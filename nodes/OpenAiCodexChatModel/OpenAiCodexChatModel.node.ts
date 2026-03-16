import {
	BaseChatModel,
	getParametersJsonSchema,
	parseSSEStream,
	supplyModel,
	type GenerateResult,
	type Message,
	type MessageContent,
	type StreamChunk,
	type TokenUsage,
	type Tool,
} from '@n8n/ai-node-sdk';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import packageJson from '../../package.json';
import type {
	IDataObject,
	IExecuteFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
} from 'n8n-workflow';
import { ApplicationError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

type CodexAuthJson = {
	OPENAI_API_KEY?: string | null;
	openai_api_key?: string | null;
	tokens?: {
		id_token?: string | { raw_jwt?: string; [key: string]: unknown };
		access_token?: string;
		refresh_token?: string;
		account_id?: string;
		[key: string]: unknown;
	};
	last_refresh?: string;
	[key: string]: unknown;
};

type TokenRefreshResponse = {
	id_token?: string;
	access_token?: string;
	refresh_token?: string;
	[key: string]: unknown;
};

type DeviceCodeStartResponse = {
	device_auth_id?: string;
	user_code?: string;
	usercode?: string;
	interval?: string | number;
	error?: string;
	error_description?: string;
	[key: string]: unknown;
};

type DeviceCodeState = {
	device_auth_id: string;
	user_code: string;
	interval_seconds: number;
	verification_url: string;
	issued_at: string;
};

type DeviceCodePollSuccess = {
	authorization_code?: string;
	code_challenge?: string;
	code_verifier?: string;
	error?: string;
	error_description?: string;
	[key: string]: unknown;
};

type AuthRequestContext = Pick<ISupplyDataFunctions, 'helpers'>;

type RuntimeNodeState = {
	codexAuthJson?: CodexAuthJson;
	codexDeviceAuth?: DeviceCodeState;
	conversationId?: string;
};

type RuntimeStateContext = {
	getWorkflow: () => { id?: string | number | null };
	getNode: () => { id?: string; name: string };
};

type BoundToolsDebugState = {
	toolNames: string[];
	lastToolChoice?: string;
	lastParallelToolCalls?: string;
	lastToolsPayload?: string;
	lastInputTypes?: string;
	lastInputPayload?: string;
	lastModel?: string;
	lastRequestKeys?: string;
	lastReasoning?: string;
};

type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

type ModelReasoningEffort = Exclude<CodexReasoningEffort, 'none'>;

const MODEL_OPTIONS: INodePropertyOptions[] = [
	{
		name: 'Custom',
		value: '__custom__',
	},
	{
		name: 'GPT-5.4',
		value: 'gpt-5.4',
	},
	{
		name: 'GPT-5.3 Codex',
		value: 'gpt-5.3-codex',
	},
	{
		name: 'GPT-5.2',
		value: 'gpt-5.2',
	},
	{
		name: 'GPT-5.2 Codex',
		value: 'gpt-5.2-codex',
	},
	{
		name: 'GPT-5.1',
		value: 'gpt-5.1',
	},
	{
		name: 'GPT-5.1 Codex Max',
		value: 'gpt-5.1-codex-max',
	},
	{
		name: 'GPT-5.1 Codex',
		value: 'gpt-5.1-codex',
	},
	{
		name: 'GPT-5',
		value: 'gpt-5',
	},
	{
		name: 'GPT-5 Codex',
		value: 'gpt-5-codex',
	},
	{
		name: 'GPT-5.1 Codex Mini',
		value: 'gpt-5.1-codex-mini',
	},
	{
		name: 'GPT-5 Codex Mini',
		value: 'gpt-5-codex-mini',
	},
	{
		name: 'GPT-OSS 120B',
		value: 'gpt-oss-120b',
	},
	{
		name: 'GPT-OSS 20B',
		value: 'gpt-oss-20b',
	},
];

const MODEL_SUPPORTS_PARALLEL_TOOL_CALLS: Readonly<Record<string, boolean>> = {
	'gpt-5.3-codex': true,
	'gpt-5.4': true,
	'gpt-5.2-codex': true,
	'gpt-5.1-codex-max': false,
	'gpt-5.1-codex': false,
	'gpt-5.2': true,
	'gpt-5.1': true,
	'gpt-5-codex': false,
	'gpt-5-codex-mini': false,
	'gpt-5.1-codex-mini': false,
	'gpt-5': false,
	'gpt-oss-120b': false,
	'gpt-oss-20b': false,
};

const MODEL_REASONING_EFFORTS: Readonly<Record<string, ReadonlyArray<ModelReasoningEffort>>> = {
	'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
	'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
	'gpt-5.2-codex': ['low', 'medium', 'high', 'xhigh'],
	'gpt-5.1-codex-max': ['low', 'medium', 'high', 'xhigh'],
	'gpt-5.1-codex': ['low', 'medium', 'high'],
	'gpt-5.2': ['low', 'medium', 'high', 'xhigh'],
	'gpt-5.1': ['low', 'medium', 'high'],
	'gpt-5-codex': ['low', 'medium', 'high'],
	'gpt-5': ['minimal', 'low', 'medium', 'high'],
	'gpt-oss-120b': ['low', 'medium', 'high'],
	'gpt-oss-20b': ['low', 'medium', 'high'],
	'gpt-5.1-codex-mini': ['medium', 'high'],
	'gpt-5-codex-mini': ['medium', 'high'],
};

const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = 'medium';
const ALL_REASONING_EFFORTS: ReadonlyArray<ModelReasoningEffort> = [
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
];
const REASONING_EFFORT_RANK: Readonly<Record<ModelReasoningEffort, number>> = {
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
};
const REASONING_EFFORT_LABEL: Readonly<Record<CodexReasoningEffort, string>> = {
	none: 'None',
	minimal: 'Minimal',
	low: 'Low',
	medium: 'Mid',
	high: 'High',
	xhigh: 'Extreme',
};

const MODELS_REASONING_LMHX: ReadonlyArray<string> = [
	'gpt-5.3-codex',
	'gpt-5.4',
	'gpt-5.2-codex',
	'gpt-5.1-codex-max',
	'gpt-5.2',
];
const MODELS_REASONING_LMH: ReadonlyArray<string> = [
	'gpt-5.1-codex',
	'gpt-5.1',
	'gpt-5-codex',
	'gpt-oss-120b',
	'gpt-oss-20b',
];
const MODELS_REASONING_MH: ReadonlyArray<string> = ['gpt-5.1-codex-mini', 'gpt-5-codex-mini'];
const MODELS_REASONING_MINIMAL_LMH: ReadonlyArray<string> = ['gpt-5'];

function reasoningEffortOptions(
	supported: ReadonlyArray<ModelReasoningEffort>,
): INodePropertyOptions[] {
	const values: CodexReasoningEffort[] = ['none', ...supported];
	return values.map((value) => ({
		name: REASONING_EFFORT_LABEL[value],
		value,
	}));
}

const REASONING_OPTIONS_LMHX = reasoningEffortOptions(['low', 'medium', 'high', 'xhigh']);
const REASONING_OPTIONS_LMH = reasoningEffortOptions(['low', 'medium', 'high']);
const REASONING_OPTIONS_MH = reasoningEffortOptions(['medium', 'high']);
const REASONING_OPTIONS_MINIMAL_LMH = reasoningEffortOptions([
	'minimal',
	'low',
	'medium',
	'high',
]);
const REASONING_OPTIONS_CUSTOM = reasoningEffortOptions(ALL_REASONING_EFFORTS);

function resolveReasoningEffortParameterName(modelName: string | undefined): string {
	const normalized = normalizeModelName(modelName);
	if (!normalized || normalized === '__custom__') return 'reasoningEffortCustom';
	if (MODELS_REASONING_LMHX.includes(normalized)) return 'reasoningEffortLmhx';
	if (MODELS_REASONING_LMH.includes(normalized)) return 'reasoningEffortLmh';
	if (MODELS_REASONING_MH.includes(normalized)) return 'reasoningEffortMh';
	if (MODELS_REASONING_MINIMAL_LMH.includes(normalized)) return 'reasoningEffortMinimalLmh';
	return 'reasoningEffortCustom';
}

type PersistedStateContext = AuthRequestContext & RuntimeStateContext;

const runtimeNodeState = new Map<string, RuntimeNodeState>();

const DEFAULT_CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_ORIGINATOR = 'codex_cli_rs';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_ISSUER = 'https://auth.openai.com';
const REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEVICE_CODE_USERCODE_URL = `${AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_CODE_TOKEN_URL = `${AUTH_ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_CODE_VERIFICATION_URL = `${AUTH_ISSUER}/codex/device`;
const DEVICE_CODE_CALLBACK_URL = `${AUTH_ISSUER}/deviceauth/callback`;
const DEFAULT_MODEL = 'gpt-5-codex';
const TOKEN_REFRESH_INTERVAL_DAYS = 8;
const DEVICE_CODE_EXPIRY_MS = 15 * 60 * 1000;
const CODEX_NODE_VERSION = toTrimmed(packageJson.version) ?? '0.0.0';
const CODEX_USER_AGENT = `${DEFAULT_ORIGINATOR}/${CODEX_NODE_VERSION} (n8n-openai-codex)`;
const PERSISTED_STATE_PREFIX = '.openai-codex-state';
const DIRECT_PERSIST_DIR_ENV = 'N8N_OPENAI_CODEX_STATE_DIR';
const ALLOW_PARALLEL_TOOL_CALLS =
	toTrimmed(process.env.N8N_OPENAI_CODEX_ALLOW_PARALLEL_TOOLS) === 'true';
const DEFAULT_INSTRUCTIONS = 'You are Codex.';
const REQUEST_NORMALIZER_VERSION = '2026-03-16.6';

type CodexResponsesMessageContentItem = {
	type: 'input_text' | 'output_text';
	text: string;
};

type CodexResponsesInputItem =
	| {
			type: 'message';
			role: 'user' | 'assistant';
			content: CodexResponsesMessageContentItem[];
	  }
	| {
			type: 'function_call';
			call_id: string;
			name: string;
			arguments: string;
	  }
	| {
			type: 'function_call_output';
			call_id: string;
			output: string;
	  };

type CodexResponsesTool = {
	type: 'function';
	name: string;
	description: string;
	strict: false;
	parameters: Record<string, unknown>;
};

type CodexResponsesReasoning = {
	effort: ModelReasoningEffort;
	summary: 'auto';
};

type CodexResponsesRequest = {
	model: string;
	instructions: string;
	input: CodexResponsesInputItem[];
	tools: CodexResponsesTool[];
	tool_choice: 'auto';
	parallel_tool_calls: boolean;
	stream: true;
	store: false;
	include: string[];
	prompt_cache_key: string;
	reasoning?: CodexResponsesReasoning;
};

type CodexResponsesOutputItem = {
	type?: string;
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	call_id?: string;
	name?: string;
	arguments?: string;
};

type CodexResponsesResponse = {
	id?: string;
	object?: string;
	created_at?: string;
	model?: string;
	output?: CodexResponsesOutputItem[];
	status?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
		input_tokens_details?: {
			cached_tokens?: number;
		};
		output_tokens_details?: {
			reasoning_tokens?: number;
		};
	};
};

type CodexStreamEvent = {
	type?: string;
	delta?: string;
	output_index?: number;
	item?: Record<string, unknown>;
	response?: CodexResponsesResponse;
};

type CodexOpenStreamRequest = (
	request: CodexResponsesRequest,
	headers: Record<string, string>,
) => Promise<IN8nHttpFullResponse>;

type CodexResponsesChatModelConfig = {
	baseUrl: string;
	defaultHeaders: Record<string, string>;
	defaultInstructions: string;
	reasoning?: CodexResponsesReasoning;
	parallelToolCalls: boolean;
	promptCacheKey: string;
	chatgptAccountId: string;
	openStreamRequest: CodexOpenStreamRequest;
	debugState: BoundToolsDebugState;
};

function isAsyncBufferIterable(value: unknown): value is AsyncIterableIterator<Buffer | Uint8Array> {
	return (
		Boolean(value) &&
		typeof value === 'object' &&
		typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
	);
}

async function* parseCodexStreamEvents(
	body: AsyncIterableIterator<Buffer | Uint8Array>,
): AsyncIterable<CodexStreamEvent> {
	for await (const message of parseSSEStream(body)) {
		if (!message.data || message.data === '[DONE]') continue;
		try {
			yield JSON.parse(message.data) as CodexStreamEvent;
		} catch {
			// ignore malformed events
		}
	}
}

function parseCodexTokenUsage(usage: CodexResponsesResponse['usage']): TokenUsage | undefined {
	if (!usage) return undefined;
	const promptTokens = usage.input_tokens ?? 0;
	const completionTokens = usage.output_tokens ?? 0;
	const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;

	return {
		promptTokens,
		completionTokens,
		totalTokens,
		inputTokenDetails:
			typeof usage.input_tokens_details?.cached_tokens === 'number'
				? {
						cacheRead: usage.input_tokens_details.cached_tokens,
					}
				: undefined,
		outputTokenDetails:
			typeof usage.output_tokens_details?.reasoning_tokens === 'number'
				? {
						reasoning: usage.output_tokens_details.reasoning_tokens,
					}
				: undefined,
	};
}

function parseToolCallArguments(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// ignore and return empty object
	}
	return {};
}

function parseCodexOutputItems(outputItems: unknown): {
	text: string;
	toolCalls: Array<{ id: string; name: string; argumentsRaw: string }>;
} {
	const textParts: string[] = [];
	const toolCalls: Array<{ id: string; name: string; argumentsRaw: string }> = [];

	const items = Array.isArray(outputItems) ? outputItems : [];
	for (const item of items) {
		const itemObj = toObject(item);
		if (!itemObj) continue;

		const type = toTrimmed(itemObj.type);
		if (type === 'message' && toTrimmed(itemObj.role) === 'assistant') {
			const contentItems = Array.isArray(itemObj.content) ? itemObj.content : [];
			for (const block of contentItems) {
				const blockObj = toObject(block);
				if (!blockObj) continue;
				if (toTrimmed(blockObj.type) === 'output_text') {
					const text = toTrimmed(blockObj.text);
					if (text) textParts.push(text);
				}
			}
			continue;
		}

		if (type === 'function_call') {
			const id = toTrimmed(itemObj.call_id) ?? toTrimmed(itemObj.id);
			const name = toTrimmed(itemObj.name);
			const argumentsRaw = toTrimmed(itemObj.arguments) ?? '{}';
			if (id && name) {
				toolCalls.push({ id, name, argumentsRaw });
			}
		}
	}

	return {
		text: textParts.join(''),
		toolCalls,
	};
}

function toCodexOutputText(part: MessageContent): string | undefined {
	if (part.type === 'text' || part.type === 'reasoning') {
		return toTrimmed(part.text);
	}

	if (part.type === 'provider') {
		try {
			return JSON.stringify(part.value);
		} catch {
			return undefined;
		}
	}

	return undefined;
}

function stringifyToolCallInput(input: string): string {
	const trimmed = toTrimmed(input);
	if (!trimmed) return '{}';
	try {
		JSON.parse(trimmed);
		return trimmed;
	} catch {
		return JSON.stringify(trimmed);
	}
}

function toCodexInput(messages: Message[], fallbackPrompt = 'Continue.'): {
	instructions: string | undefined;
	input: CodexResponsesInputItem[];
} {
	const instructionsParts: string[] = [];
	const input: CodexResponsesInputItem[] = [];

	for (const message of messages) {
		if (message.role === 'system') {
			for (const part of message.content) {
				const text = toCodexOutputText(part);
				if (text) instructionsParts.push(text);
			}
			continue;
		}

		if (message.role === 'user') {
			const content: CodexResponsesMessageContentItem[] = [];
			for (const part of message.content) {
				const text = toCodexOutputText(part);
				if (text) {
					content.push({
						type: 'input_text',
						text,
					});
				}
			}
			if (content.length > 0) {
				input.push({
					type: 'message',
					role: 'user',
					content,
				});
			}
			continue;
		}

		if (message.role === 'assistant') {
			for (const part of message.content) {
				if (part.type === 'tool-call') {
					const name = toTrimmed(part.toolName);
					if (!name) continue;
					input.push({
						type: 'function_call',
						call_id: toTrimmed(part.toolCallId) ?? randomUUID(),
						name,
						arguments: stringifyToolCallInput(part.input),
					});
					continue;
				}

				const text = toCodexOutputText(part);
				if (!text) continue;
				input.push({
					type: 'message',
					role: 'assistant',
					content: [
						{
							type: 'output_text',
							text,
						},
					],
				});
			}
			continue;
		}

		if (message.role === 'tool') {
			for (const part of message.content) {
				if (part.type !== 'tool-result') continue;
				const callId = toTrimmed(part.toolCallId);
				if (!callId) continue;
				const output =
					typeof part.result === 'string' ? part.result : JSON.stringify(part.result ?? null);
				input.push({
					type: 'function_call_output',
					call_id: callId,
					output,
				});
			}
		}
	}

	if (input.length === 0) {
		input.push({
			type: 'message',
			role: 'user',
			content: [
				{
					type: 'input_text',
					text: fallbackPrompt,
				},
			],
		});
	}

	return {
		instructions: instructionsParts.length > 0 ? instructionsParts.join('\n\n') : undefined,
		input,
	};
}

function codexToolFromGenericTool(
	tool: Tool,
): CodexResponsesTool | undefined {
	if (tool.type === 'provider') {
		return undefined;
	}

	const rawName = toTrimmed(tool.name);
	if (!rawName) return undefined;

	const name = rawName;
	const description = toTrimmed(tool.description) ?? 'No description';
	const parameters = normalizeCodexToolParameters(getParametersJsonSchema(tool));

	return {
		type: 'function',
		name,
		description,
		strict: false,
		parameters,
	};
}

function normalizeCodexToolParameters(rawSchema: unknown): Record<string, unknown> {
	const sanitized = sanitizeToolJsonSchema(rawSchema);
	const schemaObj = toObject(sanitized);
	if (!schemaObj) {
		return {
			type: 'object',
			properties: {},
			additionalProperties: false,
		};
	}

	const schemaType = toTrimmed(schemaObj.type)?.toLowerCase();
	if (schemaType === 'object' || toObject(schemaObj.properties)) {
		const properties = toObject(schemaObj.properties) ?? {};
		const normalized: Record<string, unknown> = {
			...schemaObj,
			type: 'object',
			properties,
			additionalProperties:
				typeof schemaObj.additionalProperties === 'boolean'
					? schemaObj.additionalProperties
					: false,
		};
		return normalized;
	}

	// n8n tools like Calculator can expose a primitive top-level schema.
	// Codex responses backend expects function parameters to be an object.
	return {
		type: 'object',
		properties: {
			input: schemaObj,
		},
		required: ['input'],
		additionalProperties: false,
	};
}

class CodexResponsesChatModel extends BaseChatModel {
	constructor(
		modelId: string,
		private readonly config: CodexResponsesChatModelConfig,
	) {
		super('openai-codex', modelId);
	}

	private buildRequest(messages: Message[]): CodexResponsesRequest {
		const tools: CodexResponsesTool[] = [];
		for (const tool of this.tools) {
			const normalizedTool = codexToolFromGenericTool(tool);
			if (!normalizedTool) continue;
			tools.push(normalizedTool);
		}

		const { instructions, input } = toCodexInput(messages);
		const include = this.config.reasoning ? ['reasoning.encrypted_content'] : [];

		const request: CodexResponsesRequest = {
			model: this.modelId,
			instructions: instructions ?? this.config.defaultInstructions,
			input,
			tools,
			tool_choice: 'auto',
			parallel_tool_calls: this.config.parallelToolCalls,
			stream: true,
			store: false,
			include,
			prompt_cache_key: this.config.promptCacheKey,
			...(this.config.reasoning ? { reasoning: this.config.reasoning } : {}),
		};

		this.config.debugState.toolNames = tools.map((tool) => tool.name);
		this.config.debugState.lastModel = this.modelId;
		this.config.debugState.lastToolChoice = request.tool_choice;
		this.config.debugState.lastParallelToolCalls = String(request.parallel_tool_calls);
		this.config.debugState.lastToolsPayload =
			tools.length > 0 ? truncateErrorValue(JSON.stringify(tools)) : undefined;
		this.config.debugState.lastReasoning = this.config.reasoning
			? truncateErrorValue(JSON.stringify(this.config.reasoning))
			: undefined;
		this.config.debugState.lastRequestKeys = Object.keys(request).sort().join(',');
		setInputDebugState(request.input, this.config.debugState);

		return request;
	}

	private async openResponsesStream(
		request: CodexResponsesRequest,
	): Promise<AsyncIterableIterator<Buffer | Uint8Array>> {
		const response = await this.config.openStreamRequest(request, this.config.defaultHeaders);

		if (response.statusCode < 200 || response.statusCode > 299) {
			const errorPayload = {
				status: response.statusCode,
				message: extractBackendErrorMessage(response.body) ?? `${response.statusCode} status code (no body)`,
				response: {
					status: response.statusCode,
					data: response.body,
				},
			};
			if (response.statusCode === 401) {
				throw buildUnauthorizedModelError(errorPayload, this.config.chatgptAccountId);
			}
			throw buildModelRequestFailedError(
				errorPayload,
				this.config.chatgptAccountId,
				this.config.debugState,
			);
		}

		if (!isAsyncBufferIterable(response.body)) {
			throw new ApplicationError('Codex backend did not return a stream body');
		}

		return response.body;
	}

	async generate(messages: Message[]): Promise<GenerateResult> {
		const request = this.buildRequest(messages);
		const stream = await this.openResponsesStream(request);

		let text = '';
		const streamedToolCalls: Array<{ id: string; name: string; argumentsRaw: string }> = [];
		const toolCallBuffers: Record<number, { id: string; name: string; argumentsRaw: string }> = {};
		let finalResponse: CodexResponsesResponse | undefined;

		for await (const event of parseCodexStreamEvents(stream)) {
			const eventType = toTrimmed(event.type);
			if (!eventType) continue;

			if (eventType === 'response.output_text.delta') {
				const delta = toTrimmed(event.delta);
				if (delta) text += delta;
				continue;
			}

			if (eventType === 'response.output_item.added') {
				const item = toObject(event.item);
				if (!item) continue;
				if (toTrimmed(item.type) === 'function_call') {
					const idx = event.output_index ?? 0;
					toolCallBuffers[idx] = {
						id: toTrimmed(item.call_id) ?? toTrimmed(item.id) ?? randomUUID(),
						name: toTrimmed(item.name) ?? 'tool',
						argumentsRaw: toTrimmed(item.arguments) ?? '',
					};
				}
				continue;
			}

			if (eventType === 'response.function_call_arguments.delta') {
				const idx = event.output_index ?? 0;
				const delta = toTrimmed(event.delta);
				if (delta && toolCallBuffers[idx]) {
					toolCallBuffers[idx].argumentsRaw += delta;
				}
				continue;
			}

			if (eventType === 'response.output_item.done') {
				const item = toObject(event.item);
				if (!item || toTrimmed(item.type) !== 'function_call') continue;
				const idx = event.output_index ?? 0;
				const buffered = toolCallBuffers[idx];
				const callId = toTrimmed(item.call_id) ?? buffered?.id;
				const name = toTrimmed(item.name) ?? buffered?.name;
				if (!callId || !name) continue;
				streamedToolCalls.push({
					id: callId,
					name,
					argumentsRaw: buffered?.argumentsRaw || toTrimmed(item.arguments) || '{}',
				});
				continue;
			}

			if (eventType === 'response.done' || eventType === 'response.completed') {
				finalResponse = toObject(event.response) as CodexResponsesResponse | undefined;
			}
		}

		const parsedOutput = parseCodexOutputItems(finalResponse?.output);
		const mergedToolCalls = new Map<string, { id: string; name: string; argumentsRaw: string }>();
		for (const toolCall of streamedToolCalls) {
			mergedToolCalls.set(toolCall.id, toolCall);
		}
		for (const toolCall of parsedOutput.toolCalls) {
			if (!mergedToolCalls.has(toolCall.id)) {
				mergedToolCalls.set(toolCall.id, toolCall);
			}
		}

		const finalText = text || parsedOutput.text;
		const content: MessageContent[] = [];
		for (const toolCall of mergedToolCalls.values()) {
			const parsedArguments = parseToolCallArguments(toolCall.argumentsRaw || '{}');
			content.push({
				type: 'tool-call',
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				input: JSON.stringify(parsedArguments),
			});
		}
		content.push({
			type: 'text',
			text: finalText,
		});

		return {
			id: toTrimmed(finalResponse?.id) ?? randomUUID(),
			finishReason: toTrimmed(finalResponse?.status) === 'completed' ? 'stop' : 'other',
			usage: parseCodexTokenUsage(finalResponse?.usage),
			message: {
				role: 'assistant',
				content,
				id: toTrimmed(finalResponse?.id),
			},
			rawResponse: finalResponse,
			providerMetadata: {
				model_provider: 'openai-codex',
				model: toTrimmed(finalResponse?.model) ?? this.modelId,
				status: toTrimmed(finalResponse?.status) ?? 'completed',
				id: toTrimmed(finalResponse?.id),
			},
		};
	}

	async *stream(messages: Message[]): AsyncIterable<StreamChunk> {
		const request = this.buildRequest(messages);
		const stream = await this.openResponsesStream(request);
		const toolCallBuffers: Record<number, { id: string; name: string; argumentsRaw: string }> = {};

		for await (const event of parseCodexStreamEvents(stream)) {
			const eventType = toTrimmed(event.type);
			if (!eventType) continue;

			if (eventType === 'response.output_text.delta') {
				const delta = toTrimmed(event.delta);
				if (delta) {
					yield { type: 'text-delta', delta };
				}
				continue;
			}

			if (eventType === 'response.reasoning_summary_text.delta') {
				const delta = toTrimmed(event.delta);
				if (delta) {
					yield { type: 'reasoning-delta', delta };
				}
				continue;
			}

			if (eventType === 'response.output_item.added') {
				const item = toObject(event.item);
				if (!item) continue;
				if (toTrimmed(item.type) === 'function_call') {
					const idx = event.output_index ?? 0;
					toolCallBuffers[idx] = {
						id: toTrimmed(item.call_id) ?? toTrimmed(item.id) ?? randomUUID(),
						name: toTrimmed(item.name) ?? 'tool',
						argumentsRaw: toTrimmed(item.arguments) ?? '',
					};
				}
				continue;
			}

			if (eventType === 'response.function_call_arguments.delta') {
				const idx = event.output_index ?? 0;
				const delta = toTrimmed(event.delta);
				if (delta && toolCallBuffers[idx]) {
					toolCallBuffers[idx].argumentsRaw += delta;
				}
				continue;
			}

			if (eventType === 'response.output_item.done') {
				const item = toObject(event.item);
				if (!item || toTrimmed(item.type) !== 'function_call') continue;
				const idx = event.output_index ?? 0;
				const buffered = toolCallBuffers[idx];
				const callId = toTrimmed(item.call_id) ?? buffered?.id;
				const name = toTrimmed(item.name) ?? buffered?.name;
				if (!callId || !name) continue;
				yield {
					type: 'tool-call-delta',
					id: callId,
					name,
					argumentsDelta: buffered?.argumentsRaw || toTrimmed(item.arguments) || '{}',
				};
				continue;
			}

			if (eventType === 'response.done' || eventType === 'response.completed') {
				const response = toObject(event.response) as CodexResponsesResponse | undefined;
				yield {
					type: 'finish',
					finishReason: 'stop',
					usage: parseCodexTokenUsage(response?.usage),
				};
				return;
			}
		}

		yield {
			type: 'finish',
			finishReason: 'stop',
		};
	}
}

function toTrimmed(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function toObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split('.');
	if (parts.length < 2) return undefined;

	const payload = parts[1];
	if (!payload) return undefined;

	const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
	const padLen = (4 - (base64.length % 4)) % 4;
	const padded = base64 + '='.repeat(padLen);

	try {
		const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// ignore decode errors
	}

	return undefined;
}

function resolveIdTokenRaw(
	idToken: string | { raw_jwt?: string; [key: string]: unknown } | undefined,
): string | undefined {
	if (typeof idToken === 'string') {
		return toTrimmed(idToken);
	}
	const obj = toObject(idToken);
	return obj ? toTrimmed(obj.raw_jwt) : undefined;
}

function extractChatgptAccountId(token?: string): string | undefined {
	const tokenValue = toTrimmed(token);
	if (!tokenValue) return undefined;

	const payload = decodeJwtPayload(tokenValue);
	if (!payload) return undefined;

	const authObj = toObject(payload['https://api.openai.com/auth']);
	if (!authObj) return undefined;

	return toTrimmed(authObj.chatgpt_account_id);
}

function getJwtExpirationMs(token?: string): number | undefined {
	const tokenValue = toTrimmed(token);
	if (!tokenValue) return undefined;

	const payload = decodeJwtPayload(tokenValue);
	if (!payload) return undefined;

	const exp = payload.exp;
	if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;

	return exp * 1000;
}

function isJwtExpiredOrAlmostExpired(token?: string, leewayMs = 60_000): boolean {
	const exp = getJwtExpirationMs(token);
	if (!exp) return false;
	return exp <= Date.now() + leewayMs;
}

function isLastRefreshStale(lastRefresh?: string): boolean {
	const lastRefreshValue = toTrimmed(lastRefresh);
	if (!lastRefreshValue) return false;

	const lastRefreshMs = Date.parse(lastRefreshValue);
	if (!Number.isFinite(lastRefreshMs)) return false;

	const refreshIntervalMs = TOKEN_REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
	return lastRefreshMs < Date.now() - refreshIntervalMs;
}

function normalizeAuthJson(value: unknown): CodexAuthJson {
	let parsed: unknown = value;
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) {
			throw new ApplicationError('Auth JSON is empty');
		}

		try {
			parsed = JSON.parse(text);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new ApplicationError(`Auth JSON is invalid: ${message}`);
		}
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ApplicationError('Auth JSON root must be an object');
	}

	return parsed as CodexAuthJson;
}

function hasUsableAuthData(auth: CodexAuthJson): boolean {
	const tokens = toObject(auth.tokens) as CodexAuthJson['tokens'] | undefined;
	return Boolean(
		toTrimmed(auth.OPENAI_API_KEY) ??
			toTrimmed(auth.openai_api_key) ??
			toTrimmed(tokens?.access_token),
	);
}

function deepCloneAuthJson(auth: CodexAuthJson): CodexAuthJson {
	return JSON.parse(JSON.stringify(auth)) as CodexAuthJson;
}

function toIntervalSeconds(value: unknown, defaultSeconds = 5): number {
	if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
		return Math.floor(value);
	}

	if (typeof value === 'string') {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed) && parsed >= 0) {
			return parsed;
		}
	}

	return defaultSeconds;
}

function normalizeDeviceCodeState(value: unknown): DeviceCodeState | undefined {
	const obj = toObject(value);
	if (!obj) return undefined;

	const deviceAuthId = toTrimmed(obj.device_auth_id);
	const userCode = toTrimmed(obj.user_code);
	const verificationUrl = toTrimmed(obj.verification_url);
	const issuedAt = toTrimmed(obj.issued_at);
	const intervalSeconds = toIntervalSeconds(obj.interval_seconds);

	if (!deviceAuthId || !userCode || !verificationUrl || !issuedAt) {
		return undefined;
	}

	return {
		device_auth_id: deviceAuthId,
		user_code: userCode,
		verification_url: verificationUrl,
		issued_at: issuedAt,
		interval_seconds: intervalSeconds,
	};
}

function isDeviceCodeStateExpired(state: DeviceCodeState): boolean {
	const issuedAtMs = Date.parse(state.issued_at);
	if (!Number.isFinite(issuedAtMs)) return true;
	return issuedAtMs + DEVICE_CODE_EXPIRY_MS <= Date.now();
}

function extractBackendErrorMessage(body: unknown): string | undefined {
	const parsed = toObject(body);
	if (!parsed) return undefined;

	const description = toTrimmed(parsed.error_description);
	const message = toTrimmed(parsed.message);
	const errorCode = toTrimmed(parsed.error) ?? toTrimmed(parsed.code);

	if (description && errorCode) {
		return `${errorCode}: ${description}`;
	}

	return description ?? message ?? errorCode;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRuntimeStateKey(context: RuntimeStateContext): string {
	const workflowId = String(context.getWorkflow()?.id ?? 'unsaved');
	const node = context.getNode();
	const nodeId = toTrimmed(node.id) ?? node.name;
	return `${workflowId}:${nodeId}`;
}

function getRuntimeState(key: string): RuntimeNodeState {
	return runtimeNodeState.get(key) ?? {};
}

function setRuntimeAuthState(key: string, auth: CodexAuthJson | undefined): void {
	const current = getRuntimeState(key);
	if (auth) {
		current.codexAuthJson = deepCloneAuthJson(auth);
	} else {
		delete current.codexAuthJson;
	}

	if (current.codexAuthJson || current.codexDeviceAuth) {
		runtimeNodeState.set(key, current);
	} else {
		runtimeNodeState.delete(key);
	}
}

function setRuntimeDeviceState(key: string, state: DeviceCodeState | undefined): void {
	const current = getRuntimeState(key);
	if (state) {
		current.codexDeviceAuth = { ...state };
	} else {
		delete current.codexDeviceAuth;
	}

	if (current.codexAuthJson || current.codexDeviceAuth) {
		runtimeNodeState.set(key, current);
	} else {
		runtimeNodeState.delete(key);
	}
}

function sanitizeStateKeySegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getPersistedStateBaseDir(): string {
	const configuredPath = toTrimmed(process.env[DIRECT_PERSIST_DIR_ENV]);
	if (configuredPath) {
		return configuredPath;
	}

	const n8nUserFolder = toTrimmed(process.env.N8N_USER_FOLDER) ?? join(homedir(), '.n8n');
	return join(n8nUserFolder, 'openai-codex-state');
}

function getPersistedStateFilePath(context: RuntimeStateContext): string {
	const storagePath = getPersistedStateBaseDir();
	const runtimeStateKey = getRuntimeStateKey(context);
	const safeStateKey = sanitizeStateKeySegment(runtimeStateKey);
	return join(storagePath, `${PERSISTED_STATE_PREFIX}-${safeStateKey}.json`);
}

function getSystemErrorCode(error: unknown): string | undefined {
	return toTrimmed(toObject(error)?.code);
}

function normalizePersistedState(value: unknown): RuntimeNodeState {
	const parsed = toObject(value);
	if (!parsed) return {};

	const state: RuntimeNodeState = {};
	if (parsed.codexAuthJson) {
		state.codexAuthJson = normalizeAuthJson(parsed.codexAuthJson);
	}

	const deviceState = normalizeDeviceCodeState(parsed.codexDeviceAuth);
	if (deviceState) {
		state.codexDeviceAuth = deviceState;
	}

	return state;
}

async function readPersistedState(context: PersistedStateContext): Promise<RuntimeNodeState> {
	const filePath = getPersistedStateFilePath(context);
	try {
		const content = await readFile(filePath, { encoding: 'utf8' });
		const trimmed = toTrimmed(content);
		if (!trimmed) return {};
		return normalizePersistedState(JSON.parse(trimmed));
	} catch (error) {
		if (getSystemErrorCode(error) === 'ENOENT') {
			return {};
		}

		throw new ApplicationError(
			`Failed to read persisted Codex auth state: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function writePersistedState(
	context: PersistedStateContext,
	state: RuntimeNodeState,
): Promise<void> {
	const filePath = getPersistedStateFilePath(context);

	const payload: IDataObject = {
		updated_at: new Date().toISOString(),
	};

	if (state.codexAuthJson) {
		payload.codexAuthJson = deepCloneAuthJson(state.codexAuthJson) as unknown as IDataObject;
	}

	if (state.codexDeviceAuth) {
		payload.codexDeviceAuth = { ...state.codexDeviceAuth } as unknown as IDataObject;
	}

	try {
		await mkdir(dirname(filePath), { recursive: true });
		const tempPath = `${filePath}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8' });
		await rename(tempPath, filePath);
	} catch (error) {
		throw new ApplicationError(
			`Failed to write persisted Codex auth state: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function loadNodeState(
	context: PersistedStateContext,
	runtimeStateKey: string,
	nodeStaticData: IDataObject,
): Promise<RuntimeNodeState> {
	const runtimeState = getRuntimeState(runtimeStateKey);
	const persistedState = await readPersistedState(context);

	const authRaw =
		persistedState.codexAuthJson ?? nodeStaticData.codexAuthJson ?? runtimeState.codexAuthJson;
	const deviceRaw =
		persistedState.codexDeviceAuth ??
		nodeStaticData.codexDeviceAuth ??
		runtimeState.codexDeviceAuth;

	return {
		codexAuthJson: authRaw ? normalizeAuthJson(authRaw) : undefined,
		codexDeviceAuth: normalizeDeviceCodeState(deviceRaw),
	};
}

async function saveNodeState(
	context: PersistedStateContext,
	runtimeStateKey: string,
	nodeStaticData: IDataObject,
	state: RuntimeNodeState,
): Promise<void> {
	if (state.codexAuthJson) {
		nodeStaticData.codexAuthJson = deepCloneAuthJson(state.codexAuthJson) as unknown as IDataObject;
	} else {
		delete nodeStaticData.codexAuthJson;
	}

	if (state.codexDeviceAuth) {
		nodeStaticData.codexDeviceAuth = { ...state.codexDeviceAuth } as unknown as IDataObject;
	} else {
		delete nodeStaticData.codexDeviceAuth;
	}

	setRuntimeAuthState(runtimeStateKey, state.codexAuthJson);
	setRuntimeDeviceState(runtimeStateKey, state.codexDeviceAuth);

	await writePersistedState(context, state);
}

async function requestDeviceCode(context: AuthRequestContext): Promise<DeviceCodeState> {
	const response = (await context.helpers.httpRequest({
		method: 'POST',
		url: DEVICE_CODE_USERCODE_URL,
		headers: {
			'Content-Type': 'application/json',
		},
		body: {
			client_id: CODEX_CLIENT_ID,
		},
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as IN8nHttpFullResponse;

	if (response.statusCode < 200 || response.statusCode > 299) {
		const detail = extractBackendErrorMessage(response.body);
		if (response.statusCode === 404) {
			throw new ApplicationError(
				'Device-code login is not enabled for this auth server. Use Codex browser login and re-try.',
			);
		}

		throw new ApplicationError(
			detail
				? `Device-code start failed with status ${response.statusCode}: ${detail}`
				: `Device-code start failed with status ${response.statusCode}`,
		);
	}

	const payload = (toObject(response.body) ?? {}) as DeviceCodeStartResponse;
	const deviceAuthId = toTrimmed(payload.device_auth_id);
	const userCode = toTrimmed(payload.user_code) ?? toTrimmed(payload.usercode);

	if (!deviceAuthId || !userCode) {
		throw new ApplicationError('Device-code response is missing required fields');
	}

	return {
		device_auth_id: deviceAuthId,
		user_code: userCode,
		interval_seconds: toIntervalSeconds(payload.interval),
		verification_url: DEVICE_CODE_VERIFICATION_URL,
		issued_at: new Date().toISOString(),
	};
}

async function pollDeviceCodeUntilAuthorized(
	context: AuthRequestContext,
	state: DeviceCodeState,
	maxWaitMs: number,
): Promise<{ status: 'pending' } | { status: 'authorized'; token: DeviceCodePollSuccess }> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < maxWaitMs) {
		const result = await pollDeviceCode(context, state);
		if (result.status === 'authorized') {
			return result;
		}

		const elapsedMs = Date.now() - startedAt;
		const remainingMs = maxWaitMs - elapsedMs;
		if (remainingMs <= 0) break;

		await sleep(Math.min(remainingMs, Math.max(1, state.interval_seconds) * 1000));
	}

	return { status: 'pending' };
}

function buildPendingVerificationPayload(state: DeviceCodeState): IDataObject {
	return {
		status: 'pending_verification',
		verification_url: state.verification_url,
		user_code: state.user_code,
		poll_interval_seconds: state.interval_seconds,
		login_initiated_at: state.issued_at,
		message: 'Open verification_url, enter user_code, then click Execute step again.',
	};
}

async function pollDeviceCode(
	context: AuthRequestContext,
	state: DeviceCodeState,
): Promise<{ status: 'pending' } | { status: 'authorized'; token: DeviceCodePollSuccess }> {
	const response = (await context.helpers.httpRequest({
		method: 'POST',
		url: DEVICE_CODE_TOKEN_URL,
		headers: {
			'Content-Type': 'application/json',
		},
		body: {
			device_auth_id: state.device_auth_id,
			user_code: state.user_code,
		},
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as IN8nHttpFullResponse;

	if (response.statusCode === 403 || response.statusCode === 404) {
		return { status: 'pending' };
	}

	if (response.statusCode < 200 || response.statusCode > 299) {
		const detail = extractBackendErrorMessage(response.body);
		throw new ApplicationError(
			detail
				? `Device-code poll failed with status ${response.statusCode}: ${detail}`
				: `Device-code poll failed with status ${response.statusCode}`,
		);
	}

	const payload = (toObject(response.body) ?? {}) as DeviceCodePollSuccess;
	if (!toTrimmed(payload.authorization_code) || !toTrimmed(payload.code_verifier)) {
		throw new ApplicationError('Device-code poll succeeded but authorization payload is invalid');
	}

	return { status: 'authorized', token: payload };
}

async function exchangeAuthorizationCodeForTokens(
	context: AuthRequestContext,
	authorizationCode: string,
	codeVerifier: string,
): Promise<CodexAuthJson> {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code: authorizationCode,
		redirect_uri: DEVICE_CODE_CALLBACK_URL,
		client_id: CODEX_CLIENT_ID,
		code_verifier: codeVerifier,
	});

	const response = (await context.helpers.httpRequest({
		method: 'POST',
		url: REFRESH_TOKEN_URL,
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as IN8nHttpFullResponse;

	if (response.statusCode < 200 || response.statusCode > 299) {
		const detail = extractBackendErrorMessage(response.body);
		throw new ApplicationError(
			detail
				? `Authorization-code exchange failed with status ${response.statusCode}: ${detail}`
				: `Authorization-code exchange failed with status ${response.statusCode}`,
		);
	}

	const payload = normalizeRefreshResponseBody(response.body) as TokenRefreshResponse;
	const accessToken = toTrimmed(payload.access_token);
	const refreshToken = toTrimmed(payload.refresh_token);
	const idToken = toTrimmed(payload.id_token);

	if (!accessToken || !refreshToken || !idToken) {
		throw new ApplicationError('Authorization-code exchange did not return full token set');
	}

	const accountId = extractChatgptAccountId(idToken) ?? extractChatgptAccountId(accessToken);

	return {
		OPENAI_API_KEY: null,
		tokens: {
			id_token: idToken,
			access_token: accessToken,
			refresh_token: refreshToken,
			account_id: accountId,
		},
		last_refresh: new Date().toISOString(),
	};
}

function normalizeRefreshResponseBody(body: unknown): Record<string, unknown> {
	return toObject(body) ?? {};
}

function extractRefreshTokenErrorCode(body: unknown): string | undefined {
	const parsed = normalizeRefreshResponseBody(body);
	const errorValue = parsed.error;
	const errorObject = toObject(errorValue);

	if (errorObject) {
		return toTrimmed(errorObject.code);
	}

	if (typeof errorValue === 'string') {
		return toTrimmed(errorValue);
	}

	return toTrimmed(parsed.code);
}

function buildRefreshFailureMessage(body: unknown): string {
	const code = extractRefreshTokenErrorCode(body);
	const detail = extractBackendErrorMessage(body);
	return [
		'Token refresh failed.',
		code ? `code=${code}` : undefined,
		detail ? `message=${detail}` : undefined,
	]
		.filter(Boolean)
		.join(' ');
}

function resolveDefaultHeaders(chatgptAccountId: string, conversationId: string): Record<string, string> {
	const headers: Record<string, string> = {
		originator: DEFAULT_ORIGINATOR,
		'chatgpt-account-id': chatgptAccountId,
		'x-client-request-id': conversationId,
		session_id: conversationId,
		version: CODEX_NODE_VERSION,
		'User-Agent': CODEX_USER_AGENT,
	};

	const organization = toTrimmed(process.env.OPENAI_ORGANIZATION);
	const project = toTrimmed(process.env.OPENAI_PROJECT);

	if (organization) {
		headers['OpenAI-Organization'] = organization;
	}

	if (project) {
		headers['OpenAI-Project'] = project;
	}

	return headers;
}

function resolveConversationId(state: RuntimeNodeState): string {
	const existing = toTrimmed(state.conversationId);
	if (existing) return existing;
	return randomUUID();
}

function getErrorStatus(error: unknown): number | undefined {
	const obj = toObject(error);
	if (!obj) return undefined;

	const status = obj.status ?? toObject(obj.response)?.status;
	if (typeof status === 'number' && Number.isFinite(status)) {
		return status;
	}

	return undefined;
}

function getErrorRequestId(error: unknown): string | undefined {
	const obj = toObject(error);
	if (!obj) return undefined;

	const direct = toTrimmed(obj.request_id);
	if (direct) return direct;

	const headers = toObject(obj.headers) ?? toObject(toObject(obj.response)?.headers);
	if (!headers) return undefined;

	return (
		toTrimmed(headers['x-request-id']) ??
		toTrimmed(headers['request-id']) ??
		toTrimmed(headers['openai-request-id'])
	);
}

function getErrorBodyObject(error: unknown): Record<string, unknown> | undefined {
	const obj = toObject(error);
	if (!obj) return undefined;

	const errorObj = toObject(obj.error);
	if (errorObj) return errorObj;

	const responseData = toObject(toObject(obj.response)?.data);
	if (!responseData) return undefined;

	return toObject(responseData.error) ?? responseData;
}

function getErrorCode(error: unknown): string | undefined {
	const obj = toObject(error);
	const body = getErrorBodyObject(error);

	return (
		toTrimmed(obj?.code) ??
		toTrimmed(body?.code) ??
		toTrimmed(toObject(body?.error)?.code)
	);
}

function getErrorMessage(error: unknown): string | undefined {
	const obj = toObject(error);
	const body = getErrorBodyObject(error);

	return (
		toTrimmed(body?.message) ??
		toTrimmed(toObject(body?.error)?.message) ??
		toTrimmed(obj?.message)
	);
}

function truncateErrorValue(value: string | undefined, maxLength = 300): string | undefined {
	const normalized = toTrimmed(value);
	if (!normalized) return undefined;
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength)}...`;
}

function getErrorBodySummary(error: unknown): string | undefined {
	const obj = toObject(error);
	if (!obj) return undefined;

	const response = toObject(obj.response);
	if (!response) return undefined;

	const rawData = response.data;
	if (typeof rawData === 'string') {
		return truncateErrorValue(rawData);
	}

	if (rawData && typeof rawData === 'object') {
		try {
			return truncateErrorValue(JSON.stringify(rawData));
		} catch {
			// ignore non-serializable objects
		}
	}

	return undefined;
}

function buildUnauthorizedModelError(error: unknown, chatgptAccountId: string): ApplicationError {
	const status = getErrorStatus(error);
	const requestId = getErrorRequestId(error);
	const code = getErrorCode(error);
	const message = getErrorMessage(error);

	const details = [
		'Codex backend returned 401 Unauthorized.',
		status ? `status=${status}` : undefined,
		requestId ? `request_id=${requestId}` : undefined,
		code ? `code=${code}` : undefined,
		message ? `message=${message}` : undefined,
		`chatgpt_account_id=${chatgptAccountId}`,
	]
		.filter(Boolean)
		.join(' ');

	return new ApplicationError(details);
}

function buildModelRequestFailedError(
	error: unknown,
	chatgptAccountId: string,
	debugState?: BoundToolsDebugState,
): ApplicationError {
	const status = getErrorStatus(error);
	const requestId = getErrorRequestId(error);
	const code = getErrorCode(error);
	const message = truncateErrorValue(getErrorMessage(error));
	const body = getErrorBodySummary(error);
	const toolNames = debugState?.toolNames ?? [];
	const toolSummary =
		toolNames.length > 0
			? toolNames
					.filter((name) => Boolean(toTrimmed(name)))
					.slice(0, 12)
					.join(',')
			: undefined;

	const details = [
		'Codex backend request failed.',
		status ? `status=${status}` : undefined,
		requestId ? `request_id=${requestId}` : undefined,
		code ? `code=${code}` : undefined,
		message ? `message=${message}` : undefined,
		!message && body ? `body=${body}` : undefined,
		status === 400
			? 'hint=Backend rejected request payload (often tool schema/tool-call payload mismatch).'
			: undefined,
		debugState?.lastModel ? `model=${debugState.lastModel}` : undefined,
		toolSummary ? `tool_names=${toolSummary}` : undefined,
		debugState?.lastToolChoice ? `tool_choice=${debugState.lastToolChoice}` : undefined,
		debugState?.lastParallelToolCalls
			? `parallel_tool_calls=${debugState.lastParallelToolCalls}`
			: undefined,
		debugState?.lastToolsPayload ? `tools_payload=${debugState.lastToolsPayload}` : undefined,
		debugState?.lastInputTypes ? `input_types=${debugState.lastInputTypes}` : undefined,
		debugState?.lastInputPayload ? `input_payload=${debugState.lastInputPayload}` : undefined,
		debugState?.lastRequestKeys ? `request_keys=${debugState.lastRequestKeys}` : undefined,
		debugState?.lastReasoning ? `reasoning=${debugState.lastReasoning}` : undefined,
		`normalizer_version=${REQUEST_NORMALIZER_VERSION}`,
		`node_version=${CODEX_NODE_VERSION}`,
		`chatgpt_account_id=${chatgptAccountId}`,
	]
		.filter(Boolean)
		.join(' ');

	return new ApplicationError(details);
}

function pickSchemaType(typeValue: unknown): string | undefined {
	if (typeof typeValue === 'string') {
		const normalized = typeValue.toLowerCase();
		return normalized === 'integer' ? 'number' : normalized;
	}
	if (!Array.isArray(typeValue)) return undefined;

	const normalized = typeValue
		.filter((entry): entry is string => typeof entry === 'string')
		.map((entry) => entry.toLowerCase())
		.filter((entry) => entry !== 'null')
		.map((entry) => (entry === 'integer' ? 'number' : entry));

	return normalized[0];
}

function sanitizeToolJsonSchema(rawSchema: unknown): Record<string, unknown> {
	const schemaObj = toObject(rawSchema);
	if (!schemaObj) {
		return {
			type: 'object',
			properties: {},
			additionalProperties: false,
		};
	}

	const schemaType = pickSchemaType(schemaObj.type);
	if (schemaType === 'object' || (!schemaType && toObject(schemaObj.properties))) {
		const rawProperties = toObject(schemaObj.properties) ?? {};
		const properties: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(rawProperties)) {
			properties[key] = sanitizeToolJsonSchema(value);
		}

		const sanitized: Record<string, unknown> = {
			type: 'object',
			properties,
		};

		if (Array.isArray(schemaObj.required)) {
			const required = schemaObj.required
				.filter((entry): entry is string => typeof entry === 'string')
				.filter((entry) => Object.prototype.hasOwnProperty.call(properties, entry));
			if (required.length > 0) {
				sanitized.required = required;
			}
		} else {
			const propertyKeys = Object.keys(properties);
			// ChatGPT codex backend can reject underspecified schemas for simple tools.
			// If there is a single argument, mark it as required.
			if (propertyKeys.length === 1) {
				sanitized.required = propertyKeys;
			}
		}

		const additionalProperties = schemaObj.additionalProperties;
		if (typeof additionalProperties === 'boolean') {
			sanitized.additionalProperties = additionalProperties;
		} else if (additionalProperties && typeof additionalProperties === 'object') {
			sanitized.additionalProperties = sanitizeToolJsonSchema(additionalProperties);
		} else {
			sanitized.additionalProperties = false;
		}

		return sanitized;
	}

	if (schemaType === 'array') {
		const description = toTrimmed(schemaObj.description);
		return {
			type: 'array',
			items: sanitizeToolJsonSchema(schemaObj.items),
			...(description ? { description } : {}),
		};
	}

	if (schemaType === 'boolean' || schemaType === 'string' || schemaType === 'number') {
		const description = toTrimmed(schemaObj.description);
		return {
			type: schemaType,
			...(description ? { description } : {}),
		};
	}

	const fallbackDescription = toTrimmed(schemaObj.description);
	return {
		type: 'string',
		...(fallbackDescription ? { description: fallbackDescription } : {}),
	};
}

function supportsParallelToolCalls(modelName: string | undefined): boolean {
	if (!ALLOW_PARALLEL_TOOL_CALLS) {
		// Default to serial tool calls because chatgpt codex backend often rejects
		// parallel_tool_calls=true for generic n8n tool payloads.
		return false;
	}

	if (!modelName) return false;

	const normalized = modelName.trim().toLowerCase();
	if (!normalized) return false;

	const known = MODEL_SUPPORTS_PARALLEL_TOOL_CALLS[normalized];
	if (typeof known === 'boolean') return known;

	// Unknown custom models default to serial tool-calls for compatibility.
	return false;
}

function normalizeModelName(modelName: string | undefined): string | undefined {
	const normalized = modelName?.trim().toLowerCase();
	return normalized || undefined;
}
function setInputDebugState(input: unknown, debugState: BoundToolsDebugState): void {
	if (Array.isArray(input)) {
		try {
			debugState.lastInputTypes = input
				.map((item) => {
					const itemObj = toObject(item);
					if (!itemObj) return 'unknown';
					return toTrimmed(itemObj.type) ?? `role:${toTrimmed(itemObj.role) ?? 'unknown'}`;
				})
				.join(',');
		} catch {
			debugState.lastInputTypes = undefined;
		}
		try {
			debugState.lastInputPayload = truncateErrorValue(JSON.stringify(input), 500);
		} catch {
			debugState.lastInputPayload = undefined;
		}
		return;
	}

	debugState.lastInputTypes = undefined;
	debugState.lastInputPayload = undefined;
}

function getModelReasoningEfforts(modelName: string | undefined): ReadonlyArray<ModelReasoningEffort> {
	const normalized = normalizeModelName(modelName);
	if (!normalized) return ALL_REASONING_EFFORTS;
	return MODEL_REASONING_EFFORTS[normalized] ?? ALL_REASONING_EFFORTS;
}

function resolveReasoningEffortForModel(
	modelName: string | undefined,
	requestedEffort: CodexReasoningEffort,
): CodexReasoningEffort {
	if (requestedEffort === 'none') {
		return 'none';
	}

	const supported = getModelReasoningEfforts(modelName);
	if (supported.includes(requestedEffort)) {
		return requestedEffort;
	}

	const requestedRank = REASONING_EFFORT_RANK[requestedEffort];
	let closest: ModelReasoningEffort | undefined;
	let closestDistance = Number.POSITIVE_INFINITY;
	for (const effort of supported) {
		const distance = Math.abs(REASONING_EFFORT_RANK[effort] - requestedRank);
		if (distance < closestDistance) {
			closestDistance = distance;
			closest = effort;
		}
	}

	return closest ?? DEFAULT_REASONING_EFFORT;
}

async function refreshChatgptTokens(
	context: AuthRequestContext,
	auth: CodexAuthJson,
): Promise<CodexAuthJson> {
	const tokens = toObject(auth.tokens) as CodexAuthJson['tokens'] | undefined;
	const refreshToken = toTrimmed(tokens?.refresh_token);
	if (!tokens || !refreshToken) return auth;

	const refreshResponse = (await context.helpers.httpRequest({
		method: 'POST',
		url: REFRESH_TOKEN_URL,
		headers: {
			'Content-Type': 'application/json',
			originator: DEFAULT_ORIGINATOR,
			'User-Agent': CODEX_USER_AGENT,
		},
		body: {
			client_id: CODEX_CLIENT_ID,
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
		},
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as IN8nHttpFullResponse;

	if (refreshResponse.statusCode < 200 || refreshResponse.statusCode > 299) {
		if (refreshResponse.statusCode === 401) {
			throw new ApplicationError(buildRefreshFailureMessage(refreshResponse.body));
		}

		const detail = extractBackendErrorMessage(refreshResponse.body);
		throw new ApplicationError(
			detail
				? `Token refresh failed with status ${refreshResponse.statusCode}: ${detail}`
				: `Token refresh failed with status ${refreshResponse.statusCode}`,
		);
	}

	const refreshBody = normalizeRefreshResponseBody(refreshResponse.body);
	const refreshPayload = refreshBody as TokenRefreshResponse;

	tokens.access_token = toTrimmed(refreshPayload.access_token) ?? tokens.access_token;
	tokens.refresh_token = toTrimmed(refreshPayload.refresh_token) ?? tokens.refresh_token;

	const refreshedIdToken = toTrimmed(refreshPayload.id_token);
	if (refreshedIdToken) {
		tokens.id_token = refreshedIdToken;
	}

	auth.tokens = tokens;
	auth.last_refresh = new Date().toISOString();

	return auth;
}

function resolveAccessToken(auth: CodexAuthJson): string | undefined {
	const tokens = toObject(auth.tokens) as CodexAuthJson['tokens'] | undefined;
	return toTrimmed(tokens?.access_token) ?? toTrimmed(auth.OPENAI_API_KEY) ?? toTrimmed(auth.openai_api_key);
}

function resolveAccountId(auth: CodexAuthJson): string | undefined {
	const tokens = toObject(auth.tokens) as CodexAuthJson['tokens'] | undefined;
	const idToken = resolveIdTokenRaw(tokens?.id_token);
	const accessToken = toTrimmed(tokens?.access_token);

	return (
		toTrimmed(tokens?.account_id) ??
		extractChatgptAccountId(idToken) ??
		extractChatgptAccountId(accessToken)
	);
}

type AuthResolveMode = 'blocking' | 'single';

type ResolvedAuthState =
	| {
			status: 'pending';
			deviceState: DeviceCodeState;
			conversationId: string;
			initiated: boolean;
	  }
	| {
			status: 'authenticated';
			auth: CodexAuthJson;
			conversationId: string;
	  };

function shouldRefreshAuthTokens(auth: CodexAuthJson): boolean {
	const authTokens = toObject(auth.tokens) as CodexAuthJson['tokens'] | undefined;
	return Boolean(
		toTrimmed(authTokens?.refresh_token) &&
			(isJwtExpiredOrAlmostExpired(toTrimmed(authTokens?.access_token)) ||
				isLastRefreshStale(toTrimmed(auth.last_refresh))),
	);
}

function getRemainingDeviceCodeTtlMs(deviceState: DeviceCodeState): number {
	const issuedAtMs = Date.parse(deviceState.issued_at);
	if (!Number.isFinite(issuedAtMs)) return DEVICE_CODE_EXPIRY_MS;
	return Math.max(0, DEVICE_CODE_EXPIRY_MS - (Date.now() - issuedAtMs));
}

async function resolveNodeAuthState(
	stateContext: PersistedStateContext,
	authContext: AuthRequestContext,
	runtimeStateKey: string,
	nodeStaticData: IDataObject,
	mode: AuthResolveMode,
): Promise<ResolvedAuthState> {
	const loadedState = await loadNodeState(stateContext, runtimeStateKey, nodeStaticData);
	let auth = loadedState.codexAuthJson;
	let deviceState = loadedState.codexDeviceAuth;
	const conversationId = resolveConversationId(loadedState);

	if (!auth || !hasUsableAuthData(auth)) {
		auth = undefined;

		if (!deviceState || isDeviceCodeStateExpired(deviceState)) {
			deviceState = await requestDeviceCode(authContext);
			await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, {
				codexAuthJson: undefined,
				codexDeviceAuth: deviceState,
				conversationId,
			});
			return {
				status: 'pending',
				deviceState,
				conversationId,
				initiated: true,
			};
		}

		const pollResult =
			mode === 'blocking'
				? await pollDeviceCodeUntilAuthorized(
						authContext,
						deviceState,
						getRemainingDeviceCodeTtlMs(deviceState),
					)
				: await pollDeviceCode(authContext, deviceState);

		if (pollResult.status === 'pending') {
			await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, {
				codexAuthJson: undefined,
				codexDeviceAuth: deviceState,
				conversationId,
			});
			return {
				status: 'pending',
				deviceState,
				conversationId,
				initiated: false,
			};
		}

		const authorizationCode = toTrimmed(pollResult.token.authorization_code);
		const codeVerifier = toTrimmed(pollResult.token.code_verifier);
		if (!authorizationCode || !codeVerifier) {
			throw new ApplicationError('Device-code login returned an invalid authorization payload');
		}

		auth = await exchangeAuthorizationCodeForTokens(authContext, authorizationCode, codeVerifier);
		await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, {
			codexAuthJson: auth,
			codexDeviceAuth: undefined,
			conversationId,
		});
	}

	if (!auth) {
		throw new ApplicationError('No valid Codex auth state found. Run device-code login again.');
	}

	if (shouldRefreshAuthTokens(auth)) {
		auth = await refreshChatgptTokens(authContext, auth);
	}

	await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, {
		codexAuthJson: auth,
		codexDeviceAuth: undefined,
		conversationId,
	});

	return {
		status: 'authenticated',
		auth,
		conversationId,
	};
}

function buildPendingLoginMessage(deviceState: DeviceCodeState, initiated: boolean): string {
	return initiated
		? `Device login initiated. Open ${deviceState.verification_url} and enter code ${deviceState.user_code}. Then run this node again to verify login.`
		: `Device login pending. Open ${deviceState.verification_url} and enter code ${deviceState.user_code}. Then run this node again.`;
}

function resolveConfiguredModelName(context: ISupplyDataFunctions): {
	selectedModel: string;
	modelName: string;
} {
	const selectedModel = context.getNodeParameter('model', 0, DEFAULT_MODEL) as string;
	const customModel = context.getNodeParameter('customModel', 0, '') as string;
	const modelName =
		selectedModel === '__custom__'
			? toTrimmed(customModel) ?? DEFAULT_MODEL
			: toTrimmed(selectedModel) ?? DEFAULT_MODEL;

	return { selectedModel, modelName };
}

function resolveReasoningConfig(
	context: ISupplyDataFunctions,
	selectedModel: string,
	modelName: string,
): CodexResponsesReasoning | undefined {
	const reasoningParamName = resolveReasoningEffortParameterName(selectedModel);
	let selectedReasoningEffort = context.getNodeParameter(
		reasoningParamName,
		0,
		DEFAULT_REASONING_EFFORT,
	) as CodexReasoningEffort;

	// Backward compatibility for older workflow definitions.
	if (!selectedReasoningEffort) {
		selectedReasoningEffort = context.getNodeParameter(
			'reasoningEffort',
			0,
			DEFAULT_REASONING_EFFORT,
		) as CodexReasoningEffort;
	}

	const resolvedReasoningEffort = resolveReasoningEffortForModel(
		modelName,
		selectedReasoningEffort,
	);

	if (resolvedReasoningEffort === 'none') {
		return undefined;
	}

	return {
		effort: resolvedReasoningEffort as ModelReasoningEffort,
		summary: 'auto',
	};
}

// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class OpenAiCodexChatModel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'OpenAI codex',
		name: 'openAiCodexChatModel',
		icon: { light: 'file:../../icons/openAiCodex.svg', dark: 'file:../../icons/openAiCodex.dark.svg' },
		group: ['transform'],
		version: [1],
		description: 'Codex chat model using ChatGPT Codex backend with built-in device-code auth',
		defaults: {
			name: 'OpenAI codex',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://github.com/openai/codex',
					},
				],
			},
		},
		inputs: [
			{
				type: NodeConnectionTypes.Main,
				required: false,
			},
		],
		outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Status', 'Model'],
		properties: [
			{
				// eslint-disable-next-line n8n-nodes-base/node-param-display-name-miscased
				displayName:
					'How to login: click <strong>Test step</strong>. If login is required, output shows URL and code. Open that URL, enter the code, then click <strong>Test step</strong> again. Auth is persisted on disk and auto-refreshed.',
				name: 'usageCallout',
				type: 'callout',
				default: '',
			},
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				default: DEFAULT_MODEL,
				options: MODEL_OPTIONS,
				description: 'Model slug to use with the Codex backend',
			},
			{
				displayName: 'Custom Model',
				name: 'customModel',
				type: 'string',
				default: '',
				placeholder: 'e.g. gpt-5.4',
				displayOptions: {
					show: {
						model: ['__custom__'],
					},
				},
				description: 'Custom model slug',
			},
			{
				displayName: 'Reasoning Effort',
				name: 'reasoningEffortLmhx',
				type: 'options',
				default: DEFAULT_REASONING_EFFORT,
				options: REASONING_OPTIONS_LMHX,
				displayOptions: {
					show: {
						model: [...MODELS_REASONING_LMHX],
					},
				},
				description: 'Supported by this model: Low, Mid, High, Extreme',
			},
			{
				displayName: 'Reasoning Effort',
				name: 'reasoningEffortLmh',
				type: 'options',
				default: DEFAULT_REASONING_EFFORT,
				options: REASONING_OPTIONS_LMH,
				displayOptions: {
					show: {
						model: [...MODELS_REASONING_LMH],
					},
				},
				description: 'Supported by this model: Low, Mid, High',
			},
			{
				displayName: 'Reasoning Effort',
				name: 'reasoningEffortMinimalLmh',
				type: 'options',
				default: DEFAULT_REASONING_EFFORT,
				options: REASONING_OPTIONS_MINIMAL_LMH,
				displayOptions: {
					show: {
						model: [...MODELS_REASONING_MINIMAL_LMH],
					},
				},
				description: 'Supported by this model: Minimal, Low, Mid, High',
			},
			{
				displayName: 'Reasoning Effort',
				name: 'reasoningEffortMh',
				type: 'options',
				default: DEFAULT_REASONING_EFFORT,
				options: REASONING_OPTIONS_MH,
				displayOptions: {
					show: {
						model: [...MODELS_REASONING_MH],
					},
				},
				description: 'Supported by this model: Mid, High',
			},
			{
				displayName: 'Reasoning Effort',
				name: 'reasoningEffortCustom',
				type: 'options',
				default: DEFAULT_REASONING_EFFORT,
				options: REASONING_OPTIONS_CUSTOM,
				displayOptions: {
					show: {
						model: ['__custom__'],
					},
				},
				description:
					'Custom model mode. Shows all effort levels; unsupported values are normalized at runtime.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		try {
			const runtimeStateKey = getRuntimeStateKey(this as unknown as RuntimeStateContext);
			const stateContext = this as unknown as PersistedStateContext;
			const nodeStaticData = this.getWorkflowStaticData('node') as IDataObject;
			const authContext = this as unknown as AuthRequestContext;
			const resolved = await resolveNodeAuthState(
				stateContext,
				authContext,
				runtimeStateKey,
				nodeStaticData,
				'blocking',
			);

			if (resolved.status === 'pending') {
				return [this.helpers.returnJsonArray(buildPendingVerificationPayload(resolved.deviceState))];
			}

			return [
				this.helpers.returnJsonArray({
					status: 'authenticated',
					chatgpt_account_id: resolveAccountId(resolved.auth) ?? null,
					last_refresh: toTrimmed(resolved.auth.last_refresh) ?? null,
					conversation_id: resolved.conversationId,
				}),
			];
		} catch (error) {
			throw new NodeOperationError(this.getNode(), error as Error);
		}
	}

	async supplyData(this: ISupplyDataFunctions) {
		try {
			const runtimeStateKey = getRuntimeStateKey(this as unknown as RuntimeStateContext);
			const stateContext = this as unknown as PersistedStateContext;
			const authContext = this as unknown as AuthRequestContext;
			const nodeStaticData = this.getWorkflowStaticData('node') as IDataObject;
			const resolved = await resolveNodeAuthState(
				stateContext,
				authContext,
				runtimeStateKey,
				nodeStaticData,
				'single',
			);

			if (resolved.status === 'pending') {
				throw new NodeOperationError(
					this.getNode(),
					buildPendingLoginMessage(resolved.deviceState, resolved.initiated),
				);
			}

			const token = resolveAccessToken(resolved.auth);
			if (!token) {
				throw new NodeOperationError(
					this.getNode(),
					'Stored auth state does not contain an access token.',
				);
			}

			const chatgptAccountId = resolveAccountId(resolved.auth);
			if (!chatgptAccountId) {
				throw new NodeOperationError(
					this.getNode(),
					'Stored auth state does not include account ID and it could not be inferred from token claims',
				);
			}

			const { selectedModel, modelName } = resolveConfiguredModelName(this);
			const reasoningConfig = resolveReasoningConfig(this, selectedModel, modelName);
			const boundToolsDebugState: BoundToolsDebugState = {
				toolNames: [],
			};
			const defaultHeaders = {
				Authorization: `Bearer ${token}`,
				Accept: 'text/event-stream',
				...resolveDefaultHeaders(chatgptAccountId, resolved.conversationId),
			};

			const codexModel = new CodexResponsesChatModel(modelName, {
				baseUrl: DEFAULT_CHATGPT_CODEX_BASE_URL,
				defaultHeaders,
				defaultInstructions: DEFAULT_INSTRUCTIONS,
				reasoning: reasoningConfig,
				parallelToolCalls: supportsParallelToolCalls(modelName),
				promptCacheKey: resolved.conversationId,
				chatgptAccountId,
				debugState: boundToolsDebugState,
				openStreamRequest: async (request, headers) => {
					const response = (await this.helpers.httpRequest({
						method: 'POST',
						url: `${DEFAULT_CHATGPT_CODEX_BASE_URL}/responses`,
						headers,
						body: request,
						json: true,
						encoding: 'stream',
						ignoreHttpStatusErrors: true,
						returnFullResponse: true,
					})) as IN8nHttpFullResponse;

					return response;
				},
			});

			return supplyModel(this, codexModel);
		} catch (error) {
			throw new NodeOperationError(this.getNode(), error as Error);
		}
	}
}

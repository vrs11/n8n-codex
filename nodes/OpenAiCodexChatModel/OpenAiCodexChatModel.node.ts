import {
	BaseChatModel,
	getParametersJsonSchema,
	parseSSEStream,
	supplyModel,
	type ChatModelConfig,
	type GenerateResult,
	type Message,
	type MessageContent,
	type StreamChunk,
	type TokenUsage,
	type Tool,
} from '@n8n/ai-node-sdk';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import packageJson from '../../package.json';
import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INode,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError, OperationalError } from 'n8n-workflow';

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

type PersistedModelInfo = {
	slug: string;
	displayName: string;
	description?: string;
	priority: number;
	supportedInApi: boolean;
	visibility: 'list' | 'hide' | 'none';
	supportsParallelToolCalls: boolean;
	supportedReasoningEfforts: Array<{
		effort: ModelReasoningEffort;
		description?: string;
	}>;
	defaultReasoningEffort: CodexReasoningEffort;
	supportsReasoningSummary: boolean;
	defaultReasoningSummary: CodexReasoningSummary;
	supportsVerbosity: boolean;
	defaultVerbosity?: CodexVerbosity;
	serviceTiers: ModelServiceTier[];
	defaultServiceTier?: string;
	useResponsesLite: boolean;
	baseInstructions?: string;
};

type ModelServiceTier = {
	id: string;
	name: string;
	description?: string;
};

type ModelsCatalogState = {
	fetchedAt: string;
	models: PersistedModelInfo[];
};

type RuntimeNodeState = {
	codexAuthJson?: CodexAuthJson;
	codexDeviceAuth?: DeviceCodeState;
	modelsCatalog?: ModelsCatalogState;
};

type RuntimeStateContext = {
	getWorkflow: () => { id?: string | number | null };
	getNode: () => INode;
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

type CodexReasoningEffort = 'default' | 'none' | ModelReasoningEffort;
type ModelReasoningEffort = string;
type CodexReasoningSummary = 'none' | 'auto' | 'concise' | 'detailed';
type CodexVerbosity = 'low' | 'medium' | 'high';
const CUSTOM_MODEL_VALUE = '__custom__';

const MODEL_OPTIONS: INodePropertyOptions[] = [
	{
		name: 'Custom',
		value: CUSTOM_MODEL_VALUE,
	},
	{
		name: 'GPT-5.6-Sol',
		value: 'gpt-5.6-sol',
	},
	{
		name: 'GPT-5.6-Terra',
		value: 'gpt-5.6-terra',
	},
	{
		name: 'GPT-5.6-Luna',
		value: 'gpt-5.6-luna',
	},
	{
		name: 'GPT-5.5',
		value: 'gpt-5.5',
	},
	{
		name: 'GPT-5.2',
		value: 'gpt-5.2',
	},
];

const FALLBACK_MODEL_NAME_BY_SLUG = new Map(
	MODEL_OPTIONS.map((option) => [String(option.value).trim().toLowerCase(), option.name]),
);

const MODEL_REASONING_EFFORTS: Readonly<Record<string, ReadonlyArray<ModelReasoningEffort>>> = {
	'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
	'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
	'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
	'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
	'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
	'gpt-5.4-mini': ['low', 'medium', 'high', 'xhigh'],
	'gpt-5.2': ['low', 'medium', 'high', 'xhigh'],
};

const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = 'default';
const ALL_REASONING_EFFORTS: ReadonlyArray<ModelReasoningEffort> = [
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
];

function reasoningEffortLabel(value: CodexReasoningEffort): string {
	const labels: Readonly<Record<string, string>> = {
		default: 'Model Default',
		none: 'None',
		minimal: 'Minimal',
		low: 'Low',
		medium: 'Medium',
		high: 'High',
		xhigh: 'Extra High',
		max: 'Max',
		ultra: 'Ultra',
	};
	return labels[value] ?? value;
}

function reasoningEffortOptions(
	supported: ReadonlyArray<ModelReasoningEffort>,
): INodePropertyOptions[] {
	const values: CodexReasoningEffort[] = ['default', 'none', ...supported];
	return values.map((value) => ({
		name: reasoningEffortLabel(value),
		value,
	}));
}

type PersistedStateContext = AuthRequestContext & RuntimeStateContext;

const runtimeNodeState = new Map<string, RuntimeNodeState>();

const DEFAULT_CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_ORIGINATOR = 'codex_cli_rs';
const CODEX_CLIENT_ID =
	toTrimmed(process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID) ?? 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_ISSUER = 'https://auth.openai.com';
const REFRESH_TOKEN_URL =
	toTrimmed(process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE) ?? 'https://auth.openai.com/oauth/token';
const DEVICE_CODE_USERCODE_URL = `${AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_CODE_TOKEN_URL = `${AUTH_ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_CODE_VERIFICATION_URL = `${AUTH_ISSUER}/codex/device`;
const DEVICE_CODE_CALLBACK_URL = `${AUTH_ISSUER}/deviceauth/callback`;
const DEFAULT_MODEL = 'gpt-5.6-sol';
const TOKEN_REFRESH_INTERVAL_DAYS = 8;
const DEVICE_CODE_EXPIRY_MS = 15 * 60 * 1000;
const CODEX_NODE_VERSION = toTrimmed(packageJson.version) ?? '0.0.0';
const MODELS_CLIENT_VERSION = toTrimmed(process.env.N8N_OPENAI_CODEX_CLIENT_VERSION) ?? '0.145.0';
const CODEX_USER_AGENT = `${DEFAULT_ORIGINATOR}/${MODELS_CLIENT_VERSION} (n8n-openai-codex/${CODEX_NODE_VERSION})`;
const PERSISTED_STATE_PREFIX = '.openai-codex-state';
const DIRECT_PERSIST_DIR_ENV = 'N8N_OPENAI_CODEX_STATE_DIR';
const ALLOW_PARALLEL_TOOL_CALLS =
	toTrimmed(process.env.N8N_OPENAI_CODEX_ALLOW_PARALLEL_TOOLS) !== 'false';
const MODEL_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_INSTRUCTIONS = 'You are Codex.';
const REQUEST_NORMALIZER_VERSION = '2026-07-18.1';

type CodexResponsesMessageContentItem =
	| {
			type: 'input_text' | 'output_text';
			text: string;
	  }
	| {
			type: 'input_image';
			image_url: string;
			detail?: 'auto';
	  };

type CodexResponsesInputItem =
	| {
			type: 'message';
			role: 'user' | 'assistant' | 'developer';
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
	  }
	| {
			type: 'additional_tools';
			role: 'developer';
			tools: CodexResponsesTool[];
	  };

type CodexResponsesTool = {
	type: 'function';
	name: string;
	description: string;
	strict: false;
	parameters: Record<string, unknown>;
};

type CodexResponsesReasoning = {
	effort?: ModelReasoningEffort;
	summary?: Exclude<CodexReasoningSummary, 'none'>;
	context?: 'all_turns';
};

type CodexResponsesRequest = {
	model: string;
	instructions?: string;
	input: CodexResponsesInputItem[];
	tools?: CodexResponsesTool[];
	tool_choice: 'auto';
	parallel_tool_calls: boolean;
	stream: true;
	store: false;
	include: string[];
	prompt_cache_key: string;
	reasoning?: CodexResponsesReasoning;
	service_tier?: string;
	text?: { verbosity: CodexVerbosity };
	client_metadata: Record<string, string>;
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
	headers?: Record<string, unknown>;
	output?: CodexResponsesOutputItem[];
	status?: string;
	error?: { message?: string; code?: string };
	incomplete_details?: { reason?: string };
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
	headers?: Record<string, unknown>;
	delta?: string;
	output_index?: number;
	item?: Record<string, unknown>;
	response?: CodexResponsesResponse;
};

type CodexOpenStreamRequest = (
	request: CodexResponsesRequest,
	headers: Record<string, string>,
	config?: ChatModelConfig,
) => Promise<IN8nHttpFullResponse>;

type CodexResponsesChatModelConfig = {
	baseHeaders: Record<string, string>;
	defaultInstructions: string;
	reasoning?: CodexResponsesReasoning;
	serviceTier?: string;
	verbosity?: CodexVerbosity;
	parallelToolCalls: boolean;
	useResponsesLite: boolean;
	refreshAuthHeaders: () => Promise<Record<string, string>>;
	chatgptAccountId: string;
	openStreamRequest: CodexOpenStreamRequest;
	debugState: BoundToolsDebugState;
};

function isAsyncBufferIterable(
	value: unknown,
): value is AsyncIterableIterator<Buffer | Uint8Array> {
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

function getReportedModelFromHeaders(headers: unknown): string | undefined {
	const values = toObject(headers);
	if (!values) return undefined;
	for (const [name, value] of Object.entries(values)) {
		const normalizedName = name.toLowerCase();
		if (normalizedName !== 'openai-model' && normalizedName !== 'x-openai-model') continue;
		return toTrimmed(value);
	}
	return undefined;
}

function getReportedModelFromEvent(event: CodexStreamEvent): string | undefined {
	return (
		getReportedModelFromHeaders(event.response?.headers) ??
		getReportedModelFromHeaders(event.headers)
	);
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

function toCodexInputMedia(part: MessageContent): CodexResponsesMessageContentItem | undefined {
	if (part.type !== 'file') return undefined;

	const mediaType = toTrimmed(part.mediaType)?.toLowerCase();
	if (mediaType?.startsWith('audio/')) {
		return {
			type: 'input_text',
			text: 'Codex does not support audio input yet.',
		};
	}
	if (!mediaType?.startsWith('image/')) return undefined;

	const rawData =
		typeof part.data === 'string' ? part.data : Buffer.from(part.data).toString('base64');
	const imageUrl = rawData.startsWith('data:') ? rawData : `data:${mediaType};base64,${rawData}`;
	return {
		type: 'input_image',
		image_url: imageUrl,
		detail: 'auto',
	};
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

function toCodexInput(
	messages: Message[],
	fallbackPrompt = 'Continue.',
): {
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
				const media = toCodexInputMedia(part);
				if (media) {
					content.push(media);
					continue;
				}
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

function codexToolFromGenericTool(tool: Tool): CodexResponsesTool | undefined {
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

function assertSuccessfulCodexResponse(response: CodexResponsesResponse | undefined): void {
	if (!response) {
		throw new OperationalError('Codex response stream ended before a terminal event');
	}

	const status = toTrimmed(response.status);
	if (status === 'failed') {
		const detail = toTrimmed(response.error?.message) ?? toTrimmed(response.error?.code);
		throw new OperationalError(
			detail ? `Codex response failed: ${detail}` : 'Codex response failed',
		);
	}
	if (status === 'incomplete') {
		const reason = toTrimmed(response.incomplete_details?.reason);
		throw new OperationalError(
			reason ? `Codex response was incomplete: ${reason}` : 'Codex response was incomplete',
		);
	}
}

class CodexResponsesChatModel extends BaseChatModel {
	private readonly sessionId = randomUUID();
	private readonly threadId = randomUUID();
	private readonly installationId = randomUUID();
	private readonly windowId = randomUUID();

	constructor(
		modelId: string,
		private readonly config: CodexResponsesChatModelConfig,
	) {
		super('openai-codex', modelId);
	}

	private buildRequestHeaders(config?: ChatModelConfig): Record<string, string> {
		const headers: Record<string, string> = {
			...this.config.baseHeaders,
			'x-client-request-id': this.threadId,
			'session-id': this.sessionId,
			'thread-id': this.threadId,
			'x-codex-window-id': this.windowId,
			...(this.config.useResponsesLite ? { 'x-openai-internal-codex-responses-lite': 'true' } : {}),
		};
		for (const [name, value] of Object.entries(config?.headers ?? {})) {
			if (value !== undefined) headers[name] = value;
		}
		return headers;
	}

	private buildRequest(messages: Message[], turnId: string): CodexResponsesRequest {
		const tools: CodexResponsesTool[] = [];
		for (const tool of this.tools) {
			const normalizedTool = codexToolFromGenericTool(tool);
			if (!normalizedTool) continue;
			tools.push(normalizedTool);
		}

		const normalizedInput = toCodexInput(messages);
		const instructions = normalizedInput.instructions ?? this.config.defaultInstructions;
		const input = [...normalizedInput.input];
		if (this.config.useResponsesLite) {
			for (const item of input) {
				if (item.type !== 'message') continue;
				for (const contentItem of item.content) {
					if (contentItem.type === 'input_image') delete contentItem.detail;
				}
			}
			const prefix: CodexResponsesInputItem[] = [
				{
					type: 'additional_tools',
					role: 'developer',
					tools,
				},
			];
			if (instructions) {
				prefix.push({
					type: 'message',
					role: 'developer',
					content: [{ type: 'input_text', text: instructions }],
				});
			}
			input.unshift(...prefix);
		}

		const reasoning = this.config.reasoning
			? {
					...this.config.reasoning,
					...(this.config.useResponsesLite ? { context: 'all_turns' as const } : {}),
				}
			: undefined;

		const request: CodexResponsesRequest = {
			model: this.modelId,
			...(this.config.useResponsesLite ? {} : { instructions }),
			input,
			...(this.config.useResponsesLite ? {} : { tools }),
			tool_choice: 'auto',
			parallel_tool_calls: this.config.parallelToolCalls && !this.config.useResponsesLite,
			stream: true,
			store: false,
			include: ['reasoning.encrypted_content'],
			prompt_cache_key: this.sessionId,
			...(reasoning ? { reasoning } : {}),
			...(this.config.serviceTier ? { service_tier: this.config.serviceTier } : {}),
			...(this.config.verbosity ? { text: { verbosity: this.config.verbosity } } : {}),
			client_metadata: {
				'x-codex-installation-id': this.installationId,
				session_id: this.sessionId,
				thread_id: this.threadId,
				turn_id: turnId,
				'x-codex-window-id': this.windowId,
			},
		};

		this.config.debugState.toolNames = tools.map((tool) => tool.name);
		this.config.debugState.lastModel = this.modelId;
		this.config.debugState.lastToolChoice = request.tool_choice;
		this.config.debugState.lastParallelToolCalls = String(request.parallel_tool_calls);
		this.config.debugState.lastToolsPayload =
			tools.length > 0 ? truncateErrorValue(JSON.stringify(tools)) : undefined;
		this.config.debugState.lastReasoning = reasoning
			? truncateErrorValue(JSON.stringify(reasoning))
			: undefined;
		this.config.debugState.lastRequestKeys = Object.keys(request).sort().join(',');
		setInputDebugState(request.input, this.config.debugState);

		return request;
	}

	private async openResponsesStream(
		request: CodexResponsesRequest,
		config?: ChatModelConfig,
	): Promise<AsyncIterableIterator<Buffer | Uint8Array>> {
		let response = await this.config.openStreamRequest(
			request,
			this.buildRequestHeaders(config),
			config,
		);

		if (response.statusCode === 401) {
			const refreshedHeaders = await this.config.refreshAuthHeaders();
			response = await this.config.openStreamRequest(
				request,
				{
					...this.buildRequestHeaders(config),
					...refreshedHeaders,
				},
				config,
			);
		}

		if (response.statusCode < 200 || response.statusCode > 299) {
			const errorPayload = {
				status: response.statusCode,
				message:
					extractBackendErrorMessage(response.body) ??
					`${response.statusCode} status code (no body)`,
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
			throw new OperationalError('Codex backend did not return a stream body');
		}

		return response.body;
	}

	async generate(messages: Message[], config?: ChatModelConfig): Promise<GenerateResult> {
		const request = this.buildRequest(messages, randomUUID());
		const stream = await this.openResponsesStream(request, config);

		let text = '';
		let reasoning = '';
		const streamedToolCalls: Array<{
			id: string;
			name: string;
			argumentsRaw: string;
		}> = [];
		const toolCallBuffers: Record<number, { id: string; name: string; argumentsRaw: string }> = {};
		let finalResponse: CodexResponsesResponse | undefined;
		let reportedModel: string | undefined;

		for await (const event of parseCodexStreamEvents(stream)) {
			reportedModel = getReportedModelFromEvent(event) ?? reportedModel;
			const eventType = toTrimmed(event.type);
			if (!eventType) continue;

			if (eventType === 'response.output_text.delta') {
				const delta = toStringValue(event.delta);
				if (delta) text += delta;
				continue;
			}

			if (
				eventType === 'response.reasoning_summary_text.delta' ||
				eventType === 'response.reasoning_text.delta'
			) {
				const delta = toStringValue(event.delta);
				if (delta) reasoning += delta;
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
						argumentsRaw: toStringValue(item.arguments) ?? '',
					};
				}
				continue;
			}

			if (eventType === 'response.function_call_arguments.delta') {
				const idx = event.output_index ?? 0;
				const delta = toStringValue(event.delta);
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
					argumentsRaw: buffered?.argumentsRaw || toStringValue(item.arguments) || '{}',
				});
				continue;
			}

			if (
				eventType === 'response.done' ||
				eventType === 'response.completed' ||
				eventType === 'response.failed' ||
				eventType === 'response.incomplete'
			) {
				finalResponse = toObject(event.response) as CodexResponsesResponse | undefined;
			}
		}
		if (finalResponse && reportedModel && !toTrimmed(finalResponse.model)) {
			finalResponse = { ...finalResponse, model: reportedModel };
		}

		assertSuccessfulCodexResponse(finalResponse);
		assertNoModelSubstitution(this.modelId, finalResponse);

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
		if (reasoning) {
			content.push({
				type: 'reasoning',
				text: reasoning,
			});
		}
		for (const toolCall of mergedToolCalls.values()) {
			const parsedArguments = parseToolCallArguments(toolCall.argumentsRaw || '{}');
			content.push({
				type: 'tool-call',
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				input: JSON.stringify(parsedArguments),
			});
		}
		if (finalText) {
			content.push({
				type: 'text',
				text: finalText,
			});
		}

		return {
			id: toTrimmed(finalResponse?.id) ?? randomUUID(),
			finishReason: mergedToolCalls.size > 0 ? 'tool-calls' : 'stop',
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

	async *stream(messages: Message[], config?: ChatModelConfig): AsyncIterable<StreamChunk> {
		const request = this.buildRequest(messages, randomUUID());
		const stream = await this.openResponsesStream(request, config);
		const toolCallBuffers: Record<number, { id: string; name: string; argumentsRaw: string }> = {};
		let emittedToolCall = false;
		let reportedModel: string | undefined;

		for await (const event of parseCodexStreamEvents(stream)) {
			reportedModel = getReportedModelFromEvent(event) ?? reportedModel;
			const eventType = toTrimmed(event.type);
			if (!eventType) continue;

			if (eventType === 'response.output_text.delta') {
				const delta = toStringValue(event.delta);
				if (delta) {
					yield { type: 'text-delta', delta };
				}
				continue;
			}

			if (
				eventType === 'response.reasoning_summary_text.delta' ||
				eventType === 'response.reasoning_text.delta'
			) {
				const delta = toStringValue(event.delta);
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
						argumentsRaw: toStringValue(item.arguments) ?? '',
					};
				}
				continue;
			}

			if (eventType === 'response.function_call_arguments.delta') {
				const idx = event.output_index ?? 0;
				const delta = toStringValue(event.delta);
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
				emittedToolCall = true;
				yield {
					type: 'tool-call-delta',
					id: callId,
					name,
					argumentsDelta: buffered?.argumentsRaw || toStringValue(item.arguments) || '{}',
				};
				continue;
			}

			if (
				eventType === 'response.done' ||
				eventType === 'response.completed' ||
				eventType === 'response.failed' ||
				eventType === 'response.incomplete'
			) {
				let response = toObject(event.response) as CodexResponsesResponse | undefined;
				if (response && reportedModel && !toTrimmed(response.model)) {
					response = { ...response, model: reportedModel };
				}
				assertSuccessfulCodexResponse(response);
				assertNoModelSubstitution(this.modelId, response);
				yield {
					type: 'finish',
					finishReason: emittedToolCall ? 'tool-calls' : 'stop',
					usage: parseCodexTokenUsage(response?.usage),
				};
				return;
			}
		}

		throw new OperationalError('Codex response stream ended before a terminal event');
	}
}

function toTrimmed(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function toStringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string') {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	return undefined;
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

function isJwtExpiredOrAlmostExpired(token?: string, leewayMs = 5 * 60_000): boolean {
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
			throw new OperationalError('Auth JSON is empty');
		}

		parsed = JSON.parse(text);
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new OperationalError('Auth JSON root must be an object');
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

function hasModelsCatalogState(state: RuntimeNodeState): boolean {
	return Boolean(state.modelsCatalog && state.modelsCatalog.models.length > 0);
}

function hasRuntimeState(state: RuntimeNodeState): boolean {
	return Boolean(state.codexAuthJson || state.codexDeviceAuth || hasModelsCatalogState(state));
}

function setRuntimeAuthState(key: string, auth: CodexAuthJson | undefined): void {
	const current = getRuntimeState(key);
	if (auth) {
		current.codexAuthJson = deepCloneAuthJson(auth);
	} else {
		delete current.codexAuthJson;
	}

	if (hasRuntimeState(current)) {
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

	if (hasRuntimeState(current)) {
		runtimeNodeState.set(key, current);
	} else {
		runtimeNodeState.delete(key);
	}
}

function setRuntimeModelsCatalogState(
	key: string,
	modelsCatalog: ModelsCatalogState | undefined,
): void {
	const current = getRuntimeState(key);
	if (modelsCatalog && modelsCatalog.models.length > 0) {
		current.modelsCatalog = {
			fetchedAt: modelsCatalog.fetchedAt,
			models: modelsCatalog.models.map((model) => ({ ...model })),
		};
	} else {
		delete current.modelsCatalog;
	}

	if (hasRuntimeState(current)) {
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

function normalizeModelVisibility(value: unknown): PersistedModelInfo['visibility'] {
	const normalized = toTrimmed(value)?.toLowerCase();
	if (normalized === 'hide') return 'hide';
	if (normalized === 'none') return 'none';
	return 'list';
}

function normalizeModelReasoningEffort(value: unknown): ModelReasoningEffort | undefined {
	const normalized = toTrimmed(value)?.toLowerCase();
	if (!normalized || normalized === 'none' || normalized === 'default') return undefined;
	if (normalized === 'mid') return 'medium';
	return /^[a-z0-9_-]+$/.test(normalized) ? normalized : undefined;
}

function normalizeReasoningProfiles(
	value: unknown,
): PersistedModelInfo['supportedReasoningEfforts'] {
	const entries = Array.isArray(value) ? value : [];
	const profiles = new Map<
		ModelReasoningEffort,
		{ effort: ModelReasoningEffort; description?: string }
	>();
	for (const entry of entries) {
		const obj = toObject(entry);
		const effort = normalizeModelReasoningEffort(obj?.effort ?? obj?.value ?? entry);
		if (!effort) continue;
		const description = toTrimmed(obj?.description);
		profiles.set(effort, { effort, ...(description ? { description } : {}) });
	}
	return [...profiles.values()];
}

function normalizeReasoningSummary(value: unknown): CodexReasoningSummary {
	const normalized = toTrimmed(value)?.toLowerCase();
	if (normalized === 'auto' || normalized === 'concise' || normalized === 'detailed') {
		return normalized;
	}
	return 'none';
}

function normalizeVerbosity(value: unknown): CodexVerbosity | undefined {
	const normalized = toTrimmed(value)?.toLowerCase();
	return normalized === 'low' || normalized === 'medium' || normalized === 'high'
		? normalized
		: undefined;
}

function normalizeServiceTiers(value: unknown): ModelServiceTier[] {
	const entries = Array.isArray(value) ? value : [];
	const tiers: ModelServiceTier[] = [];
	for (const entry of entries) {
		const obj = toObject(entry);
		const id = toTrimmed(obj?.id);
		const name = toTrimmed(obj?.name);
		if (!id || !name) continue;
		const description = toTrimmed(obj?.description);
		tiers.push({ id, name, ...(description ? { description } : {}) });
	}
	return tiers;
}

function defaultReasoningEffortForSupported(
	supported: PersistedModelInfo['supportedReasoningEfforts'],
	preferred?: unknown,
): CodexReasoningEffort {
	const normalizedPreferred = normalizeModelReasoningEffort(preferred);
	const efforts = supported.map((profile) => profile.effort);
	if (normalizedPreferred && efforts.includes(normalizedPreferred)) {
		return normalizedPreferred;
	}
	return efforts.includes('medium') ? 'medium' : (efforts[0] ?? 'none');
}

function normalizePersistedModelInfo(value: unknown): PersistedModelInfo | undefined {
	const obj = toObject(value);
	if (!obj) return undefined;

	const slug = normalizeModelName(toTrimmed(obj.slug));
	if (!slug) return undefined;

	const displayName =
		toTrimmed(obj.displayName ?? obj.display_name) ?? FALLBACK_MODEL_NAME_BY_SLUG.get(slug) ?? slug;
	const priority = Math.floor(toFiniteNumber(obj.priority) ?? 10_000);
	const supportedInApi =
		typeof obj.supportedInApi === 'boolean'
			? obj.supportedInApi
			: typeof obj.supported_in_api === 'boolean'
				? obj.supported_in_api
				: true;
	const supportsParallelToolCalls =
		typeof obj.supportsParallelToolCalls === 'boolean'
			? obj.supportsParallelToolCalls
			: typeof obj.supports_parallel_tool_calls === 'boolean'
				? obj.supports_parallel_tool_calls
				: false;

	const supportedReasoningEffortsRaw = Array.isArray(obj.supportedReasoningEfforts)
		? obj.supportedReasoningEfforts
		: Array.isArray(obj.supported_reasoning_levels)
			? obj.supported_reasoning_levels
			: Array.isArray(obj.supported_reasoning_efforts)
				? obj.supported_reasoning_efforts
				: undefined;
	let supportedReasoningEfforts = normalizeReasoningProfiles(supportedReasoningEffortsRaw);

	if (supportedReasoningEfforts.length === 0) {
		const fallbackEfforts = MODEL_REASONING_EFFORTS[slug];
		supportedReasoningEfforts = (fallbackEfforts ?? []).map((effort) => ({
			effort,
		}));
	}
	const supportsReasoningSummaryValue =
		obj.supportsReasoningSummary ?? obj.supports_reasoning_summary_parameter;
	const supportsVerbosityValue = obj.supportsVerbosity ?? obj.support_verbosity;
	const defaultServiceTier = toTrimmed(obj.defaultServiceTier ?? obj.default_service_tier);

	return {
		slug,
		displayName,
		description: toTrimmed(obj.description),
		priority,
		supportedInApi,
		visibility: normalizeModelVisibility(obj.visibility),
		supportsParallelToolCalls,
		supportedReasoningEfforts,
		defaultReasoningEffort: defaultReasoningEffortForSupported(
			supportedReasoningEfforts,
			obj.defaultReasoningEffort ?? obj.default_reasoning_level ?? obj.default_reasoning_effort,
		),
		supportsReasoningSummary:
			typeof supportsReasoningSummaryValue === 'boolean' ? supportsReasoningSummaryValue : true,
		defaultReasoningSummary: normalizeReasoningSummary(
			obj.defaultReasoningSummary ?? obj.default_reasoning_summary,
		),
		supportsVerbosity: typeof supportsVerbosityValue === 'boolean' ? supportsVerbosityValue : false,
		defaultVerbosity: normalizeVerbosity(obj.defaultVerbosity ?? obj.default_verbosity),
		serviceTiers: normalizeServiceTiers(obj.serviceTiers ?? obj.service_tiers),
		...(defaultServiceTier ? { defaultServiceTier } : {}),
		useResponsesLite: Boolean(obj.useResponsesLite ?? obj.use_responses_lite),
		baseInstructions: toTrimmed(obj.baseInstructions ?? obj.base_instructions),
	};
}

function normalizeModelsCatalogState(value: unknown): ModelsCatalogState | undefined {
	const obj = toObject(value);
	if (!obj) return undefined;

	const fetchedAt = toTrimmed(obj.fetchedAt ?? obj.fetched_at);
	if (!fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) {
		return undefined;
	}

	const rawModels = Array.isArray(obj.models) ? obj.models : [];
	const bySlug = new Map<string, PersistedModelInfo>();
	for (const rawModel of rawModels) {
		const normalized = normalizePersistedModelInfo(rawModel);
		if (!normalized) continue;
		bySlug.set(normalized.slug, normalized);
	}

	const models = [...bySlug.values()].sort((a, b) =>
		a.priority === b.priority ? a.slug.localeCompare(b.slug) : a.priority - b.priority,
	);
	if (models.length === 0) {
		return undefined;
	}

	return {
		fetchedAt,
		models,
	};
}

function fallbackModel(
	slug: string,
	displayName: string,
	description: string,
	priority: number,
	visibility: PersistedModelInfo['visibility'],
	defaultReasoningEffort: ModelReasoningEffort,
	defaultReasoningSummary: CodexReasoningSummary,
	defaultVerbosity: CodexVerbosity,
	useResponsesLite: boolean,
	serviceTiers: ModelServiceTier[] = [],
): PersistedModelInfo {
	return {
		slug,
		displayName,
		description,
		priority,
		supportedInApi: true,
		visibility,
		supportsParallelToolCalls: true,
		supportedReasoningEfforts: (MODEL_REASONING_EFFORTS[slug] ?? []).map((effort) => ({ effort })),
		defaultReasoningEffort,
		supportsReasoningSummary: true,
		defaultReasoningSummary,
		supportsVerbosity: true,
		defaultVerbosity,
		serviceTiers,
		useResponsesLite,
	};
}

const PRIORITY_SERVICE_TIER: ModelServiceTier[] = [
	{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' },
];

const FALLBACK_MODELS_CATALOG: ModelsCatalogState = {
	fetchedAt: new Date(0).toISOString(),
	models: [
		fallbackModel(
			'gpt-5.6-sol',
			'GPT-5.6-Sol',
			'Latest frontier agentic coding model.',
			1,
			'list',
			'low',
			'none',
			'low',
			true,
			PRIORITY_SERVICE_TIER,
		),
		fallbackModel(
			'gpt-5.6-terra',
			'GPT-5.6-Terra',
			'Balanced agentic coding model for everyday work.',
			2,
			'list',
			'medium',
			'none',
			'low',
			true,
			PRIORITY_SERVICE_TIER,
		),
		fallbackModel(
			'gpt-5.6-luna',
			'GPT-5.6-Luna',
			'Fast and affordable agentic coding model.',
			3,
			'list',
			'medium',
			'none',
			'low',
			true,
			PRIORITY_SERVICE_TIER,
		),
		fallbackModel(
			'gpt-5.5',
			'GPT-5.5',
			'Frontier model for complex coding, research, and real-world work.',
			7,
			'list',
			'medium',
			'none',
			'low',
			false,
			PRIORITY_SERVICE_TIER,
		),
		fallbackModel(
			'gpt-5.4',
			'GPT-5.4',
			'Strong model for everyday coding.',
			16,
			'hide',
			'medium',
			'none',
			'low',
			false,
			PRIORITY_SERVICE_TIER,
		),
		fallbackModel(
			'gpt-5.4-mini',
			'GPT-5.4-Mini',
			'Small, fast, and cost-efficient model for simpler coding tasks.',
			23,
			'hide',
			'medium',
			'none',
			'medium',
			false,
		),
		fallbackModel(
			'gpt-5.2',
			'GPT-5.2',
			'Optimized for professional work and long-running agents.',
			29,
			'list',
			'medium',
			'auto',
			'low',
			false,
		),
		fallbackModel(
			'codex-auto-review',
			'Codex Auto Review',
			'Automatic approval review model for Codex.',
			43,
			'hide',
			'medium',
			'none',
			'low',
			false,
		),
	],
};

function mergeWithFallbackCatalog(catalog: ModelsCatalogState | undefined): ModelsCatalogState {
	if (!catalog || catalog.models.length === 0) {
		return FALLBACK_MODELS_CATALOG;
	}

	return catalog;
}

function isModelsCatalogFresh(catalog: ModelsCatalogState | undefined): boolean {
	if (!catalog) return false;
	const fetchedAtMs = Date.parse(catalog.fetchedAt);
	if (!Number.isFinite(fetchedAtMs)) return false;
	return fetchedAtMs + MODEL_CATALOG_CACHE_TTL_MS > Date.now();
}

function getModelRecordFromCatalog(
	catalog: ModelsCatalogState | undefined,
	modelName: string | undefined,
): PersistedModelInfo | undefined {
	const normalized = normalizeModelName(modelName);
	if (!normalized) return undefined;
	return catalog?.models.find((model) => model.slug === normalized);
}

function getModelOptionsFromCatalog(catalog: ModelsCatalogState): INodePropertyOptions[] {
	const options: INodePropertyOptions[] = [
		{
			name: 'Custom',
			value: CUSTOM_MODEL_VALUE,
		},
	];

	for (const model of catalog.models) {
		if (!model.supportedInApi || model.visibility !== 'list') continue;
		options.push({
			name: model.displayName,
			value: model.slug,
			...(model.description ? { description: model.description } : {}),
		});
	}

	return options;
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

	const modelsCatalog = normalizeModelsCatalogState(parsed.modelsCatalog ?? parsed.models_catalog);
	if (modelsCatalog) {
		state.modelsCatalog = modelsCatalog;
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

		throw new NodeOperationError(
			context.getNode(),
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
		payload.codexDeviceAuth = {
			...state.codexDeviceAuth,
		} as unknown as IDataObject;
	}

	if (state.modelsCatalog && state.modelsCatalog.models.length > 0) {
		payload.modelsCatalog = {
			fetchedAt: state.modelsCatalog.fetchedAt,
			models: state.modelsCatalog.models.map((model) => ({ ...model })),
		} as unknown as IDataObject;
	}

	try {
		const stateDirectory = dirname(filePath);
		await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
		if (process.platform !== 'win32') {
			await chmod(stateDirectory, 0o700);
		}
		const tempPath = `${filePath}.${randomUUID()}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(payload)}\n`, {
			encoding: 'utf8',
			mode: 0o600,
		});
		await rename(tempPath, filePath);
		if (process.platform !== 'win32') {
			await chmod(filePath, 0o600);
		}
	} catch (error) {
		throw new NodeOperationError(
			context.getNode(),
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
	const modelsCatalogRaw =
		persistedState.modelsCatalog ?? nodeStaticData.modelsCatalog ?? runtimeState.modelsCatalog;
	const modelsCatalog = normalizeModelsCatalogState(modelsCatalogRaw);

	return {
		codexAuthJson: authRaw ? normalizeAuthJson(authRaw) : undefined,
		codexDeviceAuth: normalizeDeviceCodeState(deviceRaw),
		modelsCatalog,
	};
}

async function saveNodeState(
	context: PersistedStateContext,
	runtimeStateKey: string,
	nodeStaticData: IDataObject,
	state: RuntimeNodeState,
): Promise<void> {
	// Migrate secrets written by older releases out of workflow static data. The state file is
	// local to the n8n instance and is written with owner-only permissions below.
	delete nodeStaticData.codexAuthJson;
	delete nodeStaticData.codexDeviceAuth;
	delete nodeStaticData.sessionConversations;
	delete nodeStaticData.modelsCatalog;

	setRuntimeAuthState(runtimeStateKey, state.codexAuthJson);
	setRuntimeDeviceState(runtimeStateKey, state.codexDeviceAuth);
	setRuntimeModelsCatalogState(runtimeStateKey, state.modelsCatalog);

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
			throw new OperationalError(
				'Device-code login is not enabled for this auth server. Use Codex browser login and re-try.',
			);
		}

		throw new OperationalError(
			detail
				? `Device-code start failed with status ${response.statusCode}: ${detail}`
				: `Device-code start failed with status ${response.statusCode}`,
		);
	}

	const payload = (toObject(response.body) ?? {}) as DeviceCodeStartResponse;
	const deviceAuthId = toTrimmed(payload.device_auth_id);
	const userCode = toTrimmed(payload.user_code) ?? toTrimmed(payload.usercode);

	if (!deviceAuthId || !userCode) {
		throw new OperationalError('Device-code response is missing required fields');
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
		throw new OperationalError(
			detail
				? `Device-code poll failed with status ${response.statusCode}: ${detail}`
				: `Device-code poll failed with status ${response.statusCode}`,
		);
	}

	const payload = (toObject(response.body) ?? {}) as DeviceCodePollSuccess;
	if (!toTrimmed(payload.authorization_code) || !toTrimmed(payload.code_verifier)) {
		throw new OperationalError('Device-code poll succeeded but authorization payload is invalid');
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
		throw new OperationalError(
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
		throw new OperationalError('Authorization-code exchange did not return full token set');
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

function resolveDefaultHeaders(chatgptAccountId: string): Record<string, string> {
	const headers: Record<string, string> = {
		originator: DEFAULT_ORIGINATOR,
		'chatgpt-account-id': chatgptAccountId,
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

	return toTrimmed(obj?.code) ?? toTrimmed(body?.code) ?? toTrimmed(toObject(body?.error)?.code);
}

function getErrorMessage(error: unknown): string | undefined {
	const obj = toObject(error);
	const body = getErrorBodyObject(error);

	return (
		toTrimmed(body?.message) ?? toTrimmed(toObject(body?.error)?.message) ?? toTrimmed(obj?.message)
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

function buildUnauthorizedModelError(error: unknown, chatgptAccountId: string): OperationalError {
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

	return new OperationalError(details);
}

function buildModelRequestFailedError(
	error: unknown,
	chatgptAccountId: string,
	debugState?: BoundToolsDebugState,
): OperationalError {
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

	return new OperationalError(details);
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
			if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
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

function supportsParallelToolCalls(
	modelName: string | undefined,
	modelsCatalog?: ModelsCatalogState,
): boolean {
	if (!ALLOW_PARALLEL_TOOL_CALLS) {
		// Instance-level compatibility override for deployments that require serial tool calls.
		return false;
	}

	if (!modelName) return false;

	const normalized = modelName.trim().toLowerCase();
	if (!normalized) return false;

	const fromCatalog = getModelRecordFromCatalog(modelsCatalog, normalized);
	if (fromCatalog) return fromCatalog.supportsParallelToolCalls;

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

function getModelReasoningEfforts(
	modelName: string | undefined,
	modelsCatalog?: ModelsCatalogState,
): ReadonlyArray<ModelReasoningEffort> | undefined {
	const normalized = normalizeModelName(modelName);
	if (!normalized) return undefined;

	const catalogModel = getModelRecordFromCatalog(modelsCatalog, normalized);
	if (catalogModel && catalogModel.supportedReasoningEfforts.length > 0) {
		return catalogModel.supportedReasoningEfforts.map((profile) => profile.effort);
	}

	return MODEL_REASONING_EFFORTS[normalized];
}

function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
	return value === 'default' || value === 'none' || normalizeModelReasoningEffort(value) === value;
}

function formatReasoningEffortList(efforts: ReadonlyArray<ModelReasoningEffort>): string {
	return efforts.map((effort) => reasoningEffortLabel(effort)).join(', ');
}

function isModelSelectionCompatible(requestedModel: string, responseModel: string): boolean {
	const requested = normalizeModelName(requestedModel);
	const actual = normalizeModelName(responseModel);
	if (!requested || !actual) return true;
	if (requested === actual) return true;
	if (actual.startsWith(`${requested}-`)) return true;
	if (requested.startsWith(`${actual}-`)) return true;
	return false;
}

function assertNoModelSubstitution(
	requestedModel: string,
	response: CodexResponsesResponse | undefined,
): void {
	const responseModel = toTrimmed(response?.model);
	if (!responseModel) return;
	if (isModelSelectionCompatible(requestedModel, responseModel)) return;

	throw new OperationalError(
		`Model mismatch: requested "${requestedModel}", backend returned "${responseModel}". This backend substituted the model.`,
	);
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
			throw new OperationalError(buildRefreshFailureMessage(refreshResponse.body));
		}

		const detail = extractBackendErrorMessage(refreshResponse.body);
		throw new OperationalError(
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
	return (
		toTrimmed(tokens?.access_token) ??
		toTrimmed(auth.OPENAI_API_KEY) ??
		toTrimmed(auth.openai_api_key)
	);
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

function normalizeRemoteModelInfo(value: unknown): PersistedModelInfo | undefined {
	return normalizePersistedModelInfo(value);
}

async function fetchModelsCatalogFromBackend(
	context: AuthRequestContext,
	accessToken: string,
	chatgptAccountId: string,
): Promise<ModelsCatalogState> {
	const response = (await context.helpers.httpRequest({
		method: 'GET',
		url: `${DEFAULT_CHATGPT_CODEX_BASE_URL}/models?client_version=${encodeURIComponent(MODELS_CLIENT_VERSION)}`,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
			...resolveDefaultHeaders(chatgptAccountId),
		},
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as IN8nHttpFullResponse;

	if (response.statusCode < 200 || response.statusCode > 299) {
		const detail = extractBackendErrorMessage(response.body);
		throw new OperationalError(
			detail
				? `Failed to fetch model catalog. status=${response.statusCode} message=${detail}`
				: `Failed to fetch model catalog. status=${response.statusCode}`,
		);
	}

	const body = toObject(response.body);
	const rawModels = Array.isArray(body?.models) ? body.models : [];
	const parsedBySlug = new Map<string, PersistedModelInfo>();
	for (const rawModel of rawModels) {
		const normalized = normalizeRemoteModelInfo(rawModel);
		if (!normalized) continue;
		parsedBySlug.set(normalized.slug, normalized);
	}

	if (parsedBySlug.size === 0) {
		throw new OperationalError('Model catalog response did not include any valid model metadata');
	}

	return mergeWithFallbackCatalog({
		fetchedAt: new Date().toISOString(),
		models: [...parsedBySlug.values()],
	});
}

async function resolveModelsCatalogForExecution(
	stateContext: PersistedStateContext,
	authContext: AuthRequestContext,
	runtimeStateKey: string,
	nodeStaticData: IDataObject,
	auth: CodexAuthJson,
): Promise<ModelsCatalogState> {
	const loadedState = await loadNodeState(stateContext, runtimeStateKey, nodeStaticData);
	if (isModelsCatalogFresh(loadedState.modelsCatalog)) {
		return mergeWithFallbackCatalog(loadedState.modelsCatalog);
	}

	const accessToken = resolveAccessToken(auth);
	const accountId = resolveAccountId(auth);
	if (!accessToken || !accountId) {
		return mergeWithFallbackCatalog(loadedState.modelsCatalog);
	}

	try {
		const refreshedCatalog = await fetchModelsCatalogFromBackend(
			authContext,
			accessToken,
			accountId,
		);
		const nextState: RuntimeNodeState = {
			...loadedState,
			codexAuthJson: deepCloneAuthJson(auth),
			codexDeviceAuth: undefined,
			modelsCatalog: refreshedCatalog,
		};
		await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, nextState);
		return refreshedCatalog;
	} catch {
		return mergeWithFallbackCatalog(loadedState.modelsCatalog);
	}
}

async function resolveModelsCatalogForLoadOptions(
	context: ILoadOptionsFunctions,
): Promise<ModelsCatalogState> {
	const stateContext = context as unknown as PersistedStateContext;
	const authContext = context as unknown as AuthRequestContext;
	const runtimeStateKey = getRuntimeStateKey(context as unknown as RuntimeStateContext);
	const nodeStaticData = context.getWorkflowStaticData('node') as IDataObject;
	const loadedState = await loadNodeState(stateContext, runtimeStateKey, nodeStaticData);

	if (isModelsCatalogFresh(loadedState.modelsCatalog)) {
		return mergeWithFallbackCatalog(loadedState.modelsCatalog);
	}

	let auth = loadedState.codexAuthJson;
	if (!auth || !hasUsableAuthData(auth)) {
		return mergeWithFallbackCatalog(loadedState.modelsCatalog);
	}

	if (shouldRefreshAuthTokens(auth)) {
		try {
			auth = await refreshChatgptTokens(authContext, auth);
		} catch {
			return mergeWithFallbackCatalog(loadedState.modelsCatalog);
		}
	}

	const accessToken = resolveAccessToken(auth);
	const accountId = resolveAccountId(auth);
	if (!accessToken || !accountId) {
		return mergeWithFallbackCatalog(loadedState.modelsCatalog);
	}

	try {
		const refreshedCatalog = await fetchModelsCatalogFromBackend(
			authContext,
			accessToken,
			accountId,
		);
		await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, {
			...loadedState,
			codexAuthJson: deepCloneAuthJson(auth),
			codexDeviceAuth: undefined,
			modelsCatalog: refreshedCatalog,
		});
		return refreshedCatalog;
	} catch {
		return mergeWithFallbackCatalog(loadedState.modelsCatalog);
	}
}

type AuthResolveMode = 'blocking' | 'single';

type ResolvedAuthState =
	| {
			status: 'pending';
			deviceState: DeviceCodeState;
			initiated: boolean;
	  }
	| {
			status: 'authenticated';
			auth: CodexAuthJson;
	  };

function shouldRefreshAuthTokens(auth: CodexAuthJson): boolean {
	const authTokens = toObject(auth.tokens) as CodexAuthJson['tokens'] | undefined;
	if (!toTrimmed(authTokens?.refresh_token)) return false;
	const accessToken = toTrimmed(authTokens?.access_token);
	return getJwtExpirationMs(accessToken)
		? isJwtExpiredOrAlmostExpired(accessToken)
		: isLastRefreshStale(toTrimmed(auth.last_refresh));
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

	if (!auth || !hasUsableAuthData(auth)) {
		auth = undefined;

		if (!deviceState || isDeviceCodeStateExpired(deviceState)) {
			deviceState = await requestDeviceCode(authContext);
			await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, {
				codexAuthJson: undefined,
				codexDeviceAuth: deviceState,
				modelsCatalog: loadedState.modelsCatalog,
			});
			return {
				status: 'pending',
				deviceState,
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
				modelsCatalog: loadedState.modelsCatalog,
			});
			return {
				status: 'pending',
				deviceState,
				initiated: false,
			};
		}

		const authorizationCode = toTrimmed(pollResult.token.authorization_code);
		const codeVerifier = toTrimmed(pollResult.token.code_verifier);
		if (!authorizationCode || !codeVerifier) {
			throw new OperationalError('Device-code login returned an invalid authorization payload');
		}

		auth = await exchangeAuthorizationCodeForTokens(authContext, authorizationCode, codeVerifier);
		await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, {
			codexAuthJson: auth,
			codexDeviceAuth: undefined,
			modelsCatalog: loadedState.modelsCatalog,
		});
	}

	if (!auth) {
		throw new OperationalError('No valid Codex auth state found. Run device-code login again.');
	}

	if (shouldRefreshAuthTokens(auth)) {
		auth = await refreshChatgptTokens(authContext, auth);
	}

	await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, {
		codexAuthJson: auth,
		codexDeviceAuth: undefined,
		modelsCatalog: loadedState.modelsCatalog,
	});

	return {
		status: 'authenticated',
		auth,
	};
}

function buildPendingLoginMessage(deviceState: DeviceCodeState, initiated: boolean): string {
	return initiated
		? `Device login initiated. Open ${deviceState.verification_url} and enter code ${deviceState.user_code}. Then run this node again to verify login.`
		: `Device login pending. Open ${deviceState.verification_url} and enter code ${deviceState.user_code}. Then run this node again.`;
}

function resolveConfiguredModelName(
	context: ISupplyDataFunctions,
	itemIndex: number,
): { modelName: string } {
	const selectedModel = context.getNodeParameter('model', itemIndex, DEFAULT_MODEL) as string;
	const customModel = context.getNodeParameter('customModel', itemIndex, '') as string;
	const modelName = resolveEffectiveModelName(selectedModel, customModel);

	return { modelName };
}

function resolveEffectiveModelName(
	selectedModel: string | undefined,
	customModel: string | undefined,
): string {
	const selected = toTrimmed(selectedModel);
	if (selected === CUSTOM_MODEL_VALUE) {
		return normalizeModelName(customModel) ?? DEFAULT_MODEL;
	}
	return normalizeModelName(selected) ?? DEFAULT_MODEL;
}

function resolveReasoningConfig(
	context: ISupplyDataFunctions,
	modelName: string,
	modelsCatalog: ModelsCatalogState,
	itemIndex: number,
): CodexResponsesReasoning | undefined {
	const selectedReasoningEffort = context.getNodeParameter(
		'reasoningEffort',
		itemIndex,
		DEFAULT_REASONING_EFFORT,
	) as CodexReasoningEffort;

	if (!isCodexReasoningEffort(selectedReasoningEffort)) {
		throw new NodeOperationError(
			context.getNode(),
			`Invalid Reasoning Effort "${String(selectedReasoningEffort)}".`,
		);
	}

	const modelInfo = getModelRecordFromCatalog(modelsCatalog, modelName);
	const supportedEfforts = getModelReasoningEfforts(modelName, modelsCatalog);
	const resolvedEffort =
		selectedReasoningEffort === 'default'
			? modelInfo?.defaultReasoningEffort === 'none'
				? undefined
				: modelInfo?.defaultReasoningEffort
			: selectedReasoningEffort === 'none'
				? undefined
				: selectedReasoningEffort;

	if (resolvedEffort && !supportedEfforts) {
		throw new NodeOperationError(
			context.getNode(),
			`Model "${modelName}" does not have a verified reasoning-effort profile. Select a listed model or use Model Default/None.`,
		);
	}

	if (resolvedEffort && supportedEfforts && !supportedEfforts.includes(resolvedEffort)) {
		throw new NodeOperationError(
			context.getNode(),
			`Reasoning Effort "${reasoningEffortLabel(resolvedEffort)}" is not supported by model "${modelName}". Supported: ${formatReasoningEffortList(supportedEfforts)}.`,
		);
	}

	const selectedSummary = context.getNodeParameter(
		'reasoningSummary',
		itemIndex,
		'default',
	) as string;
	const resolvedSummary =
		selectedSummary === 'default'
			? modelInfo?.defaultReasoningSummary
			: normalizeReasoningSummary(selectedSummary);
	if (resolvedSummary !== 'none' && modelInfo && !modelInfo.supportsReasoningSummary) {
		throw new NodeOperationError(
			context.getNode(),
			`Model "${modelName}" does not support reasoning summaries.`,
		);
	}

	if (!resolvedEffort && (!resolvedSummary || resolvedSummary === 'none')) return undefined;
	return {
		...(resolvedEffort ? { effort: resolvedEffort } : {}),
		...(resolvedSummary && resolvedSummary !== 'none' ? { summary: resolvedSummary } : {}),
	};
}

function resolveVerbosity(
	context: ISupplyDataFunctions,
	modelName: string,
	modelsCatalog: ModelsCatalogState,
	itemIndex: number,
): CodexVerbosity | undefined {
	const selected = context.getNodeParameter('verbosity', itemIndex, 'default') as string;
	const modelInfo = getModelRecordFromCatalog(modelsCatalog, modelName);
	if (selected === 'default')
		return modelInfo?.supportsVerbosity ? modelInfo.defaultVerbosity : undefined;
	const verbosity = normalizeVerbosity(selected);
	if (!verbosity) return undefined;
	if (modelInfo && !modelInfo.supportsVerbosity) {
		throw new NodeOperationError(
			context.getNode(),
			`Model "${modelName}" does not support verbosity.`,
		);
	}
	return verbosity;
}

function resolveServiceTier(
	context: ISupplyDataFunctions,
	modelName: string,
	modelsCatalog: ModelsCatalogState,
	itemIndex: number,
): string | undefined {
	const selected = toTrimmed(context.getNodeParameter('serviceTier', itemIndex, 'default'));
	const modelInfo = getModelRecordFromCatalog(modelsCatalog, modelName);
	if (!selected || selected === 'default') return modelInfo?.defaultServiceTier;
	if (modelInfo && !modelInfo.serviceTiers.some((tier) => tier.id === selected)) {
		throw new NodeOperationError(
			context.getNode(),
			`Service Tier "${selected}" is not supported by model "${modelName}".`,
		);
	}
	return selected;
}

// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class OpenAiCodexChatModel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'OpenAI codex',
		name: 'openAiCodexChatModel',
		icon: {
			light: 'file:../../icons/openAiCodex.svg',
			dark: 'file:../../icons/openAiCodex.dark.svg',
		},
		group: ['transform'],
		version: [1],
		subtitle: '={{ $parameter.model }}',
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
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				default: DEFAULT_MODEL,
				options: MODEL_OPTIONS,
				typeOptions: {
					loadOptionsMethod: 'getCodexModelOptions',
				},
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Custom Model',
				name: 'customModel',
				type: 'string',
				default: '',
				placeholder: 'e.g. gpt-5.4',
				displayOptions: {
					show: {
						model: [CUSTOM_MODEL_VALUE],
					},
				},
				description: 'Custom model slug',
			},
			{
				displayName: 'Reasoning Effort Name or ID',
				name: 'reasoningEffort',
				type: 'options',
				default: DEFAULT_REASONING_EFFORT,
				options: reasoningEffortOptions(ALL_REASONING_EFFORTS),
				typeOptions: {
					loadOptionsMethod: 'getCodexReasoningEffortOptions',
					loadOptionsDependsOn: ['model', 'customModel'],
				},
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Reasoning Summary',
				name: 'reasoningSummary',
				type: 'options',
				default: 'default',
				options: [
					{ name: 'Auto', value: 'auto' },
					{ name: 'Concise', value: 'concise' },
					{ name: 'Detailed', value: 'detailed' },
					{ name: 'Model Default', value: 'default' },
					{ name: 'None', value: 'none' },
				],
				description: 'Controls the reasoning summary returned by models that support it',
			},
			{
				displayName: 'Verbosity',
				name: 'verbosity',
				type: 'options',
				default: 'default',
				options: [
					{ name: 'High', value: 'high' },
					{ name: 'Low', value: 'low' },
					{ name: 'Medium', value: 'medium' },
					{ name: 'Model Default', value: 'default' },
				],
				description: 'Controls response verbosity for models that support it',
			},
			{
				displayName: 'Service Tier Name or ID',
				name: 'serviceTier',
				type: 'options',
				default: 'default',
				options: [{ name: 'Model Default', value: 'default' }],
				typeOptions: {
					loadOptionsMethod: 'getCodexServiceTierOptions',
					loadOptionsDependsOn: ['model', 'customModel'],
				},
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
		],
	};

	methods = {
		loadOptions: {
			async getCodexModelOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const catalog = await resolveModelsCatalogForLoadOptions(this);
				return getModelOptionsFromCatalog(catalog);
			},
			async getCodexReasoningEffortOptions(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				const catalog = await resolveModelsCatalogForLoadOptions(this);
				const selectedModel = this.getCurrentNodeParameter('model') as string | undefined;
				const customModel = this.getCurrentNodeParameter('customModel') as string | undefined;
				const modelName = resolveEffectiveModelName(selectedModel, customModel);
				const supportedEfforts = getModelReasoningEfforts(modelName, catalog) ?? [];
				const modelInfo = getModelRecordFromCatalog(catalog, modelName);
				const descriptions = new Map(
					(modelInfo?.supportedReasoningEfforts ?? []).map((profile) => [
						profile.effort,
						profile.description,
					]),
				);
				return reasoningEffortOptions(supportedEfforts).map((option) => {
					const description = descriptions.get(String(option.value));
					return description ? { ...option, description } : option;
				});
			},
			async getCodexServiceTierOptions(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				const catalog = await resolveModelsCatalogForLoadOptions(this);
				const selectedModel = this.getCurrentNodeParameter('model') as string | undefined;
				const customModel = this.getCurrentNodeParameter('customModel') as string | undefined;
				const modelName = resolveEffectiveModelName(selectedModel, customModel);
				const modelInfo = getModelRecordFromCatalog(catalog, modelName);
				return [
					{ name: 'Model Default', value: 'default' },
					...(modelInfo?.serviceTiers ?? []).map((tier) => ({
						name: tier.name,
						value: tier.id,
						...(tier.description ? { description: tier.description } : {}),
					})),
				];
			},
		},
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
				return [
					this.helpers.returnJsonArray(buildPendingVerificationPayload(resolved.deviceState)),
				];
			}

			return [
				this.helpers.returnJsonArray({
					status: 'authenticated',
					chatgpt_account_id: resolveAccountId(resolved.auth) ?? null,
					last_refresh: toTrimmed(resolved.auth.last_refresh) ?? null,
				}),
			];
		} catch (error) {
			if (this.continueOnFail()) {
				return [
					this.helpers.returnJsonArray({
						status: 'error',
						error: error instanceof Error ? error.message : String(error),
					}),
				];
			}
			throw new NodeOperationError(this.getNode(), error as Error);
		}
	}

	async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
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

			const modelsCatalog = await resolveModelsCatalogForExecution(
				stateContext,
				authContext,
				runtimeStateKey,
				nodeStaticData,
				resolved.auth,
			);
			const { modelName } = resolveConfiguredModelName(this, itemIndex);
			const modelInfo = getModelRecordFromCatalog(modelsCatalog, modelName);
			const reasoningConfig = resolveReasoningConfig(this, modelName, modelsCatalog, itemIndex);
			const verbosity = resolveVerbosity(this, modelName, modelsCatalog, itemIndex);
			const serviceTier = resolveServiceTier(this, modelName, modelsCatalog, itemIndex);
			const boundToolsDebugState: BoundToolsDebugState = {
				toolNames: [],
			};
			const baseHeaders = {
				Authorization: `Bearer ${token}`,
				Accept: 'text/event-stream',
				...resolveDefaultHeaders(chatgptAccountId),
			};

			const codexModel = new CodexResponsesChatModel(modelName, {
				baseHeaders,
				defaultInstructions: modelInfo?.baseInstructions ?? DEFAULT_INSTRUCTIONS,
				reasoning: reasoningConfig,
				verbosity,
				serviceTier,
				parallelToolCalls: supportsParallelToolCalls(modelName, modelsCatalog),
				useResponsesLite: modelInfo?.useResponsesLite ?? false,
				refreshAuthHeaders: async () => {
					const currentState = await loadNodeState(stateContext, runtimeStateKey, nodeStaticData);
					if (!currentState.codexAuthJson) {
						throw new OperationalError('Codex auth state is unavailable for token refresh');
					}
					const refreshedAuth = await refreshChatgptTokens(authContext, currentState.codexAuthJson);
					await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, {
						...currentState,
						codexAuthJson: refreshedAuth,
						codexDeviceAuth: undefined,
					});
					const refreshedToken = resolveAccessToken(refreshedAuth);
					const refreshedAccountId = resolveAccountId(refreshedAuth);
					if (!refreshedToken || !refreshedAccountId) {
						throw new OperationalError('Token refresh did not produce usable Codex auth state');
					}
					return {
						Authorization: `Bearer ${refreshedToken}`,
						...resolveDefaultHeaders(refreshedAccountId),
					};
				},
				chatgptAccountId,
				debugState: boundToolsDebugState,
				openStreamRequest: async (request, headers, config) => {
					const response = (await this.helpers.httpRequest({
						method: 'POST',
						url: `${DEFAULT_CHATGPT_CODEX_BASE_URL}/responses`,
						headers,
						body: request,
						json: true,
						encoding: 'stream',
						ignoreHttpStatusErrors: true,
						returnFullResponse: true,
						...(typeof config?.timeout === 'number' ? { timeout: config.timeout } : {}),
						...(config?.abortSignal ? { abortSignal: config.abortSignal } : {}),
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

import {
	BaseChatModel,
	parseSSEStream,
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
import { setTimeout as delay } from 'node:timers/promises';
import {
	getCodexToolParameters,
	getCodexStrictSchema,
	assertCodexSchemaValue,
} from './tool-schema';
import { supplyCodexModel } from './n8n-adapter';
import packageJson from '../../package.json';
import fallbackModels from './fallback-models.json';
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
	{ name: 'Custom', value: CUSTOM_MODEL_VALUE },
	...fallbackModels.models
		.filter((model) => model.visibility === 'list')
		.map((model) => ({
			name: model.display_name,
			value: model.slug,
		})),
];

const FALLBACK_MODEL_NAME_BY_SLUG = new Map(
	fallbackModels.models.map((model) => [model.slug, model.display_name]),
);

const MODEL_REASONING_EFFORTS: Readonly<Record<string, ReadonlyArray<ModelReasoningEffort>>> = {
	...Object.fromEntries(
		fallbackModels.models.map((model) => [
			model.slug,
			model.supported_reasoning_levels.map((profile) => profile.effort),
		]),
	),
	// Preserve validation for saved workflows using models removed from the CLI picker.
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
		none: 'No Effort Override',
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
const DEFAULT_MODEL = 'gpt-6.1-sol';
const LEGACY_DEFAULT_MODEL = 'gpt-5.6-sol';
const TOKEN_REFRESH_INTERVAL_DAYS = 8;
const DEVICE_CODE_EXPIRY_MS = 15 * 60 * 1000;
const CODEX_NODE_VERSION = toTrimmed(packageJson.version) ?? '0.0.0';
const MODELS_CLIENT_VERSION = toTrimmed(process.env.N8N_OPENAI_CODEX_CLIENT_VERSION) ?? '0.162.1';
const CODEX_USER_AGENT = `${DEFAULT_ORIGINATOR}/${MODELS_CLIENT_VERSION} (n8n-openai-codex/${CODEX_NODE_VERSION})`;
const PERSISTED_STATE_PREFIX = '.openai-codex-state';
const DIRECT_PERSIST_DIR_ENV = 'N8N_OPENAI_CODEX_STATE_DIR';
const ALLOW_PARALLEL_TOOL_CALLS =
	toTrimmed(process.env.N8N_OPENAI_CODEX_ALLOW_PARALLEL_TOOLS) !== 'false';
const MODEL_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_INSTRUCTIONS = 'You are Codex.';
const DEFAULT_OUTPUT_SCHEMA =
	'{"type":"object","properties":{"result":{"type":"string"}},"required":["result"],"additionalProperties":false}';
const REQUEST_NORMALIZER_VERSION = '2026-10-15.1';

type CodexResponsesMessageContentItem =
	| {
			type: 'input_text' | 'output_text';
			text: string;
	  }
	| {
			type: 'input_image';
			image_url: string;
			detail?: 'auto';
	  }
	| { type: 'input_audio'; audio_url: string };

type CodexResponsesInputItem =
	| {
			type: 'message';
			role: 'user' | 'assistant' | 'developer';
			content: CodexResponsesMessageContentItem[];
			phase?: string;
	  }
	| {
			type: 'function_call';
			call_id: string;
			name: string;
			namespace?: string;
			arguments: string;
	  }
	| {
			type: 'function_call_output';
			call_id: string;
			output: string | CodexResponsesMessageContentItem[];
	  }
	| {
			type: 'additional_tools';
			role: 'developer';
			tools: CodexResponsesToolNamespace[];
	  }
	| { type: 'reasoning'; summary: unknown[]; encrypted_content: string };

type CodexResponsesToolNamespace = {
	type: 'namespace';
	name: 'functions';
	description: string;
	tools: CodexResponsesTool[];
};

type CodexResponsesTool = {
	type: 'function';
	name: string;
	description: string;
	strict: boolean;
	parameters: Record<string, unknown>;
};

type CodexResponsesReasoning = {
	effort?: ModelReasoningEffort;
	summary?: Exclude<CodexReasoningSummary, 'none'>;
	context?: 'all_turns';
};

type CodexResponsesRequest = {
	model: string;
	input: CodexResponsesInputItem[];
	tools?: CodexResponsesTool[];
	tool_choice: 'auto' | 'none' | 'required';
	parallel_tool_calls: boolean;
	stream: true;
	store: false;
	include: string[];
	prompt_cache_key: string;
	reasoning?: CodexResponsesReasoning;
	service_tier?: string;
	text?: { verbosity?: CodexVerbosity; format?: Record<string, unknown> };
	client_metadata: Record<string, string>;
};

type CodexResponsesOutputItem = {
	type?: string;
	role?: string;
	content?: Array<{ type?: string; text?: string; refusal?: string }>;
	call_id?: string;
	name?: string;
	arguments?: string;
	namespace?: string;
	phase?: string;
	summary?: unknown[];
	encrypted_content?: string;
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
	error?: { message?: string; code?: string };
	message?: string;
	code?: string;
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
	refreshAuthHeaders: (rejectedAuthorization: string) => Promise<Record<string, string>>;
	chatgptAccountId: string;
	openStreamRequest: CodexOpenStreamRequest;
	debugState: BoundToolsDebugState;
	outputFormat?: Record<string, unknown>;
	useAgentOutputParser?: boolean;
	autoDetectOutputParser?: boolean;
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
			// Stream helpers have no node context for constructing NodeOperationError.
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
			throw new OperationalError('Codex returned a malformed stream event');
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

function parseToolCallArguments(raw: string, toolName: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = undefined;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new OperationalError(
			`Tool "${toolName}" returned malformed arguments; expected a JSON object`,
		);
	}
	return parsed as Record<string, unknown>;
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
				if (blockObj.type === 'output_text' || blockObj.type === 'refusal') {
					const text = toStringValue(blockObj.text ?? blockObj.refusal);
					if (text) textParts.push(text);
				}
			}
			continue;
		}

		if (type === 'function_call') {
			const id = toTrimmed(itemObj.call_id);
			const name = toTrimmed(itemObj.name);
			const argumentsRaw = toStringValue(itemObj.arguments) ?? '';
			if (!id || !name)
				throw new OperationalError('Codex returned a tool call without its ID or name');
			toolCalls.push({ id, name, argumentsRaw });
		}
	}

	return {
		text: textParts.join(''),
		toolCalls,
	};
}

function toCodexOutputText(part: MessageContent): string | undefined {
	if (part.type === 'text' || part.type === 'reasoning') {
		return toStringValue(part.text);
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
	if (!mediaType?.startsWith('image/') && !mediaType?.startsWith('audio/')) {
		throw new OperationalError(
			`Unsupported media input "${mediaType ?? 'unknown'}"; extract document text before sending it to Codex`,
		);
	}

	const remoteUrl = toTrimmed(part.providerMetadata?.url);
	const rawData =
		typeof part.data === 'string'
			? part.data
			: part.data
				? Buffer.from(part.data).toString('base64')
				: undefined;
	const mediaUrl =
		remoteUrl ??
		(rawData && /^(data:|https?:\/\/)/.test(rawData)
			? rawData
			: rawData
				? `data:${mediaType};base64,${rawData}`
				: undefined);
	if (!mediaUrl) throw new OperationalError('Codex media input is missing data or a URL');
	if (mediaType.startsWith('audio/')) return { type: 'input_audio', audio_url: mediaUrl };

	return {
		type: 'input_image',
		image_url: mediaUrl,
		detail: 'auto',
	};
}

function stringifyToolCallInput(input: string): string {
	parseToolCallArguments(input, 'conversation history');
	return input;
}

function codexToolOutput(result: unknown): string | CodexResponsesMessageContentItem[] {
	if (
		!Array.isArray(result) ||
		!result.every((part) =>
			['text', 'reasoning', 'file', 'provider'].includes(String(toObject(part)?.type)),
		)
	) {
		return typeof result === 'string' ? result : JSON.stringify(result ?? null);
	}
	return (result as MessageContent[]).map((part) => {
		const media = toCodexInputMedia(part);
		return media ?? { type: 'input_text', text: toCodexOutputText(part) ?? '' };
	});
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
			const hasReplayMessages = message.content.some(
				(part) =>
					part.type === 'provider' && toObject(part.value.codexMessageItem)?.type === 'message',
			);
			for (const part of message.content) {
				if (part.type === 'provider') {
					const replayMessage = toObject(part.value.codexMessageItem);
					if (
						replayMessage?.type === 'message' &&
						replayMessage.role === 'assistant' &&
						Array.isArray(replayMessage.content)
					) {
						input.push({
							type: 'message',
							role: 'assistant',
							content: replayMessage.content as CodexResponsesMessageContentItem[],
							...(typeof replayMessage.phase === 'string' ? { phase: replayMessage.phase } : {}),
						});
					}
					const item = toObject(part.value.codexReasoningItem);
					if (item?.type === 'reasoning' && typeof item.encrypted_content === 'string') {
						input.push({
							type: 'reasoning',
							summary: Array.isArray(item.summary) ? item.summary : [],
							encrypted_content: item.encrypted_content,
						});
					}
					continue;
				}
				if (part.type === 'reasoning' || (part.type === 'text' && hasReplayMessages)) continue;
				if (part.type === 'tool-call') {
					const name = toTrimmed(part.toolName);
					if (!name || !toTrimmed(part.toolCallId))
						throw new OperationalError('Tool-call history is missing its name or ID');
					input.push({
						type: 'function_call',
						call_id: toTrimmed(part.toolCallId)!,
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
				if (!callId) throw new OperationalError('Tool-result history is missing its call ID');
				const output = codexToolOutput(part.result);
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
		throw new OperationalError(
			`Provider tool "${tool.name}" is not supported by the Codex chat backend`,
		);
	}

	const rawName = toTrimmed(tool.name);
	if (!rawName) throw new OperationalError('Tool name cannot be empty');

	const name = rawName;
	const description = toTrimmed(tool.description) ?? 'No description';
	const parameters = tool.strict
		? getCodexStrictSchema(tool.inputSchema, name)
		: getCodexToolParameters(tool.inputSchema, name);

	return {
		type: 'function',
		name,
		description,
		strict: tool.strict ?? false,
		parameters,
	};
}

function sameJsonSchema(left: unknown, right: unknown): boolean {
	const canonical = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(canonical)
			: value && typeof value === 'object'
				? Object.fromEntries(
						Object.entries(value)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([key, child]) => [key, canonical(child)]),
					)
				: value;
	return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function codexReplayContent(items: CodexResponsesOutputItem[]): MessageContent[] {
	const content: MessageContent[] = [];
	for (const item of items) {
		if (item.type === 'reasoning' && item.encrypted_content) {
			content.push({
				type: 'provider',
				value: {
					codexReasoningItem: {
						type: 'reasoning',
						summary: item.summary ?? [],
						encrypted_content: item.encrypted_content,
					},
				},
			});
		} else if (item.type === 'message' && item.role === 'assistant' && item.content) {
			content.push({
				type: 'provider',
				value: {
					codexMessageItem: {
						type: 'message',
						role: 'assistant',
						content: item.content.map((part) =>
							part.type === 'refusal' ? { type: 'output_text', text: part.refusal ?? '' } : part,
						),
						...(item.phase ? { phase: item.phase } : {}),
					},
				},
			});
		}
	}
	return content;
}

function terminalCodexResponse(event: CodexStreamEvent): CodexResponsesResponse | undefined {
	if (!event.response) return undefined;
	return {
		...event.response,
		status:
			event.type === 'response.failed'
				? 'failed'
				: event.type === 'response.incomplete'
					? 'incomplete'
					: (event.response.status ?? 'completed'),
	};
}

function assertCodexStreamEvent(event: CodexStreamEvent): void {
	if (event.type !== 'error') return;
	const detail =
		toTrimmed(event.error?.message) ??
		toTrimmed(event.message) ??
		toTrimmed(event.error?.code) ??
		toTrimmed(event.code);
	throw new OperationalError(detail ? `Codex stream failed: ${detail}` : 'Codex stream failed');
}

async function readCodexErrorBody(body: unknown): Promise<unknown> {
	if (!isAsyncBufferIterable(body)) return body;
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of body) {
		const buffer = Buffer.from(chunk);
		chunks.push(buffer.subarray(0, Math.max(0, 65536 - size)));
		size += buffer.length;
		if (size >= 65536) break;
	}
	const text = Buffer.concat(chunks).toString('utf8');
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function assertSuccessfulCodexResponse(response: CodexResponsesResponse | undefined): void {
	if (!response) {
		throw new OperationalError('Codex response stream ended before a terminal event');
	}

	const status = toTrimmed(response.status);
	if (status && !['completed', 'failed', 'incomplete'].includes(status)) {
		throw new OperationalError(`Codex response did not complete: ${status}`);
	}
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
	private invocationOptions: Record<string, unknown> = {};

	constructor(
		modelId: string,
		private config: CodexResponsesChatModelConfig,
	) {
		super('openai-codex', modelId);
	}

	get hasNativeJsonOutput(): boolean {
		return Boolean(
			this.config.outputFormat ||
				this.config.useAgentOutputParser ||
				(this.config.autoDetectOutputParser &&
					this.tools.some((tool) => tool.name === 'format_final_json_response')) ||
				this.invocationOptions.response_format,
		);
	}

	withTools(tools: Tool[]): CodexResponsesChatModel {
		const names = new Set<string>();
		for (const tool of tools) {
			if (names.has(tool.name)) throw new OperationalError(`Duplicate tool name "${tool.name}"`);
			names.add(tool.name);
		}
		const model = super.withTools([]) as CodexResponsesChatModel;
		model.tools = [...tools];
		model.config = { ...this.config, debugState: { toolNames: [] } };
		return model;
	}

	withInvocationConfig(options: Record<string, unknown>): CodexResponsesChatModel {
		const model = this.withTools(this.tools);
		model.invocationOptions = { ...this.invocationOptions, ...options };
		return model;
	}

	private resolveInvocationConfig(
		config?: ChatModelConfig,
	): ChatModelConfig & Record<string, unknown> {
		const merged: ChatModelConfig & Record<string, unknown> = {
			...this.defaultConfig,
			...this.invocationOptions,
			...config,
		};
		if (merged.abortSignal?.aborted)
			throw merged.abortSignal.reason ?? new OperationalError('Codex request was cancelled');
		for (const key of [
			'temperature',
			'topP',
			'topK',
			'presencePenalty',
			'frequencyPenalty',
			'seed',
			'maxTokens',
			'stopSequences',
			'stop',
		]) {
			if (merged[key] !== undefined)
				throw new OperationalError(`Codex does not support the generation option "${key}"`);
		}
		return merged;
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

	private buildRequest(
		messages: Message[],
		turnId: string,
		options: Record<string, unknown>,
	): CodexResponsesRequest {
		const tools: CodexResponsesTool[] = [];
		for (const tool of this.tools) {
			const normalizedTool = codexToolFromGenericTool(tool);
			if (!normalizedTool) continue;
			tools.push(normalizedTool);
		}
		if (options.response_format !== undefined && !toObject(options.response_format))
			throw new OperationalError('response_format must be an object');
		let format = toObject(options.response_format) ?? this.config.outputFormat;
		// Resolve the parser before forced tool selection narrows this turn's tool list.
		const formatter = tools.find((tool) => tool.name === 'format_final_json_response');
		if (
			!format &&
			(this.config.useAgentOutputParser || (this.config.autoDetectOutputParser && formatter))
		) {
			if (!formatter)
				throw new OperationalError(
					'Agent Output Parser (Strict) requires an AI Agent with Require Specific Output Format enabled and a connected Structured Output Parser; use JSON Schema (Strict) for chains',
				);
			formatter.parameters = getCodexStrictSchema(formatter.parameters, formatter.name);
			formatter.strict = true;
			format = {
				type: 'json_schema',
				name: 'n8n_agent_output',
				strict: true,
				schema: formatter.parameters,
			};
		}

		const choice = options.tool_choice ?? 'auto';
		const forcedName =
			typeof choice === 'string' && !['auto', 'none', 'required', 'any'].includes(choice)
				? choice
				: (toTrimmed(toObject(choice)?.name) ??
					toTrimmed(toObject(toObject(choice)?.function)?.name));
		if (forcedName) {
			const selected = tools.find((tool) => tool.name === forcedName);
			if (!selected)
				throw new OperationalError(`Requested tool "${forcedName}" is not bound to this model`);
			tools.splice(0, tools.length, selected);
		} else if (!['auto', 'none', 'required', 'any'].includes(String(choice))) {
			throw new OperationalError('Unsupported tool_choice value');
		}
		const toolChoice =
			forcedName || choice === 'any'
				? 'required'
				: (choice as CodexResponsesRequest['tool_choice']);
		if (toolChoice === 'required' && tools.length === 0)
			throw new OperationalError('Forced tool choice requires at least one bound tool');
		if (format && !['json_schema', 'json_object'].includes(String(format.type)))
			throw new OperationalError('Unsupported response_format');
		if (format?.type === 'json_schema') {
			const definition = toObject(format.json_schema) ?? format;
			if (definition.strict !== undefined && typeof definition.strict !== 'boolean')
				throw new OperationalError('response_format strict must be a boolean');
			const name = toTrimmed(definition.name) ?? 'extract';
			if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
				throw new OperationalError(
					'Output schema name must contain 1–64 letters, digits, underscores, or hyphens',
				);
			format = {
				type: 'json_schema',
				name,
				strict: definition.strict ?? false,
				schema:
					definition.strict === true
						? getCodexStrictSchema(definition.schema, name)
						: getCodexToolParameters(definition.schema, name),
			};
			if (formatter && format.strict === true) {
				const parserSchema = getCodexStrictSchema(formatter.parameters, formatter.name);
				// Formatting-tool output and final text must obey the same contract.
				if (!sameJsonSchema(parserSchema, format.schema))
					throw new OperationalError(
						'Output Schema conflicts with the AI Agent output parser; select Automatic or Agent Output Parser (Strict) to use the connected parser schema',
					);
				formatter.parameters = parserSchema;
				formatter.strict = true;
			}
		}
		const normalizedInput = toCodexInput(messages);
		const instructions = normalizedInput.instructions ?? this.config.defaultInstructions;
		const input = [...normalizedInput.input];
		const prefix: CodexResponsesInputItem[] = [];
		if (this.config.useResponsesLite) {
			for (const item of input) {
				if (item.type === 'function_call') item.namespace = 'functions';
				const content =
					item.type === 'message'
						? item.content
						: item.type === 'function_call_output' && Array.isArray(item.output)
							? item.output
							: [];
				for (const contentItem of content) {
					if (contentItem.type === 'input_image') delete contentItem.detail;
				}
			}
			if (tools.length > 0)
				prefix.push({
					type: 'additional_tools',
					role: 'developer',
					tools: [{ type: 'namespace', name: 'functions', description: '', tools }],
				});
		}
		if (instructions)
			prefix.push({
				type: 'message',
				role: 'developer',
				content: [{ type: 'input_text', text: instructions }],
			});
		input.unshift(...prefix);
		const reasoning: CodexResponsesReasoning = {
			...this.config.reasoning,
			...(this.config.useResponsesLite ? { context: 'all_turns' as const } : {}),
		};

		const request: CodexResponsesRequest = {
			model: this.modelId,
			stream: true,
			...(this.config.serviceTier ? { service_tier: this.config.serviceTier } : {}),
			input,
			...(this.config.useResponsesLite ? {} : { tools }),
			tool_choice: toolChoice,
			parallel_tool_calls:
				this.config.parallelToolCalls &&
				options.parallel_tool_calls !== false &&
				!this.config.useResponsesLite &&
				!tools.some((tool) => tool.strict),
			store: false,
			include: ['reasoning.encrypted_content'],
			prompt_cache_key: this.sessionId,
			...(reasoning ? { reasoning } : {}),
			...(this.config.verbosity || format
				? {
						text: {
							...(this.config.verbosity ? { verbosity: this.config.verbosity } : {}),
							...(format ? { format } : {}),
						},
					}
				: {}),
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
			process.env.N8N_OPENAI_CODEX_DEBUG_PAYLOADS === 'true' && tools.length > 0
				? truncateErrorValue(JSON.stringify(tools))
				: undefined;
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
		const retries = config?.maxRetries ?? 2;
		if (!Number.isInteger(retries) || retries < 0 || retries > 5)
			throw new OperationalError('maxRetries must be an integer between 0 and 5');
		let response: IN8nHttpFullResponse;
		let refreshed = false;
		let attempts = 0;
		while (true) {
			if (config?.abortSignal?.aborted)
				throw config.abortSignal.reason ?? new OperationalError('Codex request was cancelled');
			const headers = this.buildRequestHeaders(config);
			response = await this.config.openStreamRequest(request, headers, config);
			if (response.statusCode === 401 && !refreshed) {
				await readCodexErrorBody(response.body);
				Object.assign(
					this.config.baseHeaders,
					await this.config.refreshAuthHeaders(headers.Authorization),
				);
				refreshed = true;
				continue;
			}
			if (![408, 429, 500, 502, 503, 504].includes(response.statusCode) || attempts >= retries)
				break;
			await readCodexErrorBody(response.body);
			const retryAfter = toStringValue(toObject(response.headers)?.['retry-after']);
			const seconds = retryAfter ? Number(retryAfter) : NaN;
			const waitMs = Number.isFinite(seconds)
				? seconds * 1000
				: retryAfter
					? Date.parse(retryAfter) - Date.now()
					: 250 * 2 ** attempts;
			attempts++;
			await delay(
				Math.min(30_000, Math.max(0, Number.isFinite(waitMs) ? waitMs : 250)),
				undefined,
				{ signal: config?.abortSignal },
			);
		}

		if (response.statusCode < 200 || response.statusCode > 299) {
			const responseBody = await readCodexErrorBody(response.body);
			const errorPayload = {
				status: response.statusCode,
				message:
					extractBackendErrorMessage(responseBody) ??
					`${response.statusCode} status code (no body)`,
				response: {
					status: response.statusCode,
					data: responseBody,
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

		assertNoModelSubstitution(this.modelId, {
			model: getReportedModelFromHeaders(response.headers),
		});
		return response.body;
	}

	async generate(messages: Message[], config?: ChatModelConfig): Promise<GenerateResult> {
		const iterator = this.streamResponse(messages, config);
		const content: MessageContent[] = [];
		let text = '';
		let finalResponse: CodexResponsesResponse | undefined;
		let finish: Extract<StreamChunk, { type: 'finish' }> | undefined;
		while (true) {
			const step = await iterator.next();
			if (step.done) {
				finalResponse = step.value;
				break;
			}
			const chunk = step.value;
			if (chunk.type === 'text-delta') text += chunk.delta;
			else if (chunk.type === 'content') content.push(chunk.content);
			else if (chunk.type === 'tool-call-delta')
				content.push({
					type: 'tool-call',
					toolCallId: chunk.id,
					toolName: chunk.name!,
					input: chunk.argumentsDelta!,
				});
			else if (chunk.type === 'finish') finish = chunk;
		}
		if (text) content.push({ type: 'text', text });
		return {
			id: finalResponse?.id,
			finishReason: finish?.finishReason,
			usage: finish?.usage,
			message: { role: 'assistant', content, id: finalResponse?.id },
			rawResponse: finalResponse,
			providerMetadata: {
				model_provider: this.provider,
				model: finalResponse?.model ?? this.modelId,
				status: finalResponse?.status,
				id: finalResponse?.id,
			},
		};
	}

	async *stream(messages: Message[], config?: ChatModelConfig): AsyncIterable<StreamChunk> {
		yield* this.streamResponse(messages, config);
	}

	private async *streamResponse(
		messages: Message[],
		config?: ChatModelConfig,
	): AsyncGenerator<StreamChunk, CodexResponsesResponse> {
		const options = this.resolveInvocationConfig(config);
		const request = this.buildRequest(messages, randomUUID(), options);
		const format = request.text?.format;
		const strictOutput = format?.type === 'json_schema' && format.strict === true;
		const stream = await this.openResponsesStream(request, options);
		const doneItems = new Map<number, CodexResponsesOutputItem>();
		const textByIndex = new Map<number, string>();
		const toolBuffers = new Map<number, CodexResponsesOutputItem>();
		let reportedModel: string | undefined;
		for await (const event of parseCodexStreamEvents(stream)) {
			if (options.abortSignal?.aborted)
				throw options.abortSignal.reason ?? new OperationalError('Codex request was cancelled');
			assertCodexStreamEvent(event);
			reportedModel =
				toTrimmed(event.response?.model) ?? getReportedModelFromEvent(event) ?? reportedModel;
			assertNoModelSubstitution(this.modelId, { model: reportedModel });
			const index = event.output_index ?? 0;
			if (event.type === 'response.output_text.delta') {
				const delta = toStringValue(event.delta) ?? '';
				textByIndex.set(index, (textByIndex.get(index) ?? '') + delta);
				if (delta && !strictOutput) yield { type: 'text-delta', delta };
			} else if (
				['response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(
					String(event.type),
				)
			) {
				if (event.delta)
					yield {
						type: 'content',
						content: { type: 'reasoning', text: event.delta },
					};
			} else if (
				event.type === 'response.output_item.added' &&
				event.item?.type === 'function_call'
			) {
				toolBuffers.set(index, event.item);
			} else if (event.type === 'response.function_call_arguments.delta') {
				const buffered = toolBuffers.get(index);
				if (!buffered)
					throw new OperationalError('Codex returned tool argument deltas without a tool call');
				buffered.arguments = (buffered.arguments ?? '') + (event.delta ?? '');
			} else if (event.type === 'response.output_item.done') {
				if (!event.item)
					throw new OperationalError('Codex returned an empty completed output item');
				doneItems.set(index, { ...toolBuffers.get(index), ...event.item });
			} else if (
				['response.done', 'response.completed', 'response.failed', 'response.incomplete'].includes(
					String(event.type),
				)
			) {
				const response = terminalCodexResponse(event);
				assertSuccessfulCodexResponse(response);
				if (!response) throw new OperationalError('Codex terminal event is missing its response');
				const indexedOutput: Array<[number, CodexResponsesOutputItem]> = response.output?.length
					? response.output.map((item, index) => [index, item])
					: [...doneItems.entries()].sort(([a], [b]) => a - b);
				const output = indexedOutput.map(([, item]) => item);
				response.output = output;
				response.model ??= reportedModel;
				const calls = parseCodexOutputItems(output).toolCalls;
				const advertisedTools =
					request.tools ??
					request.input.flatMap((item) =>
						item.type === 'additional_tools'
							? item.tools.flatMap((namespace) => namespace.tools)
							: [],
					);
				const allowed = new Map(advertisedTools.map((tool) => [tool.name, tool]));
				const ids = new Set<string>();
				for (const call of calls) {
					if (!allowed.has(call.name))
						throw new OperationalError(`Codex requested unbound tool "${call.name}"`);
					if (ids.has(call.id))
						throw new OperationalError(`Codex returned duplicate tool call ID "${call.id}"`);
					ids.add(call.id);
					const args = parseToolCallArguments(call.argumentsRaw, call.name);
					const boundTool = allowed.get(call.name)!;
					if (boundTool.strict) assertCodexSchemaValue(args, boundTool.parameters, call.name);
				}
				if (
					allowed.get('format_final_json_response')?.strict &&
					calls.length > 1 &&
					calls.some((call) => call.name === 'format_final_json_response')
				)
					throw new OperationalError(
						'Codex combined final output formatting with another tool call',
					);
				if (request.tool_choice === 'required' && !calls.length)
					throw new OperationalError('Codex did not honor forced tool choice');
				if (request.tool_choice === 'none' && calls.length)
					throw new OperationalError('Codex returned a tool call while tool choice was disabled');
				if (strictOutput) {
					if (output.some((item) => item.content?.some((part) => part.type === 'refusal')))
						throw new OperationalError('Codex refused to produce the requested structured output');
					if (!calls.length && !options.codex_output_parser_validates) {
						const finalItems = output.filter(
							(item) => item.type === 'message' && item.phase !== 'commentary',
						);
						let value: unknown;
						try {
							value = JSON.parse(parseCodexOutputItems(finalItems).text);
						} catch {
							// Model transport has no n8n node context.
							// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
							throw new OperationalError(
								'Codex returned invalid JSON for the requested strict output schema',
							);
						}
						assertCodexSchemaValue(
							value,
							format.schema as Record<string, unknown>,
							String(format.name),
						);
					}
				}
				// Only release tool calls after the terminal response has passed all validation.
				for (const [outputIndex, item] of indexedOutput) {
					if (
						item.type === 'message' &&
						!(strictOutput && !calls.length && item.phase === 'commentary')
					) {
						const fullText = parseCodexOutputItems([item]).text;
						const emitted = strictOutput ? '' : (textByIndex.get(outputIndex) ?? '');
						if (fullText && !fullText.startsWith(emitted))
							throw new OperationalError('Codex completed text differs from its streamed text');
						const remainder = fullText.slice(emitted.length);
						if (remainder) yield { type: 'text-delta', delta: remainder };
					}
					for (const content of codexReplayContent([item])) yield { type: 'content', content };
				}
				for (const call of calls)
					yield {
						type: 'tool-call-delta',
						id: call.id,
						name: call.name,
						argumentsDelta: call.argumentsRaw,
					};
				yield {
					type: 'finish',
					finishReason: calls.length ? 'tool-calls' : 'stop',
					usage: parseCodexTokenUsage(response.usage),
				};
				return response;
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

const stateTransactions = new Map<string, Promise<void>>();

async function withStateTransaction<T>(key: string, action: () => Promise<T>): Promise<T> {
	const previous = stateTransactions.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	stateTransactions.set(key, current);
	await previous;
	try {
		return await action();
	} finally {
		release();
		if (stateTransactions.get(key) === current) stateTransactions.delete(key);
	}
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

	const n8nUserFolder = join(toTrimmed(process.env.N8N_USER_FOLDER) ?? homedir(), '.n8n');
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
		baseInstructions: toTrimmed(
			toObject(obj.model_messages)?.instructions_template ??
				obj.baseInstructions ??
				obj.base_instructions,
		),
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

const FALLBACK_MODELS_CATALOG: ModelsCatalogState = {
	fetchedAt: new Date(0).toISOString(),
	models: fallbackModels.models.map((model) => normalizePersistedModelInfo(model)!).filter(Boolean),
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
	return (
		catalog?.models.find((model) => model.slug === normalized) ??
		FALLBACK_MODELS_CATALOG.models.find((model) => model.slug === normalized)
	);
}

function getModelOptionsFromCatalog(catalog: ModelsCatalogState): INodePropertyOptions[] {
	const options: INodePropertyOptions[] = [
		{
			name: 'Custom',
			value: CUSTOM_MODEL_VALUE,
		},
	];

	for (const model of catalog.models) {
		if (model.visibility !== 'list') continue;
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
	const legacyHome = toTrimmed(process.env.N8N_USER_FOLDER);
	const paths = [filePath];
	// Earlier versions interpreted N8N_USER_FOLDER as the .n8n directory itself.
	if (legacyHome && !toTrimmed(process.env[DIRECT_PERSIST_DIR_ENV]))
		paths.push(
			join(
				legacyHome,
				'openai-codex-state',
				`${PERSISTED_STATE_PREFIX}-${sanitizeStateKeySegment(getRuntimeStateKey(context))}.json`,
			),
		);
	for (const path of paths) {
		try {
			const content = await readFile(path, { encoding: 'utf8' });
			const trimmed = toTrimmed(content);
			return trimmed ? normalizePersistedState(JSON.parse(trimmed)) : {};
		} catch (error) {
			if (getSystemErrorCode(error) === 'ENOENT') continue;
			throw new NodeOperationError(
				context.getNode(),
				`Failed to read persisted Codex auth state: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return {};
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
	await writePersistedState(context, state);
	// Migrate secrets written by older releases out of workflow static data. The state file is
	// local to the n8n instance and is written with owner-only permissions below.
	delete nodeStaticData.codexAuthJson;
	delete nodeStaticData.codexDeviceAuth;
	delete nodeStaticData.sessionConversations;
	delete nodeStaticData.modelsCatalog;

	setRuntimeAuthState(runtimeStateKey, state.codexAuthJson);
	setRuntimeDeviceState(runtimeStateKey, state.codexDeviceAuth);
	setRuntimeModelsCatalogState(runtimeStateKey, state.modelsCatalog);
	while (runtimeNodeState.size > 256)
		runtimeNodeState.delete(runtimeNodeState.keys().next().value!);
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
		timeout: 30_000,
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
		timeout: 30_000,
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
		timeout: 30_000,
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

class CodexLoginRequiredError extends OperationalError {
	constructor(code: string) {
		super(
			`Codex login expired or was revoked (${code}). Open the Codex node and click Test step to sign in again.`,
		);
	}
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
			debugState.lastInputPayload =
				process.env.N8N_OPENAI_CODEX_DEBUG_PAYLOADS === 'true'
					? truncateErrorValue(JSON.stringify(input), 500)
					: undefined;
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
	if (
		actual.startsWith(`${requested}-`) &&
		/^\d{4}-\d{2}-\d{2}$/.test(actual.slice(requested.length + 1))
	)
		return true;
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
	auth = deepCloneAuthJson(auth);
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
		timeout: 30_000,
	})) as IN8nHttpFullResponse;

	if (refreshResponse.statusCode < 200 || refreshResponse.statusCode > 299) {
		const code = extractRefreshTokenErrorCode(refreshResponse.body)?.toLowerCase();
		if (
			[400, 401].includes(refreshResponse.statusCode) &&
			code &&
			[
				'refresh_token_expired',
				'refresh_token_reused',
				'refresh_token_invalidated',
				'invalid_grant',
			].includes(code)
		)
			// OperationalError subtype lets Test step distinguish revoked logins from transient failures.
			// eslint-disable-next-line n8n-nodes-base/node-execute-block-wrong-error-thrown
			throw new CodexLoginRequiredError(code);
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

	const accessToken = toTrimmed(refreshPayload.access_token);
	if (!accessToken) throw new OperationalError('Token refresh response is missing an access token');
	tokens.access_token = accessToken;
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
		timeout: 30_000,
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

async function resolveModelsCatalogForExecutionUnlocked(
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

	auth = loadedState.codexAuthJson ?? auth;
	const accessToken = resolveAccessToken(auth);
	const accountId = resolveAccountId(auth);
	if (!accessToken || !accountId) {
		return mergeWithFallbackCatalog(loadedState.modelsCatalog);
	}

	let refreshedCatalog: ModelsCatalogState;
	try {
		refreshedCatalog = await fetchModelsCatalogFromBackend(authContext, accessToken, accountId);
	} catch {
		return mergeWithFallbackCatalog(loadedState.modelsCatalog);
	}
	const nextState: RuntimeNodeState = {
		...loadedState,
		codexAuthJson: deepCloneAuthJson(auth),
		codexDeviceAuth: undefined,
		modelsCatalog: refreshedCatalog,
	};
	await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, nextState);
	return refreshedCatalog;
}

async function resolveModelsCatalogForLoadOptionsUnlocked(
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
		// Refresh tokens may rotate even when the subsequent model-catalog request fails.
		await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, {
			...loadedState,
			codexAuthJson: deepCloneAuthJson(auth),
		});
	}

	const accessToken = resolveAccessToken(auth);
	const accountId = resolveAccountId(auth);
	if (!accessToken || !accountId) {
		return mergeWithFallbackCatalog(loadedState.modelsCatalog);
	}

	let refreshedCatalog: ModelsCatalogState;
	try {
		refreshedCatalog = await fetchModelsCatalogFromBackend(authContext, accessToken, accountId);
	} catch {
		return mergeWithFallbackCatalog(loadedState.modelsCatalog);
	}
	await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, {
		...loadedState,
		codexAuthJson: deepCloneAuthJson(auth),
		codexDeviceAuth: undefined,
		modelsCatalog: refreshedCatalog,
	});
	return refreshedCatalog;
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

async function resolveNodeAuthStateUnlocked(
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
		try {
			auth = await refreshChatgptTokens(authContext, auth);
		} catch (error) {
			if (!(error instanceof CodexLoginRequiredError) || mode !== 'blocking')
				throw new NodeOperationError(stateContext.getNode(), error as Error);
			// Only replace revoked credentials after successfully obtaining a new login code.
			const nextDeviceState = await requestDeviceCode(authContext);
			await saveNodeState(stateContext, runtimeStateKey, nodeStaticData, {
				codexDeviceAuth: nextDeviceState,
				modelsCatalog: loadedState.modelsCatalog,
			});
			return { status: 'pending', deviceState: nextDeviceState, initiated: true };
		}
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
	const defaultModel = context.getNode().typeVersion < 2 ? LEGACY_DEFAULT_MODEL : DEFAULT_MODEL;
	const selectedModel = context.getNodeParameter('model', itemIndex, defaultModel) as string;
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
	if (!selected || selected === 'default') {
		const tier = modelInfo?.defaultServiceTier;
		return tier && tier !== 'default' ? tier : undefined;
	}
	if (
		selected !== 'flex' &&
		modelInfo &&
		!modelInfo.serviceTiers.some((tier) => tier.id === selected)
	) {
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
		version: [1, 2, 3],
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
				default: LEGACY_DEFAULT_MODEL,
				displayOptions: { show: { '@version': [1] } },
				options: MODEL_OPTIONS,
				typeOptions: {
					loadOptionsMethod: 'getCodexModelOptions',
				},
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				default: DEFAULT_MODEL,
				displayOptions: { show: { '@version': [2, 3] } },
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
				placeholder: 'e.g. gpt-6.1-sol',
				displayOptions: {
					show: {
						model: [CUSTOM_MODEL_VALUE],
					},
				},
				description: 'Custom model slug',
			},
			...[false, true].map((automatic) => ({
				displayName: 'Output Format',
				name: 'responseFormat',
				type: 'options' as const,
				default: automatic ? 'auto' : 'text',
				displayOptions: { show: { '@version': automatic ? [3] : [1, 2] } },
				options: [
					{
						name: 'Automatic',
						value: 'auto',
						description: 'Enforce the connected AI Agent parser schema; use text without a parser',
					},
					{
						name: 'Text',
						value: 'text',
						description: 'Leave output formatting to the agent or chain without native enforcement',
					},
					{
						name: 'Agent Output Parser (Strict)',
						value: 'agentOutputParser',
						description: 'Enforce the connected AI Agent output parser schema natively',
					},
					{
						name: 'JSON Schema (Strict)',
						value: 'jsonSchema',
						description: 'Enforce the JSON Schema entered below natively',
					},
				],
				description: 'Native strict modes enforce the final JSON structure at generation time',
			})),
			{
				displayName: 'Output Schema Name',
				name: 'outputSchemaName',
				type: 'string',
				default: 'codex_output_schema',
				displayOptions: { show: { responseFormat: ['jsonSchema'] } },
				description:
					'Schema identifier containing letters, digits, underscores, or hyphens (up to 64 characters)',
			},
			{
				displayName: 'Output Schema',
				name: 'outputSchema',
				type: 'json',
				default: DEFAULT_OUTPUT_SCHEMA,
				displayOptions: { show: { responseFormat: ['jsonSchema'] } },
				description:
					'JSON Schema for the final response. Every property must be required. Use nullable required fields for optional values. Objects are closed to additional properties.',
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
					{ name: 'Flex', value: 'flex' },
					...(modelInfo?.serviceTiers ?? [])
						.filter((tier) => tier.id !== 'flex')
						.map((tier) => ({
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
			const responseFormat = this.getNodeParameter(
				'responseFormat',
				itemIndex,
				this.getNode().typeVersion >= 3 ? 'auto' : 'text',
			) as string;
			if (!['auto', 'text', 'jsonSchema', 'agentOutputParser'].includes(responseFormat))
				throw new OperationalError('Unsupported Output Format');
			let outputFormat: Record<string, unknown> | undefined;
			if (responseFormat === 'jsonSchema') {
				const name = String(
					this.getNodeParameter('outputSchemaName', itemIndex, 'codex_output_schema'),
				);
				if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
					throw new OperationalError(
						'Output Schema Name must contain 1–64 letters, digits, underscores, or hyphens',
					);
				const raw = this.getNodeParameter('outputSchema', itemIndex, DEFAULT_OUTPUT_SCHEMA);
				let schema: unknown = raw;
				if (typeof raw === 'string') {
					try {
						schema = JSON.parse(raw);
					} catch {
						throw new NodeOperationError(this.getNode(), 'Output Schema must contain valid JSON');
					}
				}
				outputFormat = {
					type: 'json_schema',
					name,
					strict: true,
					schema: getCodexStrictSchema(schema, name),
				};
			}
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
				outputFormat,
				useAgentOutputParser: responseFormat === 'agentOutputParser',
				autoDetectOutputParser: responseFormat === 'auto',
				defaultInstructions: modelInfo?.baseInstructions ?? DEFAULT_INSTRUCTIONS,
				reasoning: reasoningConfig,
				verbosity,
				serviceTier,
				parallelToolCalls: supportsParallelToolCalls(modelName, modelsCatalog),
				useResponsesLite: modelInfo?.useResponsesLite ?? false,
				refreshAuthHeaders: async (rejectedAuthorization) =>
					withStateTransaction(runtimeStateKey, async () => {
						const currentState = await loadNodeState(stateContext, runtimeStateKey, nodeStaticData);
						if (!currentState.codexAuthJson) {
							throw new OperationalError('Codex auth state is unavailable for token refresh');
						}
						const existingToken = resolveAccessToken(currentState.codexAuthJson);
						const refreshedAuth =
							existingToken && `Bearer ${existingToken}` !== rejectedAuthorization
								? currentState.codexAuthJson
								: await refreshChatgptTokens(authContext, currentState.codexAuthJson);
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
					}),
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
						timeout: typeof config?.timeout === 'number' ? config.timeout : 600_000,
						...(config?.abortSignal ? { abortSignal: config.abortSignal } : {}),
					})) as IN8nHttpFullResponse;

					return response;
				},
			});

			return supplyCodexModel(this, codexModel);
		} catch (error) {
			throw new NodeOperationError(this.getNode(), error as Error);
		}
	}
}

async function resolveNodeAuthState(
	stateContext: PersistedStateContext,
	authContext: AuthRequestContext,
	runtimeStateKey: string,
	nodeStaticData: IDataObject,
	mode: AuthResolveMode,
): Promise<ResolvedAuthState> {
	return withStateTransaction(runtimeStateKey, () =>
		resolveNodeAuthStateUnlocked(stateContext, authContext, runtimeStateKey, nodeStaticData, mode),
	);
}

async function resolveModelsCatalogForExecution(
	stateContext: PersistedStateContext,
	authContext: AuthRequestContext,
	runtimeStateKey: string,
	nodeStaticData: IDataObject,
	auth: CodexAuthJson,
): Promise<ModelsCatalogState> {
	return withStateTransaction(runtimeStateKey, () =>
		resolveModelsCatalogForExecutionUnlocked(
			stateContext,
			authContext,
			runtimeStateKey,
			nodeStaticData,
			auth,
		),
	);
}

async function resolveModelsCatalogForLoadOptions(
	context: ILoadOptionsFunctions,
): Promise<ModelsCatalogState> {
	return withStateTransaction(getRuntimeStateKey(context as unknown as RuntimeStateContext), () =>
		resolveModelsCatalogForLoadOptionsUnlocked(context),
	);
}

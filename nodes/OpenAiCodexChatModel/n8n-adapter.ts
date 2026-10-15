import { supplyModel, type ChatModel, type ChatModelConfig, type Tool } from '@n8n/ai-node-sdk';
import {
	NodeOperationError,
	OperationalError,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';
import { getCodexToolParameters } from './tool-schema';

export interface CodexModelBridge extends ChatModel {
	withTools(tools: Tool[]): CodexModelBridge;
	withInvocationConfig(options: Record<string, unknown>): CodexModelBridge;
}

type LcMessage = {
	content: unknown;
	response_metadata?: Record<string, unknown>;
	tool_calls?: Array<{ name: string; args: unknown }>;
	constructor: new (fields: unknown) => LcMessage;
};
type LcChunk = {
	message: LcMessage & { tool_call_chunks?: Array<{ id?: string; index?: number }> };
};
type LcResult = { generations: Array<{ message: LcMessage }> };
type Adapter = {
	callbacks?: unknown;
	_generate(messages: LcMessage[], options: Record<string, unknown>): Promise<LcResult>;
	_streamResponseChunks(
		messages: LcMessage[],
		options: Record<string, unknown>,
		runManager?: unknown,
	): AsyncGenerator<LcChunk>;
	bindTools(tools: unknown[], options?: Record<string, unknown>): Adapter;
	withStructuredOutput(schema: unknown, options?: Record<string, unknown>): unknown;
	pipe(parser: (message: LcMessage) => Promise<unknown>): unknown;
};

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function genericTool(raw: unknown): Tool {
	const tool = object(raw);
	const definition = object(tool?.function) ?? tool;
	if (!definition || typeof definition.name !== 'string')
		throw new OperationalError('Tool definition is missing a name');
	if (tool?.type && tool.type !== 'function') {
		throw new OperationalError(
			`Provider tool "${definition.name}" is not supported by the Codex chat backend; connect an n8n function tool instead`,
		);
	}
	const inputSchema = definition.schema ?? definition.parameters;
	// Validate at binding so incompatible tools fail before agent execution.
	getCodexToolParameters(inputSchema, definition.name);
	return {
		type: 'function',
		name: definition.name,
		description: typeof definition.description === 'string' ? definition.description : undefined,
		inputSchema: inputSchema as Extract<Tool, { type: 'function' }>['inputSchema'],
		...(typeof definition.strict === 'boolean' ? { strict: definition.strict } : {}),
	};
}

function mediaBlock(raw: unknown): unknown {
	const block = object(raw);
	if (!block) return raw;
	const legacyImage = object(block.image_url);
	if (block.type === 'image_url') {
		const url = typeof block.image_url === 'string' ? block.image_url : legacyImage?.url;
		return {
			type: 'image',
			url,
			mimeType:
				typeof url === 'string' && url.startsWith('data:') ? url.slice(5).split(';')[0] : 'image/*',
		};
	}
	if ((block.type === 'image' || block.type === 'audio') && !block.mimeType) {
		return { ...block, mimeType: `${block.type}/*` };
	}
	if (block.type === 'resource') {
		const resource = object(block.resource);
		if (typeof resource?.text === 'string') return { type: 'text', text: resource.text };
		if (typeof resource?.blob === 'string' && typeof resource.mimeType === 'string')
			return mediaBlock({
				type: resource.mimeType.startsWith('image/') ? 'image' : 'file',
				mimeType: resource.mimeType,
				data: resource.blob,
			});
		throw new OperationalError('MCP resource has no supported embedded content');
	}
	if (block.type === 'input_audio') {
		const audio = object(block.input_audio);
		return {
			type: 'audio',
			data: audio?.data,
			mimeType: `audio/${String(audio?.format ?? 'wav')}`,
		};
	}
	if (block.type === 'non_standard') {
		const value = object(block.value);
		if (value?.codexMessageItem || value?.codexReasoningItem) return block;
		throw new OperationalError('The Codex backend cannot replay content from another provider');
	}
	if (
		![
			'text',
			'reasoning',
			'image',
			'audio',
			'file',
			'video',
			'text-plain',
			'tool_call',
			'invalid_tool_call',
			'server_tool_call_result',
			'citation',
		].includes(String(block.type))
	)
		throw new OperationalError(`Unsupported message content block "${String(block.type)}"`);
	return block;
}

/** Opaque replay records must survive memory without entering text/output parsers. */
function moveReplayToMetadata(message: LcMessage): void {
	if (!Array.isArray(message.content)) return;
	const replay = message.content.filter((raw) => {
		const block = object(raw);
		const value = object(block?.value);
		return block?.type === 'non_standard' && (value?.codexMessageItem || value?.codexReasoningItem);
	});
	if (!replay.length) return;
	message.content = message.content.filter((block) => !replay.includes(block));
	message.response_metadata = { ...message.response_metadata, codexReplay: replay };
}

function messagesWithMedia(messages: LcMessage[]): LcMessage[] {
	return messages.map((message) => {
		const replay = message.response_metadata?.codexReplay;
		if (!Array.isArray(message.content) && !Array.isArray(replay)) return message;
		const content = Array.isArray(message.content)
			? message.content
			: [{ type: 'text', text: message.content }];
		return new message.constructor({
			...message,
			content: [...(Array.isArray(replay) ? replay : []), ...content].map(mediaBlock),
		});
	});
}

function invocationConfig(
	context: ISupplyDataFunctions,
	options: Record<string, unknown>,
): Record<string, unknown> & ChatModelConfig {
	const signals = [
		options.abortSignal,
		options.signal,
		context.getExecutionCancelSignal?.(),
	].filter((signal): signal is AbortSignal =>
		Boolean(signal && typeof signal === 'object' && 'aborted' in signal),
	);
	const abortSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
	return { ...options, ...(abortSignal ? { abortSignal } : {}) };
}

/** Preserve n8n tracing and model identity while filling gaps in the SDK's public adapter. */
export function supplyCodexModel(
	context: ISupplyDataFunctions,
	model: CodexModelBridge,
): SupplyData {
	const supplied = supplyModel(context, model);
	const adapter = supplied.response as Adapter;
	const generate = adapter._generate.bind(adapter);
	const stream = adapter._streamResponseChunks.bind(adapter);
	adapter._generate = async (messages, options) => {
		const result = await generate(messagesWithMedia(messages), invocationConfig(context, options));
		for (const generation of result.generations) moveReplayToMetadata(generation.message);
		return result;
	};
	adapter._streamResponseChunks = async function* (messages, options, runManager) {
		const indices = new Map<string, number>();
		for await (const chunk of stream(
			messagesWithMedia(messages),
			invocationConfig(context, options),
			runManager,
		)) {
			for (const call of chunk.message.tool_call_chunks ?? []) {
				if (!call.id) throw new OperationalError('Streamed tool call is missing its ID');
				if (!indices.has(call.id)) indices.set(call.id, indices.size);
				call.index = indices.get(call.id);
			}
			moveReplayToMetadata(chunk.message);
			yield chunk;
		}
	};
	adapter.bindTools = (tools, options = {}) => {
		const bound = supplyCodexModel(
			context,
			model
				.withTools(
					tools.map((raw) => {
						const tool = genericTool(raw);
						return typeof options.strict === 'boolean' ? { ...tool, strict: options.strict } : tool;
					}),
				)
				.withInvocationConfig(options),
		).response as Adapter;
		bound.callbacks = adapter.callbacks;
		return bound;
	};
	adapter.withStructuredOutput = (schema, options = {}) => {
		const name = typeof options.name === 'string' ? options.name : 'extract';
		const parameters = getCodexToolParameters(schema, name);
		const method = options.method ?? 'functionCalling';
		if (!['functionCalling', 'jsonSchema', 'jsonMode'].includes(String(method)))
			throw new OperationalError(`Unsupported structured output method "${String(method)}"`);
		const boundModel =
			method === 'functionCalling'
				? model
						.withTools([
							{
								type: 'function',
								name,
								description: 'Return the requested structured output',
								inputSchema: parameters,
								...(typeof options.strict === 'boolean' ? { strict: options.strict } : {}),
							},
						])
						.withInvocationConfig({ tool_choice: name })
				: model.withInvocationConfig({
						response_format:
							method === 'jsonMode'
								? { type: 'json_object' }
								: {
										type: 'json_schema',
										name,
										strict: options.strict ?? false,
										schema: parameters,
									},
					});
		const bound = supplyCodexModel(context, boundModel).response as Adapter;
		bound.callbacks = adapter.callbacks;
		return bound.pipe(async (raw) => {
			try {
				const call = raw.tool_calls?.find((tool) => tool.name === name);
				const text =
					typeof raw.content === 'string'
						? raw.content
						: Array.isArray(raw.content)
							? raw.content
									.map((part) => (object(part)?.type === 'text' ? (object(part)?.text ?? '') : ''))
									.join('')
							: '';
				if (method === 'functionCalling' && !call)
					throw new OperationalError(`Structured output tool "${name}" was not called`);
				let parsed = method === 'functionCalling' ? call?.args : JSON.parse(text);
				const parse = object(schema)?.parseAsync;
				if (typeof parse === 'function') parsed = await parse.call(schema, parsed);
				return options.includeRaw ? { raw, parsed } : parsed;
			} catch (error) {
				if (options.includeRaw) return { raw, parsed: null, parsing_error: error };
				throw new NodeOperationError(context.getNode(), error as Error);
			}
		});
	};
	return supplied;
}

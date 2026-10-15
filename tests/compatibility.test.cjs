const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { cpSync, mkdtempSync, rmSync, readFileSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { Readable } = require('node:stream');
const { test, after } = require('node:test');
const { createRequire, Module } = require('node:module');
const sdkRequire = createRequire(require.resolve('@n8n/ai-node-sdk'));
const { fromLcMessage, toLcMessage } = sdkRequire('@n8n/ai-utilities');
const lcRequire = createRequire(sdkRequire.resolve('@n8n/ai-utilities'));
const { HumanMessage, ToolMessage, AIMessage } = lcRequire('@langchain/core/messages');
const { DynamicStructuredTool } = lcRequire('@langchain/core/tools');
const { Calculator } = lcRequire('@langchain/community/tools/calculator');

const foreignZodDir = mkdtempSync(join(tmpdir(), 'n8n-codex-foreign-zod-'));
cpSync(dirname(require.resolve('zod/package.json')), join(foreignZodDir, 'zod'), {
	recursive: true,
});
const foreignRequire = createRequire(join(foreignZodDir, 'fixture.cjs'));
const zod3 = foreignRequire('./zod').z;
const zod4 = foreignRequire('./zod/v4').z;
const stateDir = mkdtempSync(join(tmpdir(), 'n8n-codex-test-'));
process.env.N8N_OPENAI_CODEX_STATE_DIR = stateDir;
const {
	OpenAiCodexChatModel,
} = require('../dist/nodes/OpenAiCodexChatModel/OpenAiCodexChatModel.node.js');
const catalog = require('../nodes/OpenAiCodexChatModel/fallback-models.json');
after(() => {
	rmSync(stateDir, { recursive: true, force: true });
	rmSync(foreignZodDir, { recursive: true, force: true });
});
const prompt = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }];
const assistant = (text = 'Hello', phase = 'final_answer') => ({
	type: 'message',
	role: 'assistant',
	phase,
	content: [{ type: 'output_text', text }],
});
const completed = (output = [assistant()], extra = {}) => ({
	type: 'response.completed',
	response: { id: 'resp-test', status: 'completed', output, ...extra },
});
const sse = (events) => ({
	statusCode: 200,
	headers: {},
	body: Readable.from(events.map((event) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`))),
});

function harness({
	parameters = {},
	version = 2,
	id = randomUUID(),
	remoteModels = catalog.models,
	responses = [sse([completed()])],
	auth = true,
	refresh = {},
} = {}) {
	const staticData = auth
		? {
				codexAuthJson: {
					tokens: {
						access_token: 'test-access',
						refresh_token: 'test-refresh',
						id_token: 'test-id',
						account_id: 'test-account',
					},
					last_refresh: new Date().toISOString(),
				},
			}
		: {};
	const calls = [];
	let responseIndex = 0;
	const context = {
		getNode: () => ({
			id,
			name: 'Codex',
			type: 'CUSTOM.openAiCodexChatModel',
			typeVersion: version,
			position: [0, 0],
			parameters,
		}),
		getWorkflow: () => ({ id: 'test-workflow' }),
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name, _index, fallback) => parameters[name] ?? fallback,
		getCurrentNodeParameter: (name) => parameters[name],
		continueOnFail: () => false,
		helpers: {
			returnJsonArray: (json) => [{ json }],
			httpRequest: async (options) => {
				calls.push(options);
				if (options.url.includes('/models?'))
					return { statusCode: remoteModels ? 200 : 503, body: { models: remoteModels } };
				if (options.url.endsWith('/responses'))
					return responses[responseIndex++] ?? sse([completed()]);
				if (options.url.endsWith('/oauth/token'))
					return {
						statusCode: 200,
						body: {
							access_token: 'test-new-access',
							refresh_token: 'test-new-refresh',
							...refresh,
						},
					};
				if (options.url.endsWith('/deviceauth/usercode'))
					return {
						statusCode: 200,
						body: { device_auth_id: 'test-device', user_code: 'TEST-CODE', interval: '5' },
					};
				if (options.url.endsWith('/deviceauth/token')) return { statusCode: 403, body: {} };
				throw new Error(`Unexpected URL: ${options.url}`);
			},
		},
	};
	const node = new OpenAiCodexChatModel();
	return {
		context,
		node,
		calls,
		staticData,
		id,
		model: async () => (await node.supplyData.call(context, 0)).response.chatModel,
		adapter: async () => {
			const adapter = (await node.supplyData.call(context, 0)).response;
			// The harness has no n8n execution database; keep the public model interface while
			// disabling execution tracing callbacks. The production adapter retains them.
			adapter.callbacks = [];
			return adapter;
		},
		requests: () => calls.filter((call) => call.url.endsWith('/responses')),
	};
}

const tool = {
	type: 'function',
	name: 'lookup_order',
	description: 'Find an order',
	inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

for (const [version, z] of [
	['3', zod3],
	['4', zod4],
]) {
	test(`preserves structured tool arguments from a separate Zod ${version} installation`, async () => {
		const schema = z.object({
			query: z.string().describe('Search query'),
			limit: z.number().min(1).max(20).describe('Number of posts'),
			includeReplies: z.boolean(),
			filters: z.object({ tags: z.array(z.string()) }),
			mode: z.enum(['recent', 'popular']),
			cursor: z.string().optional(),
		});
		assert.notEqual(z.ZodObject, require(version === '3' ? 'zod' : 'zod/v4').z.ZodObject);
		assert.equal(schema instanceof require('zod').ZodSchema, false);
		const h = harness();
		const model = (await h.model()).withTools([
			{
				type: 'function',
				name: 'linkedin_feed',
				description: 'Get feed posts',
				inputSchema: schema,
			},
		]);
		await model.generate(prompt);
		const parameters = h.requests()[0].body.input[0].tools[0].tools[0].parameters;
		assert.deepEqual(parameters, {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search query' },
				limit: { type: 'number', minimum: 1, maximum: 20, description: 'Number of posts' },
				includeReplies: { type: 'boolean' },
				filters: {
					type: 'object',
					properties: { tags: { type: 'array', items: { type: 'string' } } },
					required: ['tags'],
					...(version === '3' ? { additionalProperties: false } : {}),
				},
				mode: { type: 'string', enum: ['recent', 'popular'] },
				cursor: { type: 'string' },
			},
			required: ['query', 'limit', 'includeReplies', 'filters', 'mode'],
			additionalProperties: false,
		});
	});

	test(`keeps Calculator-style primitive text tools compatible with Zod ${version}`, async () => {
		const h = harness();
		const model = (await h.model()).withTools([
			{
				type: 'function',
				name: 'calculator',
				description: 'Calculate',
				inputSchema: z.string().describe('Math expression'),
			},
		]);
		await model.generate(prompt);
		assert.deepEqual(h.requests()[0].body.input[0].tools[0].tools[0].parameters, {
			type: 'object',
			properties: { input: { type: 'string', description: 'Math expression' } },
			required: ['input'],
			additionalProperties: false,
		});
	});

	test(`preserves optional single arguments and defaults with Zod ${version}`, async () => {
		for (const field of [z.number().optional(), z.number().default(5)]) {
			const h = harness();
			await (await h.model())
				.withTools([{ type: 'function', name: 'feed', inputSchema: z.object({ limit: field }) }])
				.generate(prompt);
			const parameters = h.requests()[0].body.input[0].tools[0].tools[0].parameters;
			assert.equal(parameters.required?.includes('limit') ?? false, false);
			assert.equal(parameters.properties.limit.type, 'number');
		}
	});

	for (const [name, inputSchema] of [
		['date', z.object({ since: z.date() })],
		[
			'function',
			version === '3' ? z.object({ handler: z.function() }) : z.object({ handler: z.custom() }),
		],
		['unknown', z.object({ filter: z.unknown() })],
	]) {
		test(`rejects unsupported ${name} schemas in Zod ${version} before inference`, async () => {
			const h = harness();
			const model = (await h.model()).withTools([
				{ type: 'function', name: 'invalid_feed', inputSchema },
			]);
			await assert.rejects(
				() => model.generate(prompt),
				/Cannot convert input schema for tool "invalid_feed"/,
			);
			assert.equal(h.requests().length, 0);
		});
	}
}

for (const [version, z] of [
	['3', zod3],
	['4', zod4],
]) {
	test(`rejects recursive Zod ${version} schemas explicitly`, async () => {
		let schema;
		schema = z.object({ child: z.lazy(() => schema) });
		const h = harness();
		const model = (await h.model()).withTools([
			{ type: 'function', name: 'recursive_tool', inputSchema: schema },
		]);
		await assert.rejects(
			() => model.generate(prompt),
			/Cannot convert input schema for tool "recursive_tool".*[Rr]ecurs|Cannot convert input schema for tool "recursive_tool".*[Cc]ycle/,
		);
		assert.equal(h.requests().length, 0);
	});
}

test('bundled converter runs without resolving external Zod packages', () => {
	const filename = join(__dirname, '../dist/nodes/OpenAiCodexChatModel/tool-schema.js');
	const bundled = new Module(filename);
	bundled.filename = filename;
	bundled.paths = [];
	bundled.require = (name) => {
		assert.equal(name, 'n8n-workflow', `Unexpected runtime dependency: ${name}`);
		return require('n8n-workflow');
	};
	bundled._compile(readFileSync(filename, 'utf8'), filename);
	for (const z of [zod3, zod4]) {
		const parameters = bundled.exports.getCodexToolParameters(
			z.object({ limit: z.number() }),
			'feed',
		);
		assert.equal(parameters.properties.limit.type, 'number');
		assert.deepEqual(parameters.required, ['limit']);
	}
});

test('preserves JSON Schema arguments, integer types, constraints, and optional fields', async () => {
	const inputSchema = {
		type: 'object',
		properties: {
			limit: { type: 'integer', minimum: 1, maximum: 100 },
			status: { type: ['string', 'null'], enum: ['open', null] },
			payload: { anyOf: [{ type: 'string' }, { type: 'number' }] },
		},
		required: ['limit'],
		additionalProperties: false,
	};
	const h = harness();
	await (await h.model())
		.withTools([{ type: 'function', name: 'structured', inputSchema }])
		.generate(prompt);
	assert.deepEqual(h.requests()[0].body.input[0].tools[0].tools[0].parameters, inputSchema);
});

test('preserves composed object schemas without closing sibling argument branches', async () => {
	const inputSchema = {
		type: 'object',
		allOf: [
			{ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
			{ type: 'object', properties: { limit: { type: 'number' } }, required: ['limit'] },
		],
	};
	const h = harness();
	await (await h.model())
		.withTools([{ type: 'function', name: 'combined', inputSchema }])
		.generate(prompt);
	assert.deepEqual(h.requests()[0].body.input[0].tools[0].tools[0].parameters, inputSchema);
});

for (const inputSchema of [
	undefined,
	{},
	{ safeParse() {} },
	{ type: 'unsupported' },
	{ type: 'object', properties: { limit: {} } },
	{ type: 'object', properties: { limit: { $ref: '#/definitions/limit' } } },
]) {
	test(`rejects unrecognized tool schemas: ${JSON.stringify(inputSchema)}`, async () => {
		const h = harness();
		const model = (await h.model()).withTools([
			{ type: 'function', name: 'unsupported_tool', inputSchema },
		]);
		await assert.rejects(async () => {
			for await (const _ of model.stream(prompt)) {
			}
		}, /Cannot convert input schema for tool "unsupported_tool"/);
		assert.equal(h.requests().length, 0);
	});
}

test('new models match the current CLI catalog and version 1 keeps its default', async () => {
	for (const version of [1, 2, 3]) {
		const h = harness({ version, remoteModels: null });
		const model = await h.model();
		assert.equal(model.modelId, version === 1 ? 'gpt-5.6-sol' : 'gpt-6.1-sol');
		const parameter = h.node.description.properties.find(
			(x) => x.name === 'model' && x.displayOptions.show['@version'].includes(version),
		);
		assert.equal(parameter.default, model.modelId);
		await model.generate(prompt);
		assert.equal(h.requests()[0].body.reasoning.effort, 'low');
	}
	const h = harness();
	const options = await h.node.methods.loadOptions.getCodexModelOptions.call(h.context);
	assert.deepEqual(
		options.slice(1).map((x) => x.value),
		catalog.models.filter((x) => x.visibility === 'list').map((x) => x.slug),
	);
	assert.match(h.calls[0].url, /client_version=0\.162\.1$/);
});

test('Responses Lite namespaces tools, preserves names, and puts instructions in input', async () => {
	const h = harness({ parameters: { reasoningEffort: 'none' } });
	const model = (await h.model()).withTools([tool]);
	await model.generate([
		{ role: 'system', content: [{ type: 'text', text: 'Follow workflow rules.' }] },
		...prompt,
	]);
	const { body, headers } = h.requests()[0];
	assert.equal(body.instructions, undefined);
	assert.equal(body.tools, undefined);
	assert.deepEqual(body.input[0], {
		type: 'additional_tools',
		role: 'developer',
		tools: [
			{
				type: 'namespace',
				name: 'functions',
				description: '',
				tools: [
					{
						type: 'function',
						name: tool.name,
						description: tool.description,
						strict: false,
						parameters: tool.inputSchema,
					},
				],
			},
		],
	});
	assert.equal(body.input[1].role, 'developer');
	assert.equal(body.input[1].content[0].text, 'Follow workflow rules.');
	assert.deepEqual(body.reasoning, { context: 'all_turns' });
	assert.equal(body.parallel_tool_calls, false);
	assert.equal(headers['x-openai-internal-codex-responses-lite'], 'true');
});

test('standard Responses also uses developer instructions and top-level tools', async () => {
	const remoteModels = [
		{
			...catalog.models.find((x) => x.slug === 'gpt-5.5'),
			model_messages: { instructions_template: 'Current model instructions' },
		},
	];
	const h = harness({ parameters: { model: 'gpt-5.5' }, remoteModels });
	await (await h.model()).withTools([tool]).generate(prompt);
	const { body, headers } = h.requests()[0];
	assert.equal(body.instructions, undefined);
	assert.equal(body.input[0].content[0].text, 'Current model instructions');
	assert.equal(body.tools[0].name, 'lookup_order');
	assert.equal(body.reasoning.context, undefined);
	assert.equal(headers['x-openai-internal-codex-responses-lite'], undefined);
});

test('Lite requests without tools omit additional_tools', async () => {
	const h = harness();
	await (await h.model()).generate(prompt);
	assert.equal(
		h.requests()[0].body.input.some((x) => x.type === 'additional_tools'),
		false,
	);
});

test('media input supports audio, image URLs, binary images, and text whitespace', async () => {
	const h = harness();
	await (
		await h.model()
	).generate([
		{
			role: 'user',
			content: [
				{ type: 'text', text: '  indented\n' },
				{ type: 'file', mediaType: 'audio/wav', data: 'YWJj' },
				{ type: 'file', mediaType: 'image/png', data: Uint8Array.from([1, 2, 3]) },
				{
					type: 'file',
					mediaType: 'image/png',
					providerMetadata: { url: 'https://example.com/image.png' },
				},
			],
		},
	]);
	assert.deepEqual(h.requests()[0].body.input.at(-1).content, [
		{ type: 'input_text', text: '  indented\n' },
		{ type: 'input_audio', audio_url: 'data:audio/wav;base64,YWJj' },
		{ type: 'input_image', image_url: 'data:image/png;base64,AQID' },
		{ type: 'input_image', image_url: 'https://example.com/image.png' },
	]);
});

for (const streaming of [false, true]) {
	test(`${streaming ? 'stream' : 'generate'} replays reasoning, phases, and namespaced tool history`, async () => {
		const reasoning = { type: 'reasoning', summary: [], encrypted_content: 'test-encrypted' };
		const message = assistant('  working\n', 'commentary');
		const call = {
			type: 'function_call',
			namespace: 'functions',
			call_id: 'call-1',
			name: 'lookup_order',
			arguments: '{"id":"42"}',
		};
		const h = harness({ responses: [sse([completed([reasoning, message, call])])] });
		const model = (await h.model()).withTools([tool]);
		let result;
		if (streaming) {
			const chunks = [];
			for await (const chunk of model.stream(prompt)) chunks.push(chunk);
			assert.equal(chunks.at(-1).finishReason, 'tool-calls');
			assert.equal(chunks.find((x) => x.type === 'tool-call-delta').name, 'lookup_order');
			result = {
				role: 'assistant',
				content: chunks
					.filter((x) => x.type === 'content')
					.map((x) => x.content)
					.concat([
						{ type: 'text', text: '  working\n' },
						{
							type: 'tool-call',
							toolCallId: 'call-1',
							toolName: 'lookup_order',
							input: '{"id":"42"}',
						},
					]),
			};
		} else {
			const generated = await model.generate(prompt);
			assert.equal(generated.finishReason, 'tool-calls');
			result = generated.message;
		}
		await model.generate([
			...prompt,
			fromLcMessage(toLcMessage(result)),
			{
				role: 'tool',
				content: [{ type: 'tool-result', toolCallId: 'call-1', result: { found: true } }],
			},
		]);
		const input = h.requests()[1].body.input;
		assert.deepEqual(
			input.find((x) => x.type === 'reasoning'),
			reasoning,
		);
		assert.deepEqual(
			input.filter((x) => x.role === 'assistant'),
			[message],
		);
		assert.deepEqual(
			input.find((x) => x.type === 'function_call'),
			call,
		);
		assert.equal(input.at(-1).output, '{"found":true}');
	});
	for (const event of [
		{ type: 'response.failed', response: { error: { message: 'Model unavailable' } } },
		{
			type: 'response.incomplete',
			response: { incomplete_details: { reason: 'max_output_tokens' } },
		},
		{ type: 'error', error: { message: 'Service unavailable' } },
	]) {
		test(`${streaming ? 'stream' : 'generate'} rejects ${event.type}`, async () => {
			const h = harness({ responses: [sse([event])] });
			const model = await h.model();
			await assert.rejects(async () => {
				if (streaming) {
					for await (const _ of model.stream(prompt)) {
					}
				} else await model.generate(prompt);
			}, /Model unavailable|max_output_tokens|Service unavailable/);
		});
	}
}

test('done items are retained when completion contains no output', async () => {
	const h = harness({
		responses: [
			sse([{ type: 'response.output_item.done', item: assistant('\nHello\n') }, completed([])]),
		],
	});
	const result = await (await h.model()).generate(prompt);
	assert.equal(result.message.content.find((x) => x.type === 'text').text, '\nHello\n');
});

test('streamed tool deltas use final arguments once and report token usage', async () => {
	const item = {
		type: 'function_call',
		namespace: 'functions',
		call_id: 'call-1',
		name: 'lookup_order',
		arguments: '',
	};
	const h = harness({
		responses: [
			sse([
				{ type: 'response.output_item.added', output_index: 0, item },
				{ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"id":' },
				{
					type: 'response.output_item.done',
					output_index: 0,
					item: { ...item, arguments: '{"id":"42"}' },
				},
				completed([{ ...item, arguments: '{"id":"42"}' }], {
					usage: {
						input_tokens: 12,
						output_tokens: 3,
						input_tokens_details: { cached_tokens: 5 },
						output_tokens_details: { reasoning_tokens: 2 },
					},
				}),
			]),
		],
	});
	const chunks = [];
	for await (const chunk of (await h.model()).withTools([tool]).stream(prompt)) chunks.push(chunk);
	assert.equal(chunks.filter((x) => x.type === 'tool-call-delta').length, 1);
	assert.equal(chunks[0].argumentsDelta, '{"id":"42"}');
	assert.deepEqual(chunks.at(-1).usage, {
		promptTokens: 12,
		completionTokens: 3,
		totalTokens: 15,
		inputTokenDetails: { cacheRead: 5 },
		outputTokenDetails: { reasoning: 2 },
	});
});

test('401 refresh persists new tokens and reuses them on subsequent turns', async () => {
	const h = harness({
		responses: [
			{ statusCode: 401, body: Readable.from(['{"error":{"message":"expired"}}']) },
			sse([completed()]),
			sse([completed()]),
		],
	});
	const model = await h.model();
	await model.generate(prompt);
	await model.generate(prompt);
	assert.deepEqual(
		h.requests().map((x) => x.headers.Authorization),
		['Bearer test-access', 'Bearer test-new-access', 'Bearer test-new-access'],
	);
	const path = join(stateDir, `.openai-codex-state-test-workflow_${h.id}.json`);
	assert.equal(
		JSON.parse(readFileSync(path)).codexAuthJson.tokens.refresh_token,
		'test-new-refresh',
	);
	if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.equal(h.staticData.codexAuthJson, undefined);
});

test('HTTP error streams include backend details', async () => {
	const h = harness({
		responses: [
			{ statusCode: 400, body: Readable.from(['{"error":{"message":"Invalid namespace"}}']) },
		],
	});
	await assert.rejects(
		() => h.model().then((model) => model.generate(prompt)),
		/Invalid namespace/,
	);
});

test('model substitution and truncated streams are rejected', async () => {
	for (const responses of [[sse([completed([], { model: 'gpt-6-luna' })])], [sse([])]]) {
		const h = harness({ responses });
		await assert.rejects(
			() => h.model().then((model) => model.generate(prompt)),
			/Model mismatch|before a terminal event/,
		);
	}
});

test('model-specific reasoning validation rejects unsupported efforts', async () => {
	const h = harness({ parameters: { model: 'gpt-6-luna', reasoningEffort: 'ultra' } });
	await assert.rejects(() => h.model(), /not supported/);
});

test('device login follows current CLI endpoints and preserves pending state', async () => {
	const h = harness({ auth: false });
	await assert.rejects(() => h.model(), /TEST-CODE/);
	assert.equal(h.calls[0].body.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
	assert.match(h.calls[0].url, /deviceauth\/usercode$/);
	await assert.rejects(() => h.model(), /pending/);
	assert.deepEqual(h.calls[1].body, { device_auth_id: 'test-device', user_code: 'TEST-CODE' });
});

test('model metadata is available for a new model missing from an older cached catalog', async () => {
	const h = harness({ remoteModels: [catalog.models.find((x) => x.slug === 'gpt-5.6-sol')] });
	await (await h.model()).generate(prompt);
	assert.equal(h.requests()[0].headers['x-openai-internal-codex-responses-lite'], 'true');
	assert.equal(h.requests()[0].body.reasoning.effort, 'low');
});

test('ChatGPT model picker includes models marked unavailable in API-key mode', async () => {
	const h = harness({ remoteModels: [{ ...catalog.models[0], supported_in_api: false }] });
	const options = await h.node.methods.loadOptions.getCodexModelOptions.call(h.context);
	assert.equal(options[1].value, catalog.models[0].slug);
});

test('catalog lookup persists rotated tokens even when the model request fails', async () => {
	const h = harness({ remoteModels: null });
	h.staticData.codexAuthJson.last_refresh = '2000-01-01T00:00:00Z';
	await h.node.methods.loadOptions.getCodexModelOptions.call(h.context);
	await (await h.model()).generate(prompt);
	assert.equal(h.requests()[0].headers.Authorization, 'Bearer test-new-access');
	assert.equal(h.calls.filter((x) => x.url.endsWith('/oauth/token')).length, 1);
});

test('revoked Codex login gives recovery instructions and Test step starts fresh device login', async () => {
	for (const code of [
		'refresh_token_expired',
		'refresh_token_reused',
		'refresh_token_invalidated',
		'invalid_grant',
	]) {
		const h = harness();
		h.staticData.codexAuthJson.last_refresh = '2000-01-01T00:00:00Z';
		const request = h.context.helpers.httpRequest;
		h.context.helpers.httpRequest = async (options) =>
			options.url.endsWith('/oauth/token')
				? { statusCode: code === 'invalid_grant' ? 400 : 401, body: { error: { code } } }
				: request(options);
		await assert.rejects(() => h.model(), /click Test step to sign in again/);
		assert.equal(
			h.calls.some((call) => call.url.endsWith('/deviceauth/usercode')),
			false,
		);
		const result = await h.node.execute.call(h.context);
		assert.equal(result[0][0].json.status, 'pending_verification');
		assert.equal(result[0][0].json.user_code, 'TEST-CODE');
		const state = JSON.parse(
			readFileSync(join(stateDir, `.openai-codex-state-test-workflow_${h.id}.json`), 'utf8'),
		);
		assert.equal(state.codexAuthJson, undefined);
		assert.equal(state.codexDeviceAuth.user_code, 'TEST-CODE');
	}
});

test('transient refresh and failed device-login requests never discard the saved login', async () => {
	for (const scenario of ['transient-refresh', 'device-start-fails']) {
		const h = harness();
		h.staticData.codexAuthJson.last_refresh = '2000-01-01T00:00:00Z';
		const request = h.context.helpers.httpRequest;
		h.context.helpers.httpRequest = async (options) => {
			if (options.url.endsWith('/oauth/token'))
				return scenario === 'transient-refresh'
					? { statusCode: 503, body: { error: { message: 'Temporary outage' } } }
					: { statusCode: 401, body: { error: { code: 'refresh_token_invalidated' } } };
			if (options.url.endsWith('/deviceauth/usercode')) return { statusCode: 503, body: {} };
			return request(options);
		};
		await assert.rejects(
			() => h.node.execute.call(h.context),
			/Token refresh failed with status 503|Device-code start failed/,
		);
		assert.equal(h.staticData.codexAuthJson.tokens.refresh_token, 'test-refresh');
	}
});

test('Flex is accepted without catalog advertising and catalog default tiers are honored', async () => {
	for (const parameters of [
		{ model: 'gpt-6-luna' },
		{ model: 'gpt-6.1-sol', serviceTier: 'flex' },
	]) {
		const h = harness({ parameters });
		await (await h.model()).generate(prompt);
		assert.equal(h.requests()[0].body.service_tier, parameters.serviceTier ?? 'priority');
	}
});

test('device authorization exchanges the PKCE code and persists authenticated state', async () => {
	const h = harness({ auth: false });
	await assert.rejects(() => h.model(), /TEST-CODE/);
	const httpRequest = h.context.helpers.httpRequest;
	h.context.helpers.httpRequest = async (options) => {
		if (options.url.endsWith('/deviceauth/token')) {
			h.calls.push(options);
			return {
				statusCode: 200,
				body: { authorization_code: 'test-code', code_verifier: 'test-verifier' },
			};
		}
		if (options.url.endsWith('/oauth/token')) {
			h.calls.push(options);
			assert.equal(options.body.get('grant_type'), 'authorization_code');
			assert.equal(options.body.get('code_verifier'), 'test-verifier');
			assert.equal(options.body.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
			const claims = Buffer.from(
				JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }),
			).toString('base64url');
			return {
				statusCode: 200,
				body: {
					access_token: 'test-new-access',
					refresh_token: 'test-new-refresh',
					id_token: `test.${claims}.test`,
				},
			};
		}
		return httpRequest(options);
	};
	const model = await h.model();
	await model.generate(prompt);
	assert.equal(h.requests()[0].headers.Authorization, 'Bearer test-new-access');
});

const functionCall = (name, args, id = 'call-1') => ({
	type: 'function_call',
	namespace: 'functions',
	call_id: id,
	name,
	arguments: typeof args === 'string' ? args : JSON.stringify(args),
});
const publicTool = { name: tool.name, description: tool.description, schema: tool.inputSchema };
const withoutTracing = (adapter) => {
	adapter.callbacks = [];
	return adapter;
};
const advertisedTools = (request) =>
	request.tools ?? request.input.find((x) => x.type === 'additional_tools')?.tools[0].tools ?? [];

test('public adapter binds and executes the real Calculator schema and preserves its transform', async () => {
	const h = harness({
		responses: [sse([completed([functionCall('calculator', { input: '2+3' })])])],
	});
	const calculator = new Calculator();
	const adapter = withoutTracing((await h.adapter()).bindTools([calculator]));
	const result = await adapter.invoke('Calculate 2+3');
	assert.equal(advertisedTools(h.requests()[0].body)[0].parameters.properties.input.type, 'string');
	assert.deepEqual(result.tool_calls[0].args, { input: '2+3' });
	assert.equal(await calculator.invoke(result.tool_calls[0].args), '5');
});

for (const [version, z] of [
	['3', zod3],
	['4', zod4],
]) {
	test(`public adapter and DynamicStructuredTool round trip foreign Zod ${version} arguments`, async () => {
		const args = { query: 'n8n', limit: 3, enabled: true, filters: { tags: ['codex'] } };
		const schema = z.object({
			query: z.string(),
			limit: z.number().int(),
			enabled: z.boolean(),
			filters: z.object({ tags: z.array(z.string()) }),
		});
		const structured = new DynamicStructuredTool({
			name: 'feed',
			description: 'Search feed',
			schema,
			func: async (value) => JSON.stringify(value),
		});
		const h = harness({
			responses: [
				sse([completed([functionCall('feed', args)])]),
				sse([completed([assistant('Done')])]),
			],
		});
		const adapter = withoutTracing((await h.adapter()).bindTools([structured]));
		const result = await adapter.invoke('Search');
		assert.deepEqual(result.tool_calls[0].args, args);
		const output = await structured.invoke(result.tool_calls[0].args);
		await adapter.invoke([
			new HumanMessage('Search'),
			result,
			new ToolMessage({ content: output, tool_call_id: 'call-1' }),
		]);
		assert.equal(h.requests()[1].body.input.at(-1).output, JSON.stringify(args));
	});
}

test('public streaming preserves two independent calls, reasoning, usage and replay metadata', async () => {
	const calls = [
		functionCall(tool.name, { id: '1' }, 'one'),
		functionCall(tool.name, { id: '2' }, 'two'),
	];
	const h = harness({
		responses: [
			sse([
				{ type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
				{ type: 'response.output_text.delta', output_index: 1, delta: 'Checking' },
				completed(
					[
						{ type: 'reasoning', summary: [], encrypted_content: 'opaque' },
						assistant('Checking', 'commentary'),
						...calls,
					],
					{ usage: { input_tokens: 10, output_tokens: 4 } },
				),
			]),
		],
	});
	const adapter = withoutTracing((await h.adapter()).bindTools([publicTool]));
	let result;
	for await (const chunk of await adapter.stream('Check both'))
		result = result ? result.concat(chunk) : chunk;
	assert.deepEqual(
		result.tool_calls.map(({ id, args }) => ({ id, args })),
		[
			{ id: 'one', args: { id: '1' } },
			{ id: 'two', args: { id: '2' } },
		],
	);
	assert.equal(result.usage_metadata.total_tokens, 14);
	assert.ok(result.content.some((x) => x.type === 'reasoning' && x.reasoning === 'Thinking'));
	assert.ok(
		result.response_metadata.codexReplay.some(
			(x) => x.value.codexReasoningItem?.encrypted_content === 'opaque',
		),
	);
	assert.equal(
		result.content.some((x) => x.type === 'non_standard'),
		false,
	);
	await adapter.invoke([
		new HumanMessage('Check both'),
		result,
		new ToolMessage({ tool_call_id: 'one', content: 'Found one' }),
		new ToolMessage({ tool_call_id: 'two', content: 'Found two' }),
	]);
	const replay = h.requests()[1].body.input;
	assert.equal(replay.filter((x) => x.type === 'function_call').length, 2);
	assert.equal(replay.filter((x) => x.type === 'reasoning')[0].encrypted_content, 'opaque');
	assert.equal(replay.filter((x) => x.role === 'assistant')[0].phase, 'commentary');
});

for (const definition of [
	publicTool,
	{ name: tool.name, parameters: tool.inputSchema },
	{ type: 'function', function: { name: tool.name, parameters: tool.inputSchema } },
	{ type: 'function', name: tool.name, parameters: tool.inputSchema },
]) {
	test(`public binding accepts function definition ${JSON.stringify(Object.keys(definition))}`, async () => {
		const h = harness({ responses: [sse([completed([functionCall(tool.name, { id: '42' })])])] });
		const adapter = withoutTracing(
			(await h.adapter()).bindTools([definition], {
				tool_choice: tool.name,
				parallel_tool_calls: false,
			}),
		);
		await adapter.invoke('Lookup');
		assert.equal(h.requests()[0].body.tool_choice, 'required');
		assert.equal(h.requests()[0].body.parallel_tool_calls, false);
	});
}

for (const method of ['functionCalling', 'jsonSchema', 'jsonMode']) {
	test(`public structured output ${method} parses and validates foreign Zod`, async () => {
		const args = { count: 2, enabled: true };
		const h = harness({
			responses: [
				sse([
					completed([
						method === 'functionCalling'
							? functionCall('extract', args)
							: assistant(JSON.stringify(args)),
					]),
				]),
			],
		});
		const adapter = await h.adapter();
		const runnable = adapter.withStructuredOutput(
			zod4.object({ count: zod4.number().int(), enabled: zod4.boolean() }),
			{ method },
		);
		// The bound model has its own normal n8n callbacks; stub the tracing API below.
		assert.deepEqual(await runnable.invoke('Extract'), args);
		if (method !== 'functionCalling')
			assert.equal(
				h.requests()[0].body.text.format.type,
				method === 'jsonMode' ? 'json_object' : 'json_schema',
			);
	});
}

test('public image and tool-result media blocks reach the backend intact', async () => {
	const h = harness();
	const adapter = await h.adapter();
	await adapter.invoke([
		new HumanMessage({
			content: [{ type: 'image_url', image_url: { url: 'https://example.com/input.png' } }],
		}),
		new AIMessage({
			content: '',
			tool_calls: [{ id: 'image-call', name: 'screenshot', args: {} }],
		}),
		new ToolMessage({
			tool_call_id: 'image-call',
			content: [
				{ type: 'text', text: 'Screenshot' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } },
			],
		}),
	]);
	assert.deepEqual(h.requests()[0].body.input.find((x) => x.role === 'user').content, [
		{ type: 'input_image', image_url: 'https://example.com/input.png' },
	]);
	assert.deepEqual(h.requests()[0].body.input.at(-1).output, [
		{ type: 'input_text', text: 'Screenshot' },
		{ type: 'input_image', image_url: 'data:image/png;base64,YWJj' },
	]);
});

for (const args of ['{broken', '[]', 'null', '"text"']) {
	test(`invalid arguments ${args} never reach the public tool-call stream`, async () => {
		const h = harness({ responses: [sse([completed([functionCall(tool.name, args)])])] });
		const adapter = withoutTracing((await h.adapter()).bindTools([publicTool]));
		let releasedCalls = 0;
		await assert.rejects(async () => {
			for await (const chunk of await adapter.stream('Lookup'))
				releasedCalls += chunk.tool_calls?.length ?? 0;
		}, /malformed arguments/);
		assert.equal(releasedCalls, 0);
	});
}

test('failed terminal event never releases executable tool calls', async () => {
	const item = functionCall(tool.name, { id: '1' });
	const h = harness({
		responses: [
			sse([
				{ type: 'response.output_item.added', item },
				{ type: 'response.output_item.done', item },
				{ type: 'response.failed', response: { error: { message: 'failed turn' } } },
			]),
		],
	});
	const adapter = withoutTracing((await h.adapter()).bindTools([publicTool]));
	let calls = 0;
	await assert.rejects(async () => {
		for await (const chunk of await adapter.stream('Lookup'))
			calls += chunk.tool_calls?.length ?? 0;
	}, /failed turn/);
	assert.equal(calls, 0);
});

test('unbound, duplicate, and unnamed returned tool calls are rejected', async () => {
	for (const output of [
		[functionCall('unknown', {})],
		[functionCall(tool.name, {}), functionCall(tool.name, {})],
		[{ type: 'function_call', arguments: '{}' }],
	]) {
		const h = harness({ responses: [sse([completed(output)])] });
		await assert.rejects(
			() => (async () => (await h.model()).withTools([tool]).generate(prompt))(),
			/unbound tool|duplicate tool call|without its ID/,
		);
	}
});

test('duplicate bindings and provider tools fail explicitly', async () => {
	const adapter = await harness().adapter();
	assert.throws(() => adapter.bindTools([publicTool, publicTool]), /Duplicate tool/);
	assert.throws(
		() => adapter.bindTools([{ type: 'web_search', name: 'web_search' }]),
		/Provider tool/,
	);
});

test('invocation cancellation reaches the HTTP helper and pre-aborted calls never dispatch', async () => {
	const h = harness();
	const adapter = await h.adapter();
	const controller = new AbortController();
	await adapter.invoke('Hello', { signal: controller.signal });
	assert.equal(h.requests()[0].abortSignal, controller.signal);
	controller.abort(new Error('Cancelled by test'));
	await assert.rejects(() => adapter.invoke('Hello', { signal: controller.signal }), /Cancelled/);
	assert.equal(h.requests().length, 1);
});

test('completed output fallback preserves nonconsecutive stream indices without duplicating text', async () => {
	const h = harness({
		responses: [
			sse([
				{ type: 'response.output_text.delta', output_index: 3, delta: 'Hi' },
				{ type: 'response.output_item.done', output_index: 3, item: assistant('Hi') },
				completed([]),
			]),
		],
	});
	const result = await (await h.adapter()).invoke('Hello');
	assert.equal(result.text, 'Hi');
});

test('nearby model names are not accepted as dated snapshots', async () => {
	const h = harness({ responses: [sse([completed([], { model: 'gpt-5.5-unrequested' })])] });
	await assert.rejects(() => (async () => (await h.model()).generate(prompt))(), /Model mismatch/);
});

test('MCP-style schemas inline local JSON references without losing argument constraints', async () => {
	const h = harness();
	const schema = {
		type: 'object',
		properties: { filters: { $ref: '#/$defs/Filters' }, other: { $ref: '#/$defs/Filters' } },
		required: ['filters'],
		$defs: {
			Filters: {
				type: 'object',
				properties: { limit: { type: 'integer', minimum: 1 } },
				required: ['limit'],
			},
		},
	};
	await withoutTracing((await h.adapter()).bindTools([{ name: 'mcp_query', schema }])).invoke(
		'Query',
	);
	const parameters = advertisedTools(h.requests()[0].body)[0].parameters;
	assert.deepEqual(parameters.properties.filters, schema.$defs.Filters);
	assert.deepEqual(parameters.properties.other, schema.$defs.Filters);
	assert.equal(JSON.stringify(parameters).includes('$ref'), false);
});

for (const [version, z] of [
	['3', zod3],
	['4', zod4],
]) {
	test(`object discriminated unions remain structured in Zod ${version}`, async () => {
		const h = harness();
		const schema = z.discriminatedUnion('action', [
			z.object({ action: z.literal('search'), query: z.string() }),
			z.object({ action: z.literal('fetch'), id: z.number().int() }),
		]);
		await withoutTracing((await h.adapter()).bindTools([{ name: 'dispatch', schema }])).invoke(
			'Query',
		);
		const parameters = advertisedTools(h.requests()[0].body)[0].parameters;
		assert.equal(parameters.type, 'object');
		assert.equal(parameters.anyOf[0].properties.query.type, 'string');
		assert.equal(parameters.anyOf[1].properties.id.type, 'integer');
	});
}

test('simultaneous 401s reuse a rotated refresh token instead of refreshing it twice', async () => {
	const h = harness();
	const model = await h.model();
	const original = h.context.helpers.httpRequest;
	let attempts = 0;
	let release;
	const barrier = new Promise((resolve) => {
		release = resolve;
	});
	h.context.helpers.httpRequest = async (options) => {
		if (
			options.url.endsWith('/responses') &&
			options.headers.Authorization === 'Bearer test-access'
		) {
			attempts++;
			if (attempts === 2) release();
			await barrier;
			return {
				statusCode: 401,
				headers: {},
				body: Readable.from(['{"error":{"message":"expired"}}']),
			};
		}
		return original(options);
	};
	await Promise.all([model.generate(prompt), model.generate(prompt)]);
	assert.equal(attempts, 2);
	assert.equal(h.calls.filter((call) => call.url.endsWith('/oauth/token')).length, 1);
	assert.equal(h.requests().length, 2);
	assert.ok(h.requests().every((call) => call.headers.Authorization === 'Bearer test-new-access'));
});

test('simultaneous supply requests refresh stale auth once', async () => {
	const h = harness();
	h.staticData.codexAuthJson.last_refresh = '2020-01-01T00:00:00Z';
	await Promise.all([h.model(), h.model(), h.model()]);
	assert.equal(h.calls.filter((call) => call.url.endsWith('/oauth/token')).length, 1);
});

test('malformed refresh responses cannot mark stale credentials as refreshed', async () => {
	const h = harness({ refresh: { access_token: '' } });
	h.staticData.codexAuthJson.last_refresh = '2020-01-01T00:00:00Z';
	await assert.rejects(() => h.model(), /missing an access token/);
	assert.equal(h.staticData.codexAuthJson.tokens.access_token, 'test-access');
	assert.equal(h.staticData.codexAuthJson.last_refresh, '2020-01-01T00:00:00Z');
});

test('errors omit prompt payloads from diagnostics by default', async () => {
	const h = harness({
		responses: [{ statusCode: 400, body: { error: { message: 'Invalid request' } } }],
	});
	await assert.rejects(
		() =>
			(async () =>
				(await h.model()).generate([
					{ role: 'user', content: [{ type: 'text', text: 'private-customer-data' }] },
				]))(),
		(error) =>
			!error.message.includes('private-customer-data') && error.message.includes('Invalid request'),
	);
});

test('native structured output includes strictness, and includeRaw retains parse failures', async () => {
	const h = harness({ responses: [sse([completed([assistant('{"count":"bad"}')])])] });
	const result = await (
		await h.adapter()
	)
		.withStructuredOutput(zod3.object({ count: zod3.number() }), {
			method: 'jsonSchema',
			strict: true,
			includeRaw: true,
		})
		.invoke('Extract');
	assert.equal(result.parsed, null);
	assert.ok(result.parsing_error);
	assert.ok(result.raw);
	assert.equal(h.requests()[0].body.text.format.strict, true);
});

test('function structured output preserves strict tool configuration', async () => {
	const h = harness({ responses: [sse([completed([functionCall('extract', { count: 2 })])])] });
	await (await h.adapter())
		.withStructuredOutput(zod3.object({ count: zod3.number() }), { strict: true })
		.invoke('Extract');
	assert.equal(advertisedTools(h.requests()[0].body)[0].strict, true);
});

test('rebinding tools replaces the old list and retains forced options used by n8n Agents', async () => {
	const h = harness({ responses: [sse([completed([functionCall(tool.name, { id: '1' })])])] });
	const initial = (await h.adapter()).bindTools([publicTool], { tool_choice: 'any' });
	const rebound = withoutTracing(initial.bindTools([publicTool]));
	await rebound.invoke('Lookup');
	assert.equal(advertisedTools(h.requests()[0].body).length, 1);
	assert.equal(h.requests()[0].body.tool_choice, 'required');
});

test('real tool-calling AgentExecutor completes a Calculator turn and reuses BufferMemory', async () => {
	const { createToolCallingAgent, AgentExecutor } = lcRequire('@langchain/classic/agents');
	const { ChatPromptTemplate } = lcRequire('@langchain/core/prompts');
	const { BufferMemory } = lcRequire('@langchain/classic/memory');
	const h = harness({
		responses: [
			sse([completed([functionCall('calculator', { input: '2+3' })])]),
			sse([completed([assistant('The answer is 5')])]),
			sse([completed([assistant('You calculated 5')])]),
		],
	});
	const tools = [new Calculator()];
	const agentPrompt = ChatPromptTemplate.fromMessages([
		['system', 'Use tools when needed'],
		['placeholder', '{chat_history}'],
		['human', '{input}'],
		['placeholder', '{agent_scratchpad}'],
	]);
	const agent = createToolCallingAgent({
		llm: await h.adapter(),
		tools,
		prompt: agentPrompt,
		streamRunnable: false,
	});
	const executor = new AgentExecutor({
		agent,
		tools,
		memory: new BufferMemory({
			memoryKey: 'chat_history',
			returnMessages: true,
			inputKey: 'input',
			outputKey: 'output',
		}),
	});
	const first = await executor.invoke({ input: 'Calculate 2+3' });
	assert.ok(JSON.stringify(first.output).includes('The answer is 5'));
	assert.equal(
		h.requests()[1].body.input.find((x) => x.type === 'function_call_output').output,
		'5',
	);
	await executor.invoke({ input: 'What did we calculate?' });
	assert.ok(JSON.stringify(h.requests()[2].body.input).includes('The answer is 5'));
	assert.ok(JSON.stringify(h.requests()[2].body.input).includes('Calculate 2+3'));
});

test('MCP embedded text and image results and legacy audio retain their data', async () => {
	const h = harness();
	const adapter = await h.adapter();
	await adapter.invoke([
		new HumanMessage({
			content: [{ type: 'input_audio', input_audio: { data: 'YWJj', format: 'wav' } }],
		}),
		new ToolMessage({
			tool_call_id: 'call-1',
			content: [
				{ type: 'resource', resource: { uri: 'file:///a', text: 'Resource text' } },
				{ type: 'image', mimeType: 'image/png', data: 'YWJj' },
			],
		}),
	]);
	assert.equal(
		h.requests()[0].body.input.find((x) => x.role === 'user').content[0].audio_url,
		'data:audio/wav;base64,YWJj',
	);
	assert.deepEqual(h.requests()[0].body.input.at(-1).output, [
		{ type: 'input_text', text: 'Resource text' },
		{ type: 'input_image', image_url: 'data:image/png;base64,YWJj' },
	]);
});

test('unknown content and unsupported PDF attachments fail instead of disappearing', async () => {
	for (const content of [
		{ type: 'unknown_block', data: 'important' },
		{ type: 'file', mimeType: 'application/pdf', data: 'YWJj' },
	]) {
		const h = harness();
		const adapter = await h.adapter();
		await assert.rejects(
			() => adapter.invoke([new HumanMessage({ content: [content] })]),
			/Unsupported message content|Unsupported media input/,
		);
		assert.equal(h.requests().length, 0);
	}
});

test('rate-limit retries respect maxRetries and never retry after streamed output', async () => {
	const limited = () => ({
		statusCode: 429,
		headers: { 'retry-after': '0' },
		body: Readable.from(['{"error":{"message":"rate limited"}}']),
	});
	const h = harness({ responses: [limited(), sse([completed()])] });
	await (await h.adapter()).invoke('Hi', { maxRetries: 1 });
	assert.equal(h.requests().length, 2);
	const noRetry = harness({ responses: [limited()] });
	await assert.rejects(
		() => (async () => (await noRetry.adapter()).invoke('Hi', { maxRetries: 0 }))(),
		/rate limited/,
	);
	assert.equal(noRetry.requests().length, 1);
	const partial = harness({
		responses: [
			sse([
				{ type: 'response.output_text.delta', delta: 'partial' },
				{ type: 'response.failed', response: { error: { message: 'late failure' } } },
			]),
		],
	});
	await assert.rejects(
		() => (async () => (await partial.adapter()).invoke('Hi'))(),
		/late failure/,
	);
	assert.equal(partial.requests().length, 1);
});

test('n8n execution tracing remains attached through tool binding', async () => {
	const h = harness({
		responses: [
			sse([completed([assistant('Hello')], { usage: { input_tokens: 10, output_tokens: 2 } })]),
		],
	});
	const inputs = [];
	const outputs = [];
	const metadata = [];
	h.context.addInputData = (...args) => {
		inputs.push(args);
		return { index: inputs.length - 1 };
	};
	h.context.addOutputData = (...args) => outputs.push(args);
	h.context.setMetadata = (value) => metadata.push(value);
	h.context.logAiEvent = () => {};
	h.context.logger = { debug: () => {} };
	const adapter = (await h.node.supplyData.call(h.context, 0)).response.bindTools([publicTool]);
	assert.equal(adapter.callbacks[0].name, 'N8nLlmTracing');
	await adapter.invoke('Hello');
	assert.equal(inputs.length, 1);
	assert.equal(outputs.length, 1);
	assert.ok(metadata.some((x) => x.tracing?.['llm.tokens.total'] === 12));
});

test('state migration only removes static credentials after a successful disk write', async (t) => {
	const h = harness();
	const rename = t.mock.method(require('node:fs/promises'), 'rename', async () => {
		throw new Error('Simulated disk failure');
	});
	await assert.rejects(() => h.model(), /Simulated disk failure/);
	assert.equal(h.staticData.codexAuthJson.tokens.access_token, 'test-access');
	rename.mock.restore();
	await h.model();
	assert.equal(h.staticData.codexAuthJson, undefined);
});

test('N8N_USER_FOLDER follows n8n folder semantics and migrates the old state location', async () => {
	const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
	const directory = mkdtempSync(join(tmpdir(), 'codex-home-'));
	const oldStateDir = process.env.N8N_OPENAI_CODEX_STATE_DIR;
	const oldHome = process.env.N8N_USER_FOLDER;
	try {
		delete process.env.N8N_OPENAI_CODEX_STATE_DIR;
		process.env.N8N_USER_FOLDER = directory;
		const h = harness({ auth: false });
		const legacyDirectory = join(directory, 'openai-codex-state');
		mkdirSync(legacyDirectory);
		const filename = `.openai-codex-state-test-workflow_${h.id}.json`;
		writeFileSync(
			join(legacyDirectory, filename),
			JSON.stringify({
				codexAuthJson: {
					tokens: {
						access_token: 'old-access',
						refresh_token: 'old-refresh',
						account_id: 'test-account',
					},
					last_refresh: new Date().toISOString(),
				},
			}),
		);
		await (await h.model()).generate(prompt);
		assert.equal(h.requests()[0].headers.Authorization, 'Bearer old-access');
		assert.ok(existsSync(join(directory, '.n8n', 'openai-codex-state', filename)));
	} finally {
		process.env.N8N_OPENAI_CODEX_STATE_DIR = oldStateDir;
		if (oldHome === undefined) delete process.env.N8N_USER_FOLDER;
		else process.env.N8N_USER_FOLDER = oldHome;
		rmSync(directory, { recursive: true, force: true });
	}
});

test('structured output supports public streaming and keeps tool arguments distinct', async () => {
	const h = harness({ responses: [sse([completed([functionCall('extract', { count: 3 })])])] });
	const runnable = (await h.adapter()).withStructuredOutput(zod4.object({ count: zod4.number() }));
	const chunks = [];
	for await (const chunk of await runnable.stream('Extract')) chunks.push(chunk);
	assert.deepEqual(chunks, [{ count: 3 }]);
});

test('external and recursive JSON Schema references fail before inference', async () => {
	for (const schema of [
		{ type: 'object', properties: { a: { $ref: 'https://example.com/schema' } } },
		{
			type: 'object',
			properties: { a: { $ref: '#/$defs/A' } },
			$defs: { A: { type: 'object', properties: { next: { $ref: '#/$defs/A' } } } },
		},
	]) {
		const h = harness();
		const adapter = await h.adapter();
		assert.throws(
			() => adapter.bindTools([{ name: 'invalid', schema }]),
			/local JSON Schema references|Recursive JSON Schema reference/,
		);
		assert.equal(h.requests().length, 0);
	}
});

test('binding strict tools and nested OpenAI JSON response formats preserves their options', async () => {
	const h = harness({ responses: [sse([completed([assistant('{"id":"42"}')])])] });
	const adapter = withoutTracing(
		(await h.adapter()).bindTools(
			[{ ...publicTool, schema: { ...tool.inputSchema, additionalProperties: false } }],
			{ strict: true },
		),
	);
	await adapter.invoke('Hello', {
		response_format: {
			type: 'json_schema',
			json_schema: {
				name: 'answer',
				strict: true,
				schema: { ...tool.inputSchema, additionalProperties: false },
			},
		},
	});
	assert.equal(advertisedTools(h.requests()[0].body)[0].strict, true);
	assert.deepEqual(h.requests()[0].body.text.format, {
		type: 'json_schema',
		name: 'answer',
		strict: true,
		schema: { ...tool.inputSchema, additionalProperties: false },
	});
});

test('open JSON object tool schemas preserve additional arguments instead of becoming zero-argument tools', async () => {
	const h = harness();
	await withoutTracing(
		(await h.adapter()).bindTools([{ name: 'freeform', parameters: { type: 'object' } }]),
	).invoke('Hi');
	const parameters = advertisedTools(h.requests()[0].body)[0].parameters;
	assert.equal(parameters.additionalProperties, undefined);
	assert.deepEqual(parameters.properties, {});
});

test('prompt chains interoperate with text and structured LangChain output parsers', async () => {
	const { ChatPromptTemplate } = lcRequire('@langchain/core/prompts');
	const { StringOutputParser, StructuredOutputParser } = lcRequire(
		'@langchain/core/output_parsers',
	);
	const h = harness({
		responses: [
			sse([completed([assistant('Plain answer')])]),
			sse([completed([assistant('{"count":4,"enabled":true}')])]),
		],
	});
	const chainPrompt = ChatPromptTemplate.fromMessages([
		['system', 'Follow workflow rules'],
		['human', '{question}'],
	]);
	const adapter = await h.adapter();
	const textChain = chainPrompt.pipe(adapter).pipe(new StringOutputParser());
	assert.equal(await textChain.invoke({ question: 'Answer plainly' }), 'Plain answer');
	const parser = StructuredOutputParser.fromZodSchema(
		zod4.object({ count: zod4.number(), enabled: zod4.boolean() }),
	);
	const structuredChain = chainPrompt.pipe(adapter).pipe(parser);
	assert.deepEqual(await structuredChain.invoke({ question: 'Return JSON' }), {
		count: 4,
		enabled: true,
	});
	assert.ok(
		h
			.requests()
			.every((request) =>
				request.body.input.some(
					(item) => item.role === 'developer' && item.content[0].text === 'Follow workflow rules',
				),
			),
	);
});

const strictSchema = {
	type: 'object',
	properties: {
		answer: { type: 'string' },
		count: { type: 'integer', minimum: 0 },
		details: { type: ['string', 'null'] },
	},
	required: ['answer', 'count', 'details'],
	additionalProperties: false,
};
const strictValue = { answer: 'Done', count: 2, details: null };
const strictParameters = {
	responseFormat: 'jsonSchema',
	outputSchemaName: 'answer_schema',
	outputSchema: JSON.stringify(strictSchema),
};
const agentFormatter = (schema = strictSchema) => ({
	name: 'format_final_json_response',
	description: 'Format the final answer',
	schema: zod3.object({
		output:
			schema === strictSchema
				? zod3.object({
						answer: zod3.string(),
						count: zod3.number().int().min(0),
						details: zod3.string().nullable(),
					})
				: schema,
	}),
});

for (const model of ['gpt-6.1-sol', 'gpt-5.5']) {
	test(`native strict UI format sends text.format and validates final JSON for ${model}`, async () => {
		const h = harness({
			parameters: { ...strictParameters, model },
			responses: [sse([completed([assistant(JSON.stringify(strictValue))])])],
		});
		const result = await (await h.adapter()).invoke('Return an answer');
		assert.deepEqual(JSON.parse(result.text), strictValue);
		assert.deepEqual(h.requests()[0].body.text.format, {
			type: 'json_schema',
			name: 'answer_schema',
			strict: true,
			schema: strictSchema,
		});
		assert.equal(h.requests()[0].body.text.format.type, 'json_schema');
	});
}

test('agent parser mode uses n8n formatter schema with native strict final text and tool arguments', async () => {
	const args = { output: strictValue };
	const h = harness({
		parameters: { responseFormat: 'agentOutputParser' },
		responses: [sse([completed([functionCall('format_final_json_response', args)])])],
	});
	const adapter = withoutTracing((await h.adapter()).bindTools([publicTool, agentFormatter()]));
	const result = await adapter.invoke('Answer');
	assert.deepEqual(result.tool_calls[0].args, args);
	const request = h.requests()[0].body;
	const formatter = advertisedTools(request).find(
		(tool) => tool.name === 'format_final_json_response',
	);
	assert.equal(formatter.strict, true);
	assert.equal(request.text.format.strict, true);
	assert.deepEqual(request.text.format.schema, formatter.parameters);
	assert.equal(formatter.parameters.properties.output.properties.count.type, 'integer');
	assert.equal(formatter.parameters.properties.output.additionalProperties, false);
	assert.equal(request.parallel_tool_calls, false);
	assert.equal(
		advertisedTools(request).find((tool) => tool.name === publicTool.name).strict,
		false,
	);
});

test('agent parser mode keeps regular tool turns and validates the final JSON fallback', async () => {
	const args = { output: strictValue };
	const h = harness({
		parameters: { responseFormat: 'agentOutputParser' },
		responses: [
			sse([completed([functionCall(publicTool.name, { id: '42' })])]),
			sse([completed([assistant(JSON.stringify(args))])]),
		],
	});
	const adapter = withoutTracing((await h.adapter()).bindTools([publicTool, agentFormatter()]));
	const first = await adapter.invoke('Lookup then answer');
	assert.equal(first.tool_calls[0].name, publicTool.name);
	const final = await adapter.invoke([
		new HumanMessage('Lookup then answer'),
		first,
		new ToolMessage({ tool_call_id: 'call-1', content: 'Found' }),
	]);
	assert.deepEqual(JSON.parse(final.text), args);
	assert.equal(h.requests().length, 2);
});

test('agent parser mode without a formatter fails before dispatch instead of using prompt-only formatting', async () => {
	const h = harness({ parameters: { responseFormat: 'agentOutputParser' } });
	await assert.rejects(
		() => (async () => (await h.adapter()).invoke('Answer'))(),
		/requires an AI Agent/,
	);
	assert.equal(h.requests().length, 0);
});

test('unsupported strict schemas fail before inference without changing ordinary tool schemas', async () => {
	for (const schema of [
		{ type: 'object', properties: { optional: { type: 'string' } } },
		{ type: 'object', properties: {}, additionalProperties: true },
		{ type: 'object', properties: {}, allOf: [{ type: 'object' }] },
		{
			type: 'object',
			properties: { a: { type: 'array', items: [{ type: 'string' }] } },
			required: ['a'],
		},
		{ type: 'array', items: { type: 'string' } },
	]) {
		const h = harness({ parameters: { ...strictParameters, outputSchema: schema } });
		await assert.rejects(
			() => h.model(),
			/required|Free-form|Unsupported strict-schema keyword|Tuple|object at the root/,
		);
		assert.equal(h.requests().length, 0);
	}
	const normal = harness();
	await withoutTracing(
		(await normal.adapter()).bindTools([
			{ name: 'optional', schema: zod4.object({ value: zod4.string().optional() }) },
		]),
	).invoke('Hi');
	assert.equal(
		advertisedTools(normal.requests()[0].body)[0].parameters.required?.includes('value') ?? false,
		false,
	);
});

for (const [label, value] of [
	['wrong type', { ...strictValue, count: '2' }],
	['missing field', { answer: 'Done', count: 2 }],
	['extra field', { ...strictValue, extra: true }],
	['constraint violation', { ...strictValue, count: -1 }],
]) {
	test(`native strict mode rejects ${label} in completed responses`, async () => {
		const h = harness({
			parameters: strictParameters,
			responses: [sse([completed([assistant(JSON.stringify(value))])])],
		});
		await assert.rejects(
			() => (async () => (await h.adapter()).invoke('Answer'))(),
			/does not match strict schema/,
		);
	});
}

test('strict mode buffers partial output until terminal JSON validation succeeds', async () => {
	const text = JSON.stringify(strictValue);
	const h = harness({
		parameters: strictParameters,
		responses: [
			sse([
				{ type: 'response.output_text.delta', output_index: 0, delta: text.slice(0, 12) },
				{ type: 'response.output_text.delta', output_index: 0, delta: text.slice(12) },
				completed([assistant(text)]),
			]),
		],
	});
	let combined;
	for await (const chunk of await (await h.adapter()).stream('Answer'))
		combined = combined ? combined.concat(chunk) : chunk;
	assert.deepEqual(JSON.parse(combined.text), strictValue);
	const bad = harness({
		parameters: strictParameters,
		responses: [
			sse([
				{ type: 'response.output_text.delta', delta: '{"count":"wrong"}' },
				completed([assistant('{"count":"wrong"}')]),
			]),
		],
	});
	let releasedText = '';
	await assert.rejects(async () => {
		for await (const chunk of await (await bad.adapter()).stream('Answer'))
			releasedText += chunk.text;
	}, /does not match strict schema/);
	assert.equal(releasedText, '');
});

for (const [label, response, pattern] of [
	[
		'refusal',
		completed([
			{
				type: 'message',
				role: 'assistant',
				content: [{ type: 'refusal', refusal: 'Cannot comply' }],
			},
		]),
		/refused/,
	],
	['invalid JSON', completed([assistant('not JSON')]), /invalid JSON/],
	[
		'incomplete response',
		{
			type: 'response.incomplete',
			response: { incomplete_details: { reason: 'max_output_tokens' } },
		},
		/incomplete/,
	],
]) {
	test(`native strict mode reports ${label} explicitly`, async () => {
		const h = harness({ parameters: strictParameters, responses: [sse([response])] });
		await assert.rejects(() => (async () => (await h.adapter()).invoke('Answer'))(), pattern);
	});
}

test('invalid strict formatter arguments are never released to the Agent', async () => {
	const h = harness({
		parameters: { responseFormat: 'agentOutputParser' },
		responses: [
			sse([
				completed([
					functionCall('format_final_json_response', { output: { ...strictValue, count: 'bad' } }),
				]),
			]),
		],
	});
	const adapter = withoutTracing((await h.adapter()).bindTools([agentFormatter()]));
	await assert.rejects(() => adapter.invoke('Answer'), /does not match strict schema/);
});

test('native output settings are opt-in and JSON schema method is strict by default', async () => {
	const normal = harness();
	await (await normal.adapter()).invoke('Hello');
	assert.equal(normal.requests()[0].body.text?.format, undefined);
	const h = harness({ responses: [sse([completed([assistant(JSON.stringify(strictValue))])])] });
	assert.deepEqual(
		await (await h.adapter())
			.withStructuredOutput(strictSchema, { method: 'jsonSchema' })
			.invoke('Answer'),
		strictValue,
	);
	assert.equal(h.requests()[0].body.text.format.strict, true);
});

test('version 3 automatically enforces the connected Agent parser and older versions retain text defaults', async () => {
	for (const version of [1, 2, 3]) {
		const h = harness({
			version,
			responses: [
				sse([completed([functionCall('format_final_json_response', { output: strictValue })])]),
			],
		});
		const adapter = withoutTracing((await h.adapter()).bindTools([agentFormatter()]));
		await adapter.invoke('Answer');
		const property = h.node.description.properties.find(
			(p) => p.name === 'responseFormat' && p.displayOptions.show['@version'].includes(version),
		);
		assert.equal(property.default, version >= 3 ? 'auto' : 'text');
		assert.equal(h.requests()[0].body.text?.format?.strict, version >= 3 ? true : undefined);
		assert.equal(adapter.metadata?.output_format, version >= 3 ? 'json' : undefined);
	}
});

test('automatic output uses text without a parser and explicit Text disables automatic enforcement', async () => {
	for (const parameters of [{}, { responseFormat: 'auto' }, { responseFormat: 'text' }]) {
		const h = harness({ version: 3, parameters });
		const adapter = await h.adapter();
		const bound =
			parameters.responseFormat === 'text'
				? withoutTracing(adapter.bindTools([agentFormatter()]))
				: adapter;
		assert.equal((await bound.invoke('Hello')).text, 'Hello');
		assert.equal(h.requests()[0].body.text?.format, undefined);
		assert.equal(bound.metadata?.output_format, undefined);
	}
});

test('automatic mode validates formatter arguments and rejects optional parser fields before dispatch', async () => {
	const invalid = harness({
		version: 3,
		responses: [
			sse([
				completed([
					functionCall('format_final_json_response', { output: { ...strictValue, count: 'bad' } }),
				]),
			]),
		],
	});
	await assert.rejects(
		() =>
			(async () =>
				withoutTracing((await invalid.adapter()).bindTools([agentFormatter()])).invoke('Answer'))(),
		/does not match strict schema/,
	);
	const optional = harness({ version: 3 });
	await assert.rejects(
		() =>
			(async () =>
				withoutTracing(
					(await optional.adapter()).bindTools([
						agentFormatter(zod3.object({ value: zod3.string().optional() })),
					]),
				).invoke('Answer'))(),
		/All properties must be required/,
	);
	assert.equal(optional.requests().length, 0);
});

test('forcing an ordinary tool preserves the Agent output schema for this turn', async () => {
	for (const responseFormat of ['auto', 'agentOutputParser']) {
		const h = harness({
			parameters: { responseFormat },
			responses: [sse([completed([functionCall(publicTool.name, { id: '42' })])])],
		});
		await withoutTracing(
			(await h.adapter()).bindTools([publicTool, agentFormatter()], {
				tool_choice: publicTool.name,
			}),
		).invoke('Lookup');
		const request = h.requests()[0].body;
		assert.equal(request.text.format.strict, true);
		assert.deepEqual(
			advertisedTools(request).map((tool) => tool.name),
			[publicTool.name],
		);
	}
});

test('conflicting explicit and Agent output schemas fail instead of bypassing enforcement through the formatter', async () => {
	const h = harness({ parameters: strictParameters });
	await assert.rejects(
		() =>
			(async () =>
				withoutTracing((await h.adapter()).bindTools([agentFormatter()])).invoke('Answer'))(),
		/Output Schema conflicts/,
	);
	assert.equal(h.requests().length, 0);
});

test('matching explicit and Agent output schemas make formatter arguments strict', async () => {
	const wireSchema = {
		type: 'object',
		properties: { output: strictSchema },
		required: ['output'],
		additionalProperties: false,
	};
	const h = harness({
		parameters: { ...strictParameters, outputSchema: wireSchema },
		responses: [
			sse([completed([functionCall('format_final_json_response', { output: strictValue })])]),
		],
	});
	await withoutTracing((await h.adapter()).bindTools([agentFormatter()])).invoke('Answer');
	assert.equal(advertisedTools(h.requests()[0].body)[0].strict, true);
});

test('malformed programmatic response formats fail before inference', async () => {
	for (const response_format of [
		'json_schema',
		{ type: 'json_schema', strict: 'true', schema: strictSchema },
	]) {
		const h = harness();
		await assert.rejects(
			() => (async () => (await h.adapter()).invoke('Answer', { response_format }))(),
			/must be an object|must be a boolean/,
		);
		assert.equal(h.requests().length, 0);
	}
});

test('strict streaming separates commentary from the final schema and preserves it only for replay', async () => {
	const json = JSON.stringify(strictValue);
	const h = harness({
		parameters: strictParameters,
		responses: [
			sse([
				{ type: 'response.output_text.delta', output_index: 0, delta: 'Working...' },
				{ type: 'response.output_text.delta', output_index: 1, delta: json },
				completed([assistant('Working...', 'commentary'), assistant(json)]),
			]),
		],
	});
	let result;
	for await (const chunk of await (await h.adapter()).stream('Answer'))
		result = result ? result.concat(chunk) : chunk;
	assert.deepEqual(JSON.parse(result.text), strictValue);
	assert.ok(
		result.response_metadata.codexReplay.some(
			(block) => block.value.codexMessageItem?.phase === 'commentary',
		),
	);
});

test('formatter final calls cannot be mixed with unfinished tool actions', async () => {
	const h = harness({
		parameters: { responseFormat: 'agentOutputParser' },
		responses: [
			sse([
				completed([
					functionCall(publicTool.name, { id: '42' }, 'lookup'),
					functionCall('format_final_json_response', { output: strictValue }, 'final'),
				]),
			]),
		],
	});
	const adapter = withoutTracing((await h.adapter()).bindTools([publicTool, agentFormatter()]));
	await assert.rejects(() => adapter.invoke('Answer'), /combined final output formatting/);
});

test('schema configuration errors and optional Agent schemas fail clearly', async () => {
	for (const parameters of [
		{ responseFormat: 'jsonSchema', outputSchema: '{bad' },
		{ ...strictParameters, outputSchemaName: 'invalid name' },
	]) {
		const h = harness({ parameters });
		await assert.rejects(() => h.model(), /valid JSON|Schema Name/);
		assert.equal(h.requests().length, 0);
	}
	const h = harness({ parameters: { responseFormat: 'agentOutputParser' } });
	const adapter = withoutTracing(
		(await h.adapter()).bindTools([
			agentFormatter(zod3.object({ optional: zod3.string().optional() })),
		]),
	);
	await assert.rejects(() => adapter.invoke('Answer'), /All properties must be required/);
	assert.equal(h.requests().length, 0);
});

test('native strict output validates nested arrays, nulls, and supported string formats', async () => {
	const schema = {
		type: 'object',
		properties: {
			people: {
				type: 'array',
				minItems: 1,
				items: {
					type: 'object',
					properties: {
						email: { type: 'string', format: 'email' },
						age: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
					},
					required: ['email', 'age'],
				},
			},
		},
		required: ['people'],
	};
	const value = { people: [{ email: 'person@example.com', age: null }] };
	const h = harness({
		parameters: { ...strictParameters, outputSchema: schema },
		responses: [sse([completed([assistant(JSON.stringify(value))])])],
	});
	await (await h.adapter()).invoke('Answer');
	assert.equal(
		h.requests()[0].body.text.format.schema.properties.people.items.additionalProperties,
		false,
	);
	const invalid = harness({
		parameters: { ...strictParameters, outputSchema: schema },
		responses: [sse([completed([assistant('{"people":[{"email":"invalid","age":-1}]}')])])],
	});
	await assert.rejects(
		() => (async () => (await invalid.adapter()).invoke('Answer'))(),
		/does not match strict schema/,
	);
	const unsupported = harness({
		parameters: {
			...strictParameters,
			outputSchema: {
				type: 'object',
				properties: { link: { type: 'string', format: 'uri' } },
				required: ['link'],
			},
		},
	});
	await assert.rejects(() => unsupported.model(), /Unsupported native string format/);
});

test('native JSON advertises the metadata n8n Basic LLM Chain uses to return parsed objects', async () => {
	const h = harness({
		parameters: strictParameters,
		responses: [sse([completed([assistant(JSON.stringify(strictValue))])])],
	});
	const adapter = await h.adapter();
	assert.equal(adapter.metadata.output_format, 'json');
	const { JsonOutputParser } = lcRequire('@langchain/core/output_parsers');
	assert.deepEqual(await adapter.pipe(new JsonOutputParser()).invoke('Answer'), strictValue);
	assert.equal((await harness().adapter()).metadata?.output_format, undefined);
});

test('strict JSON rejects numeric overflow that n8n cannot serialize faithfully', async () => {
	const schema = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] };
	const h = harness({
		parameters: { ...strictParameters, outputSchema: schema },
		responses: [sse([completed([assistant('{"value":1e999}')])])],
	});
	await assert.rejects(
		() => (async () => (await h.adapter()).invoke('Answer'))(),
		/does not match strict schema/,
	);
});

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync, readFileSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { test, after } = require('node:test');
const { createRequire } = require('node:module');
const sdkRequire = createRequire(require.resolve('@n8n/ai-node-sdk'));
const { fromLcMessage, toLcMessage } = sdkRequire('@n8n/ai-utilities');

const stateDir = mkdtempSync(join(tmpdir(), 'n8n-codex-test-'));
process.env.N8N_OPENAI_CODEX_STATE_DIR = stateDir;
const {
	OpenAiCodexChatModel,
} = require('../dist/nodes/OpenAiCodexChatModel/OpenAiCodexChatModel.node.js');
const catalog = require('../nodes/OpenAiCodexChatModel/fallback-models.json');
after(() => rmSync(stateDir, { recursive: true, force: true }));
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
	remoteModels = catalog.models,
	responses = [sse([completed()])],
	auth = true,
	refresh = {},
} = {}) {
	const id = randomUUID();
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
		requests: () => calls.filter((call) => call.url.endsWith('/responses')),
	};
}

const tool = {
	type: 'function',
	name: 'lookup_order',
	description: 'Find an order',
	inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

test('new models match the current CLI catalog and version 1 keeps its default', async () => {
	for (const version of [1, 2]) {
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
						parameters: { ...tool.inputSchema, additionalProperties: false },
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

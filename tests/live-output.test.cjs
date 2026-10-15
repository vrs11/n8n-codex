const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');
const { Readable } = require('node:stream');
const { test } = require('node:test');

// Explicitly opt in: these tests make real requests using an existing local n8n login.
// Use that login's workflow/node IDs so token rotation is saved back to its original file.
const enabled = process.env.CODEX_TEST_LIVE === 'true';
const models = (process.env.CODEX_LIVE_MODELS || 'gpt-6.1-sol').split(',');

function modules() {
	const sdk = createRequire(require.resolve('@n8n/ai-node-sdk'));
	const lc = createRequire(sdk.resolve('@n8n/ai-utilities'));
	const root = dirname(require.resolve('@n8n/n8n-nodes-langchain/package.json'));
	return { lc, n8nModule: (file) => require(join(root, 'dist', file)) };
}

async function harness(model, parameters = {}, tools = []) {
	const id = process.env.CODEX_LIVE_NODE_ID;
	const workflowId = process.env.CODEX_LIVE_WORKFLOW_ID;
	const stateDir = process.env.N8N_OPENAI_CODEX_STATE_DIR;
	assert.ok(
		id && workflowId && stateDir,
		'Set live workflow/node IDs and the existing state directory',
	);
	const key = `${workflowId}:${id}`.replace(/[^a-zA-Z0-9._-]/g, '_');
	assert.ok(
		existsSync(join(stateDir, `.openai-codex-state-${key}.json`)),
		'Existing login file required',
	);
	const {
		OpenAiCodexChatModel,
	} = require('../dist/nodes/OpenAiCodexChatModel/OpenAiCodexChatModel.node.js');
	const requests = [];
	const staticData = {};
	const settings = { model, ...parameters };
	const context = {
		getNode: () => ({
			id,
			name: 'Codex Live Test',
			type: 'CUSTOM.openAiCodexChatModel',
			typeVersion: 3,
			position: [0, 0],
			parameters: settings,
		}),
		getWorkflow: () => ({ id: workflowId, name: 'Codex Live Test' }),
		getExecutionId: () => 'codex-live-test',
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name, _index, fallback) => settings[name] ?? fallback,
		getInputConnectionData: async (type) => (type === 'ai_tool' ? tools : undefined),
		getExecutionCancelSignal: () => undefined,
		addInputData: () => ({ index: 0 }),
		addOutputData: () => {},
		setMetadata: () => {},
		logAiEvent: () => {},
		logger: { debug: () => {}, warn: () => {} },
		helpers: {
			httpRequest: async (options) => {
				const url = new URL(options.url);
				assert.ok(
					(url.origin === 'https://chatgpt.com' &&
						url.pathname.startsWith('/backend-api/codex/')) ||
						(url.origin === 'https://auth.openai.com' && url.pathname === '/oauth/token'),
					'Unexpected live request destination',
				);
				if (url.pathname.endsWith('/responses')) requests.push(options.body);
				const response = await fetch(url, {
					method: options.method,
					headers: {
						...(options.json && options.body && !(options.body instanceof URLSearchParams)
							? { 'Content-Type': 'application/json' }
							: {}),
						...options.headers,
					},
					body:
						options.body instanceof URLSearchParams
							? options.body
							: options.body
								? JSON.stringify(options.body)
								: undefined,
					signal: AbortSignal.timeout(60_000),
					redirect: 'error',
				});
				return {
					statusCode: response.status,
					headers: Object.fromEntries(response.headers),
					body:
						options.encoding === 'stream' ||
						(options.returnFullResponse && url.pathname.endsWith('/responses'))
							? Readable.fromWeb(response.body)
							: await response.json(),
				};
			},
		},
	};
	const adapter = (await new OpenAiCodexChatModel().supplyData.call(context, 0)).response;
	adapter.callbacks = [];
	return { adapter, context, requests };
}

// Do not let the test runner serialize n8n contexts or request headers on a failure.
async function safeTest(body) {
	try {
		await body();
	} catch (error) {
		throw new Error(String(error.message));
	}
}

for (const model of models) {
	test(
		`live ${model}: native strict JSON through installed n8n Basic LLM Chain`,
		{ skip: !enabled, timeout: 90_000 },
		() =>
			safeTest(async () => {
				const { n8nModule } = modules();
				const schema = {
					type: 'object',
					properties: {
						answer: { type: 'string', enum: ['ready'] },
						count: { type: 'integer', minimum: 2, maximum: 2 },
						note: { type: ['string', 'null'] },
						tags: {
							type: 'array',
							items: { type: 'string', enum: ['ok'] },
							minItems: 1,
							maxItems: 1,
						},
					},
					required: ['answer', 'count', 'note', 'tags'],
					additionalProperties: false,
				};
				const h = await harness(model, { responseFormat: 'jsonSchema', outputSchema: schema });
				const { executeChain } = n8nModule('nodes/chains/ChainLLM/methods/chainExecutor.js');
				const result = await executeChain({
					context: h.context,
					itemIndex: 0,
					query: 'Return answer ready, count 2, note null, tags [ok].',
					llm: h.adapter,
					messages: [],
				});
				assert.deepEqual(result, [{ answer: 'ready', count: 2, note: null, tags: ['ok'] }]);
				assert.equal(h.requests[0].text.format.strict, true);
			}),
	);

	test(
		`live ${model}: automatic parser enforcement after a structured n8n tool call`,
		{ skip: !enabled, timeout: 150_000 },
		() =>
			safeTest(async () => {
				const { lc, n8nModule } = modules();
				const { z } = require('zod');
				const { DynamicStructuredTool } = lc('@langchain/core/tools');
				const { ChatPromptTemplate } = lc('@langchain/core/prompts');
				const { AgentExecutor } = lc('@langchain/classic/agents');
				const { N8nStructuredOutputParser } = n8nModule(
					'utils/output_parsers/N8nStructuredOutputParser.js',
				);
				const { getTools } = n8nModule('nodes/agents/Agent/agents/ToolsAgent/common.js');
				const { createAgentSequence } = n8nModule(
					'nodes/agents/Agent/agents/ToolsAgent/V3/helpers/createAgentSequence.js',
				);
				const secret = randomUUID();
				let executions = 0;
				const lookup = new DynamicStructuredTool({
					name: 'lookup_test_value',
					description:
						'Read-only lookup of a temporary test value. Requires named lookup arguments.',
					schema: z.object({ key: z.string(), count: z.number().int(), enabled: z.boolean() }),
					func: async (args) => {
						assert.deepEqual(args, { key: 'test', count: 2, enabled: true });
						executions++;
						return JSON.stringify({ token: secret, count: 2 });
					},
				});
				const h = await harness(model, {}, [lookup]);
				const parser = await N8nStructuredOutputParser.fromZodJsonSchema(
					z.object({ token: z.string(), count: z.number().int() }),
					1.3,
					h.context,
				);
				const tools = await getTools(h.context, parser);
				const prompt = ChatPromptTemplate.fromMessages([
					[
						'system',
						'Call lookup_test_value with key test, count 2, enabled true. Only after reading its result, return its token and count through format_final_json_response. Never invent the token.',
					],
					['human', '{input}'],
					['placeholder', '{agent_scratchpad}'],
				]);
				const agent = createAgentSequence(h.adapter, tools, prompt, {}, parser);
				const result = await new AgentExecutor({ agent, tools, maxIterations: 4 }).invoke({
					input: 'Look up the test value and return its token and count.',
				});
				assert.ok(executions > 0, 'The real model must execute the structured tool');
				assert.deepEqual(result.output, { token: secret, count: 2 });
				assert.ok(h.requests.length >= 2);
				assert.ok(h.requests.every((request) => request.text.format.strict === true));
			}),
	);
}

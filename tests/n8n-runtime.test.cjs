const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');
const { test, after } = require('node:test');

// Run these tests inside n8n's image: they load its real Agent, Chain and parser implementations.
const enabled = process.env.CODEX_TEST_N8N_RUNTIME === 'true';
const directory = enabled ? mkdtempSync(join(tmpdir(), 'codex-n8n-runtime-')) : undefined;
if (enabled) process.env.N8N_OPENAI_CODEX_STATE_DIR = directory;
after(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

function modules() {
	const sdk = createRequire(require.resolve('@n8n/ai-node-sdk'));
	const lc = createRequire(sdk.resolve('@n8n/ai-utilities'));
	const root = dirname(require.resolve('@n8n/n8n-nodes-langchain/package.json'));
	const n8nModule = (file) => require(join(root, 'dist', file));
	return { lc, n8nModule };
}
const schema = {
	type: 'object',
	properties: { answer: { type: 'string' }, count: { type: 'integer' } },
	required: ['answer', 'count'],
	additionalProperties: false,
};
const value = { answer: '5', count: 1 };
const call = (name, args, id) => ({
	type: 'function_call',
	namespace: 'functions',
	name,
	arguments: JSON.stringify(args),
	call_id: id,
});
const message = (text) => ({
	type: 'message',
	role: 'assistant',
	phase: 'final_answer',
	content: [{ type: 'output_text', text }],
});

async function harness(parameters, outputs, tools = []) {
	const {
		OpenAiCodexChatModel,
	} = require('../dist/nodes/OpenAiCodexChatModel/OpenAiCodexChatModel.node.js');
	const catalog = require('../dist/nodes/OpenAiCodexChatModel/fallback-models.json');
	const requests = [];
	let responseIndex = 0;
	const staticData = {
		codexAuthJson: {
			tokens: {
				access_token: 'test-access',
				refresh_token: 'test-refresh',
				account_id: 'test-account',
			},
			last_refresh: new Date().toISOString(),
		},
	};
	const id = randomUUID();
	const context = {
		getNode: () => ({
			id,
			name: 'Codex',
			type: 'CUSTOM.openAiCodexChatModel',
			typeVersion: 3,
			position: [0, 0],
			parameters,
		}),
		getWorkflow: () => ({ id: 'native-runtime-workflow', name: 'Native Runtime Tests' }),
		getExecutionId: () => 'test-execution',
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name, _index, fallback) => parameters[name] ?? fallback,
		getInputConnectionData: async (type) => (type === 'ai_tool' ? tools : undefined),
		getExecutionCancelSignal: () => undefined,
		addInputData: () => ({ index: 0 }),
		addOutputData: () => {},
		setMetadata: () => {},
		logAiEvent: () => {},
		logger: { debug: () => {}, warn: () => {} },
		helpers: {
			httpRequest: async (options) => {
				if (options.url.includes('/models?'))
					return { statusCode: 200, body: { models: catalog.models } };
				assert.ok(options.url.endsWith('/responses'), options.url);
				requests.push(options.body);
				const output = outputs[responseIndex++];
				assert.ok(output, 'unexpected model turn');
				const event = {
					type: 'response.completed',
					response: { id: `resp-${responseIndex}`, status: 'completed', output },
				};
				return {
					statusCode: 200,
					headers: {},
					body: Readable.from([Buffer.from(`data: ${JSON.stringify(event)}\n\n`)]),
				};
			},
		},
	};
	const adapter = (await new OpenAiCodexChatModel().supplyData.call(context, 0)).response;
	adapter.callbacks = [];
	return { adapter, context, requests };
}

for (const finish of ['formatter', 'text', 'forced-formatter'])
	test(
		`installed n8n Agent automatically enforces its parser after a tool call (${finish})`,
		{ skip: !enabled },
		async () => {
			const { lc, n8nModule } = modules();
			const { Calculator } = lc('@langchain/community/tools/calculator');
			const { ChatPromptTemplate } = lc('@langchain/core/prompts');
			const { AgentExecutor } = lc('@langchain/classic/agents');
			const { z } = require('zod');
			const { N8nStructuredOutputParser } = n8nModule(
				'utils/output_parsers/N8nStructuredOutputParser.js',
			);
			const { getTools } = n8nModule('nodes/agents/Agent/agents/ToolsAgent/common.js');
			const { createAgentSequence } = n8nModule(
				'nodes/agents/Agent/agents/ToolsAgent/V3/helpers/createAgentSequence.js',
			);
			const h = await harness(
				{},
				[
					[call('calculator', { input: '2+3' }, 'calculate')],
					finish === 'text'
						? [message(JSON.stringify({ output: value }))]
						: [call('format_final_json_response', { output: value }, 'final')],
				],
				[new Calculator()],
			);
			const parser = await N8nStructuredOutputParser.fromZodJsonSchema(
				z.object({ answer: z.string(), count: z.number().int() }),
				1.3,
				h.context,
			);
			const tools = await getTools(h.context, parser);
			const prompt = ChatPromptTemplate.fromMessages([
				['system', 'Calculate and use format_final_json_response to finish.'],
				['human', '{input}'],
				['placeholder', '{agent_scratchpad}'],
			]);
			const agent = createAgentSequence(
				h.adapter,
				tools,
				prompt,
				{},
				parser,
				undefined,
				undefined,
				finish === 'forced-formatter',
			);
			const result = await new AgentExecutor({ agent, tools, maxIterations: 3 }).invoke({
				input: 'Calculate 2+3',
			});
			assert.deepEqual(result.output, value);
			assert.equal(h.requests.length, 2);
			assert.ok(h.requests.every((request) => request.text.format.strict === true));
			assert.equal(
				h.requests[1].input.find((item) => item.type === 'function_call_output').output,
				'5',
			);
		},
	);

test(
	'installed n8n Basic LLM Chain returns parsed native JSON without a separate parser',
	{ skip: !enabled },
	async () => {
		const { n8nModule } = modules();
		const { executeChain } = n8nModule('nodes/chains/ChainLLM/methods/chainExecutor.js');
		const h = await harness({ responseFormat: 'jsonSchema', outputSchema: schema }, [
			[message(JSON.stringify(value))],
		]);
		const result = await executeChain({
			context: h.context,
			itemIndex: 0,
			query: 'Answer',
			llm: h.adapter,
			messages: [],
		});
		assert.deepEqual(result, [value]);
		assert.equal(h.requests[0].text.format.strict, true);
	},
);

test(
	'installed n8n Basic LLM Chain can retain its parser using the explicit output wrapper schema',
	{ skip: !enabled },
	async () => {
		const { n8nModule } = modules();
		const { z } = require('zod');
		const { executeChain } = n8nModule('nodes/chains/ChainLLM/methods/chainExecutor.js');
		const { N8nStructuredOutputParser } = n8nModule(
			'utils/output_parsers/N8nStructuredOutputParser.js',
		);
		const wireSchema = {
			type: 'object',
			properties: { output: schema },
			required: ['output'],
			additionalProperties: false,
		};
		const h = await harness({ responseFormat: 'jsonSchema', outputSchema: wireSchema }, [
			[message(JSON.stringify({ output: value }))],
		]);
		const parser = await N8nStructuredOutputParser.fromZodJsonSchema(
			z.object({ answer: z.string(), count: z.number().int() }),
			1.3,
			h.context,
		);
		const result = await executeChain({
			context: h.context,
			itemIndex: 0,
			query: 'Answer',
			llm: h.adapter,
			messages: [],
			outputParser: parser,
		});
		assert.deepEqual(result, [{ output: value }]);
	},
);

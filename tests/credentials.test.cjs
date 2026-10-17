const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const {
	CodexAccountProvider,
	prepareCredential,
	authenticateCredential,
	CODEX_CREDENTIAL_TYPE,
	CODEX_MODELS_URL,
	assertLocalAuthentication,
} = require('../dist/nodes/OpenAiCodexChatModel/codex-credentials.js');
const {
	OpenAiCodexAccountApi,
} = require('../dist/credentials/OpenAiCodexAccountApi.credentials.js');
const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const tokens = (expired = false) => ({
	access_token: jwt({
		exp: Date.now() / 1000 + (expired ? -100 : 3600),
		iat: Date.now() / 1000 - 100,
		nonce: randomUUID(),
	}),
	refresh_token: `refresh-${randomUUID()}`,
	account_id: 'account',
	token_type: 'Bearer',
});
function harness(expired = false, refresh) {
	let data = {
		authInitialized: '',
		clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
		grantType: 'pkce',
		accessTokenUrl: 'https://auth.openai.com/oauth/token',
		oauthTokenData: tokens(expired),
	};
	let exchanges = 0;
	const calls = [];
	const context = {
		getNode: () => ({ credentials: { [CODEX_CREDENTIAL_TYPE]: { id: id, name: 'Test' } } }),
		getCredentials: async () => structuredClone(data),
		helpers: {
			httpRequest: async (options) => {
				calls.push(options);
				return { statusCode: 200, body: { models: [] } };
			},
			refreshOAuth2Token: async () => {
				exchanges++;
				if (refresh)
					return await refresh({
						get data() {
							return data;
						},
						set data(value) {
							data = value;
						},
					});
				await new Promise((r) => setTimeout(r, 10));
				data.oauthTokenData = tokens();
			},
		},
	};
	const id = randomUUID();
	return {
		context,
		calls,
		get data() {
			return data;
		},
		set data(value) {
			data = value;
		},
		get exchanges() {
			return exchanges;
		},
		provider: () => new CodexAccountProvider(context),
	};
}
test('100 concurrent uses across nodes with a valid credential do not refresh', async () => {
	const h = harness();
	const result = await Promise.all(Array.from({ length: 100 }, () => h.provider().current()));
	assert.equal(h.exchanges, 0);
	assert.equal(new Set(result.map((x) => x.accessToken)).size, 1);
});
test('100 expired-token users share one refresh through completed persistence', async () => {
	const h = harness(true);
	const result = await Promise.all(Array.from({ length: 100 }, () => h.provider().current()));
	assert.equal(h.exchanges, 1);
	assert.ok(result.every((x) => x.accessToken === h.data.oauthTokenData.access_token));
});
test('callers cannot use an access token before persistence completes', async () => {
	let release;
	let started;
	const entered = new Promise((r) => (started = r));
	const persisted = new Promise((r) => (release = r));
	const h = harness(true, async (store) => {
		started();
		await persisted;
		store.data = { ...store.data, oauthTokenData: tokens() };
	});
	let returned = 0;
	const tasks = Array.from({ length: 10 }, () =>
		h
			.provider()
			.current()
			.then(() => returned++),
	);
	await entered;
	assert.equal(returned, 0);
	release();
	await Promise.all(tasks);
	assert.equal(returned, 10);
	assert.equal(h.exchanges, 1);
});
test('failed persistence blocks inference and shares a sanitized failure cooldown', async () => {
	const h = harness(true, async () => {
		throw new Error('SECRET refresh-token');
	});
	const results = await Promise.allSettled(
		Array.from({ length: 30 }, () => h.provider().request({ url: CODEX_MODELS_URL })),
	);
	assert.equal(h.exchanges, 1);
	assert.equal(h.calls.length, 0);
	assert.ok(results.every((x) => x.status === 'rejected' && !x.reason.message.includes('SECRET')));
});
test('native helper returning without committing tokens is rejected', async () => {
	const h = harness(true, async () => tokens());
	await assert.rejects(h.provider().current(), /persist/);
	assert.equal(h.exchanges, 1);
});
test('delayed 401s reuse the newly persisted token rather than refresh again', async () => {
	const h = harness();
	const old = h.data.oauthTokenData.access_token;
	let oldCalls = 0;
	h.context.helpers.httpRequest = async (options) => {
		if (options.headers.Authorization === `Bearer ${old}`) {
			oldCalls++;
			await new Promise((r) => setTimeout(r, oldCalls === 1 ? 0 : 30));
			return { statusCode: 401, body: {} };
		}
		return { statusCode: 200, body: {} };
	};
	const results = await Promise.all(
		Array.from({ length: 20 }, () => h.provider().request({ url: CODEX_MODELS_URL })),
	);
	assert.ok(results.every((r) => r.statusCode === 200));
	assert.equal(h.exchanges, 1);
});
test('second 401 stops after one refresh and requires reconnect', async () => {
	const h = harness();
	h.context.helpers.httpRequest = async () => ({ statusCode: 401, body: {} });
	await assert.rejects(h.provider().request({ url: CODEX_MODELS_URL }), /Reconnect/);
	await assert.rejects(h.provider().current(), /Reconnect/);
	assert.equal(h.exchanges, 1);
});
test('independent credentials refresh independently', async () => {
	const a = harness(true),
		b = harness(true);
	await Promise.all([a.provider().current(), b.provider().current()]);
	assert.equal(a.exchanges, 1);
	assert.equal(b.exchanges, 1);
});
test('cancelled waiter does not cancel a refresh already being persisted', async () => {
	let release, started;
	const entered = new Promise((r) => (started = r)),
		pending = new Promise((r) => (release = r));
	const h = harness(true, async (store) => {
		started();
		await pending;
		store.data = { ...store.data, oauthTokenData: tokens() };
	});
	const controller = new AbortController();
	const first = h.provider().current(controller.signal);
	await entered;
	controller.abort(new Error('cancelled'));
	await assert.rejects(first, /cancelled/);
	release();
	await h.provider().current();
	assert.equal(h.exchanges, 1);
});
test('queue and multi-main credential use delegates refresh to the stock n8n helper', async () => {
	for (const [name, value] of [
		['EXECUTIONS_MODE', 'queue'],
		['N8N_MULTI_MAIN_SETUP_ENABLED', 'true'],
	]) {
		const old = process.env[name];
		process.env[name] = value;
		try {
			const valid = harness();
			await valid.provider().request({ url: CODEX_MODELS_URL });
			assert.equal(valid.exchanges, 0);
			const h = harness(true);
			await h.provider().request({ url: CODEX_MODELS_URL });
			assert.throws(() => assertLocalAuthentication(), /uses a local file/);
			assert.equal(h.exchanges, 1);
			assert.equal(h.calls.length, 1);
		} finally {
			if (old === undefined) delete process.env[name];
			else process.env[name] = old;
		}
	}
});

test('a Redis cache alone does not prevent single-process authentication', async () => {
	const old = process.env.N8N_CACHE_BACKEND;
	process.env.N8N_CACHE_BACKEND = 'redis';
	try {
		const h = harness(true);
		await h.provider().current();
		assert.equal(h.exchanges, 1);
		assert.doesNotThrow(() => assertLocalAuthentication());
	} finally {
		if (old === undefined) delete process.env.N8N_CACHE_BACKEND;
		else process.env.N8N_CACHE_BACKEND = old;
	}
});

test('a failed refresh reuses newer tokens persisted by another worker before marking reconnect', async () => {
	const h = harness(true, async (store) => {
		store.data = { ...store.data, oauthTokenData: tokens() };
		throw { failure: { cause: 'credential-invalid' } };
	});
	const account = await h.provider().current();
	assert.equal(account.accessToken, h.data.oauthTokenData.access_token);
	assert.equal(h.exchanges, 1);
	await h.provider().current();
	assert.equal(h.exchanges, 1);
});

test('a delayed 401 reuses an opaque token whose refresh token and expiry were rotated', async () => {
	const h = harness();
	h.data.oauthTokenData = {
		access_token: 'opaque',
		refresh_token: 'old-refresh',
		account_id: 'account',
		n8n_expires_at: String(Date.now() + 3600000),
	};
	let sent = 0;
	h.context.helpers.httpRequest = async () => {
		if (++sent === 1) {
			h.data = {
				...h.data,
				oauthTokenData: {
					...h.data.oauthTokenData,
					refresh_token: 'rotated',
					n8n_expires_at: String(Date.now() + 7200000),
				},
			};
			return { statusCode: 401, body: {} };
		}
		return { statusCode: 200, body: {} };
	};
	assert.equal((await h.provider().request({ url: CODEX_MODELS_URL })).statusCode, 200);
	assert.equal(h.exchanges, 0);
});
test('credential auth cannot send tokens to another host or endpoint', async () => {
	const h = harness();
	for (const url of [
		'https://example.com/backend-api/codex/responses',
		'https://chatgpt.com/other',
		'https://user@chatgpt.com/backend-api/codex/models',
	]) {
		await assert.rejects(h.provider().request({ url }), /only authenticate/);
		await assert.rejects(authenticateCredential(h.data, { url }), /only authenticate/);
	}
	assert.equal(h.calls.length, 0);
});
test('connected preAuthentication never writes or refreshes', async () => {
	const h = harness();
	assert.deepEqual(
		await prepareCredential(
			{
				helpers: {
					httpRequest: () => {
						throw Error('must not call');
					},
				},
			},
			h.data,
		),
		{},
	);
});
for (const mode of ['regular', 'queue']) {
	test(`device flow persists polling state and exchanges PKCE tokens in ${mode} mode`, async () => {
		const old = process.env.EXECUTIONS_MODE;
		process.env.EXECUTIONS_MODE = mode;
		try {
			const calls = [];
			const auth = tokens();
			const context = {
				helpers: {
					httpRequest: async (options) => {
						calls.push(options);
						if (options.url.endsWith('/usercode'))
							return {
								statusCode: 200,
								body: { device_auth_id: 'device', user_code: 'PUBLIC-CODE', interval: '5' },
							};
						if (options.url.endsWith('/deviceauth/token'))
							return {
								statusCode: 200,
								body: { authorization_code: 'code', code_verifier: 'verifier' },
							};
						return { statusCode: 200, body: auth };
					},
				},
			};
			let data = await prepareCredential(context, { setupMode: 'browser' });
			assert.equal(calls.length, 1);
			assert.equal(data.deviceAuthState.user_code, 'PUBLIC-CODE');
			data = await prepareCredential(context, { setupMode: 'browser', ...data });
			assert.equal(calls.length, 1);
			data.deviceAuthState.next_poll_at = 0;
			data = await prepareCredential(context, { setupMode: 'browser', ...data });
			assert.equal(calls.length, 3);
			assert.equal(data.oauthTokenData.access_token, auth.access_token);
			assert.equal(data.deviceAuthState, null);
			assert.match(calls[2].body, /grant_type=authorization_code/);
			assert.match(calls[2].body, /code_verifier=verifier/);
		} finally {
			if (old === undefined) delete process.env.EXECUTIONS_MODE;
			else process.env.EXECUTIONS_MODE = old;
		}
	});
}
test('transfer is explicit and requires a complete login', async () => {
	const context = {
		helpers: {
			httpRequest: () => {
				throw Error('unexpected');
			},
		},
	};
	await assert.rejects(
		prepareCredential(context, { setupMode: 'transfer' }),
		/existing Codex node/,
	);
	await assert.rejects(
		prepareCredential(context, { setupMode: 'browser', migrationTokenSeed: tokens() }),
		/complete existing login/,
	);
	const seed = tokens();
	const result = await prepareCredential(context, {
		setupMode: 'transfer',
		migrationTokenSeed: seed,
	});
	assert.equal(result.oauthTokenData.access_token, seed.access_token);
	assert.equal(result.migrationTokenSeed, null);
});
test('credential secrets are hidden, redacted and use stored-value sentinels on Retry', () => {
	const credential = new OpenAiCodexAccountApi();
	for (const name of ['oauthTokenData', 'deviceAuthState']) {
		const property = credential.properties.find((p) => p.name === name);
		assert.equal(property.type, 'hidden');
		assert.equal(property.typeOptions.password, true);
		assert.match(property.default, /n8n_EMPTY_VALUE/);
	}
});

test('version 4 model reuses a shared credential on every inference turn without legacy files', async () => {
	const {
		OpenAiCodexChatModel,
	} = require('../dist/nodes/OpenAiCodexChatModel/OpenAiCodexChatModel.node.js');
	const { Readable } = require('node:stream');
	const h = harness();
	let staticReads = 0;
	const seen = [];
	const node = {
		id: randomUUID(),
		name: 'Codex shared credential',
		type: 'CUSTOM.openAiCodexChatModel',
		typeVersion: 4,
		position: [0, 0],
		parameters: { model: 'gpt-6.1-sol' },
		credentials: { [CODEX_CREDENTIAL_TYPE]: { id: randomUUID(), name: 'Shared' } },
	};
	h.context.getNode = () => node;
	const context = {
		...h.context,
		getWorkflow: () => ({ id: randomUUID() }),
		getWorkflowStaticData: () => {
			staticReads++;
			return {};
		},
		getNodeParameter: (name, index, fallback) => node.parameters[name] ?? fallback,
		getExecutionCancelSignal: () => undefined,
		getExecutionId: () => randomUUID(),
		getInputConnectionData: async () => undefined,
		addInputData: () => ({ index: 0 }),
		addOutputData() {},
		setMetadata() {},
		logAiEvent() {},
		logger: { debug() {}, warn() {} },
	};
	context.helpers.httpRequest = async (options) => {
		if (options.url.includes('/models')) return { statusCode: 503, body: {} };
		seen.push(options.headers.Authorization);
		const response = {
			model: 'gpt-6.1-sol',
			status: 'completed',
			output: [
				{
					type: 'message',
					role: 'assistant',
					phase: 'final_answer',
					content: [{ type: 'output_text', text: 'ready' }],
				},
			],
		};
		return {
			statusCode: 200,
			body: Readable.from([
				Buffer.from(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`),
			]),
		};
	};
	const model = (await new OpenAiCodexChatModel().supplyData.call(context, 0)).response;
	model.callbacks = [];
	await model.invoke('Say ready');
	h.data.oauthTokenData = tokens();
	await model.invoke('Say ready again');
	assert.equal(seen.length, 2);
	assert.notEqual(seen[0], seen[1]);
	assert.equal(h.exchanges, 0);
	// Reading workflow static metadata is harmless; no auth state is written to it.
	assert.ok(staticReads <= 1);
});
test('native n8n credential-invalid failure is recognized as a permanent reconnect requirement', async () => {
	const h = harness(true, async () => {
		const error = new Error('reconnect');
		error.failure = { cause: 'credential-invalid' };
		throw error;
	});
	await assert.rejects(h.provider().current(), /revoked/);
	await assert.rejects(h.provider().current(), /revoked/);
	assert.equal(h.exchanges, 1);
});

test('transfer removes legacy secrets only after target persistence and leaves a restart-safe marker', async () => {
	const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
	const { tmpdir } = require('node:os');
	const { join } = require('node:path');
	const directory = mkdtempSync(join(tmpdir(), 'codex-transfer-'));
	const old = process.env.N8N_OPENAI_CODEX_STATE_DIR;
	process.env.N8N_OPENAI_CODEX_STATE_DIR = directory;
	try {
		const {
			OpenAiCodexChatModel,
		} = require('../dist/nodes/OpenAiCodexChatModel/OpenAiCodexChatModel.node.js');
		const h = harness();
		const seed = tokens();
		h.data = { ...h.data, setupMode: 'transfer', oauthTokenData: '' };
		const staticData = { codexAuthJson: { tokens: seed } };
		const id = randomUUID();
		const workflowId = randomUUID();
		let action = 'transfer';
		let writes = 0;
		const node = {
			id,
			name: 'Codex',
			type: 'CUSTOM.openAiCodexChatModel',
			typeVersion: 4,
			position: [0, 0],
			parameters: { accountSource: 'credential' },
			credentials: { [CODEX_CREDENTIAL_TYPE]: { id: randomUUID(), name: 'Target' } },
		};
		const context = {
			...h.context,
			getNode: () => node,
			getWorkflow: () => ({ id: workflowId }),
			getWorkflowStaticData: () => staticData,
			getNodeParameter: () => action,
			continueOnFail: () => false,
		};
		context.helpers.returnJsonArray = (value) => [{ json: value }];
		context.helpers.httpRequestWithAuthentication = async (_type, _request, opts) => {
			const output = await prepareCredential({ helpers: {} }, opts.credentialsDecrypted.data);
			h.data = { ...h.data, ...output };
			writes++;
		};
		const impl = new OpenAiCodexChatModel();
		const result = await impl.execute.call(context);
		assert.equal(result[0][0].json.transferred, true);
		assert.equal(writes, 1);
		assert.equal(staticData.codexAuthJson, undefined);
		const state = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), 'utf8'));
		assert.equal(state.migratedCredentialId, node.credentials[CODEX_CREDENTIAL_TYPE].id);
		assert.equal(state.codexAuthJson, undefined);
		node.parameters.accountSource = 'legacy';
		await assert.rejects(impl.execute.call(context), /transferred/);
	} finally {
		if (old === undefined) delete process.env.N8N_OPENAI_CODEX_STATE_DIR;
		else process.env.N8N_OPENAI_CODEX_STATE_DIR = old;
		rmSync(directory, { recursive: true, force: true });
	}
});

test('declarative n8n credential tests resolve relative URLs against baseURL safely', async () => {
	const h = harness();
	const result = await authenticateCredential(h.data, {
		url: '/backend-api/codex/models',
		baseURL: 'https://chatgpt.com',
	});
	assert.equal(result.url, 'https://chatgpt.com/backend-api/codex/models');
	assert.equal(result.baseURL, undefined);
	await assert.rejects(
		authenticateCredential(h.data, {
			url: '/backend-api/codex/models',
			baseURL: 'https://example.com',
		}),
		/only authenticate/,
	);
});

test('short-lived tokens refresh only within ten percent of their lifetime; unknown expiry waits for 401', async () => {
	const h = harness();
	const now = Date.now() / 1000;
	h.data.oauthTokenData.access_token = jwt({ iat: now - 4, exp: now + 6 });
	await h.provider().current();
	assert.equal(h.exchanges, 0);
	h.data.oauthTokenData.access_token = jwt({ iat: now - 9.5, exp: now + 0.5 });
	await h.provider().current();
	assert.equal(h.exchanges, 1);
	const other = harness();
	other.data.oauthTokenData.access_token = 'opaque-token-without-expiry';
	await other.provider().current();
	assert.equal(other.exchanges, 0);
});
test('account identity changes are rejected during a model execution', async () => {
	const h = harness();
	const p = h.provider();
	await p.current();
	h.data.oauthTokenData.account_id = 'another-account';
	await assert.rejects(p.current(), /account changed/);
});
test('temporary refresh failures retry only after the shared cooldown; Retry-After is capped', async () => {
	const real = Date.now;
	let now = real();
	Date.now = () => now;
	try {
		let attempts = 0;
		const h = harness(true, async (store) => {
			attempts++;
			if (attempts === 1) {
				const e = new Error('secret');
				e.response = { status: 429, headers: { 'retry-after': '600' } };
				throw e;
			}
			store.data = { ...store.data, oauthTokenData: tokens() };
		});
		await assert.rejects(h.provider().current(), /cooldown/);
		now += 299_000;
		await assert.rejects(h.provider().current(), /cooldown/);
		assert.equal(attempts, 1);
		now += 1001;
		await h.provider().current();
		assert.equal(attempts, 2);
	} finally {
		Date.now = real;
	}
});
test('pending device polling persists backoff across requests and replaces an expired device session', async () => {
	let requests = 0;
	const context = {
		helpers: {
			httpRequest: async (options) => {
				requests++;
				return options.url.endsWith('/usercode')
					? {
							statusCode: 200,
							body: { device_auth_id: 'new-device', user_code: 'CODE', interval: 5 },
						}
					: { statusCode: 429, body: {} };
			},
		},
	};
	let data = {
		setupMode: 'browser',
		deviceAuthState: {
			device_auth_id: 'device',
			user_code: 'CODE',
			issued_at: Date.now(),
			next_poll_at: 0,
			interval_ms: 5000,
		},
	};
	const result = await prepareCredential(context, data);
	assert.equal(requests, 1);
	assert.ok(result.deviceAuthState.next_poll_at >= Date.now() + 29_000);
	await prepareCredential(context, { ...data, ...result });
	assert.equal(requests, 1);
	data.deviceAuthState.issued_at = Date.now() - 16 * 60_000;
	const replaced = await prepareCredential(context, data);
	assert.equal(replaced.deviceAuthState.device_auth_id, 'new-device');
	assert.equal(requests, 2);
});
test('device HTTP failures do not expose authorization secrets in error messages', async () => {
	await assert.rejects(
		prepareCredential(
			{
				helpers: {
					httpRequest: async () => {
						throw new Error('PRIVATE_DEVICE_AUTH_ID');
					},
				},
			},
			{ setupMode: 'browser' },
		),
		(error) =>
			!error.message.includes('PRIVATE_DEVICE_AUTH_ID') && /request failed/.test(error.message),
	);
});

test('a transferred credential can reconnect and continue device polling on later Test steps', async () => {
	const h = harness(true, async () => {
		const e = new Error('revoked');
		e.failure = { cause: 'credential-invalid' };
		throw e;
	});
	h.data.setupMode = 'transfer';
	h.context.helpers.httpRequestWithAuthentication = async (_type, _request, options) => {
		const input = options?.credentialsDecrypted?.data ?? h.data;
		const update = await prepareCredential(
			{
				helpers: {
					httpRequest: async () => ({
						statusCode: 200,
						body: { device_auth_id: 'reconnect-device', user_code: 'CODE', interval: 5 },
					}),
				},
			},
			input,
		);
		h.data = { ...h.data, ...update };
		throw new Error('pending login');
	};
	const first = await h.provider().testStep();
	assert.equal(first.status, 'pending_verification');
	assert.equal(h.data.setupMode, 'browser');
	assert.equal(h.data.oauthTokenData, null);
	const second = await h.provider().testStep();
	assert.equal(second.status, 'pending_verification');
	assert.equal(second.user_code, 'CODE');
});

test('transfer retains the credential gate through source cleanup and resumes after token rotation', async () => {
	const h = harness();
	const seed = tokens();
	h.data = { ...h.data, setupMode: 'transfer', oauthTokenData: '' };
	let imports = 0;
	h.context.helpers.httpRequestWithAuthentication = async (_type, _request, options) => {
		h.data = {
			...h.data,
			...(await prepareCredential({ helpers: {} }, options.credentialsDecrypted.data)),
		};
		imports++;
	};
	let release, entered;
	const held = new Promise((r) => (release = r)),
		started = new Promise((r) => (entered = r));
	let readFinished = false;
	const migration = h.provider().transfer(seed, 'workflow:node', async () => {
		entered();
		await held;
		throw new Error('disk full');
	});
	await started;
	const reader = h
		.provider()
		.current()
		.then(() => (readFinished = true));
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(readFinished, false);
	release();
	await assert.rejects(migration, /disk full/);
	await reader;
	assert.equal(imports, 1);
	// Another execution can rotate the target after a failed cleanup. Provenance lets retry clean up safely.
	h.data.oauthTokenData = tokens();
	let cleared = false;
	await h.provider().transfer(seed, 'workflow:node', async () => {
		cleared = true;
	});
	assert.equal(cleared, true);
	assert.equal(imports, 1);
	await assert.rejects(
		h.provider().transfer(seed, 'another:node', async () => assert.fail()),
		/another transfer/,
	);
});
test('persisted rotation may retain an opaque access token when its refresh token changes', async () => {
	const h = harness(false, async (store) => {
		store.data = {
			...store.data,
			oauthTokenData: { ...store.data.oauthTokenData, refresh_token: 'rotated-refresh' },
		};
	});
	h.data.oauthTokenData.access_token = 'opaque-access';
	let requests = 0;
	h.context.helpers.httpRequest = async () => ({
		statusCode: ++requests === 1 ? 401 : 200,
		body: {},
	});
	const result = await h.provider().request({ url: CODEX_MODELS_URL });
	assert.equal(result.statusCode, 200);
	assert.equal(h.exchanges, 1);
});

test('reopened credential-dialog OAuth presence flags never restart login or overwrite tokens', async () => {
	for (const setupMode of ['browser', 'transfer']) {
		let requests = 0;
		const result = await prepareCredential(
			{
				helpers: {
					httpRequest: async () => {
						requests++;
						throw new Error('must not call');
					},
				},
			},
			{ setupMode, oauthTokenData: true, authInitialized: '' },
		);
		assert.deepEqual(result, {});
		assert.equal(requests, 0);
	}
});
test('credential-dialog presence flags cannot masquerade as a live account verification', async () => {
	await assert.rejects(
		authenticateCredential({ oauthTokenData: true }, { url: CODEX_MODELS_URL }),
		/does not expose the stored OAuth tokens/,
	);
});

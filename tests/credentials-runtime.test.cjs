const assert = require('node:assert/strict');
const { test } = require('node:test');
const { dirname, join } = require('node:path');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const enabled = process.env.CODEX_TEST_N8N_RUNTIME === 'true';
function runtime() {
	const cliRoot = dirname(process.env.NODE_PATH.split(require('node:path').delimiter)[0]);
	const cli = createRequire(join(cliRoot, 'package.json'));
	const coreRoot = dirname(cli.resolve('n8n-core/package.json'));
	const core = createRequire(join(coreRoot, 'package.json'));
	const { Container } = core('@n8n/di');
	const { Cipher } = require(join(coreRoot, 'dist/encryption/cipher.js'));
	const { EncryptionKeyProxy } = require(join(coreRoot, 'dist/encryption/encryption-key-proxy.js'));
	const proxy = new EncryptionKeyProxy();
	const cipher = new Cipher({ encryptionKey: 'synthetic-test-key' }, proxy);
	const key = {
		id: 'test',
		value: cipher.encryptDEKWithInstanceKey('synthetic-test-key'),
		algorithm: 'aes-256-cbc',
		format: 'no-prefix',
	};
	proxy.setProvider({
		getActiveKey: async () => key,
		getLegacyKey: async () => key,
		getKeyById: async () => key,
	});
	Container.set(Cipher, cipher);
	return {
		Container,
		OutboundHttp: core('@n8n/backend-network').OutboundHttp,
		httpRequestWithAuthentication: require(
			join(
				coreRoot,
				'dist/execution-engine/node-execution-context/utils/request-helpers/authentication.js',
			),
		).httpRequestWithAuthentication,
		Credentials: core('n8n-core').Credentials,
		CredentialsHelper: require(join(cliRoot, 'dist/credentials-helper.js')).CredentialsHelper,
		CredentialsService: require(join(cliRoot, 'dist/credentials/credentials.service.js'))
			.CredentialsService,
		refreshOAuth2Token: require(
			join(coreRoot, 'dist/execution-engine/node-execution-context/utils/request-helpers/oauth.js'),
		).refreshOAuth2Token,
	};
}
async function store() {
	const r = runtime();
	const {
		OpenAiCodexAccountApi,
	} = require('../dist/credentials/OpenAiCodexAccountApi.credentials.js');
	const type = new OpenAiCodexAccountApi();
	const details = { id: randomUUID(), name: 'Synthetic Codex' };
	const cred = new r.Credentials(details, type.name);
	await cred.setData({
		setupMode: 'browser',
		authInitialized: '',
		oauthTokenData: '',
		deviceAuthState: '',
	});
	let encrypted = cred.data;
	let writes = 0;
	const repository = {
		update: async (_query, update) => {
			assert.equal(typeof update.data, 'string');
			encrypted = update.data;
			writes++;
		},
		updateDataIfUnchanged: async (_id, _type, old, next) => {
			if (encrypted !== old) return false;
			encrypted = next;
			writes++;
			return true;
		},
	};
	const helper = new r.CredentialsHelper({ getByName: () => type }, undefined, repository, {
		getEffectiveResolverId: () => undefined,
	});
	helper.getCredentials = async () => new r.Credentials(details, type.name, encrypted);
	helper.getCredentialsEntity = async () => ({ ...details, type: type.name, isResolvable: false });
	helper.getDecrypted = async () => {
		const data = await (await helper.getCredentials()).getData();
		helper.storedDataByDecrypted.set(data, encrypted);
		return data;
	};
	return {
		...r,
		type,
		details,
		helper,
		read: () => helper.getDecrypted(),
		get encrypted() {
			return encrypted;
		},
		get writes() {
			return writes;
		},
	};
}
test(
	'installed n8n persists device state encrypted and Retry restores current stored state',
	{ skip: !enabled },
	async () => {
		const s = await store();
		const data = await s.read();
		const node = {
			credentials: { [s.type.name]: s.details },
			parameters: {},
			type: 'CUSTOM.openAiCodexChatModel',
		};
		const http = {
			helpers: {
				httpRequest: async () => ({
					statusCode: 200,
					body: { device_auth_id: 'PRIVATE-DEVICE', user_code: 'PUBLIC-CODE', interval: '5' },
				}),
			},
		};
		const result = await s.helper.preAuthentication(http, data, s.type.name, node, false);
		assert.equal(s.writes, 1);
		assert.ok(!s.encrypted.includes('PRIVATE-DEVICE'));
		assert.equal((await s.read()).deviceAuthState.device_auth_id, 'PRIVATE-DEVICE');
		const service = Object.create(s.CredentialsService.prototype);
		service.credentialTypes = { getByName: () => s.type };
		const redacted = service.redact(await s.read(), { type: s.type.name });
		assert.equal(typeof redacted.deviceAuthState, 'string');
		assert.ok(!JSON.stringify(redacted).includes('PRIVATE-DEVICE'));
		const form = Object.fromEntries(s.type.properties.map((p) => [p.name, p.default]));
		const retry = service.unredact(form, await s.read(), s.type.properties);
		assert.equal(retry.deviceAuthState.device_auth_id, 'PRIVATE-DEVICE');
		assert.equal(result.deviceAuthState.user_code, 'PUBLIC-CODE');
	},
);
test(
	'installed n8n encrypts a transferred login; connected preAuthentication performs no write',
	{ skip: !enabled },
	async () => {
		const s = await store();
		const node = {
			credentials: { [s.type.name]: s.details },
			parameters: {},
			type: 'CUSTOM.openAiCodexChatModel',
		};
		const input = {
			...(await s.read()),
			setupMode: 'transfer',
			migrationTokenSeed: {
				access_token: 'PRIVATE-ACCESS',
				refresh_token: 'PRIVATE-REFRESH',
				account_id: 'account',
			},
		};
		await s.helper.preAuthentication(
			{ helpers: { httpRequest: () => assert.fail() } },
			input,
			s.type.name,
			node,
			false,
		);
		assert.equal(s.writes, 1);
		assert.ok(!s.encrypted.includes('PRIVATE-ACCESS'));
		assert.ok(!s.encrypted.includes('PRIVATE-REFRESH'));
		assert.equal((await s.read()).oauthTokenData.access_token, 'PRIVATE-ACCESS');
		await s.helper.preAuthentication(
			{ helpers: { httpRequest: () => assert.fail() } },
			await s.read(),
			s.type.name,
			node,
			true,
		);
		assert.equal(s.writes, 1);
	},
);
test(
	'installed n8n native OAuth refresh waits for encrypted persistence and preserves account metadata',
	{ skip: !enabled },
	async () => {
		const s = await store();
		const { createServer } = require('node:http');
		let exchanges = 0;
		const server = createServer((req, res) => {
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
				exchanges++;
				assert.match(body, /grant_type=refresh_token/);
				assert.match(body, /refresh_token=old-refresh/);
				res.setHeader('content-type', 'application/json');
				res.end(
					JSON.stringify({
						access_token: 'new-access',
						refresh_token: 'new-refresh',
						token_type: 'Bearer',
						expires_in: 3600,
					}),
				);
			});
		});
		await new Promise((r) => server.listen(0, '127.0.0.1', r));
		try {
			const data = {
				clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
				grantType: 'pkce',
				accessTokenUrl: `http://127.0.0.1:${server.address().port}/token`,
				oauthTokenData: {
					access_token: 'old-access',
					refresh_token: 'old-refresh',
					account_id: 'account',
				},
			};
			await s.helper.updateCredentials(s.details, s.type.name, data);
			const node = { name: 'Synthetic Codex', credentials: { [s.type.name]: s.details } };
			const context = {
				getCredentials: () => s.read(),
				logger: { debug() {}, warn() {} },
				helpers: {},
			};
			const result = await s.refreshOAuth2Token.call(context, s.type.name, node, {
				credentialsHelper: s.helper,
			});
			assert.equal(exchanges, 1);
			assert.equal(result.access_token, 'new-access');
			assert.equal((await s.read()).oauthTokenData.refresh_token, 'new-refresh');
			assert.equal((await s.read()).oauthTokenData.account_id, 'account');
			assert.ok(!s.encrypted.includes('new-refresh'));
		} finally {
			await new Promise((r) => server.close(r));
		}
	},
);

test(
	'installed n8n refuses a stale token write after the credential was changed',
	{ skip: !enabled },
	async () => {
		const s = await store();
		await s.helper.updateCredentials(s.details, s.type.name, {
			oauthTokenData: { access_token: 'old', refresh_token: 'old-refresh' },
		});
		const stale = await s.read();
		await s.helper.updateCredentials(s.details, s.type.name, {
			oauthTokenData: { access_token: 'newer', refresh_token: 'newer-refresh' },
		});
		stale.oauthTokenData = {
			access_token: 'stale-refresh-result',
			refresh_token: 'stale-refresh-token',
		};
		await s.helper.updateCredentialsOauthTokenData(s.details, s.type.name, stale, {});
		assert.equal((await s.read()).oauthTokenData.access_token, 'newer');
	},
);

test(
	'installed n8n public authentication pipeline encrypts transfer before source cleanup',
	{ skip: !enabled },
	async () => {
		const s = await store();
		const {
			CodexAccountProvider,
		} = require('../dist/nodes/OpenAiCodexChatModel/codex-credentials.js');
		await s.helper.updateCredentials(s.details, s.type.name, {
			setupMode: 'transfer',
			authInitialized: '',
			oauthTokenData: '',
		});
		s.helper.getParentTypes = () => [];
		const node = {
			name: 'Codex',
			type: 'CUSTOM.openAiCodexChatModel',
			typeVersion: 4,
			parameters: { accountSource: 'credential' },
			credentials: { [s.type.name]: s.details },
		};
		let sent = 0;
		s.Container.set(s.OutboundHttp, {
			requests: () => ({
				request: async (options) => {
					sent++;
					assert.equal(options.headers.Authorization, 'Bearer source-access');
					return { statusCode: 200, body: { models: [] } };
				},
			}),
		});
		const context = {
			getNode: () => node,
			getCredentials: () => s.read(),
			helpers: {},
			logger: { debug() {}, warn() {} },
		};
		context.helpers.httpRequestWithAuthentication = function (type, options, extra) {
			return s.httpRequestWithAuthentication.call(
				context,
				type,
				options,
				undefined,
				node,
				{ credentialsHelper: s.helper },
				extra,
			);
		};
		let cleared = false;
		const result = await new CodexAccountProvider(context).transfer(
			{ access_token: 'source-access', refresh_token: 'source-refresh', account_id: 'account' },
			'workflow:node',
			async () => {
				assert.equal((await s.read()).oauthTokenData.refresh_token, 'source-refresh');
				assert.ok(!s.encrypted.includes('source-refresh'));
				cleared = true;
			},
		);
		assert.equal(cleared, true);
		assert.equal(sent, 1);
		assert.equal(result.status, 'authenticated');
		assert.equal((await s.read()).migrationSource, 'workflow:node');
	},
);

test(
	'installed n8n boolean OAuth editor flag survives unredaction and cannot erase a saved account',
	{ skip: !enabled },
	async () => {
		const s = await store();
		await s.helper.updateCredentials(s.details, s.type.name, {
			setupMode: 'browser',
			authInitialized: '',
			oauthTokenData: {
				access_token: 'stored-access',
				refresh_token: 'stored-refresh',
				account_id: 'account',
			},
		});
		const service = Object.create(s.CredentialsService.prototype);
		const form = service.unredact(
			{ setupMode: 'browser', authInitialized: '', oauthTokenData: true },
			await s.read(),
			s.type.properties,
		);
		assert.equal(form.oauthTokenData, true);
		const before = s.writes;
		const node = {
			credentials: { [s.type.name]: s.details },
			parameters: { temp: '' },
			type: 'n8n-nodes-base.noOp',
		};
		await s.helper.preAuthentication(
			{ helpers: { httpRequest: () => assert.fail('must not restart login') } },
			form,
			s.type.name,
			node,
			false,
		);
		assert.equal(s.writes, before);
		assert.equal((await s.read()).oauthTokenData.refresh_token, 'stored-refresh');
	},
);

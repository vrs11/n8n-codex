import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolated stock-n8n deployment. Real queue/storage; synthetic HTTPS issuer and model.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = resolve(root, 'tests/queue');
const runtime = mkdtempSync(resolve(fixture, 'runtime-'));
const project = `codex-stock-queue-${process.pid}`;
async function command(name, args) {
	return await new Promise((done, reject) => {
		const child = spawn(name, args, {
			cwd: root,
			env: { ...process.env, CODEX_QUEUE_FIXTURES: runtime },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '',
			stderr = '';
		child.stdout.on('data', (c) => {
			stdout += c;
		});
		child.stderr.on('data', (c) => {
			stderr += c;
		});
		child.on('error', reject);
		child.on('close', (code) =>
			code === 0
				? done(stdout.trim())
				: reject(new Error(`${name} ${args.slice(0, 4).join(' ')} failed:\n${stderr}\n${stdout}`)),
		);
	});
}
const compose = (args) =>
	command('docker', ['compose', '-p', project, '-f', resolve(fixture, 'compose.yml'), ...args]);
writeFileSync(
	resolve(runtime, 'openssl.cnf'),
	'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Codex queue test CA\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nsubjectAltName=DNS:auth.openai.com,DNS:chatgpt.com\n',
);
await command('openssl', [
	'req',
	'-x509',
	'-newkey',
	'rsa:2048',
	'-nodes',
	'-days',
	'1',
	'-keyout',
	resolve(runtime, 'key.pem'),
	'-out',
	resolve(runtime, 'cert.pem'),
	'-config',
	resolve(runtime, 'openssl.cnf'),
]);
let base,
	issuer,
	ownerId,
	cookie = '';
const controllers = new Set();
async function api(path, method = 'GET', body) {
	const response = await fetch(base + '/rest' + path, {
		method,
		headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(60000),
	});
	if (response.headers.get('set-cookie'))
		cookie = response.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; ');
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
	return JSON.parse(text).data;
}
async function control(path, body) {
	const response = await fetch(issuer + path, {
		method: body ? 'POST' : 'GET',
		headers: { 'content-type': 'application/json' },
		body: body && JSON.stringify(body),
		signal: AbortSignal.timeout(30000),
	});
	assert.equal(response.status, 200);
	return await response.json();
}
const credentialId = 'codexQueueShared';
async function seed(spec) {
	const s = await control('/case', spec);
	writeFileSync(
		resolve(runtime, 'credential.json'),
		JSON.stringify([
			{
				id: credentialId,
				name: 'Synthetic shared Codex',
				type: 'openAiCodexAccountApi',
				data: {
					authInitialized: '',
					setupMode: 'browser',
					clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
					grantType: 'pkce',
					accessTokenUrl: 'https://auth.openai.com/oauth/token',
					oauthTokenData: s.tokens,
				},
			},
		]),
		{ mode: 0o644 },
	);
	// Import performs n8n's normal credential encryption. No production database is used.
	await compose([
		'exec',
		'-T',
		'main',
		'n8n',
		'import:credentials',
		'--input=/fixtures/credential.json',
		`--userId=${ownerId}`,
	]);
	return s;
}
async function invoke() {
	const controller = new AbortController();
	controllers.add(controller);
	const timeout = setTimeout(() => controller.abort(), 90000);
	try {
		const response = await fetch(base + '/webhook/codex-stock-queue', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
			signal: controller.signal,
		});
		const text = await response.text();
		assert.equal(response.status, 200, text);
		assert.deepEqual(JSON.parse(text), { answer: 'ready', count: 2 });
	} finally {
		clearTimeout(timeout);
		controllers.delete(controller);
	}
}
const metrics = (id) => control('/metrics/' + id);
async function batch(name, spec, count, expectedIssued) {
	const s = await seed(spec);
	await Promise.all(Array.from({ length: count }, () => invoke()));
	const m = await metrics(s.id);
	assert.equal(m.inference, count);
	assert.equal(m.issued, expectedIssued);
	if (!spec.delayMs || spec.delayMs < 10000) assert.ok(m.maxActive <= 1);
	console.log(
		`PASS ${name}: ${count} executions; ${m.refreshes} refresh attempts, ${m.issued} issued, maximum ${m.maxActive} concurrent exchanges`,
	);
	return s;
}
try {
	console.log(`Starting ${project} on ${process.env.N8N_IMAGE || 'official n8n 2.43.5'}`);
	await compose(['up', '-d', '--wait']);
	base = `http://${await compose(['port', 'main', '5678'])}`;
	issuer = `http://${await compose(['port', 'issuer', '8080'])}`;
	ownerId = (
		await api('/owner/setup', 'POST', {
			email: 'queue-test@example.invalid',
			firstName: 'Queue',
			lastName: 'Test',
			password: 'QueueTestOnly-Aa123456!',
		})
	).id;
	await seed({ valid: true });
	const schema = {
		type: 'object',
		properties: {
			answer: { type: 'string', enum: ['ready'] },
			count: { type: 'integer', minimum: 2, maximum: 2 },
		},
		required: ['answer', 'count'],
		additionalProperties: false,
	};
	const workflow = await api('/workflows', 'POST', {
		name: 'Synthetic stock Codex queue regression',
		settings: { executionOrder: 'v1' },
		nodes: [
			{
				id: randomUUID(),
				name: 'Webhook',
				type: 'n8n-nodes-base.webhook',
				typeVersion: 2,
				position: [0, 0],
				webhookId: randomUUID(),
				parameters: {
					path: 'codex-stock-queue',
					httpMethod: 'POST',
					responseMode: 'lastNode',
					responseData: 'firstEntryJson',
					options: {},
				},
			},
			{
				id: randomUUID(),
				name: 'Chain',
				type: '@n8n/n8n-nodes-langchain.chainLlm',
				typeVersion: 1.9,
				position: [200, 0],
				parameters: { promptType: 'define', text: 'Return answer ready and count 2.', options: {} },
			},
			{
				id: randomUUID(),
				name: 'Codex',
				type: 'CUSTOM.openAiCodexChatModel',
				typeVersion: 4,
				position: [200, 200],
				parameters: {
					accountSource: 'credential',
					model: 'gpt-6.1-sol',
					responseFormat: 'jsonSchema',
					outputSchema: JSON.stringify(schema),
					outputSchemaName: 'queue_test',
					reasoningEffort: 'default',
				},
				credentials: {
					openAiCodexAccountApi: { id: credentialId, name: 'Synthetic shared Codex' },
				},
			},
		],
		connections: {
			Webhook: { main: [[{ node: 'Chain', type: 'main', index: 0 }]] },
			Codex: { ai_languageModel: [[{ node: 'Chain', type: 'ai_languageModel', index: 0 }]] },
		},
	});
	await api(`/workflows/${workflow.id}/activate`, 'POST', {
		versionId: workflow.versionId,
		expectedChecksum: workflow.checksum,
	});
	await batch('valid shared credential', { valid: true }, 8, 0);
	await batch('concurrent expiry', {}, 8, 1);
	await batch('401 recovery', { valid: true, rejectInitial: true }, 8, 1);
	await batch('opaque access token with rotating refresh token', { opaque: true }, 8, 1);
	const persisted = await batch('native ten-second timeout behavior', { delayMs: 12500 }, 4, 1);
	await compose(['restart', 'worker-a', 'worker-b']);
	await compose(['up', '-d', '--wait', 'worker-a', 'worker-b']);
	await Promise.all(Array.from({ length: 4 }, () => invoke()));
	assert.equal((await metrics(persisted.id)).issued, 1);
	console.log('PASS restarted workers reuse persisted tokens without another refresh');
	const encrypted = await compose([
		'exec',
		'-T',
		'postgres',
		'psql',
		'-U',
		'codex_test',
		'-d',
		'codex_test',
		'-Atc',
		`SELECT position('access_token' in data) = 0 AND position('synthetic-queue-refresh' in data) = 0 FROM credentials_entity WHERE id = '${credentialId}'`,
	]);
	assert.equal(encrypted, 't');
	const logs = await compose(['logs', '--no-color', 'worker-a', 'worker-b']);
	writeFileSync(resolve(runtime, 'workers.log'), logs);
	for (const service of ['worker-a', 'worker-b'])
		assert.ok(
			logs
				.split('\n')
				.some((line) => line.includes(service) && /Worker finished execution/.test(line)),
			`${service} must execute workflows`,
		);
	console.log('PASS both workers executed workflows; shared credential is encrypted in PostgreSQL');
} catch (error) {
	try {
		writeFileSync(resolve(runtime, 'failure.log'), await compose(['logs', '--no-color']));
	} catch {}
	throw error;
} finally {
	for (const controller of controllers) controller.abort();
	await compose(['down', '--volumes', '--remove-orphans']);
	console.log(`Test logs: ${runtime}`);
}

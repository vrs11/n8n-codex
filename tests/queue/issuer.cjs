// Test-only HTTPS issuer. No real OpenAI requests or accounts are used.
const { createServer } = require('node:https');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const catalog = require('/opt/codex-dist/nodes/OpenAiCodexChatModel/fallback-models.json');
const states = new Map();
let state;
const jwt = (expired) =>
	`e30.${Buffer.from(
		JSON.stringify({
			exp: Date.now() / 1000 + (expired ? -100 : 3600),
			iat: Date.now() / 1000 - 100,
			nonce: randomUUID(),
		}),
	).toString('base64url')}.sig`;
const json = (res, code, body) => {
	res.writeHead(code, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
};
async function body(req) {
	let value = '';
	for await (const chunk of req) value += chunk;
	return value;
}
http
	.createServer(async (req, res) => {
		if (req.url === '/case' && req.method === 'POST') {
			const spec = JSON.parse(await body(req));
			state = {
				id: randomUUID(),
				spec,
				refreshes: 0,
				issued: 0,
				active: 0,
				maxActive: 0,
				inference: 0,
				rejected: 0,
				tokens: {
					access_token: spec.opaque ? `opaque-${randomUUID()}` : jwt(!spec.valid),
					refresh_token: `synthetic-queue-refresh-${randomUUID()}`,
					account_id: 'synthetic-queue-account',
					token_type: 'Bearer',
					n8n_expires_at: String(Date.now() + (spec.valid ? 3600000 : -100000)),
					expires_in: 3600,
				},
			};
			states.set(state.id, state);
			return json(res, 200, state);
		}
		if (req.url.startsWith('/metrics/'))
			return json(res, 200, states.get(req.url.split('/').pop()));
		json(res, 404, {});
	})
	.listen(8080, '0.0.0.0');
createServer(
	{
		key: readFileSync('/fixtures/key.pem'),
		cert: readFileSync('/fixtures/cert.pem'),
	},
	async (req, res) => {
		if (req.url === '/oauth/token') {
			const grant = new URLSearchParams(await body(req));
			const s = state;
			s.refreshes++;
			if (
				grant.get('grant_type') !== 'refresh_token' ||
				grant.get('refresh_token') !== s.tokens.refresh_token
			)
				return json(res, 400, { error: 'invalid_grant' });
			s.active++;
			s.maxActive = Math.max(s.maxActive, s.active);
			let finished = false;
			const timer = setTimeout(() => {
				finished = true;
				s.active--;
				if (grant.get('refresh_token') !== s.tokens.refresh_token)
					return json(res, 400, { error: 'invalid_grant' });
				s.issued++;
				s.tokens = {
					...s.tokens,
					access_token: s.spec.opaque ? s.tokens.access_token : jwt(false),
					refresh_token: `synthetic-queue-refresh-${randomUUID()}`,
					expires_in: 3600,
				};
				json(res, 200, s.tokens);
			}, s.spec.delayMs ?? 700);
			res.on('close', () => {
				if (!finished) {
					clearTimeout(timer);
					s.active--;
				}
			});
			return;
		}
		const accepted =
			state &&
			req.headers.authorization === `Bearer ${state.tokens.access_token}` &&
			(state.issued > 0 || (state.spec.valid && !state.spec.rejectInitial));
		if (!accepted) {
			if (state) state.rejected++;
			return json(res, 401, { error: 'invalid_token' });
		}
		if (req.url.startsWith('/backend-api/codex/models'))
			return json(res, 200, { models: catalog.models });
		if (req.url.startsWith('/backend-api/codex/responses')) {
			const request = JSON.parse(await body(req));
			if (request.text?.format?.type !== 'json_schema' || request.text.format.strict !== true)
				return json(res, 400, { error: 'expected strict JSON schema' });
			state.inference++;
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.end(
				`data: ${JSON.stringify({
					type: 'response.completed',
					response: {
						id: randomUUID(),
						status: 'completed',
						model: request.model,
						output: [
							{
								type: 'message',
								role: 'assistant',
								phase: 'final_answer',
								content: [{ type: 'output_text', text: '{"answer":"ready","count":2}' }],
							},
						],
					},
				})}\n\n`,
			);
			return;
		}
		json(res, 404, {});
	},
).listen(443, '0.0.0.0');

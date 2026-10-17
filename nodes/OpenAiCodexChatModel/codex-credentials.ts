/* Authentication utility errors are wrapped by the node execution boundary. */
/* eslint-disable @n8n/community-nodes/require-node-api-error */
import { createHash } from 'node:crypto';
import {
	CREDENTIAL_EMPTY_VALUE,
	OperationalError,
	type ICredentialDataDecryptedObject,
	type IDataObject,
	type IHttpRequestHelper,
	type IHttpRequestOptions,
	type IN8nHttpFullResponse,
	type INode,
	type ISupplyDataFunctions,
} from 'n8n-workflow';

export const CODEX_CREDENTIAL_TYPE = 'openAiCodexAccountApi';
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_MODELS_URL = `${CODEX_BASE_URL}/models?client_version=0.162.1`;
const ISSUER = 'https://auth.openai.com';
export const CODEX_CLIENT_ID =
	process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID?.trim() || 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEVICE_TTL = 15 * 60_000;

export type CodexAccount = { accessToken: string; accountId: string; tokenData: IDataObject };
type DeviceState = {
	device_auth_id: string;
	user_code: string;
	issued_at: number;
	next_poll_at: number;
	interval_ms: number;
};
export type CredentialContext = {
	getNode(): INode;
	getCredentials(type: string): Promise<ICredentialDataDecryptedObject>;
	helpers: ISupplyDataFunctions['helpers'];
};

export function object(value: unknown): IDataObject | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as IDataObject)
		: undefined;
}

function jwt(token: unknown): IDataObject | undefined {
	if (typeof token !== 'string') return undefined;
	try {
		return object(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()));
	} catch {
		return undefined;
	}
}

function accountId(data: IDataObject): string | undefined {
	const claims =
		object(jwt(data.id_token)?.['https://api.openai.com/auth']) ??
		object(jwt(data.access_token)?.['https://api.openai.com/auth']);
	return typeof claims?.chatgpt_account_id === 'string'
		? claims.chatgpt_account_id
		: typeof data.account_id === 'string'
			? data.account_id
			: undefined;
}

export function accountFromCredential(
	data: ICredentialDataDecryptedObject,
): CodexAccount | undefined {
	const tokenData = object(data.oauthTokenData);
	const id = tokenData && accountId(tokenData);
	if (typeof tokenData?.access_token !== 'string' || !tokenData.access_token || !id)
		return undefined;
	return { accessToken: tokenData.access_token, accountId: id, tokenData };
}

function needsRefresh(account: CodexAccount): boolean {
	const claims = jwt(account.accessToken);
	const expiresAt =
		typeof claims?.exp === 'number' ? claims.exp * 1000 : Number(account.tokenData.n8n_expires_at);
	if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
	const lifetime =
		typeof claims?.iat === 'number' && typeof claims.exp === 'number'
			? (claims.exp - claims.iat) * 1000
			: Number(account.tokenData.expires_in) * 1000;
	const margin = Number.isFinite(lifetime) && lifetime > 0 ? Math.min(60_000, lifetime / 10) : 0;
	return expiresAt <= Date.now() + margin;
}

function distributedDeployment(): boolean {
	return (
		process.env.EXECUTIONS_MODE === 'queue' || process.env.N8N_MULTI_MAIN_SETUP_ENABLED === 'true'
	);
}

export function assertLocalAuthentication(): void {
	if (distributedDeployment())
		throw new OperationalError(
			'Existing Node Login uses a local file. Transfer it to a Codex Account credential before enabling queue or distributed execution.',
		);
}

export function credentialHeaders(account: CodexAccount): Record<string, string> {
	return {
		Authorization: `Bearer ${account.accessToken}`,
		'chatgpt-account-id': account.accountId,
		originator: 'codex_cli_rs',
	};
}

export function pendingLoginMessage(data: ICredentialDataDecryptedObject): string {
	const device = object(data.deviceAuthState);
	return device?.user_code
		? `Open ${ISSUER}/codex/device and enter code ${String(device.user_code)}. After approval, click Retry (or Test step again).`
		: 'Open the selected Codex Account credential and use Save/Test to sign in.';
}

export class CodexCredentialError extends OperationalError {}

// This gate covers the decision, native refresh and its completed encrypted write, not inference.
const operations = new Map<string, Promise<void>>();
type Failure = { fingerprint: string; until: number; reconnect: boolean; message: string };
const failures = new Map<string, Failure>();
function rememberFailure(id: string, failure: Failure): void {
	failures.set(id, failure);
	if (failures.size > 256) failures.delete(failures.keys().next().value!);
}

async function gated<T>(id: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const previous = operations.get(id) ?? Promise.resolve();
	let release!: () => void;
	const lease = new Promise<void>((resolve) => {
		release = resolve;
	});
	operations.set(id, lease);
	const task = (async () => {
		await previous;
		try {
			if (signal?.aborted) throw signal.reason ?? new OperationalError('Codex request cancelled');
			return await action();
		} finally {
			release();
			if (operations.get(id) === lease) operations.delete(id);
		}
	})();
	if (!signal) return await task;
	let onAbort!: () => void;
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason ?? new OperationalError('Codex request cancelled'));
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
	try {
		return await Promise.race([task, cancelled]);
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
}

function fingerprint(account: CodexAccount): string {
	return createHash('sha256')
		.update(account.accessToken)
		.update('\0')
		.update(String(account.tokenData.refresh_token ?? ''))
		.update('\0')
		.update(String(account.tokenData.n8n_expires_at ?? ''))
		.digest('hex');
}

function errorInfo(error: unknown): { code?: string; status?: number; retryAfter?: number } {
	const e = object(error);
	const response = object(e?.response);
	const body = object(e?.body) ?? object(response?.data);
	const code =
		object(e?.failure)?.cause === 'credential-invalid'
			? 'invalid_grant'
			: (object(body?.error)?.code ?? body?.error ?? e?.code);
	const status = Number(e?.status ?? e?.statusCode ?? response?.status);
	const retryAfter = Number(object(response?.headers)?.['retry-after']);
	return {
		code: typeof code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? code : undefined,
		status: Number.isFinite(status) ? status : undefined,
		retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
	};
}

export class CodexAccountProvider {
	readonly id: string;
	private expectedAccount?: string;
	constructor(private readonly context: CredentialContext) {
		const id = context.getNode().credentials?.[CODEX_CREDENTIAL_TYPE]?.id;
		if (!id) throw new OperationalError('Select a Codex Account credential');
		this.id = id;
	}

	private async data(): Promise<ICredentialDataDecryptedObject> {
		return await this.context.getCredentials(CODEX_CREDENTIAL_TYPE);
	}

	private checked(data: ICredentialDataDecryptedObject): CodexAccount {
		const account = accountFromCredential(data);
		if (!account) throw new CodexCredentialError(pendingLoginMessage(data));
		if (this.expectedAccount && this.expectedAccount !== account.accountId)
			throw new CodexCredentialError(
				'The Codex credential account changed during execution; restart the execution',
			);
		this.expectedAccount = account.accountId;
		return account;
	}

	private async currentUnlocked(rejectedAccount?: CodexAccount): Promise<CodexAccount> {
		const data = await this.data();
		let account = this.checked(data);
		if (
			data.accessTokenUrl !== TOKEN_URL ||
			data.clientId !== CODEX_CLIENT_ID ||
			data.grantType !== 'pkce'
		)
			throw new CodexCredentialError(
				'Codex credential OAuth configuration is invalid; reconnect with a new Codex Account credential',
			);
		const failure = failures.get(this.id);
		if (failure && failure.fingerprint === fingerprint(account) && failure.until > Date.now())
			throw new CodexCredentialError(failure.message);
		if (failure && failure.fingerprint !== fingerprint(account)) failures.delete(this.id);
		if (rejectedAccount && fingerprint(rejectedAccount) !== fingerprint(account)) return account;
		if (!rejectedAccount && !needsRefresh(account)) return account;
		if (!account.tokenData.refresh_token) {
			const message = 'Codex Account has no refresh token; reconnect using Test step on this node';
			rememberFailure(this.id, {
				fingerprint: fingerprint(account),
				until: Infinity,
				reconnect: true,
				message,
			});
			throw new CodexCredentialError(message);
		}
		try {
			if (this.context.helpers.refreshOAuth2Token) {
				await this.context.helpers.refreshOAuth2Token.call(
					this.context as ISupplyDataFunctions,
					CODEX_CREDENTIAL_TYPE,
				);
			} else {
				throw new OperationalError(
					'This n8n runtime does not expose refreshOAuth2Token; use the supported n8n version',
				);
			}
			// Read back the stored credential. A returned token alone is not proof of persistence.
			const stored = this.checked(await this.data());
			if (
				stored.accessToken === account.accessToken &&
				stored.tokenData.refresh_token === account.tokenData.refresh_token &&
				stored.tokenData.n8n_expires_at === account.tokenData.n8n_expires_at
			)
				throw new OperationalError('Token refresh did not commit new token data');
			if (needsRefresh(stored))
				throw new OperationalError('Token refresh persisted an expired token');
			account = stored;
			failures.delete(this.id);
			return account;
		} catch (error) {
			// Another worker or a credential edit may have completed while this request failed.
			// Trust only a fresh persisted account, never the helper's returned token alone.
			const latest = this.checked(await this.data());
			if (fingerprint(latest) !== fingerprint(account) && !needsRefresh(latest)) {
				failures.delete(this.id);
				return latest;
			}
			const { code, status, retryAfter } = errorInfo(error);
			const reconnect = [
				'refresh_token_expired',
				'refresh_token_reused',
				'refresh_token_invalidated',
				'invalid_grant',
			].includes(code ?? '');
			const message = reconnect
				? 'Codex Account login expired or was revoked. Click Test step on this node to reconnect the selected credential.'
				: `Could not refresh and persist the Codex Account${status ? ` (HTTP ${status})` : ''}. Retry after the authentication cooldown.`;
			rememberFailure(this.id, {
				fingerprint: fingerprint(account),
				reconnect,
				message,
				until: reconnect
					? Infinity
					: Date.now() + Math.max(30_000, Math.min(300_000, (retryAfter ?? 0) * 1000)),
			});
			throw new CodexCredentialError(message);
		}
	}

	async current(signal?: AbortSignal): Promise<CodexAccount> {
		return await gated(this.id, () => this.currentUnlocked(), signal);
	}

	async request(options: IHttpRequestOptions): Promise<IN8nHttpFullResponse> {
		const url = assertCodexDestination(options.url, options.baseURL);
		const account = await this.current(options.abortSignal as AbortSignal | undefined);
		const send = async (auth: CodexAccount) =>
			(await this.context.helpers.httpRequest({
				...options,
				url,
				baseURL: undefined,
				headers: { ...options.headers, ...credentialHeaders(auth) },
				disableFollowRedirect: true,
				ignoreHttpStatusErrors: true,
				returnFullResponse: true,
			})) as IN8nHttpFullResponse;
		let response = await send(account);
		if (response.statusCode !== 401) return response;
		if (typeof object(response.body)?.destroy === 'function')
			(response.body as { destroy(): void }).destroy();
		const refreshed = await gated(
			this.id,
			() => this.currentUnlocked(account),
			options.abortSignal as AbortSignal | undefined,
		);
		response = await send(refreshed);
		if (response.statusCode === 401) {
			if (typeof object(response.body)?.destroy === 'function')
				(response.body as { destroy(): void }).destroy();
			const message =
				'Codex rejected the refreshed account token. Reconnect the selected credential using Test step.';
			rememberFailure(this.id, {
				fingerprint: fingerprint(refreshed),
				until: Infinity,
				reconnect: true,
				message,
			});
			throw new CodexCredentialError(message);
		}
		return response;
	}

	/** Explicit interactive operations only. Workflow inference never starts device login. */
	async testStep(): Promise<IDataObject> {
		return await gated(this.id, () => this.testStepUnlocked());
	}

	async transfer(
		seed: IDataObject,
		sourceKey: string,
		clearSource: () => Promise<void>,
	): Promise<IDataObject> {
		return await gated(this.id, async () => {
			let data = await this.data();
			const existing = accountFromCredential(data);
			if (existing) {
				if (data.migrationSource !== sourceKey || existing.accountId !== accountId(seed))
					throw new CodexCredentialError(
						'The selected credential is already configured for another transfer; select an empty transfer credential',
					);
			} else {
				await this.testStepUnlocked(seed, sourceKey);
			}
			data = await this.data();
			const stored = this.checked(data);
			if (
				data.migrationSource !== sourceKey ||
				stored.accountId !== accountId(seed) ||
				!stored.tokenData.refresh_token
			)
				throw new CodexCredentialError(
					'Transferred credential verification failed; source login retained',
				);
			await clearSource();
			return { status: 'authenticated', chatgpt_account_id: stored.accountId, transferred: true };
		});
	}

	private async testStepUnlocked(seed?: IDataObject, sourceKey?: string): Promise<IDataObject> {
		let data = await this.data();
		if (seed && accountFromCredential(data))
			throw new CodexCredentialError(
				'The selected Codex Account is already configured; select an empty transfer credential',
			);
		if (seed && data.setupMode !== 'transfer')
			throw new CodexCredentialError(
				'Create the target Codex Account with Transfer Existing Login selected',
			);
		let override: ICredentialDataDecryptedObject | undefined;
		if (seed) override = { ...data, migrationTokenSeed: seed, migrationSource: sourceKey ?? '' };
		else if (accountFromCredential(data)) {
			try {
				let account = await this.currentUnlocked();
				const probe = async () =>
					(await this.context.helpers.httpRequest({
						method: 'GET',
						url: CODEX_MODELS_URL,
						headers: credentialHeaders(account),
						json: true,
						timeout: 30_000,
						returnFullResponse: true,
						disableFollowRedirect: true,
						ignoreHttpStatusErrors: true,
					})) as IN8nHttpFullResponse;
				let response = await probe();
				if (response.statusCode === 401) {
					account = await this.currentUnlocked(account);
					response = await probe();
				}
				if (response.statusCode === 401)
					rememberFailure(this.id, {
						fingerprint: fingerprint(account),
						until: Infinity,
						reconnect: true,
						message: 'Codex login was rejected; reconnect using Test step',
					});
				if (response.statusCode !== 200)
					throw new CodexCredentialError('Codex account verification failed; retry Test step');
				return { status: 'authenticated', chatgpt_account_id: account.accountId };
			} catch (error) {
				if (!failures.get(this.id)?.reconnect) throw error;
				override = { ...data, setupMode: 'browser', oauthTokenData: '', deviceAuthState: '' };
			}
		}
		try {
			await this.context.helpers.httpRequestWithAuthentication.call(
				this.context as ISupplyDataFunctions,
				CODEX_CREDENTIAL_TYPE,
				{
					method: 'GET',
					url: CODEX_MODELS_URL,
					json: true,
					returnFullResponse: true,
					timeout: 30_000,
				},
				override
					? {
							credentialsDecrypted: {
								id: this.id,
								name: 'Codex Account',
								type: CODEX_CREDENTIAL_TYPE,
								data: override,
							},
						}
					: undefined,
			);
		} catch {
			data = await this.data();
			if (!object(data.deviceAuthState))
				throw new CodexCredentialError(
					'Codex Account sign-in or verification failed; retry Test step',
				);
		}
		data = await this.data();
		const account = accountFromCredential(data);
		if (account) {
			failures.delete(this.id);
			return { status: 'authenticated', chatgpt_account_id: account.accountId };
		}
		return {
			status: 'pending_verification',
			verification_url: `${ISSUER}/codex/device`,
			user_code: object(data.deviceAuthState)?.user_code ?? '',
			message: pendingLoginMessage(data),
		};
	}
}

function assertCodexDestination(url: string, baseURL?: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url, baseURL);
	} catch {
		throw new OperationalError('Invalid Codex request URL');
	}
	if (
		parsed.origin !== 'https://chatgpt.com' ||
		!['/backend-api/codex/models', '/backend-api/codex/responses'].includes(parsed.pathname) ||
		parsed.username ||
		parsed.password
	)
		throw new OperationalError(
			'Codex Account credentials can only authenticate Codex model and inference requests',
		);
	return parsed.href;
}

export async function authenticateCredential(
	data: ICredentialDataDecryptedObject,
	options: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const url = assertCodexDestination(options.url, options.baseURL);
	if (data.oauthTokenData === true)
		throw new OperationalError(
			'A saved Codex login is present. Verify live access or reconnect using Test step on a Codex node; this n8n credential dialog does not expose the stored OAuth tokens.',
		);
	const account = accountFromCredential(data);
	if (!account) throw new OperationalError(pendingLoginMessage(data));
	return {
		...options,
		url,
		baseURL: undefined,
		disableFollowRedirect: true,
		headers: { ...options.headers, ...credentialHeaders(account) },
	};
}

// Device authorization is bootstrap only. Native OAuth refresh calls this hook too;
// connected credentials must return no updates so a test cannot overwrite rotated tokens.
export async function prepareCredential(
	context: IHttpRequestHelper,
	data: ICredentialDataDecryptedObject,
): Promise<IDataObject> {
	// n8n deliberately replaces this blob with true in the credential editor.
	// Its test path passes that flag through instead of restoring the stored tokens.
	// Never treat the flag as an empty login: that would erase a valid account.
	if (data.oauthTokenData === true || accountFromCredential(data)) return {};
	const seed = object(data.migrationTokenSeed);
	if (seed) {
		if (
			data.setupMode !== 'transfer' ||
			!seed.access_token ||
			!seed.refresh_token ||
			!accountId(seed)
		)
			throw new OperationalError(
				'A complete existing login and an empty transfer credential are required',
			);
		return {
			authInitialized: '',
			oauthTokenData: { ...seed, token_type: 'Bearer' },
			deviceAuthState: null,
			migrationTokenSeed: null,
			migrationSource: typeof data.migrationSource === 'string' ? data.migrationSource : '',
			clientId: CODEX_CLIENT_ID,
			grantType: 'pkce',
			accessTokenUrl: TOKEN_URL,
		};
	}
	if (data.setupMode === 'transfer')
		throw new OperationalError(
			'Select this credential on the existing Codex node, then use Transfer Existing Login and Test step',
		);
	let device = object(data.deviceAuthState) as DeviceState | undefined;
	if (
		device &&
		(typeof device.device_auth_id !== 'string' ||
			typeof device.user_code !== 'string' ||
			![device.issued_at, device.next_poll_at, device.interval_ms].every(
				(value) => typeof value === 'number' && Number.isFinite(value),
			) ||
			device.interval_ms <= 0)
	)
		device = undefined;
	const request = async (
		url: string,
		body: IDataObject | URLSearchParams,
	): Promise<IN8nHttpFullResponse> => {
		try {
			return (await context.helpers.httpRequest({
				method: 'POST',
				url,
				body: body instanceof URLSearchParams ? body.toString() : body,
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				disableFollowRedirect: true,
				headers: {
					'Content-Type':
						body instanceof URLSearchParams
							? 'application/x-www-form-urlencoded'
							: 'application/json',
				},
				timeout: 30_000,
			})) as IN8nHttpFullResponse;
		} catch {
			throw new OperationalError('Codex device authorization request failed; retry Save/Test');
		}
	};
	if (!device?.device_auth_id || Date.now() - device.issued_at >= DEVICE_TTL) {
		const response = await request(`${ISSUER}/api/accounts/deviceauth/usercode`, {
			client_id: CODEX_CLIENT_ID,
		});
		const body = object(response.body);
		if (
			response.statusCode !== 200 ||
			typeof body?.device_auth_id !== 'string' ||
			typeof (body.user_code ?? body.usercode) !== 'string'
		)
			throw new OperationalError('Could not start Codex device login; retry Save/Test');
		const seconds = Number(body.interval);
		const interval =
			Number.isFinite(seconds) && seconds > 0
				? Math.max(1000, Math.min(300_000, seconds * 1000))
				: 5000;
		device = {
			device_auth_id: body.device_auth_id,
			user_code: String(body.user_code ?? body.usercode),
			issued_at: Date.now(),
			next_poll_at: Date.now() + interval,
			interval_ms: interval,
		};
	} else if (Date.now() >= device.next_poll_at) {
		const poll = await request(`${ISSUER}/api/accounts/deviceauth/token`, {
			device_auth_id: device.device_auth_id,
			user_code: device.user_code,
		});
		if (poll.statusCode === 200) {
			const body = object(poll.body);
			if (typeof body?.authorization_code !== 'string' || typeof body.code_verifier !== 'string')
				throw new OperationalError('Codex device authorization returned an invalid response');
			const exchange = await request(
				TOKEN_URL,
				new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: CODEX_CLIENT_ID,
					code: body.authorization_code,
					code_verifier: body.code_verifier,
					redirect_uri: `${ISSUER}/deviceauth/callback`,
				}),
			);
			const tokens = object(exchange.body);
			if (
				exchange.statusCode !== 200 ||
				typeof tokens?.access_token !== 'string' ||
				typeof tokens.refresh_token !== 'string' ||
				!accountId(tokens)
			)
				throw new OperationalError('Codex token exchange failed; retry login');
			return {
				setupMode: 'browser',
				authInitialized: '',
				oauthTokenData: {
					...tokens,
					...(Number(tokens.expires_in) > 0
						? { n8n_expires_at: String(Date.now() + Number(tokens.expires_in) * 1000) }
						: {}),
					token_type: 'Bearer',
					account_id: accountId(tokens)!,
				},
				deviceAuthState: null,
				clientId: CODEX_CLIENT_ID,
				grantType: 'pkce',
				accessTokenUrl: TOKEN_URL,
			};
		}
		if (![403, 404, 429].includes(poll.statusCode))
			throw new OperationalError('Codex device login could not be verified; retry');
		device = {
			...device,
			next_poll_at:
				Date.now() +
				(poll.statusCode === 429 ? Math.max(device.interval_ms, 30_000) : device.interval_ms),
		};
	}
	return {
		setupMode: 'browser',
		authInitialized: '',
		deviceAuthState: device,
		oauthTokenData: null,
	};
}

export const credentialTokenDefault = CREDENTIAL_EMPTY_VALUE;

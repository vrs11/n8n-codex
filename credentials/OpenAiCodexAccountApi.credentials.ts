import type {
	IAuthenticate,
	ICredentialType,
	IHttpRequestHelper,
	INodeProperties,
	ICredentialDataDecryptedObject,
} from 'n8n-workflow';
import {
	CODEX_CLIENT_ID,
	authenticateCredential,
	prepareCredential,
	credentialTokenDefault,
} from '../nodes/OpenAiCodexChatModel/codex-credentials';

export class OpenAiCodexAccountApi implements ICredentialType {
	name = 'openAiCodexAccountApi';
	// OAuth account credentials are not API keys.
	// eslint-disable-next-line n8n-nodes-base/cred-class-field-display-name-missing-api
	displayName = 'Codex Account';
	icon = {
		light: 'file:../icons/openAiCodex.svg',
		dark: 'file:../icons/openAiCodex.dark.svg',
	} as const;
	documentationUrl = 'https://github.com/vrs11/n8n-codex';
	// Token lifecycle is supplied by the Codex model, not the generic HTTP Request node.
	httpRequestNode = {
		name: 'Codex',
		docsUrl: 'https://github.com/vrs11/n8n-codex',
		apiBaseUrl: 'https://chatgpt.com/backend-api/codex',
		hidden: true,
	};
	test = {
		request: {
			method: 'GET' as const,
			baseURL: 'https://chatgpt.com',
			url: '/backend-api/codex/models?client_version=0.162.1',
		},
	};
	properties: INodeProperties[] = [
		{
			displayName:
				'Save this credential, select it on an OpenAI codex node, then use Test step to sign in, verify access or reconnect. Initial device sign-in also supports Save/Test and Retry. Reuse this credential across Codex nodes.',
			name: 'loginHelp',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Account Setup',
			name: 'setupMode',
			type: 'options',
			default: 'browser',
			options: [
				{ name: 'Sign In With Browser', value: 'browser' },
				{ name: 'Transfer Existing Login', value: 'transfer' },
			],
		},
		{
			displayName: 'Authentication Initialization',
			name: 'authInitialized',
			type: 'hidden',
			typeOptions: { expirable: true },
			default: '',
		},
		{
			displayName: 'Token Data',
			name: 'oauthTokenData',
			type: 'hidden',
			typeOptions: { password: true },
			default: credentialTokenDefault,
			noDataExpression: true,
		},
		// The device identifier is private authorization state.
		// eslint-disable-next-line @n8n/community-nodes/credential-unnecessary-password
		{
			displayName: 'Device Authorization',
			name: 'deviceAuthState',
			type: 'hidden',
			typeOptions: { password: true },
			default: credentialTokenDefault,
			noDataExpression: true,
		},
		{
			displayName: 'Transfer Source',
			name: 'migrationSource',
			type: 'hidden',
			default: credentialTokenDefault,
			noDataExpression: true,
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'hidden',
			default: CODEX_CLIENT_ID,
			noDataExpression: true,
		},
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'pkce',
			noDataExpression: true,
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: 'https://auth.openai.com/oauth/token',
			noDataExpression: true,
		},
	];
	authenticate: IAuthenticate = authenticateCredential;
	async preAuthentication(this: IHttpRequestHelper, credentials: ICredentialDataDecryptedObject) {
		return await prepareCredential(this, credentials);
	}
}

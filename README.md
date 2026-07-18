# n8n-nodes-openai-codex

Community n8n AI Chat Model node for the ChatGPT Codex backend.

## Installation

Follow n8n community node installation docs:

- https://docs.n8n.io/integrations/community-nodes/installation/

## Features

- Node name: `OpenAI codex`
- Type: AI Language Model root node (`ai_languageModel`)
- Device-code login flow compatible with Codex-style auth endpoints
- Auth state persisted on disk and reused across runs
- Owner-only auth-state files (`0600` on POSIX); secrets are not stored in workflow static data
- Automatic token refresh before expiry and one refresh/retry after a `401`
- Authoritative dynamic model catalog from backend `/models`, with the current Codex CLI catalog as offline fallback
- Current GPT-5.6 Responses Lite request format
- Model-aware reasoning effort and summary, verbosity, service tier, and parallel tool-call controls
- Tool-calling support for n8n AI Agent (exact tool-name preservation)
- Text and image inputs; audio follows Codex CLI behavior and is represented as unsupported
- Full conversation history supplied by n8n Agent/Memory
- Strict model-to-reasoning validation (invalid model/effort combinations are rejected)
- Runtime model-substitution guard (throws if backend returns a different model slug)

## Login Flow

1. Add the `OpenAI codex` node.
2. Click **Test step**.
3. If login is required, the node output/error contains:
   - verification URL
   - user code
4. Complete login in the browser, then click **Test step** again.

## Persistence

- Default auth state path: `$N8N_USER_FOLDER/openai-codex-state`
- Fallback path: `~/.n8n/openai-codex-state`
- Override path: `N8N_OPENAI_CODEX_STATE_DIR=/absolute/path`
- Older releases may have copied auth into workflow static data. The next successful state save migrates it to the local state file and removes the static-data copy.

## Conversation Context

The current Codex Responses request sends the complete input history and does not use `previous_response_id`. Connect an n8n Memory node when conversations must persist across workflow executions. Legacy `Context Mode` and `Session Key` workflow values are ignored after upgrading.

## Backend Defaults

- Base URL: `https://chatgpt.com/backend-api/codex`
- Originator header: `codex_cli_rs`
- Codex compatibility version: `0.145.0`

Optional environment variables:

- `N8N_OPENAI_CODEX_CLIENT_VERSION`: override the compatibility version sent to `/models`
- `N8N_OPENAI_CODEX_ALLOW_PARALLEL_TOOLS=false`: force serial tool calls
- `CODEX_APP_SERVER_LOGIN_CLIENT_ID`: override the OAuth device-login client ID
- `CODEX_REFRESH_TOKEN_URL_OVERRIDE`: override the OAuth refresh endpoint

## Model Identity Note

- Asking the model "what model are you?" is not a reliable identity check.
- Use backend metadata (`response.model`) instead.
- This node validates backend-returned model slug against the requested model and fails fast on mismatch.

## Development

```bash
pnpm install
pnpm lint
pnpm build
```

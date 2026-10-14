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
- Current Responses and Responses Lite request formats, including namespaced function tools
- Model-aware reasoning effort and summary, verbosity, service tier, and parallel tool-call controls
- Tool-calling support for n8n AI Agent (exact tool-name preservation)
- Text, image, and audio inputs, including image URLs and binary/base64 media
- Full conversation history supplied by n8n Agent/Memory, with encrypted reasoning and assistant-message phases preserved
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
- Codex compatibility version: `0.162.1`

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
pnpm typecheck
pnpm test
```

## Compatibility baseline (0.3.0)

Reviewed on 2026-10-15 against freshly pulled upstream code:

| Source | Commit | Version baseline |
| --- | --- | --- |
| n8n `master` | `e2529a849432bdb3082615c04b1702df61cb91d5` | n8n/workflow 2.44; AI SDK 0.34; node CLI 0.53 |
| Codex `main` | `d292f721242ef355ce5a38da90e0e33edc4790e6` | CLI compatibility header 0.162.1 |

The installed development dependencies resolve to `@n8n/ai-node-sdk` 0.34.1, `@n8n/node-cli` 0.53.1, and `n8n-workflow` 2.44.1. Use n8n 2.44 or newer for this release. The local Compose setup now defaults to n8n 2.44.1.

Changes from 0.2.0:

- Both request formats send instructions as developer messages. Model instruction templates are read from `model_messages.instructions_template`, with support for the legacy field.
- Responses Lite groups n8n tools in the `functions` namespace and retains that namespace when replaying tool calls. Empty tool lists omit `additional_tools`.
- The offline model catalog includes GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, and GPT-6 Luna with the CLI's reasoning and service-tier metadata. Live backend catalogs determine the model picker; missing metadata can fall back to the bundled catalog. The catalog is not an account entitlement check.
- New version 2 nodes default to GPT-6.1 Sol. Saved model selections remain intact, and version 1 nodes with no stored selection retain GPT-5.6 Sol.
- Audio inputs use `input_audio`. Available modalities still depend on the selected model and backend.
- Conversation history preserves encrypted reasoning and message phases using n8n provider-content blocks. Reasoning summaries are not replayed as assistant text.
- Stream errors, failed/incomplete responses, truncated streams, and streamed HTTP error bodies produce errors. Completed output items remain available when terminal events omit output. Refreshed authorization headers are reused on subsequent turns.

This integration provides an n8n chat model using the Codex backend. Tools come from the n8n AI Agent. Codex CLI shell execution, local sandbox policies, and its full agent harness are separate functionality. The bundled catalog omits CLI-specific tool instructions; n8n system messages provide workflow instructions.

To refresh the offline catalog after pulling Codex:

```bash
pnpm sync:models
# Or supply a different Codex checkout:
pnpm sync:models /absolute/path/to/codex
pnpm test
```

Compatibility tests use mocked HTTP/SSE responses and temporary auth files. They cover request formats, model defaults, media, history replay, tool calls, refresh/persistence, errors, and device login without live model calls. Live ChatGPT inference requires an authenticated account.

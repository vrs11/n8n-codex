# n8n-nodes-openai-codex

Community n8n AI Chat Model node: **OpenAI codex**.

## Installation

Follow n8n community node installation docs:

- https://docs.n8n.io/integrations/community-nodes/installation/

## Features

- Node name: `OpenAI codex`
- Type: AI Language Model root node (`ai_languageModel`)
- Device-code login flow compatible with Codex-style auth endpoints
- Auth state persisted on disk and reused across runs
- Automatic token refresh (proactive refresh before expiry)
- Model selection with reasoning-effort selection per model capability
- Tool-calling support for n8n AI Agent (exact tool-name preservation)
- Explicit context strategy switch: `Memory Only` or `Backend Chain (previous_response_id)`
- Strict model-to-reasoning validation (invalid model/effort combinations are rejected)

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

## Context Strategy

- `Memory Only (n8n Memory)`:
  - `previous_response_id` is disabled.
  - Use n8n Memory nodes (Simple/Redis/Postgres/Mongo/etc.) as context source.
- `Backend Chain (previous_response_id)`:
  - `Session Key` is required.
  - The node stores and reuses `previous_response_id` per `Session Key`.
  - Use a stable key per conversation/user (for example `={{ $json.userId }}`).

Use one strategy at a time to avoid redundant context.

## Backend Defaults

- Base URL: `https://chatgpt.com/backend-api/codex`
- Originator header: `codex_cli_rs`

## Development

```bash
pnpm install
pnpm lint
pnpm build
```

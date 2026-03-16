# n8n-nodes-openai-codex

Community n8n AI Chat Model node: **OpenAI codex**.

## Installation

Follow n8n community node installation docs:

- https://docs.n8n.io/integrations/community-nodes/installation/

## OpenAI codex (LLM Node)

- **Display name:** `OpenAI codex`
- **Type:** AI Language Model root node (`ai_languageModel`)
- **Visible config fields:** Authentication notice only

How login works:

- Click **Test step** on the node.
- If not authenticated, node output returns a device-login message with:
  - verification URL
  - user code
- Complete login in browser, then click **Test step** again.

What the node does:

- Starts Codex-style **device code login** when no saved auth exists
  - requests code from `https://auth.openai.com/api/accounts/deviceauth/usercode`
  - shows verification instructions in node error output
  - polls `https://auth.openai.com/api/accounts/deviceauth/token`
  - exchanges authorization code at `https://auth.openai.com/oauth/token`
- Persists token/device state in filesystem + workflow static data (survives restarts and manual test runs)
- Uses direct filesystem persistence (default: `$N8N_USER_FOLDER/openai-codex-state`, fallback `~/.n8n/openai-codex-state`)
- Optional override: `N8N_OPENAI_CODEX_STATE_DIR=/absolute/path`
- Proactively refreshes token when access token is near expiry or last refresh is stale
- If a request still fails with `401`, node returns backend error details (code/message) and keeps stored state
- Uses Codex defaults:
  - Base URL: `https://chatgpt.com/backend-api/codex`
  - Originator header: `codex_cli_rs`
  - Model: `gpt-5-codex`

## Development

```bash
pnpm install
pnpm lint
pnpm build
```

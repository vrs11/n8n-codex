# n8n-nodes-openai-codex

Community n8n AI Chat Model node for the ChatGPT Codex backend.

## Installation

Use Node.js 24 or newer to build this package. The tested runtime is n8n 2.44.1 with AI SDK 0.34.1.

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
- Native strict JSON Schema output, with automatic AI Agent parser detection on version 3 nodes

## Login Flow

1. Add the `OpenAI codex` node.
2. Click **Test step**.
3. If login is required, the node output/error contains:
   - verification URL
   - user code
4. Complete login in the browser, then click **Test step** again.

If the login expires or is revoked, workflow execution reports that sign-in is required. Click **Test step** on the same Codex node to obtain a fresh verification URL/code. Temporary authentication-service failures preserve the existing login.

## Persistence

- With `N8N_USER_FOLDER` configured: `$N8N_USER_FOLDER/.n8n/openai-codex-state` (matching n8n's folder semantics)
- Fallback path: `~/.n8n/openai-codex-state`
- Override path: `N8N_OPENAI_CODEX_STATE_DIR=/absolute/path`
- The earlier `$N8N_USER_FOLDER/openai-codex-state` location is read for migration when the new file does not exist.
- Updates for the same workflow/node are serialized within one n8n process, including token rotation and catalog saves. Sharing a state directory between multiple n8n processes is currently unsupported; there is no cross-process lock.
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
pnpm install --frozen-lockfile --ignore-scripts
pnpm lint
pnpm typecheck
pnpm test
pnpm test:docker
```

`test:docker` checks the compiled artifact in the pinned n8n image, with networking disabled and without host `node_modules`. It requires Docker. Live tests are separate and opt-in; see below.

## Compatibility baseline (0.3.0)

Reviewed on 2026-10-15 against freshly pulled upstream code:

| Source | Commit | Version baseline |
| --- | --- | --- |
| n8n `master` | `e2529a849432bdb3082615c04b1702df61cb91d5` | n8n/workflow 2.44; AI SDK 0.34; node CLI 0.53 |
| Codex `main` | `d292f721242ef355ce5a38da90e0e33edc4790e6` | CLI compatibility header 0.162.1 |

The installed development dependencies resolve to `@n8n/ai-node-sdk` 0.34.1, `@n8n/node-cli` 0.53.1, and `n8n-workflow` 2.44.1. The minimum baseline is n8n 2.44. The adapter targets AI SDK 0.34.x; its peer range excludes later SDK minor versions until their adapter contracts are checked. The local Compose setup now defaults to n8n 2.44.1.

Changes from 0.2.0:

- Both request formats send instructions as developer messages. Model instruction templates are read from `model_messages.instructions_template`, with support for the legacy field.
- Responses Lite groups n8n tools in the `functions` namespace and retains that namespace when replaying tool calls. Empty tool lists omit `additional_tools`.
- The offline model catalog includes GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, and GPT-6 Luna with the CLI's reasoning and service-tier metadata. Live backend catalogs determine the model picker; missing metadata can fall back to the bundled catalog. The catalog is not an account entitlement check.
- New version 2 nodes default to GPT-6.1 Sol. Saved model selections remain intact, and version 1 nodes with no stored selection retain GPT-5.6 Sol.
- Version 3 nodes retain the GPT-6.1 Sol default and automatically enforce a connected AI Agent output parser. Version 1/2 workflows retain Text mode unless explicitly changed.
- Audio inputs use `input_audio`. Available modalities still depend on the selected model and backend.
- Conversation history preserves encrypted reasoning and message phases using n8n provider-content blocks internally and opaque message metadata at the public LangChain boundary. Reasoning summaries are not replayed as assistant text.
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

## Native strict output

For an AI Agent, enable **Require Specific Output Format**, connect a **Structured Output Parser**, and define the required output there. New Codex nodes use **Automatic** and obtain the schema themselves. No second schema or model setting is needed. For existing version 1/2 nodes, select **Automatic** once to enable this behavior.

The model's **Output Format** setting also provides explicit overrides:

| Mode | Configuration and behavior |
| --- | --- |
| **Automatic** (version 3 default) | Detects the connected AI Agent parser, enforces its formatting-tool arguments and final JSON natively, and allows ordinary tools to run first. Without a parser, uses normal text behavior. Unsupported strict schemas fail before inference. |
| **Text** (version 1/2 default) | Leaves output formatting to n8n without native schema enforcement. Use this explicitly if a parser requires schema features outside the backend's strict subset. |
| **Agent Output Parser (Strict)** | On the AI Agent, enable **Require Specific Output Format** and connect a **Structured Output Parser**. The model obtains its schema from n8n's `format_final_json_response` tool, applies `strict: true` to that tool, and sends the same schema in `text.format` as strict JSON Schema. Regular tools can run before the final response. |
| **JSON Schema (Strict)** | Enter **Output Schema** and an optional **Output Schema Name** on the model. This works with Basic LLM Chain and other model consumers without a separate output parser. The model advertises JSON output metadata so Basic LLM Chain returns a parsed object. |

n8n gives a custom model control over its HTTP request, tool binding, model settings and LangChain interface. Its Agent passes the connected parser schema in a formatting tool; Basic LLM Chain only supplies formatting instructions and applies its parser afterward. The model cannot obtain a Chain parser's schema from that prompt reliably, so configure it explicitly on the model. No changes to n8n itself are required.

For a simple chain, select **JSON Schema (Strict)** and enter:

```json
{
  "type": "object",
  "properties": {
    "answer": { "type": "string" },
    "confidence": { "type": ["number", "null"], "minimum": 0, "maximum": 1 }
  },
  "required": ["answer", "confidence"],
  "additionalProperties": false
}
```

A separate Chain output parser is optional because native mode also validates the completed response locally. If you retain n8n's Structured Output Parser, the model's schema must match the parser's wire format, including its outer `output` property: `{ "type": "object", "properties": { "output": YOUR_SCHEMA }, "required": ["output"], "additionalProperties": false }`. Agent mode obtains that wrapper automatically from n8n.

If an Agent has both an explicit model schema and a parser, their schemas must match; conflicting schemas produce an error. Prefer Automatic for Agents to keep the parser as the single schema definition.

Strict mode requires an object root and every declared property to be required. Declare nullable required fields explicitly for values that may be absent. The node closes objects with `additionalProperties: false`; explicitly free-form objects, optional properties, unsupported schema keywords/formats, and recursive schemas produce errors before inference. It does not silently convert optional fields into required nullable fields. Regular non-strict tool schemas keep their existing optional-argument behavior.

Requests use the Codex CLI's native `text.format` shape with `type: "json_schema"` and `strict: true`. There is no automatic fallback to prompt-only formatting. Completed JSON and strict tool arguments are validated locally; refusals, incomplete responses and schema violations produce explicit errors. Strict JSON text is buffered until completion and validation, so partial JSON is not exposed to downstream consumers. Reasoning and tool turns remain available.

Programmatic consumers can use `withStructuredOutput(schema, { method: 'jsonSchema' })`, which now defaults to strict enforcement, or pass a strict `response_format`. Explicit `strict: false` remains available programmatically. `includeRaw` retains parsing errors; refusal/transport failures still propagate.

The [official OpenAI Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) describes native strict mode and its supported schema subset. The selected ChatGPT Codex model/backend must support this request format. Schema enforcement guarantees structure, not factual correctness.

## Tool schema conversion

The adapter converts Zod 3, Zod 4, and JSON Schema inputs without relying on constructor identity. Separate Zod module installations preserve named arguments, nested objects/arrays, numeric and boolean types, enums, constraints, and optional/default fields. Primitive text schemas remain wrapped as an `input` argument for Calculator-style tools.

Zod input transforms (including the real Calculator schema), object discriminated unions, and nonrecursive local JSON Schema references are supported. Raw JSON Schema retains its open-object semantics unless `additionalProperties` is explicitly constrained.

Unsupported, unconstrained, malformed, or recursive schemas fail before inference with the tool name and conversion error. External JSON Schema references, references with validation siblings, and top-level compositions that cannot be identified as objects are rejected. Custom Zod refinements still run when n8n invokes the original tool; JSON Schema cannot express arbitrary JavaScript validation.

`pnpm build` bundles the schema converters into `dist/nodes/OpenAiCodexChatModel/tool-schema.js`, and the JSON Schema validator, including third-party license notices in `dist`. Only n8n's own `n8n-workflow` package remains external. Use the full build command before deploying; a plain `tsc` build does not bundle the converters.

Conversion uses the [Zod JSON Schema API](https://zod.dev/json-schema) for Zod 4 and [zod-to-json-schema](https://github.com/StefanTerdell/zod-to-json-schema) for Zod 3. Regression tests load a real separate Zod installation and check both conversion and rejection paths.


## Integration audit and verified coverage

The 2026-10-15 audit found correctness gaps in both the node and the SDK adapter it used. Existing tests mostly called the underlying model directly and missed behavior at the public LangChain interface. The adapter now keeps n8n tracing while correcting these paths:

| Issue found | Result after correction |
| --- | --- |
| Tool schemas lost across Zod copies; Calculator transforms rejected | Convert schema inputs structurally; preserve named arguments and input transforms; reject unsupported schemas explicitly |
| `bindTools` options ignored and repeated bindings duplicated tools | Preserve forced choice, strictness and parallel-call options; replace the previous tool list |
| Every streamed tool call used index zero | Assign distinct indices so LangChain aggregation preserves independent calls |
| Malformed arguments became `{}`; calls could escape failed streams | Validate object arguments, names, IDs, advertised tools and terminal status before exposing tool calls |
| Replay records entered visible content and broke standard text output parsers | Keep opaque replay records in message metadata and restore them for subsequent model turns |
| Structured output depended on incomplete SDK defaults | Support function calling, native JSON Schema, JSON mode, Zod parsing and `includeRaw`, including streaming |
| Legacy images, audio and tool-result media were lost | Normalize supported content before SDK conversion and send structured tool-result content |
| Concurrent token refreshes could rotate twice or overwrite newer credentials | Serialize state transactions; reuse tokens already refreshed by another execution; persist before deleting legacy credentials |
| Error diagnostics automatically included prompt excerpts | Payload diagnostics are opt-in via `N8N_OPENAI_CODEX_DEBUG_PAYLOADS=true` |
| Loose model-name comparisons accepted unrelated variants | Accept exact model IDs and dated snapshots only |
| Rate limits lacked bounded retry handling | Honor `maxRetries` (0–5, default 2) for transient HTTP statuses before a successful stream; honor cancellation and bounded Retry-After delays |

Regression coverage uses the actual installed n8n SDK, LangChain Calculator, DynamicStructuredTool, AgentExecutor, BufferMemory, prompt chains, text/structured output parsers and n8n tracing. Tests exercise public `invoke`, `stream`, repeated tool binding, structured output, memory/history replay, multiple calls, foreign Zod 3/4 copies, MCP-style schemas and media, cancellation, authentication races, and disk-write failures. HTTP/SSE responses are mocked. These are contract tests, not a claim that every n8n integration has been executed against a live account.

## Capability boundaries

- Supported connections are n8n chat-model consumers and function tools: agents, chains, output parsers, memory, and tools supplied through the n8n/LangChain function-tool contract. A tool's remote service, credentials and own implementation remain its responsibility.
- Provider-hosted tools such as another provider's native search or code interpreter are not interchangeable with n8n function tools. They fail explicitly. Use the equivalent n8n tool node.
- Text, images, audio, and embedded MCP text/image resources are converted. PDF/video/file-ID inputs require preprocessing into supported content; unsupported content produces an error. The selected model must support the requested modality.
- Arbitrary sampling settings, token limits and stop sequences are not supported by this Codex transport. Supplying them produces an explicit error.
- Strict structured output requires a schema supported by the backend's strict mode. The node preserves optional arguments rather than silently making every property required. Zod output schemas also receive local parsing/validation; plain JSON Schema structured output also receives local validation.
- The legacy reasoning-effort value `none` means no effort override, not disabled reasoning. Its UI label is now **No Effort Override**.
- Authentication files are local to this n8n installation. Multi-process/shared-directory authentication needs cross-process coordination before it can be supported.
- A full `pnpm build` is required for deployment. `build:watch`/plain TypeScript output alone is not a production artifact because the schema converters must be bundled.

All **128 Docker regression/integration tests passed** with no skipped tests. This suite checks actual n8n Agent/Chain/parser implementations, including automatic formatter detection, final JSON text, forced tools, conflicting schemas, strict validation and login recovery. Run it with `pnpm test:docker`. On the Node 24 host, **123 tests passed**; five cases requiring the full installed n8n runtime and two opt-in live cases were skipped. The container uses Node 26.10.0, `@n8n/ai-node-sdk` 0.34.1, `@n8n/ai-utilities` 0.37.1, `n8n-workflow` 2.44.1, and Zod 3.25.76. Registration includes node versions 1, 2 and 3.

Live account tests separately exercise strict JSON through the installed Basic LLM Chain and an Agent that calls a read-only tool with named string, integer and boolean arguments before returning its parsed result. Live testing on 2026-10-15 passed both cases with GPT-6.1 Sol and GPT-5.6 Sol. The account catalog currently advertises Responses Lite models; standard Responses remains covered by mocked contract tests rather than live inference.

To rerun live tests in an n8n container, place `tests/live-output.test.cjs` beside the compiled `dist` directory and set `NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules`, `CODEX_TEST_LIVE=true`, `CODEX_LIVE_WORKFLOW_ID`, `CODEX_LIVE_NODE_ID`, and `N8N_OPENAI_CODEX_STATE_DIR` to the existing authenticated node's values. Run `node --test --test-concurrency=1 tests/live-output.test.cjs`. `CODEX_LIVE_MODELS` accepts a comma-separated list of model IDs; its default is `gpt-6.1-sol`. Tests make real model calls, use synthetic test data, and save refreshed tokens to the original login file. Run these while that workflow is idle; shared login state across concurrent n8n processes is unsupported.

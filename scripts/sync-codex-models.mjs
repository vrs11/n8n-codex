import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] ?? resolve(root, '../codex'));
const keys = [
	'slug',
	'display_name',
	'description',
	'priority',
	'visibility',
	'supported_in_api',
	'supports_parallel_tool_calls',
	'supported_reasoning_levels',
	'default_reasoning_level',
	'supports_reasoning_summary_parameter',
	'default_reasoning_summary',
	'support_verbosity',
	'default_verbosity',
	'service_tiers',
	'default_service_tier',
	'use_responses_lite',
];
const catalog = JSON.parse(
	readFileSync(resolve(source, 'codex-rs/models-manager/models.json'), 'utf8'),
);
const snapshot = {
	sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: source,
		encoding: 'utf8',
	}).trim(),
	models: catalog.models
		.map((model) =>
			Object.fromEntries(keys.filter((key) => key in model).map((key) => [key, model[key]])),
		)
		.sort((a, b) => a.priority - b.priority),
};
// CLI harness instructions describe local tools that an n8n chat model does not provide.
writeFileSync(
	resolve(root, 'nodes/OpenAiCodexChatModel/fallback-models.json'),
	`${JSON.stringify(snapshot, null, '\t')}\n`,
);
console.log(`Synced ${snapshot.models.length} models from ${snapshot.sourceCommit}`);

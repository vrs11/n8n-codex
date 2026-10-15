import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(resolve(root, 'dist/nodes/OpenAiCodexChatModel/OpenAiCodexChatModel.node.js'))) {
	throw new Error('Run pnpm build before testing the packaged artifact');
}
// Mount only the artifact and tests. Host dependencies cannot hide missing runtime imports.
const result = spawnSync(
	'docker',
	[
		'run',
		'--rm',
		'--network',
		'none',
		'--entrypoint',
		'node',
		'--mount',
		`type=bind,source=${resolve(root, 'dist')},target=/opt/codex-test/dist,readonly`,
		'--mount',
		`type=bind,source=${resolve(root, 'dist/nodes')},target=/opt/codex-test/nodes,readonly`,
		'--mount',
		`type=bind,source=${resolve(root, 'tests')},target=/opt/codex-test/tests,readonly`,
		'-e',
		'NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules',
		'-e',
		'CODEX_TEST_N8N_RUNTIME=true',
		process.env.N8N_IMAGE || 'ghcr.io/n8n-io/n8n:2.44.1',
		'--test',
		'/opt/codex-test/tests/compatibility.test.cjs',
		'/opt/codex-test/tests/n8n-runtime.test.cjs',
	],
	{ stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

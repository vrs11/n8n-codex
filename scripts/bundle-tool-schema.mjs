import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const result = await build({
	absWorkingDir: root,
	entryPoints: ['nodes/OpenAiCodexChatModel/tool-schema.ts'],
	outfile: 'dist/nodes/OpenAiCodexChatModel/tool-schema.js',
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	external: ['n8n-workflow'],
	sourcemap: true,
	metafile: true,
});
for (const output of Object.values(result.metafile.outputs)) {
	for (const entry of output.imports) {
		if (entry.external && entry.path !== 'n8n-workflow')
			throw new Error(`Unbundled dependency: ${entry.path}`);
	}
}
const notices = await Promise.all(
	['zod', 'zod-to-json-schema'].map(async (name) => {
		let directory = dirname(require.resolve(name));
		while (!existsSync(join(directory, 'LICENSE'))) {
			const parent = dirname(directory);
			if (parent === directory) throw new Error(`License not found for ${name}`);
			directory = parent;
		}
		return `${name}\n${await readFile(join(directory, 'LICENSE'), 'utf8')}`;
	}),
);
await writeFile(join(root, 'dist/THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'));
console.log('Bundled tool-schema converters into dist');

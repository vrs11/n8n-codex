import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
// Include licenses for every bundled package, including validator dependencies.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
	if (!input.startsWith('node_modules/')) continue;
	let directory = dirname(resolve(root, input));
	while (directory !== dirname(directory)) {
		const manifest = join(directory, 'package.json');
		if (existsSync(manifest)) {
			const metadata = JSON.parse(await readFile(manifest, 'utf8'));
			if (metadata.name) {
				packages.set(directory, metadata);
				break;
			}
		}
		directory = dirname(directory);
	}
}
const notices = await Promise.all(
	[...packages.entries()]
		.sort(([, a], [, b]) => a.name.localeCompare(b.name))
		.map(async ([directory, metadata]) => {
			const filename = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md'].find(
				(name) => existsSync(join(directory, name)),
			);
			if (!filename) throw new Error(`License not found for ${metadata.name}`);
			return `${metadata.name}@${metadata.version}\n${await readFile(join(directory, filename), 'utf8')}`;
		}),
);
await writeFile(join(root, 'dist/THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'));
console.log('Bundled tool-schema converters into dist');

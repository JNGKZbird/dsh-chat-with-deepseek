// Bundle the offline Shiki runtime into app/vendor/shiki.
// Usage: npm install && node build.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.resolve(here, '../../app/vendor/shiki');

fs.rmSync(outdir, { recursive: true, force: true });

const result = await build({
  entryPoints: [path.join(here, 'entry.mjs')],
  outdir,
  bundle: true,
  format: 'esm',
  splitting: true,
  minify: true,
  target: ['chrome120'],
  entryNames: 'shiki',
  chunkNames: 'chunks/[name]-[hash]',
  legalComments: 'none',
  metafile: true,
});

const outputs = Object.entries(result.metafile.outputs)
  .map(([file, meta]) => [path.relative(outdir, path.resolve(here, file)), meta.bytes])
  .sort((a, b) => b[1] - a[1]);
let total = 0;
for (const [, bytes] of outputs) total += bytes;
console.log(`files: ${outputs.length}, total: ${(total / 1024).toFixed(0)}K`);

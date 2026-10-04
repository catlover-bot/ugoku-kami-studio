import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({ entryPoints: ['apps/server/src/index.ts'], outfile: 'dist/server/index.js', platform: 'node', format: 'esm', target: 'node24', bundle: true, packages: 'external', plugins: [{ name: 'workspace-source', setup(builder) { builder.onResolve({ filter: /^@ugoku\/(core|export)$/ }, (args) => ({ path: resolve('packages', args.path.slice('@ugoku/'.length), 'src/index.ts') })); } }] });

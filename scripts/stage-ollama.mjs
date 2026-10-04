import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, symlink, writeFile, lstat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFiles, verifyBundle } from '../deployment/ollama/verify-bundle.mjs';

const source = fileURLToPath(new URL('../deployment/ollama/', import.meta.url));
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  if (!['--runtime', '--models', '--out'].includes(key) || options[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Use --runtime DIR --models DIR --out NEW_DIR');
  options[key] = resolve(args[i + 1]);
}
if (Object.keys(options).length !== 3) throw Error('Use --runtime DIR --models DIR --out NEW_DIR');
const lock = JSON.parse(await readFile(join(source, 'bundle-lock.json'), 'utf8'));
await verifyFiles(options['--runtime'], lock.runtimeFiles, true);
await verifyFiles(options['--models'], lock.modelFiles); // Other existing models stay untouched and are not copied.
const out = options['--out'];
try { await lstat(out); throw Error('Output already exists; choose a new directory'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(out, { recursive: true, mode: 0o700 });
for (const [key, prefix, entries] of [['--runtime', 'runtime', lock.runtimeFiles], ['--models', 'models', lock.modelFiles]]) {
  for (const entry of entries) {
    const target = join(out, prefix, entry.path); await mkdir(dirname(target), { recursive: true });
    if (entry.symlink) await symlink(entry.symlink, target);
    else await copyFile(join(options[key], entry.path), target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  }
}
for (const name of ['Dockerfile', 'bundle-lock.json', 'verify-bundle.mjs', 'start.sh', 'LICENSE.ollama']) await copyFile(join(source, name), join(out, name), constants.COPYFILE_EXCL);
const result = await verifyBundle(out, lock);
await writeFile(join(out, 'staging-result.json'), JSON.stringify({ status: 'staged-and-hash-verified', ...result, inferenceCalls: 0, downloads: 0, dockerBuild: 'not-run', cloudWrites: 0 }, null, 2) + '\n');
// Only staged files, never adjacent files or staging reports, enter the Docker context.
await writeFile(join(out, '.dockerignore'), '*\n!Dockerfile\n!runtime\n!runtime/**\n!models\n!models/**\n!bundle-lock.json\n!verify-bundle.mjs\n!start.sh\n!LICENSE.ollama\n');
console.log(JSON.stringify({ status: 'staged-and-hash-verified', ...result, output: out, dockerBuild: 'not-run', cloudWrites: 0 }));

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readlink, readdir } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
/** Reject links in parent directories as well as unlisted files. Never traverse arbitrary links. */
async function files(root, prefix = '') {
  const result = [];
  for (const name of await readdir(join(root, prefix))) {
    const path = join(prefix, name), stat = await lstat(join(root, path));
    if (stat.isDirectory()) result.push(...await files(root, path));
    else result.push(path);
  }
  return result;
}
export async function verifyFiles(root, entries, exact = false) {
  let bytes = 0;
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.startsWith('/') || entry.path.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Invalid bundle path');
    const path = resolve(root, entry.path);
    let parent = dirname(path);
    while (parent !== resolve(root)) {
      if (!(await lstat(parent)).isDirectory()) throw Error('Bundle parent is not a directory');
      parent = dirname(parent);
    }
    const stat = await lstat(path);
    if (entry.symlink !== undefined) {
      if (!stat.isSymbolicLink() || await readlink(path) !== entry.symlink || relative(resolve(root), resolve(dirname(path), entry.symlink)).startsWith('..')) throw Error('Bundle link mismatch');
    } else {
      if (!stat.isFile() || stat.size !== entry.size || await hashFile(path) !== entry.sha256) throw Error(`Bundle integrity mismatch: ${entry.path}`);
      bytes += stat.size;
    }
  }
  if (exact && (await files(root)).sort().join('\n') !== entries.map(entry => entry.path).sort().join('\n')) throw Error('Unexpected bundle files');
  return bytes;
}
export async function verifyBundle(root, lock) {
  const runtimeBytes = await verifyFiles(join(root, 'runtime'), lock.runtimeFiles, true);
  const modelBytes = await verifyFiles(join(root, 'models'), lock.modelFiles, true);
  const manifest = JSON.parse(await readFile(join(root, 'models', lock.manifestPath), 'utf8'));
  if (manifest.schemaVersion !== 2 || manifest.config.digest !== `sha256:${lock.modelFiles[1].sha256}`) throw Error('Model manifest mismatch');
  return { runtimeBytes, modelBytes, modelDigest: lock.modelDigest, runtimeVersion: lock.runtimeVersion, model: lock.model };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] || '/opt/bundle');
  const lock = JSON.parse(await readFile(new URL('./bundle-lock.json', import.meta.url), 'utf8'));
  console.log(JSON.stringify(await verifyBundle(root, lock)));
}

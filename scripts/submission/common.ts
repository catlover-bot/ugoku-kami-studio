import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const codeSha = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
export const json = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
export async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }
export function args(values: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < values.length; i += 2) {
    const key = values[i]!, value = values[i + 1];
    if (!allowed.includes(key) || !value || value.startsWith('--') || result[key] !== undefined) throw new Error(`Invalid argument ${key}`);
    result[key] = value;
  }
  return result;
}
export async function folders(output: string) {
  const base = resolve(output), publicDir = resolve(base, 'public'), privateDir = resolve(base, 'private'), rawDir = resolve(privateDir, 'recording');
  await mkdir(resolve(publicDir, 'images'), { recursive: true });
  await mkdir(rawDir, { recursive: true, mode: 0o700 });
  return { base, publicDir, privateDir, rawDir };
}
export async function mergePublicManifest(publicDir: string, change: Record<string, unknown>) {
  const path = resolve(publicDir, 'manifest.json');
  let previous: Record<string, unknown> = {};
  try { previous = await readJson(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await json(path, { ...previous, ...change });
}

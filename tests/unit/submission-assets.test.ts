import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import sharp from 'sharp';
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function output() { const path = await mkdtemp(join(tmpdir(), 'ugoku-submission-')); temporary.push(path); return path; }
const run = (script: string, path: string) => execFileSync(process.execPath, ['--import', 'tsx', `scripts/submission/${script}.ts`, '--out', path], { encoding: 'utf8' });
test('public prose is bounded including newlines and architecture is an actual raster; unknown publication stays unknown', async () => {
  const path = await output(); run('prepare', path);
  const manifest = JSON.parse(await readFile(join(path, 'public/manifest.json'), 'utf8'));
  for (const filename of ['problem-solution.txt', 'architecture.txt']) {
    const text = await readFile(join(path, 'public', filename), 'utf8');
    expect(text).toContain('\n'); expect([...text].length).toBeLessThanOrEqual(800); expect(text.length).toBeLessThanOrEqual(800);
    expect(manifest.texts[filename]).toEqual({ codePoints: [...text].length, utf16: text.length, sha256: createHash('sha256').update(text).digest('hex') });
  }
  const png = await sharp(join(path, 'public/architecture.png')).metadata(); expect(png.format).toBe('png'); expect(png.width).toBeGreaterThan(1000);
  expect(manifest.status).toBe('LOCAL_DRAFT'); expect(manifest.deploymentUrl).toBeNull(); expect(manifest.youtubeUrl).toBeNull(); expect(manifest.submitted).toBe(false);
  expect(manifest.verification.formCounter).toBe('not-checked'); expect(manifest.verification.physicalAssembly).toBe('not-performed');
});
test('public ZIP excludes video/private extras and cannot retain a secret from an older archive', async () => {
  const path = await output(); run('prepare', path);
  const publicDir = join(path, 'public');
  for (const name of ['01-input', '02-ai-candidate', '03-print', '04-assembly']) await writeFile(join(publicDir, 'images', `${name}.png`), await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer());
  await writeFile(join(publicDir, 'captions.srt'), '1\n00:00:00,000 --> 00:00:01,000\nfixture\n');
  await writeFile(join(publicDir, 'demo.mp4'), 'excluded-video-fixture'); await writeFile(join(publicDir, 'secret.env'), 'fixture-secret');
  await mkdir(join(path, 'deliverables')); const archive = join(path, 'deliverables/ugoku-kami-public-assets.zip');
  execFileSync('python3', ['-m', 'zipfile', '-c', archive, 'secret.env'], { cwd: publicDir });
  run('package', path);
  const members = JSON.parse(execFileSync('python3', ['-c', 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', archive], { encoding: 'utf8' })) as string[];
  expect(members).toHaveLength(11); expect(members).toContain('manifest.json'); expect(members).toContain('images/04-assembly.png');
  expect(members.some(name => /secret|\.env|demo\.mp4|private|node_modules|font|model/.test(name))).toBe(false);
});

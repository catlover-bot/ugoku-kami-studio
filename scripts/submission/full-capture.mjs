/** Genuine, local continuation of the already adopted Goal016 document. No AI.
 * node scripts/submission/full-capture.mjs --app-root ABS --out ABS --adopted ABS [--rehearsal]
 * The separate app worktree must be detached at the accepted source SHA and built.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = '6c1b858bbe73542d179334b84ef4aefe57de65aa';
const INPUT_SHA = '2d1b5129b37eead37afd5217b5f6cd06cba558aeae9e11d0fd042c9c6fbc2f75';
const ORIGINAL_CAPTURE_SHA = '86fc2e4702c4ecb54196c611d2a3262112c7ad5f76c0db571be4ac02c1e2b69a';
const DESIGN_HASH = 'ed80b7cb9983144f2a6f7d3160d14b8aba6f97433fcc447dc6ef5c3c405c3298';
const PORT = 4918, ORIGIN = `http://127.0.0.1:${PORT}`;
const argv = process.argv.slice(2), options = {};
for (let i = 0; i < argv.length; i++) {
  const name = argv[i];
  assert(['--app-root', '--out', '--adopted', '--rehearsal'].includes(name), 'Unknown option');
  assert(!(name in options), 'Duplicate option');
  options[name] = name === '--rehearsal' ? true : argv[++i];
  assert(options[name] && !String(options[name]).startsWith('--'), 'Missing option value');
}
assert(options['--app-root'] && options['--out'] && options['--adopted'], 'Explicit paths required');
const APP = resolve(options['--app-root']), OUT = resolve(options['--out']), ADOPTED = resolve(options['--adopted']);
const REHEARSAL = !!options['--rehearsal'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Read existing worktree metadata without any Git command or mutation.
const gitPointer = (await readFile(join(APP, '.git'), 'utf8')).trim();
assert(gitPointer.startsWith('gitdir: '));
const gitDirectory = resolve(APP, gitPointer.slice(8));
assert.equal((await readFile(join(gitDirectory, 'HEAD'), 'utf8')).trim(), SOURCE, 'Wrong detached app version');
const requireApp = createRequire(join(APP, 'package.json'));
const { chromium, expect } = requireApp('@playwright/test');
const { PDFDocument } = requireApp('pdf-lib');
const { tsImport } = await import(pathToFileURL(join(APP, 'node_modules/tsx/dist/esm/api/index.mjs')).href);
const { parseDesignDocument } = await tsImport(pathToFileURL(join(APP, 'packages/core/src/index.ts')).href, import.meta.url);
const inputBytes = await readFile(ADOPTED), project = JSON.parse(inputBytes);
assert.equal(sha(inputBytes), INPUT_SHA);
const document = parseDesignDocument(project.document);
assert.equal(document.revision, 2); assert.equal(document.designHash, DESIGN_HASH);
assert.equal(document.input.travelMm, 25); assert.deepEqual(project.records, []);
const originalCaptureFile = join(dirname(ADOPTED), 'capture.json');
const originalCaptureBytes = await readFile(originalCaptureFile);
assert.equal(sha(originalCaptureBytes), ORIGINAL_CAPTURE_SHA);
const originalCapture = JSON.parse(originalCaptureBytes);
assert.equal(originalCapture.sourceSha, SOURCE); assert.equal(originalCapture.simulation, false);
for (const asset of originalCapture.frontendAssets) {
  assert.equal(sha(await readFile(join(APP, 'apps/web/dist', asset.file.slice(1)))), asset.sha256);
}
const stampOf = doc => ({ designId: doc.designId, revision: doc.revision, designHash: doc.designHash });
await mkdir(OUT, { recursive: true, mode: 0o700 });
const RUN = join(OUT, `${REHEARSAL ? 'rehearsal-' : ''}${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(RUN, { mode: 0o700 });
await writeFile(join(RUN, 'imported.ugoku.json'), inputBytes, { mode: 0o600, flag: 'wx' });
const emptyEnv = join(RUN, 'empty.env'); await writeFile(emptyEnv, '', { mode: 0o600, flag: 'wx' });
const metadata = {
  format: 'ugoku-goal016-local-continuation-v1', status: 'running', rehearsal: REHEARSAL,
  submissionFootage: !REHEARSAL, sourceSha: SOURCE,
  kind: 'Separate fresh local session reopens the real, previously adopted r2; only print, guide and save operations. No new proposal or inference.',
  originalCaptureSha256: ORIGINAL_CAPTURE_SHA, originalCaptureFile, adopted: stampOf(document),
  originalProjectSha256: INPUT_SHA, viewport: { width: 1366, height: 768 }, origin: ORIGIN,
  aiProvider: 'none', newModelRequests: 0, newModelCalls: 0, aiCalls: 0, cloudCalls: 0,
  physicalValidation: 'unverified', externalRequestsBlocked: [], runRequestsBlocked: [], pageErrors: [],
  startedAt: new Date().toISOString(), scriptSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  build: { serverSha256: sha(await readFile(join(APP, 'dist/server/index.js'))), frontendMatchesOriginalCapture: true },
  evidence: { importedProject: { file: 'imported.ugoku.json', sha256: INPUT_SHA } }, clips: [], pdfs: [],
};
let server, serverExit, browser, context, page, rawVideo, clockStart;
const clip = { name: 'adopted-kit-local', events: [], scenes: [], markers: [], screenshots: [], errors: [] };
metadata.clips.push(clip);
const now = () => Number(((performance.now() - clockStart) / 1000).toFixed(4));
const event = (type, data = {}) => clip.events.push({ type, wallSeconds: now(), ...data });
const hold = seconds => page.waitForTimeout(REHEARSAL ? Math.min(120, seconds * 20) : seconds * 1000);
const shot = async name => {
  const file = name + '.png'; await page.screenshot({ path: join(RUN, file) });
  clip.screenshots.push({ file, wallSeconds: now(), sha256: sha(await readFile(join(RUN, file))) });
};
const assertStamp = async () => {
  for (const [attribute, value] of [['data-design-id', document.designId], ['data-design-revision', '2'], ['data-design-hash', DESIGN_HASH]]) {
    await expect(page.locator('main')).toHaveAttribute(attribute, value);
  }
};
async function saved() {
  await expect(page.locator('main')).toHaveAttribute('data-save-status', 'saved');
  const id = await page.locator('main').getAttribute('data-workspace-id');
  const value = await page.evaluate(id => new Promise((resolve, reject) => {
    const open = indexedDB.open('ugoku-kami.workspaces.v1');
    open.onerror = () => reject(Error('Cannot read saved workspace'));
    open.onupgradeneeded = () => { open.transaction.abort(); reject(Error('Workspace does not exist')); };
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('projects', 'readonly'), read = tx.objectStore('projects').get(id);
      tx.oncomplete = () => { db.close(); resolve(JSON.parse(read.result)); };
      tx.onerror = () => { db.close(); reject(Error('Cannot read saved project')); };
    };
  }), id);
  assert.deepEqual(value, project, 'The original project or records changed');
  return value;
}
async function scene(id, action) {
  const entry = { id, wallStart: now() }; clip.scenes.push(entry); event('scene-start', { id });
  await shot(id + '-first'); await action(); await assertStampUnlessHome(id);
  entry.wallActionEnd = now(); await shot(id + '-last'); entry.wallEnd = now(); event('scene-end', { id });
  await save(join(RUN, 'capture.json'), metadata);
}
const assertStampUnlessHome = id => id === 'home-intro' ? Promise.resolve() : assertStamp();
async function marker(kind) {
  const before = now();
  await page.goto('data:text/html,<meta name="viewport" content="width=device-width"><style>html,body{margin:0;width:100%;height:100%;background:%23d600d6}</style>');
  await hold(.6); const cyanBefore = now();
  await page.goto('data:text/html,<meta name="viewport" content="width=device-width"><style>html,body{margin:0;width:100%;height:100%;background:%2300e5e5}</style>');
  const cyanAfter = now(); await hold(.6);
  clip.markers.push({ kind, wallBefore: before, cyanBefore, cyanAfter, wallEnd: now() });
}
async function gentleTo(locator) {
  const box = await locator.boundingBox(); assert(box);
  const distance = box.y - 95;
  await page.mouse.move(680, 450);
  const pieces = REHEARSAL ? 1 : Math.max(1, Math.ceil(Math.abs(distance) / 110));
  for (let i = 0; i < pieces; i++) { await page.mouse.wheel(0, distance / pieces); await page.waitForTimeout(REHEARSAL ? 40 : 110); }
  await locator.scrollIntoViewIfNeeded();
}
async function top() { await page.keyboard.press('Control+Home'); await hold(.45); }
async function download(mode) {
  const pages = mode === 'all' ? 5 : mode === 'pattern' ? 1 : 4;
  await page.getByLabel('PDFに含める内容', { exact: true }).selectOption(mode);
  await expect(page.getByLabel('取得するPDFの内容', { exact: true })).toContainText(`PDF ${pages}ページ`);
  event('pdf-mode-selected', { mode, pages }); await hold(3.3); await shot('pdf-' + mode);
  const pending = page.waitForEvent('download', { timeout: 90000 });
  await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
  const file = `adopted-r2-${mode}.pdf`; await (await pending).saveAs(join(RUN, file)); await chmod(join(RUN, file), 0o600);
  const bytes = await readFile(join(RUN, file)), pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), pages); assert.equal(pdf.getTitle(), `${document.designId} revision 2`);
  assert(pdf.getSubject().includes(DESIGN_HASH));
  for (const sheet of pdf.getPages()) { assert(Math.abs(sheet.getWidth() - 210 * 72 / 25.4) < .001); assert(Math.abs(sheet.getHeight() - 297 * 72 / 25.4) < .001); }
  metadata.pdfs.push({ id: mode, mode, file, sha256: sha(bytes), pages, stamp: stampOf(document), A4: true });
  event('same-version-pdf-downloaded', { mode, file }); await hold(2.5);
}
async function goStep(number) {
  await top();
  const current = Number(await page.locator('.assembly-guide-step').getAttribute('data-step'));
  const button = number > current ? '次の工程' : '前の工程';
  for (let i = 0; i < Math.abs(number - current); i++) await page.getByRole('button', { name: button, exact: true }).click();
  await expect(page.locator('.assembly-guide-step')).toHaveAttribute('data-step', String(number));
  await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-hash', DESIGN_HASH);
  event('guide-step', { step: number, ...stampOf(document) });
}
async function calibrate() {
  const video = join(RUN, clip.rawVideo);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_frames', '-show_entries', 'stream=r_frame_rate,avg_frame_rate,width,height:frame=best_effort_timestamp_time', '-of', 'json', video], { encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 }));
  const rgb = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', video, '-vf', 'scale=1:1:flags=area,format=rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1024 ** 2 });
  assert.equal(rgb.length, probe.frames.length * 3); assert.equal(probe.streams[0].r_frame_rate, '25/1');
  const groups = [];
  for (let i = 0; i < probe.frames.length; i++) {
    const [r, g, b] = rgb.subarray(i * 3, i * 3 + 3), pts = Number(probe.frames[i].best_effort_timestamp_time);
    const kind = r > 180 && g < 45 && b > 180 ? 'magenta' : r < 45 && g > 180 && b > 180 ? 'cyan' : 'product';
    if (groups.at(-1)?.kind === kind) { groups.at(-1).lastPts = pts; groups.at(-1).frames++; }
    else groups.push({ kind, firstPts: pts, lastPts: pts, frames: 1 });
  }
  const cyan = groups.filter(g => g.kind === 'cyan'); assert.equal(cyan.length, 2);
  const observations = cyan.map((g, i) => ({ kind: clip.markers[i].kind, firstPts: g.firstPts, offset: g.firstPts - (clip.markers[i].cyanBefore + clip.markers[i].cyanAfter) / 2, uncertainty: (clip.markers[i].cyanAfter - clip.markers[i].cyanBefore) / 2 + .04 }));
  const drift = Math.abs(observations[0].offset - observations[1].offset);
  const timing = { method: 'Decoded video-frame PTS with separate magenta/cyan calibration pages; never product DOM injection', fps: 25, rawSha256: clip.rawSha256, decodedFrames: probe.frames.length, observations, drift, groups };
  await save(join(RUN, 'timing.json'), timing);
  assert(observations.every(x => x.uncertainty < .15) && drift < .20, 'Marker uncertainty/drift requires independent frame calibration; preserve raw and do not publish unverified cuts');
  const offset = (observations[0].offset + observations[1].offset) / 2, snap = t => Math.round(t * 25) / 25;
  clip.usableStartSeconds = Math.ceil((clip.usableWallStart + offset) * 25) / 25;
  clip.usableEndSeconds = Math.floor((clip.usableWallEnd + offset) * 25) / 25;
  assert(groups.some(g => g.kind === 'product' && g.firstPts < clip.usableStartSeconds && g.lastPts >= clip.usableEndSeconds - .04));
  for (const item of clip.scenes) {
    item.sourceStart = Math.max(clip.usableStartSeconds, snap(item.wallStart + offset));
    item.sourceEnd = Math.min(clip.usableEndSeconds, snap(item.wallEnd + offset));
    item.actionEnd = snap(item.wallActionEnd + offset);
    assert(item.sourceEnd > item.sourceStart && item.actionEnd <= item.sourceEnd + .04);
  }
  for (const item of clip.events) item.pts = snap(item.wallSeconds + offset);
  clip.timing = { file: 'timing.json', sha256: sha(await readFile(join(RUN, 'timing.json'))), fps: 25, drift };
  for (const [name, at] of [['first', clip.usableStartSeconds], ['last', clip.usableEndSeconds - .04]]) {
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(at), '-i', video, '-frames:v', '1', join(RUN, `actual-${name}-frame.png`)]);
  }
}
try {
  // Exclusive port test. Never reuse, signal or modify an existing local server.
  await new Promise((ok, reject) => { const test = createServer(); test.once('error', reject); test.listen(PORT, '127.0.0.1', () => test.close(ok)); });
  const serverEnv = { PATH: process.env.PATH, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(PORT), AI_PROVIDER: 'none', AI_PUBLIC_RELEASE: 'false', UGOKU_ENV_FILE: emptyEnv };
  server = spawn(process.execPath, ['dist/server/index.js'], { cwd: APP, env: serverEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  metadata.server = { pid: server.pid, cwd: APP, credentialEnvironmentInherited: false };
  serverExit = new Promise(resolve => server.once('exit', (code, signal) => resolve({ code, signal })));
  server.stderr.on('data', () => { metadata.serverStderrSeen = true; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    assert(server.exitCode === null && server.signalCode === null, 'Owned server exited before readiness');
    const response = await fetch(ORIGIN + '/api/status', { signal: AbortSignal.timeout(300) }).catch(() => null);
    if (response?.ok) { const status = await response.json(); assert.equal(status.ai.provider, 'none'); assert.equal(status.ai.enabled, false); metadata.serverStatus = status; ready = true; break; }
    await delay(100);
  }
  assert(ready, 'Owned server not ready');
  const browserEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  browser = await chromium.launch({ headless: true, env: browserEnv, args: ['--disable-background-networking'] });
  context = await browser.newContext({ viewport: metadata.viewport, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', acceptDownloads: true, serviceWorkers: 'block', ...(REHEARSAL ? {} : { recordVideo: { dir: RUN, size: metadata.viewport } }) });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (['data:', 'blob:', 'about:'].includes(url.protocol)) return route.continue();
    if (url.origin !== ORIGIN) { metadata.externalRequestsBlocked.push({ origin: url.origin, path: url.pathname, method: request.method() }); return route.abort('blockedbyclient'); }
    if (/^\/api\/(sessions|runs|proposals)(\/|$)/.test(url.pathname)) { metadata.runRequestsBlocked.push({ path: url.pathname, method: request.method() }); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  clockStart = performance.now(); page = await context.newPage(); page.setDefaultTimeout(12000);
  if (!REHEARSAL) rawVideo = await page.video().path();
  page.on('pageerror', error => metadata.pageErrors.push(error.message));
  await marker('before'); await page.goto(ORIGIN, { waitUntil: 'networkidle' });
  await expect(page.locator('.home-library')).toBeVisible(); clip.usableWallStart = now();
  await scene('home-intro', async () => { await hold(5.5); });
  await scene('import-adopted-r2', async () => {
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.home-library').getByRole('button', { name: 'ファイルを読み込む', exact: true }).click();
    await (await chooser).setFiles(ADOPTED); await assertStamp(); await saved(); event('adopted-project-imported', stampOf(document)); await hold(3);
    await page.locator('.workflow').getByRole('button', { name: /動きをつける$/ }).click();
    await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('25'); await hold(3);
  });
  await scene('pdf-three-contents', async () => {
    await page.locator('.workflow').getByRole('button', { name: /印刷して作る$/ }).click(); await hold(2);
    for (const mode of ['all', 'pattern', 'instructions']) await download(mode);
    await page.getByLabel('PDFに含める内容', { exact: true }).selectOption('all'); await hold(2);
  });
  await scene('guide-parts', async () => {
    await page.getByRole('button', { name: '組み立てガイドを開く', exact: true }).click(); await goStep(1);
    await gentleTo(page.locator('.assembly-guide-step h3')); await hold(4);
    await gentleTo(page.locator('.assembly-guide-part-info')); await hold(4); event('parts-read');
  });
  await scene('guide-fold', async () => {
    await goStep(2); await gentleTo(page.locator('.assembly-guide-step h3')); await hold(4);
    await gentleTo(page.locator('.assembly-guide-description')); await hold(4); event('fold-read');
  });
  await scene('guide-glue', async () => {
    await goStep(3); await gentleTo(page.locator('.assembly-guide-step h3')); await hold(3.5);
    await gentleTo(page.locator('.assembly-guide-glue')); await hold(4); event('glue-face-read');
  });
  await scene('guide-no-glue', async () => {
    await goStep(4); await gentleTo(page.locator('.assembly-guide-step h3')); await hold(3.5);
    await gentleTo(page.locator('.assembly-guide-no-glue')); await hold(4.5); event('do-not-glue-read');
  });
  await scene('save-reload-resume', async () => {
    await top(); await page.getByRole('button', { name: 'ガイドを閉じる', exact: true }).click();
    await page.getByRole('button', { name: '保存・再開', exact: true }).click(); await hold(2);
    await page.getByRole('button', { name: 'このブラウザに保存', exact: true }).click(); await saved(); await hold(1.5);
    await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click(); await hold(1);
    await page.reload({ waitUntil: 'networkidle' }); await assertStamp(); const restored = await saved(); await hold(2.5);
    await save(join(RUN, 'reloaded.ugoku.json'), restored);
    metadata.evidence.reloadedProject = { file: 'reloaded.ugoku.json', sha256: sha(await readFile(join(RUN, 'reloaded.ugoku.json'))) };
    await page.getByRole('button', { name: '組み立てガイドを開く', exact: true }).click();
    await expect(page.locator('.assembly-guide-step')).toHaveAttribute('data-step', '4');
    await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-hash', DESIGN_HASH);
    event('same-version-and-guide-step-restored', { step: 4, ...stampOf(document) }); await hold(3.5);
    await gentleTo(page.locator('.assembly-guide-step h3')); await hold(3);
    clip.savedGuideStep = 4; clip.originalProjectPreserved = true;
  });
  await saved(); await assertStamp(); clip.usableWallEnd = now(); await marker('after');
  assert.deepEqual(metadata.externalRequestsBlocked, []); assert.deepEqual(metadata.runRequestsBlocked, []); assert.deepEqual(metadata.pageErrors, []);
  clip.status = 'passed'; metadata.status = 'passed';
} catch (error) {
  metadata.status = 'failed'; clip.status = 'failed'; metadata.failure = { name: error.name, message: error.message };
  await shot('failure').catch(() => {}); process.exitCode = 1;
} finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  if (rawVideo) { clip.rawVideo = relative(RUN, rawVideo); clip.rawSha256 = sha(await readFile(rawVideo)); }
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM'); let closed = await Promise.race([serverExit, delay(5000).then(() => null)]);
    if (!closed) { server.kill('SIGKILL'); closed = await serverExit; }
    metadata.server.exit = closed;
  }
  metadata.serverStopped = !!server && (server.exitCode !== null || server.signalCode !== null);
  if (!REHEARSAL && clip.status === 'passed') {
    try { await calibrate(); } catch (error) { metadata.status = 'timing-review-required'; metadata.timingError = { name: error.name, message: error.message }; process.exitCode = 1; }
  }
  metadata.finishedAt = new Date().toISOString(); await save(join(RUN, 'capture.json'), metadata);
  console.log(JSON.stringify({ status: metadata.status, runDirectory: RUN, rawVideo: clip.rawVideo, usableStart: clip.usableStartSeconds, usableEnd: clip.usableEndSeconds, serverStopped: metadata.serverStopped, failure: metadata.failure ?? metadata.timingError ?? null }));
}

/** Genuine browser recording. A model request is possible only with the explicit
 * local-ai mode; manual rehearsal never clicks AI and cannot create public AI evidence. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { parseEnv } from 'node:util';
import { chromium, expect } from '@playwright/test';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { parseDesignDocument, validateDesign, type DesignDocument } from '@ugoku/core';
import { createApp } from '../../apps/server/src/app.js';
import { readConfig } from '../../apps/server/src/config.js';
import type { publicRun } from '../../apps/server/src/runs.js';
import { PROTOTYPE_SOURCE_SVG } from '../prepare-prototype.js';
import { args, codeSha, folders, json, mergePublicManifest, sha256 } from './common.js';

type Run = ReturnType<typeof publicRun>;
type Sync = { wallBefore: number; wallAfter: number };
type Scene = { name: string; start: number; actionEnd: number; end: number; targetSeconds: number };
const options = args(process.argv.slice(2), ['--out', '--mode', '--env', '--port', '--origin', '--source-sha']);
const mode = options['--mode'];
if (mode !== 'manual-rehearsal' && mode !== 'local-ai') throw new Error('Explicit --mode manual-rehearsal|local-ai is required');
const paths = await folders(options['--out'] ?? 'artifacts/submission');
const recordingDir = resolve(paths.rawDir, `${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(recordingDir, { recursive: true });
const env = mode === 'local-ai' ? parseEnv(await readFile(resolve(options['--env'] ?? ''), 'utf8')) : { AI_PROVIDER: 'none' };
const config = readConfig(env);
if (mode === 'local-ai' && config.provider !== 'ollama') throw new Error('Only explicitly selected local Ollama is permitted');
if (process.env.NODE_ENV === 'test') throw new Error('Submission recording cannot run in a test/injected environment');
if (options['--origin'] && !/^[a-f0-9]{7,40}$/.test(options['--source-sha'] ?? '')) throw new Error('--source-sha of the served build is required with --origin');
if (options['--origin'] && !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(options['--origin'])) throw new Error('--origin must be an explicit loopback address');
const app = options['--origin'] ? null : await createApp({ config, staticRoot: resolve('apps/web/dist') });
const origin = options['--origin'] ?? await app!.listen({ host: '127.0.0.1', port: Number(options['--port'] ?? 0) });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir: recordingDir, size: { width: 1600, height: 900 } }, locale: 'ja-JP', acceptDownloads: true });
const clockStart = performance.now();
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const scenes: Scene[] = [];
const synchronization: Sync[] = [];
let latestRun: Run | undefined;
let runPosts = 0;
let aiStartedAt = 0;
let aiFinishedAt: number;
const responseTasks = new Set<Promise<void>>();
const requestFailures: string[] = [];
page.on('pageerror', error => requestFailures.push(error.message));
page.on('response', response => {
  const url = new URL(response.url());
  if (url.origin !== origin || !/\/runs(?:\/[^/]+)?$/.test(url.pathname)) return;
  if (response.request().method() === 'POST') runPosts++;
  const task = response.json().then(body => { if (body.run) latestRun = body.run; });
  responseTasks.add(task); void task.finally(() => responseTasks.delete(task));
});
const now = () => (performance.now() - clockStart) / 1000;
const hold = (seconds: number) => page.waitForTimeout(seconds * 1000);
async function synchronizationMarker() {
  // This separate, private calibration page is outside every public scene. It
  // never changes the product DOM and contains no invented model response.
  await page.goto('data:text/html,<style>html{background:%23ff00ff}</style>'); await hold(.4);
  const wallBefore = now(); await page.goto('data:text/html,<style>html{background:%2300ffff}</style>'); const wallAfter = now();
  synchronization.push({ wallBefore, wallAfter }); await hold(.4);
}
async function scene(name: string, targetSeconds: number, action: () => Promise<void>) {
  const start = now(); await action();
  const actionEnd = now(); const elapsed = actionEnd - start;
  if (elapsed < targetSeconds + .4) await hold(targetSeconds + .4 - elapsed);
  scenes.push({ name, start, actionEnd, end: now(), targetSeconds });
}
async function stage(number: number) { await page.locator('.workflow').getByRole('button', { name: new RegExp(`${['絵を選ぶ', '動きをつける', '印刷して作る'][number - 1]}$`) }).click(); await page.evaluate(() => window.scrollTo(0, 0)); }
async function number(label: string, value: number) { const field = page.getByLabel(label, { exact: true }); await field.fill(String(value)); await field.press('Enter'); }
async function details(selector: string, open = true) { const item = page.locator(selector); if (await item.evaluate(element => (element as HTMLDetailsElement).open) !== open) await item.locator(':scope > summary').click(); }
async function download(button: string, filename: string) { const waiting = page.waitForEvent('download', { timeout: 40_000 }); await page.getByRole('button', { name: button, exact: true }).click(); const file = await waiting; await file.saveAs(resolve(recordingDir, filename)); return readFile(resolve(recordingDir, filename)); }
async function exportProject(filename: string) { await page.getByRole('button', { name: '保存・再開', exact: true }).click(); const bytes = await download('プロジェクトを書き出す', filename); await page.getByRole('button', { name: '閉じる', exact: true }).click(); const project = JSON.parse(bytes.toString()); assert.equal(project.records.length, 0); return parseDesignDocument(project.document); }
const stamp = (doc: DesignDocument) => ({ designId: doc.designId, revision: doc.revision, designHash: doc.designHash, travelMm: doc.input.travelMm, maxSheets: doc.input.maxSheets });
const images: Record<string, unknown> = {};
async function screenshot(name: string, document: DesignDocument, selector?: string) {
  const path = resolve(recordingDir, name);
  await expect(page.locator('main')).toHaveAttribute('data-save-status', 'saved');
  if (selector) await page.locator(selector).screenshot({ path }); else await page.screenshot({ path });
  images[name] = { ...stamp(document), sha256: sha256(await readFile(path)), kind: 'real-browser-screen', viewport: { width: 1600, height: 900 } };
}
let success = false;
try {
  const png = await sharp(Buffer.from(PROTOTYPE_SOURCE_SVG)).png().toBuffer();
  const inputPath = resolve(recordingDir, 'fish.png'); await writeFile(inputPath, png);
  await synchronizationMarker(); await page.goto(origin); await expect(page.locator('.home-library')).toBeVisible();
  await scene('intro', 10, async () => { await hold(2); await page.getByRole('button', { name: '自分の絵ではじめる', exact: true }).hover(); });
  await scene('selection', 30, async () => {
    const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '自分の絵ではじめる', exact: true }).click(); await (await chooser).setFiles(inputPath);
    await expect(page.locator('.workflow')).toBeVisible();
    const startEdit = page.getByRole('button', { name: '動かす部分を選び直す', exact: true }); if (await startEdit.isVisible()) await startEdit.click();
    await page.getByRole('button', { name: '2点で囲む', exact: true }).click();
    const points = await page.locator('.workbench .artwork-svg').evaluate(svg => { const matrix = (svg as SVGSVGElement).getScreenCTM()!; return [[350, 170], [650, 380]].map(([x, y]) => { const p = new DOMPoint(x, y).matrixTransform(matrix); return { x: p.x, y: p.y }; }); });
    await page.mouse.move(points[0].x, points[0].y, { steps: 20 }); await hold(1); await page.mouse.click(points[0].x, points[0].y); await page.mouse.move(points[1].x, points[1].y, { steps: 35 }); await hold(1); await page.mouse.click(points[1].x, points[1].y);
    // Pixel rounding differs across display scale. The ordinary numeric controls
    // make the selected authored rectangle exact, with each correction visible.
    await details('.selection-numeric');
    for (const [label, value] of [['選択のX', 350], ['選択のY', 170], ['選択の幅', 300], ['選択の高さ', 210]] as const) await number(label, value);
    await details('.selection-numeric', false); await page.evaluate(() => window.scrollTo(0, 0)); await hold(3);
  });
  await page.getByRole('button', { name: '選択の編集を終える', exact: true }).click();
  await scene('conditions', 18, async () => {
    await stage(2); await details('.numeric-details'); await number('作品の幅（mm）', 160); await number('作品の高さ（mm）', 110); await details('.numeric-details', false);
    await number('動く距離（mm）', 20); await number('紙の上限（枚）', 1); await page.getByLabel('絵の大きさを保つ', { exact: true }).check();
    await details('.numeric-details'); for (const label of ['紙の上限を固定', '紙の厚さを固定', 'すき間を固定']) await page.getByLabel(label, { exact: true }).check(); await details('.numeric-details', false); await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('button', { name: '動かす', exact: true }).click(); await hold(4); await page.getByRole('button', { name: '動きを停止', exact: true }).click();
  });
  // Excluded setup, version export, and actual image evidence. No secret appears
  // in any scene selected for the public video.
  const base = await exportProject('baseline.ugoku.json');
  assert.equal(base.input.widthMm, 160); assert.equal(base.input.heightMm, 110); assert.equal(base.input.travelMm, 20); assert.equal(base.input.maxSheets, 1);
  assert.deepEqual(base.input.selection, { x: 350, y: 170, width: 300, height: 210 }); assert.equal(validateDesign(base).filter(check => check.status === 'fail').length, 0);
  await stage(1); await page.getByRole('button', { name: '動かす部分を選び直す', exact: true }).click(); await screenshot('01-input.png', base); await page.getByRole('button', { name: '選択の編集を終える', exact: true }).click(); await stage(2);
  if (mode === 'manual-rehearsal') {
    await synchronizationMarker();
    await json(resolve(recordingDir, 'rehearsal.json'), { status: 'MANUAL_REHEARSAL_ONLY', codeSha: codeSha(), synchronization, base: stamp(base), runPosts, scenes, requestFailures, imageSha256: sha256(png) });
    assert.equal(runPosts, 0); success = true;
  } else {
    await page.getByRole('button', { name: '設定', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '設定', exact: true }); await dialog.getByLabel('AIアクセスコード').fill(config.accessSecret); await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
    await scene('request', 10, async () => { await details('.motion-request > .request-editor'); await page.getByLabel('どう動かしたいですか？', { exact: true }).fill('もう少し大きく動かしたい。絵の大きさは変えず、紙も増やさない'); await hold(4); aiStartedAt = now(); await page.getByRole('button', { name: 'AIで案をつくる', exact: true }).click(); });
    await expect.poll(() => latestRun?.status ?? 'running', { timeout: config.runTimeoutMs + 20_000 }).not.toBe('running'); await Promise.all([...responseTasks]); aiFinishedAt = now();
    const run = latestRun!; await json(resolve(recordingDir, 'actual-run.json'), run);
    assert.equal(runPosts, 1); assert.equal(run.mode, 'ollama'); assert.equal(run.status, 'awaiting_approval'); assert.ok(run.modelCalls > 0); assert.equal(run.baseHash, base.designHash); assert.equal(run.baseRevision, base.revision);
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.designHash);
    const candidate = parseDesignDocument(run.proposal?.document); assert.equal(candidate.input.travelMm, 25); assert.deepEqual(candidate.input.image, base.input.image); assert.deepEqual(candidate.input.selection, base.input.selection); assert.equal(candidate.input.widthMm, 160); assert.equal(candidate.input.heightMm, 110); assert.equal(candidate.input.maxSheets, 1); assert.equal(validateDesign(candidate).filter(check => check.status === 'fail').length, 0);
    assert.ok(run.events.some(event => event.type === 'validation' && event.designHash === candidate.designHash && event.checkStatuses?.every(check => check.status !== 'fail')));
    await scene('candidate', 27, async () => {
      await details('.ai-panel .preserved-conditions'); await page.evaluate(() => window.scrollTo(0, 0)); await hold(4); await screenshot('02-ai-candidate.png', candidate);
      const range = page.getByLabel('候補の比較位置', { exact: true }); await range.focus(); await range.press('End'); await hold(4); await range.press('Home'); await hold(3); await range.press('End'); await hold(3);
      await page.locator('.ai-panel').getByRole('button', { name: 'この案にする', exact: true }).click(); await expect(page.locator('main')).toHaveAttribute('data-design-hash', candidate.designHash); await page.getByRole('button', { name: '動かす', exact: true }).click(); await hold(5); await page.getByRole('button', { name: '動きを停止', exact: true }).click();
    });
    const adopted = await exportProject('adopted.ugoku.json'); assert.equal(adopted.designHash, candidate.designHash); assert.equal(adopted.revision, candidate.revision);
    await page.getByRole('button', { name: '設定', exact: true }).click(); await details('.ai-evidence'); const evidence = JSON.parse((await download('AI実行記録を書き出す', 'ai-evidence.json')).toString()); assert.equal(evidence.format, 'ugoku-kami-ai-run'); assert.equal(evidence.records.length, 1); assert.equal(evidence.records[0].decision.status, 'accepted'); assert.equal(evidence.records[0].decision.adopted.designHash, adopted.designHash); assert.equal(evidence.records[0].decision.adopted.revision, adopted.revision); await page.getByRole('dialog', { name: '設定', exact: true }).getByRole('button', { name: '閉じる', exact: true }).click();
    await scene('print', 20, async () => { await stage(3); await hold(3); const bytes = await download('PDFをダウンロード', 'kit.pdf'); const pdf = await PDFDocument.load(bytes); assert.equal(pdf.getTitle(), `${adopted.designId} revision ${adopted.revision}`); assert.ok(pdf.getSubject()?.includes(adopted.designHash)); assert.equal(pdf.getPageCount(), adopted.layout.sheets + 4); for (const page of pdf.getPages()) { assert.ok(Math.abs(page.getWidth() - 210 * 72 / 25.4) < .001); assert.ok(Math.abs(page.getHeight() - 297 * 72 / 25.4) < .001); } await screenshot('03-print.png', adopted); await details('.split-options'); await download('型紙だけを保存', 'pattern.pdf'); await download('組み立て説明だけを保存', 'instructions.pdf'); });
    // Normal UI downloads the actual A4 SVG. There may be multiple pages; the
    // fish has exactly one and the event therefore has a single destination.
    await page.getByText('印刷の設定と確認用SVG', { exact: true }).click(); await download('確認用SVGをダウンロード', 'pattern.svg');
    await scene('assembly', 24, async () => { await page.getByRole('button', { name: '組み立てガイドを開く', exact: true }).click(); await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-hash', adopted.designHash); await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-revision', String(adopted.revision)); await hold(3); for (let i = 0; i < 3; i++) { await page.getByRole('button', { name: '次の工程', exact: true }).click(); await hold(2); } await page.locator('.assembly-guide-step').scrollIntoViewIfNeeded(); await screenshot('04-assembly.png', adopted, '.assembly-guide'); await page.locator('.assembly-guide-glue').scrollIntoViewIfNeeded(); await hold(4); });
    await scene('save', 10, async () => { await page.getByRole('button', { name: 'ガイドを閉じる', exact: true }).click(); await page.getByRole('button', { name: '保存・再開', exact: true }).click(); await page.getByRole('button', { name: 'このブラウザに保存', exact: true }).click(); await hold(2); await page.getByRole('button', { name: '閉じる', exact: true }).click(); await page.getByRole('button', { name: '作品一覧', exact: true }).click(); await hold(2); await page.getByRole('button', { name: '前の作品を続ける', exact: true }).click(); });
    await scene('manual-failure', 18, async () => { await stage(2); await number('動く距離（mm）', 70); await expect(page.locator('.validation-details')).toContainText('要修正'); await page.locator('.validation-details').scrollIntoViewIfNeeded(); await hold(8); await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await expect(page.locator('main')).toHaveAttribute('data-design-hash', adopted.designHash); await page.evaluate(() => window.scrollTo(0, 0)); });
    await scene('limitations', 10, async () => { await stage(3); await page.locator('.physical-section > summary').click(); await page.locator('.physical-section').scrollIntoViewIfNeeded(); await hold(4); });
    assert.equal(runPosts, 1); assert.deepEqual(requestFailures, []); await synchronizationMarker();
    const files = ['kit.pdf', 'pattern.pdf', 'instructions.pdf', 'pattern.svg', 'adopted.ugoku.json'];
    const kit: Record<string, unknown> = {}; for (const file of files) kit[file] = { sha256: sha256(await readFile(resolve(recordingDir, file))), ...stamp(adopted) };
    const result = { status: 'REAL_LOCAL_AI_CAPTURED', codeSha: options['--source-sha'] ?? codeSha(), toolingCodeSha: codeSha(), captureScriptSha256: sha256(await readFile(new URL(import.meta.url))), synchronization, viewport: { width: 1600, height: 900 }, imageSha256: sha256(png), rawVideo: await page.video()!.path(), scenes, ai: { actualWaitSeconds: aiFinishedAt - aiStartedAt, started: aiStartedAt, finished: aiFinishedAt, runId: run.id, mode: run.mode, model: run.model, modelCalls: run.modelCalls, toolCalls: run.toolCalls, modelUsage: run.modelUsage, runPosts }, base: stamp(base), adopted: stamp(adopted), images, kit, checks: validateDesign(adopted), physicalValidation: 'unverified', requestFailures };
    await json(resolve(recordingDir, 'capture.json'), result);
    for (const name of Object.keys(images)) await writeFile(resolve(paths.publicDir, 'images', name), await readFile(resolve(recordingDir, name)));
    await mergePublicManifest(paths.publicDir, { capture: { ...result, rawVideo: undefined, scenes: undefined, checks: undefined, requestFailures: undefined }, physicalKit: { location: 'Private handoff, separate from public screenshots', ...stamp(adopted), files: kit } });
    success = true;
  }
} catch (error) {
  await page.screenshot({ path: resolve(recordingDir, 'failed-screen.png'), fullPage: true }).catch(() => undefined);
  throw error;
} finally {
  await Promise.allSettled([...responseTasks]); await context.close(); await browser.close(); await app?.close();
  await json(resolve(recordingDir, 'recording-status.json'), { success, mode, sourceSha: options['--source-sha'] ?? codeSha(), toolingSha: codeSha(), captureScriptSha256: sha256(await readFile(new URL(import.meta.url))), synchronization, scenes, runId: latestRun?.id, serverStatus: latestRun?.status, runPosts, pageErrors: requestFailures, video: relative(paths.privateDir, await page.video()!.path()), finishedAt: new Date().toISOString() });
  console.log(JSON.stringify({ success, mode, recordingDir, runPosts }));
}

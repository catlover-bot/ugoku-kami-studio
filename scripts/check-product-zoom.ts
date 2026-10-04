import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { parseDesignDocument } from '@ugoku/core';
import { INSTRUCTION_PAGE_COUNT } from '@ugoku/export';

// Run after a production build. PRODUCT_ZOOM_SOURCE_ROOT may point to a different
// checkout: only source/build hashes and copies are read there. The snapshot,
// browser profile, download files and AI-disabled server belong to this check.
// Example: PRODUCT_ZOOM_SOURCE_ROOT=/path/to/built/checkout npx tsx scripts/check-product-zoom.ts
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(process.env.PRODUCT_ZOOM_SOURCE_ROOT ?? repository);
const port = Number(process.env.PRODUCT_ZOOM_PORT ?? '4821');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PRODUCT_ZOOM_PORT must be an integer from 1024 to 65535');
const origin = `http://127.0.0.1:${port}`;
const output = resolve(repository, 'artifacts/goal005/product-zoom', new Date().toISOString().replaceAll(/[:.]/g, '-'));
const snapshot = join(output, 'build-snapshot');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const checkedAt = new Date().toISOString();
const references = [
  'https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom',
  'https://playwright.dev/docs/chrome-extensions',
];
type FileDigest = { path: string; bytes: number; sha256: string };
type Stamp = { designId: string; revision: number; designHash: string };
type ChromeApi = { chrome: { tabs: {
  query: (options: object) => Promise<{ id?: number; url?: string }[]>;
  setZoom: (id: number, factor: number) => Promise<void>;
  getZoom: (id: number) => Promise<number>;
} } };

async function inventory(root: string, paths: string[]) {
  const files: FileDigest[] = [];
  async function visit(path: string) {
    const entries = await readdir(join(root, path), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`Source inventory refuses symbolic links: ${path}/${entry.name}`);
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) await add(child);
    }
  }
  async function add(path: string) {
    const bytes = await readFile(join(root, path));
    files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  for (const path of paths) {
    if (path.endsWith('.json') || path.endsWith('.ts') || path.endsWith('.mjs')) await add(path);
    else await visit(path);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { sha256: sha256(JSON.stringify(files)), files };
}
async function unusedPort() {
  const probe = createServer();
  await new Promise<void>((accept, reject) => { probe.once('error', reject); probe.listen(port, '0.0.0.0', accept); });
  await new Promise<void>((accept, reject) => probe.close(error => error ? reject(error) : accept()));
}
async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise<void>(accept => {
    const timer = setTimeout(() => { server.kill('SIGKILL'); }, 5000);
    server.once('exit', () => { clearTimeout(timer); accept(); });
    server.kill('SIGTERM');
  });
}
async function stamp(page: Page, selector = 'main'): Promise<Stamp> {
  const result = await page.locator(selector).evaluate(element => ({
    designId: element.getAttribute('data-design-id') ?? '',
    revision: Number(element.getAttribute('data-design-revision')),
    designHash: element.getAttribute('data-design-hash') ?? '',
  }));
  expect(result.designId).not.toBe('');
  expect(result.revision).toBeGreaterThan(0);
  expect(result.designHash).toMatch(/^[a-f0-9]{64}$/);
  return result;
}
async function viewport(page: Page) {
  return page.evaluate(() => ({
    innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio,
    visualViewportScale: visualViewport?.scale, scrollWidth: document.documentElement.scrollWidth,
  }));
}
async function target(control: Locator, keyboard = false) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const result = await control.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      name: element.getAttribute('aria-label') ?? element.textContent?.trim(),
      width: rect.width, height: rect.height, x: rect.x, y: rect.y,
      uncovered: element === hit || element.contains(hit),
      focus: document.activeElement === element, outlineStyle: getComputedStyle(element).outlineStyle,
    };
  });
  expect(result.width).toBeGreaterThanOrEqual(44);
  expect(result.height).toBeGreaterThanOrEqual(44);
  expect(result.uncovered).toBe(true);
  if (keyboard) { expect(result.focus).toBe(true); expect(result.outlineStyle).not.toBe('none'); }
  return result;
}

await mkdir(snapshot, { recursive: true });
const source = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(),
  hasWorkingChanges: execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: sourceRoot, encoding: 'utf8' }).trim().length > 0,
  inventory: await inventory(sourceRoot, ['apps/web/src', 'apps/server/src', 'packages/core/src', 'packages/export/src', 'package.json', 'package-lock.json', 'scripts/build-server.mjs']),
};
await cp(join(sourceRoot, 'dist/server'), join(snapshot, 'dist/server'), { recursive: true, errorOnExist: true, force: false });
await cp(join(sourceRoot, 'apps/web/dist'), join(snapshot, 'apps/web/dist'), { recursive: true, errorOnExist: true, force: false });
const build = await inventory(snapshot, ['dist/server', 'apps/web/dist']);
expect(await inventory(sourceRoot, ['dist/server', 'apps/web/dist'])).toEqual(build);
expect(await inventory(sourceRoot, ['apps/web/src', 'apps/server/src', 'packages/core/src', 'packages/export/src', 'package.json', 'package-lock.json', 'scripts/build-server.mjs'])).toEqual(source.inventory);
await writeFile(join(snapshot, 'empty.env'), '');
await unusedPort();
const server = spawn(process.execPath, ['dist/server/index.js'], {
  cwd: snapshot, stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH ?? '', PORT: String(port), AI_ENABLED: 'false', GEMINI_API_KEY: '', AI_ACCESS_SECRET: '', LIVE_API_AUTHORIZED: '', UGOKU_ENV_FILE: join(snapshot, 'empty.env') },
});
let serverLog = '';
server.stdout!.on('data', bytes => { serverLog += String(bytes); });
server.stderr!.on('data', bytes => { serverLog += String(bytes); });
const temporary = await mkdtemp(join(tmpdir(), 'ugoku-product-zoom-'));
let context: BrowserContext | undefined;
const steps: object[] = [];
const screenshots: FileDigest[] = [];
const prohibitedRequests: string[] = [];
const pageErrors: string[] = [];
const evidence: Record<string, unknown> = {
  checkedAt, status: 'running', source, build,
  checkKind: 'Actual Chromium tab zoom at 200% via chrome.tabs.setZoom and getZoom; not CSS zoom, viewport-only reflow or CDP page scale',
  scriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  referenceCheckedAt: checkedAt.slice(0, 10), references,
  paidApiCalls: 0, realPhone: false, operatingSystemIme: 'not verified', physicalValidation: 'unverified',
  steps, screenshots, prohibitedRequests, pageErrors,
};
try {
  await expect.poll(async () => {
    if (server.exitCode !== null) throw new Error('Isolated production server exited before health verification');
    try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; }
  }, { timeout: 15_000 }).toBe(true);
  const status = await (await fetch(`${origin}/api/status`)).json() as { ai: { enabled: boolean; mode: string } };
  expect(status.ai.enabled).toBe(false); expect(status.ai.mode).toBe('manual');
  evidence.connection = status.ai;
  const extension = join(temporary, 'extension'); await mkdir(extension);
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Isolated product zoom verification', version: '1.0.0', permissions: ['tabs'], background: { service_worker: 'worker.js' } }));
  await writeFile(join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    channel: 'chromium', headless: true, viewport: null, acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1440,1000'],
  });
  context.setDefaultTimeout(15_000);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
    if (url.origin !== origin || url.pathname.startsWith('/api/sessions')) {
      prohibitedRequests.push(`${url.origin}${url.pathname}`); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await page.goto(origin);
  await expect(page.locator('.home-library')).toBeVisible();
  evidence.browser = context.browser()?.version();
  evidence.beforeZoom = await viewport(page);
  const before = await viewport(page);
  const tab = await worker.evaluate(async origin => {
    const api = (globalThis as unknown as ChromeApi).chrome.tabs;
    const matches = (await api.query({})).filter(item => item.url && new URL(item.url).origin === origin);
    if (matches.length !== 1 || matches[0]!.id === undefined) throw new Error('Expected exactly one isolated product tab');
    const id = matches[0]!.id;
    await api.setZoom(id, 2);
    return { id, zoom: await api.getZoom(id) };
  }, origin);
  expect(tab.zoom).toBe(2);
  evidence.browserZoom = tab.zoom;
  await expect.poll(async () => (await viewport(page)).innerWidth).toBeLessThanOrEqual(Math.ceil(before.innerWidth / 2));
  const cdp = await context.newCDPSession(page);
  async function capture(name: string, controls: Locator[], design?: Stamp) {
    const current = await viewport(page);
    expect(current.scrollWidth).toBeLessThanOrEqual(current.innerWidth + 1);
    const targets = [];
    for (const control of controls) targets.push(await target(control));
    if (controls.length) await controls[0]!.scrollIntoViewIfNeeded();
    const zoom = await worker.evaluate(async id => (globalThis as unknown as ChromeApi).chrome.tabs.getZoom(id), tab.id);
    expect(zoom).toBe(2);
    steps.push({ name, viewport: current, zoom, design: design ?? await stamp(page), targets });
    // Capture the real tab surface; fixed Playwright clips can crop host zoom.
    const screen = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    const bytes = Buffer.from(screen.data, 'base64'), path = `${name}.png`;
    await writeFile(join(output, path), bytes); screenshots.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const sample = page.locator('.home-library').getByRole('button', { name: 'サンプルで試す', exact: true });
  await capture('01-home', [sample]);
  await sample.click();
  await expect(page.locator('.workflow')).toBeVisible();
  const workflow = page.locator('.workflow');
  await workflow.getByRole('button', { name: /絵を選ぶ$/ }).click();
  const initialStamp = await stamp(page);
  await capture('02-stage-one', [page.getByRole('button', { name: /^動きをつけるへ/ })]);
  await page.getByRole('button', { name: /^動きをつけるへ/ }).click();
  const distance = page.getByRole('textbox', { name: '動く距離（mm）', exact: true });
  await expect(distance).toBeVisible(); await distance.fill('18'); await distance.press('Enter');
  await expect(distance).toHaveValue('18');
  const acquired = await stamp(page);
  expect(acquired.revision).toBeGreaterThan(initialStamp.revision);
  expect(acquired.designHash).not.toBe(initialStamp.designHash);
  const toPrint = page.getByRole('button', { name: /^印刷する内容を確認する/ });
  await capture('03-stage-two', [toPrint]);
  await toPrint.click();
  const pdfButton = page.getByRole('button', { name: 'PDFをダウンロード', exact: true });
  const openGuide = page.getByRole('button', { name: '組み立てガイドを開く', exact: true });
  await expect(openGuide).toBeDisabled();
  await capture('04-stage-three', [pdfButton]);
  await page.getByRole('button', { name: '保存・再開', exact: true }).click();
  const projectPending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'プロジェクトを書き出す', exact: true }).click();
  const projectDownload = await projectPending;
  const projectPath = join(output, 'sample-acquired.ugoku.json'); await projectDownload.saveAs(projectPath);
  const projectBytes = await readFile(projectPath), project = JSON.parse(projectBytes.toString()) as { document: unknown; imageDataUrl: string; records: unknown[] };
  const document = parseDesignDocument(project.document);
  expect({ designId: document.designId, revision: document.revision, designHash: document.designHash }).toEqual(acquired);
  expect(project.records).toEqual([]);
  const image = Buffer.from(project.imageDataUrl.split(',')[1]!, 'base64');
  const imagePath = join(output, 'sample-input.png'); await writeFile(imagePath, image);
  evidence.input = { kind: 'Public repository turtle sample selected using the Home button', path: 'sample-input.png', sha256: sha256(image), projectPath: relative(output, projectPath), projectSha256: sha256(projectBytes), stamp: acquired };
  await page.getByRole('dialog', { name: '保存と再開' }).getByRole('button', { name: '閉じる', exact: true }).click();
  const pdfPending = page.waitForEvent('download', { timeout: 45_000 }); await pdfButton.click();
  const pdfDownload = await pdfPending, pdfPath = join(output, 'acquired-kit.pdf'); await pdfDownload.saveAs(pdfPath);
  const pdfBytes = await readFile(pdfPath), pdf = await PDFDocument.load(pdfBytes);
  expect(pdf.getTitle()).toBe(`${acquired.designId} revision ${acquired.revision}`);
  expect(pdf.getSubject()).toContain(acquired.designHash); expect(pdf.getSubject()).toContain('physically unverified');
  expect(pdf.getPageCount()).toBe(document.layout.sheets + INSTRUCTION_PAGE_COUNT);
  evidence.pdf = { path: relative(output, pdfPath), sha256: sha256(pdfBytes), pages: pdf.getPageCount(), title: pdf.getTitle(), subject: pdf.getSubject(), acquiredStamp: acquired };
  await expect(openGuide).toBeEnabled(); await openGuide.click();
  const guide = page.locator('.assembly-guide');
  await expect(guide).toBeVisible(); expect(await stamp(page, '.assembly-guide')).toEqual(acquired);
  const next = guide.getByRole('button', { name: '次の工程', exact: true });
  const close = guide.getByRole('button', { name: 'ガイドを閉じる', exact: true });
  await expect(guide.locator('.assembly-guide-step')).toHaveAttribute('data-step', '1');
  await capture('05-acquired-guide-step-one', [close, next], acquired);
  await guide.getByRole('region', { name: '工程1の組み立て図', exact: true }).focus();
  await page.keyboard.press('Tab'); await expect(next).toBeFocused();
  evidence.keyboardNext = await target(next, true);
  await page.keyboard.press('Enter');
  await expect(guide.locator('.assembly-guide-step')).toHaveAttribute('data-step', '2');
  await capture('06-acquired-guide-step-two', [close, next], acquired);
  await close.click(); await expect(guide).toBeHidden(); await expect(openGuide).toBeFocused();
  evidence.closeRestoredFocus = true;
  await workflow.getByRole('button', { name: /動きをつける$/ }).click();
  await distance.fill('21'); await distance.press('Enter');
  const edited = await stamp(page); expect(edited.revision).toBeGreaterThan(acquired.revision);
  await workflow.getByRole('button', { name: /印刷して作る$/ }).click();
  await openGuide.click(); expect(await stamp(page, '.assembly-guide')).toEqual(acquired);
  await expect(guide.locator('.assembly-guide-version')).toContainText(`第${edited.revision}版`);
  await expect(guide.locator('.assembly-guide-step')).toHaveAttribute('data-step', '2');
  await capture('07-pinned-guide-after-edit', [close], acquired);
  await close.click(); await expect(openGuide).toBeFocused();
  evidence.finalEditorStamp = edited;
  expect(pageErrors).toEqual([]); expect(prohibitedRequests).toEqual([]);
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (context) await context.close();
  await stopServer(server);
  await rm(temporary, { recursive: true, force: true });
  await writeFile(join(output, 'server.log'), serverLog);
  await writeFile(join(output, 'manifest.json'), JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(`${JSON.stringify({ status: evidence.status, output: relative(repository, output), browserZoom: evidence.browserZoom, steps: steps.length, paidApiCalls: 0 })}\n`);
}

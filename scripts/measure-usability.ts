import { chromium, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform } from 'node:os';
import sharp from 'sharp';
import { manual, precision, saveProject, stage } from '../tests/e2e/helpers';

type Mode = 'revision' | 'candidate' | 'pdf';
type Measurement = { operation: string; durationMs: number; revision: string | null; hash: string | null };
type Probe = { operation: string; mode: Mode; start: number; originalRevision: string | null; done: boolean };
type Instrumented = Window & { ugokuProbe?: Probe; ugokuMeasurements: Measurement[]; ugokuLongTasks: number[] };

async function instrument(page: Page) {
  await page.evaluate(() => {
    const state = window as unknown as Instrumented;
    state.ugokuMeasurements = []; state.ugokuLongTasks = [];
    new PerformanceObserver(list => { state.ugokuLongTasks.push(...list.getEntries().map(item => item.duration)); }).observe({ type: 'longtask' });
    const done = () => {
      const probe = state.ugokuProbe;
      if (!probe || probe.done || probe.start < 0) return;
      probe.done = true;
      const design = document.querySelector('main')!;
      state.ugokuMeasurements.push({ operation: probe.operation, durationMs: performance.now() - probe.start, revision: design.getAttribute('data-design-revision'), hash: design.getAttribute('data-design-hash') });
    };
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (state.ugokuProbe?.mode === 'pdf' && this.download.endsWith('.pdf')) done();
      return originalClick.call(this);
    };
    new MutationObserver(() => {
      const probe = state.ugokuProbe;
      if (!probe || probe.done || probe.start < 0 || probe.mode === 'pdf') return;
      const ready = probe.mode === 'revision'
        ? document.querySelector('main')?.getAttribute('data-design-revision') !== probe.originalRevision
        : !!document.querySelector('.intent-panel .design-comparison');
      if (ready) requestAnimationFrame(() => requestAnimationFrame(done));
    }).observe(document.querySelector('main')!, { subtree: true, attributes: true, childList: true });
  });
}

async function arm(page: Page, operation: string, mode: Mode, selector: string, eventName = 'click') {
  await page.evaluate(({ operation, mode, selector, eventName }) => {
    const state = window as unknown as Instrumented;
    state.ugokuProbe = { operation, mode, start: -1, done: false, originalRevision: document.querySelector('main')!.getAttribute('data-design-revision') };
    const listener = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest(selector)) return;
      state.ugokuProbe!.start = performance.now();
      document.removeEventListener(eventName, listener, true);
    };
    document.addEventListener(eventName, listener, true);
  }, { operation, mode, selector, eventName });
}

async function completed(page: Page) {
  try { await expect.poll(() => page.evaluate(() => !!(window as unknown as Instrumented).ugokuProbe?.done)).toBe(true); }
  catch (error) {
    process.stderr.write(`${JSON.stringify(await page.evaluate(() => ({ probe: (window as unknown as Instrumented).ugokuProbe, revision: document.querySelector('main')?.getAttribute('data-design-revision'), selected: document.querySelector('[data-selection="move"]')?.outerHTML, svg: document.querySelector('#workbench .artwork-svg')?.getBoundingClientRect().toJSON() })), null, 2)}\n`);
    throw error;
  }
}

const inputPath = process.env.MEASURE_INPUT_PATH ?? 'artifacts/goal003/inputs/pattern.png';
const reportName = process.env.MEASURE_REPORT_NAME ?? 'performance';
if (!/^[a-z0-9-]+$/.test(reportName)) throw new Error('MEASURE_REPORT_NAME must be a plain lowercase file stem');
const input = await readFile(inputPath);
const metadata = await sharp(input).metadata();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15_000);
  // tsx preserves nested function names with this identity helper when evaluate() serializes them.
  await page.addInitScript('globalThis.__name = (value) => value;');
  await page.goto(process.env.MEASURE_BASE_URL ?? 'http://127.0.0.1:4173');
  await instrument(page);
  await page.getByLabel('画像を選ぶ', { exact: true }).setInputFiles({ name: 'pattern.png', mimeType: 'image/png', buffer: input });
  await expect(page.getByRole('button', { name: '選択の編集を終える', exact: true })).toBeVisible();
  const initial = await saveProject(page);
  for (let iteration = 0; iteration < 3; iteration++) {
    await stage(page, 1);
    if (await page.getByRole('button', { name: '動かす部分を選び直す', exact: true }).isVisible()) await page.getByRole('button', { name: '動かす部分を選び直す', exact: true }).click();
    const preview = page.locator('#workbench .artwork-svg'); await preview.scrollIntoViewIfNeeded();
    const coordinates = await preview.evaluate((element, { doc, iteration }) => {
      const scale = doc.artwork.placement.width / doc.input.image.widthPx;
      const convert = (x: number, y: number) => {
        const sourceX = x * doc.input.image.widthPx / 700, sourceY = y * doc.input.image.heightPx / 500;
        const point = new DOMPoint(doc.artwork.placement.x + sourceX * scale, doc.artwork.placement.y + sourceY * scale).matrixTransform((element as SVGSVGElement).getScreenCTM()!);
        return { x: point.x, y: point.y };
      };
      // Begin outside the previous rectangle and its enlarged corner targets each time.
      const rectangles = [[260, 170, 420, 320], [180, 100, 340, 250], [400, 80, 560, 230]] as const;
      const rect = rectangles[iteration]!;
      return { start: convert(rect[0], rect[1]), end: convert(rect[2], rect[3]) };
    }, { doc: initial.document, iteration });
    await arm(page, `selection-${iteration + 1}`, 'revision', '#workbench .artwork-svg', 'pointerup');
    await page.mouse.move(coordinates.start.x, coordinates.start.y); await page.mouse.down();
    await page.mouse.move(coordinates.end.x, coordinates.end.y, { steps: 8 }); await page.mouse.up();
    await completed(page);
  }
  await precision(page);
  for (const value of ['17', '18', '19']) {
    await arm(page, `adjust-${value}mm`, 'revision', '#travel', 'input');
    await page.getByLabel('動く距離（mm）', { exact: true }).fill(value); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter'); await completed(page);
  }
  await manual(page);
  for (const value of ['15', '16', '17']) {
    await page.getByLabel('どう動かしたいですか？', { exact: true }).fill(`動く距離を${value}mmにしたい`);
    await arm(page, `candidate-${value}mm`, 'candidate', '.intent-panel button');
    await page.getByRole('button', { name: '手動支援で候補をつくる', exact: true }).click(); await completed(page);
    await arm(page, `adopt-${value}mm`, 'revision', '.intent-panel .design-comparison button');
    await page.locator('.intent-panel').getByRole('button', { name: 'この案にする', exact: true }).click(); await completed(page);
  }
  await stage(page, 3);
  for (let iteration = 0; iteration < 3; iteration++) {
    await arm(page, `pdf-${iteration + 1}`, 'pdf', '.kit-download .export-button');
    const waiting = page.waitForEvent('download');
    await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
    await waiting; await completed(page);
  }
  const captured = await page.evaluate(() => {
    const state = window as unknown as Instrumented;
    return { measurements: state.ugokuMeasurements, longTasksMs: state.ugokuLongTasks, userAgent: navigator.userAgent, devicePixelRatio, hardwareConcurrency: navigator.hardwareConcurrency, resources: performance.getEntriesByType('resource').filter(item => item.name.includes('/fonts/')).map(item => ({ name: new URL(item.name).pathname, duration: item.duration, transferSize: (item as PerformanceResourceTiming).transferSize })) };
  });
  const result = { date: new Date().toISOString(), kind: 'Local headless Chromium measurement, not user or mobile device evidence; no Gemini calls', input: { path: inputPath, bytes: input.length, width: metadata.width, height: metadata.height, sha256: createHash('sha256').update(input).digest('hex'), normalizedImageId: initial.document.input.image.id }, environment: { browser: browser.version(), node: process.version, platform: platform(), architecture: arch(), cpuModel: cpus()[0]?.model, viewport: { width: 1440, height: 900 }, concurrency: 'single browser measurement page; other workspace activity may exist' }, method: { iterations: 3, revision: 'Captured input/pointerup/click event to changed main revision plus two requestAnimationFrame callbacks', candidate: 'Captured click to candidate DOM plus two requestAnimationFrame callbacks', pdf: 'Captured click to real PDF bytes ready and native download click; includes font fetch and worker creation if applicable; download event also awaited', warmth: 'Same loaded page. PDF first and repeats separately identified; font resource timings recorded. No CPU/network throttling.' }, ...captured, longTaskSummary: { count: captured.longTasksMs.length, maximumMs: Math.max(0, ...captured.longTasksMs) } };
  await mkdir('artifacts/goal003/usability', { recursive: true });
  await writeFile(`artifacts/goal003/usability/${reportName}.json`, JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally { await browser.close(); }

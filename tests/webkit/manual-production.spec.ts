import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, type PDFPage } from 'pdf-lib';
import sharp from 'sharp';
import { getAssemblySteps, type DesignDocument } from '@ugoku/core';
import { INSTRUCTION_PAGE_COUNT } from '@ugoku/export';
import type { Project } from '../../apps/web/src/project';

type SavedWorkspace = {
  project: Project;
  draft: { stage: number; guide?: { designId: string; revision: number; designHash: string; step: number; document?: DesignDocument } };
};
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const pdfLabels = { all: 'PDFをダウンロード', pattern: '型紙だけを保存', instructions: '組み立て説明だけを保存' } as const;

/** Read native persisted bytes only; do not call repository or React methods. */
async function readSaved(page: Page): Promise<SavedWorkspace> {
  const id = await page.locator('main').getAttribute('data-workspace-id');
  if (!id) throw new Error('The browser has no saved workspace ID');
  return page.evaluate(id => new Promise<SavedWorkspace>((resolve, reject) => {
    const open = indexedDB.open('ugoku-kami.workspaces.v1');
    open.onerror = () => reject(open.error);
    open.onupgradeneeded = () => { open.transaction?.abort(); reject(new Error('Expected existing native storage')); };
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction(['projects', 'drafts'], 'readonly');
      const project = tx.objectStore('projects').get(id), draft = tx.objectStore('drafts').get(id);
      tx.oncomplete = () => {
        db.close();
        try { resolve({ project: JSON.parse(project.result), draft: draft.result }); } catch (error) { reject(error); }
      };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), id);
}

async function stage(page: Page, number: 1 | 2 | 3) {
  await page.locator('.workflow').getByRole('button', { name: new RegExp(`${['絵を選ぶ', '動きをつける', '印刷して作る'][number - 1]}$`) }).click();
}

function commands(page: PDFPage): string {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map(ref => page.doc.context.lookup(ref)) : [contents];
  return streams.map(stream => {
    if (!(stream instanceof PDFRawStream)) throw new Error('Missing PDF page drawing stream');
    return (stream.dict.get(PDFName.of('Filter'))?.toString() === '/FlateDecode' ? inflateSync(stream.getContents()) : Buffer.from(stream.getContents())).toString('utf8');
  }).join('\n');
}

test('own artwork survives native save and reload, then downloads matching split PDFs and restores the acquired guide', async ({ page, browser }, info) => {
  const consoleErrors: string[] = [], apiRuns: string[] = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('request', request => { if (/\/api\/runs(?:\/|$)/.test(new URL(request.url()).pathname)) apiRuns.push(request.url()); });
  // Original developer drawing with its moving contour wholly inside the chosen rectangle.
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="white"/><path d="M345 172L314 202L345 232Z" fill="#ad573f"/><ellipse cx="397" cy="202" rx="43" ry="28" fill="#c99442"/><circle cx="417" cy="196" r="5" fill="#292923"/><path d="M70 368H570" stroke="#799a87" stroke-width="6"/></svg>';
  const png = await sharp(Buffer.from(source)).png().toBuffer();
  await writeFile(info.outputPath('developer-fish.png'), png);
  await page.goto('/');
  const choosing = page.waitForEvent('filechooser');
  await page.locator('.home-library').getByRole('button', { name: '自分の絵ではじめる', exact: true }).click();
  await (await choosing).setFiles({ name: '開発者の魚.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.workflow')).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('data-save-status', 'saved', { timeout: 15_000 });
  const initial = await readSaved(page);
  expect(initial.project.document.input.image).toMatchObject({ widthPx: 640, heightPx: 480, mimeType: 'image/png' });
  expect(initial.project.imageDataUrl).toMatch(/^data:image\/png;base64,/);
  expect(sha256(Buffer.from(initial.project.imageDataUrl.split(',')[1]!, 'base64'))).toBe(initial.project.document.input.image.id);

  await page.getByRole('button', { name: '2点で囲む', exact: true }).click();
  const preview = page.locator('#workbench .artwork-svg');
  await preview.scrollIntoViewIfNeeded();
  const points = await preview.evaluate((element, document) => {
    const p = document.artwork.placement, scale = p.width / document.input.image.widthPx;
    return [[300, 150], [460, 270]].map(([x, y]) => {
      const point = new DOMPoint(p.x + x! * scale, p.y + y! * scale).matrixTransform((element as SVGSVGElement).getScreenCTM()!);
      return { x: point.x, y: point.y };
    });
  }, initial.project.document);
  // This is Playwright touch emulation, not a claim about real touchscreen hardware.
  for (const point of points) await page.touchscreen.tap(point.x, point.y);
  await page.getByRole('button', { name: '選択の編集を終える', exact: true }).click();
  await stage(page, 2);
  const travel = page.getByLabel('動く距離（mm）', { exact: true });
  await travel.fill('18'); await travel.press('Enter');
  await expect.poll(async () => (await readSaved(page)).project.document.input.travelMm).toBe(18);
  const acquired = (await readSaved(page)).project, document = acquired.document;
  expect(document.input.selection).toEqual({ x: 300, y: 150, width: 160, height: 120 });
  expect(acquired.imageDataUrl).toBe(initial.project.imageDataUrl);
  expect(acquired.records).toEqual([]);
  await page.reload();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', document.designHash);
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('18');
  expect((await readSaved(page)).project).toEqual(acquired);
  await page.screenshot({ path: info.outputPath('restored-own-artwork.png'), scale: 'css' });

  await stage(page, 3);
  const drawings: Record<string, string[]> = {}, downloadEvidence = [];
  for (const mode of ['all', 'pattern', 'instructions'] as const) {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: pdfLabels[mode], exact: true }).click();
    const download = await pending, path = info.outputPath(`${mode}.pdf`);
    await download.saveAs(path);
    const bytes = await readFile(path), pdf = await PDFDocument.load(bytes);
    expect(download.suggestedFilename()).toBe(`${document.designId}-r${document.revision}${mode === 'all' ? '' : `-${mode}`}.pdf`);
    expect(pdf.getTitle()).toBe(`${document.designId} revision ${document.revision}`);
    expect(pdf.getSubject()).toContain(document.designHash);
    expect(pdf.getSubject()).toContain('physically unverified');
    if (mode !== 'all') expect(pdf.getSubject()).toContain(`PDF mode: ${mode}`);
    expect(pdf.getPageCount()).toBe(mode === 'all' ? document.layout.sheets + INSTRUCTION_PAGE_COUNT : mode === 'pattern' ? document.layout.sheets : INSTRUCTION_PAGE_COUNT);
    for (const sheet of pdf.getPages()) {
      expect(sheet.getWidth()).toBeCloseTo(210 * 72 / 25.4, 8);
      expect(sheet.getHeight()).toBeCloseTo(297 * 72 / 25.4, 8);
      expect(sheet.getRotation().angle).toBe(0);
    }
    drawings[mode] = pdf.getPages().map(commands);
    downloadEvidence.push({ mode, filename: download.suggestedFilename(), sha256: sha256(bytes), pages: pdf.getPageCount(), title: pdf.getTitle(), subject: pdf.getSubject(), drawingHashes: drawings[mode]!.map(sha256) });
  }
  expect(drawings.pattern).toEqual(drawings.all!.slice(0, document.layout.sheets));
  expect(drawings.instructions).toEqual(drawings.all!.slice(document.layout.sheets));
  await page.screenshot({ path: info.outputPath('split-print.png'), scale: 'css' });

  await page.getByRole('button', { name: '組み立てガイドを開く', exact: true }).click();
  const guide = page.locator('.assembly-guide');
  await expect(guide).toHaveAttribute('data-design-hash', document.designHash);
  await guide.getByRole('button', { name: '次の工程', exact: true }).click();
  await guide.getByRole('button', { name: '次の工程', exact: true }).click();
  await expect(guide.locator('.assembly-guide-step')).toHaveAttribute('data-step', '3');
  for (const note of [...getAssemblySteps(document)[2]!.glueInstructions, ...getAssemblySteps(document)[2]!.doNotGlue]) await expect(guide).toContainText(note);
  await expect.poll(async () => (await readSaved(page)).draft.guide?.step).toBe(3);
  const beforeReload = await readSaved(page);
  expect(beforeReload.project).toEqual(acquired);
  expect(beforeReload.draft.guide).toMatchObject({ document, designHash: document.designHash, revision: document.revision, step: 3 });
  await page.reload();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', document.designHash);
  await page.getByRole('button', { name: '組み立てガイドを開く', exact: true }).click();
  await expect(guide).toHaveAttribute('data-design-hash', document.designHash);
  await expect(guide.locator('.assembly-guide-step')).toHaveAttribute('data-step', '3');
  expect((await readSaved(page)).project).toEqual(acquired);
  expect(acquired.document.physicalValidation).toBe('unverified');
  expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('restored-guide.png'), scale: 'css' });
  expect(apiRuns).toEqual([]); expect(consoleErrors).toEqual([]);
  const manifest = {
    capturedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    browserEngine: browser.browserType().name(), browserVersion: browser.version(), viewport: page.viewportSize(),
    scope: 'Actual local production UI, native IndexedDB and PDF worker downloads; automated engine and touch emulation, not an iPhone or physical paper test',
    input: { file: 'developer-fish.png', sha256: sha256(png), provenance: 'Original developer vector drawing rasterized with Sharp' },
    design: { id: document.designId, revision: document.revision, hash: document.designHash },
    persistedGuideStep: 3, downloads: downloadEvidence, paidApiCalls: 0, physicalValidation: 'unverified', visualReview: 'Screenshots generated; human review is separate',
  };
  await writeFile(info.outputPath('manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await info.attach('verification manifest', { body: JSON.stringify(manifest, null, 2), contentType: 'application/json' });
});

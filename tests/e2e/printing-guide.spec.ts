import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, type PDFPage } from 'pdf-lib';
import { createDesign, getAssemblySteps, SAMPLE_INPUT, type DesignDocument } from '@ugoku/core';
import { INSTRUCTION_PAGE_COUNT, ORIGINAL_SAMPLE_SVG } from '@ugoku/export';
import type { Project } from '../../apps/web/src/project';
import { saveProject, savedProject, savedWorkspace, stage, startSample } from './helpers';

const outputRoot = 'artifacts/goal005/printing-guide';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const downloads = {
  all: 'PDFをダウンロード', pattern: '型紙だけを保存', instructions: '組み立て説明だけを保存',
} as const;
type Mode = keyof typeof downloads;

/** Real downloaded drawing streams, including numeric scale/position operands. */
function drawingCommands(page: PDFPage) {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map(reference => page.doc.context.lookup(reference)) : [contents];
  return streams.map(stream => {
    if (!(stream instanceof PDFRawStream)) throw new Error('PDF content stream is missing');
    const bytes = stream.dict.get(PDFName.of('Filter'))?.toString() === '/FlateDecode' ? inflateSync(stream.getContents()) : stream.getContents();
    return new TextDecoder().decode(bytes);
  }).join('\n');
}
async function directory(info: TestInfo, name: string) {
  const path = resolve(outputRoot, info.project.name, name); await mkdir(path, { recursive: true }); return path;
}
async function manifest(path: string, page: Page, document: DesignDocument, evidence: object) {
  await writeFile(resolve(path, 'manifest.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    kind: 'Actual production browser interaction and downloads; Chromium emulation, not real mobile hardware',
    viewport: page.viewportSize(), design: { id: document.designId, revision: document.revision, hash: document.designHash },
    physicalValidation: 'unverified', paidApiCalls: 0, ...evidence,
  }, null, 2) + '\n');
}
async function downloadPdf(page: Page, mode: Mode, document: DesignDocument, path: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: downloads[mode], exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  await download.saveAs(path);
  const bytes = await readFile(path), pdf = await PDFDocument.load(bytes);
  expect(pdf.getTitle()).toBe(`${document.designId} revision ${document.revision}`);
  expect(pdf.getSubject()).toContain(document.designHash);
  expect(pdf.getSubject()).toContain('physically unverified');
  if (mode !== 'all') expect(pdf.getSubject()).toContain(`PDF mode: ${mode}`);
  expect(pdf.getPageCount()).toBe(mode === 'pattern' ? document.layout.sheets : mode === 'instructions' ? INSTRUCTION_PAGE_COUNT : document.layout.sheets + INSTRUCTION_PAGE_COUNT);
  for (const sheet of pdf.getPages()) {
    expect(sheet.getWidth()).toBeCloseTo(210 * 72 / 25.4, 8);
    expect(sheet.getHeight()).toBeCloseTo(297 * 72 / 25.4, 8);
    expect(sheet.getRotation().angle).toBe(0);
  }
  return { pdf, evidence: { path, sha256: sha256(bytes), pages: pdf.getPageCount(), title: pdf.getTitle(), subject: pdf.getSubject(), drawingHashes: pdf.getPages().map(sheet => sha256(drawingCommands(sheet))) } };
}
async function openGuide(page: Page) {
  await page.getByRole('button', { name: '組み立てガイドを開く', exact: true }).click();
  const guide = page.locator('.assembly-guide'); await expect(guide).toBeVisible(); return guide;
}
async function expectVersion(guide: Locator, document: DesignDocument) {
  await expect(guide).toHaveAttribute('data-design-id', document.designId);
  await expect(guide).toHaveAttribute('data-design-revision', String(document.revision));
  await expect(guide).toHaveAttribute('data-design-hash', document.designHash);
}
async function expectStep(guide: Locator, number: number) {
  await expect(guide.locator('.assembly-guide-step')).toHaveCount(1);
  await expect(guide.locator('.assembly-guide-step')).toHaveAttribute('data-step', String(number));
}
async function beginSample(page: Page) {
  await page.goto('/'); await startSample(page); return await saveProject(page) as Project;
}

// No live model calls, implementation-state mutation, or simulated PDF downloads.
test('P7 actual split downloads preserve every page of the same two-sheet rotated design', async ({ page }, info) => {
  test.setTimeout(60_000);
  const dir = await directory(info, 'split-rotated');
  const image = await sharp(Buffer.from(ORIGINAL_SAMPLE_SVG)).png().toBuffer();
  const document = createDesign({ ...SAMPLE_INPUT, widthMm: 220, heightMm: 160, image: { id: sha256(image), widthPx: 800, heightPx: 550, mimeType: 'image/png' } }, { designId: 'goal005-split-rotated', revision: 7 });
  expect(document.layout.sheets).toBe(2);
  expect(document.layout.placements.some(placement => placement.rotated)).toBe(true);
  const project = { format: 'ugoku-kami-project', version: 2, document, imageDataUrl: `data:image/png;base64,${image.toString('base64')}`, records: [] };
  const input = resolve(dir, 'input.ugoku.json'); await writeFile(input, JSON.stringify(project));
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.home-library').getByRole('button', { name: 'ファイルを読み込む', exact: true }).click();
  await (await chooser).setFiles(input);
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', document.designHash);
  await stage(page, 3);
  const all = await downloadPdf(page, 'all', document, resolve(dir, 'all.pdf'));
  const pattern = await downloadPdf(page, 'pattern', document, resolve(dir, 'pattern.pdf'));
  const instructions = await downloadPdf(page, 'instructions', document, resolve(dir, 'instructions.pdf'));
  // These are files fetched through three UI actions, not direct exporter calls.
  expect(pattern.pdf.getPages().map(drawingCommands)).toEqual(all.pdf.getPages().slice(0, document.layout.sheets).map(drawingCommands));
  expect(instructions.pdf.getPages().map(drawingCommands)).toEqual(all.pdf.getPages().slice(document.layout.sheets).map(drawingCommands));
  const persisted = await saveProject(page) as Project;
  // The fixture enters through JSON, where -0 is serialized as 0. Compare that full input value.
  expect(persisted.document).toEqual(JSON.parse(JSON.stringify(document))); expect(persisted.records).toEqual([]);
  const guide = await openGuide(page); await expectVersion(guide, document);
  await page.screenshot({ path: resolve(dir, 'guide.png'), scale: 'css' });
  await manifest(dir, page, document, { input: { path: input, imageSha256: sha256(image), provenance: 'Repository original sample SVG rasterized by Sharp; no private artwork' }, rotatedPlacement: true, downloads: [all.evidence, pattern.evidence, instructions.evidence] });
});

test('P7 acquired guide version and reading step survive edits and reload without becoming physical records', async ({ page }, info) => {
  test.setTimeout(60_000);
  const dir = await directory(info, 'pinned-guide');
  const acquired = await beginSample(page);
  await stage(page, 3);
  const firstPdf = await downloadPdf(page, 'pattern', acquired.document, resolve(dir, 'acquired-pattern.pdf'));
  let guide = await openGuide(page); await expectVersion(guide, acquired.document);
  await guide.getByRole('button', { name: '次の工程', exact: true }).click();
  await guide.getByRole('button', { name: '次の工程', exact: true }).click();
  await expectStep(guide, 3);
  const step = getAssemblySteps(acquired.document)[2]!;
  for (const line of [...step.glueInstructions, ...step.doNotGlue]) await expect(guide).toContainText(line);
  await guide.getByRole('button', { name: 'ガイドを閉じる', exact: true }).click();
  await stage(page, 2);
  const travel = page.getByLabel('動く距離（mm）', { exact: true });
  await travel.fill('18'); await travel.press('Enter');
  const current = await saveProject(page) as Project;
  expect(current.document.revision).toBe(acquired.document.revision + 1);
  expect(current.document.designHash).not.toBe(acquired.document.designHash);
  await stage(page, 3);
  guide = await openGuide(page); await expectVersion(guide, acquired.document); await expectStep(guide, 3);
  await expect(guide.locator('.assembly-guide-version')).toContainText(`第${current.document.revision}版`);
  await guide.getByRole('button', { name: '全工程', exact: true }).click();
  await expect(guide.locator('.assembly-guide-step')).toHaveCount(getAssemblySteps(acquired.document).length);
  await guide.getByRole('button', { name: '一工程ずつ', exact: true }).click(); await expectStep(guide, 3);
  await saveProject(page);
  const persisted = await savedWorkspace(page);
  expect(persisted.draft?.guide).toMatchObject({ designId: acquired.document.designId, revision: acquired.document.revision, designHash: acquired.document.designHash, step: 3, document: acquired.document });
  expect(persisted.project.records).toEqual([]);
  expect(persisted.project.document.physicalValidation).toBe('unverified');
  await page.reload();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', current.document.designHash);
  guide = page.locator('.assembly-guide');
  if (!await guide.isVisible()) { await stage(page, 3); guide = await openGuide(page); }
  await expectVersion(guide, acquired.document); await expectStep(guide, 3);
  await page.screenshot({ path: resolve(dir, 'old-guide-after-reload.png'), scale: 'css' });
  await guide.getByRole('button', { name: 'ガイドを閉じる', exact: true }).click();
  const newPdf = await downloadPdf(page, 'pattern', current.document, resolve(dir, 'new-pattern.pdf'));
  guide = await openGuide(page); await expectVersion(guide, current.document);
  await saveProject(page);
  const refreshed = await savedWorkspace(page);
  expect(refreshed.draft?.guide).toMatchObject({ document: current.document, designHash: current.document.designHash });
  expect(refreshed.project.records).toEqual([]); expect(refreshed.project.document.physicalValidation).toBe('unverified');
  await manifest(dir, page, current.document, { input: 'Original bundled turtle sample, selected through Home', preservedGuide: { revision: acquired.document.revision, hash: acquired.document.designHash, restoredStep: 3 }, physicalRecordCount: 0, downloads: [firstPdf.evidence, newPdf.evidence] });
});

test('P8 guide remains readable and keyboard reachable at 320 CSS px and 200% equivalent reflow', async ({ page }, info) => {
  test.setTimeout(60_000);
  const dir = await directory(info, 'guide-reflow'), project = await beginSample(page);
  await stage(page, 3); await downloadPdf(page, 'pattern', project.document, resolve(dir, 'pattern.pdf'));
  const guide = await openGuide(page), measurements = [];
  for (const viewport of [{ width: 320, height: 800 }, { width: 640, height: 400 }]) {
    await page.setViewportSize(viewport);
    for (const name of ['ガイドを閉じる', '次の工程', '全工程', '一工程ずつ']) {
      const control = guide.getByRole('button', { name, exact: true });
      await expect(control).toBeVisible();
      const bounds = await control.boundingBox();
      expect(bounds!.width, `${viewport.width}px ${name}`).toBeGreaterThanOrEqual(44);
      expect(bounds!.height, `${viewport.width}px ${name}`).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const diagram = guide.getByRole('region', { name: '工程1の組み立て図', exact: true });
    await diagram.focus(); await page.keyboard.press('ArrowRight');
    await expect.poll(() => diagram.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    const next = guide.getByRole('button', { name: '次の工程', exact: true });
    await next.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    await expect(next).toBeFocused();
    const focus = await next.evaluate(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      const point = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(1, rect.x + rect.width / 2)), Math.min(innerHeight - 1, Math.max(1, rect.y + rect.height / 2)));
      return { visible: rect.top >= 0 && rect.bottom <= innerHeight, uncovered: point === element || element.contains(point), outline: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
    });
    expect(focus.visible).toBe(true); expect(focus.uncovered).toBe(true); expect(focus.outline).not.toBe('none'); expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);
    measurements.push({ viewport, interpretation: viewport.width === 640 ? '1280x800 at 200% equivalent reflow; browser chrome zoom was not changed' : '320 CSS px viewport', focus });
    await page.screenshot({ path: resolve(dir, `${viewport.width}-focus.png`), scale: 'css' });
  }
  await guide.getByRole('button', { name: '全工程', exact: true }).click();
  await expect(guide.locator('.assembly-guide-step')).toHaveCount(6);
  await guide.getByRole('button', { name: '工程4を大きく読む', exact: true }).click(); await expectStep(guide, 4);
  await guide.getByRole('button', { name: '前の工程', exact: true }).click(); await expectStep(guide, 3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expectVersion(guide, project.document);
  await manifest(dir, page, project.document, { input: 'Original bundled turtle sample', measurements, accessibilityScope: '44 CSS px principal targets, document reflow, horizontal diagram keyboard scrolling, visible unobscured keyboard focus. Not a full WCAG or real-device audit.' });
});

test('P1 own artwork reaches a protected manual proposal and split print without opening advanced settings', async ({ page }, info) => {
  test.setTimeout(60_000);
  const dir = await directory(info, 'own-creation');
  const source = '<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="480" fill="white"/><path d="M345 172L314 202L345 232Z" fill="#ad573f"/><ellipse cx="397" cy="202" rx="43" ry="28" fill="#c99442"/><circle cx="417" cy="196" r="5" fill="#292923"/><path d="M70 368H570" stroke="#799a87" stroke-width="6"/></svg>';
  const png = await sharp(Buffer.from(source)).png().toBuffer(); await writeFile(resolve(dir, 'developer-fish.png'), png);
  await page.goto('/');
  const choosing = page.waitForEvent('filechooser');
  await page.locator('.home-library').getByRole('button', { name: '自分の絵ではじめる', exact: true }).click();
  await (await choosing).setFiles({ name: '開発者テストの魚.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.workflow')).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('data-save-status', 'saved');
  const initial = await savedProject(page) as Project;
  await page.getByRole('button', { name: '2点で囲む', exact: true }).click();
  const preview = page.locator('#workbench .artwork-svg'); await preview.scrollIntoViewIfNeeded();
  const points = await preview.evaluate((element, document) => {
    const scale = document.artwork.placement.width / document.input.image.widthPx;
    return [[300, 150], [460, 270]].map(([x, y]) => {
      const point = new DOMPoint(document.artwork.placement.x + x! * scale, document.artwork.placement.y + y! * scale).matrixTransform((element as SVGSVGElement).getScreenCTM()!);
      return { x: point.x, y: point.y };
    });
  }, initial.document);
  for (const point of points) await page.mouse.click(point.x, point.y);
  await page.getByRole('button', { name: '選択の編集を終える', exact: true }).click();
  await stage(page, 2);
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toBeVisible();
  const maxSheets = page.getByLabel('紙の上限（枚）', { exact: true }); await expect(maxSheets).toBeVisible();
  await maxSheets.fill('1'); await maxSheets.press('Enter');
  await page.getByLabel('絵の大きさを保つ', { exact: true }).check();
  await expect(page.locator('.numeric-details')).not.toHaveAttribute('open');
  const protectedBase = await saveProject(page) as Project;
  expect(protectedBase.document.input.locks).toEqual(expect.arrayContaining(['widthMm', 'heightMm']));
  expect(protectedBase.document.input.selection).toEqual({ x: 300, y: 150, width: 160, height: 120 });
  await page.getByRole('button', { name: '手動支援', exact: true }).click();
  await page.getByLabel('どう動かしたいですか？', { exact: true }).fill('もう少し大きく動かしたい。絵の大きさは変えず、紙も増やさない');
  await page.getByRole('button', { name: '手動支援で候補をつくる', exact: true }).click();
  const candidate = page.locator('.intent-panel .design-comparison'); await expect(candidate).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', protectedBase.document.designHash);
  const previews = candidate.locator('svg.artwork-svg');
  expect(await previews.nth(0).getAttribute('viewBox')).toBe(await previews.nth(1).getAttribute('viewBox'));
  await page.screenshot({ path: resolve(dir, 'candidate.png'), scale: 'css' });
  await candidate.getByRole('button', { name: 'この案にする', exact: true }).click();
  const adopted = await saveProject(page) as Project;
  expect(adopted.document.input.travelMm).toBeGreaterThan(protectedBase.document.input.travelMm);
  expect(adopted.document.input.widthMm).toBe(protectedBase.document.input.widthMm); expect(adopted.document.input.heightMm).toBe(protectedBase.document.input.heightMm);
  expect(adopted.document.input.image).toEqual(protectedBase.document.input.image); expect(adopted.document.input.selection).toEqual(protectedBase.document.input.selection);
  expect(adopted.document.input.maxSheets).toBe(1); expect(adopted.document.layout.sheets).toBe(1);
  await expect(page.locator('.numeric-details')).not.toHaveAttribute('open');
  await stage(page, 3);
  const pattern = await downloadPdf(page, 'pattern', adopted.document, resolve(dir, 'pattern.pdf'));
  const instructions = await downloadPdf(page, 'instructions', adopted.document, resolve(dir, 'instructions.pdf'));
  await page.screenshot({ path: resolve(dir, 'print.png'), scale: 'css' });
  expect(adopted.records).toEqual([]); expect(adopted.document.physicalValidation).toBe('unverified');
  await manifest(dir, page, adopted.document, { input: { path: resolve(dir, 'developer-fish.png'), sha256: sha256(png), provenance: 'Original code-native developer test drawing; not participant evidence' }, protectedBaseHash: protectedBase.document.designHash, advancedSettingsOpened: false, downloads: [pattern.evidence, instructions.evidence] });
});

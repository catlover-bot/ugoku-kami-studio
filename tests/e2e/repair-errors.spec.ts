import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { createDesign } from '@ugoku/core';
import { closeDialog, openSave, precision, saveProject, stage } from './helpers';

const imageHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function backgroundPng() {
  return sharp({ create: { width: 400, height: 300, channels: 3, background: '#e3b868' } }).composite([{ input: Buffer.from('<svg width="400" height="300"><path d="M0 100H400V140H0Z" fill="#4b756a"/></svg>') }]).png().toBuffer();
}
async function openRepair(page: Page) {
  await stage(page, 1);
  const details = page.locator('.background-repair');
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator('summary').click();
}
async function chooseBackground(page: Page, buffer: Buffer, mimeType = 'image/png', name = 'background.png') {
  await page.getByLabel('背景用の画像を選ぶ', { exact: true }).setInputFiles({ name, mimeType, buffer });
}
const candidate = (page: Page) => page.locator('.repair-candidate');

for (const format of ['jpeg', 'webp'] as const) {
  test(`U2/U5/U7 ${format} background passes the local decoder, becomes bound PNG, and exports that revision`, async ({ page }) => {
    await page.goto('/');
    const before = await saveProject(page);
    await openRepair(page);
    const input = await sharp(await backgroundPng()).toFormat(format).toBuffer();
    const received = page.waitForResponse(response => response.url().endsWith('/api/images') && response.request().method() === 'POST');
    await chooseBackground(page, input, `image/${format}`, `background.${format}`);
    const response = await received;
    expect(response.status()).toBe(200);
    const normalized = (await response.json()).image;
    expect(normalized.mimeType).toBe('image/png'); expect(normalized.widthPx).toBe(400); expect(normalized.heightPx).toBe(300);
    expect(normalized.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(normalized.id).toBe(imageHash(Buffer.from(normalized.dataUrl.split(',')[1], 'base64')));
    await expect(candidate(page)).toBeVisible();
    expect((await saveProject(page)).document).toEqual(before.document);
    await candidate(page).getByRole('button', { name: 'この案にする', exact: true }).click();
    const after = await saveProject(page);
    expect(after.document.revision).toBe(before.document.revision + 1);
    expect(after.document.schemaVersion).toBe(2); expect(after.document.designHash).not.toBe(before.document.designHash);
    expect(after.imageDataUrl).toBe(before.imageDataUrl);
    expect(after.backgroundImageDataUrl).toBe(normalized.dataUrl);
    expect(after.document.input.artworkRepair.image).toEqual({ id: normalized.id, widthPx: 400, heightPx: 300, mimeType: 'image/png' });
    await stage(page, 3);
    const waiting = page.waitForEvent('download'); await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
    const pdf = await PDFDocument.load(await readFile((await (await waiting).path())!));
    expect(pdf.getSubject()).toContain(after.document.designHash);
    expect(pdf.getPageCount()).toBe(after.document.layout.sheets + 4);
  });
}

test('U5/U6 rejected images and broken success responses leave the current design and saved source intact', async ({ page }) => {
  await page.goto('/'); const before = await saveProject(page); await openRepair(page);
  const bytes = await backgroundPng();
  let requests = 0;
  await page.route('**/api/images', route => { requests++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '背景画像の確認が一時的に利用できません。' } }) }); });
  const oversized = Buffer.from(bytes); oversized.writeUInt32BE(9000, 16);
  await chooseBackground(page, oversized);
  await expect(page.locator('.background-repair [role="alert"]')).toContainText(/8,192px/);
  expect(requests).toBe(0);
  expect((await saveProject(page)).document).toEqual(before.document);
  await chooseBackground(page, bytes);
  await expect(page.locator('.background-repair [role="alert"]')).toContainText('一時的');
  expect(requests).toBe(1); await expect(candidate(page)).toHaveCount(0);
  expect((await saveProject(page)).document).toEqual(before.document);
  await page.unroute('**/api/images');
  await page.route('**/api/images', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ image: { id: '0'.repeat(64), widthPx: 400, heightPx: 300, mimeType: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` } }) }));
  await chooseBackground(page, bytes);
  await expect(page.locator('.background-repair [role="alert"]')).toContainText(/背景|一致|画像/);
  await expect(candidate(page)).toHaveCount(0);
  const after = await saveProject(page);
  expect(after.document).toEqual(before.document); expect(after.imageDataUrl).toBe(before.imageDataUrl);
});

test('U4/U6 stale repair candidates must be rebuilt after edits, and a pending image cannot cross to another design with the same hash', async ({ page }) => {
  await page.goto('/'); const original = await saveProject(page); await openRepair(page);
  await page.getByLabel('背景の色', { exact: true }).fill('#e3b868');
  await page.getByRole('button', { name: 'この色で比較する', exact: true }).click();
  await precision(page); await page.getByLabel('動く距離（mm）', { exact: true }).fill('18');
  const edited = await saveProject(page); await openRepair(page);
  await expect(candidate(page)).toContainText('設計が変わりました');
  await expect(candidate(page).getByRole('button', { name: 'この案にする', exact: true })).toHaveCount(0);
  expect((await saveProject(page)).document).toEqual(edited.document);
  await page.getByRole('button', { name: '背景の候補を作り直す', exact: true }).click();
  await candidate(page).getByRole('button', { name: 'この案にする', exact: true }).click();
  const repaired = await saveProject(page);
  expect(repaired.document.revision).toBe(edited.document.revision + 1);
  expect(repaired.document.input.travelMm).toBe(18);
  expect(repaired.document.input.artworkRepair).toEqual({ mode: 'solid', color: '#e3b868' });

  const bytes = await backgroundPng(); let held: Route | undefined;
  await page.route('**/api/images', route => { held = route; });
  await chooseBackground(page, bytes); await expect.poll(() => !!held).toBe(true);
  const otherDocument = createDesign(repaired.document.input, { designId: 'other-equal-geometry', revision: repaired.document.revision });
  expect(otherDocument.designHash).toBe(repaired.document.designHash);
  await openSave(page);
  await page.getByLabel('プロジェクトファイルを選ぶ', { exact: true }).setInputFiles({ name: 'other.ugoku.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...repaired, document: otherDocument })) });
  await closeDialog(page);
  await expect(page.getByRole('status').filter({ hasText: 'プロジェクトを開きました' })).toBeVisible();
  await held!.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ image: { id: imageHash(bytes), widthPx: 400, heightPx: 300, mimeType: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` } }) });
  await expect(page.locator('.background-repair [role="alert"]')).toContainText('読み込み中に設計が変わりました');
  await expect(candidate(page)).toHaveCount(0);
  expect((await saveProject(page)).document).toEqual(otherDocument);
  expect(original.document.input.artworkRepair).toBeUndefined();
});

test('U5/U7 adopting a repair discards a PDF already in flight, then exports only the adopted revision', async ({ page }) => {
  await page.goto('/'); const before = await saveProject(page); await openRepair(page);
  await page.getByLabel('背景の色', { exact: true }).fill('#e3b868');
  await page.getByRole('button', { name: 'この色で比較する', exact: true }).click();
  let release!: () => void, requested = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/fonts/ZenKakuGothicNew-Regular.ttf', async route => { requested = true; await held; await route.continue(); });
  const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
  await stage(page, 3); await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await openRepair(page); await candidate(page).getByRole('button', { name: 'この案にする', exact: true }).click();
  const after = await saveProject(page);
  expect(after.document.designHash).not.toBe(before.document.designHash);
  release();
  await expect(page.getByRole('status').filter({ hasText: '古いPDFを破棄' })).toBeVisible();
  expect(downloads).toEqual([]);
  await page.unroute('**/fonts/ZenKakuGothicNew-Regular.ttf');
  await stage(page, 3); const waiting = page.waitForEvent('download'); await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
  const downloaded = await waiting, pdf = await PDFDocument.load(await readFile((await downloaded.path())!));
  expect(downloaded.suggestedFilename()).toContain(`-r${after.document.revision}.pdf`);
  expect(pdf.getSubject()).toContain(after.document.designHash); expect(pdf.getSubject()).not.toContain(before.document.designHash);
});

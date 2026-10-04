import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { MAX_IMAGE_BYTES, MAX_PROJECT_BYTES, type PhysicalRecord, type Project } from '../../apps/web/src/project';
import { startSample, saveProject, savedWorkspace, closeDialog, openSave, physical } from './helpers';

type PortableProject = Project & { format: 'ugoku-kami-project'; version: 2 };
const note = '容量境界の自動試験。合成画像のみ、実物検証は未実施。';
const recordFor = (project: PortableProject, id: string, photos: string[] = []): PhysicalRecord => ({
  id, designId: project.document.designId, designHash: project.document.designHash, revision: project.document.revision,
  pattern: 'synthetic-test.pdf', material: note, printScale: '', measuredLine: '', modifications: '', movement: '',
  endpoints: '', guideRetention: '', glueFaces: '', roundTrips: '', viewObservations: '', photoViews: [], photos,
});
async function downloadProject(page: Page) {
  await openSave(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'プロジェクトを書き出す', exact: true }).click();
  const download = await pending, path = (await download.path())!;
  const bytes = await readFile(path);
  await closeDialog(page);
  return { path, bytes, project: JSON.parse(bytes.toString('utf8')) as PortableProject };
}
async function importProject(page: Page, info: TestInfo, project: PortableProject, filename: string) {
  const path = info.outputPath(filename);
  await writeFile(path, JSON.stringify(project));
  await page.getByLabel('プロジェクトファイルを選ぶ', { exact: true }).setInputFiles(path);
}

test('oversized physical record stays editable, then exports and reimports after removing photos', async ({ page }, info) => {
  test.setTimeout(120_000);
  // Valid, developer-generated PNG: no personal image or live API is involved.
  const photoBytes = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ddd8ce' } }).png({ compressionLevel: 0 }).toBuffer();
  expect(photoBytes.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
  const photo = `data:image/png;base64,${photoBytes.toString('base64')}`;
  await page.goto('/'); await startSample(page);
  await expect(page.locator('.artwork-stage .artwork-svg > image').first()).toHaveAttribute('href', /^data:image\/png/);
  const initial = (await downloadProject(page)).project;
  const existing = { ...initial, records: [recordFor(initial, 'size-1', [photo, photo, photo, photo]), recordFor(initial, 'size-2', [photo, photo, photo, photo])] };
  expect(Buffer.byteLength(JSON.stringify(existing))).toBeLessThan(MAX_PROJECT_BYTES);
  await importProject(page, info, existing, 'under-limit.ugoku.json');
  await expect(page.locator('.status-message')).toContainText('ファイルから作品を開きました');
  await physical(page);
  await page.getByLabel('使った材料', { exact: true }).fill(note);
  await page.getByLabel('写真（4枚まで）', { exact: true }).setInputFiles(Array.from({ length: 4 }, (_, index) => ({ name: `synthetic-${index}.png`, mimeType: 'image/png', buffer: photoBytes })));
  await expect(page.locator('.physical-section > .record-photos img')).toHaveCount(4);
  await page.getByRole('button', { name: 'この設計版に記録を追加', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('プロジェクト全体は45MBまで');
  await expect(page.getByRole('alert')).toContainText('下書きは残っています');
  await expect(page.locator('.saved-record')).toHaveCount(2);
  await expect(page.getByLabel('使った材料', { exact: true })).toHaveValue(note);
  await expect(page.locator('.physical-section > .record-photos img')).toHaveCount(4);
  // Refused completed records remain a separate, restorable draft under its own limit.
  await saveProject(page);
  const refused = await savedWorkspace(page);
  expect(refused.project.records).toHaveLength(2);
  expect((refused.draft?.recordDraft as PhysicalRecord).photos).toHaveLength(4);
  expect(refused.project.document).toEqual(initial.document);
  // Mobile CSS pixels can leave a fractional border at the viewport edge.
  await expect(page.getByRole('alert')).toBeInViewport({ ratio: 0.99 });
  await page.screenshot({ path: info.outputPath('project-size-error.png'), scale: 'css' });
  await page.getByRole('button', { name: '写真を削除', exact: true }).last().click();
  await page.getByRole('button', { name: '写真を削除', exact: true }).last().click();
  await page.getByRole('button', { name: 'この設計版に記録を追加', exact: true }).click();
  await expect(page.locator('.saved-record')).toHaveCount(3);
  await expect(page.locator('.physical-section > .record-photos img')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const exported = await downloadProject(page);
  expect(exported.bytes.length).toBeLessThanOrEqual(MAX_PROJECT_BYTES);
  expect(exported.project.records.map(record => record.photos.length)).toEqual([4, 4, 2]);
  expect(exported.project.records.slice(0, 2)).toEqual(existing.records);
  expect(exported.project.document.designHash).toBe(initial.document.designHash);
  const saved = await saveProject(page);
  expect(saved.records).toEqual(exported.project.records);
  await expect(page.locator('.site-header .save-state')).toContainText('このブラウザに保存済み');
  await page.locator('.physical-section > summary').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('project-size-recovered.png'), scale: 'css' });
  await page.reload();
  await expect(page.locator('.workflow')).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', initial.document.designHash);
  await page.getByLabel('プロジェクトファイルを選ぶ', { exact: true }).setInputFiles(exported.path);
  await expect(page.locator('.status-message')).toContainText('ファイルから作品を開きました');
  await physical(page);
  await expect(page.locator('.saved-record')).toHaveCount(3);
  await expect(page.locator('.saved-record .record-photos img')).toHaveCount(10);
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', initial.document.designHash);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // An older oversized export is rejected without replacing the recovered project.
  const tooLarge = { ...existing, records: [...existing.records, recordFor(initial, 'oversized-old-export', [photo, photo, photo, photo])] };
  expect(Buffer.byteLength(JSON.stringify(tooLarge))).toBeGreaterThan(MAX_PROJECT_BYTES);
  await importProject(page, info, tooLarge, 'old-oversized.ugoku.json');
  await expect(page.getByRole('alert')).toContainText('プロジェクト全体は45MBまで');
  await expect(page.locator('.saved-record')).toHaveCount(3);
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', initial.document.designHash);
});

test('record-count and same-project merge limits preserve the current records and draft', async ({ page }, info) => {
  await page.goto('/'); await startSample(page);
  await expect(page.locator('.artwork-stage .artwork-svg > image').first()).toHaveAttribute('href', /^data:image\/png/);
  const initial = (await downloadProject(page)).project;
  const full = { ...initial, records: Array.from({ length: 100 }, (_, index) => recordFor(initial, `count-${index}`)) };
  await importProject(page, info, full, 'hundred-records.ugoku.json');
  await expect(page.locator('.status-message')).toContainText('ファイルから作品を開きました');
  await physical(page);
  await page.getByLabel('使った材料', { exact: true }).fill(note);
  await page.getByRole('button', { name: 'この設計版に記録を追加', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('100件まで');
  await expect(page.getByLabel('使った材料', { exact: true })).toHaveValue(note);
  await expect(page.locator('.saved-record')).toHaveCount(100);
  const alternate = { ...full, records: [...full.records.slice(0, 99), recordFor(initial, 'alternate-record')] };
  await importProject(page, info, alternate, 'alternate-hundred-records.ugoku.json');
  await expect(page.getByRole('alert')).toContainText('100件まで');
  await expect(page.getByLabel('使った材料', { exact: true })).toHaveValue(note);
  await expect(page.locator('.saved-record')).toHaveCount(100);
  await saveProject(page);
  const retained = await savedWorkspace(page);
  expect(retained.project.records).toEqual(full.records);
  expect((retained.draft?.recordDraft as PhysicalRecord).material).toBe(note);
  await page.getByLabel('使った材料', { exact: true }).fill('');
  const exported = await downloadProject(page);
  expect(exported.project.records).toEqual(full.records);
  expect(exported.project.document.designHash).toBe(full.document.designHash);
});

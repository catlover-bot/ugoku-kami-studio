import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import type { Project } from '../../apps/web/src/project';
import { startSample, closeDialog, openSave, physical, precision, stage } from './helpers';

/** These tests use only the AI-disabled application and real browser controls. */
async function stamp(page: Page) {
  return page.locator('main').evaluate(element => ({ hash: element.dataset.designHash!, revision: Number(element.dataset.designRevision) }));
}
async function portable(page: Page): Promise<Project> {
  await openSave(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'プロジェクトを書き出す', exact: true }).click();
  const download = await pending;
  const project = JSON.parse(await readFile((await download.path())!, 'utf8')) as Project;
  await closeDialog(page);
  return project;
}
async function ready(page: Page) {
  await page.goto('/'); await startSample(page);
  await expect(page.locator('.artwork-stage .artwork-svg > image').first()).toHaveAttribute('href', /^data:image\/png/);
}
const undo = (page: Page) => page.getByRole('button', { name: '元に戻す', exact: true });
const redo = (page: Page) => page.getByRole('button', { name: 'やり直す', exact: true });

test('P2 empty and decimal drafts preserve the committed design; Enter and blur each commit once', async ({ page }) => {
  await ready(page); await precision(page);
  const travel = page.getByLabel('動く距離（mm）', { exact: true });
  const width = page.getByLabel('作品の幅（mm）', { exact: true });
  await expect(travel).toHaveAttribute('type', 'text');
  await expect(travel).toHaveAttribute('inputmode', 'decimal');
  const base = await stamp(page);
  await travel.fill('');
  expect(await stamp(page)).toEqual(base);
  await expect(travel).toHaveValue('');
  await expect(travel).toBeFocused();
  await expect(page.locator('.error-message')).toHaveCount(0);
  await travel.press('Enter');
  await expect(travel).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.field-error')).toContainText('数値を入力');
  await expect(travel).toBeFocused();
  expect(await stamp(page)).toEqual(base);
  await travel.press('Escape');
  await expect(travel).toHaveValue('20');
  await travel.fill('18.');
  await expect(travel).toHaveValue('18.');
  expect(await stamp(page)).toEqual(base);
  await travel.fill('18.5'); await travel.press('Enter');
  await expect.poll(() => stamp(page)).toMatchObject({ revision: base.revision + 1 });
  const committed = await stamp(page);
  expect(committed.hash).not.toBe(base.hash);
  await width.focus(); // Enter's subsequent blur must not create a second revision.
  expect(await stamp(page)).toEqual(committed);
  await width.fill('159.5');
  expect(await stamp(page)).toEqual(committed);
  await travel.focus();
  await expect.poll(() => stamp(page)).toMatchObject({ revision: committed.revision + 1 });
  const afterBlur = await stamp(page);
  await travel.fill('1000'); await travel.press('Enter');
  await expect(travel).toHaveAttribute('aria-invalid', 'true');
  expect(await stamp(page)).toEqual(afterBlur);
  await expect(page.locator('.error-message')).toHaveCount(0);
  await travel.press('Escape');
  await expect(travel).toHaveValue('18.5');
  expect(await stamp(page)).toEqual(afterBlur);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('P2 composition Enter and ordinary text undo do not invoke design transactions', async ({ page }) => {
  await ready(page); await precision(page);
  const thickness = page.getByLabel('紙の厚さ（mm）', { exact: true });
  const base = await stamp(page);
  await thickness.focus();
  // Synthetic composition events cover handler behavior; this is not a claim
  // that a real OS Japanese IME or physical mobile keyboard was exercised.
  await thickness.dispatchEvent('compositionstart', { data: '' });
  await thickness.fill('0.35');
  await thickness.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
  expect(await stamp(page)).toEqual(base);
  await thickness.dispatchEvent('compositionend', { data: '0.35' });
  await thickness.press('Enter');
  await expect.poll(() => stamp(page)).toMatchObject({ revision: base.revision + 1 });
  const committed = await stamp(page);
  await thickness.press('ControlOrMeta+A');
  await thickness.pressSequentially('0.4');
  await thickness.press('ControlOrMeta+z');
  expect(await stamp(page)).toEqual(committed);
  await thickness.press('Escape');
  await expect(thickness).toHaveValue('0.35');
  expect(await stamp(page)).toEqual(committed);
});

test('P2 invalid draft requires a decision before PDF; cancelling it prints the established version', async ({ page }) => {
  await ready(page);
  const base = await portable(page);
  await precision(page);
  const travel = page.getByLabel('動く距離（mm）', { exact: true });
  await travel.fill(''); await travel.press('Enter');
  await stage(page, 3);
  await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
  const decision = page.getByRole('dialog', { name: '入力途中の値', exact: true });
  await expect(decision).toBeVisible();
  expect(await stamp(page)).toEqual({ hash: base.document.designHash, revision: base.document.revision });
  const pending = page.waitForEvent('download');
  await decision.getByRole('button', { name: '入力を取り消して続ける', exact: true }).click();
  const download = await pending;
  const pdf = await PDFDocument.load(await readFile((await download.path())!));
  expect(pdf.getSubject()).toContain(base.document.designHash);
  expect(pdf.getTitle()).toBe(`${base.document.designId} revision ${base.document.revision}`);
  expect(await stamp(page)).toEqual({ hash: base.document.designHash, revision: base.document.revision });
  await precision(page); await expect(travel).toHaveValue('20');
});

test('P3 a slider gesture is one undo/redo transaction and preserves physical records', async ({ page }) => {
  await ready(page); await physical(page);
  await page.getByLabel('使った材料', { exact: true }).fill('自動試験の保存確認。実物での確認は未実施。');
  await page.getByRole('button', { name: 'この設計版に記録を追加', exact: true }).click();
  const original = await portable(page);
  await precision(page);
  const slider = page.getByLabel('動く距離をスライダーで調整', { exact: true });
  await slider.scrollIntoViewIfNeeded();
  const box = (await slider.boundingBox())!;
  const point = (value: number) => ({ x: box.x + 8 + (value - 2) / 68 * (box.width - 16), y: box.y + box.height / 2 });
  const start = point(20), end = point(28), base = await stamp(page);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 16 });
  expect(await stamp(page)).toEqual(base);
  await page.mouse.up();
  await expect.poll(() => stamp(page)).toMatchObject({ revision: base.revision + 1 });
  const moved = await stamp(page);
  expect(moved.hash).not.toBe(base.hash);
  await undo(page).click();
  expect(await stamp(page)).toEqual({ hash: base.hash, revision: base.revision + 2 });
  await expect(redo(page)).toBeEnabled();
  await redo(page).click();
  expect(await stamp(page)).toEqual({ hash: moved.hash, revision: base.revision + 3 });
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('18');
  await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  await expect(redo(page)).toBeDisabled();
  const beforeCancel = await stamp(page);
  await slider.scrollIntoViewIfNeeded();
  const nextBox = (await slider.boundingBox())!;
  const sx = nextBox.x + 8 + 16 / 68 * (nextBox.width - 16), sy = nextBox.y + nextBox.height / 2;
  await page.mouse.move(sx, sy); await page.mouse.down();
  await page.mouse.move(sx + 25, sy, { steps: 8 });
  await slider.dispatchEvent('pointercancel', { pointerId: 1, button: 0, bubbles: true });
  await page.mouse.up();
  expect(await stamp(page)).toEqual(beforeCancel);
  expect((await portable(page)).records).toEqual(original.records);
});

test('P3 selection drag, cancellation and one held arrow key have atomic history', async ({ page }) => {
  await ready(page); await stage(page, 1);
  await page.getByRole('button', { name: '動かす部分を選び直す', exact: true }).click();
  const svg = page.locator('#workbench .artwork-svg');
  const selection = svg.locator('[data-selection="move"]');
  await selection.scrollIntoViewIfNeeded();
  const initialX = await selection.getAttribute('x'), base = await stamp(page);
  const move = async () => {
    const box = (await selection.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 10, box.y + box.height / 2 + 5, { steps: 16 });
  };
  await move();
  expect(await stamp(page)).toEqual(base);
  await expect(selection).not.toHaveAttribute('x', initialX!);
  await svg.dispatchEvent('pointercancel', { pointerId: 1, button: 0, bubbles: true });
  await page.mouse.up();
  expect(await stamp(page)).toEqual(base);
  await expect(selection).toHaveAttribute('x', initialX!);
  await move(); await page.mouse.up();
  await expect.poll(() => stamp(page)).toMatchObject({ revision: base.revision + 1 });
  const moved = await stamp(page);
  await undo(page).click();
  expect(await stamp(page)).toEqual({ hash: base.hash, revision: base.revision + 2 });
  await redo(page).click();
  expect(await stamp(page)).toEqual({ hash: moved.hash, revision: base.revision + 3 });
  await svg.focus();
  const beforeKey = await stamp(page);
  await page.keyboard.down('ArrowRight'); await page.keyboard.down('ArrowRight'); await page.keyboard.down('ArrowRight');
  expect(await stamp(page)).toEqual(beforeKey);
  await page.keyboard.up('ArrowRight');
  await expect.poll(() => stamp(page)).toMatchObject({ revision: beforeKey.revision + 1 });
  await undo(page).click();
  expect(await stamp(page)).toEqual({ hash: beforeKey.hash, revision: beforeKey.revision + 2 });
});

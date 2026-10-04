import { expect, type Page } from '@playwright/test';

/** Navigate through the real stage controls; helpers never mutate application state. */
export async function closeDialog(page: Page) {
  if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape');
}

export async function stage(page: Page, number: 1 | 2 | 3) {
  await closeDialog(page);
  await page.locator('.workflow').getByRole('button', { name: new RegExp(`${['絵を選ぶ', '動きをつける', '印刷して作る'][number - 1]}$`) }).click();
}

export async function precision(page: Page) {
  await stage(page, 2);
  const details = page.locator('.numeric-details');
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.getByText('寸法・材料の詳細', { exact: true }).click();
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toBeVisible();
}

export async function openSave(page: Page) {
  await closeDialog(page);
  await page.getByRole('button', { name: '保存・再開', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

export async function saveProject(page: Page) {
  await openSave(page);
  await page.getByRole('button', { name: 'このブラウザに保存', exact: true }).click();
  await closeDialog(page);
  return page.evaluate(() => JSON.parse(localStorage.getItem('ugoku-kami.project.v1')!));
}

export async function ai(page: Page) {
  await stage(page, 2);
  await page.getByRole('button', { name: 'Gemini', exact: true }).click();
}

export async function manual(page: Page) {
  await stage(page, 2);
  await page.getByRole('button', { name: '手動支援', exact: true }).click();
}

export async function physical(page: Page) {
  await stage(page, 3);
  const details = page.locator('.physical-section');
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator('summary').click();
}

export async function selectionNumbers(page: Page) {
  await stage(page, 1);
  if (!(await page.locator('.selection-numeric').count())) await page.getByRole('button', { name: '動かす部分を選び直す', exact: true }).click();
  const details = page.locator('.selection-numeric');
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator('summary').click();
}

export const pdfButton = (page: Page) => page.getByRole('button', { name: 'PDFをダウンロード', exact: true, includeHidden: true });

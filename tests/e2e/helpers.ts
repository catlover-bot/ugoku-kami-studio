import { expect, type Page } from '@playwright/test';

/** Navigate through the real stage controls; helpers never mutate application state. */
export async function closeDialog(page: Page) {
  if (await page.getByRole('dialog').count()) {
    for (const dialog of await page.getByRole('dialog').all()) if (await dialog.isVisible()) { await page.keyboard.press('Escape'); break; }
  }
}

/** Goal005 starts on Home. Tests deliberately enter the existing sample editor. */
export async function startSample(page: Page) {
  if (!(await page.locator('.workflow').isVisible())) await page.locator('.home-library').getByRole('button', { name: 'サンプルで試す', exact: true }).click();
  await expect(page.locator('.workflow')).toBeVisible();
  await expect(page.locator('.artwork-stage .artwork-svg > image').first()).toHaveAttribute('href', /^data:image\/png/);
}

/** Read the real IndexedDB payload, without invoking repository or React methods. */
export async function savedWorkspace(page: Page, workspaceId?: string) {
  const id = workspaceId ?? await page.locator('main').getAttribute('data-workspace-id');
  if (!id) throw new Error('保存対象のworkspace IDがありません');
  return page.evaluate(({ id }) => new Promise<{ metadata: Record<string, unknown> | null; project: ReturnType<typeof JSON.parse> | null; draft: Record<string, unknown> | null }>((resolve, reject) => {
    const opening = indexedDB.open('ugoku-kami.workspaces.v1');
    opening.onerror = () => reject(opening.error);
    opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('作品の保存先がまだ作られていません')); };
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction(['entries', 'projects', 'drafts'], 'readonly');
      const entry = tx.objectStore('entries').get(id), project = tx.objectStore('projects').get(id), draft = tx.objectStore('drafts').get(id);
      tx.oncomplete = () => { db.close(); try { resolve({ metadata: entry.result ?? null, project: typeof project.result === 'string' ? JSON.parse(project.result) : null, draft: draft.result ?? null }); } catch (error) { reject(error); } };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { id });
}

export async function savedProject(page: Page) {
  const result = await savedWorkspace(page);
  if (!result.project) throw new Error('IndexedDBに保存された作品本文がありません');
  return result.project;
}

export async function failIndexedDbWrites(page: Page) {
  await page.evaluate(() => { IDBObjectStore.prototype.put = () => { throw new DOMException('Test storage quota exhausted', 'QuotaExceededError'); }; });
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
  await expect(page.locator('main')).toHaveAttribute('data-save-status', 'saved', { timeout: 15000 });
  await closeDialog(page);
  const result = await savedProject(page);
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', result.document.designHash);
  await expect(page.locator('main')).toHaveAttribute('data-design-revision', String(result.document.revision));
  return result;
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

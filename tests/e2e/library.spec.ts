import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { applyArtworkRepair, createDesign, SAMPLE_INPUT } from '@ugoku/core';
import { physicalRecordSchema, type Project } from '../../apps/web/src/project';
import type { WorkspaceDraft } from '../../apps/web/src/projectRepository';
import { physical, precision, stage } from './helpers';

const DATABASE = 'ugoku-kami.workspaces.v1';
const LEGACY_KEY = 'ugoku-kami.project.v1';
type SavedWorkspace = {
  metadata: { id: string; name: string; generation: number; designId: string; revision: number; designHash: string };
  project: Project;
  draft: WorkspaceDraft;
};

/** The application creates every work; direct IndexedDB writes below are fault injection only. */
async function readWorkspace(page: Page, id?: string): Promise<SavedWorkspace | null> {
  const key = id ?? await page.locator('main').getAttribute('data-workspace-id');
  if (!key) return null;
  return page.evaluate(async ({ database, key }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(database); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<SavedWorkspace | null>((resolve, reject) => {
        const tx = db.transaction(['entries', 'projects', 'drafts'], 'readonly');
        const meta = tx.objectStore('entries').get(key), project = tx.objectStore('projects').get(key), draft = tx.objectStore('drafts').get(key);
        tx.oncomplete = () => resolve(project.result === undefined ? null : { metadata: meta.result, project: JSON.parse(project.result as string) as Project, draft: draft.result } as SavedWorkspace);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }, { database: DATABASE, key });
}
async function stamp(page: Page) {
  return page.locator('main').evaluate(element => ({ id: element.dataset.designId!, hash: element.dataset.designHash!, revision: Number(element.dataset.designRevision) }));
}
async function saved(page: Page) {
  await expect(page.locator('main')).toHaveAttribute('data-save-status', 'saved');
  await expect(page.locator('main')).toHaveAttribute('data-workspace-id', /.+/);
  const value = await readWorkspace(page); expect(value).not.toBeNull(); return value!;
}
async function home(page: Page) {
  await page.getByRole('button', { name: '作品一覧', exact: true }).click();
  await expect(page.getByRole('heading', { name: '絵から、紙工作をつくろう。', exact: true })).toBeVisible();
}
function entryById(page: Page, id: string) { return page.locator(`.library-entry[data-project-id="${id}"]`); }
async function more(article: Locator) {
  const details = article.locator('.library-more');
  if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.getByText('作品の操作', { exact: true }).click();
}
async function sample(page: Page) {
  await page.getByRole('button', { name: 'サンプルで試す', exact: true }).click();
  await expect(page.locator('.home-library')).toHaveCount(0);
  await expect(page.locator('.artwork-stage .artwork-svg > image').first()).toHaveAttribute('href', /^data:image\/png/);
}
async function setTravel(page: Page, value: string) {
  await precision(page);
  const input = page.getByLabel('動く距離（mm）', { exact: true });
  await input.fill(value); await input.press('Enter');
}
async function portableFixture(id: string, version: 1 | 2, withRecord = false) {
  const png = await sharp({ create: { width: 800, height: 550, channels: 3, background: version === 1 ? '#a9cfb4' : '#e2bd88' } }).png().toBuffer();
  const imageDataUrl = `data:image/png;base64,${png.toString('base64')}`;
  let document = createDesign({ ...SAMPLE_INPUT, title: id, image: { id: createHash('sha256').update(png).digest('hex'), widthPx: 800, heightPx: 550, mimeType: 'image/png' } }, { designId: `library-${createHash('sha256').update(id).digest('hex').slice(0, 20)}` });
  if (version === 2) document = applyArtworkRepair(document, { mode: 'solid', color: '#e2bd88' });
  const records = withRecord ? [physicalRecordSchema.parse({ id: 'synthetic-record', designId: document.designId, designHash: document.designHash, revision: document.revision, pattern: `${id}.pdf`, material: '自動試験用の架空記録。実物確認は行っていません。', printScale: '', measuredLine: '', modifications: '', movement: '', photos: [] })] : [];
  const project: Project = { document, imageDataUrl, records };
  return { project, png, text: JSON.stringify({ format: 'ugoku-kami-project', version, ...project }) };
}
async function importText(page: Page, text: string, name = 'fixture.ugoku.json') {
  await page.getByLabel('プロジェクトファイルを選ぶ', { exact: true }).setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
  const payload = JSON.parse(text) as { project?: Project; document?: Project['document'] };
  await expect(page.locator('main')).toHaveAttribute('data-design-id', (payload.project?.document ?? payload.document)!.designId);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  const directory = resolve('artifacts/goal005/library-ui', info.project.name); await mkdir(directory, { recursive: true });
  if (await page.locator('.storage-error').isVisible()) await page.locator('.storage-error').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(directory, `${name}.png`), scale: 'css' });
}

// No Gemini requests or mocked successful storage callbacks are used in these tests.
test('P4 Home keeps samples ephemeral, supports own artwork and three works, and duplicates/deletes only the named work', async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '前の作品を続ける', exact: true })).toBeDisabled();
  await sample(page); const untouched = await stamp(page);
  await stage(page, 2); await page.getByLabel('表示倍率', { exact: true }).selectOption('1.5');
  // Allow one complete 600 ms debounce interval: merely exploring a sample must not create an entry.
  await page.waitForTimeout(850); await home(page);
  await expect(page.locator('.library-entry')).toHaveCount(0);
  await page.getByRole('button', { name: '前の作品を続ける', exact: true }).click();
  expect(await stamp(page)).toEqual(untouched); await home(page);

  const firstFile = await portableFixture('持ち込みの絵', 1);
  const choosing = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '自分の絵ではじめる', exact: true }).click();
  await (await choosing).setFiles({ name: '自分の絵.png', mimeType: 'image/png', buffer: firstFile.png });
  const own = await saved(page); expect(own.project.imageDataUrl).toMatch(/^data:image\/png/);
  const v1 = await portableFixture('旧形式の作品', 1, true), v2 = await portableFixture('背景補正の作品', 2);
  await home(page); await importText(page, v1.text); const imported1 = await saved(page);
  expect(imported1.project.document).toEqual(v1.project.document);
  await home(page); await importText(page, v2.text); const imported2 = await saved(page);
  expect(imported2.project.document).toEqual(v2.project.document);
  await home(page); await expect(page.locator('.library-entry')).toHaveCount(3);
  for (const work of [own, imported1, imported2]) {
    await entryById(page, work.metadata.id).getByRole('button', { name: '続きから開く', exact: true }).click();
    // A click starts asynchronous IndexedDB loading and image validation.
    // Wait for that work to finish; still require the exact requested identity.
    await expect.poll(() => stamp(page)).toEqual({ id: work.project.document.designId, hash: work.project.document.designHash, revision: work.project.document.revision });
    await home(page);
  }
  const original = entryById(page, imported1.metadata.id); await more(original);
  await original.getByRole('button', { name: '名前を変更', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '作品の名前を変更', exact: true });
  await rename.getByLabel('作品名', { exact: true }).fill('残しておく原本');
  await rename.getByRole('button', { name: '名前を保存する', exact: true }).click();
  await expect(original.getByRole('heading', { name: '残しておく原本', exact: true })).toBeVisible();
  await more(original); await original.getByRole('button', { name: '複製する', exact: true }).click();
  await expect(page.locator('.library-entry')).toHaveCount(4);
  const copy = page.locator('.library-entry').filter({ has: page.getByRole('heading', { name: '残しておく原本 の複製', exact: true }) });
  const copyId = (await copy.getAttribute('data-project-id'))!;
  const copied = (await readWorkspace(page, copyId))!;
  expect(copied.project.document.designId).not.toBe(v1.project.document.designId); expect(copied.project.document.revision).toBe(1);
  expect(copied.project.records).toEqual([]); expect(copied.draft.recordDraft).toBeUndefined();
  expect((await readWorkspace(page, imported1.metadata.id))!.project.records).toEqual(v1.project.records);
  await more(copy); await copy.getByRole('button', { name: '削除する', exact: true }).click();
  const remove = page.getByRole('dialog', { name: '作品の削除', exact: true });
  await expect(remove.getByRole('heading')).toContainText('残しておく原本 の複製');
  await remove.getByRole('button', { name: 'キャンセル', exact: true }).click(); await expect(copy).toBeVisible();
  await copy.getByRole('button', { name: '削除する', exact: true }).click(); await remove.getByRole('button', { name: '削除する', exact: true }).click();
  await expect(page.locator('.library-entry')).toHaveCount(3); await expect(original).toBeVisible();
  await screenshot(page, info, 'three-works');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('P5 reload restores stage, view, zoom, empty numeric input, cleared selection and physical draft without changing the committed design', async ({ page }, info) => {
  await page.goto('/'); await sample(page); await setTravel(page, '18.5'); await saved(page);
  await physical(page); await page.getByLabel('使った材料', { exact: true }).fill('入力途中の復元試験。実物は未確認。');
  await stage(page, 1); await page.getByRole('button', { name: '動かす部分を選び直す', exact: true }).click();
  await page.getByRole('button', { name: '選択を解除', exact: true }).click();
  await precision(page); const travel = page.getByLabel('動く距離（mm）', { exact: true });
  await travel.fill(''); await travel.press('Enter');
  await page.getByRole('button', { name: '裏のしくみ', exact: true }).click(); await page.getByLabel('表示倍率', { exact: true }).selectOption('2');
  const committed = await stamp(page);
  await expect.poll(async () => {
    const value = await readWorkspace(page); return value && { stage: value.draft.stage, view: value.draft.view, zoom: value.draft.zoom, selection: value.draft.selection, numeric: value.draft.numericDrafts?.travelMm, material: value.draft.recordDraft?.material };
  }).toEqual({ stage: 2, view: 'back', zoom: 2, selection: null, numeric: '', material: '入力途中の復元試験。実物は未確認。' });
  await saved(page); await page.reload();
  await expect(page.locator('.home-library')).toHaveCount(0);
  await expect(page.locator('.workflow [aria-current="step"]')).toContainText('動きをつける');
  expect(await stamp(page)).toEqual(committed);
  await expect(page.getByRole('button', { name: '裏のしくみ', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('表示倍率', { exact: true })).toHaveValue('2');
  await page.locator('.numeric-details').getByText('寸法・材料の詳細', { exact: true }).click(); await expect(travel).toHaveValue('');
  const restored = (await readWorkspace(page))!;
  expect(restored.project.document.input.travelMm).toBe(18.5); expect(restored.project.document.input.selection).not.toBeNull();
  expect(restored.project.records).toEqual([]); expect(restored.draft.recordDraft?.designHash).toBe(committed.hash);
  await screenshot(page, info, 'restored-unfinished-input');
  await physical(page); await expect(page.getByLabel('使った材料', { exact: true })).toHaveValue('入力途中の復元試験。実物は未確認。');
  await expect(page.locator('.saved-record')).toHaveCount(0);
  await stage(page, 1); await expect(page.getByRole('button', { name: /動きをつけるへ/ })).toBeDisabled();
});

test('P5 legacy migration is idempotent and a corrupt work can be recovered or removed while the other work survives', async ({ page }, info) => {
  const legacy = await portableFixture('移行する原本', 1, true);
  await page.addInitScript(({ key, text }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, text); }, { key: LEGACY_KEY, text: legacy.text });
  await page.goto('/'); await expect(page.locator('.library-entry')).toHaveCount(1);
  await page.getByRole('button', { name: '前の作品を続ける', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-design-id', legacy.project.document.designId); const migrated = await saved(page);
  await page.reload(); await expect(page.locator('main')).toHaveAttribute('data-workspace-id', migrated.metadata.id);
  await home(page); await expect(page.locator('.library-entry')).toHaveCount(1);
  expect(await page.evaluate(key => localStorage.getItem(key), LEGACY_KEY)).toBe(legacy.text);
  const damagedFixture = await portableFixture('復元する作品', 2); await importText(page, damagedFixture.text); const damaged = await saved(page);
  await page.evaluate(async ({ database, id, generation }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(database); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('entries', 'readwrite'); tx.objectStore('entries').put({ name: '保存情報が壊れた作品', generation }, id); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); } finally { db.close(); }
  }, { database: DATABASE, id: damaged.metadata.id, generation: damaged.metadata.generation });
  await home(page); const corrupt = entryById(page, damaged.metadata.id); await expect(corrupt).toHaveAttribute('data-status', 'corrupt');
  await corrupt.getByRole('button', { name: '復元できる内容を確認', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', damagedFixture.project.document.designHash);
  const recovered = await saved(page); expect(recovered.metadata.id).not.toBe(damaged.metadata.id);
  await home(page); await expect(page.locator('.library-entry')).toHaveCount(3);
  await more(corrupt); await corrupt.getByRole('button', { name: '削除する', exact: true }).click();
  await page.getByRole('dialog', { name: '作品の削除', exact: true }).getByRole('button', { name: '削除する', exact: true }).click();
  await expect(page.locator('.library-entry')).toHaveCount(2);
  expect((await readWorkspace(page, migrated.metadata.id))!.project).toMatchObject(legacy.project);
  await screenshot(page, info, 'migration-and-isolated-recovery');
});

test('P5 two actual tabs reject an old generation and preserve that tab as a separate recovery snapshot', async ({ page, context }, info) => {
  await page.goto('/'); await sample(page); await setTravel(page, '19'); const initial = await saved(page);
  const other = await context.newPage(); await other.goto('/');
  await entryById(other, initial.metadata.id).getByRole('button', { name: '続きから開く', exact: true }).click(); await saved(other);
  await setTravel(page, '18'); await expect.poll(async () => (await readWorkspace(page, initial.metadata.id))?.project.document.input.travelMm).toBe(18); await saved(page);
  await setTravel(other, '17'); await expect(other.locator('main')).toHaveAttribute('data-save-status', 'conflict');
  await expect(other.locator('.storage-error')).toContainText('別のタブ');
  await expect(other.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('17');
  const competing = await stamp(other); expect(competing.id).toBe(initial.project.document.designId);
  expect((await readWorkspace(other, initial.metadata.id))!.project.document.input.travelMm).toBe(18);
  await screenshot(other, info, 'two-tab-conflict');
  await other.locator('.storage-error').getByRole('button', { name: '復旧用に別名保存', exact: true }).click();
  const recovered = await saved(other); expect(recovered.metadata.id).not.toBe(initial.metadata.id);
  expect(recovered.project.document.designId).toBe(initial.project.document.designId); expect(recovered.project.document.input.travelMm).toBe(17);
  expect(recovered.project.document.designHash).toBe(competing.hash); expect((await readWorkspace(other, initial.metadata.id))!.project.document.input.travelMm).toBe(18);
  await other.close();
});

test('P5 native quota refusal keeps the previous save and current design/drafts, with a portable recovery export', async ({ page }, info) => {
  await page.goto('/'); await sample(page); await setTravel(page, '19'); const previous = await saved(page);
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('Synthetic quota refusal for browser acceptance', 'QuotaExceededError'); }; });
  await setTravel(page, '18');
  const travel = page.getByLabel('動く距離（mm）', { exact: true }); await travel.fill(''); await travel.press('Enter');
  await physical(page); await page.getByLabel('使った材料', { exact: true }).fill('保存失敗中の下書き。実物確認なし。');
  await expect(page.locator('main')).toHaveAttribute('data-save-status', 'failed'); await expect(page.locator('.storage-error')).toContainText('保存容量');
  expect(await readWorkspace(page, previous.metadata.id)).toEqual(previous);
  await expect(page.getByLabel('使った材料', { exact: true })).toHaveValue('保存失敗中の下書き。実物確認なし。');
  const downloading = page.waitForEvent('download'); await page.locator('.storage-error').getByRole('button', { name: '下書きも含めて書き出す', exact: true }).click();
  const download = await downloading, text = await readFile((await download.path())!, 'utf8');
  const backup = JSON.parse(text) as { format: string; project: Project; draft: WorkspaceDraft };
  expect(backup.format).toBe('ugoku-kami-recovery'); expect(backup.project.document.input.travelMm).toBe(18); expect(backup.project.records).toEqual([]);
  expect(backup.draft.numericDrafts?.travelMm).toBe(''); expect(backup.draft.recordDraft?.material).toBe('保存失敗中の下書き。実物確認なし。');
  await screenshot(page, info, 'quota-failure-with-backup');
  // A new page has the real native methods again; import the downloaded bytes through the product UI.
  const reopened = await page.context().newPage(); await reopened.goto('/'); await importText(reopened, text, 'quota-recovery.json'); const recovered = await saved(reopened);
  expect(recovered.metadata.id).not.toBe(previous.metadata.id); expect(recovered.project.document.input.travelMm).toBe(18);
  expect(recovered.draft.numericDrafts?.travelMm).toBe(''); expect(recovered.draft.recordDraft?.material).toBe(backup.draft.recordDraft?.material);
  expect((await readWorkspace(reopened, previous.metadata.id))!.project.document.input.travelMm).toBe(19);
  await reopened.close();
});

test('P5 denying IndexedDB leaves a usable editor and an explicit file backup path', async ({ page }, info) => {
  await page.addInitScript(() => { IDBFactory.prototype.open = function () { throw new DOMException('Synthetic permission denial for browser acceptance', 'SecurityError'); }; });
  await page.goto('/'); await expect(page.locator('.library-error')).toContainText('保存が許可');
  await sample(page); await setTravel(page, '18');
  await expect(page.locator('main')).toHaveAttribute('data-save-status', 'failed');
  await expect(page.locator('.storage-error')).toContainText('保存が許可');
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('18');
  const downloading = page.waitForEvent('download'); await page.locator('.storage-error').getByRole('button', { name: '下書きも含めて書き出す', exact: true }).click();
  const download = await downloading; const backup = JSON.parse(await readFile((await download.path())!, 'utf8')) as { project: Project };
  expect(backup.project.document.input.travelMm).toBe(18); expect(backup.project.imageDataUrl).toMatch(/^data:image\/png/);
  await screenshot(page, info, 'storage-denied-editor');
});

test('P5 cancelling deletion retains a failed active draft; confirming its exact name deletes only that work without requiring another save', async ({ page }, info) => {
  await page.goto('/');
  const keepFile = await portableFixture('消さずに残す別作品', 1), removeFile = await portableFixture('削除する保存失敗作品', 2);
  await importText(page, keepFile.text); const keep = await saved(page);
  await home(page); await importText(page, removeFile.text); const remove = await saved(page);
  await page.evaluate(() => {
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'projects' || this.name === 'drafts') throw new DOMException('Synthetic data-store quota refusal; tombstones remain writable', 'QuotaExceededError');
      return nativePut.apply(this, args);
    };
  });
  await setTravel(page, '18'); await physical(page);
  await page.getByLabel('使った材料', { exact: true }).fill('削除を取り消したら保持する下書き。実物確認なし。');
  await expect(page.locator('main')).toHaveAttribute('data-save-status', 'failed');
  const unsaved = await stamp(page); await home(page);
  const target = entryById(page, remove.metadata.id); await more(target);
  await target.getByRole('button', { name: '削除する', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '作品の削除', exact: true });
  await expect(dialog.getByRole('heading')).toContainText('削除する保存失敗作品');
  await expect(dialog).toContainText('未保存');
  await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(page.locator('.library-entry')).toHaveCount(2);
  await page.getByRole('button', { name: '前の作品を続ける', exact: true }).click();
  expect(await stamp(page)).toEqual(unsaved);
  await expect(page.getByLabel('使った材料', { exact: true })).toHaveValue('削除を取り消したら保持する下書き。実物確認なし。');
  expect((await readWorkspace(page, remove.metadata.id))!.project).toEqual(remove.project);
  await home(page); await more(target); await target.getByRole('button', { name: '削除する', exact: true }).click();
  await dialog.getByRole('button', { name: '削除する', exact: true }).click();
  await expect(dialog).not.toBeVisible(); await expect(page.locator('.library-entry')).toHaveCount(1);
  await expect(entryById(page, keep.metadata.id)).toBeVisible(); await expect(target).toHaveCount(0);
  // A previous debounce must not resurrect the explicitly deleted work.
  await page.waitForTimeout(850);
  expect(await readWorkspace(page, remove.metadata.id)).toBeNull();
  expect((await readWorkspace(page, keep.metadata.id))!.project).toEqual(keep.project);
  await expect(page.locator('.library-entry')).toHaveCount(1);
  await screenshot(page, info, 'delete-failed-active-keeps-other-work');
});

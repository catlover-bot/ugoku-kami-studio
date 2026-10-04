import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { parseDesignDocument, getAssemblySteps, getFabricationChecks } from '@ugoku/core';
import { distanceIdeas, startSample, ai, manual, pdfButton, physical, precision, saveProject, selectionNumbers, stage } from './helpers';

const root = 'artifacts/goal005/regression';
async function saved(page: Page) {
  return saveProject(page);
}
async function ask(page: Page, text: string) {
  await manual(page);
  await page.getByLabel('どう動かしたいですか？', { exact: true }).fill(text);
  await page.getByRole('button', { name: '寸法から案をつくる', exact: true }).click();
}
async function pdf(page: Page, path: string) {
  await stage(page, 3);
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
  const download = await waiting; await download.saveAs(path);
  return PDFDocument.load(await readFile(path));
}
async function evidence(page: Page, stem: string) {
  const project = await saved(page);
  await writeFile(`${stem}.ugoku.json`, JSON.stringify(project, null, 2));
  await writeFile(`${stem}.design.json`, JSON.stringify(project.document, null, 2));
  await writeFile(`${stem}.checks.json`, JSON.stringify([...project.document.checks, ...getFabricationChecks(project.document)], null, 2));
  await writeFile(`${stem}.assembly.json`, JSON.stringify(getAssemblySteps(project.document), null, 2));
  return parseDesignDocument(project.document);
}
test.beforeEach(async ({ page }, info) => {
  await mkdir(`${root}/${info.project.name}`, { recursive: true });
  await page.goto('/'); await startSample(page);
  await stage(page, 2);
  await expect(pdfButton(page)).toBeEnabled();
});

test('S1/S4 sample: intuitive distance, protected proposal, rejection and a current prototype kit', async ({ page }, info) => {
  const stem = `${root}/${info.project.name}/sample`;
  // Goal005 promotes distance to the primary settings; precision controls stay closed.
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toBeVisible();
  await expect(page.locator('.numeric-details')).not.toHaveAttribute('open');
  await page.screenshot({ path: `${stem}-start.png`, fullPage: false });
  const before = await saved(page);
  await page.getByRole('button', { name: '動かす', exact: true }).click();
  await page.getByRole('button', { name: '動きを停止', exact: true }).click();
  await page.getByRole('button', { name: 'おわり', exact: true }).click();
  const workbench = page.locator('#workbench');
  await expect(workbench.locator('[data-part="B1-slot"]')).toBeVisible();
  await expect(workbench.locator('[data-part="T1"]')).toBeVisible();
  await distanceIdeas(page);
  await page.getByRole('button', { name: 'もう少し大きく', exact: true }).click();
  await expect(page.locator('.intent-panel').getByRole('button', { name: 'この案にする', exact: true })).toBeVisible();
  await expect(page.locator('.intent-panel .change-table')).toContainText('20mm');
  await expect(page.locator('.intent-panel .change-table')).toContainText('25mm');
  await page.locator('.intent-panel').getByRole('button', { name: 'この案を使わない', exact: true }).click();
  expect((await saved(page)).document).toEqual(before.document);
  await distanceIdeas(page);
  await page.getByRole('button', { name: 'もう少し大きく', exact: true }).click();
  await page.locator('.intent-panel').screenshot({ path: `${stem}-candidate.png` });
  await page.locator('.intent-panel').getByRole('button', { name: 'この案にする', exact: true }).click();
  const after = await evidence(page, stem);
  expect(after.input.travelMm).toBe(25);
  expect(after.artwork.placement).toEqual(before.document.artwork.placement);
  expect(after.input.locks).toEqual(expect.arrayContaining(['widthMm', 'heightMm', 'maxSheets']));
  expect(after.layout.sheets).toBeLessThanOrEqual(before.document.layout.sheets);
  await page.getByRole('button', { name: '原画像', exact: true }).click();
  await expect(workbench.getByRole('img', { name: /元の絵/ })).toBeVisible();
  await page.getByRole('button', { name: '正面', exact: true }).click();
  await stage(page, 3);
  await page.locator('#making').screenshot({ path: `${stem}-kit.png` });
  const kit = await pdf(page, `${stem}.pdf`);
  expect(kit.getSubject()).toContain(after.designHash);
  expect(kit.getPageCount()).toBe(after.layout.sheets + 4);
  expect(after.physicalValidation).toBe('unverified');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('S2/S3/S6/S8 own portrait art: upward motion, original scale, instructions and per-revision records', async ({ page }, info) => {
  const stem = `${root}/${info.project.name}/own-up`;
  // Developer-created held-out illustration, never bundled as a product sample or called user evidence.
  const source = Buffer.from('<svg width="640" height="900"><rect width="640" height="900" fill="#fff"/><path d="M270 300L310 380L350 300" fill="#835c37"/><rect x="250" y="130" width="140" height="170" rx="25" fill="#e6a64b"/><path d="M275 170L365 260M365 170L275 260" stroke="#884e35" stroke-width="12"/><path d="M80 770H550" stroke="#48645a" stroke-width="18"/><circle cx="100" cy="680" r="25" fill="#8aaf87"/></svg>');
  const bytes = await sharp(source).png().toBuffer();
  await writeFile(`${stem}-developer-source.png`, bytes);
  await stage(page, 1);
  await page.getByLabel('画像を選ぶ', { exact: true }).setInputFiles({ name: '開発者テスト・上がるランタン.png', mimeType: 'image/png', buffer: bytes });
  await selectionNumbers(page);
  await expect(page.getByLabel('選択のX', { exact: true })).toBeVisible();
  for (const [name, value] of [['選択のX','250'],['選択のY','130'],['選択の幅','140'],['選択の高さ','170']]) { await page.getByLabel(name!, { exact: true }).fill(value!); await page.getByLabel(name!, { exact: true }).press('Enter'); }
  const selection = page.locator('#workbench').getByRole('img', { name: /動かす領域/ });
  await selection.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('選択のX', { exact: true })).toHaveValue('251');
  await precision(page);
  await page.getByLabel('作品の幅（mm）', { exact: true }).fill('120'); await page.getByLabel('作品の幅（mm）', { exact: true }).press('Enter');
  await page.getByLabel('作品の高さ（mm）', { exact: true }).fill('160'); await page.getByLabel('作品の高さ（mm）', { exact: true }).press('Enter');
  await page.getByRole('button', { name: '上へ', exact: true }).click();
  // Moving to stage 2 above confirms the same selected rectangle and ends editing.
  await ask(page, '選んだ部分を上へ出す。距離を18mm。絵の大きさを保って、厚紙は2枚まで');
  await page.locator('.intent-panel').getByRole('button', { name: 'この案にする', exact: true }).click();
  const initial = await saved(page);
  await ask(page, 'もう少し大きく動かしたい。紙は増やさない');
  await page.locator('.intent-panel').getByRole('button', { name: 'この案にする', exact: true }).click();
  const current = await evidence(page, stem);
  expect(current.input.direction).toBe('up');
  expect(current.input.travelMm).toBeGreaterThan(18);
  expect(current.artwork.placement).toEqual(initial.document.artwork.placement);
  expect(current.layout.sheets).toBeLessThanOrEqual(initial.document.layout.sheets);
  expect(getFabricationChecks(current).filter(c => c.status === 'fail')).toEqual([]);
  await page.getByRole('button', { name: 'おわり', exact: true }).click();
  const preview = page.locator('#workbench').getByRole('img', { name: '正面の動きのプレビュー', exact: true });
  expect(await preview.locator(':scope > g[transform]').first().getAttribute('transform')).toBe(`translate(0 ${-current.input.travelMm})`);
  await page.locator('#workbench').screenshot({ path: `${stem}-front.png` });
  await page.getByRole('button', { name: '裏のしくみ', exact: true }).click();
  await page.locator('#workbench').screenshot({ path: `${stem}-back.png` });
  await stage(page, 3);
  await page.getByText('組み立て手順の一覧', { exact: true }).click();
  await expect(page.locator('.assembly-illustration')).toHaveCount(6);
  await expect(page.locator('.assembly-steps')).toContainText(`${current.input.travelMm} mm`);
  await page.locator('.assembly-details').screenshot({ path: `${stem}-instructions.png` });
  const exported = await pdf(page, `${stem}.pdf`);
  expect(exported.getSubject()).toContain(current.designHash);
  await physical(page);
  await page.getByLabel('移動の両端と途中', { exact: true }).fill('自動テスト記録。実物は未実施');
  await page.getByLabel('ガイドがタブを保持するか', { exact: true }).fill('未実施：記録保存だけを確認');
  await page.getByLabel('接着面と表裏の確認', { exact: true }).fill('未実施');
  await page.getByLabel('組み立て時の修正', { exact: true }).fill('実物を組み立てていない');
  await page.getByRole('button', { name: 'この設計版に記録を追加', exact: true }).click();
  const stored = await saved(page);
  expect(stored.records).toHaveLength(1);
  expect(stored.records[0].designHash).toBe(current.designHash);
  expect(stored.records[0].endpoints).toContain('未実施');
  expect(stored.records[0].photos).toEqual([]);
  expect(stored.document.physicalValidation).toBe('unverified');
  await page.reload();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', current.designHash);
  await expect(page.locator('main')).toHaveAttribute('data-design-revision', String(current.revision));
  await stage(page, 2);
  await expect(page.locator('#art-title')).toContainText('上がるランタン');
  const resumed = await evidence(page, `${stem}-resumed`);
  expect(resumed).toEqual(current);
  const secondPdf = await pdf(page, `${stem}-resumed.pdf`);
  expect(secondPdf.getSubject()).toBe(exported.getSubject());
});

test('S4 incompatible sheet budget is explained; explicit relaxation preserves art scale', async ({ page }) => {
  await precision(page);
  await page.getByLabel('作品の幅（mm）', { exact: true }).fill('190'); await page.getByLabel('作品の幅（mm）', { exact: true }).press('Enter');
  await page.getByLabel('作品の高さ（mm）', { exact: true }).fill('220'); await page.getByLabel('作品の高さ（mm）', { exact: true }).press('Enter');
  await page.getByLabel('紙の上限（枚）', { exact: true }).fill('1'); await page.getByLabel('紙の上限（枚）', { exact: true }).press('Enter');
  for (const name of ['作品の幅を固定','作品の高さを固定','紙の上限を固定']) await page.getByLabel(name, { exact: true }).check();
  const base = await saved(page);
  await ask(page, 'もう少し大きく動かす。絵の大きさは保って、紙は増やさない');
  await expect(page.locator('.manual-result')).toContainText('使用可能な紙は1枚');
  await expect(page.locator('.manual-result')).toContainText('すべての配置が不可能という意味ではありません');
  await expect(page.locator('.intent-panel').getByRole('button', { name: 'この案にする', exact: true })).toHaveCount(0);
  await expect(pdfButton(page)).toBeDisabled();
  expect((await saved(page)).document).toEqual(base.document);
  await page.getByRole('button', { name: '変更してよい条件を見直す', exact: true }).click();
  await page.getByLabel('紙の上限を固定', { exact: true }).uncheck();
  await page.getByLabel('紙の上限（枚）', { exact: true }).fill('2'); await page.getByLabel('紙の上限（枚）', { exact: true }).press('Enter');
  await ask(page, 'もう少し大きく動かす。絵の大きさは保って、厚紙は2枚まで');
  await page.locator('.intent-panel').getByRole('button', { name: 'この案にする', exact: true }).click();
  const after = await saved(page);
  expect(after.document.artwork.placement).toEqual(base.document.artwork.placement);
  expect(after.document.layout.sheets).toBe(2);
  await stage(page, 2);
  await expect(pdfButton(page)).toBeEnabled();
});

test('S6 export pending then edit discards stale PDF; S7 manual recovery stays available offline', async ({ page }) => {
  await precision(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/fonts/ZenKakuGothicNew-Regular.ttf', async route => { requested = true; await held; await route.continue(); });
  const downloads: string[] = []; page.on('download', d => downloads.push(d.suggestedFilename()));
  await stage(page, 3);
  await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await precision(page);
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('17'); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  release();
  await expect(page.getByRole('status').filter({ hasText: '古いPDFを破棄' })).toBeVisible();
  expect(downloads).toEqual([]);
  await ask(page, '回転させたい');
  await expect(page.locator('.manual-result')).toContainText('直線運動');
  await page.getByRole('button', { name: '直線運動の代案を選ぶ', exact: true }).click();
  await page.getByLabel('どう動かしたいですか？', { exact: true }).fill('動く距離を15mm。絵の大きさは保つ');
  await page.getByRole('button', { name: '寸法から案をつくる', exact: true }).click();
  await page.locator('.intent-panel').getByRole('button', { name: 'この案にする', exact: true }).click();
  expect((await saved(page)).document.input.travelMm).toBe(15);
  await ai(page);
  await expect(page.locator('.connection')).toHaveText('手動で編集中');
});

test('S8 physical draft keeps its measured revision, and design undo cannot delete recorded evidence', async ({ page }) => {
  const first = await saved(page);
  await physical(page);
  await page.getByLabel('使った材料', { exact: true }).fill('自動回帰テスト：この最初の版で記入開始。実物未実施');
  await precision(page);
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('18'); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  await physical(page);
  await page.getByRole('button', { name: 'この設計版に記録を追加', exact: true }).click();
  const changed = await saved(page);
  expect(changed.document.revision).toBeGreaterThan(first.document.revision);
  expect(changed.records[0].revision).toBe(first.document.revision);
  expect(changed.records[0].designHash).toBe(first.document.designHash);
  expect(changed.records[0].pattern).toBe(`${first.document.designId}-r${first.document.revision}.pdf`);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  const undone = await saved(page);
  expect(undone.document.input.travelMm).toBe(20);
  expect(undone.records).toEqual(changed.records);
  expect(undone.document.physicalValidation).toBe('unverified');
});

import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { startSample, savedProject, savedWorkspace, failIndexedDbWrites, ai, closeDialog, openSave, pdfButton, physical, precision, saveProject, selectionNumbers, stage } from './helpers';

const output = 'artifacts/goal005/workshop-regression';
test.beforeEach(async ({ page }) => {
  await page.goto('/'); await startSample(page);
  await expect(page.locator('.workflow')).toBeVisible();
  // Existing precision-edit regressions still exercise the same fields, now intentionally
  // behind progressive disclosure. Creator scenarios below use the primary controls.
  await precision(page);
});

test('サンプルの編集・正面/裏側・原寸PDFとSVG', async ({ page }, info) => {
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('20');
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('18'); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  await page.getByRole('button', { name: '裏のしくみ', exact: true }).click();
  await expect(page.getByRole('img', { name: /裏側.*仕組み/ })).toBeVisible();
  await page.getByRole('button', { name: '正面', exact: true }).click();
  const download = page.waitForEvent('download');
  await stage(page, 3);
  await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
  const result = await download;
  expect(result.suggestedFilename()).toMatch(/\.pdf$/);
  const file = await result.path();
  const pdf = await PDFDocument.load(await readFile(file!));
  expect(pdf.getPageCount()).toBe(5);
  await expect(page.getByText('普通紙 4ページ（別）', { exact: true })).toBeVisible();
  const first = pdf.getPages()[0]!;
  expect(first.getWidth()).toBeCloseTo(210 * 72 / 25.4, 4);
  expect(first.getHeight()).toBeCloseTo(297 * 72 / 25.4, 4);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/${info.project.name}-workshop.png`, fullPage: true, scale: 'css' });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${output}/${info.project.name}-viewport.png`, scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('自分の画像を検証して選択・設計・保存から復元する', async ({ page }, info) => {
  // A held-out asymmetric input unrelated to the turtle sample, including a non-square ratio.
  const raster = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#efdab8' } }).composite([{ input: Buffer.from('<svg width="640" height="480"><rect x="240" y="180" width="180" height="120" fill="#207a68"/><circle cx="310" cy="225" r="20" fill="#ef782f"/></svg>') }]).png().toBuffer();
  await stage(page, 1);
  await page.getByLabel('画像を選ぶ', { exact: true }).setInputFiles({ name: 'held-out-workshop.png', mimeType: 'image/png', buffer: raster });
  await expect(page.getByRole('status').filter({ hasText: /画像/ })).toBeVisible();
  await selectionNumbers(page);
  await page.getByLabel('選択のX', { exact: true }).fill('300'); await page.getByLabel('選択のX', { exact: true }).press('Enter');
  await page.getByLabel('選択のY', { exact: true }).fill('180'); await page.getByLabel('選択のY', { exact: true }).press('Enter');
  await page.getByLabel('選択の幅', { exact: true }).fill('180'); await page.getByLabel('選択の幅', { exact: true }).press('Enter');
  await precision(page);
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('12'); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  const pdfDownload = page.waitForEvent('download');
  await stage(page, 3);
  await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
  expect((await pdfDownload).suggestedFilename()).toMatch(/\.pdf$/);
  const beforeReload = await saveProject(page);
  await expect(page.locator('.status-message')).toContainText('保存しました');
  await page.reload();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', beforeReload.document.designHash);
  await expect(page.locator('main')).toHaveAttribute('data-design-revision', String(beforeReload.document.revision));
  await precision(page);
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('12');
  const saved = await savedProject(page);
  expect(saved.imageDataUrl).toMatch(/^data:image\/png;base64,/);
  expect(saved.document.input.image.widthPx).toBe(640);
  expect(saved.document.input.selection).toEqual({ x: 300, y: 180, width: 180, height: 120 });
  const image = page.locator('#workbench').getByRole('img', { name: /正面の動き|動かす領域/ });
  await expect(image).toBeVisible();
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: `${output}/${info.project.name}-uploaded.png`, fullPage: true, scale: 'css' });
});

test('条件違反・未対応・AI未接続でも編集できる', async ({ page }) => {
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('60'); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  await expect(pdfButton(page)).toBeDisabled();
  await expect(page.getByText(/条件違反|見直す|要修正|修正が必要/).first()).toBeVisible();
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('20'); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  await expect(pdfButton(page)).toBeEnabled();
  await ai(page);
  await expect(page.getByText('AI未接続', { exact: true })).toBeVisible();
  await page.getByLabel('どんな動きにしたいですか？').fill('カメを回転させたい');
  await page.getByRole('button', { name: '変更案をつくる', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /未対応/ })).toBeVisible();
  await page.getByRole('button', { name: '代案「まっすぐ動かす」を選ぶ', exact: true }).click();
  await expect(page.getByLabel('どんな動きにしたいですか？')).toHaveValue(/まっすぐ/);
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('20');
});

test('通信失敗で作業を失わず、不正な画像を拒否する', async ({ page }) => {
  const beforeReload = await saveProject(page);
  await page.route('**/api/status', route => route.abort());
  await page.reload();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', beforeReload.document.designHash);
  await precision(page);
  await ai(page);
  await expect(page.getByText(/サーバーに接続できません/)).toBeVisible();
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('17'); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  await stage(page, 1);
  await page.getByLabel('画像を選ぶ', { exact: true }).setInputFiles({ name: 'pretend.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload="alert(1)"></svg>') });
  await expect(page.getByRole('alert')).toContainText(/SVG|PNG/);
  await expect(page.getByRole('alert')).toBeInViewport({ ratio: 1 });
  await precision(page);
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('17');
});

test('保存容量エラーを表示する', async ({ page }) => {
  await failIndexedDbWrites(page);
  await openSave(page);
  await page.getByRole('button', { name: 'このブラウザに保存', exact: true }).click();
  await closeDialog(page);
  await expect(page.locator('.storage-error')).toContainText(/保存|容量/);
  await expect(pdfButton(page)).toBeEnabled();
});

test('プロジェクト持ち出しと実物記録を同じ版に結び付ける', async ({ page }) => {
  await physical(page);
  await page.getByLabel('使った材料', { exact: true }).fill('テスト記録：実物ではなく保存操作の検証');
  await page.getByLabel('動作結果', { exact: true }).fill('実物未実施');
  await page.getByRole('button', { name: 'この設計版に記録を追加', exact: true }).click();
  await openSave(page);
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: /プロジェクトを書き出す/ }).click();
  const projectFile = await exported;
  const bytes = await readFile((await projectFile.path())!);
  const data = JSON.parse(bytes.toString());
  await closeDialog(page);
  expect(data.records).toHaveLength(1);
  expect(data.records[0].designHash).toBe(data.document.designHash);
  expect(data.records[0].measuredLine).toBe('');
  await precision(page);
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('17'); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  await openSave(page);
  await page.getByLabel('プロジェクトファイルを選ぶ', { exact: true }).setInputFiles({ name: 'portable.ugoku.json', mimeType: 'application/json', buffer: bytes });
  await precision(page);
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('20');
  await physical(page);
  await expect(page.getByText('実物未実施', { exact: true })).toBeVisible();
  await saveProject(page);
  const workspaceId = (await page.locator('main').getAttribute('data-workspace-id'))!;
  await page.getByRole('button', { name: '作品一覧', exact: true }).click();
  const entry = page.locator(`article[data-project-id="${workspaceId}"]`);
  await entry.getByText('作品の操作', { exact: true }).click();
  await entry.getByRole('button', { name: '削除する', exact: true }).click();
  await page.getByRole('dialog', { name: '作品の削除', exact: true }).getByRole('button', { name: '削除する', exact: true }).click();
  await expect(entry).toHaveCount(0);
  const removed = await savedWorkspace(page, workspaceId);
  expect(removed.project).toBeNull(); expect(removed.draft).toBeNull();
  expect(removed.metadata?.deleted).toBe(true);
});

test('画像の縦横比と選択座標がプレビュー・印刷で一致する', async ({ page }) => {
  await page.getByLabel('作品の幅（mm）', { exact: true }).fill('180'); await page.getByLabel('作品の幅（mm）', { exact: true }).press('Enter');
  await page.getByLabel('作品の高さ（mm）', { exact: true }).fill('60'); await page.getByLabel('作品の高さ（mm）', { exact: true }).press('Enter');
  await page.getByLabel('動きの位置', { exact: true }).fill('1');
  const preview = page.locator('#workbench').getByRole('img', { name: '正面の動きのプレビュー', exact: true });
  const transform = await preview.locator(':scope > g[transform]').first().getAttribute('transform');
  const motion = /translate\(([^ ,]+)[ ,]+([^ )]+)\)/.exec(transform!);
  // Preview geometry now uses mm directly (the same coordinate system as the kit).
  // Also verify the contain-fit artwork below so an accidental pixel/mm mix cannot pass.
  expect(Number(motion?.[1])).toBeCloseTo(20, 4);
  expect(Number(motion?.[2])).toBe(0);
  const data = await saveProject(page);
  expect(data.document.artwork.selectionMm.width).toBeCloseTo(200 * 60 / 550, 5);
  expect(data.document.artwork.selectionMm.x).toBeCloseTo((180 - 800 * 60 / 550) / 2 + 520 * 60 / 550, 5);
  expect(Number(await preview.locator(':scope > image').getAttribute('width'))).toBeCloseTo(800 * 60 / 550, 5);
  expect(Number(await preview.locator(':scope > image').getAttribute('x'))).toBeCloseTo((180 - 800 * 60 / 550) / 2, 5);
  await stage(page, 3);
  await page.getByText('印刷の設定と確認用SVG', { exact: true }).click();
  const svgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '確認用SVGをダウンロード', exact: true }).click();
  const svg = await readFile((await (await svgDownload).path())!, 'utf8');
  expect(svg).toContain('width="210mm" height="297mm" viewBox="0 0 210 297"');
  expect(svg).toContain(String(data.document.artwork.selectionMm.x));
  await stage(page, 1);
  await page.getByRole('button', { name: '動かす部分を選び直す', exact: true }).click();
  await selectionNumbers(page);
  const selection = page.getByRole('img', { name: /動かす領域/ });
  await selection.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('選択のX', { exact: true })).toHaveValue('521');
});

test('検査違反の印刷図・選択解除・固定条件が安全に動く', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('60'); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  await page.getByRole('button', { name: '印刷図', exact: true }).click();
  await expect(pdfButton(page)).toBeDisabled();
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('20'); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  await stage(page, 1);
  await page.getByRole('button', { name: '動かす部分を選び直す', exact: true }).click();
  await page.getByRole('button', { name: '選択を解除', exact: true }).click();
  await expect(pdfButton(page)).toBeDisabled();
  const committed = await saveProject(page);
  const cleared = await savedWorkspace(page);
  expect(cleared.draft?.selection).toBeNull();
  expect(cleared.draft?.selectionReady).toBe(false);
  expect(cleared.project.document).toEqual(committed.document);
  await expect(pdfButton(page)).toBeDisabled();
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await expect(pdfButton(page)).toBeEnabled();
  await precision(page);
  await page.getByLabel('動く距離を固定', { exact: true }).check();
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('サンプルの再読込中に編集しても、到着した旧応答が絵と編集を置き換えない', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/turtle.svg', async route => { requested = true; await held; await route.continue(); });
  const originalId = await page.locator('main').getAttribute('data-design-id');
  await stage(page, 1);
  await page.getByRole('button', { name: 'サンプルで試す', exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await precision(page);
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('18'); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  release();
  await expect(page.locator('main')).toHaveAttribute('data-design-id', originalId!);
  await expect(page.locator('#workbench').getByRole('img', { name: '正面の動きのプレビュー', exact: true })).toBeVisible();
  await expect(pdfButton(page)).toBeEnabled();
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('18');
});

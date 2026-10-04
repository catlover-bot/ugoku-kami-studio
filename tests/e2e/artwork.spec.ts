import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { applyArtworkRepair, createDesign, createImageInput, getArtworkComposition } from '@ugoku/core';
import { createHash } from 'node:crypto';
import { closeDialog, openSave, saveProject, stage } from './helpers';

async function fixture(kind: 'white' | 'transparent' | 'pattern') {
  const pattern = '<path d="M0 0H700V500H0Z" fill="#cfdfc8"/><path d="M0 80H700M0 180H700M0 280H700M0 380H700" stroke="#6b9189" stroke-width="34"/>';
  const source = `<svg width="700" height="500">${kind === 'white' ? '<rect width="700" height="500" fill="white"/>' : kind === 'pattern' ? pattern : ''}<circle cx="620" cy="235" r="32" fill="#728964"/><circle cx="510" cy="230" r="55" fill="none" stroke="#a54732" stroke-width="24"/></svg>`;
  return { art: await sharp(Buffer.from(source)).png().toBuffer(), background: await sharp(Buffer.from(`<svg width="700" height="500">${pattern}</svg>`)).png().toBuffer() };
}
async function importProject(page: Page, value: unknown) {
  await openSave(page);
  await page.getByLabel('プロジェクトファイルを選ぶ', { exact: true }).setInputFiles({ name: 'old.ugoku.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  await closeDialog(page);
}
function projectFrom(bytes: Buffer) {
  const doc = createDesign({ ...createImageInput({ id: createHash('sha256').update(bytes).digest('hex'), widthPx: 700, heightPx: 500, mimeType: 'image/png' }, '透過と背景の確認'), selection: { x: 420, y: 140, width: 180, height: 180 } }, { designId: 'artwork-regression', revision: 5 });
  return { format: 'ugoku-kami-project', version: 1, document: doc, imageDataUrl: `data:image/png;base64,${bytes.toString('base64')}`, records: [] };
}
async function sourceScreenPoint(page: Page, x: number, y: number) {
  const p = await saveProject(page);
  await page.locator('#workbench .artwork-svg').scrollIntoViewIfNeeded();
  return page.locator('#workbench .artwork-svg').evaluate((svg, args) => {
    const { x, y, doc } = args;
    const scale = doc.artwork.placement.width / doc.input.image.widthPx;
    const point = new DOMPoint(doc.artwork.placement.x + x * scale, doc.artwork.placement.y + y * scale).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
    return { x: point.x, y: point.y };
  }, { x, y, doc: p.document });
}

test('U2/U5/U7 author-chosen background is a versioned printable change; legacy image and records stay intact', async ({ page }) => {
  await page.goto('/');
  const { art, background } = await fixture('pattern');
  const legacy = projectFrom(art);
  await importProject(page, legacy);
  expect((await saveProject(page)).document).toEqual(legacy.document);
  await stage(page, 1);
  await page.getByText('元位置の背景を補う', { exact: true }).click();
  await page.getByLabel('背景用の画像を選ぶ', { exact: true }).setInputFiles({ name: 'background.png', mimeType: 'image/png', buffer: background });
  await expect(page.locator('.repair-candidate')).toBeVisible();
  expect((await saveProject(page)).document).toEqual(legacy.document);
  await page.locator('.repair-candidate').getByRole('button', { name: 'この案にする', exact: true }).click();
  const repaired = await saveProject(page);
  expect(repaired.document.schemaVersion).toBe(2);
  expect(repaired.document.revision).toBe(6);
  expect(repaired.document.designHash).not.toBe(legacy.document.designHash);
  expect(repaired.document.input.selection).toEqual(legacy.document.input.selection);
  expect(repaired.document.parts).toEqual(legacy.document.parts);
  expect(repaired.document.layout).toEqual(legacy.document.layout);
  expect(repaired.imageDataUrl).toEqual(legacy.imageDataUrl);
  expect(repaired.backgroundImageDataUrl).toBe(`data:image/png;base64,${background.toString('base64')}`);
  await stage(page, 2);
  await page.getByRole('button', { name: 'おわり', exact: true }).click();
  const preview = page.locator('#workbench .artwork-svg');
  await expect(preview.locator('[data-part="fixed-background"]')).toHaveAttribute('href', repaired.backgroundImageDataUrl);
  await expect(preview.locator('[data-part="M1-paper"]')).toHaveAttribute('fill', 'white');
  // Paper and ink must be composited before clipping: a double antialiased
  // white edge is visible on the printed-pattern fixture without this check.
  await preview.scrollIntoViewIfNeeded();
  const boundary = await preview.evaluate((svg, doc) => {
    const s = doc.artwork.selectionMm, box = svg.getBoundingClientRect();
    const point = new DOMPoint(s.x + doc.input.travelMm / 2, s.y).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
    return {x: point.x - box.x, y: point.y - box.y, width: box.width};
  }, repaired.document);
  const pixels = await sharp(await preview.screenshot()).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const ratio = pixels.info.width / boundary.width;
  for (const offset of [-1, 0, 1]) {
    const at = (Math.round(boundary.y * ratio + offset) * pixels.info.width + Math.round(boundary.x * ratio)) * pixels.info.channels;
    expect([...pixels.data.subarray(at, at + 3)]).toEqual([207,223,200]);
  }
  const beforeView = repaired.document;
  await page.getByLabel('表示倍率', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: '裏のしくみ', exact: true }).click();
  await page.getByRole('button', { name: '原画像', exact: true }).click();
  await page.getByRole('button', { name: '全体を見る', exact: true }).click();
  expect((await saveProject(page)).document).toEqual(beforeView);
  await stage(page, 3);
  const wait = page.waitForEvent('download'); await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
  const file = await wait;
  const pdf = await PDFDocument.load(await readFile((await file.path())!));
  expect(pdf.getSubject()).toContain(repaired.document.designHash);
  expect(pdf.getPageCount()).toBe(repaired.document.layout.sheets + 4);
  await page.reload(); await openSave(page); await page.getByRole('button', { name: '保存した作品を開く', exact: true }).click(); await closeDialog(page);
  expect((await saveProject(page)).document).toEqual(repaired.document);
  const invalid = { ...repaired, backgroundImageDataUrl: legacy.imageDataUrl };
  await importProject(page, invalid);
  await expect(page.getByRole('alert')).toContainText('背景用画像');
  expect((await saveProject(page)).document).toEqual(repaired.document);
});

test('U2 transparent pixels have printable white paper at both endpoints; solid repair needs explicit adoption', async ({ page }) => {
  await page.goto('/');
  const { art } = await fixture('transparent'); const legacy = projectFrom(art);
  await importProject(page, legacy); await stage(page, 2);
  for (const phase of ['はじめ', 'おわり']) {
    await page.getByRole('button', { name: phase, exact: true }).click();
    const paper = page.locator('#workbench [data-part="M1-paper"]'); await expect(paper).toHaveAttribute('fill', 'white');
    const mm = getArtworkComposition(legacy.document).movingPaper;
    for (const key of ['x','y','width','height'] as const) expect(Number(await paper.getAttribute(key))).toBeCloseTo(mm[key], 5);
  }
  await stage(page, 1); await page.getByText('元位置の背景を補う', { exact: true }).click();
  await page.getByLabel('背景の色', { exact: true }).fill('#cfdfc8');
  await page.getByRole('button', { name: 'この色で比較する', exact: true }).click();
  expect((await saveProject(page)).document.designHash).toEqual(legacy.document.designHash);
  await page.locator('.repair-candidate').getByRole('button', { name: 'この案を使わない', exact: true }).click();
  expect((await saveProject(page)).document).toEqual(legacy.document);
  await page.getByRole('button', { name: 'この色で比較する', exact: true }).click();
  await page.locator('.repair-candidate').getByRole('button', { name: 'この案にする', exact: true }).click();
  expect((await saveProject(page)).document.designHash).toEqual(applyArtworkRepair(legacy.document,{mode:'solid', color:'#cfdfc8'}).designHash);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  expect((await saveProject(page)).document.designHash).toEqual(legacy.document.designHash);
});

test('U3 mouse, two-tap and keyboard use source pixels through zoom; pointer cancellation and viewing do not commit', async ({ page }) => {
  await page.goto('/'); await stage(page, 1);
  await page.getByRole('button', { name: '動かす部分を選び直す', exact: true }).click();
  const before = await saveProject(page);
  await page.getByLabel('表示倍率', { exact: true }).selectOption('1.5');
  const frame = page.locator('#workbench .artwork-svg'); await frame.scrollIntoViewIfNeeded();
  // Choose safely within the zoomed viewport, outside the old sample selection.
  const first = await sourceScreenPoint(page, 260, 170), second = await sourceScreenPoint(page, 420, 320);
  await page.mouse.move(first.x, first.y); await page.mouse.down(); await page.mouse.move(second.x, second.y, { steps: 10 }); await page.mouse.up();
  const dragged = await saveProject(page);
  for (const [key, value] of Object.entries({x:260,y:170,width:160,height:150})) expect(dragged.document.input.selection[key]).toBeCloseTo(value, 0);
  expect(dragged.document.revision).toBe(before.document.revision + 1);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  expect((await saveProject(page)).document.input.selection).toEqual(before.document.input.selection);
  await page.getByRole('button', { name: '2点で囲む', exact: true }).click();
  await frame.scrollIntoViewIfNeeded();
  const p1=await sourceScreenPoint(page,280,190),p2=await sourceScreenPoint(page,430,330);
  const tap = async (p: {x:number;y:number}) => test.info().project.name === 'mobile' ? page.touchscreen.tap(p.x,p.y) : page.mouse.click(p.x,p.y);
  await tap(p1); const pending=await saveProject(page);
  await frame.scrollIntoViewIfNeeded(); await tap(p2);
  const tapped=await saveProject(page);
  expect(pending.document.input.selection).toEqual(before.document.input.selection);
  expect(tapped.document.input.selection).toEqual({x:280,y:190,width:150,height:140});
  await frame.focus(); await page.keyboard.press('Shift+ArrowRight');
  expect((await saveProject(page)).document.input.selection.x).toBe(290);
  const current=await saveProject(page);
  await page.getByRole('button', { name: 'ドラッグで囲む', exact: true }).click();
  const cancelPoint = await sourceScreenPoint(page, 260, 170);
  await page.mouse.move(cancelPoint.x, cancelPoint.y); await page.mouse.down();
  await frame.dispatchEvent('pointercancel',{pointerId:1}); await page.mouse.up();
  expect((await saveProject(page)).document).toEqual(current.document);
  await page.getByRole('button', { name: '全体を見る', exact: true }).click();
  expect((await saveProject(page)).document).toEqual(current.document);
  await frame.scrollIntoViewIfNeeded();
  const corner = await sourceScreenPoint(page, 440, 330), resizedCorner = await sourceScreenPoint(page, 480, 360);
  const hit = await frame.locator('[data-corner="se"]').boundingBox();
  expect(hit!.width).toBeCloseTo(44, 0); expect(hit!.height).toBeCloseTo(44, 0);
  await page.mouse.move(corner.x, corner.y); await page.mouse.down(); await page.mouse.move(resizedCorner.x, resizedCorner.y); await page.mouse.up();
  const resized = await saveProject(page);
  expect(resized.document.input.selection).toEqual({x:290,y:190,width:190,height:170});
  expect(resized.document.revision).toBe(current.document.revision + 1);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  expect((await saveProject(page)).document.input.selection).toEqual(current.document.input.selection);
  await page.getByRole('button', { name: '2点で囲む', exact: true }).click();
  const partial = await sourceScreenPoint(page, 280, 190); await tap(partial);
  const beforeSwitch = await saveProject(page);
  await stage(page, 2); await stage(page, 1);
  await page.getByRole('button', { name: '動かす部分を選び直す', exact: true }).click();
  await expect(page.locator('.selection-status')).toContainText('選択済み');
  expect((await saveProject(page)).document).toEqual(beforeSwitch.document);
});

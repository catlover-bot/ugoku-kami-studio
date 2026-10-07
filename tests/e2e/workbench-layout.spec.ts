import {expect, test, type Page} from '@playwright/test';
import {saveProject, stage, startSample} from './helpers';

const stamp = (page: Page) => page.locator('main').evaluate(element => ({
  hash: element.dataset.designHash!, revision: Number(element.dataset.designRevision),
}));

/** Map known source pixels through the actually rendered image, independently
 * of Preview's pointer-to-design conversion and its pan/zoom state. */
async function sourcePoint(page: Page, x: number, y: number, width: number, height: number) {
  const svg = page.locator('#workbench .artwork-svg');
  await svg.scrollIntoViewIfNeeded();
  const image = svg.locator(':scope > image').first();
  const imageBox = (await image.boundingBox())!, viewport = (await svg.boundingBox())!;
  const point = {x: imageBox.x + x / width * imageBox.width, y: imageBox.y + y / height * imageBox.height};
  expect(point.x).toBeGreaterThan(viewport.x + 2);
  expect(point.x).toBeLessThan(viewport.x + viewport.width - 2);
  expect(point.y).toBeGreaterThan(viewport.y + 2);
  expect(point.y).toBeLessThan(viewport.y + viewport.height - 2);
  return point;
}

test('Goal013 zoom and pan are view-only; Escape cannot leak a pan into two-point selection', async ({page}, info) => {
  await page.goto('/'); await startSample(page); await stage(page, 1);
  await page.getByRole('button', {name:'動かす部分を選び直す', exact:true}).click();
  await page.getByRole('button', {name:'2点で囲む', exact:true}).click();
  const original = await saveProject(page), base = await stamp(page);
  const undo = page.getByRole('button', {name:'元に戻す', exact:true});
  const redo = page.getByRole('button', {name:'やり直す', exact:true});
  await expect(undo).toBeDisabled(); await expect(redo).toBeDisabled();
  await page.getByLabel('表示倍率', {exact:true}).selectOption('2');
  const svg = page.locator('#workbench .artwork-svg');
  const zoomed = await svg.getAttribute('viewBox');
  await page.getByRole('button', {name:'表示を移動', exact:true}).click();
  await page.getByRole('button', {name:'表示を右へ', exact:true}).click();
  await svg.focus(); await page.keyboard.press('ArrowDown');
  await expect(svg).not.toHaveAttribute('viewBox', zoomed!);
  expect(await stamp(page)).toEqual(base);
  await expect(undo).toBeDisabled(); await expect(redo).toBeDisabled();

  await svg.scrollIntoViewIfNeeded();
  const beforePan = await svg.getAttribute('viewBox'), box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2 + 12, {steps:5});
  await expect(svg).not.toHaveAttribute('viewBox', beforePan!);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(svg).toHaveAttribute('viewBox', beforePan!);
  expect(await stamp(page)).toEqual(base);
  await page.getByRole('button', {name:'表示を移動', exact:true}).click();
  const tap = async (point: {x:number;y:number}) => info.project.name === 'mobile'
    ? page.touchscreen.tap(point.x, point.y) : page.mouse.click(point.x, point.y);
  const {widthPx, heightPx} = original.document.input.image;
  await tap(await sourcePoint(page, 350, 220, widthPx, heightPx));
  await expect(page.locator('.selection-status')).toContainText('選択中');
  expect(await stamp(page)).toEqual(base);
  await expect(undo).toBeDisabled();
  await tap(await sourcePoint(page, 440, 300, widthPx, heightPx));
  await expect.poll(() => stamp(page)).toMatchObject({revision:base.revision + 1});
  const selected = await saveProject(page);
  expect(selected.document.input.selection).toEqual({x:350,y:220,width:90,height:80});
  await undo.click();
  expect(await stamp(page)).toEqual({hash:base.hash,revision:base.revision + 2});
  await expect(undo).toBeDisabled(); await expect(redo).toBeEnabled();
  await redo.click();
  expect(await stamp(page)).toEqual({hash:selected.document.designHash,revision:base.revision + 3});
  const beforeFit = await saveProject(page);
  await page.getByRole('button', {name:'全体を見る', exact:true}).click();
  await expect(svg).toHaveAttribute('data-zoom','1');
  await expect(svg).toHaveAttribute('data-pan-x','0');
  await expect(svg).toHaveAttribute('data-pan-y','0');
  expect((await saveProject(page)).document).toEqual(beforeFit.document);
  await page.screenshot({path:info.outputPath('pan-selection-restored.png')});
});

import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { distanceIdeas, startSample, failIndexedDbWrites, closeDialog, manual, openSave, precision, saveProject, stage } from './helpers';

const sizes = [[1440, 900], [1280, 800], [1024, 768], [390, 844], [360, 800], [320, 800]] as const;
const identity = (page: Page) => page.locator('main').evaluate(element => ({ revision: element.getAttribute('data-design-revision'), hash: element.getAttribute('data-design-hash') }));

test('U1/U8 stages reflow and principal targets remain usable at the six specified CSS widths', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.goto('/'); await startSample(page);
  const measurements = [];
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: '作品一覧', exact: true }).click();
    const homePrimary = page.locator('.home-library').getByRole('button', { name: '自分の絵ではじめる', exact: true });
    const homeBounds = await homePrimary.boundingBox();
    expect(homeBounds!.width).toBeGreaterThanOrEqual(44); expect(homeBounds!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    measurements.push({ width, height, step: 'home', control: '自分の絵ではじめる', bounds: homeBounds });
    await page.locator('.home-library').getByRole('button', { name: '前の作品を続ける', exact: true }).click();
    for (const step of [1, 2, 3] as const) {
      await stage(page, step);
      await expect(page.locator('.workflow [aria-current="step"]')).toContainText(['絵を選ぶ', '動きをつける', '印刷して作る'][step - 1]!);
      const label = ['画像を選び直す', '印刷する内容を確認する', 'PDFをダウンロード'][step - 1]!;
      const control = page.getByRole('button', { name: label, exact: true });
      await expect(control).toBeVisible();
      const bounds = await control.boundingBox();
      expect(bounds!.width, `${width}px ${label} width`).toBeGreaterThanOrEqual(44);
      expect(bounds!.height, `${width}px ${label} height`).toBeGreaterThanOrEqual(44);
      const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: innerWidth }));
      expect(overflow.scrollWidth, `${width}px stage ${step} page overflow`).toBeLessThanOrEqual(overflow.width + 1);
      measurements.push({ width, height, step, control: label, bounds, overflow });
    }
  }
  await mkdir('artifacts/goal005/usability', { recursive: true });
  await writeFile(`artifacts/goal005/usability/${info.project.name}-layout.json`, JSON.stringify({ kind: 'Chromium viewport emulation, not real mobile hardware', measurements }, null, 2));
});

test('U8 200% equivalent reflow preserves controls and focused fields are not covered', async ({ page }, info) => {
  // A 1280px desktop at 200% has approximately 640 CSS px of layout width.
  // This deliberately records equivalent reflow, not actual browser chrome zoom.
  await page.setViewportSize({ width: 640, height: 400 });
  await page.goto('/'); await startSample(page); await precision(page);
  for (const step of [1, 2, 3] as const) {
    await stage(page, step);
    await expect(page.locator('.workflow')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await precision(page);
  await page.locator('.workflow button').first().focus();
  const focused = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    const current = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      const rect = element.getBoundingClientRect();
      const x = Math.max(1, Math.min(innerWidth - 1, rect.x + rect.width / 2));
      const y = Math.max(1, Math.min(innerHeight - 1, rect.y + rect.height / 2));
      const covering = document.elementFromPoint(x, y);
      return { tag: element.tagName, label: element.getAttribute('aria-label') ?? element.textContent?.slice(0, 50), width: rect.width, height: rect.height, visible: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth, uncovered: element === covering || element.contains(covering), outline: getComputedStyle(element).outlineStyle };
    });
    expect(current.visible, JSON.stringify(current)).toBe(true);
    expect(current.uncovered, JSON.stringify(current)).toBe(true);
    expect(current.width * current.height, JSON.stringify(current)).toBeGreaterThan(1);
    expect(current.outline, JSON.stringify(current)).not.toBe('none');
    focused.push(current);
  }
  await openSave(page);
  await expect(page.getByRole('dialog', { name: '保存と再開', exact: true })).toBeVisible();
  await closeDialog(page);
  await expect(page.getByRole('button', { name: '保存・再開', exact: true })).toBeFocused();
  await mkdir('artifacts/goal005/usability', { recursive: true });
  await writeFile(`artifacts/goal005/usability/${info.project.name}-focus.json`, JSON.stringify({ kind: '640x400 CSS viewport: 1280x800 at 200% equivalent reflow; no real OS keyboard or browser zoom', focused }, null, 2));
});

test('U8 sampled text and controls meet contrast targets using their actual computed colors', async ({ page }, info) => {
  await page.goto('/'); await startSample(page); await precision(page);
  const measurements = await page.evaluate(() => {
    type Color = [number, number, number, number];
    const color = (value: string): Color => { const numbers = value.match(/[\d.]+/g)?.map(Number) ?? []; return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 1]; };
    const over = (front: Color, back: Color): Color => [front[0] * front[3] + back[0] * (1 - front[3]), front[1] * front[3] + back[1] * (1 - front[3]), front[2] * front[3] + back[2] * (1 - front[3]), 1];
    const luminance = (value: Color) => value.slice(0, 3).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, index) => sum + v * [0.2126, 0.7152, 0.0722][index]!, 0);
    const ratio = (one: Color, two: Color) => (Math.max(luminance(one), luminance(two)) + 0.05) / (Math.min(luminance(one), luminance(two)) + 0.05);
    return [...document.querySelectorAll<HTMLElement>('.primary,.secondary,.text-button,.field-note,.muted,summary,label')].filter(element => element.getClientRects().length > 0 && !element.matches(':disabled') && !!element.textContent?.trim()).map(element => {
      const style = getComputedStyle(element); const ancestors: HTMLElement[] = [];
      for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) ancestors.push(parent);
      const background = ancestors.reverse().reduce((back, node) => over(color(getComputedStyle(node).backgroundColor), back), [255, 255, 255, 1] as Color);
      const foreground = over(color(style.color), background);
      const fontSize = parseFloat(style.fontSize), weight = Number(style.fontWeight);
      return { label: element.textContent!.trim().slice(0, 70), color: style.color, background, fontSize, ratio: ratio(foreground, background), minimum: fontSize >= 24 || (fontSize >= 18.6667 && weight >= 700) ? 3 : 4.5 };
    });
  });
  expect(measurements.length).toBeGreaterThan(10);
  expect(measurements.filter(item => item.ratio < item.minimum)).toEqual([]);
  await mkdir('artifacts/goal005/usability', { recursive: true });
  await writeFile(`artifacts/goal005/usability/${info.project.name}-contrast.json`, JSON.stringify({ kind: 'computed HTML text samples; not a complete WCAG conformance audit', measurements }, null, 2));
});

test('U8 input boundaries and keyboard focus have visible contrast against the panel', async ({ page }) => {
  await page.goto('/'); await startSample(page); await precision(page);
  const field = page.getByLabel('動く距離（mm）', { exact: true });
  await field.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  const measured = await field.evaluate(element => {
    const style = getComputedStyle(element);
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map(v => v / 255);
    const light = (value: string) => rgb(value).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    const contrast = (a: string, b: string) => (Math.max(light(a), light(b)) + 0.05) / (Math.min(light(a), light(b)) + 0.05);
    let background = 'rgb(255, 255, 255)';
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const color = getComputedStyle(parent).backgroundColor;
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { background = color; break; }
    }
    return { border: style.borderTopColor, outline: style.outlineColor, outlineWidth: parseFloat(style.outlineWidth), background, borderContrast: contrast(style.borderTopColor, background), focusContrast: contrast(style.outlineColor, background) };
  });
  expect(measured.borderContrast, JSON.stringify(measured)).toBeGreaterThanOrEqual(3);
  expect(measured.focusContrast, JSON.stringify(measured)).toBeGreaterThanOrEqual(3);
  expect(measured.outlineWidth).toBeGreaterThanOrEqual(2);
});

test('U4 same-scale synchronized comparison keeps the current document until explicit adoption', async ({ page }) => {
  await page.goto('/'); await startSample(page); await manual(page);
  const before = await saveProject(page);
  await distanceIdeas(page);
  await page.getByRole('button', { name: 'もう少し大きく', exact: true }).click();
  const comparison = page.locator('.intent-panel .design-comparison');
  const previewArea = page.locator('.candidate-workbench');
  const previews = previewArea.locator('.comparison-previews svg');
  await expect(previews).toHaveCount(2);
  expect(await previews.nth(0).getAttribute('viewBox')).toBe(await previews.nth(1).getAttribute('viewBox'));
  for (const phase of ['0', '0.5', '1']) {
    await previewArea.getByLabel('候補の比較位置', { exact: true }).fill(phase);
    await expect(previews.nth(0)).toHaveAttribute('data-phase', phase);
    await expect(previews.nth(1)).toHaveAttribute('data-phase', phase);
  }
  if (await previewArea.getByRole('button', { name: 'いまの作品', exact: true }).isVisible()) {
    await previewArea.getByRole('button', { name: 'いまの作品', exact: true }).click();
    const first = await previews.nth(0).boundingBox();
    await previewArea.getByRole('button', { name: '候補の作品', exact: true }).click();
    const second = await previews.nth(1).boundingBox();
    expect(second!.width).toBeCloseTo(first!.width, 1);
    expect(second!.height).toBeCloseTo(first!.height, 1);
  } else {
    const first = await previews.nth(0).boundingBox(), second = await previews.nth(1).boundingBox();
    expect(second!.width).toBeCloseTo(first!.width, 1);
    expect(second!.height).toBeCloseTo(first!.height, 1);
  }
  expect((await saveProject(page)).document).toEqual(before.document);
  await stage(page, 3);
  const pendingDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
  const output = await pendingDownload;
  const printed = await PDFDocument.load(await readFile((await output.path())!));
  expect(printed.getSubject()).toContain(before.document.designHash);
  await manual(page);
  await comparison.getByRole('button', { name: 'この案を使わない', exact: true }).click();
  expect((await saveProject(page)).document).toEqual(before.document);
  await distanceIdeas(page);
  await page.getByRole('button', { name: 'もう少し大きく', exact: true }).click();
  await comparison.getByRole('button', { name: 'この案にする', exact: true }).click();
  const adopted = await saveProject(page);
  expect(adopted.document.input.travelMm).toBeGreaterThan(before.document.input.travelMm);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  const undone = await saveProject(page);
  expect(undone.document.input).toEqual(before.document.input);
  expect(undone.document.revision).toBeGreaterThan(adopted.document.revision);
});

test('U5/U8 reduced motion and view-only controls preserve the design identity', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/'); await startSample(page); await stage(page, 2);
  const original = await identity(page);
  expect(original.hash).toMatch(/^[a-f0-9]{64}$/);
  await expect(page.locator('.distance-output')).toHaveAttribute('aria-live', 'off');
  await page.getByRole('button', { name: '動かす', exact: true }).click();
  await expect(page.getByRole('button', { name: '動かす', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'おわり', exact: true }).click();
  await expect(page.locator('#workbench svg.artwork-svg')).toHaveAttribute('data-phase', '1');
  await page.getByRole('button', { name: 'はじめ', exact: true }).click();
  await expect(page.locator('#workbench svg.artwork-svg')).toHaveAttribute('data-phase', '0');
  await stage(page, 1);
  await page.getByLabel('表示倍率', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: '全体を見る', exact: true }).click();
  // Back mechanisms belong to the motion stage; view changes still preserve identity.
  await stage(page, 2);
  await page.getByRole('button', { name: '裏のしくみ', exact: true }).click();
  await page.getByRole('button', { name: '正面', exact: true }).click();
  expect(await identity(page)).toEqual(original);
});

test('U5/U6 text undo and cancelling replacement after a failed save preserve unsaved work', async ({ page }) => {
  await page.goto('/'); await startSample(page); await precision(page);
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('18'); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  const edited = await identity(page);
  // Successful autosave no longer needs confirmation; force a real write failure.
  await failIndexedDbWrites(page);
  await manual(page);
  const prompt = page.getByLabel('どう動かしたいですか？', { exact: true });
  await prompt.fill(''); await prompt.pressSequentially('undo'); await prompt.press('Control+z');
  expect(await identity(page)).toEqual(edited);
  await page.getByRole('button', {name: '作品一覧', exact: true}).click();
  await page.getByRole('button', { name: 'サンプルで試す', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '未保存の変更', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '編集を続ける', exact: true }).click();
  expect(await identity(page)).toEqual(edited);
  await page.locator('.home-library').getByRole('button', {name:'前の作品を続ける',exact:true}).click();
  await precision(page);
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('18');
});

import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stage } from '../tests/e2e/helpers';

const temporary = await mkdtemp(join(tmpdir(), 'ugoku-zoom-check-'));
const extension = join(temporary, 'extension');
await mkdir(extension);
await writeFile(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Local isolated zoom verification', version: '1.0.0', permissions: ['tabs'], background: { service_worker: 'worker.js' } }));
await writeFile(join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
type ChromeApi = { chrome: { tabs: { query: (options: object) => Promise<{ id: number; url: string }[]>; setZoom: (id: number, factor: number) => Promise<void>; getZoom: (id: number) => Promise<number> } } };
const context = await chromium.launchPersistentContext(join(temporary, 'profile'), { channel: 'chromium', headless: true, viewport: null, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1440,900'] });
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto(process.env.MEASURE_BASE_URL ?? 'http://127.0.0.1:4173');
  const before = await page.evaluate(() => ({ innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio }));
  const zoom = await worker.evaluate(async () => {
    const api = (globalThis as unknown as ChromeApi).chrome.tabs;
    const tabs = await api.query({}); const tab = tabs.find(item => item.url.startsWith('http://127.0.0.1:'))!;
    if (!tab) throw new Error('Local test tab not found');
    await api.setZoom(tab.id, 2);
    return api.getZoom(tab.id);
  });
  expect(zoom).toBe(2);
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(Math.ceil(before.innerWidth / 2));
  const measurements = [];
  for (const step of [1, 2, 3] as const) {
    await stage(page, step);
    const measured = await page.evaluate(() => ({ innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio, scrollWidth: document.documentElement.scrollWidth, hash: document.querySelector('main')?.getAttribute('data-design-hash'), revision: document.querySelector('main')?.getAttribute('data-design-revision') }));
    expect(measured.scrollWidth).toBeLessThanOrEqual(measured.innerWidth + 1);
    const control = page.getByRole('button', { name: ['自分の絵ではじめる', 'もう少し大きく', 'PDFをダウンロード'][step - 1], exact: true });
    await control.scrollIntoViewIfNeeded(); await expect(control).toBeVisible();
    const box = await control.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
    measurements.push({ step, ...measured, primaryTarget: box });
  }
  await stage(page, 2); await page.locator('.workflow button').first().focus();
  const focus = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    const measured = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement, rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2)), Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2)));
      return { label: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 70), uncovered: element === top || element.contains(top), inViewport: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth, outline: getComputedStyle(element).outlineStyle };
    });
    expect(measured.uncovered).toBe(true); expect(measured.inViewport).toBe(true); expect(measured.outline).not.toBe('none');
    focus.push(measured);
  }
  const output = 'artifacts/goal003/usability'; await mkdir(output, { recursive: true });
  await page.locator('.workflow').scrollIntoViewIfNeeded();
  // Capture the browser surface: Playwright's fixed clip otherwise crops a host-zoomed tab.
  const cdp = await context.newCDPSession(page);
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  await writeFile(`${output}/browser-zoom-200.png`, Buffer.from(screenshot.data, 'base64'));
  const result = { checked: new Date().toISOString(), kind: 'Actual Chromium tab zoom via chrome.tabs.setZoom; isolated temporary extension/profile, not CSS zoom or CDP page scale', browserZoom: zoom, before, measurements, focus, browser: context.browser()?.version(), references: ['https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom', 'https://playwright.dev/docs/chrome-extensions'], realPhone: false };
  await writeFile(`${output}/browser-zoom-200.json`, JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally { await context.close(); await rm(temporary, { recursive: true, force: true }); }

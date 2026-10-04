import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import sharp from 'sharp';
import { parseDesignDocument } from '@ugoku/core';
import { createApp } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import { downloadKit, exportProject, goStage, importProject } from './live-browser.js';

const execute = promisify(execFile);
const json = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Local production UI through Home import (shared live-browser helper), explicit
 * AI-disabled config, no .env loading or model calls. Pass a new outDir per goal
 * to preserve prior prototype evidence. */
export async function capturePrototype(outDir = resolve('artifacts/goal004/prototype')) {
  outDir = resolve(outDir);
  const projectPath = join(outDir, 'prototype.ugoku.json');
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  const doc = parseDesignDocument(project.document);
  expect(project.records).toEqual([]);
  const manifestPath = join(outDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.mode !== 'manual') throw new Error('この収集コマンドは手動の試作に限ります。実Geminiはsmoke:liveで確認してください');
  expect(manifest.designHash).toBe(doc.designHash);
  const staticRoot = resolve('apps/web/dist');
  const builtIndexHash = sha256(await readFile(join(staticRoot, 'index.html')));
  const app = await createApp({ config: readConfig({ AI_PROVIDER: 'none' }), staticRoot });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  const browser = await chromium.launch({ headless: true });
  const records: unknown[] = [];
  let canonicalPdf: Awaited<ReturnType<typeof downloadKit>> | undefined;
  try {
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
      const dir = join(outDir, 'browser', name); await mkdir(dir, { recursive: true });
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true });
      const page = await context.newPage();
      const network: { method: string; path: string }[] = [], externalRequests: string[] = [], errors: string[] = [];
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) { externalRequests.push(url.origin); return route.abort(); }
        return route.continue();
      });
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === origin && url.pathname.startsWith('/api/')) network.push({ method: request.method(), path: url.pathname });
      });
      page.on('pageerror', error => errors.push(error.message));
      const stable = async () => {
        await expect(page.locator('main')).toHaveAttribute('data-design-hash', doc.designHash);
        await expect(page.locator('main')).toHaveAttribute('data-design-revision', String(doc.revision));
        await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))); });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      };
      const capture = async (filename: string, selector?: string) => {
        await stable();
        if (selector) await page.locator(selector).screenshot({ path: join(dir, filename) });
        else { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(dir, filename), fullPage: true }); }
      };
      const imported = await importProject(page, origin, projectPath);
      expect(imported).toEqual(doc);
      await capture('stage-image.png');
      await goStage(page, 2);
      await page.getByRole('button', { name: '正面', exact: true }).click();
      await page.getByRole('button', { name: 'はじめ', exact: true }).click();
      await expect(page.locator('.workbench svg.artwork-svg')).toHaveAttribute('data-phase', '0');
      await capture('front-start.png', '.workbench');
      await page.getByRole('button', { name: 'おわり', exact: true }).click();
      await expect(page.locator('.workbench svg.artwork-svg')).toHaveAttribute('data-phase', '1');
      await capture('front-end.png', '.workbench');
      await page.getByRole('button', { name: '裏のしくみ', exact: true }).click();
      await capture('back-end.png', '.workbench');
      await page.getByRole('button', { name: 'はじめ', exact: true }).click();
      await capture('back-start.png', '.workbench');
      await page.getByRole('button', { name: '正面', exact: true }).click();
      await page.locator('.motion-alternatives > summary').click();
      await page.getByRole('button', { name: 'もう少し大きく', exact: true }).click();
      await expect(page.locator('.intent-panel .manual-result')).toBeVisible();
      await expect(page.getByText('手動で編集中', { exact: true })).toBeVisible();
      const candidateHashes = await page.locator('.candidate-workbench svg.artwork-svg').evaluateAll(elements => elements.map(element => element.getAttribute('data-design-hash')));
      expect(candidateHashes).toContain(doc.designHash);
      expect(candidateHashes.some(hash => hash !== doc.designHash)).toBe(true);
      await capture('manual-candidate-not-adopted.png');
      await page.locator('.intent-panel').getByRole('button', { name: 'この案を使わない', exact: true }).click();
      const pdf = await downloadKit(page, doc, dir);
      if (name === 'desktop') { canonicalPdf = pdf; await copyFile(pdf.path, join(outDir, 'kit.pdf')); }
      await capture('stage-print.png');
      await page.locator('.physical-section > summary').click();
      await expect(page.locator('.physical-section .record-meta')).toContainText(doc.designHash);
      await expect(page.locator('.physical-section .record-meta')).toContainText(`${doc.designId}-r${doc.revision}.pdf`);
      expect(await page.locator('.physical-section input:not([type=file]), .physical-section textarea').evaluateAll(fields => fields.every(field => (field as HTMLInputElement).value === ''))).toBe(true);
      await capture('physical-blank.png', '.physical-section');
      const roundtrip = await exportProject(page, join(dir, 'roundtrip.ugoku.json'));
      expect(roundtrip).toEqual(doc);
      const exported = JSON.parse(await readFile(join(dir, 'roundtrip.ugoku.json'), 'utf8'));
      expect(exported.records).toEqual([]);
      expect(exported.imageDataUrl).toBe(project.imageDataUrl);
      expect(network.filter(item => /\/runs(?:\/|$)/.test(item.path))).toEqual([]);
      expect(externalRequests).toEqual([]);
      expect(errors).toEqual([]);
      records.push({ viewport: name, size: viewport, designId: doc.designId, revision: doc.revision, designHash: doc.designHash, candidateMode: 'manual-no-AI', candidateAdopted: false, candidateHashes, roundtripPreservesDocumentAndImage: true, recordsCount: 0, horizontalOverflow: false, physicalValidation: 'unverified', apiRequests: network, externalRequests: 0, pageErrors: [], pdf: { ...pdf, path: relative(outDir, pdf.path) } });
      await context.close();
    }
  } finally { await browser.close(); await app.close(); }
  if (!canonicalPdf) throw new Error('通常UIのPDFを取得できませんでした');
  await execute('pdftoppm', ['-png', '-r', '100', join(outDir, 'core-kit.pdf'), join(outDir, 'core-kit-page')]);
  await execute('pdftoppm', ['-png', '-r', '100', join(outDir, 'kit.pdf'), join(outDir, 'kit-page')]);
  await execute('pdftoppm', ['-png', '-r', '100', join(outDir, 'browser/mobile', `${doc.designId}-r${doc.revision}.pdf`), join(outDir, 'browser/mobile/kit-page')]);
  const renderedPages = [];
  for (let page = 1; page <= canonicalPdf.pages; page++) {
    const pixels = await Promise.all([join(outDir, `core-kit-page-${page}.png`), join(outDir, `kit-page-${page}.png`), join(outDir, `browser/mobile/kit-page-${page}.png`)].map(path => sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
    expect(pixels[1]!.info).toEqual(pixels[0]!.info); expect(pixels[2]!.info).toEqual(pixels[0]!.info);
    expect(pixels[1]!.data.equals(pixels[0]!.data)).toBe(true); expect(pixels[2]!.data.equals(pixels[0]!.data)).toBe(true);
    renderedPages.push({ page, size: pixels[0]!.info, coreAndDesktopPixelsEqual: true, coreAndMobilePixelsEqual: true, rawPixelSha256: sha256(pixels[0]!.data) });
  }
  const proof = { mode: 'manual', aiEnabled: false, modelCalls: 0, paidApiCalls: 0, builtIndexSha256: builtIndexHash, designId: doc.designId, revision: doc.revision, designHash: doc.designHash, patternSheets: doc.layout.sheets, pdfPages: canonicalPdf.pages, canonicalPdf: { path: 'kit.pdf', browserDefaultFilename: `${doc.designId}-r${doc.revision}.pdf`, sha256: canonicalPdf.sha256 }, physicalValidation: 'unverified', humanUsabilityTest: 'not-performed', realSmartphoneTest: 'not-performed', browserScreenshots: 'Actual Chromium at desktop and mobile CSS viewports; not physical photographs.', records, rasterComparison: { renderer: 'pdftoppm', dpi: 100, pages: renderedPages } };
  await json(join(outDir, 'browser-proof.json'), proof);
  await json(manifestPath, { ...manifest, browserExport: { status: 'verified', proof: 'browser-proof.json', path: 'kit.pdf', designHash: doc.designHash, revision: doc.revision, sha256: canonicalPdf.sha256, pages: canonicalPdf.pages, renderedAllPagesEqualToPreparedPdf: true }, physicalValidation: 'unverified' });
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out' || !args[1])) throw new Error('使い方: npx tsx scripts/capture-prototype.ts [--out 準備済みフォルダ]');
  const proof = await capturePrototype(args[1]);
  console.log(JSON.stringify({ mode: proof.mode, designId: proof.designId, revision: proof.revision, designHash: proof.designHash, pages: proof.pdfPages, viewports: ['1440×1000', '390×844'], allRenderedPagesEqual: true, paidApiCalls: 0, physicalValidation: proof.physicalValidation }, null, 2));
}

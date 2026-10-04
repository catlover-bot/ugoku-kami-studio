import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { parseDesignDocument } from '@ugoku/core';
import { INSTRUCTION_PAGE_COUNT } from '@ugoku/export';
import { closeDialog, openSave, precision, saveProject, stage } from '../e2e/helpers';

test('built image serves manual editing, restoration and a PDF for the same design revision', async ({ page, request, baseURL }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const externalRequests: string[] = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(baseURL!).origin) return route.continue();
    externalRequests.push(url.origin);
    return route.abort();
  });
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok' });
  const statusResponse = await request.get('/api/status');
  expect(statusResponse.status()).toBe(200);
  const status = await statusResponse.json();
  expect(status.ai).toMatchObject({ enabled: false, mode: 'manual', sendsImage: false });

  await page.goto('/');
  await expect(page.locator('.workflow')).toBeVisible();
  await page.getByRole('button', { name: 'サンプルで試す', exact: true }).click();
  await precision(page);
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('20');
  const originalHash = await page.locator('main').getAttribute('data-design-hash');
  await page.getByLabel('動く距離（mm）', { exact: true }).fill('18'); await page.getByLabel('動く距離（mm）', { exact: true }).press('Enter');
  const saved = await saveProject(page);
  const document = parseDesignDocument(saved.document);
  expect(document.input.travelMm).toBe(18);
  expect(document.designHash).not.toBe(originalHash);
  expect(document.checks.filter(check => check.status === 'fail')).toEqual([]);

  // The real disabled endpoint rejects a valid, authorized local session before
  // provider dispatch. These temporary session credentials are never exported.
  const sessionResponse = await request.post('/api/sessions', { data: { document } });
  expect(sessionResponse.status()).toBe(201);
  const session = await sessionResponse.json() as { sessionId: string; token: string };
  try {
    const denied = await request.post(`/api/sessions/${session.sessionId}/runs`, {
      headers: { authorization: `Bearer ${session.token}` },
      data: { requestId: `container-disabled-${info.project.name}`, prompt: '距離を15mmにしたい', baseRevision: document.revision, baseHash: document.designHash },
    });
    expect(denied.status()).toBe(503);
    expect((await denied.json()).error.code).toBe('ai_disabled');
  } finally {
    const removed = await request.delete(`/api/sessions/${session.sessionId}`, { headers: { authorization: `Bearer ${session.token}` } });
    expect(removed.status()).toBe(200);
  }

  await page.reload();
  await openSave(page);
  await page.getByRole('button', { name: '保存した作品を開く', exact: true }).click();
  await closeDialog(page);
  await precision(page);
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('18');
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', document.designHash);
  await expect(page.locator('main')).toHaveAttribute('data-design-revision', String(document.revision));
  await stage(page, 3);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
  const pdfPath = info.outputPath('manual-kit.pdf');
  await (await download).saveAs(pdfPath);
  const bytes = await readFile(pdfPath);
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getTitle()).toBe(`${document.designId} revision ${document.revision}`);
  expect(pdf.getSubject()).toContain(document.designHash);
  expect(pdf.getPageCount()).toBe(document.layout.sheets + INSTRUCTION_PAGE_COUNT);
  for (const sheet of pdf.getPages()) {
    expect(sheet.getWidth()).toBeCloseTo(210 * 72 / 25.4, 4);
    expect(sheet.getHeight()).toBeCloseTo(297 * 72 / 25.4, 4);
  }
  expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('manual-print.png'), fullPage: true });
  await writeFile(info.outputPath('evidence.json'), JSON.stringify({
    target: process.env.CONTAINER_IMAGE_ID ? 'docker-image' : 'external-server-control-not-container-proof',
    containerImageId: process.env.CONTAINER_IMAGE_ID ?? null,
    commit: process.env.GITHUB_SHA ?? null,
    viewport: info.project.name,
    aiMode: status.ai.mode,
    aiRunRejected: '503 ai_disabled',
    paidApiCalls: 0,
    design: { id: document.designId, revision: document.revision, hash: document.designHash, travelMm: document.input.travelMm },
    restoredSameRevision: true,
    pdf: { sha256: createHash('sha256').update(bytes).digest('hex'), pages: pdf.getPageCount(), title: pdf.getTitle(), subject: pdf.getSubject() },
    physicalValidation: 'unverified',
  }, null, 2) + '\n');
});

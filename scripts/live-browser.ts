import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, type Page, type Response } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { applyDesignPatch, parseDesignDocument, validateDesign, type DesignDocument } from '@ugoku/core';
import { INSTRUCTION_PAGE_COUNT } from '@ugoku/export';
import type { publicRun } from '../apps/server/src/runs.js';

export type LiveCase = 'L1' | 'L2' | 'L3';
export type PublicRun = ReturnType<typeof publicRun>;
export const CASE_PROMPTS: Record<LiveCase, string> = {
  L1: 'もう少し大きく動かしたい。絵の大きさは変えず、紙も増やさない',
  L2: '動く距離を70mmにしたい。絵の大きさは変えず、紙も増やさない',
  L3: '回転させたい',
};
export type CaseResult = {
  caseId: LiveCase; mode: 'gemini' | 'injected-test'; status: string; prompt: string;
  base: DesignDocument; adopted?: DesignDocument; run?: PublicRun;
  basePdf?: { path: string; sha256: string; pages: number; designHash: string; revision: number };
  runRequests: number; pdf?: { path: string; sha256: string; pages: number; designHash: string; revision: number };
  physicalValidation: 'unverified';
};

const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
export async function goStage(page: Page, stage: 1 | 2 | 3) {
  await page.locator('.workflow').getByRole('button', { name: new RegExp(`${['絵を選ぶ', '動きをつける', '印刷して作る'][stage - 1]}$`) }).click();
}
export async function importProject(page: Page, origin: string, path: string) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const doc = parseDesignDocument(raw.document);
  await page.goto(origin);
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', /[a-f0-9]{64}/);
  // The Home import is also available when a previous workspace auto-restores.
  await page.getByRole('button', { name: '作品一覧', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.home-library').getByRole('button', { name: 'ファイルを読み込む', exact: true }).click();
  await (await chooser).setFiles(path);
  await expect(page.locator('.workflow')).toBeVisible();
  await expect(page.locator('.status-message')).toContainText('ファイルから作品を開きました');
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', doc.designHash);
  await expect(page.locator('main')).toHaveAttribute('data-design-id', doc.designId);
  await expect(page.locator('main')).toHaveAttribute('data-design-revision', String(doc.revision));
  return doc;
}
export async function exportProject(page: Page, path: string) {
  await page.getByRole('button', { name: '保存・再開', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'プロジェクトを書き出す', exact: true }).click();
  await (await download).saveAs(path);
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  return parseDesignDocument(JSON.parse(await readFile(path, 'utf8')).document);
}
export async function downloadKit(page: Page, document: DesignDocument, outDir: string) {
  await goStage(page, 3);
  const download = page.waitForEvent('download', { timeout: 30_000 });
  await page.getByRole('button', { name: 'PDFをダウンロード', exact: true }).click();
  const path = join(outDir, `${document.designId}-r${document.revision}.pdf`);
  await (await download).saveAs(path);
  const bytes = await readFile(path);
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getTitle()).toBe(`${document.designId} revision ${document.revision}`);
  expect(pdf.getSubject()).toContain(document.designHash);
  expect(pdf.getPageCount()).toBe(document.layout.sheets + INSTRUCTION_PAGE_COUNT);
  for (const sheet of pdf.getPages()) {
    expect(sheet.getWidth()).toBeCloseTo(210 * 72 / 25.4, 4);
    expect(sheet.getHeight()).toBeCloseTo(297 * 72 / 25.4, 4);
  }
  const info = { path, sha256: createHash('sha256').update(bytes).digest('hex'), pages: pdf.getPageCount(), designHash: document.designHash, revision: document.revision };
  await json(join(outDir, 'pdf-binding.json'), info);
  return info;
}
function preserves(base: DesignDocument, next: DesignDocument) {
  expect(next.designId).toBe(base.designId);
  expect(next.input.image).toEqual(base.input.image);
  expect(next.input.selection).toEqual(base.input.selection);
  expect(next.input.widthMm).toBe(base.input.widthMm);
  expect(next.input.heightMm).toBe(base.input.heightMm);
  expect(next.layout.sheets).toBeLessThanOrEqual(base.layout.sheets);
  expect(next.input.maxSheets).toBeLessThanOrEqual(base.input.maxSheets);
  expect(validateDesign(next).filter(check => check.status === 'fail')).toEqual([]);
}

/** Uses only the normal browser UI and its HTTP endpoints. No provider or fake
 * response is installed here; mock runs must be explicitly supplied by tests. */
export async function runBrowserCase(options: { page: Page; origin: string; projectPath: string; accessSecret: string; caseId: LiveCase; outDir: string; timeoutMs: number; mode: 'gemini' | 'injected-test' }): Promise<CaseResult> {
  const { page, origin, projectPath, accessSecret, caseId, outDir, timeoutMs, mode } = options;
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(15_000);
  await mkdir(outDir, { recursive: true });
  const base = await importProject(page, origin, projectPath);
  if (caseId === 'L2') {
    // Prove that this exact request really fails the current core geometry.
    const requested = applyDesignPatch(base, { travelMm: 70 });
    const failures = validateDesign(requested).filter(check => check.status === 'fail');
    if (!failures.length) throw new Error('L2 fixture does not violate this design; no API request was sent.');
    await json(join(outDir, 'requested-constraint-failures.json'), { designHash: requested.designHash, failures });
  }
  const result: CaseResult = { caseId, mode, status: 'not-started', prompt: CASE_PROMPTS[caseId], base, runRequests: 0, physicalValidation: 'unverified' };
  if (caseId === 'L1') {
    const beforeDir = join(outDir, 'before');
    await mkdir(beforeDir, { recursive: true });
    result.basePdf = await downloadKit(page, base, beforeDir);
  }
  const pending = new Set<Promise<void>>();
  const onResponse = (response: Response) => {
    if (new URL(response.url()).origin !== origin || !/\/runs(?:\/[^/]+)?$/.test(new URL(response.url()).pathname)) return;
    if (response.request().method() === 'POST') result.runRequests++;
    const task = response.json().then(body => { if (body.run) result.run = body.run as PublicRun; }).catch(() => undefined);
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  page.on('response', onResponse);
  try {
    await goStage(page, 2);
    await page.getByRole('button', { name: 'Gemini', exact: true }).click();
    const aiSettings = page.locator('.ai-settings');
    if (!(await aiSettings.evaluate(element => (element as HTMLDetailsElement).open))) await aiSettings.locator(':scope > summary').click();
    await page.getByLabel('AIアクセスコード').fill(accessSecret);
    await page.getByLabel('どんな動きにしたいですか？', { exact: true }).fill(result.prompt);
    await page.getByRole('button', { name: '変更案をつくる', exact: true }).click();
    if (caseId === 'L3') {
      await expect(page.locator('.ai-panel').getByRole('status')).toContainText('未対応');
      await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.designHash);
      expect(result.runRequests).toBe(0);
      result.status = 'unsupported-locally-no-model-call';
      await page.screenshot({ path: join(outDir, 'unsupported.png'), fullPage: true });
      return result;
    }
    await expect.poll(() => result.run?.status ?? 'running', { timeout: timeoutMs + 15_000 }).not.toBe('running');
    await Promise.allSettled([...pending]);
    const run = result.run!;
    expect(run.mode).toBe(mode);
    expect(run.baseHash).toBe(base.designHash);
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.designHash);
    await json(join(outDir, 'run-before-decision.json'), run);
    await page.screenshot({ path: join(outDir, 'candidate-or-result.png'), fullPage: true });
    if (caseId === 'L1') {
      expect(run.status).toBe('awaiting_approval');
      expect(run.modelCalls).toBeGreaterThan(0);
      const tools = run.events.filter(event => event.type === 'tool').map(event => event.tool);
      expect(tools).toContain('propose_design_patch');
      const candidate = parseDesignDocument(run.proposal?.document);
      // The normal server always validates and arranges through the core. The
      // model need not split those operations into a scripted call sequence.
      expect(run.events.some(event => event.type === 'validation' && event.designHash === candidate.designHash && event.checkStatuses?.every(check => check.status !== 'fail'))).toBe(true);
      preserves(base, candidate);
      expect(candidate.input.travelMm).toBeGreaterThan(base.input.travelMm);
      expect(candidate.designHash).not.toBe(base.designHash);
      await page.locator('.ai-panel').getByRole('button', { name: 'この案にする', exact: true }).click();
      await expect(page.locator('main')).toHaveAttribute('data-design-hash', candidate.designHash);
      result.adopted = await exportProject(page, join(outDir, 'adopted.ugoku.json'));
      expect(result.adopted.designHash).toBe(candidate.designHash);
      await json(join(outDir, 'adopted-design.json'), result.adopted);
      await json(join(outDir, 'checks.json'), validateDesign(result.adopted));
      result.pdf = await downloadKit(page, result.adopted, outDir);
      result.status = 'adopted-and-pdf-verified';
      // Playback belongs to the motion stage; the print stage now opens the A4 preview.
      await goStage(page, 2);
      for (const [label, name, phase] of [['はじめ', 'start', '0'], ['おわり', 'end', '1']] as const) {
        await page.getByRole('button', { name: label, exact: true }).click();
        await expect(page.locator('.workbench .artwork-svg')).toHaveAttribute('data-phase', phase);
        await expect(page.locator('main')).toHaveAttribute('data-design-hash', result.adopted.designHash);
        await page.locator('.workbench .preview-surface').screenshot({ path: join(outDir, `${name}.png`) });
      }
      await goStage(page, 3);
      await page.screenshot({ path: join(outDir, 'print.png'), fullPage: true });
    } else {
      const proposal = run.proposal;
      if (proposal) {
        preserves(base, proposal.document);
        expect(proposal.fulfillsRequested).toBe(false);
        expect(proposal.requestedTravelMm).toBe(70);
        expect(proposal.document.input.travelMm).not.toBe(70);
        await page.locator('.ai-panel').getByRole('button', { name: 'この案を使わない', exact: true }).click();
        result.status = 'alternative-offered-original-preserved';
      } else {
        expect(run.constraintSuggestions.length).toBeGreaterThan(0);
        expect(run.validationIssues.length > 0 || run.error?.code === 'conditions_conflict').toBe(true);
        result.status = 'condition-change-offered-original-preserved';
      }
      await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.designHash);
    }
    await goStage(page, 2);
    await page.locator('.ai-evidence > summary').click();
    const evidence = page.waitForEvent('download');
    await page.getByRole('button', { name: 'AI実行記録を書き出す', exact: true }).click();
    const recordPath = join(outDir, 'browser-run-record.json');
    await (await evidence).saveAs(recordPath);
    const exported = JSON.parse(await readFile(recordPath, 'utf8'));
    const entry = exported.records.find((item: { runId: string }) => item.runId === run.id);
    expect(entry.execution.mode).toBe(mode);
    expect(entry.base.designHash).toBe(base.designHash);
    expect(entry.serverRun.modelCalls).toBe(run.modelCalls);
    if (result.adopted) {
      expect(entry.proposed.designHash).toBe(result.adopted.designHash);
      expect(entry.decision.status).toBe('accepted');
      expect(entry.decision.adopted).toMatchObject({ designId: result.adopted.designId, revision: result.adopted.revision, designHash: result.adopted.designHash });
    }
    return result;
  } catch (error) {
    result.status = 'verification-failed';
    // Do not serialize SDK/Playwright error text: it could contain credentials.
    throw error;
  } finally {
    page.off('response', onResponse);
    await Promise.allSettled([...pending]);
    await json(join(outDir, 'case-result.json'), result);
  }
}

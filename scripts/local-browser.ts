import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, type Response } from '@playwright/test';
import { applyDesignPatch, parseDesignDocument, validateDesign, type DesignDocument } from '@ugoku/core';
import { downloadKit, exportProject, goStage, importProject, openRequestEditor, type PublicRun } from './live-browser.js';

export type LocalCase = 'L1' | 'L2' | 'L3';
export const LOCAL_PROMPTS: Record<LocalCase, string> = {
  L1: 'あと5mm動かしたい。絵の大きさと紙の枚数は変えない',
  L2: '動く距離を70mmにしたい。絵の大きさと紙の枚数は変えない',
  L3: '回転させずに、右へ動かして。絵の大きさと紙の枚数は変えない',
};
export type LocalCaseResult = {
  caseId: LocalCase; mode: 'manual' | 'ollama'; prompt: string; status: string;
  elapsedMs: number; candidateWaitMs?: number; runRequests: number;
  base?: DesignDocument; run?: PublicRun; adopted?: DesignDocument;
  pdf?: Awaited<ReturnType<typeof downloadKit>>; resultText?: string;
  failedCheck?: string; errorKind?: string; serverRejection?: { status: number; code: string };
  physicalValidation: 'unverified';
};
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
function preserves(base: DesignDocument, next: DesignDocument) {
  expect(next.designId).toBe(base.designId);
  expect(next.input.image).toEqual(base.input.image);
  expect(next.input.selection).toEqual(base.input.selection);
  expect(next.input.widthMm).toBe(base.input.widthMm);
  expect(next.input.heightMm).toBe(base.input.heightMm);
  expect(next.input.maxSheets).toBe(base.input.maxSheets);
  expect(next.layout.sheets).toBeLessThanOrEqual(base.layout.sheets);
  expect(next.input.locks).toEqual(expect.arrayContaining(base.input.locks));
  expect(validateDesign(next).filter(check => check.status === 'fail')).toEqual([]);
}

/** Normal UI only. This helper never supplies provider responses or patches a
 * server/session. Every failed real trial remains in its own output directory. */
export async function runLocalBrowserCase(options: {
  page: Page; origin: string; projectPath: string; accessSecret: string;
  caseId: LocalCase; outDir: string; timeoutMs: number; mode: 'manual' | 'ollama';
}): Promise<LocalCaseResult> {
  const { page, origin, projectPath, accessSecret, caseId, outDir, timeoutMs, mode } = options;
  await mkdir(outDir, { recursive: true });
  const start = performance.now(); let check = 'import';
  const result: LocalCaseResult = { caseId, mode, prompt: LOCAL_PROMPTS[caseId], status: 'not-started', elapsedMs: 0, runRequests: 0, physicalValidation: 'unverified' };
  const pending = new Set<Promise<void>>();
  const onResponse = (response: Response) => {
    const url = new URL(response.url());
    if (url.origin !== origin || !/\/runs(?:\/[^/]+)?$/.test(url.pathname)) return;
    if (response.request().method() === 'POST') result.runRequests++;
    const task = response.json().then(body => {
      if (body.run) result.run = body.run;
      if (response.status() >= 400 && typeof body.error?.code === 'string') result.serverRejection = { status: response.status(), code: body.error.code };
    }).catch(() => undefined);
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  page.on('response', onResponse);
  page.setDefaultTimeout(15_000);
  try {
    const base = result.base = await importProject(page, origin, projectPath);
    expect(base.input.travelMm).toBe(20);
    if (caseId === 'L2') {
      const requested = applyDesignPatch(base, { travelMm: 70 });
      const failures = validateDesign(requested).filter(item => item.status === 'fail');
      expect(failures.length).toBeGreaterThan(0);
      await json(join(outDir, 'requested-constraint-failures.json'), { requestedTravelMm: 70, designHash: requested.designHash, failures });
    }
    await goStage(page, 2);
    check = 'configure-and-request';
    if (mode === 'ollama') {
      await page.getByRole('button', { name: '設定', exact: true }).click();
      const settings = page.getByRole('dialog', { name: '設定', exact: true });
      await settings.getByLabel('AIアクセスコード').fill(accessSecret);
      await settings.getByRole('button', { name: '閉じる', exact: true }).click();
    }
    await openRequestEditor(page);
    await page.getByLabel('どう動かしたいですか？', { exact: true }).fill(result.prompt);
    await page.screenshot({ path: join(outDir, 'before-request.png') });
    const requestedAt = performance.now();
    await page.getByRole('button', { name: mode === 'ollama' ? 'AIで案をつくる' : '寸法から案をつくる', exact: true }).click();
    check = 'wait-for-response';
    if (mode === 'ollama') {
      await expect.poll(() => result.serverRejection ? 'rejected' : result.run?.status ?? 'running', { timeout: timeoutMs + 15_000 }).not.toBe('running');
      await Promise.allSettled([...pending]);
      result.candidateWaitMs = Math.round(performance.now() - requestedAt);
      await json(join(outDir, 'run-before-decision.json'), result.run ?? result.serverRejection);
      check = 'real-local-response';
      expect(result.serverRejection).toBeUndefined();
      expect(result.run?.mode).toBe('ollama');
      expect(result.run?.modelCalls).toBeGreaterThan(0);
      expect(result.run?.modelUsage.some(call => call.received)).toBe(true);
      expect(result.run?.baseHash).toBe(base.designHash);
    } else {
      await expect(page.locator('.manual-result')).toBeVisible();
      result.candidateWaitMs = Math.round(performance.now() - requestedAt);
      expect(result.runRequests).toBe(0);
    }
    const panel = page.locator(mode === 'ollama' ? '.ai-panel' : '.intent-panel');
    result.resultText = await panel.innerText();
    await page.screenshot({ path: join(outDir, 'candidate-or-result.png'), fullPage: true });
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.designHash);
    check = 'requested-semantics';
    if (caseId === 'L1') {
      const proposedHash = result.run?.proposal?.document.designHash;
      if (mode === 'ollama') {
        expect(result.run?.status).toBe('awaiting_approval');
        expect(result.run?.events.some(event => event.tool === 'propose_design_patch')).toBe(true);
        const candidate = parseDesignDocument(result.run?.proposal?.document);
        preserves(base, candidate); expect(candidate.input.travelMm).toBe(25);
        expect(result.run?.proposal?.fulfillsRequested).toBe(true);
      }
      await expect(page.locator('.comparison-after figcaption')).toContainText('25mm');
      await panel.getByRole('button', { name: 'この案にする', exact: true }).click();
      check = 'adoption-and-pdf';
      const adopted = result.adopted = await exportProject(page, join(outDir, 'adopted.ugoku.json'));
      preserves(base, adopted); expect(adopted.input.travelMm).toBe(25);
      expect(adopted.revision).toBe(base.revision + 1);
      if (mode === 'ollama') expect(adopted.designHash).toBe(proposedHash);
      await json(join(outDir, 'checks.json'), validateDesign(adopted));
      result.pdf = await downloadKit(page, adopted, outDir);
      await page.screenshot({ path: join(outDir, 'print.png'), fullPage: true });
      result.status = 'adopted-and-pdf-verified';
    } else if (caseId === 'L2') {
      if (mode === 'ollama') {
        const run = result.run!;
        if (run.proposal) {
          preserves(base, run.proposal.document);
          expect(run.proposal.fulfillsRequested).toBe(false);
          expect(run.proposal.requestedTravelMm).toBe(70);
          expect(run.proposal.document.input.travelMm).not.toBe(70);
        } else {
          expect(run.constraintSuggestions.length).toBeGreaterThan(0);
          expect(run.validationIssues.length > 0 || run.error?.code === 'conditions_conflict').toBe(true);
        }
      } else await expect(panel).toContainText(/希望.*異なる|条件.*見直/);
      const reject = panel.getByRole('button', { name: 'この案を使わない', exact: true });
      if (await reject.count()) await reject.click();
      await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.designHash);
      result.status = 'incompatible-request-distinguished-original-preserved';
    } else {
      if (mode === 'ollama') {
        expect(result.run?.status).toBe('succeeded');
        expect(result.run?.requestInterpretation?.interpretation.mechanism).toBe('single-pull-tab');
        expect(result.run?.error).toBeUndefined();
      } else {
        await expect(panel).toContainText('現在の作品が希望と一致しています');
        await expect(panel).not.toContainText('この動きには対応していません');
      }
      await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.designHash);
      result.status = 'negated-rotation-keeps-right-motion';
    }
    if (mode === 'ollama') {
      check = 'browser-evidence-export';
      await page.getByRole('button', { name: '設定', exact: true }).click();
      const evidence = page.locator('.ai-evidence');
      if (!await evidence.evaluate(node => (node as HTMLDetailsElement).open)) await evidence.locator(':scope > summary').click();
      const download = page.waitForEvent('download');
      await evidence.getByRole('button', { name: 'AI実行記録を書き出す', exact: true }).click();
      const path = join(outDir, 'browser-run-record.json'); await (await download).saveAs(path);
      const records = JSON.parse(await readFile(path, 'utf8')).records;
      const entry = records.find((record: { runId: string }) => record.runId === result.run?.id);
      expect(entry.execution.mode).toBe('ollama');
      if (result.adopted) expect(entry.decision.adopted.designHash).toBe(result.adopted.designHash);
      await page.getByRole('dialog', { name: '設定', exact: true }).getByRole('button', { name: '閉じる', exact: true }).click();
    }
  } catch (error) {
    result.status = 'verification-failed'; result.failedCheck = check;
    result.errorKind = error instanceof Error ? error.name : 'UnknownError';
    // Error text may include Playwright input values. The public run and the
    // named failed check provide diagnostics without exporting credentials.
    await page.screenshot({ path: join(outDir, 'failure.png'), fullPage: true }).catch(() => undefined);
  } finally {
    await Promise.allSettled([...pending]); page.off('response', onResponse);
    result.elapsedMs = Math.round(performance.now() - start);
    await json(join(outDir, 'case-result.json'), result);
  }
  return result;
}

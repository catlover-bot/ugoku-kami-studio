import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadServerEnv, readConfig } from '../apps/server/src/config.js';
import { ATTEMPT_LIMITS, CAMPAIGN_LIMITS, parseLiveArgs, readLedger, reserveAttempt } from './live-budget.js';
import type { CaseResult } from './live-browser.js';

const campaignDir = resolve('artifacts/goal004/live');
const args = process.argv.slice(2);
let options: ReturnType<typeof parseLiveArgs> | undefined;
try { options = parseLiveArgs(args); } catch { /* handled without dispatch below */ }
const caseId = options?.caseId ?? 'L1';
if (!options) {
  console.error('使い方: npm run smoke:live -- --plan、または許可後に --case L1 --authorize-paid-api。');
  process.exitCode = 1;
} else if (options.plan) {
  try {
    const environment = loadServerEnv();
    const config = readConfig();
    const ledger = await readLedger(campaignDir);
    console.log(JSON.stringify({ status: 'offline-plan', selectedProvider: config.provider, eligibleForGeminiRun: config.provider === 'gemini', environmentFile: environment.path, configurationLoaded: environment.loaded, model: config.model, aiEnabled: config.aiEnabled, apiKeyConfigured: !!config.apiKey, accessSecretConfigured: config.accessSecret.length >= 32, caseId, sentData: '開発用の白背景作品の設計寸法・選択座標・検査結果と依頼文。画像本体なし。', perAttempt: { modelCalls: Math.min(config.maxModelCalls, ATTEMPT_LIMITS.modelCalls), toolCalls: Math.min(config.maxToolCalls, ATTEMPT_LIMITS.toolCalls), timeoutMs: Math.min(config.runTimeoutMs, ATTEMPT_LIMITS.executionMs), inputBytes: Math.min(config.maxInputBytes, 65_536), outputTokens: Math.min(config.maxOutputTokens, 4096) }, campaign: { ...CAMPAIGN_LIMITS, reservedAttempts: ledger.attempts.length, remainingAttempts: CAMPAIGN_LIMITS.attempts - ledger.attempts.length }, browserPath: '同じFastify API → 通常画面の比較・採用 → PDFワーカー', pricingReference: 'docs/live-gemini.md', networkRequests: 0, paidApiCalls: 0 }, null, 2));
  } catch { console.error('BLOCKED: 設定または履歴を確認できません。npm run doctor を実行してください。API呼び出し0回。'); process.exitCode = 1; }
} else if (!options.authorize || process.env.LIVE_API_AUTHORIZED !== 'yes') {
  // Authorization is deliberately not loaded from .env. The operator must opt
  // in for this invocation, in addition to passing the explicit CLI flag.
  console.log('SKIPPED: 実Gemini未実行。設定確認は npm run smoke:live -- --plan。本人の実行許可後だけ LIVE_API_AUTHORIZED=yes npm run smoke:live -- --case L1 --authorize-paid-api。API呼び出し0回。');
} else if (process.env.CI || process.env.NODE_ENV === 'test') {
  console.error('BLOCKED: check・E2E・CIから実APIは実行できません。API呼び出し0回。'); process.exitCode = 1;
} else {
  await authorizedRun();
}

async function authorizedRun() {
  let browser: import('@playwright/test').Browser | undefined;
  let app: import('../apps/server/src/app.js').App | undefined;
  let reservation: Awaited<ReturnType<typeof reserveAttempt>> | undefined;
  let result: CaseResult | undefined;
  let outputDir: string | undefined;
  let completed = false;
  let finalMeter: { modelCalls?: number; toolCalls?: number; runId?: string; usage?: unknown } = {};
  try {
    loadServerEnv();
    const configured = readConfig();
    if (configured.provider !== 'gemini' || !configured.aiEnabled || !configured.apiKey || configured.accessSecret.length < 32 || !process.env.GEMINI_MODEL) throw new Error('Explicit Gemini configuration missing');
    if (!existsSync('apps/web/dist/index.html')) throw new Error('Build missing');
    const { chromium } = await import('@playwright/test');
    if (!existsSync(chromium.executablePath())) throw new Error('Chromium missing');
    const { createPrototypeProject, writePrototypeBundle } = await import('./prepare-prototype.js');
    const seedDir = resolve('artifacts/goal004/live-input');
    const seed = await createPrototypeProject();
    await writePrototypeBundle(seed, { outDir: seedDir, mode: 'manual' });
    let projectPath = join(seedDir, 'prototype.ugoku.json');
    if (caseId !== 'L1') {
      const ledger = await readLedger(campaignDir);
      const first = ledger.attempts.find(item => item.caseId === 'L1' && item.status === 'adopted-and-pdf-verified');
      if (!first) throw new Error('First verify L1');
      projectPath = join(campaignDir, first.id, 'adopted.ugoku.json');
      if (!existsSync(projectPath)) throw new Error('Adopted L1 missing');
    }
    browser = await chromium.launch({ headless: true });
    const config = { ...configured, maxInputBytes: Math.min(configured.maxInputBytes, 65_536), maxOutputTokens: Math.min(configured.maxOutputTokens, 4096), maxModelCalls: Math.min(configured.maxModelCalls, ATTEMPT_LIMITS.modelCalls), maxToolCalls: Math.min(configured.maxToolCalls, ATTEMPT_LIMITS.toolCalls), runTimeoutMs: Math.min(configured.runTimeoutMs, ATTEMPT_LIMITS.executionMs), maxConcurrentRuns: 1, runsPerHour: 1, runsPerMinute: 1 };
    // Same application server, adapter, approval endpoint, and browser output.
    const { createApp } = await import('../apps/server/src/app.js');
    app = await createApp({ config, logger: false });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    reservation = await reserveAttempt(campaignDir, caseId, config.model);
    outputDir = join(campaignDir, reservation.id);
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    const { runBrowserCase } = await import('./live-browser.js');
    console.log(JSON.stringify({ status: 'starting-authorized-case', caseId, model: config.model, attemptId: reservation.id, maximumModelCalls: config.maxModelCalls, maximumToolCalls: config.maxToolCalls, timeoutMs: config.runTimeoutMs }));
    result = await runBrowserCase({ page, origin, projectPath, accessSecret: config.accessSecret, caseId, outDir: outputDir, timeoutMs: config.runTimeoutMs, mode: 'gemini' });
    if (result.adopted) {
      const adopted = JSON.parse(await readFile(join(outputDir, 'adopted.ugoku.json'), 'utf8'));
      const prototypeDir = join(outputDir, 'prototype');
      const bundle = await writePrototypeBundle(adopted, { outDir: prototypeDir, mode: 'live-gemini', liveRunId: result.run?.id });
      if (!result.pdf) throw new Error('Verified PDF missing');
      await copyFile(result.pdf.path, join(prototypeDir, 'kit.pdf'));
      await writeFile(join(prototypeDir, 'manifest.json'), JSON.stringify({ ...bundle, browserExport: { ...result.pdf, path: 'kit.pdf', source: 'normal browser UI and PDF worker', runId: result.run?.id } }, null, 2) + '\n');
    }
    completed = true;
    console.log(JSON.stringify({ status: result.status, caseId, mode: caseId === 'L3' ? 'local-unsupported-guard' : 'gemini', runId: result.run?.id ?? null, modelCalls: result.run?.modelCalls ?? 0, toolCalls: result.run?.toolCalls ?? 0, usage: result.run?.usage ?? null, outputDir, physicalValidation: 'unverified' }));
  } catch {
    // Never print raw HTTP/SDK/browser errors, which can contain credentials.
    console.error('FAILED: ライブ確認は完了していません。秘密を含み得るエラー本文は出力しません。doctor、準備資料、および保存されたcase-result.jsonを確認してください。自動再試行しません。');
    process.exitCode = 1;
  } finally {
    if (app) {
      const runs = [...app.sessions.sessions.values()].flatMap(session => [...session.runs.values()]);
      for (const run of runs) app.runs.cancel(run);
      await Promise.allSettled(runs.map(run => run.done));
      finalMeter = { modelCalls: runs.reduce((sum, run) => sum + run.modelCalls, 0), toolCalls: runs.reduce((sum, run) => sum + run.toolCalls, 0), runId: runs[0]?.id, usage: runs.map(run => ({ runId: run.id, usage: run.usage, modelUsage: run.modelUsage })) };
      if (outputDir) {
        const { publicRun } = await import('../apps/server/src/runs.js');
        await writeFile(join(outputDir, 'server-runs.json'), JSON.stringify(runs.map(publicRun), null, 2) + '\n', { mode: 0o600 });
      }
      await app.close();
    }
    await browser?.close();
    if (reservation) await reservation.finish({ status: completed ? result!.status : 'verification-failed', ...finalMeter });
  }
}

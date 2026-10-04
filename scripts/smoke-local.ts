import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadServerEnv, readConfig, type ServerConfig } from '../apps/server/src/config.js';
import type { App } from '../apps/server/src/app.js';
import type { Browser, BrowserContext } from '@playwright/test';
import type { LocalCase, LocalCaseResult } from './local-browser.js';
import { parseOllamaPid, startLocalMetrics } from './local-metrics.js';

export function parseLocalArgs(args: string[]): { plan: boolean; cases: LocalCase[] } {
  let plan = false, selected = 'all', hasCase = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plan' && !plan) plan = true;
    else if (args[i] === '--case' && !hasCase && ['L1', 'L2', 'L3', 'all'].includes(args[i + 1] ?? '')) { selected = args[++i]!; hasCase = true; }
    else throw new Error('Invalid local trial arguments');
  }
  return { plan, cases: selected === 'all' ? ['L1', 'L2', 'L3'] : [selected as LocalCase] };
}
function localConfig(): ServerConfig {
  loadServerEnv();
  if (process.env.CI || process.env.NODE_ENV === 'test') throw new Error('Local trial is not available in CI/tests');
  const config = readConfig();
  if (config.provider !== 'ollama' || !config.aiEnabled || config.maxConcurrentRuns !== 1) throw new Error('Explicit single-run local configuration required');
  return config;
}
const successStatuses = new Set(['adopted-and-pdf-verified', 'incompatible-request-distinguished-original-preserved', 'negated-rotation-keeps-right-motion']);

export async function runLocalSmoke(args = process.argv.slice(2)): Promise<number> {
  let options: ReturnType<typeof parseLocalArgs>, config: ServerConfig;
  try { options = parseLocalArgs(args); config = localConfig(); }
  catch { console.error('BLOCKED: ローカル専用設定と引数を確認してください。CI/test、非Ollama、並列数1以外では実行できません。推論0回。'); return 1; }
  if (options.plan) {
    // No application/provider/browser creation, process sampling, or network.
    console.log(JSON.stringify({ status: 'offline-local-plan', provider: config.provider, model: config.model,
      endpoint: config.ollama.baseUrl, expectedDigest: config.ollama.digest || null, contextLength: config.ollama.contextLength,
      toolMode: config.ollama.toolMode, cases: options.cases, order: 'Each case: manual then real Ollama, fresh browser context, same input.',
      limits: { modelCalls: config.maxModelCalls, toolCalls: config.maxToolCalls, inputBytes: config.maxInputBytes, outputTokens: config.maxOutputTokens, timeoutMs: config.runTimeoutMs, parallel: config.maxConcurrentRuns },
      networkRequests: 0, inferenceCalls: 0, hostedApiCalls: 0, prerequisites: 'Build and Chromium installed; a separately started loopback Ollama process has cloud disabled and the one selected model already present.' }, null, 2));
    return 0;
  }
  const startedAt = new Date().toISOString();
  const outputDir = resolve('artifacts/goal007r/local', `run-${startedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const json = async (path: string, value: unknown) => {
    const text = JSON.stringify(value, null, 2).replaceAll(config.accessSecret, '[redacted-access-secret]');
    await writeFile(path, `${text}\n`, { mode: 0o600 });
  };
  let browser: Browser | undefined, context: BrowserContext | undefined, app: App | undefined;
  let interrupted = false, stage = 'prerequisites';
  const results: LocalCaseResult[] = [], blockedRequests: { caseId: LocalCase; mode: 'manual' | 'ollama'; count: number }[] = [];
  let failure: string | undefined;
  const stop = () => {
    interrupted = true;
    for (const session of app?.sessions.sessions.values() ?? []) for (const run of session.runs.values()) app!.runs.cancel(run);
    void context?.close().catch(() => undefined);
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (!existsSync('apps/web/dist/index.html')) throw new Error('Build missing');
    const { chromium } = await import('@playwright/test');
    if (!existsSync(chromium.executablePath())) throw new Error('Chromium missing');
    const ollamaPid = parseOllamaPid(process.env.UGOKU_OLLAMA_PID);
    const { createPrototypeProject } = await import('./prepare-prototype.js');
    const { createDesign, applyDesignPatch, canExport } = await import('@ugoku/core');
    const seed = await createPrototypeProject();
    const document = createDesign({ ...seed.document.input, title: 'ローカルAIを確かめる魚', travelMm: 20, locks: seed.document.input.locks.filter(key => key !== 'direction') }, { designId: 'goal007r-fish', revision: 1 });
    if (!canExport(document) || !canExport(applyDesignPatch(document, { travelMm: 25 })) || canExport(applyDesignPatch(document, { travelMm: 70 }))) throw new Error('Fixture geometry invalid');
    const projectPath = join(outputDir, 'input.ugoku.json'); await json(projectPath, { ...seed, document });
    await json(join(outputDir, 'configuration.json'), { provider: config.provider, model: config.model, ollama: config.ollama,
      limits: { modelCalls: config.maxModelCalls, toolCalls: config.maxToolCalls, inputBytes: config.maxInputBytes, outputTokens: config.maxOutputTokens, timeoutMs: config.runTimeoutMs, concurrentRuns: config.maxConcurrentRuns, runsPerMinute: config.runsPerMinute, runsPerHour: config.runsPerHour },
      measurementParentPid: ollamaPid ?? null, measurementMissingPid: !ollamaPid, input: { designId: document.designId, revision: document.revision, designHash: document.designHash }, hostedApiCalls: 0, physicalValidation: 'unverified' });
    stage = 'start-application';
    const { createApp } = await import('../apps/server/src/app.js');
    const { publicRun } = await import('../apps/server/src/runs.js');
    app = await createApp({ config, logger: false }); // No injected provider and no hosted fallback.
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    browser = await chromium.launch({ headless: true });
    const { runLocalBrowserCase, LOCAL_PROMPTS } = await import('./local-browser.js');
    for (const caseId of options.cases) for (const mode of ['manual', 'ollama'] as const) {
      if (interrupted) break;
      stage = `${caseId}-${mode}`;
      const caseDir = join(outputDir, caseId, mode); await mkdir(caseDir, { recursive: true, mode: 0o700 });
      const beforeRunIds = new Set([...app.sessions.sessions.values()].flatMap(session => [...session.runs.keys()]));
      const newRuns = () => [...app!.sessions.sessions.values()].flatMap(session => [...session.runs.values()]).filter(run => !beforeRunIds.has(run.id));
      const network = { caseId, mode, count: 0 }; blockedRequests.push(network);
      let metrics: Awaited<ReturnType<typeof startLocalMetrics>> | undefined;
      const began = performance.now();
      let result: LocalCaseResult = { caseId, mode, prompt: LOCAL_PROMPTS[caseId], status: 'verification-failed', failedCheck: 'case-setup', elapsedMs: 0, runRequests: 0, physicalValidation: 'unverified' };
      try {
        metrics = await startLocalMetrics({ baseUrl: config.ollama.baseUrl, model: config.model, ollamaPid });
        context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, serviceWorkers: 'block' });
        await context.route('**/*', route => {
          if (new URL(route.request().url()).origin === origin) return route.continue();
          network.count++; return route.abort();
        });
        result = await runLocalBrowserCase({ page: await context.newPage(), origin, projectPath, accessSecret: config.accessSecret, caseId, outDir: caseDir, timeoutMs: config.runTimeoutMs, mode });
        if (mode === 'manual' && newRuns().some(run => run.modelCalls > 0)) result = { ...result, status: 'verification-failed', failedCheck: 'manual-started-inference' };
        if (network.count) result = { ...result, status: 'verification-failed', failedCheck: 'external-browser-request-blocked' };
      } catch { result = { ...result, status: 'verification-failed', failedCheck: interrupted ? 'interrupted' : 'case-runner', elapsedMs: Math.round(performance.now() - began) }; }
      finally {
        // Capture the real outcome before cleanup cancels any outstanding approval.
        await json(join(caseDir, 'server-runs.json'), newRuns().map(publicRun));
        for (const run of newRuns()) app.runs.cancel(run);
        await Promise.allSettled(newRuns().map(run => run.done));
        await context?.close().catch(() => undefined); context = undefined;
        if (metrics) await json(join(caseDir, 'memory.json'), await metrics.stop());
        else await json(join(caseDir, 'memory.json'), { status: 'not-measured', reason: 'case-setup-failed' });
        if (!result.elapsedMs) result.elapsedMs = Math.round(performance.now() - began);
        await json(join(caseDir, 'case-result.json'), result); results.push(result);
        console.log(JSON.stringify({ caseId, mode, status: result.status, failedCheck: result.failedCheck ?? null, modelCalls: result.run?.modelCalls ?? 0, elapsedMs: result.elapsedMs, outputDir: caseDir }));
      }
    }
  } catch { failure = interrupted ? 'interrupted' : stage; }
  finally {
    if (app) {
      const { publicRun } = await import('../apps/server/src/runs.js');
      const runs = [...app.sessions.sessions.values()].flatMap(session => [...session.runs.values()]);
      for (const run of runs) app.runs.cancel(run);
      await Promise.allSettled(runs.map(run => run.done));
      await json(join(outputDir, 'server-runs-final.json'), runs.map(publicRun));
    }
    await browser?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await json(join(outputDir, 'manifest.json'), { startedAt, completedAt: new Date().toISOString(), status: failure || interrupted || results.some(result => !successStatuses.has(result.status)) || results.length !== options.cases.length * 2 ? 'verification-failed' : 'completed',
      failedCheck: failure ?? (interrupted ? 'interrupted' : null), requestedCases: options.cases, provider: 'ollama', realGemini: false, hostedApiCalls: 0, runtimeStartedByRunner: false, modelDownloadedByRunner: false,
      physicalValidation: 'unverified', blockedExternalBrowserRequests: blockedRequests, cases: results.map(result => ({ caseId: result.caseId, mode: result.mode, status: result.status, failedCheck: result.failedCheck ?? null, elapsedMs: result.elapsedMs, candidateWaitMs: result.candidateWaitMs ?? null, runId: result.run?.id ?? null, modelCalls: result.run?.modelCalls ?? 0, modelUsage: result.run?.modelUsage ?? [], path: `${result.caseId}/${result.mode}/case-result.json` })) });
  }
  const failed = !!failure || interrupted || results.some(result => !successStatuses.has(result.status)) || results.length !== options.cases.length * 2;
  console.log(JSON.stringify({ status: failed ? 'verification-failed' : 'completed', outputDir, hostedApiCalls: 0 }));
  return failed ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runLocalSmoke(); }
  catch { console.error('FAILED: 試験の準備または成果物保存を完了できませんでした。秘密を含み得る例外本文は出力しません。'); process.exitCode = 1; }
}

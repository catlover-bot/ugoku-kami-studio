import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { FinishReason, type Part } from '@google/genai';
import { createApp } from '../../apps/server/src/app.js';
import { readConfig } from '../../apps/server/src/config.js';
import type { ModelProvider, ProviderResponse } from '../../apps/server/src/provider.js';
import { createPrototypeProject } from '../../scripts/prepare-prototype.js';
import { runBrowserCase, type LiveCase } from '../../scripts/live-browser.js';

const access = 'offline-workflow-test-access-32-characters';
const response = (parts: Part[]): ProviderResponse => ({ candidates: [{ finishReason: FinishReason.STOP, content: { role: 'model', parts } }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10, totalTokenCount: 40 } });
const call = (name: string, args: Record<string, unknown> = {}): Part => ({ functionCall: { name, args, id: `offline-${name}` } });

for (const caseId of ['L1', 'L2', 'L3'] as LiveCase[]) test(`Goal004 ${caseId}: offline transport, actual application/approval/PDF path`, async ({ page }, info) => {
  test.setTimeout(60_000);
  const outDir = resolve(`artifacts/goal005/rehearsal/${info.project.name}/${caseId}`);
  await mkdir(outDir, { recursive: true });
  const project = await createPrototypeProject();
  const projectPath = join(outDir, 'input.ugoku.json');
  await writeFile(projectPath, JSON.stringify(project));
  let calls = 0;
  const provider: ModelProvider = {
    async generate() {
      calls++;
      if (calls === 1) return response([call('inspect_design'), call('propose_design_patch'), call('validate_design'), call('arrange_pages')]);
      if (caseId === 'L2' && calls === 2) return response([call('propose_constraint_change', { key: 'widthMm', value: project.document.input.widthMm + 50, reason: '指定した70mmでは台紙の余裕が不足します。幅変更を許すか、距離を短くする選択が必要です。' })]);
      return response([{ text: 'テスト専用のモデル通信です。実際のコア検査結果を確認しました。実物は未検証です。' }]);
    },
  };
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  let app;
  try { app = await createApp({ config: readConfig({ AI_ENABLED: 'true', GEMINI_API_KEY: 'offline-no-real-key', AI_ACCESS_SECRET: access }), provider }); }
  finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
  try {
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    const result = await runBrowserCase({ page, origin, projectPath, accessSecret: access, caseId, outDir, timeoutMs: 15_000, mode: 'injected-test' });
    expect(result.mode).toBe('injected-test');
    expect(result.status).toBe(caseId === 'L1' ? 'adopted-and-pdf-verified' : caseId === 'L2' ? 'condition-change-offered-original-preserved' : 'unsupported-by-server-no-model-call');
    expect(calls).toBe(caseId === 'L1' ? 2 : caseId === 'L2' ? 3 : 0);
    expect(result.physicalValidation).toBe('unverified');
  } finally {
    // Release browser connections before awaiting the server owned by this test.
    // Fixture cleanup happens after this function returns; waiting for app.close()
    // first can leave it waiting on a speculative/keep-alive browser socket.
    try { await page.context().close(); } finally { await app.close(); }
  }
});

import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { applyDesignPatch, parseDesignDocument, type DesignDocument } from '@ugoku/core';
import type { AiEvidence, AiRun } from '../../apps/web/src/aiEvidence';
import { openRequest, startSample, stage } from './helpers';

// Browser HTTP fixtures only. The app server has AI_PROVIDER=none; no SDK,
// Google endpoint, credential or live model is used by these tests.
class VertexHttpFixture {
  statusMode: 'vertex' | 'injected-test' = 'vertex';
  response: 'proposal' | 'running' = 'proposal';
  document?: DesignDocument;
  run?: AiRun;
  starts = 0;
  approvals = 0;
  cancelHeaders?: Record<string, string>;

  async attach(page: Page) {
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/status') return json({ ai: { enabled: true, provider: 'vertex', mode: this.statusMode,
        model: 'vertex-http-fixture-model', endpoint: 'https://aiplatform.googleapis.com', sendsImage: false },
      limits: { modelCalls: 6, toolCalls: 12, timeoutMs: 180000, inputBytes: 65536, outputTokens: 768 } });
      if (path === '/api/sessions' && method === 'POST') {
        this.document = parseDesignDocument(request.postDataJSON().document);
        return json({ sessionId: 'vertex-fixture-session', token: 'vertex-fixture-token' }, 201);
      }
      if (path.endsWith('/runs') && method === 'POST') {
        this.starts++;
        const body = request.postDataJSON();
        expect(body.baseHash).toBe(this.document!.designHash);
        expect(body.baseRevision).toBe(this.document!.revision);
        const candidate = applyDesignPatch(this.document!, { travelMm: 25 });
        expect(candidate.checks.filter(check => check.status === 'fail')).toEqual([]);
        this.run = { id: 'vertex-http-fixture-run', requestId: body.requestId, baseRevision: body.baseRevision, baseHash: body.baseHash,
          mode: 'injected-test', provider: 'vertex', model: 'vertex-http-fixture-model',
          status: this.response === 'running' ? 'running' : 'awaiting_approval',
          message: 'Vertex接続のHTTP表示試験です。実API・実モデルには送信していません。',
          events: this.response === 'running' ? [] : [{ type: 'validation', message: '模擬候補を共通coreで検査', designHash: candidate.designHash,
            checkStatuses: candidate.checks.map(({ id, status }) => ({ id, status })), durationMs: 0 }],
          constraintSuggestions: [], modelCalls: 1, toolCalls: this.response === 'running' ? 0 : 1, elapsedMs: 0,
          modelUsage: [{ call: 1, inputBytes: 100, outputTokenLimit: 768, durationMs: 0, received: false, finishReason: null, modelVersion: null, usage: null }],
          ...(this.response === 'proposal' ? { proposal: { id: 'vertex-fixture-proposal', patch: { travelMm: 25 }, document: candidate } } : {}) };
        return json({ run: this.run }, 202);
      }
      if (path.includes('/runs/') && method === 'GET') return json({ run: this.run });
      if (path.endsWith('/approve') && method === 'POST') {
        expect(request.postDataJSON()).toMatchObject({ requestId: this.run!.requestId, baseRevision: this.run!.baseRevision, baseHash: this.run!.baseHash });
        this.approvals++;
        return json({ document: this.run!.proposal!.document });
      }
      if (path.includes('/runs/') && method === 'DELETE') {
        this.cancelHeaders = await request.allHeaders();
        expect(request.postData()).toBeNull();
        this.run = { ...this.run!, status: 'cancelled', proposal: undefined, dispatchClosed: true, cancellation: {requestedAt: '2026-10-05T00:00:00.000Z', previousStatus: this.run!.status, dispatchClosedBeforeCancel: false, abortSignalAborted: true, toolCallsAtRequest: this.run!.toolCalls} };
        return json({ run: {...this.run, cancellation: {...this.run.cancellation, authorization: 'fixture-private-field-must-not-be-exported'}} });
      }
      throw new Error(`Unexpected fixture API path: ${method} ${path}`);
    });
  }
}

async function prepare(page: Page, fixture: VertexHttpFixture) {
  await fixture.attach(page);
  await page.goto('/'); await startSample(page); await stage(page, 2); await openRequest(page);
  await expect(page.getByLabel('どう動かしたいですか？', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '設定', exact: true });
  await settings.getByLabel('AIアクセスコード').fill('vertex-fixture-access-not-a-real-secret');
  return settings;
}

async function record(page: Page, path: string) {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.locator('.ai-evidence > summary').click();
  await expect(page.locator('.ai-evidence strong')).toHaveText('模擬実行（Vertex AI）');
  await expect(page.locator('.ai-evidence')).not.toContainText('実Vertex AI');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'AI実行記録を書き出す', exact: true }).click();
  await (await downloading).saveAs(path);
  const text = await readFile(path, 'utf8');
  expect(text).not.toContain('vertex-fixture-access-not-a-real-secret');
  expect(text).not.toContain('vertex-fixture-token');
  return JSON.parse(text) as { records: AiEvidence[] };
}

test('Vertex setup stays in settings; a mocked candidate uses the same workbench and keeps mock provenance', async ({ page }, info) => {
  const fixture = new VertexHttpFixture();
  const settings = await prepare(page, fixture);
  await expect(settings.getByRole('heading', { name: 'Vertex AI（設定済み）', exact: true })).toBeVisible();
  await expect(settings).toContainText('認証はサーバー側で行います');
  await expect(settings).toContainText('設定済みの表示だけでは、接続成功を確認していません');
  await expect(settings.getByRole('combobox')).toHaveCount(0);
  expect(fixture.starts).toBe(0);
  await settings.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.getByText('モデル：vertex-http-fixture-model', { exact: true })).not.toBeVisible();
  const beforeHash = await page.locator('main').getAttribute('data-design-hash');
  await page.getByRole('button', { name: 'AIで案をつくる', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'AIの変更案 · 採用待ち', exact: true })).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', beforeHash!);
  await expect(page.getByLabel('どう動かしたいですか？', { exact: true })).toHaveCount(1);
  await expect(page.locator('.comparison-workbench')).toHaveCount(1);
  await expect(page.locator('.motion-settings')).not.toBeVisible();
  const previews = page.locator('.comparison-previews .artwork-svg');
  await expect(previews).toHaveCount(2);
  expect(await previews.nth(0).getAttribute('viewBox')).toBe(await previews.nth(1).getAttribute('viewBox'));
  const comparisonPosition = page.getByLabel('候補の比較位置', { exact: true });
  if (info.project.name === 'desktop') {
    await expect(page.getByRole('group', { name: '比べる作品', exact: true })).toBeHidden();
    const bounds = await comparisonPosition.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    const scales = await previews.evaluateAll(elements => elements.map(element => {
      const matrix = (element as SVGSVGElement).getScreenCTM();
      return matrix ? { x: matrix.a, y: matrix.d } : null;
    }));
    expect(scales[0]).toEqual(scales[1]);
    await page.setViewportSize({ width: 1366, height: 768 });
    const compactBounds = await comparisonPosition.boundingBox();
    expect(compactBounds!.y + compactBounds!.height).toBeLessThanOrEqual(768);
  }
  await page.getByRole('button', { name: '比較を始点にする', exact: true }).click();
  await expect(comparisonPosition).toHaveValue('0');
  await expect(previews.nth(0)).toHaveAttribute('data-phase', '0');
  await expect(previews.nth(1)).toHaveAttribute('data-phase', '0');
  await comparisonPosition.focus(); await comparisonPosition.press('End');
  await expect(comparisonPosition).toHaveValue('1');
  await expect(previews.nth(0)).toHaveAttribute('data-phase', '1');
  await expect(previews.nth(1)).toHaveAttribute('data-phase', '1');
  if (info.project.name === 'mobile') {
    const candidateBox = await previews.nth(1).boundingBox();
    await page.getByRole('button', { name: 'いまの作品', exact: true }).click();
    const currentBox = await previews.nth(0).boundingBox();
    expect(currentBox!.width).toBeCloseTo(candidateBox!.width, 1);
    expect(currentBox!.height).toBeCloseTo(candidateBox!.height, 1);
    await page.getByRole('button', { name: '候補の作品', exact: true }).click();
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('vertex-http-fixture-candidate.png'), fullPage: true });
  await page.locator('.ai-panel').getByRole('button', { name: 'この案にする', exact: true }).click();
  await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('25');
  expect(fixture.approvals).toBe(1);
  const exported = await record(page, info.outputPath('vertex-http-fixture-record.json'));
  expect(exported.records[0]!.execution).toEqual({ mode: 'injected-test', provider: 'vertex', model: 'vertex-http-fixture-model' });
  expect(exported.records[0]!.serverRun.provider).toBe('vertex');
  expect(exported.records[0]!.decision.adopted).toEqual({ designId: fixture.run!.proposal!.document.designId,
    revision: fixture.run!.proposal!.document.revision, designHash: fixture.run!.proposal!.document.designHash });
});

test('Vertex mock cancellation retains the source and the bodyless DELETE fix', async ({ page }, info) => {
  const fixture = new VertexHttpFixture(); fixture.statusMode = 'injected-test'; fixture.response = 'running';
  const settings = await prepare(page, fixture);
  await expect(settings).toContainText('接続方式：Vertex AI（模擬）');
  await settings.getByRole('button', { name: '閉じる', exact: true }).click();
  const beforeHash = await page.locator('main').getAttribute('data-design-hash');
  const beforeRevision = await page.locator('main').getAttribute('data-design-revision');
  await page.getByRole('button', { name: 'AIで案をつくる', exact: true }).click();
  await expect.poll(() => fixture.starts).toBe(1);
  await page.getByRole('button', { name: '中断する', exact: true }).click();
  await expect.poll(() => fixture.cancelHeaders).toBeTruthy();
  expect(fixture.cancelHeaders!['content-type']).toBeUndefined();
  expect(fixture.cancelHeaders!.authorization).toBe('Bearer vertex-fixture-token');
  expect(fixture.cancelHeaders!['x-ai-access']).toBe('vertex-fixture-access-not-a-real-secret');
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', beforeHash!);
  await expect(page.locator('main')).toHaveAttribute('data-design-revision', beforeRevision!);
  await expect(page.getByRole('status').filter({hasText: 'サーバーが中断要求を確認しました。別の依頼を実行できます。'})).toBeVisible();
  const exported = await record(page, info.outputPath('vertex-http-fixture-cancel.json'));
  expect(exported.records[0]!.execution.mode).toBe('injected-test');
  expect(exported.records[0]!.execution.provider).toBe('vertex');
  expect(exported.records[0]!.decision.status).toBe('cancelled');
  expect(exported.records[0]!.serverRun.status).toBe('cancelled');
  expect(exported.records[0]!.serverRun.dispatchClosed).toBe(true);
  expect(exported.records[0]!.serverRun.cancellation).toEqual(fixture.run!.cancellation);
  expect(JSON.stringify(exported)).not.toContain('fixture-private-field-must-not-be-exported');
  expect(fixture.starts).toBe(1);
});

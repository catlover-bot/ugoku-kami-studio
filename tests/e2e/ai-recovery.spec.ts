import { expect, test, type Page } from '@playwright/test';
import { applyDesignPatch, parseDesignDocument, type DesignDocument } from '@ugoku/core';
import type { AiRun } from '../../apps/web/src/aiEvidence';
import { ai, closeDialog, openRequest, saveProject, savedProject, startSample } from './helpers';

type LostCode = 'unauthorized' | 'not_found';
class RecoveryFixture {
  base!: DesignDocument;
  run!: AiRun;
  sessions = 0; starts = 0; polls = 0; approvals = 0;
  statusRequests = 0;
  statusOutcome: 'ready' | 'unavailable' = 'ready';
  startStatus: 'running' | 'awaiting_approval' = 'running';
  pollOutcome: LostCode | 'unavailable' | 'running' | 'proposal' = 'running';
  approvalError?: LostCode;
  requests: {requestId: string; prompt: string; baseHash: string; baseRevision: number}[] = [];
  async attach(page: Page) {
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname, method = route.request().method();
      const json = (data: unknown, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(data)});
      const lost = (code: LostCode) => json({error: {code, message: code === 'unauthorized' ? '作業セッションが無効です。再接続してください。' : '実行が見つかりません。'}}, code === 'unauthorized' ? 401 : 404);
      if (pathname === '/api/status') {
        this.statusRequests++;
        return this.statusOutcome === 'unavailable' ? json({error: {code: 'temporarily_unavailable', message: '起動待ちです。'}}, 503) : json({ai: {enabled: true, mode: 'injected-test', provider: 'ollama', model: 'offline-recovery-fixture'}});
      }
      if (pathname === '/api/sessions' && method === 'POST') {
        this.sessions++;
        this.base = parseDesignDocument(route.request().postDataJSON().document);
        return json({sessionId: `recovery-session-${this.sessions}`, token: 'test-only-recovery-token'}, 201);
      }
      if (pathname.endsWith('/document')) { this.base = parseDesignDocument(route.request().postDataJSON().document); return json({document: this.base}); }
      if (pathname.endsWith('/runs') && method === 'POST') {
        this.starts++; const body = route.request().postDataJSON(); this.requests.push(body);
        this.run = {id: `recovery-run-${this.starts}`, requestId: body.requestId, baseHash: body.baseHash, baseRevision: body.baseRevision, mode: 'injected-test', status: this.startStatus, message: '模擬通信の実行中です。実推論ではありません。', events: [], constraintSuggestions: [], modelCalls: 0, toolCalls: 0, elapsedMs: 0};
        if (this.startStatus === 'awaiting_approval') this.propose();
        return json({run: this.run}, 202);
      }
      if (pathname.includes('/runs/') && method === 'GET') {
        this.polls++;
        if (this.pollOutcome === 'unauthorized' || this.pollOutcome === 'not_found') return lost(this.pollOutcome);
        if (this.pollOutcome === 'unavailable') return json({error: {code: 'temporarily_unavailable', message: '一時的に応答できません。'}}, 503);
        if (this.pollOutcome === 'proposal') this.propose();
        return json({run: this.run});
      }
      if (pathname.endsWith('/approve')) {
        this.approvals++;
        return this.approvalError ? lost(this.approvalError) : json({document: this.run.proposal!.document});
      }
      if (method === 'DELETE') return json({run: {...this.run, status: 'cancelled', proposal: undefined}});
      return route.abort();
    });
  }
  propose() { this.run.status = 'awaiting_approval'; this.run.proposal = {id: `recovery-proposal-${this.starts}`, patch: {travelMm: 15}, document: applyDesignPatch(this.base, {travelMm: 15})}; }
}
const start = (page: Page) => page.getByRole('button', {name: 'AIで案をつくる', exact: true});
const accept = (page: Page) => page.locator('.ai-panel').getByRole('button', {name: 'この案にする', exact: true});
async function open(page: Page, fixture: RecoveryFixture) {
  await fixture.attach(page); await page.goto('/'); await startSample(page);
  const original = await saveProject(page);
  await ai(page); await page.getByLabel('AIアクセスコード').fill('test-only-code'); await closeDialog(page);
  await page.getByLabel('どう動かしたいですか？').fill('動く距離を15mmにしたい');
  await start(page).click();
  return original;
}
async function expectOriginal(page: Page, original: Awaited<ReturnType<typeof saveProject>>) {
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', original.document.designHash);
  await expect(page.locator('main')).toHaveAttribute('data-design-revision', String(original.document.revision));
  await expect(page.getByLabel('どう動かしたいですか？')).toHaveValue('動く距離を15mmにしたい');
  const saved = await savedProject(page);
  expect(saved.document).toEqual(original.document);
  expect(saved.imageDataUrl).toBe(original.imageDataUrl);
  expect(saved.records).toEqual(original.records);
}

test.describe('expired AI sessions: offline HTTP fixtures, no model or paid API', () => {
  test('initial status failure can be rechecked without starting inference or changing saved work', async ({page}, info) => {
    const fixture = new RecoveryFixture(); fixture.statusOutcome = 'unavailable';
    await fixture.attach(page); await page.goto('/'); await startSample(page);
    const original = await saveProject(page);
    await ai(page);
    await page.getByLabel('どう動かしたいですか？').fill('動く距離を15mmにしたい');
    await start(page).click();
    const recheck = page.getByRole('button', {name: '接続状態を再確認する', exact: true});
    await expect(recheck).toBeVisible();
    expect(fixture.statusRequests).toBe(1); expect(fixture.sessions).toBe(0); expect(fixture.starts).toBe(0);
    await expectOriginal(page, original);
    // Another failed read must remain retryable and never create a session.
    await recheck.click(); await expect(recheck).toBeEnabled();
    await expect(page.locator('.ai-panel')).toContainText('サーバーの状態を確認できません');
    expect(fixture.statusRequests).toBe(2); expect(fixture.sessions).toBe(0);
    fixture.statusOutcome = 'ready';
    await recheck.click();
    await expect(page.locator('.ai-panel')).toContainText('AIへの依頼はまだ送っていません');
    await expect(recheck).toHaveCount(0);
    await page.waitForTimeout(850);
    expect(fixture.statusRequests).toBe(3); expect(fixture.sessions).toBe(0); expect(fixture.starts).toBe(0);
    await expectOriginal(page, original);
    await page.screenshot({path: info.outputPath('status-recovered-before-explicit-start.png'), fullPage: true});
    await ai(page); await page.getByLabel('AIアクセスコード').fill('test-only-code'); await closeDialog(page);
    fixture.startStatus = 'awaiting_approval';
    await start(page).click(); await expect(accept(page)).toBeVisible();
    expect(fixture.sessions).toBe(1); expect(fixture.starts).toBe(1);
    expect(fixture.requests[0]!.baseHash).toBe(original.document.designHash);
    await expectOriginal(page, original);
  });

  for (const code of ['unauthorized', 'not_found'] as const) {
    test(`lost polling ${code} clears stale state and needs one explicit fresh request`, async ({page}, info) => {
      const fixture = new RecoveryFixture(); fixture.pollOutcome = code;
      const original = await open(page, fixture);
      await expect(page.locator('.ai-panel')).toContainText('サーバー側の作業が失効しました');
      await expect(page.getByRole('button', {name: '状況を確認する'})).toHaveCount(0);
      await expect(accept(page)).toHaveCount(0);
      await expectOriginal(page, original);
      await openRequest(page); await expect(start(page)).toBeEnabled();
      await page.waitForTimeout(850);
      expect(fixture.starts).toBe(1); expect(fixture.sessions).toBe(1); expect(fixture.polls).toBe(1);
      await page.screenshot({path: info.outputPath(`expired-poll-${code}.png`), fullPage: true});
      await page.getByRole('button', {name: '設定', exact: true}).click();
      await page.locator('.ai-evidence > summary').click();
      await expect(page.locator('.ai-evidence')).toContainText('サーバー側の作業が失効');
      await closeDialog(page);
      fixture.startStatus = 'awaiting_approval'; fixture.pollOutcome = 'proposal';
      await start(page).click(); await expect(accept(page)).toBeVisible();
      expect(fixture.sessions).toBe(2); expect(fixture.starts).toBe(2);
      expect(fixture.requests[1]!.requestId).not.toBe(fixture.requests[0]!.requestId);
      expect(fixture.requests[1]!.baseHash).toBe(original.document.designHash);
      await accept(page).click();
      await expect(page.locator('main')).toHaveAttribute('data-design-hash', applyDesignPatch(original.document, {travelMm: 15}).designHash);
    });

    test(`approval ${code} discards only the missing proposal and keeps saved artwork`, async ({page}, info) => {
      const fixture = new RecoveryFixture(); fixture.startStatus = 'awaiting_approval'; fixture.approvalError = code;
      const original = await open(page, fixture);
      await accept(page).click();
      await expect(page.locator('.ai-panel')).toContainText('サーバー側の作業が失効しました');
      await expect(accept(page)).toHaveCount(0);
      await expectOriginal(page, original);
      await openRequest(page); await expect(start(page)).toBeEnabled();
      await page.waitForTimeout(850); expect(fixture.starts).toBe(1); expect(fixture.approvals).toBe(1);
      await page.screenshot({path: info.outputPath(`expired-approval-${code}.png`), fullPage: true});
      fixture.approvalError = undefined;
      await start(page).click(); await accept(page).click();
      expect(fixture.sessions).toBe(2); expect(fixture.starts).toBe(2);
      await expect(page.locator('main')).toHaveAttribute('data-design-hash', fixture.run.proposal!.document.designHash);
    });
  }

  test('transient503 retains the same run for explicit status recovery, without another inference request', async ({page}) => {
    const fixture = new RecoveryFixture(); fixture.pollOutcome = 'unavailable';
    const original = await open(page, fixture);
    await expect(page.getByRole('button', {name: '状況を確認する'})).toBeVisible();
    await expect(page.locator('.ai-panel')).not.toContainText('作業が失効');
    await expectOriginal(page, original);
    await expect(start(page)).toBeDisabled();
    fixture.pollOutcome = 'proposal';
    await page.getByRole('button', {name: '状況を確認する'}).click(); await expect(accept(page)).toBeVisible();
    expect(fixture.sessions).toBe(1); expect(fixture.starts).toBe(1); expect(fixture.polls).toBe(2);
    await accept(page).click();
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', fixture.run.proposal!.document.designHash);
  });

  test('waiting shows measured elapsed seconds and cancellation while keeping original design', async ({page}, info) => {
    const fixture = new RecoveryFixture(), original = await open(page, fixture);
    await expect(page.locator('.ai-wait')).toContainText(/経過 \d+秒/);
    const seconds = async () => Number((await page.locator('.ai-wait').innerText()).match(/経過 (\d+)秒/)![1]);
    const initial = await seconds();
    await expect.poll(seconds, {timeout: 5000}).toBeGreaterThan(initial);
    await expect(page.getByRole('button', {name: '中断する', exact: true})).toBeVisible();
    await expectOriginal(page, original);
    await page.screenshot({path: info.outputPath('elapsed-wait.png'), fullPage: true});
    await page.getByRole('button', {name: '中断する', exact: true}).click();
    await expect(page.locator('.ai-wait')).toHaveCount(0);
    expect(fixture.starts).toBe(1);
  });
});

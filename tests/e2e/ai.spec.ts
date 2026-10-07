import { expect, test, type Page, type Route } from '@playwright/test';
import { applyDesignPatch, parseDesignDocument, type DesignDocument } from '@ugoku/core';
import { openRequest, editCurrentSettings, startSample, ai, precision, saveProject } from './helpers';

// HTTP fixtures are confined to this browser test. No key, SDK request or production fallback is used.
type RequestBody = { requestId: string; prompt: string; baseRevision: number; baseHash: string };
type FakeRun = {
  id: string; requestId: string; baseRevision: number; baseHash: string;
  status: 'running' | 'awaiting_approval' | 'failed' | 'cancelled' | 'succeeded';
  message: string; events: { tool: string; message: string }[];
  proposal?: { id: string; patch: { travelMm: number }; document: DesignDocument };
  error?: { code: string; message: string };
  constraintSuggestions: never[]; modelCalls: number; toolCalls: number; elapsedMs: number;
};
type Held = { route: Route; run: FakeRun };
class AiFixture {
  document?: DesignDocument;
  currentRun?: FakeRun;
  requests: RequestBody[] = [];
  approvals: Omit<RequestBody, 'prompt'>[] = [];
  rejects = 0;
  cancels = 0;
  sessions = 0;
  targetDistance = 15;
  mode: 'proposal' | 'running' | 'provider429' | 'http429' | 'html' = 'proposal';
  holdStart = false;
  holdPoll = false;
  holdApproval = false;
  holdCancel = false;
  pendingCancel?: Held;
  pendingStart?: Held;
  pendingPoll?: Held;
  pendingApproval?: { route: Route; document: DesignDocument };
  html = '<img src="missing" onerror="window.aiInjected=true"><script>window.aiInjected=true</script>';

  async attach(page: Page) {
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/status') return json({ ai: { enabled: true, mode: 'gemini', reason: 'テスト専用HTTP応答', sendsImage: false } });
      if (path === '/api/sessions') {
        this.document = parseDesignDocument((route.request().postDataJSON() as {document: unknown}).document);
        this.sessions++;
        return json({ sessionId: `fixture-session-${this.sessions}`, token: 'fixture-token', document: this.document }, 201);
      }
      if (path.endsWith('/document')) {
        const document = parseDesignDocument((route.request().postDataJSON() as {document: unknown}).document);
        if (this.document && (document.revision < this.document.revision || (document.revision === this.document.revision && document.designHash !== this.document.designHash))) return json({ error: { code: 'stale_design', message: '古い設計は反映できません。現在の設計で再接続してください。' } }, 409);
        this.document = document;
        return json({ document: this.document });
      }
      if (path.endsWith('/runs') && method === 'POST') {
        const body = route.request().postDataJSON() as RequestBody; this.requests.push(body);
        if (this.mode === 'http429') return json({ error: { code: 'instance_limit', message: '現在の実行上限です。時間をおいて再試行してください。' } }, 429);
        const run = this.makeRun(body); this.currentRun = run;
        if (this.holdStart) { this.pendingStart = { route, run }; return; }
        return json({ run }, 202);
      }
      if (path.includes('/runs/') && method === 'GET') {
        if (this.holdPoll) { this.pendingPoll = { route, run: this.currentRun! }; return; }
        return json({ run: this.currentRun });
      }
      if (path.includes('/runs/') && method === 'DELETE') {
        this.cancels++;
        const run = {...this.currentRun!, status: 'cancelled' as const, proposal: undefined};
        if (this.holdCancel) {this.pendingCancel = {route, run}; return;}
        return json({run});
      }
      if (path.endsWith('/approve')) {
        this.approvals.push(route.request().postDataJSON() as Omit<RequestBody, 'prompt'>);
        const document = this.currentRun!.proposal!.document;
        this.document = document; // The server can commit before its HTTP response reaches the browser.
        if (this.holdApproval) { this.pendingApproval = { route, document }; return; }
        return json({ document });
      }
      if (path.includes('/proposals/') && method === 'DELETE') { this.rejects++; return json({ run: { ...this.currentRun, status: 'cancelled', proposal: undefined } }); }
      return route.fallback();
    });
  }

  makeRun(body: RequestBody): FakeRun {
    const base: FakeRun = { id: `fixture-run-${this.requests.length}`, requestId: body.requestId, baseRevision: body.baseRevision, baseHash: body.baseHash, status: 'awaiting_approval', message: '数値を検査した変更案です。採用するまで設計は変わりません。', events: [{ tool: 'propose_design_patch', message: '候補を生成し検査しました。' }], constraintSuggestions: [], modelCalls: 2, toolCalls: 2, elapsedMs: 120 };
    base.proposal = { id: `fixture-proposal-${this.requests.length}`, patch: { travelMm: this.targetDistance }, document: applyDesignPatch(this.document!, { travelMm: this.targetDistance }) };
    if (this.mode === 'running') { base.status = 'running'; base.message = '設計条件を確認しています。'; delete base.proposal; }
    if (this.mode === 'provider429') { base.status = 'failed'; base.message = 'Geminiの利用上限に達しました。時間をおいて再試行してください。'; base.error = { code: 'provider_rate_limit', message: base.message }; delete base.proposal; }
    if (this.mode === 'html') { base.status = 'succeeded'; base.message = this.html; base.events[0]!.message = this.html; delete base.proposal; }
    return base;
  }

  async release(held: Held, status = held.run.status) {
    const run = { ...held.run, status };
    if (status === 'awaiting_approval' && !run.proposal) run.proposal = { id: 'late-proposal', patch: { travelMm: this.targetDistance }, document: applyDesignPatch(this.document!, { travelMm: this.targetDistance }) };
    await held.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run }) });
  }
}

async function open(page: Page, fixture: AiFixture) {
  await fixture.attach(page); await page.goto('/'); await startSample(page);
  await precision(page); await ai(page);
  await expect(page.locator('.ai-settings h3')).toHaveText('Gemini（設定済み）');
  await expect(page.getByLabel('動く距離（mm）', {exact:true})).toHaveValue('20');
  await page.getByLabel('AIアクセスコード').fill('test-only-access'); await page.getByRole('dialog', {name: '設定', exact: true}).getByRole('button', {name: '閉じる', exact: true}).click();
  await page.getByLabel('どう動かしたいですか？').fill('動く距離を15mmにしたい');
}

test.describe('AI panel — test-only HTTP fixtures, no live Gemini', () => {
  test('U6 Japanese composition Enter never submits an AI request', async ({ page }) => {
    const fixture = new AiFixture(); await open(page, fixture);
    const prompt = page.getByLabel('どう動かしたいですか？');
    await prompt.focus();
    await prompt.dispatchEvent('compositionstart', { data: '首' });
    await prompt.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    await prompt.dispatchEvent('compositionend', { data: '首' });
    await page.keyboard.press('Enter');
    expect(fixture.requests).toEqual([]);
    await openRequest(page);
    await expect(page.getByRole('button', { name: 'AIで案をつくる', exact: true })).toBeEnabled();
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる', exact: true }).click();
    await expect.poll(() => fixture.requests.length).toBe(1);
    await expect(page.locator('.ai-panel').getByRole('button', { name: 'この案にする', exact: true })).toBeVisible();
  });

  test('a cancelled late session cannot replace the session of a new proposal', async ({ page }) => {
    let sessionCount = 0;
    let firstSession: Route | undefined;
    let proposalDocument: DesignDocument | undefined;
    let approvalSession = '';
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/status') return json({ ai: { enabled: true, mode: 'gemini' } });
      if (path === '/api/sessions') {
        sessionCount++;
        if (sessionCount === 1) { firstSession = route; return; }
        const base = parseDesignDocument((route.request().postDataJSON() as { document: unknown }).document);
        proposalDocument = applyDesignPatch(base, { travelMm: 15 });
        return json({ sessionId: 'active-session-B', token: 'fixture-token-B' }, 201);
      }
      if (path.endsWith('/runs') && route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as RequestBody;
        return json({ run: {
          id: 'run-B', requestId: body.requestId, baseRevision: body.baseRevision, baseHash: body.baseHash,
          status: 'awaiting_approval', message: '後から開始した実行の変更案です。', events: [],
          proposal: { id: 'proposal-B', patch: { travelMm: 15 }, document: proposalDocument },
          constraintSuggestions: [], modelCalls: 2, toolCalls: 1, elapsedMs: 10,
        } }, 202);
      }
      if (path.endsWith('/approve')) {
        approvalSession = path.split('/')[3]!;
        if (approvalSession !== 'active-session-B') return json({ error: { message: '変更案のセッションが違います。' } }, 409);
        return json({ document: proposalDocument });
      }
      return route.fallback();
    });
    await page.goto('/'); await startSample(page);
    await precision(page); await ai(page);
    await page.getByLabel('AIアクセスコード').fill('test-only-access'); await page.getByRole('dialog', {name: '設定', exact: true}).getByRole('button', {name: '閉じる', exact: true}).click();
    await page.getByLabel('どう動かしたいですか？').fill('動く距離を15mmにしたい');
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる', exact: true }).click();
    await expect.poll(() => !!firstSession).toBe(true);
    await page.getByRole('button', { name: '中断する', exact: true }).click();
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'AIの変更案 · 採用待ち', exact: true })).toBeVisible();
    const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions');
    await firstSession!.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ sessionId: 'obsolete-session-A', token: 'fixture-token-A' }) });
    await oldResponse;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.locator('.ai-panel').getByRole('button', { name: 'この案にする', exact: true }).click();
    await expect(page.getByLabel('動く距離（mm）', { exact: true })).toHaveValue('15');
    expect(approvalSession).toBe('active-session-B');
    expect(sessionCount).toBe(2);
  });

  test('proposal stays separate until accept; reject preserves the current design', async ({ page }) => {
    const fixture = new AiFixture(); await open(page, fixture);
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる' }).click();
    await expect(page.getByRole('heading', { name: '変更案 · 採用待ち' })).toBeVisible();
    await expect(page.getByLabel('動く距離（mm）', {exact:true})).toHaveValue('20');
    await page.locator('.ai-panel').getByRole('button', { name: 'この案にする', exact: true }).click();
    await expect(page.getByLabel('動く距離（mm）', {exact:true})).toHaveValue('15');
    expect(fixture.approvals).toEqual([{ requestId: fixture.requests[0]!.requestId, baseRevision: fixture.requests[0]!.baseRevision, baseHash: fixture.requests[0]!.baseHash }]);
    await expect(page.getByRole('button', { name: '変更前と比較' })).toBeEnabled();
    fixture.targetDistance = 12;
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる' }).click();
    await expect(page.getByRole('heading', { name: '変更案 · 採用待ち' })).toBeVisible();
    await page.locator('.ai-panel').getByRole('button', { name: 'この案を使わない', exact: true }).click();
    await expect(page.getByText('変更案を却下しました。設計は変わりません。')).toBeVisible();
    await expect(page.getByLabel('動く距離（mm）', {exact:true})).toHaveValue('15');
    expect(fixture.rejects).toBe(1);
  });

  test('a late proposal cannot revive after edit and undo with the same hash but newer revision', async ({ page }) => {
    const fixture = new AiFixture(); fixture.holdStart = true; await open(page, fixture);
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる' }).click();
    await expect.poll(() => Boolean(fixture.pendingStart)).toBe(true);
    const original = fixture.requests[0]!;
    await editCurrentSettings(page);
    await page.getByLabel('動く距離（mm）', {exact:true}).fill('18'); await page.getByLabel('動く距離（mm）', {exact:true}).press('Enter');
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await expect(page.getByLabel('動く距離（mm）', {exact:true})).toHaveValue('20');
    await fixture.release(fixture.pendingStart!);
    await openRequest(page);
    await expect(page.getByRole('button', { name: 'AIで案をつくる' })).toBeEnabled();
    await expect(page.getByRole('heading', { name: '変更案 · 採用待ち' })).toHaveCount(0);
    fixture.holdStart = false;
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる' }).click();
    await expect.poll(() => fixture.requests.length).toBe(2);
    expect(fixture.requests[1]!.baseHash).toBe(original.baseHash);
    expect(fixture.requests[1]!.baseRevision).toBeGreaterThan(original.baseRevision);
  });

  test('a late approval cannot replace newer edits even when undo restores the original hash', async ({ page }) => {
    const fixture = new AiFixture(); fixture.holdApproval = true; await open(page, fixture);
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる' }).click();
    await page.locator('.ai-panel').getByRole('button', { name: 'この案にする', exact: true }).click();
    await expect.poll(() => Boolean(fixture.pendingApproval)).toBe(true);
    await editCurrentSettings(page);
    await page.getByLabel('動く距離（mm）', {exact:true}).fill('18'); await page.getByLabel('動く距離（mm）', {exact:true}).press('Enter');
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await fixture.pendingApproval!.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ document: fixture.pendingApproval!.document }) });
    await openRequest(page);
    await expect(page.getByRole('button', { name: 'AIで案をつくる' })).toBeEnabled();
    await expect(page.getByLabel('動く距離（mm）', {exact:true})).toHaveValue('20');
    await expect(page.getByRole('heading', { name: '変更案 · 採用待ち' })).toHaveCount(0);
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる' }).click();
    await expect.poll(() => fixture.requests.length).toBe(2);
    expect(fixture.requests[1]!.baseHash).toBe(fixture.requests[0]!.baseHash);
    expect(fixture.requests[1]!.baseRevision).toBe(fixture.requests[0]!.baseRevision + 2);
  });

  test('provider 429 and HTTP 429 preserve manual editing and permit explicit retry', async ({ page }, info) => {
    const fixture = new AiFixture(); fixture.mode = 'provider429'; await open(page, fixture);
    const original = await saveProject(page);
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる' }).click();
    await expect(page.getByText('Geminiの利用上限に達しました。時間をおいて再試行してください。')).toBeVisible();
    await expect(page.getByLabel('動く距離（mm）', {exact:true})).toBeEnabled();
    fixture.mode = 'http429';
    await openRequest(page);
    await page.getByRole('button', { name: 'AIを再試行する', exact: true }).click();
    await expect(page.getByText('AIへの依頼が続いています。時間をおいて再度お試しください。作品は変更していません。')).toBeVisible();
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', original.document.designHash);
    await expect(page.locator('main')).toHaveAttribute('data-design-revision', String(original.document.revision));
    await expect(page.getByRole('button', {name: 'この案にする', exact: true})).toHaveCount(0);
    await page.locator('.ai-panel').screenshot({path:info.outputPath('rate-limit.png')});
    await page.getByRole('button', {name: '手動の調整に戻る', exact: true}).click();
    const distance = page.getByLabel('動く距離（mm）', {exact:true});
    await distance.fill('18'); await distance.press('Enter');
    await page.getByRole('button', {name: '元に戻す', exact:true}).click();
    const restored = await saveProject(page);
    expect(restored.document.designHash).toBe(original.document.designHash);
    expect(restored.document.revision).toBeGreaterThan(original.document.revision);
    expect(restored.document.input.locks).toEqual(original.document.input.locks);
    expect(fixture.requests).toHaveLength(2); // Manual recovery never retries AI.
    fixture.mode = 'proposal';
    await openRequest(page);
    await page.getByRole('button', { name: /AIで案をつくる|AIを再試行する/ }).click();
    await expect(page.getByRole('heading', { name: '変更案 · 採用待ち' })).toBeVisible();
    await expect(page.getByLabel('動く距離（mm）', {exact:true})).toHaveValue('20');
    expect(fixture.requests).toHaveLength(3);
  });

  test('manual edit during approval keeps its value and reconnects after server revision diverges', async ({ page }) => {
    const fixture = new AiFixture(); fixture.holdApproval = true; await open(page, fixture);
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる' }).click();
    await page.locator('.ai-panel').getByRole('button', { name: 'この案にする', exact: true }).click();
    await expect.poll(() => Boolean(fixture.pendingApproval)).toBe(true);
    await editCurrentSettings(page);
    await page.getByLabel('動く距離（mm）', {exact:true}).fill('18'); await page.getByLabel('動く距離（mm）', {exact:true}).press('Enter');
    await fixture.pendingApproval!.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ document: fixture.pendingApproval!.document }) });
    await openRequest(page);
    await expect(page.getByRole('button', { name: 'AIで案をつくる' })).toBeEnabled();
    await expect(page.getByLabel('動く距離（mm）', {exact:true})).toHaveValue('18');
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる' }).click();
    await expect.poll(() => fixture.requests.length).toBe(2);
    expect(fixture.sessions).toBe(2);
    await expect(page.getByRole('heading', { name: '変更案 · 採用待ち' })).toBeVisible();
    await expect(page.getByLabel('動く距離（mm）', {exact:true})).toHaveValue('18');
  });

  test('cancel confirmation blocks a new request while manual edits remain usable', async ({ page }, info) => {
    const fixture = new AiFixture(); fixture.mode = 'running'; fixture.holdCancel = true;
    await open(page, fixture); await openRequest(page);
    await page.getByRole('button', {name: 'AIで案をつくる', exact: true}).click();
    await expect(page.getByRole('button', {name: '中断する', exact: true})).toBeVisible();
    await page.getByRole('button', {name: '中断する', exact: true}).click();
    await expect.poll(() => Boolean(fixture.pendingCancel)).toBe(true);
    await expect(page.getByRole('status').filter({hasText: '中断を要求しています。'})).toBeVisible();
    await openRequest(page);
    await expect(page.getByRole('button', {name: '中断要求を確認中…', exact: true})).toBeDisabled();
    await page.screenshot({path: info.outputPath('cancel-pending.png')});
    await editCurrentSettings(page);
    const distance = page.getByLabel('動く距離（mm）', {exact: true});
    await distance.fill('18'); await distance.press('Enter');
    await expect(distance).toHaveValue('18');
    expect(fixture.requests).toHaveLength(1);
    await fixture.release(fixture.pendingCancel!, 'cancelled');
    await openRequest(page);
    await expect(page.getByRole('button', {name: 'AIで案をつくる', exact: true})).toBeEnabled();
    fixture.mode = 'proposal';
    await page.getByLabel('どう動かしたいですか？', {exact: true}).fill('動く距離を15mmにしてください');
    await page.getByRole('button', {name: 'AIで案をつくる', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'AIの変更案 · 採用待ち', exact: true})).toBeVisible();
    await expect(distance).toHaveValue('18');
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]!.baseHash).toBe(fixture.document!.designHash);
    await page.screenshot({path: info.outputPath('cancel-recovered.png')});
    expect(fixture.cancels).toBe(1);
  });

  test('cancel dismisses a running request and ignores a late poll result', async ({ page }) => {
    const fixture = new AiFixture(); fixture.mode = 'running'; fixture.holdPoll = true; await open(page, fixture);
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる' }).click();
    await expect.poll(() => Boolean(fixture.pendingPoll)).toBe(true);
    await page.getByRole('button', { name: '中断する', exact: true }).click();
    await expect(page.getByText(/中断しました。届いた結果/)).toBeVisible();
    await fixture.release(fixture.pendingPoll!, 'awaiting_approval');
    await openRequest(page);
    await expect(page.getByRole('button', { name: 'AIで案をつくる' })).toBeEnabled();
    await expect(page.getByRole('heading', { name: '変更案 · 採用待ち' })).toHaveCount(0);
    await page.getByLabel('動く距離（mm）', {exact:true}).fill('16'); await page.getByLabel('動く距離（mm）', {exact:true}).press('Enter');
    await expect(page.getByLabel('動く距離（mm）', {exact:true})).toHaveValue('16');
    expect(fixture.cancels).toBe(1);
  });

  test('model text and tool log HTML are displayed literally and do not create elements', async ({ page }) => {
    const fixture = new AiFixture(); fixture.mode = 'html'; await open(page, fixture);
    await openRequest(page);
    await page.getByRole('button', { name: 'AIで案をつくる' }).click();
    await expect(page.getByText(fixture.html, { exact: true })).toBeVisible();
    await page.getByRole('button',{name:'設定',exact:true}).click();
    await page.getByText('実際の操作ログ（2回）', { exact: true }).click();
    await expect(page.locator('.execution-log')).toContainText(fixture.html);
    await expect(page.locator('.ai-panel img, .ai-panel script')).toHaveCount(0);
    expect(await page.evaluate(() => 'aiInjected' in window)).toBe(false);
  });
});

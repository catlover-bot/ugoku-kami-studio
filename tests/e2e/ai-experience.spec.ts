import { expect, test, type Page, type Route } from '@playwright/test';
import { applyDesignPatch, parseDesignDocument, type DesignDocument } from '@ugoku/core';
import { ai, manual, savedWorkspace, stage, startSample } from './helpers';

// These HTTP fixtures exercise the real product UI, shared request state and
// IndexedDB autosave. They never create an SDK client or use a paid API.
const ACCESS = 'synthetic-ai-experience-access';
const AI_PROMPT = 'どんな動きにしたいですか？';
const MANUAL_PROMPT = 'どう動かしたいですか？';
const requestButton = (page: Page) => page.locator('.ai-panel').getByRole('button', { name: '変更案をつくる', exact: true });
const acceptButton = (page: Page) => page.locator('.ai-panel').getByRole('button', { name: 'この案にする', exact: true });

async function openPanel(page: Page) {
  await page.goto('/');
  await startSample(page);
  await stage(page, 2);
  await page.getByRole('button', { name: 'Gemini', exact: true }).click();
}

class SharedRequestFixture {
  starts = 0;
  cancels = 0;
  sessions = 0;
  holdRun = false;
  holdApproval = false;
  heldRun?: Route;
  heldApproval?: Route;
  base!: DesignDocument;
  candidate!: DesignDocument;
  run: Record<string, unknown> = {};

  async attach(page: Page) {
    await page.route('**/api/**', async route => {
      const method = route.request().method();
      const path = new URL(route.request().url()).pathname;
      const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (path === '/api/status') return json({ ai: { enabled: true, mode: 'injected-test' } });
      if (path === '/api/sessions' && method === 'POST') {
        this.base = parseDesignDocument(route.request().postDataJSON().document);
        this.sessions++;
        return json({ sessionId: `session-${this.sessions}`, token: 'synthetic-session-token' }, 201);
      }
      if (path.endsWith('/document') && method === 'PUT') {
        this.base = parseDesignDocument(route.request().postDataJSON().document);
        return json({ document: this.base });
      }
      if (path.endsWith('/runs') && method === 'POST') {
        this.starts++;
        const body = route.request().postDataJSON() as { prompt: string; requestId: string };
        this.candidate = applyDesignPatch(this.base, { travelMm: Number(/(\d+)mm/.exec(body.prompt)?.[1] ?? 15) });
        this.run = {
          id: `run-${this.starts}`, requestId: body.requestId, baseRevision: this.base.revision, baseHash: this.base.designHash,
          mode: 'injected-test', model: 'fixture', status: 'awaiting_approval', message: '寸法を検査した模擬候補です。',
          events: [], constraintSuggestions: [], modelCalls: 1, toolCalls: 1, elapsedMs: 20,
          proposal: { id: `proposal-${this.starts}`, patch: { travelMm: this.candidate.input.travelMm }, document: this.candidate },
        };
        if (this.holdRun) { this.heldRun = route; return; }
        return json({ run: this.run }, 202);
      }
      if (path.endsWith('/approve') && method === 'POST') {
        if (this.holdApproval) { this.heldApproval = route; return; }
        return json({ document: this.candidate });
      }
      if (path.includes('/runs/') && method === 'DELETE') {
        this.cancels++;
        return json({ run: { ...this.run, status: 'cancelled', proposal: undefined } });
      }
      return json({ error: 'Unexpected endpoint in the offline browser fixture' }, 500);
    });
  }
}

async function openFixture(page: Page, fixture: SharedRequestFixture) {
  await fixture.attach(page);
  await openPanel(page);
  await expect(page.getByText('模擬接続（テスト）', { exact: true })).toBeVisible();
  await ai(page);
  await page.getByLabel('AIアクセスコード').fill(ACCESS);
  await page.getByLabel(AI_PROMPT).fill('動く距離を15mmにしたい');
}

async function editManualRequest(page: Page, value: string) {
  await manual(page);
  await page.getByLabel(MANUAL_PROMPT).fill(value);
}

test.describe('Goal005 AI experience — offline HTTP fixtures', () => {
  test('unconnected guidance is user-facing and trusted conditions remain visible without opening settings', async ({ page }, info) => {
    await page.route('**/api/status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ai: { enabled: false, mode: 'manual', reason: 'AI_ENABLED=false; GEMINI_API_KEY is absent; deploy the server' } }) }));
    await openPanel(page);
    await expect(page.getByText('AI未接続', { exact: true })).toBeVisible();
    await expect(page.locator('.ai-settings')).not.toHaveAttribute('open', '');
    const panel = page.locator('.ai-panel');
    await expect(panel.getByRole('heading', { name: '今回守る条件' })).toBeVisible();
    await page.getByLabel(AI_PROMPT).fill('もう少し大きく動かしたい');
    await expect(panel.locator('.ai-request-conditions')).toContainText('型紙はA4で2枚まで');
    await expect(panel.getByRole('button', { name: '手動支援を使う', exact: true })).toBeVisible();
    expect(await panel.innerText()).not.toMatch(/AI_ENABLED|GEMINI_API_KEY|deploy/);
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 800 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test('access code and model details are secondary and configured status does not claim a tested live connection', async ({ page }) => {
    await page.route('**/api/status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ai: { enabled: true, mode: 'gemini', model: 'gemini-model-for-local-ui-fixture' } }) }));
    await openPanel(page);
    await expect(page.getByText('Gemini設定済み', { exact: true })).toBeVisible();
    await expect(page.getByLabel('AIアクセスコード')).toBeHidden();
    await expect(page.locator('.ai-panel').getByText('gemini-model-for-local-ui-fixture', { exact: false })).toBeHidden();
    await page.locator('.ai-settings > summary').click();
    await expect(page.getByLabel('AIアクセスコード')).toHaveAttribute('type', 'password');
    await expect(page.locator('.ai-settings')).toContainText('設定済みの表示だけでは、接続の成功は確認できません');
    await page.getByLabel('AIアクセスコード').fill(ACCESS);
    await page.locator('.ai-settings > summary').click();
    await expect(page.getByLabel('AIアクセスコード')).toBeHidden();
    await expect(requestButton(page)).toBeVisible();
  });

  test('missing access and a real numeric draft block requests; IME does not submit and autosave excludes the secret', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/**', route => {
      if (new URL(route.request().url()).pathname === '/api/status') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ai: { enabled: true, mode: 'injected-test' } }) });
      calls++;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected request in presentation fixture' }) });
    });
    await openPanel(page);
    await expect(page.getByText('模擬接続（テスト）', { exact: true })).toBeVisible();
    await requestButton(page).click();
    await expect(page.locator('.ai-panel').getByRole('status')).toContainText('アクセスコードを入力');
    expect(calls).toBe(0);
    await page.locator('.ai-settings > summary').click();
    await expect(page.locator('.ai-settings')).toContainText('実Geminiには送信しません');
    await page.getByLabel('AIアクセスコード').fill(ACCESS);
    const distance = page.getByRole('textbox', { name: '動く距離（mm）', exact: true });
    await distance.fill('');
    await expect(requestButton(page)).toBeDisabled();
    await distance.press('Escape');
    await expect(distance).toHaveValue('20');
    await expect(requestButton(page)).toBeEnabled();
    const prompt = page.getByLabel(AI_PROMPT);
    await prompt.fill('動く距離を15mmにしたい');
    await prompt.dispatchEvent('compositionstart', { data: '首' });
    await prompt.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
    await prompt.dispatchEvent('compositionend', { data: '首' });
    await expect(page.locator('main')).toHaveAttribute('data-save-status', 'saved');
    const persisted = await savedWorkspace(page);
    expect(persisted.draft?.requestText).toBe('動く距離を15mmにしたい');
    expect(JSON.stringify(persisted)).not.toContain(ACCESS);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(ACCESS);
    expect(calls).toBe(0);
  });

  test('manual and AI share one request and each edit invalidates the old proposal once without rerunning', async ({ page }) => {
    const fixture = new SharedRequestFixture();
    await openFixture(page, fixture);
    const originalHash = await page.locator('main').getAttribute('data-design-hash');
    await requestButton(page).click();
    await expect(acceptButton(page)).toBeVisible();
    await editManualRequest(page, '動く距離を18mmにしたい');
    await ai(page);
    await expect(acceptButton(page)).toHaveCount(0);
    await expect(page.getByLabel(AI_PROMPT)).toHaveValue('動く距離を18mmにしたい');
    await expect.poll(() => fixture.cancels).toBe(1);
    expect(fixture.starts).toBe(1);
    await requestButton(page).click();
    await expect(acceptButton(page)).toBeVisible();
    await page.locator('.ai-panel > .request-editor > summary').click();
    await page.getByLabel(AI_PROMPT).fill('動く距離を16mmにしたい');
    await manual(page);
    await expect(page.getByLabel(MANUAL_PROMPT)).toHaveValue('動く距離を16mmにしたい');
    await expect.poll(() => fixture.cancels).toBe(2);
    await expect(page.locator('main')).toHaveAttribute('data-save-status', 'saved');
    expect((await savedWorkspace(page)).draft?.requestText).toBe('動く距離を16mmにしたい');
    expect(fixture.cancels).toBe(2);
    expect(fixture.starts).toBe(2);
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', originalHash!);
  });

  test('a held run response after editing the shared manual request stays stale and cannot revive a candidate', async ({ page }) => {
    const fixture = new SharedRequestFixture(); fixture.holdRun = true;
    await openFixture(page, fixture);
    const originalHash = await page.locator('main').getAttribute('data-design-hash');
    await requestButton(page).click();
    await expect.poll(() => !!fixture.heldRun).toBe(true);
    await editManualRequest(page, '動く距離を18mmにしたい');
    await fixture.heldRun!.fulfill({ contentType: 'application/json', body: JSON.stringify({ run: fixture.run }) });
    await expect.poll(() => fixture.cancels).toBe(1);
    await ai(page);
    await expect(acceptButton(page)).toHaveCount(0);
    await page.locator('.ai-evidence > summary').click();
    await expect(page.locator('.ai-evidence')).toContainText('依頼・設計が変わったため無効');
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', originalHash!);
    expect(fixture.starts).toBe(1);
  });

  test('editing the shared manual request during approval ignores the old design and starts a new session', async ({ page }) => {
    const fixture = new SharedRequestFixture(); fixture.holdApproval = true;
    await openFixture(page, fixture);
    const originalHash = await page.locator('main').getAttribute('data-design-hash');
    await requestButton(page).click();
    await acceptButton(page).click();
    await expect.poll(() => !!fixture.heldApproval).toBe(true);
    await editManualRequest(page, '動く距離を18mmにしたい');
    const approvedResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/approve'));
    await fixture.heldApproval!.fulfill({ contentType: 'application/json', body: JSON.stringify({ document: fixture.candidate }) });
    await approvedResponse;
    await ai(page);
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', originalHash!);
    await expect(requestButton(page)).toBeEnabled();
    fixture.holdApproval = false;
    await requestButton(page).click();
    await expect.poll(() => fixture.sessions).toBe(2);
    await acceptButton(page).click();
    await expect(page.getByRole('textbox', { name: '動く距離（mm）', exact: true })).toHaveValue('18');
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', fixture.candidate.designHash);
  });
});

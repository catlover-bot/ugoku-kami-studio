import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { applyDesignPatch, parseDesignDocument, type DesignDocument } from '@ugoku/core';
import { openRequest, startSample, ai, physical, saveProject, stage } from './helpers';

// Every AI response in this file is a labelled HTTP fixture. No live provider is contacted.
class OfflineAi {
  base!: DesignDocument;
  current: Record<string, unknown> = {};
  held?: Route;
  starts = 0;
  gets = 0;
  cancels = 0;
  mode: 'held' | 'poll-failure' | 'proposal' | 'failure' | 'running' = 'proposal';
  async attach(page: Page) {
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname, method = route.request().method();
      const json = (value: unknown, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(value)});
      if (path === '/api/status') return json({ai: {enabled: true, mode: 'injected-test', model: 'offline-fixture-model', reason: 'HTTP模擬応答のみ'}});
      if (path === '/api/sessions') {this.base = parseDesignDocument(route.request().postDataJSON().document); return json({sessionId: 'offline-session', token: 'private-fixture-session-token'});}
      if (path.endsWith('/document')) {this.base = parseDesignDocument(route.request().postDataJSON().document); return json({document: this.base});}
      if (path.endsWith('/runs') && method === 'POST') {
        this.starts++;
        const body = route.request().postDataJSON();
        // Goal006 sends requests through the normal server interpretation path.
        // This HTTP fixture models its definite unsupported response; real
        // RunManager + zero provider dispatch is covered by live-workflow.spec.
        if (body.prompt === '回転させたい') return json({error: {code: 'unsupported_motion', message: 'その動きは未対応です。直線運動1か所に対応しています。'}}, 422);
        const candidate = applyDesignPatch(this.base, {travelMm: 15});
        this.current = {id: `offline-run-${this.starts}`, requestId: body.requestId, baseHash: this.base.designHash, baseRevision: this.base.revision, mode: 'injected-test', model: 'offline-fixture-model', status: 'awaiting_approval', message: '模擬応答：実API・実物確認ではありません。', events: [{sequence: 1, type: 'tool', tool: 'propose_design_patch', message: 'HTTPフィクスチャの候補', designHash: candidate.designHash, patch: {travelMm: 15}, checkStatuses: candidate.checks.map(({id,status}) => ({id,status})), durationMs: 0}], constraintSuggestions: [], validationIssues: [], modelCalls: 1, toolCalls: 1, elapsedMs: 30, usage: {promptTokens: 100, outputTokens: 20, totalTokens: 120, responsesWithUsage: 1, responsesWithoutUsage: 0}, modelUsage: [{call: 1, inputBytes: 100, outputTokenLimit: 1000, durationMs: 30, received: true, finishReason: 'STOP', modelVersion: 'offline-fixture-model', usage: {promptTokens: 100, outputTokens: 20, thinkingTokens: 0, cachedInputTokens: 0, toolPromptTokens: 0, totalTokens: 120}}], proposal: {id: `offline-proposal-${this.starts}`, patch: {travelMm: 15}, document: candidate}};
        if (this.mode === 'held') {this.held = route; return;}
        if (this.mode === 'poll-failure' || this.mode === 'running') return json({run: {...this.current, status: 'running', proposal: undefined}});
        if (this.mode === 'failure') {this.current = {...this.current, status: 'failed', proposal: undefined, error: {code: 'provider_rate_limit', message: '模擬応答：利用上限に達しました。時間をおいて再試行してください。'}, usage: {promptTokens: 0, outputTokens: 0, totalTokens: 0, responsesWithUsage: 0, responsesWithoutUsage: 1}, modelUsage: [{call: 1, inputBytes: 100, outputTokenLimit: 1000, durationMs: 30, received: false, finishReason: null, modelVersion: null, usage: null}]};}
        return json({run: this.current});
      }
      if (path.includes('/runs/') && method === 'GET') {this.gets++; if (this.mode === 'poll-failure' && this.gets === 1) return json({error: {message: '模擬応答：接続を一時的に確認できません。'}}, 503); return json({run: this.mode === 'running' ? {...this.current, status: 'running', proposal: undefined} : this.current});}
      if (path.includes('/runs/') && method === 'DELETE') {this.cancels++; this.current = {...this.current, status: 'cancelled', proposal: undefined}; return json({run: this.current});}
      if (path.endsWith('/approve')) return json({document: (this.current.proposal as {document: DesignDocument}).document});
      if (path.includes('/proposals/') && method === 'DELETE') {this.current = {...this.current, status: 'cancelled', proposal: undefined}; return json({run: this.current});}
      return route.fallback();
    });
  }
}
async function openAi(page: Page, fixture: OfflineAi) {
  await fixture.attach(page); await page.goto('/'); await startSample(page); await page.locator('.artwork-stage .artwork-svg').waitFor(); await ai(page);
  await expect(page.getByRole('dialog', { name: '設定', exact: true }).getByRole('heading', { name: '模擬AI（テスト）', exact: true })).toBeVisible();
  await page.getByLabel('AIアクセスコード').fill('private-fixture-access-code'); await page.getByRole('dialog', {name: '設定', exact: true}).getByRole('button', {name: '閉じる', exact: true}).click();
  await page.getByLabel('どう動かしたいですか？').fill('動く距離を15mmにしたい');
}
async function recordDownload(page: Page) {
  await page.getByRole('button',{name:'設定',exact:true}).click();
  const section = page.locator('.ai-evidence');
  if (!(await section.evaluate(element => (element as HTMLDetailsElement).open))) await section.locator('summary').click();
  const pending = page.waitForEvent('download'); await page.getByRole('button', {name: 'AI実行記録を書き出す', exact: true}).click();
  const download = await pending, text = await readFile((await download.path())!, 'utf8');
  expect(text).not.toContain('private-fixture-session-token'); expect(text).not.toContain('private-fixture-access-code'); expect(text).not.toContain('data:image/');
  await page.getByRole('dialog',{name:'設定',exact:true}).getByRole('button',{name:'閉じる',exact:true}).click();
  return JSON.parse(text);
}
const mainHash = (page: Page) => page.locator('main').getAttribute('data-design-hash');

test('G4 edited request invalidates a late proposal and retains honest stale evidence', async ({page}) => {
  const fixture = new OfflineAi(); fixture.mode = 'held'; await openAi(page, fixture);
  const before = await mainHash(page);
  await page.getByRole('button', {name: 'AIで案をつくる', exact: true}).click();
  await expect.poll(() => !!fixture.held).toBe(true);
  await page.getByLabel('どう動かしたいですか？').fill('回転させたい');
  await fixture.held!.fulfill({contentType: 'application/json', body: JSON.stringify({run: fixture.current})});
  await expect(page.locator('.ai-evidence')).toHaveCount(1);
  await expect(page.locator('.ai-panel').getByRole('button', {name: 'この案にする', exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: 'AIで案をつくる', exact: true}).click();
  await expect(page.locator('.ai-panel').getByRole('status')).toContainText('その動きは未対応');
  expect(fixture.starts).toBe(2); expect(await mainHash(page)).toBe(before);
  const exported = await recordDownload(page);
  expect(exported.format).toBe('ugoku-kami-ai-run'); expect(exported.records).toHaveLength(1);
  expect(exported.records[0].execution.mode).toBe('injected-test'); expect(exported.records[0].decision.status).toBe('stale');
  expect(exported.records[0].base.designHash).toBe(before); expect(exported.records[0].proposed.changes[0].after).toBe('15mm');
});

test('G4 interrupted polling resumes the same run and exports its adopted version', async ({page}) => {
  const fixture = new OfflineAi(); fixture.mode = 'poll-failure'; await openAi(page, fixture);
  const before = await mainHash(page);
  await page.getByRole('button', {name: 'AIで案をつくる', exact: true}).click();
  await expect(page.getByRole('button', {name: '状況を確認する', exact: true})).toBeVisible();
  expect(await mainHash(page)).toBe(before); expect(fixture.starts).toBe(1);
  await page.getByRole('button', {name: '状況を確認する', exact: true}).click();
  await page.locator('.ai-panel').getByRole('button', {name: 'この案にする', exact: true}).click();
  await expect.poll(() => mainHash(page)).not.toBe(before);
  const exported = await recordDownload(page), item = exported.records[0];
  expect(fixture.starts).toBe(1); expect(fixture.gets).toBe(2);
  expect(item.decision.status).toBe('accepted'); expect(item.decision.adopted.designHash).toBe(await mainHash(page));
  expect(item.proposed.designHash).toBe(item.decision.adopted.designHash);
  expect(item.serverRun.events[0].checkStatuses.length).toBeGreaterThan(0); expect(item.serverRun.modelUsage[0].usage.totalTokens).toBe(120);
  await stage(page, 3); await expect(page.getByRole('button', {name: 'PDFをダウンロード', exact: true})).toBeEnabled();
  await expect(page.getByLabel('PDFに含める内容', { exact: true })).toHaveValue('all');
  await expect(page.locator('.kit-download')).toContainText('PDF 5ページ');
  expect(await mainHash(page)).toBe(item.decision.adopted.designHash);
});

test('G4 rejection, failure and cancellation retain separate evidence without charging claims', async ({page}) => {
  const fixture = new OfflineAi(); await openAi(page, fixture); const before = await mainHash(page);
  await page.getByRole('button', {name: 'AIで案をつくる', exact: true}).click();
  await page.locator('.ai-panel').getByRole('button', {name: 'この案を使わない', exact: true}).click();
  fixture.mode = 'failure'; await openRequest(page); await page.getByRole('button', {name: 'AIで案をつくる', exact: true}).click();
  await expect(page.getByRole('button', {name: 'AIを再試行する', exact: true})).toBeVisible();
  fixture.mode = 'running'; await page.getByRole('button', {name: 'AIを再試行する', exact: true}).click();
  await expect.poll(() => fixture.starts).toBe(3);
  await page.getByRole('button', {name: '中断する', exact: true}).click();
  const exported = await recordDownload(page);
  expect(exported.records.map((item: {decision: {status: string}}) => item.decision.status)).toEqual(['rejected', 'failed', 'cancelled']);
  expect(exported.records[0].proposed.designHash).toBeTruthy(); expect(exported.records[1].serverRun.modelUsage[0].usage).toBeNull();
  const failedEntry = page.locator('.ai-evidence li').filter({hasText: 'offline-run-2'});
  await expect(failedEntry).toContainText('使用量は未取得'); await expect(failedEntry).not.toContainText('0トークン');
  await expect(page.locator('.ai-evidence')).toContainText('使用量未取得は0料金を意味しません'); expect(await mainHash(page)).toBe(before);
});

test('G4 a mismatched image response is actionable and preserves the current artwork', async ({page}) => {
  await page.goto('/'); await startSample(page); await page.locator('.artwork-stage .artwork-svg').waitFor(); const before = await saveProject(page);
  const bytes = await sharp({create: {width: 640, height: 480, channels: 4, background: '#ffffff'}}).png().toBuffer();
  await page.route('**/api/images', route => route.fulfill({contentType: 'application/json', body: JSON.stringify({image: {id: '0'.repeat(64), widthPx: 640, heightPx: 480, mimeType: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}`}})}));
  await page.getByLabel('画像を選ぶ', {exact: true}).setInputFiles({name: 'developer-test.png', mimeType: 'image/png', buffer: bytes});
  await expect(page.getByRole('alert')).toContainText('画像の確認結果と画像が一致しません');
  await expect(page.getByRole('button', {name: '画像を選び直す', exact: true})).toBeVisible();
  expect(await mainHash(page)).toBe(before.document.designHash);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.unroute('**/api/images');
  await page.getByLabel('画像を選ぶ', {exact: true}).setInputFiles({name: 'developer-test.png', mimeType: 'image/png', buffer: bytes});
  await expect(page.getByRole('button', {name: '選択の編集を終える', exact: true})).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0); expect(await mainHash(page)).not.toBe(before.document.designHash);
});

test('G4 physical record stores four labelled views and an explicitly unperformed initial check', async ({page}) => {
  await page.goto('/'); await startSample(page); await page.locator('.artwork-stage .artwork-svg').waitFor(); const before = await mainHash(page); await physical(page);
  await page.getByLabel('10往復程度の初期チェック', {exact: true}).fill('自動テストの保存確認。実物での往復は未実施。');
  await page.getByLabel('正面・裏面・始点・終点の様子', {exact: true}).fill('開発者の合成画像。実物写真ではありません。');
  const bytes = await sharp({create: {width: 60, height: 50, channels: 3, background: '#ddd8ce'}}).png().toBuffer();
  await page.getByLabel('写真（4枚まで）', {exact: true}).setInputFiles(Array.from({length: 4}, (_, i) => ({name: `developer-view-${i}.png`, mimeType: 'image/png', buffer: bytes})));
  for (const [index, value] of ['front','back','start','end'].entries()) await page.getByLabel(`写真${index + 1}の向き`, {exact: true}).selectOption(value);
  await page.getByRole('button', {name: 'この設計版に記録を追加', exact: true}).click();
  const saved = await saveProject(page), record = saved.records[0];
  expect(record.photos).toHaveLength(4); expect(record.photoViews).toEqual(['front','back','start','end']); expect(record.roundTrips).toContain('未実施'); expect(record.designHash).toBe(before);
  const legacy = {...saved, version: 1, records: [{...record, photos: record.photos.slice(0,3)}]};
  delete legacy.records[0].photoViews; delete legacy.records[0].roundTrips; delete legacy.records[0].viewObservations;
  // Import the legacy file from Home in a new tab. Reload now restores the active
  // project automatically, where merging correctly preserves the newer record.
  const legacyPage = await page.context().newPage();
  await legacyPage.goto('/'); await expect(legacyPage.locator('.home-library')).toBeVisible();
  await legacyPage.getByLabel('プロジェクトファイルを選ぶ', {exact: true}).setInputFiles({name: 'legacy.ugoku.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy))});
  await expect(legacyPage.locator('.status-message')).toContainText('ファイルから作品を開きました');
  const resumed = await saveProject(legacyPage); expect(resumed.records[0].photos).toHaveLength(3); expect(resumed.records[0].photoViews).toEqual([]); expect(resumed.records[0].roundTrips).toBe('');
  expect((await saveProject(page)).records[0]).toEqual(record);
  await legacyPage.close();
});

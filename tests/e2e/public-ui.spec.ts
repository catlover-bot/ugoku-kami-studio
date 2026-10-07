import { expect, test, type Page } from '@playwright/test';
import { getKitSummary } from '@ugoku/core';
import { readFile, writeFile } from 'node:fs/promises';
import { createApp } from '../../apps/server/src/app';
import { readConfig } from '../../apps/server/src/config';
import type { ModelProvider, ProviderResponse } from '../../apps/server/src/provider';
import type { AiRun } from '../../apps/web/src/aiEvidence';
import type { Project } from '../../apps/web/src/project';
import { downloadKit, importProject } from '../../scripts/live-browser';
import { ai, manual, openRequest, saveProject, stage, startSample } from './helpers';

const access = 'public-ui-offline-fixture-access-code';
const startButton = (page: Page) => page.getByRole('button', {name: 'AIで案をつくる', exact: true});
async function enterCode(page: Page) {
  await ai(page);
  await page.getByLabel('AIアクセスコード').fill(access);
  await page.getByRole('dialog', {name: '設定', exact: true}).getByRole('button', {name: '閉じる', exact: true}).click();
}
async function fixtureServer(provider: ModelProvider) {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
  try {
    return await createApp({config: readConfig({AI_PROVIDER: 'vertex', VERTEX_PROJECT: 'offline-fixture-project', VERTEX_LOCATION: 'global', VERTEX_MODEL: 'gemini-3.8-flash', AI_ACCESS_SECRET: access, AI_MAX_MODEL_CALLS: '3'}), provider});
  } finally {if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;}
}

test('public manual editing, persistence and PDF need no code; missing AI code offers the existing settings', async ({page}, info) => {
  let aiStarts = 0, sessionStarts = 0;
  await page.route('**/api/status', route => route.fulfill({json: {ai: {enabled: true, mode: 'injected-test', provider: 'vertex', reason: 'HTTP fixture only'}}}));
  page.on('request', request => {if (request.method() === 'POST') {if (/\/runs$/.test(request.url())) aiStarts++; if (/\/sessions$/.test(request.url())) sessionStarts++;}});
  await page.goto('/'); await startSample(page); await manual(page);
  await page.getByLabel('動く距離（mm）', {exact: true}).fill('18');
  await page.getByLabel('動く距離（mm）', {exact: true}).press('Enter');
  await startButton(page).click();
  await expect(page.locator('.ai-panel')).toContainText('AIだけにアクセスコードが必要です');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', {name: 'AIの設定を開く', exact: true}).click();
  await expect(page.getByLabel('AIアクセスコード')).toHaveValue('');
  await page.keyboard.press('Escape');
  const saved = await saveProject(page) as Project;
  expect(saved.document.input.travelMm).toBe(18);
  await downloadKit(page, saved.document, info.outputDir);
  await page.reload();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', saved.document.designHash);
  expect(aiStarts).toBe(0); expect(sessionStarts).toBe(0);
});

test('only actual Retry-After gives a waiting deadline; neither timed nor unknown limits resend automatically', async ({page}, info) => {
  let starts = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/status') return route.fulfill({json: {ai: {enabled: true, mode: 'injected-test'}}});
    if (path === '/api/sessions') return route.fulfill({json: {sessionId: 'http-fixture-session', token: 'fixture-token'}});
    if (path.endsWith('/runs')) {
      starts++;
      return route.fulfill({status: 429, headers: starts === 1 ? {'Retry-After': '2'} : {}, json: {error: {code: 'instance_limit', message: '模擬上限応答。', ...(starts === 2 ? {retryAfterMs: 9999} : {})}}});
    }
    return route.continue();
  });
  await page.goto('/'); await startSample(page); await enterCode(page);
  const before = await saveProject(page) as Project; await openRequest(page);
  await startButton(page).click();
  await expect(page.locator('.ai-panel')).toContainText('サーバーの案内による待機');
  await expect(startButton(page)).toBeDisabled();
  await page.screenshot({path: info.outputPath('actual-retry-after.png')});
  await expect(page.locator('.ai-panel')).toContainText('案内された待機時間が過ぎました', {timeout: 5000});
  await expect(startButton(page)).toBeEnabled();
  expect(starts).toBe(1);
  await startButton(page).click();
  await expect.poll(() => starts).toBe(2);
  await expect(page.locator('.ai-panel')).not.toContainText('サーバーの案内による待機');
  await expect(page.locator('.ai-panel')).not.toContainText('待機時間が過ぎました');
  await expect(startButton(page)).toBeEnabled();
  await page.waitForTimeout(1400); // More than two polling periods; no automatic request.
  expect(starts).toBe(2);
  expect((await saveProject(page)).document).toEqual(before.document);
});

test('a terminal candidate stops polling; server session loss keeps the work and requires a new explicit request', async ({page}, info) => {
  let calls = 0, starts = 0, polls = 0;
  const provider: ModelProvider = {async generate() {calls++; return {message: {role: 'assistant', text: '', calls: [{name: 'propose_design_patch', args: {travelMm: 15}}]}, finishReason: 'STOP'};}};
  const app = await fixtureServer(provider);
  try {
    const origin = await app.listen({host: '127.0.0.1', port: 0});
    page.on('request', request => {if (/\/runs$/.test(request.url()) && request.method() === 'POST') starts++; if (/\/runs\/[^/]+$/.test(request.url()) && request.method() === 'GET') polls++;});
    await page.goto(origin); await startSample(page); await enterCode(page);
    const prompt = '動く距離を15mmにしたい';
    await page.getByLabel('どう動かしたいですか？', {exact: true}).fill(prompt);
    const before = await saveProject(page) as Project; await openRequest(page);
    await startButton(page).click();
    const accept = page.locator('.ai-panel').getByRole('button', {name: 'この案にする', exact: true});
    await expect(accept).toBeVisible();
    const terminalPolls = polls;
    await page.waitForTimeout(1400);
    expect(polls).toBe(terminalPolls); expect(calls).toBe(1);
    // Simulate process/session loss on the real in-process server, not the UI.
    app.sessions.sessions.clear();
    await accept.click();
    await expect(page.locator('.ai-panel')).toContainText('現在の作品と希望は残っています');
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', before.document.designHash);
    await expect(page.getByLabel('どう動かしたいですか？', {exact: true})).toHaveValue(prompt);
    await page.waitForTimeout(1400);
    expect(starts).toBe(1); expect(calls).toBe(1); expect(polls).toBe(terminalPolls);
    await page.screenshot({path: info.outputPath('session-expired-original-retained.png')});
    await openRequest(page);
    await startButton(page).click();
    await expect(accept).toBeVisible(); expect(starts).toBe(2); expect(calls).toBe(2);
    await page.locator('.ai-panel').getByRole('button', {name: 'この案を使わない', exact: true}).click();
    expect((await saveProject(page)).document).toEqual(before.document);
    await downloadKit(page, before.document, info.outputDir);
    await page.reload();
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', before.document.designHash);
    expect(calls).toBe(2);
  } finally {await page.context().close(); await app.close();}
});

test('saved tool-event reconstruction (not live AI): three textless responses produce a checked alternative, adoption and the same PDF/guide', async ({page}, info) => {
  test.setTimeout(60_000);
  const fixture = JSON.parse(await readFile(new URL('../../apps/server/test/fixtures/goal010r-c-replay.json', import.meta.url), 'utf8')) as {project: Project; prompt: string; responses: ProviderResponse[]; provenance: unknown; expectedToolDesignHashes: string[]};
  let calls = 0;
  const provider: ModelProvider = {async generate() {const response = fixture.responses[calls++]; if (!response) throw Error('No fourth fixture response: a further model call is a regression'); return response;}};
  const app = await fixtureServer(provider);
  try {
    const origin = await app.listen({host: '127.0.0.1', port: 0});
    const file = info.outputPath('reconstructed-input.ugoku.json'); await writeFile(file, JSON.stringify(fixture.project));
    await importProject(page, origin, file); await enterCode(page);
    const runs: AiRun[] = [];
    page.on('response', response => {if (/\/runs(?:\/[^/]+)?$/.test(new URL(response.url()).pathname)) void response.json().then(value => {if (value.run) runs.push(value.run);}).catch(() => undefined);});
    await page.getByLabel('どう動かしたいですか？', {exact: true}).fill(fixture.prompt);
    await startButton(page).click();
    const accept = page.locator('.ai-panel').getByRole('button', {name: 'この案にする', exact: true});
    await expect(accept).toBeVisible();
    const run = runs.at(-1)!;
    expect(run.mode).toBe('injected-test'); expect(calls).toBe(3); expect(run.modelCalls).toBe(3);
    expect(run.proposal).toMatchObject({fulfillsRequested: false, requestedTravelMm: 70, summarySource: 'deterministic-core'});
    expect(run.requestedValidation?.travelMm).toBe(70);
    expect(run.requestedValidation?.checks.some(check => check.status === 'fail')).toBe(true);
    expect(run.candidateValidation?.travelMm).toBe(35);
    expect(run.candidateValidation?.checks.some(check => check.status === 'fail')).toBe(false);
    await expect(page.locator('.ai-panel')).toContainText('希望の70mmに対し、候補は35mm');
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', fixture.project.document.designHash);
    await expect(page.locator('.comparison-after figcaption')).toContainText('35mm');
    const comparison = page.locator('.ai-panel .design-comparison');
    await expect(comparison.locator('.comparison-distances dt')).toHaveText(['現在', '希望', '候補（代案）']);
    await expect(comparison.locator('.comparison-distances dd')).toHaveText([`${fixture.project.document.input.travelMm}mm`, '70mm', '35mm']);
    await expect(comparison.locator('.candidate-paper')).toContainText('絵の大きさを維持');
    const allChecks = comparison.locator('.candidate-checks');
    const candidateChecks = getKitSummary(run.proposal!.document).checks;
    await expect(allChecks).not.toHaveAttribute('open', '');
    await allChecks.locator('summary').focus(); await page.keyboard.press('Enter');
    await expect(allChecks.locator('li')).toHaveCount(candidateChecks.length);
    for (const check of candidateChecks) await expect(allChecks.getByText(check.message, { exact: false })).toBeVisible();
    await allChecks.locator('summary').press('Enter');
    await expect(allChecks).not.toHaveAttribute('open', '');
    if (info.project.name === 'mobile') await page.setViewportSize({width: 320, height: 800});
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await accept.scrollIntoViewIfNeeded(); await expect(accept).toBeInViewport();
    expect((await accept.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({path: info.outputPath('reconstructed-alternative-not-live.png')});
    await accept.click();
    const saved = await saveProject(page) as Project;
    expect(saved.document.input.travelMm).toBe(35);
    expect(saved.document.revision).toBe(fixture.project.document.revision + 1);
    expect(saved.document.input.selection).toEqual(fixture.project.document.input.selection);
    expect(saved.document.input.locks).toEqual(fixture.project.document.input.locks);
    expect(saved.document.input.maxSheets).toBe(fixture.project.document.input.maxSheets);
    expect(saved.records).toEqual([]);
    await page.getByRole('button', {name: '設定', exact: true}).click();
    await page.locator('.ai-evidence > summary').click();
    const pending = page.waitForEvent('download'); await page.getByRole('button', {name: 'AI実行記録を書き出す', exact: true}).click();
    const evidencePath = info.outputPath('reconstructed.ai-run.json'); await (await pending).saveAs(evidencePath);
    const record = JSON.parse(await readFile(evidencePath, 'utf8')).records[0];
    expect(record.serverRun.requestedValidation).toEqual(run.requestedValidation);
    expect(record.serverRun.candidateValidation).toEqual(run.candidateValidation);
    expect(record.serverRun.proposal.summarySource).toBe('deterministic-core');
    expect(record.decision.adopted.designHash).toBe(saved.document.designHash);
    expect(JSON.stringify(record)).not.toContain(access);
    await page.keyboard.press('Escape');
    const pdf = await downloadKit(page, saved.document, info.outputDir);
    await page.getByRole('button', {name: '組み立てガイドを開く', exact: true}).click();
    await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-hash', saved.document.designHash);
    await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-revision', String(saved.document.revision));
    await page.screenshot({path: info.outputPath('reconstructed-adopted-guide-not-live.png')});
    await page.getByRole('button', {name: 'ガイドを閉じる', exact: true}).click();
    await saveProject(page); await page.reload();
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', saved.document.designHash);
    await stage(page, 3);
    await page.getByRole('button', {name: '組み立てガイドを開く', exact: true}).click();
    await expect(page.locator('.assembly-guide')).toHaveAttribute('data-design-hash', saved.document.designHash);
    expect(calls).toBe(3);
    await writeFile(info.outputPath('reconstruction-provenance.json'), JSON.stringify({kind: 'saved-tool-event-reconstruction', realAiCalls: 0, originalNetworkPayloadAvailable: false, provenance: fixture.provenance, run, adopted: saved.document, pdf}, null, 2));
  } finally {await page.context().close(); await app.close();}
});

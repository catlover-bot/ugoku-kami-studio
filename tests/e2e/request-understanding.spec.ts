import { test, expect, type Page } from '@playwright/test';
import { createDesign, getKitSummary, applyDesignPatch } from '@ugoku/core';
import { createPrototypeProject } from '../../scripts/prepare-prototype.js';
import { importProject, downloadKit } from '../../scripts/live-browser.js';
import { writeFile } from 'node:fs/promises';
import { manual, stage, saveProject, interpretation, editCurrentSettings } from './helpers';

async function openTwenty(page: Page, file: string, origin: string) {
  const prototype = await createPrototypeProject();
  const project = {...prototype, document: createDesign({...prototype.document.input, title: '解釈を確かめる魚', travelMm: 20, locks: prototype.document.input.locks.filter(key => key !== 'direction')}, {designId: 'request-ui-fish', revision: 1})};
  expect(getKitSummary(applyDesignPatch(project.document, {travelMm: 25})).status).toBe('prototype');
  await writeFile(file, JSON.stringify(project));
  await importProject(page, origin, file);
  await manual(page);
  return project;
}
async function ask(page: Page, text: string) {
  const editor = page.locator('.motion-request .request-editor');
  if (!await editor.evaluate(node => (node as HTMLDetailsElement).open)) await editor.locator(':scope > summary').click();
  await page.getByLabel('どう動かしたいですか？', {exact: true}).fill(text);
  await page.getByRole('button', {name: '寸法から案をつくる', exact: true}).click();
  await expect(page.locator('.manual-result')).toBeVisible();
  await interpretation(page);
}

test('R1: relative and absolute distance differ; interpretation correction recalculates before adoption and PDF', async ({page, baseURL}, info) => {
  const base = await openTwenty(page, info.outputPath('input.ugoku.json'), baseURL!);
  await ask(page, 'あと5mm動かして');
  const interpreted = page.locator('.intent-panel .request-interpretation');
  await expect(interpreted).toContainText(/20\s*→\s*25/);
  await expect(page.locator('.comparison-after figcaption')).toContainText('25mm');
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.document.designHash);
  await interpreted.getByText('解釈を直す', {exact: true}).click();
  await interpreted.getByLabel('距離の受け取り方', {exact: true}).selectOption('absolute');
  await interpreted.getByLabel('解釈する距離（mm）', {exact: true}).fill('5');
  await expect(page.locator('.intent-panel').getByRole('button', {name:'この案にする',exact:true})).toBeDisabled();
  await interpreted.getByRole('button', {name: 'この解釈で検査し直す', exact: true}).click();
  await expect(interpreted).toContainText(/20\s*→\s*5/);
  await expect(page.locator('.comparison-after figcaption')).toContainText('5mm');
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.document.designHash);
  await ask(page, '5mm動かして');
  await expect(page.locator('.comparison-after figcaption')).toContainText('5mm');
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.document.designHash);
  await ask(page, '動く距離をさらに5ミリ長くして');
  await expect(interpreted).toContainText(/20\s*→\s*25/);
  await page.locator('.intent-panel').getByRole('button', {name: 'この案にする', exact: true}).click();
  await expect(page.getByLabel('動く距離（mm）', {exact: true})).toHaveValue('25');
  const adopted = await saveProject(page);
  expect(adopted.document.revision).toBe(base.document.revision + 1);
  expect(adopted.document.input.selection).toEqual(base.document.input.selection);
  expect(adopted.document.input.locks).toEqual(base.document.input.locks);
  expect(adopted.records).toEqual([]);
  await downloadKit(page, adopted.document, info.outputDir);
  await page.screenshot({path: info.outputPath('adopted-print.png')});
});

test('R2/R3: negated rotation and forbidden left preserve unspecified distance; true rotation is separate', async ({page, baseURL}, info) => {
  const base = await openTwenty(page, info.outputPath('input.ugoku.json'), baseURL!);
  for (const text of ['回転させずに、右へ動かして', '左には動かさず、右に動かして']) {
    await ask(page, text);
    const interpreted = page.locator('.intent-panel .request-interpretation');
    await expect(interpreted).toContainText('右');
    await expect(interpreted).toContainText('20');
    await expect(page.locator('.manual-result')).not.toContainText('この動きには対応していません');
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.document.designHash);
    await expect(page.getByLabel('動く距離（mm）', {exact: true})).toHaveValue('20');
  }
  await page.screenshot({path: info.outputPath('negated-direction.png')});
  await ask(page, '回転させたい');
  await expect(page.locator('.manual-result')).toContainText('この動きには対応していません');
  await expect(page.getByRole('button',{name:'直線運動の代案を選ぶ',exact:true})).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.document.designHash);
  await stage(page, 1);
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.document.designHash);
});


test('Manual interpretation is bound to the request and revision; undo does not revive an old relative candidate', async ({page, baseURL}, info) => {
  const base = await openTwenty(page, info.outputPath('input.ugoku.json'), baseURL!);
  await ask(page, 'いまより5mm長く動かして');
  await expect(page.locator('.comparison-after figcaption')).toContainText('25mm');
  const distance = page.getByLabel('動く距離（mm）', {exact: true});
  await editCurrentSettings(page);
  await distance.fill('18'); await distance.press('Enter');
  await expect(page.locator('.intent-panel .request-interpretation')).toHaveCount(0);
  await page.getByRole('button', {name: '元に戻す', exact: true}).click();
  await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.document.designHash);
  await expect(page.locator('main')).toHaveAttribute('data-design-revision', String(base.document.revision + 2));
  await expect(page.locator('.intent-panel').getByRole('button', {name: 'この案にする', exact: true})).toHaveCount(0);
  await expect(page.locator('.intent-panel')).toContainText('現在の設定へ戻りました');
  const saved = await saveProject(page);
  expect(saved.document.input.selection).toEqual(base.document.input.selection);
  expect(saved.records).toEqual([]);
  await ask(page, 'あと5mm動かして');
  await expect(page.locator('.intent-panel .request-interpretation')).toHaveAttribute('data-base-revision', String(base.document.revision + 2));
  await expect(page.locator('.comparison-after figcaption')).toContainText('25mm');
});

// Only the model transport is injected below. Sessions, correction binding,
// deterministic tools, approval and PDF generation use the actual application.
import { createApp } from '../../apps/server/src/app.js';
import { readConfig } from '../../apps/server/src/config.js';
import type { ModelProvider, ProviderResponse, ToolCall } from '../../apps/server/src/provider.js';
import { ai } from './helpers';
import type { AiRun } from '../../apps/web/src/aiEvidence';
const accessCode = 'request-ui-offline-access-secret-32-characters';
const modelReply = (calls: ToolCall[], text = ''): ProviderResponse => ({message:{role:'assistant',text,calls},finishReason:'STOP'});
const toolCall = (name: string, args: Record<string, unknown> = {}): ToolCall => ({name,args,id:`fixture-${name}`});
const finalReply = () => modelReply([], '模擬通信です。実Geminiの理解性能を確認した結果ではありません。');
async function isolatedAi(provider: ModelProvider) {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
  try {return await createApp({config:readConfig({AI_PROVIDER:'gemini',GEMINI_API_KEY:'offline-not-real',AI_ACCESS_SECRET:accessCode}),provider});}
  finally {if(previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;}
}

test('Injected AI: a bound interpretation correction replaces the actual server candidate and its adopted PDF', async ({page}, info) => {
  test.setTimeout(60_000);
  let calls = 0;
  const provider: ModelProvider = {async generate() {
    calls++;
    if(calls === 1) return modelReply([toolCall('propose_request_interpretation',{distance:{kind:'absolute',value:5,unit:'mm'},direction:{forbidden:[]},size:'unspecified',paper:{kind:'unspecified'},mechanism:'single-pull-tab',unresolved:[]})]);
    if(calls === 3) return modelReply([toolCall('propose_design_patch')]);
    return finalReply();
  }};
  const app = await isolatedAi(provider);
  try {
    const origin = await app.listen({host:'127.0.0.1',port:0});
    const base = await openTwenty(page,info.outputPath('input.ugoku.json'),origin);
    const bodies: Record<string, unknown>[] = [], runs: AiRun[] = [];
    page.on('request', request => {if(request.method()==='POST' && /\/runs$/.test(new URL(request.url()).pathname)) bodies.push(request.postDataJSON());});
    page.on('response', response => {if(/\/runs(?:\/[^/]+)?$/.test(new URL(response.url()).pathname)) void response.json().then(value => {if(value.run) runs.push(value.run);}).catch(() => undefined);});
    await ai(page);await page.getByLabel('AIアクセスコード').fill(accessCode); await page.getByRole('dialog', {name: '設定', exact: true}).getByRole('button', {name: '閉じる', exact: true}).click();
    await page.getByLabel('どう動かしたいですか？',{exact:true}).fill('  あと5mm動かして  ');
    await page.getByRole('button',{name:'AIで案をつくる',exact:true}).click();
    const interpreted=page.locator('.ai-panel .request-interpretation');
    await expect(interpreted).toBeVisible();
    await expect.poll(()=>runs.at(-1)?.status).toBe('clarification_required');
    await expect(page.locator('.ai-panel .proposal')).toHaveCount(0);
    await expect(page.locator('main')).toHaveAttribute('data-design-hash',base.document.designHash);
    await interpreted.getByText('解釈を直す',{exact:true}).click();
    await interpreted.getByLabel('距離の受け取り方',{exact:true}).selectOption('absolute');
    await interpreted.getByLabel('解釈する距離（mm）',{exact:true}).fill('5');
    await interpreted.getByRole('button',{name:'この解釈で検査し直す',exact:true}).click();
    await expect(page.locator('.candidate-workbench .comparison-after figcaption')).toContainText('5mm');
    expect(bodies).toHaveLength(2);
    const first=runs.find(run=>run.status==='clarification_required')!;
    expect(bodies[1]).toMatchObject({prompt:'  あと5mm動かして  ',baseRevision:base.document.revision,baseHash:base.document.designHash,correction:{runId:first.id,requestId:first.requestId,changes:{binding:first.requestInterpretation!.binding,distance:{kind:'absolute',value:5,unit:'mm'}}}});
    expect(bodies[1]!.requestId).not.toBe(bodies[0]!.requestId);
    await expect(page.locator('main')).toHaveAttribute('data-design-hash',base.document.designHash);
    await page.screenshot({path:info.outputPath('corrected-ai-proposal.png'),fullPage:true});
    await page.locator('.ai-panel').getByRole('button',{name:'この案にする',exact:true}).click();
    await expect(page.getByLabel('動く距離（mm）',{exact:true})).toHaveValue('5');
    const adopted=await saveProject(page);
    expect(adopted.document.input.selection).toEqual(base.document.input.selection);
    expect(adopted.document.input.maxSheets).toBe(base.document.input.maxSheets);
    expect(adopted.document.input.locks).toEqual(base.document.input.locks);
    expect(JSON.stringify(adopted)).not.toContain(accessCode);
    await writeFile(info.outputPath('adopted.ugoku.json'),JSON.stringify(adopted,null,2));
    await writeFile(info.outputPath('server-runs.json'),JSON.stringify({mode:'injected-test',realGemini:false,requests:bodies,runs},null,2));
    await downloadKit(page,adopted.document,info.outputDir);
    // Two calls expose the initial interpretation conflict. The corrected
    // request hands off after its one checked patch, without a summary round.
    expect(calls).toBe(3);
  } finally {try {await page.context().close();} finally {await app.close();}}
});

test('Injected AI: cancelling a delayed interpretation keeps design, selection and draft after its response arrives', async ({page}, info) => {
  let release!: (value:ProviderResponse)=>void;
  const provider:ModelProvider={generate:()=>new Promise(resolve=>{release=resolve;})};
  const app=await isolatedAi(provider);
  try {
    const origin=await app.listen({host:'127.0.0.1',port:0});
    const base=await openTwenty(page,info.outputPath('input.ugoku.json'),origin);
    await ai(page);await page.getByLabel('AIアクセスコード').fill(accessCode); await page.getByRole('dialog', {name: '設定', exact: true}).getByRole('button', {name: '閉じる', exact: true}).click();
    await page.getByLabel('どう動かしたいですか？',{exact:true}).fill('首のストロークをひと伸び分足したい');
    const sent=page.waitForResponse(response=>response.request().method()==='POST' && /\/runs$/.test(new URL(response.url()).pathname));
    await page.getByRole('button',{name:'AIで案をつくる',exact:true}).click();
    const started = await (await sent).json() as {run: AiRun};
    const cancelled = page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname.endsWith(`/runs/${started.run.id}`));
    await page.getByRole('button',{name:'中断する',exact:true}).click();
    const cancellation = await cancelled;
    expect(cancellation.status()).toBe(200);
    expect(cancellation.request().headers()['content-type']).toBeUndefined();
    expect(cancellation.request().postData()).toBeNull();
    expect((await cancellation.json()).run.status).toBe('cancelled');
    const session = [...app.sessions.sessions.values()][0]!;
    expect(session.runs.get(started.run.id)?.status).toBe('cancelled');
    expect(session.runs.get(started.run.id)?.controller.signal.aborted).toBe(true);
    await expect(page.locator('.ai-panel').getByRole('status')).toContainText('中断');
    const distance=page.getByLabel('動く距離（mm）',{exact:true});await distance.fill('');
    release(modelReply([toolCall('propose_request_interpretation',{distance:{kind:'relative',delta:5,unit:'mm'},direction:{forbidden:[]},size:'unspecified',paper:{kind:'unspecified'},mechanism:'single-pull-tab',unresolved:[]}),toolCall('propose_design_patch')]));
    await expect(page.locator('.ai-panel .proposal')).toHaveCount(0);
    await expect(page.locator('.ai-panel .request-interpretation')).toHaveCount(0);
    await expect(distance).toHaveValue('');
    await expect(page.locator('main')).toHaveAttribute('data-design-hash',base.document.designHash);
    await distance.press('Escape');
    const saved=await saveProject(page);
    expect(saved.document.input.selection).toEqual(base.document.input.selection);
    expect(saved.records).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain(accessCode);
  } finally {try {await page.context().close();} finally {await app.close();}}
});

test('Injected AI: bodyless proposal rejection and session deletion reach the actual Fastify handlers', async ({page}, info) => {
  let calls = 0;
  const provider: ModelProvider = {async generate() {
    calls++;
    return calls === 1 ? modelReply([toolCall('propose_design_patch')]) : finalReply();
  }};
  const app = await isolatedAi(provider);
  try {
    const origin = await app.listen({host: '127.0.0.1', port: 0});
    const base = await openTwenty(page, info.outputPath('input.ugoku.json'), origin);
    await ai(page);
    await page.getByLabel('AIアクセスコード').fill(accessCode);
    await page.getByRole('dialog', {name: '設定', exact: true}).getByRole('button', {name: '閉じる', exact: true}).click();
    await page.getByLabel('どう動かしたいですか？', {exact: true}).fill('あと5mm動かして');
    const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/sessions');
    await page.getByRole('button', {name: 'AIで案をつくる', exact: true}).click();
    const credentials = await (await created).json() as {sessionId: string; token: string};
    const reject = page.locator('.ai-panel').getByRole('button', {name: 'この案を使わない', exact: true});
    await expect(reject).toBeVisible();
    const session = app.sessions.sessions.get(credentials.sessionId)!;
    const run = [...session.runs.values()][0]!;
    expect(run.status).toBe('awaiting_approval');
    const rejected = page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname.includes('/proposals/'));
    await reject.click();
    const response = await rejected;
    expect(response.status()).toBe(200);
    expect(response.request().headers()['content-type']).toBeUndefined();
    expect(response.request().postData()).toBeNull();
    expect((await response.json()).run.status).toBe('cancelled');
    expect(run.status).toBe('cancelled');
    expect(run.proposal).toBeUndefined();
    expect(session.document).toEqual(base.document);
    await expect(page.locator('main')).toHaveAttribute('data-design-hash', base.document.designHash);
    // The UI has no session-close action. Exercise that existing bodyless API from
    // the browser too, through real HTTP/Fastify parsing with the same session.
    const deleted = await page.evaluate(async ({sessionId, token}) => {
      const result = await fetch(`/api/sessions/${sessionId}`, {method: 'DELETE', headers: {Authorization: `Bearer ${token}`}});
      return {status: result.status, body: await result.json()};
    }, credentials);
    expect(deleted).toEqual({status: 200, body: {deleted: true}});
    expect(app.sessions.sessions.has(credentials.sessionId)).toBe(false);
    // The checked textless patch is already sufficient; rejection needs no
    // additional model summary and both DELETE routes remain bodyless.
    expect(calls).toBe(1);
  } finally {try {await page.context().close();} finally {await app.close();}}
});

test('Only the ambiguous quantity needs a short choice; distance correction retains a forbidden direction', async ({page,baseURL},info) => {
  const base=await openTwenty(page,info.outputPath('input.ugoku.json'),baseURL!);
  await ask(page,'5だけ動かす');
  const interpreted=page.locator('.intent-panel .request-interpretation');
  await expect(page.locator('.intent-panel .design-comparison')).toHaveCount(0);
  await expect(interpreted).toContainText('単位');
  await page.screenshot({path:info.outputPath('quantity-choice.png')});
  await interpreted.getByRole('button',{name:'5mm増やす',exact:true}).click();
  await expect(page.locator('.comparison-after figcaption')).toContainText('25mm');
  await expect(page.locator('main')).toHaveAttribute('data-design-hash',base.document.designHash);
  await page.locator('.intent-panel').getByRole('button',{name:'この案を使わない',exact:true}).click();
  await ask(page,'左には動かさず、右に動かして');
  await interpreted.getByText('解釈を直す',{exact:true}).click();
  await expect(interpreted.getByRole('checkbox',{name:'左',exact:true})).toBeChecked();
  await interpreted.getByLabel('距離の受け取り方',{exact:true}).selectOption('relative');
  await interpreted.getByLabel('解釈する距離（mm）',{exact:true}).fill('100001');
  await interpreted.getByRole('button',{name:'この解釈で検査し直す',exact:true}).click();
  await expect(interpreted.getByRole('alert')).toContainText('100000');
  await expect(page.locator('main')).toHaveAttribute('data-design-hash',base.document.designHash);
  await interpreted.getByLabel('解釈する距離（mm）',{exact:true}).fill('5');
  await interpreted.getByRole('button',{name:'この解釈で検査し直す',exact:true}).click();
  await expect(interpreted.getByRole('button',{name:'この解釈で検査し直す',exact:true})).toBeFocused();
  await expect(interpreted.getByRole('checkbox',{name:'左',exact:true})).toBeChecked();
  await expect(interpreted).toContainText('左は禁止');
  await expect(page.locator('.comparison-after figcaption')).toContainText('25mm');
  await expect(page.locator('main')).toHaveAttribute('data-design-hash',base.document.designHash);
});

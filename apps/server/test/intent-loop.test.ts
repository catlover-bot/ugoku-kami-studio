import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { FinishReason, type Content, type Part } from '@google/genai';
import { applyArtworkRepair, createDesign, getAssemblySteps, SAMPLE_INPUT, type CheckResult, type DesignDocument } from '@ugoku/core';
import { generatePdf, generateSvg } from '@ugoku/export';
import { createApp, type App } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { ModelProvider, ProviderResponse } from '../src/provider.js';
import { publicRun } from '../src/runs.js';

const access = 'test-only-access-secret-more-than-32-characters';
const response = (parts: Part[]): ProviderResponse => ({ candidates: [{ content: { role: 'model', parts }, finishReason: FinishReason.STOP }] });
const invoke = (name: string, args: Record<string, unknown> = {}): ProviderResponse => response([{ functionCall: { name, args, id: `test-call-${name}` } }]);
const resultText = response([{ text: '候補の寸法と紙面を検査しました。実物の動作は未確認です。' }]);
const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

/** Only the model transport is mocked. Decisions consume the actual core tool results. */
function adjustingProvider() {
  const histories: Content[][] = [];
  const generate = vi.fn(async (history: Content[]): Promise<ProviderResponse> => {
    histories.push(structuredClone(history));
    const result = history.at(-1)?.parts?.find(part => part.functionResponse)?.functionResponse?.response;
    if (!result) return invoke('propose_design_patch');
    if (result.error) throw new Error('The test provider could not create an authorized candidate');
    const checks = result.checks as CheckResult[];
    if (!checks.some(check => check.status === 'fail')) return resultText;
    const original = JSON.parse(history[0]!.parts![0]!.text!) as { design: DesignDocument };
    const nextTravel = Math.floor((Number(result.candidateTravelMm) + original.design.input.travelMm) / 2);
    if (nextTravel <= original.design.input.travelMm) return invoke('propose_constraint_change', { key: 'widthMm', value: original.design.input.widthMm + 10, reason: '選択と台紙の縁の余裕が不足しています。作品サイズ変更を許すか、手動で選択位置を見直してください。' });
    return invoke('propose_design_patch', { travelMm: nextTravel });
  });
  return { histories, generate };
}
function sequence(items: ProviderResponse[]): ModelProvider & { histories: Content[][] } {
  const histories: Content[][] = [];
  return { histories, generate: vi.fn(async history => { histories.push(structuredClone(history)); return items.shift() ?? resultText; }) };
}
async function setup(provider: ModelProvider, document = createDesign(SAMPLE_INPUT)) {
  const app = await createApp({ config: readConfig({ AI_ENABLED: 'true', GEMINI_API_KEY: 'test-only-key', AI_ACCESS_SECRET: access }), provider }); apps.push(app);
  const created = await app.inject({ method: 'POST', url: '/api/sessions', payload: { document } });
  expect(created.statusCode).toBe(201);
  const body = created.json() as { sessionId: string; token: string };
  const headers = { authorization: `Bearer ${body.token}`, 'x-ai-access': access };
  const session = app.sessions.authorize(body.sessionId, headers.authorization);
  const url = `/api/sessions/${body.sessionId}`;
  const start = async (prompt: string) => {
    const request = { requestId: 'intent-request-001', prompt, baseRevision: document.revision, baseHash: document.designHash };
    const result = await app.inject({ method: 'POST', url: `${url}/runs`, headers, payload: request });
    expect(result.statusCode).toBe(202);
    const run = app.runs.get(session, (result.json() as {run: {id: string}}).run.id); await run.done;
    return run;
  };
  return { app, headers, session, url, document, start };
}

describe('author intent through the actual server, core tools, approval and outputs (mock model communication)', () => {
  it('keeps author-approved v2 artwork repair through the tool loop and rejects model repair edits', async () => {
    const original = applyArtworkRepair(createDesign(SAMPLE_INPUT), { mode: 'solid', color: '#e6cfaa' });
    const provider = sequence([invoke('propose_design_patch', { artworkRepair: { mode: 'white' } }), invoke('propose_design_patch', { travelMm: 15 }), resultText]);
    const s = await setup(provider, original);
    const run = await s.start('移動距離を15mmにしたい');
    expect(provider.histories[1]!.at(-1)!.parts![0]!.functionResponse!.response!.error).toMatchObject({ code: 'invalid_arguments' });
    expect(run.status).toBe('awaiting_approval');
    expect(run.proposal!.document.schemaVersion).toBe(2);
    expect(run.proposal!.document.input.artworkRepair).toEqual(original.input.artworkRepair);
    const accepted = s.app.runs.approve(s.session, run.proposal!.id, { requestId: run.requestId, baseRevision: run.baseRevision, baseHash: run.baseHash }).document;
    expect(accepted.input.travelMm).toBe(15);
    expect(accepted.input.artworkRepair).toEqual(original.input.artworkRepair);
    expect(provider.histories[0]![0]!.parts![0]!.text).not.toContain('data:image/');
  });

  it('invalidates an existing proposal when a manual artwork repair changes the design', async () => {
    const s = await setup(adjustingProvider());
    const run = await s.start('移動距離を15mmにしたい');
    const proposal = run.proposal!;
    const repaired = applyArtworkRepair(s.document, { mode: 'solid', color: '#e6cfaa' });
    const update = await s.app.inject({ method: 'PUT', url: `${s.url}/document`, headers: s.headers, payload: { document: repaired } });
    expect(update.statusCode).toBe(200);
    expect(repaired.revision).toBe(s.document.revision + 1);
    expect(repaired.designHash).not.toBe(s.document.designHash);
    const late = await s.app.inject({ method: 'POST', url: `${s.url}/proposals/${proposal.id}/approve`, headers: s.headers, payload: { requestId: run.requestId, baseRevision: run.baseRevision, baseHash: run.baseHash } });
    expect(late.statusCode).toBe(409);
    expect(s.session.document).toEqual(repaired);
    expect(run.status).toBe('cancelled');
  });

  it.each([8, 12, 20])('uses current %imm travel, preserves artwork and actual paper count without manufacturing a first failure', async travelMm => {
    const provider = adjustingProvider(); const s = await setup(provider, createDesign({ ...SAMPLE_INPUT, travelMm }));
    const run = await s.start('もう少し大きく動かしたい。絵の大きさは変えない。紙は増やさない');
    expect(run.status).toBe('awaiting_approval'); expect(run.modelCalls).toBe(2); expect(run.toolCalls).toBe(1);
    expect(run.validationIssues).toEqual([]);
    const candidate = run.proposal!.document;
    expect(candidate.input.travelMm).toBeGreaterThan(travelMm);
    expect(candidate.input.widthMm).toBe(s.document.input.widthMm); expect(candidate.input.heightMm).toBe(s.document.input.heightMm);
    expect(candidate.artwork.placement).toEqual(s.document.artwork.placement); expect(candidate.input.selection).toEqual(s.document.input.selection);
    expect(candidate.input.maxSheets).toBe(s.document.layout.sheets); expect(candidate.layout.sheets).toBeLessThanOrEqual(s.document.layout.sheets);
    expect(candidate.input.locks).toEqual(expect.arrayContaining(['widthMm', 'heightMm', 'maxSheets']));
    expect(s.session.document).toEqual(s.document); // Conditions are proposed, not applied before approval.
    expect(publicRun(run)).not.toHaveProperty('intent');
    expect(run.proposal!.protectedConditions.join(' ')).toContain('枚以内');
    expect(provider.histories[0]![0]!.parts![0]!.text).not.toContain('data:image/');
  });

  it.each(['絵のサイズはそのままで、首を右に出したい。厚紙はA4で2枚まで', '画像の寸法を維持して、右へ動かす。紙は二枚以内'])('persists equivalent protected conditions after approval: %s', async prompt => {
    const s = await setup(adjustingProvider()); const run = await s.start(prompt);
    expect(run.status).toBe('awaiting_approval');
    const proposal = run.proposal!;
    const approved = await s.app.inject({ method: 'POST', url: `${s.url}/proposals/${proposal.id}/approve`, headers: s.headers, payload: { requestId: run.requestId, baseRevision: run.baseRevision, baseHash: run.baseHash } });
    expect(approved.statusCode).toBe(200);
    const after = (approved.json() as {document: DesignDocument}).document;
    expect(after.input.locks).toEqual(expect.arrayContaining(['widthMm', 'heightMm', 'maxSheets'])); expect(after.input.maxSheets).toBe(2);
    expect(after.input.widthMm).toBe(s.document.input.widthMm); expect(after.artwork.placement).toEqual(s.document.artwork.placement);
    const svg = generateSvg(after);
    expect(svg).toContain(`revision ${after.revision}`); expect(svg).toContain(after.designId);
    const printedHash = /SHA-256 ([a-f0-9]+)/.exec(svg)?.[1];
    expect(printedHash!.length).toBeGreaterThanOrEqual(16); expect(after.designHash.startsWith(printedHash!)).toBe(true);
    expect(after.designHash).not.toBe(s.document.designHash);
  });

  it('repairs actual geometric failures using returned checks and labels an alternative to an explicit distance', async () => {
    const provider = adjustingProvider(); const s = await setup(provider);
    const run = await s.start('移動距離を70mmにしたい。絵の大きさは固定。厚紙は2枚まで');
    const returnedChecks = provider.histories.slice(1).flatMap(history => history.at(-1)?.parts?.flatMap(part => part.functionResponse?.response?.checks as CheckResult[] ?? []) ?? []);
    expect(returnedChecks.some(check => check.status === 'fail' && check.partIds.length > 0)).toBe(true);
    expect(run.status).toBe('awaiting_approval'); expect(run.proposal!.fulfillsRequested).toBe(false); expect(run.proposal!.requestedTravelMm).toBe(70);
    expect(run.proposal!.document.input.travelMm).toBeGreaterThan(s.document.input.travelMm); expect(run.proposal!.document.input.travelMm).toBeLessThan(70);
    expect(run.proposal!.document.checks.some(check => check.status === 'fail')).toBe(false);
    expect(run.message).toContain('希望は70mm');
    const proposalRun = publicRun(run);
    const beforeSteps = getAssemblySteps(s.document); const proposal = run.proposal!;
    const { document: after } = s.app.runs.approve(s.session, proposal.id, { requestId: run.requestId, baseRevision: run.baseRevision, baseHash: run.baseHash });
    expect(generateSvg(after)).not.toBe(generateSvg(s.document)); expect(getAssemblySteps(after)).not.toEqual(beforeSteps);
    expect(getAssemblySteps(after).flatMap(step => step.partIds).every(id => after.parts.some(part => part.id === id))).toBe(true);
    const artifactDir = 'artifacts/goal004/server-regression';
    await mkdir(artifactDir, { recursive: true });
    const fontBytes = new Uint8Array(await readFile('apps/web/public/fonts/ZenKakuGothicNew-Regular.ttf'));
    const samplePng = await sharp(await readFile('apps/web/public/turtle.svg')).png().toBuffer();
    const imageDataUrl = `data:image/png;base64,${samplePng.toString('base64')}`;
    const pdf = await generatePdf(after, { fontBytes, imageDataUrl });
    await Promise.all([
      writeFile(`${artifactDir}/before.design.json`, JSON.stringify(s.document, null, 2)),
      writeFile(`${artifactDir}/accepted.design.json`, JSON.stringify(after, null, 2)),
      writeFile(`${artifactDir}/proposal-run.json`, JSON.stringify(proposalRun, null, 2)),
      writeFile(`${artifactDir}/before.svg`, generateSvg(s.document, 1, { imageDataUrl })),
      writeFile(`${artifactDir}/accepted.svg`, generateSvg(after, 1, { imageDataUrl })),
      writeFile(`${artifactDir}/accepted.pdf`, pdf),
      writeFile(`${artifactDir}/assembly.before.json`, JSON.stringify(beforeSteps, null, 2)),
      writeFile(`${artifactDir}/assembly.accepted.json`, JSON.stringify(getAssemblySteps(after), null, 2)),
      writeFile(`${artifactDir}/evidence.json`, JSON.stringify({ mode: 'test-only mocked model communication with real server/core/export', scenarios: ['S4', 'S5'], liveApiCalls: 0, physicalValidation: 'unverified', requestedTravelMm: 70, acceptedTravelMm: after.input.travelMm, acceptedDesignHash: after.designHash, modelCalls: run.modelCalls, toolCalls: run.toolCalls, firstCandidateHadActualGeometryFailures: returnedChecks.some(check => check.status === 'fail') }, null, 2)),
    ]);
  });

  it('denies model attempts to shrink protected artwork, add paper or supply a replacement interpretation', async () => {
    const provider = sequence([invoke('propose_design_patch', { widthMm: 100 }), invoke('propose_design_patch', { maxSheets: 3 }), invoke('propose_design_patch', { intent: { protections: {} }, locks: [] }), invoke('propose_design_patch'), resultText]);
    const s = await setup(provider); const run = await s.start('もっと大きく動かしたい。絵の大きさは変えない。紙は2枚まで');
    const errors = provider.histories.slice(1, 4).map(history => history.at(-1)!.parts![0]!.functionResponse!.response!.error as {code: string});
    expect(errors.map(error => error.code)).toEqual(['protected_condition', 'protected_condition', 'invalid_arguments']);
    expect(run.status).toBe('awaiting_approval'); expect(run.proposal!.document.input.widthMm).toBe(s.document.input.widthMm); expect(run.proposal!.document.input.maxSheets).toBe(2);
    const request = { requestId: run.requestId, baseRevision: run.baseRevision, baseHash: run.baseHash, patch: { widthMm: 100 }, intent: { protections: {} } };
    const forged = await s.app.inject({ method: 'POST', url: `${s.url}/proposals/${run.proposal!.id}/approve`, headers: s.headers, payload: request });
    expect(forged.statusCode).toBe(400); expect(s.session.document).toEqual(s.document);
  });

  it('cannot fulfill a request for larger movement by shrinking movement to fit', async () => {
    const provider = sequence([invoke('propose_design_patch', { travelMm: 10 }), resultText]); const s = await setup(provider);
    const run = await s.start('もっと大きく動かして。絵の大きさは保つ');
    expect(run.status).toBe('failed'); expect(run.proposal).toBeUndefined(); expect(s.session.document).toEqual(s.document);
    expect(provider.histories[1]!.at(-1)!.parts![0]!.functionResponse!.response!.error).toMatchObject({ code: 'protected_condition' });
  });

  it('presents actual failed part reasons and a condition suggestion without applying it', async () => {
    const provider = sequence([invoke('propose_design_patch'), invoke('propose_constraint_change', { key: 'widthMm', value: 180, reason: '切り込みの縁が足りないため、作品の幅を変えることを許すか、選択を中央側へ動かしてください。' }), resultText]);
    const s = await setup(provider); const run = await s.start('距離を70mmに。絵の大きさは変えない。紙は増やさない');
    expect(run.status).toBe('failed'); expect(run.error?.code).toBe('validation_failed'); expect(run.proposal).toBeUndefined();
    expect(run.validationIssues.some(check => check.id === 'slot-contained' && check.partIds.includes('B1'))).toBe(true);
    expect(run.message).toContain(run.validationIssues[0]!.message); expect(run.constraintSuggestions).toHaveLength(1); expect(s.session.document).toEqual(s.document);
  });

  it('reject leaves newly requested protections unapplied; existing protected conditions cannot be unlocked by prose', async () => {
    const s = await setup(adjustingProvider()); const run = await s.start('少し大きく動かしたい。絵のサイズを保って、厚紙は2枚まで');
    expect(run.proposal).toBeDefined(); s.app.runs.reject(s.session, run.proposal!.id); expect(s.session.document).toEqual(s.document); expect(s.session.document.input.locks).toEqual([]);
    const provider = adjustingProvider(); const locked = await setup(provider, createDesign({ ...SAMPLE_INPUT, locks: ['widthMm', 'heightMm', 'maxSheets'], maxSheets: 1 }));
    const result = await locked.app.inject({ method: 'POST', url: `${locked.url}/runs`, headers: locked.headers, payload: { requestId: 'request-unlock-001', prompt: '固定を解除して絵のサイズを変更して。紙は2枚まで増やして', baseRevision: locked.document.revision, baseHash: locked.document.designHash } });
    expect(result.statusCode).toBe(422); expect(result.json().error.code).toBe('clarification_required'); expect(provider.generate).not.toHaveBeenCalled(); expect(locked.session.document).toEqual(locked.document);
  });

  it.each(['絵の大きさを保つ。でも絵を小さくして', '紙は増やさない。でも紙を増やして', '右へ、上へ動かす', 'もっと大きく、少し小さく動かしたい', 'もっと大きく動かさないで'])('asks to clarify conflicting or negative instructions before calling the provider: %s', async prompt => {
    const provider = adjustingProvider(); const s = await setup(provider);
    const result = await s.app.inject({ method: 'POST', url: `${s.url}/runs`, headers: s.headers, payload: { requestId: 'request-clarify-001', prompt, baseRevision: s.document.revision, baseHash: s.document.designHash } });
    expect(result.statusCode).toBe(422); expect(result.json().error.code).toBe('clarification_required'); expect(provider.generate).not.toHaveBeenCalled();
  });
});

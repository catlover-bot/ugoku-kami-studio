import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { applyDesignPatch, createDesign, getAssemblySteps, mmToPt, parseDesignDocument, validateDesign, type DesignDocument } from '@ugoku/core';
import { generatePdf } from '@ugoku/export';
import { createApp, type App } from '../src/app.js';
import { readConfig, type ServerConfig } from '../src/config.js';
import { type ModelProvider, type ProviderResponse } from '../src/provider.js';
import { RunManager, publicRun } from '../src/runs.js';
import type { Session } from '../src/sessions.js';

// The real tool arguments and their order are preserved. Provider envelopes and
// empty final text are reconstructed; this is not a live-model or raw HTTP replay.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/goal010r-c-replay.json', import.meta.url), 'utf8')) as {
  provenance: { originalNetworkPayloadAvailable: boolean; kind: string };
  project: { document: DesignDocument; imageDataUrl: string };
  prompt: string; responses: ProviderResponse[]; expectedToolDesignHashes: string[];
};
const access = 'offline-candidate-handoff-test-access-secret';
const config = (overrides: Partial<ServerConfig> = {}) => ({ ...readConfig({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-only', AI_ACCESS_SECRET: access, AI_MAX_MODEL_CALLS: '3' }), ...overrides });
const base = () => parseDesignDocument(fixture.project.document);
const patchReply = (travelMm: number): ProviderResponse => ({ message: { role: 'assistant', text: '', calls: [{ name: 'propose_design_patch', args: { travelMm } }] }, finishReason: 'STOP' });
function providerFor(responses: ProviderResponse[]): ModelProvider {
  const queue = structuredClone(responses);
  return { generate: vi.fn(async () => { const next = queue.shift(); if (!next) throw Error('Unexpected extra model call'); return next; }) };
}
function harness(responses: ProviderResponse[], options: { document?: DesignDocument; prompt?: string; config?: Partial<ServerConfig> } = {}) {
  const document = options.document ?? base(), session = { document, runs: new Map() } as Session;
  const provider = providerFor(responses), manager = new RunManager(config(options.config), provider);
  const request = { requestId: 'candidate-handoff-request', prompt: options.prompt ?? fixture.prompt, baseRevision: document.revision, baseHash: document.designHash };
  const run = manager.start(session, request);
  return { document, session, provider, manager, request, run };
}
const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('safe textless candidate handoff from the saved C tool sequence', () => {
  it('rebuilds 70→45→35 within three calls, preserves the original failure, then approves and exports the same version', async () => {
    expect(fixture.provenance.originalNetworkPayloadAvailable).toBe(false);
    const document = base(), original = JSON.stringify(document), provider = providerFor(fixture.responses);
    const app = await createApp({ config: config(), provider }); apps.push(app);
    const created = await app.inject({ method: 'POST', url: '/api/sessions', payload: { document } });
    expect(created.statusCode).toBe(201);
    const { sessionId, token } = created.json() as { sessionId: string; token: string };
    const headers = { authorization: `Bearer ${token}`, 'x-ai-access': access }, url = `/api/sessions/${sessionId}`;
    const request = { requestId: 'reconstructed-c-request', prompt: fixture.prompt, baseRevision: document.revision, baseHash: document.designHash };
    const started = await app.inject({ method: 'POST', url: `${url}/runs`, headers, payload: request });
    expect(started.statusCode).toBe(202);
    const session = app.sessions.authorize(sessionId, headers.authorization);
    const run = session.runs.get(started.json().run.id)!; await run.done;
    expect(run.status).toBe('awaiting_approval');
    expect(run.modelCalls).toBe(3); expect(run.toolCalls).toBe(3); expect(provider.generate).toHaveBeenCalledTimes(3);
    expect(run.events.filter(event => event.type === 'tool').map(event => event.designHash)).toEqual(fixture.expectedToolDesignHashes);
    expect(run.requestedValidation).toMatchObject({ source: 'deterministic-core', travelMm: 70, designHash: fixture.expectedToolDesignHashes[0] });
    expect(run.requestedValidation!.checks.filter(check => check.status === 'fail').map(check => check.id)).toEqual(['guides-on-base', 'slot-contained']);
    expect(run.candidateValidation).toMatchObject({ source: 'deterministic-core', travelMm: 35, designHash: fixture.expectedToolDesignHashes[2] });
    expect(run.candidateValidation!.checks.some(check => check.status === 'fail')).toBe(false);
    expect(run.candidateValidation!.checks.find(check => check.id === 'physical-operation')?.status).toBe('unknown');
    expect(run.proposal).toMatchObject({ summarySource: 'deterministic-core', fulfillsRequested: false, requestedTravelMm: 70, document: { revision: document.revision + 1, input: { travelMm: 35, maxSheets: 1, locks: document.input.locks } } });
    expect(run.message).toContain('希望は70mm、候補は35mm'); expect(run.message).toContain('現在の条件と検査した配置');
    expect(run.message).toContain('型紙は1枚のまま'); expect(run.message).toContain('未検証');
    expect(run.message).not.toMatch(/最大|唯一|実物.*成功/);
    expect(JSON.stringify(session.document)).toBe(original);
    expect(publicRun(run).requestedValidation).toEqual(run.requestedValidation);
    const candidate = structuredClone(run.proposal!.document);
    const adoptedResponse = await app.inject({ method: 'POST', url: `${url}/proposals/${run.proposal!.id}/approve`, headers, payload: { requestId: request.requestId, baseRevision: request.baseRevision, baseHash: request.baseHash } });
    expect(adoptedResponse.statusCode).toBe(200);
    const adopted = parseDesignDocument(adoptedResponse.json().document);
    expect(adopted).toEqual(candidate); expect(session.document).toEqual(candidate);
    const pdf = await PDFDocument.load(await generatePdf(adopted, { imageDataUrl: fixture.project.imageDataUrl }));
    expect(pdf.getPageCount()).toBe(5); expect(pdf.getTitle()).toBe(`${adopted.designId} revision ${adopted.revision}`);
    expect(pdf.getSubject()).toContain(adopted.designHash); expect(pdf.getSubject()).toContain('physically unverified');
    for (const page of pdf.getPages()) { expect(page.getWidth()).toBeCloseTo(mmToPt(210), 5); expect(page.getHeight()).toBeCloseTo(mmToPt(297), 5); }
    expect(getAssemblySteps(adopted).length).toBeGreaterThan(4);
  });

  it.each([
    { width: 160, height: 110, sheets: 1, initial: 30, request: 43, candidate: 42, fails: false },
    { width: 160, height: 110, sheets: 1, initial: 30, request: 43, candidate: 43, fails: true },
    { width: 180, height: 123.75, sheets: 2, initial: 30, request: 70, candidate: 45, fails: false },
    { width: 160, height: 110, sheets: 1, initial: 30, request: 2, candidate: 2, fails: false },
  ])('uses actual geometry and actual requested values at $width mm / $candidate mm', async row => {
    const document = createDesign({ ...base().input, widthMm: row.width, heightMm: row.height, maxSheets: row.sheets, travelMm: row.initial });
    expect(validateDesign(document).some(check => check.status === 'fail')).toBe(false);
    const h = harness([patchReply(row.candidate)], { document, prompt: `動く距離を${row.request}mmに。絵の大きさと紙の枚数は変えない`, config: { maxModelCalls: 1 } }); await h.run.done;
    expect(h.session.document).toEqual(document);
    if (row.fails) { expect(h.run.status).toBe('failed'); expect(h.run.proposal).toBeUndefined(); expect(h.run.validationIssues.map(check => check.id)).toContain('guides-on-base'); }
    else {
      expect(h.run.status).toBe('awaiting_approval'); expect(h.run.modelCalls).toBe(1);
      expect(h.run.proposal).toMatchObject({ fulfillsRequested: row.candidate === row.request, requestedTravelMm: row.request, summarySource: 'deterministic-core' });
      expect(h.run.candidateValidation?.travelMm).toBe(row.candidate);
      expect(h.run.message).toContain(`${row.candidate}mm`); expect(h.run.message).not.toContain('35mm');
    }
  });

  it.each(['unknown-tool', 'protected-size', 'paper-cap', 'tool-limit'])('processes the complete final batch and cannot hide %s after a valid candidate', async failure => {
    const response = patchReply(35);
    response.message.calls.push(failure === 'unknown-tool' ? { name: 'unknown_tool', args: {} } : failure === 'tool-limit' ? { name: 'validate_design', args: {} } : { name: 'propose_design_patch', args: failure === 'paper-cap' ? { maxSheets: 2 } : { widthMm: 200 } });
    const h = harness([patchReply(70), patchReply(45), response], { config: { maxToolCalls: failure === 'tool-limit' ? 3 : 4 } }); await h.run.done;
    expect(h.run.status).toBe('failed'); expect(h.run.proposal).toBeUndefined(); expect(h.run.modelCalls).toBe(3);
    expect(h.run.error?.code).toBe(failure === 'tool-limit' ? 'tool_limit' : 'model_limit');
    expect(h.session.document).toEqual(h.document);
  });

  it('reports known failed geometry and manual recovery when all three candidates fail', async () => {
    const h = harness([patchReply(70), patchReply(65), patchReply(60)]); await h.run.done;
    expect(h.run.status).toBe('failed'); expect(h.run.error?.code).toBe('model_limit'); expect(h.run.proposal).toBeUndefined();
    expect(h.run.requestedValidation?.travelMm).toBe(70); expect(h.run.candidateValidation?.travelMm).toBe(60);
    expect(h.run.message).toContain('手動で条件を見直せます'); expect(h.run.message).toContain('採用可能な候補はありません');
    for (const failure of h.run.validationIssues) expect(h.run.message).toContain(failure.message);
    expect(h.session.document).toEqual(h.document);
  });

  it.each(['cancel', 'new-revision', 'changed-request', 'changed-correction'])('does not hand off a late valid result after %s', async change => {
    let release!: (response: ProviderResponse) => void;
    const provider: ModelProvider = { generate: () => new Promise(resolve => { release = resolve; }) };
    const document = base(), session = { document, runs: new Map() } as Session, manager = new RunManager(config(), provider);
    const run = manager.start(session, { requestId: 'late-textless-candidate', prompt: fixture.prompt, baseRevision: document.revision, baseHash: document.designHash });
    if (change === 'cancel') manager.cancel(run);
    else if (change === 'new-revision') session.document = createDesign(document.input, { designId: document.designId, revision: document.revision + 1 });
    else if (change === 'changed-request') run.prompt = '距離を35mmにして';
    else run.authorCorrection = { binding: run.intent.binding, distance: { kind: 'absolute', value: 35, unit: 'mm' } };
    release(patchReply(35)); await run.done;
    expect(run.status).toBe(change === 'cancel' ? 'cancelled' : 'failed'); expect(run.proposal).toBeUndefined();
    expect(session.document.input).toEqual(document.input);
  });

  it('rechecks approval against trusted geometry even if an in-memory candidate is tampered with', async () => {
    const h = harness([patchReply(35)]); await h.run.done;
    const proposal = h.run.proposal!;
    proposal.patch = { travelMm: 70 }; proposal.document = applyDesignPatch(h.document, proposal.patch);
    expect(() => h.manager.approve(h.session, proposal.id, { requestId: h.request.requestId, baseRevision: h.request.baseRevision, baseHash: h.request.baseHash })).toThrow('再検査');
    expect(h.session.document).toEqual(h.document);
  });
});

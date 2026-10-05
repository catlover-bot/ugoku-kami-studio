import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleAuth } from 'google-auth-library';
import { createDesign, SAMPLE_INPUT } from '@ugoku/core';
import { createApp, type App } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { signTrialPermit, verifyTrialPermit, type TrialPermit } from '../src/trial-permit.js';

const secret = 'offline-only-trial-permit-test-secret';
const sha = 'a'.repeat(40);
const settings = { AI_PROVIDER: 'vertex', VERTEX_PROJECT: 'offline-project', VERTEX_LOCATION: 'global', VERTEX_MODEL: 'gemini-3.8-flash', VERTEX_MODEL_BUDGET_USD: '3.9', VERTEX_TRIAL_PERMITS_REQUIRED: 'true', VERTEX_TRIAL_SOURCE_SHA: sha, AI_ACCESS_SECRET: secret, AI_MAX_INPUT_BYTES: '32768', AI_MAX_OUTPUT_TOKENS: '2048' };
const response = () => new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'inspect_design', args: {} } }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 120 }, responseId: 'offline-response', modelVersion: 'gemini-3.8-flash' }), { headers: { 'content-type': 'application/json' } });
const apps: App[] = [];
beforeEach(() => { vi.spyOn(GoogleAuth.prototype, 'getRequestHeaders').mockResolvedValue(new Headers({ authorization: 'Bearer offline-only' })); });
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture(maxCalls = 1) {
  const app = await createApp({ config: readConfig(settings) }); apps.push(app);
  const document = createDesign(SAMPLE_INPUT);
  const session = (await app.inject({ method: 'POST', url: '/api/sessions', payload: { document } })).json();
  const body = { requestId: randomUUID(), baseHash: document.designHash, baseRevision: document.revision, prompt: '距離を15mmにしてください。' };
  const binding = { sessionId: session.sessionId, ...body, sourceSha: sha };
  const permit: TrialPermit = { version: 1, permitId: randomUUID(), sessionId: session.sessionId, requestId: body.requestId, baseHash: body.baseHash, baseRevision: body.baseRevision, sourceSha: sha, model: 'gemini-3.8-flash', callIds: Array.from({ length: maxCalls }, () => randomUUID()), issuedAt: Date.now(), expiresAt: Date.now() + 120_000, priorCommittedNanoUsd: 1_112_064_000, poolNanoUsd: 3_900_000_000, callReserveNanoUsd: 556_032_000 };
  const headers = { authorization: `Bearer ${session.token}`, 'x-ai-access': secret };
  return { app, body, headers, permit, binding, document, session, url: `/api/sessions/${session.sessionId}` };
}

describe('durably reserved private-trial call grants (offline transport)', () => {
  it('binds the signed grant to session, request, version, source, expiry and funds', async () => {
    const f = await fixture(), token = signTrialPermit(f.permit, secret);
    expect(verifyTrialPermit(token, secret, f.binding)).toEqual(f.permit);
    for (const change of [{ sessionId: randomUUID() }, { requestId: randomUUID() }, { baseHash: 'b'.repeat(64) }, { baseRevision: 999 }, { sourceSha: 'c'.repeat(40) }]) expect(() => verifyTrialPermit(token, secret, { ...f.binding, ...change })).toThrow();
    expect(() => verifyTrialPermit(token, secret, f.binding, f.permit.expiresAt)).toThrow();
    expect(() => verifyTrialPermit(token + 'x', secret, f.binding)).toThrow();
    expect(() => signTrialPermit({ ...f.permit, priorCommittedNanoUsd: 3_800_000_000 }, secret)).toThrow();
    expect(() => signTrialPermit({ ...f.permit, callIds: [f.permit.callIds[0], f.permit.callIds[0]] }, secret)).toThrow();
  });
  it('refuses missing/forged grants before SDK invocation and caps a valid run at its granted calls', async () => {
    const f = await fixture(1), fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
    expect((await f.app.inject({ method: 'POST', url: f.url + '/runs', headers: f.headers, payload: f.body })).statusCode).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    const headers = { ...f.headers, 'x-ai-trial-permit': signTrialPermit(f.permit, secret) };
    const started = await f.app.inject({ method: 'POST', url: f.url + '/runs', headers, payload: f.body }); expect(started.statusCode).toBe(202);
    const current = f.app.sessions.authorize(f.session.sessionId, f.headers.authorization), run = current.runs.get(started.json().run.id)!;
    await run.done;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ dispatchClosed: true, error: { code: 'model_limit' }, modelCalls: 1 });
    expect(run.modelUsage[0]).toMatchObject({ attemptId: f.permit.callIds[0], dispatch: { attemptId: f.permit.callIds[0], transport: 'vertex-http', sdkRetryAttempts: 1 } });
    expect(run.modelUsage[0].observations?.map(x => x.source)).toEqual(['http-response', 'sdk-response']);
    const duplicate = await f.app.inject({ method: 'POST', url: f.url + '/runs', headers, payload: f.body }); expect(duplicate.json().run.id).toBe(run.id);
    expect(fetch).toHaveBeenCalledTimes(1);
    const nextSession = (await f.app.inject({ method: 'POST', url: '/api/sessions', payload: { document: f.document } })).json();
    expect((await f.app.inject({ method: 'POST', url: `/api/sessions/${nextSession.sessionId}/runs`, headers: { ...headers, authorization: `Bearer ${nextSession.token}` }, payload: f.body })).statusCode).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('closes dispatch before cancellation acknowledgement and retains late numeric observations without tools', async () => {
    const f = await fixture(3); let finish!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetch);
    const started = await f.app.inject({ method: 'POST', url: f.url + '/runs', headers: { ...f.headers, 'x-ai-trial-permit': signTrialPermit(f.permit, secret) }, payload: f.body });
    const current = f.app.sessions.authorize(f.session.sessionId, f.headers.authorization), run = current.runs.get(started.json().run.id)!;
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const cancelled = await f.app.inject({ method: 'DELETE', url: f.url + '/runs/' + run.id, headers: f.headers });
    expect(cancelled.json().run).toMatchObject({ status: 'cancelled', dispatchClosed: true, toolCalls: 0, cancellation: { previousStatus: 'running', dispatchClosedBeforeCancel: false, abortSignalAborted: true, toolCallsAtRequest: 0 } });
    finish(response());
    await vi.waitFor(() => expect(run.modelUsage[0].observations?.length).toBeGreaterThan(0));
    expect(run).toMatchObject({ status: 'cancelled', dispatchClosed: true, toolCalls: 0, modelCalls: 1 });
    expect(run.proposal).toBeUndefined(); expect(current.document).toEqual(f.document); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('checks inherited global consumption again before every actual model send', async () => {
    const f = await fixture(2); f.permit.priorCommittedNanoUsd = 2_700_000_000;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'inspect_design', args: {} } }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 150_000 } }), { headers: { 'content-type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
    const started = await f.app.inject({ method: 'POST', url: f.url + '/runs', headers: { ...f.headers, 'x-ai-trial-permit': signTrialPermit(f.permit, secret) }, payload: f.body });
    const run = f.app.sessions.authorize(f.session.sessionId, f.headers.authorization).runs.get(started.json().run.id)!; await run.done;
    expect(run).toMatchObject({ dispatchClosed: true, error: { code: 'model_budget_limit' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(run.modelUsage[1].dispatch).toBeUndefined();
  });
});

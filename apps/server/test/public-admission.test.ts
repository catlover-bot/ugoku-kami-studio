import { afterEach, describe, expect, it } from 'vitest';
import { createDesign, SAMPLE_INPUT, type DesignDocument } from '@ugoku/core';
import { createApp, type App } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { initialPublicLedger, LedgerStoreError, PublicLedger, type PublicLedgerStore } from '../src/public-ledger.js';
import { assessVertexUsage, vertexUsageDiagnostics } from '../src/vertex-budget.js';
import type { ModelProvider, ModelCallContext } from '../src/conversation.js';
const config = () => readConfig({ AI_PROVIDER: 'vertex', AI_ACCESS_SECRET: 'public-test-code-no-cloud-'.repeat(3), VERTEX_PROJECT: 'example-project', VERTEX_LOCATION: 'global', VERTEX_MODEL: 'gemini-3.8-flash', VERTEX_MODEL_BUDGET_USD: '85', AI_PUBLIC_RELEASE: 'true', AI_LEDGER_BUCKET: 'private-ledger-test', AI_LEDGER_OBJECT: 'public-release-011/ledger.json', AI_RELEASE_PHASE: 'pre-release', AI_MAX_MODEL_CALLS: '6', AI_MAX_TOOL_CALLS: '4', AI_MAX_INPUT_BYTES: '32768', AI_MAX_OUTPUT_TOKENS: '2048', AI_TIMEOUT_MS: '90000', AI_MAX_CONCURRENT: '1', AI_RUNS_PER_MINUTE: '2', AI_MAX_RUNS_PER_HOUR: '4' });
class Store implements PublicLedgerStore {
  data = JSON.stringify(initialPublicLedger()); generation = 1; reads = 0; writes = 0; rejectWrite = 0;
  beforeWrite?: (data: string) => Promise<void>;
  async read() { this.reads++; return { data: this.data, generation: String(this.generation) }; }
  async compareAndSwap(generation: string, data: string) {
    this.writes++; if (this.writes === this.rejectWrite) throw new LedgerStoreError('unavailable');
    if (generation !== String(this.generation)) throw new LedgerStoreError('conflict');
    await this.beforeWrite?.(data);
    this.data = data; return String(++this.generation);
  }
}
const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup(store = new Store(), document = createDesign(SAMPLE_INPUT), extra?: (context: ModelCallContext, signal: AbortSignal) => Promise<void>) {
  const ledger = new PublicLedger(store); let sends = 0, starts = 0;
  const provider: ModelProvider = { async generate(_messages, signal, context) {
    starts++; if (!context) throw Error('Missing dispatch context');
    await context.beforeDispatch?.(); signal.throwIfAborted();
    await context.onDispatch?.({ attemptId: context.attemptId, call: context.call, dispatchedAt: new Date().toISOString() });
    expect((await ledger.snapshot()).sends).toBeGreaterThan(0); sends++;
    if (extra) await extra(context, signal);
    const usage = { totalTokenCount: 100 };
    await context.onObservation?.({ attemptId: context.attemptId, call: context.call, source: 'http-response', observedAt: new Date().toISOString(), sdkVersion: '2.27.0', model: 'gemini-3.8-flash', modelVersion: null, responseId: null, finishReason: 'STOP', aborted: signal.aborted, usageDiagnostics: vertexUsageDiagnostics(usage), modelCost: { ...assessVertexUsage(usage), reservationUsd: .556032 } });
    return { message: { role: 'assistant', text: '', calls: [{ name: 'propose_design_patch', args: { travelMm: 15 }, id: 'patch' }] }, finishReason: 'STOP', usageMetadata: usage };
  } };
  const app = await createApp({ config: config(), provider, publicLedger: ledger }); apps.push(app);
  const created = (await app.inject({ method: 'POST', url: '/api/sessions', payload: { document } })).json() as { sessionId: string; token: string; document: DesignDocument };
  const url = `/api/sessions/${created.sessionId}`, headers = { authorization: `Bearer ${created.token}`, 'x-ai-access': config().accessSecret };
  const body = { requestId: 'public-request-one', prompt: '動く距離を15mmに', baseRevision: document.revision, baseHash: document.designHash };
  return { store, ledger, app, url, headers, body, created, document, sends: () => sends, starts: () => starts };
}
async function finish(s: Awaited<ReturnType<typeof setup>>, id: string) {
  const session = s.app.sessions.authorize(s.created.sessionId, s.headers.authorization), run = s.app.runs.get(session, id);
  await run.done; return (await s.app.inject({ url: `${s.url}/runs/${id}`, headers: s.headers })).json().run;
}
describe('public HTTP admission to internal durable capabilities', () => {
  it('keeps manual routes available; bad code, client permits and oversized inputs never touch the ledger', async () => {
    const s = await setup();
    for (const headers of [{ authorization: s.headers.authorization }, { ...s.headers, 'x-ai-access': 'bad' }, { ...s.headers, 'x-ai-trial-permit': 'signed-with-reviewer-code' }]) {
      const response = await s.app.inject({ method: 'POST', url: `${s.url}/runs`, headers, payload: s.body }); expect([401, 403]).toContain(response.statusCode);
    }
    expect((await s.app.inject({ method: 'POST', url: `${s.url}/runs`, headers: s.headers, payload: { ...s.body, modelCalls: 100, budget: 1000 } })).statusCode).toBe(400);
    expect(s.store.reads).toBe(0); expect(s.store.writes).toBe(0); expect(s.starts()).toBe(0);
    expect((await s.app.inject({ method: 'PUT', url: `${s.url}/document`, headers: { authorization: s.headers.authorization }, payload: { document: s.document } })).statusCode).toBe(200);
  });
  it('reserves before send, settles once and refuses a duplicate across restart and changed transport IDs', async () => {
    const s = await setup(); const accepted = await s.app.inject({ method: 'POST', url: `${s.url}/runs`, headers: s.headers, payload: s.body });
    expect(accepted.statusCode).toBe(202); const run = await finish(s, accepted.json().run.id);
    expect(run.status).toBe('awaiting_approval'); expect(run.proposal.document.input.travelMm).toBe(15);
    expect(await s.ledger.snapshot()).toMatchObject({ requests: 1, sends: 1, reservedNano: 0, aggregateUpperEstimateNano: 750000 });
    expect(s.sends()).toBe(1); expect(JSON.stringify(run)).not.toContain('accountingPending');
    const duplicate = await s.app.inject({ method: 'POST', url: `${s.url}/runs`, headers: s.headers, payload: s.body }); expect(duplicate.json().run.id).toBe(run.id); expect(s.sends()).toBe(1);
    const restarted = await setup(s.store, s.document);
    const replay = await restarted.app.inject({ method: 'POST', url: `${restarted.url}/runs`, headers: restarted.headers, payload: { ...restarted.body, requestId: 'another-transport-id' } });
    expect(replay.statusCode).toBe(409); expect(restarted.sends()).toBe(0);
  });
  it('fails closed for rejected admission or per-send CAS without a model HTTP send', async () => {
    for (const write of [1, 2]) {
      const store = new Store(); store.rejectWrite = write; const s = await setup(store);
      const result = await s.app.inject({ method: 'POST', url: `${s.url}/runs`, headers: s.headers, payload: s.body });
      if (write === 1) expect(result.statusCode).toBe(503);
      else expect((await finish(s, result.json().run.id)).status).toBe('failed');
      expect(s.sends()).toBe(0);
    }
  });
  it('does not expose or approve a proposal while final ledger persistence is pending', async () => {
    const s = await setup(); let unblock!: () => void, waiting!: () => void;
    const pending = new Promise<void>(resolve => { waiting = resolve; });
    s.store.beforeWrite = async data => { if (JSON.parse(data).entries[0]?.state === 'closed') { waiting(); await new Promise<void>(resolve => { unblock = resolve; }); } };
    const accepted = await s.app.inject({ method: 'POST', url: `${s.url}/runs`, headers: s.headers, payload: s.body }); await pending;
    const id = accepted.json().run.id;
    const visible = (await s.app.inject({ url: `${s.url}/runs/${id}`, headers: s.headers })).json().run;
    expect(visible.status).toBe('running'); expect(visible.proposal).toBeUndefined();
    const session = s.app.sessions.authorize(s.created.sessionId, s.headers.authorization), proposal = s.app.runs.get(session, id).proposal!;
    const approval = await s.app.inject({ method: 'POST', url: `${s.url}/proposals/${proposal.id}/approve`, headers: s.headers, payload: { requestId: s.body.requestId, baseRevision: s.body.baseRevision, baseHash: s.body.baseHash } }); expect(approval.statusCode).toBe(409);
    unblock(); expect((await finish(s, id)).status).toBe('awaiting_approval');
  });
  it('retains sent-unknown on cancellation and accepts only late usage, never late tools', async () => {
    let arrived!: () => void, release!: () => void;
    const sent = new Promise<void>(resolve => { arrived = resolve; });
    const s = await setup(new Store(), createDesign(SAMPLE_INPUT), async () => { arrived(); await new Promise<void>(resolve => { release = resolve; }); });
    const accepted = await s.app.inject({ method: 'POST', url: `${s.url}/runs`, headers: s.headers, payload: s.body }); await sent;
    const id = accepted.json().run.id;
    const cancelled = await s.app.inject({ method: 'DELETE', url: `${s.url}/runs/${id}`, headers: s.headers }); expect(cancelled.json().run.status).toBe('cancelled');
    expect(await s.ledger.snapshot()).toMatchObject({ sentUnknownNano: 556032000, reservedNano: 0 });
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    const run = await finish(s, id); expect(run.status).toBe('cancelled'); expect(run.proposal).toBeUndefined(); expect(run.toolCalls).toBe(0);
    expect(await s.ledger.snapshot()).toMatchObject({ sentUnknownNano: 0, aggregateUpperEstimateNano: 750000 });
    expect(s.app.sessions.authorize(s.created.sessionId, s.headers.authorization).document).toEqual(s.document);
  });
});

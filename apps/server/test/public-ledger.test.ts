import { describe, expect, it } from 'vitest';
import { PublicLedger, LedgerStoreError, initialPublicLedger, publicLedgerHash, PUBLIC_LEDGER_LIMITS, type PublicLedgerStore } from '../src/public-ledger.js';
import { assessVertexUsage, vertexUsageDiagnostics } from '../src/vertex-budget.js';
import type { ModelObservation } from '../src/conversation.js';

class MemoryStore implements PublicLedgerStore {
  data: string; generation = 1; writes = 0; behavior: 'ok' | 'denied' | 'lost-after' | 'lost-before' | 'conflict' = 'ok';
  constructor(now: number) { this.data = JSON.stringify(initialPublicLedger(now)); }
  async read() { return { generation: String(this.generation), data: this.data }; }
  async compareAndSwap(generation: string, data: string) {
    this.writes++;
    if (this.behavior === 'denied') throw new LedgerStoreError('unavailable');
    if (this.behavior === 'lost-before') throw new LedgerStoreError('uncertain');
    if (this.behavior === 'conflict' || generation !== String(this.generation)) throw new LedgerStoreError('conflict');
    this.data = data; this.generation++;
    if (this.behavior === 'lost-after') throw new LedgerStoreError('uncertain');
    return String(this.generation);
  }
}
const start = Date.parse('2026-10-05T00:00:00Z');
const request = (id: string, phase: 'pre-release' | 'public' = 'public') => ({ requestId: id, fingerprint: publicLedgerHash(`fingerprint:${id}`), bindingHash: publicLedgerHash(`binding:${id}`), phase });
function observation(call = 1, attemptId = 'attempt-1', usage: unknown = { totalTokenCount: 100 }, source: 'http-response' | 'sdk-response' = 'http-response'): ModelObservation {
  return { call, attemptId, source, observedAt: new Date(start).toISOString(), sdkVersion: '2.27.0', model: 'gemini-3.8-flash', modelVersion: null, responseId: null, finishReason: null, aborted: false, usageDiagnostics: vertexUsageDiagnostics(usage), modelCost: { ...assessVertexUsage(usage), reservationUsd: .556032 } };
}
async function setup(time = start) {
  let now = time;
  const store = new MemoryStore(now), ledger = new PublicLedger(store, () => now);
  await ledger.setPhase('public');
  return { store, ledger, setTime: (value: number) => { now = value; }, advance: (delta: number) => { now += delta; } };
}

describe('durable public admission and settlement (no cloud or provider)', () => {
  it('reserves all six before dispatch and retains sent-unknown after verified close', async () => {
    const { ledger } = await setup(), grant = await ledger.reserve(request('one'));
    expect((await ledger.snapshot()).committedNano).toBe(6 * 556032000);
    await ledger.beforeDispatch(grant, { call: 1, attemptId: 'attempt-1' });
    await ledger.close(grant, { verified: true });
    expect(await ledger.snapshot()).toMatchObject({ requests: 1, sends: 1, pendingSends: 0, sentUnknownNano: 556032000, active: false });
    await expect(ledger.beforeDispatch(grant, { call: 2, attemptId: 'attempt-2' })).rejects.toMatchObject({ code: 'stale_public_grant' });
  });
  it('CAS across two instances admits only one simultaneous request and fences duplicate sends', async () => {
    const { ledger, store } = await setup(), other = new PublicLedger(store, () => start);
    const results = await Promise.allSettled([ledger.reserve(request('one')), other.reserve(request('two'))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const result = results[0]; expect(result.status).toBe('fulfilled'); if (result.status !== 'fulfilled') throw new Error();
    const sends = await Promise.allSettled([ledger.beforeDispatch(result.value, { call: 1, attemptId: 'a' }), ledger.beforeDispatch(result.value, { call: 1, attemptId: 'b' })]);
    expect(sends.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect((await other.snapshot()).sends).toBe(1);
  });
  it('restart preserves budget and global request/fingerprint deduplication', async () => {
    const { ledger, store } = await setup(), grant = await ledger.reserve(request('one'));
    await ledger.beforeDispatch(grant, { call: 1, attemptId: 'one' }); await ledger.close(grant, { verified: true });
    const other = new PublicLedger(store, () => start + 1000);
    await expect(other.reserve(request('one'))).rejects.toMatchObject({ code: 'duplicate_request' });
    await expect(other.reserve({ ...request('one'), requestId: 'new-id' })).rejects.toMatchObject({ code: 'duplicate_request' });
    expect((await other.snapshot()).sentUnknownNano).toBe(556032000);
    await expect(other.close(grant, { verified: true })).rejects.toMatchObject({ code: 'stale_public_grant' });
  });
  it('lost successful CAS response requires durable operation proof, never a second write', async () => {
    const { ledger, store } = await setup(); store.behavior = 'lost-after';
    const previous = store.writes, grant = await ledger.reserve(request('one'));
    expect(store.writes - previous).toBe(1);
    await ledger.beforeDispatch(grant, { call: 1, attemptId: 'a' });
    expect((await ledger.snapshot()).sends).toBe(1);
    await expect(ledger.beforeDispatch(grant, { call: 1, attemptId: 'a' })).rejects.toMatchObject({ code: 'stale_public_grant' });
  });
  it('unknown unproven writes and denied writes fail closed without blind retry', async () => {
    for (const behavior of ['lost-before', 'denied'] as const) {
      const { ledger, store } = await setup(); store.behavior = behavior; const prior = store.writes;
      await expect(ledger.reserve(request(behavior))).rejects.toMatchObject({ code: 'ledger_unavailable' });
      expect(store.writes - prior).toBe(1); expect((await ledger.snapshot()).requests).toBe(0);
    }
  });
  it('missing/corrupt ledger never initializes; conflicts retry at most four writes', async () => {
    const { store, ledger } = await setup(); store.behavior = 'conflict'; const prior = store.writes;
    await expect(ledger.reserve(request('one'))).rejects.toMatchObject({ code: 'ledger_unavailable' });
    expect(store.writes - prior).toBe(4);
    store.data = '{}'; await expect(ledger.snapshot()).rejects.toMatchObject({ code: 'ledger_unavailable' });
    const missing = new PublicLedger({ read: async () => { throw new LedgerStoreError('missing'); }, compareAndSwap: async () => { throw new Error('must not initialize'); } });
    await expect(missing.reserve(request('missing'))).rejects.toMatchObject({ code: 'ledger_unavailable' });
  });
  it('known usage is assessed internally; absent details remain aggregate, null total keeps reserve', async () => {
    const { ledger } = await setup(), grant = await ledger.reserve(request('one'));
    await ledger.beforeDispatch(grant, { call: 1, attemptId: 'attempt-1' });
    const info = observation(); info.modelCost.estimateUsd = 0;
    await ledger.observe(grant, info); await ledger.close(grant, { verified: true });
    expect(await ledger.snapshot()).toMatchObject({ aggregateUpperEstimateNano: 750000, sentUnknownNano: 0 });
    await ledger.observe(grant, observation(1, 'attempt-1', { totalTokenCount: null }, 'sdk-response'));
    expect((await ledger.snapshot()).sentUnknownNano).toBe(556032000);
  });
  it('late usage survives closure and duplicate settlement cannot double-release or lower conflicting costs', async () => {
    const { ledger } = await setup(), grant = await ledger.reserve(request('one'));
    await ledger.beforeDispatch(grant, { call: 1, attemptId: 'attempt-1' }); await ledger.close(grant, { verified: true });
    const info = observation(1, 'attempt-1', { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 0, totalTokenCount: 110 });
    await ledger.observe(grant, info); await ledger.observe(grant, info); await ledger.close(grant, { verified: true });
    expect(await ledger.snapshot()).toMatchObject({ usageEstimateNano: 225000, sends: 1, pendingSends: 0 });
    await ledger.observe(grant, observation(1, 'attempt-1', { totalTokenCount: 2 }));
    expect((await ledger.snapshot()).sentUnknownNano).toBe(556032000);
  });
  it('conflicting shared numeric HTTP/SDK usage retains the reservation instead of picking a cheaper estimate', async () => {
    const { ledger } = await setup(), grant = await ledger.reserve(request('one'));
    await ledger.beforeDispatch(grant, { call: 1, attemptId: 'attempt-1' });
    await ledger.observe(grant, observation(1, 'attempt-1', { totalTokenCount: 100 }));
    await ledger.observe(grant, observation(1, 'attempt-1', { totalTokenCount: 200 }, 'sdk-response'));
    await ledger.close(grant, { verified: true });
    expect((await ledger.snapshot()).sentUnknownNano).toBe(556032000);
  });
  it('expiry fences old grants; recovers only undispatched permits and retains sent uncertainty', async () => {
    const { ledger, store, advance } = await setup(), old = await ledger.reserve(request('old'));
    await ledger.beforeDispatch(old, { call: 1, attemptId: 'old-a' }); advance(90000);
    const next = await ledger.reserve(request('next'));
    expect((await ledger.snapshot()).committedNano).toBe(7 * 556032000);
    await expect(ledger.beforeDispatch(old, { call: 2, attemptId: 'old-b' })).rejects.toMatchObject({ code: 'stale_public_grant' });
    await ledger.close(next, { verified: true });
    expect((await new PublicLedger(store).snapshot()).sentUnknownNano).toBe(556032000);
    await ledger.observe(old, observation(1, 'old-a'));
    expect((await ledger.snapshot()).aggregateUpperEstimateNano).toBe(750000);
  });
  it('cancellation consumes minute/hour starts and concurrent capacity has no guessed retry', async () => {
    const { ledger, advance } = await setup(), one = await ledger.reserve(request('1'));
    await expect(ledger.reserve(request('concurrent'))).rejects.toMatchObject({ code: 'instance_limit', retryWindow: undefined });
    await ledger.close(one, { verified: true }); const two = await ledger.reserve(request('2')); await ledger.close(two, { verified: true });
    await expect(ledger.reserve(request('3'))).rejects.toMatchObject({ code: 'instance_limit', retryWindow: { retryAfterMs: 60000 } });
    advance(60000);
    for (const id of ['3', '4']) { const grant = await ledger.reserve(request(id)); await ledger.close(grant, { verified: true }); }
    await expect(ledger.reserve(request('5'))).rejects.toMatchObject({ retryWindow: { retryAfterMs: 3540000 } });
  });
  it('JST midnight moves the actual send day without resetting historical budget or request count', async () => {
    const before = Date.parse('2026-10-05T14:59:59Z'), { ledger, advance } = await setup(before), grant = await ledger.reserve(request('one'));
    advance(2000); await ledger.beforeDispatch(grant, { call: 1, attemptId: 'a' }); await ledger.close(grant, { verified: true });
    expect(await ledger.snapshot()).toMatchObject({ day: '2026-10-06', requests: 1, requestsToday: 0, sends: 1, sendsToday: 1, sentUnknownNano: 556032000 });
  });
  it('prerelease six requests is a distinct cap but all requests remain in period totals', async () => {
    let now = start; const store = new MemoryStore(start), ledger = new PublicLedger(store, () => now);
    for (let i = 0; i < 6; i++) { const grant = await ledger.reserve(request(String(i), 'pre-release')); await ledger.close(grant, { verified: true }); now += 3600000; }
    await expect(ledger.reserve(request('seventh', 'pre-release'))).rejects.toMatchObject({ code: 'public_usage_limit' });
    await ledger.setPhase('public'); const grant = await ledger.reserve(request('public')); await ledger.close(grant, { verified: true });
    expect(await ledger.snapshot()).toMatchObject({ requests: 7, preReleaseRequests: 6 });
  });
  it('prerelease sends are capped at 24 including reservations and public budget counts remain', async () => {
    let now = start; const store = new MemoryStore(start), ledger = new PublicLedger(store, () => now);
    for (let i = 0; i < 4; i++) {
      const grant = await ledger.reserve(request(String(i), 'pre-release'));
      for (let c = 1; c <= 6; c++) await ledger.beforeDispatch(grant, { call: c, attemptId: `${i}-${c}` });
      await ledger.close(grant, { verified: true }); now += 3600000;
    }
    await expect(ledger.reserve(request('fifth', 'pre-release'))).rejects.toMatchObject({ code: 'public_usage_limit' });
    expect(await ledger.snapshot()).toMatchObject({ sends: 24, sentUnknownNano: 24 * 556032000 });
  });
  it('daily request and send limits are independent, and expiry does not erase either', async () => {
    const { ledger, advance } = await setup();
    for (let i = 0; i < 10; i++) { const grant = await ledger.reserve(request(String(i))); await ledger.close(grant, { verified: true }); advance(3600000); }
    await expect(ledger.reserve(request('daily-11'))).rejects.toMatchObject({ code: 'public_usage_limit' });
    const other = await setup();
    for (let i = 0; i < 5; i++) {
      const grant = await other.ledger.reserve(request(String(i)));
      for (let c = 1; c <= 6; c++) await other.ledger.beforeDispatch(grant, { call: c, attemptId: `${i}-${c}` });
      await other.ledger.close(grant, { verified: true }); other.advance(3600000);
    }
    expect((await other.ledger.snapshot()).sendsToday).toBe(30);
    await expect(other.ledger.reserve(request('daily-sixth'))).rejects.toMatchObject({ code: 'public_usage_limit' });
  });
  it('85 USD model pool includes all unknown historical sends, even on different days', async () => {
    const { ledger, advance } = await setup();
    for (let i = 0; i < 25; i++) {
      const grant = await ledger.reserve(request(String(i)));
      for (let c = 1; c <= 6; c++) await ledger.beforeDispatch(grant, { call: c, attemptId: `${i}-${c}` });
      await ledger.close(grant, { verified: true }); advance(86400000);
    }
    expect((await ledger.snapshot()).committedNano).toBe(150 * 556032000);
    await expect(ledger.reserve(request('budget'))).rejects.toMatchObject({ code: 'model_budget_limit' });
  });
  it('period caps survive compact 600-entry history without resetting on a new JST day', async () => {
    // Boundary fixture represents already verified, cheap calls across 60 days;
    // no model or GCS calls are needed to exercise actual admission at the cap.
    const initial = Date.parse('2026-10-01T00:00:00Z'), { store, ledger, setTime } = await setup(initial);
    const exemplar = await ledger.reserve(request('prototype')); await ledger.close(exemplar, { verified: true });
    const state = JSON.parse(store.data), template = state.entries[0]; state.entries = [];
    for (let i = 0; i < 600; i++) {
      const time = initial + Math.floor(i / 10) * 86400000 + (i % 10) * 3600000;
      const entry = structuredClone(template); entry.id = crypto.randomUUID(); entry.request = publicLedgerHash(`req-${i}`); entry.fingerprint = publicLedgerHash(`fp-${i}`); entry.startedAt = time; entry.expiresAt = time + 90000;
      entry.calls = entry.calls.map((call: Record<string, unknown>) => ({ ...call, id: crypto.randomUUID(), day: new Date(time + 9 * 3600000).toISOString().slice(0, 10) })); state.entries.push(entry);
    }
    store.data = JSON.stringify(state); setTime(initial + 60 * 86400000);
    await expect(ledger.reserve(request('601'))).rejects.toMatchObject({ code: 'public_usage_limit' });
    expect((await ledger.snapshot()).requests).toBe(600);
    // 300 requests with 6 aggregate-estimated sends = period send cap, while
    // below both request and cost caps. Historical receipts/IDs remain bounded.
    state.entries = state.entries.slice(0, 300);
    for (const [index, entry] of state.entries.entries()) entry.calls = entry.calls.map((call: Record<string, unknown>, c: number) => ({ ...call, state: 'possibly-sent', attempt: publicLedgerHash(`${index}-${c}`), sentAt: entry.startedAt, http: { kind: 'aggregate-upper-estimate', nano: 7500, values: { totalTokenCount: 1 }, hash: publicLedgerHash('usage') } }));
    store.data = JSON.stringify(state);
    expect((await ledger.snapshot()).sends).toBe(1800);
    await expect(ledger.reserve(request('1801'))).rejects.toMatchObject({ code: 'public_usage_limit' });
    expect(Buffer.byteLength(store.data)).toBeLessThan(PUBLIC_LEDGER_LIMITS.maxBytes);
  });
  it('corrupt monetary assessments fail closed instead of lowering persisted usage', async () => {
    const { ledger, store } = await setup(), grant = await ledger.reserve(request('one'));
    await ledger.beforeDispatch(grant, { call: 1, attemptId: 'attempt-1' }); await ledger.observe(grant, observation());
    const state = JSON.parse(store.data); state.entries[0].calls[0].http.nano = 0; store.data = JSON.stringify(state);
    await expect(ledger.snapshot()).rejects.toMatchObject({ code: 'ledger_unavailable' });
  });
  it('persistent AI/whole stops and end date reject new dispatches as well as new requests', async () => {
    const { ledger, store } = await setup(), grant = await ledger.reserve(request('one'));
    await ledger.setStop({ ai: true, whole: false });
    await expect(ledger.beforeDispatch(grant, { call: 1, attemptId: 'a' })).rejects.toMatchObject({ code: 'ai_disabled' });
    expect((await new PublicLedger(store).snapshot()).stop.ai).toBe(true);
    await ledger.setStop({ ai: false, whole: true }); await expect(ledger.reserve(request('two'))).rejects.toMatchObject({ code: 'ai_disabled' });
    await ledger.setStop({ ai: false, whole: false }); expect((await ledger.snapshot()).stop).toEqual({ ai: true, whole: true });
    const fresh = await setup(); fresh.setTime(Date.parse(PUBLIC_LEDGER_LIMITS.expiresAt));
    await expect(fresh.ledger.reserve(request('end'))).rejects.toMatchObject({ code: 'ai_disabled' });
  });
  it('stored object has no request text, images, access code, tokens, response IDs or client cost', async () => {
    const { ledger, store } = await setup(), grant = await ledger.reserve(request('private-request'));
    await ledger.beforeDispatch(grant, { call: 1, attemptId: 'private-attempt' });
    const info = observation(1, 'private-attempt'); info.responseId = 'private-response-id'; info.modelVersion = 'private-model-text';
    await ledger.observe(grant, info);
    for (const sensitive of ['private-request', 'private-attempt', 'private-response-id', 'private-model-text', 'usageDiagnostics', 'modelCost']) expect(store.data).not.toContain(sensitive);
    await expect(ledger.close(JSON.parse(JSON.stringify(grant)), { verified: true })).rejects.toMatchObject({ code: 'stale_public_grant' });
  });
});

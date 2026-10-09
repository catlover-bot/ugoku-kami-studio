import { describe, expect, it } from 'vitest';
import { PublicLedger, LedgerStoreError, initialPublicLedger, publicLedgerHash, PUBLIC_LEDGER_LIMITS, PUBLIC_OBSERVATION_MAX_AGE_MS, type PublicLedgerStore, type PublicLedgerState } from '../src/public-ledger.js';
import { publicError } from '../src/errors.js';
import { assessVertexUsage, vertexUsageDiagnostics } from '../src/vertex-budget.js';

const start = Date.parse('2026-10-10T00:00:00Z');
const request = (id: string) => ({ requestId: id, fingerprint: publicLedgerHash(`fingerprint:${id}`), bindingHash: publicLedgerHash(`binding:${id}`), phase: 'public' as const });
class Store implements PublicLedgerStore {
  data = JSON.stringify({ ...initialPublicLedger(start), phase: 'public' });
  generation = 1; writes = 0; denied = false; readFailure = false;
  onWrite?: () => void;
  uncertain = false;
  async read() { if (this.readFailure) throw new LedgerStoreError('unavailable'); return { data: this.data, generation: String(this.generation) }; }
  async compareAndSwap(generation: string, data: string) {
    this.writes++; this.onWrite?.();
    if (this.denied) throw new LedgerStoreError('unavailable');
    if (generation !== String(this.generation)) throw new LedgerStoreError('conflict');
    this.data = data; this.generation++;
    if (this.uncertain) throw new LedgerStoreError('uncertain');
    return String(this.generation);
  }
  state(): PublicLedgerState { return JSON.parse(this.data); }
  replace(state: PublicLedgerState) { this.data = JSON.stringify(state); this.generation++; }
}
function setup() {
  let now = start;
  const store = new Store(), ledger = new PublicLedger(store, () => now, { requireObservation: true });
  return { store, ledger, setTime(value: number) { now = value; }, restart: () => new PublicLedger(store, () => now, { requireObservation: true }) };
}

describe('persistent monitoring observation fences public AI sends', () => {
  it('requires explicit successful observation without initializing old ledger data', async () => {
    const { store, ledger } = setup(), original = store.data;
    await expect(ledger.reserve(request('missing'))).rejects.toMatchObject({ code: 'ledger_unavailable' });
    expect(store.data).toBe(original); expect(store.writes).toBe(0);
    await ledger.confirmObservation(start);
    expect(await ledger.snapshot()).toMatchObject({ observation: { checkedAt: start }, requests: 0, committedNano: 0 });
    expect(await ledger.reserve(request('healthy'))).toHaveProperty('id');
  });

  it('accepts the exact reserved freshness boundary, but rejects the next send after it', async () => {
    const { store, ledger, setTime } = setup();
    await ledger.confirmObservation(start); setTime(start + PUBLIC_OBSERVATION_MAX_AGE_MS);
    const grant = await ledger.reserve(request('edge'));
    await ledger.beforeDispatch(grant, { call: 1, attemptId: 'sent-at-boundary' });
    setTime(start + PUBLIC_OBSERVATION_MAX_AGE_MS + 1); const prior = store.data;
    await expect(ledger.beforeDispatch(grant, { call: 2, attemptId: 'too-late' })).rejects.toMatchObject({ code: 'ledger_unavailable' });
    expect(store.data).toBe(prior);
    await ledger.close(grant, { verified: true });
    expect(await ledger.snapshot()).toMatchObject({ requests: 1, sends: 1, sentUnknownNano: PUBLIC_LEDGER_LIMITS.callNano, reservedNano: 0 });
  });

  it('restart neither renews observation nor erases historical sent uncertainty', async () => {
    const s = setup(); await s.ledger.confirmObservation(start);
    const grant = await s.ledger.reserve(request('original'));
    await s.ledger.beforeDispatch(grant, { call: 1, attemptId: 'original-attempt' });
    await s.ledger.close(grant, { verified: true });
    s.setTime(start + PUBLIC_OBSERVATION_MAX_AGE_MS + 1); const persisted = s.store.data;
    await expect(s.restart().reserve(request('after-restart'))).rejects.toMatchObject({ code: 'ledger_unavailable' });
    expect(s.store.data).toBe(persisted);
    await s.restart().confirmObservation(start + PUBLIC_OBSERVATION_MAX_AGE_MS + 1);
    const resumed = await s.restart().reserve(request('after-confirmation'));
    expect(resumed.id).not.toBe(grant.id);
    expect(await s.ledger.snapshot()).toMatchObject({ requests: 2, sends: 1, sentUnknownNano: 556032000, committedNano: 7 * 556032000 });
    expect(s.store.state().initializedAt).toBe(start);
  });

  it('a failed stop write cannot authorize sends after freshness expiry, or when the ledger read fails', async () => {
    const s = setup(); await s.ledger.confirmObservation(start);
    s.setTime(start + PUBLIC_OBSERVATION_MAX_AGE_MS - 1);
    const grant = await s.ledger.reserve(request('reserved'));
    s.store.denied = true;
    await expect(s.ledger.setStop({ ai: true, whole: true })).rejects.toMatchObject({ code: 'ledger_unavailable' });
    expect(s.store.state().stop).toEqual({ ai: false, whole: false });
    s.store.denied = false; s.setTime(start + PUBLIC_OBSERVATION_MAX_AGE_MS + 1);
    const unchanged = s.store.data, writes = s.store.writes;
    await expect(s.ledger.beforeDispatch(grant, { call: 1, attemptId: 'stale' })).rejects.toMatchObject({ code: 'ledger_unavailable' });
    await expect(s.restart().reserve(request('new'))).rejects.toMatchObject({ code: 'ledger_unavailable' });
    expect(s.store.data).toBe(unchanged); expect(s.store.writes).toBe(writes);
    s.store.readFailure = true;
    await expect(s.ledger.beforeDispatch(grant, { call: 1, attemptId: 'unreadable' })).rejects.toMatchObject({ code: 'ledger_unavailable' });
    expect(s.store.writes).toBe(writes);
  });

  it('rechecks freshness after a slow successful or uncertain CAS and retains its conservative hold', async () => {
    for (const uncertain of [false, true]) {
      const s = setup(); await s.ledger.confirmObservation(start);
      s.setTime(start + PUBLIC_OBSERVATION_MAX_AGE_MS - 1);
      const grant = await s.ledger.reserve(request('slow-send'));
      s.store.uncertain = uncertain;
      s.store.onWrite = () => s.setTime(start + PUBLIC_OBSERVATION_MAX_AGE_MS + 1);
      await expect(s.ledger.beforeDispatch(grant, { call: 1, attemptId: 'not-permitted-to-fetch' })).rejects.toMatchObject({ code: 'ledger_unavailable' });
      s.store.onWrite = undefined; s.store.uncertain = false;
      await s.ledger.close(grant, { verified: true });
      expect(await s.ledger.snapshot()).toMatchObject({ sends: 1, sentUnknownNano: 556032000, reservedNano: 0 });
    }
  });

  it('CAS contention cannot overwrite a newer monitor stop, even after a healthy heartbeat', async () => {
    const s = setup(); await s.ledger.confirmObservation(start);
    s.store.onWrite = () => {
      s.store.onWrite = undefined;
      const state = s.store.state(); state.stop = { ai: true, whole: true }; s.store.replace(state);
    };
    await expect(s.ledger.reserve(request('raced'))).rejects.toMatchObject({ code: 'ai_disabled' });
    await s.ledger.confirmObservation(start);
    expect(await s.ledger.snapshot()).toMatchObject({ requests: 0, stop: { ai: true, whole: true }, committedNano: 0 });
    await expect(s.restart().reserve(request('restart-stopped'))).rejects.toMatchObject({ code: 'ai_disabled' });
  });

  it('rejects missing, malformed, future, and rewound observations without resetting budget or dates', async () => {
    for (const checkedAt of [undefined, null, '2026-10-10T00:00:00Z', start + 1, start - 1, 0.5]) {
      const s = setup();
      s.store.data = JSON.stringify({ ...s.store.state(), observation: { checkedAt } });
      const original = s.store.data;
      await expect(s.ledger.reserve(request('invalid'))).rejects.toMatchObject({ code: 'ledger_unavailable' });
      expect(s.store.data).toBe(original); expect(s.store.writes).toBe(0);
    }
    const s = setup(); s.setTime(start + 1000); await s.ledger.confirmObservation(start + 1000);
    for (const checkedAt of [start - 1, start, start + 1001, NaN, Infinity]) {
      const original = s.store.data;
      await expect(s.ledger.confirmObservation(checkedAt)).rejects.toMatchObject({ code: 'ledger_unavailable' });
      expect(s.store.data).toBe(original);
    }
  });

  it('accepts late usage and verified closure while stale or stopped without renewing health', async () => {
    const s = setup(); await s.ledger.confirmObservation(start);
    const grant = await s.ledger.reserve(request('late'));
    await s.ledger.beforeDispatch(grant, { call: 1, attemptId: 'sent' });
    s.setTime(start + PUBLIC_OBSERVATION_MAX_AGE_MS + 1);
    await s.ledger.setStop({ ai: true, whole: true });
    await s.ledger.close(grant, { verified: true });
    const usage = { totalTokenCount: 100 };
    await s.ledger.observe(grant, { call: 1, attemptId: 'sent', source: 'http-response', observedAt: new Date(start).toISOString(), sdkVersion: '2.27.0', model: 'gemini-3.8-flash', modelVersion: null, responseId: null, finishReason: null, aborted: true, usageDiagnostics: vertexUsageDiagnostics(usage), modelCost: { ...assessVertexUsage(usage), reservationUsd: .556032 } });
    const before = s.store.state();
    await s.ledger.confirmObservation(start + PUBLIC_OBSERVATION_MAX_AGE_MS + 1);
    const after = s.store.state();
    expect(after.entries).toEqual(before.entries); expect(after.initializedAt).toBe(before.initializedAt); expect(after.expiresAt).toBe(before.expiresAt);
    expect(await s.ledger.snapshot()).toMatchObject({ stop: { ai: true, whole: true }, requests: 1, sends: 1, reservedNano: 0, aggregateUpperEstimateNano: 750000 });
    await expect(s.ledger.reserve(request('still-stopped'))).rejects.toMatchObject({ code: 'ai_disabled' });
  });

  it('keeps fixed store diagnostics internal and does not retain raw transport errors', async () => {
    for (const cause of [new LedgerStoreError('unavailable'), Error('sensitive transport text')]) {
      const ledger = new PublicLedger({ read: async () => { throw cause; }, compareAndSwap: async () => { throw Error('must not write'); } });
      let failure: unknown;
      try { await ledger.snapshot(); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'ledger_unavailable' });
      expect((failure as Error).cause).toBe(cause instanceof LedgerStoreError ? cause : undefined);
      expect(Object.keys(publicError(failure))).toEqual(['code', 'message']);
      expect(JSON.stringify(failure)).not.toContain('sensitive transport text');
    }
  });
});

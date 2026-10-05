import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelObservation } from './conversation.js';
import { AppError } from './errors.js';
import { assessVertexUsage } from './vertex-budget.js';

export const PUBLIC_LEDGER_LIMITS = Object.freeze({ modelNano: 85_000_000_000, callNano: 556_032_000, callsPerRequest: 6, requestsPerDay: 10, sendsPerDay: 30, requestsPerPeriod: 600, sendsPerPeriod: 1800, requestsPerMinute: 2, requestsPerHour: 4, preReleaseRequests: 6, preReleaseSends: 24, leaseMs: 90_000, expiresAt: '2026-12-01T14:59:00.000Z', maxBytes: 2_097_152 });
export type LedgerVersion = { generation: string; data: string };
export interface PublicLedgerStore {
  read(): Promise<LedgerVersion>;
  compareAndSwap(generation: string, data: string): Promise<string>;
}
export class LedgerStoreError extends Error {
  constructor(readonly kind: 'conflict' | 'unavailable' | 'uncertain' | 'missing') { super(`Public ledger store: ${kind}`); }
}
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().uuid();
const Time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Phase = z.enum(['pre-release', 'public']);
const UsageNumbers = z.strictObject({ promptTokenCount: z.number().int().min(0).max(10_000_000).optional(), candidatesTokenCount: z.number().int().min(0).max(10_000_000).optional(), thoughtsTokenCount: z.number().int().min(0).max(10_000_000).optional(), cachedContentTokenCount: z.number().int().min(0).max(10_000_000).optional(), toolUsePromptTokenCount: z.number().int().min(0).max(10_000_000).optional(), totalTokenCount: z.number().int().min(0).max(10_000_000).optional() });
const Assessment = z.strictObject({ values: UsageNumbers, kind: z.enum(['usage-estimate', 'aggregate-upper-estimate', 'sent-unknown']), nano: Money, hash: Hash });
const Call = z.strictObject({ id: Id, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), state: z.enum(['reserved', 'possibly-sent', 'released']), attempt: Hash.optional(), sentAt: Time.optional(), http: Assessment.optional(), sdk: Assessment.optional() });
const Entry = z.strictObject({ id: Id, request: Hash, fingerprint: Hash, binding: Hash, phase: Phase, startedAt: Time, expiresAt: Time, state: z.enum(['active', 'closed', 'expired']), calls: z.array(Call).length(6) });
const State = z.strictObject({ format: z.literal('ugoku-public-ledger-v1'), initializedAt: Time, expiresAt: z.literal(PUBLIC_LEDGER_LIMITS.expiresAt), phase: Phase, stop: z.strictObject({ ai: z.boolean(), whole: z.boolean() }), entries: z.array(Entry).max(600), receipts: z.array(Id).max(64) });
export type PublicLedgerState = z.infer<typeof State>;
type StoredEntry = z.infer<typeof Entry>;
type StoredCall = z.infer<typeof Call>;
export type PublicGrant = Readonly<{ id: string; callIds: readonly string[]; expiresAt: string }>;
export type PublicReservation = { requestId: string; fingerprint: string; bindingHash: string; phase: 'pre-release' | 'public' };
export const publicLedgerHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const publicLedgerJstDay = (time: number) => new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const unavailable = () => new AppError('ledger_unavailable', 'AIの利用状況を確認できません。作品を保ったまま手動で続けられます。', 503);
const invalidGrant = () => new AppError('stale_public_grant', 'このAI実行の許可は終了しています。', 409);

/** Deployment creates this object explicitly with GCS ifGenerationMatch=0.
 * Runtime never initializes, recreates, resets, or garbage-collects entries. */
export function initialPublicLedger(now = Date.now()): PublicLedgerState {
  return State.parse({ format: 'ugoku-public-ledger-v1', initializedAt: now, expiresAt: PUBLIC_LEDGER_LIMITS.expiresAt, phase: 'pre-release', stop: { ai: false, whole: false }, entries: [], receipts: [] });
}
function parse(data: string): PublicLedgerState {
  try {
    if (Buffer.byteLength(data) > PUBLIC_LEDGER_LIMITS.maxBytes) throw new Error();
    const state = State.parse(JSON.parse(data));
    const requests = new Set<string>(), fingerprints = new Set<string>(), ids = new Set<string>(), attempts = new Set<string>();
    let active = 0;
    for (const entry of state.entries) {
      if (entry.expiresAt !== entry.startedAt + PUBLIC_LEDGER_LIMITS.leaseMs || entry.startedAt < state.initializedAt || requests.has(entry.request) || fingerprints.has(entry.fingerprint) || ids.has(entry.id)) throw new Error();
      requests.add(entry.request); fingerprints.add(entry.fingerprint); ids.add(entry.id);
      if (entry.state === 'active') active++;
      for (const call of entry.calls) {
        if (ids.has(call.id) || (call.attempt && attempts.has(call.attempt))) throw new Error();
        ids.add(call.id); if (call.attempt) attempts.add(call.attempt);
        if ((call.state === 'possibly-sent') !== (call.attempt !== undefined && call.sentAt !== undefined)) throw new Error();
        if (call.state !== 'possibly-sent' && (call.http || call.sdk || call.attempt || call.sentAt !== undefined)) throw new Error();
        if (entry.state !== 'active' && call.state === 'reserved') throw new Error();
        if (call.sentAt !== undefined && (call.sentAt < entry.startedAt || call.sentAt >= entry.expiresAt || call.day !== publicLedgerJstDay(call.sentAt))) throw new Error();
        for (const assessment of [call.http, call.sdk]) if (assessment) {
          if (assessment.kind === 'sent-unknown') { if (assessment.nano < PUBLIC_LEDGER_LIMITS.callNano) throw new Error(); }
          else {
            const verified = assessVertexUsage(assessment.values);
            if (verified.kind !== assessment.kind || verified.estimateUsd === null || Math.round(verified.estimateUsd * 1e9) !== assessment.nano) throw new Error();
          }
        }
      }
    }
    if (active > 1 || new Set(state.receipts).size !== state.receipts.length) throw new Error();
    return state;
  } catch { throw unavailable(); }
}
function callCost(call: StoredCall): { kind: 'reserved' | 'usage' | 'aggregate' | 'unknown' | 'released'; nano: number } {
  if (call.state === 'released') return { kind: 'released', nano: 0 };
  if (call.state === 'reserved') return { kind: 'reserved', nano: PUBLIC_LEDGER_LIMITS.callNano };
  const seen = [call.http, call.sdk].filter(item => item !== undefined);
  const disagreement = call.http && call.sdk && Object.entries(call.http.values).some(([key, value]) => { const other = call.sdk!.values[key as keyof typeof call.sdk.values]; return other !== undefined && other !== value; });
  if (!seen.length || disagreement || seen.some(item => item.kind === 'sent-unknown')) return { kind: 'unknown', nano: Math.max(PUBLIC_LEDGER_LIMITS.callNano, ...seen.map(item => item.nano)) };
  return { kind: seen.every(item => item.kind === 'usage-estimate') ? 'usage' : 'aggregate', nano: Math.max(...seen.map(item => item.nano)) };
}
export function publicLedgerSummary(state: PublicLedgerState, now = Date.now()) {
  const day = publicLedgerJstDay(now), calls = state.entries.flatMap(entry => entry.calls), today = calls.filter(call => call.day === day);
  const total = (kind: ReturnType<typeof callCost>['kind']) => calls.map(callCost).filter(item => item.kind === kind).reduce((sum, item) => sum + item.nano, 0);
  const sent = (values: StoredCall[]) => values.filter(call => call.state === 'possibly-sent').length;
  const pending = (values: StoredCall[]) => values.filter(call => call.state === 'reserved').length;
  const committedNano = calls.map(callCost).reduce((sum, item) => sum + item.nano, 0);
  return { phase: state.phase, stop: { ...state.stop }, expiresAt: state.expiresAt, day, requests: state.entries.length, requestsToday: state.entries.filter(entry => publicLedgerJstDay(entry.startedAt) === day).length, sends: sent(calls), sendsToday: sent(today), pendingSends: pending(calls), pendingSendsToday: pending(today), preReleaseRequests: state.entries.filter(entry => entry.phase === 'pre-release').length, preReleaseSends: sent(state.entries.filter(entry => entry.phase === 'pre-release').flatMap(entry => entry.calls)), committedNano, usageEstimateNano: total('usage'), aggregateUpperEstimateNano: total('aggregate'), sentUnknownNano: total('unknown'), reservedNano: total('reserved'), modelBudgetNano: PUBLIC_LEDGER_LIMITS.modelNano, active: state.entries.some(entry => entry.state === 'active'), hardBillingCap: false as const };
}

/** A single generation-CAS object is the authority, including after restart.
 * WeakMap grants are internal capabilities, never accepted from request JSON.
 * Every possibly-sent transition must finish before the provider's fetch; the
 * caller MUST check its AbortSignal and deadline again after this await. */
export class PublicLedger {
  private grants = new WeakMap<PublicGrant, { id: string; binding: string }>();
  constructor(private readonly store: PublicLedgerStore, private readonly now: () => number = Date.now) {}
  private async read() {
    try { const value = await this.store.read(); return { ...value, state: parse(value.data) }; }
    catch { throw unavailable(); }
  }
  private async change<T>(apply: (state: PublicLedgerState, now: number) => T): Promise<T> {
    const operation = randomUUID();
    for (let attempt = 0; attempt < 4; attempt++) {
      const { generation, state } = await this.read();
      const result = apply(state, this.now());
      state.receipts.push(operation); state.receipts = state.receipts.slice(-64);
      const data = JSON.stringify(state);
      parse(data);
      try { await this.store.compareAndSwap(generation, data); return result; }
      catch (error) {
        if (error instanceof LedgerStoreError && error.kind === 'conflict') continue;
        // An ambiguous write is never blindly retried. A later strongly
        // consistent read must prove this exact operation was committed.
        if (error instanceof LedgerStoreError && error.kind === 'uncertain') {
          const proof = await this.read();
          if (proof.state.receipts.includes(operation)) return result;
        }
        throw unavailable();
      }
    }
    throw unavailable();
  }
  private recoverExpired(state: PublicLedgerState, now: number) {
    for (const entry of state.entries) if (entry.state === 'active' && entry.expiresAt <= now) {
      entry.state = 'expired';
      for (const call of entry.calls) if (call.state === 'reserved') call.state = 'released';
    }
  }
  private entry(state: PublicLedgerState, grant: PublicGrant): StoredEntry {
    const capability = this.grants.get(grant);
    const entry = capability && state.entries.find(item => item.id === capability.id && item.binding === capability.binding);
    if (!entry) throw invalidGrant();
    return entry;
  }
  private available(state: PublicLedgerState, now: number) {
    if (now >= Date.parse(state.expiresAt) || state.stop.ai || state.stop.whole) throw new AppError('ai_disabled', 'AIの公開利用は停止しています。作品を保ったまま手動で続けられます。', 503);
  }
  async reserve(input: PublicReservation): Promise<PublicGrant> {
    const checked = z.strictObject({ requestId: z.string().min(1).max(200), fingerprint: Hash, bindingHash: Hash, phase: Phase }).parse(input);
    const requestHash = publicLedgerHash(checked.requestId), id = randomUUID(), callIds = Array.from({ length: 6 }, () => randomUUID());
    const grant = await this.change((state, now) => {
      this.available(state, now); this.recoverExpired(state, now);
      if (state.phase !== checked.phase) throw new AppError('ai_disabled', 'AIの利用段階が切り替わりました。', 503);
      if (state.entries.some(entry => entry.request === requestHash || entry.fingerprint === checked.fingerprint)) throw new AppError('duplicate_request', '同じAI依頼は受け付け済みです。元の実行結果を確認してください。', 409);
      if (state.entries.some(entry => entry.state === 'active')) throw new AppError('instance_limit', '別のAI依頼を処理中です。時間をおいてお試しください。', 429);
      const waitingUntil = [ { ms: 60_000, max: 2 }, { ms: 3_600_000, max: 4 } ].map(window => {
        const starts = state.entries.filter(entry => entry.startedAt > now - window.ms).map(entry => entry.startedAt).sort((a, b) => a - b);
        return starts.length >= window.max ? starts[starts.length - window.max] + window.ms : 0;
      });
      const retryAt = Math.max(...waitingUntil);
      if (retryAt > now) throw new AppError('instance_limit', 'AIへの依頼が続いています。時間をおいて再度お試しください。', 429, { retryAfterMs: retryAt - now, retryAt: new Date(retryAt).toISOString() });
      const s = publicLedgerSummary(state, now), preCalls = state.entries.filter(entry => entry.phase === 'pre-release').flatMap(entry => entry.calls).filter(call => call.state !== 'released').length;
      if (s.requests >= 600 || s.requestsToday >= 10 || s.sends + s.pendingSends + 6 > 1800 || s.sendsToday + s.pendingSendsToday + 6 > 30 || (checked.phase === 'pre-release' && (s.preReleaseRequests >= 6 || preCalls + 6 > 24))) throw new AppError('public_usage_limit', 'AIの利用回数の上限に達しました。手動で制作を続けられます。', 429);
      if (s.committedNano + 6 * PUBLIC_LEDGER_LIMITS.callNano > PUBLIC_LEDGER_LIMITS.modelNano) throw new AppError('model_budget_limit', 'AIの費用管理上限に達する見込みのため停止しました。', 429);
      const expiresAt = now + PUBLIC_LEDGER_LIMITS.leaseMs;
      state.entries.push({ id, request: requestHash, fingerprint: checked.fingerprint, binding: checked.bindingHash, phase: checked.phase, startedAt: now, expiresAt, state: 'active', calls: callIds.map(callId => ({ id: callId, day: publicLedgerJstDay(now), state: 'reserved' })) });
      return Object.freeze({ id, callIds: Object.freeze(callIds), expiresAt: new Date(expiresAt).toISOString() });
    });
    this.grants.set(grant, { id, binding: checked.bindingHash });
    return grant;
  }
  async beforeDispatch(grant: PublicGrant, dispatch: { call: number; attemptId: string }): Promise<void> {
    const { call, attemptId } = z.strictObject({ call: z.number().int().min(1).max(6), attemptId: z.string().min(1).max(200) }).parse(dispatch);
    await this.change((state, now) => {
      this.available(state, now);
      const entry = this.entry(state, grant), item = entry.calls[call - 1], attempt = publicLedgerHash(attemptId);
      if (entry.state !== 'active' || now >= entry.expiresAt || item.state !== 'reserved') throw invalidGrant();
      if (state.entries.some(other => other.calls.some(value => value.attempt === attempt))) throw invalidGrant();
      // Day rollover moves only this previously reserved permit. Requests keep
      // their admission day; sends belong to the actual JST dispatch day.
      const today = publicLedgerJstDay(now), summary = publicLedgerSummary(state, now);
      if (item.day !== today && summary.sendsToday + summary.pendingSendsToday >= 30) throw new AppError('public_usage_limit', '本日のAI呼び出し上限に達しました。', 429);
      if (summary.committedNano > PUBLIC_LEDGER_LIMITS.modelNano) throw new AppError('model_budget_limit', 'AIの費用管理上限に達したため停止しました。', 429);
      item.day = today; item.state = 'possibly-sent'; item.attempt = attempt; item.sentAt = now;
    });
  }
  async observe(grant: PublicGrant, observation: ModelObservation): Promise<void> {
    const slot = observation.call - 1;
    if (!Number.isInteger(slot) || slot < 0 || slot >= 6 || !['http-response', 'sdk-response'].includes(observation.source)) throw invalidGrant();
    // Reconstruct only the six numeric usage fields and their absence states.
    // Never persist response content, IDs, model text, signatures or credentials.
    const usage: Record<string, unknown> = {};
    for (const key of ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'cachedContentTokenCount', 'toolUsePromptTokenCount', 'totalTokenCount'] as const) {
      const field = observation.usageDiagnostics.fields[key];
      if (field.state === 'null') usage[key] = null;
      else if (field.state === 'invalid') usage[key] = 'invalid';
      else if (field.state !== 'missing') usage[key] = field.value;
    }
    const assessment = assessVertexUsage(usage), nano = assessment.estimateUsd === null ? PUBLIC_LEDGER_LIMITS.callNano : Math.round(assessment.estimateUsd * 1e9);
    const values = Object.fromEntries(Object.entries(usage).filter(([, value]) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000));
    const next = { values: UsageNumbers.parse(values), kind: assessment.kind, nano, hash: publicLedgerHash(JSON.stringify(usage)) };
    await this.change(state => {
      const item = this.entry(state, grant).calls[slot];
      if (item.state !== 'possibly-sent' || item.attempt !== publicLedgerHash(observation.attemptId)) throw invalidGrant();
      const source = observation.source === 'http-response' ? 'http' : 'sdk';
      const prior = item[source];
      if (!prior) item[source] = next;
      else if (prior.hash !== next.hash) item[source] = { values: prior.values, kind: 'sent-unknown', nano: Math.max(prior.nano, next.nano, PUBLIC_LEDGER_LIMITS.callNano), hash: prior.hash };
      if (publicLedgerSummary(state).committedNano > PUBLIC_LEDGER_LIMITS.modelNano) state.stop.ai = true;
    });
  }
  async close(grant: PublicGrant, proof: { verified: true }): Promise<void> {
    if (proof?.verified !== true) throw invalidGrant();
    await this.change(state => {
      const entry = this.entry(state, grant);
      if (entry.state === 'active') entry.state = 'closed';
      for (const call of entry.calls) if (call.state === 'reserved') call.state = 'released';
    });
  }
  async setStop(stop: { ai: boolean; whole: boolean }): Promise<void> {
    const checked = z.strictObject({ ai: z.boolean(), whole: z.boolean() }).parse(stop);
    // Runtime stop writes are monotonic: an outdated monitor cannot clear an
    // operator stop. Resuming requires a separately reviewed deployment action.
    await this.change(state => { state.stop = { ai: state.stop.ai || checked.ai, whole: state.stop.whole || checked.whole }; });
  }
  async setPhase(phase: 'public'): Promise<void> {
    if (phase !== 'public') throw unavailable();
    await this.change(state => { state.phase = phase; });
  }
  async snapshot() { const { generation, state } = await this.read(); return { generation, ...publicLedgerSummary(state, this.now()) }; }
}

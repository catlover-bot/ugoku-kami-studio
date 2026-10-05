import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Ledger, type ClosureReport, type LedgerInitial, type TrialGrant, type TrialPhase, type RejectedRequestReport, type VerifyRejectedRequest } from '../../scripts/trial-ledger.js';
vi.mock('node:fs', async (importOriginal) => { const actual = await importOriginal<typeof import('node:fs')>(); return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }; });
const dirs: string[] = [], opened: Ledger[] = [];
const HASH = 'a'.repeat(64);
const initial = (): LedgerInitial => ({ trialId: 'goal010', budget: { grossLimitNanoUsd: 5_000_000_000, modelPoolNanoUsd: 3_900_000_000, priorInfrastructureNanoUsd: 171_668_569, additionalInfrastructureNanoUsd: 700_000_000, safetyNanoUsd: 228_331_431, callReserveNanoUsd: 556_032_000, maxRequests: 4, maxCalls: 24 }, historicalReconciliation: { requestId: 'old-request', reservationId: 'old-reservation', runId: 'old-run', sourceSha: '4'.repeat(40), originalLedgerHash: HASH, evidenceHashes: ['b'.repeat(64)], reservedCalls: 6, sentUnknownCalls: 2, priorRunSeconds: 339.978, priorBuildSeconds: 128.385 } });
const binding = { sessionId: 'session-one', baseRevision: 1, baseHash: HASH, sourceSha: 'c'.repeat(40), revision: 'trial-00002-test' };
function path() { const dir = fs.mkdtempSync(join(tmpdir(), 'ugoku-ledger-test-')); dirs.push(dir); return join(dir, 'ledger.jsonl'); }
function create(p = path()) { const ledger = Ledger.create(p, initial()); opened.push(ledger); return ledger; }
function reopen(p: string) { const ledger = Ledger.open(p); opened.push(ledger); return ledger; }
function reserve(ledger: Ledger, phase: TrialPhase, maxCalls: number) { return ledger.reserveRequest({ requestId: 'request-' + phase, phase, maxCalls, binding }); }
function report(grant: TrialGrant, count: number, usd?: number): ClosureReport { return { requestId: grant.requestId, grantId: grant.grantId, binding: grant.binding, dispatchClosed: true, completeAttemptList: true, sdkFetchRetryGuard: 1, serverIdentity: 'verified-server', proofHashes: [HASH], attempts: grant.callIds.slice(0, count).map(attemptId => ({ attemptId, dispatch: 'sent', cost: usd === undefined ? { kind: 'sent-unknown' } : { kind: 'usage-estimate', usd }, observationHashes: [HASH] })) }; }
function finish(ledger: Ledger, grant: TrialGrant, count: number, usd?: number) { expect(ledger.markForwarded(grant)).toBe(true); ledger.reconcile(report(grant, count, usd), () => true); }
function rejection(grant: TrialGrant): RejectedRequestReport { return { requestId: grant.requestId, grantId: grant.grantId, binding: grant.binding, httpStatus: 429, errorCode: 'instance_limit', classification: 'audited-before-run-rejection', proofHashes: [HASH, 'f'.repeat(64)], serverIdentity: 'audited-pinned-service-source' }; }
function prepareC() {
  const ledger = create(); finish(ledger, reserve(ledger, 'cancel', 1), 1);
  const b = reserve(ledger, 'recovery', 3), r = report(b, 3, .0277275); r.attempts.forEach(a => { a.cost = { kind: 'aggregate-upper-estimate', usd: .0277275 }; }); ledger.markForwarded(b); ledger.reconcile(r, () => true);
  return { ledger, c: reserve(ledger, 'infeasible', 3) };
}
afterEach(() => { vi.restoreAllMocks(); for (const ledger of opened.splice(0)) ledger.close(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('durable bounded trial ledger', () => {
  it('preserves historical six-to-two evidence, prior infra/time, and cumulative budget without charging outer+inner twice', () => {
    const ledger = create(), s = ledger.getSnapshot();
    expect(s.committedNanoUsd).toBe(1_112_064_000); expect(s.historicalAmounts).toEqual({ reservedBeforeNanoUsd: 3_336_192_000, retainedSentUnknownNanoUsd: 1_112_064_000, releasedNotSentNanoUsd: 2_224_128_000 }); expect(s.historicalReconciliation.reservedCalls - s.historicalReconciliation.sentUnknownCalls).toBe(4);
    expect(s.historicalReconciliation.priorRunSeconds).toBe(339.978); expect(s.historicalReconciliation.priorBuildSeconds).toBe(128.385); expect(s.budget.priorInfrastructureNanoUsd).toBe(171_668_569);
    expect(s.grossCommittedAndInfraNanoUsd).toBe(2_212_064_000); expect(s.requestsConsumed).toBe(1);
    const before = fs.readFileSync(ledger.path), grant = reserve(ledger, 'cancel', 1);
    expect(grant.priorCommittedNanoUsd).toBe(1_112_064_000); expect(ledger.getSnapshot().committedNanoUsd).toBe(1_668_096_000); expect(fs.readFileSync(ledger.path).subarray(0, before.length)).toEqual(before);
    expect(() => Ledger.create(ledger.path, initial())).toThrow();
  });
  it('protects phase order, later minimum, global pool and exact duplicate binding', () => {
    const ledger = create(); expect(() => ledger.reserveRequest({ requestId: 'old-request', phase: 'cancel', maxCalls: 1, binding })).toThrow('Historical'); expect(() => reserve(ledger, 'recovery', 1)).toThrow(); expect(() => reserve(ledger, 'cancel', 2)).toThrow();
    const a = reserve(ledger, 'cancel', 1), size = fs.statSync(ledger.path).size;
    expect(reserve(ledger, 'cancel', 1)).toEqual(a); expect(fs.statSync(ledger.path).size).toBe(size);
    expect(() => ledger.reserveRequest({ requestId: a.requestId, phase: 'cancel', maxCalls: 1, binding: { ...binding, baseRevision: 2 } })).toThrow();
    expect(() => reserve(ledger, 'recovery', 3)).toThrow(); finish(ledger, a, 1);
    const b = reserve(ledger, 'recovery', 3); finish(ledger, b, 3);
    expect(() => reserve(ledger, 'infeasible', 2)).toThrow(); const c = reserve(ledger, 'infeasible', 1); finish(ledger, c, 1);
    expect(ledger.getSnapshot().committedNanoUsd).toBe(3_892_224_000); expect(ledger.getSnapshot().requestsConsumed).toBe(4);
    expect(() => ledger.reserveRequest({ requestId: 'fifth', phase: 'infeasible', maxCalls: 1, binding })).toThrow();
  });
  it('requires durable forward before a real attempt and never reissues duplicate forward authority', () => {
    const ledger = create(), a = reserve(ledger, 'cancel', 1); expect(() => ledger.reconcile(report(a, 0), () => true)).toThrow();
    expect(ledger.markForwarded(a)).toBe(true); expect(ledger.markForwarded(a)).toBe(false);
    expect(() => ledger.closeUnforwarded({ ...a, reason: 'not sent' })).toThrow();
    ledger.close(); const restored = reopen(ledger.path); expect(restored.markForwarded(a)).toBe(false); expect(restored.getSnapshot().grants[0].calls[0].state).toBe('possibly-sent');
    expect(restored.getSnapshot().committedNanoUsd).toBe(1_668_096_000);
  });
  it('allows only unforwarded local release and consumes that request slot', () => {
    const ledger = create(), a = reserve(ledger, 'cancel', 1), close = { requestId: a.requestId, grantId: a.grantId, reason: 'pre-dispatch rejection' };
    ledger.closeUnforwarded(close); const bytes = fs.readFileSync(ledger.path); ledger.closeUnforwarded(close);
    expect(fs.readFileSync(ledger.path)).toEqual(bytes); expect(ledger.getSnapshot().committedNanoUsd).toBe(1_112_064_000); expect(ledger.getSnapshot().requestsConsumed).toBe(2); expect(() => ledger.markForwarded(a)).toThrow();
  });
  it('rejects unverified/incomplete closures, wrong source, hidden SDK retries, duplicate or foreign attempt IDs', () => {
    const ledger = create(), a = reserve(ledger, 'cancel', 1); ledger.markForwarded(a);
    expect(() => ledger.reconcile(report(a, 1), () => false)).toThrow();
    expect(() => ledger.reconcile(report(a, 1), (() => Promise.resolve(true)) as unknown as () => boolean)).toThrow();
    expect(() => ledger.reconcile({ ...report(a, 1), dispatchClosed: false } as unknown as ClosureReport, () => true)).toThrow();
    expect(() => ledger.reconcile({ ...report(a, 1), completeAttemptList: false } as unknown as ClosureReport, () => true)).toThrow();
    expect(() => ledger.reconcile({ ...report(a, 1), sdkFetchRetryGuard: 2 } as unknown as ClosureReport, () => true)).toThrow();
    expect(() => ledger.reconcile({ ...report(a, 1), binding: { ...binding, sourceSha: 'd'.repeat(40) } }, () => true)).toThrow();
    const r = report(a, 1); expect(() => ledger.reconcile({ ...r, attempts: [...r.attempts, ...r.attempts] }, () => true)).toThrow();
    expect(() => ledger.reconcile({ ...r, attempts: [{ ...r.attempts[0], attemptId: '00000000-0000-4000-8000-000000000000' }] }, () => true)).toThrow();
    expect(ledger.getSnapshot().committedNanoUsd).toBe(1_668_096_000);
  });
  it('reconciles a six-permit grant with only two sent after authenticated closure and refuses conflicting settlement', () => {
    // Use a generic smaller per-call planning reserve so a six-permit C fits after two prior request slots.
    const p = path(), config = initial(); config.budget.callReserveNanoUsd = 100_000_000;
    const ledger = Ledger.create(p, config); opened.push(ledger); finish(ledger, reserve(ledger, 'cancel', 1), 1, .001); finish(ledger, reserve(ledger, 'recovery', 1), 1, .001);
    const c = reserve(ledger, 'infeasible', 6); ledger.markForwarded(c); const r = report(c, 2); ledger.reconcile(r, () => true);
    expect(ledger.getSnapshot().grants[2].calls.filter(x => x.state === 'released-not-sent')).toHaveLength(4); expect(ledger.getSnapshot().committedNanoUsd).toBe(402_000_000);
    const bytes = fs.readFileSync(p); ledger.reconcile(r, () => { throw Error('already recorded idempotently'); }); expect(fs.readFileSync(p)).toEqual(bytes);
    expect(() => ledger.reconcile(report(c, 1), () => true)).toThrow(); ledger.close(); const restored = reopen(p); expect(restored.getSnapshot().committedNanoUsd).toBe(402_000_000);
  });
  it('retains all six sent calls and observed over-reserve estimates without clamping to create budget', () => {
    const config = initial(); config.budget.callReserveNanoUsd = 100_000_000; const ledger = Ledger.create(path(), config); opened.push(ledger);
    finish(ledger, reserve(ledger, 'cancel', 1), 1, .001); finish(ledger, reserve(ledger, 'recovery', 1), 1, .001); const c = reserve(ledger, 'infeasible', 6); ledger.markForwarded(c);
    const r = report(c, 6, 1); r.attempts[0].cost = { kind: 'aggregate-upper-estimate', usd: 1.2 }; ledger.reconcile(r, () => true);
    expect(ledger.getSnapshot().committedNanoUsd).toBe(6_402_000_000); expect(ledger.getSnapshot().remainingModelNanoUsd).toBeLessThan(0); expect(ledger.getSnapshot().grants[2].calls.some(x => x.state === 'released-not-sent')).toBe(false);
  });
  it('rejects a cost estimate for possibly-sent records and keeps the reservation after cancellation', () => {
    const ledger = create(), a = reserve(ledger, 'cancel', 1); ledger.markForwarded(a); const r = report(a, 1, .001); r.attempts[0].dispatch = 'possibly-sent';
    expect(() => ledger.reconcile(r, () => true)).toThrow(); r.attempts[0].cost = { kind: 'sent-unknown' }; ledger.reconcile(r, () => true); expect(ledger.getSnapshot().committedNanoUsd).toBe(1_668_096_000);
  });
  it('appends an audited pre-run C rejection without inventing a run closure or restoring request/call permits', () => {
    const { ledger, c } = prepareC(); ledger.markForwarded(c); const before = ledger.getSnapshot(), bytes = fs.readFileSync(ledger.path);
    expect(before.committedNanoUsd).toBe(3_419_374_500);
    ledger.reconcileRejectedRequest(rejection(c), (r, g) => r.classification === 'audited-before-run-rejection' && g.grantId === c.grantId);
    const after = ledger.getSnapshot(); expect(after.committedNanoUsd).toBe(1_751_278_500); expect(after.requestsConsumed).toBe(4); expect(after.callPermitsConsumed).toBe(9);
    expect(after.historicalAmounts).toEqual(before.historicalAmounts); expect(after.grants.slice(0, 2)).toEqual(before.grants.slice(0, 2));
    expect(after.grants[2]).toMatchObject({ forwarded: true, closed: true, rejection: rejection(c) }); expect(after.grants[2].closure).toBeUndefined();
    expect(after.grants[2].calls.every(call => call.state === 'released-not-sent' && call.committedNanoUsd === 0)).toBe(true);
    expect(fs.readFileSync(ledger.path).subarray(0, bytes.length)).toEqual(bytes);
    expect(() => ledger.reserveRequest({ requestId: 'retry-forbidden', phase: 'infeasible', maxCalls: 1, binding })).toThrow();
    ledger.close(); const restored = reopen(ledger.path); expect(restored.getSnapshot()).toEqual(after); expect(restored.markForwarded(c)).toBe(false);
  });
  it('requires exact matching pre-run rejection evidence and a literal trusted verifier result', () => {
    const { ledger, c } = prepareC(), r = rejection(c); expect(() => ledger.reconcileRejectedRequest(r, () => true)).toThrow(); ledger.markForwarded(c);
    const bytes = fs.readFileSync(ledger.path);
    for (const verify of [undefined, () => false, () => Promise.resolve(true)]) expect(() => ledger.reconcileRejectedRequest(r, verify as unknown as VerifyRejectedRequest)).toThrow();
    for (const change of [{ httpStatus: 503 }, { errorCode: 'provider_quota' }, { proofHashes: [] }, { binding: { ...binding, baseRevision: 2 } }, { requestId: 'unknown' }, { dispatchClosed: true }, { classification: 'assumed-not-sent' }]) expect(() => ledger.reconcileRejectedRequest({ ...r, ...change } as RejectedRequestReport, () => true)).toThrow();
    expect(fs.readFileSync(ledger.path)).toEqual(bytes); expect(ledger.getSnapshot().committedNanoUsd).toBe(3_419_374_500);
  });
  it('makes exact rejection evidence idempotent and refuses changed evidence or overwriting a real run settlement', () => {
    const { ledger, c } = prepareC(); ledger.markForwarded(c); const r = rejection(c); ledger.reconcileRejectedRequest(r, () => true); const bytes = fs.readFileSync(ledger.path);
    ledger.reconcileRejectedRequest(r, () => true); expect(fs.readFileSync(ledger.path)).toEqual(bytes);
    expect(() => ledger.reconcileRejectedRequest({ ...r, proofHashes: ['e'.repeat(64)] }, () => true)).toThrow('Conflicting');
    expect(() => ledger.reconcileRejectedRequest(r, undefined as unknown as VerifyRejectedRequest)).toThrow();
    expect(() => ledger.reconcileRejectedRequest(rejection(ledger.getSnapshot().grants[1].grant), () => true)).toThrow();
    expect(() => ledger.reconcile(report(c, 0), () => true)).toThrow(); expect(fs.readFileSync(ledger.path)).toEqual(bytes);
  });
  it('fails closed on torn lines, hash changes and simultaneous writers', () => {
    const ledger = create(), p = ledger.path; expect(() => Ledger.open(p)).toThrow(); const lock = JSON.parse(fs.readFileSync(p + '.lock', 'utf8')); expect(() => Ledger.clearAbandonedLock(p, lock)).toThrow('alive');
    ledger.close(); const original = fs.readFileSync(p); fs.appendFileSync(p, '{"partial":'); expect(() => Ledger.open(p)).toThrow('torn');
    fs.writeFileSync(p, original.toString().replace('goal010', 'goal011')); expect(() => Ledger.open(p)).toThrow('hash chain');
  });
  it('retains a completed write after fsync error; caller cannot continue or silently retry in memory', () => {
    const ledger = create(), p = ledger.path; vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw Error('synthetic fsync failure'); });
    expect(() => reserve(ledger, 'cancel', 1)).toThrow(); expect(() => ledger.getSnapshot()).toThrow('uncertain'); ledger.close();
    const restored = reopen(p); expect(restored.getSnapshot().committedNanoUsd).toBe(1_668_096_000); expect(reserve(restored, 'cancel', 1).callIds).toHaveLength(1);
  });
  it('recovers only a proven dead writer and keeps a forwarded unknown grant across process crash', () => {
    const p = path(), module = pathToFileURL(resolve('scripts/trial-ledger.ts')).href;
    const code = `import {Ledger} from ${JSON.stringify(module)}; const l=Ledger.create(${JSON.stringify(p)},${JSON.stringify(initial())});const g=l.reserveRequest(${JSON.stringify({ requestId: 'request-cancel', phase: 'cancel', maxCalls: 1, binding })});l.markForwarded(g);process.kill(process.pid,'SIGKILL');`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8' }); expect(child.signal).toBe('SIGKILL');
    expect(() => Ledger.open(p)).toThrow(); const lock = JSON.parse(fs.readFileSync(p + '.lock', 'utf8')); expect(lock.pid).toBe(child.pid);
    expect(() => Ledger.clearAbandonedLock(p, { ...lock, token: '00000000-0000-4000-8000-000000000000' })).toThrow(); Ledger.clearAbandonedLock(p, lock);
    const restored = reopen(p); expect(restored.getSnapshot().committedNanoUsd).toBe(1_668_096_000); expect(restored.getSnapshot().grants[0].calls[0].state).toBe('possibly-sent');
  });
});

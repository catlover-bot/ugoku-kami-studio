import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, type ClosureReport, type RejectedRequestReport, type SupplementalAuthorization, type TrialGrant, type VerifySupplementalAuthorization } from '../../scripts/trial-ledger.js';

const H = 'a'.repeat(64), paths: string[] = [], ledgers: Ledger[] = [];
const binding = { sessionId: 'session-fixture', baseRevision: 3, baseHash: H, sourceSha: 'b'.repeat(40), revision: 'trial-00001-fixture' };
const rejection = (g: TrialGrant): RejectedRequestReport => ({ requestId: g.requestId, grantId: g.grantId, binding: g.binding, httpStatus: 429, errorCode: 'instance_limit', classification: 'audited-before-run-rejection', proofHashes: [H], serverIdentity: 'audited-app-fixture' });
const finish = (ledger: Ledger, g: TrialGrant, usd?: number) => {
  ledger.markForwarded(g);
  ledger.reconcile({ requestId: g.requestId, grantId: g.grantId, binding: g.binding, dispatchClosed: true, completeAttemptList: true, sdkFetchRetryGuard: 1, serverIdentity: 'fixture', proofHashes: [H], attempts: g.callIds.map(attemptId => ({ attemptId, dispatch: 'sent', observationHashes: [H], cost: usd === undefined ? { kind: 'sent-unknown' } : { kind: 'aggregate-upper-estimate', usd } })) }, () => true);
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ugoku-supplemental-')); paths.push(dir);
  const ledger = Ledger.create(join(dir, 'ledger.jsonl'), { trialId: 'goal010', budget: { grossLimitNanoUsd: 5_000_000_000, modelPoolNanoUsd: 3_900_000_000, priorInfrastructureNanoUsd: 171_668_569, additionalInfrastructureNanoUsd: 700_000_000, safetyNanoUsd: 228_331_431, callReserveNanoUsd: 556_032_000, maxRequests: 4, maxCalls: 24 }, historicalReconciliation: { requestId: 'old-1', reservationId: 'old-reserve', runId: 'old-run', sourceSha: 'c'.repeat(40), originalLedgerHash: H, evidenceHashes: [H], reservedCalls: 6, sentUnknownCalls: 2, priorRunSeconds: 339.978, priorBuildSeconds: 128.385 } }); ledgers.push(ledger);
  finish(ledger, ledger.reserveRequest({ requestId: 'old-A', phase: 'cancel', maxCalls: 1, binding }));
  finish(ledger, ledger.reserveRequest({ requestId: 'old-B', phase: 'recovery', maxCalls: 3, binding }), .0277275);
  const c = ledger.reserveRequest({ requestId: 'old-C', phase: 'infeasible', maxCalls: 3, binding }); ledger.markForwarded(c); ledger.reconcileRejectedRequest(rejection(c), () => true);
  return ledger;
}
function authorization(ledger: Ledger): SupplementalAuthorization {
  const snapshot = ledger.getSnapshot();
  return { authorizationId: 'explicit-goal010r', purpose: 'goal010r-c-only', authorizationDocumentHash: 'd'.repeat(64), proofHashes: [H], priorHeadHash: snapshot.headHash,
    inherited: { requestsConsumed: 4, callPermitsConsumed: 9, committedNanoUsd: snapshot.committedNanoUsd }, additionalBusinessRequests: 1, maxPostAttempts: 2, maxModelCalls: 6, retryOnlyAfter: 'audited-before-run-rejection' };
}
const reserve = (ledger: Ledger, requestId = 'new-C', retryOfRequestId?: string, maxCalls = 3) => ledger.reserveRequest({ requestId, phase: 'infeasible', maxCalls, binding, authorizationId: 'explicit-goal010r', ...(retryOfRequestId ? { retryOfRequestId } : {}) });
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('explicit C-only supplemental trial authorization', () => {
  it('appends authorization without recharging/resetting history, then retains the current three-call affordability bound across restart', () => {
    const ledger = fixture(), old = ledger.getSnapshot(), bytes = readFileSync(ledger.path), report = authorization(ledger);
    expect(old.committedNanoUsd).toBe(1_751_278_500); expect(old.remainingModelNanoUsd).toBe(2_148_721_500);
    expect(() => reserve(ledger)).toThrow(); ledger.authorizeSupplementalRequest(report, () => true);
    const after = ledger.getSnapshot(); expect(after.committedNanoUsd).toBe(old.committedNanoUsd); expect(after.budget).toEqual(old.budget); expect(after.requestsConsumed).toBe(4); expect(after.callPermitsConsumed).toBe(9);
    expect(after.grants).toEqual(old.grants); expect(after.historicalReconciliation).toEqual(old.historicalReconciliation); expect(after.supplementalAuthorization).toEqual(report);
    expect(readFileSync(ledger.path).subarray(0, bytes.length)).toEqual(bytes);
    ledger.close(); const restored = Ledger.open(ledger.path); ledgers.push(restored); expect(restored.getSnapshot()).toEqual(after);
    expect(() => reserve(restored, 'too-many', undefined, 4)).toThrow(); expect(() => reserve(restored, 'six', undefined, 6)).toThrow();
    const g = reserve(restored); expect(g.maxCalls).toBe(3); expect(g.priorCommittedNanoUsd).toBe(1_751_278_500);
    const state = restored.getSnapshot(); expect(state.committedNanoUsd).toBe(3_419_374_500); expect(state.grossCommittedAndInfraNanoUsd).toBe(4_519_374_500); expect(state.requestsConsumed).toBe(5); expect(state.callPermitsConsumed).toBe(12); expect(state.budget.maxCalls).toBe(24);
    expect(reserve(restored)).toEqual(g); expect(() => restored.reserveRequest({ requestId: 'extra-A', phase: 'cancel', maxCalls: 1, binding, authorizationId: report.authorizationId })).toThrow();
  });
  it('permits exactly one new retry only after the new first POST is audited as app429 with no run, keeping all consumed slots', () => {
    const ledger = fixture(); ledger.authorizeSupplementalRequest(authorization(ledger), () => true);
    expect(() => reserve(ledger, 'premature-retry', 'old-C')).toThrow();
    const first = reserve(ledger); ledger.markForwarded(first); expect(() => reserve(ledger, 'retry', first.requestId)).toThrow();
    ledger.reconcileRejectedRequest(rejection(first), () => true);
    expect(ledger.getSnapshot().committedNanoUsd).toBe(1_751_278_500);
    expect(() => reserve(ledger, 'unlabelled-retry')).toThrow(); expect(() => reserve(ledger, 'wrong-prior', 'old-C')).toThrow();
    expect(() => ledger.reserveRequest({ requestId: 'changed-input', phase: 'infeasible', maxCalls: 3, binding: { ...binding, baseRevision: 4 }, authorizationId: 'explicit-goal010r', retryOfRequestId: first.requestId })).toThrow();
    const second = reserve(ledger, 'retry', first.requestId); expect(second.callIds.some(id => first.callIds.includes(id))).toBe(false); ledger.markForwarded(second); ledger.reconcileRejectedRequest(rejection(second), () => true);
    const snapshot = ledger.getSnapshot(); expect(snapshot.requestsConsumed).toBe(6); expect(snapshot.callPermitsConsumed).toBe(15); expect(snapshot.committedNanoUsd).toBe(1_751_278_500); expect(snapshot.supplementalRequestsConsumed).toBe(2);
    expect(() => reserve(ledger, 'third', second.requestId)).toThrow(); ledger.close(); const restored = Ledger.open(ledger.path); ledgers.push(restored); expect(restored.getSnapshot()).toEqual(snapshot); expect(() => reserve(restored, 'restart-retry', second.requestId)).toThrow();
  });
  it('does not permit retries for unknown dispatch, provider429, model failure, normal zero-attempt closure or local abandonment', () => {
    for (const kind of ['unknown', 'provider429', 'model-failure', 'zero-attempt-run', 'local-abandonment']) {
      const ledger = fixture(); ledger.authorizeSupplementalRequest(authorization(ledger), () => true); const first = reserve(ledger);
      if (kind === 'local-abandonment') ledger.closeUnforwarded({ requestId: first.requestId, grantId: first.grantId, reason: 'not forwarded' });
      else {
        ledger.markForwarded(first);
        if (kind === 'provider429') expect(() => ledger.reconcileRejectedRequest({ ...rejection(first), errorCode: 'provider_quota' } as unknown as RejectedRequestReport, () => true)).toThrow();
        if (kind === 'model-failure' || kind === 'zero-attempt-run') {
          const report: ClosureReport = { requestId: first.requestId, grantId: first.grantId, binding, dispatchClosed: true, completeAttemptList: true, sdkFetchRetryGuard: 1, serverIdentity: 'fixture', proofHashes: [H], attempts: kind === 'zero-attempt-run' ? [] : [{ attemptId: first.callIds[0], dispatch: 'sent', cost: { kind: 'sent-unknown' }, observationHashes: [H] }] };
          ledger.reconcile(report, () => true);
        }
      }
      expect(() => reserve(ledger, 'retry', first.requestId)).toThrow(); expect(ledger.getSnapshot().requestsConsumed).toBe(5);
    }
  });
  it('requires explicit verified authorization bound to the exact history and never stacks or edits allowances', () => {
    const ledger = fixture(), report = authorization(ledger), before = readFileSync(ledger.path);
    for (const verify of [undefined, () => false, () => Promise.resolve(true)]) expect(() => ledger.authorizeSupplementalRequest(report, verify as unknown as VerifySupplementalAuthorization)).toThrow();
    for (const change of [{ priorHeadHash: 'f'.repeat(64) }, { inherited: { ...report.inherited, committedNanoUsd: 0 } }, { maxPostAttempts: 3 }, { maxModelCalls: 7 }, { additionalBusinessRequests: 2 }, { modelPoolNanoUsd: 5_000_000_000 }]) expect(() => ledger.authorizeSupplementalRequest({ ...report, ...change } as SupplementalAuthorization, () => true)).toThrow();
    expect(readFileSync(ledger.path)).toEqual(before); ledger.authorizeSupplementalRequest(report, () => true); const authorized = readFileSync(ledger.path); ledger.authorizeSupplementalRequest(report, () => true); expect(readFileSync(ledger.path)).toEqual(authorized);
    expect(() => ledger.authorizeSupplementalRequest({ ...report, authorizationId: 'second-authorization' }, () => true)).toThrow(); expect(() => ledger.authorizeSupplementalRequest({ ...report, proofHashes: ['e'.repeat(64)] }, () => true)).toThrow();
    expect(ledger.getSnapshot().budget.maxRequests).toBe(4); expect(ledger.getSnapshot().budget.modelPoolNanoUsd).toBe(3_900_000_000); expect(ledger.getSnapshot().committedNanoUsd).toBe(1_751_278_500);
  });
});

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { trialClosureFromResponse, type AssessTrialUsage, type ResponseEvidence } from '../../scripts/trial-reconciliation.js';
import type { TrialGrant } from '../../scripts/trial-ledger.js';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const rateBasis = 'vertex-global-standard-conservative-2026-10-05';
const cost = (tokens: number, kind: 'usage-estimate' | 'aggregate-upper-estimate' = 'usage-estimate') => ({ kind, estimateUsd: tokens / 1e6, usageEstimateUsd: kind === 'usage-estimate' ? tokens / 1e6 : null, basis: kind === 'usage-estimate' ? 'itemized' : 'total-at-output-rate', rateBasis, billingActual: false as const });
// The production caller passes assessVertexUsage. These tests isolate whether
// the verifier reconstructs the exact numeric metadata and retains uncertainty.
const assess: AssessTrialUsage = usage => cost((usage as { totalTokenCount: number }).totalTokenCount);
function fixture() {
  const grant: TrialGrant = { requestId: 'request-fixture', phase: 'recovery', maxCalls: 3, grantId: randomUUID(), callIds: Array.from({ length: 3 }, () => randomUUID()), priorCommittedNanoUsd: 1_112_064_000, reservedNanoUsd: 3 * 556_032_000,
    binding: { sessionId: randomUUID(), baseHash: 'a'.repeat(64), baseRevision: 2, sourceSha: 'b'.repeat(40), revision: 'review-00001-test' } };
  const observation = (call: number, source: 'http-response' | 'sdk-response', total = 100) => ({ attemptId: grant.callIds[call - 1], call, source, sdkVersion: '2.27.0', model: 'gemini-3.8-flash', observedAt: '2026-10-05T12:00:01.000Z', aborted: false,
    usageDiagnostics: { source: source === 'http-response' ? 'http-usage-metadata' : 'sdk-usage-metadata', metadataPresent: true, metadataState: 'present', invalidFields: [], inconsistencies: [],
      observed: { promptTokenCount: total - 20, candidatesTokenCount: 20, thoughtsTokenCount: 0, totalTokenCount: total },
      fields: { promptTokenCount: { state: 'value', value: total - 20 }, candidatesTokenCount: { state: 'value', value: 20 }, thoughtsTokenCount: { state: 'zero', value: 0 }, totalTokenCount: { state: 'value', value: total }, cachedContentTokenCount: { state: 'missing' }, toolUsePromptTokenCount: { state: 'missing' } },
    }, modelCost: { ...cost(total), reservationUsd: 0.556032 } });
  const meter = (call: number) => ({ call, attemptId: grant.callIds[call - 1], received: true, dispatch: { attemptId: grant.callIds[call - 1], startedAt: '2026-10-05T12:00:00.000Z', transport: 'vertex-http', sdkRetryAttempts: 1 }, observations: [observation(call, 'http-response'), observation(call, 'sdk-response')] });
  const run = { id: randomUUID(), requestId: grant.requestId, baseHash: grant.binding.baseHash, baseRevision: 2, provider: 'vertex', mode: 'vertex', model: 'gemini-3.8-flash', status: 'awaiting_approval', dispatchClosed: true, dispatchClosedAt: '2026-10-05T12:00:02.000Z', modelCalls: 2, modelUsage: [meter(1), meter(2)], trialDispatch: { permitId: grant.grantId, callIds: grant.callIds, sourceSha: grant.binding.sourceSha, sessionId: grant.binding.sessionId, sdkRetryAttempts: 1 } };
  const verify = (value: unknown = run, evidenceChange: Partial<ResponseEvidence> = {}, calculator = assess) => {
    const bytes = Buffer.from(JSON.stringify({ run: value }));
    return trialClosureFromResponse(bytes, grant, { authenticatedHttps: true, origin: 'https://review.run.app', sourceSha: grant.binding.sourceSha, revision: grant.binding.revision, sessionId: grant.binding.sessionId, runId: run.id, responseSha256: sha(bytes), deploymentProofSha256: 'c'.repeat(64), ...evidenceChange }, calculator);
  };
  return { grant, run, meter, observation, verify };
}
describe('authenticated closure reconciliation', () => {
  it('binds the entire response and two ordered attempts, keeps explicit zero distinct from missing', () => {
    const { verify, grant } = fixture(), calculator = vi.fn(assess), report = verify(undefined, {}, calculator)!;
    expect(report.attempts.map(a => a.attemptId)).toEqual(grant.callIds.slice(0, 2));
    expect(report.attempts.every(a => a.cost.kind === 'usage-estimate')).toBe(true);
    expect(report.proofHashes).toHaveLength(2);
    expect(calculator).toHaveBeenCalledWith({ promptTokenCount: 80, candidatesTokenCount: 20, thoughtsTokenCount: 0, totalTokenCount: 100 });
    expect(calculator.mock.calls[0][0]).not.toHaveProperty('cachedContentTokenCount');
  });
  it('never releases on running, unclosed, wrong source, session, revision, body hash or provider', () => {
    const { run, verify } = fixture();
    expect(verify({ ...run, status: 'running' })).toBeNull(); expect(verify({ ...run, dispatchClosed: false })).toBeNull();
    for (const change of [{ authenticatedHttps: false }, { origin: 'http://review.run.app' }, { sourceSha: 'd'.repeat(40) }, { revision: 'other-revision' }, { sessionId: randomUUID() }, { responseSha256: 'd'.repeat(64) }]) expect(() => verify(run, change as Partial<ResponseEvidence>)).toThrow();
    for (const change of [{ provider: 'gemini' }, { mode: 'injected-test' }, { model: 'other' }, { requestId: 'other' }, { baseRevision: 3 }, { dispatchClosedAt: undefined }, { modelCalls: 3 }]) expect(() => verify({ ...run, ...change })).toThrow();
  });
  it('rejects permit, attempt order, omitted meter, retry, observation identity and source duplication', () => {
    for (const mutation of [
      (r: ReturnType<typeof fixture>['run']) => { r.trialDispatch.permitId = randomUUID(); },
      (r: ReturnType<typeof fixture>['run']) => { r.trialDispatch.callIds = [...r.trialDispatch.callIds].reverse(); },
      (r: ReturnType<typeof fixture>['run']) => { r.modelUsage.reverse(); },
      (r: ReturnType<typeof fixture>['run']) => { r.modelUsage.pop(); },
      (r: ReturnType<typeof fixture>['run']) => { r.modelUsage[0].dispatch.sdkRetryAttempts = 2; },
      (r: ReturnType<typeof fixture>['run']) => { r.modelUsage[0].observations[0].attemptId = randomUUID(); },
      (r: ReturnType<typeof fixture>['run']) => { r.modelUsage[0].observations[1].source = 'http-response'; },
    ]) { const { run, verify } = fixture(); mutation(run); expect(() => verify()).toThrow(); }
  });
  it('retains sent-unknown for no response or one incomplete/inconsistent observation', () => {
    const f = fixture(); f.run.status = 'cancelled'; f.run.modelUsage[0].received = false; f.run.modelUsage[0].observations = [];
    f.run.modelUsage[1].observations[0].modelCost.estimateUsd = 0;
    const result = f.verify()!; expect(result.attempts[0]).toMatchObject({ dispatch: 'possibly-sent', cost: { kind: 'sent-unknown' } });
    expect(result.attempts[1]).toMatchObject({ dispatch: 'sent', cost: { kind: 'sent-unknown' } });
    expect(result.attempts[0].observationHashes).toHaveLength(1);
  });
  it('retains the full reservation when HTTP and SDK numeric observations disagree', () => {
    const f = fixture(); f.run.modelUsage[0].observations[0] = f.observation(1, 'http-response', 120);
    expect(f.verify()!.attempts[0].cost).toEqual({ kind: 'sent-unknown' });
  });
  it('uses a consistent HTTP-only estimate after cancellation; SDK null/missing are preserved without invented zero', () => {
    const f = fixture(); f.run.status = 'cancelled'; f.run.modelUsage[0].received = false; f.run.modelUsage[0].observations.pop();
    expect(f.verify()!.attempts[0].cost).toEqual({ kind: 'usage-estimate', usd: 0.0001 });
    const sdk = f.run.modelUsage[1].observations[1].usageDiagnostics;
    sdk.fields.cachedContentTokenCount.state = 'null';
    expect(f.verify()!.attempts[1].cost.kind).toBe('usage-estimate');
  });
  it('only releases a trailing never-dispatched meter with no observations/received response', () => {
    const f = fixture(), r = structuredClone(f.run) as unknown as Record<string, unknown>;
    const meters = r.modelUsage as Record<string, unknown>[]; delete meters[1].dispatch; meters[1].received = false; meters[1].observations = [];
    expect(f.verify(r)!.attempts).toHaveLength(1);
    meters[1].received = true; expect(() => f.verify(r)).toThrow(); meters[1].received = false;
    delete meters[0].dispatch; meters[0].received = false; meters[0].observations = []; expect(() => f.verify(r)).toThrow();
  });
  it('does not improve a saved settlement using an invalid metadata field or a fabricated cheaper cost', () => {
    const f = fixture(); f.run.modelUsage[0].observations[0].usageDiagnostics.fields.thoughtsTokenCount.state = 'missing';
    expect(f.verify()!.attempts[0].cost.kind).toBe('sent-unknown');
    f.run.modelUsage[1].observations[1].usageDiagnostics.invalidFields = ['totalTokenCount'] as never[];
    expect(f.verify()!.attempts[1].cost.kind).toBe('sent-unknown');
  });
});

import { describe, expect, it } from 'vitest';
import { nextTrialRequestWindow, type TrialRequestWindowInput } from '../../scripts/trial-request-window.js';

const input = (times: number[], nowMs: number): TrialRequestWindowInput => ({ nowMs, previousNowMs: nowMs - 1,
  acceptedRequestIds: times.map((_, i) => `request-${i}`), acknowledgements: times.map((receivedAtMs, i) => ({ requestId: `request-${i}`, runId: `run-${i}`, receivedAtMs })) });

describe('private trial request window', () => {
  it('allows zero/one accepted starts without wait; failures and cancellation still count once accepted', () => {
    expect(nextTrialRequestWindow(input([], 100_000)).waitMs).toBe(0);
    expect(nextTrialRequestWindow(input([99_900], 100_000)).waitMs).toBe(0);
    // No model-success/status field can erase either accepted start.
    const history = input([100_000, 110_000], 120_000), original = structuredClone(history);
    expect(nextTrialRequestWindow(history)).toEqual({ waitMs: 41_000, notBeforeMs: 161_000, windowLimit: 2, windowMs: 60_000, safetyMarginMs: 1_000 });
    expect(history).toEqual(original);
    expect(nextTrialRequestWindow({ ...history, nowMs: 160_999, previousNowMs: 160_000 }).waitMs).toBe(1);
    expect(nextTrialRequestWindow({ ...history, nowMs: 161_000, previousNowMs: 160_999 }).waitMs).toBe(0);
    expect(nextTrialRequestWindow(input([100_000, 100_000], 100_000)).waitMs).toBe(61_000);
  });
  it('uses the older of the latest two receipts after a valid third start, without extending any permission', () => {
    const result = nextTrialRequestWindow(input([100_000, 110_000, 161_000], 162_000));
    expect(result.waitMs).toBe(9_000); expect(result.notBeforeMs).toBe(171_000);
    expect(result).not.toHaveProperty('authorized'); expect(result).not.toHaveProperty('retry');
  });
  it('fails closed for missing receipts, inconsistent identities, clock reversal, impossible history and overflow', () => {
    const valid = input([100_000, 110_000], 120_000);
    const broken: unknown[] = [
      { ...valid, nowMs: Number.NaN }, { ...valid, previousNowMs: undefined }, { ...valid, previousNowMs: 120_001 },
      { ...valid, acknowledgements: valid.acknowledgements.slice(0, 1) },
      { ...valid, acceptedRequestIds: ['request-0', 'request-0'] },
      { ...valid, acknowledgements: [valid.acknowledgements[0], { ...valid.acknowledgements[1], requestId: 'other' }] },
      { ...valid, acknowledgements: [valid.acknowledgements[0], { ...valid.acknowledgements[1], runId: 'run-0' }] },
      { ...valid, acknowledgements: [valid.acknowledgements[0], { ...valid.acknowledgements[1], receivedAtMs: undefined }] },
      input([100_000, 99_000], 120_000), input([100_000, 121_000], 120_000), input([100_000, 110_000, 159_999], 160_000),
      input([Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER], Number.MAX_SAFE_INTEGER),
    ];
    for (const value of broken) expect(() => nextTrialRequestWindow(value as TrialRequestWindowInput)).toThrow();
  });
});

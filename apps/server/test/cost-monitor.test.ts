import { describe, expect, it } from 'vitest';
import { infrastructureEstimate, metricSum, stopReason, RELEASE_DEADLINE, type MonitorState } from '../src/operations/cost-monitor.js';
const start = Date.parse('2026-10-05T15:00:00Z');
const state: MonitorState = { schema: 'ugoku-public-monitor-011', startedAt: new Date(start).toISOString(), checkedAt: new Date(start).toISOString(), fixedReserveUsd: 1.5, totals: { cpuSeconds: 3600, memoryGiBSeconds: 3600, sentBytes: 2 ** 30, requests: 1000 }, lastDailyNotice: '' };
describe('release infrastructure monitoring', () => {
  it('counts allocation including idle, all transfer, minimum job billing and reserves without credits', () => {
    const result = infrastructureEstimate(state, state.totals, start + 86400000);
    expect(result.cpuUsd + result.memoryUsd).toBeCloseTo(0.072);
    expect(result.transferUsd).toBe(0.25);
    expect(result.monitorUsd).toBeCloseTo(20 * 60 * 0.000019);
    expect(result.totalUsd).toBeGreaterThan(2); expect(result.billingActual).toBe(false);
  });
  it('does not revive funds if an observed total decreases or becomes malformed', () => {
    expect(infrastructureEstimate(state, { cpuSeconds: 0, memoryGiBSeconds: 0, sentBytes: 0, requests: 0 }, start).totals).toEqual(state.totals);
    expect(() => infrastructureEstimate(state, { ...state.totals, sentBytes: NaN }, start)).toThrow();
    expect(() => infrastructureEstimate(state, { cpuSeconds: 0 } as typeof state.totals, start)).toThrow();
  });
  it('stops the whole service before the 10 USD infrastructure allocation and at the deadline', () => {
    expect(stopReason(start, 7.99, false)).toBeUndefined();
    expect(stopReason(start, 8, false)).toBe('infrastructure-reserve');
    expect(stopReason(Date.parse(RELEASE_DEADLINE), 0, false)).toBe('release-deadline');
    expect(stopReason(start, NaN, false)).toBe('unavailable-cost-observation');
    expect(stopReason(start, 0, true)).toBe('operator-stop');
  });
  it('sums every page/revision and bounds malformed or endless responses', async () => {
    const urls: string[] = [];
    const value = await metricSum(async url => { urls.push(url); return urls.length === 1 ? { timeSeries: [{ points: [{ value: { doubleValue: 60 } }] }], nextPageToken: 'next' } : { timeSeries: [{ points: [{ value: { int64Value: '30' } }] }] }; }, { project: 'example-project', region: 'asia-northeast1', service: 'release', metric: 'container/cpu/allocation_time', start: state.startedAt, end: new Date(start + 86400000).toISOString() });
    expect(value).toBe(90); expect(new URL(urls[1]!).searchParams.get('pageToken')).toBe('next');
    expect(new URL(urls[0]!).searchParams.get('filter')).toContain('cloud_run_revision');
    const args = { project: 'example-project', region: 'asia-northeast1', service: 'release', metric: 'container/cpu/allocation_time', start: state.startedAt, end: new Date(start + 86400000).toISOString() };
    await expect(metricSum(async () => ({timeSeries: [], nextPageToken: 'never-ending'}), args)).rejects.toThrow('pagination limit');
    await expect(metricSum(async () => ({timeSeries: [], executionErrors: [{code: 14}]}), args)).rejects.toThrow('Incomplete');
    await expect(metricSum(async () => ({timeSeries: [], unreachable: ['asia-northeast1']}), args)).rejects.toThrow('Incomplete');
  });
});

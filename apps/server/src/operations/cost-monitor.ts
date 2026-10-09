/** Public-release cost guard. Monitoring observations are estimates, never invoices. */
export const RELEASE_DEADLINE = '2026-12-01T14:59:00.000Z';
export const INFRA_STOP_USD = 8;
export const INFRA_WARNING_USD = 6;
export const MONITOR_INTERVAL_MS = 3 * 60 * 60 * 1000;
export const MONITOR_LAG_MS = 5 * 60 * 1000;
export type MetricTotals = { cpuSeconds: number; memoryGiBSeconds: number; sentBytes: number; requests: number };
export type MonitorState = {
  schema: 'ugoku-public-monitor-011'; startedAt: string; checkedAt: string;
  fixedReserveUsd: number; totals: MetricTotals; lastDailyNotice: string;
  stoppedAt?: string; stopReason?: string;
};
export function infrastructureEstimate(state: MonitorState, observed: MetricTotals, now: number) {
  if (state.schema !== 'ugoku-public-monitor-011' || !Number.isFinite(Date.parse(state.startedAt)) || Date.parse(state.startedAt) > now || !Number.isFinite(state.fixedReserveUsd) || state.fixedReserveUsd < 1.5 || state.fixedReserveUsd > 3) throw Error('Invalid monitor initialization');
  const keys = ['cpuSeconds', 'memoryGiBSeconds', 'sentBytes', 'requests'] as const;
  const totals = Object.fromEntries(keys.map(key => {
    const value = observed[key];
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(state.totals[key as keyof MetricTotals]) || state.totals[key as keyof MetricTotals] < 0) throw Error('Invalid metric total');
    return [key, Math.max(value, state.totals[key as keyof MetricTotals])];
  })) as MetricTotals;
  const cpuUsd = totals.cpuSeconds * 0.000018;
  const memoryUsd = totals.memoryGiBSeconds * 0.000002;
  // All network kinds counted, including Google LB replies. No free tier.
  const transferUsd = totals.sentBytes / 2 ** 30 * 0.25;
  // Conservative 8 KiB per request, including platform HTTP logs, at $0.50/GiB.
  const logsUsd = totals.requests * 8192 / 2 ** 30 * 0.5;
  // 3-hour polling is a job, not a request to the web service. Reserve a full
  // 60s CPU + 512MiB minimum for every scheduled execution (plus 12 setup runs).
  const jobExecutions = Math.ceil((now - Date.parse(state.startedAt)) / MONITOR_INTERVAL_MS) + 12;
  const monitorUsd = jobExecutions * 60 * (0.000018 + 0.5 * 0.000002);
  const lagAndNextCheckUsd = (MONITOR_INTERVAL_MS + MONITOR_LAG_MS) / 1000 * 0.00002;
  const totalUsd = state.fixedReserveUsd + cpuUsd + memoryUsd + transferUsd + logsUsd + monitorUsd + lagAndNextCheckUsd;
  return { totals, cpuUsd, memoryUsd, transferUsd, logsUsd, monitorUsd, fixedReserveUsd: state.fixedReserveUsd, lagAndNextCheckUsd, totalUsd, billingActual: false as const };
}
export function stopReason(now: number, estimatedInfrastructureUsd: number, wholeStop: boolean): string | undefined {
  if (now >= Date.parse(RELEASE_DEADLINE)) return 'release-deadline';
  if (wholeStop) return 'operator-stop';
  if (!Number.isFinite(estimatedInfrastructureUsd)) return 'unavailable-cost-observation';
  if (estimatedInfrastructureUsd >= INFRA_STOP_USD) return 'infrastructure-reserve';
  return undefined;
}
export function dailyNoticeKey(now: number) { return new Date(now + 9 * 3600000).toISOString().slice(0, 10); }

/** Reads the whole release interval. Monotonic maxima tolerate delayed metrics;
 * no incremental cursor can skip a late point. Bound both pages and data size. */
export async function metricSum(get: (url: string) => Promise<unknown>, args: { project: string; region: string; service: string; metric: string; start: string; end: string }) {
  const base = new URL(`https://monitoring.googleapis.com/v3/projects/${args.project}/timeSeries`);
  base.searchParams.set('filter', `metric.type="run.googleapis.com/${args.metric}" AND resource.type="cloud_run_revision" AND resource.labels.service_name="${args.service}" AND resource.labels.location="${args.region}"`);
  base.searchParams.set('interval.startTime', args.start); base.searchParams.set('interval.endTime', args.end);
  base.searchParams.set('aggregation.alignmentPeriod', '86400s'); base.searchParams.set('aggregation.perSeriesAligner', 'ALIGN_SUM');
  base.searchParams.set('aggregation.crossSeriesReducer', 'REDUCE_SUM'); base.searchParams.set('view', 'FULL'); base.searchParams.set('pageSize', '1000');
  let total = 0, points = 0;
  for (let page = 0; page < 10; page++) {
    const response = await get(base.href) as { timeSeries?: { points: { value: { doubleValue?: number; int64Value?: string } }[] }[]; nextPageToken?: string; executionErrors?: unknown[]; unreachable?: unknown[] };
    if (!response || typeof response !== 'object' || response.timeSeries && !Array.isArray(response.timeSeries)) throw Error('Malformed metric response');
    // HTTP 200 may still report partial query results. Do not treat these as full costs.
    if (response.executionErrors !== undefined && (!Array.isArray(response.executionErrors) || response.executionErrors.length)
      || response.unreachable !== undefined && (!Array.isArray(response.unreachable) || response.unreachable.length)) throw Error('Incomplete metric observation');
    if (response.nextPageToken !== undefined && typeof response.nextPageToken !== 'string') throw Error('Malformed metric page token');
    for (const series of response.timeSeries ?? []) for (const point of series.points) {
      const n = point.value.doubleValue ?? Number(point.value.int64Value);
      if (!Number.isFinite(n) || n < 0) throw Error('Invalid metric observation');
      total += n;
      points++;
      if (!Number.isFinite(total)) throw Error('Metric total overflow');
    }
    if (!response.nextPageToken) {
      if (points === 0) throw Error('Incomplete metric observation');
      return total;
    }
    base.searchParams.set('pageToken', response.nextPageToken);
  }
  throw Error('Metric pagination limit');
}

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GcsLedgerStore, metadataAccessToken } from '../gcs-ledger-store.js';
import { PublicLedger, type PublicLedgerStore } from '../public-ledger.js';
import { dailyNoticeKey, infrastructureEstimate, INFRA_WARNING_USD, metricSum, MONITOR_LAG_MS, RELEASE_DEADLINE, stopReason, type MonitorState } from './cost-monitor.js';

const region = 'asia-northeast1', service = 'ugoku-kami-release-011';
// Reserve most of the 30-second Job for fail-closed deletion and cleanup.
export const OBSERVATION_BUDGET_MS = 10_000;
export const STOP_STAGE_BUDGET_MS = 3_000;
type CloudResult = {absent?: boolean; name?: string; [key: string]: unknown};
export type MonitorDependencies = {
  project: string; bucket: string; now?: () => number;
  stateStore: (signal: AbortSignal) => PublicLedgerStore;
  ledger: (signal: AbortSignal) => Pick<PublicLedger, 'snapshot' | 'setStop'>;
  api: (method: 'GET' | 'DELETE', url: string, signal: AbortSignal) => Promise<CloudResult>;
  notice: (event: string, data: Record<string, unknown>) => void;
};
async function bounded<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(Error('Monitor stage timeout'));}, ms);});
  try {return await Promise.race([Promise.resolve().then(() => work(controller.signal)), expired]);}
  finally {clearTimeout(timer!); controller.abort();}
}
function targets(project: string, bucket: string) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || bucket !== `${project}-ugoku-g011`) throw Error('Explicit dedicated monitor target required');
  return {
    service: `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${service}`,
    owned: [
      `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${region}/repositories/ugoku-kami-release-011`,
      `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/ugoku-release-011-access`,
      `https://storage.googleapis.com/storage/v1/b/${bucket}/o/source%2Frelease.tar.gz`,
    ],
    schedules: ['ugoku-deadline-011', 'ugoku-monitor-011'].map(name => `https://cloudscheduler.googleapis.com/v1/projects/${project}/locations/${region}/jobs/${name}`),
  };
}
/** Resource-level deletion permission can disappear with the resource itself.
 * Project-level read permission proves absence without widening delete scope.
 * Three bounded attempts fit inside the existing three-second stop stage.
 */
async function safeDelete(deps: MonitorDependencies, url: string, signal: AbortSignal): Promise<CloudResult> {
  const read = () => bounded(700, inner => deps.api('GET', url, AbortSignal.any([signal, inner])));
  try {if ((await read()).absent) return {absent: true};} catch {signal.throwIfAborted();}
  try {
    return await bounded(1500, inner => deps.api('DELETE', url.includes('artifactregistry.') ? `${url}?force=true` : url, AbortSignal.any([signal, inner])));
  } catch {
    signal.throwIfAborted();
    // A timeout/403 is not proof of deletion. Only a fresh GET404 is.
    if ((await read()).absent) return {absent: true};
    throw Error('Resource deletion unconfirmed');
  }
}
async function stop(deps: MonitorDependencies, reason: string, owned: ReturnType<typeof targets>) {
  // Prioritize the service; unavailable or hung ledger writes cannot delay it.
  let ledgerStopped = false, deletionAccepted = false;
  try {
    await bounded(STOP_STAGE_BUDGET_MS, async signal => {
      const deletion = safeDelete(deps, owned.service, signal);
      const stopLedger = deps.ledger(signal).setStop({ai: true, whole: true}).then(() => {ledgerStopped = true;}).catch(() => {});
      const result = await deletion; deletionAccepted = true;
      deps.notice('release-stopped', {reason, deletionAccepted: true, operation: result.name ?? null});
      await stopLedger;
    });
  } catch {if (!deletionAccepted) throw Error('Service deletion unconfirmed');}
  deps.notice(ledgerStopped ? 'ledger-stop' : 'ledger-stop-unconfirmed', {confirmed: ledgerStopped});
  await bounded(STOP_STAGE_BUDGET_MS, signal => Promise.all(owned.owned.map(url => safeDelete(deps, url, signal))));
  // DELETE may only accept an asynchronous operation. Keep the schedule until
  // the service and owned resources are confirmed absent by control-plane GET.
  const absent = await bounded(STOP_STAGE_BUDGET_MS, signal => Promise.all([owned.service, ...owned.owned].map(url => deps.api('GET', url, signal))));
  if (!ledgerStopped || absent.some(result => !result.absent)) {deps.notice('cleanup-pending', {reason: ledgerStopped ? 'Deletion accepted; remaining resources will be checked next time' : 'Service deletion accepted; persistent ledger stop will be retried'}); return;}
  // Deadline first, monitor last: a failed deadline deletion stays retryable.
  for (const url of owned.schedules) await bounded(STOP_STAGE_BUDGET_MS, signal => safeDelete(deps, url, signal));
  deps.notice('release-cleanup', {serviceAbsent: true, repositoryAbsent: true, sourceAndSecretAbsent: true, schedulesAbsent: true, ledgerStopped, retained: 'private ledger and monitor objects, job definition, IAM, audit logs'});
}

/** Only control-plane/Monitoring APIs and generation CAS; never wakes the app. */
export async function runMonitor(deps: MonitorDependencies): Promise<void> {
  const owned = targets(deps.project, deps.bucket), now = deps.now ?? Date.now;
  let reason: string | undefined;
  try {
    reason = await bounded(OBSERVATION_BUDGET_MS, async signal => {
      if (now() >= Date.parse(RELEASE_DEADLINE)) return 'release-deadline';
      const stateStore = deps.stateStore(signal);
      const version = await stateStore.read(), state = JSON.parse(version.data) as MonitorState;
      if (state.schema !== 'ugoku-public-monitor-011' || typeof state.lastDailyNotice !== 'string') throw Error('Invalid initialized monitor');
      if (state.stoppedAt !== undefined || state.stopReason !== undefined) {
        if (!Number.isFinite(Date.parse(state.stoppedAt ?? '')) || typeof state.stopReason !== 'string' || !state.stopReason) throw Error('Invalid stop state');
        return state.stopReason;
      }
      // A direct deadline or fail-closed DELETE may not have persisted markers.
      if ((await deps.api('GET', owned.service, signal)).absent) return 'service-absent';
      const ledgerState = await deps.ledger(signal).snapshot();
      if (ledgerState.stop.whole) return 'operator-stop';
      const time = now(), end = new Date(time - MONITOR_LAG_MS).toISOString();
      const types = ['container/cpu/allocation_time', 'container/memory/allocation_time', 'container/network/sent_bytes_count', 'request_count'];
      const values = Date.parse(end) > Date.parse(state.startedAt) ? await Promise.all(types.map(metric => metricSum(url => deps.api('GET', url, signal), {project: deps.project, region, service, metric, start: state.startedAt, end}))) : [0, 0, 0, 0];
      const observed = {cpuSeconds: values[0]!, memoryGiBSeconds: values[1]!, sentBytes: values[2]!, requests: values[3]!};
      const estimate = infrastructureEstimate(state, observed, time), reason = stopReason(time, estimate.totalUsd, false), day = dailyNoticeKey(time);
      const updated: MonitorState = {...state, checkedAt: new Date(time).toISOString(), totals: estimate.totals, lastDailyNotice: day, ...(reason ? {stoppedAt: new Date(time).toISOString(), stopReason: reason} : {})};
      await stateStore.compareAndSwap(version.generation, JSON.stringify(updated));
      const report = {day, infrastructure: estimate, modelCommittedUsd: ledgerState.committedNano / 1e9, modelUnknownHeldUsd: ledgerState.sentUnknownNano / 1e9, requests: ledgerState.requests, sends: ledgerState.sends, modelBudgetUsd: 85, infraStopUsd: 8, grossLimitUsd: 100, creditsDeducted: 0, billingActual: false};
      if (day !== state.lastDailyNotice) deps.notice('daily-review', report);
      if (estimate.totalUsd >= INFRA_WARNING_USD || ledgerState.committedNano >= 65e9) deps.notice('budget-warning', report);
      deps.notice('monitor-check', report);
      return reason;
    });
  } catch {
    reason = 'monitor-unavailable';
    deps.notice('monitor-failed', {reason: 'Monitoring or persistent state unavailable; stopping dedicated service'});
  }
  if (reason) {
    try {await stop(deps, reason, owned);}
    catch {deps.notice('monitor-failed', {reason: 'Stopping or cleanup incomplete; operator action or the next monitor is required'}); throw Error('Monitor stopping incomplete');}
  }
}

/** Bound while streaming, before decoding/JSON parsing; never log response bodies. */
export async function cloudApi(method: 'GET' | 'DELETE', address: string, signal: AbortSignal, token = metadataAccessToken, fetcher: typeof fetch = fetch): Promise<CloudResult> {
  signal.throwIfAborted(); const accessToken = await token(); signal.throwIfAborted();
  const response = await fetcher(address, {method, headers: {Authorization: `Bearer ${accessToken}`}, signal, redirect: 'error'});
  if (response.status === 404 && !address.startsWith('https://monitoring.googleapis.com/')) {await response.body?.cancel(); return {absent: true};}
  if (!response.ok) {await response.body?.cancel(); throw Error(`Monitor cloud API status ${response.status}`);}
  if (!response.body) return {};
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {const {done, value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 2_097_152) throw Error('Monitor response limit'); chunks.push(value);}
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
  const text = Buffer.concat(chunks).toString('utf8'); return text ? JSON.parse(text) : {};
}
function notice(event: string, data: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({severity: ['release-stopped', 'monitor-failed', 'ledger-stop-unconfirmed'].includes(event) ? 'ERROR' : event === 'budget-warning' ? 'WARNING' : 'NOTICE', component: 'ugoku-public-monitor-011', event, ...data}) + '\n');
}
async function main() {
  const project = process.env.MONITOR_PROJECT ?? '', bucket = process.env.MONITOR_BUCKET ?? '';
  const store = (object: string, signal: AbortSignal) => new GcsLedgerStore({bucket, object, fetch: (url, init) => {signal.throwIfAborted(); return fetch(url, {...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal});}});
  try {await runMonitor({project, bucket, stateStore: signal => store('public-release-011/monitor.json', signal), ledger: signal => new PublicLedger(store('public-release-011/ledger.json', signal)), api: cloudApi, notice});}
  catch {notice('monitor-failed', {reason: 'Monitor execution did not finish; operator action required'}); process.exitCode = 1;}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

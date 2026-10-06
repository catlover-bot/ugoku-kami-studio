import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { GcsLedgerStore, metadataAccessToken } from '../gcs-ledger-store.js';
import { LedgerStoreError, PublicLedger, type PublicLedgerStore } from '../public-ledger.js';
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
type FailureCategory = 'timeout' | 'http' | 'transport' | 'invalid-response' | 'partial-response' | 'response-limit' | 'pagination-limit' | 'invalid-state' | 'unavailable' | 'missing' | 'conflict' | 'uncertain' | 'unknown';
class MonitorFailure extends Error {
  constructor(readonly category: FailureCategory, readonly httpStatus?: number) {
    super(category === 'response-limit' ? 'Monitor response limit' : `Monitor failure: ${category}${httpStatus === undefined ? '' : ` (${httpStatus})`}`);
  }
}
/** Never forward exception messages, response bodies, URLs or credentials. */
function failureDetails(error: unknown): {category: FailureCategory; httpStatus?: number} {
  if (error instanceof MonitorFailure) return {category: error.category, ...(error.httpStatus === undefined ? {} : {httpStatus: error.httpStatus})};
  if (error instanceof LedgerStoreError) return {category: error.kind};
  if (error instanceof SyntaxError) return {category: 'invalid-response'};
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return {category: 'timeout'};
    // These are fixed local validation errors, never externally supplied text.
    const known: Record<string, FailureCategory> = {
      'Incomplete metric observation': 'partial-response', 'Metric pagination limit': 'pagination-limit',
      'Malformed metric response': 'invalid-response', 'Malformed metric page token': 'invalid-response',
      'Invalid metric observation': 'invalid-response', 'Metric total overflow': 'invalid-response',
      'Invalid monitor initialization': 'invalid-state', 'Invalid metric total': 'invalid-state',
      'Invalid initialized monitor': 'invalid-state', 'Invalid stop state': 'invalid-state',
    };
    if (Object.hasOwn(known, error.message)) return {category: known[error.message]!};
  }
  return {category: 'unknown'};
}
async function diagnostic<T>(deps: MonitorDependencies, stage: string, work: () => Promise<T>): Promise<T> {
  try {return await work();}
  catch (error) {deps.notice('monitor-diagnostic', {stage, ...failureDetails(error)}); throw error;}
}
async function bounded<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(new MonitorFailure('timeout'));}, ms);});
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
async function safeDelete(deps: MonitorDependencies, url: string, signal: AbortSignal, stage: string): Promise<CloudResult> {
  const read = () => diagnostic(deps, `${stage}.read`, () => bounded(700, inner => deps.api('GET', url, AbortSignal.any([signal, inner]))));
  try {if ((await read()).absent) return {absent: true};} catch {signal.throwIfAborted();}
  try {
    return await diagnostic(deps, `${stage}.delete`, () => bounded(1500, inner => deps.api('DELETE', url, AbortSignal.any([signal, inner]))));
  } catch (error) {
    signal.throwIfAborted();
    // A timeout/403 is not proof of deletion. Only a fresh GET404 is.
    if ((await read()).absent) return {absent: true};
    throw error;
  }
}
async function stop(deps: MonitorDependencies, reason: string, owned: ReturnType<typeof targets>) {
  // Prioritize the service; unavailable or hung ledger writes cannot delay it.
  let ledgerStopped = false, deletionAccepted = false;
  try {
    await bounded(STOP_STAGE_BUDGET_MS, async signal => {
      const deletion = safeDelete(deps, owned.service, signal, 'cleanup.service');
      const stopLedger = diagnostic(deps, 'cleanup.ledger-stop', () => deps.ledger(signal).setStop({ai: true, whole: true})).then(() => {ledgerStopped = true;}).catch(() => {});
      const result = await deletion; deletionAccepted = true;
      deps.notice('release-stopped', {reason, deletionAccepted: true, operation: result.name ?? null});
      await stopLedger;
    });
  } catch (error) {deps.notice('monitor-diagnostic', {stage: 'cleanup.service-and-ledger', ...failureDetails(error)}); if (!deletionAccepted) throw error;}
  deps.notice(ledgerStopped ? 'ledger-stop' : 'ledger-stop-unconfirmed', {confirmed: ledgerStopped});
  const names = ['repository', 'secret', 'source'] as const;
  await diagnostic(deps, 'cleanup.resources', () => bounded(STOP_STAGE_BUDGET_MS, signal => Promise.all(owned.owned.map((url, index) => safeDelete(deps, url, signal, `cleanup.${names[index]}`)))));
  // DELETE may only accept an asynchronous operation. Keep the schedule until
  // the service and owned resources are confirmed absent by control-plane GET.
  const absent = await diagnostic(deps, 'cleanup.verify', () => bounded(STOP_STAGE_BUDGET_MS, signal => Promise.all([owned.service, ...owned.owned].map((url, index) => diagnostic(deps, `cleanup.verify.${['service', ...names][index]}`, () => deps.api('GET', url, signal))))));
  if (!ledgerStopped || absent.some(result => !result.absent)) {deps.notice('cleanup-pending', {reason: ledgerStopped ? 'Deletion accepted; remaining resources will be checked next time' : 'Service deletion accepted; persistent ledger stop will be retried'}); return;}
  // Deadline first, monitor last: a failed deadline deletion stays retryable.
  for (const [index, url] of owned.schedules.entries()) await diagnostic(deps, `cleanup.schedule.${index === 0 ? 'deadline' : 'monitor'}`, () => bounded(STOP_STAGE_BUDGET_MS, signal => safeDelete(deps, url, signal, `cleanup.schedule.${index === 0 ? 'deadline' : 'monitor'}`)));
  deps.notice('release-cleanup', {serviceAbsent: true, repositoryAbsent: true, sourceAndSecretAbsent: true, schedulesAbsent: true, ledgerStopped, retained: 'private ledger and monitor objects, job definition, IAM, audit logs'});
}

/** Shared metric request path for normal monitoring and explicit recovery checks. */
async function observeCost(deps: MonitorDependencies, signal: AbortSignal, state: MonitorState, time: number) {
  const end = new Date(time - MONITOR_LAG_MS).toISOString();
  const types = ['container/cpu/allocation_time', 'container/memory/allocation_time', 'container/network/sent_bytes_count', 'request_count'];
  const values = Date.parse(end) > Date.parse(state.startedAt) ? await Promise.all(types.map((metric, index) => diagnostic(deps, `observation.metrics.${['cpu', 'memory', 'network', 'requests'][index]}`, () => metricSum(url => deps.api('GET', url, signal), {project: deps.project, region, service, metric, start: state.startedAt, end})))) : [0, 0, 0, 0];
  const observed = {cpuSeconds: values[0]!, memoryGiBSeconds: values[1]!, sentBytes: values[2]!, requests: values[3]!};
  return diagnostic(deps, 'observation.cost-estimate', async () => infrastructureEstimate(state, observed, time));
}

/** Explicit operator preflight: no stop decision, DELETE or ledger mutation.
 * Only the existing monitor object is CAS-written with its exact original bytes.
 * A denied/uncertain CAS or concurrent change is a failure, never an implicit retry.
 */
export async function runMonitorPreflight(deps: MonitorDependencies): Promise<void> {
  const owned = targets(deps.project, deps.bucket), now = deps.now ?? Date.now;
  try {
    await bounded(OBSERVATION_BUDGET_MS, async signal => {
      const time = now(), store = deps.stateStore(signal);
      const version = await diagnostic(deps, 'observation.state-read', () => store.read());
      const state = await diagnostic(deps, 'preflight.state-validation', async () => {
        const value = JSON.parse(version.data) as MonitorState;
        if (value.schema !== 'ugoku-public-monitor-011' || typeof value.lastDailyNotice !== 'string'
          || !Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.checkedAt))
          || Date.parse(value.checkedAt) < Date.parse(value.startedAt) || Date.parse(value.checkedAt) > time
          || (value.stoppedAt !== undefined || value.stopReason !== undefined)
            && (!Number.isFinite(Date.parse(value.stoppedAt ?? '')) || typeof value.stopReason !== 'string' || !value.stopReason)) throw new MonitorFailure('invalid-state');
        // The exact production validator checks fixed reserve and all cumulative totals.
        infrastructureEstimate(value, value.totals, time);
        return value;
      });
      const currentService = await diagnostic(deps, 'observation.service-read', () => deps.api('GET', owned.service, signal));
      await diagnostic(deps, 'preflight.service-ready', async () => {
        const condition = currentService.terminalCondition as {type?: string; state?: string} | undefined;
        if (currentService.absent || currentService.reconciling === true || currentService.deleteTime !== undefined
          || condition?.type !== 'Ready' || condition.state !== 'CONDITION_SUCCEEDED'
          || typeof currentService.generation !== 'string' || currentService.generation !== currentService.observedGeneration
          || typeof currentService.latestReadyRevision !== 'string' || !currentService.latestReadyRevision
          || currentService.latestReadyRevision !== currentService.latestCreatedRevision) throw new MonitorFailure('invalid-state');
      });
      const ledger = deps.ledger(signal);
      const before = await diagnostic(deps, 'observation.ledger-read', () => ledger.snapshot());
      await diagnostic(deps, 'preflight.ledger-stopped', async () => {
        if (!before.stop.ai || !before.stop.whole || before.active) throw new MonitorFailure('invalid-state');
      });
      const estimate = await observeCost(deps, signal, state, time);
      signal.throwIfAborted();
      const generation = await diagnostic(deps, 'preflight.state-identical-cas', () => store.compareAndSwap(version.generation, version.data));
      signal.throwIfAborted();
      await diagnostic(deps, 'preflight.preservation-proof', async () => {
        const afterState = await store.read(), afterLedger = await ledger.snapshot();
        if (afterState.generation !== generation || afterState.data !== version.data || before.generation !== afterLedger.generation) throw new MonitorFailure('conflict');
      });
      deps.notice('monitor-preflight', {serviceReady: true, ledgerStopped: true, monitorBodyUnchanged: true, ledgerUnchanged: true,
        stateGeneration: generation, ledgerGeneration: before.generation, monitorBodySha256: createHash('sha256').update(version.data).digest('hex'),
        startedAt: state.startedAt, checkedAt: state.checkedAt, modelCommittedUsd: before.committedNano / 1e9,
        modelUnknownHeldUsd: before.sentUnknownNano / 1e9, requests: before.requests, sends: before.sends,
        infrastructure: estimate, stopDecision: false, deletes: 0, ledgerWrites: 0, creditsDeducted: 0, billingActual: false});
    });
  } catch (error) {
    deps.notice('monitor-diagnostic', {stage: 'preflight', ...failureDetails(error)});
    throw error;
  }
}

export function monitorMode(args: readonly string[]): 'normal' | 'preflight' {
  if (args.length === 0) return 'normal';
  if (args.length === 1 && args[0] === '--preflight') return 'preflight';
  throw new MonitorFailure('invalid-state');
}

/** Only control-plane/Monitoring APIs and generation CAS; never wakes the app. */
export async function runMonitor(deps: MonitorDependencies): Promise<void> {
  const owned = targets(deps.project, deps.bucket), now = deps.now ?? Date.now;
  let reason: string | undefined;
  try {
    reason = await bounded(OBSERVATION_BUDGET_MS, async signal => {
      if (now() >= Date.parse(RELEASE_DEADLINE)) return 'release-deadline';
      const stateStore = deps.stateStore(signal);
      const version = await diagnostic(deps, 'observation.state-read', () => stateStore.read()), state = JSON.parse(version.data) as MonitorState;
      if (state.schema !== 'ugoku-public-monitor-011' || typeof state.lastDailyNotice !== 'string') throw Error('Invalid initialized monitor');
      if (state.stoppedAt !== undefined || state.stopReason !== undefined) {
        if (!Number.isFinite(Date.parse(state.stoppedAt ?? '')) || typeof state.stopReason !== 'string' || !state.stopReason) throw Error('Invalid stop state');
        return state.stopReason;
      }
      // A direct deadline or fail-closed DELETE may not have persisted markers.
      if ((await diagnostic(deps, 'observation.service-read', () => deps.api('GET', owned.service, signal))).absent) return 'service-absent';
      const ledgerState = await diagnostic(deps, 'observation.ledger-read', () => deps.ledger(signal).snapshot());
      if (ledgerState.stop.whole) return 'operator-stop';
      const time = now(), estimate = await observeCost(deps, signal, state, time);
      const reason = stopReason(time, estimate.totalUsd, false), day = dailyNoticeKey(time);
      const updated: MonitorState = {...state, checkedAt: new Date(time).toISOString(), totals: estimate.totals, lastDailyNotice: day, ...(reason ? {stoppedAt: new Date(time).toISOString(), stopReason: reason} : {})};
      await diagnostic(deps, 'observation.state-write', () => stateStore.compareAndSwap(version.generation, JSON.stringify(updated)));
      const report = {day, infrastructure: estimate, modelCommittedUsd: ledgerState.committedNano / 1e9, modelUnknownHeldUsd: ledgerState.sentUnknownNano / 1e9, requests: ledgerState.requests, sends: ledgerState.sends, modelBudgetUsd: 85, infraStopUsd: 8, grossLimitUsd: 100, creditsDeducted: 0, billingActual: false};
      if (day !== state.lastDailyNotice) deps.notice('daily-review', report);
      if (estimate.totalUsd >= INFRA_WARNING_USD || ledgerState.committedNano >= 65e9) deps.notice('budget-warning', report);
      deps.notice('monitor-check', report);
      return reason;
    });
  } catch (error) {
    deps.notice('monitor-diagnostic', {stage: 'observation', ...failureDetails(error)});
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
  let response: Response;
  try {response = await fetcher(address, {method, headers: {Authorization: `Bearer ${accessToken}`}, signal, redirect: 'error'});}
  catch {throw new MonitorFailure(signal.aborted ? 'timeout' : 'transport');}
  if (response.status === 404 && !address.startsWith('https://monitoring.googleapis.com/')) {await response.body?.cancel(); return {absent: true};}
  if (!response.ok) {await response.body?.cancel(); throw new MonitorFailure('http', response.status);}
  if (!response.body) return {};
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {const {done, value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 2_097_152) throw new MonitorFailure('response-limit'); chunks.push(value);}
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
  const text = Buffer.concat(chunks).toString('utf8'); return text ? JSON.parse(text) : {};
}
function notice(event: string, data: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({severity: ['release-stopped', 'monitor-failed', 'ledger-stop-unconfirmed', 'monitor-diagnostic', 'monitor-preflight-failed'].includes(event) ? 'ERROR' : event === 'budget-warning' ? 'WARNING' : 'NOTICE', component: 'ugoku-public-monitor-011', event, ...data}) + '\n');
}
async function main() {
  let mode: ReturnType<typeof monitorMode> | undefined;
  try {
    mode = monitorMode(process.argv.slice(2));
    const project = process.env.MONITOR_PROJECT ?? '', bucket = process.env.MONITOR_BUCKET ?? '';
    const store = (object: string, signal: AbortSignal) => new GcsLedgerStore({bucket, object, fetch: (url, init) => {signal.throwIfAborted(); return fetch(url, {...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal});}});
    const deps: MonitorDependencies = {project, bucket, stateStore: signal => store('public-release-011/monitor.json', signal), ledger: signal => new PublicLedger(store('public-release-011/ledger.json', signal)), api: cloudApi, notice};
    if (mode === 'preflight') await runMonitorPreflight(deps); else await runMonitor(deps);
  } catch (error) {
    notice(mode === 'preflight' ? 'monitor-preflight-failed' : 'monitor-failed', {stage: mode ? 'entrypoint' : 'arguments', ...failureDetails(error), reason: mode === 'preflight' ? 'Preflight failed; no stop decision or ledger stop change was performed' : 'Monitor execution did not finish; operator action required'});
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

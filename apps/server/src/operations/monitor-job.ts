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
export const CLOUD_READ_ATTEMPT_MS = 1_500;
type CloudResult = {absent?: boolean; name?: string; [key: string]: unknown};
export type MonitorDependencies = {
  project: string; bucket: string; now?: () => number;
  stateStore: (signal: AbortSignal) => PublicLedgerStore;
  ledger: (signal: AbortSignal) => Pick<PublicLedger, 'snapshot' | 'setStop'> & Partial<Pick<PublicLedger, 'confirmObservation'>>;
  api: (method: 'GET' | 'DELETE', url: string, signal: AbortSignal) => Promise<CloudResult>;
  notice: (event: string, data: Record<string, unknown>) => void;
};
type FailureCategory = 'timeout' | 'http' | 'permission' | 'invalid' | 'size' | 'transport' | 'invalid-response' | 'partial-response' | 'response-limit' | 'pagination-limit' | 'invalid-state' | 'unavailable' | 'missing' | 'conflict' | 'uncertain' | 'unknown';
class MonitorFailure extends Error {
  constructor(readonly category: FailureCategory, readonly httpStatus?: number, readonly retryAfterMs = 0) {
    super(category === 'response-limit' ? 'Monitor response limit' : `Monitor failure: ${category}${httpStatus === undefined ? '' : ` (${httpStatus})`}`);
  }
}
/** Never forward exception messages, response bodies, URLs or credentials. */
function failureDetails(error: unknown): {category: FailureCategory; httpStatus?: number; detailStage?: string} {
  if (error instanceof Error && error.cause instanceof LedgerStoreError) return failureDetails(error.cause);
  if (error instanceof MonitorFailure) return {category: error.category, ...(error.httpStatus === undefined ? {} : {httpStatus: error.httpStatus})};
  if (error instanceof LedgerStoreError) return {category: error.details?.category ?? error.kind, ...(error.details ? {detailStage: error.details.stage, ...(error.details.httpStatus === undefined ? {} : {httpStatus: error.details.httpStatus})} : {})};
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
      // Preserve the reason without replacing cumulative observations or creating
      // a missing state. Failure here cannot postpone service/AI shutdown.
      const stopState = diagnostic(deps, 'stop.state-marker', async () => {
        const store = deps.stateStore(signal), version = await store.read();
        const state = validateState(version.data, (deps.now ?? Date.now)());
        if (state.stoppedAt !== undefined) return;
        signal.throwIfAborted();
        await store.compareAndSwap(version.generation, JSON.stringify({...state, stoppedAt: new Date((deps.now ?? Date.now)()).toISOString(), stopReason: reason}));
      }).catch(() => {});
      const result = await deletion; deletionAccepted = true;
      deps.notice('release-stopped', {reason, deletionAccepted: true, operation: result.name ?? null});
      await Promise.all([stopLedger, stopState]);
    });
  } catch (error) {deps.notice('monitor-diagnostic', {stage: 'cleanup.service-and-ledger', ...failureDetails(error)}); if (!deletionAccepted) throw error;}
  deps.notice(ledgerStopped ? 'ledger-stop' : 'ledger-stop-unconfirmed', {confirmed: ledgerStopped});
  const terminal = ['release-deadline', 'infrastructure-reserve', 'operator-stop'].includes(reason);
  if (!terminal) {
    deps.notice('recovery-materials-retained', {reason, ledgerStopped, serviceDeletionAccepted: deletionAccepted,
      until: RELEASE_DEADLINE, retained: 'repository, secret, source, schedules, ledger, monitor state', automaticResume: false});
    return;
  }
  if (!ledgerStopped) {
    deps.notice('cleanup-pending', {reason: 'Persistent ledger stop must be confirmed before material deletion'});
    return;
  }
  // A terminal stop can clean application materials. The repository contains
  // this Job's own image: delete it LAST, after all dependent work is confirmed.
  const names = ['secret', 'source'] as const, materials = owned.owned.slice(1);
  await diagnostic(deps, 'cleanup.resources', () => bounded(STOP_STAGE_BUDGET_MS, signal => Promise.all(materials.map((url, index) => safeDelete(deps, url, signal, `cleanup.${names[index]}`)))));
  const absent = await diagnostic(deps, 'cleanup.verify', () => bounded(STOP_STAGE_BUDGET_MS, signal => Promise.all([owned.service, ...materials].map((url, index) => diagnostic(deps, `cleanup.verify.${['service', ...names][index]}`, () => deps.api('GET', url, signal))))));
  if (!ledgerStopped || absent.some(result => !result.absent)) {deps.notice('cleanup-pending', {reason: ledgerStopped ? 'Deletion accepted; remaining resources will be checked next time' : 'Service deletion accepted; persistent ledger stop will be retried'}); return;}
  // Deadline first, monitor last: a failed deadline deletion stays retryable.
  for (const [index, url] of owned.schedules.entries()) await diagnostic(deps, `cleanup.schedule.${index === 0 ? 'deadline' : 'monitor'}`, () => bounded(STOP_STAGE_BUDGET_MS, async signal => {
    await safeDelete(deps, url, signal, `cleanup.schedule.${index === 0 ? 'deadline' : 'monitor'}`);
    if (!(await deps.api('GET', url, signal)).absent) throw new MonitorFailure('uncertain');
  }));
  const repository = await diagnostic(deps, 'cleanup.repository-final', () => bounded(STOP_STAGE_BUDGET_MS, signal => safeDelete(deps, owned.owned[0]!, signal, 'cleanup.repository')));
  deps.notice('release-cleanup', {serviceAbsent: true, repositoryDeletionAccepted: true, repositoryAbsent: repository.absent === true,
    repositoryOperation: repository.name ?? null, sourceAndSecretAbsent: true, schedulesAbsent: true, ledgerStopped,
    retained: 'private ledger and monitor objects, job definition, IAM, audit logs'});
}

function validateState(data: string, time: number): MonitorState {
  const state = JSON.parse(data) as MonitorState;
  if (state.schema !== 'ugoku-public-monitor-011' || typeof state.lastDailyNotice !== 'string'
    || !Number.isFinite(Date.parse(state.checkedAt)) || Date.parse(state.checkedAt) < Date.parse(state.startedAt)
    || Date.parse(state.checkedAt) > time
    || (state.stoppedAt !== undefined || state.stopReason !== undefined)
      && (!Number.isFinite(Date.parse(state.stoppedAt ?? '')) || typeof state.stopReason !== 'string' || !state.stopReason)) throw new MonitorFailure('invalid-state');
  infrastructureEstimate(state, state.totals, time);
  return state;
}

/** Shared metric request path for normal monitoring and explicit recovery checks. */
async function observeCost(deps: MonitorDependencies, signal: AbortSignal, state: MonitorState, time: number) {
  const end = new Date(time - MONITOR_LAG_MS).toISOString();
  const types = ['container/cpu/allocation_time', 'container/memory/allocation_time', 'container/network/sent_bytes_count', 'request_count'];
  if (Date.parse(end) <= Date.parse(state.startedAt)) throw new MonitorFailure('partial-response');
  const values = await Promise.all(types.map((metric, index) => diagnostic(deps, `observation.metrics.${['cpu', 'memory', 'network', 'requests'][index]}`, () => metricSum(url => deps.api('GET', url, signal), {project: deps.project, region, service, metric, start: state.startedAt, end}))));
  const observed = {cpuSeconds: values[0]!, memoryGiBSeconds: values[1]!, sentBytes: values[2]!, requests: values[3]!};
  for (const key of Object.keys(observed) as (keyof typeof observed)[]) {
    if (observed[key] + Math.max(1e-6, state.totals[key] * 1e-9) < state.totals[key]) throw new MonitorFailure('partial-response');
  }
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
        startedAt: state.startedAt, checkedAt: state.checkedAt, observedAt: new Date(time).toISOString(), modelCommittedUsd: before.committedNano / 1e9,
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
      let version = await diagnostic(deps, 'observation.state-read', () => stateStore.read()), state = validateState(version.data, now());
      if (state.stoppedAt !== undefined || state.stopReason !== undefined) {
        if (!Number.isFinite(Date.parse(state.stoppedAt ?? '')) || typeof state.stopReason !== 'string' || !state.stopReason) throw Error('Invalid stop state');
        return state.stopReason;
      }
      // A direct deadline or fail-closed DELETE may not have persisted markers.
      if ((await diagnostic(deps, 'observation.service-read', () => deps.api('GET', owned.service, signal))).absent) return 'service-absent';
      const ledgerState = await diagnostic(deps, 'observation.ledger-read', () => deps.ledger(signal).snapshot());
      // A monitor can set the ledger stop but lose its state-marker write. Do
      // not reinterpret that ambiguous stop as permission to destroy materials.
      if (ledgerState.stop.whole) return 'persistent-stop-unclassified';
      const time = now(), observed = await observeCost(deps, signal, state, time), day = dailyNoticeKey(time);
      let estimate = observed, reason = stopReason(time, estimate.totalUsd, false);
      for (let attempt = 0; attempt < 2; attempt++) {
        const updated: MonitorState = {...state, checkedAt: new Date(time).toISOString(), totals: estimate.totals, lastDailyNotice: day, ...(reason ? {stoppedAt: new Date(time).toISOString(), stopReason: reason} : {})};
        const body = JSON.stringify(updated); signal.throwIfAborted();
        try {await diagnostic(deps, 'observation.state-write', () => stateStore.compareAndSwap(version.generation, body)); break;}
        catch (error) {
          if (!(error instanceof LedgerStoreError) || !['conflict', 'uncertain'].includes(error.kind)) throw error;
          if (error.kind === 'conflict' && attempt !== 0) throw error;
          signal.throwIfAborted();
          const proof = await diagnostic(deps, 'observation.state-readback', () => stateStore.read());
          if (error.kind === 'uncertain') {
            if (proof.generation !== version.generation && proof.data === body) break;
            throw error; // Unknown write result is never blindly resubmitted.
          }
          state = validateState(proof.data, time);
          if (state.stoppedAt !== undefined) return state.stopReason;
          version = proof; estimate = infrastructureEstimate(state, observed.totals, time);
          reason = stopReason(time, estimate.totalUsd, false);
        }
      }
      signal.throwIfAborted();
      if (!reason && deps.ledger(signal).confirmObservation) await diagnostic(deps, 'observation.ledger-freshness', () => deps.ledger(signal).confirmObservation!(time));
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
async function cloudAttempt(method: 'GET' | 'DELETE', address: string, signal: AbortSignal, token: typeof metadataAccessToken, fetcher: typeof fetch): Promise<CloudResult> {
  signal.throwIfAborted(); const accessToken = await token(signal); signal.throwIfAborted();
  let response: Response;
  try {response = await fetcher(address, {method, headers: {Authorization: `Bearer ${accessToken}`}, signal, redirect: 'error'});}
  catch {throw new MonitorFailure(signal.aborted ? 'timeout' : 'transport');}
  if (response.status === 404 && !address.startsWith('https://monitoring.googleapis.com/')) {await response.body?.cancel(); return {absent: true};}
  if (!response.ok) {
    const header = response.headers.get('retry-after');
    const retryAfterMs = header === null ? 0 : /^\d+$/.test(header) ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now());
    await response.body?.cancel(); throw new MonitorFailure(response.status === 401 || response.status === 403 ? 'permission' : 'http', response.status, Number.isFinite(retryAfterMs) ? retryAfterMs : Infinity);
  }
  if (!response.body) return {};
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {const {done, value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 2_097_152) throw new MonitorFailure('response-limit'); chunks.push(value);}
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
  const text = Buffer.concat(chunks).toString('utf8'); return text ? JSON.parse(text) : {};
}
/** Only GET is retried, once, inside the caller's total observation/stop budget.
 * DELETE/CAS/model generation never inherit these read retry rules. */
export async function cloudApi(method: 'GET' | 'DELETE', address: string, signal: AbortSignal, token = metadataAccessToken, fetcher: typeof fetch = fetch): Promise<CloudResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    try {
      return await bounded(CLOUD_READ_ATTEMPT_MS, inner => cloudAttempt(method, address, AbortSignal.any([signal, inner]), token, fetcher));
    } catch (error) {
      signal.throwIfAborted(); const detail = failureDetails(error);
      const retryable = ['timeout', 'transport'].includes(detail.category)
        || detail.httpStatus !== undefined && (detail.httpStatus === 408 || detail.httpStatus === 429 || detail.httpStatus >= 500);
      const waitMs = Math.max(100, error instanceof MonitorFailure ? error.retryAfterMs : 0);
      if (method !== 'GET' || attempt !== 0 || !retryable || waitMs > 250) throw error;
      await new Promise<void>((resolve, reject) => {
        const aborted = () => {clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(new MonitorFailure('timeout'));};
        const timer = setTimeout(() => {signal.removeEventListener('abort', aborted); resolve();}, waitMs);
        signal.addEventListener('abort', aborted, {once: true});
        if (signal.aborted) aborted();
      });
    }
  }
  throw new MonitorFailure('unavailable');
}
function notice(event: string, data: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({severity: ['release-stopped', 'monitor-failed', 'ledger-stop-unconfirmed', 'monitor-diagnostic', 'monitor-preflight-failed'].includes(event) ? 'ERROR' : event === 'budget-warning' ? 'WARNING' : 'NOTICE', component: 'ugoku-public-monitor-011', event, ...data}) + '\n');
}
async function main() {
  let mode: ReturnType<typeof monitorMode> | undefined;
  try {
    mode = monitorMode(process.argv.slice(2));
    const project = process.env.MONITOR_PROJECT ?? '', bucket = process.env.MONITOR_BUCKET ?? '';
    const store = (object: string, signal: AbortSignal) => new GcsLedgerStore({bucket, object, signal});
    const deps: MonitorDependencies = {project, bucket, stateStore: signal => store('public-release-011/monitor.json', signal), ledger: signal => new PublicLedger(store('public-release-011/ledger.json', signal)), api: cloudApi, notice};
    if (mode === 'preflight') await runMonitorPreflight(deps); else await runMonitor(deps);
  } catch (error) {
    notice(mode === 'preflight' ? 'monitor-preflight-failed' : 'monitor-failed', {stage: mode ? 'entrypoint' : 'arguments', ...failureDetails(error), reason: mode === 'preflight' ? 'Preflight failed; no stop decision or ledger stop change was performed' : 'Monitor execution did not finish; operator action required'});
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudApi, CLOUD_READ_ATTEMPT_MS, monitorMode, OBSERVATION_BUDGET_MS, runMonitor, runMonitorPreflight, STOP_STAGE_BUDGET_MS, type MonitorDependencies } from '../src/operations/monitor-job.js';
import { dailyNoticeKey, RELEASE_DEADLINE, type MonitorState } from '../src/operations/cost-monitor.js';
import { LedgerStoreError, PublicLedger, initialPublicLedger, publicLedgerHash, publicLedgerSummary } from '../src/public-ledger.js';

const now = Date.parse('2026-10-06T03:00:00Z'), start = now - 12 * 3600000;
function harness() {
  let state: MonitorState = {schema: 'ugoku-public-monitor-011', startedAt: new Date(start).toISOString(), checkedAt: new Date(start).toISOString(), fixedReserveUsd: 1.5, totals: {cpuSeconds: 0, memoryGiBSeconds: 0, sentBytes: 0, requests: 0}, lastDailyNotice: ''};
  const deleted = new Set<string>(), requests: {method: string; url: string}[] = [], notices: {event: string; data: Record<string, unknown>}[] = [];
  let cpu = 3600, pendingResource = '', serviceAbsent = false, stateGeneration = 123;
  const stateStore = {read: vi.fn(async () => ({generation: String(stateGeneration), data: JSON.stringify(state)})), compareAndSwap: vi.fn(async (generation: string, data: string) => {expect(generation).toBe(String(stateGeneration)); state = JSON.parse(data); return String(++stateGeneration);})};
  const ledger = {snapshot: vi.fn(async () => ({generation: '55', ...publicLedgerSummary(initialPublicLedger(start), now)})), setStop: vi.fn(async () => {}), confirmObservation: vi.fn(async (_checkedAt: number) => {})};
  const deps: MonitorDependencies = {
    project: 'example-project', bucket: 'example-project-ugoku-g011', now: () => now,
    stateStore: () => stateStore, ledger: () => ledger,
    notice: (event, data) => {notices.push({event, data});},
    api: vi.fn(async (method, url) => {
      requests.push({method, url});
      if (method === 'DELETE') {deleted.add(url.replace('?force=true', '')); return {name: 'operations/fixture-deletion'};}
      if (url.includes('monitoring.googleapis.com')) {
        const filter = new URL(url).searchParams.get('filter')!;
        return {timeSeries: [{points: [{value: {doubleValue: filter.includes('cpu/allocation_time') ? cpu : 0}}]}]};
      }
      if (pendingResource && url.includes(pendingResource)) return {name: 'still-deleting'};
      return deleted.has(url) || serviceAbsent && url.includes('run.googleapis.com') ? {absent: true} : {name: 'dedicated-resource'};
    }),
  };
  return {deps, stateStore, ledger, requests, notices, deleted, state: () => state, setState: (value: Partial<MonitorState>) => {state = {...state, ...value};}, cpu: (n: number) => {cpu = n;}, pendingResource: (value: string) => {pendingResource = value;}, concurrentState: (value: Partial<MonitorState>) => {state = {...state, ...value}; stateGeneration++;}, serviceAbsent: () => {serviceAbsent = true;}};
}
afterEach(() => vi.useRealTimers());
describe('independent monitor Job: injected control-plane APIs only', () => {
  it('reads full release interval for all four metrics, CASes totals and emits a daily notice only once', async () => {
    const h = harness(); await runMonitor(h.deps);
    const metrics = h.requests.filter(request => request.url.includes('monitoring.googleapis.com'));
    expect(metrics).toHaveLength(4);
    for (const request of metrics) {
      const url = new URL(request.url);
      expect(request.method).toBe('GET'); expect(url.searchParams.get('interval.startTime')).toBe(new Date(start).toISOString());
      expect(url.searchParams.get('filter')).toContain('resource.labels.service_name="ugoku-kami-release-011"');
      expect(url.searchParams.get('filter')).not.toContain('metric.labels.kind');
    }
    expect(h.state().totals.cpuSeconds).toBe(3600); expect(h.state().lastDailyNotice).toBe(dailyNoticeKey(now));
    expect(h.notices.filter(item => item.event === 'daily-review')).toHaveLength(1);
    expect(h.requests.every(request => request.method === 'GET')).toBe(true);
    await runMonitor(h.deps);
    expect(h.notices.filter(item => item.event === 'daily-review')).toHaveLength(1);
    expect(h.notices.at(-1)?.data).toMatchObject({creditsDeducted: 0, billingActual: false, modelBudgetUsd: 85});
  });
  it('warns at six without deleting and stops at eight, deleting only owned resources with its own image repository last', async () => {
    const h = harness(); h.cpu(260000); await runMonitor(h.deps);
    expect(h.notices.some(item => item.event === 'budget-warning')).toBe(true);
    expect(h.deleted.size).toBe(0);
    h.cpu(360000); await runMonitor(h.deps);
    expect(h.state().stopReason).toBe('infrastructure-reserve');
    expect(h.ledger.setStop).toHaveBeenCalledWith({ai: true, whole: true});
    const deleted = h.requests.filter(request => request.method === 'DELETE').map(request => request.url);
    expect(deleted).toHaveLength(6);
    expect(deleted[0]).toContain('/services/ugoku-kami-release-011');
    expect(deleted.slice(-3).map(url => url.split('/').at(-1))).toEqual(['ugoku-deadline-011', 'ugoku-monitor-011', 'ugoku-kami-release-011']);
    expect(deleted.at(-1)).toContain('artifactregistry.googleapis.com');
    expect(h.requests.at(-1)).toEqual({method: 'DELETE', url: deleted.at(-1)});
    expect(h.notices.at(-1)?.data).toMatchObject({repositoryDeletionAccepted: true, repositoryAbsent: false, repositoryOperation: 'operations/fixture-deletion', sourceAndSecretAbsent: true, schedulesAbsent: true});
    expect(deleted.some(url => /ledger|monitor.json|buckets|serviceAccounts/.test(url))).toBe(false);
    expect(h.notices.at(-1)?.event).toBe('release-cleanup');
  });
  it('repository DELETE wire has no unsupported force parameter and retains scoped authorization', async () => {
    const h = harness(); h.deps.now = () => Date.parse(RELEASE_DEADLINE);
    const api = h.deps.api;
    const fetcher = vi.fn<typeof fetch>(async (address, init) => {
      const url = new URL(String(address));
      if (url.search) return Response.json({error: {message: 'Unknown query parameter'}}, {status: 400});
      expect(init?.method).toBe('DELETE');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token');
      h.deleted.add(url.href);
      return Response.json({name: 'operations/repository-delete'});
    });
    h.deps.api = (method, url, signal) => method === 'DELETE' && url.includes('artifactregistry.')
      ? cloudApi(method, url, signal, async () => 'fixture-token', fetcher) : api(method, url, signal);
    await runMonitor(h.deps);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetcher.mock.calls[0]![0])).search).toBe('');
    expect(h.notices.at(-1)?.event).toBe('release-cleanup');
  });
  it('records observation HTTP status and stage without response text, tokens or private URL', async () => {
    const h = harness(), api = h.deps.api;
    let failed = false;
    h.deps.api = (method, url, signal) => {
      if (!failed && method === 'GET' && url.includes('/services/')) {
        failed = true;
        return cloudApi(method, url, signal, async () => 'SECRET_TOKEN', async () => Response.json({error: {message: 'SECRET_BODY'}}, {status: 503}));
      }
      return api(method, url, signal);
    };
    await runMonitor(h.deps);
    expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'observation.service-read', category: 'http', httpStatus: 503}});
    const diagnostics = h.notices.filter(n => n.event === 'monitor-diagnostic');
    expect(JSON.stringify(diagnostics)).not.toMatch(/SECRET|googleapis|example-project/);
    expect(h.deleted.size).toBe(1);
    expect(h.notices.at(-1)).toMatchObject({event: 'recovery-materials-retained', data: {reason: 'monitor-unavailable', automaticResume: false}});
    expect(h.state()).toMatchObject({startedAt: new Date(start).toISOString(), checkedAt: new Date(start).toISOString(), stopReason: 'monitor-unavailable', stoppedAt: new Date(now).toISOString()});
  });
  it('preserves a failing secret cleanup and HTTP status, leaving schedules and repository for retry', async () => {
    const h = harness(), api = h.deps.api; h.deps.now = () => Date.parse(RELEASE_DEADLINE);
    h.deps.api = (method, url, signal) => method === 'DELETE' && url.includes('secretmanager.')
      ? cloudApi(method, url, signal, async () => 'SECRET_TOKEN', async () => Response.json({error: {message: 'SECRET_CLEANUP'}}, {status: 400}))
      : api(method, url, signal);
    await expect(runMonitor(h.deps)).rejects.toThrow('incomplete');
    expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'cleanup.secret.delete', category: 'http', httpStatus: 400}});
    expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'cleanup.resources', category: 'http', httpStatus: 400}});
    expect(h.requests.some(r => /cloudscheduler|artifactregistry/.test(r.url))).toBe(false);
    expect(JSON.stringify(h.notices)).not.toContain('SECRET');
  });
  it('hides unknown state-write exception text and fails closed without destroying recovery assets', async () => {
    const h = harness(); h.stateStore.compareAndSwap.mockRejectedValueOnce(Error('SECRET_UNKNOWN'));
    await runMonitor(h.deps);
    expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'observation.state-write', category: 'unknown'}});
    expect(JSON.stringify(h.notices)).not.toContain('SECRET');
    expect(h.notices.some(n => n.event === 'monitor-check')).toBe(false);
    expect(h.deleted.size).toBe(1); expect(h.ledger.confirmObservation).not.toHaveBeenCalled();
  });
  it('a persisted stop marker resumes cleanup after a recovered ledger; unconfirmed secret deletion keeps both schedules and the repository', async () => {
    const h = harness(); h.setState({stoppedAt: new Date(now - 1000).toISOString(), stopReason: 'infrastructure-reserve'}); h.pendingResource('secretmanager.');
    await runMonitor(h.deps);
    expect(h.ledger.snapshot).not.toHaveBeenCalled();
    expect(h.requests.some(request => request.url.includes('monitoring.googleapis.com'))).toBe(false);
    expect(h.requests.some(request => request.url.includes('cloudscheduler.googleapis.com'))).toBe(false);
    expect(h.notices.at(-1)?.event).toBe('cleanup-pending');
    h.pendingResource(''); await runMonitor(h.deps);
    expect(h.notices.at(-1)?.event).toBe('release-cleanup');
  });
  it('an absent service before the deadline preserves recovery materials and marks the reason', async () => {
    const h = harness(); h.serviceAbsent(); await runMonitor(h.deps);
    expect(h.notices.find(item => item.event === 'release-stopped')?.data.reason).toBe('service-absent');
    expect(h.ledger.snapshot).not.toHaveBeenCalled();
    expect(h.notices.at(-1)?.event).toBe('recovery-materials-retained');
    expect(h.requests.every(r => r.method === 'GET' && r.url.includes('/services/'))).toBe(true);
    expect(h.state().stopReason).toBe('service-absent');
  });
  it('missing state or an unknown CAS result fails closed instead of publishing a successful cost observation', async () => {
    for (const failure of ['read', 'compareAndSwap'] as const) {
      const h = harness(); h.stateStore[failure].mockRejectedValueOnce(Error('private-state-detail'));
      await runMonitor(h.deps);
      expect(h.requests.some(request => request.method === 'DELETE' && request.url.includes('/services/'))).toBe(true);
      expect(h.notices.some(item => item.event === 'monitor-check')).toBe(false);
      expect(JSON.stringify(h.notices)).not.toContain('private-state-detail');
    }
  });
  it('a hung observation and hung stop write cannot consume the Job before service deletion', async () => {
    vi.useFakeTimers(); const h = harness(); const readSignals: AbortSignal[] = [];
    h.deps.stateStore = signal => {readSignals.push(signal); return h.stateStore;};
    h.stateStore.read.mockImplementation(() => new Promise(() => {}));
    h.ledger.setStop.mockImplementation(() => new Promise(() => {}));
    const task = runMonitor(h.deps);
    await vi.advanceTimersByTimeAsync(OBSERVATION_BUDGET_MS);
    expect(readSignals[0]?.aborted).toBe(true);
    expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'observation', category: 'timeout'}});
    expect(h.requests[0]).toMatchObject({method: 'GET'});
    expect(h.requests[0]!.url).toContain('/services/ugoku-kami-release-011');
    expect(h.requests.find(request => request.method === 'DELETE')?.url).toContain('/services/ugoku-kami-release-011');
    await vi.advanceTimersByTimeAsync(STOP_STAGE_BUDGET_MS); await task;
    expect(h.notices.some(item => item.event === 'ledger-stop-unconfirmed')).toBe(true);
    expect(h.notices.at(-1)?.event).toBe('recovery-materials-retained');
    expect(h.requests.some(request => request.url.includes('cloudscheduler.googleapis.com'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('deadline bypasses unavailable metrics, and a failed cleanup never deletes the last monitor scheduler', async () => {
    const h = harness(); h.deps.now = () => Date.parse(RELEASE_DEADLINE);
    const api = h.deps.api;
    h.deps.api = async (method, url, signal) => {if (url.endsWith('/ugoku-deadline-011')) throw Error('denied'); return api(method, url, signal);};
    await expect(runMonitor(h.deps)).rejects.toThrow('incomplete');
    expect(h.ledger.snapshot).not.toHaveBeenCalled();
    expect(h.requests.some(request => /monitoring|artifactregistry/.test(request.url))).toBe(false);
    expect(h.requests.some(request => request.url.endsWith('/ugoku-monitor-011'))).toBe(false);
    expect(h.requests[0]!.url).toContain('/services/');
  });
  it('malformed partial Monitoring responses stop service instead of accepting a low partial total', async () => {
    const h = harness(), api = h.deps.api;
    h.deps.api = async (method, url, signal) => url.includes('monitoring.googleapis.com') ? {executionErrors: [{code: 14}], timeSeries: []} : api(method, url, signal);
    await runMonitor(h.deps);
    expect(h.notices.some(item => item.event === 'monitor-check')).toBe(false);
    expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'observation.metrics.cpu', category: 'partial-response'}});
    expect(h.requests.some(request => request.method === 'DELETE' && request.url.includes('/services/'))).toBe(true);
  });
  it('empty or regressed cumulative metrics cannot refresh AI admission or replace the last successful totals', async () => {
    for (const fault of ['empty', 'regressed'] as const) {
      const h = harness(), api = h.deps.api;
      h.setState({totals: {...h.state().totals, cpuSeconds: 7200}});
      h.deps.api = async (method, url, signal) => url.includes('monitoring.') && fault === 'empty' ? {timeSeries: []} : api(method, url, signal);
      await runMonitor(h.deps);
      expect(h.state().totals.cpuSeconds).toBe(7200); expect(h.state().checkedAt).toBe(new Date(start).toISOString());
      expect(h.ledger.confirmObservation).not.toHaveBeenCalled();
      expect(h.notices.some(n => n.event === 'monitor-check')).toBe(false);
      expect(h.notices.at(-1)?.event).toBe('recovery-materials-retained'); expect(h.deleted.size).toBe(1);
    }
  });
  it('an unconfirmed service DELETE retains cleanup targets and schedules and reports failure', async () => {
    const h = harness(); h.deps.now = () => Date.parse(RELEASE_DEADLINE);
    const api = h.deps.api;
    h.deps.api = async (method, url, signal) => {if (url.includes('/services/')) throw Error('private API response'); return api(method, url, signal);};
    await expect(runMonitor(h.deps)).rejects.toThrow('incomplete');
    expect(h.ledger.setStop).toHaveBeenCalledWith({ai: true, whole: true});
    expect(h.deleted.size).toBe(0);
    expect(h.notices.at(-1)?.event).toBe('monitor-failed');
    expect(JSON.stringify(h.notices)).not.toContain('private API response');
  });
  it('an invalid project/bucket binding performs no read or deletion', async () => {
    const h = harness(); h.deps.bucket = 'unrelated-bucket';
    await expect(runMonitor(h.deps)).rejects.toThrow('dedicated monitor target');
    expect(h.requests).toHaveLength(0); expect(h.stateStore.read).not.toHaveBeenCalled();
  });
  it('already absent resources skip DELETE even after their resource-level IAM bindings disappear', async () => {
    const h = harness(); h.deps.now = () => Date.parse(RELEASE_DEADLINE);
    const requests: {method: string; url: string}[] = [];
    h.deps.api = async (method, url) => {requests.push({method, url}); if (method === 'DELETE') throw Error('403 deleted resource binding'); return {absent: true};};
    await runMonitor(h.deps);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect(h.notices.at(-1)?.data).toMatchObject({repositoryDeletionAccepted: true, repositoryAbsent: true, repositoryOperation: null});
    expect(requests[0]!.url).toContain('/services/ugoku-kami-release-011');
    expect(h.ledger.setStop).toHaveBeenCalledWith({ai: true, whole: true});
    expect(h.notices.at(-1)?.event).toBe('release-cleanup');
  });
  for (const outcome of ['403', 'timeout'] as const) {
    it(`DELETE ${outcome} resumes cleanup only after a fresh GET proves absence`, async () => {
      vi.useFakeTimers(); const h = harness(); h.deps.now = () => Date.parse(RELEASE_DEADLINE);
      const api = h.deps.api; let serviceDeleted = false, readCount = 0;
      h.deps.api = async (method, url, signal) => {
        if (url.includes('/services/')) {
          if (method === 'GET') {readCount++; return serviceDeleted ? {absent: true} : {name: 'present'};}
          serviceDeleted = true;
          if (outcome === '403') throw Error('403 after deletion');
          return new Promise(() => {});
        }
        return api(method, url, signal);
      };
      const task = runMonitor(h.deps);
      await vi.advanceTimersByTimeAsync(STOP_STAGE_BUDGET_MS); await task;
      expect(readCount).toBeGreaterThanOrEqual(3); // before, after failure, final absence
      expect(h.notices.at(-1)?.event).toBe('release-cleanup');
      expect(vi.getTimerCount()).toBe(0);
    });
  }
  it('DELETE403 while the service still exists never becomes a successful cleanup', async () => {
    const h = harness(); h.deps.now = () => Date.parse(RELEASE_DEADLINE);
    h.deps.api = async method => {if (method === 'DELETE') throw Error('403'); return {name: 'still-present'};};
    await expect(runMonitor(h.deps)).rejects.toThrow('incomplete');
    expect(h.notices.some(item => item.event === 'release-cleanup')).toBe(false);
  });
  it('repeated observation-stop markers never escalate into destructive cleanup through a stopped ledger', async () => {
    const h = harness(); h.setState({stoppedAt: new Date(now - 1000).toISOString(), stopReason: 'monitor-unavailable'});
    h.ledger.snapshot.mockResolvedValue({...await h.ledger.snapshot(), stop: {ai: true, whole: true}}); h.ledger.snapshot.mockClear();
    for (let i = 0; i < 2; i++) await runMonitor(h.deps);
    expect(h.ledger.snapshot).not.toHaveBeenCalled();
    expect(h.requests.every(r => r.url.includes('/services/'))).toBe(true);
    expect(h.notices.filter(n => n.event === 'recovery-materials-retained')).toHaveLength(2);
    expect(h.state().stopReason).toBe('monitor-unavailable');
  });
  it('a stopped ledger without an explicit terminal marker retains assets, including after failed service deletion and marker write', async () => {
    const h = harness(), api = h.deps.api;
    h.ledger.setStop.mockImplementation(async () => {
      h.ledger.snapshot.mockResolvedValue({...await h.ledger.snapshot(), stop: {ai: true, whole: true}});
    });
    h.stateStore.read.mockRejectedValueOnce(new LedgerStoreError('unavailable'));
    h.stateStore.compareAndSwap.mockRejectedValueOnce(new LedgerStoreError('uncertain'));
    h.deps.api = async (method, url, signal) => {
      if (method === 'DELETE' && url.includes('/services/')) throw Error('private transport failure');
      return api(method, url, signal);
    };
    await expect(runMonitor(h.deps)).rejects.toThrow('incomplete');
    expect(h.state().stopReason).toBeUndefined();
    h.deps.api = api; await runMonitor(h.deps);
    expect(h.notices.at(-1)).toMatchObject({event: 'recovery-materials-retained', data: {reason: 'persistent-stop-unclassified'}});
    expect(h.requests.every(r => r.url.includes('/services/'))).toBe(true);
    expect(h.ledger.confirmObservation).not.toHaveBeenCalled();
  });
  it('the fixed deadline overrides a recoverable marker and cleans materials when the service is already absent', async () => {
    const h = harness(); h.serviceAbsent(); h.deps.now = () => Date.parse(RELEASE_DEADLINE);
    h.setState({stoppedAt: new Date(now - 1000).toISOString(), stopReason: 'monitor-unavailable'});
    await runMonitor(h.deps);
    expect(h.notices.find(n => n.event === 'release-stopped')?.data.reason).toBe('release-deadline');
    expect(h.ledger.snapshot).not.toHaveBeenCalled();
    expect(h.requests.some(r => r.method === 'DELETE' && r.url.includes('/services/'))).toBe(false);
    expect(h.notices.at(-1)).toMatchObject({event: 'release-cleanup', data: {repositoryDeletionAccepted: true, repositoryAbsent: false}});
  });
  it('an explicit operator marker is terminal but repository removal remains the final API operation', async () => {
    const h = harness(); h.setState({stoppedAt: new Date(now - 1000).toISOString(), stopReason: 'operator-stop'});
    h.pendingResource('artifactregistry.'); await runMonitor(h.deps);
    expect(h.requests.at(-1)?.method).toBe('DELETE'); expect(h.requests.at(-1)?.url).toContain('artifactregistry.');
    expect(h.notices.at(-1)).toMatchObject({event: 'release-cleanup', data: {repositoryDeletionAccepted: true, repositoryAbsent: false, repositoryOperation: 'operations/fixture-deletion'}});
    expect(h.ledger.confirmObservation).not.toHaveBeenCalled();
  });
  it('an accepted scheduler DELETE must be confirmed absent before the next scheduler or repository is removed', async () => {
    const h = harness(); h.deps.now = () => Date.parse(RELEASE_DEADLINE); h.pendingResource('/jobs/ugoku-deadline-011');
    await expect(runMonitor(h.deps)).rejects.toThrow('incomplete');
    expect(h.requests.some(r => r.method === 'DELETE' && r.url.endsWith('/ugoku-deadline-011'))).toBe(true);
    expect(h.requests.some(r => r.url.includes('artifactregistry.') || r.url.endsWith('/ugoku-monitor-011'))).toBe(false);
    expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'cleanup.schedule.deadline', category: 'uncertain'}});
    expect(h.notices.some(n => n.event === 'release-cleanup')).toBe(false);
  });
  it('an unconfirmed ledger stop preserves all recovery materials after terminal service removal', async () => {
    const h = harness(); h.deps.now = () => Date.parse(RELEASE_DEADLINE); h.ledger.setStop.mockRejectedValue(new LedgerStoreError('uncertain'));
    await runMonitor(h.deps);
    expect(h.deleted.size).toBe(1);
    expect(h.requests.some(r => /cloudscheduler|artifactregistry|secretmanager|storage/.test(r.url) && r.method === 'DELETE')).toBe(false);
    expect(h.notices.at(-1)?.event).toBe('cleanup-pending');
  });
  it('a single CAS conflict rereads and recomputes against the new generation before confirming freshness', async () => {
    const h = harness(), original = h.stateStore.compareAndSwap.getMockImplementation()!;
    h.stateStore.compareAndSwap.mockImplementationOnce(async () => {
      h.concurrentState({totals: {...h.state().totals, cpuSeconds: 2000}, lastDailyNotice: dailyNoticeKey(now)});
      throw new LedgerStoreError('conflict');
    }).mockImplementation(original);
    await runMonitor(h.deps);
    expect(h.stateStore.compareAndSwap.mock.calls.map(([generation]) => generation)).toEqual(['123', '124']);
    expect(h.stateStore.read).toHaveBeenCalledTimes(2);
    expect(h.state().totals.cpuSeconds).toBe(3600); expect(h.state().startedAt).toBe(new Date(start).toISOString());
    expect(h.notices.some(n => n.event === 'daily-review')).toBe(false);
    expect(h.ledger.confirmObservation).toHaveBeenCalledExactlyOnceWith(now);
    expect(h.ledger.confirmObservation.mock.invocationCallOrder[0]).toBeGreaterThan(h.stateStore.compareAndSwap.mock.invocationCallOrder[1]!);
    expect(h.deleted.size).toBe(0);
  });
  it('a concurrent recoverable stop is preserved rather than overwritten by an observation retry', async () => {
    const h = harness(); h.stateStore.compareAndSwap.mockImplementationOnce(async () => {
      h.concurrentState({stoppedAt: new Date(now).toISOString(), stopReason: 'monitor-unavailable'});
      throw new LedgerStoreError('conflict');
    });
    await runMonitor(h.deps);
    expect(h.stateStore.compareAndSwap).toHaveBeenCalledTimes(1);
    expect(h.ledger.confirmObservation).not.toHaveBeenCalled();
    expect(h.notices.at(-1)?.event).toBe('recovery-materials-retained');
    expect(h.state().stopReason).toBe('monitor-unavailable');
  });
  it('a second CAS conflict stops observation after two writes and retains recovery materials', async () => {
    const h = harness(); h.stateStore.compareAndSwap.mockRejectedValueOnce(new LedgerStoreError('conflict')).mockRejectedValueOnce(new LedgerStoreError('conflict'));
    await runMonitor(h.deps);
    const observations = h.stateStore.compareAndSwap.mock.calls.filter(([, body]) => !(JSON.parse(body) as MonitorState).stopReason);
    expect(observations).toHaveLength(2);
    expect(h.stateStore.read).toHaveBeenCalledTimes(3); // Initial, one conflict readback, then a separate stop-marker read.
    expect(h.ledger.confirmObservation).not.toHaveBeenCalled();
    expect(h.notices.at(-1)?.event).toBe('recovery-materials-retained');
    expect(h.deleted.size).toBe(1);
  });
  it('an uncertain CAS succeeds only through exact committed-body readback at a different generation, without resending', async () => {
    const h = harness(), original = h.stateStore.compareAndSwap.getMockImplementation()!;
    h.stateStore.compareAndSwap.mockImplementationOnce(async (generation, body) => {
      await original(generation, body); throw new LedgerStoreError('uncertain');
    });
    await runMonitor(h.deps);
    expect(h.stateStore.compareAndSwap).toHaveBeenCalledTimes(1); expect(h.stateStore.read).toHaveBeenCalledTimes(2);
    expect(h.ledger.confirmObservation).toHaveBeenCalledExactlyOnceWith(now);
    expect(h.notices.at(-1)?.event).toBe('monitor-check'); expect(h.deleted.size).toBe(0);
  });
  for (const mismatch of ['same-generation', 'different-body'] as const) {
    it(`an uncertain CAS with ${mismatch} readback is not retried or certified fresh`, async () => {
      const h = harness();
      h.stateStore.compareAndSwap.mockImplementationOnce(async (_generation, body) => {
        const updated = JSON.parse(body) as MonitorState;
        if (mismatch === 'same-generation') h.setState(updated);
        else h.concurrentState({...updated, lastDailyNotice: ''});
        throw new LedgerStoreError('uncertain');
      });
      await runMonitor(h.deps);
      const observations = h.stateStore.compareAndSwap.mock.calls.filter(([, body]) => !(JSON.parse(body) as MonitorState).stopReason);
      expect(observations).toHaveLength(1); // A separate best-effort stop marker is permitted.
      expect(h.ledger.confirmObservation).not.toHaveBeenCalled();
      expect(h.notices.at(-1)?.event).toBe('recovery-materials-retained'); expect(h.deleted.size).toBe(1);
    });
  }
  it('a failed freshness confirmation stops the service without certifying the completed metric observation', async () => {
    const h = harness(); h.ledger.confirmObservation.mockRejectedValueOnce(new LedgerStoreError('uncertain'));
    await runMonitor(h.deps);
    expect(h.state().totals.cpuSeconds).toBe(3600);
    expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'observation.ledger-freshness', category: 'uncertain'}});
    expect(h.notices.some(n => n.event === 'monitor-check' || n.event === 'daily-review')).toBe(false);
    expect(h.deleted.size).toBe(1); expect(h.state().stopReason).toBe('monitor-unavailable');
  });

});

describe('monitor Cloud HTTP adapter (in-memory responses, no cloud)', () => {
  it('keeps metadata tokens in headers only, passes abort/redirect restrictions and treats resource404 as absence', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', {status: 404}));
    const signal = new AbortController().signal;
    expect(await cloudApi('DELETE', 'https://run.googleapis.com/owned', signal, async () => 'not-a-real-token', fetcher)).toEqual({absent: true});
    expect(fetcher).toHaveBeenCalledWith('https://run.googleapis.com/owned', {method: 'DELETE', headers: {Authorization: 'Bearer not-a-real-token'}, signal: expect.any(AbortSignal), redirect: 'error'});
    await expect(cloudApi('GET', 'https://monitoring.googleapis.com/missing', signal, async () => 'not-a-real-token', fetcher)).rejects.toThrow('404');
  });
  it('rejects streamed oversized responses and never dispatches after a late token resolves past abort', async () => {
    let cancelled = false;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(2_097_153));}, cancel() {cancelled = true;}})));
    await expect(cloudApi('GET', 'https://monitoring.googleapis.com/fixture', new AbortController().signal, async () => 'fixture', fetcher)).rejects.toThrow('response limit');
    expect(cancelled).toBe(true);
    const controller = new AbortController(), noFetch = vi.fn<typeof fetch>();
    await expect(cloudApi('DELETE', 'https://run.googleapis.com/owned', controller.signal, async () => {controller.abort(); return 'fixture';}, noFetch)).rejects.toThrow();
    expect(noFetch).not.toHaveBeenCalled();
  });
  it('retries transient GET once inside its total budget, while DELETE and denied/invalid reads never retry', async () => {
    vi.useFakeTimers(); const signal = new AbortController().signal;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({}, {status: 503})).mockResolvedValueOnce(Response.json({name: 'recovered'}));
    const task = cloudApi('GET', 'https://run.googleapis.com/owned', signal, async () => 'fixture', fetcher);
    await vi.advanceTimersByTimeAsync(100);
    expect(await task).toEqual({name: 'recovered'}); expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [method, status] of [['DELETE', 503], ['GET', 403], ['GET', 400]] as const) {
      const denied = vi.fn<typeof fetch>(async () => Response.json({}, {status}));
      await expect(cloudApi(method, 'https://run.googleapis.com/owned', signal, async () => 'fixture', denied)).rejects.toThrow(String(status));
      expect(denied).toHaveBeenCalledTimes(1);
    }
    const invalid = vi.fn<typeof fetch>(async () => new Response('not-json'));
    await expect(cloudApi('GET', 'https://run.googleapis.com/owned', signal, async () => 'fixture', invalid)).rejects.toThrow();
    expect(invalid).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not shorten Retry-After into the read budget or loop after two persistent transport failures', async () => {
    vi.useFakeTimers(); const signal = new AbortController().signal;
    const limited = vi.fn<typeof fetch>(async () => Response.json({}, {status: 429, headers: {'Retry-After': '1'}}));
    await expect(cloudApi('GET', 'https://monitoring.googleapis.com/fixture', signal, async () => 'fixture', limited)).rejects.toThrow('429');
    expect(limited).toHaveBeenCalledTimes(1);
    const failed = vi.fn<typeof fetch>(async () => {throw Error('private network details');});
    const task = expect(cloudApi('GET', 'https://monitoring.googleapis.com/fixture', signal, async () => 'fixture', failed)).rejects.toThrow('transport');
    await vi.advanceTimersByTimeAsync(100); await task;
    expect(failed).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a hung GET attempt and prevents retry/dispatch after the enclosing signal aborts', async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const task = expect(cloudApi('GET', 'https://run.googleapis.com/owned', controller.signal, async () => 'fixture', fetcher)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(CLOUD_READ_ATTEMPT_MS);
    controller.abort(); await task;
    expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

});


describe('explicit recovery preflight (in-memory production ledger, no Cloud)', () => {
  async function recoveryHarness() {
    const h = harness(), api = h.deps.api;
    h.deps.api = (method, url, signal) => method === 'GET' && url.includes('/services/')
      ? Promise.resolve({generation: '2', observedGeneration: '2', terminalCondition: {type: 'Ready', state: 'CONDITION_SUCCEEDED'}, latestReadyRevision: 'same-revision', latestCreatedRevision: 'same-revision'})
      : api(method, url, signal);
    let ledgerData = JSON.stringify(initialPublicLedger(start)), ledgerGeneration = 10;
    const writes = vi.fn(async (generation: string, data: string) => {expect(generation).toBe(String(ledgerGeneration)); ledgerData = data; return String(++ledgerGeneration);});
    const actual = new PublicLedger({read: async () => ({generation: String(ledgerGeneration), data: ledgerData}), compareAndSwap: writes}, () => now - 60_000);
    const grant = await actual.reserve({requestId: randomUUID(), fingerprint: publicLedgerHash('fixture request'), bindingHash: publicLedgerHash('fixture base'), phase: 'pre-release'});
    await actual.beforeDispatch(grant, {call: 1, attemptId: randomUUID()});
    await actual.close(grant, {verified: true});
    await actual.setStop({ai: true, whole: true});
    writes.mockClear();
    const setStop = vi.fn(async () => {throw Error('Preflight must not call setStop');});
    h.deps.ledger = () => ({snapshot: () => actual.snapshot(), setStop});
    let raw = JSON.stringify(h.state(), null, 2) + '\n', generation = '123';
    h.stateStore.read.mockImplementation(async () => ({generation, data: raw}));
    h.stateStore.compareAndSwap.mockImplementation(async (before, data) => {expect(before).toBe(generation); expect(data).toBe(raw); generation = '124'; return generation;});
    return {...h, writes, setStop, originalRaw: raw, ledgerData: () => ledgerData, replaceLedger: (data: string) => {ledgerData = data;}, replaceRaw: (data: string) => {raw = data;}};
  }
  it('uses explicit CLI only; unknown or combined flags cannot fall back to normal mode', () => {
    expect(monitorMode([])).toBe('normal'); expect(monitorMode(['--preflight'])).toBe('preflight');
    for (const args of [['--prefligh'], ['--preflight', '--preflight'], ['--preflight', '--delete']]) expect(() => monitorMode(args)).toThrow();
  });
  it('reads actual cumulative ledger, executes shared metrics, and CASes identical monitor bytes without any ledger mutation', async () => {
    const h = await recoveryHarness(), before = h.ledgerData();
    h.cpu(360000); // Even an over-threshold estimate is only reported; this mode makes no stop decision.
    await runMonitorPreflight(h.deps);
    expect(h.stateStore.compareAndSwap).toHaveBeenCalledExactlyOnceWith('123', h.originalRaw);
    expect(h.stateStore.read).toHaveBeenCalledTimes(2);
    expect(h.ledgerData()).toBe(before); expect(h.writes).not.toHaveBeenCalled(); expect(h.setStop).not.toHaveBeenCalled();
    expect(h.requests.every(r => r.method === 'GET')).toBe(true);
    const metrics = h.requests.filter(r => r.url.includes('monitoring.')); expect(metrics).toHaveLength(4);
    for (const r of metrics) {const u = new URL(r.url); expect(u.searchParams.get('interval.startTime')).toBe(h.state().startedAt); expect(u.searchParams.get('aggregation.perSeriesAligner')).toBe('ALIGN_SUM');}
    expect(h.notices.at(-1)).toMatchObject({event: 'monitor-preflight', data: {requests: 1, sends: 1, modelUnknownHeldUsd: .556032, ledgerUnchanged: true, monitorBodyUnchanged: true, startedAt: h.state().startedAt, checkedAt: h.state().checkedAt, stopDecision: false, deletes: 0, ledgerWrites: 0}});
    expect(h.notices.at(-1)?.data.infrastructure).toMatchObject({billingActual: false});
  });
  it('requires the restored service to exist, be Ready and have a fully observed matching revision', async () => {
    for (const value of [{absent: true}, {terminalCondition: {type: 'Ready', state: 'CONDITION_PENDING'}}, {generation: '2', observedGeneration: '1', terminalCondition: {type: 'Ready', state: 'CONDITION_SUCCEEDED'}}]) {
      const h = await recoveryHarness(); h.deps.api = vi.fn(async () => value);
      await expect(runMonitorPreflight(h.deps)).rejects.toThrow();
      expect(h.stateStore.compareAndSwap).not.toHaveBeenCalled(); expect(h.setStop).not.toHaveBeenCalled();
      expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'preflight.service-ready', category: 'invalid-state'}});
    }
  });
  it('rejects a corrupt or already-unlocked ledger without recreating it or spending its previous unknown reservation', async () => {
    for (const change of ['corrupt', 'unlocked']) {
      const h = await recoveryHarness(), state = JSON.parse(h.ledgerData());
      if (change === 'corrupt') state.entries[0].calls[0].state = 'released'; else state.stop.whole = false;
      h.replaceLedger(JSON.stringify(state)); const before = h.ledgerData();
      await expect(runMonitorPreflight(h.deps)).rejects.toThrow();
      expect(h.ledgerData()).toBe(before); expect(h.writes).not.toHaveBeenCalled(); expect(h.setStop).not.toHaveBeenCalled(); expect(h.stateStore.compareAndSwap).not.toHaveBeenCalled();
    }
  });
  it('rejects invalid cumulative state without altering checkedAt/start/stop marker', async () => {
    const h = await recoveryHarness(); h.replaceRaw(JSON.stringify({...h.state(), totals: {...h.state().totals, cpuSeconds: -1}, stoppedAt: new Date(now).toISOString(), stopReason: 'operator-stop'}));
    await expect(runMonitorPreflight(h.deps)).rejects.toThrow();
    expect(h.stateStore.compareAndSwap).not.toHaveBeenCalled(); expect(h.setStop).not.toHaveBeenCalled(); expect(h.requests).toEqual([]);
  });
  it('an actual-shaped Monitoring HTTP error fails safely, with no normal-monitor deletion fallback', async () => {
    const h = await recoveryHarness(), api = h.deps.api;
    h.deps.api = (method, url, signal) => url.includes('monitoring.') ? cloudApi(method, url, signal, async () => 'SECRET_TOKEN', async () => Response.json({error: {message: 'SECRET_BODY'}}, {status: 403})) : api(method, url, signal);
    await expect(runMonitorPreflight(h.deps)).rejects.toThrow('403');
    expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'observation.metrics.cpu', category: 'permission', httpStatus: 403}});
    expect(h.stateStore.compareAndSwap).not.toHaveBeenCalled(); expect(h.setStop).not.toHaveBeenCalled(); expect(h.deleted.size).toBe(0); expect(JSON.stringify(h.notices)).not.toContain('SECRET');
  });
  it('denied or uncertain same-body CAS is not retried and does not report preflight success', async () => {
    for (const kind of ['unavailable', 'uncertain'] as const) {
      const h = await recoveryHarness(); h.stateStore.compareAndSwap.mockRejectedValueOnce(new LedgerStoreError(kind));
      await expect(runMonitorPreflight(h.deps)).rejects.toThrow();
      expect(h.stateStore.compareAndSwap).toHaveBeenCalledTimes(1); expect(h.setStop).not.toHaveBeenCalled(); expect(h.writes).not.toHaveBeenCalled(); expect(h.deleted.size).toBe(0);
      expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'preflight.state-identical-cas', category: kind}});
      expect(h.notices.some(n => n.event === 'monitor-preflight')).toBe(false);
    }
  });
  it('a changed readback cannot claim preservation and a hung read remains bounded at the original ten seconds', async () => {
    const h = await recoveryHarness(); h.stateStore.compareAndSwap.mockImplementation(async () => {h.replaceRaw(h.originalRaw + ' '); return '123';});
    await expect(runMonitorPreflight(h.deps)).rejects.toThrow('conflict');
    expect(h.notices.some(n => n.event === 'monitor-preflight')).toBe(false); expect(h.setStop).not.toHaveBeenCalled();
    vi.useFakeTimers(); const hung = await recoveryHarness(); hung.stateStore.read.mockImplementation(() => new Promise(() => {}));
    const pending = expect(runMonitorPreflight(hung.deps)).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(OBSERVATION_BUDGET_MS); await pending;
    expect(hung.deleted.size).toBe(0); expect(hung.setStop).not.toHaveBeenCalled(); expect(hung.stateStore.compareAndSwap).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudApi, OBSERVATION_BUDGET_MS, runMonitor, STOP_STAGE_BUDGET_MS, type MonitorDependencies } from '../src/operations/monitor-job.js';
import { dailyNoticeKey, RELEASE_DEADLINE, type MonitorState } from '../src/operations/cost-monitor.js';
import { LedgerStoreError, initialPublicLedger, publicLedgerSummary } from '../src/public-ledger.js';

const now = Date.parse('2026-10-06T03:00:00Z'), start = now - 12 * 3600000;
function harness() {
  let state: MonitorState = {schema: 'ugoku-public-monitor-011', startedAt: new Date(start).toISOString(), checkedAt: new Date(start).toISOString(), fixedReserveUsd: 1.5, totals: {cpuSeconds: 0, memoryGiBSeconds: 0, sentBytes: 0, requests: 0}, lastDailyNotice: ''};
  const deleted = new Set<string>(), requests: {method: string; url: string}[] = [], notices: {event: string; data: Record<string, unknown>}[] = [];
  let cpu = 3600, pendingRepository = false, serviceAbsent = false;
  const stateStore = {read: vi.fn(async () => ({generation: '123', data: JSON.stringify(state)})), compareAndSwap: vi.fn(async (generation: string, data: string) => {expect(generation).toBe('123'); state = JSON.parse(data); return '124';})};
  const ledger = {snapshot: vi.fn(async () => ({generation: '55', ...publicLedgerSummary(initialPublicLedger(start), now)})), setStop: vi.fn(async () => {})};
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
      if (pendingRepository && url.includes('artifactregistry.')) return {name: 'still-deleting'};
      return deleted.has(url) || serviceAbsent && url.includes('run.googleapis.com') ? {absent: true} : {name: 'dedicated-resource'};
    }),
  };
  return {deps, stateStore, ledger, requests, notices, deleted, state: () => state, setState: (value: Partial<MonitorState>) => {state = {...state, ...value};}, cpu: (n: number) => {cpu = n;}, pendingRepository: (value: boolean) => {pendingRepository = value;}, serviceAbsent: () => {serviceAbsent = true;}};
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
  it('warns at six without deleting and stops at eight, deleting only owned resources with schedulers last', async () => {
    const h = harness(); h.cpu(260000); await runMonitor(h.deps);
    expect(h.notices.some(item => item.event === 'budget-warning')).toBe(true);
    expect(h.deleted.size).toBe(0);
    h.cpu(360000); await runMonitor(h.deps);
    expect(h.state().stopReason).toBe('infrastructure-reserve');
    expect(h.ledger.setStop).toHaveBeenCalledWith({ai: true, whole: true});
    const deleted = h.requests.filter(request => request.method === 'DELETE').map(request => request.url);
    expect(deleted).toHaveLength(6);
    expect(deleted[0]).toContain('/services/ugoku-kami-release-011');
    expect(deleted.slice(-2).map(url => url.split('/').at(-1))).toEqual(['ugoku-deadline-011', 'ugoku-monitor-011']);
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
    expect(h.deleted.size).toBe(6); // Same fail-closed action; diagnostics do not weaken it.
  });
  it('preserves the failing cleanup target and HTTP status, leaving schedules for retry', async () => {
    const h = harness(), api = h.deps.api; h.deps.now = () => Date.parse(RELEASE_DEADLINE);
    h.deps.api = (method, url, signal) => method === 'DELETE' && url.includes('artifactregistry.')
      ? cloudApi(method, url, signal, async () => 'SECRET_TOKEN', async () => Response.json({error: {message: 'SECRET_CLEANUP'}}, {status: 400}))
      : api(method, url, signal);
    await expect(runMonitor(h.deps)).rejects.toThrow('incomplete');
    expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'cleanup.repository.delete', category: 'http', httpStatus: 400}});
    expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'cleanup.resources', category: 'http', httpStatus: 400}});
    expect(h.requests.some(r => r.url.includes('cloudscheduler.'))).toBe(false);
    expect(JSON.stringify(h.notices)).not.toContain('SECRET');
  });
  it('classifies ledger conflicts and hides unknown exception messages', async () => {
    for (const error of [new LedgerStoreError('conflict'), Error('SECRET_UNKNOWN')]) {
      const h = harness(); h.stateStore.compareAndSwap.mockRejectedValueOnce(error);
      await runMonitor(h.deps);
      expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'observation.state-write', category: error instanceof LedgerStoreError ? 'conflict' : 'unknown'}});
      expect(JSON.stringify(h.notices)).not.toContain('SECRET');
      expect(h.notices.some(n => n.event === 'monitor-check')).toBe(false);
    }
  });
  it('a persisted stop marker resumes cleanup after a recovered ledger; asynchronous deletion keeps both schedules', async () => {
    const h = harness(); h.setState({stoppedAt: new Date(now - 1000).toISOString(), stopReason: 'infrastructure-reserve'}); h.pendingRepository(true);
    await runMonitor(h.deps);
    expect(h.ledger.snapshot).not.toHaveBeenCalled();
    expect(h.requests.some(request => request.url.includes('monitoring.googleapis.com'))).toBe(false);
    expect(h.requests.some(request => request.url.includes('cloudscheduler.googleapis.com'))).toBe(false);
    expect(h.notices.at(-1)?.event).toBe('cleanup-pending');
    h.pendingRepository(false); await runMonitor(h.deps);
    expect(h.notices.at(-1)?.event).toBe('release-cleanup');
  });
  it('external deadline deletion with no persisted marker still resumes cleanup', async () => {
    const h = harness(); h.serviceAbsent(); await runMonitor(h.deps);
    expect(h.notices.find(item => item.event === 'release-stopped')?.data.reason).toBe('service-absent');
    expect(h.ledger.snapshot).not.toHaveBeenCalled();
    expect(h.notices.at(-1)?.event).toBe('release-cleanup');
  });
  it('missing state or a CAS conflict fails closed instead of publishing a successful cost observation', async () => {
    for (const failure of ['read', 'compareAndSwap'] as const) {
      const h = harness(); h.stateStore[failure].mockRejectedValueOnce(Error('private-state-detail'));
      await runMonitor(h.deps);
      expect(h.requests.some(request => request.method === 'DELETE' && request.url.includes('/services/'))).toBe(true);
      expect(h.notices.some(item => item.event === 'monitor-check')).toBe(false);
      expect(JSON.stringify(h.notices)).not.toContain('private-state-detail');
    }
  });
  it('a hung observation and hung stop write cannot consume the Job before service deletion', async () => {
    vi.useFakeTimers(); const h = harness(); let readSignal: AbortSignal | undefined;
    h.deps.stateStore = signal => {readSignal = signal; return h.stateStore;};
    h.stateStore.read.mockImplementation(() => new Promise(() => {}));
    h.ledger.setStop.mockImplementation(() => new Promise(() => {}));
    const task = runMonitor(h.deps);
    await vi.advanceTimersByTimeAsync(OBSERVATION_BUDGET_MS);
    expect(readSignal?.aborted).toBe(true);
    expect(h.notices).toContainEqual({event: 'monitor-diagnostic', data: {stage: 'observation', category: 'timeout'}});
    expect(h.requests[0]).toMatchObject({method: 'GET'});
    expect(h.requests[0]!.url).toContain('/services/ugoku-kami-release-011');
    expect(h.requests.find(request => request.method === 'DELETE')?.url).toContain('/services/ugoku-kami-release-011');
    await vi.advanceTimersByTimeAsync(STOP_STAGE_BUDGET_MS); await task;
    expect(h.notices.some(item => item.event === 'ledger-stop-unconfirmed')).toBe(true);
    expect(h.notices.at(-1)?.event).toBe('cleanup-pending');
    expect(h.requests.some(request => request.url.includes('cloudscheduler.googleapis.com'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('deadline bypasses unavailable metrics, and a failed cleanup never deletes the last monitor scheduler', async () => {
    const h = harness(); h.deps.now = () => Date.parse(RELEASE_DEADLINE);
    const api = h.deps.api;
    h.deps.api = async (method, url, signal) => {if (url.endsWith('/ugoku-deadline-011')) throw Error('denied'); return api(method, url, signal);};
    await expect(runMonitor(h.deps)).rejects.toThrow('incomplete');
    expect(h.stateStore.read).not.toHaveBeenCalled();
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
});

describe('monitor Cloud HTTP adapter (in-memory responses, no cloud)', () => {
  it('keeps metadata tokens in headers only, passes abort/redirect restrictions and treats resource404 as absence', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', {status: 404}));
    const signal = new AbortController().signal;
    expect(await cloudApi('DELETE', 'https://run.googleapis.com/owned', signal, async () => 'not-a-real-token', fetcher)).toEqual({absent: true});
    expect(fetcher).toHaveBeenCalledWith('https://run.googleapis.com/owned', {method: 'DELETE', headers: {Authorization: 'Bearer not-a-real-token'}, signal, redirect: 'error'});
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
});

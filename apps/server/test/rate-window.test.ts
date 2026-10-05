import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesign, SAMPLE_INPUT } from '@ugoku/core';
import { createApp, type App } from '../src/app.js';
import { readConfig, type ServerConfig } from '../src/config.js';
import { AppError, publicError } from '../src/errors.js';
import type { ProviderResponse } from '../src/provider.js';

const secret = 'rate-window-test-access-secret-at-least-32';
const epoch = Date.parse('2026-10-05T00:00:00.000Z');
const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });

async function fixture(limits: Partial<ServerConfig>) {
  const provider = { generate: vi.fn(() => new Promise<ProviderResponse>(() => {})) };
  const app = await createApp({ config: { ...readConfig({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-only', AI_ACCESS_SECRET: secret }), ...limits }, provider });
  apps.push(app);
  const document = createDesign(SAMPLE_INPUT);
  function session() {
    const saved = app.sessions.create(document);
    return { url: `/api/sessions/${saved.sessionId}/runs`, headers: { authorization: `Bearer ${saved.token}`, 'x-ai-access': secret }, current: app.sessions.authorize(saved.sessionId, `Bearer ${saved.token}`) };
  }
  const client = session();
  const start = (requestId: string, target = client) => app.inject({ method: 'POST', url: target.url, headers: target.headers, payload: { requestId, prompt: '距離を15mmにしてください。', baseRevision: document.revision, baseHash: document.designHash } });
  const cancel = async (id: string) => { const run = app.runs.get(client.current, id); app.runs.cancel(run); await run.done; };
  return { app, provider, client, session, start, cancel };
}

describe('server-derived accepted-start rate windows', () => {
  it('counts cancelled starts, rounds the header upward, and reopens exactly at the minute boundary', async () => {
    let now = epoch; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = await fixture({ runsPerMinute: 2 });
    const first = await f.start('minute-request-1'); expect(first.statusCode).toBe(202);
    now += 15_000; await f.cancel(first.json().run.id);
    now = epoch + 20_000;
    const second = await f.start('minute-request-2'); expect(second.statusCode).toBe(202);
    now += 5_000; await f.cancel(second.json().run.id);
    now = epoch + 35_123;
    const rejected = await f.start('minute-request-3');
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json().error).toMatchObject({ code: 'instance_limit', retryAfterMs: 24_877, retryAt: '2026-10-05T00:01:00.000Z' });
    expect(rejected.headers['retry-after']).toBe('25');
    expect(f.provider.generate).toHaveBeenCalledTimes(2); expect(f.client.current.runs.size).toBe(2);
    now = epoch + 59_999;
    const lastMillisecond = await f.start('minute-request-3');
    expect(lastMillisecond.json().error.retryAfterMs).toBe(1); expect(lastMillisecond.headers['retry-after']).toBe('1');
    now = epoch + 60_000;
    const reopened = await f.start('minute-request-3'); expect(reopened.statusCode).toBe(202);
    expect(reopened.headers['retry-after']).toBeUndefined(); await f.cancel(reopened.json().run.id);
    expect(f.provider.generate).toHaveBeenCalledTimes(3);
  });

  it('uses the later hour release when both windows block, without consuming a rejected start', async () => {
    let now = epoch; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = await fixture({ runsPerMinute: 1, runsPerHour: 1 });
    const first = await f.start('hour-request-1'); await f.cancel(first.json().run.id);
    now += 1_234;
    const rejected = await f.start('hour-request-2');
    expect(rejected.json().error).toMatchObject({ retryAfterMs: 3_598_766, retryAt: '2026-10-05T01:00:00.000Z' });
    expect(rejected.headers['retry-after']).toBe('3599');
    now = epoch + 3_600_000;
    const reopened = await f.start('hour-request-2'); expect(reopened.statusCode).toBe(202); await f.cancel(reopened.json().run.id);
    expect(f.provider.generate).toHaveBeenCalledTimes(2);
  });

  it('omits retry metadata when active concurrency has an unknown release, even with a full starts window', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    const f = await fixture({ maxConcurrentRuns: 1, runsPerMinute: 1 });
    const first = await f.start('active-request-1');
    const rejected = await f.start('active-request-2', f.session());
    expect(rejected.statusCode).toBe(429);
    expect(Object.keys(rejected.json().error).sort()).toEqual(['code', 'message']);
    expect(rejected.headers['retry-after']).toBeUndefined(); expect(f.provider.generate).toHaveBeenCalledTimes(1);
    await f.cancel(first.json().run.id);
  });

  it('does not expose arbitrary provider or invalid retry metadata', () => {
    expect(publicError(Object.assign(new Error('private'), { status: 429, retryAfterMs: 10, retryAt: new Date(epoch).toISOString() }))).toEqual({ code: 'provider_rate_limit', message: 'Geminiの利用上限に達しました。時間をおいて再試行してください。' });
    for (const window of [{ retryAfterMs: NaN, retryAt: new Date(epoch).toISOString() }, { retryAfterMs: 1, retryAt: 'private' }]) {
      expect(publicError(new AppError('instance_limit', 'wait', 429, window))).toEqual({ code: 'instance_limit', message: 'wait' });
    }
  });
});

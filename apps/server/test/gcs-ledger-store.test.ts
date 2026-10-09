import { describe, expect, it, vi } from 'vitest';
import { GcsLedgerStore, GCS_READ_BUDGET, createMetadataAccessToken } from '../src/gcs-ledger-store.js';
import { initialPublicLedger, LedgerStoreError, PublicLedger, publicLedgerHash, PUBLIC_LEDGER_LIMITS } from '../src/public-ledger.js';

const start = Date.parse('2026-10-05T00:00:00Z');
function fakeGcs() {
  let data = JSON.stringify(initialPublicLedger(start)), generation = 1;
  const calls: { url: URL; init: RequestInit }[] = [];
  let loseNextWriteResponse = false, denyWrites = false, missing = false;
  const fetcher = (async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    expect(url.origin).toBe('https://storage.googleapis.com');
    expect(init.redirect).toBe('error'); expect(new Headers(init.headers).get('authorization')).toBe('Bearer server-token');
    if (init.method === 'POST') {
      if (denyWrites) return new Response('private error details must not escape', { status: 403 });
      if (url.searchParams.get('ifGenerationMatch') !== String(generation)) return new Response('', { status: 412 });
      data = String(init.body); generation++;
      if (loseNextWriteResponse) { loseNextWriteResponse = false; throw new Error('network lost after commit'); }
      return Response.json({ generation: String(generation) });
    }
    if (missing) return new Response('', { status: 404 });
    if (url.searchParams.get('alt') === 'media') {
      if (url.searchParams.get('ifGenerationMatch') !== String(generation)) return new Response('', { status: 412 });
      return new Response(data);
    }
    return Response.json({ generation: String(generation), size: String(Buffer.byteLength(data)) });
  }) as typeof fetch;
  const adapter = () => new GcsLedgerStore({ bucket: 'private-ledger', object: 'public/ledger.json', fetch: fetcher, accessToken: async () => 'server-token' });
  return { adapter, calls, loseWrite: () => { loseNextWriteResponse = true; }, deny: () => { denyWrites = true; }, remove: () => { missing = true; } };
}
const req = (id: string) => ({ requestId: id, fingerprint: publicLedgerHash(id), bindingHash: publicLedgerHash(`binding:${id}`), phase: 'pre-release' as const });
describe('GCS generation adapter with fake HTTP only', () => {
  it('binds content to metadata generation and writes with matching generation and encoded object name', async () => {
    const fake = fakeGcs(), store = fake.adapter(), value = await store.read();
    expect(value.generation).toBe('1');
    expect(await store.compareAndSwap(value.generation, value.data)).toBe('2');
    expect(fake.calls[0].url.pathname).toContain('public%2Fledger.json');
    expect(fake.calls[1].url.searchParams.get('ifGenerationMatch')).toBe('1');
    expect(fake.calls[2].url.searchParams.get('name')).toBe('public/ledger.json');
    expect(fake.calls[2].url.searchParams.get('ifGenerationMatch')).toBe('1');
    await expect(store.compareAndSwap('1', value.data)).rejects.toMatchObject({ kind: 'conflict' });
  });
  it('two ledger instances share one authority; a response lost after durable dispatch cannot resend', async () => {
    const fake = fakeGcs(), one = new PublicLedger(fake.adapter(), () => start), two = new PublicLedger(fake.adapter(), () => start);
    const grant = await one.reserve(req('one'));
    await expect(two.reserve(req('two'))).rejects.toMatchObject({ code: 'instance_limit' });
    fake.loseWrite(); await one.beforeDispatch(grant, { call: 1, attemptId: 'attempt' });
    await expect(one.beforeDispatch(grant, { call: 1, attemptId: 'attempt' })).rejects.toMatchObject({ code: 'stale_public_grant' });
    await one.close(grant, { verified: true });
    expect(await two.snapshot()).toMatchObject({ requests: 1, sends: 1, sentUnknownNano: 556032000 });
  });
  it('403 writes and 404 reads do not initialize or expose server response details', async () => {
    const fake = fakeGcs(), ledger = new PublicLedger(fake.adapter(), () => start);
    fake.deny(); await expect(ledger.reserve(req('one'))).rejects.toMatchObject({ code: 'ledger_unavailable' });
    expect(fake.calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
    fake.remove(); await expect(ledger.reserve(req('two'))).rejects.toMatchObject({ code: 'ledger_unavailable' });
    expect(fake.calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
    expect(fake.calls.every(call => call.url.searchParams.get('ifGenerationMatch') !== '0')).toBe(true);
  });
  it('oversize metadata and streamed content are bounded before parsing', async () => {
    const make = (fetcher: typeof fetch) => new GcsLedgerStore({ bucket: 'test-bucket', object: 'ledger', fetch: fetcher, accessToken: async () => 'token' });
    await expect(make((async () => Response.json({ generation: '1', size: String(PUBLIC_LEDGER_LIMITS.maxBytes + 1) })) as typeof fetch).read()).rejects.toMatchObject({ kind: 'unavailable' });
    let calls = 0;
    const store = make((async () => ++calls === 1 ? Response.json({ generation: '1', size: '1' }) : new Response('x'.repeat(PUBLIC_LEDGER_LIMITS.maxBytes + 1))) as typeof fetch);
    await expect(store.read()).rejects.toMatchObject({ kind: 'unavailable' });
  });
  it('stale metadata re-reads a bounded number of times, never accepts a different object version', async () => {
    let calls = 0;
    const store = new GcsLedgerStore({ bucket: 'test-bucket', object: 'ledger', accessToken: async () => 'token', fetch: (async () => ++calls % 2 ? Response.json({ generation: '1', size: '1' }) : new Response('', { status: 412 })) as typeof fetch });
    await expect(store.read()).rejects.toMatchObject({ kind: 'unavailable', details: { stage: 'media-http', category: 'conflict', httpStatus: 412 } }); expect(calls).toBe(4);
  });
  it('metadata ADC token is memory-only, endpoint-fixed, cached and never falls back to an API key', async () => {
    let now = start, calls = 0;
    const token = createMetadataAccessToken((async (input, init) => {
      expect(String(input)).toBe('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
      expect(new Headers(init?.headers).get('metadata-flavor')).toBe('Google'); expect(init?.redirect).toBe('error'); calls++;
      return Response.json({ access_token: 'memory-token', token_type: 'Bearer', expires_in: 120 }, { headers: { 'Metadata-Flavor': 'Google' } });
    }) as typeof fetch, () => now);
    expect(await token()).toBe('memory-token'); expect(await token()).toBe('memory-token'); expect(calls).toBe(1);
    now += 61000; await token(); expect(calls).toBe(2);
    const rejected = createMetadataAccessToken((async () => Response.json({ access_token: 'unexpected', token_type: 'Bearer', expires_in: 120 })) as typeof fetch);
    await expect(rejected()).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('bounded read recovery and safe storage diagnostics', () => {
  const make = (fetcher: typeof fetch, signal?: AbortSignal, accessToken = async (_signal?: AbortSignal) => 'token') => new GcsLedgerStore({ bucket: 'test-bucket', object: 'ledger', fetch: fetcher, accessToken, signal });
  const meta = (generation = '1') => Response.json({ generation, size: '1' });
  const secret = 'private-token-and-error-body';

  it('retries transient GET failures once, retaining stage/status after exhaustion; never retries denial or missing data', async () => {
    for (const [status, category, expectedCalls] of [[401, 'permission', 1], [403, 'permission', 1], [404, 'missing', 1], [400, 'http', 1], [408, 'http', 2], [429, 'http', 2], [503, 'http', 2]] as const) {
      let calls = 0;
      const result = await make((async () => { calls++; return new Response(secret, { status }); }) as typeof fetch).read().catch(error => error as LedgerStoreError);
      expect(result).toMatchObject({ kind: status === 404 ? 'missing' : 'unavailable', details: { stage: 'metadata-http', category, httpStatus: status } });
      expect(calls).toBe(expectedCalls); expect(JSON.stringify(result)).not.toContain(secret); expect(String(result)).not.toContain(secret);
    }
    const unexpected = new LedgerStoreError('unavailable', { stage: secret, category: 'http', httpStatus: 503 } as never);
    expect(unexpected.details).toBeUndefined(); expect(JSON.stringify(unexpected)).not.toContain(secret);
  });

  it('re-reads metadata after a transient media failure and only accepts its newly bound generation', async () => {
    const urls: URL[] = [];
    const store = make((async input => {
      urls.push(new URL(String(input)));
      return [() => meta('11'), () => new Response(secret, { status: 503 }), () => meta('12'), () => new Response('x')][urls.length - 1]();
    }) as typeof fetch);
    expect(await store.read()).toEqual({ generation: '12', data: 'x' });
    expect(urls.map(url => url.searchParams.get('ifGenerationMatch'))).toEqual([null, '11', null, '12']);
  });

  it('separates invalid metadata, excess size, body transport and content mismatch without retrying invalid data', async () => {
    for (const [response, stage, category] of [
      [() => new Response('{private-invalid-json'), 'metadata-validation', 'invalid'],
      [() => Response.json({ generation: 'bad', size: '1' }), 'metadata-validation', 'invalid'],
      [() => Response.json({ generation: '1', size: String(PUBLIC_LEDGER_LIMITS.maxBytes + 1) }), 'metadata-validation', 'size'],
      [() => new Response('x', { headers: { 'Content-Length': '20000' } }), 'metadata-body', 'size'],
    ] as const) {
      let calls = 0;
      await expect(make((async () => { calls++; return response(); }) as typeof fetch).read()).rejects.toMatchObject({ details: { stage, category } });
      expect(calls).toBe(1);
    }
    let calls = 0;
    await expect(make((async () => ++calls % 2 ? meta() : new Response('xx')) as typeof fetch).read()).rejects.toMatchObject({ details: { stage: 'media-validation', category: 'invalid' } });
    expect(calls).toBe(2);
    calls = 0;
    await expect(make((async () => { calls++; return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError(secret)); } })); }) as typeof fetch).read()).rejects.toMatchObject({ details: { stage: 'metadata-body', category: 'transport' } });
    expect(calls).toBe(2);
    calls = 0;
    await expect(make((async () => { calls++; throw new TypeError(secret); }) as typeof fetch).read()).rejects.toMatchObject({ details: { stage: 'metadata-http', category: 'transport' } });
    expect(calls).toBe(2);
  });

  it('classifies metadata authentication separately and never sends GCS requests after denial or invalid credentials', async () => {
    for (const status of [403, 503]) {
      let tokenCalls = 0, storageCalls = 0;
      const token = createMetadataAccessToken((async () => { tokenCalls++; return new Response(secret, { status }); }) as typeof fetch);
      await expect(make((async () => { storageCalls++; return meta(); }) as typeof fetch, undefined, token).read()).rejects.toMatchObject({ details: { stage: 'token-http', category: status === 403 ? 'permission' : 'http', httpStatus: status } });
      expect(tokenCalls).toBe(status === 403 ? 1 : 2); expect(storageCalls).toBe(0);
    }
    let tokenCalls = 0;
    const token = createMetadataAccessToken((async () => { tokenCalls++; return Response.json({ access_token: secret, expires_in: 0 }, { headers: { 'Metadata-Flavor': 'Google' } }); }) as typeof fetch);
    await expect(make(vi.fn() as typeof fetch, undefined, token).read()).rejects.toMatchObject({ details: { stage: 'token-validation', category: 'invalid' } });
    expect(tokenCalls).toBe(1);
  });

  it('bounds hanging response bodies to 1.5s per GET and at most two attempts, cancelling each body', async () => {
    vi.useFakeTimers();
    try {
      expect(GCS_READ_BUDGET).toEqual({ totalMs: 4000, requestMs: 1500, attempts: 2 });
      let calls = 0, cancelled = 0;
      const result = make((async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled++; } })); }) as typeof fetch).read().catch(error => error);
      await vi.advanceTimersByTimeAsync(1499); expect(calls).toBe(1); expect(cancelled).toBe(0);
      await vi.advanceTimersByTimeAsync(1); expect(calls).toBe(1); expect(cancelled).toBe(1);
      await vi.advanceTimersByTimeAsync(100); expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await result).toMatchObject({ details: { stage: 'metadata-body', category: 'timeout' } });
      expect(calls).toBe(2); expect(cancelled).toBe(2); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('enforces the 4s whole-read deadline across token, metadata, media and retry, including uncooperative fetch', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetcher = (async (_input, init) => {
        signals.push(init?.signal as AbortSignal);
        if (signals.length === 3) return new Promise<Response>(() => {});
        await new Promise(resolve => setTimeout(resolve, 1400));
        return signals.length === 1 ? meta() : new Response('', { status: 503 });
      }) as typeof fetch;
      const result = make(fetcher).read().catch(error => error);
      await vi.advanceTimersByTimeAsync(3999); expect(signals).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ details: { stage: 'read-budget', category: 'timeout' } });
      expect(signals.every(signal => signal.aborted)).toBe(true); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('honours parent abort before authentication and during stalled authentication, with no late GET or retry', async () => {
    const parent = new AbortController(); parent.abort(new Error(secret));
    const token = vi.fn(async () => 'token'), fetcher = vi.fn() as typeof fetch;
    await expect(make(fetcher, parent.signal, token).read()).rejects.toMatchObject({ details: { category: 'timeout' } });
    expect(token).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    const during = new AbortController(); let finishToken!: (value: string) => void;
    const waitingToken = vi.fn(() => new Promise<string>(resolve => { finishToken = resolve; }));
    const result = make(fetcher, during.signal, waitingToken).read().catch(error => error);
    during.abort(new Error(secret));
    expect(await result).toMatchObject({ details: { category: 'timeout' } });
    finishToken('late-token'); await Promise.resolve(); await Promise.resolve();
    expect(waitingToken).toHaveBeenCalledTimes(1); expect(fetcher).not.toHaveBeenCalled();
  });

  it('never replays an ambiguous CAS, including 5s timeout or a malformed successful response', async () => {
    for (const response of [() => new Response(secret, { status: 503 }), () => new Response('{private-invalid-json')]) {
      const fetcher = vi.fn(async () => response()) as typeof fetch;
      await expect(make(fetcher).compareAndSwap('1', '{}')).rejects.toMatchObject({ kind: 'uncertain' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(() => new Promise<Response>(() => {})) as typeof fetch;
      const result = make(fetcher).compareAndSwap('1', '{}').catch(error => error);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toMatchObject({ kind: 'uncertain', details: { stage: 'write-http', category: 'timeout' } });
      expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('honours Retry-After without logging its text, and aborts the retry wait without a second GET', async () => {
    for (const header of ['1', '999999999999999999999999999999999999999', secret, new Date(Date.now() + 60_000).toUTCString()]) {
      let calls = 0;
      const result = await make((async () => { calls++; return new Response(secret, { status: 503, headers: { 'Retry-After': header } }); }) as typeof fetch).read().catch(error => error);
      expect(calls).toBe(1); expect(result).toMatchObject({ details: { stage: 'metadata-http', category: 'http', httpStatus: 503 } });
      expect(JSON.stringify(result)).not.toContain(header);
    }
    vi.useFakeTimers();
    try {
      const parent = new AbortController(); let calls = 0;
      const result = make((async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '0' } }); }) as typeof fetch, parent.signal).read().catch(error => error);
      await vi.advanceTimersByTimeAsync(99); expect(calls).toBe(1);
      parent.abort(); expect(await result).toMatchObject({ details: { category: 'timeout' } });
      await vi.advanceTimersByTimeAsync(200); expect(calls).toBe(1); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

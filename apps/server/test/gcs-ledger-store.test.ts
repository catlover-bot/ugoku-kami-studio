import { describe, expect, it } from 'vitest';
import { GcsLedgerStore, createMetadataAccessToken } from '../src/gcs-ledger-store.js';
import { initialPublicLedger, PublicLedger, publicLedgerHash, PUBLIC_LEDGER_LIMITS } from '../src/public-ledger.js';

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
    await expect(store.read()).rejects.toMatchObject({ kind: 'unavailable' }); expect(calls).toBe(8);
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

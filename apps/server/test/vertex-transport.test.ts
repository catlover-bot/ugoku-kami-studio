import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleAuth } from 'google-auth-library';
import { createDesign, SAMPLE_INPUT } from '@ugoku/core';
import { readConfig } from '../src/config.js';
import { VertexProvider, type ConversationMessage } from '../src/provider.js';
import { createApp, type App } from '../src/app.js';
import { publicRun } from '../src/runs.js';

// Actual installed @google/genai transport, but OAuth and all HTTP are intercepted.
// These are NOT real Vertex calls, credential checks or model-success evidence.
const access = 'synthetic-offline-vertex-access-secret-32';
const config = () => readConfig({ AI_PROVIDER: 'vertex', VERTEX_PROJECT: 'offline-project', VERTEX_LOCATION: 'global', VERTEX_MODEL: 'gemini-3.8-flash', AI_ACCESS_SECRET: access, AI_MAX_OUTPUT_TOKENS: '512' });
const signed = { role: 'model', parts: [{ text: 'private reasoning', thought: true, thoughtSignature: 'opaque-thought' }, { functionCall: { name: 'inspect_design', args: {}, id: 'call-local' }, thoughtSignature: 'opaque-call' }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apps: App[] = [];
beforeEach(() => { vi.spyOn(GoogleAuth.prototype, 'getRequestHeaders').mockResolvedValue(new Headers({ authorization: 'Bearer synthetic-offline-oauth', 'x-goog-user-project': 'unrelated-ambient-quota' })); });
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function session() {
  const app = await createApp({ config: config() }); apps.push(app);
  const document = createDesign(SAMPLE_INPUT);
  const created = (await app.inject({ method: 'POST', url: '/api/sessions', payload: { document } })).json();
  const headers = { authorization: `Bearer ${created.token}`, 'x-ai-access': access };
  const current = app.sessions.authorize(created.sessionId, headers.authorization);
  const body = { requestId: 'vertex-request-001', prompt: '距離を15mmにしてください。', baseRevision: document.revision, baseHash: document.designHash };
  return { app, document, current, headers, body, url: `/api/sessions/${created.sessionId}` };
}

describe('Vertex v1 installed-SDK wire contract (offline intercepts only)', () => {
  it('pins ADC/global/v1 without API keys or ambient endpoint/project overrides; keeps original signed parts and call IDs', async () => {
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'false'); vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'false');
    vi.stubEnv('GOOGLE_API_KEY', 'ambient-key-never-used'); vi.stubEnv('GEMINI_API_KEY', 'stored-key-never-used');
    vi.stubEnv('GOOGLE_VERTEX_BASE_URL', 'https://not-used.invalid');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'another-project'); vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    const fetch = vi.fn(async () => json({ candidates: [{ content: signed, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 13 }, modelVersion: 'gemini-3.8-flash' })); vi.stubGlobal('fetch', fetch);
    const provider = new VertexProvider(config());
    expect(GoogleAuth.prototype.getRequestHeaders).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    const first: ConversationMessage[] = [{ role: 'user', text: 'inspect' }];
    const result = await provider.generate(first, new AbortController().signal);
    expect(JSON.stringify(result)).not.toMatch(/private reasoning|opaque-thought|opaque-call|oauth/);
    expect(result.usageMetadata).toMatchObject({ thoughtsTokenCount: 3 });
    const continued: ConversationMessage[] = [...first, result.message, { role: 'tool', results: [{ name: 'inspect_design', id: 'call-local', response: { checked: true } }] }];
    await provider.generate(continued, new AbortController().signal);
    const [url, options] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://aiplatform.googleapis.com/v1/projects/offline-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent');
    const headers = new Headers(options.headers);
    expect(headers.get('authorization')).toBe('Bearer synthetic-offline-oauth');
    expect(headers.get('x-goog-api-key')).toBeNull(); expect(headers.get('x-goog-user-project')).toBe('offline-project');
    const wire = JSON.parse(String(options.body));
    expect(wire.contents).toEqual([{ role: 'user', parts: [{ text: 'inspect' }] }, signed, { role: 'user', parts: [{ functionResponse: { name: 'inspect_design', id: 'call-local', response: { checked: true } } }] }]);
    expect(wire.generationConfig).toEqual({ maxOutputTokens: 512, thinkingConfig: { thinkingLevel: 'LOW' } });
    expect(wire.tools).toHaveLength(1); expect(wire.tools[0].functionDeclarations).toHaveLength(6);
    expect(wire.tools[0].functionDeclarations.find((tool: { name: string }) => tool.name === 'propose_request_interpretation').parametersJsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
    await expect(provider.generate(structuredClone(continued), new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_history' });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(provider.generate(first, cancelled.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('retains complete signed history in the input limit and never truncates it to dispatch', async () => {
    const configured = { ...config(), maxInputBytes: 16_384 };
    const fetch = vi.fn(async () => json({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'inspect_design', args: {}, id: 'call-long' }, thoughtSignature: 's'.repeat(16_384) }] }, finishReason: 'STOP' }] })); vi.stubGlobal('fetch', fetch);
    const provider = new VertexProvider(configured), first: ConversationMessage[] = [{ role: 'user', text: 'inspect' }];
    const result = await provider.generate(first, new AbortController().signal);
    await expect(provider.generate([...first, result.message], new AbortController().signal)).rejects.toMatchObject({ code: 'input_limit' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('fails on ADC resolution without falling back to a key and exposes only a safe error', async () => {
    vi.mocked(GoogleAuth.prototype.getRequestHeaders).mockRejectedValue(new Error('synthetic-private-credential-detail'));
    const fetch = vi.fn(async () => { throw new Error('no-network'); }); vi.stubGlobal('fetch', fetch);
    const s = await session();
    const run = s.app.runs.start(s.current, s.body); await run.done;
    expect(run.status).toBe('failed'); expect(run.error?.code).toBe('provider_error');
    expect(run.modelCalls).toBe(1); expect(run.modelUsage[0]!.received).toBe(false);
    expect(fetch).not.toHaveBeenCalled(); expect(s.current.document).toEqual(s.document);
    expect(JSON.stringify(publicRun(run))).not.toMatch(/synthetic-private|offline-project|oauth|Bearer/);
  });
  it.each([[403, 'provider_auth'], [429, 'provider_rate_limit'], [500, 'provider_error']] as const)('does not retry/fallback on HTTP %s', async (status, code) => {
    const fetch = vi.fn(async () => json({ error: { code: status, message: 'synthetic-sensitive-upstream-detail' } }, status)); vi.stubGlobal('fetch', fetch);
    const s = await session(); const run = s.app.runs.start(s.current, s.body); await run.done;
    expect(run.status).toBe('failed'); expect(run.error?.code).toBe(code); expect(fetch).toHaveBeenCalledTimes(1);
    expect(s.current.document).toEqual(s.document); expect(JSON.stringify(publicRun(run))).not.toContain('synthetic-sensitive');
  });
  it('rejects a truncated response before executing an apparently valid tool call', async () => {
    const fetch = vi.fn(async () => json({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'propose_design_patch', id: 'truncated-call', args: { travelMm: 15 } } }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 492, totalTokenCount: 612 } })); vi.stubGlobal('fetch', fetch);
    const s = await session(), run = s.app.runs.start(s.current, s.body); await run.done;
    expect(run).toMatchObject({ status: 'failed', error: { code: 'invalid_output' }, toolCalls: 0, modelCalls: 1 });
    expect(run.usage.responsesWithUsage).toBe(0); expect(run.modelUsage[0]?.usage).toBeNull();
    expect(run.modelUsage[0]?.usageDiagnostics?.observed.thoughtsTokenCount).toBe(492);
    expect(run.modelUsage[0]?.modelCost?.kind).toBe('usage-estimate');
    expect(run.modelUsage[0]?.finishReason).toBe('MAX_TOKENS');
    expect(run.proposal).toBeUndefined(); expect(s.current.document).toEqual(s.document); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('cancels via bodyless DELETE and ignores a late SDK result without another dispatch or adoption', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn((_url: unknown, _options?: RequestInit) => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetch);
    const s = await session(), run = s.app.runs.start(s.current, s.body);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const options = fetch.mock.calls[0]![1]!;
    const stopped = await s.app.inject({ method: 'DELETE', url: `${s.url}/runs/${run.id}`, headers: s.headers });
    expect(stopped.statusCode).toBe(200); expect(stopped.json().run.status).toBe('cancelled');
    await run.done; expect(options.signal?.aborted).toBe(true);
    finish(json({ candidates: [{ content: { role: 'model', parts: [{ text: '遅れて届いた候補' }, { functionCall: { name: 'propose_design_patch', id: 'late-call', args: { travelMm: 15 } } }] }, finishReason: 'STOP' }] }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(run.status).toBe('cancelled'); expect(run.toolCalls).toBe(0); expect(run.proposal).toBeUndefined();
    expect(s.current.document).toEqual(s.document); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('runs the actual deterministic tool through the Vertex transport, keeps the original until bound approval and does not expose credentials', async () => {
    const fetch = vi.fn(async () => json({ candidates: [{ content: { role: 'model', parts: [{ text: '移動距離を15mmにする候補です。実物は未検証です。' }, { functionCall: { name: 'propose_design_patch', id: 'patch-vertex', args: { travelMm: 15 } }, thoughtSignature: 'private-patch-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 99, candidatesTokenCount: 12, thoughtsTokenCount: 8, totalTokenCount: 119 } })); vi.stubGlobal('fetch', fetch);
    const s = await session();
    const status = await s.app.inject('/api/status');
    expect(status.json().ai).toMatchObject({ mode: 'vertex', provider: 'vertex', connectionStatus: 'not-tested' });
    expect(status.body).not.toContain('offline-project'); expect(fetch).not.toHaveBeenCalled();
    expect((await s.app.inject({ method: 'POST', url: `${s.url}/runs`, headers: { authorization: s.headers.authorization }, payload: s.body })).statusCode).toBe(401);
    const started = await s.app.inject({ method: 'POST', url: `${s.url}/runs`, headers: s.headers, payload: s.body }); expect(started.statusCode).toBe(202);
    const run = s.current.runs.get(started.json().run.id)!; await run.done;
    expect(run).toMatchObject({ provider: 'vertex', mode: 'vertex', status: 'awaiting_approval', modelCalls: 1, toolCalls: 1 });
    expect(run.proposal?.document.input.travelMm).toBe(15); expect(s.current.document).toEqual(s.document);
    expect(run.events.some(event => event.type === 'validation')).toBe(true);
    const approval = { requestId: run.requestId, baseRevision: run.baseRevision, baseHash: run.baseHash };
    const url = `${s.url}/proposals/${run.proposal!.id}/approve`;
    expect((await s.app.inject({ method: 'POST', url, headers: s.headers, payload: { ...approval, baseRevision: run.baseRevision + 1 } })).statusCode).toBe(409);
    expect((await s.app.inject({ method: 'POST', url, headers: s.headers, payload: approval })).statusCode).toBe(200);
    expect(s.current.document.input.travelMm).toBe(15); expect(s.current.document.revision).toBe(s.document.revision + 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(publicRun(run))).not.toMatch(/private-patch-signature|offline-project|synthetic-offline-oauth/);
  });
});

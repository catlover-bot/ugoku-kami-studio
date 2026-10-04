import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDesign, SAMPLE_INPUT } from '@ugoku/core';
import { readConfig, type ServerConfig } from '../src/config.js';
import { checkLocalRuntime, OllamaProvider } from '../src/ollama.js';
import { GeminiProvider } from '../src/provider.js';
import { createApp } from '../src/app.js';
import { publicRun } from '../src/runs.js';
import type { ConversationMessage } from '../src/conversation.js';

const model = 'gemma4:e2b-it-qat', digest = 'a'.repeat(64), access = 'test-local-access-code-at-least-32-characters';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); vi.unstubAllGlobals(); });
type Wire = { path: string; body: Record<string, unknown> | undefined; headers: IncomingMessage['headers'] };
type Reply = (call: Wire, response: ServerResponse) => unknown;
async function fixture(reply?: Reply) {
  const requests: Wire[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const call = { path: request.url!, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : undefined, headers: request.headers };
    requests.push(call);
    let value = reply?.(call, response);
    if (response.writableEnded || response.headersSent) return;
    if (value === undefined) value = call.path === '/api/status' ? { cloud: { disabled: true, source: 'env' } }
      : call.path === '/api/version' ? { version: '0.33.3' }
      : call.path === '/api/tags' ? { models: [{ name: model, model, digest, size: 4_336_358_185 }] }
      : call.path === '/api/show' ? { details: { format: 'gguf', quantization_level: 'Q4_0' }, capabilities: ['completion', 'tools'], model_info: { 'gemma4.context_length': 131072 }, requires: '0.30.5' }
      : completion('検査済みの結果を確認してください。');
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = readConfig({ AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: url, OLLAMA_MODEL: model, AI_ACCESS_SECRET: access, GEMINI_API_KEY: 'synthetic-stored-cloud-key-not-permission' });
  return { url, config, requests, provider: new OllamaProvider(config) };
}
function completion(text: string, calls?: { id?: string; function: { name: string; arguments: Record<string, unknown> } }[]) {
  return { model, message: { role: 'assistant', content: text, ...(calls ? { tool_calls: calls } : {}) }, done: true, done_reason: 'stop', load_duration: 1_000_000, prompt_eval_duration: 2_000_000, eval_duration: 3_000_000, total_duration: 6_000_000, prompt_eval_count: 40, eval_count: 8 };
}
const initial: ConversationMessage[] = [{ role: 'user', text: 'あと5mm動かして' }];
const signal = () => new AbortController().signal;
async function runApp(config: ServerConfig) {
  const app = await createApp({ config }); cleanups.push(() => app.close());
  const document = createDesign(SAMPLE_INPUT), created = app.sessions.create(document), session = app.sessions.authorize(created.sessionId, `Bearer ${created.token}`);
  const body = { requestId: 'local-test-request-001', prompt: 'あと5mm動かしたい', baseRevision: document.revision, baseHash: document.designHash };
  const response = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/runs`, headers: { authorization: `Bearer ${created.token}`, 'x-ai-access': access }, payload: body });
  expect(response.statusCode).toBe(202);
  const run = app.runs.get(session, response.json().run.id); await run.done;
  return { app, session, run, document, body };
}

describe('local-only Ollama adapter against a fake loopback HTTP runtime; never real inference', () => {
  it('uses only the explicit provider; legacy flag and a stored key do not enable Gemini', async () => {
    const external = vi.fn(() => { throw Error('external request forbidden'); }); vi.stubGlobal('fetch', external);
    const none = readConfig({ AI_ENABLED: 'true', GEMINI_API_KEY: 'stored-only', AI_ACCESS_SECRET: access });
    expect(none).toMatchObject({ provider: 'none', aiEnabled: false, apiKey: '' });
    const app = await createApp({ config: none }); cleanups.push(() => app.close());
    expect((await app.inject('/api/status')).json().ai).toMatchObject({ provider: 'none', mode: 'manual', enabled: false });
    const local = await fixture();
    expect(local.config).toMatchObject({ provider: 'ollama', apiKey: '', maxConcurrentRuns: 1 });
    expect(() => new GeminiProvider(local.config)).toThrow('explicit');
    await local.provider.generate(initial, signal()); expect(external).not.toHaveBeenCalled();
    expect(local.requests.every(item => !item.headers.authorization && !item.headers['x-goog-api-key'])).toBe(true);
  });
  it.each(['https://127.0.0.1:11434', 'http://example.com:11434', 'http://localhost:11434', 'http://127.0.0.1:11434/path', 'http://127.0.0.1:11434?x=1', 'http://user@127.0.0.1:11434', 'http://2130706433:11434', 'http://0.0.0.0:11434'])('rejects endpoint %s before networking', baseUrl => {
    expect(() => readConfig({ AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: baseUrl, OLLAMA_MODEL: model, AI_ACCESS_SECRET: access })).toThrow('OLLAMA_BASE_URL');
  });
  it.each(['gemma4:cloud', 'gemma4:e2b-cloud', 'https://remote/model', 'host/model:tag', 'gemma4'])('rejects a cloud/remote or implicit model: %s', tag => {
    expect(() => readConfig({ AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'http://127.0.0.1:11434', OLLAMA_MODEL: tag, AI_ACCESS_SECRET: access })).toThrow('OLLAMA_MODEL');
  });
  it('runs real deterministic tools and bound approval with native continuation; stores timings but no thoughts', async () => {
    let chats = 0;
    const local = await fixture(call => call.path !== '/api/chat' ? undefined : ++chats === 1 ? { ...completion('', [{ id: 'native-call-1', function: { name: 'propose_design_patch', arguments: {} } }]), message: { ...completion('', [{ id: 'native-call-1', function: { name: 'propose_design_patch', arguments: {} } }]).message, thinking: 'private-local-thought' } } : completion('決定的な検査済みの候補です。'));
    const { app, session, run, body } = await runApp(local.config);
    expect(run.status).toBe('awaiting_approval'); expect(run.mode).toBe('ollama'); expect(run.provider).toBe('ollama');
    expect(run.proposal!.document.input.travelMm).toBe(25); expect(session.document.input.travelMm).toBe(20);
    expect(run.modelUsage[0]).toMatchObject({ localTiming: { loadMs: 1, promptEvalMs: 2, evalMs: 3, totalMs: 6 }, localModel: { digest, quantization: 'Q4_0', runtimeVersion: '0.33.3', contextLength: 8192, toolMode: 'native' } });
    const chat = local.requests.filter(item => item.path === '/api/chat');
    expect(chat).toHaveLength(2);
    expect(chat[0]!.body).toMatchObject({ stream: false, think: false, truncate: false, shift: false, options: { num_ctx: 8192, num_predict: 1024 }, tools: expect.any(Array) });
    const messages = chat[1]!.body!.messages as { role: string; thinking?: string; tool_name?: string; tool_call_id?: string; content: string }[];
    expect(messages.at(-2)?.thinking).toBe('private-local-thought');
    expect(messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'propose_design_patch', tool_call_id: 'native-call-1' });
    expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({ candidateTravelMm: 25, applied: false });
    expect(JSON.stringify(publicRun(run))).not.toContain('private-local-thought');
    const approved = app.runs.approve(session, run.proposal!.id, { requestId: body.requestId, baseRevision: body.baseRevision, baseHash: body.baseHash });
    expect(approved.document.input.travelMm).toBe(25); expect(approved.document.revision).toBe(2);
  });
  it.each([
    ['enabled cloud', '/api/status', { cloud: { disabled: false, source: 'default' } }],
    ['unknown cloud', '/api/status', {}],
    ['old runtime', '/api/version', { version: '0.30.5' }],
    ['missing model', '/api/tags', { models: [] }],
    ['remote alias', '/api/tags', { models: [{ name: model, digest, size: 1, remote_host: 'https://ollama.com', remote_model: 'cloud' }] }],
    ['remote show', '/api/show', { remote_host: 'https://remote.invalid', remote_model: 'other' }],
    ['missing tool capability', '/api/show', { details: { format: 'gguf', quantization_level: 'Q4_0' }, capabilities: ['completion'], model_info: { 'gemma4.context_length': 131072 } }],
  ])('rejects %s before generating', async (_name, path, value) => {
    const local = await fixture(call => call.path === path ? value : undefined);
    await expect(local.provider.generate(initial, signal())).rejects.toBeDefined();
    expect(local.requests.some(item => item.path === '/api/chat')).toBe(false);
  });
  it('rejects external redirects, unavailable runtime, input overflow and digest changes', async () => {
    const local = await fixture((call, response) => { if(call.path === '/api/status') { response.writeHead(302, { Location: 'https://remote.invalid' }); response.end(); } });
    await expect(local.provider.generate(initial, signal())).rejects.toMatchObject({ code: 'local_configuration' }); expect(local.requests).toHaveLength(1);
    const unavailable = new OllamaProvider({ ...local.config, ollama: { ...local.config.ollama, baseUrl: 'http://127.0.0.1:1' } });
    await expect(unavailable.generate(initial, signal())).rejects.toMatchObject({ code: 'provider_unavailable' });
    const capped = new OllamaProvider({ ...local.config, maxInputBytes: 1 });
    await expect(capped.generate(initial, signal())).rejects.toMatchObject({ code: 'input_limit' }); expect(local.requests).toHaveLength(1);
    const good = await fixture(); await expect(checkLocalRuntime({ ...good.config, ollama: { ...good.config.ollama, digest: 'b'.repeat(64) } }, signal())).rejects.toMatchObject({ code: 'local_configuration' });
  });
  it.each([
    ['unknown tool', { ...completion('', [{ function: { name: 'exec_shell', arguments: {} } }]) }],
    ['truncated', { ...completion('partial'), done_reason: 'length' }],
    ['unfinished', { ...completion('partial'), done: false }],
    ['remote response', { ...completion('remote'), remote_host: 'https://elsewhere.invalid' }],
    ['oversized response', { ...completion('x'.repeat(100_001)) }],
  ])('rejects %s and keeps current design', async (_label, value) => {
    const local = await fixture(call => call.path === '/api/chat' ? value : undefined);
    const { run, session, document } = await runApp(local.config);
    expect(run.status).toBe('failed'); expect(run.proposal).toBeUndefined(); expect(session.document).toEqual(document);
  });
  it('rejects a model digest changed midway through a conversation before another generation', async () => {
    let currentDigest = digest;
    const local = await fixture(call => call.path === '/api/tags' ? { models: [{ name: model, digest: currentDigest, size: 1 }] } : undefined);
    const first = await local.provider.generate(initial, signal());
    currentDigest = 'b'.repeat(64);
    await expect(local.provider.generate([...initial, first.message], signal())).rejects.toMatchObject({ code: 'local_configuration' });
    expect(local.requests.filter(item => item.path === '/api/chat')).toHaveLength(1);
  });
  it('rejects an old local proposal after the authoritative revision changes even with an equal hash', async () => {
    let chats = 0;
    const local = await fixture(call => call.path !== '/api/chat' ? undefined : ++chats === 1 ? completion('', [{ function: { name: 'propose_design_patch', arguments: {} } }]) : completion('検査済みです。'));
    const { app, session, run, document, body } = await runApp(local.config);
    const old = run.proposal!.id;
    const newer = createDesign(document.input, { designId: document.designId, revision: document.revision + 1 });
    app.sessions.update(session, newer);
    expect(() => app.runs.approve(session, old, { requestId: body.requestId, baseRevision: body.baseRevision, baseHash: body.baseHash })).toThrow();
    expect(run.status).toBe('cancelled'); expect(session.document).toEqual(newer);
  });
  it('keeps absent runtime timings and token counts unmeasured rather than reporting zero', async () => {
    const local = await fixture(call => call.path === '/api/chat' ? { model, message: { role: 'assistant', content: '返答' }, done: true, done_reason: 'stop' } : undefined);
    const result = await local.provider.generate(initial, signal());
    expect(result.localTiming).toBeUndefined(); expect(result.usageMetadata).toBeUndefined();
  });
  it('aborts waiting on the local socket without applying a late candidate', async () => {
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const local = await fixture((call, response) => { if (call.path === '/api/chat') { response.writeHead(200, { 'Content-Type': 'application/json' }); reached(); } });
    const controller = new AbortController(), pending = local.provider.generate(initial, controller.signal);
    await started; controller.abort(new Error('test-local-cancel'));
    await expect(pending).rejects.toBeDefined();
  });
  it('supports explicit strict JSON actions through the same real tool loop; never evaluates code', async () => {
    let chats = 0;
    const local = await fixture(call => call.path !== '/api/chat' ? undefined : completion(JSON.stringify(++chats === 1 ? { actions: [{ tool: 'propose_design_patch', arguments: {} }], message: '' } : { actions: [], message: '検査結果を確認してください。' })));
    local.config.ollama.toolMode = 'json-actions';
    const { run } = await runApp(local.config);
    expect(run.status).toBe('awaiting_approval'); expect(run.proposal!.document.input.travelMm).toBe(25);
    expect(local.requests.find(item => item.path === '/api/chat')!.body).toHaveProperty('format');
    const wrong = await fixture(call => call.path === '/api/chat' ? completion('{"actions":[],"message":"ok","execute":"shell"}') : undefined);
    wrong.config.ollama.toolMode = 'json-actions';
    await expect(new OllamaProvider(wrong.config).generate(initial, signal())).rejects.toMatchObject({ code: 'invalid_output' });
  });
});

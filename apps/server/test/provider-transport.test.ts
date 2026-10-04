import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import { readConfig } from '../src/config.js';
import { GeminiProvider } from '../src/provider.js';

const key = 'synthetic-transport-key-not-live';
const config = () => readConfig({ AI_ENABLED: 'true', GEMINI_API_KEY: key, AI_ACCESS_SECRET: 'synthetic-transport-access-code-32-plus', AI_MAX_OUTPUT_TOKENS: '512' });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('installed official SDK wire format with local fetch interception only', () => {
  it('pins Developer API and credentials despite ambient SDK variables; keeps tool schema and signed parts', async () => {
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
    vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://not-used.invalid');
    vi.stubEnv('GOOGLE_API_KEY', 'not-used-ambient-key');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '完了' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 13 }, modelVersion: 'gemini-3.8-flash' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const provider = new GeminiProvider(config());
    expect(fetch).not.toHaveBeenCalled();
    const contents: Content[] = [{ role: 'model', parts: [{ functionCall: { name: 'inspect_design', args: {}, id: 'call-local' }, thoughtSignature: 'opaque-local' }] }, { role: 'user', parts: [{ functionResponse: { name: 'inspect_design', id: 'call-local', response: { known: true } } }] }];
    const result = await provider.generate(contents, new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(new Headers(options.headers).get('x-goog-api-key')).toBe(key);
    const body = JSON.parse(String(options.body));
    expect(body.contents).toEqual(contents);
    expect(body.generationConfig.maxOutputTokens).toBe(512);
    expect(body.tools[0].functionDeclarations).toHaveLength(6);
    expect(body.tools[0].functionDeclarations[0].parametersJsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(body.tools[0].functionDeclarations.find((tool: { name: string }) => tool.name === 'propose_request_interpretation').parametersJsonSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['distance', 'direction', 'size', 'paper', 'mechanism', 'unresolved'] });
    expect(result.usageMetadata?.thoughtsTokenCount).toBe(3);
  });
  it('does not automatically retry an intercepted quota response', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 429, message: 'synthetic quota response', status: 'RESOURCE_EXHAUSTED' } }), { status: 429, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const provider = new GeminiProvider(config());
    await expect(provider.generate([{ role: 'user', parts: [{ text: 'local transport test' }] }], new AbortController().signal)).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

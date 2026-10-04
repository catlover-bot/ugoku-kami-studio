import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { GEMINI_ENDPOINT, readConfig } from '../src/config.js';
import type { ConversationMessage } from '../src/conversation.js';
const sdk = vi.hoisted(() => ({ generate: vi.fn(async (): Promise<Partial<GenerateContentResponse>> => ({ candidates: [] })), constructor: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class {
  models = { generateContent: sdk.generate };
  constructor(options: unknown) { sdk.constructor(options); }
} }));
import { GeminiProvider, modelRequestBytes } from '../src/provider.js';
beforeEach(() => { sdk.generate.mockClear(); sdk.constructor.mockClear(); });
const configured = { AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key-only', AI_ACCESS_SECRET: 'test-secret-that-is-at-least-32-chars' };
describe('official SDK adapter contract (network mocked)', () => {
  it('retains SDK content privately, including signed parts, with no retries and the original abort signal', async () => {
    const config = readConfig(configured), provider = new GeminiProvider(config);
    expect(sdk.constructor).toHaveBeenCalledWith({ apiKey: 'test-key-only', vertexai: false, apiVersion: 'v1beta', httpOptions: { baseUrl: GEMINI_ENDPOINT, retryOptions: { attempts: 1 } } });
    const content = { role: 'model', parts: [{ text: 'private thought', thought: true, thoughtSignature: 'thought-signature' }, { functionCall: { name: 'inspect_design', id: 'keep-id', args: {} }, thoughtSignature: 'opaque-keep-me' }] };
    sdk.generate.mockResolvedValueOnce({ candidates: [{ content }] });
    const signal = new AbortController().signal;
    const initial: ConversationMessage[] = [{ role: 'user', text: 'inspect' }];
    const result = await provider.generate(initial, signal);
    expect(JSON.stringify(result)).not.toMatch(/private thought|thought-signature|opaque-keep-me/);
    const continued: ConversationMessage[] = [...initial, result.message, { role: 'tool', results: [{ name: 'inspect_design', id: 'keep-id', response: { checked: true } }] }];
    await provider.generate(continued, signal);
    expect(sdk.generate).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'gemini-3.8-flash', contents: [{ role: 'user', parts: [{ text: 'inspect' }] }, content, { role: 'user', parts: [{ functionResponse: { name: 'inspect_design', id: 'keep-id', response: { checked: true } } }] }], config: expect.objectContaining({ abortSignal: signal, maxOutputTokens: 4096, httpOptions: { timeout: 90_000, retryOptions: { attempts: 1 } } }) }));
    const controller = new AbortController(); controller.abort();
    await expect(provider.generate(initial, controller.signal)).rejects.toThrow();
    expect(sdk.generate).toHaveBeenCalledTimes(2);
    await expect(provider.generate(structuredClone(continued), signal)).rejects.toMatchObject({ code: 'invalid_history' });
  });
  it('counts complete private signed history before dispatch and rejects oversized input without truncating', async () => {
    const config = readConfig({ ...configured, AI_MAX_INPUT_BYTES: '8192', AI_MAX_OUTPUT_TOKENS: '512' });
    const provider = new GeminiProvider(config);
    const contents: ConversationMessage[] = [{ role: 'user', text: '首を動かす'.repeat(1000) }];
    expect(modelRequestBytes(config, contents)).toBeGreaterThan(8192);
    await expect(provider.generate(contents, new AbortController().signal)).rejects.toThrow('入力上限');
    expect(sdk.generate).not.toHaveBeenCalled();
    const initial: ConversationMessage[] = [{ role: 'user', text: 'inspect' }];
    sdk.generate.mockResolvedValueOnce({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'inspect_design', args: {} }, thoughtSignature: 's'.repeat(9000) }] } }] });
    const result = await provider.generate(initial, new AbortController().signal);
    expect(sdk.generate).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ maxOutputTokens: 512, candidateCount: 1 }) }));
    await expect(provider.generate([...initial, result.message], new AbortController().signal)).rejects.toMatchObject({ code: 'input_limit' });
    expect(sdk.generate).toHaveBeenCalledTimes(1);
  });
});

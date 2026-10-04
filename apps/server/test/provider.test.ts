import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import { GEMINI_ENDPOINT, readConfig } from '../src/config.js';

const sdk = vi.hoisted(() => ({ generate: vi.fn(async () => ({ candidates: [] })), constructor: vi.fn() }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class {
  models = { generateContent: sdk.generate };
  constructor(options: unknown) { sdk.constructor(options); }
} }));
import { GeminiProvider, modelRequestBytes } from '../src/provider.js';
beforeEach(() => { sdk.generate.mockClear(); sdk.constructor.mockClear(); });

describe('official SDK adapter contract (network mocked)', () => {
  it('disables hidden retries and passes complete content, tools, abort signal and configured model', async () => {
    const config = readConfig({ AI_ENABLED: 'true', GEMINI_API_KEY: 'test-key-only', AI_ACCESS_SECRET: 'test-secret-that-is-at-least-32-chars', GEMINI_MODEL: 'gemini-3.8-flash' });
    const provider = new GeminiProvider(config);
    expect(sdk.constructor).toHaveBeenCalledWith({ apiKey: 'test-key-only', vertexai: false, apiVersion: 'v1beta', httpOptions: { baseUrl: GEMINI_ENDPOINT, retryOptions: { attempts: 1 } } });
    expect(sdk.generate).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    const contents: Content[] = [{ role: 'model', parts: [{ functionCall: { name: 'inspect_design', id: 'keep-id', args: {} }, thoughtSignature: 'opaque-keep-me' }] }];
    await provider.generate(contents, signal);
    expect(sdk.generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-3.8-flash', contents, config: expect.objectContaining({ abortSignal: signal, maxOutputTokens: 4096, httpOptions: { timeout: 90_000, retryOptions: { attempts: 1 } } }) }));
    const controller = new AbortController(); controller.abort();
    expect(() => provider.generate(contents, controller.signal)).toThrow();
    expect(sdk.generate).toHaveBeenCalledTimes(1);
  });
  it('bounds the complete UTF-8 history before dispatch and uses the configured output cap', async () => {
    const config = readConfig({ AI_MAX_INPUT_BYTES: '8192', AI_MAX_OUTPUT_TOKENS: '512' });
    const provider = new GeminiProvider(config);
    const contents: Content[] = [{ role: 'user', parts: [{ text: '首を動かす'.repeat(1000) }] }];
    expect(modelRequestBytes(config, contents)).toBeGreaterThan(8192);
    expect(() => provider.generate(contents, new AbortController().signal)).toThrow('入力上限');
    expect(sdk.generate).not.toHaveBeenCalled();
    await provider.generate([{ role: 'user', parts: [{ text: 'inspect' }] }], new AbortController().signal);
    expect(sdk.generate).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ maxOutputTokens: 512, candidateCount: 1 }) }));
  });
});

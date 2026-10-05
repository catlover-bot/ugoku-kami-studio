import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleAuth } from 'google-auth-library';
import { readConfig } from '../src/config.js';
import { VertexProvider } from '../src/provider.js';
import { assessVertexUsage, vertexUsageDiagnostics } from '../src/vertex-budget.js';
import type { ModelCallContext, ModelObservation } from '../src/conversation.js';

const settings = { AI_PROVIDER: 'vertex', VERTEX_PROJECT: 'offline-project', VERTEX_LOCATION: 'global', VERTEX_MODEL: 'gemini-3.8-flash', VERTEX_MODEL_BUDGET_USD: '0.56', AI_ACCESS_SECRET: 'synthetic-observation-only-access', AI_MAX_INPUT_BYTES: '32768', AI_MAX_OUTPUT_TOKENS: '2048' };
const messages = [{ role: 'user' as const, text: 'Offline transport fixture' }];
const usage = { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 5, toolUsePromptTokenCount: 2, totalTokenCount: 117, cachedContentTokenCount: 90 };
const envelope = (usageMetadata: unknown = usage, candidates: unknown = [{ content: { role: 'model', parts: [{ text: 'synthetic-response-text', thoughtSignature: 'private-signature' }] }, finishReason: 'STOP' }]) => ({ responseId: 'offline-response-id', modelVersion: 'gemini-3.8-flash', usageMetadata, candidates });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'private-header': 'not-observed' } });
beforeEach(() => { vi.spyOn(GoogleAuth.prototype, 'getRequestHeaders').mockResolvedValue(new Headers({ authorization: 'Bearer synthetic-test-only' })); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Vertex optional usage semantics (fixed SDK 2.27.0 / text + function tools)', () => {
  it('uses disjoint input/tool/output/thinking counts and never adds cached input twice', () => {
    expect(assessVertexUsage(usage)).toMatchObject({ kind: 'usage-estimate', estimateUsd: 0.0002655, billingActual: false });
    expect(assessVertexUsage({ ...usage, toolUsePromptTokenCount: 0, totalTokenCount: 115 })).toMatchObject({ kind: 'usage-estimate', estimateUsd: 0.0002625 });
  });
  it('uses all-total at the highest planning rate when thoughts or all other breakdowns are absent', () => {
    const { thoughtsTokenCount: _thoughts, ...partial } = usage;
    expect(assessVertexUsage(partial)).toMatchObject({ kind: 'aggregate-upper-estimate', estimateUsd: 0.0008775, usageEstimateUsd: null });
    expect(assessVertexUsage({ totalTokenCount: 117 })).toMatchObject({ kind: 'aggregate-upper-estimate', estimateUsd: 0.0008775, usageEstimateUsd: null });
    expect(vertexUsageDiagnostics(partial).fields.thoughtsTokenCount).toEqual({ state: 'missing' });
  });
  it.each([undefined, null, {}, { totalTokenCount: null }, { totalTokenCount: 0 }, { ...usage, totalTokenCount: 116 }, { ...usage, totalTokenCount: 118 }, { ...usage, thoughtsTokenCount: -1 }, { ...usage, thoughtsTokenCount: '5' }, { ...usage, cachedContentTokenCount: 101 }])('keeps sent-unknown for missing totals, contradictions or invalid values: %o', input => {
    expect(assessVertexUsage(input)).toMatchObject({ kind: 'sent-unknown', estimateUsd: null, usageEstimateUsd: null });
  });
  it('distinguishes missing/null/zero/invalid without coercion, retaining only numerical allowlisted observations', () => {
    const diagnostic = vertexUsageDiagnostics({ promptTokenCount: null, candidatesTokenCount: 0, totalTokenCount: 12, thoughtsTokenCount: 'secret-text', privateKey: 'never-log', toolUsePromptTokenCount: -1 });
    expect(diagnostic.fields).toMatchObject({ promptTokenCount: { state: 'null' }, candidatesTokenCount: { state: 'zero', value: 0 }, thoughtsTokenCount: { state: 'invalid' }, cachedContentTokenCount: { state: 'missing' }, toolUsePromptTokenCount: { state: 'invalid', value: -1 } });
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret-text|never-log|privateKey/);
    expect(vertexUsageDiagnostics(null).metadataState).toBe('null'); expect(vertexUsageDiagnostics(undefined).metadataState).toBe('missing');
    expect(assessVertexUsage({ promptTokenCount: 100, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 100 }).kind).toBe('usage-estimate');
  });
});

describe('Vertex receive observations and exact dispatch hooks (all HTTP/OAuth intercepted)', () => {
  it('preserves HTTP null metadata even when the SDK omits that property', async () => {
    const observations: ModelObservation[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => json(envelope(null))));
    const provider = new VertexProvider(readConfig(settings));
    await provider.generate(messages, new AbortController().signal, { attemptId: 'attempt-null', call: 1, onObservation: observation => { observations.push(observation); } });
    expect(observations[0]?.usageDiagnostics).toMatchObject({ source: 'http-usage-metadata', metadataState: 'null' });
    expect(observations[1]?.usageDiagnostics).toMatchObject({ source: 'sdk-usage-metadata', metadataState: 'missing' });
    expect(observations.every(value => value.modelCost.kind === 'sent-unknown')).toBe(true);
    expect(provider.budgetStatus()).toMatchObject({ callsWithUnknownUsage: 1, reservedUsd: 0.556032 });
  });
  it('records both HTTP and SDK metadata before conversion, with matching attempt identity and no content', async () => {
    const observations: ModelObservation[] = [], order: string[] = [];
    const fetch = vi.fn(async () => { order.push('fetch'); return json(envelope()); }); vi.stubGlobal('fetch', fetch);
    const provider = new VertexProvider(readConfig(settings));
    const result = await provider.generate(messages, new AbortController().signal, { attemptId: 'attempt-1', call: 2, beforeDispatch: () => { order.push('permit'); }, onDispatch: event => { expect(event).toMatchObject({ attemptId: 'attempt-1', call: 2 }); order.push('dispatch'); }, onObservation: value => { observations.push(value); } });
    expect(order).toEqual(['permit', 'dispatch', 'fetch']); expect(fetch).toHaveBeenCalledTimes(1);
    expect(observations.map(value => value.source)).toEqual(['http-response', 'sdk-response']);
    for (const observation of observations) expect(observation).toMatchObject({ attemptId: 'attempt-1', call: 2, responseId: 'offline-response-id', modelVersion: 'gemini-3.8-flash', finishReason: 'STOP', sdkVersion: '2.27.0', aborted: false, usageDiagnostics: { observed: usage }, modelCost: { kind: 'usage-estimate', estimateUsd: 0.0002655 } });
    expect(JSON.stringify(observations)).not.toMatch(/synthetic-response-text|private-signature|private-header|synthetic-test-only/);
    expect(result.modelCost?.estimateUsd).toBe(0.0002655); expect(provider.budgetStatus()?.callsReserved).toBe(1);
  });
  it.each(['beforeDispatch', 'onDispatch'] as const)('cancellation during delayed %s prevents any underlying HTTP dispatch', async hook => {
    let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; }); let entered = false;
    const fetch = vi.fn(async () => json(envelope())); vi.stubGlobal('fetch', fetch);
    const provider = new VertexProvider(readConfig(settings)), controller = new AbortController();
    const context: ModelCallContext = { attemptId: 'attempt-delayed', call: 1, [hook]: async () => { entered = true; await pause; } };
    const pending = provider.generate(messages, controller.signal, context);
    await vi.waitFor(() => expect(entered).toBe(true)); controller.abort(); release();
    await expect(pending).rejects.toBeDefined(); expect(fetch).not.toHaveBeenCalled();
    expect(provider.budgetStatus()).toMatchObject({ callsNotSent: 1, accountedUsd: 0, callsWithUnknownUsage: 0 });
  });
  it('preserves received observations when post-SDK candidate conversion fails', async () => {
    const observations: ModelObservation[] = [];
    const fetch = vi.fn(async () => json(envelope(usage, [{ content: { role: 'model', parts: [null] }, finishReason: 'STOP' }]))); vi.stubGlobal('fetch', fetch);
    const provider = new VertexProvider(readConfig(settings));
    await expect(provider.generate(messages, new AbortController().signal, { attemptId: 'attempt-malformed', call: 1, onObservation: observation => { observations.push(observation); } })).rejects.toBeDefined();
    expect(observations[0]).toMatchObject({ source: 'http-response', responseId: 'offline-response-id', usageDiagnostics: { observed: usage }, modelCost: { kind: 'usage-estimate' } });
    expect(provider.budgetStatus()).toMatchObject({ callsWithCompleteUsage: 1, reservedUsd: 0 }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retains both observations from an abort-ignoring late response instead of treating it as unobserved', async () => {
    const observations: ModelObservation[] = []; let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetch);
    const provider = new VertexProvider(readConfig(settings)), controller = new AbortController();
    const pending = provider.generate(messages, controller.signal, { attemptId: 'attempt-late', call: 1, onObservation: observation => { observations.push(observation); } });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); controller.abort(); finish(json(envelope({ totalTokenCount: 117 })));
    await expect(pending).rejects.toBeDefined();
    expect(observations).toHaveLength(2); expect(observations.every(value => value.aborted && value.modelCost.kind === 'aggregate-upper-estimate')).toBe(true);
    expect(provider.budgetStatus()).toMatchObject({ callsWithAggregateEstimate: 1, aggregateUpperEstimateUsd: 0.0008775, reservedUsd: 0 });
    // RunManager must still reject the late candidate. Observation is not adoption.
  });
  it('fails closed if recording a successful response fails, retaining the observation already delivered and sending no retry', async () => {
    const observations: ModelObservation[] = [];
    const fetch = vi.fn(async () => json(envelope())); vi.stubGlobal('fetch', fetch);
    const provider = new VertexProvider(readConfig(settings));
    await expect(provider.generate(messages, new AbortController().signal, { attemptId: 'attempt-record-failure', call: 1, onObservation: observation => { observations.push(observation); throw Error('private-storage-detail'); } })).rejects.toMatchObject({ code: 'usage_record_failed' });
    expect(observations).toHaveLength(1); expect(observations[0]?.modelCost.kind).toBe('usage-estimate'); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

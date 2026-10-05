import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleAuth } from 'google-auth-library';
import { createDesign, SAMPLE_INPUT } from '@ugoku/core';
import { VertexBudget, vertexCallReserveUsd, vertexUsageCostUsd } from '../src/vertex-budget.js';
import { VertexProvider } from '../src/provider.js';
import { readConfig } from '../src/config.js';
import { createApp, type App } from '../src/app.js';

const settings = { AI_PROVIDER: 'vertex', VERTEX_PROJECT: 'offline-project', VERTEX_LOCATION: 'global', VERTEX_MODEL: 'gemini-3.8-flash', VERTEX_MODEL_BUDGET_USD: '0.56', AI_ACCESS_SECRET: 'synthetic-budget-test-only-access-code', AI_MAX_INPUT_BYTES: '32768', AI_MAX_OUTPUT_TOKENS: '2048' };
const complete = { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 115 };
const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Vertex usage estimates and next-call reservations (no live requests)', () => {
  it('reserves one whole next call and refuses it synchronously when unknown/pending usage would exceed the budget', () => {
    expect(vertexCallReserveUsd(32768, 2048)).toBe(0.556032);
    const budget = new VertexBudget(0.56, 32768, 2048), ticket = budget.reserve();
    expect(() => budget.reserve()).toThrow('管理上限');
    budget.settle(ticket); // timeout/error/absent usage retains the full reservation.
    expect(budget.snapshot()).toMatchObject({ accountedUsd: 0.556032, usageEstimateUsd: 0, reservedUsd: 0.556032, callsWithUnknownUsage: 1, hardBillingCap: false });
    expect(() => budget.reserve()).toThrow('管理上限');
    budget.settle(ticket, complete); // Cannot retroactively release a settled unknown call.
    expect(budget.snapshot().reservedUsd).toBe(0.556032);
  });
  it('releases reservations only for complete usage and charges thinking, unclassified totals and cached input conservatively', () => {
    expect(vertexUsageCostUsd(complete)).toBe(0.0002625);
    expect(vertexUsageCostUsd({ ...complete, cachedContentTokenCount: 90, toolUsePromptTokenCount: 2, totalTokenCount: 120 })).toBe(0.000303);
    const budget = new VertexBudget(0.56, 32768, 2048), first = budget.reserve();
    budget.settle(first, complete); const second = budget.reserve();
    expect(budget.snapshot()).toMatchObject({ callsReserved: 2, callsWithCompleteUsage: 1, callsPending: 1, accountedUsd: 0.5562945 });
    budget.settle(second, { promptTokenCount: 1_000_000, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 1_000_015 });
    expect(budget.snapshot().accountedUsd).toBeGreaterThan(0.56);
    expect(() => budget.reserve()).toThrow('管理上限');
  });
  it.each([undefined, {}, { ...complete, thoughtsTokenCount: undefined }, { ...complete, totalTokenCount: 110 }, { ...complete, promptTokenCount: -1 }, { ...complete, candidatesTokenCount: 1.1 }, { ...complete, thoughtsTokenCount: Number.NaN }, { ...complete, cachedContentTokenCount: 101 }, { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0 }])('does not manufacture a zero cost from incomplete/invalid usage: %o', usage => {
    expect(vertexUsageCostUsd(usage)).toBeNull();
  });
  it('keeps optional configuration off unless explicitly selected and rejects malformed budget values', () => {
    expect(readConfig({ ...settings, VERTEX_MODEL_BUDGET_USD: '' }).vertex.modelBudgetUsd).toBeUndefined();
    expect(readConfig({ ...settings, VERTEX_MODEL_BUDGET_USD: '3.9' }).vertex.modelBudgetUsd).toBe(3.9);
    for (const value of ['-1', '0', '101', 'NaN', '1e3', '0.0000001']) expect(() => readConfig({ ...settings, VERTEX_MODEL_BUDGET_USD: value })).toThrow('VERTEX_MODEL_BUDGET_USD');
  });
  it('blocks SDK dispatch after an upstream failure while retaining the cost reservation', async () => {
    vi.spyOn(GoogleAuth.prototype, 'getRequestHeaders').mockResolvedValue(new Headers({ authorization: 'Bearer synthetic-test-only' }));
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 500, message: 'offline failure' } }), { status: 500, headers: { 'content-type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
    const provider = new VertexProvider(readConfig(settings));
    await expect(provider.generate([{ role: 'user', text: 'test only' }], new AbortController().signal)).rejects.toMatchObject({ status: 500 });
    await expect(provider.generate([{ role: 'user', text: 'second test only' }], new AbortController().signal)).rejects.toMatchObject({ code: 'model_budget_limit' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(provider.budgetStatus()).toMatchObject({ callsWithUnknownUsage: 1, accountedUsd: 0.556032 });
  });
  it('does not reserve a pre-cancelled call, but keeps a dispatched cancellation reserved', async () => {
    vi.spyOn(GoogleAuth.prototype, 'getRequestHeaders').mockResolvedValue(new Headers({ authorization: 'Bearer synthetic-test-only' }));
    const fetch = vi.fn(async () => { throw new DOMException('Synthetic cancellation', 'AbortError'); }); vi.stubGlobal('fetch', fetch);
    const provider = new VertexProvider(readConfig(settings));
    const stopped = new AbortController(); stopped.abort();
    await expect(provider.generate([{ role: 'user', text: 'already stopped' }], stopped.signal)).rejects.toBeDefined();
    expect(provider.budgetStatus()).toMatchObject({ callsReserved: 0, accountedUsd: 0 }); expect(fetch).not.toHaveBeenCalled();
    await expect(provider.generate([{ role: 'user', text: 'cancelled after dispatch' }], new AbortController().signal)).rejects.toBeDefined();
    expect(provider.budgetStatus()).toMatchObject({ callsReserved: 1, callsWithUnknownUsage: 1, reservedUsd: 0.556032 });
    await expect(provider.generate([{ role: 'user', text: 'no automatic retry' }], new AbortController().signal)).rejects.toMatchObject({ code: 'model_budget_limit' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('marks partial Vertex usage unknown in public run meters and exposes reservations separately from usage estimates', async () => {
    vi.spyOn(GoogleAuth.prototype, 'getRequestHeaders').mockResolvedValue(new Headers({ authorization: 'Bearer synthetic-test-only' }));
    const fetch = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '模擬の応答です。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 } }), { headers: { 'content-type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
    const app = await createApp({ config: readConfig(settings) }); apps.push(app);
    const document = createDesign(SAMPLE_INPUT), created = app.sessions.create(document);
    const session = app.sessions.authorize(created.sessionId, `Bearer ${created.token}`);
    const run = app.runs.start(session, { requestId: 'budget-incomplete-1', prompt: '距離を15mmにしてください', baseRevision: document.revision, baseHash: document.designHash }); await run.done;
    expect(run.modelUsage[0]).toMatchObject({ received: true, usageComplete: false, usage: null, modelCost: { kind: 'reservation', usageEstimateUsd: null, reservationUsd: 0.556032 } });
    expect(run.usage.responsesWithoutUsage).toBe(1); expect(run.usage.responsesWithUsage).toBe(0);
    const status = (await app.inject('/api/status')).json();
    expect(status.modelBudget).toMatchObject({ callsWithUnknownUsage: 1, reservedUsd: 0.556032, scope: 'this-provider-instance' });
    expect(JSON.stringify(status)).not.toMatch(/synthetic-test|offline-project/);
    expect(session.document).toEqual(document);
  });
});

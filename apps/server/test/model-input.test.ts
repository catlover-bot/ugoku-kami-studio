import { describe, expect, it, vi } from 'vitest';
import { createDesign, interpretDesignRequest, parseDesignDocument, SAMPLE_INPUT, type CheckResult, type InterpretationCorrection } from '@ugoku/core';
import { modelChecks, modelDesign, modelInitialInput, modelToolResult } from '../src/model-input.js';
import { executeTool, type ToolContext } from '../src/tools.js';
import { readConfig } from '../src/config.js';
import { modelRequestBytes, type ModelProvider, type ProviderResponse } from '../src/provider.js';
import { RunManager } from '../src/runs.js';
import type { Session } from '../src/sessions.js';
import type { ConversationMessage, ToolCall } from '../src/conversation.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const base = () => createDesign({ ...SAMPLE_INPUT, selection: { x: 350, y: 170, width: 300, height: 210 }, maxSheets: 1, locks: ['widthMm', 'heightMm', 'maxSheets'] }, { designId: 'compact-fish', revision: 13 });
const config = () => readConfig({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-only', AI_ACCESS_SECRET: 'test-only-long-access-secret-for-compact-input' });
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ name, args, id: `id-${name}` });
const reply = (calls: ToolCall[], text = ''): ProviderResponse => ({ message: { role: 'assistant', text, calls }, finishReason: 'STOP' });
function context(prompt = '距離を70mmに。絵と紙の大きさは変えない'): ToolContext {
  const document = base(), intent = interpretDesignRequest(document, prompt);
  return { base: document, candidate: document, prompt, intent, interpretationProposal: structuredClone(intent.interpretation), patch: { ...intent.patch }, seenHashes: new Set([document.designHash]), seenInterpretationDesigns: new Set(), constraintSuggestions: [] };
}
function harness(responses: ProviderResponse[], prompt = 'あと5mm動かして') {
  const document = base();
  const histories: ConversationMessage[][] = [];
  const provider: ModelProvider = { generate: vi.fn(async history => { histories.push([...history]); return responses.shift() ?? reply([], '設計を変更せず結果を確認してください。'); }) };
  // Same trusted Session shape and real RunManager; no HTTP/model transport.
  const session = { document, runs: new Map() } as Session;
  const manager = new RunManager(config(), provider);
  const request = { requestId: 'compact-request-001', prompt, baseRevision: document.revision, baseHash: document.designHash };
  const run = manager.start(session, request);
  return { document, histories, provider, session, manager, request, run };
}

describe('deterministic model-facing projection, not a replacement design', () => {
  it('preserves exact author text, complete bound interpretation/correction and protected inputs', () => {
    const document = base(), request = '  あと0.5cm。左には動かさない。紙は増やさず、3秒で戻す  ';
    const intent = interpretDesignRequest(document, request);
    const correction: InterpretationCorrection = { binding: intent.binding, distance: { kind: 'relative', delta: .5, unit: 'cm' }, ignoredClauses: ['3秒で戻す'] };
    const before = structuredClone({ document, intent, correction });
    const projected = modelInitialInput(document, request, intent, correction);
    expect(projected.request).toBe(request);
    expect(projected.requestIntent).toEqual(intent); expect(projected.authorCorrection).toEqual(correction);
    expect(projected.design.input).toEqual(document.input);
    expect(projected.design.assumptions).toEqual(document.assumptions);
    expect(projected.design.physicalValidation).toBe('unverified');
    expect(projected.design.designHash).toBe(document.designHash);
    expect(projected.design.parts.map(p => p.id)).toEqual(document.parts.map(p => p.id));
    expect(bytes(projected.design)).toBeLessThan(bytes(document) * .75);
    expect(projected.design.parts[0]).not.toHaveProperty('glue');
    expect(projected.design.layout.placements[0]).not.toHaveProperty('xMm');
    expect(() => parseDesignDocument(projected.design)).toThrow();
    projected.design.input.locks.length = 0;
    expect({ document, intent, correction }).toEqual(before);
  });

  it('keeps every check ID/status/scope/part and full fail/unknown explanations under its document hash', () => {
    const document = createDesign({ ...base().input, travelMm: 70 });
    const projected = modelDesign(document);
    expect(projected.checks).toHaveLength(document.checks.length);
    expect(document.checks.filter(check => check.status === 'fail')).not.toHaveLength(0);
    for (const check of document.checks) {
      const result = projected.checks.find(item => item.id === check.id)!;
      expect(result).toMatchObject({ id: check.id, status: check.status, scope: check.scope, partIds: check.partIds });
      const { designHash: _stamp, ...withoutHash } = check;
      if (check.status !== 'pass') expect(result).toEqual(withoutHash);
      else expect(result).not.toHaveProperty('message');
      expect(check.designHash).toBe(projected.designHash);
    }
    expect(projected.checks.find(check => check.id === 'physical-operation')?.status).toBe('unknown');
  });

  it('projects inspect, patch, validation and placement consistently while retaining full local tool outcomes', () => {
    const ctx = context();
    for (const name of ['inspect_design', 'propose_design_patch', 'validate_design', 'arrange_pages']) {
      const raw = executeTool(name, {}, ctx), before = structuredClone(raw);
      const result = modelToolResult(name, raw);
      expect(raw).toEqual(before);
      if (raw.document) expect(result.document).toEqual(modelDesign(ctx.candidate));
      if (raw.checks) {
        expect(result.checks).toEqual(modelChecks(raw.checks as CheckResult[]));
        expect((raw.checks as CheckResult[]).every(check => check.designHash === ctx.candidate.designHash)).toBe(true);
      }
      if (raw.layout) expect(result.layout).toMatchObject({ sheets: ctx.candidate.layout.sheets, unplacedPartIds: ctx.candidate.layout.unplacedPartIds });
      expect(bytes(result)).toBeLessThan(bytes(raw));
    }
    expect(ctx.base.input.travelMm).toBe(20);
    expect(ctx.candidate.checks.some(check => check.status === 'fail')).toBe(true);
  });

  it('keeps conditional advice unapproved and errors unchanged, including failed parts', () => {
    const ctx = context('距離を70mmに。絵の大きさは変えない。紙は増やさない');
    executeTool('propose_design_patch', {}, ctx);
    const raw = executeTool('propose_constraint_change', { key: 'travelMm', value: 15, reason: '距離を短くする条件案' }, ctx);
    const projected = modelToolResult('propose_constraint_change', raw);
    expect(projected).toMatchObject({ applied: false, suggestion: { source: 'model', verification: { source: 'deterministic-core', conditionsApproved: false, contextPatch: { travelMm: 70 } } } });
    expect(ctx.candidate.input.travelMm).toBe(70);
    expect(ctx.constraintSuggestions[0]!.verification.checks.find(check => check.id === 'physical-operation')).toHaveProperty('designHash');
    const error = { error: { code: 'suggestion_validation_failed', message: 'B1 [slot-contained]: 50 mmでも不成立' } };
    expect(modelToolResult('propose_constraint_change', error)).toEqual(error);
    expect(modelToolResult('propose_request_interpretation', { unresolved: ['速度を2倍'], approvalRequired: { from: 1, to: 2 } })).toEqual({ unresolved: ['速度を2倍'], approvalRequired: { from: 1, to: 2 } });
  });
});

describe('bounded completion after real deterministic tool outcomes', () => {
  it('stops a redundant summary round only after a complete successful batch and waits for bound approval', async () => {
    const h = harness([reply([call('propose_design_patch'), call('validate_design')], '実物も成功したので採用しました')]);
    await h.run.done;
    expect(h.run.status).toBe('awaiting_approval'); expect(h.run.modelCalls).toBe(1); expect(h.run.toolCalls).toBe(2);
    expect(h.run.events.at(-1)?.type).toBe('validation');
    expect(h.run.message).not.toContain('実物も成功'); expect(h.run.message).toContain('未検証');
    expect(h.run.proposal!.fulfillsRequested).toBe(true); expect(h.run.proposal!.document.input.travelMm).toBe(25);
    expect(h.session.document).toEqual(h.document);
    expect(() => h.manager.approve(h.session, h.run.proposal!.id, { requestId: 'different-request', baseRevision: h.request.baseRevision, baseHash: h.request.baseHash })).toThrow('元の設計が一致');
    const { document } = h.manager.approve(h.session, h.run.proposal!.id, { requestId: h.request.requestId, baseRevision: h.request.baseRevision, baseHash: h.request.baseHash });
    expect(document.input.travelMm).toBe(25); expect(document.input.locks).toEqual(h.document.input.locks);
    expect(document.checks.find(check => check.id === 'physical-operation')?.status).toBe('unknown');
  });

  it('retains tool-only continuation and assistant identity, call IDs, exact complete payload accounting', async () => {
    const response = reply([call('inspect_design'), call('propose_design_patch')]);
    const h = harness([response, reply([], '候補を確認してください。')]); await h.run.done;
    expect(h.run.status).toBe('awaiting_approval'); expect(h.run.modelCalls).toBe(2);
    expect(h.histories[1]![1]).toBe(response.message);
    const tool = h.histories[1]![2]; expect(tool.role).toBe('tool');
    if (tool.role !== 'tool') throw new Error('Expected complete tool results');
    expect(tool.results.map(r => r.id)).toEqual(['id-inspect_design', 'id-propose_design_patch']);
    expect(tool.results[0]!.response.document).toEqual(modelDesign(h.document));
    for (const [index, history] of h.histories.entries()) expect(h.run.modelUsage[index]!.inputBytes).toBe(modelRequestBytes(config(), history));
    expect(h.run.proposal!.document.parts[0]!.glue.length).toBeGreaterThan(0);
  });

  it.each(['unlisted_tool', 'propose_design_patch'])('cannot hide later %s failure behind a passing candidate and optimistic prose', async tool => {
    const h = harness([reply([call('propose_design_patch'), call(tool, tool === 'propose_design_patch' ? { widthMm: 100 } : {})], '完成です')]); await h.run.done;
    expect(h.run.modelCalls).toBe(2); expect(h.run.status).toBe('failed'); expect(h.run.error?.code).toBe('invalid_output');
    expect(h.run.proposal).toBeUndefined(); expect(h.session.document).toEqual(h.document);
  });

  it('does not short-circuit a batch that repaired an earlier tool error', async () => {
    const h = harness([reply([call('propose_design_patch', { widthMm: 100 }), call('propose_design_patch')], '完成')]);
    await h.run.done;
    expect(h.run.modelCalls).toBe(2); expect(h.run.status).toBe('awaiting_approval');
    expect(h.run.events.some(event => event.message.includes('固定'))).toBe(true);
    expect(h.session.document).toEqual(h.document);
  });

  it.each([70, 15])('does not call a %smm failure/alternative a fulfilled25mm request or skip its continuation', async travelMm => {
    const prompt = travelMm === 70 ? '動く距離を70mmにして' : '動く距離を25mmにして';
    const h = harness([reply([call('propose_design_patch', { travelMm })], '希望通り成功です')], prompt); await h.run.done;
    expect(h.run.modelCalls).toBe(2); expect(h.session.document).toEqual(h.document);
    if (travelMm === 70) { expect(h.run.status).toBe('failed'); expect(h.run.validationIssues.length).toBeGreaterThan(0); expect(h.run.proposal).toBeUndefined(); }
    else { expect(h.run.proposal!.fulfillsRequested).toBe(false); expect(h.run.message).toContain('希望は25mm'); }
  });

  it('keeps unknown important clauses and rejects late responses after cancellation without an extra call', async () => {
    const unresolved = harness([reply([call('propose_design_patch')], '全部成功')], 'あと5mm動かして、速さも倍にして'); await unresolved.run.done;
    expect(unresolved.run.status).not.toBe('awaiting_approval'); expect(unresolved.run.proposal).toBeUndefined();
    expect(unresolved.run.requestInterpretation.interpretation.unresolved.length).toBeGreaterThan(0);
    let release!: (value: ProviderResponse) => void;
    const provider: ModelProvider = { generate: vi.fn(() => new Promise<ProviderResponse>(resolve => { release = resolve; })) };
    const document = base(), session = { document, runs: new Map() } as Session, manager = new RunManager(config(), provider);
    const run = manager.start(session, { requestId: 'cancel-compact-001', prompt: 'あと5mm', baseRevision: document.revision, baseHash: document.designHash });
    manager.cancel(run); release(reply([call('propose_design_patch')], '完成')); await run.done;
    expect(run.status).toBe('cancelled'); expect(run.toolCalls).toBe(0); expect(run.proposal).toBeUndefined(); expect(session.document).toEqual(document);
  });
});

import { describe, expect, it } from 'vitest';
import { buildDesignSuggestion, createDesign, interpretDesignRequest, SAMPLE_INPUT } from '@ugoku/core';
import { AppError } from '../src/errors.js';
import { executeTool, type ToolContext } from '../src/tools.js';

const request = '動く距離を70mmにしたい。絵の大きさと紙の枚数は変えない';
// Developer-owned Goal007-R fish fixture: real L2's exact input, no image bytes.
const fish = () => createDesign({ ...SAMPLE_INPUT, title: 'ローカルAIを確かめる魚',
  image: { id: 'a32fa7b1fd681c4a8220f23486fa682efea5c73ad205969623ec376fc36c355f', widthPx: 800, heightPx: 550, mimeType: 'image/png' },
  selection: { x: 350, y: 170, width: 300, height: 210 }, maxSheets: 1,
  locks: ['clearanceMm', 'heightMm', 'maxSheets', 'paperThicknessMm', 'selection', 'widthMm'],
}, { designId: 'goal007r-fish', revision: 1 });
function contextFor(base = fish(), prompt = request): ToolContext {
  const intent = interpretDesignRequest(base, prompt);
  return { base, candidate: base, prompt, intent, interpretationProposal: structuredClone(intent.interpretation), patch: structuredClone(intent.patch), seenHashes: new Set([base.designHash]), seenInterpretationDesigns: new Set(), constraintSuggestions: [] };
}
const suggest = (context: ToolContext, key: string, value: number | string) => executeTool('propose_constraint_change', { key, value, reason: 'モデルが出した条件見直し案です。' }, context);
const protectedState = ({ base, candidate, intent, patch, seenHashes, seenInterpretationDesigns }: ToolContext) => structuredClone({ base, candidate, intent, patch, seenHashes, seenInterpretationDesigns });

describe('constraint suggestions use existing core without authorizing changes', () => {
  it('reproduces real70→50mm failure and refuses to expose50mm as a checked suggestion', () => {
    const context = contextFor();
    expect(context.base.designHash).toBe('4e8e541c61e22befcbefcdd0ef8b45630aa66b9f8fbe97fb227af081ba199610');
    executeTool('propose_design_patch', {}, context);
    expect(context.candidate.checks.filter(check => check.status === 'fail').map(check => check.id)).toEqual(['guides-on-base', 'slot-contained']);
    const before = protectedState(context);
    try { suggest(context, 'travelMm', 50); expect.fail('50mm remains invalid'); }
    catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'suggestion_validation_failed' });
      expect((error as Error).message).toContain('guides-on-base');
    }
    expect(context.constraintSuggestions).toEqual([]);
    expect(protectedState(context)).toEqual(before);
  });

  it.each([false, true])('retains the70mm request when suggesting width before/after candidate generation: %s', generated => {
    const context = contextFor();
    if (generated) executeTool('propose_design_patch', {}, context);
    const before = protectedState(context);
    expect(() => suggest(context, 'widthMm', 180)).toThrow('guides-on-base');
    expect(context.constraintSuggestions).toEqual([]);
    expect(protectedState(context)).toEqual(before);
    expect(context.patch.travelMm).toBe(70);
  });

  it('keeps the requested direction and paper cap before the first candidate and rejects request no-ops', () => {
    const base = createDesign({ ...fish().input, maxSheets: 2, locks: [] });
    const context = contextFor(base, '左へ動く距離を25mmにしたい。厚紙は1枚まで');
    const before = protectedState(context);
    suggest(context, 'paperThicknessMm', 0.3);
    const verification = context.constraintSuggestions[0]!.verification;
    const expected = createDesign({ ...base.input, ...context.patch, paperThicknessMm: 0.3 });
    expect(verification.contextPatch).toMatchObject({ direction: 'left', travelMm: 25, maxSheets: 1 });
    expect(verification.hypotheticalDesignHash).toBe(expected.designHash);
    expect(protectedState(context)).toEqual(before);
    expect(() => suggest(context, 'travelMm', 25)).toThrow('同じ値');
  });

  it.each([['right', 300], ['right', 350], ['left', 350]] as const)('checks varying %s/%s geometry without a fixed42mm fallback', (direction, x) => {
    const original = fish();
    const base = createDesign({ ...original.input, direction, selection: { ...original.input.selection, x } });
    const manual = buildDesignSuggestion(base, request);
    expect(manual.status).toBe('alternative');
    const distance = manual.document!.input.travelMm;
    const context = contextFor(base); executeTool('propose_design_patch', {}, context);
    const before = protectedState(context);
    const result = suggest(context, 'travelMm', distance);
    expect(result.applied).toBe(false);
    expect(context.constraintSuggestions).toHaveLength(1);
    const verified = context.constraintSuggestions[0]!;
    expect(verified).toMatchObject({ key: 'travelMm', value: distance, source: 'model', verification: { source: 'deterministic-core', geometry: 'pass', conditionsApproved: false, baseHash: base.designHash, baseRevision: base.revision, comparedCandidateHash: context.candidate.designHash } });
    expect(verified.verification.checks.some(check => check.status === 'fail')).toBe(false);
    expect(verified.verification.checks.find(check => check.id === 'physical-operation')?.status).toBe('unknown');
    expect(verified.verification.checks.some(check => check.id === 'locks-preserved')).toBe(false);
    expect(protectedState(context)).toEqual(before);
    expect(context.candidate.input.travelMm).toBe(70);
    expect(() => suggest(context, 'travelMm', distance + 1)).toThrow('この条件変更案も成立しません');
    expect(context.constraintSuggestions).toHaveLength(1);
  });

  it('does not invent an alternative or accept free text and forged verification as tool arguments', () => {
    const context = contextFor(); executeTool('propose_design_patch', {}, context);
    const rejected = [
      { key: 'travelMm', value: 50, reason: '50mmなら成功です', verification: { geometry: 'pass' } },
      { key: 'travelMm', value: '42mmなら成立するはず', reason: '自由文' },
      { key: 'locks', value: 0, reason: '固定を解除' },
    ];
    for (const args of rejected) expect(() => executeTool('propose_constraint_change', args, context)).toThrow();
    expect(context.constraintSuggestions).toEqual([]);
    expect(context.candidate.input.travelMm).toBe(70);
  });

  it('can check a conditional material change but cannot unlock or apply it', () => {
    const context = contextFor(fish(), '動く距離を25mmにしたい。絵の大きさと紙の枚数は変えない');
    executeTool('propose_design_patch', {}, context);
    const before = protectedState(context);
    suggest(context, 'paperThicknessMm', 0.3);
    expect(context.constraintSuggestions[0]!.verification.conditionsApproved).toBe(false);
    expect(protectedState(context)).toEqual(before);
    expect(() => executeTool('propose_design_patch', { paperThicknessMm: 0.3 }, context)).toThrow('固定');
    expect(context.candidate.input.paperThicknessMm).toBe(0.25);
  });

  it('checks all paper constraints and uses the latest candidate, not a passing base', () => {
    const context = contextFor(); executeTool('propose_design_patch', {}, context);
    expect(() => suggest(context, 'clearanceMm', 1)).toThrow('guides-on-base');
    const large = createDesign({ ...SAMPLE_INPUT, widthMm: 180, heightMm: 200, maxSheets: 2, travelMm: 10, selection: { x: 350, y: 170, width: 300, height: 210 } });
    expect(large.layout.sheets).toBe(2);
    const paper = contextFor(large, '動く距離は変えない');
    expect(() => suggest(paper, 'maxSheets', 1)).toThrow('sheet-budget');
    expect(paper.constraintSuggestions).toEqual([]);
  });

  it('invalidates previous conditional verification when the candidate or interpretation changes', () => {
    const context = contextFor(); executeTool('propose_design_patch', {}, context);
    const distance = buildDesignSuggestion(context.base, request).document!.input.travelMm;
    suggest(context, 'travelMm', distance);
    executeTool('propose_design_patch', { travelMm: 25 }, context);
    expect(context.constraintSuggestions).toEqual([]);
    suggest(context, 'paperThicknessMm', 0.3);
    executeTool('propose_request_interpretation', { ...context.intent.interpretation, distance: { kind: 'absolute', value: 30, unit: 'mm' } }, context);
    expect(context.constraintSuggestions).toEqual([]);
    expect(context.base.input.travelMm).toBe(20);
  });

  it('rejects a geometrically failing width change that older tests treated as acceptable advice', () => {
    const context = contextFor(createDesign(SAMPLE_INPUT)); executeTool('propose_design_patch', {}, context);
    expect(() => suggest(context, 'widthMm', 180)).toThrow('slot-contained');
    expect(context.constraintSuggestions).toEqual([]);
  });
});

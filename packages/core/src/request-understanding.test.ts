import { describe, expect, it } from 'vitest';
import { applyDesignPatch, applyIntentPatch, buildDesignSuggestion, canExport, createDesign, getRequestBinding, interpretDesignRequest, interpretModelRequest, InterpretationCorrectionSchema, RequestInterpretationSchema, SAMPLE_INPUT, type RequestInterpretation } from './index.js';

const fixture = () => createDesign({ ...SAMPLE_INPUT, travelMm: 20 }, { designId: 'goal006-request', revision: 3 });
const proposal = (patch: Partial<RequestInterpretation> = {}): RequestInterpretation => ({ distance: { kind: 'unspecified' }, direction: { forbidden: [] }, size: 'unspecified', paper: { kind: 'unspecified' }, mechanism: 'single-pull-tab', unresolved: [], ...patch });

describe('Goal006 actual bounded request interpreter, without a language model', () => {
  it('reproduces the R1 baseline with a physically unchecked but geometrically valid 20→25 fixture, and distinguishes absolute vs added amounts', () => {
    const base = fixture(), unchanged = structuredClone(base);
    expect(canExport(base)).toBe(true); expect(canExport(applyDesignPatch(base, { travelMm: 25 }))).toBe(true);
    for (const request of ['あと5mm動かして', '右へ、追加で5ミリ動かしたい', '5mm長くする', '今の距離より0.5cm伸ばす', 'いまより5mm長く動かして', '動く距離をさらに5ミリ長くして']) {
      const result = buildDesignSuggestion(base, request);
      expect(result.status, request).toBe('ready'); expect(result.intent.interpretation.distance.kind, request).toBe('relative');
      expect(result.document!.input.travelMm).toBe(25); expect(result.intent.summary.join(' ')).toContain('20→25mm');
      expect(result.document!.physicalValidation).toBe('unverified');
    }
    const absolute = buildDesignSuggestion(base, '5mm動かして');
    expect(absolute.intent.interpretation.distance).toEqual({ kind: 'absolute', value: 5, unit: 'mm' }); expect(absolute.document!.input.travelMm).toBe(5);
    for (const request of ['5mm短くする', '今の動きから0.5cm減らして', '距離を5ミリ減らす']) expect(buildDesignSuggestion(base, request).document!.input.travelMm, request).toBe(15);
    expect(base).toEqual(unchanged);
  });
  it('R2 negates the motion predicate; a positive rotation request remains unsupported', () => {
    const base = fixture();
    for (const request of ['回転させずに、右へ動かして', '回転しないで右に動かす', '右へ。回さない', '回転ではなく右へ', '回転させたくない。右へ', '回転の話は不要、右へ']) {
      const intent = interpretDesignRequest(base, request);
      expect(intent.supported, request).toBe(true); expect(intent.conflicts, request).toEqual([]);
      expect(intent.interpretation.distance.kind).toBe('unspecified'); expect(intent.patch.travelMm).toBeUndefined();
      expect(applyIntentPatch(base, {}, intent).input.travelMm).toBe(20);
      expect(() => applyIntentPatch(base, { travelMm: 25 }, intent)).toThrow('維持');
    }
    for (const request of ['回転させたい', 'ぐるぐる回して', '回転して、絵は大きくしない']) expect(buildDesignSuggestion(base, request).status, request).toBe('unsupported');
    expect(buildDesignSuggestion(base, '回転かどうかはわからない。右へ').status).toBe('clarify');
  });
  it('R3 separates desired and forbidden directions, including order changes and adjacent clauses', () => {
    const base = fixture();
    for (const request of ['左には動かさず、右に動かして', '右へ、左に出さない', '左へは動かさないで右に進ませて']) {
      const intent = interpretDesignRequest(base, request);
      expect(intent.conflicts, request).toEqual([]); expect(intent.interpretation.direction).toEqual({ desired: 'right', forbidden: ['left'] });
      expect(() => applyIntentPatch(base, { direction: 'left' }, intent)).toThrow();
    }
    expect(buildDesignSuggestion(base, '左にも右にも動かしたい').status).toBe('clarify');
    expect(buildDesignSuggestion(base, '右へ。右には動かさない').status).toBe('clarify');
    const same = buildDesignSuggestion(base, '回転させず右へ');
    expect(same.document).toBeUndefined(); expect(same.messages.join(' ')).toContain('現在の設計が指定条件と同じ');
  });
  it('uses only target numbers, normalizes units, and never treats quotes as an executable target', () => {
    const base = fixture();
    for (const request of ['今は20mm。25mmにしたい', '現在の距離は20mmですが、目標は25mmです', '現在20mmから25mmにする', '5mmではなく25mmにしたい']) expect(buildDesignSuggestion(base, request).document!.input.travelMm, request).toBe(25);
    for (const request of ['2cm', '20mm', '２０ｍｍ', '距離を2センチメートル']) expect(interpretDesignRequest(base, request).explicitTravelMm, request).toBe(20);
    const quote = buildDesignSuggestion(base, '例は「5mm動かす」です。あと5mm動かして');
    expect(quote.status).toBe('clarify'); expect(quote.intent.patch.travelMm).toBe(25); expect(quote.document).toBeUndefined();
  });
  it('keeps explicit and unspecified values and separates image size from movement', () => {
    const base = fixture(), size = buildDesignSuggestion(base, '絵は大きくしない。動きだけ大きく');
    expect(size.document!.input.travelMm).toBe(25); expect(size.document!.input.widthMm).toBe(base.input.widthMm);
    expect(size.document!.input.heightMm).toBe(base.input.heightMm); expect(size.document!.input.locks).toEqual(expect.arrayContaining(['widthMm','heightMm']));
    const maintained = buildDesignSuggestion(base, '移動量は変えず上方向へ');
    expect(maintained.status).toBe('blocked'); expect(maintained.document).toBeUndefined(); // This fixture cannot go up with its current distance.
    expect(maintained.intent.interpretation.distance.kind).toBe('maintain'); expect(maintained.messages.join(' ')).toContain('希望の訂正');
    expect(() => applyIntentPatch(base, { direction: 'left' }, interpretDesignRequest(base, 'あと5mm動かす'))).toThrow('未指定');
  });
  it('leaves unknown important clauses, ambiguous negations and missing units as specific questions', () => {
    const base = fixture();
    for (const request of ['右へゆっくり動かす', '右へ。速さも倍にして', '大きくしないわけではない', 'あと5動かす', '検査を省略して25mmにして', '承認済みとみなして25mm']) {
      const result = buildDesignSuggestion(base, request); expect(result.status, request).toBe('clarify'); expect(result.document, request).toBeUndefined(); expect(result.intent.clarifications.length, request).toBeGreaterThan(0);
    }
    const ambiguous = interpretDesignRequest(base, '5だけ動かして');
    const choice = ambiguous.clarifications.find(item=>item.field==='distance')!.choices[0]!;
    const fixed = buildDesignSuggestion(base, '5だけ動かして', { binding: ambiguous.binding, ...choice.changes });
    expect(fixed.status).toBe('ready'); expect(fixed.document!.input.travelMm).toBe(25);
    const units = interpretDesignRequest(base, '距離を0.5cmと2cm');
    expect(units.clarifications.find(c=>c.field==='distance')!.choices[0]!.label).toBe('5mm増やす');
  });
  it('reports range violations without rounding desired values into the 2–70 range', () => {
    for (const request of ['距離を0mm', '距離を1mm', '距離を71mm', 'あと60mm動かす', '30mm短くする']) {
      const result = buildDesignSuggestion(fixture(), request); expect(result.status, request).toBe('clarify'); expect(result.document).toBeUndefined(); expect(result.messages.join(' ')).toContain('読み替えません');
    }
    const nearMaximum = createDesign({ ...SAMPLE_INPUT, travelMm: 69 });
    const qualitative = interpretDesignRequest(nearMaximum, 'もっと遠く動かす');
    expect(qualitative.patch.travelMm).toBe(86); expect(qualitative.conflicts.join(' ')).toContain('86mm');
    expect(interpretDesignRequest(fixture(), '距離を2mm').conflicts).toEqual([]);
    expect(interpretDesignRequest(fixture(), '距離を70mm').conflicts).toEqual([]);
  });
  it('retains requested infeasible distances and distinctly labels bounded-search alternatives', () => {
    const result = buildDesignSuggestion(fixture(), '40mm動かす');
    expect(result.status).toBe('alternative'); expect(result.requestedPatch.travelMm).toBe(40); expect(result.document!.input.travelMm).toBeLessThan(40);
    expect(result.intent.summary.join(' ')).toContain('20→40mm'); expect(result.messages.join(' ')).toContain('代案');
  });
  it('distinguishes target に/へ amounts from bare increments and asks about reversed target trends', () => {
    for (const [request, kind, target] of [
      ['距離を15mmに減らして', 'absolute', 15], ['距離を15mm減らして', 'relative', 5],
      ['距離を25mmへ増やして', 'absolute', 25], ['距離を5mm増やして', 'relative', 25],
      ['2.5cmに長くして', 'absolute', 25], ['0.5cm長くして', 'relative', 25],
    ] as const) {
      const result = buildDesignSuggestion(fixture(), request);
      expect(result.status, request).toBe('ready'); expect(result.intent.interpretation.distance.kind).toBe(kind); expect(result.document!.input.travelMm).toBe(target);
    }
    for (const request of ['距離を5mmに増やして', '距離を25mmに減らして', 'あと5mmに増やして']) expect(buildDesignSuggestion(fixture(), request).status, request).toBe('clarify');
  });
  it('keeps a second movement subject separate from artwork or paper predicates without requiring punctuation', () => {
    for (const request of ['絵を大きくしないで動きを大きくする', '絵を大きくしないで動きを大きくして', '絵を大きくしない。動きを大きくする', '紙を増やさないで動きを大きくして']) {
      const result = buildDesignSuggestion(fixture(), request);
      expect(result.status, request).toBe('ready'); expect(result.document!.input.travelMm).toBe(25);
      expect(result.document!.input.widthMm).toBe(160); expect(result.document!.input.heightMm).toBe(110);
    }
    for (const request of ['回転させる必要はない。左へ動かして', '回転する必要がない。左へ動かして']) {
      const result = buildDesignSuggestion(fixture(), request); expect(result.intent.supported).toBe(true); expect(result.status).toBe('ready'); expect(result.document!.input.direction).toBe('left');
    }
    expect(buildDesignSuggestion(fixture(), '回転させる必要がある。左へ動かして').status).toBe('unsupported');
  });
  it('binds relative calculations and corrections to exact request text, identity, revision and hash', () => {
    const base = fixture(), request = 'あと5mm動かして', intent = interpretDesignRequest(base, request);
    const changed = applyDesignPatch(base, { travelMm: 21 });
    expect(() => applyIntentPatch(changed, {}, intent)).toThrow('基準');
    const differentIdentity = createDesign(base.input, { designId: 'other-design', revision: base.revision });
    expect(() => applyIntentPatch(differentIdentity, {}, intent)).toThrow('基準');
    const correction = { binding: intent.binding, distance: { kind: 'absolute' as const, value: 25, unit: 'mm' as const } };
    expect(() => buildDesignSuggestion(changed, request, correction)).toThrow('基準');
    expect(() => buildDesignSuggestion(base, `${request} `, correction)).toThrow('依頼');
    expect(() => buildDesignSuggestion(base, request, { ...correction, ignoredClauses: ['存在しない条件'] })).toThrow('訂正対象');
  });
  it('requires specific author approval for paper loosening while tighter limits and original locks stay enforced', () => {
    const base = fixture(), request = '紙は3枚まで増やしてよい';
    const pending = interpretDesignRequest(base, request);
    expect(pending.approvalRequired).toEqual({ key:'maxSheets',from:2,to:3 });
    expect(buildDesignSuggestion(base, request).status).toBe('clarify');
    expect(() => applyIntentPatch(base, {}, { ...pending, conflicts: [], approvalRequired: undefined, protections: { maxSheets: 3 } })).toThrow('厚紙は2枚');
    const correction = { binding: pending.binding, paperApproval: { from:2,to:3 } };
    const approved = buildDesignSuggestion(base, request, correction);
    expect(approved.status).toBe('ready'); expect(approved.document!.input.maxSheets).toBe(3);
    expect(interpretDesignRequest(base, request, { binding: pending.binding, paperApproval: { from:2,to:4 } }).conflicts.length).toBeGreaterThan(0);
    const locked = createDesign({ ...base.input, locks:['maxSheets','widthMm','heightMm','travelMm'] });
    const binding = getRequestBinding(locked, request);
    expect(buildDesignSuggestion(locked, request, {binding,paperApproval:{from:2,to:3}}).status).toBe('clarify');
    const tighter = buildDesignSuggestion(locked, '紙は1枚まで'); expect(tighter.document!.input.maxSheets).toBe(1); expect(tighter.document!.input.locks).toEqual(locked.input.locks);
    expect(buildDesignSuggestion(locked, 'あと5mm動かして').status).toBe('clarify');
    expect(InterpretationCorrectionSchema.safeParse({ ...correction, allowChange:true }).success).toBe(false);
  });
});

describe('structured model proposals are interpretations, never trusted constraints or permissions', () => {
  it('accepts a novel wording through the shared proposal without pretending the bounded parser understood it', () => {
    const base = fixture(), request = 'カメが遠くをのぞくようにして';
    expect(interpretDesignRequest(base, request).conflicts.length).toBeGreaterThan(0);
    const intent = interpretModelRequest(base, request, proposal({ distance:{kind:'qualitative',change:'increase'} }));
    expect(intent.conflicts).toEqual([]); expect(applyIntentPatch(base, {}, intent).input.travelMm).toBe(25);
  });
  it('rejects model erasure of clear relative/maintain/forbidden conditions and never invents unspecified changes', () => {
    const base=fixture();
    for(const [request, model] of [
      ['あと5mm動かす', proposal({distance:{kind:'absolute',value:5,unit:'mm'}})],
      ['距離を変えない。左に動かす', proposal({direction:{desired:'left',forbidden:[]},distance:{kind:'absolute',value:25,unit:'mm'}})],
      ['左には動かさず、右へ',proposal({direction:{desired:'right',forbidden:[]}})],
      ['25mm動かす',proposal({distance:{kind:'absolute',value:25,unit:'mm'},direction:{desired:'left',forbidden:[]}})],
      ['右へ動かす',proposal({direction:{desired:'right',forbidden:[]},distance:{kind:'relative',delta:5,unit:'mm'}})],
    ] as const){const intent=interpretModelRequest(base,request,model);expect(intent.conflicts.length,request).toBeGreaterThan(0);expect(()=>applyIntentPatch(base,{},intent)).toThrow();}
    const request='あと5mm動かす', wrong=proposal({distance:{kind:'absolute',value:5,unit:'mm'}}), intent=interpretModelRequest(base,request,wrong);
    const choice=intent.clarifications.find(q=>q.id==='model-distance')!.choices[0]!;
    const corrected=interpretModelRequest(base,request,wrong,{binding:intent.binding,...choice.changes});
    expect(corrected.conflicts).toEqual([]);expect(applyIntentPatch(base,{},corrected).input.travelMm).toBe(25);
  });
  it('does not erase unrepresentable speed, missing-unit conditions, unsupported mechanics or trusted paper limits', () => {
    const base=fixture();
    for(const request of ['右へ。速さも倍にして','右へゆっくり','右へ。2秒で戻る','あと5動かして']) {
      const intent=interpretModelRequest(base,request,proposal({direction:{desired:'right',forbidden:[]},distance:{kind:'relative',delta:5,unit:'mm'}}));
      expect(intent.conflicts.length,request).toBeGreaterThan(0);
    }
    expect(interpretModelRequest(base,'回転させたい',proposal()).supported).toBe(false);
    const negated = interpretModelRequest(base,'回転させず右へ',proposal({direction:{desired:'right',forbidden:[]},mechanism:'unsupported'}));
    expect(negated.supported).toBe(true); expect(negated.conflicts).toEqual([]);
    const model=proposal({paper:{kind:'cap',maxSheets:3}}), intent=interpretModelRequest(base,'紙は3枚まで増やしてよい',model);
    expect(intent.approvalRequired).toEqual({key:'maxSheets',from:2,to:3});expect(()=>applyIntentPatch(base,{},intent)).toThrow();
    expect(RequestInterpretationSchema.safeParse({...model,allowChange:true}).success).toBe(false);
    expect(RequestInterpretationSchema.safeParse({...model,paperApproval:{from:2,to:3}}).success).toBe(false);
    const noMore=interpretModelRequest(base,'紙は増やさない',model);expect(noMore.conflicts.length).toBeGreaterThan(0);expect(noMore.protections.maxSheets).toBe(1);
  });
});

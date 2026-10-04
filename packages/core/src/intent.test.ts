import { describe, expect, it } from 'vitest';
import { applyIntentPatch, buildDesignSuggestion, canExport, createDesign, createImageInput, getAssemblySteps, interpretDesignRequest, SAMPLE_INPUT } from './index.js';

describe('request-derived constraints and manual assistance (no model)', () => {
  it('preserves the existing paper budget by default without requiring the author to repeat it', () => {
    for (const maxSheets of [1, 2, 7]) {
      const base = createDesign({ ...SAMPLE_INPUT, maxSheets });
      const intent = interpretDesignRequest(base, 'もう少し大きく動かしたい');
      expect(intent.protections.maxSheets).toBe(maxSheets);
      expect(intent.patch.maxSheets).toBeUndefined();
      expect(() => applyIntentPatch(base, { travelMm: 25, maxSheets: maxSheets + 1 }, intent)).toThrow(`厚紙は${maxSheets}枚まで`);
      const candidate = applyIntentPatch(base, { travelMm: 25 }, intent);
      expect(candidate.input.maxSheets).toBe(maxSheets);
      expect(candidate.input.locks).toEqual(base.input.locks);
      expect(buildDesignSuggestion(base, 'もう少し大きく動かしたい').preserved.join(' ')).toContain(`A4 ${maxSheets}枚まで`);
      expect(() => applyIntentPatch(base, { maxSheets: maxSheets + 1 }, { ...intent, protections: {} })).toThrow(`厚紙は${maxSheets}枚まで`);
    }
  });
  it('allows an explicit new paper cap only when the existing budget is unlocked, preserving normal confirmation and tighter bounds', () => {
    const base = createDesign(SAMPLE_INPUT), intent = interpretDesignRequest(base, 'もう少し大きく動かしたい。厚紙はA4で3枚まで');
    expect(intent.conflicts).toEqual([]); expect(intent.protections.maxSheets).toBe(3);
    const candidate = applyIntentPatch(base, {}, intent);
    expect(candidate.input.maxSheets).toBe(3); expect(candidate.input.locks).toContain('maxSheets');
    expect(base.input.maxSheets).toBe(2); expect(base.input.locks).toEqual([]);
    expect(() => applyIntentPatch(base, { maxSheets: 4 }, intent)).toThrow('厚紙は3枚まで');
    const locked = createDesign({ ...SAMPLE_INPUT, locks: ['maxSheets'] });
    const blocked = interpretDesignRequest(locked, '厚紙はA4で3枚まで');
    expect(blocked.conflicts.length).toBeGreaterThan(0); expect(() => applyIntentPatch(locked, {}, blocked)).toThrow();
    const smaller = applyIntentPatch(locked, {}, interpretDesignRequest(locked, '厚紙はA4で1枚まで'));
    expect(smaller.input.maxSheets).toBe(1); expect(smaller.input.locks).toContain('maxSheets');
    expect(buildDesignSuggestion(base, 'もう少し大きく動かしたい。紙を増やして').status).toBe('clarify');
  });
  it('keeps original image/selection/scale through A–F, persists protections, and revises every dependent output', () => {
    const original = createDesign(SAMPLE_INPUT);
    const first = buildDesignSuggestion(original, '首を右に出したい。絵の大きさは保って、厚紙はA4で2枚まで');
    expect(first.status).toBe('ready');
    const accepted = first.document!;
    expect(accepted.input.locks).toEqual(expect.arrayContaining(['widthMm', 'heightMm', 'maxSheets']));
    const second = buildDesignSuggestion(accepted, 'もう少し大きく動かしたい。紙は増やさない');
    expect(second.status).toBe('ready');
    const changed = second.document!;
    expect(changed.input.travelMm).toBeGreaterThan(accepted.input.travelMm);
    expect(changed.input.image).toEqual(original.input.image);
    expect(changed.input.selection).toEqual(original.input.selection);
    expect(changed.artwork.placement).toEqual(original.artwork.placement);
    expect(changed.layout.sheets).toBeLessThanOrEqual(accepted.layout.sheets);
    expect(changed.input.maxSheets).toBe(accepted.layout.sheets);
    expect(changed.revision).toBe(accepted.revision + 1);
    expect(changed.checks.every(c => c.designHash === changed.designHash)).toBe(true);
    expect(getAssemblySteps(changed)).not.toEqual(getAssemblySteps(accepted));
    expect(original.input.travelMm).toBe(20); // Building/rejecting a candidate cannot mutate the base.
    expect(first.baseHash).toBe(original.designHash);
  });
  it('computes relative changes from different inputs and preserves artist scale for paraphrased requests', () => {
    for (const travelMm of [8, 12, 19, 23]) {
      const base = createDesign({ ...SAMPLE_INPUT, travelMm });
      for (const words of ['さらに遠くに動かしたい。サイズはそのまま。用紙を追加しない', '移動量を増やす。絵のサイズを変えず、枚数を増やしたくない', 'move further, keep image size, no more sheets']) {
        const proposal = buildDesignSuggestion(base, words);
        // At 23 mm the preferred +25% exceeds the slot limit; a clearly labelled
        // alternative may still increase actual travel without violating the artwork.
        expect(['ready', 'alternative']).toContain(proposal.status);
        expect(proposal.document!.input.travelMm).toBeGreaterThan(travelMm);
        expect(proposal.document!.artwork.placement).toEqual(base.artwork.placement);
        expect(proposal.document!.layout.sheets).toBeLessThanOrEqual(base.layout.sheets);
      }
    }
  });
  it('rejects model or caller attempts to shrink art, loosen sheets, change intended direction or reverse relative motion', () => {
    const base = createDesign(SAMPLE_INPUT);
    const intent = interpretDesignRequest(base, 'もっと大きく動かして右へ。絵の大きさは変えない。紙は増やさない');
    for (const patch of [{ widthMm: 150 }, { heightMm: 100 }, { maxSheets: 3 }, { travelMm: 15 }, { direction: 'left' as const }]) expect(() => applyIntentPatch(base, patch, intent)).toThrow();
    const candidate = applyIntentPatch(base, { travelMm: 24 }, intent);
    expect(candidate.input.maxSheets).toBe(1);
    expect(candidate.input.locks).toEqual(expect.arrayContaining(['widthMm', 'heightMm', 'maxSheets']));
    expect(canExport(candidate)).toBe(true);
  });
  it('offers an explicitly smaller feasible alternative, never pretends to satisfy impossible requested distance', () => {
    const base = createDesign(SAMPLE_INPUT);
    const proposal = buildDesignSuggestion(base, '距離を40mm。絵の大きさは固定、厚紙は1枚まで');
    expect(proposal.status).toBe('alternative');
    expect(proposal.requestedPatch.travelMm).toBe(40);
    expect(proposal.document!.input.travelMm).toBeLessThan(40);
    expect(proposal.messages.join(' ')).toContain('希望の40');
    expect(proposal.messages.join(' ')).toContain('切り込み');
    expect(proposal.document!.artwork.placement).toEqual(base.artwork.placement);
    expect(canExport(proposal.document!)).toBe(true);
    const atLimit = createDesign({ ...SAMPLE_INPUT, travelMm: 28, locks: ['widthMm', 'heightMm', 'maxSheets'] });
    const blocked = buildDesignSuggestion(atLimit, 'もっと大きく動かして。紙は増やさない');
    expect(blocked.status).toBe('blocked'); expect(blocked.document).toBeUndefined();
    expect(blocked.messages.join(' ')).toContain('すべての配置が不可能という意味ではありません');
  });
  it('asks for clarification instead of treating contradictions, negations or unsupported budgets as success', () => {
    const base = createDesign(SAMPLE_INPUT);
    for (const words of ['もっと大きく動かさないで', '紙を増やさない。紙を増やして', '絵の大きさは保つ。絵を縮小して', '右に出し、左に出す', '紙は12枚まで', '紙は0枚まで', '紙は2枚まで、3枚以内', '大きく動かして距離を10mm']) {
      const proposal = buildDesignSuggestion(base, words);
      expect(proposal.status, words).toBe('clarify'); expect(proposal.document, words).toBeUndefined();
    }
    expect(buildDesignSuggestion(base, '回転させたい').status).toBe('unsupported');
    expect(buildDesignSuggestion(base, '2か所を同時に動かす').status).toBe('unsupported');
    expect(buildDesignSuggestion(base, '回転はしない。右へ動かす。紙は2枚まで').status).toBe('ready');
    const paperOnly = interpretDesignRequest(base, 'no more sheets');
    expect(paperOnly.relativeTravel).toBeNull(); expect(paperOnly.patch.travelMm).toBeUndefined();
    expect(interpretDesignRequest(base, '紙の枚数を変更しない').protections.maxSheets).toBe(1);
    for (const phrase of ['絵は縮めたくない', '絵を小さくしない', '絵はそのまま']) expect(interpretDesignRequest(base, phrase).protections.widthMm).toBe(160);
    for (const phrase of ['紙を増やしていいわけじゃない', '絵の大きさは変えないと言ったけれど、今度は変えてもよい']) expect(buildDesignSuggestion(base, phrase).status).toBe('clarify');
  });
  it('preserves existing locked travel and uses input dimensions, not sample geometry, for uploads', () => {
    const base = createDesign({ ...SAMPLE_INPUT, locks: ['travelMm'] });
    expect(buildDesignSuggestion(base, 'もう少し大きく動かす').status).toBe('clarify');
    for (const [widthPx, heightPx] of [[640, 900], [900, 480], [1, 1]]) {
      const input = createImageInput({ id: 'developer-generated', widthPx: widthPx!, heightPx: heightPx!, mimeType: 'image/png' }, '開発者テスト');
      expect(input.selection.x + input.selection.width).toBeLessThanOrEqual(widthPx!);
      expect(input.selection.y + input.selection.height).toBeLessThanOrEqual(heightPx!);
      expect(() => createDesign(input)).not.toThrow();
      expect(input.selection).not.toEqual(SAMPLE_INPUT.selection);
    }
  });
});

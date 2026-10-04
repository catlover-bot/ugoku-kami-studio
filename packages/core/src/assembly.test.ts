import { describe, expect, it } from 'vitest';
import { applyDesignPatch, createDesign, getAssemblySteps, getFabricationChecks, getKitSummary, getMaterials, getPartPose, parseDesignDocument, SAMPLE_INPUT, type Direction, type Rect } from './index.js';
function designFor(direction: Direction) {
  return createDesign(direction === 'right' ? SAMPLE_INPUT : direction === 'left' ? { ...SAMPLE_INPUT, direction, selection: { x: 80, y: 170, width: 200, height: 160 } } : { ...SAMPLE_INPUT, direction, image: { ...SAMPLE_INPUT.image, widthPx: 550, heightPx: 800 }, widthMm: 110, heightMm: 160, selection: { x: 190, y: direction === 'up' ? 80 : 520, width: 160, height: 200 } });
}
const projected = (r: Rect, axis: { x: number; y: number }) => [r.x * axis.x + r.y * axis.y, (r.x + r.width) * axis.x + (r.y + r.height) * axis.y].sort((a, b) => a - b);

describe('fabrication kit invariants', () => {
  it('preserves Goal001 schema-1 canonical geometry and hash while deriving new checks', () => {
    const d = createDesign(SAMPLE_INPUT);
    expect(d.designHash).toBe('3787f166a6830f528043fd98dcc477258ca29d36b8aac4b5911700f04628ed31');
    const original = JSON.stringify(d);
    expect(getKitSummary(d).status).toBe('prototype');
    expect(getFabricationChecks(d).every(c => c.status === 'pass' && c.designHash === d.designHash)).toBe(true);
    expect(JSON.stringify(d)).toBe(original); expect(parseDesignDocument(JSON.parse(original))).toEqual(d);
  });
  it.each(['right', 'left', 'up', 'down'] as const)('keeps an accessible handle, both guides and stop contacts throughout %s motion', direction => {
    const d = designFor(direction), a = d.motion.axis;
    expect(d.checks.filter(c => c.status === 'fail')).toEqual([]);
    const base = projected(getPartPose(d, 'B1'), a);
    for (const position of [0, .01, 7.375, 19.99, 20]) {
      const tab = projected(getPartPose(d, 'T1', position), a);
      expect(tab[1]! - base[1]!).toBeGreaterThanOrEqual(18);
      for (const id of ['G1', 'G2']) {
        const guide = projected(getPartPose(d, id, position), a);
        expect(tab[0]!).toBeLessThanOrEqual(guide[0]!); expect(tab[1]!).toBeGreaterThanOrEqual(guide[1]!);
      }
      for (const part of d.parts) {
        const front = getPartPose(d, part.id, position), back = getPartPose(d, part.id, position, 'back');
        expect(front.x + back.x + front.width).toBeCloseTo(d.input.widthMm);
        expect(back.y).toBe(front.y); expect(back.width).toBe(front.width); expect(back.height).toBe(front.height);
      }
    }
    const s1 = projected(getPartPose(d, 'S1', 20), a), s2 = projected(getPartPose(d, 'S2', 0), a);
    const g1 = projected(getPartPose(d, 'G1'), a), g2 = projected(getPartPose(d, 'G2'), a);
    expect(s1[1]).toBeCloseTo(g1[0]!); expect(s2[0]).toBeCloseTo(g2[1]!);
    expect(getKitSummary(d).checks.find(c => c.id === 'physical-operation')?.status).toBe('unknown');
  });
  it('threads a bare tab before C1 and stops, and identifies opposite connector glue faces', () => {
    const d = designFor('up'), steps = getAssemblySteps(d), ids = new Set(d.parts.map(p => p.id));
    for (const step of steps) for (const id of [...step.partIds, ...step.beforePartIds, ...step.addedPartIds, ...step.afterPartIds]) expect(ids.has(id)).toBe(true);
    expect(steps[2]!.afterPartIds).toContain('T1');
    expect(steps[2]!.afterPartIds).not.toContain('C1'); expect(steps[2]!.afterPartIds).not.toContain('S1');
    expect(steps[3]!.beforePartIds).toEqual(steps[2]!.afterPartIds); expect(steps[3]!.addedPartIds).toEqual(['C1', 'M1']);
    expect(steps[4]!.addedPartIds).toEqual(['S1', 'S2']); expect(new Set(steps[4]!.afterPartIds)).toEqual(ids);
    expect(steps[3]!.glueInstructions.join(' ')).toContain('T1表示の裏'); expect(steps[3]!.glueInstructions.join(' ')).toContain('M1表示面');
    expect(getMaterials(d).find(m => m.name === '型紙から切る機構部品')?.quantity).toBe('8個');
    const next = applyDesignPatch(d, { travelMm: 15 });
    expect(getAssemblySteps(next)[5]!.description).toContain('0〜15 mm');
    expect(getKitSummary(next).checks.every(c => c.designHash === next.designHash)).toBe(true);
  });
});

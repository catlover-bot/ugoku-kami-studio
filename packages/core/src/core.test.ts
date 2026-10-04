import { describe, expect, it } from 'vitest';
import { applyDesignPatch, createDesign, DesignInputSchema, getAssemblySteps, mmToPt, parseDesignDocument, ptToMm, SAMPLE_INPUT, screenSelectionToPixels, selectionToMm, type DesignInput } from './index.js';
const sample = () => createDesign(SAMPLE_INPUT, { designId: 'test-design' });
const hasFailure = (input: DesignInput, id: string) => createDesign(input).checks.find(c => c.id === id)?.status === 'fail';
describe('deterministic pull-tab core', () => {
  it('rebuilds the same geometry, hash, print placements and checks from normalized inputs', () => {
    const a = sample(), b = createDesign({ ...SAMPLE_INPUT, title: `  ${SAMPLE_INPUT.title}  ` }, { designId: 'test-design' });
    expect(a).toEqual(b); expect(a.designHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parseDesignDocument(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(a.checks.filter(c => c.status === 'fail')).toEqual([]);
    expect(a.checks.find(c => c.id === 'physical-operation')?.status).toBe('unknown');
  });
  it('converts mm/pt without a printer-dependent scale and maps letterboxed screen selection to print', () => {
    expect(mmToPt(25.4)).toBe(72); expect(ptToMm(72)).toBe(25.4);
    expect(() => mmToPt(Infinity)).toThrow();
    const rect = screenSelectionToPixels({ x: 260, y: 197.5, width: 100, height: 80 }, { width: 400, height: 500 }, SAMPLE_INPUT.image);
    expect(rect).toEqual(SAMPLE_INPUT.selection);
    expect(selectionToMm({ ...SAMPLE_INPUT, selection: rect })).toEqual({ x: 104, y: 34, width: 40, height: 32 });
  });
  it('rejects non-finite dimensions, out-of-image selection, excess pixels, negative values and unknown keys', () => {
    for (const value of [NaN, Infinity, -1, 0, 71]) expect(() => createDesign({ ...SAMPLE_INPUT, travelMm: value })).toThrow();
    expect(() => createDesign({ ...SAMPLE_INPUT, widthMm: 261 })).toThrow();
    expect(() => createDesign({ ...SAMPLE_INPUT, selection: { x: 700, y: 0, width: 200, height: 30 } })).toThrow();
    expect(() => createDesign({ ...SAMPLE_INPUT, image: { ...SAMPLE_INPUT.image, widthPx: 8193 } })).toThrow();
    expect(() => createDesign({ ...SAMPLE_INPUT, image: { ...SAMPLE_INPUT.image, widthPx: 4000, heightPx: 4000 } })).toThrow();
    expect(() => DesignInputSchema.parse({ ...SAMPLE_INPUT, success: true })).toThrow();
  });
  it('rejects altered hashes, references, inspection claims, layout and unsupported versions', () => {
    for (const change of [(d: ReturnType<typeof sample>) => { d.designHash = '0'.repeat(64); }, (d: ReturnType<typeof sample>) => { d.parts[1]!.attachedTo = ['unknown']; }, (d: ReturnType<typeof sample>) => { d.checks.at(-1)!.status = 'pass'; }, (d: ReturnType<typeof sample>) => { d.layout.placements[0]!.xMm = 0; }]) {
      const doc = sample(); change(doc); expect(() => parseDesignDocument(doc)).toThrow();
    }
    expect(() => parseDesignDocument({ ...sample(), schemaVersion: 2 })).toThrow();
  });
  it('invalidates revision and hash for travel, image, selection and lock edits; rejects locked patches', () => {
    const doc = sample(); const next = applyDesignPatch(doc, { travelMm: 15 });
    expect(next.revision).toBe(2); expect(next.designId).toBe(doc.designId); expect(next.designHash).not.toBe(doc.designHash);
    expect(next.checks.every(c => c.designHash === next.designHash)).toBe(true);
    expect(applyDesignPatch(doc, { travelMm: 20 })).toEqual(doc);
    expect(createDesign({ ...SAMPLE_INPUT, image: { ...SAMPLE_INPUT.image, id: 'replacement' } }).designHash).not.toBe(doc.designHash);
    expect(applyDesignPatch(doc, { selection: { ...SAMPLE_INPUT.selection, x: 500 } }).designHash).not.toBe(doc.designHash);
    const locked = createDesign({ ...SAMPLE_INPUT, locks: ['travelMm', 'selection'] });
    expect(() => applyDesignPatch(locked, { travelMm: 21 })).toThrow(/固定/);
    expect(() => applyDesignPatch(locked, { selection: { ...SAMPLE_INPUT.selection, x: 500 } })).toThrow(/固定/);
    expect(() => applyDesignPatch(locked, { locks: [] } as never)).toThrow();
    const materialLocked = createDesign({ ...SAMPLE_INPUT, locks: ['paperThicknessMm', 'clearanceMm'] });
    expect(() => applyDesignPatch(materialLocked, { paperThicknessMm: 0.3 })).toThrow(/固定/);
    expect(() => applyDesignPatch(materialLocked, { clearanceMm: 1 })).toThrow(/固定/);
    expect(applyDesignPatch(materialLocked, { travelMm: 15 }).input.travelMm).toBe(15);
    expect(applyDesignPatch(materialLocked, { paperThicknessMm: SAMPLE_INPUT.paperThicknessMm, clearanceMm: SAMPLE_INPUT.clearanceMm })).toEqual(materialLocked);
  });
  it('checks the whole travel interval and exact endpoint contact for both stops', () => {
    const d = sample(), tab = d.parts.find(p => p.id === 'T1')!, g1 = d.parts.find(p => p.id === 'G1')!, g2 = d.parts.find(p => p.id === 'G2')!, s1 = d.parts.find(p => p.id === 'S1')!, s2 = d.parts.find(p => p.id === 'S2')!;
    for (const travel of [0, .125, 10, 19.875, 20]) {
      expect(tab.assembly.x + travel).toBeLessThanOrEqual(g1.assembly.x);
      expect(tab.assembly.x + tab.assembly.width + travel).toBeGreaterThanOrEqual(g2.assembly.x + g2.assembly.width);
    }
    expect(s1.assembly.x + s1.assembly.width + 20).toBeCloseTo(g1.assembly.x);
    expect(s2.assembly.x).toBeCloseTo(g2.assembly.x + g2.assembly.width);
    expect(d.checks.find(c => c.id === 'guide-engagement')?.scope).toMatch(/連続区間/);
  });
  it('passes aligned mirrored and vertical designs, and rejects uncontained slots or too-small artwork', () => {
    const left = { ...SAMPLE_INPUT, direction: 'left' as const, selection: { x: 80, y: 170, width: 200, height: 160 } };
    const down = { ...SAMPLE_INPUT, image: { ...SAMPLE_INPUT.image, widthPx: 550, heightPx: 800 }, widthMm: 110, heightMm: 160, direction: 'down' as const, selection: { x: 170, y: 520, width: 160, height: 200 } };
    const up = { ...down, direction: 'up' as const, selection: { ...down.selection, y: 80 } };
    for (const input of [left, down, up]) expect(createDesign(input).checks.filter(c => c.status === 'fail')).toEqual([]);
    expect(hasFailure({ ...SAMPLE_INPUT, travelMm: 28 }, 'slot-contained')).toBe(false);
    expect(hasFailure({ ...SAMPLE_INPUT, travelMm: 28.001 }, 'slot-contained')).toBe(true);
    expect(hasFailure({ ...SAMPLE_INPUT, travelMm: 70 }, 'slot-contained')).toBe(true);
    expect(hasFailure({ ...SAMPLE_INPUT, selection: { x: 600, y: 200, width: 20, height: 20 } }, 'part-dimensions')).toBe(true);
  });
  it('counts all mechanism parts and detects oversized A4 parts and sheet budget failures', () => {
    const d = sample(); expect(d.parts).toHaveLength(8); expect(d.layout.placements).toHaveLength(8);
    const ids = new Set(d.parts.map(p => p.id));
    expect(new Set(getAssemblySteps(d).flatMap(s => s.partIds))).toEqual(ids);
    for (const p of d.parts) expect(p.attachedTo.every(id => ids.has(id))).toBe(true);
    expect(hasFailure({ ...SAMPLE_INPUT, widthMm: 260, heightMm: 260 }, 'page-fit')).toBe(true);
    const big = createDesign({ ...SAMPLE_INPUT, widthMm: 190, heightMm: 220, maxSheets: 1 });
    expect(big.layout.sheets).toBeGreaterThan(1); expect(big.checks.find(c => c.id === 'sheet-budget')?.status).toBe('fail');
    for (const a of d.layout.placements) {
      const part = d.parts.find(p => p.id === a.partId)!; const width = a.rotated ? part.heightMm : part.widthMm, height = a.rotated ? part.widthMm : part.heightMm;
      expect(a.xMm).toBeGreaterThanOrEqual(10); expect(a.yMm).toBeGreaterThanOrEqual(35); expect(a.xMm + width).toBeLessThanOrEqual(200); expect(a.yMm + height).toBeLessThanOrEqual(272);
      for (const b of d.layout.placements.filter(b => b.partId !== a.partId && b.page === a.page)) {
        const p = d.parts.find(p => p.id === b.partId)!; const bw = b.rotated ? p.heightMm : p.widthMm, bh = b.rotated ? p.widthMm : p.heightMm;
        expect(a.xMm + width <= b.xMm || b.xMm + bw <= a.xMm || a.yMm + height <= b.yMm || b.yMm + bh <= a.yMm).toBe(true);
      }
    }
  });
});

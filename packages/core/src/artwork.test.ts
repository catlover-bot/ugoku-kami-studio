import { describe, expect, it } from 'vitest';
import { applyArtworkRepair, applyDesignPatch, createDesign, DesignInputSchema, DesignPatchSchema, getArtworkComposition, parseDesignDocument, SAMPLE_INPUT } from './index.js';

describe('versioned author-chosen artwork treatment', () => {
  it('preserves the exact v1 hash and upgrades only an explicit repair adoption', () => {
    const old = createDesign(SAMPLE_INPUT), serialized = JSON.stringify(old);
    expect(old.schemaVersion).toBe(1);
    expect(old.designHash).toBe('3787f166a6830f528043fd98dcc477258ca29d36b8aac4b5911700f04628ed31');
    expect(JSON.stringify(parseDesignDocument(JSON.parse(serialized)))).toBe(serialized);
    expect(old.input).not.toHaveProperty('artworkRepair');
    const next = applyArtworkRepair(old, { mode: 'solid', color: '#E2Ac74' });
    expect(next.schemaVersion).toBe(2); expect(next.revision).toBe(old.revision + 1);
    expect(next.designId).toBe(old.designId); expect(next.designHash).not.toBe(old.designHash);
    expect(next.parts).toEqual(old.parts); expect(next.layout).toEqual(old.layout);
    expect(next.input.artworkRepair).toEqual({ mode: 'solid', color: '#e2ac74' });
    expect(next.checks.every(check => check.designHash === next.designHash)).toBe(true);
    expect(next.physicalValidation).toBe('unverified');
    expect(JSON.stringify(old)).toBe(serialized);
    expect(parseDesignDocument(JSON.parse(JSON.stringify(next)))).toEqual(next);
    expect(applyArtworkRepair(next, { mode: 'solid', color: '#E2AC74' })).toEqual(next);
    const white = applyArtworkRepair(next, { mode: 'white' });
    expect(white.schemaVersion).toBe(2); expect(white.revision).toBe(3);
    expect(white.designHash).not.toBe(old.designHash);
  });
  it('keeps repairs through normal edits but excludes them from AI patch authority', () => {
    const next = applyArtworkRepair(createDesign(SAMPLE_INPUT), { mode: 'solid', color: '#ff0000' });
    const resized = applyDesignPatch(next, { widthMm: 170 });
    expect(resized.schemaVersion).toBe(2); expect(resized.input.artworkRepair).toEqual(next.input.artworkRepair);
    expect(resized.designHash).not.toBe(next.designHash);
    expect(() => DesignPatchSchema.parse({ artworkRepair: { mode: 'white' } })).toThrow();
    expect(() => applyArtworkRepair(next, { mode: 'solid', color: 'url(https://example.test)' })).toThrow();
    expect(() => applyArtworkRepair(next, { mode: 'image', image: SAMPLE_INPUT.image })).toThrow(/SHA-256/);
    expect(() => DesignInputSchema.parse({ ...SAMPLE_INPUT, artworkRepair: { mode: 'solid', color: '#ffffff', success: true } })).toThrow();
  });
  it('uses a shared centered cover placement, source crop, and opaque rectangular paper', () => {
    const legacy = getArtworkComposition(createDesign(SAMPLE_INPUT));
    expect(legacy.fixedMask).toEqual({ rect: { x: 104, y: 34, width: 40, height: 32 }, color: '#ffffff' });
    expect(legacy.movingPaper).toEqual(legacy.fixedMask.rect); expect(legacy.background).toBeNull();
    const next = applyArtworkRepair(createDesign(SAMPLE_INPUT), { mode: 'image', image: { id: 'a'.repeat(64), widthPx: 1000, heightPx: 500, mimeType: 'image/png' } });
    const result = getArtworkComposition(next);
    expect(result.source).toEqual({ x: 0, y: 0, width: 160, height: 110 });
    expect(result.background?.placement).toEqual({ x: -30, y: 0, width: 220, height: 110 });
    expect(result.background?.clip).toEqual(result.fixedMask.rect);
    expect(result.movingPaper).toEqual(legacy.movingPaper);
    expect(next.artwork.mask).toBe('image-rectangle');
  });
  it('rejects false version upgrades and modified treatment, metadata, or resulting geometry', () => {
    const old = createDesign(SAMPLE_INPUT);
    expect(() => parseDesignDocument({ ...old, schemaVersion: 2 })).toThrow(/不一致/);
    const next = applyArtworkRepair(old, { mode: 'solid', color: '#123456' });
    expect(() => parseDesignDocument({ ...next, schemaVersion: 1 })).toThrow(/不一致/);
    expect(() => parseDesignDocument({ ...next, input: { ...next.input, artworkRepair: { mode: 'white' } } })).toThrow(/不一致/);
    expect(() => parseDesignDocument({ ...next, artwork: { ...next.artwork, mask: 'white-rectangle' } })).toThrow(/不一致/);
  });
});

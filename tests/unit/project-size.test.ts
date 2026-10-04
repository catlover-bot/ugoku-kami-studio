import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createDesign, SAMPLE_INPUT } from '@ugoku/core';
import { assertProjectByteLength, MAX_IMAGE_BYTES, MAX_PROJECT_BYTES, parseProject, physicalRecordSchema, serializeProject, type PhysicalRecord, type Project } from '../../apps/web/src/project.js';

let base: Project;
beforeAll(async () => {
  const png = await sharp({ create: { width: 800, height: 550, channels: 3, background: '#ffffff' } }).png().toBuffer();
  base = {
    document: createDesign({ ...SAMPLE_INPUT, image: { ...SAMPLE_INPUT.image, id: createHash('sha256').update(png).digest('hex') } }),
    imageDataUrl: `data:image/png;base64,${png.toString('base64')}`,
    records: [],
  };
});

function record(index: number, photos: string[] = []): PhysicalRecord {
  return physicalRecordSchema.parse({
    id: `developer-record-${index}`, designId: base.document.designId, designHash: base.document.designHash,
    revision: base.document.revision, pattern: `${base.document.designId}-r${base.document.revision}.pdf`,
    material: '', printScale: '', measuredLine: '', modifications: '', movement: '', photos,
  });
}

describe('project save/load capacity', () => {
  it('allows the byte limit inclusively and rejects the next byte', () => {
    expect(MAX_PROJECT_BYTES).toBe(45_000_000);
    for (const bytes of [0, MAX_PROJECT_BYTES - 1, MAX_PROJECT_BYTES]) expect(() => assertProjectByteLength(bytes)).not.toThrow();
    expect(() => assertProjectByteLength(MAX_PROJECT_BYTES + 1)).toThrow(/45MB/);
  });

  it('rejects oversized UTF-8 before JSON parsing or any browser image decoding', async () => {
    // Deliberately not JSON: parsing first would produce a syntax error instead
    // of the useful size error. Japanese characters use three UTF-8 bytes each.
    const text = 'あ'.repeat(Math.floor(MAX_PROJECT_BYTES / 3) + 1);
    expect(text.length).toBeLessThan(MAX_PROJECT_BYTES);
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(MAX_PROJECT_BYTES);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      await expect(parseProject(text)).rejects.toThrow(/45MB/);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });

  it('serializes 100 valid records but rejects 101 without modifying either project', () => {
    const project = { ...base, records: Array.from({ length: 100 }, (_, index) => record(index)) };
    const before = structuredClone(project);
    const saved = JSON.parse(serializeProject(project));
    expect(saved.records).toHaveLength(100);
    expect(saved.document).toEqual(project.document);
    expect(saved.imageDataUrl).toBe(project.imageDataUrl);
    expect(project).toEqual(before);

    const tooMany = { ...project, records: [...project.records, record(100)] };
    const beforeRejected = structuredClone(tooMany);
    expect(() => serializeProject(tooMany)).toThrow();
    expect(tooMany).toEqual(beforeRejected);
    expect(project).toEqual(before);
  });

  it('rejects a roughly 50 MB project containing twelve individually valid PNG photos', async () => {
    const width = 1100, height = 950, pixels = Buffer.alloc(width * height * 3);
    // Developer-generated deterministic noise is a valid, poorly compressible
    // photograph-sized raster. No private fixture or padded fake PNG is used.
    let state = 0x1f2e3d4c;
    for (let index = 0; index < pixels.length; index++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      pixels[index] = state & 255;
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
    expect(png.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(await sharp(png).metadata()).toMatchObject({ format: 'png', width, height });
    const photo = `data:image/png;base64,${png.toString('base64')}`;
    const project = { ...base, records: Array.from({ length: 3 }, (_, index) => record(index, [photo, photo, photo, photo])) };
    expect(project.records.flatMap(item => item.photos)).toHaveLength(12);
    const envelope = JSON.stringify({ format: 'ugoku-kami-project', version: 2, ...project });
    expect(Buffer.byteLength(envelope, 'utf8')).toBeGreaterThan(50_000_000);
    expect(() => serializeProject(project)).toThrow(/45MB/);
    expect(project.records.every(item => item.photos.length === 4 && item.photos.every(image => image === photo))).toBe(true);
  });
});

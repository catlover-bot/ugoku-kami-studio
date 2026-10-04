import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFDict, PDFName, PDFRawStream } from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import sharp from 'sharp';
import { applyArtworkRepair, createDesign, SAMPLE_INPUT } from '@ugoku/core';
import { generatePdf, generateSvg } from './index.js';

const sha = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
const url = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
async function fixtures() {
  const background = await sharp({ create: { width: 800, height: 550, channels: 3, background: '#287c90' } }).composite([{ input: Buffer.from('<svg width="800" height="550"><path d="M0 170H800V190H0Z" fill="#f3b55e"/></svg>') }]).png().toBuffer();
  const original = await sharp(background).composite([{ input: Buffer.from('<svg width="800" height="550"><rect x="550" y="200" width="100" height="100" fill="#d13030"/></svg>') }]).png().toBuffer();
  const doc = createDesign({ ...SAMPLE_INPUT, image: { ...SAMPLE_INPUT.image, id: sha(original) } });
  const next = applyArtworkRepair(doc, { mode: 'image', image: { id: sha(background), widthPx: 800, heightPx: 550, mimeType: 'image/png' } });
  return { doc, next, original, background, options: { imageDataUrl: url(original), backgroundImageDataUrl: url(background) } };
}

describe('printed artwork repairs and paper opacity', () => {
  it('prints supplied patterned background at the original coordinates and preserves the moving source crop', async () => {
    const { next, background, options } = await fixtures();
    const unchanged = JSON.stringify(next);
    const svg = generateSvg(next, 1, options);
    expect(JSON.stringify(next)).toBe(unchanged);
    expect(svg).toContain('id="paper-composite-B1" filterUnits="userSpaceOnUse" x="0" y="0" width="160" height="110" color-interpolation-filters="sRGB"');
    expect(svg).toContain('id="paper-composite-M1" filterUnits="userSpaceOnUse" x="-104" y="-34" width="160" height="110" color-interpolation-filters="sRGB"');
    expect(svg).toContain('<feOffset dx="0" dy="0"/>');
    expect(svg).toContain('data-artwork="background"'); expect(svg).toContain('clip-path="url(#repair-B1)"');
    const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (xMm: number, yMm: number) => {
      const offset = (Math.round(yMm * info.height / 297) * info.width + Math.round(xMm * info.width / 210)) * 3;
      return Array.from(data.subarray(offset, offset + 3));
    };
    const base = next.layout.placements.find(p => p.partId === 'B1')!, moving = next.layout.placements.find(p => p.partId === 'M1')!;
    expect(pixel(base.xMm + 110, base.yMm + 36)).toEqual([243, 181, 94]); // stripe extends through former red artwork
    expect(pixel(base.xMm + 110, base.yMm + 42)).toEqual([40, 124, 144]);
    expect(pixel(moving.xMm + 10, moving.yMm + 10)).toEqual([209, 48, 48]);
    const edgeX = Math.floor((base.xMm + next.artwork.selectionMm.x + next.artwork.selectionMm.width) * info.width / 210);
    const edgeY = Math.round((base.yMm + 60) * info.height / 297);
    for (let x = edgeX - 2; x <= edgeX + 2; x++) expect(Array.from(data.subarray((edgeY * info.width + x) * 3, (edgeY * info.width + x) * 3 + 3))).toEqual([40, 124, 144]);
    const pdf = await PDFDocument.load(await generatePdf(next, options));
    const expected = sha(await sharp(background).removeAlpha().raw().toBuffer());
    const embedded: string[] = [], isolated: boolean[] = [];
    const inspect = (resources: PDFDict) => {
      const objects = resources.lookup(PDFName.of('XObject'), PDFDict);
      for (const [, ref] of objects.entries()) {
        const stream = pdf.context.lookup(ref);
        if (!(stream instanceof PDFRawStream)) continue;
        if (stream.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') embedded.push(sha(inflateSync(stream.getContents())));
        else if (stream.dict.get(PDFName.of('Subtype'))?.toString() === '/Form') {
          isolated.push(stream.dict.lookup(PDFName.of('Group'), PDFDict).get(PDFName.of('I'))?.toString() === 'true');
          inspect(stream.dict.lookup(PDFName.of('Resources'), PDFDict));
        }
      }
    };
    inspect(pdf.getPages()[0]!.node.Resources()!);
    expect(embedded).toContain(expected); // both output formats use exactly the same uploaded pixels
    expect(isolated).toContain(true); // paper and background must share one clip, avoiding pale edge seams
    expect(pdf.getPageCount()).toBe(next.layout.sheets + 4);
    expect(pdf.getSubject()).toContain(next.designHash);
  });
  it('requires matching background bytes, type, and pixel dimensions for both SVG and PDF', async () => {
    const { next, original, options } = await fixtures();
    expect(() => generateSvg(next, 1, { imageDataUrl: options.imageDataUrl })).toThrow(/背景画像がありません/);
    await expect(generatePdf(next, { imageDataUrl: options.imageDataUrl })).rejects.toThrow(/背景画像がありません/);
    expect(() => generateSvg(next, 1, { ...options, backgroundImageDataUrl: url(original) })).toThrow(/画像ハッシュ/);
    await expect(generatePdf(next, { ...options, backgroundImageDataUrl: url(original) })).rejects.toThrow(/画像ハッシュ/);
    const repair = next.input.artworkRepair!;
    if (repair.mode !== 'image') throw new Error('Expected image repair');
    const wrongSize = applyArtworkRepair(next, { ...repair, image: { ...repair.image, widthPx: 799 } });
    expect(() => generateSvg(wrongSize, 1, options)).toThrow(/画素寸法/);
    await expect(generatePdf(wrongSize, options)).rejects.toThrow(/画素寸法/);
    expect(() => generateSvg(next, 1, { ...options, backgroundImageDataUrl: options.backgroundImageDataUrl.replace('image/png', 'image/jpeg') })).toThrow(/種類/);
  });
  it('prints solid repair only on B1 and gives transparent M1 its real opaque white paper', async () => {
    const transparent = await sharp({ create: { width: 800, height: 550, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: Buffer.from('<svg width="800" height="550"><rect x="570" y="200" width="40" height="40" fill="#ff0000"/></svg>') }]).png().toBuffer();
    const doc = applyArtworkRepair(createDesign({ ...SAMPLE_INPUT, image: { ...SAMPLE_INPUT.image, id: sha(transparent) } }), { mode: 'solid', color: '#287c90' });
    const svg = generateSvg(doc, 1, { imageDataUrl: url(transparent) });
    expect(svg).toContain('data-paper="M1" width="40" height="32" fill="white"');
    expect(svg).toContain('<g clip-path="url(#crop-M1)" filter="url(#paper-composite-M1)" style="isolation:isolate"><rect data-paper="M1"');
    expect(svg).toContain('x="104" y="34" width="40" height="32" fill="#287c90"');
    const b1 = svg.match(/<g data-part-id="B1"[\s\S]*?<\/g>/)![0], m1 = svg.match(/<g data-part-id="M1"[\s\S]*?<\/g>/)![0];
    expect(b1).not.toContain('paint-order="stroke">B1'); expect(m1).not.toContain('paint-order="stroke">M1');
    const pdf = await PDFDocument.load(await generatePdf(doc, { imageDataUrl: url(transparent) }));
    expect(pdf.getPageCount()).toBe(doc.layout.sheets + 4);
    const objects = pdf.getPages()[0]!.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const movingPaper = objects.entries().map(([, ref]) => pdf.context.lookup(ref)).find((stream): stream is PDFRawStream => stream instanceof PDFRawStream && stream.dict.get(PDFName.of('Subtype'))?.toString() === '/Form');
    expect(movingPaper).toBeDefined();
    expect(movingPaper!.dict.lookup(PDFName.of('Group'), PDFDict).get(PDFName.of('I'))?.toString()).toBe('true');
    expect(new TextDecoder().decode(inflateSync(movingPaper!.getContents()))).toContain('1 1 1 rg');
  });
});

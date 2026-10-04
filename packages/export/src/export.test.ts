import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFDict, PDFName, PDFRawStream } from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createDesign, SAMPLE_INPUT, mmToPt, applyDesignPatch } from '@ugoku/core';
import { generatePdf, generateSvg, generateAssemblySvg, getAssemblySteps, ORIGINAL_SAMPLE_SVG, SAMPLE_PNG_DATA_URL } from './index.js';

describe('actual-size exports', () => {
  it('exports real A4 PDF pages including every part and separate generated instruction pages', async () => {
    const doc = createDesign(SAMPLE_INPUT); const bytes = await generatePdf(doc); const pdf = await PDFDocument.load(bytes);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(pdf.getPageCount()).toBe(doc.layout.sheets + 4);
    for (const page of pdf.getPages()) { expect(page.getWidth()).toBeCloseTo(mmToPt(210), 8); expect(page.getHeight()).toBeCloseTo(mmToPt(297), 8); }
    const svg = generateSvg(doc);
    expect(svg).toContain('width="210mm" height="297mm" viewBox="0 0 210 297"');
    expect(svg).toContain('M10 283H60');
    for (const part of doc.parts) expect(svg).toContain(`>${part.id}</text>`);
    expect(getAssemblySteps(doc).flatMap(s => s.partIds)).toContain('C1');
    expect(svg).toContain('width="160" height="110"');
  });
  it('uses the exact same original sample pixels in the app, SVG and default PDF', async () => {
    expect(ORIGINAL_SAMPLE_SVG).toBe(await readFile(new URL('../../../apps/web/public/turtle.svg', import.meta.url), 'utf8'));
    const png = Buffer.from(SAMPLE_PNG_DATA_URL.split(',')[1]!, 'base64');
    const sourcePixels = await sharp(Buffer.from(ORIGINAL_SAMPLE_SVG)).removeAlpha().raw().toBuffer();
    expect(bytesToHex(sha256(await sharp(png).removeAlpha().raw().toBuffer()))).toBe(bytesToHex(sha256(sourcePixels)));
    const d = createDesign(SAMPLE_INPUT);
    expect(generateSvg(d)).toContain(`href="${SAMPLE_PNG_DATA_URL}"`);
    const pdf = await PDFDocument.load(await generatePdf(d));
    const images = pdf.getPages()[0]!.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const stream = pdf.context.lookup(images.entries()[0]![1]);
    if (!(stream instanceof PDFRawStream)) throw new Error('Embedded sample image stream is missing');
    expect(stream.dict.get(PDFName.of('Subtype'))?.toString()).toBe('/Image');
    expect(stream.dict.get(PDFName.of('Width'))?.toString()).toBe('800');
    expect(stream.dict.get(PDFName.of('Height'))?.toString()).toBe('550');
    expect(bytesToHex(sha256(inflateSync(stream.getContents())))).toBe(bytesToHex(sha256(sourcePixels)));
  });
  it('marks output as prototype and shows old/new assembly parts from the same revision', async () => {
    const d = createDesign(SAMPLE_INPUT), next = applyDesignPatch(d, { travelMm: 15 });
    expect(generateSvg(d)).toContain('PROTOTYPE');
    expect((await PDFDocument.load(await generatePdf(d))).getSubject()).toContain('PROTOTYPE');
    const beforeC1 = generateAssemblySvg(d, 3), afterC1 = generateAssemblySvg(d, 4);
    expect(beforeC1).toContain(`data-design-hash="${d.designHash}"`);
    expect(beforeC1).not.toContain('data-part-id="C1"');
    expect(afterC1).toContain('data-part-id="C1" data-stage="after" data-added="true"');
    expect(afterC1).toContain('data-part-id="G1" data-stage="before" data-added="false"');
    expect(generateAssemblySvg(d, 5)).toContain('data-part-id="S1" data-stage="after" data-added="true"');
    expect(generateAssemblySvg(next, 6)).toContain('END / 15 mm');
    expect(generateAssemblySvg(next, 6)).toContain(`data-design-hash="${next.designHash}" data-revision="2"`);
  });
  it('embeds actual user artwork, crops exact source selection, and masks the original region', async () => {
    const doc = createDesign(SAMPLE_INPUT);
    const png = await sharp({ create: { width: 800, height: 550, channels: 3, background: '#bd173f' } }).png().toBuffer();
    const imageDataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const svg = generateSvg(doc, 1, { imageDataUrl });
    expect(svg).toContain(imageDataUrl); expect(svg).toContain('x="104" y="34" width="40" height="32" fill="white"');
    expect(svg).toContain('x="-104" y="-34" width="160" height="110"');
    const bytes = await generatePdf(doc, { imageDataUrl }); const pdf = await PDFDocument.load(bytes);
    const names = pdf.getPages()[0]!.node.Resources()?.toString() ?? '';
    expect(names).toContain('/Image');
  });
  it('binds supplied image bytes and dimensions to their design, with no fallback for missing uploads', async () => {
    const png = await sharp({ create: { width: 800, height: 550, channels: 3, background: 'red' } }).png().toBuffer();
    const doc = createDesign({ ...SAMPLE_INPUT, image: { ...SAMPLE_INPUT.image, id: bytesToHex(sha256(png)) } });
    const imageDataUrl = `data:image/png;base64,${png.toString('base64')}`;
    expect(() => generateSvg(doc)).toThrow(/元画像/);
    expect(generateSvg(doc, 1, { imageDataUrl })).toContain(imageDataUrl);
    const other = await sharp({ create: { width: 800, height: 550, channels: 3, background: 'blue' } }).png().toBuffer();
    expect(() => generateSvg(doc, 1, { imageDataUrl: `data:image/png;base64,${other.toString('base64')}` })).toThrow(/画像ハッシュ/);
    const wrongSize = createDesign({ ...SAMPLE_INPUT, image: { ...SAMPLE_INPUT.image, widthPx: 801 } });
    await expect(generatePdf(wrongSize, { imageDataUrl })).rejects.toThrow(/画素寸法/);
  });
  it('rejects failing, tampered, external image and invalid page exports, and uses changed revision', async () => {
    const doc = createDesign(SAMPLE_INPUT), bad = applyDesignPatch(doc, { travelMm: 70 });
    expect(() => generateSvg(bad)).toThrow(/条件違反/); await expect(generatePdf(bad)).rejects.toThrow(/条件違反/);
    expect(() => generateSvg(doc, 0)).toThrow(); expect(() => generateSvg(doc, 1, { imageDataUrl: 'https://example.com/image.png' })).toThrow();
    const next = applyDesignPatch(doc, { travelMm: 15 });
    expect(generateSvg(next)).toContain('revision 2'); expect(generateSvg(next)).not.toBe(generateSvg(doc));
    doc.checks[0]!.status = 'fail'; expect(() => generateSvg(doc)).toThrow(/不一致/);
  });
});

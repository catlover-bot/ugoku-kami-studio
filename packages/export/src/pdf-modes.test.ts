import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, type PDFPage } from 'pdf-lib';
import { createDesign, mmToPt, SAMPLE_INPUT } from '@ugoku/core';
import { generatePdf, INSTRUCTION_PAGE_COUNT, type PdfMode } from './index.js';

/** Compare actual PDF drawing commands, keeping all scale and position operands. */
function pageContents(page: PDFPage): string {
  const value = page.node.Contents();
  const streams = value instanceof PDFArray ? value.asArray().map(ref => page.doc.context.lookup(ref)) : [value];
  return streams.map(stream => {
    if (!(stream instanceof PDFRawStream)) throw new Error('Expected a PDF content stream');
    const bytes = stream.dict.get(PDFName.of('Filter'))?.toString() === '/FlateDecode' ? inflateSync(stream.getContents()) : stream.getContents();
    return new TextDecoder().decode(bytes);
  }).join('\n');
}

describe('PDF sections from the same generated pages', () => {
  it.each([false, true])('keeps default output, scale, order, identity and page contents (rotated multi-sheet: %s)', async multiSheet => {
    const doc = createDesign({ ...SAMPLE_INPUT, ...(multiSheet ? { widthMm: 220, heightMm: 160 } : {}) }, { designId: 'pdf-mode-test', revision: 7 });
    if (multiSheet) { expect(doc.layout.sheets).toBeGreaterThan(1); expect(doc.layout.placements.some(placement => placement.rotated)).toBe(true); }
    const unchanged = JSON.stringify(doc);
    const [defaultPdf, all, pattern, instructions] = await Promise.all([undefined, 'all', 'pattern', 'instructions'].map(async mode => PDFDocument.load(await generatePdf(doc, { mode: mode as PdfMode | undefined }))));
    expect(defaultPdf!.getPageCount()).toBe(doc.layout.sheets + INSTRUCTION_PAGE_COUNT);
    expect(all!.getPageCount()).toBe(defaultPdf!.getPageCount());
    expect(pattern!.getPageCount()).toBe(doc.layout.sheets);
    expect(instructions!.getPageCount()).toBe(INSTRUCTION_PAGE_COUNT);
    const allContents = all!.getPages().map(pageContents);
    expect(defaultPdf!.getPages().map(pageContents)).toEqual(allContents);
    expect(pattern!.getPages().map(pageContents)).toEqual(allContents.slice(0, doc.layout.sheets));
    expect(instructions!.getPages().map(pageContents)).toEqual(allContents.slice(doc.layout.sheets));
    for (const pdf of [defaultPdf!, all!, pattern!, instructions!]) {
      expect(pdf.getTitle()).toBe(`${doc.designId} revision ${doc.revision}`);
      expect(pdf.getSubject()).toContain(doc.designHash);
      expect(pdf.getSubject()).toContain('physically unverified');
      for (const page of pdf.getPages()) {
        expect(page.getWidth()).toBeCloseTo(mmToPt(210), 8);
        expect(page.getHeight()).toBeCloseTo(mmToPt(297), 8);
        expect(page.getRotation().angle).toBe(0);
      }
    }
    expect(pattern!.getSubject()).toContain('PDF mode: pattern');
    expect(instructions!.getSubject()).toContain('PDF mode: instructions');
    // Instruction pages need vectors and fonts, not an orphaned embedded copy
    // of the source artwork hidden in their object table.
    expect(instructions!.context.enumerateIndirectObjects().some(([, object]) => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image')).toBe(false);
    expect(JSON.stringify(doc)).toBe(unchanged);
  });

  it('rejects unknown modes and retains failing-design protection for each output', async () => {
    const doc = createDesign(SAMPLE_INPUT);
    await expect(generatePdf(doc, { mode: 'unknown' as PdfMode })).rejects.toThrow(/保存内容/);
    const blocked = createDesign({ ...SAMPLE_INPUT, travelMm: 70 });
    for (const mode of ['all', 'pattern', 'instructions'] as const) await expect(generatePdf(blocked, { mode })).rejects.toThrow(/条件違反/);
  });
});

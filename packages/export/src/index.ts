import { PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix, type PDFFont, type PDFPage, type PDFImage, type PDFEmbeddedPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canExport, getArtworkComposition, getAssemblySteps, getKitSummary, mmToPt, parseDesignDocument, type DesignDocument, type Part, type Rect } from '@ugoku/core';
import { validateBackgroundRaster } from './raster.js';
export { getAssemblySteps, getMaterials } from '@ugoku/core';
import { buildAssemblyDiagram } from './assembly-diagram.js';
export { generateAssemblySvg } from './assembly-diagram.js';
export const INSTRUCTION_PAGE_COUNT = 4;
import { SAMPLE_PNG_DATA_URL } from './sample-artwork.js';
export { ORIGINAL_SAMPLE_SVG, SAMPLE_PNG_DATA_URL } from './sample-artwork.js';
export type ExportOptions = { imageDataUrl?: string; backgroundImageDataUrl?: string; fontBytes?: Uint8Array | ArrayBuffer };
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const num = (n: number) => Number(n.toFixed(4));
const ink = rgb(0.13, 0.17, 0.16), pale = rgb(0.94, 0.94, 0.90), line = rgb(0.28, 0.33, 0.31);
function validateOptions(options: ExportOptions, doc: DesignDocument): void {
  if (doc.input.artworkRepair?.mode === 'image') validateBackgroundRaster(options.backgroundImageDataUrl, doc.input.artworkRepair.image);
  if (options.imageDataUrl && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(options.imageDataUrl) || options.imageDataUrl.length > 28_000_000)) throw new Error('画像はPNG/JPEG/WebPの埋め込みデータだけを利用できます');
  if (!options.imageDataUrl && doc.input.image.id !== 'sample-turtle-v1') throw new Error('この設計の元画像がありません。画像を含むプロジェクトを読み込んでください');
  if (!options.imageDataUrl && (doc.input.image.widthPx !== 800 || doc.input.image.heightPx !== 550)) throw new Error('サンプル画像の画素寸法と設計が一致しません');
  if (options.imageDataUrl && /^[a-f0-9]{64}$/.test(doc.input.image.id)) {
    const encoded = options.imageDataUrl.split(',')[1]!;
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    if (bytesToHex(sha256(bytes)) !== doc.input.image.id) throw new Error('元画像と設計の画像ハッシュが一致しません');
  }
}
function verified(document: DesignDocument): DesignDocument {
  const doc = parseDesignDocument(document);
  if (!canExport(doc) || getKitSummary(doc).status === 'blocked') throw new Error('条件違反を修正してから型紙を出力してください');
  return doc;
}
function svgArt(doc: DesignDocument, part: Part, imageDataUrl: string, backgroundImageDataUrl?: string): string {
  const p = doc.artwork.placement, s = doc.artwork.selectionMm;
  if (part.role !== 'base' && part.role !== 'artwork') return '';
  const art = (x: number, y: number) => `<image href="${esc(imageDataUrl)}" x="${num(x)}" y="${num(y)}" width="${num(p.width)}" height="${num(p.height)}" preserveAspectRatio="none"/>`;
  const composition = getArtworkComposition(doc), bg = composition.background;
  const paper = `<rect data-paper="${part.id}" width="${part.widthMm}" height="${part.heightMm}" fill="white"/>`;
  // Chromium needs an actual offscreen group; isolation alone may still clip each
  // draw separately. A zero offset preserves pixels and uses bounded source space.
  const filter = `<filter id="paper-composite-${part.id}" filterUnits="userSpaceOnUse" x="${part.role === 'base' ? p.x : p.x - s.x}" y="${part.role === 'base' ? p.y : p.y - s.y}" width="${p.width}" height="${p.height}" color-interpolation-filters="sRGB"><feOffset dx="0" dy="0"/></filter>`;
  const repair = `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="${composition.fixedMask.color === '#ffffff' ? 'white' : composition.fixedMask.color}"/>`;
  const background = bg ? `${filter}<clipPath id="repair-B1"><rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}"/></clipPath><g clip-path="url(#repair-B1)" filter="url(#paper-composite-B1)" style="isolation:isolate"><rect width="${part.widthMm}" height="${part.heightMm}" fill="white"/><image data-artwork="background" href="${esc(backgroundImageDataUrl!)}" x="${bg.placement.x}" y="${bg.placement.y}" width="${bg.placement.width}" height="${bg.placement.height}" preserveAspectRatio="none"/></g>` : '';
  return part.role === 'base' ? `${paper}${art(p.x, p.y)}${bg ? background : repair}` : `${filter}<clipPath id="crop-M1"><rect width="${part.widthMm}" height="${part.heightMm}"/></clipPath><g clip-path="url(#crop-M1)" filter="url(#paper-composite-M1)" style="isolation:isolate">${paper}${art(p.x - s.x, p.y - s.y)}</g>`;
}
function svgPart(doc: DesignDocument, part: Part, imageDataUrl: string, backgroundImageDataUrl?: string): string {
  const art = svgArt(doc, part, imageDataUrl, backgroundImageDataUrl);
  const lines = [art];
  for (const glue of part.role === 'base' ? [] : part.glue) {
    const r = glue.rect;
    lines.push(`<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="white" fill-opacity=".8" stroke="#555" stroke-width=".2" stroke-dasharray=".6 .6"/><path d="M${r.x} ${r.y}L${r.x + r.width} ${r.y + r.height}M${r.x + r.width} ${r.y}L${r.x} ${r.y + r.height}" stroke="#888" stroke-width=".15"/>`);
    if (part.role !== 'base') lines.push(`<text x="${r.x + .4}" y="${r.y + Math.min(r.height - .5, 2.3)}" font-size="1.6">${esc(glue.label.split(' ')[0] ?? 'GLUE')}</text>`);
  }
  for (const cut of part.cuts) lines.push(`<rect x="${cut.x}" y="${cut.y}" width="${cut.width}" height="${cut.height}" fill="white" stroke="#202b25" stroke-width=".25"/>`);
  for (const fold of part.folds) lines.push(`<path d="M${fold.from.x} ${fold.from.y}L${fold.to.x} ${fold.to.y}" fill="none" stroke="#202b25" stroke-width=".25" stroke-dasharray="1.5 1"/>`);
  const internalId = part.role === 'base' || part.role === 'artwork' ? '' : `<text x="1" y="${Math.max(3, part.heightMm - 1)}" font-size="2.5" stroke="white" stroke-width=".6" paint-order="stroke">${part.id}</text>`;
  lines.push(`<rect width="${part.widthMm}" height="${part.heightMm}" fill="none" stroke="#202b25" stroke-width=".3"/>${internalId}<text x="0" y="-1.8" font-size="2.5">${part.widthMm >= 40 ? `${part.id} ${esc(part.label)} · ${part.widthMm} × ${part.heightMm} mm` : part.id}</text>`);
  if (part.role === 'pull-tab') lines.push(`<text x="${part.widthMm - 17}" y="11" font-size="2.7">PULL &gt;</text>`);
  if (part.role === 'base') lines.push(`<text x="${part.widthMm - 12}" y="-1.8" font-size="2.3">TOP</text>`);
  return lines.join('');
}
export function generateSvg(document: DesignDocument, page = 1, options: Pick<ExportOptions, 'imageDataUrl' | 'backgroundImageDataUrl'> = {}): string {
  const doc = verified(document); validateOptions(options, doc);
  if (!Number.isInteger(page) || page < 1 || page > doc.layout.sheets) throw new Error('型紙ページ番号が不正です');
  const parts = doc.layout.placements.filter(p => p.page === page).map(placement => {
    const part = doc.parts.find(p => p.id === placement.partId)!;
    const transform = placement.rotated ? `translate(${placement.xMm + part.heightMm} ${placement.yMm}) rotate(90)` : `translate(${placement.xMm} ${placement.yMm})`;
    return `<g data-part-id="${part.id}" transform="${transform}">${svgPart(doc, part, options.imageDataUrl || SAMPLE_PNG_DATA_URL, options.backgroundImageDataUrl)}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297"><title>${esc(doc.input.title)} 型紙 ${page}</title><desc>原寸100%、用紙に合わせない。試作・実物未確認（PROTOTYPE）。切る線は実線、折る線は破線、接着は×印。</desc><rect width="210" height="297" fill="white"/><g font-family="sans-serif" fill="#202b25"><text x="10" y="12" font-size="4.4"${doc.input.title.length > 30 ? ' textLength="187" lengthAdjust="spacingAndGlyphs"' : ''}>うごく紙工房 · ${esc(doc.input.title)}</text><text x="10" y="18" font-size="2.7">${esc(doc.designId)} / revision ${doc.revision} / pattern ${page} of ${doc.layout.sheets}</text><text x="10" y="23" font-size="2.3">PROTOTYPE / 試作・実物未確認 / SHA-256 ${doc.designHash.slice(0, 20)}</text><text x="10" y="28" font-size="2.6">実線: 切る / 破線: 折る / ×印: 接着する位置（糊を付ける表裏は手順を参照）</text>${parts}<path d="M10 283H60M10 281V285M60 281V285" fill="none" stroke="#202b25" stroke-width=".3"/><text x="65" y="284" font-size="2.8">50 mm · 実際のサイズ／100% · 縮小を無効</text><text x="10" y="291" font-size="2.4">試作キット・実物未確認。校正線を測ってから工作。説明書4ページは型紙枚数に含みません。</text></g></svg>`;
}
function rect(page: PDFPage, x: number, y: number, w: number, h: number, opts: { fill?: boolean; dashed?: boolean; border?: number } = {}) {
  page.drawRectangle({ x: mmToPt(x), y: mmToPt(y), width: mmToPt(w), height: mmToPt(h), borderColor: line, borderWidth: mmToPt(opts.border ?? .22), ...(opts.fill ? { color: pale } : {}), ...(opts.dashed ? { borderDashArray: [mmToPt(.8), mmToPt(.6)] } : {}) });
}
function textAt(page: PDFPage, font: PDFFont, text: string, x: number, y: number, sizeMm = 2.5) {
  // The enclosing transform uses top-down mm space, so invert glyphs locally.
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, -1, 0, 2 * mmToPt(y)));
  page.drawText(text, { x: mmToPt(x), y: mmToPt(y), size: mmToPt(sizeMm), font, color: ink });
  page.pushOperators(popGraphicsState());
}
function lineAt(page: PDFPage, x1: number, y1: number, x2: number, y2: number, dashed = false) {
  page.drawLine({ start: { x: mmToPt(x1), y: mmToPt(y1) }, end: { x: mmToPt(x2), y: mmToPt(y2) }, thickness: mmToPt(.25), color: line, ...(dashed ? { dashArray: [mmToPt(1.5), mmToPt(1)] } : {}) });
}
function imageAt(page: PDFPage, image: PDFImage, x: number, y: number, w: number, h: number) {
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, -1, 0, mmToPt(2 * y + h)));
  page.drawImage(image, { x: mmToPt(x), y: mmToPt(y), width: mmToPt(w), height: mmToPt(h) });
  page.pushOperators(popGraphicsState());
}
function paperPatchAt(page: PDFPage, patch: PDFEmbeddedPage, region: Rect) {
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, -1, 0, mmToPt(2 * region.y + region.height)));
  page.drawPage(patch, { x: mmToPt(region.x), y: mmToPt(region.y), width: mmToPt(region.width), height: mmToPt(region.height) });
  page.pushOperators(popGraphicsState());
}
/** Composite white paper and image once, then clip the resulting opaque paper layer. */
async function makePaperPatch(pdf: PDFDocument, doc: DesignDocument, image: PDFImage, placement: Rect, region: Rect): Promise<PDFEmbeddedPage> {
  const pageIndex = pdf.getPageCount(), page = pdf.addPage([mmToPt(doc.input.widthMm), mmToPt(doc.input.heightMm)]);
  page.drawRectangle({ x: 0, y: 0, width: page.getWidth(), height: page.getHeight(), color: rgb(1, 1, 1) });
  page.drawImage(image, { x: mmToPt(placement.x), y: mmToPt(doc.input.heightMm - placement.y - placement.height), width: mmToPt(placement.width), height: mmToPt(placement.height) });
  const patch = await pdf.embedPage(page, { left: mmToPt(region.x), bottom: mmToPt(doc.input.heightMm - region.y - region.height), right: mmToPt(region.x + region.width), top: mmToPt(doc.input.heightMm - region.y) });
  await patch.embed();
  const form = pdf.context.lookup(patch.ref);
  if (!(form instanceof PDFRawStream)) throw new Error('画像の印刷用合成に失敗しました');
  // /I isolates the group so a fractional clip edge is antialiased only once.
  form.dict.set(PDFName.of('Group'), pdf.context.obj({ S: 'Transparency', CS: 'DeviceRGB', I: true }));
  pdf.removePage(pageIndex);
  return patch;
}
function drawPart(page: PDFPage, doc: DesignDocument, part: Part, font: PDFFont, image: PDFImage, movingPatch: PDFEmbeddedPage, japanese: boolean, backgroundPatch?: PDFEmbeddedPage) {
  const p = doc.artwork.placement, s = doc.artwork.selectionMm;
  const composition = getArtworkComposition(doc);
  if (part.role === 'base') page.drawRectangle({ x: 0, y: 0, width: mmToPt(part.widthMm), height: mmToPt(part.heightMm), color: rgb(1, 1, 1) });
  if (part.role === 'base') {
    imageAt(page, image, p.x, p.y, p.width, p.height);
    if (backgroundPatch) {
      paperPatchAt(page, backgroundPatch, s);
    } else {
      const color = composition.fixedMask.color;
      page.drawRectangle({ x: mmToPt(s.x), y: mmToPt(s.y), width: mmToPt(s.width), height: mmToPt(s.height), color: rgb(parseInt(color.slice(1, 3), 16) / 255, parseInt(color.slice(3, 5), 16) / 255, parseInt(color.slice(5, 7), 16) / 255) });
    }
  } else if (part.role === 'artwork') {
    paperPatchAt(page, movingPatch, { x: 0, y: 0, width: part.widthMm, height: part.heightMm });
  }
  for (const glue of part.role === 'base' ? [] : part.glue) {
    const r = glue.rect;
    page.drawRectangle({ x: mmToPt(r.x), y: mmToPt(r.y), width: mmToPt(r.width), height: mmToPt(r.height), color: rgb(1, 1, 1), opacity: .85 });
    rect(page, r.x, r.y, r.width, r.height, { dashed: true }); lineAt(page, r.x, r.y, r.x + r.width, r.y + r.height); lineAt(page, r.x + r.width, r.y, r.x, r.y + r.height);
    if (part.role !== 'base') textAt(page, font, glue.label.split(' ')[0] ?? 'GLUE', r.x + .4, r.y + Math.min(r.height - .5, 2.3), 1.6);
  }
  for (const cut of part.cuts) { page.drawRectangle({ x: mmToPt(cut.x), y: mmToPt(cut.y), width: mmToPt(cut.width), height: mmToPt(cut.height), color: rgb(1, 1, 1) }); rect(page, cut.x, cut.y, cut.width, cut.height); }
  for (const fold of part.folds) lineAt(page, fold.from.x, fold.from.y, fold.to.x, fold.to.y, true);
  rect(page, 0, 0, part.widthMm, part.heightMm);
  if (part.role !== 'base' && part.role !== 'artwork') {
    page.drawRectangle({ x: mmToPt(.6), y: mmToPt(part.heightMm - 4), width: mmToPt(6), height: mmToPt(3.5), color: rgb(1, 1, 1), opacity: .9 });
    textAt(page, font, part.id, 1, part.heightMm - 1, 2.5);
  }
  textAt(page, font, part.widthMm >= 40 ? `${part.id} ${japanese ? part.label : part.role} / ${part.widthMm} x ${part.heightMm} mm` : part.id, 0, -1.8, 2.4);
  if (part.role === 'pull-tab') textAt(page, font, 'PULL >', part.widthMm - 17, 11, 2.7);
  if (part.role === 'base') textAt(page, font, 'TOP', part.widthMm - 12, -1.8, 2.3);
}
function wrap(font: PDFFont, text: string, maxWidthMm: number, sizeMm: number): string[] {
  const lines: string[] = []; let current = '';
  for (const char of text) {
    if (char === '\n' || font.widthOfTextAtSize(current + char, mmToPt(sizeMm)) > mmToPt(maxWidthMm)) { lines.push(current); current = char === '\n' ? '' : char; } else current += char;
  }
  if (current) lines.push(current); return lines;
}
function drawAssemblyDiagram(page: PDFPage, doc: DesignDocument, font: PDFFont, y: number, step: number, japanese: boolean) {
  const scene = buildAssemblyDiagram(doc, step, japanese);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(.92, 0, 0, .92, mmToPt(17.5), mmToPt(y)));
  for (const mark of scene.marks) {
    if (mark.kind === 'text') textAt(page, font, mark.text, mark.x, mark.y, mark.size ?? 2.7);
    else if (mark.kind === 'rect') rect(page, mark.rect.x, mark.rect.y, mark.rect.width, mark.rect.height, { dashed: mark.dashed, border: mark.added ? .6 : .23 });
    else for (let i = 1; i < mark.points.length; i++) {
      const a = mark.points[i - 1]!, b = mark.points[i]!;
      lineAt(page, a.x, a.y, b.x, b.y, mark.dashed);
    }
  }
  page.pushOperators(popGraphicsState());
}
const englishSteps = [
  'Print at actual size / 100%. Disable fit-to-page. Measure the 50 mm calibration line. Cut all 8 parts on solid outlines and the slot in B1. Dashed lines are folds: do not cut or glue them.',
  'Fold G1 and G2 at all four dashed lines into raised tunnels. Fold C1 into a Z with sections 6 / 2 / 6 mm. Keep printed faces as shown. Do not glue yet.',
  'Turn B1 left-to-right, keeping TOP up. Measure foot positions using the rear reference. Glue the BLANK BACK of each 5 mm guide foot to B1 BACK. Thread bare T1 through both guides, printed side facing B1, before adding C1 or stops. Keep the tunnel glue-free.',
  'Lift B1 for access from both sides. Feed the M1 foot of C1 edgewise from BACK through the slot to FRONT, then restore its Z fold. Glue the BLANK BACK of the T1 foot to the C1 mark on T1. Glue the PRINTED M1 foot to the BACK of M1, aligned to its original selected position. No glue on the slot or central 2 mm riser.',
  'After threading, glue the BLANK BACK of the central 14 mm of S1/S2 to their marks on T1. Keep the 4 mm wings free. S2 contacts G2 at START; S1 contacts G1 at END. Never glue stops to B1 or guides.',
  'Let glue dry. Pull the exposed handle gently through START, middle and END. Check that both guides retain T1 throughout. Record material, calibration, orientation, glue, binding and hand corrections against this revision. This is an unverified PROTOTYPE. Take care with tools and small parts.',
];
export async function generatePdf(document: DesignDocument, options: ExportOptions = {}): Promise<Uint8Array> {
  const doc = verified(document); validateOptions(options, doc);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${doc.designId} revision ${doc.revision}`); pdf.setSubject(`PROTOTYPE - physically unverified single pull-tab; SHA-256 ${doc.designHash}; physically unverified`); pdf.setCreator('Ugoku Kami Studio');
  pdf.registerFontkit(fontkit);
  const japanese = !!options.fontBytes;
  const font = options.fontBytes ? await pdf.embedFont(options.fontBytes, { subset: false }) : await pdf.embedFont(StandardFonts.Helvetica);
  const imageDataUrl = options.imageDataUrl || SAMPLE_PNG_DATA_URL;
  if (imageDataUrl.startsWith('data:image/webp')) throw new Error('PDF出力用の画像をPNGへ変換してください');
  const img = imageDataUrl.startsWith('data:image/png') ? await pdf.embedPng(imageDataUrl) : await pdf.embedJpg(imageDataUrl);
  if (img.width !== doc.input.image.widthPx || img.height !== doc.input.image.heightPx) throw new Error('元画像の画素寸法と設計が一致しません');
  const movingPatch = await makePaperPatch(pdf, doc, img, doc.artwork.placement, doc.artwork.selectionMm);
  let backgroundPatch: PDFEmbeddedPage | undefined;
  if (doc.input.artworkRepair?.mode === 'image') {
    const url = options.backgroundImageDataUrl!;
    if (url.startsWith('data:image/webp')) throw new Error('PDF出力用の背景画像をPNGへ変換してください');
    const backgroundImage = url.startsWith('data:image/png') ? await pdf.embedPng(url) : await pdf.embedJpg(url);
    const source = doc.input.artworkRepair.image;
    if (backgroundImage.width !== source.widthPx || backgroundImage.height !== source.heightPx) throw new Error('背景画像の画素寸法と設計が一致しません');
    // Composite paper + background once before clipping. Independent white erasure and
    // image clips produce a pale seam at fractional-pixel boundaries in PDF renderers.
    const composition = getArtworkComposition(doc), b = composition.background!.placement, s = composition.fixedMask.rect;
    backgroundPatch = await makePaperPatch(pdf, doc, backgroundImage, b, s);
  }
  const newPage = () => { const page = pdf.addPage([mmToPt(210), mmToPt(297)]); page.pushOperators(concatTransformationMatrix(1, 0, 0, -1, 0, mmToPt(297))); return page; };
  for (let index = 1; index <= doc.layout.sheets; index++) {
    const page = newPage();
    const heading = japanese ? `うごく紙工房 / ${doc.input.title}` : 'UGOKU KAMI STUDIO / Pull-tab pattern';
    const headingSize = Math.min(4.3, 4.3 * mmToPt(189) / font.widthOfTextAtSize(heading, mmToPt(4.3)));
    textAt(page, font, heading, 10, 12, headingSize);
    textAt(page, font, `${doc.designId} / revision ${doc.revision} / pattern ${index} of ${doc.layout.sheets}`, 10, 18, 2.7);
    textAt(page, font, `${japanese ? 'PROTOTYPE / 試作・実物未確認' : 'PROTOTYPE / PHYSICALLY UNVERIFIED'} / SHA-256 ${doc.designHash.slice(0, 20)}`, 10, 23, 2.3);
    textAt(page, font, japanese ? '実線: 切る / 破線: 折る / ×印: 接着する位置（糊を付ける表裏は手順を参照）' : 'SOLID: CUT / DASHED: FOLD / X: GLUE AREA (see instructions for which face)', 10, 28, 2.6);
    for (const placement of doc.layout.placements.filter(p => p.page === index)) {
      const part = doc.parts.find(p => p.id === placement.partId)!;
      page.pushOperators(pushGraphicsState(), placement.rotated ? concatTransformationMatrix(0, 1, -1, 0, mmToPt(placement.xMm + part.heightMm), mmToPt(placement.yMm)) : concatTransformationMatrix(1, 0, 0, 1, mmToPt(placement.xMm), mmToPt(placement.yMm)));
      drawPart(page, doc, part, font, img, movingPatch, japanese, backgroundPatch); page.pushOperators(popGraphicsState());
    }
    lineAt(page, 10, 283, 60, 283); lineAt(page, 10, 281, 10, 285); lineAt(page, 60, 281, 60, 285);
    textAt(page, font, japanese ? '50 mm / 実際のサイズ・100% / 縮小を無効' : '50 mm / ACTUAL SIZE 100% / DISABLE FIT-TO-PAGE', 65, 284, 2.6);
    textAt(page, font, japanese ? '試作キット・実物未確認。校正線を測ってから工作。説明書4ページは型紙枚数に含みません。' : 'PROTOTYPE. Measure calibration first. Four instruction pages are separate from pattern sheets.', 10, 291, 2.5);
  }
  const steps = getAssemblySteps(doc), kit = getKitSummary(doc);
  for (let sheet = 0; sheet < 3; sheet++) {
    const page = newPage();
    textAt(page, font, japanese ? '試作・実物未確認 / 組み立て手順' : 'PROTOTYPE / Assembly instructions', 10, 14, 4.4);
    textAt(page, font, `${doc.designId} / revision ${doc.revision} / instructions ${sheet + 1} of ${INSTRUCTION_PAGE_COUNT}`, 10, 21, 2.6);
    for (let index = 0; index < 2; index++) {
      const i = sheet * 2 + index, step = steps[i]!; const y = 33 + index * 111;
      textAt(page, font, `${i + 1}. ${japanese ? step.title : ['Calibrate and cut eight parts', 'Fold tunnels and Z connector', 'Attach guides; thread the BARE tab', 'Pass C1 through FIRST, then glue', 'Add stops AFTER threading', 'Dry, test both ends and the whole travel'][i]}`, 10, y, 3.5);
      const repairNote = doc.input.artworkRepair?.mode === 'image' ? ' The chosen background is printed on B1; no extra part.' : doc.input.artworkRepair?.mode === 'solid' ? ' The chosen solid color is printed on B1.' : '';
      const body = japanese ? [step.description, ...step.glueInstructions, ...step.doNotGlue].join(' ') : englishSteps[i]! + (i === 0 ? ` M1 is rectangular white paper; transparent pixels print white.${repairNote}` : '');
      const lines = wrap(font, body, 188, 2.8);
      lines.forEach((line, k) => textAt(page, font, line, 10, y + 7 + k * 4.2, 2.8));
      drawAssemblyDiagram(page, doc, font, y + 38, i + 1, japanese);
    }
    if (sheet === 2) {
      textAt(page, font, japanese ? `材料: A4型紙${doc.layout.sheets}枚＋説明書${INSTRUCTION_PAGE_COUNT}ページ。のり、定規、はさみ、カッターマット。` : `Materials: ${doc.layout.sheets} A4 pattern sheets + ${INSTRUCTION_PAGE_COUNT} instruction pages, glue, ruler, scissors, cutting mat.`, 10, 253, 2.7);
      textAt(page, font, japanese ? '全部品: B1台紙 / M1絵 / T1引き手 / G1・G2ガイド / C1接続片 / S1・S2抜け止め。' : 'All parts: B1 base, M1 artwork, T1 tab, G1/G2 guides, C1 connector, S1/S2 stops.', 10, 259, 2.7);
      textAt(page, font, japanese ? `想定紙厚${doc.input.paperThicknessMm} mm。引き手は始点で${kit.handleExposureMm.start} mm外へ出ます。刃物と小さな部品に注意。` : `Assumed paper ${doc.input.paperThicknessMm} mm; handle exposed ${kit.handleExposureMm.start} mm at start. Care with tools and small parts.`, 10, 265, 2.6);
    }
    textAt(page, font, `SHA-256 ${doc.designHash}`, 10, 290, 2.2);
  }
  const reference = newPage();
  textAt(reference, font, japanese ? 'B1の裏側 / 接着位置を測る' : 'BACK of B1 / Measure glue-foot positions', 10, 14, 4.2);
  textAt(reference, font, `${doc.designId} / revision ${doc.revision} / instructions 4 of 4`, 10, 21, 2.6);
  const intro = japanese ? '上辺を上に保ち、B1を左右に裏返します。下の座標は裏側から見た台紙の左上が原点です。型紙の絵に印は付けていません。定規で裏へ接着足を写してください。' : 'Turn B1 left-to-right, keeping the top edge up. Coordinates below are measured from the upper-left corner of the BACK. Mark the glue feet on the back with a ruler.';
  wrap(font, intro, 188, 3.1).forEach((t, k) => textAt(reference, font, t, 10, 31 + k * 5.5, 3.1));
  const backScale = Math.min(1, 180 / doc.input.widthMm, 105 / doc.input.heightMm);
  reference.pushOperators(pushGraphicsState(), concatTransformationMatrix(backScale, 0, 0, backScale, mmToPt(15), mmToPt(55)));
  rect(reference, 0, 0, doc.input.widthMm, doc.input.heightMm);
  textAt(reference, font, 'TOP / B1 BACK', 3, 7, 4);
  const slot = doc.motion.slot;
  rect(reference, doc.input.widthMm - slot.x - slot.width, slot.y, slot.width, slot.height);
  const base = doc.parts.find(p => p.id === 'B1')!;
  base.glue.forEach((g, i) => {
    const r = g.rect, x = doc.input.widthMm - r.x - r.width;
    rect(reference, x, r.y, r.width, r.height, { fill: true, dashed: true });
    lineAt(reference, x, r.y, x + r.width, r.y + r.height);
    lineAt(reference, x + r.width, r.y, x, r.y + r.height);
    textAt(reference, font, `${Math.floor(i / 2) + 1}${i % 2 ? 'b' : 'a'}`, x, r.y - 2, 3);
  });
  reference.pushOperators(popGraphicsState());
  textAt(reference, font, japanese ? `位置図の縮尺 ${Math.round(backScale * 100)}% / 座標と寸法は実寸mm` : `Diagram scale ${Math.round(backScale * 100)}% / All coordinates are actual mm`, 10, 171, 2.8);
  base.glue.forEach((g, i) => {
    const r = g.rect, x = num(doc.input.widthMm - r.x - r.width);
    textAt(reference, font, `G${Math.floor(i / 2) + 1} foot ${i % 2 ? 'b' : 'a'}: x=${x}, y=${num(r.y)}, width=${num(r.width)}, height=${num(r.height)} mm`, 10, 181 + i * 7, 3);
  });
  textAt(reference, font, japanese ? '×印の接着足だけを接着。ガイドの通路とタブには糊を付けない。' : 'Glue crossed feet only. Keep the guide tunnels and the moving tab free of glue.', 10, 214, 2.8);
  const narrowParts = doc.parts.filter(p => p.widthMm < 40).map(p => `${p.id} ${japanese ? p.label : p.role} ${p.widthMm} x ${p.heightMm} mm`).join(' / ');
  wrap(font, narrowParts, 188, 2.5).forEach((t, k) => textAt(reference, font, t, 10, 223 + k * 4.5, 2.5));
  textAt(reference, font, japanese ? `正面から${kit.directionLabel}へ${kit.travelMm} mm / PROTOTYPE・実物未確認` : `Front direction: ${doc.input.direction}; travel ${kit.travelMm} mm / PROTOTYPE`, 10, 242, 3);
  textAt(reference, font, japanese ? 'この版で試す：始点・途中・終点、両ガイドの保持、接着面、手修正。' : 'Test this revision: START / middle / END, both guides, glue faces and hand corrections.', 10, 250, 2.8);
  textAt(reference, font, japanese ? '校正線の実測 ______ mm / 紙の種類・厚さ ____________________' : 'Measured calibration ______ mm / paper type and thickness ____________________', 10, 261, 2.9);
  textAt(reference, font, japanese ? '動作と修正内容 __________________________________________' : 'Motion and hand corrections ______________________________________________', 10, 273, 2.9);
  textAt(reference, font, `SHA-256 ${doc.designHash}`, 10, 290, 2.2);
  return pdf.save();
}

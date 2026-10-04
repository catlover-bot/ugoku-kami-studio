import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createDesign, SAMPLE_INPUT, applyDesignPatch, getAssemblySteps, getMaterials, getKitSummary } from '@ugoku/core';
import { generatePdf, generateSvg, generateAssemblySvg, INSTRUCTION_PAGE_COUNT, ORIGINAL_SAMPLE_SVG } from '@ugoku/export';

const out = new URL('../artifacts/examples/', import.meta.url);
await mkdir(out, { recursive: true });
const fontBytes = await readFile(new URL('../apps/web/public/fonts/ZenKakuGothicNew-Regular.ttf', import.meta.url));
let svg: string;
try { svg = await readFile(new URL('../apps/web/public/turtle.svg', import.meta.url), 'utf8'); } catch { svg = ORIGINAL_SAMPLE_SVG; }
const png = await sharp(Buffer.from(svg)).png().toBuffer();
const imageDataUrl = `data:image/png;base64,${png.toString('base64')}`;
const sample = createDesign(SAMPLE_INPUT, { designId: 'example-turtle' });
const vertical = createDesign({ ...SAMPLE_INPUT, title: '縦方向の確認用サンプル', image: { ...SAMPLE_INPUT.image, widthPx: 550, heightPx: 800, id: 'sample-vertical-v1' }, selection: { x: 220, y: 520, width: 160, height: 200 }, widthMm: 110, heightMm: 160, direction: 'down' }, { designId: 'example-vertical' });
const heldout = createDesign({ ...SAMPLE_INPUT, title: '長い作品名の印刷検証'.repeat(8).slice(0, 80), widthMm: 220, heightMm: 140, maxSheets: 4, travelMm: 22.3, paperThicknessMm: 0.42, clearanceMm: 1.13, selection: { x: 515.5, y: 165.25, width: 198.5, height: 171.75 } }, { designId: 'heldout-'.padEnd(64, 'x') });
const rotatedPng = await sharp(png).rotate(90).png().toBuffer();
const verticalUrl = `data:image/png;base64,${rotatedPng.toString('base64')}`;
// Original developer-created fixture, not a user's image and not bundled in the app.
const balloonSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900"><rect width="600" height="900" fill="white"/><path d="M0 780Q100 680 250 770Q400 670 600 760V900H0Z" fill="#b9ce9a"/><path d="M0 845Q130 785 260 850Q400 780 600 830V900H0Z" fill="#819c65"/><ellipse cx="300" cy="220" rx="75" ry="99" fill="#bb6b48" stroke="#66432f" stroke-width="6"/><path d="M300 121C240 160 240 275 300 319C360 275 360 160 300 121" fill="#ead398" stroke="#66432f" stroke-width="5"/><path d="M263 307L275 355M337 307L325 355" fill="none" stroke="#66432f" stroke-width="5"/><path d="M267 355H333L325 395H275Z" fill="#b99563" stroke="#66432f" stroke-width="5"/><circle cx="105" cy="710" r="15" fill="#ddb868"/><path d="M104 725V772" stroke="#577449" stroke-width="6"/></svg>`;
const balloonPng = await sharp(Buffer.from(balloonSvg)).png().toBuffer();
await writeFile(new URL('developer-balloon-source.svg', out), balloonSvg);
await writeFile(new URL('developer-balloon-source.png', out), balloonPng);
const balloonUrl = `data:image/png;base64,${balloonPng.toString('base64')}`;
const upward = createDesign({ ...SAMPLE_INPUT, title: '上へのぼる気球（開発者作成画像）', image: { id: bytesToHex(sha256(balloonPng)), widthPx: 600, heightPx: 900, mimeType: 'image/png' }, selection: { x: 200, y: 115, width: 205, height: 290 }, widthMm: 120, heightMm: 180, direction: 'up', travelMm: 20, maxSheets: 2 }, { designId: 'example-upward-balloon' });
for (const [name, doc, artwork] of [['turtle', sample, imageDataUrl], ['vertical', vertical, verticalUrl], ['heldout-wide-long-title', heldout, imageDataUrl], ['upward-balloon', upward, balloonUrl]] as const) {
  if (doc.checks.some(c => c.status === 'fail')) throw new Error(`Example ${name} failed geometric checks`);
  await writeFile(new URL(`${name}.pdf`, out), await generatePdf(doc, { imageDataUrl: artwork, fontBytes }));
  for (let page = 1; page <= doc.layout.sheets; page++) await writeFile(new URL(`${name}-${page}.svg`, out), generateSvg(doc, page, { imageDataUrl: artwork }));
  for (const step of getAssemblySteps(doc)) await writeFile(new URL(`${name}-assembly-${step.number}.svg`, out), generateAssemblySvg(doc, step.number));
  await writeFile(new URL(`${name}.design.json`, out), JSON.stringify(doc, null, 2));
  await writeFile(new URL(`${name}.checks.json`, out), JSON.stringify({ designHash: doc.designHash, checks: getKitSummary(doc).checks, kit: getKitSummary(doc), assembly: getAssemblySteps(doc), materials: getMaterials(doc) }, null, 2));
  console.log(`${name}: ${doc.layout.sheets} pattern sheets + ${INSTRUCTION_PAGE_COUNT} instructions; physical-operation=unknown; ${doc.designHash}`);
}
const rejected = applyDesignPatch(sample, { travelMm: 60 });
await writeFile(new URL('rejected-travel.checks.json', out), JSON.stringify(rejected.checks, null, 2));
console.log('Generated artifacts/examples (PDF bytes may differ due to PDF metadata; geometry hashes are deterministic).');

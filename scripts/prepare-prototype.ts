import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { applyDesignPatch, createDesign, getArtworkComposition, getAssemblySteps, getKitSummary, getMaterials, getPartPose, parseDesignDocument, type DesignDocument } from '@ugoku/core';
import { generateAssemblySvg, generatePdf, generateSvg, INSTRUCTION_PAGE_COUNT } from '@ugoku/export';
import { validateImage } from '../apps/server/src/images.js';

/** Original vector artwork made for this prototype. It is not user artwork or AI output. */
export const PROTOTYPE_SOURCE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="550" viewBox="0 0 800 550">
<rect width="800" height="550" fill="white"/>
<g fill="none" stroke="#8caba8" stroke-width="5"><circle cx="160" cy="190" r="17"/><circle cx="230" cy="135" r="10"/><path d="M90 455Q125 435 160 455T230 455T300 455M470 455Q505 435 540 455T610 455T680 455"/></g>
<g stroke="#514333" stroke-width="6" stroke-linejoin="round">
<path d="M445 247L380 205V335L445 292Z" fill="#cf8c45"/>
<path d="M474 230L500 185L547 224Z" fill="#d4a555"/>
<path d="M478 314L514 354L547 313Z" fill="#d4a555"/>
<ellipse cx="515" cy="270" rx="88" ry="57" fill="#e8bb62"/>
<path d="M491 236Q514 270 491 304" fill="none"/>
</g>
<circle cx="562" cy="251" r="8" fill="#292923"/>
<circle cx="564" cy="249" r="2.3" fill="white"/>
<path d="M583 286Q594 291 600 282" fill="none" stroke="#514333" stroke-width="5" stroke-linecap="round"/>
</svg>`;

export type PrototypeProject = { format: 'ugoku-kami-project'; version: 2; document: DesignDocument; imageDataUrl: string; records: [] };
export type PrototypeBundleOptions = { outDir?: string; mode?: 'manual' | 'live-gemini'; liveRunId?: string };

/** Uses the production raster validator; no AI provider or paid request is constructed. */
export async function createPrototypeProject(): Promise<PrototypeProject> {
  const png = await sharp(Buffer.from(PROTOTYPE_SOURCE_SVG)).png().toBuffer();
  const { image: { dataUrl: imageDataUrl, ...image } } = await validateImage({ dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  const document = createDesign({
    title: '右へ泳ぐ魚・試作004', image,
    selection: { x: 350, y: 170, width: 300, height: 210 },
    direction: 'right', travelMm: 15, widthMm: 160, heightMm: 110, maxSheets: 1,
    paperThicknessMm: .25, clearanceMm: .8,
    locks: ['widthMm', 'heightMm', 'maxSheets', 'selection', 'direction', 'paperThicknessMm', 'clearanceMm'],
  }, { designId: 'prototype-004-fish', revision: 1 });
  return { format: 'ugoku-kami-project', version: 2, document, imageDataUrl, records: [] };
}

function expectedFront(project: PrototypeProject, travel: number): string {
  const doc = project.document, composition = getArtworkComposition(doc), p = composition.source, s = composition.movingPaper;
  const tab = getPartPose(doc, 'T1', travel), tabEnd = getPartPose(doc, 'T1', doc.input.travelMm), moving = getPartPose(doc, 'M1', travel);
  const width = Math.max(doc.input.widthMm, tabEnd.x + tabEnd.width) + 20, height = doc.input.heightMm + 20;
  const image = (x: number, y: number) => `<image href="${project.imageDataUrl}" x="${x}" y="${y}" width="${p.width}" height="${p.height}"/>`;
  const slot = doc.motion.slot;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="-10 -10 ${width} ${height}" data-design-hash="${doc.designHash}" data-revision="${doc.revision}" data-travel-mm="${travel}"><title>設計から生成した正面の予定図・${travel}mm・実物未確認</title><rect x="-10" y="-10" width="${width}" height="${height}" fill="#f6f4ee"/><rect x="${tab.x}" y="${tab.y}" width="${tab.width}" height="${tab.height}" fill="white" stroke="#292923" stroke-width=".25"/><rect width="${doc.input.widthMm}" height="${doc.input.heightMm}" fill="white" stroke="#292923" stroke-width=".25"/>${image(p.x,p.y)}<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="white"/><rect x="${slot.x}" y="${slot.y}" width="${slot.width}" height="${slot.height}" fill="white" stroke="#292923" stroke-width=".25"/><defs><clipPath id="moving"><rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}"/></clipPath><filter id="paper" filterUnits="userSpaceOnUse" x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" color-interpolation-filters="sRGB"><feOffset dx="0" dy="0"/></filter></defs><g transform="translate(${moving.x-s.x} ${moving.y-s.y})"><g clip-path="url(#moving)" filter="url(#paper)"><rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="white"/>${image(p.x,p.y)}</g></g></svg>`;
}

/** Bundle this exact version. The browser-produced canonical kit.pdf is never overwritten. */
export async function writePrototypeBundle(project: PrototypeProject, options: PrototypeBundleOptions = {}) {
  const doc = parseDesignDocument(project.document), kit = getKitSummary(doc), mode = options.mode ?? 'manual';
  if (mode === 'live-gemini' && !options.liveRunId) throw new Error('実Gemini由来を記録するには実際のrunIdが必要です');
  if (kit.status === 'blocked') throw new Error('試作の幾何条件を満たしていません');
  if (doc.input.artworkRepair && doc.input.artworkRepair.mode !== 'white') throw new Error('この試作は白背景の元画像を使います。背景補正のある別設計とは分けてください');
  const checked = await validateImage({ dataUrl: project.imageDataUrl });
  if (checked.image.id !== doc.input.image.id || checked.image.widthPx !== doc.input.image.widthPx || checked.image.heightPx !== doc.input.image.heightPx) throw new Error('試作の画像と設計が一致しません');
  const reference = await createPrototypeProject();
  if (doc.input.image.id !== reference.document.input.image.id || doc.input.direction !== 'right') throw new Error('この準備スクリプトは開発者作成の魚を右へ動かす試作専用です');
  const outDir = resolve(options.outDir ?? 'artifacts/goal004/prototype'); await mkdir(outDir, { recursive: true });
  const previousPdf = await readFile(resolve(outDir, 'kit.pdf')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (previousPdf && !(await PDFDocument.load(previousPdf)).getSubject()?.includes(doc.designHash)) throw new Error('出力先のkit.pdfは別の設計版です。新しい出力フォルダで元のキットを保存してください');
  const output = (name: string, value: string | Uint8Array) => writeFile(resolve(outDir, name), value);
  const json = (name: string, value: unknown) => output(name, `${JSON.stringify(value, null, 2)}\n`);
  const fontBytes = await readFile(new URL('../apps/web/public/fonts/ZenKakuGothicNew-Regular.ttf', import.meta.url));
  await output('developer-fish-source.svg', PROTOTYPE_SOURCE_SVG);
  await output('source.png', Buffer.from(project.imageDataUrl.split(',')[1]!, 'base64'));
  await json('prototype.ugoku.json', { ...project, document: doc });
  await json('design.json', doc);
  await json('checks.json', { designId: doc.designId, revision: doc.revision, designHash: doc.designHash, checks: kit.checks, physicalValidation: 'unverified' });
  await json('materials.json', { designId: doc.designId, revision: doc.revision, designHash: doc.designHash, patternSheets: doc.layout.sheets, instructionPages: INSTRUCTION_PAGE_COUNT, materials: getMaterials(doc) });
  await json('assembly.json', { designId: doc.designId, revision: doc.revision, designHash: doc.designHash, steps: getAssemblySteps(doc) });
  const pdfBytes = await generatePdf(doc, { imageDataUrl: project.imageDataUrl, fontBytes });
  await output('core-kit.pdf', pdfBytes);
  for (let page = 1; page <= doc.layout.sheets; page++) await output(`pattern-${page}.svg`, generateSvg(doc, page, { imageDataUrl: project.imageDataUrl }));
  for (const step of getAssemblySteps(doc)) await output(`assembly-${step.number}.svg`, generateAssemblySvg(doc, step.number));
  for (const [name, travel] of [['start', 0], ['end', doc.input.travelMm]] as const) {
    const svg = expectedFront(project, travel); await output(`expected-${name}.svg`, svg);
    await output(`expected-${name}.png`, await sharp(Buffer.from(svg)).png().toBuffer());
  }
  const feasible = [20, 25].map(travelMm => {
    const candidate = applyDesignPatch(doc, { travelMm }), summary = getKitSummary(candidate);
    return { travelMm, status: summary.status, patternSheets: summary.patternSheets, widthMm: candidate.input.widthMm, heightMm: candidate.input.heightMm, designHash: candidate.designHash, failures: summary.checks.filter(check => check.status === 'fail') };
  });
  const tooLong = applyDesignPatch(doc, { travelMm: 70 });
  const sourcePixels = await sharp(Buffer.from(project.imageDataUrl.split(',')[1]!, 'base64')).extract({ left: doc.input.selection.x, top: doc.input.selection.y, width: doc.input.selection.width, height: doc.input.selection.height }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bounds = { left: sourcePixels.info.width, top: sourcePixels.info.height, right: -1, bottom: -1 };
  for (let y = 0; y < sourcePixels.info.height; y++) for (let x = 0; x < sourcePixels.info.width; x++) {
    const offset = (y * sourcePixels.info.width + x) * sourcePixels.info.channels;
    if ([0, 1, 2].some(channel => sourcePixels.data[offset + channel]! < 250)) { bounds.left = Math.min(bounds.left, x); bounds.top = Math.min(bounds.top, y); bounds.right = Math.max(bounds.right, x); bounds.bottom = Math.max(bounds.bottom, y); }
  }
  const containedContour = bounds.left > 0 && bounds.top > 0 && bounds.right < sourcePixels.info.width - 1 && bounds.bottom < sourcePixels.info.height - 1;
  if (!containedContour) throw new Error('元画像の輪郭が選択境界にかかっています');
  if (feasible.some(candidate => candidate.status === 'blocked' || candidate.patternSheets !== doc.layout.sheets || candidate.widthMm !== doc.input.widthMm || candidate.heightMm !== doc.input.heightMm)) throw new Error('L1の余地を保った試作条件ではありません');
  const contains = (outer: { x: number; y: number; width: number; height: number }, inner: typeof outer) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
  await json('construction-audit.json', { designId: doc.designId, revision: doc.revision, designHash: doc.designHash, scope: 'Analytical geometry and printed instructions only; no physical assembly was performed.', sourceSelection: doc.input.selection, sourceInkBoundsWithinSelectionPx: bounds, contourContainedInSelection: containedContour, handleExposureMm: kit.handleExposureMm, slotMm: doc.motion.slot, movingPaperMm: getArtworkComposition(doc).movingPaper, fullSlotCoveredByMovingPaperAtStartAndEnd: [0, doc.motion.maxMm].every(travel => contains(getPartPose(doc, 'M1', travel), doc.motion.slot)), endpointPartPoses: [0, doc.motion.maxMm].map(travelMm => ({ travelMm, parts: Object.fromEntries(doc.parts.map(part => [part.id, getPartPose(doc, part.id, travelMm)])) })), guideInternalWidthMm: 14 + 2 * doc.input.clearanceMm, guideHeightMm: 2 * doc.input.paperThicknessMm + .5, connectorBlankSectionsMm: [6, 2, 6], unverified: ['実際の紙厚、のり・テープの厚み、折りの曲げ半径', '高さ1 mmのガイドを折る作業性と摩擦', 'C1の表裏接着と2 mmの立ち上がりの作業性', '接着強度、たわみ、10往復後の変化'], geometryChangedForThisPrototype: false });
  const manifest = { mode, liveRunId: options.liveRunId ?? null, designId: doc.designId, revision: doc.revision, designHash: doc.designHash, imageId: doc.input.image.id, source: 'Original developer-authored SVG, normalized through the production image validator; no AI image generation or personal artwork.', files: { project: 'prototype.ugoku.json', preparedPdf: 'core-kit.pdf', canonicalBrowserPdf: 'kit.pdf', expectedStart: 'expected-start.png', expectedEnd: 'expected-end.png', form: 'physical-record-blank.json', constructionAudit: 'construction-audit.json' }, preparedPdfSha256: createHash('sha256').update(pdfBytes).digest('hex'), patternSheets: doc.layout.sheets, instructionPages: INSTRUCTION_PAGE_COUNT, physicalValidation: 'unverified', humanUsabilityTest: 'not-performed', expectedViews: 'Generated from the same design geometry, not photographs or a report of physical operation.', l1FeasibilityExamples: feasible, l2ActualViolation: { requestedTravelMm: 70, status: getKitSummary(tooLong).status, failures: getKitSummary(tooLong).checks.filter(check => check.status === 'fail') }, browserExport: previousPdf ? 'existing kit.pdf has matching designHash; browser evidence is recorded separately' : 'pending; root captures the same revision through the normal app and writes kit.pdf' };
  await json('manifest.json', manifest);
  await json('physical-record-blank.json', {
    status: 'not-performed', designId: doc.designId, revision: doc.revision, designHash: doc.designHash, pdf: 'kit.pdf', browserDefaultFilename: `${doc.designId}-r${doc.revision}.pdf`,
    printedOn: '', printer: '', printScale: '', calibration50mmMeasured: '', paperType: '', paperThicknessMeasured: '', adhesive: '',
    assemblyOutsideInstructions: '', start: '', middle: '', end: '', guideRetention: '', glueFaces: '', repeatedCycles: '', changesAfter10Cycles: '',
    photos: { front: '', back: '', start: '', end: '', calibration: '' }, nextChanges: '',
  });
  const inventory = doc.parts.map(part => `| ${part.id} | ${part.label} | ${part.widthMm} × ${part.heightMm} mm |`).join('\n');
  await output('assembly-and-record.md', `# 試作004・同じ版の組み立てと未記入の確認票\n\n${doc.designId} / 第${doc.revision}版 / SHA-256 ${doc.designHash}\n\n実行区分: ${mode === 'manual' ? '手動設計（実Geminiの成果ではありません）' : `実Geminiの採用版・runId ${options.liveRunId}`}。**実物未確認**。印刷対象は通常UIから得る [kit.pdf](kit.pdf)。準備用の同設計PDFは [core-kit.pdf](core-kit.pdf)。\n\nA4型紙 ${doc.layout.sheets}枚、説明書 ${INSTRUCTION_PAGE_COUNT}ページは別。想定紙厚 ${doc.input.paperThicknessMm} mm、片側すき間 ${doc.input.clearanceMm} mm。のり・定規・はさみ・カッター・カッターマット・先の丸い折り筋道具。\n\n| 部品 | 用途 | 切り出し寸法 |\n|---|---|---|\n${inventory}\n\n${getAssemblySteps(doc).map(step => `## ${step.number}. ${step.title}\n\n${step.description}\n\n${[...step.glueInstructions,...step.doNotGlue].map(text=>`- ${text}`).join('\n')}\n\n![工程${step.number}](assembly-${step.number}.svg)`).join('\n\n')}\n\n## 実物の記録（すべて未実施）\n\n1. 100%で印刷し、50mm校正線の実測値を記入する。用紙に合わせる縮小を無効にする。\n2. 工程外の切り直し・折り直し・接着位置変更があれば、部品IDと変更寸法を記録し元型紙を残す。\n3. 始点・途中・終点で引っかかり、G1/G2の保持、S2/G2とS1/G1の接触を確認する。\n4. 10往復程度を初期チェックとして記録する。耐久性保証とはしない。\n5. 正面・裏面・始点・終点・校正線を記録する。写真は本人が撮影したものだけを使う。\n\n| 項目 | 実測・観察（空欄は未実施） |\n|---|---|\n| 印刷日時・印刷機・倍率 | |\n| 50mm校正線の実測 | |\n| 紙の種類・厚さ・接着剤 | |\n| 工程外の変更（部品・寸法・理由） | |\n| 始点・途中・終点の引っかかり | |\n| 両ガイドの保持・止まり方・接着面 | |\n| 往復回数・10往復後の変化 | |\n| 正面・裏面・両端・校正線の写真 | |\n| 次の版で直すこと | |\n\n[空欄JSON](physical-record-blank.json)はアプリの実物記録へ自動登録しません。実測後はアプリでこの設計ID・版・hashへ記録してください。\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out' || !args[1])) throw new Error('使い方: npx tsx scripts/prepare-prototype.ts [--out 出力先]');
  const project = await createPrototypeProject();
  const manifest = await writePrototypeBundle(project, { outDir: args[1] });
  console.log(JSON.stringify({ mode: manifest.mode, designId: manifest.designId, revision: manifest.revision, designHash: manifest.designHash, patternSheets: manifest.patternSheets, instructionPages: manifest.instructionPages, physicalValidation: manifest.physicalValidation }, null, 2));
}

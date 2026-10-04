import { getAssemblySteps, getPartPose, parseDesignDocument, type DesignDocument, type Rect } from '@ugoku/core';

export type DiagramMark =
  | { kind: 'rect'; rect: Rect; added?: boolean; dashed?: boolean; partId?: string; stage?: 'before' | 'after' }
  | { kind: 'line'; points: { x: number; y: number }[]; dashed?: boolean; added?: boolean }
  | { kind: 'text'; x: number; y: number; text: string; size?: number };
export type AssemblyDiagram = { width: 190; height: 67; marks: DiagramMark[]; designHash: string; revision: number };
const n = (value: number) => Number(value.toFixed(3));
/** Both PDF and SVG draw this same list, calculated from the saved design's parts. */
export function buildAssemblyDiagram(document: DesignDocument, stepNumber: number, japanese = true): AssemblyDiagram {
  const doc = parseDesignDocument(document), step = getAssemblySteps(doc).find(s => s.number === stepNumber);
  if (!step) throw new Error('組み立て工程番号が不正です');
  const marks: DiagramMark[] = [];
  const text = (x: number, y: number, value: string, size = 2.7) => marks.push({ kind: 'text', x, y, text: value, size });
  const line = (points: number[][], added = false, dashed = false) => marks.push({ kind: 'line', points: points.map(([x, y]) => ({ x: x!, y: y! })), added, dashed });
  if (stepNumber === 1) {
    for (const [offset, after] of [[0, false], [100, true]] as const) {
      text(offset, 4, japanese ? (after ? '切り離す8部品（まだ組み立てない）' : `切る前：型紙${doc.layout.sheets}枚`) : (after ? 'AFTER: 8 separate parts' : `BEFORE: ${doc.layout.sheets} pattern sheets`));
      const scale = Math.min(88 / (doc.layout.sheets * 216), 49 / 297);
      for (let p = 1; p <= doc.layout.sheets; p++) {
        const px = offset + (p - 1) * 216 * scale;
        if (!after) marks.push({ kind: 'rect', rect: { x: px, y: 9, width: 210 * scale, height: 297 * scale }, dashed: true });
        for (const place of doc.layout.placements.filter(v => v.page === p)) {
          const part = doc.parts.find(v => v.id === place.partId)!;
          const r = { x: px + place.xMm * scale, y: 9 + place.yMm * scale, width: (place.rotated ? part.heightMm : part.widthMm) * scale, height: (place.rotated ? part.widthMm : part.heightMm) * scale };
          marks.push({ kind: 'rect', rect: r, added: after, partId: part.id, stage: after ? 'after' : 'before' });
          text(r.x, r.y + Math.min(r.height - .2, 2.5), part.id, 1.9);
        }
      }
    }
  } else if (stepNumber === 2) {
    text(0, 4, japanese ? '折る前：破線を確認' : 'BEFORE: flat parts');
    let x = 4;
    for (const id of ['G1', 'G2', 'C1']) {
      const p = doc.parts.find(v => v.id === id)!; const scale = 1.2;
      marks.push({ kind: 'rect', rect: { x, y: 14, width: p.widthMm * scale, height: p.heightMm * scale }, partId: id, stage: 'before' });
      for (const fold of p.folds) line([[x + fold.from.x * scale, 14 + fold.from.y * scale], [x + fold.to.x * scale, 14 + fold.to.y * scale]], false, true);
      text(x, 11, id); x += p.widthMm * scale + 13;
    }
    text(100, 4, japanese ? '折った後：断面（高さを強調）' : 'AFTER: cross sections (height exaggerated)');
    const guide = doc.parts.find(p => p.id === 'G1')!;
    const inside = guide.folds[2]!.from.y - guide.folds[1]!.from.y;
    const scale = 2.1, gx = 106;
    line([[gx, 24], [gx + 5 * scale, 24], [gx + 5 * scale, 14], [gx + (inside + 5) * scale, 14], [gx + (inside + 5) * scale, 24], [gx + (inside + 10) * scale, 24]], true);
    text(gx, 11, 'G1 / G2'); text(gx + 5 * scale, 21, `${n(inside)} mm / T1`, 2.2);
    text(gx, 29, japanese ? '足の裏だけ接着' : 'GLUE under feet only', 2.4);
    const c = doc.parts.find(p => p.id === 'C1')!, bottom = c.heightMm - c.folds[1]!.from.y, top = c.folds[0]!.from.y;
    line([[gx, 51], [gx + bottom * 3, 51], [gx + bottom * 3, 42], [gx + (bottom + top) * 3, 42]], true);
    text(gx, 38, `C1: ${top} / ${c.folds[1]!.from.y - top} / ${bottom} mm`, 2.5);
    text(gx + bottom * 3 + 1, 40, japanese ? 'M1：印面に糊' : 'M1: printed face', 2.3);
    text(gx, 56, japanese ? 'T1：印の裏に糊' : 'T1: blank underside', 2.3);
  } else {
    const face = 'back' as const;
    // Use identical bounds for before/after, including the extended handle at full travel.
    const completePoses = doc.parts.flatMap(p => [getPartPose(doc, p.id, 0, face), getPartPose(doc, p.id, doc.motion.maxMm, face)]);
    const minX = Math.min(...completePoses.map(r => r.x)) - 4, minY = Math.min(...completePoses.map(r => r.y)) - 4;
    const maxX = Math.max(...completePoses.map(r => r.x + r.width)) + 4, maxY = Math.max(...completePoses.map(r => r.y + r.height)) + 4;
    const scale = Math.min(62 / (maxX - minX), 44 / (maxY - minY));
    for (const [offset, after] of [[0, false], [100, true]] as const) {
      const ids = after ? step.afterPartIds : step.beforePartIds;
      const travel = stepNumber === 6 && after ? doc.motion.maxMm : 0;
      text(offset, 4, stepNumber === 6 ? (after ? `END / ${travel} mm` : 'START / 0 mm') : japanese ? (after ? `追加後：${step.addedPartIds.join('・') || 'なし'}` : '前の工程まで') : (after ? `AFTER: + ${step.addedPartIds.join(' ')}` : 'BEFORE'));
      const map = (r: Rect): Rect => ({ x: offset + 2 + (r.x - minX) * scale, y: 12 + (r.y - minY) * scale, width: r.width * scale, height: r.height * scale });
      const labels: { text: string; rect: Rect; added: boolean }[] = [];
      for (const id of ids) {
        const p = doc.parts.find(v => v.id === id)!, r = map(getPartPose(doc, id, travel, face));
        const added = after && step.addedPartIds.includes(id);
        marks.push({ kind: 'rect', rect: r, added, dashed: p.layer === 'front', partId: id, stage: after ? 'after' : 'before' });
        if (id === 'B1') text(r.x + .4, r.y + 2.5, 'B1', 2.2);
        else labels.push({ text: `${added ? '+' : ''}${id}`, rect: r, added });
      }
      // Leaders keep narrow vertical guides and overlapping front/back layers readable.
      labels.sort((a, b) => a.rect.y + a.rect.height / 2 - b.rect.y - b.rect.height / 2);
      const labelY = labels.map((label, i) => Math.max(16 + i * 4, Math.min(31, label.rect.y + label.rect.height / 2)));
      for (let i = 1; i < labelY.length; i++) labelY[i] = Math.max(labelY[i]!, labelY[i - 1]! + 4);
      const lift = Math.max(0, (labelY.at(-1) ?? 0) - 56);
      labels.forEach((label, i) => {
        const ly = labelY[i]! - lift;
        line([[label.rect.x + label.rect.width, label.rect.y + label.rect.height / 2], [offset + 66, ly - .8]], label.added);
        text(offset + 67, ly, label.text, 2.6);
      });
      const base = map(getPartPose(doc, 'B1', 0, face));
      text(base.x + base.width - 9, base.y + 2.5, 'TOP', 2);
      const slot = map({ ...doc.motion.slot, x: doc.input.widthMm - doc.motion.slot.x - doc.motion.slot.width });
      marks.push({ kind: 'rect', rect: slot });
      if (ids.includes('T1')) {
        const a = doc.motion.axis;
        const tip = map(getPartPose(doc, 'T1', travel, face));
        const ax = -a.x, ay = a.y;
        const cx = ax > 0 ? tip.x + tip.width : ax < 0 ? tip.x : tip.x + tip.width / 2;
        const cy = ay > 0 ? tip.y + tip.height : ay < 0 ? tip.y : tip.y + tip.height / 2;
        line([[cx - ax * 6, cy - ay * 6], [cx, cy]], true);
        line([[cx - ax * 2 - ay, cy - ay * 2 + ax], [cx, cy], [cx - ax * 2 + ay, cy - ay * 2 - ax]], true);
      }
      text(offset, 61, japanese ? '裏側 / 上辺を上にして左右に裏返す' : 'BACK / Turn left-to-right; TOP stays up', 2.2);
    }
  }
  text(0, 66, japanese ? '太線と「+」=今回追加 / 破線のM1=表の絵を透かした位置 / 図は原寸ではありません' : 'Heavy outline + = newly added / dashed M1 = front picture shown through / NOT ACTUAL SIZE', 2.15);
  return { width: 190, height: 67, marks, designHash: doc.designHash, revision: doc.revision };
}
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
export function generateAssemblySvg(document: DesignDocument, stepNumber: number): string {
  const d = buildAssemblyDiagram(document, stepNumber);
  const body = d.marks.map(m => m.kind === 'text' ? `<text x="${m.x}" y="${m.y}" font-size="${m.size ?? 2.7}">${escape(m.text)}</text>` : m.kind === 'rect' ? `<rect x="${m.rect.x}" y="${m.rect.y}" width="${m.rect.width}" height="${m.rect.height}" fill="none" stroke="${m.added ? '#1a2721' : '#727773'}" stroke-width="${m.added ? .6 : .25}"${m.dashed ? ' stroke-dasharray="1 .8"' : ''}${m.partId ? ` data-part-id="${m.partId}" data-stage="${m.stage}" data-added="${!!m.added}"` : ''}/>` : `<polyline points="${m.points.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#24382c" stroke-width="${m.added ? .55 : .25}"${m.dashed ? ' stroke-dasharray="1 .8"' : ''}/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="950" height="335" viewBox="0 0 190 67" data-design-hash="${d.designHash}" data-revision="${d.revision}"><title>工程${stepNumber} 前後の状態</title><rect width="190" height="67" fill="white"/><g font-family="sans-serif" fill="#24382c">${body}</g></svg>`;
}

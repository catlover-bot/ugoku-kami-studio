import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ArtworkComposition, ArtworkRepair, AssemblyStep, CheckResult, DesignDocument, DesignInput, DesignPatch, Direction, Part, Point, Rect } from './types.js';
export type * from './types.js';

const finite = z.number().finite();
export const RectSchema = z.object({ x: finite.min(0).max(100000), y: finite.min(0).max(100000), width: finite.positive().max(100000), height: finite.positive().max(100000) }).strict();
export const ImageSourceSchema = z.object({ id: z.string().min(1).max(100), widthPx: finite.int().min(1).max(8192), heightPx: finite.int().min(1).max(8192), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']) }).strict().refine(i => i.widthPx * i.heightPx <= 12_000_000, '展開後の画像は1200万画素以下にしてください');
export const ArtworkRepairSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('white') }).strict(),
  z.object({ mode: z.literal('solid'), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).transform(color => color.toLowerCase()) }).strict(),
  z.object({ mode: z.literal('image'), image: ImageSourceSchema.refine(image => /^[a-f0-9]{64}$/.test(image.id), '背景画像には内容のSHA-256識別情報が必要です') }).strict(),
]);
const inputFields = {
  title: z.string().trim().min(1).max(80),
  image: ImageSourceSchema,
  artworkRepair: ArtworkRepairSchema.optional(),
  selection: RectSchema,
  direction: z.enum(['right', 'left', 'up', 'down']),
  travelMm: finite.min(2).max(70),
  widthMm: finite.min(60).max(260),
  heightMm: finite.min(60).max(260),
  maxSheets: finite.int().min(1).max(8),
  paperThicknessMm: finite.min(0.1).max(0.6),
  clearanceMm: finite.min(0.3).max(2),
  locks: z.array(z.enum(['travelMm', 'direction', 'widthMm', 'heightMm', 'maxSheets', 'selection', 'paperThicknessMm', 'clearanceMm'])).max(8),
};
export const DesignInputSchema = z.object(inputFields).strict().superRefine((input, ctx) => {
  const r = input.selection;
  if (r.x + r.width > input.image.widthPx || r.y + r.height > input.image.heightPx) ctx.addIssue({ code: 'custom', path: ['selection'], message: '選択範囲を画像内に収めてください' });
  if (new Set(input.locks).size !== input.locks.length) ctx.addIssue({ code: 'custom', path: ['locks'], message: '固定条件が重複しています' });
});
export const DesignPatchSchema = z.object({ title: inputFields.title.optional(), direction: inputFields.direction.optional(), travelMm: inputFields.travelMm.optional(), widthMm: inputFields.widthMm.optional(), heightMm: inputFields.heightMm.optional(), maxSheets: inputFields.maxSheets.optional(), paperThicknessMm: inputFields.paperThicknessMm.optional(), clearanceMm: inputFields.clearanceMm.optional(), selection: RectSchema.optional() }).strict();
export const SAMPLE_INPUT: DesignInput = { title: '首をのばすカメ', image: { id: 'sample-turtle-v1', widthPx: 800, heightPx: 550, mimeType: 'image/png' }, selection: { x: 520, y: 170, width: 200, height: 160 }, direction: 'right', travelMm: 20, widthMm: 160, heightMm: 110, maxSheets: 2, paperThicknessMm: 0.25, clearanceMm: 0.8, locks: [] };
export const mmToPt = (mm: number): number => { if (!Number.isFinite(mm)) throw new Error('mm must be finite'); return mm * 72 / 25.4; };
export const ptToMm = (pt: number): number => { if (!Number.isFinite(pt)) throw new Error('pt must be finite'); return pt * 25.4 / 72; };
const round = (n: number): number => Math.round(n * 1000000) / 1000000;
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}
function hash(value: unknown): string { return bytesToHex(sha256(new TextEncoder().encode(stableStringify(value)))); }
/** Contain-fit image on the base; no hidden stretch or crop. */
export function artworkPlacement(input: DesignInput): Rect {
  const scale = Math.min(input.widthMm / input.image.widthPx, input.heightMm / input.image.heightPx);
  const width = input.image.widthPx * scale, height = input.image.heightPx * scale;
  return { x: round((input.widthMm - width) / 2), y: round((input.heightMm - height) / 2), width: round(width), height: round(height) };
}
export function selectionToMm(input: DesignInput): Rect {
  const p = artworkPlacement(input), s = input.selection;
  const scale = p.width / input.image.widthPx;
  return { x: round(p.x + s.x * scale), y: round(p.y + s.y * scale), width: round(s.width * scale), height: round(s.height * scale) };
}
/** Pointer rectangle in CSS pixels to source pixels, respecting contain-fit letterboxing. */
export function screenSelectionToPixels(rect: Rect, viewport: { width: number; height: number }, image: { widthPx: number; heightPx: number }): Rect {
  if (![viewport.width, viewport.height, image.widthPx, image.heightPx].every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid viewport');
  const scale = Math.min(viewport.width / image.widthPx, viewport.height / image.heightPx);
  const ox = (viewport.width - image.widthPx * scale) / 2, oy = (viewport.height - image.heightPx * scale) / 2;
  const x = Math.max(0, Math.min(image.widthPx, (rect.x - ox) / scale));
  const y = Math.max(0, Math.min(image.heightPx, (rect.y - oy) / scale));
  const right = Math.max(x, Math.min(image.widthPx, (rect.x + rect.width - ox) / scale));
  const bottom = Math.max(y, Math.min(image.heightPx, (rect.y + rect.height - oy) / scale));
  if (right <= x || bottom <= y) throw new Error('画像の内側を選択してください');
  return { x: round(x), y: round(y), width: round(right - x), height: round(bottom - y) };
}
function axis(direction: Direction): Point { return { right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, down: { x: 0, y: 1 }, up: { x: 0, y: -1 } }[direction]; }
function localSystem(input: DesignInput) {
  const horizontal = input.direction === 'right' || input.direction === 'left';
  const length = horizontal ? input.widthMm : input.heightMm;
  const breadth = horizontal ? input.heightMm : input.widthMm;
  const point = (u: number, v: number): Point => input.direction === 'right' ? { x: u, y: v } : input.direction === 'left' ? { x: input.widthMm - u, y: v } : input.direction === 'down' ? { x: v, y: u } : { x: v, y: input.heightMm - u };
  const rect = (u: number, v: number, w: number, h: number): Rect => {
    const a = point(u, v), b = point(u + w, v + h);
    return { x: round(Math.min(a.x, b.x)), y: round(Math.min(a.y, b.y)), width: round(Math.abs(a.x - b.x)), height: round(Math.abs(a.y - b.y)) };
  };
  const art = selectionToMm(input), cx = art.x + art.width / 2, cy = art.y + art.height / 2;
  const u = input.direction === 'right' ? cx : input.direction === 'left' ? input.widthMm - cx : input.direction === 'down' ? cy : input.heightMm - cy;
  return { length, breadth, point, rect, u, v: horizontal ? cy : cx, horizontal };
}
export function arrangeParts(parts: Part[]): DesignDocument['layout'] {
  const placements: DesignDocument['layout']['placements'] = [], unplacedPartIds: string[] = [];
  let page = 1, x = 10, y = 35, rowHeight = 0;
  const right = 200, bottom = 272, gap = 7;
  for (const part of parts) {
    // Prefer the narrower paper dimension. This is a bounded shelf heuristic, not optimal packing.
    const rotated = part.widthMm > 190 && part.heightMm <= 190;
    const w = rotated ? part.heightMm : part.widthMm, h = rotated ? part.widthMm : part.heightMm;
    if (w > 190 || h > 237) { unplacedPartIds.push(part.id); continue; }
    if (x + w > right) { x = 10; y += rowHeight + gap; rowHeight = 0; }
    if (y + h > bottom) { page++; x = 10; y = 35; rowHeight = 0; }
    placements.push({ partId: part.id, page, xMm: round(x), yMm: round(y), rotated });
    x += w + gap; rowHeight = Math.max(rowHeight, h);
  }
  return { pageWidthMm: 210, pageHeightMm: 297, marginMm: 10, sheets: placements.length ? page : 0, placements, unplacedPartIds, algorithm: 'deterministic-shelf-v1' };
}

export function createDesign(raw: DesignInput, options: { designId?: string; revision?: number } = {}): DesignDocument {
  const input = DesignInputSchema.parse(raw);
  // Absent repair stays absent: v1 documents must retain their exact canonical hash.
  if (input.artworkRepair === undefined) delete input.artworkRepair;
  input.locks = [...input.locks].sort();
  const inputHash = hash(input);
  const designId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(options.designId ?? `design-${inputHash.slice(0, 12)}`);
  const revision = z.number().int().min(1).max(1000000).parse(options.revision ?? 1);
  const s = localSystem(input), T = input.travelMm, c = input.clearanceMm;
  const guideHeight = round(input.paperThicknessMm * 2 + 0.5);
  const guideInside = 14 + 2 * c, guideBlank = round(10 + 2 * guideHeight + guideInside);
  // Keep both guides outside the ENTIRE connector sweep. Try the trailing side first.
  const behind = s.u >= T + 58;
  const g1 = behind ? s.u - 43 : s.u + T + 18, g2 = g1 + 25;
  const tabStart = Math.min(s.u - 8, g1 - 13 - T), tabEnd = Math.max(s.length + 18, g2 + 18);
  const tabLength = round(tabEnd - tabStart);
  const slot = s.rect(s.u - 5, s.v - 1.5, T + 10, 3);
  const art = selectionToMm(input);
  const guideFootV = s.v - guideInside / 2 - 5;
  const guideAssembly = (g: number) => s.rect(g - 5, guideFootV, 10, guideInside + 10);
  const part = (id: string, label: string, role: Part['role'], w: number, h: number, layer: Part['layer'], assembly: Rect, attachedTo: string[]): Part => ({ id, label, role, widthMm: round(w), heightMm: round(h), layer, assembly, attachedTo, cuts: [], folds: [], glue: [] });
  const base = part('B1', '固定台紙', 'base', input.widthMm, input.heightMm, 'base', { x: 0, y: 0, width: input.widthMm, height: input.heightMm }, []);
  base.cuts.push(slot);
  // Footprints are deliberately dashed glue areas, distinct from through cuts.
  for (const g of [g1, g2]) {
    base.glue.push({ rect: s.rect(g - 5, guideFootV, 10, 5), label: 'BACK: guide foot' }, { rect: s.rect(g - 5, s.v + guideInside / 2, 10, 5), label: 'BACK: guide foot' });
  }
  const moving = part('M1', '可動する絵', 'artwork', art.width, art.height, 'front', art, ['C1']);
  const tab = part('T1', '引っぱりタブ', 'pull-tab', tabLength, 14, 'back', s.rect(tabStart, s.v - 7, tabLength, 14), ['C1', 'S1', 'S2']);
  tab.glue.push({ rect: { x: round(s.u - 4 - tabStart), y: 7, width: 8, height: 6 }, label: 'C1 bottom' });
  tab.glue.push({ rect: { x: round(g1 - 13 - T - tabStart), y: 0, width: 8, height: 14 }, label: 'S1 after threading' }, { rect: { x: round(g2 + 5 - tabStart), y: 0, width: 8, height: 14 }, label: 'S2 after threading' });
  const guides = [g1, g2].map((g, index) => {
    const guide = part(`G${index + 1}`, `ガイド ${index + 1}`, 'guide', 10, guideBlank, 'back', guideAssembly(g), ['B1']);
    guide.folds = [5, 5 + guideHeight, 5 + guideHeight + guideInside, 5 + 2 * guideHeight + guideInside].map(y => ({ from: { x: 0, y: round(y) }, to: { x: 10, y: round(y) } }));
    guide.glue = [{ rect: { x: 0, y: 0, width: 10, height: 5 }, label: 'B1 back ONLY' }, { rect: { x: 0, y: round(guideBlank - 5), width: 10, height: 5 }, label: 'B1 back ONLY' }];
    return guide;
  });
  const stopper1 = part('S1', '抜け止め・最大位置', 'stopper', 8, 22, 'back', s.rect(g1 - 13 - T, s.v - 11, 8, 22), ['T1']);
  const stopper2 = part('S2', '抜け止め・開始位置', 'stopper', 8, 22, 'back', s.rect(g2 + 5, s.v - 11, 8, 22), ['T1']);
  for (const st of [stopper1, stopper2]) st.glue.push({ rect: { x: 0, y: 4, width: 8, height: 14 }, label: 'T1 ONLY' });
  const connector = part('C1', '絵とタブの接続片', 'connector', 8, 14, 'back', s.rect(s.u - 4, s.v - 6, 8, 12), ['M1', 'T1']);
  connector.folds = [6, 8].map(y => ({ from: { x: 0, y }, to: { x: 8, y } }));
  connector.glue = [{ rect: { x: 0, y: 0, width: 8, height: 6 }, label: 'M1 back' }, { rect: { x: 0, y: 8, width: 8, height: 6 }, label: 'T1 front' }];
  const parts = [base, moving, tab, ...guides, stopper1, stopper2, connector];
  const layout = arrangeParts(parts);
  const schemaVersion = input.artworkRepair ? 2 as const : 1 as const;
  const mask: DesignDocument['artwork']['mask'] = input.artworkRepair?.mode === 'solid' ? 'solid-rectangle' : input.artworkRepair?.mode === 'image' ? 'image-rectangle' : 'white-rectangle';
  const geometry = { unit: 'mm' as const, mechanism: 'single-pull-tab' as const, input, artwork: { placement: artworkPlacement(input), selectionMm: art, mask }, motion: { direction: input.direction, axis: axis(input.direction), minMm: 0 as const, maxMm: T, connector: s.point(s.u, s.v), guideCenters: [s.point(g1, s.v), s.point(g2, s.v)], slot }, parts, layout };
  const designHash = hash({ schemaVersion, ...geometry });
  const checks: CheckResult[] = [];
  const add = (id: string, pass: boolean | null, message: string, partIds: string[], scope: string, suggestion?: string) => checks.push({ id, status: pass === null ? 'unknown' : pass ? 'pass' : 'fail', message, partIds, scope, designHash, ...(suggestion ? { suggestion } : {}) });
  const finiteParts = parts.every(p => [p.widthMm, p.heightMm].every(n => Number.isFinite(n) && n >= 4));
  add('part-dimensions', finiteParts && art.width >= 14 && art.height >= 16, '可動絵は14 × 16 mm以上、全部品は正の有限寸法である必要があります。', parts.map(p => p.id), '全生成部品の寸法', '選択範囲または作品サイズを大きくしてください。');
  const guidesInside = g1 - 5 >= 3 && g2 + 5 <= s.length - 3 && guideFootV >= 3 && guideFootV + guideInside + 10 <= s.breadth - 3;
  add('guides-on-base', guidesInside, 'G1・G2の接着足は台紙の縁から3 mm以上内側に必要です。', ['B1', 'G1', 'G2'], 'ガイドの接着足の全領域', '移動距離を短くするか、選択範囲を台紙の中央付近へ移してください。');
  const coverage = tabStart + T <= g1 - 5 && tabEnd >= g2 + 5;
  add('guide-engagement', coverage, `全移動区間 0〜${T} mmでT1がG1・G2の両方を通ります。`, ['T1', 'G1', 'G2'], `連続区間 [0, ${T}] mm：線形不等式による端点と区間全体の検査`);
  const slotFits = slot.x >= 3 && slot.y >= 3 && slot.x + slot.width <= input.widthMm - 3 && slot.y + slot.height <= input.heightMm - 3;
  add('slot-contained', slotFits, `B1の切り込みは接続片8 mm＋移動${T} mm＋両端各1 mm。台紙内に3 mmの縁を残します。`, ['B1', 'C1'], `全移動区間 [0, ${T}] mm`, '距離を短くするか、動かす部分を縁から離してください。');
  const connectorSweepClear = [g1, g2].every(g => s.u + T + 4 < g - 5 || s.u - 4 > g + 5);
  add('back-layer-clearance', connectorSweepClear, '接続片C1の移動区間と背面ガイドは同じ層で重なりません。絵と台紙の投影上の重なりは許容します。', ['C1', 'G1', 'G2'], `背面の連続移動区間 [0, ${T}] mm`);
  add('stopper-range', 22 > guideInside && T >= 2, 'S1は最大位置でG1に、S2は開始位置でG2に当たり、タブの抜けを防ぎます。', ['S1', 'S2', 'G1', 'G2'], '理想化された剛体平面で0 mmと最大位置の接触');
  add('page-fit', layout.unplacedPartIds.length === 0, layout.unplacedPartIds.length ? `A4の配置枠に収まらない部品: ${layout.unplacedPartIds.join(', ')}。自動縮小はしていません。` : 'すべての部品を余白付きA4に原寸配置しました。', layout.unplacedPartIds, '単純棚詰め配置。すべての配置が不可能であることの証明ではありません。', '作品サイズや移動距離を小さくしてください。');
  add('sheet-budget', layout.sheets <= input.maxSheets && layout.unplacedPartIds.length === 0, `型紙は${layout.sheets}枚、使用可能な紙は${input.maxSheets}枚です。説明ページは別です。`, parts.map(p => p.id), '固定台紙・可動絵・ガイド・タブ・接続片・抜け止めを含む全パーツ', '用紙枚数を増やすか作品サイズを小さくしてください。');
  add('locks-preserved', true, input.locks.length ? `固定条件: ${input.locks.join(', ')}。変更時は元の設計と照合します。` : '固定条件は設定されていません。', [], 'この版の入力。パッチ適用時に元の固定値と照合');
  add('physical-operation', null, '実物未検証。紙厚・摩擦・接着剤・折り精度・耐久性は実物で確認してください。', parts.map(p => p.id), '幾何検査では実際の動作・強度を保証しません');
  const repairAssumption = input.artworkRepair?.mode === 'solid' ? `可動絵の元位置は作者が選んだ単色${input.artworkRepair.color}で印刷します。背景の復元ではありません。可動絵は白い矩形の紙です。` : input.artworkRepair?.mode === 'image' ? '作者が指定した背景画像を原絵全体へ中央合わせで拡大・縮小し、元位置の矩形だけに印刷します。自動復元ではなく、追加部品もありません。可動絵は白い矩形の紙です。' : '可動絵の元位置は白い矩形で覆います。背景補完ではありません。';
  return { schemaVersion, designId, revision, designHash, ...geometry, checks, assumptions: [`紙厚${input.paperThicknessMm} mm、横すき間片側${c} mm、ガイド高さ${guideHeight} mmは未実測の設計仮定です。`, repairAssumption, 'C1は6 / 2 / 6 mmのZ折り。G1・G2の足だけをB1の裏に接着し、T1の通路には糊を付けません。', '紙面配置は決定的な棚詰め法で、配置の最適性は保証しません。'], physicalValidation: 'unverified' };
}
export function parseDesignDocument(value: unknown): DesignDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('設計データが不正です');
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1 && v.schemaVersion !== 2) throw new Error('未対応の設計バージョンです');
  const document = createDesign(DesignInputSchema.parse(v.input), { designId: v.designId as string, revision: v.revision as number });
  if (stableStringify(document) !== stableStringify(value)) throw new Error('設計ハッシュ・部品参照・検査結果の不一致があります。元の入力から再設計してください。');
  return document;
}
export const DesignDocumentSchema = z.unknown().transform((value, ctx): DesignDocument => {
  try { return parseDesignDocument(value); } catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid design' }); return z.NEVER; }
});
export function applyDesignPatch(document: DesignDocument, rawPatch: DesignPatch): DesignDocument {
  const doc = parseDesignDocument(document), patch = DesignPatchSchema.parse(rawPatch);
  for (const key of doc.input.locks) if (key in patch && stableStringify(patch[key]) !== stableStringify(doc.input[key])) throw new Error(`固定された条件 ${key} は変更できません`);
  const next = createDesign({ ...doc.input, ...patch }, { designId: doc.designId, revision: doc.revision + 1 });
  return next.designHash === doc.designHash ? doc : next;
}
/** Explicit author action; intentionally excluded from AI's DesignPatchSchema. */
export function applyArtworkRepair(document: DesignDocument, rawRepair: ArtworkRepair): DesignDocument {
  const doc = parseDesignDocument(document), artworkRepair = ArtworkRepairSchema.parse(rawRepair);
  const next = createDesign({ ...doc.input, artworkRepair }, { designId: doc.designId, revision: doc.revision + 1 });
  return next.designHash === doc.designHash ? doc : next;
}
/** Shared print/preview composition in base-space mm. Transparent pixels reveal white paper. */
export function getArtworkComposition(document: DesignDocument): ArtworkComposition {
  const doc = parseDesignDocument(document), source = doc.artwork.placement, region = doc.artwork.selectionMm, repair = doc.input.artworkRepair;
  let background: ArtworkComposition['background'] = null;
  if (repair?.mode === 'image') {
    const scale = Math.max(source.width / repair.image.widthPx, source.height / repair.image.heightPx);
    const width = repair.image.widthPx * scale, height = repair.image.heightPx * scale;
    background = { image: repair.image, placement: { x: round(source.x + (source.width - width) / 2), y: round(source.y + (source.height - height) / 2), width: round(width), height: round(height) }, clip: region };
  }
  return { source, fixedMask: { rect: region, color: repair?.mode === 'solid' ? repair.color : '#ffffff' }, background, movingPaper: region };
}
export const validateDesign = (doc: DesignDocument): CheckResult[] => parseDesignDocument(doc).checks;
export const arrangePages = (doc: DesignDocument): DesignDocument['layout'] => parseDesignDocument(doc).layout;
export const canExport = (doc: DesignDocument): boolean => !doc.checks.some(c => c.status === 'fail');
export function assessMotionIntent(text: string): { supported: boolean; reason: string; alternative: string } {
  const unsupported = /回転|回す|ぐるぐる|振る|振り|揺|歩[く行]|歯車|立体|モーター|電子|rotate|rotation|swing|oscillat|walk|gear|motor|3d/i.test(text);
  return { supported: !unsupported, reason: unsupported ? 'この版は引っぱりタブの直線運動だけに対応しています。希望の動きは未対応です。' : '直線運動の範囲で寸法と配置を検討します。', alternative: '「首をまっすぐ出す」など、直線で動く案を選んでから再実行してください。' };
}
export function getAssemblySteps(document: DesignDocument): AssemblyStep[] {
  const d = parseDesignDocument(document);
  const all = d.parts.map(p => p.id), guided = ['B1', 'G1', 'G2', 'T1'], connected = [...guided, 'C1', 'M1'];
  return [
    { number: 1, title: '倍率を確かめ、8部品を切る', description: `実際のサイズ／100%で印刷し、用紙に合わせる縮小を無効にします。50 mmの校正線を測り、8部品の外周実線とB1の${round(Math.max(d.motion.slot.width, d.motion.slot.height))} × 3 mmの切り込みを切ります。M1は白い矩形の紙で、透明画素も白紙になります。${d.input.artworkRepair?.mode === 'image' ? '指定背景はB1に印刷済み。追加部品は不要です。' : d.input.artworkRepair?.mode === 'solid' ? '選んだ単色はB1の元位置に印刷済みです。' : ''}`, partIds: all, diagram: 'cut', view: 'separate', beforePartIds: [], addedPartIds: all, afterPartIds: all, glueInstructions: [], doNotGlue: ['この工程では接着しません。破線は切りません。'] },
    { number: 2, title: 'トンネルとZ形を折る', description: `G1・G2の4本の破線を折り、内幅${round(14 + 2 * d.input.clearanceMm)} mm、高さ${round(d.input.paperThicknessMm * 2 + 0.5)} mmのトンネルにします。C1は6 / 2 / 6 mmのZ形。印のある面を図の向きにそろえ、まだ糊を付けません。`, partIds: ['G1', 'G2', 'C1'], diagram: 'fold', view: 'separate', beforePartIds: all, addedPartIds: [], afterPartIds: all, glueInstructions: [], doNotGlue: ['C1中央2 mmとガイド中央は接着しません。'] },
    { number: 3, title: '裏側にガイドを付け、裸のタブを通す', description: 'B1の上辺を上に保ち左右に裏返します。裏面位置図の寸法を測り、G1・G2の足だけを接着します。C1・S1・S2を付ける前のT1を両ガイドに通し、T1の印刷面をB1に向けます。S2印の端をG2の端に合わせると始点です。', partIds: guided, diagram: 'guide', view: 'back', beforePartIds: ['B1'], addedPartIds: ['G1', 'G2', 'T1'], afterPartIds: guided, glueInstructions: ['G1・G2両端5 mmの×印の裏（無地面） → B1裏面。'], doNotGlue: ['T1の通路・ガイド中央・T1本体には糊を付けません。'] },
    { number: 4, title: 'C1を切り込みへ通してから、絵を接続する', description: 'B1を持ち上げ、表裏から手が入る状態にします。C1のM1側の足を細く立て、裏から切り込みを通して表へ出し、Z形に戻します。下側の足をT1のC1印へ接着。その後、表側の足へM1の裏を接着し、絵を選択した元位置に合わせます。', partIds: connected, diagram: 'connect', view: 'both', beforePartIds: guided, addedPartIds: ['C1', 'M1'], afterPartIds: connected, glueInstructions: ['C1のT1表示の裏（無地面） → T1のC1印刷面。', 'C1のM1表示面 → M1の裏（無地面）。上下の足は糊を付ける面が逆です。'], doNotGlue: ['B1・切り込み・C1中央2 mmは接着しません。'] },
    { number: 5, title: '通した後で、抜け止めを付ける', description: `S1・S2の中央14 mmをT1の同名印に接着します。S2がG2に当たる位置が始点。${d.input.travelMm} mm引くとS1がG1に当たる終点になります。ストッパーが台紙やガイドにも接着されていないことを確認します。`, partIds: all, diagram: 'stop', view: 'back', beforePartIds: connected, addedPartIds: ['S1', 'S2'], afterPartIds: all, glueInstructions: ['S1・S2中央14 mmの×印の裏 → T1の同名印刷面。'], doNotGlue: ['左右に出る各4 mmの羽、B1、G1・G2には接着しません。'] },
    { number: 6, title: '乾かして始点・途中・終点を確かめる', description: `十分に乾かし、外に出た引き手を持って0〜${d.input.travelMm} mmをゆっくり往復させます。始点と終点だけでなく途中も両ガイドで保持されるか確認。強く引かず、引っかかり・たわみ・手修正をこの設計版へ記録します。実物未確認の試作です。`, partIds: all, diagram: 'test', view: 'back', beforePartIds: all, addedPartIds: [], afterPartIds: all, glueInstructions: [], doNotGlue: ['動きが悪くても力で引かず、乾燥・通路・向き・糊のはみ出しを見直します。'] },
  ];
}
export function getMaterials(document: DesignDocument): { name: string; quantity: string; note: string }[] {
  const d = parseDesignDocument(document);
  return [{ name: 'A4の紙', quantity: `${d.layout.sheets}枚`, note: `型紙用。想定厚さ${d.input.paperThicknessMm} mm（未実測）。説明書は別。` }, { name: '型紙から切る機構部品', quantity: `${d.parts.length}個`, note: d.parts.map(p => `${p.id} ${p.label}`).join(' / ') }, { name: 'のり・両面テープ', quantity: '少量', note: '接着印の部分のみ。動く通路には付けない。' }, { name: 'はさみ・カッター・カッターマット', quantity: '各1', note: '刃物に注意。切り込みは大人の補助を推奨。' }, { name: '定規・折り筋用の先の丸い道具', quantity: '各1', note: '50 mm校正線と折り位置の確認。' }];
}

export { DIRECTION_LABELS, getPartPose, getFabricationChecks, getKitSummary } from './assembly.js';

export * from "./intent.js";

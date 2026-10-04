import { parseDesignDocument } from './index.js';
import type { CheckResult, DesignDocument, Direction, KitSummary, Rect } from './types.js';

export const DIRECTION_LABELS: Record<Direction, string> = { right: '右', left: '左', up: '上', down: '下' };
const movingRoles = new Set(['artwork', 'pull-tab', 'stopper', 'connector']);
/** A view transform of canonical assembly rectangles; no new mechanism model. */
export function getPartPose(doc: DesignDocument, partId: string, travelMm = 0, face: 'front' | 'back' = 'front'): Rect {
  if (!Number.isFinite(travelMm) || travelMm < 0 || travelMm > doc.motion.maxMm) throw new Error('移動量が設計範囲外です');
  const part = doc.parts.find(p => p.id === partId);
  if (!part) throw new Error(`部品 ${partId} が設計にありません`);
  const distance = movingRoles.has(part.role) ? travelMm : 0;
  const rect = { ...part.assembly, x: part.assembly.x + distance * doc.motion.axis.x, y: part.assembly.y + distance * doc.motion.axis.y };
  return face === 'back' ? { ...rect, x: doc.input.widthMm - rect.x - rect.width } : rect;
}
function interval(rect: Rect, axis: { x: number; y: number }): [number, number] {
  const a = rect.x * axis.x + rect.y * axis.y;
  const b = (rect.x + rect.width) * axis.x + (rect.y + rect.height) * axis.y;
  return [Math.min(a, b), Math.max(a, b)];
}
/** Additional fabrication checks derived from the same schema-1 geometry. Kept outside
 * serialized checks so projects created in Goal 001 retain their exact hash and parse. */
export function getFabricationChecks(document: DesignDocument): CheckResult[] {
  const doc = parseDesignDocument(document), axis = doc.motion.axis;
  const tab = doc.parts.find(p => p.id === 'T1')!;
  const [t0, t1] = interval(tab.assembly, axis);
  const [, edge] = interval(doc.parts.find(p => p.id === 'B1')!.assembly, axis);
  const fullTravel = doc.motion.maxMm;
  const guides = doc.parts.filter(p => p.role === 'guide').map(p => interval(p.assembly, axis));
  const [slot0, slot1] = interval(doc.motion.slot, axis);
  const center = doc.motion.connector.x * axis.x + doc.motion.connector.y * axis.y;
  const make = (id: string, pass: boolean, message: string, partIds: string[], scope: string): CheckResult => ({ id, status: pass ? 'pass' : 'fail', message, partIds, scope, designHash: doc.designHash });
  return [
    make('handle-reachable', t1 - edge >= 18 - 1e-6, `引き手T1は開始位置で台紙の外へ${Number((t1 - edge).toFixed(3))} mm、終点で${Number((t1 + fullTravel - edge).toFixed(3))} mm出ます。`, ['B1', 'T1'], '全移動区間の突出長。人の握りやすさ・周囲の障害物は実物で確認'),
    make('retained-throughout', guides.every(([g0, g1]) => t0 + fullTravel <= g0 + 1e-6 && t1 >= g1 - 1e-6), `0〜${fullTravel} mmの全域で両ガイド内にT1が残ります。`, ['T1', 'G1', 'G2'], '移動軸への投影による連続区間全体の包含。摩擦・たわみは対象外'),
    make('connector-slot-sweep', center - 4 >= slot0 + 1 - 1e-6 && center + fullTravel + 4 <= slot1 - 1 + 1e-6, 'C1の立ち上がりは全移動区間で切り込みの両端に各1 mm以上の余裕を残します。', ['C1', 'B1'], '接続片の移動軸方向8 mmと切り込みの連続区間。折りの厚み・作業性は実物未確認'),
  ];
}
export function getKitSummary(document: DesignDocument): KitSummary {
  const doc = parseDesignDocument(document), checks = [...doc.checks, ...getFabricationChecks(doc)];
  const tab = interval(doc.parts.find(p => p.id === 'T1')!.assembly, doc.motion.axis);
  const base = interval(doc.parts.find(p => p.id === 'B1')!.assembly, doc.motion.axis);
  const start = Number((tab[1] - base[1]).toFixed(3));
  const blocked = checks.some(c => c.status === 'fail');
  return {
    status: blocked ? 'blocked' : 'prototype',
    statusLabel: blocked ? '条件の修正が必要' : '試作キット・実物未確認',
    patternSheets: doc.layout.sheets, partCount: doc.parts.length,
    directionLabel: DIRECTION_LABELS[doc.input.direction], travelMm: doc.motion.maxMm,
    handleExposureMm: { start, end: Number((start + doc.motion.maxMm).toFixed(3)) }, checks,
    physicalTestItems: [
      '印刷倍率100%と50 mm校正線の実測値',
      `使用した紙の種類・実測厚さ（設計仮定${doc.input.paperThicknessMm} mm）`,
      `始点0 mmと終点${doc.motion.maxMm} mmでS2/G2・S1/G1が当たること`,
      '途中を含む全域でT1がG1・G2から抜けず、指で引き手を動かせること',
      'B1表裏・C1の糊面・ガイド足の接着。通路に糊がないこと',
      '途中で必要になった切り直し、折り直し、接着位置の修正と写真（任意）',
    ],
  };
}

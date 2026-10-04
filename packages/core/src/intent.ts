import { applyDesignPatch, createDesign, parseDesignDocument, canExport, DesignPatchSchema } from './index.js';
import type { DesignDocument, DesignInput, DesignPatch, Direction, ImageSource, LockKey } from './types.js';
import { displayDimension } from './display.js';
import { assertRequestBinding, distanceTargetMm, getRequestBinding, InterpretationCorrectionSchema, RequestInterpretationSchema, type RequestBinding, type RequestInterpretation, type InterpretationCorrection, type InterpretationClarification } from './interpretation.js';
import { importantUnrepresented, readManualRequest } from './manualInterpretation.js';
export * from './interpretation.js';

/** A bounded interpretation proposal, separate from the immutable author conditions. */
export type DesignIntent = {
  supported: boolean; patch: DesignPatch; addLocks: LockKey[];
  protections: { widthMm?: number; heightMm?: number; maxSheets?: number; direction?: Direction };
  conflicts: string[]; notes: string[]; relativeTravel: 'increase' | 'decrease' | null; explicitTravelMm?: number;
  binding: RequestBinding; request: string; interpretation: RequestInterpretation;
  clarifications: InterpretationClarification[]; summary: string[];
  approvalRequired?: { key: 'maxSheets'; from: number; to: number };
  correction?: InterpretationCorrection;
};
export type DesignSuggestion = {
  baseHash: string; baseRevision: number;
  status: 'ready' | 'alternative' | 'blocked' | 'unsupported' | 'clarify';
  intent: DesignIntent; requestedPatch: DesignPatch; patch: DesignPatch; document?: DesignDocument;
  messages: string[]; changes: { key: string; label: string; before: string; after: string }[]; preserved: string[]; remaining: string[];
};
const names: Record<string, string> = { direction: '方向', travelMm: '動く距離', widthMm: '作品の幅', heightMm: '作品の高さ', maxSheets: '厚紙の上限', paperThicknessMm: '紙の厚さ', clearanceMm: 'すき間', selection: '選択範囲', title: '作品名', locks: '固定する条件' };
const directions = { right: '右', left: '左', up: '上', down: '下' };
const shown = (key: string, value: unknown) => key === 'direction' ? directions[value as Direction] : key === 'locks' ? (value as LockKey[]).map(k => names[k]).join('・') || 'なし' : `${typeof value === 'object' ? JSON.stringify(value) : value}${key.endsWith('Mm') ? ' mm' : key === 'maxSheets' ? '枚' : ''}`;
export function describeDesignChanges(before: DesignDocument, after: DesignDocument): DesignSuggestion['changes'] {
  return Object.keys(names).filter(key => JSON.stringify(before.input[key as keyof DesignInput]) !== JSON.stringify(after.input[key as keyof DesignInput])).map(key => ({ key, label: names[key]!, before: shown(key, before.input[key as keyof DesignInput]), after: shown(key, after.input[key as keyof DesignInput]) }));
}

function deriveIntent(document: DesignDocument, request: string, proposed: RequestInterpretation, correction?: InterpretationCorrection, issues = readManualRequest(request).issues): DesignIntent {
  const doc = parseDesignDocument(document), input = doc.input;
  const interpretation = RequestInterpretationSchema.parse(proposed);
  const binding = getRequestBinding(doc, request);
  const trustedCorrection = correction === undefined ? undefined : InterpretationCorrectionSchema.parse(correction);
  if (trustedCorrection) assertRequestBinding(doc, request, trustedCorrection.binding);
  const intent: DesignIntent = { supported: interpretation.mechanism !== 'unsupported', patch: {}, addLocks: [], protections: { maxSheets: input.maxSheets }, conflicts: [], notes: [], relativeTravel: null, binding, request, interpretation, clarifications: [], summary: [], ...(trustedCorrection ? { correction: trustedCorrection } : {}) };
  const addIssue = (field: InterpretationClarification['field'], message: string, choices: InterpretationClarification['choices'] = []) => {
    if (intent.conflicts.includes(message)) return;
    intent.conflicts.push(message); intent.clarifications.push({ id: `${field}-${intent.clarifications.length + 1}`, field, message, choices });
  };
  if (trustedCorrection) {
    for (const key of ['distance', 'direction', 'size', 'paper'] as const) if (trustedCorrection[key] !== undefined) Object.assign(interpretation, { [key]: trustedCorrection[key] });
    for (const clause of trustedCorrection.ignoredClauses ?? []) if (!proposed.unresolved.includes(clause)) throw new Error('訂正対象の未解釈の節が依頼と一致しません。');
  }
  const ignored = trustedCorrection?.ignoredClauses ?? [];
  interpretation.unresolved = interpretation.unresolved.filter(clause => !ignored.includes(clause) && !issues.some(issue => issue.text === clause && issue.field !== 'other' && trustedCorrection?.[issue.field] !== undefined));
  for (const clause of interpretation.unresolved) {
    const issue = issues.find(item => item.text === clause), field = issue?.field ?? 'other';
    const numeric = clause.normalize('NFKC').match(/(-?\d+(?:\.\d+)?)\s*(cm|センチ(?:メートル)?|mm|ミリ(?:メートル)?)?/i);
    const amount = numeric ? Number(numeric[1]) * (/cm|センチ/i.test(numeric[2] ?? '') ? 10 : 1) : 5;
    const changes: InterpretationClarification['choices'] = field === 'distance' ? [
      { label: `${displayDimension(amount)}mm増やす`, changes: { distance: { kind: 'relative', delta: amount, unit: 'mm' } } },
      { label: `距離を${displayDimension(amount)}mmにする`, changes: { distance: { kind: 'absolute', value: amount, unit: 'mm' } } },
      { label: '現在の距離を保つ', changes: { distance: { kind: 'maintain' } } },
    ] : field === 'direction' ? (Object.entries(directions) as [Direction, string][]).map(([desired, name]) => ({ label: `${name}へ`, changes: { direction: { desired, forbidden: [] } } })) : [{ label: 'この未解釈の条件は今回使わない', changes: { ignoredClauses: [...ignored, clause] } }];
    addIssue(field, issue?.message ?? `「${clause}」をまだ解釈できません。`, changes);
  }
  if (!intent.supported) {
    intent.notes.push('直線運動1か所だけに対応しています。回転などへは変換できません。否定ではなく回転等を求める場合は対象外です。'); return intent;
  }
  if (interpretation.mechanism === 'uncertain') addIssue('other', '今回の動きが直線1か所の範囲に収まるか確認してください。');
  const addLock = (key: LockKey) => { if (!intent.addLocks.includes(key)) intent.addLocks.push(key); };
  if (interpretation.size === 'maintain') {
    intent.protections.widthMm = input.widthMm; intent.protections.heightMm = input.heightMm; addLock('widthMm'); addLock('heightMm');
    intent.notes.push(`絵の大きさを維持：台紙 ${displayDimension(input.widthMm)} × ${displayDimension(input.heightMm)} mm、画像の配置倍率も固定します。`);
    intent.summary.push('絵の大きさを維持');
  }
  if (interpretation.size === 'change') addIssue('size', '絵の大きさの変更は幅・高さを手動で指定してください。固定中の条件は解釈で解除できません。');
  const paper = interpretation.paper;
  let cap = input.maxSheets;
  if (paper.kind === 'maintain') cap = Math.min(input.maxSheets, Math.max(1, doc.layout.sheets));
  if (paper.kind === 'cap') cap = paper.maxSheets;
  if (cap < 1 || cap > 8 || !Number.isInteger(cap)) addIssue('paper', '紙の上限は1〜8枚で指定してください。枚数を読み替えることはしません。');
  else if (cap > input.maxSheets) {
    const approval = trustedCorrection?.paperApproval;
    const approved = approval?.from === input.maxSheets && approval.to === cap;
    if (!approved) {
      intent.approvalRequired = { key: 'maxSheets', from: input.maxSheets, to: cap };
      addIssue('paper', `厚紙の上限を${input.maxSheets}→${cap}枚に緩めるには、この具体的な変更の確認が必要です。`, [{ label: `上限を${input.maxSheets}→${cap}枚に変更する`, changes: { paperApproval: { from: input.maxSheets, to: cap } } }, { label: `現在の上限${input.maxSheets}枚を保つ`, changes: { paper: { kind: 'cap', maxSheets: input.maxSheets } } }]);
    }
    if (input.locks.includes('maxSheets')) addIssue('paper', `厚紙の上限${input.maxSheets}枚は固定中です。解釈や承認では固定を解除できません。`);
    if (approved && !input.locks.includes('maxSheets')) intent.protections.maxSheets = cap;
    intent.patch.maxSheets = cap;
  } else intent.protections.maxSheets = cap;
  if (trustedCorrection?.paperApproval && (trustedCorrection.paperApproval.from !== input.maxSheets || trustedCorrection.paperApproval.to !== cap || cap <= input.maxSheets)) addIssue('paper', '紙上限の承認と今回の具体的な変更が一致しません。');
  if (paper.kind !== 'unspecified' && cap >= 1 && cap <= 8) { intent.patch.maxSheets = cap; addLock('maxSheets'); }
  intent.notes.push(`現在の厚紙の上限、A4 ${intent.protections.maxSheets}枚までを保ちます。説明書は別です。${paper.kind === 'maintain' ? '現在使う型紙の枚数を増やしません。' : ''}`);
  intent.summary.push(intent.approvalRequired ? `厚紙の上限 ${input.maxSheets}→${cap}枚（確認待ち）` : paper.kind === 'maintain' ? `型紙の使用枚数を増やさない（現在${doc.layout.sheets}枚）` : `型紙は上限${intent.protections.maxSheets}枚以内（説明書は別）`);
  const direction = interpretation.direction.desired ?? input.direction;
  if (interpretation.direction.forbidden.includes(direction)) addIssue('direction', `${directions[direction]}への動きは禁止されています。動かす方向を選んでください。`, (Object.entries(directions) as [Direction,string][]).filter(([key]) => !interpretation.direction.forbidden.includes(key)).map(([desired,label]) => ({label:`${label}へ`, changes:{direction:{...interpretation.direction,desired}}})));
  if (interpretation.direction.desired) { intent.patch.direction = direction; intent.protections.direction = direction; }
  intent.summary.unshift(`${directions[direction]}へ${interpretation.direction.desired ? '' : '（現在の方向）'}${interpretation.direction.forbidden.length ? `／${interpretation.direction.forbidden.map(d=>directions[d]).join('・')}は禁止` : ''}`);
  const operation = interpretation.distance, target = distanceTargetMm(input.travelMm, operation);
  if (operation.kind === 'relative') intent.relativeTravel = operation.delta > 0 ? 'increase' : operation.delta < 0 ? 'decrease' : null;
  if (operation.kind === 'qualitative') intent.relativeTravel = operation.change;
  if (operation.kind !== 'unspecified' && operation.kind !== 'maintain') { intent.patch.travelMm = target; intent.explicitTravelMm = target; }
  if (target < 2 || target > 70) addIssue('distance', `希望の移動量は${displayDimension(target)}mmです。この機構の範囲2〜70mmを外れます。上限・下限へ読み替えません。`, [{label:'現在の距離を保つ',changes:{distance:{kind:'maintain'}}}]);
  if (readManualRequest(request).forbiddenDistancesMm.includes(target)) addIssue('distance', `指定しない希望だった${displayDimension(target)}mmと計算結果が重なっています。`);
  intent.summary.splice(1, 0, target === input.travelMm ? `動く距離 ${displayDimension(input.travelMm)}mmを維持${operation.kind === 'unspecified' ? '（未指定）' : ''}` : `動く距離 ${displayDimension(input.travelMm)}→${displayDimension(target)}mm${operation.kind === 'relative' ? `（${operation.delta > 0 ? '+' : ''}${displayDimension(operation.delta * (operation.unit === 'cm' ? 10 : 1))}mm）` : operation.kind === 'qualitative' ? '（定性的な希望への目安）' : ''}`);
  for (const key of input.locks) if (key in intent.patch && JSON.stringify(intent.patch[key]) !== JSON.stringify(input[key]) && !(key === 'maxSheets' && Number(intent.patch.maxSheets) < input.maxSheets)) addIssue(key === 'direction' ? 'direction' : key === 'maxSheets' ? 'paper' : 'distance', `${names[key]}は固定中です。解釈では固定を解除できません。`);
  return intent;
}

export function interpretDesignRequest(document: DesignDocument, request: string, correction?: InterpretationCorrection): DesignIntent {
  const reading = readManualRequest(request);
  return deriveIntent(document, request, reading.interpretation, correction, reading.issues);
}

/** A model may resolve vocabulary uncertainty; it cannot erase clear author conditions. */
export function interpretModelRequest(document: DesignDocument, request: string, proposal: RequestInterpretation, correction?: InterpretationCorrection): DesignIntent {
  const reading = readManualRequest(request), manual = reading.interpretation, model = RequestInterpretationSchema.parse(proposal);
  const contradictions: InterpretationClarification[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const field of ['distance', 'direction', 'size', 'paper'] as const) {
    const certain = !reading.issues.some(issue => issue.field === field);
    const explicit = field === 'direction' ? !!manual.direction.desired || !!manual.direction.forbidden.length : field === 'size' ? manual.size !== 'unspecified' : manual[field].kind !== 'unspecified';
    if (certain && (explicit || manual.unresolved.length === 0) && !correction?.[field]) {
      const agrees = field === 'direction' ? (!manual.direction.desired && !explicit ? model.direction.desired === undefined : !manual.direction.desired || manual.direction.desired === model.direction.desired) && manual.direction.forbidden.every(d => model.direction.forbidden.includes(d)) : field === 'distance' ? distanceTargetMm(document.input.travelMm, manual.distance) === distanceTargetMm(document.input.travelMm, model.distance) && manual.distance.kind === model.distance.kind : same(manual[field], model[field]);
      if (!agrees) contradictions.push({ id: `model-${field}`, field, message: `モデルの${field === 'distance' ? '距離' : field === 'direction' ? '方向' : field === 'paper' ? '紙上限' : '絵の大きさ'}の解釈が明示された希望と一致しません。訂正して再検査してください。`, choices: [{ label: '原文の明確な条件を使う', changes: { [field]: manual[field] } }] });
      Object.assign(model, { [field]: manual[field] });
    }
  }
  // For completely understood clauses, a model cannot reintroduce the old
  // false rejection of explicitly negated rotation. Unknown wording still uses
  // the model's mechanism interpretation and remains visible to the author.
  if (manual.mechanism === 'unsupported' || manual.unresolved.length === 0) model.mechanism = manual.mechanism;
  for (const issue of reading.issues) if ((importantUnrepresented.test(issue.text) || issue.field === 'distance' && /\d/.test(issue.text) && !/mm|cm|ミリ|センチ/i.test(issue.text)) && !model.unresolved.includes(issue.text)) model.unresolved.push(issue.text);
  const intent = deriveIntent(document, request, model, correction, reading.issues);
  for (const question of contradictions) { intent.conflicts.push(question.message); intent.clarifications.push(question); }
  return intent;
}

/** Immutable baseline, locks and concrete author approval are rechecked at application. */
export function applyIntentPatch(document: DesignDocument, patch: DesignPatch, intent: DesignIntent): DesignDocument {
  const base = parseDesignDocument(document);
  assertRequestBinding(base, intent.request, intent.binding);
  if (intent.correction) assertRequestBinding(base, intent.request, intent.correction.binding);
  if (!intent.supported || intent.conflicts.length || intent.approvalRequired) throw new Error(intent.conflicts.join(' ') || intent.notes.join(' '));
  const merged = DesignPatchSchema.parse({ ...intent.patch, ...patch }), p = intent.protections;
  if (intent.interpretation.size === 'maintain') for (const key of ['widthMm','heightMm'] as const) if ((merged[key] ?? base.input[key]) !== base.input[key]) throw new Error(`${names[key]}は依頼で保護されています。`);
  if (intent.interpretation.direction.desired && (merged.direction ?? base.input.direction) !== intent.interpretation.direction.desired) throw new Error('希望された方向と候補が一致しません。');
  if (!intent.interpretation.direction.desired && (merged.direction ?? base.input.direction) !== base.input.direction) throw new Error('方向は未指定のため現在の方向を維持します。');
  for (const key of ['widthMm', 'heightMm', 'direction'] as const) if (p[key] !== undefined && (merged[key] ?? base.input[key]) !== p[key]) throw new Error(`${names[key]}は依頼で保護されています。条件変更の提案と利用者の確認が必要です。`);
  for (const key of ['selection'] as const) if (merged[key] !== undefined && JSON.stringify(merged[key]) !== JSON.stringify(base.input[key])) throw new Error('依頼の解釈で選択範囲を変更できません。');
  let maxSheets = Math.min(p.maxSheets ?? base.input.maxSheets, base.input.maxSheets);
  const approval = intent.correction?.paperApproval;
  if (approval && approval.from === base.input.maxSheets && approval.to === p.maxSheets && intent.interpretation.paper.kind === 'cap' && approval.to === intent.interpretation.paper.maxSheets && !base.input.locks.includes('maxSheets')) maxSheets = approval.to;
  if ((merged.maxSheets ?? base.input.maxSheets) > maxSheets) throw new Error(`厚紙は${maxSheets}枚までです。紙を増やす前に具体的な条件変更の確認が必要です。`);
  const travel = merged.travelMm ?? base.input.travelMm;
  if (['unspecified','maintain'].includes(intent.interpretation.distance.kind) && travel !== base.input.travelMm) throw new Error('動く距離は現在値を維持する解釈です。距離の変更には解釈の訂正が必要です。');
  if (intent.interpretation.direction.forbidden.includes(merged.direction ?? base.input.direction)) throw new Error('禁止された方向へは変更できません。');
  if (intent.relativeTravel === 'increase' && travel <= base.input.travelMm || intent.relativeTravel === 'decrease' && travel >= base.input.travelMm) throw new Error('候補の移動距離が「大きく／小さく」の希望と一致しません。実現できない場合は条件変更案を示してください。');
  const tightening = maxSheets < base.input.maxSheets && base.input.locks.includes('maxSheets');
  const applied = applyDesignPatch(base, tightening ? { ...merged, maxSheets: base.input.maxSheets } : merged);
  const input = { ...applied.input, ...(tightening ? { maxSheets: merged.maxSheets ?? maxSheets } : {}), locks: [...new Set([...base.input.locks, ...intent.addLocks])] };
  const candidate = createDesign(input, { designId: base.designId, revision: base.revision + 1 });
  return candidate.designHash === base.designHash ? base : candidate;
}

export function buildDesignSuggestion(document: DesignDocument, request: string, correction?: InterpretationCorrection): DesignSuggestion {
  const base = parseDesignDocument(document), intent = interpretDesignRequest(base, request, correction);
  const result: DesignSuggestion = { baseHash: base.designHash, baseRevision: base.revision, status: 'blocked', intent, requestedPatch: intent.patch, patch: intent.patch, messages: [], changes: [], preserved: [...intent.notes], remaining: ['紙厚・摩擦・折り精度・接着・耐久性は実物未確認です。'] };
  if (!intent.supported) return { ...result, status: 'unsupported', messages: intent.notes };
  if (intent.conflicts.length) return { ...result, status: 'clarify', messages: intent.conflicts };
  if (!Object.keys(intent.patch).length && !intent.addLocks.length) return { ...result, status: 'clarify', messages: ['方向や距離が未指定です。動かす方向または距離の操作を指定してください。'] };
  let candidate: DesignDocument;
  try { candidate = applyIntentPatch(base, intent.patch, intent); }
  catch (error) { return { ...result, messages: [error instanceof Error ? error.message : '固定条件を確認してください。'] }; }
  if (canExport(candidate)) {
    if (candidate.designHash === base.designHash) return { ...result, messages: ['現在の設計が指定条件と同じです。距離や方向は変更していません。'] };
    return { ...result, document: candidate, status: 'ready', changes: describeDesignChanges(base, candidate), messages: [`移動 ${base.input.travelMm} → ${candidate.input.travelMm} mm、${directions[candidate.input.direction]}へ。型紙${candidate.layout.sheets}枚です。採用するまで元の設計を保ちます。`] };
  }
  result.messages = candidate.checks.filter(c => c.status === 'fail').map(c => `${c.partIds.join('・')}: ${c.message} ${c.suggestion ?? ''}`);
  if (['unspecified','maintain'].includes(intent.interpretation.distance.kind)) return { ...result, messages: [...result.messages, '距離は現在値を維持します。距離を変える代案には、希望の訂正が必要です。'] };
  const target = candidate.input.travelMm;
  const candidates = Array.from({ length: 69 }, (_, i) => i + 2).filter(value => value <= target && (!intent.relativeTravel || (intent.relativeTravel === 'increase' ? value > base.input.travelMm : value < base.input.travelMm))).sort((a, b) => b - a);
  for (const travelMm of candidates) {
    try {
      const alternative = applyIntentPatch(base, { ...intent.patch, travelMm }, intent);
      if (canExport(alternative)) return { ...result, status: 'alternative', patch: { ...intent.patch, travelMm }, document: alternative, changes: describeDesignChanges(base, alternative), messages: [`希望の${target} mmでは条件違反があります。絵・選択・紙の上限を保つ代案は${travelMm} mmです。希望との差を確認して選んでください。`, ...result.messages] };
    } catch { /* Locked or contradictory distances remain inadmissible. */ }
  }
  return { ...result, messages: [...result.messages, '現在の絵・選択・固定条件のまま、2〜70 mmの1 mm刻み探索では候補が見つかりませんでした。選択位置を中央側へ選び直すか、詳細設定で変更を許す条件を明示してください。すべての配置が不可能という意味ではありません。'] };
}

/** General image defaults. Selection is an editable rectangle, never a claim of segmentation. */
export function createImageInput(image: ImageSource, title: string): DesignInput {
  const widthMm = 150, heightMm = Math.min(180, Math.max(60, widthMm * image.heightPx / image.widthPx));
  const width = Math.max(1, Math.round(image.widthPx * .25)), height = Math.max(1, Math.round(image.heightPx * .25));
  return { title: title.trim().slice(0, 80) || 'わたしの作品', image, widthMm, heightMm, selection: { x: Math.min(image.widthPx - width, Math.round(image.widthPx * .5)), y: Math.min(image.heightPx - height, Math.round(image.heightPx * .25)), width, height }, direction: 'right', travelMm: 12, maxSheets: 2, paperThicknessMm: .25, clearanceMm: .8, locks: [] };
}

import { applyDesignPatch, createDesign, parseDesignDocument, canExport, DesignPatchSchema } from './index.js';
import type { DesignDocument, DesignInput, DesignPatch, Direction, ImageSource, LockKey } from './types.js';

/** A deliberately bounded Japanese/English helper, not an image recognizer or an AI substitute. */
export type DesignIntent = {
  supported: boolean;
  patch: DesignPatch;
  addLocks: LockKey[];
  protections: { widthMm?: number; heightMm?: number; maxSheets?: number; direction?: Direction };
  conflicts: string[];
  notes: string[];
  relativeTravel: 'increase' | 'decrease' | null;
  explicitTravelMm?: number;
};
export type DesignSuggestion = {
  baseHash: string; baseRevision: number;
  status: 'ready' | 'alternative' | 'blocked' | 'unsupported' | 'clarify';
  intent: DesignIntent; requestedPatch: DesignPatch; patch: DesignPatch;
  document?: DesignDocument;
  messages: string[];
  changes: { key: string; label: string; before: string; after: string }[];
  preserved: string[]; remaining: string[];
};
const names: Record<string, string> = { direction: '方向', travelMm: '動く距離', widthMm: '作品の幅', heightMm: '作品の高さ', maxSheets: '厚紙の上限', paperThicknessMm: '紙の厚さ', clearanceMm: 'すき間', selection: '選択範囲', title: '作品名', locks: '固定する条件' };
const directions = { right: '右', left: '左', up: '上', down: '下' };
const shown = (key: string, value: unknown) => key === 'direction' ? directions[value as Direction] : key === 'locks' ? (value as LockKey[]).map(k => names[k]).join('・') || 'なし' : `${typeof value === 'object' ? JSON.stringify(value) : value}${key.endsWith('Mm') ? ' mm' : key === 'maxSheets' ? '枚' : ''}`;
export function describeDesignChanges(before: DesignDocument, after: DesignDocument): DesignSuggestion['changes'] {
  return Object.keys(names).filter(key => JSON.stringify(before.input[key as keyof DesignInput]) !== JSON.stringify(after.input[key as keyof DesignInput])).map(key => ({ key, label: names[key]!, before: shown(key, before.input[key as keyof DesignInput]), after: shown(key, after.input[key as keyof DesignInput]) }));
}

export function interpretDesignRequest(document: DesignDocument, request: string): DesignIntent {
  const doc = parseDesignDocument(document), input = doc.input;
  const text = request.normalize('NFKC').trim();
  const intent: DesignIntent = { supported: true, patch: {}, addLocks: [], protections: {}, conflicts: [], notes: [], relativeTravel: null };
  const addLock = (key: LockKey) => { if (!intent.addLocks.includes(key)) intent.addLocks.push(key); };
  // Negative motion clauses are removed only when their subject is explicit.
  const motionText = text.replace(/(?:回転|回す|揺らす|振る)(?:は)?(?:しない|させない|さない|不要|ではなく|じゃなく)/g, '');
  if (/回転|回す|ぐるぐる|揺|手を振|歩[く行]|歯車|立体|モーター|電子|複数(?:の)?(?:部分|可動部|箇所)|[2-9二三](?:か所|箇所|ヶ所)|両(?:手|腕)|手と足|rotate|rotation|swing|oscillat|walk|gear|motor|3d/i.test(motionText)) {
    intent.supported = false; intent.notes.push('直線運動1か所だけに対応しています。回転などへは変換できません。「まっすぐ動かす」を選ぶか希望を書き直してください。'); return intent;
  }
  const keepSize = /(?:絵|作品|画像)?(?:の)?(?:大きさ|サイズ|寸法).{0,10}(?:保[つっち]|固定(?!しない)|そのまま|維持|変え(?:ない|ず|たくない)|変[更化]しない)|(?:絵|画像|作品).{0,6}(?:縮小しない|縮め(?:ない|たくない)|小さくしない|そのまま|いじらず)|keep.{0,16}(?:art|image|size)|same size/i.test(text);
  const changeSize = /(?:絵|作品|画像)(?:の)?(?:大きさ|サイズ|寸法).{0,6}(?:変更して|変えて|小さくして|大きくして)|(?:絵|作品|画像)(?:は|を)(?:縮小して|小さくして|拡大して)|(?:サイズ|大きさ)(?:は|の)?(?:固定しない|変えてよい|変えていい)|(?:今度は|今は).{0,5}(?:変えてもよい|変えてもいい)/.test(text);
  if (keepSize && changeSize) intent.conflicts.push('絵の大きさを保つ希望と変更する希望が同時にあります。どちらを優先するか書き直してください。');
  if (keepSize) { intent.protections.widthMm = input.widthMm; intent.protections.heightMm = input.heightMm; addLock('widthMm'); addLock('heightMm'); intent.notes.push(`絵の大きさを維持：台紙 ${input.widthMm} × ${input.heightMm} mm、画像の配置倍率も固定します。`); }
  if (changeSize && (input.locks.includes('widthMm') || input.locks.includes('heightMm'))) intent.conflicts.push('絵の大きさは固定中です。詳細設定で変更する条件の固定を解除してから、改めて依頼してください。');
  const noMorePaper = /(?:紙|枚数|厚紙).{0,10}(?:増や(?:さない|さず|したくない)|増加させない|追加しない|変更しない|変え(?:ない|ず)|そのまま|今のまま|維持)|no more (?:paper|sheets)|without (?:more|adding) (?:paper|sheets)/i.test(text);
  const morePaper = /(?:紙|枚数|厚紙).{0,8}(?:増やして|増や(?:せる|してよい|していい))/.test(text);
  const caps = [...text.matchAll(/(?:A4\s*(?:で|は|を)?\s*)?(\d+|[一二三四五六七八九十]+)\s*枚(?:まで|以内|以下|のまま|に収め|を上限)/g)].map(m => /^[一二三四五六七八]$/.test(m[1]!) ? '一二三四五六七八'.indexOf(m[1]!) + 1 : Number(m[1]));
  if (caps.some(cap => !Number.isInteger(cap) || cap < 1 || cap > 8)) { intent.conflicts.push('紙の上限は1〜8枚で指定してください。枚数を読み替えることはしません。'); return intent; }
  if (new Set(caps).size > 1) intent.conflicts.push('紙枚数の上限が複数指定されています。上限を1つにしてください。');
  if (noMorePaper && morePaper) intent.conflicts.push('紙を増やさない希望と増やす希望が同時にあります。どちらを優先するか書き直してください。');
  if (noMorePaper || caps.length) {
    const cap = Math.min(caps[0] ?? Infinity, noMorePaper ? Math.min(input.maxSheets, Math.max(1, doc.layout.sheets)) : Infinity);
    intent.protections.maxSheets = cap; intent.patch.maxSheets = cap; addLock('maxSheets');
    intent.notes.push(`厚紙はA4 ${cap}枚まで。説明書は別です。${noMorePaper ? '現在使う型紙の枚数を増やしません。' : ''}`);
    if (input.locks.includes('maxSheets') && cap > input.maxSheets) intent.conflicts.push(`厚紙の上限${input.maxSheets}枚は固定中です。詳細設定で紙の上限の固定を解除し、変更を確認してください。`);
  }
  if (morePaper && input.locks.includes('maxSheets')) intent.conflicts.push('紙枚数の上限は固定中です。増やす場合は詳細設定で固定を解除してから上限を変更してください。');
  const found = (Object.entries({ right: /右(?:へ|に|方向)|\bright\b/i, left: /左(?:へ|に|方向)|\bleft\b/i, up: /上(?:へ|に|方向)|\bup(?:ward)?\b/i, down: /下(?:へ|に|方向)|\bdown(?:ward)?\b/i }) as [Direction, RegExp][]).filter(([, re]) => re.test(text)).map(([key]) => key);
  if (found.length > 1) intent.conflicts.push('動かす方向を1つ選んでください。複数方向の動きには対応していません。');
  if (found.length === 1) { intent.patch.direction = found[0]; intent.protections.direction = found[0]; }
  if (/わけ(?:じゃ|では)ない|とは言って(?:い)?ない/.test(text)) intent.conflicts.push('否定を含む条件の優先順位を確定できません。「絵の大きさを保つ」「紙は増やさない」など、守る条件を直接指定してください。');
  const travelText = text.replace(/(?:絵|画像|作品)(?:の大きさ|のサイズ)?(?:は|を|も)?(?:小さくしない|大きくしない|縮めない|縮めたくない)/g, '');
  if (/(?:大きく|小さく|遠く|長く|短く).{0,5}(?:動かさない|しない|したくない)|(?:動き|距離|移動量).{0,8}(?:増やさない|減らさない|変えない)/.test(travelText)) intent.conflicts.push('動かす距離を変えない希望として受け取りました。現在値を固定する場合は詳細設定で「動く距離を固定」を選んでください。');
  const larger = /(?:もっと|もう少し|少し|さらに).{0,5}(?:大きく|遠く|長く)|(?:大きく|遠く|長く)(?:動か|移動)|(?:動き|距離|移動量)(?:を|は)?.{0,4}(?:増や|大きく|長く)|(?:move|travel).{0,8}(?:more|further|larger|longer)|(?:more|larger|longer)\s+(?:motion|travel|movement)/i.test(text);
  const smaller = /(?:もっと|もう少し|少し).{0,5}(?:小さく|短く)|(?:小さく|短く)(?:動か|移動)|(?:動き|距離|移動量)(?:を|は)?.{0,4}(?:減ら|小さく|短く)|(?:move|travel).{0,8}(?:less|shorter|smaller)|(?:less|smaller|shorter)\s+(?:motion|travel|movement)/i.test(text);
  if (larger && smaller) intent.conflicts.push('動く距離を増やす希望と減らす希望が同時にあります。どちらかにしてください。');
  if (larger || smaller) { intent.relativeTravel = larger ? 'increase' : 'decrease'; const delta = Math.max(2, Math.round(input.travelMm * .25)); intent.patch.travelMm = Math.max(2, Math.min(70, input.travelMm + (larger ? delta : -delta))); }
  const distances = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(mm|ミリ(?:メートル)?|cm|センチ(?:メートル)?)\s*(?:動か|移動|引く|出す)|(?:移動距離|動く距離|移動量|距離)(?:を|は)?\s*(\d+(?:\.\d+)?)\s*(mm|ミリ(?:メートル)?|cm|センチ(?:メートル)?)/gi)];
  if (distances.length) {
    const amounts = distances.map(m => Number(m[1] ?? m[3]) * (/cm|センチ/i.test(m[2] ?? m[4]!) ? 10 : 1));
    if (new Set(amounts).size > 1) intent.conflicts.push('動く距離が複数指定されています。距離を1つにしてください。');
    const amount = amounts[0]!;
    if (amount < 2 || amount > 70) intent.conflicts.push('この機構で指定できる移動量は2〜70 mmです。距離を書き直してください。');
    else { intent.patch.travelMm = amount; intent.explicitTravelMm = amount; }
  }
  if (intent.relativeTravel === 'increase' && intent.explicitTravelMm !== undefined && intent.explicitTravelMm <= input.travelMm || intent.relativeTravel === 'decrease' && intent.explicitTravelMm !== undefined && intent.explicitTravelMm >= input.travelMm) intent.conflicts.push('指定した距離と「大きく／小さく」の希望が一致しません。現在の距離を確認してください。');
  // Do not quietly interpret an unrecognized size operation as fulfilled.
  if (changeSize && !intent.conflicts.length) intent.conflicts.push('絵の大きさを変える場合は、詳細設定で幅・高さを指定し、完成予定を確認してください。');
  for (const key of input.locks) if (key in intent.patch && JSON.stringify(intent.patch[key]) !== JSON.stringify(input[key]) && !(key === 'maxSheets' && Number(intent.patch.maxSheets) < input.maxSheets)) intent.conflicts.push(`${names[key]}は固定中です。詳細設定で固定を解除するか、現在の条件を保つ希望にしてください。`);
  return intent;
}

/** Enforces request-derived protections on the server and in the manual helper. */
export function applyIntentPatch(document: DesignDocument, patch: DesignPatch, intent: DesignIntent): DesignDocument {
  const base = parseDesignDocument(document);
  if (!intent.supported || intent.conflicts.length) throw new Error(intent.conflicts.join(' ') || intent.notes.join(' '));
  const merged = DesignPatchSchema.parse({ ...intent.patch, ...patch });
  const p = intent.protections;
  for (const key of ['widthMm', 'heightMm', 'direction'] as const) if (p[key] !== undefined && (merged[key] ?? base.input[key]) !== p[key]) throw new Error(`${names[key]}は依頼で保護されています。条件変更の提案と利用者の確認が必要です。`);
  if (p.maxSheets !== undefined && (merged.maxSheets ?? base.input.maxSheets) > p.maxSheets) throw new Error(`厚紙は${p.maxSheets}枚までです。紙を増やす前に条件変更の確認が必要です。`);
  const travel = merged.travelMm ?? base.input.travelMm;
  if (intent.relativeTravel === 'increase' && travel <= base.input.travelMm || intent.relativeTravel === 'decrease' && travel >= base.input.travelMm) throw new Error('候補の移動距離が「大きく／小さく」の希望と一致しません。実現できない場合は条件変更案を示してください。');
  // A direct request may tighten an existing upper bound, but never silently loosen it.
  const tightening = p.maxSheets !== undefined && p.maxSheets < base.input.maxSheets && base.input.locks.includes('maxSheets');
  const applied = applyDesignPatch(base, tightening ? { ...merged, maxSheets: base.input.maxSheets } : merged);
  const input = { ...applied.input, ...(tightening ? { maxSheets: merged.maxSheets ?? p.maxSheets } : {}), locks: [...new Set([...base.input.locks, ...intent.addLocks])] };
  const candidate = createDesign(input, { designId: base.designId, revision: base.revision + 1 });
  return candidate.designHash === base.designHash ? base : candidate;
}

export function buildDesignSuggestion(document: DesignDocument, request: string): DesignSuggestion {
  const base = parseDesignDocument(document), intent = interpretDesignRequest(base, request);
  const result: DesignSuggestion = { baseHash: base.designHash, baseRevision: base.revision, status: 'blocked', intent, requestedPatch: intent.patch, patch: intent.patch, messages: [], changes: [], preserved: [...intent.notes], remaining: ['紙厚・摩擦・折り精度・接着・耐久性は実物未確認です。'] };
  if (!intent.supported) return { ...result, status: 'unsupported', messages: intent.notes };
  if (intent.conflicts.length) return { ...result, status: 'clarify', messages: intent.conflicts };
  if (!Object.keys(intent.patch).length && !intent.addLocks.length) return { ...result, status: 'clarify', messages: ['手動支援では「右へ」「もう少し大きく動かす」「距離を15mm」「絵の大きさを保つ」「紙は2枚まで」などを指定できます。方向か動く距離を具体的にしてください。'] };
  let candidate: DesignDocument;
  try { candidate = applyIntentPatch(base, intent.patch, intent); }
  catch (error) { return { ...result, messages: [error instanceof Error ? error.message : '固定条件を確認してください。'] }; }
  if (canExport(candidate)) {
    if (candidate.designHash === base.designHash) return { ...result, messages: ['現在の設計が指定条件と同じです。変更する方向や距離を指定してください。'] };
    return { ...result, document: candidate, status: 'ready', changes: describeDesignChanges(base, candidate), messages: [`移動 ${base.input.travelMm} → ${candidate.input.travelMm} mm、${directions[candidate.input.direction]}へ。型紙${candidate.layout.sheets}枚です。採用するまで元の設計を保ちます。`] };
  }
  const failures = candidate.checks.filter(c => c.status === 'fail');
  result.messages = failures.map(c => `${c.partIds.join('・')}: ${c.message} ${c.suggestion ?? ''}`);
  // Search only travel, with image scale, selection, direction and all locked fields intact.
  // A 1-mm bounded search is a helpful alternative, never an impossibility proof.
  const target = candidate.input.travelMm;
  const candidates = Array.from({ length: 69 }, (_, i) => i + 2).filter(value => value <= target && (!intent.relativeTravel || (intent.relativeTravel === 'increase' ? value > base.input.travelMm : value < base.input.travelMm))).sort((a, b) => b - a);
  for (const travelMm of candidates) {
    try {
      const alternative = applyIntentPatch(base, { ...intent.patch, travelMm }, intent);
      if (canExport(alternative)) return { ...result, status: 'alternative', patch: { ...intent.patch, travelMm }, document: alternative, changes: describeDesignChanges(base, alternative), messages: [`希望の${target} mmでは条件違反があります。絵・選択・紙の上限を保つ代案は${travelMm} mmです。希望との差を確認して選んでください。`, ...result.messages] };
    } catch { /* A locked or contradictory distance is not an admissible candidate. */ }
  }
  return { ...result, messages: [...result.messages, '現在の絵・選択・固定条件のまま、2〜70 mmの1 mm刻み探索では候補が見つかりませんでした。選択位置を中央側へ選び直すか、詳細設定で変更を許す条件を明示してください。すべての配置が不可能という意味ではありません。'] };
}

/** General image defaults. Selection is an editable rectangle, never a claim of segmentation. */
export function createImageInput(image: ImageSource, title: string): DesignInput {
  const widthMm = 150, heightMm = Math.min(180, Math.max(60, widthMm * image.heightPx / image.widthPx));
  const width = Math.max(1, Math.round(image.widthPx * .25)), height = Math.max(1, Math.round(image.heightPx * .25));
  return { title: title.trim().slice(0, 80) || 'わたしの作品', image, widthMm, heightMm, selection: { x: Math.min(image.widthPx - width, Math.round(image.widthPx * .5)), y: Math.min(image.heightPx - height, Math.round(image.heightPx * .25)), width, height }, direction: 'right', travelMm: 12, maxSheets: 2, paperThicknessMm: .25, clearanceMm: .8, locks: [] };
}

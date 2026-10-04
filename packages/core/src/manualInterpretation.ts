import type { Direction } from './types.js';
import type { DistanceOperation, RequestInterpretation } from './interpretation.js';

export type ManualReading = { interpretation: RequestInterpretation; issues: { field: 'distance' | 'direction' | 'size' | 'paper' | 'other'; text: string; message: string }[]; forbiddenDistancesMm: number[]; absoluteTrends: { targetMm: number; change: 'increase' | 'decrease' }[] };
const negative = /^(?:(?:の話|について|に関して)?は|を|も|に|には|へは)?(?:(?:させる|する)必要(?:は|が)?ない|させたくない|したくない|させず|させない|さず|しない(?!と)|しなく|せず|せない|ない|なく|ず|不要|ではなく|じゃなく|はやめ|をやめ)/;
const directionNames: Record<string, Direction> = { 右: 'right', 左: 'left', 上: 'up', 下: 'down', right: 'right', left: 'left', up: 'up', down: 'down' };
export const importantUnrepresented = /速度|速さ|スピード|速く|ゆっくり|遅く|遅さ|秒|時間|分間|往復|交互|順番|自動|繰り返|重さ|重量|色|赤|青|静か|検査|承認|解除|無視|チェック/;

/** Bounded clause reader. Unconsumed conditions remain questions, not success. */
export function readManualRequest(request: string): ManualReading {
  const interpretation: RequestInterpretation = { distance: { kind: 'unspecified' }, direction: { forbidden: [] }, size: 'unspecified', paper: { kind: 'unspecified' }, mechanism: 'single-pull-tab', unresolved: [] };
  const issues: ManualReading['issues'] = [], forbiddenDistancesMm: number[] = [], absoluteTrends: ManualReading['absoluteTrends'] = [];
  const issue = (field: ManualReading['issues'][number]['field'], text: string, message: string) => {
    if (!issues.some(item => item.field === field && item.text === text && item.message === message)) issues.push({ field, text, message });
  };
  const text = request.normalize('NFKC').trim();
  if (!text || text.length > 2000) issue('other', text || '空の依頼', '依頼を1〜2000文字で入力してください。');
  const quoted = text.replace(/「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/g, match => {
    issue('other', match, '引用された内容を目標値とは決めていません。今回の希望に使う部分を確認してください。'); return ' ';
  });
  // A conjunction between two explicit subjects is a clause boundary as well.
  const clauses = quoted.split(/[。、,;；!?！？\n]+|(?<=[ずて])(?=(?:右|左|上|下)(?:へ|に))|(?<=しない)(?=動き)|(?<=保って)(?=紙)|(?<=せず)(?=右|左|上|下)/u).map(s => s.trim()).filter(Boolean).flatMap(clause => {
    // An explicit switch from artwork/paper to movement starts a new subject,
    // even without punctuation. Do not consume both predicates as a size clause.
    const nextSubject = clause.search(/(?:動き|動く距離|移動量|移動距離)(?:だけ|は|を)/);
    return nextSubject > 0 && /絵|画像|作品|サイズ|大きさ|紙|枚数/.test(clause.slice(0, nextSubject)) ? [clause.slice(0, nextSubject), clause.slice(nextSubject)] : [clause];
  });
  const operations: DistanceOperation[] = [], desired: Direction[] = [], sizes: string[] = [], papers: RequestInterpretation['paper'][] = [];
  const qualitative: ('increase' | 'decrease')[] = [];
  for (const clause of clauses) {
    let rest = clause;
    const consume = (re: RegExp) => { rest = rest.replace(re, ' '); };
    if (/わけ(?:じゃ|では)ない|とは言って(?:い)?ない|ないことはない|なくはない|なくもない|言ったけれど/.test(clause)) {
      issue('other', clause, '否定の重なりや条件の優先順位を確定できません。今回の希望を選び直してください。'); continue;
    }
    if (/検査.{0,12}(?:省略|不要|しない|せず)|承認.{0,12}(?:みな|済み|不要)|固定.{0,12}(?:解除|無視)|制約.{0,12}(?:無視|外)|チェック.{0,12}(?:飛ば|省略)/.test(clause)) {
      issue('other', clause, '文章で固定条件・検査・採用の確認を省略できません。'); continue;
    }
    const unsupported = /回転|回す|回さ|回し|ぐるぐる|揺ら|揺れ|手を振|歩く|歩か|歯車|立体|モーター|電子|複数(?:の)?(?:部分|可動部|箇所)|[2-9二三](?:か所|箇所|ヶ所)|両(?:手|腕)|手と足|\b(?:rotat\w*|swing|oscillat\w*|walk|gear|motor|3d)\b/gi;
    for (const match of clause.matchAll(unsupported)) {
      const tail = clause.slice(match.index! + match[0].length), prefix = clause.slice(0, match.index!);
      const negated = negative.test(tail) || /(?:do not|don't|without|not)\s*$/i.test(prefix) || (/回さ|揺ら|手を振|歩か/.test(match[0]) && /^(?:ない|ず)/.test(tail));
      const explicitlyPositive = /^(?:は|を)?(?:させたい|したい|させて|して|する|させる|がほしい)/.test(tail);
      const uncertain = /かどうか|なのか|できるか|とは|の説明|の話/.test(tail) || !explicitlyPositive && /ない|なく|ず|不要|わから/.test(tail);
      if (!negated && !uncertain) interpretation.mechanism = 'unsupported';
      else if (!negated && interpretation.mechanism !== 'unsupported') { interpretation.mechanism = 'uncertain'; issue('other', clause, '非対応の動きを求めているのか確定できません。直線1か所の希望か確認してください。'); }
      consume(new RegExp(match[0] + '(?:(?:の話|について|に関して)?は|を)?(?:(?:させる|する)必要(?:は|が)?ない|させたくない|したくない|させずに?|させない|さずに?|しない|せずに?|ない|ずに?|不要|ではなく|じゃなく)?', 'i'));
    }
    const directionMatches = [...clause.matchAll(/(右|左|上|下)(?:へ|に|方向|向き)|\b(right|left|up|down)(?:ward)?\b/gi)];
    for (let i = 0; i < directionMatches.length; i++) {
      const match = directionMatches[i]!, next = directionMatches[i + 1]?.index ?? clause.length;
      const value = directionNames[(match[1] ?? match[2]!).toLowerCase()]!;
      const tail = clause.slice(match.index! + match[0].length, next), prefix = clause.slice(0, match.index!);
      const forbidden = /^(?:は|も|向かって)?(?:動かさず|動かさない|移動させず|移動しない|出さず|出さない|引かず|引かない|ではなく|じゃなく|しない)/.test(tail) || /(?:not|without)\s*$/i.test(prefix);
      if (forbidden) interpretation.direction.forbidden.push(value); else desired.push(value);
    }
    consume(/(?:右|左|上|下)(?:へ|に|方向|向き)(?:は|も)?(?:動かさずに?|動かさないで?|移動させずに?|移動しないで?|出さずに?|出さないで?|引かずに?|引かないで?|ではなく|じゃなく)?|\b(?:right|left|up|down)(?:ward)?\b/gi);

    const paperTopic = /紙|枚数|枚(?:まで|以内|以下|のまま)|sheets?|paper/i.test(clause);
    const sizeTopic = /絵|画像|作品|サイズ|大きさ|寸法|image|\bart\b|size/i.test(clause) && !/^(?:動き|距離|移動量)/.test(clause);
    if (paperTopic) {
      const noMore = /増や(?:さない|さず|したくない)|増加させない|追加しない|変更しない|変え(?:ない|ず)|そのまま|今のまま|維持|no more|without (?:more|adding)/i.test(clause);
      const caps = [...clause.matchAll(/(\d+|[一二三四五六七八九十])\s*枚(?:まで|以内|以下|のまま|に収め|を上限)/g)].map(m => /\d/.test(m[1]!) ? Number(m[1]) : '一二三四五六七八九十'.indexOf(m[1]!) + 1);
      if (noMore) papers.push({ kind: 'maintain' });
      for (const maxSheets of caps) papers.push({ kind: 'cap', maxSheets });
      if (!noMore && !caps.length) issue('paper', clause, '紙を増やす場合は新しい上限を枚数で指定し、具体的な変更を確認してください。');
      consume(/(?:厚紙|用紙|紙|枚数|A4|で|は|を|の|も|は)?\s*(?:\d+|[一二三四五六七八九十])\s*枚(?:まで|以内|以下|のまま|に収め|を上限)/g);
      consume(/増や(?:さない|さず|したくない|してよい|していい|して|せる)|増加させない|追加しない|変更しない|変え(?:ない|ず)|そのまま|今のまま|維持|no more (?:paper|sheets)|without (?:more|adding) (?:paper|sheets)/gi);
      consume(/厚紙|用紙|枚数|紙|A4|sheets?|paper/gi);
    }
    if (sizeTopic) {
      const keep = /保[つっち]|固定(?!しない)|そのまま|維持|変え(?:ない|ず|たくない)|変[更化]しない|縮小しない|縮め(?:ない|たくない)|小さくしない|大きくしない|いじらず|keep|same size/i.test(clause);
      const change = /(?:変更して|変えて|縮小して|小さくして|拡大して|大きくして|固定しない|変えてよい|変えていい|変えてもよい|変えてもいい)/.test(clause);
      if (keep) sizes.push('maintain'); if (change) sizes.push('change');
      if (!keep && !change && /サイズ|大きさ|寸法/.test(clause)) issue('size', clause, '絵の大きさの希望を確認してください。変更する場合は幅と高さを手動で指定してください。');
      if (keep || change) {
        consume(/保[つっちて]*|固定(?:しない)?|そのまま|維持|変え(?:ない|ず|たくない)|変[更化]しない|縮小しない|縮め(?:ない|たくない)|小さくしない|大きくしない|いじらず|変更して|変えて(?:もよい|もいい|よい|いい)?|縮小して|小さくして|拡大して|大きくして|keep|same size/gi);
        consume(/絵|画像|作品|大きさ|サイズ|寸法|image|\bart\b|size/gi);
      }
    }

    // Read distances only in the motion part, after size/paper clauses were consumed.
    const motion = rest;
    const amounts = [...motion.matchAll(/(-?\d+(?:\.\d+)?)\s*(mm|ミリ(?:メートル)?|cm|センチ(?:メートル)?)/gi)];
    for (let i = 0; i < amounts.length; i++) {
      const match = amounts[i]!, prefix = motion.slice(0, match.index!), tail = motion.slice(match.index! + match[0].length, amounts[i + 1]?.index ?? motion.length);
      const value = Number(match[1]), unit = /cm|センチ/i.test(match[2]!) ? 'cm' as const : 'mm' as const;
      if ((/今|現在|元は|以前|前は/.test(prefix) && !/より|追加|あと|増や/.test(prefix) && !/に(?:したい|して|する)|へ(?:変更|増)|増や|減ら|長く|短く/.test(tail)) || /^から/.test(tail)) { consume(new RegExp(match[0])); consume(/今(?:は|の距離は)?|現在(?:は|の距離は)?|元は|以前|前は|から/g); continue; }
      if (/^(?:は|に)?(?:動かさない|しない|ではなく|じゃなく|以外)/.test(tail)) { forbiddenDistancesMm.push(value * (unit === 'cm' ? 10 : 1)); consume(new RegExp(match[0])); consume(/(?:は|に)?(?:動かさない|しない|ではなく|じゃなく|以外)/g); continue; }
      const minus = /減ら|短く|小さく|減算|マイナス/.test(tail) || /(?:減ら|マイナス)[^\d]*$/.test(prefix);
      const plus = /長く|遠く|大きく|伸ば|増や|加え|足し|足す|プラス/.test(tail) || /(?:あと|追加で?|さらに|余分に|より|増や|プラス)[^\d]*$/.test(prefix);
      const targetAmount = /^(?:に|へ)\s*(?:増や|減ら|長く|短く|大きく|小さく|伸ば)/.test(tail);
      operations.push(!targetAmount && (minus || plus) ? { kind: 'relative', delta: minus ? -value : value, unit } : { kind: 'absolute', value, unit });
      if (targetAmount) {
        absoluteTrends.push({ targetMm: value * (unit === 'cm' ? 10 : 1), change: minus ? 'decrease' : 'increase' });
        if (/(?:あと|追加|余分に)[^\d]*$/.test(prefix)) issue('distance', clause, '追加量と到達する距離の指定が重なっています。増減量か絶対距離かを確認してください。');
      }
      if (!minus && !plus && /(?:大きく|遠く|長く).{0,8}動か/.test(prefix)) qualitative.push('increase');
      if (!minus && !plus && /(?:小さく|短く).{0,8}動か/.test(prefix)) qualitative.push('decrease');
      consume(new RegExp(match[0]));
    }
    const keepTravel = /(?:動き|距離|移動量|移動距離)(?:を|は)?.{0,3}(?:変え(?:ない|ず)|そのまま|維持|固定)|keep (?:the )?(?:distance|travel)/i.test(motion);
    if (keepTravel) { operations.push({ kind: 'maintain' }); consume(/(?:動き|距離|移動量|移動距離)(?:を|は)?.{0,3}(?:変え(?:ない|ず)|そのまま|維持|固定)|keep (?:the )?(?:distance|travel)/gi); }
    if (/(?:大きく|小さく|遠く|長く|短く).{0,5}(?:動かさない|しない|したくない)|(?:動き|距離|移動量).{0,5}(?:増やさない|減らさない)/.test(motion)) issue('distance', clause, '距離を維持するのか、増減を制限するのか確認してください。');
    if (!amounts.length && !keepTravel && !sizeTopic && !paperTopic) {
      const larger = /大きく|遠く|長く|増や|more|further|larger|longer/i.test(motion);
      const smaller = /小さく|短く|減ら|less|shorter|smaller/i.test(motion);
      if (larger) qualitative.push('increase'); if (smaller) qualitative.push('decrease');
    }
    consume(/あと|追加で?|さらに|余分に|現在より|今より|いまより|(?:今|いま)の(?:動き|距離)(?:より|から)|もっと|もう少し|少し|比べて|だけ|大きく|小さく|遠く|長く|短く|伸ば(?:す|して|したい)?|増や(?:す|して|したい)?|減ら(?:す|して|したい)?|加え(?:て|たい)?|足し(?:て|たい)?|足す|プラス|マイナス/gi);
    consume(/移動距離|動く距離|移動量|動き|距離|mm|cm|\b(?:move|travel|motion|movement|more|further|larger|longer|less|shorter|smaller)\b/gi);
    consume(/(?:動か|移動|出|引|進ま|直進|まっすぐ)(?:させ|せて|して|したい|す|せる|し|かす|かして|かしたい|かすように|て|たい|してほしい|してください)?/g);
    // Grammatical glue and neutral subject names only; unrecognized modifiers survive.
    consume(/お願いします|お願い|ください|してほしい|したい|したく|にする|にして|する|して|させて|ほしい|まっすぐ|直線|平行|目標|です|首|頭|手|腕|選んだ部分|選択した部分|部分|カメ|絵|へ|に|の|は|を|も|で|と|て|が|だけ|(?<![a-z])(?:please|the|and)(?![a-z])/gi);
    rest = rest.replace(/[\s()（）「」『』:：→]+/g, '');
    if (rest) issue(/\d/.test(rest) ? 'distance' : 'other', clause, /\d/.test(rest) ? '数値の対象や単位を確定できません。距離の単位と増減・絶対値を確認してください。' : `「${clause}」の条件をまだ解釈できません。認識できた部分だけでは実行しません。`);
    if (importantUnrepresented.test(clause) && !issues.some(i => i.text === clause)) issue('other', clause, `「${clause}」は方向・距離・寸法・紙上限だけでは表せません。`);
  }
  const unique = <T>(values: T[]) => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
  const ds = unique(desired); interpretation.direction.forbidden = unique(interpretation.direction.forbidden);
  if (ds.length === 1) interpretation.direction.desired = ds[0];
  if (ds.length > 1) issue('direction', text, '動かす方向を1つ選んでください。複数方向の動きには対応していません。');
  if (ds.some(d => interpretation.direction.forbidden.includes(d))) issue('direction', text, '同じ方向への希望と禁止が重なっています。');
  const ss = unique(sizes); if (ss.length === 1) interpretation.size = ss[0] as RequestInterpretation['size'];
  if (ss.length > 1) issue('size', text, '絵の大きさの維持と変更が重なっています。');
  const ps = unique(papers); if (ps.length === 1) interpretation.paper = ps[0]!;
  if (ps.length > 1) issue('paper', text, '紙の上限や増やさない希望が複数あります。今回の上限を確認してください。');
  const ops = unique(operations), qs = unique(qualitative);
  if (ops.length === 1) interpretation.distance = ops[0]!;
  if (ops.length > 1) issue('distance', text, '動く距離の指定が複数あります。今回の操作を1つ選んでください。');
  if (!ops.length && qs.length === 1) interpretation.distance = { kind: 'qualitative', change: qs[0]! };
  if (qs.length > 1) issue('distance', text, '距離を増やす希望と減らす希望が重なっています。');
  if (ops.length && qs.length) issue('distance', text, '数値と定性的な増減を併記しています。今回の距離の操作を確認してください。');
  if (forbiddenDistancesMm.length && !ops.length) issue('distance', text, '指定された距離にはしない希望です。使う距離を指定してください。');
  interpretation.unresolved = unique(issues.map(item => item.text));
  return { interpretation, issues, forbiddenDistancesMm, absoluteTrends };
}

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { args, codeSha, folders, mergePublicManifest, sha256 } from './common.js';

const problem = `【公開用下書き・ローカル実演】
絵を「手で動く紙工作」にしたくても、どこを切り、どの部品を裏へ付ければ動くかを考えるのは簡単ではありません。うごく紙工房は、親子や授業での工作を想定し、自分の絵から試作の型紙をつくる道具です。
絵の動かしたい部分を四角く囲み、方向と距離、保つ絵の大きさ、使える紙の枚数を決めます。寸法を直接調整できるほか、Gemmaへ「あと5mm動かしたい」と希望を伝えられます。AIの案は寸法と紙面配置を検査し、現在の作品と同じ縮尺で比較して、本人が選んだときだけ反映します。成立しない依頼では原本を保ち、理由を示します。AIが案を作れない場合もあり、手動で調整を続けられます。
採用した同じ設計版から、A4の型紙PDF、材料と組み立てガイドを取得できます。作品はブラウザに保存し、ファイルでも持ち出せます。
これまでのローカルGemma実行で提案・採用・PDFまで確認しています。クラウド公開、実物の印刷・組み立て、初見の人による操作は未確認。対応は矩形1か所を直線に引く1機構です。
`;
const architecture = `【公開用下書き・現在のローカル構成】
Reactの制作画面は「絵を選ぶ・動きをつける・印刷して作る」の3工程です。画像、設計、入力途中の内容、実物の記録はIndexedDBへ保存します。サーバーに利用者の作品を永続保存する構成ではありません。
Fastifyの同一オリジンAPIが画像を検証し、認証と実行上限を管理します。明示的な「AIで案をつくる」操作だけが、サーバーから同じ実行環境内のOllama／Gemmaへ接続します。画像そのものはモデルへ送らず、希望文、寸法、選択範囲、保護条件を扱います。Geminiへの自動切替はありません。
AIは希望の解釈と変更案を提案し、共通のTypeScriptコアが寸法、部品の干渉、A4配置、紙上限を決定的に検査します。本人の採用後、その同じ設計ID・版・ハッシュからPDFと組み立て図を生成します。検査の成功を実物の摩擦や耐久性の確認とは扱いません。
この資料はWSLで確認したローカル版の下書きです。公開構成と公開URLは未確定で、Cloud Runが利用者PCへ接続する説明ではありません。
`;
const description = `うごく紙工房 — 絵から、動く紙工作の試作へ

この動画はローカル版の実操作を収める提出用下書きです。クラウド公開・YouTube掲載・最終提出の完了を示すものではありません。
希望を伝えるAIと、寸法を確かめる検査を分け、候補を比較して本人が採用した設計版から型紙を出力します。AIが案を作れない場合もあり、そのときは作品を保ったまま手動で調整できます。

対応範囲：矩形1か所を直線に動かす引っぱりタブ、A4。
実物の印刷・組み立て、耐久性、初見の人の操作確認は未実施です。
ナレーション・音楽なし。字幕版です。AIの待ち時間を省略した区間は画面に明記します。
公開版URLとYouTube URLは、実際の公開後に確認して別途記入します。
`;

const options = args(process.argv.slice(2), ['--out']);
const { publicDir } = await folders(options['--out'] ?? 'artifacts/submission');
const texts = { 'problem-solution.txt': problem, 'architecture.txt': architecture, 'youtube-description.txt': description };
const counts: Record<string, { codePoints: number; utf16: number; sha256: string }> = {};
for (const [name, text] of Object.entries(texts)) {
  const item = { codePoints: [...text].length, utf16: text.length, sha256: sha256(text) };
  if (name !== 'youtube-description.txt' && (item.codePoints > 800 || item.utf16 > 800)) throw new Error(`${name} exceeds 800`);
  await writeFile(resolve(publicDir, name), text);
  counts[name] = item;
}
let svg = await readFile('docs/architecture.svg', 'utf8');
svg = svg.replace('うごく紙工房 — 設計データを中心にした構成', 'うごく紙工房 — ローカル構成（公開版は準備中）')
  .replace('同じコアで検査 → 比較・採用 → 同じ設計版のPDF / SVG', 'ローカル実演の構成 / 公開環境の検証は未完了')
  .replace('ModelProvider / adapter', 'Gemma / Ollama')
  .replace('Ollama：ローカル接続のみ', 'WSL内のループバック接続')
  .replace('実装資料 / Goal007-R / 2026-10-04', '提出素材の下書き / クラウド公開・実物確認は未完了');
await writeFile(resolve(publicDir, 'architecture.svg'), svg);
const png = await sharp(Buffer.from(svg)).png().toBuffer();
await writeFile(resolve(publicDir, 'architecture.png'), png);
await mergePublicManifest(publicDir, { status: 'LOCAL_DRAFT', preparedCodeSha: codeSha(), deploymentRevision: null, deploymentImageDigest: null, deploymentUrl: null, youtubeUrl: null, submitted: false, texts: counts, architecture: { svgSha256: sha256(svg), pngSha256: sha256(png), scope: 'Current local WSL architecture; not a verified cloud deployment' }, verification: { formCounter: 'not-checked', physicalAssembly: 'not-performed', firstTimeUsers: 'not-tested', cloudDeployment: 'not-deployed' } });
console.log(JSON.stringify({ status: 'LOCAL_DRAFT', texts: counts, prepared: ['architecture.svg', 'architecture.png'] }));

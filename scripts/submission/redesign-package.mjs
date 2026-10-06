/** Package reviewed, local submission assets. Never uploads or deploys anything.
 * node scripts/submission/redesign-package.mjs --assets-root /.../artifacts/submission --edition review-v2.1
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, readdir, stat, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
assert.equal(process.argv[2], '--assets-root'); assert([4, 6].includes(process.argv.length));
if (process.argv.length === 6) assert.equal(process.argv[4], '--edition');
const edition = process.argv[5] ?? 'review-v2';
assert(['review-v2', 'review-v2.1'].includes(edition));
const finalized = edition === 'review-v2.1';
const base = resolve(process.argv[3]);
if (!finalized) await access(join(base, 'private/material-finalize-20261006/preservation.json')).then(() => {
  throw new Error('review-v2 is preserved. Use --edition review-v2.1; reproduce historical editions only in an isolated assets root.');
}, error => { if (error.code !== 'ENOENT') throw error; });
const old = join(base, 'public/goal011'), out = join(old, edition);
const previousWork = join(base, 'private/material-redesign-20261006');
const work = finalized ? join(base, 'private/material-finalize-20261006') : previousWork;
const read = async p => JSON.parse(await readFile(p, 'utf8'));
const hash = async p => createHash('sha256').update(await readFile(p)).digest('hex');
const baseline = await read(join(previousWork, 'old-baseline.json'));
const images = await read(join(work, 'images/provenance.json'));
const edl = await read(join(work, 'video/edit-decisions.json'));
const review = await read(join(work, 'video/review/technical-review.json'));
const accepted = await read(join(work, 'acceptance.json'));
const copy = await read(new URL('./redesign-copy.json', import.meta.url));
const oldManifest = await read(join(old, 'manifest.json'));
const preservation = finalized ? await read(join(work, 'preservation.json')) : null;
if (preservation) for (const f of preservation.preservedFiles) assert.equal(await hash(join(base, f.path)), f.sha256, `Preserved review-v2 changed: ${f.path}`);
assert.equal(accepted.accepted, true);
assert.equal(accepted.videoSha256, await hash(join(out, 'demo.mp4')));
assert.equal(accepted.videoSha256, edl.sha256);
assert.equal(review.sha256, edl.sha256);
assert.equal(review.fullDecode, 'passed-all4428-frames-no-errors');
assert.equal(review.playback.ended, true);
assert.equal(review.playback.playbackRate, 1);
assert.equal(review.playback.quality.corruptedVideoFrames, 0);
assert.equal(review.browserErrors.pageErrors.length + review.browserErrors.consoleErrors.length + review.browserErrors.blockedExternalRequests.length, 0);
for (const file of baseline.originalFiles) assert.equal(await hash(join(old, file.path)), file.sha256, `Old source changed: ${file.path}`);
assert.equal(await hash(join(base, 'ugoku-kami-goal011-submission.zip')), baseline.oldZip.sha256);
for (const img of images.images) {
  assert.equal(await hash(join(out, 'images', img.file)), img.sha256);
  assert.equal(accepted.imageSha256[img.file], img.sha256);
}
const copies = ['architecture.png', 'architecture.svg', 'fish-revision3.pdf', 'public-variant-35mm-revision3.pdf', 'physical-handoff.txt'];
for (const file of copies) await copyFile(join(old, file), join(out, file));
for (const [field, file] of [['problemSolution', 'problem-solution.txt'], ['architecture', 'architecture.txt']]) {
  const text = copy.submissionTextDrafts[field];
  assert([...text].length <= 800 && text.length <= 800);
  await writeFile(join(out, file), text + '\n');
}
const url = oldManifest.publication.publicAppUrl;
const lines = [
  `うごく紙工房 — Zenn提出用の最新版 ${edition}（2026年10月6日）`,
  '',
  '画像4枚と2分57.12秒の無音デモを、実画面・実出力中心に再編集した版です。',
  'このREADMEの一覧を提出素材の選択基準にしてください。旧版と混在させず、このフォルダ一式を使います。',
  `素材一式：ugoku-kami-goal011-${edition}.zip（artifacts/submission/直下）`,
  '画像・動画・本文・構成図・PDF・ZIPはGit管理対象外です。制作コード・確定コピー・再生成手順はGitに管理します。',
  `ローカル保存先：${out}`,
  finalized ? '以前のreview-v2（動画ca6c7b67…）と旧ZIPは保全済み。冒頭だけ調整したreview-v2.1を新しい提出候補にします。' : '旧素材と旧提出ZIPは保全しています。',
  '',
  'Zennで差し替えるもの',
  '・プロジェクトイメージ1：images/01-from-your-art.png — 自分の絵を選ぶ',
  '・プロジェクトイメージ2：images/02-five-more-millimeters.png — あと5mm・紙1枚を維持',
  '・プロジェクトイメージ3：images/03-compare-and-choose.png — AI提案・コード検査・作者採用',
  '・プロジェクトイメージ4：images/04-full-size-kit.png — 採用版から原寸PDFとガイド',
  '・課題と解決：problem-solution.txt',
  '・アーキテクチャ説明：architecture.txt',
  '・動画URL：demo.mp4を本人がYouTubeへ投稿した後、その実URLを設定',
  '・構成図：architecture.png（従来ファイルと同一。SVGも同梱）',
  '',
  `既存のデプロイURL：${url}`,
  '手動制作はGoogleログイン・コード不要。AIのみ審査用コードが必要です。コードは同梱していません。',
  '今回、公開アプリ・Cloud設定・監視の変更、新しいAI依頼、YouTube投稿、Zenn提出は行っていません。',
  '',
  '動画の見方と出所',
  ...(finalized ? [
    '・0:00〜0:10：同じ25→30mm作品の実画面3抜粋。自分の絵（3.2秒）、条件保持の候補比較（3.2秒）、採用30mm第3版の実PDF・ガイド（3.6秒）。すべて静止表示で、連続操作ではありません。',
    '・0:10〜1:03：別セッションのローカル手動収録。絵の読み込み・選択・正面・裏側を操作。旧版と重複する選択確認を2秒短縮。',
  ] : ['・0:00〜1:03：ローカル手動収録。自作の魚の絵を読み込み、選択・正面・裏側を操作。']),
  '・1:03〜1:33.12：2026年10月5日の実Vertex記録。別の25mm作品を30mmへ。比較を読む静止表示を挿入。',
  '・1:33.12〜2:33.12：上記の保存済み30mm採用版をローカルで開き、PDF・ガイド・保存再読込を新収録。',
  '・2:33.12〜2:49.12：別作品の公開版実画面を静止表示。希望70mmに対し検査済み代案35mm。',
  '・2:49.12〜2:57.12：ローカル手動のプレビューを再掲して締める。',
  '録画は等速、静止画は画面上でも区別しています。一つの連続セッションではありません。',
  '177.12秒 / 1920×1080 / 25fps / H.264 / 無音。字幕を画面に焼込み、補助SRTも同梱。',
  '',
  'PDFを区別してください',
  '・fish-revision3.pdf：25→30mmを採用した160×110mm作品の第3版。画像2・4、動画のPDF工程に対応。',
  '・public-variant-35mm-revision3.pdf：幅168mmの別作品、35mmの第3版。画像3・動画の別依頼に対応。',
  'どちらも従来取得した実PDFを同じバイトで同梱。型紙1ページ＋説明4ページです。',
  '新しい手動収録で再取得したPDFも30mmの同じdesignHashですが、PDFバイトは異なるため私的証拠側に保存。',
  '実物の印刷・組立・動作は未確認です。実物確認の手順はphysical-handoff.txt。',
  '',
  `確認範囲：画像4枚の原寸目視、動画全4428フレームのデコード、等速通し再生、全${edl.scenes.length}場面と${edl.scenes.length - 1}カット前後の実フレーム確認。`,
  '画像と動画の出所・ハッシュ・切出し位置・検査記録の要約はmanifest.json。改善理由はbefore-after.txt。',
];
await writeFile(join(out, 'README.txt'), lines.join('\n') + '\n');
await writeFile(join(out, 'before-after.txt'), (finalized ? [
  'review-v2 → review-v2.1 の変更',
  '旧冒頭8秒は手動プレビューだけだったため、同じ実AI作品の「自分の絵」「条件を守った25→30mm案」「採用した30mm第3版の原寸PDF」を10秒の静止抜粋で先に紹介します。既存の字幕形式と装飾量を維持しました。',
  '旧手動選択の確認区間を8秒から6秒へ短縮。33秒以降は旧版と同じ開始時刻・同じエンコード済み映像です。総尺177.12秒を維持しました。',
  '画像4枚・本文2欄・構成図・2つのPDFはreview-v2と同じバイトです。新収録・追加AI生成・公開アプリや監視の変更はありません。旧review-v2の16ファイルとZIPを保全しました。',
] : [
  '変更の意図',
  '旧版の課題は、実画面よりも説明文・出所表示・検査説明が先に目に入りやすいことでした。架空のAI成功や生成画像が混じっていたという判定ではありません。',
  '画像：全画面キャプチャ4枚をそのまま並べる構成から、選択／条件付き比較／検査と本人採用／同版キットの4役へ。見出しを1つに絞り、実画面を必要な範囲だけ切り出し、白系の背景・同じ余白・1色のアクセントで統一しました。',
  '動画：冒頭10秒の説明カードを作品の動きへ変更。手動操作を新収録し、主字幕は原則1文。比較には読む時間を置き、採用後のPDF・ガイド・保存を通して見せます。別作品の70mm希望／35mm代案は後段へ移しました。',
  '長い構成図の章と重い黒字幕帯を外し、構成図は独立資料として保持。実画面・数値・検査結果を描き替えず、実物の成功写真は追加していません。',
  '旧176.40秒→新177.12秒。尺を増やすことより、視線と順序を整理することを重視しました。',
]).join('\n\n') + '\n');
async function filesIn(dir, prefix = '') {
  const result = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) result.push(...await filesIn(join(dir, e.name), prefix + e.name + '/'));
    else result.push(prefix + e.name);
  }
  return result.sort();
}
const publicFiles = (await filesIn(out)).filter(p => p !== 'manifest.json');
if (finalized) for (const f of [...copies, 'problem-solution.txt', 'architecture.txt', ...images.images.map(i => 'images/' + i.file)]) assert.equal(await hash(join(out, f)), await hash(join(old, 'review-v2', f)), `Unchanged asset differs: ${f}`);
// The secret is used only for an in-memory membership check and is never logged.
const knownSecret = (await readFile(join(base, 'private/goal011/ai-access-code.txt'), 'utf8')).trim();
assert(knownSecret.length >= 16);
for (const f of publicFiles) assert(!(await readFile(join(out, f))).includes(Buffer.from(knownSecret)), 'Known private credential detected');
const toolingCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' }).trim();
const integration = finalized ? await read(join(work, 'integration-status.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : null;
if (integration) {
  assert.equal(integration.mainSha, toolingCommit);
  assert.equal(integration.pushed, true);
  assert.deepEqual(integration.ci.map(run => run.name).sort(), ['Check', 'WebKit representative workflow']);
  assert(integration.ci.every(run => run.headSha === toolingCommit && run.status === 'completed' && run.conclusion === 'success'));
}
const manifest = {
  schemaVersion: 1, createdAt: new Date().toISOString(), status: 'LOCAL_MATERIALS_REVIEWED_READY_FOR_USER_SUBMISSION',
  publication: { publicAppUrl: url, appSourceCodeSha: baseline.appSourceSha, monitorSourceCodeSha: baseline.monitorSourceSha, changedByThisWork: false, newCloudCalls: 0, newModelCalls: 0, videoUploadedByThisWork: false, zennSubmittedByThisWork: false },
  repository: { toolingCommit, baseMainSha: baseline.oldMainSha, branch: execFileSync('git', ['branch', '--show-current'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' }).trim(), productCodeChanges: false },
  mainIntegration: integration,
  edition, localAssetsDirectory: out, assetsTrackedByGit: false,
  video: { file: 'demo.mp4', sha256: edl.sha256, durationSeconds: edl.durationSeconds, width: 1920, height: 1080, fps: 25, frames: 4428, audio: false, classification: edl.composition, opening: edl.opening, sourceTimeline: edl.scenes.map(({ id, kind, sourceStart, duration, outputStart, outputEnd, sourceSha256, caption, label, playbackRate }) => ({ id, kind, sourceStart, sourceEnd: sourceStart === undefined ? undefined : Number((sourceStart + duration).toFixed(3)), duration, outputStart, outputEnd, sourceSha256, caption, label, playbackRate })), sources: { newManualCodeSha: edl.sourceCodeSha, historicalRealAiCodeSha: edl.historicalAiCodeSha, actualPublicStillCodeSha: baseline.appSourceSha }, excludedHistoricalSettings: edl.historicalSettingsExcluded },
  images, pdf: { exact30mm: { file: 'fish-revision3.pdf', ...images.bindings.kit }, alternative35mm: { file: 'public-variant-35mm-revision3.pdf', designHash: '45962ad2a339ab8af1df14cf378e7130177222f116a2bf6dc2c750c6f5cfe466', revision: 3, requestedTravelMm: 70, candidateTravelMm: 35, widthMm: 168, fulfillsRequested: false } },
  textCounts: copy.textCounts,
  review: { fullDecode: review.fullDecode, playback: { ended: review.playback.ended, duration: review.playback.duration, playbackRate: review.playback.playbackRate, wallMs: review.playback.wallMs, quality: review.playback.quality }, frameSampling: review.frameSampling, visual: accepted.visual, knownPrivateCredentialMatch: false, physicalValidation: 'unverified' },
  preservation: { previousReviewV2FilesAndZipVerified: preservation?.preservedFiles.length, originalFilesVerified: baseline.originalFiles.length, oldZipSha256: baseline.oldZip.sha256, originalArchitectureAndPdfsByteIdentical: true },
  files: await Promise.all(publicFiles.map(async path => ({ path, bytes: (await stat(join(out, path))).size, sha256: await hash(join(out, path)) }))),
};
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
assert(!(await readFile(join(out, 'manifest.json'))).includes(Buffer.from(knownSecret)), 'Known private credential detected');
const zip = join(base, `ugoku-kami-goal011-${edition}.zip`);
execFileSync('python3', ['-c', 'import pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED,compresslevel=9) as z:\n for f in sorted(p.rglob("*")):\n  if f.is_file(): z.write(f,p.name+"/"+str(f.relative_to(p)))\nwith zipfile.ZipFile(sys.argv[2]) as z: assert z.testzip() is None', out, zip], { stdio: 'pipe' });
await writeFile(join(work, 'package-result.json'), JSON.stringify({ out, zip, sha256: await hash(zip), bytes: (await stat(zip)).size, files: manifest.files.length + 1, originalsUnchanged: true, credentialScan: 'no known private credential matched', toolingCommit }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ out, zip, bytes: (await stat(zip)).size, sha256: await hash(zip), originalsUnchanged: true }));

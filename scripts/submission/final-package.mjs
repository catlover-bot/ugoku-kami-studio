/** Goal014 local packaging. Requires the exact movie's completed review and visual acceptance.
 * node scripts/submission/final-package.mjs --assets-root /absolute/artifacts/submission
 * No upload, Cloud call, model call or product edit. Old editions remain immutable.
 */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { readFile, writeFile, copyFile, readdir, lstat, mkdir, mkdtemp, access } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';

assert.equal(process.argv[2], '--assets-root'); assert.equal(process.argv.length, 4);
const assets = resolve(process.argv[3]), edition = 'goal014-final';
const out = join(assets, 'public', edition), work = join(assets, 'private', edition);
const repo = fileURLToPath(new URL('../..', import.meta.url));
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = async path => sha(await readFile(path));
const exists = async path => access(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
function assetPath(path) {
  assert(typeof path === 'string' && path.length > 0);
  const resolved = resolve(assets, path), rel = relative(assets, resolved);
  assert(rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep), 'Asset path must stay inside the assets root');
  return { absolute: resolved, relative: rel.split(sep).join('/') };
}
async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), 'Symlinks are not public assets');
    if (entry.isDirectory()) files.push(...await inventory(join(directory, entry.name), `${prefix}${entry.name}/`));
    else { assert(entry.isFile(), 'Only regular public files are permitted'); files.push(prefix + entry.name); }
  }
  return files.sort();
}
const preservation = await read(join(work, 'preservation.json'));
assert.equal(preservation.files.length, 90, 'The original 90 assets must be covered');
assert.equal(new Set(preservation.files.map(f => f.path)).size, 90);
async function verifyPreserved() {
  for (const file of preservation.files) {
    const p = assetPath(file.path).absolute;
    assert((await lstat(p)).isFile());
    const bytes = await readFile(p);
    assert.equal(bytes.length, file.bytes, `Preserved size changed: ${file.path}`);
    assert.equal(sha(bytes), file.sha256, `Preserved hash changed: ${file.path}`);
  }
}
await verifyPreserved();
const edlFile = join(work, 'video/edit-decisions.json'), reviewFile = join(work, 'video/review/technical-review.json');
const edl = await read(edlFile), review = await read(reviewFile), accepted = await read(join(work, 'acceptance.json'));
const copyFilePath = fileURLToPath(new URL('./final-copy.json', import.meta.url));
const copy = await read(copyFilePath), originalImages = await read(join(assets, 'public/goal013-ui/manifest.json'));
const bindingsFile = join(work, 'pdf-bindings.json'), bindings = await read(bindingsFile);
const captureLocation = assetPath(edl.captureDirectory), captureDirectory = captureLocation.relative;
const captureManifestPath = join(captureLocation.absolute, 'capture.json');
assert(/^[a-f0-9]{64}$/.test(edl.captureSha256), 'EDL must bind the completed capture manifest');
assert.equal(await hash(captureManifestPath), edl.captureSha256, 'Capture manifest changed after editing');
const capture = await read(captureManifestPath);
assert.equal(capture.status, 'passed'); assert.equal(capture.aiCalls, 0); assert.equal(capture.cloudCalls, 0);
assert.equal(capture.aiProvider, 'none'); assert.equal(capture.rehearsal, false); assert.equal(capture.submissionFootage, true);
assert(/^[a-f0-9]{40}$/.test(edl.captureSourceSha)); assert.equal(capture.sourceSha, edl.captureSourceSha);
assert(Array.isArray(capture.clips));
const movieSha = await hash(join(out, 'demo.mp4')), frames = Math.round(edl.durationSeconds * 25);
assert.equal(copy.edition, edition); assert.equal(copy.scope.newModelCalls, 0); assert.equal(copy.scope.newCloudChanges, 0);
assert.equal(accepted.accepted, true); assert.equal(accepted.videoSha256, movieSha); assert.equal(edl.sha256, movieSha);
assert.equal(review.sha256, movieSha); assert.equal(review.edlSha256, await hash(edlFile));
assert.equal(review.result, 'technical-pass-visual-review-pending');
assert.equal(review.fullDecode, `passed-all${frames}-frames-no-errors`); assert.equal(review.totalFrames, frames);
assert.equal(edl.width, 1920); assert.equal(edl.height, 1080); assert.equal(edl.fps, 25);
assert(edl.durationSeconds >= 150 && edl.durationSeconds <= 195); assert.equal(edl.newCloudCalls, 0); assert.equal(edl.newModelCalls, 0);
assert.equal(review.playback.ended, true); assert.equal(review.playback.playbackRate, 1);
assert(Math.abs(review.playback.duration - edl.durationSeconds) < .05);
assert.equal(review.playback.quality.corruptedVideoFrames, 0);
assert.equal(review.browserErrors.pageErrors.length + review.browserErrors.consoleErrors.length + review.browserErrors.blockedExternalRequests.length, 0);
assert.equal(review.frameSampling.midpoints, edl.scenes.length);
assert.equal(review.frameSampling.boundaryAdjacentFrames, 2 * (edl.scenes.length - 1));
assert(Array.isArray(review.frameSampling.uniqueFrameHashes) && review.frameSampling.uniqueFrameHashes.length > 0);
assert.equal(review.frameSampling.extractedUniqueFrames, review.frameSampling.uniqueFrameHashes.length);
assert(accepted.visual && typeof accepted.visual === 'object', 'Visual acceptance must state the actually reviewed scope');
if (review.playback.quality.droppedVideoFrames > 0) assert.equal(accepted.visual.droppedFramesReviewed, true, 'Nonzero dropped frames require an explicit visual review acknowledgement');
for (const sample of review.frameSampling.uniqueFrameHashes) assert.equal(await hash(join(work, 'video/review', sample.file)), sample.sha256);

const expectedImageNames = ['01-select-your-art.png', '02-set-the-motion.png', '03-compare-manual-proposal.png', '04-print-the-adopted-version.png'];
assert.deepEqual(copy.images.map(i => i.file).sort(), expectedImageNames.map(n => `images/${n}`).sort());
assert(Array.isArray(accepted.images) && accepted.images.length === 4);
const acceptedImages = new Map(accepted.images.map(i => [i.file.startsWith('images/') ? i.file : `images/${i.file}`, i.sha256]));
assert.equal(acceptedImages.size, 4);
const imageMetadata = [];
for (const item of copy.images) {
  const name = item.file.slice('images/'.length), source = `public/goal013-ui/${name}`;
  assert.equal(item.source, source); assert.equal(item.copyMode, 'exact-bytes');
  const original = originalImages.images.find(i => i.file === name); assert(original);
  const digest = await hash(join(assets, source)); assert.equal(digest, original.sha256); assert.equal(acceptedImages.get(item.file), digest);
  imageMetadata.push({ file: item.file, source, sha256: digest, title: item.title, description: item.description, stamp: original.stamp, processing: 'none; byte-identical Goal013 screenshot' });
}
assert.equal(copy.architecture.sourceDirectory, 'public/goal011/review-v2.1/');
assert.deepEqual([...copy.architecture.files].sort(), ['architecture.png', 'architecture.svg']);
assert.equal(copy.architecture.copyMode, 'exact-bytes');
assert(Array.isArray(bindings.pdfs) && bindings.pdfs.length >= 1 && bindings.pdfs.length <= 2);
assert.equal(bindings.pdfs.filter(p => p.role === 'historical-adopted').length, 1);
assert(bindings.pdfs.filter(p => p.role === 'new-ui-manual').length <= 1);
const pdfs = [];
for (const entry of bindings.pdfs) {
  assert(['historical-adopted', 'new-ui-manual'].includes(entry.role));
  assert.equal(entry.file, entry.role === 'historical-adopted' ? 'historical-adopted-30mm-r3.pdf' : 'manual-proposal-30mm.pdf');
  const source = assetPath(entry.source), bytes = await readFile(source.absolute);
  const clipName = entry.role === 'historical-adopted' ? 'kit-B' : 'manual-A';
  const matchedClips = capture.clips.filter(clip => clip.name === clipName);
  assert.equal(matchedClips.length, 1, 'Each PDF must have one completed capture clip');
  const clip = matchedClips[0]; assert.equal(clip.status, 'passed'); assert(clip.pdf && clip.document);
  assert.equal(assetPath(clip.directory).absolute, join(captureLocation.absolute, clipName));
  assert.equal(source.absolute, assetPath(clip.pdf.path).absolute, 'PDF must be the file downloaded in this capture');
  assert(source.absolute.startsWith(assetPath(clip.directory).absolute + sep));
  assert.equal(entry.sha256, clip.pdf.sha256, 'PDF bytes must match the capture download');
  for (const field of ['designId', 'revision', 'designHash']) {
    assert.equal(entry[field], clip.pdf[field], `PDF ${field} differs from capture`);
    assert.equal(entry[field], clip.document[field], `Captured document ${field} differs from PDF`);
  }
  if (entry.captureDirectory !== undefined) assert.equal(assetPath(entry.captureDirectory).relative, captureDirectory);
  const raw = assetPath(clip.rawVideo);
  assert.equal(await hash(raw.absolute), clip.rawSha256);
  assert(edl.scenes.some(scene => scene.kind === 'video' && assetPath(scene.input).absolute === raw.absolute && scene.sourceSha256 === clip.rawSha256), 'The PDF capture clip must also appear in this movie');
  assert.equal(sha(bytes), entry.sha256); assert.equal(await hash(join(out, entry.file)), entry.sha256, 'Root-supplied PDF must match its recorded source');
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal(pdf.getTitle(), `${entry.designId} revision ${entry.revision}`);
  assert(pdf.getSubject()?.includes(entry.designHash)); assert(pdf.getSubject()?.includes('physically unverified'));
  for (const page of pdf.getPages()) { const size = page.getSize(); assert(Math.abs(size.width * 25.4 / 72 - 210) < 1e-6 && Math.abs(size.height * 25.4 / 72 - 297) < 1e-6); }
  assert.equal(pdf.getPageCount(), clip.pdf.pages); assert.equal(clip.pdf.A4, true);
  if (entry.role === 'historical-adopted') {
    assert.equal(entry.designId, 'goal009-comparison-fish'); assert.equal(entry.revision, 3);
    assert.equal(entry.designHash, '5b3d233852f77d3d47610aecb9fbf49a8b61c345b6faa8f0236252850b18fdd8');
    assert.equal(pdf.getPageCount(), 5);
  }
  pdfs.push({ file: entry.file, source: source.relative, sha256: entry.sha256, role: entry.role, designId: entry.designId, revision: entry.revision, designHash: entry.designHash, pages: pdf.getPageCount(), A4: true, physicalValidation: 'unverified', captureDirectory, captureManifestSha256: edl.captureSha256, captureClip: clipName });
}
if (pdfs.length === 2) assert.notEqual(pdfs[0].designId, pdfs[1].designId, 'Manual A and historical B are distinct recorded projects');
const optionalCaptions = await exists(join(out, 'captions.srt'));
assert(optionalCaptions, 'The renderer must supply captions.srt');
const allowed = new Set(['demo.mp4', ...(optionalCaptions ? ['captions.srt'] : []), ...copy.images.map(i => i.file), 'architecture.png', 'architecture.svg', ...pdfs.map(p => p.file), 'problem-solution.txt', 'architecture.txt', 'README.txt', 'manifest.json']);
for (const name of await inventory(out)) assert(allowed.has(name), `Unexpected public asset: ${name}`);
const stageRoot = await mkdtemp(join(work, 'package-')), stage = join(stageRoot, edition);
await mkdir(join(stage, 'images'), { recursive: true, mode: 0o700 });
for (const file of ['demo.mp4', ...(optionalCaptions ? ['captions.srt'] : []), ...pdfs.map(p => p.file)]) await copyFile(join(out, file), join(stage, file), constants.COPYFILE_EXCL);
for (const image of imageMetadata) await copyFile(join(assets, image.source), join(stage, image.file), constants.COPYFILE_EXCL);
const architectures = [];
for (const file of ['architecture.png', 'architecture.svg']) { const source = `public/goal011/review-v2.1/${file}`; await copyFile(join(assets, source), join(stage, file), constants.COPYFILE_EXCL); architectures.push({ file, source, sha256: await hash(join(stage, file)), processing: 'exact bytes; existing technical diagram' }); }
const textCounts = {};
for (const [key, file] of [['problemSolution', 'problem-solution.txt'], ['architecture', 'architecture.txt']]) {
  const text = copy.submissionTextDrafts[key]; assert(typeof text === 'string' && text.trim());
  const counts = { codePoints: [...text].length, utf16: text.length }; assert(counts.codePoints <= 800 && counts.utf16 <= 800);
  assert.deepEqual(counts, copy.textCounts[key]); textCounts[key] = counts;
  await writeFile(join(stage, file), text + '\n');
}
const oldManifest = await read(join(assets, 'public/goal011/review-v2.1/manifest.json'));
const publicAppUrl = copy.publicAppUrl ?? oldManifest.publication.publicAppUrl;
const url = new URL(publicAppUrl); assert.equal(url.protocol, 'https:'); assert(!url.username && !url.password && !url.search);
const toolingCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const integrationPath = join(work, 'integration-status.json'); let mainIntegration = null;
if (await exists(integrationPath)) {
  const integration = await read(integrationPath);
  assert.equal(integration.mainSha, toolingCommit); assert.equal(integration.pushed, true);
  assert.deepEqual(integration.ci.map(run => run.name).sort(), ['Check', 'WebKit representative workflow']);
  assert(integration.ci.every(run => run.headSha === toolingCommit && run.status === 'completed' && run.conclusion === 'success'));
  mainIntegration = integration;
}
const formatTime = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
const readme = [
  'うごく紙工房 — Goal014 最終提出候補（ローカル素材）', '',
  'このフォルダ一式を今回の素材の選択基準にしてください。旧版の素材・ZIPはそのまま保持しています。',
  '素材一式：ugoku-kami-goal014-final.zip（artifacts/submission/直下）',
  'リポジトリからの保存先：artifacts/submission/public/goal014-final/',
  'ZIP保存先：artifacts/submission/ugoku-kami-goal014-final.zip',
  '画像・動画・PDF・本文・ZIPはGit管理外です。制作スクリプトと確定コピーはGit管理します。', '',
  '提出用の画像4枚（Goal013実画面そのまま）',
  ...imageMetadata.map((i, n) => `${n + 1}. ${i.file} — ${i.title}。${i.description}`),
  copy.imageSequenceNote, '',
  `動画：demo.mp4 / ${edl.durationSeconds.toFixed(2)}秒 / 1920×1080 / 25fps / 無音。${optionalCaptions ? '補助字幕 captions.srt を同梱。' : ''}`,
  '新UIの手動A、過去の実Vertex、同じ採用済み版を新UIへ開くBは別セッションです。',
  '過去の実AI依頼は「魚を右へ30mm動かしたい。絵の大きさと紙の枚数は変えない」。元25→30mmの差分と、相対量の依頼実績を混同しません。',
  ...edl.scenes.map(s => `${formatTime(s.outputStart)}–${formatTime(s.outputEnd)} ${s.label} / ${s.caption}${s.kind === 'still' ? '（静止表示）' : '（等速）'}`), '',
  'PDFを区別してください',
  ...pdfs.map(p => `${p.file}：${p.role === 'historical-adopted' ? '過去の実AIで採用した正本を新UIで再取得' : '新UIの手動候補を採用した別作品'}。${p.designId} / 第${p.revision}版 / ${p.pages}ページ / A4。`),
  '設計ID・版・hashで対応します。PDFの日時metadataによるバイト差と設計変更を区別します。',
  '画像4枚の20→25mm作品は動画A/Bと別の記録です。実物の印刷・組立・動作確認は未実施です。', '',
  '本文：problem-solution.txt、architecture.txt。構成図：architecture.png / architecture.svg（旧版と同一バイト）。',
  `既存アプリURL：${publicAppUrl}`,
  '手動制作はGoogleログイン・コード不要。AIの審査用コードは同梱しません。',
  '今回の素材制作でアプリ・Cloud設定を変更せず、新しいモデル呼出しも行っていません。',
  'YouTube投稿・Zenn最終提出は行っていません。動画を投稿した後の実URLは本人が設定します。',
  ...(copy.readmeNotes ?? []), '',
  `検査：全${frames}フレームをデコード、ローカル1x全編再生、全${edl.scenes.length}場面中点と全${edl.scenes.length - 1}カット前後のフレーム抽出。目視範囲はmanifestに記録。`,
  '通常再生とサンプルフレームの目視は、全フレームを1枚ずつ目視したという意味ではありません。',
  mainIntegration ? `制作コードmain統合：${mainIntegration.mainSha}（同SHA CI成功）。撮影時SHAとは別です。` : '制作コードの最終main統合・同SHA CIは別記録で後から追記できます。撮影時SHAへ付け替えません。',
];
await writeFile(join(stage, 'README.txt'), readme.join('\n') + '\n');
const files = await Promise.all((await inventory(stage)).map(async path => ({ path, bytes: (await lstat(join(stage, path))).size, sha256: await hash(join(stage, path)) })));
const manifest = {
  schemaVersion: 1, edition, createdAt: new Date().toISOString(), status: 'LOCAL_MATERIALS_REVIEWED_READY_FOR_USER_SUBMISSION', assetsTrackedByGit: false, localAssetsDirectory: 'artifacts/submission/public/goal014-final/',
  publication: { publicAppUrl, changedByThisWork: false, newCloudCalls: 0, newModelCalls: 0, youtubeUploadedByThisWork: false, zennSubmittedByThisWork: false },
  repository: { toolingCommit, productChanges: false }, mainIntegration,
  video: { file: 'demo.mp4', sha256: movieSha, durationSeconds: edl.durationSeconds, width: 1920, height: 1080, fps: 25, frames, audio: false, captureDirectory, captureSourceSha: edl.captureSourceSha, captureSha256: edl.captureSha256, edl: { file: 'private/goal014-final/video/edit-decisions.json', sha256: await hash(edlFile) }, sessions: copy.video.sessions,
    scenes: edl.scenes.map(s => ({ id: s.id, kind: s.kind, source: assetPath(s.input).relative, sourceSha256: s.sourceSha256, sourceStart: s.sourceStart, sourceEnd: s.sourceStart === undefined ? undefined : Number((s.sourceStart + s.duration).toFixed(6)), duration: s.duration, outputStart: s.outputStart, outputEnd: s.outputEnd, caption: s.caption, label: s.label, playbackRate: s.playbackRate })) },
  images: { sourceManifest: { file: 'public/goal013-ui/manifest.json', sha256: await hash(join(assets, 'public/goal013-ui/manifest.json')) }, captureSource: originalImages.capture.sourceBinding, note: copy.imageSequenceNote, items: imageMetadata },
  architecture: architectures, pdfs, textCounts, copySource: { file: 'scripts/submission/final-copy.json', sha256: await hash(copyFilePath) },
  review: { technicalSha256: await hash(reviewFile), fullDecode: review.fullDecode, playback: review.playback, frameSampling: review.frameSampling, visual: accepted.visual, acceptanceSha256: await hash(join(work, 'acceptance.json')), physicalValidation: 'unverified', knownCredentialByteScan: 'no match; pixel visibility is covered separately by visual acceptance' },
  preservation: { file: 'private/goal014-final/preservation.json', sha256: await hash(join(work, 'preservation.json')), originalFileCount: preservation.files.length, originalsUnchanged: true }, files,
};
await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
// Known credentials stay in memory. Never print their value or scan contents.
const secret = (await readFile(join(assets, 'private/goal011/ai-access-code.txt'), 'utf8')).trim();
assert(secret.length >= 16, 'Expected private credential for local scan is missing');
const patterns = [...new Set([secret, Buffer.from(secret).toString('base64'), encodeURIComponent(secret)])].map(s => Buffer.from(s));
const stagedFiles = await inventory(stage); assert.deepEqual(stagedFiles, [...allowed].sort());
for (const name of stagedFiles) { const bytes = await readFile(join(stage, name)); assert(patterns.every(p => !bytes.includes(p)), 'Private credential match detected; packaging refused'); }
const stagedZip = join(stageRoot, 'ugoku-kami-goal014-final.zip'), extracted = join(stageRoot, 'extracted');
execFileSync('python3', ['-c', `import pathlib,sys,zipfile
p=pathlib.Path(sys.argv[1]); zpath=pathlib.Path(sys.argv[2]); extracted=pathlib.Path(sys.argv[3])
files=sorted(f for f in p.rglob('*') if f.is_file()); expected=[p.name+'/'+f.relative_to(p).as_posix() for f in files]
with zipfile.ZipFile(zpath,'x',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for f,name in zip(files,expected): z.write(f,name)
with zipfile.ZipFile(zpath) as z:
 assert z.namelist()==expected and len(set(z.namelist()))==len(expected)
 assert z.testzip() is None
 for info in z.infolist():
  assert not pathlib.PurePosixPath(info.filename).is_absolute() and '..' not in pathlib.PurePosixPath(info.filename).parts
 z.extractall(extracted)
for f,name in zip(files,expected): assert f.read_bytes()==(extracted/name).read_bytes()
`, stage, stagedZip, extracted], { stdio: 'pipe' });
for (const name of stagedFiles) { const bytes = await readFile(join(extracted, edition, name)); assert(patterns.every(p => !bytes.includes(p)), 'Private credential match detected in extracted ZIP'); }
await verifyPreserved();
await mkdir(join(out, 'images'), { recursive: true });
const generated = new Set(['README.txt', 'manifest.json', 'problem-solution.txt', 'architecture.txt']);
for (const name of stagedFiles) {
  const target = join(out, name);
  if (await exists(target)) {
    if (!generated.has(name)) assert.equal(await hash(target), await hash(join(stage, name)), `Existing Goal014 source changed: ${name}`);
    else await copyFile(join(stage, name), target);
  } else await copyFile(join(stage, name), target, constants.COPYFILE_EXCL);
}
const zip = join(assets, 'ugoku-kami-goal014-final.zip');
if (await exists(zip)) await copyFile(zip, join(stageRoot, 'previous-public-package.zip'), constants.COPYFILE_EXCL);
await copyFile(stagedZip, zip);
assert.deepEqual(await inventory(out), stagedFiles);
for (const name of stagedFiles) assert.equal(await hash(join(out, name)), await hash(join(extracted, edition, name)));
await verifyPreserved();
const packageResult = { createdAt: new Date().toISOString(), out: relative(assets, out), zip: relative(assets, zip), sha256: await hash(zip), bytes: (await lstat(zip)).size, files: stagedFiles.length, originalFilesVerified: preservation.files.length, originalsUnchanged: true, zipAllFilesExtractedAndByteMatched: true, credentialScan: 'no known private credential match', toolingCommit, mainIntegration, stageEvidenceDirectory: relative(assets, stageRoot) };
await writeFile(join(stageRoot, 'package-result.json'), JSON.stringify(packageResult, null, 2) + '\n', { mode: 0o600 });
await writeFile(join(work, 'package-result.json'), JSON.stringify(packageResult, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ result: 'packaged-and-verified', ...packageResult }));

/** Local-only editorial assembly. Requires real captures and verified source PTS.
 * node scripts/submission/redesign-video.mjs --assets-root /.../artifacts/submission --capture-dir /.../capture/session
 * All source footage stays at 1x. Static excerpts are explicitly labeled.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { chromium } from '@playwright/test';

assert.equal(process.argv[2], '--assets-root');
assert.equal(process.argv[4], '--capture-dir');
assert([6, 8].includes(process.argv.length));
if (process.argv.length === 8) assert.equal(process.argv[6], '--edition');
const edition = process.argv[7] ?? 'review-v2';
assert(['review-v2', 'review-v2.1'].includes(edition));
const finalized = edition === 'review-v2.1';
const base = resolve(process.argv[3]), captureDir = resolve(process.argv[5]);
if (!finalized) await access(join(base, 'private/material-finalize-20261006/preservation.json')).then(() => {
  throw new Error('review-v2 is preserved. Use --edition review-v2.1; reproduce historical editions only in an isolated assets root.');
}, error => { if (error.code !== 'ENOENT') throw error; });
const out = join(base, 'public/goal011', edition);
const previousWork = join(base, 'private/material-redesign-20261006');
const editionWork = finalized ? join(base, 'private/material-finalize-20261006') : previousWork;
const work = join(editionWork, 'video');
const read = async p => JSON.parse(await readFile(p, 'utf8'));
const hash = async p => createHash('sha256').update(await readFile(p)).digest('hex');
const previousEdl = finalized ? await read(join(previousWork, 'video/edit-decisions.json')) : null;
if (finalized) {
  const preservation = await read(join(editionWork, 'preservation.json'));
  for (const f of preservation.preservedFiles) assert.equal(await hash(join(base, f.path)), f.sha256, `Preserved source changed: ${f.path}`);
  await mkdir(join(out, 'images'), { recursive: true });
  await mkdir(join(editionWork, 'images'), { recursive: true });
  const images = await read(join(previousWork, 'images/provenance.json'));
  for (const img of images.images) {
    const source = join(base, 'public/goal011/review-v2/images', img.file);
    assert.equal(await hash(source), img.sha256);
    await copyFile(source, join(out, 'images', img.file));
  }
  await copyFile(join(previousWork, 'images/provenance.json'), join(editionWork, 'images/provenance.json'));
}
const ffmpeg = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
const capture = await read(join(captureDir, 'capture.json'));
const timing = await read(join(captureDir, 'verified-pts.json'));
assert.equal(capture.status, 'passed');
assert.equal(capture.aiCalls, 0); assert.equal(capture.cloudCalls, 0);
assert.equal(capture.aiProvider, 'none');
const a = capture.clips.find(c => c.name === 'manual-A');
const b = capture.clips.find(c => c.name === 'kit-B');
assert.equal(await hash(a.rawVideo), a.rawSha256);
assert.equal(await hash(b.rawVideo), b.rawSha256);
assert.equal(b.document.designHash, '5b3d233852f77d3d47610aecb9fbf49a8b61c345b6faa8f0236252850b18fdd8');
const real = join(base, 'private/goal010/browser-sequence-2026-10-05T09-11-37.048Z/raw-video/page@de21d445086ace1eab9b95f1b5a6005b.webm');
assert.equal(await hash(real), 'c791f1ed4338fe952fbcb564323cf862d252494faffe309f9f6a9eabe33a170a');
await mkdir(join(work, 'assets'), { recursive: true });
await mkdir(join(work, 'segments'), { recursive: true });
await mkdir(out, { recursive: true });
const font = await readFile(new URL('../../apps/web/public/fonts/ZenKakuGothicNew-Regular.ttf', import.meta.url));
const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.route('**/*', route => route.abort());
async function frame(id, title, label, caption, note = '') {
  const path = join(work, 'assets', `${id}-frame.png`);
  await page.setContent(`<!doctype html><html lang="ja"><meta charset="utf-8"><style>
  @font-face{font-family:Zen;src:url(data:font/ttf;base64,${font.toString('base64')})}
  *{box-sizing:border-box}body{margin:0;width:1920px;height:1080px;background:#FAFAF7;color:#252923;font-family:Zen,sans-serif}
  header{position:absolute;left:80px;right:80px;top:17px;display:flex;justify-content:space-between;align-items:center;font-size:24px}
  header b{font-weight:400;color:#A34A35;margin-right:22px}header small{font-size:19px;color:#6D7268}
  footer{position:absolute;left:80px;right:80px;top:979px;border-top:1px solid #DDDED7;padding-top:14px;font-size:36px;white-space:nowrap}
  .note{position:absolute;right:82px;top:1038px;font-size:18px;color:#6D7268}
  </style><header><span><b>うごく紙工房</b>${esc(title)}</span><small>${esc(label)}</small></header><footer>${esc(caption)}</footer>${note ? `<div class="note">${esc(note)}</div>` : ''}</html>`);
  await page.evaluate(() => document.fonts.ready);
  assert(await page.locator('footer').evaluate(e => e.scrollWidth <= e.clientWidth));
  await page.screenshot({ path });
  return path;
}
async function comparison(id, source, rect) {
  const path = join(work, 'assets', `${id}.png`);
  await sharp(source).extract(rect).resize({ width: 1800, height: 850, fit: 'inside' }).png().toFile(path);
  return path;
}
const cmpB = await comparison('comparison-30mm', join(out, 'images/02-five-more-millimeters.png'), { left: 80, top: 270, width: 1765, height: 773 });
const cmpC = await comparison('comparison-35mm', join(out, 'images/03-compare-and-choose.png'), { left: 80, top: 270, width: 1765, height: 773 });
const requestStill = join(work, 'assets', 'real-request.png');
ffmpeg(['-ss', '4.88', '-i', real, '-frames:v', '1', requestStill]);

// Verified source boundaries come from observed frame PTS, not event wall times.
const at = timing.clips.find(c => c.name === 'manual-A');
const bt = timing.clips.find(c => c.name === 'kit-B');
const A = at.selectionStart, M = at.motionStart, B = bt.usableStart;
assert(A >= at.usableStart && A + 25 <= at.usableEnd);
assert(M + 30 <= at.usableEnd);
assert(B + 60 <= bt.usableEnd);
const local = '手動デモ・ローカル';
const historic = '実AIの記録・2026.10.5';
const video = (id, input, start, duration, title, label, caption, note = '') => ({ id, kind: 'video', input, sourceStart: start, duration, title, label, caption, note, playbackRate: 1 });
const still = (id, input, duration, title, label, caption) => ({ id, kind: 'still', input, duration, title, label, caption });
const scenes = [
  video('01-opening', a.rawVideo, M + 3, 8, '自分の絵から、動く紙工作へ。', local, '絵を動かす仕組みを、画面で確かめながら。'),
  video('02-import', a.rawVideo, A, 9, '絵を選ぶ', local, '自分の絵を読み込みます。'),
  video('03-select', a.rawVideo, A + 9, 8, '動かす部分を決める', local, '動かしたいところを、四角で囲みます。'),
  video('04-selection', a.rawVideo, A + 17, 8, '動かす部分を決める', local, '四角い紙ごと動くので、範囲を確かめます。'),
  video('05-front', a.rawVideo, M, 14, '動きを確かめる', local, '方向と距離を決めて、動きをプレビュー。'),
  video('06-back', a.rawVideo, M + 14, 16, '裏の仕組みも見る', local, '両端の姿と、裏のタブの通り道を確認します。'),
  still('07-request', requestStill, 6, '別の例：25mmから、あと5mm', `${historic}・静止`, '25mmから30mmへ。絵の大きさと紙の枚数はそのまま。'),
  video('08-real-wait', real, 4.88, 8.64, '希望を伝える', historic, 'AIの案を、コードで検査しています。'),
  still('09-compare', cmpB, 8, '比べて選ぶ', '同じ実AIの候補画面・静止', '原本を残して、同じ縮尺で見比べます。'),
  still('10-decide', cmpB, 6, '比べて選ぶ', '同じ実AIの候補画面・静止', '使う案は、作者が選びます。'),
  video('11-adopt', real, 13.52, 1.48, 'この案にする', historic, '使う案は、作者が選びます。'),
  video('12-open-adopted', b.rawVideo, B, 8, '保存した30mmの採用版を開く', local, 'この採用版から、型紙とガイドへ。'),
  video('13-pdf', b.rawVideo, B + 8, 14, '同じ版を、原寸キットに', local, '第3版・30mmの設計から、PDFをダウンロード。'),
  video('14-guide', b.rawVideo, B + 22, 12, '組み立てる順番を見る', local, '部品と手順を、図で確認できます。'),
  video('15-glue', b.rawVideo, B + 34, 12, '組み立てる順番を見る', local, '接着する面と、接着しない場所を確かめます。'),
  video('16-save', b.rawVideo, B + 46, 7, '保存して、続きから', local, '作品と、開いていた手順を保存。'),
  video('17-resume', b.rawVideo, B + 53, 7, '保存して、続きから', local, '再び開くと、同じ版から再開できます。'),
  still('18-alternative', cmpC, 8, '別の依頼：希望70mm、代案35mm', '公開版の実画面・静止', '希望どおりに収まらないときも、違いを示します。'),
  still('19-core', cmpC, 8, '別の依頼：希望70mm、代案35mm', '公開版の実画面・静止', 'AIが提案。コードが検査。作者が選ぶ。'),
  video('20-ending', a.rawVideo, M + 3, 8, '自分の絵から、動く紙工作へ。', local, '描いた絵に、動く仕組みを。', '紙での動作は、印刷・組み立てで確認します。'),
];
if (finalized) {
  const kit = await comparison('opening-same30mm-kit', join(out, 'images/04-full-size-kit.png'), { left: 110, top: 205, width: 1712, height: 882 });
  scenes.splice(0, 1,
    still('01a-opening-art', requestStill, 3.2, '見どころ｜自分の絵', '実画面の抜粋・静止', '自分の絵が、工作の設計に。'),
    still('01b-opening-conditions', cmpB, 3.2, '見どころ｜条件を守った変更案', '同じ作品の実AI候補・静止', 'あと5mm。紙は増やさない。'),
    still('01c-opening-kit', kit, 3.6, '見どころ｜採用した同じ版の型紙', '実PDFとガイドの抜粋・静止', '選んだ版から、原寸型紙と組立ガイドへ。'),
  );
  // Remove two seconds of the already-demonstrated selection hold, preserving
  // all subsequent chapter boundaries and the original 177.12-second duration.
  scenes.find(s => s.id === '04-selection').duration = 6;
}
try {
  let total = 0;
  const concat = [], subtitles = [];
  const stamp = sec => `${Math.floor(sec / 3600).toString().padStart(2,'0')}:${Math.floor(sec / 60 % 60).toString().padStart(2,'0')}:${Math.floor(sec % 60).toString().padStart(2,'0')},${Math.round(sec % 1 * 1000).toString().padStart(3,'0')}`;
  for (const s of scenes) {
    s.outputStart = Number(total.toFixed(3)); total += s.duration; s.outputEnd = Number(total.toFixed(3));
    s.frame = await frame(s.id, s.title, s.label, s.caption, s.note);
    s.encoded = join(work, 'segments', `${s.id}.mp4`);
    s.sourceSha256 = await hash(s.input);
    const prior = previousEdl?.scenes.find(p => p.id === s.id);
    const reusable = prior && ['kind', 'sourceStart', 'duration', 'title', 'label', 'caption', 'note', 'playbackRate', 'sourceSha256'].every(k => prior[k] === s[k]) && await hash(prior.frame) === await hash(s.frame);
    const args = s.kind === 'video' ? ['-ss', String(s.sourceStart), '-t', String(s.duration), '-i', s.input] : ['-loop', '1', '-i', s.input];
    args.push('-loop', '1', '-i', s.frame, '-filter_complex', '[0:v]fps=25,scale=1800:900:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[clip];[1:v][clip]overlay=x=(W-w)/2:y=64+(900-h)/2:shortest=1,format=yuv420p[v]', '-map', '[v]', '-t', String(s.duration), '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-threads', '2', '-movflags', '+faststart', s.encoded);
    if (reusable) {
      assert.equal(await hash(prior.encoded), prior.encodedSha256);
      await copyFile(prior.encoded, s.encoded);
      s.reusedEncodedFromReviewV2 = true;
    } else ffmpeg(args);
    s.encodedSha256 = await hash(s.encoded);
    concat.push(`file '${s.encoded.replaceAll("'", "'\\''")}'`);
    subtitles.push(`${subtitles.length + 1}\n${stamp(s.outputStart)} --> ${stamp(s.outputEnd)}\n${s.caption}${s.note ? '\n' + s.note : ''}\n`);
    console.log(JSON.stringify({ scene: s.id, end: s.outputEnd }));
  }
  assert.equal(Number(total.toFixed(2)), 177.12);
  await writeFile(join(work, 'concat.txt'), concat.join('\n') + '\n', { mode: 0o600 });
  const movie = join(out, 'demo.mp4');
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', join(work, 'concat.txt'), '-c', 'copy', '-movflags', '+faststart', movie]);
  await writeFile(join(out, 'captions-ja.srt'), subtitles.join('\n'));
  const edl = { edition, durationSeconds: total, sha256: await hash(movie), newCloudCalls: 0, newModelCalls: 0, sourceCodeSha: capture.sourceSha, captureDirectory: relative(base, captureDir), timingSource: relative(base, join(captureDir, 'verified-pts.json')), historicalAiCodeSha: '6b6e98bd33f9f125e0301865da98024167ef9fab', historicalSettingsExcluded: [[0, 2.44], [3.92, 4.88], [15, 15.28], [18.04, 18.8]], composition: 'Ordinary local manual recording, historical real Vertex recording at 1x, explicitly labeled real screenshot excerpts. Editorial cuts between sessions. No fabricated app or model response.', adoptedPdfBinding: b.pdf, opening: finalized ? { durationSeconds: 10, kind: 'three-labeled-static-excerpts-not-continuous-demonstration', sameProject: b.document.designId, beforeRevision: 2, adoptedRevision: 3, adoptedDesignHash: b.document.designHash, sourcePdf: 'public/goal011/review-v2/fish-revision3.pdf', sourcePdfSha256: 'd9bb14261db7a64365d988b9e11b15d73f8d57a9b2a978d5e180ee254c916e4b', removedRepeatedSelectionSeconds: 2 } : undefined, previousVideoSha256: previousEdl?.sha256, scenes };
  await writeFile(join(work, 'edit-decisions.json'), JSON.stringify(edl, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ movie, durationSeconds: total, sha256: edl.sha256 }));
} finally { await browser.close(); }

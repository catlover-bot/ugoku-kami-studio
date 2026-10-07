/** Make a reproducible Goal014 cut list from calibrated genuine recordings. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
assert.equal(process.argv[2], '--assets-root'); assert.equal(process.argv[4], '--capture-dir'); assert.equal(process.argv.length, 6);
const base = resolve(process.argv[3]), directory = resolve(process.argv[5]);
const captureManifest = join(directory, 'capture.json'), timingManifest = join(directory, 'verified-pts.json');
const read = async p => JSON.parse(await readFile(p, 'utf8'));
const hash = async p => createHash('sha256').update(await readFile(p)).digest('hex');
const capture = await read(captureManifest), timing = await read(timingManifest);
assert.equal(capture.status, 'passed'); assert.equal(timing.captureSha256, await hash(captureManifest));
assert.equal(capture.submissionFootage, true);
const a = timing.clips.find(c => c.name === 'manual-A'), b = timing.clips.find(c => c.name === 'kit-B');
assert(a && b);
const metadataA = capture.clips.find(c => c.name === a.name), metadataB = capture.clips.find(c => c.name === b.name);
assert.equal(metadataA.document.travelMm, 30);
assert.equal(metadataB.document.designHash, '5b3d233852f77d3d47610aecb9fbf49a8b61c345b6faa8f0236252850b18fdd8');
assert.equal(metadataB.document.designId, 'goal009-comparison-fish');
assert.equal(metadataB.document.revision, 3);
const snap = n => Math.round(n * 25) / 25;
const event = (clip, type) => { const found = clip.events.find(e => e.type === type); assert(found, `Missing ${type}`); return found.pts; };
const scene = (clip, id) => { const found = clip.scenes.find(s => s.id === id); assert(found, `Missing ${id}`); return found; };
const video = (id, clip, start, duration, label, caption) => ({ id, kind: 'video', input: clip.rawVideo, sourceSha256: clip.sha256, sourceStart: snap(start), duration: snap(duration), playbackRate: 1, label, caption });
const whole = (id, clip, sourceScene, label, caption) => { const s = scene(clip, sourceScene); return video(id, clip, s.sourceStart, s.sourceEnd - s.sourceStart, label, caption); };
const teaser = '新UI・手動制作の抜粋';
const manual = '新UI・手動の寸法支援';
const historical = 'UI更新前の実行記録 · 2026.10.5';
const adopted = '新UI・同じ採用版の操作';
const raw = join(base, 'private/goal010/browser-sequence-2026-10-05T09-11-37.048Z/raw-video/page@de21d445086ace1eab9b95f1b5a6005b.webm');
const rawHash = await hash(raw);
assert.equal(rawHash, 'c791f1ed4338fe952fbcb564323cf862d252494faffe309f9f6a9eabe33a170a');
const real = { rawVideo: raw, sha256: rawHash };
const work = join(base, 'private/goal014-final');
const stillDirectory = join(work, 'historical-frame'); await mkdir(stillDirectory, { mode: 0o700 });
const still = join(stillDirectory, 'actual-comparison.png');
execFileSync('ffmpeg', ['-nostdin','-v','error','-ss','13.80','-i',raw,'-frames:v','1',still]);
const print = scene(a, 'adopted-pdf-and-guide');
const printStage = a.events.find(e => e.type === 'stage' && e.stage === 3 && e.pts >= print.sourceStart);
assert(printStage);
const scenes = [
  video('opening-motion', a, event(a, 'adopted30mm-motion-start') + .20, 3.2, teaser, '自分の絵が、動く紙工作に。'),
  video('opening-change', a, event(a, 'same-scale-comparison-at-end'), 3.2, teaser, 'あと5mm。絵の大きさと紙の枚数は、そのまま。'),
  video('opening-pattern', a, printStage.pts + .16, 3.6, teaser, '選んだ設計を、原寸型紙に。'),
  whole('select-art', a, 'import-and-select', '新UI・手動制作', '自分の絵を読み込み、動かすところを四角で囲む。'),
  whole('set-conditions', a, '25mm-author-conditions', '新UI・手動制作', '方向と距離、絵の大きさ、使う紙を決める。'),
  whole('request-and-compare', a, 'manual-request-and-comparison', manual, '希望を一か所に。まずは寸法から案をつくって比べる。'),
  whole('author-adopts', a, 'adopted30mm-motion', manual, '原本と見比べ、使う案は作者が選ぶ。'),
  video('real-ai-response', real, 4.88, 8.92, historical, '実AIにも、30mmの希望と変えない条件を伝えました。'),
  { id: 'real-ai-comparison', kind: 'still', input: still, sourceSha256: await hash(still), duration: 3.2, label: historical + '・一時停止', caption: 'AIが提案。コードが検査。作者が選ぶ。', evidence: { rawSha256: rawHash, rawPts: 13.80 } },
  video('real-ai-adoption', real, 13.80, 1.20, historical, 'この案を採用。'),
  whole('reopen-adopted', b, 'import-real-adopted-project', adopted, '採用した設計を新UIで開く。'),
  whole('same-version-pdf', b, 'same-version-print-and-pdf', adopted, 'PDFの内容を選び、採用した同じ版をダウンロード。'),
  whole('guide-parts-and-glue', b, 'guide-real-steps', adopted, '部品、接着する面、接着しない場所を図で確かめる。'),
  whole('save-and-resume', b, 'save-reload-and-guide', adopted, '作品と手順を保存して、続きから。紙での動作は実物で確認。'),
];
for (const s of scenes) {
  if (s.kind === 'video' && [a.rawVideo, b.rawVideo].includes(s.input)) {
    const clip = s.input === a.rawVideo ? a : b;
    assert(s.sourceStart >= clip.usableStart && s.sourceStart + s.duration <= clip.usableEnd + .001);
  }
}
const plan = { edition: 'goal014-final', captureManifest, timingManifest, createdAt: new Date().toISOString(), opening: { durationSeconds: 10, kind: 'three-actual-video-excerpts-from-the-same-manual-project', designId: metadataA.document.designId, adoptedRevision: metadataA.document.revision, adoptedDesignHash: metadataA.document.designHash, note: 'Manual dimension assistance, not AI. Compare shows the unadopted proposal; motion and pattern show its adopted version.' }, historicalAi: { sourceCodeSha: '6b6e98bd33f9f125e0301865da98024167ef9fab', sourceSha256: rawHash, safeSourceRange: [4.88,15], request: '魚を右へ30mm動かしたい。絵の大きさと紙の枚数は変えない', designId: 'goal009-comparison-fish', adoptedRevision: 3, adoptedDesignHash: metadataB.document.designHash, newInference: false }, scenes };
await writeFile(join(work, 'video-plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ plan: join(work, 'video-plan.json'), duration: snap(scenes.reduce((n,s) => n + s.duration, 0)), scenes: scenes.map(s => ({ id: s.id, duration: s.duration })) }));

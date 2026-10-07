/** Goal014 editorial assembly of genuine footage. No app, Cloud or model access.
 * --assets-root ABS --plan ABS_JSON. Plan uses checked source PTS, never wall time.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

assert.equal(process.argv[2], '--assets-root');
assert.equal(process.argv[4], '--plan');
assert.equal(process.argv.length, 6);
const base = resolve(process.argv[3]), planPath = resolve(process.argv[5]);
const planBytes = await readFile(planPath), plan = JSON.parse(planBytes);
const out = join(base, 'public/goal014-final');
const work = join(base, 'private/goal014-final/video');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = async file => hash(await readFile(file));
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const capture = await read(plan.captureManifest);
const timing = await read(plan.timingManifest);
assert.equal(capture.status, 'passed');
assert.equal(capture.submissionFootage, true);
assert.equal(capture.aiProvider, 'none');
assert.equal(capture.aiCalls, 0); assert.equal(capture.cloudCalls, 0);
assert.equal(timing.captureSha256, await fileHash(plan.captureManifest));
assert.deepEqual(capture.externalRequestsBlocked, []);
assert.deepEqual(capture.runRequestsBlocked, []);
assert.equal(plan.edition, 'goal014-final');
assert.equal(plan.opening.durationSeconds, 10);
assert(plan.scenes.length >= 10);
await mkdir(out, { recursive: true });
await mkdir(work, { mode: 0o700 }); // A previous render must be preserved explicitly.
await mkdir(join(work, 'frames'), { mode: 0o700 });
await mkdir(join(work, 'segments'), { mode: 0o700 });
await access(join(out, 'demo.mp4')).then(() => { throw Error('Preserve the previous movie before rerendering'); }, error => { if (error.code !== 'ENOENT') throw error; });
const font = await readFile(new URL('../../apps/web/public/fonts/ZenKakuGothicNew-Regular.ttf', import.meta.url));
const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.route('**/*', route => route.abort());
const ffmpeg = args => new Promise((accept, reject) => {
  const process = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  process.stderr.on('data', bytes => { error += bytes.toString(); });
  process.once('error', reject);
  process.once('close', code => code === 0 && !error.trim() ? accept() : reject(Error(`ffmpeg ${code}: ${error.slice(0,2000)}`)));
});
const stamp = seconds => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2,'0')}:${String(Math.floor(ms / 60000) % 60).padStart(2,'0')}:${String(Math.floor(ms / 1000) % 60).padStart(2,'0')},${String(ms % 1000).padStart(3,'0')}`;
};
try {
  let frames = 0;
  const scenes = [], concat = [], subtitles = [];
  for (const scene of plan.scenes) {
    assert(/^[a-z0-9-]+$/.test(scene.id));
    assert(['video', 'still'].includes(scene.kind));
    assert.equal(await fileHash(scene.input), scene.sourceSha256);
    assert(scene.duration > 0);
    const count = Math.round(scene.duration * 25);
    assert(Math.abs(count / 25 - scene.duration) < 1e-6);
    assert(scene.kind !== 'still' || scene.duration <= 5, 'No long frozen footage');
    if (scene.kind === 'video') {
      assert.equal(scene.playbackRate, 1);
      assert(Number.isFinite(scene.sourceStart) && scene.sourceStart >= 0);
      const local = timing.clips.find(c => c.rawVideo === scene.input);
      if (local) assert(scene.sourceStart >= local.usableStart && scene.sourceStart + scene.duration <= local.usableEnd + .001);
      else {
        assert.equal(scene.sourceSha256, 'c791f1ed4338fe952fbcb564323cf862d252494faffe309f9f6a9eabe33a170a');
        assert(scene.sourceStart >= 4.88 && scene.sourceStart + scene.duration <= 15.001, 'Historical settings footage must remain excluded');
        assert(scene.label.includes('UI更新前の実行記録'));
      }
    }
    const frame = join(work, 'frames', scene.id + '.png');
    await page.setContent(`<!doctype html><html lang="ja"><meta charset="utf-8"><style>
      @font-face{font-family:Zen;src:url(data:font/ttf;base64,${font.toString('base64')})}
      *{box-sizing:border-box}body{margin:0;width:1920px;height:1080px;background:#f4f6f5;color:#183b36;font-family:Zen,sans-serif}
      header{position:absolute;left:32px;right:32px;top:6px;height:30px;display:flex;align-items:center;justify-content:space-between;font-size:20px;color:#435953}
      header b{font-weight:400}header span{font-size:21px}
      footer{position:absolute;left:32px;right:32px;top:1027px;height:49px;display:flex;justify-content:center;align-items:center;font-size:30px;white-space:nowrap;color:#183b36}
      </style><header><b>うごく紙工房</b><span>${esc(scene.label)}</span></header><footer>${esc(scene.caption)}</footer></html>`);
    await page.evaluate(() => document.fonts.ready);
    assert(await page.locator('footer').evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.screenshot({ path: frame });
    const encoded = join(work, 'segments', scene.id + '.mp4');
    const args = scene.kind === 'video' ? ['-ss', String(scene.sourceStart), '-i', scene.input] : ['-loop', '1', '-i', scene.input];
    const crop = scene.crop ? `crop=${scene.crop.width}:${scene.crop.height}:${scene.crop.left}:${scene.crop.top},` : '';
    if (scene.crop) for (const value of Object.values(scene.crop)) assert(Number.isInteger(value) && value >= 0);
    args.push('-loop', '1', '-i', frame, '-filter_complex', `[0:v]${crop}fps=25,scale=1856:980:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[clip];[1:v][clip]overlay=x=(W-w)/2:y=42+(980-h)/2:shortest=1,format=yuv420p[v]`, '-map', '[v]', '-frames:v', String(count), '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-threads', '2', '-movflags', '+faststart', encoded);
    await ffmpeg(args);
    const completed = { ...scene, outputStart: frames / 25, outputEnd: (frames + count) / 25, frame, encoded, encodedSha256: await fileHash(encoded) };
    scenes.push(completed); frames += count;
    concat.push(`file '${encoded.replaceAll("'", "'\\''")}'`);
    subtitles.push(`${subtitles.length + 1}\n${stamp(completed.outputStart)} --> ${stamp(completed.outputEnd)}\n${scene.caption}\n`);
    console.log(JSON.stringify({ scene: scene.id, outputEnd: frames / 25 }));
  }
  const durationSeconds = frames / 25;
  assert(durationSeconds >= 150 && durationSeconds <= 195, 'Keep the film approximately three minutes');
  assert.equal(scenes.filter(s => s.id.startsWith('opening-')).reduce((n,s) => n + s.duration, 0), 10);
  await writeFile(join(work, 'concat.txt'), concat.join('\n') + '\n', { mode: 0o600 });
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', join(work, 'concat.txt'), '-c', 'copy', '-movflags', '+faststart', join(out, 'demo.mp4')]);
  await writeFile(join(out, 'captions.srt'), subtitles.join('\n'));
  const result = { edition: plan.edition, createdAt: new Date().toISOString(), sha256: await fileHash(join(out, 'demo.mp4')), width: 1920, height: 1080, fps: 25, frames, durationSeconds, newCloudCalls: 0, newModelCalls: 0, captureDirectory: relative(base, resolve(plan.captureManifest, '..')), captureSourceSha: capture.sourceSha, captureSha256: await fileHash(plan.captureManifest), timingSha256: await fileHash(plan.timingManifest), toolingCommit: execFileSync('git', ['rev-parse','HEAD'], { encoding: 'utf8' }).trim(), scriptSha256: await fileHash(new URL(import.meta.url)), planSha256: hash(planBytes), historicalAi: plan.historicalAi, opening: plan.opening, composition: 'New ordinary UI recordings with manual dimension assistance; short unchanged historical real Vertex footage, explicitly identified as previous UI. Saved adopted design imported normally for the same revision PDF and guide. No model response composited into the new UI.', scenes };
  await writeFile(join(work, 'edit-decisions.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ movie: join(out, 'demo.mp4'), durationSeconds, frames, sha256: result.sha256 }));
} finally { await browser.close(); }

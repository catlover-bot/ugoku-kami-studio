/** Value-first film: current UI actions, comparison and same-version printable kit.
 * --assets-root ABS --plan ABS_JSON. Plan uses checked source PTS, never wall time.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { loadValueSources, preparePdfImages, resolveValueScenes, VALUE_EDITION } from './value-media.mjs';

assert.equal(process.argv[2], '--assets-root');
assert.equal(process.argv[4], '--plan');
assert.equal(process.argv.length, 6);
const base = resolve(process.argv[3]), planPath = resolve(process.argv[5]);
const planBytes = await readFile(planPath), plan = JSON.parse(planBytes);
const out = join(base, 'public/goal016-value-first');
const work = join(base, 'private/goal016-value-first/video');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = async file => hash(await readFile(file));
assert.equal(plan.editorialScriptSha256, await fileHash(new URL('./full-script.value-first.json', import.meta.url)), 'Render the exact measured editorial script');
const sources = await loadValueSources(base, plan.realCaptureManifest, plan.localCaptureManifest);
const evidence = sources.real, capture = evidence.capture;
assert.equal(plan.edition, VALUE_EDITION);
assert(typeof plan.editingNote === 'string' && plan.editingNote.trim(), 'Disclose local continuation, real request interval and stills');
await mkdir(out, { recursive: true });
for (const file of ['demo-full.mp4', 'captions.srt']) {
  await access(join(out, file)).then(() => { throw Error(`Preserve the previous ${file} before rerendering`); }, error => { if (error.code !== 'ENOENT') throw error; });
}
await mkdir(work, { mode: 0o700 });
await mkdir(join(work, 'frames'), { mode: 0o700 });
await mkdir(join(work, 'segments'), { mode: 0o700 });
await preparePdfImages(sources);
const sourceScenes = await resolveValueScenes(plan, sources);
const font = await readFile(new URL('../../apps/web/public/fonts/ZenKakuGothicNew-Regular.ttf', import.meta.url));
const dimensions = new Map();
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
  for (const scene of sourceScenes) {
    assert(/^[a-z0-9-]+$/.test(scene.id));
    assert(['video', 'still'].includes(scene.kind));
    assert.equal(await fileHash(scene.input), scene.sourceSha256);
    assert(scene.duration > 0);
    const count = Math.round(scene.duration * 25);
    assert(Math.abs(count / 25 - scene.duration) < 1e-6);
    assert(scene.kind !== 'still' || scene.duration <= 10, 'Only bounded explanatory stills');
    if (scene.kind === 'video') {
      assert.equal(scene.playbackRate, 1);
      assert(Number.isFinite(scene.sourceStart) && scene.sourceStart >= 0);

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
    assert(await page.locator('header').evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.screenshot({ path: frame });
    const encoded = join(work, 'segments', scene.id + '.mp4');
    const args = scene.kind === 'video' ? ['-ss', String(scene.sourceStart), '-i', scene.input] : ['-loop', '1', '-i', scene.input];
    const crop = scene.crop ? `crop=${scene.crop.width}:${scene.crop.height}:${scene.crop.left}:${scene.crop.top},` : '';
    if (scene.crop) {
      if (!dimensions.has(scene.input)) {
        const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', scene.input], { encoding: 'utf8' }));
        dimensions.set(scene.input, probe.streams[0]);
      }
      const d = dimensions.get(scene.input);
      assert(scene.crop.left + scene.crop.width <= d.width && scene.crop.top + scene.crop.height <= d.height, 'Crop must remain inside actual recorded content');
    }
    args.push('-loop', '1', '-i', frame, '-filter_complex', `[0:v]${crop}fps=25,scale=1856:980:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[clip];[1:v][clip]overlay=x=(W-w)/2:y=42+(980-h)/2:shortest=1,format=yuv420p[v]`, '-map', '[v]', '-frames:v', String(count), '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-threads', '2', '-movflags', '+faststart', encoded);
    await ffmpeg(args);
    const completed = { ...scene, outputStart: frames / 25, outputEnd: (frames + count) / 25, frame, encoded, encodedSha256: await fileHash(encoded) };
    scenes.push(completed); frames += count;
    concat.push(`file '${encoded.replaceAll("'", "'\\''")}'`);
    subtitles.push(`${subtitles.length + 1}\n${stamp(completed.outputStart)} --> ${stamp(completed.outputEnd)}\n${scene.caption}\n`);
    console.log(JSON.stringify({ scene: scene.id, outputEnd: frames / 25 }));
  }
  const durationSeconds = frames / 25;
  assert(durationSeconds >= 150 && durationSeconds <= 180, 'Full film must be 150–180 seconds');
  await writeFile(join(work, 'concat.txt'), concat.join('\n') + '\n', { mode: 0o600 });
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', join(work, 'concat.txt'), '-c', 'copy', '-movflags', '+faststart', join(out, 'demo-full.mp4')]);
  await writeFile(join(out, 'captions.srt'), subtitles.join('\n'), { flag: 'wx' });
  const result = {
    edition: VALUE_EDITION, createdAt: new Date().toISOString(),
    sha256: await fileHash(join(out, 'demo-full.mp4')),
    width: 1920, height: 1080, fps: 25, frames, durationSeconds,
    newCloudCalls: 0, newModelCalls: 0,
    realCaptureManifest: relative(base, sources.real.path),
    localCaptureManifest: relative(base, sources.local.path),
    captureDirectory: relative(base, evidence.directory),
    captureSourceSha: capture.sourceSha, captureSha256: evidence.sha256,
    localCaptureDirectory: relative(base, sources.local.directory),
    localCaptureSha256: sources.local.sha256,
    localCaptureSourceSha: sources.local.capture.sourceSha,
    publicRevision: capture.revision, capturedModelRequests: capture.newModelRequests,
    capturedModelCalls: capture.liveAi.modelCalls, liveAi: capture.liveAi,
    sourceBindings: {
      real: { path: relative(base, sources.real.path), sha256: sources.real.sha256, sourceSha: capture.sourceSha, revision: capture.revision },
      local: { path: relative(base, sources.local.path), sha256: sources.local.sha256, sourceSha: sources.local.capture.sourceSha, newModelRequests: 0, newModelCalls: 0 },
      pdf: { file: relative(base, sources.pdf.file), sha256: sources.pdf.sha256, stamp: sources.pdf.stamp, pages: sources.pdf.pages, rasterBindingSha256: await fileHash(join(sources.rasterDirectory, 'binding.json')) },
    },
    toolingCommit: plan.toolingCommit ?? null,
    scriptSha256: await fileHash(new URL(import.meta.url)),
    mediaModuleSha256: await fileHash(new URL('./value-media.mjs', import.meta.url)),
    planSha256: hash(planBytes), editorialScriptSha256: plan.editorialScriptSha256, editingNote: plan.editingNote,
    composition: 'One actual current public request through adoption, then the exact adopted design reopened in a separate recorded local session. Provenance is retained here; viewer headings describe actions and outputs. No additional AI, old UI, slow motion, or repeated moving intervals. Explanatory stills and crops are indicated.',
    scenes,
  };
  await writeFile(join(work, 'edit-decisions.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ movie: join(out, 'demo-full.mp4'), durationSeconds, frames, sha256: result.sha256 }));
} finally { await browser.close(); }

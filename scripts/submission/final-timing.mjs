/** Calibrate new Goal014 recording events against decoded WebM frame PTS. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

assert.equal(process.argv[2], '--capture-dir');
assert.equal(process.argv.length, 4);
const directory = resolve(process.argv[3]);
const bytes = await readFile(join(directory, 'capture.json'));
const capture = JSON.parse(bytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(capture.status, 'passed');
assert.equal(capture.submissionFootage, true);
assert.equal(capture.aiProvider, 'none');
assert.equal(capture.aiCalls, 0);
assert.equal(capture.cloudCalls, 0);
assert.deepEqual(capture.runRequestsBlocked, []);
assert.deepEqual(capture.externalRequestsBlocked, []);
const output = join(directory, 'timing');
await mkdir(output, { mode: 0o700 });
const result = { captureSha256: hash(bytes), sourceSha: capture.sourceSha, fps: 25, method: 'Actual decoded WebM PTS and independent calibration-page transitions. Scene event times retain screencast uncertainty; final cuts must also be visually inspected.', clips: [] };
const snap = time => Math.round(time * 25) / 25;
for (const clip of capture.clips) {
  assert.equal(clip.status, 'passed');
  assert.equal(hash(await readFile(clip.rawVideo)), clip.rawSha256);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', clip.rawVideo], { encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 }));
  const samples = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', clip.rawVideo, '-vf', 'scale=1:1:flags=area,format=rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1024 ** 2 });
  assert.equal(samples.length, probe.frames.length * 3);
  const groups = [];
  for (let i = 0; i < probe.frames.length; i++) {
    const [r, g, b] = samples.subarray(i * 3, i * 3 + 3);
    const kind = r > 180 && g < 45 && b > 180 ? 'magenta' : r < 45 && g > 180 && b > 180 ? 'cyan' : 'product';
    const pts = Number(probe.frames[i].best_effort_timestamp_time);
    assert(Number.isFinite(pts));
    if (groups.at(-1)?.kind === kind) { groups.at(-1).lastPts = pts; groups.at(-1).frames++; }
    else groups.push({ kind, firstPts: pts, lastPts: pts, frames: 1 });
  }
  const cyan = groups.filter(g => g.kind === 'cyan');
  assert.equal(cyan.length, 2, 'Both independent calibration pages must be present');
  assert.equal(clip.markers.length, 2);
  const observations = cyan.map((group, i) => {
    const marker = clip.markers[i];
    const offset = group.firstPts - (marker.cyanBefore + marker.cyanAfter) / 2;
    return { kind: marker.kind, firstPts: group.firstPts, wallBefore: marker.cyanBefore, wallAfter: marker.cyanAfter, offset, reliable: group.firstPts > 0, uncertaintySeconds: (marker.cyanAfter - marker.cyanBefore) / 2 + .04 };
  });
  const reliable = observations.filter(o => o.reliable);
  assert(reliable.length >= 1);
  assert(reliable.every(o => o.uncertaintySeconds < .15));
  const drift = Math.max(...reliable.map(o => o.offset)) - Math.min(...reliable.map(o => o.offset));
  assert(drift < .20, 'Recording clock drift requires manual correction');
  const offset = reliable.reduce((n, o) => n + o.offset, 0) / reliable.length;
  const usableStart = Math.ceil((clip.usableWallStart + offset) * 25) / 25;
  const usableEnd = Math.floor((clip.usableWallEnd + offset) * 25) / 25;
  assert(usableStart < usableEnd);
  const product = groups.find(g => g.kind === 'product' && g.firstPts < usableStart && g.lastPts >= usableEnd - .04);
  assert(product, 'Usable interval includes a calibration page');
  const scenes = clip.scenes.map(scene => ({ ...scene, sourceStart: Math.max(usableStart, snap(scene.wallStart + offset)), sourceEnd: Math.min(usableEnd, snap(scene.wallEnd + offset)), actionEnd: snap(scene.wallActionEnd + offset) }));
  for (const scene of scenes) {
    assert(scene.sourceEnd > scene.sourceStart);
    assert(scene.actionEnd >= scene.sourceStart && scene.actionEnd <= scene.sourceEnd + .04, 'Scene cut removes an operation; one-frame rounding tolerance only');
  }
  const calibrated = { name: clip.name, rawVideo: clip.rawVideo, sha256: clip.rawSha256, decodedFrames: probe.frames.length, groups, observations, drift, offset, usableStart, usableEnd, scenes, events: clip.events.map(e => ({ ...e, pts: snap(e.wallSeconds + offset) })) };
  result.clips.push(calibrated);
  for (const [label, at] of [['first', usableStart], ['last', usableEnd - .04]]) execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(at), '-i', clip.rawVideo, '-frames:v', '1', join(output, `${clip.name}-${label}.png`)]);
}
await writeFile(join(directory, 'verified-pts.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ captureDirectory: directory, clips: result.clips.map(c => ({ name: c.name, start: c.usableStart, end: c.usableEnd, drift: c.drift, scenes: c.scenes.map(s => ({ id: s.id, start: s.sourceStart, end: s.sourceEnd })) })), cloudCalls: 0, modelCalls: 0 }));

/** Full MP4 decode + real-time browser playback; contact sheets for human review.
 * This does not claim that a machine playback proves readability or aesthetics. */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { args, folders, json, sha256 } from './common.js';
const options = args(process.argv.slice(2), ['--out']);
const { publicDir, privateDir } = await folders(options['--out'] ?? 'artifacts/submission');
const dir = resolve(privateDir, 'video-review'); await mkdir(dir, { recursive: true });
const path = resolve(publicDir, 'demo.mp4');
const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { encoding: 'utf8' }));
const run = (command: string[]) => new Promise<void>((accept, reject) => { const child = spawn('ffmpeg', command, { stdio: ['ignore', 'ignore', 'pipe'] }); let errors = ''; child.stderr.on('data', chunk => { errors += chunk; }); child.once('error', reject); child.once('close', code => code === 0 && !errors.trim() ? accept() : reject(new Error(errors || `ffmpeg exit ${code}`))); });
await run(['-v', 'error', '-i', path, '-f', 'null', '-']);
// One frame per second covers all subtitle intervals; full-size contact sheets
// remain private and are explicitly a sample rather than all 4,500 frames.
await run(['-v', 'error', '-y', '-i', path, '-vf', 'fps=1,scale=640:360,tile=4x5:padding=8:margin=8:color=white', '-frames:v', '9', resolve(dir, 'contact-%02d.jpg')]);
const bytes = await readFile(path);
const server = createServer((req, response) => {
  if (req.url === '/video.mp4') {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    response.writeHead(match ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(match ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) }); response.end(bytes.subarray(start, end + 1)); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end('<!doctype html><html lang="ja"><title>提出動画の通し再生確認</title><style>body{margin:0;background:#000}video{width:100vw;height:100vh;object-fit:contain}</style><video controls muted src="/video.mp4"></video></html>');
});
await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
const address = server.address(); if (!address || typeof address === 'string') throw new Error('No review server port');
const browser = await chromium.launch();
let playback: unknown;
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }); await page.goto(`http://127.0.0.1:${address.port}`);
  playback = await page.evaluate(async () => {
    const video = document.querySelector('video')!;
    let callbackFrames = 0; const samples: { time: number; mediaTime: number }[] = []; let nextSample = 0;
    video.requestVideoFrameCallback(function frame(time, metadata) { callbackFrames++; if (metadata.mediaTime >= nextSample) { samples.push({ time, mediaTime: metadata.mediaTime }); nextSample += 10; } if (!video.ended) video.requestVideoFrameCallback(frame); });
    const started = performance.now(); const result = new Promise((accept, reject) => { video.onended = () => accept({ ended: video.ended, duration: video.duration, currentTime: video.currentTime, elapsedMs: performance.now() - started, playbackRate: video.playbackRate, callbackFrames, quality: { totalVideoFrames: video.getVideoPlaybackQuality().totalVideoFrames, droppedVideoFrames: video.getVideoPlaybackQuality().droppedVideoFrames, corruptedVideoFrames: video.getVideoPlaybackQuality().corruptedVideoFrames }, samples }); video.onerror = () => reject(new Error(video.error?.message)); });
    await video.play(); return result;
  });
} finally { await browser.close(); await new Promise<void>(accept => server.close(() => accept())); }
await json(resolve(dir, 'technical-review.json'), { sha256: sha256(bytes), metadata, completeDecode: 'passed-no-errors', playback, visualSampling: { intervalSeconds: 1, contactSheets: 9, visualReview: 'pending-human-inspection', notClaimed: 'All video frames visually inspected at full resolution' } });
console.log(JSON.stringify({ decode: 'passed', realTimePlayback: playback, contactSheets: dir }));

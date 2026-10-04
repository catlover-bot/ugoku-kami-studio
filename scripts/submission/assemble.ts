/** Edits only genuine recorded browser intervals. No generated UI or model text. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { args, folders, json, mergePublicManifest, readJson, sha256 } from './common.js';

type Scene = { name: string; start: number; end: number; targetSeconds: number };
type Capture = { status: string; rawVideo: string; codeSha: string; scenes: Scene[]; ai: { actualWaitSeconds: number; started: number; finished: number; mode: string; model: string; runId: string } };
const options = args(process.argv.slice(2), ['--capture', '--out', '--font']);
if (!options['--capture']) throw new Error('--capture actual capture.json is required');
const capture = await readJson<Capture>(resolve(options['--capture']));
assert.equal(capture.status, 'REAL_LOCAL_AI_CAPTURED'); assert.equal(capture.ai.mode, 'ollama');
const { publicDir, privateDir } = await folders(options['--out'] ?? 'artifacts/submission');
const editDir = resolve(privateDir, 'edit'); await mkdir(editDir, { recursive: true });
const run = (program: string, values: string[]) => new Promise<void>((accept, reject) => { const child = spawn(program, values, { stdio: ['ignore', 'ignore', 'pipe'] }); let log = ''; child.stderr.on('data', value => { log = (log + value).slice(-6000); }); child.on('error', reject); child.on('close', code => code === 0 ? accept() : reject(new Error(`${program} failed (${code}): ${log}`))); });
const captionText: Record<string, string[]> = {
  intro: ['絵から、動く紙工作の試作へ。', 'うごく紙工房・ローカル版の実操作です。'],
  selection: ['自作の魚の画像を読み込みます。', '動かしたい部分を四角く囲みます。', '四角い紙ごと動き、元の位置には白地が残ります。'],
  conditions: ['右へ20mm。絵の大きさは160×110mm。', '絵の大きさを保ち、A4型紙は1枚までにします。'],
  request: ['「もう少し大きく動かしたい。', '絵の大きさは変えず、紙も増やさない」'],
  wait: [`Gemmaの待ち時間を省略しています。`, `この実行の待ち時間：約${Math.round(capture.ai.actualWaitSeconds)}秒（ローカル環境）。`],
  candidate: ['AIが提案した20→25mmの案を、同じ縮尺で比較。', '寸法・配置・紙の上限は、共通の検査で確かめます。', '「この案にする」を押して初めて作品に反映します。'],
  print: ['採用した設計版から、A4の型紙PDFを取得。', '型紙と組み立て説明を分けても保存できます。'],
  assembly: ['同じ設計版の組み立てガイドです。', '加える部品、表裏、接着する面を順番に確認します。', '図の確認だけで、実物の動作を保証するものではありません。'],
  save: ['作品と入力途中の内容を、このブラウザに保存。', '作品一覧から続きを開けます。'],
  'manual-failure': ['ここはAIではなく、手動で70mmを指定した例です。', '成立しない寸法では、検査の理由が表示されます。', '元に戻して、取得した型紙の設計内容を保ちます。'],
  limitations: ['対応は矩形1か所・直線の引っぱりタブです。', '実物の印刷・組み立て、初見の人の操作は未確認。', '公開環境は準備中。この映像はローカル実演の下書きです。'],
};
const scenes: Scene[] = [];
for (const scene of capture.scenes) {
  scenes.push(scene);
  if (scene.name === 'request') {
    const start = scene.end + .1;
    if (capture.ai.finished - start < 3.5) throw new Error('Actual wait was too short for the planned disclosed wait cut; revise the edit explicitly.');
    scenes.push({ name: 'wait', start, end: capture.ai.finished, targetSeconds: 3 });
  }
}
assert.equal(scenes.reduce((sum, scene) => sum + scene.targetSeconds, 0), 180);
let timeline = 0;
const decisions: { name: string; sourceStart: number; sourceEnd: number; start: number; end: number }[] = [];
const captions: { start: number; end: number; text: string }[] = [];
for (let index = 0; index < scenes.length; index++) {
  const scene = scenes[index];
  assert.ok(scene.end - scene.start >= scene.targetSeconds + .15, `${scene.name} was not held long enough`);
  const start = scene.start + .1;
  decisions.push({ name: scene.name, sourceStart: start, sourceEnd: start + scene.targetSeconds, start: timeline, end: timeline + scene.targetSeconds });
  const lines = captionText[scene.name]; assert.ok(lines);
  if (scene.name === 'request' || scene.name === 'wait') captions.push({ start: timeline, end: timeline + scene.targetSeconds, text: lines.join('\n') });
  else lines.forEach((text, position) => captions.push({ start: timeline + scene.targetSeconds * position / lines.length, end: timeline + scene.targetSeconds * (position + 1) / lines.length, text }));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', capture.rawVideo, '-t', String(scene.targetSeconds), '-an', '-vf', 'fps=25,scale=1706:960:flags=lanczos,pad=1920:1080:(ow-iw)/2:0:color=0xf6f4ee,setsar=1', '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p', resolve(editDir, `scene-${index}.mp4`)]);
  timeline += scene.targetSeconds;
}
function time(seconds: number) { const milliseconds = Math.round(seconds * 1000); return `${String(Math.floor(milliseconds / 3600000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 60000) % 60).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')},${String(milliseconds % 1000).padStart(3, '0')}`; }
await writeFile(resolve(publicDir, 'captions.srt'), captions.map((caption, index) => `${index + 1}\n${time(caption.start)} --> ${time(caption.end)}\n${caption.text}\n`).join('\n'));
await writeFile(resolve(editDir, 'concat.txt'), scenes.map((_, index) => `file 'scene-${index}.mp4'`).join('\n'));
await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', resolve(editDir, 'concat.txt'), '-c', 'copy', resolve(editDir, 'joined.mp4')]);
// Use files inside the edit directory and a fixed filter expression; no shell is
// involved and no private path is burned into the public frame.
await writeFile(resolve(editDir, 'captions.srt'), await readFile(resolve(publicDir, 'captions.srt')));
const font = options['--font'] ?? '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
await writeFile(resolve(editDir, 'subtitle-font.ttc'), await readFile(font));
const escaped = editDir.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "'\\''");
await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', resolve(editDir, 'joined.mp4'), '-vf', `subtitles=filename='${escaped}/captions.srt':fontsdir='${escaped}':force_style='FontName=Noto Sans CJK JP,FontSize=10,PrimaryColour=&H00232929,Outline=0,Shadow=0,MarginV=8,Alignment=2'`, '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', resolve(publicDir, 'demo.mp4')]);
await json(resolve(editDir, 'edit-decisions.json'), { kind: 'actual-browser-footage-only', captureCodeSha: capture.codeSha, source: capture.rawVideo, speed: 1, decisions, captions, omitted: 'Secret setup, technical exports, and most model waiting. Waiting cut is disclosed in video.', syntheticUi: false, voiceOrMusic: false });
await mergePublicManifest(publicDir, { video: { filename: 'demo.mp4', sha256: sha256(await readFile(resolve(publicDir, 'demo.mp4'))), durationSeconds: 180, dimensions: [1920, 1080], fps: 25, actualModelWaitSeconds: capture.ai.actualWaitSeconds, modelRunId: capture.ai.runId, sourceCodeSha: capture.codeSha, mode: 'real-local-ollama', syntheticUi: false, waitingTimeCutDisclosed: true, audio: 'none', review: 'pending' }, captions: { filename: 'captions.srt', sha256: sha256(await readFile(resolve(publicDir, 'captions.srt'))), count: captions.length } });
console.log(JSON.stringify({ output: resolve(publicDir, 'demo.mp4'), seconds: timeline, scenes: scenes.length, review: 'pending' }));

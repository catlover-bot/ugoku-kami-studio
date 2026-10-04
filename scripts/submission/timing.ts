import { execFileSync } from 'node:child_process';

export type Synchronization = { wallBefore: number; wallAfter: number };
/** Markers are private standalone pages, before/after the product recording. */
export function calibrateTimeline(video: string, markers: Synchronization[]) {
  if (markers.length !== 2) throw new Error('Both recording synchronization markers are required');
  const samples = execFileSync('ffmpeg', ['-v', 'error', '-i', video, '-vf', 'fps=25,scale=1:1:flags=area,format=rgb24', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1024 * 1024 });
  const transitions: number[] = []; let magenta = false;
  for (let frame = 0; frame * 3 + 2 < samples.length; frame++) {
    const [r, g, b] = samples.subarray(frame * 3, frame * 3 + 3);
    if (r > 230 && g < 25 && b > 230) magenta = true;
    else if (magenta && r < 25 && g > 230 && b > 230) { transitions.push(frame / 25); magenta = false; }
    else if (magenta) magenta = false;
  }
  if (transitions.length !== 2) throw new Error(`Expected exactly two private sync transitions, received ${transitions.length}`);
  const observations = markers.map((marker, i) => ({ ...marker, videoPts: transitions[i], wallMinusVideoSeconds: (marker.wallBefore + marker.wallAfter) / 2 - transitions[i], uncertaintySeconds: (marker.wallAfter - marker.wallBefore) / 2 + .04 }));
  const driftSeconds = Math.abs(observations[1].wallMinusVideoSeconds - observations[0].wallMinusVideoSeconds);
  if (driftSeconds > .12 || observations.some(marker => marker.uncertaintySeconds > .10)) throw new Error(`Recording timing needs frame-by-frame correction: drift=${driftSeconds}`);
  return { wallMinusVideoSeconds: observations.reduce((total, item) => total + item.wallMinusVideoSeconds, 0) / 2, driftSeconds, observations, methodology: 'Two real color transitions on private standalone pages, 25fps decoded video; no product DOM or model output was changed.' };
}

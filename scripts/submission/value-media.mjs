/** Value-first film bindings. Viewer copy is separate from immutable evidence. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadFullSources } from './full-media.mjs';
import { safeFile, hash, read } from './goal016-media.mjs';
export { preparePdfImages, REAL_CAPTURE_FILE, REAL_CAPTURE_SHA, PDF_DPI } from './full-media.mjs';
import { PDF_DPI } from './full-media.mjs';

export const VALUE_EDITION = 'goal016-value-first';
const rawRange = [7.28, 21.36];
const PRODUCTION_COPY = /未確認|未検証|確認できていません|ローカル|別セッション|公開版|収録|実AI|[1１]依頼|[1１]送信|追加AI|SHA|Goal\d|テスト件数|検証件数|費用/u;
const LOCAL_CAPTURE_SHA = '4dcb67024007dbb2e75b0c1b271c4af6e134f4ea3c75d810ced7068f088ce0b1';

/** Reuse the original source, exact-design and no-extra-AI checks without editing them. */
export async function loadValueSources(assets, realManifest, localManifest) {
  const sources = await loadFullSources(assets, realManifest, localManifest);
  assert.equal(sources.local.sha256, LOCAL_CAPTURE_SHA, 'Reuse the reviewed continuation only');
  sources.rasterDirectory = join(sources.assets, 'private', VALUE_EDITION, 'video', 'pdf-pages');
  return sources;
}

/** Re-resolves both a render plan and completed EDL; reviewers compare resolved inputs. */
export async function resolveValueScenes(plan, sources) {
  assert.equal(plan.edition, VALUE_EDITION);
  assert.equal(plan.captureSha256, sources.real.sha256);
  assert.equal(plan.localCaptureSha256, sources.local.sha256);
  assert(Array.isArray(plan.scenes) && plan.scenes.length >= 5);
  const raster = await read(join(sources.rasterDirectory, 'binding.json'));
  assert.equal(raster.sourcePdfSha256, sources.pdf.sha256); assert.equal(raster.dpi, PDF_DPI);
  assert.deepEqual(raster.design, sources.pdf.stamp);
  const usedIds = new Set(), movingRanges = new Map(), stillKeys = new Set(), realRanges = [];
  let outputFrames = 0, firstRealStart = null;
  const resolved = [];
  for (const scene of plan.scenes) {
    assert(/^[a-z0-9-]+$/.test(scene.id) && !usedIds.has(scene.id)); usedIds.add(scene.id);
    assert(['video', 'still'].includes(scene.kind));
    assert(Number.isFinite(scene.duration) && scene.duration > 0 && Math.abs(scene.duration * 25 - Math.round(scene.duration * 25)) < 1e-6);
    for (const k of ['caption', 'label']) {
      assert(typeof scene[k] === 'string' && scene[k].trim());
      assert(!PRODUCTION_COPY.test(scene[k]), `Production notes are not viewer-facing ${k}`);
    }
    let input, sourceSha256, provenance, pdfSha256;
    if (scene.kind === 'video') {
      assert.equal(scene.playbackRate, 1);
      let lo, hi, clip;
      if (scene.source === 'real') {
        clip = sources.real.capture.clips.find(c => c.id === scene.clipId); assert(clip);
        input = join(sources.real.directory, clip.file); sourceSha256 = clip.sha256;
        lo = Math.max(clip.usableStartSeconds, rawRange[0]); hi = Math.min(clip.usableEndSeconds, rawRange[1]);
        provenance = 'public-real-ai'; firstRealStart ??= outputFrames / 25;
        realRanges.push({ start: scene.sourceStart, end: scene.sourceStart + scene.duration });

      } else {
        assert.equal(scene.source, 'local'); clip = sources.local.clips.get(scene.clipId); assert(clip);
        input = clip.file; sourceSha256 = clip.sha256;
        const shot = clip.scenes.find(s => s.id === scene.shotId); assert(shot, 'Local scenes require a named measured shot');
        lo = shot.sourceStart; hi = shot.sourceEnd; provenance = 'local-adopted-continuation';

      }
      assert(Number.isFinite(scene.sourceStart) && scene.sourceStart >= lo - 1e-6 && scene.sourceStart + scene.duration <= hi + 1e-6, 'Moving interval leaves its measured source shot');
      const prior = movingRanges.get(input) ?? [];
      assert(prior.every(p => scene.sourceStart >= p.end - 1e-6 || scene.sourceStart + scene.duration <= p.start + 1e-6), 'Do not repeat any moving footage');
      assert(!prior.length || scene.sourceStart >= prior.at(-1).end - 1e-6, 'Keep each recording in actual chronological order');
      prior.push({ start: scene.sourceStart, end: scene.sourceStart + scene.duration }); movingRanges.set(input, prior);
    } else {
      assert(scene.duration >= 4 && scene.duration <= 10, 'Explanatory stills are limited to 4–10 seconds');
      if (scene.duration > 7) assert(typeof scene.holdReason === 'string' && scene.holdReason.trim(), 'Longer stills require a measured-speech or reading purpose');
      assert(scene.label.includes('静止')); assert(typeof scene.explanation === 'string' && scene.explanation.trim());
      if (scene.source === 'real-image') {
        const item = sources.real.capture.images.find(i => i.role === scene.imageRole); assert(item);
        input = join(sources.real.directory, item.file); sourceSha256 = item.sha256; provenance = 'public-real-ai-still';
      } else {
        assert.equal(scene.source, 'pdf');
        const page = raster.pages.find(p => p.page === scene.page); assert(page);
        input = await safeFile(sources.rasterDirectory, page.file); sourceSha256 = page.sha256;
        provenance = 'bound-pdf'; pdfSha256 = sources.pdf.sha256;
      }
      const key = `${input}|${JSON.stringify(scene.crop ?? null)}`;
      assert(!stillKeys.has(key), 'Identical stills must not be repeated'); stillKeys.add(key);
    }
    assert.equal(await hash(input), sourceSha256);
    if (scene.crop) {
      assert.deepEqual(Object.keys(scene.crop).sort(), ['height', 'left', 'top', 'width']);
      for (const [k, value] of Object.entries(scene.crop)) assert(Number.isInteger(value) && value >= (['width', 'height'].includes(k) ? 1 : 0));
      assert(scene.label.includes('拡大'), 'A crop must be explicitly labeled');
    }
    const outputStart = outputFrames / 25;
    outputFrames += Math.round(scene.duration * 25);
    const item = { ...scene, input, sourceSha256, provenance, ...(pdfSha256 ? { pdfSha256 } : {}), outputStart, outputEnd: outputFrames / 25 };
    for (const key of ['input', 'sourceSha256', 'provenance', 'pdfSha256', 'outputStart', 'outputEnd']) {
      if (Object.hasOwn(scene, key)) assert.deepEqual(scene[key], item[key], `Completed EDL changed ${key}`);
    }
    resolved.push(item);
  }
  assert(firstRealStart !== null && firstRealStart <= 25, 'Introduce the actual request before30seconds');
  assert(Math.abs(realRanges[0].start - rawRange[0]) < 1e-6 && Math.abs(realRanges.at(-1).end - rawRange[1]) < 1e-6, 'Show the complete request-through-adoption interval');
  for (let i = 1; i < realRanges.length; i++) assert(Math.abs(realRanges[i].start - realRanges[i-1].end) < 1e-6, 'No wait omission or repeated real inference');
  assert(resolved.some(s => s.source === 'local') && resolved.some(s => s.source === 'pdf'));
  assert.deepEqual([...new Set(resolved.filter(s => s.source === 'pdf').map(s => s.page))].sort(), [1, 2, 3, 4, 5], 'Explain all five pages of the same-version PDF');
  assert(outputFrames / 25 >= 150 && outputFrames / 25 <= 180);
  return resolved;
}

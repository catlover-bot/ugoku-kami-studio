/** Goal016 full-film bindings. Local files only; no application/model/network calls. */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { loadCapture, safeFile, hash, read, save, stamp } from './goal016-media.mjs';

export const FULL_EDITION = 'goal016-submission';
export const REAL_CAPTURE_SHA = '86fc2e4702c4ecb54196c611d2a3262112c7ad5f76c0db571be4ac02c1e2b69a';
export const REAL_CAPTURE_FILE = 'private/goal016-final/capture/2026-10-13T17-11-18.589Z/capture.json';
export const PDF_DPI = 144;
const rawRange = [7.28, 21.36]; // Request through actual adoption, excluding old PDF/guide/reload.
const absolute = (assets, path) => resolve(assets, path);
const recordPath = async (directory, item, name = 'file') => {
  const file = await safeFile(directory, relative(directory, resolve(directory, item[name])));
  assert.equal(await hash(file), item.sha256 ?? item.rawSha256);
  return file;
};

export async function loadFullSources(assets, realManifest, localManifest) {
  assets = resolve(assets);
  assert.equal(absolute(assets, realManifest), join(assets, REAL_CAPTURE_FILE));
  const real = await loadCapture(assets, absolute(assets, realManifest));
  assert.equal(real.sha256, REAL_CAPTURE_SHA);
  const localRoot = join(assets, 'private', FULL_EDITION, 'local-capture');
  const path = await safeFile(localRoot, relative(localRoot, absolute(assets, localManifest)));
  const directory = resolve(path, '..'), capture = await read(path);
  assert.equal(capture.format, 'ugoku-goal016-local-continuation-v1');
  assert.equal(capture.status, 'passed');
  assert.equal(capture.newModelRequests, 0); assert.equal(capture.newModelCalls, 0);
  assert.equal(capture.aiProvider, 'none');
  assert.equal(capture.aiCalls, 0); assert.equal(capture.cloudCalls, 0);
  assert.equal(capture.originalCaptureSha256, real.sha256);
  assert(/^[a-f0-9]{40}$/.test(capture.sourceSha));
  assert.equal(capture.sourceSha, real.capture.sourceSha, 'Local continuation must use the same deployed product source');
  assert.equal(capture.build?.frontendMatchesOriginalCapture, true);
  assert.deepEqual(stamp(capture.adopted), real.capture.liveAi.adopted);
  const adopted = await read(join(real.directory, real.capture.evidence.adoptedProject.file));
  for (const key of ['importedProject', 'reloadedProject']) {
    assert(capture.evidence?.[key], `Missing ${key}`);
    const file = await recordPath(directory, capture.evidence[key]);
    const project = await read(file);
    assert.deepEqual(project.document, adopted.document, `${key} must be the exact actually adopted document`);
  }
  assert(capture.clips?.length > 0);
  const clips = new Map(), ids = new Set();
  for (const clip of capture.clips) {
    const id = clip.id ?? clip.name;
    assert(/^[a-z0-9-]+$/.test(id) && !ids.has(id)); ids.add(id);
    assert(Number.isFinite(clip.usableStartSeconds) && Number.isFinite(clip.usableEndSeconds));
    assert(clip.usableStartSeconds >= 0 && clip.usableEndSeconds > clip.usableStartSeconds);
    const file = await recordPath(directory, clip, clip.rawVideo ? 'rawVideo' : 'file');
    assert(clip.scenes?.length > 0);
    for (const shot of clip.scenes) {
      assert(typeof shot.id === 'string');
      assert(Number.isFinite(shot.sourceStart) && Number.isFinite(shot.sourceEnd));
      assert(shot.sourceStart >= clip.usableStartSeconds && shot.sourceEnd <= clip.usableEndSeconds);
      assert(shot.sourceEnd > shot.sourceStart);
    }
    clips.set(id, { ...clip, id, file, sha256: clip.rawSha256 ?? clip.sha256 });
  }
  const pdfs = capture.pdfs ?? capture.clips.flatMap(c => c.pdfs ?? []);
  assert(pdfs.length >= 1, 'At least the current local same-version PDF must be preserved');
  for (const p of pdfs) {
    const file = await recordPath(directory, p);
    const pdf = await PDFDocument.load(await readFile(file), { updateMetadata: false });
    assert.deepEqual(stamp(p.stamp), real.capture.liveAi.adopted);
    assert.equal(pdf.getTitle(), `${capture.adopted.designId} revision ${capture.adopted.revision}`);
    assert(pdf.getSubject()?.includes(capture.adopted.designHash));
    assert.equal(pdf.getPageCount(), p.pages);
    for (const page of pdf.getPages()) {
      const size = page.getSize();
      assert(Math.abs(size.width * 25.4 / 72 - 210) < 1e-5 && Math.abs(size.height * 25.4 / 72 - 297) < 1e-5);
    }
  }
  return { assets, real, local: { path, directory, capture, sha256: await hash(path), clips },
    pdf: { file: join(real.directory, real.capture.pdf.file), sha256: real.capture.pdf.sha256,
      pages: real.capture.pdf.pages, stamp: real.capture.pdf.stamp },
    rasterDirectory: join(assets, 'private', FULL_EDITION, 'video', 'pdf-pages') };
}

/** Render only the bound actual PDF. Never accepts a caller-selected image. */
export async function preparePdfImages(sources) {
  await mkdir(sources.rasterDirectory, { mode: 0o700 });
  execFileSync('pdftoppm', ['-r', String(PDF_DPI), '-png', sources.pdf.file, join(sources.rasterDirectory, 'page')], { stdio: 'pipe' });
  const pages = [];
  for (let page = 1; page <= sources.pdf.pages; page++) {
    const file = `page-${page}.png`;
    pages.push({ page, file, sha256: await hash(join(sources.rasterDirectory, file)) });
  }
  const binding = { sourcePdfSha256: sources.pdf.sha256, sourcePdf: sources.pdf.file, dpi: PDF_DPI,
    design: sources.pdf.stamp, pages };
  await save(join(sources.rasterDirectory, 'binding.json'), binding);
  return binding;
}

/** Re-resolves both a render plan and completed EDL; reviewers compare resolved inputs. */
export async function resolveFullScenes(plan, sources) {
  assert.equal(plan.edition, FULL_EDITION);
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
    for (const k of ['caption', 'label']) assert(typeof scene[k] === 'string' && scene[k].trim());
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
        assert(scene.label.includes('実AI'));
      } else {
        assert.equal(scene.source, 'local'); clip = sources.local.clips.get(scene.clipId); assert(clip);
        input = clip.file; sourceSha256 = clip.sha256;
        const shot = clip.scenes.find(s => s.id === scene.shotId); assert(shot, 'Local scenes require a named measured shot');
        lo = shot.sourceStart; hi = shot.sourceEnd; provenance = 'local-adopted-continuation';
        assert(scene.label.includes('ローカル'));
        if (scene.shotId === 'home-intro') assert(!scene.label.includes('第2版'), 'Home is shown before the adopted project is imported');
        else assert(scene.label.includes('同じ第2版'));
      }
      assert(Number.isFinite(scene.sourceStart) && scene.sourceStart >= lo - 1e-6 && scene.sourceStart + scene.duration <= hi + 1e-6, 'Moving interval leaves its measured source shot');
      const prior = movingRanges.get(input) ?? [];
      assert(prior.every(p => scene.sourceStart >= p.end - 1e-6 || scene.sourceStart + scene.duration <= p.start + 1e-6), 'Do not repeat any moving footage');
      assert(!prior.length || scene.sourceStart >= prior.at(-1).end - 1e-6, 'Keep each recording in actual chronological order');
      prior.push({ start: scene.sourceStart, end: scene.sourceStart + scene.duration }); movingRanges.set(input, prior);
    } else {
      assert(scene.duration >= 4 && scene.duration <= 7, 'Explanatory stills are limited to 4–7 seconds');
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

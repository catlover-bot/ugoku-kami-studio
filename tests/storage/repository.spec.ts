import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const moduleUrl = `/@fs${resolve('tests/storage/browser.ts')}`;
async function boot(page: Page) {
  await page.route('**/__repository_test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Repository native browser test</title>' }));
  await page.goto('/__repository_test');
}
test.beforeEach(async ({ page }) => { await boot(page); });

test('three validated works, v1/v2 files, draft restoration and lightweight metadata survive browser-page restart', async ({ page }) => {
  const databaseName = `storage-${randomUUID()}`;
  const before = await page.evaluate(async ({ moduleUrl, databaseName }) => {
    const { repository: r, project: p, fixture, recordFor } = await import(moduleUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName });
    const one = await fixture('one', true); one.records = [recordFor(one)];
    const draft = { ...r.EMPTY_WORKSPACE_DRAFT, stage: 2 as const, zoom: 1.5 as const, view: 'back' as const, selection: { x: 2, y: 3, width: 4, height: 5 }, editing: true, numericDrafts: { travelMm: '2.' }, numericBase: { designId: one.document.designId, revision: one.document.revision, designHash: one.document.designHash }, recordDraft: { ...recordFor(one), id: 'unfinished-record', movement: 'まだ入力中' } };
    const saved = await repo.save({ project: one, draft, expectedGeneration: null, name: '最初の作品' });
    const v1 = await fixture('two');
    const parsedV1 = await p.parseProject(JSON.stringify({ format: 'ugoku-kami-project', version: 1, ...v1 }));
    await repo.save({ project: parsedV1, draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: null });
    await repo.save({ project: await fixture('three'), draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: null });
    const renamed = await repo.rename(saved.id, '名前を変更', saved.generation);
    const list = await repo.list();
    await repo.close();
    return { list, generation: renamed.generation, document: one.document, draft, image: one.imageDataUrl, background: one.backgroundImageDataUrl };
  }, { moduleUrl, databaseName });
  expect(before.list).toHaveLength(3);
  expect(before.list.every(item => item.status === 'ready' && item.thumbnail.startsWith('data:image/png;base64,'))).toBe(true);
  expect(before.list.some(item => 'project' in item || 'draft' in item)).toBe(false);
  await page.reload();
  const restored = await page.evaluate(async ({ moduleUrl, databaseName }) => {
    const { repository: r } = await import(moduleUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName }); const value = await repo.load('one'); await repo.close(); return value;
  }, { moduleUrl, databaseName });
  expect(restored).not.toBeNull();
  expect(restored!.name).toBe('名前を変更');
  expect(restored!.generation).toBe(before.generation);
  expect(restored!.project.document).toEqual(before.document);
  expect(restored!.project.imageDataUrl).toBe(before.image);
  expect(restored!.project.backgroundImageDataUrl).toBe(before.background);
  expect(restored!.draft).toEqual(before.draft);
  expect(restored!.project.records).toHaveLength(1);
  expect(restored!.project.records[0]!.id).toBe('physical-one');
});

test('draft-only writes never rewrite project images and never persist credentials or running AI state', async ({ page }) => {
  const result = await page.evaluate(async moduleUrl => {
    const { repository: r, fixture, rawRead } = await import(moduleUrl) as typeof import('./browser');
    const databaseName = `storage-${crypto.randomUUID()}`, repo = r.createProjectRepository({ databaseName });
    const project = await fixture();
    const saved = await repo.save({ project, draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: null });
    const puts: string[] = [], original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { puts.push(this.name); return original.apply(this, args); };
    let current;
    try { current = await repo.saveDraft(saved.id, { ...r.EMPTY_WORKSPACE_DRAFT, zoom: 2, numericDrafts: { travelMm: '', secret: 'SYNTHETIC_SECRET' }, numericBase: { designId: 'one', revision: 1, designHash: project.document.designHash, token: 'SYNTHETIC_SECRET' }, apiKey: 'SYNTHETIC_SECRET', accessCode: 'SYNTHETIC_SECRET', sessionToken: 'SYNTHETIC_SECRET', run: { status: 'running' }, playing: true } as Parameters<typeof repo.saveDraft>[1], saved.generation); }
    finally { IDBObjectStore.prototype.put = original; }
    const loaded = await repo.load(saved.id), raw = await rawRead(databaseName, 'drafts', saved.id);
    await repo.close();
    return { puts, current, raw, loaded, oldHash: project.document.designHash };
  }, moduleUrl);
  expect(result.puts).toEqual(['entries', 'drafts']);
  expect(result.current.generation).toBe(2);
  expect(result.loaded!.project.document.designHash).toBe(result.oldHash);
  expect(result.loaded!.project.document.revision).toBe(1);
  expect(result.loaded!.draft.numericDrafts).toEqual({ travelMm: '' });
  expect(JSON.stringify(result.raw)).not.toContain('SYNTHETIC_SECRET');
  expect(JSON.stringify(result.raw)).not.toMatch(/sessionToken|apiKey|accessCode|playing|running/);
});

test('two real tabs competing at one generation commit once; rename, draft, delete and ABA resurrection are guarded', async ({ page, context }) => {
  const databaseName = `storage-${randomUUID()}`;
  const initial = await page.evaluate(async ({ moduleUrl, databaseName }) => {
    const { repository: r, fixture } = await import(moduleUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName }); const entry = await repo.save({ project: await fixture(), draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: null }); await repo.close(); return entry;
  }, { moduleUrl, databaseName });
  const other = await context.newPage(); await boot(other);
  const values = await Promise.all([page, other].map((tab, index) => tab.evaluate(async ({ moduleUrl, databaseName, initial, index }) => {
    const { repository: r, applyDesignPatch } = await import(moduleUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName });
    try {
      const entry = await repo.save({ id: initial.id, project: { ...initial.project, document: applyDesignPatch(initial.project.document, { travelMm: 18 + index }) }, draft: initial.draft, name: `tab-${index}`, expectedGeneration: initial.generation });
      return { result: 'saved', generation: entry.generation };
    } catch (error) { return { result: error instanceof r.RepositoryConflictError ? 'conflict' : String(error), generation: 0 }; }
    finally { await repo.close(); }
  }, { moduleUrl, databaseName, initial, index })));
  expect(values.map(value => value.result).sort()).toEqual(['conflict', 'saved']);
  const guarded = await page.evaluate(async ({ moduleUrl, databaseName, initial }) => {
    const { repository: r } = await import(moduleUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName }), codes: string[] = [];
    for (const act of [() => repo.rename(initial.id, 'old tab', 1), () => repo.saveDraft(initial.id, initial.draft, 1), () => repo.delete(initial.id, 1)]) {
      try { await act(); codes.push('unexpected'); } catch (error) { codes.push(error instanceof r.RepositoryConflictError ? 'conflict' : String(error)); }
    }
    const latest = (await repo.load(initial.id))!;
    await repo.delete(initial.id, latest.generation);
    const missing = await repo.load(initial.id);
    const recreated = await repo.save({ id: initial.id, project: initial.project, draft: initial.draft, expectedGeneration: null });
    try { await repo.rename(initial.id, 'stale before delete', latest.generation); codes.push('unexpected'); } catch (error) { codes.push(error instanceof r.RepositoryConflictError ? 'conflict' : String(error)); }
    await repo.close(); return { codes, missing, recreatedGeneration: recreated.generation };
  }, { moduleUrl, databaseName, initial });
  expect(guarded.codes).toEqual(['conflict', 'conflict', 'conflict', 'conflict']);
  expect(guarded.missing).toBeNull();
  expect(guarded.recreatedGeneration).toBe(4);
  await other.close();
});

test('duplicates have a new design identity, revision one, no inherited physical evidence or evidence draft', async ({ page }) => {
  const result = await page.evaluate(async moduleUrl => {
    const { repository: r, fixture, recordFor, applyDesignPatch } = await import(moduleUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName: `storage-${crypto.randomUUID()}` });
    const project = await fixture('original', true); project.document = applyDesignPatch(project.document, { travelMm: 18 }); project.records = [recordFor(project)];
    const saved = await repo.save({ project, draft: { ...r.EMPTY_WORKSPACE_DRAFT, recordDraft: recordFor(project), numericDrafts: { travelMm: '-' }, guide: { designId: project.document.designId, revision: project.document.revision, designHash: project.document.designHash, step: 3 } }, expectedGeneration: null, name: '原本' });
    const copied = await repo.duplicate(saved.id, saved.generation);
    const original = await repo.load(saved.id); await repo.delete(copied.id, copied.generation);
    const list = await repo.list(); await repo.close(); return { copied, original, list };
  }, moduleUrl);
  expect(result.copied.project.document.designId).not.toBe(result.original!.project.document.designId);
  expect(result.copied.project.document.revision).toBe(1);
  expect(result.copied.project.document.physicalValidation).toBe('unverified');
  expect(result.copied.project.records).toEqual([]);
  expect(result.copied.draft.recordDraft).toBeUndefined();
  expect(result.copied.draft.numericDrafts).toBeUndefined();
  expect(result.copied.draft.guide).toBeUndefined();
  expect(result.copied.project.backgroundImageDataUrl).toBe(result.original!.project.backgroundImageDataUrl);
  expect(result.original!.project.records).toHaveLength(1);
  expect(result.list.map(item => item.id)).toEqual(['original']);
});

test('legacy migration is verified, idempotent across tabs, retains old bytes, and never resurrects an explicitly deleted work', async ({ page, context }) => {
  const databaseName = `storage-${randomUUID()}`;
  const original = await page.evaluate(async moduleUrl => {
    const { project: p, fixture } = await import(moduleUrl) as typeof import('./browser');
    const text = JSON.stringify({ format: 'ugoku-kami-project', version: 1, ...await fixture('legacy-original') }); localStorage.setItem(p.STORAGE_KEY, text); return text;
  }, moduleUrl);
  const other = await context.newPage(); await boot(other);
  const results = await Promise.all([page, other].map(tab => tab.evaluate(async ({ moduleUrl, databaseName }) => {
    const { repository: r } = await import(moduleUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName }); const result = await repo.migrateLegacy(); await repo.close(); return result;
  }, { moduleUrl, databaseName })));
  expect(results.map(result => result.status).sort()).toEqual(['already-migrated', 'migrated']);
  expect(results[0]!.entry!.id).toBe(results[1]!.entry!.id);
  const after = await page.evaluate(async ({ moduleUrl, databaseName }) => {
    const { repository: r, project: p } = await import(moduleUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName }); const list = await repo.list(); await repo.delete(list[0]!.id, list[0]!.generation); const repeated = await repo.migrateLegacy(); const empty = await repo.list(); await repo.close(); return { count: list.length, repeated, empty, legacy: localStorage.getItem(p.STORAGE_KEY) };
  }, { moduleUrl, databaseName });
  expect(after.count).toBe(1);
  expect(after.repeated).toEqual({ status: 'already-migrated', entry: null });
  expect(after.empty).toEqual([]);
  expect(after.legacy).toBe(original);
  await other.close();
});

test('one corrupt project or draft can be inspected and deleted without harming the remaining works', async ({ page }) => {
  const result = await page.evaluate(async moduleUrl => {
    const { repository: r, fixture, rawWrite, rawDelete } = await import(moduleUrl) as typeof import('./browser');
    const databaseName = `storage-${crypto.randomUUID()}`, repo = r.createProjectRepository({ databaseName });
    for (const id of ['good', 'broken-project', 'broken-draft', 'broken-meta', 'orphan']) await repo.save({ project: await fixture(id), draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: null });
    await rawWrite(databaseName, 'projects', 'broken-project', '{broken');
    await rawWrite(databaseName, 'drafts', 'broken-draft', { stage: 999, apiKey: 'SYNTHETIC_SECRET' });
    await rawWrite(databaseName, 'entries', 'broken-meta', { name: '壊れた保存情報', generation: 1 });
    await rawDelete(databaseName, 'entries', 'orphan');
    const list = await repo.list(), errors: string[] = [];
    for (const id of ['broken-project', 'broken-draft', 'broken-meta', 'orphan']) { try { await repo.load(id); } catch (error) { errors.push(error instanceof r.StorageError ? error.code : String(error)); } }
    const projectRecovery = await repo.recover('broken-project'), draftRecovery = await repo.recover('broken-draft'), metadataRecovery = await repo.recover('broken-meta');
    for (const id of ['broken-project', 'broken-draft', 'broken-meta']) await repo.delete(id, 1);
    const orphanRecovery = await repo.recover('orphan'); await repo.delete('orphan', null);
    const good = await repo.load('good'), after = await repo.list(); await repo.close();
    return { list, errors, projectRecovery, draftRecovery, metadataRecovery, orphanRecovery, good, after };
  }, moduleUrl);
  expect(result.list).toHaveLength(5);
  expect(result.list.find(item => item.id === 'broken-meta')!.status).toBe('corrupt');
  expect(result.errors).toEqual(['corrupt', 'corrupt', 'corrupt', 'corrupt']);
  expect(result.orphanRecovery.project).not.toBeNull();
  expect(result.projectRecovery.project).toBeNull();
  expect(result.projectRecovery.draft).not.toBeNull();
  expect(result.draftRecovery.project).not.toBeNull();
  expect(result.draftRecovery.draft).toBeNull();
  expect(result.metadataRecovery.project).not.toBeNull();
  expect(result.good!.project.document.designId).toBe('good');
  expect(result.after.map(item => item.id)).toEqual(['good']);
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
});

test('injected quota refusal aborts the real transaction atomically, keeps current draft in memory, and never deletes old data', async ({ page }) => {
  const result = await page.evaluate(async moduleUrl => {
    const { repository: r, fixture, rawRead } = await import(moduleUrl) as typeof import('./browser');
    const databaseName = `storage-${crypto.randomUUID()}`, repo = r.createProjectRepository({ databaseName });
    const original = await repo.save({ project: await fixture(), draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: null });
    const pending = { ...r.EMPTY_WORKSPACE_DRAFT, numericDrafts: { travelMm: '12.' } };
    const put = IDBObjectStore.prototype.put; let errorCode = '';
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'drafts') throw new DOMException('Synthetic quota refusal', 'QuotaExceededError'); return put.apply(this, args); };
    try { await repo.saveDraft(original.id, pending, original.generation); } catch (error) { errorCode = error instanceof r.StorageError ? error.code : String(error); }
    finally { IDBObjectStore.prototype.put = put; }
    const restored = await repo.load(original.id), raw = await rawRead(databaseName, 'entries', original.id); await repo.close();
    return { original, pending, restored, errorCode, raw };
  }, moduleUrl);
  expect(result.errorCode).toBe('quota');
  expect(result.restored).toEqual(result.original);
  expect(result.pending.numericDrafts.travelMm).toBe('12.');
  expect(result.raw).toMatchObject({ generation: 1 });
});

test('injected storage denial reports an actionable error, and project image/100-record/45MB bounds remain enforced before writes', async ({ page }) => {
  const result = await page.evaluate(async moduleUrl => {
    const { repository: r, fixture, recordFor, project: p } = await import(moduleUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName: `storage-${crypto.randomUUID()}` }), original = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function () { throw new DOMException('Synthetic storage refusal', 'SecurityError'); };
    let denied = '';
    try { await repo.list(); } catch (error) { denied = error instanceof r.StorageError ? error.code : String(error); } finally { IDBFactory.prototype.open = original; }
    const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB')!;
    Object.defineProperty(window, 'indexedDB', { configurable: true, get() { throw new DOMException('Synthetic denied property access', 'SecurityError'); } });
    let deniedProperty = '';
    try { await repo.list(); } catch (error) { deniedProperty = error instanceof r.StorageError ? error.code : String(error); } finally { Object.defineProperty(window, 'indexedDB', descriptor); }
    const base = await fixture(), record = recordFor(base), errors: string[] = [];
    const hundred = await repo.save({ project: { ...base, records: Array.from({ length: 100 }, (_, i) => ({ ...record, id: `record-${i}` })) }, draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: null });
    for (const value of [{ ...base, records: Array.from({ length: 101 }, () => record) }, { ...base, imageDataUrl: 'data:image/png;base64,aGVsbG8=' }]) {
      try { await repo.save({ project: value, draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: hundred.generation }); } catch (error) { errors.push(error instanceof r.StorageError ? error.code : String(error)); }
    }
    localStorage.setItem(p.STORAGE_KEY, '{bad'); let migrationError = '';
    try { await repo.migrateLegacy(); } catch (error) { migrationError = error instanceof r.StorageError ? error.code : String(error); }
    const oldBytes = localStorage.getItem(p.STORAGE_KEY), restored = await repo.load(base.document.designId), list = await repo.list(); await repo.close();
    let sizeBoundary = false; try { p.assertProjectByteLength(p.MAX_PROJECT_BYTES + 1); } catch { sizeBoundary = true; }
    return { denied, deniedProperty, errors, migrationError, oldBytes, count: restored!.project.records.length, generation: restored!.generation, listLength: list.length, sizeBoundary };
  }, moduleUrl);
  expect(result).toEqual({ denied: 'denied', deniedProperty: 'denied', errors: ['invalid', 'invalid'], migrationError: 'corrupt', oldBytes: '{bad', count: 100, generation: 1, listLength: 1, sizeBoundary: true });
});

test('duplicate checks its source again inside the target-creation transaction after asynchronous image validation', async ({ page }) => {
  const result = await page.evaluate(async moduleUrl => {
    const { repository: r, fixture } = await import(moduleUrl) as typeof import('./browser');
    const databaseName = `storage-${crypto.randomUUID()}`, repo = r.createProjectRepository({ databaseName }), other = r.createProjectRepository({ databaseName });
    const source = await repo.save({ project: await fixture(), draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: null });
    await other.list();
    const original = HTMLCanvasElement.prototype.toDataURL; let changing: Promise<unknown> | undefined, failure = '';
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const result = original.apply(this, args);
      changing ??= other.rename(source.id, '別のタブで変更', source.generation);
      return result;
    };
    try { await repo.duplicate(source.id, source.generation); } catch (error) { failure = error instanceof r.RepositoryConflictError ? 'conflict' : String(error); }
    finally { HTMLCanvasElement.prototype.toDataURL = original; }
    await changing;
    const list = await repo.list(); await repo.close(); await other.close(); return { failure, list };
  }, moduleUrl);
  expect(result.failure).toBe('conflict');
  expect(result.list).toHaveLength(1);
  expect(result.list[0]).toMatchObject({ name: '別のタブで変更', generation: 2 });
});

test('a successful final request followed by a native transaction abort never reports a successful save', async ({ page }) => {
  const result = await page.evaluate(async moduleUrl => {
    const { repository: r, fixture } = await import(moduleUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName: `storage-${crypto.randomUUID()}` });
    const originalEntry = await repo.save({ project: await fixture(), draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: null });
    const original = IDBObjectStore.prototype.put; let requestSucceeded = false, failure = '';
    IDBObjectStore.prototype.put = function (...args) {
      const request = original.apply(this, args);
      if (this.name === 'drafts') request.addEventListener('success', () => { requestSucceeded = true; this.transaction.abort(); });
      return request;
    };
    try { await repo.saveDraft(originalEntry.id, { ...r.EMPTY_WORKSPACE_DRAFT, stage: 3 }, originalEntry.generation); }
    catch (error) { failure = error instanceof r.StorageError ? error.code : String(error); }
    finally { IDBObjectStore.prototype.put = original; }
    const restored = await repo.load(originalEntry.id); await repo.close(); return { requestSucceeded, failure, restored, originalEntry };
  }, moduleUrl);
  expect(result.requestSucceeded).toBe(true);
  expect(result.failure).toBe('unknown');
  expect(result.restored).toEqual(result.originalEntry);
});

test('migration quota refusal leaves legacy bytes untouched and rolls back its marker so explicit retry succeeds once', async ({ page }) => {
  const result = await page.evaluate(async moduleUrl => {
    const { repository: r, fixture, project: p } = await import(moduleUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName: `storage-${crypto.randomUUID()}` });
    const text = p.serializeProject(await fixture()); localStorage.setItem(p.STORAGE_KEY, text);
    const original = IDBObjectStore.prototype.put; let failure = '';
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'migrations') throw new DOMException('Synthetic quota refusal', 'QuotaExceededError'); return original.apply(this, args); };
    try { await repo.migrateLegacy(); } catch (error) { failure = error instanceof r.StorageError ? error.code : String(error); }
    finally { IDBObjectStore.prototype.put = original; }
    const empty = await repo.list(), beforeRetry = localStorage.getItem(p.STORAGE_KEY);
    const retry = await repo.migrateLegacy(), repeated = await repo.migrateLegacy(), list = await repo.list(); await repo.close();
    return { failure, empty, unchanged: text === beforeRetry && text === localStorage.getItem(p.STORAGE_KEY), retry: retry.status, repeated: repeated.status, count: list.length };
  }, moduleUrl);
  expect(result).toEqual({ failure: 'quota', empty: [], unchanged: true, retry: 'migrated', repeated: 'already-migrated', count: 1 });
});

test('a real over-45MB project of valid small PNG photos is rejected before any database write and leaves the prior work intact', async ({ page }) => {
  const result = await page.evaluate(async moduleUrl => {
    const { repository: r, fixture, recordFor, project: p } = await import(moduleUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName: `storage-${crypto.randomUUID()}` });
    const project = await fixture(), saved = await repo.save({ project, draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: null });
    const canvas = document.createElement('canvas'); canvas.width = 1100; canvas.height = 950;
    const context = canvas.getContext('2d')!, pixels = context.createImageData(canvas.width, canvas.height);
    let state = 0x1f2e3d4c;
    for (let index = 0; index < pixels.data.length; index += 4) {
      for (let channel = 0; channel < 3; channel++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; pixels.data[index + channel] = state & 255; }
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const photo = canvas.toDataURL('image/png'); await p.verifyDataImage(photo);
    const oversized = { ...project, records: Array.from({ length: 3 }, (_, index) => ({ ...recordFor(project), id: `record-${index}`, photos: [photo, photo, photo, photo] })) };
    const fullBytes = new TextEncoder().encode(JSON.stringify({ format: 'ugoku-kami-project', version: 2, ...oversized })).byteLength;
    const original = IDBObjectStore.prototype.put; let writes = 0, code = '', message = '';
    IDBObjectStore.prototype.put = function (...args) { writes++; return original.apply(this, args); };
    try { await repo.save({ project: oversized, draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: saved.generation }); }
    catch (error) { code = error instanceof r.StorageError ? error.code : String(error); message = error instanceof Error ? error.message : ''; }
    finally { IDBObjectStore.prototype.put = original; }
    const restored = await repo.load(saved.id); await repo.close();
    return { fullBytes, photoBytes: atob(photo.split(',')[1]!).length, writes, code, message, unchanged: restored!.generation === saved.generation && restored!.project.records.length === 0, memoryPhotoCount: oversized.records.flatMap(item => item.photos).length };
  }, moduleUrl);
  expect(result.fullBytes).toBeGreaterThan(45_000_000);
  expect(result.photoBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
  expect(result.writes).toBe(0);
  expect(result.code).toBe('invalid');
  expect(result.message).toContain('45MB');
  expect(result.unchanged).toBe(true);
  expect(result.memoryPhotoCount).toBe(12);
});

test('recover explains a schema-valid metadata stamp mismatch while returning only the validated original design', async ({ page }) => {
  const result = await page.evaluate(async moduleUrl => {
    const { repository: r, fixture, rawRead, rawWrite } = await import(moduleUrl) as typeof import('./browser');
    const databaseName = `storage-${crypto.randomUUID()}`, repo = r.createProjectRepository({ databaseName });
    const saved = await repo.save({ project: await fixture(), draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: null });
    const metadata = await rawRead(databaseName, 'entries', saved.id) as Record<string, unknown>;
    await rawWrite(databaseName, 'entries', saved.id, { ...metadata, revision: 999, designHash: 'mismatched-stamp' });
    let loadError = ''; try { await repo.load(saved.id); } catch (error) { loadError = error instanceof r.StorageError ? error.code : String(error); }
    const recovery = await repo.recover(saved.id); await repo.close(); return { loadError, recovery, original: saved.project.document };
  }, moduleUrl);
  expect(result.loadError).toBe('corrupt');
  expect(result.recovery.issues.some(issue => issue.includes('設計版が一致しません'))).toBe(true);
  expect(result.recovery.project!.document).toEqual(result.original);
});

test('a migration marker with missing work reports corruption, exposes a remaining draft, and differs from an explicit tombstone deletion', async ({ page }) => {
  const result = await page.evaluate(async moduleUrl => {
    const { repository: r, fixture, project: p, rawDelete } = await import(moduleUrl) as typeof import('./browser');
    const databaseName = `storage-${crypto.randomUUID()}`, repo = r.createProjectRepository({ databaseName });
    const text = p.serializeProject(await fixture()); localStorage.setItem(p.STORAGE_KEY, text);
    const migrated = await repo.migrateLegacy(), id = migrated.entry!.id;
    await rawDelete(databaseName, 'entries', id); await rawDelete(databaseName, 'projects', id);
    const list = await repo.list(), recovery = await repo.recover(id);
    let missingError = '', message = '';
    try { await repo.migrateLegacy(); } catch (error) { missingError = error instanceof r.StorageError ? error.code : String(error); message = error instanceof Error ? error.message : ''; }
    await repo.delete(id, null);
    const deleted = await repo.migrateLegacy(), empty = await repo.list();
    // Even when no draft survives, a marker without a deletion tombstone is corruption.
    await rawDelete(databaseName, 'entries', id);
    let fullyMissingError = ''; try { await repo.migrateLegacy(); } catch (error) { fullyMissingError = error instanceof r.StorageError ? error.code : String(error); }
    await repo.close(); return { list, recovery, missingError, message, deleted, empty, fullyMissingError, legacyPreserved: localStorage.getItem(p.STORAGE_KEY) === text };
  }, moduleUrl);
  expect(result.list).toHaveLength(1);
  expect(result.list[0]).toMatchObject({ status: 'corrupt', generation: null });
  expect(result.recovery.project).toBeNull();
  expect(result.recovery.draft).not.toBeNull();
  expect(result.missingError).toBe('corrupt');
  expect(result.message).toContain('以前のデータは残して');
  expect(result.deleted).toEqual({ status: 'already-migrated', entry: null });
  expect(result.empty).toEqual([]);
  expect(result.fullyMissingError).toBe('corrupt');
  expect(result.legacyPreserved).toBe(true);
});

import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkspaceDraft } from '../../apps/web/src/projectRepository';

const fixtureUrl = `/@fs${resolve('tests/storage/browser.ts')}`;
const backupUrl = `/@fs${resolve('apps/web/src/workspaceBackup.ts')}`;

test.beforeEach(async ({ page }) => {
  await page.route('**/__guide_storage', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Native guide snapshot persistence test</title>' }));
  await page.goto('/__guide_storage');
});

test('an acquired guide survives later edits and browser reload; reading progress changes only draft storage, not the current design or records', async ({ page }) => {
  const databaseName = `guide-${randomUUID()}`;
  const before = await page.evaluate(async ({ fixtureUrl, databaseName }) => {
    const { repository: r, fixture, recordFor, applyDesignPatch } = await import(fixtureUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName });
    const acquired = await fixture('guide-pinned');
    // Synthetic fixture evidence is retained only to prove reading cannot add/remove records.
    acquired.records = [recordFor(acquired)];
    const old = acquired.document;
    const guide = { designId: old.designId, revision: old.revision, designHash: old.designHash, step: 2, document: old };
    const saved = await repo.save({ project: acquired, draft: { ...r.EMPTY_WORKSPACE_DRAFT, stage: 3, guide }, expectedGeneration: null });
    const current = { ...acquired, document: applyDesignPatch(old, { travelMm: 18 }) };
    const updated = await repo.save({ id: saved.id, project: current, draft: saved.draft, expectedGeneration: saved.generation });
    await repo.close(); return { old, current, guide, id: updated.id, generation: updated.generation };
  }, { fixtureUrl, databaseName });
  await page.reload();
  const after = await page.evaluate(async ({ fixtureUrl, databaseName, id }) => {
    const { repository: r, rawRead } = await import(fixtureUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName });
    const loaded = (await repo.load(id))!, originalBytes = await rawRead(databaseName, 'projects', id);
    const puts: string[] = [], nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { puts.push(this.name); return nativePut.apply(this, args); };
    let progress;
    try { progress = await repo.saveDraft(id, { ...loaded.draft, guide: { ...loaded.draft.guide!, step: 5 } }, loaded.generation); }
    finally { IDBObjectStore.prototype.put = nativePut; }
    const reread = (await repo.load(id))!, finalBytes = await rawRead(databaseName, 'projects', id);
    await repo.close(); return { loaded, progress, reread, puts, projectBytesUnchanged: originalBytes === finalBytes };
  }, { fixtureUrl, databaseName, id: before.id });
  expect(after.loaded.project).toEqual(before.current);
  expect(after.loaded.draft.guide).toEqual(before.guide);
  expect(after.loaded.project.document.revision).toBeGreaterThan(before.old.revision);
  expect(after.loaded.project.document.designHash).not.toBe(before.old.designHash);
  expect(after.reread.draft.guide).toEqual({ ...before.guide, step: 5 });
  expect(after.reread.project).toEqual(before.current);
  expect(after.reread.project.document.physicalValidation).toBe('unverified');
  expect(after.progress!.generation).toBe(before.generation + 1);
  expect(after.reread.project.document.revision).toBe(before.current.document.revision);
  expect(after.puts).toEqual(['entries', 'drafts']);
  expect(after.projectBytesUnchanged).toBe(true);
});

test('mismatched, tampered and foreign guide snapshots cannot overwrite an existing workspace', async ({ page }) => {
  const result = await page.evaluate(async fixtureUrl => {
    const { repository: r, fixture } = await import(fixtureUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName: `guide-${crypto.randomUUID()}` });
    const project = await fixture('guide-owner'), document = project.document;
    const guide = { designId: document.designId, revision: document.revision, designHash: document.designHash, step: 3, document };
    const saved = await repo.save({ project, draft: { ...r.EMPTY_WORKSPACE_DRAFT, guide }, expectedGeneration: null });
    const foreign = (await fixture('guide-foreign')).document;
    const tampered = structuredClone(document); tampered.parts[0]!.widthMm += 1;
    const cases = [
      { label: 'hash stamp mismatch', guide: { ...guide, designHash: '0'.repeat(64) } },
      { label: 'revision stamp mismatch', guide: { ...guide, revision: document.revision + 1 } },
      { label: 'noncanonical geometry', guide: { ...guide, document: tampered } },
      { label: 'another work', guide: { designId: foreign.designId, revision: foreign.revision, designHash: foreign.designHash, step: 3, document: foreign } },
      { label: 'null document is not an omitted snapshot', guide: { ...guide, document: null } },
    ];
    const outcomes: { label: string; code: string; unchanged: boolean }[] = [];
    for (const item of cases) {
      let code = '';
      try { await repo.saveDraft(saved.id, { ...saved.draft, guide: item.guide } as WorkspaceDraft, saved.generation); }
      catch (error) { code = error instanceof r.StorageError ? error.code : String(error); }
      outcomes.push({ label: item.label, code, unchanged: JSON.stringify(await repo.load(saved.id)) === JSON.stringify(saved) });
    }
    await repo.close(); return outcomes;
  }, fixtureUrl);
  expect(result).toHaveLength(5);
  for (const outcome of result) {
    expect(outcome.code, outcome.label).toBe('invalid');
    expect(outcome.unchanged, outcome.label).toBe(true);
  }
});

test('duplicating a work removes the acquired guide and physical evidence while retaining the original snapshot', async ({ page }) => {
  const result = await page.evaluate(async fixtureUrl => {
    const { repository: r, fixture, recordFor, applyDesignPatch } = await import(fixtureUrl) as typeof import('./browser');
    const repo = r.createProjectRepository({ databaseName: `guide-${crypto.randomUUID()}` });
    const source = await fixture('guide-copy-source', true), old = source.document;
    source.records = [recordFor(source)];
    source.document = applyDesignPatch(old, { travelMm: 18 });
    const draft = { ...r.EMPTY_WORKSPACE_DRAFT, guide: { designId: old.designId, revision: old.revision, designHash: old.designHash, step: 4, document: old }, recordDraft: recordFor(source) };
    const saved = await repo.save({ project: source, draft, expectedGeneration: null });
    const copy = await repo.duplicate(saved.id, saved.generation), reread = await repo.load(saved.id);
    await repo.close(); return { saved, copy, reread };
  }, fixtureUrl);
  expect(result.copy.project.document.designId).not.toBe(result.saved.project.document.designId);
  expect(result.copy.project.document.revision).toBe(1);
  expect(result.copy.project.records).toEqual([]);
  expect(result.copy.draft.guide).toBeUndefined(); expect(result.copy.draft.recordDraft).toBeUndefined();
  expect(result.copy.project.imageDataUrl).toBe(result.saved.project.imageDataUrl);
  expect(result.copy.project.backgroundImageDataUrl).toBe(result.saved.project.backgroundImageDataUrl);
  expect(result.reread).toEqual(result.saved);
});

test('a recovery backup carries the acquired snapshot and step separately from the newer project; foreign guides are rejected both ways', async ({ page }) => {
  const result = await page.evaluate(async ({ fixtureUrl, backupUrl }) => {
    const { repository: r, fixture, recordFor, applyDesignPatch, project: p } = await import(fixtureUrl) as typeof import('./browser');
    const backup = await import(backupUrl) as typeof import('../../apps/web/src/workspaceBackup');
    const acquired = await fixture('guide-backup', true), old = acquired.document;
    acquired.records = [recordFor(acquired)];
    const current = { ...acquired, document: applyDesignPatch(old, { travelMm: 18 }) };
    const guide = { designId: old.designId, revision: old.revision, designHash: old.designHash, step: 5, document: old };
    const draft = { ...r.EMPTY_WORKSPACE_DRAFT, stage: 3 as const, guide, numericDrafts: { travelMm: '' }, recordDraft: recordFor(acquired) };
    const text = await backup.serializeWorkspaceBackup(current, draft), resumed = await backup.parseWorkspaceFile(text);
    const repo = r.createProjectRepository({ databaseName: `guide-${crypto.randomUUID()}` });
    const stored = await repo.save({ project: resumed.project, draft: resumed.draft!, expectedGeneration: null });
    const reread = await repo.load(stored.id); await repo.close();
    const foreign = (await fixture('guide-backup-foreign')).document;
    const foreignDraft = { ...draft, guide: { designId: foreign.designId, revision: foreign.revision, designHash: foreign.designHash, step: 1, document: foreign } };
    const foreignText = JSON.stringify({ format: 'ugoku-kami-recovery', version: 1, project: JSON.parse(p.serializeProject(current)), draft: foreignDraft });
    const rejectMessage = async (action: () => Promise<unknown>) => { try { await action(); return ''; } catch (error) { return (error as Error).message; } };
    return { current, draft, resumed, reread, importIssue: await rejectMessage(() => backup.parseWorkspaceFile(foreignText)), exportIssue: await rejectMessage(() => backup.serializeWorkspaceBackup(current, foreignDraft)) };
  }, { fixtureUrl, backupUrl });
  expect(result.resumed.project).toEqual(result.current); expect(result.resumed.draft).toEqual(result.draft);
  expect(result.reread!.project).toEqual(result.current); expect(result.reread!.draft).toEqual(result.draft);
  expect(result.reread!.draft.guide!.document!.revision).toBeLessThan(result.reread!.project.document.revision);
  expect(result.importIssue).toContain('別の作品'); expect(result.exportIssue).toContain('別の作品');
});

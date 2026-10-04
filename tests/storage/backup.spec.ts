import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
const fixtureUrl = `/@fs${resolve('tests/storage/browser.ts')}`, backupUrl = `/@fs${resolve('apps/web/src/workspaceBackup.ts')}`;

test('recovery files preserve unfinished strings and old physical drafts separately; credentials never enter portable output', async ({ page }) => {
  await page.route('**/__backup', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Recovery file test</title>' }));
  await page.goto('/__backup');
  const result = await page.evaluate(async ({ fixtureUrl, backupUrl }) => {
    const f = await import(fixtureUrl) as typeof import('./browser');
    const b = await import(backupUrl) as typeof import('../../apps/web/src/workspaceBackup');
    const project = await f.fixture('backup-project', true), record = f.recordFor(project);
    const draft = { stage: 3 as const, zoom: 2 as const, view: 'back' as const, selection: null, selectionReady: false, numericDrafts: { travelMm: '', widthMm: 'not a number', token: 'secret-numeric' }, recordDraft: { ...record, token: 'secret-record' }, accessCode: 'secret-access', sessionToken: 'secret-session' };
    const text = await b.serializeWorkspaceBackup(project, draft);
    const resumed = await b.parseWorkspaceFile(text);
    return { text, resumed, project, record };
  }, { fixtureUrl, backupUrl });
  expect(result.text).not.toContain('secret-');
  expect(result.resumed.project).toEqual(result.project);
  expect(result.resumed.project.records).toHaveLength(0);
  expect(result.resumed.draft?.recordDraft).toEqual(result.record);
  expect(result.resumed.draft?.numericDrafts).toEqual({ travelMm: '', widthMm: 'not a number' });
  expect(result.resumed.draft?.selection).toBeNull();
  expect(result.resumed.draft?.selectionReady).toBe(false);
});

test('recovery import rejects cross-work physical drafts and combined payload overflow without promoting them', async ({ page }) => {
  await page.route('**/__backup', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' })); await page.goto('/__backup');
  const result = await page.evaluate(async ({ fixtureUrl, backupUrl }) => {
    const f = await import(fixtureUrl) as typeof import('./browser');
    const b = await import(backupUrl) as typeof import('../../apps/web/src/workspaceBackup');
    const project = await f.fixture('backup-owner'), foreign = f.recordFor(await f.fixture('foreign-owner'));
    const projectText = f.project.serializeProject(project);
    const text = JSON.stringify({ format: 'ugoku-kami-recovery', version: 1, project: JSON.parse(projectText), draft: { ...f.repository.EMPTY_WORKSPACE_DRAFT, recordDraft: foreign } });
    const rejected = async (action: () => Promise<unknown>) => { try { await action(); return ''; } catch (e) { return (e as Error).message; } };
    return { importIssue: await rejected(() => b.parseWorkspaceFile(text)), exportIssue: await rejected(() => b.serializeWorkspaceBackup(project, { ...f.repository.EMPTY_WORKSPACE_DRAFT, recordDraft: foreign })), oversized: await rejected(() => b.parseWorkspaceFile(' '.repeat(f.project.MAX_PROJECT_BYTES + 1))), standard: await b.parseWorkspaceFile(projectText), project };
  }, { fixtureUrl, backupUrl });
  expect(result.importIssue).toContain('別の作品'); expect(result.exportIssue).toContain('元の作品'); expect(result.oversized).toContain('45MB');
  expect(result.standard.project).toEqual(result.project); expect(result.standard.draft).toBeUndefined();
});

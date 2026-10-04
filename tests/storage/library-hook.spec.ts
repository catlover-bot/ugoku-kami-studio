import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const moduleUrl = `/@fs${resolve('tests/storage/browser.ts')}`, harnessUrl = `/@fs${resolve('tests/storage/hookHarness.tsx')}`;
async function boot(page: Page, setup?: () => Promise<void>) {
  await page.route('**/__hook_test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Native storage hook test</title><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>' }));
  await page.goto('/__hook_test');
  await setup?.();
  await page.evaluate(async harnessUrl => { await (await import(harnessUrl) as typeof import('./hookHarness')).mount(); }, harnessUrl);
  await expect(page.getByTestId('initializing')).toHaveText('false');
}
test('StrictMode leaves an untouched sample unsaved; debounced edits save once, while draft-only and animation do not rewrite images', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const puts: string[] = []; Object.assign(window, { storagePuts: puts });
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { puts.push(this.name); return original.apply(this, args); };
  });
  await page.waitForTimeout(700);
  await expect(page.getByTestId('status')).toHaveText('idle');
  await expect(page.getByTestId('count')).toHaveText('0');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '確定編集' }).click();
  await expect(page.getByTestId('status')).toHaveText('pending');
  await expect(page.getByTestId('status')).toHaveText('saved');
  const first = await page.evaluate(async () => {
    const h = window.storageHarness; const entry = await h.library.repository.load(h.library.activeId!); return { puts: (window as unknown as { storagePuts: string[] }).storagePuts.slice(), entry, lastSaved: h.library.lastSaved };
  });
  expect(first.puts.filter(store => store === 'projects')).toHaveLength(1);
  expect(first.entry!.project.document.input.travelMm).toBe(23);
  expect(first.entry!.project.document.revision).toBe(4);
  expect(first.lastSaved).toEqual({ revision: 4, designHash: first.entry!.project.document.designHash, generation: 1 });
  await page.getByRole('button', { name: '数値の途中' }).click();
  await expect(page.getByTestId('generation')).toHaveText('2');
  await page.evaluate(() => window.storageHarness.frames());
  await page.waitForTimeout(700);
  const second = await page.evaluate(async () => {
    const h = window.storageHarness; return { entry: await h.library.repository.load(h.library.activeId!), puts: (window as unknown as { storagePuts: string[] }).storagePuts };
  });
  expect(second.puts.filter(store => store === 'projects')).toHaveLength(1);
  expect(second.puts.filter(store => store === 'drafts')).toHaveLength(2);
  expect(second.entry!.draft.numericDrafts).toEqual({ travelMm: '2.' });
  expect(second.entry!.project.document).toEqual(first.entry!.project.document);
});

test('flush includes pending debounce and drains newer edits serially after an in-flight write', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const repo = window.storageHarness.library.repository, save = repo.save.bind(repo);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(window, { releaseWrite: release });
    let first = true;
    repo.save = async options => { if (first) { first = false; await gate; } return save(options); };
  });
  await page.getByRole('button', { name: '確定編集' }).click();
  await expect(page.getByTestId('status')).toHaveText('saving');
  await page.getByRole('button', { name: '確定編集' }).click();
  await page.getByRole('button', { name: '数値の途中' }).click();
  const result = await page.evaluate(async () => {
    const h = window.storageHarness; const flushing = h.library.flush();
    (window as unknown as { releaseWrite(): void }).releaseWrite();
    await flushing; return await h.library.repository.load('first-work');
  });
  expect(result!.generation).toBe(2);
  expect(result!.project.document.input.travelMm).toBe(22);
  expect(result!.draft.numericDrafts).toEqual({ travelMm: '2.' });
  await expect(page.getByTestId('status')).toHaveText('saved');
});

test('opening another work flushes the old draft first, and hydration does not create a spurious revision or save generation', async ({ page }) => {
  await boot(page);
  await page.evaluate(async moduleUrl => {
    const { fixture, repository: r } = await import(moduleUrl) as typeof import('./browser');
    const project = await fixture('existing-work', true);
    await window.storageHarness.library.repository.save({ project, draft: { ...r.EMPTY_WORKSPACE_DRAFT, stage: 3, zoom: 2, numericDrafts: { widthMm: '-' } }, expectedGeneration: null });
  }, moduleUrl);
  await page.getByRole('button', { name: '確定編集' }).click();
  await page.getByRole('button', { name: '数値の途中' }).click();
  await page.evaluate(() => window.storageHarness.open('existing-work'));
  await expect(page.getByTestId('id')).toHaveText('existing-work');
  await expect(page.getByTestId('status')).toHaveText('saved');
  await page.waitForTimeout(800);
  const result = await page.evaluate(async () => {
    const h = window.storageHarness; return { restored: h.project, draft: h.draft, old: await h.library.repository.load('first-work'), current: await h.library.repository.load('existing-work') };
  });
  expect(result.old!.draft.numericDrafts).toEqual({ travelMm: '2.' });
  expect(result.old!.project.document.input.travelMm).toBe(21);
  expect(result.current!.generation).toBe(1);
  expect(result.draft).toEqual(result.current!.draft);
  expect(result.restored).toEqual(result.current!.project);
});

test('quota failure retains editor and draft, blocks implicit switching, and explicit retry saves the retained snapshot', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: '確定編集' }).click();
  await page.evaluate(() => window.storageHarness.library.flush());
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put; Object.assign(window, { originalPut: original });
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'drafts') throw new DOMException('Synthetic refusal', 'QuotaExceededError'); return original.apply(this, args); };
  });
  await page.getByRole('button', { name: '数値の途中' }).click();
  await expect(page.getByTestId('status')).toHaveText('failed');
  const refused = await page.evaluate(async () => {
    const h = window.storageHarness; let rejected = false;
    try { await h.create(); } catch { rejected = true; }
    return { rejected, projectId: window.storageHarness.project.document.designId, draft: window.storageHarness.draft, saved: await h.library.repository.load('first-work'), lastSaved: h.library.lastSaved };
  });
  expect(refused.rejected).toBe(true);
  expect(refused.projectId).toBe('first-work');
  expect(refused.draft.numericDrafts).toEqual({ travelMm: '2.' });
  expect(refused.saved!.generation).toBe(1);
  expect(refused.lastSaved!.generation).toBe(1);
  await page.evaluate(async () => { IDBObjectStore.prototype.put = (window as unknown as { originalPut: typeof IDBObjectStore.prototype.put }).originalPut; await window.storageHarness.library.retry(); });
  await expect(page.getByTestId('status')).toHaveText('saved');
  await expect(page.getByTestId('generation')).toHaveText('2');
});

test('stale cross-tab generation becomes conflict and preserves the latest stored work and unsaved local draft', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: '確定編集' }).click();
  await page.evaluate(() => window.storageHarness.library.flush());
  await page.evaluate(async moduleUrl => {
    const { repository: r } = await import(moduleUrl) as typeof import('./browser');
    const other = r.createProjectRepository(); await other.rename('first-work', '他のタブの作品名', 1); await other.close();
  }, moduleUrl);
  await page.getByRole('button', { name: '数値の途中' }).click();
  await expect(page.getByTestId('status')).toHaveText('conflict');
  await expect(page.getByTestId('error')).toContainText('別のタブで更新');
  const result = await page.evaluate(async () => {
    const h = window.storageHarness; return { saved: await h.library.repository.load('first-work'), draft: h.draft, lastSaved: h.library.lastSaved };
  });
  expect(result.saved!.name).toBe('他のタブの作品名');
  expect(result.saved!.generation).toBe(2);
  expect(result.saved!.draft.numericDrafts).toBeUndefined();
  expect(result.draft.numericDrafts).toEqual({ travelMm: '2.' });
  expect(result.lastSaved!.generation).toBe(1);
});

for (const completion of ['success', 'failure'] as const) test(`an old delayed save ${completion} after explicit discard cannot change the new work's state`, async ({ page }) => {
  await boot(page);
  await page.evaluate(completion => {
    const repo = window.storageHarness.library.repository, save = repo.save.bind(repo);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(window, { releaseWrite: release }); let first = true;
    repo.save = async options => { if (first) { first = false; await gate; if (completion === 'failure') throw new DOMException('Synthetic old failure', 'QuotaExceededError'); } return save(options); };
  }, completion);
  await page.getByRole('button', { name: '確定編集' }).click();
  await expect(page.getByTestId('status')).toHaveText('saving');
  await page.evaluate(() => window.storageHarness.create(true, 'import-separate-entry'));
  await expect(page.getByTestId('id')).toHaveText('import-separate-entry');
  await expect(page.getByTestId('status')).toHaveText('pending');
  await page.evaluate(async () => { (window as unknown as { releaseWrite(): void }).releaseWrite(); await window.storageHarness.library.flush(); });
  await expect(page.getByTestId('status')).toHaveText('saved');
  await expect(page.getByTestId('error')).toHaveText('');
  const result = await page.evaluate(async () => {
    const h = window.storageHarness; return { id: h.library.activeId, projectId: h.project.document.designId, lastSaved: h.library.lastSaved, saved: await h.library.repository.load('import-separate-entry'), old: await h.library.repository.load('first-work') };
  });
  expect(result.id).toBe('import-separate-entry');
  expect(result.projectId).toBe('new-work');
  expect(result.saved!.project.document.designId).toBe('new-work');
  expect(result.lastSaved).toEqual({ revision: 1, designHash: result.saved!.project.document.designHash, generation: 1 });
  expect(!!result.old).toBe(completion === 'success');
});

test('a corrupt legacy entry does not block other listed works or explicit saving of an untouched sample', async ({ page }) => {
  await boot(page, async () => {
    await page.evaluate(async moduleUrl => {
      const { repository: r, project: p, fixture } = await import(moduleUrl) as typeof import('./browser');
      const repo = r.createProjectRepository(); await repo.save({ project: await fixture('good-previous'), draft: r.EMPTY_WORKSPACE_DRAFT, expectedGeneration: null }); await repo.close(); localStorage.setItem(p.STORAGE_KEY, '{broken');
    }, moduleUrl);
  });
  await expect(page.getByTestId('initialization-error')).not.toHaveText('');
  await expect(page.getByTestId('count')).toHaveText('1');
  await expect(page.getByTestId('status')).toHaveText('idle');
  await page.evaluate(() => window.storageHarness.library.flush({ force: true }));
  await expect(page.getByTestId('status')).toHaveText('saved');
  await expect(page.getByTestId('count')).toHaveText('2');
  expect(await page.evaluate(() => localStorage.getItem('ugoku-kami.project.v1'))).toBe('{broken');
});

test('the first committed render of an empty numeric draft is already pending, never the previous saved state', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: '確定編集' }).click();
  await page.evaluate(() => window.storageHarness.library.flush());
  await expect(page.getByTestId('status')).toHaveText('saved');
  await page.evaluate(() => {
    window.storageCommits = [];
    const h = window.storageHarness;
    h.setDraft({ ...h.draft, numericDrafts: { travelMm: '' } });
  });
  await expect.poll(() => page.evaluate(() => window.storageCommits.some(commit => commit.numeric === ''))).toBe(true);
  const first = await page.evaluate(() => window.storageCommits.find(commit => commit.numeric === ''));
  expect(first!.status).toBe('pending');
  await expect(page.getByTestId('status')).toHaveText('saved');
  const saved = await page.evaluate(() => window.storageHarness.library.repository.load('first-work'));
  expect(saved!.generation).toBe(2);
  expect(saved!.draft.numericDrafts).toEqual({ travelMm: '' });
  expect(saved!.project.document.input.travelMm).toBe(21);
});

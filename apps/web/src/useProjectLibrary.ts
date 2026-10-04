import { useCallback, useEffect, useRef, useState } from 'react';
import { createProjectRepository, RepositoryConflictError, type ProjectSummary, type StoredEntry, type WorkspaceDraft } from './projectRepository';
import type { Project } from './project';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'failed' | 'conflict';
export type SavedPoint = { revision: number; designHash: string; generation: number };
export type LibraryOptions = { project: Project; draft: WorkspaceDraft; enabled: boolean };
type Snapshot = LibraryOptions;
type Active = { id: string | null; generation: number | null; project: Project | null; draft: WorkspaceDraft | null };
const emptyActive = (): Active => ({ id: null, generation: null, project: null, draft: null });
const toError = (error: unknown): Error => error instanceof Error ? error : new Error('保存できませんでした。現在の編集を残して再試行できます。');
function sameRestoredProject(a: Project, b: Project): boolean {
  return a === b || (a.document.designId === b.document.designId && a.document.revision === b.document.revision && a.document.designHash === b.document.designHash && a.imageDataUrl === b.imageDataUrl && a.backgroundImageDataUrl === b.backgroundImageDataUrl && JSON.stringify(a.records) === JSON.stringify(b.records));
}

/**
 * Debounced browser persistence. The caller owns editor state and must memoize draft;
 * playback position, credentials, candidates and unaccepted AI results are not inputs.
 * load() flushes the old work; adopt() and startNew() guard the following React restore.
 */
export function useProjectLibrary({ project, draft, enabled }: LibraryOptions) {
  const [repository] = useState(() => createProjectRepository());
  const [entries, setEntries] = useState<ProjectSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [generation, setGeneration] = useState<number | null>(null);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [initializationError, setInitializationError] = useState<Error | null>(null);
  const [lastSaved, setLastSaved] = useState<SavedPoint | null>(null);
  const latest = useRef<Snapshot>({ project, draft, enabled }); latest.current = { project, draft, enabled };
  const active = useRef<Active>(emptyActive()), epoch = useRef(0), alive = useRef(false);
  const restoring = useRef<{ project: Project; draft: WorkspaceDraft; acknowledged: boolean } | null>(null);
  const blocked = useRef<Error | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const due = useRef(0), draining = useRef<Promise<void> | null>(null), forceDrain = useRef(false), forceEnabled = useRef(false);
  const initialization = useRef<Promise<void> | null>(null), refreshSequence = useRef(0);
  const drainRef = useRef<(force?: boolean, includeDisabled?: boolean) => Promise<void>>(() => Promise.resolve());

  const clearTimer = useCallback(() => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }, []);
  const hasChanges = useCallback(() => {
    const value = latest.current, saved = active.current;
    return value.project !== saved.project || value.draft !== saved.draft;
  }, []);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const values = await repository.list();
    if (alive.current && sequence === refreshSequence.current) setEntries(values);
    return values;
  }, [repository]);
  const schedule = useCallback(() => {
    clearTimer();
    if (!alive.current || restoring.current || blocked.current || !latest.current.enabled || !hasChanges()) return;
    timer.current = setTimeout(() => { timer.current = null; void drainRef.current().catch(() => { /* error is published by the transaction result */ }); }, Math.max(0, due.current - Date.now()));
  }, [clearTimer, hasChanges]);

  const drain = useCallback((force = false, includeDisabled = false): Promise<void> => {
    if (force) { forceDrain.current = true; clearTimer(); }
    if (includeDisabled) forceEnabled.current = true;
    if (blocked.current) return Promise.reject(blocked.current);
    if (draining.current) return draining.current;
    // Defer the body one microtask so the promise ref exists even when there is no write.
    const work = Promise.resolve().then(async () => {
      while (alive.current && !restoring.current && (latest.current.enabled || forceEnabled.current) && hasChanges()) {
        if (!forceDrain.current && Date.now() < due.current) break;
        const value = latest.current, target = { ...active.current }, scope = epoch.current;
        if (alive.current) { setStatus('saving'); setError(null); }
        try {
          const full = target.id === null || target.generation === null || target.project !== value.project;
          const result = full
            ? await repository.save({ ...(target.id ? { id: target.id } : {}), project: value.project, draft: value.draft, expectedGeneration: target.generation })
            : await repository.saveDraft(target.id!, value.draft, target.generation!);
          if (scope !== epoch.current) { void refresh().catch(() => {}); continue; }
          active.current = { id: result.id, generation: result.generation, project: value.project, draft: value.draft };
          if (alive.current) {
            setActiveId(result.id); setGeneration(result.generation);
            setLastSaved({ revision: value.project.document.revision, designHash: value.project.document.designHash, generation: result.generation! });
            setStatus(hasChanges() ? 'pending' : 'saved');
          }
          void refresh().catch(() => { /* Saved bytes are still committed if listing fails. */ });
        } catch (reason) {
          if (scope !== epoch.current) continue;
          const failure = toError(reason); blocked.current = failure;
          if (alive.current) { setError(failure); setStatus(failure instanceof RepositoryConflictError ? 'conflict' : 'failed'); }
          throw failure;
        }
      }
    }).finally(() => {
      if (draining.current === work) draining.current = null;
      forceDrain.current = false; forceEnabled.current = false;
      schedule();
    });
    draining.current = work;
    return work;
  }, [clearTimer, hasChanges, refresh, repository, schedule]);
  drainRef.current = drain;

  const flush = useCallback(async (options: { force?: boolean } = {}) => {
    if (restoring.current) throw new Error('作品を切り替えています。画面の復元後に保存してください。');
    if (!latest.current.enabled && !options.force) return;
    do { await drain(true, options.force === true); }
    while (alive.current && !restoring.current && (latest.current.enabled || options.force) && hasChanges());
  }, [drain, hasChanges]);
  const retry = useCallback(async () => { blocked.current = null; if (alive.current) setError(null); await flush({ force: true }); }, [flush]);

  const adopt = useCallback((entry: StoredEntry) => {
    // The caller reaches here only after flushing, or an explicit discard confirmation.
    epoch.current++; clearTimer(); blocked.current = null; forceDrain.current = false; forceEnabled.current = false;
    active.current = { id: entry.id, generation: entry.generation, project: entry.project, draft: entry.draft };
    restoring.current = { project: entry.project, draft: entry.draft, acknowledged: true };
    if (alive.current) {
      setActiveId(entry.id); setGeneration(entry.generation); setError(null); setStatus('saved');
      setLastSaved({ revision: entry.project.document.revision, designHash: entry.project.document.designHash, generation: entry.generation });
    }
  }, [clearTimer]);
  const startNew = useCallback(async (nextProject: Project, nextDraft: WorkspaceDraft, options: { discardUnsaved?: boolean; id?: string } = {}) => {
    if (!options.discardUnsaved) await flush();
    epoch.current++; clearTimer(); blocked.current = null; forceDrain.current = false; forceEnabled.current = false;
    active.current = { ...emptyActive(), id: options.id ?? null };
    restoring.current = { project: nextProject, draft: nextDraft, acknowledged: false };
    if (alive.current) { setActiveId(options.id ?? null); setGeneration(null); setLastSaved(null); setError(null); setStatus('idle'); }
  }, [clearTimer, flush]);
  const load = useCallback(async (id: string) => { await flush(); return repository.load(id); }, [flush, repository]);

  useEffect(() => {
    alive.current = true;
    // StrictMode's setup-cleanup-setup shares this promise: migration happens once per hook.
    initialization.current ??= (async () => {
      try { await repository.migrateLegacy(); }
      catch (reason) { if (alive.current) setInitializationError(toError(reason)); }
      try { await refresh(); }
      catch (reason) { if (alive.current) setInitializationError(toError(reason)); }
      finally { if (alive.current) setInitializing(false); }
    })();
    return () => {
      alive.current = false; clearTimer();
      void Promise.allSettled([initialization.current, draining.current]).then(() => { if (!alive.current) void repository.close().catch(() => {}); });
    };
  }, [clearTimer, refresh, repository]);

  useEffect(() => {
    const restore = restoring.current;
    if (restore) {
      // A restore may recreate the memoized draft object. Compare only during hydration,
      // never on animation frames or every autosave, and preserve unresolved numeric text.
      if (!sameRestoredProject(project, restore.project) || JSON.stringify(draft) !== JSON.stringify(restore.draft)) return;
      if (restore.acknowledged) active.current = { ...active.current, project, draft };
      restoring.current = null;
    }
    clearTimer();
    if (!enabled) { if (!blocked.current && !draining.current) setStatus(active.current.id && !hasChanges() ? 'saved' : 'idle'); return; }
    if (blocked.current) return;
    if (!hasChanges()) { if (active.current.id) setStatus('saved'); return; }
    due.current = Date.now() + 600;
    setStatus('pending');
    schedule();
  }, [project, draft, enabled, clearTimer, hasChanges, schedule]);

  // Effects run after a committed render. Do not expose the previous "saved" label
  // during the first render of a new edit, even before the debounce effect runs.
  const visibleStatus = !restoring.current && hasChanges() && (status === 'saved' || status === 'idle') ? (enabled ? 'pending' : 'idle') : status;
  return { repository, entries, activeId, generation, status: visibleStatus, error, initializing, initializationError, lastSaved, refresh, flush, retry, load, adopt, activate: adopt, startNew };
}

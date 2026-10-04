import { StrictMode, useLayoutEffect, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { applyDesignPatch } from '@ugoku/core';
import { useProjectLibrary } from '../../apps/web/src/useProjectLibrary';
import { EMPTY_WORKSPACE_DRAFT, type WorkspaceDraft } from '../../apps/web/src/projectRepository';
import type { Project } from '../../apps/web/src/project';
import { fixture } from './browser';

type Library = ReturnType<typeof useProjectLibrary>;
export type Harness = {
  library: Library; project: Project; draft: WorkspaceDraft; enabled: boolean;
  open(id: string): Promise<void>; create(discardUnsaved?: boolean, id?: string): Promise<void>;
  frames(): void; setProject(value: Project): void; setDraft(value: WorkspaceDraft): void;
};
declare global { interface Window { storageHarness: Harness; storageRoot: Root; storageCommits: { status: string; numeric: string | null }[] } }
function Workbench({ initial }: { initial: Project }) {
  const [project, setProject] = useState(initial), [rawDraft, setDraft] = useState<WorkspaceDraft>({ ...EMPTY_WORKSPACE_DRAFT });
  const [enabled, setEnabled] = useState(false), [frame, setFrame] = useState(0);
  const draft = useMemo(() => ({ ...rawDraft }), [rawDraft]);
  const library = useProjectLibrary({ project, draft, enabled });
  useLayoutEffect(() => {
    window.storageCommits ??= [];
    window.storageCommits.push({ status: library.status, numeric: draft.numericDrafts?.travelMm ?? null });
    window.storageHarness = {
      library, project, draft, enabled, setProject, setDraft,
      frames: () => { for (let i = 0; i < 30; i++) setFrame(previous => previous + 1); },
      open: async id => { const entry = await library.load(id); if (!entry) throw new Error('missing fixture'); library.adopt(entry); setProject(entry.project); setDraft({ ...entry.draft }); setEnabled(true); },
      create: async (discardUnsaved = false, id) => {
        const next = await fixture('new-work'); const nextDraft = { ...EMPTY_WORKSPACE_DRAFT };
        await library.startNew(next, nextDraft, { discardUnsaved, id }); setProject(next); setDraft(nextDraft); setEnabled(true);
      },
    };
  });
  return <main>
    <output data-testid="status">{library.status}</output><output data-testid="id">{library.activeId ?? 'none'}</output>
    <output data-testid="generation">{library.generation ?? 0}</output><output data-testid="count">{library.entries.length}</output>
    <output data-testid="initializing">{String(library.initializing)}</output><output data-testid="initialization-error">{library.initializationError?.message ?? ''}</output>
    <output data-testid="error">{library.error?.message ?? ''}</output><output data-testid="frame">{frame}</output>
    <button onClick={() => { setEnabled(true); setProject(previous => ({ ...previous, document: applyDesignPatch(previous.document, { travelMm: previous.document.input.travelMm + 1 }) })); }}>確定編集</button>
    <button onClick={() => { setEnabled(true); setDraft(previous => ({ ...previous, stage: 2, numericDrafts: { travelMm: '2.' } })); }}>数値の途中</button>
    <button onClick={() => { setEnabled(true); setDraft(previous => ({ ...previous, view: 'back' })); }}>裏面を見る</button>
  </main>;
}
export async function mount() {
  const initial = await fixture('first-work');
  const node = document.createElement('div'); document.body.append(node);
  window.storageRoot = createRoot(node); window.storageRoot.render(<StrictMode><Workbench initial={initial} /></StrictMode>);
}

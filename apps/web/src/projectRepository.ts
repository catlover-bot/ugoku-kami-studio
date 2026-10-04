import { z } from 'zod';
import { createDesign, type Rect } from '@ugoku/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { STORAGE_KEY, MAX_PROJECT_BYTES, decodeImage, parseProject, serializeProject, physicalRecordSchema, verifyDataImage, type PhysicalRecord, type Project } from './project';

export const PROJECT_DATABASE_NAME = 'ugoku-kami.workspaces.v1';
const STORES = ['entries', 'projects', 'drafts', 'migrations'] as const;
const numericKeys = ['travelMm', 'widthMm', 'heightMm', 'maxSheets', 'paperThicknessMm', 'clearanceMm', 'selection.x', 'selection.y', 'selection.width', 'selection.height'] as const;
const stampSchema = z.object({ designId: z.string().max(100), revision: z.number().int().positive(), designHash: z.string().max(150) });
const draftSchema = z.object({
  stage: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  zoom: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).default(1),
  view: z.enum(['front', 'back', 'original', 'print']).default('front'),
  selection: z.object({ x: z.number().finite().min(-8192).max(8192), y: z.number().finite().min(-8192).max(8192), width: z.number().finite().min(0).max(8192), height: z.number().finite().min(0).max(8192) }).nullable().default(null),
  numericDrafts: z.object(Object.fromEntries(numericKeys.map(key => [key, z.string().max(128).optional()]))).optional(),
  numericBase: stampSchema.optional(),
  recordDraft: physicalRecordSchema.strip().optional(),
  editing: z.boolean().optional(),
  selectionReady: z.boolean().optional(),
  selectionMode: z.enum(['drag', 'corners']).optional(),
  helper: z.enum(['manual', 'ai']).optional(),
  requestText: z.string().max(4000).optional(),
  guide: stampSchema.extend({ step: z.number().int().min(1).max(100) }).optional(),
});
/** Recovery only. These values are never added to a validated Project or sent to AI. */
export type WorkspaceDraft = {
  stage: 1 | 2 | 3; zoom: 1 | 1.5 | 2; view: 'front' | 'back' | 'original' | 'print'; selection: Rect | null;
  numericDrafts?: Partial<Record<typeof numericKeys[number], string>>;
  numericBase?: { designId: string; revision: number; designHash: string };
  recordDraft?: PhysicalRecord; editing?: boolean; selectionReady?: boolean;
  selectionMode?: 'drag' | 'corners'; helper?: 'manual' | 'ai'; requestText?: string;
  guide?: { designId: string; revision: number; designHash: string; step: number };
};
export const EMPTY_WORKSPACE_DRAFT: WorkspaceDraft = { stage: 1, zoom: 1, view: 'front', selection: null };
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const nameSchema = z.string().trim().min(1).max(120);
const metadataSchema = z.object({
  version: z.literal(1), id: idSchema, name: nameSchema, generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.string().datetime(), thumbnail: z.string().max(300_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
  designId: z.string(), revision: z.number().int().positive(), designHash: z.string(), projectBytes: z.number().int().positive().max(MAX_PROJECT_BYTES),
}).strict();
type Metadata = z.infer<typeof metadataSchema>;
export type ProjectSummary = Pick<Metadata, 'id' | 'name' | 'updatedAt' | 'thumbnail'> & {
  generation: number | null; status: 'ready' | 'corrupt'; issue?: string;
  designId?: string; revision?: number; designHash?: string;
};
export type StoredEntry = Metadata & { project: Project; draft: WorkspaceDraft };
export type StorageErrorCode = 'unavailable' | 'blocked' | 'denied' | 'quota' | 'corrupt' | 'invalid' | 'not-found' | 'unknown';
export class StorageError extends Error {
  constructor(public readonly code: StorageErrorCode, message: string, options?: ErrorOptions) { super(message, options); this.name = 'StorageError'; }
}
export class RepositoryConflictError extends Error {
  constructor(public readonly id: string, public readonly expectedGeneration: number | null, public readonly actualGeneration: number | null) {
    super('別のタブで更新されています。最新版を開くか、現在の編集を別の作品として残してください。'); this.name = 'RepositoryConflictError';
  }
}
export type SaveProjectOptions = { id?: string; project: Project; draft: WorkspaceDraft; name?: string; expectedGeneration: number | null };
export type RecoveryResult = { id: string; project: Project | null; draft: WorkspaceDraft | null; issues: string[] };
export type MigrationResult = { status: 'none' | 'migrated' | 'already-migrated'; entry: StoredEntry | null };

type Raw = { metadata: unknown; project: unknown; draft: unknown };
function object(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}; }
function generation(value: unknown): number | null { const n = object(value).generation; return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null; }
function deleted(value: unknown): boolean { return object(value).deleted === true && generation(value) !== null; }
function summary(meta: Metadata): ProjectSummary { const { id, name, generation, updatedAt, thumbnail, designId, revision, designHash } = meta; return { id, name, generation, updatedAt, thumbnail, designId, revision, designHash, status: 'ready' }; }
function storageError(error: unknown): Error {
  if (error instanceof StorageError || error instanceof RepositoryConflictError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError') return new StorageError('quota', 'このブラウザの保存容量が足りません。編集中の内容をファイルに書き出すか、不要な作品を整理してください。', { cause: error });
  if (name === 'SecurityError' || name === 'NotAllowedError') return new StorageError('denied', 'このブラウザで保存が許可されていません。現在の作品はファイルに書き出せます。', { cause: error });
  return new StorageError('unknown', '保存領域を読み書きできませんでした。現在の編集を残したまま、再試行するかファイルに書き出してください。', { cause: error });
}
function invalid(error: unknown): StorageError { return new StorageError('invalid', error instanceof Error && error.name !== 'ZodError' ? error.message : '保存する作品または下書きの形式を確認してください。', { cause: error }); }
function bytes(text: string): number { return new TextEncoder().encode(text).byteLength; }
export async function validateWorkspaceDraft(value: unknown): Promise<WorkspaceDraft> {
  // Zod's object whitelist strips unknown fields at every level, including credentials.
  const draft = draftSchema.parse(value) as WorkspaceDraft;
  if (bytes(JSON.stringify(draft)) > MAX_PROJECT_BYTES) throw new Error('復元用の下書きは45MBまでです。写真を減らしてください。');
  for (const photo of draft.recordDraft?.photos ?? []) await verifyDataImage(photo);
  return draft;
}
function assertDraftOwner(draft: WorkspaceDraft, designId: string) {
  if (draft.recordDraft?.designId && draft.recordDraft.designId !== designId) throw new StorageError('invalid', '実物記録の下書きは、元の作品に保存してください。');
}
async function thumbnail(dataUrl: string): Promise<string> {
  const image = await decodeImage(dataUrl);
  const scale = Math.min(1, 200 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new StorageError('unavailable', '作品のサムネイルを作れませんでした。もう一度保存してください。');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/** Native IndexedDB; no network, localStorage fallback, or automatic eviction. */
export class ProjectRepository {
  private connection: Promise<IDBDatabase> | null = null;
  constructor(private readonly databaseName = PROJECT_DATABASE_NAME) {}
  private open(): Promise<IDBDatabase> {
    if (this.connection) return this.connection;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        const factory = globalThis.indexedDB;
        if (!factory) { reject(new StorageError('unavailable', 'このブラウザでは作品の保存領域が使えません。ファイルに書き出せます。')); return; }
        request = factory.open(this.databaseName, 1);
      } catch (error) { reject(storageError(error)); return; }
      let blocked = false;
      request.onupgradeneeded = () => { for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name); };
      request.onerror = () => reject(storageError(request.error));
      request.onblocked = () => { blocked = true; reject(new StorageError('blocked', '別のタブが保存領域を使用しています。他のタブを閉じて再試行してください。')); };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => { db.close(); this.connection = null; };
        db.onclose = () => { this.connection = null; };
        resolve(db);
      };
    });
    this.connection = pending;
    void pending.catch(() => { if (this.connection === pending) this.connection = null; });
    return pending;
  }
  async close(): Promise<void> { const connection = this.connection; this.connection = null; if (connection) (await connection).close(); }

  /**
   * Enqueue mutations from request callbacks; image decoding finishes before this transaction.
   * Overlapping readwrite scopes are serialized by IndexedDB, so the generation read and put
   * form one CAS even across tabs. Resolve only on complete, never on request success.
   * W3C IndexedDB §2.7.1–2.7.2, checked 2026-10-04: https://www.w3.org/TR/IndexedDB-3/#transaction-scheduling
   */
  private async transaction<T>(mode: IDBTransactionMode, stores: readonly string[], operation: (tx: IDBTransaction, done: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction([...stores], mode, mode === 'readwrite' ? { durability: 'strict' } : undefined); } catch (error) { reject(storageError(error)); return; }
      let result: T, completed = false, failure: unknown;
      const fail = (error: unknown) => { failure = error; try { tx.abort(); } catch { reject(storageError(error)); } };
      tx.oncomplete = () => { if (completed) resolve(result); else reject(new StorageError('unknown', '保存処理を完了できませんでした。')); };
      tx.onabort = () => reject(storageError(failure ?? tx.error));
      tx.onerror = () => { failure ??= tx.error; };
      try { operation(tx, value => { result = value; completed = true; }, fail); } catch (error) { fail(error); }
    });
  }
  private async read(id: string): Promise<Raw> {
    return this.transaction('readonly', ['entries', 'projects', 'drafts'], (tx, done) => {
      const out: Raw = { metadata: undefined, project: undefined, draft: undefined }; let remaining = 3;
      for (const [store, key] of [['entries', 'metadata'], ['projects', 'project'], ['drafts', 'draft']] as const) {
        const request = tx.objectStore(store).get(id);
        request.onsuccess = () => { out[key] = request.result; if (--remaining === 0) done(out); };
      }
    });
  }
  async list(): Promise<ProjectSummary[]> {
    return this.transaction('readonly', ['entries', 'projects', 'drafts'], (tx, done) => {
      const entries = tx.objectStore('entries').getAll(), keys = tx.objectStore('entries').getAllKeys(), projects = tx.objectStore('projects').getAllKeys(), drafts = tx.objectStore('drafts').getAllKeys();
      let remaining = 4;
      const ready = () => {
        if (--remaining) return;
        const projectIds = new Set(projects.result.map(String));
        const result: ProjectSummary[] = [];
        entries.result.forEach((value: unknown, index: number) => {
          if (deleted(value)) return;
          const id = String(keys.result[index]);
          const parsed = metadataSchema.safeParse(value);
          if (parsed.success && parsed.data.id === id && projectIds.has(id)) result.push(summary(parsed.data));
          else result.push({ id, name: typeof object(value).name === 'string' ? String(object(value).name).slice(0, 120) : '復元が必要な作品', generation: generation(value), updatedAt: '', thumbnail: '', status: 'corrupt', issue: 'この作品の保存情報を読み取れません。復元できる内容を確認するか、この作品だけを削除できます。' });
        });
        const known = new Set(keys.result.map(String));
        for (const id of new Set([...projectIds, ...drafts.result.map(String)])) if (!known.has(id)) result.push({ id, name: '復元が必要な作品', generation: null, updatedAt: '', thumbnail: '', status: 'corrupt', issue: '作品名と保存世代の情報がありません。設計や下書きを復元できるか確認してください。' });
        done(result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)));
      };
      entries.onsuccess = ready; keys.onsuccess = ready; projects.onsuccess = ready; drafts.onsuccess = ready;
    });
  }
  async load(id: string): Promise<StoredEntry | null> {
    const raw = await this.read(id);
    if (deleted(raw.metadata) || (raw.metadata === undefined && raw.project === undefined && raw.draft === undefined)) return null;
    try {
      const meta = metadataSchema.parse(raw.metadata);
      if (meta.id !== id || typeof raw.project !== 'string') throw new Error('保存された作品が見つかりません。');
      const project = await parseProject(raw.project), draft = await validateWorkspaceDraft(raw.draft ?? EMPTY_WORKSPACE_DRAFT);
      if (project.document.designId !== meta.designId || project.document.revision !== meta.revision || project.document.designHash !== meta.designHash) throw new Error('作品の保存情報と設計版が一致しません。');
      assertDraftOwner(draft, project.document.designId);
      return { ...meta, project, draft };
    } catch (error) { throw new StorageError('corrupt', 'この作品の一部を読み取れません。復元できる内容を確認してください。他の作品はそのまま残っています。', { cause: error }); }
  }
  async recover(id: string): Promise<RecoveryResult> {
    const raw = await this.read(id), result: RecoveryResult = { id, project: null, draft: null, issues: [] };
    if (deleted(raw.metadata) || (raw.metadata === undefined && raw.project === undefined && raw.draft === undefined)) throw new StorageError('not-found', 'この作品は見つかりません。');
    try { if (typeof raw.project !== 'string') throw new Error(); result.project = await parseProject(raw.project); } catch { result.issues.push('設計と画像を復元できません。元のバックアップファイルから読み込めます。'); }
    try { result.draft = await validateWorkspaceDraft(raw.draft ?? EMPTY_WORKSPACE_DRAFT); if (result.project) assertDraftOwner(result.draft, result.project.document.designId); }
    catch { result.draft = null; result.issues.push('復元用の下書きを読み取れません。検証できた設計と下書きだけを別作品として保存できます。'); }
    const meta = metadataSchema.safeParse(raw.metadata);
    if (!meta.success) result.issues.push('作品名や保存世代の情報が壊れています。元の作品を上書きせずに復元してください。');
    else if (meta.data.id !== id || (result.project && (meta.data.designId !== result.project.document.designId || meta.data.revision !== result.project.document.revision || meta.data.designHash !== result.project.document.designHash))) result.issues.push('保存情報と設計版が一致しません。検証できた設計を別作品として復元してください。');
    return result;
  }
  private compare(id: string, current: unknown, expected: number | null, creating = false): number {
    const exists = current !== undefined && !deleted(current), actual = exists ? generation(current) : null;
    if (creating ? exists || expected !== null : !exists || actual !== expected) throw new RepositoryConflictError(id, expected, actual);
    const next = (generation(current) ?? 0) + 1;
    if (!Number.isSafeInteger(next)) throw new StorageError('invalid', '保存世代の上限です。別作品として保存してください。');
    return next;
  }
  save(options: SaveProjectOptions): Promise<StoredEntry> { return this.persist(options); }
  private async persist(options: SaveProjectOptions, source?: { id: string; generation: number }): Promise<StoredEntry> {
    let project: Project, draft: WorkspaceDraft, text: string, preview: string, id: string, name: string | undefined;
    try {
      id = idSchema.parse(options.id ?? options.project.document.designId);
      name = options.name === undefined ? undefined : nameSchema.parse(options.name);
      text = serializeProject(options.project); project = await parseProject(text);
      draft = await validateWorkspaceDraft(options.draft); assertDraftOwner(draft, project.document.designId);
      preview = await thumbnail(project.imageDataUrl);
    } catch (error) { throw invalid(error); }
    return this.transaction('readwrite', ['entries', 'projects', 'drafts'], (tx, done, fail) => {
      const entries = tx.objectStore('entries'), request = entries.get(id);
      request.onsuccess = () => {
        const write = () => { try {
          const next = this.compare(id, request.result, options.expectedGeneration, options.expectedGeneration === null);
          const previous = metadataSchema.safeParse(request.result);
          const meta: Metadata = metadataSchema.parse({ version: 1, id, name: name ?? (previous.success ? previous.data.name : project.document.input.title.slice(0, 120) || '名前のない作品'), generation: next, updatedAt: new Date().toISOString(), thumbnail: preview, designId: project.document.designId, revision: project.document.revision, designHash: project.document.designHash, projectBytes: bytes(text) });
          if (previous.success && previous.data.designId !== project.document.designId) throw new StorageError('invalid', '別の作品は新しい保存先に保存してください。');
          entries.put(meta, id); tx.objectStore('projects').put(text, id); tx.objectStore('drafts').put(draft, id);
          done({ ...meta, project, draft });
        } catch (error) { fail(error); }
        };
        if (source) {
          const original = entries.get(source.id);
          original.onsuccess = () => {
            try { this.compare(source.id, original.result, source.generation); write(); }
            catch (error) { fail(error); }
          };
        } else write();
      };
    });
  }
  async saveDraft(id: string, value: WorkspaceDraft, expectedGeneration: number): Promise<ProjectSummary> {
    let draft: WorkspaceDraft;
    try { draft = await validateWorkspaceDraft(value); } catch (error) { throw invalid(error); }
    return this.transaction('readwrite', ['entries', 'drafts'], (tx, done, fail) => {
      const entries = tx.objectStore('entries'), request = entries.get(id);
      request.onsuccess = () => {
        try {
          const next = this.compare(id, request.result, expectedGeneration), previous = metadataSchema.parse(request.result);
          assertDraftOwner(draft, previous.designId);
          const meta = { ...previous, generation: next, updatedAt: new Date().toISOString() };
          entries.put(meta, id); tx.objectStore('drafts').put(draft, id); done(summary(meta));
        } catch (error) { fail(error instanceof z.ZodError ? new StorageError('corrupt', '保存情報が壊れています。別作品への復元をお試しください。') : error); }
      };
    });
  }
  async rename(id: string, name: string, expectedGeneration: number): Promise<ProjectSummary> {
    let clean: string; try { clean = nameSchema.parse(name); } catch (error) { throw invalid(error); }
    return this.transaction('readwrite', ['entries'], (tx, done, fail) => {
      const store = tx.objectStore('entries'), request = store.get(id);
      request.onsuccess = () => {
        try {
          const next = this.compare(id, request.result, expectedGeneration), previous = metadataSchema.parse(request.result);
          const meta = { ...previous, name: clean, generation: next, updatedAt: new Date().toISOString() };
          store.put(meta, id); done(summary(meta));
        } catch (error) { fail(error instanceof z.ZodError ? new StorageError('corrupt', '保存情報が壊れています。別作品への復元をお試しください。') : error); }
      };
    });
  }
  async delete(id: string, expectedGeneration: number | null): Promise<void> {
    return this.transaction('readwrite', ['entries', 'projects', 'drafts'], (tx, done, fail) => {
      const entries = tx.objectStore('entries'), request = entries.get(id);
      request.onsuccess = () => {
        if (request.result === undefined && expectedGeneration === null) {
          const orphan = tx.objectStore('projects').getKey(id), draft = tx.objectStore('drafts').getKey(id);
          let remaining = 2;
          const remove = () => {
            if (--remaining) return;
            try {
              if (orphan.result === undefined && draft.result === undefined) throw new RepositoryConflictError(id, expectedGeneration, null);
              entries.put({ version: 1, id, generation: 1, deleted: true }, id);
              tx.objectStore('projects').delete(id); tx.objectStore('drafts').delete(id); done(undefined);
            } catch (error) { fail(error); }
          };
          orphan.onsuccess = remove; draft.onsuccess = remove;
          return;
        }
        try {
          const next = this.compare(id, request.result, expectedGeneration);
          // Retain a tiny tombstone so delete/recreate never reuses an old generation.
          entries.put({ version: 1, id, generation: next, deleted: true }, id);
          tx.objectStore('projects').delete(id); tx.objectStore('drafts').delete(id); done(undefined);
        } catch (error) { fail(error); }
      };
    });
  }
  async duplicate(id: string, expectedGeneration: number, name?: string): Promise<StoredEntry> {
    const source = await this.load(id);
    if (!source || source.generation !== expectedGeneration) throw new RepositoryConflictError(id, expectedGeneration, source?.generation ?? null);
    const document = createDesign(source.project.document.input, { designId: crypto.randomUUID(), revision: 1 });
    const { recordDraft: _record, numericDrafts: _numbers, numericBase: _base, guide: _guide, ...draft } = source.draft;
    const entry = await this.persist({ project: { ...source.project, document, records: [] }, draft, name: name ?? `${source.name.slice(0, 116)} の複製`, expectedGeneration: null }, { id, generation: expectedGeneration });
    return entry;
  }
  async migrateLegacy(storage?: Pick<Storage, 'getItem'>): Promise<MigrationResult> {
    let text: string | null;
    try { text = (storage ?? globalThis.localStorage).getItem(STORAGE_KEY); } catch (error) { throw storageError(error); }
    if (!text) return { status: 'none', entry: null };
    let project: Project, canonical: string, preview: string;
    try { project = await parseProject(text); canonical = serializeProject(project); preview = await thumbnail(project.imageDataUrl); }
    catch (error) { throw new StorageError('corrupt', '以前の保存作品を読み込めませんでした。以前のデータは変更せず残しています。', { cause: error }); }
    const fingerprint = bytesToHex(sha256(new TextEncoder().encode(text))), id = `legacy-${fingerprint.slice(0, 40)}`;
    const migrated = await this.transaction<boolean>('readwrite', STORES, (tx, done, fail) => {
      const markers = tx.objectStore('migrations'), marker = markers.get(fingerprint);
      marker.onsuccess = () => {
        if (marker.result !== undefined) { done(false); return; }
        const entries = tx.objectStore('entries'), existing = entries.get(id);
        existing.onsuccess = () => {
          try {
            const next = this.compare(id, existing.result, null, true);
            const meta = metadataSchema.parse({ version: 1, id, name: project.document.input.title.slice(0, 120) || '以前の作品', generation: next, updatedAt: new Date().toISOString(), thumbnail: preview, designId: project.document.designId, revision: project.document.revision, designHash: project.document.designHash, projectBytes: bytes(canonical) });
            entries.put(meta, id); tx.objectStore('projects').put(canonical, id); tx.objectStore('drafts').put(EMPTY_WORKSPACE_DRAFT, id);
            markers.put({ id }, fingerprint); done(true);
          } catch (error) { fail(error); }
        };
      };
    });
    // Re-read and validate the actual committed bytes. Never delete or change legacy data.
    let entry: StoredEntry | null;
    try { entry = await this.load(id); }
    catch (error) { throw new StorageError('corrupt', '移行済みの作品の一部を読み取れません。以前のデータは残しています。復元できる内容を確認するか、バックアップから読み込んでください。', { cause: error }); }
    if (!entry && !deleted((await this.read(id)).metadata)) throw new StorageError('corrupt', '移行済みの作品が見つかりません。以前のデータは残しています。バックアップから別作品として復元してください。');
    return { status: migrated ? 'migrated' : 'already-migrated', entry };
  }
}
export function createProjectRepository(options: { databaseName?: string } = {}): ProjectRepository { return new ProjectRepository(options.databaseName); }

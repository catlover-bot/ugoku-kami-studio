/** Browser-only fixtures: real canvas PNGs and real IndexedDB, no storage polyfill. */
import { applyArtworkRepair, applyDesignPatch, createDesign, SAMPLE_INPUT } from '@ugoku/core';
import * as repository from '../../apps/web/src/projectRepository';
import * as project from '../../apps/web/src/project';
export { repository, project, applyDesignPatch };
export async function fixture(id = 'one', background = false): Promise<project.Project> {
  const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 550;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#d4f0db'; context.fillRect(0, 0, 800, 550);
  context.fillStyle = '#264f35'; context.fillRect(290, 165, 160, 90);
  const imageDataUrl = canvas.toDataURL('image/png');
  let documentValue = createDesign({ ...SAMPLE_INPUT, image: { ...SAMPLE_INPUT.image, id: project.imageContentId(imageDataUrl) } }, { designId: id });
  if (!background) return { document: documentValue, imageDataUrl, records: [] };
  context.fillStyle = '#f4a723'; context.fillRect(0, 0, 800, 550);
  const backgroundImageDataUrl = canvas.toDataURL('image/png');
  documentValue = applyArtworkRepair(documentValue, { mode: 'image', image: { ...documentValue.input.image, id: project.imageContentId(backgroundImageDataUrl) } });
  return { document: documentValue, imageDataUrl, backgroundImageDataUrl, records: [] };
}
export function recordFor(value: project.Project): project.PhysicalRecord {
  return project.physicalRecordSchema.parse({ id: 'physical-one', designId: value.document.designId, designHash: value.document.designHash, revision: value.document.revision, pattern: 'original-pattern.pdf', material: '実際の厚紙', printScale: '100%', measuredLine: '50', modifications: '', movement: '', photos: [] });
}
export async function rawWrite(name: string, store: string, key: string, value: unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); }
  finally { db.close(); }
}
export async function rawRead(name: string, store: string, key: string): Promise<unknown> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try { return await new Promise((resolve, reject) => { const tx = db.transaction(store), request = tx.objectStore(store).get(key); let value: unknown; request.onsuccess = () => { value = request.result; }; tx.oncomplete = () => resolve(value); tx.onabort = () => reject(tx.error); }); }
  finally { db.close(); }
}
export async function rawDelete(name: string, store: string, key: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); }
  finally { db.close(); }
}

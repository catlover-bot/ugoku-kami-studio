import { useRef, useState, type KeyboardEvent } from 'react';
import type { DesignDocument, DesignPatch, Rect } from '@ugoku/core';

export type NumericKey = 'travelMm' | 'widthMm' | 'heightMm' | 'maxSheets' | 'paperThicknessMm' | 'clearanceMm' | `selection.${keyof Rect}`;
type Draft = { text: string; base: string; error?: string };
export type NumericDraftMap = Partial<Record<NumericKey, Draft>>;
export const designStamp = (doc: DesignDocument) => `${doc.designId}:${doc.revision}:${doc.designHash}`;

/** Strings stay outside DesignDocument until an explicit input transaction. */
export function useNumericDrafts(document: DesignDocument, apply: (patch: DesignPatch) => string | null) {
  const [drafts, setDrafts] = useState<NumericDraftMap>({});
  const ref = useRef(drafts); ref.current = drafts;
  const current = useRef({ document, apply }); current.current = { document, apply };
  function update(next: NumericDraftMap) { ref.current = next; setDrafts(next); }
  function discard(key?: NumericKey) {
    const next = { ...ref.current }; if (key) delete next[key];
    update(key ? next : {});
  }
  function change(key: NumericKey, text: string) {
    update({ ...ref.current, [key]: { text, base: designStamp(current.current.document) } });
  }
  function commit(key?: NumericKey): boolean {
    const entries = Object.entries(ref.current).filter(([name]) => !key || name === key) as [NumericKey, Draft][];
    if (!entries.length) return true;
    const patch: DesignPatch = {}, next = { ...ref.current };
    let invalid = false;
    for (const [name, draft] of entries) {
      let error = '';
      if (draft.base !== designStamp(current.current.document)) error = '設計が更新されました。入力し直すか、Escapeで現在の確定値に戻してください。';
      const raw = draft.text.trim();
      if (!error && !raw) error = '数値を入力してください。Escapeで確定値に戻せます。';
      if (!error && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) || !Number.isFinite(Number(raw)))) error = '半角の数値で入力してください。';
      if (error) { next[name] = { ...draft, error }; invalid = true; continue; }
      if (name.startsWith('selection.')) patch.selection = { ...(patch.selection ?? current.current.document.input.selection), [name.slice(10)]: Number(raw) };
      else Object.assign(patch, { [name]: Number(raw) });
    }
    if (invalid) { update(next); return false; }
    // Remove the committed strings before notifying React. Enter's following
    // blur observes the ref synchronously and cannot create a second revision.
    for (const [name] of entries) delete next[name];
    const issue = current.current.apply(patch);
    if (issue) {
      for (const [name, draft] of entries) next[name] = { ...draft, error: issue };
      update(next); return false;
    }
    update(next); return true;
  }
  return { drafts, ref, change, commit, discard, restore: (values: Partial<Record<NumericKey, string>>) => update(Object.fromEntries(Object.entries(values).map(([key, text]) => [key, { text, base: designStamp(current.current.document) }]))), hasDrafts: Object.keys(drafts).length > 0 };
}

export type NumericController = ReturnType<typeof useNumericDrafts>;
export function DraftNumberInput({ controller, field, value, label, disabled = false }: { controller: NumericController; field: NumericKey; value: number; label: string; disabled?: boolean }) {
  const composing = useRef(false), draft = controller.drafts[field];
  const id = `number-${field.replace('.', '-')}`, errorId = `${id}-error`;
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') { event.preventDefault(); controller.commit(field); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); controller.discard(field); }
  }
  return <span className="draft-number"><input id={id} type="text" inputMode="decimal" autoComplete="off" aria-label={label} disabled={disabled} value={draft?.text ?? String(value)} aria-invalid={!!draft?.error} aria-describedby={draft?.error ? errorId : undefined} onChange={event => controller.change(field, event.target.value)} onKeyDown={keyDown} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onBlur={() => { if (!composing.current) controller.commit(field); }} />{draft?.error && <span className="field-error" id={errorId} role="alert">{draft.error}</span>}</span>;
}

/** Only the lightweight range value changes while a pointer or key is held. */
export function TransactionRange({ value, min, max, step = 1, disabled, label, onCommit, onPreview }: { value: number; min: number; max: number; step?: number; disabled?: boolean; label: string; onCommit: (value: number) => void; onPreview?: (value: number | null) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const pending = useRef<number | null>(null), pointer = useRef(false), keyboard = useRef(false);
  function update(next: number | null) { pending.current = next; setDraft(next); onPreview?.(next); }
  function finish() { const next = pending.current; pointer.current = false; keyboard.current = false; update(null); if (next !== null && next !== value) onCommit(next); }
  function cancel() { pointer.current = false; keyboard.current = false; update(null); }
  return <input className="travel-range" aria-label={label} type="range" min={min} max={max} step={step} value={draft ?? value} disabled={disabled} onPointerDown={event => { pointer.current = true; event.currentTarget.setPointerCapture(event.pointerId); }} onChange={event => { const next = Number(event.target.value); update(next); if (!pointer.current && !keyboard.current) { update(null); onCommit(next); } }} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={() => { if (pointer.current) cancel(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } else if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) keyboard.current = true; }} onKeyUp={() => { if (keyboard.current) finish(); }} onBlur={() => { if (keyboard.current) finish(); }} />;
}

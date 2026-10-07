import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import './HomeLibrary.css';

/** Structural subset of repository summaries; this view never reads storage. */
export type HomeLibraryEntry = {
  id: string;
  name: string;
  updatedAt: string;
  thumbnail: string;
  status: 'ready' | 'corrupt';
  issue?: string;
};
type Action = void | Promise<void>;
/** Mutating callbacks resolve after success and reject on failure/cancellation. */
export type HomeLibraryProps = {
  entries: readonly HomeLibraryEntry[];
  activeId?: string;
  activeStatus?: string;
  continueId?: string;
  loading?: boolean;
  error?: string;
  onCreateOwn: () => Action;
  onTrySample: () => Action;
  onContinue?: () => Action;
  onOpen: (id: string) => Action;
  onRename: (id: string, name: string) => Action;
  onDuplicate: (id: string) => Action;
  onDelete: (id: string) => Action;
  onImport: () => Action;
  onExport: (id: string) => Action;
  onRecover: (id: string) => Action;
  onRetry?: () => Action;
};
type LibraryDialog = { kind: 'rename' | 'delete'; entry: HomeLibraryEntry };
const displayName = (entry: HomeLibraryEntry) => entry.name.trim() || '名前のない作品';
const updatedLabel = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) : null;
};
function actionError(error: unknown) {
  return error instanceof Error && error.message ? error.message : '操作を完了できませんでした。作品を残したまま、もう一度試せます。';
}

export default function HomeLibrary({ entries, activeId, activeStatus, continueId, loading = false, error, onCreateOwn, onTrySample, onContinue, onOpen, onRename, onDuplicate, onDelete, onImport, onExport, onRecover, onRetry }: HomeLibraryProps) {
  const headingId = useId(), listId = useId(), renameId = useId(), renameErrorId = useId();
  const [dialog, setDialog] = useState<LibraryDialog | null>(null);
  const [name, setName] = useState('');
  const [localError, setLocalError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const busyRef = useRef(false), composing = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null), nameRef = useRef<HTMLInputElement>(null), cancelDeleteRef = useRef<HTMLButtonElement>(null), listHeading = useRef<HTMLHeadingElement>(null), dialogOrigin = useRef<HTMLElement | null>(null);
  const ready = entries.filter(entry => entry.status === 'ready');
  const recent = ready.find(entry => entry.id === continueId) ?? ready.find(entry => entry.id === activeId) ?? ready.reduce<HomeLibraryEntry | undefined>((latest, entry) => !latest || (Date.parse(entry.updatedAt) || 0) > (Date.parse(latest.updatedAt) || 0) ? entry : latest, undefined);
  const disabled = loading || !!busy;

  useEffect(() => {
    const element = dialogRef.current;
    if (!element) return;
    if (dialog && !element.open) {
      element.showModal();
      if (dialog.kind === 'rename') { nameRef.current?.focus(); nameRef.current?.select(); }
      else cancelDeleteRef.current?.focus();
    } else if (!dialog && element.open) {
      element.close();
      dialogOrigin.current?.focus();
    }
  }, [dialog]);

  async function perform(message: string, action: () => Action, success?: () => void) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(message); setLocalError(''); setNotice('');
    try { await action(); success?.(); }
    catch (issue) { setLocalError(actionError(issue)); }
    finally { busyRef.current = false; setBusy(''); }
  }
  function openDialog(kind: LibraryDialog['kind'], entry: HomeLibraryEntry) {
    if (disabled) return;
    const focused = dialogRef.current?.ownerDocument.activeElement;
    dialogOrigin.current = focused instanceof HTMLElement ? focused.closest('details')?.querySelector('summary') ?? focused : null;
    setLocalError(''); setName(displayName(entry)); setDialog({ kind, entry });
  }
  function closeDialog() {
    if (busyRef.current) return;
    setDialog(null); setLocalError(''); composing.current = false;
  }
  function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog || dialog.kind !== 'rename' || composing.current || busyRef.current) return;
    const clean = name.trim();
    if (!clean || clean.length > 120) { setLocalError('作品名を1〜120文字で入力してください。'); nameRef.current?.focus(); return; }
    void perform('作品名を保存しています…', () => onRename(dialog.entry.id, clean), () => { setDialog(null); setNotice(`作品名を「${clean}」に変更しました。`); });
  }
  function remove() {
    if (!dialog || dialog.kind !== 'delete') return;
    const target = dialog.entry;
    void perform('作品を削除しています…', () => onDelete(target.id), () => {
      setDialog(null); setNotice(`「${displayName(target)}」をこのブラウザの一覧から削除しました。`);
      requestAnimationFrame(() => listHeading.current?.focus());
    });
  }

  return <section className="home-library" aria-labelledby={headingId}>
    <div className="library-start">
      <div><h1 id={headingId}>作品をつくる</h1><p>絵を選び、動かすところを囲むことから。</p></div>
      <div className="library-start-actions">
        <button className="primary" disabled={disabled} onClick={() => void perform('画像を選びます…', onCreateOwn)}>自分の絵ではじめる</button>
        <button className="secondary" disabled={disabled} onClick={() => void perform('サンプルを開いています…', onTrySample)}>サンプルで試す</button>
        {(onContinue || recent) && <button className="secondary" disabled={disabled} onClick={() => { if (onContinue || recent) void perform('前の作品を開いています…', onContinue ?? (() => onOpen(recent!.id))); }}>前の作品を続ける</button>}
      </div>
      {recent && !onContinue && <p className="library-recent">続きから：{displayName(recent)}</p>}
    </div>

    <div className="library-list-heading"><div><h2 id={listId} ref={listHeading} tabIndex={-1}>このブラウザの作品 <span>{entries.length}件</span></h2><p>このブラウザ・このサイトへの保存です。別の端末とは同期しません。</p></div><button className="secondary" disabled={disabled} onClick={() => void perform('プロジェクトファイルを選びます…', onImport)}>ファイルを読み込む</button></div>
    <p className="library-live" role="status" aria-live="polite">{busy || (loading ? '保存した作品を確認しています…' : notice)}</p>
    {!dialog && (localError || error) && <div className="notice warning library-error" role="alert"><p>{localError || error}</p>{onRetry && <button className="secondary" disabled={disabled} onClick={() => void perform('作品一覧を読み直しています…', onRetry)}>一覧を読み直す</button>}</div>}

    {!entries.length && !loading && <div className="library-empty"><p>{error ? '作品一覧を表示できませんでした。保存した作品は削除していません。' : '保存した作品はまだありません。'}</p></div>}
    {!!entries.length && <ul className="library-list" aria-labelledby={listId} aria-busy={loading}>{entries.map((entry, index) => {
      const titleId = `${listId}-${index}`, label = displayName(entry), date = updatedLabel(entry.updatedAt);
      const corrupt = entry.status === 'corrupt';
      return <li key={entry.id}><article className="library-entry" aria-labelledby={titleId} data-project-id={entry.id} data-status={entry.status}>
        <div className="library-thumbnail">{/^data:image\/(?:png|jpeg|webp);base64,/.test(entry.thumbnail) ? <img src={entry.thumbnail} alt="" loading="lazy" /> : <span>{corrupt ? '復元を確認' : 'プレビューなし'}</span>}</div>
        <div className="library-entry-body"><h3 id={titleId}>{label}</h3><p className="library-entry-meta">{date ? <time dateTime={entry.updatedAt}>更新 {date}</time> : '更新日時を確認できません'}{entry.id === activeId ? <span className="library-active">編集中{activeStatus ? ` · ${activeStatus}` : ''}</span> : <span>{corrupt ? '復元の確認が必要' : '保存済み'}</span>}</p>
          {corrupt && <p className="library-entry-issue">{entry.issue || 'この作品を読み取れません。復元できる内容を確認するか、この作品だけを削除できます。'}</p>}
          <div className="library-entry-actions">
            <button className="secondary" disabled={disabled} onClick={() => void perform(corrupt ? '復元できる内容を確認しています…' : '作品を開いています…', () => corrupt ? onRecover(entry.id) : onOpen(entry.id))}>{corrupt ? '復元できる内容を確認' : '続きから開く'}</button>
            <details className="library-more" onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
            }} onKeyDown={event => {
              if (event.key === 'Escape' && event.currentTarget.open) {
                event.preventDefault(); event.currentTarget.open = false;
                event.currentTarget.querySelector('summary')?.focus();
              }
            }} onToggle={event => {
              if (event.currentTarget.open) event.currentTarget.closest('.library-list')?.querySelectorAll<HTMLDetailsElement>('.library-more[open]').forEach(menu => { if (menu !== event.currentTarget) menu.open = false; });
            }}><summary aria-disabled={disabled} onClick={event => { if (disabled) event.preventDefault(); }}>作品の操作</summary><div>
              {!corrupt && <><button className="text-button" disabled={disabled} onClick={() => openDialog('rename', entry)}>名前を変更</button><button className="text-button" disabled={disabled} onClick={() => void perform('作品を複製しています…', () => onDuplicate(entry.id), () => setNotice(`「${label}」を複製しました。`))}>複製する</button><button className="text-button" disabled={disabled} onClick={() => void perform('プロジェクトを書き出しています…', () => onExport(entry.id), () => setNotice(`「${label}」を書き出しました。`))}>ファイルに書き出す</button></>}
              <button className="text-button library-delete" disabled={disabled} onClick={() => openDialog('delete', entry)}>削除する</button>
            </div></details>
          </div>
        </div>
      </article></li>;
    })}</ul>}
    {!!entries.length && <p className="library-backup-note">作品の操作から、ファイルにも書き出せます。</p>}

    <dialog ref={dialogRef} className="library-dialog" aria-label={dialog?.kind === 'rename' ? '作品の名前を変更' : '作品の削除'} onCancel={event => { event.preventDefault(); closeDialog(); }}>
      {dialog?.kind === 'rename' ? <form onSubmit={rename}><h2>作品の名前を変更</h2><label htmlFor={renameId}>作品名<input ref={nameRef} id={renameId} value={name} maxLength={120} aria-invalid={!!localError} aria-describedby={localError ? renameErrorId : undefined} disabled={!!busy} onChange={event => { setName(event.target.value); setLocalError(''); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }} /></label>{localError && <p className="notice warning" id={renameErrorId} role="alert">{localError}</p>}<div className="library-dialog-actions"><button className="primary" type="submit" disabled={!!busy}>{busy || '名前を保存する'}</button><button className="secondary" type="button" disabled={!!busy} onClick={closeDialog}>キャンセル</button></div></form> : dialog ? <><h2>「{displayName(dialog.entry)}」を削除しますか？</h2><p>このブラウザ・このサイトから、この作品の保存データと下書きを削除します。書き出したファイルは残ります。</p>{dialog.entry.id === activeId && <p className="notice warning">いま編集中の作品です。未保存の編集や記録の下書きがある場合は、先に残してください。</p>}{localError && <p className="notice warning" role="alert">{localError}</p>}<div className="library-dialog-actions"><button className="secondary library-delete" disabled={!!busy} onClick={remove}>{busy || '削除する'}</button><button ref={cancelDeleteRef} className="secondary" disabled={!!busy} onClick={closeDialog}>キャンセル</button></div></> : null}
    </dialog>
  </section>;
}

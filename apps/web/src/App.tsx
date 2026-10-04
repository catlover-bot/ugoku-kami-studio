import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { SAMPLE_INPUT, createDesign, applyDesignPatch, createImageInput, getKitSummary, type DesignDocument, type DesignInput, type DesignPatch, type LockKey, type Rect } from '@ugoku/core';
import { generateSvg, generateAssemblySvg, INSTRUCTION_PAGE_COUNT, getAssemblySteps, getMaterials } from '@ugoku/export';
import Preview, { getPreviewBounds } from './Preview';
import BackgroundRepairPanel from './BackgroundRepairPanel';
import { generatePdfOffThread } from './pdf';
import AiPanel from './AiPanel';
import IntentPanel from './IntentPanel';
import { designChanges } from './DesignComparison';
import { STORAGE_KEY, MAX_RECORD_PHOTOS, assertProjectByteLength, photoViewLabels, verifyDataImage, decodeImage, downloadFile, imageContentId, parseProject, readRaster, serializeProject, type PhysicalRecord, type Project } from './project';

const initialDocument = createDesign(SAMPLE_INPUT, { designId: 'turtle-sample', revision: 1 });
const directionLabels = { right: '右へ', left: '左へ', up: '上へ', down: '下へ' };
const directionArrows = { right: '→', left: '←', up: '↑', down: '↓' };
const lockLabels: { key: LockKey; label: string }[] = [{ key: 'travelMm', label: '動く距離' }, { key: 'direction', label: '方向' }, { key: 'widthMm', label: '作品の幅' }, { key: 'heightMm', label: '作品の高さ' }, { key: 'maxSheets', label: '紙の上限' }, { key: 'selection', label: '選択領域' }, { key: 'paperThicknessMm', label: '紙の厚さ' }, { key: 'clearanceMm', label: 'すき間' }];
const blankRecord = (document: DesignDocument): PhysicalRecord => ({ id: crypto.randomUUID(), designId: document.designId, designHash: document.designHash, revision: document.revision, pattern: `${document.designId}-r${document.revision}.pdf`, material: '', printScale: '', measuredLine: '', modifications: '', movement: '', endpoints: '', guideRetention: '', glueFaces: '', roundTrips: '', viewObservations: '', photoViews: [], photos: [] });
const hasRecordData = (record: PhysicalRecord) => !!record.photos.length || ['material','printScale','measuredLine','modifications','movement','endpoints','guideRetention','glueFaces','roundTrips','viewObservations'].some(key => String(record[key as keyof PhysicalRecord] ?? '').trim().length > 0);

function friendlyError(error: unknown) {
  if (error instanceof Error) {
    if (error.name === 'ZodError') {
      const issues = (error as Error & {issues?: {path: PropertyKey[]}[]}).issues;
      const paths = issues?.flatMap(issue => issue.path.map(String)) ?? [];
      if (paths.includes('selection')) return '選択の枠を元画像の内側に収めてください。X・Yは0以上にし、幅・高さを画像の端までに調整できます。';
      if (paths.includes('travelMm')) return '動く距離は2〜70mmで指定してください。「少し小さく」でも実際の距離を調整する候補が出せます。';
      if (paths.includes('widthMm') || paths.includes('heightMm')) return '作品の幅・高さは60〜260mmで指定してください。紙に収まるかどうかは、変更後の検査で確認します。';
      if (paths.includes('maxSheets')) return '紙の上限は1〜8枚の整数で指定してください。型紙の必要枚数は「確かめる」で確認できます。';
      if (paths.includes('paperThicknessMm')) return '想定する紙の厚さは0.1〜0.6mmです。使う紙の実測値を確認してください。';
      if (paths.includes('clearanceMm')) return 'すき間は0.3〜2mmで指定してください。摩擦や加工精度は実物で確認します。';
      return '読み込んだ内容が正しい形式ではありません。画像・設計版・記録の形式を確認してください。';
    }
    if (error instanceof SyntaxError) return '読み込んだ内容が正しい形式ではありません。うごく紙工房から書き出したJSONファイルを選んでください。';
    return error.message;
  }
  return '処理できませんでした。もう一度お試しください。';
}

export default function App() {
  const [project, setProject] = useState<Project>({ document: initialDocument, imageDataUrl: '', records: [] });
  const [history, setHistory] = useState<Project[]>([]);
  const [compare, setCompare] = useState(false);
  const [view, setView] = useState<'front' | 'back' | 'print' | 'original'>('front');
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selection, setSelection] = useState<Rect | null>(initialDocument.input.selection);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('カメの首が選ばれています。自分の絵を開くか、このサンプルで試せます。');
  const [error, setErrorState] = useState('');
  const [errorScope, setErrorScope] = useState<'global' | 'image' | 'print'>('global');
  function setError(value: string, scope: 'global' | 'image' | 'print' = 'global') {setErrorState(value); setErrorScope(scope);}
  const [hasSaved, setHasSaved] = useState(false);
  const [record, setRecord] = useState<PhysicalRecord>(() => blankRecord(initialDocument));
  const [printPage, setPrintPage] = useState(1);
  const [printUrl, setPrintUrl] = useState('');
  const [stage, setStage] = useState(1);
  const [manualRequest, setManualRequest] = useState<{text: string; sequence: number} | null>(null);
  const [zoom, setZoom] = useState(1);
  const [selectionMode, setSelectionMode] = useState<'drag' | 'corners'>('drag');
  const [helper, setHelper] = useState<'manual' | 'ai'>('manual');
  const [manualCandidate, setManualCandidate] = useState(false);
  const [aiCandidate, setAiCandidate] = useState(false);
  const [repairCandidate, setRepairCandidate] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveLabel, setSaveLabel] = useState('まだ保存していません');
  const saveDialog = useRef<HTMLDialogElement>(null), replaceDialog = useRef<HTMLDialogElement>(null);
  const queuedAction = useRef<(() => void) | null>(null);
  const errorBanner = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const imageInput = useRef<HTMLInputElement>(null), projectInput = useRef<HTMLInputElement>(null);
  const projectRef = useRef(project); projectRef.current = project;
  const pending = useRef(0);
  const workbench = useRef<HTMLElement>(null);
  const doc = project.document, input = doc.input;
  const kit = useMemo(() => getKitSummary(doc), [doc]);
  const failChecks = kit.checks.filter(check => check.status === 'fail');
  const unknownChecks = kit.checks.filter(check => check.status === 'unknown');
  const previous = history.at(-1);
  const canCompare = previous?.document.designId === doc.designId;
  const visibleProject = compare && previous && canCompare ? previous : project;
  const comparisonBounds = useMemo(() => getPreviewBounds(previous?.document.designId === doc.designId ? [doc, previous.document] : [doc], view === 'print' ? 'front' : view), [doc, previous, view]);
  const steps = useMemo(() => getAssemblySteps(doc), [doc]);
  const assemblyImages = useMemo(() => steps.map(step => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(generateAssemblySvg(doc, step.number))}`), [doc, steps]);
  const materials = useMemo(() => getMaterials(doc), [doc]);
  const recordStarted = hasRecordData(record);
  const recordIsOlder = recordStarted && (record.designId !== doc.designId || record.revision !== doc.revision || record.designHash !== doc.designHash);

  const candidateActive = stage === 1 ? repairCandidate : stage === 2 && (helper === 'manual' ? manualCandidate : aiCandidate);
  const hasUnsaved = dirty || recordStarted;
  useEffect(() => {
    if (error && !saveDialog.current?.open && !replaceDialog.current?.open) errorBanner.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);
  useEffect(() => {
    if (!hasUnsaved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsaved]);

  useEffect(() => {
    let current = true;
    void decodeImage('/turtle.svg').then(image => {
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 550;
      canvas.getContext('2d')!.drawImage(image, 0, 0);
      const imageDataUrl = canvas.toDataURL('image/png');
      const bindInitialImage = (existing: Project): Project => existing.imageDataUrl || existing.document.input.image.id !== SAMPLE_INPUT.image.id ? existing : ({ ...existing, imageDataUrl, document: createDesign({ ...existing.document.input, image: { ...existing.document.input.image, id: imageContentId(imageDataUrl) } }, { designId: existing.document.designId, revision: existing.document.revision + (existing.document.revision > 1 ? 1 : 0) }) });
      if (current) { setProject(bindInitialImage); setHistory(previous => previous.map(bindInitialImage)); }
    }).catch(() => { if (current) setError('サンプル画像を読み込めませんでした。画像を選んで開始できます。'); });
    try { setHasSaved(!!localStorage.getItem(STORAGE_KEY)); } catch { setMessage('このブラウザでは保存領域が使えません。プロジェクトファイルへ書き出せます。'); }
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (!playing) return;
    let frame = 0; const start = performance.now(); const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { setPlaying(false); setMessage('動きを減らす設定に合わせ、自動再生を停止しました。スライダーで位置を調整できます。'); return; }
    const animate = (time: number) => { setPosition((1 - Math.cos((time - start) / 1500 * Math.PI)) / 2); frame = requestAnimationFrame(animate); };
    frame = requestAnimationFrame(animate); return () => cancelAnimationFrame(frame);
  }, [playing]);
  useEffect(() => {
    if (view !== 'print') return;
    if (!selection || doc.checks.some(check => check.status === 'fail')) { setPrintUrl(''); return; }
    try {
      const svg = generateSvg(doc, Math.min(printPage, Math.max(1, doc.layout.sheets)), { imageDataUrl: project.imageDataUrl, backgroundImageDataUrl: project.backgroundImageDataUrl });
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); setPrintUrl(url);
      return () => URL.revokeObjectURL(url);
    } catch (issue) { setPrintUrl(''); setError(friendlyError(issue)); }
  }, [doc, printPage, project.imageDataUrl, project.backgroundImageDataUrl, view, selection]);

  const commit = useCallback((next: Project, text = '設計を更新しました。検査と型紙も同じ版に更新されます。') => {
    const current = projectRef.current;
    const records = current.document.designId === next.document.designId ? [...new Map([...next.records, ...current.records].map(record => [record.id, record])).values()] : next.records;
    if (current.document.designId === next.document.designId && current.records !== next.records) serializeProject({ ...next, records });
    pending.current++; setHistory(list => [...list.slice(-19), current]); setProject({ ...next, records }); projectRef.current = { ...next, records }; setDirty(true); setSaveLabel('保存後に変更があります');
    setSelection(next.document.input.selection); setCompare(false); setPlaying(false); setPosition(0); setPrintPage(1); setBusy(null); setError(''); setMessage(text);
  }, []);
  function patch(changes: DesignPatch) {
    try {
      const next = applyDesignPatch(doc, changes);
      const change = designChanges(doc, next)[0];
      const failures = getKitSummary(next).checks.filter(check => check.status === 'fail').length;
      commit({ ...project, document: next }, `${change ? `${change.label}を${change.before}から${change.after}へ変更しました。` : '選択と条件を更新しました。'}${failures ? `${failures}件の条件を「確かめる」で見直してください。` : '寸法・配置を検査し、型紙も更新しました。'}`);
      if (!selection && !changes.selection) setSelection(null);
    } catch (issue) { setError(friendlyError(issue)); }
  }
  function lock(key: LockKey) {
    const locks = input.locks.includes(key) ? input.locks.filter(item => item !== key) : [...input.locks, key];
    commit({ ...project, document: createDesign({ ...input, locks }, { designId: doc.designId, revision: doc.revision + 1 }) }, input.locks.includes(key) ? '条件の固定を解除しました。' : '条件を固定しました。手動編集とAIの変更案の両方に適用します。');
    if (!selection) setSelection(null);
  }
  function undo() {
    const last = history.at(-1); if (!last) return;
    pending.current++; setHistory(list => list.slice(0, -1)); setBusy(null);
    const restored = { ...last, records: last.document.designId === doc.designId ? project.records : last.records, document: createDesign(last.document.input, { designId: last.document.designId, revision: Math.max(doc.revision, last.document.revision) + 1 }) };
    setProject(restored); projectRef.current = restored; setDirty(true); setSaveLabel('保存後に変更があります'); setSelection(restored.document.input.selection); setCompare(false); setPlaying(false); setPosition(0); setError(''); setMessage('前の内容に戻しました。設計版は新しくなっています。');
  }
  async function sample() {
    setBusy('サンプルを準備しています…'); const ticket = ++pending.current;
    try {
      const image = await decodeImage('/turtle.svg'); const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 550; canvas.getContext('2d')!.drawImage(image, 0, 0);
      if (ticket !== pending.current) return;
      const imageDataUrl = canvas.toDataURL('image/png');
      commit({ document: createDesign({ ...SAMPLE_INPUT, image: { ...SAMPLE_INPUT.image, id: imageContentId(imageDataUrl) } }, { designId: crypto.randomUUID(), revision: 1 }), imageDataUrl, records: [] }, 'カメのサンプルを開きました。首の部分が選ばれています。'); setEditing(false); setView('front'); setStage(2); setZoom(1); setRecord(blankRecord(projectRef.current.document));
    } catch (issue) { if (ticket === pending.current) setError(friendlyError(issue)); } finally { if (ticket === pending.current) setBusy(null); }
  }
  async function uploadFile(file: File) {
    const ticket = ++pending.current; setBusy('画像を確認しています…'); setError('');
    try {
      const checked = await readRaster(file);
      const response = await fetch('/api/images', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: checked.dataUrl }) });
      const result = await response.json() as { image: DesignInput['image'] & { dataUrl: string }; error?: {message?: string} | string };
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message ?? 'サーバーが画像を読み込めませんでした。');
      if (ticket !== pending.current) return;
      const verified = await verifyDataImage(result.image.dataUrl);
      if (result.image.mimeType !== 'image/png' || !result.image.dataUrl.startsWith('data:image/png;base64,') || verified.naturalWidth !== result.image.widthPx || verified.naturalHeight !== result.image.heightPx || imageContentId(result.image.dataUrl) !== result.image.id) throw new Error('画像の確認結果と画像が一致しません。現在の作品は残っています。画像を選び直してください。');
      if (ticket !== pending.current) return;
      const { dataUrl, ...source } = result.image;
      const nextInput = createImageInput(source, file.name.replace(/\.[^.]+$/, ''));
      const next = createDesign(nextInput, { designId: crypto.randomUUID(), revision: 1 });
      commit({ document: next, imageDataUrl: dataUrl, records: [] }, '画像を開きました。動かしたい部分を囲んでください。'); setEditing(true); setView('front'); setStage(1); setZoom(1); setRecord(blankRecord(next));
    } catch (issue) { if (ticket === pending.current) setError(issue instanceof TypeError ? '画像の確認サーバーに接続できません。接続を確認して再試行してください。編集中の作品は残っています。' : friendlyError(issue), 'image'); }
    finally { if (ticket === pending.current) setBusy(null); }
  }
  function updateSelection(next: Rect) { patch({ selection: next }); }
  function goTo(next: number) {
    setStage(next); setPlaying(false); setCompare(false); setZoom(1);
    if (next !== 1) setEditing(false);
    if (view === 'print' || view === 'original') setView('front');
  }
  function editSelection() { goTo(1); setEditing(true); setPlaying(false); setPosition(0); setView('front'); setCompare(false); }
  function openDetails() { goTo(2); if (detailsRef.current) detailsRef.current.open = true; }
  function quickMotion(text: string) { setManualRequest(previous => ({ text, sequence: (previous?.sequence ?? 0) + 1 })); setHelper('manual'); goTo(2); }
  function numberSelection(key: keyof Rect, value: number) {
    if (!selection) return;
    updateSelection({ ...selection, [key]: value });
  }
  async function exportPdf() {
    if (busy || !selection || failChecks.length) return;
    const snapshot = project, ticket = pending.current;
    setBusy('原寸PDFをつくっています…'); setError('');
    try {
      const response = await fetch('/fonts/ZenKakuGothicNew-Regular.ttf'); if (!response.ok) throw new Error('印刷用フォントを読み込めません。再試行してください。');
      const fontBytes = new Uint8Array(await response.arrayBuffer());
      const bytes = await generatePdfOffThread(snapshot.document, { imageDataUrl: snapshot.imageDataUrl, backgroundImageDataUrl: snapshot.backgroundImageDataUrl, fontBytes });
      if (ticket !== pending.current) { setMessage('設計が変わったため、古いPDFを破棄しました。もう一度出力してください。'); return; }
      downloadFile(new Uint8Array(bytes), 'application/pdf', `${snapshot.document.designId}-r${snapshot.document.revision}.pdf`); setMessage(`第${snapshot.document.revision}版のPDFをダウンロードしました。100%で印刷し、50mmの校正線を測ってください。`);
    } catch (issue) { if (ticket === pending.current) setError(friendlyError(issue), 'print'); } finally { if (ticket === pending.current) setBusy(null); }
  }
  function exportSvg() {
    try {
      for (let page = 1; page <= doc.layout.sheets; page++) downloadFile(generateSvg(doc, page, { imageDataUrl: project.imageDataUrl, backgroundImageDataUrl: project.backgroundImageDataUrl }), 'image/svg+xml', `${doc.designId}-r${doc.revision}-p${page}.svg`);
      setMessage('確認用SVGを出力しました。各ファイルがA4の1ページです。');
    } catch (issue) { setError(friendlyError(issue)); }
  }
  function save(): boolean {
    if (!selection) { setError('動かす部分を選んでから保存してください。選択をやり直すか、やり直しで戻れます。'); return false; }
    if (recordStarted) { setError('入力中の実物記録は、先に「この設計版に記録を追加」で確定してください。下書きはまだ作品に保存されていません。'); return false; }
    let serialized: string;
    try { serialized = serializeProject(project); }
    catch (issue) { setError(friendlyError(issue)); return false; }
    try { localStorage.setItem(STORAGE_KEY, serialized); setHasSaved(true); setDirty(false); setSaveLabel(`第${doc.revision}版をこのブラウザに保存済み`); setError(''); setMessage('画像・設計・実物の記録を、このブラウザだけに保存しました。'); return true; }
    catch { setError('ブラウザに保存できませんでした。空き容量や設定を確認するか、プロジェクトを書き出してください。'); return false; }
  }
  function askReplace(action: () => void) {
    saveDialog.current?.close();
    if (hasUnsaved) { queuedAction.current = action; replaceDialog.current?.showModal(); }
    else action();
  }
  function finishReplacement(saveFirst: boolean) {
    if (saveFirst && !save()) return;
    replaceDialog.current?.close();
    const action = queuedAction.current; queuedAction.current = null;
    if (action) action();
  }
  function chooseFile(event: ChangeEvent<HTMLInputElement>, kind: 'image' | 'project') {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    askReplace(() => void (kind === 'image' ? uploadFile(file) : importFile(file)));
  }
  function exportProject() {
    if (!selection || !project.imageDataUrl) return;
    if (recordStarted) { setError('入力中の実物記録を先に追加してください。未確定の下書きはファイルに含まれません。'); return; }
    try { downloadFile(serializeProject(project), 'application/json', `${doc.designId}.ugoku.json`); setDirty(false); setSaveLabel(`第${doc.revision}版をファイルに書き出し済み`); setMessage('画像を含むプロジェクトを書き出しました。このブラウザの保存とは別です。'); setError(''); }
    catch (cause) { setError(friendlyError(cause)); }
  }
  async function resume() {
    const ticket = ++pending.current;
    setBusy('保存した作品を確認しています…');
    try { const saved = localStorage.getItem(STORAGE_KEY); if (!saved) throw new Error('保存した作品がありません。'); const restored = await parseProject(saved); if (ticket !== pending.current) return; const retainedRecords = projectRef.current.document.designId === restored.document.designId && projectRef.current.records.some(item => !restored.records.some(saved => saved.id === item.id)); commit(restored, retainedRecords ? '保存した作品を開きました。あとで追加した実物記録も残しました。記録を含めて、もう一度保存してください。' : '保存した画像・選択領域・設計・記録を復元しました。'); setDirty(retainedRecords); setSaveLabel(retainedRecords ? '実物記録に未保存の変更があります' : `第${restored.document.revision}版をこのブラウザから再開`); setRecord(blankRecord(restored.document)); setStage(1); }
    catch (issue) { if (ticket === pending.current) setError(friendlyError(issue)); } finally { if (ticket === pending.current) setBusy(null); }
  }
  async function importFile(file: File) {
    const ticket = ++pending.current;
    setBusy('プロジェクトを確認しています…');
    try { assertProjectByteLength(file.size); const restored = await parseProject(await file.text()); if (ticket !== pending.current) return; const retainedRecords = projectRef.current.document.designId === restored.document.designId && projectRef.current.records.some(item => !restored.records.some(saved => saved.id === item.id)); commit(restored, retainedRecords ? 'ファイルを開きました。現在の作品に追加した実物記録も残っています。記録を含めて、もう一度保存してください。' : '画像を含むプロジェクトを開きました。'); setDirty(retainedRecords); setSaveLabel(retainedRecords ? '実物記録に未保存の変更があります' : 'ファイルから再開・ブラウザには未保存'); setRecord(blankRecord(restored.document)); setStage(1); }
    catch (issue) { if (ticket === pending.current) setError(friendlyError(issue)); } finally { if (ticket === pending.current) setBusy(null); }
  }
  function removeSaved() {
    try { localStorage.removeItem(STORAGE_KEY); setHasSaved(false); setDirty(true); setSaveLabel('このブラウザには未保存'); setMessage('このブラウザに保存した作品を削除しました。開いている作品は残ります。'); } catch { setError('ブラウザの保存領域にアクセスできず、削除できませんでした。'); }
  }
  async function addPhotos(event: ChangeEvent<HTMLInputElement>) {
    const ticket = pending.current, recordId = record.id;
    const files = [...(event.target.files ?? [])]; event.target.value = '';
    if (files.length + record.photos.length > MAX_RECORD_PHOTOS) { setError(`写真は1つの記録につき${MAX_RECORD_PHOTOS}枚までです。`); return; }
    try { const photos = await Promise.all(files.map(readRaster)); if (ticket !== pending.current) return; setRecord(existing => existing.id === recordId ? { ...(hasRecordData(existing) ? existing : blankRecord(doc)), photos: [...existing.photos, ...photos.map(photo => photo.dataUrl)].slice(0, MAX_RECORD_PHOTOS), photoViews: [...existing.photos.map((_, index) => existing.photoViews[index] ?? 'unspecified'), ...photos.map(() => 'unspecified' as const)].slice(0, MAX_RECORD_PHOTOS) } : existing); } catch (issue) { if (ticket === pending.current) setError(friendlyError(issue)); }
  }
  function updateRecord(changes: Partial<PhysicalRecord>) {
    setRecord(existing => ({ ...(hasRecordData(existing) ? existing : blankRecord(projectRef.current.document)), ...changes }));
  }
  function saveRecord() {
    if (!hasRecordData(record)) { setError('実際に確認した材料・校正線・動作・手修正・写真などを1つ記入してください。未確認の欄は空欄のままで構いません。'); return; }
    if (record.designId && record.designId !== doc.designId) { setError('入力中の記録は別の作品のものです。その作品へ戻るか、下書きを破棄して現在の作品の記録を始めてください。'); return; }
    const next = { ...projectRef.current, records: [...projectRef.current.records, record] };
    try { serializeProject(next); }
    catch (issue) { setError(`記録を追加できませんでした。${friendlyError(issue)} 下書きは残っています。`); return; }
    setProject(next); projectRef.current = next; setDirty(true); setSaveLabel('実物記録に未保存の変更があります');
    setRecord(blankRecord(doc)); setError(''); setMessage(`入力を始めた第${record.revision}版に実物の記録を追加しました。記録を残すにはブラウザへ保存するか、プロジェクトを書き出してください。`);
  }

  const imageFailure = error && errorScope === 'image' ? <div className="notice warning image-failure" role="alert"><p>{error}</p><button className="secondary" onClick={() => imageInput.current?.click()}>画像を選び直す</button></div> : null;
  return <div className="app-shell">
    <a className="skip-link" href="#workbench">工作の編集へ</a>
    <header className="site-header">
      <div className="brand"><span className="brand-mark" aria-hidden="true">↗</span><span>うごく紙工房</span></div>
      <div className="header-actions"><span className={`save-state ${hasUnsaved ? 'unsaved' : ''}`}>{hasUnsaved ? '未保存の変更があります' : saveLabel}</span><button className="text-button" title="やり直し" aria-label="やり直し" disabled={!history.length} onClick={undo}><span aria-hidden="true">↶</span> やり直し</button><button className="secondary" onClick={() => saveDialog.current?.showModal()}>保存・再開</button></div>
    </header>
    <main data-design-revision={doc.revision} data-design-hash={doc.designHash}>
      <nav className="workflow" aria-label="工作の流れ">{['絵を選ぶ','動きをつける','印刷して作る'].map((label,index) => <button key={label} className={stage === index + 1 ? 'active' : ''} aria-current={stage === index + 1 ? 'step' : undefined} onClick={() => goTo(index + 1)}><span className="step-number">{index + 1}</span><span>{label}</span></button>)}</nav>
      {error && (errorScope === 'global' || (errorScope === 'image' && stage !== 1) || (errorScope === 'print' && stage !== 3)) && <div ref={errorBanner} role="alert" className="notice error-message"><p>{error}</p><button className="text-button" onClick={() => setError('')}>メッセージを閉じる</button></div>}
      <div className="workspace-layout">
        <div className="workspace-main">
          <div className="mobile-start" hidden={stage !== 1}><button className={doc.designId === 'turtle-sample' && !dirty ? 'primary' : 'secondary'} onClick={() => imageInput.current?.click()} disabled={!!busy}>自分の絵ではじめる</button><button className="text-button" onClick={() => askReplace(() => void sample())} disabled={!!busy}>サンプルで試す</button>{imageFailure}</div>
          <section className="workbench" id="workbench" ref={workbench} aria-labelledby="art-title" hidden={stage === 2 && !!candidateActive}>
            <div className="workbench-header"><div><p className="eyebrow">{stage === 1 ? '動かすところを、四角く囲む。' : stage === 2 ? '引いて、動きを確かめる。' : 'この姿を、紙でためす。'}</p><h1 id="art-title">{input.title}</h1></div><span className="revision">第{doc.revision}版</span></div>
            <div className="canvas-toolbar"><div className="segmented" role="group" aria-label="表示する面">{([{key:'front',label:'正面'},{key:'original',label:'原画像'},{key:'back',label:'裏のしくみ'},{key:'print',label:'印刷図'}] as const).map(item => <button key={item.key} aria-pressed={view === item.key} onClick={() => { setView(item.key); setPlaying(false); if (item.key !== 'front') setEditing(false); }}>{item.label}</button>)}</div>{previous && canCompare && <button className="text-button" onClick={() => setCompare(value => !value)} aria-pressed={compare}>変更前と比較</button>}</div>
            <div className={`artwork-stage ${view === 'print' ? 'print-stage' : ''}`}>
              {compare && <span className="comparison-label">変更前 · 第{previous?.document.revision}版</span>}
              {view === 'print' ? <>{!printUrl && <p className="notice">条件の見直し、または動かす部分の選択が必要です。設計の検査を確認してください。</p>}{printUrl && <img className="print-preview" src={printUrl} alt={`第${doc.revision}版のA4型紙 ${printPage}ページ目`} />}</> : project.imageDataUrl ? <Preview document={visibleProject.document} imageDataUrl={visibleProject.imageDataUrl} backgroundImageDataUrl={visibleProject.backgroundImageDataUrl} position={position} view={view} editing={stage === 1 && editing && !compare} selection={compare ? visibleProject.document.input.selection : selection} onSelection={updateSelection} bounds={comparisonBounds} zoom={zoom} selectionMode={selectionMode} /> : <div className="empty-state"><p>絵を準備しています。</p><button className="secondary" onClick={() => imageInput.current?.click()}>自分の画像を選ぶ</button></div>}
            </div>
            {view === 'print' ? <div className="playback"><label>ページ <select value={printPage} onChange={event => setPrintPage(Number(event.target.value))}>{Array.from({length: Math.max(1, doc.layout.sheets)}, (_, index) => <option key={index} value={index + 1}>{index + 1} / {doc.layout.sheets}</option>)}</select></label><span className="field-note">A4 · 100% · 校正線50mm</span></div> : view === 'original' ? <p className="original-note">読み込んだ原画像です。画像そのものは変更していません。枠は「正面」で選び直せます。</p> : <div className="playback"><button className="play-button secondary" onClick={() => { setEditing(false); setPlaying(value => !value); }} disabled={!selection} aria-label={playing ? '動きを停止' : '動かす'}><span aria-hidden="true">{playing ? 'Ⅱ' : '▷'}</span>{playing ? '止める' : '動かす'}</button><button className="text-button endpoint-button" onClick={() => { setPlaying(false); setPosition(0); }}>はじめ</button><label className="position-control"><span className="sr-only">動きの位置</span><input aria-label="動きの位置" type="range" min="0" max="1" step="0.01" value={position} onChange={event => { setPlaying(false); setPosition(Number(event.target.value)); }} /></label><button className="text-button endpoint-button" onClick={() => { setPlaying(false); setPosition(1); }}>おわり</button><output className="distance-output" aria-live="off">{(position * visibleProject.document.input.travelMm).toFixed(0)}<small>mm</small></output></div>}
            <div className="canvas-bottom"><p className="canvas-footnote">{view === 'back' ? '裏から見た配置です。タブの通り道は接着しません。' : input.artworkRepair?.mode === 'image' ? '四角い紙ごと動き、元位置には指定した背景を印刷します。模様の境目を両端で確かめてください。' : input.artworkRepair?.mode === 'solid' ? '四角い紙ごと動き、元位置を指定した色で補います。色の境目を両端で確かめてください。' : '四角い紙ごと動き、元位置には白い四角が残ります。原画像と両端の姿を比べてください。'}</p>{view !== 'print' && <div className="zoom-controls"><label>表示倍率<select aria-label="表示倍率" value={zoom} onChange={event => setZoom(Number(event.target.value))}><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></select></label><button className="text-button" onClick={() => setZoom(1)}>全体を見る</button></div>}</div>
          </section>
          <div hidden={stage !== 1} className="repair-section"><BackgroundRepairPanel project={project} disabled={!selection || !project.imageDataUrl} onCandidateChange={setRepairCandidate} onAccept={(next, backgroundImageDataUrl) => commit({ ...project, document: next, backgroundImageDataUrl }, '元位置の背景を補いました。元画像は保持し、型紙にも同じ補正を反映します。')} /></div>
          <section className="helper-workspace" hidden={stage !== 2} aria-label="動きの相談">
            <div className="helper-switch segmented" role="group" aria-label="候補をつくる方法"><button aria-pressed={helper === 'manual'} onClick={() => setHelper('manual')}>手動支援</button><button aria-pressed={helper === 'ai'} onClick={() => setHelper('ai')}>Gemini</button></div>
            <div hidden={helper !== 'manual'}><IntentPanel document={doc} imageDataUrl={project.imageDataUrl} backgroundImageDataUrl={project.backgroundImageDataUrl} selectionReady={!!selection && !!project.imageDataUrl} request={manualRequest} onCandidateChange={setManualCandidate} onAccept={next => commit({ ...project, document: next }, 'この案にしました。作品と型紙が同じ設計版に更新されています。')} onEditSelection={editSelection} onOpenDetails={openDetails} /></div>
            <div hidden={helper !== 'ai'}><AiPanel document={doc} imageDataUrl={project.imageDataUrl} backgroundImageDataUrl={project.backgroundImageDataUrl} selectionReady={!!selection && !!project.imageDataUrl} onCandidateChange={setAiCandidate} onManual={() => setHelper('manual')} onAccept={next => commit({ ...project, document: next }, 'AIの変更案を採用しました。変更前と比較できます。')} /></div>
          </section>
          <details className="validation-details" hidden={stage === 1} open={!!failChecks.length}><summary>設計の検査 <span>{failChecks.length ? `要修正 ${failChecks.length}件` : '寸法・配置を検査済み'}</span></summary>{!selection && <p className="notice">選択領域は編集中です。以下は直前の設計の検査です。</p>}<ul className="check-list">{kit.checks.map(check => <li key={check.id} className={check.status}><span className="check-mark" aria-hidden="true">{check.status === 'pass' ? '✓' : check.status === 'fail' ? '!' : '?'}</span><div><strong>{check.status === 'pass' ? '適合' : check.status === 'fail' ? '要修正' : '未確認'}：{check.message}</strong>{check.status !== 'pass' && check.suggestion && <p>{check.suggestion}</p>}<small>{check.scope} {check.partIds.length ? `／ ${check.partIds.join(', ')}` : ''}</small></div></li>)}</ul>{!!failChecks.length && <div className="button-row"><button className="secondary" onClick={() => quickMotion(`動く距離を${input.travelMm}mm。絵の大きさを保って、紙は増やさない`)}>条件を保つ距離の代案を探す</button><button className="text-button" onClick={editSelection}>枠の位置を選び直す</button></div>}<p className="field-note">実物の確認待ち {unknownChecks.length}件 · 第{doc.revision}版</p><code className="design-hash">{doc.designHash}</code></details>
        </div>
        <aside className="settings-panel" aria-label="動きと作品の設定">
          <div hidden={stage !== 1}>
            <section className="settings-section start-section"><h2>どの絵でつくる？</h2><button className={doc.designId === 'turtle-sample' && !dirty ? 'primary' : 'secondary'} onClick={() => imageInput.current?.click()} disabled={!!busy}>自分の絵ではじめる</button><button className="text-button" onClick={() => askReplace(() => void sample())} disabled={!!busy}>サンプルで試す</button>{imageFailure}<p className="field-note">PNG・JPEG・WebP / 5MBまで<br />輪郭が枠に収まる、白い背景の絵から始めると作りやすくなります。</p></section>
            <section className="settings-section"><h2>動かす部分</h2><button className="selection-button secondary" disabled={!project.imageDataUrl || input.locks.includes('selection')} onClick={() => { if (editing) setEditing(false); else editSelection(); }}>{editing ? '選択の編集を終える' : '動かす部分を選び直す'}</button>
              <p className="field-note">四角い枠が、そのまま動く紙になります。輪郭や背景が切れて見える場合は、枠を選び直してください。</p>
              {editing && <div className="selection-fields"><div className="selection-methods" role="group" aria-label="枠の選び方"><button aria-pressed={selectionMode === 'drag'} onClick={() => setSelectionMode('drag')}>ドラッグで囲む</button><button aria-pressed={selectionMode === 'corners'} onClick={() => setSelectionMode('corners')}>2点で囲む</button></div><p className="field-note">角で大きさ、中央で位置を調整。枠にフォーカスすると矢印キーで移動、Shift＋矢印で10pxずつ移動できます。</p><details className="selection-numeric"><summary>枠を数値で調整</summary>{selection ? <div className="number-grid">{(['x','y','width','height'] as const).map(key => <label key={key}>{({x:'選択のX',y:'選択のY',width:'選択の幅',height:'選択の高さ'})[key]}<input type="number" min={key === 'width' || key === 'height' ? 10 : 0} step="1" value={selection[key]} onChange={event => numberSelection(key, Number(event.target.value))} /></label>)}</div> : <p className="notice">動かす部分が未選択です。</p>}</details><button className="text-button" onClick={() => { commit({ ...project, document: createDesign(input, { designId: doc.designId, revision: doc.revision + 1 }) }, '選択を解除しました。新しい部分を囲んでください。'); setSelection(null); }}>選択を解除</button></div>}
            </section>
            {!candidateActive && <div className="stage-action"><button className={doc.designId === 'turtle-sample' && !dirty ? 'secondary' : 'primary'} onClick={() => goTo(2)} disabled={!selection || !project.imageDataUrl}>動きをつけるへ <span aria-hidden="true">→</span></button></div>}
          </div>
          <div hidden={stage !== 2}>
            <section className="settings-section"><h2>どちらへ？</h2><div className="direction-grid" role="group" aria-label="動く方向">{(['left','right','up','down'] as const).map(direction => <button key={direction} aria-pressed={input.direction === direction} disabled={input.locks.includes('direction')} onClick={() => patch({ direction })}><span aria-hidden="true">{directionArrows[direction]}</span>{directionLabels[direction]}</button>)}</div></section>
            <section className="settings-section"><h2>どれくらい？</h2><p className="motion-summary">いまは <strong>{input.travelMm}mm</strong>、{directionLabels[input.direction]}。</p><div className="motion-presets"><button className="secondary" disabled={!selection || input.locks.includes('travelMm')} onClick={() => quickMotion('少し小さく動かしたい。絵の大きさを保って、紙は増やさない')}>少し小さく</button><button className="secondary" disabled={!selection || input.locks.includes('travelMm')} onClick={() => quickMotion('もう少し大きく動かしたい。絵の大きさを保って、紙は増やさない')}>もう少し大きく</button></div><p className="field-note">絵と紙の枚数を保つ案を出します。「この案にする」で反映します。</p></section>
          <details className="settings-section numeric-details" ref={detailsRef}><summary>寸法・材料の詳細</summary><div className="advanced-fields">
            <div className="range-label"><label htmlFor="travel">動く距離</label><div><input id="travel" aria-label="動く距離（mm）" type="number" min="2" max="70" step="1" value={input.travelMm} disabled={input.locks.includes('travelMm')} onChange={event => patch({travelMm: Number(event.target.value)})} /><span>mm</span></div></div><input className="travel-range" aria-label="動く距離をスライダーで調整" type="range" min="2" max="70" step="1" value={input.travelMm} disabled={input.locks.includes('travelMm')} onChange={event => patch({travelMm: Number(event.target.value)})} />
            <div className="number-grid"><label>作品の幅（mm）<input aria-label="作品の幅（mm）" type="number" min="60" max="260" value={input.widthMm} disabled={input.locks.includes('widthMm')} onChange={event => patch({widthMm: Number(event.target.value)})} /></label><label>作品の高さ（mm）<input aria-label="作品の高さ（mm）" type="number" min="60" max="260" value={input.heightMm} disabled={input.locks.includes('heightMm')} onChange={event => patch({heightMm: Number(event.target.value)})} /></label><label>紙の上限（枚）<input aria-label="紙の上限（枚）" type="number" min="1" max="8" value={input.maxSheets} disabled={input.locks.includes('maxSheets')} onChange={event => patch({maxSheets: Number(event.target.value)})} /></label><label>紙の厚さ（mm）<input type="number" min="0.1" max="0.6" step="0.05" value={input.paperThicknessMm} disabled={input.locks.includes('paperThicknessMm')} onChange={event => patch({paperThicknessMm: Number(event.target.value)})} /></label><label>すき間（mm）<input type="number" min="0.3" max="2" step="0.1" value={input.clearanceMm} disabled={input.locks.includes('clearanceMm')} onChange={event => patch({clearanceMm: Number(event.target.value)})} /></label></div>
            <fieldset><legend>変えない条件</legend>{lockLabels.map(item => <label className="check-label" key={item.key}><input type="checkbox" checked={input.locks.includes(item.key)} onChange={() => lock(item.key)} />{item.label}を固定</label>)}</fieldset><p className="field-note">固定した条件は手動支援・AIのどちらでも守ります。解除はここで明示的に行ってください。</p>
          </div></details>

            <div className="stage-action"><p className={`check-summary ${failChecks.length ? 'has-fail' : ''}`}>{!selection ? '動かす部分を選んでください' : failChecks.length ? `見直す条件が${failChecks.length}件あります` : '寸法・配置を検査済み'}</p>{!candidateActive && <button className="primary" onClick={() => goTo(3)} disabled={!selection || !!failChecks.length}>印刷する内容を確認する <span aria-hidden="true">→</span></button>}<button className="text-button" onClick={editSelection}>動かす枠を選び直す</button></div>
          </div>
          <section className="settings-section kit-download" hidden={stage !== 3}><h2>紙でためそう</h2><span className="outline-tag">試作用 · 実物未検証</span><dl><div><dt>機構の型紙</dt><dd>A4厚紙 <strong>{doc.layout.sheets}枚</strong> / {kit.partCount}部品</dd></div><div><dt>説明書</dt><dd>普通紙 {INSTRUCTION_PAGE_COUNT}ページ（別）</dd></div><div><dt>引く向き・距離</dt><dd>正面から見て{directionLabels[input.direction]} {input.travelMm}mm</dd></div></dl><p className="field-note">型紙と説明書を1つのPDFにまとめます。紙厚・摩擦・動きは、実物で確かめてください。</p>{error && errorScope === 'print' && <p className="notice warning" role="alert">{error}</p>}<button className="primary export-button" onClick={() => void exportPdf()} disabled={!!busy || !selection || !project.imageDataUrl || !!failChecks.length}>PDFをダウンロード</button><p className="field-note">PDF全{doc.layout.sheets + INSTRUCTION_PAGE_COUNT}ページ<br />第{doc.revision}版 · 100%で印刷<br />最初に50mmの校正線を測ります。</p><button className="text-button" onClick={() => goTo(2)}>動きを調整する</button></section>
        </aside>
      </div>
      <div className="status-area" aria-live="polite"><p role="status" className="status-message">{busy || message}</p></div>
      <section className="making-panel" id="making" hidden={stage !== 3} aria-label="材料と工作の記録">
        <details className="kit-materials"><summary>用意するもの</summary><ul>{materials.map(material => <li key={material.name}><strong>{material.name} · {material.quantity}</strong><p>{material.note}</p></li>)}</ul></details>
        <details className="assembly-details"><summary>材料と組み立て手順</summary><ol className="assembly-steps">{steps.map(step => <li key={step.number}><span>{String(step.number).padStart(2, '0')}</span><div><h3>{step.title}</h3><p>{step.description}</p><img className="assembly-illustration" src={assemblyImages[step.number - 1]} alt={`工程${step.number}：${step.title}。前の状態と、今回追加する部品${step.addedPartIds.join('・')}`} /><small>今回の部品 {step.addedPartIds.join('・') || '追加なし・確認のみ'} / 対象 {step.partIds.join('・')}</small>{step.glueInstructions.map((note,index) => <p key={`glue${index}`} className="glue-note">接着：{note}</p>)}{step.doNotGlue.map((note,index) => <p key={`no${index}`} className="no-glue-note">接着しない：{note}</p>)}</div></li>)}</ol></details>
        <details><summary>印刷の設定と確認用SVG</summary><div className="printing-note"><p><strong>「実際のサイズ／100%」</strong>で印刷し、「用紙に合わせる縮小」は無効にします。まず50mmの校正線を定規で測ってください。</p><p>切る線は実線、折る線は破線、接着場所は斜線と文字です。画面での大きさは実寸ではありません。</p><button className="secondary" onClick={exportSvg} disabled={!!failChecks.length || !selection}>確認用SVGをダウンロード</button><p className="field-note">はさみ・カッターと小さな部品の扱いに気をつけてください。必要に応じて大人と作業します。</p></div></details>
      <details className="physical-section"><summary>実物でためした記録 <span>{project.records.length}件 · 自分の工作ノート</span></summary><p className="muted">入力を始めた版に実物の記録を結び付けます。実際に試した欄だけを書いてください。記録を追加しても機構全体の検証済みにはなりません。</p><div className="record-meta">記録の対象：第{recordStarted ? record.revision : doc.revision}版<br />設計ハッシュ <code>{recordStarted ? record.designHash : doc.designHash}</code><br />使用した型紙 {recordStarted ? record.pattern : `${doc.designId}-r${doc.revision}.pdf`}</div>{recordIsOlder && <div className="notice warning"><p>{record.designId !== doc.designId ? '入力中の記録は別の作品のものです。' : `入力中の記録は第${record.revision}版のものです。現在の第${doc.revision}版には付け替えません。`}対象の型紙に書かれた距離と部品を確認して記入してください。</p><button className="text-button" onClick={() => { setRecord(blankRecord(doc)); setMessage(`下書きを破棄しました。第${doc.revision}版の記録を始められます。`); }}>下書きを破棄して現在の版で記録</button></div>}{!recordIsOlder && <ul className="physical-checklist">{kit.physicalTestItems.map(item => <li key={item}>{item}</li>)}</ul>}<div className="record-grid"><label className="field">使った材料<input value={record.material} onChange={event => updateRecord({material: event.target.value})} maxLength={1000} placeholder="例：厚紙0.25mm、木工用接着剤" /></label><label className="field">印刷倍率<input value={record.printScale} onChange={event => updateRecord({printScale: event.target.value})} maxLength={100} placeholder="例：100%" /></label><label className="field">50mm校正線の実測<input value={record.measuredLine} onChange={event => updateRecord({measuredLine: event.target.value})} maxLength={100} placeholder="測った長さをmmで記入" /></label><label className="field">移動の両端と途中<textarea value={record.endpoints} onChange={event => updateRecord({endpoints: event.target.value})} maxLength={2000} rows={2} placeholder={recordIsOlder ? '対象の型紙で、開始位置・途中・終点の様子を確認' : `開始位置・途中・${input.travelMm}mmの終点での様子`} /></label><label className="field">ガイドがタブを保持するか<textarea value={record.guideRetention} onChange={event => updateRecord({guideRetention: event.target.value})} maxLength={2000} rows={2} placeholder="始点・途中・終点でG1・G2から抜けないか、引き手をつかめるか" /></label><label className="field">接着面と表裏の確認<textarea value={record.glueFaces} onChange={event => updateRecord({glueFaces: event.target.value})} maxLength={2000} rows={2} placeholder="C1の上下の足、ガイドの足、通り道に糊がないか" /></label><label className="field">組み立て時の修正<textarea value={record.modifications} onChange={event => updateRecord({modifications: event.target.value})} maxLength={3000} rows={2} placeholder="切り直し、すき間調整、補強など" /></label><label className="field">動作結果<textarea value={record.movement} onChange={event => updateRecord({movement: event.target.value})} maxLength={3000} rows={2} placeholder="意図した動きに近づいたか、残る課題" /></label><label className="field">10往復程度の初期チェック<textarea value={record.roundTrips} onChange={event => updateRecord({roundTrips: event.target.value})} maxLength={2000} rows={2} placeholder="実際の往復回数と、前後の引っかかり・緩みの変化。耐久性の保証ではありません。" /></label><label className="field">正面・裏面・始点・終点の様子<textarea value={record.viewObservations} onChange={event => updateRecord({viewObservations: event.target.value})} maxLength={2000} rows={2} placeholder="確認した向きや位置だけ記入。未確認のものは空欄のままで構いません。" /></label><label className="field">写真（4枚まで）<input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={event => void addPhotos(event)} /></label></div>{!!record.photos.length && <div className="record-photos">{record.photos.map((photo, index) => <figure key={index}><img src={photo} alt={`追加する実物写真 ${index + 1}`} /><label>写真{index + 1}の向き<select aria-label={`写真${index + 1}の向き`} value={record.photoViews[index] ?? 'unspecified'} onChange={event => updateRecord({photoViews: record.photos.map((_, i) => i === index ? event.target.value as PhysicalRecord['photoViews'][number] : record.photoViews[i] ?? 'unspecified')})}>{Object.entries(photoViewLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="text-button" onClick={() => setRecord({...record, photos: record.photos.filter((_, i) => i !== index), photoViews: record.photos.map((_, i) => record.photoViews[i] ?? 'unspecified').filter((_, i) => i !== index)})}>写真を削除</button></figure>)}</div>}<button className="secondary" onClick={saveRecord}>この設計版に記録を追加</button>{project.records.map(item => <article className="saved-record" key={item.id}><h3>第{item.revision}版の実物記録</h3><small>{item.designHash} · {item.pattern}</small><dl>{[{label:'材料',value:item.material},{label:'印刷倍率 / 校正線',value:`${item.printScale || '未記入'} / ${item.measuredLine || '未記入'}`},{label:'移動の両端と途中',value:item.endpoints},{label:'ガイドの保持',value:item.guideRetention},{label:'接着面・表裏',value:item.glueFaces},{label:'組み立て時の修正',value:item.modifications},{label:'動作結果',value:item.movement},{label:'10往復程度の初期チェック',value:item.roundTrips},{label:'正面・裏面・始点・終点',value:item.viewObservations}].map(field => <div key={field.label}><dt>{field.label}</dt><dd>{field.value || '未記入'}</dd></div>)}</dl><div className="record-photos">{item.photos.map((photo, index) => <figure key={index}><img src={photo} alt={`第${item.revision}版の実物写真 ${index + 1}：${photoViewLabels[item.photoViews[index] ?? 'unspecified']}`} /><figcaption>{photoViewLabels[item.photoViews[index] ?? 'unspecified']}</figcaption></figure>)}</div></article>)}</details>
      </section>
      <input className="sr-only" tabIndex={-1} ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => chooseFile(event, 'image')} aria-label="画像を選ぶ" />
      <input ref={projectInput} className="sr-only" tabIndex={-1} type="file" accept=".json,application/json" aria-label="プロジェクトファイルを選ぶ" onChange={event => chooseFile(event, 'project')} />
    </main>
    <dialog ref={saveDialog} aria-label="保存と再開" className="project-dialog"><div className="dialog-heading"><h2>保存と再開</h2><button className="text-button" onClick={() => saveDialog.current?.close()}>閉じる</button></div><p>元画像・設計・追加済みの工作記録を一緒に残します。自動保存はしません。</p><p className="save-state">{hasUnsaved ? '未保存の変更があります' : saveLabel}</p>{recordStarted && <p className="notice warning">実物記録の下書きがあります。先に工程3で記録を追加してください。</p>}<div className="project-actions"><button className="primary" onClick={() => save()} disabled={!project.imageDataUrl || !selection}>このブラウザに保存</button><button className="secondary" onClick={() => askReplace(() => void resume())} disabled={!hasSaved || !!busy}>保存した作品を開く</button><button className="secondary" disabled={!project.imageDataUrl || !selection} onClick={exportProject}>プロジェクトを書き出す</button><button className="secondary" onClick={() => projectInput.current?.click()}>プロジェクトを読み込む</button></div><details><summary>保存したデータの削除</summary><p>このブラウザの保存だけを削除します。編集中の作品や、書き出したファイルは残ります。</p><button className="text-button" disabled={!hasSaved} onClick={removeSaved}>ブラウザの保存を削除</button><button className="text-button" onClick={() => { removeSaved(); setMessage('ブラウザには保存しません。未保存の内容は画面を閉じると消えます。'); }}>保存しない</button></details>{error && <p className="notice warning" role="alert">{error}</p>}<p className="field-note">{busy || message}</p></dialog>
    <dialog ref={replaceDialog} aria-label="未保存の変更" className="project-dialog" onCancel={() => { queuedAction.current = null; }}><h2>未保存の変更があります</h2><p>別の作品に切り替える前に、現在の作品を残しますか？</p>{recordStarted && <p className="notice warning">実物記録の下書きがあります。「編集を続ける」で戻り、記録を追加してから保存してください。</p>}<div className="project-actions"><button className="primary" disabled={recordStarted || !selection} onClick={() => finishReplacement(true)}>保存して切り替える</button><button className="secondary" onClick={() => finishReplacement(false)}>保存せず切り替える</button><button className="text-button" onClick={() => { queuedAction.current = null; replaceDialog.current?.close(); }}>編集を続ける</button></div>{error && <p role="alert" className="notice warning">{error}</p>}</dialog>
  </div>;
}

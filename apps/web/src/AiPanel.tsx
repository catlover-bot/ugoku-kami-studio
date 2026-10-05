import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { distanceTargetMm, displayDimension, getKitSummary, parseDesignDocument, type DesignDocument, type InterpretationChanges, type InterpretationCorrection } from '@ugoku/core';
import DesignComparison, { fieldNames } from './DesignComparison';
import { designStamp, observeRun, publicRunSnapshot, usageLabel, type AiRun as Run, type AiEvidence } from './aiEvidence';
import { downloadFile } from './project';
import './AiPanel.css';
import RequestInterpretation from './RequestInterpretation';

type RunCorrection = {runId: string; requestId: string; changes: InterpretationCorrection};
class ApiRequestError extends Error { constructor(message: string, readonly code?: string, readonly retryAt?: number) {super(message);} }
type Session = {sessionId: string; token: string; designId: string};
type PollContext = {session: Session; runId: string; base: DesignDocument; ticket: number; prompt: string; requestedAt: string; access: string};
async function request<T>(url: string, method: string, body?: unknown, token?: string, access?: string): Promise<T> {
  const hasBody = body !== undefined;
  const response = await fetch(url, {method, headers: {...(hasBody ? {'Content-Type': 'application/json'} : {}), ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(access ? {'X-AI-Access': access} : {})}, ...(hasBody ? {body: JSON.stringify(body)} : {})});
  const result = await response.json() as T & {error?: {message?: string; code?: string} | string; message?: string};
  if (!response.ok) {
    // Only an actual 429 Retry-After header supplies a waiting deadline. A
    // concurrency limit without this header must not invent a retry interval.
    const header = response.status === 429 ? response.headers.get('Retry-After') : null;
    const seconds = header && /^\d+$/.test(header) ? Number(header) : undefined;
    const retryAt = seconds !== undefined && Number.isSafeInteger(seconds) ? Date.now() + seconds * 1000 : header ? Date.parse(header) : undefined;
    throw new ApiRequestError(typeof result.error === 'string' ? result.error : result.error?.message ?? result.message ?? '通信に失敗しました。接続を確認して再試行してください。', typeof result.error === 'object' ? result.error.code : undefined, retryAt !== undefined && Number.isFinite(retryAt) && retryAt > Date.now() ? retryAt : undefined);
  }
  return result;
}

type AiPanelProps = {
  document: DesignDocument; imageDataUrl: string; backgroundImageDataUrl?: string;
  onCandidateChange?: (active: boolean) => void; onAccept: (document: DesignDocument) => void;
  selectionReady?: boolean; inputDraftActive?: boolean; onManual?: () => void;
  previewTarget?: HTMLElement | null; actionTarget?: HTMLElement | null; settingsTarget?: HTMLElement | null;
  visible?: boolean; onActivate?: () => void; onOpenSettings?: () => void; onConnectionLabel?: (label: string) => void;
  requestText?: string; onRequestTextChange?: (value: string) => void;
};
export default function AiPanel({document, imageDataUrl, backgroundImageDataUrl, onAccept, inputDraftActive = false, selectionReady = true, onCandidateChange, onManual, requestText, onRequestTextChange, previewTarget, actionTarget, settingsTarget, visible = true, onActivate, onOpenSettings, onConnectionLabel}: AiPanelProps) {
  const [connection, setConnection] = useState<{enabled: boolean; reason?: string; mode: string; provider?: 'none' | 'ollama' | 'gemini' | 'vertex'; model?: string | null; endpoint?: string | null; contextLength?: number; toolMode?: string; unreachable?: boolean}>({enabled: false, mode: 'manual', reason: '接続を確認中です。'});
  const [limits, setLimits] = useState<{modelCalls: number; toolCalls: number; timeoutMs: number; inputBytes: number; outputTokens: number} | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const connectionTicket = useRef(0);
  const connectionChecking = useRef(false);
  const [localPrompt, setLocalPrompt] = useState('もう少し大きく動かしたい。絵の大きさは変えず、紙も増やさない');
  const prompt = requestText ?? localPrompt;
  const promptRef = useRef(prompt); promptRef.current = prompt;
  const previousPrompt = useRef(prompt);
  const [access, setAccess] = useState('');
  const [codeRequired, setCodeRequired] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = (value: boolean) => {busyRef.current = value; setBusyState(value);};
  const [message, setMessage] = useState('');
  const [interpretationDraft, setInterpretationDraft] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [pollInterrupted, setPollInterrupted] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancellingRef = useRef(false);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const waitStarted = useRef<number | null>(null);
  const [evidence, setEvidence] = useState<AiEvidence[]>([]);
  const sessionRef = useRef<Session | null>(null);
  const documentRef = useRef(document); documentRef.current = document;
  const draftRef = useRef(inputDraftActive); draftRef.current = inputDraftActive;
  const identity = `${document.designId}:${document.revision}:${document.designHash}:${selectionReady}:${inputDraftActive}`;
  const previousIdentity = useRef(identity);
  const acceptedIdentity = useRef<string | null>(null);
  const isCurrent = (base: DesignDocument, submittedPrompt?: string) => !draftRef.current && base.designId === documentRef.current.designId && base.revision === documentRef.current.revision && base.designHash === documentRef.current.designHash && (submittedPrompt === undefined || submittedPrompt === promptRef.current);
  const generation = useRef(0);
  const endedGenerations = useRef(new Map<number, 'cancelled' | 'stale' | 'expired'>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pollContext = useRef<PollContext | null>(null);
  const cancellationSent = useRef(new Set<string>());
  const runRef = useRef<Run | null>(null); runRef.current = run;

  function decide(runId: string, status: AiEvidence['decision']['status'], adopted?: DesignDocument, reason?: string) {
    setEvidence(items => items.map(item => item.runId === runId ? {...item, decision: {status, at: new Date().toISOString(), ...(adopted ? {adopted: designStamp(adopted)} : {}), ...(reason ? {reason} : {})}} : item));
  }
  function observe(candidate: Run, context: Omit<PollContext, 'runId'>) {
    setEvidence(items => {
      const entry = observeRun(items.find(item => item.runId === candidate.id), candidate, context.base, context.prompt, context.requestedAt);
      const ended = endedGenerations.current.get(context.ticket) ?? (!isCurrent(context.base, context.prompt) ? 'stale' : undefined);
      if (ended) entry.decision = {status: ended, at: new Date().toISOString(), reason: ended === 'expired' ? 'サーバー側の作業が失効しました。以前の候補は反映していません。' : '実行開始後に画面で中断、または依頼・設計を変更しました。届いた候補は反映していません。'};
      return [...items.filter(item => item.runId !== candidate.id), entry].slice(-20);
    });
  }
  function rememberResponse(candidate: Run) {
    setEvidence(items => items.map(item => item.runId === candidate.id ? {...item, observedAt: new Date().toISOString(), serverRun: publicRunSnapshot(candidate)} : item));
  }
  async function cancelServerRun(session: Session, runId: string, accessCode: string) {
    const key = `${session.sessionId}:${runId}`;
    if (cancellationSent.current.has(key)) return;
    cancellationSent.current.add(key);
    try {const result = await request<{run: Run}>(`/api/sessions/${session.sessionId}/runs/${runId}`, 'DELETE', undefined, session.token, accessCode); rememberResponse(result.run); return result.run;}
    catch (error) {cancellationSent.current.delete(key); throw error;}
  }
  function endGeneration(kind: 'cancelled' | 'stale' | 'expired') {
    endedGenerations.current.set(generation.current, kind);
    // A session itself is bounded to 100 runs. Keep only recent local generations, too.
    if (endedGenerations.current.size > 100) endedGenerations.current.delete(endedGenerations.current.keys().next().value!);
    generation.current++; clearTimeout(timer.current); pollContext.current = null; setPollInterrupted(false); setBusy(false);
  }
  function releaseExpiredSession(error: unknown): boolean {
    if (!(error instanceof ApiRequestError) || !['unauthorized', 'not_found'].includes(error.code ?? '')) return false;
    const current = runRef.current;
    endGeneration('expired');
    if (current) decide(current.id, 'expired', undefined, 'サーバー側の作業が失効しました。現在の作品へ以前の候補を反映していません。');
    sessionRef.current = null; pollContext.current = null;
    setRun(null); runRef.current = null; setInterpretationDraft(false); setUnsupported(false);
    setMessage('サーバー側の作業が失効しました。現在の作品と希望は残っています。「AIで案をつくる」で新しく実行するか、手動の調整に戻れます。');
    return true;
  }
  function discardCurrent(reason: string) {
    const current = runRef.current, session = sessionRef.current;
    endGeneration('stale');
    if (current && ['running', 'awaiting_approval', 'clarification_required'].includes(current.status)) decide(current.id, 'stale', undefined, reason);
    setRun(null); runRef.current = null;
    if (current && session && ['running', 'awaiting_approval', 'clarification_required'].includes(current.status)) {
      void cancelServerRun(session, current.id, access).catch(() => undefined);
    }
  }
  async function checkConnection(explicit = false) {
    if (connectionChecking.current) return;
    const ticket = ++connectionTicket.current;
    connectionChecking.current = true; setCheckingConnection(true);
    try {
      const result = await request<{ai: typeof connection; limits?: typeof limits}>('/api/status', 'GET');
      if (ticket !== connectionTicket.current) return;
      setConnection(result.ai); setLimits(result.limits ?? null);
      if (explicit) setMessage(result.ai.enabled ? 'サーバーの設定を確認しました。AIへの依頼はまだ送っていません。「AIで案をつくる」で実行できます。' : 'サーバーの設定を確認しました。このサイトではAIは無効です。手動での編集と出力を続けられます。');
    } catch {
      if (ticket !== connectionTicket.current) return;
      setConnection({enabled: false, mode: 'manual', unreachable: true});
      if (explicit) setMessage('サーバーの状態を確認できません。現在の作品と希望は残っています。接続状態を再確認するか、手動での編集と出力を続けてください。');
    } finally {
      if (ticket === connectionTicket.current) {connectionChecking.current = false; setCheckingConnection(false);}
    }
  }
  useEffect(() => {
    void checkConnection();
    return () => {connectionTicket.current++; connectionChecking.current = false; generation.current++; clearTimeout(timer.current);};
  }, []);
  useEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity;
    const current = runRef.current, wasBusy = busyRef.current;
    if (current?.status === 'succeeded' && acceptedIdentity.current === identity) {clearTimeout(timer.current); setBusy(false); return;}
    if (!current && !wasBusy && !pollContext.current) return;
    discardCurrent('設計または選択が変わったため、この実行の結果を現在の作品へ反映していません。');
    setMessage('設計が変わったため、以前の変更案と実行結果を無効にしました。実行記録は残っています。');
  }, [identity]);
  useEffect(() => {
    if (previousPrompt.current === prompt) return;
    previousPrompt.current = prompt;
    const active = !!runRef.current || busyRef.current || !!pollContext.current;
    if (active) discardCurrent('別の入力欄で希望が変わったため、以前の依頼の候補を無効にしました。');
    setUnsupported(false);
    setMessage(active ? '希望が変わったため、以前の変更案を無効にしました。現在の作品は変わっていません。' : '');
  }, [prompt]);
  useEffect(() => {onCandidateChange?.(run?.status === 'awaiting_approval' && !!run.proposal);}, [run?.status, run?.proposal, onCandidateChange]);
  useEffect(() => {
    if (!busy && !pollInterrupted) { waitStarted.current = null; return; }
    waitStarted.current ??= performance.now();
    const update = () => setWaitSeconds(Math.floor((performance.now() - waitStarted.current!) / 1000));
    update(); const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [busy, pollInterrupted]);

  useEffect(() => {
    if (retryAt === null) return;
    let timeout: ReturnType<typeof setTimeout>;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      setRetrySeconds(remaining);
      if (remaining > 0) timeout = setTimeout(update, 1000);
    };
    update();
    return () => clearTimeout(timeout);
  }, [retryAt]);

  function editPrompt(value: string) {
    if (value === promptRef.current) return;
    previousPrompt.current = value; promptRef.current = value;
    if (runRef.current || busyRef.current || pollContext.current) discardCurrent('依頼文を書き直したため、以前の依頼の候補を無効にしました。');
    setLocalPrompt(value); onRequestTextChange?.(value); setUnsupported(false); setMessage('');
  }
  async function receive(candidate: Run, context: PollContext) {
    if (candidate.proposal) candidate = {...candidate, proposal: {...candidate.proposal, document: parseDesignDocument(candidate.proposal.document)}};
    observe(candidate, context);
    if (context.ticket !== generation.current || !isCurrent(context.base, context.prompt)) {
      if (['running', 'awaiting_approval', 'clarification_required'].includes(candidate.status)) void cancelServerRun(context.session, candidate.id, context.access).catch(() => undefined);
      return;
    }
    setUnsupported(candidate.error?.code === 'unsupported_motion');
    setRun(candidate); runRef.current = candidate; setMessage(candidate.error?.message ?? candidate.message); setPollInterrupted(false);
    if (candidate.status === 'running') {
      pollContext.current = context;
      timer.current = setTimeout(() => void poll(context), 650);
    } else {clearTimeout(timer.current); pollContext.current = null; setBusy(false);}
  }
  async function poll(context: PollContext) {
    if (context.ticket !== generation.current || !isCurrent(context.base, context.prompt)) return;
    try {
      const next = await request<{run: Run}>(`/api/sessions/${context.session.sessionId}/runs/${context.runId}`, 'GET', undefined, context.session.token, context.access);
      await receive(next.run, context);
    } catch (error) {
      if (context.ticket !== generation.current || !isCurrent(context.base, context.prompt)) return;
      if (releaseExpiredSession(error)) return;
      setMessage(`${error instanceof Error ? error.message : '通信に失敗しました。'} 実行結果の確認が止まっています。「状況を確認する」で同じ実行を確認できます。`);
      setPollInterrupted(true); setBusy(false);
    }
  }
  async function resumePolling() {
    const context = pollContext.current;
    if (!context || busyRef.current) return;
    setBusy(true); setPollInterrupted(false); setMessage('同じ実行の状況を確認しています。新しいAI依頼は送信しません。');
    await poll(context);
  }
  async function start(correction?: RunCorrection) {
    if (busyRef.current || cancellingRef.current || !selectionReady || draftRef.current || pollContext.current || retryAt !== null && Date.now() < retryAt) return;
    if (!connection.enabled) {setMessage(connection.unreachable ? 'サーバーに接続できません。現在の作品は残っています。手動での編集と出力は続けられます。' : 'AIは未接続です。寸法から案をつくり、保存・印刷まで進められます。'); return;}
    if (!access.trim()) {setCodeRequired(true); setMessage('AIだけにアクセスコードが必要です。手動での制作・保存・印刷はそのまま使えます。'); return;}
    setCodeRequired(false); setRetryAt(null); setRetrySeconds(0);
    if (correction) {
      // The server replaces a live proposal atomically with its bound correction.
      // A preceding DELETE would revoke that source before correction validation.
      endGeneration('stale'); decide(correction.runId, 'stale', undefined, '解釈を訂正して検査し直しました。以前の候補は採用していません。');
    } else if (runRef.current?.status === 'awaiting_approval') discardCurrent('新しい依頼を実行するため、以前の候補を無効にしました。');
    const ticket = ++generation.current, base = documentRef.current, submittedPrompt = prompt, requestedAt = new Date().toISOString(), submittedAccess = access;
    waitStarted.current = performance.now(); setWaitSeconds(0);
    setBusy(true); setRun(null); runRef.current = null; setMessage('設計条件を読み取り、変更案を検査しています。'); setUnsupported(false); setPollInterrupted(false);
    try {
      let session = sessionRef.current;
      if (!session || session.designId !== base.designId) {
        const created = await request<{sessionId: string; token: string}>('/api/sessions', 'POST', {document: base});
        if (ticket !== generation.current || !isCurrent(base, submittedPrompt)) return;
        session = {...created, designId: base.designId}; sessionRef.current = session;
      } else {
        session = {...session}; sessionRef.current = session;
        await request(`/api/sessions/${session.sessionId}/document`, 'PUT', {document: base}, session.token);
      }
      if (ticket !== generation.current || !isCurrent(base, submittedPrompt)) return;
      const result = await request<{run: Run}>(`/api/sessions/${session.sessionId}/runs`, 'POST', {requestId: crypto.randomUUID(), prompt: submittedPrompt, baseRevision: base.revision, baseHash: base.designHash, ...(correction ? {correction} : {})}, session.token, submittedAccess);
      await receive(result.run, {session, runId: result.run.id, base, ticket, prompt: submittedPrompt, requestedAt, access: submittedAccess});
    } catch (error) {if (ticket === generation.current) {if (releaseExpiredSession(error)) return; sessionRef.current = null; setUnsupported(error instanceof ApiRequestError && error.code === 'unsupported_motion'); setMessage(error instanceof ApiRequestError && error.code === 'instance_limit' ? 'AIへの依頼が続いています。時間をおいて再度お試しください。作品は変更していません。' : error instanceof Error ? error.message : '実行に失敗しました。'); if (error instanceof ApiRequestError && error.retryAt !== undefined) {setRetryAt(error.retryAt); setRetrySeconds(Math.max(0, Math.ceil((error.retryAt - Date.now()) / 1000)));} setCodeRequired(error instanceof ApiRequestError && error.code === 'access_denied'); setBusy(false);}}
  }
  async function correctInterpretation(changes: InterpretationChanges) {
    const current = runRef.current;
    if (!current?.requestInterpretation || busyRef.current || draftRef.current) return;
    const binding = current.requestInterpretation.binding;
    if (binding.designId !== documentRef.current.designId || binding.baseHash !== documentRef.current.designHash || binding.baseRevision !== documentRef.current.revision) {
      discardCurrent('解釈の基準となる作品が変わっています。'); setMessage('現在の作品から解釈し直してください。'); return;
    }
    await start({runId: current.id, requestId: current.requestId, changes: {...changes, binding}});
  }
  async function cancel() {
    if (cancellingRef.current) return;
    const current = runRef.current, session = sessionRef.current;
    endGeneration('cancelled'); const ticket = generation.current;
    if (current) decide(current.id, 'cancelled', undefined, '画面で中断しました。届いた結果は反映しません。送信済みの処理が止まったかは実行記録で確認します。');
    setRun(null); runRef.current = null;
    let confirmed = false;
    if (current && session) {
      cancellingRef.current = true; setCancelling(true);
      setMessage('中断を要求しています。現在の作品は変わっていません。手動の編集は続けられます。');
      try {confirmed = (await cancelServerRun(session, current.id, access))?.status === 'cancelled';}
      catch (error) {if (ticket === generation.current && !releaseExpiredSession(error)) setMessage('画面での待機を中断しました。サーバーへの中断要求は届きませんでした。送信済みの呼び出しは取り消せないことがあります。'); return;}
      finally {cancellingRef.current = false; setCancelling(false);}
    }
    if (ticket === generation.current) setMessage(confirmed ? '中断しました。届いた結果は反映しません。サーバーが中断要求を確認しました。別の依頼を実行できます。送信済みのAPI処理や課金の停止は保証しません。' : '画面での待機を中断しました。届いた結果は反映しません。サーバー側の中断はまだ確認できていません。');
  }
  async function resolveProposal(accept: boolean) {
    const session = sessionRef.current;
    if (!run?.proposal || !session || busyRef.current || draftRef.current || interpretationDraft) return;
    if (run.baseHash !== documentRef.current.designHash || run.baseRevision !== documentRef.current.revision) {discardCurrent('古い設計への変更案です。'); setMessage('古い設計への変更案です。新しい設計で再実行してください。'); return;}
    waitStarted.current = performance.now(); setWaitSeconds(0); setBusy(true);
    const base = documentRef.current, ticket = generation.current, submittedPrompt = promptRef.current;
    try {
      const path = `/api/sessions/${session.sessionId}/proposals/${run.proposal.id}`;
      if (accept) {
        const result = await request<{document: DesignDocument}>(`${path}/approve`, 'POST', {requestId: run.requestId, baseRevision: run.baseRevision, baseHash: run.baseHash}, session.token, access);
        if (ticket !== generation.current || !isCurrent(base, submittedPrompt)) {decide(run.id, 'stale', undefined, '採用応答が届く前に作品を変更したため、この応答を適用していません。'); if (sessionRef.current === session) sessionRef.current = null; return;}
        const next = parseDesignDocument(result.document);
        const accepted = {...run, status: 'succeeded' as const, proposal: undefined}; runRef.current = accepted;
        acceptedIdentity.current = `${next.designId}:${next.revision}:${next.designHash}:${selectionReady}:false`;
        decide(run.id, 'accepted', next); setRun(accepted); onAccept(next); setMessage(`第${next.revision}版に変更案を採用しました。印刷して作る工程から、この版のPDFを出力できます。`);
      } else {
        const result = await request<{run: Run}>(path, 'DELETE', undefined, session.token, access); rememberResponse(result.run);
        if (ticket !== generation.current) return;
        decide(run.id, 'rejected'); setRun(null); runRef.current = null; setMessage('変更案を却下しました。設計は変わりません。実行記録は残っています。');
      }
    } catch (error) {if (ticket === generation.current && !releaseExpiredSession(error)) setMessage(error instanceof Error ? error.message : '変更案を処理できませんでした。');}
    finally {if (ticket === generation.current) setBusy(false);}
  }
  function exportEvidence() {
    if (!evidence.length) return;
    const latest = evidence.at(-1)!;
    downloadFile(JSON.stringify({format: 'ugoku-kami-ai-run', version: 1, exportedAt: new Date().toISOString(), records: evidence}, null, 2), 'application/json', `${latest.runId}.ai-run.json`);
  }
  const connectionLabel = connection.enabled ? connection.mode === 'injected-test' ? '模擬AI（テスト）' : connection.mode === 'ollama' ? 'ローカルAI' : connection.mode === 'vertex' ? 'Vertex AI（設定済み）' : 'Gemini（設定済み）' : '手動で編集中';
  useEffect(() => {onConnectionLabel?.(connectionLabel);}, [connectionLabel, onConnectionLabel]);
  const awaitingProposal = !!run?.proposal && run.status === 'awaiting_approval';
  const settings = <section className="ai-settings" aria-label="AIの設定">
    <h3>{connectionLabel}</h3>
    {connection.enabled ? <>
      <p>{connection.mode === 'injected-test' ? 'テスト用の模擬AIです。実モデルへの送信はありません。' : connection.mode === 'ollama' ? 'アプリのサーバー内で動くOllamaを使う設定です。外部の推論APIへ自動で切り替えません。設定済みの表示だけでは、接続成功を確認していません。' : connection.mode === 'vertex' ? 'Vertex AIを使う設定です。認証はサーバー側で行います。設定済みの表示だけでは、接続成功を確認していません。' : 'Gemini Developer APIを使う設定です。設定済みの表示だけでは、接続成功を確認していません。'}</p>
      {connection.mode === 'injected-test' && connection.provider === 'vertex' && <p className="field-note">接続方式：Vertex AI（模擬）</p>}
      <label className="field">AIアクセスコード<input type="password" value={access} onChange={event => {setAccess(event.target.value); if (event.target.value.trim()) setCodeRequired(false);}} autoComplete="off" spellCheck={false} /><small>この画面のメモリだけで扱い、作品には保存しません。</small></label>
      {connection.model && <p className="field-note">モデル：{connection.model}</p>}{connection.endpoint && <p className="field-note">接続先：<code>{connection.endpoint}</code></p>}{connection.contextLength && <p className="field-note">コンテキスト上限：{connection.contextLength} / {connection.toolMode}</p>}{limits && <p className="field-note">1依頼の上限：モデル{limits.modelCalls}回・ツール{limits.toolCalls}回・{limits.timeoutMs / 1000}秒</p>}
      <p className="field-note">{connection.mode === 'ollama' ? '推論にはアプリのサーバーの計算資源と電力を使います。外部推論APIへの課金はありません。モデルの初回取得には外部通信が必要です。' : connection.mode === 'injected-test' ? '模擬実行の結果は、実モデルの性能確認にはなりません。' : '外部推論APIの利用料が発生する場合があります。'}</p>
    </> : <p>{connection.unreachable ? 'サーバーの状態を確認できません。' : 'このサイトではAIは無効です。'} 方向・距離の操作や、寸法からの案づくりを続けられます。</p>}
    <p className="field-note">案をつくる操作をしたときだけ、希望・寸法・選択範囲を送ります。画像そのものは送信しません。</p>
  </section>;
  const action = <button data-design-action onClick={() => {onActivate?.(); void start();}} disabled={busy || cancelling || retrySeconds > 0 || pollInterrupted || interpretationDraft || !prompt.trim() || !selectionReady || inputDraftActive} className="secondary">{cancelling ? '中断要求を確認中…' : run?.status === 'failed' ? 'AIを再試行する' : busy ? 'AIの案を待っています…' : 'AIで案をつくる'}</button>;
  const failedValidation = run?.status === 'failed' && run.error?.code === 'validation_failed'
    && message === (run.error.message ?? run.message) && !!run.validationIssues?.length;
  const distance = run?.requestInterpretation?.interpretation.distance;
  const requestedDistance = failedValidation && run?.baseHash === document.designHash && run.baseRevision === document.revision
    && distance && (distance.kind === 'absolute' || distance.kind === 'relative')
    ? distanceTargetMm(document.input.travelMm, distance) : undefined;
  const statusMessage = failedValidation
    ? `${requestedDistance !== undefined && Number.isFinite(requestedDistance) ? `希望${displayDimension(requestedDistance)}mm。` : ''}この条件では未成立です。作品と固定条件は変更していません。下の理由を確認し、変更してよい条件を見直してください。`
    : message;
  return <>
    {actionTarget && createPortal(action, actionTarget)}
    {settingsTarget && createPortal(<>{settings}
    {!!evidence.length && <details className="ai-evidence"><summary>AI実行の記録（{evidence.length}件）</summary><p className="field-note">この画面で受け取った直近20件を保存できます。依頼文・モデル・ツール・検査・使用量・採用した版を含みます。画像やアクセスコードは含めません。</p><ul>{evidence.map(item => <li key={item.runId}><strong>{item.execution.mode === 'ollama' ? '実ローカルAI' : item.execution.mode === 'gemini' ? '実Gemini' : item.execution.mode === 'vertex' ? '実Vertex AI' : item.execution.mode === 'injected-test' ? '模擬実行' : '実行方式は未確認'}{item.execution.provider === 'vertex' && item.execution.mode !== 'vertex' ? '（Vertex AI）' : ''}</strong> · {item.execution.model ?? 'モデル名未取得'}<br /><code>{item.runId}</code><br />{({pending:'候補待ち／未採用',accepted:'採用済み',rejected:'不採用',cancelled:'中断',stale:'依頼・設計が変わったため無効',expired:'サーバー側の作業が失効',failed:'失敗',completed:'応答完了'})[item.decision.status]}{item.decision.adopted ? ` · 第${item.decision.adopted.revision}版` : ''}<br />モデル {item.serverRun.modelCalls}回 / ツール {item.serverRun.toolCalls}回 / {usageLabel(item.serverRun)}</li>)}</ul><button className="secondary" onClick={exportEvidence}>AI実行記録を書き出す</button><p className="field-note">使用量未取得は0料金を意味しません。実物確認の記録は工程3で追加します。</p></details>}
    {!!run?.events?.length && <details><summary>実際の操作ログ（{run.toolCalls}回）</summary><ol className="execution-log">{run.events.map((event, index) => <li key={index}>{event.tool ?? event.name ?? event.type} {event.message}</li>)}</ol><small>モデル {run.modelCalls}回 · ツール {run.toolCalls}回 · {(run.elapsedMs / 1000).toFixed(1)}秒</small></details>}</>, settingsTarget)}
    <section className="ai-panel" aria-label="AIの調整結果" hidden={!visible}>
    {(busy || pollInterrupted) && <div className="ai-wait"><p>{pollInterrupted ? '通信の確認が必要です。現在の作品は変わっていません。' : run?.status === 'awaiting_approval' ? '採用の結果を確認しています。' : '候補を待っています。現在の作品は変わっていません。'}</p><p>経過 {waitSeconds}秒 · 中断して手動で調整できます。</p><div className="button-row">{pollInterrupted && <button className="secondary" onClick={() => void resumePolling()}>状況を確認する</button>}<button onClick={() => void cancel()} className="text-button">中断する</button></div></div>}
    {statusMessage && !busy && <p role="status" className={`notice ${unsupported || run?.status === 'failed' ? 'warning' : ''}`}>{statusMessage}</p>}
    {codeRequired && onOpenSettings && <button className="text-button" onClick={onOpenSettings}>AIの設定を開く</button>}
    {retryAt !== null && <p className="field-note" role="status">{retrySeconds > 0 ? `サーバーの案内による待機：あと約${retrySeconds}秒。` : '案内された待機時間が過ぎました。必要なら、もう一度ボタンを押してください。'} 自動では再送信しません。</p>}
    {connection.unreachable && <button className="secondary" disabled={checkingConnection} onClick={() => void checkConnection(true)}>{checkingConnection ? '接続状態を確認中…' : '接続状態を再確認する'}</button>}
    {unsupported && <button className="text-button" onClick={() => { editPrompt('引っぱりタブでまっすぐ動く距離を調整したい'); setUnsupported(false); setMessage('代案を入力しました。実行するか、手動で調整してください。'); }}>代案「まっすぐ動かす」を選ぶ</button>}

    {run?.status === 'clarification_required' && !busy && <button className="text-button" onClick={() => void cancel()}>この依頼を取り消す</button>}
    {visible && run?.proposal && run.status === 'awaiting_approval' && run.baseHash === document.designHash && run.baseRevision === document.revision && <div className="proposal"><h3>AIの変更案 · 採用待ち</h3>{run.proposal.fulfillsRequested === false && <p className="notice warning">希望の{run.proposal.requestedTravelMm}mmに対し、候補は{run.proposal.document.input.travelMm}mmです。希望と異なる距離であることを確認してから採用してください。</p>}<DesignComparison previewTarget={visible ? previewTarget : null} before={document} after={run.proposal.document} imageDataUrl={imageDataUrl} backgroundImageDataUrl={backgroundImageDataUrl} preserved={run.proposal.protectedConditions ?? run.intentSummary?.protections ?? document.input.locks.map(key => `${fieldNames[key] ?? key}を固定`)}><div className="button-row"><button className="primary" disabled={busy || inputDraftActive || interpretationDraft || getKitSummary(run.proposal.document).status === 'blocked'} data-design-action onClick={() => void resolveProposal(true)}>この案にする</button><button className="secondary" disabled={busy} onClick={() => void resolveProposal(false)}>この案を使わない</button></div></DesignComparison></div>}
    {!busy && onManual && (message || run) && (!connection.enabled || unsupported || run?.status === 'failed' || !run && !!message) && <button className="text-button" onClick={onManual}>{failedValidation ? '条件を見直す' : '手動の調整に戻る'}</button>}
    {run?.requestInterpretation && !busy && run.baseHash === document.designHash && run.baseRevision === document.revision && run.status !== 'succeeded' && run.status !== 'cancelled' && <RequestInterpretation compact={awaitingProposal} value={run.requestInterpretation} document={document} source="ai" disabled={busy || inputDraftActive || !selectionReady || !['awaiting_approval', 'clarification_required'].includes(run.status)} onCorrect={changes => void correctInterpretation(changes)} onDraftChange={setInterpretationDraft} />}
    {awaitingProposal && <button className="text-button" onClick={() => {void cancel(); onManual?.();}}>設定を編集する</button>}
    {!!run?.validationIssues?.length && <div className="notice warning"><h3>設計で見つかった問題</h3>{run.validationIssues.map(issue => <p key={issue.id}>{issue.partIds.join('・')}：{issue.message} {issue.suggestion}</p>)}</div>}
    {!!run?.constraintSuggestions?.length && <div className="notice"><h3>条件を見直す案</h3><p>採用候補ではありません。固定条件や希望の変更は、必要な場合だけ手動で行い、再検査してください。</p>{run.constraintSuggestions.map((item, index) => <p key={index}>{fieldNames[item.key] ?? item.key} → {String(item.value)}：{item.reason}<br />{item.source === 'model' && item.verification?.geometry === 'pass' && item.verification.source === 'deterministic-core' && item.verification.baseHash === run.baseHash && item.verification.baseRevision === run.baseRevision ? 'モデルの案。希望と直近の変更内容へこの1条件を加え、寸法・紙面を共通コアで検査しました。条件変更は未承認、実物未確認です。' : 'この値で成立するかは未検査です。'}（自動では変更しません）</p>)}</div>}

    </section>
  </>;
}

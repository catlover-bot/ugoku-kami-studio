import { useEffect, useMemo, useRef, useState } from 'react';
import { displayDimension, getKitSummary, interpretDesignRequest, parseDesignDocument, type DesignDocument, type InterpretationChanges, type InterpretationCorrection } from '@ugoku/core';
import DesignComparison, { fieldNames } from './DesignComparison';
import { designStamp, observeRun, publicRunSnapshot, usageLabel, type AiRun as Run, type AiEvidence } from './aiEvidence';
import { downloadFile } from './project';
import './AiPanel.css';
import RequestInterpretation from './RequestInterpretation';

type RunCorrection = {runId: string; requestId: string; changes: InterpretationCorrection};
class ApiRequestError extends Error { constructor(message: string, readonly code?: string) {super(message);} }
type Session = {sessionId: string; token: string; designId: string};
type PollContext = {session: Session; runId: string; base: DesignDocument; ticket: number; prompt: string; requestedAt: string; access: string};
async function request<T>(url: string, method: string, body?: unknown, token?: string, access?: string): Promise<T> {
  const response = await fetch(url, {method, headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(access ? {'X-AI-Access': access} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  const result = await response.json() as T & {error?: {message?: string; code?: string} | string; message?: string};
  if (!response.ok) throw new ApiRequestError(typeof result.error === 'string' ? result.error : result.error?.message ?? result.message ?? '通信に失敗しました。接続を確認して再試行してください。', typeof result.error === 'object' ? result.error.code : undefined);
  return result;
}

type AiPanelProps = {
  document: DesignDocument; imageDataUrl: string; backgroundImageDataUrl?: string;
  onCandidateChange?: (active: boolean) => void; onAccept: (document: DesignDocument) => void;
  selectionReady?: boolean; inputDraftActive?: boolean; onManual?: () => void;
  requestText?: string; onRequestTextChange?: (value: string) => void;
};
export default function AiPanel({document, imageDataUrl, backgroundImageDataUrl, onAccept, inputDraftActive = false, selectionReady = true, onCandidateChange, onManual, requestText, onRequestTextChange}: AiPanelProps) {
  const [connection, setConnection] = useState<{enabled: boolean; reason?: string; mode: string; model?: string | null; unreachable?: boolean}>({enabled: false, mode: 'manual', reason: '接続を確認中です。'});
  const [localPrompt, setLocalPrompt] = useState('もう少し大きく動かしたい。絵の大きさは変えず、紙も増やさない');
  const prompt = requestText ?? localPrompt;
  const promptRef = useRef(prompt); promptRef.current = prompt;
  const previousPrompt = useRef(prompt);
  const [access, setAccess] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = (value: boolean) => {busyRef.current = value; setBusyState(value);};
  const [message, setMessage] = useState('');
  const [interpretationDraft, setInterpretationDraft] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [pollInterrupted, setPollInterrupted] = useState(false);
  const [evidence, setEvidence] = useState<AiEvidence[]>([]);
  const sessionRef = useRef<Session | null>(null);
  const documentRef = useRef(document); documentRef.current = document;
  const draftRef = useRef(inputDraftActive); draftRef.current = inputDraftActive;
  const identity = `${document.designId}:${document.revision}:${document.designHash}:${selectionReady}:${inputDraftActive}`;
  const previousIdentity = useRef(identity);
  const acceptedIdentity = useRef<string | null>(null);
  const isCurrent = (base: DesignDocument, submittedPrompt?: string) => !draftRef.current && base.designId === documentRef.current.designId && base.revision === documentRef.current.revision && base.designHash === documentRef.current.designHash && (submittedPrompt === undefined || submittedPrompt === promptRef.current);
  const generation = useRef(0);
  const endedGenerations = useRef(new Map<number, 'cancelled' | 'stale'>());
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
      if (ended) entry.decision = {status: ended, at: new Date().toISOString(), reason: '実行開始後に画面で中断、または依頼・設計を変更しました。届いた候補は反映していません。'};
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
    try {const result = await request<{run: Run}>(`/api/sessions/${session.sessionId}/runs/${runId}`, 'DELETE', undefined, session.token, accessCode); rememberResponse(result.run);}
    catch (error) {cancellationSent.current.delete(key); throw error;}
  }
  function endGeneration(kind: 'cancelled' | 'stale') {
    endedGenerations.current.set(generation.current, kind);
    // A session itself is bounded to 100 runs. Keep only recent local generations, too.
    if (endedGenerations.current.size > 100) endedGenerations.current.delete(endedGenerations.current.keys().next().value!);
    generation.current++; clearTimeout(timer.current); pollContext.current = null; setPollInterrupted(false); setBusy(false);
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
  useEffect(() => {
    let current = true;
    request<{ai: typeof connection}>('/api/status', 'GET').then(result => {if (current) setConnection(result.ai);}).catch(() => {if (current) setConnection({enabled: false, mode: 'manual', unreachable: true});});
    return () => {current = false; generation.current++; clearTimeout(timer.current);};
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
    } else {pollContext.current = null; setBusy(false);}
  }
  async function poll(context: PollContext) {
    if (context.ticket !== generation.current || !isCurrent(context.base, context.prompt)) return;
    try {
      const next = await request<{run: Run}>(`/api/sessions/${context.session.sessionId}/runs/${context.runId}`, 'GET', undefined, context.session.token, context.access);
      await receive(next.run, context);
    } catch (error) {
      if (context.ticket !== generation.current || !isCurrent(context.base, context.prompt)) return;
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
    if (busyRef.current || !selectionReady || draftRef.current || pollContext.current) return;
    if (!connection.enabled) {setMessage('AIは未接続です。手動支援で希望を試し、保存・印刷まで進められます。'); return;}
    if (!access.trim()) {setMessage('「AIを利用する」を開き、アクセスコードを入力してください。'); return;}
    if (correction) {
      // The server replaces a live proposal atomically with its bound correction.
      // A preceding DELETE would revoke that source before correction validation.
      endGeneration('stale'); decide(correction.runId, 'stale', undefined, '解釈を訂正して検査し直しました。以前の候補は採用していません。');
    } else if (runRef.current?.status === 'awaiting_approval') discardCurrent('新しい依頼を実行するため、以前の候補を無効にしました。');
    const ticket = ++generation.current, base = documentRef.current, submittedPrompt = prompt, requestedAt = new Date().toISOString(), submittedAccess = access;
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
    } catch (error) {if (ticket === generation.current) {sessionRef.current = null; setUnsupported(error instanceof ApiRequestError && error.code === 'unsupported_motion'); setMessage(error instanceof Error ? error.message : '実行に失敗しました。'); setBusy(false);}}
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
    const current = runRef.current, session = sessionRef.current;
    endGeneration('cancelled'); const ticket = generation.current;
    if (current) decide(current.id, 'cancelled', undefined, '画面で中断しました。送信済みの呼び出しの課金取消しは保証されません。');
    setRun(null); runRef.current = null;
    if (current && session) {
      try {await cancelServerRun(session, current.id, access);}
      catch {if (ticket === generation.current) setMessage('画面での待機を中断しました。サーバーへの中断要求は届きませんでした。送信済みの呼び出しは取り消せないことがあります。'); return;}
    }
    if (ticket === generation.current) setMessage('中断しました。送信済みの呼び出しの課金取消しは保証されません。編集内容と実行記録は残っています。');
  }
  async function resolveProposal(accept: boolean) {
    const session = sessionRef.current;
    if (!run?.proposal || !session || busyRef.current || draftRef.current || interpretationDraft) return;
    if (run.baseHash !== documentRef.current.designHash || run.baseRevision !== documentRef.current.revision) {discardCurrent('古い設計への変更案です。'); setMessage('古い設計への変更案です。新しい設計で再実行してください。'); return;}
    setBusy(true);
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
    } catch (error) {if (ticket === generation.current) setMessage(error instanceof Error ? error.message : '変更案を処理できませんでした。');}
    finally {if (ticket === generation.current) setBusy(false);}
  }
  function exportEvidence() {
    if (!evidence.length) return;
    const latest = evidence.at(-1)!;
    downloadFile(JSON.stringify({format: 'ugoku-kami-ai-run', version: 1, exportedAt: new Date().toISOString(), records: evidence}, null, 2), 'application/json', `${latest.runId}.ai-run.json`);
  }
  const requestIntent = useMemo(() => interpretDesignRequest(document, prompt), [document, prompt]);
  const protections = useMemo(() => {
    const values = new Map<string, unknown>(document.input.locks.map(key => [key, document.input[key]]));
    for (const [key, value] of Object.entries(requestIntent.protections)) if (value !== undefined) values.set(key, value);
    const labels: string[] = [];
    if (values.has('widthMm') && values.has('heightMm')) {
      labels.push(`絵の大きさ ${displayDimension(Number(values.get('widthMm')))} × ${displayDimension(Number(values.get('heightMm')))}mm を保つ`);
      values.delete('widthMm'); values.delete('heightMm');
    }
    const directions: Record<string, string> = { right: '右', left: '左', up: '上', down: '下' };
    for (const [key, value] of values) {
      if (key === 'maxSheets') labels.push(`型紙はA4で${value}枚まで`);
      else if (key === 'selection') labels.push('動かす部分を変えない');
      else if (key === 'direction') labels.push(`動く方向は${directions[String(value)] ?? String(value)}`);
      else labels.push(`${fieldNames[key] ?? key} ${String(value)}mm を保つ`);
    }
    return labels;
  }, [document, requestIntent]);
  const awaitingProposal = !!run?.proposal && run.status === 'awaiting_approval';
  const disconnectedMessage = connection.unreachable ? 'サーバーに接続できません。接続を確認してください。手動での編集と型紙出力は続けられます。' : 'AIは未接続です。手動支援で希望を試し、保存・印刷まで進められます。';
  return <section className="ai-panel" aria-labelledby="ai-title">
    <div className="section-top"><div><h2 id="ai-title">Geminiに相談する</h2></div><span className="connection"><span className={connection.enabled ? 'dot connected' : 'dot'} />{connection.enabled ? connection.mode === 'injected-test' ? '模擬接続（テスト）' : 'Gemini設定済み' : 'AI未接続'}</span></div>
    <p className="ai-introduction">希望から変更案をつくり、今の作品と比べて選べます。作品が変わるのは、採用したときだけです。</p>
    {!connection.enabled && <p className="ai-availability">{disconnectedMessage}</p>}
    <details className="request-editor" open={!awaitingProposal}><summary>希望を編集する</summary>
      <label htmlFor="ai-prompt">どんな動きにしたいですか？</label>
      <textarea id="ai-prompt" value={prompt} onChange={event => editPrompt(event.target.value)} maxLength={2000} rows={3} placeholder="例：紙は2枚のまま、首をもう少し遠くまで動かしたい" aria-describedby="ai-request-example" />
      <p className="field-note" id="ai-request-example">例：もう少し大きく動かしたい。絵の大きさは変えず、紙は2枚まで。</p>
      <div className="ai-request-conditions" aria-labelledby="ai-conditions-title">
        <h3 id="ai-conditions-title">今回守る条件</h3>
        {protections.length ? <ul>{protections.map(item => <li key={item}>{item}</li>)}</ul> : <p className="field-note">大きさや紙の枚数など、変えたくないことも希望に書けます。</p>}
        {!!requestIntent.conflicts.length && <p className="notice warning">{requestIntent.conflicts.join(' ')}</p>}
      </div>
      <details className="ai-settings"><summary>AIを利用する</summary>
        {connection.enabled ? <>
          <p>{connection.mode === 'injected-test' ? 'テスト用の模擬AIです。実Geminiには送信しません。' : 'Geminiを利用する設定があります。設定済みの表示だけでは、接続の成功は確認できません。'}</p>
          <label className="field">AIアクセスコード<input type="password" value={access} onChange={event => setAccess(event.target.value)} autoComplete="off" spellCheck={false} placeholder="利用案内にあるコード" /><small>この画面のメモリだけで扱います。作品や実行記録には保存しません。</small></label>
          {connection.model && <p className="field-note">利用するモデル：{connection.model}</p>}
        </> : <p>現在このサイトではAIを利用できません。手動支援から、同じ作品を続けて編集できます。</p>}
      </details>
      <p className="field-note">{connection.mode === 'injected-test' ? '模擬AIで操作を試します。実Geminiへの送信はありません。' : '実行すると希望・設計寸法・選択範囲がGeminiへ送られます。画像そのものは送信しません。'}</p>
      {inputDraftActive && <p className="field-note">入力中の数値を確定するか、元の値に戻してから変更案をつくれます。</p>}
      {connection.enabled && !access.trim() && <p className="field-note">はじめに「AIを利用する」でアクセスコードを入力してください。</p>}
      <div className="button-row"><button data-design-action onClick={() => void start()} disabled={busy || pollInterrupted || interpretationDraft || !prompt.trim() || !selectionReady || inputDraftActive} className={connection.enabled ? 'primary' : 'secondary'}>{run?.status === 'failed' ? '再試行する' : busy ? '検査しています…' : '変更案をつくる'}</button></div>
    </details>
    {(busy || pollInterrupted) && <div className="ai-wait"><p>{pollInterrupted ? '通信の確認が必要です。現在の作品は変わっていません。' : run?.status === 'awaiting_approval' ? '採用の結果を確認しています。' : '候補を待っています。現在の作品は変わっていません。'}</p><div className="button-row">{pollInterrupted && <button className="secondary" onClick={() => void resumePolling()}>状況を確認する</button>}<button onClick={() => void cancel()} className="text-button">中断する</button></div></div>}
    {message && <p role="status" className={`notice ${unsupported || run?.status === 'failed' ? 'warning' : ''}`}>{message}</p>}
    {unsupported && <button className="text-button" onClick={() => { editPrompt('引っぱりタブでまっすぐ動く距離を調整したい'); setUnsupported(false); setMessage('代案を入力しました。実行するか、手動で調整してください。'); }}>代案「まっすぐ動かす」を選ぶ</button>}
    {run?.requestInterpretation && !busy && run.baseHash === document.designHash && run.baseRevision === document.revision && run.status !== 'succeeded' && run.status !== 'cancelled' && <RequestInterpretation value={run.requestInterpretation} document={document} source="ai" disabled={busy || inputDraftActive || !selectionReady || !['awaiting_approval', 'clarification_required'].includes(run.status)} onCorrect={changes => void correctInterpretation(changes)} onDraftChange={setInterpretationDraft} />}
    {run?.status === 'clarification_required' && !busy && <button className="text-button" onClick={() => void cancel()}>この依頼を取り消す</button>}
    {run?.proposal && run.status === 'awaiting_approval' && run.baseHash === document.designHash && run.baseRevision === document.revision && <div className="proposal"><h3>AIの変更案 · 採用待ち</h3>{run.proposal.fulfillsRequested === false && <p className="notice warning">希望の{run.proposal.requestedTravelMm}mmに対し、候補は{run.proposal.document.input.travelMm}mmです。希望と異なる距離であることを確認してから採用してください。</p>}<DesignComparison before={document} after={run.proposal.document} imageDataUrl={imageDataUrl} backgroundImageDataUrl={backgroundImageDataUrl} preserved={run.proposal.protectedConditions ?? run.intentSummary?.protections ?? document.input.locks.map(key => `${fieldNames[key] ?? key}を固定`)}><div className="button-row"><button className="primary" disabled={busy || inputDraftActive || interpretationDraft || getKitSummary(run.proposal.document).status === 'blocked'} data-design-action onClick={() => void resolveProposal(true)}>この案にする</button><button className="secondary" disabled={busy} onClick={() => void resolveProposal(false)}>この案を使わない</button></div></DesignComparison></div>}
    {!busy && onManual && (!connection.enabled || unsupported || run?.status === 'failed') && <button className={connection.enabled ? 'secondary' : 'primary'} onClick={onManual}>手動支援を使う</button>}
    {!!run?.validationIssues?.length && <div className="notice warning"><h3>設計で見つかった問題</h3>{run.validationIssues.map(issue => <p key={issue.id}>{issue.partIds.join('・')}：{issue.message} {issue.suggestion}</p>)}</div>}
    {!!run?.constraintSuggestions?.length && <div className="notice"><h3>条件変更の提案</h3>{run.constraintSuggestions.map((item, index) => <p key={index}>{fieldNames[item.key] ?? item.key} → {String(item.value)}：{item.reason}（自動では変更しません）</p>)}</div>}
    {!!evidence.length && <details className="ai-evidence"><summary>AI実行の記録（{evidence.length}件）</summary><p className="field-note">この画面で受け取った直近20件を保存できます。依頼文・モデル・ツール・検査・使用量・採用した版を含みます。画像やアクセスコードは含めません。</p><ul>{evidence.map(item => <li key={item.runId}><strong>{item.execution.mode === 'gemini' ? '実Gemini' : item.execution.mode === 'injected-test' ? '模擬実行' : '実行方式は未確認'}</strong> · {item.execution.model ?? 'モデル名未取得'}<br /><code>{item.runId}</code><br />{({pending:'候補待ち／未採用',accepted:'採用済み',rejected:'不採用',cancelled:'中断',stale:'依頼・設計が変わったため無効',failed:'失敗',completed:'応答完了'})[item.decision.status]}{item.decision.adopted ? ` · 第${item.decision.adopted.revision}版` : ''}<br />モデル {item.serverRun.modelCalls}回 / ツール {item.serverRun.toolCalls}回 / {usageLabel(item.serverRun)}</li>)}</ul><button className="secondary" onClick={exportEvidence}>AI実行記録を書き出す</button><p className="field-note">使用量未取得は0料金を意味しません。実物確認の記録は工程3で追加します。</p></details>}
    {!!run?.events?.length && <details><summary>実際の操作ログ（{run.toolCalls}回）</summary><ol className="execution-log">{run.events.map((event, index) => <li key={index}>{event.tool ?? event.name ?? event.type} {event.message}</li>)}</ol><small>モデル {run.modelCalls}回 · ツール {run.toolCalls}回 · {(run.elapsedMs / 1000).toFixed(1)}秒</small></details>}
  </section>;
}

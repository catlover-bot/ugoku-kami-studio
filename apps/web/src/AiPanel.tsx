import { useEffect, useRef, useState } from 'react';
import { getKitSummary, interpretDesignRequest, parseDesignDocument, type DesignDocument } from '@ugoku/core';
import DesignComparison, { fieldNames } from './DesignComparison';
import { designStamp, observeRun, publicRunSnapshot, usageLabel, type AiRun as Run, type AiEvidence } from './aiEvidence';
import { downloadFile } from './project';

type Session = {sessionId: string; token: string; designId: string};
type PollContext = {session: Session; runId: string; base: DesignDocument; ticket: number; prompt: string; requestedAt: string; access: string};
async function request<T>(url: string, method: string, body?: unknown, token?: string, access?: string): Promise<T> {
  const response = await fetch(url, {method, headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(access ? {'X-AI-Access': access} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  const result = await response.json() as T & {error?: {message?: string} | string; message?: string};
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message ?? result.message ?? '通信に失敗しました。接続を確認して再試行してください。');
  return result;
}

export default function AiPanel({document, imageDataUrl, backgroundImageDataUrl, onAccept, inputDraftActive = false, selectionReady = true, onCandidateChange, onManual}: {document: DesignDocument; imageDataUrl: string; backgroundImageDataUrl?: string; onCandidateChange?: (active: boolean) => void; onAccept: (document: DesignDocument) => void; selectionReady?: boolean; inputDraftActive?: boolean; onManual?: () => void}) {
  const [connection, setConnection] = useState<{enabled: boolean; reason?: string; mode: string; model?: string | null}>({enabled: false, mode: 'manual', reason: '接続を確認中です。'});
  const [prompt, setPrompt] = useState('もう少し大きく動かしたい。絵の大きさは変えず、紙も増やさない');
  const [access, setAccess] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = (value: boolean) => {busyRef.current = value; setBusyState(value);};
  const [message, setMessage] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [pollInterrupted, setPollInterrupted] = useState(false);
  const [evidence, setEvidence] = useState<AiEvidence[]>([]);
  const sessionRef = useRef<Session | null>(null);
  const documentRef = useRef(document); documentRef.current = document;
  const draftRef = useRef(inputDraftActive); draftRef.current = inputDraftActive;
  const identity = `${document.designId}:${document.revision}:${document.designHash}:${selectionReady}:${inputDraftActive}`;
  const previousIdentity = useRef(identity);
  const acceptedIdentity = useRef<string | null>(null);
  const isCurrent = (base: DesignDocument) => !draftRef.current && base.designId === documentRef.current.designId && base.revision === documentRef.current.revision && base.designHash === documentRef.current.designHash;
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
      const ended = endedGenerations.current.get(context.ticket);
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
    if (current && ['running', 'awaiting_approval'].includes(current.status)) decide(current.id, 'stale', undefined, reason);
    setRun(null); runRef.current = null;
    if (current && session && ['running', 'awaiting_approval'].includes(current.status)) {
      void cancelServerRun(session, current.id, access).catch(() => undefined);
    }
  }
  useEffect(() => {
    let current = true;
    request<{ai: typeof connection}>('/api/status', 'GET').then(result => {if (current) setConnection(result.ai);}).catch(() => {if (current) setConnection({enabled: false, mode: 'manual', reason: 'サーバーに接続できません。手動での編集と型紙出力は続けられます。'});});
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
  useEffect(() => {onCandidateChange?.(run?.status === 'awaiting_approval' && !!run.proposal);}, [run?.status, run?.proposal, onCandidateChange]);

  function editPrompt(value: string) {
    if (runRef.current || busyRef.current || pollContext.current) discardCurrent('依頼文を書き直したため、以前の依頼の候補を無効にしました。');
    setPrompt(value); setUnsupported(false); setMessage('');
  }
  async function receive(candidate: Run, context: PollContext) {
    if (candidate.proposal) candidate = {...candidate, proposal: {...candidate.proposal, document: parseDesignDocument(candidate.proposal.document)}};
    observe(candidate, context);
    if (context.ticket !== generation.current || !isCurrent(context.base)) {
      if (['running', 'awaiting_approval'].includes(candidate.status)) void cancelServerRun(context.session, candidate.id, context.access).catch(() => undefined);
      return;
    }
    setRun(candidate); runRef.current = candidate; setMessage(candidate.error?.message ?? candidate.message); setPollInterrupted(false);
    if (candidate.status === 'running') {
      pollContext.current = context;
      timer.current = setTimeout(() => void poll(context), 650);
    } else {pollContext.current = null; setBusy(false);}
  }
  async function poll(context: PollContext) {
    if (context.ticket !== generation.current || !isCurrent(context.base)) return;
    try {
      const next = await request<{run: Run}>(`/api/sessions/${context.session.sessionId}/runs/${context.runId}`, 'GET', undefined, context.session.token, context.access);
      await receive(next.run, context);
    } catch (error) {
      if (context.ticket !== generation.current || !isCurrent(context.base)) return;
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
  async function start() {
    if (busyRef.current || !selectionReady || pollContext.current) return;
    if (!interpretDesignRequest(documentRef.current, prompt).supported) {
      if (runRef.current) discardCurrent('新しい依頼は非対応のため、以前の候補を無効にしました。');
      setUnsupported(true); setMessage('その動きは未対応です。引っぱりタブの直線運動だけを作れます。作品は変更していません。直線運動の依頼を選ぶか、手動で動きを決めてください。'); return;
    }
    if (!connection.enabled) {setMessage(connection.reason ?? 'AI未接続です。手動で動きを決められます。'); return;}
    if (runRef.current?.status === 'awaiting_approval') discardCurrent('新しい依頼を実行するため、以前の候補を無効にしました。');
    const ticket = ++generation.current, base = documentRef.current, submittedPrompt = prompt, requestedAt = new Date().toISOString(), submittedAccess = access;
    setBusy(true); setRun(null); runRef.current = null; setMessage('設計条件を読み取り、変更案を検査しています。'); setUnsupported(false); setPollInterrupted(false);
    try {
      let session = sessionRef.current;
      if (!session || session.designId !== base.designId) {
        const created = await request<{sessionId: string; token: string}>('/api/sessions', 'POST', {document: base});
        if (ticket !== generation.current || !isCurrent(base)) return;
        session = {...created, designId: base.designId}; sessionRef.current = session;
      } else {
        session = {...session}; sessionRef.current = session;
        await request(`/api/sessions/${session.sessionId}/document`, 'PUT', {document: base}, session.token);
      }
      if (ticket !== generation.current || !isCurrent(base)) return;
      const result = await request<{run: Run}>(`/api/sessions/${session.sessionId}/runs`, 'POST', {requestId: crypto.randomUUID(), prompt: submittedPrompt, baseRevision: base.revision, baseHash: base.designHash}, session.token, submittedAccess);
      await receive(result.run, {session, runId: result.run.id, base, ticket, prompt: submittedPrompt, requestedAt, access: submittedAccess});
    } catch (error) {if (ticket === generation.current) {sessionRef.current = null; setMessage(error instanceof Error ? error.message : '実行に失敗しました。'); setBusy(false);}}
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
    if (!run?.proposal || !session || busyRef.current) return;
    if (run.baseHash !== documentRef.current.designHash || run.baseRevision !== documentRef.current.revision) {discardCurrent('古い設計への変更案です。'); setMessage('古い設計への変更案です。新しい設計で再実行してください。'); return;}
    setBusy(true);
    const base = documentRef.current, ticket = generation.current;
    try {
      const path = `/api/sessions/${session.sessionId}/proposals/${run.proposal.id}`;
      if (accept) {
        const result = await request<{document: DesignDocument}>(`${path}/approve`, 'POST', {requestId: run.requestId, baseRevision: run.baseRevision, baseHash: run.baseHash}, session.token, access);
        if (ticket !== generation.current || !isCurrent(base)) {decide(run.id, 'stale', undefined, '採用応答が届く前に作品を変更したため、この応答を適用していません。'); if (sessionRef.current === session) sessionRef.current = null; return;}
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
  return <section className="ai-panel" aria-labelledby="ai-title">
    <div className="section-top"><div><h2 id="ai-title">Geminiに相談する</h2></div><span className="connection"><span className={connection.enabled ? 'dot connected' : 'dot'} />{connection.enabled ? connection.mode === 'injected-test' ? '模擬接続（テスト）' : 'Gemini設定済み' : 'AI未接続'}</span></div>
    <details className="request-editor" open={!(run?.proposal && run.status === 'awaiting_approval')}><summary>希望を編集する</summary>
    <p className="muted">希望に合わせて、直線運動の寸法を調整します。変更は、あなたが採用してから。</p>
    {!connection.enabled && <p className="notice">{connection.reason || 'AIの利用は無効です。手動の設計・保存・型紙出力を利用できます。'}</p>}
    <label htmlFor="ai-prompt">どんな動きにしたいですか？</label>
    <textarea id="ai-prompt" value={prompt} onChange={event => editPrompt(event.target.value)} maxLength={2000} rows={3} placeholder="例：紙は2枚のまま、首をもう少し遠くまで動かしたい" />
    <p className="field-note">実行すると入力文・設計寸法・選択範囲がGeminiへ送られます。画像そのものは送信しません。</p>
    {connection.enabled && <label className="field">AIアクセスコード<input type="password" value={access} onChange={event => setAccess(event.target.value)} autoComplete="off" placeholder="管理者が設定したコード" /><small>この画面のメモリだけで扱い、保存しません。</small></label>}
    <div className="button-row"><button data-design-action onClick={() => void start()} disabled={busy || pollInterrupted || !prompt.trim() || !selectionReady} className="secondary">{run?.status === 'failed' ? '再試行する' : busy ? '検査しています…' : '変更案をつくる'}</button></div></details>
    {(busy || pollInterrupted) && <div className="ai-wait"><p>{pollInterrupted ? '通信の確認が必要です。現在の作品は変わっていません。' : run?.status === 'awaiting_approval' ? '採用の結果を確認しています。' : '候補を待っています。現在の作品は変わっていません。'}</p><div className="button-row">{pollInterrupted && <button className="secondary" onClick={() => void resumePolling()}>状況を確認する</button>}<button onClick={() => void cancel()} className="text-button">中断する</button></div></div>}
    {message && <p role="status" className={`notice ${unsupported || run?.status === 'failed' ? 'warning' : ''}`}>{message}</p>}
    {unsupported && <button className="text-button" onClick={() => { editPrompt('引っぱりタブでまっすぐ動く距離を調整したい'); setUnsupported(false); setMessage('代案を入力しました。実行するか、手動で調整してください。'); }}>代案「まっすぐ動かす」を選ぶ</button>}
    {run?.proposal && run.status === 'awaiting_approval' && run.baseHash === document.designHash && run.baseRevision === document.revision && <div className="proposal"><h3>AIの変更案 · 採用待ち</h3>{run.proposal.fulfillsRequested === false && <p className="notice warning">希望の{run.proposal.requestedTravelMm}mmに対し、候補は{run.proposal.document.input.travelMm}mmです。希望と異なる距離であることを確認してから採用してください。</p>}<DesignComparison before={document} after={run.proposal.document} imageDataUrl={imageDataUrl} backgroundImageDataUrl={backgroundImageDataUrl} preserved={run.proposal.protectedConditions ?? run.intentSummary?.protections ?? document.input.locks.map(key => `${fieldNames[key] ?? key}を固定`)}><div className="button-row"><button className="primary" disabled={busy || getKitSummary(run.proposal.document).status === 'blocked'} data-design-action onClick={() => void resolveProposal(true)}>この案にする</button><button className="secondary" disabled={busy} onClick={() => void resolveProposal(false)}>この案を使わない</button></div></DesignComparison></div>}
    {!busy && onManual && (!connection.enabled || unsupported || run?.status === 'failed') && <button className="text-button" onClick={onManual}>手動支援を使う</button>}
    {!!run?.validationIssues?.length && <div className="notice warning"><h3>設計で見つかった問題</h3>{run.validationIssues.map(issue => <p key={issue.id}>{issue.partIds.join('・')}：{issue.message} {issue.suggestion}</p>)}</div>}
    {!!run?.constraintSuggestions?.length && <div className="notice"><h3>条件変更の提案</h3>{run.constraintSuggestions.map((item, index) => <p key={index}>{fieldNames[item.key] ?? item.key} → {String(item.value)}：{item.reason}（自動では変更しません）</p>)}</div>}
    {!!evidence.length && <details className="ai-evidence"><summary>AI実行の記録（{evidence.length}件）</summary><p className="field-note">この画面で受け取った直近20件を保存できます。依頼文・モデル・ツール・検査・使用量・採用した版を含みます。画像やアクセスコードは含めません。</p><ul>{evidence.map(item => <li key={item.runId}><strong>{item.execution.mode === 'gemini' ? '実Gemini' : item.execution.mode === 'injected-test' ? '模擬実行' : '実行方式は未確認'}</strong> · {item.execution.model ?? 'モデル名未取得'}<br /><code>{item.runId}</code><br />{({pending:'候補待ち／未採用',accepted:'採用済み',rejected:'不採用',cancelled:'中断',stale:'依頼・設計が変わったため無効',failed:'失敗',completed:'応答完了'})[item.decision.status]}{item.decision.adopted ? ` · 第${item.decision.adopted.revision}版` : ''}<br />モデル {item.serverRun.modelCalls}回 / ツール {item.serverRun.toolCalls}回 / {usageLabel(item.serverRun)}</li>)}</ul><button className="secondary" onClick={exportEvidence}>AI実行記録を書き出す</button><p className="field-note">使用量未取得は0料金を意味しません。実物確認の記録は工程3で追加します。</p></details>}
    {!!run?.events?.length && <details><summary>実際の操作ログ（{run.toolCalls}回）</summary><ol className="execution-log">{run.events.map((event, index) => <li key={index}>{event.tool ?? event.name ?? event.type} {event.message}</li>)}</ol><small>モデル {run.modelCalls}回 · ツール {run.toolCalls}回 · {(run.elapsedMs / 1000).toFixed(1)}秒</small></details>}
  </section>;
}

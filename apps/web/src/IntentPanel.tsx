import { useEffect, useRef, useState } from 'react';
import { applyIntentPatch, buildDesignSuggestion, getKitSummary, type DesignDocument, type DesignSuggestion } from '@ugoku/core';
import DesignComparison from './DesignComparison';

type Candidate = { suggestion: DesignSuggestion; base: DesignDocument; text: string };
export default function IntentPanel({ document, imageDataUrl, backgroundImageDataUrl, selectionReady, request, onAccept, onEditSelection, onOpenDetails, onCandidateChange, requestText, onRequestTextChange }: {requestText?: string; onRequestTextChange?: (text: string) => void; document: DesignDocument; imageDataUrl: string; backgroundImageDataUrl?: string; onCandidateChange?: (active: boolean) => void; selectionReady: boolean; request: {text: string; sequence: number} | null; onAccept: (document: DesignDocument) => void; onEditSelection: () => void; onOpenDetails: () => void}) {
  const [localText, setLocalText] = useState('選んだ部分を右に出したい。絵の大きさは保って、厚紙はA4で2枚まで');
  const text = requestText ?? localText;
  const setText = (value: string) => { setLocalText(value); onRequestTextChange?.(value); };
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [message, setMessage] = useState('');
  const sameBase = (base: DesignDocument) => base.designId === document.designId && base.revision === document.revision && base.designHash === document.designHash;
  const active = candidate && candidate.text === text && sameBase(candidate.base) && selectionReady ? candidate : null;
  useEffect(() => { onCandidateChange?.(!!active?.suggestion.document); }, [active?.suggestion.document, onCandidateChange]);
  const lastSequence = useRef(0);
  useEffect(() => {
    if (!request || request.sequence === lastSequence.current) return;
    lastSequence.current = request.sequence;
    setText(request.text); setCandidate({ suggestion: buildDesignSuggestion(document, request.text), base: document, text: request.text }); setMessage('');
  }, [request, document, lastSequence]);
  function build() {
    if (!selectionReady) return;
    setCandidate({ suggestion: buildDesignSuggestion(document, text), base: document, text }); setMessage('');
  }
  function accept() {
    if (!active?.suggestion.document || !sameBase(active.base)) { setMessage('設計が変わっています。現在の作品から候補をつくり直してください。'); return; }
    const next = applyIntentPatch(document, active.suggestion.patch, active.suggestion.intent);
    if (getKitSummary(next).status === 'blocked') { setMessage('組み立て条件に未解決の問題があります。検査理由を確認し、条件か選択を見直してください。'); return; }
    setCandidate(null); onAccept(next); setMessage(`動く距離は${document.input.travelMm}mmから${next.input.travelMm}mmへ。候補を採用し、型紙と手順も更新しました。`);
  }
  return <section className="intent-panel" aria-labelledby="intent-title">
    <div className="section-top"><div><h2 id="intent-title">言葉で動きを調整する</h2></div><span className="outline-tag">AIなし</span></div>
    <details className="request-editor" open={!active?.suggestion.document}><summary>希望を編集する</summary>
    <p className="muted">方向・距離と、変えたくない条件を入力してください。寸法から案を計算します。</p>
    <label htmlFor="design-intent">どう動かしたいですか？</label>
    <textarea id="design-intent" value={text} onChange={event => { setText(event.target.value); setCandidate(null); setMessage(''); }} rows={3} maxLength={2000} />
    <div className="intent-examples"><button className="text-button" onClick={() => { setText('もう少し大きく動かしたい。絵の大きさは保って、紙は増やさない'); setCandidate(null); }}>例：もっと大きく、紙はそのまま</button><button className="text-button" onClick={() => { setText('選んだ部分を上へ出したい。絵の大きさは保って、厚紙は2枚まで'); setCandidate(null); }}>例：上に出す</button></div>
    <button className="secondary" data-design-action onClick={build} disabled={!selectionReady || !text.trim()}>手動支援で候補をつくる</button></details>
    {message && <p role="status" className="notice">{message}</p>}
    {candidate && !active && <p className="notice">希望・設計・選択が変わりました。現在の作品から候補をつくり直してください。</p>}
    {active && <div className="manual-result">
      <h3>{active.suggestion.status === 'ready' ? '希望を反映した候補' : active.suggestion.status === 'alternative' ? '希望の距離と異なる代案' : active.suggestion.status === 'unsupported' ? 'この動きには対応していません' : '希望と条件を見直しましょう'}</h3>
      {active.suggestion.messages.map((item,index) => <p className={`notice ${active.suggestion.status !== 'ready' ? 'warning' : ''}`} key={index}>{item}</p>)}
      {active.suggestion.document ? <DesignComparison before={active.base} after={active.suggestion.document} imageDataUrl={imageDataUrl} backgroundImageDataUrl={backgroundImageDataUrl} preserved={active.suggestion.preserved} remaining={active.suggestion.remaining}><div className="button-row"><button className="primary" disabled={getKitSummary(active.suggestion.document).status === 'blocked'} data-design-action onClick={accept}>この案にする</button><button className="secondary" onClick={() => { setCandidate(null); setMessage('候補を却下しました。元の作品と条件は変えていません。'); }}>この案を使わない</button></div></DesignComparison> : <div className="button-row"><button className="secondary" onClick={onEditSelection}>動かす枠を選び直す</button><button className="text-button" onClick={onOpenDetails}>変更してよい条件を見直す</button>{active.suggestion.status === 'unsupported' && <button className="text-button" onClick={() => { setText('選んだ部分をまっすぐ右へ動かす'); setCandidate(null); setMessage('直線運動の代案を入力しました。内容を確認してから候補をつくってください。'); }}>直線運動の代案を選ぶ</button>}</div>}
    </div>}
  </section>;
}

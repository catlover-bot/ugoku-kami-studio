import { useEffect, useRef, useState } from 'react';
import { applyIntentPatch, buildDesignSuggestion, distanceTargetMm, getKitSummary, type DesignDocument, type DesignSuggestion, type InterpretationCorrection, type InterpretationChanges } from '@ugoku/core';
import DesignComparison from './DesignComparison';
import RequestInterpretation from './RequestInterpretation';

type Candidate = { suggestion: DesignSuggestion; base: DesignDocument; text: string; correction?: InterpretationCorrection };
export default function IntentPanel({ document, imageDataUrl, backgroundImageDataUrl, selectionReady, request, onAccept, onEditSelection, onOpenDetails, onCandidateChange, requestText, onRequestTextChange, previewTarget, visible = true }: {previewTarget?: HTMLElement | null; visible?: boolean; requestText?: string; onRequestTextChange?: (text: string) => void; document: DesignDocument; imageDataUrl: string; backgroundImageDataUrl?: string; onCandidateChange?: (active: boolean) => void; selectionReady: boolean; request: {text: string; sequence: number} | null; onAccept: (document: DesignDocument) => void; onEditSelection: () => void; onOpenDetails: () => void}) {
  const [localText, setLocalText] = useState('選んだ部分を右に出したい。絵の大きさは保って、厚紙はA4で2枚まで');
  const text = requestText ?? localText;
  const setText = (value: string) => { setLocalText(value); onRequestTextChange?.(value); };
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [message, setMessage] = useState('');
  const [interpretationDraft, setInterpretationDraft] = useState(false);
  const sameBase = (base: DesignDocument) => base.designId === document.designId && base.revision === document.revision && base.designHash === document.designHash;
  const active = candidate && candidate.text === text && sameBase(candidate.base) && selectionReady ? candidate : null;
  const unchanged = active && !active.suggestion.document && active.suggestion.intent.supported && !active.suggestion.intent.conflicts.length && !active.suggestion.intent.clarifications.length && !active.suggestion.intent.approvalRequired && Object.entries(active.suggestion.intent.patch).every(([key,value]) => JSON.stringify(document.input[key as keyof typeof document.input]) === JSON.stringify(value)) && active.suggestion.intent.addLocks.every(key => document.input.locks.includes(key));
  useEffect(() => { onCandidateChange?.(!!active?.suggestion.document); }, [active?.suggestion.document, onCandidateChange]);
  const lastSequence = useRef(0);
  useEffect(() => {
    if (!request || request.sequence === lastSequence.current) return;
    lastSequence.current = request.sequence;
    setText(request.text); setCandidate({ suggestion: buildDesignSuggestion(document, request.text), base: document, text: request.text }); setMessage('');
  }, [request, document, lastSequence]);
  function correct(changes: InterpretationChanges) {
    if (!active || !sameBase(active.base)) { setMessage('設計か希望が変わっています。現在の作品から解釈し直してください。'); return; }
    const correction: InterpretationCorrection = {...active.correction, ...changes, binding: active.suggestion.intent.binding};
    if (changes.paper && !changes.paperApproval) delete correction.paperApproval;
    if (changes.ignoredClauses) correction.ignoredClauses = [...new Set([...(active.correction?.ignoredClauses ?? []), ...changes.ignoredClauses])];
    try {
      setCandidate({...active, correction, suggestion: buildDesignSuggestion(document, text, correction)});
      setMessage('解釈を訂正して検査し直しました。採用するまで作品は変わりません。');
    } catch (error) {setMessage(error instanceof Error ? error.message : '解釈を更新できませんでした。作品は変わっていません。');}
  }
  function accept() {
    if (interpretationDraft || !active?.suggestion.document || !sameBase(active.base)) { setMessage('設計が変わっています。現在の作品から候補をつくり直してください。'); return; }
    try {
      const next = applyIntentPatch(document, active.suggestion.patch, active.suggestion.intent);
      if (getKitSummary(next).status === 'blocked') { setMessage('組み立て条件に未解決の問題があります。検査理由を確認し、条件か選択を見直してください。'); return; }
      onAccept(next); setCandidate(null); setMessage(`動く距離は${document.input.travelMm}mmから${next.input.travelMm}mmへ。候補を採用し、型紙と手順も更新しました。`);
    } catch (error) {setMessage(error instanceof Error ? error.message : '候補を採用できませんでした。現在の作品は変わっていません。');}
  }
  return <section className="intent-panel" aria-label="寸法からの調整結果" hidden={!visible}>
    {message && <p role="status" className="notice">{message}</p>}
    {candidate && !active && <p className="notice">希望・設計・選択が変わりました。現在の作品から候補をつくり直してください。</p>}
    {active && <div className="manual-result">
      <h3>{unchanged ? '現在の作品が希望と一致しています' : active.suggestion.status === 'ready' ? '希望を反映した候補' : active.suggestion.status === 'alternative' ? '希望の距離と異なる代案' : active.suggestion.status === 'unsupported' ? 'この動きには対応していません' : '希望と条件を見直しましょう'}</h3>
      {active.suggestion.messages.filter(item => !active.suggestion.document && active.suggestion.status !== 'ready' && !active.suggestion.intent.clarifications.some(question => question.message === item)).map((item,index) => <p className={`notice ${!unchanged && active.suggestion.status !== 'ready' ? 'warning' : ''}`} key={index}>{item}</p>)}
      {active.suggestion.document ? <DesignComparison requestedTravelMm={distanceTargetMm(active.base.input.travelMm, active.suggestion.intent.interpretation.distance)} previewTarget={visible ? previewTarget : null} before={active.base} after={active.suggestion.document} imageDataUrl={imageDataUrl} backgroundImageDataUrl={backgroundImageDataUrl} preserved={active.suggestion.preserved} remaining={active.suggestion.remaining}><div className="button-row"><button className="primary" disabled={interpretationDraft || getKitSummary(active.suggestion.document).status === 'blocked'} data-design-action onClick={accept}>この案にする</button><button className="secondary" onClick={() => { setCandidate(null); setMessage('候補を却下しました。元の作品と条件は変えていません。'); }}>この案を使わない</button></div></DesignComparison> : !unchanged && (active.suggestion.status === 'unsupported' || !active.suggestion.intent.clarifications.length && !active.suggestion.intent.approvalRequired) && <div className="button-row"><button className="secondary" onClick={onEditSelection}>動かす枠を選び直す</button><button className="text-button" onClick={onOpenDetails}>変更してよい条件を見直す</button>{active.suggestion.status === 'unsupported' && <button className="text-button" onClick={() => { setText('選んだ部分をまっすぐ右へ動かす'); setCandidate(null); setMessage('直線運動の代案を入力しました。内容を確認してから候補をつくってください。'); }}>直線運動の代案を選ぶ</button>}</div>}
      {active.suggestion.document && !!active.suggestion.messages.length && <details className="proposal-explanation"><summary>{active.suggestion.status === 'alternative' ? '希望どおりにならない理由' : '案の説明'}</summary>{active.suggestion.messages.map((item,index) => <p key={index}>{item}</p>)}</details>}
      {active.suggestion.document && <button className="text-button" onClick={() => {setCandidate(null); setMessage('候補を使わず、現在の設定へ戻りました。');}}>設定を編集する</button>}
      <RequestInterpretation compact={!!active.suggestion.document} value={active.suggestion.intent} document={active.base} onCorrect={correct} onDraftChange={setInterpretationDraft} />
    </div>}
  </section>;
}

import { useEffect, useId, useState } from 'react';
import { displayDimension, type DesignDocument, type DesignIntent, type DistanceOperation, type InterpretationChanges } from '@ugoku/core';
import './RequestInterpretation.css';

export type InterpretationView = Pick<DesignIntent, 'binding' | 'interpretation' | 'clarifications' | 'summary' | 'approvalRequired'>;
type Props = { value: InterpretationView; document: DesignDocument; disabled?: boolean; onCorrect: (changes: InterpretationChanges) => void; source?: 'manual' | 'ai'; compact?: boolean; onDraftChange?: (active: boolean) => void };
const directionNames = { right: '右へ', left: '左へ', up: '上へ', down: '下へ' };
function initialDistance(operation: DistanceOperation): { mode: string; amount: string } {
  if (operation.kind === 'absolute') return {mode: 'absolute', amount: String(operation.value * (operation.unit === 'cm' ? 10 : 1))};
  if (operation.kind === 'relative') return {mode: 'relative', amount: String(operation.delta * (operation.unit === 'cm' ? 10 : 1))};
  return {mode: operation.kind === 'qualitative' ? operation.change : operation.kind, amount: ''};
}
function InterpretationEditor({value, document, disabled, onCorrect, onDraftChange}: Props) {
  const initial = initialDistance(value.interpretation.distance);
  const [mode, setMode] = useState(initial.mode), [amount, setAmount] = useState(initial.amount);
  const [direction, setDirection] = useState(value.interpretation.direction.desired ?? 'current');
  const [directionTouched, setDirectionTouched] = useState(false);
  const [forbidden, setForbidden] = useState(value.interpretation.direction.forbidden);
  const [error, setError] = useState('');
  const id = useId();
  const dirty = mode !== initial.mode || amount !== initial.amount || direction !== (value.interpretation.direction.desired ?? 'current') || JSON.stringify(forbidden) !== JSON.stringify(value.interpretation.direction.forbidden);
  useEffect(() => {onDraftChange?.(dirty);}, [dirty, onDraftChange]);
  useEffect(() => () => onDraftChange?.(false), [onDraftChange]);
  function reset() {
    const next = initialDistance(value.interpretation.distance);
    setMode(next.mode); setAmount(next.amount); setDirection(value.interpretation.direction.desired ?? 'current'); setDirectionTouched(false); setForbidden(value.interpretation.direction.forbidden); setError('');
  }
  useEffect(() => {
    const next = initialDistance(value.interpretation.distance);
    setMode(next.mode); setAmount(next.amount); setDirection(value.interpretation.direction.desired ?? 'current'); setDirectionTouched(false); setForbidden(value.interpretation.direction.forbidden); setError('');
  }, [value.interpretation]);
  function correct() {
    let distance: DistanceOperation;
    if (mode === 'absolute' || mode === 'relative') {
      const normalized = amount.normalize('NFKC').trim();
      if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) || !Number.isFinite(Number(normalized))) {setError('距離を数値で入力してください。増減は減らす量をマイナスで指定できます。'); return;}
      if (Math.abs(Number(normalized)) > 100_000) {setError('解釈する数値は-100000〜100000mmで入力してください。この機構で使える距離は、訂正後に別途検査します。'); return;}
      distance = mode === 'absolute' ? {kind: 'absolute', value: Number(normalized), unit: 'mm'} : {kind: 'relative', delta: Number(normalized), unit: 'mm'};
    } else if (mode === 'increase' || mode === 'decrease') distance = {kind: 'qualitative', change: mode};
    else distance = {kind: mode === 'maintain' ? 'maintain' : 'unspecified'};
    const desired = direction === 'current' ? directionTouched ? document.input.direction : value.interpretation.direction.desired : direction as keyof typeof directionNames;
    onCorrect({distance, direction: {...(desired ? {desired} : {}), forbidden}});
    setError('');
  }
  return <details className="interpretation-editor"><summary>解釈を直す</summary>
    <p className="field-note">この依頼の意味だけを訂正し、現在の作品から検査し直します。作品は採用するまで変わりません。</p>
    <div className="interpretation-fields">
      <label>距離の受け取り方<select aria-label="距離の受け取り方" value={mode} onChange={event => {setMode(event.target.value); setError('');}} disabled={disabled}>
        <option value="unspecified">距離は指定していない</option><option value="maintain">今の距離を保つ</option><option value="absolute">指定した距離にする</option><option value="relative">今の距離から増減する</option><option value="increase">もう少し大きくする</option><option value="decrease">もう少し小さくする</option>
      </select></label>
      {(mode === 'absolute' || mode === 'relative') && <label>解釈する距離（mm）<input aria-label="解釈する距離（mm）" type="text" inputMode="decimal" value={amount} onChange={event => {setAmount(event.target.value); setError('');}} disabled={disabled} aria-invalid={!!error} aria-describedby={error ? id : undefined} />{mode === 'relative' && <small>現在 {displayDimension(document.input.travelMm)}mm。例：5で5mm増やす、-5で5mm減らす。</small>}</label>}
      <label>希望する方向<select aria-label="希望する方向" value={direction} onChange={event => {setDirection(event.target.value); setDirectionTouched(true);}} disabled={disabled}><option value="current">今の方向を保つ</option>{Object.entries(directionNames).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    </div>
    <fieldset className="interpretation-forbidden"><legend>動かさない方向</legend><div className="button-row">{Object.entries(directionNames).map(([key,label]) => <label key={key}><input type="checkbox" checked={forbidden.includes(key as keyof typeof directionNames)} disabled={disabled} onChange={event => setForbidden(previous => event.target.checked ? [...previous, key as keyof typeof directionNames] : previous.filter(item => item !== key))} />{label.replace('へ','')}</label>)}</div></fieldset>
    {error && <p id={id} role="alert" className="field-error">{error}</p>}
    {dirty && <p className="field-note">訂正はまだ検査していません。検査し直すか、訂正を元に戻すと候補を採用できます。</p>}
    <div className="button-row"><button type="button" className="secondary" data-design-action disabled={disabled} onClick={correct}>この解釈で検査し直す</button>{dirty && <button type="button" className="text-button" disabled={disabled} onClick={reset}>訂正を元に戻す</button>}</div>
  </details>;
}

/** Displays only the actual core/server interpretation. It never fabricates a candidate or modifies the design. */
export default function RequestInterpretation(props: Props) {
  const {value, document, disabled, onCorrect, source = 'manual'} = props;
  const [expanded, setExpanded] = useState(!props.compact);
  useEffect(() => {setExpanded(!props.compact);}, [value.binding.requestHash]);
  useEffect(() => {if (!props.compact || value.clarifications.length || value.approvalRequired) setExpanded(true);}, [props.compact, value.clarifications.length, value.approvalRequired]);
  const contents = <section className="request-interpretation" aria-label="希望の受け取り方" data-base-hash={value.binding.baseHash} data-base-revision={value.binding.baseRevision}>
    <h4>{value.clarifications.length || value.approvalRequired ? '希望を確認してください' : 'この案で使った解釈'}</h4>
    <ul className="interpretation-summary">{value.summary.map((item,index) => <li key={index}>{item}</li>)}</ul>
    {source === 'ai' && <p className="field-note">違うところは採用前に訂正できます。</p>}
    {value.clarifications.map(item => <div className="interpretation-question" key={item.id}><p>{item.message}</p><div className="button-row">{item.choices.map((choice,index) => <button type="button" className="secondary" data-design-action key={index} disabled={disabled} onClick={() => onCorrect(choice.changes)}>{choice.label}</button>)}</div></div>)}
    {value.approvalRequired && <div className="interpretation-question"><p>紙の上限を {value.approvalRequired.from}枚 → {value.approvalRequired.to}枚 に緩める希望です。今の上限のままでは採用できません。</p><button type="button" className="secondary" data-design-action disabled={disabled} onClick={() => onCorrect({paperApproval:{from:value.approvalRequired!.from,to:value.approvalRequired!.to}})}>上限を{value.approvalRequired.from}枚から{value.approvalRequired.to}枚に変更して検査する</button></div>}
    <InterpretationEditor {...props} document={document} />
  </section>;
  return <details className="interpretation-details" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>希望の受け取り方・訂正</summary>{contents}</details>;
}

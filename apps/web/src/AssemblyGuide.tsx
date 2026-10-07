import { useId, useMemo, useState } from 'react';
import { getAssemblySteps, getMaterials, parseDesignDocument, type AssemblyStep, type DesignDocument } from '@ugoku/core';
import { generateAssemblySvg, INSTRUCTION_PAGE_COUNT } from '@ugoku/export';
import type { Project } from './project';
import './AssemblyGuide.css';

export type AssemblyGuideProps = {
  /** Snapshot for the acquired pattern. Remount with a new key to open another version. */
  project: Pick<Project, 'document'>;
  currentDocument: DesignDocument;
  initialStep?: number;
  /** Reading position only: callers must not turn this into a physical test record. */
  onStepChange?: (step: number) => void;
  onClose?: () => void;
};

const faceNames: Record<AssemblyStep['view'], string> = {
  front: '正面', back: '裏面（上辺を上にして左右に裏返す）', both: '表と裏の両方', separate: '切り離した部品',
};

export default function AssemblyGuide({ project, currentDocument, initialStep = 1, onStepChange, onClose }: AssemblyGuideProps) {
  // Retain a validated value, never the mutable/current editor project reference.
  const [document] = useState(() => parseDesignDocument(project.document));
  const steps = useMemo(() => getAssemblySteps(document), [document]);
  const materials = useMemo(() => getMaterials(document), [document]);
  const diagrams = useMemo(() => steps.map(step => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(generateAssemblySvg(document, step.number))}`), [document, steps]);
  const [stepNumber, setStepNumber] = useState(() => Number.isInteger(initialStep) ? Math.max(1, Math.min(steps.length, initialStep)) : 1);
  const [allSteps, setAllSteps] = useState(false);
  const headingId = useId();
  const changed = currentDocument.designId !== document.designId || currentDocument.revision !== document.revision || currentDocument.designHash !== document.designHash;
  const parts = (ids: string[]) => ids.map(id => `${id} ${document.parts.find(part => part.id === id)!.label}`).join(' / ');

  function selectStep(number: number) {
    if (number < 1 || number > steps.length) return;
    setAllSteps(false);
    if (number === stepNumber) return;
    setStepNumber(number);
    onStepChange?.(number);
  }

  function renderStep(step: AssemblyStep) {
    return <article className="assembly-guide-step" key={step.number} data-step={step.number} aria-labelledby={`${headingId}-step-${step.number}`}>
      <h3 id={`${headingId}-step-${step.number}`}>{step.number}. {step.title}</h3>
      <p className="assembly-guide-face">見る面：{faceNames[step.view]}</p>
      <figure className="assembly-guide-figure">
        <div className="assembly-guide-diagram" role="region" tabIndex={0} aria-label={`工程${step.number}の組み立て図`} aria-describedby={`${headingId}-diagram-help-${step.number}`}>
          <img className="assembly-illustration" src={diagrams[step.number - 1]} alt={`工程${step.number}の前後：${step.title}。図は原寸ではありません。`} />
        </div>
        <figcaption id={`${headingId}-diagram-help-${step.number}`}>図は原寸ではありません。図を左右に動かして、前の状態と追加後を見比べられます。</figcaption>
      </figure>
      <div className="assembly-guide-instructions">
        <div><dl className="assembly-guide-part-info">
          <div><dt>今回加える部品</dt><dd>{step.addedPartIds.length ? parts(step.addedPartIds) : '追加なし'}</dd></div>
          <div><dt>作業する部品</dt><dd>{parts(step.partIds)}</dd></div>
        </dl><p className="assembly-guide-description">{step.description}</p></div>
        <div>
          {step.glueInstructions.length > 0 && <div className="assembly-guide-glue"><h4>接着する場所と面</h4><ul>{step.glueInstructions.map(note => <li key={note}>{note}</li>)}</ul></div>}
          {step.doNotGlue.length > 0 && <div className="assembly-guide-no-glue"><h4>接着しない・切らないところ</h4><ul>{step.doNotGlue.map(note => <li key={note}>{note}</li>)}</ul></div>}
        </div>
      </div>
      {allSteps && <button className="secondary" onClick={() => selectStep(step.number)}>工程{step.number}を大きく読む</button>}
    </article>;
  }

  return <section className="assembly-guide" aria-labelledby={headingId} data-design-id={document.designId} data-design-revision={document.revision} data-design-hash={document.designHash}>
    <div className="assembly-guide-heading"><div><h2 id={headingId}>組み立てガイド</h2><p>対象の型紙：{document.input.title} · 第{document.revision}版</p></div>{onClose && <button className="secondary" onClick={onClose}>ガイドを閉じる</button>}</div>
    {changed && <p className="notice assembly-guide-version" role="status">現在編集中：{currentDocument.input.title} · 第{currentDocument.revision}版。このガイドは、開いた型紙の第{document.revision}版を保っています。</p>}
    <p className="field-note">型紙はA4厚紙{document.layout.sheets}枚、説明書は普通紙{INSTRUCTION_PAGE_COUNT}ページ（別）。型紙は100%で印刷し、50mm校正線を測ります。</p>
    <details className="assembly-guide-materials"><summary>この型紙に用意するもの</summary><ul>{materials.map(material => <li key={material.name}><strong>{material.name} · {material.quantity}</strong><p>{material.note}</p></li>)}</ul></details>
    <div className="assembly-guide-toolbar">
      <div className="segmented assembly-guide-view" role="group" aria-label="組み立てガイドの表示"><button aria-pressed={!allSteps} onClick={() => setAllSteps(false)}>一工程ずつ</button><button aria-pressed={allSteps} onClick={() => setAllSteps(true)}>全工程</button></div>
      {!allSteps && <nav className="assembly-guide-navigation" aria-label="組み立て工程の移動"><button className="secondary" onClick={() => selectStep(stepNumber - 1)} disabled={stepNumber === 1}>前の工程</button><button className="secondary" onClick={() => selectStep(stepNumber + 1)} disabled={stepNumber === steps.length}>次の工程</button></nav>}
    </div>
    <p className="assembly-guide-reading" aria-live="polite">{allSteps ? `全${steps.length}工程を表示しています。` : `閲覧中の工程 ${stepNumber} / ${steps.length}`}</p>
    <div className={allSteps ? 'assembly-guide-content all-steps' : 'assembly-guide-content'}>{allSteps ? steps.map(renderStep) : renderStep(steps[stepNumber - 1]!)}</div>
    <p className="field-note">ここに残るのは手順の閲覧位置です。印刷・組み立て・動作確認の結果は、実際に試してから「実物でためした記録」に残してください。</p>
    <details className="assembly-guide-identity"><summary>型紙の版を照合する</summary><p>{document.designId} · 第{document.revision}版</p><code className="design-hash">{document.designHash}</code></details>
  </section>;
}

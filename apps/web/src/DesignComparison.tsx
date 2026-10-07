import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { displayDimension, getKitSummary, type DesignDocument } from '@ugoku/core';
import Preview, { getPreviewBounds } from './Preview';
import './DesignComparison.css';

export const fieldNames: Record<string, string> = { travelMm: '動く距離', widthMm: '作品の幅', heightMm: '作品の高さ', direction: '方向', maxSheets: '紙の上限', clearanceMm: 'すき間', paperThicknessMm: '紙の厚さ', title: '作品名', selection: '動かす部分' };
const directionNames: Record<string, string> = { right: '右', left: '左', up: '上', down: '下' };
export function designChanges(before: DesignDocument, after: DesignDocument): {key: string; label: string; before: string; after: string}[] {
  return Object.keys(fieldNames).filter(key => JSON.stringify(before.input[key as keyof typeof before.input]) !== JSON.stringify(after.input[key as keyof typeof after.input])).map(key => {
    const format = (document: DesignDocument): string => {
      const value = document.input[key as keyof typeof document.input];
      if (typeof value === 'string') return directionNames[value] ?? value;
      if (key === 'selection') { const rect = document.input.selection; return `左${rect.x}・上${rect.y} / ${rect.width}×${rect.height}px`; }
      return `${String(value)}${key === 'maxSheets' ? '枚' : 'mm'}`;
    };
    return { key, label: fieldNames[key]!, before: format(before), after: format(after) };
  });
}

type Props = {before: DesignDocument; after: DesignDocument; imageDataUrl: string; backgroundImageDataUrl?: string; beforeBackgroundImageDataUrl?: string; afterBackgroundImageDataUrl?: string; preserved?: string[]; remaining?: string[]; children?: ReactNode; previewTarget?: HTMLElement | null; requestedTravelMm?: number};
export default function DesignComparison({ before, after, imageDataUrl, backgroundImageDataUrl, beforeBackgroundImageDataUrl = backgroundImageDataUrl, afterBackgroundImageDataUrl = backgroundImageDataUrl, preserved = [], remaining = [], children, previewTarget, requestedTravelMm }: Props) {
  const [position, setPosition] = useState(1);
  const [side, setSide] = useState<'before' | 'after'>('after');
  const bounds = getPreviewBounds([before, after]);
  const changes = designChanges(before, after);
  const summary = getKitSummary(after);
  const failures = summary.checks.filter(check => check.status === 'fail');
  const protectedConditions = [...new Set([...preserved, ...after.input.locks.map(key => `${fieldNames[key] ?? key}を固定`)])];
  const newlyLocked = after.input.locks.filter(key => !before.input.locks.includes(key));
  const requested = requestedTravelMm !== undefined && Number.isFinite(requestedTravelMm) ? requestedTravelMm : undefined;
  const alternative = requested !== undefined && requested !== after.input.travelMm;
  const sizePreserved = before.input.widthMm === after.input.widthMm && before.input.heightMm === after.input.heightMm;
  const previews = <>
    <p className="candidate-state">同じ縮尺で比べる <span>候補はまだ採用していません</span></p>
    <div className="comparison-switch segmented" role="group" aria-label="比べる作品">
      <button type="button" aria-pressed={side === 'before'} onClick={() => setSide('before')}>いまの作品</button>
      <button type="button" aria-pressed={side === 'after'} onClick={() => setSide('after')}>候補の作品</button>
    </div>
    <div className="comparison-previews" data-comparison-side={side}>
      <figure className={side === 'before' ? 'comparison-before current' : 'comparison-before'}><figcaption>いまの作品 <strong>{displayDimension(before.input.travelMm)}mm</strong></figcaption><Preview document={before} imageDataUrl={imageDataUrl} backgroundImageDataUrl={beforeBackgroundImageDataUrl} bounds={bounds} position={position} view="front" editing={false} selection={before.input.selection} onSelection={() => undefined} /></figure>
      <figure className={side === 'after' ? 'comparison-after current' : 'comparison-after'}><figcaption>候補の作品 <strong>{displayDimension(after.input.travelMm)}mm</strong>{alternative && <span>代案</span>}</figcaption><Preview document={after} imageDataUrl={imageDataUrl} backgroundImageDataUrl={afterBackgroundImageDataUrl} bounds={bounds} position={position} view="front" editing={false} selection={after.input.selection} onSelection={() => undefined} /></figure>
    </div>
    <div className="comparison-position">
      <button type="button" aria-label="比較を始点にする" onClick={() => setPosition(0)}>始点</button>
      <label>比較する位置<input aria-label="候補の比較位置" type="range" min="0" max="1" step="0.01" value={position} onChange={event => setPosition(Number(event.target.value))} /></label>
      <button type="button" aria-label="比較を終点にする" onClick={() => setPosition(1)}>終点</button>
      <span>{position === 0 ? 'はじめ' : position === 1 ? 'おわり' : `${Math.round(position * 100)}%`}</span>
    </div>
  </>;
  return <div className="design-comparison">
    {previewTarget ? createPortal(<div className="comparison-workbench">{previews}</div>, previewTarget) : previews}
    <dl className="comparison-distances" aria-label="動く距離の比較">
      <div><dt>現在</dt><dd>{displayDimension(before.input.travelMm)}<small>mm</small></dd></div>
      {requested !== undefined && <div><dt>希望</dt><dd>{displayDimension(requested)}<small>mm</small></dd></div>}
      <div className="comparison-candidate-distance"><dt>{alternative ? '候補（代案）' : '候補'}</dt><dd>{displayDimension(after.input.travelMm)}<small>mm</small></dd></div>
    </dl>
    {alternative && <p className="candidate-alternative">希望の{displayDimension(requested)}mmに対し、候補は{displayDimension(after.input.travelMm)}mmです。希望と異なる距離です。</p>}
    <p className="candidate-paper">厚紙 {before.layout.sheets}枚 → <strong>{after.layout.sheets}枚</strong>（上限 {after.input.maxSheets}枚）<br />{sizePreserved ? '絵の大きさを維持' : `絵の大きさ：${displayDimension(after.input.widthMm)} × ${displayDimension(after.input.heightMm)}mm`}</p>
    {changes.filter(change => change.key !== 'travelMm').length > 0 && <ul className="candidate-other-changes">{changes.filter(change => change.key !== 'travelMm').slice(0,2).map(change => <li key={change.key}>{change.label}：{change.before} → {change.after}</li>)}</ul>}
    {children}
    <p className={`candidate-verification ${failures.length ? 'field-error' : 'field-note'}`}>{failures.length ? '条件違反があるため、この案は選べません。' : '寸法・配置を検査済み。紙での動作は実物未確認です。'}</p>
    <details className="comparison-change-details"><summary>変更の詳細（{changes.length}項目）</summary>
      <table className="change-table"><caption>この案で変わること</caption><thead><tr><th>項目</th><th>いま</th><th>候補</th></tr></thead><tbody>{changes.map(change => <tr key={change.key}><th scope="row">{change.label}</th><td>{change.before}</td><td>{change.after}</td></tr>)}{!changes.length && <tr><td colSpan={3}>{JSON.stringify(before.input.artworkRepair) !== JSON.stringify(after.input.artworkRepair) ? '元位置に見える背景だけを補います。元画像・寸法・動く部分は維持します。' : '寸法は維持し、指定した条件を固定します。'}</td></tr>}</tbody></table>
    </details>
    {!!protectedConditions.length && <details className="preserved-conditions"><summary>守る条件（{protectedConditions.length}件）</summary>{!!newlyLocked.length && <p>この案にすると、{newlyLocked.map(key => fieldNames[key] ?? key).join('・')}の条件を固定します。</p>}<ul>{protectedConditions.map((item,index) => <li key={index}>{item}</li>)}</ul></details>}
    <details className="candidate-checks" open={failures.length > 0 ? true : undefined}><summary>全検査（{summary.checks.length}件）{failures.length > 0 ? `・未成立${failures.length}件` : ''}</summary><ul>{summary.checks.map(check => <li key={check.id} data-check-status={check.status}><strong>{check.status === 'fail' ? '未成立' : check.status === 'pass' ? '確認済み' : '要確認'}</strong> {check.message}{check.partIds.length > 0 && <span>（{check.partIds.join('・')}）</span>}{check.suggestion && <p>{check.suggestion}</p>}</li>)}</ul></details>
    {!!remaining.length && <details><summary>試作で確かめること</summary><ul className="remaining-notes">{remaining.map((item,index) => <li key={index}>{item}</li>)}</ul></details>}
  </div>;
}

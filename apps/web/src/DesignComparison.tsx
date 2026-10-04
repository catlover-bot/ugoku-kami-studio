import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getKitSummary, type DesignDocument } from '@ugoku/core';
import Preview, { getPreviewBounds } from './Preview';

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

export default function DesignComparison({ before, after, imageDataUrl, backgroundImageDataUrl, beforeBackgroundImageDataUrl = backgroundImageDataUrl, afterBackgroundImageDataUrl = backgroundImageDataUrl, preserved = [], remaining = [], children, previewTarget }: {before: DesignDocument; after: DesignDocument; imageDataUrl: string; backgroundImageDataUrl?: string; beforeBackgroundImageDataUrl?: string; afterBackgroundImageDataUrl?: string; preserved?: string[]; remaining?: string[]; children?: ReactNode; previewTarget?: HTMLElement | null}) {
  const [position, setPosition] = useState(1);
  const [side, setSide] = useState<'before' | 'after'>('after');
  const bounds = getPreviewBounds([before, after]);
  const changes = designChanges(before, after);
  const failures = getKitSummary(after).checks.filter(check => check.status === 'fail');
  const protectedConditions = [...new Set([...preserved, ...after.input.locks.map(key => `${fieldNames[key] ?? key}を固定`)])];
  const newlyLocked = after.input.locks.filter(key => !before.input.locks.includes(key));
  const previews = <>
    <p className="candidate-state">現在の作品と、未採用の案を比べる</p>
    <div className="comparison-switch segmented" role="group" aria-label="比べる作品">
      <button aria-pressed={side === 'before'} onClick={() => setSide('before')}>いまの作品</button>
      <button aria-pressed={side === 'after'} onClick={() => setSide('after')}>候補の作品</button>
    </div>
    <div className="comparison-previews" data-comparison-side={side}>
      <figure className={side === 'before' ? 'comparison-before current' : 'comparison-before'}><figcaption>いまの作品 <strong>{before.input.travelMm}mm</strong></figcaption><Preview document={before} imageDataUrl={imageDataUrl} backgroundImageDataUrl={beforeBackgroundImageDataUrl} bounds={bounds} position={position} view="front" editing={false} selection={before.input.selection} onSelection={() => undefined} /></figure>
      <figure className={side === 'after' ? 'comparison-after current' : 'comparison-after'}><figcaption>候補の作品 <strong>{after.input.travelMm}mm</strong></figcaption><Preview document={after} imageDataUrl={imageDataUrl} backgroundImageDataUrl={afterBackgroundImageDataUrl} bounds={bounds} position={position} view="front" editing={false} selection={after.input.selection} onSelection={() => undefined} /></figure>
    </div>
    <label className="comparison-position">同じ縮尺・同じ位置で比べる<input aria-label="候補の比較位置" type="range" min="0" max="1" step="0.01" value={position} onChange={event => setPosition(Number(event.target.value))} /><span>{position === 0 ? 'はじめ' : position === 1 ? 'おわり' : `${Math.round(position * 100)}%`}</span></label>
  </>;
  const rows = (items: typeof changes) => items.map(change => <tr key={change.key}><th scope="row">{change.label}</th><td>{change.before}</td><td>{change.after}</td></tr>);
  return <div className="design-comparison">
    {previewTarget ? createPortal(<div className="comparison-workbench">{previews}</div>, previewTarget) : previews}
    <table className="change-table"><caption>この案で変わること</caption><thead><tr><th>項目</th><th>いま</th><th>候補</th></tr></thead><tbody>{rows(changes.slice(0,3))}{!changes.length && <tr><td colSpan={3}>{JSON.stringify(before.input.artworkRepair) !== JSON.stringify(after.input.artworkRepair) ? '元位置に見える背景だけを補います。元画像・寸法・動く部分は維持します。' : '寸法は維持し、指定した条件を固定します。'}</td></tr>}</tbody></table>
    {changes.length > 3 && <details><summary>ほかの変更（{changes.length - 3}件）</summary><table className="change-table"><tbody>{rows(changes.slice(3))}</tbody></table></details>}
    <p className="candidate-paper">厚紙 {before.layout.sheets}枚 → <strong>{after.layout.sheets}枚</strong>（上限 {after.input.maxSheets}枚）</p>
    {children}

    {!!protectedConditions.length && <details className="preserved-conditions"><summary>守る条件（{protectedConditions.length}件）</summary>    {!!newlyLocked.length && <p className="candidate-paper">この案にすると、{newlyLocked.map(key => fieldNames[key] ?? key).join('・')}の条件を固定します。</p>}<ul>{protectedConditions.map((item,index) => <li key={index}>{item}</li>)}</ul></details>}
    {failures.map(check => <p className="notice warning" key={check.id}>{check.message} {check.suggestion}</p>)}
    <p className="field-note">{failures.length ? '条件違反があるため、この案は選べません。' : '寸法・配置を検査済み。紙での動作は、組み立てて確かめます。'}</p>
    {!!remaining.length && <details><summary>試作で確かめること</summary><ul className="remaining-notes">{remaining.map((item,index) => <li key={index}>{item}</li>)}</ul></details>}
  </div>;
}

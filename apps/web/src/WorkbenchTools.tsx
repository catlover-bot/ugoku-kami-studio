export type WorkbenchView = 'front' | 'original' | 'back' | 'print';

const views = [
  { key: 'front', label: '正面' }, { key: 'original', label: '原画像' },
  { key: 'back', label: '裏のしくみ' }, { key: 'print', label: '印刷図' },
] as const;

export function WorkbenchViews({ stage, view, onView, canCompare, comparing, onCompare }: {
  stage: number; view: WorkbenchView; onView: (view: WorkbenchView) => void;
  canCompare: boolean; comparing: boolean; onCompare: () => void;
}) {
  const available = views.filter(item => item.key === view || (stage === 1 ? item.key === 'front' || item.key === 'original' : stage === 3 ? item.key !== 'original' : true));
  return <div className="canvas-toolbar">
    <div className="segmented" role="group" aria-label="表示する面">{available.map(item => <button key={item.key} aria-pressed={view === item.key} onClick={() => onView(item.key)}>{item.label}</button>)}</div>
    {stage === 2 && canCompare && <button className="text-button" onClick={onCompare} aria-pressed={comparing}>変更前と比較</button>}
  </div>;
}

export function MotionPlayback({ playing, selectionReady, position, travelMm, onToggle, onPosition }: {
  playing: boolean; selectionReady: boolean; position: number; travelMm: number;
  onToggle: () => void; onPosition: (position: number) => void;
}) {
  return <div className="playback">
    <button className="play-button secondary" onClick={onToggle} disabled={!selectionReady} aria-label={playing ? '動きを停止' : '動かす'}><span aria-hidden="true">{playing ? 'Ⅱ' : '▷'}</span>{playing ? '止める' : '動かす'}</button>
    <button className="text-button endpoint-button" onClick={() => onPosition(0)}>はじめ</button>
    <label className="position-control"><span className="sr-only">動きの位置</span><input aria-label="動きの位置" type="range" min="0" max="1" step="0.01" value={position} onChange={event => onPosition(Number(event.target.value))} /></label>
    <button className="text-button endpoint-button" onClick={() => onPosition(1)}>おわり</button>
    <output className="distance-output" aria-live="off">{(position * travelMm).toFixed(0)}<small>mm</small></output>
  </div>;
}

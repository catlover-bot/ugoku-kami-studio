import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { getArtworkComposition, type DesignDocument, type Rect } from '@ugoku/core';

type View = 'front' | 'back' | 'original';
type Point = { x: number; y: number };
type Gesture = { start: Point; initial: Rect; corner?: string; move: boolean };
type Props = { document: DesignDocument; imageDataUrl: string; backgroundImageDataUrl?: string; position: number; view: View; editing: boolean; selection: Rect | null; onSelection: (selection: Rect) => void; showMotion?: boolean; bounds?: Rect; zoom?: number; selectionMode?: 'drag' | 'corners' };

/** One common millimetre viewport for every design in a comparison. */
export function getPreviewBounds(documents: DesignDocument[], view: View = 'front'): Rect {
  const extents = documents.flatMap(doc => {
    const tab = doc.parts.find(part => part.role === 'pull-tab')!.assembly;
    const end = { ...tab, x: tab.x + doc.motion.axis.x * doc.input.travelMm, y: tab.y + doc.motion.axis.y * doc.input.travelMm };
    return [tab, end, { x: 0, y: 0, width: doc.input.widthMm, height: doc.input.heightMm }].map(rect => view === 'back' ? { ...rect, x: doc.input.widthMm - rect.x - rect.width } : rect);
  });
  const x = Math.min(...extents.map(rect => rect.x)) - 10, y = Math.min(...extents.map(rect => rect.y)) - 12;
  return { x, y, width: Math.max(...extents.map(rect => rect.x + rect.width)) + 10 - x, height: Math.max(...extents.map(rect => rect.y + rect.height)) + 12 - y };
}

export default function Preview({ document, imageDataUrl, backgroundImageDataUrl, position, view, editing, selection, onSelection, showMotion = false, bounds, zoom = 1, selectionMode = 'drag' }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const anchor = useRef<Point | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [unit, setUnit] = useState(0.4);
  const prefix = useId().replace(/:/g, '');
  const input = document.input, placement = document.artwork.placement;
  const composition = useMemo(() => getArtworkComposition(document), [document]);
  const scale = placement.width / input.image.widthPx;
  const selected = draft ?? selection ?? input.selection;
  const selectedMm = { x: placement.x + selected.x * scale, y: placement.y + selected.y * scale, width: selected.width * scale, height: selected.height * scale };
  const fixedMm = document.artwork.selectionMm;
  const { axis, slot } = document.motion;
  const dx = axis.x * input.travelMm * position, dy = axis.y * input.travelMm * position;
  const tab = document.parts.find(part => part.role === 'pull-tab')!;
  const mirror = (rect: Rect): Rect => view === 'back' ? { ...rect, x: input.widthMm - rect.x - rect.width } : rect;
  const extent = bounds ?? getPreviewBounds([document], view);
  const viewport = { x: extent.x + extent.width * (1 - 1 / zoom) / 2, y: extent.y + extent.height * (1 - 1 / zoom) / 2, width: extent.width / zoom, height: extent.height / zoom };
  const cancel = () => { gesture.current = null; anchor.current = null; setDraft(null); setSelecting(false); };
  useEffect(() => { gesture.current = null; anchor.current = null; setDraft(null); setSelecting(false); }, [editing, view, selectionMode, input.image.id, document.designId, document.designHash]);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => { const matrix = svg.getScreenCTM(); if (matrix?.a) setUnit(1 / Math.abs(matrix.a)); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(svg); return () => observer.disconnect();
  }, [viewport.width, viewport.height]);
  const sourcePoint = (event: PointerEvent<SVGSVGElement>): Point => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: Math.round(Math.min(input.image.widthPx, Math.max(0, (point.x - placement.x) / scale))), y: Math.round(Math.min(input.image.heightPx, Math.max(0, (point.y - placement.y) / scale))) };
  };
  const rectangle = (start: Point, end: Point): Rect => ({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) });
  function gestureRect(end: Point): Rect | null {
    const active = gesture.current;
    if (!active) return null;
    if (active.move) return { ...active.initial, x: Math.max(0, Math.min(input.image.widthPx - active.initial.width, active.initial.x + end.x - active.start.x)), y: Math.max(0, Math.min(input.image.heightPx - active.initial.height, active.initial.y + end.y - active.start.y)) };
    if (active.corner) {
      const { x, y, width, height } = active.initial;
      const opposite = { x: active.corner.includes('w') ? x + width : x, y: active.corner.includes('n') ? y + height : y };
      return rectangle(opposite, end);
    }
    return rectangle(active.start, end);
  }
  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if (!editing || view !== 'front' || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.focus();
    if (selectionMode === 'corners') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const target = event.target as SVGElement;
    const start = sourcePoint(event);
    // Resolve overlapping touch boxes by the nearest visible corner.
    const corners: [string, number, number][] = [['nw',selected.x,selected.y],['ne',selected.x+selected.width,selected.y],['sw',selected.x,selected.y+selected.height],['se',selected.x+selected.width,selected.y+selected.height]];
    const corner = target.dataset.corner ? corners.sort((a,b) => Math.hypot(a[1]-start.x,a[2]-start.y)-Math.hypot(b[1]-start.x,b[2]-start.y))[0]![0] : undefined;
    gesture.current = { start, initial: selected, corner, move: target.dataset.selection === 'move' };
    setSelecting(true);
  }
  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!editing || view !== 'front') return;
    if (gesture.current) setDraft(gestureRect(sourcePoint(event)));
    else if (anchor.current) setDraft(rectangle(anchor.current, sourcePoint(event)));
  }
  function pointerUp(event: PointerEvent<SVGSVGElement>) {
    if (!editing || view !== 'front') return;
    if (selectionMode === 'corners') {
      const point = sourcePoint(event);
      if (!anchor.current) { anchor.current = point; setDraft({ ...point, width: 0, height: 0 }); setSelecting(true); return; }
      const next = rectangle(anchor.current, point); cancel();
      if (next.width >= 10 && next.height >= 10) onSelection(next);
      return;
    }
    const next = gestureRect(sourcePoint(event)); cancel();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (next && next.width >= 10 && next.height >= 10 && JSON.stringify(next) !== JSON.stringify(selection)) onSelection(next);
  }
  function keyboard(event: KeyboardEvent<SVGSVGElement>) {
    if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
    if (!editing || !selection || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); const amount = event.shiftKey ? 10 : 1;
    onSelection({ ...selection, x: Math.max(0, Math.min(input.image.widthPx - selection.width, selection.x + (event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0))), y: Math.max(0, Math.min(input.image.heightPx - selection.height, selection.y + (event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0))) });
  }
  const tabPose = mirror({ ...tab.assembly, x: tab.assembly.x + dx, y: tab.assembly.y + dy });
  const motionStart = mirror(fixedMm), motionEnd = mirror({ ...fixedMm, x: fixedMm.x + axis.x * input.travelMm, y: fixedMm.y + axis.y * input.travelMm });
  const handles: [string, number, number][] = [['nw',selectedMm.x,selectedMm.y],['ne',selectedMm.x+selectedMm.width,selectedMm.y],['sw',selectedMm.x,selectedMm.y+selectedMm.height],['se',selectedMm.x+selectedMm.width,selectedMm.y+selectedMm.height]];
  return <div className="preview-surface">
    <svg ref={svgRef} className={`artwork-svg ${editing ? 'editing' : ''}`} viewBox={`${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`} data-design-hash={document.designHash} data-revision={document.revision} data-phase={position} data-zoom={zoom} role="img" aria-label={view === 'original' ? '元の絵。切り抜きや白い台紙の処理をしていない原画像' : view === 'back' ? '裏側から見た仕組み。左右を反転したタブ、ガイド、抜け止めと接着位置' : editing ? '動かす領域。ドラッグまたは2点タップで選択、矢印キーで移動、Shiftと矢印で10px移動' : '正面の動きのプレビュー'} tabIndex={editing ? 0 : undefined} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancel} onLostPointerCapture={() => { if (gesture.current) cancel(); }} onKeyDown={keyboard}>
      <defs>
        {/* Zero offset forces one paper+ink composite before clipping, as in the PDF Form. */}
        <filter id={`${prefix}-paper-composite`} filterUnits="userSpaceOnUse" {...placement} colorInterpolationFilters="sRGB"><feOffset dx="0" dy="0" /></filter>
        <clipPath id={`${prefix}-moving`}><rect {...fixedMm} /></clipPath>
        <pattern id={`${prefix}-hatch`} width="3" height="3" patternUnits="userSpaceOnUse"><path d="M-1 1L1-1M0 3L3 0M2 4L4 2" stroke="#292923" strokeWidth="0.4" /></pattern>
      </defs>
      {view !== 'original' && !editing && <rect data-part="T1" {...tabPose} fill="white" stroke="#292923" strokeWidth="0.45" />}
      <rect data-part="paper" x="0" y="0" width={input.widthMm} height={input.heightMm} fill="white" stroke={view === 'original' ? 'none' : '#81796d'} strokeWidth="0.4" />
      {view !== 'back' && <image data-part="original-art" href={imageDataUrl} {...placement} />}
      {view === 'front' && !editing && <>
        {selection && !composition.background && <rect data-part="fixed-fill" {...composition.fixedMask.rect} fill={composition.fixedMask.color} />}
        {selection && composition.background && backgroundImageDataUrl && <g style={{isolation: 'isolate'}} filter={`url(#${prefix}-paper-composite)`} clipPath={`url(#${prefix}-moving)`}><rect {...placement} fill="white" /><image data-part="fixed-background" href={backgroundImageDataUrl} {...composition.background.placement} preserveAspectRatio="none" /></g>}
        <rect data-part="B1-slot" {...slot} fill="white" stroke="#292923" strokeWidth="0.3" />
        {selection && <g data-part="M1" transform={`translate(${dx} ${dy})`}><g style={{isolation: 'isolate'}} filter={`url(#${prefix}-paper-composite)`} clipPath={`url(#${prefix}-moving)`}><rect data-part="M1-paper" {...composition.movingPaper} fill="white" /><image href={imageDataUrl} {...placement} /></g></g>}
      </>}
      {view === 'front' && editing && (selection || draft) && <g>
        <rect data-selection="move" {...selectedMm} fill="#a547321a" stroke="#71301f" strokeWidth={2 * unit} strokeDasharray={`${5 * unit} ${3 * unit}`} />
        {handles.map(([corner,x,y]) => <g key={corner}><rect x={x - 4*unit} y={y - 4*unit} width={8*unit} height={8*unit} fill="white" stroke="#71301f" strokeWidth={2*unit} /><rect data-corner={corner} x={x - 22*unit} y={y - 22*unit} width={44*unit} height={44*unit} fill="transparent" style={{cursor: `${corner}-resize`}} /></g>)}
      </g>}
      {view === 'back' && <>
        {document.parts.filter(part => part.layer === 'back').sort((a,b) => (a.role === 'guide' ? 1 : 0) - (b.role === 'guide' ? 1 : 0)).map(part => {
          const moving = ['pull-tab','stopper','connector'].includes(part.role);
          const pose = mirror({ ...part.assembly, x: part.assembly.x + (moving ? dx : 0), y: part.assembly.y + (moving ? dy : 0) });
          return <g key={part.id}><rect {...pose} fill="white" stroke="#292923" strokeWidth="0.45" /><text x={pose.x + 1} y={pose.y + Math.min(pose.height - 1, 4)} fontSize="3" fill="#292923">{part.id}</text></g>;
        })}
        {document.parts.find(part => part.role === 'base')!.glue.map((glue, index) => { const rect = mirror(glue.rect); return <g key={index}><rect {...rect} fill={`url(#${prefix}-hatch)`} stroke="#292923" strokeWidth="0.3" /><text x={rect.x + 1} y={rect.y + 3} fontSize="2.4">のり</text></g>; })}
        <rect {...mirror(slot)} fill="none" stroke="#292923" strokeWidth="0.5" strokeDasharray="1.5 1" />
      </>}
      {showMotion && selection && !editing && view !== 'original' && <g className="motion-overlay" fill="none" stroke="#71301f" strokeWidth="0.45"><rect data-motion="start" {...motionStart} strokeDasharray="1 1.4" /><rect data-motion="end" {...motionEnd} strokeDasharray="2 1" /></g>}
    </svg>
    {editing && <p className="selection-status" role="status">{selecting ? selectionMode === 'corners' ? '選択中：対角の点をタップ。Escで取り消し。' : '選択中：離すと確定。Escで取り消し。' : selection ? '選択済み。枠と四隅をドラッグ、または2点で選び直せます。' : '選択なし。動かす部分を囲んでください。'}</p>}
  </div>;
}

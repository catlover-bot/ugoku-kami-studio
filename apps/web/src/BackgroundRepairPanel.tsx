import { useEffect, useRef, useState } from 'react';
import { applyArtworkRepair, type DesignDocument, type ArtworkRepair, type ImageSource } from '@ugoku/core';
import { imageContentId, readRaster, verifyDataImage, type Project } from './project';
import DesignComparison from './DesignComparison';

type Candidate = { baseDesignId: string; baseHash: string; baseRevision: number; document: DesignDocument; backgroundImageDataUrl?: string };
export default function BackgroundRepairPanel({ project, onAccept, onCandidateChange, disabled = false }: { project: Project; onAccept: (document: DesignDocument, backgroundImageDataUrl?: string) => void; disabled?: boolean; onCandidateChange?: (active: boolean) => void }) {
  const [color, setColor] = useState('#ffffff');
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const current = useRef(project); current.current = project;
  useEffect(() => { onCandidateChange?.(!!candidate); }, [candidate, onCandidateChange]);
  const stale = candidate && (candidate.baseDesignId !== project.document.designId || candidate.baseHash !== project.document.designHash || candidate.baseRevision !== project.document.revision);
  function prepare(repair: ArtworkRepair, backgroundImageDataUrl?: string) {
    try {
      const doc = applyArtworkRepair(project.document, repair);
      setCandidate({ baseDesignId: project.document.designId, baseHash: project.document.designHash, baseRevision: project.document.revision, document: doc, backgroundImageDataUrl });
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '補正候補を作れませんでした。'); }
  }
  async function chooseImage(file: File) {
    const ticket = ++request.current, base = project.document;
    setLoading(true); setError('');
    try {
      const checked = await readRaster(file);
      const response = await fetch('/api/images', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: checked.dataUrl }) });
      const result = await response.json() as { image: ImageSource & { dataUrl: string }; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? '背景用画像を確認できませんでした。接続を確認して選び直してください。');
      if (ticket !== request.current) return;
      const verified = await verifyDataImage(result.image.dataUrl);
      if (result.image.mimeType !== 'image/png' || !result.image.dataUrl.startsWith('data:image/png;base64,') || verified.naturalWidth !== result.image.widthPx || verified.naturalHeight !== result.image.heightPx || imageContentId(result.image.dataUrl) !== result.image.id) throw new Error('背景用画像の確認結果と画像が一致しません。現在の作品は残っています。');
      if (ticket !== request.current) return;
      if (current.current.document.designId !== base.designId || current.current.document.designHash !== base.designHash || current.current.document.revision !== base.revision) throw new Error('読み込み中に設計が変わりました。現在の設計で背景用画像を選び直してください。');
      const { dataUrl, ...image } = result.image;
      const doc = applyArtworkRepair(base, { mode: 'image', image });
      setCandidate({ baseDesignId: base.designId, baseHash: base.designHash, baseRevision: base.revision, document: doc, backgroundImageDataUrl: dataUrl });
    } catch (cause) { if (ticket === request.current) setError(cause instanceof TypeError ? '背景用画像の確認サーバーに接続できません。現在の作品は残っています。' : cause instanceof Error ? cause.message : '背景用画像を読み込めませんでした。'); }
    finally { if (ticket === request.current) setLoading(false); }
  }
  function recalculate() {
    if (candidate?.document.input.artworkRepair) prepare(candidate.document.input.artworkRepair, candidate.backgroundImageDataUrl);
  }
  return <details className="background-repair">
    <summary>元位置の背景を補う</summary>
    <p>動いたあとに残る四角い白抜けを、指定した色や背景用画像で補います。固定側の台紙にも同じ補正を印刷します。</p>
    <p className="field-note">可動側は白い紙に元の絵を印刷した四角形です。透明部分も白い紙になります。つながった輪郭や隠れた模様は自動復元しません。輪郭が欠ける場合は、選択枠へ輪郭全体を入れて選び直してください。</p>
    <fieldset disabled={disabled || loading}>
      <legend>補い方を選んで、変更前後を確認</legend>
      <label>背景の色<input aria-label="背景の色" type="color" value={color} onChange={event => setColor(event.target.value)} /></label>
      <button onClick={() => prepare({ mode: 'solid', color })}>この色で比較する</button>
      <label className="file-button">背景用の画像を選ぶ<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="背景用の画像を選ぶ" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void chooseImage(file); }} /></label>
      <p className="field-note">PNG・JPEG・WebP／5MB・1,200万画素まで。元絵と同じ大きさの、動かす部分を含まない背景画像なら位置が揃います。縦横比が違う画像は中央を切り取り、白抜け部分だけへ使います。</p>
      <button onClick={() => prepare({ mode: 'white' })}>補正なしの白で比較する</button>
    </fieldset>
    {loading && <p role="status">背景用画像を確認しています…</p>}
    {error && <p className="notice warning" role="alert">{error}</p>}
    {candidate && <section className="repair-candidate" aria-label="背景補正の候補">
      <h3>元位置の背景の変更案</h3>
      <p>採用前の印刷対象は、いまの作品です。模様の境目と四角い紙の輪郭を両端で確認してください。</p>
      {stale && <p className="notice warning" role="status">候補を作ったあとに設計が変わりました。現在の作品で比較し直してください。<button onClick={recalculate}>背景の候補を作り直す</button><button onClick={() => setCandidate(null)}>この案を使わない</button></p>}
      {!stale && <DesignComparison before={project.document} after={candidate.document} imageDataUrl={project.imageDataUrl} beforeBackgroundImageDataUrl={project.backgroundImageDataUrl} afterBackgroundImageDataUrl={candidate.backgroundImageDataUrl} preserved={['元画像・動かす範囲・寸法・機構・部品数は変更しません。']} remaining={['背景を作者が指定する補正です。元の絵の復元や、実物での動作確認ではありません。']}>
        <div className="button-row"><button className="primary" disabled={disabled || !!stale} data-design-action onClick={() => { if (!stale && !disabled) { onAccept(candidate.document, candidate.backgroundImageDataUrl); setCandidate(null); } }}>この案にする</button><button onClick={() => { ++request.current; setCandidate(null); }}>この案を使わない</button></div>
      </DesignComparison>}
    </section>}
  </details>;
}

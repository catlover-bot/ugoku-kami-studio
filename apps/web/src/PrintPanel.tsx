import { displayDimension, type DesignDocument } from '@ugoku/core';
import { INSTRUCTION_PAGE_COUNT, type PdfMode } from '@ugoku/export';

type Props = {
  document: DesignDocument;
  partCount: number;
  mode: PdfMode;
  onMode: (mode: PdfMode) => void;
  busy: boolean;
  disabled: boolean;
  error?: string;
  acquiredDocument?: DesignDocument;
  onDownload: () => void;
  onGuide: () => void;
  onEdit: () => void;
};
const directions = { right: '右', left: '左', up: '上', down: '下' };

/** Describes the chosen download and the separately pinned guide; never changes either design. */
export default function PrintPanel({ document, partCount, mode, onMode, busy, disabled, error, acquiredDocument, onDownload, onGuide, onEdit }: Props) {
  const pattern = mode !== 'instructions', instructions = mode !== 'pattern';
  const pages = (pattern ? document.layout.sheets : 0) + (instructions ? INSTRUCTION_PAGE_COUNT : 0);
  const olderGuide = acquiredDocument && (acquiredDocument.designId !== document.designId || acquiredDocument.revision !== document.revision || acquiredDocument.designHash !== document.designHash);
  return <section className="settings-section kit-download" aria-label="PDFと組み立て">
    <div className="print-heading"><h2>印刷して作る</h2><span className="revision">第{document.revision}版</span></div>
    <p className="print-motion">正面から見て{directions[document.input.direction]}へ {displayDimension(document.input.travelMm)}mm</p>
    <label className="pdf-mode">PDFに含める内容<select aria-label="PDFに含める内容" value={mode} disabled={busy} onChange={event => onMode(event.target.value as PdfMode)}><option value="all">型紙と組み立て説明（全部入り）</option><option value="pattern">型紙のみ</option><option value="instructions">組み立て説明のみ</option></select></label>
    <div className="pdf-contents" aria-label="取得するPDFの内容" aria-live="polite" aria-atomic="true">
      <div className="pdf-page-count"><strong>PDF {pages}ページ</strong><span>A4</span></div>
      <dl>
        {pattern && <div><dt>型紙</dt><dd>厚紙 <strong>{document.layout.sheets}枚</strong><span>{partCount}部品を切り出す</span></dd></div>}
        {instructions && <div><dt>組み立て説明</dt><dd>普通紙 <strong>{INSTRUCTION_PAGE_COUNT}ページ</strong><span>手順・接着位置を確認</span></dd></div>}
      </dl>
    </div>
    {error && <p className="notice warning" role="alert">{error}</p>}
    <button className="primary export-button" data-design-action onClick={onDownload} disabled={busy || disabled}>{busy ? 'PDFを準備しています…' : 'PDFをダウンロード'}</button>
    <p className="field-note print-instructions">100%で印刷し、型紙の50mm校正線を測ります。<br />試作用です。紙での動作は実物未確認です。</p>
    <div className="print-guide-next">
      <div className="print-heading"><h3>組み立てる</h3>{acquiredDocument && <span className="revision">取得済み · 第{acquiredDocument.revision}版</span>}</div>
      <button id="open-assembly-guide" className="secondary" onClick={onGuide} disabled={!acquiredDocument}>組み立てガイドを開く</button>
      <p className="field-note">{acquiredDocument ? `最後に取得したPDF：第${acquiredDocument.revision}版。続きの工程から開けます。` : 'PDFを取得すると、同じ版の手順を開けます。'}</p>
      {olderGuide && <p className="guide-version-note">編集中の第{document.revision}版とは異なります。今の作品で組み立てる場合は、PDFを取り直してください。</p>}
    </div>
    <button className="text-button print-back" onClick={onEdit}>動きを調整する</button>
  </section>;
}

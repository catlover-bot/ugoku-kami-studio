import type { DesignDocument } from '@ugoku/core';
import type { ExportOptions } from '@ugoku/export';

export function generatePdfOffThread(document: DesignDocument, options: ExportOptions): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ bytes?: Uint8Array; error?: string }>) => {
      worker.terminate();
      if (event.data.bytes) resolve(event.data.bytes);
      else reject(new Error(event.data.error ?? 'PDFを作れませんでした。'));
    };
    worker.onerror = () => { worker.terminate(); reject(new Error('印刷処理を開始できませんでした。再試行してください。')); };
    worker.postMessage({ document, options });
  });
}

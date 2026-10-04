import { generatePdf, type ExportOptions } from '@ugoku/export';
import type { DesignDocument } from '@ugoku/core';

// Font parsing, raster embedding and PDF serialization run away from UI input.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ document: DesignDocument; options: ExportOptions }>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = async event => {
  try {
    const bytes = await generatePdf(event.data.document, event.data.options);
    scope.postMessage({ bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (cause) {
    scope.postMessage({ error: cause instanceof Error ? cause.message : 'PDFを作れませんでした。' });
  }
};

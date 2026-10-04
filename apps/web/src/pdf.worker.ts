import { generatePdf } from '@ugoku/export';
import type { PdfWorkerRequest } from './pdf';

// Font parsing, raster embedding and PDF serialization run away from UI input.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PdfWorkerRequest>) => void) | null;
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

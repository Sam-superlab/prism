import type { PDFPageProxy } from 'pdfjs-dist';

type OcrHost = Window & {
  webkit?: {
    messageHandlers?: {
      prismPdfOcr?: {
        postMessage(input: { id: string; png: string } | { id: string; cancel: true }): Promise<unknown>;
      };
    };
  };
};

const edgeLimit = 2200;
const pngLimit = 8 * 1024 * 1024;

function recognitionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function nativeBridge() {
  if (typeof window !== 'undefined') return (window as OcrHost).webkit?.messageHandlers?.prismPdfOcr;
}

export function canRecognizeLiteraturePdfScans() {
  return typeof nativeBridge()?.postMessage === 'function';
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function recognizeLiteraturePdfPage(page: PDFPageProxy, signal: AbortSignal) {
  const bridge = nativeBridge();
  if (!bridge) throw new Error('Local scan recognition is available in PRISM for macOS.');
  signal.throwIfAborted();
  const base = page.getViewport({ scale: 1 });
  if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0)
    throw new Error('The scanned page has invalid dimensions.');
  const viewport = page.getViewport({ scale: Math.min(4, edgeLimit / Math.max(base.width, base.height)) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const render = page.render({ canvas, viewport, annotationMode: 0 });
  const cancel = () => render.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await render.promise;
    signal.throwIfAborted();
    const blob = await waitFor(
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) =>
            result ? resolve(result) : reject(new Error('Could not prepare the scanned page image.')),
          'image/png',
        );
      }),
      signal,
    );
    if (blob.size > pngLimit) throw new Error('The scanned page image exceeds the recognition limit.');
    const bytes = new Uint8Array(await waitFor(blob.arrayBuffer(), signal));
    let raw = '';
    for (let from = 0; from < bytes.length; from += 8192)
      raw += String.fromCharCode(...bytes.subarray(from, from + 8192));
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const id = recognitionId();
    const cancelRecognition = () => {
      void bridge.postMessage({ id, cancel: true }).catch(() => {});
    };
    deadline.addEventListener('abort', cancelRecognition, { once: true });
    try {
      const result = await waitFor(bridge.postMessage({ id, png: btoa(raw) }), deadline);
      if (typeof result !== 'string') throw new Error('Local scan recognition returned an invalid result.');
      return result;
    } finally {
      deadline.removeEventListener('abort', cancelRecognition);
    }
  } catch (cause) {
    signal.throwIfAborted();
    throw cause;
  } finally {
    signal.removeEventListener('abort', cancel);
    canvas.width = 0;
    canvas.height = 0;
  }
}

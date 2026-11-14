import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { LiteraturePdfHighlight } from '../components/LiteraturePdfReader';
import { api } from './api';
import { pdfAreaImageSource } from './knowledge-image-sources';
import { loadLiteraturePdf } from './literature-pdfs';

type Crop = LiteraturePdfHighlight['rects'][number];
type OpenPdf = { promise: Promise<PDFDocumentProxy>; close: () => void; readers: number };
const openPdfs = new Map<string, OpenPdf>();
const queue: (() => void)[] = [];
let active = 0;

async function reserve(signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    if (active < 2) {
      active++;
      resolve();
      return;
    }
    const ready = () => {
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = () => {
      const index = queue.indexOf(ready);
      if (index >= 0) queue.splice(index, 1);
      reject(signal.reason);
    };
    queue.push(ready);
    signal.addEventListener('abort', cancel, { once: true });
  });
  return () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };
}

function openPdf(id: string): OpenPdf {
  const existing = openPdfs.get(id);
  if (existing) { existing.readers++; return existing; }
  const controller = new AbortController();
  let worker: Worker | undefined;
  let task: PDFDocumentLoadingTask | undefined;
  const entry: OpenPdf = {
    readers: 1,
    promise: Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), loadLiteraturePdf(id, controller.signal)])
      .then(([module, bytes]) => {
        controller.signal.throwIfAborted();
        worker = new Worker(new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' });
        task = module.getDocument({ data: new Uint8Array(bytes), worker: module.PDFWorker.create({ port: worker }),
          useSystemFonts: true, useWorkerFetch: false, useWasm: false, enableXfa: false });
        const currentTask = task;
        const stop = () => { void currentTask.destroy().catch(() => {}); };
        currentTask.onPassword = stop;
        worker.addEventListener('error', stop, { once: true });
        const timer = setTimeout(stop, 30_000);
        return currentTask.promise.finally(() => clearTimeout(timer));
      }),
    close() {
      if (--entry.readers > 0) return;
      openPdfs.delete(id);
      controller.abort();
      if (task) void task.destroy().catch(() => {}).finally(() => worker?.terminate());
      else worker?.terminate();
    },
  };
  openPdfs.set(id, entry);
  return entry;
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function renderLiteraturePdfAreaImage(src: string, parentSignal: AbortSignal): Promise<Blob> {
  const source = pdfAreaImageSource(src);
  if (!source) throw new Error('Invalid PDF figure source.');
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(40_000)]);
  const release = await reserve(signal);
  let pdf: OpenPdf | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let rendering: RenderTask | undefined;
  const cancel = () => rendering?.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const mark = await api<{ pdf_id: string; page: number; kind: string; rects: Crop[] }>(
      `/research/pdf-annotations/${source.annotationId}`, { signal },
    );
    const rect = mark.rects[0];
    if (mark.kind !== 'area' || mark.pdf_id !== source.pdfId || mark.page !== source.page || !rect)
      throw new Error('This PDF figure is unavailable.');
    signal.throwIfAborted();
    pdf = openPdf(source.pdfId);
    const documentProxy = await untilAborted(pdf.promise, signal);
    const page = await untilAborted(documentProxy.getPage(source.page), signal);
    const base = page.getViewport({ scale: 1 });
    const longest = Math.max(base.width * rect.width, base.height * rect.height);
    if (!Number.isFinite(longest) || longest <= 0) throw new Error('Invalid PDF figure dimensions.');
    const viewport = page.getViewport({ scale: Math.min(8, 1400 / longest) });
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width * rect.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height * rect.height));
    rendering = page.render({ canvas, viewport, annotationMode: 0,
      transform: [1, 0, 0, 1, -viewport.width * rect.x, -viewport.height * rect.y] });
    await rendering.promise;
    const output = canvas;
    return await untilAborted(new Promise<Blob>((resolve, reject) => {
      output.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not prepare the PDF figure.')), 'image/png');
    }), signal);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    pdf?.close();
    release();
  }
}

export function displayLiteraturePdfAreaImage(element: HTMLImageElement, src: string, onUnavailable?: () => void) {
  const controller = new AbortController();
  let objectUrl: string | undefined;
  element.dataset.prismPdfFigure = 'loading';
  void renderLiteraturePdfAreaImage(src, controller.signal).then((blob) => {
    if (controller.signal.aborted) return;
    objectUrl = URL.createObjectURL(blob);
    element.src = objectUrl;
    element.dataset.prismPdfFigure = 'ready';
  }).catch(() => {
    if (controller.signal.aborted) return;
    element.dataset.prismPdfFigure = 'unavailable';
    onUnavailable?.();
  });
  return () => {
    controller.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}

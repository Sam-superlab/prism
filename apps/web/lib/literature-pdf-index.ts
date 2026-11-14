import { api, uuid } from './api';
import { literaturePdfPath, loadLiteraturePdf } from './literature-pdfs';
import { canRecognizeLiteraturePdfScans, recognizeLiteraturePdfPage } from './literature-pdf-ocr';

export type LiteraturePdfTextMode = 'embedded' | 'local-ocr';
export type LiteraturePdfIndex = {
  status: 'missing' | 'indexing' | 'ready';
  index_id: string | null;
  next_page: number;
  page_count: number;
  text_mode: LiteraturePdfTextMode | null;
};
export const pdfIndexPath = (id: string) => `${literaturePdfPath(id)}/text-index`;

export async function indexLiteraturePdf(
  id: string,
  signal: AbortSignal,
  progress: (page: number, total: number) => void,
  options: { recognizeScans?: boolean; maxPages?: number } = {},
) {
  const path = pdfIndexPath(id);
  const prior = await api<LiteraturePdfIndex>(path, { signal });
  if (prior.status === 'ready' && (!options.recognizeScans || prior.text_mode === 'local-ocr')) return;
  const requested: LiteraturePdfTextMode | undefined =
    options.recognizeScans === undefined ? undefined : options.recognizeScans ? 'local-ocr' : 'embedded';
  const pending = prior.status === 'indexing' ? (prior.text_mode ?? 'embedded') : undefined;
  if (pending && requested && pending !== requested)
    throw new Error('Finish the pending text index before changing how scans are recognized.');
  const textMode = pending ?? requested ?? 'embedded';
  if (textMode === 'local-ocr' && !canRecognizeLiteraturePdfScans())
    throw new Error('Resume this scan index in PRISM for macOS.');
  const [module, bytes] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    loadLiteraturePdf(id, signal),
  ]);
  signal.throwIfAborted();
  const worker = new Worker(new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url), {
    type: 'module',
  });
  const task = module.getDocument({
    data: new Uint8Array(bytes),
    worker: module.PDFWorker.create({ port: worker }),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    enableXfa: false,
  });
  const abort = () => {
    void task.destroy().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  worker.addEventListener('error', abort, { once: true });
  task.onPassword = abort;
  const openingTimer = setTimeout(abort, 45_000);
  try {
    const pdf = await task.promise;
    clearTimeout(openingTimer);
    signal.throwIfAborted();
    if (options.maxPages && pdf.numPages > options.maxPages) return 'manual';
    if (pdf.numPages > 2000) throw new Error('Indexing supports PDFs with up to 2,000 pages.');
    const indexId = prior.status === 'indexing' ? prior.index_id! : uuid();
    const started = await api<LiteraturePdfIndex>(path, {
      method: 'POST',
      signal,
      body: { index_id: indexId, page_count: pdf.numPages, text_mode: textMode },
    });
    if (started.status === 'ready') return;
    const activeId = started.index_id;
    if (!activeId) throw new Error('The index could not be opened.');
    let start = started.next_page;
    progress(start - 1, pdf.numPages);
    while (start <= pdf.numPages) {
      const pages: string[] = [];
      for (let number = start; number < start + 10 && number <= pdf.numPages; number++) {
        signal.throwIfAborted();
        const page = await pdf.getPage(number);
        try {
          const content = await page.getTextContent();
          const text = content.items
            .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
            .join('');
          const embedded = text.replaceAll('\0', '').trim();
          // Scan-only pages may still carry a page number or punctuation layer.
          const meaningful = (embedded.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 12;
          const recognized =
            textMode === 'local-ocr' && !meaningful ? await recognizeLiteraturePdfPage(page, signal) : '';
          const cleaned = recognized.replaceAll('\0', '').trim() || embedded;
          pages.push([...cleaned].slice(0, 12_000).join(''));
        } finally {
          page.cleanup();
        }
      }
      const batch = await api<{ next_page: number }>(`${path}/pages`, {
        method: 'PUT',
        signal,
        body: { index_id: activeId, start_page: start, pages, text_mode: textMode },
      });
      if (
        !Number.isInteger(batch.next_page) ||
        batch.next_page <= start ||
        batch.next_page > pdf.numPages + 1
      )
        throw new Error('The text index returned an unexpected page number.');
      start = batch.next_page;
      progress(start - 1, pdf.numPages);
    }
    await api(`${path}/complete`, {
      method: 'POST',
      signal,
      body: { index_id: activeId, text_mode: textMode },
    });
  } finally {
    clearTimeout(openingTimer);
    signal.removeEventListener('abort', abort);
    try {
      await task.destroy();
    } finally {
      worker.terminate();
    }
  }
}

import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import { doiPattern } from './bibliography';
import { maxLiteraturePdfBytes } from './literature-pdfs';

export type LiteraturePdfMetadata = {
  title: string;
  authors: string[];
  doi: string | null;
  year: number | null;
};

function text(value: unknown, limit: number) {
  return typeof value === 'string'
    ? value
        .replace(/\p{Cc}/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit) || undefined
    : undefined;
}

function values(value: unknown, limit: number) {
  return (Array.isArray(value) ? value : [value]).flatMap((entry) => text(entry, limit) ?? []);
}

function metadataDoi(value: string) {
  const id = value.replace(/^doi\s*:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  return id.length <= 250 && doiPattern.test(id) ? id : null;
}

function firstPageDoi(value: string) {
  const match =
    /(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)\s*(10\.[0-9]{4,9}\/[\p{L}\p{N}\-._;()/:+]+)/iu.exec(
      value,
    )?.[1];
  if (!match) return null;
  let cleaned = match.replace(/[.,;:]+$/g, '');
  if (cleaned.endsWith(')') && cleaned.split(')').length > cleaned.split('(').length)
    cleaned = cleaned.slice(0, -1);
  return metadataDoi(cleaned);
}

function dateYear(value: unknown) {
  const date = text(value, 200);
  const result = date?.match(/^(?:D:)?([12]\d{3})/)?.[1] ?? date?.match(/\b([12]\d{3})\b/)?.[1];
  return result ? Number(result) : null;
}

export async function extractLiteraturePdfMetadata(
  file: File,
  signal?: AbortSignal,
): Promise<LiteraturePdfMetadata> {
  if (file.size < 8 || file.size > maxLiteraturePdfBytes)
    throw new Error('Choose a PDF no larger than 32 MiB.');
  signal?.throwIfAborted();
  const [pdfjs, bytes] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), file.arrayBuffer()]);
  signal?.throwIfAborted();
  if (new TextDecoder('ascii').decode(bytes.slice(0, 8)).indexOf('%PDF-') !== 0)
    throw new Error('This file does not have a PDF header.');

  const worker = new Worker(new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url), {
    type: 'module',
  });
  let task: PDFDocumentLoadingTask | undefined;
  let cleanupFailure = () => {};
  try {
    const failure = new Promise<never>((_, reject) => {
      const abort = () => reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
      const workerError = () => reject(new Error('The PDF reader could not start.'));
      const timeout = setTimeout(() => reject(new Error('Reading PDF metadata timed out.')), 30_000);
      cleanupFailure = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        worker.removeEventListener('error', workerError);
      };
      signal?.addEventListener('abort', abort, { once: true });
      worker.addEventListener('error', workerError, { once: true });
    });

    task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      worker: pdfjs.PDFWorker.create({ port: worker }),
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      useWasm: false,
      enableXfa: false,
    });
    const read = async () => {
      const pdf = await task!.promise;
      const { info, metadata } = await pdf.getMetadata();
      const known = info as Record<string, unknown>;
      const custom = known.Custom instanceof Map ? known.Custom : undefined;
      const authorNames = values(metadata?.get('dc:creator'), 300);
      if (!authorNames.length)
        authorNames.push(...values(known.Author, 2000).flatMap((names) => names.split(/\s+and\s+|;/i)));
      const authors = [...new Set(authorNames.flatMap((author) => text(author, 300) ?? []))].slice(0, 100);
      const title =
        values(metadata?.get('dc:title'), 500)[0] ??
        text(known.Title, 500) ??
        text(file.name.replace(/\.pdf$/i, ''), 500) ??
        'Untitled PDF';
      let doi =
        [
          ...values(metadata?.get('prism:doi'), 300),
          ...values(metadata?.get('pdfx:doi'), 300),
          ...values(metadata?.get('dc:identifier'), 300),
          ...values(custom?.get('DOI') ?? custom?.get('doi'), 300),
        ]
          .map(metadataDoi)
          .find(Boolean) ?? null;
      if (!doi && pdf.numPages > 0) {
        // Reading only the first page avoids scanning large attachments during capture.
        try {
          const page = await pdf.getPage(1);
          const content = await page.getTextContent();
          const firstPage = content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(' ');
          doi = firstPageDoi(firstPage);
        } catch {
          // A broken first-page text stream should not discard usable document metadata.
        }
      }
      const year =
        [
          metadata?.get('prism:publicationdate'),
          metadata?.get('dc:date'),
          metadata?.get('xmp:createdate'),
          known.CreationDate,
        ]
          .map((value) => values(value, 200).map(dateYear).find(Boolean))
          .find(Boolean) ?? null;
      return { title, authors, doi, year };
    };
    return await Promise.race([read(), failure]);
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'PasswordException')
      throw new Error('This PDF is password-protected. Choose an unlocked copy.');
    throw cause;
  } finally {
    cleanupFailure();
    // A failed worker may not respond to PDF.js's teardown handshake.
    void task?.destroy().catch(() => {});
    worker.terminate();
  }
}

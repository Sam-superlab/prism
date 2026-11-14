import { api, ApiError } from './api';
import { literatureAttachmentDownload, literatureAttachmentPath, type LiteratureAttachment } from './literature-pdfs';
import type { LiteraturePdfIndex } from './literature-pdf-index';

export type LiteratureIndexCandidate = Pick<LiteratureAttachment, 'id' | 'format'>;
const lockName = 'prism.literature-index.v1';
let active = false;

export async function withLiteratureIndexLock<T>(work: () => Promise<T>): Promise<T | undefined> {
  if (active) return;
  if (navigator.locks?.request) {
    return navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      active = true;
      try { return await work(); }
      finally { active = false; }
    });
  }
  active = true;
  try { return await work(); }
  finally { active = false; }
}

export async function buildLiteratureAttachmentIndex(
  candidate: LiteratureIndexCandidate, signal: AbortSignal, progress: (indexed: number, total: number) => void,
  options: { maxSections?: number } = {},
) {
  signal.throwIfAborted();
  const path = `${literatureAttachmentPath(candidate.id)}/text-index`;
  const status = await api<LiteraturePdfIndex>(path, { signal });
  if (status.status === 'ready') return 'existing';
  if (status.text_mode === 'local-ocr') return 'manual';
  if (candidate.format === 'pdf') {
    const { indexLiteraturePdf } = await import('../lib/literature-pdf-index');
    const result = await indexLiteraturePdf(candidate.id, signal, progress, { recognizeScans: false, maxPages: options.maxSections });
    if (result === 'manual') return result;
  } else {
    const [response, { indexLiteratureText }] = await Promise.all([
      fetch(literatureAttachmentDownload(candidate.id), { signal, credentials: 'same-origin', cache: 'no-store' }),
      import('./literature-text-index'),
    ]);
    if (!response.ok) throw new ApiError('ATTACHMENT_UNAVAILABLE', 'Could not open the attachment.', response.status);
    let pages: string[];
    if (candidate.format === 'epub') {
      const { parseLiteratureEpub } = await import('./literature-epub');
      const book = await parseLiteratureEpub(await response.arrayBuffer(), signal);
      pages = book.sections.map(({ blocks }) => blocks.map(({ text }) => text).join('\n\n'));
    } else {
      if (!response.headers.get('content-type')?.startsWith('text/plain')) throw new Error('Could not read the snapshot.');
      pages = (await response.text()).split(/\n{2,}/u);
    }
    if (options.maxSections && pages.length > options.maxSections) return 'manual';
    await indexLiteratureText(candidate.id, pages, signal, progress);
  }
  return 'indexed';
}

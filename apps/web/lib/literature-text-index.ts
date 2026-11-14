import { api, uuid } from './api';
import { literatureAttachmentPath } from './literature-pdfs';
import type { LiteraturePdfIndex } from './literature-pdf-index';

export async function indexLiteratureText(
  id: string, pages: readonly string[], signal: AbortSignal, progress: (indexed: number, total: number) => void,
) {
  if (!pages.length || pages.length > 2000) throw new Error('Indexing supports between 1 and 2,000 sections.');
  const path = `${literatureAttachmentPath(id)}/text-index`;
  const prior = await api<LiteraturePdfIndex>(path, { signal });
  if (prior.status === 'ready') return;
  const started = await api<LiteraturePdfIndex>(path, { method: 'POST', signal, body: {
    index_id: prior.index_id ?? uuid(), page_count: pages.length,
  } });
  if (started.status === 'ready') return;
  if (!started.index_id) throw new Error('The index could not be opened.');
  let offset = started.next_page;
  progress(offset - 1, pages.length);
  while (offset <= pages.length) {
    const batch = pages.slice(offset - 1, offset + 9)
      .map((page) => [...page.replaceAll('\0', '')].slice(0, 12_000).join(''));
    const result = await api<{ next_page: number }>(`${path}/pages`, { method: 'PUT', signal, body: {
      index_id: started.index_id, start_page: offset, pages: batch,
    } });
    if (!Number.isInteger(result.next_page) || result.next_page <= offset || result.next_page > pages.length + 1)
      throw new Error('The index could not advance.');
    offset = result.next_page;
    progress(offset - 1, pages.length);
  }
  await api(`${path}/complete`, { method: 'POST', signal, body: { index_id: started.index_id } });
}

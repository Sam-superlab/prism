import { api } from './api';
import { captureLiteratureAutoIndexOwner, enqueueLiteratureAutoIndex } from './literature-auto-index';

export const maxLiteraturePdfBytes = 32 * 1024 * 1024;
const chunkSize = 512 * 1024;

export type LiteraturePdf = {
  id: string;
  reference_id: string;
  file_name: string;
  size_bytes: number;
  sha256: string;
  version: string;
  status: 'uploading' | 'ready';
  next_offset: number;
};
export type LiteratureAttachmentFormat = 'pdf' | 'epub' | 'webpage';
export type LiteratureAttachment = LiteraturePdf & { format: LiteratureAttachmentFormat };
export const literatureAttachmentExtension = { pdf: 'pdf', epub: 'epub', webpage: 'txt' } as const;
export const literatureAttachmentLabel = { pdf: 'PDF', epub: 'EPUB', webpage: 'page snapshot' } as const;

export type LiteraturePdfUpload = {
  id: string;
  initKey: string;
  completeKey: string;
  chunkKeys: Map<number, string>;
  file: File;
  digest?: string;
};

function base64(bytes: Uint8Array) {
  let raw = '';
  for (let from = 0; from < bytes.length; from += 8192)
    raw += String.fromCharCode(...bytes.subarray(from, from + 8192));
  return btoa(raw);
}

export const literaturePdfPath = (id: string) => `/research/reference-pdfs/${id}`;
export const literaturePdfDownload = (id: string) => `/api/v1${literaturePdfPath(id)}/download`;
export const literatureAttachmentPath = (id: string) => `/research/attachments/${id}`;
export const literatureAttachmentDownload = (id: string) => `/api/v1${literatureAttachmentPath(id)}/download`;

export function loadLiteraturePdf(id: string, signal: AbortSignal) {
  return loadLiteraturePdfDownload(literaturePdfDownload(id), signal);
}

export async function loadLiteraturePdfDownload(path: string, signal: AbortSignal) {
  const response = await fetch(path, { signal, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error?.message ?? 'Could not open this attachment.');
  }
  if (!response.headers.get('content-type')?.startsWith('application/pdf'))
    throw new Error('The saved file could not be opened as a PDF.');
  return response.arrayBuffer();
}

export async function uploadLiteraturePdf(
  referenceId: string,
  upload: LiteraturePdfUpload,
  onProgress: (completed: number) => void,
) {
  return uploadLiteratureAttachment(referenceId, upload, onProgress);
}

export async function prepareLiteratureAttachment(file: File, format?: LiteratureAttachmentFormat) {
  if (!file.size || file.size > maxLiteraturePdfBytes) throw new Error('Choose a file no larger than 32 MiB.');
  const bytes = await file.arrayBuffer();
  if (format === 'epub') {
    const { parseLiteratureEpub } = await import('./literature-epub');
    await parseLiteratureEpub(bytes);
  } else if (format !== 'webpage' && !new TextDecoder('ascii').decode(bytes.slice(0, 8)).startsWith('%PDF-')) {
    throw new Error('This file does not have a PDF header.');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function uploadLiteratureAttachment(
  referenceId: string,
  upload: LiteraturePdfUpload,
  onProgress: (completed: number) => void,
  format?: LiteratureAttachmentFormat,
) {
  const { file, id } = upload;
  const owner = captureLiteratureAutoIndexOwner();
  if (!file.size || file.size > maxLiteraturePdfBytes) throw new Error('Choose a file no larger than 32 MiB.');
  upload.digest ??= await prepareLiteratureAttachment(file, format);

  const started = await api<LiteraturePdf>(`/research/references/${referenceId}/${format ? 'attachments' : 'pdf'}`, {
    method: 'POST',
    key: upload.initKey,
    body: { id, file_name: file.name, size_bytes: file.size, sha256: upload.digest, ...(format && { format }) },
  });
  if (started.status === 'ready') {
    enqueueLiteratureAutoIndex(owner, started.id, format ?? 'pdf', file.size);
    return started;
  }
  const path = format ? literatureAttachmentPath(id) : literaturePdfPath(id);
  let offset = started.next_offset;
  onProgress(offset);
  while (offset < file.size) {
    const data = base64(new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer()));
    const key = upload.chunkKeys.get(offset) ?? crypto.randomUUID();
    upload.chunkKeys.set(offset, key);
    const result = await api<{ next_offset: number }>(`${path}/chunk`, {
      method: 'PUT',
      key,
      body: { offset, data },
    });
    if (!Number.isInteger(result.next_offset) || result.next_offset <= offset || result.next_offset > file.size)
      throw new Error('The upload returned an unexpected file position.');
    offset = result.next_offset;
    onProgress(offset);
  }
  const saved = await api<LiteraturePdf>(`${path}/complete`, { method: 'POST', key: upload.completeKey, body: {} });
  if (saved.status === 'ready') enqueueLiteratureAutoIndex(owner, saved.id, format ?? 'pdf', file.size);
  return saved;
}

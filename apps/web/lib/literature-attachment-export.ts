import { strToU8, Zip, ZipPassThrough } from 'fflate';
import {
  literatureAttachmentDownload,
  literatureAttachmentExtension,
  type LiteratureAttachment,
} from './literature-pdfs';

export const maxLiteratureAttachmentArchiveBytes = 64 * 1024 * 1024;
const maxAttachments = 200;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const archiveMime = 'application/zip';

function archiveEntryName(file: LiteratureAttachment, used: Set<string>) {
  const extension = '.' + literatureAttachmentExtension[file.format];
  const cleaned = file.file_name
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '_')
    .replace(/^[.\s]+|[.\s]+$/gu, '');
  const withoutExtension = cleaned.toLowerCase().endsWith(extension)
    ? cleaned.slice(0, -extension.length)
    : cleaned;
  let stem =
    [...withoutExtension]
      .slice(0, 55)
      .join('')
      .replace(/[.\s]+$/gu, '') || 'Attachment';
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(stem)) stem = '_' + stem;
  let name = stem + extension;
  for (let count = 2; used.has(name.toLowerCase()); count++) name = `${stem} (${count})${extension}`;
  used.add(name.toLowerCase());
  return 'attachments/' + name;
}

function planArchive(referenceId: string, attachments: readonly LiteratureAttachment[]) {
  const files = attachments.filter((file) => file.status === 'ready');
  if (!files.length) throw new Error('No attachments are ready to export.');
  if (!uuidPattern.test(referenceId) || files.length > maxAttachments)
    throw new Error('This attachment list cannot be exported as one archive.');
  const ids = new Set<string>();
  const used = new Set<string>();
  const owner = files[0].reference_id;
  let totalBytes = 0;
  return files.map((file) => {
    if (
      !uuidPattern.test(file.id) ||
      ids.has(file.id) ||
      // A merged reference's attachment list contains the canonical owner ID.
      !uuidPattern.test(owner) ||
      file.reference_id !== owner ||
      !Object.hasOwn(literatureAttachmentExtension, file.format) ||
      typeof file.file_name !== 'string' ||
      !file.file_name ||
      file.file_name.length > 200 ||
      !Number.isSafeInteger(file.size_bytes) ||
      file.size_bytes <= 0 ||
      !/^[a-f0-9]{64}$/i.test(file.sha256)
    )
      throw new Error('Could not verify the saved attachment list.');
    ids.add(file.id);
    totalBytes += file.size_bytes;
    if (totalBytes > maxLiteratureAttachmentArchiveBytes)
      throw new Error('These attachments exceed 64 MiB. Download them individually.');
    return { file, path: archiveEntryName(file, used) };
  });
}

async function verifiedAttachment(response: Response, file: LiteratureAttachment, signal: AbortSignal) {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`Could not download “${file.file_name}”.`);
  }
  const bytes = new Uint8Array(file.size_bytes);
  const reader = response.body.getReader();
  const cancelRead = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancelRead, { once: true });
  let offset = 0;
  let finished = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        break;
      }
      if (offset + chunk.value.byteLength > bytes.byteLength)
        throw new Error(`The downloaded size of “${file.file_name}” changed.`);
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
  } finally {
    signal.removeEventListener('abort', cancelRead);
    if (!finished) cancelRead();
    reader.releaseLock();
  }
  signal.throwIfAborted();
  if (offset !== bytes.byteLength) throw new Error(`The download of “${file.file_name}” was incomplete.`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== file.sha256.toLowerCase())
    throw new Error(`Could not verify the contents of “${file.file_name}”.`);
  signal.throwIfAborted();
  return bytes;
}

type ExportOptions = {
  signal: AbortSignal;
  onProgress?: (filesCompleted: number, totalFiles: number) => void;
  fetchAttachment?: (id: string, signal: AbortSignal) => Promise<Response>;
};

const fetchLocalAttachment = (id: string, signal: AbortSignal) =>
  fetch(literatureAttachmentDownload(id), {
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
    redirect: 'error',
  });

export async function exportLiteratureAttachments(
  referenceId: string,
  attachments: readonly LiteratureAttachment[],
  { signal, onProgress, fetchAttachment = fetchLocalAttachment }: ExportOptions,
): Promise<Blob> {
  signal.throwIfAborted();
  const files = planArchive(referenceId, attachments);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const archive = new Zip((error, data) => {
    if (error) throw error;
    chunks.push(data);
  });
  function add(name: string, bytes: Uint8Array<ArrayBuffer>) {
    const entry = new ZipPassThrough(name);
    archive.add(entry);
    entry.push(bytes, true);
  }
  try {
    onProgress?.(0, files.length);
    for (const [index, { file, path }] of files.entries()) {
      signal.throwIfAborted();
      const response = await fetchAttachment(file.id, signal);
      add(path, await verifiedAttachment(response, file, signal));
      onProgress?.(index + 1, files.length);
    }
    signal.throwIfAborted();
    const manifest = {
      version: 1,
      reference_id: files[0].file.reference_id,
      attachments: files.map(({ file, path }) => ({
        id: file.id,
        file_name: file.file_name,
        format: file.format,
        size_bytes: file.size_bytes,
        sha256: file.sha256.toLowerCase(),
        path,
      })),
    };
    add('manifest.json', strToU8(JSON.stringify(manifest, null, 2) + '\n'));
    archive.end();
    return new Blob(chunks, { type: archiveMime });
  } catch (error) {
    archive.terminate();
    throw error;
  }
}

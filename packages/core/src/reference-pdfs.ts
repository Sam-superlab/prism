import { createHash } from 'node:crypto';
import type { Row, Sql } from '@prism/database';
import { ApiError, validation } from './errors';
import type { PrismService } from './service';

const table = 'research_reference_pdfs';
const chunks = 'research_reference_pdf_chunks';
const maxChunkBytes = 524_288;
const maxAttachmentsPerReference = 100;
const maxPending = 8;
const expiresAfter = 86_400_000;
const pdfHeader = /^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/;
export type ReferenceAttachmentFormat = 'pdf' | 'epub' | 'webpage';
const maxWebpageBytes = 262_144;
const epubMime = Buffer.from('application/epub+zip', 'ascii');

function validEpubHeader(bytes: Buffer) {
  // The EPUB OCF first local ZIP entry is a stored, unencrypted mimetype with no extra fields.
  if (bytes.length < 38 + epubMime.length || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  const flags = bytes.readUInt16LE(6);
  return !(flags & 0x49) && bytes.readUInt16LE(8) === 0 &&
    bytes.readUInt32LE(18) === epubMime.length && bytes.readUInt32LE(22) === epubMime.length &&
    bytes.readUInt16LE(26) === 8 && bytes.readUInt16LE(28) === 0 &&
    bytes.subarray(30, 38).equals(Buffer.from('mimetype')) &&
    bytes.subarray(38, 38 + epubMime.length).equals(epubMime);
}

type WriteContext = { sql: Sql; userId: string };
type Change = (row: Row) => Promise<void>;

function expired(row: Row) {
  return row.status === 'uploading' && Date.now() - new Date(row.updated_at).getTime() > expiresAfter;
}

export function safeAttachmentFileName(raw: string, format: ReferenceAttachmentFormat) {
  const name = raw.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
  const extension = format === 'webpage' ? 'txt' : format;
  if (!name || !name.toLowerCase().endsWith(`.${extension}`))
    throw validation(`Choose a file with a .${extension} extension.`);
  return name;
}

function bytesFromBase64(value: string) {
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maxChunkBytes || bytes.toString('base64') !== value)
    throw validation('Provide a valid base64 attachment chunk of at most 512 KiB.');
  return bytes;
}

export function pdfDisposition(fileName: string) {
  const ascii = fileName.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'reference.pdf';
  const unicode = encodeURIComponent(Buffer.from(fileName, 'utf8').toString('utf8')).replace(
    /['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${unicode}`;
}

export async function beginReferenceAttachment(
  service: PrismService,
  ctx: WriteContext,
  referenceId: string,
  input: Row,
  format: ReferenceAttachmentFormat,
) {
  await service.row(ctx.sql, ctx.userId, 'research_references', referenceId);
  if (format === 'webpage' && input.size_bytes > maxWebpageBytes)
    throw validation('Webpage snapshots can be up to 256 KiB.');
  const fileName = safeAttachmentFileName(input.file_name, format);
  const args = [ctx.userId, referenceId];
  const { rows: stale } = await ctx.sql.query(
    `SELECT id FROM ${table} WHERE user_id=$1 AND status='uploading' AND deleted_at IS NULL
       AND updated_at<now()-interval '24 hours'`,
    [ctx.userId],
  );
  for (const upload of stale) await removeReferencePdf(service, ctx, upload.id);
  const { rows: byId } = await ctx.sql.query(
    `SELECT * FROM ${table} WHERE user_id=$1 AND id=$2`, [ctx.userId, input.id],
  );
  const existing = byId[0];
  if (existing) {
    if (
      existing.deleted_at || existing.reference_id !== referenceId || existing.file_name !== fileName ||
      existing.format !== format || existing.sha256 !== input.sha256 || existing.size_bytes !== input.size_bytes
    ) throw new ApiError(409, 'VALIDATION_ERROR', 'This upload ID is already in use. Start a new upload.');
    return existing;
  }
  const { rows: ready } = await ctx.sql.query(
    `SELECT * FROM ${table} WHERE user_id=$1 AND reference_id=$2 AND sha256=$3
       AND size_bytes=$4 AND format=$5 AND status='ready' AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1`,
    [...args, input.sha256, input.size_bytes, format],
  );
  if (ready[0]) return ready[0];
  const { rows: counts } = await ctx.sql.query(
    `SELECT count(*) FILTER (WHERE status='ready' AND reference_id=$2)::int AS ready,
            count(*) FILTER (WHERE status='uploading')::int AS pending
       FROM ${table} WHERE user_id=$1 AND deleted_at IS NULL`,
    args,
  );
  if (counts[0].ready >= maxAttachmentsPerReference) throw validation('This reference already has 100 attachments.');
  if (counts[0].pending >= maxPending) throw validation('Finish or cancel an existing attachment upload first.');
  return service.insert(ctx.sql, table, {
    id: input.id, reference_id: referenceId, file_name: fileName, size_bytes: input.size_bytes, sha256: input.sha256, format,
  }, ctx.userId);
}

export async function appendReferenceAttachment(
  service: PrismService,
  ctx: WriteContext,
  id: string,
  input: Row,
  onlyFormat?: ReferenceAttachmentFormat,
) {
  const row = await service.row(ctx.sql, ctx.userId, table, id);
  if (onlyFormat && row.format !== onlyFormat) throw new ApiError(404, 'NOT_FOUND', 'Attachment not found.');
  if (expired(row)) throw new ApiError(410, 'UPLOAD_EXPIRED', 'This attachment upload expired. Start a new upload.');
  const bytes = bytesFromBase64(input.data);
  if (input.offset < row.next_offset) {
    const { rows } = await ctx.sql.query(
      `SELECT data FROM ${chunks} WHERE user_id=$1 AND pdf_id=$2 AND byte_offset=$3`,
      [ctx.userId, id, input.offset],
    );
    if (rows[0] && bytes.equals(Buffer.from(rows[0].data))) return { next_offset: row.next_offset };
  }
  if (row.status !== 'uploading' || input.offset !== row.next_offset)
    throw new ApiError(409, 'VALIDATION_ERROR', 'Send attachment chunks in order.', { next_offset: row.next_offset });
  const next = row.next_offset + bytes.length;
  if (next > row.size_bytes) throw validation('Attachment chunk exceeds the declared size.');
  if (bytes.length !== Math.min(maxChunkBytes, row.size_bytes - row.next_offset))
    throw validation('Send 512 KiB chunks except for the final chunk.');
  await ctx.sql.query(
    `INSERT INTO ${chunks}(user_id,pdf_id,byte_offset,data) VALUES($1,$2,$3,$4)`,
    [ctx.userId, id, input.offset, bytes],
  );
  await ctx.sql.query(
    `UPDATE ${table} SET next_offset=$3,updated_at=now() WHERE user_id=$1 AND id=$2`,
    [ctx.userId, id, next],
  );
  return { next_offset: next };
}

async function readBytes(ctx: WriteContext, id: string, size: number) {
  const { rows } = await ctx.sql.query(
    `SELECT byte_offset,data FROM ${chunks} WHERE user_id=$1 AND pdf_id=$2 ORDER BY byte_offset`,
    [ctx.userId, id],
  );
  let offset = 0;
  const buffers: Buffer[] = [];
  for (const chunk of rows) {
    if (chunk.byte_offset !== offset) throw validation('The attachment is missing data.');
    const bytes = Buffer.from(chunk.data);
    buffers.push(bytes);
    offset += bytes.length;
  }
  if (offset !== size) throw validation('The attachment size does not match the upload.');
  return buffers;
}

const workspaceAttachmentExportLimit = 64 * 1024 * 1024;
const workspaceAttachmentFileLimit = 1000;
const attachmentExtensions: Record<ReferenceAttachmentFormat, string> = { pdf: 'pdf', epub: 'epub', webpage: 'txt' };

export async function workspaceAttachmentArchive(sql: Sql, userId: string) {
  const { rows } = await sql.query<{
    id: string; reference_id: string; size_bytes: number; sha256: string; file_name: string; format: ReferenceAttachmentFormat;
  }>(`SELECT a.id,a.reference_id,a.size_bytes,a.sha256,a.file_name,a.format
      FROM research_reference_pdfs a JOIN research_references r ON (a.user_id,a.reference_id)=(r.user_id,r.id)
      WHERE a.user_id=$1 AND a.status='ready' AND a.deleted_at IS NULL AND r.deleted_at IS NULL
      ORDER BY a.id LIMIT $2`, [userId, workspaceAttachmentFileLimit + 1]);
  const size = rows.reduce((sum, row) => sum + Number(row.size_bytes), 0);
  if (rows.length > workspaceAttachmentFileLimit || size > workspaceAttachmentExportLimit)
    throw new ApiError(422, 'ATTACHMENT_EXPORT_LIMIT', 'Attachment export supports up to 1,000 files and 64 MiB total. Export files by reference for larger libraries.');
  const invalidAttachment = () => new ApiError(422, 'ATTACHMENT_EXPORT_INVALID', 'An attachment failed verification. Export your records separately and check the original files.');
  const result: Array<(typeof rows)[number] & { path: string; bytes: Buffer }> = [];
  for (const row of rows) {
    let bytes: Buffer;
    try {
      const size = Number(row.size_bytes);
      bytes = Buffer.concat(await readBytes({ sql, userId }, row.id, size), size);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      throw invalidAttachment();
    }
    if (createHash('sha256').update(bytes).digest('hex') !== row.sha256)
      throw invalidAttachment();
    result.push({ ...row, path: `attachments/${row.id}.${attachmentExtensions[row.format]}`, bytes });
  }
  return result;
}

export async function completeReferenceAttachment(
  service: PrismService, ctx: WriteContext, id: string, change: Change, onlyFormat?: ReferenceAttachmentFormat,
) {
  const row = await service.row(ctx.sql, ctx.userId, table, id);
  if (onlyFormat && row.format !== onlyFormat) throw new ApiError(404, 'NOT_FOUND', 'Attachment not found.');
  await service.row(ctx.sql, ctx.userId, 'research_references', row.reference_id);
  if (row.status === 'ready') return row;
  if (expired(row)) throw new ApiError(410, 'UPLOAD_EXPIRED', 'This PDF upload expired. Start a new upload.');
  if (row.next_offset !== row.size_bytes)
    throw new ApiError(409, 'VALIDATION_ERROR', 'The PDF upload is incomplete.', { next_offset: row.next_offset });
  const buffers = await readBytes(ctx, id, row.size_bytes);
  if (row.format === 'pdf' && !pdfHeader.test(buffers[0].subarray(0, 10).toString('ascii')))
    throw validation('The uploaded file does not start with a PDF header.');
  if (row.format === 'epub' && !validEpubHeader(buffers[0]))
    throw validation('The uploaded file does not start with a valid EPUB mimetype entry.');
  if (row.format === 'webpage') {
    let text: string;
    try {
      // Web snapshots fit in one chunk by construction.
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffers[0]);
    } catch {
      throw validation('Webpage snapshots must use UTF-8 text.');
    }
    if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text))
      throw validation('Webpage snapshots must contain readable plain text.');
  }
  const hash = createHash('sha256');
  for (const bytes of buffers) hash.update(bytes);
  if (hash.digest('hex') !== row.sha256) throw validation('The attachment failed its integrity check. Start a new upload.');
  const { rows } = await ctx.sql.query(
    `SELECT * FROM ${table} WHERE user_id=$1 AND reference_id=$2 AND sha256=$3
       AND size_bytes=$4 AND format=$5 AND status='ready' AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1`,
    [ctx.userId, row.reference_id, row.sha256, row.size_bytes, row.format],
  );
  if (rows[0]) {
    await removeReferencePdf(service, ctx, id);
    return rows[0];
  }
  const updated = await service.update(ctx.sql, ctx.userId, table, id, { status: 'ready' });
  await change(updated);
  return updated;
}

export async function removeReferencePdf(
  service: PrismService,
  ctx: WriteContext,
  id: string,
  change?: Change,
) {
  const deleted = await service.update(ctx.sql, ctx.userId, table, id, { deleted_at: new Date() });
  // Null the binary data in place to avoid granting DELETE to hosted runtime roles.
  await ctx.sql.query(
    `UPDATE ${chunks} SET data=NULL WHERE user_id=$1 AND pdf_id=$2`, [ctx.userId, id],
  );
  if (change && deleted.status === 'ready') await change(deleted);
}

export async function moveReferencePdfs(
  service: PrismService,
  ctx: WriteContext,
  sourceId: string,
  targetId: string,
  change: Change,
) {
  const { rows } = await ctx.sql.query(
    `SELECT id,status FROM ${table} WHERE user_id=$1 AND reference_id=$2 AND deleted_at IS NULL`,
    [ctx.userId, sourceId],
  );
  for (const row of rows) {
    if (row.status === 'uploading') await removeReferencePdf(service, ctx, row.id);
    else await change(await service.update(ctx.sql, ctx.userId, table, row.id, { reference_id: targetId }));
  }
}

export async function downloadReferenceAttachment(
  service: PrismService, userId: string, id: string, onlyFormat?: ReferenceAttachmentFormat,
) {
  return service.db.transaction(userId, async (sql) => {
    const row = await service.row(sql, userId, table, id);
    if (row.status !== 'ready' || (onlyFormat && row.format !== onlyFormat))
      throw new ApiError(404, 'NOT_FOUND', 'Attachment not found.');
    await service.row(sql, userId, 'research_references', row.reference_id);
    const bytes = Buffer.concat(await readBytes({ sql, userId }, id, row.size_bytes), row.size_bytes);
    return { bytes, fileName: row.file_name as string, format: row.format as ReferenceAttachmentFormat };
  }, 'repeatable read');
}

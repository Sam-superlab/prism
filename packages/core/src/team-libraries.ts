import { createHash, randomUUID } from 'node:crypto';
import type { Row, Sql } from '@prism/database';
import type { HostedAccount } from './config';
import { ApiError, notFound, validation } from './errors';
import { validatePdfAnnotation } from './pdf-annotation-validation';
import type { Command, Result } from './service';

const maxOwnedLibraries = 50;
const maxTeamMembers = 100;
const maxTeamReferences = 5000;
const maxNotesPerReference = 100;
const maxAnnotationsPerAttachment = 5000;
const maxTeamAttachmentBytes = 250 * 1024 * 1024;
const sharedPublicationFields = [
  'type', 'journal', 'booktitle', 'publisher', 'volume', 'number', 'pages', 'edition',
  'institution', 'series', 'address', 'isbn', 'issn', 'editor', 'pmid', 'month',
];

type Scope = { sql: Sql; userId: string };
type Mutation = Scope & { expected?: string };
type Cursor = {
  decode: (token: string) => Row;
  encode: (payload: Row) => string;
};

function clean(value: string, label: string) {
  const result = value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (!result) throw validation(`Enter ${label}.`);
  return result;
}
function version(row: Row, expected?: string) {
  if (!expected) throw new ApiError(428, 'PRECONDITION_REQUIRED', 'If-Match version is required.');
  if (String(row.version) !== expected) throw new ApiError(412, 'VERSION_CONFLICT', 'This record changed on another device.', {
    current_version: String(row.version),
  });
}
export function serializeTeamLibrary(row: Row) {
  return {
    id: row.id, name: row.name, description: row.description, role: row.role, visibility: row.visibility,
    created_by: row.created_by, updated_by: row.updated_by,
    created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(),
    version: String(row.version),
  };
}
function member(row: Row) {
  return { user_id: row.user_id, display_name: row.display_name, role: row.role, version: String(row.version) };
}
function reference(row: Row) {
  return {
    id: row.id, library_id: row.library_id, title: row.title, authors: row.authors, year: row.year, doi: row.doi,
    url: row.url, publication: row.publication, tags: row.tags, created_by: row.created_by, updated_by: row.updated_by,
    created_by_name: row.created_by_name, updated_by_name: row.updated_by_name,
    created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(),
    version: String(row.version),
  };
}
function note(row: Row) {
  return {
    id: row.id, library_id: row.library_id, reference_id: row.reference_id, title: row.title, content: row.content,
    created_by: row.created_by, created_by_name: row.created_by_name, updated_by: row.updated_by,
    updated_by_name: row.updated_by_name, created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(), version: String(row.version),
  };
}
function attachment(row: Row) {
  return {
    id: row.id, library_id: row.library_id, reference_id: row.reference_id, file_name: row.file_name,
    size_bytes: row.size_bytes, sha256: row.sha256, created_by: row.created_by, created_by_name: row.created_by_name,
    created_at: new Date(row.created_at).toISOString(), version: String(row.version),
  };
}
function annotation(row: Row) {
  return {
    id: row.id, library_id: row.library_id, reference_id: row.reference_id, attachment_id: row.attachment_id,
    page: row.page, kind: row.kind, color: row.color, text: row.text, comment: row.comment, tags: row.tags,
    rects: row.rects, ink_path: row.ink_path, created_by: row.created_by, created_by_name: row.created_by_name,
    updated_by: row.updated_by, updated_by_name: row.updated_by_name,
    created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(), version: String(row.version),
  };
}
export async function readTeamLibrary(scope: Scope, id: string) {
  const row = (await scope.sql.query(
    'SELECT t.*,prism.team_library_role(t.id) AS role FROM team_libraries t WHERE t.id=$1 AND t.deleted_at IS NULL',
    [id],
  )).rows[0];
  if (!row?.role) throw notFound();
  return row;
}
function requireRole(row: Row, ...roles: string[]) {
  if (!roles.includes(row.role)) throw new ApiError(403, 'FORBIDDEN', 'Your role cannot perform this team library action.');
}
export async function authorizeTeamCommand(sql: Sql, command: Command) {
  const [, libraryId, section, refId, nested, attachmentId, content, itemId] = command.path.split('/');
  const id = libraryId ?? command.body?.id;
  if (!id) throw notFound();
  // Serialize group writers across accounts and recheck access before replaying any receipt.
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('prism-team:' || $1::uuid::text,0))", [id]);
  if (!libraryId) return;
  const row = (await sql.query('SELECT prism.team_library_role($1) AS role', [id])).rows[0];
  if (section === 'join') {
    if (!row?.role) await checkOpenTeamJoin({ sql, userId: command.userId }, id);
    return;
  }
  if (!row?.role && command.method === 'DELETE' && !section) return;
  if (!row?.role) throw notFound();
  requireRole(row, ...(section === 'references' ? ['admin', 'editor'] : ['admin']));
  if (nested === 'attachments') {
    requireTeamFiles(await readTeamLibrary({ sql, userId: command.userId }, id));
    if (content === 'annotations') {
      await teamAttachmentRow(sql, id, refId, attachmentId);
      if (itemId) {
        const item = await teamAnnotationRow(sql, id, refId, attachmentId, itemId, command.method === 'DELETE');
        requireAnnotationEditor(row, command.userId, item);
      }
    }
  }
  if (nested === 'notes') requireTeamNotes(await readTeamLibrary({ sql, userId: command.userId }, id));
}
async function checkOpenTeamJoin(scope: Scope, libraryId: string) {
  const publicState = (await scope.sql.query(`SELECT prism.team_library_public($1) AS visible,
    prism.team_library_open($1) AS open`, [libraryId])).rows[0];
  if (!publicState.visible) throw notFound();
  if (!publicState.open) throw new ApiError(403, 'FORBIDDEN', 'An administrator must add you to this library.');
  if (await memberRow(scope, libraryId, scope.userId, true))
    throw new ApiError(403, 'FORBIDDEN', 'An administrator must restore your membership.');
}
async function joinTeamLibrary(scope: Mutation, libraryId: string): Promise<Result> {
  const { sql, userId } = scope;
  const existing = (await sql.query('SELECT prism.team_library_role($1) AS role', [libraryId])).rows[0];
  if (!existing?.role) {
    await checkOpenTeamJoin(scope, libraryId);
    const name = await accountName(scope, libraryId, userId);
    await sql.query(`INSERT INTO team_library_members(library_id,user_id,display_name,role,added_by,updated_by)
      VALUES($1,$2,$3,'reader',$2,$2)`, [libraryId, userId, name]);
    await audit(scope, libraryId, 'member_joined', userId);
  }
  return { status: 200, body: serializeTeamLibrary(await readTeamLibrary(scope, libraryId)) };
}
async function audit(scope: Scope, libraryId: string, action: string, subjectId: string) {
  await scope.sql.query('INSERT INTO team_library_events(id,library_id,actor_id,action,subject_id) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), libraryId, scope.userId, action, subjectId]);
}
async function accountName(scope: Scope, libraryId: string, userId: string): Promise<string> {
  const row = (await scope.sql.query('SELECT prism.team_library_account_name($1,$2) AS name', [libraryId, userId])).rows[0];
  if (!row?.name) throw notFound();
  return row.name;
}
export async function saveTeamAccountName(sql: Sql, userId: string, name: string) {
  const displayName = [...name.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()].slice(0, 200).join('') || 'PRISM member';
  await sql.query(`INSERT INTO team_account_profiles(user_id,display_name) VALUES($1,$2)
    ON CONFLICT(user_id) DO UPDATE SET display_name=EXCLUDED.display_name`, [userId, displayName]);
}
async function memberRow(scope: Scope, libraryId: string, userId: string, includeDeleted = false) {
  return (await scope.sql.query(
    `SELECT * FROM team_library_members WHERE library_id=$1 AND user_id=$2${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
    [libraryId, userId],
  )).rows[0];
}
async function referenceRow(scope: Scope, libraryId: string, id: string) {
  const row = (await scope.sql.query('SELECT * FROM team_library_references WHERE library_id=$1 AND id=$2 AND deleted_at IS NULL', [libraryId, id])).rows[0];
  if (!row) throw notFound();
  return row;
}
function requireTeamFiles(library: Row) {
  if (library.visibility === 'public_open')
    throw new ApiError(409, 'VALIDATION_ERROR', 'PDF sharing is available in private and public-closed libraries.');
}
function requireTeamNotes(library: Row) {
  if (library.visibility === 'public_open')
    throw new ApiError(409, 'VALIDATION_ERROR', 'Team notes are available in private and public-closed libraries.');
}
async function teamAttachmentRow(sql: Sql, libraryId: string, refId: string, id: string) {
  const row = (await sql.query(`SELECT * FROM team_library_attachments
    WHERE library_id=$1 AND reference_id=$2 AND id=$3 AND deleted_at IS NULL`, [libraryId, refId, id])).rows[0];
  if (!row) throw notFound();
  return row;
}
async function teamAnnotationRow(sql: Sql, libraryId: string, refId: string, attachmentId: string, id: string, includeDeleted = false) {
  const row = (await sql.query(`SELECT * FROM team_pdf_annotations WHERE library_id=$1 AND reference_id=$2
    AND attachment_id=$3 AND id=$4 ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`, [libraryId, refId, attachmentId, id])).rows[0];
  if (!row) throw notFound();
  return row;
}
function requireAnnotationEditor(library: Row, userId: string, item: Row) {
  if (library.role !== 'admin' && item.created_by !== userId)
    throw new ApiError(403, 'FORBIDDEN', 'Only the annotation author or a team administrator can edit it.');
}
async function readTeamAnnotations(scope: Scope, library: Row, refId: string, attachmentId: string, query: Row, cursor: Cursor, id?: string): Promise<Row> {
  requireTeamFiles(library);
  const { sql } = scope;
  const libraryId = library.id;
  await referenceRow(scope, libraryId, refId);
  await teamAttachmentRow(sql, libraryId, refId, attachmentId);
  if (id) return annotation(await teamAnnotationRow(sql, libraryId, refId, attachmentId, id));
  const limit = Math.min(100, Number(query.limit) || 50);
  const page = query.page ?? null;
  const decoded = query.cursor ? cursor.decode(query.cursor) : undefined;
  if (decoded && (decoded.library !== libraryId || decoded.reference !== refId || decoded.attachment !== attachmentId || decoded.page !== page))
    throw validation('Cursor belongs to a different annotation list.');
  const { rows } = await sql.query(`SELECT *,created_at::text AS cursor_time FROM team_pdf_annotations
    WHERE library_id=$1 AND reference_id=$2 AND attachment_id=$3 AND deleted_at IS NULL AND ($4::int IS NULL OR page=$4)
    ${decoded ? 'AND (created_at,id)>($6::timestamptz,$7::uuid)' : ''} ORDER BY created_at,id LIMIT $5`,
    [libraryId, refId, attachmentId, page, limit + 1, ...(decoded ? [decoded.time, decoded.id] : [])]);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items: items.map(annotation), next_cursor: rows.length > limit && last
    ? cursor.encode({ library: libraryId, reference: refId, attachment: attachmentId, page, time: last.cursor_time, id: last.id }) : null };
}
async function mutateTeamAnnotation(scope: Mutation, library: Row, refId: string, attachmentId: string, method: string, body: Row, id?: string): Promise<Result> {
  requireTeamFiles(library);
  requireRole(library, 'admin', 'editor');
  const { sql, userId } = scope;
  const libraryId = library.id;
  await referenceRow(scope, libraryId, refId);
  await teamAttachmentRow(sql, libraryId, refId, attachmentId);
  const name = await accountName(scope, libraryId, userId);
  if (method === 'POST' && !id) {
    validatePdfAnnotation(body);
    const { rows } = await sql.query(`SELECT count(*)::int AS count FROM team_pdf_annotations
      WHERE library_id=$1 AND attachment_id=$2 AND deleted_at IS NULL`, [libraryId, attachmentId]);
    if (rows[0].count >= maxAnnotationsPerAttachment) throw validation('This PDF already has 5,000 shared annotations.');
    const created = (await sql.query(`INSERT INTO team_pdf_annotations(id,library_id,reference_id,attachment_id,page,kind,color,
      text,comment,tags,rects,ink_path,created_by,updated_by,created_by_name,updated_by_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$13,$14,$14) RETURNING *`,
      [body.id, libraryId, refId, attachmentId, body.page, body.kind, body.color ?? 'yellow', body.text ?? '', body.comment ?? '',
        body.tags ?? [], JSON.stringify(body.rects), body.ink_path ? JSON.stringify(body.ink_path) : null, userId, name])).rows[0];
    await audit(scope, libraryId, 'reference_annotation_created', created.id);
    return { status: 201, body: annotation(created) };
  }
  if (!id) throw notFound();
  const old = await teamAnnotationRow(sql, libraryId, refId, attachmentId, id);
  requireAnnotationEditor(library, userId, old);
  version(old, scope.expected);
  const base = [libraryId, refId, attachmentId, id, userId, name];
  if (method === 'PATCH') {
    validatePdfAnnotation(body, old);
    const fields = Object.entries(body).filter(([field]) => ['page', 'kind', 'color', 'text', 'comment', 'tags', 'rects', 'ink_path'].includes(field));
    if (!fields.length) throw validation('Enter an annotation change.');
    const json = (field: string) => field === 'rects' || field === 'ink_path';
    const sets = fields.map(([field], index) => `${field}=$${index + 7}${json(field) ? '::jsonb' : ''}`);
    const updated = (await sql.query(`UPDATE team_pdf_annotations SET ${sets.join(',')},updated_by=$5,updated_by_name=$6,
      updated_at=now(),version=version+1 WHERE library_id=$1 AND reference_id=$2 AND attachment_id=$3 AND id=$4 RETURNING *`,
      [...base, ...fields.map(([field, value]) => json(field) && value !== null ? JSON.stringify(value) : value)])).rows[0];
    await audit(scope, libraryId, 'reference_annotation_updated', id);
    return { status: 200, body: annotation(updated) };
  }
  if (method !== 'DELETE') throw notFound();
  await sql.query(`UPDATE team_pdf_annotations SET deleted_at=now(),updated_at=now(),version=version+1,
    updated_by=$5,updated_by_name=$6 WHERE library_id=$1 AND reference_id=$2 AND attachment_id=$3 AND id=$4`, base);
  await audit(scope, libraryId, 'reference_annotation_deleted', id);
  return { status: 204, body: null };
}
async function clearTeamAttachments(sql: Sql, libraryId: string, refId?: string, id?: string) {
  const filter = [libraryId, refId ?? null, id ?? null];
  const scope = 'library_id=$1 AND ($2::uuid IS NULL OR reference_id=$2) AND ($3::uuid IS NULL OR id=$3) AND deleted_at IS NULL';
  await sql.query(`UPDATE team_library_attachment_chunks SET data=NULL WHERE library_id=$1 AND data IS NOT NULL
    AND attachment_id IN (SELECT id FROM team_library_attachments WHERE ${scope})`, filter);
  await sql.query(`UPDATE team_library_attachments SET deleted_at=now(),version=version+1 WHERE ${scope}`, filter);
}
export async function downloadTeamLibraryPdf(scope: Scope, libraryId: string, refId: string, id: string) {
  const { sql } = scope;
  await sql.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('prism-team:' || $1::uuid::text,0))", [libraryId]);
  const library = await readTeamLibrary(scope, libraryId);
  requireTeamFiles(library);
  await referenceRow(scope, libraryId, refId);
  const file = await teamAttachmentRow(sql, libraryId, refId, id);
  const { rows } = await sql.query(`SELECT byte_offset,data FROM team_library_attachment_chunks
    WHERE library_id=$1 AND attachment_id=$2 ORDER BY byte_offset`, [libraryId, id]);
  let offset = 0;
  const parts: Buffer[] = [];
  const digest = createHash('sha256');
  for (const row of rows) {
    if (row.byte_offset !== offset || !row.data) throw notFound();
    const bytes = Buffer.from(row.data);
    offset += bytes.length;
    if (offset > file.size_bytes) throw notFound();
    digest.update(bytes);
    parts.push(bytes);
  }
  if (offset !== file.size_bytes || digest.digest('hex') !== file.sha256) throw notFound();
  return { bytes: Buffer.concat(parts, offset), fileName: file.file_name as string };
}
async function mutateTeamAttachment(scope: Mutation, library: Row, refId: string, method: string, body: Row, id?: string): Promise<Result> {
  requireTeamFiles(library);
  requireRole(library, 'admin', 'editor');
  const { sql, userId } = scope;
  const libraryId = library.id;
  await referenceRow(scope, libraryId, refId);
  if (method === 'POST' && !id) {
    const source = (await sql.query(`SELECT a.id,a.file_name,a.size_bytes,a.sha256 FROM research_reference_pdfs a
      JOIN research_references r ON r.user_id=a.user_id AND r.id=a.reference_id AND r.deleted_at IS NULL
      WHERE a.user_id=$1 AND a.id=$2 AND a.format='pdf' AND a.status='ready' AND a.deleted_at IS NULL`,
      [userId, body.attachment_id])).rows[0];
    if (!source) throw notFound();
    const duplicate = (await sql.query(`SELECT * FROM team_library_attachments WHERE library_id=$1
      AND reference_id=$2 AND sha256=$3 AND deleted_at IS NULL`, [libraryId, refId, source.sha256])).rows[0];
    if (duplicate) return { status: 200, body: attachment(duplicate) };
    const usage = (await sql.query(`SELECT coalesce(sum(size_bytes),0)::int AS bytes FROM team_library_attachments
      WHERE library_id=$1 AND deleted_at IS NULL`, [libraryId])).rows[0].bytes;
    if (usage + source.size_bytes > maxTeamAttachmentBytes)
      throw validation('This PDF would exceed the team library’s 250 MiB attachment limit.');
    const name = await accountName(scope, libraryId, userId);
    const inserted = (await sql.query(`INSERT INTO team_library_attachments
      (id,library_id,reference_id,file_name,size_bytes,sha256,created_by,created_by_name)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [body.id, libraryId, refId, source.file_name, source.size_bytes, source.sha256, userId, name])).rows[0];
    const { rows } = await sql.query(`WITH copied AS (
      INSERT INTO team_library_attachment_chunks(library_id,attachment_id,byte_offset,data)
      SELECT $1,$2,byte_offset,data FROM research_reference_pdf_chunks WHERE user_id=$3 AND pdf_id=$4 AND data IS NOT NULL
      RETURNING octet_length(data) AS size
    ) SELECT coalesce(sum(size),0)::int AS size FROM copied`, [libraryId, inserted.id, userId, source.id]);
    if (rows[0].size !== source.size_bytes) throw validation('The source PDF is incomplete.');
    await audit(scope, libraryId, 'reference_attachment_created', inserted.id);
    return { status: 201, body: attachment(inserted) };
  }
  if (method !== 'DELETE' || !id) throw notFound();
  const row = await teamAttachmentRow(sql, libraryId, refId, id);
  version(row, scope.expected);
  await clearTeamAttachments(sql, libraryId, refId, id);
  await audit(scope, libraryId, 'reference_attachment_deleted', id);
  return { status: 204, body: null };
}
async function teamNoteRow(sql: Sql, libraryId: string, refId: string, id: string) {
  const row = (await sql.query(`SELECT * FROM team_library_notes
    WHERE library_id=$1 AND reference_id=$2 AND id=$3 AND deleted_at IS NULL`, [libraryId, refId, id])).rows[0];
  if (!row) throw notFound();
  return row;
}
async function clearTeamNotes(scope: Scope, libraryId: string, refId?: string) {
  const { sql, userId } = scope;
  const active = (await sql.query(`SELECT 1 FROM team_library_notes WHERE library_id=$1
    AND ($2::uuid IS NULL OR reference_id=$2) AND deleted_at IS NULL LIMIT 1`, [libraryId, refId ?? null])).rows[0];
  if (!active) return;
  const name = await accountName(scope, libraryId, userId);
  await sql.query(`UPDATE team_library_notes SET deleted_at=now(),updated_at=now(),version=version+1,
    updated_by=$3,updated_by_name=$4 WHERE library_id=$1 AND ($2::uuid IS NULL OR reference_id=$2) AND deleted_at IS NULL`,
    [libraryId, refId ?? null, userId, name]);
}
async function mutateTeamNote(scope: Mutation, library: Row, refId: string, method: string, body: Row, id?: string): Promise<Result> {
  requireTeamNotes(library);
  requireRole(library, 'admin', 'editor');
  const { sql, userId } = scope;
  const libraryId = library.id;
  await referenceRow(scope, libraryId, refId);
  if (method === 'POST' && !id) {
    const { rows } = await sql.query(`SELECT count(*)::int AS count FROM team_library_notes WHERE library_id=$1
      AND reference_id=$2 AND deleted_at IS NULL`, [libraryId, refId]);
    if (rows[0].count >= maxNotesPerReference) throw validation('This reference already has 100 shared notes.');
    const name = await accountName(scope, libraryId, userId);
    const created = (await sql.query(`INSERT INTO team_library_notes(id,library_id,reference_id,title,content,
      created_by,updated_by,created_by_name,updated_by_name) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$7) RETURNING *`,
      [body.id, libraryId, refId, clean(body.title, 'a note title'), body.content ?? '', userId, name])).rows[0];
    await audit(scope, libraryId, 'reference_note_created', created.id);
    return { status: 201, body: note(created) };
  }
  if (!id) throw notFound();
  const old = await teamNoteRow(sql, libraryId, refId, id);
  version(old, scope.expected);
  const name = await accountName(scope, libraryId, userId);
  if (method === 'PATCH') {
    const title = body.title === undefined ? old.title : clean(body.title, 'a note title');
    const content = body.content ?? old.content;
    if (title === old.title && content === old.content) return { status: 200, body: note(old) };
    const updated = (await sql.query(`UPDATE team_library_notes SET title=$4,content=$5,updated_by=$6,
      updated_by_name=$7,updated_at=now(),version=version+1 WHERE library_id=$1 AND reference_id=$2 AND id=$3 RETURNING *`,
      [libraryId, refId, id, title, content, userId, name])).rows[0];
    await audit(scope, libraryId, 'reference_note_updated', id);
    return { status: 200, body: note(updated) };
  }
  if (method !== 'DELETE') throw notFound();
  await sql.query(`UPDATE team_library_notes SET deleted_at=now(),updated_at=now(),version=version+1,
    updated_by=$4,updated_by_name=$5 WHERE library_id=$1 AND reference_id=$2 AND id=$3`, [libraryId, refId, id, userId, name]);
  await audit(scope, libraryId, 'reference_note_deleted', id);
  return { status: 204, body: null };
}
function sharedFields(input: Row) {
  const data = Object.fromEntries(['title', 'authors', 'year', 'doi', 'url', 'publication', 'tags']
    .filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
  if (data.title !== undefined) data.title = clean(data.title, 'a reference title');
  if (data.authors !== undefined) data.authors = data.authors.map((value: string) => value.trim()).filter(Boolean);
  if (data.tags !== undefined) {
    const seen = new Set<string>();
    data.tags = data.tags.map((tag: string) => clean(tag, 'a tag')).filter((tag: string) => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (data.doi) data.doi = data.doi.toLowerCase();
  if (data.url) {
    let url: URL;
    try { url = new URL(data.url); } catch { throw validation('Enter a valid reference URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000)
      throw validation('Use an HTTP or HTTPS reference URL without credentials.');
    data.url = url.href;
  }
  if (data.publication !== undefined) data.publication = Object.fromEntries(sharedPublicationFields.flatMap((field) => {
    const value = data.publication[field];
    return typeof value === 'string' && value.trim() ? [[field, value.trim()]] : [];
  }));
  return data;
}

export async function queryTeamLibraries(scope: Scope, parts: string[], query: Row, cursor: Cursor): Promise<Row> {
  const { sql, userId } = scope;
  const [, libraryId, section, itemId, nested, nestedId, content, contentId] = parts;
  if (!libraryId) {
    const { rows } = await sql.query(`SELECT t.*,prism.team_library_role(t.id) AS role FROM team_libraries t
      WHERE t.deleted_at IS NULL AND prism.team_library_role(t.id) IS NOT NULL ORDER BY lower(t.name),t.id`);
    return { items: rows.map(serializeTeamLibrary) };
  }
  const library = await readTeamLibrary(scope, libraryId);
  if (!section) return serializeTeamLibrary(library);
  if (section === 'members' && !itemId) {
    requireRole(library, 'admin');
    const { rows } = await sql.query(`SELECT * FROM team_library_members WHERE library_id=$1 AND deleted_at IS NULL
      ORDER BY CASE WHEN user_id=$2 THEN 0 ELSE 1 END,lower(display_name),user_id`, [libraryId, userId]);
    return { items: rows.map(member) };
  }
  if (section !== 'references') throw notFound();
  if (itemId && nested === 'attachments') {
    if (nestedId && content === 'annotations') return readTeamAnnotations(scope, library, itemId, nestedId, query, cursor, contentId);
    requireTeamFiles(library);
    await referenceRow(scope, libraryId, itemId);
    const { rows } = await sql.query(`SELECT * FROM team_library_attachments WHERE library_id=$1
      AND reference_id=$2 AND deleted_at IS NULL ORDER BY created_at,id`, [libraryId, itemId]);
    return { items: rows.map(attachment) };
  }
  if (itemId && nested === 'notes') {
    requireTeamNotes(library);
    await referenceRow(scope, libraryId, itemId);
    if (nestedId) return note(await teamNoteRow(sql, libraryId, itemId, nestedId));
    const { rows } = await sql.query(`SELECT * FROM team_library_notes WHERE library_id=$1 AND reference_id=$2
      AND deleted_at IS NULL ORDER BY created_at DESC,id DESC`, [libraryId, itemId]);
    return { items: rows.map(note) };
  }
  if (itemId) return reference(await referenceRow(scope, libraryId, itemId));
  const limit = Math.min(100, Number(query.limit) || 30);
  const decoded = query.cursor ? cursor.decode(query.cursor) : undefined;
  if (decoded && decoded.library !== libraryId) throw validation('Cursor belongs to a different team library.');
  const { rows } = await sql.query(`SELECT *,created_at::text AS cursor_time FROM team_library_references
    WHERE library_id=$1 AND deleted_at IS NULL ${decoded ? 'AND (created_at,id)<($3::timestamptz,$4::uuid)' : ''}
    ORDER BY created_at DESC,id DESC LIMIT $2`, [libraryId, limit + 1, ...(decoded ? [decoded.time, decoded.id] : [])]);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items: items.map(reference), next_cursor: rows.length > limit && last
    ? cursor.encode({ library: libraryId, time: last.cursor_time, id: last.id }) : null };
}

export async function queryPublicTeamLibraries(sql: Sql, parts: string[], query: Row, cursor: Cursor): Promise<Row> {
  const [, libraryId, section] = parts;
  const limit = Math.min(100, Number(query.limit) || 30);
  const decoded = query.cursor ? cursor.decode(query.cursor) : undefined;
  if (decoded && decoded.library !== (libraryId ?? null)) throw validation('Cursor belongs to a different listing.');
  if (!libraryId) {
    const { rows } = await sql.query('SELECT * FROM prism.public_team_libraries(NULL,$1,$2)', [decoded?.id ?? null, limit + 1]);
    const items = rows.slice(0, limit);
    return { items, next_cursor: rows.length > limit ? cursor.encode({ library: null, id: items.at(-1)!.id }) : null };
  }
  const library = (await sql.query('SELECT * FROM prism.public_team_libraries($1,NULL,1)', [libraryId])).rows[0];
  if (!library) throw notFound();
  if (!section) return library;
  const { rows } = await sql.query('SELECT * FROM prism.public_team_library_references($1,$2,$3,$4)',
    [libraryId, decoded?.time ?? null, decoded?.id ?? null, limit + 1]);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(({ cursor_time: _time, ...record }) => record),
    next_cursor: rows.length > limit && last ? cursor.encode({ library: libraryId, time: last.cursor_time, id: last.id }) : null,
  };
}

async function mutateMember(scope: Mutation, library: Row, method: string, body: Row, accounts: HostedAccount[], id?: string): Promise<Result> {
  requireRole(library, 'admin');
  const { sql, userId } = scope;
  const libraryId = library.id;
  const accountId = String(id ?? body.user_id).toLowerCase();
  if (accountId === library.created_by) throw validation('The library creator is a permanent administrator.');
  if (method === 'POST' && !id) {
    if (!accounts.some((account) => account.userId === accountId)) throw notFound();
    const old = await memberRow(scope, libraryId, accountId, true);
    if (old && !old.deleted_at) throw new ApiError(409, 'VALIDATION_ERROR', 'This account is already a member.');
    const { rows } = await sql.query('SELECT count(*)::int AS count FROM team_library_members WHERE library_id=$1 AND deleted_at IS NULL', [libraryId]);
    if (rows[0].count >= maxTeamMembers) throw validation('This library already has 100 members.');
    const name = await accountName(scope, libraryId, accountId);
    const inserted = await sql.query(`INSERT INTO team_library_members(library_id,user_id,display_name,role,added_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(library_id,user_id) DO UPDATE SET
      display_name=EXCLUDED.display_name,role=EXCLUDED.role,updated_by=EXCLUDED.updated_by,deleted_at=NULL,
      updated_at=now(),version=team_library_members.version+1 RETURNING *`, [libraryId, accountId, name, body.role, userId]);
    await audit(scope, libraryId, 'member_added', accountId);
    return { status: 201, body: member(inserted.rows[0]) };
  }
  const old = await memberRow(scope, libraryId, accountId);
  if (!old) throw notFound();
  version(old, scope.expected);
  if (method === 'PATCH') {
    if (old.role === body.role) return { status: 200, body: member(old) };
    const updated = await sql.query(`UPDATE team_library_members SET role=$3,updated_by=$4,updated_at=now(),version=version+1
      WHERE library_id=$1 AND user_id=$2 RETURNING *`, [libraryId, accountId, body.role, userId]);
    await audit(scope, libraryId, 'member_updated', accountId);
    return { status: 200, body: member(updated.rows[0]) };
  }
  if (method !== 'DELETE') throw notFound();
  await sql.query(`UPDATE team_library_members SET deleted_at=now(),updated_by=$3,updated_at=now(),version=version+1
    WHERE library_id=$1 AND user_id=$2`, [libraryId, accountId, userId]);
  await audit(scope, libraryId, 'member_removed', accountId);
  return { status: 204, body: null };
}

async function mutateReference(scope: Mutation, library: Row, method: string, body: Row, id?: string): Promise<Result> {
  requireRole(library, 'admin', 'editor');
  const { sql, userId } = scope;
  const libraryId = library.id;
  if (method === 'POST' && !id) {
    const { rows } = await sql.query('SELECT count(*)::int AS count FROM team_library_references WHERE library_id=$1 AND deleted_at IS NULL', [libraryId]);
    if (rows[0].count >= maxTeamReferences) throw validation('This library already has 5,000 references.');
    let source = body;
    if (body.reference_id) {
      source = (await sql.query(`SELECT title,authors,year,doi,url,publication FROM research_references
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [body.reference_id, userId])).rows[0];
      if (!source) throw notFound();
    }
    const fields = sharedFields(source);
    const name = await accountName(scope, libraryId, userId);
    const inserted = await sql.query(`INSERT INTO team_library_references(id,library_id,title,authors,year,doi,url,publication,tags,
      created_by,updated_by,created_by_name,updated_by_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$10,$11,$11) RETURNING *`,
      [body.id, libraryId, fields.title, fields.authors ?? [], fields.year ?? null, fields.doi ?? null,
        fields.url ?? null, JSON.stringify(fields.publication ?? {}), fields.tags ?? [], userId, name]);
    await audit(scope, libraryId, 'reference_created', inserted.rows[0].id);
    return { status: 201, body: reference(inserted.rows[0]) };
  }
  if (!id) throw notFound();
  const old = await referenceRow(scope, libraryId, id);
  version(old, scope.expected);
  const name = await accountName(scope, libraryId, userId);
  if (method === 'PATCH') {
    const fields = sharedFields(body);
    const values = Object.entries(fields);
    if (!values.length) throw validation('Enter a reference change.');
    const sets = values.map(([field], index) => `${field}=$${index + 5}${field === 'publication' ? '::jsonb' : ''}`);
    const updated = await sql.query(`UPDATE team_library_references SET ${sets.join(',')},updated_by=$3,updated_by_name=$4,
      updated_at=now(),version=version+1 WHERE library_id=$1 AND id=$2 RETURNING *`,
      [libraryId, id, userId, name, ...values.map(([field, value]) => field === 'publication' ? JSON.stringify(value) : value)]);
    await audit(scope, libraryId, 'reference_updated', id);
    return { status: 200, body: reference(updated.rows[0]) };
  }
  if (method !== 'DELETE') throw notFound();
  if (library.visibility !== 'public_open') {
    await clearTeamAttachments(sql, libraryId, id);
    await clearTeamNotes(scope, libraryId, id);
  }
  await sql.query(`UPDATE team_library_references SET deleted_at=now(),updated_by=$3,updated_by_name=$4,updated_at=now(),version=version+1
    WHERE library_id=$1 AND id=$2`, [libraryId, id, userId, name]);
  await audit(scope, libraryId, 'reference_deleted', id);
  return { status: 204, body: null };
}

export async function mutateTeamLibraries(scope: Mutation, parts: string[], method: string, body: Row, accounts: HostedAccount[]): Promise<Result> {
  const { sql, userId } = scope;
  const [, libraryId, section, itemId, nested, nestedId, content, contentId] = parts;
  if (method === 'POST' && !libraryId) {
    const { rows } = await sql.query('SELECT count(*)::int AS count FROM team_libraries WHERE created_by=$1 AND deleted_at IS NULL', [userId]);
    if (rows[0].count >= maxOwnedLibraries) throw validation('You already own 50 team libraries.');
    const created = await sql.query(`INSERT INTO team_libraries(id,name,description,created_by,updated_by)
      VALUES($1,$2,$3,$4,$4) RETURNING *`, [body.id, clean(body.name, 'a library name'), body.description?.trim() ?? '', userId]);
    const id = created.rows[0].id;
    const name = await accountName(scope, id, userId);
    await sql.query(`INSERT INTO team_library_members(library_id,user_id,display_name,role,added_by,updated_by)
      VALUES($1,$2,$3,'admin',$2,$2)`, [id, userId, name]);
    await audit(scope, id, 'library_created', id);
    return { status: 201, body: serializeTeamLibrary({ ...created.rows[0], role: 'admin' }) };
  }
  if (!libraryId) throw notFound();
  if (section === 'join' && method === 'POST') return joinTeamLibrary(scope, libraryId);
  const library = await readTeamLibrary(scope, libraryId);
  if (section === 'references' && itemId && nested === 'attachments') {
    if (nestedId && content === 'annotations') return mutateTeamAnnotation(scope, library, itemId, nestedId, method, body, contentId);
    return mutateTeamAttachment(scope, library, itemId, method, body, nestedId);
  }
  if (section === 'references' && itemId && nested === 'notes')
    return mutateTeamNote(scope, library, itemId, method, body, nestedId);
  if (section === 'members') return mutateMember(scope, library, method, body, accounts, itemId);
  if (section === 'references') return mutateReference(scope, library, method, body, itemId);
  if (section) throw notFound();
  requireRole(library, 'admin');
  version(library, scope.expected);
  if (method === 'PATCH') {
    const name = body.name === undefined ? library.name : clean(body.name, 'a library name');
    const description = body.description === undefined ? library.description : body.description.trim();
    const visibility = body.visibility ?? library.visibility;
    if (name === library.name && description === library.description && visibility === library.visibility)
      return { status: 200, body: serializeTeamLibrary(library) };
    if (visibility === 'public_open' && library.visibility !== 'public_open') {
      const { rows } = await sql.query(`SELECT EXISTS(SELECT 1 FROM team_library_attachments
        WHERE library_id=$1 AND deleted_at IS NULL) AS has_attachments`, [libraryId]);
      if (rows[0].has_attachments)
        throw new ApiError(409, 'VALIDATION_ERROR', 'Remove shared PDFs before making this library public-open.');
      const notes = await sql.query(`SELECT EXISTS(SELECT 1 FROM team_library_notes
        WHERE library_id=$1 AND deleted_at IS NULL) AS has_notes`, [libraryId]);
      if (notes.rows[0].has_notes)
        throw new ApiError(409, 'VALIDATION_ERROR', 'Remove shared notes before making this library public-open.');
    }
    const updated = await sql.query(`UPDATE team_libraries SET name=$2,description=$3,updated_by=$4,visibility=$5,updated_at=now(),version=version+1
      WHERE id=$1 RETURNING *`, [library.id, name, description, userId, visibility]);
    await audit(scope, library.id, 'library_updated', library.id);
    return { status: 200, body: serializeTeamLibrary({ ...updated.rows[0], role: library.role }) };
  }
  if (method !== 'DELETE') throw notFound();
  if (library.visibility !== 'public_open') {
    await clearTeamAttachments(sql, libraryId);
    await clearTeamNotes(scope, libraryId);
  }
  await audit(scope, library.id, 'library_deleted', library.id);
  await sql.query(`UPDATE team_libraries SET deleted_at=now(),updated_by=$2,updated_at=now(),version=version+1 WHERE id=$1`, [library.id, userId]);
  return { status: 204, body: null };
}

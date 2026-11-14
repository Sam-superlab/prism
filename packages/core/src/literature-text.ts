import type { Row, Sql } from '@prism/database';
import { ApiError, notFound, validation } from './errors';
import type { ReferenceAttachmentFormat } from './reference-pdfs';

const indexTable = 'research_pdf_text_indexes';
const textTable = 'research_pdf_page_text';

function displayText(value: string) {
  return value.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeCharacter(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

export function normalizeLiteratureSearch(value: string = '') {
  return displayText(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function snippet(text: string, needle: string) {
  const normalized = normalizeLiteratureSearch(text);
  const matched = normalized.includes(needle)
    ? needle
    : needle.split(' ').find((term) => normalized.includes(term)) ?? '';
  const match = normalized.indexOf(matched);
  if (match < 0 || text.length <= 240) return text.slice(0, 240);
  const wantedStart = Math.max(0, match - 75);
  const wantedEnd = match + matched.length + 125;
  let cursor = 0;
  let position = 0;
  let start = 0;
  let end = text.length;
  for (const character of text) {
    if (cursor <= wantedStart) start = position;
    if (cursor >= wantedEnd) {
      end = position;
      break;
    }
    cursor += normalizeCharacter(character).length;
    position += character.length;
  }
  return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

function status(row?: Row) {
  return row
    ? { index_id: row.id, status: row.status, next_page: row.next_page, page_count: row.page_count, text_mode: row.text_mode }
    : { index_id: null, status: 'missing', next_page: 1, page_count: 0, text_mode: null };
}

function textMode(input: Row) {
  const mode = input.text_mode ?? 'embedded';
  if (mode !== 'embedded' && mode !== 'local-ocr') throw validation('Invalid text indexing mode.');
  return mode;
}

function requireSameTextMode(index: Row, mode: string) {
  if (index.text_mode !== mode) throw new ApiError(409, 'VALIDATION_ERROR',
    index.text_mode === 'local-ocr' ? 'Resume this text index with local OCR on a Mac.' : 'Finish the embedded text index before running local OCR.');
}

export async function pdfTextIndexStatus(sql: Sql, userId: string, pdfId: string) {
  const { rows } = await sql.query(
    `SELECT * FROM ${indexTable} WHERE user_id=$1 AND pdf_id=$2 AND status IN ('indexing','ready')
       ORDER BY (status='indexing') DESC LIMIT 1`,
    [userId, pdfId],
  );
  return status(rows[0]);
}

async function readIndex(sql: Sql, userId: string, pdfId: string, indexId: string) {
  const { rows } = await sql.query(
    `SELECT * FROM ${indexTable} WHERE user_id=$1 AND pdf_id=$2 AND id=$3`,
    [userId, pdfId, indexId],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

async function retireIndex(sql: Sql, userId: string, indexId: string) {
  await sql.query(`UPDATE ${indexTable} SET status='retired',updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, indexId]);
  await sql.query(`UPDATE ${textTable} SET text=NULL,search_text=NULL WHERE user_id=$1 AND index_id=$2`, [userId, indexId]);
}

export async function retirePdfTextIndexes(sql: Sql, userId: string, pdfId: string) {
  const { rows } = await sql.query(
    `SELECT id FROM ${indexTable} WHERE user_id=$1 AND pdf_id=$2 AND status<>'retired'`, [userId, pdfId],
  );
  for (const index of rows) await retireIndex(sql, userId, index.id);
}

export async function beginPdfTextIndex(sql: Sql, userId: string, pdfId: string, input: Row, format: ReferenceAttachmentFormat) {
  const mode = textMode(input);
  if (mode === 'local-ocr' && format !== 'pdf') throw validation('Local OCR is available for PDFs.');
  const { rows } = await sql.query(
    `SELECT * FROM ${indexTable} WHERE user_id=$1 AND id=$2`,
    [userId, input.index_id],
  );
  const previous = rows[0];
  if (previous) {
    if (previous.pdf_id !== pdfId || previous.page_count !== input.page_count || previous.status === 'retired')
      throw new ApiError(409, 'VALIDATION_ERROR', 'Use a new ID to rebuild this PDF index.');
    requireSameTextMode(previous, mode);
    return status(previous);
  }
  const pending = await sql.query(
    `SELECT * FROM ${indexTable} WHERE user_id=$1 AND pdf_id=$2 AND status='indexing'`, [userId, pdfId],
  );
  const priorPending = pending.rows[0];
  if (priorPending) {
    requireSameTextMode(priorPending, mode);
    if (priorPending.page_count === input.page_count) return status(priorPending);
    await retireIndex(sql, userId, priorPending.id);
  }
  const active = await sql.query(
    `SELECT count(*)::int AS count FROM ${indexTable} WHERE user_id=$1 AND status='indexing'`, [userId],
  );
  if (active.rows[0].count >= 8) {
    const abandoned = await sql.query(
      `SELECT id FROM ${indexTable} WHERE user_id=$1 AND status='indexing'
       AND updated_at<now()-interval '24 hours' ORDER BY updated_at,id LIMIT 1`,
      [userId],
    );
    if (!abandoned.rows[0]) throw validation('Finish indexing another attachment first.');
    await retireIndex(sql, userId, abandoned.rows[0].id);
  }
  const created = await sql.query(
    `INSERT INTO ${indexTable}(id,user_id,pdf_id,page_count,text_mode) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [input.index_id, userId, pdfId, input.page_count, mode],
  );
  return status(created.rows[0]);
}

export async function appendPdfTextPages(sql: Sql, userId: string, pdfId: string, input: Row) {
  const index = await readIndex(sql, userId, pdfId, input.index_id);
  requireSameTextMode(index, textMode(input));
  const start = input.start_page as number;
  const pages = (input.pages as string[]).map(displayText);
  const end = start + pages.length;
  if (end > index.page_count + 1) throw validation('These sections exceed the declared index length.');
  if (index.status !== 'retired' && start < index.next_page && end <= index.next_page) {
    const { rows } = await sql.query(
      `SELECT text FROM ${textTable} WHERE user_id=$1 AND index_id=$2 AND page >= $3 AND page < $4 ORDER BY page`,
      [userId, index.id, start, end],
    );
    if (rows.length === pages.length && rows.every((row, i) => row.text === pages[i]))
      return { next_page: index.next_page as number };
  }
  if (index.status !== 'indexing' || start !== index.next_page)
    throw new ApiError(409, 'VALIDATION_ERROR', 'Send text sections in order.', { next_page: index.next_page });
  for (const [i, page] of pages.entries()) {
    await sql.query(
      `INSERT INTO ${textTable}(user_id,index_id,page,text,search_text) VALUES($1,$2,$3,$4,$5)`,
      [userId, index.id, start + i, page, normalizeLiteratureSearch(page).slice(0, 36_000)],
    );
  }
  await sql.query(`UPDATE ${indexTable} SET next_page=$3,updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, index.id, end]);
  return { next_page: end };
}

export async function completePdfTextIndex(sql: Sql, userId: string, pdfId: string, input: Row) {
  const index = await readIndex(sql, userId, pdfId, input.index_id);
  requireSameTextMode(index, textMode(input));
  if (index.status === 'ready') return status(index);
  if (index.status !== 'indexing' || index.next_page !== index.page_count + 1)
    throw new ApiError(409, 'VALIDATION_ERROR', 'Text indexing is incomplete.', { next_page: index.next_page });
  const { rows } = await sql.query(
    `SELECT id FROM ${indexTable} WHERE user_id=$1 AND pdf_id=$2 AND status='ready'`, [userId, pdfId],
  );
  if (rows[0]) await retireIndex(sql, userId, rows[0].id);
  const updated = await sql.query(
    `UPDATE ${indexTable} SET status='ready',updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING *`, [userId, index.id],
  );
  return status(updated.rows[0]);
}

type TextMatch = {
  pdf_id: string;
  reference_id: string;
  file_name: string;
  format: ReferenceAttachmentFormat;
  title: string;
  page: number;
  kind: 'page' | 'annotation';
  annotation_id: string | null;
  item_id: string;
  body: string;
};

export const foldLiteratureSqlText = (expression: string) => `lower(regexp_replace(
  normalize(regexp_replace(${expression},'[[:space:]]+',' ','g'), NFKD),
  '[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]', '', 'g'
))`;

const legacyPdfAnnotationSearch = `coalesce(a.search_text, ${foldLiteratureSqlText("concat_ws(' ',a.text,a.comment)")})`;

export async function listLiteratureAnnotations(
  sql: Sql, userId: string, filters: { q: string; color: string; tag: string }, limit: number,
  after?: { created_at: string; format: string; id: string },
) {
  const terms = [...new Set(filters.q.split(' ').filter(Boolean))];
  const { rows } = await sql.query(
    `WITH annotations AS (
      SELECT a.id,a.pdf_id AS attachment_id,p.reference_id,p.format,a.page,r.title,p.file_name,a.kind,
        a.text AS quote,a.comment,a.color,a.tags,a.created_at,${legacyPdfAnnotationSearch} AS search_text
      FROM research_pdf_annotations a
      JOIN research_reference_pdfs p ON p.id=a.pdf_id AND p.user_id=a.user_id
        AND p.format='pdf' AND p.status='ready' AND p.deleted_at IS NULL
      JOIN research_references r ON r.id=p.reference_id AND r.user_id=p.user_id AND r.deleted_at IS NULL
      WHERE a.user_id=$1 AND a.deleted_at IS NULL
      UNION ALL
      SELECT a.id,a.attachment_id,p.reference_id,p.format,a.section,r.title,p.file_name,'highlight',
        a.anchor->>'quote',a.comment,a.color,a.tags,a.created_at,a.search_text
      FROM research_text_annotations a
      JOIN research_reference_pdfs p ON p.id=a.attachment_id AND p.user_id=a.user_id
        AND p.format=a.format AND p.status='ready' AND p.deleted_at IS NULL
      JOIN research_references r ON r.id=p.reference_id AND r.user_id=p.user_id AND r.deleted_at IS NULL
      WHERE a.user_id=$1 AND a.deleted_at IS NULL
    )
    SELECT id,attachment_id,reference_id,format,page,title,file_name,kind,quote,comment,color,tags,
      created_at::text AS cursor_time FROM annotations
    WHERE ($2='' OR color=$2) AND ($3='' OR EXISTS(SELECT 1 FROM unnest(tags) AS tag WHERE lower(tag)=$3))
      AND NOT EXISTS(SELECT 1 FROM unnest($4::text[]) AS term WHERE strpos(search_text,term)=0)
      ${after ? 'AND (created_at,format,id)<($6::timestamptz,$7::text,$8::uuid)' : ''}
    ORDER BY created_at DESC,format DESC,id DESC LIMIT $5`,
    [userId, filters.color, filters.tag, terms, limit + 1, ...(after ? [after.created_at, after.format, after.id] : [])],
  );
  return rows;
}

export async function searchLiteratureText(
  sql: Sql,
  userId: string,
  raw: string,
  limit: number,
  after?: { pdf: string; page: number; kind: string; item: string },
) {
  const needle = normalizeLiteratureSearch(raw);
  const terms = [...new Set(needle.split(' ').filter(Boolean))];
  if (!terms.length) return [];
  const params: unknown[] = [userId, terms];
  let paging = '';
  if (after) {
    params.push(after.pdf, after.page, after.kind, after.item);
    paging = 'AND (pdf_id,page,kind,item_id)>($3::uuid,$4::int,$5::text,$6::uuid)';
  }
  params.push(limit + 1);
  const { rows } = await sql.query<TextMatch>(
    `WITH attachments AS (
      SELECT p.id,p.reference_id,p.file_name,p.format,r.title
      FROM research_reference_pdfs p JOIN research_references r
        ON r.user_id=p.user_id AND r.id=p.reference_id AND r.deleted_at IS NULL
      WHERE p.user_id=$1 AND p.deleted_at IS NULL AND p.status='ready'
    ), matches AS (
      SELECT p.id AS pdf_id,p.reference_id,p.file_name,p.format,p.title,t.page,
        'page' AS kind,NULL::uuid AS annotation_id,p.id AS item_id,t.text AS body
      FROM attachments p JOIN ${indexTable} i ON i.user_id=$1 AND i.pdf_id=p.id AND i.status='ready'
      JOIN ${textTable} t ON t.user_id=$1 AND t.index_id=i.id
      WHERE t.search_text IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM unnest($2::text[]) AS term WHERE strpos(t.search_text,term)=0
      )
      UNION ALL
      SELECT p.id,p.reference_id,p.file_name,p.format,p.title,a.page,
        'annotation',a.id,a.id,concat_ws(' — ',nullif(a.text,''),nullif(a.comment,''))
      FROM attachments p JOIN research_pdf_annotations a ON a.user_id=$1 AND a.pdf_id=p.id AND a.deleted_at IS NULL
      WHERE p.format='pdf' AND NOT EXISTS(
        SELECT 1 FROM unnest($2::text[]) AS term
        WHERE strpos(${legacyPdfAnnotationSearch},term)=0
      )
      UNION ALL
      SELECT p.id,p.reference_id,p.file_name,p.format,p.title,a.section,
        'annotation',a.id,a.id,concat_ws(' — ',a.anchor->>'quote',nullif(a.comment,''))
      FROM attachments p JOIN research_text_annotations a ON a.user_id=$1 AND a.attachment_id=p.id
        AND a.format=p.format AND a.deleted_at IS NULL
      WHERE NOT EXISTS(SELECT 1 FROM unnest($2::text[]) AS term WHERE strpos(a.search_text,term)=0)
    )
    SELECT * FROM matches WHERE true ${paging} ORDER BY pdf_id,page,kind,item_id LIMIT $${params.length}`,
    params,
  );
  return rows.map(({ body, ...row }) => ({
    ...row,
    snippet: snippet(displayText(body), needle),
  }));
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database, Row, Sql } from '@prism/database';
import { ApiError, notFound, validation } from './errors';

const day = 86_400_000;
const maxActiveTokens = 10;
const prefix = '/developer/literature';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const readPath = new RegExp(`^/api/v1${prefix}/(?:references(?:/${uuid})?|collections|attachments)$`, 'i');
const credentialPattern = new RegExp(`^Bearer prism_lit_(${uuid})\\.([a-zA-Z0-9_-]{43})$`);
const metadata = 'id,name,created_at,expires_at,revoked_at,scope';
const referenceColumns = 'id,title,authors,year,doi,url,arxiv_id,citation_key,tags,publication,updated_at,version::text AS version';
const unauthorized = () => new ApiError(401, 'UNAUTHENTICATED', 'A valid literature access token is required.');

export type LiteratureCredential = { id: string; hash: string; userId: string };
export type LiteratureTokenScope = 'bibliography' | 'attachment_manifest';
export const isDeveloperLiteraturePath = (path: string) => path === prefix || path.startsWith(prefix + '/');
export const isDeveloperLiteratureRead = (path: string) => readPath.test(path);
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');

async function tokenAccount(sql: Sql, id: string, hash: string): Promise<string | null> {
  const { rows } = await sql.query('SELECT prism.developer_literature_token_account($1,$2) AS user_id', [id, hash]);
  return rows[0]?.user_id ?? null;
}
export async function authenticateLiteratureToken(db: Database, authorization?: string): Promise<LiteratureCredential> {
  const match = authorization && credentialPattern.exec(authorization);
  if (!match) throw unauthorized();
  const [, id, secret] = match;
  const hash = digest(secret);
  const userId = await db.transaction(undefined, (sql) => tokenAccount(sql, id, hash));
  if (!userId) throw unauthorized();
  return { id, hash, userId };
}
function tokenMetadata(row: Row) {
  return { id: row.id, name: row.name, created_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(), revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    ...(row.scope === 'attachment_manifest' && { scope: row.scope }) };
}
export async function listLiteratureTokens(db: Database, userId: string) {
  return db.transaction(userId, async (sql) => {
    const { rows } = await sql.query(`SELECT ${metadata} FROM developer_literature_tokens WHERE user_id=$1
      AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC,id`, [userId]);
    return { items: rows.map(tokenMetadata) };
  });
}
export async function issueLiteratureToken(db: Database, userId: string, input: { id: string; name: string; expires_in_days: number; scope?: LiteratureTokenScope }) {
  const name = input.name.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (!name) throw validation('Enter a token name.');
  const id = input.id.toLowerCase();
  const secret = randomBytes(32).toString('base64url');
  return db.transaction(userId, async (sql) => {
    await sql.query('SELECT revision FROM user_sync_state WHERE user_id=$1 FOR UPDATE', [userId]);
    const { rows } = await sql.query(`SELECT count(*)::int AS count FROM developer_literature_tokens
      WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()`, [userId]);
    if (rows[0].count >= maxActiveTokens) throw validation('You already have 10 active literature tokens.');
    const row = (await sql.query(`INSERT INTO developer_literature_tokens(id,user_id,name,secret_hash,expires_at,scope)
      VALUES($1,$2,$3,$4,now()+($5::int*interval '1 day'),$6) ON CONFLICT (id) DO NOTHING RETURNING ${metadata}`,
      [id, userId, name, digest(secret), input.expires_in_days, input.scope ?? 'bibliography'])).rows[0];
    if (!row) throw new ApiError(409, 'VALIDATION_ERROR', 'This token ID is already in use.');
    return { ...tokenMetadata(row), token: `prism_lit_${id}.${secret}` };
  });
}
export async function revokeLiteratureToken(db: Database, userId: string, id: string) {
  return db.transaction(userId, async (sql) => {
    const { rows } = await sql.query(`UPDATE developer_literature_tokens SET revoked_at=coalesce(revoked_at,now())
      WHERE id=$1 AND user_id=$2 RETURNING id`, [id, userId]);
    if (!rows.length) throw notFound();
  });
}
function sign(payload: string, key: string) {
  return createHmac('sha256', key).update('developer-literature-v1\0').update(payload).digest('base64url');
}
function decodeCursor(value: string, key: string, binding: string): string {
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra !== undefined) throw validation('Invalid literature cursor.');
  const expected = sign(payload, key);
  if (!/^[a-zA-Z0-9_-]{43}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
    throw validation('Invalid literature cursor.');
  try {
    const cursor = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (cursor.binding !== binding || typeof cursor.exp !== 'number' || cursor.exp <= Date.now() ||
        typeof cursor.id !== 'string' || !new RegExp(`^${uuid}$`).test(cursor.id)) throw new Error('Invalid cursor');
    return cursor.id;
  } catch {
    throw validation('Invalid literature cursor.');
  }
}
function serializeReference(row: Row) {
  const { publication, ...fields } = row;
  const bibliography = Object.fromEntries(['type', 'journal', 'booktitle', 'publisher', 'volume', 'number', 'pages',
    'edition', 'institution', 'series', 'address', 'isbn', 'issn', 'editor', 'pmid', 'month', 'keywords']
    .filter((field) => typeof publication?.[field] === 'string').map((field) => [field, publication[field]]));
  return { ...fields, publication: bibliography, updated_at: new Date(row.updated_at).toISOString() };
}

function developerPage<T extends { id: string }>(rows: T[], limit: number, key: string, binding: string) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const payload = last && rows.length > limit ? Buffer.from(JSON.stringify({ binding, id: last.id, exp: Date.now() + day })).toString('base64url') : null;
  return { items, next_cursor: payload ? `${payload}.${sign(payload, key)}` : null };
}

async function attachmentManifest(sql: Sql, userId: string, tokenId: string, key: string, query: Row) {
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
  const reference = query.reference_id?.toLowerCase() ?? null;
  const binding = JSON.stringify({ userId, id: tokenId, scope: 'attachment_manifest', reference });
  const after = query.cursor ? decodeCursor(query.cursor, key, binding) : null;
  if (reference && !(await sql.query(`SELECT 1 FROM research_references WHERE user_id=$1 AND id=$2
    AND project_id IS NULL AND deleted_at IS NULL`, [userId, reference])).rows[0]) throw notFound();
  const { rows } = await sql.query<{ id: string; reference_id: string; format: string; file_name: string; size_bytes: number; sha256: string; updated_at: string }>(
    `SELECT a.id,a.reference_id,a.format,a.file_name,a.size_bytes,a.sha256,a.updated_at
     FROM research_reference_pdfs a JOIN research_references r ON (r.user_id,r.id)=(a.user_id,a.reference_id)
     WHERE a.user_id=$1 AND a.status='ready' AND a.deleted_at IS NULL AND r.project_id IS NULL AND r.deleted_at IS NULL
       AND ($2::uuid IS NULL OR a.id>$2) AND ($4::uuid IS NULL OR a.reference_id=$4)
     ORDER BY a.id LIMIT $3`, [userId, after, limit + 1, reference],
  );
  const page = developerPage(rows, limit, key, binding);
  return { ...page, items: page.items.map((item) => ({ ...item, size_bytes: Number(item.size_bytes), updated_at: new Date(item.updated_at).toISOString() })) };
}

export async function readDeveloperLiterature(db: Database, credential: LiteratureCredential, key: string, path: string, query: Row) {
  const { userId, id, hash } = credential;
  return db.transaction(userId, async (sql) => {
    // A concurrent revoke either wins here or waits for the authorized read to complete.
    const { rows: tokens } = await sql.query('SELECT scope FROM developer_literature_tokens WHERE id=$1 AND user_id=$2 FOR SHARE', [id, userId]);
    if (!tokens[0] || await tokenAccount(sql, id, hash) !== userId) throw unauthorized();
    if (path === `${prefix}/attachments`) {
      if (tokens[0].scope !== 'attachment_manifest') throw new ApiError(403, 'FORBIDDEN', 'This token cannot read attachment metadata.');
      return attachmentManifest(sql, userId, id, key, query);
    }
    if (tokens[0].scope !== 'bibliography') throw new ApiError(403, 'FORBIDDEN', 'This token cannot read bibliography metadata.');
    if (path.startsWith(`${prefix}/references/`)) {
      const refId = path.slice(`${prefix}/references/`.length);
      const row = (await sql.query(`SELECT ${referenceColumns} FROM research_references
        WHERE user_id=$1 AND id=$2 AND project_id IS NULL AND deleted_at IS NULL`, [userId, refId])).rows[0];
      if (!row) throw notFound();
      return serializeReference(row);
    }
    const collections = path === `${prefix}/collections`;
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
    const collection = collections ? null : query.collection_id ?? null;
    const tag = collections ? '' : String(query.tag ?? '').trim().toLowerCase();
    const binding = JSON.stringify({ userId, id, collections, collection, tag });
    const after = query.cursor ? decodeCursor(query.cursor, key, binding) : null;
    if (collection && !(await sql.query('SELECT 1 FROM literature_collections WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL', [userId, collection])).rows[0])
      throw notFound();
    const { rows } = collections
      ? await sql.query(`SELECT id,name,parent_id FROM literature_collections WHERE user_id=$1 AND deleted_at IS NULL
          AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`, [userId, after, limit + 1])
      : await sql.query(`SELECT ${referenceColumns} FROM research_references r WHERE user_id=$1 AND project_id IS NULL
          AND deleted_at IS NULL AND ($2::uuid IS NULL OR id>$2)
          AND ($4='' OR EXISTS(SELECT 1 FROM unnest(tags) AS tag WHERE lower(tag)=$4))
          AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM literature_collection_memberships m
            WHERE m.user_id=r.user_id AND m.reference_id=r.id AND m.collection_id=$5 AND m.deleted_at IS NULL))
          ORDER BY id LIMIT $3`, [userId, after, limit + 1, tag, collection]);
    const page = developerPage(rows as (Row & { id: string })[], limit, key, binding);
    return { ...page, items: collections ? page.items : page.items.map(serializeReference) };
  }, 'repeatable read');
}

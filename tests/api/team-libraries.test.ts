import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config';
import { validateApiResponse } from '../../apps/api/src/contract';
import { createOidcFixture, createTestPostgres } from '../../apps/api/src/testing';
import { createDatabase, type Database } from '../../packages/database/src/index';

const teamPath = '/team-libraries';
const owner = { userId: randomUUID(), subject: 'library-owner-fixture', displayName: 'Owner' };
const reader = { userId: randomUUID(), subject: 'library-reader-fixture', displayName: 'Reader' };
const editor = { userId: randomUUID(), subject: 'library-editor-fixture', displayName: 'Editor' };
const outsider = { userId: randomUUID(), subject: 'library-outsider-fixture', displayName: 'Outsider' };
const accounts = [owner, reader, editor, outsider];
const roster = JSON.stringify(accounts.slice(1).map((account) => ({ subject: account.subject, user_id: account.userId })));
let app: Awaited<ReturnType<typeof buildApp>>;
let oidc: Awaited<ReturnType<typeof createOidcFixture>>;
let pg: Awaited<ReturnType<typeof createTestPostgres>> | undefined;
let db: Database;
const tokens = new Map<string, string>();
const primaryConfig = { PRISM_AUTH_MODE: 'oidc', OIDC_AUDIENCE: 'prism-test-api', OIDC_ISSUER: 'https://identity.example.org',
  PRISM_USER_ID: owner.userId, PRISM_ALLOWED_SUBJECT: owner.subject, PRISM_DATA_DIR: tmpdir() };

beforeAll(async () => {
  if (process.env.PRISM_API_TEST_POSTGRES === '1') pg = await createTestPostgres(process.env.PRISM_TEST_POSTGRES_CONFIG);
  db = pg?.db ?? await createDatabase({ memory: true });
  oidc = await createOidcFixture(owner.subject);
  const config = loadConfig({ ...primaryConfig, OIDC_ISSUER: oidc.issuer, DATABASE_URL: pg?.url ?? 'fixture-db', PRISM_HOSTED_ACCOUNTS: roster });
  for (const account of accounts) {
    await db.transaction(account.userId, async (sql) => {
      await sql.query(`INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,$4)`,
        [account.userId, account.subject, `${account.subject}@prism.invalid`, account.displayName]);
      await sql.query('INSERT INTO user_preferences(id,user_id) VALUES($1,$2)', [randomUUID(), account.userId]);
      await sql.query('INSERT INTO user_sync_state(id,user_id) VALUES($1,$2)', [randomUUID(), account.userId]);
    });
    tokens.set(account.subject, await oidc.token({ subject: account.subject }));
  }
  app = await buildApp({ db, config });
});
afterAll(async () => {
  await app?.close();
  await oidc?.close();
  if (pg) await pg.cleanup();
  else await db?.close();
});

async function request(subject: string | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload?: object,
  version?: string, key = randomUUID(), target = app) {
  const response = await target.inject({ method, url: `/api/v1${path}`, payload, headers: {
    ...(subject && { Authorization: `Bearer ${tokens.get(subject) ?? await oidc.token({ subject })}` }),
    'Idempotency-Key': key, ...(version && { 'If-Match': `"${version}"` }),
  } });
  const body = response.statusCode === 204 ? null : response.headers['content-type'] === 'application/pdf' ? response.rawPayload : response.json();
  expect(await validateApiResponse(method, path, response.statusCode, body), response.body).toEqual([]);
  return { status: response.statusCode, body, headers: response.headers };
}

it('requires explicit unique hosted mappings and preserves single-account behavior', async () => {
  for (const invalid of ['', '[]', '{}', JSON.stringify([{ subject: owner.subject, user_id: reader.userId }]),
    JSON.stringify([{ subject: reader.subject, user_id: owner.userId.toUpperCase() }]),
    JSON.stringify([{ subject: reader.subject, user_id: 'not-a-uuid' }])]) {
    expect(() => loadConfig({ ...primaryConfig, DATABASE_URL: 'fixture-db', PRISM_HOSTED_ACCOUNTS: invalid })).toThrow();
  }
  expect(() => loadConfig({ ...primaryConfig, PRISM_HOSTED_ACCOUNTS: roster })).toThrow();
  expect(() => loadConfig({ ...primaryConfig, PRISM_AUTH_MODE: 'development', DATABASE_URL: 'fixture-db', PRISM_HOSTED_ACCOUNTS: roster })).toThrow();
  await expect(buildApp({ db, config: loadConfig({ ...primaryConfig, OIDC_ISSUER: oidc.issuer, DATABASE_URL: 'fixture-db',
    PRISM_HOSTED_ACCOUNTS: JSON.stringify([{ subject: reader.subject, user_id: editor.userId }]),
  }) })).rejects.toThrow('has not been provisioned');
  const single = await buildApp({ db, config: loadConfig({ ...primaryConfig, OIDC_ISSUER: oidc.issuer }) });
  try {
    expect((await request(reader.subject, 'GET', '/me', undefined, undefined, undefined, single)).status).toBe(403);
    expect((await request(owner.subject, 'GET', '/me', undefined, undefined, undefined, single)).body).not.toHaveProperty('team_libraries_enabled');
    expect((await request(owner.subject, 'GET', teamPath, undefined, undefined, undefined, single)).status).toBe(404);
  } finally {
    await single.close();
  }
});

it('isolates private team metadata and personal notes across actual signed subjects', async () => {
  expect((await request(null, 'GET', teamPath)).status).toBe(401);
  expect((await request('unprovisioned', 'GET', teamPath)).status).toBe(403);
  for (const account of accounts)
    expect((await request(account.subject, 'GET', '/me')).body).toMatchObject({ id: account.userId, team_libraries_enabled: true });
  const noteId = randomUUID();
  expect((await request(owner.subject, 'POST', '/knowledge-items', { id: noteId, title: 'Private theorem', type: 'theorem', content: 'Private content' })).status).toBe(201);
  expect((await request(reader.subject, 'GET', `/knowledge-items/${noteId}`)).status).toBe(404);
  const originalId = randomUUID();
  expect((await request(owner.subject, 'POST', '/research/references', {
    id: originalId, title: 'Shared title', authors: ['Fixture author'], year: 2026,
    citation_key: 'private-citation', tags: ['private tag'], publication: { journal: 'Journal', note: 'Private note', abstract: 'Private abstract', keywords: 'Private keywords' },
  })).status).toBe(201);
  const sourceLookup = `/research/references/${originalId}/open-access`;
  expect((await request(null, 'GET', sourceLookup)).status).toBe(401);
  expect((await request(reader.subject, 'GET', sourceLookup)).status).toBe(404);
  expect((await request(reader.subject, 'POST', `${sourceLookup}/pdf`, { provider: 'arxiv', identifier: '2601.12345' })).status).toBe(404);
  expect((await request(owner.subject, 'GET', sourceLookup)).body).toEqual({ items: [] });
  const libraryId = randomUUID();
  const library = `${teamPath}/${libraryId}`;
  const members = `${library}/members`;
  const refs = `${library}/references`;
  const created = await request(owner.subject, 'POST', teamPath, { id: libraryId, name: 'Private mathematics', description: 'Team bibliography' });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ id: libraryId, role: 'admin', created_by: owner.userId, version: '1' });
  expect(created.headers['cache-control']).toBe('private, no-store');
  expect((await request(outsider.subject, 'GET', teamPath)).body).toEqual({ items: [] });
  expect((await request(outsider.subject, 'GET', library)).status).toBe(404);
  expect((await request(owner.subject, 'POST', members, { user_id: randomUUID(), role: 'reader' })).status).toBe(404);
  expect((await request(owner.subject, 'DELETE', `${members}/${owner.userId}`, undefined, '1')).status).toBe(422);
  const added = await request(owner.subject, 'POST', members, { user_id: reader.userId, role: 'reader' });
  expect(added.status).toBe(201);
  expect(added.body).toEqual({ user_id: reader.userId, display_name: 'Reader', role: 'reader', version: '1' });
  expect((await request(owner.subject, 'POST', members, { user_id: editor.userId, role: 'editor' })).status).toBe(201);
  expect((await request(owner.subject, 'GET', members)).body.items).toHaveLength(3);
  expect((await request(reader.subject, 'GET', members)).status).toBe(403);
  expect((await request(reader.subject, 'GET', teamPath)).body.items[0]).toMatchObject({ id: libraryId, role: 'reader' });
  expect((await request(reader.subject, 'POST', refs, { id: randomUUID(), title: 'Reader cannot add' })).status).toBe(403);
  expect((await request(editor.subject, 'POST', members, { user_id: outsider.userId, role: 'reader' })).status).toBe(403);
  expect((await request(editor.subject, 'PATCH', library, { name: 'Editor cannot rename' }, '1')).status).toBe(403);
  expect((await request(editor.subject, 'POST', refs, { id: randomUUID(), reference_id: originalId })).status).toBe(404);

  const copiedId = randomUUID();
  const copied = await request(owner.subject, 'POST', refs, { id: copiedId, reference_id: originalId });
  expect(copied.status).toBe(201);
  expect(copied.body).toMatchObject({ id: copiedId, library_id: libraryId, title: 'Shared title', publication: { journal: 'Journal' },
    created_by: owner.userId, updated_by: owner.userId, created_by_name: 'Owner', updated_by_name: 'Owner' });
  expect(copied.body.publication).toEqual({ journal: 'Journal' });
  expect(JSON.stringify(copied.body)).not.toContain(originalId);
  expect(JSON.stringify(copied.body)).not.toContain('private');
  expect((await request(reader.subject, 'GET', `${refs}/${copiedId}`)).body).toEqual(copied.body);
  expect((await request(outsider.subject, 'GET', `${refs}/${copiedId}`)).status).toBe(404);
  const updatedId = randomUUID();
  const editorKey = randomUUID();
  const editorMutation = { id: updatedId, title: 'Editor reference' };
  expect((await request(editor.subject, 'POST', refs, editorMutation, undefined, editorKey)).status).toBe(201);
  const page = await request(reader.subject, 'GET', `${refs}?limit=1`);
  expect(page.body.items).toHaveLength(1);
  expect((await request(reader.subject, 'GET', `${refs}?cursor=${encodeURIComponent(page.body.next_cursor)}`)).body.items).toHaveLength(1);
  expect((await request(reader.subject, 'PATCH', `${refs}/${copiedId}`, { title: 'Reader cannot edit' }, '1')).status).toBe(403);
  const edited = await request(editor.subject, 'PATCH', `${refs}/${copiedId}`, { title: 'Edited by editor' }, '1');
  expect(edited.body).toMatchObject({ created_by: owner.userId, updated_by: editor.userId, updated_by_name: 'Editor', version: '2' });
  expect((await request(editor.subject, 'PATCH', `${refs}/${copiedId}`, { title: 'Stale edit' }, '1')).status).toBe(412);
  expect((await request(owner.subject, 'GET', `/research/references/${originalId}`)).body.title).toBe('Shared title');
  expect((await request(owner.subject, 'PATCH', `${members}/${editor.userId}`, { role: 'reader' }, '1')).body.version).toBe('2');
  expect((await request(editor.subject, 'POST', refs, editorMutation, undefined, editorKey)).status).toBe(403);
  expect((await request(owner.subject, 'DELETE', `${members}/${editor.userId}`, undefined, '2')).status).toBe(204);
  expect((await request(editor.subject, 'GET', refs)).status).toBe(404);
  expect((await request(editor.subject, 'POST', refs, editorMutation, undefined, editorKey)).status).toBe(404);
  const deletedKey = randomUUID();
  expect((await request(owner.subject, 'DELETE', library, undefined, '1', deletedKey)).status).toBe(204);
  expect((await request(owner.subject, 'DELETE', library, undefined, '1', deletedKey)).status).toBe(204);
  expect((await request(reader.subject, 'GET', refs)).status).toBe(404);
  expect((await request(owner.subject, 'GET', `/research/references/${originalId}`)).status).toBe(200);
});

it('publishes only explicit metadata and controls open and closed joining', async () => {
  const discovery = '/team-library-discovery';
  const libraryId = randomUUID();
  const library = `${teamPath}/${libraryId}`;
  const publicLibrary = `${discovery}/${libraryId}`;
  const join = `${library}/join`;
  const members = `${library}/members`;
  const refs = `${library}/references`;
  const privateLibrary = await request(owner.subject, 'POST', teamPath, { id: libraryId, name: 'Published mathematics', description: 'Public bibliography' });
  expect(privateLibrary.body.visibility).toBe('private');
  expect((await request(null, 'GET', publicLibrary)).status).toBe(404);
  expect((await request(outsider.subject, 'POST', join)).status).toBe(404);
  expect((await request(null, 'POST', join)).status).toBe(401);
  expect((await request(null, 'GET', discovery)).body).toEqual({ items: [], next_cursor: null });
  const referenceId = randomUUID();
  expect((await request(owner.subject, 'POST', refs, { id: referenceId, title: 'Public algebra', authors: ['Author'], year: 2026,
    publication: { journal: 'Public Journal' } })).status).toBe(201);
  expect((await request(owner.subject, 'POST', refs, { id: randomUUID(), title: 'Another public paper' })).status).toBe(201);
  expect((await request(owner.subject, 'PATCH', library, { visibility: 'public_closed' }, '1')).body.visibility).toBe('public_closed');
  const published = await request(null, 'GET', publicLibrary);
  expect(published.headers['cache-control']).toBe('no-store');
  expect(published.body).toEqual({ id: libraryId, name: 'Published mathematics', description: 'Public bibliography', visibility: 'public_closed' });
  expect((await request(outsider.subject, 'POST', join)).status).toBe(403);
  expect((await request(null, 'GET', members)).status).toBe(401);
  expect((await request(outsider.subject, 'GET', members)).status).toBe(404);
  const page = (await request(null, 'GET', `${publicLibrary}/references?limit=1`)).body;
  const next = (await request(null, 'GET', `${publicLibrary}/references?cursor=${encodeURIComponent(page.next_cursor)}`)).body;
  const visible = [...page.items, ...next.items].find((record) => record.id === referenceId);
  expect(visible).toEqual({ id: referenceId, title: 'Public algebra', authors: ['Author'], year: 2026, doi: null, url: null,
    publication: { journal: 'Public Journal' } });
  expect(JSON.stringify([page, next])).not.toContain(owner.userId);
  expect((await request(null, 'GET', discovery)).body.items).toContainEqual(published.body);
  expect((await request(owner.subject, 'PATCH', library, { visibility: 'public_open' }, '2')).body.visibility).toBe('public_open');
  const joinKey = randomUUID();
  expect((await request(outsider.subject, 'POST', join, undefined, undefined, joinKey)).body).toMatchObject({ role: 'reader', visibility: 'public_open' });
  expect((await request(outsider.subject, 'GET', refs)).status).toBe(200);
  expect((await request(outsider.subject, 'PATCH', library, { visibility: 'private' }, '3')).status).toBe(403);
  expect((await request(owner.subject, 'PATCH', `${members}/${outsider.userId}`, { role: 'editor' }, '1')).status).toBe(200);
  expect((await request(outsider.subject, 'POST', join, undefined, undefined, joinKey)).body.role).toBe('editor');
  expect((await request(owner.subject, 'DELETE', `${members}/${outsider.userId}`, undefined, '2')).status).toBe(204);
  expect((await request(outsider.subject, 'POST', join, undefined, undefined, joinKey)).status).toBe(403);
  expect((await request(outsider.subject, 'POST', join)).status).toBe(403);
  expect((await request(outsider.subject, 'GET', refs)).status).toBe(404);
  expect((await request(owner.subject, 'POST', members, { user_id: outsider.userId, role: 'reader' })).status).toBe(201);
  expect((await request(owner.subject, 'PATCH', library, { visibility: 'private' }, '3')).status).toBe(200);
  expect((await request(null, 'GET', discovery)).body.items).toEqual([]);
  const withdrawn = await request(null, 'GET', `${publicLibrary}/references`);
  expect(withdrawn.status).toBe(404);
  expect(withdrawn.headers['cache-control']).toBe('no-store');
  expect((await request(outsider.subject, 'GET', refs)).status).toBe(200);
});

it('copies a personal PDF independently and authorizes every team download', async () => {
  const ownerReference = randomUUID();
  const originalId = randomUUID();
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(524288), Buffer.from('\n%%EOF\n')]);
  const sha256 = createHash('sha256').update(pdf).digest('hex');
  expect((await request(owner.subject, 'POST', '/research/references', { id: ownerReference, title: 'Personal PDF reference' })).status).toBe(201);
  const original = `/research/reference-pdfs/${originalId}`;
  const begin = await request(owner.subject, 'POST', `/research/references/${ownerReference}/pdf`, {
    id: originalId, file_name: 'Épreuve.pdf', size_bytes: pdf.length, sha256,
  });
  expect(begin.status).toBe(200);
  expect((await request(owner.subject, 'PUT', `${original}/chunk`, { offset: 0, data: pdf.subarray(0, 524288).toString('base64') })).status).toBe(200);
  expect((await request(owner.subject, 'PUT', `${original}/chunk`, { offset: 524288, data: pdf.subarray(524288).toString('base64') })).status).toBe(200);
  expect((await request(owner.subject, 'POST', `${original}/complete`, {})).status).toBe(200);

  const id = randomUUID();
  const library = `${teamPath}/${id}`;
  const ref = `${library}/references/${randomUUID()}`;
  const list = `${ref}/attachments`;
  const fileId = randomUUID();
  const file = `${list}/${fileId}`;
  const download = `${file}/download`;
  expect((await request(owner.subject, 'POST', teamPath, { id, name: 'Attachments' })).status).toBe(201);
  expect((await request(owner.subject, 'POST', `${library}/references`, { id: ref.split('/').at(-1), title: 'Team PDF reference' })).status).toBe(201);
  expect((await request(owner.subject, 'POST', `${library}/members`, { user_id: editor.userId, role: 'editor' })).status).toBe(201);
  expect((await request(owner.subject, 'POST', `${library}/members`, { user_id: reader.userId, role: 'reader' })).status).toBe(201);
  const copy = { id: fileId, attachment_id: originalId };
  expect((await request(reader.subject, 'POST', list, copy)).status).toBe(403);
  expect((await request(editor.subject, 'POST', list, copy)).status).toBe(404);
  const receipt = randomUUID();
  const copied = await request(owner.subject, 'POST', list, copy, undefined, receipt);
  expect(copied.status, JSON.stringify(copied.body)).toBe(201);
  expect(copied.body).toMatchObject({ id: fileId, library_id: id, reference_id: ref.split('/').at(-1),
    file_name: 'Épreuve.pdf', size_bytes: pdf.length, sha256, created_by: owner.userId, created_by_name: 'Owner', version: '1' });
  expect(JSON.stringify(copied.body)).not.toContain(originalId);
  expect((await request(owner.subject, 'POST', list, copy, undefined, receipt)).body).toEqual(copied.body);
  expect((await request(owner.subject, 'POST', list, { ...copy, id: randomUUID() })).status).toBe(200);
  expect((await request(reader.subject, 'GET', list)).body.items).toEqual([copied.body]);
  expect((await request(outsider.subject, 'GET', download)).status).toBe(404);
  expect((await request(null, 'GET', download)).status).toBe(401);
  expect((await request(reader.subject, 'GET', `${original}/download`)).status).toBe(404);
  const shared = await request(reader.subject, 'GET', download);
  expect(shared.status).toBe(200);
  expect(shared.body.equals(pdf)).toBe(true);
  expect(shared.headers['content-disposition']).toContain("filename*=UTF-8''%C3%89preuve.pdf");
  expect(shared.headers['content-security-policy']).toBe('sandbox');
  expect(shared.headers['cache-control']).toBe('private, no-store');
  expect(shared.headers['x-content-type-options']).toBe('nosniff');
  expect((await request(owner.subject, 'DELETE', original, undefined, '2')).status).toBe(204);
  expect((await request(reader.subject, 'GET', download)).body.equals(pdf)).toBe(true);
  expect((await request(owner.subject, 'PATCH', library, { visibility: 'public_open' }, '1')).status).toBe(409);
  expect((await request(owner.subject, 'PATCH', library, { visibility: 'public_closed' }, '1')).status).toBe(200);
  expect((await request(reader.subject, 'GET', download)).status).toBe(200);
  const published = await request(null, 'GET', `/team-library-discovery/${id}/references`);
  expect(JSON.stringify(published.body)).not.toContain(fileId);
  expect((await request(owner.subject, 'DELETE', `${library}/members/${reader.userId}`, undefined, '1')).status).toBe(204);
  expect((await request(reader.subject, 'GET', download)).status).toBe(404);
  expect((await request(editor.subject, 'DELETE', file, undefined, '2')).status).toBe(412);
  expect((await request(editor.subject, 'DELETE', file, undefined, '1')).status).toBe(204);
  expect((await request(editor.subject, 'GET', download)).status).toBe(404);
  expect((await request(owner.subject, 'PATCH', library, { visibility: 'public_open' }, '2')).status).toBe(200);
  expect((await request(owner.subject, 'GET', list)).status).toBe(409);
  expect((await request(owner.subject, 'POST', list, copy, undefined, receipt)).status).toBe(409);
});

it('keeps team PDF annotations independent and enforces author, role and parent lifecycle', async () => {
  const personalRef = randomUUID();
  const personalPdf = randomUUID();
  const bytes = Buffer.from('%PDF-1.7\n%%EOF\n');
  const original = `/research/reference-pdfs/${personalPdf}`;
  expect((await request(owner.subject, 'POST', '/research/references', { id: personalRef, title: 'Annotation source' })).status).toBe(201);
  expect((await request(owner.subject, 'POST', `/research/references/${personalRef}/pdf`, {
    id: personalPdf, file_name: 'Fixture.pdf', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  })).status).toBe(200);
  expect((await request(owner.subject, 'PUT', `${original}/chunk`, { offset: 0, data: bytes.toString('base64') })).status).toBe(200);
  expect((await request(owner.subject, 'POST', `${original}/complete`, {})).status).toBe(200);
  const rects = [{ x: 0.1, y: 0.2, width: 0.15, height: 0.15 }];
  expect((await request(owner.subject, 'POST', `${original}/annotations`, { id: randomUUID(), page: 1, kind: 'note', comment: 'Personal-only annotation', rects })).status).toBe(201);

  const id = randomUUID();
  const library = `${teamPath}/${id}`;
  const members = `${library}/members`;
  const referenceId = randomUUID();
  const attachmentId = randomUUID();
  const files = `${library}/references/${referenceId}/attachments`;
  const attachment = `${files}/${attachmentId}`;
  const annotations = `${attachment}/annotations`;
  expect((await request(owner.subject, 'POST', teamPath, { id, name: 'Shared annotations' })).status).toBe(201);
  expect((await request(owner.subject, 'POST', `${library}/references`, { id: referenceId, title: 'Shared PDF' })).status).toBe(201);
  expect((await request(owner.subject, 'POST', files, { id: attachmentId, attachment_id: personalPdf })).status).toBe(201);
  for (const account of [editor, outsider]) expect((await request(owner.subject, 'POST', members, { user_id: account.userId, role: 'editor' })).status).toBe(201);
  expect((await request(owner.subject, 'POST', members, { user_id: reader.userId, role: 'reader' })).status).toBe(201);
  expect((await request(reader.subject, 'GET', annotations)).body.items).toEqual([]);
  const annotationId = randomUUID();
  const item = `${annotations}/${annotationId}`;
  const create = { id: annotationId, page: 1, kind: 'ink', color: 'blue', rects, tags: ['Proof', 'proof'],
    ink_path: [{ x: 0.11, y: 0.21 }, { x: 0.15, y: 0.25 }] };
  expect((await request(reader.subject, 'POST', annotations, create)).status).toBe(403);
  expect((await request(editor.subject, 'POST', annotations, { ...create, ink_path: [{ x: 0, y: 0 }, { x: 0.15, y: 0.25 }] })).status).toBe(422);
  const key = randomUUID();
  const shared = await request(editor.subject, 'POST', annotations, create, undefined, key);
  expect(shared.status, JSON.stringify(shared.body)).toBe(201);
  expect(shared.body).toMatchObject({ ...create, tags: ['Proof'], created_by_name: 'Editor', updated_by_name: 'Editor',
    attachment_id: attachmentId, reference_id: referenceId, library_id: id, version: '1' });
  expect((await request(reader.subject, 'GET', item)).body).toEqual(shared.body);
  expect((await request(editor.subject, 'GET', `${original}/annotations`)).status).toBe(404);
  expect((await request(null, 'GET', annotations)).status).toBe(401);
  expect((await request(editor.subject, 'GET', annotations.replace(attachmentId, personalPdf))).status).toBe(404);
  expect((await request(outsider.subject, 'PATCH', item, { comment: 'Other editor' }, '1')).status).toBe(403);
  const second = await request(owner.subject, 'POST', annotations, { id: randomUUID(), page: 2, kind: 'note', comment: 'Team note', rects });
  expect(second.status).toBe(201);
  const firstPage = (await request(reader.subject, 'GET', `${annotations}?limit=1`)).body;
  expect(firstPage.items).toHaveLength(1);
  expect((await request(reader.subject, 'GET', `${annotations}?cursor=${encodeURIComponent(firstPage.next_cursor)}`)).body.items).toHaveLength(1);
  expect((await request(reader.subject, 'GET', `${annotations}?page=2`)).body.items).toEqual([second.body]);
  expect((await request(owner.subject, 'PATCH', item, { comment: 'Admin edit' }, '1')).body).toMatchObject({
    created_by_name: 'Editor', updated_by_name: 'Owner', version: '2', comment: 'Admin edit',
  });
  expect((await request(editor.subject, 'PATCH', item, { comment: 'Stale edit' }, '1')).status).toBe(412);
  expect((await request(editor.subject, 'PATCH', item, { kind: 'area', comment: 'Author edit' }, '2')).body).toMatchObject({
    version: '3', ink_path: null, kind: 'area', updated_by_name: 'Editor',
  });
  expect((await request(owner.subject, 'PATCH', library, { visibility: 'public_closed' }, '1')).status).toBe(200);
  const projection = (await request(null, 'GET', `/team-library-discovery/${id}/references`)).body;
  expect(JSON.stringify(projection)).not.toContain(annotationId);
  expect((await request(owner.subject, 'PATCH', `${members}/${editor.userId}`, { role: 'reader' }, '1')).status).toBe(200);
  expect((await request(editor.subject, 'PATCH', item, { comment: 'Downgraded' }, '3')).status).toBe(403);
  expect((await request(owner.subject, 'DELETE', `${members}/${editor.userId}`, undefined, '2')).status).toBe(204);
  expect((await request(editor.subject, 'GET', item)).status).toBe(404);
  expect((await request(editor.subject, 'POST', annotations, create, undefined, key)).status).toBe(404);
  expect((await request(outsider.subject, 'DELETE', attachment, undefined, '1')).status).toBe(204);
  expect((await request(reader.subject, 'GET', item)).status).toBe(404);
  const archived = await db.transaction(owner.userId, (sql) => sql.query(`SELECT deleted_at,updated_by FROM team_pdf_annotations
    WHERE library_id=$1 AND attachment_id=$2`, [id, attachmentId]));
  expect(archived.rows).toHaveLength(2);
  expect(archived.rows.every((row) => row.deleted_at && row.updated_by === outsider.userId)).toBe(true);
  expect((await request(owner.subject, 'GET', `${original}/annotations`)).body.items).toHaveLength(1);
});

it('isolates attributed shared notes and tags from public listings and revoked members', async () => {
  const id = randomUUID();
  const library = `${teamPath}/${id}`;
  const refs = `${library}/references`;
  const refId = randomUUID();
  const ref = `${refs}/${refId}`;
  const notes = `${ref}/notes`;
  const noteId = randomUUID();
  const note = `${notes}/${noteId}`;
  const members = `${library}/members`;
  const publicRefs = `/team-library-discovery/${id}/references`;
  expect((await request(owner.subject, 'POST', teamPath, { id, name: 'Notes and tags' })).status).toBe(201);
  const created = await request(owner.subject, 'POST', refs, { id: refId, title: 'Team reference', tags: ['  Algebra  ', 'ALGEBRA', 'Singularities'] });
  expect(created.status).toBe(201);
  expect(created.body.tags).toEqual(['Algebra', 'Singularities']);
  const copySource = randomUUID();
  await request(owner.subject, 'POST', '/research/references', { id: copySource, title: 'Personal source', tags: ['personal tag'] });
  const otherRefId = randomUUID();
  const copied = await request(owner.subject, 'POST', refs, { id: otherRefId, reference_id: copySource });
  expect(copied.status).toBe(201);
  expect(copied.body.tags).toEqual([]);
  expect((await request(owner.subject, 'POST', members, { user_id: editor.userId, role: 'editor' })).status).toBe(201);
  expect((await request(owner.subject, 'POST', members, { user_id: reader.userId, role: 'reader' })).status).toBe(201);
  expect((await request(reader.subject, 'GET', ref)).body.tags).toEqual(['Algebra', 'Singularities']);
  expect((await request(reader.subject, 'PATCH', ref, { tags: ['Reader tag'] }, '1')).status).toBe(403);
  expect((await request(editor.subject, 'PATCH', ref, { tags: ['Geometry', 'GEOMETRY'] }, '1')).body.tags).toEqual(['Geometry']);
  expect((await request(reader.subject, 'POST', notes, { id: noteId, title: 'Reader cannot create' })).status).toBe(403);
  expect((await request(editor.subject, 'POST', notes, { id: noteId, title: '   ' })).status).toBe(422);
  const noteKey = randomUUID();
  const payload = { id: noteId, title: 'Shared discussion', content: 'A group-only observation.\n\n$X^2$.' };
  const added = await request(editor.subject, 'POST', notes, payload, undefined, noteKey);
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  expect(added.body).toMatchObject({ ...payload, library_id: id, reference_id: refId, created_by: editor.userId, updated_by: editor.userId,
    created_by_name: 'Editor', updated_by_name: 'Editor', version: '1' });
  expect((await request(reader.subject, 'GET', note)).body).toEqual(added.body);
  expect((await request(reader.subject, 'GET', notes)).body.items).toEqual([added.body]);
  expect((await request(reader.subject, 'GET', `${refs}/${otherRefId}/notes/${noteId}`)).status).toBe(404);
  expect((await request(outsider.subject, 'GET', notes)).status).toBe(404);
  expect((await request(null, 'GET', notes)).status).toBe(401);
  expect((await request(reader.subject, 'PATCH', note, { content: 'Reader cannot edit' }, '1')).status).toBe(403);
  const edited = await request(owner.subject, 'PATCH', note, { content: 'Revised by admin' }, '1');
  expect(edited.body).toMatchObject({ content: 'Revised by admin', created_by_name: 'Editor', updated_by_name: 'Owner', version: '2' });
  expect((await request(editor.subject, 'PATCH', note, { content: 'Stale' }, '1')).status).toBe(412);
  expect((await request(owner.subject, 'PATCH', library, { visibility: 'public_closed' }, '1')).status).toBe(200);
  const published = await request(null, 'GET', publicRefs);
  expect(published.status).toBe(200);
  expect(published.body.items.find((row: { id: string }) => row.id === refId)).not.toHaveProperty('tags');
  expect(JSON.stringify(published.body)).not.toContain(noteId);
  expect(JSON.stringify(published.body)).not.toContain('Revised by admin');
  expect((await request(owner.subject, 'PATCH', library, { visibility: 'public_open' }, '2')).status).toBe(409);
  expect((await request(owner.subject, 'DELETE', `${members}/${editor.userId}`, undefined, '1')).status).toBe(204);
  expect((await request(editor.subject, 'GET', note)).status).toBe(404);
  expect((await request(editor.subject, 'POST', notes, payload, undefined, noteKey)).status).toBe(404);
  expect((await request(owner.subject, 'DELETE', note, undefined, '2')).status).toBe(204);
  expect((await request(reader.subject, 'GET', notes)).body.items).toEqual([]);
  const cascaded = await request(owner.subject, 'POST', notes, { id: randomUUID(), title: 'Archive with parent' });
  expect(cascaded.status).toBe(201);
  expect((await request(owner.subject, 'DELETE', ref, undefined, '2')).status).toBe(204);
  expect((await request(owner.subject, 'GET', `${notes}/${cascaded.body.id}`)).status).toBe(404);
  expect((await request(owner.subject, 'PATCH', library, { visibility: 'public_open' }, '2')).status).toBe(200);
  const openNotes = `${refs}/${otherRefId}/notes`;
  expect((await request(reader.subject, 'GET', openNotes)).status).toBe(409);
  expect((await request(owner.subject, 'POST', openNotes, { id: randomUUID(), title: 'Cannot share open note' })).status).toBe(409);
});

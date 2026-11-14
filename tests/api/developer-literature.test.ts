import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config';
import { validateApiResponse } from '../../apps/api/src/contract';
import { createOidcFixture, createTestPostgres } from '../../apps/api/src/testing';
import { createDatabase, type Database } from '../../packages/database/src/index';

const root = '/developer/literature';
const owner = { id: randomUUID(), subject: 'developer-owner-fixture' };
const outsider = { id: randomUUID(), subject: 'developer-other-fixture' };
let app: Awaited<ReturnType<typeof buildApp>>;
let oidc: Awaited<ReturnType<typeof createOidcFixture>>;
let pg: Awaited<ReturnType<typeof createTestPostgres>> | undefined;
let db: Database;
let ownerToken: string;
let outsiderToken: string;
const configEnv = { PRISM_AUTH_MODE: 'oidc', OIDC_AUDIENCE: 'prism-test-api', PRISM_USER_ID: owner.id,
  PRISM_ALLOWED_SUBJECT: owner.subject, PRISM_DATA_DIR: tmpdir(), DATABASE_URL: 'fixture-db',
  PRISM_HOSTED_ACCOUNTS: JSON.stringify([{ subject: outsider.subject, user_id: outsider.id }]) };

beforeAll(async () => {
  if (process.env.PRISM_API_TEST_POSTGRES === '1') pg = await createTestPostgres(process.env.PRISM_TEST_POSTGRES_CONFIG);
  db = pg?.db ?? await createDatabase({ memory: true });
  oidc = await createOidcFixture(owner.subject);
  ownerToken = await oidc.token({ subject: owner.subject });
  outsiderToken = await oidc.token({ subject: outsider.subject });
  for (const account of [owner, outsider]) await db.transaction(account.id, async (sql) => {
    await sql.query('INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,$2)',
      [account.id, account.subject, `${account.subject}@prism.invalid`]);
    await sql.query('INSERT INTO user_preferences(id,user_id) VALUES($1,$2)', [randomUUID(), account.id]);
    await sql.query('INSERT INTO user_sync_state(id,user_id) VALUES($1,$2)', [randomUUID(), account.id]);
  });
  app = await buildApp({ db, config: loadConfig({ ...configEnv, OIDC_ISSUER: oidc.issuer,
    DATABASE_URL: pg?.url ?? 'fixture-db', PRISM_DEVELOPER_LITERATURE_API: 'true' }) });
});
afterAll(async () => {
  await app?.close();
  await oidc?.close();
  if (pg) await pg.cleanup();
  else await db?.close();
});

async function request(method: 'GET' | 'POST' | 'DELETE', path: string, token?: string, payload?: object, target = app, check = true) {
  const response = await target.inject({ method, url: `/api/v1${path}`, payload, headers: {
    ...(token && { Authorization: `Bearer ${token}` }), 'Idempotency-Key': randomUUID(),
  } });
  const body = response.statusCode === 204 ? null : response.json();
  if (check) expect(await validateApiResponse(method, path, response.statusCode, body), response.body).toEqual([]);
  return { status: response.statusCode, body, headers: response.headers };
}

it('defaults off and refuses desktop or development configuration', async () => {
  expect(() => loadConfig({ PRISM_AUTH_MODE: 'development', PRISM_DEVELOPER_LITERATURE_API: 'true' })).toThrow();
  const disabled = await buildApp({ db, config: loadConfig({ ...configEnv, OIDC_ISSUER: oidc.issuer }) });
  try {
    expect((await request('GET', `${root}/tokens`, ownerToken, undefined, disabled)).status).toBe(404);
    expect((await request('GET', `${root}/references`, undefined, undefined, disabled)).status).toBe(404);
  } finally {
    await disabled.close();
  }
});

it('issues once and confines the bearer to owned standalone library metadata', async () => {
  const id = randomUUID();
  const payload = { id, name: ' Synthetic key ', expires_in_days: 30 };
  expect((await request('POST', `${root}/tokens`, undefined, payload)).status).toBe(401);
  expect((await request('POST', `${root}/tokens`, ownerToken, { ...payload, expires_in_days: 91 })).status).toBe(422);
  const issued = await request('POST', `${root}/tokens`, ownerToken, payload);
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  expect(issued.headers['cache-control']).toBe('private, no-store');
  expect(issued.body).toMatchObject({ id, name: 'Synthetic key', token: expect.stringMatching(/^prism_lit_/) });
  const key = issued.body.token;
  expect((await request('POST', `${root}/tokens`, ownerToken, payload)).status).toBe(409);
  expect((await request('GET', `${root}/tokens`, outsiderToken)).body.items).toEqual([]);
  const listed = (await request('GET', `${root}/tokens`, ownerToken)).body.items;
  expect(listed).toEqual([{ id, name: 'Synthetic key', created_at: issued.body.created_at, expires_at: issued.body.expires_at, revoked_at: null }]);
  const receipt = await db.transaction(owner.id, (sql) => sql.query(`SELECT id FROM api_idempotency WHERE response_body::text LIKE '%prism_lit_%'`));
  expect(receipt.rows).toEqual([]);
  expect((await request('GET', `${root}/tokens`, key)).status).toBe(401);
  expect((await request('POST', `${root}/tokens`, key, payload)).status).toBe(401);
  expect((await request('GET', '/me', key)).status).toBe(401);
  expect((await request('GET', '/research/references', key)).status).toBe(401);
  expect((await request('GET', `${root}/references`, ownerToken)).status).toBe(401);

  const standalone = randomUUID();
  const second = randomUUID();
  const foreign = randomUUID();
  const project = randomUUID();
  const projectRef = randomUUID();
  const collection = randomUUID();
  const makeReference = (token: string, ref: object) => request('POST', '/research/references', token, ref);
  expect((await makeReference(ownerToken, { id: standalone, title: 'Synthetic article', tags: ['Algebra'],
    publication: { journal: 'Journal', note: 'Private note', abstract: 'Private abstract' } })).status).toBe(201);
  expect((await makeReference(ownerToken, { id: second, title: 'Second article' })).status).toBe(201);
  expect((await makeReference(outsiderToken, { id: foreign, title: 'Other account' })).status).toBe(201);
  expect((await request('POST', '/research/projects', ownerToken, { id: project, title: 'Hidden project' })).status).toBe(201);
  expect((await makeReference(ownerToken, { id: projectRef, title: 'Project-only article', project_id: project })).status).toBe(201);
  expect((await request('POST', '/research/library/collections', ownerToken, { id: collection, name: 'Library collection' })).status).toBe(201);
  expect((await request('POST', '/research/library/memberships', ownerToken, { id: randomUUID(), collection_id: collection, reference_id: standalone })).status).toBe(201);
  const metadata = await request('GET', `${root}/references/${standalone}`, key);
  expect(metadata.body).toMatchObject({ id: standalone, tags: ['Algebra'], publication: { journal: 'Journal' } });
  expect(metadata.body.publication).toEqual({ journal: 'Journal' });
  expect(metadata.body).not.toHaveProperty('project_id');
  expect((await request('GET', `${root}/references/${foreign}`, key)).status).toBe(404);
  expect((await request('GET', `${root}/references/${projectRef}`, key)).status).toBe(404);
  expect((await request('GET', `${root}/collections`, key)).body.items).toEqual([{ id: collection, name: 'Library collection', parent_id: null }]);
  const page = (await request('GET', `${root}/references?limit=1`, key)).body;
  const next = (await request('GET', `${root}/references?cursor=${encodeURIComponent(page.next_cursor)}`, key)).body;
  expect([...page.items, ...next.items].map((item) => item.id).sort()).toEqual([standalone, second].sort());
  expect((await request('GET', `${root}/references?tag=ALGEBRA&collection_id=${collection}`, key)).body.items).toHaveLength(1);
  expect((await request('GET', `${root}/references?tag=ALGEBRA&cursor=${encodeURIComponent(page.next_cursor)}`, key)).status).toBe(422);
  expect((await request('DELETE', `${root}/tokens/${id}`, outsiderToken)).status).toBe(404);
  expect((await request('DELETE', `${root}/tokens/${id}`, ownerToken)).status).toBe(204);
  expect((await request('DELETE', `${root}/tokens/${id}`, ownerToken)).status).toBe(204);
  expect((await request('GET', `${root}/references`, key)).status).toBe(401);
  expect((await request('GET', `${root}/tokens`, ownerToken)).body.items).toEqual([]);
});

it('uses mutually exclusive scopes and returns only ready standalone attachment metadata', async () => {
  const id = randomUUID();
  const createToken = (tokenId: string, scope?: string) => request('POST', `${root}/tokens`, ownerToken, {
    id: tokenId, name: 'Synthetic attachment tool', expires_in_days: 1, ...(scope && { scope }),
  });
  const owner = await createToken(id, 'attachment_manifest');
  expect(owner.status).toBe(201);
  expect(owner.body).toMatchObject({ id, scope: 'attachment_manifest', token: expect.stringMatching(/^prism_lit_/) });
  const key = owner.body.token;
  const baseline = (await createToken(randomUUID())).body.token;
  const otherKey = (await createToken(randomUUID(), 'attachment_manifest')).body.token;
  expect((await createToken(randomUUID(), 'notes')).status).toBe(422);
  expect((await request('GET', `${root}/tokens`, ownerToken)).body.items).toContainEqual(expect.objectContaining({ id, scope: 'attachment_manifest' }));
  expect((await request('GET', `${root}/tokens`, outsiderToken)).body.items).toEqual([]);
  expect((await request('GET', `${root}/attachments`, ownerToken)).status).toBe(401);
  expect((await request('GET', `${root}/attachments`, baseline)).status).toBe(403);
  expect((await request('GET', `${root}/references`, key)).status).toBe(403);
  expect((await request('GET', `${root}/collections`, key)).status).toBe(403);
  expect((await request('GET', `${root}/attachments?reference_id=no`, key)).status).toBe(422);

  const standalone = randomUUID(), second = randomUUID(), foreign = randomUUID(), project = randomUUID(), projectRef = randomUUID();
  expect((await request('POST', '/research/projects', ownerToken, { id: project, title: 'Excluded fixture' })).status).toBe(201);
  for (const ref of [standalone, second, foreign, projectRef]) {
    expect((await request('POST', '/research/references', ref === foreign ? outsiderToken : ownerToken, {
      id: ref, title: 'Synthetic manuscript', ...(ref === projectRef && { project_id: project }),
    })).status).toBe(201);
  }
  async function upload(token: string, reference: string, name: string, complete = true) {
    const attachment = randomUUID();
    const content = Buffer.from(`Synthetic ${attachment}`);
    const data = { id: attachment, format: 'webpage', file_name: name, size_bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex') };
    expect((await request('POST', `/research/references/${reference}/attachments`, token, data)).status).toBe(200);
    if (complete) {
      const chunk = await app.inject({ method: 'PUT', url: `/api/v1/research/attachments/${attachment}/chunk`,
        headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() }, payload: { offset: 0, data: content.toString('base64') } });
      expect(chunk.statusCode).toBe(200);
      expect((await request('POST', `/research/attachments/${attachment}/complete`, token, {})).status).toBe(200);
    }
    return { ...data, reference_id: reference };
  }
  const first = await upload(ownerToken, standalone, 'Visible fixture.txt');
  const next = await upload(ownerToken, second, 'Other fixture.txt');
  await upload(ownerToken, standalone, 'Still uploading.txt', false);
  const archived = await upload(ownerToken, standalone, 'Removed fixture.txt');
  const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/research/attachments/${archived.id}`,
    headers: { Authorization: `Bearer ${ownerToken}`, 'Idempotency-Key': randomUUID(), 'If-Match': '"2"' } });
  expect(deleted.statusCode).toBe(204);
  await upload(ownerToken, projectRef, 'Project fixture.txt');
  await upload(outsiderToken, foreign, 'Foreign fixture.txt');

  const path = `${root}/attachments`;
  const firstPage = await request('GET', `${path}?limit=1`, key);
  expect(firstPage.headers['cache-control']).toBe('private, no-store');
  const cursor = encodeURIComponent(firstPage.body.next_cursor);
  expect(cursor).not.toBe('null');
  const nextPage = await request('GET', `${path}?cursor=${cursor}`, key);
  expect([...firstPage.body.items, ...nextPage.body.items].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
    [first, next].sort((a, b) => a.id.localeCompare(b.id)).map((row) => ({ ...row, updated_at: expect.any(String) })),
  );
  expect((await request('GET', `${path}?reference_id=${standalone}`, key)).body.items).toMatchObject([first]);
  expect((await request('GET', `${path}?cursor=${cursor}&reference_id=${standalone}`, key)).status).toBe(422);
  expect((await request('GET', `${path}?cursor=${cursor}`, otherKey)).status).toBe(422);
  expect((await request('GET', `${path}?reference_id=${foreign}`, key)).status).toBe(404);
  expect((await request('GET', `${path}?reference_id=${projectRef}`, key)).status).toBe(404);
  expect((await request('GET', `/research/attachments/${first.id}/download`, key)).status).toBe(401);
  expect((await request('GET', `/research/attachments/${first.id}/text-annotations`, key)).status).toBe(401);
  expect((await request('DELETE', `${root}/tokens/${id}`, ownerToken)).status).toBe(204);
  expect((await request('GET', path, key)).status).toBe(401);
});

it('isolates linked note text searches by workspace account', async () => {
  const ref = randomUUID(), note = randomUUID(), foreignRef = randomUUID();
  expect((await request('POST', '/research/references', ownerToken, { id: ref, title: 'Owned note search fixture' })).status).toBe(201);
  expect((await request('POST', '/research/references', outsiderToken, { id: foreignRef, title: 'Other note search fixture' })).status).toBe(201);
  expect((await request('POST', `/research/references/${ref}/notes`, ownerToken, {
    id: note, link_id: randomUUID(), title: 'Private fixture note', content: 'isolated gröbner basis',
  })).status).toBe(201);
  const search = { conditions: { field: 'note_text', operator: 'contains', value: 'isolated grobner basis' } };
  expect((await request('POST', '/research/library/search', ownerToken, search)).body.items).toEqual([expect.objectContaining({ id: ref })]);
  expect((await request('POST', '/research/library/search', outsiderToken, search)).body.items).toEqual([]);
  expect((await request('POST', `/research/references/${foreignRef}/knowledge-links`, outsiderToken, { id: randomUUID(), knowledge_item_id: note })).status).toBe(404);
});

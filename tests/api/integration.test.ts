import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../../packages/database/src/index';
import { buildApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config';
import { createTestPostgres } from '../../apps/api/src/testing';
import { validateApiResponse } from '../../apps/api/src/contract';
let app: Awaited<ReturnType<typeof buildApp>>, db: Database;
let postgres: Awaited<ReturnType<typeof createTestPostgres>> | undefined;
const id = () => randomUUID();
async function post(path: string, body: any, key = id(), version?: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1' + path,
    headers: { 'Idempotency-Key': key, ...(version ? { 'If-Match': `"${version}"` } : {}) },
    payload: body,
  });
  expect(
    await validateApiResponse('POST', path, r.statusCode, r.statusCode === 204 ? null : r.json()),
    r.body,
  ).toEqual([]);
  return r;
}
async function patch(path: string, body: any, version: string, key = id()) {
  const r = await app.inject({
    method: 'PATCH',
    url: '/api/v1' + path,
    headers: { 'Idempotency-Key': key, 'If-Match': `"${version}"` },
    payload: body,
  });
  expect(
    await validateApiResponse('PATCH', path, r.statusCode, r.statusCode === 204 ? null : r.json()),
    r.body,
  ).toEqual([]);
  return r;
}
const get = async (path: string) => {
  const r = await app.inject({ method: 'GET', url: '/api/v1' + path });
  if (r.headers['content-type']?.includes('application/json'))
    expect(await validateApiResponse('GET', path, r.statusCode, r.json()), r.body).toEqual([]);
  return r;
};
beforeAll(async () => {
  if (process.env.PRISM_API_TEST_POSTGRES === '1') {
    postgres = await createTestPostgres();
    db = postgres.db;
  } else db = await createDatabase({ memory: true });
  const dir = await mkdtemp(join(tmpdir(), 'prism-api-test-'));
  app = await buildApp({
    db,
    rateLimitMax: 1000,
    config: loadConfig({
      PRISM_AUTH_MODE: 'development',
      PRISM_DATA_DIR: dir,
      ...(postgres ? { PRISM_USER_ID: postgres.userId, PRISM_ALLOWED_SUBJECT: postgres.subject } : {}),
    }),
  });
});
afterAll(async () => {
  await app?.close();
  if (postgres) await postgres.cleanup();
  else await db?.close();
});
describe('PRISM canonical backend', () => {
  it('sorts filtered Library results across cursors with ties and missing fields', async () => {
    const token = `Library ordering ${id()}`;
    const fixtures = [
      { title: 'Alpha', authors: ['Zulu', 'Ada'], year: 2024 },
      { title: 'Beta', authors: ['Ada', 'Zulu'], year: 2021 },
      { title: 'Delta', authors: [], year: null },
      { title: 'Gamma', authors: ['ada'], year: 2024 },
      { title: 'Zeta', authors: [], year: null },
    ];
    for (const item of fixtures) {
      expect((await post('/research/references', { ...item, id: id(), title: `${token} ${item.title}` })).statusCode).toBe(201);
    }
    for (const [sort, direction, expected] of [
      ['year', 'asc', ['Beta', 'Alpha', 'Gamma', 'Delta', 'Zeta']],
      ['year', 'desc', ['Alpha', 'Gamma', 'Beta', 'Delta', 'Zeta']],
      ['author', 'asc', ['Beta', 'Gamma', 'Alpha', 'Delta', 'Zeta']],
      ['author', 'desc', ['Alpha', 'Beta', 'Gamma', 'Delta', 'Zeta']],
      ['title', 'desc', ['Zeta', 'Gamma', 'Delta', 'Beta', 'Alpha']],
    ] as const) {
      const query = new URLSearchParams({ q: token, sort, direction, limit: '1' });
      const actual: string[] = [];
      for (let i = 0; i < fixtures.length; i++) {
        const response = await get(`/research/library?${query}`);
        expect(response.statusCode).toBe(200);
        const page = response.json();
        expect(page.items).toHaveLength(1);
        actual.push(page.items[0].title.slice(token.length + 1));
        if (!page.next_cursor) break;
        query.set('cursor', page.next_cursor);
      }
      expect(actual).toEqual(expected);
    }
    const conditions = { field: 'title', operator: 'contains', value: token };
    const search = { conditions, sort: 'year', direction: 'desc', limit: 2 };
    const first = (await post('/research/library/search', search)).json();
    expect(first.items.map((item: { year: number }) => item.year)).toEqual([2024, 2024]);
    const second = (await post('/research/library/search', { ...search, cursor: first.next_cursor })).json();
    expect(second.items.map((item: { year: number | null }) => item.year)).toEqual([2021, null]);
    expect((await post('/research/library/search', { ...search, direction: 'asc', cursor: first.next_cursor })).statusCode).toBe(422);
  });

  it('serves initialized user with closed validation', async () => {
    expect((await get('/me')).statusCode).toBe(200);
    const r = await post('/knowledge-items', {
      id: id(),
      title: 'Test',
      type: 'theorem',
      content: 'x',
      user_id: id(),
    });
    expect(r.statusCode).toBe(422);
  });
  it('rejects malformed query values without server errors', async () => {
    expect((await get('/today?date=bad')).statusCode).toBe(422);
    expect((await get('/tasks?limit=-1')).statusCode).toBe(422);
    expect((await get('/tasks?project_id=bad')).statusCode).toBe(422);
  });
  it('persists ordered creator roles and maintains legacy bibliography fields', async () => {
    const reference = id();
    const base = '/research/references';
    const path = `${base}/${reference}`;
    const creators = [
      { role: 'translator', name: '  Translator, Téa  ' },
      { role: 'author', name: 'Example, Ada' },
      { role: 'editor', name: 'Editor, Eve' },
      { role: 'author', name: 'Example, Sam' },
    ];
    const expected = creators.map((creator) => ({ ...creator, name: creator.name.trim() }));
    const payload = { id: reference, title: 'Chapter fixture', authors: ['Outdated projection'], creators,
      publication: { type: 'incollection', booktitle: 'Book of Algebra', editor: 'Outdated editor' } };
    const created = await post(base, payload);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ creators: expected, authors: ['Example, Ada', 'Example, Sam'],
      publication: { type: 'incollection', booktitle: 'Book of Algebra', editor: 'Editor, Eve', translator: 'Translator, Téa' } });
    const listing = (await get('/research/library?q=Chapter%20fixture')).json().items;
    expect(listing).toEqual([expect.objectContaining({ id: reference, creators: expected })]);
    const project = id();
    expect((await post('/research/projects', { id: project, title: 'Creator project fixture' })).statusCode).toBe(201);
    expect((await post('/research/reference-links', { id: id(), project_id: project, reference_id: reference })).statusCode).toBe(201);
    expect((await get(`/research/projects/${project}/bibliography`)).json().items).toEqual([expect.objectContaining({ creators: expected })]);
    const oldClient = await patch(path, { authors: ['Example, Uma'] }, '1');
    expect(oldClient.json()).toMatchObject({ creators: [expected[0], { role: 'author', name: 'Example, Uma' }, expected[2]],
      publication: { translator: 'Translator, Téa' }, version: '2' });
    const newClient = await patch(path, { creators: [{ role: 'editor', name: 'Editor, Eva' }] }, '2');
    expect(newClient.json()).toMatchObject({ authors: [], creators: [{ role: 'editor', name: 'Editor, Eva' }],
      publication: { type: 'incollection', booktitle: 'Book of Algebra', editor: 'Editor, Eva' }, version: '3' });
    expect(newClient.json().publication).not.toHaveProperty('translator');
    const importId = id();
    const imported = await post('/research/library/import', { items: [{ id: importId, title: 'Imported creators', creators }] });
    expect(imported.statusCode).toBe(200);
    expect((await get(`${base}/${importId}`)).json()).toMatchObject({ creators: expected });
    const oldId = id();
    const old = await post(base, { id: oldId, title: 'Legacy creators', authors: ['Legacy author'], publication: { editor: 'Legacy editor' } });
    expect(old.json()).toMatchObject({ authors: ['Legacy author'], publication: { editor: 'Legacy editor' } });
    expect(old.json()).not.toHaveProperty('creators');
  });
  it('pins and reverts native citation keys while keeping existing citations resolvable', async () => {
    const refId = id();
    const otherId = id();
    const sourceId = id();
    const fallback = `ref-${refId}`;
    const endpoint = `/research/references/${refId}/citation-key`;
    const otherEndpoint = `/research/references/${otherId}/citation-key`;
    expect((await post('/research/references', {
      id: refId, title: 'Citation fixture', arxiv_id: '2601.12345',
    })).statusCode).toBe(201);
    expect((await post('/research/references', {
      id: otherId, title: 'Other citation fixture', citation_key: 'External:key',
    })).statusCode).toBe(201);
    expect((await post('/research/references', { id: sourceId, title: 'Merged citation fixture' })).statusCode).toBe(201);
    expect((await patch(endpoint, { citation_key: 'arxiv-2601.12345' }, '1')).statusCode).toBe(422);
    expect((await patch(endpoint, { citation_key: `ref-${otherId}` }, '1')).statusCode).toBe(422);
    expect((await patch(endpoint, { citation_key: 'External:key' }, '1')).statusCode).toBe(409);
    expect((await patch(endpoint, { citation_key: fallback }, '1')).json()).toMatchObject({ version: '1', citation_key: null });
    const key = id();
    const pinned = await patch(endpoint, { citation_key: 'Author_2026:fixture' }, '1', key);
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(pinned.json()).toMatchObject({ version: '2', citation_key: 'Author_2026:fixture', citation_aliases: [fallback] });
    expect((await patch(endpoint, { citation_key: 'Author_2026:fixture' }, '1', key)).json()).toEqual(pinned.json());
    expect((await patch(endpoint, { citation_key: 'Another', }, '1')).statusCode).toBe(412);
    const next = await patch(endpoint, { citation_key: 'Author.2026' }, '2');
    expect(next.json()).toMatchObject({ version: '3', citation_key: 'Author.2026', citation_aliases: [fallback, 'Author_2026:fixture'] });
    expect((await patch(otherEndpoint, { citation_key: 'Author_2026:fixture' }, '1')).statusCode).toBe(409);
    const merge = await post('/research/library/merge', {
      target_id: refId, target_version: '3', sources: [{ id: sourceId, version: '1' }],
    });
    expect(merge.statusCode, merge.body).toBe(200);
    expect((await get(`/research/references/${refId}`)).json()).toMatchObject({
      citation_aliases: [fallback, 'Author_2026:fixture', `ref-${sourceId}`], version: '4',
    });
    expect((await patch(endpoint, { citation_key: `ref-${sourceId}` }, '4')).json()).toMatchObject({
      version: '5', citation_key: `ref-${sourceId}`, citation_aliases: [fallback, 'Author_2026:fixture', 'Author.2026'],
    });
    expect((await patch(endpoint, { citation_key: fallback }, '5')).json()).toMatchObject({
      version: '6', citation_key: null, citation_aliases: ['Author_2026:fixture', 'Author.2026', `ref-${sourceId}`],
    });
  });
  it('edits selected references atomically and undoes only the original fields', async () => {
    const endpoint = '/research/library/batch-edit';
    const firstId = id();
    const secondId = id();
    const firstPath = `/research/references/${firstId}`;
    const secondPath = `/research/references/${secondId}`;
    const base = '/research/references';
    await post(base, { id: firstId, title: 'Batch reference A', tags: ['Algebra', 'old'], year: 2024,
      citation_key: 'Batch:ReferenceA', publication: { type: 'article', journal: 'Original Journal', volume: '10' } });
    await post(base, { id: secondId, title: 'Batch reference B', tags: ['old'],
      publication: { journal: 'Second Journal', publisher: 'Original Press', pages: '1–3' } });
    const items = [{ id: firstId, version: '1' }, { id: secondId, version: '1' }];
    const changes = { tags_add: ['geometry', 'ALGEBRA'], tags_remove: ['OLD'], year: null,
      publication: { type: 'book', journal: null, publisher: 'New Press' } };
    const command = { items, changes };
    expect((await post(endpoint, { ...command, items: [...items, { ...items[0], id: firstId.toUpperCase() }] })).statusCode).toBe(422);
    expect((await post(endpoint, { ...command, items: [items[0], { ...items[1], version: '2' }] })).statusCode).toBe(412);
    expect((await post(endpoint, { ...command, items: [items[0], { id: id(), version: '1' }] })).statusCode).toBe(404);
    expect((await get(firstPath)).json()).toMatchObject({ version: '1', tags: ['Algebra', 'old'] });
    expect((await post(endpoint, { items: [items[0]], changes: { tags_add: Array.from({ length: 40 }, (_, i) => `tag${i}`) } })).statusCode).toBe(422);
    expect((await post(endpoint, { items: [items[0]], changes: { tags_add: ['algebra'] } })).json()).toEqual({
      items: [items[0]], changed_count: 0, undo_token: null,
    });
    const key = id();
    const applied = await post(endpoint, command, key);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toEqual({ items: items.map((item) => ({ ...item, version: '2' })), changed_count: 2, undo_token: key });
    expect((await post(endpoint, command, key)).json()).toEqual(applied.json());
    expect((await post(endpoint, { ...command, changes: { year: 2026 } }, key)).statusCode).toBe(409);
    expect((await get(firstPath)).json()).toMatchObject({ title: 'Batch reference A', year: null,
      tags: ['Algebra', 'geometry'], citation_key: 'Batch:ReferenceA',
      publication: { type: 'book', publisher: 'New Press', volume: '10' } });
    expect((await get(secondPath)).json().publication).toEqual({ type: 'book', publisher: 'New Press', pages: '1–3' });

    const undo = `${endpoint}/undo`;
    const undoKey = id();
    expect((await post(undo, { undo_token: id() })).statusCode).toBe(404);
    const undone = await post(undo, { undo_token: key }, undoKey);
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json()).toEqual({ items: items.map((item) => ({ ...item, version: '3' })), changed_count: 2 });
    expect((await post(undo, { undo_token: key }, undoKey)).json()).toEqual(undone.json());
    expect((await post(undo, { undo_token: key })).statusCode).toBe(412);
    expect((await get(firstPath)).json()).toMatchObject({ tags: ['Algebra', 'old'], year: 2024, version: '3' });
    expect((await get(firstPath)).json().publication).toEqual({ type: 'article', journal: 'Original Journal', volume: '10' });
    expect((await get(secondPath)).json().publication).toEqual({ journal: 'Second Journal', publisher: 'Original Press', pages: '1–3' });

    const next = await post(endpoint, { items: items.map((item) => ({ ...item, version: '3' })), changes: { year: 2026 } });
    expect((await patch(secondPath, { title: 'Edit after batch' }, '4')).statusCode).toBe(200);
    const stale = await post(undo, { undo_token: next.json().undo_token });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().error.details).toMatchObject({ id: secondId, current_version: '5' });
    expect((await get(firstPath)).json()).toMatchObject({ year: 2026, version: '4' });
    expect((await get(secondPath)).json()).toMatchObject({ year: 2026, version: '5' });
    const expired = await post(endpoint, { items: [{ id: firstId, version: '4' }], changes: { year: 2027 } });
    const date = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 3_600_000);
    try {
      expect((await post(undo, { undo_token: expired.json().undo_token })).statusCode).toBe(410);
    } finally {
      date.mockRestore();
    }
    expect((await get(firstPath)).json()).toMatchObject({ year: 2027, version: '5' });
  });
  it('imports standalone references atomically and preserves metadata and citation keys', async () => {
    const manual = id(), imported = id(), duplicate = id(), invalid = id();
    const publication = { type: 'article', journal: 'Synthetic Journal of Rings', keywords: 'rings; ideals' };
    const citationKey = 'Local_Rings:2026';
    const manuallyAdded = await post('/research/references', { id: manual, title: 'Standalone fixture' });
    expect(manuallyAdded.statusCode).toBe(201);
    expect(manuallyAdded.json()).toMatchObject({ project_id: null, citation_key: null, publication: {} });

    const invalidBatch = await post('/research/library/import', { items: [
      { id: imported, title: 'Valid entry first' }, { id: invalid, title: 'Invalid URL', url: 'file:///tmp/no.pdf' },
    ] });
    expect(invalidBatch.statusCode).toBe(422);
    expect((await get(`/research/references/${imported}`)).statusCode).toBe(404);

    const importBody = { items: [
      { id: imported, title: 'Local Rings', doi: '10.5555/LOCAL-RINGS', citation_key: citationKey, publication },
      { id: duplicate, title: 'Local Rings duplicate', doi: '10.5555/local-rings' },
    ] };
    const operation = id();
    const results = await post('/research/library/import', importBody, operation);
    expect(results.statusCode).toBe(200);
    expect(results.json()).toEqual({ items: [
      { id: imported, status: 'imported', reference_id: imported, citation_key: citationKey },
      { id: duplicate, status: 'skipped', reference_id: imported, citation_key: citationKey, reason: 'duplicate', matched_by: 'doi' },
    ] });
    expect((await post('/research/library/import', importBody, operation)).json()).toEqual(results.json());
    const entry = (await get('/research/library?q=Synthetic%20Journal%20of%20Rings')).json().items[0];
    expect(entry).toMatchObject({ id: imported, projects: [], citation_key: citationKey, publication });
    expect((await get(`/research/references/${duplicate}`)).statusCode).toBe(404);
    const edited = await patch(`/research/references/${imported}`, { title: 'Rings and ideals' }, entry.version);
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ id: imported, citation_key: citationKey, publication });
    expect((await get(`/graph?focus=reference:${manual}`)).json()).toMatchObject({
      nodes: [{ id: `reference:${manual}`, kind: 'paper', label: 'Standalone fixture', href: `/research/library?reference=${manual}` }],
      edges: [],
    });
  });

  it('imports Zotero collections and linked notes atomically without overwriting earlier imports', async () => {
    const userId = (await get('/me')).json().id;
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    const fileHash = sha(id());
    const item = (name: string, doi?: string) => {
      const resourceHash = sha(name);
      const hash = sha(`${userId}:${fileHash}:${resourceHash}`);
      return { id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${((Number.parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
        title: name, doi, import_source: { format: 'zotero-rdf', file_sha256: fileHash, resource_sha256: resourceHash } };
    };
    const duplicateDoi = `10.5555/zotero-${fileHash.slice(0, 10)}`;
    const manual = (await post('/research/references', { id: id(), title: 'Existing independent Zotero match', doi: duplicateDoi })).json();
    const existingFileItem = item('Zotero previously imported');
    const duplicateItem = item('Zotero duplicate by DOI', duplicateDoi);
    const newItem = item('Zotero newly imported');
    expect((await post('/research/library/import', { items: [existingFileItem] })).statusCode).toBe(200);
    const parent = sha('top');
    const child = sha('child');
    const body = {
      file_sha256: fileHash, items: [existingFileItem, duplicateItem, newItem], link_existing: false,
      collections: [
        { resource_sha256: child, parent_resource_sha256: parent, name: 'Imported child', reference_ids: [newItem.id, duplicateItem.id] },
        { resource_sha256: parent, parent_resource_sha256: null, name: 'Imported top', reference_ids: [existingFileItem.id] },
      ],
      notes: [
        { resource_sha256: sha('note1'), reference_id: existingFileItem.id, title: 'Imported source note', content: 'Original Zotero text' },
        { resource_sha256: sha('note2'), reference_id: duplicateItem.id, title: 'Note for an independent duplicate', content: 'Retain only after confirmation' },
      ],
    };
    const path = '/research/library/zotero-rdf/import';
    const cyclic = { ...body, collections: [body.collections[0], { ...body.collections[1], parent_resource_sha256: child }] };
    expect((await post(path, cyclic)).statusCode).toBe(422);
    expect((await get(`/research/references/${newItem.id}`)).statusCode).toBe(404);
    expect((await post(path, { ...body, items: [...body.items, { ...item('Late invalid URL'), url: 'file:///fixture/never-read' }] })).statusCode).toBe(422);
    expect((await get(`/research/references/${newItem.id}`)).statusCode).toBe(404);
    const key = id();
    const result = await post(path, body, key);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ collections_created: 3, memberships_created: 2, memberships_skipped: 1, notes_created: 1, notes_skipped: 1 });
    expect((await post(path, body, key)).json()).toEqual(result.json());
    const collectionList = (await get('/research/library/collections')).json().items;
    const root = collectionList.find((entry: any) => entry.name === `Zotero import ${fileHash.slice(0, 8)}`);
    const top = collectionList.find((entry: any) => entry.parent_id === root.id);
    const nested = collectionList.find((entry: any) => entry.parent_id === top.id);
    expect(nested.name).toBe('Imported child');
    expect((await get(`/research/library?collection_id=${nested.id}`)).json().items.map((entry: any) => entry.id)).toEqual([newItem.id]);
    const sourceNote = (await get(`/research/references/${existingFileItem.id}/knowledge-links`)).json().items[0];
    expect(sourceNote.title).toBe('Imported source note');
    const snapshot = (await get(`/knowledge-items/${sourceNote.knowledge_item_id}`)).json();
    const edit = await patch(`/knowledge-items/${sourceNote.knowledge_item_id}`, { content: 'Keep my edits', base_snapshot: snapshot }, snapshot.version);
    expect(edit.statusCode, edit.body).toBe(200);
    const reimport = await post(path, { ...body, link_existing: true });
    expect(reimport.statusCode, reimport.body).toBe(200);
    expect(reimport.json()).toMatchObject({ collections_kept: 3, memberships_kept: 2, memberships_created: 1, notes_kept: 1, notes_created: 1 });
    expect((await get(`/knowledge-items/${sourceNote.knowledge_item_id}`)).json().content).toBe('Keep my edits');
    expect((await get(`/research/references/${manual.id}`)).json().title).toBe('Existing independent Zotero match');
    expect((await get(`/research/references/${manual.id}/knowledge-links`)).json().items[0].title).toBe('Note for an independent duplicate');
    expect((await patch(`/research/library/collections/${nested.id}`, { parent_id: null }, nested.version)).statusCode).toBe(200);
    const afterMove = item('Zotero late transactional rollback');
    expect((await post(path, { ...body, items: [...body.items, afterMove] })).statusCode).toBe(409);
    expect((await get(`/research/references/${afterMove.id}`)).statusCode).toBe(404);
  });

  it('imports a notes-only Zotero export, preserves collection tags and never restores deleted notes', async () => {
    const sha = (value: string) => createHash('sha256').update(value).digest('hex');
    const suffix = id();
    const fileHash = sha(suffix);
    const title = `Independent Zotero note ${suffix}`;
    const note = { resource_sha256: sha('note'), title, content: 'Original standalone note',
      collection_paths: [['Algebra', 'Ideas'], ['Spring reading']] };
    const body = { file_sha256: fileHash, items: [], collections: [], notes: [], standalone_notes: [note], link_existing: false };
    const path = '/research/library/zotero-rdf/import';
    expect((await post('/research/library/import', { items: [] })).statusCode).toBe(422);
    expect((await post(path, { ...body, standalone_notes: [] })).statusCode).toBe(422);
    expect((await post(path, { ...body, standalone_notes: [note, note] })).statusCode).toBe(422);
    expect((await post(path, { ...body, standalone_notes: [note, { ...note, resource_sha256: sha('bad'), collection_paths: [['A'.repeat(120), 'B'.repeat(120), 'C'.repeat(120)]] }] })).statusCode).toBe(422);
    const lookup = `/knowledge-items?subject=Zotero%20notes&q=${suffix}`;
    expect((await get(lookup)).json().items).toEqual([]);
    const result = await post(path, body);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ items: [], standalone_notes_created: 1, standalone_notes_kept: 0 });
    const [imported] = (await get(lookup)).json().items;
    const editPath = `/knowledge-items/${imported.id}`;
    expect(imported).toMatchObject({ type: 'note', title, content: note.content,
      tags: ['Zotero collection: Algebra › Ideas', 'Zotero collection: Spring reading'] });
    expect((await get(`/knowledge-items?tag=${encodeURIComponent('Zotero collection: Algebra › Ideas')}`)).json().items).toContainEqual(imported);
    const edited = await patch(editPath, { base_snapshot: imported, title: 'My title', content: 'My note edits', tags: ['My tag'] }, imported.version);
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await post(path, body)).json()).toMatchObject({ standalone_notes_created: 0, standalone_notes_kept: 1 });
    expect((await get(editPath)).json()).toMatchObject({ title: 'My title', content: 'My note edits', tags: ['My tag'] });
    const removed = await app.inject({ method: 'DELETE', url: `/api/v1${editPath}`,
      headers: { 'If-Match': `"${edited.json().version}"`, 'Idempotency-Key': id() } });
    expect(removed.statusCode).toBe(204);
    expect((await post(path, body)).json()).toMatchObject({ standalone_notes_created: 0, standalone_notes_kept: 0, standalone_notes_skipped: 1 });
    expect((await get(editPath)).statusCode).toBe(404);
  });

  it('links the same standalone reference to multiple projects and detaches it independently', async () => {
    const reference = (await post('/research/references', {
      id: id(), title: 'Canonical link fixture', citation_key: 'Canonical:fixture',
    })).json();
    const first = (await post('/research/projects', { id: id(), title: 'Canonical first project' })).json();
    const second = (await post('/research/projects', { id: id(), title: 'Canonical second project' })).json();
    const link = (project: string, referenceId = reference.id) => post('/research/reference-links', {
      id: id(), project_id: project, reference_id: referenceId,
    });
    const [firstLink, secondLink] = await Promise.all([link(first.id), link(second.id)]);
    expect(firstLink.statusCode).toBe(201);
    expect(secondLink.statusCode).toBe(201);
    expect((await link(first.id)).statusCode).toBe(409);
    const legacy = (await post('/research/references', {
      id: id(), project_id: first.id, title: 'Canonical legacy fixture',
    })).json();
    expect((await link(second.id, legacy.id)).statusCode).toBe(422);
    expect((await get(`/research/reference-links?reference_id=${reference.id}`)).json().items).toHaveLength(2);
    for (const [project, result] of [[first, firstLink], [second, secondLink]] as const) {
      const bibliography = (await get(`/research/projects/${project.id}/bibliography`)).json().items;
      expect(bibliography).toContainEqual(expect.objectContaining({
        id: reference.id, citation_key: reference.citation_key, link_id: result.json().id, link_version: '1',
      }));
    }
    const library = (await get('/research/library?q=Canonical&standalone=true')).json().items;
    expect(library).toEqual([expect.objectContaining({ id: reference.id, project_id: null,
      projects: [{ id: first.id, title: first.title }, { id: second.id, title: second.title }],
    })]);
    const graph = (await get(`/graph?focus=reference:${reference.id}&depth=1`)).json();
    expect(graph.edges).toEqual(expect.arrayContaining([first, second].map((project) => ({
      source: `project:${project.id}`, target: `reference:${reference.id}`, kind: 'project_reference',
    }))));
    const remove = (path: string, version: string) => app.inject({
      method: 'DELETE', url: `/api/v1${path}`,
      headers: { 'Idempotency-Key': id(), 'If-Match': `"${version}"` },
    });
    expect((await remove(`/research/reference-links/${firstLink.json().id}`, '1')).statusCode).toBe(204);
    expect((await remove(`/research/projects/${second.id}`, '1')).statusCode).toBe(204);
    expect((await get(`/research/references/${reference.id}`)).json()).toMatchObject({ version: '1' });
    expect((await get(`/research/reference-links?reference_id=${reference.id}`)).json().items).toEqual([]);
    expect((await link(first.id)).statusCode).toBe(201);
    expect((await remove(`/research/references/${reference.id}`, '1')).statusCode).toBe(204);
    expect((await get(`/research/reference-links?reference_id=${reference.id}`)).json().items).toEqual([]);
  });

  it('organizes references in nested collections with independent membership and exact tags', async () => {
    const collections = '/research/library/collections';
    const memberships = '/research/library/memberships';
    const createCollection = (name: string, parentId: string | null = null) =>
      post(collections, { id: id(), name, parent_id: parentId });
    const root = (await createCollection('  Algebra  ')).json();
    expect(root).toMatchObject({ name: 'Algebra', parent_id: null, version: '1' });
    expect((await createCollection('algebra')).statusCode).toBe(409);
    const child = (await createCollection('Commutative', root.id)).json();
    const grandchild = (await createCollection('Ideals', child.id)).json();
    const otherRoot = (await createCollection('Geometry')).json();
    expect((await patch(`${collections}/${root.id}`, { parent_id: grandchild.id }, '1')).statusCode).toBe(422);
    expect((await patch(`${collections}/${root.id}`, { parent_id: root.id }, '1')).statusCode).toBe(422);
    expect((await patch(`${collections}/${child.id}`, { parent_id: id() }, '1')).statusCode).toBe(404);
    const moved = await patch(`${collections}/${child.id}`, { name: 'Rings', parent_id: otherRoot.id }, '1');
    expect(moved.json()).toMatchObject({ name: 'Rings', parent_id: otherRoot.id, version: '2' });
    expect((await patch(`${collections}/${child.id}`, { parent_id: null }, '1')).statusCode).toBe(412);
    expect((await get(collections)).json().items.map((row: { id: string }) => row.id)).toEqual(
      expect.arrayContaining([root.id, child.id, grandchild.id, otherRoot.id]),
    );

    const fixture = (await post('/research/references', {
      id: id(), title: 'Bibliography membership fixture', tags: [' Rings ', 'rings', ' Abstract Algebra ', ' '],
    })).json();
    expect(fixture.tags).toEqual(['Rings', 'Abstract Algebra']);
    const link = (collection: string) => post(memberships, { id: id(), collection_id: collection, reference_id: fixture.id });
    const first = (await link(child.id)).json();
    expect((await link(child.id)).statusCode).toBe(409);
    const second = (await link(root.id)).json();
    expect((await get(`${memberships}?reference_id=${fixture.id}`)).json().items.map((row: { id: string }) => row.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    const inCollection = (await get(`/research/library?collection_id=${child.id}&tag=RINGS`)).json().items;
    expect(inCollection.map((row: { id: string }) => row.id)).toEqual([fixture.id]);
    expect((await get(`/research/library?collection_id=${child.id}&tag=RING`)).json().items).toEqual([]);
    expect((await get(`/research/library?collection_id=${grandchild.id}`)).json().items).toEqual([]);
    expect((await get(`/research/library?q=Abstract%20Algebra`)).json().items).toContainEqual(
      expect.objectContaining({ id: fixture.id }),
    );
    const remove = (path: string, version = '1') => app.inject({
      method: 'DELETE', url: `/api/v1${path}`,
      headers: { 'Idempotency-Key': id(), 'If-Match': `"${version}"` },
    });
    expect((await remove(`${collections}/${root.id}`)).statusCode).toBe(409);
    expect((await remove(`${collections}/${child.id}`, '2')).statusCode).toBe(409);
    expect((await remove(`${memberships}/${second.id}`)).statusCode).toBe(204);
    expect((await remove(`${collections}/${root.id}`)).statusCode).toBe(204);
    expect((await get(`/research/references/${fixture.id}`)).statusCode).toBe(200);
    expect((await get(`/research/library?collection_id=${root.id}`)).statusCode).toBe(404);
    expect((await remove(`/research/references/${fixture.id}`)).statusCode).toBe(204);
    expect((await get(`${memberships}?collection_id=${child.id}`)).json().items).toEqual([]);
    expect((await get(`${collections}/${child.id}`)).statusCode).toBe(200);
  });

  it('merges versioned standalone duplicates without losing citations or relationships', async () => {
    const target = (await post('/research/references', {
      id: id(), title: 'Canonical Merge Rings', authors: ['Example, Ada'], year: 2026,
      citation_key: 'Merge:target', arxiv_id: '2611.12341v1', tags: ['Rings'],
      publication: { journal: 'Target journal' },
    })).json();
    const source = (await post('/research/references', {
      id: id(), title: 'Canonical  Merge Rings', authors: ['EXAMPLE, ADA'], year: 2026,
      citation_key: 'Merge:source', arxiv_id: '2611.12341v2', doi: '10.5555/merge-fixture',
      tags: ['rings', 'Ideals'], publication: { journal: 'Source journal', volume: '10' },
    })).json();
    const project = (await post('/research/projects', { id: id(), title: 'Duplicate merge project' })).json();
    const collection = (await post('/research/library/collections', { id: id(), name: 'Duplicate merge collection' })).json();
    const sourceLink = (await post('/research/reference-links', {
      id: id(), project_id: project.id, reference_id: source.id,
    })).json();
    const targetMembership = (await post('/research/library/memberships', {
      id: id(), collection_id: collection.id, reference_id: target.id,
    })).json();
    expect((await post('/research/library/memberships', {
      id: id(), collection_id: collection.id, reference_id: source.id,
    })).statusCode).toBe(201);
    const duplicates = await get('/research/library/duplicates');
    expect(duplicates.statusCode).toBe(200);
    expect(duplicates.json().items).toContainEqual(expect.objectContaining({
      matched_by: 'arxiv_id', value: '2611.12341', references: expect.arrayContaining([
        expect.objectContaining({ id: target.id }), expect.objectContaining({ id: source.id }),
      ]),
    }));
    const mergePath = '/research/library/merge';
    const body = { target_id: target.id, target_version: target.version, sources: [{ id: source.id, version: source.version }] };
    expect((await post(mergePath, { ...body, sources: [{ id: source.id, version: '999' }] })).statusCode).toBe(412);
    expect((await get(`/research/references/${source.id}`)).json().id).toBe(source.id);
    expect((await post(mergePath, { ...body, sources: [{ id: id(), version: '1' }] })).statusCode).toBe(404);
    const mismatch = (await post('/research/references', {
      id: id(), title: 'Different identifier', arxiv_id: '2611.12342',
    })).json();
    expect((await post(mergePath, { ...body, sources: [...body.sources, { id: mismatch.id, version: '1' }] })).statusCode).toBe(422);
    expect((await get(`/research/references/${source.id}`)).json().id).toBe(source.id);
    const key = id();
    const result = await post(mergePath, body, key);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ reference: {
      id: target.id, version: '2', citation_key: 'Merge:target',
      citation_aliases: [`ref-${source.id}`, 'Merge:source'],
      doi: '10.5555/merge-fixture', arxiv_id: '2611.12341v1', tags: ['Rings', 'Ideals'],
      publication: { journal: 'Target journal', volume: '10' },
    }, merged_ids: [source.id] });
    expect((await post(mergePath, body, key)).json()).toEqual(result.json());
    expect((await get(`/research/references/${source.id}`)).json().id).toBe(target.id);
    expect((await get(`/graph?focus=reference:${source.id}`)).json().nodes).toContainEqual(
      expect.objectContaining({ id: `reference:${target.id}` }),
    );
    expect((await get(`/research/projects/${project.id}/bibliography`)).json().items).toEqual([
      expect.objectContaining({ id: target.id, link_id: sourceLink.id, citation_aliases: [`ref-${source.id}`, 'Merge:source'] }),
    ]);
    expect((await get(`/research/library/memberships?collection_id=${collection.id}`)).json().items).toEqual([
      expect.objectContaining({ id: targetMembership.id, reference_id: target.id }),
    ]);
    expect((await post('/research/references', { id: id(), title: 'Conflicting key', citation_key: 'Merge:source' })).statusCode).toBe(409);
    expect((await post('/research/library/import', { items: [{ id: id(), title: 'Old citation', citation_key: 'Merge:source' }] })).json().items).toEqual([
      expect.objectContaining({ status: 'skipped', matched_by: 'citation_key', reference_id: target.id }),
    ]);
    expect((await get('/research/library/duplicates')).json().items).not.toContainEqual(
      expect.objectContaining({ matched_by: 'arxiv_id', value: '2611.12341' }),
    );
  });

  it('syncs saved search filters without broadening deleted collection scope', async () => {
    const searches = '/research/library/saved-searches';
    const collection = (await post('/research/library/collections', { id: id(), name: 'Saved-search fixture collection' })).json();
    const searchId = id();
    const payload = { id: searchId, name: '  Read later  ', query: '  module  ', tag: ' Algebra ', collection_id: collection.id };
    const created = await post(searches, payload);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: searchId, name: 'Read later', query: 'module', tag: 'Algebra', collection_id: collection.id });
    expect((await post(searches, { id: id(), name: 'read later' })).statusCode).toBe(409);
    expect((await post(searches, { id: id(), name: 'Foreign collection', collection_id: id() })).statusCode).toBe(404);
    const remove = (path: string, version: string) => app.inject({
      method: 'DELETE', url: `/api/v1${path}`,
      headers: { 'Idempotency-Key': id(), 'If-Match': `"${version}"` },
    });
    expect((await remove(`/research/library/collections/${collection.id}`, '1')).statusCode).toBe(204);
    expect((await get(`/research/library?collection_id=${collection.id}`)).statusCode).toBe(404);
    const stillSaved = (await get(searches)).json().items.find((search: { id: string }) => search.id === searchId);
    expect(stillSaved.collection_id).toBe(collection.id);
    const renamed = await patch(`${searches}/${searchId}`, { name: 'Old collection search' }, '1');
    expect(renamed.json()).toMatchObject({ name: 'Old collection search', version: '2', collection_id: collection.id });
    expect((await patch(`${searches}/${searchId}`, { collection_id: null }, '1')).statusCode).toBe(412);
    const device = (await post('/devices', { id: id(), name: 'Literature sync', platform: 'web' })).json();
    const snapshot = (await post('/sync/snapshots', { device_id: device.id })).json();
    const page = (await get(`/sync/snapshots/${snapshot.id}/records?limit=500`)).json();
    expect(page.records).toContainEqual(expect.objectContaining({
      entity_type: 'literature_saved_search', entity_id: searchId,
      data: expect.objectContaining({ collection_id: collection.id, name: 'Old collection search' }),
    }));
    expect((await remove(`${searches}/${searchId}`, '2')).statusCode).toBe(204);
    expect((await get(`${searches}/${searchId}`)).statusCode).toBe(404);
  });

  it('combines bounded advanced literature conditions and preserves saved filters', async () => {
    const reference = async (title: string, authors: string[], year: number, tags: string[]) =>
      (await post('/research/references', { id: id(), title, authors, year, tags })).json();
    const first = await reference('Search fixture algebra', ['Ada Example'], 2023, ['Rings']);
    const second = await reference('Search fixture geometry', ['Benoit Example'], 2024, ['Rings']);
    const third = await reference('Search fixture obsolete', ['Ada Example'], 2020, ['Geometry']);
    const collection = (await post('/research/library/collections', { id: id(), name: 'Advanced search fixture' })).json();
    const member = await post('/research/library/memberships', { id: id(), collection_id: collection.id, reference_id: first.id });
    expect(member.statusCode).toBe(201);
    const conditions = { all: [
      { any: [
        { field: 'author', operator: 'contains', value: 'Ada' },
        { field: 'year', operator: 'gte', value: 2024 },
      ] },
      { not: { field: 'tag', operator: 'equals', value: 'GEOMETRY' } },
    ] };
    const searchPath = '/research/library/search';
    const search = (body: Record<string, unknown>) => post(searchPath, body);
    const page = await search({ conditions, q: 'search fixture', limit: 1 });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().items).toEqual([expect.objectContaining({ id: first.id })]);
    const cursor = page.json().next_cursor;
    expect(cursor).toBeTruthy();
    expect((await search({ conditions, q: 'search fixture', cursor })).json().items).toEqual([
      expect.objectContaining({ id: second.id }),
    ]);
    expect((await search({ conditions, q: 'fixture', cursor })).statusCode).toBe(422);
    expect((await search({ conditions, tag: 'geometry' })).json().items).toEqual([]);
    expect((await search({ conditions, collection_id: collection.id })).json().items).toEqual([
      expect.objectContaining({ id: first.id }),
    ]);
    expect((await search({ conditions: { field: 'title', operator: 'contains', value: "%' OR 1=1 --" } })).json().items).toEqual([]);
    expect((await search({ conditions: { all: [] } })).statusCode).toBe(422);
    expect((await search({ conditions: { field: 'year', operator: 'contains', value: 2024 } })).statusCode).toBe(422);
    let deep: Record<string, unknown> = { field: 'year', operator: 'equals', value: 2024 };
    for (let index = 0; index < 5; index++) deep = { not: deep };
    expect((await search({ conditions: deep })).statusCode).toBe(422);
    expect((await search({ conditions: { not: { field: 'collection', operator: 'equals', value: id() } } })).statusCode).toBe(404);
    expect((await search({ conditions: { all: [
      { field: 'title', operator: 'equals', value: third.title },
      { field: 'has_attachment', operator: 'equals', value: false },
      { field: 'source', operator: 'equals', value: 'reference' },
    ] } })).json().items).toEqual([expect.objectContaining({ id: third.id })]);

    const savedPath = '/research/library/saved-searches';
    const saved = await post(savedPath, { id: id(), name: 'Advanced fixture', conditions });
    expect(saved.statusCode, saved.body).toBe(201);
    const savedId = saved.json().id;
    expect((await get(`${savedPath}/${savedId}`)).json().conditions).toEqual(conditions);
    const cleared = await patch(`${savedPath}/${savedId}`, { conditions: null }, '1');
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().conditions).toBeNull();
    const basic = await post(savedPath, { id: id(), name: 'Basic fixture', query: 'rings', conditions: null });
    expect(basic.statusCode, basic.body).toBe(201);
    expect(basic.json()).toMatchObject({ name: 'Basic fixture', query: 'rings', conditions: null });
  });

  it('searches live linked Knowledge note content with normalized advanced conditions', async () => {
    const token = id();
    const first = id(), second = id(), third = id();
    for (const [reference, title] of [[first, `Linked ${token}`], [second, `Theorem ${token}`], [third, `Unlinked ${token}`]])
      expect((await post('/research/references', { id: reference, title })).statusCode).toBe(201);
    const body = 'The GRÖBNER\n\t basis argument includes the literal characters % and _.';
    const note = { id: id(), link_id: id(), title: 'Research note', content: body };
    expect((await post(`/research/references/${first}/notes`, note)).statusCode).toBe(201);
    const theorem = (await post('/knowledge-items', { id: id(), title: 'Research theorem', content: body, type: 'theorem' })).json();
    expect((await post(`/research/references/${second}/knowledge-links`, { id: id(), knowledge_item_id: theorem.id })).statusCode).toBe(201);
    expect((await post('/knowledge-items', { id: id(), title: 'Unlinked matching note', content: body, type: 'note' })).statusCode).toBe(201);
    const match = { field: 'note_text', operator: 'contains', value: '  grobner   BASIS  ' };
    const search = (conditions: Record<string, unknown>) => post('/research/library/search', { q: token, conditions });
    expect((await search({ all: [{ field: 'source', operator: 'equals', value: 'reference' }, match] })).json().items)
      .toEqual([expect.objectContaining({ id: first })]);
    expect((await search({ not: match })).json().items.map((item: { id: string }) => item.id).sort()).toEqual([second, third].sort());
    expect((await search({ ...match, value: '%' })).json().items).toEqual([expect.objectContaining({ id: first })]);
    expect((await search({ ...match, value: "%' OR 1=1 --" })).json().items).toEqual([]);
    expect((await search({ ...match, operator: 'equals' })).statusCode).toBe(422);
    const saved = await post('/research/library/saved-searches', { id: id(), name: `Linked note ${token}`, conditions: match });
    expect(saved.statusCode).toBe(201);
    expect((await get(`/research/library/saved-searches/${saved.json().id}`)).json().conditions).toEqual(match);
    const remove = (path: string, version = '1') => app.inject({ method: 'DELETE', url: `/api/v1${path}`,
      headers: { 'If-Match': `"${version}"`, 'Idempotency-Key': id() } });
    expect((await remove(`/research/reference-knowledge-links/${note.link_id}`)).statusCode).toBe(204);
    expect((await search(match)).json().items).toEqual([]);
    expect((await post(`/research/references/${first}/knowledge-links`, { id: id(), knowledge_item_id: note.id })).statusCode).toBe(201);
    expect((await search(match)).json().items).toHaveLength(1);
    expect((await remove(`/knowledge-items/${note.id}`)).statusCode).toBe(204);
    expect((await search(match)).json().items).toEqual([]);
  });

  it('filters literature by identifiers and workspace-local calendar dates across midnight', async () => {
    const referenceId = id();
    const title = 'Calendar and identifier fixture';
    expect((await post('/research/references', { id: referenceId, title,
      publication: { pmcid: 'PMC1234567', issn: '1234-5679' },
    })).statusCode).toBe(201);
    const profile = (await get('/me')).json();
    expect((await patch('/me', { timezone: 'Europe/Budapest' }, profile.version)).statusCode).toBe(200);
    await db.transaction(app.prism.config.userId, (sql) => sql.query(`UPDATE research_references
      SET created_at='2025-12-31T23:30:00Z'::timestamptz, updated_at='2026-01-02T23:30:00Z'::timestamptz WHERE id=$1`, [referenceId]));
    const search = (condition: Record<string, unknown>) => post('/research/library/search', { q: title, conditions: condition });
    expect((await search({ all: [
      { field: 'date_added', operator: 'equals', value: '2026-01-01' },
      { field: 'date_modified', operator: 'gte', value: '2026-01-03' },
      { field: 'pmcid', operator: 'equals', value: 'pmc1234567' },
      { field: 'issn', operator: 'equals', value: '1234-5679' },
    ] })).json().items).toEqual([expect.objectContaining({ id: referenceId })]);
    expect((await search({ field: 'date_added', operator: 'lte', value: '2025-12-31' })).json().items).toEqual([]);
    expect((await search({ field: 'date_added', operator: 'equals', value: '2026-02-30' })).statusCode).toBe(422);
    expect((await get('/research/library?q=PMC1234567')).json().items).toEqual([expect.objectContaining({ id: referenceId })]);
    if (profile.timezone !== 'Europe/Budapest') {
      const changed = (await get('/me')).json();
      await patch('/me', { timezone: profile.timezone }, changed.version);
    }
  });

  it('publishes verified PDF attachments without exposing partial files or upload bytes', async () => {
    const original = (await post('/research/references', { id: id(), title: 'PDF fixture reference' })).json();
    const target = (await post('/research/references', { id: id(), title: 'PDF fixture merge target' })).json();
    const attachmentId = id();
    const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(524288), Buffer.from('\n%%EOF\n')]);
    const upload = {
      id: attachmentId, file_name: 'Épreuve λ.pdf', size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const begin = `/research/references/${original.id}/pdf`;
    const list = (referenceId: string) => `/research/references/${referenceId}/pdfs`;
    const base = `/research/reference-pdfs/${attachmentId}`;
    const send = (offset: number, data: string) => app.inject({
      method: 'PUT', url: '/api/v1' + base + '/chunk',
      headers: { 'Idempotency-Key': id() }, payload: { offset, data },
    });
    const started = await post(begin, upload);
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toMatchObject({ id: attachmentId, status: 'uploading', next_offset: 0, version: '1' });
    expect((await get(list(original.id))).json().items).toEqual([]);
    expect((await get(base + '/download')).statusCode).toBe(404);
    const readingPosition = base + '/reading-position';
    const setPage = (payload: { page: number; expected_version?: string | null }, key = id()) => app.inject({
      method: 'PUT', url: '/api/v1' + readingPosition, headers: { 'Idempotency-Key': key }, payload,
    });
    expect((await get(readingPosition)).statusCode).toBe(404);
    expect((await setPage({ page: 2 })).statusCode).toBe(404);
    const annotations = base + '/annotations';
    const annotationId = id();
    const annotation = {
      id: annotationId, page: 2, kind: 'highlight', color: 'green', text: 'Selected text',
      comment: 'Connection to proof', rects: [{ x: 0.2, y: 0.3, width: 0.4, height: 0.04 }],
    };
    expect((await post(annotations, annotation)).statusCode).toBe(404);
    const first = bytes.subarray(0, 524288).toString('base64');
    const last = bytes.subarray(524288).toString('base64');
    expect((await send(524288, last)).statusCode).toBe(409);
    expect((await send(0, first)).json()).toEqual({ next_offset: 524288 });
    expect((await send(0, first)).json()).toEqual({ next_offset: 524288 });
    expect((await send(0, last)).statusCode).toBe(409);
    expect((await post(base + '/complete', {})).statusCode).toBe(409);
    expect((await send(524288, last)).json()).toEqual({ next_offset: bytes.length });
    const ready = await post(base + '/complete', {});
    expect(ready.statusCode, ready.body).toBe(200);
    expect(ready.json()).toMatchObject({ id: attachmentId, status: 'ready', version: '2' });
    expect((await post(begin, { ...upload, id: id() })).json().id).toBe(attachmentId);
    const exportJob = await post('/exports', { formats: ['json', 'attachments'] });
    expect(exportJob.statusCode).toBe(202);
    await app.prism.service.processExports();
    const archivePath = `/exports/${exportJob.json().id}`;
    const exported = (await get(archivePath)).json();
    expect(exported.status, JSON.stringify(exported)).toBe('ready');
    const name = `attachments/${attachmentId}.pdf`;
    expect(exported.manifest.files).toContainEqual(expect.objectContaining({ path: name, sha256: upload.sha256 }));
    const archive = await get(archivePath + '/download');
    const { unzipSync } = createRequire(new URL('../../packages/core/package.json', import.meta.url))('fflate') as {
      unzipSync: (input: Uint8Array) => Record<string, Uint8Array>;
    };
    const files = unzipSync(archive.rawPayload);
    expect(Buffer.from(files[name])).toEqual(bytes);
    expect(JSON.parse(Buffer.from(files['attachments.json']).toString())).toContainEqual(expect.objectContaining({
      id: attachmentId, reference_id: original.id, sha256: upload.sha256, path: name,
    }));

    expect((await get(readingPosition)).json()).toEqual({ position: null });
    expect((await setPage({ page: 0 })).statusCode).toBe(422);
    const positionKey = id();
    const position = await setPage({ page: 2, expected_version: null }, positionKey);
    expect(position.statusCode).toBe(200);
    expect(await validateApiResponse('PUT', readingPosition, position.statusCode, position.json())).toEqual([]);
    expect(position.json()).toMatchObject({ position: { id: attachmentId, pdf_id: attachmentId, page: 2, version: '1' } });
    expect((await setPage({ page: 2, expected_version: null }, positionKey)).json()).toEqual(position.json());
    expect((await setPage({ page: 2 })).json()).toEqual(position.json());
    expect((await setPage({ page: 4, expected_version: null })).statusCode).toBe(412);
    expect((await setPage({ page: 3, expected_version: '1' })).json()).toMatchObject({ position: { page: 3, version: '2' } });
    expect((await get(readingPosition)).json()).toMatchObject({ position: { page: 3, version: '2' } });

    expect((await post(annotations, { ...annotation, rects: [{ x: 0.9, y: 0.3, width: 0.4, height: 0.04 }] })).statusCode).toBe(422);
    const createdAnnotation = await post(annotations, annotation);
    expect(createdAnnotation.statusCode, createdAnnotation.body).toBe(201);
    expect(createdAnnotation.json()).toMatchObject({ ...annotation, pdf_id: attachmentId, version: '1' });
    expect((await get(annotations + '?page=1')).json().items).toEqual([]);
    expect((await get(annotations + '?page=2')).json().items).toHaveLength(1);
    const edited = await patch(`/research/pdf-annotations/${annotationId}`, { color: 'blue', kind: 'underline' }, '1');
    expect(edited.json()).toMatchObject({ color: 'blue', kind: 'underline', version: '2' });
    expect((await patch(`/research/pdf-annotations/${annotationId}`, { comment: 'stale' }, '1')).statusCode).toBe(412);

    const stickyId = id();
    const sticky = {
      id: stickyId, page: 1, kind: 'note', color: 'pink', comment: 'Sticky note on a syzygy',
      rects: [{ x: 0.2, y: 0.3, width: 0.04, height: 0.04 }],
    };
    expect((await post(annotations, { ...sticky, comment: '   ' })).statusCode).toBe(422);
    expect((await post(annotations, { ...sticky, rects: [...sticky.rects, ...sticky.rects] })).statusCode).toBe(422);
    const stickyResult = await post(annotations, sticky);
    expect(stickyResult.statusCode, stickyResult.body).toBe(201);
    expect(stickyResult.json()).toMatchObject({ ...sticky, text: '', pdf_id: attachmentId, version: '1' });
    expect((await patch(`/research/pdf-annotations/${stickyId}`, { comment: '' }, '1')).statusCode).toBe(422);
    expect((await patch(`/research/pdf-annotations/${stickyId}`, { comment: 'Revised note on a syzygy' }, '1')).json()).toMatchObject({
      kind: 'note', comment: 'Revised note on a syzygy', version: '2',
    });
    expect((await get('/research/library/full-text?q=syzygy')).json().items).toEqual([
      expect.objectContaining({ annotation_id: stickyId, kind: 'annotation', page: 1 }),
    ]);

    const areaId = id();
    const areaPath = `/research/pdf-annotations/${areaId}`;
    const area = {
      id: areaId, page: 2, kind: 'area', color: 'green',
      rects: [{ x: 0.2, y: 0.3, width: 0.35, height: 0.2 }],
    };
    expect((await post(annotations, { ...area, rects: [...area.rects, ...area.rects] })).statusCode).toBe(422);
    const createdArea = await post(annotations, area);
    expect(createdArea.statusCode, createdArea.body).toBe(201);
    expect(createdArea.json()).toMatchObject({ ...area, comment: '', text: '', pdf_id: attachmentId, version: '1' });
    expect((await patch(areaPath, { rects: [...area.rects, ...area.rects] }, '1')).statusCode).toBe(422);
    expect((await patch(areaPath, { comment: 'Highlighted area depicts a monomial diagram' }, '1')).json())
      .toMatchObject({ kind: 'area', comment: 'Highlighted area depicts a monomial diagram', version: '2' });
    expect((await get('/research/library/full-text?q=monomial%20diagram')).json().items).toEqual([
      expect.objectContaining({ annotation_id: areaId, kind: 'annotation', page: 2 }),
    ]);

    const inkId = id();
    const ink = {
      ...area, id: inkId, kind: 'ink', color: 'purple', comment: 'A hand-drawn arrow',
      tags: ['Proof technique', 'proof technique', ' reread '],
      ink_path: [{ x: 0.21, y: 0.31 }, { x: 0.38, y: 0.43 }, { x: 0.52, y: 0.32 }],
    };
    expect((await post(annotations, { ...ink, ink_path: [{ x: 0.8, y: 0.4 }, ink.ink_path[0]] })).statusCode).toBe(422);
    expect((await post(annotations, { ...ink, kind: 'area' })).statusCode).toBe(422);
    const createdInk = await post(annotations, ink);
    expect(createdInk.statusCode, createdInk.body).toBe(201);
    expect(createdInk.json()).toMatchObject({ ...ink, tags: ['Proof technique', 'reread'] });
    expect((await patch(`/research/pdf-annotations/${inkId}`, { color: 'blue' }, '1')).json())
      .toMatchObject({ color: 'blue', ink_path: ink.ink_path, version: '2' });
    expect((await post('/research/library/search', { conditions: { field: 'annotation_tag', operator: 'equals', value: 'PROOF TECHNIQUE' } })).json().items)
      .toMatchObject([{ id: original.id }]);

    const index = base + '/text-index';
    expect((await get(index)).json()).toEqual({ status: 'missing', index_id: null, page_count: 0, next_page: 1, text_mode: null });
    const indexId = id();
    expect((await post(index, { index_id: indexId, page_count: 2 })).json()).toEqual({
      index_id: indexId, status: 'indexing', next_page: 1, page_count: 2, text_mode: 'embedded',
    });
    const put = (index_id: string, start_page: number, pages: string[], text_mode?: 'local-ocr') => app.inject({
      method: 'PUT', url: `/api/v1${index}/pages`,
      headers: { 'Idempotency-Key': id() }, payload: { index_id, start_page, pages, ...(text_mode && { text_mode }) },
    });
    expect((await post(index, { index_id: id(), page_count: 2, text_mode: 'local-ocr' })).statusCode).toBe(409);
    expect((await put(indexId, 2, ['Out of order'])).statusCode).toBe(409);
    const firstPage = 'Intro '.repeat(80) + 'The Bézout theorem connects graded ideals.';
    expect((await put(indexId, 1, [firstPage])).json()).toEqual({ next_page: 2 });
    expect((await put(indexId, 1, [firstPage])).json()).toEqual({ next_page: 2 });
    expect((await put(indexId, 1, ['Different content'])).statusCode).toBe(409);
    expect((await post(index + '/complete', { index_id: indexId })).statusCode).toBe(409);
    expect((await post(index, { index_id: id(), page_count: 2 })).json().index_id).toBe(indexId);
    expect((await get('/research/library/full-text?q=bezout')).json().items).toEqual([]);
    expect((await put(indexId, 2, ['A second Bézout result in commutative algebra.'])).json()).toEqual({ next_page: 3 });
    expect((await post(index + '/complete', { index_id: indexId })).json()).toMatchObject({
      status: 'ready', index_id: indexId, next_page: 3,
    });
    const search = '/research/library/full-text';
    const firstResult = (await get(search + '?q=BEZOUT&limit=1')).json();
    expect(firstResult.items).toEqual([expect.objectContaining({
      pdf_id: attachmentId, reference_id: original.id, page: 1, kind: 'page', format: 'pdf',
      snippet: expect.stringContaining('Bézout'), annotation_id: null,
    })]);
    expect(firstResult.next_cursor).toBeTruthy();
    expect((await get(search + '?q=bezout&limit=1&cursor=' + encodeURIComponent(firstResult.next_cursor))).json().items).toEqual([
      expect.objectContaining({ page: 2, pdf_id: attachmentId }),
    ]);
    expect((await get(search + '?q=unrelated&cursor=' + encodeURIComponent(firstResult.next_cursor))).statusCode).toBe(422);
    expect((await get(search + '?q=selected%20proof')).json().items).toEqual([
      expect.objectContaining({ page: 2, kind: 'annotation', annotation_id: annotationId }),
    ]);
    const rebuild = id();
    expect((await post(index, { index_id: rebuild, page_count: 1, text_mode: 'local-ocr' })).json())
      .toMatchObject({ status: 'indexing', text_mode: 'local-ocr' });
    expect((await get(index)).json()).toMatchObject({ index_id: rebuild, text_mode: 'local-ocr' });
    expect((await get(search + '?q=bezout')).json().items).toHaveLength(2);
    expect((await put(rebuild, 1, ['A plain fallback must not replace the scan text.'])).statusCode).toBe(409);
    expect((await put(rebuild, 1, ['A new Gröbner basis index.'], 'local-ocr')).json()).toEqual({ next_page: 2 });
    expect((await post(index + '/complete', { index_id: rebuild })).statusCode).toBe(409);
    expect((await post(index + '/complete', { index_id: rebuild, text_mode: 'local-ocr' })).statusCode).toBe(200);
    expect((await get(search + '?q=bezout')).json().items).toEqual([]);
    expect((await get(search + '?q=grobner')).json().items).toHaveLength(1);

    const advanced = await post('/research/library/search', { conditions: { all: [
      { field: 'attachment_format', operator: 'equals', value: 'pdf' },
      { field: 'attachment_text', operator: 'contains', value: 'grobner' },
      { field: 'annotation_comment', operator: 'contains', value: 'SYZYGY' },
      { field: 'annotation_color', operator: 'equals', value: 'pink' },
    ] } });
    expect(advanced.statusCode, advanced.body).toBe(200);
    expect(advanced.json().items).toEqual([expect.objectContaining({ id: original.id })]);

    const result = await get(base + '/download');
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toBe('application/pdf');
    expect(result.headers['content-disposition']).toContain("filename*=UTF-8''%C3%89preuve%20%CE%BB.pdf");
    expect(result.headers['cache-control']).toContain('no-store');
    expect(result.rawPayload.equals(bytes)).toBe(true);

    const device = (await post('/devices', { id: id(), name: 'PDF sync', platform: 'web' })).json();
    const snapshot = (await post('/sync/snapshots', { device_id: device.id })).json();
    const { records } = (await get(`/sync/snapshots/${snapshot.id}/records?limit=500`)).json();
    const syncPdf = records.find((record: { entity_id: string; entity_type: string }) =>
      record.entity_id === attachmentId && record.entity_type === 'research_reference_pdf');
    expect(records).toContainEqual(expect.objectContaining({
      entity_type: 'research_pdf_reading_position', entity_id: attachmentId,
      data: expect.objectContaining({ page: 3, version: '2' }),
    }));
    expect(syncPdf).toMatchObject({ entity_type: 'research_reference_pdf', data: { id: attachmentId, sha256: upload.sha256 } });
    expect(syncPdf.data).not.toHaveProperty('data');
    expect(records).toContainEqual(expect.objectContaining({
      entity_type: 'research_pdf_annotation', entity_id: annotationId,
      data: expect.objectContaining({ pdf_id: attachmentId, color: 'blue', kind: 'underline' }),
    }));
    expect(records).toContainEqual(expect.objectContaining({
      entity_type: 'research_pdf_annotation', entity_id: areaId,
      data: expect.objectContaining({ pdf_id: attachmentId, kind: 'area', rects: area.rects }),
    }));
    expect(records).toContainEqual(expect.objectContaining({
      entity_type: 'research_pdf_annotation', entity_id: inkId,
      data: expect.objectContaining({ pdf_id: attachmentId, kind: 'ink', ink_path: ink.ink_path, tags: ['Proof technique', 'reread'] }),
    }));
    await db.transaction(undefined, async (sql) => {
      const receipts = (await sql.query('SELECT response_body FROM api_idempotency')).rows;
      expect(JSON.stringify(receipts)).not.toContain(first);
    });

    const merge = await post('/research/library/merge', {
      target_id: target.id, target_version: target.version, sources: [{ id: original.id, version: original.version }],
    });
    expect(merge.statusCode).toBe(200);
    expect((await get(list(target.id))).json().items).toEqual([
      expect.objectContaining({ id: attachmentId, reference_id: target.id, version: '3' }),
    ]);
    expect((await get(annotations)).json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: annotationId, pdf_id: attachmentId, kind: 'underline' }),
      expect.objectContaining({ id: stickyId, pdf_id: attachmentId, kind: 'note' }),
      expect.objectContaining({ id: areaId, pdf_id: attachmentId, kind: 'area' }),
      expect.objectContaining({ id: inkId, pdf_id: attachmentId, kind: 'ink', ink_path: ink.ink_path }),
    ]));
    expect((await get(readingPosition)).json()).toMatchObject({ position: { page: 3, version: '2' } });
    expect((await get(search + '?q=grobner')).json().items).toEqual([
      expect.objectContaining({ reference_id: target.id, pdf_id: attachmentId }),
    ]);
    const rename = await patch(base, { file_name: 'Revised proof.pdf' }, '3');
    expect(rename.statusCode, rename.body).toBe(200);
    expect(rename.json()).toMatchObject({ id: attachmentId, file_name: 'Revised proof.pdf', version: '4', sha256: upload.sha256 });
    expect((await patch(base, { file_name: 'Another proof.pdf' }, '3')).statusCode).toBe(412);
    expect((await patch(base, { file_name: 'Revised proof' }, '4')).statusCode).toBe(422);
    expect((await patch(base, { file_name: 'Revised proof.pdf' }, '4')).json().version).toBe('4');
    const renamedDownload = await get(base + '/download');
    expect(renamedDownload.headers['content-disposition']).toContain('Revised%20proof.pdf');
    expect(renamedDownload.rawPayload.equals(bytes)).toBe(true);
    expect((await get(readingPosition)).json()).toMatchObject({ position: { page: 3, version: '2' } });
    expect((await get(annotations)).json().items).toContainEqual(expect.objectContaining({ id: annotationId }));
    const removed = await app.inject({
      method: 'DELETE', url: `/api/v1${base}`,
      headers: { 'Idempotency-Key': id(), 'If-Match': '"4"' },
    });
    expect(removed.statusCode).toBe(204);
    expect((await get(base + '/download')).statusCode).toBe(404);
    expect((await get(search + '?q=grobner')).json().items).toEqual([]);
    expect((await get(search + '?q=selected%20proof')).json().items).toEqual([]);
    expect((await get(readingPosition)).statusCode).toBe(404);
    expect((await setPage({ page: 5 })).statusCode).toBe(404);
    expect((await get(annotations)).statusCode).toBe(404);
    expect((await get(`/research/pdf-annotations/${annotationId}`)).statusCode).toBe(404);
    expect((await get(`/research/pdf-annotations/${stickyId}`)).statusCode).toBe(404);
    expect((await get(list(target.id))).json().items).toEqual([]);
  });

  it('keeps related references symmetric, versioned, and linked after canonical merge', async () => {
    const create = async (title: string) => (await post('/research/references', { id: id(), title })).json();
    const target = await create('Symmetric reference target');
    const source = await create('Symmetric reference source');
    const shared = await create('Symmetric shared neighbor');
    const moved = await create('Symmetric transferred neighbor');
    const related = (reference: string) => `/research/references/${reference}/related`;
    const add = (first: string, second: string) => post(related(first), { id: id(), reference_id: second });
    expect((await add(target.id, target.id)).statusCode).toBe(422);
    expect((await add(target.id, id())).statusCode).toBe(404);
    const original = await add(target.id, shared.id);
    expect(original.statusCode).toBe(201);
    expect(original.json()).toMatchObject({ reference_id: shared.id, version: '1' });
    expect((await add(shared.id, target.id)).statusCode).toBe(409);
    expect((await get(related(shared.id))).json().items).toEqual([
      expect.objectContaining({ id: original.json().id, reference_id: target.id }),
    ]);
    const shadow = await add(source.id, shared.id);
    const sourceOnly = await add(source.id, moved.id);
    const selfAfterMerge = await add(target.id, source.id);
    expect([shadow, sourceOnly, selfAfterMerge].map((r) => r.statusCode)).toEqual([201, 201, 201]);
    const first = (await get(related(target.id) + '?limit=1')).json();
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).toBeTruthy();
    expect((await get(related(shared.id) + '?cursor=' + encodeURIComponent(first.next_cursor))).statusCode).toBe(422);
    const before = (await get(`/graph?focus=reference:${target.id}&depth=1`)).json();
    expect(before.edges).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'related' })]));

    const merge = await post('/research/library/merge', {
      target_id: target.id, target_version: target.version, sources: [{ id: source.id, version: source.version }],
    });
    expect(merge.statusCode).toBe(200);
    const list = (await get(related(source.id))).json().items;
    expect(list).toHaveLength(2);
    expect(list).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: original.json().id, reference_id: shared.id, version: '1' }),
      expect.objectContaining({ id: sourceOnly.json().id, reference_id: moved.id, version: '2' }),
    ]));
    expect((await get(`/research/reference-relations/${shadow.json().id}`)).statusCode).toBe(404);
    expect((await get(`/research/reference-relations/${selfAfterMerge.json().id}`)).statusCode).toBe(404);
    const graph = (await get(`/graph?focus=reference:${moved.id}&depth=1`)).json();
    const pair = [`reference:${target.id}`, `reference:${moved.id}`].sort();
    expect(graph.edges).toContainEqual({ source: pair[0], target: pair[1], kind: 'related' });
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: `reference:${target.id}` }));

    const remove = (path: string, version: string) => app.inject({
      method: 'DELETE', url: `/api/v1${path}`,
      headers: { 'Idempotency-Key': id(), 'If-Match': `"${version}"` },
    });
    const linkPath = `/research/reference-relations/${sourceOnly.json().id}`;
    expect((await remove(linkPath, '1')).statusCode).toBe(412);
    expect((await remove(linkPath, '2')).statusCode).toBe(204);
    expect((await get(related(moved.id))).json().items).toEqual([]);
    expect((await remove(`/research/references/${shared.id}`, '1')).statusCode).toBe(204);
    expect((await get(related(target.id))).json().items).toEqual([]);
  });

  it('creates reference notes atomically and keeps Knowledge when links or references are removed', async () => {
    const target = (await post('/research/references', { id: id(), title: 'Linked Knowledge merge target' })).json();
    const source = (await post('/research/references', { id: id(), title: 'Linked Knowledge source' })).json();
    const linkPath = (reference: string) => `/research/references/${reference}/knowledge-links`;
    const notePath = `/research/references/${source.id}/notes`;
    const existing = (await post('/knowledge-items', {
      id: id(), title: 'An existing theorem', type: 'theorem', content: 'An existing mathematical statement.',
    })).json();
    const existingLink = (await post(linkPath(target.id), { id: id(), knowledge_item_id: existing.id })).json();
    expect(existingLink).toMatchObject({ reference_id: target.id, knowledge_item_id: existing.id, type: 'theorem', version: '1' });
    expect((await post(linkPath(target.id), { id: id(), knowledge_item_id: existing.id })).statusCode).toBe(409);
    expect((await post(linkPath(target.id), { id: id(), knowledge_item_id: id() })).statusCode).toBe(404);
    const duplicate = (await post(linkPath(source.id), { id: id(), knowledge_item_id: existing.id })).json();
    const note = {
      id: id(), link_id: id(), title: 'Reading notes', content: 'A Markdown note with $x$.', subject: 'Algebra',
      source_reference: `/research/library?reference=${source.id}`,
    };
    const invalid = { ...note, id: id(), link_id: existingLink.id };
    expect((await post(notePath, invalid)).statusCode).toBe(409);
    expect((await get(`/knowledge-items/${invalid.id}`)).statusCode).toBe(404);
    const key = id();
    const created = await post(notePath, note, key);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      knowledge: { id: note.id, type: 'note', content: note.content, source_reference: note.source_reference },
      link: { id: note.link_id, knowledge_item_id: note.id, reference_id: source.id, version: '1' },
    });
    expect((await post(notePath, note, key)).json()).toEqual(created.json());

    const graph = (await get(`/graph?focus=reference:${source.id}&depth=1`)).json();
    expect(graph.edges).toContainEqual({ source: `reference:${source.id}`, target: `knowledge:${note.id}`, kind: 'related' });
    const firstPage = (await get(linkPath(source.id) + '?limit=1')).json();
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.next_cursor).toBeTruthy();
    expect((await get(linkPath(target.id) + '?cursor=' + encodeURIComponent(firstPage.next_cursor))).statusCode).toBe(422);
    expect((await post('/research/library/merge', {
      target_id: target.id, target_version: target.version, sources: [{ id: source.id, version: source.version }],
    })).statusCode).toBe(200);
    const canonical = (await get(linkPath(source.id))).json().items;
    expect(canonical).toHaveLength(2);
    expect(canonical).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: existingLink.id, reference_id: target.id, version: '1' }),
      expect.objectContaining({ id: note.link_id, reference_id: target.id, version: '2' }),
    ]));
    expect((await get(`/research/reference-knowledge-links/${duplicate.id}`)).statusCode).toBe(404);
    const reverse = (await get(`/knowledge-items/${note.id}/reference-links`)).json().items;
    expect(reverse).toEqual([expect.objectContaining({
      id: note.link_id, knowledge_item_id: note.id, reference_id: target.id, title: target.title, version: '2',
    })]);
    expect((await get(`/knowledge-items/${id()}/reference-links`)).statusCode).toBe(404);
    const remove = (path: string, version: string) => app.inject({
      method: 'DELETE', url: `/api/v1${path}`,
      headers: { 'Idempotency-Key': id(), 'If-Match': `"${version}"` },
    });
    const createdLinkPath = `/research/reference-knowledge-links/${note.link_id}`;
    expect((await remove(createdLinkPath, '1')).statusCode).toBe(412);
    expect((await remove(createdLinkPath, '2')).statusCode).toBe(204);
    expect((await get(`/knowledge-items/${note.id}`)).statusCode).toBe(200);
    const relink = (await post(linkPath(target.id), { id: id(), knowledge_item_id: note.id })).json();
    expect((await remove(`/knowledge-items/${note.id}`, '1')).statusCode).toBe(204);
    expect((await get(`/research/reference-knowledge-links/${relink.id}`)).statusCode).toBe(404);
    expect((await remove(`/research/references/${target.id}`, '2')).statusCode).toBe(204);
    expect((await get(`/knowledge-items/${existing.id}`)).statusCode).toBe(200);
    expect((await get(`/research/reference-knowledge-links/${existingLink.id}`)).statusCode).toBe(404);
  });

  it('preserves question evidence across a reference merge and emits audit events for its lifecycle and links', async () => {
    const project = (await post('/research/projects', { id: id(), title: 'Question provenance fixture' })).json();
    const objects = `/research/projects/${project.id}/objects`;
    const create = (type: string) => post(objects, { id: id(), object_type: type, title: type, content: 'Fixture' });
    const question = (await create('question')).json();
    const attempt = (await create('proof_attempt')).json();
    expect(question.question_status).toBe('open');
    expect(attempt.question_status).toBeNull();
    expect((await get(`${objects}?object_type=question`)).json().items.map((row: { id: string }) => row.id)).toEqual([question.id]);

    const source = (await post('/research/references', { id: id(), title: 'Source fixture' })).json();
    const target = (await post('/research/references', { id: id(), title: 'Reference merge fixture' })).json();
    const attachment = id();
    const bytes = Buffer.from('%PDF-1.7\nQuestion evidence fixture\n%%EOF\n');
    const base = `/research/attachments/${attachment}`;
    const upload = await post(`/research/references/${source.id}/attachments`, {
      id: attachment, format: 'pdf', file_name: 'Source.pdf', size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(upload.statusCode, upload.body).toBe(200);
    const sent = await app.inject({ method: 'PUT', url: `/api/v1${base}/chunk`,
      headers: { 'Idempotency-Key': id() }, payload: { offset: 0, data: bytes.toString('base64') } });
    expect(sent.statusCode, sent.body).toBe(200);
    expect((await post(`${base}/complete`, {})).statusCode).toBe(200);

    const links = '/research/question-links';
    const sourceLink = { id: id(), question_id: question.id, relation_type: 'motivates',
      reference_id: source.id, attachment_id: attachment, page: 2, notes: '  Read the highlighted argument.  ' };
    const recordLink = { id: id(), question_id: question.id, relation_type: 'attempt', research_object_id: attempt.id };
    expect((await post(links, { ...sourceLink, reference_id: target.id })).statusCode).toBe(422);
    expect((await post(links, { ...sourceLink, attachment_id: null })).statusCode).toBe(422);
    expect((await post(links, { ...sourceLink, page: 0 })).statusCode).toBe(422);
    expect((await post(links, { ...recordLink, relation_type: 'result' })).statusCode).toBe(422);
    const savedSource = await post(links, sourceLink);
    expect(savedSource.statusCode, savedSource.body).toBe(201);
    expect(savedSource.json()).toMatchObject({ notes: sourceLink.notes.trim(), page: 2, attachment_id: attachment });
    expect((await post(links, { ...sourceLink, id: id() })).statusCode).toBe(409);
    expect((await post(links, recordLink)).statusCode).toBe(201);
    const byQuestion = `${links}?question_id=${question.id}`;
    const byRecord = `${links}?research_object_id=${attempt.id}`;
    expect((await get(byRecord)).json().items).toEqual([expect.objectContaining({
      id: recordLink.id, question_id: question.id, question_title: question.title, target_type: attempt.object_type,
    })]);
    const firstPage = (await get(`${byQuestion}&limit=1`)).json();
    expect(firstPage.items).toHaveLength(1);
    const secondPage = (await get(`${byQuestion}&limit=1&cursor=${encodeURIComponent(firstPage.next_cursor)}`)).json();
    expect([firstPage.items[0].id, secondPage.items[0].id].sort()).toEqual([sourceLink.id, recordLink.id].sort());

    const status = await patch(`/research/objects/${question.id}`, { base_snapshot: question, question_status: 'investigating' }, question.version);
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({ question_status: 'investigating', claim_status: 'needs_verification' });
    const merge = await post('/research/library/merge', {
      target_id: target.id, target_version: target.version, sources: [{ id: source.id, version: source.version }],
    });
    expect(merge.statusCode, merge.body).toBe(200);
    expect((await get(byQuestion)).json().items).toEqual(expect.arrayContaining([expect.objectContaining({
      id: sourceLink.id, reference_id: target.id, attachment_id: attachment, page: 2, target_title: target.title,
    })]));
    expect((await get(`${base}/download`)).rawPayload).toEqual(bytes);
    expect((await get(`/graph?focus=research:${question.id}&depth=1`)).json().edges).toEqual(expect.arrayContaining([
      { source: `research:${question.id}`, target: `reference:${target.id}`, kind: 'question_source' },
      { source: `research:${question.id}`, target: `research:${attempt.id}`, kind: 'question_record' },
    ]));

    const remove = await app.inject({ method: 'DELETE', url: `/api/v1${base}`,
      headers: { 'Idempotency-Key': id(), 'If-Match': '"3"' } });
    expect(remove.statusCode, remove.body).toBe(204);
    expect((await get(byQuestion)).json().items).toEqual([expect.objectContaining({ id: recordLink.id })]);
    expect((await get(`/research/projects/${project.id}/timeline?object_id=${question.id}`)).json().items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ event_type: 'question_status_changed', event_payload: expect.objectContaining({ question_status: 'investigating' }) }),
        expect.objectContaining({ event_type: 'question_link_removed', event_payload: expect.objectContaining({ link_id: sourceLink.id, page: 2 }) }),
      ]));
  });

  it('builds a bounded workspace graph from active records and explicit links owned by the user', async () => {
    const project = (await post('/research/projects', { id: id(), title: 'Graph research project' })).json();
    const createdObject = await post(`/research/projects/${project.id}/objects`, {
      id: id(),
      object_type: 'question',
      title: 'Graph research question',
      content: 'What relates these records?',
      claim_status: 'needs_verification',
    });
    expect(createdObject.statusCode, createdObject.body).toBe(201);
    const object = createdObject.json();
    const createNote = async (title: string) =>
      (await post('/knowledge-items', { id: id(), type: 'note', title, content: title })).json();
    const first = await createNote('Graph linked note');
    const second = await createNote('Graph neighboring note');
    const separate = await createNote('Graph standalone note');
    expect(
      (
        await post('/knowledge-relations', {
          id: id(),
          source_item_id: first.id,
          target_item_id: second.id,
          relation_type: 'depends_on',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await post('/research/knowledge-links', {
          id: id(),
          project_id: project.id,
          knowledge_item_id: first.id,
        })
      ).statusCode,
    ).toBe(201);
    const reference = (
      await post('/research/references', {
        id: id(),
        project_id: project.id,
        title: 'Graph project reference',
        doi: '10.1234/graph',
      })
    ).json();
    const linkedPaper = id(),
      savedPaper = id(),
      unownedPaper = id();
    await db.transaction(undefined, async (sql) => {
      for (const [paperId, arxivId] of [
        [linkedPaper, '2601.98761'],
        [savedPaper, '2601.98762'],
        [unownedPaper, '2601.98763'],
      ]) {
        await sql.query(
          `INSERT INTO arxiv_papers(id,arxiv_id,latest_version,title,authors,categories,published_at,updated_at,source_url,pdf_url)
           VALUES($1,$2,1,'Graph arXiv paper',ARRAY['Graph Author'],ARRAY['math.AC'],now(),now(),$3,$4)`,
          [paperId, arxivId, `https://arxiv.org/abs/${arxivId}`, `https://arxiv.org/pdf/${arxivId}`],
        );
      }
    });
    expect(
      (await post('/research/paper-links', { id: id(), project_id: project.id, paper_id: linkedPaper }))
        .statusCode,
    ).toBe(201);
    expect((await post(`/arxiv/papers/${savedPaper}/save`, {})).statusCode).toBe(200);
    const otherUser = id(),
      otherNote = id();
    await db.transaction(otherUser, async (sql) => {
      await sql.query('INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,$4)', [
        otherUser,
        otherUser,
        `graph-${otherUser}@example.test`,
        'Graph test user',
      ]);
      await sql.query(
        "INSERT INTO knowledge_items(id,user_id,title,type) VALUES($1,$2,'Another user note','note')",
        [otherNote, otherUser],
      );
      await sql.query('INSERT INTO user_papers(id,user_id,paper_id,is_saved) VALUES($1,$2,$3,true)', [
        id(),
        otherUser,
        unownedPaper,
      ]);
    });

    expect((await get('/research/library?q=Graph&native=true')).json().items).toEqual([
      expect.objectContaining({ id: reference.id, kind: 'reference' }),
    ]);
    const library = (await get('/research/library?q=Graph')).json();
    expect(library.items.map((item: { id: string }) => item.id).sort()).toEqual(
      [reference.id, linkedPaper, savedPaper].sort(),
    );
    expect(library.items.find((item: { id: string }) => item.id === linkedPaper).projects).toEqual([
      { id: project.id, title: project.title },
    ]);
    const firstPage = (await get('/research/library?q=Graph%20Author&limit=1')).json();
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.next_cursor).toBeTruthy();
    const secondPage = (await get(
      `/research/library?q=Graph%20Author&limit=1&cursor=${encodeURIComponent(firstPage.next_cursor)}`,
    )).json();
    expect(secondPage.items).toHaveLength(1);
    expect([firstPage.items[0].id, secondPage.items[0].id].sort()).toEqual([linkedPaper, savedPaper].sort());
    expect(secondPage.next_cursor).toBeNull();
    expect((await get(
      `/research/library?q=elsewhere&cursor=${encodeURIComponent(firstPage.next_cursor)}`,
    )).statusCode).toBe(422);

    const all = await get('/graph');
    expect(all.statusCode).toBe(200);
    expect(all.json().nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `knowledge:${separate.id}`, href: `/knowledge/${separate.id}` }),
        expect.objectContaining({ id: `paper:${savedPaper}`, href: 'https://arxiv.org/abs/2601.98762' }),
      ]),
    );
    expect(all.json().nodes.map((node: { id: string }) => node.id)).not.toContain(`knowledge:${otherNote}`);
    expect(all.json().nodes.map((node: { id: string }) => node.id)).not.toContain(`paper:${unownedPaper}`);
    expect((await get(`/graph?focus=knowledge:${otherNote}`)).statusCode).toBe(404);
    expect((await get('/graph?depth=4')).statusCode).toBe(422);

    const focus = `knowledge:${first.id}`;
    const nearest = (await get(`/graph?focus=${focus}&depth=1`)).json();
    expect(nearest.nodes.map((node: { id: string }) => node.id).sort()).toEqual(
      [focus, `knowledge:${second.id}`, `project:${project.id}`].sort(),
    );
    const neighborhood = (await get(`/graph?focus=${focus}&depth=2`)).json();
    expect(neighborhood.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `paper:${linkedPaper}` }),
        expect.objectContaining({
          id: `research:${object.id}`,
          href: `/research/${project.id}/questions/${object.id}`,
        }),
        expect.objectContaining({ id: `reference:${reference.id}`, href: 'https://doi.org/10.1234/graph' }),
      ]),
    );
    expect(neighborhood.edges).toEqual(
      expect.arrayContaining([
        { source: focus, target: `knowledge:${second.id}`, kind: 'depends_on' },
        { source: `project:${project.id}`, target: `paper:${linkedPaper}`, kind: 'project_paper' },
      ]),
    );
    const limited = (await get(`/graph?focus=${focus}&limit=1`)).json();
    expect(limited).toMatchObject({ nodes: [{ id: focus }], edges: [], truncated: true });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/research/references/${reference.id}`,
      headers: { 'Idempotency-Key': id(), 'If-Match': `"${reference.version}"` },
    });
    expect(removed.statusCode).toBe(204);
    const updated = (await get(`/graph?focus=project:${project.id}`)).json();
    expect(updated.nodes.map((node: { id: string }) => node.id)).not.toContain(`reference:${reference.id}`);
    expect(updated.edges.map((edge: { target: string }) => edge.target)).not.toContain(
      `reference:${reference.id}`,
    );
  });
  it('stores project bibliography entries, combines linked papers, and retains reference history', async () => {
    const project = (await post('/research/projects', { id: id(), title: 'Bibliography project' })).json();
    const other = (await post('/research/projects', { id: id(), title: 'Other bibliography' })).json();
    const reference = {
      id: id(),
      project_id: project.id,
      title: '  A reference  ',
      authors: ['  Example, Ada  '],
      doi: '10.1234/EXAMPLE',
      year: 2024,
      zotero_key: 'ABCD2345',
    };
    const saved = await post('/research/references', reference);
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({ title: 'A reference', authors: ['Example, Ada'], doi: '10.1234/example' });
    expect((await post('/research/references', { ...reference, id: id(), zotero_key: 'ZBCDE234' })).statusCode).toBe(409);
    expect((await post('/research/references', { ...reference, id: id(), project_id: other.id })).statusCode).toBe(201);
    expect((await post('/research/references', { ...reference, id: id(), url: 'javascript:alert(1)' })).statusCode).toBe(422);

    const paperId = id();
    const arxivId = '2401.12345';
    await db.transaction(undefined, (sql) =>
      sql.query(
        `INSERT INTO arxiv_papers(id,arxiv_id,latest_version,title,authors,categories,published_at,updated_at,source_url,pdf_url)
         VALUES($1,$2,1,'Linked paper',ARRAY['Example, Eli'],ARRAY['math.AC'],'2024-01-01','2024-01-01',$3,$4)`,
        [paperId, arxivId, `https://arxiv.org/abs/${arxivId}`, `https://arxiv.org/pdf/${arxivId}`],
      ),
    );
    expect((await post('/research/paper-links', { id: id(), project_id: project.id, paper_id: paperId })).statusCode).toBe(201);
    const bibliography = await get(`/research/projects/${project.id}/bibliography`);
    expect(bibliography.json().items).toMatchObject([
      { id: reference.id, title: 'A reference', kind: 'reference' },
      { title: 'Linked paper', arxiv_id: arxivId, year: 2024, kind: 'arxiv' },
    ]);
    expect((await get(`/research/projects/${other.id}/bibliography`)).json().items).toHaveLength(1);

    const deletion = await app.inject({
      method: 'DELETE',
      url: `/api/v1/research/projects/${project.id}`,
      headers: { 'Idempotency-Key': id(), 'If-Match': `"${project.version}"` },
    });
    expect(deletion.statusCode).toBe(204);
    expect((await get(`/research/projects/${project.id}/bibliography`)).statusCode).toBe(404);
    expect((await get(`/research/references/${reference.id}`)).statusCode).toBe(404);
    expect((await get(`/research/projects/${other.id}/bibliography`)).json().items).toHaveLength(1);
  });
  it('scopes knowledge and due cards to the current parent subject and chapter range', async () => {
    const subject = 'Advanced Abstract Algebra';
    const path = '/knowledge-items';
    const create = async (title: string, course: string, tags: string[]) => {
      const note = (
        await post(path, { id: id(), title, type: 'definition', content: title, subject: course, tags })
      ).json();
      const card = (
        await post(`${path}/${note.id}/cards`, {
          id: id(),
          card_type: 'statement',
          prompt: `Define ${title}`,
          answer: title,
        })
      ).json();
      return { note, card };
    };
    const first = await create('Normal extension', subject, [
      'chapter: 3\u00a0',
      'chapter-title: Normality ',
    ]);
    const second = await create('Splitting field', subject, ['chapter:7']);
    const unassigned = await create('Open note', '', ['chapter:03', 'chapter:3']);
    expect((await get('/knowledge-subjects')).json().items).toEqual(expect.arrayContaining(['', subject]));
    const query = `subject=${encodeURIComponent(subject)}`;
    expect((await get(`/knowledge-chapters?${query}`)).json().items).toEqual([
      { number: 3, title: 'Normality' },
      { number: 7, title: '' },
    ]);
    expect((await get('/knowledge-chapters?subject=')).json().items).toEqual([]);
    expect((await get('/knowledge-chapters')).statusCode).toBe(422);
    expect(
      (await get(`${path}?${query}`))
        .json()
        .items.map((item: any) => item.id)
        .sort(),
    ).toEqual([first.note.id, second.note.id].sort());
    expect((await get(`${path}?subject=`)).json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: unassigned.note.id })]),
    );
    const range = `${query}&chapter_from=3&chapter_to=7`;
    expect((await get(`${path}?${query}&chapter_from=3&chapter_to=3`)).json().items).toMatchObject([
      { id: first.note.id },
    ]);
    expect((await get(`${path}?subject=&chapter_to=3`)).json().items).toEqual([]);
    expect((await get(`${path}?${query}&chapter_from=8&chapter_to=3`)).statusCode).toBe(422);
    expect((await get(`/review/queue?${query}&chapter_from=0`)).statusCode).toBe(422);
    expect((await get(`/review/queue?${query}&chapter_from=7`)).json().items).toMatchObject([
      { id: second.card.id },
    ]);
    const page = (await get(`/review/queue?${range}&limit=1`)).json();
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBeTruthy();
    const cursor = encodeURIComponent(page.next_cursor);
    const next = (await get(`/review/queue?${range}&limit=1&cursor=${cursor}`)).json();
    expect([...page.items, ...next.items].map((card) => card.id).sort()).toEqual(
      [first.card.id, second.card.id].sort(),
    );
    expect((await get(`/review/queue?subject=&cursor=${cursor}`)).statusCode).toBe(422);
    expect(
      (await get(`/review/queue?${query}&chapter_from=4&chapter_to=7&cursor=${cursor}`)).statusCode,
    ).toBe(422);
    expect(
      (
        await patch(
          `${path}/${second.note.id}`,
          { subject: '', base_snapshot: second.note },
          second.note.version,
        )
      ).statusCode,
    ).toBe(200);
    expect((await get(`/review/queue?${query}`)).json().items).toMatchObject([{ id: first.card.id }]);
    const nowUnassigned = (await get('/review/queue?subject=')).json().items;
    expect(nowUnassigned).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: second.card.id,
          version: second.card.version,
          due_at: second.card.due_at,
        }),
        expect.objectContaining({ id: unassigned.card.id }),
      ]),
    );
  });
  it('keeps arXiv rounds across refreshes and adds more only after a completed round', async () => {
    const subscription = await post('/arxiv/subscriptions', {
      id: id(),
      subscription_type: 'category',
      subscription_value: 'math.AG',
    });
    expect(subscription.statusCode).toBe(201);
    const now = new Date().toISOString();
    const papers = [
      'Syzygies of projective curves',
      'Derived stacks and gerbes',
      'Toric degenerations of flags',
      'Moduli of stable sheaves',
      'Motives of K3 surfaces',
      'Frobenius splitting of divisors',
      'Quantum cohomology of Grassmannians',
      'Rational points on elliptic fibrations',
    ].map((title, index) => {
      const arxivId = `2611.9100${index}`;
      return {
        arxiv_id: arxivId,
        latest_version: 1,
        title,
        abstract: title,
        authors: ['For You fixture'],
        categories: ['math.AG'],
        published_at: now,
        updated_at: now,
        source_url: `https://arxiv.org/abs/${arxivId}`,
        pdf_url: `https://arxiv.org/pdf/${arxivId}`,
      };
    });
    await app.prism.service.ingestPapers(app.prism.config.userId, papers, id());
    expect(
      (await post('/arxiv/for-you/keywords', { term: '  Graded   Betti Numbers  ', mode: 'follow' }))
        .statusCode,
    ).toBe(204);
    const [first, concurrent] = await Promise.all([get('/arxiv/for-you'), get('/arxiv/for-you')]);
    expect(first.statusCode, first.body).toBe(200);
    const deck = first.json();
    expect(deck.items).toHaveLength(6);
    expect(deck).toMatchObject({ round: 1, can_review_more: false });
    expect(concurrent.json()).toEqual(deck);
    expect(deck.keywords).toEqual([{ term: 'graded betti numbers', mode: 'follow' }]);
    const [saved, declined] = deck.items.map((item: any) => item.paper.paper_id);
    const more = { date: deck.date, round: 1 };
    expect((await post('/arxiv/for-you/more', more)).statusCode).toBe(409);
    const receipt = id();
    expect(
      (await post('/arxiv/for-you/reaction', { paper_id: saved, action: 'save' }, receipt)).statusCode,
    ).toBe(204);
    expect(
      (await post('/arxiv/for-you/reaction', { paper_id: saved, action: 'save' }, receipt)).statusCode,
    ).toBe(204);
    expect(
      (await post('/arxiv/for-you/reaction', { paper_id: declined, action: 'not_interested' })).statusCode,
    ).toBe(204);
    expect((await post('/arxiv/for-you/reaction', { paper_id: declined, action: 'liked' })).statusCode).toBe(
      204,
    );
    expect(
      (await post('/arxiv/for-you/keywords', { term: 'Graded Betti Numbers', mode: 'less' })).statusCode,
    ).toBe(204);
    const sameDay = (await get('/arxiv/for-you')).json();
    const deckIds = deck.items.map((item: any) => item.paper.paper_id);
    expect(sameDay.items.map((item: any) => item.paper.paper_id)).toEqual(deckIds);
    expect(sameDay.items[0]).toMatchObject({ done: true, paper: { is_saved: true } });
    expect(sameDay.items[1]).toMatchObject({ done: true, reaction: 'not_interested' });
    expect(sameDay.keywords).toEqual([{ term: 'graded betti numbers', mode: 'less' }]);
    const feed = (await get('/arxiv/feed')).json();
    expect(feed.items.find((item: any) => item.paper_id === declined)).toMatchObject({ status: 'unread' });
    expect(feed.items.find((item: any) => item.paper_id === saved)).toMatchObject({ is_saved: true });

    const device = (await post('/devices', { id: id(), name: 'Explore sync', platform: 'ios' })).json();
    const snapshot = (await post('/sync/snapshots', { device_id: device.id })).json();
    const syncPage = (await get(`/sync/snapshots/${snapshot.id}/records`)).json();
    const [liked, alsoLiked, interested, skipped] = deckIds.slice(2);
    for (const [paper_id, action] of [
      [liked, 'liked'],
      [alsoLiked, 'liked'],
      [interested, 'interested'],
      [skipped, 'skip'],
    ]) {
      expect((await post('/arxiv/for-you/reaction', { paper_id, action })).statusCode).toBe(204);
    }
    const changes = (
      await get('/sync/pull?cursor=' + encodeURIComponent(syncPage.resume_sync_cursor))
    ).json();
    expect(changes.batches.flatMap((batch: any) => batch.changes)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity_type: 'user_paper',
          data: expect.objectContaining({ paper_id: liked, for_you_reaction: 'liked' }),
        }),
        expect.objectContaining({
          entity_type: 'user_paper',
          data: expect.objectContaining({ paper_id: interested, for_you_reaction: 'interested' }),
        }),
      ]),
    );
    expect((await post(`/arxiv/papers/${liked}/mark-read`, {})).statusCode).toBe(200);
    expect((await post(`/arxiv/papers/${liked}/save`, {})).statusCode).toBe(200);
    const firstLiked = (await get('/arxiv/feed?reaction=liked&limit=1')).json();
    expect(firstLiked.items).toHaveLength(1);
    expect(firstLiked.next_cursor).toBeTruthy();
    const cursor = encodeURIComponent(firstLiked.next_cursor);
    const nextLiked = (await get(`/arxiv/feed?reaction=liked&limit=1&cursor=${cursor}`)).json();
    expect(nextLiked.items).toHaveLength(1);
    expect(nextLiked.next_cursor).toBeNull();
    const likedItems = [...firstLiked.items, ...nextLiked.items];
    expect(likedItems.map((item) => item.paper_id).sort()).toEqual([liked, alsoLiked].sort());
    const laterPaper = nextLiked.items[0];
    const search = encodeURIComponent(laterPaper.paper.arxiv_id);
    const folderIds = encodeURIComponent(likedItems.map((item) => item.id).join(','));
    const matching = (await get(`/arxiv/feed?reaction=liked&limit=1&q=${search}&ids=${folderIds}`)).json();
    expect(matching.items.map((item: any) => item.id)).toEqual([laterPaper.id]);
    expect(matching.next_cursor).toBeNull();
    expect((await get(`/arxiv/feed?reaction=liked&q=${search}&ids=${firstLiked.items[0].id}`)).json().items).toEqual([]);
    expect((await get(`/arxiv/feed?reaction=liked&q=${search}&cursor=${cursor}`)).statusCode).toBe(422);
    expect(likedItems.find((item) => item.paper_id === liked)).toMatchObject({
      for_you_reaction: 'liked',
      status: 'read',
      is_saved: true,
    });
    const interestedFeed = (await get('/arxiv/feed?reaction=interested')).json();
    expect(interestedFeed.items).toMatchObject([{ paper_id: interested, for_you_reaction: 'interested' }]);
    expect((await get(`/arxiv/feed?reaction=interested&cursor=${cursor}`)).statusCode).toBe(422);
    expect((await get('/arxiv/feed?reaction=skip')).statusCode).toBe(422);
    const completed = (await get('/arxiv/for-you')).json();
    expect(completed).toMatchObject({ round: 1, can_review_more: true });
    const extraRoundKey = id();
    const requested = await Promise.all([
      post('/arxiv/for-you/more', more, extraRoundKey),
      post('/arxiv/for-you/more', more),
    ]);
    expect(requested.map((result) => result.statusCode)).toEqual([204, 204]);
    expect((await post('/arxiv/for-you/more', more, extraRoundKey)).statusCode).toBe(204);
    const extra = (await get('/arxiv/for-you')).json();
    expect(extra).toMatchObject({ round: 2, can_review_more: false });
    expect(extra.items).toHaveLength(2);
    const extraIds = extra.items.map((item: any) => item.paper.paper_id);
    expect(extraIds.every((paperId: string) => !deckIds.includes(paperId))).toBe(true);
    for (const paperId of extraIds) {
      expect((await post('/arxiv/for-you/reaction', { paper_id: paperId, action: 'skip' })).statusCode).toBe(
        204,
      );
    }
    expect((await post('/arxiv/for-you/more', { date: deck.date, round: 2 })).statusCode).toBe(204);
    expect((await get('/arxiv/for-you')).json()).toMatchObject({ round: 2, can_review_more: false });

    await db.transaction(app.prism.config.userId, (sql) =>
      sql.query('UPDATE user_papers SET for_you_day=for_you_day-1 WHERE for_you_day=$1', [deck.date]),
    );
    const nextDay = (await get('/arxiv/for-you')).json();
    expect(nextDay).toMatchObject({ items: [], round: 0, can_review_more: false });
    expect(
      (await post('/arxiv/for-you/keywords', { term: 'graded betti numbers', mode: 'remove' })).statusCode,
    ).toBe(204);
    expect((await get('/arxiv/for-you')).json().keywords).toEqual([]);
    const rule = subscription.json();
    expect(
      (await patch(`/arxiv/subscriptions/${rule.id}`, { enabled: false }, rule.version)).statusCode,
    ).toBe(200);
  });
  it('preserves concurrent mathematical edits for explicit merge', async () => {
    const note = (
      await post('/knowledge-items', {
        id: id(),
        title: 'Concurrent theorem',
        type: 'theorem',
        content: 'Original',
      })
    ).json();
    const first = await patch(
      '/knowledge-items/' + note.id,
      { content: 'Version A', base_snapshot: note },
      note.version,
    );
    expect(first.statusCode, first.body).toBe(200);
    const stale = await patch(
      '/knowledge-items/' + note.id,
      { content: 'Version B', base_snapshot: note },
      note.version,
    );
    expect(stale.statusCode, stale.body).toBe(412);
    expect(stale.json().error.details.conflict_id).toBeTruthy();
    const conflict = (await get('/sync/conflicts/' + stale.json().error.details.conflict_id)).json();
    expect(conflict.base_payload.content).toBe('Original');
    expect(conflict.client_payload.content).toBe('Version B');
    expect(conflict.server_payload.content).toBe('Version A');
  });
  it('runs independent FSRS cards and exactly-once replay under duplicate concurrency', async () => {
    const k = await post('/knowledge-items', {
      id: id(),
      title: 'Nakayama lemma',
      type: 'lemma',
      content: 'M = IM implies M = 0 under the hypotheses.',
    });
    expect(k.statusCode, k.body).toBe(201);
    const item = k.json();
    const c1 = (
      await post(`/knowledge-items/${item.id}/cards`, {
        id: id(),
        card_type: 'statement',
        prompt: 'State',
        answer: 'Statement',
      })
    ).json();
    const c2 = (
      await post(`/knowledge-items/${item.id}/cards`, {
        id: id(),
        card_type: 'proof',
        prompt: 'Prove',
        answer: 'Proof',
      })
    ).json();
    expect(c1.fsrs_state).toBeTruthy();
    const device = (await post('/devices', { id: id(), name: 'Test phone', platform: 'ios' })).json();
    const key = id();
    const rating = {
      card_id: c1.id,
      device_id: device.id,
      rating: 'good',
      reviewed_at: new Date(Date.now() + 10).toISOString(),
      duration_ms: 2000,
      base_version: c1.version,
      idempotency_key: key,
    };
    const { timezone } = (await get('/me')).json();
    const dashboardDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(rating.reviewed_at));
    const dashboard = '/today?date=' + dashboardDate;
    const before = (await get(dashboard)).json().review_activity;
    expect(before).toHaveLength(7);
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post('/review/events', rating, key)),
    );
    for (const r of responses) expect(r.statusCode, r.body).toBe(201);
    expect(new Set(responses.map((r) => r.json().event.id)).size).toBe(1);
    expect((await get(`/review/cards/${c2.id}`)).json().version).toBe(c2.version);
    expect((await get(`/review/history?card_id=${c1.id}`)).json().items).toHaveLength(1);
    const staleKey = id();
    const stale = await post('/review/events', { ...rating, idempotency_key: staleKey }, staleKey);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.details.conflict_id).toBeTruthy();
    expect((await get(`/review/history?card_id=${c1.id}`)).json().items).toHaveLength(1);
    const changed = await post('/review/events', { ...rating, rating: 'easy' }, key);
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await get(dashboard)).json().review_activity).toEqual([
      ...before.slice(0, -1),
      { date: dashboardDate, count: before.at(-1).count + 1 },
    ]);
  });
  it('stores ordered proof hints and immutable stuck-step snapshots with the review', async () => {
    const note = (
      await post('/knowledge-items', {
        id: id(),
        type: 'theorem',
        title: 'Uniqueness of an identity',
        content: 'An identity is unique.',
      })
    ).json();
    const cards = `/knowledge-items/${note.id}/cards`;
    const input = {
      id: id(),
      card_type: 'proof',
      prompt: 'Prove uniqueness.',
      answer: 'Compare the two identities by multiplying them.',
    };
    const steps = [
      { id: id(), hint: 'Let both elements be identities.' },
      { id: id(), hint: 'Compute their product in two ways.' },
    ];
    expect((await post(cards, { ...input, card_type: 'statement', proof_steps: steps })).statusCode).toBe(
      422,
    );
    expect((await post(cards, { ...input, proof_steps: [steps[0], steps[0]] })).statusCode).toBe(422);
    const created = await post(cards, { ...input, proof_steps: steps });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().proof_steps).toEqual(steps);
    const card = `/review/cards/${input.id}`;
    const edited = await patch(card, { prompt: 'Show the identity is unique.' }, created.json().version);
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().proof_steps).toEqual(steps);
    const device = (await post('/devices', { id: id(), name: 'Proof Recall', platform: 'web' })).json();
    const key = id();
    const request = {
      card_id: input.id,
      device_id: device.id,
      rating: 'hard',
      reviewed_at: new Date().toISOString(),
      duration_ms: 2000,
      base_version: edited.json().version,
      idempotency_key: key,
      proof_stuck_step_ids: [steps[1].id],
    };
    const invalidKey = id();
    expect(
      (
        await post(
          '/review/events',
          { ...request, idempotency_key: invalidKey, proof_stuck_step_ids: [id()] },
          invalidKey,
        )
      ).statusCode,
    ).toBe(422);
    const reviewed = await post('/review/events', request, key);
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    const result = reviewed.json();
    expect(result.event.proof_stuck_steps).toEqual([steps[1]]);
    expect((await post('/review/events', request, key)).json().event.id).toBe(result.event.id);
    const changedType = await patch(card, { card_type: 'statement' }, result.card.version);
    expect(changedType.statusCode, changedType.body).toBe(200);
    expect(changedType.json().proof_steps).toEqual([]);
    const history = (await get(`/review/history?card_id=${input.id}`)).json().items;
    expect(history).toMatchObject([{ id: result.event.id, proof_stuck_steps: [steps[1]] }]);
  });
  it('preserves mathematical claim status when completing linked task and audits changes', async () => {
    const project = (await post('/research/projects', { id: id(), title: 'Strong Persistence' })).json();
    const object = (
      await post(`/research/projects/${project.id}/objects`, {
        id: id(),
        object_type: 'conjecture',
        title: 'Claim',
        content: '...',
        claim_status: 'conjecture',
      })
    ).json();
    const task = (
      await post('/tasks', {
        id: id(),
        title: 'Try a proof',
        source_type: 'research',
        project_id: project.id,
        research_object_id: object.id,
        estimated_minutes: 25,
      })
    ).json();
    const done = await post(
      `/tasks/${task.id}/complete`,
      { completed_at: new Date().toISOString() },
      id(),
      task.version,
    );
    expect(done.statusCode, done.body).toBe(200);
    expect((await get(`/research/objects/${object.id}`)).json().claim_status).toBe('conjecture');
    expect(
      (await get(`/research/projects/${project.id}/timeline`)).json().items.length,
    ).toBeGreaterThanOrEqual(2);
    const invalid = await patch(
      `/research/objects/${object.id}`,
      { claim_status: 'proved', base_snapshot: object },
      object.version,
    );
    expect(invalid.statusCode).toBe(422);
  });
  it('logs normalized strength/cardio records and preserves completed workout history', async () => {
    const exercise = (
      await post('/fitness/exercises', {
        id: id(),
        name: 'Bench press',
        exercise_type: 'strength',
        measurement_unit: 'kg',
      })
    ).json();
    const template = (
      await post('/fitness/templates', {
        id: id(),
        title: 'Upper',
        activity_type: 'strength',
        exercises: [{ id: id(), exercise_id: exercise.id, position: 0, target_sets: 3, target_reps: 5 }],
      })
    ).json();
    const started = await post('/fitness/sessions', {
      id: id(),
      template_id: template.id,
      started_at: new Date().toISOString(),
    });
    expect(started.statusCode, started.body).toBe(201);
    const session = started.json();
    expect(session.exercises).toHaveLength(1);
    const set = await post(`/fitness/sessions/${session.id}/sets`, {
      id: id(),
      session_exercise_id: session.exercises[0].id,
      set_order: 0,
      entered_weight: 100,
      entered_weight_unit: 'lb',
      reps: 5,
      completed_at: new Date().toISOString(),
    });
    expect(set.statusCode, set.body).toBe(201);
    expect(set.json().weight_kg).toBeCloseTo(45.359237);
    const cardio = await post(`/fitness/sessions/${session.id}/cardio`, {
      id: id(),
      activity_type: 'Run',
      duration_seconds: 600,
      distance: 1,
      distance_unit: 'mi',
    });
    expect(cardio.statusCode, cardio.body).toBe(201);
    expect(cardio.json().distance_meters).toBe(1609.344);
    const current = (await get(`/fitness/sessions/${session.id}`)).json();
    const completed = await post(
      `/fitness/sessions/${session.id}/complete`,
      { ended_at: new Date().toISOString() },
      id(),
      current.version,
    );
    expect(completed.statusCode, completed.body).toBe(200);
    const edited = await patch(`/fitness/sets/${set.json().id}`, { reps: 6 }, set.json().version);
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await get(`/fitness/sessions/${session.id}`)).json().volume_kg_reps).toBeCloseTo(45.359237 * 6);
  });
  it('preserves DATE-only values and microsecond-safe pagination', async () => {
    const date = '2026-11-08',
      project = await post('/research/projects', { id: id(), title: 'Date-only', started_at: date });
    expect(project.json().started_at).toBe(date);
    const task = (
      await post('/tasks', {
        id: id(),
        title: 'Ordinary planned task',
        source_type: 'general',
        planned_date: date,
        estimated_minutes: 5,
      })
    ).json();
    const plan = await post('/daily-plans/generate', {
      plan_date: date,
      timezone: 'Europe/Budapest',
      as_of: '2026-11-08T10:00:00Z',
      capacity_minutes: 1440,
    });
    expect(plan.json().items.some((x: any) => x.task_id === task.id && x.status === 'planned')).toBe(true);
    const label = 'pagination-' + id(),
      ids: string[] = [];
    for (let n = 0; n < 3; n++) {
      const note = (
        await post('/knowledge-items', { id: id(), title: label, type: 'note', content: 'Page' })
      ).json();
      ids.push(note.id);
      await db.transaction(app.prism.config.userId, (sql) =>
        sql.query(
          "UPDATE knowledge_items SET created_at='2026-11-08T00:00:00.123456Z'::timestamptz+($2*interval '1 microsecond') WHERE id=$1",
          [note.id, n],
        ),
      );
    }
    const found: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: { id: string }[]; next_cursor: string | null } = (
        await get(
          '/knowledge-items?limit=1&q=' + label + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        )
      ).json();
      found.push(...page.items.map((x: any) => x.id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(new Set(found)).toEqual(new Set(ids));
  });
  it('generates a capacity-aware plan and preserves pinned tasks', async () => {
    await post('/tasks', {
      id: id(),
      title: 'Pinned research',
      source_type: 'general',
      estimated_minutes: 120,
      pinned: true,
    });
    const date = '2026-11-08';
    const plan = await post('/daily-plans/generate', {
      plan_date: date,
      timezone: 'Europe/Budapest',
      as_of: '2026-11-08T10:00:00Z',
      capacity_minutes: 15,
    });
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.json().overload_minutes).toBeGreaterThan(0);
    expect(plan.json().items.some((x: any) => x.pinned)).toBe(true);
    expect((await get('/today?date=' + date)).statusCode).toBe(200);
  });
  it('keeps legacy workout tasks out of current plans without removing their records', async () => {
    const date = '2026-11-09';
    const template = (
      await post('/fitness/templates', { id: id(), title: 'Legacy recovery', activity_type: 'recovery' })
    ).json();
    const workout = (
      await post('/tasks', {
        id: id(),
        title: 'Legacy workout task',
        source_type: 'workout',
        workout_template_id: template.id,
        planned_date: date,
        estimated_minutes: 90,
        pinned: true,
      })
    ).json();
    expect(workout.id).toBeTruthy();
    const request = {
      plan_date: date,
      timezone: 'Europe/Budapest',
      as_of: '2026-11-09T10:00:00Z',
      capacity_minutes: 180,
    };
    const generated = await post('/daily-plans/generate', request);
    expect(generated.statusCode, generated.body).toBe(200);
    const plan = generated.json();
    expect(plan.items.length).toBeGreaterThan(1);
    expect(plan.items.map((item: any) => item.task_id)).not.toContain(workout.id);
    await db.transaction(app.prism.config.userId, (sql) =>
      sql.query(
        "INSERT INTO daily_plan_items (id, user_id, daily_plan_id, task_id, item_type, position, title_snapshot, scheduled_minutes, pinned, priority_reason) VALUES ($1,$2,$3,$4,'task',$5,'Legacy workout task',90,true,'Pinned')",
        [id(), app.prism.config.userId, plan.id, workout.id, plan.items.length],
      ),
    );
    const today = (await get('/today?date=' + date)).json();
    expect(today.plan.items.map((item: any) => item.id)).toEqual(plan.items.map((item: any) => item.id));
    const reversed = today.plan.items.map((item: any) => item.id).reverse();
    const reordered = await post(
      '/daily-plans/' + plan.id + '/reorder',
      { item_ids: reversed },
      id(),
      plan.version,
    );
    expect(reordered.statusCode, reordered.body).toBe(200);
    const current = (await get('/today?date=' + date)).json();
    expect(current.plan.items.map((item: any) => item.id)).toEqual(reversed);
    expect((await get('/tasks/' + workout.id)).json().id).toBe(workout.id);
  });
  it('creates an atomic snapshot and syncs offline capture without duplicate entities', async () => {
    const device = (await post('/devices', { id: id(), name: 'Offline phone', platform: 'ios' })).json();
    const snapshot = await post('/sync/snapshots', { device_id: device.id });
    expect(snapshot.statusCode, snapshot.body).toBe(201);
    const page = (await get(`/sync/snapshots/${snapshot.json().id}/records`)).json();
    expect(page.resume_sync_cursor).toBeTruthy();
    const captureId = id(),
      operation = id();
    const batch = {
      device_id: device.id,
      operations: [
        {
          client_operation_id: operation,
          entity_id: captureId,
          operation: 'inbox.create',
          payload: { id: captureId, content: 'Offline observation' },
        },
      ],
    };
    const first = await post('/sync/push', batch);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().results[0].status).toBe('applied');
    const again = await post('/sync/push', batch);
    expect(again.json().results[0].status).toBe('duplicate');
    const changes = await get('/sync/pull?cursor=' + encodeURIComponent(page.resume_sync_cursor));
    expect(changes.statusCode, changes.body).toBe(200);
    expect(
      changes.json().batches.some((b: any) => b.changes.some((x: any) => x.entity_id === captureId)),
    ).toBe(true);
  });
  it('shares permanent receipts and dependency proofs across REST and sync transports', async () => {
    const device = (await post('/devices', { id: id(), name: 'Mixed transport', platform: 'ios' })).json();
    const key = id(),
      noteId = id(),
      payload = { id: noteId, title: 'Mixed transport note', type: 'note', content: 'Original' };
    const note = (await post('/knowledge-items', payload, key)).json();
    const update = id();
    const result = await post('/sync/push', {
      device_id: device.id,
      operations: [
        {
          client_operation_id: update,
          entity_id: noteId,
          operation: 'knowledge.update',
          base_version: note.version,
          depends_on_operation_id: key,
          payload: { content: 'After sync', base_snapshot: note },
        },
        { client_operation_id: key, entity_id: noteId, operation: 'knowledge.create', payload },
      ],
    });
    expect(result.json().results.find((x: any) => x.client_operation_id === key).status, result.body).toBe(
      'duplicate',
    );
    expect(result.json().results.find((x: any) => x.client_operation_id === update).status, result.body).toBe(
      'applied',
    );
    expect((await get('/knowledge-items/' + noteId)).json().content).toBe('After sync');
    const parent = id(),
      second = (
        await post(
          '/knowledge-items',
          { id: id(), title: 'Direct dependency', type: 'note', content: 'Before' },
          parent,
        )
      ).json();
    const onlyChild = await post('/sync/push', {
      device_id: device.id,
      operations: [
        {
          client_operation_id: id(),
          entity_id: second.id,
          operation: 'knowledge.update',
          base_version: second.version,
          depends_on_operation_id: parent,
          payload: { content: 'Parent need not be replayed', base_snapshot: second },
        },
      ],
    });
    expect(onlyChild.json().results[0].status, onlyChild.body).toBe('applied');
  });
  it('replays REST reviews through sync without double scheduling and unblocks later reviews', async () => {
    const note = (
      await post('/knowledge-items', { id: id(), title: 'Transport review', type: 'note', content: 'Recall' })
    ).json();
    const card = (
      await post('/knowledge-items/' + note.id + '/cards', {
        id: id(),
        card_type: 'custom',
        prompt: 'Q',
        answer: 'A',
      })
    ).json();
    const device = (await post('/devices', { id: id(), name: 'Review transport', platform: 'ios' })).json(),
      key = id(),
      next = id(),
      time = Date.now();
    const payload = {
      card_id: card.id,
      device_id: device.id,
      rating: 'good',
      reviewed_at: new Date(time).toISOString(),
      duration_ms: 100,
      base_version: card.version,
      idempotency_key: key,
    };
    expect((await post('/review/events', payload, key)).statusCode).toBe(201);
    const replay = await post('/sync/push', {
      device_id: device.id,
      operations: [
        {
          client_operation_id: key,
          entity_id: card.id,
          operation: 'review.rate',
          base_version: card.version,
          payload,
        },
        {
          client_operation_id: next,
          entity_id: card.id,
          operation: 'review.rate',
          base_version: card.version,
          depends_on_operation_id: key,
          payload: {
            ...payload,
            idempotency_key: next,
            reviewed_at: new Date(time + 100).toISOString(),
            depends_on_operation_id: key,
          },
        },
      ],
    });
    expect(replay.json().results[0].status, replay.body).toBe('duplicate');
    expect(replay.json().results[1].status, replay.body).toBe('applied');
    expect((await get('/review/history?card_id=' + card.id)).json().items).toHaveLength(2);
  });
  it('applies original delete and complete actions when explicitly resolving offline conflicts', async () => {
    const device = (await post('/devices', { id: id(), name: 'Conflict actions', platform: 'ios' })).json(),
      note = (
        await post('/knowledge-items', {
          id: id(),
          title: 'Delete conflict',
          type: 'note',
          content: 'Before',
        })
      ).json();
    const updated = (
      await patch(
        '/knowledge-items/' + note.id,
        { content: 'Server version', base_snapshot: note },
        note.version,
      )
    ).json();
    const remove = await post('/sync/push', {
      device_id: device.id,
      operations: [
        {
          client_operation_id: id(),
          entity_id: note.id,
          operation: 'knowledge.delete',
          base_version: note.version,
          payload: {},
        },
      ],
    });
    expect(remove.json().results[0].status).toBe('conflict');
    const conflict = (await get('/sync/conflicts/' + remove.json().results[0].conflict_id)).json();
    expect(
      (
        await post(
          '/sync/conflicts/' + conflict.id + '/resolve',
          { resolution: 'apply_client', current_entity_version: updated.version },
          id(),
          conflict.version,
        )
      ).statusCode,
    ).toBe(200);
    expect((await get('/knowledge-items/' + note.id)).statusCode).toBe(404);
    const session = (
      await post('/fitness/sessions', { id: id(), started_at: new Date(Date.now() - 1000).toISOString() })
    ).json();
    const edited = (
      await patch('/fitness/sessions/' + session.id, { notes: 'Server note' }, session.version)
    ).json();
    const finish = await post('/sync/push', {
      device_id: device.id,
      operations: [
        {
          client_operation_id: id(),
          entity_id: session.id,
          operation: 'workout.session.complete',
          base_version: session.version,
          payload: { ended_at: new Date().toISOString() },
        },
      ],
    });
    expect(finish.json().results[0].status).toBe('conflict');
    const finishConflict = (await get('/sync/conflicts/' + finish.json().results[0].conflict_id)).json();
    const resolved = await post(
      '/sync/conflicts/' + finishConflict.id + '/resolve',
      { resolution: 'apply_client', current_entity_version: edited.version },
      id(),
      finishConflict.version,
    );
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect((await get('/fitness/sessions/' + session.id)).json().status).toBe('completed');
  });
  it('recovers after backup rollback and rejects old stream cursors even when revisions are reused', async () => {
    const device = (await post('/devices', { id: id(), name: 'Restore recovery', platform: 'ios' })).json();
    const snapshot = (await post('/sync/snapshots', { device_id: device.id })).json();
    expect(snapshot.schema_version).toBe('1');
    const initial = (await get('/sync/snapshots/' + snapshot.id + '/records')).json();
    await post('/inbox', { id: id(), content: 'Change before simulated restore' });
    const advanced = (
      await get('/sync/pull?cursor=' + encodeURIComponent(initial.resume_sync_cursor))
    ).json();
    const oldCursor = advanced.next_cursor;
    const head = (
      await db.transaction(app.prism.config.userId, (sql) =>
        sql.query('SELECT id,revision::text revision FROM user_sync_state WHERE user_id=$1', [
          app.prism.config.userId,
        ]),
      )
    ).rows[0];
    await db.transaction(app.prism.config.userId, (sql) =>
      sql.query('UPDATE user_sync_state SET revision=$2 WHERE user_id=$1', [
        app.prism.config.userId,
        String(BigInt(head.revision) - 1n),
      ]),
    );
    const ahead = await get('/sync/pull?cursor=' + encodeURIComponent(oldCursor));
    expect(ahead.statusCode, ahead.body).toBe(410);
    expect(ahead.json().error.code).toBe('SYNC_CURSOR_EXPIRED');
    expect(ahead.json().error.details.reason).toBe('CURSOR_AHEAD');
    await db.transaction(app.prism.config.userId, (sql) =>
      sql.query('UPDATE user_sync_state SET revision=$2 WHERE user_id=$1', [
        app.prism.config.userId,
        head.revision,
      ]),
    );
    const rotated = await app.prism.service.rotateSyncStream(app.prism.config.userId);
    expect(rotated.previous_generation).toBe(head.id);
    expect(rotated.generation).not.toBe(head.id);
    await post('/inbox', { id: id(), content: 'New stream advances past the old revision' });
    const old = await get('/sync/pull?cursor=' + encodeURIComponent(oldCursor));
    expect(old.statusCode, old.body).toBe(410);
    expect(old.json().error.details.reason).toBe('STREAM_RESET');
    const oldPage = await get('/sync/snapshots/' + snapshot.id + '/records');
    expect(oldPage.statusCode, oldPage.body).toBe(410);
    expect(oldPage.json().error.details.reason).toBe('STREAM_RESET');
    const fresh = (await post('/sync/snapshots', { device_id: device.id })).json();
    expect(fresh.schema_version).toBe('1');
    const page = (await get('/sync/snapshots/' + fresh.id + '/records')).json();
    expect((await get('/sync/pull?cursor=' + encodeURIComponent(page.resume_sync_cursor))).statusCode).toBe(
      200,
    );
    expect((await get('/sync/pull?cursor=not-a-valid-cursor')).statusCode).toBe(400);
    const forged = page.resume_sync_cursor.slice(0, -1) + (page.resume_sync_cursor.endsWith('A') ? 'B' : 'A');
    expect((await get('/sync/pull?cursor=' + encodeURIComponent(forged))).statusCode).toBe(400);
  });
  it('uses changed retention on the next review without silently moving existing due times', async () => {
    const note = (
      await post('/knowledge-items', { id: id(), title: 'Retention', type: 'note', content: 'Recall' })
    ).json();
    const card = (
      await post('/knowledge-items/' + note.id + '/cards', {
        id: id(),
        card_type: 'custom',
        prompt: 'Q',
        answer: 'A',
      })
    ).json();
    const prefs = (await get('/me/preferences')).json();
    expect((await patch('/me/preferences', { desired_retention: 0.95 }, prefs.version)).statusCode).toBe(200);
    expect((await get('/review/cards/' + card.id)).json().due_at).toBe(card.due_at);
    const device = (await post('/devices', { id: id(), name: 'Retention phone', platform: 'ios' })).json(),
      key = id();
    const reviewed = await post(
      '/review/events',
      {
        card_id: card.id,
        device_id: device.id,
        rating: 'good',
        reviewed_at: new Date().toISOString(),
        duration_ms: 100,
        base_version: card.version,
        idempotency_key: key,
      },
      key,
    );
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    expect(reviewed.json().card.scheduler_config.desired_retention).toBe(0.95);
    expect(reviewed.json().event.scheduler_config.id).not.toBe(card.scheduler_config.id);
  });
  it('synchronizes a complete offline workout with causal parent versions and no duplicate sets', async () => {
    const device = (await post('/devices', { id: id(), name: 'Workout phone', platform: 'ios' })).json();
    const exercise = (
      await post('/fitness/exercises', {
        id: id(),
        name: 'Offline row',
        exercise_type: 'strength',
        measurement_unit: 'kg',
      })
    ).json();
    const session = id(),
      sx = id(),
      set = id(),
      create = id(),
      actual = id(),
      log = id();
    const operations = [
      {
        client_operation_id: log,
        entity_id: set,
        operation: 'workout.set.create',
        depends_on_operation_id: actual,
        payload: {
          id: set,
          session_id: session,
          session_exercise_id: sx,
          set_order: 0,
          entered_weight: 40,
          entered_weight_unit: 'kg',
          reps: 8,
          completed_at: new Date().toISOString(),
        },
      },
      {
        client_operation_id: create,
        entity_id: session,
        operation: 'workout.session.create',
        payload: { id: session, started_at: new Date(Date.now() - 1000).toISOString() },
      },
      {
        client_operation_id: actual,
        entity_id: sx,
        operation: 'workout.exercise.create',
        depends_on_operation_id: create,
        payload: { id: sx, session_id: session, exercise_id: exercise.id, position: 0 },
      },
    ];
    const pushed = await post('/sync/push', { device_id: device.id, operations });
    expect(pushed.statusCode, pushed.body).toBe(200);
    for (const r of pushed.json().results) expect(r.status, JSON.stringify(r)).toBe('applied');
    const parent = pushed
      .json()
      .results.find((x: any) => x.client_operation_id === log)
      .records.find((x: any) => x.entity_id === session);
    expect(parent).toBeTruthy();
    const complete = await post('/sync/push', {
      device_id: device.id,
      operations: [
        {
          client_operation_id: id(),
          entity_id: session,
          operation: 'workout.session.complete',
          base_version: parent.entity_version,
          depends_on_operation_id: log,
          payload: { ended_at: new Date().toISOString() },
        },
      ],
    });
    expect(complete.json().results[0].status, complete.body).toBe('applied');
    const repeated = await post('/sync/push', { device_id: device.id, operations });
    for (const r of repeated.json().results) expect(r.status).toBe('duplicate');
    const current = (await get('/fitness/sessions/' + session)).json();
    expect(current.status).toBe('completed');
    expect(current.exercises).toHaveLength(1);
    expect(current.sets).toHaveLength(1);
    expect(current.volume_kg_reps).toBe(320);
  });
  it('keeps arXiv versions unique and digests only newly ingested versions', async () => {
    const now = new Date(),
      paper = {
        arxiv_id: '2611.99999',
        latest_version: 1,
        title: 'Test metadata fixture',
        abstract: 'Commutative algebra',
        authors: ['Fixture Author'],
        categories: ['math.AC'],
        published_at: now.toISOString(),
        updated_at: now.toISOString(),
        source_url: 'https://arxiv.org/abs/2611.99999',
        pdf_url: 'https://arxiv.org/pdf/2611.99999',
        relevance_score: 4,
        match_reasons: ['category:math.AC'],
      };
    const subscription = (
      await post('/arxiv/subscriptions', {
        id: id(),
        subscription_type: 'category',
        subscription_value: ' math,ac ',
      })
    ).json();
    expect(subscription.subscription_value).toBe('math.AC');
    expect(
      (
        await post('/arxiv/subscriptions', {
          id: id(),
          subscription_type: 'category',
          subscription_value: 'math??AG',
        })
      ).statusCode,
    ).toBe(422);
    await post('/arxiv/subscriptions', {
      id: id(),
      subscription_type: 'category',
      subscription_value: 'math.NT',
    });
    const activePaper = {
      ...paper,
      arxiv_id: '2611.99997',
      categories: ['math.NT'],
      source_url: 'https://arxiv.org/abs/2611.99997',
      pdf_url: 'https://arxiv.org/pdf/2611.99997',
    };
    await app.prism.service.ingestPapers(app.prism.config.userId, [paper, activePaper], id());
    await app.prism.service.ingestPapers(app.prism.config.userId, [paper, activePaper], id());
    const feed = (await get('/arxiv/feed')).json();
    const fixture = feed.items.find((x: any) => x.paper.arxiv_id === paper.arxiv_id),
      active = feed.items.find((x: any) => x.paper.arxiv_id === activePaper.arxiv_id);
    expect(fixture.paper.versions).toHaveLength(1);
    expect(active.paper.versions).toHaveLength(1);
    const unreadPage = (await get('/arxiv/feed?status=unread&limit=1')).json();
    expect(unreadPage.items).toHaveLength(1);
    expect(unreadPage.next_cursor).toBeTruthy();
    const nextUnread = `/arxiv/feed?status=unread&limit=1&cursor=${encodeURIComponent(unreadPage.next_cursor)}`;
    expect((await get(nextUnread)).json().items[0].id).not.toBe(unreadPage.items[0].id);
    const refresh = await post('/arxiv/refresh', {});
    expect(refresh.statusCode).toBe(202);
    expect((await post('/arxiv/refresh', {})).json().id).toBe(refresh.json().id);
    expect(
      (await patch('/arxiv/subscriptions/' + subscription.id, { enabled: false }, subscription.version))
        .statusCode,
    ).toBe(200);
    const remainingUnread = (await get('/arxiv/feed?status=unread&limit=1')).json();
    expect(remainingUnread.items.map((x: any) => x.paper_id)).toEqual([active.paper_id]);
    expect(remainingUnread.next_cursor).toBeNull();
    expect((await get(nextUnread)).statusCode).toBe(422);
    expect((await post('/arxiv/papers/' + fixture.paper_id + '/save', {})).statusCode).toBe(200);
    expect(
      (await get('/arxiv/feed?status=unread&saved=true')).json().items.map((x: any) => x.paper_id),
    ).toContain(fixture.paper_id);
    const changedRefresh = await post('/arxiv/refresh', {});
    expect(changedRefresh.statusCode).toBe(202);
    expect(changedRefresh.json().id).not.toBe(refresh.json().id);
    expect((await get('/automation/jobs/' + changedRefresh.json().id)).json().status).toBe('pending');
    const stalePaper = {
      ...paper,
      arxiv_id: '2611.99996',
      source_url: 'https://arxiv.org/abs/2611.99996',
      pdf_url: 'https://arxiv.org/pdf/2611.99996',
    };
    await app.prism.service.ingestPapers(app.prism.config.userId, [stalePaper], id());
    expect(
      (await get('/arxiv/feed')).json().items.some((x: any) => x.paper.arxiv_id === stalePaper.arxiv_id),
    ).toBe(false);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    const tomorrow = new Date(now.getTime() + 86400000);
    const next = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(tomorrow);
    await app.prism.service.dailyAutomation(app.prism.config.userId, 'digest', today);
    await app.prism.service.dailyAutomation(app.prism.config.userId, 'digest', next);
    const notifications = await db.transaction(app.prism.config.userId, (sql) =>
      sql.query(
        "SELECT payload FROM notification_events WHERE notification_type='digest' ORDER BY created_at",
      ),
    );
    expect(notifications.rows.find((x) => x.payload.date === today)!.payload.paper_ids).not.toContain(
      fixture.paper_id,
    );
    expect(notifications.rows.find((x) => x.payload.date === today)!.payload.paper_ids).toContain(
      active.paper_id,
    );
    expect(notifications.rows.find((x) => x.payload.date === next)!.payload.paper_ids).not.toContain(
      active.paper_id,
    );
    expect((await get('/arxiv/feed')).json().items.some((x: any) => x.paper_id === fixture.paper_id)).toBe(
      true,
    );
  });
  it('exposes push tokens only to the server worker and bounds failed delivery retries', async () => {
    app.prism.config.pushEncryptionKey = Buffer.alloc(32, 7).toString('base64');
    const token = 'ExpoPushToken[private-test-fixture]';
    const device = await post('/devices', {
      id: id(),
      name: 'Push phone',
      platform: 'ios',
      push_token: token,
    });
    expect(device.statusCode, device.body).toBe(201);
    expect(device.body).not.toContain(token);
    expect(device.json().push_registered).toBe(true);
    const pending = await app.prism.service.pendingNotifications();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].push_tokens).toContain(token);
    for (let n = 0; n < 5; n++)
      await app.prism.service.ackNotification(pending[0].id, app.prism.config.userId, 'failed');
    const status = await db.transaction(app.prism.config.userId, (sql) =>
      sql.query('SELECT status,payload FROM notification_events WHERE id=$1', [pending[0].id]),
    );
    expect(status.rows[0].status).toBe('failed');
    expect(status.rows[0].payload.delivery_attempts).toBe(5);
  });
  it('soft deletes records with a repeatable204 receipt and exports all product data', async () => {
    const note = (
      await post('/knowledge-items', { id: id(), title: 'Temporary', type: 'note', content: 'x' })
    ).json();
    const key = id();
    const req = {
      method: 'DELETE' as const,
      url: '/api/v1/knowledge-items/' + note.id,
      headers: { 'Idempotency-Key': key, 'If-Match': `"${note.version}"` },
    };
    expect((await app.inject(req)).statusCode).toBe(204);
    expect((await app.inject(req)).statusCode).toBe(204);
    expect((await get('/knowledge-items/' + note.id)).statusCode).toBe(404);
    const created = await post('/exports', { formats: ['json', 'markdown'] });
    expect(created.statusCode, created.body).toBe(202);
    await app.prism.service.processExports();
    const exported = (await get('/exports/' + created.json().id)).json();
    expect(exported.status, JSON.stringify(exported)).toBe('ready');
    expect(exported.manifest.files.length).toBeGreaterThan(0);
    const zip = await get('/exports/' + exported.id + '/download');
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toContain('application/zip');
  });
  it('creates review cards in an idempotent batch and rolls back a late ID collision', async () => {
    const createdItem = await post('/knowledge-items', {
      id: id(),
      title: 'Batch recall fixture',
      type: 'lemma',
      content: 'A finite subset of a Hausdorff space is closed.',
    });
    expect(createdItem.statusCode).toBe(201);
    const itemId = createdItem.json().id;
    const path = `/knowledge-items/${itemId}/cards`;
    const cards = [
      { id: id(), card_type: 'statement', prompt: 'State the lemma.', answer: 'Finite subsets are closed.' },
      {
        id: id(),
        card_type: 'hypotheses',
        prompt: 'What is assumed about the space?',
        answer: 'It is Hausdorff.',
      },
    ];
    const key = id();
    const created = await post(`${path}/batch`, { cards }, key);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().items).toMatchObject(cards.map((card) => ({ ...card, knowledge_item_id: itemId })));

    const retried = await post(`${path}/batch`, { cards }, key);
    expect(retried.statusCode, retried.body).toBe(201);
    expect(retried.json()).toEqual(created.json());
    const before = (await get(path)).json();
    expect(before.items.map((card: { id: string }) => card.id).sort()).toEqual(
      cards.map((card) => card.id).sort(),
    );

    const newCard = { ...cards[0], id: id(), prompt: 'A card that should roll back.' };
    const collision = await post(`${path}/batch`, { cards: [newCard, cards[1]] });
    expect(collision.statusCode, collision.body).toBe(422);
    expect((await get(`/review/cards/${newCard.id}`)).statusCode).toBe(404);
    expect((await get(path)).json().items).toMatchObject(
      before.items.map((card: { id: string; version: string; due_at: string }) => ({
        id: card.id,
        version: card.version,
        due_at: card.due_at,
      })),
    );
  });
});

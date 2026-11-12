import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
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
          href: `/research/${project.id}?object=${object.id}`,
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

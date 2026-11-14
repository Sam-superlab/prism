import type { RequestOptions } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config';
import { validateApiResponse } from '../../apps/api/src/contract';
import { createFeedPreview } from '../../apps/worker/src/feed-preview';
import { startWorker } from '../../apps/worker/src/index';
import { createDatabase } from '../../packages/database/src/index';
import { LOCAL_USER_ID } from '../../packages/core/src/config';

const path = '/research/library/feeds/preview';
const headers = { host: '127.0.0.1:4000', authorization: `Bearer ${'a'.repeat(64)}` };
const publicAddress = { address: '93.184.216.34', family: 4 };
const publicV6 = { address: '2606:4700::6810:84e5', family: 6 };
const address = 'https://journals.example.org/feed';
const rss = `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
  <title>Rings &amp; Ideals</title>
  <item><guid isPermaLink="false">paper-1</guid><title>Algebra &amp; Computation</title>
    <link>/papers/example?a=1&amp;b=2</link><dc:creator>Ada Example</dc:creator>
    <pubDate>Fri, 06 Nov 2026 11:30:00 GMT</pubDate>
    <description><![CDATA[<p>Graded <em>rings</em> and ideals.</p>]]></description>
  </item><item><guid>paper-1</guid><title>Repeated item</title></item>
  <item><title>Entry without link</title><link>javascript:alert(1)</link></item>
</channel></rss>`;
const atom = `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>Seminars</atom:title>
  <atom:author><atom:name>Ada Example</atom:name></atom:author><atom:entry>
    <atom:id>tag:example.org,2026:1</atom:id><atom:title type="html">A &lt;i&gt;number&lt;/i&gt;</atom:title>
    <atom:link rel="self" href="/feed"/><atom:link rel="alternate" href="/abstract"/>
    <atom:updated>2026-11-05T12:00:00+01:00</atom:updated>
    <atom:summary type="html">&lt;b&gt;Prime&lt;/b&gt; numbers</atom:summary>
  </atom:entry></atom:feed>`;

function response(body: string | Uint8Array = rss, statusCode = 200, responseHeaders: Record<string, string> = {}) {
  return {
    statusCode, headers: responseHeaders, destroy: vi.fn(),
    async *[Symbol.asyncIterator]() { yield typeof body === 'string' ? Buffer.from(body) : body; },
  };
}

const resolve = vi.fn(async (_hostname: string) => [publicAddress]);
const open = vi.fn(async (_url: URL, _options: RequestOptions) => response());
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof createDatabase>>;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'prism-feed-preview-'));
  db = await createDatabase({ memory: true });
  app = await buildApp({
    db, feedPreview: createFeedPreview({ resolve, open }), config: loadConfig({
      PRISM_AUTH_MODE: 'desktop', PRISM_PORT: '4000', PRISM_DESKTOP_TOKEN: 'a'.repeat(64), PRISM_DATA_DIR: dataDir,
      PRISM_WEB_ORIGIN: 'http://127.0.0.1:38741',
    }),
  });
});
beforeEach(() => {
  resolve.mockReset().mockResolvedValue([publicAddress]);
  open.mockReset().mockImplementation(async () => response());
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function preview(url = address, authorized = true) {
  const result = await app.inject({
    method: 'POST', url: '/api/v1' + path, headers: authorized ? headers : { host: headers.host },
    payload: { url },
  });
  expect(await validateApiResponse('POST', path, result.statusCode, result.json())).toEqual([]);
  return result;
}

it('authenticates and rejects invalid origins before DNS or a network request', async () => {
  expect((await preview(address, false)).statusCode).toBe(401);
  for (const url of [
    'http://journals.example.org/feed', 'https://journals.example.org:8443/feed',
    'https://user:pass@journals.example.org/feed', 'https://localhost/feed',
    'https://domain.local/feed', 'https://127.0.0.1/feed', 'https://[::1]/feed',
  ]) expect((await preview(url)).statusCode).toBe(422);
  expect(resolve).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it('rejects nonpublic DNS answers even when another answer is public', async () => {
  const validate = createFeedPreview({ resolve, open });
  for (const answer of [
    { address: '127.0.0.1', family: 4 }, { address: '10.0.0.5', family: 4 },
    { address: '169.254.10.10', family: 4 }, { address: '100.64.0.1', family: 4 },
    { address: '::ffff:127.0.0.1', family: 6 }, { address: 'fe80::10', family: 6 },
    { address: 'fc00::10', family: 6 }, { address: '2001:db8::1', family: 6 },
    { address: '2002:7f00:1::1', family: 6 }, { address: '3fff:123::1', family: 6 },
  ]) {
    resolve.mockResolvedValueOnce([publicAddress, answer]);
    await expect(validate(address)).rejects.toMatchObject({ status: 422 });
  }
  expect(open).not.toHaveBeenCalled();
});

it('pins the validated HTTPS destination and returns normalized RSS data without persistence', async () => {
  const result = await preview(`${address}#ignored`);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.headers['cache-control']).toBe('private, no-store');
  expect(resolve).toHaveBeenCalledExactlyOnceWith('journals.example.org');
  const [[url, options]] = open.mock.calls;
  expect(url.href).toBe(address);
  expect(options).toMatchObject({ agent: false, servername: 'journals.example.org', rejectUnauthorized: true, family: 4 });
  expect(Object.keys(options.headers ?? {})).not.toEqual(expect.arrayContaining(['cookie', 'authorization']));
  const done = vi.fn();
  options.lookup?.(url.hostname, {}, done);
  expect(done).toHaveBeenLastCalledWith(null, publicAddress.address, 4);
  options.lookup?.(url.hostname, { all: true }, done);
  expect(done).toHaveBeenLastCalledWith(null, [publicAddress], 4);
  expect(result.json()).toMatchObject({ url: address, title: 'Rings & Ideals', items: [
    { external_id: expect.stringMatching(/^[a-f0-9]{64}$/), title: 'Algebra & Computation',
      url: 'https://journals.example.org/papers/example?a=1&b=2', authors: ['Ada Example'],
      published_at: '2026-11-06T11:30:00.000Z', summary: 'Graded rings and ideals.' },
    { title: 'Entry without link', url: null, published_at: null, authors: [], summary: null },
  ] });
  const saved = await app.inject({ url: '/api/v1/research/library?native=true', headers });
  expect(saved.json().items).toEqual([]);
});

it('previews Atom on a pinned IPv6 destination and bounds the entry list', async () => {
  resolve.mockResolvedValue([publicV6]);
  open.mockResolvedValueOnce(response(atom));
  const parsed = await preview();
  expect(parsed.statusCode, parsed.body).toBe(200);
  expect(open.mock.calls[0][1].family).toBe(6);
  expect(parsed.json()).toMatchObject({ title: 'Seminars', items: [
    { title: 'A number', url: 'https://journals.example.org/abstract', published_at: '2026-11-05T11:00:00.000Z',
      authors: ['Ada Example'], summary: 'Prime numbers' },
  ] });
  open.mockResolvedValueOnce(response(`<rss><channel><title>Many</title>${Array.from({ length: 55 }, (_, i) =>
    `<item><title>Paper ${i}</title></item>`).join('')}</channel></rss>`));
  expect((await preview()).json().items).toHaveLength(50);
});

it('rejects redirects, malformed XML, dangerous XML declarations and oversized payloads', async () => {
  const redirect = response('', 302, { location: 'https://another.example.org/feed' });
  open.mockResolvedValueOnce(redirect);
  expect((await preview()).statusCode).toBe(502);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);
  expect(redirect.destroy).toHaveBeenCalledTimes(1);
  const responses = [
    response('<rss><channel>'),
    response('<!DOCTYPE rss SYSTEM "https://another.example.org/feed"><rss><channel/></rss>'),
    response(`<rss><channel>${'<nested>'.repeat(30)}text${'</nested>'.repeat(30)}</channel></rss>`),
    response(rss, 200, { 'content-encoding': 'gzip' }),
    response(rss, 200, { 'content-length': '524289' }),
    response(Buffer.alloc(524289)),
    response(Uint8Array.from([0xff, 0xfe, 0xf0])),
  ];
  for (const fixture of responses) {
    open.mockResolvedValueOnce(fixture);
    expect((await preview()).statusCode).toBe(422);
    expect(fixture.destroy).toHaveBeenCalledTimes(1);
  }
});

async function feedRequest(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', route: string, options: {
  body?: Record<string, unknown>; version?: string; key?: string; authorized?: boolean;
} = {}) {
  const result = await app.inject({
    method, url: '/api/v1' + route,
    headers: { ...(options.authorized === false ? { host: headers.host } : headers),
      'Idempotency-Key': options.key ?? crypto.randomUUID(),
      ...(options.version && { 'If-Match': `"${options.version}"` }),
    },
    payload: options.body,
  });
  const json = result.statusCode === 204 ? null : result.json();
  expect(await validateApiResponse(method, route, result.statusCode, json), result.body).toEqual([]);
  return { result, json };
}

const feedsPath = '/research/library/feeds';
const feedEntriesPath = '/research/library/feed-entries';

async function advanceFeedSchedule(id: string, releaseSpacing = true) {
  await db.transaction(LOCAL_USER_ID, async (sql) => {
    await sql.query("UPDATE literature_feeds SET next_refresh_at=now()-interval '1 second' WHERE id=$1 AND auto_refresh", [id]);
    if (releaseSpacing) await sql.query("UPDATE literature_feeds SET scheduled_refresh_started_at=now()-interval '2 minutes' WHERE scheduled_refresh_started_at IS NOT NULL");
  });
}

it('persists subscriptions, refreshes, paginates, updates read state and preserves saved bibliography records', async () => {
  const id = crypto.randomUUID();
  const feed = `${feedsPath}/${id}`;
  const create = { id, url: 'https://JOURNALS.example.org:443/feed#fragment' };
  expect((await feedRequest('POST', feedsPath, { body: create, authorized: false })).result.statusCode).toBe(401);
  expect((await feedRequest('POST', feedsPath, { body: { ...create, url: 'https://localhost/feed' } })).result.statusCode).toBe(422);
  const created = await feedRequest('POST', feedsPath, { body: create });
  expect(created.result.statusCode).toBe(201);
  expect(created.json).toMatchObject({ id, url: address, title: 'journals.example.org', unread_count: 0, version: '1' });
  expect(resolve).not.toHaveBeenCalled();
  expect((await feedRequest('POST', feedsPath, { body: { id: crypto.randomUUID(), url: address } })).result.statusCode).toBe(409);
  expect((await feedRequest('POST', `${feed}/refresh`, { key: 'not-a-uuid' })).result.statusCode).toBe(422);
  expect((await feedRequest('POST', `${feedsPath}/${crypto.randomUUID()}/refresh`)).result.statusCode).toBe(404);
  expect(open).not.toHaveBeenCalled();

  const refreshKey = crypto.randomUUID();
  const refreshed = await feedRequest('POST', `${feed}/refresh`, { key: refreshKey });
  expect(refreshed.result.statusCode).toBe(200);
  expect(refreshed.json).toMatchObject({ added: 2, pruned: 0, feed: { id, title: 'Rings & Ideals', unread_count: 2, version: '2', last_refresh_error: null } });
  expect((await feedRequest('POST', `${feed}/refresh`, { key: refreshKey })).json).toEqual(refreshed.json);
  expect(open).toHaveBeenCalledTimes(1);
  expect((await feedRequest('GET', feedsPath)).json.items).toContainEqual(refreshed.json.feed);
  const page = (await feedRequest('GET', `${feed}/entries?limit=1`)).json;
  expect(page.items).toHaveLength(1);
  const next = encodeURIComponent(page.next_cursor);
  expect((await feedRequest('GET', `${feed}/entries?unread=true&cursor=${next}`)).result.statusCode).toBe(422);
  expect((await feedRequest('GET', `${feed}/entries?cursor=${next}`)).json.items).toHaveLength(1);

  const first = (await feedRequest('GET', `${feed}/entries`)).json.items.find((item: { title: string }) => item.title.startsWith('Algebra'));
  const read = await feedRequest('PATCH', `${feedEntriesPath}/${first.id}`, { version: first.version, body: { read: true } });
  expect(read.result.statusCode).toBe(200);
  expect(read.json).toMatchObject({ read_at: expect.any(String), version: '2' });
  expect((await feedRequest('PATCH', `${feedEntriesPath}/${first.id}`, { version: '1', body: { read: false } })).result.statusCode).toBe(412);
  expect((await feedRequest('GET', `${feed}/entries?unread=true`)).json.items).toHaveLength(1);
  expect((await feedRequest('GET', feed)).json.unread_count).toBe(1);

  const renamed = await feedRequest('PATCH', feed, { version: '2', body: { title: '  My journal  ' } });
  expect(renamed.json).toMatchObject({ title: 'My journal', version: '3' });
  open.mockResolvedValueOnce(response(rss.replace('Algebra &amp; Computation', 'A revised algebra article')));
  const repeated = await feedRequest('POST', `${feed}/refresh`);
  expect(repeated.json).toMatchObject({ added: 0, pruned: 0, feed: { title: 'My journal', version: '4', unread_count: 1 } });
  const revised = (await feedRequest('GET', `${feed}/entries`)).json.items.find((item: { id: string }) => item.id === first.id);
  expect(revised).toMatchObject({ title: 'A revised algebra article', read_at: read.json.read_at, version: '3' });
  expect((await feedRequest('PATCH', `${feedEntriesPath}/${first.id}`, { version: revised.version, body: { read: false } })).json)
    .toMatchObject({ read_at: null, version: '4' });

  const deviceId = crypto.randomUUID();
  await feedRequest('POST', '/devices', { body: { id: deviceId, name: 'Feed sync fixture', platform: 'web' } });
  const snapshot = await feedRequest('POST', '/sync/snapshots', { body: { device_id: deviceId } });
  const records = (await feedRequest('GET', `/sync/snapshots/${snapshot.json.id}/records?limit=100`)).json.records;
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ entity_type: 'literature_feed', entity_id: id, data: expect.objectContaining({ title: 'My journal' }) }),
    expect.objectContaining({ entity_type: 'literature_feed_entry', entity_id: first.id, data: expect.objectContaining({ read_at: null }) }),
  ]));
  const record = records.find((item: { entity_id: string }) => item.entity_id === id);
  expect(record.data).not.toHaveProperty('refresh_token');
  const savedId = crypto.randomUUID();
  await feedRequest('POST', '/research/references', { body: { id: savedId, title: revised.title, url: revised.url } });
  expect((await feedRequest('DELETE', feed, { version: '3' })).result.statusCode).toBe(412);
  expect((await feedRequest('DELETE', feed, { version: '4' })).result.statusCode).toBe(204);
  expect((await feedRequest('GET', `${feed}/entries`)).result.statusCode).toBe(404);
  expect((await feedRequest('PATCH', `${feedEntriesPath}/${first.id}`, { version: '4', body: { read: false } })).result.statusCode).toBe(404);
  expect((await feedRequest('GET', `/research/references/${savedId}`)).result.statusCode).toBe(200);
});

it('claims refresh outside the write transaction and records a sanitized failure only once per retry key', async () => {
  const id = crypto.randomUUID();
  const feed = `${feedsPath}/${id}`;
  const url = `${address}?private=fixture-only`;
  await feedRequest('POST', feedsPath, { body: { id, url } });
  let started!: () => void;
  let finish!: (value: ReturnType<typeof response>) => void;
  const fetching = new Promise<void>((resolve) => { started = resolve; });
  open.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; started(); }));
  const inFlight = feedRequest('POST', `${feed}/refresh`);
  await fetching;
  expect((await feedRequest('POST', `${feed}/refresh`)).json.error.code).toBe('FEED_REFRESH_BUSY');
  expect((await feedRequest('PATCH', feed, { body: { title: 'Renamed during refresh' }, version: '1' })).result.statusCode).toBe(200);
  finish(response());
  const success = await inFlight;
  expect(success.json).toMatchObject({ feed: { title: 'Renamed during refresh', version: '3', unread_count: 2 } });

  const key = crypto.randomUUID();
  open.mockRejectedValueOnce(new Error(`Request failed: ${url}`));
  const failed = await feedRequest('POST', `${feed}/refresh`, { key });
  expect(failed.result.statusCode).toBe(502);
  expect(failed.result.body).not.toContain('fixture-only');
  const state = (await feedRequest('GET', feed)).json;
  expect(state).toMatchObject({ version: '4', last_refreshed_at: success.json.feed.last_refreshed_at,
    unread_count: 2, last_refresh_error: 'The feed could not be reached. Try again shortly.' });
  expect((await feedRequest('POST', `${feed}/refresh`, { key })).result.statusCode).toBe(502);
  expect((await feedRequest('GET', feed)).json).toEqual(state);
  expect(open).toHaveBeenCalledTimes(2);
  expect((await feedRequest('POST', `${feed}/refresh`)).json.feed).toMatchObject({ version: '5', last_refresh_error: null });
});

it('retains the newest 200 entries of each feed and removes older rows', async () => {
  const id = crypto.randomUUID();
  const feed = `${feedsPath}/${id}`;
  await feedRequest('POST', feedsPath, { body: { id, url: 'https://archive.example.org/feed' } });
  for (let batch = 0; batch < 5; batch++) {
    const entries = Array.from({ length: 50 }, (_, index) => {
      const entry = batch * 50 + index;
      const date = new Date(Date.UTC(2026, 0, 1 + entry)).toISOString();
      return `<item><title>Entry ${entry}</title><guid>${entry}</guid><pubDate>${date}</pubDate></item>`;
    });
    open.mockResolvedValueOnce(response(`<rss><channel><title>Archive</title>${entries.join('')}</channel></rss>`));
    const refresh = await feedRequest('POST', `${feed}/refresh`);
    expect(refresh.json).toMatchObject({ added: 50, pruned: batch === 4 ? 50 : 0 });
  }
  const page = (await feedRequest('GET', `${feed}/entries?limit=100`)).json;
  expect(page.items[0].title).toBe('Entry 249');
  const next = (await feedRequest('GET', `${feed}/entries?limit=100&cursor=${encodeURIComponent(page.next_cursor)}`)).json;
  expect(next.items.at(-1).title).toBe('Entry 50');
  expect(next.next_cursor).toBeNull();
  expect((await feedRequest('GET', feed)).json.unread_count).toBe(200);
});

it('schedules only opted-in feeds and backs off after safe failures', async () => {
  const id = crypto.randomUUID();
  const feed = `${feedsPath}/${id}`;
  const previewFeed = createFeedPreview({ resolve, open });
  const refreshDue = () => app.prism.service.refreshDueLiteratureFeed(LOCAL_USER_ID, previewFeed);
  const created = await feedRequest('POST', feedsPath, { body: { id, url: 'https://scheduled.example.org/feed' } });
  expect(created.json).toMatchObject({ auto_refresh: false, next_refresh_at: null });
  expect(await refreshDue()).toBeNull();
  expect(open).not.toHaveBeenCalled();

  const enabled = await feedRequest('PATCH', feed, { version: '1', body: { auto_refresh: true } });
  expect(enabled.result.statusCode, enabled.result.body).toBe(200);
  expect(enabled.json).toMatchObject({ auto_refresh: true, version: '2' });
  expect(Date.parse(enabled.json.next_refresh_at) - Date.now()).toBeGreaterThan(50_000);
  expect(await refreshDue()).toBeNull();
  await advanceFeedSchedule(id);
  expect(await refreshDue()).toEqual({ feed_id: id, status: 200 });
  const success = (await feedRequest('GET', feed)).json;
  expect(success).toMatchObject({ auto_refresh: true, last_refresh_error: null, unread_count: 2, version: '3' });
  expect(Date.parse(success.next_refresh_at) - Date.now()).toBeGreaterThan(5.9 * 3_600_000);
  expect(open).toHaveBeenCalledTimes(1);

  await advanceFeedSchedule(id, false);
  expect(await refreshDue()).toBeNull();
  expect(open).toHaveBeenCalledTimes(1);
  for (let attempt = 0; attempt < 7; attempt++) {
    await advanceFeedSchedule(id);
    open.mockRejectedValueOnce(new Error('Publisher failed: URL with fixture secret'));
    expect(await refreshDue()).toEqual({ feed_id: id, status: 502 });
    const failed = (await feedRequest('GET', feed)).json;
    const delay = Date.parse(failed.next_refresh_at) - Date.now();
    expect(delay).toBeCloseTo(Math.min(24, 2 ** attempt) * 3_600_000, -4);
    expect(failed).toMatchObject({ last_refreshed_at: success.last_refreshed_at, unread_count: 2, version: String(4 + attempt) });
    expect(failed.last_refresh_error).not.toContain('secret');
  }
  const manual = await feedRequest('POST', `${feed}/refresh`);
  expect(manual.json).toMatchObject({ added: 0, feed: { last_refresh_error: null, version: '11' } });
  expect((await feedRequest('PATCH', feed, { version: '11', body: { auto_refresh: false } })).json)
    .toMatchObject({ auto_refresh: false, next_refresh_at: null });
});

it('discards a scheduled result after an off-on toggle and deduplicates worker attempts', async () => {
  const id = crypto.randomUUID();
  const feed = `${feedsPath}/${id}`;
  await feedRequest('POST', feedsPath, { body: { id, url: 'https://pause.example.org/feed' } });
  await feedRequest('PATCH', feed, { version: '1', body: { auto_refresh: true } });
  await advanceFeedSchedule(id);

  let started!: () => void;
  let finish!: (value: ReturnType<typeof response>) => void;
  const fetching = new Promise<void>((resolve) => { started = resolve; });
  open.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; started(); }));
  const previewFeed = createFeedPreview({ resolve, open });
  const refreshDue = () => app.prism.service.refreshDueLiteratureFeed(LOCAL_USER_ID, previewFeed);
  const pending = refreshDue();
  await fetching;
  expect(await refreshDue()).toBeNull();
  expect(open).toHaveBeenCalledTimes(1);
  expect((await feedRequest('PATCH', feed, { version: '2', body: { auto_refresh: false } })).result.statusCode).toBe(200);
  expect((await feedRequest('PATCH', feed, { version: '3', body: { auto_refresh: true } })).result.statusCode).toBe(200);
  finish(response());
  expect(await pending).toBeNull();
  expect((await feedRequest('GET', feed)).json).toMatchObject({ auto_refresh: true, version: '4', unread_count: 0, last_refreshed_at: null });
  await feedRequest('PATCH', feed, { version: '4', body: { auto_refresh: false } });
});

it('dispatches a due feed through the worker and records outcomes without URLs', async () => {
  const id = crypto.randomUUID();
  const feed = `${feedsPath}/${id}`;
  await feedRequest('POST', feedsPath, { body: { id, url: 'https://worker.example.org/feed?fixture=private' } });
  await feedRequest('PATCH', feed, { version: '1', body: { auto_refresh: true } });
  await advanceFeedSchedule(id);
  let logDone!: (record: Record<string, unknown>) => void;
  const logged = new Promise<Record<string, unknown>>((resolve) => { logDone = resolve; });
  const worker = startWorker({
    db, userId: LOCAL_USER_ID, service: app.prism.service, intervalMs: 60_000,
    feedPreview: createFeedPreview({ resolve, open }),
    fetch: async () => { throw new Error('No external requests in this fixture'); },
    logger: (record) => { if (record.event === 'literature_feed_refresh') logDone(record); },
  });
  try {
    await worker.tick();
    expect(await logged).toEqual({ event: 'literature_feed_refresh', feed_id: id, status: 200 });
    expect((await feedRequest('GET', feed)).json).toMatchObject({ unread_count: 2, last_refreshed_at: expect.any(String) });
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    await worker.close();
  }
});

it('rotates feed polling across distinct hosted accounts on one worker', async () => {
  const secondary = crypto.randomUUID();
  const poll = vi.spyOn(app.prism.service, 'refreshDueLiteratureFeed').mockResolvedValue(null);
  const worker = startWorker({
    db, userId: LOCAL_USER_ID, literatureFeedUserIds: [LOCAL_USER_ID, secondary, secondary],
    service: app.prism.service, intervalMs: 60_000,
    fetch: async () => { throw new Error('No external requests in this fixture'); },
    logger: () => {},
  });
  try {
    await worker.tick();
    await worker.tick();
    await worker.tick();
    expect(poll.mock.calls.map(([account]) => account)).toEqual([LOCAL_USER_ID, secondary, LOCAL_USER_ID]);
  } finally {
    await worker.close();
    poll.mockRestore();
  }
});

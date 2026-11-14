import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { buildApp } from '../../apps/api/src/app';
import { loadConfig } from '../../apps/api/src/config';
import { createDatabase } from '../../packages/database/src/index';
import { validateApiResponse } from '../../apps/api/src/contract';

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof createDatabase>>;
let dataDir: string;
const path = '/research/library/lookup';
const headers = { host: '127.0.0.1:4000', authorization: `Bearer ${'a'.repeat(64)}` };

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'prism-reference-lookup-'));
  db = await createDatabase({ memory: true });
  app = await buildApp({
    db, config: loadConfig({
      PRISM_AUTH_MODE: 'desktop', PRISM_DATA_DIR: dataDir, PRISM_PORT: '4000',
      PRISM_DESKTOP_TOKEN: 'a'.repeat(64), PRISM_WEB_ORIGIN: 'http://127.0.0.1:38741',
    }),
  });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await app?.close();
  await db?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function lookup(kind: string, value: string, authorized = true) {
  const url = `${path}?${new URLSearchParams({ kind, value })}`;
  const response = await app.inject({
    url: '/api/v1' + url,
    headers: authorized ? headers : { host: headers.host },
  });
  expect(await validateApiResponse('GET', url, response.statusCode, response.json())).toEqual([]);
  return response;
}

it('authenticates and validates identifiers before any outbound request', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect((await lookup('doi', '10.5555/fixture', false)).statusCode).toBe(401);
  expect((await lookup('doi', 'https://example.test/doi/10.5555/fixture')).statusCode).toBe(422);
  expect((await lookup('doi', '10.5555/../../fixture')).statusCode).toBe(422);
  expect((await lookup('isbn', '9780980200440')).statusCode).toBe(422);
  expect((await lookup('pmid', '17284678,12345678')).statusCode).toBe(422);
  expect((await lookup('pmcid', 'https://example.test/articles/PMC7840891')).statusCode).toBe(422);
  expect((await lookup('pmcid', 'PMC7840891/../PMC2')).statusCode).toBe(422);
  expect((await lookup('issn', 'ISSN 0003-4861')).statusCode).toBe(422);
  expect((await lookup('arxiv', 'https://not-arxiv.test/abs/1706.03762')).statusCode).toBe(422);
  expect(fetch).not.toHaveBeenCalled();
});

it('maps public provider metadata without persisting a reference or forwarding local credentials', async () => {
  const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    const outgoing = new Headers(init?.headers);
    expect(outgoing.has('authorization')).toBe(false);
    expect(outgoing.has('cookie')).toBe(false);
    if (url.hostname === 'api.crossref.org') {
      expect(url.href).toBe('https://api.crossref.org/works/10.5555%2Flookup%3Ftest%23record');
      return Response.json({ message: {
        DOI: '10.5555/LOOKUP?TEST#RECORD', title: ['Synthetic graded rings'],
        author: [{ given: 'Ada', family: 'Example' }], type: 'journal-article',
        'container-title': ['Journal fixture'], issued: { 'date-parts': [[2025, 3]] }, volume: '7', issue: '2',
      } });
    }
    if (url.hostname === 'openlibrary.org') {
      expect(url.searchParams.get('bibkeys')).toBe('ISBN:9780980200447');
      return Response.json({ 'ISBN:9780980200447': {
        title: 'Synthetic book', subtitle: 'An introduction', authors: [{ name: 'Ada Example' }],
        publish_date: 'November 2024', publishers: [{ name: 'University Press' }], url: 'https://evil.test/not-a-book',
      } });
    }
    if (url.hostname === 'eutils.ncbi.nlm.nih.gov') {
      expect(url.searchParams.get('id')).toBe('17284678');
      return Response.json({ result: { '17284678': {
        uid: '17284678', title: 'Synthetic PubMed article', authors: [{ name: 'Example A' }],
        pubdate: '2023 Jan', fulljournalname: 'Medical journal fixture',
        articleids: [{ idtype: 'doi', value: '10.5555/pmid-fixture' }],
      } } });
    }
    expect(url.hostname).toBe('export.arxiv.org');
    expect(url.searchParams.get('id_list')).toBe('2611.12342v2');
    return new Response(`<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><id>https://arxiv.org/abs/2611.12342v2</id><title>Synthetic arXiv fixture</title>
      <published>2026-11-11T00:00:00Z</published><updated>2026-11-12T00:00:00Z</updated>
      <summary>A mathematical abstract.</summary><author><name>Ada Example</name></author></entry></feed>`);
  });
  vi.stubGlobal('fetch', fetch);
  const [doi, isbn, pmid, arxiv] = await Promise.all([
    lookup('doi', 'https://doi.org/10.5555/LOOKUP?TEST#RECORD'),
    lookup('isbn', 'ISBN 978-0-9802004-4-7'),
    lookup('pmid', 'https://pubmed.ncbi.nlm.nih.gov/17284678/'),
    lookup('arxiv', 'https://arxiv.org/pdf/2611.12342v2.pdf'),
  ]);
  expect(doi.json()).toMatchObject({
    kind: 'doi', identifier: '10.5555/lookup?test#record', reference: {
      title: 'Synthetic graded rings', authors: ['Example, Ada'], year: 2025,
      publication: { type: 'article', journal: 'Journal fixture', volume: '7', number: '2' },
      url: 'https://doi.org/10.5555/lookup%3Ftest%23record',
    },
  });
  expect(isbn.json()).toMatchObject({ reference: {
    title: 'Synthetic book: An introduction', year: 2024, url: 'https://openlibrary.org/isbn/9780980200447',
    publication: { isbn: '9780980200447', publisher: 'University Press' },
  } });
  expect(pmid.json()).toMatchObject({ reference: { doi: '10.5555/pmid-fixture', publication: { pmid: '17284678' } } });
  expect(arxiv.json()).toMatchObject({ reference: { arxiv_id: '2611.12342v2', publication: { abstract: 'A mathematical abstract.' } } });
  expect(doi.headers['cache-control']).toContain('no-store');
  expect(fetch).toHaveBeenCalledTimes(4);
  const library = await app.inject({ url: '/api/v1/research/library', headers });
  expect(library.json().items).toEqual([]);
});

it('uses previously ingested arXiv metadata without a provider request', async () => {
  await db.transaction(undefined, async (sql) => {
    await sql.query(
      `INSERT INTO arxiv_papers(id,arxiv_id,latest_version,title,authors,categories,published_at,updated_at,source_url,pdf_url)
       VALUES($1,'2611.12343',3,'Local arXiv fixture',ARRAY['Example, Ada'],ARRAY['math.AC'],now(),now(),
       'https://arxiv.org/abs/2611.12343','https://arxiv.org/pdf/2611.12343')`, [randomUUID()],
    );
  });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const response = await lookup('arxiv', '2611.12343v3');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ reference: { title: 'Local arXiv fixture', arxiv_id: '2611.12343v3' } });
  expect(fetch).not.toHaveBeenCalled();
});

it('previews an ISSN journal and a PubMed Central article through fixed providers', async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 30_000);
  const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    if (url.hostname === 'api.crossref.org') {
      expect(url.href).toBe('https://api.crossref.org/journals/0003-486X');
      return Response.json({ message: { title: 'Synthetic journal fixture', publisher: 'University Press', ISSN: ['0003-486X', '1939-8980'] } });
    }
    expect(url.origin + url.pathname).toBe('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi');
    expect(Object.fromEntries(url.searchParams)).toEqual({ db: 'pmc', id: '7840891', retmode: 'json', tool: 'PRISM' });
    return Response.json({ result: { '7840891': {
      uid: '7840891', title: 'Synthetic archived article', authors: [{ name: 'Example A' }], printpubdate: '2024 Dec',
      fulljournalname: 'Synthetic journal fixture', volume: '3', pages: '44–52',
      articleids: [{ idtype: 'pmid', value: '33248227' }, { idtype: 'pmcid', value: 'PMC7840891' }, { idtype: 'doi', value: '10.5555/archived-lookup-fixture' }],
    } } });
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const [issn, pmcid] = await Promise.all([lookup('issn', 'ISSN 0003486x'), lookup('pmcid', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7840891/')]);
    expect(issn.statusCode).toBe(200);
    expect(issn.json()).toMatchObject({ kind: 'issn', identifier: '0003-486X', reference: {
      title: 'Synthetic journal fixture', authors: [], year: null, doi: null,
      url: 'https://portal.issn.org/resource/ISSN/0003-486X',
      publication: { type: 'periodical', issn: '0003-486X', publisher: 'University Press' },
    } });
    expect(pmcid.statusCode).toBe(200);
    expect(pmcid.json()).toMatchObject({ kind: 'pmcid', identifier: 'PMC7840891', reference: {
      title: 'Synthetic archived article', authors: ['Example A'], year: 2024, doi: '10.5555/archived-lookup-fixture',
      url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7840891/',
      publication: { type: 'article', pmid: '33248227', pmcid: 'PMC7840891', volume: '3', pages: '44–52' },
    } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await lookup('pmid', '33248227')).statusCode).toBe(429);
    expect((await lookup('doi', '10.5555/other')).statusCode).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(2);

    clock.mockReturnValue(now + 31_100);
    fetch.mockImplementation(async (url: URL) => url.hostname === 'api.crossref.org'
      ? Response.json({ message: { title: 'Different journal', ISSN: ['1939-8980'] } })
      : Response.json({ result: { '7840891': { uid: '7840891', title: 'Wrong archive identifier', articleids: [{ idtype: 'pmcid', value: 'PMC1234' }] } } }));
    const [wrongIssn, wrongPmcid] = await Promise.all([lookup('issn', '0003-486X'), lookup('pmcid', 'PMC7840891')]);
    expect(wrongIssn.statusCode).toBe(404);
    expect(wrongPmcid.statusCode).toBe(404);
    const library = await app.inject({ url: '/api/v1/research/library', headers });
    expect(library.json().items).toEqual([]);
  } finally { clock.mockRestore(); }
});

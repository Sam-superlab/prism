import { parseArxivFeed } from '@prism/worker';
import { ApiError, validation } from './errors';

export type IdentifierKind = 'doi' | 'isbn' | 'issn' | 'pmid' | 'pmcid' | 'arxiv';
type SourceRecord = Record<string, unknown>;
type Reference = {
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxiv_id: string | null;
  url: string | null;
  publication: Record<string, string>;
};
type LookupResult = { kind: IdentifierKind; identifier: string; reference: Reference };

const arxivPattern = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v[1-9]\d{0,5})?$/i;
const doiPattern = /^10\.\d{4,9}\/[\x21-\x7e]+$/i;
const providers = {
  doi: 'Crossref',
  isbn: 'Open Library',
  issn: 'Crossref',
  pmid: 'PubMed',
  pmcid: 'PubMed Central',
  arxiv: 'arXiv',
} satisfies Record<IdentifierKind, string>;
const rateGroups = { doi: 'crossref', issn: 'crossref', isbn: 'openlibrary', pmid: 'ncbi', pmcid: 'ncbi', arxiv: 'arxiv' } as const;
const providerSpacingMs = { crossref: 1000, openlibrary: 1100, ncbi: 400, arxiv: 3100 } as const;

function cleanDoi(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, '').toLowerCase();
  if (normalized.length > 250 || !doiPattern.test(normalized) || /\\/.test(normalized)) return null;
  // A slash or dot segment in the registered identifier is encoded as data in the API URL.
  if (normalized.split('/').some((part) => part === '.' || part === '..')) return null;
  return normalized;
}

function cleanIsbn(value: string) {
  const digits = value.trim().replace(/^ISBN(?:-1[03])?:?\s*/i, '').replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(digits)) {
    const total = [...digits].reduce((sum, char, i) => sum + (char === 'X' ? 10 : Number(char)) * (10 - i), 0);
    return total % 11 === 0 ? digits : null;
  }
  if (/^97[89]\d{10}$/.test(digits)) {
    const total = [...digits].reduce((sum, char, i) => sum + Number(char) * (i % 2 ? 3 : 1), 0);
    return total % 10 === 0 ? digits : null;
  }
  return null;
}

function cleanIssn(value: unknown) {
  if (typeof value !== 'string') return null;
  const code = value.trim().replace(/^ISSN:?\s*/i, '').toUpperCase();
  if (!/^\d{4}-?\d{3}[\dX]$/.test(code)) return null;
  const digits = code.replace('-', '');
  const checksum = [...digits].reduce((sum, char, index) => sum + (char === 'X' ? 10 : Number(char)) * (8 - index), 0);
  return checksum % 11 === 0 ? `${digits.slice(0, 4)}-${digits.slice(4)}` : null;
}

function cleanPmcid(value: unknown) {
  if (typeof value !== 'string') return null;
  const code = value.trim().replace(/^(?:pmcid:\s*|https:\/\/pmc\.ncbi\.nlm\.nih\.gov\/articles\/)/i, '').replace(/\/$/, '').toUpperCase();
  return /^PMC[1-9]\d{0,11}$/.test(code) ? code : null;
}

export function normalizeReferenceIdentifier(kind: IdentifierKind, value: string): string {
  let identifier: string | null = null;
  switch (kind) {
    case 'doi':
      identifier = cleanDoi(value);
      break;
    case 'isbn':
      identifier = cleanIsbn(value);
      break;
    case 'issn':
      identifier = cleanIssn(value);
      break;
    case 'pmcid':
      identifier = cleanPmcid(value);
      break;
    case 'pmid': {
      const id = value.trim().replace(/^(?:pmid:\s*|https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/)/i, '').replace(/\/$/, '');
      identifier = /^[1-9]\d{0,9}$/.test(id) ? id : null;
      break;
    }
    case 'arxiv': {
      const id = value.trim().replace(/^(?:arxiv:\s*|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)/i, '').replace(/\.pdf$/i, '');
      identifier = arxivPattern.test(id) ? id.toLowerCase() : null;
      break;
    }
  }
  if (!identifier) throw validation(`Enter a valid ${kind === 'arxiv' ? 'arXiv ID' : kind.toUpperCase()}.`);
  return identifier;
}

function record(value: unknown): SourceRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as SourceRecord : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown, limit = 2000) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function firstText(value: unknown) {
  return text(list(value)[0]);
}
function year(value: unknown): number | null {
  const match = /\b\d{4}\b/.exec(text(value, 100));
  const parsed = match ? Number(match[0]) : null;
  return parsed && parsed <= 9999 ? parsed : null;
}
function yearsFromDateParts(value: unknown) {
  const first = list(record(value)['date-parts'])[0];
  const parsed = Number(list(first)[0]);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 9999 ? parsed : null;
}
function metadata(fields: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields)
    .map(([name, value]) => [name, text(value, name === 'abstract' ? 12000 : 2000)])
    .filter(([, value]) => value));
}
function authors(values: unknown[], read: (value: SourceRecord) => string) {
  return values.slice(0, 100).map((value) => text(read(record(value)), 300)).filter(Boolean);
}
function safeOpenLibraryUrl(value: unknown, isbn: string) {
  try {
    const url = new URL(text(value), 'https://openlibrary.org');
    if (url.origin === 'https://openlibrary.org' && !url.username && !url.password &&
        /^\/(?:books\/OL\d+M|isbn\/\d{9}[\dX](?:\d{3})?)(?:\/|$)/i.test(url.pathname))
      return url.href;
  } catch {
    // Use the canonical ISBN link if provider metadata omits a valid edition URL.
  }
  return `https://openlibrary.org/isbn/${isbn}`;
}

function doiReference(payload: unknown, id: string): Reference | null {
  const item = record(record(payload).message);
  if (cleanDoi(item.DOI) !== id) return null;
  const type = text(item.type);
  const venue = firstText(item['container-title']);
  const mappedType =
    type === 'journal-article' ? 'article' :
    type === 'proceedings-article' ? 'inproceedings' :
    type === 'book-chapter' ? 'incollection' :
    ['book', 'monograph', 'reference-book', 'edited-book'].includes(type) ? 'book' : 'misc';
  return {
    title: text(firstText(item.title), 500),
    authors: authors(list(item.author), (author) =>
      [text(author.family), text(author.given)].filter(Boolean).join(', ') || text(author.name)),
    year: yearsFromDateParts(item.issued) ?? yearsFromDateParts(item.published),
    doi: id,
    arxiv_id: null,
    url: `https://doi.org/${id.split('/').map(encodeURIComponent).join('/')}`,
    publication: metadata({
      type: mappedType, journal: mappedType === 'article' ? venue : '',
      booktitle: ['inproceedings', 'incollection'].includes(mappedType) ? venue : '',
      publisher: item.publisher, volume: item.volume, number: item.issue,
      pages: item.page ?? item['article-number'], isbn: firstText(item.ISBN), issn: firstText(item.ISSN),
    }),
  };
}
function isbnReference(payload: unknown, id: string): Reference | null {
  const item = record(record(payload)[`ISBN:${id}`]);
  if (!Object.hasOwn(item, 'title')) return null;
  return {
    title: text([text(item.title), text(item.subtitle)].filter(Boolean).join(': '), 500),
    authors: authors(list(item.authors), (author) => text(author.name)),
    year: year(item.publish_date),
    doi: null, arxiv_id: null, url: safeOpenLibraryUrl(item.url, id),
    publication: metadata({
      type: 'book', isbn: id, publisher: list(item.publishers).map((publisher) => text(record(publisher).name)).filter(Boolean).join('; '),
    }),
  };
}
function issnReference(payload: unknown, id: string): Reference | null {
  const item = record(record(payload).message);
  if (!list(item.ISSN).some((entry) => cleanIssn(entry) === id)) return null;
  return {
    title: text(item.title, 500), authors: [], year: null, doi: null, arxiv_id: null,
    url: `https://portal.issn.org/resource/ISSN/${id}`,
    publication: metadata({ type: 'periodical', issn: id, publisher: item.publisher }),
  };
}

function ncbiReference(payload: unknown, id: string, archive = false): Reference | null {
  const uid = archive ? id.slice(3) : id;
  const item = record(record(record(payload).result)[uid]);
  if (String(item.uid) !== uid || item.error) return null;
  const articleIds = list(item.articleids).map(record);
  const articleId = (kind: string) => articleIds.find((entry) => entry.idtype === kind)?.value;
  const pmcid = cleanPmcid(articleId('pmcid'));
  if (archive && pmcid !== id) return null;
  const pmid = archive ? text(articleId('pmid'), 20) : id;
  return {
    title: text(item.title, 500),
    authors: authors(list(item.authors), (author) => text(author.name)),
    year: year(item.pubdate) ?? year(item.epubdate) ?? year(item.printpubdate),
    doi: cleanDoi(articleId('doi')),
    arxiv_id: null, url: archive ? `https://pmc.ncbi.nlm.nih.gov/articles/${id}/` : `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
    publication: metadata({
      type: 'article', pmid: /^[1-9]\d{0,9}$/.test(pmid) ? pmid : null, pmcid, journal: item.fulljournalname ?? item.source,
      volume: item.volume, number: item.issue, pages: item.pages, issn: item.issn,
    }),
  };
}
export function arxivReference(
  item: { arxiv_id: string; latest_version: number; title: string; authors: string[]; abstract?: string; published_at: string },
  id: string,
): Reference | null {
  const versioned = `${item.arxiv_id.toLowerCase()}v${item.latest_version}`;
  if (![item.arxiv_id.toLowerCase(), versioned].includes(id)) return null;
  return {
    title: text(item.title, 500),
    authors: item.authors.slice(0, 100).map((author) => text(author, 300)).filter(Boolean),
    year: year(item.published_at),
    doi: null, arxiv_id: id, url: `https://arxiv.org/abs/${id}`,
    publication: metadata({ type: 'misc', abstract: item.abstract }),
  };
}

async function boundedBody(response: Response) {
  if (!response.body) throw new Error('Missing response');
  const limit = 1_048_576;
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel().catch(() => {});
    throw new Error('Oversized response');
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Oversized response');
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(parts, size).toString('utf8');
}

function providerUrl(kind: IdentifierKind, identifier: string): URL {
  switch (kind) {
    case 'doi':
      return new URL(`https://api.crossref.org/works/${encodeURIComponent(identifier)}`);
    case 'issn':
      return new URL(`https://api.crossref.org/journals/${identifier}`);
    case 'isbn':
      return new URL(`https://openlibrary.org/api/books?${new URLSearchParams({
        bibkeys: `ISBN:${identifier}`, jscmd: 'data', format: 'json',
      })}`);
    case 'pmid':
    case 'pmcid':
      return new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${new URLSearchParams({
        db: kind === 'pmid' ? 'pubmed' : 'pmc', id: kind === 'pmid' ? identifier : identifier.slice(3), retmode: 'json', tool: 'PRISM',
      })}`);
    case 'arxiv':
      return new URL(`https://export.arxiv.org/api/query?${new URLSearchParams({
        id_list: identifier, max_results: '1',
      })}`);
  }
}

export function createReferenceLookup() {
  const lastRequest = new Map<(typeof rateGroups)[IdentifierKind], number>();
  const pending = new Map<string, Promise<LookupResult>>();
  return async (kind: IdentifierKind, id: string): Promise<LookupResult> => {
    const key = `${kind}:${id}`;
    const rateGroup = rateGroups[kind];
    const running = pending.get(key);
    if (running) return running;
    if (Date.now() - (lastRequest.get(rateGroup) ?? 0) < providerSpacingMs[rateGroup])
      throw new ApiError(429, 'RATE_LIMITED', `Wait a moment before another ${providers[kind]} lookup.`);
    lastRequest.set(rateGroup, Date.now());
    const lookup = (async () => {
      try {
        const response = await fetch(providerUrl(kind, id), {
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
          headers: {
            Accept: kind === 'arxiv' ? 'application/atom+xml' : 'application/json',
            'User-Agent': 'PRISM Reference Lookup (+https://github.com/Sam-superlab/prism)',
          },
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (response.status === 404) throw new ApiError(404, 'NOT_FOUND', 'No reference found for this identifier.');
          if (response.status === 429)
            throw new ApiError(503, 'LOOKUP_BUSY', `${providers[kind]} is busy. Try again shortly.`);
          throw new Error('Provider request failed');
        }
        const data = await boundedBody(response);
        const parser = { doi: doiReference, isbn: isbnReference, issn: issnReference, pmid: ncbiReference,
          pmcid: (payload: unknown, identifier: string) => ncbiReference(payload, identifier, true) };
        const reference = kind === 'arxiv'
          ? parseArxivFeed(data).papers.map((item) => arxivReference(item, id)).find(Boolean)
          : parser[kind](JSON.parse(data), id);
        if (!reference?.title) throw new ApiError(404, 'NOT_FOUND', 'No reference found for this identifier.');
        return { kind, identifier: id, reference };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
          throw new ApiError(504, 'LOOKUP_TIMEOUT', `${providers[kind]} took too long to respond.`);
        throw new ApiError(502, 'LOOKUP_UNAVAILABLE', `Unable to read metadata from ${providers[kind]}. Try again shortly.`);
      }
    })();
    pending.set(key, lookup);
    try {
      return await lookup;
    } finally {
      pending.delete(key);
    }
  };
}

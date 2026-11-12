import { readLimitedBody } from './request-body';
import {
  arxivReferencePattern,
  doiPattern,
  safeReferenceUrl,
  zoteroKeyPattern,
  type ReferenceFields,
  type ZoteroCollection,
  type ZoteroPage,
} from './zotero-reference';

const zoteroApi = 'http://127.0.0.1:23119/api/users/0/';
const pageSize = 25;

export class ZoteroError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function decodeCollection(value: unknown): ZoteroCollection | null {
  const item = object(value);
  const data = object(item?.data);
  const key = string(item?.key, 100);
  const name = string(data?.name, 500);
  const parent = string(data?.parentCollection, 100);
  return zoteroKeyPattern.test(key) && name
    ? { key, name, parent: zoteroKeyPattern.test(parent) ? parent : null }
    : null;
}

function decodeItem(value: unknown): ReferenceFields | null {
  const item = object(value);
  const data = object(item?.data);
  const key = string(item?.key, 100);
  const title = string(data?.title, 500);
  if (
    !data ||
    !title ||
    !zoteroKeyPattern.test(key) ||
    ['attachment', 'note', 'annotation'].includes(String(data.itemType))
  )
    return null;
  const creators = Array.isArray(data.creators) ? data.creators.map(object) : [];
  const authors = creators.filter((creator) => creator?.creatorType === 'author');
  const contributors = authors.length
    ? authors
    : creators.filter((creator) => creator?.creatorType === 'editor');
  const url = safeReferenceUrl(string(data.url, 2000));
  const doi = string(data.DOI, 250).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  const arxivId = url?.match(
    /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?(?:[?#]|$)/i,
  )?.[1];
  const year = Number(string(data.date, 100).match(/\b[1-9]\d{3}\b/)?.[0]) || null;
  return {
    title,
    authors: contributors
      .map((creator) => {
        const last = string(creator?.lastName, 200);
        const first = string(creator?.firstName, 100);
        return string(creator?.name, 300) || [last, first].filter(Boolean).join(', ').slice(0, 300);
      })
      .filter(Boolean)
      .slice(0, 100),
    year,
    doi: doiPattern.test(doi) ? doi.toLowerCase() : null,
    arxiv_id: arxivId && arxivReferencePattern.test(arxivId) ? arxivId : null,
    url: url && url.length <= 2000 ? url : null,
    zotero_key: key,
  };
}

async function readPage<T>(path: string, start: number, decode: (value: unknown) => T | null, search = '') {
  const url = new URL(path, zoteroApi);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('start', String(start));
  if (search) url.searchParams.set('q', search);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'Zotero-API-Version': '3' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    throw new ZoteroError(503, 'Open Zotero and try again.');
  }
  if (response.status === 403)
    throw new ZoteroError(
      503,
      'In Zotero Settings → Advanced, allow other applications to communicate with Zotero.',
    );
  if (!response.ok) throw new ZoteroError(502, 'Zotero could not load this collection.');
  try {
    const bytes = await readLimitedBody(response, 2 * 1024 * 1024);
    const rows: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(rows) || rows.length > pageSize) throw new Error('Invalid page');
    const items = rows.map(decode).filter((item): item is T => item !== null);
    const count = response.headers.get('Total-Results');
    const hasMore = count === null ? rows.length === pageSize : start + rows.length < Number(count);
    return { items, next: rows.length && hasMore ? start + rows.length : null } satisfies ZoteroPage<T>;
  } catch {
    throw new ZoteroError(502, 'Zotero returned an unreadable page.');
  }
}

export function readZoteroCollections(start: number) {
  return readPage('collections', start, decodeCollection);
}

export function readZoteroItems(collection: string, start: number, search: string) {
  if (!zoteroKeyPattern.test(collection)) throw new ZoteroError(400, 'Choose a Zotero collection.');
  return readPage(`collections/${collection}/items/top`, start, decodeItem, search);
}

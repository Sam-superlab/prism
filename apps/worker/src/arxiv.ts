import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { rankSubscriptionMatches } from '@prism/core';

export interface ArxivPaper {
  arxiv_id: string;
  latest_version: number;
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  published_at: string;
  updated_at: string;
  source_url: string;
  pdf_url: string;
}
export interface Subscription {
  subscription_type: 'category' | 'keyword' | 'author' | 'topic';
  subscription_value: string;
  enabled: boolean;
  weight?: number;
}
export interface RankedPaper extends ArxivPaper {
  relevance_score: number;
  match_reasons: string[];
}
const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const clean = (value: unknown) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export function parseArxivIdentifier(value: string): { id: string; version: number } {
  const raw = value.replace(/^https?:\/\/[^/]+\/(?:abs|pdf)\//, '').replace(/\.pdf$/, '');
  const match = raw.match(/^((?:\d{4}\.\d{4,5}|[a-zA-Z][a-zA-Z.-]*\/\d{7}))(?:v([1-9]\d*))?$/);
  if (!match) throw new Error('Malformed arXiv identifier');
  return { id: match[1], version: Number(match[2] ?? 1) };
}

export function parseArxivFeed(xml: string): { papers: ArxivPaper[]; quarantined: string[]; total: number } {
  if (xml.length > 8_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('Unsafe or oversized arXiv response');
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed arXiv XML');
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false }).parse(
    xml,
  );
  const feed = parsed.feed;
  if (!feed || typeof feed !== 'object') throw new Error('Missing Atom feed');
  const papers: ArxivPaper[] = [],
    quarantined: string[] = [];
  for (const entry of list<Record<string, unknown>>(feed.entry)) {
    try {
      if (String(entry.id).includes('/api/errors'))
        throw new Error(`arXiv API error: ${clean(entry.summary) || 'Unknown source error'}`);
      const identifier = parseArxivIdentifier(clean(entry.id));
      const title = clean(entry.title),
        published = new Date(clean(entry.published)),
        updated = new Date(clean(entry.updated));
      if (!title || !Number.isFinite(published.getTime()) || !Number.isFinite(updated.getTime()))
        throw new Error('Missing title or valid dates');
      papers.push({
        arxiv_id: identifier.id,
        latest_version: identifier.version,
        title,
        abstract: clean(entry.summary),
        authors: list<Record<string, unknown>>(entry.author as Record<string, unknown>[])
          .map((author) => clean(author.name))
          .filter(Boolean),
        categories: list<Record<string, unknown>>(entry.category as Record<string, unknown>[])
          .map((category) => clean(category['@_term']))
          .filter(Boolean),
        published_at: published.toISOString(),
        updated_at: updated.toISOString(),
        source_url: `https://arxiv.org/abs/${identifier.id}`,
        pdf_url: `https://arxiv.org/pdf/${identifier.id}`,
      });
    } catch (error) {
      quarantined.push(error instanceof Error ? error.message : 'Invalid entry');
    }
  }
  if (!papers.length && quarantined.some((error) => error.includes('arXiv API')))
    throw new Error(quarantined.join('; '));
  return { papers, quarantined, total: Number(feed.totalResults ?? papers.length) };
}

export function rankPaper(paper: ArxivPaper, subscriptions: Subscription[]): RankedPaper {
  return { ...paper, ...rankSubscriptionMatches(paper, subscriptions) };
}

export function arxivQuery(subscriptions: Subscription[]): string {
  const quote = (s: string) => `"${s.replace(/["\\]/g, ' ').trim()}"`;
  return subscriptions
    .filter((sub) => sub.enabled)
    .map((sub) => {
      if (sub.subscription_type === 'category') {
        if (!/^[A-Za-z][A-Za-z.-]*$/.test(sub.subscription_value)) throw new Error('Invalid arXiv category');
        return `cat:${sub.subscription_value}`;
      }
      if (sub.subscription_type === 'author') return `au:${quote(sub.subscription_value)}`;
      return `(ti:${quote(sub.subscription_value)} OR abs:${quote(sub.subscription_value)})`;
    })
    .join(' OR ');
}

export class ArxivFetchError extends Error {
  constructor(
    message: string,
    public retryAfterMs = 0,
  ) {
    super(message);
  }
}

export async function fetchRecentPapers(
  subscriptions: Subscription[],
  options: {
    fetch?: typeof fetch;
    now?: Date;
    userAgent?: string;
    since?: Date;
    withRateLimit: <T>(action: () => Promise<T>) => Promise<T>;
  },
): Promise<{ papers: RankedPaper[]; quarantined: string[] }> {
  if (!subscriptions.some((sub) => sub.enabled)) return { papers: [], quarantined: [] };
  const query = arxivQuery(subscriptions);
  if (query.length > 6000)
    throw new Error('Subscription query too broad; split subscriptions before ingestion');
  const cutoff = Math.min(
    (options.now ?? new Date()).getTime(),
    options.since?.getTime() ?? Infinity,
    (options.now ?? new Date()).getTime() - 7 * 86400000,
  );
  const collected = new Map<string, ArxivPaper>();
  const quarantined: string[] = [];
  let finished = false;
  for (let start = 0; start < 2000; start += 100) {
    const url = new URL('https://export.arxiv.org/api/query');
    url.search = new URLSearchParams({
      search_query: query,
      start: String(start),
      max_results: '100',
      sortBy: 'lastUpdatedDate',
      sortOrder: 'descending',
    }).toString();
    const page = await options.withRateLimit(async () => {
      const response = await (options.fetch ?? fetch)(url, {
        headers: { 'User-Agent': options.userAgent ?? 'PRISM/0.1.0 (personal research digest)' },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        const retry = response.headers.get('Retry-After');
        const delay = retry
          ? /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Math.max(0, Date.parse(retry) - Date.now())
          : 0;
        throw new ArxivFetchError(`arXiv HTTP ${response.status}`, delay);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty arXiv response');
      const decoder = new TextDecoder();
      let xml = '',
        bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 8_000_000) {
          await reader.cancel();
          throw new Error('Oversized arXiv response');
        }
        xml += decoder.decode(chunk.value, { stream: true });
      }
      xml += decoder.decode();
      return parseArxivFeed(xml);
    });
    quarantined.push(...page.quarantined);
    for (const paper of page.papers) {
      if (Date.parse(paper.updated_at) < cutoff) {
        finished = true;
        continue;
      }
      const previous = collected.get(paper.arxiv_id);
      if (!previous || previous.latest_version < paper.latest_version) collected.set(paper.arxiv_id, paper);
    }
    if (
      start + 100 >= page.total ||
      finished ||
      (page.papers.length === 0 && page.quarantined.length === 0)
    ) {
      finished = true;
      break;
    }
  }
  if (!finished)
    throw new Error('arXiv pagination bound reached; ingestion will retry without marking completion');
  return {
    papers: [...collected.values()]
      .map((p) => rankPaper(p, subscriptions))
      .filter((p) => p.relevance_score > 0)
      .sort(
        (a, b) =>
          b.relevance_score - a.relevance_score ||
          b.updated_at.localeCompare(a.updated_at) ||
          a.arxiv_id.localeCompare(b.arxiv_id),
      ),
    quarantined,
  };
}

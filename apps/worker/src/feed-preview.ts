import { createHash } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request, type RequestOptions } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import ipaddr from 'ipaddr.js';
import { invalidLiteratureFeedUrl, normalizeLiteratureFeedUrl, type LiteratureFeedPreview } from '@prism/core';
import { ApiError } from '@prism/core/errors';

const maxBodyBytes = 512 * 1024;
const maxEntries = 50;
const dnsTimeoutMs = 3000;
const requestTimeoutMs = 7000;
const activeLimit = 4;

type FeedResponse = AsyncIterable<Uint8Array> & {
  statusCode?: number;
  headers: IncomingHttpHeaders;
  destroy(): unknown;
};
type Dependencies = {
  resolve: (hostname: string) => Promise<LookupAddress[]>;
  open: (url: URL, options: RequestOptions) => Promise<FeedResponse>;
};

const fetchFailed = () => new ApiError(502, 'FEED_UNAVAILABLE', 'The feed could not be reached or did not return a successful response.');
const parseFailed = () => new ApiError(422, 'INVALID_FEED', 'The URL did not return a supported RSS or Atom feed.');

function isPublicAddress(result: LookupAddress): boolean {
  const { address, family } = result;
  if (family !== 4 && family !== 6 || isIP(address) !== family || address.includes('%')) return false;
  const ip = ipaddr.parse(address);
  if (ip.range() !== 'unicast') return false;
  if (ip.kind() === 'ipv4') return true;
  return ip.match(ipaddr.IPv6.parse('2000::'), 3);
}

async function resolveWithin(resolve: Dependencies['resolve'], hostname: string): Promise<LookupAddress[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolve(hostname),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(fetchFailed()), dnsTimeoutMs); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function openHttps(url: URL, options: RequestOptions): Promise<FeedResponse> {
  return new Promise((resolve, reject) => {
    const outbound = request(url, options, resolve);
    outbound.on('error', reject);
    outbound.end();
  });
}

async function readFeed(response: FeedResponse): Promise<string> {
  try {
    if (response.statusCode !== 200) throw fetchFailed();
    const type = response.headers['content-type']?.toLowerCase() ?? '';
    const encoding = response.headers['content-encoding']?.toLowerCase();
    if (encoding && encoding !== 'identity' || type.includes('text/html') ||
        type.includes('application/xhtml+xml')) throw parseFailed();
    if (Number(response.headers['content-length']) > maxBodyBytes) throw parseFailed();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response) {
      length += chunk.byteLength;
      if (length > maxBodyBytes) throw parseFailed();
      chunks.push(chunk);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
    } catch {
      throw parseFailed();
    }
  } finally {
    response.destroy();
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  processEntities: false,
  parseTagValue: false,
  maxNestedTags: 24,
});

type Element = Record<string, unknown>;
const record = (value: unknown): Element | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Element : undefined;
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string => typeof value === 'string' ? value : textNode(record(value)?.['#text']);
const textNode = (value: unknown): string => typeof value === 'string' ? value : '';
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value: string): string {
  return value.replace(/&(#(?:x[\da-f]{1,6}|\d{1,7})|amp|lt|gt|quot|apos|nbsp);/gi, (_, token: string) => {
    if (token[0] !== '#') return entities[token.toLowerCase()] ?? '';
    const point = /^#x/i.test(token) ? parseInt(token.slice(2), 16) : Number(token.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
  });
}

function plain(value: unknown, max: number, html = false): string {
  const source = text(value);
  const decoded = html ? decodeEntities(source).replace(/<\/?[a-z][^<>]*>/gi, ' ') : source;
  return decodeEntities(decoded).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
}

function itemUrl(value: unknown, base: URL): string | null {
  const href = decodeEntities(text(value)).trim();
  if (!href || href.length > 2000) return null;
  try {
    const url = new URL(href, base);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password &&
        url.href.length <= 2000) return url.href;
  } catch {
    // The entry is still useful without a link.
  }
  return null;
}

function atomLink(value: unknown, base: URL): string | null {
  for (const candidate of list(value)) {
    const link = record(candidate);
    if (!link || (link['@_rel'] !== undefined && link['@_rel'] !== 'alternate')) continue;
    const url = itemUrl(link['@_href'], base);
    if (url) return url;
  }
  return null;
}

function published(value: unknown): string | null {
  const timestamp = Date.parse(text(value));
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp).toISOString();
  return date.length === 24 ? date : null;
}

function parseFeed(xml: string, base: URL): LiteratureFeedPreview {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw parseFailed();
  let parsed: Element;
  try {
    parsed = parser.parse(xml, true) as Element;
  } catch {
    throw parseFailed();
  }
  const atom = record(parsed.feed);
  const rdf = record(parsed.RDF);
  const channel = atom ?? record((rdf ?? record(parsed.rss))?.channel);
  if (!channel) throw parseFailed();
  const items: LiteratureFeedPreview['items'] = [];
  const seen = new Set<string>();
  for (const raw of list(atom ? channel.entry : rdf ? rdf.item : channel.item)) {
    const entry = record(raw);
    if (!entry) continue;
    const title = plain(entry.title, 500, record(entry.title)?.['@_type'] === 'html');
    if (!title) continue;
    const url = atom ? atomLink(entry.link, base) : itemUrl(entry.link, base);
    const date = atom ? published(entry.published) ?? published(entry.updated) : published(entry.pubDate ?? entry.date);
    const sourceId = plain(atom ? entry.id : entry.guid, 2000) || url || `${title}\n${date ?? ''}`;
    const external_id = createHash('sha256').update(sourceId).digest('hex');
    if (seen.has(external_id)) continue;
    seen.add(external_id);
    const authors = list(atom ? entry.author ?? channel.author : entry.creator ?? entry.author)
      .map((author) => plain(atom ? record(author)?.name : author, 200)).filter(Boolean).slice(0, 30);
    items.push({
      external_id,
      title,
      url,
      authors: [...new Set(authors)],
      published_at: date,
      summary: plain(atom ? entry.summary ?? entry.content : entry.description ?? entry.encoded, 4000, true) || null,
    });
    if (items.length === maxEntries) break;
  }
  return { url: base.href, title: plain(channel.title, 500, record(channel.title)?.['@_type'] === 'html') || base.hostname, items };
}

export function createFeedPreview(dependencies: Partial<Dependencies> = {}) {
  const resolve = dependencies.resolve ?? ((hostname: string) => lookup(hostname, { all: true, order: 'verbatim' }));
  const open = dependencies.open ?? openHttps;
  let active = 0;
  return async (value: string, abort?: AbortSignal): Promise<LiteratureFeedPreview> => {
    const url = normalizeLiteratureFeedUrl(value);
    if (active >= activeLimit) throw new ApiError(429, 'RATE_LIMITED', 'Too many feed previews are running. Try again shortly.');
    active++;
    try {
      abort?.throwIfAborted();
      const addresses = await resolveWithin(resolve, url.hostname);
      abort?.throwIfAborted();
      if (!addresses.length || addresses.some((result) => !isPublicAddress(result))) throw invalidLiteratureFeedUrl();
      const pinned = addresses[0];
      const response = await open(url, {
        agent: false,
        servername: url.hostname,
        rejectUnauthorized: true,
        family: pinned.family,
        lookup: (hostname, options, callback) => {
          if (hostname !== url.hostname) return callback(new Error('Unexpected feed hostname.'), '', pinned.family);
          callback(null, options.all ? [pinned] : pinned.address, pinned.family);
        },
        signal: AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), ...(abort ? [abort] : [])]),
        headers: {
          Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml',
          'Accept-Encoding': 'identity',
          'User-Agent': 'PRISM Feed Preview',
        },
      });
      return parseFeed(await readFeed(response), url);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw fetchFailed();
    } finally {
      active--;
    }
  };
}

import { isIP } from 'node:net';
import { validation } from './errors';

export type LiteratureFeedItem = {
  external_id: string;
  title: string;
  url: string | null;
  authors: string[];
  published_at: string | null;
  summary: string | null;
};
export type LiteratureFeedPreview = { url: string; title: string; items: LiteratureFeedItem[] };

const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const specialHostname = /(?:^|\.)(?:localhost|local|internal|home\.arpa|test|example|invalid|onion)$/;
export const invalidLiteratureFeedUrl = () => validation('Enter a public HTTPS feed URL.');

export function normalizeLiteratureFeedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidLiteratureFeedUrl();
  }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.port || url.username || url.password || host.length > 253 ||
      isIP(host) || !host.includes('.') || !host.split('.').every((part) => label.test(part)) || specialHostname.test(host))
    throw invalidLiteratureFeedUrl();
  url.hash = '';
  if (url.href.length > 2000) throw invalidLiteratureFeedUrl();
  return url;
}

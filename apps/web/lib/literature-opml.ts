export type LiteratureOpmlFeed = { title: string; url: string };

export type LiteratureOpmlIssue = {
  title: string;
  url: string | null;
  reason: 'invalid-url' | 'duplicate' | 'missing-url' | 'unsupported-type';
};

export const maxLiteratureOpmlBytes = 512 * 1024;
export const maxLiteratureOpmlEntries = 200;
const maxOutlineNodes = 1000;
const maxOutlineDepth = 20;
const maxTitleLength = 500;
const hostLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const specialHostname = /(?:^|\.)(?:localhost|local|internal|home\.arpa|test|example|invalid|onion)$/;
const feedTypes = new Set(['rss', 'atom', 'rdf', 'xml']);

function publicFeedUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      host.length > 253 ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      !host.includes('.') ||
      !host.split('.').every((part) => hostLabel.test(part)) ||
      specialHostname.test(host)
    )
      return;
    url.hash = '';
    if (url.href.length <= 2000) return url;
  } catch {
    return;
  }
}

function outlineTitle(outline: Element) {
  return (
    [outline.getAttribute('title'), outline.getAttribute('text')]
      .find((value) => value?.trim())
      ?.trim()
      .slice(0, maxTitleLength) ?? ''
  );
}

export function parseLiteratureOpml(source: string): {
  feeds: LiteratureOpmlFeed[];
  skipped: LiteratureOpmlIssue[];
} {
  if (
    source.length > maxLiteratureOpmlBytes ||
    new TextEncoder().encode(source).byteLength > maxLiteratureOpmlBytes
  )
    throw new Error('Choose an OPML file no larger than 512 KiB.');
  const xml = source.trimStart();
  const content = xml.replace(/^<\?xml\s+[^?]*\?>/i, '');
  const declarations = content.replace(/<!--[\s\S]*?-->/g, '');
  if (/<!\s*(?:doctype|entity)\b|<\?/i.test(declarations))
    throw new Error('This OPML file contains unsupported XML declarations.');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  if (document.doctype || document.getElementsByTagName('parsererror').length || root.localName !== 'opml')
    throw new Error('Choose a valid OPML file.');
  const body = Array.from(root.children).find((element) => element.localName === 'body');
  if (!body) throw new Error('This OPML file is missing its body.');

  const feeds: LiteratureOpmlFeed[] = [];
  const skipped: LiteratureOpmlIssue[] = [];
  const seen = new Set<string>();
  let outlineNodes = 0;
  let entries = 0;

  function read(parent: Element, depth: number) {
    for (const outline of parent.children) {
      if (outline.localName !== 'outline') continue;
      if (++outlineNodes > maxOutlineNodes || depth > maxOutlineDepth)
        throw new Error('This OPML file contains too many nested outlines.');
      const type = outline.getAttribute('type')?.trim().toLowerCase();
      const rawUrl = outline.getAttribute('xmlUrl')?.trim() || null;
      if (outline.getAttribute('isComment')?.toLowerCase() === 'true') continue;
      if (outline.hasAttribute('xmlUrl') || (type && feedTypes.has(type))) {
        if (++entries > maxLiteratureOpmlEntries)
          throw new Error('This OPML file contains more than 200 subscriptions.');
        const title = outlineTitle(outline);
        const url = rawUrl && publicFeedUrl(rawUrl);
        const reason =
          type && !feedTypes.has(type)
            ? 'unsupported-type'
            : !rawUrl
              ? 'missing-url'
              : !url
                ? 'invalid-url'
                : seen.has(url.href)
                  ? 'duplicate'
                  : undefined;
        if (reason) skipped.push({ title, url: rawUrl?.slice(0, 2000) ?? null, reason });
        else if (url) {
          seen.add(url.href);
          feeds.push({ title: title || url.hostname, url: url.href });
        }
      }
      read(outline, depth + 1);
    }
  }
  read(body, 1);
  return { feeds, skipped };
}

function escapeXml(value: string) {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
    '\t': '&#9;',
    '\n': '&#10;',
    '\r': '&#13;',
  };
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, '')
    .replace(/[&<>"'\t\n\r]/g, (character) => entities[character]!);
}

export function serializeLiteratureOpml(feeds: readonly { title?: string | null; url: string }[]): string {
  if (feeds.length > maxLiteratureOpmlEntries) throw new Error('Export up to 200 subscriptions at a time.');
  const seen = new Set<string>();
  const outlines = feeds.flatMap((feed) => {
    const url = publicFeedUrl(feed.url);
    if (!url) throw new Error('An OPML subscription does not have a public HTTPS URL.');
    if (seen.has(url.href)) return [];
    seen.add(url.href);
    const title = escapeXml(feed.title?.trim().slice(0, maxTitleLength) ?? '') || url.hostname;
    return [`    <outline text="${title}" title="${title}" type="rss" xmlUrl="${escapeXml(url.href)}"/>`];
  });
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head><title>PRISM Literature Feeds</title></head>',
    '  <body>',
    ...outlines,
    '  </body>',
    '</opml>',
    '',
  ].join('\n');
  if (new TextEncoder().encode(xml).byteLength > maxLiteratureOpmlBytes)
    throw new Error('This OPML export exceeds 512 KiB.');
  return xml;
}

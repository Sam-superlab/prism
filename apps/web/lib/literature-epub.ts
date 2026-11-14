import { decodeLiteratureXml, readLiteratureZip } from './literature-zip';

export type LiteratureEpubBlock = {
  kind: 'heading' | 'paragraph' | 'quote' | 'code' | 'list-item';
  text: string;
  level?: number;
};

export type LiteratureEpubSection = { id: string; title: string; blocks: LiteratureEpubBlock[] };
export type LiteratureEpub = {
  title: string | null;
  authors: string[];
  language: string | null;
  sections: LiteratureEpubSection[];
};

export const maxLiteratureEpubBytes = 32 * 1024 * 1024;
const maxEntries = 4096;
const maxSections = 600;
const maxXmlBytes = 2 * 1024 * 1024;
const maxTotalXmlBytes = 24 * 1024 * 1024;
const epubMime = 'application/epub+zip';
const containerPath = 'META-INF/container.xml';
const packageNamespace = 'http://www.idpf.org/2007/opf';
const containerNamespace = 'urn:oasis:names:tc:opendocument:xmlns:container';
const dcNamespace = 'http://purl.org/dc/elements/1.1/';
const xhtmlNamespace = 'http://www.w3.org/1999/xhtml';
function resolveEntry(base: string, href: string | null): string | undefined {
  if (!href || /^\s*(?:\/|[a-z][a-z0-9+.-]*:)/i.test(href) || href.includes('\\')) return;
  const raw = href.split(/[?#]/, 1)[0];
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return;
  }
  if (!path || path.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(path)) return;
  const parts = base.split('/').slice(0, -1);
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

function xmlDocument(source: string, chapter = false) {
  let xml = source.trimStart();
  if (chapter) {
    // Older EPUBs declare an XHTML DTD. Remove the declaration itself and do not
    // resolve it. Internal subsets, entities and other processing are rejected.
    xml = xml.replace(
      /^(<\?xml\s[^?]*\?>\s*)?<!DOCTYPE\s+html(?:\s+(?:PUBLIC\s+["'][^"']*["']\s+|SYSTEM\s+)["'][^"']*["'])?\s*>/i,
      '$1',
    );
  }
  if (/<!\s*(?:doctype|entity)|<\?/i.test(xml.replace(/^<\?xml\s[^?]*\?>/i, '')))
    throw new Error('This EPUB contains unsupported XML declarations.');
  // Parse as XML, never HTML. No fetched styles, frames or images, and no DOM
  // from the book is ever attached to PRISM.
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.doctype || document.getElementsByTagName('parsererror').length)
    throw new Error('This EPUB contains malformed XML.');
  return document;
}

function elements(parent: Document | Element, namespace: string, name: string) {
  return Array.from(parent.getElementsByTagNameNS(namespace, name));
}

function clean(text: string) {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

const dropElements = new Set([
  'script',
  'style',
  'nav',
  'iframe',
  'object',
  'embed',
  'form',
  'template',
  'canvas',
  'svg',
]);
const boundaries = new Set([
  'p',
  'li',
  'blockquote',
  'pre',
  'div',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'figure',
  'figcaption',
  'table',
  'tr',
  'dt',
  'dd',
]);

function chapterBlocks(body: Element) {
  const blocks: LiteratureEpubBlock[] = [];
  let pending = '';
  function flush(kind: LiteratureEpubBlock['kind'] = 'paragraph', level?: number) {
    const text = kind === 'code' ? pending.trim() : clean(pending);
    if (text) blocks.push({ kind, text, ...(level === undefined ? {} : { level }) });
    pending = '';
  }
  function walk(node: Node, depth: number, block: LiteratureEpubBlock['kind'] = 'paragraph', level?: number) {
    if (depth > 100 || blocks.length > 10_000) throw new Error('This EPUB chapter is too complex to open.');
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
      const text = node.nodeValue ?? '';
      pending += block === 'code' ? text : text.replace(/[\t\r\n]+/g, ' ');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const name = element.localName.toLowerCase();
    if (
      dropElements.has(name) ||
      element.hasAttribute('hidden') ||
      element.getAttribute('aria-hidden') === 'true'
    )
      return;
    if (name === 'br') {
      pending += '\n';
      return;
    }
    if (name === 'img') {
      const alt = element.getAttribute('alt')?.trim();
      if (alt) pending += ' [' + alt + '] ';
      return;
    }
    const heading = /^h([1-6])$/.exec(name);
    const boundary = heading || boundaries.has(name);
    if (boundary) flush(block, level);
    const kind = heading
      ? 'heading'
      : name === 'li'
        ? 'list-item'
        : name === 'blockquote'
          ? 'quote'
          : name === 'pre'
            ? 'code'
            : block;
    const nextLevel = heading ? Number(heading[1]) : level;
    for (const child of element.childNodes) walk(child, depth + 1, kind, nextLevel);
    if (name === 'td' || name === 'th') pending += ' ';
    if (boundary) flush(kind, nextLevel);
  }
  walk(body, 0);
  flush();
  return blocks;
}

export async function parseLiteratureEpub(
  bytes: ArrayBuffer | Uint8Array,
  signal?: AbortSignal,
): Promise<LiteratureEpub> {
  signal?.throwIfAborted();
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.byteLength < 22 || data.byteLength > maxLiteratureEpubBytes)
    throw new Error('Choose an EPUB no larger than 32 MiB.');
  let archive: ReturnType<typeof readLiteratureZip>;
  try {
    archive = readLiteratureZip(data, maxEntries);
  } catch {
    throw new Error('This EPUB contains an invalid ZIP archive.');
  }
  let remaining = maxTotalXmlBytes;
  const read = (name: string) => {
    const entry = archive.entries.get(name);
    if (!entry) return;
    if (entry.flags & 1) throw new Error('This EPUB contains encrypted content.');
    if (entry.size > maxXmlBytes || entry.size > remaining || entry.compressed > maxXmlBytes + 65_536)
      throw new Error('This EPUB contains too much text to open.');
    try {
      const bytes = archive.read(name)!;
      remaining -= bytes.byteLength;
      return decodeLiteratureXml(bytes);
    } catch {
      throw new Error('This EPUB contains an invalid ZIP archive.');
    }
  };
  if (read('mimetype') !== epubMime) throw new Error('This ZIP file is not an EPUB.');
  const containerSource = read(containerPath);
  if (!containerSource) throw new Error('This EPUB is missing its container metadata.');
  const container = xmlDocument(containerSource);
  const packagePath = resolveEntry(
    '',
    elements(container, containerNamespace, 'rootfile')
      .find((root) => root.getAttribute('media-type') === 'application/oebps-package+xml')
      ?.getAttribute('full-path') ?? null,
  );
  const packageSource = packagePath && read(packagePath);
  if (!packagePath || !packageSource) throw new Error('This EPUB is missing its package metadata.');
  const publication = xmlDocument(packageSource);
  const root = publication.documentElement;
  if (root.localName !== 'package' || root.namespaceURI !== packageNamespace)
    throw new Error('This EPUB package metadata is invalid.');
  const child = (name: string) =>
    Array.from(root.children).find(
      (node) => node.namespaceURI === packageNamespace && node.localName === name,
    );
  const metadata = child('metadata');
  const manifest = child('manifest');
  const spine = child('spine');
  if (!manifest || !spine) throw new Error('This EPUB is missing its reading order.');
  const chapters = elements(spine, packageNamespace, 'itemref');
  if (!chapters.length || chapters.length > maxSections)
    throw new Error('This EPUB has an unsupported number of chapters.');
  const files = new Map(
    elements(manifest, packageNamespace, 'item').flatMap((item) => {
      const id = item.getAttribute('id');
      return id ? [[id, item] as const] : [];
    }),
  );
  const sections: LiteratureEpubSection[] = [];
  for (const [index, chapter] of chapters.entries()) {
    signal?.throwIfAborted();
    // Let an in-flight cancellation or progress redraw reach the event loop.
    if (index && index % 12 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    signal?.throwIfAborted();
    const id = chapter.getAttribute('idref') ?? '';
    const file = files.get(id);
    const href = resolveEntry(packagePath, file?.getAttribute('href') ?? null);
    if (!href || !['application/xhtml+xml', 'text/html'].includes(file?.getAttribute('media-type') ?? ''))
      continue;
    const source = read(href);
    if (!source) continue;
    const document = xmlDocument(source, true);
    const body = elements(document, xhtmlNamespace, 'body')[0] ?? document.getElementsByTagName('body')[0];
    if (!body) continue;
    const blocks = chapterBlocks(body);
    if (!blocks.length) continue;
    const heading = blocks.find((block) => block.kind === 'heading')?.text;
    const title =
      heading ||
      clean(elements(document, xhtmlNamespace, 'title')[0]?.textContent ?? '') ||
      'Section ' + (sections.length + 1);
    sections.push({ id: id + ':' + index, title: title.slice(0, 160), blocks });
  }
  if (!sections.length) throw new Error('No readable chapters were found in this EPUB.');
  const metadataText = (name: string, limit: number) =>
    metadata
      ? elements(metadata, dcNamespace, name).flatMap((node) => {
          const text = clean(node.textContent ?? '');
          return text ? [text.slice(0, limit)] : [];
        })
      : [];
  return {
    title: metadataText('title', 500)[0] ?? null,
    authors: metadataText('creator', 300).slice(0, 100),
    language: metadataText('language', 40)[0] ?? null,
    sections,
  };
}

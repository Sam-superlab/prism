import { strToU8, zipSync, type Zippable } from 'fflate';
import { citationKey, citationKeyPattern, referenceUrl, type BibliographyItem } from './bibliography';
import { formatLiteratureCitations } from './bibliography-csl';
import { decodeLiteratureXml, readLiteratureZip } from './literature-zip';

export const maxLiteratureOdtBytes = 24 * 1024 * 1024;
const maxExpandedBytes = 64 * 1024 * 1024;
const maxXmlBytes = 8 * 1024 * 1024;
const mime = 'application/vnd.oasis.opendocument.text';
const office = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const textNs = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const manifestNs = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0';
const tableNs = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const citePattern = /\[\[cite:([a-z0-9_./:+-]{1,180})(?:\|([0-9A-Za-z., –—-]{1,35}))?\]\]/gi;
const bibliographyMarker = '[[bibliography]]';
const indexName = 'PRISM_Bibliography';
const bibliographyTypes = new Set([
  'article',
  'book',
  'booklet',
  'conference',
  'inbook',
  'incollection',
  'inproceedings',
  'journal',
  'manual',
  'mastersthesis',
  'misc',
  'phdthesis',
  'proceedings',
  'techreport',
  'unpublished',
  'www',
]);
const typeAliases: Record<string, string> = {
  'article-journal': 'article',
  'paper-conference': 'inproceedings',
  chapter: 'incollection',
  online: 'www',
  webpage: 'www',
  thesis: 'phdthesis',
  report: 'techreport',
};

function readXml(bytes: Uint8Array | undefined, namespace: string, name: string) {
  if (!bytes || bytes.byteLength > maxXmlBytes)
    throw new Error('An OpenDocument XML part is missing or too large.');
  const source = decodeLiteratureXml(bytes);
  if (/<!\s*(?:doctype|entity)|<\?/i.test(source.replace(/^<\?xml\s+[^?]*\?>/i, '')))
    throw new Error('The OpenDocument contains unsupported XML declarations.');
  const document = new DOMParser().parseFromString(source, 'application/xml');
  if (
    document.getElementsByTagName('parsererror').length ||
    document.documentElement.namespaceURI !== namespace ||
    document.documentElement.localName !== name
  )
    throw new Error('The OpenDocument contains an unsupported XML part.');
  return document;
}

function textElement(document: Document, name: string, value?: string) {
  const node = document.createElementNS(textNs, 'text:' + name);
  if (value) node.textContent = validXml(value);
  return node;
}

function validXml(value: string) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, '');
}

function attribute(node: Element, name: string, value: string) {
  node.setAttributeNS(textNs, 'text:' + name, validXml(value));
}

function bibliographyType(item: BibliographyItem) {
  const type = item.publication?.type?.toLowerCase() ?? '';
  if (bibliographyTypes.has(type)) return type;
  if (Object.hasOwn(typeAliases, type)) return typeAliases[type];
  return item.publication?.journal ? 'article' : item.url || item.arxiv_id ? 'www' : 'misc';
}

function referenceMark(document: Document, item: BibliographyItem, identifier: string) {
  const node = textElement(document, 'bibliography-mark', `[${identifier}]`);
  const publication = item.publication;
  for (const [name, value] of [
    ['identifier', identifier],
    ['bibliography-type', bibliographyType(item)],
    ['title', item.title],
    ['author', item.authors.join('; ')],
    ['year', item.year?.toString()],
    ['url', referenceUrl(item)],
    ['journal', publication?.journal],
    ['booktitle', publication?.booktitle],
    ['publisher', publication?.publisher],
    ['address', publication?.address],
    ['volume', publication?.volume],
    ['number', publication?.number],
    ['pages', publication?.pages],
    ['editor', publication?.editor],
    ['isbn', publication?.isbn],
    ['issn', publication?.issn],
    ['edition', publication?.edition],
    ['series', publication?.series],
    ['institution', publication?.institution],
    ['custom1', item.doi],
    ['custom2', item.arxiv_id],
  ] as const)
    if (value) attribute(node, name, value);
  return node;
}

function bibliographyIndex(document: Document, items: readonly BibliographyItem[], paragraph: Element) {
  const index = textElement(document, 'bibliography');
  attribute(index, 'name', indexName);
  const source = textElement(document, 'bibliography-source');
  const title = textElement(document, 'index-title-template', 'Bibliography');
  source.append(title);
  const paragraphStyle = paragraph.getAttributeNS(textNs, 'style-name');
  for (const type of bibliographyTypes) {
    const template = textElement(document, 'bibliography-entry-template');
    attribute(template, 'bibliography-type', type);
    if (paragraphStyle) attribute(template, 'style-name', paragraphStyle);
    for (const [field, after] of [
      ['author', '. '],
      ['year', '. '],
      ['title', '. '],
      [type === 'article' ? 'journal' : 'publisher', '. '],
      ['url', ''],
    ]) {
      const entry = textElement(document, 'index-entry-bibliography');
      attribute(entry, 'bibliography-data-field', field);
      template.append(entry);
      if (after) template.append(textElement(document, 'index-entry-span', after));
    }
    source.append(template);
  }
  const body = textElement(document, 'index-body');
  const header = textElement(document, 'index-title');
  attribute(header, 'name', indexName + '_Title');
  header.append(textElement(document, 'p', 'Bibliography'));
  body.append(header);
  for (const line of formatLiteratureCitations(items, 'apa').bibliography.split(/\r?\n/).filter(Boolean)) {
    const entry = textElement(document, 'p', line);
    if (paragraphStyle) attribute(entry, 'style-name', paragraphStyle);
    body.append(entry);
  }
  index.append(source, body);
  return index;
}

function displayLocator(locator: string) {
  const label = /^(?:p|pp|page|pages)\.?\s/iu.test(locator) ? '' : /[-–—,]/u.test(locator) ? 'pp. ' : 'p. ';
  return ` (${label}${locator})`;
}

function isPlainParagraph(paragraph: Element, root: Element) {
  for (let node = paragraph.parentElement; node && node !== root; node = node.parentElement) {
    if (node.namespaceURI === textNs && ['list', 'list-item', 'section'].includes(node.localName)) continue;
    if (
      node.namespaceURI === tableNs &&
      ['table', 'table-row', 'table-cell', 'table-header-rows', 'table-rows'].includes(node.localName)
    )
      continue;
    return false;
  }
  return true;
}

export function buildLiteratureOdtExport(input: ArrayBuffer, items: readonly BibliographyItem[]) {
  if (input.byteLength < 22 || input.byteLength > maxLiteratureOdtBytes)
    throw new Error('Choose an ODT file no larger than 24 MiB.');
  const zip = readLiteratureZip(new Uint8Array(input), 2000);
  let expanded = 0;
  for (const [path, part] of zip.entries) {
    expanded += part.size;
    if (expanded > maxExpandedBytes) throw new Error('The OpenDocument exceeds the expanded size limit.');
    if (/^META-INF\/.*signatures|^(?:Basic|Scripts)\//i.test(path))
      throw new Error('Choose an unsigned ODT without macros.');
  }
  const mediaType = zip.read('mimetype');
  if (!mediaType || decodeLiteratureXml(mediaType) !== mime)
    throw new Error('Choose a standard ODT document.');
  const manifest = readXml(zip.read('META-INF/manifest.xml'), manifestNs, 'manifest');
  if (manifest.getElementsByTagNameNS(manifestNs, 'encryption-data').length)
    throw new Error('Unlock the ODT before exporting.');
  if (
    !Array.from(manifest.getElementsByTagNameNS(manifestNs, 'file-entry')).some(
      (part) =>
        part.getAttributeNS(manifestNs, 'full-path') === '/' &&
        part.getAttributeNS(manifestNs, 'media-type') === mime,
    )
  )
    throw new Error('Choose a standard ODT document.');
  const document = readXml(zip.read('content.xml'), office, 'document-content');
  const root = document.getElementsByTagNameNS(office, 'text')[0];
  if (!root) throw new Error('The OpenDocument has no text body.');

  const byKey = new Map<string, Map<string, BibliographyItem>>();
  for (const item of items)
    for (const key of [citationKey(item), ...(item.citation_aliases ?? [])]) {
      if (!citationKeyPattern.test(key)) continue;
      const group = byKey.get(key) ?? new Map<string, BibliographyItem>();
      group.set(item.kind + ':' + item.id, item);
      byKey.set(key, group);
    }
  const missing = new Set<string>();
  const ambiguous = new Set<string>();
  const cited = new Map<string, BibliographyItem>();
  const bibliographyParagraphs: Element[] = [];
  const existingMarks = new Map(
    Array.from(
      root.getElementsByTagNameNS(textNs, 'bibliography-mark'),
      (mark) => [mark.getAttributeNS(textNs, 'identifier'), mark] as const,
    ),
  );
  const result = {
    citations: 0,
    skipped: 0,
    bibliography: false,
    missing: [] as string[],
    ambiguous: [] as string[],
  };
  let read = 0;
  for (const paragraph of Array.from(root.getElementsByTagNameNS(textNs, 'p'))) {
    const original = paragraph.textContent ?? '';
    const total = [...original.matchAll(citePattern)].length;
    const placeholder = original.trim() === bibliographyMarker;
    if (!total && !placeholder) continue;
    if (!isPlainParagraph(paragraph, root)) {
      result.skipped += total + Number(placeholder);
      continue;
    }
    if (placeholder) {
      if (
        paragraph.parentElement === root &&
        Array.from(paragraph.children).every(
          (child) =>
            child.namespaceURI === textNs && child.localName === 'span' && child.children.length === 0,
        )
      )
        bibliographyParagraphs.push(paragraph);
      else result.skipped++;
    }
    let found = 0;
    const nodes = [
      ...paragraph.childNodes,
      ...Array.from(paragraph.children).flatMap((child) =>
        child.namespaceURI === textNs && child.localName === 'span' ? [...child.childNodes] : [],
      ),
    ];
    for (const node of nodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.nodeValue) continue;
      const source = node.nodeValue;
      const fragment = document.createDocumentFragment();
      let offset = 0;
      for (const match of source.matchAll(citePattern)) {
        found++;
        if (++read > 500) throw new Error('Choose a document with at most 500 citation markers.');
        const candidates = byKey.get(match[1]);
        if (!candidates) {
          missing.add(match[1]);
          continue;
        }
        const item = candidates.values().next().value!;
        const id = citationKey(item);
        const existing = existingMarks.get(id);
        if (
          candidates.size !== 1 ||
          byKey.get(id)?.size !== 1 ||
          (existing &&
            (existing.getAttributeNS(textNs, 'title') !== item.title ||
              (existing.getAttributeNS(textNs, 'author') ?? '') !== item.authors.join('; ') ||
              (existing.getAttributeNS(textNs, 'year') ?? '') !== (item.year?.toString() ?? '')))
        ) {
          ambiguous.add(match[1]);
          continue;
        }
        fragment.append(source.slice(offset, match.index));
        fragment.append(referenceMark(document, item, id));
        const locator = match[2]?.trim();
        if (locator) fragment.append(displayLocator(locator));
        offset = match.index + match[0].length;
        cited.set(id, item);
        result.citations++;
      }
      if (offset) {
        fragment.append(source.slice(offset));
        node.parentNode?.replaceChild(fragment, node);
      }
    }
    result.skipped += Math.max(0, total - found);
  }
  result.missing = [...missing];
  result.ambiguous = [...ambiguous];
  if (!result.citations) return { ...result, bytes: null };

  const indexes = Array.from(root.getElementsByTagNameNS(textNs, 'bibliography'));
  if (!indexes.length && bibliographyParagraphs.length === 1) {
    bibliographyParagraphs[0].replaceWith(
      bibliographyIndex(document, [...cited.values()], bibliographyParagraphs[0]),
    );
    result.bibliography = true;
  } else {
    result.skipped += bibliographyParagraphs.length;
    const managed = indexes.find((index) => index.getAttributeNS(textNs, 'name') === indexName);
    const earlier = [...existingMarks.keys()].map((id) => id && byKey.get(id));
    if (managed && earlier.every((matches) => matches && matches.size === 1)) {
      for (const matches of earlier) {
        const item = matches && matches.values().next().value!;
        if (item) cited.set(citationKey(item), item);
      }
      const previousBody = Array.from(managed.children).find(
        (child) => child.namespaceURI === textNs && child.localName === 'index-body',
      );
      if (previousBody) {
        const previousParagraph = previousBody.getElementsByTagNameNS(textNs, 'p')[1] ?? previousBody;
        const replacement = bibliographyIndex(document, [...cited.values()], previousParagraph);
        const nextBody = Array.from(replacement.children).find((child) => child.localName === 'index-body')!;
        previousBody.replaceWith(nextBody);
        result.bibliography = true;
      }
    }
  }

  // ODF requires the stored MIME part first. All unrelated ZIP entry contents
  // are written byte-for-byte; only content.xml is serialized again.
  const files: Zippable = Object.create(null);
  files.mimetype = [mediaType, { level: 0 }];
  for (const path of zip.entries.keys())
    if (path !== 'mimetype' && path !== 'content.xml') files[path] = zip.read(path)!;
  const xml = new XMLSerializer().serializeToString(document).replace(/^<\?xml\s+[^?]*\?>/i, '');
  files['content.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8"?>' + xml);
  return { ...result, bytes: zipSync(files, { level: 1 }) };
}

import { strToU8, zipSync } from 'fflate';
import { citationKey, citationKeyPattern, referenceUrl, type BibliographyItem } from './bibliography';
import { formatLiteratureCitations } from './bibliography-csl';
import { decodeLiteratureXml, readLiteratureZip } from './literature-zip';

export const maxLiteratureDocxBytes = 24 * 1024 * 1024;
const maxExpandedBytes = 64 * 1024 * 1024;
const maxXmlBytes = 8 * 1024 * 1024;
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/';
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const bibliography = office + 'bibliography';
const datastore = office + 'customXml';
const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
const types = 'http://schemas.openxmlformats.org/package/2006/content-types';
const documentPath = 'word/document.xml';
const documentRelsPath = 'word/_rels/document.xml.rels';
const typesPath = '[Content_Types].xml';
const marker = /\[\[cite:([a-z0-9_./:+-]{1,180})(?:\|([0-9A-Za-z., –—-]{1,35}))?\]\]/gi;
const bibliographyMarker = '[[bibliography]]';
const xmlNs = 'http://www.w3.org/XML/1998/namespace';
const wordSourceTag = /^PRISM_[a-z0-9_]+$/i;
const managedBibliography = 'PRISM_BIBLIOGRAPHY';
const sourceStem = (tag: string) => tag.split('_', 2).join('_');

function parseXml(bytes: Uint8Array, namespace: string, localName: string) {
  if (bytes.byteLength > maxXmlBytes) throw new Error('A Word XML part exceeds the size limit.');
  const source = decodeLiteratureXml(bytes);
  if (/<!\s*(?:doctype|entity)|<\?/i.test(source.replace(/^<\?xml\s+[^?]*\?>/i, '')))
    throw new Error('The Word file contains unsupported XML declarations.');
  const document = new DOMParser().parseFromString(source, 'application/xml');
  const root = document.documentElement;
  if (
    document.getElementsByTagName('parsererror').length ||
    root.namespaceURI !== namespace ||
    root.localName !== localName
  )
    throw new Error('The Word file contains an unsupported XML part.');
  return document;
}

function element(document: Document, namespace: string, name: string, text?: string) {
  const node = document.createElementNS(namespace, name);
  if (text)
    node.textContent = text.replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu,
      '',
    );
  return node;
}

function writeXml(files: Record<string, Uint8Array>, path: string, document: Document) {
  const xml = new XMLSerializer().serializeToString(document).replace(/^<\?xml\s+[^?]*\?>/i, '');
  files[path] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + xml);
}

function addRelationship(document: Document, type: string, target: string) {
  const ids = new Set(Array.from(document.documentElement.children, (child) => child.getAttribute('Id')));
  let id = 1;
  while (ids.has(`rId${id}`)) id++;
  const relationship = element(document, rels, 'Relationship');
  relationship.setAttribute('Id', `rId${id}`);
  relationship.setAttribute('Type', office + 'relationships/' + type);
  relationship.setAttribute('Target', target);
  document.documentElement.append(relationship);
}

function createSource(sources: Document, tag: string, item: BibliographyItem) {
  const add = (parent: Node, name: string, value?: string | null) => {
    const child = element(sources, bibliography, 'b:' + name, value ?? undefined);
    parent.appendChild(child);
    return child;
  };
  const source = element(sources, bibliography, 'b:Source');
  const publication = item.publication;
  const type = publication?.journal
    ? 'JournalArticle'
    : publication?.booktitle
      ? 'BookSection'
      : publication?.type === 'book'
        ? 'Book'
        : item.url || item.arxiv_id
          ? 'InternetSite'
          : 'Misc';
  add(source, 'Tag', tag);
  add(source, 'SourceType', type);
  if (item.authors.length) {
    const people = add(add(add(source, 'Author'), 'Author'), 'NameList');
    for (const author of item.authors) {
      const [family, given] = author.split(',').map((name) => name.trim());
      const person = add(people, 'Person');
      add(person, 'Last', given ? family : author);
      if (given) add(person, 'First', given);
    }
  }
  add(source, 'Title', item.title);
  if (item.year !== null) add(source, 'Year', String(item.year));
  for (const [name, value] of [
    ['JournalName', publication?.journal],
    ['BookTitle', publication?.booktitle],
    ['Publisher', publication?.publisher],
    ['City', publication?.address],
    ['Volume', publication?.volume],
    ['Issue', publication?.number],
    ['Pages', publication?.pages],
    ['URL', referenceUrl(item)],
    ['StandardNumber', publication?.isbn ?? publication?.issn],
  ] as const)
    if (value) add(source, name, value);
  return source;
}

function datastoreId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return (
    '{' +
    [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-') +
    '}'
  );
}

function sourceFile(files: Record<string, Uint8Array>, contentTypes: Document, documentRels: Document) {
  const knownPaths = Object.keys(files);
  const existing = Array.from(documentRels.documentElement.children).flatMap((node) => {
    if (!node.getAttribute('Type')?.endsWith('/customXml') || node.getAttribute('TargetMode') === 'External')
      return [];
    const target = node.getAttribute('Target') ?? '';
    const match = /^(?:\.\.\/|\/)customXml\/([\w.-]+\.xml)$/.exec(target);
    return match ? ['customXml/' + match[1]] : [];
  });
  const matched = [];
  for (const path of existing) {
    const bytes = files[path];
    if (!bytes || bytes.byteLength > maxXmlBytes) continue;
    if (!decodeLiteratureXml(bytes).includes(bibliography)) continue;
    matched.push({ path, sources: parseXml(bytes, bibliography, 'Sources'), created: false });
  }
  if (matched.length > 1) throw new Error('This document has multiple Word bibliography source lists.');
  if (matched.length) return matched[0];
  let index = 1;
  while (
    knownPaths.some((path) =>
      [
        `customXml/item${index}.xml`,
        `customXml/itemProps${index}.xml`,
        `customXml/_rels/item${index}.xml.rels`,
      ].includes(path),
    )
  )
    index++;
  const path = `customXml/item${index}.xml`;
  const propertiesPath = `customXml/itemProps${index}.xml`;
  const sources = document.implementation.createDocument(bibliography, 'b:Sources');
  sources.documentElement.setAttribute('SelectedStyle', '/APA.XSL');
  sources.documentElement.setAttribute('StyleName', 'APA');
  const props = document.implementation.createDocument(datastore, 'ds:datastoreItem');
  props.documentElement.setAttributeNS(datastore, 'ds:itemID', datastoreId());
  const schema = element(props, datastore, 'ds:schemaRef');
  schema.setAttributeNS(datastore, 'ds:uri', bibliography);
  const schemas = element(props, datastore, 'ds:schemaRefs');
  schemas.append(schema);
  props.documentElement.append(schemas);
  const propsRels = document.implementation.createDocument(rels, 'Relationships');
  addRelationship(propsRels, 'customXmlProps', `itemProps${index}.xml`);
  writeXml(files, propertiesPath, props);
  writeXml(files, `customXml/_rels/item${index}.xml.rels`, propsRels);
  addRelationship(documentRels, 'customXml', '../' + path);
  const override = element(contentTypes, types, 'Override');
  override.setAttribute('PartName', '/' + propertiesPath);
  override.setAttribute(
    'ContentType',
    'application/vnd.openxmlformats-officedocument.customXmlProperties+xml',
  );
  contentTypes.documentElement.append(override);
  if (
    !Array.from(contentTypes.documentElement.children).some(
      (child) => child.getAttribute('Extension') === 'xml',
    )
  ) {
    const type = element(contentTypes, types, 'Default');
    type.setAttribute('Extension', 'xml');
    type.setAttribute('ContentType', 'application/xml');
    contentTypes.documentElement.prepend(type);
  }
  return { path, sources, created: true };
}

function w(document: Document, name: string, value?: string) {
  return element(document, word, 'w:' + name, value);
}

function textRun(document: Document, value: string, properties?: Element) {
  const run = w(document, 'r');
  const text = w(document, 't', value);
  text.setAttributeNS(xmlNs, 'xml:space', 'preserve');
  if (properties) run.append(properties.cloneNode(true));
  run.append(text);
  return run;
}

function field(document: Document, instruction: string, cached: string, properties?: Element) {
  const node = w(document, 'fldSimple');
  node.setAttributeNS(word, 'w:instr', instruction);
  node.append(textRun(document, cached, properties));
  return node;
}

function renderedBibliography(document: Document, items: readonly BibliographyItem[]) {
  const formatted = formatLiteratureCitations(items, 'apa').bibliography;
  const result: Element[] = [];
  for (const [index, line] of formatted.split('\n').entries()) {
    if (index) {
      const breakRun = w(document, 'r');
      breakRun.append(w(document, 'br'));
      result.push(breakRun);
    }
    result.push(textRun(document, line));
  }
  return result;
}

type WordCitation = { run: Element; item: BibliographyItem; locator: string; from: number; to: number };

export function buildLiteratureDocxExport(input: ArrayBuffer, items: readonly BibliographyItem[]) {
  if (input.byteLength < 22 || input.byteLength > maxLiteratureDocxBytes)
    throw new Error('Choose a DOCX file no larger than 24 MiB.');
  const zip = readLiteratureZip(new Uint8Array(input), 2000);
  const files: Record<string, Uint8Array> = Object.create(null);
  let expanded = 0;
  for (const [path, entry] of zip.entries) {
    expanded += entry.size;
    if (expanded > maxExpandedBytes) throw new Error('The Word file exceeds the expanded size limit.');
    if (/^_xmlsignatures\/|(?:^|\/)vbaProject(?:Signature)?\.bin$/i.test(path))
      throw new Error('Choose an unsigned DOCX without macros.');
  }
  for (const [path] of zip.entries) files[path] = zip.read(path)!;
  const documentBytes = files[documentPath];
  const contentTypeBytes = files[typesPath];
  if (!documentBytes || !contentTypeBytes || !files['_rels/.rels'])
    throw new Error('Choose a standard DOCX file.');
  const packageRels = parseXml(files['_rels/.rels'], rels, 'Relationships');
  if (
    !Array.from(packageRels.documentElement.children).some(
      (node) =>
        node.getAttribute('Type') === office + 'relationships/officeDocument' &&
        node.getAttribute('TargetMode') !== 'External' &&
        node.getAttribute('Target')?.replace(/^\//, '') === documentPath,
    )
  )
    throw new Error('Choose a standard DOCX file.');
  const contentTypes = parseXml(contentTypeBytes, types, 'Types');
  if (
    !Array.from(contentTypes.documentElement.children).some(
      (node) =>
        node.getAttribute('PartName') === '/' + documentPath &&
        node.getAttribute('ContentType') ===
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    )
  )
    throw new Error('Choose a standard DOCX file.');
  const main = parseXml(documentBytes, word, 'document');
  const body = main.getElementsByTagNameNS(word, 'body')[0];
  if (!body) throw new Error('The Word file has no document body.');
  const byKey = new Map<string, Set<BibliographyItem>>();
  for (const item of items)
    for (const key of new Set([citationKey(item), ...(item.citation_aliases ?? [])])) {
      if (!citationKeyPattern.test(key)) continue;
      const matches = byKey.get(key) ?? new Set<BibliographyItem>();
      matches.add(item);
      byKey.set(key, matches);
    }
  const unresolved = new Set<string>();
  const ambiguous = new Set<string>();
  const citations: WordCitation[] = [];
  const bibliographyParagraphs: Element[] = [];
  let skipped = 0;
  let markersRead = 0;
  const ordinaryContainers = new Set(['body', 'tbl', 'tr', 'tc']);
  for (const paragraph of body.getElementsByTagNameNS(word, 'p')) {
    const text = Array.from(
      paragraph.getElementsByTagNameNS(word, 't'),
      (node) => node.textContent ?? '',
    ).join('');
    const markers = [...text.matchAll(marker)].length;
    const wantsBibliography = text.trim() === bibliographyMarker;
    if (!markers && !wantsBibliography) continue;
    let parent = paragraph.parentElement;
    while (
      parent &&
      parent !== body &&
      parent.namespaceURI === word &&
      ordinaryContainers.has(parent.localName)
    )
      parent = parent.parentElement;
    if (parent !== body || paragraph.getElementsByTagNameNS(word, 'fldChar').length) {
      skipped += markers + Number(wantsBibliography);
      continue;
    }
    let found = 0;
    for (const run of paragraph.children) {
      if (
        run.namespaceURI !== word ||
        run.localName !== 'r' ||
        Array.from(run.children).some(
          (child) => child.namespaceURI !== word || !['t', 'rPr'].includes(child.localName),
        ) ||
        run.getElementsByTagNameNS(word, 't').length !== 1
      )
        continue;
      const content = run.getElementsByTagNameNS(word, 't')[0].textContent ?? '';
      for (const match of content.matchAll(marker)) {
        found++;
        if (++markersRead > 500) throw new Error('Choose a document with at most 500 citation markers.');
        const matches = byKey.get(match[1]);
        if (!matches) unresolved.add(match[1]);
        else if (matches.size !== 1) ambiguous.add(match[1]);
        else
          citations.push({
            run,
            item: [...matches][0],
            locator: match[2]?.trim() ?? '',
            from: match.index ?? 0,
            to: (match.index ?? 0) + match[0].length,
          });
      }
    }
    skipped += Math.max(0, markers - found);
    if (wantsBibliography) {
      const plain =
        Array.from(paragraph.children).every(
          (node) => node.namespaceURI === word && ['r', 'pPr'].includes(node.localName),
        ) &&
        Array.from(paragraph.getElementsByTagNameNS(word, 'r')).every((run) =>
          Array.from(run.children).every(
            (child) => child.namespaceURI === word && ['rPr', 't'].includes(child.localName),
          ),
        );
      if (plain && paragraph.parentElement === body) bibliographyParagraphs.push(paragraph);
      else skipped++;
    }
  }
  const result = {
    citations: citations.length,
    skipped,
    missing: [...unresolved],
    ambiguous: [...ambiguous],
    bibliography: false,
  };
  if (!citations.length) return { ...result, bytes: null };

  const documentRels = files[documentRelsPath]
    ? parseXml(files[documentRelsPath], rels, 'Relationships')
    : document.implementation.createDocument(rels, 'Relationships');
  const { path, sources, created } = sourceFile(files, contentTypes, documentRels);
  const existingSources = new Map<string | undefined, Element | null>(
    Array.from(
      sources.getElementsByTagNameNS(bibliography, 'Tag'),
      (node) => [node.textContent?.toLowerCase(), node.parentElement] as const,
    ),
  );
  const itemBySource = new Map(
    items.map((item) => [
      'prism_' +
        item.id
          .replace(/[^a-z0-9]/gi, '')
          .slice(0, 40)
          .toLowerCase(),
      item,
    ]),
  );
  const referencesInDocument = new Set(
    [
      ...Array.from(main.getElementsByTagNameNS(word, 'fldSimple'), (node) =>
        node.getAttributeNS(word, 'instr'),
      ),
      ...Array.from(main.getElementsByTagNameNS(word, 'instrText'), (node) => node.textContent),
    ].flatMap((instruction) => {
      const tag = /^\s*CITATION\s+([\w-]+)/i.exec(instruction ?? '')?.[1];
      return tag && wordSourceTag.test(tag) ? [tag.toLowerCase()] : [];
    }),
  );
  const sourceTags = new Map<BibliographyItem, string>();
  const grouped = new Map<Element, WordCitation[]>();
  for (const citation of citations) {
    if (!sourceTags.has(citation.item)) {
      const base = 'PRISM_' + citation.item.id.replace(/[^a-z0-9]/gi, '').slice(0, 40);
      let tag = base;
      let sequence = 2;
      let source = createSource(sources, tag, citation.item);
      // A previous export uses the same source for new markers if the data still agrees.
      while (existingSources.has(tag.toLowerCase())) {
        const existing = existingSources.get(tag.toLowerCase());
        if (referencesInDocument.has(tag.toLowerCase()) && existing?.isEqualNode(source)) break;
        tag = base + '_' + sequence++;
        source = createSource(sources, tag, citation.item);
      }
      if (!existingSources.has(tag.toLowerCase())) {
        sources.documentElement.append(source);
        existingSources.set(tag.toLowerCase(), source);
      }
      sourceTags.set(citation.item, tag);
    }
    const group = grouped.get(citation.run) ?? [];
    group.push(citation);
    grouped.set(citation.run, group);
  }
  for (const [run, group] of grouped) {
    const props = run.getElementsByTagNameNS(word, 'rPr')[0];
    const original = run.getElementsByTagNameNS(word, 't')[0].textContent ?? '';
    const replacement: Element[] = [];
    let position = 0;
    for (const { item, locator, from, to } of group) {
      if (from > position) replacement.push(textRun(main, original.slice(position, from), props));
      const cache = formatLiteratureCitations([item], 'apa', 'en-US', [{ locator }]).citation;
      replacement.push(
        field(
          main,
          ` CITATION ${sourceTags.get(item)}${locator ? ` \\p "${locator}"` : ''} \\l 1033 `,
          cache,
          props,
        ),
      );
      position = to;
    }
    if (position < original.length) replacement.push(textRun(main, original.slice(position), props));
    run.replaceWith(...replacement);
  }

  const itemsForBibliography = new Set(sourceTags.keys());
  for (const tag of referencesInDocument) {
    const previous = itemBySource.get(sourceStem(tag));
    if (previous) itemsForBibliography.add(previous);
  }
  const bibliographyFields = Array.from(main.getElementsByTagNameNS(word, 'fldSimple')).filter((node) =>
    /^\s*BIBLIOGRAPHY\b/i.test(node.getAttributeNS(word, 'instr') ?? ''),
  );
  const priorBibliography =
    bibliographyFields.length ||
    Array.from(main.getElementsByTagNameNS(word, 'instrText')).some((node) =>
      /\bBIBLIOGRAPHY\b/i.test(node.textContent ?? ''),
    );
  if (!priorBibliography && bibliographyParagraphs.length === 1) {
    const para = bibliographyParagraphs[0];
    for (const child of Array.from(para.children)) if (child.localName !== 'pPr') child.remove();
    const bibliographyField = field(main, ' BIBLIOGRAPHY \\l 1033 ', '');
    bibliographyField.replaceChildren(...renderedBibliography(main, [...itemsForBibliography]));
    const existingBookmarks = Array.from(main.getElementsByTagNameNS(word, 'bookmarkStart'));
    if (!existingBookmarks.some((node) => node.getAttributeNS(word, 'name') === managedBibliography)) {
      const used = new Set(existingBookmarks.map((node) => node.getAttributeNS(word, 'id')));
      let bookmarkId = 0;
      while (used.has(String(bookmarkId))) bookmarkId++;
      const start = w(main, 'bookmarkStart');
      start.setAttributeNS(word, 'w:id', String(bookmarkId));
      start.setAttributeNS(word, 'w:name', managedBibliography);
      const end = w(main, 'bookmarkEnd');
      end.setAttributeNS(word, 'w:id', String(bookmarkId));
      para.append(start, bibliographyField, end);
    } else para.append(bibliographyField);
    result.bibliography = true;
  } else {
    result.skipped += bibliographyParagraphs.length;
    const managed = bibliographyFields.find(
      (node) =>
        node.previousElementSibling?.namespaceURI === word &&
        node.previousElementSibling.localName === 'bookmarkStart' &&
        node.previousElementSibling.getAttributeNS(word, 'name') === managedBibliography &&
        node.nextElementSibling?.namespaceURI === word &&
        node.nextElementSibling.localName === 'bookmarkEnd' &&
        node.nextElementSibling.getAttributeNS(word, 'id') ===
          node.previousElementSibling.getAttributeNS(word, 'id'),
    );
    // Refresh only our own cache, and only when we can account for every
    // earlier managed citation within the selected library scope.
    if (managed && [...referencesInDocument].every((tag) => itemBySource.has(sourceStem(tag)))) {
      managed.replaceChildren(...renderedBibliography(main, [...itemsForBibliography]));
      result.bibliography = true;
    }
  }
  writeXml(files, documentPath, main);
  if (created) {
    writeXml(files, typesPath, contentTypes);
    writeXml(files, documentRelsPath, documentRels);
  }
  writeXml(files, path, sources);
  return { ...result, bytes: zipSync(files, { level: 1 }) };
}

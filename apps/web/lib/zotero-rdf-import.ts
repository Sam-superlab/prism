import { arxivReferencePattern, citationKeyPattern, doiPattern, safeReferenceUrl, type ReferenceCreator } from './bibliography';
import type { BibliographyImportResult } from './bibliography-import';

const ns = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  dc: 'http://purl.org/dc/elements/1.1/',
  terms: 'http://purl.org/dc/terms/',
  bib: 'http://purl.org/net/biblio#',
  prism: 'http://prismstandard.org/namespaces/1.2/basic/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  vcard: 'http://nwalsh.com/rdf/vCard#',
  z: 'http://www.zotero.org/namespaces/export#',
  link: 'http://purl.org/rss/1.0/modules/link/',
} as const;

const typeMap: Record<string, string> = {
  book: 'book', bookSection: 'chapter', journalArticle: 'article-journal', magazineArticle: 'article-magazine',
  newspaperArticle: 'article-newspaper', conferencePaper: 'paper-conference', thesis: 'thesis', report: 'report',
  webpage: 'webpage', blogPost: 'webpage', manuscript: 'manuscript', preprint: 'article', patent: 'patent',
  dataset: 'dataset', computerProgram: 'software', encyclopediaArticle: 'chapter', dictionaryEntry: 'chapter',
};
const maxRdfBytes = 8 * 1024 * 1024;
const maxRdfElements = 50_000;
const maxRdfDepth = 32;
const maxRdfRecords = 200;
const maxRdfAttachments = 50;

type Namespace = keyof typeof ns;
type Source = { format: 'zotero-rdf'; file_sha256: string; resource_sha256: string };
type ImportRecord = BibliographyImportResult['records'][number];
type RdfCollection = { resource_sha256: string; parent_resource_sha256: string | null; name: string; reference_ids: string[] };
type RdfNote = { resource_sha256: string; reference_id: string; title: string; content: string };
type RdfStandaloneNote = Omit<RdfNote, 'reference_id'> & { collection_paths: string[][] };
function zoteroCollectionTagLength(path: string[]) {
  return [...`Zotero collection: ${path.join(' › ')}`].length;
}
export type RdfAttachment = { id: string; referenceId: string; paths: string[]; fileName: string; format: 'pdf' | 'epub' | 'webpage' };
export type ZoteroRdfImport = Omit<BibliographyImportResult, 'format' | 'records'> & {
  format: 'zotero-rdf';
  records: (ImportRecord & { importId: string; importSource: Source })[];
  fileHash: string;
  collections: RdfCollection[];
  notes: RdfNote[];
  standaloneNotes: RdfStandaloneNote[];
  attachments: RdfAttachment[];
  unavailable: { collections?: string; notes?: string; collectionMembers: number; notesSkipped: number; notePathsSkipped: number };
  omitted: { collectionCount: number; collectionNames: string[]; noteCount: number; attachmentCount: number };
};

function children(node: Element | undefined, namespace: Namespace, name: string): Element[] {
  return Array.from(node?.children ?? []).filter((child) => child.namespaceURI === ns[namespace] && child.localName === name);
}
const read = (node?: Element) => node?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
const value = (node: Element | undefined, namespace: Namespace, name: string) => read(children(node, namespace, name)[0]);
const characters = (source: string, max: number) => [...source].slice(0, max).join('');

function subject(node: Element) {
  return node.getAttributeNS(ns.rdf, 'about') ??
    (node.hasAttributeNS(ns.rdf, 'ID') ? `#${node.getAttributeNS(ns.rdf, 'ID')}` : null) ??
    (node.hasAttributeNS(ns.rdf, 'nodeID') ? `_:${node.getAttributeNS(ns.rdf, 'nodeID')}` : null);
}
function resource(node: Element) {
  return node.getAttributeNS(ns.rdf, 'resource') ??
    (node.hasAttributeNS(ns.rdf, 'nodeID') ? `_:${node.getAttributeNS(ns.rdf, 'nodeID')}` : null);
}
function isType(node: Element | undefined, namespace: Namespace, type: string) {
  return Boolean(node && ((node.namespaceURI === ns[namespace] && node.localName === type) ||
    children(node, 'rdf', 'type').some((kind) => resource(kind) === ns[namespace] + type)));
}
function elementChildren(root: Element) {
  const nodes: Element[] = [];
  let stack = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > maxRdfDepth || nodes.length >= maxRdfElements)
      throw new Error('This Zotero RDF export is too complex. Export a smaller collection and try again.');
    nodes.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1 });
  }
  return nodes;
}
function keyForHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
function uuidFromDigest(bytes: Uint8Array) {
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = keyForHex(bytes.slice(0, 16));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function noteMarkdown(raw: string) {
  // Template contents belong to an inert document. Nothing is attached to the page or fetched.
  const template = document.createElement('template');
  template.innerHTML = raw;
  template.content.querySelectorAll('script,style,template,noscript,iframe,object,svg,math').forEach((node) => node.remove());
  template.content.querySelectorAll('p,div,li,blockquote,pre,h1,h2,h3,h4,h5,h6,td,br').forEach((node) => node.after(node.localName === 'br' ? '\n' : '\n\n'));
  const text = (template.content.textContent ?? '').replace(/\n(?:[^\S\n]*\n){2,}/gu, '\n\n').trim();
  return { text, content: text.replace(/[\\`*_\[\]<>~!$|{}#]/gu, '\\$&') };
}

function attachmentPaths(raw: string) {
  const match = /^files\/([1-9][0-9]{0,15})\/([^/\\\u0000-\u001f\u007f]{1,4096})$/u.exec(raw);
  if (!match || /%(?:00|2f|5c)/iu.test(match[2])) return [];
  let decoded: string;
  try { decoded = decodeURIComponent(match[2]); } catch { decoded = match[2]; }
  const names = new Set([match[2], decoded]);
  return [...names].filter((name) => !/[/\\\u0000-\u001f\u007f]/u.test(name) && /\.(?:pdf|epub|html?)$/iu.test(name))
    .map((name) => `files/${match[1]}/${name}`);
}

/** Parse the Zotero export vocabulary as data. RDF resources are resolved in this document only. */
export async function parseZoteroRdf(source: ArrayBuffer, userId: string): Promise<ZoteroRdfImport> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('The workspace account is still loading. Try again shortly.');
  if (source.byteLength > maxRdfBytes) throw new Error('Choose a Zotero RDF export under 8 MiB.');
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(source).trimStart(); }
  catch { throw new Error('Choose a Zotero RDF export encoded as UTF-8.'); }
  const body = xml.replace(/^<\?xml\s+[^?]*\?>/i, '').replace(/<!--[\s\S]*?-->/g, '');
  if (/<!\s*(?:doctype|entity)\b|<\?/i.test(body)) throw new Error('This Zotero RDF file contains unsupported XML declarations.');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  if (document.doctype || root.namespaceURI !== ns.rdf || root.localName !== 'RDF' || document.getElementsByTagName('parsererror').length)
    throw new Error('Choose a Zotero RDF export.');
  const nodes = elementChildren(root);
  const resources = new Map<string, Element>();
  for (const node of nodes) {
    // rdf:nodeID on an empty property element is a reference to a blank node.
    if (node.parentElement !== root && !node.children.length && !node.hasAttributeNS(ns.rdf, 'about') &&
        !node.hasAttributeNS(ns.rdf, 'ID')) continue;
    const id = subject(node);
    if (!id) continue;
    if (resources.has(id)) throw new Error('This Zotero RDF file repeats a resource definition.');
    resources.set(id, node);
  }
  const resolve = (link: Element) => {
    const key = resource(link);
    return key ? resources.get(key) : link.firstElementChild ?? undefined;
  };
  const resolveStructure = (link: Element) => link.children.length > (resource(link) ? 0 : 1) ? undefined : resolve(link);
  const collections = nodes.filter((node) => isType(node, 'z', 'Collection'));
  const notes = nodes.filter((node) => isType(node, 'bib', 'Memo') || value(node, 'z', 'itemType') === 'note');
  const attachments = nodes.filter((node) => isType(node, 'z', 'Attachment') || value(node, 'z', 'itemType') === 'attachment');
  const omitted = {
    collectionCount: collections.length,
    collectionNames: collections.slice(0, 8).flatMap((node) => {
      const name = value(node, 'dc', 'title');
      return name ? [characters(name, 120)] : [];
    }),
    noteCount: notes.length,
    attachmentCount: attachments.length,
  };
  const candidates = nodes.filter((node) => {
    const type = value(node, 'z', 'itemType');
    return type && type !== 'attachment' && type !== 'note' && !isType(node, 'bib', 'Memo') && !isType(node, 'z', 'Attachment');
  });
  if (candidates.length > maxRdfRecords) throw new Error('Export a smaller Zotero collection with at most 200 references.');
  if (!candidates.length && !notes.length) throw new Error('No Zotero references or notes were found in this export.');

  function contributors(node: Element) {
    const creators: ReferenceCreator[] = [];
    for (const [role, namespace] of [['author', 'bib'], ['editor', 'bib'], ['translator', 'z']] as const) {
      const group = children(node, namespace, `${role}s`);
      for (const relation of group) {
        const sequence = resolve(relation);
        const members = Array.from(sequence?.children ?? []).filter((element) => element.namespaceURI === ns.rdf &&
          (element.localName === 'li' || /^_\d+$/.test(element.localName)));
        if (members.every((member) => member.localName !== 'li')) members.sort((a, b) => Number(a.localName.slice(1)) - Number(b.localName.slice(1)));
        for (const member of members) {
          const person = resolve(member);
          const family = value(person, 'foaf', 'surname');
          const given = value(person, 'foaf', 'givenName');
          const name = [family, given].filter(Boolean).join(', ') || value(person, 'foaf', 'name') || read(member);
          if (name) creators.push({ role, name });
        }
      }
    }
    return creators;
  }
  const encoder = new TextEncoder();
  const fileHash = keyForHex(await sha256(new Uint8Array(source)));
  const resourceHash = async (value: string) => keyForHex(await sha256(encoder.encode(value)));
  const records: ZoteroRdfImport['records'] = [];
  const referenceIds = new Map<Element, string>();
  let unsupported = 0;
  let skipped = 0;
  let clipped = 0;
  let missingLinks = 0;
  for (const [index, node] of candidates.entries()) {
    const type = value(node, 'z', 'itemType')!;
    const title = value(node, 'dc', 'title') ?? value(node, 'z', 'displayTitle');
    if (!title) { skipped++; continue; }
    if (!Object.hasOwn(typeMap, type)) unsupported++;
    const chain: Element[] = [];
    let container = node;
    for (let i = 0; i < 8; i++) {
      const relation = children(container, 'terms', 'isPartOf')[0];
      if (!relation) break;
      const next = resolve(relation);
      if (!next || next === node || chain.includes(next)) { missingLinks++; break; }
      chain.push(next);
      container = next;
    }
    const series = chain.find((element) => isType(element, 'bib', 'Series'));
    const parent = chain.find((element) => !isType(element, 'bib', 'Series') && !isType(element, 'bib', 'Part'));
    const publisherRelation = children(node, 'dc', 'publisher')[0];
    const publisher = publisherRelation && resolve(publisherRelation);
    const addressRelation = children(publisher, 'vcard', 'adr')[0];
    const address = addressRelation && resolve(addressRelation);
    const identifiers = [node, ...chain].flatMap((element) => children(element, 'dc', 'identifier').map((entry) => {
      const resolved = resolve(entry);
      return resolved && isType(resolved, 'terms', 'URI') ? value(resolved, 'rdf', 'value') : read(entry);
    }).filter((entry): entry is string => Boolean(entry)));
    const prefixed = (prefix: string) => identifiers.find((id) => id.toLowerCase().startsWith(`${prefix.toLowerCase()} `))?.slice(prefix.length + 1).trim();
    const doi = (prefixed('DOI') ?? value(node, 'z', 'DOI') ?? '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    const href = identifiers.find((entry) => /^https?:\/\//i.test(entry));
    const url = href ? safeReferenceUrl(href) : null;
    const arxiv = url && /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/([^?#]+)/i.exec(url)?.[1]?.replace(/\.pdf$/i, '');
    const year = Number(/(?:^|\D)([1-9]\d{3})(?:\D|$)/.exec(value(node, 'dc', 'date') ?? value(node, 'terms', 'issued') ?? '')?.[1]);
    const tags = children(node, 'dc', 'subject').flatMap((entry) => {
      const linked = resolve(entry);
      const tag = linked ? (isType(linked, 'z', 'AutomaticTag') ? value(linked, 'rdf', 'value') : undefined) : resource(entry) ? undefined : read(entry);
      return tag ? [tag] : [];
    });
    const creatorList = contributors(node);
    const creators = creatorList.slice(0, 300).map(({ role, name }) => ({ role, name: characters(name, 300) }));
    let authors = creators.filter(({ role }) => role === 'author').map(({ name }) => name);
    if (authors.length > 100) {
      authors = authors.slice(0, 100);
      let count = 0;
      creators.splice(0, creators.length, ...creators.filter(({ role }) => role !== 'author' || count++ < 100));
    }
    if (title.length > 500 || creatorList.length !== creators.length || creatorList.some(({ name }) => name.length > 300) ||
        tags.length > 40 || tags.some((tag) => [...tag].length > 64)) clipped++;
    const cite = value(node, 'z', 'citationKey');
    const subjectHash = await resourceHash(subject(node) ?? `#anonymous-${index}`);
    const id = uuidFromDigest(await sha256(encoder.encode(`${userId.toLowerCase()}:${fileHash}:${subjectHash}`)));
    referenceIds.set(node, id);
    records.push({
      importId: id,
      importSource: { format: 'zotero-rdf', file_sha256: fileHash, resource_sha256: subjectHash },
      fields: { title: characters(title, 500), authors, year: Number.isFinite(year) ? year : null,
        doi: doi && doi.length <= 250 && doiPattern.test(doi) ? doi : null, arxiv_id: arxiv && arxiv.length <= 80 && arxivReferencePattern.test(arxiv) ? arxiv : null,
        url: url && url.length <= 2000 ? url : null },
      ...(creators.length && { creators }),
      ...(cite && citationKeyPattern.test(cite) && { sourceKey: cite }),
      publication: {
        entryType: Object.hasOwn(typeMap, type) ? typeMap[type] : 'misc',
        containerTitle: value(parent, 'dc', 'title') ?? value(node, 'z', 'bookTitle') ?? value(node, 'z', 'proceedingsTitle'),
        publisher: value(publisher, 'foaf', 'name') ?? (publisherRelation && !resource(publisherRelation) ? read(publisherRelation) : undefined),
        address: value(address, 'vcard', 'locality'),
        series: value(series, 'dc', 'title') ?? value(series, 'terms', 'alternative'),
        edition: value(node, 'prism', 'edition'), pages: value(node, 'bib', 'pages'),
        volume: value(parent, 'prism', 'volume') ?? value(node, 'prism', 'volume'),
        issue: value(parent, 'prism', 'number') ?? value(node, 'prism', 'number'),
        isbn: prefixed('ISBN'), issn: prefixed('ISSN'), abstract: value(node, 'terms', 'abstract'),
        keywords: tags.filter((tag) => [...tag].length <= 64).slice(0, 40),
      },
    });
  }
  const unavailable: ZoteroRdfImport['unavailable'] = { collectionMembers: 0, notesSkipped: 0, notePathsSkipped: 0 };
  const collectionSet = new Set(collections);
  const noteSet = new Set(notes);
  const parentOf = new Map<Element, Element>();
  const ambiguousParents = new Set<Element>();
  const membersOf = new Map<Element, Set<string>>();
  const noteCollections = new Map<Element, Set<Element>>();
  let memberCount = 0;
  for (const collection of collections) {
    const members = new Set<string>();
    membersOf.set(collection, members);
    for (const link of children(collection, 'terms', 'hasPart')) {
      const target = resolveStructure(link);
      if (target && collectionSet.has(target)) {
        if (parentOf.has(target) && parentOf.get(target) !== collection) {
          unavailable.collections = 'The export assigns a collection to multiple parents.';
          ambiguousParents.add(target);
        }
        parentOf.set(target, collection);
      } else if (target && referenceIds.has(target)) {
        members.add(referenceIds.get(target)!);
      } else if (target && noteSet.has(target)) {
        const memberships = noteCollections.get(target) ?? new Set<Element>();
        memberships.add(collection);
        noteCollections.set(target, memberships);
      } else if (!target) {
        unavailable.collections = 'The export contains an unresolved collection member.';
      } else {
        unavailable.collectionMembers++;
      }
    }
    memberCount += members.size;
  }
  if (collections.length > 200 || memberCount > 1000)
    unavailable.collections = 'This export exceeds 200 collections or 1,000 collection memberships.';
  for (const collection of collections) {
    const name = value(collection, 'dc', 'title');
    if (!name || [...name].length > 120) unavailable.collections = 'The export contains a missing or oversized collection name.';
    let ancestor = parentOf.get(collection);
    const seen = new Set([collection]);
    while (ancestor && seen.size <= 16 && !seen.has(ancestor)) {
      seen.add(ancestor);
      ancestor = parentOf.get(ancestor);
    }
    if (ancestor || seen.size > 16) unavailable.collections = 'The export contains a circular or deeply nested collection.';
  }
  const importedCollections: RdfCollection[] = [];
  if (!unavailable.collections) {
    const hashes = new Map(await Promise.all(collections.map(async (node, index) => [node, await resourceHash(subject(node) ?? `collection:${index}`)] as const)));
    for (const collection of collections) {
      const parent = parentOf.get(collection);
      importedCollections.push({
        resource_sha256: hashes.get(collection)!,
        parent_resource_sha256: parent ? hashes.get(parent)! : null,
        name: value(collection, 'dc', 'title')!,
        reference_ids: [...membersOf.get(collection)!],
      });
    }
  }

  const importedNotes: RdfNote[] = [];
  const standaloneNotes: RdfStandaloneNote[] = [];
  const collectionPath = (collection: Element) => {
    const path: string[] = [];
    const visited = new Set<Element>();
    for (let node: Element | undefined = collection; node; node = parentOf.get(node)) {
      const name = value(node, 'dc', 'title');
      if (!name || [...name].length > 120 || path.length >= 16 || visited.has(node) || ambiguousParents.has(node)) return [];
      visited.add(node);
      path.push(name);
    }
    return path.reverse();
  };
  if (notes.length > 200) unavailable.notes = 'This export exceeds 200 notes.';
  if (!unavailable.notes) {
    const noteParents = new Map<Element, Set<Element>>();
    for (const possibleParent of nodes) {
      for (const link of children(possibleParent, 'terms', 'isReferencedBy')) {
        // A malformed relation still signals that the note might have a parent.
        const target = resolve(link);
        if (!target || !noteSet.has(target)) continue;
        const parents = noteParents.get(target) ?? new Set<Element>();
        parents.add(resolveStructure(link) ? possibleParent : link);
        noteParents.set(target, parents);
      }
    }
    for (const [index, note] of notes.entries()) {
      const parents = noteParents.get(note);
      const parent = parents?.size === 1 ? parents.values().next().value : undefined;
      const referenceId = parent && referenceIds.get(parent);
      const independent = !parents?.size && note.parentElement === root && value(note, 'z', 'itemType') === 'note';
      const values = children(note, 'rdf', 'value');
      const raw = values.length === 1 && !values[0].children.length ? values[0].textContent : undefined;
      if ((!referenceId && !independent) || !raw || raw.length > 120_000) { unavailable.notesSkipped++; continue; }
      const { content, text } = noteMarkdown(raw);
      if (!content || [...content].length > 12_000) { unavailable.notesSkipped++; continue; }
      const title = value(note, 'dc', 'title') ?? text.split(/\r?\n/)[0];
      const fields = {
        resource_sha256: await resourceHash(subject(note) ?? `note:${index}`),
        title: characters(title, 120) || 'Zotero note',
        content,
      };
      if (referenceId) importedNotes.push({ ...fields, reference_id: referenceId });
      else {
        const memberships = noteCollections.get(note) ?? [];
        const paths: string[][] = [];
        const added = new Set<string>();
        for (const membership of memberships) {
          const path = collectionPath(membership);
          const label = path.join(' › ');
          if (added.has(label)) continue;
          if (!path.length || paths.length >= 40 || zoteroCollectionTagLength(path) > 300) unavailable.notePathsSkipped++;
          else {
            added.add(label);
            paths.push(path);
          }
        }
        standaloneNotes.push({ ...fields, collection_paths: paths });
      }
    }
  }
  if (!records.length && !standaloneNotes.length) throw new Error('No importable Zotero references or stand-alone notes were found in this export.');
  const importedAttachments: RdfAttachment[] = [];
  if (attachments.length <= 200 && !nodes.some((node) => node.hasAttributeNS('http://www.w3.org/XML/1998/namespace', 'base'))) {
    const knownAttachments = new Set(attachments);
    const attachmentParents = new Map<Element, Set<Element>>();
    for (const reference of candidates) {
      for (const link of children(reference, 'link', 'link')) {
        const target = resolveStructure(link);
        if (!target || !knownAttachments.has(target)) continue;
        const parents = attachmentParents.get(target) ?? new Set<Element>();
        parents.add(reference);
        attachmentParents.set(target, parents);
      }
    }
    for (const [index, attachment] of attachments.entries()) {
      const parents = attachmentParents.get(attachment);
      const parent = parents?.size === 1 ? parents.values().next().value : undefined;
      const referenceId = parent && referenceIds.get(parent);
      const properties = children(attachment, 'z', 'path');
      const path = properties.length === 1 && !properties[0].children.length ? properties[0].getAttributeNS(ns.rdf, 'resource') : null;
      if (!referenceId || !path) continue;
      const paths = attachmentPaths(path);
      if (!paths.length) continue;
      const fileName = paths.at(-1)!.split('/').at(-1)!;
      importedAttachments.push({ id: await resourceHash(subject(attachment) ?? `attachment:${index}`), referenceId, paths, fileName,
        format: /\.html?$/i.test(fileName) ? 'webpage' : /\.epub$/i.test(fileName) ? 'epub' : 'pdf' });
    }
  }
  const warnings = [
    ...(skipped ? [`${skipped} references without a title were skipped.`] : []),
    ...(unsupported ? [`${unsupported} references use Zotero item types that PRISM stores as general references.`] : []),
    ...(clipped ? [`${clipped} references exceed PRISM limits for titles, creators or tags.`] : []),
    ...(missingLinks ? ['Some publication details referred to a missing or cyclic RDF resource.'] : []),
    ...(attachments.length > 200 || importedAttachments.length > maxRdfAttachments ? ['Export a smaller Zotero collection to preview up to 50 supported attachments at a time.'] : []),
  ];
  return { format: 'zotero-rdf', records, fileHash, collections: importedCollections, notes: importedNotes, standaloneNotes,
    attachments: importedAttachments.length <= maxRdfAttachments ? importedAttachments : [], unavailable, warnings, omitted };
}

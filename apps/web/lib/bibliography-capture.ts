import {
  arxivReferencePattern,
  doiPattern,
  safeReferenceUrl,
  type Publication,
  type ReferenceFields,
} from './bibliography';

type MetadataTag = { name: string; content: string };

export type BibliographyPage = {
  pageUrl: string;
  title?: string;
  meta?: readonly MetadataTag[];
  canonicalUrl?: string;
  jsonLd?: readonly string[];
};

export type BibliographyCapture = {
  fields: Pick<
    ReferenceFields,
    'title' | 'authors' | 'year' | 'doi' | 'arxiv_id' | 'url' | 'publication' | 'tags'
  >;
  pdfUrl: string | null;
  snapshot?: { text: string; truncated: boolean };
};

type SchemaObject = Record<string, unknown>;
const schemaTypes: Record<string, string> = {
  ScholarlyArticle: 'article',
  MedicalScholarlyArticle: 'article',
  Article: 'article',
  NewsArticle: 'article',
  BlogPosting: 'online',
  Report: 'techreport',
  Thesis: 'phdthesis',
  Chapter: 'incollection',
  Book: 'book',
  WebPage: 'online',
};
const schemaPriority = [
  'ScholarlyArticle',
  'MedicalScholarlyArticle',
  'Thesis',
  'Report',
  'Chapter',
  'Article',
  'NewsArticle',
  'BlogPosting',
  'Book',
  'WebPage',
];

function record(value: unknown): SchemaObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as SchemaObject) : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, 500) : value == null ? [] : [value];
}

function text(value: unknown, limit = 2000) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return (
    String(value)
      .slice(0, limit * 4)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit) || undefined
  );
}

function schemaType(value: unknown) {
  const types = list(value).flatMap((type) => text(type)?.split(/[/:#]/).at(-1) ?? []);
  return schemaPriority.find((type) => types.includes(type));
}

function schemaNodes(sources: readonly string[]) {
  const nodes: SchemaObject[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || nodes.length >= 200) return;
    for (const item of list(value)) {
      const node = record(item);
      if (!node) continue;
      nodes.push(node);
      if (nodes.length >= 200) break;
      visit(node['@graph'], depth + 1);
      visit(node.mainEntity, depth + 1);
    }
  };
  for (const source of sources.slice(0, 24)) {
    if (source.length > 256_000) continue;
    try {
      visit(JSON.parse(source), 0);
    } catch {
      // An unrelated broken script does not invalidate the page's metadata.
    }
  }
  return nodes;
}

function schemaData(sources: readonly string[]) {
  const nodes = schemaNodes(sources);
  const indexed = new Map(
    nodes.flatMap((node) => (typeof node['@id'] === 'string' ? [[node['@id'], node] as const] : [])),
  );
  const resolve = (value: unknown) => {
    const node = record(value);
    const id = typeof value === 'string' ? value : node?.['@id'];
    if (typeof id === 'string')
      return node && Object.keys(node).length > 1 ? node : (indexed.get(id) ?? node);
    return node;
  };
  const article = schemaPriority
    .map((type) =>
      nodes.find((node) => schemaType(node['@type']) === type && text(node.headline ?? node.name)),
    )
    .find(Boolean);
  const named = (value: unknown) => {
    const node = resolve(value);
    const name = text(node?.name ?? node?.legalName ?? (node ? undefined : value));
    return name && !/^(?:https?:\/\/|#)/i.test(name) ? name : undefined;
  };
  const authors = list(article?.author).flatMap((author) => {
    const person = resolve(author);
    const family = text(person?.familyName);
    const given = text(person?.givenName);
    return family && given ? `${family}, ${given}` : (named(author) ?? []);
  });
  const containers = new Set<SchemaObject>();
  const visitContainer = (value: unknown) => {
    for (const candidate of list(value)) {
      const node = resolve(candidate);
      if (!node || containers.has(node) || containers.size >= 20) continue;
      containers.add(node);
      visitContainer(node.isPartOf);
    }
  };
  visitContainer(article?.isPartOf);
  const container = (field: string) => [...containers].map((node) => text(node[field])).find(Boolean);
  const identifiers = list(article?.identifier).flatMap((item) => {
    const node = record(item);
    const value = text(node?.value ?? item);
    const property = text(node?.propertyID);
    return value ? [value, ...(property ? [`${property.split(/[/:#]/).at(-1)}:${value}`] : [])] : [];
  });
  const pdfs = list(article?.encoding).flatMap((item) => {
    const node = resolve(item);
    if (!node || text(node.encodingFormat)?.toLowerCase() !== 'application/pdf') return [];
    return text(node.contentUrl ?? node.url) ?? [];
  });
  return { article, authors, named, container, identifiers, pdfs };
}

function link(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) return null;
  try {
    const result = safeReferenceUrl(new URL(value.trim(), base).href);
    if (!result || result.length > 2000) return null;
    const url = new URL(result);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function doi(value: string | undefined) {
  const result = value?.replace(/^doi\s*:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  return result && result.length <= 250 && doiPattern.test(result) ? result : null;
}

function arxiv(value: string | undefined) {
  if (!value) return null;
  const withoutPrefix = value.replace(/^arxiv\s*:\s*/i, '');
  const url = /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/([^?#]+)$/i.exec(
    withoutPrefix.split(/[?#]/, 1)[0],
  );
  const result = url?.[1].replace(/\.pdf$/i, '') ?? withoutPrefix;
  return result.length <= 80 && arxivReferencePattern.test(result) ? result : null;
}

function distinct(values: readonly string[], count: number, length: number) {
  const found = new Map<string, string>();
  for (const value of values) {
    const name = text(value, length);
    if (!name || found.has(name.toLowerCase())) continue;
    found.set(name.toLowerCase(), name);
    if (found.size >= count) break;
  }
  return [...found.values()];
}

function pageRange(first?: string, last?: string) {
  return first && last && first !== last ? `${first}–${last}` : (first ?? last);
}

export function parseBibliographyCapture(input: BibliographyPage): BibliographyCapture | null {
  const pageUrl = safeReferenceUrl(input.pageUrl);
  if (!pageUrl || pageUrl.length > 2000) return null;
  const tags = new Map<string, string[]>();
  for (const { name, content } of (input.meta ?? []).slice(0, 1000)) {
    const key = name.trim().toLowerCase();
    const value = text(content, 12_000);
    if (!key || !value) continue;
    if (!tags.has(key)) tags.set(key, []);
    tags.get(key)!.push(value);
  }
  const all = (...names: string[]) => names.flatMap((name) => tags.get(name) ?? []);
  const first = (...names: string[]) => all(...names)[0];
  const { article, authors, named, container, identifiers, pdfs } = schemaData(input.jsonLd ?? []);
  const title = text(
    first('citation_title') ??
      article?.headline ??
      article?.name ??
      first('dc.title', 'dcterms.title', 'og:title') ??
      input.title,
    500,
  );
  if (!title) return null;

  const scholarAuthors = all('citation_author');
  const dcAuthors = all('dc.creator', 'dcterms.creator');
  const authorValues = scholarAuthors.length
    ? scholarAuthors
    : authors.length
      ? authors
      : dcAuthors.length
        ? dcAuthors
        : all('author', 'article:author', 'book:author').filter((author) => !/^https?:\/\//i.test(author));
  const publicationDate =
    first('citation_publication_date', 'citation_date', 'citation_year') ??
    text(article?.datePublished) ??
    first('dcterms.issued', 'dc.date.issued', 'dc.date', 'article:published_time', 'book:release_date');
  const year =
    publicationDate?.match(/^([1-9][0-9]{3})(?=$|[^0-9])/)?.[1] ??
    publicationDate?.match(/\b([12][0-9]{3})\b/)?.[1];
  const resultUrl =
    [first('citation_public_url'), input.canonicalUrl, article?.url, first('og:url'), pageUrl]
      .map((value) => link(value, pageUrl))
      .find(Boolean) ?? pageUrl;
  const idDoi =
    [
      ...all('citation_doi', 'prism.doi', 'dc.identifier.doi', 'dcterms.identifier', 'dc.identifier'),
      ...identifiers,
      text(article?.doi),
      ...[resultUrl, pageUrl].filter((url) => /^https?:\/\/(?:dx\.)?doi\.org\//i.test(url)),
    ]
      .map(doi)
      .find(Boolean) ?? null;
  const idArxiv =
    [...all('citation_arxiv_id', 'arxiv:id', 'dc.identifier.arxiv'), ...identifiers, resultUrl, pageUrl]
      .map(arxiv)
      .find(Boolean) ?? null;
  const possiblePdfs = [
    ...all('citation_pdf_url'),
    ...pdfs,
    ...all('dc.identifier', 'dcterms.identifier').filter((url) => /\.pdf(?:$|[?#])/i.test(url)),
    ...[pageUrl].filter((url) => /\.pdf(?:$|[?#])|^https?:\/\/(?:www\.)?arxiv\.org\/pdf\//i.test(url)),
  ];
  const pdfUrl =
    possiblePdfs.map((url) => link(url, pageUrl)).find(Boolean) ??
    (idArxiv ? `https://arxiv.org/pdf/${idArxiv}` : null);

  const type = schemaType(article?.['@type']);
  const containerName = container('name') ?? first('dc.relation.ispartof', 'dcterms.ispartof');
  const journal =
    first('citation_journal_title', 'prism.publicationname') ??
    (type === 'Chapter' || type === 'Book' ? undefined : containerName);
  const conference = first('citation_conference_title');
  const subjectTags = distinct(
    [
      ...all('citation_keywords', 'keywords', 'dc.subject', 'dcterms.subject').flatMap((value) =>
        value.split(/[,;]/),
      ),
      ...list(article?.keywords).flatMap((value) => text(value)?.split(/[,;]/) ?? []),
      ...all('article:tag', 'book:tag'),
    ],
    40,
    60,
  );
  const metadata: Publication = {
    type: conference
      ? 'inproceedings'
      : journal
        ? 'article'
        : type
          ? schemaTypes[type]
          : first('citation_isbn', 'book:isbn')
            ? 'book'
            : idArxiv
              ? 'misc'
              : 'online',
    journal: conference ? undefined : text(journal),
    booktitle: text(conference ?? (type === 'Chapter' ? containerName : undefined)),
    series: type === 'Book' ? text(containerName) : undefined,
    publisher: text(
      first('citation_publisher') ?? named(article?.publisher) ?? first('dc.publisher', 'dcterms.publisher'),
    ),
    volume: text(
      first('citation_volume', 'prism.volume', 'dc.citation.volume') ??
        text(article?.volumeNumber) ??
        container('volumeNumber'),
    ),
    number: text(
      first('citation_issue', 'prism.number', 'dc.citation.issue') ??
        text(article?.issueNumber) ??
        container('issueNumber'),
    ),
    pages:
      pageRange(
        text(
          first('citation_firstpage', 'prism.startingpage', 'dc.citation.spage') ?? article?.pageStart,
          500,
        ),
        text(first('citation_lastpage', 'prism.endingpage', 'dc.citation.epage') ?? article?.pageEnd, 500),
      ) ?? text(article?.pagination),
    isbn: text(first('citation_isbn') ?? article?.isbn ?? first('book:isbn')),
    issn: text(first('citation_issn', 'prism.issn') ?? article?.issn ?? container('issn')),
    abstract: text(
      first('citation_abstract') ??
        article?.abstract ??
        first('dc.description', 'dcterms.abstract', 'og:description', 'description') ??
        article?.description,
      12_000,
    ),
    keywords: text(subjectTags.join(', ')),
  };

  return {
    fields: {
      title,
      authors: distinct(authorValues, 100, 300),
      year: year ? Number(year) : null,
      doi: idDoi,
      arxiv_id: idArxiv,
      url: resultUrl,
      publication: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)),
      tags: subjectTags,
    },
    pdfUrl,
  };
}

export function readBibliographyPage(document: Document, pageUrl = document.URL): BibliographyCapture | null {
  return parseBibliographyCapture({
    pageUrl,
    title: document.title,
    canonicalUrl: document.head.querySelector('link[rel~="canonical" i]')?.getAttribute('href') ?? undefined,
    meta: Array.from(document.head.querySelectorAll('meta[name], meta[property]')).flatMap((node) => {
      const name = node.getAttribute('name') || node.getAttribute('property');
      const content = node.getAttribute('content');
      return name && content ? [{ name, content }] : [];
    }),
    jsonLd: Array.from(
      document.querySelectorAll('script[type="application/ld+json" i]'),
      (node) => node.textContent ?? '',
    ),
  });
}

const transferFormat = 'prism-reference-v1';
export const bibliographyCaptureLimit = 200_000;
const snapshotLimit = 60_000;

export function serializeBibliographyCapture(capture: BibliographyCapture) {
  return JSON.stringify({ format: transferFormat, capture });
}

export function parseBibliographyCaptureTransfer(source: string): BibliographyCapture {
  if (source.length > bibliographyCaptureLimit) throw new Error('The copied reference is too large.');
  let envelope: SchemaObject | undefined;
  try {
    envelope = record(JSON.parse(source));
  } catch {
    throw new Error('Paste the reference copied by PRISM Browser Capture.');
  }
  const capture = record(envelope?.capture);
  const fields = record(capture?.fields);
  if (envelope?.format !== transferFormat || !fields || typeof fields.url !== 'string')
    throw new Error('Paste the reference copied by PRISM Browser Capture.');
  const snapshot = record(capture?.snapshot);
  let pageText: BibliographyCapture['snapshot'];
  if (capture?.snapshot !== undefined) {
    if (!snapshot || typeof snapshot.text !== 'string' || typeof snapshot.truncated !== 'boolean' ||
        !snapshot.text.trim() || snapshot.text.length > snapshotLimit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(snapshot.text))
      throw new Error('The copied page text is missing or invalid.');
    pageText = { text: snapshot.text.replace(/\r\n?/g, '\n').trim(), truncated: snapshot.truncated };
  }

  const pageUrl = safeReferenceUrl(fields.url);
  const title = text(fields.title, 500);
  if (!pageUrl || pageUrl.length > 2000 || !title)
    throw new Error('The copied reference is missing a title or a valid web address.');

  const publication = record(fields.publication);
  const publicationNames: (keyof Publication)[] = [
    'journal',
    'booktitle',
    'publisher',
    'volume',
    'number',
    'pages',
    'edition',
    'institution',
    'series',
    'address',
    'isbn',
    'issn',
    'editor',
    'month',
    'abstract',
    'note',
    'keywords',
  ];
  const type = text(publication?.type, 32);
  const mapped: Publication = {};
  if (type && /^[a-z][a-z0-9-]{0,31}$/i.test(type)) mapped.type = type;
  for (const name of publicationNames) {
    const value = text(publication?.[name], name === 'abstract' || name === 'note' ? 12_000 : 2000);
    if (value) mapped[name] = value;
  }
  const year =
    typeof fields.year === 'number' &&
    Number.isInteger(fields.year) &&
    fields.year >= 1 &&
    fields.year <= 9999
      ? fields.year
      : null;
  return {
    fields: {
      title,
      authors: distinct(
        list(fields.authors).filter((value): value is string => typeof value === 'string'),
        100,
        300,
      ),
      year,
      doi: doi(text(fields.doi)),
      arxiv_id: arxiv(text(fields.arxiv_id)),
      url: link(pageUrl, pageUrl),
      publication: mapped,
      tags: distinct(
        list(fields.tags).filter((value): value is string => typeof value === 'string'),
        40,
        60,
      ),
    },
    pdfUrl: typeof capture?.pdfUrl === 'string' ? link(capture.pdfUrl, pageUrl) : null,
    ...(pageText && { snapshot: pageText }),
  };
}

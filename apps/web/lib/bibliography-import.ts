import { plugins, type CSL, type CSLName } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import '@citation-js/plugin-ris';
import { arxivReferencePattern, doiPattern, safeReferenceUrl, type ReferenceCreator, type ReferenceFields } from './bibliography';

export type BibliographyImportFormat = 'bibtex' | 'ris' | 'csl-json';

export type BibliographyImportRecord = {
  fields: Pick<ReferenceFields, 'title' | 'authors' | 'year' | 'doi' | 'arxiv_id' | 'url'>;
  creators?: ReferenceCreator[];
  sourceKey?: string;
  publication: {
    entryType?: string;
    containerTitle?: string;
    publisher?: string;
    address?: string;
    series?: string;
    editors?: string[];
    translators?: string[];
    edition?: string;
    month?: string;
    note?: string;
    pmid?: string;
    pmcid?: string;
    volume?: string;
    issue?: string;
    pages?: string;
    isbn?: string;
    issn?: string;
    abstract?: string;
    keywords?: string[];
  };
};

export type BibliographyImportResult = {
  format: BibliographyImportFormat | 'zotero-rdf';
  records: BibliographyImportRecord[];
  warnings: string[];
};

export const bibliographyImportByteLimit = 8 * 1024 * 1024;

function text(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const result = String(value)
    // Citation.js can turn LaTeX emphasis, small caps, and scripts into HTML.
    .replace(
      /<\/?(?:b|i|em|strong|sub|sup|span)(?: class="(?:nocase|small-caps)"| style="font-variant:small-caps;?")?>/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return result || undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function authorName(value: unknown) {
  const name = object(value) as CSLName | undefined;
  if (!name) return text(value);
  const literal = text(name.literal);
  if (literal) return literal;
  const family = [name['non-dropping-particle'], name.family].flatMap((part) => text(part) ?? []).join(' ');
  const given = [name.given, name['dropping-particle']].flatMap((part) => text(part) ?? []).join(' ');
  return [family, given, text(name.suffix)].filter(Boolean).join(', ') || undefined;
}

function names(value: unknown) {
  return (Array.isArray(value) ? value : [value]).flatMap((name) => authorName(name) ?? []);
}

function arxivId(value: string | undefined) {
  if (!value) return null;
  const id = value
    .trim()
    .replace(/^arxiv\s*:\s*/i, '')
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\//i, '')
    .replace(/\.pdf$/i, '');
  return arxivReferencePattern.test(id) && id.length <= 80 ? id : null;
}

function inferredArxiv(url: string | null) {
  if (!url || !/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\//i.test(url)) return null;
  return arxivId(url.split(/[?#]/, 1)[0]);
}

type ParsedEntry = {
  item: CSL;
  sourceKey?: string;
  arxiv?: string;
  hasLocalAttachment?: boolean;
  keywords?: string[];
  risEditors?: string[];
  risTranslators?: string[];
};

function parseBibtex(source: string): ParsedEntry[] {
  const entries = plugins.input.data(source, '@biblatex/text');
  const items = plugins.input.data(entries, '@biblatex/entries+list') as unknown as CSL[];
  return items.map((item, index) => {
    const entry = entries[index];
    const props = entry.properties;
    const arxivSource = /^(?:arxiv)$/i.test(text(props.eprinttype ?? props.archiveprefix) ?? '');
    return {
      item,
      sourceKey: entry.label,
      arxiv: text(props.arxiv ?? (arxivSource ? props.eprint : undefined)),
      hasLocalAttachment: Boolean(props.file),
    };
  });
}

function risToCsl(entry: Record<string, string | string[]>) {
  return plugins.input.data(entry, '@ris/record');
}

function parseRis(source: string): ParsedEntry[] {
  // Preserve RIS continuation lines and the original spelling of repeatable fields.
  // The format translator handles tag aliases, date parsing and item types.
  type RisEntry = Parameters<typeof risToCsl>[0];
  const entries: RisEntry[] = [];
  let entry: RisEntry | undefined;
  let lastTag: string | undefined;
  for (const line of source.split('\n')) {
    const field = /^\s*([A-Z][A-Z0-9])[ \t]+-[ \t]*(.*)$/i.exec(line);
    if (!field) {
      if (!entry || !lastTag || !line.trim()) continue;
      const value = entry[lastTag];
      if (Array.isArray(value)) value[value.length - 1] += ' ' + line.trim();
      else entry[lastTag] = value + ' ' + line.trim();
      continue;
    }
    const tag = field[1].toUpperCase();
    const value = field[2].trim();
    if (tag === 'ER') {
      entry = undefined;
      lastTag = undefined;
      continue;
    }
    if (tag === 'TY') {
      const type = value.toUpperCase();
      entry = { TY: type === 'JOURN' ? 'JOUR' : type };
      entries.push(entry);
      lastTag = undefined;
      continue;
    }
    if (!entry || !value) continue;
    const previous = entry[tag];
    entry[tag] = previous === undefined ? value : ([] as string[]).concat(previous, value);
    lastTag = tag;
  }

  return entries.map((entry) => {
    const item = risToCsl(entry);
    const sourceKey = typeof entry.ID === 'string' ? text(entry.ID) : undefined;
    const arxiv =
      (/^arxiv$/i.test(String(entry.DB ?? '')) && typeof entry.AN === 'string' ? arxivId(entry.AN) : null) ??
      [entry.L1, entry.L2].flat().flatMap((url) => inferredArxiv(url ?? null) ?? [])[0];
    return {
      item,
      sourceKey,
      arxiv,
      risEditors: names(entry.ED),
      risTranslators: names(entry.A4),
      keywords: Array.isArray(entry.KW) ? entry.KW : entry.KW ? [entry.KW] : undefined,
      hasLocalAttachment: [entry.L1, entry.L2, entry.L3, entry.L4]
        .flat()
        .some((value) => Boolean(value && /^(?:file:|attachments?:|[\/\\]|[a-z]:[\/\\])/i.test(value))),
    };
  });
}

function parseCslJson(source: string): ParsedEntry[] {
  const parsed: unknown = JSON.parse(source);
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records.map((value) => {
    const record = object(value);
    if (!record) throw new Error('Expected CSL JSON reference objects.');
    return {
      // Metadata is untrusted; the shared mapping validates each value before use.
      item: record as unknown as CSL,
      sourceKey: text(record['citation-key']) ?? text(record.id),
      arxiv: /^arxiv$/i.test(text(record.archive) ?? '') ? text(record.archive_location) : undefined,
    };
  });
}

function cslDate(value: unknown): readonly unknown[] {
  const date = object(value);
  const parts = date?.['date-parts'];
  return Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0] : [];
}

export function parseBibliographyImport(
  input: string,
  format?: BibliographyImportFormat,
): BibliographyImportResult {
  if (new TextEncoder().encode(input).byteLength > bibliographyImportByteLimit)
    throw new Error('This bibliography exceeds 8 MB. Split it into smaller files and try again.');
  const source = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!source) throw new Error('This bibliography is empty.');
  // Prefer whichever recognizable record starts first, so an abstract with a
  // literal "TY  - " line cannot change the interpretation of a BibTeX file.
  const bibtexStart = source.search(/^\s*@\w+\s*[({]/m);
  const risStart = source.search(/^[ \t]*TY[ \t]+-[ \t]*/im);
  const selected =
    format ??
    (/^(?:\{|\[)/.test(source)
      ? 'csl-json'
      : risStart >= 0 && (bibtexStart < 0 || risStart < bibtexStart)
        ? 'ris'
        : 'bibtex');

  let entries: ParsedEntry[];
  try {
    entries =
      selected === 'csl-json'
        ? parseCslJson(source)
        : selected === 'ris'
          ? parseRis(source)
          : parseBibtex(source);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message.match(/line \d+(?: col(?:umn)? \d+)?/i)?.[0] : undefined;
    const label = selected === 'csl-json' ? 'CSL JSON' : selected === 'ris' ? 'RIS' : 'BibTeX';
    throw new Error(
      `Could not read the ${label} bibliography${detail ? ` near ${detail}` : ''}. Check the file format or export it again.`,
      { cause: error },
    );
  }

  const warnings: string[] = [];
  const records: BibliographyImportRecord[] = [];
  let skipped = 0;
  let invalidFields = 0;
  let oversizedFields = 0;
  for (const { item, sourceKey, arxiv, keywords, risEditors, risTranslators } of entries) {
    const title = text(item.title);
    if (!title) {
      skipped++;
      continue;
    }
    const authors = names(item.author);
    const editors = risEditors?.length ? risEditors : names(item.editor);
    const translators = names(item.translator);
    if (!translators.length && risTranslators?.length && ['book', 'chapter'].includes(String(item.type)))
      translators.push(...risTranslators);
    const groupedCreators = { author: authors, editor: editors, translator: translators };
    const creators = (Object.keys(groupedCreators) as ReferenceCreator['role'][]).flatMap((role) =>
      groupedCreators[role].slice(0, 100).map((name) => ({ role, name: [...name].slice(0, 300).join('') })));
    const date = cslDate(item.issued);
    const year = Number(text(date[0]));
    const month = Number(text(date[1]));
    const pmid = text(item.PMID);
    const pmcid = text(item.PMCID)?.toUpperCase();
    const sourceUrl = text(item.URL);
    const doi = text(item.DOI)?.replace(/^(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, '');
    const url = sourceUrl ? safeReferenceUrl(sourceUrl) : null;
    const validatedDoi = doi && doi.length <= 250 && doiPattern.test(doi) ? doi : null;
    const validatedUrl = url && url.length <= 2000 ? url : null;
    const validatedArxiv = arxivId(arxiv) ?? inferredArxiv(validatedUrl);
    if ((doi && !validatedDoi) || (sourceUrl && !validatedUrl) || (arxiv && !validatedArxiv)) invalidFields++;
    if (title.length > 500 || Object.values(groupedCreators).some((people) => people.length > 100 || people.some((name) => name.length > 300)))
      oversizedFields++;
    records.push({
      fields: {
        title: title.slice(0, 500),
        authors: authors.slice(0, 100).map((author) => author.slice(0, 300)),
        year: Number.isInteger(year) && year >= 1 && year <= 9999 ? year : null,
        doi: validatedDoi,
        arxiv_id: validatedArxiv,
        url: validatedUrl,
      },
      sourceKey,
      ...(creators.length && { creators }),
      publication: {
        entryType: text(item.type),
        containerTitle: text(item['container-title']),
        publisher: text(item.publisher),
        address: text(item['publisher-place']),
        series: text(item['collection-title']),
        editors: editors.length ? editors : undefined,
        ...(translators.length && { translators }),
        edition: text(item.edition),
        month: Number.isInteger(month) && month >= 1 && month <= 12 ? String(month) : undefined,
        note: text(item.note),
        pmid: /^\d{1,12}$/.test(pmid ?? '') ? pmid : undefined,
        pmcid: /^PMC[1-9]\d{0,11}$/.test(pmcid ?? '') ? pmcid : undefined,
        volume: text(item.volume),
        issue: text(item.issue),
        pages: text(item.page),
        isbn: text(item.ISBN),
        issn: text(item.ISSN),
        abstract: text(item.abstract),
        keywords: (keywords ?? text(item.keyword)?.split(/[,;]/))?.flatMap((keyword) => text(keyword) ?? []),
      },
    });
  }

  if (!records.length) {
    if (skipped) throw new Error('Every entry is missing a title.');
    throw new Error('No bibliography entries were found. Choose a BibTeX, RIS, or CSL JSON export.');
  }
  if (skipped) warnings.push(`Skipped ${skipped} ${skipped === 1 ? 'entry' : 'entries'} without a title.`);
  if (invalidFields)
    warnings.push(
      `Ignored an invalid or unsupported identifier or link in ${invalidFields} ${invalidFields === 1 ? 'entry' : 'entries'}.`,
    );
  if (oversizedFields)
    warnings.push(
      `Shortened fields that exceed PRISM limits in ${oversizedFields} ${oversizedFields === 1 ? 'entry' : 'entries'}.`,
    );
  if (entries.some((entry) => entry.hasLocalAttachment))
    warnings.push(
      'This import includes bibliography metadata. Local attachment files must be added separately.',
    );
  return { format: selected, records, warnings };
}

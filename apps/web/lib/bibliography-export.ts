import type { CSL, CSLName, CSLType } from '@citation-js/core';
import {
  arxivReferencePattern,
  bibliographyBibtex,
  bibtexText,
  bibliographyKeywords,
  citationKey,
  citationKeyPattern,
  doiPattern,
  referenceUrl,
  referenceCreators,
  referenceCreatorRoles,
  type BibliographyItem,
} from './bibliography';

export type BibliographyExportFormat = 'bibtex' | 'biblatex' | 'ris' | 'csl-json' | 'markdown';

const types: Record<string, { csl: CSLType; ris: string }> = {
  article: { csl: 'article-journal', ris: 'JOUR' },
  'article-journal': { csl: 'article-journal', ris: 'JOUR' },
  periodical: { csl: 'periodical', ris: 'SER' },
  book: { csl: 'book', ris: 'BOOK' },
  collection: { csl: 'book', ris: 'BOOK' },
  proceedings: { csl: 'book', ris: 'CONF' },
  inbook: { csl: 'chapter', ris: 'CHAP' },
  incollection: { csl: 'chapter', ris: 'CHAP' },
  chapter: { csl: 'chapter', ris: 'CHAP' },
  inproceedings: { csl: 'paper-conference', ris: 'CPAPER' },
  'paper-conference': { csl: 'paper-conference', ris: 'CPAPER' },
  conference: { csl: 'paper-conference', ris: 'CPAPER' },
  phdthesis: { csl: 'thesis', ris: 'THES' },
  mastersthesis: { csl: 'thesis', ris: 'THES' },
  thesis: { csl: 'thesis', ris: 'THES' },
  techreport: { csl: 'report', ris: 'RPRT' },
  report: { csl: 'report', ris: 'RPRT' },
  patent: { csl: 'patent', ris: 'PAT' },
  dataset: { csl: 'dataset', ris: 'DATA' },
  software: { csl: 'software', ris: 'COMP' },
  online: { csl: 'webpage', ris: 'ELEC' },
  webpage: { csl: 'webpage', ris: 'ELEC' },
  manuscript: { csl: 'manuscript', ris: 'UNPB' },
  unpublished: { csl: 'manuscript', ris: 'UNPB' },
};

function publicationType(item: BibliographyItem) {
  const type = item.publication?.type?.toLowerCase();
  if (type && Object.hasOwn(types, type)) return types[type];
  if (item.kind === 'arxiv' || item.arxiv_id) return { csl: 'article' as const, ris: 'UNPB' };
  return { csl: 'document' as const, ris: 'GEN' };
}

function authorName(author: string): CSLName {
  const [family, given, ...suffix] = author.split(',').map((part) => part.trim());
  // Plain names can represent institutions, non-Western names, or personal names.
  // Keep their exact spelling when the user did not supply a family/given split.
  if (!family || !given) return { literal: author.trim() };
  return { family, given, ...(suffix.length ? { suffix: suffix.join(', ') } : {}) };
}

function preprintId(item: BibliographyItem) {
  return item.arxiv_id && arxivReferencePattern.test(item.arxiv_id) ? item.arxiv_id : undefined;
}

export function bibliographyCslRecords(items: readonly BibliographyItem[]): CSL[] {
  return items.map((item): CSL => {
    const key = citationKey(item);
    const publication = item.publication;
    const arxiv = preprintId(item);
    const creators = referenceCreators(item);
    const people = (role: 'author' | 'editor' | 'translator') => {
      const names = creators.filter((creator) => creator.role === role).map((creator) => authorName(creator.name));
      return names.length ? names : undefined;
    };
    return {
      id: key,
      'citation-key': key,
      type: publicationType(item).csl,
      title: item.title,
      author: people('author'),
      editor: people('editor'),
      translator: people('translator'),
      issued: cslIssued(item),
      DOI: item.doi ?? undefined,
      PMID: publication?.pmid,
      PMCID: publication?.pmcid,
      URL: referenceUrl(item) ?? undefined,
      archive: arxiv ? 'arXiv' : undefined,
      archive_location: arxiv,
      'container-title': publication?.journal ?? publication?.booktitle,
      publisher: publication?.publisher ?? publication?.institution,
      'publisher-place': publication?.address,
      'collection-title': publication?.series,
      volume: publication?.volume,
      issue: publication?.number,
      page: publication?.pages,
      edition: publication?.edition,
      ISBN: publication?.isbn,
      ISSN: publication?.issn,
      abstract: publication?.abstract,
      keyword: item.tags?.length ? bibliographyKeywords(item).join(', ') || undefined : publication?.keywords,
      note: publication?.note,
    };
  });
}

export function bibliographyCslJson(items: readonly BibliographyItem[]): string {
  return JSON.stringify(bibliographyCslRecords(items), null, 2) + '\n';
}

function risField(tag: string, value: string | number | null | undefined) {
  const line = value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
  return line ? [`${tag}  - ${line}`] : [];
}

function risPages(value: string | undefined) {
  const range = value?.match(/^([\w.]+)\s*[-–—]+\s*([\w.]+)$/u);
  return range ? [...risField('SP', range[1]), ...risField('EP', range[2])] : risField('SP', value);
}

export function bibliographyRis(items: readonly BibliographyItem[]): string {
  return (
    items
      .map((item) => {
        const publication = item.publication;
        const arxiv = preprintId(item);
        const url = referenceUrl(item);
        const arxivUrl = arxiv ? `https://arxiv.org/abs/${arxiv}` : undefined;
        return [
          ...risField('TY', publicationType(item).ris),
          ...risField('ID', citationKey(item)),
          ...risField('TI', item.title),
          ...referenceCreators(item).flatMap(({ role, name }) => risField({ author: 'AU', editor: 'ED', translator: 'A4' }[role], name)),
          ...risField('PY', item.year),
          ...risField('DO', item.doi),
          ...risField('UR', url),
          ...(url !== arxivUrl ? risField('L2', arxivUrl) : []),
          ...risField('DB', arxiv ? 'arXiv' : undefined),
          ...risField('AN', arxiv),
          ...risField('JF', publication?.journal),
          ...risField('T2', publication?.booktitle),
          ...risField('PB', publication?.publisher ?? publication?.institution),
          ...risField('CY', publication?.address),
          ...risField('T3', publication?.series),
          ...risField('VL', publication?.volume),
          ...risField('IS', publication?.number),
          ...risPages(publication?.pages),
          ...risField('ET', publication?.edition),
          ...risField('SN', publication?.isbn ?? publication?.issn),
          ...risField('AB', publication?.abstract),
          ...bibliographyKeywords(item).flatMap((keyword) => risField('KW', keyword)),
          ...risField('N1', publication?.note),
          'ER  -',
        ].join('\r\n');
      })
      .join('\r\n\r\n') + (items.length ? '\r\n' : '')
  );
}

const biblatexTypeAliases: Record<string, string> = {
  'article-journal': 'article',
  'article-magazine': 'article',
  'article-newspaper': 'article',
  'paper-conference': 'inproceedings',
  chapter: 'incollection',
  conference: 'inproceedings',
  mastersthesis: 'thesis',
  phdthesis: 'thesis',
  techreport: 'report',
  webpage: 'online',
};

const biblatexPublication = [
  ['journal', 'journaltitle'],
  ['booktitle', 'booktitle'],
  ['publisher', 'publisher'],
  ['volume', 'volume'],
  ['number', 'number'],
  ['pages', 'pages'],
  ['edition', 'edition'],
  ['institution', 'institution'],
  ['series', 'series'],
  ['address', 'location'],
  ['isbn', 'isbn'],
  ['issn', 'issn'],
  ['abstract', 'abstract'],
  ['note', 'note'],
] as const;
const monthNumbers = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function publicationMonth(item: BibliographyItem) {
  const month = item.publication?.month?.trim().toLowerCase();
  if (!month) return;
  const number = /^\d{1,2}$/.test(month) ? Number(month) : monthNumbers.indexOf(month.slice(0, 3)) + 1;
  return number >= 1 && number <= 12 ? number : undefined;
}

function cslIssued(item: BibliographyItem): CSL['issued'] {
  if (item.year === null) return;
  const month = publicationMonth(item);
  return { 'date-parts': [month ? [item.year, month] : [item.year]] };
}

function bibliographyDate(item: BibliographyItem) {
  if (item.year === null) return '';
  const year = String(item.year).padStart(4, '0');
  const month = publicationMonth(item);
  return month ? year + '-' + String(month).padStart(2, '0') : year;
}

function verbatimField(value: string | undefined | null) {
  // Biber reads URL and identifiers verbatim. Escape nothing, and reject any value
  // that could close the braced field or start a new entry.
  return value && !/[{}\\\r\n]/.test(value) ? value : '';
}

function biblatexName(name: string) {
  const safe = bibtexText(name);
  // Protect a single corporate author containing "and" from the name-list separator.
  return /\s+and\s+/i.test(name) ? `{${safe}}` : safe;
}

export function bibliographyBibLaTeX(items: readonly BibliographyItem[]): string {
  const keys = items.map(citationKey);
  const reserved = new Set(keys);
  const claimed = new Set<string>();
  return (
    items
      .map((item, index) => {
        const publication = item.publication;
        const storedType = publication?.type?.toLowerCase();
        const entryType =
          storedType && /^[a-z][a-z0-9-]{0,31}$/.test(storedType)
            ? Object.hasOwn(biblatexTypeAliases, storedType)
              ? biblatexTypeAliases[storedType]
              : storedType
            : preprintId(item)
              ? 'online'
              : 'misc';
        const aliases = (item.citation_aliases ?? []).filter((alias) => {
          if (!citationKeyPattern.test(alias) || reserved.has(alias) || claimed.has(alias)) return false;
          claimed.add(alias);
          return true;
        });
        const arxiv = preprintId(item);
        const pmid = /^\d{1,12}$/.test(publication?.pmid ?? '') ? publication?.pmid : undefined;
        const creators = referenceCreators(item);
        const fields = [
          ['title', `{${bibtexText(item.title)}}`],
          ...referenceCreatorRoles.map((role) => [role, creators
            .filter((creator) => creator.role === role).map((creator) => biblatexName(creator.name)).join(' and ')]),
          ['date', bibliographyDate(item)],
          [
            'type',
            storedType === 'phdthesis'
              ? 'phdthesis'
              : storedType === 'mastersthesis'
                ? 'mathesis'
                : storedType === 'techreport'
                  ? 'techreport'
                  : '',
          ],
          ['ids', aliases.join(',')],
          ['doi', verbatimField(item.doi)],
          ['eprint', verbatimField(arxiv ?? pmid)],
          ['eprinttype', arxiv ? 'arxiv' : pmid ? 'pubmed' : ''],
          ['eprintclass', arxiv?.match(/^[a-z-]+(?:\.[a-z-]+)?(?=\/)/i)?.[0] ?? ''],
          ['url', verbatimField(referenceUrl(item))],
          ['keywords', bibtexText(bibliographyKeywords(item).join(', '))],
          ...biblatexPublication.map(([source, target]) => [target, bibtexText(publication?.[source] ?? '')]),
          // An arXiv eprint uses the one standard eprint slot, so retain a second identifier in PMID.
          ['pmid', arxiv && pmid ? pmid : ''],
        ].filter(([, value]) => value);
        return `@${entryType}{${keys[index]},\n${fields.map(([name, value]) => `  ${name} = {${value}}`).join(',\n')}\n}`;
      })
      .join('\n\n') + (items.length ? '\n' : '')
  );
}

function markdownText(value: string) {
  return value
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\\`*_\[\]<>~$|&]/g, '\\$&')
    .replace(/^(?:#{1,6}(?=\s|$)|[+-](?=\s))/u, '\\$&')
    .replace(/^(\d{1,9})([.)])(?=\s)/u, '$1\\$2');
}

function markdownLink(label: string, url: string) {
  return `[${markdownText(label)}](<${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>)`;
}

export function bibliographyMarkdown(items: readonly BibliographyItem[]): string {
  if (!items.length) return '';
  const records = items.map((item) => {
    const publication = item.publication;
    const details = [
      item.authors.map(markdownText).filter(Boolean).join('; '),
      item.year === null ? '' : String(item.year),
      markdownText(publication?.journal ?? publication?.booktitle ?? ''),
      markdownText(publication?.publisher ?? publication?.institution ?? ''),
      publication?.volume ? `vol. ${markdownText(publication.volume)}` : '',
      publication?.number ? `no. ${markdownText(publication.number)}` : '',
      publication?.pages ? `pp. ${markdownText(publication.pages)}` : '',
    ].filter(Boolean);
    const arxiv = preprintId(item);
    const url = referenceUrl(item);
    const doi = item.doi && doiPattern.test(item.doi) ? item.doi : null;
    const doiUrl = doi ? 'https://doi.org/' + doi.split('/').map(encodeURIComponent).join('/') : null;
    const arxivUrl = arxiv ? 'https://arxiv.org/abs/' + arxiv : null;
    const links = [
      doiUrl && markdownLink('DOI ' + doi, doiUrl),
      arxivUrl && markdownLink('arXiv ' + arxiv, arxivUrl),
      url && url !== doiUrl && url !== arxivUrl && markdownLink('Source', url),
    ].filter(Boolean);
    return [
      `- **${markdownText(item.title)}**`,
      details.length ? '  ' + details.join(' · ') : '',
      links.length ? '  ' + links.join(' · ') : '',
      `  Citation key: \`${citationKey(item)}\``,
    ]
      .filter(Boolean)
      .join('  \n');
  });
  return '# Bibliography\n\n' + records.join('\n\n') + '\n';
}

export function bibliographyExport(
  items: readonly BibliographyItem[],
  format: BibliographyExportFormat,
): { content: string; extension: '.bib' | '.ris' | '.json' | '.md'; mimeType: string } {
  switch (format) {
    case 'markdown':
      return {
        content: bibliographyMarkdown(items),
        extension: '.md',
        mimeType: 'text/markdown;charset=utf-8',
      };
    case 'ris':
      return {
        content: bibliographyRis(items),
        extension: '.ris',
        mimeType: 'application/x-research-info-systems;charset=utf-8',
      };
    case 'csl-json':
      return {
        content: bibliographyCslJson(items),
        extension: '.json',
        mimeType: 'application/json;charset=utf-8',
      };
    case 'biblatex':
      return {
        content: bibliographyBibLaTeX(items),
        extension: '.bib',
        mimeType: 'application/x-bibtex;charset=utf-8',
      };
    case 'bibtex':
      return {
        content: bibliographyBibtex([...items]),
        extension: '.bib',
        mimeType: 'application/x-bibtex;charset=utf-8',
      };
  }
}

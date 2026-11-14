import { citationKey, citationKeyPattern, type BibliographyItem } from './bibliography';

export const writerPacketHeader = 'PRISM-WRITER-CITATIONS/1';
export const maxWriterPacketEntries = 100;
export const maxWriterPacketBytes = 256 * 1024;
const typeNumbers: Record<string, number> = {
  article: 0,
  'article-journal': 0,
  book: 1,
  booklet: 2,
  conference: 3,
  inbook: 4,
  incollection: 5,
  chapter: 5,
  inproceedings: 6,
  'paper-conference': 6,
  journal: 7,
  manual: 8,
  mastersthesis: 9,
  misc: 10,
  phdthesis: 11,
  thesis: 11,
  proceedings: 12,
  techreport: 13,
  report: 13,
  unpublished: 14,
  www: 16,
  webpage: 16,
  online: 16,
};

function cell(value: string | undefined | null, limit: number) {
  return (value ?? '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
    .slice(0, limit)
    .replace(/[\uD800-\uDFFF]/gu, '');
}

export function buildWriterCitationPacket(input: string, items: readonly BibliographyItem[]) {
  if (input.length > 20_000) throw new Error('Enter no more than 100 citation keys.');
  const requested = [
    ...new Set(
      input
        .trim()
        .split(/[\s,]+/u)
        .filter(Boolean),
    ),
  ];
  if (requested.length > maxWriterPacketEntries) throw new Error('Enter no more than 100 citation keys.');
  if (requested.some((key) => !citationKeyPattern.test(key)))
    throw new Error('Use citation keys separated by spaces, commas or new lines.');

  const matches = new Map<string, Map<string, BibliographyItem>>();
  const wanted = new Set(requested);
  for (const item of items) {
    for (const key of [
      citationKey(item),
      ...(item.citation_aliases ?? []).filter((alias) => wanted.has(alias)),
    ]) {
      const keyItems = matches.get(key) ?? new Map<string, BibliographyItem>();
      keyItems.set(`${item.kind}:${item.id}`, item);
      matches.set(key, keyItems);
    }
  }
  const rows = new Map<string, { key: string; title: string; line: string }>();
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const requestedKey of requested) {
    const matched = matches.get(requestedKey);
    if (!matched?.size) {
      missing.push(requestedKey);
      continue;
    }
    if (matched.size > 1) {
      ambiguous.push(requestedKey);
      continue;
    }
    const item = [...matched.values()][0]!;
    const key = citationKey(item);
    if (!citationKeyPattern.test(key)) throw new Error('A reference has an invalid citation key.');
    if (matches.get(key)!.size !== 1) {
      ambiguous.push(requestedKey);
      continue;
    }
    if (!rows.has(key)) rows.set(key, writerRow(item, key));
  }
  const entries = [...rows.values()];
  const packet = [writerPacketHeader, ...entries.map((row) => row.line)].join('\n') + '\n';
  if (new TextEncoder().encode(packet).byteLength > maxWriterPacketBytes)
    throw new Error('This packet is too large. Choose fewer references.');
  return { packet, entries: entries.map(({ key, title }) => ({ key, title })), missing, ambiguous };
}

function writerRow(item: BibliographyItem, key: string) {
  const publication = item.publication;
  const title = cell(item.title, 800) || key;
  const type = publication?.type?.toLowerCase() ?? '';
  const number = Object.hasOwn(typeNumbers, type)
    ? typeNumbers[type]!
    : publication?.journal
      ? 0
      : item.arxiv_id
        ? 16
        : 10;
  const year =
    item.year && Number.isInteger(item.year) && item.year >= 1 && item.year <= 9999
      ? item.year.toString()
      : '';
  const fields = [
    key,
    String(number),
    title,
    cell(item.authors.join('; '), 800),
    year,
    cell(publication?.journal, 300),
    cell(publication?.booktitle, 300),
    cell(publication?.publisher, 300),
    cell(publication?.volume, 80),
    cell(publication?.number, 80),
    cell(publication?.pages, 120),
    cell(item.doi, 300),
    cell(item.arxiv_id, 120),
    cell(publication?.isbn, 100),
  ];
  return { key, title, line: fields.join('\t') };
}

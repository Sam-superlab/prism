export type ReferenceFields = {
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxiv_id: string | null;
  url: string | null;
  zotero_key: string | null;
};

export type BibliographyItem = ReferenceFields & {
  id: string;
  version: string;
  kind: 'reference' | 'arxiv';
};

export type ZoteroCollection = { key: string; name: string; parent: string | null };
export type ZoteroPage<T> = { items: T[]; next: number | null };

export const zoteroKeyPattern = /^[A-Z0-9]{8}$/;
export const doiPattern = /^10\.[0-9]{4,9}\/[^\s]+$/i;
export const arxivReferencePattern = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v[1-9]\d*)?$/i;

export function safeReferenceUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function citationKey(item: BibliographyItem) {
  if (item.kind === 'arxiv' && item.arxiv_id && arxivReferencePattern.test(item.arxiv_id))
    return `arxiv-${item.arxiv_id.toLowerCase()}`;
  return `ref-${item.id}`;
}

export function referenceUrl(item: ReferenceFields) {
  if (item.url) return safeReferenceUrl(item.url);
  if (item.doi && doiPattern.test(item.doi)) return `https://doi.org/${encodeURI(item.doi)}`;
  if (item.arxiv_id && arxivReferencePattern.test(item.arxiv_id))
    return `https://arxiv.org/abs/${item.arxiv_id}`;
  return null;
}

const bibtexEscape: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '#': '\\#',
  $: '\\$',
  '%': '\\%',
  '&': '\\&',
  _: '\\_',
  '^': '\\textasciicircum{}',
  '~': '\\textasciitilde{}',
};
const bibtexText = (value: string) =>
  value
    .replace(/[\\{}#$%&_^~]/g, (char) => bibtexEscape[char]!)
    .replace(/\s+/g, ' ')
    .trim();

export function bibliographyBibtex(items: BibliographyItem[]): string {
  return (
    items
      .map((item) => {
        const fields = [
          ['title', `{${bibtexText(item.title)}}`],
          ['author', item.authors.map(bibtexText).join(' and ')],
          ['year', item.year === null ? '' : String(item.year)],
          ['doi', item.doi ? bibtexText(item.doi) : ''],
          ['eprint', item.arxiv_id ? bibtexText(item.arxiv_id) : ''],
          ['archivePrefix', item.arxiv_id ? 'arXiv' : ''],
          ['url', bibtexText(referenceUrl(item) ?? '')],
        ].filter(([, value]) => value);
        return `@misc{${citationKey(item)},\n${fields.map(([key, value]) => `  ${key} = {${value}}`).join(',\n')}\n}`;
      })
      .join('\n\n') + '\n'
  );
}

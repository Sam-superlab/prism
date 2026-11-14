export type Publication = Partial<Record<
  'type' | 'journal' | 'booktitle' | 'publisher' | 'volume' | 'number' | 'pages' |
  'edition' | 'institution' | 'series' | 'address' | 'isbn' | 'issn' | 'editor' | 'translator' |
  'pmid' | 'pmcid' | 'month' | 'abstract' | 'note' | 'keywords',
  string
>>;
export const referenceCreatorRoles = ['author', 'editor', 'translator'] as const;
export type ReferenceCreator = { role: typeof referenceCreatorRoles[number]; name: string };

export type ReferenceFields = {
  title: string;
  authors: string[];
  creators?: ReferenceCreator[];
  year: number | null;
  doi: string | null;
  arxiv_id: string | null;
  url: string | null;
  zotero_key: string | null;
  citation_key?: string | null;
  citation_aliases?: string[];
  publication?: Publication | null;
  tags?: string[];
};

export type BibliographyItem = ReferenceFields & {
  id: string;
  version: string;
  kind: 'reference' | 'arxiv';
};

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

export const citationKeyPattern = /^[a-z0-9_./:+-]{1,180}$/i;

export function citationKey(
  item: Pick<ReferenceFields, 'arxiv_id' | 'citation_key'> & Pick<BibliographyItem, 'id' | 'kind'>,
) {
  if (item.kind === 'arxiv' && item.arxiv_id && arxivReferencePattern.test(item.arxiv_id))
    return `arxiv-${item.arxiv_id.toLowerCase()}`;
  return item.citation_key && citationKeyPattern.test(item.citation_key) ? item.citation_key : `ref-${item.id}`;
}

export function referenceUrl(item: ReferenceFields) {
  if (item.url) return safeReferenceUrl(item.url);
  if (item.doi && doiPattern.test(item.doi)) return `https://doi.org/${encodeURI(item.doi)}`;
  if (item.arxiv_id && arxivReferencePattern.test(item.arxiv_id))
    return `https://arxiv.org/abs/${item.arxiv_id}`;
  if (/^PMC[1-9]\d{0,11}$/.test(item.publication?.pmcid ?? ''))
    return `https://pmc.ncbi.nlm.nih.gov/articles/${item.publication!.pmcid}/`;
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
export const bibtexText = (value: string) =>
  value
    .replace(/[\\{}#$%&_^~]/g, (char) => bibtexEscape[char]!)
    .replace(/\s+/g, ' ')
    .trim();

export function bibliographyKeywords(item: BibliographyItem) {
  const keywords = item.publication?.keywords?.split(/[,;]/).map((word) => word.trim()).filter(Boolean) ?? [];
  return [...new Map([...keywords, ...(item.tags ?? [])].map((word) => [word.toLowerCase(), word])).values()];
}
export function referenceCreators(item: Pick<ReferenceFields, 'creators' | 'authors' | 'publication'>): ReferenceCreator[] {
  if (item.creators !== undefined) return item.creators;
  return referenceCreatorRoles.flatMap((role) => {
    const names = role === 'author' ? item.authors : item.publication?.[role]?.split(/\s+and\s+|\s*;\s*/i) ?? [];
    return names.flatMap((value) => value.trim() ? [{ role, name: value.trim() }] : []);
  });
}

export function bibliographyBibtex(items: BibliographyItem[]): string {
  return (
    items
      .map((item) => {
        const { type, keywords: _keywords, editor: _editor, translator: _translator, ...publication } = item.publication ?? {};
        const creators = referenceCreators(item);
        const entryType = type && /^[a-z][a-z0-9-]{0,31}$/i.test(type) ? type : 'misc';
        const fields = [
          ['title', `{${bibtexText(item.title)}}`],
          ...referenceCreatorRoles.map((role) => [role, creators.filter((creator) => creator.role === role)
            .map((creator) => bibtexText(creator.name)).join(' and ')]),
          ['year', item.year === null ? '' : String(item.year)],
          ['doi', item.doi ? bibtexText(item.doi) : ''],
          ['eprint', item.arxiv_id ? bibtexText(item.arxiv_id) : ''],
          ['archivePrefix', item.arxiv_id ? 'arXiv' : ''],
          ['url', bibtexText(referenceUrl(item) ?? '')],
          ...Object.entries(publication).map(([name, value]) => [name, bibtexText(value)]),
          ['keywords', bibtexText(bibliographyKeywords(item).join(', '))],
        ].filter(([, value]) => value);
        return `@${entryType}{${citationKey(item)},\n${fields.map(([key, value]) => `  ${key} = {${value}}`).join(',\n')}\n}`;
      })
      .join('\n\n') + '\n'
  );
}

export const literatureSearchFields = {
  title: 'Title', author: 'Author', year: 'Year', doi: 'DOI', arxiv_id: 'arXiv ID', isbn: 'ISBN', pmid: 'PubMed ID',
  pmcid: 'PubMed Central ID', issn: 'ISSN', date_added: 'Date added', date_modified: 'Date modified',
  publisher: 'Publisher', journal: 'Journal', type: 'Publication type', tag: 'Tag', collection: 'Collection',
  has_attachment: 'Has attachment', attachment_format: 'Attachment format', source: 'Source',
  attachment_text: 'Attachment text', note_text: 'Linked note text', annotation_comment: 'Annotation comment', annotation_color: 'Annotation color',
  annotation_tag: 'Annotation tag',
} as const;

export type LiteratureSearchField = keyof typeof literatureSearchFields;
export type LiteratureSearchOperator = 'contains' | 'equals' | 'gte' | 'lte';
export type LiteratureCondition = { all: LiteratureCondition[] } | { any: LiteratureCondition[] }
  | { not: LiteratureCondition }
  | { field: LiteratureSearchField; operator: LiteratureSearchOperator; value: string | number | boolean };

export const literatureSearchOperators = { contains: 'Contains', equals: 'Is', gte: 'At least', lte: 'At most' } as const;

export function operatorsForField(field: LiteratureSearchField): readonly LiteratureSearchOperator[] {
  switch (field) {
    case 'year': case 'date_added': case 'date_modified': return ['equals', 'gte', 'lte'];
    case 'collection': case 'tag': case 'has_attachment': case 'attachment_format': case 'source': case 'annotation_color': case 'annotation_tag': return ['equals'];
    case 'attachment_text': case 'annotation_comment': case 'note_text': return ['contains'];
    default: return ['contains', 'equals'];
  }
}

export function defaultLiteratureCondition(field: LiteratureSearchField = 'title'): LiteratureCondition {
  const values = { year: new Date().getFullYear(), has_attachment: true, attachment_format: 'pdf', source: 'reference', annotation_color: 'yellow' };
  return { field, operator: operatorsForField(field)[0], value: field in values ? values[field as keyof typeof values] : '' };
}

export function completeLiteratureCondition(condition: LiteratureCondition): boolean {
  let leaves = 0;
  function check(rule: LiteratureCondition, depth: number): boolean {
    if (depth > 5) return false;
    if ('all' in rule || 'any' in rule) {
      const children = 'all' in rule ? rule.all : rule.any;
      return children.length > 0 && children.length <= 12 && children.every((child) => check(child, depth + 1));
    }
    if ('not' in rule) return check(rule.not, depth + 1);
    if (++leaves > 24 || !operatorsForField(rule.field).includes(rule.operator)) return false;
    if (rule.field === 'year') return typeof rule.value === 'number' && Number.isInteger(rule.value) && rule.value >= 1 && rule.value <= 9999;
    if (rule.field === 'date_added' || rule.field === 'date_modified')
      return typeof rule.value === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(rule.value);
    if (rule.field === 'has_attachment') return typeof rule.value === 'boolean';
    return typeof rule.value === 'string' && !!rule.value.trim();
  }
  return check(condition, 1);
}

import { validation } from './errors';
import { foldLiteratureSqlText, normalizeLiteratureSearch } from './literature-text';

const textColumns = {
  title: 'library.title',
  doi: 'library.doi',
  arxiv_id: 'library.arxiv_id',
  isbn: "library.publication->>'isbn'",
  pmid: "library.publication->>'pmid'",
  pmcid: "library.publication->>'pmcid'",
  issn: "library.publication->>'issn'",
  publisher: "library.publication->>'publisher'",
  journal: "library.publication->>'journal'",
  type: "CASE WHEN library.kind='arxiv' THEN 'preprint' ELSE library.publication->>'type' END",
} as const;
const yearOperators = { equals: '=', gte: '>=', lte: '<=' } as const;
const dateFields = { date_added: 'library.added_on', date_modified: 'library.modified_on' } as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const attachment = `SELECT 1 FROM research_reference_pdfs p
  WHERE library.kind='reference' AND p.user_id=$1 AND p.reference_id=library.id AND p.status='ready' AND p.deleted_at IS NULL`;
const annotationMatches = (predicate: string) => `(EXISTS(${attachment} AND p.format='pdf' AND EXISTS(
  SELECT 1 FROM research_pdf_annotations a WHERE a.user_id=$1 AND a.pdf_id=p.id AND a.deleted_at IS NULL AND ${predicate}
)) OR EXISTS(${attachment} AND p.format IN ('epub','webpage') AND EXISTS(
  SELECT 1 FROM research_text_annotations a WHERE a.user_id=$1 AND a.attachment_id=p.id AND a.deleted_at IS NULL AND ${predicate}
)))`;
type TextField = keyof typeof textColumns | 'author';
type Leaf =
  | { field: TextField; operator: 'contains' | 'equals'; value: string }
  | { field: 'attachment_text' | 'annotation_comment' | 'note_text'; operator: 'contains'; value: string }
  | { field: 'year'; operator: keyof typeof yearOperators; value: number }
  | { field: keyof typeof dateFields; operator: keyof typeof yearOperators; value: string }
  | { field: 'tag' | 'collection' | 'attachment_format' | 'annotation_color' | 'annotation_tag' | 'source'; operator: 'equals'; value: string }
  | { field: 'has_attachment'; operator: 'equals'; value: boolean };
export type LiteratureCondition = Leaf | { all: LiteratureCondition[] } | { any: LiteratureCondition[] } | { not: LiteratureCondition };

export function parseLiteratureConditions(value: unknown) {
  const collections = new Set<string>();
  let leaves = 0;
  let nodes = 0;
  let usesCalendarDates = false;
  function visit(input: unknown, depth: number): LiteratureCondition {
    if (++nodes > 60 || depth > 5 || !input || typeof input !== 'object' || Array.isArray(input))
      throw validation('Limit advanced search to five levels and 24 rules.');
    const row = input as Record<string, unknown>;
    const keys = Object.keys(row);
    if (keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')) {
      const group = row[keys[0]];
      if (!Array.isArray(group) || !group.length || group.length > 12)
        throw validation('Each search group needs between 1 and 12 conditions.');
      const items = group.map((item) => visit(item, depth + 1));
      return keys[0] === 'all' ? { all: items } : { any: items };
    }
    if (keys.length === 1 && keys[0] === 'not') return { not: visit(row.not, depth + 1) };
    if (++leaves > 24 || keys.length !== 3 || !keys.includes('field') || !keys.includes('operator') || !keys.includes('value'))
      throw validation('Enter at most 24 valid search rules.');
    const { field, operator, value: raw } = row;
    if (field === 'year' && typeof operator === 'string' && Object.hasOwn(yearOperators, operator) &&
        typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 9999)
      return { field, operator: operator as keyof typeof yearOperators, value: raw };
    if (field === 'has_attachment' && operator === 'equals' && typeof raw === 'boolean')
      return { field, operator, value: raw };
    if (typeof field !== 'string' || typeof raw !== 'string' || raw.length > 300)
      throw validation('Choose a valid search field, operator, and value.');
    const value = raw.trim();
    if (!value || /\u0000/.test(value)) throw validation('Enter a non-empty search value.');
    if (Object.hasOwn(dateFields, field) && typeof operator === 'string' && Object.hasOwn(yearOperators, operator)) {
      if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) throw validation('Enter a calendar date.');
      const parsed = new Date(`${value}T00:00:00Z`);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
        throw validation('Enter a valid calendar date.');
      usesCalendarDates = true;
      return { field: field as keyof typeof dateFields, operator: operator as keyof typeof yearOperators, value };
    }
    if ((Object.hasOwn(textColumns, field) || field === 'author') && (operator === 'contains' || operator === 'equals'))
      return { field: field as TextField, operator, value: value.toLowerCase() };
    if ((field === 'attachment_text' || field === 'note_text') && operator === 'contains') {
      const folded = normalizeLiteratureSearch(value);
      if (!folded) throw validation('Enter a text search term.');
      return { field, operator, value: folded };
    }
    if (field === 'annotation_comment' && operator === 'contains')
      return { field, operator, value: value.toLowerCase() };
    if (operator === 'equals') {
      const lower = value.toLowerCase();
      if (field === 'collection' && uuid.test(lower)) {
        collections.add(lower);
        return { field, operator, value: lower };
      }
      if ((field === 'tag' || field === 'annotation_tag') && lower.length <= 64 ||
          field === 'attachment_format' && ['pdf', 'epub', 'webpage'].includes(lower) ||
          field === 'annotation_color' && ['yellow', 'green', 'blue', 'pink', 'purple'].includes(lower) ||
          field === 'source' && ['reference', 'arxiv'].includes(lower))
        return { field, operator, value: lower };
    }
    throw validation('Choose a valid search field, operator, and value.');
  }
  const condition = visit(value, 1);
  return { condition, collections: [...collections], usesCalendarDates };
}

export function compileLiteratureCondition(condition: LiteratureCondition, params: unknown[]): string {
  if ('all' in condition) return '(' + condition.all.map((item) => compileLiteratureCondition(item, params)).join(' AND ') + ')';
  if ('any' in condition) return '(' + condition.any.map((item) => compileLiteratureCondition(item, params)).join(' OR ') + ')';
  if ('not' in condition) return `NOT (${compileLiteratureCondition(condition.not, params)})`;

  const { field, operator, value } = condition;
  if (field === 'has_attachment') return `${value ? '' : 'NOT '}EXISTS(${attachment})`;
  params.push(field === 'attachment_text' ? [...new Set(String(value).split(' ').filter(Boolean))] : value);
  const marker = '$' + params.length;
  const stringTest = (expression: string) => operator === 'equals'
    ? `lower(coalesce(${expression},''))=${marker}`
    : `strpos(lower(coalesce(${expression},'')),${marker})>0`;
  switch (field) {
    case 'year':
      return `coalesce(library.year${yearOperators[operator]}${marker}::int,false)`;
    case 'date_added': case 'date_modified':
      return `coalesce(${dateFields[field]}${yearOperators[operator]}${marker}::date,false)`;
    case 'tag':
      return `EXISTS(SELECT 1 FROM unnest(library.tags) AS tag WHERE lower(tag)=${marker})`;
    case 'author':
      return `EXISTS(SELECT 1 FROM unnest(library.authors) AS author WHERE ${stringTest('author')})`;
    case 'source':
      return `library.kind=${marker}`;
    case 'collection':
      return `(library.kind='reference' AND EXISTS(SELECT 1 FROM literature_collection_memberships m
        WHERE m.user_id=$1 AND m.collection_id=${marker}::uuid AND m.reference_id=library.id AND m.deleted_at IS NULL))`;
    case 'attachment_format':
      return `EXISTS(${attachment} AND p.format=${marker})`;
    case 'attachment_text':
      return `EXISTS(${attachment} AND EXISTS(
        SELECT 1 FROM research_pdf_text_indexes i JOIN research_pdf_page_text t ON t.user_id=i.user_id AND t.index_id=i.id
        WHERE i.user_id=$1 AND i.pdf_id=p.id AND i.status='ready' AND t.search_text IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM unnest(${marker}::text[]) AS term WHERE strpos(t.search_text,term)=0)))`;
    case 'annotation_comment':
      return annotationMatches(stringTest('a.comment'));
    case 'note_text':
      return `EXISTS(SELECT 1 FROM research_reference_knowledge_links l
        JOIN knowledge_items k ON (k.user_id,k.id)=(l.user_id,l.knowledge_item_id)
        WHERE library.kind='reference' AND l.user_id=$1 AND l.reference_id=library.id AND l.deleted_at IS NULL
          AND k.type='note' AND k.deleted_at IS NULL AND strpos(${foldLiteratureSqlText('k.content')},${marker})>0)`;
    case 'annotation_color':
      return annotationMatches(`a.color=${marker}`);
    case 'annotation_tag':
      return annotationMatches(`EXISTS(SELECT 1 FROM unnest(a.tags) AS tag WHERE lower(tag)=${marker})`);
    default:
      return stringTest(textColumns[field]);
  }
}

export const annotationNoteTemplates = {
  standard: 'Reading notes',
  'by-color': 'Grouped by color',
  quotes: 'Quotes only',
  comments: 'Comments only',
} as const;

const colorLabels = {
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  pink: 'Pink',
  purple: 'Purple',
} as const;

type AnnotationNoteEntry = {
  id?: string;
  kind?: string;
  page: number;
  text?: string | null;
  comment?: string | null;
  color?: keyof typeof colorLabels | null;
};

export type AnnotationNoteOptions = {
  template?: keyof typeof annotationNoteTemplates;
  includeQuote?: boolean;
  includeComment?: boolean;
  includeAreaImages?: boolean;
  order?: 'selected' | 'page';
  locationLabel?: 'Page' | 'Chapter' | 'Paragraph';
};

export function literaturePdfHref(referenceId: string, pdfId: string, page?: number, annotationId?: string | null) {
  const params = new URLSearchParams({ reference: referenceId, pdf: pdfId });
  if (page !== undefined) params.set('page', String(page));
  if (annotationId) params.set('annotation', annotationId);
  return `/research/library?${params}`;
}

function annotationNoteGroups<T extends AnnotationNoteEntry>(
  entries: readonly T[],
  options: AnnotationNoteOptions,
) {
  const { template = 'standard', order = 'selected' } = options;
  const includeQuote = options.includeQuote ?? template !== 'comments';
  const includeComment = options.includeComment ?? template !== 'quotes';
  const includeAreaImages = options.includeAreaImages ?? (template === 'standard' || template === 'by-color');
  const included = entries.filter(
    ({ id, kind, text, comment }) =>
      (includeQuote && includeComment) ||
      (includeQuote && Boolean(text?.trim())) ||
      (includeComment && Boolean(comment?.trim())) ||
      (includeAreaImages && id && kind === 'area'),
  );
  if (order === 'page') included.sort((first, second) => first.page - second.page);

  const groups = new Map<string | null, T[]>();
  for (const entry of included) {
    const label =
      template === 'by-color'
        ? (entry.color && Object.hasOwn(colorLabels, entry.color) && colorLabels[entry.color]) || 'Uncolored'
        : null;
    const group = groups.get(label);
    if (group) group.push(entry);
    else groups.set(label, [entry]);
  }
  return { groups, includeQuote, includeComment, includeAreaImages };
}

export function orderedAnnotationNoteEntries<T extends AnnotationNoteEntry>(
  entries: readonly T[],
  options: AnnotationNoteOptions = {},
) {
  return [...annotationNoteGroups(entries, options).groups.values()].flat();
}

export function annotationNoteMarkdown(
  referenceTitle: string,
  file: { id: string; reference_id: string },
  entries: readonly AnnotationNoteEntry[],
  options: AnnotationNoteOptions = {},
) {
  const title = referenceTitle.replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>])/g, '\\$1');
  const quote = (text: string) =>
    text
      .trim()
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => '> ' + line.replace(/([\\`*_[\]<>$])/g, '\\$1'))
      .join('\n');
  const { groups, includeQuote, includeComment, includeAreaImages } = annotationNoteGroups(entries, options);
  const location = options.locationLabel ?? 'Page';
  return [...groups]
    .flatMap(([label, group]) => [
      ...(label ? [`### ${label}`] : []),
      ...group.map(({ id, kind, page, text, comment }) =>
        [
          `${label ? '####' : '###'} [${title} · ${location} ${page}](${literaturePdfHref(file.reference_id, file.id, page, id)})`,
          includeAreaImages && id && kind === 'area'
            ? `![PDF figure · Page ${page}](${literaturePdfHref(file.reference_id, file.id, page, id)})` : '',
          includeQuote && text?.trim() ? quote(text) : '',
          includeComment ? (comment?.trim() ?? '') : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      ),
    ])
    .join('\n\n');
}

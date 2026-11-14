import { describe, expect, it } from 'vitest';
import {
  annotationNoteMarkdown,
  orderedAnnotationNoteEntries,
} from '../../apps/web/lib/literature-pdf-notes';

const file = { id: 'paper pdf', reference_id: 'source&reference' };
const heading = (page: number, annotation?: string) =>
  `### [A \\[synthetic\\] paper · Page ${page}](/research/library?reference=source%26reference&pdf=paper+pdf&page=${page}${annotation ? `&annotation=${annotation}` : ''})`;

describe('annotation-to-note Markdown', () => {
  it('preserves the default text, note Markdown, links, and entry order', () => {
    const result = annotationNoteMarkdown('A [synthetic]\npaper', file, [
      { page: 5, text: ' One *result* \r\nfor $X$. ', comment: ' **Keep this.** ' },
      { page: 2 },
    ]);
    expect(result).toBe(
      [heading(5), '> One \\*result\\* \n> for \\$X\\$.', '**Keep this.**', heading(2)].join('\n\n'),
    );
  });

  it('groups by color, applies stable page ordering, and uses the first rendered entry as the source', () => {
    const entries = [
      { id: 'blue-5', page: 5, color: 'blue', comment: 'Last blue' },
      { id: 'yellow-3a', page: 3, color: 'yellow', comment: 'First yellow' },
      { id: 'blue-2', page: 2, color: 'blue', text: 'Quote only' },
      { id: 'yellow-3b', page: 3, color: 'yellow', comment: 'Second yellow' },
      { id: 'uncolored-1', page: 1, comment: 'First page' },
    ] as const;
    const options = { template: 'by-color', order: 'page', includeQuote: false } as const;
    expect(orderedAnnotationNoteEntries(entries, options).map(({ id }) => id)).toEqual([
      'uncolored-1',
      'yellow-3a',
      'yellow-3b',
      'blue-5',
    ]);
    expect(annotationNoteMarkdown('A [synthetic] paper', file, entries, options)).toBe(
      [
        '### Uncolored',
        '#' + heading(1, 'uncolored-1'),
        'First page',
        '### Yellow',
        '#' + heading(3, 'yellow-3a'),
        'First yellow',
        '#' + heading(3, 'yellow-3b'),
        'Second yellow',
        '### Blue',
        '#' + heading(5, 'blue-5'),
        'Last blue',
      ].join('\n\n'),
    );
  });

  it('omits entries with no content in a restricted template', () => {
    const entries = [
      { page: 1, text: ' ', comment: 'First comment' },
      { page: 2, text: 'Second quote' },
    ];
    const title = 'A [synthetic] paper';
    expect(annotationNoteMarkdown(title, file, entries, { template: 'quotes' })).toBe(
      heading(2) + '\n\n> Second quote',
    );
    expect(annotationNoteMarkdown(title, file, entries, { template: 'comments' })).toBe(
      heading(1) + '\n\nFirst comment',
    );
    expect(annotationNoteMarkdown(title, file, entries, { includeQuote: false, includeComment: false })).toBe(
      '',
    );
  });
});

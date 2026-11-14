import { describe, expect, it } from 'vitest';
import type { BibliographyItem } from '../../apps/web/lib/bibliography';
import {
  buildLiteratureWritingExport,
  literatureWritingDocumentStem,
} from '../../apps/web/lib/literature-writing-export';

function item(key: string, aliases: string[] = [], id = key): BibliographyItem {
  return {
    id,
    kind: 'reference',
    version: '1',
    title: 'Synthetic ' + key,
    authors: ['Example, Ada'],
    year: 2024,
    doi: null,
    arxiv_id: null,
    url: null,
    zotero_key: null,
    citation_key: key,
    citation_aliases: aliases,
  };
}

describe('portable Markdown writing projects', () => {
  it('updates old aliases inside citation clusters while preserving locators, code, and Quarto cross-references', () => {
    const document = [
      '---',
      'title: "Examples"',
      'nocite: |',
      '  @old-four # @uncited-comment',
      '---',
      '',
      'As @old-one [p. 2] and [see -@old-two, pp. 3–4; @old-one]. Also @old-three.',
      '',
      'Compare @fig-example and @thm-first.',
      'Contact ada@research.org, or read [a link](https://example.org/@old-one) or https://example.org/@old-one.',
      'Keep `@old-one`, $@old-one$, and \\@old-one unchanged.',
      '<!-- @old-one -->',
      '',
      '~~~{python}',
      'print("@old-one")',
      '~~~',
      '',
      '    @old-one',
    ].join('\n');
    const result = buildLiteratureWritingExport(
      document,
      [
        item('example2024', ['old-one']),
        item('ring::proof', ['old-two']),
        item('book', ['old-three', 'old-four']),
      ],
      'csl-json',
      true,
    );
    expect(result).toMatchObject({
      resolved: 3,
      missing: [],
      ambiguous: [],
      aliases: [
        { from: 'old-four', to: 'book' },
        { from: 'old-one', to: 'example2024' },
        { from: 'old-two', to: 'ring::proof' },
        { from: 'old-three', to: 'book' },
      ],
      bibliography: { filename: 'prism-references.json' },
    });
    expect(result.document).toBe(
      document
        .replace('  @old-four #', '  @book #')
        .replace('---\n\nAs', 'bibliography: prism-references.json\n---\n\nAs')
        .replace(
          'As @old-one [p. 2] and [see -@old-two, pp. 3–4; @old-one]. Also @old-three.',
          'As @example2024 [p. 2] and [see -@{ring::proof}, pp. 3–4; @example2024]. Also @book.',
        ),
    );
    expect(JSON.parse(result.bibliography.content).map(({ id }: { id: string }) => id)).toEqual([
      'book',
      'example2024',
      'ring::proof',
    ]);
  });

  it('retains and reports missing or ambiguous citations without guessing', () => {
    const source = '[@shared; @missing; @valid; @only-alias]. Email @example.org.';
    const result = buildLiteratureWritingExport(
      source,
      [item('duplicate', ['shared', 'only-alias'], '1'), item('duplicate', ['shared'], '2'), item('valid')],
      'biblatex',
    );
    expect(result).toMatchObject({
      resolved: 1,
      missing: ['missing', 'example.org'],
      ambiguous: ['shared', 'only-alias'],
    });
    expect(result.document).toContain(source);
    expect(result.bibliography.content).toContain('@misc{valid,');
    expect(result.bibliography.content).not.toContain('duplicate');
  });

  it('preserves surrounding metadata and existing bibliography lists', () => {
    const original =
      '---\r\ntitle: Notes\r\nbibliography: "old.bib" # Keep this\r\nformat: pdf\r\n---\r\n[@valid]';
    const items = [item('valid')];
    const result = buildLiteratureWritingExport(original, items, 'csl-json');
    expect(result.document).toBe(
      original.replace(
        'bibliography: "old.bib" # Keep this',
        'bibliography:\r\n  - "old.bib" # Keep this\r\n  - prism-references.json',
      ),
    );
    const repeated = buildLiteratureWritingExport(result.document, items, 'csl-json');
    expect(repeated.document).toBe(result.document);
    const switched = buildLiteratureWritingExport(result.document, items, 'biblatex');
    expect(switched.document).toBe(result.document.replace('prism-references.json', 'prism-references.bib'));

    const complex = '---\nbibliography: [sources.bib, other.bib]\n---\n[@valid]';
    expect(buildLiteratureWritingExport(complex, items, 'csl-json')).toMatchObject({
      document: complex,
      metadataWarning: expect.stringContaining('prism-references.json'),
    });
  });

  it('accepts a leading rule and produces names portable across desktop filesystems', () => {
    expect(buildLiteratureWritingExport('---\n\n[@valid]', [item('valid')], 'csl-json').document).toBe(
      '---\nbibliography: prism-references.json\n---\n\n---\n\n[@valid]',
    );
    expect(literatureWritingDocumentStem('CON.qmd')).toBe('_CON');
    expect(literatureWritingDocumentStem('Early results #1.md')).toBe('Early results -1');
    expect([...literatureWritingDocumentStem('𠮷'.repeat(200) + '.qmd')]).toHaveLength(55);
  });
});

import { describe, expect, it } from 'vitest';
import type { BibliographyItem } from '../../apps/web/lib/bibliography';
import { formatLiteratureCitations, literatureCitationStyles } from '../../apps/web/lib/bibliography-csl';

const article: BibliographyItem = {
  id: '11111111-1111-4111-8111-111111111111',
  version: '1',
  kind: 'reference',
  title: 'Graded Rings',
  authors: ['Example, Ada'],
  year: 2024,
  doi: '10.1234/fixture',
  arxiv_id: null,
  url: null,
  zotero_key: null,
  citation_key: 'reused-key',
  publication: { type: 'article', journal: 'Algebra Review', volume: '4', number: '2', pages: '21-31' },
};
const book: BibliographyItem = {
  ...article,
  id: '22222222-2222-4222-8222-222222222222',
  title: 'A Monograph on Topology',
  authors: ['Borel, Jean'],
  year: 2020,
  doi: null,
  publication: { type: 'book', publisher: 'Example Press' },
};

describe('built-in citation styles', () => {
  it('formats APA author-date citations and alphabetically sorted bibliography entries', () => {
    const result = formatLiteratureCitations([article, book], 'apa');
    expect(result.citation).toBe('(Borel, 2020; Example, 2024)');
    expect(result.bibliography.split('\n')).toEqual([
      'Borel, J. (2020). A Monograph on Topology. Example Press.',
      'Example, A. (2024). Graded Rings. Algebra Review, 4(2), 21–31. https://doi.org/10.1234/fixture',
    ]);
  });

  it('formats IEEE numbers in citation order without merging distinct items that share a key', () => {
    const first = formatLiteratureCitations([article, book], 'ieee');
    expect(first.citation).toBe('[1], [2]');
    expect(first.bibliography.split('\n')).toEqual([
      '[1] A. Example, “Graded Rings,” Algebra Review, vol. 4, no. 2, pp. 21–31, 2024, doi: 10.1234/fixture.',
      '[2] J. Borel, A Monograph on Topology. Example Press, 2020.',
    ]);
    const second = formatLiteratureCitations([book], 'ieee');
    expect(second.citation).toBe('[1]');
    expect(second.bibliography).toBe('[1] J. Borel, A Monograph on Topology. Example Press, 2020.');
  });

  it('formats Chicago author-date with full author names', () => {
    const result = formatLiteratureCitations([article], 'chicago-author-date');
    expect(result.citation).toBe('(Example 2024)');
    expect(result.bibliography).toBe(
      'Example, Ada. 2024. “Graded Rings.” Algebra Review 4 (2): 21–31. https://doi.org/10.1234/fixture.',
    );
  });

  it('formats page and section locators with prefix and suffix without changing the bibliography', () => {
    const detailed = formatLiteratureCitations([article], 'apa', 'en-US', [
      { locator: 12, prefix: ' see ', suffix: ', emphasis added' },
    ]);
    expect(detailed.citation).toBe('(see Example, 2024, p. 12, emphasis added)');
    expect(detailed.bibliography).toBe(formatLiteratureCitations([article], 'apa').bibliography);
    expect(
      formatLiteratureCitations([article], 'apa', 'en-US', [
        { locator: '21–24', label: 'section', prefix: 'cf.' },
      ]).citation,
    ).toBe('(cf. Example, 2024, Sections 21–24)');
  });

  it('applies each detail to its source after sorting and can omit one author', () => {
    const baseline = formatLiteratureCitations([article, book], 'apa');
    const result = formatLiteratureCitations([article, book], 'apa', 'en-US', [
      { locator: '12', prefix: 'see', label: 'page', suffix: ', emphasis added' },
      { locator: '2.3', label: 'section', suppressAuthor: true },
    ]);
    expect(result.citation).toContain('2020, Section 2.3');
    expect(result.citation).not.toContain('Borel');
    expect(result.citation).toContain('see Example, 2024, p. 12, emphasis added');
    expect(result.bibliography).toBe(baseline.bibliography);
  });

  it('returns an empty result for an empty collection in any style', () => {
    for (const style of literatureCitationStyles) {
      expect(formatLiteratureCitations([], style.id)).toEqual({ citation: '', bibliography: '' });
    }
  });
});

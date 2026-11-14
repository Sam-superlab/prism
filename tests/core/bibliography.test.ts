import { describe, expect, it } from 'vitest';
import { bibliographyBibtex } from '../../apps/web/lib/bibliography';

describe('PRISM bibliography', () => {
  it('exports the editor key and escapes special characters in BibTeX', () => {
    const bibtex = bibliographyBibtex([
      {
        id: '11111111-1111-4111-8111-111111111111',
        version: '1',
        kind: 'reference',
        title: 'Ring & module {notes}',
        authors: ['Example, Ada'],
        year: 2025,
        doi: null,
        arxiv_id: null,
        url: null,
        zotero_key: null,
      },
    ]);
    expect(bibtex).toContain('@misc{ref-11111111-1111-4111-8111-111111111111,');
    expect(bibtex).toContain('title = {{Ring \\& module \\{notes\\}}}');
  });
});

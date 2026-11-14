import { describe, expect, it } from 'vitest';
import { parseBibliographyImport } from '../../apps/web/lib/bibliography-import';

describe('bibliography file import', () => {
  it('reads Zotero-compatible BibTeX with macros, LaTeX, source keys and arXiv metadata', () => {
    const source = String.raw`
@string{journal = "Algebra"}
@article{grobner:2024,
  title = {{Gr\"obner} bases and \textit{modules}},
  author = {de Silva, Ana and {The Algebra Group}},
  journal = journal # " Today",
  year = 2024,
  doi = {https://doi.org/10.1234/fixture},
  archivePrefix = {arXiv},
  eprint = {math.AC/0501234v2},
  pages = {5--8},
  keywords = {algebra, Gröbner bases},
  file = {/tmp/example.pdf}
}
@book(parent,
  title = {Abstract Algebra},
  publisher = {Example Press}
)
@incollection{chapter,
  title = {Ideals},
  crossref = {parent}
}
`;
    const result = parseBibliographyImport(source);
    expect(result.format).toBe('bibtex');
    expect(result.records).toHaveLength(3);
    expect(result.records[0]).toMatchObject({
      fields: {
        title: 'Gröbner bases and modules',
        authors: ['de Silva, Ana', 'The Algebra Group'],
        year: 2024,
        doi: '10.1234/fixture',
        arxiv_id: 'math.AC/0501234v2',
        url: null,
      },
      sourceKey: 'grobner:2024',
      publication: {
        entryType: 'article-journal',
        containerTitle: 'Algebra Today',
        pages: '5-8',
        keywords: ['algebra', 'Gröbner bases'],
      },
    });
    expect(result.records[2].publication.publisher).toBe('Example Press');
    expect(result.warnings).toEqual([
      'This import includes bibliography metadata. Local attachment files must be added separately.',
    ]);
    expect(JSON.stringify(result)).not.toContain('/tmp/example.pdf');
  });

  it('reads RIS repeats, BOM, line continuations and preprint links', () => {
    const result = parseBibliographyImport(
      [
        '\uFEFFTY  - JOUR',
        'AU  - Example, Ada',
        'AU  - Example, Sam',
        'TI  - Quotient rings  -  a survey',
        'JF  - Algebra Review',
        'PY  - 2024/04/11',
        'UR  - https://arxiv.org/pdf/math.AC/0501234v2.pdf?download=1',
        'AB  - A long',
        '      abstract',
        'KW  - topology, algebra',
        'KW  - review',
        '      articles',
        'ID  - Quote2024',
        'ER  -',
      ].join('\r\n'),
    );
    expect(result).toMatchObject({
      format: 'ris',
      records: [
        {
          fields: {
            title: 'Quotient rings - a survey',
            authors: ['Example, Ada', 'Example, Sam'],
            year: 2024,
            arxiv_id: 'math.AC/0501234v2',
          },
          sourceKey: 'Quote2024',
          publication: {
            abstract: 'A long abstract',
            containerTitle: 'Algebra Review',
            keywords: ['topology, algebra', 'review articles'],
          },
        },
      ],
      warnings: [],
    });
  });

  it('keeps valid records and reports skipped titles and unsupported links', () => {
    const result = parseBibliographyImport(
      '@book{noTitle, year={2022}}\n@misc{fixture, title={A test}, url={file:///local.pdf}, doi={bad}}',
      'bibtex',
    );
    expect(result.records.map((entry) => entry.fields)).toEqual([
      {
        title: 'A test',
        authors: [],
        year: null,
        doi: null,
        arxiv_id: null,
        url: null,
      },
    ]);
    expect(result.warnings).toEqual([
      'Skipped 1 entry without a title.',
      'Ignored an invalid or unsupported identifier or link in 1 entry.',
    ]);
  });

  it('rejects missing bibliography records and reports malformed BibTeX', () => {
    expect(() => parseBibliographyImport('  ')).toThrow(/empty/);
    expect(() => parseBibliographyImport('@article{incomplete, title={Broken')).toThrow(
      /Could not read the BibTeX/,
    );
    expect(() => parseBibliographyImport('@comment{Only a comment}')).toThrow(/No bibliography entries/);
    expect(() => parseBibliographyImport('https://example.test/file.bib')).toThrow(/bibliography/);
  });
});

describe('CSL JSON bibliography import', () => {
  it('retains structured contributors, dates, identifiers and publication data', () => {
    const data = [
      {
        id: 'legacy-id',
        'citation-key': 'Canonical:2024',
        type: 'chapter',
        title: 'On generated modules',
        author: [
          { 'non-dropping-particle': 'de', family: 'Silva', given: 'Ada' },
          { literal: 'The Algebra Group' },
        ],
        editor: [{ family: 'Borel', given: 'Jean', suffix: 'Jr.' }],
        issued: { 'date-parts': [[2024, 5, 1]] },
        'container-title': 'Collected Papers',
        publisher: 'Example Press',
        'publisher-place': 'Budapest',
        'collection-title': 'Studies in Algebra',
        edition: 3,
        DOI: '10.1234/synthetic',
        PMID: '12345678',
        archive: 'arXiv',
        archive_location: '2401.01234v2',
        URL: 'https://example.test/paper',
        keyword: 'Algebra; Topology',
        note: 'Synthetic record.',
      },
    ];
    expect(parseBibliographyImport(JSON.stringify(data))).toMatchObject({
      format: 'csl-json',
      records: [
        {
          sourceKey: 'Canonical:2024',
          fields: {
            title: 'On generated modules',
            authors: ['de Silva, Ada', 'The Algebra Group'],
            year: 2024,
            doi: '10.1234/synthetic',
            arxiv_id: '2401.01234v2',
            url: 'https://example.test/paper',
          },
          publication: {
            entryType: 'chapter',
            containerTitle: 'Collected Papers',
            publisher: 'Example Press',
            address: 'Budapest',
            series: 'Studies in Algebra',
            edition: '3',
            editors: ['Borel, Jean, Jr.'],
            month: '5',
            pmid: '12345678',
            note: 'Synthetic record.',
            keywords: ['Algebra', 'Topology'],
          },
        },
      ],
      warnings: [],
    });
  });

  it('validates imported values and refuses unrelated JSON', () => {
    const result = parseBibliographyImport(
      JSON.stringify({
        id: 1,
        title: 'A standalone reference',
        type: 'article-journal',
        author: [null, { family: { invalid: true } }, { literal: 'Mathematical Society' }],
        URL: 'javascript:alert(1)',
        issued: { 'date-parts': [[{}, 88]] },
      }),
      'csl-json',
    );
    expect(result.records[0]).toMatchObject({
      sourceKey: '1',
      fields: { authors: ['Mathematical Society'], url: null, year: null },
    });
    expect(result.warnings).toHaveLength(1);
    expect(() => parseBibliographyImport('{"collections":[]}', 'csl-json')).toThrow(/missing a title/);
    expect(() => parseBibliographyImport('[2]', 'csl-json')).toThrow(/Could not read the CSL JSON/);
  });
});

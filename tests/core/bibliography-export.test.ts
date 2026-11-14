import { describe, expect, it } from 'vitest';
import type { BibliographyItem } from '../../apps/web/lib/bibliography';
import { bibliographyExport } from '../../apps/web/lib/bibliography-export';
import { parseBibliographyImport } from '../../apps/web/lib/bibliography-import';

const article: BibliographyItem = {
  id: '11111111-1111-4111-8111-111111111111',
  version: '1',
  kind: 'reference',
  title: 'Gröbner bases and graded rings',
  authors: ['de Silva, Ana', 'The Algebra Group'],
  year: 2024,
  doi: '10.1234/fixture',
  arxiv_id: 'math.AC/0501234v2',
  url: 'https://example.test/algebra',
  zotero_key: 'ABCDEFGH',
  citation_key: 'silva:2024',
  publication: {
    type: 'article',
    journal: 'Algebra Review',
    volume: '2',
    number: '7',
    pages: '91--105',
    issn: '1234-5678',
    pmid: '12345678',
    abstract: 'An example.\nTY  - BOOK',
    keywords: 'Rings; Grading',
    editor: 'Borel, Jean and Xu, Jia',
    note: 'Example note',
  },
};

describe('bibliography export formats', () => {
  it('roundtrips a PubMed Central identifier and preserves the journal type in CSL JSON', () => {
    const archived = { ...article, arxiv_id: null, doi: null, url: null, publication: { type: 'article', pmcid: 'PMC7840891' } };
    const journal = { ...article, title: 'Journal fixture', publication: { type: 'periodical', issn: '0003-486X' } };
    const data = bibliographyExport([archived, journal], 'csl-json').content;
    expect(JSON.parse(data)).toMatchObject([
      { PMCID: 'PMC7840891', URL: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7840891/' },
      { type: 'periodical', ISSN: '0003-486X' },
    ]);
    expect(parseBibliographyImport(data, 'csl-json').records.map((entry) => entry.publication)).toMatchObject([
      { pmcid: 'PMC7840891' }, { entryType: 'periodical', issn: '0003-486X' },
    ]);
  });
  it('roundtrips structured chapter creator roles through bibliography formats', () => {
    const creators = [
      { role: 'author', name: 'Example, Ada' },
      { role: 'editor', name: 'Editor, Eve' },
      { role: 'translator', name: 'Translator, Téa' },
    ] as const;
    const chapter: BibliographyItem = { ...article, title: 'Chapter on ideals', authors: ['Old projection'],
      creators: [...creators], publication: { type: 'incollection', booktitle: 'Algebra collection', publisher: 'Example Press' } };
    for (const format of ['bibtex', 'biblatex', 'ris', 'csl-json'] as const) {
      const result = parseBibliographyImport(bibliographyExport([chapter], format).content);
      expect(result.records[0].creators, format).toEqual(creators);
      expect(result.records[0].publication, format).toMatchObject({ entryType: 'chapter', containerTitle: 'Algebra collection' });
    }
  });
  it('exports a structured CSL JSON array with preserved citation keys and metadata', () => {
    const file = bibliographyExport([article], 'csl-json');
    expect(file).toMatchObject({ extension: '.json', mimeType: 'application/json;charset=utf-8' });
    expect(JSON.parse(file.content)).toEqual([
      {
        id: 'silva:2024',
        'citation-key': 'silva:2024',
        type: 'article-journal',
        title: article.title,
        author: [{ family: 'de Silva', given: 'Ana' }, { literal: 'The Algebra Group' }],
        editor: [
          { family: 'Borel', given: 'Jean' },
          { family: 'Xu', given: 'Jia' },
        ],
        issued: { 'date-parts': [[2024]] },
        DOI: '10.1234/fixture',
        PMID: '12345678',
        URL: 'https://example.test/algebra',
        archive: 'arXiv',
        archive_location: 'math.AC/0501234v2',
        'container-title': 'Algebra Review',
        volume: '2',
        issue: '7',
        page: '91--105',
        ISSN: '1234-5678',
        abstract: 'An example.\nTY  - BOOK',
        keyword: 'Rings; Grading',
        note: 'Example note',
      },
    ]);
  });

  it('roundtrips CSL JSON export with month, editors, and secondary identifiers', () => {
    const item = { ...article, publication: { ...article.publication, month: 'March', address: 'Budapest' } };
    const output = bibliographyExport([item], 'csl-json');
    const imported = parseBibliographyImport(output.content);
    expect(imported.format).toBe('csl-json');
    expect(imported.records[0]).toMatchObject({
      sourceKey: article.citation_key,
      fields: {
        title: article.title,
        authors: article.authors,
        year: article.year,
        doi: article.doi,
        arxiv_id: article.arxiv_id,
        url: article.url,
      },
      publication: {
        editors: ['Borel, Jean', 'Xu, Jia'],
        month: '3',
        address: 'Budapest',
        pmid: '12345678',
      },
    });
  });

  it('exports standard RIS tags and roundtrips core publication data', () => {
    const file = bibliographyExport([article], 'ris');
    expect(file.extension).toBe('.ris');
    const lines = file.content.trimEnd().split('\r\n');
    expect(lines[0]).toBe('TY  - JOUR');
    expect(lines.at(-1)).toBe('ER  -');
    expect(lines).toEqual(
      expect.arrayContaining([
        'ID  - silva:2024',
        'AU  - de Silva, Ana',
        'AU  - The Algebra Group',
        'AN  - math.AC/0501234v2',
        'DB  - arXiv',
        'L2  - https://arxiv.org/abs/math.AC/0501234v2',
        'SP  - 91',
        'EP  - 105',
        'SN  - 1234-5678',
      ]),
    );
    expect(lines.filter((line) => line.startsWith('TY  -'))).toHaveLength(1);
    const parsed = parseBibliographyImport(file.content);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      fields: {
        title: article.title,
        authors: article.authors,
        year: 2024,
        doi: '10.1234/fixture',
        arxiv_id: 'math.AC/0501234v2',
        url: 'https://example.test/algebra',
      },
      sourceKey: 'silva:2024',
      publication: {
        entryType: 'article-journal',
        containerTitle: 'Algebra Review',
        volume: '2',
        issue: '7',
        pages: '91-105',
        issn: '1234-5678',
        abstract: 'An example. TY - BOOK',
        keywords: ['Rings', 'Grading'],
      },
    });
  });

  it('exports BibLaTeX entry-key aliases and retains richer native fields', () => {
    const previousKey = 'graded_rings:2024';
    const record = {
      ...article,
      authors: ['de Silva, Ana', 'Mathematics and Topology Group'],
      citation_aliases: [previousKey, 'removed-record', previousKey, article.citation_key!, 'bad alias'],
      publication: { ...article.publication, month: 'March', address: 'Budapest' },
      url: 'https://example.test/graded_rings?id=1&download=1',
    };
    const output = bibliographyExport([record], 'biblatex');
    expect(output.extension).toBe('.bib');
    expect(output.content).toContain('@article{silva:2024,');
    expect(output.content).toContain('ids = {graded_rings:2024,removed-record}');
    expect(output.content).toContain('date = {2024-03}');
    expect(output.content).toContain('journaltitle = {Algebra Review}');
    expect(output.content).toContain('location = {Budapest}');
    expect(output.content).toContain('eprinttype = {arxiv}');
    expect(output.content).toContain('eprintclass = {math.AC}');
    expect(output.content).toContain('pmid = {12345678}');
    expect(output.content).toContain('author = {de Silva, Ana and {Mathematics and Topology Group}}');
    expect(output.content).toContain('url = {https://example.test/graded_rings?id=1&download=1}');
    expect(output.content).not.toContain('bad alias');
    expect(output.content).not.toContain('ABCDEFGH');
    const bibtex = bibliographyExport([record], 'bibtex').content;
    expect(bibtex).toContain('journal = {Algebra Review}');
    expect(bibtex).toContain('year = {2024}');
    expect(bibtex).toContain('archivePrefix = {arXiv}');
    expect(bibtex).not.toContain('ids =');
    expect(parseBibliographyImport(output.content).records[0]).toMatchObject({
      fields: {
        title: record.title,
        authors: record.authors,
        year: 2024,
        arxiv_id: record.arxiv_id,
        url: record.url,
      },
      publication: { containerTitle: 'Algebra Review' },
      sourceKey: 'silva:2024',
    });
  });

  it('avoids assigning an alias that is already a real citation key', () => {
    const source = { ...article, citation_aliases: ['other-record', 'merged-alias'] };
    const distinct = { ...article, citation_key: 'other-record' };
    const { content } = bibliographyExport([source, distinct], 'biblatex');
    expect(content).toContain('ids = {merged-alias}');
    expect(content).toContain('@article{other-record,');
    expect(content).not.toContain('ids = {other-record');
  });

  it('keeps BibTeX available and avoids leaking local fields in exports', () => {
    const file = bibliographyExport([article], 'bibtex');
    expect(file.extension).toBe('.bib');
    expect(file.content).toContain('@article{silva:2024,');
    expect(file.content).not.toContain('ABCDEFGH');
    expect(bibliographyExport([], 'ris').content).toBe('');
    expect(bibliographyExport([], 'csl-json').content).toBe('[]\n');
  });

  it('exports a readable Markdown bibliography with the stable citation key and source links', () => {
    const file = bibliographyExport([article], 'markdown');
    expect(file).toMatchObject({ extension: '.md', mimeType: 'text/markdown;charset=utf-8' });
    expect(file.content).toBe(
      [
        '# Bibliography\n',
        '- **Gröbner bases and graded rings**  ',
        '  de Silva, Ana; The Algebra Group · 2024 · Algebra Review · vol. 2 · no. 7 · pp. 91--105  ',
        '  [DOI 10.1234/fixture](<https://doi.org/10.1234/fixture>) · [arXiv math.AC/0501234v2](<https://arxiv.org/abs/math.AC/0501234v2>) · [Source](<https://example.test/algebra>)  ',
        '  Citation key: `silva:2024`\n',
      ].join('\n'),
    );
    expect(file.content).not.toContain('ABCDEFGH');
    expect(bibliographyExport([], 'markdown').content).toBe('');
  });

  it('keeps Markdown punctuation in metadata literal and skips unsafe source URLs', () => {
    const item = {
      ...article,
      title: 'A *result* [on rings]\n<script>',
      authors: ['1. Analysis Group'],
      doi: '10.1234/fixture#label',
      arxiv_id: null,
      url: 'javascript:alert(1)',
      citation_key: null,
      publication: null,
    };
    const { content } = bibliographyExport([item], 'markdown');
    expect(content).toContain('- **A \\*result\\* \\[on rings\\] \\<script\\>**');
    expect(content).toContain('1\\. Analysis Group');
    expect(content).toContain('https://doi.org/10.1234/fixture%23label');
    expect(content).toContain(`Citation key: \`ref-${article.id}\``);
    expect(content).not.toContain('javascript:');
  });
});

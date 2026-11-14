import { describe, expect, it } from 'vitest';
import {
  bibliographyCaptureLimit,
  parseBibliographyCapture,
  parseBibliographyCaptureTransfer,
  serializeBibliographyCapture,
} from '../../apps/web/lib/bibliography-capture';

const tags = (entries: [string, string][]) => entries.map(([name, content]) => ({ name, content }));

describe('browser bibliography capture', () => {
  it('uses scholarly citation tags and preserves multiple authors', () => {
    const result = parseBibliographyCapture({
      pageUrl: 'https://example.test/paper/123?view=paper#notes',
      canonicalUrl: './123',
      title: 'Page title',
      meta: tags([
        ['CITATION_TITLE', 'A graded ring theorem'],
        ['citation_author', 'Ada Example'],
        ['citation_author', 'Sam Example'],
        ['citation_author', '  Ada  Example '],
        ['citation_publication_date', '2023/05/02'],
        ['citation_journal_title', 'Example Journal'],
        ['citation_doi', 'https://doi.org/10.1234/article'],
        ['citation_pdf_url', '/files/123.pdf#page=1'],
        ['citation_firstpage', '21'],
        ['citation_lastpage', '31'],
        ['citation_volume', '4'],
        ['citation_issue', '2'],
        ['citation_keywords', 'Algebra; Graded Rings'],
        ['article:tag', 'algebra'],
        ['og:title', 'Social title'],
      ]),
    });
    expect(result).toEqual({
      fields: {
        title: 'A graded ring theorem',
        authors: ['Ada Example', 'Sam Example'],
        year: 2023,
        doi: '10.1234/article',
        arxiv_id: null,
        url: 'https://example.test/paper/123',
        tags: ['Algebra', 'Graded Rings'],
        publication: {
          type: 'article',
          journal: 'Example Journal',
          volume: '4',
          number: '2',
          pages: '21–31',
          keywords: 'Algebra, Graded Rings',
        },
      },
      pdfUrl: 'https://example.test/files/123.pdf',
    });
  });

  it('resolves scholarly JSON-LD references across a graph', () => {
    const graph = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'Journal home' },
        {
          '@type': 'https://schema.org/ScholarlyArticle',
          headline: 'Compact modules',
          url: '/paper',
          author: [{ '@id': '#author' }, { '@type': 'Organization', name: 'Example Group' }],
          datePublished: '2024-09-03',
          abstract: 'Synthetic abstract.',
          isPartOf: { '@id': '#issue' },
          identifier: { '@type': 'PropertyValue', propertyID: 'DOI', value: '10.4321/test' },
          encoding: { '@type': 'MediaObject', encodingFormat: 'application/pdf', contentUrl: '/paper.pdf' },
          publisher: { name: 'Example Press' },
        },
        { '@id': '#author', '@type': 'Person', givenName: 'Ada', familyName: 'Example' },
        { '@id': '#issue', '@type': 'PublicationIssue', issueNumber: 7, isPartOf: { '@id': '#journal' } },
        { '@id': '#journal', '@type': 'Periodical', name: 'Example Journal', issn: '1234-5678' },
      ],
    };
    expect(
      parseBibliographyCapture({
        pageUrl: 'https://example.test/read',
        jsonLd: ['malformed JSON', JSON.stringify(graph)],
      }),
    ).toMatchObject({
      fields: {
        title: 'Compact modules',
        authors: ['Example, Ada', 'Example Group'],
        url: 'https://example.test/paper',
        year: 2024,
        doi: '10.4321/test',
        publication: {
          type: 'article',
          journal: 'Example Journal',
          number: '7',
          issn: '1234-5678',
          publisher: 'Example Press',
          abstract: 'Synthetic abstract.',
        },
      },
      pdfUrl: 'https://example.test/paper.pdf',
    });
  });

  it('uses Dublin Core fields and derives versioned arXiv identity', () => {
    expect(
      parseBibliographyCapture({
        pageUrl: 'https://arxiv.org/abs/math.AC/0501234v2?ref=link',
        meta: tags([
          ['DC.Title', 'An algebraic note'],
          ['DC.creator', 'Example, Ada'],
          ['DCTERMS.issued', 'April 2005'],
          ['dc.description', 'A synthetic preprint.'],
          ['dc.subject', 'Algebra'],
        ]),
      }),
    ).toMatchObject({
      fields: {
        title: 'An algebraic note',
        authors: ['Example, Ada'],
        year: 2005,
        arxiv_id: 'math.AC/0501234v2',
        tags: ['Algebra'],
        publication: { type: 'misc', abstract: 'A synthetic preprint.' },
      },
      pdfUrl: 'https://arxiv.org/pdf/math.AC/0501234v2',
    });
  });

  it('falls back to OpenGraph without saving profile URLs as author names or unsafe links', () => {
    expect(
      parseBibliographyCapture({
        pageUrl: 'https://example.test/read#fragment',
        canonicalUrl: 'javascript:alert(1)',
        meta: tags([
          ['og:title', 'A page'],
          ['og:url', 'file:///local'],
          ['article:author', 'https://example.test/person/123'],
          ['article:published_time', '2026-05-07T01:02:03Z'],
          ['citation_pdf_url', 'https://user:secret@example.test/private.pdf'],
        ]),
      }),
    ).toMatchObject({
      fields: {
        title: 'A page',
        authors: [],
        year: 2026,
        url: 'https://example.test/read',
      },
      pdfUrl: null,
    });
    expect(parseBibliographyCapture({ pageUrl: 'file:///tmp/example.html', title: 'File' })).toBeNull();
    expect(parseBibliographyCapture({ pageUrl: 'https://example.test/' })).toBeNull();
  });
});

describe('browser capture clipboard transfer', () => {
  it('roundtrips metadata and revalidates untrusted clipboard fields', () => {
    const initial = parseBibliographyCapture({
      pageUrl: 'https://example.test/paper',
      meta: tags([
        ['citation_title', 'A synthetic paper'],
        ['citation_author', 'Example, Ada'],
        ['citation_pdf_url', '/paper.pdf'],
        ['citation_doi', '10.4321/fixture'],
        ['dc.subject', 'Algebra'],
      ]),
    });
    expect(initial).not.toBeNull();
    const transfer = serializeBibliographyCapture(initial!);
    expect(parseBibliographyCaptureTransfer(transfer)).toEqual(initial);

    const modified = JSON.parse(transfer);
    modified.capture.fields.authors = ['Example, Ada', 'Example, Ada', { bad: true }];
    modified.capture.fields.tags = ['Algebra', 'algebra', 'Geometry'];
    modified.capture.fields.publication = { type: 'article', journal: 'Example Journal', unknown: '<img>' };
    modified.capture.pdfUrl = 'javascript:alert(1)';
    expect(parseBibliographyCaptureTransfer(JSON.stringify(modified))).toMatchObject({
      fields: {
        authors: ['Example, Ada'],
        tags: ['Algebra', 'Geometry'],
        publication: { type: 'article', journal: 'Example Journal' },
      },
      pdfUrl: null,
    });
    expect(parseBibliographyCaptureTransfer(JSON.stringify(modified)).fields.publication).not.toHaveProperty(
      'unknown',
    );

    modified.capture.fields.url = 'https://private:secret@example.test/';
    expect(() => parseBibliographyCaptureTransfer(JSON.stringify(modified))).toThrow(/valid web address/);
  });

  it('rejects non-PRISM and oversized data', () => {
    expect(() => parseBibliographyCaptureTransfer('not JSON')).toThrow(/Paste the reference/);
    expect(() => parseBibliographyCaptureTransfer('{"format":"another"}')).toThrow(/Paste the reference/);
    expect(() => parseBibliographyCaptureTransfer('x'.repeat(bibliographyCaptureLimit + 1))).toThrow(
      /too large/,
    );
  });

  it('retains plain page text with paragraph boundaries and rejects controls', () => {
    const source = { format: 'prism-reference-v1', capture: {
      fields: { title: 'Fixture', url: 'https://example.test/article' },
      snapshot: { text: 'First line.\r\n\r\nSecond line.', truncated: true },
    } };
    expect(parseBibliographyCaptureTransfer(JSON.stringify(source)).snapshot).toEqual({
      text: 'First line.\n\nSecond line.', truncated: true,
    });
    source.capture.snapshot.text = '\u0000hidden';
    expect(() => parseBibliographyCaptureTransfer(JSON.stringify(source))).toThrow(/page text/);
  });
});

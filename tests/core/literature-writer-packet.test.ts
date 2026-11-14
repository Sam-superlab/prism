import { describe, expect, it } from 'vitest';
import type { BibliographyItem } from '../../apps/web/lib/bibliography';
import { buildWriterCitationPacket, writerPacketHeader } from '../../apps/web/lib/literature-writer-packet';

const sample: BibliographyItem = {
  id: 'reference-1',
  version: '1',
  kind: 'reference',
  title: 'Étude\t 数学\nand 😀',
  authors: ['Example, Ada', 'Sample, Charles'],
  year: 2025,
  doi: '10.1234/sample',
  arxiv_id: '2601.12345',
  url: 'https://example.org/private?token=test',
  zotero_key: null,
  citation_key: 'sample-key',
  citation_aliases: ['older-key'],
  publication: {
    type: 'article-journal',
    journal: 'Journal',
    publisher: 'Press',
    volume: '2',
    number: '3',
    pages: '42–45',
    note: 'private note',
  },
};

describe('Writer citation packet', () => {
  it('exports only chosen citation metadata with canonical keys and fixed UTF-8 columns', () => {
    const other = {
      ...sample,
      id: 'reference-2',
      citation_key: 'not-selected',
      citation_aliases: [],
      title: 'Do not export',
    };
    const result = buildWriterCitationPacket('older-key, sample-key\nmissing', [sample, other]);
    expect(result.entries).toEqual([{ key: 'sample-key', title: 'Étude 数学 and 😀' }]);
    expect(result.missing).toEqual(['missing']);
    expect(result.ambiguous).toEqual([]);
    const [header, row, trailing] = result.packet.split('\n');
    expect(header).toBe(writerPacketHeader);
    expect(trailing).toBe('');
    expect(row?.split('\t')).toEqual([
      'sample-key',
      '0',
      'Étude 数学 and 😀',
      'Example, Ada; Sample, Charles',
      '2025',
      'Journal',
      '',
      'Press',
      '2',
      '3',
      '42–45',
      '10.1234/sample',
      '2601.12345',
      '',
    ]);
    expect(result.packet).not.toMatch(/private|not-selected|Do not export/);
  });

  it('reports alias and canonical collisions without exporting either record', () => {
    const conflicting = {
      ...sample,
      id: 'reference-2',
      citation_aliases: ['conflicting-alias', 'older-key'],
    };
    const result = buildWriterCitationPacket('older-key\nconflicting-alias\nsample-key', [
      sample,
      conflicting,
    ]);
    expect(result.ambiguous).toEqual(['older-key', 'conflicting-alias', 'sample-key']);
    expect(result.entries).toEqual([]);
  });

  it('rejects invalid keys, too many rows, and oversized UTF-8 packets', () => {
    expect(() => buildWriterCitationPacket('=RUN()', [sample])).toThrow('citation keys');
    expect(() =>
      buildWriterCitationPacket(Array.from({ length: 101 }, (_, i) => `k${i}`).join(' '), []),
    ).toThrow('100');
    const references = Array.from({ length: 100 }, (_, i) => ({
      ...sample,
      id: `reference-${i}`,
      citation_key: `key-${i}`,
      title: '数'.repeat(800),
      authors: ['学'.repeat(800)],
    }));
    expect(() =>
      buildWriterCitationPacket(references.map((item) => item.citation_key).join(' '), references),
    ).toThrow('too large');
  });
});

import { describe, expect, it } from 'vitest';
import type { BibliographyItem } from '../../apps/web/lib/bibliography';
import { buildWriterCitationPacket } from '../../apps/web/lib/literature-writer-packet';
import {
  citationFieldOptions,
  describeWordSource,
  maxPacketBytes,
  parseCitationPacket,
} from '../../apps/word-citations/packet.mjs';
import {
  insertBibliography,
  insertCitation,
  refreshSelectedBibliography,
  supportedWordHost,
} from '../../apps/word-citations/word-host.mjs';

const source: BibliographyItem = {
  id: 'reference-1',
  kind: 'reference',
  version: '1',
  title: 'Étude <source> & 数学',
  authors: ['Example, Ada', 'Ada Example'],
  year: 2026,
  doi: '10.1234/example',
  arxiv_id: '2601.12345',
  url: 'https://example.org/private',
  zotero_key: null,
  citation_key: 'synthetic:paper',
  citation_aliases: ['old'],
  publication: { type: 'article-journal', journal: 'Fixture Journal', pages: '34–45' },
};
const encoder = new TextEncoder();
const packet = () => buildWriterCitationPacket('old', [source]).packet;
const reference = () => parseCitationPacket(encoder.encode(packet()))[0];

function mockWord(
  options: {
    existingTag?: string;
    hasBibliography?: boolean;
    cited?: boolean;
    selectedBibliographies?: number;
    locked?: boolean;
  } = {},
) {
  const calls: unknown[][] = [];
  const field = {
    updateResult() {
      calls.push(['update']);
    },
    locked: !!options.locked,
  };
  const fields = (type: string) => ({
    load(property: string) {
      calls.push(['load fields', type, property]);
    },
  });
  const point = {
    insertField(...args: unknown[]) {
      calls.push(['insert field', ...args]);
      return field;
    },
  };
  const selection = {
    getRange(location: string) {
      calls.push(['selection edge', location]);
      return point;
    },
    fields: {
      getByTypes([type]: string[]) {
        return {
          ...fields(type),
          items: Array.from({ length: options.selectedBibliographies ?? 0 }, () => field),
        };
      },
    },
  };
  const document = {
    bibliography: {
      sources: {
        items: options.existingTag
          ? [
              {
                tag: options.existingTag,
                xml: 'invalid XML',
                load(property: string) {
                  calls.push(['load source', property]);
                },
              },
            ]
          : [],
        load(property: string) {
          calls.push(['load sources', property]);
        },
        add(xml: string) {
          calls.push(['add source', xml]);
        },
      },
    },
    getSelection() {
      calls.push(['selection']);
      return selection;
    },
    body: {
      fields: {
        getByTypes([type]: string[]) {
          return {
            ...fields(type),
            items: (type === 'Bibliography' ? options.hasBibliography : options.cited) ? [field] : [],
          };
        },
      },
      insertParagraph(text: string, location: string) {
        calls.push(['paragraph', text, location]);
        return {
          getRange(edge: string) {
            calls.push(['paragraph edge', edge]);
            return point;
          },
        };
      },
    },
  };
  return {
    calls,
    word: {
      run(callback: (value: { document: typeof document; sync(): Promise<void> }) => Promise<void>) {
        return callback({
          document,
          async sync() {
            calls.push(['sync']);
          },
        });
      },
    },
  };
}

describe('Word citation add-in pilot', () => {
  it('reads the real PRISM packet, preserving UTF-8 while escaping source XML', async () => {
    expect(reference()).toMatchObject({
      key: source.citation_key,
      title: source.title,
      type: 0,
      year: '2026',
    });
    const entry = await describeWordSource(reference());
    expect(entry.tag).toMatch(/^PRISM_[a-f0-9]{24}$/);
    expect(entry.tag).toBe((await describeWordSource({ ...reference(), title: 'Another title' })).tag);
    expect(entry.xml).toContain('Étude &lt;source&gt; &amp; 数学');
    expect(entry.xml).toContain('<b:Last>Example</b:Last><b:First>Ada</b:First>');
    expect(entry.xml).toContain('<b:URL>https://doi.org/10.1234/example</b:URL>');
    expect(entry.xml).not.toContain('https://example.org/private');
    expect(citationFieldOptions(entry.tag, '12–14')).toBe(`${entry.tag} \\p "12–14"`);
    expect(() => citationFieldOptions(entry.tag, '4" \\l 99')).toThrow(/page numbers/);
  });

  it('rejects duplicate, hostile, oversized and invalid-encoding packets', () => {
    const [header, line] = packet().split('\n');
    expect(() => parseCitationPacket(encoder.encode(`${header}\n${line}\n${line}\n`))).toThrow(/duplicate/);
    expect(() => parseCitationPacket(encoder.encode(packet().replace('Étude', 'literal\x01')))).toThrow(
      /Invalid/,
    );
    expect(() => parseCitationPacket(encoder.encode(packet().replace('synthetic:paper', 'a" \\x')))).toThrow(
      /Invalid/,
    );
    expect(() => parseCitationPacket(Uint8Array.of(255))).toThrow(/UTF-8/);
    expect(() => parseCitationPacket(new Uint8Array(maxPacketBytes + 1))).toThrow(/256 KiB/);
    expect(parseCitationPacket(encoder.encode(packet().replaceAll('\n', '\r\n')))).toEqual([reference()]);
  });

  it('requires desktop Office and the two API sets', () => {
    const requirements = new Set(['WordApi/1.5', 'WordApiDesktop/1.3']);
    const office = {
      PlatformType: { Mac: 'Mac', PC: 'PC' },
      context: {
        requirements: {
          isSetSupported(name: string, version: string) {
            return requirements.has(`${name}/${version}`);
          },
        },
      },
    };
    expect(supportedWordHost(office, 'Mac')).toBe(true);
    expect(supportedWordHost(office, 'PC')).toBe(true);
    expect(supportedWordHost(office, 'OfficeOnline')).toBe(false);
    requirements.delete('WordApiDesktop/1.3');
    expect(supportedWordHost(office, 'Mac')).toBe(false);
  });

  it('adds only the selected source before inserting a citation at selection end', async () => {
    const mock = mockWord();
    const { tag, xml } = await describeWordSource(reference());
    await insertCitation(mock.word, reference(), '4');
    expect(mock.calls).toEqual([
      ['selection'],
      ['selection edge', 'End'],
      ['load sources', 'items/tag'],
      ['sync'],
      ['add source', xml],
      ['sync'],
      ['insert field', 'End', 'Citation', `${tag} \\p "4"`],
      ['update'],
      ['sync'],
    ]);
    const untouched = mockWord();
    await expect(insertCitation(untouched.word, reference(), '4"')).rejects.toThrow(/page numbers/);
    expect(untouched.calls).toEqual([]);
  });

  it('preserves unrelated bibliographies, and refreshes only the selected unlocked field', async () => {
    const withBibliography = mockWord({ hasBibliography: true, cited: true });
    await expect(insertBibliography(withBibliography.word)).rejects.toThrow(/already has a bibliography/);
    expect(withBibliography.calls).not.toContainEqual(['update']);
    const noCitations = mockWord();
    await expect(insertBibliography(noCitations.word)).rejects.toThrow(/main document/);
    expect(noCitations.calls).not.toContainEqual(['update']);
    const cited = mockWord({ cited: true });
    await insertBibliography(cited.word);
    expect(cited.calls).toContainEqual(['paragraph', '', 'End']);
    expect(cited.calls).toContainEqual(['insert field', 'Start', 'Bibliography']);
    const chosen = mockWord({ selectedBibliographies: 1 });
    await refreshSelectedBibliography(chosen.word);
    expect(chosen.calls).toEqual([
      ['selection'],
      ['load fields', 'Bibliography', 'items/locked'],
      ['sync'],
      ['update'],
      ['sync'],
    ]);
    const several = mockWord({ selectedBibliographies: 2 });
    await expect(refreshSelectedBibliography(several.word)).rejects.toThrow(/exactly one/);
    expect(several.calls).not.toContainEqual(['update']);
    const locked = mockWord({ selectedBibliographies: 1, locked: true });
    await expect(refreshSelectedBibliography(locked.word)).rejects.toThrow(/Unlock/);
    expect(locked.calls).not.toContainEqual(['update']);
  });
});

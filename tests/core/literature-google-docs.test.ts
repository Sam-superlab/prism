import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { BibliographyItem } from '../../apps/web/lib/bibliography';
import { buildGoogleDocsCitationPacket } from '../../apps/web/lib/literature-google-docs';

type Summary = { add: number; refresh: number; bibliography: boolean; skipped: number; missing: string[] };
const script = readFileSync(new URL('../../apps/google-docs-citations/Code.gs', import.meta.url), 'utf8');
const item: BibliographyItem = {
  id: 'book',
  kind: 'reference',
  version: '1',
  title: 'Synthetic book',
  authors: ['Example, Ada'],
  year: 2025,
  doi: null,
  arxiv_id: null,
  url: null,
  zotero_key: null,
  citation_key: 'new',
  citation_aliases: ['old'],
  publication: { type: 'book', publisher: 'Example Press' },
};

function googleDocs(paragraphs: string[]) {
  type Node = ReturnType<typeof makeText>;
  type Span = { text: Node; start: number; end: number };
  type Named = { name: string; span: Span; remove(): void; getName(): string; getRange(): unknown };
  const named: Named[] = [];
  let span: Span;
  const edits: string[] = [];
  const body = {
    getType: () => 'BODY_SECTION',
    getNumChildren: () => nodes.length,
    getChild: (index: number) => nodes[index].paragraph,
    getChildIndex: (paragraph: unknown) => nodes.findIndex((node) => node.paragraph === paragraph),
  };
  function makeText(text: string) {
    const paragraph = {
      getType: () => 'PARAGRAPH',
      getParent: () => body,
      getNumChildren: () => 1,
      getChild: () => node,
      getChildIndex: () => 0,
    };
    const node = {
      paragraph,
      getType: () => 'TEXT',
      getParent: () => paragraph,
      asText: () => node,
      getText: () => text,
      getAttributes: () => ({ bold: true }),
      deleteText: (start: number, end: number) => {
        const count = end + 1 - start;
        text = text.slice(0, start) + text.slice(end + 1);
        for (const range of named)
          if (range.span.text === node && range.span.start > end) {
            range.span.start -= count;
            range.span.end -= count;
          }
      },
      insertText: (start: number, value: string) => {
        text = text.slice(0, start) + value + text.slice(start);
        for (const range of named)
          if (range.span.text === node && range.span.start >= start) {
            range.span.start += value.length;
            range.span.end += value.length;
          }
        edits.push(value);
      },
      setAttributes: () => {},
      changeText: (value: string) => {
        text = value;
      },
    };
    return node;
  }
  const nodes = paragraphs.map(makeText);
  const builder = {
    addElement: (text: Node, start: number, end: number) => {
      span = { text, start, end };
      return builder;
    },
    build: () => span,
  };
  const tab = {
    getBody: () => body,
    getNamedRanges: () => [...named],
    newRange: () => builder,
    addNamedRange: (name: string, range: Span) => {
      const value: Named = {
        name,
        span: range,
        remove: () => {
          named.splice(named.indexOf(value), 1);
        },
        getName: () => name,
        getRange: () => ({
          getRangeElements: () => [
            {
              getElement: () => range.text,
              isPartial: () => true,
              getStartOffset: () => range.start,
              getEndOffsetInclusive: () => range.end,
            },
          ],
        }),
      };
      named.push(value);
    },
  };
  const context = createContext({
    Utilities: {
      computeDigest: (_: unknown, value: string) => [...createHash('sha256').update(value).digest()],
      DigestAlgorithm: { SHA_256: 1 },
      Charset: { UTF_8: 1 },
    },
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    DocumentApp: {
      ElementType: { BODY_SECTION: 'BODY_SECTION', PARAGRAPH: 'PARAGRAPH', TEXT: 'TEXT' },
      getActiveDocument: () => ({
        getActiveTab: () => ({ getId: () => 'test-tab', asDocumentTab: () => tab }),
      }),
    },
  });
  runInContext(script, context);
  return {
    nodes,
    named,
    edits,
    preview: context.previewPrismCitations as (packet: string) => { summary: Summary; token: string },
    apply: context.applyPrismCitations as (packet: string, token: string) => Summary,
  };
}

describe('Google Docs bound citation bridge', () => {
  it('prepares only formatted marker data and previews before adding named citations and bibliography', () => {
    const source = 'Private prose. [[cite:old|12–14]] and [[cite:old]].';
    const packet = buildGoogleDocsCitationPacket(source, [item]);
    expect(packet.packet).not.toContain('Private prose');
    const docs = googleDocs([source, '[[bibliography]]', 'User paragraph']);
    const preview = docs.preview(packet.packet);
    expect(preview.summary).toMatchObject({ add: 2, refresh: 0, bibliography: true, skipped: 0 });
    expect(docs.edits).toEqual([]);
    docs.apply(packet.packet, preview.token);
    expect(docs.nodes[0].getText()).toBe('Private prose. (Example, 2025, pp. 12–14) and (Example, 2025).');
    expect(docs.nodes[1].getText()).toContain('Synthetic book');
    expect(docs.nodes[2].getText()).toBe('User paragraph');
    expect(docs.named).toHaveLength(3);
    expect(docs.preview(packet.packet).summary).toMatchObject({ add: 0, refresh: 0, bibliography: false });
  });

  it('rejects stale previews and preserves collaborator edits in managed ranges', () => {
    const source = 'See [[cite:old]].';
    const first = buildGoogleDocsCitationPacket(source, [item]).packet;
    const docs = googleDocs([source, '[[bibliography]]']);
    const stale = docs.preview(first);
    docs.nodes[0].changeText('Changed ' + source);
    expect(() => docs.apply(first, stale.token)).toThrow('Preview again');
    expect(docs.edits).toEqual([]);
    docs.apply(first, docs.preview(first).token);

    const second = buildGoogleDocsCitationPacket(source, [{ ...item, year: 2026 }]).packet;
    const refresh = docs.preview(second);
    expect(refresh.summary).toMatchObject({ refresh: 1, bibliography: true });
    docs.apply(second, refresh.token);
    expect(docs.nodes[0].getText()).toContain('(Example, 2026)');

    docs.nodes[0].changeText(docs.nodes[0].getText().replace('Example', 'Changed'));
    const edited = docs.preview(first);
    expect(edited.summary).toMatchObject({ refresh: 0, bibliography: false, skipped: 2 });
  });

  it('reports missing markers and keeps an existing bibliography intact when packet coverage is partial', () => {
    const packet = buildGoogleDocsCitationPacket('[[cite:old]]', [item]).packet;
    const docs = googleDocs(['[[cite:old]] and [[cite:missing]]', '[[bibliography]]']);
    const preview = docs.preview(packet);
    expect(preview.summary).toMatchObject({ add: 1, bibliography: false, missing: ['missing'] });
    docs.apply(packet, preview.token);
    expect(docs.nodes[1].getText()).toBe('[[bibliography]]');
    expect(() => docs.preview('{"entries":[]}')).toThrow('unsupported format');
  });
});

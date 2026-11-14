import { describe, expect, it } from 'vitest';
import {
  reflowLiteraturePdfPage,
  reflowLiteraturePdfPageWithMap,
  scanLiteraturePdfRunningMargins,
} from '../../apps/web/lib/literature-pdf-reflow';

function item(str: string, x: number, y: number, hasEOL = false, height = 10, width = str.length * 5) {
  return { str, dir: 'ltr', transform: [height, 0, 0, height, x, y], width, height, fontName: 'F1', hasEOL };
}

const pageBounds = [20, 10, 620, 810];
function marginPage(
  pageNumber: number,
  { header = 'Synthetic algebra notes', headerSize = 8, headerX = 55, footer = String(pageNumber + 10) } = {},
) {
  return {
    items: [
      item(header, headerX, 783, true, headerSize),
      item('A body heading', 55, 722, true, 14),
      item('Repeated body text', 55, 687, true),
      item('continues below.', 55, 674, true),
      item(footer, 315, 37, true, 8),
    ],
  };
}

describe('literature PDF text reflow', () => {
  it('joins wrap lines, separates paragraphs, and keeps UTF-16 source offsets exact', () => {
    const items = [
      item('  Mathematical 𝕜', 40, 700),
      { type: 'beginMarkedContent', id: 'first' },
      item('text ', 150, 700, true),
      item('continues below.', 40, 687, true),
      item('Next paragraph.', 40, 655, true),
    ];
    const result = reflowLiteraturePdfPageWithMap({ items });
    expect(result.paragraphs).toEqual(['Mathematical 𝕜 text continues below.', 'Next paragraph.']);
    expect(result.spans.map((span) => span.itemIndex)).toEqual([0, 2, 3, 4]);
    expect(result.spans[0].sourceFrom).toBe(2);
    for (const { itemIndex, paragraph, from, to, sourceFrom, sourceTo } of result.spans) {
      expect(result.paragraphs[paragraph].slice(from, to)).toBe(
        items[itemIndex].str?.slice(sourceFrom, sourceTo),
      );
    }
  });

  it('retains formula lines, superscript order, and literal hyphens', () => {
    const result = reflowLiteraturePdfPage({
      items: [
        item('The polynomial', 40, 700, true),
        item('x', 40, 687, false, 10, 5),
        item('²', 45, 692, false, 6, 3),
        item(' + y ∈ R[x,y]', 48, 687, true),
        item('is well-', 40, 674, true),
        item('defined.', 40, 661, true),
      ],
    });
    expect(result).toEqual(['The polynomial\nx² + y ∈ R[x,y]\nis well-defined.']);
  });

  it('preserves PDF stream order when two columns restart at the top of a page', () => {
    const result = reflowLiteraturePdfPage({
      items: [
        item('Left column first', 40, 700, true),
        item('left column last', 40, 688, true),
        item('Right column first', 300, 700, true),
        item('right column last', 300, 688, true),
      ],
    });
    expect(result).toEqual(['Left column first left column last', 'Right column first right column last']);
  });

  it('retains explicit paragraph breaks with correct intra-item offsets', () => {
    const result = reflowLiteraturePdfPageWithMap({
      items: [item('First.\r\n\r\n Second.', 40, 700, true)],
    });
    expect(result.paragraphs).toEqual(['First.', 'Second.']);
    expect(result.spans).toEqual([
      { itemIndex: 0, paragraph: 0, from: 0, to: 6, sourceFrom: 0, sourceTo: 6 },
      { itemIndex: 0, paragraph: 1, from: 0, to: 7, sourceFrom: 11, sourceTo: 18 },
    ]);
  });

  it('suppresses confirmed repeated running margins and preserves the original body mapping', () => {
    const page = marginPage(4);
    const nearbyMargins = [2, 3, 5].map((number) =>
      scanLiteraturePdfRunningMargins(marginPage(number), number, pageBounds),
    );
    expect(reflowLiteraturePdfPage(page)[0]).toBe('Synthetic algebra notes');
    const result = reflowLiteraturePdfPageWithMap(page, { pageNumber: 4, bounds: pageBounds, nearbyMargins });
    expect(result.paragraphs).toEqual(['A body heading', 'Repeated body text continues below.']);
    expect(result.spans.map((span) => span.itemIndex)).toEqual([1, 2, 3]);
    for (const { itemIndex, paragraph, from, to, sourceFrom, sourceTo } of result.spans) {
      expect(result.paragraphs[paragraph].slice(from, to)).toBe(
        page.items[itemIndex].str.slice(sourceFrom, sourceTo),
      );
    }
  });

  it('keeps the first or unmatched top line, headings, and unrelated footer numbers', () => {
    const nearbyMargins = [3, 4, 5].map((number) =>
      scanLiteraturePdfRunningMargins(marginPage(number), number, pageBounds),
    );
    expect(
      reflowLiteraturePdfPage(marginPage(2, { footer: '184' }), {
        pageNumber: 2,
        bounds: pageBounds,
        nearbyMargins,
      }),
    ).toEqual(['Synthetic algebra notes', 'A body heading', 'Repeated body text continues below.', '184']);
    expect(
      reflowLiteraturePdfPage(marginPage(4, { header: 'New topic', headerSize: 15 }), {
        pageNumber: 4,
        bounds: pageBounds,
        nearbyMargins,
      }),
    ).toEqual(['New topic', 'A body heading', 'Repeated body text continues below.']);
    expect(
      reflowLiteraturePdfPage(marginPage(4, { headerX: 310 }), {
        pageNumber: 4,
        bounds: pageBounds,
        nearbyMargins,
      })[0],
    ).toBe('Synthetic algebra notes');

    const heading = { header: 'Theorem 1. A statement' };
    const headingMargins = [2, 3, 5].map((number) =>
      scanLiteraturePdfRunningMargins(marginPage(number, heading), number, pageBounds),
    );
    expect(
      reflowLiteraturePdfPage(marginPage(4, heading), {
        pageNumber: 4,
        bounds: pageBounds,
        nearbyMargins: headingMargins,
      })[0],
    ).toBe(heading.header);
  });

  it('requires two distinct nearby matches and protects multi-line margin content', () => {
    const previous = scanLiteraturePdfRunningMargins(marginPage(3), 3, pageBounds);
    const distant = scanLiteraturePdfRunningMargins(marginPage(50), 50, pageBounds);
    const page = marginPage(4);
    expect(
      reflowLiteraturePdfPage(page, {
        pageNumber: 4,
        bounds: pageBounds,
        nearbyMargins: [previous, previous, distant],
      }),
    ).toEqual(reflowLiteraturePdfPage(page));

    page.items.push(item('A body footnote.', 55, 57, true, 8));
    const nearbyMargins = [2, 3, 5].map((number) =>
      scanLiteraturePdfRunningMargins(marginPage(number), number, pageBounds),
    );
    expect(reflowLiteraturePdfPage(page, { pageNumber: 4, bounds: pageBounds, nearbyMargins }).at(-1)).toBe(
      'A body footnote.',
    );
  });
});

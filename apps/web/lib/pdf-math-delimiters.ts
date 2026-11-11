import type { PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { TextRun } from './pdf-math-layout';

export type PdfMathExtensionFont = 'cmex' | 'latin-modern';
type ExtensionFonts = ReadonlyMap<string, PdfMathExtensionFont>;
type Kind = 'paren' | 'bracket' | 'brace' | 'bar' | 'double-bar';
type Side = 'left' | 'right' | 'either';
type Part = 'top' | 'middle' | 'bottom' | 'extension';

export interface PdfMathDelimiter {
  kind: Kind;
  side: Side;
  start: number;
  end: number;
  x: number;
  width: number;
  bottom: number;
  top: number;
  size: number;
}

interface DelimiterGlyph {
  kind: Kind;
  side: Side;
  part?: Part;
  depth?: number;
}

const plainGlyphs: Record<string, DelimiterGlyph> = {
  '(': { kind: 'paren', side: 'left' },
  ')': { kind: 'paren', side: 'right' },
  '[': { kind: 'bracket', side: 'left' },
  ']': { kind: 'bracket', side: 'right' },
  '{': { kind: 'brace', side: 'left' },
  '}': { kind: 'brace', side: 'right' },
  '|': { kind: 'bar', side: 'either' },
  '∣': { kind: 'bar', side: 'either' },
  '‖': { kind: 'double-bar', side: 'either' },
  '∥': { kind: 'double-bar', side: 'either' },
  '||': { kind: 'double-bar', side: 'either' },
};

const glyphPieces = new Map<string, DelimiterGlyph>();
for (const [kind, side, characters, depth] of [
  ['paren', 'left', '⎛⎝', 1.76],
  ['paren', 'right', '⎞⎠', 1.76],
  ['bracket', 'left', '⎡⎣', 1.76],
  ['bracket', 'right', '⎤⎦', 1.76],
  ['brace', 'left', '⎧⎩', 0.9],
  ['brace', 'right', '⎫⎭', 0.9],
] as const) {
  Array.from(characters).forEach((glyph, index) =>
    glyphPieces.set(glyph, { kind, side, part: index < 2 ? 'top' : 'bottom', depth }),
  );
}
for (const [kind, side, part, characters, depth] of [
  ['paren', 'left', 'extension', '⎜', 0.6],
  ['paren', 'right', 'extension', '⎟', 0.6],
  ['bracket', 'left', 'extension', '⎢', 0.6],
  ['bracket', 'right', 'extension', '⎥', 0.6],
  ['brace', 'left', 'middle', '⎨', 1.8],
  ['brace', 'right', 'middle', '⎬', 1.8],
  ['brace', 'either', 'extension', '⎪', 0.3],
] as const) {
  for (const glyph of characters) glyphPieces.set(glyph, { kind, side, part, depth });
}

// Computer Modern's legacy font encoding can expose delimiter slots as text.
const legacyGlyphs = new Map<string, DelimiterGlyph>();
for (const [kind, left, right, depth] of [
  ['paren', 0, 1, 1.16],
  ['paren', 16, 17, 1.76],
  ['paren', 18, 19, 2.36],
  ['paren', 32, 33, 2.96],
  ['bracket', 2, 3, 1.16],
  ['bracket', 104, 105, 1.76],
  ['bracket', 20, 21, 2.36],
  ['bracket', 34, 35, 2.96],
  ['brace', 8, 9, 1.16],
  ['brace', 110, 111, 1.76],
  ['brace', 26, 27, 2.36],
  ['brace', 40, 41, 2.96],
] as const) {
  legacyGlyphs.set(String.fromCharCode(left), { kind, side: 'left', depth });
  legacyGlyphs.set(String.fromCharCode(right), { kind, side: 'right', depth });
}
const extensionWidths = {
  paren: [0.4583, 0.5972, 0.7361, 0.7917],
  bracket: [0.4167, 0.4722, 0.5278, 0.5833],
  brace: [0.5833, 0.6667, 0.75, 0.8056],
};
const extensionDepths = [1.16, 1.76, 2.36, 2.96];

export function readPdfMathExtensionFonts(page: PDFPageProxy, items: readonly TextItem[]): ExtensionFonts {
  const styles = new Map<string, PdfMathExtensionFont>();
  for (const id of new Set(items.map((item) => item.fontName))) {
    if (!page.commonObjs.has(id)) continue;
    const font: unknown = page.commonObjs.get(id);
    if (!font || typeof font !== 'object' || !('name' in font) || typeof font.name !== 'string') continue;
    const name = font.name.replace(/^[A-Z]{6}\+/, '');
    if (/^cmex\d*(?:-regular)?$/i.test(name)) styles.set(id, 'cmex');
    else if (/^(?:lmex|lmmathextension)\d*(?:-regular)?$/i.test(name)) styles.set(id, 'latin-modern');
  }
  return styles;
}

function glyphForRun(run: TextRun, fonts?: ExtensionFonts): DelimiterGlyph | undefined {
  const text = run.text.trim();
  const font = fonts?.get(run.font);
  const pieces = glyphPieces.get(text);
  if (pieces && (font || !/[\uE000-\uF8FF]/u.test(text))) return pieces;
  const plain = Object.hasOwn(plainGlyphs, text) ? plainGlyphs[text] : undefined;
  if (!font) return plain;
  const legacy = font === 'cmex' ? legacyGlyphs.get(text) : undefined;
  // A CMEX parenthesis code can mean a brace; distinguish an explicit Unicode
  // parenthesis at the same code point by its measured glyph advance.
  if (legacy && ((text !== '(' && text !== ')') || Math.abs(run.width / run.size - 0.8056) < 0.007)) {
    return legacy;
  }
  if (!plain) return;
  if (plain.kind === 'bar' || plain.kind === 'double-bar') return { ...plain, depth: 0.6 };
  const widths = extensionWidths[plain.kind];
  const index = widths.findIndex((width) => Math.abs(run.width / run.size - width) < 0.022);
  return index < 0 ? undefined : { ...plain, depth: extensionDepths[index] };
}

export function isPdfMathDelimiterRun(run: TextRun, fonts?: ExtensionFonts): boolean {
  return Boolean(glyphForRun(run, fonts));
}

function measure(run: TextRun, glyph: DelimiterGlyph, fonts?: ExtensionFonts): PdfMathDelimiter {
  const depth = fonts?.has(run.font) ? glyph.depth : undefined;
  return {
    kind: glyph.kind,
    side: glyph.side,
    start: run.start,
    end: run.end,
    x: run.x,
    width: run.width,
    bottom: run.y - run.size * (depth ?? 0.23),
    top: run.y + run.size * (depth === undefined ? 0.8 : 0.04),
    size: run.size,
  };
}

function sameColumn(first: TextRun, next: TextRun): boolean {
  return (
    first.font === next.font &&
    Math.abs(first.x - next.x) <= first.size * 0.13 &&
    Math.abs(first.size - next.size) <= first.size * 0.1 &&
    Math.abs(first.width - next.width) <= first.size * 0.16
  );
}

export function collectPdfMathDelimiters(
  runs: readonly TextRun[],
  fonts?: ExtensionFonts,
): PdfMathDelimiter[] {
  const delimiters: PdfMathDelimiter[] = [];
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index];
    if (
      !run.horizontal ||
      ![run.x, run.y, run.size, run.width].every(Number.isFinite) ||
      run.size <= 0 ||
      run.width <= 0
    )
      continue;
    const glyph = glyphForRun(run, fonts);
    if (!glyph || (glyph.part && glyph.part !== 'top')) continue;
    const delimiter = measure(run, glyph, fonts);
    const repeatBar = (glyph.kind === 'bar' || glyph.kind === 'double-bar') && glyph.depth === 0.6;
    if (glyph.part === 'top' || repeatBar) {
      let completed = repeatBar;
      let last = index;
      for (let next = index + 1; next < runs.length; next++) {
        const candidate = runs[next];
        if (!candidate.horizontal || !sameColumn(run, candidate) || candidate.y >= runs[last].y) break;
        const fragment = glyphForRun(candidate, fonts);
        if (
          !fragment ||
          fragment.kind !== glyph.kind ||
          (fragment.side !== glyph.side && fragment.side !== 'either') ||
          (repeatBar ? fragment.depth !== 0.6 : !fragment.part || fragment.part === 'top')
        )
          break;
        const bounds = measure(candidate, fragment, fonts);
        if (Math.abs(bounds.top - delimiter.bottom) > run.size * 0.29) break;
        delimiter.bottom = Math.min(delimiter.bottom, bounds.bottom);
        delimiter.end = candidate.end;
        last = next;
        if (fragment.part === 'bottom') {
          completed = true;
          break;
        }
      }
      if (!completed) continue;
      index = last;
    }
    delimiters.push(delimiter);
  }
  return delimiters;
}

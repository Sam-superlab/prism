import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { collectPdfCases } from './pdf-math-cases';
import {
  collectPdfMathDelimiters,
  isPdfMathDelimiterRun,
  type PdfMathExtensionFont,
} from './pdf-math-delimiters';
import type { PdfMathFont } from './pdf-math-fonts';
import { collectPdfFractions } from './pdf-math-fractions';
import { collectPdfLimitFunctions, isPdfLimitFunctionRun } from './pdf-math-limit-functions';
import { collectPdfMatrices } from './pdf-math-matrices';
import { collectPdfLimitOperators, isPdfLimitOperatorRun } from './pdf-math-operators';
import { convertTextbookMath } from './textbook-math';

export interface PdfMathWarning {
  snippet: string;
  reason: string;
}

export type PositionedMathWarning = PdfMathWarning & { start: number };

export interface PdfMathLine {
  original: string;
  text: string;
  mathWarnings?: PdfMathWarning[];
}

/** A horizontal line in the same PDF coordinates as a text item's transform. */
export interface PdfMathRule {
  x1: number;
  x2: number;
  y: number;
}

export interface TextRun {
  text: string;
  start: number;
  end: number;
  x: number;
  y: number;
  width: number;
  size: number;
  font: string;
  horizontal: boolean;
}

export interface MathSpan {
  start: number;
  end: number;
  latex: string;
}

interface SourceLine {
  start: number;
  end: number;
  warnings: PdfMathWarning[];
}

const simpleIdentifier = /[A-Za-z\p{Script=Greek}\d]+$/u;
const mathCharacters = /^[A-Za-z\p{Script=Greek}\d\s+−\-*/=≠≤≥<>×÷·.,:;!?|∈∉⊆⊂⊇⊃∩∪∞√()[\]{}]+$/u;
const scriptCharacters = /^[A-Za-z\p{Script=Greek}\d+−\-*/=.,'′()]+$/u;
const scriptTerm = /(?:[A-Za-z\p{Script=Greek}]{1,3}|\d+(?:\.\d+)?)[′']?/u.source;
const scriptExpression = new RegExp(`^[+−-]?${scriptTerm}(?:[+−*/=,-]${scriptTerm})*$`, 'u');

function latexForText(value: string): string {
  return Array.from(value.replace(/\.(?:[ \t]*\.){2}/g, '…'), (character) => {
    switch (character) {
      case '{':
      case '}':
        return '\\' + character;
      case '|':
        return '\\mid ';
      case '…':
        return '\\ldots ';
      default: {
        const converted = convertTextbookMath(character);
        if (converted === character) return character;
        const command = converted.slice(1, -1);
        return /\\[a-z]+$/i.test(command) ? command + ' ' : command;
      }
    }
  }).join('');
}

function layoutRuns(items: readonly TextItem[], includeLineBreaks = false): TextRun[] {
  let offset = 0;
  return items.map((item) => {
    const [xScale, skewY, skewX, yScale, x, y] = item.transform;
    const start = offset;
    const end = start + item.str.length;
    offset = end + (includeLineBreaks && item.hasEOL ? 1 : 0);
    return {
      text: item.str,
      start,
      end,
      x,
      y,
      width: item.width,
      size: Math.hypot(skewX, yScale) || item.height,
      font: item.fontName,
      horizontal: item.dir === 'ltr' && xScale > 0 && yScale > 0 && Math.abs(skewY) < xScale * 0.12,
    };
  });
}

function collectFontSpans(
  runs: readonly TextRun[],
  fonts: ReadonlyMap<string, PdfMathFont> | undefined,
  warnings: PdfMathWarning[],
): MathSpan[] {
  const spans: MathSpan[] = [];
  if (!fonts?.size) return spans;
  for (const run of runs) {
    const font = fonts.get(run.font);
    if (!font) continue;
    if (font === 'ambiguous') {
      // A vaguely named script font can also be used for prose.
      const snippet = run.text.trim();
      if (/^[([{]?[A-Za-z0-9]{1,2}[)\]},.;:]?$/.test(snippet)) {
        warnings.push({ snippet, reason: 'Check the math font style against the PDF.' });
      }
      continue;
    }
    // The installed KaTeX fonts supply uppercase letters and blackboard bold lowercase k.
    const supported = font === 'mathbb' ? /^[A-Zk]+$/ : /^[A-Z]+$/;
    for (const match of run.text.matchAll(/[A-Za-z0-9]+/g)) {
      const [letters] = match;
      if (!supported.test(letters)) {
        warnings.push({
          snippet: letters,
          reason: 'Check this math font style. The preview font does not include these characters.',
        });
        continue;
      }
      const start = run.start + match.index;
      spans.push({ start, end: start + letters.length, latex: '\\' + font + '{' + letters + '}' });
    }
  }
  return spans;
}

function scriptOffset(run: TextRun, base: TextRun): number | undefined {
  if (!run.horizontal || !base.horizontal || !base.size || !run.size) return;
  const offset = (run.y - base.y) / base.size;
  if (
    !Number.isFinite(offset) ||
    Math.abs(offset) < 0.1 ||
    offset < -0.55 ||
    offset > 0.85 ||
    run.size > base.size * 1.02
  )
    return;
  return offset;
}

function scriptBaseStart(base: TextRun, proseFonts: ReadonlySet<string>): number | undefined {
  const identifier = simpleIdentifier.exec(base.text);
  if (!identifier) return;
  const { 0: name, index } = identifier;
  if (name.length > 1 && (name.length > 3 || proseFonts.has(base.font)) && !/^\d+$/.test(name)) return;
  return base.start + index;
}

function scriptGroupEnd(runs: readonly TextRun[], start: number): number {
  const first = runs[start];
  let last = start;
  while (last + 1 < runs.length) {
    const previous = runs[last];
    const next = runs[last + 1];
    const gap = next.x - previous.x - previous.width;
    if (
      !scriptCharacters.test(next.text) ||
      Math.abs(next.y - first.y) > first.size * 0.12 ||
      Math.abs(next.size - first.size) > first.size * 0.15 ||
      gap < -first.size * 0.2 ||
      gap > first.size * 0.25
    )
      break;
    last++;
  }
  return last;
}

function scriptLatex(
  original: string,
  start: number,
  end: number,
  rise: number,
  fontSpans: readonly MathSpan[],
): string | undefined {
  const script = original.slice(start, end);
  const body = script.startsWith('(') && script.endsWith(')') ? script.slice(1, -1) : script;
  const approachSign =
    rise > 0 && /^[+−-]$/.test(script) && /[→↗↘⟶]\s*[\p{L}\p{N}∞]+\s*$/u.test(original.slice(0, start));
  if (script.length > 24 || (!scriptExpression.test(body) && !approachSign)) return;
  return `${rise > 0 ? '^' : '_'}{${latexBetween(original, start, end, fontSpans).trimEnd()}}`;
}

function collectScripts(
  runs: readonly TextRun[],
  original: string,
  warnings: PdfMathWarning[],
  fontSpans: readonly MathSpan[],
  extensionFonts: ReadonlyMap<string, PdfMathExtensionFont> | undefined,
): MathSpan[] {
  const spans: MathSpan[] = [];
  const proseFonts = new Set(
    runs.filter((run) => /\p{L}{3,}\s+\p{L}{3,}/u.test(run.text)).map((run) => run.font),
  );
  for (let index = 0; index < runs.length - 1; index++) {
    const base = runs[index];
    const first = runs[index + 1];
    if (
      base.text.includes('√') ||
      first.text.includes('√') ||
      /^[=+−-]+$/.test(base.text.trim()) ||
      /^[.,;:!?](?:\s|$)/.test(first.text.trimStart()) ||
      isPdfLimitOperatorRun(base, extensionFonts) ||
      isPdfLimitOperatorRun(first, extensionFonts) ||
      isPdfMathDelimiterRun(base, extensionFonts) ||
      isPdfMathDelimiterRun(first, extensionFonts) ||
      isPdfLimitFunctionRun(base) ||
      isPdfLimitFunctionRun(first)
    )
      continue;
    const rise = scriptOffset(first, base);
    const gap = (first.x - base.x - base.width) / base.size;
    if (rise === undefined || gap < -0.2 || gap > 0.45) continue;

    let last = scriptGroupEnd(runs, index + 1);
    let script = scriptLatex(original, first.start, runs[last].end, rise, fontSpans);
    const start = scriptBaseStart(base, proseFonts);
    const second = runs[last + 1];
    const secondRise = second && scriptOffset(second, base);
    // A base can have both a lower and upper script at almost the same horizontal position.
    if (secondRise !== undefined && Math.abs(second.x - first.x) < base.size * 0.3) {
      last = scriptGroupEnd(runs, last + 1);
      const secondScript = scriptLatex(original, second.start, runs[last].end, secondRise, fontSpans);
      script =
        script && secondScript && rise * secondRise < 0 && second.size <= base.size * 0.87
          ? script + secondScript
          : undefined;
    }
    const end = runs[last].end;
    if (start !== undefined && first.size <= base.size * 0.87 && gap <= 0.23 && script) {
      spans.push({
        start,
        end,
        latex: latexBetween(original, start, first.start, fontSpans).trimEnd() + script,
      });
    } else {
      warnings.push({
        snippet: original
          .slice(start ?? base.start, end)
          .trim()
          .slice(-100),
        reason: 'Check whether the offset text is a subscript or exponent.',
      });
    }
    index = last;
  }
  return spans;
}

function latexBetween(original: string, start: number, end: number, spans: readonly MathSpan[]): string {
  let latex = '';
  let offset = start;
  for (const span of spans) {
    if (span.start < start || span.end > end) continue;
    latex += latexForText(original.slice(offset, span.start)) + span.latex;
    offset = span.end;
  }
  return latex + latexForText(original.slice(offset, end));
}

function radicalRules(root: TextRun, body: TextRun, rules: readonly PdfMathRule[]): PdfMathRule[] {
  return rules.filter(
    (rule) =>
      Math.abs(rule.x1 - root.x - root.width) <= root.size * 0.24 &&
      Math.abs(rule.x1 - body.x) <= root.size * 0.25 &&
      rule.y - body.y > body.size * 0.38 &&
      rule.y - body.y < body.size * 1.7 &&
      rule.x2 > rule.x1,
  );
}

function characterWidth(character: string, size: number): number {
  if (/\d/.test(character)) return size * 0.5;
  if (/[()\[\]{}.,]/.test(character)) return size * 0.32;
  if (/[+−=]/.test(character)) return size * 0.75;
  if (/\s/.test(character)) return size * 0.3;
  return size * 0.55;
}

/** Stop at a visible formula boundary in a text item which also contains prose. */
function radicalEnd(runs: readonly TextRun[], first: number, rule: PdfMathRule): number | undefined {
  const baseline = runs[first];
  const tolerance = baseline.size * 0.18;
  let end: number | undefined;
  let rightEdge: number | undefined;
  let nesting = 0;
  for (let index = first; index < runs.length; index++) {
    const run = runs[index];
    if (run.x >= rule.x2 - tolerance || !run.horizontal || run.text.includes('√')) break;
    const verticalOffset = run.y - baseline.y;
    if (verticalOffset < -baseline.size * 0.55 || verticalOffset > baseline.size * 0.8) break;
    let prefix = '';
    for (const character of run.text) {
      if (!mathCharacters.test(character)) break;
      if ('([{'.includes(character)) nesting++;
      if (')]}'.includes(character)) {
        if (!nesting) break;
        nesting--;
      }
      prefix += character;
    }
    prefix = prefix.trimEnd();
    if (!prefix || /\p{L}{3,}/u.test(prefix)) return;

    const wholeRun = prefix === run.text.trimEnd();
    const estimatedWidth = Array.from(prefix).reduce(
      (sum, character) => sum + characterWidth(character, run.size),
      0,
    );
    const right = run.x + (wholeRun ? run.width : estimatedWidth);
    if (right > rule.x2 + tolerance) return;
    end = run.start + prefix.length;
    rightEdge = right;
    if (!wholeRun) break;
  }
  return end !== undefined &&
    rightEdge !== undefined &&
    !nesting &&
    Math.abs(rightEdge - rule.x2) <= tolerance
    ? end
    : undefined;
}

function collectRadicals(
  runs: readonly TextRun[],
  original: string,
  rules: readonly PdfMathRule[],
  spans: MathSpan[],
  warnings: PdfMathWarning[],
): void {
  for (let index = 0; index < runs.length; index++) {
    const root = runs[index];
    const symbol = root.text.indexOf('√');
    if (symbol < 0) continue;
    const start = root.start + symbol;
    const first = index + 1;
    const body = runs[first];
    const possibleRules =
      root.text.trim() === '√' && root.horizontal && body?.horizontal ? radicalRules(root, body, rules) : [];
    const end = possibleRules.length === 1 ? radicalEnd(runs, first, possibleRules[0]) : undefined;
    if (end !== undefined && !spans.some((span) => span.start < end && span.end > end)) {
      const inner = latexBetween(original, root.end, end, spans).trim();
      if (inner) {
        for (let spanIndex = spans.length - 1; spanIndex >= 0; spanIndex--) {
          if (spans[spanIndex].start >= start && spans[spanIndex].end <= end) spans.splice(spanIndex, 1);
        }
        spans.push({ start, end, latex: `\\sqrt{${inner}}` });
        continue;
      }
    }
    const snippet = /^√\s*[+−-]?(?:[A-Za-z\p{Script=Greek}]|\d+(?:\.\d+)?)/u.exec(original.slice(start))?.[0];
    warnings.push({ snippet: snippet ?? '√', reason: 'Check where the square root ends.' });
  }
}

function expandMathSpan(original: string, span: MathSpan): { start: number; end: number } {
  let { start, end } = span;
  const tail = /^[A-Za-z\p{Script=Greek}]{1,2}(?!\p{L})/u.exec(original.slice(end));
  if (tail) end += tail[0].length;
  const dots = /^,\s*\.(?:[ \t]*\.){2}/.exec(original.slice(end));
  if (dots) end += dots[0].length;

  const pairs = { '}': '{', ']': '[', ')': '(' };
  const open: { index: number; character: string }[] = [];
  for (let index = 0; index < original.length; index++) {
    const character = original[index];
    if ('{[('.includes(character)) open.push({ index, character });
    else if (character in pairs) {
      const opening = open.pop();
      const adjacent =
        opening?.index === end && /^[A-Za-z\p{Script=Greek}]$/u.test(original.slice(start, end));
      if (
        !opening ||
        opening.character !== pairs[character as keyof typeof pairs] ||
        (!adjacent && opening.index > start) ||
        index < end - 1
      )
        continue;
      const text = original.slice(opening.index, index + 1);
      if (
        !mathCharacters.test(text) ||
        /\p{L}{3,}/u.test(text) ||
        (text.includes('√') && !span.latex.includes('\\sqrt'))
      )
        continue;
      start = Math.min(start, opening.index);
      end = index + 1;
      if (!adjacent && original[start] !== '{') {
        const name = /(?:^|[^\p{L}\d])([A-Za-z\p{Script=Greek}])$/u.exec(original.slice(0, start));
        if (name) start--;
      }
    }
  }
  return { start, end };
}

function collectInlineSpans(
  original: string,
  items: readonly TextItem[],
  rules: readonly PdfMathRule[],
  fonts: ReadonlyMap<string, PdfMathFont> | undefined,
  extensionFonts: ReadonlyMap<string, PdfMathExtensionFont> | undefined,
): { spans: MathSpan[]; warnings: PdfMathWarning[] } {
  const runs = layoutRuns(items).filter((run) => run.text.trim());
  const warnings: PdfMathWarning[] = [];
  const fontSpans = collectFontSpans(runs, fonts, warnings);
  const scripts = collectScripts(runs, original, warnings, fontSpans, extensionFonts);
  const spans = [
    ...scripts,
    ...fontSpans.filter(
      (font) => !scripts.some((script) => font.start < script.end && font.end > script.start),
    ),
  ].sort((left, right) => left.start - right.start);
  collectRadicals(runs, original, rules, spans, warnings);
  spans.sort((left, right) => left.start - right.start);
  return { spans, warnings };
}

function renderLine(original: string, spans: readonly MathSpan[], warnings: PdfMathWarning[]): PdfMathLine {
  const groups: { start: number; end: number }[] = [];
  for (const span of spans) {
    const group = expandMathSpan(original, span);
    const previous = groups.at(-1);
    const gap = previous && original.slice(previous.end, group.start);
    if (previous && (group.start <= previous.end || (gap && /^[\s,]+$/.test(gap) && gap.includes(',')))) {
      previous.start = Math.min(previous.start, group.start);
      previous.end = Math.max(previous.end, group.end);
    } else groups.push(group);
  }
  let text = '';
  let offset = 0;
  for (const group of groups) {
    const latex = latexBetween(original, group.start, group.end, spans);
    if (latex.includes('√')) continue;
    text += original.slice(offset, group.start) + `$${latex.trim()}$`;
    offset = group.end;
  }
  text += original.slice(offset);
  return { original, text, ...(warnings.length ? { mathWarnings: warnings } : {}) };
}

function mergeStructuredSpans(
  original: string,
  inlineSpans: readonly MathSpan[],
  structuredSpans: readonly MathSpan[],
  warnings: PositionedMathWarning[],
): MathSpan[] {
  let merged = [...inlineSpans];
  for (const span of structuredSpans) {
    const crossesAnother = merged.some(
      (existing) =>
        existing.start < span.end &&
        existing.end > span.start &&
        (existing.start < span.start || existing.end > span.end),
    );
    if (crossesAnother) {
      warnings.push({
        start: span.start,
        snippet: original.slice(span.start, span.end).trim().slice(0, 100),
        reason: 'Check the boundaries of these overlapping formulas.',
      });
      continue;
    }
    merged = merged.filter((existing) => existing.end <= span.start || existing.start >= span.end);
    merged.push(span);
  }
  return merged.sort((left, right) => left.start - right.start);
}

function renderPage(
  original: string,
  sourceLines: readonly SourceLine[],
  spans: readonly MathSpan[],
  positionedWarnings: readonly PositionedMathWarning[],
): PdfMathLine[] {
  const lines: PdfMathLine[] = [];
  let spanIndex = 0;
  let warningIndex = 0;
  for (let index = 0; index < sourceLines.length; index++) {
    const { start, warnings } = sourceLines[index];
    let { end } = sourceLines[index];
    const lineWarnings = [...warnings];
    const lineSpans: MathSpan[] = [];
    // A structured formula may span several of PDF.js's extracted text lines.
    while (spanIndex < spans.length && spans[spanIndex].start < end) {
      const span = spans[spanIndex++];
      while (span.end > end && index + 1 < sourceLines.length) {
        const nextLine = sourceLines[++index];
        end = nextLine.end;
        lineWarnings.push(...nextLine.warnings);
      }
      lineSpans.push({ ...span, start: span.start - start, end: span.end - start });
    }
    while (warningIndex < positionedWarnings.length && positionedWarnings[warningIndex].start <= end) {
      const { snippet, reason } = positionedWarnings[warningIndex++];
      lineWarnings.push({ snippet, reason });
    }
    lines.push(renderLine(original.slice(start, end), lineSpans, lineWarnings));
  }
  return lines;
}

export function reconstructPdfMath(
  items: readonly TextItem[],
  rules: readonly PdfMathRule[] = [],
  fonts?: ReadonlyMap<string, PdfMathFont>,
  extensionFonts?: ReadonlyMap<string, PdfMathExtensionFont>,
): PdfMathLine[] {
  const sourceLines: SourceLine[] = [];
  const inlineSpans: MathSpan[] = [];
  let start = 0;
  let line: TextItem[] = [];
  const addLine = () => {
    const original = line.map((item) => item.str).join('');
    const { spans, warnings } = collectInlineSpans(original, line, rules, fonts, extensionFonts);
    const end = start + original.length;
    sourceLines.push({ start, end, warnings });
    for (const span of spans) {
      inlineSpans.push({ ...span, start: span.start + start, end: span.end + start });
    }
    start = end + 1;
    line = [];
  };
  for (const item of items) {
    line.push(item);
    if (item.hasEOL) addLine();
  }
  if (line.length || items.at(-1)?.hasEOL) addLine();

  const original = items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join('');
  const runs = layoutRuns(items, true).filter((run) => run.text.trim());
  const renderInline = (from: number, to: number) =>
    latexBetween(original, from, to, inlineSpans).replace(/\s*\n\s*/g, ' ');
  const operators = collectPdfLimitOperators(runs, original, renderInline, extensionFonts);
  const limitFunctions = collectPdfLimitFunctions(runs, original, renderInline);
  const warnings = [...operators.warnings, ...limitFunctions.warnings];
  const withOperators = mergeStructuredSpans(
    original,
    inlineSpans,
    [...operators.spans, ...limitFunctions.spans],
    warnings,
  );
  const fractions = collectPdfFractions(runs, original, rules, (from, to) =>
    latexBetween(original, from, to, withOperators).replace(/\s*\n\s*/g, ' '),
  );
  warnings.push(...fractions.warnings);
  const withFractions = mergeStructuredSpans(original, withOperators, fractions.spans, warnings);
  const delimiters = collectPdfMathDelimiters(runs, extensionFonts);
  const renderCell = (from: number, to: number) =>
    latexBetween(original, from, to, withFractions).replace(/\s*\n\s*/g, ' ');
  const matrices = collectPdfMatrices(runs, original, renderCell, delimiters);
  const cases = collectPdfCases(runs, original, renderCell, delimiters, withFractions);
  warnings.push(...matrices.warnings, ...cases.warnings);
  const spans = mergeStructuredSpans(original, withFractions, [...matrices.spans, ...cases.spans], warnings);
  return renderPage(
    original,
    sourceLines,
    spans,
    warnings.sort((left, right) => left.start - right.start),
  );
}

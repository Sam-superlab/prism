import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';

export type LiteraturePdfReflowSpan = {
  itemIndex: number;
  paragraph: number;
  from: number;
  to: number;
  sourceFrom: number;
  sourceTo: number;
};

export type LiteraturePdfReflow = { paragraphs: string[]; spans: LiteraturePdfReflowSpan[] };

type MarginSignature = {
  edge: 'top' | 'bottom';
  signature: string;
  pageOffset?: number;
  inset: number;
  bodyGap: number;
  left: number;
  center: number;
  right: number;
  size: number;
};

export type LiteraturePdfRunningMargins = {
  pageNumber: number;
  candidates: readonly MarginSignature[];
};

type RunningMarginOptions = {
  pageNumber: number;
  bounds: readonly number[];
  nearbyMargins: readonly LiteraturePdfRunningMargins[];
};

type Fragment = { itemIndex: number; text: string; sourceFrom: number };
type Position = { x: number; y: number; size: number; width: number };
type Line = {
  fragments: Fragment[];
  start?: Position;
  end?: Position;
  blankBefore: boolean;
  hasUnpositionedText?: boolean;
};

function position(item: TextItem): Position | undefined {
  if (item.dir === 'ttb') return;
  const [a, b, c, d, x, y] = item.transform;
  if (![a, b, c, d, x, y].every(Number.isFinite) || Math.abs(b) > Math.abs(a) * 0.15) return;
  return {
    x,
    y,
    size: Math.max(Math.hypot(c, d), item.height || 0, 1),
    width: Number.isFinite(item.width) ? Math.abs(item.width) : 0,
  };
}

function onDifferentLine(start: Position, previous: Position, current: Position) {
  const shift = Math.abs(current.y - start.y);
  const reset = current.x < previous.x - start.size * 0.25;
  return shift > start.size * (reset ? 0.4 : 0.85);
}

function wordGap(previous: Position, next: Position) {
  return next.x - previous.x - previous.width > Math.max(previous.size, next.size) * 0.19;
}

function readLines(content: Pick<TextContent, 'items'>) {
  const lines: Line[] = [];
  let current: Line = { fragments: [], blankBefore: false };
  let consecutiveBreaks = 0;

  function finish() {
    if (current.fragments.some((part) => part.text.trim())) {
      current.blankBefore = consecutiveBreaks > 1;
      lines.push(current);
      consecutiveBreaks = 0;
    }
    consecutiveBreaks++;
    current = { fragments: [], blankBefore: false };
  }

  content.items.forEach((item, itemIndex) => {
    if (!('str' in item)) return;
    const origin = position(item);
    const last = current.end;
    if (origin && current.start && last && onDifferentLine(current.start, last, origin)) finish();
    const prevText = current.fragments.at(-1)?.text ?? '';
    if (
      item.str &&
      prevText &&
      current.end &&
      origin &&
      wordGap(current.end, origin) &&
      !/\s$/u.test(prevText) &&
      !/^\s/u.test(item.str)
    )
      current.fragments.push({ itemIndex: -1, text: ' ', sourceFrom: 0 });

    for (const match of item.str.matchAll(/[^\r\n]+|\r\n|[\r\n]/g)) {
      const text = match[0];
      if (/^[\r\n]/.test(text)) finish();
      else {
        current.fragments.push({ itemIndex, text, sourceFrom: match.index });
        if (origin && text.trim()) {
          current.start ??= origin;
          current.end = origin;
        } else if (text.trim()) current.hasUnpositionedText = true;
      }
    }
    if (item.hasEOL && !/[\r\n]$/.test(item.str)) finish();
  });
  finish();
  return lines;
}

function paragraphBreak(previous: Line, next: Line) {
  if (next.blankBefore) return true;
  if (!previous.start || !next.start) return false;
  const scale = Math.max(previous.start.size, next.start.size);
  const rise = next.start.y - previous.start.y;
  // Keep the PDF content stream order, including explicit column resets.
  if (rise > scale * 0.45 || -rise > scale * 1.9) return true;
  if (Math.abs(next.start.x - previous.start.x) > scale * 2.3) return true;
  return (
    Math.max(previous.start.size, next.start.size) > Math.min(previous.start.size, next.start.size) * 1.3
  );
}

function lineText(line: Line) {
  return line.fragments.map((fragment) => fragment.text).join('');
}

function runningMarginCandidates(lines: readonly Line[], pageNumber: number, bounds: readonly number[]) {
  const [x0 = NaN, y0 = NaN, x1 = NaN, y1 = NaN] = bounds;
  if (![x0, y0, x1, y1].every(Number.isFinite)) return [];
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return [];

  const positioned = lines.filter(
    (line): line is Line & { start: Position; end: Position } => !!line.start && !!line.end,
  );
  const body = positioned.filter(({ start }) => start.y > y0 + height * 0.09 && start.y < y1 - height * 0.09);
  if (body.length < 3) return [];
  const bodySizes = body.map(({ start }) => start.size).sort((first, second) => first - second);
  const bodySize = bodySizes[Math.floor(bodySizes.length / 2)]!;
  const candidates: { line: Line; signature: MarginSignature }[] = [];

  for (const edge of ['top', 'bottom'] as const) {
    const distance = edge === 'top' ? (y: number) => y1 - y : (y: number) => y - y0;
    const margin = positioned.filter(({ start }) => {
      const inset = distance(start.y);
      return inset >= 0 && inset < height * 0.075;
    });
    // A single isolated line is a safer candidate than adjacent header, title,
    // or footnote material. Leave every line in a multi-line margin alone.
    const [line] = margin;
    if (margin.length !== 1 || !line) continue;
    const { start, end } = line;
    if (
      line.hasUnpositionedText ||
      Math.max(start.size, end.size) > bodySize * 1.08 ||
      Math.abs(start.y - end.y) > bodySize * 0.25
    )
      continue;
    const inset = distance(start.y);
    const nearest = positioned.reduce((gap, other) => {
      const difference = distance(other.start.y) - inset;
      return other === line || difference < 0 ? gap : Math.min(gap, difference);
    }, Infinity);
    if (nearest < bodySize * 2.1) continue;

    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x + start.width, end.x + end.width);
    if (left < x0 || right > x1 || right - left > width * 0.7) continue;
    const text = lineText(line).normalize('NFC').replace(/\s+/gu, ' ').trim();
    if (!text || text.length > 100) continue;
    const counter = /^(?:page\s+)?(\d{1,6})$/iu.exec(text)?.[1];
    // Common mathematical and section headings are meaningful even if a
    // scanned document repeats them at the start of several pages.
    if (
      !counter &&
      (/^(?:chapter|section|part|appendix|definition|theorem|lemma|proposition|corollary|exercise)\b/iu.test(
        text,
      ) ||
        /[=≈≠≤≥∫∑∏√∈∉⇒⇔]/u.test(text))
    )
      continue;
    candidates.push({
      line,
      signature: {
        edge,
        signature: counter ? text.replace(counter, '#').toLowerCase() : text,
        pageOffset: counter ? Number(counter) - pageNumber : undefined,
        inset: inset / height,
        bodyGap: nearest / height,
        left: (left - x0) / width,
        center: ((left + right) / 2 - x0) / width,
        right: (right - x0) / width,
        size: Math.max(start.size, end.size),
      },
    });
  }
  return candidates;
}

export function scanLiteraturePdfRunningMargins(
  content: Pick<TextContent, 'items'>,
  pageNumber: number,
  bounds: readonly number[],
): LiteraturePdfRunningMargins {
  return {
    pageNumber,
    candidates: runningMarginCandidates(readLines(content), pageNumber, bounds).map(
      ({ signature }) => signature,
    ),
  };
}

function matchesRunningMargin(first: MarginSignature, second: MarginSignature) {
  return (
    first.edge === second.edge &&
    first.signature === second.signature &&
    first.pageOffset === second.pageOffset &&
    Math.abs(first.inset - second.inset) <= 0.013 &&
    (first.edge === 'bottom' || Math.abs(first.bodyGap - second.bodyGap) <= 0.025) &&
    Math.max(first.size, second.size) <= Math.min(first.size, second.size) * 1.17 &&
    Math.min(
      Math.abs(first.left - second.left),
      Math.abs(first.center - second.center),
      Math.abs(first.right - second.right),
    ) <= 0.045
  );
}

function repeatedRunningMargins(lines: readonly Line[], options: RunningMarginOptions) {
  const { pageNumber, bounds, nearbyMargins } = options;
  const candidates = runningMarginCandidates(lines, pageNumber, bounds);
  const suppressed = new Set<Line>();
  for (const { line, signature } of candidates) {
    if (pageNumber === 1 && signature.edge === 'top') continue;
    const matches = new Set<number>();
    for (const page of nearbyMargins) {
      const distance = Math.abs(page.pageNumber - pageNumber);
      if (
        distance > 0 &&
        distance <= 4 &&
        page.candidates.some((candidate) => matchesRunningMargin(signature, candidate))
      )
        matches.add(page.pageNumber);
    }
    // Keep the first occurrence of a top line. It can be a section heading
    // that subsequent pages use as their running header.
    if (matches.size >= 2 && (signature.edge === 'bottom' || [...matches].some((page) => page < pageNumber)))
      suppressed.add(line);
  }
  return suppressed;
}

function lineSeparator(previous: Line, next: Line) {
  const before = lineText(previous).trim();
  const after = lineText(next).trim();
  // A hanging layout, list or displayed formula should keep its visible break.
  if (
    /^[\u2022\u25aa\u25e6]\s|\d+[.)]\s/u.test(after) ||
    (previous.start && next.start && Math.abs(next.start.x - previous.start.x) > previous.start.size * 0.8) ||
    (/[=≈≠≤≥∫∑∏√∈∉⇒⇔]/u.test(before) && before.length <= 50) ||
    (/[=≈≠≤≥∫∑∏√∈∉⇒⇔]/u.test(after) && after.length <= 50)
  )
    return '\n';
  // Do not erase a literal hyphen from the source, even across a wrapped word.
  return /\p{L}[-\u2010]$/u.test(before) && /^\p{Ll}/u.test(after) ? '' : ' ';
}

export function reflowLiteraturePdfPageWithMap(
  content: Pick<TextContent, 'items'>,
  options?: RunningMarginOptions,
): LiteraturePdfReflow {
  const paragraphs: string[] = [];
  const spans: LiteraturePdfReflowSpan[] = [];
  let paragraph = '';
  let previous: Line | undefined;

  const lines = readLines(content);
  const suppressed = options && repeatedRunningMargins(lines, options);
  for (const line of lines) {
    if (suppressed?.has(line)) continue;
    const raw = lineText(line);
    const start = raw.length - raw.trimStart().length;
    const end = raw.trimEnd().length;
    if (previous && paragraphBreak(previous, line)) {
      paragraphs.push(paragraph);
      paragraph = '';
    } else if (previous) paragraph += lineSeparator(previous, line);

    let offset = 0;
    for (const part of line.fragments) {
      const next = offset + part.text.length;
      const from = Math.max(start, offset);
      const to = Math.min(end, next);
      if (to > from) {
        const sourceFrom = part.sourceFrom + from - offset;
        if (part.itemIndex >= 0)
          spans.push({
            itemIndex: part.itemIndex,
            paragraph: paragraphs.length,
            from: paragraph.length,
            to: paragraph.length + to - from,
            sourceFrom,
            sourceTo: sourceFrom + to - from,
          });
        paragraph += part.text.slice(from - offset, to - offset);
      }
      offset = next;
    }
    previous = line;
  }
  if (paragraph) paragraphs.push(paragraph);
  return { paragraphs, spans };
}

export function reflowLiteraturePdfPage(
  content: Pick<TextContent, 'items'>,
  options?: RunningMarginOptions,
): string[] {
  return reflowLiteraturePdfPageWithMap(content, options).paragraphs;
}

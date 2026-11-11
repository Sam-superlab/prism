import type { MathSpan, PositionedMathWarning, TextRun } from './pdf-math-layout';

type LimitPosition = 'above' | 'below';
type LimitLayout = 'centered' | 'side';
type OperatorStyle = 'inline' | 'display';
type ExtensionFontIds = Pick<ReadonlySet<string>, 'has'>;

const unicodeOperators = {
  '∑': '\\sum',
  '∏': '\\prod',
  '∫': '\\int',
  '∬': '\\iint',
  '∭': '\\iiint',
  '∮': '\\oint',
  '∯': '\\oiint',
  '∰': '\\oiiint',
} as const;
type OperatorCommand = (typeof unicodeOperators)[keyof typeof unicodeOperators];

interface LimitOperator {
  run: TextRun;
  command: OperatorCommand;
  baseline: number;
  layouts: readonly LimitLayout[];
  extensionStyle?: OperatorStyle;
}

interface OperatorLimit {
  start: number;
  end: number;
  latex: string;
  layouts: LimitLayout[];
}

const unicodeOperatorCharacters = '[' + Object.keys(unicodeOperators).join('') + ']';
const unicodeOperatorPattern = new RegExp(unicodeOperatorCharacters, 'u');
const unicodeOperatorMatches = new RegExp(unicodeOperatorCharacters, 'gu');
const extensionOperatorPattern = /^(?:[PQXYHI]|R(?:\s*R){0,2}|Z(?:\s*Z){0,2}|∫(?:\s*∫){1,2})$/u;
const bothLayouts = ['centered', 'side'] as const;
const placementReviewReason = 'Check whether the limits sit above and below the operator or to its right.';
const integralLimitHeights = {
  inline: {
    above: { sideMax: 0.8, centeredMin: 0.82 },
    below: { sideMax: 0.73, centeredMin: 0.75 },
  },
  display: {
    above: { sideMax: 1.29, centeredMin: 1.33 },
    below: { sideMax: 1.2, centeredMin: 1.23 },
  },
  other: {
    above: { sideMax: 1.48, centeredMin: 0.3 },
    below: { sideMax: 1.32, centeredMin: 0.3 },
  },
};
const limitText = /^[\p{L}\p{Nd}∞\s+=−\-*/<>≤≥≠∈∉⊆⊂⊇⊃∩∪×·±∓.,:|()[\]{}'′…]+$/u;
const incompleteLimit = /[+=−\-*/<>≤≥≠∈∉⊆⊂⊇⊃∩∪×·±∓.,:]$/u;

function isUnicodeOperator(glyph: string): glyph is keyof typeof unicodeOperators {
  return Object.hasOwn(unicodeOperators, glyph);
}

function limitReviewReason(command: OperatorCommand): string {
  if (command === '\\sum') return 'Check which text belongs to the summation limits.';
  if (command === '\\prod') return 'Check which text belongs to the product limits.';
  return 'Check which text belongs to the integral limits.';
}

export function isPdfLimitOperatorRun(run: TextRun, operatorFonts?: ExtensionFontIds): boolean {
  return (
    unicodeOperatorPattern.test(run.text) ||
    (operatorFonts?.has(run.font) === true && extensionOperatorPattern.test(run.text.trim()))
  );
}

function extensionOperator(run: TextRun, glyph: string): LimitOperator | undefined {
  const width = run.width / run.size;
  // Extension font transforms start near the top of the glyph. CMEX aliases
  // reflect font slots, while Latin Modern may map the same slots to Unicode.
  if (glyph === 'P' || glyph === 'X' || glyph === '∑') {
    const inline = glyph === 'P' || (glyph === '∑' && width < 1.24);
    return {
      run,
      command: '\\sum',
      baseline: run.y - run.size * (inline ? 0.75 : 0.95),
      layouts: inline ? ['side'] : ['centered'],
    };
  }
  if (glyph === 'Q' || glyph === 'Y' || glyph === '∏') {
    const inline = glyph === 'Q' || (glyph === '∏' && width < 1.11);
    return {
      run,
      command: '\\prod',
      baseline: run.y - run.size * (inline ? 0.75 : 0.95),
      layouts: bothLayouts,
    };
  }

  const signs = glyph.replace(/\s/g, '');
  if (!/^(?:R{1,3}|Z{1,3}|H|I|∫{1,3}|∮)$/u.test(signs)) return;
  const command =
    signs === 'H' || signs === 'I' || signs === '∮'
      ? '\\oint'
      : signs.length === 3
        ? '\\iiint'
        : signs.length === 2
          ? '\\iint'
          : '\\int';
  const inline =
    signs[0] === 'R' ||
    signs === 'H' ||
    ((signs[0] === '∫' || signs === '∮') && width / signs.length < 0.515);
  return {
    run,
    command,
    baseline: run.y - run.size * (inline ? 0.806 : 1.36),
    layouts: bothLayouts,
    extensionStyle: inline ? 'inline' : 'display',
  };
}

function limitOperator(run: TextRun, operatorFonts: ExtensionFontIds | undefined): LimitOperator | undefined {
  if (
    !run.horizontal ||
    !Number.isFinite(run.size) ||
    run.size <= 0 ||
    !Number.isFinite(run.width) ||
    run.width <= 0
  )
    return;
  const glyph = run.text.trim();
  if (operatorFonts?.has(run.font)) {
    const extension = extensionOperator(run, glyph);
    if (extension) return extension;
  }
  if (isUnicodeOperator(glyph))
    return { run, command: unicodeOperators[glyph], baseline: run.y, layouts: bothLayouts };
}

function nearbyLimit(run: TextRun, operator: LimitOperator): LimitPosition | undefined {
  const { run: symbol, baseline } = operator;
  if (
    !run.horizontal ||
    !Number.isFinite(run.size) ||
    run.size < symbol.size * 0.25 ||
    run.size > symbol.size * 0.92 ||
    run.x + run.width < symbol.x - symbol.size * 2 ||
    run.x > symbol.x + symbol.width + symbol.size * 6
  )
    return;
  const offset = (run.y - baseline) / symbol.size;
  if (offset >= 0.16 && offset <= 2.35) return 'above';
  if (offset <= -0.13 && offset >= -2.35) return 'below';
}

function findLimitRuns(
  runs: readonly TextRun[],
  index: number,
  operator: LimitOperator,
  operatorFonts: ExtensionFontIds | undefined,
): Record<LimitPosition, TextRun[]> {
  const limits: Record<LimitPosition, TextRun[]> = { above: [], below: [] };
  // A run of ordinary text between the operator and a candidate ends its ownership.
  for (const direction of [-1, 1]) {
    for (let next = index + direction; next >= 0 && next < runs.length; next += direction) {
      const run = runs[next];
      if (isPdfLimitOperatorRun(run, operatorFonts)) break;
      const position = nearbyLimit(run, operator);
      if (!position) break;
      limits[position].push(run);
    }
  }
  return limits;
}

function matchingLimitLayouts(
  operator: LimitOperator,
  position: LimitPosition,
  height: number,
  center: number,
  left: number,
): LimitLayout[] {
  const { run: symbol, command, extensionStyle } = operator;
  const integral = command !== '\\sum' && command !== '\\prod';
  const above = position === 'above';
  const centerOffset = (center - symbol.x - symbol.width / 2) / symbol.size;
  const sideOffset = (left - symbol.x - symbol.width) / symbol.size;
  if (!integral) {
    return operator.layouts.filter((layout) =>
      layout === 'centered'
        ? height >= 0.3 && Math.abs(centerOffset) <= 0.4
        : height >= (above ? 0.2 : 0.13) && height <= (above ? 0.94 : 0.78) && Math.abs(sideOffset) <= 0.35,
    );
  }

  // Integral limits follow a slanted glyph. Display integrals reach farther
  // above and below the baseline than the corresponding inline glyphs.
  const { sideMax, centeredMin } = integralLimitHeights[extensionStyle ?? 'other'][position];
  const slant = extensionStyle ? (above ? 0.24 : -0.14) : 0;
  return operator.layouts.filter((layout) =>
    layout === 'centered'
      ? height >= centeredMin && Math.abs(centerOffset - slant) <= 0.4
      : height >= (above ? 0.2 : 0.13) &&
        height <= sideMax &&
        sideOffset >= -0.25 &&
        sideOffset <= (above ? 0.62 : 0.4),
  );
}

function readLimit(
  runs: readonly TextRun[],
  operator: LimitOperator,
  position: LimitPosition,
  original: string,
  render: (start: number, end: number) => string,
): OperatorLimit | undefined {
  if (!runs.length) return;
  const ordered = [...runs].sort((a, b) => a.start - b.start);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first.start < operator.run.end && last.end > operator.run.start) return;
  const baseline = ordered.reduce((largest, run) => (run.size > largest.size ? run : largest), first);
  const raw = original.slice(first.start, last.end).replace(/\s+/g, ' ').trim();
  if (
    raw.length > 72 ||
    !limitText.test(raw) ||
    !/[\p{L}\p{Nd}∞]/u.test(raw) ||
    /\p{L}{3,}|\p{L}\s+\p{L}/u.test(raw) ||
    incompleteLimit.test(raw)
  )
    return;

  let nestedScripts = 0;
  let previousWasScript = false;
  for (const [index, run] of ordered.entries()) {
    const rise = Math.abs(run.y - baseline.y) / baseline.size;
    const script = rise > 0.12;
    if (script && (rise > 0.65 || run.size > baseline.size * 0.84)) return;
    if (script && !previousWasScript) nestedScripts++;
    previousWasScript = script;
    const previous = ordered[index - 1];
    if (!previous) continue;
    const gap = run.x - previous.x - previous.width;
    if (gap < -baseline.size * 0.24 || gap > baseline.size * 0.6) return;
  }

  const height = Math.abs(baseline.y - operator.baseline) / operator.run.size;
  const right = Math.max(...ordered.map((run) => run.x + run.width));
  const center = (first.x + right) / 2;
  const layouts = matchingLimitLayouts(operator, position, height, center, first.x);
  const latex = render(first.start, last.end).replace(/\s+/g, ' ').trim();
  if (!layouts.length || !latex || (latex.match(/[_^]\{/g)?.length ?? 0) < nestedScripts) return;
  return { start: first.start, end: last.end, latex, layouts };
}

export function collectPdfLimitOperators(
  runs: readonly TextRun[],
  original: string,
  render: (start: number, end: number) => string,
  operatorFonts?: ExtensionFontIds,
): { spans: MathSpan[]; warnings: PositionedMathWarning[] } {
  const proposals: { glyph: MathSpan; bounded?: MathSpan; reason: string }[] = [];
  const warnings: PositionedMathWarning[] = [];

  for (const [index, run] of runs.entries()) {
    if (!isPdfLimitOperatorRun(run, operatorFonts)) continue;
    const operator = limitOperator(run, operatorFonts);
    if (!operator) {
      for (const match of run.text.matchAll(unicodeOperatorMatches)) {
        const command = unicodeOperators[match[0] as keyof typeof unicodeOperators];
        const start = run.start + match.index;
        const reason = limitReviewReason(command);
        proposals.push({ glyph: { start, end: start + 1, latex: command + ' ' }, reason });
        warnings.push({ start, snippet: run.text.trim().slice(0, 100), reason });
      }
      continue;
    }

    const { command } = operator;
    const reason = limitReviewReason(command);
    const start = run.start + run.text.search(/\S/);
    const glyph: MathSpan = { start, end: start + run.text.trim().length, latex: command + ' ' };
    const { above, below } = findLimitRuns(runs, index, operator, operatorFonts);
    if (!above.length && !below.length) {
      proposals.push({ glyph, reason });
      continue;
    }

    const upper = readLimit(above, operator, 'above', original, render);
    const lower = readLimit(below, operator, 'below', original, render);
    const layouts = operator.layouts.filter(
      (layout) => (!upper || upper.layouts.includes(layout)) && (!lower || lower.layouts.includes(layout)),
    );
    const layout = layouts.length === 1 || command === '\\sum' ? layouts[0] : undefined;
    const from = Math.min(glyph.start, ...above.map((run) => run.start), ...below.map((run) => run.start));
    const to = Math.max(glyph.end, ...above.map((run) => run.end), ...below.map((run) => run.end));
    // Both limits must be contiguous in the source, including when PDF.js splits them with line breaks.
    const boundsOverlap = upper && lower && upper.start < lower.end && upper.end > lower.start;
    const ownsLimits = !(above.length && !upper) && !(below.length && !lower) && !boundsOverlap;
    if (!ownsLimits || !layout) {
      proposals.push({ glyph, reason });
      warnings.push({
        start: from,
        snippet: original.slice(from, to).trim().slice(0, 100),
        reason: ownsLimits && layouts.length > 1 ? placementReviewReason : reason,
      });
      continue;
    }

    const placement = layout === 'centered' ? '\\limits' : '';
    const latex =
      command + placement + (lower ? '_{' + lower.latex + '}' : '') + (upper ? '^{' + upper.latex + '}' : '');
    proposals.push({ glyph, bounded: { start: from, end: to, latex }, reason });
  }

  const spans = proposals.map(({ glyph, bounded, reason }) => {
    if (!bounded) return glyph;
    if (
      proposals.some(
        (other) =>
          other.glyph !== glyph &&
          (other.bounded ?? other.glyph).start < bounded.end &&
          (other.bounded ?? other.glyph).end > bounded.start,
      )
    ) {
      warnings.push({
        start: bounded.start,
        snippet: original.slice(bounded.start, bounded.end).trim().slice(0, 100),
        reason,
      });
      return glyph;
    }
    return bounded;
  });
  return { spans, warnings };
}

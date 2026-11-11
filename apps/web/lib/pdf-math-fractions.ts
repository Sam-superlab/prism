import type { MathSpan, PdfMathRule, PositionedMathWarning, TextRun } from './pdf-math-layout';

interface FractionSide {
  start: number;
  end: number;
  left: number;
  right: number;
  baseline: number;
  size: number;
  source: string;
  clear: boolean;
}

interface FractionCandidate extends MathSpan {
  source: string;
}

const mathText = /^[\p{L}\p{N}\s+−\-*/=≠≤≥<>×÷·.,:∈∉⊆⊂⊇⊃∩∪∞√∑∏∫∬∭∮∯∰()[\]{}|′']+$/u;

function isShortExpression(source: string): boolean {
  return (
    source.length <= 100 &&
    mathText.test(source) &&
    /[\p{L}\p{N}∞∑∏∫∬∭∮∯∰]/u.test(source) &&
    !/\p{L}{4,}/u.test(source)
  );
}

function isInsideRule(run: TextRun, rule: PdfMathRule): boolean {
  const tolerance = run.size * 0.18;
  return run.x >= rule.x1 - tolerance && run.x + run.width <= rule.x2 + tolerance;
}

function isRadicalBar(rule: PdfMathRule, runs: readonly TextRun[]): boolean {
  return runs.some(
    (run) =>
      run.text.trim() === '√' &&
      Math.abs(run.x + run.width - rule.x1) <= run.size * 0.25 &&
      Math.abs(run.y - rule.y) <= run.size * 0.35,
  );
}

function isBraceBar(rule: PdfMathRule, runs: readonly TextRun[]): boolean {
  // Extensible TeX braces place glyph fragments at the ends of their horizontal rules.
  const fragments = runs.filter(
    (run) =>
      /^(?:[|{}⏞⏟⏜⏝]|[{}]z|z[{}])$/u.test(run.text.trim()) && Math.abs(run.y - rule.y) <= run.size * 0.2,
  );
  return fragments.some(
    (left) =>
      Math.abs(left.x + left.width - rule.x1) <= left.size * 0.12 &&
      fragments.some(
        (right) =>
          right.font === left.font &&
          Math.abs(right.y - left.y) <= left.size * 0.1 &&
          Math.abs(right.x - rule.x2) <= right.size * 0.12 &&
          /[{}⏞⏟⏜⏝]/u.test(left.text + right.text),
      ),
  );
}

function contiguousSource(runs: readonly TextRun[], original: string): boolean {
  return runs.every(
    (run, index) => index === 0 || /^\s*$/.test(original.slice(runs[index - 1].end, run.start)),
  );
}

function nearestSourceGroup(runs: TextRun[], original: string, rule: PdfMathRule): TextRun[] {
  const groups: TextRun[][] = [];
  for (const run of runs) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (group && previous && /^\s*$/.test(original.slice(previous.end, run.start))) group.push(run);
    else groups.push([run]);
  }
  if (groups.length < 2) return runs;
  const ranked = groups
    .map((group) => ({ group, distance: Math.min(...group.map((run) => Math.abs(run.y - rule.y))) }))
    .sort((a, b) => a.distance - b.distance);
  const [nearest, next] = ranked;
  const rowSize = Math.max(nearest.group[0].size, next.group[0].size);
  return next.distance - nearest.distance > rowSize * 0.75 ? nearest.group : runs;
}

function readSide(
  runs: readonly TextRun[],
  original: string,
  rule: PdfMathRule,
  above: boolean,
): FractionSide | undefined {
  const nearby = nearestSourceGroup(
    runs.filter((run) => {
      const offset = (run.y - rule.y) / run.size;
      return (
        isInsideRule(run, rule) &&
        (above ? offset >= 0.07 && offset <= 1.55 : offset <= -0.48 && offset >= -1.75)
      );
    }),
    original,
    rule,
  );
  if (!nearby.length) return;
  const base = nearby.reduce((largest, run) =>
    largest.text.trim() === '√' || (run.text.trim() !== '√' && run.size > largest.size) ? run : largest,
  );
  const start = nearby[0].start;
  const end = nearby[nearby.length - 1].end;
  const source = original.slice(start, end).trim();
  const left = Math.min(...nearby.map((run) => run.x));
  const right = Math.max(...nearby.map((run) => run.x + run.width));
  if (!isShortExpression(source)) return;
  const clear =
    contiguousSource(nearby, original) &&
    nearby.every((run) => {
      const rise = Math.abs(run.y - base.y) / base.size;
      return (
        rise <= 0.2 ||
        (rise <= 0.7 && run.size <= base.size * 0.86) ||
        (rise <= 0.95 && run.text.trim() === '√')
      );
    });
  return { start, end, left, right, baseline: base.y, size: base.size, source, clear };
}

function centered(side: FractionSide, rule: PdfMathRule): boolean {
  const centerOffset = Math.abs(side.left + side.right - rule.x1 - rule.x2) / 2;
  return centerOffset <= Math.max(side.size * 0.24, (rule.x2 - rule.x1) * 0.13);
}

function tightRule(side: FractionSide, rule: PdfMathRule): boolean {
  return rule.x2 - rule.x1 <= (side.right - side.left) * 1.35 + side.size * 0.5;
}

function fractionWarning(start: number, snippet: string): PositionedMathWarning {
  return {
    start,
    snippet,
    reason: 'Check which text belongs above and below the fraction bar.',
  };
}

export function collectPdfFractions(
  runs: readonly TextRun[],
  original: string,
  rules: readonly PdfMathRule[],
  render: (start: number, end: number) => string,
): { spans: MathSpan[]; warnings: PositionedMathWarning[] } {
  const candidates: FractionCandidate[] = [];
  const warnings: PositionedMathWarning[] = [];
  const horizontal = runs.filter((run) => run.horizontal && run.size > 0 && run.width > 0);
  for (const rule of rules) {
    if (isRadicalBar(rule, horizontal) || isBraceBar(rule, horizontal)) continue;
    const top = readSide(horizontal, original, rule, true);
    const bottom = readSide(horizontal, original, rule, false);
    if (!top || !bottom) {
      const side = top ?? bottom;
      // One-sided lines are common in prose. A raised expression and a tight bar are stronger evidence.
      if (
        side &&
        centered(side, rule) &&
        tightRule(side, rule) &&
        Math.abs(side.baseline - rule.y) > side.size * 0.33
      ) {
        warnings.push(fractionWarning(side.start, side.source));
      }
      continue;
    }
    const first = top.start < bottom.start ? top : bottom;
    const last = first === top ? bottom : top;
    const snippet = original.slice(first.start, Math.max(first.end, last.end)).trim().slice(0, 100);
    if (!tightRule(top, rule) && !tightRule(bottom, rule)) continue;
    if (
      !top.clear ||
      !bottom.clear ||
      !centered(top, rule) ||
      !centered(bottom, rule) ||
      first.end > last.start ||
      !/^\s*$/.test(original.slice(first.end, last.start))
    ) {
      warnings.push(fractionWarning(first.start, snippet));
      continue;
    }
    const numerator = render(top.start, top.end)
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    const denominator = render(bottom.start, bottom.end)
      .replace(/\s*\n\s*/g, ' ')
      .trim();
    if (!numerator || !denominator || /[√∑∏∫∬∭∮∯∰]/u.test(numerator + denominator)) {
      warnings.push(fractionWarning(first.start, snippet));
      continue;
    }
    candidates.push({
      start: first.start,
      end: last.end,
      latex: '\\frac{' + numerator + '}{' + denominator + '}',
      source: snippet,
    });
  }
  const spans: MathSpan[] = [];
  for (const candidate of candidates) {
    const conflicting = candidates.some(
      (other) =>
        other !== candidate &&
        other.start < candidate.end &&
        candidate.start < other.end &&
        (candidate.start !== other.start || candidate.end !== other.end || candidate.latex !== other.latex),
    );
    if (conflicting) {
      warnings.push(fractionWarning(candidate.start, candidate.source));
    } else if (!spans.some((span) => span.start === candidate.start && span.end === candidate.end)) {
      spans.push({ start: candidate.start, end: candidate.end, latex: candidate.latex });
    }
  }
  return { spans, warnings };
}

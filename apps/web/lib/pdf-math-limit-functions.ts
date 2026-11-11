import type { MathSpan, PositionedMathWarning, TextRun } from './pdf-math-layout';

type LimitFunction = '\\lim' | '\\limsup' | '\\liminf';

interface LimitFunctionRun {
  first: number;
  last: number;
  start: number;
  end: number;
  left: number;
  right: number;
  y: number;
  size: number;
  command: LimitFunction;
}

interface ApproachCondition {
  start: number;
  end: number;
  latex?: string;
  placement?: 'centered' | 'side';
}

const limitName = /(?<![\p{L}\p{N}_\\])lim(?:\s*(?:sup|inf))?\s*$/u;
const approachStart = /^\s*[\p{L}](?:_?[\p{L}\p{N}]|[′'])*\s*(?:[→⟶↗↘]|->)/u;
const inlineApproach =
  /(?<![\p{L}\p{N}_\\])lim(?:\s*(?:sup|inf))?\s+[\p{L}](?:_?[\p{L}\p{N}]|[′'])*\s*(?:[→⟶↗↘]|->)/u;
const approachArrow = /[→⟶↗↘]|->/u;
const approachTerm = /^[\p{L}\p{N}∞\s+\-−±∓.,()[\]{}|′'⁺⁻_]+$/u;
const reviewReason = 'Check which approach condition belongs to this limit.';

export function isPdfLimitFunctionRun(run: TextRun): boolean {
  return limitName.test(run.text);
}

function hasGeometry(run: TextRun): boolean {
  return (
    run.horizontal &&
    [run.x, run.y, run.size, run.width].every(Number.isFinite) &&
    run.size > 0 &&
    run.width > 0
  );
}

function readFunction(runs: readonly TextRun[], index: number): LimitFunctionRun | undefined {
  const run = runs[index];
  const match = limitName.exec(run.text);
  if (!match || !hasGeometry(run)) return;

  let name = match[0].replace(/\s+/g, '');
  const next = runs[index + 1];
  const gap = next ? next.x - run.x - run.width : Infinity;
  const split =
    name === 'lim' &&
    next &&
    hasGeometry(next) &&
    /^(?:sup|inf)$/.test(next.text.trim()) &&
    Math.abs(next.y - run.y) <= run.size * 0.12 &&
    Math.abs(next.size - run.size) <= run.size * 0.12 &&
    gap >= -run.size * 0.1 &&
    gap <= run.size * 0.6;
  if (split) name += next.text.trim();

  // PDF.js may return the preceding prose in the same run. Its right edge
  // still locates a side limit, while the suffix estimates the operator center.
  const width = run.width * (match[0].length / run.text.length);
  const last = split ? next : run;
  return {
    first: index,
    last: split ? index + 1 : index,
    start: run.start + match.index,
    end: last.end,
    left: run.x + run.width - width,
    right: last.x + last.width,
    y: run.y,
    size: run.size,
    command: name === 'limsup' ? '\\limsup' : name === 'liminf' ? '\\liminf' : '\\lim',
  };
}

function neighboringCondition(
  runs: readonly TextRun[],
  operator: LimitFunctionRun,
  direction: -1 | 1,
): TextRun[] {
  const condition: TextRun[] = [];
  const edge = direction === 1 ? operator.last : operator.first;
  for (let index = edge + direction; index >= 0 && index < runs.length; index += direction) {
    const run = runs[index];
    const drop = (operator.y - run.y) / operator.size;
    const raisedSign = /^[+−-]$/.test(run.text.trim()) && run.size <= operator.size * 0.68;
    if (
      !hasGeometry(run) ||
      run.size < operator.size * 0.24 ||
      run.size > operator.size * 0.94 ||
      drop < (raisedSign ? -0.12 : 0.05) ||
      drop > 1.55 ||
      run.x + run.width < operator.left - operator.size * 3 ||
      run.x > operator.right + operator.size * 5 ||
      isPdfLimitFunctionRun(run)
    )
      break;

    condition.push(run);
  }
  return direction === 1 ? condition : condition.reverse();
}

function isApproachTerm(value: string): boolean {
  return (
    approachTerm.test(value) &&
    /[\p{L}\p{N}∞]/u.test(value) &&
    !/\p{L}{3,}|\p{L}\s+\p{L}/u.test(value) &&
    !/[⁺⁻].*[⁺⁻]/u.test(value) &&
    !/[+,−\-_.]$/.test(value)
  );
}

function readCondition(
  runs: readonly TextRun[],
  operator: LimitFunctionRun,
  original: string,
  render: (start: number, end: number) => string,
): ApproachCondition | undefined {
  const first = runs[0];
  const last = runs.at(-1);
  if (!first || !last) return;
  const result = { start: first.start, end: last.end };
  const raw = original.slice(first.start, last.end).trim();
  if (!approachArrow.test(raw)) return;
  const gap =
    first.start >= operator.end
      ? original.slice(operator.end, first.start)
      : original.slice(last.end, operator.start);
  if (raw.length > 72 || !/^\s*$/.test(gap)) return result;

  const main = runs.reduce((largest, run) => (run.size > largest.size ? run : largest));
  const penultimate = runs.at(-2);
  const sign = last.text.trim();
  const oneSided =
    /^[+−-]$/.test(sign) &&
    penultimate &&
    last.size <= main.size * 0.87 &&
    last.y - penultimate.y >= main.size * 0.12 &&
    last.y - penultimate.y <= main.size * 0.65;
  const terms = (oneSided ? original.slice(first.start, penultimate.end) : raw)
    .trim()
    .split(approachArrow)
    .map((term) => term.trim());
  if (terms.length !== 2 || !terms.every(isApproachTerm) || (oneSided && /[⁺⁻]$/u.test(terms[1])))
    return result;

  let nested = 0;
  let previousWasScript = false;
  for (const [index, run] of runs.entries()) {
    const rise = Math.abs(run.y - main.y) / main.size;
    const script = rise > 0.16;
    if (script && (rise > 0.65 || run.size > main.size * 0.87)) return result;
    if (script && !previousWasScript) nested++;
    previousWasScript = script;
    const previous = runs[index - 1];
    if (previous) {
      const space = run.x - previous.x - previous.width;
      if (space < -main.size * 0.25 || space > main.size * 0.65) return result;
    }
  }

  const drop = (operator.y - main.y) / operator.size;
  const right = Math.max(...runs.map((run) => run.x + run.width));
  const centerOffset = (first.x + right - operator.left - operator.right) / (2 * operator.size);
  const sideOffset = (first.x - operator.right) / operator.size;
  const centered = drop >= 0.37 && Math.abs(centerOffset) <= 0.42;
  const side = drop >= 0.1 && drop <= 0.42 && sideOffset >= -0.2 && sideOffset <= 0.4;
  if (centered === side) return result;

  let latex = render(first.start, last.end).replace(/-\s*>/u, '\\to ').replace(/\s+/g, ' ').trim();
  if (oneSided && !/\^\{[+-]\}$/.test(latex)) {
    const base = render(first.start, penultimate.end).replace(/-\s*>/u, '\\to ').replace(/\s+/g, ' ').trim();
    latex = base + '^{' + (sign === '+' ? '+' : '-') + '}';
  }
  latex = latex.replace(/[⁺⁻]$/u, (suffix) => '^{' + (suffix === '⁺' ? '+' : '-') + '}');
  if ((latex.match(/[_^]\{/g)?.length ?? 0) < nested) return result;
  return { ...result, latex, placement: centered ? 'centered' : 'side' };
}

export function collectPdfLimitFunctions(
  runs: readonly TextRun[],
  original: string,
  render: (start: number, end: number) => string,
): { spans: MathSpan[]; warnings: PositionedMathWarning[] } {
  const proposals: MathSpan[] = [];
  const warnings: PositionedMathWarning[] = [];
  const warn = (start: number, end: number) => {
    warnings.push({ start, snippet: original.slice(start, end).trim().slice(0, 100), reason: reviewReason });
  };

  for (const [index, run] of runs.entries()) {
    const operator = readFunction(runs, index);
    if (!operator) {
      const match = inlineApproach.exec(run.text);
      if (match) warn(run.start + match.index, run.end);
      continue;
    }
    const conditions = ([-1, 1] as const).flatMap((direction) => {
      const adjacent = neighboringCondition(runs, operator, direction);
      const condition = readCondition(adjacent, operator, original, render);
      return condition ? [condition] : [];
    });
    const after = runs[operator.last + 1];
    if (!conditions.length) {
      // Flat extracted text may give the apparent condition the same baseline as the operator.
      if (after && hasGeometry(after) && Math.abs(after.x - operator.right) <= operator.size * 0.7) {
        let end = operator.end;
        for (const part of runs.slice(operator.last + 1, operator.last + 4)) {
          if (Math.abs(part.y - operator.y) > operator.size * 0.15) break;
          end = part.end;
        }
        if (approachStart.test(original.slice(operator.end, end))) warn(operator.start, end);
      }
      continue;
    }
    const start = Math.min(operator.start, ...conditions.map((condition) => condition.start));
    const end = Math.max(operator.end, ...conditions.map((condition) => condition.end));
    const [condition] = conditions;
    if (conditions.length !== 1 || !condition.latex) {
      warn(start, end);
      continue;
    }
    const placement = condition.placement === 'centered' ? '\\limits' : '\\nolimits';
    proposals.push({ start, end, latex: operator.command + placement + '_{' + condition.latex + '}' });
  }

  const spans = proposals.filter((span) => {
    if (!proposals.some((other) => other !== span && span.start < other.end && span.end > other.start))
      return true;
    warn(span.start, span.end);
    return false;
  });
  return { spans, warnings };
}

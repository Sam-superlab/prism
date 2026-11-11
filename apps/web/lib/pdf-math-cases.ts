import type { PdfMathDelimiter } from './pdf-math-delimiters';
import type { MathSpan, PositionedMathWarning, TextRun } from './pdf-math-layout';
import { clusterPdfGridRows, splitPdfGridRow } from './pdf-math-matrices';

interface Cell {
  start: number;
  end: number;
}

interface CaseRow {
  expression: Cell;
  condition: Cell;
  expressionLeft: number;
  expressionRight: number;
  conditionX: number;
}

const caseReviewReason = 'Check which expression and condition belong to each piecewise row.';
const mathText = /^[\p{L}\p{N}\s+−\-*/=≠≤≥<>×÷·.,:;!?，。；：、∈∉⊆⊂⊇⊃∩∪∞√∑∏∫∬∭∮∯∰→⟶↗↘()[\]{}|′'…]+$/u;
const mathRelation = /[=≠≤≥<>∈∉⊆⊂⊇⊃]/u;
const plainCondition = /^[\p{L}\p{N}\s,.;:!?，。；：、'′-]+$/u;
const proseWords =
  /[ \t]*(?:(?<!\p{L})(?:otherwise|if|when|unless|where|for|all|some|and|or|is|not|even|odd|rational|irrational|positive|negative)(?!\p{L})|[\p{Script=Han}，。；：、]+)[ \t]*/giu;

function enclosedByRightBrace(brace: PdfMathDelimiter, delimiters: readonly PdfMathDelimiter[]): boolean {
  const height = brace.top - brace.bottom;
  return delimiters.some((other) => {
    const rightHeight = other.top - other.bottom;
    return (
      other.kind === 'brace' &&
      other.side === 'right' &&
      other.x > brace.x + brace.width &&
      other.start >= brace.end &&
      rightHeight >= height * 0.75 &&
      rightHeight <= height * 1.3 &&
      Math.abs(other.top - brace.top) <= height * 0.25 &&
      Math.abs(other.bottom - brace.bottom) <= height * 0.25
    );
  });
}

function readBody(runs: readonly TextRun[], brace: PdfMathDelimiter): TextRun[] {
  const body: TextRun[] = [];
  const first = runs.findIndex((run) => run.start >= brace.end);
  if (first < 0) return body;

  const left = brace.x + brace.width;
  const size = Math.min(brace.size, runs[first].size);
  const margin = size * 0.25;
  const baselines: number[] = [];
  let columnLeft = runs[first].x;
  let previousBaseline: number | undefined;

  for (let index = first; index < runs.length; index++) {
    const run = runs[index];
    if (
      !run.horizontal ||
      ![run.x, run.y, run.width, run.size].every(Number.isFinite) ||
      run.width <= 0 ||
      run.size < size * 0.45 ||
      run.x < left - margin ||
      run.y < brace.bottom - margin ||
      run.y > brace.top + margin
    )
      break;

    if (run.size >= size * 0.84) {
      if (previousBaseline !== undefined && run.y > previousBaseline + size * 0.4) {
        // Some PDFs emit a whole column at a time. Following prose typically returns to the center.
        const startsNewColumn =
          run.x > columnLeft + size * 0.6 &&
          run.y > (brace.top + brace.bottom) / 2 + size * 0.2 &&
          baselines.some((baseline) => Math.abs(baseline - run.y) <= size * 0.22);
        if (!startsNewColumn) break;
        columnLeft = run.x;
        previousBaseline = undefined;
      }
      if (!baselines.some((baseline) => Math.abs(baseline - run.y) <= size * 0.22)) baselines.push(run.y);
      previousBaseline = Math.min(previousBaseline ?? run.y, run.y);
    }
    body.push(run);
  }
  return body;
}

function sourceCell(runs: readonly TextRun[], original: string): Cell | undefined {
  const ordered = [...runs].sort((left, right) => left.start - right.start);
  const first = ordered[0];
  const last = ordered.at(-1);
  if (!first || !last) return;
  if (ordered.some((run, index) => index > 0 && /\S/.test(original.slice(ordered[index - 1].end, run.start))))
    return;

  const raw = original.slice(first.start, last.end).trim();
  if (!raw || raw.length > 120 || !mathText.test(raw)) return;
  return { start: first.start, end: last.end };
}

function candidateRows(
  row: readonly TextRun[],
  size: number,
  original: string,
  structured: readonly MathSpan[],
): CaseRow[] {
  const baseline = row.reduce((main, run) => (run.size > main.size ? run : main)).y;
  const unresolved = row.some(
    (run) =>
      Math.abs(run.y - baseline) > size * 0.22 &&
      !structured.some((span) => span.start <= run.start && span.end >= run.end),
  );
  if (unresolved) return [];

  const groups = splitPdfGridRow(row, size);
  const options: CaseRow[] = [];
  for (let column = 1; column < groups.length; column++) {
    const expressionRuns = groups.slice(0, column).flat();
    const expression = sourceCell(expressionRuns, original);
    const condition = sourceCell(groups.slice(column).flat(), original);
    if (!expression || !condition || (expression.start < condition.end && condition.start < expression.end))
      continue;
    const text = original.slice(condition.start, condition.end);
    const prose = plainCondition.test(text) && /\p{L}{2,}\s+\p{L}{2,}/u.test(text);
    if (!mathRelation.test(text) && !prose && ![...text.matchAll(proseWords)].length) continue;
    options.push({
      expression,
      condition,
      expressionLeft: expressionRuns[0].x,
      expressionRight: Math.max(...expressionRuns.map((run) => run.x + run.width)),
      conditionX: groups[column][0].x,
    });
  }
  return options;
}

function alignedRows(
  rows: readonly TextRun[][],
  size: number,
  original: string,
  structured: readonly MathSpan[],
): CaseRow[] | undefined {
  if (rows.length < 2) return;

  const options = rows.map((row) => candidateRows(row, size, original, structured));
  const layouts: CaseRow[][] = [];
  for (const first of options[0]) {
    const aligned = options.map((row) =>
      row.filter((option) => Math.abs(option.conditionX - first.conditionX) <= size * 0.36),
    );
    if (aligned.some((row) => row.length !== 1)) continue;
    const rows = aligned.map(([row]) => row);
    const expressionsAlign = [0, 0.5, 1].some((alignment) => {
      const edges = rows.map(
        (row) => row.expressionLeft + (row.expressionRight - row.expressionLeft) * alignment,
      );
      return Math.max(...edges) - Math.min(...edges) <= size * 0.35;
    });
    if (expressionsAlign) layouts.push(rows);
  }
  return layouts.length === 1 ? layouts[0] : undefined;
}

function renderCondition(
  cell: Cell,
  original: string,
  render: (start: number, end: number) => string,
): string {
  const raw = original.slice(cell.start, cell.end);
  if (plainCondition.test(raw)) return '\\text{' + raw.replace(/\s+/g, ' ').trim() + '}';
  let result = '';
  let position = cell.start;
  for (const match of raw.matchAll(proseWords)) {
    const start = cell.start + match.index;
    result += render(position, start).trim();
    result += '\\text{' + match[0] + '}';
    position = start + match[0].length;
  }
  return result + render(position, cell.end).trim();
}

export function collectPdfCases(
  runs: readonly TextRun[],
  original: string,
  render: (start: number, end: number) => string,
  delimiters: readonly PdfMathDelimiter[],
  structured: readonly MathSpan[] = [],
): { spans: MathSpan[]; warnings: PositionedMathWarning[] } {
  const spans: MathSpan[] = [];
  const warnings: PositionedMathWarning[] = [];
  for (const brace of delimiters) {
    if (brace.kind !== 'brace' || brace.side !== 'left' || enclosedByRightBrace(brace, delimiters)) continue;

    const body = readBody(runs, brace);
    if (!body.length) continue;
    const { rows, size, confident } = clusterPdfGridRows(body);
    const left = Math.min(...body.map((run) => run.x));
    if (!size || brace.top - brace.bottom < size * 1.6 || left - brace.x - brace.width > size * 1.8) continue;

    const end = body[body.length - 1].end;
    const beforeBody = original.slice(brace.end, body[0].start);
    const pieces =
      confident && !/\S/.test(beforeBody) ? alignedRows(rows, size, original, structured) : undefined;
    if (pieces) {
      const cells = pieces
        .flatMap(({ expression, condition }) => [expression, condition])
        .sort((left, right) => left.start - right.start);
      const complete = cells.every((cell, index) => {
        const previous = cells[index - 1];
        return (
          !previous || (cell.start >= previous.end && !/\S/.test(original.slice(previous.end, cell.start)))
        );
      });
      if (complete) {
        const latexRows = pieces.map(
          ({ expression, condition }) =>
            render(expression.start, expression.end).trim() +
            ' & ' +
            renderCondition(condition, original, render),
        );
        spans.push({
          start: brace.start,
          end,
          latex: '\\begin{cases}' + latexRows.join(' \\\\ ') + '\\end{cases}',
        });
        continue;
      }
    }

    warnings.push({
      start: brace.start,
      snippet: original.slice(brace.start, end).trim().slice(0, 100),
      reason: caseReviewReason,
    });
  }
  return { spans, warnings };
}

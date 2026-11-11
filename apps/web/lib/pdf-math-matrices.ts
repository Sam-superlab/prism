import type { PdfMathDelimiter } from './pdf-math-delimiters';
import type { MathSpan, PositionedMathWarning, TextRun } from './pdf-math-layout';

interface GridRows {
  rows: TextRun[][];
  size: number;
  confident: boolean;
}

interface MatrixCandidate {
  start: number;
  end: number;
  latex?: string;
}

const environments = {
  paren: 'pmatrix',
  bracket: 'bmatrix',
  brace: 'Bmatrix',
  bar: 'vmatrix',
  'double-bar': 'Vmatrix',
} as const;
const reviewReason = 'Check the matrix rows and columns against the PDF.';

function validRun(run: TextRun): boolean {
  return (
    run.horizontal &&
    run.text.trim().length > 0 &&
    [run.x, run.y, run.size, run.width].every(Number.isFinite) &&
    run.size > 0 &&
    run.width >= 0
  );
}

export function clusterPdfGridRows(runs: readonly TextRun[]): GridRows {
  const usable = runs.filter(validRun);
  if (!usable.length) return { rows: [], size: 0, confident: false };

  const sizes = usable.map((run) => run.size).sort((a, b) => a - b);
  const size = sizes[Math.floor((sizes.length - 1) * 0.7)];
  const fullSize = usable.filter((run) => run.size >= size * 0.85).sort((a, b) => b.y - a.y);
  const rows: { baseline: number; runs: TextRun[] }[] = [];
  for (const run of fullSize) {
    const previous = rows.at(-1);
    if (previous && previous.baseline - run.y <= size * 0.22) {
      previous.runs.push(run);
    } else {
      rows.push({ baseline: run.y, runs: [run] });
    }
  }

  let confident = usable.length === runs.length;
  for (const run of usable) {
    if (run.size >= size * 0.85) continue;
    const nearest = rows
      .map((row) => ({ row, distance: Math.abs(row.baseline - run.y) }))
      .sort((a, b) => a.distance - b.distance);
    const [first, second] = nearest;
    if (first.distance > size * 0.52 || (second && second.distance - first.distance < size * 0.14)) {
      confident = false;
      continue;
    }
    first.row.runs.push(run);
  }
  if (rows.some((row, index) => index > 0 && rows[index - 1].baseline - row.baseline < size * 0.72))
    confident = false;
  return {
    rows: rows.map((row) => row.runs.sort((a, b) => a.x - b.x || a.start - b.start)),
    size,
    confident,
  };
}

export function splitPdfGridRow(row: readonly TextRun[], size: number): TextRun[][] {
  const cells: TextRun[][] = [];
  let right = -Infinity;
  for (const run of row) {
    const previous = cells.at(-1);
    if (previous && run.x - right < size * 0.6) {
      previous.push(run);
    } else {
      cells.push([run]);
    }
    right = Math.max(right, run.x + run.width);
  }
  return cells;
}

function columnsAlign(grid: readonly TextRun[][][], size: number): boolean {
  return grid[0].every((_, column) => {
    const bounds = grid.map((row) => {
      const cell = row[column];
      return [cell[0].x, Math.max(...cell.map((run) => run.x + run.width))];
    });
    return [0, 0.5, 1].some((alignment) => {
      const positions = bounds.map(([left, right]) => left + (right - left) * alignment);
      return Math.max(...positions) - Math.min(...positions) <= size * 0.48;
    });
  });
}

function matchesDelimiter(left: PdfMathDelimiter, right: PdfMathDelimiter): boolean {
  if (left === right || left.kind !== right.kind || right.side === 'left' || right.x <= left.x + left.width)
    return false;
  const overlap = Math.min(left.top, right.top) - Math.max(left.bottom, right.bottom);
  const height = Math.max(left.top - left.bottom, right.top - right.bottom);
  return overlap >= height * 0.7;
}

function renderMatrix(
  original: string,
  runs: readonly TextRun[],
  left: PdfMathDelimiter,
  right: PdfMathDelimiter,
  render: (start: number, end: number) => string,
): MatrixCandidate | undefined {
  const bottom = Math.max(left.bottom, right.bottom);
  const top = Math.min(left.top, right.top);
  const interior = runs.filter(
    (run) =>
      validRun(run) &&
      (run.end <= left.start || run.start >= left.end) &&
      (run.end <= right.start || run.start >= right.end) &&
      run.y >= bottom - run.size * 0.2 &&
      run.y <= top + run.size * 0.2 &&
      run.x >= left.x + left.width - run.size * 0.18 &&
      run.x + run.width <= right.x + run.size * 0.18,
  );
  const { rows, size, confident } = clusterPdfGridRows(interior);
  if (rows.length < 2 && (rows.length === 0 || top - bottom < size * 1.6)) return;

  const start = Math.min(left.start, right.start, ...interior.map((run) => run.start));
  const end = Math.max(left.end, right.end, ...interior.map((run) => run.end));
  const uncertain = { start, end };
  if (!confident || rows.length < 2 || rows.length > 24) return uncertain;

  const included = new Set(interior);
  for (const run of runs) {
    const from = Math.max(start, run.start);
    const to = Math.min(end, run.end);
    if (from >= to || included.has(run) || !original.slice(from, to).trim()) continue;
    if ((from < left.start || to > left.end) && (from < right.start || to > right.end)) return uncertain;
  }

  const grid = rows.map((row) => splitPdfGridRow(row, size));
  const columnCount = grid[0].length;
  if (
    !columnCount ||
    columnCount > 24 ||
    grid.some((row) => row.length !== columnCount) ||
    !columnsAlign(grid, size)
  )
    return uncertain;

  const cellSpans = grid.flatMap((row) =>
    row.map((cell) => ({
      start: Math.min(...cell.map((run) => run.start)),
      end: Math.max(...cell.map((run) => run.end)),
    })),
  );
  const ordered = [...cellSpans].sort((a, b) => a.start - b.start);
  if (ordered.some((cell, index) => index > 0 && cell.start < ordered[index - 1].end)) return uncertain;

  const cells: string[] = [];
  for (const cell of cellSpans) {
    const raw = original.slice(cell.start, cell.end).trim();
    const latex = render(cell.start, cell.end).replace(/\s+/g, ' ').trim();
    // A single PDF item can merge multiple columns without retaining the gap.
    if (
      (/[\p{L}\p{N}]\s+[\p{L}\p{N}]/u.test(raw) && !/\\(?:frac|sqrt)\b|[_^]\{/u.test(latex)) ||
      /\p{L}{4,}/u.test(raw) ||
      /[&$%#]/.test(raw)
    )
      return uncertain;
    if (!latex) return uncertain;
    cells.push(latex);
  }
  const latexRows = grid.map((_, index) =>
    cells.slice(index * columnCount, (index + 1) * columnCount).join(' & '),
  );
  const environment = environments[left.kind];
  return {
    start,
    end,
    latex: '\\begin{' + environment + '} ' + latexRows.join(' \\\\ ') + ' \\end{' + environment + '}',
  };
}

export function collectPdfMatrices(
  runs: readonly TextRun[],
  original: string,
  render: (start: number, end: number) => string,
  delimiters: readonly PdfMathDelimiter[],
): { spans: MathSpan[]; warnings: PositionedMathWarning[] } {
  const proposals: MatrixCandidate[] = [];
  const warnings: PositionedMathWarning[] = [];
  const warn = (start: number, end: number) => {
    warnings.push({ start, snippet: original.slice(start, end).trim().slice(0, 160), reason: reviewReason });
  };

  for (const left of delimiters) {
    if (left.side === 'right') continue;
    const candidates = delimiters
      .filter((right) => matchesDelimiter(left, right))
      .map((right) => renderMatrix(original, runs, left, right, render))
      .filter((candidate) => candidate !== undefined);
    const clear = candidates.filter((candidate) => candidate.latex);
    if (clear.length === 1) {
      proposals.push(clear[0]);
    } else if (candidates.length) {
      const nearest = candidates.reduce((a, b) => (a.end - a.start <= b.end - b.start ? a : b));
      warn(nearest.start, nearest.end);
    }
  }

  const spans: MathSpan[] = [];
  for (const proposal of proposals) {
    if (
      proposals.some(
        (other) => other !== proposal && other.start < proposal.end && other.end > proposal.start,
      )
    ) {
      warn(proposal.start, proposal.end);
    } else if (proposal.latex) {
      spans.push({ ...proposal, latex: proposal.latex });
    }
  }
  return { spans, warnings };
}

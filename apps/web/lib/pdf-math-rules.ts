import type { PDFOperatorList } from 'pdfjs-dist/types/src/display/api';
import type { PdfMathRule } from './pdf-math-layout';

type Matrix = [number, number, number, number, number, number];
type PdfOperators = Pick<
  typeof import('pdfjs-dist').OPS,
  | 'save'
  | 'restore'
  | 'transform'
  | 'paintFormXObjectBegin'
  | 'paintFormXObjectEnd'
  | 'constructPath'
  | 'stroke'
  | 'fill'
  | 'eoFill'
>;

const identity: Matrix = [1, 0, 0, 1, 0, 0];

function compose([a, b, c, d, e, f]: Matrix, [g, h, i, j, k, l]: Matrix): Matrix {
  return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
}

function isMatrix(value: unknown): value is Matrix {
  return Array.isArray(value) && value.length === 6 && value.every(Number.isFinite);
}

function horizontalRule(
  [a, b, c, d, e, f]: Matrix,
  left: number,
  bottom: number,
  right: number,
  top: number,
): PdfMathRule | undefined {
  const x1 = a * left + c * bottom + e;
  const x2 = a * right + c * top + e;
  const y1 = b * left + d * bottom + f;
  const y2 = b * right + d * top + f;
  const width = Math.abs(x2 - x1);
  const rise = Math.abs(y2 - y1);
  if (!Number.isFinite(width) || !Number.isFinite(rise) || width < 2 || rise > Math.min(1.5, width * 0.12))
    return;
  return { x1: Math.min(x1, x2), x2: Math.max(x1, x2), y: (y1 + y2) / 2 };
}

export function readPdfMathRules(list: PDFOperatorList, ops: PdfOperators): PdfMathRule[] {
  const rules: PdfMathRule[] = [];
  const stack: Matrix[] = [];
  let transform = identity;
  for (const [index, operator] of list.fnArray.entries()) {
    const args: unknown = list.argsArray[index];
    if (operator === ops.save || operator === ops.paintFormXObjectBegin) {
      stack.push(transform);
      if (operator === ops.paintFormXObjectBegin && Array.isArray(args) && isMatrix(args[0])) {
        transform = compose(transform, args[0]);
      }
    } else if (operator === ops.restore || operator === ops.paintFormXObjectEnd) {
      transform = stack.pop() ?? identity;
    } else if (operator === ops.transform && isMatrix(args)) {
      transform = compose(transform, args);
    } else if (operator === ops.constructPath && Array.isArray(args)) {
      const [paint, paths, bounds] = args;
      const path: unknown = Array.isArray(paths) ? paths[0] : undefined;
      if (!(path instanceof Float32Array)) continue;
      // PDF.js packs moveTo as 0, lineTo as 1, and closePath as 4 in this path format.
      let rule: PdfMathRule | undefined;
      if (paint === ops.stroke && path.length === 6 && path[0] === 0 && path[3] === 1) {
        rule = horizontalRule(transform, path[1], path[2], path[4], path[5]);
      } else if (
        (paint === ops.fill || paint === ops.eoFill) &&
        bounds instanceof Float32Array &&
        bounds.length === 4 &&
        path.length === 13 &&
        path[0] === 0 &&
        path[3] === 1 &&
        path[6] === 1 &&
        path[9] === 1 &&
        path[12] === 4
      ) {
        const [left, bottom, right, top] = bounds;
        const corners = new Set<number>();
        for (const offset of [1, 4, 7, 10]) {
          const x = path[offset];
          const y = path[offset + 1];
          if ((x === left || x === right) && (y === bottom || y === top)) {
            corners.add((x === right ? 2 : 0) + (y === top ? 1 : 0));
          }
        }
        if (corners.size === 4) rule = horizontalRule(transform, left, bottom, right, top);
      }
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

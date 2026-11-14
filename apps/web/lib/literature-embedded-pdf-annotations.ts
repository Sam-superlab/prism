import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { LiteraturePdfHighlight } from '../components/LiteraturePdfReader';

type Annotation = Omit<LiteraturePdfHighlight, 'color' | 'kind'> & {
  kind: NonNullable<LiteraturePdfHighlight['kind']>;
  color: Color;
  comment: string;
};
type Rect = Annotation['rects'][number];
type Point = NonNullable<Annotation['ink_path']>[number];
type Viewport = ReturnType<PDFPageProxy['getViewport']>;
type EmbeddedMark = {
  id?: string;
  subtype?: string;
  annotationFlags?: number;
  rect?: ArrayLike<number>;
  quadPoints?: ArrayLike<number> | null;
  color?: ArrayLike<number> | null;
  inkLists?: readonly ArrayLike<number>[];
  contentsObj?: { str?: string };
  overlaidText?: string;
  textContent?: string[];
};

export type EmbeddedPdfPreview = {
  candidates: Annotation[];
  skipped: { page: number; reason: string }[];
  limited: boolean;
};

export const pdfAnnotationColors = {
  yellow: '#f6ce45', green: '#70d68b', blue: '#73b9ff', pink: '#ff98ba', purple: '#ba9af5',
} as const;
type Color = keyof typeof pdfAnnotationColors;
const sourceKinds = new Map<string, Annotation['kind']>([
  ['Highlight', 'highlight'], ['Underline', 'underline'], ['Text', 'note'],
  ['FreeText', 'note'], ['Square', 'area'], ['Ink', 'ink'],
]);
const maxPages = 2000;
const maxCandidates = 500;
const maxSkipped = 200;
const maxInkPoints = 512;
const maxStrokePoints = 8192;
const maxRects = 300;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

function nearestColor(color: EmbeddedMark['color']): Color {
  if (!color || color.length !== 3) return 'yellow';
  const channels = Array.from(color);
  if (channels.every((value) => value < 55)) return 'purple';
  let closest: Color = 'yellow';
  let shortest = Infinity;
  for (const [name, hex] of Object.entries(pdfAnnotationColors) as [Color, string][]) {
    const distance = channels.reduce((sum, value, index) => {
      const channel = Number.parseInt(hex.slice(1 + 2 * index, 3 + 2 * index), 16);
      return sum + (value - channel) ** 2;
    }, 0);
    if (distance < shortest) {
      closest = name;
      shortest = distance;
    }
  }
  return closest;
}

function bounds(points: Point[]): Rect | undefined {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = clamp(Math.min(...xs));
  const y = clamp(Math.min(...ys));
  const width = clamp(Math.max(...xs)) - x;
  const height = clamp(Math.max(...ys)) - y;
  if (width > 0 && height > 0) return { x, y, width, height };
}

function project(viewport: Viewport, coordinates: ArrayLike<number>, start: number, end: number): Point[] {
  const points: Point[] = [];
  for (let index = start; index < end; index += 2) {
    const [x, y] = viewport.convertToViewportPoint(coordinates[index], coordinates[index + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    points.push({ x: x / viewport.width, y: y / viewport.height });
  }
  return points;
}

function inkGeometry(viewport: Viewport, coordinates: ArrayLike<number>) {
  if (coordinates.length < 4 || coordinates.length % 2 || coordinates.length > maxStrokePoints * 2) return;
  const all = project(viewport, coordinates, 0, coordinates.length);
  if (!all.length || all.some(({ x, y }) => x < 0 || x > 1 || y < 0 || y > 1)) return;
  const count = Math.min(all.length, maxInkPoints);
  const ink_path = Array.from({ length: count }, (_, index) =>
    all[Math.round(index * (all.length - 1) / (count - 1))]);
  if (!ink_path.some(({ x, y }) => x !== ink_path[0].x || y !== ink_path[0].y)) return;
  const paddingX = 2 / viewport.width;
  const paddingY = 2 / viewport.height;
  const rect = bounds(ink_path.flatMap(({ x, y }) => [
    { x: x - paddingX, y: y - paddingY }, { x: x + paddingX, y: y + paddingY },
  ]));
  if (rect) return { rects: [rect], ink_path };
}

const cleanText = (text?: string) => Array.from((text ?? '').replaceAll('\0', '').trim()).slice(0, 12000).join('');

async function embeddedPdfAnnotationId(pdfId: string, page: number, sourceId: string, stroke: number) {
  const bytes = new TextEncoder().encode(JSON.stringify(['prism-embedded-pdf-v1', pdfId, page, sourceId, stroke]));
  const result = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).subarray(0, 16);
  result[6] = (result[6] & 15) | 64;
  result[8] = (result[8] & 63) | 128;
  const hex = Array.from(result, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function previewEmbeddedPdfAnnotations(
  pdf: PDFDocumentProxy, pdfId: string, signal: AbortSignal, progress: (page: number, total: number) => void,
): Promise<EmbeddedPdfPreview> {
  if (pdf.numPages > maxPages) throw new Error('Annotation scanning supports PDFs with up to 2,000 pages.');
  const preview: EmbeddedPdfPreview = { candidates: [], skipped: [], limited: false };
  const ids = new Set<string>();
  const skip = (page: number, reason: string) => {
    if (preview.skipped.length < maxSkipped) preview.skipped.push({ page, reason });
    else preview.limited = true;
  };
  for (let page = 1; page <= pdf.numPages; page++) {
    signal.throwIfAborted();
    progress(page, pdf.numPages);
    const source = await pdf.getPage(page);
    const viewport = source.getViewport({ scale: 1 });
    const marks = await source.getAnnotations({ intent: 'any' }) as EmbeddedMark[];
    signal.throwIfAborted();
    for (const mark of marks) {
      // Ordinary PDF links, popup wrappers, and widgets are not reading marks.
      if (!mark.subtype || ['Link', 'Popup', 'Widget'].includes(mark.subtype) || ((mark.annotationFlags ?? 0) & 35)) continue;
      const kind = sourceKinds.get(mark.subtype);
      if (!kind || !mark.id) {
        skip(page, `Unsupported PDF mark (${mark.subtype.slice(0, 40)}).`);
        continue;
      }
      const color = nearestColor(mark.color);
      const comment = cleanText(mark.contentsObj?.str || (mark.subtype === 'FreeText' ? mark.textContent?.join('\n') : undefined));
      const text = cleanText(mark.overlaidText);
      const geometry: Pick<Annotation, 'rects' | 'ink_path'>[] = [];
      if (kind === 'ink') {
        const strokes = mark.inkLists ?? [];
        if (strokes.length > 100) {
          skip(page, 'This drawing has too many separate strokes.');
          continue;
        }
        for (const coordinates of strokes) {
          const stroke = inkGeometry(viewport, coordinates);
          if (!stroke) break;
          geometry.push(stroke);
        }
        if (geometry.length !== strokes.length) geometry.length = 0;
      } else if (kind !== 'note' || comment) {
        const quads = kind === 'highlight' || kind === 'underline' ? mark.quadPoints : undefined;
        const rects: Rect[] = [];
        if (quads && quads.length % 8 === 0 && quads.length <= maxRects * 8) {
          for (let index = 0; index < quads.length; index += 8) {
            const rect = bounds(project(viewport, quads, index, index + 8));
            if (rect) rects.push(rect);
          }
        } else if (!quads && mark.rect?.length === 4) {
          const rect = bounds(project(viewport, mark.rect, 0, 4));
          if (rect) rects.push(rect);
        }
        if (rects.length) geometry.push({ rects });
      }
      if (!geometry.length) {
        skip(page, kind === 'note' && !comment ? 'Note has no readable text.' : 'Mark has unsupported or invalid page geometry.');
        continue;
      }
      if (preview.candidates.length + geometry.length > maxCandidates) return { ...preview, limited: true };
      for (const [stroke, shape] of geometry.entries()) {
        const id = await embeddedPdfAnnotationId(pdfId, page, mark.id, stroke);
        if (ids.has(id)) continue;
        ids.add(id);
        preview.candidates.push({ id, page, kind, color, text, comment: stroke === 0 ? comment : '', ...shape });
      }
    }
  }
  return preview;
}

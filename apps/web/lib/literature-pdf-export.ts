import { PDFDocument, PDFHexString, PDFName, type PDFPage } from 'pdf-lib';

type Rect = { x: number; y: number; width: number; height: number };
type Point = readonly [number, number];
type Quad = readonly [Point, Point, Point, Point];

export type LiteraturePdfExportAnnotation = {
  page: number;
  kind: 'highlight' | 'underline' | 'note' | 'area' | 'ink';
  rects: readonly Rect[];
  ink_path?: readonly { x: number; y: number }[] | null;
  color: string;
  comment?: string | null;
  text?: string | null;
};

const annotationList = PDFName.of('Annots');

function colorValues(input: string) {
  const value = input.trim().replace(/^#/, '');
  const color = /^[\da-f]{3}$/i.test(value)
    ? [...value].map((digit) => digit + digit).join('')
    : /^[\da-f]{6}$/i.test(value)
      ? value
      : 'ffda45';
  return [0, 2, 4].map((start) => parseInt(color.slice(start, start + 2), 16) / 255);
}

function corners({ x, y, width, height }: Rect) {
  return [Math.min(x, x + width), Math.min(y, y + height), Math.max(x, x + width), Math.max(y, y + height)];
}

function displayToPdf(page: PDFPage): (x: number, y: number) => Point {
  const media = corners(page.getMediaBox());
  const crop = corners(page.getCropBox());
  const intersection = [
    Math.max(crop[0], media[0]),
    Math.max(crop[1], media[1]),
    Math.min(crop[2], media[2]),
    Math.min(crop[3], media[3]),
  ];
  const [left, bottom, right, top] =
    intersection[0] < intersection[2] && intersection[1] < intersection[3] ? intersection : media;
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const width = right - left;
  const height = top - bottom;
  // Selections use the top-left of PDF.js's rotated, cropped page as their origin.
  switch (rotation) {
    case 90:
      return (x, y) => [left + y * width, bottom + x * height];
    case 180:
      return (x, y) => [right - x * width, bottom + y * height];
    case 270:
      return (x, y) => [right - y * width, top - x * height];
    default:
      return (x, y) => [left + x * width, top - y * height];
  }
}

function quadrilaterals(rects: readonly Rect[], project: (x: number, y: number) => Point): Quad[] {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  return rects.flatMap(({ x, y, width, height }) => {
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
    const left = clamp(x),
      right = clamp(x + width),
      top = clamp(y),
      bottom = clamp(y + height);
    if (right <= left || bottom <= top) return [];
    // Acrobat and other PDF readers use a Z order for text markup quadrilaterals.
    return [[project(left, top), project(right, top), project(left, bottom), project(right, bottom)]];
  });
}

const pdfNumber = (value: number) => Number(value.toFixed(6)).toString();

function annotationAppearance(
  kind: Exclude<LiteraturePdfExportAnnotation['kind'], 'note'>,
  quads: Quad[],
  left: number,
  bottom: number,
  rgb: number[],
  ink?: readonly Point[],
) {
  const local = ([x, y]: Point) => `${pdfNumber(x - left)} ${pdfNumber(y - bottom)}`;
  const color = rgb.map(pdfNumber).join(' ');
  const commands = kind === 'ink' && ink?.length
      ? ['1.8 w 1 J 1 j', `${local(ink[0])} m`, ...ink.slice(1).map((point) => `${local(point)} l`), 'S']
      : kind === 'area'
      ? quads.map(([tl, tr, bl, br]) => `1 w ${local(tl)} m ${local(tr)} l ${local(br)} l ${local(bl)} l h S`)
      : kind === 'highlight'
      ? quads.map(([tl, tr, bl, br]) => `${local(tl)} m ${local(tr)} l ${local(br)} l ${local(bl)} l h f`)
      : quads.map(([tl, tr, bl, br]) => {
          const thickness = Math.max(0.6, Math.min(3, Math.hypot(tl[0] - bl[0], tl[1] - bl[1]) * 0.1));
          const inset = (start: Point, end: Point): Point => [
            start[0] + (end[0] - start[0]) * 0.08,
            start[1] + (end[1] - start[1]) * 0.08,
          ];
          return `${pdfNumber(thickness)} w ${local(inset(bl, tl))} m ${local(inset(br, tr))} l S`;
        });
  return ['q', '/GS gs', `${color} ${kind === 'highlight' ? 'rg' : 'RG'}`, ...commands, 'Q', ''].join('\n');
}

export async function exportAnnotatedLiteraturePdf(
  bytes: ArrayBuffer | Uint8Array,
  annotations: readonly LiteraturePdfExportAnnotation[],
): Promise<Uint8Array> {
  const original = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0));
  if (!annotations.length) return original;
  const pdf = await PDFDocument.load(original, { updateMetadata: false });
  const { context } = pdf;
  const pages = pdf.getPages();

  for (const annotation of annotations) {
    const page = pages[annotation.page - 1];
    if (!page) throw new Error(`An annotation refers to missing page ${annotation.page}.`);
    const project = displayToPdf(page);
    const quads = quadrilaterals(annotation.rects, project);
    if (!quads.length) throw new Error(`An annotation on page ${annotation.page} has no usable area.`);
    const points = quads.flat();
    const xs = points.map(([x]) => x),
      ys = points.map(([, y]) => y);
    const ink = annotation.kind === 'ink' ? annotation.ink_path?.map(({ x, y }) => project(x, y)) : undefined;
    if (annotation.kind === 'ink' && (!ink || ink.length < 2)) throw new Error(`An ink annotation on page ${annotation.page} has no stroke.`);
    const margin = annotation.kind === 'underline' || annotation.kind === 'ink' ? 1.5 : 0;
    const left = Math.min(...xs) - margin,
      bottom = Math.min(...ys) - margin;
    const right = Math.max(...xs) + margin,
      top = Math.max(...ys) + margin;
    const rgb = colorValues(annotation.color);
    const opacity = annotation.kind === 'highlight' ? 0.4 : 1;
    const appearance = annotation.kind === 'note' ? undefined : context.register(
      context.flateStream(annotationAppearance(annotation.kind, quads, left, bottom, rgb, ink), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, right - left, top - bottom],
        Resources: { ExtGState: { GS: { Type: 'ExtGState', CA: opacity, ca: opacity, BM: 'Normal' } } },
      }),
    );
    const note = annotation.comment?.trim() || annotation.text?.trim();
    const ref = context.register(
      context.obj({
        Type: 'Annot',
        Subtype: { highlight: 'Highlight', underline: 'Underline', note: 'Text', area: 'Square', ink: 'Ink' }[annotation.kind],
        P: page.ref,
        Rect: [left, bottom, right, top],
        QuadPoints: annotation.kind === 'highlight' || annotation.kind === 'underline' ? points.flat() : undefined,
        Name: annotation.kind === 'note' ? 'Comment' : undefined,
        InkList: ink ? [ink.flat()] : undefined,
        C: rgb,
        F: 4,
        AP: appearance ? { N: appearance } : undefined,
        Contents: note ? PDFHexString.fromText(note) : undefined,
      }),
    );

    // Append to the original annotation array, including indirect arrays.
    const list = page.node.Annots() ?? context.obj([]);
    if (!page.node.has(annotationList)) page.node.set(annotationList, list);
    list.push(ref);
  }
  return pdf.save({ updateFieldAppearances: false });
}

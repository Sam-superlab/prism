import { expect, test } from 'vitest';
import { exportAnnotatedLiteraturePdf } from '../../apps/web/lib/literature-pdf-export';
import { pdfDocument } from '../e2e/pdf-fixture';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const resolveWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const pdfjs = pathToFileURL(resolveWeb.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;

const original = pdfDocument([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Annots 5 0 R >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /CropBox [20 10 180 90] /Rotate 90 >>',
  '[6 0 R]',
  '<< /Type /Annot /Subtype /Text /Rect [1 1 11 11] /Contents (Existing note) >>',
]);

function renderableRects(data: number[] | Float32Array | null | undefined) {
  return Array.from(data ?? [], (coordinate) => Math.round(coordinate * 100) / 100);
}

test('exports editable highlights and underlines with comments while retaining existing annotations', async () => {
  const input = new Uint8Array(original);
  const result = await exportAnnotatedLiteraturePdf(input, [
    {
      page: 1,
      kind: 'highlight',
      color: '#ffca33',
      rects: [
        { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        { x: 0.1, y: 0.4, width: 0.25, height: 0.1 },
      ],
      text: 'Selected line',
      comment: 'Comment 数学',
    },
    {
      page: 2,
      kind: 'underline',
      color: '#008',
      rects: [{ x: 0.25, y: 0.25, width: 0.5, height: 0.25 }],
      text: 'Rotated line',
    },
    {
      page: 1, kind: 'note', color: '#ffca33', comment: 'Revisit this figure.',
      rects: [{ x: 0.1, y: 0.2, width: 0.1, height: 0.1 }],
    },
    {
      page: 1, kind: 'area', color: '#ba9af5', comment: 'Figure area.',
      rects: [{ x: 0.4, y: 0.3, width: 0.1, height: 0.1 }],
    },
    {
      page: 2, kind: 'ink', color: '#00c', comment: 'Handwritten arrow.',
      rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }],
      ink_path: [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.5 }, { x: 0.5, y: 0.3 }],
    },
  ]);
  expect(input).toEqual(new Uint8Array(original));
  const { getDocument } = await import(pdfjs);
  const originalTask = getDocument({ data: new Uint8Array(original), useWasm: false, useWorkerFetch: false });
  const task = getDocument({ data: result, useWasm: false, useWorkerFetch: false });
  try {
    const [before, pdf] = await Promise.all([originalTask.promise, task.promise]);
    expect(await (await before.getPage(1)).getAnnotations()).toHaveLength(1);

    const page1 = await pdf.getPage(1);
    const [existing, highlight, note, area] = await page1.getAnnotations();
    expect(existing).toMatchObject({ subtype: 'Text', contentsObj: { str: 'Existing note' } });
    expect(highlight).toMatchObject({
      subtype: 'Highlight',
      hasAppearance: true,
      contentsObj: { str: 'Comment 数学' },
    });
    expect(renderableRects(highlight.quadPoints)).toEqual([
      20, 80, 80, 80, 20, 70, 80, 70, 20, 60, 70, 60, 20, 50, 70, 50,
    ]);
    expect(note).toMatchObject({ subtype: 'Text', contentsObj: { str: 'Revisit this figure.' } });
    expect(area).toMatchObject({ subtype: 'Square', hasAppearance: true, contentsObj: { str: 'Figure area.' } });
    const page2 = await pdf.getPage(2);
    const [underline, ink] = await page2.getAnnotations();
    expect(underline).toMatchObject({
      subtype: 'Underline',
      hasAppearance: true,
      contentsObj: { str: 'Rotated line' },
    });
    const [x0, y0, x1, y1] = Array.from(underline.rect as number[]);
    expect(renderableRects([x0, y0, x1, y1])).toEqual([58.5, 28.5, 101.5, 71.5]);
    expect(renderableRects(underline.quadPoints)).toEqual([60, 70, 100, 70, 60, 30, 100, 30]);
    expect(ink).toMatchObject({ subtype: 'Ink', hasAppearance: true, contentsObj: { str: 'Handwritten arrow.' } });
    expect(Array.from(ink.inkLists[0])).toEqual([52, 26, 100, 42, 68, 50]);
  } finally {
    await Promise.all([originalTask.destroy(), task.destroy()]);
  }
});

test('copies untouched files and reports invalid annotation positions without discarding others', async () => {
  const bytes = new Uint8Array(original);
  const copy = await exportAnnotatedLiteraturePdf(bytes, []);
  expect(copy).toEqual(bytes);
  expect(copy).not.toBe(bytes);
  const annotation = {
    page: 99,
    kind: 'highlight' as const,
    color: '#fff',
    rects: [{ x: 0, y: 0, width: 1, height: 1 }],
  };
  await expect(exportAnnotatedLiteraturePdf(bytes, [annotation])).rejects.toThrow(/missing page 99/);
  await expect(exportAnnotatedLiteraturePdf(bytes, [{ ...annotation, page: 1, rects: [] }])).rejects.toThrow(
    /no usable area/,
  );
});

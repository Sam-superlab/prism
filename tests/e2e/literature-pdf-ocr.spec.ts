import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { pdfDocument } from './pdf-fixture';

let script: string;
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ['apps/web/lib/literature-pdf-ocr.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'prismOcr',
  });
  script = bundle.outputFiles[0]!.text;
});

test('only invokes local scan recognition with a native bridge and bounds its page raster', async ({
  page,
}) => {
  await page.addScriptTag({ content: script });
  const result = await page.evaluate(async () => {
    const host = window as Window & {
      webkit?: {
        messageHandlers: { prismPdfOcr: { postMessage: (value: { png: string }) => Promise<string> } };
      };
      prismOcr: typeof import('../../apps/web/lib/literature-pdf-ocr');
    };
    const { canRecognizeLiteraturePdfScans, recognizeLiteraturePdfPage } = host.prismOcr;
    const absent = !canRecognizeLiteraturePdfScans();
    const dimensions: number[][] = [];
    const pngHeaders: number[][] = [];
    const cancelledIds: string[] = [];
    let pendingId: string | undefined;
    let waitForCancel = false;
    const mockPage = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 1000 * scale, height: 4000 * scale }),
      render: ({ canvas, annotationMode }: { canvas: HTMLCanvasElement; annotationMode: number }) => {
        dimensions.push([canvas.width, canvas.height, annotationMode]);
        return { promise: Promise.resolve(), cancel: () => {} };
      },
    } as unknown as Parameters<typeof recognizeLiteraturePdfPage>[0];
    Object.defineProperty(host, 'webkit', {
      configurable: true,
      value: {
        messageHandlers: {
          prismPdfOcr: {
            async postMessage(input: { id: string; png?: string; cancel?: boolean }) {
              if (input.cancel) {
                cancelledIds.push(input.id);
                return true;
              }
              if (waitForCancel) {
                pendingId = input.id;
                return new Promise(() => {});
              }
              pngHeaders.push([...atob(input.png!).slice(0, 8)].map((char) => char.charCodeAt(0)));
              return 'Synthetic scan text';
            },
          },
        },
      },
    });
    const present = canRecognizeLiteraturePdfScans();
    const recognized = await recognizeLiteraturePdfPage(mockPage, new AbortController().signal);
    const controller = new AbortController();
    controller.abort(new Error('Stopped scan'));
    const cancelled = await recognizeLiteraturePdfPage(mockPage, controller.signal).catch(
      (error: Error) => error.message,
    );
    waitForCancel = true;
    const inFlight = new AbortController();
    const pending = recognizeLiteraturePdfPage(mockPage, inFlight.signal).catch((error: Error) => error.message);
    while (!pendingId) await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight.abort(new Error('Cancelled native request'));
    return {
      absent, present, dimensions, pngHeaders, recognized, cancelled,
      inFlight: await pending, cancelDelivered: cancelledIds.length === 1 && cancelledIds[0] === pendingId,
    };
  });
  expect(result).toEqual({
    absent: true,
    present: true,
    dimensions: [[550, 2200, 0], [550, 2200, 0]],
    pngHeaders: [[137, 80, 78, 71, 13, 10, 26, 10]],
    recognized: 'Synthetic scan text',
    cancelled: 'Stopped scan',
    inFlight: 'Cancelled native request',
    cancelDelivered: true,
  });
});

test('reads a scan through the local bridge and indexes its text separately from the PDF', async ({ page, request, baseURL }) => {
  const referenceId = randomUUID();
  const title = 'Synthetic scanned monograph';
  const fileName = 'scan-fixture.pdf';
  const text = 'A deliberately synthetic étale algebra scan';
  await page.addInitScript((result) => {
    Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: { prismPdfOcr: {
      postMessage: async () => result,
    } } } });
  }, text);
  expect((await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': referenceId }, data: { id: referenceId, title },
  })).status()).toBe(201);
  const ink = '0.2 g 40 40 75 75 re f';
  const pdf = pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(ink)} >>\nstream\n${ink}\nendstream`,
  ]);
  await page.goto(`/research/library?reference=${referenceId}`);
  const attachments = page.getByRole('region', { name: 'Attachments' });
  await attachments.getByRole('button', { name: 'Add attachment' }).click();
  await page.getByRole('dialog', { name: 'Add attachment' }).getByLabel('Choose a PDF or EPUB').setInputFiles({ name: fileName, mimeType: 'application/pdf', buffer: pdf });
  await page.getByRole('dialog', { name: 'Add attachment' }).getByRole('button', { name: 'Attach file' }).click();
  await attachments.getByRole('button', { name: fileName, exact: true }).click();
  const reader = page.getByRole('dialog', { name: fileName });
  await reader.getByRole('button', { name: 'Reading mode' }).click();
  const reflow = reader.getByRole('article', { name: 'Reflowed page' });
  await expect(reflow.getByText('No selectable text on this page.', { exact: false })).toBeVisible();
  await reflow.getByRole('button', { name: 'Recognize text on this page' }).click();
  await expect(reflow.getByText(text, { exact: true })).toBeVisible();
  await expect(reflow.getByText('Original page · figures, tables, and formulas')).toBeVisible();
  const search = '/api/v1/research/library/full-text?q=deliberately%20synthetic%20etale';
  expect((await (await request.get(search)).json()).items).toEqual([]);
  await reader.getByRole('button', { name: 'Index scanned pages' }).click();
  await expect(reader.getByRole('button', { name: 'Indexed', exact: true })).toBeDisabled();
  expect((await (await request.get(search)).json()).items).toEqual([
    expect.objectContaining({ reference_id: referenceId, page: 1, format: 'pdf', snippet: text }),
  ]);
});

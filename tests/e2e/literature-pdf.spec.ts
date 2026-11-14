import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { areaPdfFixture, pdfDocument, pdfWithImageAndRepeatedMargins } from './pdf-fixture';

function samplePdf() {
  const pages = [
    'BT /F1 18 Tf 55 720 Td (Synthetic algebra first page) Tj ET',
    'BT /F1 18 Tf 55 720 Td (A unique ideal on page two) Tj ET',
  ];
  return pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(pages[0])} >>\nstream\n${pages[0]}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${Buffer.byteLength(pages[1])} >>\nstream\n${pages[1]}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

test('previews and imports embedded PDF annotations without rewriting the source or resurrecting deletions', async ({
  page, request, baseURL,
}) => {
  const id = randomUUID();
  const title = `Embedded PDF ${id.slice(0, 8)}`;
  expect((await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id }, data: { id, title },
  })).status()).toBe(201);
  const filename = 'embedded-marks.pdf';
  const text = 'BT /F1 18 Tf 55 700 Td (Synthetic marked proof) Tj ET';
  const buffer = pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Rotate 90 /MediaBox [0 0 612 792] /CropBox [20 30 600 770] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R 7 0 R 8 0 R 9 0 R 10 0 R] >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Annot /Subtype /Highlight /Rect [54 698 247 720] /QuadPoints [54 720 247 720 54 698 247 698] /C [1 0.8 0.2] /Contents (Proof comment) >>',
    '<< /Type /Annot /Subtype /Text /Rect [220 620 242 642] /Contents (Inspect this step) >>',
    '<< /Type /Annot /Subtype /Ink /Rect [47 600 109 640] /InkList [[50 605 60 625 75 615] [85 610 100 635]] /C [0.4 0.6 0.95] >>',
    '<< /Type /Annot /Subtype /StrikeOut /Rect [55 660 100 680] /QuadPoints [55 680 100 680 55 660 100 660] >>',
    '<< /Type /Annot /Subtype /Square /Rect [180 500 260 540] /F 2 >>',
  ]);
  await page.goto(`/research/library?reference=${id}`);
  const attachments = page.getByRole('region', { name: 'Attachments' });
  await attachments.getByRole('button', { name: 'Add attachment' }).click();
  await page.getByRole('dialog', { name: 'Add attachment' }).getByLabel('Choose a PDF or EPUB').setInputFiles({ name: filename, mimeType: 'application/pdf', buffer });
  await page.getByRole('dialog', { name: 'Add attachment' }).getByRole('button', { name: 'Attach file' }).click();
  await attachments.getByRole('button', { name: filename, exact: true }).click();
  const reader = page.getByRole('dialog', { name: filename });
  const panel = reader.getByRole('region', { name: 'PDF annotations' });
  const files = await (await request.get(`/api/v1/research/references/${id}/pdfs`)).json();
  const path = `/api/v1/research/reference-pdfs/${files.items[0].id}`;
  await panel.getByRole('button', { name: 'Import marks from this PDF' }).click();
  const preview = panel.getByRole('region', { name: 'Embedded PDF mark preview' });
  await expect(preview.getByRole('button', { name: 'Import 4 selected' })).toBeVisible();
  await expect(preview.getByLabel('Highlight · Synthetic marked proof')).toBeChecked();
  await expect(preview.getByText('1 mark needs manual review')).toBeVisible();
  expect((await (await request.get(`${path}/annotations`)).json()).items).toHaveLength(0);
  await preview.getByLabel('Note · Inspect this step').uncheck();
  await preview.getByLabel('Show original PDF marks').uncheck();
  await preview.getByRole('button', { name: 'Import 3 selected' }).click();
  await expect(preview.getByText('Imported 3.', { exact: true })).toBeVisible();
  const { items } = await (await request.get(`${path}/annotations`)).json();
  expect(items.map((item: { kind: string }) => item.kind).sort()).toEqual(['highlight', 'ink', 'ink']);
  const imported = items.find((item: { kind: string }) => item.kind === 'highlight');
  expect(imported).toMatchObject({ text: 'Synthetic marked proof', comment: 'Proof comment', page: 1 });
  expect(imported.rects[0].x).toBeCloseTo((698 - 30) / 740, 5);
  expect(imported.rects[0].y).toBeCloseTo((54 - 20) / 580, 5);
  expect(items.filter((item: { kind: string }) => item.kind === 'ink').map((item: { ink_path: unknown[] }) => item.ink_path.length).sort()).toEqual([2, 3]);
  expect(await (await request.get(`${path}/download`)).body()).toEqual(buffer);

  const bad = await request.post(`${path}/annotations/import`, {
    headers: { Origin: baseURL!, 'Idempotency-Key': randomUUID() }, data: { annotations: [
      { id: randomUUID(), kind: 'area', page: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }] },
      { id: randomUUID(), kind: 'note', page: 1, rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }] },
    ] },
  });
  expect(bad.status()).toBe(422);
  expect((await (await request.get(`${path}/annotations`)).json()).items).toHaveLength(3);
  const removal = await request.delete(`/api/v1/research/pdf-annotations/${imported.id}`, {
    headers: { Origin: baseURL!, 'Idempotency-Key': randomUUID(), 'If-Match': `"${imported.version}"` },
  });
  expect(removal.status()).toBe(204);
  await reader.getByRole('button', { name: 'Close', exact: true }).click();
  await attachments.getByRole('button', { name: filename, exact: true }).click();
  await panel.getByRole('button', { name: 'Import marks from this PDF' }).click();
  await expect(preview.getByLabel('Show original PDF marks')).not.toBeChecked();
  await expect(preview.getByRole('button', { name: 'Import 2 selected' })).toBeVisible();
  await preview.getByRole('button', { name: 'Import 2 selected' }).click();
  await expect(preview.getByText('Imported 1. Skipped 1 previously handled.')).toBeVisible();
  const after = (await (await request.get(`${path}/annotations`)).json()).items;
  expect(after.map((item: { kind: string }) => item.kind).sort()).toEqual(['ink', 'ink', 'note']);
});

test('attaches, reads, downloads, and removes a local PDF from a library reference', async ({
  page,
  request,
  baseURL,
}) => {
  const id = randomUUID();
  const title = `Synthetic library PDF ${id.slice(0, 8)}`;
  const response = await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id },
    data: { id, title },
  });
  expect(response.status()).toBe(201);
  await page.goto(`/research/library?reference=${id}`);
  const attachments = page.getByRole('region', { name: 'Attachments' });
  const file = samplePdf();
  const filename = 'synthetic-algebra.pdf';
  await attachments.getByRole('button', { name: 'Add attachment' }).click();
  await page.getByRole('dialog', { name: 'Add attachment' }).getByLabel('Choose a PDF or EPUB').setInputFiles({
    name: filename,
    mimeType: 'application/pdf',
    buffer: file,
  });
  await page.getByRole('dialog', { name: 'Add attachment' }).getByRole('button', { name: 'Attach file' }).click();
  await expect(attachments.getByRole('button', { name: filename, exact: true })).toBeVisible();
  await attachments.getByRole('button', { name: filename, exact: true }).click();
  const reader = page.getByRole('dialog', { name: filename });
  const viewer = reader.getByRole('region', { name: 'PDF page viewer' });
  const canvas = viewer.locator('canvas');
  await expect(viewer.getByText('Synthetic algebra first page')).toBeVisible();
  const annotationPanel = reader.getByRole('region', { name: 'PDF annotations' });
  await viewer.getByText('Synthetic algebra first page', { exact: true }).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await reader.getByRole('button', { name: 'Highlight selection' }).click();
  await annotationPanel.getByLabel('Mark').selectOption('underline');
  await annotationPanel.getByLabel('Comment').fill('Check the algebra example again.');
  await annotationPanel.getByRole('button', { name: 'Save annotation' }).click();
  await expect(annotationPanel.getByText('Check the algebra example again.', { exact: true })).toBeVisible();
  await expect(viewer.locator('[data-kind="underline"]').first()).toBeAttached();
  const firstWidth = (await canvas.boundingBox())!.width;
  await reader.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(firstWidth);
  await reader.getByRole('button', { name: 'Next page' }).click();
  await expect(viewer.getByText('A unique ideal on page two')).toBeVisible();
  await reader.getByRole('button', { name: 'Previous page' }).click();
  await expect(viewer.getByText('Synthetic algebra first page')).toBeVisible();
  await reader.getByRole('searchbox', { name: 'Find in PDF' }).fill('unique ideal');
  await reader.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(reader.getByText('1 matching page', { exact: true })).toBeVisible();
  await reader.getByRole('combobox', { name: 'Matching pages' }).selectOption('2');
  await expect(viewer.getByText('A unique ideal on page two')).toBeVisible();
  await reader.getByRole('button', { name: 'Close', exact: true }).click();
  await attachments.getByRole('button', { name: filename, exact: true }).click();
  await expect(viewer.getByText('A unique ideal on page two')).toBeVisible();
  await annotationPanel.getByRole('button', { name: 'Page 1', exact: true }).click();
  await expect(viewer.locator('[data-kind="underline"]').first()).toBeAttached();
  await annotationPanel.getByRole('button', { name: 'Edit', exact: true }).click();
  await annotationPanel.getByLabel('Color').selectOption('purple');
  await annotationPanel.getByRole('button', { name: 'Save annotation' }).click();
  await expect(viewer.locator('[data-kind="underline"]').first()).toHaveAttribute('style', /#ba9af5/);
  await annotationPanel.getByRole('button', { name: 'Create note from annotations' }).click();
  await annotationPanel.getByLabel('Note template').selectOption('by-color');
  await annotationPanel.getByRole('button', { name: 'Save knowledge note' }).click();
  const noteHref = await annotationPanel.getByRole('link', { name: 'Open saved note' }).getAttribute('href');
  const note = await request.get(`/api/v1/knowledge-items/${noteHref!.split('/').at(-1)}`);
  const saved = await note.json();
  expect(saved.content).toContain('Check the algebra example again.');
  expect(saved.content).toContain('### Purple');
  expect(saved.content).toMatch(/page=1&annotation=[a-f\d-]{36}/);
  expect(saved.source_reference).toMatch(/reference=.*&pdf=.*&page=1$/);

  const markedDownload = page.waitForEvent('download');
  await annotationPanel.getByRole('button', { name: 'Export annotated PDF' }).click();
  const marked = await markedDownload;
  expect(marked.suggestedFilename()).toBe('synthetic-algebra-annotated.pdf');
  expect(await readFile((await marked.path())!)).not.toEqual(file);
  await annotationPanel.getByRole('button', { name: 'Index PDF text' }).click();
  await expect(annotationPanel.getByRole('button', { name: 'Indexed', exact: true })).toBeVisible();
  await reader.getByRole('button', { name: 'Close', exact: true }).click();

  await attachments.getByRole('button', { name: `Rename ${filename}` }).click();
  const newFilename = 'renamed-algebra.pdf';
  await attachments.getByLabel('Attachment filename').fill('renamed-algebra');
  await attachments.getByRole('button', { name: 'Save name' }).click();
  await expect(attachments.getByRole('button', { name: newFilename, exact: true })).toBeVisible();

  const archiveReady = page.waitForEvent('download');
  await attachments.getByRole('button', { name: 'Download attachments ZIP' }).click();
  const archive = await archiveReady;
  expect(archive.suggestedFilename()).toBe('prism-attachments.zip');
  expect((await readFile((await archive.path())!)).subarray(0, 4)).toEqual(Buffer.from([80, 75, 3, 4]));
  const downloaded = page.waitForEvent('download');
  await attachments.getByRole('link', { name: 'Download', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(newFilename);
  expect(await readFile((await download.path())!)).toEqual(file);
  await page.getByRole('button', { name: 'Close reference details' }).click();
  await page.getByRole('button', { name: 'Search attachment text', exact: true }).click();
  const fullText = page.getByRole('dialog', { name: 'Search attachment text and annotations' });
  const query = fullText.getByRole('searchbox', { name: 'Search attachment text' });
  await query.fill('example again');
  await fullText.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(fullText.getByText(/Check the algebra example again\./)).toBeVisible();
  const annotationLink = fullText.getByRole('link', { name: `${title} · Page 1` });
  await expect(annotationLink).toHaveAttribute('href', /annotation=[a-f\d-]{36}/);
  await query.fill('unique ideal');
  await fullText.getByRole('button', { name: 'Search', exact: true }).click();
  await fullText.getByRole('link', { name: `${title} · Page 2` }).click();
  const renamedReader = page.getByRole('dialog', { name: newFilename });
  await expect(renamedReader.getByText('A unique ideal on page two')).toBeVisible();
  await renamedReader.getByRole('button', { name: 'Close', exact: true }).click();
  await attachments.getByRole('button', { name: `Remove ${newFilename}` }).click();
  await page.getByRole('dialog', { name: 'Remove PDF' }).getByRole('button', { name: 'Remove PDF' }).click();
  await expect(attachments.getByText('No attachments.')).toBeVisible();
});

test('imports a PDF as a new reference using its local metadata', async ({ page, request }) => {
  let lookups = 0;
  await page.route('**/api/v1/research/library/lookup?*', (route) => {
    lookups++;
    expect(new URL(route.request().url()).searchParams.get('value')).toBe('10.1000/prism-fixture');
    return route.fulfill({ json: { reference: { title: 'Crossref fixture result', authors: ['Fixture Author'],
      doi: '10.1000/prism-fixture', year: 2021, publication: { journal: 'Fixture journal' } } } });
  });
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Import PDF', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import PDF as reference' });
  const filename = 'imported-algebra.pdf';
  await dialog.getByLabel('Choose a PDF').setInputFiles({ name: filename, mimeType: 'application/pdf', buffer: samplePdf() });
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('imported-algebra');
  await dialog.getByLabel('DOI', { exact: true }).fill('10.1000/prism-fixture');
  expect(lookups).toBe(0);
  await dialog.getByRole('button', { name: 'Find DOI details' }).click();
  await expect(dialog.getByText('Crossref fixture result · Fixture Author · 2021')).toBeVisible();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('imported-algebra');
  await dialog.getByRole('button', { name: 'Use these details' }).click();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Crossref fixture result');
  await dialog.getByLabel('Title', { exact: true }).fill('Reviewed synthetic algebra');
  await dialog.getByRole('button', { name: 'Save reference and PDF' }).click();
  const detail = page.getByRole('region', { name: 'Reviewed synthetic algebra' });
  await expect(detail).toBeVisible();
  const id = new URL(page.url()).searchParams.get('reference');
  expect(await (await request.get(`/api/v1/research/references/${id}`)).json()).toMatchObject({
    authors: ['Fixture Author'], doi: '10.1000/prism-fixture', publication: { journal: 'Fixture journal' },
  });
  const result = await request.get(`/api/v1/research/references/${id}/pdfs`);
  expect((await result.json()).items).toMatchObject([{ file_name: filename, status: 'ready' }]);
});

test('reflows PDF text, keeps annotations, and resumes on an independent browser', async ({ page, browser, request, baseURL }) => {
  await page.setViewportSize({ width: 1400, height: 930 });
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Import PDF', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import PDF as reference' });
  const filename = `reading-${randomUUID()}.pdf`;
  await dialog.getByLabel('Choose a PDF').setInputFiles({ name: filename, mimeType: 'application/pdf', buffer: samplePdf() });
  await dialog.getByRole('button', { name: 'Save reference and PDF' }).click();
  await expect(page.getByRole('region', { name: 'Attachments' }).getByRole('button', { name: filename, exact: true })).toBeVisible();
  const referenceId = new URL(page.url()).searchParams.get('reference');
  const files = await request.get(`/api/v1/research/references/${referenceId}/pdfs`);
  const { id } = (await files.json()).items[0];
  const position = `/api/v1/research/reference-pdfs/${id}/reading-position`;

  await page.addInitScript(() => {
    const utterance = class extends EventTarget { constructor(public text: string) { super(); } };
    const speech = Object.assign(new EventTarget(), {
      getVoices: () => [
        { name: 'Device English', lang: 'en', localService: true, voiceURI: 'device-en', default: true },
        { name: 'Remote English', lang: 'en', localService: false, voiceURI: 'remote-en' },
      ],
      speak: () => {}, cancel: () => {}, pause: () => {}, resume: () => {},
    });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: speech });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: utterance });
  });
  await page.reload();

  await page.getByRole('button', { name: filename, exact: true }).click();
  const reader = page.getByRole('dialog', { name: filename });
  await reader.getByRole('button', { name: 'Reading mode' }).click();
  const reflow = reader.locator('article[aria-label="Reflowed page"]');
  const paragraph = reflow.getByText('Synthetic algebra first page', { exact: true });
  await expect(paragraph).toBeVisible();
  await reader.getByLabel('Font size').selectOption('24');
  await expect(reflow).toHaveCSS('font-size', '24px');
  const audio = reader.getByRole('region', { name: 'Read aloud' });
  await expect(audio.getByLabel('Voice').locator('option')).toHaveText(['Default device voice', 'Device English (en)']);
  await audio.getByRole('button', { name: 'Read aloud', exact: true }).click();
  await expect(reflow.locator('[data-speaking="true"]')).toContainText('Synthetic algebra first page');
  await audio.getByRole('button', { name: 'Pause reading' }).click();
  await audio.getByRole('button', { name: 'Resume reading' }).click();
  await audio.getByRole('button', { name: 'Stop reading' }).click();
  await paragraph.evaluate((element) => {
    const range = document.createRange();
    const text = element.firstChild!;
    range.setStart(text, 10);
    range.setEnd(text, 17);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await reader.getByRole('button', { name: 'Highlight selection' }).click();
  await reader.getByLabel('Comment').fill('Marked from reading mode');
  await reader.getByRole('button', { name: 'Save annotation' }).click();
  await expect(reflow.locator('[data-kind="highlight"]')).toHaveText('algebra');
  await reader.getByRole('button', { name: 'Original PDF' }).click();
  const viewer = reader.getByRole('region', { name: 'PDF page viewer' });
  await expect(viewer.locator('[data-kind="highlight"]')).toBeVisible();
  await reader.getByRole('button', { name: 'Add page note' }).click();
  await viewer.locator('canvas').click({ position: { x: 120, y: 120 } });
  await reader.getByLabel('Comment').fill('Revisit this area of the page');
  await reader.getByRole('button', { name: 'Save annotation' }).click();
  const pin = viewer.getByRole('button', { name: 'Open page note' });
  await pin.click();
  await expect(reader.getByLabel('Comment')).toHaveValue('Revisit this area of the page');
  await reader.getByRole('button', { name: 'Cancel', exact: true }).click();
  await reader.getByRole('button', { name: 'Next page' }).click();
  await expect.poll(async () => (await (await request.get(position)).json()).position?.page).toBe(2);

  const second = await browser.newContext({ baseURL, storageState: await page.context().storageState() });
  try {
    await second.addInitScript(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('prism.literature.pdf-page.')) localStorage.removeItem(key);
      }
    });
    const otherPage = await second.newPage();
    await otherPage.goto(`/research/library?reference=${referenceId}&pdf=${id}`);
    const otherReader = otherPage.getByRole('dialog', { name: filename });
    await expect(otherReader.getByText('A unique ideal on page two')).toBeVisible();
    await otherReader.getByRole('button', { name: 'Previous page' }).click();
    await expect.poll(async () => (await (await request.get(position)).json()).position?.page).toBe(1);
    await otherReader.getByRole('button', { name: 'Next page' }).click();
    await expect.poll(async () => (await (await request.get(position)).json()).position?.page).toBe(2);
    await reader.getByRole('button', { name: 'Previous page' }).click();
    await expect(reader.getByText('Another device updated the reading position.')).toBeVisible();
    await reader.getByRole('button', { name: 'Open synced page' }).click();
    await expect(reader.getByText('A unique ideal on page two')).toBeVisible();
  } finally {
    await second.close();
  }
  await reader.getByRole('button', { name: 'Reading mode' }).click();
  await expect(reflow.getByText('A unique ideal on page two')).toBeVisible();
  await reader.getByRole('button', { name: 'Side-by-side' }).click();
  const originalPane = reader.getByRole('region', { name: 'Original PDF page' });
  const readingPane = reader.getByRole('region', { name: 'Reading text' });
  await expect(originalPane.locator('canvas')).toBeVisible();
  await expect(readingPane.getByText('A unique ideal on page two')).toBeVisible();
  expect((await readingPane.boundingBox())!.x).toBeLessThan((await originalPane.boundingBox())!.x);
  await reader.getByRole('button', { name: 'Add page note' }).click();
  await expect(reader.getByRole('button', { name: 'Reading mode' })).toBeVisible();
  await reader.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: filename, exact: true }).click();
  await expect(reflow.getByText('A unique ideal on page two')).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Side-by-side' })).toHaveAttribute('aria-pressed', 'true');
  await expect(originalPane.locator('canvas')).toBeVisible();
  await page.setViewportSize({ width: 850, height: 930 });
  await expect(reader.getByRole('button', { name: 'Side-by-side' })).toHaveCount(0);
  await expect(reflow.getByText('A unique ideal on page two')).toBeVisible();
  await expect(reader.getByRole('region', { name: 'PDF page viewer' }).locator('canvas')).toBeVisible();
  await page.setViewportSize({ width: 1400, height: 930 });
  await expect(reader.getByRole('button', { name: 'Side-by-side' })).toHaveAttribute('aria-pressed', 'true');
});

test('renders thumbnails, omits confirmed running margins, and saves a figure area', async ({ page, request, baseURL }) => {
  const id = randomUUID();
  const title = `PDF geometry ${id.slice(0, 8)}`;
  const response = await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id }, data: { id, title },
  });
  expect(response.status()).toBe(201);
  await page.goto(`/research/library?reference=${id}`);
  const attachments = page.getByRole('region', { name: 'Attachments' });
  const name = 'synthetic-geometry.pdf';
  await attachments.getByRole('button', { name: 'Add attachment' }).click();
  await page.getByRole('dialog', { name: 'Add attachment' }).getByLabel('Choose a PDF or EPUB').setInputFiles({ name, mimeType: 'application/pdf', buffer: pdfWithImageAndRepeatedMargins() });
  await page.getByRole('dialog', { name: 'Add attachment' }).getByRole('button', { name: 'Attach file' }).click();
  await attachments.getByRole('button', { name, exact: true }).click();
  const reader = page.getByRole('dialog', { name });
  await reader.getByRole('button', { name: 'Page thumbnails' }).click();
  const thumbs = reader.getByRole('navigation', { name: 'PDF thumbnails' });
  await expect(thumbs.locator('[data-thumbnail-state="ready"] canvas').first()).toBeVisible();
  await thumbs.getByRole('button', { name: 'Page 2', exact: true }).click();
  await reader.getByRole('button', { name: 'Page thumbnails' }).click();
  await reader.getByRole('button', { name: 'Reading mode' }).click();
  const reflow = reader.locator('article[aria-label="Reflowed page"]');
  await expect(reflow.getByText('Unique proof paragraph on page 2')).toBeVisible();
  await expect(reflow.getByText(areaPdfFixture.header)).toHaveCount(0);
  await expect(reflow.getByText(areaPdfFixture.footer)).toHaveCount(0);
  await reader.getByRole('button', { name: 'Original PDF' }).click();
  await reader.getByRole('button', { name: 'Mark area' }).click();
  const viewer = reader.getByRole('region', { name: 'PDF page viewer' });
  const canvas = viewer.locator('canvas');
  await canvas.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const frame = (await canvas.boundingBox())!;
  const { image, page: paper } = areaPdfFixture;
  const left = frame.x + (image.x / paper.width) * frame.width;
  const top = frame.y + ((paper.height - image.y - image.height) / paper.height) * frame.height;
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(left + (image.width / paper.width) * frame.width, top + (image.height / paper.height) * frame.height, { steps: 6 });
  await page.mouse.up();
  await reader.getByLabel('Comment').fill('A figure to revisit');
  await reader.getByRole('button', { name: 'Save annotation' }).click();
  await viewer.getByRole('button', { name: 'Select marked area' }).click();
  await expect(reader.getByLabel('Comment')).toHaveValue('A figure to revisit');
  const saving = page.waitForEvent('download');
  await reader.getByRole('button', { name: 'Download area image' }).click();
  const download = await saving;
  expect(download.suggestedFilename()).toBe('page-2-area.png');
  const png = await readFile((await download.path())!);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect(png.readUInt32BE(16)).toBeGreaterThan(50);
  const panel = reader.getByRole('region', { name: 'PDF annotations' });
  await panel.getByRole('button', { name: 'Create note from annotations' }).click();
  const previewFigure = panel.getByRole('img', { name: 'PDF figure · Page 2' });
  await expect(previewFigure).toHaveAttribute('data-prism-pdf-figure', 'ready');
  expect(await previewFigure.evaluate((element: HTMLImageElement) => element.decode().then(() => element.naturalWidth))).toBeGreaterThan(100);
  await panel.getByRole('button', { name: 'Save knowledge note' }).click();
  const noteHref = (await panel.getByRole('link', { name: 'Open saved note' }).getAttribute('href'))!;
  const note = await (await request.get(`/api/v1/knowledge-items/${noteHref.split('/').at(-1)}`)).json();
  expect(note.content).toMatch(/!\[PDF figure · Page 2\]\(\/research\/library\?reference=.*&pdf=.*&page=2&annotation=/);
  const knowledge = await page.context().newPage();
  await knowledge.goto(noteHref);
  const savedFigure = knowledge.getByRole('img', { name: 'PDF figure · Page 2' });
  await expect(savedFigure).toHaveAttribute('data-prism-pdf-figure', 'ready');
  const figure = await savedFigure.evaluate(async (element: HTMLImageElement) => {
    await element.decode();
    const crop = document.createElement('canvas');
    crop.width = element.naturalWidth;
    crop.height = element.naturalHeight;
    const context = crop.getContext('2d')!;
    context.drawImage(element, 0, 0);
    return { width: crop.width, height: crop.height,
      pixel: Array.from(context.getImageData(crop.width / 2, crop.height / 2, 1, 1).data) };
  });
  expect(figure.width / figure.height).toBeCloseTo(image.width / image.height, 1);
  expect(figure.pixel.slice(0, 3)).not.toEqual([255, 255, 255]);
  await knowledge.goto(`/knowledge/export?item=${note.id}`);
  await expect(knowledge.getByRole('img', { name: 'PDF figure · Page 2' })).toHaveAttribute('data-prism-pdf-figure', 'ready');
  await knowledge.close();
  await reader.getByRole('button', { name: 'Draw ink', exact: true }).click();
  await canvas.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const drawingFrame = (await canvas.boundingBox())!;
  const inkX = drawingFrame.x + drawingFrame.width * 0.24;
  const inkY = drawingFrame.y + drawingFrame.height * 0.41;
  await page.mouse.move(inkX, inkY);
  await page.mouse.down();
  await page.mouse.move(inkX + 26, inkY + 19, { steps: 4 });
  await page.mouse.move(inkX + 49, inkY - 4, { steps: 4 });
  await page.mouse.up();
  await expect(viewer.locator('[data-ink-stroke="preview"]')).toHaveCount(1);
  await reader.getByLabel('Comment').fill('Check the handwritten mark');
  await reader.getByLabel('Annotation tags').fill('Proof technique; Reread');
  await reader.getByRole('button', { name: 'Save annotation' }).click();
  await expect(viewer.locator('[data-ink-stroke="saved"]')).toHaveCount(1);
  await reader.getByRole('button', { name: 'Close', exact: true }).click();
  await attachments.getByRole('button', { name, exact: true }).click();
  await expect(viewer.locator('[data-ink-stroke="saved"]')).toHaveCount(1);
  await reader.getByLabel('Filter annotations by tag').selectOption('Proof technique');
  await expect(panel.getByText('Check the handwritten mark')).toBeVisible();
  await expect(panel.getByText('A figure to revisit')).toHaveCount(0);
  await reader.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Close reference details' }).click();
  await page.getByRole('button', { name: 'Annotations', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Library annotations' });
  await browser.getByRole('searchbox', { name: 'Search annotations' }).fill('figure to revisit');
  await browser.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(browser.getByText('A figure to revisit', { exact: true })).toBeVisible();
  await browser.getByRole('listitem').filter({ hasText: 'A figure to revisit' })
    .getByLabel('Include annotation', { exact: true }).check();
  await browser.getByLabel('Include quotes', { exact: true }).uncheck();
  await browser.getByLabel('Include comments', { exact: true }).uncheck();
  await browser.getByRole('button', { name: 'Draft knowledge note (1)' }).click();
  await expect(browser.getByRole('img', { name: 'PDF figure · Page 2' })).toHaveAttribute('data-prism-pdf-figure', 'ready');
});

test('stores a separate HTTPS shared workspace address on this device', async ({ page }) => {
  await page.goto('/settings');
  const panel = page.getByRole('region', { name: 'Shared workspace' });
  const address = panel.getByLabel('Shared workspace address');
  await address.fill('https://user:secret@example.test');
  await panel.getByRole('button', { name: 'Save address' }).click();
  await expect(panel.getByText('Enter a valid HTTPS workspace address.')).toBeVisible();
  await address.fill('https://prism.example.test');
  await panel.getByRole('button', { name: 'Save address' }).click();
  const open = panel.getByRole('link', { name: 'Open shared workspace' });
  await expect(open).toHaveAttribute('href', 'https://prism.example.test/');
  await page.reload();
  await expect(open).toHaveAttribute('href', 'https://prism.example.test/');
  await address.fill('');
  await panel.getByRole('button', { name: 'Save address' }).click();
  await expect(open).toHaveCount(0);
});

test('opens separate PDF workspace tabs and restores the selected attachment after reload', async ({ page, request, baseURL }) => {
  const id = randomUUID();
  const title = `PDF tab test ${id.slice(0, 8)}`;
  const created = await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id }, data: { id, title },
  });
  expect(created.status()).toBe(201);
  await page.goto(`/research/library?reference=${id}`);
  const attachments = page.getByRole('region', { name: 'Attachments' });
  for (const [name, buffer] of [['tab-algebra.pdf', samplePdf()], ['tab-geometry.pdf', pdfWithImageAndRepeatedMargins()]] as const) {
    await attachments.getByRole('button', { name: 'Add attachment' }).click();
    await page.getByRole('dialog', { name: 'Add attachment' }).getByLabel('Choose a PDF or EPUB').setInputFiles({ name, mimeType: 'application/pdf', buffer });
    await page.getByRole('dialog', { name: 'Add attachment' }).getByRole('button', { name: 'Attach file' }).click();
    await expect(attachments.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await attachments.getByRole('link', { name: 'Open tab-algebra.pdf in a workspace tab' }).click();
  const tabs = page.getByRole('navigation', { name: 'Workspace tabs' });
  const algebra = tabs.getByRole('button', { name: 'tab-algebra.pdf', exact: true });
  await expect(algebra).toHaveAttribute('aria-current', 'page');
  const first = page.getByRole('dialog', { name: 'tab-algebra.pdf' });
  await expect(first.getByText('Synthetic algebra first page')).toBeVisible();
  await first.getByRole('button', { name: 'Next page' }).click();
  await expect(first.getByText('A unique ideal on page two')).toBeVisible();
  const libraryTab = tabs.getByRole('button', { name: 'Library', exact: true });
  await libraryTab.click();
  await expect(attachments).toBeVisible();
  await attachments.getByRole('link', { name: 'Open tab-geometry.pdf in a workspace tab' }).click();
  const second = page.getByRole('dialog', { name: 'tab-geometry.pdf' });
  await expect(second.getByText('Unique proof paragraph on page 1')).toBeVisible();
  await page.reload();
  await expect(second.getByText('Unique proof paragraph on page 1')).toBeVisible();
  await expect(tabs.getByRole('button', { name: 'tab-geometry.pdf', exact: true })).toHaveAttribute('aria-current', 'page');
  await algebra.click();
  await expect(first.getByText('A unique ideal on page two')).toBeVisible();
});

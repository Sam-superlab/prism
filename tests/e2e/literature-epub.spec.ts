import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { literatureEpubFixture } from './epub-fixture';
import { pdfDocument } from './pdf-fixture';

test('indexes unopened PDF, EPUB, and snapshot attachments through the library search', async ({ page, request, baseURL }) => {
  const reference = randomUUID();
  const title = `Bulk index ${reference.slice(0, 8)}`;
  const headers = () => ({ Origin: baseURL!, 'Idempotency-Key': randomUUID() });
  expect((await request.post('/api/v1/research/references', { headers: headers(), data: { id: reference, title } })).status()).toBe(201);
  const content = 'BT /F1 18 Tf 55 700 Td (Unique bulk indexed PDF theorem) Tj ET';
  const pdf = pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
  const fixtures = [
    { format: 'pdf', file: 'batch.pdf', bytes: pdf, search: 'unique bulk indexed pdf', place: 'Page 1' },
    { format: 'epub', file: 'batch.epub', bytes: literatureEpubFixture(), search: 'quotient rings', place: 'Chapter 2' },
    { format: 'webpage', file: 'batch.txt', bytes: Buffer.from('Snapshot introduction\n\nUnique bulk indexed snapshot'), search: 'unique bulk indexed snapshot', place: 'Paragraph 2' },
  ];
  const ids: string[] = [];
  for (const { file, format, bytes } of fixtures) {
    const id = randomUUID();
    ids.push(id);
    expect((await request.post(`/api/v1/research/references/${reference}/attachments`, { headers: headers(),
      data: { id, format, file_name: file, size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    })).status()).toBe(200);
    expect((await request.put(`/api/v1/research/attachments/${id}/chunk`, { headers: headers(),
      data: { offset: 0, data: bytes.toString('base64') } })).status()).toBe(200);
    expect((await request.post(`/api/v1/research/attachments/${id}/complete`, { headers: headers(), data: {} })).status()).toBe(200);
    expect((await (await request.get(`/api/v1/research/attachments/${id}/text-index`)).json()).status).toBe('missing');
  }
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Search attachment text', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Search attachment text and annotations' });
  await dialog.getByRole('button', { name: 'Index library attachments' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: /Indexed \d+ · Already indexed/ })).toBeVisible();
  for (const id of ids) {
    expect((await (await request.get(`/api/v1/research/attachments/${id}/text-index`)).json()).status).toBe('ready');
  }
  for (const { search, place } of fixtures) {
    await dialog.getByRole('searchbox').fill(search);
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(dialog.getByRole('link', { name: `${title} · ${place}` })).toBeVisible();
  }
});

test('automatically indexes new attachments after opt-in and resumes an interrupted queue', async ({ page, request, baseURL }) => {
  const id = randomUUID();
  const title = `Automatic index ${id.slice(0, 8)}`;
  const user = (await (await request.get('/api/v1/me')).json()).id;
  const settingsKey = `prism.literature-auto-index.v1.${user}`;
  const filename = 'auto-index-fixture.epub';
  expect((await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id }, data: { id, title },
  })).status()).toBe(201);
  await page.goto('/settings');
  const toggle = page.getByRole('switch', { name: /Index new attachments automatically/ });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.goto(`/research/library?reference=${id}`);
  const attachments = page.getByRole('region', { name: 'Attachments' });
  let release: () => void = () => {};
  const interrupted = new Promise<void>((resolve) => { release = resolve; });
  let started: () => void = () => {};
  const startedIndex = new Promise<void>((resolve) => { started = resolve; });
  await page.route('**/api/v1/research/attachments/*/text-index/pages', async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    started();
    await interrupted;
    await route.abort().catch(() => {});
  });
  await attachments.getByRole('button', { name: 'Add attachment' }).click();
  await page.getByRole('dialog', { name: 'Add attachment' }).getByLabel('Choose a PDF or EPUB').setInputFiles({ name: filename, mimeType: 'application/epub+zip', buffer: literatureEpubFixture() });
  await page.getByRole('dialog', { name: 'Add attachment' }).getByRole('button', { name: 'Attach file' }).click();
  await expect(attachments.getByRole('button', { name: filename, exact: true })).toBeVisible();
  const file = (await (await request.get(`/api/v1/research/references/${id}/attachments`)).json()).items[0];
  const statusPath = `/api/v1/research/attachments/${file.id}/text-index`;
  await startedIndex;
  expect((await (await request.get(statusPath)).json())).toMatchObject({ status: 'indexing', next_page: 3, text_mode: 'embedded' });
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).queue.length, settingsKey)).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  release();
  await page.unroute('**/api/v1/research/attachments/*/text-index/pages');
  expect((await (await request.get(statusPath)).json()).status).toBe('indexing');
  await page.goto('/settings');
  await expect(toggle).toBeChecked();
  await expect.poll(async () => (await (await request.get(statusPath)).json()).status).toBe('ready');
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).queue.length, settingsKey)).toBe(0);
  await toggle.uncheck();
  await page.goto(`/research/library?reference=${id}`);
  const second = literatureEpubFixture({ 'OPS/chapter 1.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Another file</p></body></html>' });
  await attachments.getByRole('button', { name: 'Add attachment' }).click();
  await page.getByRole('dialog', { name: 'Add attachment' }).getByLabel('Choose a PDF or EPUB').setInputFiles({ name: 'manual-only.epub', mimeType: 'application/epub+zip', buffer: second });
  await page.getByRole('dialog', { name: 'Add attachment' }).getByRole('button', { name: 'Attach file' }).click();
  await expect(attachments.getByRole('button', { name: 'manual-only.epub', exact: true })).toBeVisible();
  const manual = (await (await request.get(`/api/v1/research/references/${id}/attachments`)).json()).items.find((entry: { file_name: string }) => entry.file_name === 'manual-only.epub');
  expect((await (await request.get(`/api/v1/research/attachments/${manual.id}/text-index`)).json()).status).toBe('missing');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).queue.length, settingsKey)).toBe(0);
});

test('attaches and reads EPUB chapters without fetching resources from the book', async ({ page, request, baseURL }) => {
  const id = randomUUID();
  const title = `Synthetic EPUB ${id.slice(0, 8)}`;
  const response = await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id }, data: { id, title },
  });
  expect(response.status()).toBe(201);
  const external: string[] = [];
  await page.route('https://example.test/**', async (route) => {
    external.push(route.request().url());
    await route.abort();
  });
  await page.goto(`/research/library?reference=${id}`);
  const attachments = page.getByRole('region', { name: 'Attachments' });
  const filename = 'synthetic-ebook.epub';
  const bytes = literatureEpubFixture();
  await attachments.getByRole('button', { name: 'Add attachment' }).click();
  await page.getByRole('dialog', { name: 'Add attachment' }).getByLabel('Choose a PDF or EPUB').setInputFiles({ name: filename, mimeType: 'application/epub+zip', buffer: bytes });
  await page.getByRole('dialog', { name: 'Add attachment' }).getByRole('button', { name: 'Attach file' }).click();
  await attachments.getByRole('button', { name: filename, exact: true }).click();
  const reader = page.getByRole('dialog', { name: filename });
  const chapter = reader.getByRole('region', { name: 'EPUB chapter' });
  await expect(chapter.getByRole('heading', { name: 'Foundations' })).toBeVisible();
  await reader.getByRole('searchbox', { name: 'Find in EPUB' }).fill('quotient rings');
  const savedPosition = page.waitForResponse((response) => response.request().method() === 'PUT' &&
    new URL(response.url()).pathname.endsWith('/reading-position') && response.ok());
  await reader.getByLabel('Matching chapters').selectOption('1');
  await savedPosition;
  await expect(chapter.getByRole('heading', { name: 'Applications' })).toBeVisible();
  await chapter.getByRole('heading', { name: 'Applications' }).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
  });
  await reader.getByRole('button', { name: 'Annotate selection' }).click();
  const notes = reader.getByRole('region', { name: 'Text annotations' });
  await notes.getByLabel('Annotation comment').fill('Review this synthetic EPUB chapter');
  await notes.getByRole('button', { name: 'Save annotation' }).click();
  await expect(chapter.locator('mark')).toHaveText('Applications');
  await expect(notes.getByText('Review this synthetic EPUB chapter')).toBeVisible();
  await notes.getByRole('button', { name: 'Create note from annotations' }).click();
  await expect(notes.getByLabel('Note title')).toHaveValue('synthetic-ebook.epub — Reading notes');
  await notes.getByRole('button', { name: 'Save knowledge note' }).click();
  await expect(notes.getByRole('link', { name: 'Open saved note' })).toBeVisible();
  await reader.getByLabel('Reading theme').selectOption('sepia');
  await expect(chapter).toHaveAttribute('data-reader-theme', 'sepia');
  await reader.getByRole('button', { name: 'Index text' }).click();
  await expect(reader.getByRole('button', { name: 'Indexed', exact: true })).toBeVisible();
  await reader.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('prism.literature.epub-chapter.')) localStorage.removeItem(key);
  });
  await attachments.getByRole('button', { name: filename, exact: true }).click();
  await expect(chapter.getByRole('heading', { name: 'Applications' })).toBeVisible();
  await expect(chapter.locator('mark')).toHaveText('Applications');
  await expect(reader.getByLabel('Reading theme')).toHaveValue('sepia');
  await reader.getByRole('button', { name: 'Close', exact: true }).click();
  expect(external).toEqual([]);

  const downloadReady = page.waitForEvent('download');
  await attachments.getByRole('link', { name: 'Download' }).click();
  expect(await readFile((await (await downloadReady).path())!)).toEqual(bytes);
  await page.getByRole('button', { name: 'Close reference details' }).click();
  await page.getByRole('button', { name: 'Annotations', exact: true }).click();
  const annotationBrowser = page.getByRole('dialog', { name: 'Library annotations' });
  await annotationBrowser.getByRole('searchbox', { name: 'Search annotations' }).fill('review this synthetic epub chapter');
  await annotationBrowser.getByRole('button', { name: 'Filter' }).click();
  await annotationBrowser.getByRole('checkbox', { name: 'Include annotation' }).check();
  await annotationBrowser.getByRole('checkbox', { name: 'Group by color' }).check();
  await annotationBrowser.getByText('Customize color headings', { exact: true }).click();
  await annotationBrowser.getByLabel('Yellow heading').fill('Definitions');
  await annotationBrowser.getByRole('button', { name: 'Draft knowledge note (1)' }).click();
  await annotationBrowser.getByLabel('Note title').fill('Cross-reference reading notes');
  await annotationBrowser.getByRole('button', { name: 'Save knowledge note' }).click();
  const noteLink = annotationBrowser.getByRole('link', { name: 'Open saved note' });
  await expect(noteLink).toBeVisible();
  const noteId = (await noteLink.getAttribute('href'))!.split('/').at(-1);
  const savedNote = await (await request.get(`/api/v1/knowledge-items/${noteId}`)).json();
  expect(savedNote.content).toContain(`## Definitions\n\n### [${title} · Chapter 2]`);
  expect(savedNote.content).toContain('&annotation=');
  await annotationBrowser.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Search attachment text', exact: true }).click();
  const search = page.getByRole('dialog', { name: 'Search attachment text and annotations' });
  await search.getByRole('searchbox').fill('quotient rings');
  await search.getByRole('button', { name: 'Search', exact: true }).click();
  await search.getByRole('link', { name: `${title} · Chapter 2` }).click();
  await expect(chapter.getByRole('heading', { name: 'Applications' })).toBeVisible();
  await reader.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Close reference details' }).click();
  await page.getByRole('button', { name: 'Search attachment text', exact: true }).click();
  await search.getByRole('searchbox').fill('review this synthetic epub chapter');
  await search.getByRole('button', { name: 'Search', exact: true }).click();
  await search.getByRole('link', { name: `${title} · Chapter 2` }).click();
  await expect(chapter.locator('mark[data-active-text-mark="true"]')).toHaveText('Applications');
  await reader.getByRole('button', { name: 'Close', exact: true }).click();
  await attachments.getByRole('button', { name: `Remove ${filename}` }).click();
  await page.getByRole('dialog', { name: 'Remove EPUB' }).getByRole('button', { name: 'Remove EPUB' }).click();
  await expect(attachments.getByText('No attachments.')).toBeVisible();
});

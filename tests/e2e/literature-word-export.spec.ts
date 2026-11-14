import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { zipSync, unzipSync } = webRequire('fflate') as {
  zipSync: (files: Record<string, Uint8Array>) => Uint8Array;
  unzipSync: (input: Uint8Array) => Record<string, Uint8Array>;
};

test('downloads a locally edited Word copy with citations and bibliography', async ({
  page,
  request,
  baseURL,
}, info) => {
  const id = randomUUID();
  const title = 'Synthetic Word reference ' + id;
  const key = 'docx:' + id;
  const created = await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id },
    data: { id, title, citation_key: key, authors: ['Example, Ada'], year: 2025 },
  });
  expect(created.status()).toBe(201);
  const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const types = 'http://schemas.openxmlformats.org/package/2006/content-types';
  const parts = {
    '[Content_Types].xml': `<Types xmlns="${types}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="${word}"><w:body><w:p><w:r><w:t>A sample [[cite:${key}|12–14]].</w:t></w:r></w:p><w:p><w:r><w:t>[[bibliography]]</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  };
  const original = Buffer.from(
    zipSync(Object.fromEntries(Object.entries(parts).map(([part, xml]) => [part, Buffer.from(xml)]))),
  );
  await page.goto('/research/library');
  await page.getByLabel('Search library').fill(id);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Literature results' }).getByText(title)).toBeVisible();
  await page.getByRole('button', { name: 'Export writing project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export writing project' });
  await dialog.getByLabel('Writing format').selectOption('word');
  await dialog.getByLabel('Open Word document').setInputFiles({
    name: 'example.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: original,
  });
  const outbound: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') outbound.push(request.url());
  });
  await dialog.getByRole('button', { name: 'Prepare Word copy' }).click();
  await expect(dialog.getByRole('status')).toHaveText('1 citation added with a bibliography.');
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download Word copy' }).click();
  const downloaded = await pending;
  expect(downloaded.suggestedFilename()).toBe('example-prism.docx');
  const bytes = await readFile((await downloaded.path())!);
  const copy = unzipSync(bytes);
  expect(Buffer.from(copy['word/document.xml']).toString()).toContain('CITATION PRISM_');
  expect(Buffer.from(copy['word/document.xml']).toString()).toContain('BIBLIOGRAPHY');
  expect(Buffer.from(copy['customXml/item1.xml']).toString()).toContain(title);
  expect(outbound).toEqual([]);
  if (process.env.PRISM_DOCX_INTEROP_FIXTURE) await writeFile(info.outputPath('example-prism.docx'), bytes);
});

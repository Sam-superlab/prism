import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

for (const [format, editor] of [
  ['writer-addon', 'Writer'],
  ['word-addon', 'Word'],
] as const) {
  test(`downloads only selected citation metadata for ${editor}`, async ({ page, request, baseURL }) => {
    const id = randomUUID();
    const key = 'writer:' + id;
    const title = 'Synthetic Writer source 数学 ' + id;
    const response = await request.post('/api/v1/research/references', {
      headers: { Origin: baseURL!, 'Idempotency-Key': id },
      data: { id, title, citation_key: key, authors: ['Example, Ada'], year: 2025 },
    });
    expect(response.status()).toBe(201);
    await page.goto('/research/library');
    await page.getByRole('button', { name: 'Export writing project' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export writing project' });
    await dialog.getByLabel('Writing format').selectOption(format);
    const outbound: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET') outbound.push(request.url());
    });
    await dialog.getByLabel('Citation keys').fill(`${key}\nunknown-citation`);
    await dialog.getByRole('button', { name: `Prepare ${editor} packet` }).click();
    await expect(dialog.getByRole('list', { name: 'Selected references' })).toContainText(title);
    await expect(dialog.getByText('Missing keys: unknown-citation')).toBeVisible();
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: `Download ${editor} packet` }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('prism-citations.txt');
    const [header, row, trailing] = (await readFile((await file.path())!, 'utf8')).split('\n');
    expect(header).toBe('PRISM-WRITER-CITATIONS/1');
    expect(row?.split('\t').slice(0, 5)).toEqual([key, '10', title, 'Example, Ada', '2025']);
    expect(trailing).toBe('');
    expect(outbound).toEqual([]);
  });
}

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('copies an existing citation key and downloads the matching library Markdown', async ({
  page,
  request,
  baseURL,
}) => {
  const id = randomUUID();
  const title = `Synthetic bibliography ${id}`;
  const key = 'export:' + id.slice(0, 8);
  const created = await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id },
    data: { id, title, authors: ['Example, Ada'], year: 2024, citation_key: key },
  });
  expect(created.status()).toBe(201);

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => sessionStorage.setItem('test-citation-key', text),
      },
    });
  });
  await page.goto(`/research/library?reference=${id}`);
  const details = page.getByRole('region', { name: title });
  await expect(details.getByText(key, { exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Copy citation key' }).click();
  await expect(details.getByRole('status').filter({ hasText: 'Citation key copied.' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('test-citation-key'))).toBe(key);
  await details.getByRole('button', { name: 'Close reference details' }).click();

  await page.getByLabel('Search library').fill(id);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Literature results' }).getByText(title)).toBeVisible();
  await page.getByRole('button', { name: 'Export bibliography' }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Export bibliography' });
  await exportDialog.getByLabel('Format').selectOption({ label: 'Markdown' });
  const pendingDownload = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download' }).click();
  const download = await pendingDownload;
  expect(download.suggestedFilename()).toBe('prism-library.md');
  expect(await readFile((await download.path())!, 'utf8')).toContain('Citation key: `' + key + '`');
});

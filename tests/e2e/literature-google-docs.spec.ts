import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('prepares a Google Docs citation packet without sending the pasted manuscript', async ({
  page,
  request,
  baseURL,
}) => {
  const id = randomUUID();
  const key = 'docs:' + id;
  const title = 'Synthetic Docs source ' + id;
  const response = await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id },
    data: { id, title, citation_key: key, authors: ['Example, Ada'], year: 2025 },
  });
  expect(response.status()).toBe(201);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => sessionStorage.setItem('test-docs-packet', value) },
    });
  });
  await page.goto('/research/library');
  await page.getByLabel('Search library').fill(id);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Literature results' }).getByText(title)).toBeVisible();
  await page.getByRole('button', { name: 'Export writing project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export writing project' });
  await dialog.getByLabel('Writing format').selectOption('google-docs');
  const outbound: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') outbound.push(request.url());
  });
  await dialog.getByLabel('Citation markers').fill(`Private manuscript [[cite:${key}|7]].`);
  await dialog.getByRole('button', { name: 'Prepare citation packet' }).click();
  await expect(dialog.getByRole('status')).toHaveText('1 marker matched.');
  const output = await dialog.getByLabel('Citation packet').inputValue();
  expect(output).not.toContain('Private manuscript');
  expect(JSON.parse(output)).toMatchObject({
    kind: 'prism-docs-citations',
    version: 1,
    entries: [{ key, canonical: key, locator: '7', text: '(Example, 2025, p. 7)' }],
    bibliography: expect.stringContaining(title),
  });
  await dialog.getByRole('button', { name: 'Copy citation packet' }).click();
  await expect(dialog.getByText('Citation packet copied.')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('test-docs-packet'))).toBe(output);
  expect(outbound).toEqual([]);
});

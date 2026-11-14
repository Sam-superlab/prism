import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { unzipSync } = webRequire('fflate') as {
  unzipSync: (input: Uint8Array) => Record<string, Uint8Array>;
};

test('resolves renamed references in a private Quarto draft and downloads a local writing project', async ({
  page,
  request,
  baseURL,
}) => {
  const id = randomUUID();
  const oldKey = `old-${id}`;
  const newKey = `new-${id}`;
  const title = `Synthetic manuscript reference ${id}`;
  const path = '/api/v1/research/references';
  const created = await request.post(path, {
    headers: { Origin: baseURL!, 'Idempotency-Key': id },
    data: { id, title, authors: ['Example, Ada'], year: 2024, citation_key: oldKey },
  });
  expect(created.status()).toBe(201);
  const previous = await created.json();
  expect(
    (
      await request.patch(`${path}/${id}/citation-key`, {
        headers: { Origin: baseURL!, 'If-Match': `"${previous.version}"`, 'Idempotency-Key': randomUUID() },
        data: { citation_key: newKey },
      })
    ).ok(),
  ).toBe(true);

  await page.goto('/research/library');
  await page.getByLabel('Search library').fill(id);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Literature results' }).getByText(title)).toBeVisible();
  await page.getByRole('button', { name: 'Export writing project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export writing project' });
  const outbound: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') outbound.push(request.url());
  });
  const source = `A synthetic paragraph cites [@${oldKey}, p. 12; @unmatched]. See @fig-examples.\n\n\`\`\`text\n@${oldKey}\n\`\`\`\n`;
  await dialog.getByLabel('Open Markdown or Quarto document').setInputFiles({
    name: 'example.qmd',
    mimeType: 'text/markdown',
    buffer: Buffer.from(source),
  });
  await expect(dialog.getByLabel('Document Markdown')).toHaveValue(source);
  await dialog.getByRole('button', { name: 'Prepare export' }).click();
  await expect(dialog.getByRole('status')).toHaveText('1 reference matched.');
  await expect(dialog.getByText('Missing keys: unmatched')).toBeVisible();
  await expect(dialog.getByText('1 alias updated')).toBeVisible();

  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download writing project ZIP' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('example-prism.zip');
  const files = unzipSync(await readFile((await download.path())!));
  expect(Object.keys(files)).toEqual(['example.qmd', 'prism-references.json']);
  expect(new TextDecoder().decode(files['example.qmd'])).toBe(
    '---\nbibliography: prism-references.json\n---\n\n' + source.replace(`[@${oldKey}`, `[@${newKey}`),
  );
  expect(JSON.parse(new TextDecoder().decode(files['prism-references.json']))).toEqual([
    expect.objectContaining({ id: newKey, title }),
  ]);
  expect(outbound).toEqual([]);
});

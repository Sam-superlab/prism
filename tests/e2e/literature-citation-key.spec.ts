import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('changes a generated citation key, preserves the draft after a version conflict, and exports the old alias', async ({
  page,
  request,
  baseURL,
}) => {
  const id = randomUUID();
  const title = `Synthetic citation key ${id}`;
  const oldKey = `ref-${id}`;
  const newKey = `fixture:${id}`;
  const path = `/api/v1/research/references/${id}`;
  const created = await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id },
    data: { id, title },
  });
  expect(created.status()).toBe(201);
  const first = await created.json();

  await page.goto(`/research/library?reference=${id}`);
  const details = page.getByRole('region', { name: title });
  await details.getByRole('button', { name: 'Edit citation key' }).click();
  const input = details.getByRole('textbox', { name: 'Citation key' });
  const save = details.getByRole('button', { name: 'Save citation key' });
  await expect(input).toHaveValue(oldKey);
  await expect(save).toBeDisabled();
  await input.fill('key with spaces');
  await expect(save).toBeDisabled();
  await input.fill(newKey);

  const editedElsewhere = await request.patch(path, {
    headers: { Origin: baseURL!, 'Idempotency-Key': randomUUID(), 'If-Match': `"${first.version}"` },
    data: { authors: ['Concurrent Author'] },
  });
  expect(editedElsewhere.ok()).toBe(true);
  await save.click();
  const reload = details.getByRole('button', { name: 'Reload latest citation key' });
  await expect(reload).toBeVisible();
  await expect(input).toHaveValue(newKey);
  await expect(save).toBeDisabled();
  await reload.click();
  await expect(input).toHaveValue(newKey);
  await save.click();
  await expect(details.getByRole('status')).toHaveText('Citation key saved.');
  await expect(details.getByText(newKey, { exact: true })).toBeVisible();

  const stored = await request.get(path);
  expect(await stored.json()).toMatchObject({
    citation_key: newKey,
    citation_aliases: [oldKey],
    authors: ['Concurrent Author'],
  });
  await details.getByRole('button', { name: 'Close reference details' }).click();
  await page.getByLabel('Search library').fill(id);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Literature results' }).getByText(title)).toBeVisible();
  await page.getByRole('button', { name: 'Export bibliography' }).click();
  const exporter = page.getByRole('dialog', { name: 'Export bibliography' });
  await exporter.getByLabel('Format').selectOption({ label: 'BibLaTeX' });
  const downloading = page.waitForEvent('download');
  await exporter.getByRole('button', { name: 'Download' }).click();
  const output = await readFile((await (await downloading).path())!, 'utf8');
  expect(output).toContain(`@misc{${newKey},`);
  expect(output).toContain(`ids = {${oldKey}}`);
});

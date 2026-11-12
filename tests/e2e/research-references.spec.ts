import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('saves a project reference, cites it in notes, and exports the matching BibTeX key', async ({
  page,
  request,
  baseURL,
}) => {
  const project = randomUUID();
  const created = await request.post('/api/v1/research/projects', {
    headers: { Origin: baseURL!, 'Idempotency-Key': project },
    data: { id: project, title: 'Synthetic bibliography project' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`/research/${project}`);
  const references = page.getByRole('region', { name: 'References' });
  await references.getByRole('button', { name: 'Add reference' }).click();
  const add = page.getByRole('dialog', { name: 'Add reference' });
  await add.getByLabel('Title', { exact: true }).fill('Example paper on graded rings');
  await add.getByLabel('Authors').fill('Example, Ada');
  await add.getByLabel('Year').fill('2024');
  await add.getByLabel('DOI').fill('10.5555/fixture');
  await add.getByRole('button', { name: 'Save reference' }).click();
  await expect(references.getByRole('link', { name: 'Example paper on graded rings' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit project' }).click();
  const editor = page.getByRole('dialog');
  const notes = editor.getByLabel('Project notes', { exact: true });
  await notes.fill('See ');
  const chooser = editor.getByLabel('Reference for Project notes');
  await chooser.selectOption({ label: 'Example paper on graded rings' });
  const citation = await chooser.inputValue();
  await editor.getByRole('button', { name: 'Insert citation' }).click();
  await expect(notes).toHaveValue(`See [@${citation}]`);
  await editor.getByText('Rendered preview', { exact: true }).click();
  await expect(editor.getByText('See (Example, 2024)', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Save project' }).click();
  await page.getByRole('button', { name: 'Project notes' }).click();
  await expect(page.getByText('See (Example, 2024)', { exact: true })).toBeVisible();

  const exported = page.waitForEvent('download');
  await references.getByRole('button', { name: 'Export BibTeX' }).click();
  const download = await exported;
  expect(download.suggestedFilename()).toBe('references.bib');
  expect(await readFile((await download.path())!, 'utf8')).toContain(`@misc{${citation},`);
});

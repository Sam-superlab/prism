import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectMarkdownSource } from './markdown-source';
import { literatureEpubFixture } from './epub-fixture';
import { pdfWithImageAndRepeatedMargins } from './pdf-fixture';

test('opens Library from the sidebar with direct tools and switches references in place', async ({ page, request, baseURL }) => {
  const token = randomUUID().slice(0, 8);
  const entries = [{ id: randomUUID(), title: `${token} First paper`, authors: ['Ada Example'] },
    { id: randomUUID(), title: `${token} Second paper`, authors: ['Eve Example'] }];
  for (const entry of entries) {
    expect((await request.post('/api/v1/research/references', {
      headers: { Origin: baseURL!, 'Idempotency-Key': entry.id }, data: entry,
    })).status()).toBe(201);
  }
  await page.goto('/research');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await navigation.getByRole('link', { name: 'Library', exact: true }).click();
  await expect(page).toHaveURL(/\/research\/library$/);
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Library', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(navigation.getByRole('link', { name: 'Research', exact: true })).not.toHaveAttribute('aria-current', 'page');
  const tools = page.getByRole('group', { name: 'Library tools' });
  for (const name of ['Add reference', 'Look up identifier', 'Import PDF', 'Import bibliography', 'Capture from browser',
    'Select references', 'Find duplicates', 'Search attachment text', 'Annotations', 'Feeds', 'Format citations',
    'Export bibliography', 'Export writing project']) {
    await expect(tools.getByRole('button', { name, exact: true })).toBeVisible();
  }
  const importPdf = tools.getByRole('button', { name: 'Import PDF', exact: true });
  await importPdf.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Import PDF as reference' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(importPdf).toBeFocused();
  const results = page.getByRole('region', { name: 'Literature results' });
  const table = results.getByRole('table', { name: 'Library references' });
  await expect(table.getByRole('columnheader')).toHaveText(['Title', 'Authors', 'Year']);
  await results.getByRole('searchbox').fill(token);
  await results.getByRole('button', { name: 'Search', exact: true }).click();
  for (const entry of entries) {
    const row = results.getByRole('link', { name: entry.title });
    await row.click();
    const detail = page.getByRole('region', { name: entry.title });
    await expect(detail.getByText(entry.authors[0])).toBeVisible();
    await expect(detail.getByRole('region', { name: 'Attachments' })).toBeVisible();
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const collections = await page.getByRole('navigation', { name: 'Collection filters' }).boundingBox();
    const list = await results.boundingBox();
    const inspector = await detail.boundingBox();
    expect(collections!.x).toBeLessThan(list!.x);
    expect(list!.x).toBeLessThan(inspector!.x);
  }
  await expect(results.getByRole('searchbox')).toHaveValue(token);
  await table.getByRole('button', { name: 'Authors' }).click();
  await table.getByRole('button', { name: 'Authors' }).click();
  await expect(table.getByRole('columnheader', { name: 'Authors' })).toHaveAttribute('aria-sort', 'descending');
  await expect(table.getByRole('link').first()).toHaveText(entries[1].title);
  await expect(table.getByRole('cell', { name: 'Eve Example', exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`reference=${entries[1].id}$`));
  await page.reload();
  await expect(page.getByRole('region', { name: entries[1].title })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Authors' })).toHaveAttribute('aria-sort', 'descending');
  await page.setViewportSize({ width: 440, height: 860 });
  await expect(results).toBeHidden();
  await page.getByRole('button', { name: 'Close reference details' }).click();
  await expect(results.getByRole('searchbox')).toBeFocused();
});

test('resizes Library panes and restores their widths and collapsed state', async ({ page, request, baseURL }) => {
  const id = randomUUID();
  const title = `Synthetic pane reference ${id.slice(0, 8)}`;
  expect((await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id }, data: { id, title },
  })).status()).toBe(201);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`/research/library?reference=${id}`);
  const collections = page.getByRole('complementary', { name: 'Literature collections' });
  const results = page.getByRole('region', { name: 'Literature results' });
  const detail = page.getByRole('region', { name: title });
  const left = page.getByRole('separator', { name: 'Resize collections' });
  const right = page.getByRole('separator', { name: 'Resize reference details' });
  await expect(detail.getByRole('region', { name: 'Attachments' })).toBeVisible();
  async function dragDivider(divider: typeof left, delta: number) {
    const box = await divider.boundingBox();
    const x = box!.x + box!.width / 2;
    const y = box!.y + 100;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 6 });
    await page.mouse.up();
  }

  const initialLeft = Number(await left.getAttribute('aria-valuenow'));
  const initialRight = Number(await right.getAttribute('aria-valuenow'));
  await dragDivider(left, 52);
  await expect(left).toHaveAttribute('aria-valuenow', String(initialLeft + 52));
  await dragDivider(right, 61);
  await expect(right).toHaveAttribute('aria-valuenow', String(initialRight - 61));
  await right.press('Shift+ArrowLeft');
  const adjustedRight = initialRight - 61 + 32;
  await expect(right).toHaveAttribute('aria-valuenow', String(adjustedRight));
  await expect.poll(async () => (await collections.boundingBox())?.width).toBe(initialLeft + 52);
  await expect.poll(async () => (await detail.boundingBox())?.width).toBe(adjustedRight);
  const fullWidth = (await results.boundingBox())!.width;
  await page.reload();
  await expect(left).toHaveAttribute('aria-valuenow', String(initialLeft + 52));
  await expect(right).toHaveAttribute('aria-valuenow', String(adjustedRight));

  const search = results.getByRole('searchbox');
  await search.fill(title);
  await search.press('Enter');
  await expect(results.getByRole('link', { name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Hide reference details' }).click();
  await expect(detail).toBeHidden();
  await expect(right).toBeHidden();
  await expect.poll(async () => (await results.boundingBox())!.width).toBe(fullWidth + adjustedRight + 1);
  await expect(search).toHaveValue(title);
  await expect(page).toHaveURL(new RegExp(`reference=${id}$`));
  await page.reload();
  await expect(detail).toBeHidden();
  await expect(left).toHaveAttribute('aria-valuenow', String(initialLeft + 52));
  await page.getByRole('button', { name: 'Show reference details' }).click();
  await expect(detail.getByRole('region', { name: 'Attachments' })).toBeVisible();
  await expect(right).toHaveAttribute('aria-valuenow', String(adjustedRight));

  await page.setViewportSize({ width: 440, height: 860 });
  await expect(left).toBeHidden();
  await expect(right).toBeHidden();
  await expect(detail).toBeVisible();
  await expect(results).toBeHidden();
  await page.setViewportSize({ width: 1500, height: 900 });
  await expect(left).toHaveAttribute('aria-valuenow', String(initialLeft + 52));
  await expect(right).toHaveAttribute('aria-valuenow', String(adjustedRight));
});

test('reviews PMCID lookup metadata before saving the article', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `Archived article fixture ${suffix}`;
  const query = `/api/v1/research/library?q=${suffix}`;
  await page.route('**/api/v1/research/library/lookup?**', (route) => {
    expect(Object.fromEntries(new URL(route.request().url()).searchParams)).toEqual({ kind: 'pmcid', value: 'PMC7840891' });
    return route.fulfill({ json: { kind: 'pmcid', identifier: 'PMC7840891', reference: {
      title, authors: ['Example, Ada'], year: 2025, doi: `10.5555/lookup-${suffix}`, arxiv_id: null,
      url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7840891/',
      publication: { type: 'article', pmcid: 'PMC7840891', pmid: '33248227' },
    } } });
  });
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Look up identifier' }).click();
  const lookup = page.getByRole('dialog', { name: 'Look up an identifier' });
  await lookup.getByLabel('Identifier type').selectOption('pmcid');
  await lookup.getByLabel('Identifier', { exact: true }).fill('PMC7840891');
  await lookup.getByRole('button', { name: 'Look up' }).click();
  const review = page.getByRole('dialog', { name: 'Add reference' });
  await expect(review.getByLabel('Title', { exact: true })).toHaveValue(title);
  await expect(review.getByLabel('PubMed Central ID')).toHaveValue('PMC7840891');
  expect((await (await request.get(query)).json()).items).toHaveLength(0);
  await review.getByRole('button', { name: 'Save reference' }).click();
  await expect(review).not.toBeVisible();
  expect((await (await request.get(query)).json()).items).toMatchObject([{ title, publication: { pmcid: 'PMC7840891', pmid: '33248227' } }]);
});

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
  await references.getByRole('button', { name: 'References', exact: true }).click();
  await references.getByRole('button', { name: 'Add reference' }).click();
  const add = page.getByRole('dialog', { name: 'Add reference' });
  await add.getByLabel('Title', { exact: true }).fill('Example paper on graded rings');
  await add.getByLabel('Authors').fill('Example, Ada');
  await add.getByLabel('Editors').fill('Example, Eve');
  await add.getByLabel('Translators').fill('Example, Téa');
  await add.getByLabel('Year').fill('2024');
  await add.getByLabel('DOI').fill('10.5555/fixture');
  await add.getByRole('button', { name: 'Save reference' }).click();
  await expect(references.getByRole('link', { name: 'Example paper on graded rings', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Edit project' }).click();
  const editor = page.getByRole('dialog');
  const notes = editor.getByLabel('Project notes', { exact: true });
  await notes.fill('See ');
  const chooser = editor.getByLabel('Reference for Project notes');
  await chooser.selectOption({ label: 'Example paper on graded rings' });
  const citation = await chooser.inputValue();
  await editor.getByRole('button', { name: 'Markdown source for Project notes' }).click();
  await editor.getByRole('button', { name: 'Insert citation' }).click();
  await expectMarkdownSource(notes, `See [@${citation}]`);
  await editor.getByRole('button', { name: 'Markdown source for Project notes' }).click();
  await notes.blur();
  await expect(editor.getByText('See (Example, 2024)', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Save project' }).click();
  await page.getByRole('button', { name: 'Project notes', exact: true }).click();
  await expect(page.getByText('See (Example, 2024)', { exact: true })).toBeVisible();

  const exported = page.waitForEvent('download');
  await references.getByRole('button', { name: 'Export BibTeX' }).click();
  const download = await exported;
  expect(download.suggestedFilename()).toBe('references.bib');
  expect(await readFile((await download.path())!, 'utf8')).toContain(`@misc{${citation},`);
  const bibliography = await (await request.get(`/api/v1/research/projects/${project}/bibliography`)).json();
  const anchor = bibliography.items[0].id;
  await page.goto(`/research/${project}#reference-${anchor}`);
  await expect(references.getByRole('button', { name: 'References', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(references.locator(`#reference-${anchor}`)).toBeVisible();


  await references.getByRole('link', { name: 'Open library' }).click();
  await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
  await page.getByLabel('Search library').fill('example, ada');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Literature results' })).toContainText('Example paper on graded rings');
  await page.getByRole('link', { name: 'Example paper on graded rings', exact: true }).click();
  await page.getByRole('button', { name: 'Edit reference Example paper on graded rings' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit reference' });
  await expect(edit.getByLabel('Editors')).toHaveValue('Example, Eve');
  await expect(edit.getByLabel('Translators')).toHaveValue('Example, Téa');
  await edit.getByLabel('Title', { exact: true }).fill('Updated paper on graded rings');
  await edit.getByRole('button', { name: 'Save reference' }).click();
  await expect(page.getByRole('link', { name: 'Updated paper on graded rings', exact: true })).toBeVisible();
  const raw = await request.get(`/api/v1/research/references/${citation.replace(/^ref-/, '')}`);
  expect(raw.ok()).toBe(true);
  expect(await raw.json()).toMatchObject({ title: 'Updated paper on graded rings', version: '2', creators: [
    { role: 'author', name: 'Example, Ada' }, { role: 'editor', name: 'Example, Eve' },
    { role: 'translator', name: 'Example, Téa' },
  ] });
  expect((await request.get('/api/v1/zotero')).status()).toBe(404);
});

test('imports and shares a library record across projects with its original citation key', async ({ page, request, baseURL }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `Standalone ideal theory ${suffix}`;
  const key = `Fixture_Algebra:${suffix}`;
  const data = `@article{${key},
    title = {${title}},
    author = {Noether, Emmy and Smith, Jane},
    year = {2021},
    journal = {Journal of Fixture Mathematics},
    volume = {8}
  }`;
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Import bibliography' }).click();
  const importer = page.getByRole('dialog', { name: 'Import bibliography' });
  await importer.getByLabel('Bibliography file').setInputFiles({
    name: 'fixture.bib',
    mimeType: 'text/plain',
    buffer: Buffer.from(data),
  });
  await expect(importer.getByText(title, { exact: true })).toBeVisible();
  await importer.getByRole('button', { name: 'Import references' }).click();
  await expect(importer.getByRole('status')).toHaveText('1 imported · 0 skipped as duplicates');
  await importer.getByRole('button', { name: 'Done' }).click();
  await page.getByLabel('Search library').fill(suffix);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export bibliography' }).click();
  await page.getByRole('dialog', { name: 'Export bibliography' }).getByRole('button', { name: 'Download' }).click();
  const download = await exported;
  const text = await readFile((await download.path())!, 'utf8');
  expect(text).toContain(`@article{${key},`);
  expect(text).toContain('journal = {Journal of Fixture Mathematics}');

  const projectNames = ['Shared algebra reference', 'Shared ring theory reference'];
  const projects = await Promise.all(projectNames.map(async (name) => {
    const id = randomUUID();
    const result = await request.post('/api/v1/research/projects', {
      headers: { Origin: baseURL!, 'Idempotency-Key': id },
      data: { id, title: name },
    });
    expect(result.status()).toBe(201);
    return id;
  }));
  for (const id of projects) {
    await page.goto(`/research/${id}`);
    const references = page.getByRole('region', { name: 'References' });
    await references.getByRole('button', { name: 'References', exact: true }).click();
    await references.getByRole('button', { name: 'Choose from library' }).click();
    const chooser = page.getByRole('dialog', { name: 'Choose from library' });
    await chooser.getByLabel('Search library').fill(suffix);
    await chooser.getByRole('button', { name: 'Search', exact: true }).click();
    await chooser.getByRole('button', { name: `Link ${title}`, exact: true }).click();
    await expect(references.getByText(title, { exact: true })).toBeVisible();
  }

  const bibliography = await request.get(`/api/v1/research/projects/${projects[1]}/bibliography`);
  const referenceId = (await bibliography.json()).items.find((item: { title: string }) => item.title === title).id;
  await page.goto(`/research/library?reference=${referenceId}`);
  await expect(page.getByRole('region', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: title }).getByText('Journal of Fixture Mathematics', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close reference details' }).click();
  await expect(page).toHaveURL(/\/research\/library$/);

  for (const id of projects) {
    await page.goto(`/research/${id}`);
    const references = page.getByRole('region', { name: 'References' });
    await references.getByRole('button', { name: 'References', exact: true }).click();
    await references.getByRole('button', { name: `Unlink ${title}` }).click();
    await expect(references.getByText(title, { exact: true })).toHaveCount(0);
  }
  await page.goto('/research/library');
  await page.getByLabel('Search library').fill(suffix);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('link', { name: title, exact: true }).click();
  await page.getByRole('button', { name: `Remove reference ${title}` }).click();
  await page.getByRole('dialog', { name: 'Remove reference' }).getByRole('button', { name: 'Remove reference' }).click();
  await expect(page.getByText('No references match your search.')).toBeVisible();
});

test('organizes a reference in nested collections, filters by tag, and exports the selected collection', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const parent = `Algebra ${suffix}`;
  const child = `Ideals ${suffix}`;
  const title = `Tagged paper ${suffix}`;
  await page.goto('/research/library');
  const navigation = page.getByRole('complementary', { name: 'Literature collections' });
  for (const name of [parent, child]) {
    await navigation.getByRole('button', { name: 'New collection' }).click();
    const dialog = page.getByRole('dialog', { name: 'New collection' });
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    if (name === child) await expect(dialog.getByLabel('Parent collection').locator('option:checked')).toHaveText(parent);
    await dialog.getByRole('button', { name: 'Save collection' }).click();
    await expect(navigation.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'true');
  }
  await page.getByRole('button', { name: 'Add reference', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add reference' });
  await add.getByLabel('Title', { exact: true }).fill(title);
  await add.getByLabel('Tags', { exact: true }).fill('Important; Reading');
  await add.getByRole('button', { name: 'Save reference' }).click();
  await page.getByLabel('Search library').fill(suffix);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('link', { name: title, exact: true }).click();
  await page.getByRole('button', { name: `Manage collections for ${title}` }).click();
  const manage = page.getByRole('dialog', { name: 'Manage collections' });
  for (const name of [parent, child]) {
    await manage.getByRole('button', { name: `Add to ${name}` }).click();
    await expect(manage.getByRole('button', { name: `Remove from ${name}` })).toBeEnabled();
  }
  await manage.getByRole('button', { name: 'Close', exact: true }).click();
  await navigation.getByRole('button', { name: child, exact: true }).click();
  await page.getByRole('button', { name: 'Important', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear tag filter · Important' })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export bibliography' }).click();
  const exporter = page.getByRole('dialog', { name: 'Export bibliography' });
  await exporter.getByLabel('Format').selectOption('ris');
  await exporter.getByRole('button', { name: 'Download' }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe('prism-library.ris');
  const content = await readFile((await file.path())!, 'utf8');
  expect(content).toContain(title);
  expect(content).toContain('KW  - Important');
});

test('saved searches reopen after reload and include new matching records', async ({ page, request, baseURL }) => {
  const token = randomUUID().slice(0, 8);
  const save = async (title: string, tags: string[]) => {
    const id = randomUUID();
    const response = await request.post('/api/v1/research/references', {
      headers: { Origin: baseURL!, 'Idempotency-Key': id },
      data: { id, title, tags },
    });
    expect(response.status()).toBe(201);
  };
  await save(`Initial ${token}`, ['Review soon']);
  await page.goto('/research/library');
  await page.getByLabel('Search library').fill(token);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('link', { name: `Initial ${token}` }).click();
  await page.getByRole('button', { name: 'Review soon', exact: true }).click();
  await page.getByRole('button', { name: 'Save current search', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save current search' });
  await dialog.getByLabel('Search name').fill(`Review ${token}`);
  await dialog.getByRole('button', { name: 'Save search' }).click();
  await expect(dialog).toBeHidden();

  await save(`New tagged ${token}`, ['Review soon']);
  await save(`New untagged ${token}`, []);
  await page.reload();
  await page.getByRole('combobox', { name: 'Saved searches' }).selectOption({ label: `Review ${token}` });
  await expect(page.getByText(`New tagged ${token}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`New untagged ${token}`, { exact: true })).toHaveCount(0);
});

test('combines nested advanced conditions and reopens a saved query', async ({ page, request, baseURL }) => {
  const token = randomUUID().slice(0, 8);
  const kept = `Advanced algebra ${token}`;
  const excluded = `Advanced geometry ${token}`;
  for (const [title, year] of [[kept, 2025], [excluded, 2018]] as const) {
    const id = randomUUID();
    const response = await request.post('/api/v1/research/references', {
      headers: { Origin: baseURL!, 'Idempotency-Key': id }, data: { id, title, year },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Advanced search', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Advanced search' });
  await editor.getByRole('textbox', { name: 'Value' }).fill(token);
  await editor.getByRole('button', { name: 'Add group' }).click();
  await editor.getByLabel('Field', { exact: true }).last().selectOption('year');
  await editor.getByLabel('Operator', { exact: true }).last().selectOption('gte');
  await editor.getByRole('spinbutton', { name: 'Value' }).fill('2024');
  await editor.getByRole('button', { name: 'Apply conditions' }).click();
  const results = page.getByRole('region', { name: 'Literature results' });
  await expect(results.getByText(kept, { exact: true })).toBeVisible();
  await expect(results.getByText(excluded, { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Save current search' }).click();
  const save = page.getByRole('dialog', { name: 'Save current search' });
  const name = `Advanced query ${token}`;
  await save.getByLabel('Search name').fill(name);
  await save.getByRole('button', { name: 'Save search' }).click();
  await expect(save).toBeHidden();
  await page.reload();
  await page.getByRole('combobox', { name: 'Saved searches', exact: true }).selectOption({ label: name });
  await expect(results.getByText(kept, { exact: true })).toBeVisible();
  await expect(results.getByText(excluded, { exact: true })).toBeHidden();
});

test('finds references by linked note text in advanced search', async ({ page, request, baseURL }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `A linked reference ${suffix}`;
  const linked = randomUUID();
  const headers = () => ({ Origin: baseURL!, 'Idempotency-Key': randomUUID() });
  const fixture = await request.post('/api/v1/research/references', { headers: headers(), data: { id: linked, title } });
  expect(fixture.status()).toBe(201);
  const note = await request.post(`/api/v1/research/references/${linked}/notes`, { headers: headers(), data: {
    id: randomUUID(), link_id: randomUUID(), title: 'Private note fixture', content: `Gröbner\n basis ${suffix}`,
  } });
  expect(note.status()).toBe(201);
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Advanced search', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Advanced search' });
  await editor.getByLabel('Field', { exact: true }).selectOption({ label: 'Linked note text' });
  await editor.getByLabel('Value', { exact: true }).fill(`grobner basis ${suffix}`);
  await editor.getByRole('button', { name: 'Apply conditions' }).click();
  const results = page.getByRole('region', { name: 'Literature results' });
  await expect(results.getByText(title, { exact: true })).toBeVisible();
  await expect(results.getByText('Private note fixture')).toHaveCount(0);
});

test('edits selected reference metadata and undoes the batch', async ({ page, request, baseURL }) => {
  const token = randomUUID().slice(0, 8);
  const records = [`Batch algebra ${token}`, `Batch geometry ${token}`, `Unselected ${token}`].map((title) => ({
    id: randomUUID(), title, year: 2019, tags: ['Pending'], publication: { journal: 'Example Journal' },
  }));
  for (const record of records) {
    const created = await request.post('/api/v1/research/references', {
      headers: { Origin: baseURL!, 'Idempotency-Key': record.id }, data: record,
    });
    expect(created.status()).toBe(201);
  }
  await page.goto('/research/library');
  await page.getByRole('searchbox', { name: 'Search library' }).fill(token);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Select references', exact: true }).click();
  await page.getByRole('checkbox', { name: `Select ${records[0].title}` }).check();
  await page.getByRole('checkbox', { name: `Select ${records[1].title}` }).check();
  await page.getByRole('button', { name: 'Edit selected (2)' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit selected references' });
  await edit.getByLabel('Add tags').fill('Reviewed');
  await edit.getByLabel('Remove tags').fill('pending');
  await edit.getByRole('checkbox', { name: 'Set Year' }).check();
  await edit.getByRole('spinbutton', { name: 'Year', exact: true }).fill('2025');
  await edit.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: '2 references updated.' })).toBeVisible();
  for (const [i, record] of records.entries()) {
    const saved = await request.get(`/api/v1/research/references/${record.id}`);
    expect(await saved.json()).toMatchObject({
      year: i === 2 ? 2019 : 2025, tags: i === 2 ? ['Pending'] : ['Reviewed'], publication: record.publication,
    });
  }
  await page.getByRole('button', { name: 'Undo batch edit' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Batch edit undone.' })).toBeVisible();
  for (const record of records) {
    const saved = await request.get(`/api/v1/research/references/${record.id}`);
    expect(await saved.json()).toMatchObject({ year: 2019, tags: ['Pending'], publication: record.publication });
  }
});

test('merges duplicate references and keeps the old citation in project notes', async ({ page, request, baseURL }) => {
  const token = randomUUID().slice(0, 8);
  const title = `Duplicate rings ${token}`;
  const targetId = randomUUID();
  const sourceId = randomUUID();
  const projectId = randomUUID();
  const post = async (path: string, data: Record<string, unknown>) => {
    const response = await request.post(`/api/v1/${path}`, {
      headers: { Origin: baseURL!, 'Idempotency-Key': randomUUID() },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const base = { title, authors: ['Noether, Emmy'], year: 2024 };
  await post('research/references', { ...base, id: targetId, tags: ['Keep'] });
  await post('research/references', { ...base, id: sourceId, tags: ['Transfer'], publication: { journal: 'Fixture Algebra' } });
  await post('research/projects', { id: projectId, title: `Merge project ${token}`, notes: `See [@ref-${sourceId}].` });
  await post('research/reference-links', { id: randomUUID(), project_id: projectId, reference_id: sourceId });

  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Find duplicates' }).click();
  const modal = page.getByRole('dialog', { name: 'Duplicate references' });
  await modal.getByRole('listitem').filter({ hasText: title }).getByRole('button', { name: 'Review' }).click();
  await modal.getByRole('radio', { name: new RegExp(targetId) }).check();
  await modal.getByRole('button', { name: 'Merge references' }).click();
  await expect(modal.getByText(title, { exact: true })).toHaveCount(0);
  await modal.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('Search library').fill(token);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Literature results' }).getByText(title, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Export bibliography' }).click();
  const exporter = page.getByRole('dialog', { name: 'Export bibliography' });
  await exporter.getByLabel('Format').selectOption('biblatex');
  const pending = page.waitForEvent('download');
  await exporter.getByRole('button', { name: 'Download', exact: true }).click();
  const downloaded = await pending;
  expect(downloaded.suggestedFilename()).toBe('prism-library-biblatex.bib');
  const text = await readFile((await downloaded.path())!, 'utf8');
  expect(text).toContain(`@misc{ref-${targetId},`);
  expect(text).toContain(`ids = {ref-${sourceId}}`);
  await page.goto(`/research/${projectId}`);
  await page.getByRole('button', { name: 'Project notes', exact: true }).click();
  await expect(page.getByText('See (Noether, 2024).', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'References' }).getByText(title, { exact: true })).toHaveCount(1);
});

test('reviews captured web metadata before saving a library reference', async ({ page, request }) => {
  const token = randomUUID().slice(0, 8);
  const title = `Captured algebra ${token}`;
  const transfer = JSON.stringify({
    format: 'prism-reference-v1',
    capture: { fields: { title, url: 'https://example.test/article', authors: ['Noether, Emmy'], year: 2024,
      publication: { type: 'article', journal: 'Captured Journal' }, tags: ['Algebra'] }, pdfUrl: null },
  });
  await page.addInitScript((text) => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => text } });
  }, transfer);
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Capture from browser' }).click();
  const capture = page.getByRole('dialog', { name: 'Capture from browser' });
  await capture.getByRole('button', { name: 'Review from clipboard' }).click();
  const add = page.getByRole('dialog', { name: 'Add reference' });
  await expect(add.getByLabel('Title', { exact: true })).toHaveValue(title);
  expect((await (await request.get(`/api/v1/research/library?q=${token}`)).json()).items).toEqual([]);
  await expect(add.getByLabel('Journal', { exact: true })).toHaveValue('Captured Journal');
  await add.getByLabel('Journal', { exact: true }).fill('Reviewed Journal');
  await add.getByRole('button', { name: 'Save reference' }).click();
  await expect(add).toBeHidden();
  const result = await request.get(`/api/v1/research/library?q=${token}`);
  expect((await result.json()).items).toMatchObject([{ title, publication: { journal: 'Reviewed Journal' }, tags: ['Algebra'] }]);
});

test('previews a publication feed and reviews an entry before saving it', async ({ page, request }) => {
  const token = randomUUID().slice(0, 8);
  const title = `Feed algebra ${token}`;
  const url = 'https://example.test/math.xml';
  await page.route('**/api/v1/research/library/feeds/preview', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ url });
    await route.fulfill({ json: { url, title: 'Algebra papers', items: [{
      external_id: 'entry-1', title, url: 'https://example.test/math/article', authors: ['Emmy Noether'],
      published_at: '2026-11-12T00:00:00.000Z', summary: 'A new result in commutative algebra.',
    }] } });
  });
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Feeds', exact: true }).click();
  const feed = page.getByRole('dialog', { name: 'Literature feeds' });
  await feed.getByLabel('Public HTTPS feed URL').fill(url);
  await feed.getByRole('button', { name: 'Preview feed', exact: true }).click();
  await expect(feed.getByRole('heading', { name: 'Algebra papers' })).toBeVisible();
  await feed.getByRole('button', { name: `Review ${title}` }).click();
  const editor = page.getByRole('dialog', { name: 'Add reference' });
  await expect(editor.getByLabel('Title', { exact: true })).toHaveValue(title);
  await expect(editor.getByLabel('Year', { exact: true })).toHaveValue('2026');
  await editor.getByRole('button', { name: 'Save reference' }).click();
  await expect(editor).toBeHidden();
  const result = await request.get(`/api/v1/research/library?q=${token}`);
  expect((await result.json()).items).toMatchObject([{ title, authors: ['Emmy Noether'], year: 2026 }]);
});

test('imports feed subscriptions from OPML, saves unread state, and exports the list', async ({ page, request }) => {
  const token = randomUUID().slice(0, 8);
  const url = `https://feed-${token}.example.com/algebra.xml`;
  const feedTitle = `Fixture feed ${token}`;
  const title = `Persistent paper ${token}`;
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Feeds', exact: true }).click();
  const feed = page.getByRole('dialog', { name: 'Literature feeds' });
  await feed.getByLabel('Choose OPML file').setInputFiles({
    name: 'fixture.opml', mimeType: 'text/xml',
    buffer: Buffer.from(`<?xml version="1.0"?><opml version="2.0"><head><title>Fixture</title></head><body><outline type="rss" text="${feedTitle}" xmlUrl="${url}"/></body></opml>`),
  });
  await feed.getByRole('button', { name: 'Import selected subscriptions' }).click();
  await expect(feed.getByText('1 subscription imported.')).toBeVisible();
  const list = await (await request.get('/api/v1/research/library/feeds')).json();
  const savedFeed = list.items.find((item: { url: string }) => item.url === url);
  expect(savedFeed?.title).toBe(feedTitle);
  await page.route(`**/api/v1/research/library/feeds/${savedFeed.id}/refresh`, async (route) => {
    await route.fulfill({ json: { feed: savedFeed, added: 1, pruned: 0 } });
  });
  const entryId = randomUUID();
  let readAt: string | null = null;
  await page.route(`**/api/v1/research/library/feeds/${savedFeed.id}/entries?*`, async (route) => {
    const unreadOnly = new URL(route.request().url()).searchParams.has('unread');
    await route.fulfill({ json: { items: unreadOnly && readAt ? [] : [{
      id: entryId, external_id: 'entry-1', title, url: null, authors: [], published_at: null, summary: null,
      version: readAt ? '2' : '1', read_at: readAt,
    }], next_cursor: null } });
  });
  await page.route(`**/api/v1/research/library/feed-entries/${entryId}`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ read: true });
    readAt = '2026-11-13T00:00:00.000Z';
    await route.fulfill({ json: { id: entryId, read_at: readAt, version: '2' } });
  });
  await feed.getByLabel('Subscription', { exact: true }).selectOption(savedFeed.id);
  const autoRefresh = feed.getByRole('checkbox', { name: 'Refresh automatically' });
  await expect(autoRefresh).not.toBeChecked();
  await autoRefresh.click();
  await expect(autoRefresh).toBeChecked();
  await expect(feed.getByText(/Next refresh/)).toBeVisible();
  await autoRefresh.click();
  await expect(autoRefresh).not.toBeChecked();
  await feed.getByRole('button', { name: 'Refresh feed', exact: true }).click();
  await expect(feed.getByText('1 new entry')).toBeVisible();
  await feed.getByRole('button', { name: 'Mark read' }).click();
  await expect(feed.getByRole('button', { name: 'Mark unread' })).toBeVisible();
  await feed.getByLabel('Unread only').check();
  await expect(feed.getByText('No unread entries.')).toBeVisible();
  const exported = page.waitForEvent('download');
  await feed.getByRole('button', { name: 'Export OPML' }).click();
  const download = await exported;
  expect(download.suggestedFilename()).toBe('prism-feeds.opml');
  expect(await readFile((await download.path())!, 'utf8')).toContain(url);
});

test('previews and saves captured page text as a searchable reader attachment', async ({ page, request }) => {
  const token = randomUUID().slice(0, 8);
  const title = `Captured page ${token}`;
  const snapshot = 'Example first paragraph.\n\nA unique algebraic application.\n\n<script>window.snapshotExecuted = true</script>';
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Capture from browser' }).click();
  const capture = page.getByRole('dialog', { name: 'Capture from browser' });
  await capture.getByLabel('Copied reference').fill(JSON.stringify({ format: 'prism-reference-v1', capture: {
    fields: { title, url: 'https://example.test/article' }, pdfUrl: null, snapshot: { text: snapshot, truncated: true },
  } }));
  await capture.getByRole('button', { name: 'Review reference' }).click();
  const add = page.getByRole('dialog', { name: 'Add reference' });
  await add.getByText('Review captured page text (partial)', { exact: true }).click();
  await expect(add.getByLabel('Captured page text')).toHaveValue(snapshot);
  await add.getByRole('button', { name: 'Save reference' }).click();
  await expect(add).toBeHidden();
  const { items } = await (await request.get(`/api/v1/research/library?q=${token}`)).json();
  const id = items[0].id;
  await page.goto(`/research/library?reference=${id}`);
  const name = 'Webpage snapshot.txt';
  await page.getByRole('button', { name, exact: true }).click();
  const reader = page.getByRole('dialog', { name });
  const content = reader.getByRole('region', { name: 'Saved page text' });
  await expect(content.getByText('<script>window.snapshotExecuted = true</script>', { exact: true })).toBeVisible();
  await reader.getByRole('searchbox', { name: 'Find in page snapshot' }).fill('algebraic');
  await expect(content.locator('[data-current-match]')).toHaveText('A unique algebraic application.');
  await content.locator('[data-current-match]').evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
  });
  await reader.getByRole('button', { name: 'Annotate selection' }).click();
  const annotations = reader.getByRole('region', { name: 'Text annotations' });
  await annotations.getByLabel('Annotation comment').fill('Reread this snapshot annotation');
  await annotations.getByRole('button', { name: 'Save annotation' }).click();
  await expect(content.locator('mark')).toHaveText('A unique algebraic application.');
  expect(await page.evaluate(() => 'snapshotExecuted' in window)).toBe(false);
  await reader.getByRole('button', { name: 'Index text' }).click();
  await expect(reader.getByRole('button', { name: 'Indexed', exact: true })).toBeVisible();
  await reader.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Close reference details' }).click();
  await page.getByRole('button', { name: 'Search attachment text', exact: true }).click();
  const search = page.getByRole('dialog', { name: 'Search attachment text and annotations' });
  await search.getByRole('searchbox').fill('reread this snapshot annotation');
  await search.getByRole('button', { name: 'Search', exact: true }).click();
  await search.getByRole('link', { name: `${title} · Paragraph 2` }).click();
  await expect(content.locator('[data-current-match]')).toHaveText('A unique algebraic application.');
  await expect(content.locator('mark[data-active-text-mark="true"]')).toHaveText('A unique algebraic application.');
});

test('creates, opens, unlinks and relinks a reference note without deleting the Knowledge item', async ({ page, request, baseURL }) => {
  const id = randomUUID();
  const title = `Reference note fixture ${id.slice(0, 8)}`;
  const noteTitle = `Reading idea ${id.slice(0, 8)}`;
  const created = await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id }, data: { id, title },
  });
  expect(created.status()).toBe(201);
  await page.goto(`/research/library?reference=${id}`);
  const notes = page.getByRole('region', { name: title }).getByRole('region', { name: 'Reference notes' });
  await notes.getByRole('button', { name: 'New note' }).click();
  await notes.getByLabel('Note title', { exact: true }).fill(noteTitle);
  await notes.locator('.cm-content').fill('Compare this construction with the earlier proof.');
  await notes.getByRole('button', { name: 'Save note' }).click();
  const link = notes.getByRole('link', { name: noteTitle });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  await notes.getByRole('button', { name: `Unlink ${noteTitle}` }).click();
  await expect(link).toBeHidden();
  const knowledgeId = href?.split('/').at(-1);
  const note = await request.get(`/api/v1/knowledge-items/${knowledgeId}`);
  expect((await note.json()).content).toContain('the earlier proof');
  await notes.getByRole('button', { name: 'Link a Knowledge item' }).click();
  await notes.getByRole('searchbox', { name: 'Search Knowledge' }).fill(noteTitle);
  await notes.getByRole('button', { name: 'Search', exact: true }).click();
  await notes.getByLabel('Knowledge item').selectOption(knowledgeId!);
  await notes.getByRole('button', { name: 'Link item' }).click();
  await expect(link).toHaveAttribute('href', href!);
  await link.click();
  await expect(page.getByRole('region', { name: 'Literature references' }).getByRole('link', { name: title })).toBeVisible();
});

test('reviews identifier metadata before saving, then formats the reference with CSL', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `Reviewed algebra ${suffix}`;
  await page.route('**/api/v1/research/library/lookup?*', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('kind')).toBe('doi');
    await route.fulfill({ json: { kind: 'doi', identifier: '10.5555/lookup-fixture', reference: {
      title: 'Original algebra title', authors: ['Noether, Emmy'], year: 2024,
      doi: '10.5555/lookup-fixture', url: null, arxiv_id: null,
      publication: { type: 'article', journal: 'Journal of Fixture Algebra' },
    } } });
  });
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Look up identifier' }).click();
  const lookup = page.getByRole('dialog', { name: 'Look up an identifier' });
  await lookup.getByLabel('Identifier', { exact: true }).fill('10.5555/lookup-fixture');
  await lookup.getByRole('button', { name: 'Look up', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add reference' });
  await expect(editor.getByLabel('Title', { exact: true })).toHaveValue('Original algebra title');
  expect((await (await request.get('/api/v1/research/library?q=lookup-fixture')).json()).items).toHaveLength(0);
  await editor.getByLabel('Title', { exact: true }).fill(title);
  await editor.getByRole('button', { name: 'Save reference' }).click();
  await expect(editor).toBeHidden();
  await page.getByLabel('Search library').fill(suffix);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Format citations' }).click();
  const format = page.getByRole('dialog', { name: 'Formatted citations' });
  await expect(format.getByLabel('In-text citation')).toHaveValue(/Noether, 2024/);
  await format.getByText('Citation details', { exact: true }).click();
  await format.getByLabel('Page or range').fill('24');
  await expect(format.getByLabel('In-text citation')).toHaveValue(/p\. 24/);
  await format.getByLabel('Page or range').fill('');
  await format.getByLabel('Citation style').selectOption('ieee');
  await expect(format.getByLabel('In-text citation')).toHaveValue('[1]');
  await expect(format.getByLabel('Bibliography', { exact: true })).toHaveValue(/Journal of Fixture Algebra/);
});

test('links references in both directions and removes the relation from either record', async ({ page, request, baseURL }) => {
  const suffix = randomUUID().slice(0, 8);
  const titles = [`Source ideals ${suffix}`, `Related rings ${suffix}`];
  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    const response = await request.post('/api/v1/research/references', {
      headers: { Origin: baseURL!, 'Idempotency-Key': id },
      data: { id, title: titles[index] },
    });
    expect(response.status()).toBe(201);
  }

  await page.goto(`/research/library?reference=${ids[0]}`);
  const related = page.getByRole('region', { name: 'Related references' });
  await related.getByLabel('Search for a related reference').fill(titles[1]);
  await related.getByRole('button', { name: 'Find related references' }).click();
  await related.getByRole('button', { name: `Relate ${titles[1]}` }).click();
  await related.getByRole('link', { name: titles[1], exact: true }).click();
  await expect(page.getByRole('region', { name: titles[1] })).toBeVisible();
  await expect(related.getByRole('link', { name: titles[0], exact: true })).toBeVisible();
  await related.getByRole('button', { name: `Unlink ${titles[0]}` }).click();
  await expect(related.getByText('No related references.')).toBeVisible();
  const original = await request.get(`/api/v1/research/references/${ids[0]}/related`);
  expect((await original.json()).items).toHaveLength(0);
});

test('imports a CSL JSON file into the local literature library', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = 'Synthetic CSL export ' + suffix;
  const key = 'Fixture_CSL_' + suffix;
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Import bibliography' }).click();
  const importer = page.getByRole('dialog', { name: 'Import bibliography' });
  await importer.getByLabel('Bibliography file').setInputFiles({
    name: 'synthetic-library.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify([{
      id: 'unselected-legacy-' + suffix,
      'citation-key': key,
      type: 'chapter',
      title,
      author: [{ family: 'Noether', given: 'Emmy' }],
      editor: [{ family: 'Borel', given: 'Jean' }],
      issued: { 'date-parts': [[2023, 2]] },
      'container-title': 'Fixture Proceedings',
      publisher: 'Fixture Press',
      'publisher-place': 'Budapest',
      'collection-title': 'Fixture Algebra Series',
      edition: '3',
      archive: 'arXiv',
      archive_location: '2401.01234v2',
      URL: 'https://example.test/' + suffix,
      keyword: 'Synthetic Algebra',
      note: 'From a local CSL JSON file.',
    }])),
  });
  await expect(importer.getByText(title, { exact: true })).toBeVisible();
  await importer.getByRole('button', { name: 'Import references' }).click();
  await expect(importer.getByRole('status')).toHaveText('1 imported · 0 skipped as duplicates');
  const response = await request.get('/api/v1/research/library?q=' + encodeURIComponent(key));
  expect(response.ok()).toBe(true);
  expect((await response.json()).items[0]).toMatchObject({
    title,
    citation_key: key,
    authors: ['Noether, Emmy'],
    year: 2023,
    arxiv_id: '2401.01234v2',
    tags: ['Synthetic Algebra'],
    publication: {
      type: 'incollection',
      booktitle: 'Fixture Proceedings',
      publisher: 'Fixture Press',
      address: 'Budapest',
      series: 'Fixture Algebra Series',
      edition: '3',
      month: '2',
      editor: 'Borel, Jean',
      note: 'From a local CSL JSON file.',
    },
  });
});

test('previews Zotero RDF locally and imports only confirmed metadata once', async ({ page, request, baseURL }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `Zotero chapter fixture ${suffix}`;
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dct="http://purl.org/dc/terms/"
 xmlns:b="http://purl.org/net/biblio#" xmlns:z="http://www.zotero.org/namespaces/export#"
 xmlns:f="http://xmlns.com/foaf/0.1/" xmlns:link="http://purl.org/rss/1.0/modules/link/">
 <b:BookSection r:about="#item_1"><z:itemType>bookSection</z:itemType><dc:title>${title}</dc:title>
  <dc:date>2024</dc:date><dct:isPartOf r:nodeID="book"/><dc:subject>Algebra</dc:subject>
  <b:authors><r:Seq><r:li><f:Person><f:surname>Example</f:surname><f:givenName>Ada</f:givenName></f:Person></r:li></r:Seq></b:authors>
  <dc:identifier><dct:URI><r:value>https://external.example/chapter</r:value></dct:URI></dc:identifier>
  <dct:isReferencedBy r:resource="#item_2"/><link:link r:resource="#item_3"/>
 </b:BookSection>
 <b:Book r:nodeID="book"><dc:title>Fixture Book</dc:title></b:Book>
 <b:Memo r:about="#item_2"><r:value>&lt;p&gt;Private fixture note&lt;/p&gt;</r:value></b:Memo>
 <z:Attachment r:about="#item_3"><z:itemType>attachment</z:itemType><z:path r:resource="file:///fixture/never-read.pdf"/></z:Attachment>
 <z:Collection r:about="#collection_1"><dc:title>Algebra course</dc:title><dct:hasPart r:resource="#item_1"/></z:Collection>
</r:RDF>`;
  const external: string[] = [];
  await page.route('https://external.example/**', (route) => { external.push(route.request().url()); return route.abort(); });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/research/library/import')) writes.push(request.url());
  });
  await page.goto('/research/library');
  async function preview(bytes = source) {
    await page.getByRole('button', { name: 'Import bibliography' }).click();
    const modal = page.getByRole('dialog', { name: 'Import bibliography' });
    await modal.getByLabel('Bibliography file').setInputFiles({ name: 'fixture.rdf', mimeType: 'application/rdf+xml', buffer: Buffer.from(bytes) });
    return modal;
  }
  let modal = await preview();
  await expect(modal.getByText(title, { exact: true })).toBeVisible();
  await expect(modal.getByText(/omit 1 collections, 1 notes and 1 attachments/)).toBeVisible();
  await expect(modal.getByText(/Algebra course/)).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Import references' })).toBeDisabled();
  expect(writes).toHaveLength(0);
  await modal.getByRole('checkbox', { name: 'Import bibliography metadata only' }).check();
  await modal.getByRole('button', { name: 'Import references' }).click();
  await expect(modal.getByRole('status')).toHaveText('1 imported · 0 skipped as duplicates');
  expect(writes).toHaveLength(1);
  await modal.getByRole('button', { name: 'Done' }).click();
  const result = (await (await request.get(`/api/v1/research/library?q=${suffix}`)).json()).items[0];
  const stored = (await (await request.get(`/api/v1/research/references/${result.id}`)).json());
  expect(stored).toMatchObject({ title, year: 2024, url: 'https://external.example/chapter', tags: ['Algebra'],
    authors: ['Example, Ada'], publication: { booktitle: 'Fixture Book' },
    import_source: { format: 'zotero-rdf', file_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), resource_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(JSON.stringify(stored)).not.toContain('never-read');
  modal = await preview();
  await modal.getByRole('checkbox', { name: 'Import bibliography metadata only' }).check();
  await modal.getByRole('button', { name: 'Import references' }).click();
  await expect(modal.getByRole('status')).toHaveText('0 imported · 1 skipped as duplicates');
  await modal.getByRole('button', { name: 'Done' }).click();
  const removed = await request.delete(`/api/v1/research/references/${result.id}`, {
    headers: { Origin: baseURL!, 'Idempotency-Key': randomUUID(), 'If-Match': '"1"' },
  });
  expect(removed.status()).toBe(204);
  modal = await preview();
  await modal.getByRole('checkbox', { name: 'Import bibliography metadata only' }).check();
  await modal.getByRole('button', { name: 'Import references' }).click();
  await expect(modal.getByText('A deleted reference already has this ID.')).toBeVisible();
  await modal.getByText('Close', { exact: true }).click();
  modal = await preview(source.replace('?>', '?>\n<!DOCTYPE r:RDF SYSTEM "https://external.example/resource.dtd">'));
  await expect(modal.getByText(/unsupported XML declarations/)).toBeVisible();
  expect(writes).toHaveLength(3);
  expect(external).toEqual([]);
});

test('imports selected Zotero collections and linked notes without loading external content', async ({ page, request, baseURL }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `Zotero structure fixture ${suffix}`;
  const source = `<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dct="http://purl.org/dc/terms/"
 xmlns:b="http://purl.org/net/biblio#" xmlns:z="http://www.zotero.org/namespaces/export#">
 <b:Book r:about="file:///private-test/book"><z:itemType>book</z:itemType><dc:title>${title}</dc:title>
  <dct:isReferencedBy r:resource="#child_note"/>
 </b:Book>
 <b:Memo r:about="#child_note"><r:value><![CDATA[<p>Remember <em>this</em> result.</p>
  <img src="https://external.example/pixel.png"><iframe src="https://external.example/frame.html"></iframe>
  <script>Ignore this code.</script><p>Literal $x$ and &lt;unsafe&gt;.</p>]]></r:value></b:Memo>
 <b:Memo r:about="#orphan"><r:value>Leave this independent note alone.</r:value></b:Memo>
 <z:Collection r:about="#inner"><dc:title>Inner ${suffix}</dc:title><dct:hasPart r:resource="file:///private-test/book"/></z:Collection>
 <z:Collection r:about="#outer"><dc:title>Outer ${suffix}</dc:title><dct:hasPart r:resource="#inner"/></z:Collection>
</r:RDF>`;
  const external: string[] = [];
  await page.route('https://external.example/**', (route) => { external.push(route.request().url()); return route.abort(); });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/research/library/zotero-rdf/import')) writes.push(request.postData() ?? '');
  });
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Import bibliography' }).click();
  await page.evaluate(() => window.addEventListener('prism:graph-changed', () => {
    document.body.dataset.rdfGraphChanged = 'true';
  }));
  const modal = page.getByRole('dialog', { name: 'Import bibliography' });
  await modal.getByLabel('Bibliography file').setInputFiles({ name: 'structure.rdf', mimeType: 'application/rdf+xml', buffer: Buffer.from(source) });
  await expect(modal.getByText(/1 notes are unlinked/)).toBeVisible();
  await modal.getByRole('checkbox', { name: /Include collection hierarchy/ }).check();
  await modal.getByRole('checkbox', { name: /Include linked notes/ }).check();
  await expect(modal.getByRole('button', { name: 'Import references' })).toBeDisabled();
  expect(writes).toHaveLength(0);
  await modal.getByRole('checkbox', { name: 'Import metadata and selected collections or notes' }).check();
  await modal.getByRole('button', { name: 'Import references' }).click();
  await expect(modal.getByText(/3 collections added.*1 memberships added.*1 notes added/)).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-rdf-graph-changed', 'true');
  expect(writes).toHaveLength(1);
  expect(writes[0]).not.toMatch(/private-test|external\.example|Ignore this code|independent note/);
  expect(external).toEqual([]);
  await modal.getByRole('button', { name: 'Done' }).click();
  const item = (await (await request.get(`/api/v1/research/library?q=${suffix}`)).json()).items[0];
  const allCollections = (await (await request.get('/api/v1/research/library/collections')).json()).items;
  const parent = allCollections.find((entry: { name: string }) => entry.name === `Outer ${suffix}`);
  const child = allCollections.find((entry: { name: string }) => entry.name === `Inner ${suffix}`);
  expect(child.parent_id).toBe(parent.id);
  const filtered = (await (await request.get(`/api/v1/research/library?collection_id=${child.id}`)).json()).items;
  expect(filtered).toMatchObject([{ id: item.id }]);
  const links = (await (await request.get(`/api/v1/research/references/${item.id}/knowledge-links`)).json()).items;
  const note = (await (await request.get(`/api/v1/knowledge-items/${links[0].knowledge_item_id}`)).json());
  expect(note).toMatchObject({ type: 'note', title: 'Remember this result.' });
  expect(note.content).toContain('Literal \\$x\\$ and \\<unsafe\\>.');
  const sourceRead = await request.post('/api/v1/research/library/zotero-rdf/import', {
    headers: { Origin: baseURL!, 'Idempotency-Key': randomUUID() }, data: JSON.parse(writes[0]),
  });
  expect(sourceRead.status()).toBe(200);
  expect(await sourceRead.json()).toMatchObject({ collections_kept: 3, memberships_kept: 1, notes_kept: 1 });
});

test('previews stand-alone Zotero notes and saves collection paths as Knowledge tags', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `Independent fixture ${suffix}`;
  const bytes = Buffer.from(`<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dct="http://purl.org/dc/terms/"
 xmlns:b="http://purl.org/net/biblio#" xmlns:z="http://www.zotero.org/namespaces/export#">
 <b:Memo r:about="file:///private-standalone-path"><z:itemType>note</z:itemType>
   <r:value><![CDATA[<p>${title}</p><img src="https://example.test/never-open"><p>Recall $x$ &amp; &lt;y&gt;.</p>]]></r:value>
 </b:Memo>
 <b:Memo r:about="#orphan"><r:value>Orphan child memo.</r:value></b:Memo>
 <b:Memo r:about="#attachment-note"><z:itemType>note</z:itemType><r:value>Attachment child note.</r:value></b:Memo>
 <z:Attachment r:about="#attachment"><dct:isReferencedBy r:resource="#attachment-note"/></z:Attachment>
 <z:Collection r:about="#nested"><dc:title>Ideas</dc:title><dct:hasPart r:resource="file:///private-standalone-path"/></z:Collection>
 <z:Collection r:about="#root"><dc:title>Algebra</dc:title><dct:hasPart r:resource="#nested"/></z:Collection>
 <z:Collection r:about="#second"><dc:title>Other reading</dc:title><dct:hasPart r:resource="file:///private-standalone-path"/></z:Collection>
 <z:Collection r:about="#cyclic"><dc:title>Broken branch</dc:title><dct:hasPart r:resource="#cyclic"/><dct:hasPart r:resource="file:///private-standalone-path"/></z:Collection>
</r:RDF>`);
  const network: string[] = [];
  const writes: string[] = [];
  await page.route('https://example.test/**', (route) => { network.push(route.request().url()); return route.abort(); });
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/research/library/zotero-rdf/import')) writes.push(request.postData() ?? '');
  });
  await page.goto('/research/library');
  await page.getByRole('button', { name: 'Import bibliography' }).click();
  const modal = page.getByRole('dialog', { name: 'Import bibliography' });
  await modal.getByLabel('Bibliography file').setInputFiles({ name: 'notes-only.rdf', mimeType: 'application/rdf+xml', buffer: bytes });
  await expect(modal.getByText(title, { exact: true })).toBeVisible();
  await expect(modal.getByText('Algebra › Ideas', { exact: true })).toBeVisible();
  await expect(modal.getByText('Other reading', { exact: true })).toBeVisible();
  await expect(modal.getByText(/1 note collection paths are unavailable/)).toBeVisible();
  await expect(modal.getByText(/2 notes are unlinked/)).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Import notes' })).toBeDisabled();
  expect(writes).toHaveLength(0);
  await modal.getByRole('checkbox', { name: /Include stand-alone notes/ }).check();
  await modal.getByRole('checkbox', { name: 'Import selected notes and collections' }).check();
  await modal.getByRole('button', { name: 'Import notes' }).click();
  await expect(modal.getByRole('status')).toHaveText('1 stand-alone note added · 0 kept · 0 skipped');
  expect(writes).toHaveLength(1);
  expect(writes[0]).not.toMatch(/private-standalone-path|example\.test|Orphan child memo|Attachment child note/);
  const note = (await (await request.get(`/api/v1/knowledge-items?subject=Zotero%20notes&q=${suffix}`)).json()).items[0];
  expect(note).toMatchObject({ title, type: 'note', subject: 'Zotero notes', tags: ['Zotero collection: Algebra › Ideas', 'Zotero collection: Other reading'] });
  expect(note.content).toContain('Recall \\$x\\$ & \\<y\\>.');
  expect(network).toEqual([]);
  await modal.getByRole('button', { name: 'Done' }).click();
  await page.goto(`/knowledge/${note.id}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
});

test('copies only selected Zotero export attachments and resumes after interruption', async ({ page, request, baseURL }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `Zotero file fixture ${suffix}`;
  const duplicateTitle = `Existing duplicate fixture ${suffix}`;
  const doi = `10.5555/zotero-attachment-${suffix}`;
  const duplicate = randomUUID();
  const reference = await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': duplicate },
    data: { id: duplicate, title: duplicateTitle, doi },
  });
  expect(reference.status()).toBe(201);
  const path = (id: number, file: string) => `files/${id}/${file}`;
  const attachment = (id: number, resource: string) => `<z:Attachment r:about="#item_${id}"><z:path r:resource="${resource}"/></z:Attachment>`;
  const links = (...ids: number[]) => ids.map((id) => `<l:link r:resource="#item_${id}"/>`).join('');
  const source = `<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:b="http://purl.org/net/biblio#" xmlns:z="http://www.zotero.org/namespaces/export#" xmlns:l="http://purl.org/rss/1.0/modules/link/">
    <b:Book r:about="#first"><z:itemType>book</z:itemType><dc:title>${title}</dc:title>${links(11, 12, 13, 14, 16, 17, 18, 19, 20)}</b:Book>
    <b:Book r:about="#second"><z:itemType>book</z:itemType><dc:title>Incoming duplicate ${suffix}</dc:title><dc:identifier>DOI ${doi}</dc:identifier>${links(15, 19)}</b:Book>
    ${attachment(11, path(11, 'café%20notes.pdf'))}${attachment(12, path(12, 'reference.epub'))}
    ${attachment(13, path(13, 'missing.pdf'))}${attachment(14, 'https://example.test/never-fetch.pdf')}
    ${attachment(15, path(15, 'café notes.pdf'))}${attachment(16, path(16, 'notes.svg'))}
    ${attachment(17, path(17, '%2Fprivate.pdf'))}${attachment(18, path(11, 'café notes.pdf'))}
    ${attachment(19, path(19, 'multiple-parents.pdf'))}${attachment(20, path(20, 'recover.pdf'))}
  </r:RDF>`;
  const folder = await mkdtemp(join(tmpdir(), 'prism-zotero-attachment-test-'));
  const wrong = await mkdtemp(join(tmpdir(), 'prism-zotero-wrong-export-'));
  try {
    await writeFile(join(folder, 'fixture.rdf'), source);
    await writeFile(join(wrong, 'fixture.rdf'), `${source}\n`);
    const pdf = pdfWithImageAndRepeatedMargins();
    const longPdf = Buffer.concat([pdf, Buffer.alloc(530_000, 32)]);
    for (const [entry, bytes] of [
      [path(11, 'café notes.pdf'), pdf], [path(12, 'reference.epub'), literatureEpubFixture()],
      [path(15, 'café notes.pdf'), pdf], [path(19, 'multiple-parents.pdf'), pdf], [path(20, 'recover.pdf'), longPdf],
      ['files/500/unrelated.pdf', pdf],
    ] as const) {
      await mkdir(join(folder, entry, '..'), { recursive: true });
      await writeFile(join(folder, entry), bytes);
    }
    const network: string[] = [];
    await page.route('https://example.test/**', (route) => { network.push(route.request().url()); return route.abort(); });
    const uploadIds: string[] = [];
    const offsets: number[] = [];
    let interrupted = false;
    await page.route('**/api/v1/research/references/*/attachments', async (route) => {
      const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
      if (body?.file_name === 'recover.pdf') uploadIds.push(body.id);
      await route.continue();
    });
    await page.route('**/api/v1/research/attachments/*/chunk', async (route) => {
      const url = route.request().url();
      if (uploadIds.some((id) => url.includes(id))) {
        const { offset } = route.request().postDataJSON();
        offsets.push(offset);
        if (offset > 0 && !interrupted) { interrupted = true; return route.abort(); }
      }
      await route.continue();
    });
    await page.goto('/research/library');
    async function openImport() {
      await page.getByRole('button', { name: 'Import bibliography' }).click();
      const modal = page.getByRole('dialog', { name: 'Import bibliography' });
      await modal.getByLabel('Bibliography file').setInputFiles(join(folder, 'fixture.rdf'));
      await modal.getByRole('checkbox', { name: 'Import bibliography metadata only' }).check();
      await modal.getByRole('button', { name: 'Import references' }).click();
      return modal;
    }
    let modal = await openImport();
    const picker = () => modal.getByLabel('Zotero export folder');
    await picker().setInputFiles(wrong);
    await expect(modal.getByText(/does not contain the same Zotero RDF/)).toBeVisible();
    await picker().setInputFiles(folder);
    await expect(modal.getByText('File missing from the selected folder.', { exact: false })).toBeVisible();
    await expect(modal.getByText('More than one attachment claims this path.', { exact: false })).toHaveCount(2);
    await expect(modal.getByText(/never-fetch|unrelated\.pdf|multiple-parents\.pdf/)).toHaveCount(0);
    await expect(modal.getByRole('checkbox', { name: `café notes.pdf → ${duplicateTitle}` })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Copy selected attachments' })).toBeDisabled();
    await modal.getByRole('checkbox', { name: `reference.epub → ${title}` }).check();
    await modal.getByRole('checkbox', { name: `recover.pdf → ${title}` }).check();
    await modal.getByRole('button', { name: 'Copy selected attachments' }).click();
    await expect(modal.getByText('1 attachment saved')).toBeVisible();
    await expect(modal.getByText(/Unable to connect/)).toBeVisible();
    const item = (await (await request.get(`/api/v1/research/library?q=${suffix}`)).json()).items.find((entry: { title: string }) => entry.title === title);
    const attachments = `/api/v1/research/references/${item.id}/attachments`;
    expect((await (await request.get(attachments)).json()).items.map((entry: { file_name: string }) => entry.file_name)).toEqual(['reference.epub']);
    await page.reload();
    modal = await openImport();
    await picker().setInputFiles(folder);
    await modal.getByRole('checkbox', { name: `reference.epub → ${title}` }).check();
    await modal.getByRole('checkbox', { name: `recover.pdf → ${title}` }).check();
    await modal.getByRole('checkbox', { name: 'Allow attachments on existing references matched by identifier' }).check();
    await modal.getByRole('checkbox', { name: `café notes.pdf → ${duplicateTitle}` }).check();
    await modal.getByRole('button', { name: 'Copy selected attachments' }).click();
    await expect(modal.getByText('3 attachments saved')).toBeVisible();
    expect(uploadIds[0]).toBe(uploadIds[1]);
    expect(offsets).toEqual([0, 524288, 524288]);
    const completed = (await (await request.get(attachments)).json()).items;
    expect(completed.map((entry: { file_name: string }) => entry.file_name).sort()).toEqual(['recover.pdf', 'reference.epub']);
    const pdfFile = completed.find((entry: { format: string }) => entry.format === 'pdf');
    expect(await (await request.get(`/api/v1/research/attachments/${pdfFile.id}/download`)).body()).toEqual(longPdf);
    expect((await (await request.get(`/api/v1/research/references/${duplicate}/attachments`)).json()).items).toMatchObject([{ file_name: 'café notes.pdf', format: 'pdf' }]);
    expect(network).toEqual([]);
  } finally {
    await Promise.all([rm(folder, { recursive: true, force: true }), rm(wrong, { recursive: true, force: true })]);
  }
});

test('converts selected Zotero HTML snapshots to safe readable page text', async ({ page, request }) => {
  const suffix = randomUUID().slice(0, 8);
  const title = `Web snapshot bibliography ${suffix}`;
  const htmlTitle = `Saved web title ${suffix}`;
  const source = `<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:b="http://purl.org/net/biblio#" xmlns:z="http://www.zotero.org/namespaces/export#" xmlns:l="http://purl.org/rss/1.0/modules/link/">
  <b:Document r:about="#page"><z:itemType>webpage</z:itemType><dc:title>${title}</dc:title>
    <l:link r:resource="#snapshot"/><l:link r:resource="#empty"/><l:link r:resource="#long"/><l:link r:resource="#external"/>
  </b:Document>
  <z:Attachment r:about="#snapshot"><z:path r:resource="files/11/page.html"/></z:Attachment>
  <z:Attachment r:about="#empty"><z:path r:resource="files/12/empty.htm"/></z:Attachment>
  <z:Attachment r:about="#long"><z:path r:resource="files/13/long.html"/></z:Attachment>
  <z:Attachment r:about="#external"><z:path r:resource="https://example.test/external.html"/></z:Attachment>
 </r:RDF>`;
  const folder = await mkdtemp(join(tmpdir(), 'prism-zotero-snapshot-'));
  const html = `<!doctype html><html><head><title>${htmlTitle}</title><base href="https://example.test/">
  <link rel="stylesheet" href="secret.css"><style>@import url(https://example.test/style.css);</style>
  <meta http-equiv="refresh" content="0; url=https://example.test/redirect">
  <script src="https://example.test/script.js"></script></head><body onload="window.snapshotWasRun = true">
  <h1>Local chapter &amp; notes</h1><p>Read <em>ordinary</em> text and &lt;quoted&gt; words.</p>
  <img src="pixel.png" srcset="wide.png 2x" onerror="window.snapshotWasRun = true">
  <iframe src="https://example.test/frame">Embedded frame fallback</iframe>
  <script>window.snapshotWasRun = true; /* source-secret */</script>
  <form><input value="form-secret"><textarea>textarea-secret</textarea><select><option>option-secret</option></select></form>
  <span hidden>hidden-secret</span><span aria-hidden="true">aria-secret</span><span style="display:none">inline-secret</span>
  <template shadowrootmode="open">template-secret</template><svg><text>svg-secret</text></svg>
  <table><tr><td>Alpha</td><td>Beta</td></tr></table></body></html>`;
  try {
    await writeFile(join(folder, 'snapshot.rdf'), source);
    for (const [name, text] of [
      ['11/page.html', html], ['12/empty.htm', '<title>No body</title><form><textarea>private</textarea></form>'],
      ['13/long.html', `<p>${'x'.repeat(61_000)}</p>`],
    ]) {
      await mkdir(join(folder, 'files', name, '..'), { recursive: true });
      await writeFile(join(folder, 'files', name), text);
    }
    const external: string[] = [];
    await page.route('https://example.test/**', (route) => { external.push(route.request().url()); return route.abort(); });
    const writes: string[] = [];
    page.on('request', (request) => {
      if (['POST', 'PUT'].includes(request.method()) && /\/research\/(?:references\/[^/]+\/attachments|attachments\/[^/]+\/(?:chunk|complete))$/.test(request.url()))
        writes.push(request.postData() ?? '');
    });
    await page.goto('/research/library');
    await page.getByRole('button', { name: 'Import bibliography' }).click();
    const modal = page.getByRole('dialog', { name: 'Import bibliography' });
    await modal.getByLabel('Bibliography file').setInputFiles(join(folder, 'snapshot.rdf'));
    await modal.getByRole('checkbox', { name: 'Import bibliography metadata only' }).check();
    await modal.getByRole('button', { name: 'Import references' }).click();
    await modal.getByLabel('Zotero export folder').setInputFiles(folder);
    await expect(modal.getByText('This HTML snapshot has no readable page text.', { exact: false })).toBeVisible();
    await expect(modal.getByText('Preview page text (truncated)', { exact: true })).toBeVisible();
    await modal.getByText('Preview page text', { exact: true }).click();
    await expect(modal.getByText(htmlTitle, { exact: true })).toBeVisible();
    await expect(modal.getByText('Local chapter & notes', { exact: true })).toBeVisible();
    expect(writes).toHaveLength(0);
    await modal.getByRole('checkbox', { name: `page.html → ${title}` }).check();
    await modal.getByRole('button', { name: 'Copy selected attachments' }).click();
    await expect(modal.getByText('1 attachment saved')).toBeVisible();
    expect(writes).toHaveLength(3);
    expect(writes[0]).toContain('page.txt');
    expect(writes.join(' ')).not.toMatch(/example\.test|files\/11/);
    const reference = (await (await request.get(`/api/v1/research/library?q=${suffix}`)).json()).items[0];
    const attachments = (await (await request.get(`/api/v1/research/references/${reference.id}/attachments`)).json()).items;
    expect(attachments).toMatchObject([{ file_name: 'page.txt', format: 'webpage' }]);
    const saved = await request.get(`/api/v1/research/attachments/${attachments[0].id}/download`);
    expect(saved.headers()['content-type']).toContain('text/plain');
    expect(await saved.text()).toBe(`${htmlTitle}\n\nLocal chapter & notes\n\nRead ordinary text and <quoted> words.\n\nAlpha Beta`);
    expect(await page.evaluate(() => Object.hasOwn(window, 'snapshotWasRun'))).toBe(false);
    expect(external).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

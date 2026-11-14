import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const style = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text">
  <info>
    <title>Fixture independent style</title>
    <id>https://example.test/csl/fixture</id>
    <updated>2026-01-01T00:00:00+00:00</updated>
  </info>
  <macro name="work"><text variable="title"/></macro>
  <citation><layout prefix="Fixture [" suffix="]"><text macro="work"/></layout></citation>
  <bibliography><layout><text macro="work" prefix="Entry: "/></layout></bibliography>
</style>`;

test('imports an independent local CSL style, persists selection, and rejects unsafe style files', async ({
  page,
  request,
  baseURL,
}) => {
  const id = randomUUID();
  const title = 'Synthetic citation ' + id.slice(0, 8);
  const created = await request.post('/api/v1/research/references', {
    headers: { Origin: baseURL!, 'Idempotency-Key': id },
    data: { id, title, authors: ['Noether, Emmy'], year: 2024 },
  });
  expect(created.status()).toBe(201);
  await page.goto('/research/library');
  await page.getByLabel('Search library').fill(title);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Format citations' }).click();
  const dialog = page.getByRole('dialog', { name: 'Formatted citations' });
  const selector = dialog.getByLabel('Citation style');
  await expect(selector).toHaveValue('apa');
  await dialog.getByText('Manage citation styles').click();
  const fileInput = dialog.getByLabel('Import CSL style');
  const upload = (xml: string) =>
    fileInput.setInputFiles({
      name: 'synthetic-style.csl',
      mimeType: 'application/xml',
      buffer: Buffer.from(xml),
    });
  await upload(
    style.replace(
      '<style ',
      '<!DOCTYPE style [<!ENTITY external SYSTEM "https://example.test/private">]><style ',
    ),
  );
  await expect(dialog.getByText(/XML declaration or instruction/)).toBeVisible();
  await upload(style.replace('variable="title"', 'macro="work"'));
  await expect(dialog.getByText(/circular macro reference/)).toBeVisible();
  await upload(
    style.replace(
      '<updated>',
      '<link rel="independent-parent" href="https://example.test/parent"/><updated>',
    ),
  );
  await expect(dialog.getByText(/depends on a parent style/)).toBeVisible();
  await upload(style);
  await expect(selector.locator('option:checked')).toHaveText('Fixture independent style');
  const styleSearch = dialog.getByLabel('Search citation styles');
  await styleSearch.fill('independent');
  await expect(selector.getByRole('option')).toHaveCount(1);
  await styleSearch.fill('unknown-style');
  await expect(dialog.getByText('No citation styles match your search.')).toBeVisible();
  await expect(selector.locator('option:checked')).toHaveText('Fixture independent style');
  await styleSearch.clear();
  await expect(dialog.getByLabel('In-text citation')).toHaveValue('Fixture [' + title + ']');
  await expect(dialog.getByLabel('Bibliography', { exact: true })).toHaveValue('Entry: ' + title);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await page.getByLabel('Search library').fill(title);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Format citations' }).click();
  await expect(selector.locator('option:checked')).toHaveText('Fixture independent style');
  await expect(dialog.getByLabel('In-text citation')).toHaveValue('Fixture [' + title + ']');
  await dialog.getByText('Manage citation styles').click();
  await dialog.getByRole('button', { name: 'Remove selected style' }).click();
  await expect(selector).toHaveValue('apa');
  await expect(selector.getByRole('option', { name: 'Fixture independent style' })).toHaveCount(0);
});

test('builds a filtered citation cluster with independent locators and affixes', async ({
  page,
  request,
  baseURL,
}) => {
  const token = randomUUID().slice(0, 8);
  const articles = [
    {
      id: randomUUID(),
      title: `Étude de la topologie ${token}`,
      authors: ['Borel, Jean'],
      year: 2020,
      citation_key: `topology:${token}`,
    },
    {
      id: randomUUID(),
      title: `Algebra and its applications ${token}`,
      authors: ['Example, Ada'],
      year: 2024,
      citation_key: `algebra:${token}`,
    },
  ];
  for (const item of articles) {
    const created = await request.post('/api/v1/research/references', {
      headers: { Origin: baseURL!, 'Idempotency-Key': item.id },
      data: item,
    });
    expect(created.status()).toBe(201);
  }
  await page.goto('/research/library');
  await page.getByLabel('Search library').fill(token);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText(articles[0].title, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Format citations' }).click();
  const dialog = page.getByRole('dialog', { name: 'Formatted citations' });
  const citation = dialog.getByLabel('In-text citation');
  const bibliography = dialog.getByLabel('Bibliography', { exact: true });
  await expect(citation).toHaveValue('(Borel, 2020; Example, 2024)');
  const originalBibliography = await bibliography.inputValue();

  await dialog.getByText('Included references (2)').click();
  const search = dialog.getByLabel('Find references');
  await search.fill('etude 2020');
  await expect(dialog.getByRole('checkbox', { name: articles[0].title })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: articles[1].title })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Clear selection' }).click();
  await expect(dialog.getByText('Include at least one reference to format a citation.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Include matching references' }).click();
  await expect(citation).toHaveValue('(Borel, 2020)');
  await search.fill(`algebra:${token}`);
  await expect(dialog.getByRole('checkbox', { name: articles[1].title })).toBeVisible();
  await dialog.getByRole('button', { name: 'Include matching references' }).click();
  await expect(citation).toHaveValue('(Borel, 2020; Example, 2024)');

  await dialog.getByText('Citation details', { exact: true }).click();
  const source = dialog.getByLabel('Citation reference');
  await source.selectOption(`reference:${articles[0].id}`);
  await dialog.getByLabel('Locator type').selectOption('section');
  await dialog.getByLabel('Locator', { exact: true }).fill('2.3');
  await dialog.getByRole('checkbox', { name: 'Omit author in citation' }).check();
  await source.selectOption(`reference:${articles[1].id}`);
  await dialog.getByLabel('Page or range').fill('12');
  await dialog.getByLabel('Prefix').fill('see');
  await dialog.getByLabel('Suffix').fill(', emphasis added');
  await expect(citation).toHaveValue(/2020, Section 2\.3.*see Example, 2024, p\. 12, emphasis added/);
  await expect(citation).not.toHaveValue(/Borel/);
  await expect(bibliography).toHaveValue(originalBibliography);

  await dialog.getByRole('checkbox', { name: articles[1].title }).uncheck();
  await expect(citation).toHaveValue('(2020, Section 2.3)');
  await dialog.getByRole('checkbox', { name: articles[1].title }).check();
  await expect(citation).toHaveValue(/p\. 12, emphasis added/);
  await expect(bibliography).toHaveValue(originalBibliography);
});

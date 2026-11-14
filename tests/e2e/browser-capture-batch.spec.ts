import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { parseBibliographyImport } from '../../apps/web/lib/bibliography-import';

test('finds independent bibliographic records and resolves references in structured listing metadata', async ({ page }) => {
  const bundle = await build({
    entryPoints: ['apps/browser-capture/capture.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'captureTest',
  });
  const listing = {
    '@graph': [
      {
        '@type': 'ItemList',
        itemListElement: [
          { '@type': 'ListItem', url: '/papers/one', item: { '@id': '#one' } },
          {
            '@type': 'ListItem',
            item: {
              '@type': 'Book', name: 'Second fixture', isbn: '9780000000002',
              url: 'javascript:alert(1)', doi: '10.4321/second', author: { name: 'Fixture Lab' },
            },
          },
          { '@type': 'ScholarlyArticle', name: 'Duplicate fixture', doi: '10.4321/SECOND' },
          { '@type': 'ScholarlyArticle', name: 'Unsafe fixture', url: 'https://name:password@example.test/paper' },
          { '@type': 'Product', name: 'Unrelated fixture', url: '/catalog/product' },
        ],
      },
      {
        '@id': '#one', '@type': 'https://schema.org/ScholarlyArticle', headline: 'First fixture',
        author: [{ '@id': '#author' }], isPartOf: { '@id': '#journal' }, datePublished: '2025-02-12',
        identifier: { propertyID: 'DOI', value: '10.4321/first' },
      },
      { '@id': '#author', '@type': 'Person', givenName: 'Ada', familyName: 'Example' },
      { '@id': '#journal', '@type': 'Periodical', name: 'Journal of Fixtures' },
    ],
  };
  await page.route('https://example.test/library', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<title>Listing</title><script type="application/ld+json">{broken</script>
      <script type="application/ld+json">${JSON.stringify(listing)}</script>`,
  }));
  await page.goto('https://example.test/library');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const captured = await page.evaluate<{ batch: { records: unknown[]; truncated: boolean } }>('captureTest.collect()');
  expect(captured.batch.truncated).toBe(false);
  expect(captured.batch.records).toMatchObject([
    {
      type: 'article-journal', title: 'First fixture', author: [{ family: 'Example', given: 'Ada' }],
      DOI: '10.4321/first', URL: 'https://example.test/papers/one', 'container-title': 'Journal of Fixtures',
    },
    { type: 'book', title: 'Second fixture', DOI: '10.4321/second', URL: 'https://doi.org/10.4321/second' },
  ]);
  const imported = parseBibliographyImport(JSON.stringify(captured.batch.records), 'csl-json');
  expect(imported.records.map(({ fields }) => fields.title)).toEqual(['First fixture', 'Second fixture']);
  expect(imported.records.map(({ fields }) => fields.doi)).toEqual(['10.4321/first', '10.4321/second']);

  await page.evaluate(() => {
    const script = document.querySelector('script[type="application/ld+json"]')!;
    script.textContent = JSON.stringify(Array.from({ length: 30 }, (_, index) => ({
      '@type': 'ScholarlyArticle', headline: `Additional fixture ${index + 1}`, url: `/papers/additional-${index + 1}`,
    })));
  });
  const limited = await page.evaluate<typeof captured>('captureTest.collect()');
  expect(limited.batch.truncated).toBe(true);
  expect(limited.batch.records).toHaveLength(25);
});

test('downloads only checked references after an explicit popup click', async ({ page }) => {
  await page.setContent(
    (await readFile('apps/browser-capture/popup.html', 'utf8')).replace(/<script[^>]*><\/script>/, ''),
  );
  await page.evaluate(() => {
    const records = [
      { id: 'fixture-one', type: 'article-journal', title: 'First fixture' },
      { id: 'fixture-two', type: 'article-journal', title: '<b>Second fixture</b>' },
    ];
    Object.defineProperty(window, 'chrome', { configurable: true, value: {
      tabs: { query: async () => [{ id: 9 }] },
      scripting: { executeScript: async () => [{ result: { title: 'Listing', transfer: '{}', batch: { records, truncated: false } } }] },
    } });
  });
  await page.addScriptTag({ path: 'apps/browser-capture/popup.js' });
  const first = page.getByRole('checkbox', { name: 'First fixture' });
  const second = page.getByRole('checkbox', { name: '<b>Second fixture</b>' });
  const download = page.getByRole('button', { name: /Download selected/ });
  await expect(first).not.toBeChecked();
  await expect(second).not.toBeChecked();
  await expect(download).toBeDisabled();
  await second.check();
  await expect(download).toHaveText('Download selected (1)');
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  expect(file.suggestedFilename()).toBe('prism-references.json');
  const localFile = await file.path();
  expect(JSON.parse(await readFile(localFile!, 'utf8'))).toEqual([
    { id: 'fixture-two', type: 'article-journal', title: '<b>Second fixture</b>' },
  ]);
  await expect(page.getByRole('status')).toContainText('Import bibliography');
});

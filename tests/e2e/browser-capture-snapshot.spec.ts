import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

test('injected snapshot bundles only share an identity within the captured document', async ({ page }) => {
  const buildScript = (name: 'capture' | 'snapshot') => build({
    entryPoints: [`apps/browser-capture/${name}.ts`], bundle: true, write: false,
    format: 'iife', globalName: 'prismBrowserCapture',
  }).then(({ outputFiles }) => outputFiles[0].text);
  const [capture, snapshot] = await Promise.all([buildScript('capture'), buildScript('snapshot')]);
  await page.route('https://example.test/document', (route) => route.fulfill({
    contentType: 'text/html', body: '<title>Fixture paper</title><article><p>Fixture body.</p></article>',
  }));
  await page.goto('https://example.test/document');
  await page.addScriptTag({ content: capture });
  const key = await page.evaluate<string>('prismBrowserCapture.collect().documentKey');
  expect(key).toBeTruthy();
  await page.addScriptTag({ content: snapshot });
  expect(await page.evaluate('prismBrowserCapture.collect().documentKey')).toBe(key);
  await page.reload();
  await page.addScriptTag({ content: snapshot });
  expect(await page.evaluate('prismBrowserCapture.collect()')).toBeNull();
});

test('extracts visible article structure and excludes form values and unrelated content', async ({
  page,
}) => {
  const bundle = await build({
    entryPoints: ['apps/browser-capture/webpage.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'snapshotTest',
  });
  await page.setContent(`
    <nav>Navigation away from the paper</nav>
    <main>
      <section><p>Unrelated main section</p></section>
      <article>
        <h1>Algebraic structures</h1>
        <p>An <em>ideal</em> is an important object.<br>We now prove a theorem.</p>
        <form><input value="private field"><textarea>private note</textarea><p>Form text</p></form>
        <p contenteditable>Editable note</p>
        <div style="display:none"><p>Hidden text</p></div>
        <div style="visibility:hidden"><p>Invisible text</p></div>
        <div aria-hidden="true">Decoration</div>
        <aside>Related stories</aside>
        <iframe srcdoc="<p>Embedded page</p>"></iframe>
        <script type="application/json">{"secret": "Never captured"}</script>
        <ul><li>First observation</li><li>Second observation</li></ul>
        <pre>  x = 1
  y = 2</pre>
      </article>
    </main>
    <footer>Site links</footer>
  `);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const snapshot = await page.evaluate('snapshotTest.readWebpageSnapshot(document)');
  expect(snapshot).toEqual({
    text: 'Algebraic structures\n\nAn ideal is an important object.\nWe now prove a theorem.\n\n• First observation\n• Second observation\n\n  x = 1\n  y = 2',
    truncated: false,
  });

  await page.locator('article').evaluate((element) => {
    element.textContent = '𝕜'.repeat(35_000);
  });
  const long = await page.evaluate('snapshotTest.readWebpageSnapshot(document)');
  expect(long.truncated).toBe(true);
  expect(long.text.length).toBeLessThanOrEqual(60_000);
  expect(long.text.isWellFormed()).toBe(true);
});

test('the browser popup captures page text only after the separate explicit click', async ({ page }) => {
  await page.setContent(
    (await readFile('apps/browser-capture/popup.html', 'utf8')).replace(/<script[^>]*><\/script>/, ''),
  );
  await page.evaluate(() => {
    const calls: { file: string; target: unknown }[] = [];
    let clipboard = '';
    const testChrome = {
      tabs: { query: async () => [{ id: 9 }] },
      scripting: {
        executeScript: async ({ files, target }: { files: string[]; target: unknown }) => {
          calls.push({ file: files[0], target });
          const snapshot = files[0] === 'snapshot.js';
          const capture = {
            fields: { title: 'Fixture reference' },
            ...(snapshot ? { snapshot: { text: 'Visible article text', truncated: false } } : {}),
          };
          return [
            {
              documentId: 'fixture',
              result: {
                documentKey: 'fixture-key',
                title: capture.fields.title,
                documentUrl: 'https://example.test/paper',
                transfer: JSON.stringify({ format: 'prism-reference-v1', capture }),
              },
            },
          ];
        },
      },
    };
    Object.defineProperty(window, 'chrome', { configurable: true, value: testChrome });
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          clipboard = text;
        },
      },
    });
    Object.assign(window, { popupResult: () => ({ calls, clipboard }) });
  });
  await page.addScriptTag({ path: 'apps/browser-capture/popup.js' });
  const copy = page.getByRole('button', { name: 'Copy reference', exact: true });
  await expect(copy).toBeEnabled();
  await copy.click();
  await expect(page.getByRole('status')).toContainText('Copied.');
  const before = await page.evaluate<{ calls: unknown[]; clipboard: string }>('popupResult()');
  expect(before.calls).toEqual([{ file: 'capture.js', target: { tabId: 9, frameIds: [0] } }]);
  expect(JSON.parse(before.clipboard).capture).not.toHaveProperty('snapshot');
  await page.getByRole('button', { name: 'Copy reference + page text' }).click();
  await expect(page.getByRole('status')).toContainText('Copied the reference and page text');
  const after = await page.evaluate<{ calls: unknown[]; clipboard: string }>('popupResult()');
  expect(after.calls).toEqual([
    { file: 'capture.js', target: { tabId: 9, frameIds: [0] } },
    { file: 'snapshot.js', target: { tabId: 9, documentIds: ['fixture'] } },
  ]);
  expect(JSON.parse(after.clipboard).capture.snapshot).toEqual({
    text: 'Visible article text',
    truncated: false,
  });
});

test('the Firefox frame fallback refuses text from a same-URL reload', async ({ page }) => {
  await page.setContent(
    (await readFile('apps/browser-capture/popup.html', 'utf8')).replace(/<script[^>]*><\/script>/, ''),
  );
  await page.evaluate(() => {
    const calls: { file: string; target: unknown }[] = [];
    let clipboard = '';
    const testBrowser = {
      tabs: { query: async () => [{ id: 4 }] },
      scripting: {
        executeScript: async ({ files, target }: { files: string[]; target: unknown }) => {
          calls.push({ file: files[0], target });
          const snapshot = files[0] === 'snapshot.js';
          return [{ frameId: 0, result: {
            title: 'Fixture reference',
            documentKey: snapshot ? 'reloaded-fixture' : 'original-fixture',
            documentUrl: 'https://example.test/same-paper',
            transfer: snapshot ? 'Text from a different document' : 'Original reference',
          } }];
        },
      },
    };
    Object.defineProperty(window, 'browser', { configurable: true, value: testBrowser });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => { clipboard = value; } } });
    Object.assign(window, { popupResult: () => ({ calls, clipboard }) });
  });
  await page.addScriptTag({ path: 'apps/browser-capture/popup.js' });
  await page.getByRole('button', { name: 'Copy reference + page text' }).click();
  await expect(page.getByRole('status')).toContainText('The page text could not be captured');
  const result = await page.evaluate('popupResult()');
  expect(result).toEqual({ calls: [
    { file: 'capture.js', target: { tabId: 4, frameIds: [0] } },
    { file: 'snapshot.js', target: { tabId: 4, frameIds: [0] } },
  ], clipboard: '' });
});

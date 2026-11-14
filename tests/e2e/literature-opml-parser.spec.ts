import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import type * as opml from '../../apps/web/lib/literature-opml';

declare global {
  interface Window {
    prismOpml: typeof opml;
  }
}

let script: string;
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ['apps/web/lib/literature-opml.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'prismOpml',
    platform: 'browser',
  });
  script = bundle.outputFiles[0]!.text;
});
test.beforeEach(async ({ page }) => {
  await page.addScriptTag({ content: script });
});

test('reads nested feeds locally and reports duplicates, missing URLs, and invalid entries', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const parsed = await page.evaluate(() =>
    window.prismOpml.parseLiteratureOpml(`
    <?xml version="1.0"?>
    <opml version="2.0"><body>
      <!-- The string &lt;? is fine in comments, as is <?example>. -->
      <outline text="Journal feeds">
        <outline type="rss" text="Geometry &amp; Algebra" xmlUrl="https://public.example.com/feed?q=1&amp;p=2"/>
        <outline type="atom" xmlUrl="https://research.example.org/atom"/>
      </outline>
      <outline type="rss" title="Duplicate" xmlUrl="https://PUBLIC.example.com:443/feed?q=1&amp;p=2#item"/>
      <outline type="rss" title="Missing" />
      <outline type="rss" text="HTTP" xmlUrl="http://public.example.com/feed"/>
      <outline type="rss" text="Local" xmlUrl="https://127.0.0.1/atom"/>
      <outline type="rss" text="Auth" xmlUrl="https://user:pass@public.example.com/atom"/>
      <outline type="rss" text="Private DNS suffix" xmlUrl="https://printer.home.arpa/atom"/>
      <outline type="rss" text="IPv6" xmlUrl="https://[::1]/atom"/>
      <outline type="link" text="Website" xmlUrl="https://research.example.org/"/>
      <outline type="include" url="https://example.com/list.opml"/>
      <outline isComment="true" text="Commented feeds">
        <outline type="rss" text="Commented" xmlUrl="https://commented.example.com/feed"/>
      </outline>
    </body></opml>
  `),
  );
  expect(parsed.feeds).toEqual([
    { title: 'Geometry & Algebra', url: 'https://public.example.com/feed?q=1&p=2' },
    { title: 'research.example.org', url: 'https://research.example.org/atom' },
  ]);
  expect(parsed.skipped.map(({ title, reason }) => [title, reason])).toEqual([
    ['Duplicate', 'duplicate'],
    ['Missing', 'missing-url'],
    ['HTTP', 'invalid-url'],
    ['Local', 'invalid-url'],
    ['Auth', 'invalid-url'],
    ['Private DNS suffix', 'invalid-url'],
    ['IPv6', 'invalid-url'],
    ['Website', 'unsupported-type'],
  ]);
  expect(requests).toEqual([]);
});

test('exports OPML 2.0 with escaped names and normalized feed URLs', async ({ page }) => {
  const result = await page.evaluate(() => {
    const xml = window.prismOpml.serializeLiteratureOpml([
      {
        title: 'A & B <Geometry> "quotes" \'apostrophe\' 📚',
        url: 'https://public.example.com/?q=1&p=2#part',
      },
      { title: 'Duplicate', url: 'https://public.example.com/?q=1&p=2' },
      { title: '\u0001', url: 'https://public.example.net/atom' },
    ]);
    return { xml, parsed: window.prismOpml.parseLiteratureOpml(xml) };
  });
  expect(result.xml).toContain('<opml version="2.0">');
  expect(result.xml).toContain('type="rss" xmlUrl="https://public.example.com/?q=1&amp;p=2"');
  expect(result.xml).toContain('&amp; B &lt;Geometry&gt; &quot;quotes&quot; &apos;apostrophe&apos; 📚');
  expect(result.parsed).toEqual({
    feeds: [
      { title: 'A & B <Geometry> "quotes" \'apostrophe\' 📚', url: 'https://public.example.com/?q=1&p=2' },
      { title: 'public.example.net', url: 'https://public.example.net/atom' },
    ],
    skipped: [],
  });
});

test('rejects DTDs, processing instructions, malformed files, and oversized or deeply nested input', async ({
  page,
}) => {
  const results = await page.evaluate(() => {
    const { parseLiteratureOpml, maxLiteratureOpmlBytes, maxLiteratureOpmlEntries } = window.prismOpml;
    const body = (xml: string) => '<opml><body>' + xml + '</body></opml>';
    return [
      '<!DOCTYPE opml [<!ENTITY title SYSTEM "https://example.com/entity">]>' + body(''),
      '<?xml-stylesheet href="https://example.com/style"?>' + body(''),
      '<opml><body></opml>',
      body('é'.repeat(maxLiteratureOpmlBytes / 2)),
      body('<outline>'.repeat(21) + '</outline>'.repeat(21)),
      body('<outline type="rss"/>'.repeat(maxLiteratureOpmlEntries + 1)),
    ].map((source) => {
      try {
        parseLiteratureOpml(source);
        return 'Opened';
      } catch (error) {
        return (error as Error).message;
      }
    });
  });
  expect(results).toEqual([
    'This OPML file contains unsupported XML declarations.',
    'This OPML file contains unsupported XML declarations.',
    'Choose a valid OPML file.',
    'Choose an OPML file no larger than 512 KiB.',
    'This OPML file contains too many nested outlines.',
    'This OPML file contains more than 200 subscriptions.',
  ]);
});

import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

let script: string;
test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd() + '/apps/web',
      contents: `export { strToU8, zipSync, unzipSync } from 'fflate';
        export { buildLiteratureOdtExport } from './lib/literature-odt';`,
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'prismOdt',
    platform: 'browser',
  });
  script = bundle.outputFiles[0]!.text;
});

test('preserves ODT parts, writes native Writer marks and an index, and keeps locators visible', async ({
  page,
}) => {
  await page.addScriptTag({ content: script });
  const output = await page.evaluate(() => {
    const { strToU8, zipSync, unzipSync, buildLiteratureOdtExport } = (
      window as Window & {
        prismOdt: {
          strToU8: (text: string) => Uint8Array;
          zipSync: (
            parts: Record<string, Uint8Array | [Uint8Array, { level: 0 }]>,
          ) => Uint8Array<ArrayBuffer>;
          unzipSync: (bytes: Uint8Array) => Record<string, Uint8Array>;
          buildLiteratureOdtExport: typeof import('../../apps/web/lib/literature-odt').buildLiteratureOdtExport;
        };
      }
    ).prismOdt;
    const office = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
    const text = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
    const manifest = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0';
    const mime = 'application/vnd.oasis.opendocument.text';
    const originalManifest = `<manifest:manifest xmlns:manifest="${manifest}"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
    const archive = (content: string, metadata = originalManifest) =>
      zipSync({
        mimetype: [strToU8(mime), { level: 0 }],
        'META-INF/manifest.xml': strToU8(metadata),
        'content.xml': strToU8(
          `<office:document-content xmlns:office="${office}" xmlns:text="${text}" office:version="1.3"><office:body><office:text>${content}</office:text></office:body></office:document-content>`,
        ),
        'Pictures/fixture.txt': strToU8('Keep this part.'),
      });
    const reference = {
      id: 'fixture',
      version: '1',
      kind: 'reference' as const,
      title: 'Synthetic Writer Source',
      authors: ['Example, Ada'],
      year: 2025,
      doi: null,
      arxiv_id: null,
      url: null,
      zotero_key: null,
      citation_key: 'canonical',
      citation_aliases: ['old'],
      publication: { type: 'book', pages: '1–90' },
    };
    const input = archive(
      '<text:p>A <text:span text:style-name="Sample">[[cite:old|12–14]]</text:span> and [[cite:missing]].</text:p><text:p>[[cite:<text:span>old</text:span>]]</text:p><text:p>[[bibliography]]</text:p>',
    );
    const output = buildLiteratureOdtExport(input.buffer, [reference]);
    const files = unzipSync(output.bytes!);
    const decode = (file: string) => new TextDecoder().decode(files[file]);
    const xml = new DOMParser().parseFromString(decode('content.xml'), 'application/xml');
    const entry = xml.getElementsByTagNameNS(text, 'bibliography-mark')[0];
    const index = xml.getElementsByTagNameNS(text, 'bibliography')[0];
    const packageView = new DataView(output.bytes!.buffer);
    const error = (callback: () => unknown) => {
      try {
        callback();
        return null;
      } catch (cause) {
        return (cause as Error).message;
      }
    };
    const result = {
      count: output.citations,
      bibliography: output.bibliography,
      missing: output.missing,
      skipped: output.skipped,
      entry: {
        key: entry.getAttributeNS(text, 'identifier'),
        type: entry.getAttributeNS(text, 'bibliography-type'),
        pages: entry.getAttributeNS(text, 'pages'),
        style: entry.parentElement?.getAttributeNS(text, 'style-name'),
      },
      visible: xml.getElementsByTagNameNS(text, 'p')[0].textContent,
      bibliographyText: index.textContent,
      mimetypeFirst: new TextDecoder().decode(output.bytes!.subarray(30, 38)) === 'mimetype',
      mimetypeStored: packageView.getUint16(8, true) === 0,
      manifestPreserved: decode('META-INF/manifest.xml') === originalManifest,
      retained: decode('Pictures/fixture.txt'),
      invalid: error(() =>
        buildLiteratureOdtExport(archive('<!DOCTYPE x><text:p>[[cite:old]]</text:p>').buffer, [reference]),
      ),
      encrypted: error(() =>
        buildLiteratureOdtExport(
          archive(
            '<text:p>[[cite:old]]</text:p>',
            originalManifest.replace(
              '</manifest:manifest>',
              '<manifest:encryption-data/></manifest:manifest>',
            ),
          ).buffer,
          [reference],
        ),
      ),
    };
    return result;
  });
  expect(output).toMatchObject({
    count: 1,
    bibliography: true,
    missing: ['missing'],
    skipped: 1,
    entry: { key: 'canonical', type: 'book', pages: '1–90', style: 'Sample' },
    visible: 'A [canonical] (pp. 12–14) and [[cite:missing]].',
    bibliographyText: expect.stringContaining('Synthetic Writer Source'),
    mimetypeFirst: true,
    mimetypeStored: true,
    manifestPreserved: true,
    retained: 'Keep this part.',
    invalid: 'The OpenDocument contains unsupported XML declarations.',
    encrypted: 'Unlock the ODT before exporting.',
  });
});

import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

let script: string;
test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd() + '/apps/web',
      contents: `export { strToU8, zipSync, unzipSync } from 'fflate';
        export { buildLiteratureDocxExport } from './lib/literature-docx';`,
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'prismDocx',
    platform: 'browser',
  });
  script = bundle.outputFiles[0]!.text;
});

test('writes native Word citation fields and preserves unrelated parts', async ({ page }) => {
  await page.addScriptTag({ content: script });
  const output = await page.evaluate(() => {
    const { zipSync, strToU8, unzipSync, buildLiteratureDocxExport } = (
      window as Window & {
        prismDocx: {
          zipSync: (files: Record<string, Uint8Array>) => Uint8Array<ArrayBuffer>;
          strToU8: (text: string) => Uint8Array;
          unzipSync: (bytes: Uint8Array) => Record<string, Uint8Array>;
          buildLiteratureDocxExport: typeof import('../../apps/web/lib/literature-docx').buildLiteratureDocxExport;
        };
      }
    ).prismDocx;
    const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const bibliography = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography';
    const parts = {
      '[Content_Types].xml':
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels':
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml': `<w:document xmlns:w="${word}"><w:body><w:p><w:r><w:rPr><w:i/></w:rPr><w:t>As in [[cite:old-key|12–14]] and [[cite:absent]].</w:t></w:r></w:p><w:p><w:r><w:t>[[cite:old-</w:t></w:r><w:r><w:t>key]]</w:t></w:r></w:p><w:p><w:r><w:t>[[bibliography]]</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
      'docProps/fixture.xml': '<fixture>Preserve these bytes.</fixture>',
    };
    const input = zipSync(
      Object.fromEntries(Object.entries(parts).map(([path, xml]) => [path, strToU8(xml)])),
    );
    const references = [
      {
        id: '22222222-2222-2222-2222-222222222222',
        kind: 'reference' as const,
        version: '1',
        title: 'Synthetic citation book',
        authors: ['Example, Ada'],
        year: 2025,
        doi: null,
        arxiv_id: null,
        url: null,
        zotero_key: null,
        citation_key: 'new-key',
        citation_aliases: ['old-key'],
        publication: { type: 'book', publisher: 'Example Press' },
      },
    ];
    const converted = buildLiteratureDocxExport(input.buffer, references);
    const archive = unzipSync(converted.bytes!);
    const text = (part: string) => new TextDecoder().decode(archive[part]);
    const read = (part: string) => new DOMParser().parseFromString(text(part), 'application/xml');
    const main = read('word/document.xml');
    const fields = Array.from(main.getElementsByTagNameNS(word, 'fldSimple'), (node) => ({
      instruction: node.getAttributeNS(word, 'instr'),
      text: node.textContent,
      italic: node.getElementsByTagNameNS(word, 'i').length > 0,
    }));
    const sources = read('customXml/item1.xml');
    const markerText = main.documentElement.textContent;
    const nextParagraph = main.createElementNS(word, 'w:p');
    const nextRun = main.createElementNS(word, 'w:r');
    const nextText = main.createElementNS(word, 'w:t');
    nextText.textContent = 'New marker [[cite:new-key]]';
    nextRun.append(nextText);
    nextParagraph.append(nextRun);
    const body = main.getElementsByTagNameNS(word, 'body')[0];
    body.insertBefore(nextParagraph, body.lastElementChild);
    // Remove the unsupported and unmatched markers to isolate the repeat export.
    body.removeChild(body.children[1]);
    archive['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(main));
    const updated = buildLiteratureDocxExport(zipSync(archive).buffer, references);
    const updatedArchive = unzipSync(updated.bytes!);
    const updatedSources = new DOMParser().parseFromString(
      new TextDecoder().decode(updatedArchive['customXml/item1.xml']),
      'application/xml',
    );
    return {
      result: { ...converted, bytes: Boolean(converted.bytes) },
      fields,
      sourceTag: sources.getElementsByTagNameNS(bibliography, 'Tag')[0]?.textContent,
      sourceTitle: sources.getElementsByTagNameNS(bibliography, 'Title')[0]?.textContent,
      props: text('customXml/itemProps1.xml'),
      docRels: text('word/_rels/document.xml.rels'),
      propsRels: text('customXml/_rels/item1.xml.rels'),
      parts: text('[Content_Types].xml'),
      markerText,
      packageRelsPreserved: text('_rels/.rels') === parts['_rels/.rels'],
      unchanged: text('docProps/fixture.xml') === parts['docProps/fixture.xml'],
      updatedSources: updatedSources.getElementsByTagNameNS(bibliography, 'Source').length,
      updatedBibliography: updated.bibliography,
    };
  });
  expect(output.result).toEqual({
    citations: 1,
    skipped: 1,
    missing: ['absent'],
    ambiguous: [],
    bibliography: true,
    bytes: true,
  });
  expect(output.fields).toEqual([
    {
      instruction: ` CITATION ${output.sourceTag} \\p "12–14" \\l 1033 `,
      text: '(Example, 2025, pp. 12–14)',
      italic: true,
    },
    {
      instruction: ' BIBLIOGRAPHY \\l 1033 ',
      text: expect.stringContaining('Synthetic citation book'),
      italic: false,
    },
  ]);
  expect(output.sourceTitle).toBe('Synthetic citation book');
  expect(output.markerText).toContain('[[cite:old-key]]');
  expect(output.markerText).toContain('[[cite:absent]]');
  expect(output.props).toContain('schemaRef');
  expect(output.docRels).toContain('Target="../customXml/item1.xml"');
  expect(output.propsRels).toContain('Target="itemProps1.xml"');
  expect(output.parts).toContain('PartName="/customXml/itemProps1.xml"');
  expect(output.packageRelsPreserved).toBe(true);
  expect(output.unchanged).toBe(true);
  expect(output.updatedSources).toBe(1);
  expect(output.updatedBibliography).toBe(true);
});

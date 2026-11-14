import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import type { parseLiteratureEpub } from '../../apps/web/lib/literature-epub';
import { literatureEpubFixture } from './epub-fixture';

declare global {
  interface Window {
    prismEpub: { parseLiteratureEpub: typeof parseLiteratureEpub };
    epubScriptExecuted?: boolean;
  }
}

let parserScript: string;

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ['apps/web/lib/literature-epub.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'prismEpub',
    platform: 'browser',
  });
  parserScript = bundle.outputFiles[0]!.text;
});

test.beforeEach(async ({ page }) => {
  await page.addScriptTag({ content: parserScript });
});

test('opens EPUB metadata and local chapters in spine order without loading embedded resources', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const result = await page.evaluate(
    async (bytes) => {
      const book = await window.prismEpub.parseLiteratureEpub(Uint8Array.from(bytes));
      return { book, scriptExecuted: window.epubScriptExecuted ?? false };
    },
    [...literatureEpubFixture()],
  );

  expect(result.book).toMatchObject({
    title: 'Synthetic algebra reader',
    authors: ['Example, Ada'],
    language: 'en',
    sections: [
      {
        title: 'Foundations',
        blocks: [
          { kind: 'heading', text: 'Foundations', level: 1 },
          { kind: 'quote', text: 'A synthetic quotation.' },
          { kind: 'paragraph', text: 'Choose a ring\nwith identity. [Identity diagram]' },
        ],
      },
      {
        title: 'Applications',
        blocks: [
          { kind: 'heading', text: 'Applications', level: 1 },
          { kind: 'paragraph', text: 'Apply the theorem to quotient rings.' },
          { kind: 'list-item', text: 'First example.' },
          { kind: 'code', text: 'let x = 1;\n  x += 2;' },
        ],
      },
    ],
  });
  expect(result.scriptExecuted).toBe(false);
  expect(requests).toEqual([]);
});

test('rejects unsupported XML declarations, damaged content, excessive text, and aborted reads', async ({
  page,
}) => {
  const corrupt = literatureEpubFixture();
  // The fixture writes the stored mimetype as the first ZIP entry.
  corrupt[30 + 'mimetype'.length] ^= 1;
  const externalEntity = literatureEpubFixture({
    'Text/chapter.xhtml':
      '<!DOCTYPE html [<!ENTITY e SYSTEM "https://example.test/entity">]><html><body><p>&e;</p></body></html>',
  });
  const oversized = literatureEpubFixture({
    'Text/chapter.xhtml': '<html><body>' + 'x'.repeat(2 * 1024 * 1024) + '</body></html>',
  });
  const falseSize = Buffer.from(oversized);
  const filename = 'Text/chapter.xhtml';
  let entry = falseSize.readUInt32LE(falseSize.length - 6);
  while (
    falseSize.toString('utf8', entry + 46, entry + 46 + falseSize.readUInt16LE(entry + 28)) !== filename
  ) {
    entry +=
      46 +
      falseSize.readUInt16LE(entry + 28) +
      falseSize.readUInt16LE(entry + 30) +
      falseSize.readUInt16LE(entry + 32);
  }
  falseSize.writeUInt32LE(16, entry + 24);
  const messages = await page.evaluate(
    async ({ files, valid }) => {
      const read = async (bytes: number[], signal?: AbortSignal) => {
        try {
          await window.prismEpub.parseLiteratureEpub(Uint8Array.from(bytes).buffer, signal);
          return 'Opened';
        } catch (error) {
          return (error as Error).message;
        }
      };
      const results = await Promise.all(files.map((file) => read(file)));
      const controller = new AbortController();
      controller.abort(new Error('Stopped reading'));
      results.push(await read(valid, controller.signal));
      return results;
    },
    {
      files: [corrupt, externalEntity, oversized, falseSize].map((file) => [...file]),
      valid: [...literatureEpubFixture()],
    },
  );

  expect(messages).toEqual([
    'This EPUB contains an invalid ZIP archive.',
    'This EPUB contains unsupported XML declarations.',
    'This EPUB contains too much text to open.',
    'This EPUB contains an invalid ZIP archive.',
    'Stopped reading',
  ]);
});

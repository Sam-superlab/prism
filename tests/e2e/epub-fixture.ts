import { createRequire } from 'node:module';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { zipSync, strToU8 } = webRequire('fflate') as {
  zipSync: (files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]>) => Uint8Array;
  strToU8: (text: string) => Uint8Array;
};

const container =
  '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const book =
  '<package version="3.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Synthetic algebra reader</dc:title><dc:creator>Example, Ada</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="first" href="chapter%201.xhtml" media-type="application/xhtml+xml"/><item id="second" href="../Text/chapter.xhtml" media-type="application/xhtml+xml"/><item id="remote" href="https://example.test/remote.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="second"/><itemref idref="remote"/><itemref idref="first"/></spine></package>';
const chapterOne =
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Algebraic applications</title></head><body><h1>Applications</h1><p>Apply the theorem to <em>quotient rings</em>.</p><ol><li>First example.</li></ol><pre>let x = 1;\n  x += 2;</pre></body></html>';
const chapterTwo =
  '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Basics</title><link rel="stylesheet" href="https://example.test/style.css"/></head><body><h1>Foundations</h1><script>window.epubScriptExecuted = true</script><iframe src="https://example.test/frame"/><blockquote><p>A synthetic quotation.</p></blockquote><p>Choose a <em>ring</em><br/>with identity.<img src="https://example.test/image" alt="Identity diagram"/></p></body></html>';

export function literatureEpubFixture(overrides: Record<string, string> = {}) {
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(container),
    'OPS/book.opf': strToU8(book),
    'OPS/chapter 1.xhtml': strToU8(chapterOne),
    'Text/chapter.xhtml': strToU8(chapterTwo),
  };
  for (const [name, content] of Object.entries(overrides)) files[name] = strToU8(content);
  return Buffer.from(zipSync(files));
}

import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const source = fileURLToPath(new URL('../apps/browser-capture/', import.meta.url));
const output = join(source, 'dist');
await mkdir(output, { recursive: true });
await Promise.all([
  ...['manifest.json', 'popup.html', 'popup.css', 'popup.js'].map((name) =>
    copyFile(join(source, name), join(output, name)),
  ),
  ...['capture', 'snapshot'].map((name) =>
    build({
      entryPoints: [join(source, `${name}.ts`)],
      outfile: join(output, `${name}.js`),
      bundle: true,
      format: 'iife',
      globalName: 'prismBrowserCapture',
      footer: { js: 'prismBrowserCapture.collect();' },
      platform: 'browser',
      target: ['chrome102', 'firefox140'],
      minify: true,
    }),
  ),
]);
console.log(`Load the unpacked extension from ${output}`);

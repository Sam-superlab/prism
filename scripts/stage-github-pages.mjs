import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = new URL('../site/', import.meta.url);
const files = ['.nojekyll', 'README.md', 'index.html', 'styles.css', 'links.js', 'prism-mark.svg'];
const [repository, tag, destination = 'output/macos/github-pages-preview', ...extra] = process.argv.slice(2);

if (
  !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/(?!\.{1,2}$)[a-z\d_.-]{1,100}$/i.test(repository ?? '') ||
  !/^v\d+\.\d+\.\d+(?:-[a-z\d-]+(?:\.[a-z\d-]+)*)?$/i.test(tag ?? '') ||
  !destination ||
  extra.length
) {
  throw new Error('Usage: node scripts/stage-github-pages.mjs OWNER/REPO v0.2.0-preview.1 [new-folder]');
}

function setMetadata(html, name, value) {
  const placeholder = `<meta name="${name}" content="">`;
  if (html.split(placeholder).length !== 2) throw new Error(`Expected one empty ${name} metadata value.`);
  return html.replace(placeholder, `<meta name="${name}" content="${value}">`);
}

const contents = await Promise.all(
  files.map(async (name) => {
    const file = new URL(name, source);
    if (!(await lstat(file)).isFile())
      throw new Error(`Expected a regular site file: ${fileURLToPath(file)}`);
    const content = await readFile(file);
    if (name !== 'index.html') return content;
    const html = setMetadata(
      content.toString('utf8'),
      'prism-repository',
      `https://github.com/${repository}`,
    );
    return setMetadata(html, 'prism-release-tag', tag);
  }),
);

const output = resolve(destination);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
await Promise.all(
  files.map((name, index) => writeFile(resolve(output, name), contents[index], { flag: 'wx' })),
);
console.log(`Staged ${files.length} public website files at ${output}`);

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const [bundlePath, workspacePath] = process.argv.slice(2);
if (!bundlePath || !workspacePath)
  throw new Error('Usage: node scripts/collect-macos-notices.mjs PRISM.app STAGED_WORKSPACE');

const workspace = realpathSync(workspacePath);
const resources = resolve(bundlePath, 'Contents/Resources');
const licenses = join(resources, 'licenses');
if (!existsSync(join(licenses, 'Node.js.txt')))
  throw new Error('The Node.js distribution notice must be copied before collecting package notices.');

function manifestAt(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
}

function installedPackages(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile() || entry.name !== 'package.json') return false;
      const parent = dirname(entry.parentPath);
      return (
        basename(parent) === 'node_modules' ||
        (basename(parent).startsWith('@') && basename(dirname(parent)) === 'node_modules')
      );
    })
    .map((entry) => entry.parentPath);
}

const identity = (manifest) => `${manifest.name}@${manifest.version}`;
const thirdParty = ({ name, version }) =>
  typeof name === 'string' && typeof version === 'string' && !name.startsWith('@prism/');

function addPackage(index, directory, manifest) {
  if (!thirdParty(manifest)) return;
  const name = identity(manifest);
  const entry = index.get(name) ?? { directories: new Set(), manifest };
  entry.directories.add(realpathSync(directory));
  index.set(name, entry);
  return entry;
}

const installed = new Map();
for (const directory of installedPackages(join(workspace, 'node_modules')))
  addPackage(installed, directory, manifestAt(directory));

const distributed = new Map();
function include(directory, manifest) {
  const entry = addPackage(distributed, directory, manifest);
  if (!entry) return;
  for (const source of installed.get(identity(manifest))?.directories ?? []) entry.directories.add(source);
}

for (const directory of installedPackages(join(resources, 'desktop'))) {
  include(directory, manifestAt(directory));
}

function resolvePackage(directory, name) {
  for (let current = directory; ; current = dirname(current)) {
    const target = join(current, 'node_modules', name);
    if (existsSync(join(target, 'package.json'))) {
      const resolved = realpathSync(target);
      const path = relative(workspace, resolved);
      if (path === '..' || path.startsWith('../') || isAbsolute(path))
        throw new Error(`Package ${name} resolves outside the staged workspace.`);
      return resolved;
    }
    if (current === workspace) return;
  }
}

// The standalone trace omits packages already compiled into client or server chunks.
const visited = new Set();
function includeWebDependencies(directory) {
  if (visited.has(directory)) return;
  visited.add(directory);
  const manifest = manifestAt(directory);
  include(directory, manifest);
  const peers = Object.keys(manifest.peerDependencies ?? {}).filter(
    (name) => !manifest.peerDependenciesMeta?.[name]?.optional,
  );
  // Optional native and build-time packages are inventoried only if shipped in the bundle.
  for (const name of [...Object.keys(manifest.dependencies ?? {}), ...peers]) {
    const target = resolvePackage(directory, name);
    if (target) includeWebDependencies(target);
  }
}
includeWebDependencies(join(workspace, 'apps/web'));

const noticeName =
  /(?:^|\.)(?:licen[cs]es?|copying|copyright|notice|third[-_ ]party[-_ ](?:licen[cs]es?|notices?))(?:$|[._-])/i;
const executableExtension = /\.(?:[cm]?js|ts|jsx|tsx|map|html|css)$/i;

function collectNotices(directory) {
  const notices = new Map();
  function scan(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') scan(path);
      if (entry.isFile() && noticeName.test(entry.name) && !executableExtension.test(entry.name)) {
        const bytes = readFileSync(path);
        const key = bytes.toString('base64');
        if (!notices.has(key)) notices.set(key, { name: relative(directory, path), bytes });
      }
    }
  }
  scan(directory);
  if (notices.size) return [...notices.values()];

  for (const name of ['README.md', 'readme.md', 'README']) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    const section = readFileSync(path, 'utf8').match(
      /^#{1,6}[ \t]+(?:licen[cs]e|copyright)\b[^\r\n]*\r?\n[\s\S]*?(?=^#{1,6}[ \t]+|(?![\s\S]))/im,
    )?.[0];
    if (section) return [{ name: `${name} (license section)`, bytes: Buffer.from(section) }];
  }
  return [];
}

function nextMonorepoNotice(manifest) {
  if (manifest.name !== '@next/env' && !manifest.name.startsWith('@next/swc-')) return [];
  if (manifest.repository?.url !== 'https://github.com/vercel/next.js') return [];
  const next = distributed.get(`next@${manifest.version}`);
  if (!next) return [];
  for (const directory of next.directories) {
    const path = join(directory, 'license.md');
    if (existsSync(path))
      return [{ name: `Next.js v${manifest.version} monorepo license.md`, bytes: readFileSync(path) }];
  }
  return [];
}

function collectPackageNotices(entry) {
  const notices = new Map();
  // A standalone trace can omit notices from one copy of a package that another copy retains.
  for (const directory of entry.directories) {
    for (const notice of collectNotices(directory)) {
      const key = notice.bytes.toString('base64');
      if (!notices.has(key)) notices.set(key, notice);
    }
  }
  return [...notices.values()];
}

function nativePackageNotice(manifest) {
  const parentName = manifest.name.startsWith('@esbuild/')
    ? 'esbuild'
    : manifest.name.startsWith('@msgpackr-extract/msgpackr-extract-')
      ? 'msgpackr-extract'
      : undefined;
  if (!parentName || !manifest.repository?.url || !manifest.license) return [];
  const parent = distributed.get(`${parentName}@${manifest.version}`);
  if (
    !parent ||
    parent.manifest.repository?.url !== manifest.repository.url ||
    parent.manifest.license !== manifest.license ||
    parent.manifest.optionalDependencies?.[manifest.name] !== manifest.version
  )
    return [];
  return collectPackageNotices(parent).map(({ name, bytes }) => ({
    name: `${parentName}@${manifest.version} platform package notice, ${name}`,
    bytes,
  }));
}

const missing = [];
const sections = [Buffer.from('PRISM desktop third-party notices\nNode.js notices are in Node.js.txt.\n')];
for (const [name, entry] of [...distributed].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  const { manifest } = entry;
  const license = typeof manifest.license === 'string' ? manifest.license : 'See package documentation';
  sections.push(Buffer.from(`\n=== ${name} ===\nDeclared license: ${license}\n`));
  let notices = collectPackageNotices(entry);
  if (!notices.length) notices = nextMonorepoNotice(manifest);
  if (!notices.length) notices = nativePackageNotice(manifest);
  if (!notices.length) {
    missing.push(name);
    sections.push(Buffer.from('No separate license notice was present in the installed package.\n'));
  }
  for (const notice of notices) {
    sections.push(Buffer.from(`\n--- ${notice.name} ---\n`), notice.bytes, Buffer.from('\n'));
  }
}

mkdirSync(licenses, { recursive: true });
writeFileSync(join(licenses, 'Third-party packages.txt'), Buffer.concat(sections));
console.log(`Collected notices for ${distributed.size} packages.`);
if (missing.length) console.warn(`Packages without a separate license notice: ${missing.join(', ')}`);

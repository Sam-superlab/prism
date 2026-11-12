import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const sourceArchive = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(sourceArchive))
  throw new Error('Usage: node scripts/package-windows.mjs VERIFIED_MAC_PUBLIC_ZIP [OUTPUT_DIRECTORY]');
const output = resolve(process.argv[3] ?? 'output/windows');
const temp = mkdtempSync(join(tmpdir(), 'prism-windows-'));
const app = join(temp, 'PRISM');
const resources = join(app, 'resources');
const shell = join(resources, 'app');
const electronVersion = '45.3.0';
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const copy = (source, destination, dereference = false) => {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference, verbatimSymlinks: !dereference });
};
async function verifiedArchive(base, name, destination) {
  const [archiveResponse, sumsResponse] = await Promise.all(
    [name, 'SHASUMS256.txt'].map((file) => fetch(base + file, { signal: AbortSignal.timeout(180000) })),
  );
  if (!archiveResponse.ok || !sumsResponse.ok) throw new Error(`Could not download ${name}.`);
  const sum = (await sumsResponse.text())
    .split('\n')
    .find((line) => line.trim().endsWith(name))
    ?.slice(0, 64);
  const bytes = Buffer.from(await archiveResponse.arrayBuffer());
  if (!sum || createHash('sha256').update(bytes).digest('hex') !== sum)
    throw new Error(`Checksum mismatch for ${name}.`);
  const archive = join(temp, name);
  writeFileSync(archive, bytes);
  run('ditto', ['-x', '-k', archive, destination]);
}
async function installEsbuild(directory, version) {
  const unpacked = join(temp, `esbuild-${version}`);
  if (!existsSync(unpacked)) {
    const metadataResponse = await fetch(`https://registry.npmjs.org/@esbuild/win32-x64/${version}`);
    if (!metadataResponse.ok) throw new Error('Windows esbuild metadata could not be fetched.');
    const metadata = await metadataResponse.json();
    if (!metadata.dist?.tarball?.startsWith('https://registry.npmjs.org/'))
      throw new Error('Unexpected esbuild source.');
    const bytes = Buffer.from(await (await fetch(metadata.dist.tarball)).arrayBuffer());
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    if (integrity !== metadata.dist.integrity) throw new Error('Windows esbuild checksum mismatch.');
    const archive = join(temp, `esbuild-${version}.tgz`);
    writeFileSync(archive, bytes);
    mkdirSync(unpacked);
    run('tar', ['-xzf', archive, '-C', unpacked]);
  }
  const target = join(directory, 'node_modules/@esbuild/win32-x64');
  copy(join(unpacked, 'package'), target);
}
try {
  const nativeDownloads = Promise.all([
    verifiedArchive(
      `https://github.com/electron/electron/releases/download/v${electronVersion}/`,
      `electron-v${electronVersion}-win32-x64.zip`,
      app,
    ),
    verifiedArchive(
      `https://nodejs.org/dist/${process.version}/`,
      `node-${process.version}-win-x64.zip`,
      join(temp, 'node'),
    ),
  ]);
  nativeDownloads.catch(() => {});
  const mac = join(temp, 'mac');
  run('ditto', ['-x', '-k', sourceArchive, mac]);
  const source = join(mac, 'PRISM.app/Contents/Resources');
  const plist = execFileSync(
    'plutil',
    ['-convert', 'json', '-o', '-', join(mac, 'PRISM.app/Contents/Info.plist')],
    { encoding: 'utf8' },
  );
  const manifest = JSON.parse(plist);
  if (
    !manifest.PRISMPackaged ||
    manifest.PRISMProjectRoot ||
    !/^\d+\.\d+\.\d+$/.test(manifest.CFBundleVersion)
  )
    throw new Error('Windows packaging requires a clean public Mac distribution.');
  const version = process.env.PRISM_WINDOWS_RELEASE_VERSION ?? manifest.CFBundleVersion;
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version))
    throw new Error('Use a numeric Windows release version such as 0.2.6.');
  const updatePublicKey = Buffer.from(manifest.SUPublicEDKey ?? '', 'base64');
  if (updatePublicKey.length !== 32 || updatePublicKey.toString('base64') !== manifest.SUPublicEDKey)
    throw new Error('The public Mac package must include its canonical Ed25519 update key.');
  await nativeDownloads;
  renameSync(join(app, 'electron.exe'), join(app, 'PRISM.exe'));
  rmSync(join(resources, 'default_app.asar'), { force: true });
  copy(join(temp, 'node', `node-${process.version}-win-x64/node.exe`), join(resources, 'runtime/node.exe'));
  copy(
    join(temp, 'node', `node-${process.version}-win-x64/LICENSE`),
    join(resources, 'licenses/Node.js.txt'),
  );
  copy(join(source, 'licenses'), join(resources, 'licenses'));
  // Copy product files without platform-dependent package-manager links.
  const runtime = join(resources, 'desktop');
  cpSync(join(source, 'desktop'), runtime, {
    recursive: true,
    filter: (path) => !path.split('/').includes('node_modules'),
  });
  const esbuildDirs = [];
  function materializeModules(sourceRoot, targetRoot) {
    if (!existsSync(sourceRoot)) return;
    mkdirSync(targetRoot, { recursive: true });
    const installed = new Map();
    function names(root) {
      return readdirSync(root)
        .filter((name) => !name.startsWith('.'))
        .flatMap((name) =>
          name.startsWith('@') ? readdirSync(join(root, name)).map((child) => `${name}/${child}`) : [name],
        );
    }
    function resolveDependency(directory, name) {
      for (let current = directory; ; current = dirname(current)) {
        const candidate = join(current, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
        if (current === dirname(current)) return;
      }
    }
    function install(sourceDirectory, target, ancestors = new Map()) {
      const actual = realpathSync(sourceDirectory);
      const manifestFile = join(actual, 'package.json');
      if (!existsSync(manifestFile)) return;
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      const identity = `${manifest.name}@${manifest.version}`;
      if (ancestors.get(manifest.name) === identity) return;
      if (existsSync(join(target, 'package.json'))) return;
      mkdirSync(dirname(target), { recursive: true });
      cpSync(actual, target, {
        recursive: true,
        dereference: true,
        filter: (path) => !path.slice(actual.length).split('/').includes('node_modules'),
      });
      if (manifest.name === 'esbuild') esbuildDirs.push(target);
      const nextAncestors = new Map(ancestors).set(manifest.name, identity);
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      };
      for (const name of Object.keys(dependencies)) {
        const dependency = resolveDependency(actual, name);
        if (!dependency) continue; // Standalone traces omit build-only and unused optional dependencies.
        const depManifest = JSON.parse(readFileSync(join(dependency, 'package.json'), 'utf8'));
        const depIdentity = `${depManifest.name}@${depManifest.version}`;
        if (nextAncestors.get(depManifest.name) === depIdentity) continue;
        const rootTarget = join(targetRoot, name);
        const known = installed.get(name);
        if (!known) installed.set(name, depIdentity);
        const dependencyTarget =
          !known || known === depIdentity ? rootTarget : join(target, 'node_modules', name);
        install(dependency, dependencyTarget, nextAncestors);
      }
    }
    // Reserve direct dependencies before hoisting transitive dependencies.
    const direct = names(sourceRoot).filter((name) => existsSync(join(sourceRoot, name, 'package.json')));
    for (const name of direct) {
      const manifest = JSON.parse(readFileSync(join(sourceRoot, name, 'package.json'), 'utf8'));
      installed.set(name, `${manifest.name}@${manifest.version}`);
    }
    for (const name of direct) install(join(sourceRoot, name), join(targetRoot, name));
  }
  for (const subpath of ['apps/api/node_modules', 'web/node_modules', 'web/apps/web/node_modules'])
    materializeModules(join(source, 'desktop', subpath), join(runtime, subpath));
  const databaseSource = realpathSync(join(source, 'desktop/apps/api/node_modules/@prism/database'));
  copy(resolve(databaseSource, '../../database'), join(runtime, 'apps/api/node_modules/database'));
  for (const directory of esbuildDirs) {
    const version = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version;
    await installEsbuild(directory, version);
  }
  for (const entry of readdirSync(runtime, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory() && /^(?:darwin-(?:arm64|x64)|swc-darwin-)/.test(entry.name))
      rmSync(join(entry.parentPath, entry.name), { recursive: true, force: true });
  }
  mkdirSync(shell, { recursive: true });
  for (const name of [
    'main.cjs',
    'launch.mjs',
    'service.mjs',
    'loading.html',
    'updater.cjs',
    'update-helper.cjs',
    'focus-preload.cjs',
    'focus-desktop.cjs',
  ])
    copy(join(repo, 'apps/windows', name), join(shell, name));
  writeFileSync(
    join(shell, 'update-config.json'),
    JSON.stringify(
      {
        feedUrl: 'https://sam-superlab.github.io/prism/windows-update.json',
        publicKey: manifest.SUPublicEDKey,
      },
      null,
      2,
    ) + '\n',
  );
  copy(join(repo, 'apps/windows/app-package.json'), join(shell, 'package.json'));
  copy(join(repo, 'apps/web/public/app-icon.png'), join(shell, 'app-icon.png'));
  const shellManifest = JSON.parse(readFileSync(join(shell, 'package.json'), 'utf8'));
  shellManifest.version = version;
  writeFileSync(join(shell, 'package.json'), JSON.stringify(shellManifest, null, 2) + '\n');
  writeFileSync(
    join(app, 'README.txt'),
    `PRISM ${version} for Windows x64\r\n\r\nExtract the entire ZIP, then open PRISM.exe. Keep the files beside PRISM.exe together.\r\nRequires Windows 10 or Windows 11 (64-bit x64).\r\nYour notes, settings, and logs are in %APPDATA%\\PRISM Desktop. Keep that folder when updating the app.\r\nChoose File > Check for Updates to download and install signed updates. PRISM will close and reopen during installation.\r\nThis preview is unsigned. Windows may show a first-launch security prompt.\r\n`,
  );
  const forbidden = readdirSync(app, { recursive: true, withFileTypes: true }).filter((entry) =>
    ['.git', '.data', '.env', '.env.local', 'PG_VERSION', 'postmaster.pid'].includes(entry.name),
  );
  if (forbidden.length) throw new Error('The Windows bundle contains workspace files.');
  const inventory = readdirSync(app, { recursive: true, withFileTypes: true });
  if (inventory.some((entry) => !entry.isFile() && !entry.isDirectory()))
    throw new Error('The portable Windows package must contain only ordinary files and directories.');
  const entryPath = (entry) =>
    join(entry.parentPath, entry.name)
      .slice(app.length + 1)
      .replaceAll('\\', '/');
  writeFileSync(
    join(app, 'prism-install.json'),
    JSON.stringify(
      {
        format: 'prism-portable-v1',
        version,
        files: inventory
          .filter((entry) => entry.isFile())
          .map(entryPath)
          .sort(),
        directories: inventory
          .filter((entry) => entry.isDirectory())
          .map(entryPath)
          .sort(),
      },
      null,
      2,
    ) + '\n',
  );
  mkdirSync(output, { recursive: true });
  const archive = join(output, 'PRISM-Windows-x64.zip');
  run('ditto', ['-c', '-k', '--norsrc', '--keepParent', app, archive]);
  console.log(`Packaged PRISM ${version}: ${archive}`);
  console.log(`SHA-256 ${createHash('sha256').update(readFileSync(archive)).digest('hex')}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

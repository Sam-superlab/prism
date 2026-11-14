import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ubuntu = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '';
if (
  process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '24' ||
  !/^ID=ubuntu$/m.test(ubuntu) || !/^VERSION_ID="24\.04"$/m.test(ubuntu)
) throw new Error('Use Ubuntu 24.04 x86-64 and Node.js 24 to package PRISM for Linux.');

const repo = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(repo, process.argv[2] ?? 'output/linux/prism-literature-preview');
const version = process.env.PRISM_LINUX_PREVIEW_VERSION ?? '0.2.5';
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version))
  throw new Error('Use a numeric preview version such as 0.2.5.');
const electronVersion = '45.3.0';
const temp = mkdtempSync(join(tmpdir(), 'prism-linux-'));
const stage = join(temp, 'source');
const packageRoot = join(temp, 'package');
const app = join(packageRoot, 'opt/prism-preview');
const resources = join(app, 'resources');
const shell = join(resources, 'app');
const runtime = join(resources, 'desktop');
const api = join(runtime, 'apps/api');
const filename = 'PRISM-Literature-Preview-linux-amd64.deb';
const buildEnvironment = {
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(':'),
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  NEXT_TELEMETRY_DISABLED: '1',
};
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });

function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}

function stageSources() {
  const sources = [
    'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json',
    ...['api', 'mobile', 'web', 'worker'].map((name) => `apps/${name}/package.json`),
    ...['api-client', 'core', 'database', 'fsrs', 'planner', 'shared-utils', 'types'].flatMap((name) =>
      [`packages/${name}/package.json`, `packages/${name}/src`],
    ),
    ...['app', 'components', 'lib', 'next.config.ts', 'tsconfig.json', 'public/app-icon.png', 'public/prism-mark.svg']
      .map((file) => `apps/web/${file}`),
    ...['app.ts', 'config.ts', 'developer-literature.ts', 'errors.ts', 'local-workspace-backup.ts',
      'open-access-pdf.ts', 'reference-lookup.ts', 'server.ts', 'service.ts'].map((file) => `apps/api/src/${file}`),
    'apps/worker/src',
  ];
  for (const source of sources) copy(join(repo, source), join(stage, source));
}

async function verifiedArchive(base, name) {
  const [archive, sums] = await Promise.all([name, 'SHASUMS256.txt'].map((file) =>
    fetch(base + file, { signal: AbortSignal.timeout(180000) }),
  ));
  if (!archive.ok || !sums.ok) throw new Error(`Could not download ${name}.`);
  const expected = (await sums.text()).split('\n')
    .map((line) => line.match(/^([a-f0-9]{64})\s+\*?(\S+)\s*$/))
    .find((match) => match?.[2] === name)?.[1];
  const bytes = Buffer.from(await archive.arrayBuffer());
  if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error(`Checksum mismatch for ${name}.`);
  const path = join(temp, name);
  writeFileSync(path, bytes);
  return path;
}

function assembleRuntime() {
  const web = join(stage, 'apps/web/.next');
  copy(join(web, 'standalone'), join(runtime, 'web'));
  copy(join(web, 'static'), join(runtime, 'web/apps/web/.next/static'));
  copy(join(stage, 'apps/web/public'), join(runtime, 'web/apps/web/public'));
  const webStore = join(runtime, 'web/node_modules/.pnpm');
  for (const entry of readdirSync(webStore)) {
    if (/^(?:sharp@|@img\+)/.test(entry)) rmSync(join(webStore, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(webStore, { recursive: true, withFileTypes: true })) {
    if (entry.name === '@img' || (entry.name === 'sharp' && entry.isSymbolicLink()))
      rmSync(join(entry.parentPath, entry.name), { recursive: true, force: true });
  }
  run('pnpm', ['--filter', '@prism/api', 'deploy', '--prod', '--legacy', api], { cwd: stage, env: buildEnvironment });
  rmSync(join(api, 'node_modules/.modules.yaml'), { force: true });
  rmSync(join(api, 'node_modules/.pnpm/node_modules/@prism/api'), { force: true });
  const database = resolve(realpathSync(join(api, 'node_modules/@prism/database')), '../../database');
  copy(join(repo, 'database/schema.sql'), join(database, 'schema.sql'));
  for (const name of readdirSync(join(repo, 'database/migrations')).filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)))
    copy(join(repo, 'database/migrations', name), join(database, 'migrations', name));
  copy(join(repo, 'docs/api/openapi.json'), join(runtime, 'docs/api/openapi.json'));
}

function installDesktopFiles() {
  for (const file of ['main.cjs', 'launch.mjs']) copy(join(repo, 'apps/linux', file), join(shell, file));
  copy(join(repo, 'apps/desktop/loading.html'), join(shell, 'loading.html'));
  writeFileSync(join(shell, 'package.json'), JSON.stringify({
    name: 'prism-preview',
    productName: 'PRISM Literature Preview',
    version,
    main: 'main.cjs',
    private: true,
  }, null, 2) + '\n');
  copy(join(repo, 'apps/web/public/app-icon.png'), join(shell, 'app-icon.png'));
  copy(join(repo, 'apps/web/public/app-icon.png'), join(packageRoot, 'usr/share/pixmaps/prism-preview.png'));
  const launcher = join(packageRoot, 'usr/bin/prism-preview');
  copy(join(repo, 'apps/linux/prism-preview'), launcher);
  chmodSync(launcher, 0o755);
  const desktopEntry = 'app.prism.desktop.preview.desktop';
  copy(join(repo, 'apps/linux', desktopEntry), join(packageRoot, 'usr/share/applications', desktopEntry));
  copy(join(repo, 'apps/linux/prism-preview.apparmor'), join(packageRoot, 'etc/apparmor.d/prism-preview'));
  copy(join(repo, 'apps/linux/README.md'), join(packageRoot, 'usr/share/doc/prism-preview/README.md'));
}

function verifyInventory() {
  const forbidden = /^(?:\.env(?:\..*)?|\.git|\.data|\.DS_Store|PG_VERSION|postmaster\.pid)$/;
  for (const entry of readdirSync(packageRoot, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (forbidden.test(entry.name) || (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()))
      throw new Error(`Unexpected package entry: ${path}`);
    if ((lstatSync(path).mode & 0o6000) !== 0) throw new Error(`Privilege bits on package entry: ${path}`);
    if (entry.isSymbolicLink()) {
      const target = realpathSync(path);
      if (!target.startsWith(app + sep)) throw new Error(`Package link escapes its program directory: ${path}`);
    }
  }
}
try {
  stageSources();
  const nodeName = `node-${process.version}-linux-x64`;
  const nativeDownloads = Promise.all([
    verifiedArchive(`https://github.com/electron/electron/releases/download/v${electronVersion}/`, `electron-v${electronVersion}-linux-x64.zip`),
    verifiedArchive(`https://nodejs.org/dist/${process.version}/`, `${nodeName}.tar.xz`),
  ]);
  nativeDownloads.catch(() => {});
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: stage, env: buildEnvironment });
  run('pnpm', ['--filter', '@prism/web', 'build'], {
    cwd: stage, env: { ...buildEnvironment, PRISM_NEXT_STANDALONE: 'true' },
  });
  const [electron, node] = await nativeDownloads;
  mkdirSync(app, { recursive: true });
  run('unzip', ['-q', electron, '-d', app]);
  renameSync(join(app, 'electron'), join(app, 'prism-preview'));
  // Ubuntu's executable-specific AppArmor profile permits the namespace sandbox.
  // The preview does not rely on a privileged setuid helper.
  rmSync(join(app, 'chrome-sandbox'));
  rmSync(join(resources, 'default_app.asar'), { force: true });
  run('tar', ['-xJf', node, '-C', temp, `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);
  copy(join(temp, nodeName, 'bin/node'), join(resources, 'runtime/node'));
  copy(join(temp, nodeName, 'LICENSE'), join(resources, 'licenses/Node.js.txt'));
  assembleRuntime();
  installDesktopFiles();
  copy(join(repo, 'docs/implementation/eom-title-index.md'), join(resources, 'licenses/EoM-title-index.md'));
  copy(join(stage, 'apps/web/lib/csl'), join(resources, 'licenses/CSL-styles'));
  const noticeRoot = join(temp, 'notices');
  mkdirSync(join(noticeRoot, 'Contents'), { recursive: true });
  symlinkSync(resources, join(noticeRoot, 'Contents/Resources'));
  run(process.execPath, [join(repo, 'scripts/collect-macos-notices.mjs'), noticeRoot, stage]);
  verifyInventory();
  mkdirSync(join(packageRoot, 'DEBIAN'));
  writeFileSync(join(packageRoot, 'DEBIAN/control'), `Package: prism-preview
Version: ${version}
Architecture: amd64
Section: education
Priority: optional
Maintainer: PRISM contributors
Depends: apparmor, ca-certificates, libasound2t64, libatk-bridge2.0-0t64, libatk1.0-0t64, libatspi2.0-0t64, libatomic1, libc6, libcairo2, libcups2t64, libdbus-1-3, libdrm2, libexpat1, libgbm1, libglib2.0-0t64, libgtk-3-0t64, libnspr4, libnss3, libpango-1.0-0, libstdc++6, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxkbcommon0, libxrandr2, xdg-utils
Description: PRISM Literature Preview for Ubuntu
 Local desktop workspace for research, reading, and review.
`);
  writeFileSync(join(packageRoot, 'DEBIAN/conffiles'), '/etc/apparmor.d/prism-preview\n');
  mkdirSync(output, { recursive: true });
  const pending = join(output, `.${filename}.${process.pid}`);
  try {
    run('dpkg-deb', ['--root-owner-group', '-Zxz', '-z3', '--build', packageRoot, pending]);
    const target = join(output, filename);
    renameSync(pending, target);
    const sum = createHash('sha256').update(readFileSync(target)).digest('hex');
    console.log(`Packaged PRISM at ${target}\nSHA-256 ${sum}`);
  } finally {
    rmSync(pending, { force: true });
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSparkle, runMacToolchain, signSparkle, sparkleSwiftFlags } from './macos-sparkle.mjs';

if (
  process.platform !== 'darwin' ||
  !['arm64', 'x64'].includes(process.arch) ||
  process.versions.node.split('.')[0] !== '24'
)
  throw new Error('Use Node.js 24 on an Apple silicon or Intel Mac to package PRISM.');

const repo = fileURLToPath(new URL('../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'prism-macos-'));
const staging = join(temp, 'source');
const bundle = join(temp, 'PRISM.app');
const binaries = join(bundle, 'Contents/MacOS');
const resources = join(bundle, 'Contents/Resources');
const frameworks = join(bundle, 'Contents/Frameworks');
const runtime = join(resources, 'desktop');
const api = join(runtime, 'apps/api');
const version = process.env.PRISM_RELEASE_VERSION || '0.2.0';
const identity = process.env.PRISM_MACOS_SIGN_IDENTITY || '-';
const notaryProfile = process.env.PRISM_MACOS_NOTARY_PROFILE;
const updateFeed = process.env.PRISM_MACOS_UPDATE_FEED_URL;
const updatePublicKey = process.env.PRISM_MACOS_UPDATE_PUBLIC_KEY;
const updateTestId = process.env.PRISM_MACOS_UPDATE_TEST_ID;
const updateTestPort = Number(process.env.PRISM_MACOS_UPDATE_TEST_PORT || 38742);
const publicAdHocPreview = process.env.PRISM_MACOS_PUBLIC_AD_HOC_PREVIEW === 'true';
const withUpdater = Boolean(
  updateFeed ||
  updatePublicKey ||
  updateTestId ||
  process.env.PRISM_MACOS_UPDATE_TEST_PORT ||
  publicAdHocPreview,
);
const output = resolve(
  repo,
  process.env.PRISM_MACOS_OUTPUT_DIR ||
    (updateTestId ? `output/macos/update-tests/${updateTestId}/${version}` : 'output/macos'),
);
const bundleId = updateTestId ? `app.prism.desktop.update-test.${updateTestId}` : 'app.prism.desktop.release';
const releaseName = `PRISM-macOS-${process.arch}.zip`;
const zip = join(temp, releaseName);
const offline = process.env.PRISM_PACKAGE_OFFLINE === 'true' ? ['--offline'] : [];
const targetArchitecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const publicAppcast = process.arch === 'arm64' ? 'appcast.xml' : 'appcast-intel.xml';
const publicUpdateFeed = `https://sam-superlab.github.io/prism/${publicAppcast}`;
const buildPath = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(':');

function copy(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, verbatimSymlinks: true });
}

function stage(path) {
  copy(join(repo, path), join(staging, path));
}

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...options });
}

function sign(path, args = []) {
  const hardened = identity === '-' ? [] : ['--options', 'runtime', '--timestamp'];
  run('codesign', ['--force', '--sign', identity, ...hardened, ...args, path]);
}

function verifyArchitecture(path) {
  try {
    runMacToolchain(['lipo', '-verify_arch', targetArchitecture, path]);
  } catch (error) {
    throw new Error(`${path} does not contain a ${targetArchitecture} build.`, { cause: error });
  }
}

async function downloadNode() {
  const name = `node-${process.version}-darwin-${process.arch}`;
  const archive = `${name}.tar.xz`;
  const url = `https://nodejs.org/dist/${process.version}/`;
  const [download, sums] = await Promise.all(
    [archive, 'SHASUMS256.txt'].map((file) => fetch(url + file, { signal: AbortSignal.timeout(120000) })),
  );
  if (!download.ok || !sums.ok) throw new Error('Failed to download the official Node.js release.');
  const expected = (await sums.text())
    .split('\n')
    .find((line) => line.endsWith(`  ${archive}`))
    ?.slice(0, 64);
  const bytes = Buffer.from(await download.arrayBuffer());
  if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Node.js release checksum mismatch.');
  const archivePath = join(temp, archive);
  writeFileSync(archivePath, bytes);
  run('tar', ['-xJf', archivePath, '-C', temp, `${name}/bin/node`, `${name}/LICENSE`]);
  copy(join(temp, name, 'bin/node'), join(binaries, 'node'));
  copy(join(temp, name, 'LICENSE'), join(resources, 'licenses/Node.js.txt'));
}

function validateUpdater() {
  if (!withUpdater) return;
  const key = Buffer.from(updatePublicKey ?? '', 'base64');
  if (key.length !== 32 || key.toString('base64') !== updatePublicKey)
    throw new Error('An updater build requires a valid Sparkle EdDSA public key.');
  if (updateTestId) {
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/appcast\.xml$/.exec(updateFeed ?? '');
    const feedPort = Number(match?.[1]);
    if (
      !/^[a-z0-9]{8,32}$/.test(updateTestId) ||
      !(feedPort >= 1024 && feedPort <= 65535) ||
      !Number.isInteger(updateTestPort) ||
      updateTestPort < 1024 ||
      updateTestPort > 65535 ||
      [38741, feedPort].includes(updateTestPort) ||
      identity !== '-' ||
      notaryProfile ||
      publicAdHocPreview
    )
      throw new Error('Update tests require a separate ad-hoc bundle, Web port and loopback appcast.');
  } else {
    if (process.env.PRISM_MACOS_UPDATE_TEST_PORT || updateFeed !== publicUpdateFeed)
      throw new Error(`Public ${process.arch} updater builds require ${publicUpdateFeed}.`);
    if (publicAdHocPreview) {
      if (identity !== '-' || notaryProfile)
        throw new Error('The public ad-hoc preview uses ad-hoc signing without a notarization profile.');
    } else if (!identity.startsWith('Developer ID Application:') || !notaryProfile) {
      throw new Error(
        'Public updater builds require Developer ID and notarization or the explicit PRISM_MACOS_PUBLIC_AD_HOC_PREVIEW=true opt-in.',
      );
    }
  }
}

function updaterInfo() {
  if (!withUpdater) return '';
  return `<key>SUFeedURL</key><string>${updateFeed}</string>
<key>SUPublicEDKey</key><string>${updatePublicKey}</string>
<key>SUVerifyUpdateBeforeExtraction</key><true/>
<key>SURequireSignedFeed</key><true/>
<key>SUSignedFeedFailureExpirationInterval</key><integer>0</integer>
<key>SUEnableAutomaticChecks</key>${updateTestId ? '<false/>' : '<true/>'}
<key>SUScheduledCheckInterval</key><integer>3600</integer>
<key>SUAutomaticallyUpdate</key><false/>
<key>SUAllowsAutomaticUpdates</key><false/>
<key>SUEnableSystemProfiling</key><false/>
${
  updateTestId
    ? `<key>PRISMUpdateTestWorkspace</key><string>${updateTestId}</string>
<key>PRISMUpdateTestWebPort</key><integer>${updateTestPort}</integer>\n`
    : ''
}`;
}

try {
  if (!/^\d+\.\d+\.\d+$/.test(version) || (notaryProfile && identity === '-'))
    throw new Error('Use a numeric release version and a Developer ID identity for notarization.');
  validateUpdater();
  for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json'])
    stage(file);
  for (const name of ['api', 'mobile', 'web', 'worker']) stage(`apps/${name}/package.json`);
  for (const dir of ['api-client', 'core', 'database', 'fsrs', 'planner', 'shared-utils', 'types']) {
    stage(`packages/${dir}/package.json`);
    stage(`packages/${dir}/src`);
  }
  for (const file of [
    'app',
    'components',
    'lib',
    'next.config.ts',
    'tsconfig.json',
    'public/app-icon.png',
    'public/prism-mark.svg',
  ])
    stage(`apps/web/${file}`);
  stage('apps/worker/src');
  for (const file of ['app.ts', 'config.ts', 'errors.ts', 'server.ts', 'service.ts'])
    stage(`apps/api/src/${file}`);

  const nodeDownload = downloadNode();
  nodeDownload.catch(() => {});
  const sparkle = withUpdater
    ? installSparkle({
        temporaryDirectory: temp,
        frameworksDirectory: frameworks,
        resourcesDirectory: resources,
      })
    : Promise.resolve();
  sparkle.catch(() => {});
  const pnpmEnv = { ...process.env, PATH: buildPath };
  const userAgent = execFileSync(
    'pnpm',
    ['--config.verify-deps-before-run=false', 'exec', 'node', '-p', 'process.env.npm_config_user_agent'],
    { cwd: staging, env: pnpmEnv, encoding: 'utf8' },
  );
  if (userAgent.match(/\bdarwin (\S+)/)?.[1] !== process.arch)
    throw new Error(`Use pnpm running on ${process.arch} Node.js to install matching native dependencies.`);
  run('pnpm', ['install', '--frozen-lockfile', ...offline], { cwd: staging, env: pnpmEnv });
  run('pnpm', ['--filter', '@prism/web', 'build'], {
    cwd: staging,
    env: {
      PATH: buildPath,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NEXT_TELEMETRY_DISABLED: '1',
      PRISM_NEXT_STANDALONE: 'true',
    },
  });
  const webOutput = join(staging, 'apps/web/.next');
  const webRuntime = join(runtime, 'web');
  copy(join(webOutput, 'standalone'), webRuntime);
  copy(join(webOutput, 'static'), join(webRuntime, 'apps/web/.next/static'));
  copy(join(staging, 'apps/web/public'), join(webRuntime, 'apps/web/public'));
  // The desktop frontend serves its icons directly and has Next's image optimizer disabled.
  const webStore = join(webRuntime, 'node_modules/.pnpm');
  for (const entry of readdirSync(webStore)) {
    if (/^(?:sharp@|@img\+)/.test(entry)) rmSync(join(webStore, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(webStore, { recursive: true, withFileTypes: true })) {
    if (entry.name === '@img' || (entry.name === 'sharp' && entry.isSymbolicLink()))
      rmSync(join(entry.parentPath, entry.name), { recursive: true, force: true });
  }
  run('pnpm', ['--filter', '@prism/api', 'deploy', '--prod', '--legacy', ...offline, api], {
    cwd: staging,
    env: pnpmEnv,
  });
  // pnpm's install metadata contains the builder's absolute store path. Node does not use it.
  rmSync(join(api, 'node_modules/.modules.yaml'), { force: true });
  // pnpm's legacy deploy adds an unused self-reference to the build workspace.
  rmSync(join(api, 'node_modules/.pnpm/node_modules/@prism/api'), { force: true });
  copy(join(repo, 'docs/api/openapi.json'), join(runtime, 'docs/api/openapi.json'));
  copy(join(repo, 'docs/implementation/eom-title-index.md'), join(resources, 'licenses/EoM-title-index.md'));
  const databaseModule = realpathSync(join(api, 'node_modules/@prism/database'));
  for (const file of [
    'schema.sql',
    'migrations/002_arxiv_for_you.sql',
    'migrations/003_arxiv_for_you_rounds.sql',
    'migrations/004_ai_review_drafts.sql',
    'migrations/005_proof_recall.sql',
    'migrations/006_research_project_knowledge.sql',
    'migrations/007_research_references.sql',
    'migrations/008_reference_arxiv_identifiers.sql',
  ])
    copy(join(repo, 'database', file), resolve(databaseModule, '../../database', file));
  copy(join(repo, 'apps/macos/launch.mjs'), join(runtime, 'launch.mjs'));
  copy(join(repo, 'apps/macos/Assets/AppIcon.icns'), join(resources, 'AppIcon.icns'));
  copy(join(repo, 'apps/desktop/loading.html'), join(resources, 'loading.html'));
  await Promise.all([nodeDownload, sparkle]);
  run(process.execPath, [join(repo, 'scripts/collect-macos-notices.mjs'), bundle, staging]);

  writeFileSync(
    join(bundle, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PRISM</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>PRISM</string>
<key>CFBundleDisplayName</key><string>PRISM</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>PRISMPackaged</key><true/>
${updaterInfo()}</dict></plist>\n`,
  );
  runMacToolchain([
    'swiftc',
    '-O',
    '-target',
    `${targetArchitecture}-apple-macos13.5`,
    '-framework',
    'Cocoa',
    '-framework',
    'WebKit',
    ...(withUpdater ? sparkleSwiftFlags(frameworks) : []),
    ...(updateTestId ? ['-D', 'PRISM_UPDATE_TEST'] : []),
    join(repo, 'apps/macos/PRISM.swift'),
    '-o',
    join(binaries, 'PRISM'),
  ]);
  run(process.execPath, [join(repo, 'scripts/smoke-macos-package.mjs'), bundle, '--files-only']);

  const nodeBinary = join(binaries, 'node');
  verifyArchitecture(join(binaries, 'PRISM'));
  verifyArchitecture(nodeBinary);
  const nativeCode = new Set();
  for (const path of readdirSync(runtime, { recursive: true, withFileTypes: true })) {
    if (!path.isFile()) continue;
    const file = join(path.parentPath, path.name);
    // pnpm also installs shell and JavaScript launchers named esbuild.
    if (
      /\.(?:node|dylib)$/.test(path.name) ||
      (path.name === 'esbuild' && readFileSync(file).subarray(0, 2).toString() !== '#!')
    )
      nativeCode.add(realpathSync(file));
  }
  for (const path of nativeCode) verifyArchitecture(path);
  if (withUpdater) {
    const sparkleFramework = join(frameworks, 'Sparkle.framework');
    for (const file of ['Sparkle', 'Autoupdate', 'Updater.app/Contents/MacOS/Updater'])
      verifyArchitecture(join(sparkleFramework, file));
  }

  // Keep native helper code signed from the inside out before signing the outer bundle.
  const nodeEntitlements = join(temp, 'node-entitlements.plist');
  writeFileSync(
    nodeEntitlements,
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>',
  );
  sign(nodeBinary, ['--entitlements', nodeEntitlements]);
  for (const path of nativeCode) sign(path);
  if (withUpdater) signSparkle(frameworks, sign);
  sign(bundle, ['--identifier', bundleId]);
  run('codesign', ['--verify', '--deep', '--strict', bundle]);

  run(process.execPath, [join(repo, 'scripts/smoke-macos-package.mjs'), bundle]);
  run('codesign', ['--verify', '--deep', '--strict', bundle]);
  const zipBundle = () =>
    run('ditto', ['-c', '-k', ...(!notaryProfile ? ['--norsrc'] : []), '--keepParent', bundle, zip]);
  zipBundle();
  if (notaryProfile) {
    runMacToolchain(['notarytool', 'submit', zip, '--keychain-profile', notaryProfile, '--wait']);
    runMacToolchain(['stapler', 'staple', bundle]);
    runMacToolchain(['stapler', 'validate', bundle]);
    rmSync(zip);
    zipBundle();
  }
  mkdirSync(output, { recursive: true });
  const target = join(output, releaseName);
  const pending = join(output, `.${releaseName}.${process.pid}`);
  try {
    copy(zip, pending);
    renameSync(pending, target);
  } finally {
    rmSync(pending, { force: true });
  }
  console.log(`Packaged ${identity === '-' ? 'ad-hoc' : 'Developer ID'} PRISM at ${target}`);
  console.log(`SHA-256 ${createHash('sha256').update(readFileSync(target)).digest('hex')}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

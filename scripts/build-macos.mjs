import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { installSparkle, signSparkle, sparkleSwiftFlags } from './macos-sparkle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('Build the macOS desktop app on macOS.');
const { values } = parseArgs({
  options: {
    'build-only': { type: 'boolean' },
    'with-updater': { type: 'boolean' },
    'stage-update': { type: 'boolean' },
    version: { type: 'string', default: '0.2.2' },
    build: { type: 'string', default: '5' },
  },
});
const { version, build } = values;
const stageUpdate = values['stage-update'];
const buildOnly = values['build-only'] || stageUpdate;
const bundleId = 'app.prism.desktop.local';
const feed = 'http://127.0.0.1:38743/appcast.xml';
const account = 'prism-macos-personal';
const updateDirectory = join(root, '.data/macos-updates');
const install = join(homedir(), 'Applications/PRISM.app');
const installed = existsSync(install)
  ? JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(install, 'Contents/Info.plist')]))
  : null;
const withUpdater =
  values['with-updater'] ||
  stageUpdate ||
  (!buildOnly && installed?.CFBundleIdentifier === bundleId && Boolean(installed.SUPublicEDKey));
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[1-9]\d{0,8}$/.test(build))
  throw new Error('Use a numeric version such as 0.2.3 and a positive integer build number.');
if (!buildOnly && installed && installed.CFBundleIdentifier !== bundleId)
  throw new Error('The installed PRISM belongs to another update channel. Use --build-only.');
if (!buildOnly && installed?.SUPublicEDKey && Number(build) < Number(installed.CFBundleVersion))
  throw new Error('The installed personal app is newer. Use its build number or a higher one.');
if (
  stageUpdate &&
  (installed?.CFBundleIdentifier !== bundleId ||
    installed.SUFeedURL !== feed ||
    installed.PRISMProjectRoot !== root ||
    Number(build) <= Number(installed.CFBundleVersion))
)
  throw new Error(
    'Install the updater-enabled personal app from this checkout first and stage a higher build number.',
  );

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function sign(path, args = []) {
  run('codesign', ['--force', '--sign', '-', ...args, path]);
}

const output = join(root, 'output/macos');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(output, '.personal-build-'));
const bundle = join(temp, 'PRISM.app');
const binaries = join(bundle, 'Contents/MacOS');
const resources = join(bundle, 'Contents/Resources');
const frameworks = join(bundle, 'Contents/Frameworks');
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function replaceBundle(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const staged = mkdtempSync(join(dirname(destination), '.prism-install-'));
  const next = join(staged, 'PRISM.app');
  const previous = join(staged, 'previous.app');
  try {
    run('ditto', [source, next]);
    run('codesign', ['--verify', '--deep', '--strict', next]);
    if (existsSync(destination)) renameSync(destination, previous);
    try {
      renameSync(next, destination);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
  } finally {
    if (existsSync(destination) || !existsSync(previous)) rmSync(staged, { recursive: true, force: true });
  }
}

function publishLocalUpdate(tools) {
  const directory = updateDirectory;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory())
    throw new Error('The personal update directory must be a real local directory.');
  chmodSync(directory, 0o700);
  const staging = mkdtempSync(join(directory, '.staging-'));
  const name = `PRISM-personal-${build}.zip`;
  const archive = join(staging, name);
  const appcast = join(staging, 'appcast.xml');
  try {
    for (const file of readdirSync(directory)) {
      const existing = /^PRISM-personal-([1-9]\d*)\.zip$/.exec(file);
      if (existing && Number(existing[1]) >= Number(build))
        throw new Error('Use a build number higher than all previously staged personal updates.');
    }
    run('ditto', ['-c', '-k', '--norsrc', '--keepParent', bundle, archive]);
    chmodSync(archive, 0o600);
    run(process.execPath, [
      join(root, 'scripts/sign-macos-appcast.mjs'),
      '--sign-update',
      join(tools, 'sign_update'),
      '--archive',
      archive,
      '--download-url',
      new URL(name, feed).href,
      '--output',
      appcast,
      '--account',
      account,
    ]);
    chmodSync(appcast, 0o600);
    const published = join(directory, name);
    linkSync(archive, published);
    try {
      rmSync(archive);
      renameSync(appcast, join(directory, 'appcast.xml'));
    } catch (error) {
      rmSync(published);
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  console.log(`Staged PRISM ${version} for Check for Updates on this Mac.`);
}

try {
  run(process.execPath, [join(root, 'scripts/generate-icons.mjs')]);
  mkdirSync(binaries, { recursive: true });
  mkdirSync(resources, { recursive: true });
  copyFileSync(join(root, 'apps/macos/Assets/AppIcon.icns'), join(resources, 'AppIcon.icns'));
  let tools;
  let updaterInfo = '';
  if (withUpdater) {
    tools = await installSparkle({
      temporaryDirectory: temp,
      frameworksDirectory: frameworks,
      resourcesDirectory: resources,
    });
    const generateKeys = join(tools, 'generate_keys');
    const trustedKey = installed?.CFBundleIdentifier === bundleId ? installed.SUPublicEDKey : undefined;
    if (!trustedKey) run(generateKeys, ['--account', account]);
    const key = execFileSync(generateKeys, ['--account', account, '-p'], { encoding: 'utf8' }).trim();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error('Could not read the personal Sparkle public key.');
    if (trustedKey && key !== trustedKey)
      throw new Error('The local Sparkle signing key does not match the one already trusted by PRISM.');
    updaterInfo = `<key>SUFeedURL</key><string>${feed}</string>
<key>SUPublicEDKey</key><string>${key}</string>
<key>SUVerifyUpdateBeforeExtraction</key><true/>
<key>SURequireSignedFeed</key><true/>
<key>SUSignedFeedFailureExpirationInterval</key><integer>0</integer>
<key>SUEnableAutomaticChecks</key><true/>
<key>SUScheduledCheckInterval</key><integer>3600</integer>
<key>SUAutomaticallyUpdate</key><false/>
<key>SUAllowsAutomaticUpdates</key><false/>
<key>SUEnableSystemProfiling</key><false/>`;
  }
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
<key>CFBundleVersion</key><string>${build}</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>PRISMProjectRoot</key><string>${xml(root)}</string>
${updaterInfo}
</dict></plist>`,
  );
  run('xcrun', [
    'swiftc',
    '-O',
    '-target',
    `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
    '-framework',
    'Cocoa',
    '-framework',
    'WebKit',
    ...(withUpdater ? sparkleSwiftFlags(frameworks) : []),
    join(root, 'apps/macos/PRISM.swift'),
    '-o',
    join(binaries, 'PRISM'),
  ]);
  if (withUpdater) signSparkle(frameworks, sign);
  sign(bundle, ['--identifier', bundleId]);
  run('codesign', ['--verify', '--deep', '--strict', bundle]);
  if (stageUpdate) publishLocalUpdate(tools);
  else {
    const result = join(output, 'PRISM.app');
    replaceBundle(bundle, result);
    console.log(`Built local desktop app: ${result}`);
    if (!buildOnly) {
      if (withUpdater && !existsSync(join(updateDirectory, 'appcast.xml'))) publishLocalUpdate(tools);
      replaceBundle(bundle, install);
      console.log(`Installed local desktop app: ${install}`);
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runMacToolchain } from './macos-sparkle.mjs';

const { values } = parseArgs({
  options: {
    'sign-update': { type: 'string' },
    archive: { type: 'string' },
    'download-url': { type: 'string' },
    output: { type: 'string' },
    account: { type: 'string', default: 'prism-macos-release' },
    'test-key-file': { type: 'string' },
  },
});
if (
  !values['sign-update'] ||
  !values.archive?.endsWith('.zip') ||
  !values['download-url'] ||
  !values.output?.endsWith('.xml')
) {
  throw new Error(
    'Usage: node scripts/sign-macos-appcast.mjs --sign-update TOOL --archive UPDATE.zip --download-url URL --output appcast.xml',
  );
}

const tool = resolve(values['sign-update']);
const archive = resolve(values.archive);
const output = resolve(values.output);
const plist = execFileSync('/usr/bin/unzip', ['-p', archive, 'PRISM.app/Contents/Info.plist']);
const info = JSON.parse(
  execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: plist }),
);
const {
  CFBundleIdentifier,
  CFBundleVersion,
  CFBundleShortVersionString,
  LSMinimumSystemVersion,
  SUPublicEDKey,
} = info;
const versionPattern = /^\d+(?:\.\d+){0,2}$/;
if (
  !versionPattern.test(CFBundleVersion ?? '') ||
  !versionPattern.test(CFBundleShortVersionString ?? '') ||
  !versionPattern.test(LSMinimumSystemVersion ?? '') ||
  info.SUVerifyUpdateBeforeExtraction !== true ||
  info.SURequireSignedFeed !== true ||
  info.SUSignedFeedFailureExpirationInterval !== 0 ||
  !/^[A-Za-z0-9+/]{43}=$/.test(SUPublicEDKey ?? '')
) {
  throw new Error('The archive must contain PRISM release metadata and signed Sparkle update settings.');
}

function cleanUrl(input) {
  const url = new URL(input);
  if (url.username || url.password || url.hash)
    throw new Error('Feed and download URLs cannot contain credentials or fragments.');
  return url;
}
const feed = cleanUrl(info.SUFeedURL);
const download = cleanUrl(values['download-url']);
const test =
  typeof CFBundleIdentifier === 'string' && CFBundleIdentifier.startsWith('app.prism.desktop.update-test.');

function isWithin(directory, path) {
  const name = relative(directory, path);
  return name !== '..' && !name.startsWith('../') && !isAbsolute(name);
}

function verifyPublicArchitecture(architecture) {
  const directory = mkdtempSync(join(tmpdir(), 'prism-appcast-'));
  try {
    for (const name of ['PRISM', 'node']) {
      const executable = join(directory, name);
      const handle = openSync(executable, 'wx');
      try {
        execFileSync('/usr/bin/unzip', ['-p', archive, `PRISM.app/Contents/MacOS/${name}`], {
          stdio: ['ignore', handle, 'pipe'],
        });
      } finally {
        closeSync(handle);
      }
      const architectures = runMacToolchain(['lipo', '-archs', executable], {
        encoding: 'utf8',
      }).trim();
      if (architectures !== architecture)
        throw new Error(`Public update ${name} must be ${architecture}. Found ${architectures}.`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

let credentials = ['--account', values.account];
if (test) {
  if (
    feed.protocol !== 'http:' ||
    feed.hostname !== '127.0.0.1' ||
    download.origin !== feed.origin ||
    !values['test-key-file']
  )
    throw new Error(
      'Test updates require a loopback feed, a download from the same server, and a disposable test key.',
    );
  const key = realpathSync(values['test-key-file']);
  const workspace = fileURLToPath(new URL('../', import.meta.url));
  const keyStat = statSync(key);
  if (
    !keyStat.isFile() ||
    keyStat.mode & 0o077 ||
    isWithin(workspace, key) ||
    isWithin(realpathSync(dirname(output)), key)
  )
    throw new Error(
      'Keep the mode-0600 test key outside both the workspace and the directory serving the feed.',
    );
  credentials = ['--ed-key-file', key];
} else if (CFBundleIdentifier === 'app.prism.desktop.local') {
  const localOrigin = 'http://127.0.0.1:38743';
  if (
    info.SUFeedURL !== `${localOrigin}/appcast.xml` ||
    values['download-url'] !== `${localOrigin}/PRISM-personal-${CFBundleVersion}.zip` ||
    !/^[1-9]\d*$/.test(CFBundleVersion) ||
    values.account !== 'prism-macos-personal' ||
    values['test-key-file'] !== undefined ||
    typeof info.PRISMProjectRoot !== 'string' ||
    !isAbsolute(info.PRISMProjectRoot) ||
    info.PRISMPackaged ||
    info.SUEnableSystemProfiling !== false
  ) {
    throw new Error(
      'Personal PRISM updates require the local appcast, a matching versioned ZIP, and the prism-macos-personal Keychain account.',
    );
  }
} else {
  const publicFeeds = new Map([
    ['https://sam-superlab.github.io/prism/appcast.xml', ['arm64', 'arm64']],
    ['https://sam-superlab.github.io/prism/appcast-intel.xml', ['x64', 'x86_64']],
  ]);
  const release = publicFeeds.get(feed.href);
  if (CFBundleIdentifier !== 'app.prism.desktop.release' || !release || values['test-key-file']) {
    throw new Error('Public PRISM releases require the project Pages feed and a Keychain signing key.');
  }
  const [assetArchitecture, executableArchitecture] = release;
  const asset = `PRISM-macOS-${assetArchitecture}.zip`;
  if (
    basename(archive) !== asset ||
    basename(output) !== basename(feed.pathname) ||
    download.href !==
      `https://github.com/Sam-superlab/prism/releases/download/v${CFBundleShortVersionString}/${asset}`
  ) {
    throw new Error(
      'Public PRISM releases require the archive, appcast, and GitHub URL to match the update architecture.',
    );
  }
  verifyPublicArchitecture(executableArchitecture);
}

function sparkle(args) {
  try {
    return execFileSync(tool, [...credentials, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Sparkle may echo malformed key data. Do not pass its failure output to the terminal.
    throw new Error('Sparkle signing or verification failed. Check the signing tool and key access.');
  }
}

const signature = sparkle(['-p', archive]);
const bytes = readFileSync(archive);
const key = createPublicKey({
  format: 'jwk',
  key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(SUPublicEDKey, 'base64').toString('base64url') },
});
if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || !verify(null, bytes, key, Buffer.from(signature, 'base64')))
  throw new Error('The archive signature does not match the public key embedded in PRISM.');

const escaped = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[character],
  );
const system = LSMinimumSystemVersion.split('.');
while (system.length < 3) system.push('0');
const content = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>PRISM for macOS</title>
    <link>${escaped(new URL('.', feed).href)}</link>
    <description>PRISM for macOS updates.</description>
    <language>en</language>
    <item>
      <title>PRISM ${escaped(CFBundleShortVersionString)}</title>
      <pubDate>${statSync(archive).mtime.toUTCString()}</pubDate>
      <sparkle:version>${escaped(CFBundleVersion)}</sparkle:version>
      <sparkle:shortVersionString>${escaped(CFBundleShortVersionString)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${system.join('.')}</sparkle:minimumSystemVersion>
      <enclosure url="${escaped(download.href)}" sparkle:edSignature="${signature}" length="${bytes.length}" type="application/octet-stream"/>
    </item>
  </channel>
</rss>
`;

const staging = mkdtempSync(join(dirname(output), '.appcast-'));
try {
  const signed = join(staging, 'appcast.xml');
  writeFileSync(signed, content, { flag: 'wx' });
  sparkle(['-p', signed]);
  sparkle(['--verify', signed]);
  renameSync(signed, output);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
console.log(`Signed and verified ${output} for PRISM build ${CFBundleVersion}`);
console.log(`Archive SHA-256 ${createHash('sha256').update(bytes).digest('hex')}`);

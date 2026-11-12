import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'sign-update': { type: 'string' },
    archive: { type: 'string' },
    version: { type: 'string' },
    'public-key': { type: 'string' },
    'download-url': { type: 'string' },
    output: { type: 'string' },
    account: { type: 'string', default: 'prism-macos-release' },
    'test-loopback': { type: 'boolean', default: false },
  },
});
if (!values['sign-update'] || !values.archive?.endsWith('.zip') || !values.output?.endsWith('.json')) {
  throw new Error(
    'Usage: node scripts/sign-windows-update.mjs --sign-update TOOL --archive UPDATE.zip --public-key BASE64 --output windows-update.json',
  );
}
const archive = realpathSync(resolve(values.archive));
const output = resolve(values.output);
const publicKeyBytes = Buffer.from(values['public-key'] ?? '', 'base64');
if (publicKeyBytes.length !== 32 || publicKeyBytes.toString('base64') !== values['public-key'])
  throw new Error('A canonical base64 Ed25519 public key is required.');
const key = createPublicKey({
  format: 'jwk',
  key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyBytes.toString('base64url') },
});
const info = JSON.parse(execFileSync('/usr/bin/unzip', ['-p', archive, 'PRISM/resources/app/package.json']));
const config = JSON.parse(
  execFileSync('/usr/bin/unzip', ['-p', archive, 'PRISM/resources/app/update-config.json']),
);
const installation = JSON.parse(execFileSync('/usr/bin/unzip', ['-p', archive, 'PRISM/prism-install.json']));
const version = values.version ?? info.version;
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version ?? '') || info.version !== version)
  throw new Error('The requested version must match the numeric version in the Windows archive.');
if (
  installation.format !== 'prism-portable-v1' ||
  installation.version !== version ||
  !Array.isArray(installation.files) ||
  !Array.isArray(installation.directories)
)
  throw new Error('The Windows installation inventory must match the app version.');
if (
  config.feedUrl !== 'https://sam-superlab.github.io/prism/windows-update.json' ||
  config.publicKey !== values['public-key']
)
  throw new Error('The Windows archive must embed the public PRISM update feed and matching signing key.');
const productionUrl = `https://github.com/Sam-superlab/prism/releases/download/v${version}/PRISM-Windows-x64.zip`;
const downloadUrl = values['download-url'] ?? productionUrl;
if (values.account !== 'prism-macos-release')
  throw new Error('Windows releases use the PRISM release Keychain account.');
if (values['test-loopback']) {
  const workspace = fileURLToPath(new URL('../', import.meta.url));
  const name = relative(realpathSync(workspace), join(realpathSync(dirname(output)), basename(output)));
  if (
    downloadUrl !== 'http://127.0.0.1:38744/PRISM-Windows-x64.zip' ||
    basename(output) !== 'windows-update-test.json' ||
    (name !== '..' && !name.startsWith('../') && !isAbsolute(name))
  )
    throw new Error(
      'Loopback test manifests require the fixed test URL and windows-update-test.json outside the workspace.',
    );
} else if (downloadUrl !== productionUrl || basename(output) !== 'windows-update.json') {
  throw new Error('Public manifests require the versioned PRISM GitHub ZIP and windows-update.json.');
}
const bytes = readFileSync(archive);
if (bytes.length < 1 || bytes.length > 768 * 1024 * 1024 || !statSync(archive).isFile())
  throw new Error('The update must be a ZIP no larger than 768 MiB.');
const tool = resolve(values['sign-update']);
function sign(path, data) {
  let signature;
  try {
    signature = execFileSync(tool, ['--account', values.account, '-p', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error('Windows update signing failed. Check the release key access.');
  }
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || !verify(null, data, key, Buffer.from(signature, 'base64')))
    throw new Error('The Windows update signature does not match the embedded public key.');
  return signature;
}
const signature = sign(archive, bytes);
const payload = Buffer.from(
  JSON.stringify({
    version,
    url: downloadUrl,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature,
  }),
);
const temporary = mkdtempSync(join(dirname(output), '.windows-manifest-'));
try {
  const payloadPath = join(temporary, 'payload.bin');
  writeFileSync(payloadPath, payload, { flag: 'wx' });
  const envelope = {
    payload: payload.toString('base64'),
    signature: sign(payloadPath, payload),
  };
  const staged = join(temporary, 'manifest.json');
  writeFileSync(staged, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
  renameSync(staged, output);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
console.log(`Signed and verified Windows update ${version}: ${output}`);
console.log(`Archive SHA-256 ${createHash('sha256').update(bytes).digest('hex')}`);

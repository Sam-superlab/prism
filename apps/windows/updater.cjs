const { createHash, createPublicKey, randomBytes, verify } = require('node:crypto');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');
const zlib = require('node:zlib');

const PUBLIC_FEED = 'https://sam-superlab.github.io/prism/windows-update.json';
const MAX_ARCHIVE = 768 * 1024 * 1024;
const MAX_UNPACKED = 3 * 1024 * 1024 * 1024;
const VERSION = /^\d+\.\d+\.\d+$/;
function versionParts(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) throw new Error('Invalid update version.');
  const parts = value.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part > 999999))
    throw new Error('Invalid update version.');
  return parts;
}
function isNewer(version, current) {
  const left = versionParts(version),
    right = versionParts(current);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}
function publicKey(raw) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(raw))
    throw new Error('Invalid update signing key.');
  return createPublicKey({
    format: 'jwk',
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw, 'base64').toString('base64url') },
  });
}
function validSignature(bytes, signature, key) {
  return (
    typeof signature === 'string' &&
    /^[A-Za-z0-9+/]{86}==$/.test(signature) &&
    verify(null, bytes, key, Buffer.from(signature, 'base64'))
  );
}
function checkManifest(envelope, config, feed) {
  const key = publicKey(config.publicKey);
  if (
    !envelope ||
    typeof envelope.payload !== 'string' ||
    envelope.payload.length > 24000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload)
  )
    throw new Error('Invalid update manifest.');
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (!validSignature(bytes, envelope.signature, key))
    throw new Error('The update manifest signature is invalid.');
  const entry = JSON.parse(bytes.toString('utf8'));
  versionParts(entry.version);
  if (
    !Number.isSafeInteger(entry.size) ||
    entry.size < 1 ||
    entry.size > MAX_ARCHIVE ||
    !/^[a-f0-9]{64}$/.test(entry.sha256) ||
    !/^[A-Za-z0-9+/]{86}==$/.test(entry.signature)
  )
    throw new Error('Invalid update archive details.');
  const url = new URL(entry.url);
  if (url.username || url.password || url.hash || url.search)
    throw new Error('Invalid update download address.');
  if (feed === PUBLIC_FEED) {
    if (
      url.href !==
      `https://github.com/Sam-superlab/prism/releases/download/v${entry.version}/PRISM-Windows-x64.zip`
    )
      throw new Error('Unexpected update download address.');
  } else if (url.origin !== new URL(feed).origin || url.pathname !== '/PRISM-Windows-x64.zip')
    throw new Error('Unexpected test download address.');
  return entry;
}
function safeName(value) {
  if (
    !value ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.includes(':') ||
    value.includes('\0') ||
    /[<>"|?*\x00-\x1f]/.test(value)
  )
    throw new Error('Unsafe update path.');
  const parts = value.replace(/\/$/, '').split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error('Unsafe update path.');
  return parts;
}
function zipEntries(bytes) {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6))
    throw new Error('Unsupported update ZIP.');
  const count = bytes.readUInt16LE(end + 10),
    start = bytes.readUInt32LE(end + 16),
    size = bytes.readUInt32LE(end + 12);
  if (!count || count === 65535 || count !== bytes.readUInt16LE(end + 8) || start + size !== end)
    throw new Error('Invalid update ZIP directory.');
  const entries = [],
    names = new Set();
  let offset = start,
    unpacked = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('Invalid update ZIP entry.');
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20),
      length = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28),
      extra = bytes.readUInt16LE(offset + 30),
      comment = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extra + comment;
    if (next > end || flags & 1 || ![0, 8].includes(method) || bytes.readUInt16LE(offset + 34))
      throw new Error('Unsupported update ZIP entry.');
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength),
      name = rawName.toString('utf8');
    if (!Buffer.from(name).equals(rawName)) throw new Error('Invalid ZIP filename encoding.');
    const parts = safeName(name),
      mode = bytes.readUInt32LE(offset + 38) >>> 16;
    if (parts[0] !== 'PRISM' || (mode & 0o170000 && ![0o040000, 0o100000].includes(mode & 0o170000)))
      throw new Error('Unexpected update ZIP layout.');
    const normalized = parts.join('/').toLowerCase();
    if (names.has(normalized)) throw new Error('Duplicate update ZIP path.');
    names.add(normalized);
    unpacked += length;
    if (unpacked > MAX_UNPACKED || length > MAX_ARCHIVE)
      throw new Error('The update expands beyond its size limit.');
    const local = bytes.readUInt32LE(offset + 42);
    if (
      local + 30 > start ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt16LE(local + 6) & 1
    )
      throw new Error('Invalid local update ZIP entry.');
    const localNameLength = bytes.readUInt16LE(local + 26),
      localExtra = bytes.readUInt16LE(local + 28),
      data = local + 30 + localNameLength + localExtra;
    if (
      data + compressed > start ||
      !bytes.subarray(local + 30, local + 30 + localNameLength).equals(rawName)
    )
      throw new Error('Inconsistent update ZIP entry.');
    const directory = name.endsWith('/');
    if (directory && (length || compressed)) throw new Error('Invalid update directory.');
    entries.push({ parts, directory, data, compressed, length, method });
    offset = next;
  }
  if (offset !== end) throw new Error('Invalid update ZIP directory length.');
  return entries;
}
async function extractArchive(bytes, directory) {
  const entries = zipEntries(bytes);
  for (const entry of entries) {
    const target = path.join(directory, ...entry.parts);
    if (entry.directory) {
      await fs.mkdir(target, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const data = bytes.subarray(entry.data, entry.data + entry.compressed);
    const content =
      entry.method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: entry.length || 1 }) : data;
    if (content.length !== entry.length) throw new Error('Update file size mismatch.');
    await fs.writeFile(target, content, { flag: 'wx' });
  }
}
function within(root, location) {
  const relative = path.relative(root, location);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}
async function validateInstallation(directory, version) {
  const real = await fs.realpath(directory);
  const marker = JSON.parse(await fs.readFile(path.join(real, 'prism-install.json'), 'utf8'));
  if (
    marker.format !== 'prism-portable-v1' ||
    marker.version !== version ||
    !Array.isArray(marker.files) ||
    !Array.isArray(marker.directories)
  )
    throw new Error(
      'This PRISM folder does not support in-app updates. Install the current official Windows download first.',
    );
  const expectedFiles = new Set(marker.files.map((name) => safeName(name).join('/')));
  const expectedDirectories = new Set(marker.directories.map((name) => safeName(name).join('/')));
  if (expectedFiles.size !== marker.files.length || expectedDirectories.size !== marker.directories.length)
    throw new Error('Invalid installation inventory.');
  expectedFiles.add('prism-install.json');
  async function visit(root, prefix = '') {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error('The PRISM folder contains links and cannot be updated safely.');
      if (entry.isDirectory()) {
        if (!expectedDirectories.delete(relative))
          throw new Error(
            'The PRISM folder contains extra files. Move personal files outside the program folder before updating.',
          );
        await visit(path.join(root, entry.name), relative);
      } else if (!entry.isFile() || !expectedFiles.delete(relative))
        throw new Error(
          'The PRISM folder contains extra files. Move personal files outside the program folder before updating.',
        );
    }
  }
  await visit(real);
  const pkg = JSON.parse(await fs.readFile(path.join(real, 'resources/app/package.json'), 'utf8'));
  if (
    expectedFiles.size ||
    expectedDirectories.size ||
    pkg.version !== version ||
    !(await fs.stat(path.join(real, 'PRISM.exe'))).isFile()
  )
    throw new Error('The PRISM installation is incomplete. Download a fresh copy before updating.');
  return real;
}
async function readLimited(response, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw new Error('The update response exceeds its size limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function createUpdater({ app, dialog, getWindow, shutdown, smokeDir }) {
  const installDir = path.dirname(process.execPath);
  const configPath = path.join(__dirname, 'update-config.json');
  let busy = false,
    controller,
    prepared,
    installing = false,
    disposing = false;
  let completion = Promise.resolve(),
    complete;
  const stateFile = smokeDir && path.join(smokeDir, 'updater-state.json');
  function progress(value) {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.setProgressBar(value);
  }
  async function state(status, details = {}) {
    if (stateFile) await fs.writeFile(stateFile, JSON.stringify({ status, ...details }));
  }
  async function confirm(options) {
    if (smokeDir) return 1;
    return (
      await dialog.showMessageBox(getWindow(), {
        type: 'info',
        buttons: ['Cancel', 'Continue'],
        defaultId: 1,
        cancelId: 0,
        ...options,
      })
    ).response;
  }
  async function install() {
    if (!prepared) return;
    if (
      !(await confirm({
        message: `PRISM ${prepared.entry.version} is ready to install.`,
        detail: 'Save your current edits. PRISM will close, install the update, and reopen.',
        buttons: ['Later', 'Install and restart'],
      }))
    )
      return;
    await validateInstallation(installDir, app.getVersion());
    await state('installing', { version: prepared.entry.version });
    const helper = path.join(prepared.session, 'update-helper.cjs');
    const runner = spawn(
      path.join(prepared.session, 'node.exe'),
      [helper, path.join(prepared.session, 'job.json')],
      { detached: true, windowsHide: true, stdio: 'ignore', cwd: prepared.session },
    );
    await new Promise((resolve, reject) => {
      runner.once('spawn', resolve);
      runner.once('error', reject);
    });
    runner.unref();
    installing = true;
    await shutdown();
    app.quit();
  }
  async function check({ automatic = false } = {}) {
    if (busy) {
      if (
        !automatic &&
        !smokeDir &&
        controller &&
        (await confirm({
          message: 'An update is downloading.',
          buttons: ['Continue download', 'Cancel download'],
        }))
      )
        controller.abort();
      return;
    }
    busy = true;
    completion = new Promise((resolve) => {
      complete = resolve;
    });
    controller = new AbortController();
    let staging;
    try {
      if (prepared) {
        if (!automatic) await install();
        return;
      }
      await state('checking');
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      let feed = config.feedUrl;
      const testFeed = smokeDir && process.env.PRISM_WINDOWS_UPDATE_TEST_FEED;
      if (testFeed) {
        const url = new URL(testFeed);
        if (
          url.protocol !== 'http:' ||
          url.hostname !== '127.0.0.1' ||
          url.pathname !== '/windows-update.json' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error('Invalid test update address.');
        feed = url.href;
      } else if (feed !== PUBLIC_FEED) throw new Error('Unexpected update feed address.');
      const manifestResponse = await fetch(feed, {
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        cache: 'no-store',
      });
      if (!manifestResponse.ok) throw new Error('The update service is unavailable. Try again later.');
      const entry = checkManifest(
        JSON.parse((await readLimited(manifestResponse, 32000)).toString('utf8')),
        config,
        feed,
      );
      if (!isNewer(entry.version, app.getVersion())) {
        await state('current', { version: app.getVersion() });
        if (!smokeDir && !automatic)
          await dialog.showMessageBox(getWindow(), {
            message: `PRISM ${app.getVersion()} is up to date.`,
            buttons: ['OK'],
          });
        return;
      }
      const root = await validateInstallation(installDir, app.getVersion());
      const parent = path.dirname(root),
        userData = await fs.realpath(app.getPath('userData'));
      const protectedPaths = ['home', 'appData', 'userData', 'desktop', 'documents', 'downloads', 'temp'].map(
        (name) => app.getPath(name),
      );
      if (root === path.parse(root).root || protectedPaths.some((location) => within(root, location)))
        throw new Error('Move PRISM into its own writable program folder before updating.');
      if (
        !(await confirm({
          message: `PRISM ${entry.version} is available.`,
          detail: 'Download the update now?',
          buttons: ['Cancel', 'Download update'],
        }))
      )
        return;
      staging = await fs.mkdtemp(path.join(parent, '.prism-update-'));
      await state('downloading', { version: entry.version });
      progress(2);
      const response = await fetch(entry.url, {
        redirect: feed === PUBLIC_FEED ? 'follow' : 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]),
      });
      if (!response.ok) throw new Error('The update download failed. Try again later.');
      if (
        response.headers.get('content-length') &&
        Number(response.headers.get('content-length')) !== entry.size
      )
        throw new Error('The update download has an unexpected size.');
      const bytes = await readLimited(response, entry.size);
      if (
        bytes.length !== entry.size ||
        createHash('sha256').update(bytes).digest('hex') !== entry.sha256 ||
        !validSignature(bytes, entry.signature, publicKey(config.publicKey))
      )
        throw new Error('The downloaded update checksum or signature is invalid.');
      await extractArchive(bytes, staging);
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const candidate = path.join(staging, 'PRISM');
      await validateInstallation(candidate, entry.version);
      const updates = path.join(userData, 'updates');
      await fs.mkdir(updates, { recursive: true });
      const session = await fs.mkdtemp(path.join(updates, 'install-'));
      await fs.copyFile(path.join(process.resourcesPath, 'runtime/node.exe'), path.join(session, 'node.exe'));
      await fs.copyFile(path.join(__dirname, 'update-helper.cjs'), path.join(session, 'update-helper.cjs'));
      await fs.copyFile(path.join(__dirname, 'updater.cjs'), path.join(session, 'updater.cjs'));
      const ackToken = randomBytes(32).toString('hex');
      const job = {
        installDir: root,
        candidate,
        staging,
        backup: path.join(staging, 'previous'),
        userData,
        parentPid: process.pid,
        previousVersion: app.getVersion(),
        version: entry.version,
        ack: path.join(session, 'ack.json'),
        ackToken,
        stateFile,
        smokeDir,
        environment: Object.fromEntries(
          [
            'SystemRoot',
            'WINDIR',
            'PATH',
            'TEMP',
            'TMP',
            'USERPROFILE',
            'APPDATA',
            'LOCALAPPDATA',
            'PRISM_WINDOWS_SMOKE_DIR',
            'PRISM_WINDOWS_UPDATE_TEST_FEED',
          ]
            .filter((name) => process.env[name] !== undefined)
            .map((name) => [name, process.env[name]]),
        ),
      };
      await fs.writeFile(path.join(session, 'job.json'), JSON.stringify(job), { flag: 'wx' });
      prepared = { entry, session, staging };
      staging = undefined;
      progress(-1);
      await install();
    } catch (error) {
      const message = error.name === 'AbortError' ? 'The update download was cancelled.' : error.message;
      await state('error', { message });
      if (!smokeDir && !disposing && !automatic)
        await dialog.showMessageBox(getWindow(), {
          type: 'error',
          message: 'PRISM could not update.',
          detail: message,
          buttons: ['OK'],
        });
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      progress(-1);
      busy = false;
      controller = undefined;
      complete?.();
    }
  }
  async function dispose() {
    if (installing) return;
    disposing = true;
    controller?.abort();
    await completion;
    if (prepared) {
      await fs.rm(prepared.staging, { recursive: true, force: true }).catch(() => {});
      await fs.rm(prepared.session, { recursive: true, force: true }).catch(() => {});
      prepared = undefined;
    }
  }
  async function notifyPreviousFailure() {
    const report = path.join(app.getPath('userData'), 'updates', 'rollback.json');
    try {
      const failure = JSON.parse(await fs.readFile(report, 'utf8'));
      if (!smokeDir)
        await dialog.showMessageBox(getWindow(), {
          type: 'error',
          message: 'PRISM restored the previous version.',
          detail: String(failure.message).slice(0, 1000),
          buttons: ['OK'],
        });
      await fs.unlink(report);
    } catch {
      /* No previous update failure report. */
    }
  }
  return { check, dispose, notifyPreviousFailure };
}
function startAutomaticChecks({ file, check, now = Date.now }) {
  const hour = 60 * 60 * 1000;
  let timer;
  let stopped = false;
  let running = false;
  async function tick() {
    if (stopped || running) return;
    running = true;
    clearTimeout(timer);
    let nextCheck = now() + hour;
    try {
      let lastAttempt = 0;
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        if (Number.isFinite(saved.lastAttemptAt)) lastAttempt = saved.lastAttemptAt;
      } catch {
        // A new profile checks on its first launch.
      }
      const timestamp = now();
      if (lastAttempt > 0 && timestamp >= lastAttempt && timestamp - lastAttempt < hour) {
        nextCheck = lastAttempt + hour;
        return;
      }
      nextCheck = timestamp + hour;
      if (stopped) return;
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = file + '.tmp';
      await fs.writeFile(temporary, JSON.stringify({ lastAttemptAt: timestamp }));
      await fs.rename(temporary, file);
      if (!stopped) await check();
    } catch {
      // Automatic check failures stay quiet. The File menu remains available.
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(() => void tick(), Math.max(1, nextCheck - now()));
        timer.unref?.();
      }
    }
  }
  const ready = tick();
  return {
    ready,
    tick,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

async function acknowledgeUpdate(app) {
  const raw = process.env.PRISM_WINDOWS_UPDATE_ACK;
  if (!raw) return;
  const ack = JSON.parse(raw);
  if (typeof ack.path !== 'string' || !path.isAbsolute(ack.path) || !/^[a-f0-9]{64}$/.test(ack.token))
    throw new Error('Invalid update acknowledgement.');
  const relative = path.relative(path.join(app.getPath('userData'), 'updates'), ack.path);
  if (
    relative.split(path.sep).length !== 2 ||
    !/^install-[a-zA-Z0-9]+$/.test(relative.split(path.sep)[0]) ||
    path.basename(ack.path) !== 'ack.json'
  )
    throw new Error('Invalid update acknowledgement location.');
  await fs.writeFile(
    ack.path,
    JSON.stringify({ token: ack.token, pid: process.pid, version: app.getVersion() }),
    { flag: 'wx' },
  );
  delete process.env.PRISM_WINDOWS_UPDATE_ACK;
}
module.exports = {
  createUpdater,
  startAutomaticChecks,
  acknowledgeUpdate,
  checkManifest,
  isNewer,
  zipEntries,
  extractArchive,
  validateInstallation,
  validSignature,
};

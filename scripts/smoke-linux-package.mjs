import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [operation, scratch] = process.argv.slice(2);
if (!['create', 'verify'].includes(operation) || !isAbsolute(scratch || '') ||
    !/^prism-linux-smoke\.[A-Za-z0-9]+$/.test(basename(scratch)) || !process.getuid?.())
  throw new Error('Run as a desktop user with create|verify and a new private prism-linux-smoke.XXXXXX directory.');
const info = await lstat(scratch);
assert(info.isDirectory() && info.uid === process.getuid() && !(info.mode & 0o077));
const resources = '/opt/prism-preview/resources';
const origin = 'http://127.0.0.1:38874';
const endpoint = origin + '/api/v1/';
const state = join(scratch, 'fixture.json');
const noteID = '11111111-2222-4222-8222-000000000001';
const referenceID = '11111111-2222-4222-8222-000000000002';
const attachmentID = '11111111-2222-4222-8222-000000000003';
const pdf = Buffer.from('%PDF-1.7\nSynthetic package verification attachment.');
const title = 'Disposable Linux package fixture';
const token = randomBytes(32).toString('hex');
const cookie = { Cookie: `prism_desktop=${token}` };
let runtime;

function launch() {
  const process = spawn(join(resources, 'runtime/node'), [join(resources, 'app/launch.mjs')], {
    env: {
      PRISM_DESKTOP_TOKEN: token,
      PRISM_DATA_DIR: join(scratch, 'workspace'),
      PRISM_DESKTOP_RUNTIME: join(resources, 'desktop'),
      PRISM_WORKER_ENABLED: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const close = once(process, 'close');
  let errors = '';
  process.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-8000); });
  return { process, close, errors: () => errors };
}

async function start() {
  runtime = launch();
  const { process, close, errors } = runtime;
  await Promise.race([
    new Promise((resolve) => {
      process.on('message', (message) => { if (message?.type === 'ready') resolve(); });
    }),
    close.then(() => { throw new Error(errors() || 'Packaged services exited before readiness.'); }),
    delay(85000, undefined, { ref: false }).then(() => { throw new Error('Packaged startup timed out.'); }),
  ]);
}

async function stop() {
  if (!runtime) return;
  const { process, close } = runtime;
  runtime = undefined;
  if (process.connected) process.send({ type: 'shutdown' }, () => {});
  const result = await Promise.race([close, delay(10000, undefined, { ref: false })]);
  if (!result) {
    process.kill('SIGTERM');
    await close;
    throw new Error('Packaged shutdown timed out.');
  }
  assert.deepEqual(result, [0, null]);
}

function request(path, options = {}) {
  return fetch(endpoint + path, { ...options, signal: AbortSignal.timeout(7000) });
}

async function mutate(path, method, body, key, version) {
  const response = await request(path, {
    method,
    headers: {
      ...cookie,
      Origin: origin,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      ...(version === undefined ? {} : { 'If-Match': `"${version}"` }),
    },
    body: JSON.stringify(body),
  });
  assert(response.ok, await response.text());
}

try {
  await start();
  assert.equal((await request('me')).status, 401);
  assert.equal((await request('me', { headers: { ...cookie, Origin: 'https://example.invalid' } })).status, 403);
  const page = await fetch(origin + '/today', { headers: cookie, signal: AbortSignal.timeout(7000) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /PRISM/);
  if (operation === 'create') {
    const initial = await request('knowledge-items', { headers: cookie });
    assert.deepEqual((await initial.json()).items, []);
    await mutate('knowledge-items', 'POST', { id: noteID, title, type: 'definition', content: 'Synthetic test data' }, noteID);
    await mutate('research/references', 'POST', { id: referenceID, title }, referenceID);
    await mutate(`research/references/${referenceID}/attachments`, 'POST', {
      id: attachmentID, format: 'pdf', file_name: 'Fixture.pdf', size_bytes: pdf.length,
      sha256: createHash('sha256').update(pdf).digest('hex'),
    }, attachmentID);
    await mutate(`research/attachments/${attachmentID}/chunk`, 'PUT', { offset: 0, data: pdf.toString('base64') },
      '11111111-2222-4222-8222-000000000004');
    await mutate(`research/attachments/${attachmentID}/complete`, 'POST', {},
      '11111111-2222-4222-8222-000000000005');
    const prefs = await (await request('me/preferences', { headers: cookie })).json();
    await mutate('me/preferences', 'PATCH', { desired_retention: 0.95 }, '11111111-2222-4222-8222-000000000006', prefs.version);
    await writeFile(state, 'created\n', { flag: 'wx', mode: 0o600 });
  } else {
    assert.equal(await readFile(state, 'utf8'), 'created\n');
    const note = await request(`knowledge-items/${noteID}`, { headers: cookie });
    assert.equal(note.status, 200);
    assert.equal((await note.json()).title, title);
    const prefs = await request('me/preferences', { headers: cookie });
    assert.equal((await prefs.json()).desired_retention, 0.95);
    const attachment = await request(`research/attachments/${attachmentID}/download`, { headers: cookie });
    assert.equal(attachment.status, 200);
    assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), pdf);
  }
} finally {
  await stop();
}
const blockingServer = createServer().listen(38874, '127.0.0.1');
await once(blockingServer, 'listening');
try {
  const blocked = launch();
  assert.deepEqual(await blocked.close, [1, null]);
  assert.match(blocked.errors(), /EADDRINUSE/);
} finally {
  blockingServer.close();
}
console.log(`Linux package fixture ${operation} passed, including authentication and occupied port handling.`);

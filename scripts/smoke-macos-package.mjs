import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, mkdtemp, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const bundle = await realpath(resolve(process.argv[2]));
const plist = await readFile(join(bundle, 'Contents/Info.plist'), 'utf8');
assert.match(plist, /<key>PRISMPackaged<\/key><true\/>/);
assert.doesNotMatch(plist, /PRISMProjectRoot|\/Users\//);
const resources = join(bundle, 'Contents/Resources');
for (const entry of await readdir(resources, { recursive: true, withFileTypes: true })) {
  const path = join(entry.parentPath, entry.name);
  assert(
    !['.data', '.git', 'postmaster.pid', 'PG_VERSION'].includes(entry.name),
    'Unexpected workspace files',
  );
  assert(!/^\.env(?:\.|$)/.test(entry.name), 'Unexpected environment file');
  if (entry.isSymbolicLink()) {
    assert(!isAbsolute(await readlink(path)), `Absolute runtime link at ${path}`);
    assert((await realpath(path)).startsWith(resources + sep), `External runtime link at ${path}`);
  }
}
if (process.argv.includes('--files-only')) process.exit(0);

const scratch = await mkdtemp(join(tmpdir(), 'prism-smoke-'));
const node = join(bundle, 'Contents/MacOS/node');
const launch = join(resources, 'desktop/launch.mjs');
const token = randomBytes(32).toString('hex');
const localHeaders = { Cookie: `prism_desktop=${token}` };
const dataDir = join(scratch, 'workspace');
const readyFile = join(scratch, 'ready');
let processToStop;

async function choosePort() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function start() {
  const port = await choosePort();
  const child = spawn(node, [launch], {
    cwd: scratch,
    env: {
      PRISM_DATA_DIR: dataDir,
      PRISM_DESKTOP_TOKEN: token,
      PRISM_DESKTOP_READY_FILE: readyFile,
      PRISM_DESKTOP_WEB_PORT: String(port),
      PRISM_WORKER_ENABLED: 'false',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  processToStop = child;
  const timeout = Date.now() + 80000;
  while (Date.now() < timeout) {
    assert.equal(child.exitCode, null, 'Desktop runtime exited before readiness');
    try {
      const record = JSON.parse(await readFile(readyFile, 'utf8'));
      assert.equal(record.webOrigin, `http://127.0.0.1:${port}`);
      assert.match(record.apiOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
      return record;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(200);
  }
  throw new Error('Desktop runtime did not start');
}

async function stop() {
  const child = processToStop;
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const result = await Promise.race([exited, delay(8000, null, { ref: false })]);
  if (!result) {
    child.kill('SIGKILL');
    throw new Error('Desktop runtime did not shut down');
  }
  assert.equal(result[0], 0);
}

function getStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const client = request(url, { headers, timeout: 5000 }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    client.once('timeout', () => client.destroy(new Error('Request timed out')));
    client.once('error', reject);
    client.end();
  });
}

try {
  const { apiOrigin, webOrigin } = await start();
  const endpoint = `${webOrigin}/api/v1/knowledge-items`;
  assert.equal(await getStatus(endpoint, {}), 401);
  assert.equal(await getStatus(endpoint, { ...localHeaders, Host: 'public.example' }), 403);
  assert.equal(await getStatus(endpoint, { ...localHeaders, Origin: 'https://public.example' }), 403);
  assert.equal(await getStatus(endpoint, { ...localHeaders, 'Sec-Fetch-Site': 'cross-site' }), 403);
  assert.equal(await getStatus(`${apiOrigin}/health`, {}), 401);
  const authorization = { Authorization: `Bearer ${token}` };
  assert.equal(await getStatus(`${apiOrigin}/health`, { ...authorization, Host: 'public.example' }), 403);
  assert.equal(
    await getStatus(`${apiOrigin}/health`, { ...authorization, Origin: 'https://public.example' }),
    403,
  );
  assert.equal(await getStatus(`${apiOrigin}/health`, authorization), 200);
  const today = await fetch(`${webOrigin}/today`, { headers: localHeaders });
  assert.equal(today.status, 200);
  assert.match(await today.text(), /PRISM/);
  const empty = await fetch(endpoint, { headers: localHeaders });
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).items, []);
  const title = 'Disposable package smoke note';
  const id = randomUUID();
  const saved = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...localHeaders,
      Origin: webOrigin,
      'Content-Type': 'application/json',
      'Idempotency-Key': id,
    },
    body: JSON.stringify({ id, title, type: 'definition', content: 'Synthetic test data' }),
  });
  assert.equal(saved.status, 201);
  assert.equal((await saved.json()).id, id);
  await stop();
  const restarted = await start();
  const item = await fetch(`${restarted.webOrigin}/api/v1/knowledge-items/${id}`, { headers: localHeaders });
  assert.equal(item.status, 200);
  assert.equal((await item.json()).title, title);
  const filtered = await fetch(`${restarted.webOrigin}/api/v1/knowledge-items?type=theorem`, {
    headers: localHeaders,
  });
  assert.equal(filtered.status, 200);
  assert.deepEqual((await filtered.json()).items, []);
  console.log('Packaged PRISM verified with isolated ports and a fresh workspace.');
} finally {
  try {
    await stop();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

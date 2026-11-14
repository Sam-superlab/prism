import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, open, readFile, mkdtemp, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
const backupDir = join(scratch, 'backup');
const readyFile = join(scratch, 'ready');
let processToStop;
await mkdir(backupDir, { mode: 0o700 });

async function choosePort() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function start(workspace = dataDir, recovery = false) {
  const port = recovery ? 0 : await choosePort();
  const sessionToken = recovery ? randomBytes(32).toString('hex') : token;
  const child = spawn(node, [launch], {
    cwd: scratch,
    env: {
      PRISM_DATA_DIR: workspace,
      PRISM_DESKTOP_TOKEN: sessionToken,
      PRISM_DESKTOP_READY_FILE: readyFile,
      PRISM_DESKTOP_WEB_PORT: String(port),
      PRISM_DESKTOP_PARENT_PID: String(process.pid),
      PRISM_WORKSPACE_BACKUP_DIR: backupDir,
      ...(recovery && { PRISM_RECOVERY_PREVIEW: 'true' }),
      PRISM_WORKER_ENABLED: 'false',
    },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  processToStop = child;
  const timeout = Date.now() + 80000;
  while (Date.now() < timeout) {
    assert.equal(child.exitCode, null, 'Desktop runtime exited before readiness');
    try {
      const record = JSON.parse(await readFile(readyFile, 'utf8'));
      if (recovery) assert.match(record.webOrigin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]+$/);
      else assert.equal(record.webOrigin, `http://127.0.0.1:${port}`);
      assert.match(record.apiOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
      return { ...record, sessionToken };
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(200);
  }
  throw new Error('Desktop runtime did not start');
}

async function backupRequest(operation, key, prepare) {
  const id = randomBytes(16).toString('hex');
  const folder = join(backupDir, id);
  const archive = join(folder, 'archive.prismbackup');
  await mkdir(folder, { mode: 0o700 });
  await prepare?.(archive);
  const command = JSON.stringify({ type: 'prism-workspace-backup', operation, id, key }) + '\n';
  await new Promise((resolve, reject) => processToStop.stdin.write(command, (error) => error ? reject(error) : resolve()));
  for (let attempt = 0; attempt < 250; attempt++) {
    assert.equal(processToStop.exitCode, null);
    try { return { archive, result: JSON.parse(await readFile(join(folder, 'result.json'), 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(100);
  }
  throw new Error('The packaged workspace backup did not respond.');
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
  async function mutate(path, method, body) {
    const response = await fetch(`${webOrigin}/api/v1/${path}`, {
      method, headers: { ...localHeaders, Origin: webOrigin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(body),
    });
    assert(response.ok, await response.text());
  }
  const reference = randomUUID();
  const attachment = randomUUID();
  const attachmentBytes = Buffer.from('%PDF-1.7\nSynthetic packaged workspace backup attachment.');
  await mutate('research/references', 'POST', { id: reference, title: 'Disposable backup reference' });
  await mutate(`research/references/${reference}/attachments`, 'POST', { id: attachment, format: 'pdf', file_name: 'Fixture.pdf',
    size_bytes: attachmentBytes.length, sha256: createHash('sha256').update(attachmentBytes).digest('hex') });
  await mutate(`research/attachments/${attachment}/chunk`, 'PUT', { offset: 0, data: attachmentBytes.toString('base64') });
  await mutate(`research/attachments/${attachment}/complete`, 'POST', {});
  const key = randomBytes(32).toString('hex');
  const created = await backupRequest('create', key);
  assert.deepEqual(created.result, { ok: true });
  assert.equal((await stat(created.archive)).mode & 0o777, 0o600);
  const archive = await readFile(created.archive);
  const magic = Buffer.from('PRISM-WORKSPACE-BACKUP-V2\n');
  assert(archive.subarray(0, magic.length).equals(magic));
  assert(!archive.includes(Buffer.from(title)));
  const decrypt = createDecipheriv('aes-256-gcm', hkdfSync('sha256', Buffer.from(key, 'hex'), 'PRISM backup',
    'workspace v2 AES-256-GCM', 32), archive.subarray(magic.length, magic.length + 12));
  decrypt.setAAD(magic);
  decrypt.setAuthTag(archive.subarray(archive.length - 16));
  const legacy = Buffer.concat([Buffer.from('PRISM-WORKSPACE-BACKUP-V1\n'),
    decrypt.update(archive.subarray(magic.length + 12, archive.length - 16)), decrypt.final()]);
  assert.deepEqual((await backupRequest('validate', key, (path) => writeFile(path, legacy, { mode: 0o600 }))).result,
    { ok: true, knowledgeItems: 1, attachments: 1 });
  assert.deepEqual((await backupRequest('validate', key, (archive) => symlink(created.archive, archive))).result,
    { ok: false, reason: 'invalid' });
  const validated = await backupRequest('validate', key, (archive) => rename(created.archive, archive));
  assert.deepEqual(validated.result, { ok: true, knowledgeItems: 1, attachments: 1 });
  const restored = await backupRequest('restore', key, (archive) => rename(validated.archive, archive));
  assert.deepEqual(restored.result, { ok: true });
  const wrongKey = await backupRequest('validate', randomBytes(32).toString('hex'), (archive) => rename(restored.archive, archive));
  assert.deepEqual(wrongKey.result, { ok: false, reason: 'invalid' });
  const corrupted = await backupRequest('validate', key, async (archive) => {
    await rename(wrongKey.archive, archive);
    const file = await open(archive, 'r+');
    try { await file.write(Buffer.from([archive.at(-1) ^ 1]), 0, 1, archive.length - 1); } finally { await file.close(); }
  });
  assert.deepEqual(corrupted.result, { ok: false, reason: 'invalid' });
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
  await stop();
  const recovered = await start(resolve(restored.archive, '..'), true);
  assert.notEqual(recovered.webOrigin, restarted.webOrigin);
  const recoveredHeaders = { Cookie: `prism_desktop=${recovered.sessionToken}` };
  assert.equal(await getStatus(`${recovered.webOrigin}/api/v1/me`, localHeaders), 401);
  assert.equal(await getStatus(`${recovered.webOrigin}/api/v1/research/library/lookup?kind=doi&value=10.1234/test`, recoveredHeaders), 403);
  assert.equal(await getStatus(`${recovered.webOrigin}/api/v1/research/references/${reference}/open-access`, recoveredHeaders), 403);
  const blocked = await fetch(`${recovered.webOrigin}/api/v1/knowledge-items`, {
    method: 'POST', headers: { ...recoveredHeaders, Origin: recovered.webOrigin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ id: randomUUID(), title: 'This write must be refused', type: 'note', content: 'Synthetic' }),
  });
  assert.equal(blocked.status, 403);
  const copiedNote = await fetch(`${recovered.webOrigin}/api/v1/knowledge-items/${id}`, { headers: recoveredHeaders });
  assert.equal(copiedNote.status, 200);
  assert.equal((await copiedNote.json()).title, title);
  const copiedAttachment = await fetch(`${recovered.webOrigin}/api/v1/research/attachments/${attachment}/download`, { headers: recoveredHeaders });
  assert.equal(copiedAttachment.status, 200);
  assert.deepEqual(Buffer.from(await copiedAttachment.arrayBuffer()), attachmentBytes);
  console.log('Packaged PRISM verified with isolated ports and a fresh workspace.');
} finally {
  try {
    await stop();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

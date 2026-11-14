import { spawn } from 'node:child_process';
import { lstat, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const {
  PRISM_DESKTOP_TOKEN: token,
  PRISM_DATA_DIR: dataDir,
  PRISM_DESKTOP_READY_FILE: readyFile,
} = process.env;
const parentPid = Number(process.env.PRISM_DESKTOP_PARENT_PID || 0);
const host = '127.0.0.1';
const recovery = process.env.PRISM_RECOVERY_PREVIEW === 'true';
let webPort = Number(process.env.PRISM_DESKTOP_WEB_PORT || 38741);
const children = [];
const backupDir = process.env.PRISM_WORKSPACE_BACKUP_DIR;
let stopping = false;

async function removeScratch(path, pattern, nested = false) {
  if (parentPid <= 1 || !isAbsolute(path || '') || !pattern.test(basename(path || ''))) return;
  const folder = await lstat(path).catch(() => null);
  const temp = await realpath(tmpdir()).catch(() => null);
  const parent = await realpath(dirname(path)).catch(() => null);
  const managed = nested ? parent && temp && dirname(parent) === temp && /^prism-workspace-backup\.[A-Za-z0-9]{6}$/.test(basename(parent)) : parent === temp;
  if (folder?.isDirectory() && folder.uid === process.getuid?.() && !(folder.mode & 0o077) && temp && managed)
    await rm(path, { recursive: true, force: true }).catch(() => {});
}

function testPort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, host, () => {
      const assigned = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(assigned)));
    });
  });
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const exited = Promise.all(children.map((child) => child.closed));
  await Promise.race([exited, delay(5000, undefined, { ref: false })]);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  if (readyFile) await unlink(readyFile).catch(() => {});
  await removeScratch(backupDir, /^prism-workspace-backup\.[A-Za-z0-9]{6}$/);
  if (recovery) await removeScratch(dataDir, /^[a-f0-9]{32}$/, true);
  process.exit(code);
}

function start(directory, args, env, ipc = false) {
  const cwd = fileURLToPath(new URL(directory, import.meta.url));
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit', ...(ipc ? ['ipc'] : [])] });
  child.closed = new Promise((resolve) => child.once('close', resolve));
  child.once('error', (error) => console.error(error.message));
  child.once('close', () => void stop(1));
  children.push(child);
  return child;
}

function forwardBackupRequests(api) {
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    if (pending.length > 4096) { pending = ''; return; }
    const messages = pending.split('\n');
    pending = messages.pop();
    for (const line of messages) {
      try { if (api.connected) api.send(JSON.parse(line), () => {}); } catch { /* Ignore invalid IPC input. */ }
    }
  });
}

async function ready(url, headers) {
  const deadline = Date.now() + 75000;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(1500) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // The service may still be starting.
    }
    await delay(250);
  }
  throw new Error('A PRISM service did not become ready.');
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void stop(0));
if (parentPid > 1) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      void stop(0);
    }
  }, 1000).unref();
}

try {
  if (!/^[0-9a-f]{64}$/.test(token || '') || !isAbsolute(dataDir || '') || !isAbsolute(readyFile || ''))
    throw new Error('PRISM requires a private workspace and a session token.');
  if (!Number.isInteger(webPort) || (webPort < 1024 && !(recovery && webPort === 0)) || webPort > 65535)
    throw new Error('Invalid PRISM desktop port.');
  webPort = await testPort(webPort);
  const webOrigin = `http://${host}:${webPort}`;
  const apiPort = await testPort(0);
  if (apiPort === webPort) throw new Error('The chosen PRISM ports conflict.');
  const apiOrigin = `http://${host}:${apiPort}`;
  const env = {
    PRISM_AUTH_MODE: 'desktop',
    PRISM_DATA_DIR: dataDir,
    PRISM_DESKTOP_TOKEN: token,
    PRISM_HOST: host,
    PRISM_WEB_ORIGIN: webOrigin,
    NEXT_TELEMETRY_DISABLED: '1',
  };
  const backup = !recovery && parentPid > 1 && isAbsolute(backupDir || '');
  const api = start('./apps/api/', ['--import', './node_modules/tsx/dist/loader.mjs', 'src/server.ts'], {
    ...env,
    NODE_ENV: 'development',
    PRISM_PORT: String(apiPort),
    PRISM_WORKER_ENABLED: process.env.PRISM_WORKER_ENABLED || 'true',
    ...(recovery && { PRISM_RECOVERY_PREVIEW: 'true' }),
    ...(backup && { PRISM_WORKSPACE_BACKUP_DIR: backupDir }),
  }, backup);
  if (backup) forwardBackupRequests(api);
  await ready(`${apiOrigin}/health`, { Authorization: `Bearer ${token}` });
  start('./web/apps/web/', ['server.js'], {
    ...env,
    HOSTNAME: host,
    NODE_ENV: 'production',
    PORT: String(webPort),
    PRISM_API_URL: apiOrigin,
    ...(recovery && { PRISM_RECOVERY_PREVIEW: 'true' }),
  });
  await ready(`${webOrigin}/api/v1/me`, { Cookie: `prism_desktop=${token}` });
  await writeFile(readyFile, JSON.stringify({ apiOrigin, webOrigin }), { flag: 'wx', mode: 0o600 });
} catch (error) {
  console.error(error.message);
  await stop(1);
}

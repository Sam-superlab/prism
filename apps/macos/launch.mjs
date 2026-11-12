import { spawn } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const {
  PRISM_DESKTOP_TOKEN: token,
  PRISM_DATA_DIR: dataDir,
  PRISM_DESKTOP_READY_FILE: readyFile,
} = process.env;
const parentPid = Number(process.env.PRISM_DESKTOP_PARENT_PID || 0);
const host = '127.0.0.1';
const webPort = Number(process.env.PRISM_DESKTOP_WEB_PORT || 38741);
const webOrigin = `http://${host}:${webPort}`;
const children = [];
let stopping = false;

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
  process.exit(code);
}

function start(directory, args, env) {
  const cwd = fileURLToPath(new URL(directory, import.meta.url));
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
  child.closed = new Promise((resolve) => child.once('close', resolve));
  child.once('error', (error) => console.error(error.message));
  child.once('close', () => void stop(1));
  children.push(child);
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
  if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535)
    throw new Error('Invalid PRISM desktop port.');
  await testPort(webPort);
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
  start('./apps/api/', ['--import', './node_modules/tsx/dist/loader.mjs', 'src/server.ts'], {
    ...env,
    NODE_ENV: 'development',
    PRISM_PORT: String(apiPort),
    PRISM_WORKER_ENABLED: process.env.PRISM_WORKER_ENABLED || 'true',
  });
  await ready(`${apiOrigin}/health`, { Authorization: `Bearer ${token}` });
  start('./web/apps/web/', ['server.js'], {
    ...env,
    HOSTNAME: host,
    NODE_ENV: 'production',
    PORT: String(webPort),
    PRISM_API_URL: apiOrigin,
  });
  await ready(`${webOrigin}/api/v1/me`, { Cookie: `prism_desktop=${token}` });
  await writeFile(readyFile, JSON.stringify({ apiOrigin, webOrigin }), { flag: 'wx', mode: 0o600 });
} catch (error) {
  console.error(error.message);
  await stop(1);
}

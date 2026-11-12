import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { PRISM_DESKTOP_TOKEN: token, PRISM_DATA_DIR: dataDir, PRISM_DESKTOP_RUNTIME: runtime } = process.env;
const host = '127.0.0.1';
const webPort = 38741;
const webOrigin = `http://${host}:${webPort}`;
const wrapper = fileURLToPath(new URL('./service.mjs', import.meta.url));
const children = [];
let stopping = false;
function portFree(port) {
  return new Promise((resolve, reject) => {
    const server = createServer().listen(port, host);
    server.once('error', reject);
    server.once('listening', () => {
      const actual = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(actual)));
    });
  });
}
async function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.connected) child.send({ type: 'shutdown' });
  await Promise.race([Promise.all(children.map((child) => child.closed)), delay(7000)]);
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(code);
}
function start(cwd, imports, target, env) {
  const child = spawn(process.execPath, [...imports, wrapper, pathToFileURL(join(cwd, target)).href], {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.closed = new Promise((resolve) => child.once('close', resolve));
  child.once('error', (error) => {
    console.error(error.message);
    void stop(1);
  });
  child.once('close', () => {
    if (!stopping) void stop(1);
  });
  children.push(child);
}
async function ready(url, headers) {
  for (let attempt = 0; attempt < 300 && !stopping; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1500), redirect: 'error' });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      /* Services may still be starting. */
    }
    await delay(250);
  }
  throw new Error('A PRISM service did not start.');
}
process.on('message', (message) => {
  if (message?.type === 'shutdown') void stop(0);
});
process.on('disconnect', () => void stop(0));
try {
  if (!/^[a-f0-9]{64}$/.test(token || '') || !isAbsolute(dataDir || '') || !isAbsolute(runtime || ''))
    throw new Error('PRISM requires a private local workspace and session.');
  await portFree(webPort);
  const apiPort = await portFree(0);
  const apiOrigin = `http://${host}:${apiPort}`;
  const env = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    PRISM_AUTH_MODE: 'desktop',
    PRISM_DESKTOP_TOKEN: token,
    PRISM_DATA_DIR: dataDir,
    PRISM_HOST: host,
    PRISM_WEB_ORIGIN: webOrigin,
    NEXT_TELEMETRY_DISABLED: '1',
  };
  start(join(runtime, 'apps/api'), ['--import', './node_modules/tsx/dist/loader.mjs'], 'src/server.ts', {
    ...env,
    NODE_ENV: 'development',
    PRISM_PORT: String(apiPort),
    PRISM_WORKER_ENABLED: process.env.PRISM_WORKER_ENABLED,
  });
  await ready(`${apiOrigin}/health`, { Authorization: `Bearer ${token}` });
  start(join(runtime, 'web/apps/web'), [], 'server.js', {
    ...env,
    NODE_ENV: 'production',
    HOSTNAME: host,
    PORT: String(webPort),
    PRISM_API_URL: apiOrigin,
  });
  await ready(`${webOrigin}/api/v1/me`, { Cookie: `prism_desktop=${token}` });
  process.send?.({ type: 'ready' });
} catch (error) {
  console.error(error.message);
  await stop(1);
}

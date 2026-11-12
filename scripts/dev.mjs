import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { createMacUpdateServer, macUpdateHost, macUpdatePort } from './serve-macos-updates.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  loadEnvFile(resolve(root, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (process.env.NODE_ENV === 'production')
  throw new Error('Use the production start commands; the development launcher cannot run in production.');
const apiPort = Number(process.env.PRISM_PORT ?? 4000);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535 || apiPort === 3000)
  throw new Error('PRISM_PORT must be an available API port distinct from Web port 3000.');
const { OPENAI_API_KEY: openaiApiKey, ...launcherEnv } = process.env;
const env = {
  ...launcherEnv,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  NODE_ENV: 'development',
  PRISM_AUTH_MODE: 'development',
  PRISM_HOST: '127.0.0.1',
  PRISM_DATA_DIR: resolve(root, process.env.PRISM_DATA_DIR ?? '.data'),
  PRISM_WEB_ORIGIN: process.env.PRISM_WEB_ORIGIN ?? 'http://localhost:3000',
  PRISM_API_URL: process.env.PRISM_API_URL ?? `http://127.0.0.1:${apiPort}`,
};
for (const [value, port] of [
  [env.PRISM_WEB_ORIGIN, 3000],
  [env.PRISM_API_URL, apiPort],
]) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    Number(url.port || 80) !== port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      `Local launcher URL must use localhost or 127.0.0.1 on port ${port}. Check PRISM_WEB_ORIGIN and PRISM_API_URL.`,
    );
}
env.PRISM_WEB_ORIGIN = new URL(env.PRISM_WEB_ORIGIN).origin;
env.PRISM_API_URL = new URL(env.PRISM_API_URL).origin;
const webUrl = new URL('/today', env.PRISM_WEB_ORIGIN).href;
const lockPath = resolve(root, '.data/dev-launcher.json');
const owner = {
  pid: process.pid,
  nonce: randomUUID(),
  root,
  dataDir: env.PRISM_DATA_DIR,
  apiUrl: env.PRISM_API_URL,
  webUrl,
  phase: 'starting',
};
const children = [];
let macUpdateServer;
let ownsLock = false;
let stopping = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function readLock() {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
function releaseLock() {
  if (ownsLock && readLock()?.nonce === owner.nonce) {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(error.message);
    }
  }
}
function setPhase(phase) {
  if (!ownsLock || readLock()?.nonce !== owner.nonce) return;
  owner.phase = phase;
  const temp = `${lockPath}.${owner.nonce}.tmp`;
  writeFileSync(temp, JSON.stringify(owner), { mode: 0o600 });
  renameSync(temp, lockPath);
}
async function acquireLock() {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(owner));
      } finally {
        closeSync(fd);
      }
      ownsLock = true;
      return null;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = readLock();
      if (!previous) {
        await delay(50);
        continue;
      }
      if (previous.root !== root || !Number.isInteger(previous.pid) || !previous.nonce)
        throw new Error('启动记录无效。请关闭本项目的启动器后，删除 .data/dev-launcher.json 再重试。');
      if (isAlive(previous.pid)) return previous;
      // Serialize stale-owner eviction so concurrent launchers cannot unlink a newly acquired lock.
      const recoveryPath = `${lockPath}.recovery`;
      try {
        mkdirSync(recoveryPath, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await delay(50);
        continue;
      }
      try {
        const current = readLock();
        if (current?.nonce === previous.nonce && !isAlive(current.pid)) {
          // Never signal a PID from an old record.
          unlinkSync(lockPath);
        }
      } finally {
        try {
          rmdirSync(recoveryPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }
  throw new Error('另一个启动器尚在初始化，请稍后重试。');
}
function groupAlive(child) {
  if (!child.pid) return false;
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
function signalChild(child, signal) {
  if (!groupAlive(child)) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') console.error(error.message);
  }
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  macUpdateServer?.close();
  macUpdateServer?.closeAllConnections();
  try {
    setPhase('stopping');
  } catch (error) {
    console.error(`无法更新启动记录，仍会停止本次服务：${error.code ?? 'IO_ERROR'}`);
  }
  for (const child of children) signalChild(child, 'SIGTERM');
  const deadline = Date.now() + 8000;
  while (children.some(groupAlive) && Date.now() < deadline) await delay(100);
  for (const child of children) signalChild(child, 'SIGKILL');
  process.exit(code);
}
function start(name) {
  // Starting PRISM from Finder has no terminal for pnpm's automatic reinstall prompt.
  const child = spawn('pnpm', ['--config.verify-deps-before-run=false', '--filter', name, 'dev'], {
    cwd: root,
    env: name === '@prism/api' && openaiApiKey ? { ...env, OPENAI_API_KEY: openaiApiKey } : env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
  children.push(child);
  child.on('error', (error) => {
    console.error(error.message);
    void stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`${name} 提前退出（${signal ?? code}），正在停止本次启动的服务。`);
      void stop(1);
    }
  });
}
async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `端口 ${port} 已被占用。本次未启动新服务，也未停止占用端口的程序。若 PRISM 已运行，请打开 ${webUrl}；否则请先关闭占用程序。`,
            )
          : error,
      ),
    );
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
async function servicesReady(includeWeb) {
  try {
    const health = await fetch(`${env.PRISM_API_URL}/health`, { signal: AbortSignal.timeout(1000) });
    const body = await health.json();
    if (!health.ok || body.status !== 'ok' || body.auth_mode !== 'development') return false;
    const endpoints = [`${env.PRISM_API_URL}/api/v1/me`];
    if (includeWeb) endpoints.push(webUrl, new URL('/api/v1/me', env.PRISM_WEB_ORIGIN).href);
    return (
      await Promise.all(endpoints.map((url) => fetch(url, { signal: AbortSignal.timeout(1500) })))
    ).every((r) => r.ok);
  } catch {
    return false;
  }
}
async function waitReady(includeWeb, previous) {
  const deadline = Date.now() + 90000;
  while (!stopping && Date.now() < deadline) {
    if (previous) {
      const current = readLock();
      if (current?.nonce !== previous.nonce || !isAlive(previous.pid) || current.phase === 'stopping')
        return false;
      if (current.phase !== 'ready') {
        await delay(250);
        continue;
      }
    }
    if (await servicesReady(includeWeb)) return true;
    await delay(250);
  }
  return false;
}
function showReady(reused = false) {
  console.log(
    `\n${reused ? 'PRISM 已在运行，已复用现有实例。' : 'PRISM 已启动。'}\nWeb ${webUrl}\nAPI ${env.PRISM_API_URL}\n`,
  );
  if (process.env.PRISM_OPEN_BROWSER === '1' && process.platform === 'darwin') {
    const browser = spawn('open', [webUrl], { env, stdio: 'ignore' });
    browser.on('error', () => console.error(`请在浏览器打开 ${webUrl}`));
    browser.unref();
  }
}
process.once('exit', () => {
  for (const child of children) signalChild(child, 'SIGTERM');
  releaseLock();
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void stop());
try {
  const previous = await acquireLock();
  if (previous) {
    if (
      previous.dataDir !== owner.dataDir ||
      previous.apiUrl !== owner.apiUrl ||
      previous.webUrl !== owner.webUrl
    )
      throw new Error('本项目已有使用不同配置的启动器。请先在原终端按 Ctrl+C 停止，再重新启动。');
    if (!(await waitReady(true, previous)))
      throw new Error('已有启动器尚未就绪或已停止。请查看原终端输出后重试。');
    showReady(true);
  } else {
    await assertPortFree(3000);
    await assertPortFree(apiPort);
    if (process.platform === 'darwin') {
      macUpdateServer = createMacUpdateServer(root);
      macUpdateServer.on('error', (error) => {
        console.error(`PRISM 本机更新服务不可用（${error.code ?? 'IO_ERROR'}）。`);
      });
      macUpdateServer.listen(macUpdatePort, macUpdateHost);
    }
    start('@prism/api');
    if (!(await waitReady(false))) throw new Error('API 未能就绪，请查看上方启动输出。');
    if (!stopping) start('@prism/web');
    if (!(await waitReady(true))) throw new Error('Web 未能就绪，请查看上方启动输出。');
    if (!stopping) {
      setPhase('ready');
      showReady();
    }
  }
} catch (error) {
  if (!stopping) console.error(error.message);
  await stop(1);
}

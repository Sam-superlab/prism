import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lock = resolve(root, '.data/dev-launcher.json');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readLock = async () => JSON.parse(await readFile(lock, 'utf8'));
const exists = async (file) =>
  access(file).then(
    () => true,
    () => false,
  );
async function free(port) {
  return new Promise((resolve) => {
    const server = tcpServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
async function until(check, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await delay(100);
  }
  throw new Error('Launcher condition timed out');
}
async function healthy() {
  const health = await fetch('http://127.0.0.1:4000/health', { signal: AbortSignal.timeout(1500) });
  const web = await fetch('http://localhost:3000/api/v1/me', { signal: AbortSignal.timeout(1500) });
  return health.ok && web.ok;
}

test('local launcher ownership and duplicate startup', { timeout: 180000 }, async (t) => {
  assert.equal(await exists(lock), false, 'Stop the running local launcher before this integration test');
  assert.ok(
    (await free(3000)) && (await free(4000)),
    'Ports 3000/4000 must be free; no existing server is stopped by this test',
  );
  const data = await mkdtemp(resolve(tmpdir(), 'prism-launcher-test-'));
  const active = new Set();
  const env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    NODE_ENV: 'development',
    PRISM_DATA_DIR: data,
    PRISM_OPEN_BROWSER: '0',
    PRISM_WORKER_ENABLED: 'false',
    PRISM_PORT: '4000',
    PRISM_API_URL: 'http://127.0.0.1:4000',
    PRISM_WEB_ORIGIN: 'http://localhost:3000',
  };
  function launch() {
    const child = spawn('./start.command', [], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const exited = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        active.delete(child);
        resolve({ code, signal, output });
      });
    });
    active.add(child);
    return { child, exited, output: () => output };
  }
  async function exit(result, timeout = 15000) {
    let timer;
    try {
      return await Promise.race([
        result.exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Launcher did not exit: ${result.output()}`)), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function stop(result) {
    result.child.kill('SIGINT');
    assert.equal((await exit(result)).code, 0, result.output());
    await until(async () => !(await exists(lock)) && (await free(3000)) && (await free(4000)), 15000);
  }
  try {
    for (const port of [3000, 4000]) {
      await t.test(`unrelated port ${port} owner is preserved and no service starts`, async () => {
        const unrelated = createServer((_, response) => response.end('unrelated fixture'));
        await new Promise((resolve) => unrelated.listen(port, '127.0.0.1', resolve));
        try {
          const result = await exit(launch());
          assert.equal(result.code, 1, result.output);
          assert.match(result.output, new RegExp(`端口 ${port} 已被占用`));
          assert.equal(await free(port === 3000 ? 4000 : 3000), true);
          assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'unrelated fixture');
          assert.equal(await exists(lock), false);
        } finally {
          await new Promise((resolve) => unrelated.close(resolve));
        }
      });
    }
    await t.test('dead owner record is recovered, ready duplicate reuses the same instance', async () => {
      await writeFile(
        lock,
        JSON.stringify({
          pid: 2147483647,
          nonce: 'dead-test-owner',
          root,
          dataDir: data,
          apiUrl: env.PRISM_API_URL,
          webUrl: 'http://localhost:3000/today',
          phase: 'starting',
        }),
        { mode: 0o600 },
      );
      const first = launch();
      await until(async () => (await readLock()).phase === 'ready');
      const before = await readLock();
      assert.equal(before.pid, first.child.pid);
      assert.ok(await healthy());
      const duplicate = await exit(launch());
      assert.equal(duplicate.code, 0, duplicate.output);
      assert.match(duplicate.output, /已复用现有实例/);
      assert.equal((await readLock()).nonce, before.nonce);
      assert.equal(first.child.exitCode, null);
      assert.ok(await healthy());
      await stop(first);
    });
    for (const stale of [false, true])
      await t.test(
        `simultaneous launches with ${stale ? 'stale record and shutdown write failure' : 'fresh lock'} keep one owner`,
        async () => {
          if (stale)
            await writeFile(
              lock,
              JSON.stringify({
                pid: 2147483647,
                nonce: 'dead-concurrent-owner',
                root,
                dataDir: data,
                apiUrl: env.PRISM_API_URL,
                webUrl: 'http://localhost:3000/today',
                phase: 'starting',
              }),
              { mode: 0o600 },
            );
          const a = launch(),
            b = launch();
          await until(async () => (await readLock()).phase === 'ready');
          const owner = await readLock();
          assert.ok([a.child.pid, b.child.pid].includes(owner.pid));
          const first = owner.pid === a.child.pid ? a : b;
          const second = first === a ? b : a;
          const result = await exit(second);
          assert.equal(result.code, 0, result.output);
          assert.match(result.output, /已复用现有实例/);
          assert.equal(first.child.exitCode, null);
          assert.ok(await healthy());
          const blocked = `${lock}.${owner.nonce}.tmp`;
          if (stale) await mkdir(blocked);
          try {
            await stop(first);
            if (stale) assert.match(first.output(), /仍会停止本次服务/);
          } finally {
            if (stale) await rm(blocked, { recursive: true, force: true });
          }
        },
      );
  } finally {
    for (const child of active) child.kill('SIGTERM');
    await until(async () => active.size === 0, 15000);
    await rm(data, { recursive: true, force: true });
  }
});

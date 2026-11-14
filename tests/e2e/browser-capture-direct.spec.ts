import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';

async function localPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function stop(child: ChildProcess) {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Process already stopped. */ }
  }
}

test('saves one reference from an actual Chromium extension to an isolated desktop workspace', async ({ request, browserName }) => {
  test.skip(browserName !== 'chromium', 'This fixture loads an unpacked Chromium extension.');
  test.setTimeout(90_000);
  const dir = await mkdtemp(join(tmpdir(), 'prism-capture-direct-test-'));
  const desktop = randomBytes(32).toString('hex');
  const children: ChildProcess[] = [];
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  const logs: string[] = [];
  const dist = `.next-e2e-capture-${randomUUID()}`;
  try {
    const webPort = await localPort();
    let apiPort = await localPort();
    while (apiPort === webPort) apiPort = await localPort();
    const origin = `http://127.0.0.1:${webPort}`;
    const apiOrigin = `http://127.0.0.1:${apiPort}`;
    const environment = { ...process.env, PRISM_AUTH_MODE: 'desktop', PRISM_HOST: '127.0.0.1', PRISM_PORT: String(apiPort),
      PRISM_WEB_ORIGIN: origin, PRISM_API_URL: apiOrigin, PRISM_DESKTOP_TOKEN: desktop, PRISM_DATA_DIR: join(dir, 'data'),
      PRISM_WORKER_ENABLED: 'false', PRISM_NEXT_DIST_DIR: dist, PRISM_RECOVERY_PREVIEW: 'false', DATABASE_URL: '', REDIS_URL: '',
      NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
    for (const args of [
      ['--filter', '@prism/api', 'exec', 'tsx', 'src/server.ts'],
      ['--filter', '@prism/web', 'exec', 'next', 'dev', '--hostname', '127.0.0.1', '--port', String(webPort)],
    ]) {
      const child = spawn('pnpm', args, { env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      for (const stream of [child.stdout, child.stderr]) stream?.on('data', (data) => logs.push(String(data)));
    }
    const cookie = `prism_desktop=${desktop}`;
    const bridge = `${origin}/api/browser-capture`;
    await expect.poll(async () => {
      try {
        const backend = await request.get(`${apiOrigin}/health`, { headers: { Authorization: `Bearer ${desktop}` }, timeout: 2000 });
        const frontend = await request.get(bridge, { headers: { Cookie: cookie }, timeout: 2000 });
        return [backend.status(), frontend.status()];
      } catch { return []; }
    }, { timeout: 35_000 }).toEqual([200, 204]);

    const extensionDir = join(dir, 'extension');
    await mkdir(extensionDir);
    const manifest = JSON.parse(await readFile('apps/browser-capture/manifest.json', 'utf8'));
    // A test-only worker identifies the assigned extension origin. The popup is the product source.
    await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({ ...manifest, background: { service_worker: 'worker.js' } }));
    await writeFile(join(extensionDir, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
    for (const file of ['popup.js', 'popup.css', 'popup.html'])
      await writeFile(join(extensionDir, file), await readFile(`apps/browser-capture/${file}`));
    context = await chromium.launchPersistentContext(join(dir, 'profile'), {
      channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const popupUrl = new URL('popup.html', worker.url()).href;
    const popup = await context.newPage();
    // Stub active-tab capture while retaining the real extension-page Origin and native fetch.
    await context.addInitScript(() => {
      if (location.protocol !== 'chrome-extension:') return;
      Object.defineProperty(chrome.tabs, 'query', { value: async () => [{ id: 9 }] });
      Object.defineProperty(chrome.scripting, 'executeScript', { value: async () => [{ result: {
        title: 'Synthetic browser title', transfer: JSON.stringify({ format: 'prism-reference-v1', capture: { fields: {
          title: 'Synthetic browser reference', authors: ['Example, Ada'], doi: '10.5555/browser-capture-fixture', url: 'https://example.test/paper',
        } } }),
      } }] });
    });
    await popup.goto(popupUrl);
    await expect(popup.getByRole('status')).toHaveText('Synthetic browser title');
    const app = await context.newPage();
    await context.addCookies([{ name: 'prism_desktop', value: desktop, url: origin, httpOnly: true, sameSite: 'Strict' }]);
    await app.goto(`${origin}/research/library`);
    await app.getByRole('button', { name: 'Capture from browser' }).click();
    await app.getByText('Save directly from the extension', { exact: true }).click();
    await app.getByRole('button', { name: 'Generate save code' }).click();
    const issued = app.getByLabel('One-time save code');
    await expect(issued).toHaveValue(new RegExp(`^prism1\\.${webPort}\\.[A-Za-z0-9_-]{43}$`));
    const code = await issued.inputValue();
    const token = code.split('.')[2];
    expect((await request.post(bridge, { headers: { Origin: 'https://example.test', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, data: '{}' })).status()).toBe(403);
    await popup.getByText('Save to PRISM Desktop', { exact: true }).click();
    await popup.getByLabel('One-time save code').fill(code);
    await popup.getByRole('button', { name: 'Save this reference' }).click();
    await expect(popup.getByRole('status')).toHaveText('Saved to PRISM Desktop.');
    await popup.getByLabel('One-time save code').fill(code);
    await popup.getByRole('button', { name: 'Save this reference' }).click();
    await expect(popup.getByRole('status')).toHaveText('Saved to PRISM Desktop.');
    await app.getByRole('button', { name: 'Revoke save code' }).click();
    await expect(app.getByText('Save code revoked.')).toBeVisible();
    await popup.getByLabel('One-time save code').fill(code);
    await popup.getByRole('button', { name: 'Save this reference' }).click();
    await expect(popup.getByRole('status')).toHaveText('Generate a new save code in PRISM Desktop.');
    await app.getByRole('button', { name: 'Cancel' }).click();
    await expect(app.getByRole('link', { name: 'Synthetic browser reference', exact: true })).toBeVisible();
    const results = await request.get(`${origin}/api/v1/research/library?q=Synthetic%20browser%20reference`, { headers: { Cookie: cookie } });
    expect(results.status()).toBe(200);
    expect((await results.json()).items).toMatchObject([{ title: 'Synthetic browser reference', doi: '10.5555/browser-capture-fixture' }]);
  } catch (error) {
    if (children.some((child) => child.exitCode)) console.error(logs.join('').replaceAll(desktop, '[desktop session]'));
    throw error;
  } finally {
    await context?.close();
    for (const child of children) stop(child);
    await Promise.all(children.map((child) => child.exitCode === null && child.signalCode === null
      ? new Promise<void>((resolve) => child.once('exit', () => resolve())) : Promise.resolve()));
    await Promise.all([rm(dir, { recursive: true, force: true, maxRetries: 6 }),
      rm(join('apps/web', dist), { recursive: true, force: true, maxRetries: 6 })]);
  }
});

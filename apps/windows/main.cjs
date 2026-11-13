const { app, BrowserWindow, dialog, Menu, session, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { mkdir, writeFile, unlink, access } = require('node:fs/promises');
const { join, isAbsolute } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createUpdater, acknowledgeUpdate, startAutomaticChecks } = require('./updater.cjs');
const { installFocusDesktop } = require('./focus-desktop.cjs');

app.setName('PRISM');
app.setAppUserModelId(process.execPath);
app.setPath('userData', join(app.getPath('appData'), 'PRISM Desktop'));
const smokeDir = process.env.PRISM_WINDOWS_SMOKE_DIR;
if (smokeDir) {
  if (!isAbsolute(smokeDir)) throw new Error('The test workspace must be an absolute directory.');
  app.setPath('userData', join(smokeDir, 'profile'));
}
let window;
let launcher;
let quitting = false;
let stopped = false;
let serviceStopping = false;
let smokeTimer;
let updater;
let dailyChecks;
let focusDesktop;
const token = randomBytes(32).toString('hex');
const origin = 'http://127.0.0.1:38741';
const local = (url) => {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
};
function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (/^zotero:\/\/select\/library\/items\/[A-Z0-9]{8}$/.test(parsed.href)) {
      void shell.openExternal(parsed.href).catch(() => {});
      return;
    }
    if (
      ['https:', 'http:'].includes(parsed.protocol) &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    )
      void shell.openExternal(parsed.href);
  } catch {
    /* Ignore malformed links. */
  }
}
async function shutdown() {
  serviceStopping = true;
  dailyChecks?.stop();
  focusDesktop?.dispose();
  clearInterval(smokeTimer);
  if (!launcher || launcher.exitCode !== null) return;
  const exited = new Promise((resolve) => launcher.once('exit', resolve));
  if (launcher.connected) launcher.send({ type: 'shutdown' });
  await Promise.race([exited, delay(10000)]);
  if (launcher.exitCode === null) {
    await new Promise((resolve) =>
      execFile('taskkill', ['/pid', String(launcher.pid), '/T', '/F'], { windowsHide: true }, resolve),
    );
    await Promise.race([exited, delay(3000)]);
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    dailyChecks?.stop();
    void (async () => {
      await updater?.dispose();
      await shutdown();
    })().finally(() => {
      stopped = true;
      app.quit();
    });
  });
  app
    .whenReady()
    .then(async () => {
      const root = process.resourcesPath;
      const workspace = smokeDir ? join(smokeDir, 'workspace') : join(app.getPath('userData'), 'workspace');
      const logs = join(app.getPath('userData'), 'logs');
      await mkdir(workspace, { recursive: true });
      await mkdir(logs, { recursive: true });
      const log = createWriteStream(join(logs, 'desktop.log'), { flags: 'a' });
      const browserSession = session.fromPartition('persist:prism');
      browserSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
      browserSession.setPermissionCheckHandler(() => false);
      window = new BrowserWindow({
        title: 'PRISM',
        width: 1360,
        height: 900,
        minWidth: 430,
        minHeight: 600,
        backgroundColor: '#fafafa',
        icon: join(__dirname, 'app-icon.png'),
        webPreferences: {
          preload: join(__dirname, 'focus-preload.cjs'),
          session: browserSession,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      focusDesktop = installFocusDesktop(window, origin);
      window.on('closed', () => {
        window = undefined;
        focusDesktop.dispose();
        app.quit();
      });
      window.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: 'deny' };
      });
      window.webContents.on('will-navigate', (event, url) => {
        if (!local(url)) {
          event.preventDefault();
          openExternal(url);
        }
      });
      window.webContents.on('will-redirect', (event, url) => {
        if (!local(url)) event.preventDefault();
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'File',
            submenu: [
              {
                label: 'Check for Updates…',
                click: () => void updater?.check(),
              },
              { label: 'Open data folder', click: () => void shell.openPath(workspace) },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          { role: 'editMenu' },
          {
            label: 'View',
            submenu: [
              { role: 'reload' },
              { role: 'resetZoom' },
              { role: 'zoomIn' },
              { role: 'zoomOut' },
              { role: 'togglefullscreen' },
            ],
          },
          {
            label: 'Help',
            submenu: [
              { label: 'PRISM website', click: () => openExternal('https://sam-superlab.github.io/prism/') },
              {
                label: 'About PRISM',
                click: () =>
                  void dialog.showMessageBox(window, {
                    title: 'PRISM',
                    message: `PRISM ${app.getVersion()}`,
                    detail: 'Windows preview. Notes and settings are stored on this computer.',
                  }),
              },
            ],
          },
        ]),
      );
      updater = createUpdater({ app, dialog, getWindow: () => window, shutdown, smokeDir });
      await window.loadFile(join(__dirname, 'loading.html'));
      launcher = spawn(join(root, 'runtime', 'node.exe'), [join(__dirname, 'launch.mjs')], {
        cwd: __dirname,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          PATH: process.env.PATH,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          USERPROFILE: process.env.USERPROFILE,
          APPDATA: process.env.APPDATA,
          PRISM_DESKTOP_TOKEN: token,
          PRISM_DATA_DIR: workspace,
          PRISM_DESKTOP_RUNTIME: join(root, 'desktop'),
          PRISM_WORKER_ENABLED: smokeDir ? 'false' : 'true',
        },
      });
      launcher.stdout.pipe(log);
      launcher.stderr.pipe(log);
      const startup = new Promise((resolve, reject) => {
        launcher.on('message', (message) => {
          if (message?.type === 'ready') resolve();
        });
        launcher.once('error', reject);
        launcher.once('exit', (code) =>
          reject(new Error(`Services exited (${code}). See ${join(logs, 'desktop.log')}`)),
        );
      });
      await Promise.race([
        startup,
        delay(90000).then(() => {
          throw new Error('PRISM services took too long to start.');
        }),
      ]);
      await browserSession.cookies.set({
        url: origin,
        name: 'prism_desktop',
        value: token,
        httpOnly: true,
        sameSite: 'strict',
      });
      await window.loadURL(`${origin}/today?restoreTabs=1`);
      if (!(await window.webContents.executeJavaScript(`Boolean(document.querySelector('main'))`)))
        throw new Error('The PRISM workspace did not become ready.');
      await acknowledgeUpdate(app);
      await updater.notifyPreviousFailure();
      if (!smokeDir || process.env.PRISM_WINDOWS_DAILY_CHECK_TEST === '1') {
        dailyChecks = startAutomaticChecks({
          file: join(app.getPath('userData'), 'updates', 'daily-check.json'),
          check: () => updater.check({ automatic: true }),
        });
      }
      launcher.on('exit', () => {
        if (!quitting && !serviceStopping) {
          void dialog.showMessageBox(window, {
            type: 'error',
            title: 'PRISM',
            message: 'PRISM services stopped.',
            detail: `See ${join(logs, 'desktop.log')}`,
          });
        }
      });
      if (smokeDir) {
        const writeSnapshot = async () => {
          const ui = await window.webContents.executeJavaScript(
            `({ hasMain: Boolean(document.querySelector('main')), theme: document.documentElement.dataset.theme, appearance: localStorage.getItem('prism.appearance.v1') })`,
          );
          await writeFile(
            join(smokeDir, 'ready.json'),
            JSON.stringify({ origin, token, version: app.getVersion(), pid: process.pid, ...ui }),
          );
        };
        await writeSnapshot();
        let commandRunning = false;
        smokeTimer = setInterval(async () => {
          if (commandRunning) return;
          commandRunning = true;
          try {
            await access(join(smokeDir, 'stop'));
            await unlink(join(smokeDir, 'stop'));
            app.quit();
          } catch {
            /* Test is still running. */
          }
          try {
            await access(join(smokeDir, 'update'));
            await unlink(join(smokeDir, 'update'));
            await updater.check();
          } catch {
            /* No update test requested. */
          }
          try {
            await access(join(smokeDir, 'appearance-dark'));
            await unlink(join(smokeDir, 'appearance-dark'));
            await window.webContents.executeJavaScript(
              `localStorage.setItem('prism.appearance.v1', JSON.stringify({theme:'dark',textSize:18}))`,
            );
            const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
            window.webContents.reload();
            await reloaded;
            await writeSnapshot();
          } catch {
            /* No appearance test requested. */
          }
          commandRunning = false;
        }, 250);
      }
    })
    .catch(async (error) => {
      if (smokeDir) await writeFile(join(smokeDir, 'startup-error.txt'), error.stack || error.message);
      else
        await dialog.showMessageBox({
          type: 'error',
          title: 'PRISM could not start',
          message: error.message,
        });
      app.quit();
    });
}

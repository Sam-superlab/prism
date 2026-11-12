const { BrowserWindow, ipcMain, Notification, powerMonitor, screen, session, shell } = require('electron');
const { join } = require('node:path');

const maxTimerSpan = 2 * 60 * 60 * 1000;
const panelSize = { width: 190, height: 210 };

function normalizeState(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { endsAt, phase, sound, pet, mood, reducedMotion } = input;
  if (
    !['focus', 'break'].includes(phase) ||
    !['ready', 'running', 'paused', 'finished'].includes(mood) ||
    [sound, pet, reducedMotion].some((value) => typeof value !== 'boolean')
  )
    return null;
  if (mood === 'running') {
    if (!Number.isSafeInteger(endsAt) || Math.abs(endsAt - now) > maxTimerSpan) return null;
  } else if (endsAt !== null) {
    return null;
  }
  return { endsAt, phase, sound, pet, mood, reducedMotion };
}

function installFocusDesktop(mainWindow, origin) {
  const petUrl = new URL('/focus-pet', origin).href;
  const preload = join(__dirname, 'focus-preload.cjs');
  let state;
  let alarm;
  let notified;
  let companion;
  let companionLoaded = false;
  let disposed = false;
  let notice;

  function validMain(url) {
    try {
      const parsed = new URL(url);
      return parsed.origin === origin && parsed.pathname !== '/focus-pet';
    } catch {
      return false;
    }
  }

  function trustedSender(event, win, validUrl) {
    if (!win || win.isDestroyed()) return false;
    const contents = win.webContents;
    return (
      event.sender === contents && event.senderFrame === contents.mainFrame && validUrl(event.senderFrame.url)
    );
  }

  function sendToMain(eventName) {
    if (disposed || mainWindow.isDestroyed() || !validMain(mainWindow.webContents.getURL())) return;
    void mainWindow.webContents
      .executeJavaScript(`window.dispatchEvent(new Event(${JSON.stringify(eventName)}))`)
      .catch(() => {});
  }

  function revealFocus() {
    if (disposed || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    sendToMain('prism:open-focus');
  }

  function hideCompanion() {
    if (state) state = { ...state, pet: false };
    companion?.hide();
    sendToMain('prism:hide-pet');
  }

  function syncCompanion() {
    if (disposed || !state?.pet) {
      companion?.hide();
      return;
    }

    if (!companion) {
      const { workArea } = screen.getDisplayMatching(mainWindow.getBounds());
      const isolated = session.fromPartition('prism-focus-overlay');
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolated.setPermissionCheckHandler(() => false);
      const panel = new BrowserWindow({
        ...panelSize,
        x: workArea.x + Math.max(0, workArea.width - panelSize.width - 20),
        y: workArea.y + Math.max(0, workArea.height - panelSize.height - 20),
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        webPreferences: {
          preload,
          session: isolated,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      companion = panel;
      panel.setMenu(null);
      panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const allowPet = (event, url) => {
        if (url !== petUrl) event.preventDefault();
      };
      panel.webContents.on('will-navigate', allowPet);
      panel.webContents.on('will-redirect', allowPet);
      panel.on('close', (event) => {
        if (disposed) return;
        event.preventDefault();
        hideCompanion();
      });
      panel.on('closed', () => {
        companion = undefined;
        companionLoaded = false;
      });
      panel.webContents.on('did-finish-load', () => {
        if (panel.webContents.getURL() !== petUrl) return;
        companionLoaded = true;
        syncCompanion();
      });
      void panel.loadURL(petUrl).catch(() => panel.destroy());
      return;
    }

    if (!companionLoaded || companion.webContents.getURL() !== petUrl) return;
    const snapshot = JSON.stringify(state);
    void companion.webContents
      .executeJavaScript(
        `window.prismFocusState = ${snapshot}; window.dispatchEvent(new CustomEvent('prism:focus-state',{detail:window.prismFocusState}));`,
      )
      .catch(() => {});
    if (!companion.isVisible()) companion.showInactive();
  }

  function fireAlarm() {
    clearTimeout(alarm);
    if (disposed || state?.endsAt == null) return;
    const remaining = state.endsAt - Date.now();
    if (remaining > 0) {
      alarm = setTimeout(fireAlarm, remaining);
      return;
    }

    const key = `${state.phase}:${state.endsAt}`;
    const { phase, sound } = state;
    state = { ...state, endsAt: null, mood: 'finished' };
    syncCompanion();
    if (notified === key) return;
    notified = key;

    // Give the portable app a visible fallback if Windows suppresses a toast.
    if (!mainWindow.isDestroyed() && !mainWindow.isFocused()) mainWindow.flashFrame(true);
    if (sound) shell.beep();
    if (!Notification.isSupported()) return;
    notice?.close();
    notice = new Notification({
      title: phase === 'focus' ? 'Focus complete' : 'Break complete',
      body: phase === 'focus' ? 'Take a break when you’re ready.' : 'Ready for another focus session?',
      silent: true, // The user's sound choice is handled once by the app.
    });
    notice.on('click', revealFocus);
    notice.show();
  }

  function onState(event, input) {
    if (disposed || !trustedSender(event, mainWindow, validMain)) return;
    const next = normalizeState(input, Date.now());
    if (!next) return;

    // A renderer can mark the phase finished just before the native timeout is handled.
    if (next.mood === 'finished' && next.phase === state?.phase && state?.endsAt != null) fireAlarm();
    if (next.endsAt !== null && notified === `${next.phase}:${next.endsAt}`)
      state = { ...next, endsAt: null, mood: 'finished' };
    else state = next;
    syncCompanion();
    fireAlarm();
  }

  function onHide(event) {
    if (trustedSender(event, companion, (url) => url === petUrl)) hideCompanion();
  }

  function onOpen(event) {
    if (trustedSender(event, companion, (url) => url === petUrl)) revealFocus();
  }

  ipcMain.on('prism:focus-state', onState);
  ipcMain.on('prism:hide-pet', onHide);
  ipcMain.on('prism:open-focus', onOpen);
  powerMonitor.on('resume', fireAlarm);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(alarm);
      ipcMain.off('prism:focus-state', onState);
      ipcMain.off('prism:hide-pet', onHide);
      ipcMain.off('prism:open-focus', onOpen);
      powerMonitor.off('resume', fireAlarm);
      notice?.close();
      companion?.destroy();
    },
  };
}

module.exports = { installFocusDesktop };

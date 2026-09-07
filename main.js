'use strict';

/**
 * AppMute — main process.
 * Electron shell: window, tray, global hotkeys, IPC. All audio work goes
 * through lib/audio-manager.js (platform-isolated backends).
 */

const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, Notification, nativeTheme, shell, dialog } = require('electron');
const path = require('path');

const { ConfigStore } = require('./lib/config-store');
const audioManager = require('./lib/audio-manager');
const platform = require('./lib/platform');
const hotkeyUtils = require('./lib/hotkey-utils');
const processList = require('./lib/process-list');
const autostart = require('./lib/autostart');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

let mainWindow = null;
let tray = null;
let store = null;
let audio = null;
const pausedState = new Map(); // appId -> boolean (macOS pause tracking)

function ok(data) {
  return { ok: true, data };
}
function fail(error) {
  return { ok: false, error: String((error && error.message) || error) };
}

function newId() {
  return `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const bounds = store.getWindowBounds();
  mainWindow = new BrowserWindow({
    width: bounds.width || 920,
    height: bounds.height || 660,
    minWidth: 720,
    minHeight: 520,
    x: bounds.x,
    y: bounds.y,
    title: 'AppMute',
    backgroundColor: '#111318',
    icon: path.join(__dirname, 'resources', 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch((e) => {
    dialog.showErrorBox('AppMute failed to load its interface', String((e && e.stack) || e));
  });

  // Never leave the user staring at a blank window without explanation.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    dialog.showErrorBox('AppMute failed to load its interface', `${url}\n${desc} (code ${code})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog
      .showMessageBox(mainWindow, {
        type: 'error',
        title: 'AppMute interface stopped',
        message: `The interface process exited unexpectedly (${details.reason}). Your hotkeys keep working.`,
        buttons: ['Reload interface', 'Quit AppMute'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0 && mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
        else {
          app.quitting = true;
          app.quit();
        }
      });
  });
  if (process.argv.includes('--debug')) {
    mainWindow.webContents.on('console-message', (_e, _level, message, line, source) => {
      console.error(`[renderer] ${source}:${line} ${message}`);
    });
  }

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const b = mainWindow.getBounds();
      store.setWindowBounds({ width: b.width, height: b.height, x: b.x, y: b.y });
    } catch {
      /* ignore */
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.on('close', (e) => {
    saveBounds();
    const settings = store.getSettings();
    if (settings.minimizeToTrayOnClose && !app.quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

function unregisterHotkey(appEntry) {
  try {
    if (appEntry.hotkey) globalShortcut.unregister(appEntry.hotkey);
  } catch {
    /* ignore */
  }
}

function registerHotkey(appEntry) {
  if (!appEntry.hotkey) return { ok: true };
  const v = hotkeyUtils.validateAccelerator(appEntry.hotkey);
  if (!v.ok) return { ok: false, reason: v.reason };
  try {
    const registered = globalShortcut.register(appEntry.hotkey, () => {
      void handleHotkeyToggle(appEntry.id);
    });
    if (!registered) {
      return { ok: false, reason: 'Hotkey is already taken (by the OS or another program) and could not be registered.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

function registerAllHotkeys() {
  const failures = [];
  for (const a of store.getApps()) {
    if (!a.hotkey) continue;
    const r = registerHotkey(a);
    if (!r.ok) failures.push({ name: a.name, reason: r.reason });
  }
  return failures;
}

async function handleHotkeyToggle(id) {
  const apps = store.getApps();
  const entry = apps.find((a) => a.id === id);
  if (!entry) return;
  const sup = audioManager.describeSupport(entry);
  if (!sup.muteSupported && !sup.pauseSupported) {
    const reason = sup.muteReason || sup.pauseReason || 'Nothing to toggle.';
    notify(`${entry.name} — could not toggle`, String(reason), true);
    sendToast('error', `Could not toggle "${entry.name}"`, String(reason));
    return;
  }
  let muteErr = null;
  let pauseErr = null;
  // 1. Toggle mute where supported.
  if (sup.muteSupported) {
    try {
      const res = await audio.toggleMuted(entry);
      entry.muted = !!res.muted;
      entry.emulated = !!res.emulated;
    } catch (e) {
      muteErr = e;
    }
  }
  // 2. Mirror pause state to the (new) mute state where supported, so one
  // keypress means muted+paused and the next means unmuted+resumed. When
  // mute isn't supported (e.g. macOS QuickTime) or the mute toggle failed
  // (e.g. idle app with no audio session yet), fall back to toggling pause
  // on its own tracked state so the keypress still does something useful.
  let newPaused = pausedState.get(id) || false;
  let wantedPause = null; // true = tried to pause, false = tried to resume
  if (sup.pauseSupported) {
    if (sup.muteSupported && !muteErr) wantedPause = !!entry.muted;
    else wantedPause = !newPaused;
  }
  if (wantedPause !== null) {
    try {
      if (wantedPause) {
        await audio.pause(entry);
        newPaused = true;
      } else {
        await audio.resume(entry);
        newPaused = false;
      }
      pausedState.set(id, newPaused);
    } catch (e) {
      pauseErr = e;
    }
  }
  entry.lastChanged = Date.now();
  store.setApps(apps);
  broadcastUpdate();
  if (!muteErr && !pauseErr) {
    const parts = [];
    if (sup.muteSupported) parts.push(entry.muted ? 'Muted' : 'Unmuted');
    if (wantedPause !== null) parts.push(newPaused ? 'Paused' : 'Resumed');
    notify(`${entry.name} — ${parts.join(' + ') || 'Toggled'}`);
  } else {
    if (muteErr) {
      notify(`${entry.name} — could not toggle mute`, String((muteErr && muteErr.message) || muteErr), true);
      sendToast('error', `Could not toggle mute for "${entry.name}"`, String((muteErr && muteErr.message) || muteErr));
    } else if (sup.muteSupported) {
      notify(`${entry.name} — ${entry.muted ? 'Muted' : 'Unmuted'}`);
    }
    if (pauseErr) {
      const action = wantedPause ? 'pause' : 'resume';
      notify(`${entry.name} — could not ${action}`, String((pauseErr && pauseErr.message) || pauseErr), true);
      sendToast('error', `Could not ${action} "${entry.name}"`, String((pauseErr && pauseErr.message) || pauseErr));
    } else if (wantedPause !== null && (muteErr || !sup.muteSupported)) {
      notify(`${entry.name} — ${newPaused ? 'Paused' : 'Resumed'}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Notifications / toasts / tray
// ---------------------------------------------------------------------------

function notify(title, body = '', isError = false) {
  const settings = store ? store.getSettings() : { showNotifications: true };
  if (!settings.showNotifications && !isError) return;
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'AppMute', body: body ? `${title}\n${body}` : title });
      n.show();
    }
  } catch {
    /* notifications must never crash the app */
  }
  // Always mirror to in-app toast so feedback is visible.
  sendToast(isError ? 'error' : 'info', title, body);
}

function sendToast(type, title, body = '') {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('appmute:toast', { type, title, body });
    }
  } catch {
    /* ignore */
  }
}

function broadcastUpdate() {
  void refreshStatuses()
    .catch(() => store.getApps())
    .then((apps) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('appmute:apps-updated', apps);
        }
      } catch {
        /* ignore */
      }
      updateTrayMenu();
    });
}

/** Best-effort live mute/running status for every tracked app. */
async function refreshStatuses() {
  const apps = store.getApps();
  const sessions = await audio.listSessions().catch(() => []);
  const byPid = new Map(sessions.map((s) => [s.pid, s]));
  const byName = new Map();
  for (const s of sessions) {
    const k = String(s.processName || '').toLowerCase();
    if (k && !byName.has(k)) byName.set(k, s);
  }

  for (const a of apps) {
    a.support = audioManager.describeSupport(a);
    a.paused = pausedState.get(a.id) || false;
    try {
      if (isWin) {
        const key = String(a.processName || '').toLowerCase();
        const hit =
          (a.pid && byPid.get(a.pid)) || byName.get(key) || byName.get(`${key}.exe`) || null;
        if (hit) {
          a.running = true;
          a.pid = hit.pid;
          a.muted = !!hit.muted;
        } else {
          a.running = false;
        }
      } else if (isMac) {
        // Emulated backends can report their own state; unsupported ones stay as stored.
        if (a.support.muteSupported) {
          try {
            a.muted = await audio.isMuted(a);
            a.running = true;
          } catch {
            a.running = false;
          }
        } else {
          a.running = await isMacAppRunning(a).catch(() => undefined);
        }
      } else {
        a.running = false;
      }
    } catch {
      /* keep last known state */
    }
  }
  return apps;
}

async function isMacAppRunning(a) {
  const mac = require('./lib/audio-macos');
  const c = mac.classify(a.name || a.processName);
  if (!c.scriptName) return undefined; // unknown
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run('pgrep', ['-x', c.scriptName], { timeout: 3000 });
    return String(stdout).trim().length > 0;
  } catch {
    return false;
  }
}

function trayIcon() {
  // Real PNG assets (resources/tray.png + tray@2x.png, generated by
  // resources/generate-icons.py). Template image on macOS so the menu-bar
  // icon adapts to light/dark menu bars.
  try {
    const { nativeImage } = require('electron');
    const img =
      nativeImage.createFromPath(path.join(__dirname, 'resources', 'tray.png')) ||
      nativeImage.createEmpty();
    if (isMac && !img.isEmpty()) img.setTemplateImage(true);
    return img.isEmpty() ? undefined : img;
  } catch {
    return undefined;
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const apps = store.getApps();
  const template = [
    { label: 'Show AppMute', click: showWindow },
    { type: 'separator' },
    ...apps.slice(0, 12).map((a) => ({
      label: `${a.muted ? 'Unmute' : 'Mute'} ${a.name}`,
      enabled: a.support ? a.support.muteSupported || isWin : true,
      click: () => {
        void toggleAppMute(a.id);
      },
    })),
    ...(apps.length ? [{ type: 'separator' }] : []),
    {
      label: 'Quit AppMute',
      click: () => {
        app.quitting = true;
        app.quit();
      },
    },
  ];
  try {
    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.setToolTip('AppMute — per-app audio control');
  } catch {
    /* ignore */
  }
}

function setupTray() {
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('AppMute — per-app audio control');
    tray.on('click', showWindow);
    updateTrayMenu();
  } catch {
    tray = null;
  }
}

// ---------------------------------------------------------------------------
// Core actions (shared by IPC + tray + hotkeys)
// ---------------------------------------------------------------------------

async function toggleAppMute(id) {
  const apps = store.getApps();
  const entry = apps.find((a) => a.id === id);
  if (!entry) throw new Error('Application not found. It may have been removed.');
  const sup = audioManager.describeSupport(entry);
  if (!sup.muteSupported) throw new Error(sup.muteReason || `Muting is not supported for "${entry.name}".`);
  const res = await audio.toggleMuted(entry);
  entry.muted = !!res.muted;
  entry.emulated = !!res.emulated;
  entry.lastChanged = Date.now();
  store.setApps(apps);
  broadcastUpdate();
  notify(`${entry.name} — ${entry.muted ? 'Muted' : 'Unmuted'}`);
  return entry;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function setupIpc() {
  ipcMain.handle('appmute:get-state', async () => {
    try {
      const apps = await refreshStatuses();
      return ok({
        apps,
        settings: store.getSettings(),
        platform: platform.platformId(),
        capabilities: platform.audioCapabilities(),
        autostart: await autostart.isEnabled(process.execPath).catch(() => false),
      });
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('appmute:list-processes', async () => {
    try {
      const apps = await processList.listProcesses();
      let tabDenials = [];
      if (isMac) {
        // Best-effort browser tab titles for identification (AppleScript).
        // Never rejects the picker: denial/timeout just leaves process rows.
        try {
          const macTabs = require('./lib/browser-tabs-macos');
          const info = await macTabs.listBrowserTabs({ timeout: 8000 });
          tabDenials = macTabs.enrichWithTabs(apps, info).tabDenials;
        } catch {
          /* process list still usable */
        }
      } else if (isWin) {
        // Best-effort top-level window titles (active tab per browser window).
        try {
          if (typeof audio.listWindowsWithProcess === 'function') {
            processList.attachWindowTitles(apps, await audio.listWindowsWithProcess());
          }
        } catch {
          /* ignore */
        }
      }
      return ok({ apps, tabDenials });
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('appmute:get-file-icon', async (_e, exePath) => {
    try {
      if (!exePath) return ok({ dataUrl: '' });
      const img = await app.getFileIcon(exePath, { size: 'normal' });
      return ok({ dataUrl: img.isEmpty() ? '' : img.toDataURL() });
    } catch {
      return ok({ dataUrl: '' });
    }
  });

  ipcMain.handle('appmute:add-app', async (_e, info) => {
    try {
      const name = String((info && info.name) || '').trim();
      if (!name) return fail('Select an application first.');
      const apps = store.getApps();
      const dup = apps.find(
        (a) =>
          a.name.toLowerCase() === name.toLowerCase() ||
          (info.pid && a.pid === info.pid && info.pid !== 0)
      );
      if (dup) return fail(`"${name}" is already in your list.`);
      const entry = {
        id: newId(),
        name,
        processName: String((info && info.processName) || name),
        exePath: String((info && info.exePath) || ''),
        pid: (info && info.pid) || 0,
        hotkey: '',
        muted: false,
        emulated: false,
        running: undefined,
        lastChanged: 0,
      };
      apps.push(entry);
      store.setApps(apps);
      broadcastUpdate();
      return ok(entry);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('appmute:remove-app', async (_e, id) => {
    try {
      const apps = store.getApps();
      const entry = apps.find((a) => a.id === id);
      if (entry) unregisterHotkey(entry);
      store.setApps(apps.filter((a) => a.id !== id));
      pausedState.delete(id);
      broadcastUpdate();
      return ok({ removed: id });
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('appmute:toggle-mute', async (_e, id) => {
    try {
      return ok(await toggleAppMute(id));
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('appmute:set-muted', async (_e, id, muted) => {
    try {
      const apps = store.getApps();
      const entry = apps.find((a) => a.id === id);
      if (!entry) return fail('Application not found. It may have been removed.');
      const sup = audioManager.describeSupport(entry);
      if (!sup.muteSupported) return fail(sup.muteReason || `Muting is not supported for "${entry.name}".`);
      const res = await audio.setMuted(entry, !!muted);
      entry.muted = res && typeof res.muted === 'boolean' ? res.muted : !!muted;
      entry.emulated = !!(res && res.emulated);
      entry.lastChanged = Date.now();
      store.setApps(apps);
      broadcastUpdate();
      notify(`${entry.name} — ${entry.muted ? 'Muted' : 'Unmuted'}`);
      return ok(entry);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('appmute:set-hotkey', async (_e, id, accelerator) => {
    try {
      const acc = String(accelerator || '').trim();
      const apps = store.getApps();
      const entry = apps.find((a) => a.id === id);
      if (!entry) return fail('Application not found. It may have been removed.');
      if (!acc) {
        unregisterHotkey(entry);
        entry.hotkey = '';
        store.setApps(apps);
        broadcastUpdate();
        return ok(entry);
      }
      const v = hotkeyUtils.validateAccelerator(acc);
      if (!v.ok) return fail(v.reason);
      const conflict = hotkeyUtils.findConflict(apps, acc, id);
      if (conflict) return fail(`That hotkey is already assigned to "${conflict.name}". Choose a different combination.`);
      unregisterHotkey(entry);
      const previous = entry.hotkey;
      entry.hotkey = acc;
      const r = registerHotkey(entry);
      if (!r.ok) {
        entry.hotkey = previous;
        registerHotkey(entry);
        return fail(r.reason || 'Hotkey could not be registered.');
      }
      store.setApps(apps);
      broadcastUpdate();
      return ok(entry);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('appmute:pause', async (_e, id) => {
    try {
      const apps = store.getApps();
      const entry = apps.find((a) => a.id === id);
      if (!entry) return fail('Application not found.');
      await audio.pause(entry);
      pausedState.set(id, true);
      broadcastUpdate();
      return ok({ paused: true });
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('appmute:resume', async (_e, id) => {
    try {
      const apps = store.getApps();
      const entry = apps.find((a) => a.id === id);
      if (!entry) return fail('Application not found.');
      await audio.resume(entry);
      pausedState.set(id, false);
      broadcastUpdate();
      return ok({ paused: false });
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('appmute:open-app', async (_e, id) => {
    try {
      const entry = store.getApps().find((a) => a.id === id);
      if (!entry) return fail('Application not found.');
      if (entry.exePath) {
        const res = await shell.openPath(entry.exePath);
        if (res) return fail(`Could not open "${entry.name}": ${res}`);
        return ok({});
      }
      if (isMac) {
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        await promisify(execFile)('open', ['-a', entry.name]);
        return ok({});
      }
      return fail(`No executable path stored for "${entry.name}". Launch it manually.`);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('appmute:update-settings', async (_e, patch) => {
    try {
      const before = store.getSettings();
      const next = store.updateSettings(patch || {});
      try {
        nativeTheme.themeSource = next.theme === 'system' ? 'system' : next.theme;
      } catch {
        /* ignore */
      }
      if ((patch || {}).launchAtStartup !== undefined && patch.launchAtStartup !== before.launchAtStartup) {
        try {
          await autostart.setEnabled(!!patch.launchAtStartup, process.execPath);
        } catch (e) {
          store.updateSettings({ launchAtStartup: before.launchAtStartup });
          return fail(e);
        }
      }
      return ok({ settings: next, autostart: await autostart.isEnabled(process.execPath).catch(() => false) });
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('appmute:reset-settings', async () => {
    try {
      const settings = store.resetSettings();
      try {
        nativeTheme.themeSource = settings.theme;
      } catch {
        /* ignore */
      }
      try {
        await autostart.setEnabled(false, process.execPath);
      } catch {
        /* non-fatal */
      }
      return ok({ settings });
    } catch (e) {
      return fail(e);
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function init() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', showWindow);

  await app.whenReady();

  store = new ConfigStore(app.getPath('userData'));
  audio = audioManager.backend();

  try {
    nativeTheme.themeSource = store.getSettings().theme || 'dark';
  } catch {
    /* ignore */
  }

  setupIpc();

  const startMinimized =
    process.argv.includes('--start-minimized') || store.getSettings().startMinimized;
  if (!startMinimized) {
    createWindow();
  } else {
    // Create hidden window so tray + hotkeys still work.
    createWindow();
    if (mainWindow) mainWindow.hide();
  }
  setupTray();

  const failures = registerAllHotkeys();
  if (failures.length && mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      sendToast(
        'error',
        'Some hotkeys could not be registered',
        failures.map((f) => `${f.name}: ${f.reason}`).join('\n')
      );
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (!isMac) {
      const settings = store ? store.getSettings() : { minimizeToTrayOnClose: false };
      if (!settings.minimizeToTrayOnClose) app.quit();
    }
  });
}

init().catch((e) => {
  try {
    app.whenReady().then(() => {
      dialog.showErrorBox('AppMute failed to start', String((e && e.stack) || e));
    });
  } finally {
    app.quit();
  }
});

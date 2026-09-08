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

let mainWindow = null;
let tray = null;
let store = null;
let audio = null;
const pausedState = new Map(); // appId -> boolean (pause tracking)
// While the renderer is capturing a new hotkey combination, global hotkey
// handlers must not fire. Otherwise pressing an already-assigned combo to
// test it would toggle the other app instead of showing the conflict warning.
let hotkeyCaptureActive = false;
let hotkeyCaptureStartedAt = 0;
const HOTKEY_CAPTURE_TIMEOUT_MS = 5 * 60 * 1000;

function isCapturingHotkey() {
  if (!hotkeyCaptureActive) return false;
  if (Date.now() - hotkeyCaptureStartedAt > HOTKEY_CAPTURE_TIMEOUT_MS) {
    hotkeyCaptureActive = false;
    return false;
  }
  return true;
}

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

/** Hotkey slot field: 'mute' -> hotkey, 'pause' -> pauseHotkey. */
function hotkeyField(kind) {
  return kind === 'pause' ? 'pauseHotkey' : 'hotkey';
}

// Multiple apps may share the same accelerator. We keep exactly one global
// registration per unique combination (case-insensitive) and fan out to
// every app/slot using it. Map: normalized accelerator -> canonical string
// as registered with Electron.
const registeredAccelerators = new Map();

function acceleratorKey(acc) {
  return String(acc || '').toLowerCase();
}

function collectUniqueAccelerators(apps) {
  const uniq = new Map();
  for (const a of apps || []) {
    for (const field of ['hotkey', 'pauseHotkey']) {
      const acc = a && a[field];
      if (!acc) continue;
      const key = acceleratorKey(acc);
      if (key && !uniq.has(key)) uniq.set(key, acc);
    }
  }
  return uniq;
}

function isAcceleratorUsedByApps(apps, acc) {
  if (!acc) return false;
  const want = acceleratorKey(acc);
  return (apps || []).some(
    (a) =>
      (a.hotkey || '').toLowerCase() === want ||
      (a.pauseHotkey || '').toLowerCase() === want
  );
}

/** Fan-out handler: one physical hotkey press acts on ALL apps sharing it. */
async function handleSharedHotkey(canonicalAcc) {
  if (isCapturingHotkey()) return;
  const want = acceleratorKey(canonicalAcc);
  let apps = [];
  try {
    apps = store.getApps();
  } catch {
    return;
  }
  const targets = (apps || []).filter(
    (a) =>
      (a.hotkey || '').toLowerCase() === want ||
      (a.pauseHotkey || '').toLowerCase() === want
  );
  for (const t of targets) {
    try {
      if ((t.hotkey || '').toLowerCase() === want) {
        await handleMuteHotkey(t.id);
      }
    } catch {
      /* per-app errors already surface via notify/toast */
    }
    try {
      if ((t.pauseHotkey || '').toLowerCase() === want) {
        await handlePauseHotkey(t.id);
      }
    } catch {
      /* per-app errors already surface via notify/toast */
    }
  }
}

function registerSharedAccelerator(acc) {
  if (!acc) return { ok: true };
  const v = hotkeyUtils.validateAccelerator(acc);
  if (!v.ok) return { ok: false, reason: v.reason };
  const key = acceleratorKey(acc);
  if (registeredAccelerators.has(key)) return { ok: true };
  try {
    if (
      typeof globalShortcut.isRegistered === 'function' &&
      globalShortcut.isRegistered(acc)
    ) {
      return { ok: false, reason: 'Hotkey is already taken (by the OS or another program) and could not be registered.' };
    }
    const registered = globalShortcut.register(acc, () => {
      void handleSharedHotkey(acc);
    });
    if (!registered) {
      return { ok: false, reason: 'Hotkey is already taken (by the OS or another program) and could not be registered.' };
    }
    registeredAccelerators.set(key, acc);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

function unregisterAcceleratorIfUnused(acc, apps) {
  if (!acc) return;
  if (isAcceleratorUsedByApps(apps, acc)) return; // still shared
  const key = acceleratorKey(acc);
  const canonical = registeredAccelerators.get(key) || acc;
  try {
    globalShortcut.unregister(canonical);
  } catch {
    /* ignore */
  }
  if (String(canonical).toLowerCase() !== String(acc).toLowerCase()) {
    try {
      globalShortcut.unregister(acc);
    } catch {
      /* ignore */
    }
  }
  registeredAccelerators.delete(key);
}

function registerAllHotkeys() {
  registeredAccelerators.clear();
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
  const failures = [];
  const apps = store.getApps();
  const uniq = collectUniqueAccelerators(apps);
  for (const [, canonical] of uniq) {
    const r = registerSharedAccelerator(canonical);
    if (!r.ok) {
      const want = acceleratorKey(canonical);
      const affected = apps.filter(
        (a) =>
          (a.hotkey || '').toLowerCase() === want ||
          (a.pauseHotkey || '').toLowerCase() === want
      );
      if (affected.length === 0) {
        failures.push({ name: canonical, kind: 'mute/pause', reason: r.reason });
      } else {
        for (const a of affected) {
          const slots = [];
          if ((a.hotkey || '').toLowerCase() === want) slots.push('mute');
          if ((a.pauseHotkey || '').toLowerCase() === want) slots.push('pause');
          failures.push({ name: a.name, kind: slots.join('+') || 'mute/pause', reason: r.reason });
        }
      }
    }
  }
  return failures;
}

async function handleMuteHotkey(id) {
  if (isCapturingHotkey()) return;
  const apps = store.getApps();
  const entry = apps.find((a) => a.id === id);
  if (!entry) return;
  try {
    const res = await audio.toggleMuted(entry);
    entry.muted = !!res.muted;
    entry.emulated = !!res.emulated;
    entry.lastChanged = Date.now();
    store.setApps(apps);
    broadcastUpdate();
    notify(`${entry.name} — ${entry.muted ? 'Muted' : 'Unmuted'}`);
  } catch (e) {
    notify(`${entry.name} — could not toggle mute`, String((e && e.message) || e), true);
    sendToast('error', `Could not toggle mute for "${entry.name}"`, String((e && e.message) || e));
  }
}

async function handlePauseHotkey(id) {
  if (isCapturingHotkey()) return;
  const apps = store.getApps();
  const entry = apps.find((a) => a.id === id);
  if (!entry) return;
  const sup = audioManager.describeSupport(entry);
  if (!sup.pauseSupported) {
    const reason = sup.pauseReason || 'Pause/Resume is not supported for this application.';
    notify(`${entry.name} — could not pause`, String(reason), true);
    sendToast('error', `Could not pause "${entry.name}"`, String(reason));
    return;
  }
  try {
    let paused;
    if (pausedState.get(id)) {
      await audio.resume(entry);
      paused = false;
    } else {
      await audio.pause(entry);
      paused = true;
    }
    pausedState.set(id, paused);
    entry.lastChanged = Date.now();
    store.setApps(apps);
    broadcastUpdate();
    notify(`${entry.name} — ${paused ? 'Paused' : 'Resumed'}`);
  } catch (e) {
    notify(`${entry.name} — could not toggle pause`, String((e && e.message) || e), true);
    sendToast('error', `Could not toggle pause for "${entry.name}"`, String((e && e.message) || e));
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
    } catch {
      /* keep last known state */
    }
  }
  return apps;
}

function trayIcon() {
  // Real PNG assets (resources/tray.png + tray@2x.png, generated by
  // resources/generate-icons.py).
  try {
    const { nativeImage } = require('electron');
    const img =
      nativeImage.createFromPath(path.join(__dirname, 'resources', 'tray.png')) ||
      nativeImage.createEmpty();
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
      enabled: a.support ? a.support.muteSupported : true,
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
      // Best-effort top-level window titles (active tab per browser window).
      try {
        if (typeof audio.listWindowsWithProcess === 'function') {
          processList.attachWindowTitles(apps, await audio.listWindowsWithProcess());
        }
      } catch {
        /* ignore */
      }
      return ok({ apps, tabDenials: [] });
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
        pauseHotkey: '',
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
      const remaining = apps.filter((a) => a.id !== id);
      store.setApps(remaining);
      if (entry) {
        if (entry.hotkey) unregisterAcceleratorIfUnused(entry.hotkey, remaining);
        if (entry.pauseHotkey) unregisterAcceleratorIfUnused(entry.pauseHotkey, remaining);
      }
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

  ipcMain.handle('appmute:set-hotkey-capture', async (_e, active) => {
    try {
      hotkeyCaptureActive = !!active;
      hotkeyCaptureStartedAt = Date.now();
      return ok({ capturing: hotkeyCaptureActive });
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('appmute:set-hotkey', async (_e, id, accelerator, kind) => {
    try {
      const which = kind === 'pause' ? 'pause' : 'mute';
      const field = hotkeyField(which);
      const acc = String(accelerator || '').trim();
      const apps = store.getApps();
      const entry = apps.find((a) => a.id === id);
      if (!entry) return fail('Application not found. It may have been removed.');
      if (!(hotkeyField('mute') in entry)) entry.hotkey = '';
      if (!(hotkeyField('pause') in entry)) entry.pauseHotkey = '';
      if (!acc) {
        const previous = entry[field];
        entry[field] = '';
        store.setApps(apps);
        unregisterAcceleratorIfUnused(previous, apps);
        broadcastUpdate();
        return ok(entry);
      }
      const v = hotkeyUtils.validateAccelerator(acc);
      if (!v.ok) return fail(v.reason);
      // Duplicate check is SAME-APP ONLY: different apps may share one
      // combination (one global registration fans out to all of them).
      const conflict = hotkeyUtils.findConflict(apps, acc, id, field);
      if (conflict) {
        const otherSlot = field === 'hotkey' ? 'pause' : 'mute';
        return fail(`That hotkey is already used as the ${otherSlot} hotkey for "${conflict.name}". Use a different combination for this slot.`);
      }
      const previous = entry[field] || '';
      if (previous.toLowerCase() === acc.toLowerCase()) {
        // Re-saving the same value (e.g. casing change): ensure registration.
        entry[field] = acc;
        store.setApps(apps);
        const rSame = registerSharedAccelerator(acc);
        if (!rSame.ok) return fail(rSame.reason || 'Hotkey could not be registered.');
        broadcastUpdate();
        return ok(entry);
      }
      // Ensure the new combination is registrable before dropping the old one.
      const rNew = registerSharedAccelerator(acc);
      if (!rNew.ok) {
        return fail(rNew.reason || 'Hotkey could not be registered.');
      }
      entry[field] = acc;
      store.setApps(apps);
      if (previous) unregisterAcceleratorIfUnused(previous, apps);
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
        failures.map((f) => `${f.name} (${f.kind} hotkey): ${f.reason}`).join('\n')
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
    const settings = store ? store.getSettings() : { minimizeToTrayOnClose: false };
    if (!settings.minimizeToTrayOnClose) app.quit();
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

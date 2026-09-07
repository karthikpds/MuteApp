'use strict';

/**
 * Preload bridge — the only surface the renderer can touch.
 * contextIsolation stays on; no Node globals leak into the UI.
 */

const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld('appMute', {
  getState: () => invoke('appmute:get-state'),
  listProcesses: () => invoke('appmute:list-processes'),
  getFileIcon: (exePath) => invoke('appmute:get-file-icon', exePath),
  addApp: (info) => invoke('appmute:add-app', info),
  removeApp: (id) => invoke('appmute:remove-app', id),
  toggleMute: (id) => invoke('appmute:toggle-mute', id),
  setMuted: (id, muted) => invoke('appmute:set-muted', id, muted),
  setHotkey: (id, accelerator) => invoke('appmute:set-hotkey', id, accelerator),
  pause: (id) => invoke('appmute:pause', id),
  resume: (id) => invoke('appmute:resume', id),
  openApp: (id) => invoke('appmute:open-app', id),
  updateSettings: (patch) => invoke('appmute:update-settings', patch),
  resetSettings: () => invoke('appmute:reset-settings'),

  onAppsUpdated: (cb) => {
    const listener = (_e, apps) => cb(apps);
    ipcRenderer.on('appmute:apps-updated', listener);
    return () => ipcRenderer.removeListener('appmute:apps-updated', listener);
  },
  onToast: (cb) => {
    const listener = (_e, toast) => cb(toast);
    ipcRenderer.on('appmute:toast', listener);
    return () => ipcRenderer.removeListener('appmute:toast', listener);
  },
});

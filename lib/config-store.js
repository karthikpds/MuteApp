'use strict';

/**
 * Minimal JSON config store (no external dependencies).
 * Persists: apps, hotkeys, mute state, user preferences, window bounds.
 * File location is injected (main.js passes app.getPath('userData')).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  launchAtStartup: false,
  startMinimized: false,
  showNotifications: true,
  minimizeToTrayOnClose: true,
  theme: 'dark', // 'dark' | 'light' | 'system'
};

const DEFAULT_STATE = {
  version: 1,
  apps: [],
  settings: { ...DEFAULT_SETTINGS },
  window: { width: 920, height: 660, x: undefined, y: undefined },
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

class ConfigStore {
  /**
   * @param {string} dir directory to store config in
   * @param {string} [filename]
   */
  constructor(dir, filename = 'appmute-config.json') {
    this.filePath = path.join(dir, filename);
    this.state = clone(DEFAULT_STATE);
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.state = {
          ...clone(DEFAULT_STATE),
          ...parsed,
          settings: { ...clone(DEFAULT_SETTINGS), ...(parsed.settings || {}) },
          window: { ...clone(DEFAULT_STATE.window), ...(parsed.window || {}) },
          apps: Array.isArray(parsed.apps) ? parsed.apps : [],
        };
      }
    } catch {
      this.state = clone(DEFAULT_STATE);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
    } catch {
      // Never silently fail in UI; main.js surfaces save errors via IPC result.
      throw new Error(`Could not write configuration to ${this.filePath}`);
    }
  }

  getApps() {
    return clone(this.state.apps);
  }

  setApps(apps) {
    this.state.apps = clone(apps);
    this.save();
  }

  getSettings() {
    return clone(this.state.settings);
  }

  updateSettings(patch) {
    this.state.settings = { ...this.state.settings, ...patch };
    this.save();
    return this.getSettings();
  }

  resetSettings() {
    this.state.settings = clone(DEFAULT_SETTINGS);
    this.save();
    return this.getSettings();
  }

  getWindowBounds() {
    return clone(this.state.window);
  }

  setWindowBounds(bounds) {
    this.state.window = { ...this.state.window, ...bounds };
    // Debounced by caller; save directly (small file).
    try {
      this.save();
    } catch {
      /* ignore transient save errors for window geometry */
    }
  }
}

module.exports = { ConfigStore, DEFAULT_SETTINGS, DEFAULT_STATE };

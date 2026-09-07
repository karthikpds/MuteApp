'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ConfigStore, DEFAULT_SETTINGS } = require('../lib/config-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'appmute-test-'));
}

test('ConfigStore persists apps, hotkeys, settings and window prefs', () => {
  const dir = tempDir();
  const store = new ConfigStore(dir);
  assert.deepEqual(store.getApps(), []);
  assert.deepEqual(store.getSettings(), DEFAULT_SETTINGS);

  store.setApps([{ id: 'a', name: 'Spotify', hotkey: 'Control+Alt+S', muted: true }]);
  store.updateSettings({ theme: 'light', showNotifications: false });
  store.setWindowBounds({ width: 800, height: 600 });

  const reopened = new ConfigStore(dir);
  assert.equal(reopened.getApps().length, 1);
  assert.equal(reopened.getApps()[0].hotkey, 'Control+Alt+S');
  assert.equal(reopened.getSettings().theme, 'light');
  assert.equal(reopened.getSettings().showNotifications, false);
  assert.equal(reopened.getWindowBounds().width, 800);
});

test('ConfigStore resetSettings restores defaults but keeps apps', () => {
  const dir = tempDir();
  const store = new ConfigStore(dir);
  store.setApps([{ id: 'a', name: 'Chrome' }]);
  store.updateSettings({ theme: 'light' });
  const reset = store.resetSettings();
  assert.equal(reset.theme, DEFAULT_SETTINGS.theme);
  assert.equal(store.getApps().length, 1);
});

test('ConfigStore migrates legacy single-hotkey entries to dual hotkeys', () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, 'appmute-config.json'),
    JSON.stringify({ apps: [{ id: 'a', name: 'Spotify', hotkey: 'Control+Alt+S', muted: true }] })
  );
  const store = new ConfigStore(dir);
  assert.equal(store.getApps()[0].hotkey, 'Control+Alt+S');
  assert.equal(store.getApps()[0].pauseHotkey, '');
});

test('ConfigStore tolerates corrupt files', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'appmute-config.json'), '{not json');
  const store = new ConfigStore(dir);
  assert.deepEqual(store.getApps(), []);
});

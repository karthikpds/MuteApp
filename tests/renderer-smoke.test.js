'use strict';

/**
 * Renderer smoke test: runs the real renderer/renderer.js against a minimal
 * stub DOM and asserts the main render path (header badge, notice, app cards,
 * status bar) works with representative state — without needing Electron.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

function makeEl() {
  const el = {
    children: [],
    style: {},
    dataset: {},
    textContent: '',
    disabled: false,
    checked: false,
    value: '',
    _listeners: {},
    _innerHTML: '',
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, force) {
        if (force === undefined) this._s.has(c) ? this._s.delete(c) : this._s.add(c);
        else if (force) this._s.add(c);
        else this._s.delete(c);
      },
      contains(c) { return this._s.has(c); },
    },
    set innerHTML(v) { this._innerHTML = String(v); this.children = []; },
    get innerHTML() { return this._innerHTML; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    focus() {},
    remove() {},
  };
  return el;
}

const SAMPLE_STATE = {
  apps: [
    {
      id: 'a1', name: 'Spotify', processName: 'Spotify', exePath: '', pid: 111,
      hotkey: 'Control+Alt+S', pauseHotkey: 'Control+Alt+P', muted: true, emulated: true, paused: false, running: true,
      support: { muteSupported: true, muteEmulated: true, pauseSupported: true, muteReason: '', pauseReason: '' },
    },
    {
      id: 'a2', name: 'Google Chrome', processName: 'Google Chrome', exePath: '', pid: 222,
      hotkey: '', pauseHotkey: '', muted: false, emulated: false, paused: false, running: false,
      support: {
        muteSupported: false, muteEmulated: false, pauseSupported: false,
        muteReason: 'macOS does not provide a per-application mute API.',
        pauseReason: 'No media controls.',
      },
    },
  ],
  settings: { theme: 'dark', showNotifications: true },
  platform: 'macos',
  capabilities: { perAppMute: false, notes: 'macOS has no public per-application mute API.' },
  autostart: false,
};

function buildSandbox() {
  const elements = new Map();
  const docListeners = {};
  const apiCalls = [];
  const api = new Proxy(
    {
      getState: async () => ({ ok: true, data: SAMPLE_STATE }),
      onAppsUpdated: () => () => {},
      onToast: () => () => {},
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return async (...args) => {
          apiCalls.push([prop, args]);
          return { ok: true, data: {} };
        };
      },
    }
  );
  const document = {
    documentElement: { dataset: {} },
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeEl());
      return elements.get(id);
    },
    createElement: () => makeEl(),
    querySelectorAll: () => [],
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
  };
  const sandbox = {
    window: { confirm: () => true },
    document,
    CSS: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') },
    setTimeout: (fn) => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    console,
  };
  sandbox.window.appMute = api;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, elements, docListeners, apiCalls };
}

async function flush(times = 10) {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

test('every element id used in renderer.js exists in index.html', () => {
  const htmlIds = new Set([...INDEX_HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const usedIds = new Set([...RENDERER_SRC.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(usedIds.size > 10, 'expected many element lookups');
  for (const id of usedIds) {
    assert.ok(htmlIds.has(id), `renderer.js references #${id} but index.html has no such id`);
  }
});

test('picker subtitle and search cover tab and window titles', () => {
  const { sandbox } = buildSandbox();
  vm.runInContext(RENDERER_SRC, sandbox, { filename: 'renderer.js' });
  const chrome = {
    name: 'Google Chrome', processName: 'Google Chrome', pid: 111,
    activeTabTitle: 'YouTube', totalTabs: 5,
  };
  assert.equal(sandbox.processSubtitle(chrome), '▶ YouTube · 5 tabs · Google Chrome · PID 111');
  assert.equal(sandbox.processMatches(chrome, 'youtube'), true);
  assert.equal(sandbox.processMatches(chrome, 'chrome'), true);
  assert.equal(sandbox.processMatches(chrome, 'zzz-no-match'), false);
  const winGrouped = {
    name: 'chrome', processName: 'chrome.exe', pid: 0, grouped: true, processCount: 12,
    windowTitles: ['YouTube - Google Chrome'],
  };
  assert.equal(
    sandbox.processSubtitle(winGrouped),
    '🪟 YouTube - Google Chrome · chrome.exe · 12 processes'
  );
  assert.equal(sandbox.processMatches(winGrouped, 'youtube'), true);
});

test('renderer renders header, cards and status bar from live state', async () => {
  const { sandbox, elements, docListeners } = buildSandbox();
  vm.runInContext(RENDERER_SRC, sandbox, { filename: 'renderer.js' });
  assert.ok(docListeners.DOMContentLoaded, 'renderer must bind DOMContentLoaded');
  for (const fn of docListeners.DOMContentLoaded) fn();
  await flush();

  const badge = elements.get('platform-badge');
  assert.match(badge.textContent, /macOS · limited/);
  const notice = elements.get('platform-notice');
  assert.equal(notice.classList.contains('hidden'), false);
  assert.match(elements.get('platform-notice-text').innerHTML, /macOS limitation/);

  const list = elements.get('app-list');
  assert.equal(list.children.length, 2);
  const [spotify, chrome] = list.children.map((c) => c.innerHTML);
  assert.match(spotify, /Spotify/);
  assert.match(spotify, /Muted/);
  assert.match(spotify, /⌃ \+ ⌥ \+ S/); // Control+Alt+S shown with macOS symbols
  assert.match(spotify, /⌃ \+ ⌥ \+ P/); // pause hotkey chip alongside the mute one
  assert.match(chrome, /Google Chrome/);
  assert.match(chrome, /Not running/);
  assert.match(chrome, /Set mute key/);
  assert.match(chrome, /Pause N\/A/); // pause unsupported: disabled chip, not a setter

  assert.match(elements.get('statusbar-text').textContent, /2 apps · 1 muted/);
  assert.equal(elements.get('empty-state').classList.contains('hidden'), true);
});

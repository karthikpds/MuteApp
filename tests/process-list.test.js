'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  groupWindowsProcesses,
  attachWindowTitles,
  isHelperNoise,
} = require('../lib/process-list');

test('isHelperNoise hides sub-process rows but keeps real apps', () => {
  assert.equal(isHelperNoise('Google Chrome Helper'), true);
  assert.equal(isHelperNoise('Google Chrome Helper (Renderer)'), true);
  assert.equal(isHelperNoise('Google Chrome Helper (GPU)'), true);
  assert.equal(isHelperNoise('chrome_crashpad_handler'), true);
  assert.equal(isHelperNoise('Google Chrome'), false);
  assert.equal(isHelperNoise('chrome'), false);
  assert.equal(isHelperNoise('Spotify'), false);
  assert.equal(isHelperNoise('VLC'), false);
});

test('groupWindowsProcesses collapses one row per process name', () => {
  const grouped = groupWindowsProcesses([
    { pid: 1, name: 'chrome', processName: 'chrome.exe', exePath: '' },
    { pid: 2, name: 'chrome', processName: 'chrome.exe', exePath: 'C:\\Chrome\\chrome.exe' },
    { pid: 3, name: 'chrome', processName: 'chrome.exe', exePath: '' },
    { pid: 9, name: 'Spotify', processName: 'Spotify.exe', exePath: '' },
  ]);
  assert.equal(grouped.length, 2);
  const chrome = grouped.find((g) => g.name === 'chrome');
  assert.equal(chrome.pid, 0);
  assert.equal(chrome.grouped, true);
  assert.equal(chrome.processCount, 3);
  assert.equal(chrome.exePath, 'C:\\Chrome\\chrome.exe');
});

test('attachWindowTitles maps titles by process name, capped and deduped', () => {
  const apps = [{ name: 'chrome', processName: 'chrome.exe' }, { name: 'Spotify', processName: 'Spotify.exe' }];
  attachWindowTitles(apps, [
    { processName: 'chrome.exe', title: 'YouTube - Google Chrome' },
    { processName: 'chrome.exe', title: 'YouTube - Google Chrome' },
    { processName: 'chrome.exe', title: 'Gmail - Google Chrome' },
    { processName: 'chrome.exe', title: 'Docs - Google Chrome' },
    { processName: 'chrome.exe', title: 'Extra - Google Chrome' },
  ]);
  assert.deepEqual(apps[0].windowTitles, [
    'YouTube - Google Chrome',
    'Gmail - Google Chrome',
    'Docs - Google Chrome',
  ]);
  assert.equal(apps[1].windowTitles, undefined);
});

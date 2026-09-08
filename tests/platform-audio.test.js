'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const platform = require('../lib/platform');
const { describeSupport } = require('../lib/audio-manager');
const { parseTasklistCsv, prioritizeForPicker } = require('../lib/process-list');

test('platform capabilities: Windows true mute', () => {
  assert.equal(platform.audioCapabilities('win32').perAppMute, true);
  assert.equal(platform.audioCapabilities('win32').perAppMuteEmulated, false);
  assert.equal(platform.platformId('win32'), 'windows');
});

test('audio-manager describeSupport reflects platform', () => {
  const win = describeSupport({ name: 'Chrome' }, 'win32');
  assert.equal(win.muteSupported, true);
  assert.equal(win.pauseSupported, true);
});

test('process-list parses tasklist CSV', () => {
  const csv = '"chrome.exe","1234","Console","1","200,000 K"\n"Spotify.exe","5678","Console","1","150,000 K"\n';
  const apps = parseTasklistCsv(csv);
  assert.equal(apps.length, 2);
  assert.equal(apps[0].pid, 1234);
  assert.equal(apps[0].name, 'chrome');
  assert.equal(apps[1].processName, 'Spotify.exe');
});

test('process-list prioritizes likely audio apps in the picker', () => {
  const ordered = prioritizeForPicker([
    { pid: 3, name: 'accountsd' },
    { pid: 1, name: 'Spotify' },
    { pid: 2, name: 'Finder' },
  ]);
  assert.equal(ordered[0].name, 'Spotify');
  assert.equal(ordered[1].name, 'Finder');
  assert.equal(ordered[2].name, 'accountsd');
});

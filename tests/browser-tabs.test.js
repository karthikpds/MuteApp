'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const macTabs = require('../lib/browser-tabs-macos');
const {
  groupWindowsProcesses,
  attachWindowTitles,
  isHelperNoise,
} = require('../lib/process-list');

const US = String.fromCharCode(31);
const RS = String.fromCharCode(30);

test('parseTabOutput reads ACTIVE header and tab records', () => {
  const out = `ACTIVE${US}YouTube${US}https://youtube.com/${RS}` +
    `YouTube${US}https://youtube.com/${US}1${RS}` +
    `Gmail${US}https://mail.google.com/${US}1${RS}` +
    `Docs${US}https://docs.google.com/${US}2${RS}`;
  const { activeTab, tabs } = macTabs.parseTabOutput(out);
  assert.deepEqual(activeTab, { title: 'YouTube', url: 'https://youtube.com/' });
  assert.equal(tabs.length, 3);
  assert.deepEqual(tabs[1], { title: 'Gmail', url: 'https://mail.google.com/', windowIndex: 1 });
});

test('parseTabOutput tolerates empty output and titles with spaces/unicode', () => {
  assert.deepEqual(macTabs.parseTabOutput(''), { activeTab: null, tabs: [] });
  assert.deepEqual(macTabs.parseTabOutput(null), { activeTab: null, tabs: [] });
  const { tabs } = macTabs.parseTabOutput(`Café — Mix ${US}https://x.com/${US}1${RS}`);
  assert.equal(tabs[0].title, 'Café — Mix');
});

test('isDeniedError detects Automation denial, not generic failures', () => {
  const denied = new Error('execution error: Not allowed to send Apple events to Google Chrome. (-1743)');
  denied.stderr = '36:45: execution error: Not allowed to send Apple events (-1743)';
  assert.equal(macTabs.isDeniedError(denied), true);
  assert.equal(macTabs.isDeniedError(new Error('User canceled (-128)')), true);
  assert.equal(macTabs.isDeniedError(new Error('Command timed out')), false);
  assert.equal(macTabs.isDeniedError(new Error('Application isn\'t running (-600)')), false);
});

test('buildTabScript uses title for Chromium, name for Safari', () => {
  const chrome = macTabs.buildTabScript('Google Chrome', 'chromium');
  assert.match(chrome, /tell application "Google Chrome"/);
  assert.match(chrome, /title of _t/);
  assert.match(chrome, /ACTIVE/);
  const safari = macTabs.buildTabScript('Safari', 'safari');
  assert.match(safari, /tell application "Safari"/);
  assert.match(safari, /name of _t/);
});

test('matchBrowser maps comm names to known browsers only', () => {
  assert.equal(macTabs.matchBrowser({ name: 'Google Chrome' }).key, 'chrome');
  assert.equal(macTabs.matchBrowser({ name: 'Safari' }).key, 'safari');
  assert.equal(macTabs.matchBrowser({ name: 'safari' }).key, 'safari');
  assert.equal(macTabs.matchBrowser({ name: 'Spotify' }), null);
  assert.equal(macTabs.matchBrowser({ name: 'Google Chrome Helper' }), null);
  assert.equal(macTabs.matchBrowser(null), null);
});

test('enrichWithTabs attaches display tabs and counts, caps stored tabs', () => {
  const apps = [{ name: 'Google Chrome', processName: 'Google Chrome' }, { name: 'Spotify' }];
  const tabs = Array.from({ length: 20 }, (_, i) => ({ title: `Tab ${i}`, url: `https://x/${i}`, windowIndex: 1 }));
  const info = {
    browsers: [
      { key: 'chrome', running: true, supported: true, tabs, totalTabs: 20, activeTab: { title: 'YouTube', url: 'https://youtube.com' } },
    ],
  };
  const { apps: out, tabDenials } = macTabs.enrichWithTabs(apps, info);
  const chrome = out.find((a) => a.name === 'Google Chrome');
  assert.equal(chrome.activeTabTitle, 'YouTube');
  assert.equal(chrome.totalTabs, 20);
  assert.equal(chrome.tabs.length, 8); // capped for display/search
  assert.equal(chrome.tabsSupported, true);
  assert.equal(out.find((a) => a.name === 'Spotify').tabs, undefined);
  assert.deepEqual(tabDenials, []);
});

test('enrichWithTabs surfaces denial as data, not errors', () => {
  const apps = [{ name: 'Google Chrome' }];
  const info = {
    browsers: [{ key: 'chrome', running: true, supported: false, denialReason: 'Allow in Privacy settings.' }],
  };
  const { apps: out, tabDenials } = macTabs.enrichWithTabs(apps, info);
  assert.equal(out[0].tabsSupported, false);
  assert.equal(out[0].tabsDenial, 'Allow in Privacy settings.');
  assert.deepEqual(tabDenials, ['Allow in Privacy settings.']);
});

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

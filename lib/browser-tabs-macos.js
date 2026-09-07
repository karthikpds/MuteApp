'use strict';

/**
 * macOS browser-tab enumeration via AppleScript.
 *
 * `ps` only shows "Google Chrome Helper (Renderer)" for tabs, which is
 * useless for identification. Chromium browsers and Safari expose every tab's
 * title + URL to AppleScript, so the Add App dialog can show e.g.
 * "Google Chrome — ▶ YouTube · +4 more tabs".
 *
 * Constraints (see docs/LIMITATIONS.md):
 *  - Firefox exposes no tab dictionary — never supported here.
 *  - Targeting a browser triggers a one-time macOS Automation prompt
 *    ("AppMute would like to control Google Chrome"). Denial is detected
 *    and reported as data ({ supported: false }), never thrown.
 *  - `tell application` would LAUNCH a non-running browser, so every browser
 *    is guarded by a `pgrep` running-check first (no prompt, no launch).
 *  - Tab titles/URLs are in-memory only and must NEVER be persisted.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// ASCII separators unlikely to appear in titles/URLs.
const SEP_FIELD = String.fromCharCode(31); // unit separator
const SEP_RECORD = String.fromCharCode(30); // record separator

const MAX_TABS_PER_BROWSER = 100;
/** Tabs kept on the picker entry for subtitle/search (full count kept separately). */
const MAX_TABS_STORED = 8;

const BROWSERS = [
  { key: 'chrome', scriptName: 'Google Chrome', kind: 'chromium' },
  { key: 'edge', scriptName: 'Microsoft Edge', kind: 'chromium' },
  { key: 'brave', scriptName: 'Brave Browser', kind: 'chromium' },
  { key: 'arc', scriptName: 'Arc', kind: 'chromium' },
  { key: 'opera', scriptName: 'Opera', kind: 'chromium' },
  { key: 'vivaldi', scriptName: 'Vivaldi', kind: 'chromium' },
  { key: 'safari', scriptName: 'Safari', kind: 'safari' },
];

function run(cmd, args, opts = {}) {
  return execFileAsync(cmd, args, { timeout: 8000, windowsHide: true, ...opts });
}

async function isBrowserRunning(scriptName) {
  try {
    await run('pgrep', ['-x', scriptName], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the AppleScript. Output format:
 *   ACTIVE<US>title<US>url<RS> title<US>url<US>windowIndex<RS> ...
 * The ACTIVE header names the front window's active tab explicitly because
 * `every window` ordering is not guaranteed to put the front window first.
 * The active-tab query is wrapped in try/end try so a running browser with
 * zero windows returns just tab records (or nothing) instead of erroring.
 */
function buildTabScript(scriptName, kind) {
  const titleProp = kind === 'safari' ? 'name' : 'title';
  return `tell application "${scriptName}"
  set _out to ""
  try
    set _at to active tab of front window
    set _out to "ACTIVE" & (ASCII character 31) & (${titleProp} of _at) & (ASCII character 31) & (URL of _at) & (ASCII character 30)
  end try
  set _wi to 0
  repeat with _w in every window
    set _wi to _wi + 1
    repeat with _t in every tab of _w
      set _out to _out & (${titleProp} of _t) & (ASCII character 31) & (URL of _t) & (ASCII character 31) & (_wi as text) & (ASCII character 30)
    end repeat
  end repeat
  return _out
end tell`;
}

/** macOS Automation denial / cancellation signatures from osascript stderr. */
function isDeniedError(e) {
  const msg = String((e && e.stderr) || (e && e.message) || e || '');
  return (
    /-1743/.test(msg) || // not allowed to send Apple events
    /not allowed to send apple events/i.test(msg) ||
    /user canceled/i.test(msg) ||
    /-128\b/.test(msg) // user cancelled
  );
}

/**
 * Parse raw osascript stdout into { activeTab, tabs }.
 * @returns {{ activeTab: {title,url}|null, tabs: Array<{title,url,windowIndex}> }}
 */
function parseTabOutput(stdout) {
  const activeTab = null;
  const tabs = [];
  const text = String(stdout == null ? '' : stdout);
  if (!text) return { activeTab, tabs };
  let active = null;
  for (const record of text.split(SEP_RECORD)) {
    if (!record) continue;
    const fields = record.split(SEP_FIELD);
    if (fields[0] === 'ACTIVE') {
      active = { title: (fields[1] || '').trim(), url: (fields[2] || '').trim() };
    } else if (fields.length >= 2 && (fields[0] || fields[1])) {
      tabs.push({
        title: (fields[0] || '').trim(),
        url: (fields[1] || '').trim(),
        windowIndex: Number(fields[2]) || 0,
      });
    }
  }
  return { activeTab: active, tabs };
}

async function listTabsForBrowser(browser, { timeout = 8000 } = {}) {
  const { scriptName, kind, key } = browser;
  if (!(await isBrowserRunning(scriptName))) {
    return { key, scriptName, running: false, supported: true, tabs: [], totalTabs: 0, activeTab: null };
  }
  try {
    const { stdout } = await run('osascript', ['-e', buildTabScript(scriptName, kind)], { timeout });
    const { activeTab, tabs } = parseTabOutput(stdout);
    const capped = tabs.slice(0, MAX_TABS_PER_BROWSER);
    return {
      key,
      scriptName,
      running: true,
      supported: true,
      tabs: capped,
      totalTabs: tabs.length,
      activeTab,
    };
  } catch (e) {
    if (isDeniedError(e)) {
      return {
        key,
        scriptName,
        running: true,
        supported: false,
        denialReason:
          `"${scriptName}" tab titles need permission: System Settings → Privacy & Security → Automation → allow AppMute to control ${scriptName}.`,
        tabs: [],
        totalTabs: 0,
        activeTab: null,
      };
    }
    // Any other failure (busy browser, timeout): behave as "no tab data",
    // the picker still lists the browser process itself.
    return { key, scriptName, running: true, supported: true, tabs: [], totalTabs: 0, activeTab: null };
  }
}

/**
 * Enumerate tabs for all known browsers (sequentially — parallel osascript
 * calls to the same browser can prompt/fail oddly). Resolves; never rejects.
 */
async function listBrowserTabs(opts = {}) {
  const browsers = [];
  let denied = false;
  for (const b of BROWSERS) {
    const info = await listTabsForBrowser(b, opts);
    browsers.push(info);
    if (info.supported === false) denied = true;
  }
  return { browsers, denied };
}

/** Match a process-list entry to a known browser (exact comm name, case-insensitive). */
function matchBrowser(entry) {
  const n = String((entry && (entry.name || entry.processName)) || '').toLowerCase();
  return BROWSERS.find((b) => b.scriptName.toLowerCase() === n) || null;
}

/**
 * Attach tab info to matching picker entries. Adds:
 *   entry.tabs: [{title, url}] (capped for display/search)
 *   entry.totalTabs: number
 *   entry.activeTabTitle: string
 * Non-browser entries are returned untouched.
 */
function enrichWithTabs(apps, tabInfo) {
  const byKey = new Map((tabInfo && tabInfo.browsers ? tabInfo.browsers : []).map((b) => [b.key, b]));
  // Surface Automation-denial hints to the picker (shown once, inline).
  const denials = (tabInfo && tabInfo.browsers ? tabInfo.browsers : [])
    .filter((b) => b.supported === false)
    .map((b) => b.denialReason);
  for (const app of apps || []) {
    const browser = matchBrowser(app);
    if (!browser) continue;
    const info = byKey.get(browser.key);
    if (!info || !info.running) continue;
    if (info.supported === false) {
      app.tabsSupported = false;
      app.tabsDenial = info.denialReason;
      continue;
    }
    app.tabsSupported = true;
    app.totalTabs = info.totalTabs;
    app.tabs = (info.tabs || []).slice(0, MAX_TABS_STORED).map((t) => ({ title: t.title, url: t.url }));
    if (info.activeTab && info.activeTab.title) {
      app.activeTabTitle = info.activeTab.title;
    } else if (app.tabs.length > 0) {
      app.activeTabTitle = app.tabs[0].title;
    }
  }
  return { apps: apps || [], tabDenials: denials };
}

module.exports = {
  BROWSERS,
  MAX_TABS_PER_BROWSER,
  buildTabScript,
  parseTabOutput,
  isDeniedError,
  isBrowserRunning,
  listTabsForBrowser,
  listBrowserTabs,
  matchBrowser,
  enrichWithTabs,
};

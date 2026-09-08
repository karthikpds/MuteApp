'use strict';

/**
 * Enumeration of running applications on Windows (no external deps).
 * Used by the "+ Add App" dialog so users never have to type a process name.
 *
 * Windows: `tasklist /FO CSV /NH` (+ exe path lookup via wmic when available),
 *        grouped by process name (pid 0 = all processes with that name).
 *        Top-level window titles merge via the AudioController
 *        `windows` command.
 * Returns: [{ pid, name, processName, exePath, bundleId, grouped?,
 *              processCount?, windowTitles? }]
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function run(cmd, args, opts = {}) {
  return execFileAsync(cmd, args, { timeout: 8000, windowsHide: true, ...opts });
}

function parseTasklistCsv(stdout) {
  // Columns: "Image Name","PID","Session Name","Session#","Mem Usage"
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const apps = [];
  for (const line of lines) {
    const m = line.match(/^"([^"]+)","(\d+)",/);
    if (!m) continue;
    const processName = m[1];
    const pid = Number(m[2]);
    if (!Number.isFinite(pid)) continue;
    apps.push({
      pid,
      name: processName.replace(/\.exe$/i, ''),
      processName,
      exePath: '',
      bundleId: '',
    });
  }
  return apps;
}

/** Hide well-known system noise from the picker. */
function isSystemProcess(name) {
  return /^(System|Registry|smss|csrss|wininit|services|lsass|svchost|conhost|dwm|ctfmon|SearchIndexer|RuntimeBroker|ApplicationFrameHost|SystemSettings|TextInputHost)$/i.test(
    name || ''
  );
}

/**
 * Sub-process noise hidden from the picker. Audio control acts on the main
 * process (e.g. mute applies to every chrome.exe session via --process), so
 * rows like "Google Chrome Helper (Renderer)" only confuse identification.
 * Full window titles are attached to the main entry instead (see
 * the AudioController `windows` command).
 */
const HIDDEN_PROCESS_PATTERNS = [
  / helper( \(|$)/i, // "Google Chrome Helper", "Google Chrome Helper (Renderer/GPU)"
  /\(renderer\)/i,
  /\(gpu\)/i,
  /crashpad/i,
  /crash (handler|reporter|pad)/i,
  /-zsh$/i,
];

function isHelperNoise(name) {
  return HIDDEN_PROCESS_PATTERNS.some((re) => re.test(String(name || '')));
}

/** Apps users most commonly mute — floated to the top of the Add dialog. */
const KNOWN_AUDIO_APPS = [
  'chrome', 'msedge', 'edge', 'firefox', 'safari', 'opera', 'brave', 'arc',
  'spotify', 'music', 'itunes', 'vlc', 'discord', 'youtube music',
  'windows media player', 'wmplayer', 'media player', 'quicktime',
  'slack', 'zoom', 'teams', 'steam', 'obs', 'mpv', 'iina', 'podcasts',
];

function pickerScore(name) {
  const n = String(name || '').toLowerCase();
  if (KNOWN_AUDIO_APPS.some((k) => n === k || n.includes(k))) return 0;
  if (/^[A-Z]/.test(String(name || ''))) return 1; // GUI apps usually capitalized
  return 2; // background daemons last
}

/** Order: likely audio producers → GUI apps → background daemons (each A–Z). */
function prioritizeForPicker(apps) {
  return [...apps].sort(
    (a, b) => pickerScore(a.name) - pickerScore(b.name) || a.name.localeCompare(b.name)
  );
}

/**
 * Attach top-level window titles (Windows) to matching entries for picker
 * identification: entry.windowTitles = up to 3 distinct titles.
 * @param {Array} apps picker entries (matched by processName, case-insensitive)
 * @param {Array<{processName, title}>} windows windows with owning process names
 */
function attachWindowTitles(apps, windows) {
  const byName = new Map();
  for (const w of windows || []) {
    const key = String((w && w.processName) || '').toLowerCase();
    if (!key || !w.title) continue;
    if (!byName.has(key)) byName.set(key, []);
    const arr = byName.get(key);
    if (arr.length < 3 && !arr.includes(w.title)) arr.push(w.title);
  }
  for (const app of apps || []) {
    const key = String(app.processName || app.name || '').toLowerCase();
    const hit = byName.get(key);
    if (hit && hit.length) app.windowTitles = hit;
  }
  return apps || [];
}

/**
 * Group Windows rows by process name: browsers spawn dozens of chrome.exe
 * processes and muting covers all of a name's sessions (see --process), so
 * one row per process name is the honest unit. pid 0 means "all processes
 * with this name". Keeps the first non-empty exePath for icons/launch.
 */
function groupWindowsProcesses(apps) {
  const groups = new Map();
  for (const app of apps || []) {
    const key = String(app.processName || app.name || '').toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        pid: 0,
        name: app.name,
        processName: app.processName,
        exePath: app.exePath || '',
        bundleId: '',
        grouped: true,
        processCount: 0,
      });
    }
    const g = groups.get(key);
    g.processCount += 1;
    if (!g.exePath && app.exePath) g.exePath = app.exePath;
  }
  return [...groups.values()];
}

async function listWindows() {
  const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH']);
  const seen = new Map();
  for (const app of parseTasklistCsv(stdout)) {
    if (isSystemProcess(app.name)) continue;
    if (!seen.has(app.pid)) seen.set(app.pid, app);
  }
  // Best-effort exe path enrichment (failure is non-fatal).
  try {
    const { stdout: wmic } = await run('wmic', ['process', 'get', 'ProcessId,ExecutablePath', '/FORMAT:CSV']);
    for (const line of wmic.split(/\r?\n/)) {
      const parts = line.split(',');
      if (parts.length < 3) continue;
      const exePath = (parts[1] || '').trim();
      const pid = Number((parts[2] || '').trim());
      const entry = seen.get(pid);
      if (entry && exePath) entry.exePath = exePath;
    }
  } catch {
    /* wmic missing on newer Windows — exePath stays empty */
  }
  return prioritizeForPicker(groupWindowsProcesses([...seen.values()])).slice(0, 500);
}

async function listProcesses(p = process.platform) {
  if (p === 'win32') return listWindows();
  // Windows-only build: other platforms are unsupported.
  return [];
}

module.exports = {
  listProcesses,
  parseTasklistCsv,
  prioritizeForPicker,
  groupWindowsProcesses,
  attachWindowTitles,
  isHelperNoise,
  HIDDEN_PROCESS_PATTERNS,
};

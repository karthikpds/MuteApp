'use strict';

/**
 * Cross-platform enumeration of running applications (no external deps).
 * Used by the "+ Add App" dialog so users never have to type a process name.
 *
 * Windows: `tasklist /FO CSV /NH` (+ exe path lookup via wmic when available).
 * macOS: `ps -axco pid,comm` merged with running .app bundles via AppleScript
 *        (`tell application "System Events" to get name of every process`).
 * Returns: [{ pid, name, processName, exePath, bundleId }]
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
  if (/^[A-Z]/.test(String(name || ''))) return 1; // GUI apps/agents on macOS are usually capitalized
  return 2; // background daemons last
}

/** Order: likely audio producers → GUI apps → background daemons (each A–Z). */
function prioritizeForPicker(apps) {
  return [...apps].sort(
    (a, b) => pickerScore(a.name) - pickerScore(b.name) || a.name.localeCompare(b.name)
  );
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
  return prioritizeForPicker([...seen.values()]).slice(0, 500);
}

async function listMacOS() {
  const apps = new Map();
  try {
    const { stdout } = await run('ps', ['-axco', 'pid,comm']);
    for (const line of stdout.split('\n').slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const comm = m[2].trim();
      if (!comm || /^(kernel_task|launchd|logd|syslogd)$/.test(comm)) continue;
      if (/^[-.]/.test(comm)) continue; // shells and dotfiles are not GUI apps
      if (/^\d+$/.test(comm)) continue;
      apps.set(pid, { pid, name: comm, processName: comm, exePath: '', bundleId: '' });
    }
  } catch {
    /* fall through to AppleScript-only listing */
  }
  // Overlay GUI bundle ids so the UI can show proper names/icons.
  try {
    const script =
      'tell application "System Events" to get {name, bundle identifier, unix id} of every process whose background only is false';
    const { stdout } = await run('osascript', ['-e', script]);
    // Output is comma-joined triple lists; best-effort parse.
    const names = stdout.split(', ');
    for (const n of names.slice(0, 200)) {
      const clean = n.trim();
      if (clean && ![...apps.values()].some((a) => a.name === clean)) {
        apps.set(-Math.floor(Math.random() * 1e9), {
          pid: 0,
          name: clean,
          processName: clean,
          exePath: '',
          bundleId: '',
        });
      }
    }
  } catch {
    /* Accessibility permission may block this; ps list still works */
  }
  return prioritizeForPicker(
    [...apps.values()].filter((a) => a.name)
  ).slice(0, 500);
}

async function listProcesses(p = process.platform) {
  if (p === 'win32') return listWindows();
  if (p === 'darwin') return listMacOS();
  // Linux/other fallback: /proc-free ps parse.
  try {
    const { stdout } = await run('ps', ['-eo', 'pid,comm']);
    return stdout
      .split('\n')
      .slice(1)
      .map((l) => l.trim().match(/^(\d+)\s+(.+)$/))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), name: m[2], processName: m[2], exePath: '', bundleId: '' }));
  } catch {
    return [];
  }
}

module.exports = { listProcesses, parseTasklistCsv, prioritizeForPicker };

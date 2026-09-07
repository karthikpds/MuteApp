'use strict';

/**
 * Windows audio backend — true per-application mute via WASAPI, plus
 * system-wide pause/resume via media keys.
 *
 * Delegates to native/windows/AudioController.exe (C++, no runtime deps,
 * uses IMMDeviceEnumerator / IAudioSessionManager2 / ISimpleAudioVolume
 * for mute, WM_APPCOMMAND media commands for transport).
 * Protocol: `AudioController.exe <list|windows|mute|unmute|toggle|status|pause|resume|playpause> [--pid N] [--process name]`
 * All commands print JSON to stdout: { ok, ... }.
 *
 * --pid targets one process; --process (no --pid) targets EVERY session with
 * that process name (e.g. all chrome.exe renderers) and reports
 * matchedProcesses. Grouped picker entries (pid 0) therefore mute reliably
 * no matter which sub-process actually renders the audio.
 *
 * pause/resume/playpause post WM_APPCOMMAND media commands to the target
 * app's own top-level windows (e.g. all chrome.exe windows for YouTube
 * Music), falling back to a hung-safe broadcast when no window is found.
 * WASAPI exposes no per-app transport, so unlike mute this still drives
 * the SMTC session and can hit the current player if several are active.
 *
 * If the helper binary is missing (e.g. running from source without building
 * native/), every mutating call fails with an actionable error instead of
 * silently doing nothing (per requirements: never silently fail).
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

function candidatePaths() {
  const here = __dirname;
  return [
    process.env.APPMUTE_AUDIO_HELPER,
    path.join(here, '..', 'native', 'windows', 'build', 'Release', 'AudioController.exe'),
    path.join(here, '..', 'native', 'windows', 'build', 'AudioController.exe'),
    path.join(here, '..', 'native', 'windows', 'AudioController.exe'),
    path.join(process.resourcesPath || '', 'native', 'windows', 'AudioController.exe'),
  ].filter(Boolean);
}

function helperPath() {
  for (const p of candidatePaths()) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function runHelper(args, { timeout = 8000 } = {}) {
  const exe = helperPath();
  if (!exe) {
    throw new Error(
      'Windows audio helper not found. Build native/windows/AudioController.cpp ' +
        '(see native/windows/README.md) and place AudioController.exe next to it, then restart AppMute.'
    );
  }
  try {
    const { stdout } = await execFileAsync(exe, args, { timeout, windowsHide: true });
    const parsed = JSON.parse(String(stdout).trim().split('\n').pop());
    if (!parsed.ok) throw new Error(parsed.error || 'Audio helper reported failure.');
    return parsed;
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`Audio helper returned invalid output: ${e.message}`);
    throw e;
  }
}

async function listSessions() {
  const res = await runHelper(['list']);
  return (res.sessions || []).map((s) => ({
    pid: s.pid,
    processName: s.processName || '',
    exePath: s.exePath || '',
    displayName: s.displayName || s.processName || '',
    muted: !!s.muted,
    volume: typeof s.volume === 'number' ? s.volume : 1,
    hasAudio: s.hasAudio !== false,
  }));
}

/**
 * Top-level visible windows: [{ pid, title }]. Browser titles carry the
 * active tab ("YouTube - Google Chrome") — used for picker identification.
 */
async function listWindows() {
  const res = await runHelper(['windows']);
  return (res.windows || [])
    .map((w) => ({ pid: w.pid, title: (w.title || '').trim() }))
    .filter((w) => w.pid && w.title);
}

/** Windows joined with their owning process name for picker enrichment. */
async function listWindowsWithProcess() {
  const [wins, sessions] = await Promise.all([
    listWindows().catch(() => []),
    listSessions().catch(() => []),
  ]);
  const nameByPid = new Map(sessions.map((s) => [s.pid, s.processName]));
  return wins
    .map((w) => ({ pid: w.pid, title: w.title, processName: nameByPid.get(w.pid) || '' }))
    .filter((w) => w.processName);
}

/** CLI identity args: a concrete PID, else the process name (all sessions). */
function targetArgs(target) {
  if (target.pid) return ['--pid', String(target.pid)];
  const name = target.processName || target.name;
  if (name) return ['--process', String(name)];
  throw new Error('No process identity to control.');
}

/**
 * Transport identity args: prefer the process name over the stored PID.
 * A stored PID goes stale when the app restarts (and for browsers the
 * picked sub-process PID is rarely the window owner), while --process
 * reaches every top-level window of e.g. all chrome.exe at once.
 */
function transportArgs(target) {
  const name = target.processName || target.name;
  if (name) return ['--process', String(name)];
  if (target.pid) return ['--pid', String(target.pid)];
  return [];
}

async function setMuted(target, muted) {
  return withPidFallback(target, async (t) => {
    const res = await runHelper([muted ? 'mute' : 'unmute', ...targetArgs(t)]);
    return { pid: res.pid || t.pid || 0, muted, matchedProcesses: res.matchedProcesses };
  });
}

async function toggleMuted(target) {
  return withPidFallback(target, async (t) => {
    const res = await runHelper(['toggle', ...targetArgs(t)]);
    return { pid: res.pid || t.pid || 0, muted: !!res.muted, matchedProcesses: res.matchedProcesses };
  });
}

async function isMuted(target) {
  return withPidFallback(target, async (t) => {
    const res = await runHelper(['status', ...targetArgs(t)]);
    return !!res.muted;
  });
}

/**
 * Apps that close and reopen get a new PID, so a stored PID can go stale.
 * If a PID-based operation fails with "no session", retry via process-name
 * lookup instead of surfacing a confusing error.
 */
async function withPidFallback(target, fn) {
  try {
    return await fn(target);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (target.pid && target.processName && /no active audio session|not currently running/i.test(msg)) {
      return fn({ ...target, pid: 0 });
    }
    throw e;
  }
}

async function pause(target = {}) {
  const res = await runHelper(['pause', ...transportArgs(target)]);
  return { paused: true, matchedWindows: res.matchedWindows, method: res.method };
}

async function resume(target = {}) {
  const res = await runHelper(['resume', ...transportArgs(target)]);
  return { paused: false, matchedWindows: res.matchedWindows, method: res.method };
}

module.exports = {
  id: 'windows-wasapi',
  supportsPerAppMute: true,
  supportsPause: true,
  helperPath,
  listSessions,
  listWindows,
  listWindowsWithProcess,
  setMuted,
  toggleMuted,
  isMuted,
  pause,
  resume,
};

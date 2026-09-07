'use strict';

/**
 * Windows audio backend — true per-application mute via WASAPI.
 *
 * Delegates to native/windows/AudioController.exe (C++, no runtime deps,
 * uses IMMDeviceEnumerator / IAudioSessionManager2 / ISimpleAudioVolume).
 * Protocol: `AudioController.exe <list|mute|unmute|toggle|status> [--pid N] [--process name]`
 * All commands print JSON to stdout: { ok, ... }.
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

async function resolvePid(target) {
  if (target.pid) return target.pid;
  const sessions = await listSessions();
  const want = String(target.processName || target.name || '').toLowerCase();
  const hit = sessions.find(
    (s) => s.processName.toLowerCase() === want || s.processName.toLowerCase() === `${want}.exe`
  );
  if (!hit) throw new Error(`"${target.name || target.processName}" is not currently running or has no audio session.`);
  return hit.pid;
}

async function setMuted(target, muted) {
  return withPidFallback(target, async (t) => {
    const pid = await resolvePid(t);
    await runHelper([muted ? 'mute' : 'unmute', '--pid', String(pid)]);
    return { pid, muted };
  });
}

async function toggleMuted(target) {
  return withPidFallback(target, async (t) => {
    const pid = await resolvePid(t);
    const res = await runHelper(['toggle', '--pid', String(pid)]);
    return { pid, muted: !!res.muted };
  });
}

async function isMuted(target) {
  return withPidFallback(target, async (t) => {
    const pid = await resolvePid(t);
    const res = await runHelper(['status', '--pid', String(pid)]);
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

async function pause() {
  throw new Error('Pause/Resume is not available on Windows: audio sessions expose mute/volume, not media transport controls.');
}

async function resume() {
  throw new Error('Pause/Resume is not available on Windows: audio sessions expose mute/volume, not media transport controls.');
}

module.exports = {
  id: 'windows-wasapi',
  supportsPerAppMute: true,
  supportsPause: false,
  pauseUnsupportedReason: 'Windows audio sessions expose mute/volume, not media transport controls.',
  helperPath,
  listSessions,
  setMuted,
  toggleMuted,
  isMuted,
  pause,
  resume,
};

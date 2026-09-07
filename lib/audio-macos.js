'use strict';

/**
 * macOS audio backend — honest fallback.
 *
 * macOS exposes no public per-process mute API (CoreAudio is device-level).
 * Instead of faking a system mute, this backend:
 *  1. Uses in-app volume via AppleScript for scriptable apps (Spotify, Music,
 *     VLC-supporting builds) — labelled "emulated" in the UI.
 *  2. Supports pause/resume via AppleScript for common media apps.
 *  3. Reports `supported: false` for mute on everything else, with a
 *     human-readable reason and remediation (use a virtual-audio driver such
 *     as Background Music, or mute the tab inside the browser).
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function osa(script, { timeout = 8000 } = {}) {
  return execFileAsync('osascript', ['-e', script], { timeout });
}

/** App-name matching → AppleScript application name + capabilities. */
function classify(appName = '') {
  const n = appName.toLowerCase();
  if (n.includes('spotify')) return { scriptName: 'Spotify', volume: true, pause: true };
  if (n === 'music' || n.includes('apple music') || n.includes('itunes'))
    return { scriptName: 'Music', volume: true, pause: true };
  if (n.includes('vlc')) return { scriptName: 'VLC', volume: true, pause: true };
  if (n.includes('chrome')) return { scriptName: 'Google Chrome', volume: false, pause: false };
  if (n.includes('edge')) return { scriptName: 'Microsoft Edge', volume: false, pause: false };
  if (n.includes('safari')) return { scriptName: 'Safari', volume: false, pause: false };
  if (n.includes('firefox')) return { scriptName: 'Firefox', volume: false, pause: false };
  if (n.includes('discord')) return { scriptName: 'Discord', volume: false, pause: false };
  if (n.includes('youtube music')) return { scriptName: null, volume: false, pause: false };
  if (n.includes('quicktime')) return { scriptName: 'QuickTime Player', volume: false, pause: true };
  return { scriptName: null, volume: false, pause: false };
}

const UNSUPPORTED_MUTE_REASON =
  'macOS does not provide a per-application mute API. Install a virtual audio driver ' +
  '(e.g. Background Music) for true per-app muting, or mute inside the application itself.';

async function isAppRunning(scriptName) {
  if (!scriptName) return false;
  try {
    const { stdout } = await osa(`tell application "System Events" to (name of processes) contains "${scriptName}"`);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Emulated mute: store previous volume in-memory, set 0 / restore. */
const previousVolumes = new Map(); // appId -> 0..100

async function getAppVolume(scriptName) {
  const { stdout } = await osa(`tell application "${scriptName}" to get sound volume`);
  const v = Number(stdout.trim());
  return Number.isFinite(v) ? v : 100;
}

async function setAppVolume(scriptName, volume) {
  await osa(`tell application "${scriptName}" to set sound volume to ${Math.max(0, Math.min(100, Math.round(volume)))}`);
}

async function setMuted(app, muted) {
  const c = classify(app.name || app.processName);
  if (!c.scriptName || !c.volume) {
    throw new Error(`"${app.name}": ${UNSUPPORTED_MUTE_REASON}`);
  }
  if (!(await isAppRunning(c.scriptName))) {
    throw new Error(`"${app.name}" is not currently running. It will be detected automatically when it launches.`);
  }
  if (muted) {
    if (!previousVolumes.has(app.id)) {
      try {
        previousVolumes.set(app.id, await getAppVolume(c.scriptName));
      } catch {
        previousVolumes.set(app.id, 100);
      }
    }
    await setAppVolume(c.scriptName, 0);
  } else {
    await setAppVolume(c.scriptName, previousVolumes.get(app.id) ?? 100);
    previousVolumes.delete(app.id);
  }
  return { emulated: true, muted };
}

async function isMuted(app) {
  const c = classify(app.name || app.processName);
  if (!c.scriptName || !c.volume) return false;
  try {
    return (await getAppVolume(c.scriptName)) === 0;
  } catch {
    return false;
  }
}

async function toggleMuted(app) {
  const currentlyMuted = await isMuted(app);
  const res = await setMuted(app, !currentlyMuted);
  return { muted: res.muted, emulated: true };
}

async function pause(app) {
  const c = classify(app.name || app.processName);
  if (!c.scriptName || !c.pause) {
    throw new Error(`"${app.name}" does not expose compatible media controls for pause/resume.`);
  }
  await osa(`tell application "${c.scriptName}" to pause`);
  return { paused: true };
}

async function resume(app) {
  const c = classify(app.name || app.processName);
  if (!c.scriptName || !c.pause) {
    throw new Error(`"${app.name}" does not expose compatible media controls for pause/resume.`);
  }
  await osa(`tell application "${c.scriptName}" to play`);
  return { paused: false };
}

function describeSupport(app) {
  const c = classify(app.name || app.processName);
  return {
    muteSupported: !!(c.scriptName && c.volume),
    muteEmulated: !!(c.scriptName && c.volume),
    pauseSupported: !!(c.scriptName && c.pause),
    muteReason: c.scriptName && c.volume ? '' : UNSUPPORTED_MUTE_REASON,
    pauseReason:
      c.scriptName && c.pause ? '' : `"${app.name}" does not expose compatible media controls for pause/resume.`,
  };
}

module.exports = {
  id: 'macos-applescript',
  supportsPerAppMute: false,
  supportsPause: true,
  UNSUPPORTED_MUTE_REASON,
  classify,
  setMuted,
  isMuted,
  toggleMuted,
  pause,
  resume,
  describeSupport,
  listSessions: async () => [],
  // No window-title API without Screen Recording permission (see
  // docs/LIMITATIONS.md); tab titles come from lib/browser-tabs-macos.js.
  listWindowsWithProcess: async () => [],
};

'use strict';

/**
 * Platform helpers + capability flags.
 *
 * Windows-only build: true per-application muting via WASAPI audio
 * sessions (ISimpleAudioVolume per PID). See native/windows/.
 */

function platformId(p = process.platform) {
  if (p === 'win32') return 'windows';
  return p;
}

function isWindows(p = process.platform) {
  return p === 'win32';
}

/**
 * Capabilities of the current platform's audio backend.
 * @returns {{ perAppMute: boolean, perAppMuteEmulated: boolean, pauseResume: boolean, notes: string }}
 */
function audioCapabilities(p = process.platform) {
  if (isWindows(p)) {
    return {
      perAppMute: true,
      perAppMuteEmulated: false,
      pauseResume: false,
      notes: 'Windows supports true per-application muting via WASAPI audio sessions.',
    };
  }
  return {
    perAppMute: false,
    perAppMuteEmulated: false,
    pauseResume: false,
    notes: 'Unsupported platform for per-application audio control.',
  };
}

/** Modifier display names (Windows: Win key). */
function modifierDisplayName(mod, p = process.platform) {
  const mapWin = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', super: 'Win', meta: 'Win', cmd: 'Win', command: 'Win' };
  const m = mapWin;
  return m[String(mod).toLowerCase()] || String(mod);
}

module.exports = { platformId, isWindows, audioCapabilities, modifierDisplayName };

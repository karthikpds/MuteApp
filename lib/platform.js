'use strict';

/**
 * Platform helpers + capability flags.
 *
 * Central place documenting the key platform difference required by
 * docs/requirements.md:
 *  - Windows: true per-application muting IS possible via WASAPI audio
 *    sessions (ISimpleAudioVolume per PID). See native/windows/.
 *  - macOS: the public CoreAudio API exposes only device-level volume.
 *    There is no supported per-process mute API. AppMute therefore uses
 *    the closest reliable behaviors (app-level volume via AppleScript
 *    where the target app exposes it, plus media pause/resume) and marks
 *    everything else as unsupported instead of faking it.
 */

function platformId(p = process.platform) {
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return p;
}

function isWindows(p = process.platform) {
  return p === 'win32';
}

function isMacOS(p = process.platform) {
  return p === 'darwin';
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
  if (isMacOS(p)) {
    return {
      perAppMute: false,
      perAppMuteEmulated: true,
      pauseResume: true,
      notes:
        'macOS has no public per-application mute API. AppMute emulates muting ' +
        'via in-app volume (where scriptable) and supports pause/resume for media apps. ' +
        'True isolation requires a virtual audio driver (e.g. Background Music), which is out of scope.',
    };
  }
  return {
    perAppMute: false,
    perAppMuteEmulated: false,
    pauseResume: false,
    notes: 'Unsupported platform for per-application audio control.',
  };
}

/** Modifier display names per platform (requirements: Win key vs Command/Option). */
function modifierDisplayName(mod, p = process.platform) {
  const mapWin = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', super: 'Win', meta: 'Win', cmd: 'Win', command: 'Win' };
  const mapMac = { ctrl: '⌃', alt: '⌥', shift: '⇧', super: '⌘', meta: '⌘', cmd: '⌘', command: '⌘' };
  const m = isMacOS(p) ? mapMac : mapWin;
  return m[String(mod).toLowerCase()] || String(mod);
}

module.exports = { platformId, isWindows, isMacOS, audioCapabilities, modifierDisplayName };

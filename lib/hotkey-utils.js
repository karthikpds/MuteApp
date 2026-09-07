'use strict';

/**
 * Hotkey utilities — pure functions (no Electron dependency) so they are
 * unit-testable with plain node.
 *
 * Electron accelerators look like "CommandOrControl+Alt+Y".
 * This module normalizes user-captured combos, validates them, formats them
 * for display per-platform, and detects conflicts.
 */

const MODIFIERS = ['ctrl', 'control', 'alt', 'option', 'shift', 'super', 'meta', 'cmd', 'command'];
// Literal Electron tokens. NOTE: we intentionally do NOT fold everything into
// "CommandOrControl": on macOS Super == Command and Control == Ctrl are
// distinct modifiers, and on Windows Control vs Super (Win key) are distinct.
// Storing literals keeps registration and display correct on both platforms.
const CANONICAL_MOD = {
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  cmd: 'Super',
  command: 'Super',
};

function isModifier(token) {
  return MODIFIERS.includes(String(token).toLowerCase());
}

/**
 * Normalize parts (e.g. from a key-capture dialog) into a canonical
 * Electron accelerator string.
 * @param {string[]} parts e.g. ['ctrl','alt','y'] or ['Command','Shift','S']
 * @returns {string} e.g. "Control+Alt+Y"
 */
function normalizeAccelerator(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return '';
  const mods = [];
  let key = '';
  for (const raw of parts) {
    const t = String(raw).trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    if (isModifier(lower)) {
      const canon = CANONICAL_MOD[lower];
      if (!mods.includes(canon)) mods.push(canon);
    } else {
      key = t.length === 1 ? t.toUpperCase() : t;
    }
  }
  if (!key) return '';
  // Canonical modifier order: Control, Alt, Shift, Super
  const order = { Control: 0, Alt: 1, Shift: 2, Super: 3 };
  mods.sort((a, b) => order[a] - order[b]);
  return [...mods, key].join('+');
}

/** Split an accelerator into { modifiers, key }. */
function parseAccelerator(acc) {
  if (!acc || typeof acc !== 'string') return { modifiers: [], key: '' };
  const parts = acc.split('+').map((s) => s.trim()).filter(Boolean);
  const key = parts.length ? parts[parts.length - 1] : '';
  return { modifiers: parts.slice(0, -1), key };
}

/**
 * Validate an accelerator for use as a global hotkey.
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateAccelerator(acc) {
  if (!acc || typeof acc !== 'string' || !acc.trim()) {
    return { ok: false, reason: 'No hotkey provided.' };
  }
  const { modifiers, key } = parseAccelerator(acc);
  if (!key) return { ok: false, reason: 'Hotkey must include a non-modifier key.' };
  if (modifiers.length === 0) {
    return { ok: false, reason: 'Hotkey must include at least one modifier (Ctrl/Alt/Shift/Win/Cmd).' };
  }
  if (/^(ctrl|alt|shift|super|commandorcontrol|command|control|option|meta|cmd)$/i.test(key)) {
    return { ok: false, reason: 'Hotkey must include a non-modifier key.' };
  }
  return { ok: true };
}

/**
 * Human-friendly display string, using platform-appropriate names.
 * "Control+Alt+Y" -> "Ctrl + Alt + Y" (Windows); "Super+Alt+Y" -> "⌘ + ⌥ + Y" (macOS)
 */
function formatForDisplay(acc, p = process.platform) {
  if (!acc) return 'Not set';
  const isMac = p === 'darwin';
  return acc
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((tok) => {
      const l = tok.toLowerCase();
      if (l === 'commandorcontrol') return isMac ? '⌘' : 'Ctrl';
      if (l === 'ctrl' || l === 'control') return isMac ? '⌃' : 'Ctrl';
      if (l === 'alt' || l === 'option') return isMac ? '⌥' : 'Alt';
      if (l === 'shift') return isMac ? '⇧' : 'Shift';
      if (l === 'super' || l === 'meta' || l === 'cmd' || l === 'command') return isMac ? '⌘' : 'Win';
      return tok.length === 1 ? tok.toUpperCase() : tok;
    })
    .join(' + ');
}

/**
 * Find a self-conflict for `acc` within the SAME app only (case-insensitive).
 * Different apps are explicitly allowed to share the same accelerator — one
 * global registration fans out to every app using it.
 * Each app has two hotkey slots (`hotkey` = mute, `pauseHotkey` = pause);
 * a conflict matches only the app's own *other* slot. When `exceptField`
 * ('hotkey' or 'pauseHotkey') is given, that slot (the one being edited) is
 * skipped, so re-saving the same value in the same slot is not a conflict.
 * @param {Array<{id:string, hotkey?:string, pauseHotkey?:string}>} apps
 * @returns the same app if its other slot already uses `acc`, else null
 */
function findConflict(apps, acc, exceptId = null, exceptField = null) {
  if (!acc) return null;
  if (!exceptId) return null; // cross-app duplicates are allowed
  const want = acc.toLowerCase();
  const self = (apps || []).find((a) => a && a.id === exceptId);
  if (!self) return null;
  if (exceptField === 'hotkey') {
    if ((self.pauseHotkey || '').toLowerCase() === want) return self;
    return null;
  }
  if (exceptField === 'pauseHotkey') {
    if ((self.hotkey || '').toLowerCase() === want) return self;
    return null;
  }
  return null;
}

module.exports = {
  normalizeAccelerator,
  parseAccelerator,
  validateAccelerator,
  formatForDisplay,
  findConflict,
};

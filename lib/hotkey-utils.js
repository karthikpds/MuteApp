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
// "CommandOrControl": on Windows Control vs Super (Win key) are distinct.
// Storing literals keeps registration and display correct.
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

/**
 * Every main key selectable in the hotkey dropdown builder.
 * Canonical Electron accelerator tokens, grouped for <optgroup> rendering.
 * Covers full keyboard: letters, digits, F1-F24, punctuation, navigation /
 * editing, numpad, and media keys.
 */
const AVAILABLE_KEY_GROUPS = [
  { label: 'Letters', keys: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') },
  { label: 'Digits', keys: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] },
  {
    label: 'Function',
    keys: Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  },
  {
    label: 'Punctuation',
    keys: ['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/'],
  },
  {
    label: 'Navigation / Editing',
    keys: [
      'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter',
      'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
      'Escape', 'CapsLock', 'Numlock', 'Scrolllock', 'PrintScreen',
    ],
  },
  {
    label: 'Numpad',
    keys: [
      'num0', 'num1', 'num2', 'num3', 'num4',
      'num5', 'num6', 'num7', 'num8', 'num9',
      'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
    ],
  },
  {
    label: 'Media',
    keys: [
      'VolumeUp', 'VolumeDown', 'VolumeMute',
      'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause',
    ],
  },
];

/** Flat list of every selectable key (canonical token). */
const AVAILABLE_KEYS = AVAILABLE_KEY_GROUPS.flatMap((g) => g.keys);

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
    return { ok: false, reason: 'Hotkey must include at least one modifier (Ctrl/Alt/Shift/Win).' };
  }
  if (/^(ctrl|alt|shift|super|commandorcontrol|command|control|option|meta|cmd)$/i.test(key)) {
    return { ok: false, reason: 'Hotkey must include a non-modifier key.' };
  }
  return { ok: true };
}

/**
 * Human-friendly display string (Windows names).
 * "Control+Alt+Y" -> "Ctrl + Alt + Y"; "Super+Alt+Y" -> "Win + Alt + Y"
 */
function formatForDisplay(acc, p = process.platform) {
  if (!acc) return 'Not set';
  return acc
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((tok) => {
      const l = tok.toLowerCase();
      if (l === 'commandorcontrol') return 'Ctrl';
      if (l === 'ctrl' || l === 'control') return 'Ctrl';
      if (l === 'alt' || l === 'option') return 'Alt';
      if (l === 'shift') return 'Shift';
      if (l === 'super' || l === 'meta' || l === 'cmd' || l === 'command') return 'Win';
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
  AVAILABLE_KEYS,
  AVAILABLE_KEY_GROUPS,
};

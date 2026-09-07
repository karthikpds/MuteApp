'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAccelerator,
  parseAccelerator,
  validateAccelerator,
  formatForDisplay,
  findConflict,
} = require('../lib/hotkey-utils');

test('normalizeAccelerator builds canonical Electron accelerators', () => {
  assert.equal(normalizeAccelerator(['ctrl', 'alt', 'y']), 'Control+Alt+Y');
  assert.equal(normalizeAccelerator(['Shift', 'Cmd', 'S']), 'Shift+Super+S');
  assert.equal(normalizeAccelerator(['alt', 'ctrl', 'shift', 'd']), 'Control+Alt+Shift+D');
  assert.equal(normalizeAccelerator(['option', 'meta', 'p']), 'Alt+Super+P');
  assert.equal(normalizeAccelerator(['ctrl']), '');
  assert.equal(normalizeAccelerator([]), '');
});

test('validateAccelerator requires a modifier plus a key', () => {
  assert.equal(validateAccelerator('Control+Alt+Y').ok, true);
  assert.equal(validateAccelerator('Super+Alt+Y').ok, true);
  assert.equal(validateAccelerator('Y').ok, false);
  assert.equal(validateAccelerator('Control+Alt').ok, false);
  assert.equal(validateAccelerator('').ok, false);
});

test('parseAccelerator splits modifiers and key', () => {
  assert.deepEqual(parseAccelerator('Control+Alt+Y'), {
    modifiers: ['Control', 'Alt'],
    key: 'Y',
  });
});

test('formatForDisplay uses platform-appropriate names', () => {
  assert.equal(formatForDisplay('Control+Alt+Y', 'win32'), 'Ctrl + Alt + Y');
  assert.equal(formatForDisplay('Super+Alt+Y', 'darwin'), '⌘ + ⌥ + Y');
  assert.equal(formatForDisplay('Control+Shift+S', 'darwin'), '⌃ + ⇧ + S');
  assert.equal(formatForDisplay('Super+S', 'win32'), 'Win + S');
  assert.equal(formatForDisplay('', 'win32'), 'Not set');
});

test('findConflict allows duplicates across apps, only same-app other slot conflicts', () => {
  const apps = [
    { id: 'a', hotkey: 'Control+Alt+Y' },
    { id: 'b', hotkey: 'Control+Alt+S' },
  ];
  // Different apps may share: no conflict, even without an exceptId.
  assert.equal(findConflict(apps, 'control+alt+y'), null);
  assert.equal(findConflict(apps, 'Control+Alt+Y', 'b', 'hotkey'), null);
  assert.equal(findConflict(apps, 'Control+Alt+S', 'a', 'hotkey'), null);
  // Re-saving the same value in the same slot is not a conflict.
  assert.equal(findConflict(apps, 'Control+Alt+Y', 'a', 'hotkey'), null);
  assert.equal(findConflict(apps, 'Control+Alt+D', 'a', 'hotkey'), null);
  assert.equal(findConflict(apps, ''), null);
});

test('findConflict checks only the same app other slot', () => {
  const apps = [
    { id: 'a', hotkey: 'Control+Alt+Y', pauseHotkey: 'Control+Alt+P' },
    { id: 'b', hotkey: '', pauseHotkey: 'Control+Alt+O' },
  ];
  // Another app using it is fine.
  assert.equal(findConflict(apps, 'control+alt+p', 'b', 'hotkey'), null);
  assert.equal(findConflict(apps, 'Control+Alt+O', 'a', 'hotkey'), null);
  assert.equal(findConflict(apps, 'control+alt+p'), null);
  // Same accelerator in the edited slot of the same app is not a conflict…
  assert.equal(findConflict(apps, 'Control+Alt+Y', 'a', 'hotkey'), null);
  assert.equal(findConflict(apps, 'Control+Alt+P', 'a', 'pauseHotkey'), null);
  // …but it still conflicts with the app's own *other* slot…
  assert.equal(findConflict(apps, 'Control+Alt+P', 'a', 'hotkey').id, 'a');
  assert.equal(findConflict(apps, 'Control+Alt+Y', 'a', 'pauseHotkey').id, 'a');
  // …and with no exceptField there is no self slot to compare (allow).
  assert.equal(findConflict(apps, 'Control+Alt+Y', 'a'), null);
  // Unset slots never conflict.
  assert.equal(findConflict([{ id: 'c', hotkey: '', pauseHotkey: '' }], ''), null);
});

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

test('findConflict detects duplicates case-insensitively, ignoring self', () => {
  const apps = [
    { id: 'a', hotkey: 'Control+Alt+Y' },
    { id: 'b', hotkey: 'Control+Alt+S' },
  ];
  assert.equal(findConflict(apps, 'control+alt+y').id, 'a');
  assert.equal(findConflict(apps, 'Control+Alt+Y', 'a'), null);
  assert.equal(findConflict(apps, 'Control+Alt+D'), null);
  assert.equal(findConflict(apps, ''), null);
});

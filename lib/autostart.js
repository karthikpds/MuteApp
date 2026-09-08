'use strict';

/**
 * Launch-at-startup support without external dependencies.
 *
 * Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Run value.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'AppMute';

async function isEnabled(exePath, p = process.platform) {
  try {
    if (p === 'win32') {
      const { stdout } = await execFileAsync('reg', ['query', RUN_KEY, '/v', VALUE_NAME], { windowsHide: true });
      return stdout.includes(VALUE_NAME);
    }
    return false;
  } catch {
    return false;
  }
}

async function setEnabled(enable, exePath, p = process.platform) {
  if (p === 'win32') {
    if (enable) {
      if (!exePath) throw new Error('Executable path is required to enable startup on Windows.');
      await execFileAsync('reg', ['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', `"${exePath}" --start-minimized`, '/f'], {
        windowsHide: true,
      });
    } else {
      try {
        await execFileAsync('reg', ['delete', RUN_KEY, '/v', VALUE_NAME, '/f'], { windowsHide: true });
      } catch (e) {
        if (!String(e.message || e).includes('unable to find')) throw e;
      }
    }
    return;
  }
  throw new Error(`Launch at startup is not supported on this platform (${p}).`);
}

module.exports = { isEnabled, setEnabled };

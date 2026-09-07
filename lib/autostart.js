'use strict';

/**
 * Launch-at-startup support without external dependencies.
 *
 * Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Run value.
 * macOS: ~/Library/LaunchAgents/com.appmute.app.plist (opens the .app bundle).
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'AppMute';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.appmute.app.plist');

async function isEnabled(exePath, p = process.platform) {
  try {
    if (p === 'win32') {
      const { stdout } = await execFileAsync('reg', ['query', RUN_KEY, '/v', VALUE_NAME], { windowsHide: true });
      return stdout.includes(VALUE_NAME);
    }
    if (p === 'darwin') {
      if (!fs.existsSync(PLIST_PATH)) return false;
      const content = fs.readFileSync(PLIST_PATH, 'utf8');
      return content.includes('AppMute');
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
  if (p === 'darwin') {
    if (enable) {
      const appPath = (exePath || process.execPath || '').split('/Contents/')[0] || '/Applications/AppMute.app';
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.appmute.app</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/open</string><string>${appPath}</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
      fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
      fs.writeFileSync(PLIST_PATH, plist, 'utf8');
    } else if (fs.existsSync(PLIST_PATH)) {
      fs.unlinkSync(PLIST_PATH);
    }
    return;
  }
  throw new Error(`Launch at startup is not supported on this platform (${p}).`);
}

module.exports = { isEnabled, setEnabled };

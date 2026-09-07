'use strict';

/**
 * Platform-isolated audio facade shared by main.js.
 * Windows/macOS implementations live in their own modules; UI and hotkey
 * logic only talk to this facade.
 */

const platform = require('./platform');

function backend(p = process.platform) {
  if (platform.isWindows(p)) return require('./audio-windows');
  if (platform.isMacOS(p)) return require('./audio-macos');
  // Unknown platform: safe no-op backend that explains itself.
  return {
    id: 'unsupported',
    supportsPerAppMute: false,
    supportsPause: false,
    listSessions: async () => [],
    setMuted: async (app) => {
      throw new Error(`Per-application audio is not supported on this platform for "${app.name}".`);
    },
    toggleMuted: async (app) => {
      throw new Error(`Per-application audio is not supported on this platform for "${app.name}".`);
    },
    isMuted: async () => false,
    pause: async (app) => {
      throw new Error(`Pause/Resume is not supported on this platform for "${app.name}".`);
    },
    resume: async (app) => {
      throw new Error(`Pause/Resume is not supported on this platform for "${app.name}".`);
    },
  };
}

/** Per-app support description for menus/badges. */
function describeSupport(app, p = process.platform) {
  if (platform.isMacOS(p)) return require('./audio-macos').describeSupport(app);
  if (platform.isWindows(p)) {
    return { muteSupported: true, muteEmulated: false, pauseSupported: false, muteReason: '', pauseReason: 'Windows audio sessions expose mute/volume, not media transport controls.' };
  }
  return {
    muteSupported: false,
    muteEmulated: false,
    pauseSupported: false,
    muteReason: 'Unsupported platform.',
    pauseReason: 'Unsupported platform.',
  };
}

module.exports = { backend, describeSupport };

'use strict';

/**
 * Windows audio facade shared by main.js.
 * UI and hotkey logic only talk to this facade.
 */

const platform = require('./platform');

function backend(p = process.platform) {
  if (platform.isWindows(p)) return require('./audio-windows');
  // Unknown platform: safe no-op backend that explains itself.
  return {
    id: 'unsupported',
    supportsPerAppMute: false,
    supportsPause: false,
    listSessions: async () => [],
    listWindowsWithProcess: async () => [],
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
  if (platform.isWindows(p)) {
    return { muteSupported: true, muteEmulated: false, pauseSupported: true, muteReason: '', pauseReason: '' };
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

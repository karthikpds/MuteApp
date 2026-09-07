# AppMute

Mute or pause audio from specific apps — a cross-platform desktop utility for
**Windows and macOS** (per `docs/requirements.md`).

- Pick running apps from a searchable dialog (no manual process names).
- Assign each app a **global hotkey** (works while AppMute is in the background).
- Per-app **mute toggle** that preserves volume and never touches other apps.
- Pause/Resume where the OS exposes media controls.
- Dark-theme UI, system tray / menu-bar mode, launch-at-startup, persisted config.
- Honest platform handling: true WASAPI muting on Windows; emulated in-app
  volume + pause on macOS (which has no per-app mute API) — see
  `docs/LIMITATIONS.md`.

## Quickstart

```bash
npm install
npm test        # unit tests (hotkeys, store, platform matrix)
npm start       # run the app in development
```

### Windows: build the audio helper (one step)

The UI runs without it, but muting needs the tiny WASAPI helper:

```bat
cd native\windows
cl /EHsc /std:c++17 /O2 AudioController.cpp /link ole32.lib psapi.lib
```

Details and CMake alternative: `native/windows/README.md`.

### Packaging installers

```bash
npm run dist:win   # NSIS installer (run on Windows)
npm run dist:mac   # DMG (run on macOS)
```

## Usage

1. Click **+ Add App**, search, select, **Add**.
2. Click **Set hotkey** on the row, press e.g. `Ctrl + Alt + Y`, **Save**.
3. Press the hotkey anywhere — the app toggles, others keep playing.
4. `⋮` menu: Mute/Unmute, Set Hotkey, Pause/Resume (if supported), Open, Remove.
5. `⚙ Settings`: startup, start minimized, notifications, tray-on-close, theme, reset.

Config lives in the OS app-data folder (`appmute-config.json`): apps, hotkeys,
mute state, preferences, window bounds. Apps that exit stay listed and are
re-detected on relaunch.

## Layout

```
main.js preload.js renderer/ lib/ native/windows/ tests/ docs/
```

Architecture decisions: `docs/ARCHITECTURE.md`.
Platform limitations: `docs/LIMITATIONS.md`.

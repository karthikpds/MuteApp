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
npm test        # 26 tests: hotkeys, store, platform/audio matrix, browser tabs,
                # picker grouping/subtitles/search, renderer smoke
npm start       # run the app in development
```

### Windows: build the audio helper (one step)

The UI runs without it, but muting needs the tiny WASAPI helper:

```bat
cd native\windows
cl /EHsc /std:c++17 /O2 AudioController.cpp /link ole32.lib user32.lib psapi.lib
```

Details and CMake alternative: `native/windows/README.md`.

### Installing on a Windows machine

End users don't build anything — grab the installer or follow the manual
steps in **`docs/INSTALL-Windows.md`** (download vs. build, SmartScreen
note, uninstall). CI builds every push to `main`
(`.github/workflows/build-win.yml`); pushing a `v*` tag publishes a Release.

### Packaging installers

```bash
npm run dist:win   # NSIS installer (run on Windows)
npm run dist:mac   # DMG (run on macOS)
```

## Usage

1. Click **+ Add App**, search, select, **Add**. The picker shows browser tab
   titles (e.g. `Google Chrome — ▶ YouTube`) so you can find the right app;
   Helper/Renderer sub-processes are hidden and selecting a tab adds its
   parent browser (muting is per-process, not per-tab). On macOS, first use
   asks permission to control each browser — see `docs/LIMITATIONS.md`;
   denying it only hides tab titles.
2. Click **Set hotkey** on the row, press e.g. `Ctrl + Alt + Y`, **Save**.
3. Press the hotkey anywhere — the app mutes + pauses together (next press unmutes + resumes), others keep playing. Where pause isn't supported the hotkey just mutes.
4. `⋮` menu: Mute/Unmute, Set Hotkey, Pause/Resume (if supported), Open, Remove.
5. `⚙ Settings`: startup, start minimized, notifications, tray-on-close, theme, reset.

Config lives in the OS app-data folder as `appmute-config.json`
(`~/Library/Application Support/appmute` on macOS, `%APPDATA%\appmute` on
Windows): apps, hotkeys, mute state, preferences, window bounds. Apps that
exit stay listed and are re-detected on relaunch. Tab titles/URLs shown in
the picker are never written to this file — they stay in memory only.

## Troubleshooting

- **Blank window on launch** — a stale background instance may hold the
  single-instance lock. Quit all instances (`pkill -f MuteApp`), delete the
  saved state (`rm -rf ~/Library/Application\ Support/appmute` on macOS),
  and relaunch. Load failures and renderer crashes now surface error dialogs
  instead of a silent blank screen.
- **Hotkey won't save** — the combination is likely OS-reserved; the dialog
  shows the exact reason. Pick another combination.
- **No tab titles on macOS** — allow control in System Settings → Privacy &
  Security → Automation. Denying only hides tab titles.
- **Mute fails on Windows** — build `AudioController.exe` first (see above);
  the error message points at `native/windows/README.md`.
- **Need renderer logs** — run `npm start -- --debug` to forward renderer
  console messages to the terminal.

## Layout

```
main.js preload.js renderer/ lib/ native/windows/ resources/ tests/ docs/
```

`resources/` holds the tray/window icons plus `generate-icons.py` (stdlib-only
generator — rerun it after editing the artwork).

Architecture decisions: `docs/ARCHITECTURE.md`.
Platform limitations: `docs/LIMITATIONS.md`.

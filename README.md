# AppMute

Mute or pause audio from specific apps — a desktop utility for
**Windows**.

- Pick running apps from a searchable dialog (no manual process names).
- Assign each app two **global hotkeys** — one for mute, one for pause
  (each works while AppMute is in the background).
- Per-app **mute toggle** via WASAPI that preserves volume and never touches other apps.
- Pause/Resume via media commands.
- Dark-theme UI, system tray mode, launch-at-startup, persisted config.

## Quickstart

```bash
npm install
npm test        # hotkeys (incl. dual mute/pause slots), store
                # (incl. legacy single-hotkey migration), platform/audio matrix,
                # picker grouping/subtitles/search, renderer smoke
npm start       # run the app in development (on Windows)
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
```

## Usage

1. Click **+ Add App**, search, select, **Add**. The picker shows window
   titles (e.g. `YouTube - Google Chrome`) so you can find the right app;
   Helper/Renderer sub-processes are hidden and rows are grouped per process
   name (muting is per-process, not per-tab).
2. Click **Set mute key** on the row (and **Set pause key**), press e.g.
   `Ctrl + Alt + Y` for mute and `Ctrl + Alt + U` for pause, **Save**. A
   combination may only occupy one slot anywhere, so the dialog warns if it
   clashes with any mute or pause key, including the app's own other slot.
3. Press a hotkey anywhere — mute toggles mute, pause toggles pause/resume;
   other apps keep playing.
4. `⋮` menu: Mute/Unmute, Set mute hotkey…, Set pause hotkey…, Pause/Resume, Open, Remove.
5. `⚙ Settings`: startup, start minimized, notifications, tray-on-close, theme, reset.

Config lives in `%APPDATA%\appmute\appmute-config.json`: apps, hotkeys, mute
state, preferences, window bounds. Apps that exit stay listed and are
re-detected on relaunch. Window titles shown in the picker are never written
to this file — they stay in memory only.

## Troubleshooting

- **Blank window on launch** — a stale background instance may hold the
  single-instance lock. Quit all instances, delete the saved state
  (`%APPDATA%\appmute`), and relaunch. Load failures and renderer crashes now
  surface error dialogs instead of a silent blank screen.
- **Hotkey won't save** — the combination is likely OS-reserved or already
  used as another mute/pause key; the dialog shows the exact reason. Pick
  another combination.
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

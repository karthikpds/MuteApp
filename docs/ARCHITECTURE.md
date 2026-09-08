# AppMute — architecture

## Decision summary

| Concern | Decision | Why |
|---|---|---|
| Desktop framework | **Electron** | Mature `globalShortcut` (global hotkeys), `Tray` (Windows system tray), `Notification`, `getFileIcon`, `autoLaunch`-equivalent via own code. Lower implementation risk than Tauri/Rust for WASAPI bindings, and `electron-builder` produces a real NSIS installer. |
| Windows per-app mute | **WASAPI audio sessions** via `native/windows/AudioController.exe` (C++, SDK-only) | `ISimpleAudioVolume::SetMute/GetMute` per PID is the supported OS mechanism. A tiny out-of-process CLI avoids node-gyp rebuilds per Electron version and keeps the helper testable standalone (`AudioController.exe list`). |
| Global hotkeys | **Electron `globalShortcut`** | Works when AppMute is unfocused; registration failures (OS-reserved combos) surface as errors, never silent. |
| Persistence | **JSON file in `userData`** (`lib/config-store.js`) | Zero dependencies; stores apps, hotkeys, mute state, settings, window bounds. |
| Startup / tray | **Own `lib/autostart.js`** (Run key) + `Tray` | Avoids extra npm deps and their permission quirks. |

## Process layout

```
renderer/  (index.html, styles.css, renderer.js)  — dark-theme UI, dialogs, toasts
   ↕ ipc (preload.js bridge, no Node in renderer)
main.js    — window, tray, globalShortcut registry, IPC handlers, notifications
lib/
  audio-manager.js  — facade over the Windows backend
  audio-windows.js  — spawns AudioController.exe (JSON protocol)
  hotkey-utils.js   — pure normalize/validate/format/conflict (unit-tested)
  config-store.js   — JSON persistence (unit-tested)
  process-list.js   — tasklist enumeration for the Add dialog
  autostart.js      — Run key
  platform.js       — capability flags + modifier names
native/windows/    — AudioController.cpp + CMakeLists + README
resources/         — tray.png / tray@2x.png / app-icon.png + generate-icons.py (stdlib-only PNG generator)
```

## Key flows

- **Toggles via hotkeys:** `globalShortcut` → `handleMuteHotkey(id)` → `audio.toggleMuted(entry)` (mute chip / mute hotkey), and separately → `handlePauseHotkey(id)` → `audio.pause`/`resume` driven by tracked pause state (pause chip / pause hotkey) → persist → `apps-updated` event → tray refresh + OS notification. Each app stores `hotkey` (mute) + `pauseHotkey` (pause); either slot may be unset.
- **Set hotkey:** renderer captures combo per slot (mute/pause) → main validates → conflict-check against *both* slots of every app (an app's own other slot included) → `unregister`/`register` that slot only → persist only if the OS accepted it.
- **Status refresh:** main re-queries WASAPI sessions on `get-state` and every 15 s, so closed/reopened apps show *Not running* then recover automatically.
- **Add dialog enrichment:** `list-processes` merges top-level window titles (Windows `AudioController windows`); Helper/Renderer sub-process rows are hidden and rows are grouped per process name since `--process` mute covers all of a name's sessions.
- **Close button:** hidden to tray when `minimizeToTrayOnClose` is set; `Quit AppMute` in the tray menu exits fully.
- **Single instance:** a second launch exits immediately and focuses the existing window (stale background processes therefore block startup visibly — see README troubleshooting).
- **Load failures:** `did-fail-load` / `render-process-gone` surface error dialogs with reload, and `npm start -- --debug` forwards renderer console output to the terminal, so a blank window is always explainable.

## Verification performed

- `npm test` — hotkey normalize/validate/format/dual-slot conflicts,
  config persistence/corruption/reset/legacy-hotkey migration, platform/audio
  capability matrix, tasklist parsing, picker ordering, Helper-noise filtering,
  Windows process grouping, window-title merge, picker subtitle/search,
  renderer DOM smoke (real `renderer.js` against a stub DOM, incl. dual hotkey
  chips), element-id cross-check between renderer and HTML.
- `npx electron --version` + smoke load of all `lib/` modules without Electron.
- Windows native code (`AudioController.cpp`: WASAPI mute, `windows` command,
  process-wide mute, targeted `WM_APPCOMMAND` pause/resume with hung-safe
  broadcast fallback) is compiled with MSVC on every push by
  `.github/workflows/build-win.yml` (which also smoke-tests the helper binary
  and runs the full `npm test` suite on Windows), and pause/resume plus both
  hotkeys have been exercised against live apps on a Windows machine
  (`AudioController.exe pause|resume --process chrome.exe`).

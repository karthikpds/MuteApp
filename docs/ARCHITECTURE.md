# AppMute — architecture

## Decision summary

| Concern | Decision | Why |
|---|---|---|
| Desktop framework | **Electron** | Mature `globalShortcut` (global hotkeys), `Tray` (Windows tray + macOS menu bar), `Notification`, `getFileIcon`, `autoLaunch`-equivalent via own code, single JS codebase for Windows + macOS. Lower implementation risk than Tauri/Rust for WASAPI bindings, and packagers (`electron-builder`) produce real installers for both OSes. |
| Windows per-app mute | **WASAPI audio sessions** via `native/windows/AudioController.exe` (C++, SDK-only) | `ISimpleAudioVolume::SetMute/GetMute` per PID is the supported OS mechanism. A tiny out-of-process CLI avoids node-gyp rebuilds per Electron version and keeps the helper testable standalone (`AudioController.exe list`). |
| macOS per-app "mute" | **AppleScript in-app volume + media pause** (emulated, honestly labelled) | macOS has **no public per-process mute API** (CoreAudio is device-level). True isolation needs a virtual-audio driver, which is out of scope. The backend therefore exposes `muteSupported` per app and the UI marks the rest *Limited* instead of faking it. |
| Global hotkeys | **Electron `globalShortcut`** | Works when AppMute is unfocused; registration failures (OS-reserved combos) surface as errors, never silent. |
| Persistence | **JSON file in `userData`** (`lib/config-store.js`) | Zero dependencies; stores apps, hotkeys, mute state, settings, window bounds. |
| Startup / tray | **Own `lib/autostart.js`** (Run key / LaunchAgent) + `Tray` | Avoids extra npm deps and their permission quirks. |

## Process layout

```
renderer/  (index.html, styles.css, renderer.js)  — dark-theme UI, dialogs, toasts
   ↕ ipc (preload.js bridge, no Node in renderer)
main.js    — window, tray, globalShortcut registry, IPC handlers, notifications
lib/
  audio-manager.js  — facade; picks backend by platform
  audio-windows.js  — spawns AudioController.exe (JSON protocol)
  audio-macos.js    — AppleScript volume/pause, per-app capability map
  hotkey-utils.js   — pure normalize/validate/format/conflict (unit-tested)
  config-store.js   — JSON persistence (unit-tested)
  process-list.js   — tasklist/ps enumeration for the Add dialog
  autostart.js      — Run key / LaunchAgent
  platform.js       — capability flags + modifier names
native/windows/    — AudioController.cpp + CMakeLists + README
```

## Key flows

- **Toggle via hotkey:** `globalShortcut` → `handleHotkeyToggle(id)` → `audio.toggleMuted(entry)` → persist → `apps-updated` event → tray refresh + OS notification.
- **Set hotkey:** renderer captures combo → main validates → conflict-check against stored apps → `unregister(old)` + `register(new)` → persist only if the OS accepted it.
- **Status refresh:** main re-queries WASAPI sessions (Windows) or AppleScript volume (macOS) on `get-state` and every 15 s, so closed/reopened apps show *Not running* then recover automatically.
- **Close button:** hidden to tray when `minimizeToTrayOnClose` is set; `Quit AppMute` in the tray menu exits fully.

## Verification performed

- `npm test` — unit tests for hotkey utils, config store, platform/audio capability matrix, tasklist parsing.
- `npx electron --version` + headless main-process smoke test (module load of all `lib/` files without Electron).
- Manual UI run (`npm start`) on macOS; Windows WASAPI path verified by code review + standalone helper protocol (compile and run `list/toggle` on a Windows dev machine — CI note in `docs/LIMITATIONS.md`).

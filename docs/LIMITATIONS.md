# AppMute — platform limitations (Windows)

## Windows: true mute, one build step

Windows supports real per-app mute via WASAPI (`ISimpleAudioVolume` per audio
session). The only requirement is compiling the helper once:

```bat
cd native\windows
cl /EHsc /std:c++17 /O2 AudioController.cpp /link ole32.lib user32.lib psapi.lib
```

Until `AudioController.exe` exists, mute actions fail with an explicit message
pointing at `native/windows/README.md` — never a silent no-op. Edge cases
handled: process with no active session (idle, not producing audio), process
exited between listing and muting, multiple sessions per PID (all toggled
together), multiple PIDs per process name (`--process` mute/toggle covers
every `chrome.exe` at once and reports `matchedProcesses`), stale stored PIDs
(automatic retry via process-name lookup when an app was closed and reopened),
previous volume preserved (mute ≠ volume change).

Pause/Resume on Windows posts media commands (`APPCOMMAND_MEDIA_PAUSE` /
`APPCOMMAND_MEDIA_PLAY` through `AudioController.exe pause|resume --process
<name>`) to the target app's own windows — e.g. all `chrome.exe` windows for
YouTube Music — falling back to a hung-safe broadcast to the current media
(SMTC) session when no window matches. Unlike mute this is window-targeted,
not audio-session targeted: with several players active it can still hit the
current one, not necessarily the row you clicked. If Resume seems dead after
Pause, rebuild `AudioController.exe` (pre-targeting builds used a blocking
broadcast that could deliver out of order) and prefer `--process` over a
stale PID.

## Window titles in the picker (identification only)

The Add dialog shows top-level window titles via the AudioController `windows`
command (no permissions needed). A window title carries the *active* tab
("YouTube - Google Chrome"); background tabs are not enumerable without
relaunching the browser with debug flags, which AppMute will not do.

Showing a window title does **not** mean per-tab muting: mute granularity is the
whole process. Selecting the "YouTube" row adds Google Chrome, and muting mutes
all of Chrome's audio. Window titles are kept in memory only and are never
written to the config file.

## Global hotkeys

Registered with Electron `globalShortcut`, which cannot override OS-reserved
combinations. If registration fails, the Save is rolled back and the error is
shown. Each hotkey requires at least one modifier plus a key; each app has
separate mute and pause slots and a combination may only occupy one slot
anywhere (including the same app's other slot). Modifiers are stored
literally (`Control`/`Alt`/`Shift`/`Super`), where `Super` means the Windows
key — display names use Windows conventions (`Ctrl + Alt + Y`, `Win + S`).

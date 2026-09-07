# AppMute — platform limitations (read this first on macOS)

## macOS: no true per-application mute API

macOS CoreAudio controls **device** volume, not per-process volume. There is no
supported API to mute PID X while leaving PID Y untouched. Apps that appear to
do this (SoundSource, Background Music) install a **virtual audio device driver**
that re-routes all audio — a kernel/driver-level project with its own installer,
permissions, and stability surface. That is deliberately out of scope here.

What AppMute does instead (honestly labelled in the UI):

| App | Mute | Pause/Resume | How |
|---|---|---|---|
| Spotify, Apple Music, VLC | ✅ emulated | ✅ | AppleScript in-app `sound volume` 0/restore + `pause`/`play` |
| QuickTime Player | ❌ | ✅ | AppleScript transport only |
| Chrome, Edge, Safari, Firefox, Discord, YouTube Music, others | ❌ *Limited* | ❌ | No scriptable volume/transport; UI disables the actions and explains why |

The main window shows a persistent banner on macOS, and each unsupported row
carries a *Limited on macOS* pill plus the reason in its ⋮ menu. Remediation
offered: mute inside the app (e.g. the browser tab) or install a virtual-audio
driver such as Background Music.

macOS Accessibility note: enumerating GUI processes via System Events may
require Automation permission; denial only degrades the Add dialog (the `ps`
fallback still lists processes).

## Tab/window titles in the picker (identification only)

The Add dialog shows browser tab titles so you can find e.g. your YouTube tab:

- **macOS:** every tab's title + URL for Chrome, Edge, Brave, Arc, Opera,
  Vivaldi, and Safari via AppleScript. First use triggers a macOS Automation
  prompt per browser ("AppMute would like to control Google Chrome"); denying
  it only hides tab titles, everything else keeps working. Firefox exposes no
  tab API on macOS and can never show tabs here.
- **Windows:** top-level window titles via the AudioController `windows`
  command (no permissions needed). A window title carries the *active* tab
  ("YouTube - Google Chrome"); background tabs are not enumerable without
  relaunching the browser with debug flags, which AppMute will not do.

Showing a tab title does **not** mean per-tab muting: mute granularity is the
whole process on both platforms. Selecting the "YouTube" row adds Google
Chrome, and muting mutes all of Chrome's audio. Tab titles/URLs are kept in
memory only and are never written to the config file.

## Windows: true mute, one build step

Windows supports real per-app mute via WASAPI (`ISimpleAudioVolume` per audio
session). The only requirement is compiling the helper once:

```bat
cd native\windows
cl /EHsc /std:c++17 /O2 AudioController.cpp /link ole32.lib psapi.lib
```

Until `AudioController.exe` exists, mute actions fail with an explicit message
pointing at `native/windows/README.md` — never a silent no-op. Edge cases
handled: process with no active session (idle, not producing audio), process
exited between listing and muting, multiple sessions per PID (all toggled
together), previous volume preserved (mute ≠ volume change).

Pause/Resume is **not** offered on Windows: audio sessions expose no media
transport; the menu item is disabled with that explanation.

## Global hotkeys

Registered with Electron `globalShortcut`, which cannot override OS-reserved
combinations. If registration fails, the Save is rolled back and the error is
shown. Hotkeys require at least one modifier plus a key. Modifiers are stored
literally (`Control`/`Alt`/`Shift`/`Super`), where `Super` means Command on
macOS and the Windows key on Windows — display names adapt per platform.

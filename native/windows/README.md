# Windows audio helper (AudioController.exe)

True per-application muting on Windows is implemented with WASAPI audio
sessions (`ISimpleAudioVolume::SetMute` per process ID). `AudioController.cpp`
is a dependency-free C++ CLI (Windows SDK only) that the Electron layer calls:

```
AudioController.exe list
AudioController.exe windows
AudioController.exe mute   --pid 1234
AudioController.exe unmute --process chrome.exe
AudioController.exe toggle --pid 1234
AudioController.exe status --pid 1234
AudioController.exe pause
AudioController.exe resume
AudioController.exe playpause
```

Every command prints one JSON object (`{"ok":true,...}`).

Pause/Resume post `APPCOMMAND_MEDIA_PAUSE` / `APPCOMMAND_MEDIA_PLAY` /
`APPCOMMAND_MEDIA_PLAY_PAUSE` to the target app's own top-level windows
(`--process chrome.exe` reaches all Chrome windows, so the YouTube Music tab
is hit regardless of sub-process PID; `--pid` targets one process). With no
match it falls back to a hung-safe broadcast to the current Windows media
(SMTC) session. Unlike mute this is window-targeted, not audio-session
targeted, so with several players active it can still hit the current one.
`pause`/`resume` report `matchedWindows` and `method:"targeted"|"broadcast"`.
Test with the process name first (stale-PID-proof for browsers):

- `--pid` targets one process. `--process` (without `--pid`) targets **every**
  session with that process name and reports `matchedProcesses` — this is how
  AppMute reliably mutes Chrome no matter which `chrome.exe` sub-process
  renders the audio.
- `windows` lists visible top-level windows as
  `{"windows":[{"pid":N,"title":"YouTube - Google Chrome"}, ...]}` for picker
  identification (active tab per browser window). Needs no permissions.

## Build

Option A — Visual Studio (x64 Native Tools Command Prompt):

```bat
cd native\windows
cl /EHsc /std:c++17 /O2 AudioController.cpp /link ole32.lib user32.lib psapi.lib
```

Option B — CMake:

```bat
cd native\windows
cmake -S . -B build -A x64
cmake --build build --config Release
copy build\Release\AudioController.exe .
```

AppMute looks for the binary in (first hit wins):

1. `%APPMUTE_AUDIO_HELPER%`
2. `native/windows/build/Release/AudioController.exe`
3. `native/windows/build/AudioController.exe`
4. `native/windows/AudioController.exe`
5. `<resources>/native/windows/AudioController.exe` (packaged app)

## Test

```bat
AudioController.exe list
AudioController.exe windows
AudioController.exe status --process chrome.exe
AudioController.exe toggle --process chrome.exe
AudioController.exe pause --process chrome.exe
AudioController.exe resume --process chrome.exe
```

## Troubleshooting

- `No default audio output device found` — no playback device is enabled.
- `Process has no active audio session` — the app is running but not
  producing audio right now (common for idle browsers). Start playback and retry.
- The helper must run as the same user as the audio session (normal case).

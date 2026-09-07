# Installing AppMute on Windows

Two ways to get AppMute on a Windows machine. **Option A needs no developer
tools** — the audio helper (`AudioController.exe`) is compiled and bundled
automatically.

> The repo is private, so downloading anything from GitHub requires being
> logged in with an account that has access.

## Option A — download the installer (recommended)

1. Open the repo on GitHub and go to **Releases** (tagged versions like
   `v0.1.0`), or to **Actions → build-windows → latest run → Artifacts**
   for a bleeding-edge build.
2. Download `AppMute Setup <version>.exe` and run it.
3. Windows will likely show a **SmartScreen** warning ("Unknown publisher")
   because the installer isn't code-signed. Click **More info → Run anyway**.
   (Signing requires a paid certificate; the code is fully auditable in this
   repo — see `native/windows/AudioController.cpp`.)
4. Choose **install for the current user only** (no admin rights needed) and
   finish the wizard. Launch AppMute from the Start menu.

That's it — muting works immediately, no extra build step.

## Option B — build it yourself on the Windows machine

Prerequisites (one-time):

- Windows 10/11 64-bit
- **Node.js 20+** from https://nodejs.org (includes npm)
- **C++ build tools**: Visual Studio 2022 (any edition, incl. free
  Community) or the standalone *Build Tools for Visual Studio 2022* with the
  **"Desktop development with C++"** workload
- **Git** from https://git-scm.com

Steps (in an **x64 Native Tools Command Prompt for VS 2022**):

```bat
git clone https://github.com/karthikpds/MuteApp.git
cd MuteApp

:: 1. Build the audio helper (true per-app mute needs this binary)
cd native\windows
cl /EHsc /std:c++17 /O2 AudioController.cpp /link ole32.lib psapi.lib
AudioController.exe
:: ^ prints a usage error and exits 1 — that means the binary runs. cd back:
cd ..\..

:: 2. Install JS dependencies and (optionally) test / run unpacked
npm install
npm test
npm start

:: 3. Package the installer (first run downloads NSIS tooling automatically)
npm run dist:win
```

The installer lands in `dist\` as `AppMute Setup <version>.exe` — run it as
in Option A, step 3–4. Every push to `main` also builds this automatically
via `.github/workflows/build-win.yml`; pushing a tag like `v0.2.0` publishes
it as a GitHub Release.

## After installing

- Click **+ Add App**, pick e.g. Chrome or Spotify, assign a global hotkey
  (e.g. `Ctrl + Alt + Y`), then press it while another window is focused.
- Settings (⚙) cover launch-at-startup, tray behavior, and theme.
- Your config lives in `%APPDATA%\appmute\appmute-config.json`.

## Uninstall

Settings → Apps → AppMute → Uninstall (or re-run the installer). Your config
file under `%APPDATA%\appmute` is left behind — delete it for a full reset.

## Troubleshooting

- **"Windows audio helper not found"** — shouldn't happen with the
  installer (the helper is bundled). Reinstall; if building manually, make
  sure `AudioController.exe` sits next to `AudioController.cpp` *before*
  running `npm run dist:win`.
- **"No active audio session"** — the app is running but silent right now
  (idle browser tab). Start playback and retry.
- **Antivirus flags the installer** — expected for unsigned binaries from
  time to time; allow-list it if you trust this source.
- **Hotkey does nothing** — it may be OS-reserved; AppMute shows the exact
  reason when saving. Pick another combination.

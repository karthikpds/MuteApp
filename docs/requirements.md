Build a desktop application called **AppMute** that runs on **Windows**.

## Core purpose

AppMute allows the user to select individual applications and control their audio independently from other applications.

For each added application, the user should be able to assign two **global keyboard hotkeys**: one that toggles that application's audio between muted and unmuted, and one that toggles pause/resume (where the platform exposes media controls).

For example:

* Chrome playing YouTube → press `Ctrl + Alt + Y` → Chrome audio is muted
* Press `Ctrl + Alt + Y` again → Chrome audio is restored
* Press `Ctrl + Alt + U` → YouTube pauses; press again → it resumes
* Spotify → press its assigned mute hotkey → Spotify audio is muted
* Other applications should continue playing normally

The app should work with common audio-producing applications such as:

* Google Chrome
* Microsoft Edge
* Spotify
* YouTube Music
* VLC
* Discord
* Windows Media Player
* Other applications that produce audio

## Important platform requirement

The application must support:

* Windows

Use the Windows audio APIs for controlling application audio.

Do NOT simply change the computer's master volume. The goal is to control the audio of an individual application while leaving all other applications unaffected.

If an application/platform does not support true per-application muting through the available operating-system APIs, handle that limitation gracefully and clearly communicate it to the user.

## Main interface

Create a modern, clean desktop UI with a dark theme.

The main window should contain:

### Header

* AppMute logo/icon
* App name: `AppMute`
* Short description: `Mute or pause audio from specific apps`
* `+ Add App` button

### Application list

Each application should appear as a row/card containing:

* Application icon
* Application name
* Application/process name if useful
* Current audio status
* Assigned mute hotkey and pause hotkey
* Quick mute/unmute toggle
* Three-dot `⋮` menu

Example:

`YouTube`
`Chrome`

Status: `Muted`

Mute hotkey: `Ctrl + Alt + Y`
Pause hotkey: `Ctrl + Alt + U`

Toggle: ON

`⋮`

Another example:

`Spotify`

Status: `Unmuted`

Mute hotkey: `Ctrl + Alt + S`
Pause hotkey: `Ctrl + Alt + P`

Toggle: OFF

`⋮`

## Add App

Clicking `+ Add App` should open an application-selection dialog.

The dialog should:

* Display applications currently running and/or available on the computer
* Allow searching for an application
* Display the application icon and name
* Allow the user to select an application
* Have `Add` and `Cancel` buttons

The user should not have to manually enter a process name unless necessary.

After adding an application, it should immediately appear in the main application list.

## Right-click / three-dot menu

Right-clicking an application, or clicking its `⋮` menu, should display options such as:

* Mute / Unmute
* Set mute hotkey
* Set pause hotkey (only if supported)
* Pause / Resume (only if supported)
* Open Application
* Remove

The exact available options should depend on what the operating system and application support.

## Hotkey system

Each application can have two global hotkeys of its own: a mute hotkey and
a pause hotkey. Either slot may be left unset.

Both hotkeys must work even when AppMute is not the currently focused window.

For example:

* YouTube mute → `Ctrl + Alt + Y`, YouTube pause → `Ctrl + Alt + U`
* Spotify mute → `Ctrl + Alt + S`, Spotify pause → `Ctrl + Alt + P`
* Discord mute → `Ctrl + Alt + D`

When the user chooses `Set mute hotkey` or `Set pause hotkey`:

1. Open a small dialog.
2. Tell the user to press the desired key combination.
3. Detect the key combination.
4. Display the detected combination.
5. Check whether the hotkey is already assigned — as any application's mute
   or pause hotkey, including the same application's other slot.
6. Warn the user if there is a conflict.
7. Allow the user to save or cancel.

The user should be able to use modifier keys such as:

* Ctrl
* Alt
* Shift
* Windows key

Use Windows names (`Ctrl + Alt + Y`, `Win + S`).

## Mute behavior

Pressing an application's assigned mute hotkey should toggle its audio state.

Example:

`Ctrl + Alt + Y`

YouTube:
`Unmuted → Muted`

Press again:

`Muted → Unmuted`

The application should NOT affect the audio of other applications.

When possible, preserve the application's previous volume level rather than changing the volume permanently.

## Optional pause behavior

If technically possible, support pausing media in applications that expose media controls.

For applications that support media pausing:

`Pause → Resume` (via the assigned pause hotkey or the menu)

For applications that do not support it:

* Disable the pause option and the pause hotkey slot
* Explain that the application does not expose compatible media controls

Do not pretend to pause an application if the operating system/API cannot actually do so.

## Visual feedback

The user should always be able to tell whether an application is muted.

Use clear visual states such as:

* 🔊 Unmuted
* 🔇 Muted
* ▶ Playing
* ⏸ Paused

When a mute hotkey is pressed, optionally show a small non-intrusive notification:

`YouTube — Muted`

or

`Spotify — Unmuted`

and likewise `YouTube — Paused` / `YouTube — Resumed` for the pause hotkey.

The notification should disappear automatically.

## Persistence

Save the user's configuration locally.

The following should persist after restarting AppMute:

* Added applications
* Assigned hotkeys
* Mute state where technically possible
* User preferences
* Window preferences

If an application is not currently running, keep it in the list and automatically detect it when it launches again.

## System tray

AppMute should be able to run in the background.

On Windows:

* Add a system tray icon.

Closing the main window should optionally minimize AppMute to the tray rather than completely exiting.

Provide an option in settings for:

`Close window → Keep AppMute running`

## Startup

Provide an option to launch AppMute automatically when the computer starts.

The user should be able to enable/disable this from Settings.

## Settings

Create a simple Settings page containing options such as:

* Launch AppMute at startup
* Start minimized
* Show mute notifications
* Minimize to tray when closed
* Dark/light/system theme
* Reset settings

Keep the settings interface simple and avoid unnecessary options.

## Design

Use a polished modern desktop-app aesthetic.

Design characteristics:

* Dark theme by default
* Rounded cards
* Subtle borders
* Clear typography
* Blue accent color
* Simple icons
* Smooth hover states
* Clear muted/unmuted visual states
* Avoid excessive gradients or visual clutter

The interface should feel like a professional utility such as a modern volume mixer rather than a generic website.

The main application window should be compact enough to remain open beside other applications.

## Architecture

Before implementing, determine the best desktop framework and Windows audio APIs.

Prioritize:

1. Reliable per-application audio control
2. Reliable global hotkeys
3. Windows compatibility
4. Low CPU and memory usage
5. Persistent configuration
6. Simple installation/build process

Keep audio functionality isolated behind a small backend facade.

## Error handling

Handle situations such as:

* The selected application is no longer running
* The application has no audio output
* An application cannot be controlled
* A hotkey cannot be registered
* A hotkey conflicts with another AppMute hotkey
* The user removes an application
* The application changes its audio output
* The target application closes and reopens

Never silently fail.

Show a concise explanation and, when appropriate, instructions for resolving the problem.

## Important implementation rule

Do not build a fake UI/demo.

The application must actually attempt to perform the requested audio controls using real operating-system APIs.

Before building the full UI, verify that the chosen Windows APIs can actually perform per-application audio muting.

If a requested feature is impossible through the available Windows APIs, document the limitation and implement the closest reliable behavior rather than creating a misleading interface.

## Development process

First:

1. Analyze the requirements.
2. Determine the appropriate framework.
3. Determine how per-application audio muting will work on Windows.
4. Determine how global hotkeys will work.
5. Identify limitations.
6. Propose the architecture.

Then implement the application.

After implementation:

* Test every major feature.
* Test multiple applications simultaneously.
* Test hotkeys while another application has focus.
* Test restarting AppMute.
* Test applications being closed and reopened.
* Test Windows-specific behavior.
* Fix errors rather than leaving TODOs or placeholder functionality.

The final result should be a functional, polished **AppMute** desktop application rather than a prototype.


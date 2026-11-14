# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-11-14

Found while testing a PS3 emulator (ARMSX3) on an AYN Thor.

### Added
- `key --source gamepad|dpad|joystick|keyboard`. Emulators ignore keyboard events. With a gamepad
  source, button names map to `KEYCODE_BUTTON_*`, so `key A --source gamepad` sends
  `KEYCODE_BUTTON_A`. `seq` and the MCP `key`/`seq` tools take it too.
- `wait-for rendering` and `fps --wait` take `--min-fps` (default 15) and `--stable` (default 3 s).

### Fixed
- `wait-for rendering` passed on a single burst of frames, such as an animated menu redrawing once.
  It looked at one dump. It now requires new frames sustained over the whole `--stable` window,
  counted against wall-clock time.

## [0.4.0] - 2026-11-14

### Added
- `push` and `pull` copy whole folders:
  - Only missing or changed files are copied; `--checksum` compares hashes, not just sizes.
  - Every copied file is sha256-verified.
  - An interrupted copy resumes when the command is run again.
  - Nothing is ever deleted on either side.
  - `--dry-run` shows the plan.
  - Copies into Android/data run `chmod 660` and `sync` on the copied files.
- `backup <device folder> [--to dir]`: a dated, verified snapshot with `SHA256SUMS`.
- `record [file.mp4] [seconds] [--display <id>]`: screen video through screenrecord, then pulled
  and removed from the device.
- `handroid mcp`: an MCP server over stdio with no dependencies.
  - It exposes 23 tools; screenshots are returned as image content.
  - Tools run the CLI with an argument array, values after `--`.

### Fixed
- sha256 of local files is streamed, so `install`, `push` and `pull` work with files larger than
  2 GB. Before, the whole file was read into memory.

## [0.3.0] - 2026-11-14

### Added
- `doctor [check ...]`: health checks chosen by argument, all run in one adb call, with `--json`,
  `--strict` and `--list`. Checks: `storage[:warn%]`, `memory[:min%]`,
  `thermals[:cpu=,gpu=,battery=]`, `battery`, `phantom`, `wireless`, `app:<pkg>` (uptime plus
  starts/crashes/ANRs/kills from the event log, crash-loop detection) and `perms:<dir>`. Nothing in it
  is device-specific.
- `wait-for text|gone|app|awake|rendering` with `--timeout`.
- `seq`: several validated inputs (tap, swipe, key, sleep) in one adb call.
- `launch --display <id>`.
- `logcat [pkg] [lines] [--errors] [--crash]`.
- `bench`: fps, temperatures and battery per interval, a throttling verdict, `--csv` and `--json`.
- `fps --json`.

### Changed
- The fps sampling loop runs on the device clock, so `fps 5` measures 5 s of wall time. Before, each
  dumpsys call added about 0.2 s per sample.

## [0.2.0] - 2026-11-14

Tested interactively on an AYN Thor (two screens, Android 13).

### Added
- Dual-screen support:
  - `displays` shows each screen's logical and physical id, size, focus and top activity (`--json` too).
  - `tap`, `swipe`, `key` and `type` take `--display <id>`.
  - `shot --display` accepts the logical id as well as the physical one.
- `ui` prints which screen its tree came from on multi-screen devices.
- `ui` and `tap "text"` say "the screen is asleep" instead of uiautomator's "could not get idle state".

### Fixed
- `tap "text"` on a dual-screen device tapped display 0 even when the tree came from the other screen.
  The tree's screen is now worked out from its root window (size and package), because uiautomator
  does not always dump the focused screen.
- `fps` on a mostly static app counted frames from long before the measurement. One run reported
  "42 s measured" for 5 s. The first sample is now only a baseline.
- `ADB=/c/Users/...` (Git Bash style) now works on Windows.

## [0.1.0] - 2026-11-14

First public release.

### Added
- `handroid` CLI (Node 18+, zero dependencies, Windows / Linux / macOS) with `discover [--json]`,
  `connect`, `pair`, `status`, `displays`, `shot [--display]`, `ui [--all]`, `tap`, `swipe`, `key`,
  `type`, `launch`, `apps`, `install [--sha256]`, `push`, `pull`, `thermals` and `fps [--wait]`.
- `fps`: presented fps, 1% / 0.1% lows, worst frame, slow frames and hitches from SurfaceFlinger,
  sampled on the device in overlapping windows; non-overlapping windows are excluded as breaks.
- Claude Code skill `skills/handroid-use` with safety rules for agents and an AYN Thor device profile.
- Test suite on `node:test`: parser and fps-statistics unit tests with captured fixtures, end-to-end
  tests against a fake adb, and a read-only live smoke test behind `HANDROID_LIVE=1`.
- CI on Linux, Windows and macOS with Node 18, 20 and 22; zero-dependency lint.
- `--serial=<id>`, `-h`, and `--` to end option parsing.

### Changed
- Logic moved from the single script into `lib/` modules; `bin/handroid.mjs` is a thin entry point.
- `discover`, `status`, `apps` and `thermals` use one adb round trip per device instead of one per
  property or package.
- `fps` picks the layer of the focused activity, then its `SurfaceView`, and matches the pattern
  case-insensitively.
- 1% / 0.1% lows use nearest-rank percentiles.

### Fixed
- `fps` could measure a presentation window on the second display instead of the app's main window.
- `type`: `#`, `?`, `*`, `[` and other shell metacharacters were interpreted by the device shell.
- `launch`, `key`, `swipe` and `tap` passed unvalidated arguments to the device shell.
- XML entities in the UI tree were decoded twice (`&amp;lt;` became `<`).
- A failed `uiautomator dump` looked like an empty (GPU-drawn) screen.
- `help` failed when adb was missing; `ADB` pointing at a missing file silently used another adb.
- `--serial` for a device that is not connected printed empty values and exited 0.
- `install`, `pull`, `connect` and `pair` exited 0 on failure; a missing local file printed a stack trace.
- `push` reported a hash mismatch when the device has no `sha256sum`.
- `push` / `pull` accepted device paths rewritten into Windows paths by Git Bash.
- Battery values were misaligned when a sysfs file was missing.
- `fps --wait` claimed success after timing out; a non-numeric duration reached the device shell.
- A USB-connected device with wireless debugging on was listed as a LAN device to connect to.
- Linux "no permissions" devices were parsed as state `no`; they now get a udev hint.

[Unreleased]: https://github.com/marinsalinas/handroid-use/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/marinsalinas/handroid-use/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/marinsalinas/handroid-use/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/marinsalinas/handroid-use/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/marinsalinas/handroid-use/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/marinsalinas/handroid-use/releases/tag/v0.1.0

# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/marinsalinas/handroid-use/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/marinsalinas/handroid-use/releases/tag/v0.1.0

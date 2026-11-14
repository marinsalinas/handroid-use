# handroid-use

[![CI](https://github.com/marinsalinas/handroid-use/actions/workflows/ci.yml/badge.svg)](https://github.com/marinsalinas/handroid-use/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**Computer use for Android handhelds: let AI agents see, drive and benchmark your Thor, Retroid or Odin.**

*hand + android.* handroid-use is a small, dependency-free CLI (`handroid`) and a Claude Code skill.
They let an AI agent discover an Android device over adb, see its screen, act on it, copy files
safely and measure real game performance.

It **complements** generic Android agent tools such as [mobile-mcp](https://github.com/mobile-next/mobile-mcp);
it does not replace them. It is Android-only and works on any Android device adb can reach (phones,
tablets, TVs), but its focus is **gaming handhelds** (AYN Thor, Retroid, Odin, Ayaneo...), where
generic tools fall short:

- **Real performance numbers.** Presented fps, 1% / 0.1% lows, worst frame and hitches straight from
  SurfaceFlinger, plus CPU/GPU/battery temperatures and battery draw. Sampling is designed so the
  measurement itself never invents hitches.
- **GPU-drawn game screens.** Games, emulators and Steam Big Picture have no UI tree; the agent is told
  to fall back to screenshots and coordinates.
- **Multi-display devices.** Dual-screen handhelds such as the Thor: list the screens with their focus
  and top app, capture either one and send input to either one. `ui` says which screen its tree came
  from, and `tap "text"` taps on that screen.
- **Hash-verified file copies.** Every `push` is checked by sha256 on the device; app-private folders
  get the `sync` + `chmod 660` their app needs; `install` refuses an APK whose hash does not match.
- **Safety rules for agents.** Don't kill keymappers or input services, leave system settings and
  logins to the human, and don't drive the screen while the user is playing.

Device knowledge lives in profiles under [`skills/handroid-use/references/`](skills/handroid-use/references/);
the [AYN Thor](skills/handroid-use/references/ayn-thor.md) is the first one. More are welcome
(see [CONTRIBUTING.md](CONTRIBUTING.md)).

```
$ handroid discover

ABC123XYZ  [device, usb]
  AYN AYN Thor  -  Android 13 (SDK 33), arm64-v8a
  SoC: QTI QCS8550   GPU: Adreno (TM) 740
  screen: 1080x1920  (2 displays: use shot --display <id>)   battery: 100%   free: 49G

On the network (wireless debugging), not connected:
  192.168.1.50:5555      -> handroid connect 192.168.1.50:5555
```

```
$ handroid thermals
temps: CPU 39.6 C | GPU 36.4 C | battery 28.0 C | battery 100% Full, 0 mA
```

```
$ handroid fps droiddeck 30 --wait
avg fps:   <n>   (<frames> frames, 30.0 s measured)
1% low:    <n> fps   0.1% low: <n> fps
worst:     <ms> ms   frames >33 ms: <n>   hitches >50 ms: <n>
temps: CPU <c> C | GPU <c> C | battery <c> C | battery <pct>% <state>, <mA> mA
```
(Output format. Hollow Knight under DroidDeck on an AYN Thor measured about 115 fps average against
a 120 Hz cap.)

## Requirements

- Node.js 18 or newer. No npm dependencies.
- adb (Android platform-tools). It is found automatically from `ADB`, `ANDROID_HOME` /
  `ANDROID_SDK_ROOT`, `PATH`, the Android SDK default location, winget (Windows) or Homebrew (macOS).
- On the device: USB debugging or wireless debugging.
- Windows, Linux or macOS.

## Install

### CLI

```
npx -y github:marinsalinas/handroid-use discover
```

Or clone it and run `node bin/handroid.mjs <command>` (or `npm link` to get `handroid` on your PATH).

### Claude Code skill

Copy or symlink `skills/handroid-use` into your skills folder:

```
# macOS / Linux
git clone https://github.com/marinsalinas/handroid-use ~/src/handroid-use
ln -s ~/src/handroid-use/skills/handroid-use ~/.claude/skills/handroid-use

# Windows (PowerShell)
git clone https://github.com/marinsalinas/handroid-use $HOME\src\handroid-use
New-Item -ItemType Junction -Path $HOME\.claude\skills\handroid-use -Target $HOME\src\handroid-use\skills\handroid-use
```

### MCP server

`handroid mcp` serves every command as an MCP tool over stdio. Screenshots come back as images the
model can see. Any MCP client can use it, not only Claude Code:

```
claude mcp add handroid --scope user -- npx -y github:marinsalinas/handroid-use mcp
# or, from a clone with npm link:
claude mcp add handroid --scope user -- handroid mcp
```

Each tool runs the CLI with an argument array, never a shell string. Values always come after `--`,
so a value can never turn into a flag. The CLI's validation and exit codes apply unchanged.

### Recommended companion: mobile-mcp

[mobile-mcp](https://github.com/mobile-next/mobile-mcp) is a general-purpose mobile automation MCP
server. Use it next to handroid-use:

```
claude mcp add mobile-mcp --scope user -- npx -y @mobilenext/mobile-mcp@latest
```

## Commands

| Command | What it does |
|---|---|
| `discover [--json]` | Every device adb sees (USB and Wi-Fi), with model, Android, SoC/GPU, displays, battery and free space. Also lists wireless-debugging devices on the LAN |
| `connect <ip:port>` / `pair <ip:port> <code>` | Attach a wireless-debugging device |
| `status` | Foreground app, screen state, battery, storage |
| `displays [--json]` | Every screen: logical and physical id, size, focus, top app |
| `shot [file] [--display id]` | Screenshot (PNG at native resolution) |
| `ui [--all]` | Compact UI tree: text, description, tappable, centre |
| `tap <x> <y>` / `tap "<text>"` | Tap by coordinates or by visible text |
| `swipe`, `key`, `type`, `launch` | Input and app launch; all take `--display <id>` |
| `seq "<step>" ...` | Several inputs (tap, swipe, key, sleep) in one adb call |
| `wait-for text|gone|app|awake|rendering ...` | Poll until a condition holds (`--timeout`), instead of sleeping |
| `apps [filter]` | Third-party packages with versions |
| `install <apk> [--sha256 hex]` | Hash-checked install |
| `push <local> <remote>` / `pull <remote> [local]` | Files or whole folders. Folders copy only missing or changed files (`--checksum` compares hashes), verify sha256, resume if interrupted, and never delete. `--dry-run` shows the plan. App-private folders get `sync` and `chmod 660` |
| `backup <remote folder> [--to dir]` | Dated, hash-verified snapshot of a device folder (an emulator's saves, for example) with a `SHA256SUMS` file |
| `record [file.mp4] [s] [--display id]` | Screen video, up to 180 s |
| `thermals` | Maximum CPU/GPU/battery temperature and battery draw |
| `fps <pkg> [s] [--wait] [--json]` | Real presented fps, 1%/0.1% lows, worst frame, hitches |
| `bench <pkg> [min] [--interval s] [--csv f] [--json]` | fps + temperatures + battery over time; flags thermal throttling |
| `doctor [check ...]` | Health checks you choose: storage, memory, thermals, battery, phantom, wireless, `app:<pkg>`, `perms:<dir>` |
| `logcat [pkg] [lines] [--errors] [--crash]` | An app's recent log, or its entries in the crash buffer |

With several devices, use `--serial <id>` (or `-s <id>`) or `ANDROID_SERIAL`. Use `--` to pass text
that starts with dashes: `handroid type -- --literal`.

Every command exits with status 0 on success and 1 on failure (no device, several devices without
`--serial`, hash mismatch, failed install, ...), with the reason on stderr, so agents and scripts can
rely on the exit code.

## Notes on the fps measurement

SurfaceFlinger keeps only the last 127 frame timestamps, which is about 1 s at 120 Hz. The CLI samples
every 0.4 s *on the device*, in a single adb call, so consecutive windows overlap and no frame is
counted twice. When a window does not overlap (adb was too slow), the gap is excluded and reported as
a break rather than counted as a hitch. The 1% and 0.1% lows are the fps at the 99th and 99.9th
percentile frame time.

The number is frames **presented**: a compositor that repeats frames, such as gamescope or frame
generation, can read higher than the game's own render rate.

The layer to measure is chosen automatically: the focused activity's game surface (`SurfaceView`)
first, then its window. Matching is a case-insensitive substring of the layer name, so
`fps droiddeck` works.

## Testing

```
npm test          # unit + integration tests (node:test), no device needed
npm run lint      # node --check on every file, and no runtime dependencies
```

The integration tests run the real CLI against a fake adb (`test/fake-adb.mjs`) that answers from
captured fixtures, so CI needs no device. To run the read-only smoke test against a real device
(it only runs `discover`, `status`, `displays`, `apps`, `thermals`, `ui`, `shot` and `fps`):

```
HANDROID_LIVE=1 npm test
HANDROID_LIVE=1 HANDROID_LIVE_FPS=<package-part> ANDROID_SERIAL=<id> npm test
```

## Contributing

Device profiles, bug reports and fixes are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to
run the tests, add a device profile and the safety rules agents must follow, and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

MIT, see [LICENSE](LICENSE).

# handroid-use

[![CI](https://github.com/marinsalinas/handroid-use/actions/workflows/ci.yml/badge.svg)](https://github.com/marinsalinas/handroid-use/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

**Computer use for Android handhelds: let AI agents see, drive and benchmark your Thor, Retroid or Odin.**

*hand + android.* handroid-use is a small, dependency-free CLI (`handroid`), a Claude Code skill and
an MCP server. Together they let an AI agent (or you) do the following over adb:
- discover an Android device and check its health;
- see its screens and act on them;
- copy files and folders safely;
- measure real game performance.

It **complements** generic Android agent tools such as [mobile-mcp](https://github.com/mobile-next/mobile-mcp);
it does not replace them. It works on any Android device adb can reach (phones, tablets, TVs), but
its focus is **gaming handhelds** (AYN Thor, Retroid, Odin, Ayaneo...), where generic tools fall short:

- **Real performance numbers.**
  - Presented fps, 1% / 0.1% lows, worst frame and hitches, straight from SurfaceFlinger.
  - CPU/GPU/battery temperatures and battery draw.
  - Long benchmark runs that flag thermal throttling.
- **GPU-drawn game screens.** Games, emulators and Steam Big Picture have no UI tree, so the agent
  falls back to screenshots and coordinates.
- **Dual-screen devices.** Lists every screen with its focus and top app, captures either screen and
  sends input to either one.
- **Health checks.** You choose what to check: storage, memory, temperatures, battery, crash-looping
  apps, Android's child-process limit, file permissions.
- **Hash-verified copies.**
  - Files and whole folders are copied incrementally and can be resumed. Nothing is ever deleted.
  - Every copied file is checked by sha256.
  - Installs are refused when the APK's hash does not match.
- **Safety rules for agents.** Don't kill key mappers or input services. Leave system settings and
  logins to the human. Don't drive the screen while the user is playing.

The code has no device-specific logic. What matters on each device lives in profiles under
[`skills/handroid-use/references/`](skills/handroid-use/references/). The
[AYN Thor](skills/handroid-use/references/ayn-thor.md) is the first; more are welcome
(see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Contents

- [Requirements](#requirements) · [Install](#install) · [Quick start](#quick-start)
- [Command reference](#command-reference)
  - [Devices and connection](#devices-and-connection): `discover`, `connect`, `pair`, `status`
  - [Screens](#screens): `displays`, `shot`, `ui`, `record`
  - [Input](#input): `tap`, `swipe`, `key`, `type`, `seq`, `launch`, `wait-for`
  - [Apps and files](#apps-and-files): `apps`, `install`, `push`, `pull`, `backup`
  - [Performance](#performance): `thermals`, `fps`, `bench`
  - [Diagnostics](#diagnostics): `doctor`, `logcat`
  - [MCP server](#mcp-server): `mcp`
- [Global options and exit codes](#global-options-and-exit-codes)
- [How the fps measurement works](#how-the-fps-measurement-works)
- [Testing](#testing) · [Contributing](#contributing) · [License](#license)

## Requirements

- Node.js 18 or newer. No npm dependencies.
- adb (Android platform-tools). It is found automatically:
  - `ADB`. Git Bash paths such as `/c/...` work on Windows.
  - `ANDROID_HOME` / `ANDROID_SDK_ROOT`, then `PATH`.
  - The Android SDK default location, winget (Windows) or Homebrew (macOS).
- On the device: USB debugging or wireless debugging.
- Windows, Linux or macOS.

## Install

**CLI**

```
npx -y github:marinsalinas/handroid-use discover
```

Or clone the repo and run `node bin/handroid.mjs <command>`. To get `handroid` on your PATH, run
`npm link` in the clone.

**Claude Code skill.** Copy or symlink `skills/handroid-use` into your skills folder:

```
# macOS / Linux
git clone https://github.com/marinsalinas/handroid-use ~/src/handroid-use
ln -s ~/src/handroid-use/skills/handroid-use ~/.claude/skills/handroid-use

# Windows (PowerShell)
git clone https://github.com/marinsalinas/handroid-use $HOME\src\handroid-use
New-Item -ItemType Junction -Path $HOME\.claude\skills\handroid-use -Target $HOME\src\handroid-use\skills\handroid-use
```

**MCP server** (for any MCP client). See [MCP server](#mcp-server).

**Recommended companion.** [mobile-mcp](https://github.com/mobile-next/mobile-mcp), a
general-purpose mobile automation MCP server:

```
claude mcp add mobile-mcp --scope user -- npx -y @mobilenext/mobile-mcp@latest
```

## Quick start

```
handroid discover                       # what is connected, what is on the LAN
handroid status                         # what is in front, screen on/off, battery, storage
handroid doctor                         # general health check
handroid ui                             # what is on screen (text tree), or:
handroid shot screen.png                # screenshot for GPU-drawn screens
handroid tap "Settings"                 # act
handroid wait-for text "Battery"        # wait for the result instead of sleeping
handroid fps <package> 30 --wait        # measure a game once it starts rendering
```

Every example below is real output from an AYN Thor, with the serial, IPs and display ids anonymized.

## Command reference

`handroid help` prints a one-line summary of every command.

### Devices and connection

#### `discover [--json]`

Every device adb sees, over USB or Wi-Fi, with its model, Android version, ABI, SoC/GPU, screens,
battery and free space. It also lists wireless-debugging devices on the LAN that are not connected
yet, found over mDNS. `--json` gives the same data for scripts.

```
$ handroid discover

ABC123XYZ  [device, usb]
  AYN AYN Thor  -  Android 13 (SDK 33), arm64-v8a
  SoC: QTI QCS8550   GPU: Adreno (TM) 740
  screen: 1080x1920  (2 displays: use shot --display <id>)   battery: 100%   free: 49G

On the network (wireless debugging), not connected:
  192.168.1.60:5555      -> handroid connect 192.168.1.60:5555
```

When a device is unauthorized or offline, `discover` prints the fix: accept the USB debugging
prompt, reconnect, and so on.

#### `connect <ip:port>` · `pair <ip:port> <code>`

Attach a wireless-debugging device. `pair` uses the 6-digit code shown on the device (Android 11+).
The exit code says whether it worked.

#### `status`

```
$ handroid status
device:   ABC123XYZ AYN Thor (Android 13)
screen:   Awake
focus:    com.droiddeck.launcher/com.droiddeck.launcher.SessionActivity
battery:  100% Full
storage:  58G free of 465G (88% used)
```

### Screens

#### `displays [--json]`

Every screen, with its focus and the app on top. Android gives each screen two ids:
- a **logical** id, used for input;
- a **physical** id, used for screenshots.

Every `--display` option accepts either one.

```
$ handroid displays
id  physical             name             size       focus  top activity
0   4619827259835644675  Built-in Screen  1920x1080         com.android.settings/.Settings
4   4619827259835644676  Screen-2         1240x1080  *      rip.moth.cocoonshell/.ExternalDisplayActivity
```

On devices that report no display info (old Android, emulators), it falls back to SurfaceFlinger's
display list.

#### `shot [file.png] [--display <id>]`

Screenshot as a PNG at native resolution; prints the saved path. Without a file it saves to the temp
folder. Without `--display` it captures the primary screen.

```
$ handroid shot bottom.png --display 4
/home/me/bottom.png
```

#### `ui [--all]`

A compact UI tree: text, content description, `[tap]` if clickable, and the centre `x,y` to tap.
`--all` also lists nodes without text, with their resource ids.

On dual-screen devices, the first line says which screen the tree came from. uiautomator dumps one
window, and it is not always the screen that has focus.

```
$ handroid ui
# display 0 "Built-in Screen" 1920x1080 (focused): tap "text" targets this screen; for coordinates add --display 0
Settings                                                              207,351
Search settings                                                       329,521
Network & internet                                                    355,698
```

An empty tree means the screen is drawn by the GPU (games, emulators, Steam Big Picture, many
launchers); use `shot` instead. On a sleeping screen, `ui` says
`the screen is asleep: run handroid key WAKEUP first`.

#### `record [file.mp4] [seconds=10] [--display <id>]`

Records a screen video, up to 180 s, through `screenrecord`. The file is pulled to the computer and
removed from the device. The command prints the local path.

```
$ handroid record bug.mp4 5 --display 4
/home/me/bug.mp4
```

### Input

`tap`, `swipe`, `key`, `type`, `seq` and `launch` all take `--display <id>`. Without it:
- taps and swipes go to display 0;
- keys go to the focused screen;
- `tap "text"` goes to the screen its UI tree came from.

#### `tap <x> <y>` · `tap "<text>"`

Tap by coordinates in device pixels, read them from `shot` or `ui`. Or tap by text: an exact match on
text or content description wins, then a case-insensitive substring. Clickable, on-screen nodes are
preferred.

```
$ handroid tap "Battery"
tap "Battery" at 240,604 on display 0
$ handroid tap 1614 837 --display 0
tap 1614,837 on display 0
```

#### `swipe <x1> <y1> <x2> <y2> [ms=300]`

```
$ handroid swipe 620 950 620 450 400 --display 4
ok
```

#### `key <name|code> [--source gamepad|dpad|joystick|keyboard]`

`BACK`, `HOME`, `WAKEUP`, `SLEEP`, `ENTER`, `DPAD_UP`, any `KEYCODE_*` name, or a number.

Emulators and games usually **ignore keyboard events** and only read controller buttons. Use
`--source gamepad`. With it, short button names map to `KEYCODE_BUTTON_*`: `A B X Y L1 R1 L2 R2 START
SELECT MODE THUMBL THUMBR`.

```
$ handroid key A --source gamepad
key KEYCODE_BUTTON_A (gamepad)
```

#### `type "<text>"`

Types ASCII text into the focused field. Shell metacharacters are passed literally. Never use it for
passwords. To type text that starts with dashes, use `handroid type -- --text`.

#### `seq "<step>" ...`

Several inputs in **one** adb call. The steps are:
- `tap x y`
- `swipe x1 y1 x2 y2 [ms]`
- `key NAME`
- `sleep s` (up to 30)

`--source gamepad` applies to the `key` steps, for example `seq "key A" "sleep 1" "key START" --source gamepad`.

Use it for controls that hide again before a second command could reach them, such as
picture-in-picture or video player overlays, or for a fixed key sequence. Every step is validated
before anything runs.

```
$ handroid seq "tap 1610 780" "sleep 0.4" "tap 1614 837" --display 0
ok (3 steps on display 0)
```

#### `launch <package> [--display <id>]`

Starts the app's launcher activity. With `--display`, it starts the app on that screen.

```
$ handroid launch com.android.settings --display 4
launched com.android.settings/.Settings on display 4
```

#### `wait-for <condition> [--timeout s=30] [--display <id>]`

Polls until a condition holds, so agents don't guess with sleeps. It exits 1 on timeout.

| Condition | True when |
|---|---|
| `text "<t>"` | the text appears in the UI tree |
| `gone "<t>"` | the text is no longer in the UI tree |
| `app <package>` | the app is in front (on that screen with `--display`) |
| `awake` | the screen is on |
| `rendering <package> [--min-fps 15] [--stable 3]` | the app's surface presents at least `--min-fps` new frames per second, sustained for `--stable` seconds |

`rendering` counts real new frames over the whole window. A menu that redraws once, or a burst followed
by silence, does not pass. A loading screen that animates steadily does pass, so after it use `shot`
to confirm gameplay. `fps --wait` uses the same check.

```
$ handroid wait-for app com.android.settings --display 4
ok after 0.1 s
$ handroid wait-for text "Network & internet" --timeout 10
ok after 2.2 s
```

### Apps and files

#### `apps [filter]`

Third-party packages with their version names, sorted, optionally filtered by substring.

```
$ handroid apps gamenative
app.gamenative 1.4.0
```

#### `install <apk> [--sha256 <hex>]`

Installs or updates (`adb install -r`). With `--sha256`, it refuses to install on a mismatch. The
`sha256:` prefix and any letter case are accepted.

```
$ handroid install gamenative-v1.4.0.apk --sha256 51e7edc667a352c664f7da274d15b973cd054ec04e0b828e2039fb40c334224d
sha256 51e7edc667a352c664f7da274d15b973cd054ec04e0b828e2039fb40c334224d
Performing Streamed Install
Success
```

#### `push <local file|folder> <remote> [--checksum] [--dry-run]`

**A file** is copied, then its sha256 is verified on the device.

**A folder** is copied incrementally:
- Only files that are missing on the device, or whose size differs, are copied. `--checksum` also
  compares hashes, which catches same-size changes.
- Every copied file is sha256-verified.
- Nothing on the device is ever deleted. Files that exist only there are reported and left alone.
- An interrupted copy resumes when you run the same command again.
- `--dry-run` lists what would be copied.

Under `Android/data/<pkg>/`, copied files also get `chmod 660` and a `sync`, so the owning app can
read them.

```
$ handroid push ./library /sdcard/Download/library
4 files: 4 to copy (48 MB), 0 already there
  [1/4] a/x.sav
  [2/4] big.bin
  [3/4] sub dir/más/dós it's.txt
  [4/4] sub dir/uno.txt
verified sha256 of 4 copied file(s) -> /sdcard/Download/library

$ handroid push ./library /sdcard/Download/library
4 files: 0 to copy (0 B), 4 already there
verified sha256 of 0 copied file(s) -> /sdcard/Download/library
```

Files of any size work; hashing is streamed. In Git Bash, set `MSYS_NO_PATHCONV=1` or write
`//sdcard/...`. Otherwise Git Bash rewrites `/sdcard` into a Windows path, and the command refuses it.

#### `pull <remote file|folder> [local] [--checksum] [--dry-run]`

The same rules in the other direction. A folder lands in `local`, or by default in a folder named
after the remote one.

#### `backup <remote folder> [--to <local folder>]`

A dated, verified snapshot of a device folder, for example an emulator's saves before an update. It
never changes the device. The snapshot also contains a `SHA256SUMS` file that `sha256sum -c` can
check later.

```
$ handroid backup "/sdcard/Download/test/sub dir" --to backups
2 files: 2 to copy (8 B), 0 already there
  [1/2] más/dós it's.txt
  [2/2] uno.txt
verified sha256 of 2 copied file(s) -> /home/me/backups/sub_dir-20261114-185357
backup: /home/me/backups/sub_dir-20261114-185357 (2 files, SHA256SUMS written; check later with: sha256sum -c SHA256SUMS)
```

### Performance

#### `thermals`

```
$ handroid thermals
temps: CPU 53.5 C | GPU 49.1 C | battery 28.0 C | battery 100% Full, 0 mA
```

#### `fps <package-or-part> [seconds=30] [--wait] [--json]`

Measures an app's real on-screen frame rate from SurfaceFlinger: average fps, 1% and 0.1% lows, worst
frame, frames over 33 ms and hitches over 50 ms, plus temperatures. `--wait` waits until the app
renders more than 15 fps, then waits 8 s and measures; use it when a game is about to start.
`--json` gives machine-readable output.

```
$ handroid fps droiddeck 30 --wait
waiting for the app to render... detected, measuring in 8 s
layer: SurfaceView[com.droiddeck.launcher/com.droiddeck.launcher.SessionActivity](BLAST)#3286
avg fps:   <fps>   (<frames> frames, <s> s measured)
1% low:    <fps> fps   0.1% low: <fps> fps
worst:     <ms> ms   frames >33 ms: <n>   hitches >50 ms: <n>
temps: CPU <c> C | GPU <c> C | battery <c> C | battery <pct>% <state>, <mA> mA
```
(Output format.)

A menu that is not animating reports `no new frames (paused, menu or static screen?)`. Hollow Knight
under DroidDeck on an AYN Thor measured about 115 fps against a 120 Hz cap.

#### `bench <package-or-part> [minutes=5] [--interval s=10] [--csv file] [--json]`

Records fps, 1% low, worst frame, hitches, CPU/GPU/battery temperature, battery mA and battery %
every interval. Use it for long sessions, thermal throttling, battery life, or a fair A/B comparison
of two apps in the same scene.

The summary compares the first and last thirds of the run. A drop of 10% or more is flagged as
likely thermal throttling.

```
$ handroid bench droiddeck 20 --interval 30 --csv run.csv
layer: SurfaceView[...]
   t(s)    fps  1%low  worst(ms)  hitches   CPU C   GPU C  batt C    mA  bat%
     30  <fps>  <fps>       <ms>      <n>   <c>     <c>     <c>     <mA>  <pct>
    ... one row per interval ...
overall: <fps> fps avg, 1% low <fps> | max CPU <c> C, GPU <c> C, battery <c> C
first third <fps> fps -> last third <fps> fps
battery used: <n>%
csv: /home/me/run.csv
```

### Diagnostics

#### `doctor [check[:arg]] ... [--json] [--strict] [--list]`

Runs only the checks you name, all in one adb call. With no arguments it runs the general ones:
`storage memory thermals battery phantom wireless`. `--list` explains each check.

| Check | Looks at |
|---|---|
| `storage[:warn%]` | /data usage (warn at 90% by default, fail at 97%) |
| `memory[:min%]` | available RAM (warn below 10%) and swap |
| `thermals[:cpu=85,gpu=80,battery=45]` | hottest sensors against your limits (°C) |
| `battery` | charge, health (overheat, dead, ...), temperature |
| `phantom` | Android 12–13's "phantom process" limit, which kills apps that start many child processes (Linux, Wine and Proton layers, terminals) |
| `wireless` | wireless debugging on/off and port |
| `app:<package>` | installed or not, version, uptime, and starts, deaths, crashes, ANRs and kills from the event log. It warns on crash loops (several restarts and a short uptime) and shows the last crash |
| `perms:<device dir>` | files the owning app may not be able to read |

The exit code is 1 if any check fails; with `--strict`, warnings count too. Nothing in `doctor` knows
about specific devices. Device profiles say which packages are worth checking: a key mapper, a
launcher, an emulator.

```
$ handroid doctor
[ok]    storage   88% used, 58.1 GB free
[ok]    memory    9.8 of 14.9 GB available (66%) | swap 34% used
[ok]    thermals  CPU 40.8 C | GPU 37.6 C | BATTERY 29.0 C
[ok]    battery   100% full, health good, 30.0 C
[ok]    phantom   phantom process monitoring is disabled
[ok]    wireless  wireless debugging on, TLS port 45549

$ handroid doctor app:xyz.blacksheep.mjolnir app:com.droiddeck.launcher storage:85
[ok]    app:xyz.blacksheep.mjolnir  version 0.2.7a, running for 14.0 h
[ok]    app:com.droiddeck.launcher  version 0.7.1, not running
[info]  app:com.droiddeck.launcher  event log (11-14 12:23:24 .. 11-14 12:23:24): 0 starts, 0 deaths, 0 crashes, 0 ANRs, 1 kills
[info]  app:com.droiddeck.launcher  last kill: 11-14 12:23:24 stop com.droiddeck.launcher due to from pid 14457
[warn]  storage:85                  88% used, 58.1 GB free
                                    -> large copies (games, ROM sets) may not fit
```

Fixes that change system settings, such as raising the phantom-process limit, are shown as hints
for the user. handroid never applies them.

#### `logcat [package] [lines=200] [--errors] [--crash]`

While the app runs, this prints its own log, filtered by its pid. When it is not running, or with
`--crash`, it prints its entries from the crash buffer. Without a package, it prints the whole
crash buffer. `--errors` keeps errors only.

```
$ handroid logcat dev.example.app
# crash buffer for dev.example.app (not running)
11-13 21:20:56.449 16849 16849 E AndroidRuntime: FATAL EXCEPTION: main
11-13 21:20:56.449 16849 16849 E AndroidRuntime: Process: dev.example.app, PID: 16849
11-13 21:20:56.449 16849 16849 E AndroidRuntime: java.lang.NoSuchMethodError: ...
```

### MCP server

`handroid mcp` serves the commands above as **23 MCP tools** over stdio, with no dependencies:

`discover` `status` `displays` `screenshot` `ui` `tap` `swipe` `key` `type` `launch` `seq` `wait_for`
`apps` `thermals` `fps` `bench` `doctor` `logcat` `install` `push` `pull` `backup` `record`

```
claude mcp add handroid --scope user -- npx -y github:marinsalinas/handroid-use mcp
# or, after npm link:
claude mcp add handroid --scope user -- handroid mcp
```

- `screenshot` returns the image itself, so the model sees it without a file round trip.
- Every tool accepts `serial`, and tools that act on a screen accept `display`.
- Each tool runs the CLI with an argument array, never a shell string. Values always come after
  `--`, so a value can never turn into a flag. The CLI's validation and exit codes apply unchanged;
  a failed command comes back as a tool error.
- You can allow read-only tools (`status`, `screenshot`, `doctor`, `fps`) without prompting and keep
  prompts for `tap`, `install` and `push`.

When should you use it? In Claude Code, the skill plus the CLI already cover everything and cost no
context until they are needed. MCP is for clients without a shell (Claude Desktop, Cursor, other
agents) and for per-tool permissions.

## Global options and exit codes

- `--serial <id>`, `-s <id>` or `--serial=<id>` picks a device when several are connected; so does
  `ANDROID_SERIAL`. With several devices and no serial, commands fail and list the serials.
- `--` ends option parsing: `handroid type -- --literal`.
- `-h` / `--help` / `handroid help` prints the command list and which adb is used.
- **Exit codes**: 0 on success, 1 on failure, with the reason on stderr. Failures include no device,
  an ambiguous device, a hash mismatch, a failed install, a timeout, a failed doctor check and bad
  arguments. Arguments are validated before anything touches the device.
- `HANDROID_DEBUG=1` prints stack traces for unexpected errors.

## How the fps measurement works

SurfaceFlinger keeps only the last 127 frame timestamps, about 1 s at 120 Hz. handroid samples
`dumpsys SurfaceFlinger --latency` every 0.4 s **on the device**, in a single adb call timed by the
device clock, so consecutive windows overlap:

- Each frame is counted once.
- The first sample is only a baseline. Frames left in the buffer from before the measurement, which
  an idle menu can keep for minutes, are never counted.
- A window that does not overlap the previous one (adb was too slow) is reported as a break and
  excluded, never counted as a hitch.
- The 1% and 0.1% lows are the fps at the 99th and 99.9th percentile frame time.

The number counts frames **presented** to the screen. A compositor that repeats frames, such as
gamescope or frame generation, can read higher than the game's own render rate.

The layer to measure is picked automatically: the focused activity's game surface (`SurfaceView`)
first, then its window, and never a layer on another screen. The match is a case-insensitive
substring of the layer name, so `fps droiddeck` works.

## Testing

```
npm test          # unit + integration tests (node:test), no device needed
npm run lint      # node --check on every file, and no runtime dependencies
```

The integration tests run the real CLI (and the MCP server over stdio) against a fake adb,
`test/fake-adb.mjs`, which answers from captured fixtures. CI runs on Linux, Windows and macOS with
Node 18, 20 and 22, and needs no device.

There is also a read-only smoke test for a real device. It runs `discover`, `status`, `displays`,
`apps`, `doctor`, `logcat`, `thermals`, `ui`, `shot` and `fps`, and never anything that changes the
device:

```
HANDROID_LIVE=1 npm test
HANDROID_LIVE=1 HANDROID_LIVE_FPS=<package-part> ANDROID_SERIAL=<id> npm test
```

## Contributing

Device profiles, bug reports and fixes are welcome.
- [CONTRIBUTING.md](CONTRIBUTING.md) covers running the tests, adding a device profile and the
  safety rules agents must follow.
- [SECURITY.md](SECURITY.md) covers reporting vulnerabilities.

## License

MIT, see [LICENSE](LICENSE).

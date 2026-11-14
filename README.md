# android-use

**Computer use, but for Android.** This is a small cross-platform CLI and a Claude Code skill. Together
they let an AI agent see and drive an Android device over adb, install and copy files safely, and
measure real game performance (fps, 1% lows, hitches, temperatures).

It was built while setting up an AYN Thor gaming handheld. It works with any Android device that adb
can reach: phones, handhelds, Android TVs.

```
$ android-use discover

ABC123XYZ  [device, usb]
  AYN AYN Thor  -  Android 13 (SDK 33), arm64-v8a
  SoC: QTI QCS8550   GPU: Adreno (TM) 740
  screen: 1080x1920  (2 displays: use shot --display <id>)   battery: 100%   free: 49G

On the network (wireless debugging), not connected:
  192.168.1.50:5555         -> android-use connect 192.168.1.50:5555
```

```
$ android-use fps droiddeck 30 --wait
avg fps:   <n>   (<frames> frames, 30.0 s measured)
1% low:    <n> fps   0.1% low: <n> fps
worst:     <ms> ms   frames >33 ms: <n>   hitches >50 ms: <n>
temps: CPU <c> C | GPU <c> C | battery <c> C | battery <pct>% <state>, <mA> mA
```
(Output format. Hollow Knight under DroidDeck on an AYN Thor measured about 115 fps average against a 120 Hz cap.)

## Why

General-purpose Android MCP servers such as [mobile-mcp](https://github.com/mobile-next/mobile-mcp)
already handle taps, swipes and screenshots well, and you can use them alongside this project. What
they don't carry is the hard-won practical knowledge:

- **GPU-drawn screens.** Games, emulators and Steam Big Picture expose no UI tree, so the agent has to
  work from screenshots.
- **Real performance numbers.** These come from SurfaceFlinger, sampled so that the measurement itself
  does not invent hitches.
- **Safe file handling.** Every copy is checked by hash on the device, and app-private folders get the
  permissions their app needs.
- **Rules for agents.** Don't force-stop keymapping services on handhelds. Leave system settings and
  logins to the human. Don't drive the screen while the user is playing.
- **Device profiles.** For example `references/ayn-thor.md`, which covers two displays, Adreno driver
  quirks and Android 13's phantom-process limit.

## Requirements

- Node.js 18+
- adb (Android platform-tools). It is found automatically from `ADB`, `ANDROID_HOME`/`ANDROID_SDK_ROOT`, `PATH`, the Android SDK default location, winget (Windows) or Homebrew (macOS).
- On the device: USB debugging or wireless debugging.

## Install

### CLI

```
npx -y github:marinsalinas/android-use discover
```

Or clone it and run `node bin/android-use.mjs <command>` (or `npm link` to get `android-use` on your PATH).

### Claude Code skill

Copy or symlink `skills/android-use` into your skills folder:

```
# macOS / Linux
git clone https://github.com/marinsalinas/android-use ~/src/android-use
ln -s ~/src/android-use/skills/android-use ~/.claude/skills/android-use

# Windows (PowerShell)
git clone https://github.com/marinsalinas/android-use $HOME\src\android-use
New-Item -ItemType Junction -Path $HOME\.claude\skills\android-use -Target $HOME\src\android-use\skills\android-use
```

### Optional: mobile-mcp next to it

```
claude mcp add mobile-mcp --scope user -- npx -y @mobilenext/mobile-mcp@latest
```

## Commands

| Command | What it does |
|---|---|
| `discover [--json]` | Every device adb sees (USB and Wi-Fi), with model, Android, SoC/GPU, displays, battery and free space. Also lists wireless-debugging devices on the LAN |
| `connect <ip:port>` / `pair <ip:port> <code>` | Attach a wireless-debugging device |
| `status` | Foreground app, screen state, battery, storage |
| `displays` | Display ids for multi-screen devices |
| `shot [file] [--display id]` | Screenshot (PNG at native resolution) |
| `ui [--all]` | Compact UI tree: text, description, tappable, centre |
| `tap <x> <y>` / `tap "<text>"` | Tap by coordinates or by visible text |
| `swipe`, `key`, `type`, `launch` | Input and app launch |
| `apps [filter]` | Third-party packages with versions |
| `install <apk> [--sha256 hex]` | Hash-checked install |
| `push <local> <remote>` / `pull` | Hash-verified copy; app-private folders get `sync` and `chmod 660` |
| `thermals` | Maximum CPU/GPU/battery temperature and battery draw |
| `fps <pkg> [s] [--wait]` | Real presented fps, 1%/0.1% lows, worst frame, hitches |

With several devices, use `--serial <id>` or `ANDROID_SERIAL`.

## Notes on the fps measurement

SurfaceFlinger keeps only the last 127 frame timestamps, which is about 1 s at 120 Hz. The CLI samples
every 0.4 s *on the device*, in a single adb call, so consecutive windows overlap. When a window does
not overlap, the gap is excluded rather than counted as a hitch. The number is frames **presented**:
a compositor that repeats frames, such as gamescope or frame generation, can read higher than the
game's own render rate.

## Contributing device profiles

Add `skills/android-use/references/<device>.md` with what you measured and what broke: app versions,
scenes, numbers and temperatures. PRs welcome.

## License

MIT

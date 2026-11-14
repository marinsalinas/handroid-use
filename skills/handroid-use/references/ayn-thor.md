# AYN Thor profile

Learned on a Thor Max (Snapdragon 8 Gen 2 = QCS8550, Adreno 740, Android 13, two AMOLED screens).

## Hardware and identification
- `discover` shows `AYN Thor`, `QTI QCS8550`, `Adreno (TM) 740` and **2 displays**: the top 1080p
  screen and the bottom touch screen.
- `displays` on a Thor (Android 13), with the device in landscape:

  ```
  id  physical             name             size       focus  top activity
  0   46309464418585xxxxx  Built-in Screen  1920x1080         com.droiddeck.launcher/.SessionActivity
  4   46309464822881xxxxx  Screen-2         1240x1080  *      rip.moth.cocoonshell/.ExternalDisplayActivity
  ```

  The top screen is logical display 0 and the bottom one is **4** (not 1). `screencap` needs the
  long physical id, while `input` needs the logical one; handroid maps between them.
- `ui` can return the bottom screen's tree while the top screen has the game. Check the `# display`
  header before tapping coordinates from it.
- AYN's **anti-image-retention pixel refresh** sometimes covers both screens with noise for about 10 s,
  showing a "tap to exit" countdown. Wait it out; screenshots taken during it show only noise.
- The screen sleeps after 60 s of no input by default. `key WAKEUP` brings it back; there is no
  lock screen to clear.
- Thermal zones are Qualcomm-style:
  - `cpu-0-*`: efficiency cores.
  - `cpu-1-*`: performance and prime cores.
  - `gpuss-*`: GPU.

  Under sustained load, normal readings are about 55–70 °C on the CPU and 50–60 °C on the GPU.
- The display runs at 120 Hz, so the fps ceiling is about 120.

## Health check for a Thor
```
handroid doctor app:xyz.blacksheep.mjolnir app:rip.moth.cocoonshell phantom storage thermals:cpu=80
```
- Mjolnir (key mapper) should be running for hours. A short uptime with several starts means its key
  filter is crash-looping, which adds input lag to every emulator. Tell the user; a reboot fixes it.
- `phantom` on the Thor (Android 13): DroidDeck's "Fix it for me" disables the monitor, which doctor
  reports as ok.
- Storage near 90% is common: ROM sets and PC games are large.

- Back up an emulator's saves before updating it or moving profiles:
  `backup <its save folder> --to <somewhere on the PC>`. Emulators keep saves in different places,
  and some use a user folder separate from the ROM library (Azahar, for example). Confirm the path in
  the emulator's settings first.

## Things that break the device
- **Keymapping/input services** (for example Mjolnir, or AYN's own key-mapper). Never force-stop
  them. A crash loop in the key filter adds input lag to every emulator until the device reboots.
- **Dual-screen helpers** (for example DualScreenDex or Cocoon's external-display activity). Don't kill
  them either; they own the second screen.
- Users often play while you work. Check `status` first and don't automate the screen while a game is in front unless asked.

## Android 13 specifics
- Android 13 kills apps that spawn many child processes. This "phantom process" limit hits Steam or
  Wine layers like DroidDeck and GameNative.
  - Android 14+ has a Developer-options switch for it. On 13 the fix is a `device_config` change,
    which these apps can apply through wireless debugging.
  - That is a system setting: the user applies it, or explicitly asks you to.
- `Android/data/<pkg>` is readable over adb. After pushing there, `sync` and `chmod 660` (the
  `push` command does both) or the app may not see the file.

## Emulators and PC-game layers (what was observed)
- **GPU-drawn UIs**: `ui` returns nothing useful in Steam Big Picture, Eden and most emulators while
  in game. Use `shot` and read coordinates from the image.
  - The UI around them is accessible: DroidDeck's controller overlay on the bottom screen (Close,
    Swap screens, Gamepad/Grips/trackpads, L4–R5) and Cocoon's launcher both have full `ui` trees.
- **DroidDeck picture-in-picture**: pressing HOME on the top screen shrinks the Steam session into a
  PiP window. To restore it, tap the PiP window, then tap the expand icon in its centre within about
  a second.
- `fps` on Steam Big Picture's menus reports "no new frames": gamescope only presents when something
  changes. Measure in game.
- **Qualcomm's stock Adreno 740 driver** (v676) works with Turnip-based layers. DroidDeck and
  GameNative use Mesa Turnip, not the Qualcomm driver.
  - Native-port apps that load newer Qualcomm drivers (v8xx) can render incorrectly on the 740.
  - If a native port renders garbage, try the app's default driver before blaming the game.
- **DroidDeck** (Valve's ARM64 Steam client with Proton and FEX) measured Hollow Knight at about 115 fps
  average, against the 120 Hz cap.
  - Its fps reading comes from the `SessionActivity` SurfaceView: `fps droiddeck --wait`.
  - First launch on Android 13 shows a "Fix it for me" page for the phantom-process limit.
- **GameNative** (its own Steam client with Wine/Proton): measure with `fps gamenative --wait`.

Add numbers here as you measure them, with the app version, game, scene, duration and temperatures.

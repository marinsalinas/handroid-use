# AYN Thor profile

Learned on a Thor Max (Snapdragon 8 Gen 2 = QCS8550, Adreno 740, Android 13, two AMOLED screens).

## Hardware and identification
- `discover` shows `AYN Thor`, `QTI QCS8550`, `Adreno (TM) 740` and **2 displays**: the top 1080p
  screen and the bottom touch screen.
- Use `displays` to get the ids, then `shot --display <id>` for the other screen. A plain `shot` captures the default display.
- Thermal zones are Qualcomm-style:
  - `cpu-0-*`: efficiency cores.
  - `cpu-1-*`: performance and prime cores.
  - `gpuss-*`: GPU.

  Under sustained load, normal readings are about 55–70 °C on the CPU and 50–60 °C on the GPU.
- The display runs at 120 Hz, so the fps ceiling is about 120.

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
- **GPU-drawn UIs**: `ui` returns nothing useful in DroidDeck, Steam Big Picture, Eden and most
  emulators while in game. Use `shot` and read coordinates from the image.
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

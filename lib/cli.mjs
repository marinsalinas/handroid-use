import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Adb, ADB_NOT_FOUND, findAdb } from "./adb.mjs";
import { parseArgs } from "./args.mjs";
import { DEVICE_INFO_CMDS, deviceInfo, parseDevices, parseDf, parseMdns, unconnectedServices } from "./devices.mjs";
import { CliError, fail } from "./errors.mjs";
import { findLayer, formatStats, frameStats, parseFocus, quickRate, splitSamples } from "./fps.mjs";
import { inputTextArg, isAsciiPrintable, isInt, isPackageName, parseSections, quote as q, sectionScript } from "./shell.mjs";
import { THERMAL_ZONES_CMD, formatThermals, parseThermalZones } from "./thermals.mjs";
import { findNode, formatNode, parseUiXml } from "./ui.mjs";

const out = (...a) => console.log(...a);
const BAT = "/sys/class/power_supply/battery";

// ---------- shared helpers ----------
export function sha256File(f) {
  return createHash("sha256").update(fs.readFileSync(f)).digest("hex");
}
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function requireFile(f, what) {
  let st;
  try { st = fs.statSync(f); } catch { fail(`${what}: ${f} does not exist`); }
  if (!st.isFile()) fail(`${what}: ${f} is not a file`);
}

/**
 * Git Bash (MSYS) rewrites arguments like /sdcard/x into C:/Program Files/Git/sdcard/x before
 * Node ever sees them. A device path must be POSIX, so refuse anything that looks like a Windows path.
 */
export function checkDevicePath(p) {
  if (/^[A-Za-z]:[\\/]/.test(p) || p.includes("\\"))
    fail(`"${p}" is not a device path. If you are in Git Bash it rewrote /sdcard/... into a Windows path: ` +
         "set MSYS_NO_PATHCONV=1 or write //sdcard/...");
}

function uiNodes(adb) {
  return parseUiXml(adb.run(["exec-out", "uiautomator", "dump", "/dev/tty"]).stdout);
}

function thermalsLine(adb) {
  const s = parseSections(adb.sh(sectionScript({
    zones: THERMAL_ZONES_CMD,
    current: `cat ${BAT}/current_now 2>/dev/null`,
    capacity: `cat ${BAT}/capacity 2>/dev/null`,
    status: `cat ${BAT}/status 2>/dev/null`,
  })));
  return formatThermals(parseThermalZones(s.zones), s);
}

function locateLayer(adb, pat) {
  const s = parseSections(adb.sh(sectionScript({
    layers: "dumpsys SurfaceFlinger --list 2>/dev/null",
    focus: "dumpsys window 2>/dev/null | grep -m1 mCurrentFocus",
  })));
  return findLayer(s.layers, pat, parseFocus(s.focus));
}

// ---------- commands ----------
// run(args, flags, adb) prints its result; it may return an exit code, and throws CliError on failure.
export const commands = {
  discover: {
    help: "discover [--json]  -> every device adb sees (USB + Wi-Fi) with model, Android, SoC/GPU, screens, battery; plus wireless-debugging devices on the LAN not connected yet",
    run(args, flags, adb) {
      const found = parseDevices(adb.raw(["devices", "-l"]).stdout);
      for (const d of found) {
        if (d.state !== "device") continue;
        const r = adb.raw(["-s", d.serial, "shell", sectionScript(DEVICE_INFO_CMDS)]);
        Object.assign(d, deviceInfo(parseSections(String(r.stdout))));
      }
      // Wireless debugging (Android 11+) advertises over mDNS
      const lan = unconnectedServices(parseMdns(adb.raw(["mdns", "services"]).stdout), found);
      if (flags.json) return out(JSON.stringify({ adb: adb.path, devices: found, lan }, null, 2));
      if (!found.length) out("No devices connected over adb.");
      for (const d of found) {
        out(`\n${d.serial}  [${d.state}, ${d.transport}]`);
        if (d.hint) { out(`  -> ${d.hint}`); continue; }
        if (d.state !== "device") continue;
        out(`  ${d.manufacturer} ${d.model}  -  Android ${d.android} (SDK ${d.sdk}), ${d.abi}`);
        out(`  SoC: ${d.soc || "?"}   GPU: ${d.gpu || "?"}`);
        out(`  screen: ${d.screen || "?"}${d.displays > 1 ? `  (${d.displays} displays: use shot --display <id>)` : ""}   battery: ${d.battery || "?"}%   free: ${d.storageFree || "?"}`);
      }
      if (lan.length) {
        out("\nOn the network (wireless debugging), not connected:");
        for (const l of lan) out(`  ${l.address.padEnd(22)} ${l.kind === "pairing" ? "pairing code shown on the device -> handroid pair " + l.address + " <code>" : "-> handroid connect " + l.address}`);
      }
      if (found.filter(d => d.state === "device").length > 1) out("\nSeveral devices: pass --serial <id> (or set ANDROID_SERIAL) to the other commands.");
    },
  },

  connect: {
    help: "connect <ip:port>  -> attach a wireless-debugging device",
    run(a, flags, adb) {
      if (!a[0]) fail("usage: connect <ip:port>");
      const r = adb.raw(["connect", a[0]]);
      const text = (r.stdout + r.stderr).trim();
      out(text);
      return /\b(already )?connected to\b/i.test(text) && !/fail|unable|cannot/i.test(text) ? 0 : 1;
    },
  },

  pair: {
    help: "pair <ip:port> <code>  -> pair with Android 11+ wireless debugging (code shown on the device)",
    run(a, flags, adb) {
      if (a.length < 2) fail("usage: pair <ip:port> <code>");
      const r = adb.raw(["pair", a[0], a[1]]);
      const text = (r.stdout + r.stderr).trim();
      out(text);
      return /successfully paired/i.test(text) ? 0 : 1;
    },
  },

  status: {
    help: "connection, foreground app, screen state, battery, free storage",
    run(a, flags, adb) {
      const s = parseSections(adb.sh(sectionScript({
        model: "getprop ro.product.model",
        release: "getprop ro.build.version.release",
        focus: "dumpsys window 2>/dev/null | grep -m1 mCurrentFocus",
        wake: "dumpsys power 2>/dev/null | grep -m1 mWakefulness",
        capacity: `cat ${BAT}/capacity 2>/dev/null`,
        bstatus: `cat ${BAT}/status 2>/dev/null`,
        df: "df -h /storage/emulated 2>/dev/null | tail -1",
      })));
      const df = parseDf(s.df);
      out(`device:   ${adb.pick()} ${s.model} (Android ${s.release})`);
      out(`screen:   ${(s.wake.split("=")[1] || "?").trim()}`);
      out(`focus:    ${parseFocus(s.focus) || "none"}`);
      if (s.capacity) out(`battery:  ${s.capacity}%${s.bstatus ? " " + s.bstatus : ""}`);
      if (df) out(`storage:  ${df.free} free of ${df.size} (${df.usePct} used)`);
    },
  },

  displays: {
    help: "list display ids (for multi-screen devices); use with: shot --display <id>",
    run(a, flags, adb) { out(adb.sh("dumpsys SurfaceFlinger --display-id").trim()); },
  },

  shot: {
    help: "shot [file.png] [--display <id>]  -> screenshot; prints the saved path",
    run(args, flags, adb) {
      const file = path.resolve(args[0] || path.join(os.tmpdir(), `android-shot-${Date.now()}.png`));
      const a = ["exec-out", "screencap", "-p"];
      if (flags.display !== undefined) {
        if (!/^\d+$/.test(String(flags.display))) fail("--display needs a numeric display id (see: handroid displays)");
        a.splice(2, 0, "-d", String(flags.display));
      }
      const r = adb.run(a, { binary: true });
      const png = r.stdout;
      if (!png || png.length < 100 || png.readUInt32BE(0) !== 0x89504e47)
        fail(`screencap failed: ${String(r.stderr || png || "").trim().slice(0, 300) || "no image data"}`);
      fs.writeFileSync(file, png);
      out(file);
    },
  },

  ui: {
    help: "ui [--all]  -> compact UI tree: text | desc | [tap] | center x,y. Empty = GPU-drawn app (game, Compose canvas): use shot",
    run(args, flags, adb) {
      for (const n of uiNodes(adb)) {
        if (!flags.all && !n.text && !n.desc) continue;
        out(formatNode(n, !!flags.all));
      }
    },
  },

  tap: {
    help: 'tap <x> <y>  |  tap "<text>"  (exact text or content-desc from the UI tree; falls back to substring)',
    run(args, flags, adb) {
      if (args.length >= 2 && isInt(args[0]) && isInt(args[1])) {
        if (args.length > 2) fail("usage: tap <x> <y>  |  tap \"<text>\"");
        adb.run(["shell", "input", "tap", args[0], args[1]]);
        return out(`tap ${args[0]},${args[1]}`);
      }
      const want = args.join(" ").trim();
      if (!want) fail('usage: tap <x> <y>  |  tap "<text>"');
      const n = findNode(uiNodes(adb), want);
      if (!n) fail(`"${want}" not found in the UI tree (GPU-drawn screen? use shot + coordinates)`);
      adb.run(["shell", "input", "tap", String(n.cx), String(n.cy)]);
      out(`tap "${n.text || n.desc}" at ${n.cx},${n.cy}`);
    },
  },

  swipe: {
    help: "swipe <x1> <y1> <x2> <y2> [ms=300]",
    run(a, flags, adb) {
      if (a.length < 4 || a.length > 5 || !a.every(isInt)) fail("usage: swipe <x1> <y1> <x2> <y2> [ms]  (integers)");
      adb.run(["shell", "input", "swipe", ...a.slice(0, 4), a[4] || "300"]);
      out("ok");
    },
  },

  type: {
    help: 'type "<text>"  -> types into the focused field (never use for passwords)',
    run(a, flags, adb) {
      const text = a.join(" ");
      if (!text) fail('usage: type "<text>"');
      if (!isAsciiPrintable(text)) console.error("warning: `input text` cannot type non-ASCII characters or line breaks reliably");
      adb.run(["shell", "input", "text", inputTextArg(text)]);
      out("ok");
    },
  },

  key: {
    help: "key <KEYCODE|name>  e.g. key BACK, key HOME, key WAKEUP, key 66",
    run(a, flags, adb) {
      if (!a[0] || !/^[A-Za-z0-9_]+$/.test(a[0])) fail("usage: key <name|number>  e.g. key BACK, key 66");
      const k = /^\d+$/.test(a[0]) ? a[0] : "KEYCODE_" + a[0].toUpperCase().replace(/^KEYCODE_/, "");
      adb.run(["shell", "input", "keyevent", k]);
      out(`key ${k}`);
    },
  },

  launch: {
    help: "launch <package>  -> start the app's launcher activity",
    run(a, flags, adb) {
      if (!a[0] || !isPackageName(a[0])) fail("usage: launch <package>  e.g. launch com.android.settings");
      const r = adb.run(["shell", "monkey", "-p", a[0], "-c", "android.intent.category.LAUNCHER", "1"]);
      const text = String(r.stdout) + String(r.stderr);
      if (/No activities found|monkey aborted/i.test(text)) fail(`could not launch ${a[0]}: not installed or has no launcher activity`);
      out(`launched ${a[0]}`);
    },
  },

  apps: {
    help: "apps [filter]  -> third-party packages with versionName",
    run(a, flags, adb) {
      const pk = adb.sh("pm list packages -3").split("\n").map(l => l.replace(/^package:/, "").trim())
        .filter(p => p && isPackageName(p) && (!a[0] || p.includes(a[0]))).sort();
      // One adb round trip per 30 packages instead of one per package.
      for (let i = 0; i < pk.length; i += 30) {
        const chunk = pk.slice(i, i + 30);
        const s = parseSections(adb.sh(chunk.map(p => `echo '@@${p}'; dumpsys package ${p} | grep -m1 versionName`).join("; ")));
        for (const p of chunk) out(`${p} ${((s[p] || "").split("=")[1] || "").trim()}`);
      }
    },
  },

  install: {
    help: "install <apk> [--sha256 <hex>]  -> verifies hash if given, then adb install -r",
    run(a, flags, adb) {
      if (!a[0]) fail("usage: install <apk> [--sha256 <hex>]");
      requireFile(a[0], "install");
      const h = sha256File(a[0]);
      out(`sha256 ${h}`);
      if (flags.sha256 !== undefined) {
        const want = String(flags.sha256).trim().replace(/^sha256:/i, "").toLowerCase();
        if (want !== h) fail(`HASH MISMATCH: not installing (expected ${want})`);
      }
      const r = adb.run(["install", "-r", path.resolve(a[0])]);
      const text = String(r.stdout) + String(r.stderr);
      process.stdout.write(text);
      if (r.status !== 0 || !/^Success/m.test(text)) fail("install failed");
    },
  },

  push: {
    help: "push <local> <remote>  -> copy, verify sha256 on device; under Android/data also sync + chmod 660",
    run(a, flags, adb) {
      if (a.length < 2) fail("usage: push <local> <remote>");
      let [local, remote] = a;
      requireFile(local, "push");
      checkDevicePath(remote);
      const r = adb.run(["push", path.resolve(local), remote]);
      if (r.status !== 0) fail(String(r.stderr || r.stdout).trim() || "adb push failed");
      if (adb.sh(`[ -d ${q(remote)} ] && echo dir`).trim() === "dir") remote = remote.replace(/\/+$/, "") + "/" + path.basename(local);
      const lh = sha256File(local);
      const sum = adb.sh(`sha256sum ${q(remote)} 2>&1`).trim();
      const rh = sum.split(/\s+/)[0];
      if (!/^[0-9a-f]{64}$/.test(rh)) fail(`could not verify the copy on the device: ${sum || "no output from sha256sum"}`);
      if (lh !== rh) fail(`HASH MISMATCH local=${lh} device=${rh}`);
      out(`verified sha256 ${lh} -> ${remote}`);
      if (remote.includes("/Android/data/")) { adb.sh(`sync; chmod 660 ${q(remote)}`); out("sync + chmod 660 done (app-private dir)"); }
    },
  },

  pull: {
    help: "pull <remote> [local]",
    run(a, flags, adb) {
      if (!a[0]) fail("usage: pull <remote> [local]");
      checkDevicePath(a[0]);
      const r = adb.run(["pull", a[0], path.resolve(a[1] || ".")]);
      process.stdout.write(String(r.stdout) + String(r.stderr));
      return r.status === 0 ? 0 : 1;
    },
  },

  thermals: {
    help: "max CPU / GPU / battery temperature and battery draw",
    run(a, flags, adb) { out(thermalsLine(adb)); },
  },

  fps: {
    help: "fps <package-or-part> [seconds=30] [--wait]  -> real on-screen fps, 1% low, hitches (SurfaceFlinger). --wait: wait until the app renders >15 fps",
    run(a, flags, adb) {
      const pat = a[0];
      if (!pat) fail("usage: fps <package> [seconds] [--wait]");
      const secs = a[1] === undefined ? 30 : Number(a[1]);
      if (!Number.isFinite(secs) || secs <= 0 || secs > 3600) fail("fps: seconds must be a number between 1 and 3600");
      let layer = locateLayer(adb, pat);
      if (flags.wait) {
        process.stdout.write("waiting for the app to render...");
        let ok = false;
        for (let i = 0; i < 360 && !ok; i++) {
          layer = locateLayer(adb, pat);
          ok = !!layer && quickRate(adb.sh(`dumpsys SurfaceFlinger --latency ${q(layer)}`)) > 15;
          if (!ok) sleepMs(5000);
        }
        if (!ok) { out(""); fail(`timed out: "${pat}" never rendered above 15 fps`); }
        out(" detected, measuring in 8 s");
        sleepMs(8000);
        layer = locateLayer(adb, pat) || layer;
      }
      if (!layer) fail(`no SurfaceFlinger layer matches "${pat}" (is the app in front?)`);
      out(`layer: ${layer}`);
      // SurfaceFlinger keeps the last 127 frames (~1 s at 120 Hz). Sample every 0.4 s *on the device*
      // (one adb call) so windows overlap; non-overlapping windows are treated as breaks, not hitches.
      const n = Math.ceil(secs / 0.4);
      const raw = adb.sh(`i=0; while [ $i -lt ${n} ]; do dumpsys SurfaceFlinger --latency ${q(layer)}; echo ---; sleep 0.4; i=$((i+1)); done`);
      const st = frameStats(splitSamples(raw));
      if (!st) return out("no new frames (paused, menu or static screen?)");
      out(formatStats(st));
      out(thermalsLine(adb));
    },
  },
};

// ---------- main ----------
function printHelp(env, print = out) {
  print("handroid - computer use for Android handhelds: adb helper for AI agents (Windows / Linux / macOS)\n\nusage: handroid [--serial <id>] <command> [args]\n");
  for (const [k, v] of Object.entries(commands)) print(`  ${k.padEnd(9)} ${v.help}`);
  let where;
  try { where = findAdb({ env }) || "not found (set ADB=/path/to/adb or ANDROID_HOME)"; } catch (e) { where = e.message; }
  print(`\nadb: ${where}`);
}

/** Run the CLI. Returns the process exit code (never calls process.exit). */
export function main(argv, env = process.env) {
  try {
    const { command, args, flags, serial } = parseArgs(argv);
    if (!command || command === "help" || flags.help) { printHelp(env); return 0; }
    if (!Object.hasOwn(commands, command)) {
      console.error(`unknown command: ${command}\n`);
      printHelp(env);
      return 1;
    }
    const adbPath = findAdb({ env });
    if (!adbPath) fail(ADB_NOT_FOUND);
    const adb = new Adb(adbPath, serial || env.ANDROID_SERIAL || "");
    const code = commands[command].run(args, flags, adb);
    return typeof code === "number" ? code : 0;
  } catch (e) {
    if (e instanceof CliError) { console.error(e.message); return e.code; }
    console.error(env.HANDROID_DEBUG ? e.stack : `error: ${e.message}`);
    return 1;
  }
}

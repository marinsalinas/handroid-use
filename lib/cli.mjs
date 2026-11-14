import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Adb, ADB_NOT_FOUND, findAdb } from "./adb.mjs";
import { parseArgs } from "./args.mjs";
import { DISPLAY_CONTEXT_CMDS, checkDisplayArg, describeDisplay, displayContext, displayForTree, formatDisplays, parseTopActivities, resolveDisplay } from "./displays.mjs";
import { CHECKS, DEFAULT_CHECKS, formatReport, planChecks, runChecks, worst } from "./doctor.mjs";
import { DEVICE_INFO_CMDS, deviceInfo, parseDevices, parseDf, parseMdns, unconnectedServices } from "./devices.mjs";
import { CliError, fail } from "./errors.mjs";
import { findLayer, formatStats, frameStats, parseFocus, splitSamples } from "./fps.mjs";
import { inputTextArg, isAsciiPrintable, isInt, isPackageName, parseSections, quote as q, sectionScript } from "./shell.mjs";
import { THERMAL_ZONES_CMD, currentMa, formatThermals, maxTemp, parseThermalZones } from "./thermals.mjs";
import { findNode, formatNode, parseUiXml } from "./ui.mjs";
import { devJoin, fmtBytes, listLocal, parseRemoteList, parseSums, planSync, remoteChunkCmds, remoteListCmd, sha256File, stamp } from "./sync.mjs";

const out = (...a) => console.log(...a);
const BAT = "/sys/class/power_supply/battery";

// ---------- shared helpers ----------
export { sha256File };

/** sha256 of each `rels` file inside device dir `dir` (chunked, one adb call per ~60 KB of paths). */
function remoteSums(adb, dir, rels) {
  const sums = new Map();
  for (const cmd of remoteChunkCmds(dir, rels, "sha256sum")) for (const [k, v] of parseSums(adb.sh(cmd))) sums.set(k, v);
  return sums;
}

const isRemoteDir = (adb, p) => adb.sh(`[ -d ${q(p)} ] && echo dir`).trim() === "dir";

/**
 * Copy a local folder into a device folder: only files that are missing or differ in size (or in
 * sha256 with --checksum), then verify every copied file's sha256 on the device. Never deletes.
 */
function pushDir(adb, local, remote, flags) {
  const src = listLocal(local);
  const dst = parseRemoteList(adb.sh(remoteListCmd(remote)));
  let srcSums = null, dstSums = null;
  if (flags.checksum) {
    const both = [...src.keys()].filter(r => dst.get(r) === src.get(r));
    srcSums = new Map(both.map(r => [r, sha256File(path.join(local, r))]));
    dstSums = remoteSums(adb, remote, both);
  }
  const plan = planSync(src, dst, srcSums, dstSums);
  out(`${src.size} files: ${plan.copy.length} to copy (${fmtBytes(plan.bytes)}), ${plan.same.length} already there` +
      `${plan.extra.length ? `, ${plan.extra.length} only on the device (left alone)` : ""}`);
  if (flags["dry-run"]) { for (const r of plan.copy) out(`  + ${r}`); return; }
  plan.copy.forEach((rel, i) => {
    const r = adb.run(["push", path.join(local, rel), devJoin(remote, rel)]);
    if (r.status !== 0) fail(`push failed for ${rel}: ${String(r.stderr || r.stdout).trim()} (run the same command again to resume)`);
    out(`  [${i + 1}/${plan.copy.length}] ${rel}`);
  });
  const sums = remoteSums(adb, remote, plan.copy);
  const bad = plan.copy.filter(r => sums.get(r) !== sha256File(path.join(local, r)));
  if (bad.length) fail(`HASH MISMATCH on ${bad.length} file(s): ${bad.slice(0, 5).join(", ")} (run again with --checksum to re-copy them)`);
  if (plan.copy.length && remote.includes("/Android/data/")) {
    for (const cmd of remoteChunkCmds(remote, plan.copy, "chmod 660")) adb.sh(cmd);
    adb.sh("sync");
    out("sync + chmod 660 done (app-private dir)");
  }
  out(`verified sha256 of ${plan.copy.length} copied file(s) -> ${remote}`);
}

/**
 * Copy a device folder into a local folder, same rules as pushDir. Returns Map(rel -> sha256) of the
 * files copied (all of them when `dest` started empty).
 */
function pullDir(adb, remote, dest, flags) {
  const src = parseRemoteList(adb.sh(remoteListCmd(remote)));
  const dst = fs.existsSync(dest) ? listLocal(dest) : new Map();
  let srcSums = null, dstSums = null;
  if (flags.checksum) {
    const both = [...src.keys()].filter(r => dst.get(r) === src.get(r));
    srcSums = remoteSums(adb, remote, both);
    dstSums = new Map(both.map(r => [r, sha256File(path.join(dest, r))]));
  }
  const plan = planSync(src, dst, srcSums, dstSums);
  out(`${src.size} files: ${plan.copy.length} to copy (${fmtBytes(plan.bytes)}), ${plan.same.length} already there` +
      `${plan.extra.length ? `, ${plan.extra.length} only on this computer (left alone)` : ""}`);
  if (flags["dry-run"]) { for (const r of plan.copy) out(`  + ${r}`); return new Map(); }
  plan.copy.forEach((rel, i) => {
    const to = path.join(dest, ...rel.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const r = adb.run(["pull", devJoin(remote, rel), to]);
    if (r.status !== 0) fail(`pull failed for ${rel}: ${String(r.stderr || r.stdout).trim()} (run the same command again to resume)`);
    out(`  [${i + 1}/${plan.copy.length}] ${rel}`);
  });
  const sums = remoteSums(adb, remote, plan.copy);
  const got = new Map();
  const bad = [];
  for (const rel of plan.copy) {
    const h = sha256File(path.join(dest, ...rel.split("/")));
    got.set(rel, h);
    if (sums.get(rel) !== h) bad.push(rel);
  }
  if (bad.length) fail(`HASH MISMATCH on ${bad.length} file(s): ${bad.slice(0, 5).join(", ")} (the file may have changed while copying; run again with --checksum)`);
  out(`verified sha256 of ${plan.copy.length} copied file(s) -> ${dest}`);
  return got;
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

/** Displays, which one is focused and what runs on each (one adb round trip). */
function getDisplays(adb) {
  return displayContext(parseSections(adb.sh(sectionScript(DISPLAY_CONTEXT_CMDS))));
}

/** --display (logical or physical id) -> display object, or null on devices without display info. */
function flagDisplay(adb, flags) {
  checkDisplayArg(flags.display);
  return resolveDisplay(getDisplays(adb).displays, flags.display);
}

/** Logical display id for `input -d`, or "" for the default. */
function inputDisplay(adb, flags) {
  if (flags.display === undefined) return "";
  const d = flagDisplay(adb, flags);
  return String(d ? d.id : flags.display);
}
const inputArgs = (disp, ...rest) => ["shell", "input", ...(disp !== "" ? ["-d", disp] : []), ...rest];

// Emulators read controller buttons, not keyboard keys: `input gamepad keyevent KEYCODE_BUTTON_A`.
const SOURCES = ["keyboard", "gamepad", "dpad", "joystick"];
const GAMEPAD_BUTTONS = new Set(["A", "B", "C", "X", "Y", "Z", "L1", "R1", "L2", "R2", "THUMBL", "THUMBR", "START", "SELECT", "MODE"]);

/** --source value for `input <source>`, or "" for the default (keyboard). */
function inputSource(flags) {
  if (flags.source === undefined) return "";
  const s = String(flags.source).toLowerCase();
  if (!SOURCES.includes(s)) fail(`--source must be one of: ${SOURCES.join(", ")}`);
  return s === "keyboard" ? "" : s;
}

/** Key name -> keycode. With a gamepad source, short button names map to KEYCODE_BUTTON_* (A -> KEYCODE_BUTTON_A). */
export function keyCode(name, source = "") {
  if (/^\d+$/.test(name)) return name;
  const n = name.toUpperCase().replace(/^KEYCODE_/, "");
  if (source === "gamepad" && GAMEPAD_BUTTONS.has(n)) return `KEYCODE_BUTTON_${n}`;
  return `KEYCODE_${n}`;
}
const keyArgs = (src, disp, k) => ["shell", "input", ...(src ? [src] : []), ...(disp !== "" ? ["-d", disp] : []), "keyevent", k];

/** --min-fps (default 15) and --stable seconds (default 3) for "is it rendering". */
function renderingOpts(flags) {
  const minFps = flags["min-fps"] === undefined ? 15 : Number(flags["min-fps"]);
  const stable = flags.stable === undefined ? 3 : Number(flags.stable);
  if (!Number.isFinite(minFps) || minFps <= 0 || minFps > 1000) fail("--min-fps must be a number above 0");
  if (!Number.isFinite(stable) || stable < 1 || stable > 120) fail("--stable must be 1..120 seconds");
  return { minFps, stable };
}

/**
 * True when the app's surface presents at least `minFps` on average over `stable` seconds of NEW frames.
 * A single burst (an animated menu redrawing once, a loading spinner) no longer counts; note that a
 * loading screen that animates steadily still does.
 */
function renders(adb, pat, minFps, stable) {
  const layer = locateLayer(adb, pat);
  if (!layer) return false;
  const st = sampleFrames(adb, layer, stable);
  // avgFps only averages the gaps between frames, so a burst followed by silence still reads high.
  // Count new frames over the wall-clock window as well.
  return !!st && st.avgFps >= minFps && st.frames / stable >= minFps;
}

/**
 * Dump the UI tree and work out which display it belongs to (null on single-screen devices).
 * uiautomator only dumps one window, and it is not always on the focused display.
 */
function uiTree(adb) {
  let nodes;
  try { nodes = uiNodes(adb); } catch (e) {
    if (e instanceof CliError && getDisplays(adb).asleep) fail("the screen is asleep: run  handroid key WAKEUP  first");
    throw e;
  }
  return { nodes, display: displayForTree(getDisplays(adb), nodes[0]) };
}

/** Temperatures and battery in one round trip: { line, cpu, gpu, battery, level, status, ma }. */
function thermalsData(adb) {
  const s = parseSections(adb.sh(sectionScript({
    zones: THERMAL_ZONES_CMD,
    current: `cat ${BAT}/current_now 2>/dev/null`,
    capacity: `cat ${BAT}/capacity 2>/dev/null`,
    status: `cat ${BAT}/status 2>/dev/null`,
  })));
  const z = parseThermalZones(s.zones);
  return {
    line: formatThermals(z, s),
    cpu: maxTemp(z, /cpu/i), gpu: maxTemp(z, /gpu/i), battery: maxTemp(z, /^battery$/i),
    level: s.capacity ? Number(s.capacity) : NaN, status: s.status || "", ma: currentMa(s.current),
  };
}
const thermalsLine = adb => thermalsData(adb).line;

/**
 * Sample a layer for `secs` on the device (one adb call) and return frame stats or null.
 * SurfaceFlinger keeps the last 127 frames (~1 s at 120 Hz): sample every 0.4 s so windows overlap;
 * non-overlapping windows are breaks, not hitches. The first sample is only a baseline.
 * The loop runs on the device clock, so `secs` is wall time (each dumpsys itself takes ~0.2 s).
 */
export function samplingScript(layer, secs) {
  const L = `dumpsys SurfaceFlinger --latency ${q(layer)}; echo ---`;
  return `end=$(($(date +%s)+${Math.max(1, Math.round(secs))})); ${L}; while [ $(date +%s) -lt $end ]; do sleep 0.4; ${L}; done`;
}
function sampleFrames(adb, layer, secs) {
  const raw = adb.sh(samplingScript(layer, secs));
  return frameStats(splitSamples(raw), { baseline: true });
}

const r1 = v => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
/** Stats without the per-frame array, rounded, for JSON. */
const statsJson = st => st && Object.fromEntries(Object.entries(st).filter(([k]) => k !== "frameTimes").map(([k, v]) => [k, typeof v === "number" ? r1(v) : v]));

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
    help: "displays [--json]  -> every screen: logical id, physical id, size, focus, top app. --display accepts either id",
    run(a, flags, adb) {
      const ctx = getDisplays(adb);
      if (flags.json) return out(JSON.stringify({ displays: ctx.displays, focused: ctx.focused }, null, 2));
      // Devices that do not print DisplayInfo (old Android, emulators): fall back to SurfaceFlinger ids.
      if (!ctx.displays.length) return out(adb.sh("dumpsys SurfaceFlinger --display-id").trim());
      out(formatDisplays(ctx));
      if (ctx.displays.length > 1) out('\nkey/type go to the focused screen (*); ui prints which screen its tree is from. tap/swipe/key/type/shot take --display <id> (logical or physical).');
    },
  },

  shot: {
    help: "shot [file.png] [--display <id>]  -> screenshot (default: primary screen); prints the saved path",
    run(args, flags, adb) {
      const file = path.resolve(args[0] || path.join(os.tmpdir(), `android-shot-${Date.now()}.png`));
      const a = ["exec-out", "screencap", "-p"];
      if (flags.display !== undefined) {
        // screencap wants the physical id; accept the logical one too.
        const d = flagDisplay(adb, flags);
        a.splice(2, 0, "-d", d && d.physical ? d.physical : String(flags.display));
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
      const { nodes, display: d } = uiTree(adb);
      if (d) out(`# ${describeDisplay(d)}${d.focused ? " (focused)" : ""}: tap "text" targets this screen; for coordinates add --display ${d.id}`);
      for (const n of nodes) {
        if (!flags.all && !n.text && !n.desc) continue;
        out(formatNode(n, !!flags.all));
      }
    },
  },

  tap: {
    help: 'tap <x> <y> [--display <id>]  |  tap "<text>"  (exact text or content-desc from the UI tree, on the focused screen; falls back to substring)',
    run(args, flags, adb) {
      if (args.length >= 2 && isInt(args[0]) && isInt(args[1])) {
        if (args.length > 2) fail("usage: tap <x> <y>  |  tap \"<text>\"");
        const disp = inputDisplay(adb, flags);
        adb.run(inputArgs(disp, "tap", args[0], args[1]));
        return out(`tap ${args[0]},${args[1]}${disp ? ` on display ${disp}` : ""}`);
      }
      const want = args.join(" ").trim();
      if (!want) fail('usage: tap <x> <y>  |  tap "<text>"');
      if (flags.display !== undefined) fail('tap "<text>" always targets the screen the UI tree comes from (see the ui header); use coordinates with --display');
      // Send the tap to the display the tree came from, not to the default display 0.
      const { nodes, display: d } = uiTree(adb);
      const n = findNode(nodes, want);
      if (!n) fail(`"${want}" not found in the UI tree (GPU-drawn screen? use shot + coordinates)`);
      adb.run(inputArgs(d ? String(d.id) : "", "tap", String(n.cx), String(n.cy)));
      out(`tap "${n.text || n.desc}" at ${n.cx},${n.cy}${d ? ` on display ${d.id}` : ""}`);
    },
  },

  swipe: {
    help: "swipe <x1> <y1> <x2> <y2> [ms=300] [--display <id>]",
    run(a, flags, adb) {
      if (a.length < 4 || a.length > 5 || !a.every(isInt)) fail("usage: swipe <x1> <y1> <x2> <y2> [ms]  (integers)");
      adb.run(inputArgs(inputDisplay(adb, flags), "swipe", ...a.slice(0, 4), a[4] || "300"));
      out("ok");
    },
  },

  type: {
    help: 'type "<text>" [--display <id>]  -> types into the focused field (never use for passwords)',
    run(a, flags, adb) {
      const text = a.join(" ");
      if (!text) fail('usage: type "<text>"');
      if (!isAsciiPrintable(text)) console.error("warning: `input text` cannot type non-ASCII characters or line breaks reliably");
      adb.run(inputArgs(inputDisplay(adb, flags), "text", inputTextArg(text)));
      out("ok");
    },
  },

  key: {
    help: "key <KEYCODE|name> [--source gamepad|dpad|joystick|keyboard] [--display <id>]  e.g. key BACK, key WAKEUP, key A --source gamepad (emulators ignore keyboard events)",
    run(a, flags, adb) {
      if (!a[0] || !/^[A-Za-z0-9_]+$/.test(a[0])) fail("usage: key <name|number>  e.g. key BACK, key 66, key A --source gamepad");
      const src = inputSource(flags);
      const k = keyCode(a[0], src);
      adb.run(keyArgs(src, inputDisplay(adb, flags), k));
      out(`key ${k}${src ? ` (${src})` : ""}`);
    },
  },

  launch: {
    help: "launch <package> [--display <id>]  -> start the app's launcher activity (on that screen)",
    run(a, flags, adb) {
      if (!a[0] || !isPackageName(a[0])) fail("usage: launch <package>  e.g. launch com.android.settings");
      if (flags.display !== undefined) {
        const disp = inputDisplay(adb, flags);
        const comp = adb.sh(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${q(a[0])} 2>/dev/null`)
          .trim().split("\n").pop().trim(); // the component is the last line
        if (!/^[\w.]+\/[\w.$]+$/.test(comp)) fail(`could not launch ${a[0]}: not installed or has no launcher activity`);
        const text = adb.sh(`am start --display ${disp} -n ${q(comp)} 2>&1`);
        if (/^Error|Exception/m.test(text)) fail(`am start failed: ${text.trim().split("\n").slice(-2).join(" ")}`);
        return out(`launched ${comp} on display ${disp}`);
      }
      const r = adb.run(["shell", "monkey", "-p", a[0], "-c", "android.intent.category.LAUNCHER", "1"]);
      const text = String(r.stdout) + String(r.stderr);
      if (/No activities found|monkey aborted/i.test(text)) fail(`could not launch ${a[0]}: not installed or has no launcher activity`);
      out(`launched ${a[0]}`);
    },
  },

  seq: {
    help: 'seq "<step>" ... [--display <id>] [--source gamepad]  -> several inputs in ONE adb call (steps: "tap x y", "swipe x1 y1 x2 y2 [ms]", "key NAME", "sleep s"); --source applies to key steps',
    run(a, flags, adb) {
      if (!a.length) fail('usage: seq "tap 100 200" "sleep 0.5" "key BACK" [--display <id>]');
      const steps = a.map(s => s.trim().split(/\s+/));
      for (const [cmd, ...p] of steps) {
        const ok = cmd === "tap" ? p.length === 2 && p.every(isInt)
          : cmd === "swipe" ? (p.length === 4 || p.length === 5) && p.every(isInt)
          : cmd === "key" ? p.length === 1 && /^[A-Za-z0-9_]+$/.test(p[0])
          : cmd === "sleep" ? p.length === 1 && /^\d+(\.\d+)?$/.test(p[0]) && Number(p[0]) <= 30
          : false;
        if (!ok) fail(`seq: bad step "${[cmd, ...p].join(" ")}". Steps: "tap x y", "swipe x1 y1 x2 y2 [ms]", "key NAME", "sleep s" (<= 30)`);
      }
      const src = inputSource(flags);
      const disp = inputDisplay(adb, flags);
      const d = disp !== "" ? ` -d ${disp}` : "";
      const script = steps.map(([cmd, ...p]) => {
        if (cmd === "sleep") return `sleep ${p[0]}`;
        if (cmd === "key") return `input${src ? ` ${src}` : ""}${d} keyevent ${keyCode(p[0], src)}`;
        if (cmd === "swipe") return `input${d} swipe ${p.slice(0, 4).join(" ")} ${p[4] || 300}`;
        return `input${d} tap ${p.join(" ")}`;
      }).join(" && ");
      adb.sh(script);
      out(`ok (${steps.length} steps${disp ? ` on display ${disp}` : ""})`);
    },
  },

  "wait-for": {
    help: 'wait-for text "<t>" | gone "<t>" | app <pkg> | awake | rendering <pkg> [--min-fps 15] [--stable 3]  [--timeout s=30] [--display <id>]  -> poll until true; exit 1 on timeout',
    run(a, flags, adb) {
      const [kind, ...rest] = a;
      const arg = rest.join(" ").trim();
      const timeout = flags.timeout === undefined ? 30 : Number(flags.timeout);
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600) fail("wait-for: --timeout must be 1..3600 seconds");
      const tree = () => { try { return uiNodes(adb); } catch { return null; } }; // uiautomator fails while animating: not yet
      let probe;
      if (kind === "text" || kind === "gone") {
        if (!arg) fail(`usage: wait-for ${kind} "<text>"`);
        probe = kind === "text" ? () => !!findNode(tree() || [], arg) : () => { const t = tree(); return !!t && !findNode(t, arg); };
      } else if (kind === "app") {
        if (!isPackageName(arg)) fail("usage: wait-for app <package>");
        const disp = flags.display === undefined ? null : Number(inputDisplay(adb, flags));
        probe = () => {
          const s = parseSections(adb.sh(sectionScript({ focus: "dumpsys window 2>/dev/null | grep -m1 mCurrentFocus", acts: DISPLAY_CONTEXT_CMDS.acts })));
          const tops = parseTopActivities(s.acts);
          const on = c => (c || "").split("/")[0] === arg;
          return disp === null ? on(parseFocus(s.focus)) || Object.values(tops).some(on) : on(tops[disp]);
        };
      } else if (kind === "awake") {
        probe = () => /mWakefulness=Awake/.test(adb.sh("dumpsys power 2>/dev/null | grep -m1 mWakefulness="));
      } else if (kind === "rendering") {
        if (!arg) fail("usage: wait-for rendering <package-or-part> [--min-fps n] [--stable s]");
        const { minFps, stable } = renderingOpts(flags);
        probe = () => renders(adb, arg, minFps, stable);
      } else fail('usage: wait-for text "<t>" | gone "<t>" | app <pkg> | awake | rendering <pkg>  [--timeout s]');
      const t0 = Date.now();
      for (;;) {
        if (probe()) return out(`ok after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        if (Date.now() - t0 > timeout * 1000) fail(`timed out after ${timeout} s waiting for ${kind}${arg ? ` "${arg}"` : ""}`);
        sleepMs(700);
      }
    },
  },

  logcat: {
    help: "logcat [package] [lines=200] [--crash] [--errors]  -> recent log of a running app (by pid), else the crash buffer",
    run(a, flags, adb) {
      const pkg = a[0] && !isInt(a[0]) ? a[0] : "";
      const n = Number((pkg ? a[1] : a[0]) ?? 200);
      if (pkg && !isPackageName(pkg)) fail("usage: logcat [package] [lines] [--crash] [--errors]");
      if (!Number.isInteger(n) || n < 1 || n > 100000) fail("logcat: lines must be 1..100000");
      const lvl = flags.errors ? " '*:E'" : "";
      const pid = pkg && !flags.crash ? adb.sh(`pidof ${q(pkg)}`).trim().split(/\s+/)[0] : "";
      let text;
      if (pid && /^\d+$/.test(pid)) {
        text = adb.sh(`logcat -d --pid=${pid}${lvl} | tail -n ${n}`);
        out(`# ${pkg} (pid ${pid}), last ${n} lines`);
      } else {
        text = adb.sh(`logcat -d -b crash -t ${n}${lvl}`);
        if (pkg) {
          // Keep only crash blocks that mention the package (a block = lines sharing one pid).
          const lines = text.split("\n");
          const pids = new Set(lines.filter(l => l.includes(pkg)).map(l => (l.trim().split(/\s+/)[2] || "")));
          text = lines.filter(l => pids.has(l.trim().split(/\s+/)[2] || "-")).join("\n");
        }
        out(`# crash buffer${pkg ? ` for ${pkg} (not running${flags.crash ? " or --crash" : ""})` : ""}`);
      }
      out(text.trim() || "(empty)");
    },
  },

  doctor: {
    help: "doctor [check[:arg]] ...  [--json] [--strict]  -> health checks you choose: storage memory thermals battery phantom wireless app:<pkg> perms:<dir> (no args = the general ones). `handroid doctor --list` explains each",
    run(a, flags, adb) {
      if (flags.list) {
        for (const [k, c] of Object.entries(CHECKS)) out(`  ${k.padEnd(9)} ${c.help}`);
        return out(`\nno arguments = ${DEFAULT_CHECKS.join(" ")}`);
      }
      const { plan, cmds } = planChecks(a);
      const report = runChecks(plan, parseSections(adb.sh(sectionScript(cmds))));
      if (flags.json) out(JSON.stringify(report, null, 2));
      else out(formatReport(report));
      const w = worst(report);
      return w >= 2 || (flags.strict && w >= 1) ? 1 : 0;
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
    help: "push <local file|folder> <remote> [--checksum] [--dry-run]  -> copy + verify sha256 on the device. Folders: only missing/changed files, resumable, never deletes. Android/data: sync + chmod 660",
    run(a, flags, adb) {
      if (a.length < 2) fail("usage: push <local> <remote>");
      let [local, remote] = a;
      checkDevicePath(remote);
      if (fs.existsSync(local) && fs.statSync(local).isDirectory()) return pushDir(adb, local, remote, flags);
      requireFile(local, "push");
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
    help: "pull <remote file|folder> [local] [--checksum] [--dry-run]  -> folders: only missing/changed files, verified, resumable, never deletes",
    run(a, flags, adb) {
      if (!a[0]) fail("usage: pull <remote> [local]");
      checkDevicePath(a[0]);
      if (isRemoteDir(adb, a[0])) {
        const dest = path.resolve(a[1] || path.posix.basename(a[0].replace(/\/+$/, "")));
        pullDir(adb, a[0], dest, flags);
        return;
      }
      const r = adb.run(["pull", a[0], path.resolve(a[1] || ".")]);
      process.stdout.write(String(r.stdout) + String(r.stderr));
      return r.status === 0 ? 0 : 1;
    },
  },

  backup: {
    help: "backup <remote folder> [--to <local folder>]  -> dated, hash-verified snapshot (+ SHA256SUMS), e.g. an emulator's saves; never touches the device",
    run(a, flags, adb) {
      if (!a[0]) fail("usage: backup <remote folder> [--to <local folder>]");
      checkDevicePath(a[0]);
      if (!isRemoteDir(adb, a[0])) fail(`backup: ${a[0]} is not a folder on the device`);
      const name = path.posix.basename(a[0].replace(/\/+$/, "")).replace(/[^\w.-]+/g, "_") || "root";
      const dest = path.resolve(flags.to || "handroid-backups", `${name}-${stamp()}`);
      if (fs.existsSync(dest)) fail(`backup: ${dest} already exists`);
      const sums = pullDir(adb, a[0], dest, {});
      if (!sums.size) { fs.rmSync(dest, { recursive: true, force: true }); fail(`backup: ${a[0]} has no files`); }
      fs.writeFileSync(path.join(dest, "SHA256SUMS"), [...sums].sort(([x], [y]) => (x < y ? -1 : 1)).map(([r, h]) => `${h}  ${r}`).join("\n") + "\n");
      out(`backup: ${dest} (${sums.size} files, SHA256SUMS written; check later with: sha256sum -c SHA256SUMS)`);
    },
  },

  record: {
    help: "record [file.mp4] [seconds=10] [--display <id>]  -> screen video via screenrecord (max 180 s)",
    run(a, flags, adb) {
      let file = "", secs = 10;
      for (const x of a) {
        if (/^\d+$/.test(x)) secs = Number(x);
        else if (!file) file = x;
        else fail("usage: record [file.mp4] [seconds] [--display <id>]");
      }
      if (secs < 1 || secs > 180) fail("record: seconds must be 1..180 (screenrecord's limit)");
      const local = path.resolve(file || path.join(os.tmpdir(), `handroid-rec-${Date.now()}.mp4`));
      let disp = "";
      if (flags.display !== undefined) {
        const d = flagDisplay(adb, flags);
        disp = ` --display-id ${d && d.physical ? d.physical : flags.display}`;
      }
      const tmp = `/sdcard/handroid-rec-${Date.now()}.mp4`;
      const msg = adb.sh(`screenrecord --time-limit ${secs}${disp} ${q(tmp)} 2>&1`).trim();
      const r = adb.run(["pull", tmp, local]);
      adb.sh(`rm -f ${q(tmp)}`);
      if (r.status !== 0 || !fs.existsSync(local) || fs.statSync(local).size === 0)
        fail(`record failed: ${msg || String(r.stderr).trim() || "no video"}`);
      out(local);
    },
  },

  thermals: {
    help: "max CPU / GPU / battery temperature and battery draw",
    run(a, flags, adb) { out(thermalsLine(adb)); },
  },

  fps: {
    help: "fps <package-or-part> [seconds=30] [--wait] [--json]  -> real on-screen fps, 1% low, hitches (SurfaceFlinger). --wait: wait until the app renders >15 fps",
    run(a, flags, adb) {
      const pat = a[0];
      if (!pat) fail("usage: fps <package> [seconds] [--wait]");
      const secs = a[1] === undefined ? 30 : Number(a[1]);
      if (!Number.isFinite(secs) || secs <= 0 || secs > 3600) fail("fps: seconds must be a number between 1 and 3600");
      let layer = locateLayer(adb, pat);
      if (flags.wait) {
        const { minFps, stable } = renderingOpts(flags);
        process.stdout.write(`waiting for the app to render (>= ${minFps} fps for ${stable} s)...`);
        let ok = false;
        for (const t0 = Date.now(); Date.now() - t0 < 30 * 60000 && !ok;) {
          ok = renders(adb, pat, minFps, stable);
          if (!ok) sleepMs(2000);
        }
        if (!ok) { out(""); fail(`timed out: "${pat}" never rendered ${minFps} fps for ${stable} s`); }
        out(" detected, measuring in 8 s");
        sleepMs(8000);
        layer = locateLayer(adb, pat) || layer;
      }
      if (!layer) fail(`no SurfaceFlinger layer matches "${pat}" (is the app in front?)`);
      if (!flags.json) out(`layer: ${layer}`);
      const st = sampleFrames(adb, layer, secs);
      if (flags.json) {
        const t = thermalsData(adb);
        return out(JSON.stringify({ layer, seconds: secs, stats: statsJson(st), temps: { cpu: r1(t.cpu), gpu: r1(t.gpu), battery: r1(t.battery) }, batteryMa: r1(t.ma) }, null, 2));
      }
      if (!st) return out("no new frames (paused, menu or static screen?)");
      out(formatStats(st));
      out(thermalsLine(adb));
    },
  },

  bench: {
    help: "bench <package-or-part> [minutes=5] [--interval s=10] [--csv file] [--json]  -> fps + temps + battery every interval: throttling, long sessions, A/B comparisons",
    run(a, flags, adb) {
      const pat = a[0];
      if (!pat) fail("usage: bench <package> [minutes] [--interval s] [--csv file] [--json]");
      const minutes = a[1] === undefined ? 5 : Number(a[1]);
      const every = flags.interval === undefined ? 10 : Number(flags.interval);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240) fail("bench: minutes must be a number between 0.1 and 240");
      if (!Number.isFinite(every) || every < 2 || every > 600) fail("bench: --interval must be 2..600 seconds");
      let layer = locateLayer(adb, pat);
      if (!layer) fail(`no SurfaceFlinger layer matches "${pat}" (is the app in front?)`);
      const rows = [], all = [];
      if (!flags.json) { out(`layer: ${layer}`); out("   t(s)    fps  1%low  worst(ms)  hitches   CPU C   GPU C  batt C    mA  bat%"); }
      const t0 = Date.now();
      while ((Date.now() - t0) / 60000 < minutes) {
        const st = sampleFrames(adb, layer, every);
        const th = thermalsData(adb);
        const row = {
          t: Math.round((Date.now() - t0) / 1000),
          fps: st ? r1(st.avgFps) : 0, low1: st ? r1(st.low1Fps) : 0, worstMs: st ? Math.round(st.worstMs) : null,
          hitches: st ? st.hitches : 0, cpu: r1(th.cpu), gpu: r1(th.gpu), battery: r1(th.battery),
          ma: Number.isFinite(th.ma) ? Math.round(th.ma) : null, level: Number.isFinite(th.level) ? th.level : null,
        };
        if (st) all.push(...st.frameTimes);
        rows.push(row);
        if (!flags.json) {
          const c = [row.t, row.fps, row.low1, row.worstMs, row.hitches, row.cpu, row.gpu, row.battery, row.ma, row.level];
          const w = [7, 6, 6, 10, 8, 7, 7, 7, 5, 5];
          out(c.map((v, i) => String(v ?? "-").padStart(w[i])).join(" "));
        }
        if (!st) layer = locateLayer(adb, pat) || layer; // the layer id changes when the app recreates its surface
      }
      const summary = benchSummary(rows, all);
      if (flags.csv) {
        const cols = ["t", "fps", "low1", "worstMs", "hitches", "cpu", "gpu", "battery", "ma", "level"];
        fs.writeFileSync(path.resolve(flags.csv), [cols.join(","), ...rows.map(r => cols.map(k => r[k] ?? "").join(","))].join("\n") + "\n");
      }
      if (flags.json) return out(JSON.stringify({ layer, minutes, interval: every, summary, rows }, null, 2));
      out("");
      out(summary.text);
      if (flags.csv) out(`csv: ${path.resolve(flags.csv)}`);
    },
  },
};

/** Whole-run numbers and a throttling verdict (first third vs last third of the intervals). */
export function benchSummary(rows, frameTimes) {
  const s = { intervals: rows.length };
  if (frameTimes.length >= 2) {
    const total = frameTimes.reduce((x, y) => x + y, 0);
    const sorted = [...frameTimes].sort((x, y) => x - y);
    s.avgFps = r1(frameTimes.length / (total / 1000));
    s.low1Fps = r1(1000 / sorted[Math.min(sorted.length - 1, Math.ceil(0.99 * sorted.length) - 1)]);
  }
  const max = k => { const v = rows.map(r => r[k]).filter(Number.isFinite); return v.length ? Math.max(...v) : null; };
  s.maxCpu = max("cpu"); s.maxGpu = max("gpu"); s.maxBattery = max("battery");
  const third = Math.floor(rows.length / 3);
  if (third >= 1) {
    const avg = list => list.reduce((x, r) => x + r.fps, 0) / list.length;
    const first = avg(rows.slice(0, third)), last = avg(rows.slice(-third));
    s.firstThirdFps = r1(first); s.lastThirdFps = r1(last);
    s.dropPct = first > 0 ? r1(((first - last) / first) * 100) : null;
    s.throttling = s.dropPct !== null && s.dropPct >= 10;
  }
  const lv = rows.map(r => r.level).filter(Number.isFinite);
  if (lv.length >= 2) s.batteryUsed = lv[0] - lv[lv.length - 1];
  s.text = [
    `overall: ${s.avgFps ?? "n/a"} fps avg, 1% low ${s.low1Fps ?? "n/a"} | max CPU ${s.maxCpu ?? "n/a"} C, GPU ${s.maxGpu ?? "n/a"} C, battery ${s.maxBattery ?? "n/a"} C`,
    ...(s.firstThirdFps !== undefined ? [`first third ${s.firstThirdFps} fps -> last third ${s.lastThirdFps} fps${s.throttling ? `: dropped ${s.dropPct}%, likely thermal throttling` : ""}`] : []),
    ...(s.batteryUsed !== undefined ? [`battery used: ${s.batteryUsed}%`] : []),
  ].join("\n");
  return s;
}

// ---------- main ----------
function printHelp(env, print = out) {
  print("handroid - computer use for Android handhelds: adb helper for AI agents (Windows / Linux / macOS)\n\nusage: handroid [--serial <id>] <command> [args]\n");
  for (const [k, v] of Object.entries(commands)) print(`  ${k.padEnd(9)} ${v.help}`);
  print(`  ${"mcp".padEnd(9)} run as an MCP server over stdio (the commands above as tools), e.g. claude mcp add handroid -- handroid mcp`);
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

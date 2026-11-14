#!/usr/bin/env node
// android-use: small, dependency-free adb helper CLI for AI agents (and humans).
// Works on Windows, Linux and macOS. Requires Node 18+ and adb.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------- adb discovery ----------
function findAdb() {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates = [];
  if (process.env.ADB) candidates.push(process.env.ADB);
  for (const v of ["ANDROID_HOME", "ANDROID_SDK_ROOT"])
    if (process.env[v]) candidates.push(path.join(process.env[v], "platform-tools", exe));
  for (const dir of (process.env.PATH || "").split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe));
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    candidates.push(path.join(local, "Android", "Sdk", "platform-tools", exe));
    const winget = path.join(local, "Microsoft", "WinGet", "Packages");
    try {
      for (const d of fs.readdirSync(winget))
        if (d.startsWith("Google.PlatformTools")) candidates.push(path.join(winget, d, "platform-tools", exe));
    } catch {}
  } else if (process.platform === "darwin") {
    candidates.push(path.join(home, "Library", "Android", "sdk", "platform-tools", exe), "/opt/homebrew/bin/adb", "/usr/local/bin/adb");
  } else {
    candidates.push(path.join(home, "Android", "Sdk", "platform-tools", exe), "/usr/bin/adb");
  }
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  die("adb not found. Install Android platform-tools or set ADB=/path/to/adb (or ANDROID_HOME).");
}

function die(msg, code = 1) { console.error(msg); process.exit(code); }

const ADB = findAdb();
let SERIAL = process.env.ANDROID_SERIAL || "";

function rawAdb(args, opts = {}) {
  const r = spawnSync(ADB, args, { encoding: opts.binary ? "buffer" : "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
  if (r.error) die(`adb failed: ${r.error.message}`);
  return r;
}
function pickDevice() {
  if (SERIAL) return SERIAL;
  const lines = rawAdb(["devices"]).stdout.split(/\r?\n/).slice(1).map(l => l.trim().split(/\s+/)).filter(p => p[0]);
  const ok = lines.filter(p => p[1] === "device");
  if (ok.length === 1) return (SERIAL = ok[0][0]);
  if (ok.length === 0) {
    const bad = lines.map(p => `${p[0]} (${p[1]})`).join(", ");
    die(bad ? `No ready device. Seen: ${bad}. Unlock the device and accept the USB debugging prompt.` : "No device connected (adb devices is empty).");
  }
  die(`Several devices: ${ok.map(p => p[0]).join(", ")}. Pick one with --serial <id> or ANDROID_SERIAL.`);
}
function adb(args, opts = {}) { return rawAdb(["-s", pickDevice(), ...args], opts); }
function sh(cmd) { return adb(["shell", cmd]).stdout.replace(/\r/g, ""); }
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`; // quote for the device shell

// ---------- commands ----------
const commands = {
  discover: {
    help: "discover [--json]  -> every device adb sees (USB + Wi-Fi) with model, Android, SoC/GPU, screens, battery; plus wireless-debugging devices on the LAN not connected yet",
    run(args, flags) {
      const lines = rawAdb(["devices", "-l"]).stdout.split(/\r?\n/).slice(1).map(l => l.trim()).filter(Boolean);
      const found = [];
      for (const l of lines) {
        const [serial, state, ...rest] = l.split(/\s+/);
        const d = { serial, state, transport: /:\d+$|_adb-tls-connect/.test(serial) ? "wifi" : "usb" };
        for (const kv of rest) { const [k, v] = kv.split(":"); if (v) d[k] = v; }
        if (state === "device") {
          const g = k => rawAdb(["-s", serial, "shell", `getprop ${k}`]).stdout.trim();
          const s = c => rawAdb(["-s", serial, "shell", c]).stdout.replace(/\r/g, "").trim();
          d.manufacturer = g("ro.product.manufacturer"); d.model = g("ro.product.model");
          d.android = g("ro.build.version.release"); d.sdk = g("ro.build.version.sdk");
          d.soc = [g("ro.soc.manufacturer"), g("ro.soc.model")].filter(Boolean).join(" ") || g("ro.board.platform");
          d.gpu = (s("dumpsys SurfaceFlinger | grep -m1 GLES").replace(/^GLES:\s*/, "").split(",")[1] || "").trim();
          d.abi = g("ro.product.cpu.abi");
          d.screen = (s("wm size").match(/(\d+x\d+)/g) || []).pop() || "";
          d.displays = (s("dumpsys SurfaceFlinger --display-id").match(/^Display \d+/gm) || []).length || 1;
          d.battery = s("cat /sys/class/power_supply/battery/capacity 2>/dev/null");
          d.storageFree = (s("df -h /storage/emulated 2>/dev/null | tail -1").split(/\s+/)[3]) || "";
        } else if (state === "unauthorized") d.hint = "unlock the device and accept the 'Allow USB debugging' prompt";
        else if (state === "offline") d.hint = "replug the cable or run: adb kill-server";
        found.push(d);
      }
      // Wireless debugging (Android 11+) advertises over mDNS
      const connected = new Set(found.map(d => d.serial));
      const lan = [];
      const m = rawAdb(["mdns", "services"]).stdout.split(/\r?\n/).slice(1);
      for (const l of m) {
        const p = l.trim().split(/\s+/); if (p.length < 3) continue;
        const [name, type, addr] = p;
        if (connected.has(addr) || [...connected].some(c => c.startsWith(name))) continue;
        lan.push({ name, kind: type.includes("pairing") ? "pairing" : "connect", address: addr });
      }
      if (flags.json) return console.log(JSON.stringify({ adb: ADB, devices: found, lan }, null, 2));
      if (!found.length) console.log("No devices connected over adb.");
      for (const d of found) {
        console.log(`\n${d.serial}  [${d.state}, ${d.transport}]`);
        if (d.hint) { console.log(`  -> ${d.hint}`); continue; }
        if (d.state !== "device") continue;
        console.log(`  ${d.manufacturer} ${d.model}  -  Android ${d.android} (SDK ${d.sdk}), ${d.abi}`);
        console.log(`  SoC: ${d.soc || "?"}   GPU: ${d.gpu || "?"}`);
        console.log(`  screen: ${d.screen}${d.displays > 1 ? `  (${d.displays} displays: use shot --display <id>)` : ""}   battery: ${d.battery || "?"}%   free: ${d.storageFree || "?"}`);
      }
      if (lan.length) {
        console.log("\nOn the network (wireless debugging), not connected:");
        for (const l of lan) console.log(`  ${l.address.padEnd(22)} ${l.kind === "pairing" ? "pairing code shown on the device -> android-use pair " + l.address + " <code>" : "-> android-use connect " + l.address}`);
      }
      if (found.filter(d => d.state === "device").length > 1) console.log("\nSeveral devices: pass --serial <id> (or set ANDROID_SERIAL) to the other commands.");
    },
  },

  connect: {
    help: "connect <ip:port>  -> attach a wireless-debugging device",
    run(a) { if (!a[0]) die("connect <ip:port>"); const r = rawAdb(["connect", a[0]]); console.log((r.stdout + r.stderr).trim()); },
  },

  pair: {
    help: "pair <ip:port> <code>  -> pair with Android 11+ wireless debugging (code shown on the device)",
    run(a) { if (a.length < 2) die("pair <ip:port> <code>"); const r = rawAdb(["pair", a[0], a[1]]); console.log((r.stdout + r.stderr).trim()); },
  },

  status: {
    help: "connection, foreground app, screen state, battery, free storage",
    run() {
      pickDevice();
      const model = sh("getprop ro.product.model").trim();
      const rel = sh("getprop ro.build.version.release").trim();
      const focus = (sh("dumpsys window | grep -m1 mCurrentFocus").match(/\{[^ ]+ [^ ]+ ([^}]+)\}/) || [])[1] || "none";
      const wake = (sh("dumpsys power | grep -m1 mWakefulness").split("=")[1] || "?").trim();
      const bat = sh("cat /sys/class/power_supply/battery/capacity /sys/class/power_supply/battery/status 2>/dev/null").trim().split(/\s+/);
      const df = sh("df -h /storage/emulated 2>/dev/null | tail -1").trim().split(/\s+/);
      console.log(`device:   ${SERIAL} ${model} (Android ${rel})`);
      console.log(`screen:   ${wake}`);
      console.log(`focus:    ${focus}`);
      if (bat[0]) console.log(`battery:  ${bat[0]}% ${bat[1] || ""}`);
      if (df[3]) console.log(`storage:  ${df[3]} free of ${df[1]} (${df[4]} used)`);
    },
  },

  displays: {
    help: "list display ids (for multi-screen devices); use with: shot --display <id>",
    run() { console.log(sh("dumpsys SurfaceFlinger --display-id").trim()); },
  },

  shot: {
    help: "shot [file.png] [--display <id>]  -> screenshot; prints the saved path",
    run(args, flags) {
      const file = path.resolve(args[0] || path.join(os.tmpdir(), `android-shot-${Date.now()}.png`));
      const a = ["exec-out", "screencap", "-p"];
      if (flags.display) a.splice(2, 0, "-d", flags.display);
      const r = adb(a, { binary: true });
      if (!r.stdout || r.stdout.length < 100) die(`screencap failed: ${r.stderr}`);
      fs.writeFileSync(file, r.stdout);
      console.log(file);
    },
  },

  ui: {
    help: "ui [--all]  -> compact UI tree: text | desc | [tap] | center x,y. Empty = GPU-drawn app (game, Compose canvas): use shot",
    run(args, flags) {
      for (const n of uiNodes()) {
        if (!flags.all && !n.text && !n.desc) continue;
        console.log(`${(n.text || "").padEnd(38)} ${(n.desc || "").padEnd(24)} ${n.clickable ? "[tap]" : "     "} ${n.cx},${n.cy}${flags.all ? "  " + n.id : ""}`);
      }
    },
  },

  tap: {
    help: 'tap <x> <y>  |  tap "<text>"  (exact text or content-desc from the UI tree; falls back to substring)',
    run(args) {
      if (args.length >= 2 && /^\d+$/.test(args[0])) { adb(["shell", "input", "tap", args[0], args[1]]); return console.log(`tap ${args[0]},${args[1]}`); }
      const want = args.join(" ");
      if (!want) die("tap needs coordinates or text");
      const nodes = uiNodes();
      const n = nodes.find(n => n.text === want || n.desc === want) ||
                nodes.find(n => (n.text + " " + n.desc).toLowerCase().includes(want.toLowerCase()));
      if (!n) die(`"${want}" not found in the UI tree (GPU-drawn screen? use shot + coordinates)`);
      adb(["shell", "input", "tap", String(n.cx), String(n.cy)]);
      console.log(`tap "${n.text || n.desc}" at ${n.cx},${n.cy}`);
    },
  },

  swipe: {
    help: "swipe <x1> <y1> <x2> <y2> [ms=300]",
    run(a) { if (a.length < 4) die("swipe x1 y1 x2 y2 [ms]"); adb(["shell", "input", "swipe", ...a.slice(0, 4), a[4] || "300"]); console.log("ok"); },
  },

  type: {
    help: 'type "<text>"  -> types into the focused field (never use for passwords)',
    run(a) { adb(["shell", "input", "text", a.join(" ").replace(/ /g, "%s").replace(/([()<>|;&*\\~"'`$])/g, "\\$1")]); console.log("ok"); },
  },

  key: {
    help: "key <KEYCODE|name>  e.g. key BACK, key HOME, key WAKEUP, key 66",
    run(a) { const k = /^\d+$/.test(a[0]) ? a[0] : "KEYCODE_" + String(a[0] || "").toUpperCase().replace(/^KEYCODE_/, ""); adb(["shell", "input", "keyevent", k]); console.log(`key ${k}`); },
  },

  launch: {
    help: "launch <package>  -> start the app's launcher activity",
    run(a) { if (!a[0]) die("launch <package>"); adb(["shell", "monkey", "-p", a[0], "-c", "android.intent.category.LAUNCHER", "1"]); console.log(`launched ${a[0]}`); },
  },

  apps: {
    help: "apps [filter]  -> third-party packages with versionName",
    run(a) {
      const pk = sh("pm list packages -3").split("\n").map(l => l.replace("package:", "").trim()).filter(Boolean).sort();
      for (const p of pk.filter(p => !a[0] || p.includes(a[0]))) {
        const v = (sh(`dumpsys package ${q(p)} | grep -m1 versionName`).split("=")[1] || "").trim();
        console.log(`${p} ${v}`);
      }
    },
  },

  install: {
    help: "install <apk> [--sha256 <hex>]  -> verifies hash if given, then adb install -r",
    run(a, flags) {
      if (!a[0]) die("install <apk>");
      const h = sha256File(a[0]); console.log(`sha256 ${h}`);
      if (flags.sha256 && flags.sha256.replace(/^sha256:/, "").toLowerCase() !== h) die("HASH MISMATCH: not installing");
      const r = adb(["install", "-r", path.resolve(a[0])]); process.stdout.write(r.stdout + r.stderr);
    },
  },

  push: {
    help: "push <local> <remote>  -> copy, verify sha256 on device; under Android/data also sync + chmod 660",
    run(a) {
      if (a.length < 2) die("push <local> <remote>");
      let [local, remote] = a;
      const r = adb(["push", path.resolve(local), remote]);
      if (r.status !== 0) die(r.stderr || r.stdout);
      if (sh(`[ -d ${q(remote)} ] && echo dir`).trim() === "dir") remote = remote.replace(/\/$/, "") + "/" + path.basename(local);
      const lh = sha256File(local), rh = sh(`sha256sum ${q(remote)}`).split(/\s+/)[0];
      if (lh !== rh) die(`HASH MISMATCH local=${lh} device=${rh}`);
      console.log(`verified sha256 ${lh} -> ${remote}`);
      if (remote.includes("/Android/data/")) { sh(`sync; chmod 660 ${q(remote)}`); console.log("sync + chmod 660 done (app-private dir)"); }
    },
  },

  pull: {
    help: "pull <remote> [local]",
    run(a) { if (!a[0]) die("pull <remote> [local]"); const r = adb(["pull", a[0], path.resolve(a[1] || ".")]); process.stdout.write(r.stdout + r.stderr); },
  },

  thermals: {
    help: "max CPU / GPU / battery temperature and battery draw",
    run() { console.log(thermalsLine()); },
  },

  fps: {
    help: "fps <package-or-part> [seconds=30] [--wait]  -> real on-screen fps, 1% low, hitches (SurfaceFlinger). --wait: wait until the app renders >15 fps",
    run(a, flags) {
      const pat = a[0] || die("fps <package> [seconds] [--wait]");
      const secs = Number(a[1] || 30);
      let layer = findLayer(pat);
      if (flags.wait) {
        process.stdout.write("waiting for the app to render...");
        for (let i = 0; i < 360; i++) {
          layer = findLayer(pat);
          if (layer && quickRate(layer) > 15) break;
          sleepMs(5000);
        }
        console.log(" detected, measuring in 8 s");
        sleepMs(8000);
      }
      if (!layer) die(`no SurfaceFlinger layer matches "${pat}" (is the app in front?)`);
      console.log(`layer: ${layer}`);
      // SurfaceFlinger keeps the last 127 frames (~1 s at 120 Hz). Sample every 0.4 s *on the device* (one adb call)
      // so windows overlap; non-overlapping windows are treated as breaks, not hitches.
      const n = Math.ceil(secs / 0.4);
      const out = sh(`i=0; while [ $i -lt ${n} ]; do dumpsys SurfaceFlinger --latency ${q(layer)} | tail -n +2; echo ---; sleep 0.4; i=$((i+1)); done`);
      const frameTimes = []; let last = 0, breaks = 0, contiguous = 0, frames = 0;
      for (const block of out.split("---")) {
        const ts = block.split("\n").map(l => l.trim().split(/\s+/)).filter(p => p.length >= 2)
          .map(p => Number(p[1])).filter(t => t > 0 && t < 9e18).sort((x, y) => x - y);
        const fresh = ts.filter(t => t > last);
        if (!fresh.length) continue;
        const overlaps = !last || ts[0] <= last;      // window shares frames with the previous one
        if (!overlaps) breaks++;
        let prev = overlaps ? last : 0;               // after a break, don't count the gap as a frame
        for (const t of fresh) {
          if (prev) { const d = (t - prev) / 1e6; frameTimes.push(d); contiguous += d; }
          prev = t; frames++;
        }
        last = fresh[fresh.length - 1];
      }
      if (frameTimes.length < 2) return console.log("no new frames (paused, menu or static screen?)");
      const sorted = [...frameTimes].sort((x, y) => x - y);
      const pct = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      console.log(`avg fps:   ${(frameTimes.length / (contiguous / 1000)).toFixed(1)}   (${frames} frames, ${(contiguous / 1000).toFixed(1)} s measured)`);
      console.log(`1% low:    ${(1000 / pct(0.99)).toFixed(1)} fps   0.1% low: ${(1000 / pct(0.999)).toFixed(1)} fps`);
      console.log(`worst:     ${sorted[sorted.length - 1].toFixed(0)} ms   frames >33 ms: ${frameTimes.filter(d => d > 33.4).length}   hitches >50 ms: ${frameTimes.filter(d => d > 50).length}`);
      if (breaks) console.log(`note: ${breaks} sampling window(s) did not overlap (slow adb); those gaps were excluded`);
      console.log(thermalsLine());
    },
  },
};

// ---------- helpers ----------
function uiNodes() {
  const xml = adb(["exec-out", "uiautomator", "dump", "/dev/tty"]).stdout;
  const nodes = [];
  for (const m of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const at = {}; for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) at[a[1]] = a[2];
    const b = (at.bounds || "").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/); if (!b) continue;
    const dec = s => (s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, " ");
    nodes.push({ text: dec(at.text), desc: dec(at["content-desc"]), id: at["resource-id"] || "", clickable: at.clickable === "true",
      cx: Math.round((+b[1] + +b[3]) / 2), cy: Math.round((+b[2] + +b[4]) / 2) });
  }
  return nodes;
}
function findLayer(pat) {
  const all = sh("dumpsys SurfaceFlinger --list").split("\n").map(s => s.trim()).filter(s => s.includes(pat));
  return all.filter(s => s.includes("SurfaceView") && s.includes("(BLAST)")).pop() ||
         all.filter(s => s.includes("SurfaceView") && !/^Background|^Bounds/.test(s)).pop() ||
         all.filter(s => !/ActivityRecord|InputSink|^Bounds|^Background/.test(s)).pop() || "";
}
function quickRate(layer) {
  const ts = sh(`dumpsys SurfaceFlinger --latency ${q(layer)}`).split("\n").slice(1).map(l => Number(l.trim().split(/\s+/)[1])).filter(t => t > 0 && t < 9e18).slice(-40);
  return ts.length < 2 ? 0 : (ts.length - 1) / ((ts[ts.length - 1] - ts[0]) / 1e9);
}
function thermalsLine() {
  const rows = sh('for z in /sys/class/thermal/thermal_zone*; do t=$(cat $z/type 2>/dev/null); v=$(cat $z/temp 2>/dev/null) || continue; echo "$t $v"; done')
    .split("\n").map(l => l.trim().split(/\s+/)).filter(p => p.length === 2 && /^-?\d+$/.test(p[1]));
  const max = re => { const v = rows.filter(r => re.test(r[0])).map(r => +r[1]).filter(v => v > 0 && v < 150000); return v.length ? (Math.max(...v) / (Math.max(...v) > 1000 ? 1000 : 1)).toFixed(1) + " C" : "n/a"; };
  const c = sh("cat /sys/class/power_supply/battery/current_now /sys/class/power_supply/battery/voltage_now /sys/class/power_supply/battery/capacity /sys/class/power_supply/battery/status 2>/dev/null").trim().split(/\s+/);
  let power = "";
  if (c.length >= 4) { const ma = Math.abs(+c[0]) / (Math.abs(+c[0]) > 20000 ? 1000 : 1); power = ` | battery ${c[2]}% ${c[3]}, ${ma.toFixed(0)} mA`; }
  return `temps: CPU ${max(/cpu/i)} | GPU ${max(/gpu/i)} | battery ${max(/^battery$/i)}${power}`;
}
function sha256File(f) { return createHash("sha256").update(fs.readFileSync(f)).digest("hex"); }
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// ---------- main ----------
const argv = process.argv.slice(2);
const flags = {}; const args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--serial" || a === "-s") { SERIAL = argv[++i]; continue; }
  if (a.startsWith("--")) { const k = a.slice(2); const nx = argv[i + 1]; if (nx && !nx.startsWith("--") && ["display", "sha256"].includes(k)) { flags[k] = nx; i++; } else flags[k] = true; continue; }
  args.push(a);
}
const name = args.shift();
if (!name || name === "help" || flags.help || !commands[name]) {
  console.log("android-use - adb helper for AI agents (Windows / Linux / macOS)\n\nusage: android-use [--serial <id>] <command> [args]\n");
  for (const [k, v] of Object.entries(commands)) console.log(`  ${k.padEnd(9)} ${v.help}`);
  console.log(`\nadb: ${ADB}`);
  process.exit(name && !commands[name] && name !== "help" ? 1 : 0);
}
commands[name].run(args, flags);

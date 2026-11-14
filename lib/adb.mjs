import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.mjs";
import { parseDevices, selectDevice } from "./devices.mjs";

/**
 * Candidate adb locations, in priority order: ANDROID_HOME / ANDROID_SDK_ROOT, PATH,
 * then the SDK default location and winget (Windows) / Homebrew (macOS) / distro paths.
 * (ADB=... is handled by findAdb: when set it is used as-is or not at all.)
 */
export function adbCandidates({ env = process.env, platform = process.platform, home = os.homedir(), readdir = fs.readdirSync } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const exe = platform === "win32" ? "adb.exe" : "adb";
  const c = [];
  for (const v of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) if (env[v]) c.push(p.join(env[v], "platform-tools", exe));
  // Windows env var names are case-insensitive ("Path" is common).
  const PATH = env.PATH ?? env.Path ?? Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
  for (const dir of PATH.split(platform === "win32" ? ";" : ":")) if (dir) c.push(p.join(dir.replace(/^"|"$/g, ""), exe));
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || p.join(home, "AppData", "Local");
    c.push(p.join(local, "Android", "Sdk", "platform-tools", exe));
    const winget = p.join(local, "Microsoft", "WinGet", "Packages");
    try {
      for (const d of readdir(winget)) if (d.startsWith("Google.PlatformTools")) c.push(p.join(winget, d, "platform-tools", exe));
    } catch {}
  } else if (platform === "darwin") {
    c.push(p.join(home, "Library", "Android", "sdk", "platform-tools", exe), "/opt/homebrew/bin/adb", "/usr/local/bin/adb");
  } else {
    c.push(p.join(home, "Android", "Sdk", "platform-tools", exe), "/usr/bin/adb", "/usr/local/bin/adb");
  }
  return c;
}

/**
 * Locate adb. Returns the path, or "" when not found.
 * If ADB is set it must exist: we never silently fall back to another adb.
 */
export function findAdb(opts = {}) {
  const env = opts.env || process.env;
  const exists = opts.exists || (f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (env.ADB) {
    if (!exists(env.ADB)) throw new CliError(`ADB is set to "${env.ADB}" but that file does not exist.`);
    return env.ADB;
  }
  for (const c of adbCandidates({ ...opts, env })) if (exists(c)) return c;
  return "";
}

export const ADB_NOT_FOUND = "adb not found. Install Android platform-tools or set ADB=/path/to/adb (or ANDROID_HOME).";

// adb client-side failures (as opposed to output of the command run on the device).
const ADB_ERROR = /^(adb: )?error:|^adb: (device|more than one|no devices)|device '.*' not found|no devices\/emulators found|device (offline|unauthorized)/im;

/**
 * Thin synchronous adb wrapper.
 * - `raw(args)` runs adb without a serial.
 * - `run(args)` runs against the selected device (`-s <serial>`), picking it lazily.
 * - `sh(cmd)` runs a device shell command and returns stdout with \r removed.
 * An adb path ending in .js/.mjs/.cjs is run with the current Node (used by the test suite's fake adb).
 */
export class Adb {
  constructor(adbPath, serial = "") {
    this.path = adbPath;
    this.serial = serial;
    this.selected = "";
  }

  raw(args, opts = {}) {
    if (!this.path) throw new CliError(ADB_NOT_FOUND);
    const isScript = /\.[cm]?js$/i.test(this.path);
    const file = isScript ? process.execPath : this.path;
    const argv = isScript ? [this.path, ...args] : args;
    const r = spawnSync(file, argv, {
      encoding: opts.binary ? "buffer" : "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (r.error) throw new CliError(`adb failed: ${r.error.message}`);
    if (r.stdout == null) r.stdout = opts.binary ? Buffer.alloc(0) : "";
    if (r.stderr == null) r.stderr = "";
    return r;
  }

  devices() {
    return parseDevices(this.raw(["devices", "-l"]).stdout);
  }

  pick() {
    if (!this.selected) this.selected = selectDevice(this.devices(), this.serial);
    return this.selected;
  }

  run(args, opts = {}) {
    const r = this.raw(["-s", this.pick(), ...args], opts);
    const err = String(r.stderr);
    if (r.status !== 0 && ADB_ERROR.test(err)) throw new CliError(err.trim());
    return r;
  }

  sh(cmd) {
    return String(this.run(["shell", cmd]).stdout).replace(/\r/g, "");
  }
}

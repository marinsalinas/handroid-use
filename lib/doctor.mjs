// `handroid doctor`: device health checks chosen by arguments. Nothing here is device-specific:
// device knowledge (which app is critical on which handheld) lives in the skill's profiles, which
// tell the agent what to pass, e.g. `doctor app:<keymapper package> storage thermals:cpu=80`.
//
// A check spec is `name`, `name:value` or `name:key=value,key=value`.
// Each check declares the shell commands it needs (all checks run in ONE adb round trip) and a pure
// evaluate() that turns their output into results: { status: ok|info|warn|fail, msg, hint? }.
import { CliError } from "./errors.mjs";
import { isPackageName, quote as q } from "./shell.mjs";
import { THERMAL_ZONES_CMD, maxTemp, parseThermalZones } from "./thermals.mjs";

/** Parse "thermals:cpu=80,gpu=75" -> { name: "thermals", value: "cpu=80,gpu=75", opts: { cpu: "80", gpu: "75" } }. */
export function parseCheckSpec(spec) {
  const s = String(spec).trim();
  const i = s.indexOf(":");
  const name = (i < 0 ? s : s.slice(0, i)).toLowerCase();
  const value = i < 0 ? "" : s.slice(i + 1);
  const opts = {};
  if (value.includes("=")) for (const kv of value.split(",")) {
    const [k, v = ""] = kv.split("=");
    if (k) opts[k.trim().toLowerCase()] = v.trim();
  }
  return { name, value, opts };
}

const num = (v, dflt, what) => {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CliError(`doctor: ${what} must be a number, got "${v}"`);
  return n;
};

/** "1-02:03:04" / "02:03:04" / "03:04" (ps ETIME) -> seconds, NaN if unparsable. */
export function etimeSeconds(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return NaN;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3]) * 60) + Number(m[4]);
}

const fmtDur = s => (s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/**
 * Count lifecycle events for `pkg` in `logcat -b events` output.
 * am_proc_start [user,pid,uid,pkg,...], am_proc_died [user,pid,pkg,...], am_crash [pid,user,pkg,flags,exception,msg,...],
 * am_anr [user,pid,pkg,...], am_kill [user,pid,pkg,adj,reason].
 */
export function appEvents(text, pkg) {
  const r = { starts: 0, died: 0, crashes: 0, anrs: 0, kills: 0, lastCrash: "", lastKill: "", first: "", last: "" };
  const own = new RegExp(`[\\[,]${pkg.replace(/\./g, "\\.")}(?::[\\w.]+)?[,\\]]`);
  for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const m = /^(\d\d-\d\d \d\d:\d\d:\d\d)\.\d+.*?\b(am_proc_start|am_proc_died|am_crash|am_anr|am_kill)\s*:\s*(\[.*\])/.exec(line);
    if (!m || !own.test(m[3])) continue;
    r.first ||= m[1]; r.last = m[1];
    const f = m[3].slice(1, -1).split(",");
    if (m[2] === "am_proc_start") r.starts++;
    else if (m[2] === "am_proc_died") r.died++;
    else if (m[2] === "am_crash") { r.crashes++; r.lastCrash = `${m[1]} ${f[4] || ""}${f[5] ? ": " + f[5] : ""}`.trim(); }
    else if (m[2] === "am_anr") r.anrs++;
    else if (m[2] === "am_kill") { r.kills++; r.lastKill = `${m[1]} ${f.slice(4).join(",")}`.trim(); }
  }
  return r;
}

export const CHECKS = {
  storage: {
    help: "storage[:warn%]  free space on /data (warn at 90% used, fail at 97%)",
    cmds: () => ({ df: "df -k /data 2>/dev/null | tail -1" }),
    evaluate(s, spec) {
      const warn = num(spec.opts.warn ?? spec.value, 90, "storage threshold");
      const p = s.df.trim().split(/\s+/);
      const pct = Number((p[4] || "").replace("%", "")), freeKb = Number(p[3]);
      if (!Number.isFinite(pct)) return [{ status: "info", msg: "could not read /data usage" }];
      const msg = `${pct}% used, ${(freeKb / 1048576).toFixed(1)} GB free`;
      if (pct >= Math.max(97, warn)) return [{ status: "fail", msg, hint: "apps fail to install or save with this little space; free some (handroid apps / pull and delete large files)" }];
      if (pct >= warn) return [{ status: "warn", msg, hint: "large copies (games, ROM sets) may not fit" }];
      return [{ status: "ok", msg }];
    },
  },

  memory: {
    help: "memory[:min%]  available RAM (warn below 10%) and swap use",
    cmds: () => ({ mem: "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo" }),
    evaluate(s, spec) {
      const min = num(spec.opts.min ?? spec.value, 10, "memory threshold");
      const kv = {};
      for (const m of s.mem.matchAll(/^(\w+):\s+(\d+)/gm)) kv[m[1]] = Number(m[2]);
      if (!kv.MemTotal) return [{ status: "info", msg: "could not read /proc/meminfo" }];
      const pct = (kv.MemAvailable / kv.MemTotal) * 100;
      const swap = kv.SwapTotal ? ` | swap ${(((kv.SwapTotal - kv.SwapFree) / kv.SwapTotal) * 100).toFixed(0)}% used` : "";
      const msg = `${(kv.MemAvailable / 1048576).toFixed(1)} of ${(kv.MemTotal / 1048576).toFixed(1)} GB available (${pct.toFixed(0)}%)${swap}`;
      return [{ status: pct < min ? "warn" : "ok", msg, ...(pct < min ? { hint: "background apps will be killed; close what is not needed" } : {}) }];
    },
  },

  thermals: {
    help: "thermals[:cpu=85,gpu=80,battery=45]  hottest CPU/GPU/battery sensor against limits (C)",
    cmds: () => ({ zones: THERMAL_ZONES_CMD }),
    evaluate(s, spec) {
      const z = parseThermalZones(s.zones);
      const lim = { cpu: num(spec.opts.cpu, 85, "cpu limit"), gpu: num(spec.opts.gpu, 80, "gpu limit"), battery: num(spec.opts.battery, 45, "battery limit") };
      const t = { cpu: maxTemp(z, /cpu/i), gpu: maxTemp(z, /gpu/i), battery: maxTemp(z, /^battery$/i) };
      const parts = Object.entries(t).map(([k, v]) => `${k.toUpperCase()} ${Number.isFinite(v) ? v.toFixed(1) + " C" : "n/a"}`);
      const hot = Object.keys(t).filter(k => t[k] >= lim[k]);
      if (!Object.values(t).some(Number.isFinite)) return [{ status: "info", msg: "no readable thermal sensors" }];
      return [{ status: hot.length ? "warn" : "ok", msg: parts.join(" | "), ...(hot.length ? { hint: `${hot.join(", ")} at or above the limit: expect throttling` } : {}) }];
    },
  },

  battery: {
    help: "battery  charge, health and temperature as reported by the battery service",
    cmds: () => ({ bat: "dumpsys battery 2>/dev/null" }),
    evaluate(s) {
      const g = k => (new RegExp(`^\\s*${k}: (.+)$`, "m").exec(s.bat) || [])[1];
      const level = g("level");
      if (level === undefined) return [{ status: "info", msg: "no battery (TV or emulator?)" }];
      const health = { 1: "unknown", 2: "good", 3: "overheat", 4: "dead", 5: "over voltage", 6: "failure", 7: "cold" }[g("health")] || "unknown";
      const status = { 1: "unknown", 2: "charging", 3: "discharging", 4: "not charging", 5: "full" }[g("status")] || "unknown";
      const temp = Number(g("temperature")) / 10;
      const msg = `${level}% ${status}, health ${health}${Number.isFinite(temp) ? `, ${temp.toFixed(1)} C` : ""}`;
      const bad = ["overheat", "dead", "over voltage", "failure", "cold"].includes(health);
      return [{ status: bad ? "fail" : "ok", msg }];
    },
  },

  phantom: {
    help: "phantom  Android 12-13 'phantom process' limit that kills apps running many child processes (Linux/Wine/Proton layers, terminals)",
    cmds: () => ({
      sdk: "getprop ro.build.version.sdk",
      max: "device_config get activity_manager max_phantom_processes 2>/dev/null",
      mon: "settings get global settings_enable_monitor_phantom_procs 2>/dev/null",
    }),
    evaluate(s) {
      const sdk = Number(s.sdk);
      if (sdk < 31) return [{ status: "ok", msg: `Android SDK ${sdk}: no phantom process limit` }];
      if (s.mon.trim() === "false") return [{ status: "ok", msg: "phantom process monitoring is disabled" }];
      const max = Number(s.max);
      if (Number.isFinite(max) && max > 1000) return [{ status: "ok", msg: `max_phantom_processes = ${max}` }];
      return [{
        status: "warn",
        msg: `default limit (${Number.isFinite(max) ? max : 32} phantom processes)`,
        hint: sdk >= 34
          ? "the user can turn off 'Disable child process restrictions' in Developer options if such apps get killed"
          : "apps that start many processes get killed; the user (not the agent) can raise it: device_config put activity_manager max_phantom_processes 2147483647 (plus device_config set_sync_disabled_for_tests persistent)",
      }];
    },
  },

  wireless: {
    help: "wireless  wireless debugging state and port",
    cmds: () => ({ on: "settings get global adb_wifi_enabled 2>/dev/null", port: "getprop service.adb.tls.port" }),
    evaluate(s) {
      if (s.on.trim() !== "1") return [{ status: "info", msg: "wireless debugging is off (USB only)" }];
      return [{ status: "ok", msg: `wireless debugging on${s.port.trim() ? `, TLS port ${s.port.trim()}` : ""}` }];
    },
  },

  app: {
    help: "app:<package>  installed, version, running for how long, and starts/crashes/ANRs/kills in the event log (crash loops)",
    needsValue: true,
    cmds: spec => {
      const p = spec.value;
      if (!isPackageName(p)) throw new CliError(`doctor: app needs a package name, e.g. app:com.example.app (got "${p}")`);
      return {
        path: `pm path ${q(p)} 2>/dev/null | head -1`,
        ver: `dumpsys package ${q(p)} 2>/dev/null | grep -m1 versionName`,
        up: `for x in $(pidof ${q(p)}); do ps -o ETIME= -p $x; done`,
        ev: `logcat -d -b events 2>/dev/null | grep -F ${q(p)} | grep -E 'am_(proc_start|proc_died|crash|anr|kill)'`,
      };
    },
    evaluate(s, spec) {
      const p = spec.value;
      if (!s.path.trim()) return [{ status: "fail", msg: `${p} is not installed` }];
      const ver = (s.ver.split("=")[1] || "?").trim();
      const ups = s.up.split("\n").map(etimeSeconds).filter(Number.isFinite);
      const up = ups.length ? Math.max(...ups) : NaN;
      const e = appEvents(s.ev, p);
      const out = [{ status: "ok", msg: `version ${ver}, ${Number.isFinite(up) ? `running for ${fmtDur(up)}` : "not running"}` }];
      if (e.starts || e.crashes || e.anrs || e.kills)
        out.push({ status: "info", msg: `event log (${e.first} .. ${e.last}): ${e.starts} starts, ${e.died} deaths, ${e.crashes} crashes, ${e.anrs} ANRs, ${e.kills} kills` });
      if (e.starts >= 3 && Number.isFinite(up) && up < 120)
        out.push({ status: "warn", msg: `restarted ${e.starts} times and up only ${fmtDur(up)}: looks like a crash loop`, hint: "read handroid logcat for this package; a reboot often clears a crash-looping system service" });
      if (e.crashes) out.push({ status: "warn", msg: `last crash: ${e.lastCrash}` });
      if (e.anrs) out.push({ status: "warn", msg: `${e.anrs} ANR(s) (app not responding)` });
      if (e.kills && e.lastKill) out.push({ status: "info", msg: `last kill: ${e.lastKill}` });
      return out;
    },
  },

  perms: {
    help: "perms:<device dir>  files an app may not be able to read (not owner+group readable), e.g. after adb push into Android/data",
    needsValue: true,
    cmds: spec => {
      const d = spec.value;
      if (!d.startsWith("/")) throw new CliError(`doctor: perms needs an absolute device path, e.g. perms:/sdcard/Android/data/<pkg>/files (got "${d}")`);
      return {
        n: `find ${q(d)} -type f 2>/dev/null | wc -l`,
        bad: `find ${q(d)} -type f ! -perm -440 2>/dev/null | head -20`,
        exists: `[ -d ${q(d)} ] && echo yes`,
      };
    },
    evaluate(s, spec) {
      if (s.exists.trim() !== "yes") return [{ status: "fail", msg: `${spec.value} does not exist` }];
      const bad = s.bad.split("\n").map(x => x.trim()).filter(Boolean);
      const n = Number(s.n.trim()) || 0;
      if (!bad.length) return [{ status: "ok", msg: `${n} files, all owner+group readable` }];
      return [{ status: "warn", msg: `${bad.length}${bad.length === 20 ? "+" : ""} of ${n} files not owner+group readable, e.g. ${bad[0]}`, hint: "chmod 660 them (handroid push does this for Android/data)" }];
    },
  },
};

export const DEFAULT_CHECKS = ["storage", "memory", "thermals", "battery", "phantom", "wireless"];

/** Validate specs and build the single shell script: { plan: [{spec, check, keys}], script } */
export function planChecks(specs) {
  const list = (specs.length ? specs : DEFAULT_CHECKS).map(parseCheckSpec);
  const plan = [];
  const cmds = {};
  list.forEach((spec, i) => {
    const check = CHECKS[spec.name];
    if (!check) throw new CliError(`doctor: unknown check "${spec.name}". Checks: ${Object.keys(CHECKS).join(", ")}`);
    if (check.needsValue && !spec.value) throw new CliError(`doctor: "${spec.name}" needs a value: ${check.help.split("  ")[0]}`);
    const keys = {};
    for (const [k, cmd] of Object.entries(check.cmds(spec))) { keys[k] = `c${i}_${k}`; cmds[keys[k]] = cmd; }
    plan.push({ spec, check, keys });
  });
  return { plan, cmds };
}

/** Evaluate every planned check against the parsed sections. */
export function runChecks(plan, sections) {
  return plan.map(({ spec, check, keys }) => {
    const s = {};
    for (const [k, key] of Object.entries(keys)) s[k] = sections[key] ?? "";
    const label = spec.value && !spec.value.includes("=") ? `${spec.name}:${spec.value}` : spec.name;
    return { check: label, results: check.evaluate(s, spec) };
  });
}

const RANK = { ok: 0, info: 0, warn: 1, fail: 2 };
export const worst = report => Math.max(0, ...report.flatMap(r => r.results.map(x => RANK[x.status] ?? 0)));

export function formatReport(report) {
  const lines = [];
  const w = Math.max(8, ...report.map(r => r.check.length));
  for (const r of report) for (const x of r.results) {
    lines.push(`[${x.status}]`.padEnd(7) + ` ${r.check.padEnd(w)}  ${x.msg}`);
    if (x.hint) lines.push(`${" ".repeat(w + 10)}-> ${x.hint}`);
  }
  return lines.join("\n");
}

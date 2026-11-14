import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = path.join(ROOT, "test", "fixtures");
export const CLI = path.join(ROOT, "bin", "android-use.mjs");
export const FAKE_ADB = path.join(ROOT, "test", "fake-adb.mjs");

export const fixture = name => fs.readFileSync(path.join(FIXTURES, name), "utf8");

export const INT64_MAX = "9223372036854775807";
export const PERIOD_120HZ = 8333333;

/**
 * Build a `dumpsys SurfaceFlinger --latency` dump like the device prints it:
 * refresh period, then exactly 127 rows (oldest first). `presents` are actual-present times (ns);
 * missing rows are "0 0 0" at the top; `pending` adds that many INT64_MAX rows at the end.
 */
export function latencyDump(presents, { period = PERIOD_120HZ, pending = 0, sep = "\t" } = {}) {
  const rows = presents.slice(-(127 - pending)).map(t => [t - 4_000_000, t, t - 2_000_000].join(sep));
  for (let i = 0; i < pending; i++) rows.push([INT64_MAX, INT64_MAX, INT64_MAX].join(sep));
  while (rows.length < 127) rows.unshift(["0", "0", "0"].join(sep));
  return `${period}\n${rows.join("\n")}\n`;
}

/** Steady frame stream: `count` presents every `intervalMs`, starting at `start` ns. */
export function stream(start, count, intervalMs) {
  return Array.from({ length: count }, (_, i) => Math.round(start + i * intervalMs * 1e6));
}

/**
 * Simulate the on-device sampler: every `everyMs`, take the last 127 presents (from `all`) that
 * are <= the sample time. Returns arrays of timestamps, one per sample.
 */
export function sampleWindows(all, startNs, count, everyMs = 400) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const now = startNs + i * everyMs * 1e6;
    out.push(all.filter(t => t <= now).slice(-127));
  }
  return out;
}

/** Make a scratch dir for one test. */
export function tmpDir(prefix = "android-use-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Run the CLI against the fake adb.
 * `rules`: [{ args: "<regex on the space-joined argv>", stdout?, stdoutFile?, stderr?, status? }]
 * Returns { code, stdout, stderr, calls } where calls = argv arrays the fake adb received.
 */
export function runCli(argv, { rules = [], env = {}, cwd } = {}) {
  const dir = tmpDir();
  const scenario = path.join(dir, "scenario.json");
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(scenario, JSON.stringify({ fixtures: FIXTURES, rules }));
  const cleanEnv = { ...process.env };
  for (const k of ["ANDROID_SERIAL", "ANDROID_HOME", "ANDROID_SDK_ROOT", "ADB", "MSYS_NO_PATHCONV"]) delete cleanEnv[k];
  const r = spawnSync(process.execPath, [CLI, ...argv], {
    cwd: cwd || dir,
    encoding: "utf8",
    env: { ...cleanEnv, ADB: FAKE_ADB, FAKE_ADB_SCENARIO: scenario, FAKE_ADB_LOG: log, ...env },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

/** Rules for a single ready device ABC123XYZ. */
export const singleDevice = [{ args: "^devices -l$", stdoutFile: "devices-single.txt" }];

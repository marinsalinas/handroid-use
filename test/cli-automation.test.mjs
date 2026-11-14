// End-to-end tests for seq, wait-for, launch --display, logcat, doctor, bench and fps --json.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { benchSummary } from "../lib/cli.mjs";
import { fixture, latencyDump, runCli, sampleWindows, singleDevice, stream, tmpDir } from "./helpers.mjs";

const S = "ABC123XYZ";
const has = (calls, argv) => calls.some(c => JSON.stringify(c) === JSON.stringify(argv));
const ctxRule = { args: "shell echo '@@dinfo'", stdoutFile: "display-context-thor.txt" };
const uiRule = { args: `^-s ${S} exec-out uiautomator dump /dev/tty$`, stdoutFile: "ui-settings.xml" };
const thermalsRule = {
  args: "shell echo '@@zones'",
  stdout: `@@zones\r\n${fixture("thermal-zones.txt")}@@current\r\n-1250000\r\n@@capacity\r\n87\r\n@@status\r\nDischarging\r\n`,
};
const T0 = 512_345_678_901_234;
const layerRule = { args: "shell echo '@@layers'", stdout: `@@layers\n${fixture("layers-game.txt")}@@focus\n${fixture("focus-droiddeck.txt")}` };
const thorActs = fixture("display-context-thor.txt").split("@@acts\n")[1].split("@@wake")[0];

test("seq: validated steps run in one adb shell call", () => {
  const r = runCli(["seq", "tap 1610 780", "sleep 0.5", "tap 1614 837", "key back", "swipe 1 2 3 4", "--display", "4"],
    { rules: [...singleDevice, ctxRule, { args: "shell input -d 4 tap", stdout: "" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(has(r.calls, ["-s", S, "shell", "input -d 4 tap 1610 780 && sleep 0.5 && input -d 4 tap 1614 837 && input -d 4 keyevent KEYCODE_BACK && input -d 4 swipe 1 2 3 4 300"]), JSON.stringify(r.calls));
  assert.equal(r.stdout.trim(), "ok (5 steps on display 4)");
  for (const bad of [["seq"], ["seq", "tap 1"], ["seq", "rm -rf /"], ["seq", "sleep 31"], ["seq", "key BACK;reboot"]]) {
    const b = runCli(bad, { rules: singleDevice });
    assert.equal(b.code, 1, bad.join(" "));
    assert.ok(!b.calls.some(c => c[2] === "shell"), bad.join(" "));
  }
});

test("wait-for: succeeds when the condition holds, times out with exit 1", () => {
  let r = runCli(["wait-for", "awake"], { rules: [...singleDevice, { args: "mWakefulness", stdout: "  mWakefulness=Awake\n" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ok after \d+\.\d s$/m);
  r = runCli(["wait-for", "awake", "--timeout", "1"], { rules: [...singleDevice, { args: "mWakefulness", stdout: "  mWakefulness=Asleep\n" }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /timed out after 1 s waiting for awake/);
  r = runCli(["wait-for", "app", "rip.moth.cocoonshell", "--display", "4"],
    { rules: [...singleDevice, ctxRule, { args: "shell echo '@@focus'", stdout: `@@focus\n@@acts\n${thorActs}` }] });
  assert.equal(r.code, 0, r.stderr);
  r = runCli(["wait-for", "text", "Battery"], { rules: [...singleDevice, uiRule] });
  assert.equal(r.code, 0, r.stderr);
  for (const bad of [["wait-for"], ["wait-for", "text"], ["wait-for", "app", "x;y"], ["wait-for", "awake", "--timeout", "0"]])
    assert.equal(runCli(bad, { rules: singleDevice }).code, 1, bad.join(" "));
});

test("launch --display resolves the launcher activity and uses am start --display", () => {
  const rules = [...singleDevice, ctxRule,
    { args: "resolve-activity", stdout: "priority=0 preferredOrder=0 match=0x108000\ncom.android.settings/.Settings\n" },
    { args: "am start --display 4 -n 'com.android.settings/.Settings'", stdout: "Starting: Intent { cmp=com.android.settings/.Settings }\n" }];
  const r = runCli(["launch", "com.android.settings", "--display", "4"], { rules });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "launched com.android.settings/.Settings on display 4");
  const missing = runCli(["launch", "com.not.there", "--display", "4"], { rules: [...singleDevice, ctxRule, { args: "resolve-activity", stdout: "No activity found\n" }] });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /could not launch com\.not\.there/);
});

test("logcat: running app by pid; otherwise the crash buffer filtered to the package", () => {
  let r = runCli(["logcat", "com.x", "50"], { rules: [...singleDevice, { args: "pidof", stdout: "4242\n" }, { args: "logcat -d --pid=4242 [|] tail -n 50", stdout: "line a\nline b\n" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.replace(/\r/g, ""), "# com.x (pid 4242), last 50 lines\nline a\nline b\n");
  const crash = [
    "11-13 21:20:56.449 16849 16849 E AndroidRuntime: FATAL EXCEPTION: main",
    "11-13 21:20:56.449 16849 16849 E AndroidRuntime: Process: com.x, PID: 16849",
    "11-13 21:20:56.449 16849 16849 E AndroidRuntime: java.lang.NoSuchMethodError: boom",
    "11-13 22:00:00.000 17000 17000 E AndroidRuntime: Process: com.other, PID: 17000",
  ].join("\n");
  r = runCli(["logcat", "com.x"], { rules: [...singleDevice, { args: "pidof", stdout: "" }, { args: "logcat -d -b crash -t 200", stdout: crash }] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /# crash buffer for com\.x \(not running\)/);
  assert.match(r.stdout, /NoSuchMethodError/);
  assert.doesNotMatch(r.stdout, /com\.other/);
  assert.equal(runCli(["logcat", "com.x", "0"], { rules: singleDevice }).code, 1);
});

test("doctor: chosen checks in one round trip; exit 1 on fail, --strict also on warn; --json", () => {
  const dumps = "@@c0_path\npackage:/data/app/base.apk\n@@c0_ver\n    versionName=0.2.7a\n@@c0_up\n14:02:03\n@@c0_ev\n@@c1_df\n/dev/block/dm-14 487651696 426605640  60914984  88% /data\n";
  const rules = [...singleDevice, { args: "shell echo '@@c0_path'", stdout: dumps }];
  let r = runCli(["doctor", "app:xyz.example.keymapper", "storage:85"], { rules });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^\[ok\] +app:xyz\.example\.keymapper +version 0\.2\.7a, running for 14\.0 h$/m);
  assert.match(r.stdout, /^\[warn\] +storage:85 +88% used, 58\.1 GB free$/m);
  assert.equal(r.calls.filter(c => c[2] === "shell").length, 1, "one adb round trip");
  r = runCli(["doctor", "app:xyz.example.keymapper", "storage:85", "--strict"], { rules });
  assert.equal(r.code, 1);
  r = runCli(["doctor", "app:xyz.example.keymapper", "storage:85", "--json"], { rules });
  assert.deepEqual(JSON.parse(r.stdout).map(x => x.check), ["app:xyz.example.keymapper", "storage:85"]);
  r = runCli(["doctor", "app:com.gone"], { rules: [...singleDevice, { args: "shell echo '@@c0_path'", stdout: "@@c0_path\n@@c0_ver\n@@c0_up\n@@c0_ev\n" }] });
  assert.equal(r.code, 1);
  r = runCli(["doctor", "bogus"], { rules: singleDevice });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0, "validated before touching the device");
  r = runCli(["doctor", "--list"], { rules: singleDevice });
  assert.match(r.stdout, /app:<package>/);
});

test("fps --json and bench (one interval) with CSV", () => {
  const windows = sampleWindows(stream(T0, 600, 1000 / 120), T0 + 50e6, 14);
  const sampled = windows.map(w => latencyDump(w, { pending: 1 }) + "---\n").join("");
  const rules = [...singleDevice, layerRule, { args: "date .%s", stdout: sampled }, thermalsRule];
  let r = runCli(["fps", "droiddeck", "5", "--json"], { rules });
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.stats.avgFps, 120);
  assert.equal(j.stats.frameTimes, undefined);
  assert.equal(j.temps.cpu, 39.6);
  assert.equal(j.batteryMa, 1250);
  const dir = tmpDir();
  const csv = path.join(dir, "bench.csv");
  r = runCli(["bench", "droiddeck", "0.01", "--interval", "2", "--csv", csv], { rules });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ +\d+ +120 +120 +\d+ +0 +39\.6 +36\.4 +28 +1250 +87$/m);
  assert.match(r.stdout, /^overall: 120 fps avg, 1% low 120 \| max CPU 39\.6 C/m);
  assert.equal(fs.readFileSync(csv, "utf8").split("\n")[0], "t,fps,low1,worstMs,hitches,cpu,gpu,battery,ma,level");
  fs.rmSync(dir, { recursive: true, force: true });
  for (const bad of [["bench"], ["bench", "x", "0"], ["bench", "x", "1", "--interval", "1"]])
    assert.equal(runCli(bad, { rules: singleDevice }).code, 1, bad.join(" "));
});

test("benchSummary: whole-run numbers and throttling verdict", () => {
  const rows = [120, 118, 119, 100, 95, 90].map((fps, i) => ({ t: i * 10, fps, cpu: 60 + i * 4, gpu: 50 + i, battery: 30, level: 100 - i }));
  const s = benchSummary(rows, Array(600).fill(1000 / 110));
  assert.equal(s.avgFps, 110);
  assert.equal(s.firstThirdFps, 119);
  assert.equal(s.lastThirdFps, 92.5);
  assert.equal(s.throttling, true);
  assert.equal(s.maxCpu, 80);
  assert.equal(s.batteryUsed, 5);
  assert.match(s.text, /dropped 22\.3%, likely thermal throttling/);
  assert.equal(benchSummary([{ t: 1, fps: 0, cpu: 40 }], []).avgFps, undefined);
});

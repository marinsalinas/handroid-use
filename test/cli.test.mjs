// End-to-end tests: run bin/handroid.mjs with ADB pointing at test/fake-adb.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FIXTURES, fixture, latencyDump, runCli, sampleWindows, singleDevice, stream, tmpDir } from "./helpers.mjs";

const S = "ABC123XYZ";
const shellCalls = calls => calls.filter(c => c[2] === "shell" || c[2] === "exec-out" || c[2] === "push" || c[2] === "install" || c[2] === "pull");
const has = (calls, argv) => calls.some(c => JSON.stringify(c) === JSON.stringify(argv));

const discoverRules = [
  { args: `^-s ${S} shell echo '@@manufacturer'`, stdoutFile: "device-info-thor.txt" },
  { args: "^mdns services$", stdoutFile: "mdns-services.txt" },
];

const thermalsRule = {
  args: "shell echo '@@zones'",
  stdout: `@@zones\r\n${fixture("thermal-zones.txt")}@@current\r\n-1250000\r\n@@capacity\r\n87\r\n@@status\r\nDischarging\r\n`,
};

// ---------- discovery ----------

test("discover: human-readable summary of the device and LAN services", () => {
  const r = runCli(["discover"], { rules: [...singleDevice, ...discoverRules] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ABC123XYZ {2}\[device, usb\]$/m);
  assert.match(r.stdout, /^ {2}AYN AYN Thor {2}- {2}Android 13 \(SDK 33\), arm64-v8a$/m);
  assert.match(r.stdout, /^ {2}SoC: QTI QCS8550 {3}GPU: Adreno \(TM\) 740$/m);
  assert.match(r.stdout, /screen: 1080x1920 {2}\(2 displays: use shot --display <id>\) {3}battery: 100% {3}free: 49G/);
  assert.match(r.stdout, /On the network \(wireless debugging\), not connected:/);
  assert.match(r.stdout, /192\.168\.1\.60:5555 +-> handroid connect 192\.168\.1\.60:5555/);
  assert.match(r.stdout, /192\.168\.1\.80:39001 +pairing code shown on the device -> handroid pair 192\.168\.1\.80:39001 <code>/);
  assert.doesNotMatch(r.stdout, /192\.168\.1\.40/, "the USB-connected device's own TLS service is hidden");
  assert.equal(r.calls.length, 3, "one adb round trip per device");
});

test("discover --json: machine-readable output", () => {
  const r = runCli(["discover", "--json"], { rules: [...singleDevice, ...discoverRules] });
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.match(j.adb, /fake-adb\.mjs$/);
  assert.equal(j.devices.length, 1);
  assert.deepEqual(
    { serial: j.devices[0].serial, model: j.devices[0].model, soc: j.devices[0].soc, gpu: j.devices[0].gpu, displays: j.devices[0].displays, transport: j.devices[0].transport },
    { serial: S, model: "AYN Thor", soc: "QTI QCS8550", gpu: "Adreno (TM) 740", displays: 2, transport: "usb" });
  assert.deepEqual(j.lan.map(l => l.address), ["192.168.1.60:5555", "192.168.1.70:41234", "192.168.1.80:39001"]);
});

test("discover: unauthorized device shows the hint and is not queried", () => {
  const r = runCli(["discover"], { rules: [{ args: "^devices -l$", stdoutFile: "devices-unauthorized.txt" }, { args: "^mdns services$", stdout: "" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ABC123XYZ {2}\[unauthorized, usb\]\n {2}-> unlock the device and accept the 'Allow USB debugging' prompt/);
  assert.equal(shellCalls(r.calls).length, 0);
});

test("discover: no devices", () => {
  const r = runCli(["discover"], { rules: [{ args: "^devices -l$", stdoutFile: "devices-empty.txt" }, { args: "^mdns services$", stdout: "" }] });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /No devices connected over adb\./);
});

test("discover: several devices adds the --serial reminder", () => {
  const r = runCli(["discover"], { rules: [
    { args: "^devices -l$", stdoutFile: "devices-multi.txt" },
    { args: "^-s \\S+ shell echo '@@manufacturer'", stdoutFile: "device-info-thor.txt" },
    { args: "^mdns services$", stdoutFile: "mdns-services.txt" },
  ] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /192\.168\.1\.50:5555 {2}\[device, wifi\]/);
  assert.match(r.stdout, /Several devices: pass --serial <id>/);
});

// ---------- device selection ----------

test("several devices without --serial: helpful error, nonzero exit, nothing run", () => {
  const r = runCli(["status"], { rules: [{ args: "^devices -l$", stdoutFile: "devices-multi.txt" }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Several devices: ABC123XYZ, 192\.168\.1\.50:5555, adb-DEF456UVW-Ab1Cd2\._adb-tls-connect\._tcp\. Pick one with --serial <id> or ANDROID_SERIAL\./);
  assert.equal(shellCalls(r.calls).length, 0);
});

test("--serial and ANDROID_SERIAL pick one of several devices", () => {
  const rules = [
    { args: "^devices -l$", stdoutFile: "devices-multi.txt" },
    { args: "^-s 192\\.168\\.1\\.50:5555 shell dumpsys SurfaceFlinger --display-id$", stdout: "Display 0 (HWC display 0): port=0\n" },
  ];
  let r = runCli(["--serial", "192.168.1.50:5555", "displays"], { rules });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "Display 0 (HWC display 0): port=0");
  r = runCli(["displays"], { rules, env: { ANDROID_SERIAL: "192.168.1.50:5555" } });
  assert.equal(r.code, 0, r.stderr);
});

test("--serial for a device that is not connected fails", () => {
  const r = runCli(["--serial", "NOPE", "status"], { rules: singleDevice });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Device "NOPE" not found\. Connected: ABC123XYZ/);
});

test("unauthorized device: hint and nonzero exit", () => {
  const r = runCli(["status"], { rules: [{ args: "^devices -l$", stdoutFile: "devices-unauthorized.txt" }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No ready device\. Seen: ABC123XYZ \(unauthorized\)\. Fix: unlock the device and accept the 'Allow USB debugging' prompt/);
});

test("adb client errors (device vanished mid-command) fail instead of printing empty data", () => {
  const r = runCli(["displays"], { rules: [...singleDevice, { args: "shell", stderr: "adb: device 'ABC123XYZ' not found\n", status: 1 }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /device 'ABC123XYZ' not found/);
});

// ---------- status / ui / tap ----------

test("status", () => {
  const r = runCli(["status"], { rules: [...singleDevice, { args: `^-s ${S} shell echo '@@model'`, stdout:
    "@@model\r\nAYN Thor\r\n@@release\r\n13\r\n@@focus\r\n  mCurrentFocus=Window{4f2a1c u0 com.android.settings/com.android.settings.Settings}\r\n" +
    "@@wake\r\n  mWakefulness=Awake\r\n@@capacity\r\n87\r\n@@bstatus\r\nDischarging\r\n@@df\r\n/dev/fuse       465G 416G   49G  90% /storage/emulated\r\n" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.replace(/\r/g, ""), [
    "device:   ABC123XYZ AYN Thor (Android 13)",
    "screen:   Awake",
    "focus:    com.android.settings/com.android.settings.Settings",
    "battery:  87% Discharging",
    "storage:  49G free of 465G (90% used)", ""].join("\n"));
});

test("status: TV without battery or shared storage", () => {
  const r = runCli(["status"], { rules: [...singleDevice, { args: "shell echo '@@model'", stdout:
    "@@model\nBRAVIA 4K\n@@release\n10\n@@focus\n  mCurrentFocus=null\n@@wake\n  mWakefulness=Asleep\n@@capacity\n@@bstatus\n@@df\n" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /focus: {4}none/);
  assert.doesNotMatch(r.stdout, /battery|storage/);
});

const uiRule = { args: `^-s ${S} exec-out uiautomator dump /dev/tty$`, stdoutFile: "ui-settings.xml" };

test("ui: compact tree of nodes with text or description", () => {
  const r = runCli(["ui"], { rules: [...singleDevice, uiRule] });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trimEnd().split(/\r?\n/);
  assert.equal(lines.length, 9);
  assert.equal(lines[0], `${"Settings".padEnd(38)} ${"".padEnd(24)}       234,160`);
  assert.match(r.stdout, /Search settings {10}\[tap\] 540,300/);
  assert.match(r.stdout, /Network & internet/);
  const all = runCli(["ui", "--all"], { rules: [...singleDevice, uiRule] });
  assert.equal(all.stdout.trimEnd().split(/\r?\n/).length, 11);
});

test("ui: uiautomator failure is an error", () => {
  const r = runCli(["ui"], { rules: [...singleDevice, { args: "exec-out uiautomator", stdoutFile: "ui-error.txt" }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /uiautomator dump failed: ERROR: could not get idle state/);
});

test('tap "<text>" taps the centre of the matching node', () => {
  const rules = [...singleDevice, uiRule, { args: `^-s ${S} shell input tap \\d+ \\d+$`, stdout: "" }];
  let r = runCli(["tap", "Battery"], { rules });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(has(r.calls, ["-s", S, "shell", "input", "tap", "540", "660"]), JSON.stringify(r.calls));
  assert.match(r.stdout, /tap "Battery" at 540,660/);
  r = runCli(["tap", "search", "settings"], { rules });
  assert.ok(has(r.calls, ["-s", S, "shell", "input", "tap", "540", "300"]));
});

test("tap <x> <y>", () => {
  const r = runCli(["tap", "100", "200"], { rules: [...singleDevice, { args: "shell input tap 100 200$", stdout: "" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(has(r.calls, ["-s", S, "shell", "input", "tap", "100", "200"]));
  assert.equal(r.stdout.trim(), "tap 100,200");
});

test("tap: unknown text fails without tapping", () => {
  const r = runCli(["tap", "Nonexistent button"], { rules: [...singleDevice, uiRule] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /"Nonexistent button" not found in the UI tree/);
  assert.ok(!r.calls.some(c => c.includes("input")));
});

// ---------- input ----------

test("type: text is quoted for the device shell", () => {
  const r = runCli(["type", "it's #1 (ok)?"], { rules: [...singleDevice, { args: "shell input text", stdout: "" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(has(r.calls, ["-s", S, "shell", "input", "text", "'it'\\''s%s#1%s(ok)?'"]), JSON.stringify(r.calls));
});

test("type -- --literal", () => {
  const r = runCli(["type", "--", "--literal"], { rules: [...singleDevice, { args: "shell input text", stdout: "" }] });
  assert.ok(has(r.calls, ["-s", S, "shell", "input", "text", "'--literal'"]));
});

test("key, swipe and launch validate their arguments before touching the device", () => {
  for (const argv of [["key", "BACK; reboot"], ["swipe", "1", "2", "3", "x"], ["launch", "com.x; reboot"], ["key"], ["tap"]]) {
    const r = runCli(argv, { rules: singleDevice });
    assert.equal(r.code, 1, argv.join(" "));
    assert.match(r.stderr, /usage:/);
    assert.ok(!r.calls.some(c => c.includes("shell")), argv.join(" "));
  }
});

test("key and launch", () => {
  let r = runCli(["key", "back"], { rules: [...singleDevice, { args: "shell input keyevent KEYCODE_BACK$", stdout: "" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "key KEYCODE_BACK");
  r = runCli(["launch", "com.not.there"], { rules: [...singleDevice, { args: "shell monkey", stdout: "  bash arg: -p\n** No activities found to run, monkey aborted.\n", status: 252 }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not launch com\.not\.there/);
});

// ---------- files ----------

function apk(dir, content = "fake apk bytes") {
  const f = path.join(dir, "app.apk");
  fs.writeFileSync(f, content);
  return { f, hash: createHash("sha256").update(content).digest("hex") };
}

test("install --sha256 mismatch refuses to install", () => {
  const dir = tmpDir();
  const { f } = apk(dir);
  const r = runCli(["install", f, "--sha256", "0".repeat(64)], { rules: [...singleDevice, { args: "install", stdout: "Success\n" }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HASH MISMATCH: not installing/);
  assert.ok(!r.calls.some(c => c.includes("install")), "adb install must not run");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("install with matching sha256 (any case, sha256: prefix) installs", () => {
  const dir = tmpDir();
  const { f, hash } = apk(dir);
  const r = runCli(["install", f, `--sha256=sha256:${hash.toUpperCase()}`], { rules: [...singleDevice, { args: `^-s ${S} install -r `, stdout: "Performing Streamed Install\nSuccess\n" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`sha256 ${hash}`));
  assert.ok(r.calls.some(c => c[2] === "install" && c[3] === "-r" && c[4] === path.resolve(f)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("install: adb failure and missing file give nonzero exit", () => {
  const dir = tmpDir();
  const { f } = apk(dir);
  let r = runCli(["install", f], { rules: [...singleDevice, { args: "install", stdout: "Performing Streamed Install\n", stderr: "adb: failed to install app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]\n", status: 1 }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /install failed/);
  r = runCli(["install", path.join(dir, "missing.apk")], { rules: singleDevice });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not exist/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
  fs.rmSync(dir, { recursive: true, force: true });
});

const pushRules = (deviceHash, extra = []) => [
  ...singleDevice,
  { args: `^-s ${S} push `, stdout: "app.apk: 1 file pushed, 0 skipped.\n" },
  { args: "shell \\[ -d ", stdout: "", status: 1 },
  { args: "shell sha256sum ", stdout: deviceHash },
  ...extra,
];

test("push: hash mismatch on the device -> nonzero exit", () => {
  const dir = tmpDir();
  const { f } = apk(dir);
  const r = runCli(["push", f, "/sdcard/Download/app.apk"], { rules: pushRules(`${"f".repeat(64)}  /sdcard/Download/app.apk\n`) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HASH MISMATCH local=[0-9a-f]{64} device=f{64}/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("push: verified copy; Android/data gets sync + chmod 660", () => {
  const dir = tmpDir();
  const { f, hash } = apk(dir);
  const remote = "/sdcard/Android/data/com.example.emu/files/app.apk";
  const r = runCli(["push", f, remote], { rules: pushRules(`${hash}  ${remote}\n`, [{ args: "shell sync; chmod 660 ", stdout: "" }]) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`verified sha256 ${hash} -> ${remote}`));
  assert.ok(has(r.calls, ["-s", S, "shell", `sync; chmod 660 '${remote}'`]));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("push into a directory verifies <dir>/<basename>", () => {
  const dir = tmpDir();
  const { f, hash } = apk(dir);
  const r = runCli(["push", f, "/sdcard/Download/"], { rules: [
    ...singleDevice,
    { args: "push ", stdout: "1 file pushed\n" },
    { args: "shell \\[ -d ", stdout: "dir\n" },
    { args: "shell sha256sum '/sdcard/Download/app.apk'", stdout: `${hash}  /sdcard/Download/app.apk\n` },
  ] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /-> \/sdcard\/Download\/app\.apk/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("push: no sha256sum on the device is 'could not verify', not a false mismatch", () => {
  const dir = tmpDir();
  const { f } = apk(dir);
  const r = runCli(["push", f, "/sdcard/app.apk"], { rules: pushRules("/system/bin/sh: sha256sum: not found\n") });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not verify the copy on the device: \/system\/bin\/sh: sha256sum: not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("push/pull refuse Windows-style device paths (Git Bash path conversion)", () => {
  const dir = tmpDir();
  const { f } = apk(dir);
  let r = runCli(["push", f, "C:/Program Files/Git/sdcard/app.apk"], { rules: singleDevice });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /MSYS_NO_PATHCONV=1/);
  assert.ok(!r.calls.some(c => c.includes("push")));
  r = runCli(["pull", "C:\\sdcard\\x"], { rules: singleDevice });
  assert.equal(r.code, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pull: adb failure is a nonzero exit", () => {
  const r = runCli(["pull", "/sdcard/missing.txt"], { rules: [...singleDevice, { args: "pull", stderr: "adb: error: failed to stat remote object '/sdcard/missing.txt': No such file or directory\n", status: 1 }] });
  assert.equal(r.code, 1);
});

// ---------- screenshot ----------

test("shot: writes the PNG and prints its path; --display is passed through", () => {
  const dir = tmpDir();
  const out = path.join(dir, "screen.png");
  const r = runCli(["shot", out, "--display", "4619827259835644675"], { rules: [...singleDevice, { args: `^-s ${S} exec-out screencap -d 4619827259835644675 -p$`, stdoutFile: "screencap.png" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), out);
  assert.deepEqual(fs.readFileSync(out), fs.readFileSync(path.join(FIXTURES, "screencap.png")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("shot: failure and bad --display", () => {
  let r = runCli(["shot"], { rules: [...singleDevice, { args: "exec-out screencap", stderr: "Capturing failed.\n", status: 1 }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /screencap failed: Capturing failed/);
  r = runCli(["shot", "--display", "top"], { rules: singleDevice });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /numeric display id/);
});

// ---------- apps / thermals / fps ----------

test("apps: sorted third-party packages with versions, filtered", () => {
  const rules = [...singleDevice,
    { args: "shell pm list packages -3$", stdout: "package:org.example.zeta\r\npackage:com.droiddeck.launcher\r\npackage:com.example.alpha\r\n" },
    { args: "shell echo '@@com.droiddeck.launcher'; dumpsys package com.droiddeck.launcher \\| grep -m1 versionName; echo '@@com.example.alpha'", stdout:
      "@@com.droiddeck.launcher\r\n    versionName=0.7.1\r\n@@com.example.alpha\r\n    versionName=2.0\r\n@@org.example.zeta\r\n" }];
  let r = runCli(["apps"], { rules });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.replace(/\r/g, ""), "com.droiddeck.launcher 0.7.1\ncom.example.alpha 2.0\norg.example.zeta \n");
  r = runCli(["apps", "droiddeck"], { rules: [...rules.slice(0, 2), { args: "shell echo '@@com.droiddeck.launcher'; dumpsys package com.droiddeck.launcher \\| grep -m1 versionName$", stdout: "@@com.droiddeck.launcher\n    versionName=0.7.1\n" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "com.droiddeck.launcher 0.7.1");
});

test("thermals", () => {
  const r = runCli(["thermals"], { rules: [...singleDevice, thermalsRule] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), "temps: CPU 39.6 C | GPU 36.4 C | battery 28.0 C | battery 87% Discharging, 1250 mA");
});

const T0 = 512_345_678_901_234;
const layerRule = { args: "shell echo '@@layers'", stdout: `@@layers\n${fixture("layers-game.txt")}@@focus\n${fixture("focus-droiddeck.txt")}` };
const BLAST = "SurfaceView[com.droiddeck.launcher/com.droiddeck.launcher.SessionActivity](BLAST)#3303";

test("fps: measures the game's SurfaceView over overlapping samples", () => {
  const windows = sampleWindows(stream(T0, 600, 1000 / 120), T0 + 50e6, 13);
  const sampled = windows.map(w => latencyDump(w, { pending: 1 }) + "---\n").join("");
  const r = runCli(["fps", "droiddeck", "5"], { rules: [...singleDevice, layerRule,
    { args: `shell i=0; while \\[ \\$i -lt 13 \\]; do dumpsys SurfaceFlinger --latency '${BLAST.replace(/[[\]().$]/g, "\\$&")}'`, stdout: sampled },
    thermalsRule] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^layer: ${BLAST.replace(/[[\]().$]/g, "\\$&")}$`, "m"));
  assert.match(r.stdout, /^avg fps: {3}120\.0 /m);
  assert.match(r.stdout, /hitches >50 ms: 0$/m);
  assert.match(r.stdout, /^temps: CPU 39\.6 C/m);
});

test("fps: static screen and missing layer", () => {
  let r = runCli(["fps", "droiddeck", "0.8"], { rules: [...singleDevice, layerRule, { args: "while", stdout: fixture("latency-idle.txt") + "---\n" + fixture("latency-idle.txt") + "---\n" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no new frames \(paused, menu or static screen\?\)/);
  r = runCli(["fps", "com.not.running", "2"], { rules: [...singleDevice, layerRule] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no SurfaceFlinger layer matches "com.not.running"/);
});

test("fps: invalid duration is rejected before touching the device", () => {
  const r = runCli(["fps", "droiddeck", "abc"], { rules: singleDevice });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /seconds must be a number/);
  assert.equal(r.calls.length, 0);
});

// ---------- connect / pair ----------

test("connect and pair report success through the exit code", () => {
  let r = runCli(["connect", "192.168.1.60:5555"], { rules: [{ args: "^connect ", stdout: "connected to 192.168.1.60:5555\n" }] });
  assert.equal(r.code, 0);
  r = runCli(["connect", "192.168.1.60:5555"], { rules: [{ args: "^connect ", stdout: "failed to connect to '192.168.1.60:5555': Connection refused\n" }] });
  assert.equal(r.code, 1);
  r = runCli(["pair", "192.168.1.80:39001", "123456"], { rules: [{ args: "^pair ", stdout: "Successfully paired to 192.168.1.80:39001 [guid=adb-GHI789RST-Qq7Rr6]\n" }] });
  assert.equal(r.code, 0);
  r = runCli(["pair", "192.168.1.80:39001", "000000"], { rules: [{ args: "^pair ", stdout: "Failed: Wrong password or connection was dropped.\n", status: 1 }] });
  assert.equal(r.code, 1);
});

// ---------- help / errors ----------

test("help works without adb; commands need it", () => {
  const missing = path.join(tmpDir(), "no-adb-here");
  let r = runCli(["help"], { env: { ADB: missing } });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: handroid \[--serial <id>\] <command> \[args\]/);
  assert.match(r.stdout, /adb: ADB is set to/);
  r = runCli(["status"], { env: { ADB: missing } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not exist/);
});

test("unknown command exits 1; no command shows help and exits 0", () => {
  let r = runCli(["frobnicate"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown command: frobnicate/);
  r = runCli([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /discover \[--json\]/);
});

// ---------- dual-screen devices ----------

const ctxRule = { args: "shell echo '@@dinfo'", stdoutFile: "display-context-thor.txt" };
const xmlRoot = (pkg, w, h, inner) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="1"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="${pkg}" content-desc="" clickable="false" enabled="true" bounds="[0,0][${w},${h}]">${inner}</node></hierarchy>`;
const node = (text, b, clickable = true) => `<node index="1" text="${text}" resource-id="" class="android.widget.TextView" package="x" content-desc="" clickable="${clickable}" enabled="true" bounds="${b}" />`;

test("displays: table with logical + physical ids, focus and top app; --json", () => {
  let r = runCli(["displays"], { rules: [...singleDevice, ctxRule] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^4 +4619827259835644676 +Screen-2 +1240x1080 +\* +rip\.moth\.cocoonshell/m);
  assert.match(r.stdout, /take --display <id> \(logical or physical\)/);
  r = runCli(["displays", "--json"], { rules: [...singleDevice, ctxRule] });
  const j = JSON.parse(r.stdout);
  assert.equal(j.focused, 4);
  assert.deepEqual(j.displays.map(d => d.id), [0, 4]);
  assert.equal(j.windows, undefined);
});

test("shot --display <logical id> captures with the physical id", () => {
  const dir = tmpDir();
  const out = path.join(dir, "bottom.png");
  const r = runCli(["shot", out, "--display", "4"], { rules: [...singleDevice, ctxRule,
    { args: `^-s ${S} exec-out screencap -d 4619827259835644676 -p$`, stdoutFile: "screencap.png" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), out);
  fs.rmSync(dir, { recursive: true, force: true });
  const bad = runCli(["shot", "--display", "9"], { rules: [...singleDevice, ctxRule] });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /no display "9"/);
});

test("tap/swipe/key/type --display send input to that screen (input -d <logical>)", () => {
  const rules = [...singleDevice, ctxRule, { args: "shell input -d 4 ", stdout: "" }];
  let r = runCli(["tap", "100", "200", "--display", "4619827259835644676"], { rules });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(has(r.calls, ["-s", S, "shell", "input", "-d", "4", "tap", "100", "200"]), JSON.stringify(r.calls));
  assert.equal(r.stdout.trim(), "tap 100,200 on display 4");
  r = runCli(["swipe", "1", "2", "3", "4", "--display", "4"], { rules });
  assert.ok(has(r.calls, ["-s", S, "shell", "input", "-d", "4", "swipe", "1", "2", "3", "4", "300"]));
  r = runCli(["key", "back", "--display", "4"], { rules });
  assert.ok(has(r.calls, ["-s", S, "shell", "input", "-d", "4", "keyevent", "KEYCODE_BACK"]));
  r = runCli(["type", "hi", "--display", "4"], { rules });
  assert.ok(has(r.calls, ["-s", S, "shell", "input", "-d", "4", "text", "'hi'"]));
});

test('ui and tap "text" use the display the UI tree came from, even when another screen has focus', () => {
  const xml = xmlRoot("com.android.settings", 1920, 1080, node("Battery", "[0,560][480,648]"));
  const rules = [...singleDevice, ctxRule, { args: "exec-out uiautomator dump", stdout: xml }, { args: "shell input ", stdout: "" }];
  let r = runCli(["ui"], { rules });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^# display 0 "Built-in Screen" 1920x1080: tap "text" targets this screen; for coordinates add --display 0$/m);
  r = runCli(["tap", "Battery"], { rules });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(has(r.calls, ["-s", S, "shell", "input", "-d", "0", "tap", "240", "604"]), JSON.stringify(r.calls));
  assert.match(r.stdout, /tap "Battery" at 240,604 on display 0/);
  r = runCli(["tap", "Battery", "--display", "4"], { rules });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /use coordinates with --display/);
});

test("ui on a sleeping screen says so instead of uiautomator's idle-state error", () => {
  const asleep = fixture("display-context-thor.txt").replace("mWakefulness=Awake", "mWakefulness=Asleep");
  const r = runCli(["ui"], { rules: [...singleDevice, { args: "shell echo '@@dinfo'", stdout: asleep }, { args: "exec-out uiautomator", stdoutFile: "ui-error.txt" }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /the screen is asleep: run {2}handroid key WAKEUP {2}first/);
});

test("fps ignores frames rendered before the measurement started", () => {
  // An idle menu: the buffer still holds 127 frames from a minute ago, then 3 s of 60 fps.
  const old = stream(T0 - 60e9, 127, 1000 / 120);
  const fresh = stream(T0 + 100e6, 180, 1000 / 60);
  const windows = sampleWindows([...old, ...fresh], T0, 9);
  const sampled = windows.map(w => latencyDump(w) + "---\n").join("");
  const r = runCli(["fps", "droiddeck", "3"], { rules: [...singleDevice, layerRule, { args: "while", stdout: sampled }, thermalsRule] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^avg fps: {3}60\.0 /m);
  assert.match(r.stdout, /hitches >50 ms: 0$/m);
});

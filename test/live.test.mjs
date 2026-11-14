// Read-only smoke test against a real device. Skipped unless ANDROID_USE_LIVE=1.
//   ANDROID_USE_LIVE=1 [ANDROID_SERIAL=<id>] [ANDROID_USE_LIVE_FPS=<package-part>] npm test
// Only commands that do not change device state are allowed here; never add tap/swipe/key/type/
// launch/install/push/pull to this file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CLI, tmpDir } from "./helpers.mjs";

const LIVE = process.env.ANDROID_USE_LIVE === "1";
const READ_ONLY = new Set(["discover", "status", "displays", "apps", "thermals", "ui", "shot", "fps"]);

function cli(...argv) {
  assert.ok(READ_ONLY.has(argv[0]), `live tests must stay read-only (${argv[0]})`);
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8", timeout: 120000 });
  if (process.env.ANDROID_USE_LIVE_VERBOSE) console.log(`$ android-use ${argv.join(" ")}\n${r.stdout}${r.stderr}`);
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("live: read-only smoke test", { skip: !LIVE && "set ANDROID_USE_LIVE=1 to run against a real device" }, async (t) => {
  await t.test("discover --json", () => {
    const r = cli("discover", "--json");
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    const ready = j.devices.filter(d => d.state === "device");
    assert.ok(ready.length >= 1, "no ready device");
    for (const d of ready) assert.ok(d.model && d.android && d.sdk, JSON.stringify(d));
  });
  await t.test("discover", () => assert.equal(cli("discover").code, 0));
  await t.test("status", () => {
    const r = cli("status");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^device: .*\(Android \d/m);
    assert.match(r.stdout, /^screen: {3}\S+/m);
  });
  await t.test("displays", () => {
    const r = cli("displays");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Display \d+/);
  });
  await t.test("apps", () => assert.equal(cli("apps").code, 0));
  await t.test("thermals", () => {
    const r = cli("thermals");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^temps: CPU /);
  });
  await t.test("ui", () => {
    const r = cli("ui");
    // uiautomator can legitimately fail while the screen animates; it must say so on stderr
    assert.ok(r.code === 0 || /uiautomator dump failed/.test(r.stderr), r.stderr);
  });
  await t.test("shot", () => {
    const dir = tmpDir();
    const file = path.join(dir, "live.png");
    const r = cli("shot", file);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(file).readUInt32BE(0), 0x89504e47);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await t.test("fps (3 s)", () => {
    const r = cli("fps", process.env.ANDROID_USE_LIVE_FPS || "systemui", "3");
    // A sleeping screen gives "no new frames"; an absent app gives "no layer". Both are fine here.
    assert.ok(r.code === 0 || /no SurfaceFlinger layer matches/.test(r.stderr), r.stderr);
    if (r.code === 0) assert.match(r.stdout, /^layer: /m);
  });
});

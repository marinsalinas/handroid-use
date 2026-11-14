import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECKS, appEvents, etimeSeconds, formatReport, parseCheckSpec, planChecks, runChecks, worst } from "../lib/doctor.mjs";
import { CliError } from "../lib/errors.mjs";
import { fixture } from "./helpers.mjs";

const ev = (spec, s) => CHECKS[parseCheckSpec(spec).name].evaluate(s, parseCheckSpec(spec));

test("parseCheckSpec: name, value and key=value options", () => {
  assert.deepEqual(parseCheckSpec("storage"), { name: "storage", value: "", opts: {} });
  assert.deepEqual(parseCheckSpec("app:com.x.y"), { name: "app", value: "com.x.y", opts: {} });
  assert.deepEqual(parseCheckSpec("Thermals:cpu=80,GPU=70").opts, { cpu: "80", gpu: "70" });
});

test("etimeSeconds parses ps ETIME", () => {
  assert.equal(etimeSeconds("03:04"), 184);
  assert.equal(etimeSeconds("02:03:04"), 7384);
  assert.equal(etimeSeconds("1-00:00:05"), 86405);
  assert.ok(Number.isNaN(etimeSeconds("")));
});

test("appEvents counts only the package's own events", () => {
  const log = [
    "11-14 10:00:00.100  1  2 I am_proc_start: [0,100,10118,com.example.app,activity,{com.example.app/.Main}]",
    "11-14 10:00:05.100  1  2 I am_crash: [100,0,com.example.app,1,java.lang.IllegalStateException,boom,Main.java,42]",
    "11-14 10:00:05.200  1  2 I am_proc_died: [0,100,com.example.app,900,17]",
    "11-14 10:00:06.100  1  2 I am_proc_start: [0,101,10118,com.example.app:service,service,{x}]",
    "11-14 10:00:07.100  1  2 I am_proc_start: [0,102,10119,com.example.appendix,activity,{x}]",
    "11-14 10:00:08.100  1  2 I am_kill : [0,101,com.example.app,700,stop com.example.app due to from pid 9]",
    "11-14 10:00:09.100  1  2 I am_anr  : [0,101,com.example.app,1,Input dispatching timed out]",
  ].join("\n");
  const e = appEvents(log, "com.example.app");
  assert.deepEqual([e.starts, e.died, e.crashes, e.anrs, e.kills], [2, 1, 1, 1, 1]);
  assert.equal(e.lastCrash, "11-14 10:00:05 java.lang.IllegalStateException: boom");
  assert.equal(e.first, "11-14 10:00:00");
  assert.equal(e.last, "11-14 10:00:09");
});

test("app: not installed fails; crash loop warns", () => {
  assert.equal(ev("app:com.x", { path: "", ver: "", up: "", ev: "" })[0].status, "fail");
  const starts = [1, 2, 3, 4].map(i => `11-14 10:00:0${i}.000  1  2 I am_proc_start: [0,${i},1,com.x,activity,{c}]`).join("\n");
  const r = ev("app:com.x", { path: "package:/data/app/x/base.apk", ver: "    versionName=1.2", up: "00:40", ev: starts });
  assert.equal(r[0].msg, "version 1.2, running for 40 s");
  assert.ok(r.some(x => x.status === "warn" && /crash loop/.test(x.msg)));
  const healthy = ev("app:com.x", { path: "package:/x", ver: "versionName=1", up: "14:02:03", ev: "" });
  assert.deepEqual(healthy.map(x => x.status), ["ok"]);
  assert.match(healthy[0].msg, /running for 14\.0 h/);
});

test("storage, memory, thermals, battery thresholds", () => {
  const df = "/dev/block/dm-14 487651696 426605640  60914984  88% /data";
  assert.equal(ev("storage", { df })[0].status, "ok");
  assert.equal(ev("storage:85", { df })[0].status, "warn");
  assert.equal(ev("storage", { df: df.replace("88%", "98%") })[0].status, "fail");
  assert.match(ev("storage", { df })[0].msg, /88% used, 58\.1 GB free/);
  const mem = "MemTotal:       15621188 kB\nMemAvailable:   10372588 kB\nSwapTotal:       4194300 kB\nSwapFree:        2720564 kB";
  assert.match(ev("memory", { mem })[0].msg, /9\.9 of 14\.9 GB available \(66%\) \| swap 35% used/);
  assert.equal(ev("memory:70", { mem })[0].status, "warn");
  const zones = fixture("thermal-zones.txt");
  assert.equal(ev("thermals", { zones })[0].status, "ok");
  assert.equal(ev("thermals:cpu=30", { zones })[0].status, "warn");
  assert.throws(() => ev("thermals:cpu=hot", { zones }), CliError);
  const bat = "  level: 100\n  status: 5\n  health: 2\n  temperature: 300";
  assert.equal(ev("battery", { bat })[0].msg, "100% full, health good, 30.0 C");
  assert.equal(ev("battery", { bat: bat.replace("health: 2", "health: 3") })[0].status, "fail");
  assert.equal(ev("battery", { bat: "" })[0].status, "info");
});

test("phantom: by Android version and setting", () => {
  assert.equal(ev("phantom", { sdk: "30", max: "", mon: "" })[0].status, "ok");
  assert.equal(ev("phantom", { sdk: "33", max: "null", mon: "null" })[0].status, "warn");
  assert.equal(ev("phantom", { sdk: "33", max: "2147483647", mon: "null" })[0].status, "ok");
  assert.equal(ev("phantom", { sdk: "34", max: "null", mon: "false" })[0].status, "ok");
  assert.match(ev("phantom", { sdk: "34", max: "null", mon: "null" })[0].hint, /Developer options/);
});

test("perms and wireless", () => {
  assert.equal(ev("perms:/sdcard/x", { exists: "", n: "", bad: "" })[0].status, "fail");
  assert.equal(ev("perms:/sdcard/x", { exists: "yes", n: "3", bad: "" })[0].msg, "3 files, all owner+group readable");
  assert.equal(ev("perms:/sdcard/x", { exists: "yes", n: "3", bad: "/sdcard/x/a.bin\n" })[0].status, "warn");
  assert.equal(ev("wireless", { on: "1", port: "45549" })[0].msg, "wireless debugging on, TLS port 45549");
  assert.equal(ev("wireless", { on: "0", port: "" })[0].status, "info");
});

test("planChecks: defaults, validation, one script; runChecks + worst + formatReport", () => {
  assert.equal(planChecks([]).plan.length, 6);
  assert.throws(() => planChecks(["bogus"]), /unknown check "bogus"/);
  assert.throws(() => planChecks(["app"]), /needs a value/);
  assert.throws(() => planChecks(["app:com.x;reboot"]), /package name/);
  assert.throws(() => planChecks(["perms:relative/dir"]), /absolute device path/);
  const { plan, cmds } = planChecks(["app:com.a", "app:com.b"]);
  assert.ok(cmds.c0_path.includes("'com.a'") && cmds.c1_path.includes("'com.b'"), "two apps get separate sections");
  const report = runChecks(plan, { c0_path: "", c1_path: "package:/x", c1_ver: "versionName=2" });
  assert.equal(worst(report), 2);
  assert.match(formatReport(report), /^\[fail\] +app:com\.a +com\.a is not installed$/m);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fmtBytes, listLocal, parseRemoteList, parseSums, planSync, remoteChunkCmds, sha256File, stamp } from "../lib/sync.mjs";
import { runCli, singleDevice, tmpDir } from "./helpers.mjs";

const sha = s => createHash("sha256").update(s).digest("hex");
function tree(files) {
  const dir = tmpDir();
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

test("sha256File streams and matches crypto", () => {
  const dir = tree({ "a.bin": Buffer.alloc(5 * 1024 * 1024, 7) });
  assert.equal(sha256File(path.join(dir, "a.bin")), sha(Buffer.alloc(5 * 1024 * 1024, 7)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("listing, parsing and planning", () => {
  const dir = tree({ "a.txt": "aa", "sub dir/b é.txt": "bbb" });
  assert.deepEqual([...listLocal(dir)], [["a.txt", 2], ["sub dir/b é.txt", 3]]);
  fs.rmSync(dir, { recursive: true, force: true });
  const remote = parseRemoteList("2 ./a.txt\r\n4 ./sub dir/b é.txt\n9 ./only-remote\nnoise\n");
  assert.deepEqual([...remote], [["a.txt", 2], ["sub dir/b é.txt", 4], ["only-remote", 9]]);
  const src = new Map([["a.txt", 2], ["sub dir/b é.txt", 3], ["new", 5]]);
  assert.deepEqual(planSync(src, remote), { copy: ["new", "sub dir/b é.txt"], same: ["a.txt"], extra: ["only-remote"], bytes: 8 });
  const sums = parseSums(`${"1".repeat(64)}  ./a.txt\n${"2".repeat(64)}  sub dir/b é.txt\n`);
  assert.equal(sums.get("a.txt"), "1".repeat(64));
  assert.equal(sums.get("sub dir/b é.txt"), "2".repeat(64));
  assert.deepEqual(planSync(new Map([["a.txt", 2]]), new Map([["a.txt", 2]]), new Map([["a.txt", "x"]]), new Map([["a.txt", "y"]])).copy, ["a.txt"], "--checksum catches same-size changes");
});

test("remoteChunkCmds quotes paths and splits long lists", () => {
  const cmds = remoteChunkCmds("/sdcard/x y", ["it's.txt", "b"], "sha256sum");
  assert.deepEqual(cmds, [`cd '/sdcard/x y' && sha256sum './it'\\''s.txt' './b'`]);
  assert.equal(remoteChunkCmds("/d", Array.from({ length: 100 }, (_, i) => `file-${i}`), "chmod 660", 200).length > 1, true);
  assert.equal(fmtBytes(1536), "1.5 KB");
  assert.match(stamp(new Date("2026-11-14T15:30:12Z")), /^20261114-153012$/);
});

test("push folder: copies only what is missing or different, verifies, never deletes", () => {
  const dir = tree({ "a.txt": "aa", "sub/b.txt": "bbb", "sub/c.txt": "c" });
  const sums = `${sha("bbb")}  ./sub/b.txt\n${sha("c")}  ./sub/c.txt\n`;
  const rules = [...singleDevice,
    { args: "shell cd '/sdcard/T' 2>/dev/null && find", stdout: "2 ./a.txt\n9 ./sub/b.txt\n5 ./extra\n" },
    { args: "^-s ABC123XYZ push ", stdout: "1 file pushed\n" },
    { args: "sha256sum", stdout: sums }];
  let r = runCli(["push", dir, "/sdcard/T"], { rules });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /3 files: 2 to copy \(4 B\), 1 already there, 1 only on the device \(left alone\)/);
  assert.match(r.stdout, /verified sha256 of 2 copied file\(s\) -> \/sdcard\/T/);
  const pushes = r.calls.filter(c => c[2] === "push").map(c => c[4]);
  assert.deepEqual(pushes, ["/sdcard/T/sub/b.txt", "/sdcard/T/sub/c.txt"]);
  assert.ok(!r.calls.some(c => /\brm\b/.test(c.join(" "))), "never deletes");
  r = runCli(["push", dir, "/sdcard/T", "--dry-run"], { rules });
  assert.match(r.stdout, /\+ sub\/b\.txt\n {2}\+ sub\/c\.txt/);
  assert.ok(!r.calls.some(c => c[2] === "push"));
  r = runCli(["push", dir, "/sdcard/T"], { rules: [...rules.slice(0, 3), { args: "sha256sum", stdout: `${"0".repeat(64)}  ./sub/b.txt\n${sha("c")}  ./sub/c.txt\n` }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HASH MISMATCH on 1 file\(s\): sub\/b\.txt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("push folder into Android/data runs chmod 660 on the copied files and sync", () => {
  const dir = tree({ "s.sav": "x" });
  const R = "/sdcard/Android/data/com.x/files";
  const r = runCli(["push", dir, R], { rules: [...singleDevice,
    { args: "find \\. -type f", stdout: "" }, { args: "^-s ABC123XYZ push ", stdout: "" },
    { args: "sha256sum", stdout: `${sha("x")}  ./s.sav\n` }, { args: "chmod 660|^-s ABC123XYZ shell sync$", stdout: "" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.calls.some(c => c[3] === `cd '${R}' && chmod 660 './s.sav'`));
  assert.ok(r.calls.some(c => c[3] === "sync"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pull folder and backup snapshot with SHA256SUMS", () => {
  const out = tmpDir();
  const fakePull = { args: "^-s ABC123XYZ pull ", stdout: "" };
  const rules = [...singleDevice,
    { args: "\\[ -d '/sdcard/saves' \\]", stdout: "dir\n" },
    { args: "find \\. -type f", stdout: "0 ./a.sav\n" },
    fakePull,
    { args: "sha256sum", stdout: `${sha("")}  ./a.sav\n` }];
  // the fake adb cannot write files: pre-create what "adb pull" would have produced
  const dest = path.join(out, "mirror");
  fs.mkdirSync(dest);
  let r = runCli(["pull", "/sdcard/saves", dest], { rules });
  assert.equal(r.code, 1, "an empty fake pull leaves no file -> sha mismatch is detected");
  fs.writeFileSync(path.join(dest, "a.sav"), "");
  r = runCli(["pull", "/sdcard/saves", dest], { rules });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 files: 0 to copy \(0 B\), 1 already there/);
  r = runCli(["backup", "/sdcard/nothing"], { rules: [...singleDevice, { args: "\\[ -d", stdout: "" }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is not a folder on the device/);
  fs.rmSync(out, { recursive: true, force: true });
});

test("record: validation before touching the device", () => {
  for (const argv of [["record", "0"], ["record", "181"], ["record", "a.mp4", "b.mp4"]]) {
    const r = runCli(argv, { rules: singleDevice });
    assert.equal(r.code, 1, argv.join(" "));
    assert.ok(!r.calls.some(c => c[2] === "shell"));
  }
});

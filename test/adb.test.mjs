import assert from "node:assert/strict";
import { test } from "node:test";
import { adbCandidates, findAdb } from "../lib/adb.mjs";
import { CliError } from "../lib/errors.mjs";

test("findAdb: ADB wins when it exists", () => {
  assert.equal(findAdb({ env: { ADB: "/x/adb" }, exists: f => f === "/x/adb" }), "/x/adb");
});

test("findAdb: ADB set to a missing file is an error (no silent fallback)", () => {
  assert.throws(() => findAdb({ env: { ADB: "/nope/adb", PATH: "/usr/bin" }, exists: f => f !== "/nope/adb" }), CliError);
});

test("findAdb: returns empty string when nothing is found", () => {
  assert.equal(findAdb({ env: {}, platform: "linux", home: "/home/u", exists: () => false }), "");
});

test("adbCandidates: linux order (ANDROID_HOME, PATH, SDK, distro)", () => {
  const c = adbCandidates({ env: { ANDROID_HOME: "/sdk", PATH: "/a:/b" }, platform: "linux", home: "/home/u" });
  assert.deepEqual(c.slice(0, 4), ["/sdk/platform-tools/adb", "/a/adb", "/b/adb", "/home/u/Android/Sdk/platform-tools/adb"]);
  assert.ok(c.includes("/usr/bin/adb"));
});

test("adbCandidates: macOS adds the SDK and Homebrew locations", () => {
  const c = adbCandidates({ env: {}, platform: "darwin", home: "/Users/u" });
  assert.deepEqual(c, ["/Users/u/Library/Android/sdk/platform-tools/adb", "/opt/homebrew/bin/adb", "/usr/local/bin/adb"]);
});

test("adbCandidates: Windows uses adb.exe, ';' PATH (any case), quoted dirs, SDK and winget", () => {
  const c = adbCandidates({
    env: { Path: 'C:\\tools;"C:\\Program Files\\pt"', LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    platform: "win32", home: "C:\\Users\\u",
    readdir: () => ["Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe", "Other.Package"],
  });
  assert.deepEqual(c, [
    "C:\\tools\\adb.exe",
    "C:\\Program Files\\pt\\adb.exe",
    "C:\\Users\\u\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe",
    "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\\platform-tools\\adb.exe",
  ]);
});

test("adbCandidates: unreadable winget folder is fine", () => {
  const c = adbCandidates({ env: {}, platform: "win32", home: "C:\\Users\\u", readdir: () => { throw new Error("ENOENT"); } });
  assert.deepEqual(c, ["C:\\Users\\u\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe"]);
});

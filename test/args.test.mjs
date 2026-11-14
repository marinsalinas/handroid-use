import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../lib/args.mjs";
import { CliError } from "../lib/errors.mjs";

test("command, positional args and boolean flags", () => {
  assert.deepEqual(parseArgs(["discover", "--json"]), { command: "discover", args: [], flags: { json: true }, serial: undefined });
  assert.deepEqual(parseArgs(["fps", "droiddeck", "30", "--wait"]).args, ["droiddeck", "30"]);
});

test("--serial / -s / --serial= anywhere on the line", () => {
  assert.equal(parseArgs(["--serial", "ABC123XYZ", "status"]).serial, "ABC123XYZ");
  assert.equal(parseArgs(["status", "-s", "192.168.1.50:5555"]).serial, "192.168.1.50:5555");
  assert.equal(parseArgs(["--serial=ABC123XYZ", "ui"]).serial, "ABC123XYZ");
  assert.equal(parseArgs(["--serial=ABC123XYZ", "ui"]).command, "ui");
});

test("value flags take the next argument or =value", () => {
  assert.deepEqual(parseArgs(["shot", "a.png", "--display", "4"]).flags, { display: "4" });
  assert.deepEqual(parseArgs(["shot", "--display=4"]).flags, { display: "4" });
  assert.deepEqual(parseArgs(["install", "x.apk", "--sha256", "sha256:AB"]).flags, { sha256: "sha256:AB" });
});

test("value flag without a value is an error, not `true`", () => {
  assert.throws(() => parseArgs(["shot", "--display"]), CliError);
  assert.throws(() => parseArgs(["status", "--serial"]), /--serial needs a value/);
  assert.throws(() => parseArgs(["shot", "--display", "--all"]), /--display needs a value/);
  assert.throws(() => parseArgs(["shot", "--display="]), /needs a value/);
});

test("-- ends option parsing", () => {
  const r = parseArgs(["type", "--", "--not-a-flag", "-s"]);
  assert.equal(r.command, "type");
  assert.deepEqual(r.args, ["--not-a-flag", "-s"]);
  assert.deepEqual(r.flags, {});
});

test("-h and --help", () => {
  assert.equal(parseArgs(["-h"]).flags.help, true);
  assert.equal(parseArgs(["tap", "--help"]).flags.help, true);
});

test("negative numbers and text stay positional", () => {
  assert.deepEqual(parseArgs(["swipe", "-1", "2", "3", "4"]).args, ["-1", "2", "3", "4"]);
  assert.deepEqual(parseArgs(["tap", "Network & internet"]).args, ["Network & internet"]);
});

test("empty argv", () => {
  assert.equal(parseArgs([]).command, undefined);
});

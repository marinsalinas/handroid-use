#!/usr/bin/env node
// A fake adb for the integration tests. The CLI runs it with Node when ADB points to a .mjs file.
//
// FAKE_ADB_SCENARIO = JSON file: { fixtures: "<dir>", rules: [{ args, stdout?, stdoutFile?, stderr?, status? }] }
//   `args` is a regular expression matched against the argv joined by single spaces; first match wins.
// FAKE_ADB_LOG      = file that receives one JSON line (the argv array) per invocation.
// Unmatched calls print an error and exit 1, so a test notices any adb call it did not expect.
import fs from "node:fs";
import path from "node:path";

// `node --test` also loads every .mjs under test/: without a scenario, do nothing.
if (!process.env.FAKE_ADB_SCENARIO) process.exit(0);

const argv = process.argv.slice(2);
if (process.env.FAKE_ADB_LOG) fs.appendFileSync(process.env.FAKE_ADB_LOG, JSON.stringify(argv) + "\n");

const { fixtures = ".", rules = [] } = JSON.parse(fs.readFileSync(process.env.FAKE_ADB_SCENARIO, "utf8"));
const line = argv.join(" ");
const rule = rules.find(r => new RegExp(r.args, "s").test(line));
if (!rule) {
  process.stderr.write(`fake-adb: no rule for: ${line}\n`);
  process.exit(1);
}
if (rule.stdoutFile) process.stdout.write(fs.readFileSync(path.join(fixtures, rule.stdoutFile)));
else if (rule.stdout) process.stdout.write(rule.stdout);
if (rule.stderr) process.stderr.write(rule.stderr);
process.exitCode = rule.status ?? 0;

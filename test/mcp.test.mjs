import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TOOLS, callTool, handle, toolList } from "../lib/mcp.mjs";
import { CLI, FAKE_ADB, FIXTURES, tmpDir } from "./helpers.mjs";

const fakeRun = (code = 0, stdout = "ok") => { const calls = []; const run = argv => { calls.push(argv); return { code, stdout, stderr: "" }; }; return { run, calls }; };

test("initialize, ping, tools/list, unknown method, notifications", () => {
  const init = handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "handroid");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.deepEqual(handle({ id: 2, method: "ping" }).result, {});
  const tools = handle({ id: 3, method: "tools/list" }).result.tools;
  assert.ok(tools.length >= 20);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.inputSchema.properties.serial, `${t.name} accepts serial`);
  }
  assert.equal(handle({ id: 4, method: "nope" }).error.code, -32601);
  assert.equal(handle({ method: "notifications/initialized" }), null);
});

test("tools build argv with positionals after --, flags before, serial first", () => {
  let f = fakeRun();
  callTool("tap", { x: 10, y: 20, display: "4", serial: "ABC" }, f.run);
  assert.deepEqual(f.calls[0], ["--serial", "ABC", "tap", "--display", "4", "--", "10", "20"]);
  f = fakeRun();
  callTool("type", { text: "--display 4; reboot" }, f.run);
  assert.deepEqual(f.calls[0], ["type", "--", "--display 4; reboot"], "a value can never become a flag");
  f = fakeRun();
  callTool("wait_for", { condition: "text", value: "Play", timeout: 5 }, f.run);
  assert.deepEqual(f.calls[0], ["wait-for", "--timeout", "5", "--", "text", "Play"]);
  f = fakeRun();
  callTool("doctor", { checks: ["app:com.x", "storage:85"] }, f.run);
  assert.deepEqual(f.calls[0], ["doctor", "--json", "--", "app:com.x", "storage:85"]);
  f = fakeRun();
  callTool("push", { local: "a", remote: "/sdcard/b", dry_run: true }, f.run);
  assert.deepEqual(f.calls[0], ["push", "--dry-run", "--", "a", "/sdcard/b"]);
  f = fakeRun();
  callTool("seq", { steps: ["tap 1 2", "sleep 0.5"], display: 0 }, f.run);
  assert.deepEqual(f.calls[0], ["seq", "--display", "0", "--", "tap 1 2", "sleep 0.5"]);
});

test("argument validation and error reporting", () => {
  const f = fakeRun(1, "");
  assert.match(callTool("swipe", { x1: 1 }, f.run).content[0].text, /missing argument: y1/);
  assert.match(callTool("status", { bogus: 1 }, f.run).content[0].text, /unknown argument: bogus/);
  assert.match(callTool("rm_rf", {}, f.run).content[0].text, /unknown tool/);
  assert.equal(f.calls.length, 0);
  const r = callTool("status", {}, f.run);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /failed \(exit 1\)/);
  assert.equal(Object.keys(TOOLS).length, toolList().length);
});

test("screenshot returns MCP image content", () => {
  const png = fs.readFileSync(path.join(FIXTURES, "screencap.png"));
  const run = argv => { fs.writeFileSync(argv[argv.length - 1], png); return { code: 0, stdout: argv[argv.length - 1], stderr: "" }; };
  const r = callTool("screenshot", { display: "4" }, run);
  assert.equal(r.content[0].type, "image");
  assert.equal(r.content[0].mimeType, "image/png");
  assert.deepEqual(Buffer.from(r.content[0].data, "base64"), png);
});

test("end to end over stdio: handroid mcp with a fake adb", () => {
  const dir = tmpDir();
  const scenario = path.join(dir, "s.json");
  fs.writeFileSync(scenario, JSON.stringify({ fixtures: FIXTURES, rules: [
    { args: "^devices -l$", stdoutFile: "devices-single.txt" },
    { args: "shell echo '@@model'", stdout: "@@model\nAYN Thor\n@@release\n13\n@@focus\n  mCurrentFocus=null\n@@wake\n  mWakefulness=Awake\n@@capacity\n90\n@@bstatus\nFull\n@@df\n/dev/fuse 100G 40G 60G 40% /storage/emulated\n" },
  ] }));
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } },
  ].map(m => JSON.stringify(m)).join("\n") + "\nnot json\n";
  const env = { ...process.env, ADB: FAKE_ADB, FAKE_ADB_SCENARIO: scenario };
  delete env.ANDROID_SERIAL;
  const r = spawnSync(process.execPath, [CLI, "mcp"], { input, encoding: "utf8", env });
  fs.rmSync(dir, { recursive: true, force: true });
  const lines = r.stdout.trim().split("\n").map(l => JSON.parse(l));
  assert.equal(lines.length, 3, r.stdout + r.stderr);
  assert.equal(lines[0].result.serverInfo.name, "handroid");
  assert.equal(lines[1].id, 2);
  assert.equal(lines[1].result.isError, false);
  assert.match(lines[1].result.content[0].text, /device: {3}ABC123XYZ AYN Thor \(Android 13\)/);
  assert.equal(lines[2].error.code, -32700);
});

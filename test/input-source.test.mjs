// key --source gamepad and the sustained-rendering check (wait-for rendering / fps --wait).
import assert from "node:assert/strict";
import { test } from "node:test";
import { keyCode } from "../lib/cli.mjs";
import { callTool } from "../lib/mcp.mjs";
import { fixture, latencyDump, runCli, sampleWindows, singleDevice, stream } from "./helpers.mjs";

const S = "ABC123XYZ";
const has = (calls, argv) => calls.some(c => JSON.stringify(c) === JSON.stringify(argv));
const T0 = 512_345_678_901_234;
const layerRule = { args: "shell echo '@@layers'", stdout: `@@layers\n${fixture("layers-game.txt")}@@focus\n${fixture("focus-droiddeck.txt")}` };
const dumps = windows => windows.map(w => latencyDump(w) + "---\n").join("");

test("keyCode: gamepad button names map to KEYCODE_BUTTON_*", () => {
  assert.equal(keyCode("a", "gamepad"), "KEYCODE_BUTTON_A");
  assert.equal(keyCode("start", "gamepad"), "KEYCODE_BUTTON_START");
  assert.equal(keyCode("L1", "gamepad"), "KEYCODE_BUTTON_L1");
  assert.equal(keyCode("BUTTON_X", "gamepad"), "KEYCODE_BUTTON_X");
  assert.equal(keyCode("DPAD_UP", "gamepad"), "KEYCODE_DPAD_UP");
  assert.equal(keyCode("a"), "KEYCODE_A", "keyboard: the letter key");
  assert.equal(keyCode("96", "gamepad"), "96");
});

test("key --source gamepad sends `input gamepad keyevent KEYCODE_BUTTON_A`", () => {
  const rules = [...singleDevice, { args: "shell input", stdout: "" }];
  let r = runCli(["key", "A", "--source", "gamepad"], { rules });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(has(r.calls, ["-s", S, "shell", "input", "gamepad", "keyevent", "KEYCODE_BUTTON_A"]), JSON.stringify(r.calls));
  assert.equal(r.stdout.trim(), "key KEYCODE_BUTTON_A (gamepad)");
  r = runCli(["key", "BACK", "--source", "keyboard"], { rules });
  assert.ok(has(r.calls, ["-s", S, "shell", "input", "keyevent", "KEYCODE_BACK"]));
  r = runCli(["key", "A", "--source", "mouse;reboot"], { rules: singleDevice });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--source must be one of: keyboard, gamepad, dpad, joystick/);
  assert.ok(!r.calls.some(c => c[2] === "shell"));
});

test("seq --source applies to key steps only", () => {
  const r = runCli(["seq", "key A", "sleep 0.3", "tap 1 2", "--source", "gamepad"], { rules: [...singleDevice, { args: "shell input", stdout: "" }] });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(has(r.calls, ["-s", S, "shell", "input gamepad keyevent KEYCODE_BUTTON_A && sleep 0.3 && input tap 1 2"]), JSON.stringify(r.calls));
});

test("wait-for rendering needs a sustained frame rate, not a burst", () => {
  // Steady 60 fps for the whole window -> ok.
  const steady = sampleWindows(stream(T0, 400, 1000 / 60), T0 + 50e6, 9);
  let r = runCli(["wait-for", "rendering", "droiddeck", "--stable", "3"], { rules: [...singleDevice, layerRule, { args: "date .%s", stdout: dumps(steady) }] });
  assert.equal(r.code, 0, r.stderr);
  // A short burst of 20 frames, then nothing (an animated menu redrawing once) -> never ok.
  const burst = sampleWindows(stream(T0 + 100e6, 20, 1000 / 120), T0, 9);
  r = runCli(["wait-for", "rendering", "droiddeck", "--timeout", "1", "--stable", "3"], { rules: [...singleDevice, layerRule, { args: "date .%s", stdout: dumps(burst) }] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /timed out after 1 s waiting for rendering/);
  // Steady but below --min-fps -> not ok.
  const slow = sampleWindows(stream(T0, 100, 1000 / 10), T0 + 50e6, 9);
  r = runCli(["wait-for", "rendering", "droiddeck", "--timeout", "1", "--min-fps", "30"], { rules: [...singleDevice, layerRule, { args: "date .%s", stdout: dumps(slow) }] });
  assert.equal(r.code, 1);
  for (const bad of [["--min-fps", "0"], ["--stable", "0"], ["--stable", "121"]]) {
    const b = runCli(["wait-for", "rendering", "droiddeck", ...bad], { rules: singleDevice });
    assert.equal(b.code, 1, bad.join(" "));
  }
});

test("MCP key/seq/wait_for pass the new options", () => {
  const calls = [];
  const run = argv => { calls.push(argv); return { code: 0, stdout: "ok", stderr: "" }; };
  callTool("key", { key: "A", source: "gamepad" }, run);
  callTool("seq", { steps: ["key START"], source: "gamepad" }, run);
  callTool("wait_for", { condition: "rendering", value: "armsx3", min_fps: 20, stable: 5 }, run);
  assert.deepEqual(calls, [
    ["key", "--source", "gamepad", "--", "A"],
    ["seq", "--source", "gamepad", "--", "key START"],
    ["wait-for", "--min-fps", "20", "--stable", "5", "--", "rendering", "armsx3"],
  ]);
});

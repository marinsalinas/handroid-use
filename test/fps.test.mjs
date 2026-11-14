import assert from "node:assert/strict";
import { test } from "node:test";
import { expandComponent, findLayer, formatStats, frameStats, parseFocus, parseLatency, percentile, quickRate, splitSamples } from "../lib/fps.mjs";
import { fixture, latencyDump, sampleWindows, stream } from "./helpers.mjs";

const T0 = 512_345_678_901_234; // a realistic CLOCK_MONOTONIC value in ns (~6 days of uptime)
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} expected ${a} ~ ${b} (+-${eps})`);

// ---------- parsing ----------

test("parseLatency: real idle layer (all rows 0 0 0, CRLF, tabs)", () => {
  assert.deepEqual(parseLatency(fixture("latency-idle.txt")), { refreshPeriodNs: 8333333, presents: [] });
});

test("parseLatency: INT64_MAX pending rows are dropped", () => {
  const { refreshPeriodNs, presents } = parseLatency(fixture("latency-120hz.txt"));
  assert.equal(refreshPeriodNs, 8333333);
  assert.equal(presents.length, 126);
  assert.ok(presents.every((t, i) => i === 0 || t > presents[i - 1]));
  assert.ok(presents.every(t => t < 9e18));
});

test("parseLatency: partially filled buffer (fresh layer) at 60 Hz", () => {
  const { refreshPeriodNs, presents } = parseLatency(fixture("latency-partial.txt"));
  assert.equal(refreshPeriodNs, 16666666);
  assert.equal(presents.length, 27);
});

test("parseLatency: garbage and layer-not-found output give no frames", () => {
  assert.deepEqual(parseLatency("").presents, []);
  assert.deepEqual(parseLatency("8333333\n").presents, []);
  assert.deepEqual(parseLatency("Layer not found\nfoo bar baz\n").presents, []);
});

test("splitSamples: dumps separated by --- lines", () => {
  const a = stream(T0, 10, 8.333), b = stream(T0 + 50e6, 10, 8.333);
  const raw = latencyDump(a) + "---\r\n" + latencyDump(b, { pending: 2 }) + "---\n";
  const s = splitSamples(raw);
  assert.equal(s.length, 3);
  assert.equal(s[0].presents.length, 10);
  assert.equal(s[1].presents.length, 10);
  assert.equal(s[2].presents.length, 0);
});

test("percentile: nearest rank", () => {
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(v, 0.99), 99);
  assert.equal(percentile(v, 0.999), 100);
  assert.equal(percentile(v, 0.5), 50);
  assert.equal(percentile([7], 0.99), 7);
  assert.ok(Number.isNaN(percentile([], 0.5)));
});

// ---------- statistics ----------

test("120 Hz steady stream sampled every 0.4 s -> ~120 fps, no hitches, no breaks", () => {
  const all = stream(T0, 1200, 1000 / 120); // 10 s
  const windows = sampleWindows(all, T0 + 50e6, 26);
  const st = frameStats(windows);
  near(st.avgFps, 120, 0.1, "avg");
  near(st.low1Fps, 120, 0.5, "1% low");
  near(st.low01Fps, 120, 0.5, "0.1% low");
  assert.equal(st.hitches, 0);
  assert.equal(st.slowFrames, 0);
  assert.equal(st.breaks, 0);
  near(st.worstMs, 8.333, 0.01);
});

test("overlapping windows: no frame is counted twice", () => {
  const all = stream(T0, 600, 1000 / 120);
  const windows = sampleWindows(all, T0 + 50e6, 13);
  const seen = new Set(windows.flat());
  const st = frameStats(windows);
  assert.equal(st.frames, seen.size);
  assert.equal(st.intervals, seen.size - 1);
  // feeding every window twice changes nothing
  const twice = frameStats(windows.flatMap(w => [w, w]));
  assert.equal(twice.frames, st.frames);
  assert.equal(twice.intervals, st.intervals);
  assert.equal(twice.measuredMs, st.measuredMs);
});

test("non-overlapping window: the gap is a break, excluded from timing, never a hitch", () => {
  const a = stream(T0, 127, 1000 / 120);
  const b = stream(T0 + 5e9, 127, 1000 / 120); // 5 s later: frames in between were never seen
  const st = frameStats([a, b]);
  assert.equal(st.breaks, 1);
  assert.equal(st.hitches, 0);
  assert.equal(st.slowFrames, 0);
  assert.equal(st.frames, 254);
  assert.equal(st.intervals, 252);
  near(st.worstMs, 8.333, 0.01);
  near(st.measuredMs, 252 * 1000 / 120, 0.01);
  near(st.avgFps, 120, 0.01);
});

test("static screen: no new frames -> null; old frames are not re-counted", () => {
  assert.equal(frameStats([[], [], []]), null);
  assert.equal(frameStats(splitSamples(fixture("latency-idle.txt") + "---\n" + fixture("latency-idle.txt"))), null);
  const old = stream(T0, 127, 1000 / 120);
  const st = frameStats([old, old, old, old]);
  assert.equal(st.frames, 127);
  assert.equal(st.intervals, 126);
  assert.equal(frameStats([[T0]]), null); // a single frame has no interval
});

test("INT64_MAX and 0 rows inside sampled dumps are ignored", () => {
  const all = stream(T0, 400, 1000 / 120);
  const raw = sampleWindows(all, T0 + 50e6, 8).map(w => latencyDump(w, { pending: 1 })).join("---\n") + "---\n";
  const st = frameStats(splitSamples(raw));
  assert.equal(st.hitches, 0);
  near(st.avgFps, 120, 0.1);
  assert.ok(st.worstMs < 9, `worst ${st.worstMs}`);
});

test("injected 60 ms frames are counted as hitches and slow frames", () => {
  const frameMs = Array(600).fill(1000 / 120);
  for (const i of [100, 250, 400]) frameMs[i] = 60;
  const all = [T0];
  for (const d of frameMs) all.push(Math.round(all[all.length - 1] + d * 1e6));
  const st = frameStats(sampleWindows(all, T0 + 50e6, 20));
  assert.equal(st.hitches, 3);
  assert.equal(st.slowFrames, 3);
  near(st.worstMs, 60, 0.01);
  assert.equal(st.breaks, 0);
  assert.ok(st.avgFps < 120 && st.avgFps > 100, `avg ${st.avgFps}`);
});

test("40 ms frames are slow (>33 ms) but not hitches (>50 ms)", () => {
  const all = [T0];
  for (let i = 0; i < 300; i++) all.push(all[all.length - 1] + (i === 150 ? 40e6 : 8_333_333));
  const st = frameStats(sampleWindows(all, T0 + 50e6, 10));
  assert.equal(st.slowFrames, 1);
  assert.equal(st.hitches, 0);
});

test("1% and 0.1% lows use the 99th / 99.9th percentile frame time", () => {
  const build = (n10, n20) => {
    const ts = [T0];
    for (const d of [...Array(n10).fill(10), ...Array(n20).fill(20)]) ts.push(ts[ts.length - 1] + d * 1e6);
    return frameStats([ts]);
  };
  let st = build(990, 10); // exactly 1% slow frames: the 99th percentile is still a 10 ms frame
  near(st.low1Fps, 100, 1e-6);
  near(st.low01Fps, 50, 1e-6);
  st = build(989, 11); // just over 1% slow frames
  near(st.low1Fps, 50, 1e-6);
  st = build(1000, 0);
  near(st.low1Fps, 100, 1e-6);
  near(st.low01Fps, 100, 1e-6);
});

test("formatStats output", () => {
  const st = frameStats([stream(T0, 121, 1000 / 120)]);
  const text = formatStats(st);
  assert.match(text, /^avg fps: {3}120\.0 {3}\(121 frames, 1\.0 s measured\)$/m);
  assert.match(text, /^1% low: {4}120\.0 fps {3}0\.1% low: 120\.0 fps$/m);
  assert.match(text, /^worst: {5}8 ms {3}frames >33 ms: 0 {3}hitches >50 ms: 0$/m);
  assert.doesNotMatch(text, /note:/);
  assert.match(formatStats(frameStats([stream(T0, 10, 10), stream(T0 + 9e9, 10, 10)])), /note: 1 sampling window/);
});

test("quickRate: recent render rate from one dump", () => {
  near(quickRate(fixture("latency-120hz.txt")), 120, 0.1);
  near(quickRate(fixture("latency-partial.txt")), 60, 0.1);
  assert.equal(quickRate(fixture("latency-idle.txt")), 0);
});

// ---------- layer selection ----------

test("findLayer: a running game's SurfaceView(BLAST) wins", () => {
  assert.equal(findLayer(fixture("layers-game.txt"), "droiddeck"),
    "SurfaceView[com.droiddeck.launcher/com.droiddeck.launcher.SessionActivity](BLAST)#3303");
});

test("findLayer: never a presentation window on the second display or a container (real Thor list)", () => {
  // Without focus (screen asleep) the old code picked "f797b68 com.droiddeck.launcher#3277" on display 4.
  assert.equal(findLayer(fixture("layers-menu.txt"), "droiddeck"),
    "25109b9 com.droiddeck.launcher/com.droiddeck.launcher.SessionActivity#3279");
});

test("findLayer: the focused activity is preferred; short component names are expanded", () => {
  assert.equal(findLayer(fixture("layers-menu.txt"), "droiddeck", "com.droiddeck.launcher/.MainActivity"),
    "511c888 com.droiddeck.launcher/com.droiddeck.launcher.MainActivity#2865");
  assert.equal(findLayer(fixture("layers-menu.txt"), "cocoonshell", "rip.moth.cocoonshell/rip.moth.cocoonshell.MainActivity"),
    "4f4d4c8 rip.moth.cocoonshell/rip.moth.cocoonshell.MainActivity#3192");
  // focused game: its SurfaceView beats the activity window
  assert.equal(findLayer(fixture("layers-game.txt"), "droiddeck", parseFocus(fixture("focus-droiddeck.txt"))),
    "SurfaceView[com.droiddeck.launcher/com.droiddeck.launcher.SessionActivity](BLAST)#3303");
});

test("findLayer: case-insensitive, and empty when nothing matches", () => {
  assert.match(findLayer(fixture("layers-game.txt"), "DroidDeck"), /\(BLAST\)/);
  assert.equal(findLayer(fixture("layers-game.txt"), "com.not.installed"), "");
  assert.equal(findLayer(fixture("layers-game.txt"), ""), "");
  assert.equal(findLayer("ActivityRecord{1 u0 com.x/.A}#1\nTask=1#2\n", "com.x"), "");
});

test("parseFocus / expandComponent", () => {
  assert.equal(parseFocus(fixture("focus-droiddeck.txt")), "com.droiddeck.launcher/com.droiddeck.launcher.SessionActivity");
  assert.equal(parseFocus("  mCurrentFocus=null"), "");
  assert.equal(parseFocus(""), "");
  assert.equal(expandComponent("com.a/.Main"), "com.a/com.a.Main");
  assert.equal(expandComponent("com.a/com.b.Main"), "com.a/com.b.Main");
  assert.equal(expandComponent(""), "");
});

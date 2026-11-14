import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkDisplayArg, displayContext, displayForTree, formatDisplays, parseDisplayInfo, parseFocusedDisplay,
  parseTopActivities, parseWindows, resolveDisplay,
} from "../lib/displays.mjs";
import { CliError } from "../lib/errors.mjs";
import { parseSections } from "../lib/shell.mjs";
import { fixture } from "./helpers.mjs";

const ctx = displayContext(parseSections(fixture("display-context-thor.txt")));
const root = (pkg, w, h) => ({ pkg, bounds: [0, 0, w, h] });

test("parseDisplayInfo: logical id, name, current (rotated) size, physical id", () => {
  assert.deepEqual(ctx.displays.map(({ id, name, width, height, physical, presentation }) => ({ id, name, width, height, physical, presentation })), [
    { id: 0, name: "Built-in Screen", width: 1920, height: 1080, physical: "4619827259835644675", presentation: false },
    { id: 4, name: "Screen-2", width: 1240, height: 1080, physical: "4619827259835644676", presentation: true },
  ]);
  assert.deepEqual(parseDisplayInfo(""), []);
});

test("focused display, top activity per display, windows", () => {
  assert.equal(ctx.focused, 4);
  assert.equal(parseFocusedDisplay("nothing"), null);
  assert.deepEqual(parseTopActivities(parseSections(fixture("display-context-thor.txt")).acts),
    { 4: "rip.moth.cocoonshell/.ExternalDisplayActivity", 0: "com.android.settings/.Settings" });
  assert.deepEqual(ctx.displays.map(d => [d.focused, d.top]), [[false, "com.android.settings/.Settings"], [true, "rip.moth.cocoonshell/.ExternalDisplayActivity"]]);
  const w = parseWindows(parseSections(fixture("display-context-thor.txt")).wins);
  assert.deepEqual(w.map(x => [x.pkg, x.display, x.visible]), [
    ["NavigationBar4", 4, false], ["com.droiddeck.launcher", 4, true], ["rip.moth.cocoonshell", 4, true],
    ["com.droiddeck.launcher", 0, false], ["com.android.settings", 0, true],
  ]);
  assert.equal(ctx.asleep, false);
});

test("displayForTree: the UI tree's own display, not just the focused one", () => {
  // uiautomator returned Settings (top screen) while the bottom screen had focus.
  assert.equal(displayForTree(ctx, root("com.android.settings", 1920, 1080)).id, 0);
  // DroidDeck's controller overlay on the bottom screen: same package also runs on display 0.
  assert.equal(displayForTree(ctx, root("com.droiddeck.launcher", 1240, 1080)).id, 4);
  assert.equal(displayForTree(ctx, root("rip.moth.cocoonshell", 1240, 1080)).id, 4);
  // Single-screen devices: no display needed.
  assert.equal(displayForTree({ displays: [ctx.displays[0]], windows: [] }, root("x", 1, 1)), null);
  assert.equal(displayForTree(ctx, undefined), null);
});

test("resolveDisplay accepts logical or physical ids", () => {
  assert.equal(resolveDisplay(ctx.displays, "4").physical, "4619827259835644676");
  assert.equal(resolveDisplay(ctx.displays, "4619827259835644675").id, 0);
  assert.equal(resolveDisplay([], "7"), null, "no display info: pass through");
  assert.throws(() => resolveDisplay(ctx.displays, "9"), /no display "9"\. Known: 0 \(physical 4619827259835644675\), 4/);
  assert.throws(() => checkDisplayArg("top"), CliError);
  assert.doesNotThrow(() => checkDisplayArg("0"));
});

test("formatDisplays: aligned table with the focused screen marked", () => {
  const lines = formatDisplays(ctx).split("\n");
  assert.match(lines[0], /^id +physical +name +size +focus +top activity$/);
  assert.match(lines[1], /^0 +4619827259835644675 +Built-in Screen +1920x1080 +com\.android\.settings\/\.Settings$/);
  assert.match(lines[2], /^4 +4619827259835644676 +Screen-2 +1240x1080 +\* +rip\.moth\.cocoonshell/);
});

test("asleep is detected from mWakefulness", () => {
  assert.equal(displayContext({ wake: "  mWakefulness=Asleep" }).asleep, true);
  assert.equal(displayContext({ wake: "  mWakefulness=Dozing" }).asleep, true);
});

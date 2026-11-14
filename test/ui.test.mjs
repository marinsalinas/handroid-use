import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError } from "../lib/errors.mjs";
import { decodeEntities, findNode, formatNode, parseUiXml } from "../lib/ui.mjs";
import { fixture } from "./helpers.mjs";

const nodes = parseUiXml(fixture("ui-settings.xml"));

test("parseUiXml: every node with bounds, centres computed", () => {
  assert.equal(nodes.length, 11);
  const search = nodes.find(n => n.desc === "Search settings");
  assert.equal(search.clickable, true);
  assert.deepEqual(search.bounds, [40, 240, 1040, 360]);
  assert.deepEqual([search.cx, search.cy], [540, 300]);
  assert.equal(search.id, "com.android.settings:id/search_action_bar");
});

test("parseUiXml: entities decoded once, line breaks flattened", () => {
  const n = nodes.find(x => x.desc === "it's here");
  assert.equal(n.text, 'Say "hi" <3 &amp; more second line');
  assert.equal(n.desc, "it's here");
  assert.equal(nodes.find(x => x.id === "android:id/summary").text, "Wi‑Fi, mobile, data usage");
  assert.equal(nodes.find(x => x.text.startsWith("Network")).text, "Network & internet");
});

test("parseUiXml: uiautomator error output is reported, not treated as an empty screen", () => {
  assert.throws(() => parseUiXml(fixture("ui-error.txt")), (e) => e instanceof CliError && /could not get idle state/.test(e.message));
  assert.throws(() => parseUiXml(""), /empty output/);
});

test("decodeEntities", () => {
  assert.equal(decodeEntities("&amp;lt;b&amp;gt;"), "&lt;b&gt;");
  assert.equal(decodeEntities("&#65;&#x42;&quot;&apos;&lt;&gt;&amp;"), "AB\"'<>&");
  assert.equal(decodeEntities("&unknown; & alone"), "&unknown; & alone");
  assert.equal(decodeEntities(undefined), "");
});

test("findNode: exact text or desc first, preferring clickable", () => {
  const battery = findNode(nodes, "Battery");
  assert.equal(battery.clickable, true);
  assert.deepEqual([battery.cx, battery.cy], [540, 660]);
  assert.equal(findNode(nodes, "Search settings").cx, 540);
});

test("findNode: case-insensitive substring fallback; zero-size nodes are skipped", () => {
  assert.equal(findNode(nodes, "network").text, "Network & internet");
  assert.equal(findNode(nodes, "Hidden"), undefined);
  assert.equal(findNode(nodes, "nothing like this"), undefined);
  assert.equal(findNode(nodes, "   "), undefined);
});

test("formatNode", () => {
  const line = formatNode(findNode(nodes, "Search settings"));
  assert.match(line, /^ {38} Search settings {10}\[tap\] 540,300$/);
  assert.match(formatNode(findNode(nodes, "Search settings"), true), /540,300  com\.android\.settings:id\/search_action_bar$/);
});

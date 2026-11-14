import assert from "node:assert/strict";
import { test } from "node:test";
import { currentMa, formatThermals, maxTemp, parseThermalZones, toCelsius } from "../lib/thermals.mjs";
import { fixture } from "./helpers.mjs";

const zones = parseThermalZones(fixture("thermal-zones.txt"));

test("parseThermalZones: real Snapdragon 8 Gen 2 output (CRLF)", () => {
  assert.equal(zones.length, 67);
  assert.deepEqual(zones[0], { type: "pa", raw: 36400 });
  assert.deepEqual(zones.find(z => z.type === "wls-therm"), { type: "wls-therm", raw: -40960 });
});

test("parseThermalZones: ignores malformed lines", () => {
  assert.deepEqual(parseThermalZones("cpu-0-0 41000\nbroken\nmodem 12x\n gpuss-0 39000 \n"), [
    { type: "cpu-0-0", raw: 41000 }, { type: "gpuss-0", raw: 39000 },
  ]);
});

test("maxTemp over cpu / gpu / battery zones", () => {
  assert.equal(maxTemp(zones, /cpu/i), 39.6);
  assert.equal(maxTemp(zones, /gpu/i), 36.4);
  assert.equal(maxTemp(zones, /^battery$/i), 28);
  assert.ok(Number.isNaN(maxTemp(zones, /nope/)));
});

test("toCelsius handles milli-, deci- and whole degrees and rejects bogus values", () => {
  assert.equal(toCelsius(45200), 45.2);
  assert.equal(toCelsius(452), 45.2);
  assert.equal(toCelsius(45), 45);
  assert.ok(Number.isNaN(toCelsius(0)));
  assert.ok(Number.isNaN(toCelsius(-40960)));
  assert.ok(Number.isNaN(toCelsius(200000)));
});

test("currentMa: uA vs mA heuristics", () => {
  assert.equal(currentMa("-1250000"), 1250);
  assert.equal(currentMa("850"), 850);
  assert.equal(currentMa("0"), 0);
  assert.ok(Number.isNaN(currentMa(undefined)));
  assert.ok(Number.isNaN(currentMa("")));
});

test("formatThermals: full line", () => {
  assert.equal(formatThermals(zones, { current: "0", capacity: "100", status: "Full" }),
    "temps: CPU 39.6 C | GPU 36.4 C | battery 28.0 C | battery 100% Full, 0 mA");
});

test("formatThermals: missing battery files do not shift values", () => {
  assert.equal(formatThermals([], { current: "", capacity: "80", status: "Discharging" }),
    "temps: CPU n/a | GPU n/a | battery n/a | battery 80% Discharging");
  assert.equal(formatThermals([], {}), "temps: CPU n/a | GPU n/a | battery n/a");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceInfo, parseDevices, parseDf, parseGles, parseMdns, parseWmSize, selectDevice, transportOf, unconnectedServices } from "../lib/devices.mjs";
import { parseSections } from "../lib/shell.mjs";
import { fixture } from "./helpers.mjs";

test("parseDevices: single USB device with -l details", () => {
  assert.deepEqual(parseDevices(fixture("devices-single.txt")), [{
    serial: "ABC123XYZ", state: "device", transport: "usb",
    usb: "1-1", product: "kalama", model: "AYN_Thor", device: "kalama", transport_id: "17",
  }]);
});

test("parseDevices: USB, tcp and TLS (wireless debugging) transports", () => {
  const d = parseDevices(fixture("devices-multi.txt"));
  assert.deepEqual(d.map(x => [x.serial, x.state, x.transport]), [
    ["ABC123XYZ", "device", "usb"],
    ["192.168.1.50:5555", "device", "wifi"],
    ["adb-DEF456UVW-Ab1Cd2._adb-tls-connect._tcp", "device", "wifi"],
  ]);
  assert.equal(d[2].model, "Pixel_7");
});

test("parseDevices: unauthorized gets a hint", () => {
  const [d] = parseDevices(fixture("devices-unauthorized.txt"));
  assert.equal(d.state, "unauthorized");
  assert.match(d.hint, /Allow USB debugging/);
});

test("parseDevices: multi-word 'no permissions' state and emulator offline", () => {
  const d = parseDevices(fixture("devices-nopermissions.txt"));
  assert.equal(d[0].state, "no permissions");
  assert.equal(d[0].usb, "1-1");
  assert.equal(d[0].transport_id, "2");
  assert.match(d[0].hint, /udev/);
  assert.deepEqual([d[1].serial, d[1].state, d[1].transport], ["emulator-5554", "offline", "emulator"]);
});

test("parseDevices: daemon chatter, header and blank lines are ignored; CRLF ok", () => {
  assert.deepEqual(parseDevices(fixture("devices-empty.txt")), []);
  assert.deepEqual(parseDevices("List of devices attached\r\nX1\tdevice\r\n\r\n").map(d => d.serial), ["X1"]);
  assert.deepEqual(parseDevices(""), []);
});

test("transportOf", () => {
  assert.equal(transportOf("ABC123XYZ"), "usb");
  assert.equal(transportOf("192.168.1.50:5555"), "wifi");
  assert.equal(transportOf("adb-X-y._adb-tls-connect._tcp"), "wifi");
  assert.equal(transportOf("emulator-5554"), "emulator");
});

test("selectDevice: one ready device is chosen", () => {
  assert.equal(selectDevice(parseDevices(fixture("devices-single.txt"))), "ABC123XYZ");
});

test("selectDevice: several devices without --serial is an error listing them", () => {
  const d = parseDevices(fixture("devices-multi.txt"));
  assert.throws(() => selectDevice(d), /Several devices: ABC123XYZ, 192\.168\.1\.50:5555, adb-DEF456UVW.*--serial/);
  assert.equal(selectDevice(d, "192.168.1.50:5555"), "192.168.1.50:5555");
});

test("selectDevice: explicit serial must exist and be ready", () => {
  const d = parseDevices(fixture("devices-single.txt"));
  assert.throws(() => selectDevice(d, "NOPE"), /Device "NOPE" not found. Connected: ABC123XYZ/);
  assert.throws(() => selectDevice(parseDevices(fixture("devices-unauthorized.txt")), "ABC123XYZ"), /unauthorized: unlock/);
});

test("selectDevice: empty and not-ready lists", () => {
  assert.throws(() => selectDevice([]), /No device connected/);
  assert.throws(() => selectDevice(parseDevices(fixture("devices-unauthorized.txt"))), /No ready device. Seen: ABC123XYZ \(unauthorized\).*Allow USB debugging/);
});

test("parseMdns: connect and pairing services, header skipped", () => {
  const s = parseMdns(fixture("mdns-services.txt"));
  assert.equal(s.length, 4);
  assert.deepEqual(s[0], { name: "adb-ABC123XYZ-Xy9Zw8", type: "_adb-tls-connect._tcp", address: "192.168.1.40:37865", kind: "connect" });
  assert.equal(s[1].type, "_adb._tcp");
  assert.equal(s[3].kind, "pairing");
  assert.deepEqual(parseMdns("List of discovered mdns services\n\n"), []);
  assert.deepEqual(parseMdns("ERROR: mdns discovery failed\n"), []);
});

test("unconnectedServices: hides devices already attached (by address, TLS name or USB serial)", () => {
  const lan = unconnectedServices(parseMdns(fixture("mdns-services.txt")), parseDevices(fixture("devices-multi.txt")));
  assert.deepEqual(lan, [
    { name: "adb-0123456789abcdef", kind: "connect", address: "192.168.1.60:5555" },
    { name: "adb-GHI789RST-Qq7Rr6", kind: "pairing", address: "192.168.1.80:39001" },
  ]);
  const byAddr = unconnectedServices([{ name: "adb-x", type: "_adb._tcp", address: "192.168.1.50:5555", kind: "connect" }],
    [{ serial: "192.168.1.50:5555" }]);
  assert.deepEqual(byAddr, []);
});

test("deviceInfo from the batched discover output (real AYN Thor capture)", () => {
  assert.deepEqual(deviceInfo(parseSections(fixture("device-info-thor.txt"))), {
    manufacturer: "AYN", model: "AYN Thor", android: "13", sdk: "33",
    soc: "QTI QCS8550", gpu: "Adreno (TM) 740", abi: "arm64-v8a",
    screen: "1080x1920", displays: 2, battery: "100", storageFree: "49G",
  });
});

test("deviceInfo: missing properties and files degrade to empty values", () => {
  const info = deviceInfo(parseSections("@@manufacturer\r\nACME\r\n@@socManufacturer\r\n\r\n@@socModel\r\n@@platform\r\nmsmnile\r\n@@battery\r\n@@df\r\n"));
  assert.equal(info.manufacturer, "ACME");
  assert.equal(info.model, "");
  assert.equal(info.soc, "msmnile");
  assert.equal(info.gpu, "");
  assert.equal(info.displays, 1);
  assert.equal(info.battery, "");
  assert.equal(info.storageFree, "");
});

test("small parsers: GLES, df, wm size", () => {
  assert.equal(parseGles("GLES: Qualcomm, Adreno (TM) 740, OpenGL ES 3.2 V@0676.53"), "Adreno (TM) 740");
  assert.equal(parseGles(""), "");
  assert.deepEqual(parseDf("/dev/fuse       465G 416G   49G  90% /storage/emulated"), { size: "465G", used: "416G", free: "49G", usePct: "90%" });
  assert.equal(parseDf(""), null);
  assert.equal(parseDf("Filesystem Size Used Avail Use% Mounted on"), null);
  assert.equal(parseWmSize("Physical size: 1080x1920"), "1080x1920");
  assert.equal(parseWmSize("Physical size: 1440x3120\nOverride size: 1080x2340"), "1080x2340");
});

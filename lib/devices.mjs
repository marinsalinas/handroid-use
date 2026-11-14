import { CliError } from "./errors.mjs";

const HINTS = {
  unauthorized: "unlock the device and accept the 'Allow USB debugging' prompt",
  offline: "replug the cable or run: adb kill-server",
  "no permissions": "adb cannot open the USB device: install udev rules / add your user to the plugdev group (Linux), then replug",
  authorizing: "waiting for the 'Allow USB debugging' prompt to be accepted",
  connecting: "adb is still connecting; try again in a few seconds",
};

export function transportOf(serial) {
  if (/^emulator-\d+$/.test(serial)) return "emulator";
  if (/:\d+$/.test(serial) || serial.includes("._adb-tls-connect.")) return "wifi";
  return "usb";
}

/**
 * Parse `adb devices` or `adb devices -l`.
 * Lines look like
 *   ABC123XYZ  device usb:1-1 product:kalama model:AYN_Thor device:kalama transport_id:17
 *   ABC123XYZ  no permissions (user in plugdev group; ...); see [http://...] usb:1-1 transport_id:2
 * The header line and adb daemon chatter ("* daemon started ...") are skipped.
 * Returns [{ serial, state, transport, product?, model?, device?, usb?, transport_id?, hint? }].
 */
export function parseDevices(text) {
  const devices = [];
  for (const raw of String(text).replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("*") || /^List of devices attached/i.test(line)) continue;
    const tokens = line.split(/\s+/);
    const serial = tokens.shift();
    if (!tokens.length) continue;
    let state = tokens.shift();
    if (state === "no" && tokens[0] === "permissions") { state = "no permissions"; tokens.shift(); }
    const d = { serial, state, transport: transportOf(serial) };
    for (const t of tokens) {
      const m = /^([a-z_]+):(.+)$/.exec(t);
      if (m) d[m[1]] = m[2];
    }
    if (HINTS[state]) d.hint = HINTS[state];
    devices.push(d);
  }
  return devices;
}

/**
 * Choose the device to talk to. `serial` (from --serial / ANDROID_SERIAL) wins when it is listed
 * and ready. Throws a CliError with a helpful message otherwise.
 */
export function selectDevice(devices, serial) {
  if (serial) {
    const d = devices.find(x => x.serial === serial);
    if (!d) throw new CliError(`Device "${serial}" not found. Connected: ${devices.map(x => x.serial).join(", ") || "none"}.`);
    if (d.state !== "device") throw new CliError(`Device ${serial} is ${d.state}${d.hint ? `: ${d.hint}` : ""}.`);
    return serial;
  }
  const ready = devices.filter(d => d.state === "device");
  if (ready.length === 1) return ready[0].serial;
  if (ready.length === 0) {
    if (!devices.length) throw new CliError("No device connected (adb devices is empty). Connect by USB, or use: handroid connect <ip:port>");
    const seen = devices.map(d => `${d.serial} (${d.state})`).join(", ");
    const hints = [...new Set(devices.map(d => d.hint).filter(Boolean))];
    throw new CliError(`No ready device. Seen: ${seen}.${hints.length ? " Fix: " + hints.join("; ") + "." : ""}`);
  }
  throw new CliError(`Several devices: ${ready.map(d => d.serial).join(", ")}. Pick one with --serial <id> or ANDROID_SERIAL.`);
}

/**
 * Parse `adb mdns services`:
 *   List of discovered mdns services
 *   adb-ABC123XYZ-Ab1Cd2   _adb-tls-connect._tcp   192.168.1.50:37865
 *   adb-ABC123XYZ-Ab1Cd2   _adb-tls-pairing._tcp   192.168.1.50:41023
 *   adb-0123456789abcdef   _adb._tcp               192.168.1.60:5555
 * Returns [{ name, type, address, kind: "pairing" | "connect" }].
 */
export function parseMdns(text) {
  const out = [];
  for (const raw of String(text).replace(/\r/g, "").split("\n")) {
    const p = raw.trim().split(/\s+/);
    if (p.length < 3 || !/^_adb/.test(p[1])) continue;
    const [name, type, address] = p;
    out.push({ name, type, address, kind: type.includes("pairing") ? "pairing" : "connect" });
  }
  return out;
}

/**
 * mDNS services that belong to a device adb is not already connected to.
 * A connected device is recognised by address (ip:port serial), by its TLS service name
 * (serial "adb-XYZ-abc._adb-tls-connect._tcp"), or by its serial number in the service
 * name ("adb-<serialno>[-suffix]"), which covers a USB-connected device with wireless
 * debugging switched on.
 */
export function unconnectedServices(services, devices) {
  const serials = devices.map(d => d.serial);
  return services.filter(s => !serials.some(c =>
    c === s.address || c.startsWith(s.name) || s.name === `adb-${c}` || s.name.startsWith(`adb-${c}-`)))
    .map(({ name, kind, address }) => ({ name, kind, address }));
}

/** Shell commands for one-round-trip device details (see sectionScript / parseSections). */
export const DEVICE_INFO_CMDS = {
  manufacturer: "getprop ro.product.manufacturer",
  model: "getprop ro.product.model",
  android: "getprop ro.build.version.release",
  sdk: "getprop ro.build.version.sdk",
  socManufacturer: "getprop ro.soc.manufacturer",
  socModel: "getprop ro.soc.model",
  platform: "getprop ro.board.platform",
  abi: "getprop ro.product.cpu.abi",
  gles: "dumpsys SurfaceFlinger 2>/dev/null | grep -m1 GLES",
  wmSize: "wm size 2>/dev/null",
  displays: "dumpsys SurfaceFlinger --display-id 2>/dev/null",
  battery: "cat /sys/class/power_supply/battery/capacity 2>/dev/null",
  df: "df -h /storage/emulated 2>/dev/null | tail -1",
};

/** GPU name from the SurfaceFlinger "GLES: <vendor>, <renderer>, <version>" line. */
export function parseGles(line) {
  return (String(line || "").replace(/^\s*GLES:\s*/, "").split(",")[1] || "").trim();
}

/** Free space column of a `df -h` data line ("/dev/fuse 465G 416G 49G 90% /storage/emulated"). */
export function parseDf(line) {
  const p = String(line || "").trim().split(/\s+/);
  return p.length >= 5 && !/^Filesystem$/i.test(p[0]) ? { size: p[1], used: p[2], free: p[3], usePct: p[4] } : null;
}

/** Effective screen size from `wm size` (an "Override size" line wins over "Physical size"). */
export function parseWmSize(text) {
  return (String(text || "").match(/\d+x\d+/g) || []).pop() || "";
}

/** Turn parseSections(DEVICE_INFO_CMDS output) into the discover fields. Missing values become "". */
export function deviceInfo(s) {
  const g = k => (s[k] || "").trim();
  return {
    manufacturer: g("manufacturer"), model: g("model"), android: g("android"), sdk: g("sdk"),
    soc: [g("socManufacturer"), g("socModel")].filter(Boolean).join(" ") || g("platform"),
    gpu: parseGles(s.gles),
    abi: g("abi"),
    screen: parseWmSize(s.wmSize),
    displays: (String(s.displays || "").match(/^Display \d+/gm) || []).length || 1,
    battery: /^\d+$/.test(g("battery")) ? g("battery") : "",
    storageFree: parseDf(s.df)?.free || "",
  };
}

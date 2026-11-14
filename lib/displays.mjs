// Multi-display support (dual-screen handhelds such as the AYN Thor).
//
// Android uses two ids per screen and different tools want different ones:
//   - logical id (0, 4, ...)            -> `input -d`, `am start --display`, dumpsys window/activity
//   - physical id (4630946441858561667) -> `screencap -d`, SurfaceFlinger
// `uiautomator dump` (Android <= 13) only sees the *focused* display, so taps derived from the UI
// tree must be sent to that display, not to the default display 0.
import { CliError } from "./errors.mjs";

/** One adb round trip worth of shell commands; parse with parseSections() then displayContext(). */
export const DISPLAY_CONTEXT_CMDS = {
  dinfo: "dumpsys display 2>/dev/null | grep -E '^ *mOverrideDisplayInfo='",
  focused: "dumpsys window 2>/dev/null | grep -m1 mTopFocusedDisplayId",
  acts: "dumpsys activity activities 2>/dev/null | grep -E '^ *Display #|topResumedActivity='",
  wake: "dumpsys power 2>/dev/null | grep -m1 mWakefulness=",
  wins: "dumpsys window windows 2>/dev/null | grep -E '^  Window #|mDisplayId=|isVisible='",
};

/**
 * `dumpsys window windows` filtered to "Window #", "mDisplayId=" and "isVisible=" lines
 * -> [{ pkg, display, visible }] (pkg is the part before "/" of the window title).
 */
export function parseWindows(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const w = /Window #\d+ Window\{\S+ \S+ ([^}\s]+)\}/.exec(line);
    if (w) { cur = { pkg: w[1].split("/")[0], display: null, visible: false }; out.push(cur); continue; }
    if (!cur) continue;
    const d = /mDisplayId=(\d+)/.exec(line);
    if (d) cur.display = Number(d[1]);
    if (/isVisible=true/.test(line)) cur.visible = true;
  }
  return out;
}

/**
 * Which display a `uiautomator dump` came from. uiautomator (Android <= 13) dumps the accessibility
 * "active window", which is usually but not always on the focused display (GPU-drawn apps are not
 * exposed, and it lags behind focus changes). Score each display by the root node: exact window
 * size match, a visible window of the same package, size fits, focused.
 */
export function displayForTree(ctx, root) {
  if (!root || ctx.displays.length < 2) return null;
  const w = root.bounds[2], h = root.bounds[3];
  let best = null, bestScore = -1;
  for (const d of ctx.displays) {
    let score = 0;
    if (d.width === w && d.height === h) score += 2;
    if ((ctx.windows || []).some(x => x.visible && x.display === d.id && x.pkg === root.pkg)) score += 2;
    else if (d.top && d.top.split("/")[0] === root.pkg) score += 2;
    if (w <= d.width && h <= d.height) score += 1;
    if (d.focused) score += 1;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/**
 * Parse `mOverrideDisplayInfo=DisplayInfo{"Built-in Screen", displayId 0", ... real 1920 x 1080, ...
 * rotation 1, ... uniqueId "local:4630946441858561667" ...}` lines (current size, after rotation).
 * Returns [{ id, name, width, height, physical, presentation }] sorted by id.
 */
export function parseDisplayInfo(text) {
  const list = [];
  for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const m = /DisplayInfo\{"([^"]*)", displayId (\d+)/.exec(line);
    if (!m) continue;
    const real = /\breal (\d+) x (\d+)/.exec(line);
    const uid = /uniqueId "local:(\d+)"/.exec(line);
    list.push({
      id: Number(m[2]),
      name: m[1],
      width: real ? Number(real[1]) : 0,
      height: real ? Number(real[2]) : 0,
      physical: uid ? uid[1] : "",
      presentation: /\bFLAG_PRESENTATION\b/.test(line),
    });
  }
  const seen = new Set();
  return list.filter(d => !seen.has(d.id) && seen.add(d.id)).sort((a, b) => a.id - b.id);
}

/** `mTopFocusedDisplayId=4` -> 4 (null if absent). */
export function parseFocusedDisplay(text) {
  const m = /mTopFocusedDisplayId=(-?\d+)/.exec(String(text ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * `dumpsys activity activities` filtered to "Display #N" and "topResumedActivity=" lines
 * -> { [id]: "pkg/.Activity" }.
 */
export function parseTopActivities(text) {
  const out = {};
  let cur = null;
  for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const d = /Display #(\d+)/.exec(line);
    if (d) { cur = Number(d[1]); continue; }
    const a = /topResumedActivity=ActivityRecord\{\S+ \S+ (\S+?)(?:\}| t\d+)/.exec(line);
    if (a && cur !== null && !(cur in out)) out[cur] = a[1];
  }
  return out;
}

/** Combine the parsed sections: { displays: [...with top, focused], focused }. */
export function displayContext(s) {
  const displays = parseDisplayInfo(s.dinfo);
  const focused = parseFocusedDisplay(s.focused);
  const top = parseTopActivities(s.acts);
  const windows = parseWindows(s.wins);
  for (const d of displays) {
    d.focused = d.id === focused;
    d.top = top[d.id] || "";
  }
  const asleep = /mWakefulness=(Asleep|Dozing)/.test(s.wake || "");
  return { displays, focused, windows, asleep };
}

/**
 * Resolve a user-supplied --display value (logical id or physical id) against the known displays.
 * Returns the display object, or null when the device reported no display info (single-screen
 * devices / old Android): callers then pass the value through unchanged.
 */
export function resolveDisplay(displays, value) {
  const v = String(value ?? "").trim();
  if (!/^\d+$/.test(v)) throw new CliError("--display needs a numeric display id (see: handroid displays)");
  if (!displays.length) return null;
  const d = displays.find(x => String(x.id) === v || x.physical === v);
  if (!d) throw new CliError(`no display "${v}". Known: ${displays.map(x => `${x.id} (physical ${x.physical || "?"})`).join(", ")}`);
  return d;
}

/** Human-readable table for `handroid displays`. */
export function formatDisplays({ displays }) {
  const rows = displays.map(d => [
    String(d.id), d.physical || "?", d.name, `${d.width}x${d.height}`, d.focused ? "*" : "", d.top || "-",
  ]);
  const head = ["id", "physical", "name", "size", "focus", "top activity"];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const fmt = r => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join("  ").trimEnd();
  return [fmt(head), ...rows.map(fmt)].join("\n");
}

/** Short description used in `ui` headers: `display 4 "Screen-2" 1240x1080`. */
export const describeDisplay = d => `display ${d.id} "${d.name}" ${d.width}x${d.height}`;

/** Validate a --display value before any adb call. */
export function checkDisplayArg(value) {
  if (!/^\d+$/.test(String(value ?? "").trim())) throw new CliError("--display needs a numeric display id (see: handroid displays)");
}

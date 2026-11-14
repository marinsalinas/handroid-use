import { CliError } from "./errors.mjs";

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decode XML entities in one pass (so "&amp;lt;" becomes "&lt;", not "<"). */
export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return NAMED[e.toLowerCase()];
  });
}

/**
 * Parse a `uiautomator dump` (<hierarchy><node ... bounds="[x1,y1][x2,y2]">...).
 * Returns [{ text, desc, id, cls, pkg, clickable, enabled, bounds: [x1,y1,x2,y2], cx, cy }].
 * Line breaks inside text are flattened to spaces so one node = one output line.
 * Throws if the dump is not a hierarchy (uiautomator prints errors such as
 * "ERROR: could not get idle state." instead).
 */
export function parseUiXml(xml) {
  xml = String(xml ?? "");
  if (!/<hierarchy[\s>]/.test(xml)) {
    const msg = xml.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new CliError(`uiautomator dump failed${msg ? `: ${msg}` : " (empty output)"}. The screen may be animating or asleep; try again, or use shot.`);
  }
  const flat = s => decodeEntities(s).replace(/\s*[\r\n]+\s*/g, " ").trim();
  const nodes = [];
  for (const m of xml.matchAll(/<node\s([^>]*?)\/?>/g)) {
    const at = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) at[a[1]] = a[2];
    const b = (at.bounds || "").match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!b) continue;
    const bounds = b.slice(1, 5).map(Number);
    nodes.push({
      text: flat(at.text), desc: flat(at["content-desc"]), id: decodeEntities(at["resource-id"] || ""),
      cls: at.class || "", pkg: at.package || "",
      clickable: at.clickable === "true", enabled: at.enabled !== "false",
      bounds,
      cx: Math.round((bounds[0] + bounds[2]) / 2), cy: Math.round((bounds[1] + bounds[3]) / 2),
    });
  }
  return nodes;
}

/**
 * Find the node to tap for `want`: exact text/content-desc first, then case-insensitive
 * substring of text or desc. Among equal matches prefer clickable, on-screen (non-zero area) ones.
 */
export function findNode(nodes, want) {
  const w = String(want).trim();
  if (!w) return undefined;
  const lw = w.toLowerCase();
  const visible = nodes.filter(n => n.bounds[2] > n.bounds[0] && n.bounds[3] > n.bounds[1]);
  const best = list => list.find(n => n.clickable) || list[0];
  return best(visible.filter(n => n.text === w || n.desc === w)) ||
         best(visible.filter(n => n.text.toLowerCase().includes(lw) || n.desc.toLowerCase().includes(lw)));
}

/** One line per node, as printed by `handroid ui`. */
export function formatNode(n, all = false) {
  return `${n.text.padEnd(38)} ${n.desc.padEnd(24)} ${n.clickable ? "[tap]" : "     "} ${n.cx},${n.cy}${all ? "  " + n.id : ""}`;
}

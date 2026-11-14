// SurfaceFlinger frame-timing parsing and fps statistics.
//
// `dumpsys SurfaceFlinger --latency <layer>` prints the refresh period in ns on the first line,
// then one row per frame (the last 127 frames):  desiredPresent  actualPresent  frameReady  (ns).
// Unfilled rows are "0 0 0"; a frame whose present fence has not signalled yet shows
// INT64_MAX (9223372036854775807). We use the actual-present column.

const PENDING = 9e18; // anything this large is INT64_MAX (pending), not a timestamp

/** Parse one --latency dump. Returns { refreshPeriodNs, presents: sorted valid present times }. */
export function parseLatency(text) {
  let refreshPeriodNs = 0;
  const presents = [];
  for (const raw of String(text).replace(/\r/g, "").split("\n")) {
    const p = raw.trim().split(/\s+/).filter(Boolean);
    if (p.length === 1 && /^\d+$/.test(p[0]) && !refreshPeriodNs && !presents.length) { refreshPeriodNs = Number(p[0]); continue; }
    if (p.length < 3 || !p.slice(0, 3).every(x => /^-?\d+$/.test(x))) continue;
    const t = Number(p[1]);
    if (t > 0 && t < PENDING) presents.push(t);
  }
  presents.sort((a, b) => a - b);
  return { refreshPeriodNs, presents };
}

/** Split the output of the on-device sampling loop (dumps separated by "---" lines). */
export function splitSamples(text) {
  return String(text).replace(/\r/g, "").split(/^---\s*$/m).map(parseLatency);
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

export const HITCH_MS = 50;
export const SLOW_MS = 33.4;

/**
 * Frame statistics from successive overlapping samples (arrays of present timestamps in ns).
 * Consecutive samples normally overlap (the 127-frame buffer covers ~1 s at 120 Hz and we sample
 * every 0.4 s), so only frames newer than the last one seen are counted. If a sample does not
 * overlap the previous one, frames were missed: the gap is excluded from the timing and counted
 * as a `break`, never as a hitch.
 *
 * Returns null when fewer than 2 frame intervals were seen (static screen), else
 * { frames, intervals, measuredMs, avgFps, low1Fps, low01Fps, worstMs, slowFrames, hitches, breaks, frameTimes }.
 * 1% / 0.1% low = fps at the 99th / 99.9th percentile frame time (nearest rank).
 */
export function frameStats(samples) {
  const frameTimes = [];
  let last = 0, breaks = 0, frames = 0, measuredMs = 0;
  for (const s of samples) {
    const ts = Array.isArray(s) ? [...s].sort((a, b) => a - b) : s.presents;
    const fresh = ts.filter(t => t > last);
    if (!fresh.length) continue;
    const overlaps = !last || ts[0] <= last; // shares at least one frame with what we saw before
    if (!overlaps) breaks++;
    let prev = overlaps ? last : 0;          // after a break, the gap is not a frame
    for (const t of fresh) {
      if (prev) { const d = (t - prev) / 1e6; frameTimes.push(d); measuredMs += d; }
      prev = t; frames++;
    }
    last = fresh[fresh.length - 1];
  }
  if (frameTimes.length < 2) return null;
  const sorted = [...frameTimes].sort((a, b) => a - b);
  return {
    frames,
    intervals: frameTimes.length,
    measuredMs,
    avgFps: frameTimes.length / (measuredMs / 1000),
    low1Fps: 1000 / percentile(sorted, 0.99),
    low01Fps: 1000 / percentile(sorted, 0.999),
    worstMs: sorted[sorted.length - 1],
    slowFrames: frameTimes.filter(d => d > SLOW_MS).length,
    hitches: frameTimes.filter(d => d > HITCH_MS).length,
    breaks,
    frameTimes,
  };
}

/** Recent render rate (fps) from a single --latency dump, over its last `n` frames. */
export function quickRate(latencyText, n = 40) {
  const ts = parseLatency(latencyText).presents.slice(-n);
  return ts.length < 2 ? 0 : (ts.length - 1) / ((ts[ts.length - 1] - ts[0]) / 1e9);
}

export function formatStats(st) {
  return [
    `avg fps:   ${st.avgFps.toFixed(1)}   (${st.frames} frames, ${(st.measuredMs / 1000).toFixed(1)} s measured)`,
    `1% low:    ${st.low1Fps.toFixed(1)} fps   0.1% low: ${st.low01Fps.toFixed(1)} fps`,
    `worst:     ${st.worstMs.toFixed(0)} ms   frames >33 ms: ${st.slowFrames}   hitches >50 ms: ${st.hitches}`,
    ...(st.breaks ? [`note: ${st.breaks} sampling window(s) did not overlap (slow adb); those gaps were excluded`] : []),
  ].join("\n");
}

// ---------- layer selection ----------

const NOT_A_BUFFER_LAYER = /ActivityRecord|InputSink|^Bounds for|^Background for|^Bounds\b|^Background\b|animation-leash|^Input Consumer|^WindowToken|^Task=|^TaskFragment|^Surface\(name=/;

/** Normalise a component "pkg/.Act" to "pkg/pkg.Act". */
export function expandComponent(c) {
  const m = /^([\w.]+)\/(\.[\w.$]+)$/.exec(c || "");
  return m ? `${m[1]}/${m[1]}${m[2]}` : (c || "");
}

/** Focused window component from `dumpsys window | grep mCurrentFocus` ("" when none). */
export function parseFocus(text) {
  const m = /mCurrentFocus=Window\{\S+ \S+ ([^}\s]+)\}/.exec(String(text)) ||
            /\{[^ ]+ [^ ]+ ([^}]+)\}/.exec(String(text));
  return m ? m[1].trim() : "";
}

/**
 * Pick the SurfaceFlinger layer to measure for `pattern` (case-insensitive substring of the
 * layer name) from `dumpsys SurfaceFlinger --list` output.
 * Preference: a layer of the focused activity > SurfaceView(BLAST) > SurfaceView > activity window
 * ("hash pkg/Activity#id") > anything else. Containers (ActivityRecord, Task, WindowToken, input
 * sinks, SurfaceView Bounds/Background) are never chosen. Ties go to the last one listed.
 */
export function findLayer(listText, pattern, focus = "") {
  const p = String(pattern).toLowerCase();
  if (!p) return "";
  const comp = expandComponent(focus);
  const layers = String(listText).replace(/\r/g, "").split("\n").map(s => s.trim())
    .filter(s => s && s.toLowerCase().includes(p) && !NOT_A_BUFFER_LAYER.test(s));
  let best = "", bestScore = -1;
  for (const s of layers) {
    let score = 1;
    if (s.includes("SurfaceView") && s.includes("(BLAST)")) score = 4;
    else if (s.includes("SurfaceView")) score = 3;
    else if (/\S\/\S/.test(s)) score = 2;
    if (comp && s.includes(comp)) score += 10;
    if (score >= bestScore) { best = s; bestScore = score; }
  }
  return best;
}

// Thermal zones and battery readings from sysfs.

/** Shell loop that prints "<zone type> <temp>" for every readable thermal zone. */
export const THERMAL_ZONES_CMD =
  'for z in /sys/class/thermal/thermal_zone*; do t=$(cat $z/type 2>/dev/null); v=$(cat $z/temp 2>/dev/null) || continue; echo "$t $v"; done';

/** Parse the THERMAL_ZONES_CMD output into [{ type, raw }]. */
export function parseThermalZones(text) {
  return String(text).replace(/\r/g, "").split("\n")
    .map(l => l.trim().split(/\s+/))
    .filter(p => p.length === 2 && p[0] && /^-?\d+$/.test(p[1]))
    .map(([type, v]) => ({ type, raw: Number(v) }));
}

/**
 * Convert a raw sysfs temperature to degrees C. Most kernels report millidegrees (36400),
 * some deci-degrees (364) or whole degrees (36). Returns NaN for sensors that are absent or
 * clearly bogus (<= 0, e.g. "-40960" for an unplugged wireless-charging sensor).
 */
export function toCelsius(raw) {
  if (!(raw > 0) || raw >= 150000) return NaN;
  if (raw > 1000) return raw / 1000;
  if (raw > 150) return raw / 10;
  return raw;
}

/** Max temperature (C) over zones whose type matches `re`, or NaN. */
export function maxTemp(zones, re) {
  const v = zones.filter(z => re.test(z.type)).map(z => toCelsius(z.raw)).filter(Number.isFinite);
  return v.length ? Math.max(...v) : NaN;
}

/** Battery current in mA (sysfs current_now is usually in uA, some kernels report mA). */
export function currentMa(raw) {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n)) return NaN;
  return Math.abs(n) > 20000 ? Math.abs(n) / 1000 : Math.abs(n);
}

const fmt = c => (Number.isFinite(c) ? `${c.toFixed(1)} C` : "n/a");

/**
 * The `thermals` line. `battery` = { current, capacity, status } raw strings (any may be missing).
 * e.g. "temps: CPU 39.6 C | GPU 36.4 C | battery 28.0 C | battery 100% Full, 0 mA"
 */
export function formatThermals(zones, battery = {}) {
  let line = `temps: CPU ${fmt(maxTemp(zones, /cpu/i))} | GPU ${fmt(maxTemp(zones, /gpu/i))} | battery ${fmt(maxTemp(zones, /^battery$/i))}`;
  if (battery.capacity) {
    const ma = currentMa(battery.current);
    line += ` | battery ${battery.capacity}%${battery.status ? " " + battery.status : ""}${Number.isFinite(ma) ? `, ${ma.toFixed(0)} mA` : ""}`;
  }
  return line;
}

// Helpers for building commands run by the device shell (`adb shell <cmd>`).
// adb joins its shell arguments with spaces and hands the line to /system/bin/sh,
// so anything that is not a fixed token must be quoted.

/** Quote one word for the device's POSIX shell. */
export const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Argument for `input text`: spaces become %s (what `input text` expects) and the
 * whole thing is single-quoted, so shell metacharacters (# ? * ; & ( ) $ ` " ' ...)
 * reach `input` literally instead of being interpreted by the device shell.
 */
export function inputTextArg(text) {
  return quote(String(text).replace(/ /g, "%s"));
}

/** `input text` can only type ASCII through the default key character map. */
export const isAsciiPrintable = s => /^[\x20-\x7e]*$/.test(s);

/**
 * Build a single shell script that prints each command's output under an `@@key` marker,
 * so several values can be fetched with one adb round trip. Parse with parseSections().
 */
export function sectionScript(map) {
  return Object.entries(map).map(([k, cmd]) => `echo '@@${k}'; ${cmd}`).join("; ");
}

/** Inverse of sectionScript(): { key: "output (trimmed, \r removed)" }. */
export function parseSections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text).replace(/\r/g, "").split("\n")) {
    const m = /^@@([\w.-]+)$/.exec(line.trim());
    if (m) { cur = m[1]; out[cur] = []; continue; }
    if (cur) out[cur].push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join("\n").trim();
  return out;
}

// Package names: letters, digits, underscore, dots (Android's own rule is stricter).
export const isPackageName = s => /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(s);
export const isInt = s => /^-?\d+$/.test(String(s));

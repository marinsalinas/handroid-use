// Directory copies between the computer and the device: listing, planning and hashing.
// Incremental and resumable: a file is copied only when it is missing on the other side or its size
// differs (or, with --checksum, its sha256 differs). Nothing is ever deleted on either side.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { quote as q } from "./shell.mjs";

/** sha256 of a local file, streamed in 4 MB blocks (works for files larger than 2 GB). */
export function sha256File(f) {
  const h = createHash("sha256");
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
  const fd = fs.openSync(f, "r");
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

/** Local files under `dir`: Map(relative posix path -> size). */
export function listLocal(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) out.set(r, fs.statSync(p).size);
    }
  };
  walk(dir, "");
  return out;
}

/** Device command listing `dir` as "<size> ./<relative path>" lines. */
export const remoteListCmd = dir => `cd ${q(dir)} 2>/dev/null && find . -type f -exec stat -c '%s %n' {} +`;

/** Parse remoteListCmd output: Map(relative path -> size). */
export function parseRemoteList(text) {
  const out = new Map();
  for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const m = /^(\d+) \.\/(.+)$/.exec(line);
    if (m) out.set(m[2], Number(m[1]));
  }
  return out;
}

/** Parse `sha256sum` output ("<hex>  ./<rel>" or "<hex>  <rel>"): Map(rel -> hex). */
export function parseSums(text) {
  const out = new Map();
  for (const line of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const m = /^([0-9a-f]{64}) [ *]?(?:\.\/)?(.+)$/.exec(line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/**
 * Device commands running `verb` (e.g. "sha256sum", "chmod 660") on `rels` inside `dir`, split so no
 * command line gets too long. Paths are passed as ./<rel>, relative to `dir`.
 */
export function remoteChunkCmds(dir, rels, verb, maxLen = 60000) {
  const cmds = [];
  let cur = [], len = 0;
  for (const r of rels) {
    const a = q("./" + r);
    if (cur.length && len + a.length > maxLen) { cmds.push(cur); cur = []; len = 0; }
    cur.push(a); len += a.length + 1;
  }
  if (cur.length) cmds.push(cur);
  return cmds.map(c => `cd ${q(dir)} && ${verb} ${c.join(" ")}`);
}

/**
 * What to copy from `src` to `dst` (Maps rel -> size; optional Maps rel -> sha256).
 * Returns { copy: [rel], same: [rel], extra: [rel only in dst], bytes }.
 */
export function planSync(src, dst, srcSums = null, dstSums = null) {
  const copy = [], same = [];
  let bytes = 0;
  for (const [rel, size] of src) {
    const differs = !dst.has(rel) || dst.get(rel) !== size ||
      (srcSums && dstSums && srcSums.get(rel) !== dstSums.get(rel));
    if (differs) { copy.push(rel); bytes += size; } else same.push(rel);
  }
  const extra = [...dst.keys()].filter(r => !src.has(r));
  return { copy: copy.sort(), same, extra: extra.sort(), bytes };
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

/** "a/b" + "c d/e" -> "a/b/c d/e" for device paths. */
export const devJoin = (dir, rel) => `${dir.replace(/\/+$/, "")}/${rel}`;

/** Timestamp for snapshot folder names: 20261114-153012. */
export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

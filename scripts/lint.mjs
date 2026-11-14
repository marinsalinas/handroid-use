// Zero-dependency lint: syntax-check every JS module with `node --check`, and keep the
// package free of runtime dependencies.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
for (const dir of ["bin", "lib", "test", "scripts"]) {
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "fixtures") walk(p); }
      else if (/\.[cm]?js$/.test(e.name)) files.push(p);
    }
  };
  if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
}

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) { failed++; process.stderr.write(`${path.relative(root, f)}\n${r.stderr}\n`); }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const k of ["dependencies", "peerDependencies", "optionalDependencies"]) {
  if (pkg[k] && Object.keys(pkg[k]).length) { failed++; console.error(`package.json: ${k} must stay empty (zero runtime dependencies)`); }
}

console.log(`lint: ${files.length} files checked, ${failed ? failed + " problem(s)" : "ok"}`);
process.exitCode = failed ? 1 : 0;

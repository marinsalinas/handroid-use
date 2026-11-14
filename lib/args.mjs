import { CliError } from "./errors.mjs";

// Flags that take a value: `--display 3`, `--display=3`.
const VALUE_FLAGS = new Set(["display", "sha256", "serial"]);

/**
 * Parse the CLI argv (without node and the script path).
 * - `--serial <id>` / `-s <id>` / `--serial=<id>` select the device.
 * - `--flag value` only for VALUE_FLAGS; any other `--flag` is boolean.
 * - `--` ends option parsing (so `type -- --literal` types "--literal").
 * - `-h` is `--help`.
 * Returns { command, args, flags, serial }.
 */
export function parseArgs(argv) {
  const flags = {};
  const args = [];
  let serial;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { args.push(...argv.slice(i + 1)); break; }
    if (a === "-h") { flags.help = true; continue; }
    let key = null, value;
    if (a === "-s") key = "serial";
    else if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      if (eq > 2) { key = a.slice(2, eq); value = a.slice(eq + 1); }
      else key = a.slice(2);
    }
    if (key === null) { args.push(a); continue; }
    if (VALUE_FLAGS.has(key)) {
      if (value === undefined) {
        const nx = argv[i + 1];
        if (nx === undefined || nx.startsWith("--")) throw new CliError(`--${key} needs a value`);
        value = nx; i++;
      }
      if (value === "") throw new CliError(`--${key} needs a value`);
      if (key === "serial") serial = value; else flags[key] = value;
    } else {
      flags[key] = value === undefined ? true : value;
    }
  }
  const command = args.shift();
  return { command, args, flags, serial };
}

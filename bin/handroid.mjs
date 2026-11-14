#!/usr/bin/env node
// handroid (handroid-use): small, dependency-free adb helper CLI for AI agents (and humans).
// Works on Windows, Linux and macOS. Requires Node 18+ and adb. The logic lives in ../lib.
// `handroid mcp` serves the same commands as MCP tools over stdio.
import { main } from "../lib/cli.mjs";

const argv = process.argv.slice(2);
if (argv[0] === "mcp") {
  const { serve } = await import("../lib/mcp.mjs");
  await serve();
} else {
  process.exitCode = main(argv);
}

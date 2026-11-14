#!/usr/bin/env node
// android-use: small, dependency-free adb helper CLI for AI agents (and humans).
// Works on Windows, Linux and macOS. Requires Node 18+ and adb. The logic lives in ../lib.
import { main } from "../lib/cli.mjs";

process.exitCode = main(process.argv.slice(2));

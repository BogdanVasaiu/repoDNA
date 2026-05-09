#!/usr/bin/env node
import { startServer } from "./server.mjs";

var args = process.argv.slice(2);
var debugMode = args.includes("--debug");

if (debugMode) {
  process.env.REPODNA_DEBUG = "1";
  console.log(
    "  [debug] Debug mode ON — writing per-file stats to repodna-debug.log",
  );
}

startServer().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DATA_DIR = join(homedir(), ".repodna");

if (!existsSync(DATA_DIR)) {
  console.log("Nothing to remove — ~/.repodna does not exist.");
  process.exit(0);
}

const args = process.argv.slice(2);
const force = args.includes("--yes") || args.includes("-y");

if (!force) {
  console.log("\n  This will permanently delete:");
  console.log("    " + DATA_DIR);
  console.log(
    "\n  (your projects are untouched — only repoDNA data is removed)",
  );
  console.log("\n  Run with --yes to confirm:\n");
  console.log("    node uninstall.mjs --yes\n");
  process.exit(0);
}

try {
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log("\n  ✓ ~/.repodna removed successfully.\n");
} catch (e) {
  console.error("\n  ✗ Failed to remove ~/.repodna:", e.message, "\n");
  process.exit(1);
}

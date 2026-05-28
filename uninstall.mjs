#!/usr/bin/env node
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

const DATA_DIR = join(homedir(), ".repodna");
const SERVER_PORT = 3741;

// ─── ANSI colors ──────────────────────────────────────────
const R = "\x1b[31m"; // red — errors
const G = "\x1b[32m"; // green — success
const Y = "\x1b[33m"; // yellow — warnings
const C = "\x1b[36m"; // cyan — paths / commands
const B = "\x1b[1m";  // bold
const D = "\x1b[2m";  // dim — secondary text
const X = "\x1b[0m";  // reset

async function isServerRunning() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 500);
    const res = await fetch("http://localhost:" + SERVER_PORT + "/api/ping", { signal: ctl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

if (await isServerRunning()) {
  console.log("\n  " + R + "✗" + X + " repoDNA is currently running on port " + B + SERVER_PORT + X + ".");
  console.log("    Stop it first (Ctrl+C in the terminal running " + C + "node main.mjs" + X + "),");
  console.log("    " + D + "then run this command again." + X + "\n");
  process.exit(1);
}

if (!existsSync(DATA_DIR)) {
  console.log(D + "Nothing to remove — ~/.repodna does not exist." + X);
  process.exit(0);
}

function prompt(q) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    // EOF / closed stdin (non-TTY, Ctrl+D) fires "close" without ever calling
    // the question callback — resolve empty so the promise always settles.
    // The guard prevents the rl.close() below (which also emits "close") from
    // clobbering a real answer with "".
    rl.on("close", () => { if (!answered) resolve(""); });
    rl.question(q, (ans) => { answered = true; resolve(ans); rl.close(); });
  });
}

const args = process.argv.slice(2);
const force = args.includes("--yes") || args.includes("-y");

if (!force) {
  console.log("\n  This will " + B + R + "permanently delete" + X + ":");
  console.log("    " + C + DATA_DIR + X);
  console.log(
    "\n  " + D + "(your projects are untouched — only repoDNA data is removed)" + X,
  );
  const ans = (await prompt("\n  Proceed with uninstall? [y/N] ")).trim().toLowerCase();
  if (ans !== "y" && ans !== "yes") {
    console.log("  " + D + "Uninstall cancelled." + X + "\n");
    process.exit(0);
  }
}

try {
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log("\n  " + G + "✓" + X + " " + C + "~/.repodna" + X + " removed successfully.\n");
} catch (e) {
  console.error("\n  " + R + "✗" + X + " Failed to remove " + C + "~/.repodna" + X + ": " + e.message + "\n");
  process.exit(1);
}

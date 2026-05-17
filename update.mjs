#!/usr/bin/env node
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));
const CURRENT = pkg.version;
const GITHUB_REPO = "BogdanVasaiu/repodna";
const SERVER_PORT = 3741;

// ─── ANSI colors ──────────────────────────────────────────
const R = "\x1b[31m"; // red — errors
const G = "\x1b[32m"; // green — success
const Y = "\x1b[33m"; // yellow — warnings
const C = "\x1b[36m"; // cyan — paths / commands / URLs
const B = "\x1b[1m";  // bold
const D = "\x1b[2m";  // dim — secondary text
const X = "\x1b[0m";  // reset

const args = process.argv.slice(2);
const force = args.includes("--force") || args.includes("-f");

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

function run(cmd) {
  return execSync(cmd, { cwd: __dirname, encoding: "utf-8" }).trim();
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

console.log("\n  " + B + "repoDNA updater" + X);
console.log(D + "  ───────────────────────────────────" + X);
console.log("  Current version: " + B + CURRENT + X);

let latest, releaseUrl;
try {
  process.stdout.write("  Checking GitHub for latest release... ");
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    { headers: { "User-Agent": "repoDNA/" + CURRENT } }
  );
  if (!res.ok) throw new Error("GitHub API returned " + res.status);
  const data = await res.json();
  latest = (data.tag_name || "").replace(/^v/, "");
  releaseUrl = data.html_url || "";
  console.log(G + "done" + X);
} catch (e) {
  console.log(R + "failed" + X);
  console.error("\n  " + R + "✗" + X + " Could not reach GitHub: " + e.message + "\n");
  process.exit(1);
}

console.log("  Latest version:  " + B + latest + X);

if (compareVersions(latest, CURRENT) <= 0) {
  console.log("\n  " + G + "✓" + X + " You are already on the latest version.\n");
  process.exit(0);
}

console.log("\n  New version available: " + B + CURRENT + X + " → " + B + G + latest + X);
console.log("  " + C + releaseUrl + X);

const dirty = run("git status --porcelain");

if (dirty && !force) {
  console.log("\n  " + R + "✗" + X + " You have uncommitted local changes:");
  dirty.split("\n").forEach(l => console.log("      " + D + l + X));
  console.log("\n  Update aborted to protect your work.");
  console.log("  " + D + "Use " + X + C + "--force" + X + D + " to stash them automatically." + X + "\n");
  process.exit(1);
}

let stashed = false;
if (dirty && force) {
  console.log("\n  " + D + "Stashing local changes..." + X);
  run("git stash push -m \"repodna-update-autostash\"");
  stashed = true;
}

console.log("\n  " + D + "Pulling latest changes..." + X);
try {
  run("git fetch origin");
  const out = run("git pull --ff-only origin main");
  console.log("  " + D + out.split("\n").join("\n  ") + X);
} catch (e) {
  console.error("  " + R + "✗" + X + " git pull failed: " + e.message);
  if (stashed) {
    try { run("git stash pop"); } catch (_) {}
  }
  process.exit(1);
}

if (stashed) {
  try {
    run("git stash pop");
    console.log("  " + G + "✓" + X + " Stash restored.");
  } catch (e) {
    console.warn("  " + Y + "⚠" + X + " Could not restore stash: run " + C + "git stash pop" + X + " manually.");
  }
}

console.log("\n  " + G + "✓" + X + " Updated to " + B + G + latest + X + "!");
console.log("  Restart repoDNA to apply:\n");
console.log("    " + C + "node main.mjs" + X + "\n");

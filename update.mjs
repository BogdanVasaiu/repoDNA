#!/usr/bin/env node
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));
const CURRENT = pkg.version;
const GITHUB_REPO = "BogdanVasaiu/repodna";

const args = process.argv.slice(2);
const force = args.includes("--force") || args.includes("-f");

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

console.log("\n  repoDNA updater");
console.log("  ───────────────────────────────────");
console.log("  Current version: " + CURRENT);

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
  console.log("done");
} catch (e) {
  console.log("failed");
  console.error("\n  ✗ Could not reach GitHub: " + e.message + "\n");
  process.exit(1);
}

console.log("  Latest version:  " + latest);

if (compareVersions(latest, CURRENT) <= 0) {
  console.log("\n  ✓ You are already on the latest version.\n");
  process.exit(0);
}

console.log("\n  New version available: " + CURRENT + " → " + latest);
console.log("  " + releaseUrl);

const dirty = run("git status --porcelain");

if (dirty && !force) {
  console.log("\n  ✗ You have uncommitted local changes:");
  dirty.split("\n").forEach(l => console.log("      " + l));
  console.log("\n  Update aborted to protect your work.");
  console.log("  Use --force to stash them automatically.\n");
  process.exit(1);
}

let stashed = false;
if (dirty && force) {
  console.log("\n  Stashing local changes...");
  run("git stash push -m \"repodna-update-autostash\"");
  stashed = true;
}

console.log("\n  Pulling latest changes...");
try {
  run("git fetch origin");
  const out = run("git pull --ff-only origin main");
  console.log("  " + out.split("\n").join("\n  "));
} catch (e) {
  console.error("  ✗ git pull failed: " + e.message);
  if (stashed) {
    try { run("git stash pop"); } catch (_) {}
  }
  process.exit(1);
}

if (stashed) {
  try {
    run("git stash pop");
    console.log("  ✓ Stash restored.");
  } catch (e) {
    console.warn("  ⚠ Could not restore stash: run 'git stash pop' manually.");
  }
}

console.log("\n  ✓ Updated to " + latest + "!");
console.log("  Restart repoDNA to apply:\n");
console.log("    node main.mjs\n");

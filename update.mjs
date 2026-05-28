#!/usr/bin/env node
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));
const CURRENT = pkg.version;
const CURRENT_SCHEMA = typeof pkg.dataSchema === "number" ? pkg.dataSchema : 0;
const GITHUB_REPO = "BogdanVasaiu/repodna";
const SERVER_PORT = 3741;

// ─── ANSI colors ──────────────────────────────────────────
const R = "\x1b[31m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const X = "\x1b[0m";

// ─── ARGUMENT PARSING ─────────────────────────────────────
const args = process.argv.slice(2);
const force = args.includes("--force") || args.includes("-f");
const yes   = args.includes("--yes") || args.includes("-y");
function argOf(name) {
  const i = args.findIndex(a => a === name || a.startsWith(name + "="));
  if (i < 0) return null;
  const a = args[i];
  if (a.includes("=")) return a.split("=").slice(1).join("=");
  return args[i + 1] || null;
}
const targetArg = argOf("--to"); // optional: pin to a specific tag

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
  // Capture stderr too (don't let git's progress/hint chatter leak to the
  // terminal). On failure execSync throws with .stderr attached.
  return execSync(cmd, { cwd: __dirname, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function prompt(q) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, ans => { rl.close(); resolve(ans); });
  });
}

// ─── REMOTE METADATA FETCH ─────────────────────────────────
// Pull the target tag's package.json and migrations.mjs straight from
// raw.githubusercontent.com so we can analyse cache compatibility
// BEFORE running git pull / git checkout.
async function fetchRawAtTag(tag, path) {
  const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${tag}/${path}`;
  const res = await fetch(url, { headers: { "User-Agent": "repoDNA-updater/" + CURRENT } });
  if (!res.ok) throw new Error(path + " not found at " + tag + " (HTTP " + res.status + ")");
  return await res.text();
}

// Parse migrations.mjs without executing any code (security).
// We only need: CACHE_SCHEMA value and the set of MIGRATIONS keys plus,
// for each key, whether the value is `null` (breaking) or a function
// (transform / identity — at parse time we cannot distinguish them).
function parseMigrationsModule(text) {
  // Strip comments so they can't fake entries.
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  const schemaMatch = cleaned.match(/export\s+const\s+DATA_SCHEMA\s*=\s*(\d+)/);
  const schema = schemaMatch ? parseInt(schemaMatch[1], 10) : 0;

  const entries = {};
  const startIdx = cleaned.search(/export\s+const\s+MIGRATIONS\s*=\s*\{/);
  if (startIdx < 0) return { schema, entries };

  // Find the matching closing brace for the MIGRATIONS object literal.
  let braceDepth = 0, started = false, bodyStart = -1, bodyEnd = -1;
  for (let i = startIdx; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") { if (!started) { started = true; bodyStart = i + 1; } braceDepth++; }
    else if (ch === "}") { braceDepth--; if (braceDepth === 0) { bodyEnd = i; break; } }
  }
  if (bodyStart < 0 || bodyEnd < 0) return { schema, entries };

  // Split the body on TOP-LEVEL commas only — arrow bodies can contain commas.
  const body = cleaned.slice(bodyStart, bodyEnd);
  const parts = [];
  let depth = 0, cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);

  for (const part of parts) {
    const m = part.match(/^\s*(\d+)\s*:\s*([\s\S]+)$/);
    if (!m) continue;
    const key = parseInt(m[1], 10);
    const valTok = m[2].trim();
    entries[key] = /^null\b/.test(valTok) ? null : "transform";
  }
  return { schema, entries };
}

function classifyChain(fromSchema, toSchema, entries) {
  if (toSchema === fromSchema) return { kind: "compatible", steps: 0 };
  if (toSchema < fromSchema)   return { kind: "downgrade",  steps: 0 };
  let hasTransform = false;
  let breakAt = -1;
  for (let v = fromSchema; v < toSchema; v++) {
    const step = entries[v];
    if (step === null || step === undefined) { breakAt = v; break; }
    hasTransform = true;
  }
  if (breakAt >= 0) return { kind: "incompatible", breakAt, steps: breakAt - fromSchema };
  return { kind: hasTransform ? "semi" : "compatible", steps: toSchema - fromSchema };
}

// ─── HEADER ────────────────────────────────────────────────
console.log("\n  " + B + "repoDNA updater" + X);
console.log(D + "  ───────────────────────────────────" + X);
console.log("  Current version: " + B + CURRENT + X + D + "  (cache schema " + CURRENT_SCHEMA + ")" + X);

// ─── DETERMINE TARGET ──────────────────────────────────────
let targetTag, targetVersion, releaseUrl = "";
try {
  if (targetArg) {
    targetTag = targetArg.startsWith("v") ? targetArg : "v" + targetArg;
    targetVersion = targetTag.replace(/^v/, "");
    console.log("  Target version:  " + B + targetVersion + X + D + "  (pinned via --to)" + X);
  } else {
    process.stdout.write("  Checking GitHub for latest release... ");
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { "User-Agent": "repoDNA/" + CURRENT } }
    );
    if (!res.ok) throw new Error("GitHub API returned " + res.status);
    const data = await res.json();
    targetVersion = (data.tag_name || "").replace(/^v/, "");
    targetTag = data.tag_name || "v" + targetVersion;
    releaseUrl = data.html_url || "";
    console.log(G + "done" + X);
    console.log("  Latest version:  " + B + targetVersion + X);
  }
} catch (e) {
  console.log(R + "failed" + X);
  console.error("\n  " + R + "✗" + X + " Could not reach GitHub: " + e.message + "\n");
  process.exit(1);
}

if (!targetArg && compareVersions(targetVersion, CURRENT) <= 0) {
  console.log("\n  " + G + "✓" + X + " You are already on the latest version.\n");
  process.exit(0);
}

// ─── CHAIN ANALYSIS ────────────────────────────────────────
process.stdout.write("  Analysing cache compatibility... ");
let analysis = null;
try {
  const remotePkgText = await fetchRawAtTag(targetTag, "package.json");
  const remotePkg = JSON.parse(remotePkgText);
  const remoteSchema = typeof remotePkg.dataSchema === "number" ? remotePkg.dataSchema : 0;

  let entries = {};
  try {
    const migText = await fetchRawAtTag(targetTag, "src/migrations.mjs");
    entries = parseMigrationsModule(migText).entries;
  } catch {
    // Pre-2.0.0 versions don't have migrations.mjs — fall back to "incompatible
    // if schemas differ, compatible if they match".
    entries = {};
  }
  analysis = classifyChain(CURRENT_SCHEMA, remoteSchema, entries);
  analysis.remoteSchema = remoteSchema;
  console.log(G + "done" + X);
} catch (e) {
  console.log(Y + "skipped" + X + D + " (" + e.message + ")" + X);
  analysis = { kind: "unknown", remoteSchema: -1 };
}

// ─── PRESENT THE PLAN ──────────────────────────────────────
console.log("");
if (CURRENT !== targetVersion) {
  console.log("  Update plan: " + B + CURRENT + X + " → " + B + G + targetVersion + X);
}
if (releaseUrl) console.log("  " + C + releaseUrl + X);

if (analysis.kind === "compatible") {
  console.log("  " + G + "✓ Data store: compatible" + X + D + " (kept as-is, no data loss)" + X);
} else if (analysis.kind === "semi") {
  console.log("  " + Y + "⚠ Data store: semi-compatible" + X +
    D + " (" + analysis.steps + " migration step(s) — data transformed in place on first launch; previous store backed up)" + X);
} else if (analysis.kind === "incompatible") {
  console.log("  " + R + "✗ Data store: incompatible" + X +
    D + " (break at schema " + analysis.breakAt + " → " + (analysis.breakAt + 1) + ")" + X);
  console.log("    On first launch your entire repoDNA store (projects, settings, caches) will be");
  console.log("    " + B + "cleared and started from zero" + X + " — before any data is loaded.");
  console.log("    " + D + "The previous store is preserved at ~/.repodna.incompatible-bak-<timestamp>" + X);
  console.log("    " + D + "To stay on an earlier compatible release, pin a tag with " + X +
    C + "--to v<version>" + X + D + " (see " + X + C + "https://github.com/" + GITHUB_REPO + "/releases" + X + D + ")." + X);
} else if (analysis.kind === "downgrade") {
  console.log("  " + Y + "⚠ Data store: target schema is older than current — store will be left untouched." + X);
} else {
  console.log("  " + D + "Data store: unknown (could not analyse remote migrations)." + X);
}

// ─── CONFIRM ───────────────────────────────────────────────
if (!yes) {
  const ans = (await prompt("\n  Proceed with update? [Y/n] ")).trim().toLowerCase();
  if (ans && ans !== "y" && ans !== "yes") {
    console.log("  " + D + "Update cancelled." + X + "\n");
    process.exit(0);
  }
}

// ─── DIRTY WORKING TREE CHECK ──────────────────────────────
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

// ─── DO THE UPDATE ─────────────────────────────────────────
console.log("\n  " + D + "Pulling " + targetTag + "..." + X);
try {
  run("git fetch origin --tags");
  if (targetArg) {
    // Pinned update: check out the exact tag (detached HEAD).
    run("git checkout " + targetTag);
    console.log("  " + D + "Checked out " + targetTag + X);
  } else {
    try {
      const out = run("git pull --ff-only origin main");
      console.log("  " + D + out.split("\n").join("\n  ") + X);
    } catch (ffErr) {
      // Local main diverged from origin (local commits, or an edited/detached
      // tree) so a fast-forward isn't possible. Fall back to checking out the
      // release tag directly — that lands exactly on the released code
      // regardless of local branch state. The working tree is already clean
      // here (committed, or stashed above), so checkout is safe.
      console.log("  " + Y + "⚠" + X + " Fast-forward not possible (local history diverged).");
      console.log("  " + D + "Checking out " + targetTag + " directly..." + X);
      run("git checkout " + targetTag);
      console.log("  " + D + "Checked out " + targetTag + X);
    }
  }
} catch (e) {
  console.error("  " + R + "✗" + X + " update failed: " + e.message);
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

console.log("\n  " + G + "✓" + X + " Updated to " + B + G + targetVersion + X + "!");
if (analysis.kind === "incompatible") {
  console.log("  " + Y + "Heads-up:" + X + " your data store will be cleared from zero on first launch (previous store backed up).");
} else if (analysis.kind === "semi") {
  console.log("  " + D + "Your data store will be migrated on first launch (previous store backed up)." + X);
}
console.log("  Restart repoDNA to apply:\n");
console.log("    " + C + "node main.mjs" + X + "\n");

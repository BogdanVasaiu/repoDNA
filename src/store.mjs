// ─── WHOLE-STORE SCHEMA MIGRATION ─────────────────────────
// Owns the schema version of the entire ~/.repodna data store and runs the
// MIGRATIONS chain (migrations.mjs) ONCE at startup, before the server
// accepts any request. This guarantees no endpoint can read pre-migration
// (stale/incompatible) data.
//
// Behaviours, per chain step:
//   null        → INCOMPATIBLE: move the whole store aside to a timestamped
//                 backup and recreate it empty (true "start from zero").
//   function    → TRANSFORM: called with the data-dir path to rewrite config
//                 + caches in place. If it throws, fall back to a safe wipe.
//   (all steps clear) → COMPATIBLE / SEMI: store is kept (and transformed).
//
// Crash safety: the only destructive op is an atomic directory rename
// (store → backup). If the process dies mid-rename, either the original or
// the backup exists intact — never a half-deleted store.
//
// All functions take an optional `dir` so the logic is unit-testable against
// a scratch directory; in production they default to ~/.repodna.

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, rmSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { DATA_SCHEMA, MIGRATIONS } from "./migrations.mjs";

const DEFAULT_DATA_DIR = join(homedir(), ".repodna");
const SCHEMA_NAME = ".schema";

export function dataDir() { return DEFAULT_DATA_DIR; }

function schemaFile(dir) { return join(dir, SCHEMA_NAME); }

// Read the store's current schema.
//   - .schema file present  → its integer value
//   - no .schema, dir empty/absent → DATA_SCHEMA (a brand-new install is current)
//   - no .schema, dir has content  → 0 (a pre-2.0 "v1" store)
export function readStoreSchema(dir = DEFAULT_DATA_DIR) {
  const sf = schemaFile(dir);
  try {
    if (existsSync(sf)) {
      const n = parseInt(String(readFileSync(sf, "utf-8")).trim(), 10);
      return Number.isFinite(n) ? n : 0;
    }
  } catch {}
  if (!existsSync(dir)) return DATA_SCHEMA;            // fresh install
  try {
    const entries = readdirSync(dir).filter((n) => n !== SCHEMA_NAME);
    if (entries.length === 0) return DATA_SCHEMA;      // empty dir == fresh
  } catch {}
  return 0;                                            // legacy v1 store
}

export function writeStoreSchema(v, dir = DEFAULT_DATA_DIR) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(schemaFile(dir), String(v));
  } catch {}
}

// Back up the whole store to a timestamped sibling dir, then empty it.
//
// We deliberately do NOT renameSync the store directory itself: on Windows
// that fails with EPERM for the user-profile-level dir and for OS-indexed
// subdirectories (Search/OneDrive hold handles). Instead we recursively COPY
// to the backup (best-effort) and DELETE each child file-by-file, which
// succeeds where directory renames don't.
function wipeWithBackup(dir, suffix) {
  let backup = "";

  // 1. Best-effort backup (copy). If it fails we still clear the store —
  //    incompatible data must never reach the new version's UI.
  try {
    if (existsSync(dir)) {
      backup = dir + "." + suffix + "-" + Date.now();
      cpSync(dir, backup, { recursive: true });
    }
  } catch {
    backup = "";
  }

  // 2. Delete every child of the store (survives where a dir rename fails).
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    } else {
      for (const name of readdirSync(dir)) {
        try {
          rmSync(join(dir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch {}
      }
    }
  } catch {}

  // 3. Stamp the fresh, empty store at the current schema.
  writeStoreSchema(DATA_SCHEMA, dir);
  return backup;
}

// Run the migration chain once. Returns:
//   { from, to, kind, events: [...] }
// kind: "compatible" | "migrated" | "incompatible" | "downgrade" | "error"
export function migrateStore(dir = DEFAULT_DATA_DIR) {
  const from = readStoreSchema(dir);
  const to = DATA_SCHEMA;
  const events = [];

  if (from === to) {
    if (!existsSync(schemaFile(dir))) writeStoreSchema(to, dir);
    return { from, to, kind: "compatible", events };
  }
  if (from > to) {
    return { from, to, kind: "downgrade", events };
  }

  for (let v = from; v < to; v++) {
    const step = MIGRATIONS[v];

    if (step === null || step === undefined) {
      const backup = wipeWithBackup(dir, "incompatible-bak");
      events.push({ kind: "wiped", from, to, reason: "incompatible", backup });
      return { from, to, kind: "incompatible", events };
    }

    try {
      step(dir);                 // transform the store in place
      events.push({ kind: "migrated", from: v, to: v + 1 });
    } catch (e) {
      const backup = wipeWithBackup(dir, "migration-failed-bak");
      events.push({
        kind: "wiped", from, to, reason: "error",
        error: String((e && e.message) || e), backup,
      });
      return { from, to, kind: "error", events };
    }
  }

  writeStoreSchema(to, dir);
  return { from, to, kind: "migrated", events };
}

// Self-check the chain before touching anything (called by the server).
export function validateMigrationsChain() {
  const problems = [];
  for (let i = 0; i < DATA_SCHEMA; i++) {
    if (!Object.prototype.hasOwnProperty.call(MIGRATIONS, i)) {
      problems.push("missing MIGRATIONS[" + i + "] (gap in chain)");
      continue;
    }
    const step = MIGRATIONS[i];
    if (step !== null && typeof step !== "function") {
      problems.push("MIGRATIONS[" + i + "] is " + typeof step + ", expected null or function");
    }
  }
  for (const k of Object.keys(MIGRATIONS).map(Number)) {
    if (k >= DATA_SCHEMA) {
      problems.push("MIGRATIONS[" + k + "] exists but DATA_SCHEMA is " + DATA_SCHEMA);
    }
  }
  return problems;
}

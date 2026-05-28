// ─── VERSIONED + CRASH-SAFE CACHE I/O ─────────────────────
// Every cache file is wrapped as:
//   { _schemaVersion: <CACHE_SCHEMA>, data: <payload> }
//
// Writes are atomic:
//   1. snapshot existing file → <file>.bak     (so a crash can restore)
//   2. write new content      → <file>.tmp
//   3. atomic rename          → <file>
//   4. delete <file>.bak
//
// Reads call recoverCacheFile() first to undo any partial write left from
// a previous crash. Migration walks the chain in migrations.mjs; if any
// step is null (breaking) or throws, the original file is renamed to
// <file>.incompatible.bak (or .migration-failed.bak) and a clean rebuild
// is signalled to the caller — no data loss without an audit trail on disk.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  copyFileSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";
import { CACHE_SCHEMA, MIGRATIONS } from "./migrations.mjs";

function tmpOf(p) { return p + ".tmp"; }
function bakOf(p) { return p + ".bak"; }

// Undo any partial write/migration crash. Safe to call every read.
export function recoverCacheFile(filePath) {
  const tmp = tmpOf(filePath);
  const bak = bakOf(filePath);
  try {
    if (existsSync(bak)) {
      // Crashed between snapshot and atomic rename — restore the original.
      try { if (existsSync(filePath)) unlinkSync(filePath); } catch {}
      try { renameSync(bak, filePath); } catch {}
    }
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch {}
    }
  } catch {}
}

// Atomic versioned write.
export function writeCacheVersioned(filePath, data) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = tmpOf(filePath);
  const bak = bakOf(filePath);
  const wrapped = { _schemaVersion: CACHE_SCHEMA, data: data };

  if (existsSync(filePath)) {
    try { copyFileSync(filePath, bak); } catch {}
  }
  writeFileSync(tmp, JSON.stringify(wrapped));
  renameSync(tmp, filePath); // atomic on POSIX, near-atomic on Windows
  if (existsSync(bak)) {
    try { unlinkSync(bak); } catch {}
  }
}

// Read + migrate. Returns:
//   { data, didMigrate?, didWipe?, fromSchema?, error? }
// If the file is absent or unreadable, returns { data: defaultValue }.
// If the chain is broken or a migration throws, the original is moved to
// a `.incompatible.bak` / `.migration-failed.bak` file and defaultValue is
// returned with didWipe: true.
export function readCacheVersioned(filePath, defaultValue) {
  recoverCacheFile(filePath);
  if (!existsSync(filePath)) return { data: defaultValue };

  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return { data: defaultValue };
  }

  // Detect v1 unwrapped format (no _schemaVersion) vs v2+ wrapped format.
  const wrapped = raw && typeof raw === "object" && typeof raw._schemaVersion === "number";
  const fromSchema = wrapped ? raw._schemaVersion : 0;
  let payload = wrapped ? raw.data : raw;

  if (fromSchema === CACHE_SCHEMA) return { data: payload };

  if (fromSchema > CACHE_SCHEMA) {
    // Downgrade — refuse silently, keep file, return default.
    return { data: defaultValue, didDowngrade: true, fromSchema };
  }

  // Walk the chain.
  for (let v = fromSchema; v < CACHE_SCHEMA; v++) {
    const step = MIGRATIONS[v];
    if (step === null || step === undefined) {
      _archiveAs(filePath, ".incompatible.bak");
      return { data: defaultValue, didWipe: true, fromSchema, reason: "incompatible" };
    }
    try {
      payload = step(payload);
    } catch (e) {
      _archiveAs(filePath, ".migration-failed.bak");
      return { data: defaultValue, didWipe: true, fromSchema, reason: "error", error: String(e && e.message || e) };
    }
  }

  // Persist the migrated payload at the new schema (atomic).
  try {
    writeCacheVersioned(filePath, payload);
  } catch {}
  return { data: payload, didMigrate: true, fromSchema };
}

function _archiveAs(filePath, suffix) {
  try {
    const dest = filePath + suffix;
    // If a previous archive exists, overwrite it (keep only the most recent).
    if (existsSync(dest)) { try { unlinkSync(dest); } catch {} }
    renameSync(filePath, dest);
  } catch {}
}

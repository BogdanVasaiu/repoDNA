// ─── CRASH-SAFE CACHE I/O ─────────────────────────────────
// Cache files are plain JSON. Schema/versioning is handled at the whole-store
// level (store.mjs + migrations.mjs), so individual files carry no version
// wrapper — by the time anything reads a cache here, the store has already
// been migrated or wiped on startup.
//
// Writes are atomic and crash-safe:
//   1. snapshot existing file → <file>.bak     (so a crash can restore)
//   2. write new content      → <file>.tmp
//   3. atomic rename          → <file>
//   4. delete <file>.bak
//
// Reads call recoverCacheFile() first to undo any partial write left by a
// previous crash (orphan .bak restored, orphan .tmp discarded).

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

function tmpOf(p) { return p + ".tmp"; }
function bakOf(p) { return p + ".bak"; }

// Undo any partial write left by a crash. Safe to call before every read.
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

// Atomic write of plain JSON.
export function writeCache(filePath, data) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = tmpOf(filePath);
  const bak = bakOf(filePath);

  if (existsSync(filePath)) {
    try { copyFileSync(filePath, bak); } catch {}
  }
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, filePath); // atomic on POSIX, near-atomic on Windows
  if (existsSync(bak)) {
    try { unlinkSync(bak); } catch {}
  }
}

// Read plain JSON. Returns defaultValue if absent or unreadable.
export function readCache(filePath, defaultValue) {
  recoverCacheFile(filePath);
  if (!existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return defaultValue;
  }
}

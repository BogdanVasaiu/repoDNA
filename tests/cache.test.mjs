#!/usr/bin/env node
// â”€â”€â”€ CACHE / MIGRATION INTEGRATION TESTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Run with:  node test-cache.mjs
//
// Exercises every code path in cache.mjs + migrations.mjs using a temp
// scratch directory. Fails loudly (exit 1) so this can be wired into CI
// or a pre-release smoke check.
//
// Tests cover:
//   - reading a v1 unwrapped JSON (schema 0)  â†’ wiped, backed up as .incompatible.bak
//   - reading a wrapped current-schema file    â†’ returned untouched, no rewrites
//   - reading missing / corrupted files        â†’ defaultValue returned, no throw
//   - reading a future-schema file (downgrade) â†’ defaultValue returned, file preserved
//   - atomic write leaves no .tmp / .bak       â†’ after success
//   - crash recovery: orphan .bak              â†’ restored on next read
//   - crash recovery: orphan .tmp              â†’ deleted on next read
//   - migrations.mjs self-consistency          â†’ keys are 0..CACHE_SCHEMA-1 with no gaps
//
// NOTE: tests use the real migrations.mjs in the repo â€” they assert the
// behaviour that ships, not a mocked variant. If you add migration entries
// in the future, the "incompatible" test will need its starting schema
// adjusted, or replaced with a fixture that targets a known break point.

import {
  mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import {
  readCacheVersioned, writeCacheVersioned, recoverCacheFile,
} from "../src/cache.mjs";
import { CACHE_SCHEMA, MIGRATIONS } from "../src/migrations.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log("  " + G + "âœ“" + X + " " + name);
    passed++;
  } catch (e) {
    console.log("  " + R + "âœ—" + X + " " + name);
    console.log("    " + R + (e && e.message || e) + X);
    failures.push({ name, error: e });
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || "values differ") + "\n      expected: " + b + "\n      actual:   " + a);
}

// â”€â”€â”€ SCRATCH DIR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SCRATCH = join(tmpdir(), "repodna-cache-test-" + Date.now());
mkdirSync(SCRATCH, { recursive: true });
function p(name) { return join(SCRATCH, name); }

console.log("\n  " + B + "repoDNA cache tests" + X);
console.log(D + "  scratch: " + SCRATCH + X);
console.log(D + "  current CACHE_SCHEMA: " + CACHE_SCHEMA + X);
console.log("");

// â”€â”€â”€ migrations.mjs self-consistency â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
test("migrations.mjs: keys are 0..CACHE_SCHEMA-1 with no gaps", () => {
  for (let i = 0; i < CACHE_SCHEMA; i++) {
    assert(Object.prototype.hasOwnProperty.call(MIGRATIONS, i),
      "missing MIGRATIONS[" + i + "] â€” chain has a gap at schema " + i);
    const step = MIGRATIONS[i];
    assert(step === null || typeof step === "function",
      "MIGRATIONS[" + i + "] must be null or a function (got " + typeof step + ")");
  }
});

test("migrations.mjs: no entries beyond CACHE_SCHEMA-1 (orphans signal a forgotten bump)", () => {
  const keys = Object.keys(MIGRATIONS).map(Number);
  for (const k of keys) {
    assert(k < CACHE_SCHEMA,
      "MIGRATIONS[" + k + "] exists but CACHE_SCHEMA is " + CACHE_SCHEMA +
      " â€” either bump CACHE_SCHEMA to " + (k + 2) + " or remove this entry");
  }
});

// â”€â”€â”€ readCacheVersioned â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
test("read: missing file returns defaultValue", () => {
  const res = readCacheVersioned(p("missing.json"), { hello: "world" });
  assertEq(res.data, { hello: "world" });
  assert(!res.didMigrate && !res.didWipe, "should not report migrate/wipe for missing file");
});

test("read: corrupted JSON returns defaultValue (no throw)", () => {
  const f = p("corrupted.json");
  writeFileSync(f, "{not valid json");
  const res = readCacheVersioned(f, {});
  assertEq(res.data, {});
});

test("read: wrapped current-schema file is returned untouched", () => {
  const f = p("current.json");
  writeFileSync(f, JSON.stringify({ _schemaVersion: CACHE_SCHEMA, data: { foo: 1 } }));
  const before = readFileSync(f, "utf-8");
  const res = readCacheVersioned(f, null);
  assertEq(res.data, { foo: 1 });
  assert(!res.didMigrate, "should not migrate when already at current schema");
  assert(!res.didWipe,    "should not wipe when already at current schema");
  assertEq(readFileSync(f, "utf-8"), before, "file should be byte-identical after read");
});

test("read: v1 unwrapped JSON (schema 0) is wiped and archived to .incompatible.bak", () => {
  const f = p("v1.json");
  const original = '{"hello.mjs":"deadbeef","world.mjs":"cafe"}';
  writeFileSync(f, original);

  const res = readCacheVersioned(f, {});
  assert(res.didWipe, "should report didWipe for incompatible v1 file");
  assertEq(res.fromSchema, 0, "should detect fromSchema=0");
  assertEq(res.reason, "incompatible");
  assertEq(res.data, {}, "should return defaultValue");

  assert(!existsSync(f), "original file should be moved");
  const bak = f + ".incompatible.bak";
  assert(existsSync(bak), ".incompatible.bak should exist");
  assertEq(readFileSync(bak, "utf-8"), original, "backup should match original byte-for-byte");
});

test("read: future-schema file (downgrade) returns defaultValue and preserves the file", () => {
  const f = p("future.json");
  writeFileSync(f, JSON.stringify({ _schemaVersion: CACHE_SCHEMA + 99, data: { secret: 1 } }));
  const before = readFileSync(f, "utf-8");
  const res = readCacheVersioned(f, { fallback: true });
  assertEq(res.data, { fallback: true });
  assert(res.didDowngrade, "should flag didDowngrade");
  assert(existsSync(f), "file must NOT be deleted on downgrade");
  assertEq(readFileSync(f, "utf-8"), before, "file must NOT be modified on downgrade");
});

// â”€â”€â”€ writeCacheVersioned â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
test("write: produces a wrapped file with current _schemaVersion", () => {
  const f = p("write1.json");
  writeCacheVersioned(f, { a: 1, b: [2, 3] });
  const parsed = JSON.parse(readFileSync(f, "utf-8"));
  assertEq(parsed._schemaVersion, CACHE_SCHEMA);
  assertEq(parsed.data, { a: 1, b: [2, 3] });
});

test("write: leaves no .tmp or .bak behind on success", () => {
  const f = p("write2.json");
  writeCacheVersioned(f, { ok: true });
  assert(!existsSync(f + ".tmp"), ".tmp must be cleaned up");
  assert(!existsSync(f + ".bak"), ".bak must be cleaned up");
});

test("write: overwriting an existing file preserves data (atomic)", () => {
  const f = p("write3.json");
  writeCacheVersioned(f, { v: 1 });
  writeCacheVersioned(f, { v: 2 });
  const res = readCacheVersioned(f, null);
  assertEq(res.data, { v: 2 });
});

// â”€â”€â”€ crash recovery â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
test("recover: orphan .bak is restored over a corrupted .json", () => {
  const f = p("crash1.json");
  // Simulate state right after copy-to-bak but before tmp-rename:
  //   .json was overwritten with partial/garbage, but original is safe in .bak.
  writeFileSync(f + ".bak", JSON.stringify({ _schemaVersion: CACHE_SCHEMA, data: { good: 1 } }));
  writeFileSync(f, "GARBAGE");
  recoverCacheFile(f);
  assert(!existsSync(f + ".bak"), ".bak must be consumed after recovery");
  const res = readCacheVersioned(f, null);
  assertEq(res.data, { good: 1 }, "recovered file must match the .bak contents");
});

test("recover: orphan .tmp is deleted (never silently committed)", () => {
  const f = p("crash2.json");
  writeFileSync(f, JSON.stringify({ _schemaVersion: CACHE_SCHEMA, data: { real: true } }));
  writeFileSync(f + ".tmp", JSON.stringify({ _schemaVersion: CACHE_SCHEMA, data: { partial: true } }));
  recoverCacheFile(f);
  assert(!existsSync(f + ".tmp"), ".tmp must be removed");
  const res = readCacheVersioned(f, null);
  assertEq(res.data, { real: true }, "main file must be untouched");
});

test("recover: idempotent when nothing to recover", () => {
  const f = p("crash3.json");
  writeFileSync(f, JSON.stringify({ _schemaVersion: CACHE_SCHEMA, data: { x: 1 } }));
  recoverCacheFile(f);
  recoverCacheFile(f);
  const res = readCacheVersioned(f, null);
  assertEq(res.data, { x: 1 });
});

// â”€â”€â”€ SUMMARY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("");
console.log(D + "  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€" + X);
if (failed === 0) {
  console.log("  " + G + "âœ“ " + passed + " passed" + X);
} else {
  console.log("  " + R + "âœ— " + failed + " failed" + X + D + ", " + passed + " passed" + X);
}

// Cleanup scratch dir
try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}

process.exit(failed === 0 ? 0 : 1);

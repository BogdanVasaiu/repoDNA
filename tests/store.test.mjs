#!/usr/bin/env node
// ─── STORE / CACHE / MIGRATION TESTS ──────────────────────
// Run with:  node tests/store.test.mjs
//
// Exercises the whole-store migration (store.mjs), the crash-safe cache I/O
// (cache.mjs), and the chain self-consistency (migrations.mjs) against scratch
// directories. Fails loudly (exit 1) so it can gate a release.
//
// Run this before tagging any release — especially after touching
// src/store.mjs, src/cache.mjs, or src/migrations.mjs.

import {
  mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { readCache, writeCache, recoverCacheFile } from "../src/cache.mjs";
import { DATA_SCHEMA, MIGRATIONS } from "../src/migrations.mjs";
import {
  migrateStore, readStoreSchema, writeStoreSchema, validateMigrationsChain,
} from "../src/store.mjs";

const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log("  " + G + "✓" + X + " " + name); passed++; }
  catch (e) { console.log("  " + R + "✗" + X + " " + name); console.log("    " + R + (e && e.message || e) + X); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || "assertion failed"); }
function assertEq(a, e, m) {
  const x = JSON.stringify(a), y = JSON.stringify(e);
  if (x !== y) throw new Error((m || "values differ") + "\n      expected: " + y + "\n      actual:   " + x);
}

const ROOT = join(tmpdir(), "repodna-test-" + Date.now());
mkdirSync(ROOT, { recursive: true });
let _n = 0;
function freshDir() { const d = join(ROOT, "store-" + (++_n)); mkdirSync(d, { recursive: true }); return d; }
function p(name) { return join(ROOT, name); }

console.log("\n  " + B + "repoDNA store/cache tests" + X);
console.log(D + "  scratch: " + ROOT + X);
console.log(D + "  DATA_SCHEMA: " + DATA_SCHEMA + X + "\n");

// ─── migrations.mjs self-consistency ──────────────────────
test("chain: keys are 0..DATA_SCHEMA-1 with no gaps", () => {
  assertEq(validateMigrationsChain(), [], "validateMigrationsChain should report no problems");
});

test("chain: MIGRATIONS[0] is null (v1 store is incompatible with v2)", () => {
  assert(MIGRATIONS[0] === null, "expected MIGRATIONS[0] === null");
});

// ─── readStoreSchema ──────────────────────────────────────
test("schema: absent dir → DATA_SCHEMA (fresh install is current)", () => {
  const d = join(ROOT, "does-not-exist-" + (++_n));
  assertEq(readStoreSchema(d), DATA_SCHEMA);
});

test("schema: empty dir → DATA_SCHEMA (counts as fresh)", () => {
  assertEq(readStoreSchema(freshDir()), DATA_SCHEMA);
});

test("schema: dir with content but no .schema → 0 (legacy v1)", () => {
  const d = freshDir();
  writeFileSync(join(d, "config.json"), '{"projects":[]}');
  assertEq(readStoreSchema(d), 0);
});

test("schema: .schema file is read as its integer value", () => {
  const d = freshDir();
  writeStoreSchema(2, d);
  assertEq(readStoreSchema(d), 2);
});

// ─── migrateStore ─────────────────────────────────────────
test("migrate: legacy v1 store (schema 0) → INCOMPATIBLE wipe", () => {
  const d = freshDir();
  // Simulate a populated v1 store: config + a project cache, no .schema.
  writeFileSync(join(d, "config.json"), '{"projects":[{"projectPath":"/x"}]}');
  mkdirSync(join(d, "projects", "abc"), { recursive: true });
  writeFileSync(join(d, "projects", "abc", "results.json"), '{"file.js":{"content":"old"}}');

  const res = migrateStore(d);
  assertEq(res.kind, "incompatible");
  assertEq(res.from, 0);
  assertEq(res.to, DATA_SCHEMA);

  // Store is now empty except the .schema marker.
  const remaining = readdirSync(d);
  assertEq(remaining, [".schema"], "store should be empty except .schema after wipe");
  assertEq(readStoreSchema(d), DATA_SCHEMA, "store should be stamped at current schema");

  // The wipe event carries no backup path (backup feature removed).
  assertEq(res.events[0].kind, "wiped");
  assert(!("backup" in res.events[0]), "wipe event should not carry a backup path");
});

test("migrate: store already at DATA_SCHEMA → COMPATIBLE, untouched", () => {
  const d = freshDir();
  writeStoreSchema(DATA_SCHEMA, d);
  writeFileSync(join(d, "config.json"), '{"keep":true}');
  const res = migrateStore(d);
  assertEq(res.kind, "compatible");
  assert(existsSync(join(d, "config.json")), "config.json must be kept");
  assertEq(JSON.parse(readFileSync(join(d, "config.json"), "utf-8")), { keep: true });
});

test("migrate: fresh/empty store → COMPATIBLE, gets stamped", () => {
  const d = freshDir();
  const res = migrateStore(d);
  assertEq(res.kind, "compatible");
  assertEq(readStoreSchema(d), DATA_SCHEMA);
});

test("migrate: future schema (downgrade) → left untouched", () => {
  const d = freshDir();
  writeStoreSchema(DATA_SCHEMA + 5, d);
  writeFileSync(join(d, "config.json"), '{"keep":true}');
  const res = migrateStore(d);
  assertEq(res.kind, "downgrade");
  assert(existsSync(join(d, "config.json")), "config must be preserved on downgrade");
});

// ─── cache.mjs: atomic plain-JSON I/O ─────────────────────
test("cache: write then read round-trips plain JSON", () => {
  const f = p("c1.json");
  writeCache(f, { a: 1, b: [2, 3] });
  assertEq(readCache(f, null), { a: 1, b: [2, 3] });
});

test("cache: write leaves no .tmp / .bak behind", () => {
  const f = p("c2.json");
  writeCache(f, { ok: true });
  assert(!existsSync(f + ".tmp"), ".tmp must be cleaned up");
  assert(!existsSync(f + ".bak"), ".bak must be cleaned up");
});

test("cache: missing file returns defaultValue", () => {
  assertEq(readCache(p("nope.json"), { d: 1 }), { d: 1 });
});

test("cache: corrupted JSON returns defaultValue (no throw)", () => {
  const f = p("c3.json");
  writeFileSync(f, "{not json");
  assertEq(readCache(f, {}), {});
});

test("cache: atomic overwrite keeps latest value", () => {
  const f = p("c4.json");
  writeCache(f, { v: 1 });
  writeCache(f, { v: 2 });
  assertEq(readCache(f, null), { v: 2 });
});

// ─── cache.mjs: crash recovery ────────────────────────────
test("recover: orphan .bak is restored over a corrupted main file", () => {
  const f = p("crash1.json");
  writeFileSync(f + ".bak", JSON.stringify({ good: 1 }));
  writeFileSync(f, "GARBAGE");
  recoverCacheFile(f);
  assert(!existsSync(f + ".bak"), ".bak must be consumed");
  assertEq(readCache(f, null), { good: 1 });
});

test("recover: orphan .tmp is discarded (never silently committed)", () => {
  const f = p("crash2.json");
  writeFileSync(f, JSON.stringify({ real: true }));
  writeFileSync(f + ".tmp", JSON.stringify({ partial: true }));
  recoverCacheFile(f);
  assert(!existsSync(f + ".tmp"), ".tmp must be removed");
  assertEq(readCache(f, null), { real: true });
});

// ─── SUMMARY ─────────────────────────────────────────────
console.log("");
console.log(D + "  ───────────────────────────────────" + X);
console.log(failed === 0 ? ("  " + G + "✓ " + passed + " passed" + X)
                         : ("  " + R + "✗ " + failed + " failed" + X + D + ", " + passed + " passed" + X));
try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);

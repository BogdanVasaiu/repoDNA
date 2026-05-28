// ─── DATA-STORE MIGRATIONS ────────────────────────────────
// A SINGLE schema number governs the ENTIRE ~/.repodna store: the global
// config.json (project list, settings, rules), every per-project cache
// (hashes/results/new-files), and anything else under that directory.
//
// The current version lives in ~/.repodna/.schema (a plain integer file).
// A store with no .schema file is treated as schema 0 (the pre-2.0 "v1" layout).
//
// On startup (before the server accepts any request) store.mjs walks the
// MIGRATIONS chain from the store's schema up to DATA_SCHEMA. Each step is
// one of three things:
//
//   MIGRATIONS[N] = null                 // breaking  → WIPE the whole store
//   MIGRATIONS[N] = (dataDir) => {...}   // shape change → TRANSFORM in place
//   MIGRATIONS[N] = (dataDir) => {}      // no-op        → COMPATIBLE (kept)
//
// Philosophy (per product decision): if data CAN be carried forward, write a
// transform and keep it. If it can't, wipe everything and start from zero —
// never let stale, incompatible data flow into a new version's UI.
//
// Rules for future releases:
//   1. NEVER edit an existing migration. Add a new one.
//   2. Bump DATA_SCHEMA by exactly 1 each time the on-disk layout changes.
//   3. Add MIGRATIONS[DATA_SCHEMA - 1] describing the previous → new step.
//
// v1 (pre-2.0.0) had no .schema file and a different cache layout, so
// MIGRATIONS[0] = null makes v1 → v2 a full wipe.

export const DATA_SCHEMA = 1;

export const MIGRATIONS = {
  // 0 → 1 : the entire v1 store is incompatible with v2.0.0 → wipe + back up.
  0: null,
};

// ─── PURE CHAIN ANALYSIS (used by update.mjs) ─────────────
// Walks the chain WITHOUT executing anything. Returns:
//   { kind: "compatible" | "semi" | "incompatible" | "downgrade", breakAt?, steps }
// `entries` maps schema → null | "transform" (update.mjs sniffs this from source).
export function classifyChain(fromSchema, toSchema, entries) {
  if (toSchema === fromSchema) return { kind: "compatible", steps: 0 };
  if (toSchema < fromSchema) return { kind: "downgrade", steps: 0 };
  let hasTransform = false;
  for (let v = fromSchema; v < toSchema; v++) {
    const step = entries[v];
    if (step === null || step === undefined) {
      return { kind: "incompatible", breakAt: v, steps: v - fromSchema };
    }
    // At runtime we can't tell identity from transform without calling, so any
    // non-null entry counts as a real step (update.mjs makes the same choice).
    hasTransform = true;
  }
  return { kind: hasTransform ? "semi" : "compatible", steps: toSchema - fromSchema };
}

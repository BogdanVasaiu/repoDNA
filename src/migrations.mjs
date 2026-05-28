// ─── CACHE MIGRATIONS ─────────────────────────────────────
// Every per-project cache file (hashes.json, results.json, new-files.json)
// is stamped with the CACHE_SCHEMA in use when it was written.
//
// When repoDNA boots, each cache is read through cache.mjs which walks the
// MIGRATIONS chain from the file's stored schema up to CACHE_SCHEMA.
//
// One number, three behaviours per step:
//
//   MIGRATIONS[N] = (data) => data            // identity → COMPATIBLE
//   MIGRATIONS[N] = (data) => transform(data) // shape change → SEMI-COMPATIBLE
//   MIGRATIONS[N] = null                      // breaking → INCOMPATIBLE (wipe)
//
// Rules for future releases:
//   1. NEVER edit an existing migration. Add a new one.
//   2. Bump CACHE_SCHEMA by exactly 1 each time the cache shape changes.
//   3. Add MIGRATIONS[CACHE_SCHEMA - 1] describing how to go from
//      the previous shape to the new one.
//
// v1 (pre-2.0.0) wrote raw JSON with no schema field. cache.mjs treats
// missing _schemaVersion as 0. MIGRATIONS[0] = null below makes the
// v1 → v2 transition INCOMPATIBLE — old caches are preserved as
// "<file>.incompatible.bak" and rebuilt on next analysis.

export const CACHE_SCHEMA = 1;

export const MIGRATIONS = {
  // 0 → 1 : v1 caches are incompatible with v2.0.0
  0: null,
};

// ─── PURE CHAIN ANALYSIS (used by update.mjs) ─────────────
// Walks the chain without running anything. Returns:
//   { kind: "compatible" | "semi" | "incompatible", breakAt?, steps }
export function classifyChain(fromSchema, toSchema, migrations) {
  if (toSchema === fromSchema) return { kind: "compatible", steps: 0 };
  if (toSchema < fromSchema) return { kind: "downgrade", steps: 0 };
  let hasTransform = false;
  for (let v = fromSchema; v < toSchema; v++) {
    const step = migrations[v];
    if (step === null || step === undefined) {
      return { kind: "incompatible", breakAt: v, steps: v - fromSchema };
    }
    // identity functions are detected by source-string sniff in update.mjs;
    // at runtime we cannot tell identity from transform without calling them,
    // so we conservatively treat every non-null entry as a real step.
    hasTransform = true;
  }
  return {
    kind: hasTransform ? "semi" : "compatible",
    steps: toSchema - fromSchema,
  };
}

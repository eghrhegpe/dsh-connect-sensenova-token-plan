/**
 * The snapshot wire contract, as the Host actually builds it.
 *
 * The declarations themselves now live in `src/shared/wire.ts` — the ONE place
 * both halves read them from. This module is the client's re-export face, kept
 * so the panel's `import ... from "./wire.ts"` call sites need no change, and
 * so the historical name stays readable at the seam it crosses.
 *
 * Re-exporting rather than re-declaring is the whole point: the old hand-written
 * mirror here was guarded only by `test/docs.test.mjs` §5b, a regex that
 * compared TOP-LEVEL field names against the Host's `return {}` literal — and
 * never looked at the nested structure. Now `tsc` (which already type-checks
 * `src/host` and `src/client` in one tsconfig) is the guard, and it sees every
 * nesting level.
 *
 * The shapes stay forgiving on purpose: a missing field must render as
 * "no data yet", never throw — so every property is optional, and reading
 * code falls back with `??` / `Array.isArray` exactly as the pre-split
 * closure did. Types are loaded, never enforced at runtime.
 */
export type {
  AuthData,
  LlmData,
  ModelData,
  PoolData,
  PoolsData,
  QuotaErrorData,
  QuotaWindowData,
  ShapeWarningData,
  SnapshotData,
  TrendData,
  TrendRowData,
  VisionModelData
} from "../shared/wire.ts";

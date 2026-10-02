/**
 * The snapshot wire contract, as the Host actually builds it.
 *
 * Every type here mirrors a field the Host's `buildSnapshotBody` returns
 * (see `src/host/snapshot-aggregate.ts`); keeping them in the client half
 * is a deliberate duplication CONSTRAINT: the client bundles unbuilt, so it
 * cannot import the Host's types, and `test/docs.test.mjs` asserts the
 * snapshot's 15-key shape against the same names.
 *
 * The shapes stay forgiving on purpose: a missing field must render as
 * "no data yet", never throw — so every property is optional, and reading
 * code falls back with `??` / `Array.isArray` exactly as the pre-split
 * closure did. Types are loaded, never enforced at runtime.
 */

/** One pool's 5h/7d quota window, as `parsePools` normalizes it. */
export interface QuotaWindowData {
  limit?: number;
  used?: number;
  remaining?: number;
  resetAt?: number | null;
}

/** One pool row of the `pools.pools` array. */
export interface PoolData {
  id?: string;
  name?: string;
  poolType?: string;
  modelIds?: string[];
  window5h?: QuotaWindowData | null;
  window7d?: QuotaWindowData | null;
  grantBalance?: number;
  nearestGrantExpiry?: number | null;
  nearestGrantExpiringBalance?: number;
  /** Filled by the Host when a catalog was available. */
  callableModels?: string[];
  lockedModels?: string[];
}

/** The `pools` block: the plan header plus the pool deck. */
export interface PoolsData {
  plan?: { id?: string; name?: string; type?: string };
  pools?: PoolData[];
}

/** One per-model consumption row of the trend chart. */
export interface TrendRowData {
  model: string;
  credits: number;
  /** Operator-configured pseudo multiplier (×N); absent when no key matched. */
  multiplier?: number;
}

/** The `trend` block: the window the chart covers and its rows. */
export interface TrendData {
  hours?: number;
  models?: TrendRowData[];
}

/** One catalogue entry the roster/picker offers. */
export interface ModelData {
  id?: string;
  name?: string;
  vision?: boolean;
  available?: boolean;
  quotaExhausted?: boolean;
  /** Positive window from `contextWindowOf`: declared value or the 128k fallback. */
  contextWindow?: number;
  /** Platform-declared output ceiling from `max_output_length`; 0/absent = unknown. */
  maxOutputLength?: number;
  /** Operator pseudo credit multiplier (×N); absent when no config key matched. */
  multiplier?: number;
  /** Thinking levels the DSH selector offers for this model, escalation order. */
  thinkingLevels?: string[];
}

/** One vision model line: the id, its capability, and the evidence source. */
export interface VisionModelData {
  id: string;
  vision: boolean;
  source?: "field" | "name" | null;
}

/** The `auth` block: token-state booleans the panel turns into guidance. */
export interface AuthData {
  configured?: boolean;
  hasAccount?: boolean;
  autoRecoverArmed?: boolean;
  hasRefreshToken?: boolean;
  expiresAt?: number | null;
  needsAccount?: boolean;
  ephemeral?: boolean;
  retryAfterMs?: number | null;
  needsUserAction?: boolean;
  error?: string | null;
}

/** The `llm` block: key presence, registration state, and the roster. */
export interface LlmData {
  hasApiKey?: boolean;
  keySource?: string | null;
  ephemeral?: boolean;
  registerProvider?: boolean;
  registerSource?: string;
  llmAvailable?: boolean;
  providerRegistered?: boolean;
  providerId?: string;
  modelCount?: number;
  visionCount?: number;
  /** Thinking effort the profile pins as DSH's "Default" (same constant the adapter dispatches). */
  thinkingDefault?: string;
  models?: ModelData[];
  enabledModelIds?: string[];
  quotaBlockedModelIds?: string[];
  providerError?: string;
  drawEnabled?: boolean;
  drawSource?: string;
  drawModel?: string;
  drawCandidateCount?: number;
  drawCandidateIds?: string[];
  drawPreferredModel?: string;
}

/** One shape-drift report line, keyed by upstream contract. */
export interface ShapeWarningData {
  api?: string;
  missing?: string;
}

/**
 * Why the quota block is empty: the console could not be reached.
 *
 * Carried INSIDE an `ok:true` snapshot — a signed-out or unreachable console
 * no longer blanks the whole body. The `code` is the same taxonomy the
 * `ok:false` failure path uses, so the panel words it with the same guidance.
 */
export interface QuotaErrorData {
  code?: string;
  message?: string;
}

/**
 * The whole snapshot body `buildSnapshotBody` returns, as the panel reads it.
 *
 * `pollSeconds` drives the panel's own poll cadence (it is consumed, not
 * rendered); `cacheSeconds` is quoted into the footnote; `auth` drives the
 * self-renew chip; `pools`/`trend` are the two content sections; `llm` is the
 * setup tab; the rest are banner lines.
 */
export interface SnapshotData {
  ok?: boolean;
  now?: number;
  consoleBase?: string;
  cacheSeconds?: number;
  pollSeconds?: number;
  auth?: AuthData | null;
  catalogAvailable?: boolean;
  catalogModels?: string[];
  visionModels?: VisionModelData[];
  uncountedModels?: string[];
  llm?: LlmData | null;
  pools?: PoolsData | null;
  trend?: TrendData | null;
  quotaError?: QuotaErrorData | null;
  shapeWarnings?: ShapeWarningData[];
}
/**
 * The wire contracts BOTH halves read: the snapshot body and the Raccoon state.
 *
 * This is the ONE declaration of what the Host builds and the panel reads.
 * The Host has no typed view of the snapshot (see `src/host/snapshot-aggregate.ts`,
 * where `buildSnapshotBody` is annotated `@returns {Promise<object>}`), so the
 * only place these shapes used to be spelled out was a hand-written mirror in
 * the client bundle — with nothing on the other side for the compiler to
 * compare it against, and nothing pinning the nested structure at all.
 *
 * This module is TYPE-ONLY: every export here is an `interface` / a `type`.
 * It carries no runtime value, so tsdown erases it from both bundles — the
 * client artifact stays dependency-free apart from `react`, and the host
 * bundle gains no browser code. It is the one thing both sides are allowed to
 * import, and the one reason the two halves can share a shape without sharing
 * state or runtime logic.
 *
 * `test/package.test.mjs` walks the host source graph and requires every
 * reachable module to live under `src/host/` — this directory is the single
 * declared exception (see that check's whitelist). Do not add a runtime
 * export here: a real value would be the first host runtime logic to enter the
 * browser artifact, which is where the isolation `docs/ARCHITECTURE.md` §5
 * actually begins to loosen.
 *
 * Every property is optional on purpose: a missing field must render as
 * "no data yet", never throw — so reading code falls back with `??` /
 * `Array.isArray` exactly as the pre-split closure did. Types are loaded,
 * never enforced at runtime.
 *
 * @module dsh-connect-sensenova-token-plan/shared-wire
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

/**
 * Why the draw tool is absent while the switch is on.
 *
 * The single union the host writes and the client words, so a new cause is a
 * compile-time change on BOTH sides at once: the host cannot set a reason the
 * client has no line for, because the client's `Record<Reason, DictionaryKey>`
 * map won't compile until a key exists.
 *
 * `no-tools-service` is the one NORMAL absence (this Host exposes no tools
 * service); the other two are Host bugs whose traces also go to the log via
 * `degrade`. Adding a cause means adding it here, in the host writer, and in
 * the i18n dictionary — nothing else.
 */
export type DrawToolAbsentReason =
  | "no-tools-service"
  | "peer-load-failed"
  | "registry-refused";

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
  /**
   * Why the draw tool is absent while the switch is on. Present (never an empty
   * string) only when the tool did not register, so the client treats it as
   * "show the note" rather than "check a string's emptiness".
   * @see DrawToolAbsentReason
   */
  drawToolNote?: DrawToolAbsentReason;
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

/** One model row as the /raccoon route reports it (the second upstream). */
export interface RaccoonModel {
  id?: string;
  name?: string;
  vision?: boolean;
  /**
   * The multiplier the gateway charges RIGHT NOW. For a promotion this is
   * `billing_effective_multiplier` (a `limited_free` model reads 0 here), not
   * the list price — the same figure the desktop client quotes as the live
   * rate. Absent when the gateway declared nothing.
   */
  multiplier?: number;
  /**
   * The list price the promotion discounts from (`billing_multiplier`). Set
   * only while the row is in a `discount` / `limited_free` state, so the panel
   * can draw the struck-through price the client shows.
   */
  originalMultiplier?: number;
  /** The promotion state, only for `discount` / `limited_free`. */
  billingStatus?: "discount" | "limited_free";
  /** The gateway's human note, e.g. "免费至10月31日". */
  billingStatusNote?: string;
  contextWindow?: number;
  maxOutputLength?: number;
}

/**
 * The secret-free state the /raccoon route answers.
 *
 * This is the SECOND upstream's wire contract (`sensenova-raccoon`). Its
 * fields are deliberately wider and fuzzier than the snapshot's — the route
 * emits most of them only when set (`pickDefined`), so absent means "not
 * declared" rather than "off". Keeping it in this shared module is what gives
 * it a real declaration on the Host side too; before this, only the panel
 * carried the shape, with nothing to compare it against.
 */
export interface RaccoonState {
  ok?: boolean;
  enabled?: boolean;
  switchSource?: string;
  loggedIn?: boolean;
  nickname?: string;
  /** The stored access token's JWT `exp`, in ms (absent when unknowable). */
  expiresAtMs?: number | null;
  /** Whether that token has lapsed — `loggedIn` can be true while this is true. */
  credentialExpired?: boolean;
  /** The refresh token's own window (≈30 days): how long until a re-scan. */
  refreshExpiresAtMs?: number | null;
  balance?: number | null;
  /** The gateway's split of the total — only parts it declared. */
  balanceBreakdown?: { daily?: number; reward?: number; monthly?: number; topup?: number } | null;
  /** The concrete reason a balance read came back empty (absent when fine). */
  balanceDetail?: string;
  /** Which roster the tab is drawing: the gateway catalogue ("live"), a read
   *  that succeeded but listed no visible model ("empty"), or a read that
   *  failed outright ("unreadable") — the last two both fall back to the
   *  built-in table, but they must be worded differently. */
  modelsSource?: "live" | "empty" | "unreadable";
  /**
   * The roster the tab draws. `readonly` because it is never mutated: the
   * "empty"/"unreadable" paths pass the FROZEN `RACCOON_FALLBACK_MODELS`
   * straight through (a test pins that by reference), so a mutable `RaccoonModel[]`
   * would be a type that no runtime value satisfies.
   */
  models?: readonly RaccoonModel[];
  /** The saved pushed-model curation (`null`/absent = the whole roster). */
  enabledModelIds?: string[] | null;
  providerRegistered?: boolean;
  providerError?: string;
  error?: string;
  /** The in-flight QR scan the route last issued (cleared when it settles). */
  scanUrl?: string;
  scanCode?: string;
  /**
   * The QR walk's outcome: `"scanning"` while one waits, otherwise a terminal
   * `logged_in` / `timeout` / `canceled` / `failed`.
   *
   * It is an EVENT, not a state: the route hands a terminal outcome over once
   * and clears it, so only the poll that catches it sees it. The durable
   * "signed in" fact is `loggedIn`. What this drives is the poll CADENCE — a
   * waiting scan is the only time the tab needs to poll faster than a minute.
   */
  loginStatus?: string;
  /** The reason a `failed` walk gave; only ever present beside that status. */
  loginError?: string;
  /**
   * The tab's idle poll cadence, in SECONDS, as stated by the route.
   *
   * The Host owns the two cache windows this poll has to respect
   * (`RACCOON_BALANCE_TTL_MS` / `RACCOON_CATALOG_TTL_MS`), so it states the
   * cadence it wants rather than leaving the client to guess a number that
   * has to track them — the same contract the snapshot's own `pollSeconds`
   * carries. Absent on an older Host: the tab then keeps its built-in
   * fallback. See `statedCadenceMs`.
   */
  pollSeconds?: number;
  /** The cadence while a scan waits on the phone (see `pollSeconds`). */
  scanPollSeconds?: number;
}

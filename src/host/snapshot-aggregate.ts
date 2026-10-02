/**
 * The snapshot route's DATA AGGREGATION — the peer-free pure half.
 *
 * Keeps the router to only the HTTP surface (route registration, the trust
 * fence, body reading, the `writeJson` responses) while the polling-side
 * decisions — fetching through the cache, parsing pools/trend/catalog,
 * computing shape warnings, splitting a pool's coverage into callable vs
 * locked models, marking quota-exhausted models, identifying vision models,
 * building the `llm` status block — live here as one testable function.
 *
 * Pure by design: it takes the resolved `settings`, the shared `cache` /
 * `inflight` maps, the `tokenStore`, the `apiKeyStore`, the `publisher`
 * (from `provider-publish.ts`) and the `catalogStore`, and returns the exact
 * snapshot body the route writes. No HTTP surface, no filesystem writes, no
 * module-level state — so `test/routes.test.mjs` can pin every branch (the
 * 14-key snapshot contract, the vision-vs-catalog distinction, the
 * quota-flip re-registration) without mounting the full container.
 *
 * @module dsh-connect-sensenova-token-plan/snapshot-aggregate
 */

import { CODE, isAuthFailure } from "./codes.ts";
import { fetchConsole, fetchModelCatalog } from "./console-client.ts";
import { parsePools, parseTrend, checkShape, identifyVisionModel } from "./parsers.ts";
import { summarizeCatalog, filterByEnabled, rosterWithAvailability, exhaustedModelIds, LLM_PROVIDER_ID, DEFAULT_REASONING_EFFORT } from "./llm-models.ts";
import { catalogSignature, syncSignaturesAfterPublish } from "./provider-publish.ts";
import { imageGenModelIds, pickDrawModel } from "./draw.ts";
import { str, errMsg } from "./util.ts";
import { resolveSwitchEnabled, switchSource } from "./switch-precedence.ts";
import type { SnapshotData, DrawToolAbsentReason } from "../shared/wire.ts";

/**
 * The operator's pseudo multiplier that names one model id, or undefined.
 *
 * Matching is a case-insensitive SUBSTRING of the model id, first configured
 * key wins (insertion order — `resolveTrendMultipliers` preserves it). One
 * matcher serves BOTH the trend rows and the panel roster, so a model's `×N`
 * in the consumption chart and its `×N` badge in the model list are the same
 * computed fact, never two copies that can drift.
 *
 * @param {unknown} modelId - a model id (trend row name or roster row id).
 * @param {Record<string, number>} multipliers - the sanitized config map.
 * @returns {number|undefined} the hit value, or undefined when nothing matched.
 */
export function matchMultiplier(modelId: unknown, multipliers: Record<string, number>): number | undefined {
  const id = String(modelId ?? "").toLowerCase();
  for (const [key, value] of Object.entries(multipliers || {})) {
    if (id.includes(key.toLowerCase())) return value;
  }
  return undefined;
}

/**
 * Attach the operator's pseudo multipliers to the parsed trend rows.
 *
 * A row without a match keeps no `multiplier` field — the panel shows no
 * factor for it rather than guessing 1. The math lives here as one exported
 * seam so the tests drive the exact function `buildSnapshotBody` calls, not a
 * copy.
 *
 * @param {{models: Array<{model: string, credits: number, multiplier?: number}>}} trend
 *   the `parseTrend` result; rows are replaced in place on the object.
 * @param {Record<string, number>} multipliers - the sanitized config map.
 * @returns {object} the same trend object with `multiplier` on matching rows.
 */
export function applyTrendMultipliers(trend: { models: Array<{ model: string; credits: number; multiplier?: number }> }, multipliers: Record<string, number>): { models: Array<{ model: string; credits: number; multiplier?: number }> } {
  trend.models = trend.models.map((row) => {
    const multiplier = matchMultiplier(row.model, multipliers);
    return multiplier === undefined ? row : { ...row, multiplier };
  });
  return trend;
}

/**
 * Run one fetch, reporting its failure instead of throwing.
 *
 * The snapshot must NOT be all-or-nothing on the console: a signed-out or
 * unreachable console still leaves the llm block and the model catalog —
 * neither of which needs the console token — deliverable. The failed source
 * is named in `quotaError`; the panel says why instead of showing nothing,
 * and the API / Raccoon tabs stay fully usable without a console login.
 * @param {() => Promise<unknown>} fn - the fetch.
 * @returns {Promise<{value: unknown, error: unknown}>} `value` or `error`, never both.
 */
async function soft(fn: () => Promise<unknown>): Promise<{ value: unknown; error: unknown }> {
  try {
    return { value: await fn(), error: null };
  } catch (error) {
    return { value: null, error };
  }
}

/**
 * Map a thrown console/auth error to the one code the panel branches on.
 *
 * A raw error message carries no intent, so the panel keys its guidance off
 * this taxonomy instead: `not_configured` (the user can fix it) and
 * `jwt_expired` (renewal already failed) pass through verbatim because the
 * panel words them differently from every other case; a misconfigured row
 * (`config`, thrown by the auth walk for a bad override or a missing key id)
 * is reported as `config_error` so the panel says "fix the row" and never
 * invites a sign-in; an auth-shaped failure becomes `auth_error`; anything
 * else is a console failure, which usually self-heals on the next poll. The
 * same mapping answers both the snapshot's in-body `quotaError` and the
 * route's `ok:false` catch — one copy, one taxonomy.
 * @param {unknown} error - the error a fetch or parse threw.
 * @returns {string} the panel-facing code.
 */
export function failureCode(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;
  if (code === CODE.CONFIG || code === CODE.CONFIG_ERROR) return CODE.CONFIG_ERROR;
  if (code === CODE.NOT_CONFIGURED || code === CODE.JWT_EXPIRED) return code;
  return isAuthFailure(error) ? CODE.AUTH_ERROR : CODE.CONSOLE_ERROR;
}

/**
 * Fetch the three console sources in parallel and aggregate them into the
 * snapshot body the route writes.
 *
 * The console sources are fetched through the shared `cache` + `inflight`
 * maps (a single-flight per URL so concurrent polls share one call) and the
 * `tokenStore` (so a 401 triggers one renewal before the call). The model
 * catalog is optional: a missing API key degrades the model lists, not the
 * quota — resolved per poll so a key that arrives after the plugin mounted
 * still lights the lists on the next poll.
 *
 * @param {object} context
 * @param {object} context.settings - the resolved settings row.
 * @param {Map} context.cache - the console-response cache (shared across polls).
 * @param {Map} context.inflight - the single-flight map (shared across polls).
 * @param {object} context.tokenStore - the `createTokenStore` instance.
 * @param {object} context.apiKeyStore - the `createApiKeyStore` instance.
 * @param {object} context.publisher - the `createProviderPublisher` instance.
 * @param {object} context.catalogStore - the `createFileCatalogStore` instance.
 * @param {() => Promise<boolean|null>} context.panelSwitch - the panel-saved
 *   provider switch (`provider-store.enabled()`); null when untouched.
 * @param {() => Promise<boolean|null>} context.drawSwitch - the panel-saved
 *   draw-tool switch (`draw-store.enabled()`), same shape and precedence.
 * @returns {Promise<SnapshotData>} the snapshot body (`{ ok, now, ..., pools, trend, ... }`).
 */
export async function buildSnapshotBody({
  settings,
  cache,
  inflight,
  tokenStore,
  apiKeyStore,
  publisher,
  catalogStore,
  panelSwitch,
  drawSwitch,
  drawModelId,
  drawToolNote
}: {
  settings: import("./host-config.ts").ResolvedSettings;
  cache: Map<string, { body: unknown; at: number; gen: number }>;
  inflight: Map<string, Promise<unknown>>;
  tokenStore: { getToken(): Promise<string>; invalidate(token?: string): void; state(): Promise<unknown> };
  apiKeyStore: { resolve(): Promise<{ value: string }>; state(): Promise<unknown> };
  publisher: {
    state: any;
    entries?: unknown[];
    publish: (entries: unknown, enabledIds: unknown, unavailableModelIds?: string[]) => Promise<unknown>;
  };
  catalogStore: { listEnabledIds(): Promise<string[]>; replace(entries: unknown, enabledIds?: unknown): Promise<void> };
  panelSwitch: () => Promise<boolean | null>;
  drawSwitch?: () => Promise<boolean | null>;
  drawModelId?: () => Promise<string | null>;
  drawToolNote?: () => DrawToolAbsentReason | null;
}): Promise<SnapshotData> {
  const providerState = publisher.state;
  const resolveApiKey = async () => (await apiKeyStore.resolve()).value;

  const now = Math.floor(Date.now() / 1000);
  // Snap the window to the granularity boundary so that two polls inside the
  // same hour/day bucket build an identical URL and the long-lived trend
  // cache (5 min) actually hits, instead of re-fetching the console on every
  // poll. The window length is unchanged — only shifted to align with the
  // bucket edges; the console returns bucket-aggregated series anyway, so the
  // panel shows complete buckets rather than a partial one.
  const bucketSeconds = settings.trendHours <= 72 ? 3600 : 86400;
  const endBucket = Math.floor(now / bucketSeconds) * bucketSeconds;
  const start = endBucket - settings.trendHours * 3600;
  const granularity = settings.trendHours <= 72
    ? "TOKEN_PLAN_CREDIT_TREND_GRANULARITY_HOUR"
    : "TOKEN_PLAN_CREDIT_TREND_GRANULARITY_DAY";
  const [poolResult, trendResult, catalog] = await Promise.all([
    // The two console sources are SOFT, not fatal: a signed-out or unreachable
    // console must not blank the whole snapshot. The quota section says why it
    // is empty (`quotaError`), while the llm block and the model catalog —
    // neither of which needs the console token — still arrive, so the API and
    // Raccoon tabs stay usable without a console login.
    soft(() => fetchConsole(settings, "/lite/console/v1/tokenplan/pool-usage", undefined, settings.cacheSeconds * 1000, cache, inflight, tokenStore)),
    soft(() => fetchConsole(
      settings,
      "/lite/console/v1/tokenplan/credit-usage-trend",
      { start_time: String(start), end_time: String(endBucket), granularity },
      Math.max(settings.cacheSeconds, 300) * 1000,
      cache,
      inflight,
      tokenStore
    )),
    // Optional: a missing API key degrades the model lists, not the quota.
    (async () => {
      const apiKey = await resolveApiKey();
      return apiKey === "" ? null : fetchModelCatalog(settings, 3600_000, cache, inflight, apiKey).catch(() => null);
    })()
  ]);
  const pools = parsePools(poolResult.value);
  const trend = parseTrend(trendResult.value, settings.trendHours);
  // Pseudo multipliers ride on the rows the Host computes, so the client
  // never re-implements the matching (and the tests drive the same math).
  applyTrendMultipliers(trend, settings.trendMultipliers);
  // The console could not be reached (no account, a rejected token, the
  // console down): the quota block is empty and says WHY, keyed by the same
  // taxonomy the failure path uses. Pool is the auth probe — its failure wins
  // the code when both sources missed.
  const consoleFailure = poolResult.error ?? trendResult.error ?? null;
  const quotaError = consoleFailure === null
    ? null
    : {
        code: failureCode(consoleFailure),
        message: errMsg(consoleFailure)
      };
  // A shape drift does not fail the poll — the parsers still return what they
  // understood — but it must reach the panel, or a renamed field would read
  // as "no usage" forever. A source that failed outright is reported through
  // `quotaError` instead, so it is skipped here: reporting both would blame
  // the shape for a network error.
  const shapeWarnings = [
    ...(poolResult.error === null
      ? checkShape(poolResult.value, "pool-usage").missing.map((key: string) => ({ api: "pool-usage", missing: key }))
      : []),
    ...(trendResult.error === null
      ? checkShape(trendResult.value, "credit-usage-trend").missing.map((key: string) => ({ api: "credit-usage-trend", missing: key }))
      : [])
  ];
  // Split each pool's advertised coverage into what this key can call and
  // what the plan lists but the key has no permission for yet.
  const catalogIds = Array.isArray(catalog) ? catalog.map((entry) => str((entry as { id?: unknown })?.id, "")) : [];
  if (Array.isArray(catalog)) {
    const available = new Set(catalogIds);
    pools.pools = pools.pools.map((pool) => {
      const callable = pool.modelIds.filter((model: string) => available.has(model));
      const locked = pool.modelIds.filter((model: string) => !available.has(model));
      return { ...pool, callableModels: callable, lockedModels: locked };
    });
  } else {
    pools.pools = pools.pools.map((pool) => ({
      ...pool,
      callableModels: pool.modelIds,
      lockedModels: []
    }));
  }
  // Models whose quota pool is exhausted would answer every chat request with
  // `429 quota_exceeded`. The picker must not offer them (the adapter drops
  // them via `unavailableModelIds`), and the panel greys them (via
  // `rosterWithAvailability`). The set also drives a re-registration when it
  // flips between catalogue polls.
  const unavailableModelIds = exhaustedModelIds(pools);
  // Which of the callable models can take image input — step one of the
  // vision plan (ARCHITECTURE.md §5.1): the info, not the execution.
  // Absent API key → no catalog → the list is simply undeclared, not "none".
  const visionModels = Array.isArray(catalog)
    ? catalog
        .map((entry) => identifyVisionModel(entry))
        .filter((entry) => entry.vision)
    : undefined;

  // Step three: persist the fetched catalog to the PRIVATE state file and
  // rebuild the registered provider, but ONLY when the offered set actually
  // changed — the catalog fetch is cached for an hour while the panel polls
  // every 30 s, so a write/re-register per poll would be pure churn. The
  // reported model counts come from the fresh catalog when one arrived, else
  // from whatever the mount seed had stored.
  const keyState = (await apiKeyStore.state().catch(() => ({ hasApiKey: false, keySource: null, ephemeral: false }))) as Record<string, unknown>;
  // The draw-model preference with the same precedence the tool resolves at
  // mount: panel-saved beats the patch default; "" = auto-pick. Resolved once
  // here so the llm block's three draw fields cannot disagree.
  const effectiveDrawModelId = (await drawModelId?.().catch(() => null)) ?? str(settings.drawModelId, "");
  // The effective switch: a panel-saved value beats the patch default. Both
  // are reported so the panel can say which side is in charge.
  const effectivePanelSwitch = await panelSwitch().catch(() => null);
  // Same read for the draw switch, taken ONCE. It used to be read twice — once
  // for the value and once for the source — and a store that flipped between
  // the two awaits could answer "enabled from panel" for one field and "off
  // from config" for the other, a self-contradictory pair the panel would then
  // render. Mirrors the provider switch above.
  const effectiveDrawPanelSwitch = await drawSwitch?.().catch(() => null) ?? null;
  // The curated allow-list is read on every poll, not only when a fresh
  // catalogue arrived: a /models save must reach the picker even on a poll
  // that serves a cached catalogue.
  const enabledIds = await catalogStore.listEnabledIds().catch(() => providerState.enabledIds);
  let offered = providerState.entries;
  let catalogChanged = false;
  if (Array.isArray(catalog)) {
    const freshSignature = catalogSignature(catalog, enabledIds);
    if (freshSignature !== providerState.signature) {
      catalogChanged = true;
      await catalogStore.replace(catalog, enabledIds).catch(() => {});
      await publisher.publish(catalog, enabledIds, unavailableModelIds);
      // Keep the signatures in lock-step with what was just published — the SAME
      // formulas the route path uses, so the "did the offer change?" signal has a
      // single source and cannot drift between the two publish paths.
      syncSignaturesAfterPublish(providerState);
    }
    offered = catalog;
  }
  // Quota state can flip (a pool hits zero, or its window resets) without the
  // catalogue changing. When it does, rebuild the registration so the picker
  // drops/restores the affected models — `PiAiAdapter` memoizes the profiles
  // snapshot on Map identity, so only a fresh registration can change the
  // offered set (ROADMAP.md §3.3). Skip when the catalogue branch already
  // published this exact set a moment ago.
  const quotaSig = [...unavailableModelIds].sort().join(",");
  if (quotaSig !== providerState.quotaSignature) {
    if (!catalogChanged) {
      await publisher.publish(providerState.entries, providerState.enabledIds, unavailableModelIds);
    }
    // Same single-source sync as the catalogue branch above; sets both signatures
    // from the published offer so the next poll sees a stable signal.
    syncSignaturesAfterPublish(providerState);
  }
  // The counts describe the OFFER, not the catalogue: the adapter is built
  // from the allow-list-filtered entries, so a panel line that quoted the raw
  // count would claim to have registered models that were ticked off.
  const summary = summarizeCatalog(filterByEnabled(offered, enabledIds));
  // Secret-free by construction: the store reports booleans/source only, never
  // the key value.
  const llmStatus = {
    ...keyState,
    registerProvider: resolveSwitchEnabled(effectivePanelSwitch, settings.registerProvider),
    registerSource: switchSource(effectivePanelSwitch),
    llmAvailable: providerState.llmAvailable,
    providerRegistered: providerState.registered,
    providerId: LLM_PROVIDER_ID,
    modelCount: summary.modelCount,
    visionCount: summary.visionCount,
    // What DSH's 思考强度 "Default" actually means on this provider. The
    // adapter profile pins this constant, the panel quotes it — same source,
    // so the two cannot drift.
    thinkingDefault: DEFAULT_REASONING_EFFORT,
    // The panel roster: every chat model this catalogue can offer, each tagged
    // with whether its quota pool is currently exhausted, plus the curated
    // allow-list. An empty allow-list means "no filter". Every row also carries
    // the operator's pseudo `×N` under the SAME matcher the trend rows use —
    // the badge and the consumption chart quote one computed fact, and an
    // unmatched model simply gets no badge (never a guessed 1).
    models: rosterWithAvailability(offered, pools).map((row) => {
      const multiplier = matchMultiplier(row.id, settings.trendMultipliers);
      return multiplier === undefined ? row : { ...row, multiplier };
    }),
    enabledModelIds: enabledIds,
    quotaBlockedModelIds: unavailableModelIds,
    drawEnabled: resolveSwitchEnabled(effectiveDrawPanelSwitch, settings.drawEnabled),
    drawSource: switchSource(effectiveDrawPanelSwitch),
    // Emitted ONLY when the switch is on and the tool never registered — the
    // one normal absence the copy (`draw.noTools`) names, plus the two Host
    // bugs (`peer-load-failed` / `registry-refused`) that also log via
    // `degrade`. Injected as a closure like `drawSwitch`, so this aggregator
    // stays pure: its only state sources are parameters, and a test can hand it
    // a `() => "registry-refused"` without touching global state. Present, never
    // an empty string, so the client treats it as "show the note" rather than
    // "check a string's emptiness".
    ...(() => {
      const note = drawToolNote?.();
      return note ? { drawToolNote: note } : {};
    })(),
    // A draw call's actual target model, picked by the same precedence the
    // tool itself uses (`pickDrawModel`) over the same normalized catalog —
    // so the panel's line and the tool's behavior cannot disagree. Emitted
    // whenever the catalog is present: an AUTO pick (no configured id) still
    // addresses the catalog's first image model, so `drawModel` / the
    // candidate set are facts about the deployment, not about the operator's
    // preference. Only `drawPreferredModel` (the operator's pinned choice) is
    // preference-shaped and absent when auto. The whole block disappears when
    // there is no catalog at all (no key, or the poll has never fetched one).
    ...(Array.isArray(catalog)
      ? (() => {
          const candidates = imageGenModelIds(catalog);
          const drawModel = pickDrawModel(catalog, "", effectiveDrawModelId);
          return {
            ...(drawModel !== null ? { drawModel } : {}),
            drawCandidateCount: candidates.length,
            drawCandidateIds: candidates,
            // Presence of a preference (panel or config) is what the panel
            // renders as "pinned"; its absence is "auto-picked".
            ...(effectiveDrawModelId !== "" ? { drawPreferredModel: effectiveDrawModelId } : {})
          };
        })()
      : {}),
    ...(providerState.error !== null ? { providerError: providerState.error } : {})
  };

  return {
    ok: true,
    now: Date.now(),
    consoleBase: settings.consoleBase,
    // The panel polls on the Host's cadence and quotes the Host's cache age,
    // so neither number is written down twice.
    cacheSeconds: settings.cacheSeconds,
    pollSeconds: settings.pollSeconds,
    // Token state, with no secret in it: the panel uses this to say whether
    // the token renews itself or is waiting on an account.
    auth: (await tokenStore.state()) as import("../shared/wire.ts").AuthData,
    catalogAvailable: Array.isArray(catalog),
    catalogModels: catalogIds,
    // `undefined` (no API key) vs `[]` (key present, no vision models) — the
    // panel must not say "no vision models" when it simply never asked.
    ...(visionModels !== undefined ? { visionModels } : {}),
    // With the console unreachable the pools are empty, so every catalogue
    // model would read as "uncounted" — noise that blames the models for the
    // missing quota data. The `quotaError` line already explains the blank.
    uncountedModels: quotaError === null && Array.isArray(catalog)
      ? catalogIds.filter((model) => !pools.pools.some((pool) => pool.modelIds.includes(model)))
      : [],
    // Step three status: key presence/source, opt-in, registration state, and
    // model/vision counts — never the key itself.
    llm: llmStatus,
    pools,
    trend,
    quotaError,
    shapeWarnings
  };
}

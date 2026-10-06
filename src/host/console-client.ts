/**
 * The Host half's console and model-catalog fetches: caching plus single-flight.
 *
 * Both endpoints share one in-flight map per URL, so several open panels (or
 * tabs) polling at once issue a single console request instead of N — which is
 * also how the Host stays off the platform's own rate limiter. Cached responses
 * age out on their own TTL, and a safety sweep drops anything older than the
 * longest TTL so the map never grows without bound.
 *
 * The caching + coalescing is NOT implemented here: both functions drive the
 * shared `coalesced-fetch.ts` primitive with the caller's maps, so this module
 * owns the REQUEST shape only and the "one call per key" discipline has exactly
 * one implementation to get right.
 *
 * The cache keys carry an IDENTITY dimension (`credentialFingerprint`): the
 * console keys are `<url>@<token digest>` and the catalog key is
 * `<url>@<key digest>`, so an account or key that changes — through the
 * panel's routes (which also clear the whole cache via the generation bump)
 * or OUT OF BAND (an edit to the credentials service or the environment the
 * panel never saw) — walks into a fresh key instead of being served the
 * previous identity's entry for the rest of its TTL. This is the console
 * side of the isolation the raccoon upstream already had (`catalog:<fp>`).
 * @module dsh-connect-sensenova-token-plan/console-client
 */

import { createHash } from "node:crypto";
import { CODE } from "./codes.ts";
import { str, obj } from "./util.ts";
import { createCoalescedFetch } from "./coalesced-fetch.ts";
import type { ResolvedSettings } from "./host-config.ts";

/**
 * A short identity fingerprint for a cache key.
 *
 * The shared console/catalog cache is keyed per IDENTITY, not per URL: the
 * raccoon upstream proved the pattern (`catalog:${tokenFingerprint(...)}`),
 * and the Token Plan side had the hole the other half never did — an
 * external change to the credential (the `.credentials.yaml` reference or
 * the environment) that bypasses the panel's save/forget routes does not
 * clear the console cache, so the OLD account's pool data (or the OLD
 * key's one-hour catalog) would otherwise keep being served. Keying under
 * a hash of the live credential means a switched account or key walks
 * into a FRESH key and re-fetches, with the panel's own save/forget
 * (which still clears everything via the generation bump) unchanged.
 *
 * Hashed, not raw: the key string lives in a long-lived in-memory Map,
 * and 12 hex chars (48 bits) is ample for two or three identities — the
 * raw token or `sk-` key must not ride along in the key.
 * @param {string} value - the credential to fingerprint.
 * @returns {string} the 12-hex-char digest prefix.
 */
export function credentialFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * One cached console response: the body plus the epoch millis it was fetched.
 * @typedef {{body: unknown, at: number}} CacheEntry
 */

/**
 * Fetch one console endpoint with a bearer token, caching the result.
 *
 * A 401/403 means the token the console saw is no longer good, so the store is
 * invalidated and the call retried exactly once with a fresh token. Without
 * the retry a token that expires mid-poll would leave the panel stuck on an
 * error until the next manual re-login; with it, the panel heals itself. A
 * PERSISTENT second refusal folds into `jwt_expired` regardless of status:
 * that is the pinned contract (the panel's "wait for the renewal or re-sign
 * in" remedy fits both), and the message alone carries the 401-vs-403
 * distinction for the debugging reader.
 *
 * @param {ResolvedSettings} settings - resolved plugin settings.
 * @param {string} path - the console path, e.g. `/lite/console/v1/tokenplan/pool-usage`.
 * @param {Record<string, string> | undefined} params - optional query parameters.
 * @param {number} cacheMs - how long to keep the response.
 * @param {Map<string, { body: unknown; at: number; gen: number }>} cache - the cache map to use.
 * @param {Map<string, Promise<unknown>>} inflight - the in-flight map to share requests through.
 * @param {{ getToken(): Promise<string>; invalidate(token?: string): void }} tokenStore - the credentials-backed token store.
 * @returns {Promise<unknown>} the parsed console body.
 */
export async function fetchConsole(
  settings: ResolvedSettings,
  path: string,
  params: Record<string, string> | undefined,
  cacheMs: number,
  cache: Map<string, { body: unknown; at: number; gen: number }>,
  inflight: Map<string, Promise<unknown>>,
  tokenStore: { getToken(): Promise<string>; invalidate(token?: string): void }
): Promise<unknown> {
  const query = params && Object.keys(params).length > 0
    ? `?${new URLSearchParams(params).toString()}`
    : "";
  const url = `${settings.consoleBase}${path}${query}`;
  // One cache + one in-flight map, shared with every other console caller: many
  // open panels (or tabs) polling at once must not each hammer the console, and
  // the request is shared until it resolves. The key carries the live token's
  // fingerprint, so two identities that share this map (an account switch that
  // outlived the process, a renewal that rotated the token) can never serve each
  // other's numbers — a fresh credential is a fresh key, not a stale entry.
  const coalesced = createCoalescedFetch({ cache, inflight });
  // The key-phase token is read WITH a fallback, on purpose: a store that cannot
  // produce a token keys under the empty-string digest — a space that is never
  // populated, because the fetch below needs a token — and the in-run
  // `getToken` stays the one that throws the real refusal. That preserves the
  // pre-keying call order exactly (a cached answer is served before the token
  // is asked for again), while a switched or renewed token still walks into a
  // fresh key: two identities that share this map never serve each other's
  // numbers.
  const keyToken = await tokenStore.getToken().catch(() => "");
  const key = `${url}@${credentialFingerprint(keyToken)}`;

  const run = async () => {
    const send = async (held: string) => fetch(url, {
      headers: { authorization: `Bearer ${held}`, accept: "application/json" },
      signal: AbortSignal.timeout(settings.consoleTimeoutMs)
    });

    let held = await tokenStore.getToken();
    let response = await send(held);
    if (response.status === 401 || response.status === 403) {
      // The console rejected this exact token: mark it refused so the store
      // renews, then try once more. Naming the token matters because a poll
      // issues several requests at once, each of which may be holding a
      // different one. A successful retry caches under THIS key, so the next
      // poll under the new token re-fetches once — the price of never serving
      // a stale account's numbers.
      tokenStore.invalidate(held);
      held = await tokenStore.getToken();
      response = await send(held);
    }
    if (response.status === 401 || response.status === 403) {
      // A persistent refusal (after the renewal above) means the console kept
      // rejecting: `jwt_expired` is the code both 401 and 403 fold into —
      // the panel's wording for it ("wait for the silent renewal, or sign in
      // again") is the remedy either way. The status is named in the message
      // so a debugging reader can tell a token rejection from a permission
      // refusal without a second request.
      const error = new Error(
        response.status === 403
          ? "console kept refusing even with a fresh token (HTTP 403); the account may not be allowed on this pool"
          : "console rejected the token (HTTP 401)"
      ) as import("./types.ts").PluginError;
      error.code = CODE.JWT_EXPIRED;
      throw error;
    }
    if (!response.ok) {
      throw new Error(`console returned HTTP ${response.status}`);
    }
    return await response.json();
  };

  return coalesced.read(key, run, cacheMs);
}

/**
 * Fetch the API-key model catalog: the models this key can actually call.
 *
 * This is a free, read-only `GET /v1/models` — it spends no credits and
 * consumes no inference quota. It is the same list the DSH Models page shows
 * in "选择要添加的模型", and it is deliberately kept separate from the
 * console's `pool-usage` `model_ids`, which is the PLAN's advertised
 * coverage (it lists models this key has no permission for).
 *
 * @param {ResolvedSettings} settings - resolved plugin settings.
 * @param {number} cacheMs - how long to keep the response (long: the catalog is stable).
 * @param {Map<string, { body: unknown; at: number; gen: number }>} cache - the cache map to use.
 * @param {Map<string, Promise<unknown>>} inflight - the in-flight map to share requests through.
 * @param {string} apiKey - the SenseNova API key. The catalog is keyed per
 *   this key's fingerprint, so a key that is swapped (in the panel or out of
 *   band) walks into a fresh cache entry instead of serving the old key's
 *   one-hour-old model list.
 */
export async function fetchModelCatalog(
  settings: ResolvedSettings,
  cacheMs: number,
  cache: Map<string, { body: unknown; at: number; gen: number }>,
  inflight: Map<string, Promise<unknown>>,
  apiKey: string
): Promise<object[]> {
  const url = `${settings.apiBase}/models`;
  // Same single-flight treatment as fetchConsole: an open panel and a Models
  // page both poll `/v1/models`, and they should share one call. The key
  // carries the key's fingerprint: the catalog is per-key, and a stale key's
  // one-hour cache must not bleed into a fresh key's poll.
  const coalesced = createCoalescedFetch({ cache, inflight });
  const key = `${url}@${credentialFingerprint(apiKey)}`;

  const run = async () => {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      // The catalog is a console call on the same footing as any other, so it
      // takes the console deadline rather than a number of its own.
      signal: AbortSignal.timeout(settings.consoleTimeoutMs)
    });
    if (!response.ok) throw new Error(`/v1/models returned HTTP ${response.status}`);
    const body = await response.json();
    // Keep the WHOLE entry, not just the id: vision identification may read
    // structured fields (input_modalities etc.) that a bare id list throws
    // away. `id` is normalized; unknown fields ride along untouched so a
    // platform adding `input_modalities` needs no parser change here.
    const models = Array.isArray(body?.data)
      ? body.data
          .map((entry: unknown) => {
            const source = obj(entry);
            return { id: str(source.id, ""), ...source };
          })
          .filter((entry: { id?: string }) => entry.id !== "")
      : [];
    return models;
  };

  return coalesced.read(key, run, cacheMs);
}

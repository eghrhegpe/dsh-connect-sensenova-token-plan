/**
 * One coalescing read-through cache: a TTL cache plus ONE in-flight promise
 * per key.
 *
 * Two properties every caller needs, and that are easy to get wrong when each
 * fetch re-implements them by hand (as `console-client.ts` once did twice):
 *
 *   1. **Single flight** — N concurrent readers of one key share ONE upstream
 *      call. Without it, every open panel (or tab) polling at once issues its
 *      own request, which is how a Host walks into the platform's own rate
 *      limiter.
 *   2. **Read-through TTL** — a fresh answer is served from memory; a stale one
 *      is refetched.
 *
 * A REJECTED producer is shared but never cached: a failure is not an answer,
 * and caching one would pin an error on the panel for a whole TTL after a
 * single transient hiccup. Sharing the rejection is still correct — the callers
 * asked for the same thing at the same time and get the same outcome.
 *
 * The maps are injectable so a caller can share one cache across modules (the
 * console route's `cache`/`inflight` pair is created in `index.ts` and cleared
 * wholesale when the account or key changes).
 *
 * @module dsh-connect-sensenova-token-plan/coalesced-fetch
 */

/**
 * The longest TTL any caller may use; entries older than this are swept so the
 * map cannot grow without bound when keys are per-credential and credentials
 * rotate.
 */
export const MAX_CACHE_AGE_MS = 3600_000;

/**
 * A coalescing read-through cache.
 * @param {object} [options]
 * @param {Map<string, {body: unknown, at: number}>} [options.cache] - an
 *   existing cache map to share; a fresh one is created when omitted.
 * @param {Map<string, Promise<unknown>>} [options.inflight] - an existing
 *   in-flight map to share.
 * @param {number} [options.maxAgeMs] - the sweep ceiling.
 * @returns {{
 *   read: (key: string, producer: () => Promise<unknown>, ttlMs: number) => Promise<unknown>,
 *   clear: (key?: string) => void
 * }}
 */
export function createCoalescedFetch(options: {
  cache?: Map<string, { body: unknown; at: number }>;
  inflight?: Map<string, Promise<unknown>>;
  maxAgeMs?: number;
} = {}) {
  const {
    cache = new Map(),
    inflight = new Map(),
    maxAgeMs = MAX_CACHE_AGE_MS
  } = options;

  /** Drop entries past the sweep ceiling; called after every write. */
  const sweep = () => {
    const nowMs = Date.now();
    for (const [key, entry] of cache) {
      if (nowMs - entry.at > maxAgeMs) cache.delete(key);
    }
  };

  /**
   * Read one key through the cache, coalescing concurrent misses.
   * @param {string} key - the cache key (a URL, or a key carrying a
   *   credential fingerprint — see the raccoon route).
   * @param {() => Promise<unknown>} producer - what to call on a miss.
   * @param {number} ttlMs - how long an answer stays fresh (`0` = never
   *   reuse; the single-flight sharing still applies).
   * @returns {Promise<unknown>} the value.
   */
  const read = async (key, producer, ttlMs) => {
    const cached = cache.get(key);
    if (cached !== undefined && Date.now() - cached.at < ttlMs) return cached.body;
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    const flight = (async () => {
      const body = await producer();
      cache.set(key, { body, at: Date.now() });
      sweep();
      return body;
    })().finally(() => {
      // Runs on BOTH paths: a rejection must not leave a poisoned promise
      // behind, or every later reader of this key inherits that failure.
      inflight.delete(key);
    });
    inflight.set(key, flight);
    return flight;
  };

  /**
   * Drop one key's cached answer, or the whole cache.
   *
   * In-flight calls are NOT cancelled — a reader already waiting answers with
   * what it asked for, and the next read simply misses. What this guarantees is
   * that the NEXT read after a change (a new account, a forgotten key, a fresh
   * login) cannot be served an answer belonging to the previous identity.
   * @param {string} [key] - the key to drop; omit to drop everything.
   * @returns {void}
   */
  const clear = (key) => {
    if (key === undefined) {
      cache.clear();
      return;
    }
    cache.delete(key);
  };

  return { read, clear };
}

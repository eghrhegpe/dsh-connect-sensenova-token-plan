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
  cache?: Map<string, { body: unknown; at: number; gen: number }>;
  inflight?: Map<string, Promise<unknown>>;
  maxAgeMs?: number;
} = {}) {
  const {
    cache = new Map(),
    inflight = new Map(),
    maxAgeMs = MAX_CACHE_AGE_MS
  } = options;

  // Generation counters, one per key and one global: `clear()` bumps them so a
  // STALE in-flight producer — the one that started before the clear and lands
  // after it — cannot write its answer back where a newer identity now owns the
  // key. Each cache entry carries the generation it was written under; a read
  // only accepts entries whose generation matches the key's CURRENT one, so a
  // late write from a pre-clear flight is written but immediately invisible,
  // and the next read simply refetches. This is what makes `clear()`'s promise
  // (below) actually hold in the concurrent case.
  let globalGen = 0;
  const keyGens = new Map<string, number>();
  const genOf = (key: string) => keyGens.get(key) ?? globalGen;

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
    if (cached !== undefined && cached.gen === genOf(key) && Date.now() - cached.at < ttlMs) return cached.body;
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    // Capture the generation the flight is born under: if `clear()` runs while
    // this producer is in flight, the write below lands under the OLD gen and
    // is ignored by every later read.
    const born = genOf(key);
    const flight = (async () => {
      const body = await producer();
      cache.set(key, { body, at: Date.now(), gen: born });
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
   * The drop bumps the key's (or the global) generation AND evicts the
   * in-flight map entry, so the NEXT read cannot join a pre-clear flight nor be
   * served a pre-clear cache entry — the previous identity's answer is gone for
   * good even when its producer was still in flight when the change happened.
   * In-flight calls themselves are NOT cancelled: a reader that already took a
   * flight's promise still settles with what it asked for; only NEW reads miss.
   * @param {string} [key] - the key to drop; omit to drop everything.
   * @returns {void}
   */
  const clear = (key) => {
    if (key === undefined) {
      globalGen += 1;
      cache.clear();
      // A pre-clear flight must not be joinable by the next read either.
      inflight.clear();
      keyGens.clear();
      return;
    }
    keyGens.set(key, genOf(key) + 1);
    cache.delete(key);
    inflight.delete(key);
  };

  return { read, clear };
}

/**
 * Doubles that more than one suite needs.
 *
 * Distinct from `harness.mjs`: that one carries the reporting ceremony every
 * suite runs; this one carries the *fakes* three suites had each hand-rolled.
 * A fake that silently diverges from its sibling is worse than a duplicated
 * helper — `resolve()` below was already two different predicates
 * (`.length > 0` in two suites, `!== ""` in the third) with the same intent,
 * and only one of them was right about non-string refs.
 *
 * This module is deliberately peer-FREE. Suites that use it range from
 * peer-free (`snapshot-aggregate`) to peer-dependent (`store`, `routes`,
 * `wiring`), so importing a Host peer here would make the fake unusable from
 * exactly the suites that need it most on a clean checkout.
 */

/**
 * A `Map`-backed stand-in for the credentials service.
 *
 * Serves three call sites that had drifted into three different feature sets,
 * so every capability is a parameter rather than a fork:
 * @param {object} [options]
 * @param {string} [options.key] - the record key `initial` is stored under.
 * @param {unknown} [options.initial] - seeded record. Stored only when TRUTHY,
 *   matching all three predecessors (passing `null` means "no record yet", not
 *   "a record whose value is null").
 * @param {Record<string, unknown>} [options.refs] - seeded `ref -> value`.
 * @param {Record<string, string>} [options.env] - environment values `resolve`
 *   prefers over `refs`, so the `source: "env"` branch stays exercised.
 * @param {string[]} [options.readOnly] - refs whose `set` throws the way the
 *   real local credentials provider does when the launcher supplies them.
 * @param {number} [options.delayMs] - await this long inside `modifyRecord`.
 *   The lock-ordering suite needs it to force overlap; everyone else leaves it 0.
 */
export function fakeCredentials({ key, initial, refs, env, readOnly, delayMs = 0 } = {}) {
  const records = new Map();
  const refsMap = new Map(Object.entries(refs ?? {}));
  if (initial) records.set(key, initial);
  // Always recorded, even where unused: `calls.modify` is how the concurrency
  // suite proves the lock held, and an always-present counter cannot be
  // forgotten by a suite that later needs it.
  const calls = { modify: 0, concurrentModify: 0, inModify: 0 };
  return {
    calls,
    records,
    refs: refsMap,
    async readRecord(k) { return records.get(k); },
    async modifyRecord(k, mutate) {
      calls.modify += 1;
      calls.inModify += 1;
      if (calls.inModify > 1) calls.concurrentModify += 1;
      try {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        const next = await mutate(records.get(k));
        // `undefined` means "no change", NOT "store undefined" — the real
        // service returns the untouched record, and a suite asserting on a
        // deleted value would otherwise see a silent write.
        if (next === undefined) return records.get(k);
        records.set(k, next);
        return next;
      } finally {
        calls.inModify -= 1;
      }
    },
    async deleteRecord(k) { records.delete(k); },
    async resolve(ref) {
      const envValue = env?.[ref];
      if (typeof envValue === "string" && envValue.length > 0) return { value: envValue, source: "env" };
      const value = refsMap.get(ref);
      // `.length > 0` rather than `!== ""`: a non-string in `refs` is a mistake
      // in the test, and reporting it as a resolved value hides the mistake.
      return typeof value === "string" && value.length > 0 ? { value, source: "file" } : undefined;
    },
    async set(ref, value) {
      if (readOnly?.includes(ref)) {
        throw new Error(`credentials-local: "${ref}" is supplied read-only by the launching environment, so set would be shadowed`);
      }
      refsMap.set(ref, value);
    },
    async unset(ref) { refsMap.delete(ref); }
  };
}

/**
 * Minimal `fetch` stub: routes by URL fragment, records what was asked for, and
 * restores the previous global on {restore}.
 *
 * The unmatched case THROWS rather than 404-ing, so a suite that forgets a
 * route fails at the call site instead of asserting on an empty body and
 * blaming the parser.
 * @param {Record<string, unknown | ((url: string, fragment: string) => unknown)>} routes
 *   fragment -> response body, or a handler returning the full response.
 * @param {{hold?: Promise<void>}} [options] - `hold` is awaited before matching,
 *   which is how a suite keeps a request in flight across a state change.
 */
export function stubFetch(routes, { hold } = {}) {
  const asked = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(typeof input === "string" ? input : (input?.url ?? input));
    asked.push(url);
    if (hold !== undefined) await hold;
    const match = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    if (match === undefined) throw new Error(`unstubbed request: ${url}`);
    const [fragment, behaviour] = match;
    // Handlers get `(url, fragment)`; the fragment is new, so existing handlers
    // that only wanted the URL are unaffected.
    if (typeof behaviour === "function") return behaviour(url, fragment);
    return {
      ok: true,
      status: 200,
      json: async () => behaviour,
      text: async () => JSON.stringify(behaviour)
    };
  };
  return { asked, restore: () => { globalThis.fetch = previous; } };
}

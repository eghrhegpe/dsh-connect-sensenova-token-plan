/**
 * The `api-key-store.ts` resolve() probe semantics (0.10.1, GitHub PR #9
 * rework) — what the PR shipped and what the audit kept:
 *
 * - The CLOSED dual-ref probe: the plugin's own `SENSENOVA_API_KEY` first,
 *   then the provider-DERIVED `SENSENOVA_TOKEN_PLAN_API_KEY` that the host's
 *   built-in 添加模型 page writes (`deriveKeyRef("sensenova-token-plan")`,
 *   verified against `dsh-client-ui-settings-models`). Without the second
 *   probe, a key saved through that page was invisible and the provider
 *   reported "not configured" — the disease PR #9 fixed.
 * - Isolation negative controls: NO wildcard scan. The credentials service is
 *   shared by every plugin on this Host, and the 小浣熊 upstream keeps refs of
 *   its own (§5 invariant 3: the two upstreams' credential references are
 *   fully isolated). Other `/sensenova/i` refs — including a service that
 *   exposes an internal `.values` shape (the PR's `(service as any).values`
 *   hack, rejected in the rework) — must never be returned.
 * - The closed-set pin: `resolve()` queries exactly `RESOLVE_REF_PROBES` and
 *   nothing else — a new ref appearing in the query log is a red.
 *
 * save/forget/env/failure-fall-through are covered by `provider.test.mjs`
 * §11–13b; this suite does not duplicate them.
 */
import { createApiKeyStore, API_KEY_REF, DERIVED_KEY_REF, RESOLVE_REF_PROBES } from "../src/host/api-key-store.ts";
import { check, fail, finish } from "./harness.mjs";

// A service shaped like the DSH credentials service, with spies.
function fakeService(initial = {}) {
  const refs = new Map(Object.entries(initial));
  const queried = [];
  const unset = [];
  const service = {
    async resolve(ref) {
      queried.push(ref);
      const value = refs.get(ref);
      return value === undefined ? undefined : { value };
    },
    async set(ref, value) { refs.set(ref, value); },
    async unset(ref) { unset.push(ref); refs.delete(ref); }
  };
  return { service, refs, queried, unset };
}

// --- 1. the closed probe set (the §15-style surface) ------------------------
{
  const derived = "sensenova-token-plan".toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
  check("DERIVED_KEY_REF is the host's deriveKeyRef('sensenova-token-plan')",
    DERIVED_KEY_REF === derived, JSON.stringify({ DERIVED_KEY_REF, derived }));
  check("RESOLVE_REF_PROBES is the closed dual list, plugin ref first",
    RESOLVE_REF_PROBES.length === 2 &&
      RESOLVE_REF_PROBES[0] === API_KEY_REF &&
      RESOLVE_REF_PROBES[1] === DERIVED_KEY_REF &&
      API_KEY_REF === "SENSENOVA_API_KEY",
    JSON.stringify({ API_KEY_REF, DERIVED_KEY_REF, RESOLVE_REF_PROBES }));
  check("RESOLVE_REF_PROBES is frozen (the set stays closed)",
    Object.isFrozen(RESOLVE_REF_PROBES));
}

// --- 2. the "Provider is not configured" gap (PR #9's original disease) -----
{
  try {
    const { service, refs } = fakeService({ [DERIVED_KEY_REF]: "sk-derived" });
    const store = createApiKeyStore({ credentials: () => service, env: {} });
    const resolved = await store.resolve();
    check("a key saved via the built-in 添加模型 page resolves (derived ref)",
      resolved.value === "sk-derived" && resolved.source === "credentials",
      JSON.stringify({ value: resolved.value, source: resolved.source }));
    const state = await store.state();
    check("state() reports hasApiKey with ONLY the derived ref present",
      state.hasApiKey === true && state.keySource === "credentials",
      JSON.stringify(state));
    await store.forget();
    check("forget() leaves the built-in page's ref intact (no cross-surface write)",
      refs.has(DERIVED_KEY_REF) && (await store.resolve()).value === "sk-derived",
      JSON.stringify({ refs: [...refs.keys()], re: (await store.resolve()).value }));
  } catch (error) {
    fail("derived-ref resolution", error);
  }
}

// --- 3. precedence: the plugin's own ref wins over the derived ref ---------
{
  try {
    const { service } = fakeService({ [API_KEY_REF]: "sk-panel", [DERIVED_KEY_REF]: "sk-derived" });
    const store = createApiKeyStore({ credentials: () => service, env: {} });
    check("both refs present: the panel-saved ref (probe #1) wins",
      (await store.resolve()).value === "sk-panel");
  } catch (error) {
    fail("probe precedence", error);
  }
}

// --- 4. isolation: other /sensenova/i refs are never returned --------------
{
  try {
    const { service } = fakeService({
      "SENSENOVA_RACCOON_API_KEY": "sk-raccoon",
      "sensenova-something": "sk-other"
    });
    const store = createApiKeyStore({ credentials: () => service, env: {} });
    check("other /sensenova/i refs (raccoon domain, §5 invariant 3) are NOT returned",
      (await store.resolve()).value === "",
      JSON.stringify(await store.state()));
  } catch (error) {
    fail("credential isolation", error);
  }
}

// --- 5. the rejected internal-shape probe (PR #9's `(service as any).values`) 
{
  try {
    const { service, refs } = fakeService({ "SENSENOVA_RACCOON_API_KEY": "sk-raccoon" });
    service.values = refs; // the internal shape the PR's scan reached for
    const store = createApiKeyStore({ credentials: () => service, env: {} });
    check("a service exposing a `.values` Map is still not scanned (internal shape ≠ contract)",
      (await store.resolve()).value === "");
  } catch (error) {
    fail("internal-shape rejection", error);
  }
}

// --- 6. the query log IS the closed set ------------------------------------
{
  try {
    const { service, queried } = fakeService({});
    const store = createApiKeyStore({ credentials: () => service, env: {} });
    await store.resolve();
    check("resolve() queries exactly the closed probe list, in order, no more (no scan)",
      queried.length === RESOLVE_REF_PROBES.length &&
        RESOLVE_REF_PROBES.every((ref, i) => queried[i] === ref),
      JSON.stringify(queried));
  } catch (error) {
    fail("closed query log", error);
  }
}

// --- 7. whitespace under the derived ref is "absent" ------------------------
{
  try {
    const { service } = fakeService({ [DERIVED_KEY_REF]: "   " });
    const store = createApiKeyStore({ credentials: () => service, env: { [API_KEY_REF]: "sk-env" } });
    const resolved = await store.resolve();
    check("a whitespace-only derived value falls through to the env fallback",
      resolved.value === "sk-env" && resolved.source === "env",
      JSON.stringify(resolved));
  } catch (error) {
    fail("whitespace fall-through", error);
  }
}

// --- 8. save() writes ONLY the plugin's own ref -----------------------------
{
  try {
    const { service, refs } = fakeService({ [DERIVED_KEY_REF]: "sk-derived" });
    const store = createApiKeyStore({ credentials: () => service, env: {} });
    await store.save("sk-panel");
    check("save() writes only under the plugin ref (never overwrites the built-in page's ref)",
      refs.get(API_KEY_REF) === "sk-panel" && refs.get(DERIVED_KEY_REF) === "sk-derived",
      JSON.stringify([...refs.entries()]));
    check("and the panel-saved value then beats the derived ref",
      (await store.resolve()).value === "sk-panel");
  } catch (error) {
    fail("save ref hygiene", error);
  }
}

finish();

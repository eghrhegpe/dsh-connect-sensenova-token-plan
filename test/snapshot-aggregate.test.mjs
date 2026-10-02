/**
 * `buildSnapshotBody`'s quota-state contract — the three-state one.
 *
 * The aggregator is a pure function behind one read-only route, so everything
 * here is driven through its parameters plus a stubbed `fetch`; nothing touches
 * the network, the filesystem, or a real Host.
 *
 * What is pinned, and why it needed a suite of its own:
 *
 *   The aggregator used to ask `exhaustedModelIds` for the set of models whose
 *   quota pool is empty, and that function can only answer yes or no — never
 *   "the console never answered". Both "nothing is exhausted" and "the poll
 *   failed" arrived as an empty pool list, because `parsePools(null)` folds an
 *   absent body to `{ pools: [] }`. Downstream, an empty unavailable set means
 *   "no pool is exhausted", so a signed-out / expired-JWT / offline Host — this
 *   plugin's most common state — published an EMPTY set and re-registered the
 *   provider with every quota-blocked model handed back to the picker. The
 *   protection inverted exactly when it was needed.
 *
 *   The rule these checks pin: UNKNOWN is not a state change. A poll that could
 *   not read the quota must keep the last known set, must not treat the
 *   difference as a flip, and must say so in `quotaError` (which it already
 *   did) rather than in the model list.
 *
 * @module dsh-connect-sensenova-token-plan/test/snapshot-aggregate
 */
import { buildSnapshotBody } from "../src/host/snapshot-aggregate.ts";
import { resolveSettings } from "../src/host/host-config.ts";
import { catalogSignature, syncSignaturesAfterPublish, quotaSignatureOf } from "../src/host/provider-publish.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

const { settings } = resolveSettings({});

/** A pool whose 5h window is spent: `limit` known, `remaining` zero. */
const EXHAUSTED_POOL = {
  plan: { id: "p1", name: "TokenPlan", type: "token_plan" },
  pools: [{
    id: "pool-1",
    model_ids: ["glm-5.2", "glm-4.6"],
    window_5h: { limit: "100", remaining: "0" },
    window_7d: { limit: "100", remaining: "50" }
  }]
};

/** Nothing exhausted: the same shape with credit left in both windows. */
const HEALTHY_POOL = {
  plan: { id: "p1", name: "TokenPlan", type: "token_plan" },
  pools: [{
    id: "pool-1",
    model_ids: ["glm-5.2", "glm-4.6"],
    window_5h: { limit: "100", remaining: "80" },
    window_7d: { limit: "100", remaining: "90" }
  }]
};

const TREND_OK = { series: [], models: [] };

/** Minimal `fetch` stub: routes by URL, records what was asked for. */
function stubFetch(routes) {
  const asked = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(typeof input === "string" ? input : (input?.url ?? input));
    asked.push(url);
    const match = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    if (match === undefined) throw new Error(`unstubbed request: ${url}`);
    const [fragment, behaviour] = match;
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

/**
 * Assembles the aggregator's parameter bag.
 *
 * `publisher.state` is a real `ProviderPublisherState`-shaped object, because
 * the aggregator reads it as the source of truth for what is currently
 * registered — stubbing it as `{}` would let these checks pass for the wrong
 * reason.
 */
function harness({ stateOverrides = {}, published = [] } = {}) {
  const state = {
    entries: [],
    enabledIds: [],
    unavailableIds: [],
    signature: "",
    quotaSignature: "",
    llmAvailable: true,
    registered: false,
    ...stateOverrides
  };
  return {
    state,
    published,
    params: {
      settings,
      cache: new Map(),
      inflight: new Map(),
      tokenStore: {
        getToken: async () => "test-token",
        invalidate: () => {},
        state: async () => ({ configured: true, ephemeral: false })
      },
      apiKeyStore: {
        // No key: the catalogue fetch is skipped, so these checks exercise the
        // quota path alone (which is where the three-state bug lived).
        resolve: async () => ({ value: "" }),
        state: async () => ({ hasApiKey: false, keySource: null, ephemeral: false })
      },
      publisher: {
        state,
        publish: async (entries, enabledIds, unavailableModelIds) => {
          published.push({ entries, enabledIds, unavailableModelIds });
          // Mirror what the real publisher does on a successful publish
          // (`provider-publish.ts`): the offer is recorded on the shared state,
          // and the poll's `syncSignaturesAfterPublish` then reads it back. A
          // stub that only recorded the call would leave `unavailableIds` at
          // its seed value, so the signature checks below would be measuring
          // the stub rather than the aggregator.
          state.entries = Array.isArray(entries) ? entries : [];
          state.enabledIds = Array.isArray(enabledIds) ? enabledIds : [];
          state.unavailableIds = Array.isArray(unavailableModelIds) ? unavailableModelIds : [];
          return { ok: true };
        }
      },
      catalogStore: {
        listEnabledIds: async () => [],
        replace: async () => {}
      },
      panelSwitch: async () => null
    }
  };
}

// === A. a readable quota drives the unavailable set =========================
{
  const { params, state, published } = harness();
  const net = stubFetch({
    "pool-usage": EXHAUSTED_POOL,
    "credit-usage-trend": TREND_OK
  });
  let body;
  try {
    body = await buildSnapshotBody(params);
  } finally {
    net.restore();
  }
  check("A1 a readable quota reports the exhausted models as blocked",
    JSON.stringify(body.llm.quotaBlockedModelIds) === JSON.stringify(["glm-5.2", "glm-4.6"]),
    JSON.stringify(body.llm.quotaBlockedModelIds));
  check("A2 a readable quota is not reported as a failure",
    body.quotaError === null || body.quotaError === undefined,
    JSON.stringify(body.quotaError));
  check("A3 the first exhausted reading re-registers the provider once",
    published.length === 1 && JSON.stringify(published[0].unavailableModelIds) === JSON.stringify(["glm-5.2", "glm-4.6"]),
    `published=${published.length} ${JSON.stringify(published[0]?.unavailableModelIds)}`);
  check("A4 the published quota signature matches the standalone function",
    state.quotaSignature === quotaSignatureOf(["glm-5.2", "glm-4.6"]),
    `${state.quotaSignature}`);
}

// === B. THE BUG: an unreadable quota must not widen the offer ===============
// Seeded as if a previous poll had already learned that two models are
// exhausted — the state a real Host is in for most of its life.
{
  const known = ["glm-5.2", "glm-4.6"];
  const { params, published } = harness({
    stateOverrides: {
      entries: [{ id: "glm-5.2" }, { id: "glm-4.6" }],
      unavailableIds: known,
      signature: catalogSignature([{ id: "glm-5.2" }, { id: "glm-4.6" }], []),
      quotaSignature: quotaSignatureOf(known)
    }
  });
  const net = stubFetch({
    // The console is unreachable: this is what a signed-out or offline Host
    // looks like, and it used to be read as "nothing is exhausted".
    "pool-usage": () => { throw new Error("the console is unreachable"); },
    "credit-usage-trend": TREND_OK
  });
  let body;
  try {
    body = await buildSnapshotBody(params);
  } finally {
    net.restore();
  }
  check("B1 an unreadable quota does NOT re-register the provider",
    published.length === 0,
    `published=${published.length} ${JSON.stringify(published[0]?.unavailableModelIds)}`);
  check("B2 an unreadable quota keeps the last known blocked set",
    JSON.stringify(body.llm.quotaBlockedModelIds) === JSON.stringify(known),
    JSON.stringify(body.llm.quotaBlockedModelIds));
  check("B3 an unreadable quota still says WHY on the quota block",
    body.quotaError !== null && body.quotaError !== undefined,
    JSON.stringify(body.quotaError));
  check("B4 the panel is told the quota failed rather than that it is empty",
    typeof body.quotaError?.code === "string" && body.quotaError.code !== "",
    JSON.stringify(body.quotaError));
}

// === C. a healthy quota after a failure re-opens the models ================
// The other direction: protection that can never be lifted is its own failure,
// so a REAL reading of "nothing exhausted" must still take effect.
{
  const { params, published } = harness({
    stateOverrides: {
      entries: [{ id: "glm-5.2" }],
      unavailableIds: ["glm-5.2"],
      signature: catalogSignature([{ id: "glm-5.2" }], []),
      quotaSignature: quotaSignatureOf(["glm-5.2"])
    }
  });
  const net = stubFetch({
    "pool-usage": HEALTHY_POOL,
    "credit-usage-trend": TREND_OK
  });
  let body;
  try {
    body = await buildSnapshotBody(params);
  } finally {
    net.restore();
  }
  check("C1 a genuinely healthy quota DOES re-register, with nothing blocked",
    published.length === 1 && JSON.stringify(published[0].unavailableModelIds) === JSON.stringify([]),
    `published=${published.length} ${JSON.stringify(published[0]?.unavailableModelIds)}`);
  check("C2 the panel stops greying the models",
    JSON.stringify(body.llm.quotaBlockedModelIds) === JSON.stringify([]),
    JSON.stringify(body.llm.quotaBlockedModelIds));
}

// === D. a stable quota does not churn the registration =====================
{
  const known = ["glm-5.2"];
  const { params, published } = harness({
    stateOverrides: {
      entries: [{ id: "glm-5.2" }, { id: "glm-4.6" }],
      unavailableIds: known,
      signature: catalogSignature([{ id: "glm-5.2" }, { id: "glm-4.6" }], []),
      quotaSignature: quotaSignatureOf(known)
    }
  });
  const net = stubFetch({
    "pool-usage": EXHAUSTED_POOL,
    "credit-usage-trend": TREND_OK
  });
  try {
    await buildSnapshotBody(params);
  } finally {
    net.restore();
  }
  // EXHAUSTED_POOL blocks BOTH models while the seeded state knows one, so this
  // asserts the fingerprint actually moves on a real change.
  check("D1 a quota reading that DIFFERS from the seeded state re-registers",
    published.length === 1 && published[0].unavailableModelIds.length === 2,
    `published=${published.length} ${JSON.stringify(published[0]?.unavailableModelIds)}`);
}

// === E. the exported signature helper is the one both paths use =============
{
  const { state } = harness({ stateOverrides: { entries: [{ id: "b" }, { id: "a" }], enabledIds: ["z"], unavailableIds: ["b", "a"] } });
  syncSignaturesAfterPublish(state);
  check("E1 syncSignaturesAfterPublish delegates to quotaSignatureOf (order-independent)",
    state.quotaSignature === quotaSignatureOf(["a", "b"]),
    `${state.quotaSignature}`);
  check("E2 the catalogue signature still tracks entries and the allow-list",
    state.signature === catalogSignature([{ id: "b" }, { id: "a" }], ["z"]),
    `${state.signature}`);
}

// --- report ----------------------------------------------------------------
const passed = results.filter((result) => result.pass).length;
const failed = results.filter((result) => !result.pass);
for (const result of failed) {
  console.error(`  FAIL  ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
}
console.log(`\nsnapshot-aggregate.test.mjs: ${passed}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;

/**
 * `buildSnapshotBody`'s quota-state contract — the three-state one.
 *
 * Everything here is driven through the aggregator's parameters plus a stubbed
 * `fetch` and stubbed stores, so THIS SUITE touches no network, no filesystem,
 * and no real Host. (The aggregator itself is not side-effect-free — a changed
 * catalogue writes the catalog state file and can rebuild the registration;
 * that is exactly why the stores below are stubs that RECORD rather than skip.)
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
import { results, check, finishVerbose } from "./harness.mjs";


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
function harness({ stateOverrides = {}, published = [], publishResult = { ok: true }, quotaWrites = [], replaceCalls = [], apiKey = "" } = {}) {
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
    quotaWrites,
    replaceCalls,
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
        // No key by default: the catalogue fetch is skipped, so the groups
        // below exercise the quota path alone (which is where the three-state
        // bug lived). `apiKey` opts a group into the catalogue branch.
        resolve: async () => ({ value: apiKey }),
        state: async () => ({ hasApiKey: apiKey !== "", keySource: apiKey !== "" ? "memory" : null, ephemeral: false })
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
          // A build failure is REPORTED, not thrown: the real publisher answers
          // `{ok:false}` and keeps the pair that was already serving. `publishResult`
          // lets the F group drive that branch, which is the whole point of it.
          return publishResult;
        }
      },
      catalogStore: {
        listEnabledIds: async () => [],
        // The quota dimension of a catalog write is RECORDED, not dropped:
        // the restart seed reads it (review #1a), and the checks below say
        // which poll must have stamped it.
        replace: async (entries, enabledIds, unavailableIds) => {
          replaceCalls.push({ entries, enabledIds, unavailableIds });
        },
        setUnavailable: async (ids) => {
          quotaWrites.push(ids);
        }
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

// === F. a publish that FAILED must not adopt the signature =================
// `publisher.publish` reports a build failure by RETURNING `{ok:false}` — it
// keeps the pair that was already serving — so a bare `await` still reaches
// the next line. Syncing the signature there stamped the NEW state's signature
// onto a registration that was still the OLD one, and the next poll's
// change-detection compared signatures, saw "no change", and never retried.
// The catalogue store had already been rewritten, so the panel quoted a model
// count the picker was not serving — until the catalogue changed again or the
// Host restarted, which is why this class of bug always reported as "a restart
// fixes it". An OFFER is not a published offer.
{
  const { params, state, published } = harness({ publishResult: { ok: false } });
  const net = stubFetch({ "pool-usage": EXHAUSTED_POOL, "credit-usage-trend": TREND_OK });
  try {
    await buildSnapshotBody(params);
  } finally {
    net.restore();
  }
  check("F1 a failed publish is still attempted (the offer is not silently dropped)",
    published.length === 1, `published=${published.length}`);
  check("F2 a failed publish leaves the quota signature unset, so the next poll retries",
    state.quotaSignature === "", `${state.quotaSignature}`);
}

// The negative control for F: an `ok` publish must STILL sync. Without this the
// F group would also pass for someone who simply deleted the sync call — which
// would reintroduce the churn bug the sync exists to prevent.
{
  const { params, state } = harness();
  const net = stubFetch({ "pool-usage": EXHAUSTED_POOL, "credit-usage-trend": TREND_OK });
  try {
    await buildSnapshotBody(params);
  } finally {
    net.restore();
  }
  check("F3 a successful publish still adopts the signature (the gate did not just delete the sync)",
    state.quotaSignature === quotaSignatureOf(["glm-5.2", "glm-4.6"]), `${state.quotaSignature}`);
}

// === G. the quota dimension rides the persisted catalog (review #1a) =========
// A restart must inherit the LAST KNOWN exhausted set (`seedPublisherFromCatalog`
// reads `listUnavailable`), so every branch that re-registers must also PERSIST
// the answer: the catalogue branch stamps it inside `replace`, a quota flip with
// an unchanged catalogue lands via `setUnavailable`, and an UNKNOWN poll states
// nothing (the third argument is ABSENT — preserving the stored record, not
// writing an empty one).
{
  const CATALOG_OK = { data: [{ id: "glm-5.2" }, { id: "glm-4.6" }] };

  // Catalogue changed + quota answered → replace carries the exhausted set.
  const replaceCalls = [];
  const { params } = harness({ apiKey: "sk-test", replaceCalls });
  let net = stubFetch({
    "pool-usage": EXHAUSTED_POOL,
    "credit-usage-trend": TREND_OK,
    "/v1/models": CATALOG_OK
  });
  try {
    await buildSnapshotBody(params);
  } finally {
    net.restore();
  }
  check("G1 a catalogue write carries the last KNOWN exhausted set",
    replaceCalls.length === 1 &&
      JSON.stringify(replaceCalls[0].unavailableIds) === JSON.stringify(["glm-5.2", "glm-4.6"]),
    JSON.stringify(replaceCalls.map((c) => c.unavailableIds)));

  // Catalogue UNCHANGED (signature seeded) + quota flipped → setUnavailable.
  const quotaWrites = [];
  const seeded = {
    entries: [{ id: "glm-5.2" }, { id: "glm-4.6" }],
    enabledIds: [],
    unavailableIds: ["glm-5.2"],
    signature: catalogSignature([{ id: "glm-5.2" }, { id: "glm-4.6" }], []),
    quotaSignature: quotaSignatureOf(["glm-5.2"])
  };
  const h2 = harness({ apiKey: "sk-test", quotaWrites, stateOverrides: seeded });
  net = stubFetch({
    "pool-usage": EXHAUSTED_POOL,
    "credit-usage-trend": TREND_OK,
    "/v1/models": CATALOG_OK
  });
  try {
    await buildSnapshotBody(h2.params);
  } finally {
    net.restore();
  }
  check("G2 a quota flip with an unchanged catalogue still persists the flip",
    quotaWrites.length === 1 && JSON.stringify(quotaWrites[0]) === JSON.stringify(["glm-5.2", "glm-4.6"]),
    JSON.stringify(quotaWrites));
  check("G3 the catalogue write that did not change does not double-stamp",
    h2.replaceCalls.length === 0, JSON.stringify(h2.replaceCalls.map((c) => c.unavailableIds)));

  // Quota UNKNOWN (console unreachable) + catalogue branch → third arg ABSENT.
  const h4calls = [];
  const h4 = harness({
    apiKey: "sk-test",
    replaceCalls: h4calls,
    stateOverrides: { unavailableIds: ["glm-5.2"], quotaSignature: quotaSignatureOf(["glm-5.2"]) }
  });
  net = stubFetch({
    "pool-usage": () => { throw new Error("the console is unreachable"); },
    "credit-usage-trend": TREND_OK,
    "/v1/models": CATALOG_OK
  });
  try {
    await buildSnapshotBody(h4.params);
  } finally {
    net.restore();
  }
  check("G4 an unknown quota writes the catalogue WITHOUT stating a set",
    h4calls.length === 1 && h4calls[0].unavailableIds === undefined,
    JSON.stringify(h4calls.map((c) => c.unavailableIds)));
  check("G5 the publish on an unknown quota re-offers the LAST KNOWN set, not an empty one",
    JSON.stringify(h4.published[0]?.unavailableModelIds) === JSON.stringify(["glm-5.2"]),
    JSON.stringify(h4.published[0]?.unavailableModelIds));
}

// --- H. a drained pool that names no models is REPORTED --------------------
// The hazard this covers: `model_ids` renamed upstream → the pool still reads
// "exhausted" but covers no models, so nothing is blocked AND nothing is
// bannered. Both those behaviours are correct; with no report the protection
// would be off while every visible reading still looked right. Note the second
// half of H2 — the sample block must stay empty, or a "fix" that blocks
// something would be a different (wrong) change being tested here.
{
  const H = harness({
    // Seed a PREVIOUS blocked set so the empty set below is a real transition —
    // otherwise the quota signature does not change and no publish is attempted,
    // which would make H2 vacuously pass.
    stateOverrides: { unavailableIds: ["glm-5.2"], quotaSignature: quotaSignatureOf(["glm-5.2"]) }
  });
  const drifts = [];
  H.params.onShapeDrift = (message) => drifts.push(message);
  const net = stubFetch({
    "pool-usage": {
      plan: { id: "free", name: "Free Plan" },
      pools: [{
        id: "pool-ghost",
        name: "Ghost pool",
        pool_type: "default",
        window_5h: { limit: "100", remaining: "0", reset_at: "1" },
        window_7d: { limit: "500", remaining: "400", reset_at: "2" }
      }]
    },
    "credit-usage-trend": TREND_OK
  });
  let body;
  try {
    body = await buildSnapshotBody(H.params);
  } finally {
    net.restore();
  }
  check("H1 a drained pool with no model ids is reported to the caller",
    drifts.length === 1 && drifts[0].includes("pool-ghost"),
    JSON.stringify(drifts));
  check("H2 …and it still blocks nothing (the report is not a silent widening)",
    JSON.stringify(H.published[0]?.unavailableModelIds) === JSON.stringify([]),
    JSON.stringify(H.published[0]?.unavailableModelIds));
  void body;
}

{
  const Q = harness();
  const seen = [];
  Q.params.onShapeDrift = (message) => seen.push(message);
  const net = stubFetch({
    "pool-usage": {
      plan: { id: "free", name: "Free Plan" },
      pools: [{
        id: "pool-ok", name: "Fine", pool_type: "default", model_ids: ["glm-5.2"],
        window_5h: { limit: "100", remaining: "5", reset_at: "1" },
        window_7d: { limit: "500", remaining: "400", reset_at: "2" }
      }]
    },
    "credit-usage-trend": TREND_OK
  });
  try {
    await buildSnapshotBody(Q.params);
  } finally {
    net.restore();
  }
  check("H3 a readable, non-drained quota reports nothing", seen.length === 0, JSON.stringify(seen));
}

// --- I. the counts describe the OFFER, blocked models included -------------
// The lie this pins: with every allow-listed model quota-blocked the adapter
// serves an EMPTY model list (the picker answers `no configured model`), while
// `modelCount` counted the catalogue and the panel said "2 models". The roster
// still lists them — that is HOW the panel explains the absence — so the count
// must not be fixed by emptying the roster too.
{
  const I = harness({ apiKey: "sk-test" });
  const CATALOG = { data: [{ id: "glm-5.2" }, { id: "glm-4.6" }] };
  const net = stubFetch({
    "pool-usage": EXHAUSTED_POOL,
    "credit-usage-trend": TREND_OK,
    "/v1/models": CATALOG
  });
  let body;
  try {
    body = await buildSnapshotBody(I.params);
  } finally {
    net.restore();
  }
  check("I1 a fully blocked offer counts zero models, not the catalogue size",
    body?.llm?.modelCount === 0 && body?.llm?.visionCount === 0,
    JSON.stringify({ m: body?.llm?.modelCount, v: body?.llm?.visionCount }));
  check("I2 …while the roster still lists them, tagged as unavailable",
    Array.isArray(body?.llm?.models) && body.llm.models.length === 2 &&
      body.llm.models.every((row) => row.available === false),
    JSON.stringify(body?.llm?.models));
}

// --- report ----------------------------------------------------------------
finishVerbose({ suite: "snapshot-aggregate.test.mjs" });

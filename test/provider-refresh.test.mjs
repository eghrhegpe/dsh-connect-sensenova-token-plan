/**
 * The background provider refresher (`provider-refresh.ts`) — peer-free,
 * fake-timers, stubbed fetch. What it pins is the GATE MATH, not the engine:
 * the engine (`buildSnapshotBody`) has its own suite; this one proves WHEN it
 * runs and what one tick is allowed to touch.
 *
 *   - `providerRefreshMinutes = 0` (or a disposed publisher at arm time)
 *     schedules NOTHING — the panel-only shape of the plugin is untouched;
 *   - a tick with the effective provider switch OFF does no upstream read at
 *     all (no console probe, no aggregate): OFF is the opt-in default and the
 *     refresher must respect it every tick, not just at arm time;
 *   - a tick with the switch ON drives the real aggregate (quota flip →
 *     publisher.publish + catalogStore.setUnavailable — the #1a persistence
 *     seen from the timer side);
 *   - close() clears the interval and any straggler callback is a no-op;
 *   - a throwing tick is REPORTED through the logger and the clock survives;
 *   - two overlapping callbacks run ONE aggregate (the `ticking` guard).
 *
 * Timers are faked by replacing setInterval/clearInterval on globalThis for
 * the duration of each case; the captured callback is invoked (and awaited via
 * setImmediate) by the test, so nothing here waits on wall-clock minutes.
 *
 * @module dsh-connect-sensenova-token-plan/test/provider-refresh
 */
import { armProviderRefresher } from "../src/host/provider-refresh.ts";
import { resolveSettings } from "../src/host/host-config.ts";
import { catalogSignature } from "../src/host/provider-publish.ts";
import { results, check, finishVerbose } from "./harness.mjs";
import { stubFetch } from "./fakes.mjs";


const EXHAUSTED_POOL = {
  plan: { id: "p1", name: "TokenPlan", type: "token_plan" },
  pools: [{
    id: "pool-1",
    model_ids: ["glm-5.2", "glm-4.6"],
    window_5h: { limit: "100", remaining: "0" },
    window_7d: { limit: "100", remaining: "50" }
  }]
};
const TREND_OK = { series: [], models: [] };

/**
 * A fake-timer sandbox: schedules recorded, callback captured, clears counted.
 * @returns {{install: () => void, uninstall: () => void, schedules: Array<{cb: Function, ms: number, id: number}>, cleared: number[], fireLast: () => Promise<void>}}
 */
function fakeTimers() {
  const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const schedules = [];
  const cleared = [];
  let nextId = 1;
  return {
    schedules,
    cleared,
    install() {
      globalThis.setInterval = (cb, ms) => {
        const id = nextId++;
        schedules.push({ cb, ms, id });
        return { id, unref: () => {} };
      };
      globalThis.clearInterval = (handle) => { cleared.push(handle?.id ?? handle); };
    },
    uninstall() {
      globalThis.setInterval = real.setInterval;
      globalThis.clearInterval = real.clearInterval;
    },
    async fire(scheduled) {
      const entry = scheduled ?? schedules[schedules.length - 1];
      entry.cb();
      // The callback starts `tick()` without awaiting it; drain the microtask
      // queue (and the one macrotask the fetch stub adds) before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}


/** The wiring bag the refresher reads — only the fields it actually touches. */
function makeWiring({ registerProvider = true, panelEnabled = null, storeThrows = false, gate = null } = {}) {
  const { settings } = resolveSettings({ registerProvider, providerRefreshMinutes: 15 });
  const published = [];
  const quotaWrites = [];
  const replaceCalls = [];
  const warnings = [];
  const publisherState = {
    entries: [], enabledIds: [], unavailableIds: [],
    signature: catalogSignature([], []), quotaSignature: "",
    llmAvailable: true, registered: false, error: null
  };
  return {
    published, quotaWrites, replaceCalls, warnings, publisherState,
    wiring: {
      settings,
      cache: new Map(),
      inflight: new Map(),
      tokenStore: {
        getToken: async () => "tok",
        invalidate: () => {},
        state: async () => ({ configured: true, ephemeral: false })
      },
      apiKeyStore: {
        // No key: only the quota half of the aggregate runs — which is the
        // half the timer exists to keep fresh when nobody is looking.
        resolve: async () => ({ value: "" }),
        state: async () => ({ hasApiKey: false, keySource: null, ephemeral: false })
      },
      publisher: {
        state: publisherState,
        isDisposed: () => false,
        publish: async (entries, enabledIds, unavailableModelIds) => {
          published.push({ entries, enabledIds, unavailableModelIds });
          publisherState.entries = Array.isArray(entries) ? entries : [];
          publisherState.enabledIds = Array.isArray(enabledIds) ? enabledIds : [];
          publisherState.unavailableIds = Array.isArray(unavailableModelIds) ? unavailableModelIds : [];
          return { ok: true };
        }
      },
      catalogStore: {
        listEnabledIds: async () => [],
        replace: async (entries, enabledIds, unavailableIds) => { replaceCalls.push({ entries, enabledIds, unavailableIds }); },
        setUnavailable: async (ids) => { quotaWrites.push(ids); }
      },
      providerStore: {
        enabled: storeThrows ? () => { throw new Error("store exploded"); } : async () => panelEnabled
      },
      logger: { warn: (m) => warnings.push(String(m)) }
    }
  };
}

// --- 1. the arm gates --------------------------------------------------------
{
  const timers = fakeTimers();
  timers.install();
  try {
    const { wiring } = makeWiring();
    check("minutes=0 arms NOTHING (the panel-only config shape is byte-identical)",
      armProviderRefresher(wiring, 0) === null && timers.schedules.length === 0,
      `schedules=${timers.schedules.length}`);
    check("a non-number minutes arms nothing either", armProviderRefresher(wiring, NaN) === null);
    const handle = armProviderRefresher(wiring, 15);
    check("minutes=15 schedules one 900000ms interval",
      handle !== null && timers.schedules.length === 1 && timers.schedules[0].ms === 900_000,
      JSON.stringify(timers.schedules.map((s) => s.ms)));
    const clamped = armProviderRefresher(wiring, 0.2);
    check("a sub-minute cadence floors to ONE minute, never to zero",
      clamped !== null && timers.schedules[1].ms === 60_000, JSON.stringify(timers.schedules.map((s) => s.ms)));
    clamped.close();
    handle.close();
    check("close() clears the interval", JSON.stringify(timers.cleared.sort()) === JSON.stringify([1, 2]),
      JSON.stringify(timers.cleared));
  } finally {
    timers.uninstall();
  }
}

// --- 2. the switch gate per tick --------------------------------------------
{
  const timers = fakeTimers();
  timers.install();
  const net = stubFetch({ "pool-usage": EXHAUSTED_POOL, "credit-usage-trend": TREND_OK });
  try {
    const off = makeWiring({ registerProvider: false });
    const h = armProviderRefresher(off.wiring, 15);
    await timers.fire();
    check("switch OFF (config default, untouched panel store): the tick does NO upstream read",
      net.asked.length === 0, JSON.stringify(net.asked));
    h.close();

    const on = makeWiring();
    const h2 = armProviderRefresher(on.wiring, 15);
    await timers.fire();
    check("switch ON: the tick drives the aggregate (quota read)",
      net.asked.some((u) => u.includes("pool-usage")), JSON.stringify(net.asked));
    check("the flip re-registers the provider",
      on.published.length === 1 && JSON.stringify(on.published[0].unavailableModelIds) === JSON.stringify(["glm-5.2", "glm-4.6"]),
      JSON.stringify(on.published[0]?.unavailableModelIds));
    check("the flip also PERSISTS (the restart seed reads this)",
      JSON.stringify(on.quotaWrites) === JSON.stringify([["glm-5.2", "glm-4.6"]]), JSON.stringify(on.quotaWrites));
    // A second tick with an identical reading must churn nothing.
    await timers.fire();
    check("a stable reading does not re-publish", on.published.length === 1, `published=${on.published.length}`);
    h2.close();

    const panelOff = makeWiring({ registerProvider: true, panelEnabled: false });
    const h3 = armProviderRefresher(panelOff.wiring, 15);
    const askedBefore = net.asked.length;
    await timers.fire();
    check("a panel-saved OFF beats the config ON, per tick",
      net.asked.length === askedBefore, JSON.stringify(net.asked.slice(askedBefore)));
    h3.close();
  } finally {
    net.restore();
    timers.uninstall();
  }
}

// --- 3. disposal, close, and the failure discipline --------------------------
{
  const timers = fakeTimers();
  timers.install();
  const net = stubFetch({ "pool-usage": EXHAUSTED_POOL, "credit-usage-trend": TREND_OK });
  try {
    const { wiring } = makeWiring();
    wiring.publisher.isDisposed = () => true;
    const h = armProviderRefresher(wiring, 15);
    await timers.fire();
    check("a disposed publisher makes the tick a no-op", net.asked.length === 0, JSON.stringify(net.asked));
    h.close();

    const closed = makeWiring();
    const h2 = armProviderRefresher(closed.wiring, 15);
    h2.close();
    await timers.fire();
    check("close() is race-proof: a fired straggler callback runs nothing",
      net.asked.length === 0 && closed.published.length === 0, JSON.stringify(net.asked));

    // A synchronously exploding store must reach `degrade` (the guard is
    // INSIDE the try) and must not escape as an unhandled rejection.
    const boom = makeWiring({ storeThrows: true });
    const h3 = armProviderRefresher(boom.wiring, 15);
    await timers.fire();
    check("a throwing tick is reported, not escaped",
      boom.warnings.some((w) => w.includes("provider-refresh")), JSON.stringify(boom.warnings));
    const warnedBefore = boom.warnings.length;
    await timers.fire();
    check("the clock survives a failed tick (the next one still runs and reports)",
      boom.warnings.length === warnedBefore + 1, JSON.stringify(boom.warnings.length));
    h3.close();
  } finally {
    net.restore();
    timers.uninstall();
  }
}

// --- 4. the overlap guard -----------------------------------------------------
{
  const timers = fakeTimers();
  timers.install();
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const net = stubFetch({ "pool-usage": EXHAUSTED_POOL, "credit-usage-trend": TREND_OK }, { hold });
  try {
    const { wiring, warnings: warns } = makeWiring();
    const h = armProviderRefresher(wiring, 15);
    timers.schedules[timers.schedules.length - 1].cb();
    timers.schedules[timers.schedules.length - 1].cb();
    await new Promise((resolve) => setImmediate(resolve));
    check("two overlapping callbacks start ONE aggregate (the ticking guard)",
      net.asked.filter((u) => u.includes("pool-usage")).length === 1, JSON.stringify(net.asked));
    release();
    // Drain until the held tick's finally has run (ticking reset). The full
    // aggregate chain is microtasks-only, but the bound keeps this honest if
    // an implementation ever adds a real timer inside a tick.
    let drained = false;
    for (let i = 0; i < 10 && !drained; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      drained = true; // observed by the NEXT fire below
    }
    const before = net.asked.length;
    // The held tick POPULATED the shared cache — a same-window tick hitting
    // it is the designed behaviour (and the panel's win). Empty it to observe
    // exactly one thing: that the ticking guard reset and the next tick RUNS.
    wiring.cache.clear();
    wiring.inflight.clear();
    await timers.fire();
    check("after the held tick settles, the guard resets and the next tick runs",
      net.asked.length > before, `asked=${JSON.stringify(net.asked.slice(before))} warnings=${JSON.stringify(warns)}`);
    h.close();
  } finally {
    net.restore();
    timers.uninstall();
  }
}

// --- report -------------------------------------------------------------------
finishVerbose({ suite: "provider-refresh.test.mjs" });

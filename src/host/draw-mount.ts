/**
 * The draw tool's mount logic — the opt-in `sensenova_draw_image` registration.
 *
 * Home of the draw half of the mount: {@link registerDrawTool} is the single
 * place that decides whether the agent gets the tool (ARCHITECTURE.md §5.4,
 * route B). The mount orchestrator (`lifecycle.ts`) calls it from
 * `startSideEffects` and re-exports it as the facade (ADR-013); a later switch
 * flip re-enters through {@link reconcileDrawTool}, which releases the held
 * registration before re-registering. The rest of
 * the draw family — tool definition (`draw.ts`), absence-note holder
 * (`draw-tool-state.ts`), panel switch store (`draw-store.ts`) — is the
 * neighbouring code this registration reads, so it lives here, not in the
 * lifecycle file.
 *
 * Peer-free discipline: the same rule as `lifecycle.ts` — no Host peer is
 * imported here; the tools module arrives lazily through the
 * `side.loadToolsModule` seam that `apply()` injects.
 *
 * @module dsh-connect-sensenova-token-plan/draw-mount
 */
import { defineDrawTool } from "./draw.ts";
import { resolveServiceWithRetry, degrade } from "./util.ts";
import { resetDrawToolNote, setDrawToolNote, setDrawToolMounted } from "./draw-tool-state.ts";
import { resolveSwitchEnabled } from "./switch-precedence.ts";
import type { Wiring } from "./types.ts";

/** The minimal fetch response `defineDrawTool`'s `fetchImpl` needs. */
export type DrawFetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

/**
 * The test seams `apply()` hands the draw family, named once.
 *
 * `startSideEffects` forwards this bag untouched to both
 * {@link registerDrawTool} and {@link reconcileDrawTool}, so spelling it here
 * is what keeps the two from drifting: a seam added for one of them is a type
 * error at the other until it is threaded through.
 */
export type DrawToolSide = {
  loadToolsModule: () => Promise<object>;
  drawFetch: (url: string, options: object) => Promise<DrawFetchResponse>;
};

/**
 * Per-wiring state for the in-session flip: one serial chain, one unload gate,
 * one "this registry cannot give the tool back" flag.
 *
 * Keyed by the `wiring` bag rather than held in module scope, because a
 * module-level chain would serialise two independent Hosts inside one process
 * (the test suites mount several) and a module-level `closed` flag would leak
 * one Host's shutdown into the next. `coalesced-fetch.ts` keys its generation
 * state the same way, for the same reason: the object that owns the state is
 * the identity, not the module.
 *
 * The chain is the concurrency fix. `reconcileDrawTool` reads the switch
 * INSIDE the queued step, so two flips that arrive while one pass is in flight
 * settle on the newest value instead of racing: without it, a slow ON pass can
 * finish after a fast OFF pass and leave the tool mounted with the switch
 * visibly off.
 */
type ReconcileState = {
  /** Serial queue: every pass runs after the previous one settles. */
  chain: Promise<void>;
  /** Set by {@link closeDrawTool}; a queued pass that has not started bails. */
  closed: boolean;
  /** The registry accepted the tool but returned no disposer (older peer). */
  sticky: boolean;
};

const RECONCILE_STATE = new WeakMap<object, ReconcileState>();

/** The (created-on-demand) flip state belonging to one wiring bag. */
function reconcileStateOf(wiring: object): ReconcileState {
  let state = RECONCILE_STATE.get(wiring);
  if (state === undefined) {
    state = { chain: Promise.resolve(), closed: false, sticky: false };
    RECONCILE_STATE.set(wiring, state);
  }
  return state;
}

/**
 * The wiring subset {@link registerDrawTool} reads — its own `Pick`, not the
 * whole bag.
 *
 * This function is exported so a test can mount the tool standalone, and
 * {@link DrawToolWiring} names exactly the fields it touches. Declaring the
 * subset as a type (rather than naming it in prose) is what lets the compiler
 * catch a field that stopped being read, or a new one that starts being read
 * without a declaration.
 *
 * No count is written here on purpose: this comment used to name a number of
 * fields, and it went stale the moment the set changed — the destructuring line
 * is not even a count of what the function reads, because `logger` is read
 * straight off the bag by the `degrade` call. The list in the type is the
 * contract; a number next to it is a second source with no compiler behind it.
 */
export type DrawToolWiring = Pick<Wiring,
  | "settings"
  | "configError"
  | "providerState"
  | "catalogStore"
  | "resolveApiKey"
  | "publisher"
  | "drawStore"
  | "drawRestore"
  | "logger"
>;

/**
 * Register the `sensenova_draw_image` agent tool (ARCHITECTURE.md §5.4,
 * route B). Opt-in (`drawEnabled`, default off) and doubly degraded — a Host
 * with no tools service never sees it, and a peer that fails to load leaves
 * the panel and the provider untouched. Named as a separate export so a test
 * can inject its own `ctx`/`wiring`; `startSideEffects` calls it when enabled.
 *
 * A successful registration stores the disposer `tools.register` returns in
 * the `drawRestore` slot, which is what makes the tool swappable: without it
 * an off→on flip would have to wait for the next Host start. Callers that want
 * to re-apply the switch use {@link reconcileDrawTool} rather than calling this
 * twice — a second registration of the same name is an error in the registry.
 * @param {{ get?: (n: string) => unknown; [key: string]: unknown }} ctx - the host root context (reads `ctx.get("tools")` / `ctx.tools`).
 * @param {DrawToolWiring} wiring - the fields listed in that type.
 * @param {object} side - test seams from `apply`'s `deps`.
 * @param {Function} side.loadToolsModule - lazy `@deepseek-ai/dsh-tools` loader.
 * @param {Function} side.drawFetch - draw request fetch (stubbed in tests).
 * @returns {Promise<void>}
 */
export async function registerDrawTool(ctx: { get?: (n: string) => unknown; [key: string]: unknown }, wiring: DrawToolWiring, side: DrawToolSide) {
  const { settings, configError, providerState, catalogStore, resolveApiKey, publisher, drawStore } = wiring;
  const { loadToolsModule, drawFetch } = side;
  // Recompute both panel bits on every attempt: a late tools service that
  // finally registers must CLEAR the stale "absent", and the mounted bit must
  // go false the moment this attempt starts deciding again — otherwise a
  // failed re-registration would leave "mounted" true over a tool that is gone.
  resetDrawToolNote();
  if (configError !== null) return;
  // The panel's saved switch beats the patch default — resolved by the one
  // adjudicator (`switch-precedence.ts`), not a hand-copied `?? settings.x`
  // dialect. A tool has no source to report (unlike the panel snapshot, which
  // tells the user WHICH side is in charge), so only the effective boolean is
  // taken here.
  const effectiveDrawEnabled = resolveSwitchEnabled(
    drawStore ? await drawStore.enabled().catch(() => null) : null,
    settings.drawEnabled
  );
  if (effectiveDrawEnabled !== true) return;
  // Same precedence as the switch: a panel-saved model preference beats the
  // patch's `drawModelId` (empty string = auto-pick from the catalog).
  const panelModelId = drawStore ? await drawStore.modelId().catch(() => null) : null;
  const effectiveSettings = panelModelId !== null ? { ...settings, drawModelId: panelModelId } : settings;
  // The tools service is optional and may register a moment AFTER this
  // plugin mounts; retry the READ, never the registration. Registering the
  // same name twice is what the registry refuses, so an in-session flip goes
  // through `reconcileDrawTool`: it releases the held disposer first, then
  // calls back in here.
  const tools = await resolveServiceWithRetry<{ register: (definition: unknown) => unknown }>(ctx, "tools", {
    isDisposed: () => publisher.isDisposed()
  });
  // The ONE normal absence the panel should state: the switch is on but this
  // Host exposes no tools service, so nothing is broken and no log line is due
  // — the copy (`draw.noTools`) is. The two bails below are Host bugs, so they
  // log (`degrade`) AND state their own reason on the panel.
  if (tools === null || typeof tools.register !== "function") {
    setDrawToolNote("no-tools-service");
    return;
  }
  let defineTool;
  try {
    const mod = await Promise.resolve(loadToolsModule());
    defineTool = (mod as { defineTool?: (definition: object) => unknown; default?: { defineTool?: (definition: object) => unknown } })?.defineTool
      ?? (mod as { default?: { defineTool?: (definition: object) => unknown } })?.default?.defineTool ?? null;
  } catch (error) {
    // No tools peer on this Host: the draw tool stays absent and the panel is
    // untouched — but not silent. Before `degrade` this catch was empty, so a
    // Host whose bundled peer could not be imported lost the tool with the
    // switch visibly on and no log line anywhere.
    setDrawToolNote("peer-load-failed");
    degrade("draw: tools peer module failed to load", error, wiring.logger, null);
    return;
  }
  if (typeof defineTool !== "function") {
    // A peer that loaded but shipped no `defineTool` factory is the same Host
    // bug as one that failed to load: the peer is not the version this plugin
    // expects.
    setDrawToolNote("peer-load-failed");
    return;
  }
  // Last gate before the registry is touched: the await chain above can be
  // long (panel store, peer module), and `teardown` may have closed this bag
  // while it was pending. Registering here would install a tool that outlives
  // the plugin, since nothing is left to hand it back.
  if (reconcileStateOf(wiring).closed) return;
  try {
    const dispose = tools.register(
      defineDrawTool({
        defineTool,
        resolveApiKey,
        // The draw's discovery set is the catalog, NOT the LLM offer: the
        // picker's allow-list is a filter on what the picker OFFERS, and
        // silently binding the agent's image tools to that curation would
        // drop a draw model from the tool's world the moment a user trimmed
        // the picker. The full persisted catalog is read at call time
        // (after mount an empty read is a no-op — `catalog-store.list()` is
        // cached in memory), so a catalog refresh lands without re-registering.
        getEntries: async () => {
          const live = Array.isArray(providerState.entries) && providerState.entries.length > 0
            ? providerState.entries
            : await catalogStore.list().catch(() => []);
          return Array.isArray(live) ? live : [];
        },
        settings: effectiveSettings,
        fetchImpl: drawFetch,
        isDisposed: () => publisher.isDisposed()
      })
    );
    const state = reconcileStateOf(wiring);
    if (typeof dispose === "function") {
      // Hold the disposer so a later switch flip can drop this tool.
      wiring.drawRestore.current = dispose as () => void;
      state.sticky = false;
      setDrawToolMounted(true);
    } else {
      // An older registry accepts the definition but hands back no disposer:
      // the tool WORKS and cannot be withdrawn. Two things follow, and both
      // are load-bearing. The panel must say so (`not-removable`) — the
      // alternative is a user switching off, reading "off", and still
      // getting a draw tool. And the `sticky` flag must stop the next flip
      // from registering a SECOND copy: a duplicate name is an error, so the
      // honest state is "mounted, not swappable", not a retry loop.
      wiring.drawRestore.current = null;
      state.sticky = true;
      // Mounted, just not withdrawable: the mounted bit is true and the reason
      // rides alongside it, which is exactly the pair the panel needs.
      setDrawToolMounted(true);
      setDrawToolNote("not-removable");
      degrade("draw: tools registry accepted the tool but returned no disposer — this Host cannot unmount it", null, wiring.logger, null);
    }
  } catch (error) {
    // A registry that refuses the tool degrades identically — tool absent,
    // panel fine — and is a Host problem, not a config one: say it, and state
    // the reason on the panel too.
    setDrawToolNote("registry-refused");
    degrade("draw: tools registry refused the registration", error, wiring.logger, null);
  }
}

/**
 * Re-apply the draw switch to the live registry: release the tool this plugin
 * holds (if any), then register it again against the current value.
 *
 * The draw counterpart of `reconcileWebSearch` (`web-search.ts`), and the
 * reason a panel flip no longer needs a Host restart. Three details are
 * load-bearing:
 *
 *   - **passes are serialised per wiring bag** ({@link reconcileStateOf}). The
 *     switch is read INSIDE the queued step, so a pass that was queued while
 *     an earlier one was still awaiting the store settles on the newest value.
 *     Without the queue the two passes interleave: the second one finds the
 *     slot already emptied by the first, decides there is nothing to release,
 *     and the first one then registers using the STALE value it read before
 *     the flip — leaving the tool mounted with the switch visibly off;
 *   - the slot is emptied BEFORE the disposer runs, so a re-entrant call reads
 *     "nothing held" rather than calling a disposer that is already spent;
 *   - a disposer that throws must not sink the re-registration — during
 *     shutdown the registry may already be gone, and the new registration is
 *     the caller's actual request.
 *
 * Nothing held is the ordinary case: an off→on flip has no tool to release, so
 * the slot is `null` and this degrades to a plain registration. A registry
 * that accepted the tool without a disposer is the one case that is NOT
 * reconciled: it holds the tool and cannot give it back, so a pass is a no-op
 * rather than a duplicate registration (see the `sticky` branch in
 * {@link registerDrawTool}).
 * @param {{ get?: (n: string) => unknown; [key: string]: unknown }} ctx - the host root context.
 * @param {DrawToolWiring} wiring - the same subset {@link registerDrawTool} reads.
 * @param {DrawToolSide} side - test seams from `apply`'s `deps`.
 * @returns {Promise<void>} resolves when THIS pass has run (queued behind any
 *   pass already in flight).
 */
export async function reconcileDrawTool(ctx: { get?: (n: string) => unknown; [key: string]: unknown }, wiring: DrawToolWiring, side: DrawToolSide) {
  const state = reconcileStateOf(wiring);
  const pass = async () => {
    if (state.closed) return;
    if (state.sticky) return;
    const held = wiring.drawRestore.current;
    wiring.drawRestore.current = null;
    if (held !== null) {
      try {
        held();
      } catch {
        // A frozen registry must not sink the reconcile.
      }
    }
    await registerDrawTool(ctx, wiring, side);
  };
  // The chain never carries a rejection forward: one failed pass must not stop
  // every later flip. `registerDrawTool` already absorbs the registry's own
  // refusals; what is left here is a genuine bug and it goes to the log.
  state.chain = state.chain.then(pass).catch((error) => {
    degrade("draw: reconcile pass failed", error, wiring.logger, null);
  });
  return state.chain;
}

/**
 * Close the flip machinery for one wiring bag: no queued or later pass may
 * register, and the tool this plugin holds is handed back now.
 *
 * Called by `teardown` instead of disposing `drawRestore.current` directly, so
 * that a pass already in flight cannot register into a Host that is letting
 * the plugin go — the `closed` gate is read at the top of every pass AND again
 * just before `tools.register`.
 * @param {object} wiring - the same bag `reconcileDrawTool` was given.
 * @returns {void}
 */
export function closeDrawTool(wiring: Pick<Wiring, "drawRestore">): void {
  const state = reconcileStateOf(wiring);
  state.closed = true;
  const held = wiring.drawRestore.current;
  wiring.drawRestore.current = null;
  if (held !== null) {
    try {
      held();
    } catch {
      // The registry may already be gone during shutdown.
    }
  }
  // The tool is gone as of now, and nothing else will recompute this bag: the
  // pass gate above stops every later pass. Leaving the bit true would have
  // the panel report a mounted tool on a Host that is shutting down.
  setDrawToolMounted(false);
}

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
import { resetDrawToolNote, setDrawToolNote } from "./draw-tool-state.ts";
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
  // Recompute the absence note on every attempt: a late tools service that
  // finally registers must CLEAR it, not leave a stale "absent" on the panel.
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
    // Hold the disposer so a later switch flip can drop this tool. A peer
    // whose `register` predates the return value hands back nothing: the tool
    // still works, it just cannot be swapped in-session, and keeping the slot
    // `null` states that honestly instead of arming a reconcile that would
    // throw.
    wiring.drawRestore.current = typeof dispose === "function" ? (dispose as () => void) : null;
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
 * reason a panel flip no longer needs a Host restart. Two details are
 * load-bearing:
 *
 *   - the slot is emptied BEFORE the disposer runs, so a re-entrant call (a
 *     second flip arriving while this one is in flight) reads "nothing held"
 *     rather than calling a disposer that is already spent;
 *   - a disposer that throws must not sink the re-registration — during
 *     shutdown the registry may already be gone, and the new registration is
 *     the caller's actual request.
 *
 * Nothing held is the ordinary case: an off→on flip has no tool to release, so
 * the slot is `null` and this degrades to a plain registration.
 * @param {{ get?: (n: string) => unknown; [key: string]: unknown }} ctx - the host root context.
 * @param {DrawToolWiring} wiring - the same subset {@link registerDrawTool} reads.
 * @param {DrawToolSide} side - test seams from `apply`'s `deps`.
 * @returns {Promise<void>}
 */
export async function reconcileDrawTool(ctx: { get?: (n: string) => unknown; [key: string]: unknown }, wiring: DrawToolWiring, side: DrawToolSide) {
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
}

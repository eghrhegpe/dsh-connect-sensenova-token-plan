/**
 * The `ctx.web` web-search mount (ROADMAP §6.1.7) — the commandcode-provider
 * precedent (`dsh-commandcode-provider`'s web-search module). DSH ships its
 * own `web_search` tool and a `WebSearchProvider` registry (`ctx.web`), so a
 * plugin registers a provider and lets DSH's model-facing tool call it — a
 * hand-registered agent tool would be a parallel, second search path.
 *
 * Opt-in (`webSearchEnabled`, default off) and doubly degraded (no `web`
 * service / no `registerSearchProvider` on it), exactly like the draw tool.
 * The provider interfaces are STRUCTURAL here (no `@deepseek-ai/dsh-web`
 * import), so the offline suite drives this with a fake `ctx` and a fake
 * runtime.
 *
 * Selection: DSH reads a private `searchProviderId` field per search call.
 * When a second provider is registered without being selected, every search
 * throws `WEB_PROVIDER_AMBIGUOUS` — the commandcode issue #26 lesson. So
 * enabling this plugin takes the selection over (Option B: only an EMPTY slot
 * or one we already own; a foreign provider's selection is refused and the
 * module goes absent) and `teardown` (lifecycle.ts) hands it back. The write is
 * a bounded dependency on the runtime shape, mirrored from commandcode.
 * The ORDER is load-bearing and inverted from the naive one: take the
 * selection over, VERIFY the field actually reads our id, and only THEN
 * register. A hardened/frozen runtime that swallows the write must degrade to
 * NEITHER registered NOR selected — "registered but unselected" was the old
 * claimed degradation, but with our provider registered and no selection held,
 * a previously unconfigured Host hits exactly the #26 ambiguity we cite as
 * the reason this takeover exists. Absence is the safe direction; a live
 * ambiguity is not degradation.
 *
 * Home: its own module — `lifecycle.ts` already owned the Token Plan mount
 * seed, the draw tool, the vision writer AND the raccoon seed, and a third
 * upstream's selection mechanics is the wrong neighbour for them.
 * `lifecycle.ts` re-exports every name below as the facade (ADR-013), so the
 * import surface (`from "./lifecycle.ts"`) is unchanged — the same zero-change
 * split precedent the raccoon publisher/store move used.
 *
 * `resolveServiceWithRetry` comes from `util.ts`, beside `retryBounded`
 * (ADR-013) — importing the helper from the facade that re-exports this module
 * would be a deliberate single cycle; `util.ts` removes it, and the shipped
 * bundle inlines all of them into `lib/index.js` anyway.
 *
 * @module dsh-connect-sensenova-token-plan/web-search
 */

import { resolveServiceWithRetry } from "./util.ts";
import { RaccoonSearchProvider, RACCOON_SEARCH_PROVIDER_ID } from "./raccoon-search.ts";
import { resolveSwitchEnabled } from "./switch-precedence.ts";
import { degrade } from "./util.ts";
import type { Wiring } from "./types.ts";

/** Structural view of the `ctx.web` runtime's search surface. */
export interface WebSearchRuntime {
  registerSearchProvider?: (provider: unknown) => void;
  searchProviderId: string | undefined;
}

/** Tracked search-selection state for one mounted `WebSearchRuntime`. */
export interface WebSearchSelection {
  /** Whether this plugin currently owns the selection. */
  owner: boolean;
  /** Whether the field already read our id when we took it over. */
  preexisting: boolean;
}

/** Fresh selection state: the plugin starts out not owning the selection. */
export function webSearchSelection(): WebSearchSelection {
  return { owner: false, preexisting: false };
}

/**
 * Reach one end of the web-search selection without trampling siblings.
 * Never throws: the caller's read-back judges the outcome, and a runtime that
 * swallowed the write simply ends up with nothing registered (see
 * {@link registerWebSearchProvider}) — "registered but unselected" is the live
 * ambiguity we cite as the reason this takeover exists, not a degradation.
 * Option B (P1 backlog): take over only an EMPTY slot or one we already own;
 * a FOREIGN provider's selection is refused, so the module goes ABSENT
 * (caller registers nothing) rather than displacing the sibling. The hand-back
 * therefore only ever CLEARS the empty slot we took over — there is no
 * displaced id to restore, which is why the selection state carries none.
 * @param {WebSearchRuntime} web - the `ctx.web` runtime.
 * @param {WebSearchSelection} state - the tracked selection.
 * @param {boolean} enable - take the selection over, or hand it back.
 */
export function applyWebSearchSelection(web: WebSearchRuntime, state: WebSearchSelection, enable: boolean): void {
  try {
    if (enable) {
      if (state.owner) {
        // Still on across a re-apply: re-assert the pin we already hold.
        web.searchProviderId = RACCOON_SEARCH_PROVIDER_ID;
        return;
      }
      const prior = web.searchProviderId;
      state.preexisting = prior === RACCOON_SEARCH_PROVIDER_ID;
      // Option B (P1 backlog "接管前检查占用、冲突则拒绝"): take over ONLY an
      // empty slot or a selection we already own. A FOREIGN provider occupying
      // the global is refused — we never displace a sibling's working
      // selection. The caller's read-back below then judges the selection as
      // not ours, so this whole module stays absent (no registration, no
      // restore) rather than stomping the global `searchProviderId`.
      if (!state.preexisting && prior !== undefined) return; // foreign-owned: refuse
      web.searchProviderId = RACCOON_SEARCH_PROVIDER_ID;
      state.owner = true;
      return;
    }
    if (state.owner) {
      state.owner = false;
      // Option B only ever took over an EMPTY slot (or one we already owned,
      // guarded by `preexisting`), so the hand-back clears the slot instead of
      // restoring a displaced sibling's id — there is none to restore.
      if (!state.preexisting) web.searchProviderId = undefined;
      state.preexisting = false;
    }
  } catch {
    // Hardened/frozen runtime: stay registered-but-unselected.
  }
}

/** The wiring subset {@link registerWebSearchProvider} reads and writes — its
 *  own `Pick`. `webSearchRestore` is in the `Pick` because this function
 *  ARMS it (`current = …`), not only because it reads it: a `Pick` that
 *  listed only what it consumed would be a lie about the mutation. */
export type WebSearchToolWiring = Pick<Wiring,
  | "settings"
  | "configError"
  | "publisher"
  | "resolveRaccoonToken"
  | "webSearchStore"
  | "webSearchRestore"
  | "logger"
>;

/**
 * Register the Raccoon `web_search` provider in `ctx.web` and take the
 * selection over when the switch is on. Off → the provider is never registered
 * and the selection is never touched; a late `web` service that finally
 * registers is picked up by {@link resolveServiceWithRetry}, never by a
 * duplicate registration. Option B: the take-over only proceeds when the
 * global slot is EMPTY or already ours — a foreign provider's selection is
 * refused, so the module goes ABSENT (nothing registered) rather than
 * displacing a sibling.
 * @param {{ get?: (n: string) => unknown; [key: string]: unknown }} ctx - the host root context (reads `ctx.get("web")`).
 * @param {WebSearchToolWiring} wiring - the fields listed in that type.
 * @returns {Promise<void>}
 */
export async function registerWebSearchProvider(ctx: { get?: (n: string) => unknown; [key: string]: unknown }, wiring: WebSearchToolWiring) {
  const { settings, configError, publisher, resolveRaccoonToken, webSearchStore } = wiring;
  if (configError !== null) return;
  const effective = resolveSwitchEnabled(
    webSearchStore ? await webSearchStore.enabled().catch(() => null) : null,
    settings.webSearchEnabled
  );
  if (effective !== true) return;
  const web = await resolveServiceWithRetry<WebSearchRuntime>(ctx, "web", {
    isDisposed: () => publisher.isDisposed()
  });
  if (web === null || typeof web.registerSearchProvider !== "function") return;
  const selection = webSearchSelection();
  // Take the selection over FIRST, then prove we hold it before registering
  // anything (see the module note: a registered-but-unselected provider is the
  // #26 ambiguity, not a degradation). `applyWebSearchSelection` never throws;
  // a frozen runtime leaves the read-back as the judge.
  applyWebSearchSelection(web, selection, true);
  if (web.searchProviderId !== RACCOON_SEARCH_PROVIDER_ID) {
    // The write did not land (or was refused): hand back whatever we took over
    // (a no-op when nothing was owned) — idempotent, and a failed hand-back is
    // equally swallowed — register NOTHING, and put the silent bail on voice
    // (PITFALLS §29/§37: a bail with no log line is how "the switch is on but
    // search never moved" becomes unanswerable).
    applyWebSearchSelection(web, selection, false);
    degrade("web-search: the runtime would not accept the search-provider selection; registering no provider (the switch stays visibly on, search keeps its current backend)", null, wiring.logger, null);
    return;
  }
  web.registerSearchProvider(new RaccoonSearchProvider({ resolveToken: resolveRaccoonToken }));
  // `startSideEffects` runs this as the `"web-search"` mount effect (ADR-008):
  // it is tracked, not awaited, so the `await` above can still be pending when
  // the host disposes the plugin — and `teardown` reads `webSearchRestore.current`
  // BEFORE the line below arms it, so it hands back nothing. If we are already
  // gone here, hand the selection straight back instead of arming an
  // unreachable teardown closure, or the global `searchProviderId` stays
  // hijacked by Raccoon after the plugin exits (ARCHITECTURE §5's "raccoon's
  // effect on the main registration is zero" violated).
  // `applyWebSearchSelection(…, false)` is idempotent, so the normal teardown
  // path below is untouched.
  if (publisher.isDisposed()) {
    applyWebSearchSelection(web, selection, false);
    return;
  }
  // Hand the selection back on teardown (idempotent: the second call sees
  // `owner === false` and does nothing). A fresh boot re-applies it.
  wiring.webSearchRestore.current = () => applyWebSearchSelection(web, selection, false);
}

/**
 * Reconcile the web-search registration to the CURRENT effective value.
 *
 * The registration is read-once at mount (`registerWebSearchProvider` above);
 * the draw tool has the same shape and lives with it, because the tools
 * registry has no unregister. Here the selection DOES have a restore, so an
 * in-session flip is safe: drop whatever this plugin had taken over, then
 * re-register against the new value. Called both at mount (in place of the
 * bare `registerWebSearchProvider`) and from the panel's `webSearch` route.
 * @param {{ get?: (n: string) => unknown; [key: string]: unknown }} ctx - the host root context.
 * @param {WebSearchToolWiring} wiring - see {@link registerWebSearchProvider}.
 * @returns {Promise<void>}
 */
export async function reconcileWebSearch(ctx: { get?: (n: string) => unknown; [key: string]: unknown }, wiring: WebSearchToolWiring) {
  // Empty the slot BEFORE re-arming, keeping the old closure in a local. Not
  // a bug fix — the `delete` this replaces was correct: pass 1 deleted the
  // field and `registerWebSearchProvider` re-armed it, so pass 2 read the new
  // closure, not `undefined`. The reason to change it is that the state is now
  // a slot (see `Wiring`), and "is a takeover held?" reads off the slot rather
  // than off whether a property happens to be present on the object. The
  // hand-back stays unconditional-when-armed either way: a flip to OFF leaves
  // the slot `null` because `register` bails before re-arming.
  const held = wiring.webSearchRestore.current;
  wiring.webSearchRestore.current = null;
  if (held !== null) {
    try { held(); } catch { /* a frozen runtime must not sink the reconcile */ }
  }
  await registerWebSearchProvider(ctx, wiring);
}

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
 * enabling this plugin takes the selection over (remembering whatever it
 * displaced) and `teardown` (lifecycle.ts) hands it back. The write is a
 * bounded dependency on the runtime shape, mirrored from commandcode; a
 * hardened runtime degrades to registered-but-unselected.
 *
 * Home: this section lived inside `lifecycle.ts`, which already owned the
 * Token Plan mount seed, the draw tool, the vision writer AND the raccoon
 * seed — a third upstream concern in a mount-lifecycle file. It moved out
 * on 2026-10-05; `lifecycle.ts` re-exports every name below as the facade,
 * so the import surface (`from "./lifecycle.ts"`) is unchanged — the same
 * zero-change split precedent the raccoon publisher/store move used.
 *
 * The `resolveServiceWithRetry` import from `lifecycle.ts` is a deliberate
 * single cycle (lifecycle re-exports this module as the facade, this module
 * imports one helper back): it is used only inside function bodies, so the
 * partial module graph at evaluation time never dereferences it — and the
 * shipped bundle inlines both files into `lib/index.js` anyway.
 *
 * @module dsh-connect-sensenova-token-plan/web-search
 */

import { resolveServiceWithRetry } from "./lifecycle.ts";
import { RaccoonSearchProvider, RACCOON_SEARCH_PROVIDER_ID } from "./raccoon-search.ts";
import { resolveSwitchEnabled } from "./switch-precedence.ts";
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
  /** The backend it displaced; `undefined` means "nothing was configured". */
  displaced: string | undefined;
  /** Whether the field already read our id when we took it over. */
  preexisting: boolean;
}

/** Fresh selection state: the plugin starts out not owning the selection. */
export function webSearchSelection(): WebSearchSelection {
  return { owner: false, displaced: undefined, preexisting: false };
}

/**
 * Reach one end of the web-search selection without trampling siblings.
 * Never throws: a hardened runtime shape degrades to registered-but-unselected.
 * @param {WebSearchRuntime} web - the `ctx.web` runtime.
 * @param {WebSearchSelection} state - the tracked selection.
 * @param {boolean} enable - take the selection over, or hand it back.
 */
export function applyWebSearchSelection(web: WebSearchRuntime, state: WebSearchSelection, enable: boolean): void {
  try {
    if (enable) {
      if (state.owner) {
        // Still on across a re-apply: re-assert without forgetting whom we displaced.
        web.searchProviderId = RACCOON_SEARCH_PROVIDER_ID;
        return;
      }
      const prior = web.searchProviderId;
      state.preexisting = prior === RACCOON_SEARCH_PROVIDER_ID;
      state.displaced = state.preexisting ? undefined : prior;
      web.searchProviderId = RACCOON_SEARCH_PROVIDER_ID;
      state.owner = true;
      return;
    }
    if (state.owner) {
      state.owner = false;
      if (!state.preexisting) web.searchProviderId = state.displaced;
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
 * duplicate registration.
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
  web.registerSearchProvider(new RaccoonSearchProvider({ resolveToken: resolveRaccoonToken }));
  applyWebSearchSelection(web, selection, true);
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

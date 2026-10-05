/**
 * The plugin's side effects — the parts of mounting that are not route
 * handlers.
 *
 * `apply()` is the single mount seam: it assembles the `wiring` object, calls
 * {@link registerRoutes} (routes.ts), then {@link startSideEffects} for:
 *
 *   - the mount seed (`seedPublisherFromCatalog`): offer models before the
 *     first poll, fire-and-forget;
 *   - the draw tool registration (opt-in `drawEnabled`, doubly degraded);
 *   - vision step two: the settings-row writer filled for the snapshot route.
 *
 * and {@link teardown} for the unmount order that PITFALLS §18 pins: dispose
 * both publishers, release both pairs, then run the route `off` callbacks —
 * the Raccoon publisher is disposed in the order it registered, so a late
 * publish cannot register into a withdrawing Host. It must NOT be simplified.
 *
 * Peer-free discipline: no Host peer is imported here. The only lazy peer
 * loads (the adapter / tools modules) are injected from `apply` via `deps`.
 *
 * @module dsh-connect-sensenova-token-plan/lifecycle
 */
import { defineDrawTool } from "./draw.ts";
import { seedPublisherFromCatalog, catalogSignature } from "./provider-publish.ts";
import { retryBounded, errMsg, degrade } from "./util.ts";
import { resetDrawToolNote, setDrawToolNote } from "./draw-tool-state.ts";
import { name } from "./host-config.ts";
import { RACCOON_FALLBACK_MODELS, fetchRaccoonCatalog } from "./raccoon.ts";
import { filterRaccoonRows } from "./raccoon-models.ts";
import { resolveSwitchEnabled } from "./switch-precedence.ts";
import { RaccoonSearchProvider, RACCOON_SEARCH_PROVIDER_ID } from "./raccoon-search.ts";
import type { Wiring } from "./types.ts";

/** How many times a mount-time optional-service read is retried. */
const SERVICE_RETRY_ATTEMPTS = 3;
/** Base backoff between service-read attempts (× attempt index). */
const SERVICE_RETRY_DELAY_MS = 300;

/**
 * Read an optional Host service with a bounded retry.
 *
 * A service may register AFTER this plugin mounts — the note on vision step
 * two below said so — and a mount-time read is the only window for a
 * capability the Host cannot later remove: the tools registry has no
 * unregister call, and the settings row is only written by a poll that finds
 * `visionPublish.current` already filled. A one-shot read therefore misses a
 * service that arrives a moment late for the WHOLE session, silently — the
 * draw tool would be absent with the switch visibly on, the vision list never
 * written, and no line on any panel naming the reason. The Raccoon publisher
 * got the same bounded retry for its mount seed.
 *
 * This retries the READ ONLY. Whatever it returns is used exactly once by the
 * caller: retrying a call that mutates (a tool registration) would register
 * the same tool twice, and the tools registry cannot tell.
 *
 * The loop itself is the shared `retryBounded` (`util.ts`) — the same backoff
 * shape the Raccoon mount seed uses; only the window length is set here.
 * @template T - the shape of the service being waited for. The reader knows
 *   what it wants (`{ register }` for tools, `{ update }` for settings); this
 *   function only knows a name, so the shape is declared at the call site and
 *   the `as T` below is the single place that claim is trusted. Defaulting to
 *   `unknown` means a caller that forgets the parameter gets a type it cannot
 *   accidentally dereference — which is the failure the old `Promise<any>`
 *   invited on every one of its seven property reads.
 * @param {object} ctx - the host root context.
 * @param {string} service - the service name for `ctx.get`.
 * @param {object} [options]
 * @param {() => boolean} [options.isDisposed] - stop early when the plugin is
 *   withdrawing; a late registration into a withdrawing Host is worse than
 *   absence.
 * @param {number} [options.attempts] - test seam for the attempt count.
 * @param {number} [options.delayMs] - test seam for the backoff base.
 * @returns {Promise<T|null>} the service, or `null` when it never appeared
 *   inside the window.
 */
export async function resolveServiceWithRetry<T = unknown>(
  ctx: { get?: (n: string) => unknown; [key: string]: unknown },
  service: string,
  // Typed explicitly rather than left to inference, and NOT via JSDoc: a
  // parameter with a default initializer is typed from that initializer (`{}`),
  // and in a `.ts` file `@param` / `@type` are comments, not type sources — so
  // the destructuring below would read three properties off `{}` (TS2339).
  options: { isDisposed?: () => boolean; attempts?: number; delayMs?: number } = {}
): Promise<T | null> {
  const {
    isDisposed = () => false,
    attempts = SERVICE_RETRY_ATTEMPTS,
    delayMs = SERVICE_RETRY_DELAY_MS
  } = options;
  // Annotated `T | null` rather than inferred from the `null` initializer,
  // which under strictNullChecks would pin the type to `null` and make every
  // assignment below — and every `tools.register` / `settings.update` at the
  // call sites — read as `never`.
  let found: T | null = null;
  await retryBounded({
    attempts,
    delayMs,
    run: () => {
      if (isDisposed()) return true;
      try {
        const value = ctx.get?.(service) ?? ctx[service] ?? null;
        if (value !== null && value !== undefined) {
          // The one trusted claim in this module: `ctx.get` hands back
          // `unknown` because the Host is dynamically typed, so the shape is
          // whatever the caller's `T` says it is. Both call sites below keep
          // their own `typeof x.method !== "function"` guard, which is what
          // makes the wrong `T` a degraded path rather than a crash.
          found = value as T;
          return true;
        }
      } catch {
        // A resolver that refuses a read is treated like an absent service.
      }
      return false;
    }
  });
  return found;
}

/** The minimal fetch response `defineDrawTool`'s `fetchImpl` needs. */
type DrawFetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
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
 * No count is written here on purpose: this comment used to say "eight of the
 * twenty-two" while the `@param` below said "the seven fields read below", and
 * both were stale — `Wiring` had twenty fields, and there are eight here of
 * which only seven are destructured (`logger` is read straight off the bag by
 * the `degrade` call, so a count of the destructuring line is not a count of
 * what the function reads). The list in the type is the contract; a number next
 * to it is a second source with no compiler behind it.
 */
export type DrawToolWiring = Pick<Wiring,
  | "settings"
  | "configError"
  | "providerState"
  | "catalogStore"
  | "resolveApiKey"
  | "publisher"
  | "drawStore"
  | "logger"
>;

/**
 * Register the `sensenova_draw_image` agent tool (ARCHITECTURE.md §5.4,
 * route B). Opt-in (`drawEnabled`, default off) and doubly degraded — a Host
 * with no tools service never sees it, and a peer that fails to load leaves
 * the panel and the provider untouched. Named as a separate export so a test
 * can inject its own `ctx`/`wiring`; `startSideEffects` calls it when enabled.
 * @param ctx - the host root context (reads `ctx.get("tools")` / `ctx.tools`).
 * @param {DrawToolWiring} wiring - the fields listed in that type.
 * @param {object} side - test seams from `apply`'s `deps`.
 * @param {Function} side.loadToolsModule - lazy `@deepseek-ai/dsh-tools` loader.
 * @param {Function} side.drawFetch - draw request fetch (stubbed in tests).
 * @returns {Promise<void>}
 */
export async function registerDrawTool(ctx: { get?: (n: string) => unknown; [key: string]: unknown }, wiring: DrawToolWiring, side: { loadToolsModule: () => Promise<object>; drawFetch: (url: string, options: object) => Promise<DrawFetchResponse> }) {
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
  // plugin mounts; retry the read, never the registration — a tool cannot be
  // unregistered, so registering it twice would be a worse failure than
  // missing it.
  const tools = await resolveServiceWithRetry<{ register: (definition: unknown) => void }>(ctx, "tools", {
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
    tools.register(
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
  } catch (error) {
    // A registry that refuses the tool degrades identically — tool absent,
    // panel fine — and is a Host problem, not a config one: say it, and state
    // the reason on the panel too.
    setDrawToolNote("registry-refused");
    degrade("draw: tools registry refused the registration", error, wiring.logger, null);
  }
}


/**
 * The Raccoon mount seed (ROADMAP §6.1 second upstream) — the fire-and-forget
 * boot of the Raccoon half, exported on its own so the
 * orchestrator in `index.ts` stays a thin assembly: the seed is a side effect
 * (it touches the credential store, the switch, the gateway, and the
 * publisher), not part of "what a route may touch", so it belongs with the
 * other mount side effects here.
 *
 * Fire-and-forget: the caller `void`s the returned promise. If the switch is
 * already on and a credential was stored before this restart, this offers the
 * Raccoon models before the first poll (and with no console login at all).
 * The roster is rebuilt from the store, NOT from `raccoonPublisher.state.rows`
 * — that field is in-memory only and empty on a fresh process, so gating on
 * it meant a restarted Host never re-registered the provider (the panel said
 * "logged in" and the tab listed models, but the picker saw none). With NO
 * credential there is nothing to offer, so the publisher stays pristine and
 * the tab keeps its "switch on — scan to log in" state.
 * @param {object} wiring - the Raccoon half of the mount wiring.
 * @param {object} wiring.raccoonStore - the Raccoon credential store.
 * @param {object} wiring.raccoonSwitch - the Raccoon switch store.
 * @param {object} wiring.raccoonPublisher - the Raccoon publisher.
 * @returns {Promise<void>} the fire-and-forget seed.
 */
export function seedRaccoonOnMount({ raccoonStore, raccoonSwitch, raccoonPublisher }: {
  raccoonStore: {
    resolve(): Promise<{ credential: { accessToken?: unknown; officeIdentity?: unknown } | null }>;
    isExpired(): Promise<boolean>;
    refresh(): Promise<unknown>;
  };
  raccoonSwitch: { enabled(): Promise<boolean | null>; enabledIds(): Promise<string[] | null> };
  raccoonPublisher: {
    isDisposed(): boolean;
    publish(rows: unknown, officeIdentity: unknown): Promise<unknown>;
    state: { registered: boolean };
  };
}) {
  // The bounded retry window, via the shared `retryBounded` loop. The two
  // "late to mount" failures this guards against are the credentials service
  // registering AFTER this plugin, and the `llm` registration service
  // appearing late — neither surfaces a reason anywhere, so a single-pass
  // seed left the picker empty for the whole session while the tab said
  // "logged in". Every attempt re-reads BOTH, and the loop stops when
  // `state.registered` flips.
  //
  // Six attempts, where the service-read window in this file uses three: a
  // seed pass has to wait for two separate services and then fetch the
  // catalogue, so it needs the longer budget. The extra time is only spent
  // when something really is late — an early success returns at once.
  const seedAttempts = 6;
  const seedDelayMs = 300;
  return (async () => {
    try {
      await retryBounded({
        attempts: seedAttempts,
        delayMs: seedDelayMs,
        run: async () => {
          if (raccoonPublisher.isDisposed()) return true;
          const switchState = await raccoonSwitch.enabled().catch(() => null);
          // Opt-in default OFF: a deployment that never touched the tab stays
          // pristine. Re-checked each attempt so a concurrent panel flip to OFF
          // is honoured instead of being raced.
          if (switchState !== true) return true;
          const { credential } = await raccoonStore.resolve().catch(() => ({ credential: null }));
          // No credential yet — most likely the credentials service has not
          // registered at this point in the mount. Keep trying inside the
          // window rather than giving up on the first read.
          if (!credential?.accessToken) return false;
          // Keep the credential inside its expiry window before the catalogue
          // call — the same eager refresh the request path uses.
          if (await raccoonStore.isExpired().catch(() => false)) {
            await raccoonStore.refresh().catch(() => {});
          }
          const { credential: live } = await raccoonStore.resolve().catch(() => ({ credential: null }));
          // A mutable COPY rather than an `as any[]` cast over the frozen
          // table. The seed only ever REBINDS `rows` (it never pushes), so a
          // fresh array is behaviourally identical — and it stops the frozen
          // fallback from being shared with a value the publisher may hold on
          // to. The element type stays `unknown` deliberately:
          // `filterRaccoonRows` accepts `unknown` and `fetchRaccoonCatalog`
          // returns an unannotated value, so the old `any[]` was buying no
          // safety at all — only the implicit widening that silenced the
          // readonly-vs-mutable error.
          let rows: unknown[] = [...RACCOON_FALLBACK_MODELS];
          if (live?.accessToken) {
            const catalog = await fetchRaccoonCatalog(live).catch(() => null);
            if (catalog !== null && catalog.length > 0) rows = catalog;
          }
          // The seed honours the panel's pushed-model curation too: a restart
          // must not widen the offer back to the whole roster behind the tab's
          // back (the switch/login/models handlers all publish filtered).
          const curated = await raccoonSwitch.enabledIds().catch(() => null);
          await raccoonPublisher.publish(filterRaccoonRows(rows, curated), live?.officeIdentity ?? "").catch(() => {});
          if (raccoonPublisher.state.registered === true) return true;
          if (raccoonPublisher.isDisposed()) return true;
          // Still unregistered: the `llm` service may not be resolvable yet, or
          // a peer module is still loading. Back off and try the whole build
          // again (a fresh roster read is harmless — publish is idempotent). A
          // permanent failure fails fast after the bounded window and stays
          // visible on the tab.
          return false;
        }
      });
    } catch {
      // No seed: the first switch/login publishes.
    }
  })();
}

/**
 * Run the mount-time side effects: the persisted-catalog seed, the draw tool
 * (when opted in), and vision step two's settings-row writer.
 * @param ctx - the host root context.
 * @param {Wiring} wiring - assembled by `apply()`; the fields read here are
 *   `settings` / `visionPublish` / `logger` plus the whole {@link DrawToolWiring}
 *   it forwards to {@link registerDrawTool}. The per-field notes that used to
 *   sit here are what the {@link Wiring} declaration now says instead.
 * @param {object} side - test seams from `apply`'s `deps`
 *   (`loadToolsModule`, `drawFetch`).
 * @returns {void} — seed and draw are fire-and-forget.
 */
export function startSideEffects(ctx: { get?: (n: string) => unknown; [key: string]: unknown }, wiring: Wiring, side: { loadToolsModule: () => Promise<object>; drawFetch: (url: string, options: object) => Promise<DrawFetchResponse> }) {
  const { publisher, catalogStore, settings, visionPublish } = wiring;

  // Seed the registration from the persisted catalog so a restarted Host
  // offers models before its first poll (and with no console login at all).
  // Fire-and-forget: a state dir that cannot be read just waits for the poll.
  void seedPublisherFromCatalog(
    publisher,
    () => catalogStore.list(),
    () => catalogStore.listEnabledIds(),
    catalogSignature
  );

  // Draw absorption: opt-in, doubly degraded (no tools service / no peer).
  // The effective value is panel-saved > config default (`draw-store.ts`),
  // read at mount time — and when it is already on, the tool is registered
  // RIGHT HERE during this mount (see `registerDrawTool`, which awaits the
  // panel value and calls `tools.register`). The tools registry has no
  // unregister call, so an off→on flip needs the next Host start; an on→off
  // flip just means this mount did not register it (the already-registered
  // tool lives until the Host restarts).
  void registerDrawTool(ctx, wiring, side);

  // Web-search absorption (ROADMAP §6.1.7): opt-in, doubly degraded, and the
  // selection is taken over only when the switch is on. Fire-and-forget, like
  // the draw tool — and the restore is remembered on `wiring` so `teardown`
  // hands the selection back to whichever backend it displaced. `reconcile`
  // rather than the bare register, so the panel's in-session flip can drop
  // and re-apply the same way this mount does.
  void reconcileWebSearch(ctx, wiring);

  // ------------------------------------------------------------------
  // Vision step two (ARCHITECTURE.md §5.1): publish which of this key's
  // models take image input into THIS row's own settings namespace, for
  // a later LLM connect plugin (dsh-provider-sensenova, etc.) to read.
  //
  // The write goes to this plugin's settings row ONLY - never another
  // provider's `imageModelIds` - so a miscalculated model list can only
  // affect the panel, not DSH's model routing. It is opt-in
  // (`writeImageModelIds`), off by default, and idempotent: a no-change
  // pass costs one revision read and no write.
  //
  // `visionPublish.current` is filled in here from `ctx.get("settings")`
  // (the resolver-not-snapshot pattern: the service may register after this
  // plugin mounts, so the read retries a bounded number of times before the
  // plugin gives up); a Host without one leaves it null and the publish
  // simply never runs. Wrapped in a fire-and-forget IIFE so a settings
  // service that arrives a moment later is still picked up before the next
  // poll — the write itself is idempotent per poll, so a late fill costs
  // nothing.
  // ------------------------------------------------------------------
  void (async () => {
    try {
      const settingsService = await resolveServiceWithRetry<{
        update: (ns: string, value: unknown, revision?: unknown) => Promise<unknown>;
        describe?: (options: { redactSecrets: boolean }) => unknown;
      }>(ctx, "settings", {
        isDisposed: () => publisher.isDisposed()
      });
      if (settingsService === null || typeof settingsService.update !== "function") return;
      // Named return type, because `describe` is typed `unknown`: the row this
      // finds carries a `revision` that `update` must hand back, and an
      // inferred `unknown | null` would push a cast onto every read below.
      const descriptorOf = (): { ns?: unknown; revision?: unknown } | null => {
        try {
          const view = settingsService.describe?.({ redactSecrets: true }) as
            | unknown[]
            | { entries?: unknown[] }
            | undefined;
          const rows = Array.isArray(view) ? view : view?.entries ?? [];
          const hit = rows.find((candidate) =>
            (candidate as { ns?: unknown } | null | undefined)?.ns === name);
          return (hit as { ns?: unknown; revision?: unknown } | undefined) ?? null;
        } catch {
          return null;
        }
      };
      let publishing = false;
      let lastPublishedIds = settings.imageModelIds.slice();
      visionPublish.current = async (visionEntries: unknown, ids: string[]) => {
        if (settings.writeImageModelIds !== true) return;
        if (publishing) return;
        if (JSON.stringify(lastPublishedIds) === JSON.stringify(ids)) return;
        const descriptor = descriptorOf();
        if (descriptor === null) return;
        publishing = true;
        try {
          await settingsService.update(name, {
            imageModelIds: ids,
            visionModels: visionEntries
          }, descriptor.revision);
          lastPublishedIds = ids.slice();
        } catch (error) {
          wiring.logger?.warn?.(`${name}: vision publish refused: ${errMsg(error)}`);
        } finally {
          publishing = false;
        }
      };
    } catch {
      // A settings service that never appears, or a resolver that throws on
      // every attempt: `visionPublish.current` stays null and the poll never
      // writes, exactly as a Host without the service.
    }
  })();
}

/**
 * Unmount, in the order PITFALLS §18 pins:
 *
 *   1. `dispose` — a publish still in flight (the mount seed's, or a poll's)
 *      must not register into a Host that is letting this plugin go;
 *   2. `release` — stop offering the provider first, so a request cannot be
 *      routed to an adapter whose Host services are already half gone;
 *   3. the route `off()` callbacks, each guarded (the web server may already
 *      be gone during shutdown).
 *
 * This order is a concurrency fix and must NOT be simplified.
 * @param {Wiring} wiring - assembled by `apply()`; only the publisher pair
 *   and the release are read, so the type says exactly three fields.
 * @param {Array<() => void>} offs - the unregister callbacks from
 *   {@link registerRoutes}. `Function[]` was the old spelling and it is
 *   `any[]` in disguise — a `Function` may be called with any arguments and
 *   return anything, so it pinned neither the shape nor the arity.
 * @returns {void}
 */
/**
 * The `ctx.web` web-search mount (ROADMAP §6.1.7) — the commandcode-provider
 * precedent (`dsh-commandcode-provider`'s web-search module). DSH ships its own
 * `web_search` tool and a `WebSearchProvider` registry (`ctx.web`), so a plugin
 * registers a provider and lets DSH's model-facing tool call it — a
 * hand-registered agent tool would be a parallel, second search path.
 *
 * Opt-in (`webSearchEnabled`, default off) and doubly degraded (no `web`
 * service / no `registerSearchProvider` on it), exactly like the draw tool. The
 * provider interfaces are STRUCTURAL here (no `@deepseek-ai/dsh-web` import), so
 * the offline suite drives this with a fake `ctx` and a fake runtime.
 *
 * Selection: DSH reads a private `searchProviderId` field per search call. When
 * a second provider is registered without being selected, every search throws
 * `WEB_PROVIDER_AMBIGUOUS` — the commandcode issue #26 lesson. So enabling this
 * plugin takes the selection over (remembering whatever it displaced) and
 * `teardown` hands it back. The write is a bounded dependency on the runtime
 * shape, mirrored from commandcode; a hardened runtime degrades to
 * registered-but-unselected.
 */

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
 * @param ctx - the host root context (reads `ctx.get("web")`).
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
 * @param ctx - the host root context.
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

export function teardown(wiring: Pick<Wiring, "publisher" | "releaseProvider" | "raccoonPublisher" | "webSearchRestore">, offs: Array<() => void>) {
  try {
    wiring.webSearchRestore.current?.();
  } catch {
    // The web runtime may already be gone during shutdown.
  }
  const { publisher, releaseProvider, raccoonPublisher } = wiring;
  // Before anything else: a publish still in flight (the mount seed's, or a
  // poll's) must not register into a Host that is letting this plugin go.
  publisher.dispose();
  // The Raccoon provider is a SECOND, independent registration (ROADMAP
  // §6.1): dispose it in the same order it registered, so a late raccoon
  // publish cannot register into the withdrawing Host either.
  raccoonPublisher?.dispose();
  raccoonPublisher?.release?.();
  // Stop offering the provider first, so a request cannot be routed to an
  // adapter whose Host services are already half gone.
  releaseProvider();
  for (const off of offs) {
    try {
      off();
    } catch {
      // The web server may already be gone during shutdown.
    }
  }
}
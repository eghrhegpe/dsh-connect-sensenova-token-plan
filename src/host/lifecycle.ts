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
import { name } from "./host-config.ts";
import { RACCOON_FALLBACK_MODELS, fetchRaccoonCatalog } from "./raccoon.ts";
import { filterRaccoonRows } from "./raccoon-models.ts";
import { resolveSwitchEnabled } from "./switch-precedence.ts";
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
 * This function is exported so a test can mount the tool standalone, and the
 * fields it actually touches are eight of the twenty-two. Declaring the
 * subset as a type (rather than naming it in prose) is what lets the compiler
 * catch a field that stopped being read, or a new one that starts being read
 * without a declaration.
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
 * @param {DrawToolWiring} wiring - the seven fields read below.
 * @param {object} side - test seams from `apply`'s `deps`.
 * @param {Function} side.loadToolsModule - lazy `@deepseek-ai/dsh-tools` loader.
 * @param {Function} side.drawFetch - draw request fetch (stubbed in tests).
 * @returns {Promise<void>}
 */
export async function registerDrawTool(ctx: { get?: (n: string) => unknown; [key: string]: unknown }, wiring: DrawToolWiring, side: { loadToolsModule: () => Promise<object>; drawFetch: (url: string, options: object) => Promise<DrawFetchResponse> }) {
  const { settings, configError, providerState, catalogStore, resolveApiKey, publisher, drawStore } = wiring;
  const { loadToolsModule, drawFetch } = side;
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
  if (tools === null || typeof tools.register !== "function") return;
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
    degrade("draw: tools peer module failed to load", error, wiring.logger, null);
    return;
  }
  if (typeof defineTool !== "function") return;
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
    // panel fine — and is a Host problem, not a config one: say it.
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
export function teardown(wiring: Pick<Wiring, "publisher" | "releaseProvider" | "raccoonPublisher">, offs: Array<() => void>) {
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
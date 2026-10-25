/**
 * The plugin's side effects — the parts of mounting that are not route
 * handlers.
 *
 * `apply()` is the single mount seam: it assembles the `wiring` object, calls
 * {@link registerRoutes} (routes.ts), then {@link startSideEffects} for:
 *
 *   - the mount seed (`seedPublisherFromCatalog`): offer models before the
 *     first poll, tracked in the effect registry (ADR-008);
 *   - the draw tool registration (opt-in `drawEnabled`, doubly degraded) —
 *     the registration itself lives in `draw-mount.ts`, re-exported below;
 *   - the Raccoon mount seed (`seedRaccoonOnMount`);
 *   - vision step two: the settings-row writer filled for the snapshot route;
 *   - the web-search mount and selection takeover (`web-search.ts`,
 *     re-exported below as the same facade).
 *
 * and {@link teardown} for the unmount order that PITFALLS §18 pins: dispose
 * both publishers, release both pairs, then run the route `off` callbacks —
 * the Raccoon publisher is disposed in the order it registered, so a late
 * publish cannot register into a withdrawing Host. It must NOT be simplified.
 *
 * What this file owns after {@link startSideEffects} is the mount itself: the
 * wiring fan-out (refresh arm, provider-reconcile seed) plus {@link teardown}
 * — the two directions that must stay sequenced together. The work each
 * effect *does* is its own neighbour-shaped module (`draw-mount.ts`,
 * `web-search.ts`); this file re-exports every name below as the facade
 * (ADR-013), so the import surface (`from "./lifecycle.ts"`) never changes.
 *
 * Peer-free discipline: no Host peer is imported here. The only lazy peer
 * loads (the adapter / tools modules) are injected from `apply` via `deps`.
 *
 * @module dsh-connect-sensenova-token-plan/lifecycle
 */
import { seedPublisherFromCatalog } from "./provider-publish.ts";
import { retryBounded, errMsg, resolveServiceWithRetry } from "./util.ts";
import { armProviderRefresher } from "./provider-refresh.ts";
import { closeDrawTool, reconcileDrawTool, type DrawToolSide } from "./draw-mount.ts";
import { name } from "./host-config.ts";
import { RACCOON_FALLBACK_MODELS, fetchRaccoonCatalog } from "./raccoon.ts";
import { filterRaccoonRows } from "./raccoon-models.ts";
import { type EffectRegistry } from "./effects.ts";
import type { Wiring } from "./types.ts";


/**
 * The Raccoon mount seed (ROADMAP §6.1 second upstream) — the boot
 * of the Raccoon half, exported on its own so the orchestrator in
 * `index.ts` stays a thin assembly: the seed is a side effect (it
 * touches the credential store, the switch, the gateway, and the
 * publisher), not part of "what a route may touch", so it belongs
 * with the other mount side effects here.
 * 
 * Tracked in the effect registry (ADR-008): starts without blocking
 * the mount, and the unmount drains it before `teardown`. If the
 * switch is already on and a credential was stored before this
 * restart, this offers the Raccoon models before the first poll
 * (and with no console login at all). The roster is rebuilt from the
 * store, NOT from `raccoonPublisher.state.rows` — that field is
 * in-memory only and empty on a fresh process, so gating on it meant
 * a restarted Host never re-registered the provider (the panel said
 * "logged in" and the tab listed models, but the picker saw none).
 * With NO credential there is nothing to offer, so the publisher
 * stays pristine and the tab keeps its "switch on — scan to log
 * in" state.
 * @param {object} wiring - the Raccoon half of the mount wiring.
 * @param {object} wiring.raccoonStore - the Raccoon credential store.
 * @param {object} wiring.raccoonSwitch - the Raccoon switch store.
 * @param {object} wiring.raccoonPublisher - the Raccoon publisher.
 * @returns {Promise<void>} the seed, tracked under `"raccoon-seed"` by the effect registry (ADR-008).
 */
export function seedRaccoonOnMount({ raccoonStore, raccoonSwitch, raccoonPublisher }: {
  raccoonStore: {
    resolve(): Promise<{ credential: { accessToken?: unknown; officeIdentity?: unknown } | null }>;
    prepareForRequest(): Promise<unknown>;
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
  // Six attempts, where the service-read window in `util.ts` uses three: a
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
          // call — the same pre-request ritual the request path uses.
          await raccoonStore.prepareForRequest();
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
 * @param {{ get?: (n: string) => unknown; [key: string]: unknown }} ctx - the host root context.
 * @param {Wiring} wiring - assembled by `apply()`; the fields read here are
 *   `publisher` / `catalogStore` / `settings` / `visionPublish` / `logger`,
 *   plus the whole bag it forwards to `registerDrawTool` (`draw-mount.ts`,
 *   which declares the subset it reads). The per-field notes that used to
 *   sit here are what the {@link Wiring} declaration now says instead.
 * @param {object} side - test seams from `apply`'s `deps`
 *   (`loadToolsModule`, `drawFetch`).
 * @param {EffectRegistry} effects - the mount-time effect registry (ADR-008):
 *   each side effect starts now and is tracked under a short label instead of
 *   an anonymous fire-and-forget IIFE, so the unmount can let them settle
 *   before teardown (the registry never blocks the mount itself).
 * @returns {void} — every effect starts on call and is tracked in the registry.
 */
export function startSideEffects(ctx: { get?: (n: string) => unknown; [key: string]: unknown }, wiring: Wiring, side: DrawToolSide, effects: EffectRegistry) {
  const { publisher, catalogStore, settings } = wiring;

  // Seed the registration from the persisted catalog so a restarted Host
  // offers models before its first poll (and with no console login at all).
  // Tracked, not fire-and-forget: a state dir that cannot be read just waits
  // for the poll, and the unmount's drain lets a still-settling seed finish
  // before the publisher is disposed. The last KNOWN quota-exhausted set
  // rides the seed too (v2 record): a restart must not hand the picker back
  // the models the last known poll blocked (the three-state rule applies at
  // boot — a v1 record states nothing and the fresh-install offer is wide).
  effects.add("catalog-seed", () =>
    seedPublisherFromCatalog(
      publisher,
      () => catalogStore.list(),
      () => catalogStore.listEnabledIds(),
      () => catalogStore.listUnavailable()
    )
  );

  // Draw absorption: opt-in, doubly degraded (no tools service / no peer).
  // The effective value is panel-saved > config default (`draw-store.ts`),
  // read here — and when it is already on, the tool is registered during this
  // mount (see `registerDrawTool`, which awaits the panel value and calls
  // `tools.register`). The reconcile form, not the bare register: it releases
  // whatever this plugin already holds before registering, which is exactly
  // what the panel's route does after a flip — so a mount and a flip share one
  // path, and an off→on flip lands in-session instead of at the next Host
  // start. It is also a QUEUE (`reconcileDrawTool`), so a flip that arrives
  // while this mount pass is still reading the store cannot race it.
  effects.add("draw-tool", () => reconcileDrawTool(ctx, wiring, side));

  // Web-search absorption (ROADMAP §6.1.7): opt-in, doubly degraded, and the
  // selection is taken over only when the switch is on. Fire-and-forget, like
  // the draw tool — and the restore is remembered on `wiring` so `teardown`
  // hands the selection back (clearing the empty slot it took over — Option B
  // never displaces a sibling, so there is no backend to restore). `reconcile`
  // rather than the bare register, so the panel's in-session flip can drop
  // and re-apply the same way this mount does.
  effects.add("web-search", () => reconcileWebSearch(ctx, wiring));

  // Background freshness for the standing provider (2026-10 review #1b): the
  // panel's poll used to be the ONLY refresher of the catalog/quota state a
  // REGISTERED provider keeps serving — while the panel lives and dies with
  // the browser tab. This effect arms the same aggregate engine on a slow
  // cadence (config `providerRefreshMinutes`, default 15, 0 = off) whenever
  // the EFFECTIVE provider switch is on; every tick re-reads the switch, so an
  // opt-in Host that never registers a provider runs no aggregate at all. The
  // handle lives in the `providerRefresh` slot and `teardown` closes it.
  effects.add("provider-refresh", async () => {
    if (settings.providerRefreshMinutes <= 0) return;
    const handle = armProviderRefresher(wiring, settings.providerRefreshMinutes);
    if (handle !== null) wiring.providerRefresh.current = handle;
  });

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
  // `visionPublish.current` is filled in by `publishVisionStepTwo` from
  // `ctx.get("settings")` (the resolver-not-snapshot pattern: the service
  // may register after this plugin mounts, so the read retries a bounded
  // number of times before the plugin gives up); a Host without one leaves
  // it null and the publish simply never runs. It runs as a tracked effect
  // (ADR-008), so a settings service that arrives a moment later is still
  // picked up before the next poll — and the unmount's drain lets it
  // settle, so the write itself is idempotent per poll and a late fill
  // costs nothing.
  // ------------------------------------------------------------------
  effects.add("vision", () => publishVisionStepTwo(ctx, wiring));
}

/**
 * Vision step two's mount-time effect (ARCHITECTURE.md §5.1). A named
 * function so the effect registry (ADR-008) can track it under `"vision"`
 * like every other mount-time effect — the label then shows up in a
 * unmount-drain straggler report instead of the effect being unnameable.
 * @param {{ get?: (n: string) => unknown; [key: string]: unknown }} ctx - the host root context.
 * @param {Wiring} wiring - assembled by `apply()`; the fields read here are
 *   `settings` / `visionPublish` / `publisher` / `logger`.
 * @returns {Promise<void>}
 */
async function publishVisionStepTwo(ctx: { get?: (n: string) => unknown; [key: string]: unknown }, wiring: Pick<Wiring, "publisher" | "settings" | "visionPublish" | "logger">) {
  const { publisher, settings, visionPublish } = wiring;
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
}

// ------------------------------------------------------------------
// Facade (ADR-013): `web-search.ts` owns the `ctx.web` mount and selection
// takeover, `draw-mount.ts` owns the draw tool's mount logic; every name
// still imports from this module, so the split never moved the import
// surface — the same zero-change precedent the raccoon publisher/store
// split used.
// ------------------------------------------------------------------
export type { WebSearchRuntime, WebSearchSelection, WebSearchToolWiring } from "./web-search.ts";
export { webSearchSelection, applyWebSearchSelection, registerWebSearchProvider } from "./web-search.ts";
export { registerDrawTool, reconcileDrawTool, closeDrawTool } from "./draw-mount.ts";
export type { DrawToolWiring, DrawFetchResponse, DrawToolSide } from "./draw-mount.ts";
import { reconcileWebSearch } from "./web-search.ts";
export { reconcileWebSearch };

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
 * This order is a concurrency fix and must NOT be simplified. The caller
 * (the unmount cleanup in `apply`) drains the effect registry BEFORE this
 * runs, so by the time these lines execute every mount-time effect has
 * either settled or been reported as a straggler by its label.
 * @param {Wiring} wiring - assembled by `apply()`; the fields read here are
 *   `publisher` / `releaseProvider` / `raccoonPublisher` / `webSearchRestore`
 *   / `providerRefresh` / `drawRestore`, so the type says exactly that shape.
 *   `drawRestore` is handed to {@link closeDrawTool} rather than called here,
 *   because the reconcile gate has to close with it.
 * @param {Array<() => void>} offs - the unregister callbacks from
 *   {@link registerRoutes}. `Function[]` was the old spelling and it is
 *   `any[]` in disguise — a `Function` may be called with any arguments and
 *   return anything, so it pinned neither the shape nor the arity.
 * @returns {void}
 */
export function teardown(wiring: Pick<Wiring, "publisher" | "releaseProvider" | "raccoonPublisher" | "webSearchRestore" | "providerRefresh" | "drawRestore">, offs: Array<() => void>) {
  try {
    wiring.webSearchRestore.current?.();
  } catch {
    // The web runtime may already be gone during shutdown.
  }
  // Hand the agent tool back too: the registry belongs to the Host fiber, so a
  // tool registered here would otherwise outlive this plugin's unmount until
  // the whole Host stops. Through `closeDrawTool`, not by calling the slot
  // directly: it also shuts the reconcile gate, so a flip still queued behind
  // the drain cannot register a tool that nothing is left to hand back.
  closeDrawTool(wiring);
  // Stop the background refresher's clock FIRST among the timers: a tick that
  // fires between this line and `publisher.dispose()` would be stopped by the
  // disposed gate anyway, but clearing the interval here means a withdrawing
  // Host never schedules another one. Idempotent through the slot: never
  // armed (config 0 / provider off at mount) reads as `null`.
  try {
    wiring.providerRefresh.current?.close();
    wiring.providerRefresh.current = null;
  } catch {
    // Nothing downstream depends on the clock being stopped twice-proof.
  }
  const { publisher, releaseProvider, raccoonPublisher } = wiring;
  // Before anything else: a publish still in flight (the mount seed's, or a
  // poll's) must not register into a Host that is letting this plugin go.
  publisher.dispose();
  // The Raccoon provider is a SECOND, independent registration (ROADMAP
  // §6.1): dispose it in the same order it registered, so a late raccoon
  // publish cannot register into the withdrawing Host either.
  raccoonPublisher?.dispose();
  raccoonPublisher?.release();
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
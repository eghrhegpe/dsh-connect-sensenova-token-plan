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
 * and {@link teardown} for the unmount order that PITFALLS §18 pins
 * (`dispose → release → off×5` — it must NOT be simplified).
 *
 * Peer-free discipline: no Host peer is imported here. The only lazy peer
 * loads (the adapter / tools modules) are injected from `apply` via `deps`.
 *
 * @module dsh-connect-sensenova-token-plan/lifecycle
 */
import { defineDrawTool } from "./draw.ts";
import { seedPublisherFromCatalog, catalogSignature } from "./provider-publish.ts";
import { retryBounded } from "./util.ts";
import { name } from "./host-config.ts";

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
 * @param {object} ctx - the host root context.
 * @param {string} service - the service name for `ctx.get`.
 * @param {object} [options]
 * @param {() => boolean} [options.isDisposed] - stop early when the plugin is
 *   withdrawing; a late registration into a withdrawing Host is worse than
 *   absence.
 * @param {number} [options.attempts] - test seam for the attempt count.
 * @param {number} [options.delayMs] - test seam for the backoff base.
 * @returns {Promise<unknown|null>} the service, or `null` when it never
 *   appeared inside the window.
 */
export async function resolveServiceWithRetry(
  ctx,
  service,
  // Typed explicitly rather than left to inference, and NOT via JSDoc: a
  // parameter with a default initializer is typed from that initializer (`{}`),
  // and in a `.ts` file `@param` / `@type` are comments, not type sources — so
  // the destructuring below would read three properties off `{}` (TS2339).
  options: { isDisposed?: () => boolean; attempts?: number; delayMs?: number } = {}
) {
  const {
    isDisposed = () => false,
    attempts = SERVICE_RETRY_ATTEMPTS,
    delayMs = SERVICE_RETRY_DELAY_MS
  } = options;
  let found = null;
  await retryBounded({
    attempts,
    delayMs,
    run: () => {
      if (isDisposed()) return true;
      try {
        const value = ctx.get?.(service) ?? ctx[service] ?? null;
        if (value !== null && value !== undefined) {
          found = value;
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

/**
 * Register the `sensenova_draw_image` agent tool (ARCHITECTURE.md §5.4,
 * route B). Opt-in (`drawEnabled`, default off) and doubly degraded — a Host
 * with no tools service never sees it, and a peer that fails to load leaves
 * the panel and the provider untouched. Named as a separate export so a test
 * can inject its own `ctx`/`wiring`; `startSideEffects` calls it when enabled.
 * @param ctx - the host root context (reads `ctx.get("tools")` / `ctx.tools`).
 * @param {object} wiring - see {@link startSideEffects}.
 * @param {object} side - test seams from `apply`'s `deps`.
 * @param {Function} side.loadToolsModule - lazy `@deepseek-ai/dsh-tools` loader.
 * @param {Function} side.drawFetch - draw request fetch (stubbed in tests).
 * @returns {Promise<void>}
 */
export async function registerDrawTool(ctx, wiring, side) {
  const { settings, configError, providerState, catalogStore, resolveApiKey, publisher, drawStore } = wiring;
  const { loadToolsModule, drawFetch } = side;
  if (configError !== null) return;
  const effectiveDrawEnabled = (drawStore ? await drawStore.enabled().catch(() => null) : null) ?? settings.drawEnabled;
  if (effectiveDrawEnabled !== true) return;
  // Same precedence as the switch: a panel-saved model preference beats the
  // patch's `drawModelId` (empty string = auto-pick from the catalog).
  const panelModelId = drawStore ? await drawStore.modelId().catch(() => null) : null;
  const effectiveSettings = panelModelId !== null ? { ...settings, drawModelId: panelModelId } : settings;
  // The tools service is optional and may register a moment AFTER this
  // plugin mounts; retry the read, never the registration — a tool cannot be
  // unregistered, so registering it twice would be a worse failure than
  // missing it.
  const tools = await resolveServiceWithRetry(ctx, "tools", {
    isDisposed: () => publisher.isDisposed()
  });
  if (tools === null || typeof tools.register !== "function") return;
  let defineTool;
  try {
    const mod = await Promise.resolve(loadToolsModule());
    defineTool = mod?.defineTool ?? mod?.default?.defineTool ?? null;
  } catch {
    // No tools peer on this Host: the draw tool stays absent, nothing logs.
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
  } catch {
    // A refusing registry degrades identically: tool absent, panel fine.
  }
}

/**
 * Run the mount-time side effects: the persisted-catalog seed, the draw tool
 * (when opted in), and vision step two's settings-row writer.
 * @param ctx - the host root context.
 * @param {object} wiring - assembled by `apply()`.
 * @param {object} wiring.settings - the resolved settings row.
 * @param {string|null} wiring.configError - a settings/auth misconfiguration.
 * @param {object} wiring.publisher - the `createProviderPublisher` instance.
 * @param {object} wiring.providerState - `publisher.state` (shared reference).
 * @param {object} wiring.catalogStore - the `createFileCatalogStore` instance.
 * @param {Function} wiring.resolveApiKey - resolves the live `sk-` key.
 * @param {{current: Function|null}} wiring.visionPublish - filled here.
 * @param {object} [wiring.logger] - `ctx.logger` (Host logging).
 * @param {object} side - test seams from `apply`'s `deps`
 *   (`loadToolsModule`, `drawFetch`).
 * @returns {void} — seed and draw are fire-and-forget.
 */
export function startSideEffects(ctx, wiring, side) {
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
  // The effective value is panel-saved > config default (draw-storets),
  // read at mount time — the actual tool mount/unmount only happens on the
  // next Host start, since the tools registry has no unregister call.
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
      const settingsService = await resolveServiceWithRetry(ctx, "settings", {
        isDisposed: () => publisher.isDisposed()
      });
      if (settingsService === null || typeof settingsService.update !== "function") return;
      const descriptorOf = () => {
        try {
          const view = settingsService.describe?.({ redactSecrets: true });
          const rows = Array.isArray(view) ? view : view?.entries ?? [];
          return rows.find((candidate) => candidate?.ns === name) ?? null;
        } catch {
          return null;
        }
      };
      let publishing = false;
      let lastPublishedIds = settings.imageModelIds.slice();
      visionPublish.current = async (visionEntries, ids) => {
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
          wiring.logger?.warn?.(`${name}: vision publish refused: ${error instanceof Error ? error.message : String(error)}`);
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
 * @param {object} wiring - assembled by `apply()`.
 * @param {Function} wiring.releaseProvider - `publisher.release()`.
 * @param {object} wiring.publisher - the `createProviderPublisher` instance.
 * @param {Function[]} offs - the unregister callbacks from {@link registerRoutes}.
 * @returns {void}
 */
export function teardown(wiring, offs) {
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
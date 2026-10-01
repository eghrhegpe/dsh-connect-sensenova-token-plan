/**
 * The directly-registered provider's PUBLISH STATE MACHINE — the peer-free
 * control-plane half of step three ("one-stop service").
 *
 * Three load-bearing semantics, each pinned by a test that must keep running:
 *   - the publish chain queues a publish behind every one in flight, so a slow
 *     publish can never be overwritten by a fast one (PITFALLS §18);
 *   - the `disposed` gate stops a publish arriving after dispose from
 *     registering into a Host that has withdrawn the plugin;
 *   - the single-point `registerPair` (with its factory-await + shape check,
 *     PITFALLS §19) is used by both the publish and the rollback path.
 *
 * Peer-free: imports no runtime peer. The adapter factory is injected by the
 * caller (`loadAdapterModule`, defaulting to `import("./llm-adapter.ts")`),
 * so the offline suites can substitute a fake factory without touching the
 * Host's node_modules.
 *
 * @module dsh-connect-sensenova-token-plan/provider-publish
 */

import { LLM_PROVIDER_ID, LLM_DISPLAY_NAME } from "./llm-models.ts";
import { identifyVisionModel } from "./parsers.ts";
import { str } from "./util.ts";
import {
  createPublishQueue,
  createPairReleaser,
  createAdapterFactoryResolver,
  registerProviderPair,
  isBuiltAdapter,
  BAD_FACTORY_SHAPE_ERROR,
  describeBuildFailure,
  warnBuildFailure,
  swapRegistration,
  resolveRegistrationService,
  unregister
} from "./publish-core.ts";
import type { HostDeps } from "./types.ts";

/**
 * The provider publisher.
 *
 * Holds the live registration state (`state`); the publish queue, the
 * `disposed` gate and the single-point `registerPair` are the shared
 * `publish-core.ts` bones. The caller drives `publish` from the mount seed, the
 * catalog poll, the provider switch, the roster save and the api-key forget;
 * it calls `dispose` from the `ctx.effect` teardown.
 *
 * The `getLlm` resolver is a FUNCTION, not a snapshot, because the `llm`
 * service may register with the Host after this plugin mounts — the same
 * resolver-not-snapshot pattern used for `credentials`.
 *
 * @param {object} [deps]
 * @param {object} [deps.settings] - the resolved settings row (reads `registerProvider` and `apiBase` only).
 * @param {() => Promise<boolean|null>} [deps.panelSwitch] - the panel-saved value
 *   (`provider-store.enabled()`); null when the state file is untouched.
 * @param {() => Promise<{createSensenovaAdapter: Function}>} [deps.loadAdapterModule] - the
 *   peer-dependent adapter factory module; defaults to the real `llm-adapter.ts`.
 * @param {(service: string) => object|null} [deps.getLlm] - optional-service
 *   resolver for the `llm` registration service.
 * @param {() => Promise<string>} [deps.resolveApiKey] - resolves the live `sk-`
 *   key per request (the `api-key-store.ts` seam). The adapter factory reads
 *   it, so it must be a real resolver, never a snapshot.
 * @param {(event: string) => void} [deps.emit] - `ctx.emit` for the adapter
 *   update event.
 * @param {object} [deps.logger] - `ctx.logger` for the build-failure warning.
 * @returns {{
 *   state: {entries, enabledIds, unavailableIds, signature, quotaSignature,
 *           llmAvailable, registered, error, built, releaseAdapter,
 *           releaseDirectory},
 *   publish: (entries: object[], enabledIds: string[],
 *             unavailableModelIds?: string[]) => Promise<object>,
 *   release: () => void,
 *   dispose: () => void,
 *   isDisposed: () => boolean
 * }}
 */
export function createProviderPublisher(deps: HostDeps = {}) {
  const {
    settings,
    panelSwitch,
    loadAdapterModule,
    getLlm,
    resolveApiKey,
    emit,
    logger
  } = deps;
  const effectiveSettings = settings ?? {};
  const effectivePanelSwitch = panelSwitch ?? (async () => null);
  const effectiveLoadAdapterModule = loadAdapterModule ?? (() => import("./llm-adapter.ts"));
  const effectiveGetLlm = getLlm ?? (() => null);
  const effectiveResolveApiKey = resolveApiKey ?? (async () => "");
  const effectiveEmit = emit ?? (() => {});
  const effectiveLogger = logger ?? { warn: () => {} };

  /**
   * The live registration state. A plain object the caller reads as `state`
   * (the snapshot's `llm` block pulls `registered` / `error` off it). The
   * release functions live here rather than being returned, because a
   * registration that throws AFTER the adapter was registered must still
   * be reachable, or the adapter outlives the plugin (see `registerPair`).
   */
  const state = {
    /** The catalog entries the current registration was built from. */
    entries: [],
    /** The curated allow-list at registration time (empty = all models). */
    enabledIds: [],
    /** The last quota-exhausted model ids published to the picker. */
    unavailableIds: [],
    /** A cheap signature of the offered set (catalog ids + vision bits + allow-list). */
    signature: "",
    /** A cheap signature of the quota-exhausted set; flips when a pool crosses zero. */
    quotaSignature: "",
    /** Whether an `llm` service answering `registerAdapter` is present. */
    llmAvailable: false,
    /** Whether our provider pair is currently registered without error. */
    registered: false,
    /** The last registration error, surfaced secret-free in the snapshot. */
    error: null,
    releaseAdapter: null,
    releaseDirectory: null,
    /** The built adapter the active release functions belong to. */
    built: null
  };

  /**
   * The publish queue and the `disposed` gate — the first two of the three
   * load-bearing semantics. Both live in `publish-core.ts` now, so the
   * Raccoon publisher's copy cannot drift from this one.
   */
  const queue = createPublishQueue();

  /** Resolve the peer-dependent adapter factory once and memoize it. */
  const resolveAdapterFactory = createAdapterFactoryResolver(
    effectiveLoadAdapterModule,
    "createSensenovaAdapter"
  );

  /** Release the registered pair. Releases are idempotent in the Host. */
  const release = createPairReleaser(state);

  /**
   * Hand one built adapter to the llm service and record its release
   * functions onto `target`.
   *
   * The body is the shared `registerProviderPair` (PITFALLS §19) — one copy
   * for both publishers and both paths; this wrapper only supplies which
   * provider the row is for.
   * @param {object} llm - the registration service.
   * @param {{providerIds: string[], adapter: unknown}} built - what to register.
   * @param {object} target - where the release functions are recorded (`state`).
   * @returns {void}
   */
  const registerPair = (llm, built, target) => registerProviderPair(llm, built, target, {
    providerId: LLM_PROVIDER_ID,
    displayName: LLM_DISPLAY_NAME
  });

  /**
   * (Re)build and register the provider for one catalog/allow-list snapshot.
   *
   * Rebuild-and-reregister rather than mutate: `PiAiAdapter` memoizes its
   * profiles snapshot internally, so only a fresh registration can change the
   * offered model list. On a failed registration the PREVIOUS pair is
   * restored, so a bad publish can never take down models that were already
   * serving.
   * @param {object[]} entries - the normalized catalog entries.
   * @param {string[]} enabledIds - the curated allow-list (empty = all).
   * @param {string[]} [unavailableModelIds] - quota-exhausted model ids to
   *   drop from the picker's offer.
   * @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
   */
  const publishProviderOnce = async (entries, enabledIds, unavailableModelIds = []) => {
    // A publish that arrives after the plugin was disposed registers a
    // provider into a Host that has already withdrawn this plugin: no owner,
    // no release, and nothing on screen saying where it came from.
    if (queue.isDisposed()) return { ok: false, skipped: true };
    const previousBuilt = state.built;
    const previousEntries = state.entries;
    const previousEnabledIds = state.enabledIds;
    const previousUnavailable = state.unavailableIds;
    state.entries = Array.isArray(entries) ? entries : [];
    state.enabledIds = Array.isArray(enabledIds) ? enabledIds : [];
    state.unavailableIds = Array.isArray(unavailableModelIds) ? unavailableModelIds : [];
    // Opt-in: with the switch off there must be no registration left behind
    // from a row that flipped it after mounting. The EFFECTIVE switch is
    // panel-first (`provider-store.ts`), falling back to the patch value —
    // re-read here on every publish, so a flip applies without a restart.
    const panelValue = await effectivePanelSwitch().catch(() => null);
    const registerWanted = panelValue ?? effectiveSettings.registerProvider === true;
    if (!registerWanted) return unregister({ state, release });
    const llm = resolveRegistrationService({ state, getLlm: effectiveGetLlm, release });
    if (llm === null) return { ok: false, error: state.error };
    let createSensenovaAdapter;
    let built;
    try {
      createSensenovaAdapter = await resolveAdapterFactory();
      // Awaited, not assumed synchronous: a factory that ever becomes async
      // would otherwise hand a Promise to `registerAdapter`, and the Host
      // would be offered a provider whose adapter is `undefined` — a failure
      // that surfaces as broken model routing, nowhere near its cause.
      built = await createSensenovaAdapter({
        entries: state.entries,
        enabledIds: state.enabledIds,
        baseUrl: effectiveSettings.apiBase,
        resolveApiKey: effectiveResolveApiKey,
        get: effectiveGetLlm,
        unavailableModelIds: state.unavailableIds
      });
      // The same reason, stated: an adapter is registered Host-wide, so a
      // factory that returns anything else must fail here rather than publish
      // a provider that cannot serve a request.
      if (!isBuiltAdapter(built)) throw new Error(BAD_FACTORY_SHAPE_ERROR);
    } catch (e) {
      // A missing llm peer surfaces as Node's ERR_MODULE_NOT_FOUND on the
      // thrown value (which may not be a plugin Error at all) — the shared
      // describer reads it, redacts the message, and appends the remedy.
      const described = describeBuildFailure(e);
      state.error = described.note;
      warnBuildFailure(effectiveLogger, "SenseNova", described);
      return { ok: false, error: described.error };
    }
    // The swap (and the rollback behind it) is the shared mechanism: a failed
    // re-registration must restore the pair that was serving. What is restored
    // on THIS side is the catalog identity — entries, allow-list, and the
    // quota-exhausted set (which must not keep pointing at a set we failed to
    // publish).
    return swapRegistration({
      llm,
      built,
      previousBuilt,
      state,
      release,
      registerPair,
      emit: effectiveEmit,
      onRollback: () => {
        state.entries = previousEntries;
        state.enabledIds = previousEnabledIds;
        state.unavailableIds = previousUnavailable;
      }
    });
  };

  /**
   * Publish, queued behind every other publish in flight.
   *
   * The wrapper exists so no caller has to remember the queue: the mount seed,
   * a catalog poll, an api-key forget and a provider switch all reach the same
   * critical section, and any one of them racing another is the bug above.
   * @param {object[]} entries - the normalized catalog entries.
   * @param {string[]} enabledIds - the curated allow-list (empty = all).
   * @param {string[]} [unavailableModelIds] - quota-exhausted model ids.
   * @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
   */
  const publish = (entries, enabledIds, unavailableModelIds = []) =>
    queue.enqueue(() => publishProviderOnce(entries, enabledIds, unavailableModelIds));

  /**
   * Mark the publisher as disposed: any in-flight or later publish becomes a
   * no-op that cannot register into a withdrawn Host.
   */
  const dispose = () => queue.dispose();

  return {
    state,
    publish,
    release,
    dispose,
    // Exposed so the caller can read whether a publish was skipped due to
    // disposal (the mount seed checks this to stay quiet).
    isDisposed: () => queue.isDisposed()
  };
}

/**
 * Seed the registration from the persisted catalog so a restarted Host offers
 * models before its first poll (and with no console login at all).
 *
 * Fire-and-forget: a state dir that cannot be read just waits for the poll.
 * @param {ReturnType<typeof createProviderPublisher>} publisher
 * @param {() => Promise<object[]>} listCatalog - read the persisted catalog entries.
 * @param {() => Promise<string[]>} listEnabled - read the persisted allow-list.
 * @param {(entries: object[], enabledIds: string[]) => string} signatureOf -
 *   the cheap offered-set signature.
 */
export function seedPublisherFromCatalog(publisher, listCatalog, listEnabled, signatureOf) {
  return (async () => {
    try {
      const [stored, storedEnabled] = await Promise.all([
        listCatalog(),
        listEnabled()
      ]);
      publisher.state.signature = signatureOf(stored, storedEnabled);
      await publisher.publish(stored, storedEnabled, []);
    } catch {
      // No seed catalog: the first successful poll publishes.
    }
  })();
}

/**
 * A cheap signature of the model set a provider registration would offer.
 *
 * It only has to answer "would rebuilding change anything?": the model ids in
 * catalog order, each tagged with the SAME vision decision the descriptors
 * use (an id whose modality flipped must rebuild even though the id list did
 * not change), plus the curated allow-list. Anything else changing in a
 * catalog entry does not affect the registered offer.
 * @param {object[]} entries - the normalized catalog entries.
 * @param {string[]} enabledIds - the allow-list (empty = all).
 * @returns {string}
 */
export function catalogSignature(entries, enabledIds) {
  const models = (Array.isArray(entries) ? entries : [])
    .map((entry) => `${str(entry?.id, "")}:${identifyVisionModel(entry).vision === true ? 1 : 0}`)
    .join(",");
  return `${models}|${(Array.isArray(enabledIds) ? enabledIds : []).join(",")}`;
}

/**
 * The Raccoon provider's PUBLISH STATE MACHINE — the peer-free control plane
 * of the "second upstream provider" (ROADMAP §6.1).
 *
 * Deliberate BOUNDARY: this is a SECOND, independent publisher. It shares
 * NONE of the Token Plan publisher's state (`provider-publish.ts`), so a flip
 * of the Raccoon switch, a Raccoon login/logout, or a Raccoon catalogue drift
 * can never register, release, or churn the Token Plan provider — the "MUST
 * NOT touch Token Plan pool semantics" line of §6.1. It carries the same three
 * load-bearing semantics, restated:
 *   - the publish chain queues a publish behind every one in flight;
 *   - the `disposed` gate stops a late publish registering into a withdrawn
 *     Host;
 *   - the single-point `registerPair` (factory-await + shape check, PITFALLS
 *     §19) serves both the publish and the rollback path.
 *
 * The difference that shapes the publish: Raccoon has NO persisted catalog
 * file and NO per-model quota exhaustion, so a publish is driven by exactly
 * two facts — "is the switch on?" and "is there a credential?" — and its
 * model set is the live (or fallback) roster. The offered-set signature is
 * the roster ids, so a catalogue drift that changes ids triggers a rebuild.
 *
 * Peer-free: the adapter factory is injected (`loadAdapterModule`, defaulting
 * to `import("./raccoon-llm-adapter.ts")`), so the offline suites substitute a
 * fake factory without touching the Host's node_modules.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-publish
 */

import { RACCOON_PROVIDER_ID, RACCOON_DISPLAY_NAME } from "./raccoon-models.ts";
import { str } from "./util.ts";
import {
  createPublishQueue,
  createPairReleaser,
  createAdapterFactoryResolver,
  registerProviderPair,
  isBuiltAdapter,
  describeBuildFailure,
  warnBuildFailure,
  swapRegistration,
  resolveRegistrationService,
  unregister,
  BAD_FACTORY_SHAPE_ERROR
} from "./publish-core.ts";
import type { RaccoonPublisherDeps } from "./types.ts";
import type { PublisherStateBase } from "./publish-core.ts";

/**
 * The Raccoon publisher's live state: the shared registration fields plus the
 * roster facts this upstream rolls back on.
 */
export interface RaccoonPublisherState extends PublisherStateBase {
  /** The roster the current registration was built from. */
  rows: any[];
  /** A cheap signature of the offered roster (ids + vision bits). */
  signature: string;
}

/**
 * The Raccoon provider publisher.
 *
 * @param {object} [deps]
 * @param {() => Promise<boolean|null>} [deps.panelSwitch] - the panel-saved
 *   value (`raccoon-switch-store.enabled()`); `null` when the state file is
 *   untouched (in which case the provider stays off — opt-in default OFF).
 * @param {() => Promise<string>} [deps.resolveToken] - resolves the live
 *   Raccoon JWT per request (`raccoon-store` seam); empty when not logged in.
 * @param {(service: string) => object|null} [deps.getLlm] - optional-service
 *   resolver for the `llm` registration service.
 * @param {() => Promise<{createRaccoonAdapter: Function}>} [deps.loadAdapterModule] -
 *   the peer-dependent adapter factory module; defaults to the real
 *   `raccoon-llm-adapter.ts`.
 * @param {(event: string) => void} [deps.emit] - `ctx.emit` for the adapter
 *   update event.
 * @param {object} [deps.logger] - `ctx.logger` for the build-failure warning.
 * @returns {{
 *   state: object,
 *   publish: (rows: object[], officeIdentity?: string) => Promise<object>,
 *   release: () => void,
 *   dispose: () => void,
 *   isDisposed: () => boolean
 * }}
 */
export function createRaccoonPublisher(deps: RaccoonPublisherDeps = {}) {
  const {
    panelSwitch,
    resolveToken,
    getLlm,
    loadAdapterModule,
    emit,
    logger
  } = deps;
  const effectivePanelSwitch = panelSwitch ?? (async () => null);
  const effectiveResolveToken = resolveToken ?? (async () => "");
  const effectiveLoadAdapterModule = loadAdapterModule ?? (() => import("./raccoon-llm-adapter.ts"));
  const effectiveGetLlm = getLlm ?? (() => null);
  // `emit` is deliberately NOT defaulted here — see the Token Plan publisher
  // for why. `publish-core`'s `emitAdaptersUpdated` is the one place that
  // handles both an absent and a refusing emitter.
  const effectiveLogger = logger ?? { warn: () => {} };

  /** The live Raccoon registration state. */
  const state: RaccoonPublisherState = {
    /** The roster the current registration was built from. */
    rows: [],
    /** A cheap signature of the offered roster (ids + vision bits). */
    signature: "",
    /** Whether an `llm` service answering `registerAdapter` is present. */
    llmAvailable: false,
    /** Whether the Raccoon provider pair is registered without error. */
    registered: false,
    /** The last registration error, surfaced secret-free in the snapshot. */
    error: null,
    releaseAdapter: null,
    releaseDirectory: null,
    /** The built adapter the active release functions belong to. */
    built: null
  };

  /**
   * The publish queue and the `disposed` gate — shared with the Token Plan
   * publisher (`publish-core.ts`), so the two cannot drift apart.
   */
  const queue = createPublishQueue();

  /** Resolve the peer-dependent adapter factory once and memoize it. */
  const resolveAdapterFactory = createAdapterFactoryResolver(
    effectiveLoadAdapterModule,
    "createRaccoonAdapter"
  );

  /** Release the registered pair. Releases are idempotent in the Host. */
  const release = createPairReleaser(state);

  /**
   * Hand one built adapter to the llm service and record its release
   * functions onto `target` — the shared single-point registrar (PITFALLS
   * §19), used by both the publish and the rollback path.
   */
  const registerPair = (llm: { registerAdapter: (providerIds: string[], adapter: unknown) => () => void; registerConfigurableProviders?: (rows: object[]) => () => void }, built: { providerIds: string[]; adapter: unknown }, target: import("./publish-core.ts").PublisherStateBase) => registerProviderPair(llm, built, target, {
    providerId: RACCOON_PROVIDER_ID,
    displayName: RACCOON_DISPLAY_NAME
  });

  /**
   * (Re)build and register the Raccoon provider for one roster snapshot.
   *
   * The publish decision is a three-way gate:
   *   - switch OFF            → release, no registration (opt-in default);
   *   - switch ON, no token   → release, `error: not_configured` (the panel's
   *                             "登录" affordance says so);
   *   - switch ON, token      → build + register the roster.
   * On a failed registration the PREVIOUS pair is restored.
   * @param {object[]} rows - the roster rows (`raccoonRoster`).
   * @param {string} [officeIdentity] - the credential's office identity.
   * @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
   */
  const publishProviderOnce = async (rows: unknown, officeIdentity = "") => {
    if (queue.isDisposed()) return { ok: false, skipped: true };
    const previousBuilt = state.built;
    const previousRows = state.rows;
    state.rows = Array.isArray(rows) ? rows : [];
    state.signature = raccoonSignature(state.rows);

    const panelValue = await effectivePanelSwitch().catch(() => null);
    const registerWanted = panelValue === true;
    if (!registerWanted) return unregister({ state, release });

    // The gateway reads the office identity from the request headers; resolve
    // the live credential's identity at publish time, not a snapshot.
    const llm = resolveRegistrationService({ state, getLlm: effectiveGetLlm, release });
    if (llm === null) return { ok: false, error: state.error };

    // No token to serve with: the offer must not exist, and the reason is a
    // fact the panel states ("not logged in — scan the QR first").
    const token = await effectiveResolveToken().catch(() => "");
    if (token === null || token === "") {
      return unregister({ state, release, error: "not_configured" });
    }

    let createRaccoonAdapter;
    let built;
    try {
      createRaccoonAdapter = await resolveAdapterFactory();
      // Awaited, not assumed synchronous: an async factory that returns a
      // Promise to `registerAdapter` would hand the Host an `undefined`
      // adapter — a failure that surfaces as broken model routing.
      if (createRaccoonAdapter === undefined) throw new Error(BAD_FACTORY_SHAPE_ERROR);
      built = await createRaccoonAdapter({
        rows: state.rows,
        officeIdentity,
        resolveToken: effectiveResolveToken,
        get: effectiveGetLlm
      });
      if (!isBuiltAdapter(built)) throw new Error(BAD_FACTORY_SHAPE_ERROR);
    } catch (e) {
      // Shared with the Token Plan publisher: redaction and the
      // ERR_MODULE_NOT_FOUND remedy live in `publish-core.ts`, so a fix to
      // that diagnosis reaches both upstreams at once.
      const described = describeBuildFailure(e);
      state.error = described.note;
      warnBuildFailure(effectiveLogger, "Raccoon", described);
      return { ok: false, error: described.error };
    }

    // The swap (and the rollback behind it) is the shared mechanism; what is
    // restored on THIS side is the roster identity.
    return swapRegistration({
      llm,
      built,
      previousBuilt,
      state,
      release,
      registerPair,
      emit,
      onRollback: () => {
        state.rows = previousRows;
      }
    });
  };

  /** Publish, queued behind every other in-flight publish. */
  const publish = (rows: unknown, officeIdentity: string | undefined) => queue.enqueue(() => publishProviderOnce(rows, officeIdentity ?? ""));

  /** Mark the publisher disposed: any later publish is a no-op. */
  const dispose = () => queue.dispose();

  return {
    state,
    publish,
    release,
    dispose,
    isDisposed: () => queue.isDisposed()
  };
}

/**
 * A cheap signature of the Raccoon offered roster: the model ids, each tagged
 * with the vision bit — an id whose modality flipped must rebuild even though
 * the id list did not change.
 * @param {object[]} rows - the `raccoonRoster` result.
 * @returns {string}
 */
export function raccoonSignature(rows: unknown): string {
  const models = (Array.isArray(rows) ? rows : [])
    .map((row) => `${str((row as { id?: unknown })?.id, "")}:${(row as { vision?: unknown })?.vision === true ? 1 : 0}`)
    .join(",");
  return models;
}

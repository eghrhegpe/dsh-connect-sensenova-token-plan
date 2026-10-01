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
import { str, redactSecrets } from "./util.ts";
import { name as pluginName } from "./host-config.ts";
import type { RaccoonPublisherDeps } from "./types.ts";

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
  const effectiveEmit = emit ?? (() => {});
  const effectiveLogger = logger ?? { warn: () => {} };

  /** The live Raccoon registration state. */
  const state = {
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

  /** Set once the plugin is disposed; a later publish is a no-op. */
  let disposed = false;

  /** Resolve the peer-dependent adapter factory once and memoize it. */
  let adapterFactoryPromise;
  const resolveAdapterFactory = async () => {
    if (adapterFactoryPromise === undefined) {
      adapterFactoryPromise = Promise.resolve(effectiveLoadAdapterModule()).then((mod) => mod.createRaccoonAdapter);
    }
    return adapterFactoryPromise;
  };

  /** Release the registered pair. Releases are idempotent in the Host. */
  const release = () => {
    const releaseFn = (fn) => {
      try {
        fn?.();
      } catch {
        // The service may already be gone during shutdown or rollback.
      }
    };
    releaseFn(state.releaseAdapter);
    releaseFn(state.releaseDirectory);
    state.releaseAdapter = null;
    state.releaseDirectory = null;
  };

  /**
   * Hand one built adapter to the llm service and record its release
   * functions onto `target` — defined ONCE, used by publish and rollback.
   */
  const registerPair = (llm, built, target) => {
    target.releaseAdapter = llm.registerAdapter(built.providerIds, built.adapter);
    target.releaseDirectory = typeof llm.registerConfigurableProviders === "function"
      ? llm.registerConfigurableProviders([{
          provider: RACCOON_PROVIDER_ID,
          displayName: RACCOON_DISPLAY_NAME,
          settingsNs: pluginName,
          settingsPath: [],
          declared: false
        }])
      : null;
  };

  /** Publishes are serialized through this chain (no lock object; a rejected
   *  link never poisons the ones behind it). */
  let publishChain = Promise.resolve();

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
  const publishProviderOnce = async (rows, officeIdentity = "") => {
    if (disposed) return { ok: false, skipped: true };
    const previousBuilt = state.built;
    const previousRows = state.rows;
    state.rows = Array.isArray(rows) ? rows : [];
    state.signature = raccoonSignature(state.rows);

    const panelValue = await effectivePanelSwitch().catch(() => null);
    const registerWanted = panelValue === true;
    if (!registerWanted) {
      release();
      state.registered = false;
      state.built = null;
      state.error = null;
      return { ok: true, skipped: true };
    }

    // The gateway reads the office identity from the request headers; resolve
    // the live credential's identity at publish time, not a snapshot.
    const llm = effectiveGetLlm("llm");
    state.llmAvailable = llm !== null && typeof llm.registerAdapter === "function";
    if (!state.llmAvailable) {
      release();
      state.registered = false;
      state.error = "the Host exposes no llm registration service";
      return { ok: false, error: state.error };
    }

    // No token to serve with: the offer must not exist, and the reason is a
    // fact the panel states ("not logged in — scan the QR first").
    const token = await effectiveResolveToken().catch(() => "");
    if (token === null || token === "") {
      release();
      state.registered = false;
      state.error = "not_configured";
      return { ok: true, skipped: true };
    }

    let createRaccoonAdapter;
    let built;
    try {
      createRaccoonAdapter = await resolveAdapterFactory();
      // Awaited, not assumed synchronous: an async factory that returns a
      // Promise to `registerAdapter` would hand the Host an `undefined`
      // adapter — a failure that surfaces as broken model routing.
      built = await createRaccoonAdapter({
        rows: state.rows,
        officeIdentity,
        resolveToken: effectiveResolveToken,
        get: effectiveGetLlm
      });
      if (built === null || typeof built !== "object"
        || !Array.isArray(built.providerIds) || built.adapter === undefined) {
        throw new Error("the adapter factory did not return { adapter, providerIds }");
      }
    } catch (e) {
      // Node's ERR_MODULE_NOT_FOUND rides a plain `code` string on the thrown
      // Error — read through an annotation local to this block (see the same
      // shape in provider-publish.ts).
      const error = e as Error & { code?: unknown };
      const note = redactSecrets(error instanceof Error ? error.message : String(error));
      state.error = note;
      effectiveLogger?.warn?.(
        `${pluginName}: cannot build the Raccoon adapter: ${note}`
          + (error?.code === "ERR_MODULE_NOT_FOUND"
            ? " — the llm peer packages ship with the Host; install this plugin where they resolve"
            : "")
      );
      return { ok: false, error };
    }

    // Build first (it can throw); only then take down the old pair.
    release();
    try {
      registerPair(llm, built, state);
    } catch (error) {
      release();
      state.built = null;
      state.rows = previousRows;
      state.error = redactSecrets(error instanceof Error ? error.message : String(error));
      if (previousBuilt !== null) {
        try {
          registerPair(llm, previousBuilt, state);
          state.built = previousBuilt;
          state.registered = true;
        } catch {
          state.built = null;
          state.registered = false;
        }
      } else {
        state.registered = false;
      }
      return { ok: false, error };
    }
    state.built = built;
    state.registered = true;
    state.error = null;
    try {
      effectiveEmit("llm/adapters-updated");
    } catch {
      // A Host that refuses the event still has the registration; readers
      // refresh on their own cadence.
    }
    return { ok: true };
  };

  /** Publish, queued behind every other in-flight publish. */
  const publish = (rows, officeIdentity) => {
    const queued = publishChain.then(
      () => publishProviderOnce(rows, officeIdentity),
      () => publishProviderOnce(rows, officeIdentity)
    );
    publishChain = queued.then(() => undefined, () => undefined);
    return queued;
  };

  /** Mark the publisher disposed: any later publish is a no-op. */
  const dispose = () => {
    disposed = true;
  };

  return {
    state,
    publish,
    release,
    dispose,
    isDisposed: () => disposed
  };
}

/**
 * A cheap signature of the Raccoon offered roster: the model ids, each tagged
 * with the vision bit — an id whose modality flipped must rebuild even though
 * the id list did not change.
 * @param {object[]} rows - the `raccoonRoster` result.
 * @returns {string}
 */
export function raccoonSignature(rows) {
  const models = (Array.isArray(rows) ? rows : [])
    .map((row) => `${str(row?.id, "")}:${row?.vision === true ? 1 : 0}`)
    .join(",");
  return models;
}

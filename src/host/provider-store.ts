/**
 * The provider-registration switch — this plugin's OWN state file, never the
 * Host's configuration.
 *
 * Why a file at all: `registerProvider` in `cordis.patch.yml` is a DEPLOYMENT
 * default the operator edits with a reload, but the panel needs a live switch
 * that takes effect on the next request. The switch state therefore lives in
 * `$DSH_HOME/state/<plugin>/provider.json`, exactly like the catalog
 * (`catalog-store.ts`) and the throttle (`throttle-store.ts`): operational
 * state, not an operator decision baked into the patch layer.
 *
 * Precedence at read time:
 *
 *   1. a value SAVED FROM THE PANEL (enabled: true|false) always wins;
 *   2. no saved value (never touched, or the file was unreadable) falls back
 *      to the patch's `registerProvider` — so an operator who enabled the
 *      provider through configuration keeps it enabled across this change.
 *
 * Integrity follows `throttle-store.ts` / `catalog-store.ts`: a versioned
 * payload, a temp file plus an atomic rename, owner-only modes, and "anything
 * unrecognised reads as not set" — a corrupted or downgraded file costs one
 * re-toggle, never a crash.
 *
 * The shared scaffolding (directory, ADR-006 write-side guard, one-shot legacy
 * inheritance, short-TTL read cache) lives in `switch-store.ts` — this store
 * keeps only its payload shape and its public method surface on top.
 *
 * @module dsh-connect-sensenova-token-plan/provider-store
 */
import { obj } from "./util.ts";
import { name } from "./host-config.ts";
import { profileStateDir } from "./state-store.ts";
import { createSwitchStore, normalizeSwitchEnabled } from "./switch-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const PROVIDER_VERSION = 1;

/**
 * Every persisted shape THIS build can read: the current version plus any
 * historical ones. Bumping {@link PROVIDER_VERSION} means adding the new number
 * here too — otherwise this build would refuse its own newest files.
 *
 * This is the ADR-006 write-side guard's whitelist: an on-disk version not in
 * this list was written by a NEWER build, and must not be clobbered.
 */
export const KNOWN_PROVIDER_VERSIONS: readonly number[] = [1];

/**
 * The directory this plugin's state lives in — per-profile when the Host names
 * one, shared otherwise (PITFALLS §23). Unlike the THROTTLE, which is
 * deliberately shared across profiles, this answers "does THIS profile want the
 * provider registered" and must not be overwritten by the other profile's Host.
 * @param {string|null} [profile] - the profile name; `null` means shared.
 * @returns {string} the directory.
 */
export function providerDir(profile: string | null) {
  return profileStateDir(name, profile);
}

// The on/off normaliser is shared (`switch-store.ts`); re-export under this
// store's historical name — `doctor.ts` and the suite import it from here.
export { normalizeSwitchEnabled as normalizeEnabled };

/**
 * The file-backed provider switch.
 * @param {object} [options]
 * @param {string} [options.dir] - override the state directory (tests).
 * @param {string|null} [options.profile] - the profile name; see {@link providerDir}.
 * @param {number} [options.ttlMs] - how long a parsed switch may be reused
 *   before disk is consulted again.
 * @returns {object} the store.
 */
export function createFileProviderStore(options: StoreOptions = {}) {
  const base = createSwitchStore<boolean>({
    label: "provider",
    file: "provider.json",
    version: PROVIDER_VERSION,
    knownVersions: KNOWN_PROVIDER_VERSIONS,
    hasLegacy: true,
    normalize: (raw) => {
      const source = obj(raw);
      // Shape check, not trust: anything unexpected reads as "not set" so a
      // corrupted or downgraded file can never silently flip the switch.
      return source.version === PROVIDER_VERSION ? normalizeSwitchEnabled(source.enabled) : null;
    },
    writeInherited: (enabled) => ({ version: PROVIDER_VERSION, enabled, updatedAt: new Date().toISOString() }),
  }, options);
  const read = () => base.read();

  return {
    async enabled() {
      return read();
    },

    async isSet() {
      return (await read()) !== null;
    },

    async save(value: boolean) {
      const enabled = normalizeSwitchEnabled(value);
      if (enabled === null) throw new TypeError("provider switch expects a boolean");
      // Write failures PROPAGATE on purpose: a switch the panel ordered must
      // not silently stay off because the state file could not be written.
      // An ADR-006 refusal SURFACES, not just logs: this is an explicit user
      // action, and the route re-reads the value on the same request — silence
      // here left the panel showing an unchanged switch with no reason to act
      // on (the audit's support trap).
      const refusal = await base.writePayload({ version: PROVIDER_VERSION, enabled, updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      base.remember(enabled);
    },

    async forget() {
      // No `enabled` key: "not set" is the absence of an answer, not `false`.
      // Remember only once the write landed — a refused write (ADR-006) leaves
      // the file, and therefore this switch, exactly as it was. Same surfacing
      // rule as `save`: silence here is a button that appears to work.
      const refusal = await base.writePayload({ version: PROVIDER_VERSION, updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      base.remember(null);
    }
  };
}

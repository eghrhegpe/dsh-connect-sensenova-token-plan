/**
 * The Raccoon `web_search` provider switch — this plugin's OWN state file, like
 * `raccoon-switch-store.ts`. Opt-in independently: registering a second
 * `ctx.web` search provider changes DSH's `web_search` routing, so the switch
 * is OFF by default and the panel holds the one saved answer.
 *
 * Same integrity discipline as `raccoon-switch-store.ts`: a versioned payload,
 * a temp file plus an atomic rename, owner-only modes, and "anything
 * unrecognised reads as not set" (PITFALLS §23, per-profile segment).
 *
 * No legacy inheritance here: this switch post-dates the profile segmentation,
 * so there is no shared-directory value to adopt — `hasLegacy` is left off.
 *
 * Shared scaffolding (directory, ADR-006 write-side guard, short-TTL read
 * cache) lives in `switch-store.ts`; this store keeps only its payload shape
 * and its public method surface on top.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-web-store
 */
import { createSwitchStore, normalizeSwitchEnabled } from "./switch-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const RACCOON_WEB_SWITCH_VERSION = 1;

/** Every persisted shape THIS build can read (current + history). */
export const KNOWN_RACCOON_WEB_SWITCH_VERSIONS: readonly number[] = [1];

interface RaccoonWebRecord {
  enabled: boolean | null;
}

/**
 * The file-backed switch.
 * @param {object} [options] - {@link StoreOptions}.
 * @returns {object} the store.
 */
export function createFileRaccoonWebStore(options: StoreOptions = {}) {
  const base = createSwitchStore<RaccoonWebRecord>({
    label: "raccoon-web-switch",
    file: "raccoon-web-search.json",
    version: RACCOON_WEB_SWITCH_VERSION,
    knownVersions: KNOWN_RACCOON_WEB_SWITCH_VERSIONS,
    normalize: (raw) => {
      const source = (raw && typeof raw === "object" ? raw : {}) as { version?: unknown; enabled?: unknown };
      if (source.version !== RACCOON_WEB_SWITCH_VERSION) return null;
      return { enabled: normalizeSwitchEnabled(source.enabled) };
    },
    writeInherited: (value) => ({ version: RACCOON_WEB_SWITCH_VERSION, enabled: value.enabled, updatedAt: new Date().toISOString() }),
  }, options);
  const read = () => base.read();

  return {
    /** The saved switch value. */
    async enabled() {
      return (await read())?.enabled ?? null;
    },
    /** Whether the panel has ever saved a value here. */
    async isSet() {
      return (await read()) !== null;
    },
    /** Persist a switch value (atomic). */
    async save(value: boolean) {
      const enabled = normalizeSwitchEnabled(value);
      if (enabled === null) throw new TypeError("the raccoon web-search switch expects a boolean");
      const refusal = await base.writePayload({ version: RACCOON_WEB_SWITCH_VERSION, enabled, updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      base.remember({ enabled });
    },
    /** Forget the panel-saved value. */
    async forget() {
      const refusal = await base.writePayload({ version: RACCOON_WEB_SWITCH_VERSION, updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      base.remember(null);
    }
  };
}

/**
 * The Raccoon provider-registration switch — this plugin's OWN state file,
 * kept separate from the Token Plan `provider-store.ts` because the two
 * providers are opt-in independently (ROADMAP §6.1 "second upstream provider").
 *
 * Same integrity discipline as `provider-store.ts`: a versioned payload, a
 * temp file plus an atomic rename, owner-only modes, and "anything
 * unrecognised reads as not set" (PITFALLS §23, per-profile segment).
 *
 * Shared scaffolding (directory, ADR-006 write-side guard, one-shot legacy
 * inheritance, short-TTL read cache) lives in `switch-store.ts`; this store
 * keeps only its payload shape and its public method surface on top.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-switch-store
 */
import { obj } from "./util.ts";
import { name } from "./host-config.ts";
import { profileStateDir } from "./state-store.ts";
import { createSwitchStore, normalizeSwitchEnabled } from "./switch-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const RACCOON_SWITCH_VERSION = 1;

/**
 * Every persisted shape THIS build can read (current + history). Bumping
 * {@link RACCOON_SWITCH_VERSION} means adding the new number here too — the
 * ADR-006 write-side guard's whitelist.
 */
export const KNOWN_RACCOON_SWITCH_VERSIONS: readonly number[] = [1];

/**
 * The directory this switch lives in — per-profile when the Host names one.
 * @param {string|null} [profile] - the profile name; `null` means shared.
 * @returns {string} the directory.
 */
export function raccoonSwitchDir(profile: string | null) {
  return profileStateDir(name, profile);
}

// The on/off normaliser is shared; re-export under this store's historical name
// (the suite imports `normalizeRaccoonEnabled` from here).
export { normalizeSwitchEnabled as normalizeRaccoonEnabled };

/**
 * Normalize the pushed-model list: `null`/absent means "no curation — push
 * the whole roster"; an array keeps only non-empty strings, deduped. Any
 * other shape reads as "not set" (the same anything-unrecognised-is-null
 * discipline as the switch itself).
 * @param {unknown} raw - the persisted or posted value.
 * @returns {string[]|null} the curated ids, or `null` when the roster pushes whole.
 */
export function normalizeRaccoonIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry === "string" && entry !== "") seen.add(entry);
  }
  return [...seen];
}

interface RaccoonSwitchRecord {
  enabled: boolean | null;
  enabledModelIds: string[] | null;
}

/**
 * The file-backed Raccoon provider switch.
 * @param {object} [options] - {@link StoreOptions}.
 * @returns {object} the store.
 */
export function createFileRaccoonStore(options: StoreOptions = {}) {
  const base = createSwitchStore<RaccoonSwitchRecord>({
    label: "raccoon-switch",
    file: "raccoon-provider.json",
    version: RACCOON_SWITCH_VERSION,
    knownVersions: KNOWN_RACCOON_SWITCH_VERSIONS,
    hasLegacy: true,
    normalize: (raw) => {
      const source = obj(raw);
      if (source.version !== RACCOON_SWITCH_VERSION) return null;
      // The ids ride beside the switch: a v1 file written before the picker
      // existed simply has no field, which normalizes to "push the whole
      // roster" — old state needs no migration.
      return { enabled: normalizeSwitchEnabled(source.enabled), enabledModelIds: normalizeRaccoonIds(source.enabledModelIds) };
    },
    writeInherited: (value) => ({
      version: RACCOON_SWITCH_VERSION,
      enabled: value.enabled,
      ...(value.enabledModelIds !== null ? { enabledModelIds: value.enabledModelIds } : {}),
      updatedAt: new Date().toISOString()
    }),
  }, options);
  const read = () => base.read();

  return {
    /** The saved switch value. */
    async enabled() {
      return (await read())?.enabled ?? null;
    },
    /** The saved pushed-model list; `null` = the whole roster pushes. */
    async enabledIds() {
      return (await read())?.enabledModelIds ?? null;
    },
    /** Whether the panel has ever saved a value here. */
    async isSet() {
      return (await read()) !== null;
    },
    /** Persist a switch value (atomic), preserving the saved id list. */
    async save(value: boolean) {
      const enabled = normalizeSwitchEnabled(value);
      if (enabled === null) throw new TypeError("the raccoon switch expects a boolean");
      const current = (await read())?.enabledModelIds ?? null;
      const refusal = await base.writePayload({ version: RACCOON_SWITCH_VERSION, enabled, ...(current !== null ? { enabledModelIds: current } : {}), updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      base.remember({ enabled, enabledModelIds: current });
    },
    /** Persist the pushed-model list (atomic), preserving the saved switch. */
    async saveIds(value: string[]) {
      const ids = normalizeRaccoonIds(value);
      if (ids === null) throw new TypeError("the raccoon id list expects an array of strings");
      const enabled = (await read())?.enabled ?? null;
      // An EMPTY list is a real curation ("push nothing"), not "not set" —
      // it must persist, or the next read would widen back to the whole
      // roster. Only `null` means uncurated, and `saveIds` never takes it.
      const refusal = await base.writePayload({ version: RACCOON_SWITCH_VERSION, ...(enabled !== null ? { enabled } : {}), enabledModelIds: ids, updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      base.remember({ enabled, enabledModelIds: ids });
    },
    /** Forget the panel-saved value. */
    async forget() {
      const refusal = await base.writePayload({ version: RACCOON_SWITCH_VERSION, updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      base.remember(null);
    }
  };
}

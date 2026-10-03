/**
 * The Raccoon provider-registration switch — this plugin's OWN state file,
 * kept separate from the Token Plan `provider-store.ts` because the two
 * providers are opt-in independently (ROADMAP §6.1 "second upstream provider").
 *
 * Same integrity discipline as `provider-store.ts`: a versioned payload, a
 * temp file plus an atomic rename, owner-only modes, and "anything
 * unrecognised reads as not set" (PITFALLS §23, per-profile segment).
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-switch-store
 */
import { obj, degrade } from "./util.ts";
import { join } from "node:path";
import { name } from "./host-config.ts";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, readStateVersion, isKnownStateVersion, createStateReadCache, STATE_READ_TTL_MS, profileStateDir, stateDir as sharedStateDir } from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const RACCOON_SWITCH_VERSION = 1;

/**
 * Every persisted shape THIS build can read (current + history). Bumping
 * {@link RACCOON_SWITCH_VERSION} means adding the new number here too — the
 * ADR-006 write-side guard's whitelist (see {@link writePayload}). Mirrors
 * `provider-store.ts` / `draw-store.ts` / `catalog-store.ts`.
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

/**
 * Normalize an on/off switch: only booleans are real answers.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
 */
export function normalizeRaccoonEnabled(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

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

/**
 * The file-backed Raccoon provider switch.
 * @param {object} [options]
 * @param {string} [options.dir] - override the state directory (tests).
 * @param {string|null} [options.profile] - the profile name; see {@link raccoonSwitchDir}.
 * @param {number} [options.ttlMs] - reuse window for a parsed value.
 * @returns {object} the store.
 */
export function createFileRaccoonStore(options: StoreOptions = {}) {
  const { dir, profile = null, ttlMs = STATE_READ_TTL_MS, logger } = options;
  const stateDir = dir ?? raccoonSwitchDir(profile);
  const filePath = join(stateDir, "raccoon-provider.json");

  /**
   * Write one payload atomically to this switch's own file — the single writer
   * for save / saveIds / forget / the §23 legacy adoption (see
   * `provider-store.ts`).
   *
   * ADR-006 write-side guard (mirrors `provider-store.ts`): never overwrite a
   * state file this build cannot read. An unknown NUMERIC version means a NEWER
   * build wrote it; clobbering it destroys data we cannot see. Refuse with a
   * `degrade` signal, not a silent no-op — PITFALLS §37: swallow the failure,
   * not the reason.
   * @param {object} body - the JSON body to persist.
   * @returns {Promise<boolean>} true when written, false when refused.
   */
  const writePayload = async (body: object): Promise<boolean> => {
    const existing = await readStateVersion(filePath);
    if (!isKnownStateVersion(existing, KNOWN_RACCOON_SWITCH_VERSIONS)) {
      degrade(
        `raccoon-switch: refusing to overwrite raccoon-provider.json holding version ${existing} (this build knows ${KNOWN_RACCOON_SWITCH_VERSIONS.join("/")})`,
        null, logger, null
      );
      return false;
    }
    const temporary = temporaryOf(stateDir, "raccoon-provider.json");
    await ensureStateDir(stateDir);
    await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary });
    return true;
  };

  const legacyFile = dir === undefined && profile ? join(sharedStateDir(name), "raccoon-provider.json") : null;
  const parseSwitch = (raw: unknown) => {
    const source = obj(raw);
    if (source.version !== RACCOON_SWITCH_VERSION) return null;
    // The ids ride beside the switch: a v1 file written before the picker
    // existed simply has no field, which normalizes to "push the whole
    // roster" — old state needs no migration.
    return {
      enabled: normalizeRaccoonEnabled(source.enabled),
      enabledModelIds: normalizeRaccoonIds(source.enabledModelIds)
    };
  };

  const cache = createStateReadCache(async () => parseSwitch(await readStateJson(filePath)), {
    ttlMs,
    inheritFrom: legacyFile === null ? null : {
      read: async () => parseSwitch(await readStateJson(legacyFile)),
      write: async (value) => {
        await writePayload({ version: RACCOON_SWITCH_VERSION, enabled: value.enabled, ...(value.enabledModelIds !== null ? { enabledModelIds: value.enabledModelIds } : {}), updatedAt: new Date().toISOString() });
      }
    }
  });
  const read = () => cache.read();

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
      const enabled = normalizeRaccoonEnabled(value);
      if (enabled === null) throw new TypeError("the raccoon switch expects a boolean");
      const current = (await read())?.enabledModelIds ?? null;
      if (await writePayload({ version: RACCOON_SWITCH_VERSION, enabled, ...(current !== null ? { enabledModelIds: current } : {}), updatedAt: new Date().toISOString() })) {
        cache.remember({ enabled, enabledModelIds: current });
      }
    },
    /** Persist the pushed-model list (atomic), preserving the saved switch. */
    async saveIds(value: string[]) {
      const ids = normalizeRaccoonIds(value);
      if (ids === null) throw new TypeError("the raccoon id list expects an array of strings");
      const enabled = (await read())?.enabled ?? null;
      // An EMPTY list is a real curation ("push nothing"), not "not set" —
      // it must persist, or the next read would widen back to the whole
      // roster. Only `null` means uncurated, and `saveIds` never takes it.
      if (await writePayload({ version: RACCOON_SWITCH_VERSION, ...(enabled !== null ? { enabled } : {}), enabledModelIds: ids, updatedAt: new Date().toISOString() })) {
        cache.remember({ enabled, enabledModelIds: ids });
      }
    },
    /** Forget the panel-saved value. */
    async forget() {
      if (await writePayload({ version: RACCOON_SWITCH_VERSION, updatedAt: new Date().toISOString() })) {
        cache.remember(null);
      }
    }
  };
}

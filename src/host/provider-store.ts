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
 * payload, a temp file plus an atomic rename (two Host processes can share
 * the directory), owner-only modes, and "anything unrecognised reads as not
 * set" — a corrupted or downgraded file costs one re-toggle, never a crash.
 *
 * @module dsh-connect-sensenova-token-plan/provider-store
 */
import { obj } from "./util.ts";
import { join } from "node:path";
import { name } from "./host-config.ts";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, createStateReadCache, STATE_READ_TTL_MS, profileStateDir, stateDir as sharedStateDir } from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const PROVIDER_VERSION = 1;

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

/**
 * Normalize an on/off switch: only booleans are real answers.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
 */
export function normalizeEnabled(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * The file-backed provider switch.
 * @param {object} [options]
 * @param {string} [options.dir] - override the state directory (tests).
 * @param {string|null} [options.profile] - the profile name; see {@link providerDir}.
 * @param {number} [options.ttlMs] - how long a parsed switch may be reused
 *   before disk is consulted again; defaults to {@link STATE_READ_TTL_MS}.
 * @returns {object} the store.
 */
export function createFileProviderStore(options: StoreOptions = {}) {
  const { dir, profile = null, ttlMs = STATE_READ_TTL_MS } = options;
  const stateDir = dir ?? providerDir(profile);
  const filePath = join(stateDir, "provider.json");

  /**
   * Write one payload atomically to this switch's own file.
   *
   * The single writer for all three callers (save / forget / the §23 legacy
   * adoption) — three copies of this is exactly the drift this module keeps
   * getting bitten by.
   * @param {object} body - the JSON body to persist.
   * @returns {Promise<void>}
   */
  const writePayload = async (body: object) => {
    const temporary = temporaryOf(stateDir, "provider.json");
    await ensureStateDir(stateDir);
    await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary });
  };

  // Pre-§23 machines kept this switch in the SHARED directory. A profile-scoped
  // store inherits it once, when its own file is missing — see the note on
  // `createStateReadCache` (`state-store.ts`). An explicit `dir` (the tests)
  // never inherits: it was never part of the shared layout.
  const legacyFile = dir === undefined && profile ? join(sharedStateDir(name), "provider.json") : null;
  const parseSwitch = (raw: unknown) => {
    const source = obj(raw);
    return source.version === PROVIDER_VERSION ? normalizeEnabled(source.enabled) : null;
  };

  // Short-TTL read cache, deliberately shared with the draw switch and the
  // catalog (`state-store.ts`): "someone else edited this file" must become
  // visible here within a tick, not after a restart, but one poll must not
  // re-read the file for every question it asks.
  const cache = createStateReadCache(async () => {
    // Shape check, not trust: anything unexpected reads as "not set" so a
    // corrupted or downgraded file can never silently flip the switch.
    // Absent/unreadable/non-JSON reads as `null` (`readStateJson`).
    return parseSwitch(await readStateJson(filePath));
  }, {
    ttlMs,
    inheritFrom: legacyFile === null ? null : {
      read: async () => parseSwitch(await readStateJson(legacyFile)),
      write: async (enabled) => {
        await writePayload({ version: PROVIDER_VERSION, enabled, updatedAt: new Date().toISOString() });
      }
    }
  });
  const read = () => cache.read();

  return {
    /**
     * The saved switch value.
     * @returns {Promise<boolean|null>} `null` = not set, fall back to config.
     */
    async enabled() {
      return read();
    },
    /**
     * Whether the panel has ever saved a value here.
     * @returns {Promise<boolean>}
     */
    async isSet() {
      return (await read()) !== null;
    },
    /**
     * Persist a switch value. The write is atomic (temp file + rename) so a
     * concurrent reader never sees a partial payload.
     * @param {boolean} value - the new switch state.
     * @returns {Promise<void>}
     */
    async save(value: boolean) {
      const enabled = normalizeEnabled(value);
      if (enabled === null) throw new TypeError("provider switch expects a boolean");
      // Write failures PROPAGATE on purpose: a switch the panel ordered must
      // not silently stay off because the state file could not be written.
      await writePayload({ version: PROVIDER_VERSION, enabled, updatedAt: new Date().toISOString() });
      cache.remember(enabled);
    },
    /**
     * Forget the panel-saved value: the config default rules again.
     * @returns {Promise<void>}
     */
    async forget() {
      cache.remember(null);
      // No `enabled` key: "not set" is the absence of an answer, not `false`.
      await writePayload({ version: PROVIDER_VERSION, updatedAt: new Date().toISOString() });
    }
  };
}

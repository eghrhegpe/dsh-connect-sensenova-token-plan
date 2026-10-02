/**
 * The draw-tool switch — this plugin's OWN state file, never the Host's
 * configuration.
 *
 * Mirrors `provider-store.ts`: `drawEnabled` in `cordis.patch.yml` is a
 * DEPLOYMENT default the operator edits with a reload, but the panel needs a
 * live switch that takes effect on the next request. The switch state lives in
 * `$DSH_HOME/state/<plugin>/draw.json` when no profile is named, and
 * `$DSH_HOME/state/<profile>/<plugin>/draw.json` when the Host runs under one
 * (`profileStateDir`) — exactly like the catalog; the throttle shares the same
 * directory by design. Operational state, not an operator decision baked into
 * the patch layer.
 *
 * Precedence at read time:
 *
 *   1. a value SAVED FROM THE PANEL (enabled: true|false) always wins;
 *   2. no saved value (never touched, or the file was unreadable) falls back
 *      to the patch's `drawEnabled` — so an operator who enabled drawing
 *      through configuration keeps it enabled across this change.
 *
 * Integrity follows `provider-store.ts`: a versioned payload, a temp file plus
 * an atomic rename, owner-only modes, and "anything unrecognised reads as not
 * set" — a corrupted or downgraded file costs one re-toggle, never a crash.
 *
 * @module dsh-connect-sensenova-token-plan/draw-store
 */
import { obj } from "./util.ts";
import { join } from "node:path";
import { name } from "./host-config.ts";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, createStateReadCache, STATE_READ_TTL_MS, profileStateDir, stateDir as sharedStateDir } from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const DRAW_STORE_VERSION = 1;

/**
 * The directory this plugin's state lives in — per-profile when the Host names
 * one, shared otherwise (PITFALLS §23). Same reasoning as the provider switch:
 * "does THIS profile route images through SenseNova" is a per-profile opt-in.
 * @param {string|null} [profile] - the profile name; `null` means shared.
 * @returns {string} the directory.
 */
export function drawStoreDir(profile) {
  return profileStateDir(name, profile);
}

/**
 * Normalize an on/off switch: only booleans are real answers.
 * @param {unknown} raw - the persisted or posted value.
 * @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
 */
export function normalizeDrawEnabled(raw) {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * Normalize a panel-saved draw-model preference: a non-empty string id, or
 * `null` when nothing usable (absent / wrong type / blank).
 * @param {unknown} raw - the persisted or posted value.
 * @returns {string|null}
 */
export function normalizeDrawModelId(raw) {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * The file-backed draw switch.
 * @param {object} [options]
 * @param {string} [options.dir] - override the state directory (tests).
 * @param {string|null} [options.profile] - the profile name; see {@link drawStoreDir}.
 * @param {number} [options.ttlMs] - how long a parsed switch may be reused
 *   before disk is consulted again; defaults to {@link STATE_READ_TTL_MS}.
 * @returns {object} the store.
 */
export function createFileDrawStore(options: StoreOptions = {}) {
  const { dir, profile = null, ttlMs = STATE_READ_TTL_MS } = options;
  const stateDir = dir ?? drawStoreDir(profile);
  const filePath = join(stateDir, "draw.json");

  /**
   * Write one payload atomically to this switch's own file — the single writer
   * for save / forget / the §23 legacy adoption (see `provider-store.ts`).
   * @param {object} body - the JSON body to persist.
   * @returns {Promise<void>}
   */
  const writePayload = async (body) => {
    const temporary = temporaryOf(stateDir, "draw.json");
    await ensureStateDir(stateDir);
    await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary });
  };

  // Pre-§23 machines kept this switch in the SHARED directory; a profile-scoped
  // store inherits it once, when its own file is missing. An explicit `dir`
  // (the tests) never inherits.
  const legacyFile = dir === undefined && profile ? join(sharedStateDir(name), "draw.json") : null;
  const parseSwitch = (raw) => {
    const source = obj(raw);
    // One read, two answers: the switch AND the model preference live in the
    // same file (they are the same operator decision — "how this profile
    // draws"), so a single parse keeps them from drifting apart.
    if (source.version !== DRAW_STORE_VERSION) return null;
    return { enabled: normalizeDrawEnabled(source.enabled), modelId: normalizeDrawModelId(source.drawModelId) };
  };

  // Short-TTL read cache, shared with the provider switch and the catalog
  // (`state-store.ts`): see the note in `provider-store.ts` — one primitive,
  // three callers, so the three cannot drift apart again.
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
        await writePayload({ version: DRAW_STORE_VERSION, enabled, updatedAt: new Date().toISOString() });
      }
    }
  });
  const read = () => cache.read();
  const saved = async () => (await read()) ?? { enabled: null, modelId: null };

  return {
    /**
     * The saved switch value.
     * @returns {Promise<boolean|null>} `null` = not set, fall back to config.
     */
    async enabled() {
      return (await saved()).enabled;
    },
    /**
     * The saved draw-model preference.
     * @returns {Promise<string|null>} `null` = not set, fall back to config.
     */
    async modelId() {
      return (await saved()).modelId;
    },
    /**
     * Whether the panel has ever saved a value here. A file that exists but
     * carries no answers (post-forget) still reads as "not set".
     * @returns {Promise<boolean>}
     */
    async isSet() {
      const value = await read();
      return value !== null && (value.enabled !== null || value.modelId !== null);
    },
    /**
     * Persist a switch value. The write is atomic (temp file + rename) so a
     * concurrent reader never sees a partial payload.
     * @param {boolean} value - the new switch state.
     * @returns {Promise<void>}
     */
    async save(value) {
      const enabled = normalizeDrawEnabled(value);
      if (enabled === null) throw new TypeError("draw switch expects a boolean");
      // Write failures PROPAGATE on purpose: a switch the panel ordered must
      // not silently stay off because the state file could not be written.
      await writePayload({ version: DRAW_STORE_VERSION, enabled, drawModelId: (await saved()).modelId ?? undefined, updatedAt: new Date().toISOString() });
      cache.remember({ enabled, modelId: (await saved()).modelId });
    },
    /**
     * Forget the panel-saved value: the config default rules again.
     * @returns {Promise<void>}
     */
    async forget() {
      cache.remember({ enabled: null, modelId: (await saved()).modelId });
      // No `enabled` key: "not set" is the absence of an answer, not `false`.
      await writePayload({ version: DRAW_STORE_VERSION, drawModelId: (await saved()).modelId ?? undefined, updatedAt: new Date().toISOString() });
    },
    /**
     * Persist a draw-model preference (the panel's picker). `null` clears it.
     * @param {string|null} value - the preferred catalog id, or null for auto.
     * @returns {Promise<void>}
     */
    async saveModel(value) {
      const modelId = normalizeDrawModelId(value);
      if (modelId === null && value != null) throw new TypeError("draw model expects a non-empty string or null");
      const enabled = (await saved()).enabled;
      await writePayload({ version: DRAW_STORE_VERSION, ...(enabled !== null ? { enabled } : {}), ...(modelId !== null ? { drawModelId: modelId } : {}), updatedAt: new Date().toISOString() });
      cache.remember({ enabled, modelId });
    },
    /**
     * Forget the draw-model preference: the config default (usually auto) rules again.
     * @returns {Promise<void>}
     */
    async forgetModel() {
      const enabled = (await saved()).enabled;
      cache.remember({ enabled, modelId: null });
      await writePayload({ version: DRAW_STORE_VERSION, ...(enabled !== null ? { enabled } : {}), updatedAt: new Date().toISOString() });
    }
  };
}

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
 * The one persisted record is `{ enabled, modelId }`: the switch and the
 * draw-model preference are the same operator decision ("how this profile
 * draws"), so they live in one file and one parse keeps them from drifting
 * apart.
 *
 * Shared scaffolding (directory, ADR-006 write-side guard, one-shot legacy
 * inheritance, short-TTL read cache) lives in `switch-store.ts`; this store
 * keeps only its payload shape and its public method surface on top.
 *
 * @module dsh-connect-sensenova-token-plan/draw-store
 */
import { obj } from "./util.ts";
import { name } from "./host-config.ts";
import { profileStateDir } from "./state-store.ts";
import { createSwitchStore, normalizeSwitchEnabled } from "./switch-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const DRAW_STORE_VERSION = 1;

/**
 * Every persisted shape THIS build can read (current + history). Bumping
 * {@link DRAW_STORE_VERSION} means adding the new number here too — the ADR-006
 * write-side guard's whitelist.
 */
export const KNOWN_DRAW_VERSIONS: readonly number[] = [1];

/**
 * The directory this plugin's state lives in — per-profile when the Host names
 * one, shared otherwise (PITFALLS §23). "Does THIS profile route images through
 * SenseNova" is a per-profile opt-in.
 * @param {string|null} [profile] - the profile name; `null` means shared.
 * @returns {string} the directory.
 */
export function drawStoreDir(profile: string | null) {
  return profileStateDir(name, profile);
}

// The on/off normaliser is shared; re-export under this store's historical name
// (the suite imports `normalizeDrawEnabled` from here).
export { normalizeSwitchEnabled as normalizeDrawEnabled };

/**
 * Normalize a panel-saved draw-model preference: a non-empty string id, or
 * `null` when nothing usable (absent / wrong type / blank).
 * @param {unknown} raw - the persisted or posted value.
 * @returns {string|null}
 */
export function normalizeDrawModelId(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

interface DrawRecord {
  enabled: boolean | null;
  modelId: string | null;
}

/**
 * The file-backed draw switch.
 * @param {object} [options]
 * @param {string} [options.dir] - override the state directory (tests).
 * @param {string|null} [options.profile] - the profile name; see {@link drawStoreDir}.
 * @param {number} [options.ttlMs] - how long a parsed switch may be reused
 *   before disk is consulted again.
 * @returns {object} the store.
 */
export function createFileDrawStore(options: StoreOptions = {}) {
  const base = createSwitchStore<DrawRecord>({
    label: "draw",
    file: "draw.json",
    version: DRAW_STORE_VERSION,
    knownVersions: KNOWN_DRAW_VERSIONS,
    hasLegacy: true,
    normalize: (raw) => {
      const source = obj(raw);
      if (source.version !== DRAW_STORE_VERSION) return null;
      return { enabled: normalizeSwitchEnabled(source.enabled), modelId: normalizeDrawModelId(source.drawModelId) };
    },
    writeInherited: (value) => ({
      version: DRAW_STORE_VERSION,
      // The value handed back is the INHERITED RECORD, not the switch alone.
      // The conditional-key shape matches the store's own writers (a null field
      // is ABSENT, not `null`), so a backfilled file reads back exactly as the
      // in-memory record.
      ...(value.enabled !== null ? { enabled: value.enabled } : {}),
      ...(value.modelId !== null ? { drawModelId: value.modelId } : {}),
      updatedAt: new Date().toISOString()
    }),
  }, options);
  const read = () => base.read();
  const saved = async (): Promise<DrawRecord> => (await read()) ?? { enabled: null, modelId: null };

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
    async save(value: boolean) {
      const enabled = normalizeSwitchEnabled(value);
      if (enabled === null) throw new TypeError("draw switch expects a boolean");
      // Write failures PROPAGATE on purpose; an ADR-006 refusal SURFACES (not
      // just logs) — this is an explicit user action, and the route re-reads the
      // value on the same request: silence left the panel showing an unchanged
      // switch with no reason to act on.
      const modelId = (await saved()).modelId;
      const refusal = await base.writePayload({ version: DRAW_STORE_VERSION, enabled, drawModelId: modelId ?? undefined, updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      base.remember({ enabled, modelId });
    },
    /**
     * Forget the panel-saved value: the config default rules again.
     * @returns {Promise<void>}
     */
    async forget() {
      // No `enabled` key: "not set" is the absence of an answer, not `false`.
      const modelId = (await saved()).modelId;
      const refusal = await base.writePayload({ version: DRAW_STORE_VERSION, drawModelId: modelId ?? undefined, updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      base.remember({ enabled: null, modelId });
    },
    /**
     * Persist a draw-model preference (the panel's picker). `null` clears it.
     * @param {string|null} value - the preferred catalog id, or null for auto.
     * @returns {Promise<void>}
     */
    async saveModel(value: string | null) {
      const modelId = normalizeDrawModelId(value);
      if (modelId === null && value != null) throw new TypeError("draw model expects a non-empty string or null");
      const enabled = (await saved()).enabled;
      const refusal = await base.writePayload({ version: DRAW_STORE_VERSION, ...(enabled !== null ? { enabled } : {}), ...(modelId !== null ? { drawModelId: modelId } : {}), updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      base.remember({ enabled, modelId });
    },
    /**
     * Forget the draw-model preference: the config default (usually auto) rules again.
     * @returns {Promise<void>}
     */
    async forgetModel() {
      const enabled = (await saved()).enabled;
      const refusal = await base.writePayload({ version: DRAW_STORE_VERSION, ...(enabled !== null ? { enabled } : {}), updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      base.remember({ enabled, modelId: null });
    }
  };
}

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
 * @module dsh-connect-sensenova-token-plan/raccoon-web-store
 */
import { degrade } from "./util.ts";
import { join } from "node:path";
import { name } from "./host-config.ts";
import { ensureStateDir, temporaryOf, writeStateFile, readStateJson, readStateVersion, isKnownStateVersion, createStateReadCache, STATE_READ_TTL_MS, profileStateDir } from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const RACCOON_WEB_SWITCH_VERSION = 1;

/** Every persisted shape THIS build can read (current + history). */
export const KNOWN_RACCOON_WEB_SWITCH_VERSIONS: readonly number[] = [1];

/** The state directory; per-profile when the Host names one. */
export function raccoonWebDir(profile: string | null) {
  return profileStateDir(name, profile);
}

/** Only booleans are real answers. */
export function normalizeWebSearchEnabled(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * The file-backed switch.
 * @param {object} [options] - {@link StoreOptions}.
 * @returns {object} the store.
 */
export function createFileRaccoonWebStore(options: StoreOptions = {}) {
  const { dir, profile = null, ttlMs = STATE_READ_TTL_MS, logger } = options;
  const stateDir = dir ?? raccoonWebDir(profile);
  const filePath = join(stateDir, "raccoon-web-search.json");

  /** ADR-006 write-side guard — never clobber a file this build cannot read. */
  const writePayload = async (body: object): Promise<string | null> => {
    const existing = await readStateVersion(filePath);
    if (!isKnownStateVersion(existing, KNOWN_RACCOON_WEB_SWITCH_VERSIONS)) {
      const reason = `raccoon-web-switch: refusing to overwrite raccoon-web-search.json holding version ${existing} (this build knows ${KNOWN_RACCOON_WEB_SWITCH_VERSIONS.join("/")})`;
      degrade(reason, null, logger, null);
      return reason;
    }
    const temporary = temporaryOf(stateDir, "raccoon-web-search.json");
    await ensureStateDir(stateDir);
    await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary });
    return null;
  };

  const parseSwitch = (raw: unknown) => {
    const source = (raw && typeof raw === "object" ? raw : {}) as { version?: unknown; enabled?: unknown };
    if (source.version !== RACCOON_WEB_SWITCH_VERSION) return null;
    return { enabled: normalizeWebSearchEnabled(source.enabled) };
  };

  const cache = createStateReadCache(async () => parseSwitch(await readStateJson(filePath)), { ttlMs });
  const read = () => cache.read();

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
      const enabled = normalizeWebSearchEnabled(value);
      if (enabled === null) throw new TypeError("the raccoon web-search switch expects a boolean");
      const refusal = await writePayload({ version: RACCOON_WEB_SWITCH_VERSION, enabled, updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      cache.remember({ enabled });
    },
    /** Forget the panel-saved value. */
    async forget() {
      const refusal = await writePayload({ version: RACCOON_WEB_SWITCH_VERSION, updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      cache.remember(null);
    }
  };
}
/**
 * The persisted model catalog — this plugin's OWN state file, never the Host's
 * configuration.
 *
 * Why a file at all: the directly-registered LLM provider needs a model list
 * before the first snapshot poll completes (and after a restart with no console
 * login), so the last catalog the API key fetched is cached under
 * `$DSH_HOME/state/<plugin>/catalog.json` (or `state/<profile>/<plugin>/` when
 * the Host names one — see `profileStateDir`). It is deliberately NOT written into
 * the settings row (`cordis.patch.yml`): a catalog is operational state, not an
 * operator decision, and writing volatile arrays into the patch layer is the
 * shape the WorkBuddy catalog drift warned about.
 *
 * Integrity follows `throttle-store.ts`: a versioned payload, a temp file plus
 * an atomic rename (two Host processes can share the directory), owner-only
 * modes, and "anything unrecognised reads as no catalog" — a corrupted or
 * downgraded file costs one re-fetch, never a crash.
 *
 * @module dsh-connect-sensenova-token-plan/catalog-store
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { str, obj, num, degrade } from "./util.ts";
import { name } from "./host-config.ts";
import { readStateJson, createStateReadCache, STATE_READ_TTL_MS, profileStateDir, stateDir as sharedStateDir, createVersionedJsonWriter } from "./state-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const CATALOG_VERSION = 1;

/**
 * Every persisted shape THIS build can read (current + history) — the ADR-006
 * write-side guard's whitelist (see {@link persist}). Mirrors
 * `provider-store.ts` / `draw-store.ts`.
 */
export const KNOWN_CATALOG_VERSIONS: readonly number[] = [1];

/** The persisted record shape `parse` accepts and the writers produce. */
export interface CatalogRecord {
  version: number;
  fetchedAt: number;
  entries: object[];
  enabledModelIds: string[];
}

/**
 * Normalize a model-id allow-list.
 *
 * An EMPTY list means "no filter" (the WorkBuddy convention): a fresh install
 * has curated nothing and must still be offered every model. Once non-empty it
 * is an allow-list. Junk entries are dropped rather than stored.
 * @param {unknown} raw - the persisted or posted list.
 * @returns {string[]} unique string ids in first-seen order.
 */
export function normalizeEnabledIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out: string[] = [];
  for (const item of raw) {
    const id = str(item, "");
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The directory this plugin's state lives in — per-profile when the Host names
 * one, shared otherwise (PITFALLS §23).
 * @param {string|null} [profile] - the profile name; `null` means shared.
 * @returns {string} the directory.
 */
export function catalogDir(profile: string | null) {
  return profileStateDir(name, profile);
}

/**
 * Normalize a raw catalog into unique, whole entries.
 *
 * Mirrors `console-client.fetchModelCatalog`: keep every field the platform
 * sent (vision identification reads `input_modalities`), normalize `id`, and
 * drop entries without one. Duplicate ids keep the LAST occurrence — the
 * freshest read wins — and stay in first-seen order.
 * @param {unknown} raw - the raw `body.data` array or persisted entries.
 * @returns {object[]} normalized entries.
 */
export function normalizeEntries(raw: unknown): object[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map();
  for (const item of raw) {
    const source = obj(item);
    const id = str(source.id, "");
    if (id === "") continue;
    byId.set(id, { ...source, id });
  }
  return [...byId.values()];
}

/**
 * Parse a persisted catalog, or `null` when it is absent, unusable, or foreign.
 *
 * Only two things are refused here: a foreign shape (`version` mismatch) and a
 * record that never carried a fetch time. There is deliberately NO staleness
 * test — the catalog is cache-shaped, and "how old is too old" is the caller's
 * call (the snapshot route refreshes it on its own cadence and replaces the
 * file on write), so refusing a merely old catalog would only force a re-fetch
 * that the next poll does anyway.
 *
 * The safe direction for a cache is "absent": the next snapshot re-fetches.
 * @param {unknown} raw - the parsed file contents.
 * @returns {{version: number, fetchedAt: number, entries: object[], enabledModelIds: string[]}|null}
 */
function parse(raw: unknown): CatalogRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as { version?: unknown; fetchedAt?: unknown; entries?: unknown; enabledModelIds?: unknown };
  if (num(body.version, 0) !== CATALOG_VERSION) return null;
  const fetchedAt = num(body.fetchedAt, 0);
  if (fetchedAt <= 0) return null;
  const entries = normalizeEntries(body.entries);
  const enabledModelIds = normalizeEnabledIds(body.enabledModelIds);
  // `version` travels with the record so the in-memory view and the written
  // payload are the same shape: what `parse` accepted is exactly what `persist`
  // will write back.
  return { version: CATALOG_VERSION, fetchedAt, entries, enabledModelIds };
}

/**
 * The store contract both the file-backed and in-memory factories satisfy:
 * one cached catalog of model entries plus a curated id allow-list.
 * @typedef {object} CatalogStore
 * @property {() => Promise<object[]>} list - stored entries, `[]` when none usable.
 * @property {() => Promise<string[]>} listEnabledIds - allow-list; `[]` means "no filter".
 * @property {(entries: object[], enabledModelIds?: string[]) => Promise<void>} replace - swap the catalog, preserving the allow-list unless given a new one.
 * @property {(ids: string[]) => Promise<void>} setEnabledIds - swap ONLY the allow-list.
 * @property {() => Promise<void>} clear - remove the stored catalog.
 */

/**
 * A catalog store backed by one atomically-written file.
 * @param {object} [options] - wiring.
 * @param {string} [options.dir] - directory; overrides {@link options.profile}.
 * @param {string|null} [options.profile] - the profile name, so two profiles
 *   each get their own catalog instead of overwriting one shared allow-list;
 *   defaults to `null` (the shared directory, i.e. today's behaviour).
 * @param {() => number} [options.now] - clock source; injected by the tests.
 * @param {number} [options.ttlMs] - how long a parsed record may be reused
 *   before disk is consulted again; defaults to {@link STATE_READ_TTL_MS}.
 * @returns {CatalogStore} the store.
 */
export function createFileCatalogStore(options: StoreOptions = {}) {
  const { dir, profile = null, now = Date.now, ttlMs = STATE_READ_TTL_MS, logger } = options;
  const stateDir = dir ?? catalogDir(profile);
  const file = join(stateDir, "catalog.json");
  // ADR-006 write-side guard + atomic write are shared via createVersionedJsonWriter
  // (state-store.ts): never overwrite a catalog file this build cannot read; a
  // refusal degrades (not errors) through `onRefuse`, so the in-memory record
  // keeps serving. `held == null` means "nothing to persist" (after clear()).
  const writeCatalog = createVersionedJsonWriter({
    file,
    versions: KNOWN_CATALOG_VERSIONS,
    label: "catalog",
    onRefuse: (reason) => degrade(reason, null, logger, null),
    now
  });
  /**
   * Last known record, mirrored from {@link cache} so the writers can reuse the
   * allow-list without a second read. `undefined` means "never synced from
   * disk", `null` means "synced, nothing usable stored".
   * @type {{version: number, fetchedAt: number, entries: object[], enabledModelIds: string[]}|null|undefined}
   */
  let held: CatalogRecord | null | undefined;
  // Read-through with a short TTL, NOT a once-per-process cache: this state
  // directory is shared with every other Host process (another profile included,
  // see PITFALLS §22), so a cache that never expires means another process's
  // allow-list edit stays invisible here until a restart. Same bound the
  // provider and draw switches already use.
  // A profile-scoped store starts empty even on a machine whose values still
  // live in the pre-§23 SHARED directory. The cache inherits that record ONCE,
  // when its own file is found missing, then writes it back. An explicit `dir`
  // (the tests) never inherits: it was never part of the shared layout.
  const legacyFile = dir === undefined && profile ? join(sharedStateDir(name), "catalog.json") : null;

  const cache = createStateReadCache(async () => parse(await readStateJson(file)), {
    ttlMs,
    now,
    inheritFrom: legacyFile === null ? null : {
      /** The pre-§23 record, if this machine ever wrote one. */
      read: async () => parse(await readStateJson(legacyFile)),
      /** Re-persist an inherited record under this profile's own directory. */
      write: async (record) => {
        held = record;
        await persist();
      }
    }
  });
  /** Sync `held` with disk (through the TTL cache) and return it. */
  const seen = async () => {
    held = await cache.read();
    return held;
  };

  const persist = async () => {
    if (held == null) return;
    await writeCatalog(held).catch(() => {});
  };

  return {
    /**
     * The stored entries, or `[]` when nothing usable is stored.
     * @returns {Promise<object[]>}
     */
    async list() {
      const record = await seen();
      return record === null ? [] : record.entries;
    },

    /**
     * The curated model-id allow-list; an EMPTY array means "no filter".
     * @returns {Promise<string[]>}
     */
    async listEnabledIds() {
      const record = await seen();
      return record === null ? [] : record.enabledModelIds;
    },

    /**
     * Atomically replace the stored catalog.
     *
     * A read-only Home must not break the panel: the write failing only means
     * the catalog is re-fetched after the next restart, so the error is
     * swallowed after the in-memory copy is updated. The curated allow-list is
     * PRESERVED across a catalog refresh unless a new one is supplied.
     * @param {object[]} entries - the fresh catalog entries.
     * @param {string[]} [enabledModelIds] - an optional replacement allow-list.
     * @returns {Promise<void>}
     */
    async replace(entries: object[], enabledModelIds?: string[]) {
      // Sync first, so the allow-list being preserved is the one ACTUALLY
      // stored — including a list another process wrote since this one last
      // looked. Reading it lazily used to silently reset it to `[]` whenever a
      // replace happened before the first `list()`.
      const current = await seen();
      const kept = current === null ? [] : current.enabledModelIds;
      held = {
        version: CATALOG_VERSION,
        fetchedAt: now(),
        entries: normalizeEntries(entries),
        enabledModelIds: enabledModelIds === undefined ? kept : normalizeEnabledIds(enabledModelIds)
      };
      cache.remember(held);
      await persist();
    },

    /** Replace ONLY the curated allow-list, keeping the cached catalog. */
    async setEnabledIds(ids: string[]) {
      const current = await seen();
      const entries = current === null ? [] : current.entries;
      const fetchedAt = current === null ? now() : current.fetchedAt;
      held = { version: CATALOG_VERSION, fetchedAt, entries, enabledModelIds: normalizeEnabledIds(ids) };
      cache.remember(held);
      await persist();
    },

    /** Remove the stored catalog (used when the API key is forgotten). */
    async clear() {
      held = null;
      cache.remember(null);
      try {
        await rm(file, { force: true });
      } catch {
        // An absent file is already a cleared catalog.
      }
    }
  };
}

/**
 * A catalog store that forgets everything when the process ends.
 *
 * Used by the tests and by hosts given nothing writable; deliberately not the
 * default, like the memory throttle store.
 * @param {() => number} [now] - clock source.
 * @returns {CatalogStore}
 */
export function createMemoryCatalogStore(now = Date.now) {
  // The initializer would pin this to `null` (noImplicitAny is off, but a
  // default/initialized binding is still typed from its initializer — see the
  // tsconfig note); annotate the record shape parse() produces instead.
  let held: { version: number; fetchedAt: number; entries: object[]; enabledModelIds: string[] } | null = null;
  return {
    async list() {
      return held === null ? [] : held.entries;
    },
    async listEnabledIds() {
      return held === null ? [] : held.enabledModelIds;
    },
    async replace(entries: object[], enabledModelIds?: string[]) {
      const kept = held === null ? [] : held.enabledModelIds;
      held = {
        version: CATALOG_VERSION,
        fetchedAt: now(),
        entries: normalizeEntries(entries),
        enabledModelIds: enabledModelIds === undefined ? kept : normalizeEnabledIds(enabledModelIds)
      };
    },
    async setEnabledIds(ids: string[]) {
      const entries = held === null ? [] : held.entries;
      const fetchedAt = held === null ? now() : held.fetchedAt;
      held = { version: CATALOG_VERSION, fetchedAt, entries, enabledModelIds: normalizeEnabledIds(ids) };
    },
    async clear() {
      held = null;
    }
  };
}

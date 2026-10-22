/**
 * When each Raccoon roster id was FIRST seen — this plugin's OWN state file,
 * like `raccoon-switch-store.ts`, and deliberately separate from it: the switch
 * store's payload is a versioned contract with three writers (save / saveIds /
 * forget) and every one of them would have to preserve this map, or a switch
 * flip would silently reset "what is new" for the user.
 *
 * Why the history has to be persisted at all: the gateway's catalogue rows
 * carry no "listed since" fact (the `sn-deepseek-v4-1-flash-1017` row has
 * `description` / `tags` / `params` / billing fields and nothing else), so
 * "this model is new to the user" is only knowable by diffing today's roster
 * against a roster this plugin wrote down. In memory would do for one process;
 * the pill has to survive restarts to be worth rendering.
 *
 * Semantics, stated once because three consumers read them:
 *  - the FIRST ever write SEEDS: it records the roster as already seen (stamped
 *    one window back) and announces nothing new — an upgrade must not tell
 *    every existing user that the whole roster is brand new;
 *  - an id that leaves the roster is dropped, so a model that comes back later
 *    counts as new again (the gateway re-listing an id IS a change the user
 *    may want to see);
 *  - "new" is a WINDOW, not a tick: an id first seen less than
 *    {@link RACCOON_ROSTER_NEW_WINDOW_MS} ago stays new across polls, so the
 *    marker does not vanish between two 300 s catalogue reads;
 *  - an unrecognised payload (or a file from a newer build) reads as "no
 *    history" (PITFALLS §23 anything-unrecognised-is-null); but the FIRST write
 *    over such a file is REFUSED, not stomped — the same ADR-006 discipline as
 *    `raccoon-provider.json`. A caller that cannot write degrades to "no
 *    marker" (`raccoon-status.ts` swallows it), never to a wrong marker.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-roster-seen-store
 */
import { createSwitchStore } from "./switch-store.ts";
import type { StoreOptions } from "./types.ts";

/** Shape version, bumped when the persisted form changes incompatibly. */
export const RACCOON_ROSTER_SEEN_VERSION = 1;

/** Every persisted shape THIS build can read (the ADR-006 write-side whitelist). */
export const KNOWN_RACCOON_ROSTER_SEEN_VERSIONS: readonly number[] = [1];

/**
 * How long a first sighting keeps reading as "new".
 *
 * Seven days: long enough that a user who opens the panel twice a week still
 * catches it, short enough that a stale marker cannot outlive the model it
 * announces. A shorter window is invisible to the weekly user; a longer one
 * turns the marker into permanent furniture.
 */
export const RACCOON_ROSTER_NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The largest roster one file will track. The gateway lists seven visible chats
 * today; the cap is a SHAPE-DRIFT guard, not a queue: a roster larger than this
 * is read as a broken/looping producer, so NOTHING is written or announced for
 * its duration. It deliberately does NOT "keep the newest N" — evicting an id
 * that is still in the live roster makes it look unseen next poll and re-
 * announce it, oscillating (a 250-id roster against a 200 cap cycled 50→100 new
 * per round). A history file that invents models is worse than none.
 */
export const RACCOON_ROSTER_SEEN_MAX_IDS = 200;

/** id → first-seen epoch ms. */
export type RaccoonRosterSeen = Readonly<Record<string, number>>;

interface RaccoonRosterSeenRecord {
  seen: RaccoonRosterSeen;
}

/**
 * Read one persisted map, keeping only well-formed entries.
 *
 * A hand-edited or half-written file must not poison the answer: a non-numeric
 * stamp is dropped rather than coerced (a coerced `0` would read as "seen since
 * 1970" and mark nothing new forever).
 * @param {unknown} raw - the persisted or posted value.
 * @returns {Record<string, number>} the usable entries (possibly empty).
 */
export function normalizeRosterSeen(raw: unknown): Record<string, number> {
  // A map is a PLAIN object. An array would pass `typeof === "object"` and its
  // numeric indices would silently become model ids, so the array branch is
  // rejected like any other unrecognised shape.
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const seen: Record<string, number> = {};
  for (const [id, stamp] of Object.entries(source)) {
    if (id === "" || typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) continue;
    seen[id] = stamp;
  }
  return seen;
}

/**
 * The file-backed first-sighting history.
 * @param {object} [options] - {@link StoreOptions}.
 * @returns {object} the store.
 */
export function createFileRaccoonRosterSeenStore(options: StoreOptions = {}) {
  const base = createSwitchStore<RaccoonRosterSeenRecord>({
    label: "raccoon-roster-seen",
    file: "raccoon-roster-seen.json",
    version: RACCOON_ROSTER_SEEN_VERSION,
    knownVersions: KNOWN_RACCOON_ROSTER_SEEN_VERSIONS,
    normalize: (raw) => {
      const source = raw !== null && typeof raw === "object" ? (raw as { version?: unknown; seen?: unknown }) : {};
      if (source.version !== RACCOON_ROSTER_SEEN_VERSION) return null;
      return { seen: normalizeRosterSeen(source.seen) };
    },
    // No legacy: this file post-dates the profile segmentation, so there is no
    // shared-directory value to adopt (`hasLegacy` stays off).
    writeInherited: (value) => ({
      version: RACCOON_ROSTER_SEEN_VERSION,
      seen: value.seen,
      updatedAt: new Date().toISOString(),
    }),
  }, options);
  const read = () => base.read();

  /** Persist one map (atomic) and refresh this process's view of it. */
  const persist = async (seen: RaccoonRosterSeen) => {
    const refusal = await base.writePayload({ version: RACCOON_ROSTER_SEEN_VERSION, seen, updatedAt: new Date().toISOString() });
    if (refusal !== null) throw new Error(refusal);
    base.remember({ seen });
  };

  /**
   * Retain the map ONLY while the roster is a sane size.
   *
   * The cap is NOT a "keep the newest 200" queue: evicting an id that is still
   * in the live roster makes it look unseen next poll, so it gets a fresh stamp
   * and re-announces — and because the evicted set rotates every round, the
   * "new" count oscillates and GROWS (a 250-id roster against a 200 cap cycles
   * 50 → 100 → …). A history file that invents new models is worse than no
   * history file, so an oversized roster is read as a SHAPE DRIFT: keep the
   * previous map untouched, write nothing, and announce nothing. The marker
   * disappears for the duration of the anomaly and self-heals when the roster
   * returns to a plausible size.
   * @param {Record<string, number>} next - this round's map (one entry per live id).
   * @returns {Record<string, number>|null} the map to persist, or `null` to skip.
   */
  const bounded = (next: Record<string, number>): Record<string, number> | null => {
    return Object.keys(next).length <= RACCOON_ROSTER_SEEN_MAX_IDS ? next : null;
  };

  return {
    /** The whole first-sighting map. */
    async seen(): Promise<RaccoonRosterSeen> {
      return (await read())?.seen ?? {};
    },
    /** Whether this store has ever written a history (distinguishes seed from growth). */
    async isSet() {
      return (await read()) !== null;
    },
    /**
     * Record today's roster and answer which ids still read as new.
     *
     * One call both diffs and persists, because the two must agree: a caller
     * that diffed a cached map and wrote later could announce a model that
     * another poll had already recorded.
     * @param {string[]} ids - the FULL roster as the gateway just listed it.
     * @param {number} [nowMs] - the clock (tests inject it).
     * @returns {Promise<{newIds: string[]}>} ids first seen inside the window,
     *   oldest first; empty on the seeding write and on a roster with nothing fresh.
     */
    async note(ids: readonly string[], nowMs: number = Date.now()): Promise<{ newIds: string[] }> {
      const list = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id !== "") : [];
      const unique = [...new Set(list)];
      if (unique.length === 0) return { newIds: [] };
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      const current = await read();
      // A stamp in the FUTURE (a clock jumped back, or a hand-edited file) is
      // clamped to now rather than trusted: `now - stamp` negative would keep
      // the marker alive past the window.
      const previous = normalizeRosterSeen(current?.seen ?? {});
      const next: Record<string, number> = {};
      const seeded = current === null;
      // A SEEDED id is stamped as if it had already aged out: the upgrade that
      // writes this file first knows the roster exists, not that any of it is
      // new, and announcing a whole roster as "just added" on install is
      // exactly the lie this file exists to avoid. The aged stamp self-heals —
      // an id only earns a real first sighting after it leaves and comes back.
      for (const id of unique) {
        const first = previous[id];
        next[id] = typeof first === "number" && first > 0
          ? Math.min(first, now)
          : seeded ? now - RACCOON_ROSTER_NEW_WINDOW_MS : now;
      }
      const boundedMap = bounded(next);
      if (boundedMap === null) {
        // Shape drift: write nothing, announce nothing, keep the old map.
        return { newIds: [] };
      }
      const trimmed = boundedMap;
      const changed = seeded
        || Object.keys(previous).length !== Object.keys(trimmed).length
        || Object.keys(trimmed).some((id) => previous[id] !== trimmed[id]);
      if (changed) await persist(trimmed);
      const newIds = seeded
        ? []
        : Object.entries(trimmed)
          .filter(([, first]) => now - first < RACCOON_ROSTER_NEW_WINDOW_MS)
          .sort((left, right) => left[1] - right[1])
          .map(([id]) => id);
      return { newIds };
    },
    /** Forget the history (the next `note` reseeds). */
    async forget() {
      const refusal = await base.writePayload({ version: RACCOON_ROSTER_SEEN_VERSION, updatedAt: new Date().toISOString() });
      if (refusal !== null) throw new Error(refusal);
      base.remember(null);
    }
  };
}

export type RaccoonRosterSeenStore = ReturnType<typeof createFileRaccoonRosterSeenStore>;

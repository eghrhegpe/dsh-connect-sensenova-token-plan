/**
 * dsh-connect-sensenova-token-plan — where the sign-in throttle lives.
 *
 * It used to live in the credentials service, disguised as a `kind: "grant"`
 * record carrying a marker field. That disguise was not a stylistic choice:
 * the service admits exactly two record kinds, and an unknown one makes the
 * whole credentials document unparseable — which takes the Host down, not
 * just this panel. So a throttle could only ever be smuggled in as a grant,
 * and a single mistyped payload was enough to break every credential on the
 * machine.
 *
 * A throttle is not a credential. It is state: a deadline and a reason, plus
 * a parked flag for refusals that have no deadline. It belongs in this
 * plugin's own file, where a malformed value costs the plugin its throttle
 * and nothing else.
 *
 * @module dsh-connect-sensenova-token-plan/throttle-store
 */
import { readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { str, num, degrade } from "./util.ts";
import { name } from "./host-config.ts";
import { ensureStateDir, readStateJson, stateDir as pluginStateDir, createVersionedJsonWriter } from "./state-store.ts";
import type { HeldThrottle } from "./token-store/state.ts";

/**
 * Shape version of the throttle STATE FILE, bumped when the persisted form
 * changes.
 *
 * Deliberately NOT the same constant as the legacy record's payload version
 * (`LEGACY_THROTTLE_PAYLOAD_VERSION` in `token-store/throttle.ts`): this one
 * versions a file this module still writes and will bump, that one versions a
 * credentials record the plugin no longer writes at all. They were two
 * unrelated constants that happened to share a name and a value, which is the
 * worst kind of duplicate — bumping one "in lockstep" with the other would
 * silently orphan every parked refusal already on disk.
 */
const THROTTLE_FILE_VERSION = 1;

/**
 * Every persisted shape THIS build can read: the current version plus any
 * historical ones. Bumping {@link THROTTLE_FILE_VERSION} means adding the new
 * number here too — otherwise this build would refuse its own newest files.
 *
 * This is the ADR-006 write-side guard's whitelist, mirroring
 * `catalog-store.ts` / `provider-store.ts` / `draw-store.ts` /
 * `raccoon-switch-store.ts` (78df0d1 → 3b4aea6): an on-disk version not in
 * this list was written by a NEWER build and must not be clobbered. The throttle
 * is the one store that patch missed, because the value it carries (a parked
 * wrong-password refusal) is the one the red line says must never be lost to a
 * cross-build overwrite. It carries the guard like the other five now — and
 * unlike them it also REPORTS the refusal, because a throttle whose write
 * failed is silent until a second Host process walks into the lock.
 */
export const KNOWN_THROTTLE_VERSIONS: readonly number[] = [THROTTLE_FILE_VERSION];

/**
 * Where the throttle lives: the SHARED directory, `$DSH_HOME/state/<plugin>`.
 *
 * Deliberately NOT per-profile, even though the catalog / provider / draw
 * states are (PITFALLS §23). A throttle is not a per-profile preference, it is
 * "how long the upstream told this machine to stop knocking" — if only the
 * profile that got the 429 honoured it, the other profile's Host would resume
 * hammering the same endpoint from the same machine during the very window the
 * platform asked for. Splitting it would silently undo the whole point of the
 * throttle, and the failure only surfaces under load. Do not "make it
 * consistent" with the other three.
 * @returns {string} the directory.
 */
export function throttleDir() {
  return pluginStateDir(name);
}

/**
 * The throttle file this plugin wrote before its rename.
 *
 * Read for MIGRATION ONLY: a parked refusal — a wrong password the user has
 * not yet corrected — must survive the rename, or the next Host start would
 * retry that password automatically and walk into a lock. The old file is
 * moved into place on first contact and never written again.
 * @returns {string} the legacy file path.
 */
function legacyThrottleFile() {
  const home = str(process.env.DSH_HOME, join(homedir(), ".dsh"));
  return join(home, "state", "dsh-llm-rate-panel", "throttle.json");
}

/**
 * Parse a persisted throttle, or `null` when it is absent, stale, or foreign.
 *
 * Anything unrecognised reads as "no throttle". That is the safe direction for
 * a *time* window — the worst case is one extra attempt — and the reason the
 * caller keeps parked refusals somewhere it can still see them.
 * @param {unknown} raw - the parsed file contents.
 * @param {() => number} now - clock source.
 * @returns {{code: string, parked: boolean, until: number|null, attempt: number}|null}
 */
function parse(raw: unknown, now: () => number): HeldThrottle | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as { version?: unknown; code?: unknown; parked?: unknown; until?: unknown; attempt?: unknown };
  if (num(body.version, 0) !== THROTTLE_FILE_VERSION) return null;
  const code = str(body.code, "");
  if (code === "") return null;
  const attempt = Math.max(1, Math.floor(num(body.attempt, 1)));
  if (body.parked === true) return { code, parked: true, until: null, attempt };
  const until = num(body.until, NaN);
  // A window that has closed is no longer a reason to refuse.
  if (!Number.isFinite(until) || until <= now()) return null;
  return { code, parked: false, until, attempt };
}

/**
 * Options the file-backed throttle store accepts.
 *
 * Deliberately NOT the shared `StoreOptions`: that type carries a `profile`,
 * and the throttle is shared on purpose (see {@link throttleDir}). Naming the
 * options here keeps the "no profile" property in the type, not only in a
 * comment.
 */
export interface ThrottleStoreOptions {
  /** Directory the throttle file lives in. */
  dir?: string;
  /** Clock override for tests. */
  now?: () => number;
  /** `ctx.logger`, for the ADR-006 write-side version-guard degrade signal. */
  logger?: { warn?: (message: string) => void };
}

/**
 * A throttle store backed by one file.
 *
 * Writes are atomic — a temporary file, then a rename — because two Host
 * processes share this path: a half-written file read by the other process
 * would read as "no throttle", which for a parked refusal means an automatic
 * retry of a password the user has not changed.
 * @param {ThrottleStoreOptions} [options] - wiring.
 * @returns {{read: Function, write: Function, clear: Function}} the store.
 */
export function createFileThrottleStore(options: ThrottleStoreOptions = {}) {
  const { dir = throttleDir(), now = Date.now, logger } = options;
  const file = join(dir, "throttle.json");
  // ADR-006 write-side guard + atomic write shared via createVersionedJsonWriter
  // (state-store.ts). A refusal is NOT silent: the guard's whole contract
  // (docs/ADR.md) is that a version this build does not know is refused, the
  // reason is recorded, and the reason reaches the caller — so `onRefuse`
  // degrades through the same logger the other five stores use. (The store
  // used to omit it on the grounds that it is "deliberately logger-less"; the
  // shape test it cited pins the CALL SITE, not the absence of a signal, and
  // a throttle is the one store whose missing write is invisible until a
  // second Host process retries a password the user never fixed.)
  const writeThrottle = createVersionedJsonWriter({
    file,
    versions: KNOWN_THROTTLE_VERSIONS,
    label: "throttle",
    onRefuse: (reason) => degrade(reason, null, logger, null)
  });

  /**
   * Move a throttle written before the rename into the current location.
   *
   * Runs once: a state already at the new address wins over one at the old. The
   * old directory then holds nothing and is left to be swept with the Home.
   * @returns {Promise<void>} resolves once any legacy state is in place.
   */
  let legacyAdopted = false;
  async function adoptLegacyFile() {
    if (legacyAdopted) return;
    legacyAdopted = true;
    try {
      await ensureStateDir(dir);
    } catch {
      // A read-only Home: nothing can be moved, the current store stands.
    }
    try {
      await readFile(file, "utf8");
    } catch {
      // The current file is absent — adopt the legacy one, if there is any.
      try {
        await rename(legacyThrottleFile(), file);
      } catch {
        // No legacy file, or the move failed: the current store stands.
      }
    }
  }

  return {
    async read() {
      await adoptLegacyFile();
      // Absent, unreadable, or not JSON reads as "no throttle" (`readStateJson`
      // returns null): the safe direction for a time window.
      return parse(await readStateJson(file), now);
    },
    /**
     * Park a refusal on disk.
     *
     * Reports whether the record REACHED the disk. A caller that keeps
     * honouring the wait in memory while the disk never learned about it is
     * the failure this file exists to prevent: the whole point of the throttle
     * is that a SECOND Host process on this machine must not retry the
     * password the user has not fixed.
     * @param {HeldThrottle} state - the throttle to park.
     * @returns {Promise<boolean>} true when the record reached the disk.
     */
    async write(state: HeldThrottle) {
      await adoptLegacyFile();
      const body = {
        version: THROTTLE_FILE_VERSION,
        code: state.code,
        parked: state.parked === true,
        until: state.parked === true ? null : state.until,
        attempt: state.attempt
      };
      try {
        // `null` = written. A string = the ADR-006 guard refused the write and
        // returned its reason; `onRefuse` has already degraded that reason.
        const refusal = await writeThrottle(body);
        return refusal === null;
      } catch (error) {
        degrade("throttle: write failed", error, logger, null);
        return false;
      }
    },
    /**
     * Drop the throttle from disk.
     * @returns {Promise<boolean>} true when the file is gone (or never was).
     */
    async clear() {
      let cleared = true;
      try {
        await rm(file, { force: true });
      } catch (error) {
        // `force: true` means an absent file does NOT throw, so this is a real
        // failure: a refusal that outlives its clear parks the user forever.
        degrade("throttle: clear failed", error, logger, null);
        cleared = false;
      }
      // A legacy file that never got adopted must not resurrect the refusal it
      // holds: a cleared throttle is cleared under both names.
      try {
        await rm(legacyThrottleFile(), { force: true });
      } catch (error) {
        degrade("throttle: clear failed (legacy)", error, logger, null);
        cleared = false;
      }
      return cleared;
    }
  };
}

/**
 * A throttle store that forgets everything when the process ends.
 *
 * Used by the tests, and by a Host that can be given nothing writable. It is
 * deliberately NOT the default: the throttle exists so that a second Host
 * process does not walk into a lock the first is waiting out, which is a
 * claim about other processes and cannot be kept in memory.
 * @param {() => number} [now] - clock source.
 * @returns {{read: Function, write: Function, clear: Function}} the store.
 */
export function createMemoryThrottleStore(now = Date.now) {
  // The memory copy carries the version marker alongside the held shape; the
  // file store writes the same pair, so `parse` can read either back.
  let held: (HeldThrottle & { version: number }) | null = null;
  return {
    async read() {
      return parse(held, now);
    },
    async write(state: HeldThrottle) {
      held = { version: THROTTLE_FILE_VERSION, ...state };
      // Nothing can fail here, so the write reports success — the same shape
      // the file store reports for a write that landed.
      return true;
    },
    async clear() {
      held = null;
      return true;
    }
  };
}

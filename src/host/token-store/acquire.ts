/**
 * The single seam where the four blocks meet: `acquire()`.
 *
 * Order of operations (frozen by the behavior baseline, must NOT change):
 *   1. throttle gate — read the in-force refusal, fail fast if parked or in window
 *   2. grant freshness — read stored (or cached), return if fresh
 *   3. renewal — try the refresh token; on a rejected refresh, fork:
 *      - account still stored → fall through to login
 *      - no account → reap the dead grant and rethrow
 *   4. login fallback — log in with the stored/env account; on a new refusal,
 *      write the throttle (except `not_configured`, which records nothing)
 *
 * All block functions are injected by the caller so this module never imports
 * them directly (no circular dependency). The body is **verbatim**; the
 * behavior baseline stays green.
 *
 * @module dsh-connect-sensenova-token-plan/token-store/acquire
 */

import { obj } from "../util.ts";
import { CODE } from "../codes.ts";
import type { StoreContextWiring, TokenStoreState, StoredGrant, HeldThrottle } from "./state.ts";

/** The four block functions `acquire` needs, injected by the caller. */
export interface AcquireBlocks {
  readThrottle: () => Promise<HeldThrottle | null>;
  clearThrottle: () => Promise<void>;
  readStored: () => Promise<StoredGrant | undefined>;
  isFresh: (token: StoredGrant | null | undefined, at?: number) => boolean;
  renewWithRefresh: (stored: StoredGrant | undefined) => Promise<StoredGrant>;
  readAccount: () => Promise<{ username: string; password: string; source: string } | undefined>;
  loginFromAccount: () => Promise<StoredGrant>;
  /**
   * Remember a refusal. `null` back means "nothing was written" — the error
   * carried no code, so it was not a refusal (see `writeThrottle`'s note);
   * the caller's re-throw carries the real message and no wait is recorded.
   */
  writeThrottle: (error: unknown, previousAttempt?: number) => Promise<HeldThrottle | null>;
  throttleError: (held: HeldThrottle, cause?: Error) => Error;
  purgeGrant: (accessToken?: string) => Promise<void>;
}

/**
 * Acquire a usable token, logging in or refreshing as needed.
 *
 * @param {object} wiring - the store context wiring.
 * @param {object} state - the store context state.
 * @param {object} blocks - the four block functions, injected by the caller.
 * @returns {Promise<string>} the access token now in effect.
 */
export async function acquire(wiring: StoreContextWiring, state: TokenStoreState, blocks: AcquireBlocks): Promise<string> {
  const { now } = wiring;
  const {
    readThrottle, clearThrottle,
    readStored, isFresh,
    renewWithRefresh,
    readAccount, loginFromAccount,
    writeThrottle, throttleError, purgeGrant
  } = blocks;

  // A refused sign-in is not repeated on a timer: the platform locks an
  // account after a few bad attempts, so a poll loop that keeps trying
  // turns one mistake into a lockout. Fail fast and say why instead.
  const held = state.throttle ?? await readThrottle();
  state.throttle = held;
  if (held !== null && (held.parked || (held.until !== null && held.until > now()))) {
    throw throttleError(held);
  }
  if (held !== null) {
    // Its window closed, so the refusal may be probed again — but the attempt
    // count is kept, so the next wait is longer than this one. Clearing the
    // throttle here and forgetting the count is what made every backoff
    // silently restart at one minute.
    state.consecutiveRefusals = held.attempt;
    await clearThrottle();
  }

  const stored: StoredGrant | null | undefined = (await readStored()) ?? state.cached ?? undefined;
  // `isFresh` is declared boolean (not a type predicate) here on purpose: a
  // stale grant IS still a StoredGrant, so the predicate's false-branch
  // narrowing would wrongly exclude it. The explicit null/undefined checks do
  // the narrowing the code actually relies on.
  if (stored !== null && stored !== undefined && isFresh(stored)) {
    state.cached = stored;
    return stored.accessToken;
  }
  // Prefer renewal: it needs no password, and the password may have been
  // removed from the environment long after the first login.
  if (stored !== null && stored !== undefined && stored.refreshToken !== "") {
    try {
      const renewed = await renewWithRefresh(stored);
      return renewed.accessToken;
    } catch (error) {
      // A rejected refresh token (or a grant that never had one) is
      // unrecoverable without a password. When an account is still stored we
      // fall through and re-login; when there is none — typically right after
      // "forget account", once the live token expires — the grant is dead for
      // good, so reap it instead of leaving an ownerless pair on disk and
      // re-hitting the dead refresh on every poll.
      if (obj(error).code !== CODE.REFRESH_REJECTED && obj(error).code !== CODE.NO_REFRESH_TOKEN) throw error;
      if ((await readAccount()) === undefined) {
        await purgeGrant(stored === null || stored === undefined ? undefined : stored.accessToken);
        throw error;
      }
    }
  }
  try {
    const fresh = await loginFromAccount();
    // A sign-in that worked clears any earlier refusal: the wait is over by
    // the only evidence that matters, and the backoff starts over.
    state.consecutiveRefusals = 0;
    if (state.throttle !== null) await clearThrottle();
    return fresh.accessToken;
  } catch (error) {
    // No account is not a refusal and no request was made, so there is
    // nothing to throttle: recording one would claim the user did something
    // wrong and would keep a fresh install looking "needs user action".
    if (obj(error).code === CODE.NOT_CONFIGURED) throw error;
    // Otherwise record the refusal so the next poll does not walk into the
    // lock again. The platform's own error is what the panel shows, since it
    // carries the reason and any stated window; the throttle only governs
    // when the next attempt may happen — so the record is kept for its side
    // effect and its return value is deliberately not read.
    //
    // This used to read `throw held.parked ? error : throttleError(held, error)`,
    // which is ONE throw wearing a two-branch hat: `throttleError` returns its
    // `cause` unchanged whenever a cause is passed, so both arms handed back the
    // identical object. The ternary promised a distinction the code never made.
    //
    // `error` was thrown by `loginFromAccount` (a pluginError); the throttle
    // contract takes an Error, so the assertion is the semantic the code
    // already relies on.
    await writeThrottle(error, state.throttle?.attempt);
    throw error as Error;
  }
}

/**
 * SenseNova console token store — the seam between the credentials service and
 * the panel's console calls.
 *
 * The console JWT lives 180 minutes; this store keeps it renewed, so the
 * panel never needs the pre-store ritual of copying a fresh token out of
 * devtools into `$DSH_HOME/.env` and restarting.
 *
 * How it works:
 *
 * - The grant lives in `ctx.credentials` as a `grant` record, never on disk in
 *   this plugin and never in the environment. Writing goes through
 *   `modifyRecord`, the service's serialized read-modify-write path, so two
 *   Host processes rotating the same refresh token cannot lose one another's
 *   write.
 * - `getToken()` returns a token that is valid for at least
 *   `skewMs`, renewing through `refresh_token` when the stored one is close to
 *   expiry. Hydra rotates refresh tokens, so every renewal also replaces the
 *   stored refresh token.
 * - `invalidate()` drops the in-memory token after a 401 so the next call
 *   renews once rather than looping on a token the console already rejected.
 *
 * Sign-in is throttled, never retried on a poll timer. The platform locks an
 * account after a few bad attempts, so an automatic retry turns one mistake
 * into a lockout. Two kinds of refusal are treated differently:
 *
 * - A time-shaped one (locked, rate-limited, a platform fault) waits out a
 *   backoff — the platform's own window when it states one, otherwise a local
 *   one that doubles per attempt up to half an hour. The throttle is persisted,
 *   so a second Host process does not keep knocking during the wait.
 * - A credential-shaped one (wrong password, a captcha the user must clear) is
 *   parked outright: waiting cannot fix it, so the panel asks for the account
 *   again and only an explicit resubmit retries. This is what stops a panel
 *   left open overnight from spending an attempt every minute on a password
 *   nobody has corrected.
 *
 * Account login is a one-time bootstrap: put the account in the environment
 * (`SENSENOVA_USERNAME` / `SENSENOVA_PASSWORD`) and the store logs in on the
 * first use, then keeps itself alive from the refresh token alone. The
 * password is never persisted by this module.
 *
 * Structure: this file is the FACADE — `createTokenStore` builds the shared
 * context via `createStoreContext` (`./token-store/state.ts`) and delegates to
 * the four extracted blocks (grant / account / renewal / throttle, in
 * `./token-store/{grant,account,renewal,throttle}.ts`) plus the acquire seam
 * (`./token-store/acquire.ts`). Public API and export surface are unchanged.
 * The split doc is `docs/TOKEN-STORE-SPLIT.md`.
 *
 * @module dsh-connect-sensenova-token-plan/token-store
 */

import { CODE } from "./codes.ts";
import { str, obj, verbatim, pluginError } from "./util.ts";
import { name as RECORD_SCOPE } from "./host-config.ts";
import { createStoreContext } from "./token-store/state.ts";
import {
  readStored as readStoredImpl,
  storeGrant,
  purgeGrant as purgeGrantImpl,
  isFresh as isFreshImpl
} from "./token-store/grant.ts";
import {
  throttleError as throttleErrorImpl,
  readThrottle as readThrottleImpl,
  writeThrottle as writeThrottleImpl,
  clearThrottle as clearThrottleImpl,
  inForceWaitMs as inForceWaitMsImpl,
  DEFAULT_LOGIN_BACKOFF_MS,
  MAX_LOGIN_BACKOFF_MS
} from "./token-store/throttle.ts";
import {
  readUsername as readUsernameImpl,
  readAccount as readAccountImpl,
  loginFromAccount as loginFromAccountImpl,
  forgetAccount as forgetAccountImpl,
  USERNAME_REF,
  PASSWORD_REF
} from "./token-store/account.ts";
import { renewWithRefresh as renewWithRefreshImpl } from "./token-store/renewal.ts";
import { acquire as acquireImpl } from "./token-store/acquire.ts";

/** Record address: this plugin's own namespace, so a stranger cannot collide. */
const RECORD_ID = "sensenova-console";

/**
 * The namespace this plugin used before the rename.
 *
 * Read for MIGRATION ONLY: an account and grant saved under the old name must
 * survive the rename, or the panel would demand a fresh login and abandon a
 * refresh token that is still good. Nothing is ever written here again; each
 * legacy record is adopted once and deleted.
 */
const LEGACY_SCOPE = "dsh-llm-rate-panel";

/**
 * The reference form of a credential name.
 *
 * `@deepseek-ai/dsh-credentials` exports `credentialRef` for this, and the
 * values below are already in the form it produces — a bare variable name.
 * Spelled out here so the store's own test does not have to resolve a peer
 * package to exercise anything; the service treats a string and its branded
 * reference identically, which check 14 pins down.
 * @param {string} name - the variable name.
 * @returns {string} the reference.
 */
const credentialRef = (name) => name;

/**
 * Where the throttle used to live, as a record in the credentials service.
 *
 * Read for MIGRATION ONLY and never written again. The marker-based adoption
 * lives in `token-store/throttle.ts`; this constant stays here as the public
 * export surface (`THROTTLE_ID`).
 */
const THROTTLE_ID = "sensenova-console-throttle";

/**
 * Build the token store.
 *
 * @param {object} options - wiring.
 * @param {object|null} options.credentials - the `ctx.credentials` service, or
 *   `null` when the Host has none. A missing service must not disable the
 *   panel: everything falls back to this process's memory, so the account form
 *   still works and the token renews for as long as the Host lives. Only a
 *   restart then asks again.
 * @param {object} [options.auth] - a `createAuth()` instance; defaults to one
 *   built on the platform defaults. The Host passes its configured instance so
 *   the login flow and token refresh target the operator's endpoints, not the
 *   shipped ones.
 * @param {Function} options.credentialKey - the service's key factory, so the
 *   branded key is built by the service that owns the type.
 * @param {object} [options.env] - environment source (defaults to
 *   `process.env`); injected by the tests.
 * @param {number} [options.skewMs] - renew this long before expiry.
 * @param {object} [options.throttleStore] - where sign-in refusals are
 *   remembered; defaults to this plugin's own file, which is what lets one
 *   Host process see a lock another is waiting out. Injected by the tests.
 * @param {() => number} [options.now] - clock source; injected by the tests so
 *   a backoff window can be crossed deliberately instead of by waiting.
 * @param {function(?object[], ?(Error & {code?: unknown})): void} [options.onTrace] - called with
 *   the sanitized hop list when a sign-in attempt ENDS, success or failure;
 *   the second argument is `null` on success and the thrown error otherwise
 *   (matching the contract `sensenova-auth.ts` uses).
 * @returns the store: `getToken`, `invalidate`, `saveAccount`,
 *   `forgetAccount`, and `state`.
 */
export function createTokenStore(options) {
  const { wiring, state } = createStoreContext(options);
  const { env, backend, ephemeral } = wiring;
  const { rejected } = state;

  /** One-line delegations to the extracted blocks. */
  const readStored = () => readStoredImpl(wiring, state);
  const store = (at, rt, exp, replacing) => storeGrant(wiring, state, at, rt, exp, replacing);
  const purgeGrant = (accessToken) => purgeGrantImpl(wiring, state, accessToken);
  const isFresh = (token: any, at?: number) => isFreshImpl(wiring, state, token, at);
  const readThrottle = () => readThrottleImpl(wiring, state);
  const clearThrottle = () => clearThrottleImpl(wiring, state);
  const writeThrottle = (error: any, previousAttempt?: any) => writeThrottleImpl(wiring, state, error, previousAttempt);
  const throttleError = (held, cause) => throttleErrorImpl(held, cause);
  const inForceWaitMs = (held) => inForceWaitMsImpl(wiring, held);
  const readUsername = () => readUsernameImpl(wiring, state);
  const readAccount = () => readAccountImpl(wiring, state);
  const loginFromAccount = (explicit) => loginFromAccountImpl(wiring, state, explicit, readStored, store);
  const renewWithRefresh = (stored) => renewWithRefreshImpl(wiring, state, stored, store);
  const acquire = () => acquireImpl(wiring, state, {
    readThrottle, clearThrottle,
    readStored, isFresh,
    renewWithRefresh,
    readAccount, loginFromAccount,
    writeThrottle, throttleError, purgeGrant
  });

  return {
    /**
     * A console access token that should not be rejected for expiry.
     * @returns {Promise<string>}
     */
    async getToken() {
      if (isFresh(state.cached)) return state.cached.accessToken;
      // One acquisition in flight: a panel poll storm must not trigger a
      // login stampede or a burst of refresh-token rotations.
      state.inflight ??= acquire()
        .then((token) => {
          state.lastError = null;
          return token;
        })
        .catch((error) => {
          state.lastError = error;
          throw error;
        })
        .finally(() => {
          state.inflight = null;
        });
      return state.inflight;
    },

    /**
     * Forget the token the console just rejected, so the next call renews
     * exactly once instead of replaying a token the server already refused.
     * @param {string} [token] - the token that was refused; defaults to the
     *   cached one.
     */
    invalidate(token) {
      const refused = str(token, state.cached?.accessToken ?? "");
      if (refused !== "") {
        rejected.add(refused);
        // Bounded: only the most recent refusals can still be in play, since a
        // token that was superseded is never handed out again.
        while (rejected.size > 8) rejected.delete(rejected.values().next().value);
      }
      state.cached = null;
    },

    /**
     * Store a console account, then log in with it.
     *
     * This is what the panel's setup form calls. Only the USERNAME goes to
     * `ctx.credentials` (owner-only on disk, never in this plugin's own
     * files); the password stays in this call's closure and is gone when the
     * attempt ends. The resulting grant is what keeps the panel alive
     * afterwards, so a rejected password leaves nothing secret at rest.
     * @param {{username: string, password: string}} account - the credentials.
     * @returns {Promise<void>}
     */
    async saveAccount(account) {
      const username = str(account?.username, "");
      const password = verbatim(account?.password, "");
      if (username === "" || password.trim() === "") {
        throw pluginError(CODE.MISSING_CREDENTIALS, "a username and a password are both required");
      }
      // Persist first, then log in: if the write is rejected (a read-only
      // environment shadows the reference) the user is told before any login
      // attempt, instead of being left with a token that dies at restart.
      // The password is deliberately NOT part of the write: `SENSENOVA_PASSWORD`
      // in the environment is the only durable source (an explicit opt-in for
      // auto-recovery after a dead refresh token), so no plaintext password
      // ever sits in the credentials document.
      await backend().set(credentialRef(USERNAME_REF), username);
      // The password may differ from the one that produced the current grant.
      state.cached = null;
      rejected.clear();
      // A deliberate resubmit is the user acting on what the panel told them,
      // so it clears the throttle — otherwise a corrected password would be
      // refused by this store's own timer. It is the ONE path that does:
      // every automatic route into `acquire` is still blocked.
      await clearThrottle();
      try {
        // The typed account is handed over directly: the password lives only
        // in this closure, so the env-based `readAccount` must not be asked
        // for it here.
        await loginFromAccount({ username, password });
        // A successful manual sign-in supersedes whatever failure the panel
        // last saw. `state.lastError` is otherwise cleared only inside
        // `acquire`'s success path — which never runs while the fresh grant
        // short-circuits `getToken` — so without this line an old
        // `login_rejected` would keep the header claiming "needs login" long
        // after the account works.
        state.lastError = null;
      } catch (error) {
        // A deliberate submit is the one path allowed to spend an attempt, but
        // a REFUSED one must still be recorded. This call's caller reads
        // `state()` the moment it rejects, and with no throttle on record the
        // panel reports "no wait, nothing for the user to do" — so the next
        // poll walks straight into another attempt with the same bad password,
        // which is exactly what the park exists to prevent.
        if (obj(error).code !== CODE.NOT_CONFIGURED) await writeThrottle(error);
        throw error;
      }
    },

    /**
     * Forget the stored account.
     *
     * The grant is left alone at first: the panel keeps working on the refresh
     * token until that runs out, and only then asks for the account again. With
     * no account left to recover a dead refresh token, `acquire` also reaps the
     * expired grant then, so nothing ownerless is left behind.
     * @returns {Promise<void>}
     */
    async forgetAccount() {
      const result = await forgetAccountImpl(wiring, state);
      // Clearing the account supersedes any earlier login failure: the grant
      // (or its absence) is what the panel should read, not an old error.
      state.lastError = null;
      return result;
    },

    /**
     * A description of the store for the panel: whether a token is held, when
     * it expires, and the last failure. No secret is included.
     */
    async state() {
      const stored = await readStored();
      const account = await readAccount();
      // The stored USERNAME is the account's identity. The password is not
      // persisted (the environment is its only durable source), so whether an
      // account is present must not depend on a password being available —
      // otherwise the panel's "clear the saved account" affordance would
      // vanish the moment no env password exists.
      const username = await readUsername();
      // Read the throttle here too, so a second Host process shows the same
      // countdown rather than inviting an attempt that would be refused.
      const held = state.throttle ?? await readThrottle();
      return {
        // "configured" means the panel can get a token: either it already has
        // one, or an account is stored to obtain the next one.
        configured: stored !== undefined || account !== undefined,
        hasAccount: username !== "",
        // Whether the environment carries the auto-recovery password
        // (`SENSENOVA_PASSWORD`). A boolean ONLY — the value never leaves the
        // store: the panel uses this to say "a dead refresh token re-signs in
        // automatically (or needs a manual re-login)". Absent or blank means
        // not armed, and the next dead refresh will surface the account form.
        autoRecoverArmed: str(env[PASSWORD_REF], "") !== "",
        hasRefreshToken: str(stored?.refreshToken, "") !== "",
        expiresAt: stored?.expiresAt ?? null,
        // Why the panel should ask for an account: nothing works yet.
        needsAccount: stored === undefined && account === undefined,
        // True when the Host has no credentials service, so the account lives
        // in this process only and must be re-entered after a restart.
        ephemeral: ephemeral(),
        // While a refused sign-in is still inside its wait, the panel shows a
        // countdown rather than inviting an immediate retry. `null` when
        // nothing is being waited out.
        retryAfterMs: inForceWaitMs(held),
        // A refusal the clock cannot fix — a wrong password, or a captcha the
        // user must clear. The panel says so instead of showing a countdown
        // that would tick down to another attempt that never happens.
        needsUserAction: held !== null && held.parked,
        error: state.lastError === null ? null : state.lastError instanceof Error ? state.lastError.message : String(state.lastError)
      };
    }
  };
}

export {
  RECORD_SCOPE,
  RECORD_ID,
  LEGACY_SCOPE,
  USERNAME_REF,
  PASSWORD_REF,
  THROTTLE_ID,
  DEFAULT_LOGIN_BACKOFF_MS,
  MAX_LOGIN_BACKOFF_MS
};

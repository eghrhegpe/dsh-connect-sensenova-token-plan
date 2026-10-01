/**
 * Block 2 of the token-store split: the account lifecycle. Owns reading the
 * username/account, logging in, saving and forgetting the account, and the
 * one-time password sweep.
 *
 * No state of its own; operates on the shared context from `state.ts`.
 * `loginFromAccount` needs two grant-block operations (read the stored grant,
 * persist the new one); they are injected by the caller so this module never
 * imports `grant.ts` (no circular dependency).
 *
 * Functions moved here are **verbatim** — the behavior baseline
 * (`test/store-baseline.test.mjs`) stays green, so no semantics moved, only
 * the file did.
 *
 * @module dsh-connect-sensenova-token-plan/token-store/account
 */

import { CODE } from "../codes.ts";
import { str, verbatim, pluginError } from "../util.ts";

/**
 * The reference form of a credential name.
 *
 * `@deepseek-ai/dsh-credentials` exports `credentialRef` for this, and the
 * values below are already in the form it produces — a bare variable name.
 * Spelled out here so the store's own test does not have to resolve a peer
 * package to exercise anything; the service treats a string and its branded
 * reference identically.
 * @param {string} name - the variable name.
 * @returns {string} the reference.
 */
const credentialRef = (name) => name;

/** Where the account lives. The password is NEVER persisted. */
export const USERNAME_REF = "SENSENOVA_USERNAME";
export const PASSWORD_REF = "SENSENOVA_PASSWORD";

/**
 * The account's identity: the stored username, with the environment as a
 * fallback. Kept apart from the password because only the username is ever
 * persisted — `state()` asks "is there an account to clear?" without
 * requiring a password to be available.
 * @returns {Promise<string>} the username, or `""` when none is known.
 */
export async function readUsername(wiring, _state) {
  const { backend, env } = wiring;
  const fromStore = async (ref) => {
    // `resolve` is per-call by contract: a value written a moment ago is
    // visible to the next read, with no restart in between.
    const resolved = await backend().resolve(credentialRef(ref)).catch(() => undefined);
    return verbatim(resolved?.value, "");
  };
  return str(await fromStore(USERNAME_REF), "") || str(env[USERNAME_REF], "");
}

/**
 * The account to log in with: a stored (or environment) username and an
 * ENVIRONMENT password.
 *
 * The password is never persisted. `SENSENOVA_PASSWORD` in the environment
 * is its only durable source, and that is an explicit opt-in: without an env
 * password the panel simply asks again when the refresh token dies.
 * @returns {Promise<{username: string, password: string, source: string}|undefined>}
 */
export async function readAccount(wiring, state) {
  const { backend, env } = wiring;
  const username = await readUsername(wiring, state);
  // One-time sweep: a previous version stored the password in the
  // credentials service. The new policy keeps no password at rest, so a
  // legacy value is removed on first contact (the environment remains the
  // opt-in path). Best-effort: a read-only service keeps the old value
  // until the user re-saves, which still cannot leak it anywhere new.
  if (!state.passwordSwept) {
    state.passwordSwept = true;
    await backend().unset(credentialRef(PASSWORD_REF)).catch(() => {});
  }
  const password = verbatim(env[PASSWORD_REF], "");
  if (username === "" || password.trim() === "") return undefined;
  return { username, password, source: "env" };
}

/**
 * Log in with an account and return a self-renewing grant.
 *
 * The account is taken EXPLICITLY when the caller just typed it (the panel
 * save path: the password lives in that call's closure and is never
 * written anywhere), and read back from the environment otherwise (the
 * auto-recovery path after a dead refresh token, opt-in via
 * `SENSENOVA_PASSWORD`).
 *
 * The grant read BEFORE the sign-in is named as the one this login
 * supersedes. It has to be read first: the token pair only arrives after the
 * network walk, and naming nothing is what let a still-fresh grant from a
 * DIFFERENT account silently survive a deliberate switch — the panel said
 * "signed in" while keeping serving the previous account. Naming the read
 * grant turns the write into the same compare-and-set a refresh uses: an
 * intentional switch wins, a login racing another process's rotation defers.
 * @param {{username: string, password: string}|undefined} explicit - an account
 *   supplied by the caller (never persisted); positionally required, though
 *   `undefined` is tolerated and falls back to `readAccount`.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
 */
export async function loginFromAccount(wiring, state, explicit, readStored, store) {
  const { auth, onTrace } = wiring;
  const account = explicit ?? await readAccount(wiring, state);
  if (account === undefined) {
    throw pluginError(CODE.NOT_CONFIGURED, "no console account is configured");
  }
  const previous = await readStored();
  const result = await auth.login({ username: account.username, password: account.password }, { onTrace });
  return store(result.accessToken, result.refreshToken, result.expiresIn, previous?.accessToken);
}

/**
 * Forget the stored account.
 *
 * The grant is left alone at first: the panel keeps working on the refresh
 * token until that runs out, and only then asks for the account again. With
 * no account left to recover a dead refresh token, `acquire` also reaps the
 * expired grant then, so nothing ownerless is left behind.
 * @returns {Promise<void>}
 */
export async function forgetAccount(wiring, state) {
  const { backend } = wiring;
  await backend().unset(credentialRef(USERNAME_REF));
  await backend().unset(credentialRef(PASSWORD_REF));
  state.cached = null;
}

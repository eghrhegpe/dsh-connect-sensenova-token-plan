/**
 * One taxonomy for every failure this plugin reports.
 *
 * A code is declared ONCE here; every consumer reads THIS table rather than
 * carrying its own copy:
 *   - `sensenova-auth.ts` throws them — it folds the platform's own machine
 *     reasons onto this table via {@link IAM_REASON_CODES}, declared here;
 *   - `token-store.ts` decides which ones are credential-shaped (parked rather
 *     than timed) by reading {@link CREDENTIAL_REFUSALS}, declared here;
 *   - `snapshot-aggregate.ts` decides which ones mean "we never got a token"
 *     by reading {@link isAuthFailure}, declared here.
 * Adding a code means one new entry — credential-refusal and auth-failure are
 * both decided in this one place, so a new platform reason can no longer be
 * produced but not recognised (the three-list split used to do exactly that,
 * reporting a locked account as a generic console failure).
 *
 * @module dsh-connect-sensenova-token-plan/codes
 */

/**
 * Every failure code this plugin can produce or carry.
 *
 * The names are the wire values: they reach the panel in `body.code` and are
 * what tests and the client branch on, so they are not free to rename.
 */
export const CODE = Object.freeze({
  /**
   * A malformed endpoint override (a bad override URL, a missing JWKS key id,
   * a non-`Uint8Array` handed to `b64url`). Its wire value is `"config"`; the
   * snapshot route reports it to the panel as {@link CODE.CONFIG_ERROR}
   * (`"config_error"`) so the panel says "fix the row" rather than inviting a
   * sign-in. Never retried.
   */
  CONFIG: "config",
  /** The password-sealing key set could not be read. */
  JWKS: "jwks",
  /** The OIDC walk ended without a challenge or a code. */
  LOGIN_FLOW: "login_flow",

  /** The submitted account is empty. The user has to fix it; waiting will not. */
  MISSING_CREDENTIALS: "missing_credentials",
  /** No account has ever been entered. Not a refusal: nothing was attempted. */
  NOT_CONFIGURED: "not_configured",

  /** The platform said the account or password is wrong. */
  LOGIN_REJECTED: "login_rejected",
  /** The platform locked the account. */
  ACCOUNT_LOCKED: "account_locked",
  /** The platform rate-limited the attempt. */
  RATE_LIMITED: "rate_limited",
  /** A captcha or an SMS step only a human can complete. */
  VERIFICATION_REQUIRED: "verification_required",
  /** The platform refused without naming a reason this table knows. */
  LOGIN_FAILED: "login_failed",

  /** The token endpoint would not exchange the code. */
  TOKEN_REJECTED: "token_rejected",
  /** The refresh token is dead: only a password login can recover. */
  REFRESH_REJECTED: "refresh_rejected",
  /** The refresh call failed for any other reason (network, 5xx). */
  REFRESH_FAILED: "refresh_failed",
  /** A stored grant carries no refresh token to renew with. */
  NO_REFRESH_TOKEN: "no_refresh_token",

  /** The console refused the token twice in a row (a renewal already failed). */
  JWT_EXPIRED: "jwt_expired",
  /** No token could be obtained: an auth-shaped failure folded into one code. */
  AUTH_ERROR: "auth_error",
  /** The console call itself failed (usually transient; the next poll clears it). */
  CONSOLE_ERROR: "console_error",
  /** The plugin row is misconfigured (the panel-facing spelling of {@link CODE.CONFIG}). */
  CONFIG_ERROR: "config_error"
});

/**
 * What the platform's own machine reasons mean, keyed by their folded form.
 *
 * IAM answers with a `google.rpc.Status` envelope whose real cause sits in
 * `details[].reason` (`invalidAccountOrPassword`, `accountLocked`,
 * `tooManyAttempts`, …). Matching that code exactly — and treating the
 * substring scan in `sensenova-auth.ts` as a fallback for a reason this table
 * has not learned yet — is the difference between a reworded message and a
 * silently reclassified lockout.
 *
 * Keys are lowercased with separators removed, because the platform writes
 * camelCase while other responses spell the same reason snake_case.
 */
export const IAM_REASON_CODES = Object.freeze({
  invalidaccountorpassword: CODE.LOGIN_REJECTED,
  incorrectusernameorpassword: CODE.LOGIN_REJECTED,
  wrongusernameorpassword: CODE.LOGIN_REJECTED,
  invalidcredentials: CODE.LOGIN_REJECTED,
  incorrectpassword: CODE.LOGIN_REJECTED,
  accountlocked: CODE.ACCOUNT_LOCKED,
  accountdisabled: CODE.ACCOUNT_LOCKED,
  userlocked: CODE.ACCOUNT_LOCKED,
  toomanyattempts: CODE.RATE_LIMITED,
  ratelimitexceeded: CODE.RATE_LIMITED,
  toomanyrequests: CODE.RATE_LIMITED,
  verificationrequired: CODE.VERIFICATION_REQUIRED,
  captcharequired: CODE.VERIFICATION_REQUIRED
});

/**
 * Refusals that describe the CREDENTIAL rather than the moment.
 *
 * A wrong password does not become right by waiting, so a timer is the wrong
 * instrument for it: the panel must keep asking for an account instead of
 * quietly burning another attempt every minute. The platform's own
 * verification prompts are the same shape — the user has to do something, so
 * nothing is retried behind their back.
 *
 * `NOT_CONFIGURED` is deliberately not here. It is not a refusal at all: it
 * means no account has ever been entered, so there was never an attempt to
 * avoid repeating. Parking it would write a throttle record on every fresh
 * install and then report `needsUserAction` to a user who has done nothing
 * wrong yet.
 * @type {ReadonlySet<string>}
 */
export const CREDENTIAL_REFUSALS: ReadonlySet<string> = Object.freeze(new Set([
  CODE.LOGIN_REJECTED,
  CODE.VERIFICATION_REQUIRED
]));

/**
 * Every code that means "the plugin could not obtain a token".
 *
 * The panel says something different for these than for a console failure:
 * one is fixed by signing in, the other usually clears on the next poll. This
 * set is what keeps that distinction honest — every platform reason this table
 * folds ({@link IAM_REASON_CODES}) and every parked refusal
 * ({@link CREDENTIAL_REFUSALS}) MUST be in here, or one of them would be
 * reported as `console_error` and the user would be told the wrong thing.
 *
 * {@link CODE.CONFIG} is deliberately absent. It is thrown from inside the auth
 * walk, but it names a MISCONFIGURED row (an operator fix), not a failed token
 * acquisition — so `failureCode` maps it to {@link CODE.CONFIG_ERROR} and the
 * panel says "fix the row" instead of inviting a sign-in.
 * @type {ReadonlySet<string>}
 */
export const AUTH_FAILURE_CODES: ReadonlySet<string> = Object.freeze(new Set([
  CODE.JWKS,
  CODE.LOGIN_FLOW,
  CODE.MISSING_CREDENTIALS,
  CODE.NOT_CONFIGURED,
  CODE.LOGIN_REJECTED,
  CODE.ACCOUNT_LOCKED,
  CODE.RATE_LIMITED,
  CODE.VERIFICATION_REQUIRED,
  CODE.LOGIN_FAILED,
  CODE.TOKEN_REJECTED,
  CODE.REFRESH_REJECTED,
  CODE.REFRESH_FAILED,
  CODE.NO_REFRESH_TOKEN
]));

/**
 * Whether this failure came from getting a token rather than from calling the
 * console.
 * @param {unknown} error - the caught error.
 * @returns {boolean} true when the token could not be obtained.
 */
export function isAuthFailure(error: unknown) {
  const code = error === null || typeof error !== "object" ? undefined : (error as { code?: unknown }).code;
  return typeof code === "string" && AUTH_FAILURE_CODES.has(code);
}

/**
 * Whether this refusal is fixed by the user acting rather than by waiting.
 * @param {string} code - a {@link CODE} value.
 * @returns {boolean} true when the refusal should be parked, not timed.
 */
export function isCredentialRefusal(code: string) {
  return typeof code === "string" && CREDENTIAL_REFUSALS.has(code);
}

/**
 * Union of the wire values of {@link CODE} (e.g. `"config"`, `"login_rejected"`).
 *
 * Any module that annotates a field against this gets a compile error when it
 * misspells a code — the exact class of silent failure the three hand-copied
 * lists used to allow. This is a real `type` export, not the JSDoc `@typedef`
 * that used to sit here: in a `.ts` file JSDoc is a comment, not a type source
 * (the same trap `tsconfig.json` warns about), so the old spelling produced no
 * narrowing at all and a typo compiled clean.
 *
 * `types.ts` re-exports this rather than redeclaring it, so there is exactly
 * one definition of "a valid code" and `pluginError`'s parameter is checked
 * against it.
 */
export type CodeValue = typeof CODE[keyof typeof CODE];

/**
 * Failures that no sign-in can fix — the ones the panel must not answer with
 * the account form.
 *
 *   `config_error` — a bad endpoint override; the operator must fix it.
 *   `console_error` — the console did not answer; usually transient, and the
 *                     text must say so instead of inviting a login.
 *
 * This is the declaration; `client.js` ships its own copy
 * (`FORM_EXCLUDED_CODES`) because the browser bundle cannot import this
 * module — and `test/panel.test.mjs` asserts the two sets are equal, so the
 * copy cannot fall behind the declaration.
 */
export const NO_LOGIN_CODES = Object.freeze(new Set([
  CODE.CONFIG_ERROR,
  CODE.CONSOLE_ERROR
]));

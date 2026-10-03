/**
 * SenseNova console authentication — OIDC authorization-code login and
 * silent refresh.
 *
 * Reproduces the console's own browser login so the panel never asks you to
 * paste a JWT by hand:
 *
 *   1. `GET /oauth2/auth` with PKCE → follow redirects to the Hydra login
 *      challenge.
 *   2. Encrypt the password into a compact JWE (RSA-OAEP + A256GCM) under the
 *      platform JWKS key, and POST it to the IAM login endpoint together with
 *      that challenge. The password is never in plaintext on the wire.
 *   3. Follow the callback to the `authorization_code`.
 *   4. Exchange code + verifier for an access token (the console JWT) AND a
 *      refresh token.
 *
 * With a refresh token in hand the access token is renewable: `refresh()` is
 * the whole point of this module, because the console JWT lives only 180
 * minutes and re-pasting it used to be the panel's only recovery.
 *
 * Two behaviours are deliberate and match the platform, not the reference
 * implementation this was ported from:
 *
 * - The authorization request MUST be started on the console origin
 *   (`platform.sensenova.cn`). Hydra's CSRF cookie is bound to the entry
 *   host, so starting on the identity provider's own host leaves the cookie
 *   unreachable for the callback and the flow dies with "No CSRF value
 *   available in the session cookie".
 * - Nothing is written to disk here. The caller persists the grant through
 *   `ctx.credentials`; this module only ever holds secrets in memory.
 *
 * This is the login state machine only. The supporting concerns live beside
 * it: `auth-config.ts` (endpoint resolution and validation), `auth-trace.ts`
 * (the sanitized per-hop recorder), `auth-iam.ts` (refusal classification and
 * retry windows), `auth-walk.ts` (the hand-driven redirect walk with the
 * cookie jar) and `sensenova-crypto.ts` (JWE/PKCE/JWKS primitives).
 *
 * @module dsh-connect-sensenova-token-plan/sensenova-auth
 */

import { CODE } from "./codes.ts";
import { b64url, pkce, sealPassword } from "./sensenova-crypto.ts";
import { str, obj, verbatim, pluginError } from "./util.ts";
import { AUTH_DEFAULTS, resolveAuthConfig } from "./auth-config.ts";
import type { AuthConfig } from "./auth-config.ts";
import { createTrace } from "./auth-trace.ts";
import type { AuthTrace } from "./auth-trace.ts";
import { retryWindowMs, rejectionDetail, rejectionCode } from "./auth-iam.ts";
import { httpGet, paramOf, followUntil, cookieHeader, collectCookies } from "./auth-walk.ts";

// The JWE/PKCE/JWKS primitives now live in sensenova-crypto.ts, so this module
// carries no module-level crypto state (no shared JWKS cache, no global key id).
// Re-export the JWT read helpers the store still imports from here.
export { readJwtClaims, readJwtExpiry } from "./sensenova-crypto.ts";

// The auth configuration is no longer module-level mutable state. Each
// `createAuth` call resolves its own frozen config from `AUTH_DEFAULTS` plus the
// operator's overrides, so two Host processes (or two tests) can target
// different tenants without sharing one global — the original design's
// hidden-state trap. The config flows through as an explicit `cfg` argument to
// every function that needs it, never as a captured module variable.

/**
 * Build a self-contained auth instance.
 *
 * Each instance owns its endpoints, OAuth parameters, timeouts and the JWKS
 * cache key it seals under — there is no module-level mutable state to leak
 * across tenants or tests. Construct one per Host (from `settings.auth`) or per
 * test, and hand it to `createTokenStore`.
 * @param {object} [overrides] - platform overrides; see {@link resolveAuthConfig}.
 * @returns {{login: Function, refresh: Function, getConfig: Function}} the instance.
 */
export function createAuth(overrides: object = {}) {
  const cfg = resolveAuthConfig(overrides);
  return {
    /** Log in with an account password; see {@link loginWith}. */
    login(credentials: { username: string; password: string }, options?: object) { return loginWith(cfg, credentials, options); },
    /** Renew a refresh token; see {@link refreshWith}. */
    refresh(token: string, options?: object) { return refreshWith(cfg, token, options); },
    /** The effective configuration, as a copy. */
    getConfig() { return { ...cfg }; }
  };
}

/**
 * Exchange a token-grant response for the fields the panel cares about.
 * @param {Response|{status: number, jsonText: string}} response - the token
 *   endpoint's response, or `{status, jsonText}` when the body was already
 *   consumed for the trace and is handed over parsed-once.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number, scope: string}>}
 */
async function readTokenResponse(response: { status: number; jsonText?: string; json?: () => Promise<unknown> }, cfg: AuthConfig): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const status = typeof response.status === "number" ? response.status : 0;
  const body = obj(response.jsonText !== undefined
    ? (() => { try { return JSON.parse(response.jsonText as string); } catch { return {}; } })()
    : await (response as { json: () => Promise<unknown> }).json().catch(() => ({})));
  const accessToken = str(body.access_token, "");
  if (accessToken === "") {
    const detail = str(body.error_description, str(body.error, `HTTP ${status}`));
    throw pluginError(CODE.TOKEN_REJECTED, `token endpoint did not return an access token: ${detail}`);
  }
  return {
    accessToken,
    refreshToken: str(body.refresh_token, ""),
    expiresIn: Number.isFinite(Number(body.expires_in))
      ? Number(body.expires_in)
      : cfg.assumedTokenLifetimeSeconds,
    scope: str(body.scope, cfg.scope)
  };
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * This is the call that removes the 3-hour manual re-login: the panel calls
 * it on demand, and the rotated refresh token is returned so the caller can
 * replace the stored one. Hydra rotates refresh tokens, so a caller that
 * ignores the new one will find the old one dead on the next refresh.
 * @param {string} refreshToken - the stored refresh token.
 * @param {object} [options] - request options.
 * @param {number} [options.timeoutMs] - deadline override.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number, scope: string}>}
 */
export async function refreshWith(cfg: AuthConfig, refreshToken: string, options: { timeoutMs?: number } = {}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const token = str(refreshToken, "");
  if (token === "") throw pluginError(CODE.NO_REFRESH_TOKEN, "no refresh token is stored");
  const response = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": cfg.userAgent,
      accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token,
      client_id: cfg.clientId,
      scope: cfg.scope
    }).toString(),
    signal: AbortSignal.timeout(options.timeoutMs ?? cfg.requestTimeoutMs)
  });
  if (!response.ok) {
    const body = obj(await response.json().catch(() => ({})));
    // Only `invalid_grant` means the refresh token itself is dead (revoked,
    // reused, or expired) and only a password login can recover. Any other 400
    // (invalid_client, invalid_scope, a malformed request — an operator typo in
    // the overrides lands here) says nothing about the token. Treating every 400
    // as a dead token is DESTRUCTIVE: the caller's REFRESH_REJECTED path
    // purges the stored grant (token-store/grant.ts purgeGrant) and deletes a
    // perfectly healthy token pair.
    const dead = response.status === 400 && str(body.error, "") === "invalid_grant";
    const detail = str(body.error_description, str(body.error, `HTTP ${response.status}`));
    throw pluginError(dead ? CODE.REFRESH_REJECTED : CODE.REFRESH_FAILED, `refresh rejected (HTTP ${response.status}): ${detail}`);
  }
  return readTokenResponse(response, cfg);
}

/**
 * Log in with an account password and return a usable grant.
 *
 * @param {object} credentials - the account.
 * @param {string} credentials.username - the console account.
 * @param {string} credentials.password - its password.
 * @param {object} [options] - request options.
 * @param {number} [options.timeoutMs] - deadline override.
 * @param {function(?object[], ?(Error & {code?: unknown})): void} [options.onTrace] - called with the
 *   sanitized hop list when the attempt ENDS, success or failure; the second
 *   argument is `null` on success and the thrown error otherwise. A success
 *   throws nothing to carry a trace on, so this is the only way one is ever
 *   recorded — and a success trace is the half that makes a failing one
 *   readable, since "the browser works but this does not" is answered by
 *   diffing the two.
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number, scope: string}>}
 *   the access token (the console JWT), the refresh token when the platform
 *   issued one, and the access token lifetime in seconds.
 */
export async function loginWith(cfg: AuthConfig, credentials: { username: string; password: string }, options: { timeoutMs?: number; onTrace?: (trace: unknown, error: unknown) => void } = {}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  /** Run one attempt; every exit — success included — reports its trace. */
  const attempt = async () => {
    const trace = createTrace();
    try {
      const granted = await performLogin(credentials, options, trace, cfg);
      // A success throws nothing, so this is the only chance to report it.
      // Without it the caller keeps only the failures, and the comparison that
      // makes a failure diagnosable — a working walk next to a broken one —
      // is impossible.
      try { options.onTrace?.(trace.done(), null); } catch { /* logging never breaks flow */ }
      return granted;
    } catch (e) {
      // A failure that bypassed the flow's own `fail()` (a crypto error, a
      // network timeout mid-walk) still owes the caller its trace. The shape
      // is the optional `trace` field pluginError's contract documents
      // (types.PluginError) — a non-pluginError throw gets the field attached
      // right here, which is the whole point of this block.
      const error = e as Error & { code?: unknown; trace?: object[] };
      if (error?.trace === undefined) {
        try { error.trace = trace.done(); } catch { /* ignore */ }
      }
      try { options.onTrace?.(error.trace, error); } catch { /* logging never breaks flow */ }
      throw error;
    }
  };
  return attempt();
}

/**
 * Step 1 — start the OIDC walk on the console origin and follow it to the
 * Hydra `login_challenge`. Returns the challenge URL (or `""` when the walk
 * ends without one). The CSRF cookie is bound to the entry host, so the walk
 * MUST begin on `consoleOrigin` (see the module header for the failure mode
 * when it does not).
 * @param {object} cfg - resolved auth config.
 * @param {Map<string,string>} jar - cookie jar, mutated with every `set-cookie`.
 * @param {{ step: (name: string, info?: object) => void }} [trace]
 * @param {string} challenge - the PKCE S256 challenge from step 0.
 * @param {string} nonce - the state nonce issued for this flow.
 * @returns {Promise<string>} the challenge URL, or `""`.
 */
async function obtainLoginChallenge(cfg: AuthConfig, jar: Map<string, string>, trace: AuthTrace, challenge: string, nonce: string): Promise<string> {
  const authUrl = new URL(cfg.authEndpoint);
  authUrl.search = new URLSearchParams({
    client_id: cfg.clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: cfg.scope,
    state: nonce
  }).toString();
  const first = await httpGet(authUrl.href, {}, cfg);
  collectCookies(first, jar);
  trace.step("authorize", {
    url: authUrl.href,
    status: first.status,
    location: first.headers.get("location"),
    note: "GET the authorization endpoint (starting on the console origin: the CSRF cookie is bound to this host)"
  });
  return followUntil(
    str(first.headers.get("location"), authUrl.href),
    /[?&]login_challenge=/,
    jar,
    cfg,
    trace
  );
}

/**
 * Step 2 — seal the password (RSA-OAEP + A256GCM under the platform JWKS key)
 * and POST it to IAM with the challenge. Returns the callback redirect URL, or
 * throws a classified refusal carrying the platform's own retry window.
 * @param {object} cfg - resolved auth config.
 * @param {Map<string,string>} jar - cookie jar (carries the CSRF cookie).
 * @param {{ step: (name: string, info?: object) => void }} [trace]
 * @param {string} loginChallenge - the Hydra challenge from step 1.
 * @param {string} secret - the verbatim password (never trimmed).
 * @param {(code: string, message: string, extra?: object) => Error} fail - trace-tagged error factory.
 * @param {number} [deadline] - request deadline override (ms).
 * @returns {Promise<string>} the IAM callback redirect.
 */
async function postIamLogin(cfg: AuthConfig, jar: Map<string, string>, trace: AuthTrace, loginChallenge: string, user: string, secret: string, fail: (code: import("./codes.ts").CodeValue, message: string, extra?: object) => Error, deadline: number): Promise<string> {
  const encrypted = await sealPassword(secret, { jwksEndpoint: cfg.jwksEndpoint, encKeyId: cfg.encKeyId, cache: cfg.jwksCache });
  const iamUrl = `${cfg.iamOrigin}/iam/authn/v1/auth/nova/login`;
  const iamResponse = await fetch(iamUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": cfg.userAgent,
      accept: "application/json",
      origin: cfg.consoleOrigin,
      referer: `${cfg.consoleOrigin}/`,
      cookie: cookieHeader(jar)
    },
    body: JSON.stringify({
      username: user,
      password: encrypted,
      challenge: loginChallenge,
      is_encrypt: true
    }),
    signal: AbortSignal.timeout(deadline ?? cfg.requestTimeoutMs)
  });
  const iamText = await iamResponse.text();
  const iamBody = obj((() => { try { return JSON.parse(iamText); } catch { return {}; } })());
  trace.step("iam-login", {
    url: iamUrl,
    status: iamResponse.status,
    note: str(iamBody.redirect, "") !== "" ? "IAM returned a callback redirect" : "IAM returned no redirect",
    body: iamText
  });
  const redirect = str(iamBody.redirect, "");
  if (!iamResponse.ok || redirect === "") {
    const code = rejectionCode(iamBody);
    const detail = rejectionDetail(iamBody, iamResponse.status);
    throw fail(code, `login failed: ${detail}`, {
      // Carry the platform's own retry window so a caller can stop instead of
      // re-attempting into a lockout.
      retryAfterMs: retryWindowMs(iamBody, iamResponse),
      // The platform's own words, kept apart from the wrapper sentence so the
      // panel can show the classified line AND the original detail.
      detail
    });
  }
  return redirect;
}

/**
 * Step 3 — walk the IAM callback to the authorization `code` and verify the
 * round-tripped `state` nonce. Throws `LOGIN_FLOW` on a missing code or a
 * state mismatch (the latter is the second half of the PKCE binding — a code
 * from a flow this process did not start must not be exchanged).
 * @param {object} cfg - resolved auth config.
 * @param {Map<string,string>} jar - cookie jar.
 * @param {{ step: (name: string, info?: object) => void }} [trace]
 * @param {string} redirect - the IAM callback URL from step 2.
 * @param {string} expectedState - the nonce issued in step 1.
 * @param {(code: string, message: string, extra?: object) => Error} fail - trace-tagged error factory.
 * @returns {Promise<string>} the authorization code.
 */
async function obtainAuthCode(cfg: AuthConfig, jar: Map<string, string>, trace: AuthTrace, redirect: string, expectedState: string, fail: (code: import("./codes.ts").CodeValue, message: string, extra?: object) => Error): Promise<string> {
  const codeUrl = await followUntil(redirect, /[?&]code=/, jar, cfg, trace);
  const code = paramOf(codeUrl, "code");
  if (code === "") {
    trace.step("callback", { url: redirect, note: "walk ended without an authorization code" });
    throw fail(CODE.LOGIN_FLOW, "could not obtain an authorization code from the callback");
  }
  const callbackState = paramOf(codeUrl, "state");
  if (callbackState !== expectedState) {
    trace.step("callback-state", { url: codeUrl, note: `state mismatch (expected ${expectedState.slice(0, 8)}…, got ${callbackState.slice(0, 8)}…)` });
    throw fail(CODE.LOGIN_FLOW, "callback state did not match the issued nonce");
  }
  return code;
}

/**
 * Step 4 — trade code + verifier for the token pair. Throws `TOKEN_REJECTED`
 * when the endpoint refuses, else returns the parsed grant.
 * @param {object} cfg - resolved auth config.
 * @param {{ step: (name: string, info?: object) => void }} [trace]
 * @param {string} code - the authorization code from step 3.
 * @param {string} verifier - the PKCE verifier matching step 1's challenge.
 * @param {(code: string, message: string, extra?: object) => Error} fail - trace-tagged error factory.
 * @param {number} [deadline] - request deadline override (ms).
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number, scope: string}>}
 */
async function exchangeCodeForToken(cfg: AuthConfig, trace: AuthTrace, code: string, verifier: string, fail: (code: import("./codes.ts").CodeValue, message: string, extra?: object) => Error, deadline: number): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const tokenResponse = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": cfg.userAgent,
      accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      scope: cfg.scope
    }).toString(),
    signal: AbortSignal.timeout(deadline ?? cfg.requestTimeoutMs)
  });
  const tokenText = await tokenResponse.text();
  trace.step("token-exchange", {
    url: cfg.tokenEndpoint,
    status: tokenResponse.status,
    note: tokenResponse.ok ? "token pair granted" : "token endpoint refused the exchange",
    body: tokenText
  });
  if (!tokenResponse.ok) {
    const body = obj((() => { try { return JSON.parse(tokenText); } catch { return {}; } })());
    const detail = str(body.error_description, str(body.error, `HTTP ${tokenResponse.status}`));
    throw fail(CODE.TOKEN_REJECTED, `token exchange failed: ${detail}`);
  }
  return readTokenResponse({ status: tokenResponse.status, jsonText: tokenText }, cfg);
}

/**
 * The login flow proper. Throws with `error.trace` attached on every exit;
 * `login` wraps this so even out-of-band failures carry the trace.
 */
async function performLogin({ username, password }: { username: string; password: string }, options: { timeoutMs?: number }, trace: AuthTrace, cfg: AuthConfig): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const deadline = options.timeoutMs ?? cfg.requestTimeoutMs;
  // The username is trimmed (an identifier), the password is not (a secret).
  const user = str(username, "");
  const secret = verbatim(password, "");
  if (user === "" || secret.trim() === "") throw pluginError(CODE.MISSING_CREDENTIALS, "username and password are required");

  const fail = (code: import("./codes.ts").CodeValue, message: string, extra: object = {}) => {
    const error = pluginError(code, message, extra);
    error.trace = trace.done();
    return error;
  };

  const jar = new Map();
  const pkcePair = await pkce();
  // Uint8Array, not Uint32Array: see sensenova-crypto.ts `b64url` — a wider
  // element type is encoded one byte per element, which quietly produced an
  // 8-character state.
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));

  const challengeUrl = await obtainLoginChallenge(cfg, jar, trace, pkcePair.challenge, nonce);
  const loginChallenge = paramOf(challengeUrl, "login_challenge");
  if (loginChallenge === "") {
    trace.step("challenge", { note: "walk ended without a login_challenge" });
    throw fail(CODE.LOGIN_FLOW, "could not obtain a login challenge from the authorization endpoint");
  }

  const redirect = await postIamLogin(cfg, jar, trace, loginChallenge, user, secret, fail, deadline);
  const code = await obtainAuthCode(cfg, jar, trace, redirect, nonce, fail);
  return exchangeCodeForToken(cfg, trace, code, pkcePair.verifier, fail, deadline);
}

export { AUTH_DEFAULTS };
export type { AuthConfig };

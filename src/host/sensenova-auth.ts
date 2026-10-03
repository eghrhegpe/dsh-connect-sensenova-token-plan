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
 * @module dsh-connect-sensenova-token-plan/sensenova-auth
 */

import { CODE, IAM_REASON_CODES } from "./codes.ts";
import { b64url, pkce, sealPassword, createJwksCache } from "./sensenova-crypto.ts";
import { str, obj, num, verbatim, pluginError } from "./util.ts";

// The JWE/PKCE/JWKS primitives now live in sensenova-crypto.ts, so this module
// carries no module-level crypto state (no shared JWKS cache, no global key id).
// Re-export the JWT read helpers the store still imports from here.
export { readJwtClaims, readJwtExpiry } from "./sensenova-crypto.ts";

/**
 * The platform's public defaults — every value here is an override point, not a
 * law of nature.
 *
 * These used to be frozen `const`s, which made pointing the panel at another
 * console host (an enterprise mirror, a staging tenant) a code change plus a
 * republish. {@link createAuth} lets the Host half pass them in from its own
 * settings; the values below stay the defaults, so an unconfigured panel
 * behaves exactly as it did before, and each instance keeps its own copy so two
 * tenants never share one global.
 */
const AUTH_DEFAULTS = Object.freeze({
  consoleOrigin: "https://platform.sensenova.cn",
  iamOrigin: "https://iam.sensecoreapi.cn",
  tokenEndpoint: "https://signin.sensecore.cn/oauth2/token",
  jwksEndpoint: "https://signin.sensecore.cn/.well-known/jwks.json",
  clientId: "nova",
  scope: "openid offline offline_access",
  encKeyId: "public:hydra.openid.id-token",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  requestTimeoutMs: 20_000,
  maxHops: 6,
  /** Used only when the token endpoint omits `expires_in`; the console JWT lives 180 min. */
  assumedTokenLifetimeSeconds: 10_800
});

// The auth configuration is no longer module-level mutable state. Each
// `createAuth` call resolves its own frozen config from `AUTH_DEFAULTS` plus the
// operator's overrides, so two Host processes (or two tests) can target
// different tenants without sharing one global — the original design's
// hidden-state trap. The config flows through as an explicit `cfg` argument to
// every function that needs it, never as a captured module variable.

/** Read a non-empty string, else `undefined`, so a bad override is skipped. */
function optionalStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Read a finite positive number, else `undefined`. */
function optionalNum(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** Whether a host is loopback — the only place plain http is tolerable. */
function isLoopback(hostname: string): boolean {
  // Strip IPv6 brackets (`[::1]`) before comparing; the e2e fake platform
  // serves `http://127.0.0.1`, and plain http has no man-in-the-middle
  // corridor on the loopback interface itself.
  const host = String(hostname ?? "").replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Reject an endpoint that is not an absolute https URL.
 *
 * https is mandatory for any non-loopback host: the token endpoint answers
 * with the LIVE access/refresh pair in plaintext, so a typo'd `http://` for a
 * real host quietly downgrades the session credentials to cleartext. The
 * loopback exception keeps the e2e fake platform (http://127.0.0.1) reachable.
 */
function checkEndpoint(value: unknown, field: string): string {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw pluginError(CODE.CONFIG, `${field} is not an absolute URL: ${value}`);
  }
  if (parsed.protocol !== "https:") {
    if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) return String(value);
    throw pluginError(CODE.CONFIG, `${field} must be https (plain http is allowed only for loopback, e.g. the e2e fake platform), got ${parsed.protocol}//${parsed.host}`);
  }
  return String(value);
}

/**
 * Resolve the platform endpoints and OAuth parameters into a frozen config.
 *
 * Unknown keys are ignored and malformed values throw rather than being
 * trusted: these strings end up in the URLs that carry a sealed password, so a
 * typo has to fail loudly instead of quietly aiming the login flow at another
 * host. The result is frozen, so a caller that keeps it cannot mutate the
 * instance's behaviour out from under it.
 * @param {object} [overrides] - values to apply; absent keys keep their default.
 * @returns {object} the effective configuration (frozen).
 */
function resolveAuthConfig(overrides: object = {}): AuthConfig {
  const source = obj(overrides);
  const pick = (key: string, fallback: unknown, isNumber: boolean): unknown => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) return fallback;
    const value = isNumber ? optionalNum(source[key]) : optionalStr(source[key]);
    return value === undefined ? fallback : value;
  };
  const consoleOrigin = checkEndpoint(pick("consoleOrigin", AUTH_DEFAULTS.consoleOrigin, false), "consoleOrigin");
  return Object.freeze({
    consoleOrigin,
    iamOrigin: checkEndpoint(pick("iamOrigin", AUTH_DEFAULTS.iamOrigin, false), "iamOrigin"),
    authEndpoint: `${consoleOrigin}/oauth2/auth`,
    tokenEndpoint: checkEndpoint(pick("tokenEndpoint", AUTH_DEFAULTS.tokenEndpoint, false), "tokenEndpoint"),
    jwksEndpoint: checkEndpoint(pick("jwksEndpoint", AUTH_DEFAULTS.jwksEndpoint, false), "jwksEndpoint"),
    clientId: str(pick("clientId", AUTH_DEFAULTS.clientId, false), AUTH_DEFAULTS.clientId),
    scope: str(pick("scope", AUTH_DEFAULTS.scope, false), AUTH_DEFAULTS.scope),
    encKeyId: str(pick("encKeyId", AUTH_DEFAULTS.encKeyId, false), AUTH_DEFAULTS.encKeyId),
    userAgent: str(pick("userAgent", AUTH_DEFAULTS.userAgent, false), AUTH_DEFAULTS.userAgent),
    redirectUri: checkEndpoint(pick("redirectUri", consoleOrigin, false), "redirectUri"),
    requestTimeoutMs: num(pick("requestTimeoutMs", AUTH_DEFAULTS.requestTimeoutMs, true), AUTH_DEFAULTS.requestTimeoutMs),
    maxHops: num(pick("maxHops", AUTH_DEFAULTS.maxHops, true), AUTH_DEFAULTS.maxHops),
    assumedTokenLifetimeSeconds: num(
      pick("assumedTokenLifetimeSeconds", AUTH_DEFAULTS.assumedTokenLifetimeSeconds, true),
      AUTH_DEFAULTS.assumedTokenLifetimeSeconds
    ),
    // The key-set cache this instance seals through. Built here so it is owned
    // by the config, not by the module: two instances (two tenants, or a test
    // next to production) cannot see each other's cached JWKS. Frozen with the
    // rest of cfg — freezing the object does not freeze the Map's contents, but
    // nothing here mutates the reference, only what lives inside it.
    jwksCache: createJwksCache()
  } as AuthConfig);
}

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

// ============================================================================
// Login trace — the difference between debugging a failed sign-in and guessing.
//
// The Python reference implementation writes a diagnostic file on every failure
// (each hop's URL, status, response snippet); without it a "browser works but
// this does not" report is undebuggable. This module does the same, with one
// gate the reference lacks: every recorded value passes `sanitizeTraceValue`,
// so no password, token, cookie, or authorization code reaches the log.
// Traces are returned on thrown errors (`error.trace`) for the caller to
// persist — this module stays free of filesystem and Host dependencies.
// ============================================================================

/** Response-body keys whose value is a secret and must never be logged. */
const SECRET_BODY_KEYS = new Set([
  "password", "access_token", "refresh_token", "id_token", "jwt",
  "authorization", "cookie", "set-cookie", "code_verifier"
]);

/** URL query parameters that carry a one-time secret. */
const SECRET_URL_PARAMS = new Set([
  "code", "login_challenge", "code_challenge", "code_verifier",
  "access_token", "refresh_token", "session_state"
]);

/** Longest sanitized response snippet kept per hop. */
const TRACE_SNIPPET_MAX = 2000;

/** Cap on total hops recorded, mirroring the redirect budget. */
const TRACE_MAX_HOPS = 12;

/**
 * Strip every secret from a URL for the record: query parameters that carry
 * one-time credentials have their VALUE replaced with `[REDACTED]` (the
 * parameter name stays, so the record still shows which one the platform
 * redirected with) — their presence is logged, their value is not.
 * @param {string} url - any URL.
 * @returns {string} the redacted URL, or the input when it does not parse.
 */
function sanitizeUrl(url: string): string {
  const raw = str(url, "");
  if (raw === "") return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    // Not a parseable URL: log it truncated and bare — a stray fragment is
    // more useful for diagnosis than nothing.
    return raw.slice(0, 200);
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (SECRET_URL_PARAMS.has(name.toLowerCase())) {
      parsed.searchParams.set(name, "[REDACTED]");
    }
  }
  return parsed.href;
}

/** The resolved auth configuration every flow function walks with. */
export interface AuthConfig {
  consoleOrigin: string;
  iamOrigin: string;
  authEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  clientId: string;
  scope: string;
  encKeyId: string;
  userAgent: string;
  redirectUri: string;
  requestTimeoutMs: number;
  maxHops: number;
  assumedTokenLifetimeSeconds: number;
  jwksCache: unknown;
}

/** The trace recorder the walk functions receive. */
interface AuthTrace {
  step(name: string, info?: Record<string, unknown>): void;
  done(): unknown[];
}

/**
 * Reduce a response body to a log-safe snippet.
 * @param {string} text - the raw body text (may be JSON, HTML, or nothing).
 * @returns {string} a sanitized, length-capped snippet.
 */
function sanitizeBody(text: unknown): string {
  const raw = str(text, "");
  if (raw === "") return "";
  let body = raw;
  // JSON first: redact the value of every secret key in place.
  try {
    const parsed = JSON.parse(raw);
    const scrub = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(scrub);
      if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
          out[key] = SECRET_BODY_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : scrub(item);
        }
        return out;
      }
      // A VALUE can hold a secret under an innocent key. IAM answers a form
      // post with a `redirect`, and its query carries `code` and
      // `login_challenge` — a name-keyed scrub leaves both in the file.
      if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
        return sanitizeUrl(value);
      }
      return value;
    };
    body = JSON.stringify(scrub(parsed));
  } catch {
    // Not JSON: redact the request-shaped secret patterns we know of.
    body = raw
      .replace(/("password"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
      // Any `name=secret` pair in the text, not only inside a parseable URL:
      // an HTML form or a redirect header puts them in plain sight.
      .replace(new RegExp(`\\b(${[...SECRET_URL_PARAMS].join("|")})=([^&\\s"']+)`, "gi"), "$1=[REDACTED]");
  }
  return body.slice(0, TRACE_SNIPPET_MAX);
}

/**
 * Create a fresh login trace for one sign-in attempt.
 * @returns {{hops: object[], step(name, info): void, done(): object[]}}
 */
function createTrace() {
  // Element type declared: `hops.push({...})` below is otherwise a push onto
  // `never[]` under strictNullChecks (the literal infers `never[]` with
  // `noImplicitAny` off). The hop shape is documented on `step`.
  const hops: any[] = [];
  return {
    hops,
    /** Record one hop; never throws — logging must not break the flow. */
    step(name: string, info: any = {}) {
      if (hops.length >= TRACE_MAX_HOPS) return;
      try {
        hops.push({
          step: name,
          at: new Date().toISOString(),
          url: sanitizeUrl(info.url),
          status: typeof info.status === "number" ? info.status : null,
          location: info.location !== undefined ? sanitizeUrl(info.location) : undefined,
          note: str(info.note, "") !== "" ? str(info.note, "") : undefined,
          body: info.body !== undefined ? sanitizeBody(info.body) : undefined
        });
      } catch {
        // A broken recorder must not break a working login.
      }
    },
    done() {
      return hops;
    }
  };
}



/**
 * How long the platform says to wait before trying again, in milliseconds.
 *
 * Two places carry it: a standard `Retry-After` header, and prose in the
 * message ("try again after 8 minutes"). Honouring it is the difference
 * between waiting out a lockout and extending one with every poll.
 *
 * RFC 7231 §7.1.3 lets `Retry-After` be either a delta-seconds integer OR an
 * HTTP-date. The platform docs only mention the seconds form, but a future
 * date must still be honoured: `Number("Wed, 21 Oct 2026 ...")` is `NaN`, and
 * letting that fall through to a guess would re-probe a lock the platform has
 * told us to back off until — so a date-shaped header is parsed and returned
 * as the wait until then.
 *
 * The prose is matched in both languages the platform uses, because a window
 * that goes unread becomes a refusal with no stated deadline — which falls
 * back to a local backoff and so probes a lock that is still in force.
 * @param {object} body - the parsed IAM response.
 * @param {Response} response - the IAM response, for its headers.
 * @returns {number|undefined} the wait, or `undefined` when none is stated.
 */
function retryWindowMs(body: unknown, response: { status?: number; headers?: { get?: (name: string) => string | null } }): number | undefined {
  // A Retry-After in seconds is the authoritative form when present.
  const header = response?.headers?.get?.("retry-after");
  const headerSeconds = Number(header);
  if (typeof header === "string" && Number.isFinite(headerSeconds) && headerSeconds > 0) {
    return Math.ceil(headerSeconds * 1000);
  }
  // An HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT") is the other RFC 7231 form.
  // A past or unparseable date yields no wait; a future one does.
  if (typeof header === "string") {
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - Date.now();
      if (delta > 0) return delta;
    }
  }

  // Otherwise read the duration out of the human message.
  const text = `${str(obj(body).message, "")} ${rejectionDetail(body, response?.status ?? 0)}`;
  const match = /(\d+(?:\.\d+)?)\s*(second|sec|minute|min|hour|hr|秒|分钟|小时|时|分)/i.exec(text);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return amount * durationFactorMs(match[2] ?? "");
}

/**
 * The length of one time unit, in either language.
 *
 * Minutes is the reading for a bare `分`, because a lockout measured in
 * minutes is common and a coinage measured in minutes is not: reading it as
 * seconds would under-wait and re-probe the lock.
 * @param {string} unit - the matched unit.
 * @returns {number} milliseconds.
 */
function durationFactorMs(unit: string): number {
  if (/^h/i.test(unit) || unit.includes("小时") || unit === "时") return 3_600_000;
  if (/^m/i.test(unit) || unit.includes("分")) return 60_000;
  return 1000;
}

/**
 * One `fetch` with the console's headers and a deadline, returning the raw
 * response so redirect handling stays with the caller.
 * @param {string} url - absolute URL.
 * @param {RequestInit & {timeoutMs?: number}} init - fetch options.
 * @returns {Promise<Response>}
 */
async function httpGet(url: string, init: RequestInit & { timeoutMs?: number } = {}, cfg: any) {
  const { timeoutMs = cfg.requestTimeoutMs, ...rest } = init;
  return fetch(url, {
    ...rest,
    redirect: "manual",
    headers: { "user-agent": cfg.userAgent, accept: "*/*", ...obj(rest.headers) },
    signal: AbortSignal.timeout(timeoutMs)
  });
}

/**
 * Dig a query parameter out of a URL, decoded.
 *
 * (The password-sealing JWE lives in `sensenova-crypto.ts` — `sealPassword` —
 * with the PKCE and JWKS primitives this module no longer carries.)
 * @param {string} url - any URL.
 * @param {string} name - the parameter to read.
 * @returns {string} the value, or `""` when absent.
 */
function paramOf(url: string, name: string): string {
  try {
    return new URL(url).searchParams.get(name) ?? "";
  } catch {
    return "";
  }
}

/**
 * Look for the next hop inside a 200 body.
 *
 * The console renders some transitions client-side, so a `Location` header is
 * not always there. Scan for an absolute URL carrying the wanted parameter,
 * then fall back to a meta refresh and the usual JS redirects.
 * @param {string} body - the response text.
 * @param {RegExp} wanted - matches the parameter that marks a hit.
 * @returns {string} the next URL, or `""` when the body carries none.
 */
function nextFromBody(body: string, wanted: RegExp): string {
  const text = str(body, "");
  if (text === "") return "";
  const absolute = /https?:\/\/[^"'\s<>]+[?&][^"'\s<>]*/g;
  for (const match of text.matchAll(absolute)) {
    if (wanted.test(match[0])) return match[0];
  }
  const meta = /<meta[^>]+http-equiv=["']refresh["'][^>]+url=["']([^"']+)/i.exec(text);
  if (meta !== null) return meta[1] ?? "";
  for (const pattern of [
    /window\.location\.replace\(["']([^"']+)["']/,
    /window\.location\.href\s*=\s*["']([^"']+)["']/,
    /location\.href\s*=\s*["']([^"']+)["']/,
    /window\.location\s*=\s*["']([^"']+)["']/
  ]) {
    const found = pattern.exec(text);
    if (found !== null) return found[1] ?? "";
  }
  return "";
}

/**
 * Walk a redirect chain by hand until `wanted` appears in a URL.
 *
 * `fetch` cannot follow this: the chain crosses hosts and the CSRF cookie
 * must ride along, which needs one jar across the whole walk.
 * @param {string} start - the first URL.
 * @param {RegExp} wanted - what marks the destination.
 * @param {Map<string, string>} jar - cookies collected along the way.
 * @param {object} cfg - resolved auth config; `cfg.maxHops` is the hop budget.
 * @param {{ step: (name: string, info?: object) => void }} [trace] - the trace
 *   recorder; when present every hop is logged and the terminal body is scanned
 *   for the next hop from the response text.
 * @returns {Promise<string>} the matching URL, or `""` when the chain ends first.
 */
async function followUntil(start: string, wanted: RegExp, jar: Map<string, string>, cfg: AuthConfig, trace?: AuthTrace): Promise<string> {
  const budget = cfg.maxHops;
  let location = start;
  for (let hop = 0; hop < budget && location !== ""; hop += 1) {
    if (wanted.test(location)) return location;
    const response = await httpGet(location, {
      headers: { cookie: cookieHeader(jar) }
    }, cfg);
    collectCookies(response, jar);
    const next = str(response.headers.get("location"), "");
    if (trace !== undefined) {
      const bodyText = next !== "" ? "" : await response.text();
      trace.step(`redirect hop ${hop + 1}`, {
        url: location,
        status: response.status,
        location: next !== "" ? next : undefined,
        note: next !== "" ? "followed Location" : "no Location; scanned body for the next hop",
        body: bodyText
      });
      location = next !== "" ? next : nextFromBody(bodyText, wanted);
    } else {
      location = next !== "" ? next : nextFromBody(await response.text(), wanted);
    }
  }
  return wanted.test(location) ? location : "";
}

/** Render a cookie jar as a request `cookie` header. */
function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Absorb `set-cookie` headers into the jar, name/value only. */
function collectCookies(response: { headers: { getSetCookie?: () => string[] } }, jar: Map<string, string>): void {
  const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair = ""] = line.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
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
 * The machine-readable reason IAM refused a login, when it sends one.
 *
 * IAM answers with a `google.rpc.Status`-shaped envelope whose top-level
 * `message` is a generic status string ("InvalidArgument"), while the actual
 * cause sits in `details[].reason` — `invalidAccountOrPassword`,
 * `accountLocked`, `tooManyAttempts` and so on. Reading only the top level
 * is what made every failure look like a wrong password, including rate
 * limits and locked accounts.
 * @param {object} body - the parsed IAM response.
 * @returns {string} the reason, or `""` when the body carries none.
 */
function iamRejectionReason(body: unknown): string {
  const details = obj(body).details;
  if (!Array.isArray(details)) return "";
  for (const entry of details) {
    const reason = str(obj(entry).reason, "");
    if (reason !== "") return reason;
  }
  return "";
}

/**
 * The best human-readable explanation of a refused login.
 *
 * Prefers the specific localized message, then the machine reason, then the
 * top-level message, so the user is told what the platform actually said
 * rather than a guess the plugin made up.
 * @param {object} body - the parsed IAM response.
 * @param {number} status - the HTTP status.
 * @returns {string}
 */
function rejectionDetail(body: unknown, status: number): string {
  const source = obj(body);
  const details = Array.isArray(source.details) ? source.details : [];
  for (const entry of details) {
    const message = str(obj(entry).message, "");
    // The LogInfo entries carry ids, not explanations; a message naming a
    // log or track id would be noise to the reader.
    if (message !== "" && !/log_id|track_id/i.test(message)) return message;
  }
  const reason = iamRejectionReason(source);
  if (reason !== "") return reason;
  return str(source.message, str(source.error, `HTTP ${status}`));
}

/**
 * Classify a refused login so the panel can say something specific.
 *
 * Order matters: an exact hit on the platform's machine reason wins, the
 * substring scan only covers a code this table has not learned yet, and the
 * generic code is the last resort — never a specific-looking guess.
 *
 * The table itself lives in `codes.ts` next to the taxonomy, so that a new
 * platform reason is recognised in one place rather than three.
 * @param {object} body - the parsed IAM response.
 * @returns {string} a {@link CODE} value.
 */
function rejectionCode(body: unknown): import("./codes.ts").CodeValue {
  // The platform writes the reason camelCase (`invalidAccountOrPassword`);
  // other responses spell it snake_case or SCREAMING_CASE. Folding separators
  // away lets one table serve every casing.
  const reason = iamRejectionReason(body).toLowerCase().replace(/[\s_-]+/g, "");
  const exact = IAM_REASON_CODES[reason as keyof typeof IAM_REASON_CODES];
  if (exact !== undefined) return exact;
  if (reason.includes("accountorpassword") || reason.includes("credential")) return CODE.LOGIN_REJECTED;
  if (reason.includes("lock") || reason.includes("disable")) return CODE.ACCOUNT_LOCKED;
  if (reason.includes("attempt") || reason.includes("limit") || reason.includes("frequent")) return CODE.RATE_LIMITED;
  if (reason.includes("captcha") || reason.includes("verify")) return CODE.VERIFICATION_REQUIRED;
  return CODE.LOGIN_FAILED;
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
 * The login flow proper. Throws with `error.trace` attached on every exit;
 * `login` wraps this so even out-of-band failures carry the trace.
 */
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

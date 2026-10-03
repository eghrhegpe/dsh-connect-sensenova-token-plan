/**
 * Auth configuration — the platform endpoints and OAuth parameters, resolved
 * per instance.
 *
 * Split out of `sensenova-auth.ts` (which keeps the login flow proper) so the
 * god file reads as a state machine rather than a config loader. Everything
 * here is pure: no fetch, no crypto, no module-level mutable state.
 *
 * @module dsh-connect-sensenova-token-plan/auth-config
 */

import { CODE } from "./codes.ts";
import { createJwksCache } from "./sensenova-crypto.ts";
import { str, obj, num, pluginError } from "./util.ts";

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
export const AUTH_DEFAULTS = Object.freeze({
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
export function resolveAuthConfig(overrides: object = {}): AuthConfig {
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

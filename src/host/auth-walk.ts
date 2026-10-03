/**
 * Redirect walk — hand-driven HTTP hops with one cookie jar across the chain.
 *
 * Split out of `sensenova-auth.ts`: the login flow asks this module to follow
 * a redirect chain until a wanted parameter shows up, because `fetch` cannot —
 * the chain crosses hosts and the CSRF cookie must ride along, which needs one
 * jar across the whole walk.
 *
 * @module dsh-connect-sensenova-token-plan/auth-walk
 */

import { str, obj } from "./util.ts";
import type { AuthConfig } from "./auth-config.ts";
import type { AuthTrace } from "./auth-trace.ts";

/**
 * One `fetch` with the console's headers and a deadline, returning the raw
 * response so redirect handling stays with the caller.
 * @param {string} url - absolute URL.
 * @param {RequestInit & {timeoutMs?: number}} init - fetch options.
 * @returns {Promise<Response>}
 */
export async function httpGet(url: string, init: RequestInit & { timeoutMs?: number } = {}, cfg: any) {
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
export function paramOf(url: string, name: string): string {
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
 * @param {string} start - the first URL.
 * @param {RegExp} wanted - what marks the destination.
 * @param {Map<string, string>} jar - cookies collected along the way.
 * @param {object} cfg - resolved auth config; `cfg.maxHops` is the hop budget.
 * @param {{ step: (name: string, info?: object) => void }} [trace] - the trace
 *   recorder; when present every hop is logged and the terminal body is scanned
 *   for the next hop from the response text.
 * @returns {Promise<string>} the matching URL, or `""` when the chain ends first.
 */
export async function followUntil(start: string, wanted: RegExp, jar: Map<string, string>, cfg: AuthConfig, trace?: AuthTrace): Promise<string> {
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
export function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Absorb `set-cookie` headers into the jar, name/value only. */
export function collectCookies(response: { headers: { getSetCookie?: () => string[] } }, jar: Map<string, string>): void {
  const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair = ""] = line.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

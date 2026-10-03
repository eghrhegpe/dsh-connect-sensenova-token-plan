/**
 * Login trace — the difference between debugging a failed sign-in and guessing.
 *
 * The Python reference implementation writes a diagnostic file on every failure
 * (each hop's URL, status, response snippet); without it a "browser works but
 * this does not" report is undebuggable. This module does the same, with one
 * gate the reference lacks: every recorded value passes sanitization, so no
 * password, token, cookie, or authorization code reaches the log. Traces are
 * returned on thrown errors (`error.trace`) for the caller to persist — this
 * module stays free of filesystem and Host dependencies.
 *
 * Split out of `sensenova-auth.ts`, which drives the recorder.
 *
 * @module dsh-connect-sensenova-token-plan/auth-trace
 */

import { str } from "./util.ts";

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

/** The trace recorder the walk functions receive. */
export interface AuthTrace {
  step(name: string, info?: Record<string, unknown>): void;
  done(): unknown[];
}

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
export function createTrace() {
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

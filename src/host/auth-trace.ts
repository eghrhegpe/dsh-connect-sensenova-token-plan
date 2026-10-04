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

/**
 * Fold a body key to its canonical comparison form.
 *
 * Separators are removed and the rest is lowercased, so `access_token`,
 * `accessToken`, `ACCESS-TOKEN` and `accesstoken` all fold to `accesstoken`.
 * The old code compared `key.toLowerCase()` against a snake_case set, which
 * folded `accessToken` to `accesstoken` — a member that was never in the set —
 * so a token endpoint that answered in camelCase wrote its access and refresh
 * tokens to the trace file verbatim. The set below is stored pre-folded.
 * @param {string} key - a body key.
 * @returns {string} the folded form.
 */
const foldKey = (key: string) => key.replace(/[_-]/g, "").toLowerCase();

/** Response-body keys whose value is a secret and must never be logged. */
const SECRET_BODY_KEYS = new Set([
  "password", "accesstoken", "refreshtoken", "idtoken", "jwt",
  "authorization", "cookie", "setcookie", "codeverifier", "clientsecret"
]);

/**
 * Value shapes that are a secret no matter WHICH key carried them.
 *
 * A name-keyed scrub can only catch secrets under names it has learned, so it
 * is a blacklist, and a blacklist fails open. These are the shapes that
 * identify themselves: a JWT is self-describing, and so is an `sk-` key. They
 * are checked by VALUE, so an innocent-looking key (`data.token`, `result`,
 * a nested `payload`) cannot smuggle one past the name check below.
 * @type {ReadonlyArray<RegExp>}
 */
const SECRET_VALUE_SHAPES: ReadonlyArray<RegExp> = Object.freeze([
  // A JWT: header.payload(.signature). Self-describing, no key needed.
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/,
  // `Bearer` / `Basic <blob>`: Basic carries a base64 user:password.
  /^(?:Bearer|Basic)\s+\S+/i,
  // A SenseNova inference key.
  /^sk-[A-Za-z0-9._-]{8,}$/
]);

/**
 * Whether a string IS a secret by its shape, independent of the key above it.
 * @param {string} value - a string value from the body.
 * @returns {boolean} true when the value must not be recorded.
 */
const isSecretValue = (value: string) =>
  value.length > 0 && SECRET_VALUE_SHAPES.some((pattern) => pattern.test(value));

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
  // Relative URLs are the common case in this flow (a redirect's `Location`
  // is very often just `/oauth2/callback?code=…`), and they are exactly the
  // ones the old code returned TRUNCATED AND BARE: `new URL()` cannot parse
  // them, so every secret query parameter rode straight into the trace file.
  // Resolve against a throwaway origin so the scrub below still runs, then
  // hand back the relative form that arrived — a stray fragment is still more
  // useful for diagnosis than nothing, once it has been scrubbed.
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    try {
      parsed = new URL(raw, "http://redacted.invalid");
    } catch {
      return raw.slice(0, 200);
    }
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (SECRET_URL_PARAMS.has(name.toLowerCase())) {
      parsed.searchParams.set(name, "[REDACTED]");
    }
  }
  // The fragment carries its own parameters and `searchParams` never sees
  // them: an implicit-flow answer puts `access_token` AFTER the `#`.
  if (parsed.hash.length > 1) {
    parsed.hash = parsed.hash.replace(
      new RegExp(`\\b(${[...SECRET_URL_PARAMS].join("|")})=([^&]+)`, "gi"),
      "$1=[REDACTED]"
    );
  }
  return isAbsolute ? parsed.href : `${parsed.pathname}${parsed.search}${parsed.hash}`;
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
          // Two independent gates: the KEY names a secret field, or the VALUE
          // simply is one. Only the first was checked before, which is why a
          // camelCase-spelled token and a JWT nested under an ordinary key
          // both reached the file untouched.
          const namedSecret = SECRET_BODY_KEYS.has(foldKey(key));
          const shapedSecret = isSecretValue(typeof item === "string" ? item.trim() : "");
          out[key] = namedSecret || shapedSecret ? "[REDACTED]" : scrub(item);
        }
        return out;
      }
      // A VALUE can hold a secret under an innocent key. IAM answers a form
      // post with a `redirect`, and its query carries `code` and
      // `login_challenge` — a name-keyed scrub leaves both in the file.
      if (typeof value === "string") {
        if (isSecretValue(value.trim())) return "[REDACTED]";
        // Relative URLs too: a `Location` of `/oauth2/callback?code=…` used to
        // skip the scrub entirely because it never parsed as absolute.
        if (/^https?:\/\//i.test(value.trim()) || value.trim().startsWith("/")) {
          return sanitizeUrl(value);
        }
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

/**
 * Shared value readers and the error constructor used across the Host half.
 *
 * These are the small "read X or fall back" primitives every module reaches
 * for. Centralising them stops copies from drifting apart the way the error-code
 * taxonomy once did.
 * @module dsh-connect-sensenova-token-plan/util
 */

import type { PluginError } from "./types.ts";
import type { CodeValue } from "./codes.ts";

/**
 * The error `pluginError` actually produces at runtime: an `Error` with a
 * stable `code` the panel branches on, plus optional structured fields the
 * panel and trace read. The fields are attached, not inherited, so this is a
 * structural annotation, not a subclass.
 * @typedef {Error & {
 *   code: import("./codes.ts").CodeValue,
 *   retryAfterMs?: number,
 *   detail?: string,
 *   trace?: object[]
 * }} PluginError
 */

/** Read a finite positive number, else the fallback. */
export function num(value: any, fallback?: any): any {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Read a non-empty string, else the fallback. */
export function str(value: any, fallback?: any): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}
/**
 * The one-line error message every catch site used to hand-write: the
 * Error's message when it is an Error, else its string form. Collapses
 * the repeated `X instanceof Error ? X.message : String(X)` boilerplate.
 * (The two Raccoon `onFail` sites that also quote `${why.name}` keep
 * their own richer message and do NOT use this.)
 * @param {unknown} value - a caught value.
 * @returns {string}
 */
export function errMsg(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}



/**
 * Redact credential-shaped strings from any text that may reach a log, an
 * error message, or a panel-facing response.
 *
 * AGENTS.md's red line: "凭据不入库" — a credential never reaches a log or a
 * response. The login trace already sanitizes in `sensenova-auth.ts`; this is
 * the counterpart for the LLM route, where an HTTP error object's `message`
 * often embeds the request headers it was built from (axios/fetch errors do),
 * and a SenseNova 4xx body may echo the `sk-` key back. Without this gate a
 * registration failure would leak the key through `providerState.error` and
 * `ctx.logger.warn`.
 * @param {string} text - any string that might carry a credential.
 * @returns {string} the text with credential patterns replaced by `[REDACTED]`.
 */
export function redactSecrets(text) {
  const raw = typeof text === "string" ? text : "";
  return (
    raw
      // 1) Header values FIRST, so a whole `"authorization":"sk-..."` value is
      //    consumed in one pass instead of leaving the token behind. The
      //    `(?!Bearer\s)` skip keeps this from eating the word "Bearer" that
      //    rule 2 leaves tagged.
      .replace(/(["']?[Aa]uthorization["']?\s*[:=]\s*["']?)(?!Bearer\s)[^"',;\s]+/g, "$1[REDACTED]")
      // 2) Bearer / Basic tokens.
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
      // 3) Bare SenseNova inference keys, e.g. sk-a1b2c3... (long alnum + - _ .)
      .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-[REDACTED]")
      // 4) Known secret JSON pairs, quoted: {"api_key":"..."}.
      .replace(/(["']?(?:password|access_token|refresh_token|api[_-]?key|token)["']?\s*:\s*["'])[^"']+(?=["'])/gi, "$1[REDACTED]")
      // 5) Known secret key=value pairs.
      .replace(/\b(password|access_token|refresh_token|api[_-]?key|token)\s*=\s*[^&;\s]+/gi, "$1=[REDACTED]")
  );
}

/** Read a plain object, else `{}`. */
export function obj(value?: any): any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Wait for something that may arrive late, inside a bounded window.
 *
 * Mount-time reads run against a Host that is still assembling itself: the
 * credentials, settings, tools and `llm` services may all register AFTER this
 * plugin mounts, and a one-shot read that misses one leaves a capability
 * absent for the whole session with no line anywhere naming the reason. This
 * is the one loop both such callers use — `resolveServiceWithRetry` in
 * `lifecycle.ts` (retries a service READ) and the Raccoon mount seed in
 * `index.ts` (retries a whole seed pass) — so the backoff shape cannot drift
 * between them.
 *
 * The window LENGTH stays with the caller: those two need different budgets
 * (a single service read settles in a few hundred ms; a seed that must wait
 * for two services and then fetch a catalogue needs longer), and that is a
 * design choice, not an accident.
 * @param {object} job
 * @param {number} job.attempts - how many attempts the window holds.
 * @param {number} job.delayMs - backoff base; the wait before attempt N is
 *   `delayMs * N` (linear, so a slow Host is not hammered).
 * @param {(attempt: number) => boolean|Promise<boolean>} job.run - one
 *   attempt; returns true to stop (succeeded, or gave up deliberately), false
 *   to keep trying inside the window.
 * @returns {Promise<boolean>} true when an attempt stopped the loop, false
 *   when the window ran out.
 */
export async function retryBounded({ attempts, delayMs, run }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await run(attempt)) return true;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  return false;
}

/**
 * Read a string exactly as it was given, else the fallback.
 *
 * The companion to `str()` for secrets: a password is stored, read back and
 * sent as typed, because trimming it is a change the user cannot see. A
 * password of only whitespace is still "not filled in", which the caller
 * judges with `.trim()`.
 */
export function verbatim(value: any, fallback?: any): string {
  return typeof value === "string" ? value : fallback;
}

/** Read a finite number, else `null`. */
export function numOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Await an OPTIONAL store call, reading "there is no store" as "no answer".
 *
 * The shape this replaces looks defensive and is not:
 * `(store ? store.enabled() : null).catch(() => null)` guards the CALL but
 * applies `.catch` to the ternary's RESULT — and the absent branch yields a
 * bare `null`, so the expression throws exactly on the branch the guard was
 * written for. It stays invisible because the store is always wired in
 * production, which is the one case where it works (PITFALLS §33).
 *
 * Use it as `await optional(store ? store.enabled() : null)`: the guard then
 * sits on the value, where "not a promise" and "a rejected promise" both read
 * as `null`.
 * @param value - the call's result (usually a promise), or `null`.
 * @param fallback - what to read on absence or rejection; `null` by default,
 *   so callers that only need "no answer" pass nothing.
 * @returns the value, or `fallback` on absence or rejection.
 *
 * Generic over both the value and the fallback rather than annotated `unknown`
 * (docs/IMPROVEMENTS.md §8): the caller's declared fallback is what makes the
 * result usable at the call site — `optional(x, { credential: null })` must
 * yield that object's shape, not `unknown`. The default-parameter form this
 * replaces was typed FROM the `null` initializer under strictNullChecks, so
 * every explicit fallback became an argument error.
 */
export function optional<T, F = null>(value: T | Promise<T> | null | undefined, fallback: F = null as F): Promise<T | F> {
  return Promise.resolve(value).catch(() => fallback) as Promise<T | F>;
}

/**
 * Omit the fields of `fields` that are `null` or `undefined`, keeping the
 * rest as a fresh object. Collapses the `(x !== null ? { x } : {})` response
 * builders: `...pickDefined({ x })` reads as omit-when-absent in one token.
 * A guard that omits an empty string or requires a specific type is a
 * DIFFERENT policy and keeps its own `typeof` / non-empty test — not this helper.
 * @param fields - the candidate field map.
 * @returns a new object holding only the defined fields.
 */
export function pickDefined<T extends Record<string, unknown>>(fields: T): Partial<{ [K in keyof T]: Exclude<T[K], null | undefined> }> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out as Partial<{ [K in keyof T]: Exclude<T[K], null | undefined> }>;
}

/**
 * An error carrying a stable code the panel can branch on.
 *
 * The single constructor for every failure this plugin produces. `extra`
 * carries optional structured fields (retryAfterMs, detail) that the panel
 * and the trace need; only defined extras are copied, so an absent field
 * stays absent rather than reading as a zero.
 *
 * The runtime value is a plain `Error` with these fields attached; the
 * {@link PluginError} type records that shape so a `catch (e)` downstream can
 * read `e.code` as more than a hopeful guess.
 * @param {import("./codes.ts").CodeValue} code - a {@link import("./codes.ts").CODE} wire value.
 * @param {string} message - human-readable description.
 * @param {{ retryAfterMs?: number, detail?: string }} [extra] - optional structured fields.
 * @returns {PluginError}
 */
export function pluginError(code: CodeValue, message: string, extra: { retryAfterMs?: number; detail?: string } = {}): PluginError {
  const error = new Error(message) as PluginError;
  error.code = code;
  if (extra.retryAfterMs !== undefined) error.retryAfterMs = extra.retryAfterMs;
  if (extra.detail !== undefined) error.detail = extra.detail;
  return error;
}

/**
 * Shared value readers, the bounded mount-time service resolver, and the error
 * constructor used across the Host half.
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
 * The one credential-word list, in the spelling the redaction rules and
 * `test/credential-guard.test.mjs` both read.
 *
 * `access[_-]?token` covers `access_token`, `access-token` and — because these
 * rules run case-insensitively — `accessToken`. `secret` and `client_secret`
 * are listed separately: OAuth-shaped bodies spell them both ways.
 *
 * EXPORTED for the same reason the redaction rules need it, and not only for
 * them: the credential fence in `test/credential-guard.test.mjs` derives its
 * field-name vocabulary from this string, so a name added here also widens the
 * fence that keeps that name out of `str()`. One list, two readers — a third
 * hand-copied list is the way these drifted apart the first time.
 */
export const SECRET_KEY = "password|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|code[_-]?verifier|token|secret";

/**
 * Rules 5, 6 and 7 of `redactSecrets`, built from {@link SECRET_KEY} instead of
 * repeating the alternation three times (which is exactly how rule 6 and rule 7
 * came to be missing `secret`: three literals, three chances to forget one).
 */
const SECRET_JSON_PAIR = new RegExp(`(["']?(?:${SECRET_KEY})["']?\\s*:\\s*["'])[^"']+(?=["'])`, "gi");
const SECRET_KEY_VALUE = new RegExp(`\\b(${SECRET_KEY})\\s*=\\s*[^&;\\s"']+`, "gi");
const SECRET_UNQUOTED_PAIR = new RegExp(`\\b(${SECRET_KEY})(\\s*:\\s*)(?!null\\b|true\\b|false\\b|undefined\\b|-?\\d)([A-Za-z0-9._~+/=-]{4,})`, "gi");

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
export function redactSecrets(text: unknown) {
  const raw = typeof text === "string" ? text : "";
  return (
    raw
      // 1) Bearer / Basic FIRST, while the scheme word and its value are still
      //    one contiguous shape. Rule 2 below swallows whatever token follows
      //    an `authorization` header, and its `(?!Bearer\s)` skip covers Bearer
      //    only — so with the old order a `Basic <base64>` pair was turned into
      //    `Authorization: [REDACTED] dXNlcjpwYXNz…`, i.e. the scheme word was
      //    redacted and the base64 (a trivially decodable user:password, and
      //    that user IS the console account name) was left standing behind it.
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
      // 2) Header values, so a whole `"authorization":"sk-..."` value is
      //    consumed in one pass instead of leaving the token behind.
      .replace(/(["']?[Aa]uthorization["']?\s*[:=]\s*["']?)(?!Bearer\s)[^"',;\s]+/g, "$1[REDACTED]")
      // 3) Cookie / Set-Cookie: every cookie in the jar is a session
      //    credential — the OIDC walk's CSRF cookie among them (AGENTS.md red
      //    line 1 names cookies explicitly) — so the whole header goes rather
      //    than trying to match cookie names one by one. It must run to the
      //    END of the value, not to the first `;`: a jar is `a=1; b=2`, and
      //    stopping at the separator would leave every cookie but the first
      //    standing. The quote group is echoed back so a JSON-shaped
      //    `"Cookie": "a=1; b=2"` stays well-formed.
      .replace(/\b(Set-Cookie|Cookie)(\s*[:=]\s*)(["']?)[^"'\n]*\3/gi, "$1$2$3[REDACTED]$3")
      // 4) Bare SenseNova inference keys, e.g. sk-a1b2c3... (long alnum + - _ .)
      .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-[REDACTED]")
      // 4b) A bare JWT — three dot-separated base64url segments, which is
      //     exactly the shape of the SenseNova access token (`readJwtExpiry`
      //     parses it) and of the refresh token. It is listed separately from
      //     rules 5/6/7 because those match on the KEY NAME, and a token that
      //     arrives under a name this list never anticipated (`jwt`,
      //     `id_token`, `session`, a renamed field) would sail through: a
      //     blacklist that only knows names cannot redact a value whose name
      //     it has not met yet, so the VALUE shape is matched here too. The
      //     shape is what an upstream 4xx body quotes back when it rejects a
      //     request — the token with no key name in front of it.
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[REDACTED]")
      // 5) Known secret JSON pairs, quoted: {"api_key":"..."}. The key
      //    alternation is separator-agnostic (`access[_-]?token` under `/i`),
      //    so a platform that spells the same field camelCase is still matched.
      .replace(SECRET_JSON_PAIR, "$1[REDACTED]")
      // 6) Known secret key=value pairs.
      .replace(SECRET_KEY_VALUE, "$1=[REDACTED]")
      // 7) The SAME pairs with an UNQUOTED value: `{ accessToken: eyJ… }`.
      //    Rule 5 needs a quote to anchor the value, so this shape slipped
      //    through it entirely — and it is the shape a Node error message takes
      //    when something interpolates the record it was handed
      //    (`util.inspect` / `String(obj)` print objects unquoted). Since the
      //    thing being printed IS the credential pair, that is the one form
      //    guaranteed to show up on a save/refresh failure.
      //
      //    The value stops at the first structural character, so it cannot eat
      //    the rest of a human-readable message. `null` / `true` / `false` /
      //    digits are left alone on purpose: a field can be reported as absent
      //    (`refreshToken: null`) and saying so is the diagnosis; redacting it
      //    to `[REDACTED]` would destroy the only clue that it was never set.
      .replace(SECRET_UNQUOTED_PAIR, "$1$2[REDACTED]")
  );
}

/**
 * Swallow a failure, but leave a trace.
 *
 * The opt-in modules degrade by design: a refused tool registration or a peer
 * that fails to load must leave the panel and the quota read working, so these
 * paths swallow. What they must NOT swallow is the reason — before this helper
 * those catches were empty, so "面板照常用、模块缺席" produced exactly zero logs
 * and a deployment that lost the draw tool had no line anywhere naming why.
 *
 * Logs at `warn`, deliberately NOT `debug`: a debug line is filtered on a
 * default Host, so it would still be zero logs. `reason` is caller-supplied and
 * static; the error message is redacted first (AGENTS.md red line 1 — a
 * credential never enters a log).
 *
 * Returns `fallback`, so one call serves both shapes a silent catch appears
 * in:
 *   try { … } catch (e) { return degrade("draw: tools peer module failed to load", e, logger, null); }
 *   … .catch((e) => degrade("draw: catalog list", e, logger, []))
 * @param {string} reason - what degraded, module-prefixed ("draw: …").
 * @param {unknown} error - the caught value; `null`/`undefined` (or empty)
 *   means "no underlying error" and is omitted, so a refusal like ADR-006's
 *   version guard does not log a misleading `: null`.
 * @param {{ warn?: (message: string) => void } | undefined} logger - `ctx.logger`.
 * @param {T} fallback - the value standing in for the absent result.
 * @returns {T}
 */
export function degrade<T>(reason: string, error: unknown, logger: { warn?: (message: string) => void } | undefined, fallback: T): T {
  const detail = error == null ? "" : redactSecrets(errMsg(error));
  logger?.warn?.(detail === "" ? `degraded: ${reason}` : `degraded: ${reason}: ${detail}`);
  return fallback;
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
 * is the one loop both such callers use — `resolveServiceWithRetry`
 * (retries a service READ, right below) and `seedRaccoonOnMount` in
 * `lifecycle.ts` (retries a whole seed pass) — so the backoff shape cannot
 * drift between them.
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
export async function retryBounded({ attempts, delayMs, run }: {
  attempts: number;
  delayMs: number;
  run: (attempt: number) => boolean | Promise<boolean>;
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await run(attempt)) return true;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  return false;
}

/** How many times a mount-time optional-service read is retried. */
const SERVICE_RETRY_ATTEMPTS = 3;
/** Base backoff between service-read attempts (× attempt index). */
const SERVICE_RETRY_DELAY_MS = 300;

/**
 * Read an optional Host service with a bounded retry.
 *
 * A service may register AFTER this plugin mounts — the vision step two note
 * in `lifecycle.ts` said so — and a mount-time read is the only window for a
 * capability the Host cannot later remove: the tools registry has no
 * unregister call, and the settings row is only written by a poll that finds
 * `visionPublish.current` already filled. A one-shot read therefore misses a
 * service that arrives a moment late for the WHOLE session, silently — the
 * draw tool would be absent with the switch visibly on, the vision list never
 * written, and no line on any panel naming the reason. The Raccoon publisher
 * got the same bounded retry for its mount seed.
 *
 * This retries the READ ONLY. Whatever it returns is used exactly once by the
 * caller: retrying a call that mutates (a tool registration) would register
 * the same tool twice, and the tools registry cannot tell.
 *
 * The loop is `retryBounded` directly above — the same backoff
 * shape the Raccoon mount seed uses; only the window length is set here.
 * @template T - the shape of the service being waited for. The reader knows
 *   what it wants (`{ register }` for tools, `{ update }` for settings); this
 *   function only knows a name, so the shape is declared at the call site and
 *   the `as T` below is the single place that claim is trusted. Defaulting to
 *   `unknown` means a caller that forgets the parameter gets a type it cannot
 *   accidentally dereference — which is the failure the old `Promise<any>`
 *   invited on every one of its seven property reads.
 * @param {object} ctx - the host root context.
 * @param {string} service - the service name for `ctx.get`.
 * @param {object} [options]
 * @param {() => boolean} [options.isDisposed] - stop early when the plugin is
 *   withdrawing; a late registration into a withdrawing Host is worse than
 *   absence.
 * @param {number} [options.attempts] - test seam for the attempt count.
 * @param {number} [options.delayMs] - test seam for the backoff base.
 * @returns {Promise<T|null>} the service, or `null` when it never appeared
 *   inside the window.
 */
export async function resolveServiceWithRetry<T = unknown>(
  ctx: { get?: (n: string) => unknown; [key: string]: unknown },
  service: string,
  // Typed explicitly rather than left to inference, and NOT via JSDoc: a
  // parameter with a default initializer is typed from that initializer (`{}`),
  // and in a `.ts` file `@param` / `@type` are comments, not type sources — so
  // the destructuring below would read three properties off `{}` (TS2339).
  options: { isDisposed?: () => boolean; attempts?: number; delayMs?: number } = {}
): Promise<T | null> {
  const {
    isDisposed = () => false,
    attempts = SERVICE_RETRY_ATTEMPTS,
    delayMs = SERVICE_RETRY_DELAY_MS
  } = options;
  // Annotated `T | null` rather than inferred from the `null` initializer,
  // which under strictNullChecks would pin the type to `null` and make every
  // assignment below — and every `tools.register` / `settings.update` at the
  // call sites — read as `never`.
  let found: T | null = null;
  await retryBounded({
    attempts,
    delayMs,
    run: () => {
      if (isDisposed()) return true;
      try {
        const value = ctx.get?.(service) ?? ctx[service] ?? null;
        if (value !== null && value !== undefined) {
          // The one trusted claim in this module: `ctx.get` hands back
          // `unknown` because the Host is dynamically typed, so the shape is
          // whatever the caller's `T` says it is. Every call site
          // (`registerDrawTool` in `draw-mount.ts`, `publishVisionStepTwo` in
          // `lifecycle.ts`, the web-search mount in `web-search.ts`) keeps its
          // own `typeof x.method !== "function"` guard, which is what makes the
          // wrong `T` a degraded path rather than a crash.
          found = value as T;
          return true;
        }
      } catch {
        // A resolver that refuses a read is treated like an absent service.
      }
      return false;
    }
  });
  return found;
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
export function numOrNull(value: unknown) {
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
 * @param {T | Promise<T> | null | undefined} value - the call's result (usually a promise), or `null`.
 * @param {F} fallback - what to read on absence or rejection; `null` by default,
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
 * @param {T} fields - the candidate field map.
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

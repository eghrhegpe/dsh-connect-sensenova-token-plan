/**
 * The decision layer: reading a snapshot response into a view, and the wire-
 * code tables the panel's guidance and forms are keyed by.
 */
import { format } from "./format.ts";
import type { Tt } from "./runtime.ts";
import type { AuthData, ShapeWarningData, SnapshotData } from "./wire.ts";

/** A structured failure: what the Host answered besides the numbers. */
export interface SnapshotFailure {
  message: unknown;
  code?: unknown;
  auth?: AuthData | null;
}

/** The (data, error) pair the panel renders; exactly one side is non-null. */
export interface SnapshotRead {
  data: SnapshotData | null;
  error: SnapshotFailure | string | null;
}

/** `viewOf`'s verdict: what this snapshot means for what to show. */
export interface SnapshotView {
  failure: SnapshotFailure | null;
  auth: AuthData | null;
  needsSetup: boolean;
  guidanceKey: string | null;
  guidance: string | null;
  shapeWarnings: ShapeWarningData[];
}

/**
 * Read one snapshot response into the (data, error) pair the panel renders.
 *
 * The Host answers HTTP 200 for every expected outcome and signals the
 * difference in the body: `ok:true` carries the numbers, `ok:false` carries
 * a code and — crucially — the `auth` block, so a panel that cannot reach
 * the console can still say whether its token will renew by itself.
 *
 * A named function at module scope, not inline branching, so the
 * Node-side tests can drive the panel's REAL reading of a response by
 * loading this bundle as a module (`client-surface.js`) — instead of a
 * hand-written copy that would drift the moment either side is edited.
 */
export function interpretSnapshot(body: unknown): SnapshotRead {
  // The body is validated by the checks themselves, so the shape is
  // asserted here rather than pretended at the signature: a non-object
  // body (a string, `null`) must keep falling through to the same two
  // refusals it always has.
  const payload = body as { ok?: unknown; error?: unknown; code?: unknown; auth?: unknown } | null | undefined;
  if (payload && payload.ok === false) {
    // The code is kept to pick the guidance rather than the message.
    return { data: null, error: { message: payload.error || "unexpected payload", code: payload.code, auth: payload.auth ?? null } };
  }
  if (!payload || payload.ok !== true) return { data: null, error: "unexpected payload" };
  return { data: payload as unknown as SnapshotData, error: null };
}

/**
 * The failure a non-2xx snapshot response becomes.
 *
 * A non-2xx carries no body, so the status is the only clue. 401/403 mean
 * the token is gone — the same story as the Host's own `jwt_expired`, and
 * the only reading that keeps the sign-in form on screen instead of leaving
 * the reader with a bare status code. Anything else is a plain transport
 * string, which keeps the form reachable too.
 *
 * Named and module-scoped for the same reason as `interpretSnapshot`: the
 * Node-side tests drive this mapping instead of a copy of it.
 */
export function errorOfStatus(status: number): SnapshotFailure | string {
  if (status === 401 || status === 403) return { message: `HTTP ${status}`, code: "jwt_expired", auth: null };
  return `HTTP ${status}`;
}

/**
 * The panel's guidance line for a wire code, keyed by `body.code`.
 *
 * This is the ONE deliberate copy of the Host's taxonomy: the browser
 * cannot import `codes.ts` (the Client module table resolves package
 * names only). The copy is therefore pinned, not trusted —
 * `test/panel.test.mjs` asserts every key here exists in `CODE`, so a code
 * renamed on either side fails the suite instead of silently reading as
 * "no guidance".
 */
export const GUIDANCE_BY_CODE: Readonly<Record<string, string>> = Object.freeze({
  auth_error: "panel.jwtExpired",
  jwt_expired: "panel.jwtExpired",
  not_configured: "panel.jwtMissing",
  config_error: "panel.configError",
  // The console did not answer. `FORM_EXCLUDED_CODES` already keeps the
  // login form away from this code, so the guidance line is the whole
  // explanation — and it must say the failure is expected to pass.
  console_error: "panel.consoleTransient"
});

/**
 * Failures the sign-in form must NOT answer, because no login fixes them.
 *
 *   config_error  — a bad endpoint override; the operator must fix it.
 *   console_error — the console did not answer; it usually clears on the
 *                   next poll, and the text must say so.
 *
 * Hiding either behind a login box turns "the console is down" into
 * "please sign in". Pinned to `NO_LOGIN_CODES` in `codes.ts` by the same
 * test: this set is the copy, that one is the declaration.
 */
export const FORM_EXCLUDED_CODES: ReadonlySet<string> = Object.freeze(new Set(["config_error", "console_error"]));

/**
 * The platform's classified refusals, keyed by wire code, mapped to the
 * dictionary line the form shows beneath the platform's own detail. The
 * canned text translates; the prose (`body.detail`) carries the lockout
 * policy and anything else the platform wanted to say.
 */
export const REFUSAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  login_rejected: "auth.badCredentials",
  account_locked: "auth.locked",
  rate_limited: "auth.rateLimited",
  verification_required: "auth.verification"
});

/**
 * The panel's decision: what this snapshot means for what to show.
 *
 * Deliberately a module-scope pure function in `(data, error, tt)`.
 * `PanelPage` calls it in the browser, and the Node-side tests call the
 * very same function after loading this bundle as a module (see
 * `client-surface.js`): no source text is copied or scraped, so the
 * tested logic and the running logic cannot drift apart.
 */
export function viewOf(
  data: SnapshotData | null,
  error: SnapshotFailure | string | null,
  tt: Tt
): SnapshotView {
  // `error` is either a string (transport failure) or the Host's structured
  // failure. The auth state travels with both, so a panel that cannot read
  // the console can still say whether the token renews itself.
  const failure: SnapshotFailure | null = error === null || error === undefined
    ? null
    : typeof error === "string" ? { message: error, code: null, auth: null } : error;
  const auth: AuthData | null = (data?.auth ?? failure?.auth ?? null) as AuthData | null;
  // With no data the form is the answer whenever the fix is the ACCOUNT:
  // nothing has been entered yet, or no token can be obtained — except for
  // the codes no login can fix. `data === null, error === null` also reads
  // as setup here, and that is the STEADY-STATE answer only: the mounted
  // page holds it behind its `loadedOnce` gate until the first attempt has
  // concluded, so the true first frame shows the loading line, not the
  // form (pinned by `test/render.test.mjs` group H2).
  const needsSetup = data === null && !FORM_EXCLUDED_CODES.has((failure?.code ?? null) as string);
  // The dictionary key, resolved with the caller's `tt`; returned as a key
  // so tests can assert the decision without owning a dictionary.
  const guidanceKey = failure === null ? null : GUIDANCE_BY_CODE[failure.code as string] ?? null;
  const guidance = guidanceKey === null
    ? null
    : guidanceKey === "panel.configError"
      ? format(tt(guidanceKey), { error: failure?.message })
      : tt(guidanceKey);
  // The Host's own contract check: a renamed upstream field would otherwise
  // look identical to "no usage yet".
  const shapeWarnings = Array.isArray(data?.shapeWarnings)
    ? (data.shapeWarnings as ShapeWarningData[])
    : [];
  return { failure, auth, needsSetup, guidanceKey, guidance, shapeWarnings };
}
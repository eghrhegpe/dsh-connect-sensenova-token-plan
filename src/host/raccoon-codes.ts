/**
 * Why a Raccoon credential rotation failed — the second upstream's OWN
 * taxonomy, plus the two predicates that read it.
 *
 * Split out of the former single `raccoon.ts` (2026-10-05). This module has no
 * dependency on any other Raccoon module: it is a pure classification table,
 * and keeping it that way is what lets a test pin the table and the mapping
 * separately from the call sites that consult them.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-codes
 */

/**
 * Why a credential rotation failed.
 *
 * These are NOT `CODE` values from `codes.ts`, and deliberately so. That table
 * is the Token Plan panel's taxonomy: `AUTH_FAILURE_CODES` decides what the
 * quota panel offers as a login form, and every member reaches
 * `snapshot-aggregate.ts`'s `failureCode`. Folding the second upstream's codes
 * in there would make one upstream's wording depend on the other upstream's
 * registrations — the coupling `docs/ARCHITECTURE.md` §5.5 exists to forbid
 * (the two share a vendor, not an auth domain: the desktop App's login does
 * not reach Token Plan at all). The two tables are separate on purpose; do not
 * merge them "to remove the duplication".
 *
 * What this buys is that the codes stop being bare literals at their call
 * sites. `session_dead` used to be produced by a ternary here and consumed
 * NOWHERE: all three refresh call sites swallowed the result with
 * `.catch(() => {})`, so a dead session was a fact the plugin produced and
 * immediately forgot. A name no code reads cannot be tested, and an untestable
 * classification is a comment.
 */
export const RACCOON_CODE = Object.freeze({
  /** No credential is stored at all — nothing was attempted. */
  NOT_CONFIGURED: "not_configured",
  /** The stored pair carries no refresh token to rotate with. */
  NO_REFRESH_TOKEN: "no_refresh_token",
  /** The refresh call itself failed (network, 5xx) — it may succeed later. */
  REFRESH_FAILED: "refresh_failed",
  /**
   * The gateway refused the refresh token and named no better reason.
   * Transient in principle, and the stored pair is KEPT: the ACCESS token may
   * still be inside its own 3-hour window, so this is not a lost login.
   */
  REFRESH_REJECTED: "refresh_rejected",
  /**
   * The session is gone — the gateway says this token is not merely lapsed but
   * no longer valid (401 / `200003`). Only a fresh QR scan recovers it; no
   * amount of waiting or retrying changes the answer.
   *
   * This is the one member with a consequence rather than a label, and it is
   * what {@link isDeadRaccoonSession} keys off.
   */
  SESSION_DEAD: "session_dead"
});

/**
 * Gateway envelope codes that mean "this token is dead", not "try again".
 *
 * The gateway answers a refresh it will never accept two ways: the HTTP status
 * `401`, and an envelope `code` of `200003` under an HTTP 200. Both were bare
 * literals in one ternary, which read as two arbitrary numbers — the reader had
 * no way to tell a typo from a contract. Named here so the pair is one fact.
 * @type {ReadonlySet<number>}
 */
export const RACCOON_DEAD_SESSION_CODES: ReadonlySet<number> = Object.freeze(new Set([
  401,
  200003
]));

/**
 * Union of the {@link RACCOON_CODE} wire values — the annotation that turns a
 * misspelling at a call site into a compile error, exactly as `CodeValue` does
 * for the Token Plan table.
 */
export type RaccoonCodeValue = typeof RACCOON_CODE[keyof typeof RACCOON_CODE];

/**
 * Whether a rotation failure means this session can never come back.
 *
 * The distinction that matters to a caller: `refresh_failed` /
 * `refresh_rejected` are answered by trying again later, `session_dead` is not.
 * Only a caller that KNOWS this can stop knocking on the gateway — the
 * eager-refresh path calls `refresh()` once per poll for as long as the access
 * token is lapsed, so an unrecognized dead session means one guaranteed-401
 * request per poll cycle, indefinitely.
 * @param {unknown} code - a {@link RACCOON_CODE} value.
 * @returns {boolean} true when only a fresh login can recover.
 */
export function isDeadRaccoonSession(code: unknown) {
  return typeof code === "string" && code === RACCOON_CODE.SESSION_DEAD;
}

/**
 * Whether a gateway envelope code means the session is unrecoverable.
 *
 * Split from {@link isDeadRaccoonSession} on purpose: this one reads the
 * GATEWAY's numbering (the wire fact), that one reads OUR classification (the
 * panel-facing fact). Keeping them apart is what lets a test pin the mapping
 * table (`RACCOON_DEAD_SESSION_CODES`) separately from the label it produces.
 * @param {unknown} envelopeCode - the envelope's numeric `code`.
 * @returns {boolean} true when only a fresh QR scan can recover.
 */
export function isDeadRaccoonEnvelope(envelopeCode: unknown) {
  return typeof envelopeCode === "number" && RACCOON_DEAD_SESSION_CODES.has(envelopeCode);
}

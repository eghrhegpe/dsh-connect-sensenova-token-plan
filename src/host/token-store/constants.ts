/**
 * The credential-domain string constants, in one place.
 *
 * These three used to be re-declared at every site that needed them — twice in
 * `token-store.ts`, once in `state.ts`, once in `grant.ts`, and twice inside
 * `throttle.ts`'s function bodies (`LEGACY_SCOPE` / `THROTTLE_ID` were
 * re-declared in BOTH `adoptLegacyThrottle` and `clearThrottle`, on the theory
 * that a local copy was cheaper than an import). The values were identical, so
 * nothing was broken — which is exactly why the duplication was dangerous:
 * these strings are RECORD ADDRESSES and MIGRATION KEYS, and a value that
 * drifts in one copy does not fail a type check, does not fail a test, and
 * fails as "the user has to log in again" or "a parked password is retried
 * after a restart" — the two failures hardest to trace back to a renamed
 * string. One declaration, imported by every site that addresses a record.
 *
 * NOT here, and deliberately so:
 *
 *   - `RECORD_SCOPE` — that is this plugin's own `name` from `host-config.ts`
 *     (the namespace half of every key below). It already has exactly one
 *     declaration; aliasing it a second time would create the same drift.
 *   - the payload version numbers — each belongs to the ONE persisted shape it
 *     versions. `grant.ts` owns the grant's, and the throttle's two live in the
 *     two modules that write and adopt them respectively, under names that say
 *     which storage they version (`token-store/throttle.ts` reads a shape this
 *     plugin no longer writes, so its number is a frozen historical fact and
 *     must never be bumped in lockstep with the file-backed one).
 *
 * @module dsh-connect-sensenova-token-plan/token-store/constants
 */

/**
 * Record name: this plugin's own console grant.
 *
 * Namespaced by `RECORD_SCOPE`, so a stranger's plugin cannot collide with it.
 */
export const RECORD_ID = "sensenova-console";

/**
 * Record name of the throttle that used to live in the credentials service.
 *
 * The throttle itself now lives in a state file (PITFALLS §23: throttle and
 * the credential grant deliberately share their store, everything else is
 * per-profile). This address survives as a MIGRATION-ONLY key: the parked
 * refusal written under it before the move is adopted once, then swept.
 */
export const THROTTLE_ID = "sensenova-console-throttle";

/**
 * The namespace this plugin used before the rename.
 *
 * Read for MIGRATION ONLY: an account and grant saved under the old name must
 * survive the rename, or the panel would demand a fresh login and abandon a
 * refresh token that is still good. Nothing is ever written here again; each
 * legacy record is adopted once and deleted.
 */
export const LEGACY_SCOPE = "dsh-llm-rate-panel";

/**
 * The Raccoon credential store — the DSH credentials-service half of the
 * second upstream provider.
 *
 * The token pair (plus its metadata) is stored as ONE reference value named
 * `RACCOON_CREDENTIAL` — the same reference-value mechanism `api-key-store.ts`
 * uses for `SENSENOVA_API_KEY`: the credentials service admits reference
 * values, and this keeps the whole credential in one owner-only
 * `~/.dsh/.credentials.yaml` entry, never in this plugin's directory, git,
 * or logs. The value is a JSON document of the token pair; a private record
 * KIND is NOT invented (red line 2) — a reference value is the admitted shape.
 *
 * The load-bearing difference from the Token Plan store: the Raccoon refresh
 * token is SINGLE-USE (the server rotates BOTH tokens). A refresh therefore
 * always re-stores the whole pair (`save` after `refresh`), so the rotated
 * refresh token is not lost in flight. The desktop-file write-back route is
 * rejected by design (ROADMAP §6.1.1: it 401s and can log the user out of the
 * App), so this store is the ONLY owner of the credential.
 *
 * Precedence, per read: the credentials service, then this process's memory
 * (a Host with no credentials service). A `null` credentials service leaves
 * the credential in-memory only, so it is `ephemeral` (mirrors token-store).
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-store
 */

import { obj, str } from "./util.ts";
import {
  decodeRaccoonJwtExpMs,
  refreshRaccoonCredential,
  isDeadRaccoonSession,
  RACCOON_CODE
} from "./raccoon.ts";
import type { RaccoonCodeValue } from "./raccoon.ts";
import type { RaccoonStoreDeps } from "./types.ts";

/** The reference name the credential pair is stored under. */
export const RACCOON_CREDENTIAL_REF = "RACCOON_CREDENTIAL";

/**
 * Parse the stored credential JSON; a malformed or absent value reads as no
 * credential rather than an error — the safe direction (one re-login, never a
 * crash).
 * @param {unknown} value - the reference value.
 * @returns {object|null} `{ accessToken, refreshToken, expiresAtMs, officeIdentity, nickname }` or `null`.
 */
export function parseRaccoonCredential(value: unknown): { accessToken: string; refreshToken: string; expiresAtMs?: number; officeIdentity: string; nickname: string } | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const source = obj(parsed);
  const accessToken = str(source.access_token, "");
  if (accessToken === "") return null;
  const refresh = str(source.refresh_token, "");
  const expiresAtMs = decodeRaccoonJwtExpMs(accessToken) ?? (typeof source.expires_at_ms === "number" ? source.expires_at_ms : undefined);
  return {
    accessToken,
    refreshToken: refresh,
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    officeIdentity: str(source.office_identity, ""),
    nickname: str(source.nickname, "")
  };
}

/**
 * Serialize one credential for storage.
 * @param {object} credential - `{ accessToken, refreshToken?, expiresAtMs?, officeIdentity?, nickname? }`.
 * @returns {string} the JSON document.
 */
export function serializeRaccoonCredential(credential: { accessToken?: unknown; refreshToken?: unknown; expiresAtMs?: unknown; officeIdentity?: unknown; nickname?: unknown }): string {
  const source = obj(credential);
  const out = {
    version: 1,
    access_token: str(source.accessToken, ""),
    refresh_token: str(source.refreshToken, ""),
    ...(typeof source.expiresAtMs === "number" ? { expires_at_ms: source.expiresAtMs } : {}),
    ...(str(source.officeIdentity, "") !== "" ? { office_identity: source.officeIdentity } : {}),
    ...(str(source.nickname, "") !== "" ? { nickname: source.nickname } : {})
  };
  return JSON.stringify(out);
}

/**
 * Build the credential store.
 * @param {object} [options] - wiring.
 * @param {object|Function|null} [options.credentials] - the `ctx.credentials`
 *   service, a resolver, or `null` (resolved on EVERY use, like
 *   `api-key-store`: the service may register after this plugin mounts).
 * @param {typeof fetch} [options.fetcher] - injected fetch for the refresh
 *   call (tests stub it; defaults to global `fetch`).
 * @returns {{save, forget, resolve, refresh, prepareForRequest, state}}
 */
export function createRaccoonStore({ credentials = null, fetcher }: RaccoonStoreDeps = {}) {
  /** Fallback vault for a Host that has no credentials service. */
  const memory = new Map();
  /** Single-flight: a refresh already in flight is shared, never raced. */
  let refreshInFlight: Promise<{ ok: boolean; code?: RaccoonCodeValue; message?: string }> | null = null;
  /**
   * Latched when the gateway declares the session dead (401 / `200003`).
   *
   * The problem this answers: the three eager-refresh call sites all
   * funnel through `prepareForRequest`, so a dead session meant one
   * guaranteed-401 request per poll cycle, forever — the access token's own window keeps the
   * condition true and the gateway's answer never changes. Token Plan has
   * `throttle-store.ts` for exactly this shape of upstream refusal; the second
   * upstream had nothing, which is why the two halves answered the same problem
   * differently.
   *
   * In-process only, and deliberately so: it is a COURTEOUS decision about one
   * credential, not a fact about the machine, so it must not become a file (the
   * credential could be replaced out from under it by a fresh login elsewhere,
   * and a stale "dead" mark would then lock out a valid session). `save()`
   * clears it, so a re-scan always re-opens the door.
   */
  let sessionDead = false;

  const resolveService = () => {
    const value = typeof credentials === "function" ? credentials() : credentials;
    return value ?? null;
  };

  const storeNow = async (credential: { accessToken?: unknown; refreshToken?: unknown; expiresAtMs?: unknown; officeIdentity?: unknown; nickname?: unknown }) => {
    const serialized = serializeRaccoonCredential(credential);
    const service = resolveService();
    if (service !== null && typeof service.set === "function") {
      await service.set(RACCOON_CREDENTIAL_REF, serialized);
      memory.set(RACCOON_CREDENTIAL_REF, serialized);
    } else {
      memory.set(RACCOON_CREDENTIAL_REF, serialized);
    }
  };

  return {
    /**
     * Persist a freshly-logged-in credential pair.
     * @param {object} credential - `{ accessToken, refreshToken?, ... }`.
     */
    async save(credential: { accessToken?: unknown; refreshToken?: unknown; expiresAtMs?: unknown; officeIdentity?: unknown; nickname?: unknown }) {
      const accessToken = str(credential?.accessToken, "");
      if (accessToken === "") throw new Error("a Raccoon access token is required");
      // A fresh scan is the ONLY thing that recovers a dead session, so it must
      // clear the latch on the way in — otherwise a re-scan would store a valid
      // pair and still be refused by the very next poll.
      sessionDead = false;
      await storeNow(credential);
    },

    /**
     * Forget the stored credential (the panel's "logout"). Both the durable
     * reference and the in-memory copy are cleared.
     */
    async forget() {
      sessionDead = false;
      memory.delete(RACCOON_CREDENTIAL_REF);
      try {
        const service = resolveService();
        if (service !== null && typeof service.unset === "function") {
          await service.unset(RACCOON_CREDENTIAL_REF);
        }
      } catch {
        // The in-memory copy is already gone; nothing else to do.
      }
    },

    /**
     * Resolve the live credential and where it came from.
     * @returns {Promise<{credential: object|null, source: ("credentials"|"memory"|null)}>}
     */
    async resolve() {
      try {
        const service = resolveService();
        if (service !== null && typeof service.resolve === "function") {
          const resolved = await service.resolve(RACCOON_CREDENTIAL_REF).catch(() => undefined);
          const credential = parseRaccoonCredential(resolved?.value);
          if (credential !== null) return { credential, source: "credentials" };
        }
      } catch {
        // No usable answer from the service: fall through to memory.
      }
      const held = parseRaccoonCredential(memory.get(RACCOON_CREDENTIAL_REF));
      if (held !== null) return { credential: held, source: "memory" };
      return { credential: null, source: null };
    },

    /**
     * Whether the stored credential is within its expiry window.
     *
     * A latched dead session reads as expired WITHOUT asking the gateway: the
     * stored access token may still be inside its own window (the panel keeps
     * serving it, which is correct — `test/raccoon.test.mjs` pins that the pair
     * is not clobbered on a dead refresh), while the refresh token is already
     * worthless. Reporting `false` here would let a poll believe there is
     * nothing to renew, so the answer has to stay `true` to keep the existing
     * `prepareForRequest` call sites working — the gate is inside
     * {@link refresh}, which short-circuits without a network call.
     * @param {number} [leadMs] - renew this long before expiry; defaults to 5 min.
     */
    async isExpired(leadMs = 5 * 60 * 1000) {
      const { credential } = await this.resolve();
      if (credential === null) return true;
      if (sessionDead) return true;
      if (credential.expiresAtMs === undefined) return false;
      return Date.now() >= credential.expiresAtMs - leadMs;
    },

    /**
     * Refresh the credential pair IN PLACE (the single-use refresh token is
     * rotated server-side, so the NEW pair is what gets stored). Single-
     * flighted: a second concurrent call joins the first, so a pair can never
     * be rotated twice and orphaned.
     * @returns {Promise<{ok: boolean, code?: RaccoonCodeValue}>}
     */
    async refresh() {
      // The latch, in one place: every eager-refresh call site funnels through
      // here, so this is the only line that has to know a dead session is not
      // worth re-asking. Short-circuit BEFORE any network call, and report the
      // same code the gateway gave, so a caller that inspects the result sees
      // the truth rather than a synthetic "skipped".
      if (sessionDead) return { ok: false, code: RACCOON_CODE.SESSION_DEAD };
      if (refreshInFlight === null) {
        refreshInFlight = (async () => {
          try {
            const { credential } = await this.resolve();
            if (credential === null) return { ok: false, code: RACCOON_CODE.NOT_CONFIGURED };
            const rotated = await refreshRaccoonCredential({ refresh_token: credential.refreshToken }, fetcher);
            if (!rotated.ok) {
              // Only a gateway verdict latches; a network error or an
              // unrecognized refusal stays retryable, or a blip would cost the
              // user a login they did not need to redo.
              if (isDeadRaccoonSession(rotated.code)) sessionDead = true;
              return rotated;
            }
            await storeNow({
              accessToken: rotated.accessToken,
              refreshToken: rotated.refreshToken,
              ...(rotated.expiresAtMs !== undefined ? { expiresAtMs: rotated.expiresAtMs } : {}),
              officeIdentity: credential.officeIdentity,
              nickname: credential.nickname
            });
            return { ok: true };
          } finally {
            refreshInFlight = null;
          }
        })();
      }
      return refreshInFlight;
    },

    /**
     * The one-call pre-request ritual the three call sites used to
     * hand-copy — `if (isExpired()) refresh()` — now owned here so none of
     * them can drift: check the expiry window and refresh in place when it
     * is crossed.
     *
     * Never throws: a failed refresh (no credential, a dead session the
     * latch already owns, a network blip) leaves the stored pair in place,
     * and the caller's gateway 401 remains the honest signal — the same
     * "swallow it, the real reason was already logged where it happened"
     * policy as `state()`.
     * @returns {Promise<void>}
     */
    async prepareForRequest() {
      if (await this.isExpired().catch(() => false)) {
        await this.refresh().catch(() => {});
      }
    },

    /**
     * The secret-free description the routes and panel report.
     * @returns {Promise<{hasCredential: boolean, source: ("credentials"|"memory"|null), ephemeral: boolean, nickname: string, expiresAtMs: number|null, refreshExpiresAtMs?: number}>}
     */
    async state() {
      const { credential, source } = await this.resolve();
      // The refresh token's own window (≈30 days): how long the login survives
      // WITHOUT a re-scan. Absent when the walk never carried one.
      const refreshExpiresAtMs = credential?.refreshToken !== undefined && credential.refreshToken !== ""
        ? decodeRaccoonJwtExpMs(credential.refreshToken)
        : undefined;
      return {
        hasCredential: credential !== null,
        source,
        ephemeral: resolveService() === null,
        nickname: credential?.nickname ?? "",
        expiresAtMs: credential?.expiresAtMs ?? null,
        ...(refreshExpiresAtMs !== undefined ? { refreshExpiresAtMs } : {})
      };
    }
  };
}

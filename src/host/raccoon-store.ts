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
  refreshRaccoonCredential
} from "./raccoon.ts";
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
export function parseRaccoonCredential(value) {
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
export function serializeRaccoonCredential(credential) {
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
 * @returns {{save, forget, resolve, refresh, state}}
 */
export function createRaccoonStore({ credentials = null, fetcher }: RaccoonStoreDeps = {}) {
  /** Fallback vault for a Host that has no credentials service. */
  const memory = new Map();
  /** Single-flight: a refresh already in flight is shared, never raced. */
  let refreshInFlight = null;

  const resolveService = () => {
    const value = typeof credentials === "function" ? credentials() : credentials;
    return value ?? null;
  };

  const storeNow = async (credential) => {
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
    async save(credential) {
      const accessToken = str(credential?.accessToken, "");
      if (accessToken === "") throw new Error("a Raccoon access token is required");
      await storeNow(credential);
    },

    /**
     * Forget the stored credential (the panel's "logout"). Both the durable
     * reference and the in-memory copy are cleared.
     */
    async forget() {
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
     * @param {number} [leadMs] - renew this long before expiry; defaults to 5 min.
     */
    async isExpired(leadMs = 5 * 60 * 1000) {
      const { credential } = await this.resolve();
      if (credential === null) return true;
      if (credential.expiresAtMs === undefined) return false;
      return Date.now() >= credential.expiresAtMs - leadMs;
    },

    /**
     * Refresh the credential pair IN PLACE (the single-use refresh token is
     * rotated server-side, so the NEW pair is what gets stored). Single-
     * flighted: a second concurrent call joins the first, so a pair can never
     * be rotated twice and orphaned.
     * @returns {Promise<{ok: boolean, code?: string}>}
     */
    async refresh() {
      if (refreshInFlight === null) {
        refreshInFlight = (async () => {
          try {
            const { credential } = await this.resolve();
            if (credential === null) return { ok: false, code: "not_configured" };
            const rotated = await refreshRaccoonCredential({ refresh_token: credential.refreshToken }, fetcher);
            if (!rotated.ok) return rotated;
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

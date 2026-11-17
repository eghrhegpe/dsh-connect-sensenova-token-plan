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
 * refresh token is not lost in flight.
 *
 * TWO SOURCES, ONE SLOT (ROADMAP §6.1.11). This store answers the same
 * `resolve()` for two origins, and the distinction is load-bearing:
 *
 *   - `qr-scan` — the credential this plugin logged in and OWNS: refreshable,
 *     `save`/`forget` apply, stored under `RACCOON_CREDENTIAL`;
 *   - `desktop-file` — a READ-ONLY VIEW of the official App's own credential
 *     (`raccoon-desktop-creds.ts`, opt-in switch off by default). The App owns
 *     that file; this store must never refresh it, never `save()` over it, and
 *     never copy it into the credentials service. `refresh()` refuses it
 *     locally and `prepareForRequest()` short-circuits before any network
 *     call — that is what keeps the write-back route (rejected since §6.1.1,
 *     still rejected) unreachable from here.
 *
 * Precedence is per read, not a mode the user switches between: a switched-on,
 * fresh desktop file wins; anything else (switch off, App closed, App rotated
 * to an expired token) falls through to the scanned pair untouched, so turning
 * the source off never costs a login and a working scan is never destroyed.
 *
 * Within OUR OWN slot, precedence per read is the credentials service, then
 * this process's memory (a Host with no credentials service). A `null`
 * credentials service leaves the credential in-memory only, so it is
 * `ephemeral` (mirrors token-store).
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-store
 */

import { isEphemeral, resolveCredentialsService } from "./credentials-service.ts";
import { obj, str, verbatim } from "./util.ts";
import {
  decodeRaccoonJwtExpMs,
  refreshRaccoonCredential,
  isDeadRaccoonSession,
  RACCOON_CODE
} from "./raccoon.ts";
import type { RaccoonCodeValue } from "./raccoon.ts";
import type { RaccoonStoreDeps } from "./types.ts";
import { RACCOON_ORIGIN_DESKTOP, RACCOON_ORIGIN_QR } from "./raccoon-desktop-creds.ts";

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
  const accessToken = verbatim(source.access_token, "");
  if (accessToken === "") return null;
  const refresh = verbatim(source.refresh_token, "");
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
    // Verbatim: these two are replayed to the gateway and the token endpoint
    // byte for byte. Trimming is a change the user cannot see, and a stored
    // token that no longer matches the one the platform signed fails with a
    // 401 that has no trace back to this line (util.ts `verbatim`).
    access_token: verbatim(source.accessToken, ""),
    refresh_token: verbatim(source.refreshToken, ""),
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
 * @returns {{save, forget, resolve, origin, refresh, prepareForRequest, state, desktopState}}
 */
export function createRaccoonStore({ credentials = null, fetcher, desktop }: RaccoonStoreDeps = {}) {
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

  /**
   * The desktop file as a live credential, or `null` — the whole gate in one
   * place so no call site can forget the switch. Any doubt reads as `null`
   * (which means "answer from our own slot"), never as a failure: the scanned
   * credential is the safer of the two answers when the file is in an
   * unrecognised state.
   * @returns {Promise<object|null>} `{ credential, expiresAtMs }` or null.
   */
  const desktopCredential = async () => {
    if (typeof desktop?.read !== "function") return null;
    try {
      if (typeof desktop.enabled === "function" && (await desktop.enabled()) !== true) return null;
      const outcome = await desktop.read();
      if (outcome?.ok !== true) return null;
      const accessToken = verbatim(outcome.credential?.accessToken, "");
      if (accessToken === "") return null;
      return { credential: outcome.credential, expiresAtMs: outcome.expiresAtMs };
    } catch {
      return null;
    }
  };

  const storeNow = async (credential: { accessToken?: unknown; refreshToken?: unknown; expiresAtMs?: unknown; officeIdentity?: unknown; nickname?: unknown }) => {
    const serialized = serializeRaccoonCredential(credential);
    const service = resolveCredentialsService(credentials);
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
      const accessToken = verbatim(credential?.accessToken, "");
      if (accessToken === "") throw new Error("a Raccoon access token is required");
      // A fresh scan is the ONLY thing that recovers a dead session, so it must
      // clear the latch on the way in — otherwise a re-scan would store a valid
      // pair and still be refused by the very next poll.
      sessionDead = false;
      await storeNow(credential);
    },

    /**
     * Forget the stored credential (the panel's "logout"). Both the durable
     * reference and the in-memory copy are cleared. What it does NOT touch is
     * the App's file — that credential is not ours to delete, and the desktop
     * source has its own switch (§6.1.11).
     */
    async forget() {
      sessionDead = false;
      memory.delete(RACCOON_CREDENTIAL_REF);
      try {
        const service = resolveCredentialsService(credentials);
        if (service !== null && typeof service.unset === "function") {
          await service.unset(RACCOON_CREDENTIAL_REF);
        }
      } catch {
        // The in-memory copy is already gone; nothing else to do.
      }
    },

    /**
     * Resolve the live credential and where it came from.
     *
     * `source` names the vault the answer came out of — `"desktop-file"` (the
     * App's file, read-only), `"credentials"`, `"memory"`, or null.
     * `origin` answers the question the panel badges: whose login is actually
     * serving requests right now (`desktop-file` / `qr-scan`).
     * @returns {Promise<{credential: object|null, source: ("desktop-file"|"credentials"|"memory"|null), origin: ("desktop-file"|"qr-scan"|null)}>}
     */
    async resolve() {
      const fromApp = await desktopCredential();
      if (fromApp !== null) {
        return {
          credential: { ...fromApp.credential, origin: RACCOON_ORIGIN_DESKTOP },
          source: RACCOON_ORIGIN_DESKTOP,
          origin: RACCOON_ORIGIN_DESKTOP
        };
      }
      try {
        const service = resolveCredentialsService(credentials);
        if (service !== null && typeof service.resolve === "function") {
          const resolved = await service.resolve(RACCOON_CREDENTIAL_REF).catch(() => undefined);
          const credential = parseRaccoonCredential(resolved?.value);
          if (credential !== null) return { credential, source: "credentials", origin: RACCOON_ORIGIN_QR };
        }
      } catch {
        // No usable answer from the service: fall through to memory.
      }
      const held = parseRaccoonCredential(memory.get(RACCOON_CREDENTIAL_REF));
      if (held !== null) return { credential: held, source: "memory", origin: RACCOON_ORIGIN_QR };
      return { credential: null, source: null, origin: null };
    },

    /**
     * The secret-free answer the panel needs about the desktop source: is the
     * switch on, is the App's credential usable right now, and if not, why in
     * category terms. Never carries a path, a token, or a size.
     * @returns {Promise<{supported: boolean, enabled: boolean, available: boolean, reason?: string, expiresAtMs?: number|null}>}
     *   `supported: false` when no desktop source was wired at all (the module
     *   is absent, so the panel hides the row instead of showing a dead switch).
     */
    async desktopState() {
      if (typeof desktop?.read !== "function") return { supported: false, enabled: false, available: false };
      const enabled = typeof desktop.enabled === "function" ? (await desktop.enabled().catch(() => null)) === true : false;
      if (!enabled) return { supported: true, enabled: false, available: false };
      try {
        const outcome = await desktop.read();
        if (outcome?.ok === true) return { supported: true, enabled: true, available: true, expiresAtMs: outcome.expiresAtMs ?? null };
        return { supported: true, enabled: true, available: false, ...(typeof outcome?.reason === "string" ? { reason: outcome.reason } : {}) };
      } catch {
        return { supported: true, enabled: true, available: false, reason: "unreadable" };
      }
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
      const { credential, origin } = await this.resolve();
      // The App owns this credential; there is nothing here to renew. The
      // reader already refused anything inside its freshness margin, and when
      // the file does lapse the NEXT resolve() answers with the scanned pair —
      // so "not expired" is the honest answer for the one we are serving.
      if (origin === RACCOON_ORIGIN_DESKTOP) return false;
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
      // The App's credential is not ours to rotate, in either direction: a
      // refresh would burn the single-use token behind it (§6.1.1) AND leave us
      // holding the new one while the App still has the old. Refuse locally —
      // this line is ABOVE the network call on purpose, so the gateway never
      // sees a desktop-origin rotation attempt, and NO_REFRESH_TOKEN is not a
      // dead-session verdict, so it cannot latch the scan out.
      if ((await this.resolve()).origin === RACCOON_ORIGIN_DESKTOP) return { ok: false, code: RACCOON_CODE.NO_REFRESH_TOKEN };
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
     * That check is the last one here — the outer `isExpired` guard in
     * `raccoon-status.ts` is a fast path, not a duplicate: it lets an
     * already-live credential skip the `state()` re-read entirely.
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
      const { credential, source, origin } = await this.resolve();
      // The refresh token's own window (≈30 days): how long the login survives
      // WITHOUT a re-scan. Absent when the walk never carried one.
      const refreshExpiresAtMs = credential?.refreshToken !== undefined && credential.refreshToken !== ""
        ? decodeRaccoonJwtExpMs(credential.refreshToken)
        : undefined;
      return {
        hasCredential: credential !== null,
        source,
        // `desktop-file` or `qr-scan`: whose login the panel should say it is
        // using. `source` stays the diagnostics field (it is gated to ?debug=1
        // by `raccoon-status.ts`), so this is the one ordinary callers read.
        credentialOrigin: origin,
        ephemeral: isEphemeral(credentials),
        nickname: credential?.nickname ?? "",
        expiresAtMs: credential?.expiresAtMs ?? null,
        ...(refreshExpiresAtMs !== undefined ? { refreshExpiresAtMs } : {})
      };
    }
  };
}

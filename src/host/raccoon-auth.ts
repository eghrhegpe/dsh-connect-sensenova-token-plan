/**
 * The Raccoon authentication operations: generate a scan code, poll its status,
 * and rotate a credential pair. The endpoints and the prose about the login
 * flow (mechanism reference, not ported) are the second upstream's core wire
 * knowledge.
 *
 * Split out of the former single `raccoon.ts` (2026-10-05). The login ORCHESTRATION
 * (the timed walk, the store hand-off) was already elsewhere — `raccoon-walk.ts`
 * drives the cadence and `raccoon-store.ts` owns the credential write-back; this
 * module is the protocol half they call.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-auth
 */

import { randomBytes } from "node:crypto";
import { obj, str, errMsg } from "./util.ts";
import { RACCOON_API_BASE, RACCOON_AUTH_PREFIX } from "./raccoon-consts.ts";
import {
  parseRaccoonEnvelope,
  decodeRaccoonJwtExpMs,
  extractRaccoonNickname
} from "./raccoon-http.ts";
import type { RaccoonQrPollResult } from "./raccoon-http.ts";
import { RACCOON_CODE, isDeadRaccoonEnvelope } from "./raccoon-codes.ts";
import type { RaccoonCodeValue } from "./raccoon-codes.ts";

/** The WeChat-QR login page the phone opens after a scan. */
export function raccoonQrLoginUrl(code: string): string {
  const params = new URLSearchParams({ code: str(code, ""), appname: "商汤小浣熊官网" });
  return `${RACCOON_API_BASE}/login/mp?${params.toString()}`;
}

/**
 * One 32-hex scan code (16 random bytes), the exact shape the gateway's own
 * client generates. Any self-made code is accepted and held `pending` until a
 * phone confirms it, so generation is local and needs no server round-trip.
 * @returns {string} the code.
 */
export function generateRaccoonQrCode() {
  return randomBytes(16).toString("hex");
}

/** The QR poll's status values, exactly as the gateway spells them. */
export const RACCOON_QR_STATUS = Object.freeze({
  PENDING: "pending",
  LOGGING: "logging",
  CANCELED: "canceled",
  SUCCESS: "success"
});

/**
 * One poll of the QR login status. Any anomaly degrades to `pending`: the
 * caller polls on a 2 s cadence, and a transient network hiccup or an unknown
 * status must never read as `success` (an empty token would stall the flow)
 * or `canceled` (a live scan would be voided).
 * @param {string} code - the scan code being polled.
 * @param {typeof fetch} [fetcher] - injected fetch.
 * @returns {Promise<object>} `{ status }` plus, on success, the token pair.
 */
export async function pollRaccoonQrLogin(code: string, fetcher?: typeof fetch): Promise<RaccoonQrPollResult> {
  const effective = fetcher ?? globalThis.fetch;
  let envelope;
  try {
    const response = await effective(
      `${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}/login_with_qrcode_code`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ qrcode_code: str(code, "") })
      }
    );
    envelope = parseRaccoonEnvelope(await response.json().catch(() => ({})), response.status);
  } catch {
    return { status: RACCOON_QR_STATUS.PENDING };
  }
  if (envelope.code !== 0 || envelope.data === null) return { status: RACCOON_QR_STATUS.PENDING };

  const rawStatus = str(envelope.data.status, "");
  if (rawStatus === RACCOON_QR_STATUS.CANCELED) return { status: RACCOON_QR_STATUS.CANCELED };
  if (rawStatus === RACCOON_QR_STATUS.LOGGING) {
    return { status: RACCOON_QR_STATUS.LOGGING, ...(str(envelope.data.expired_at, "") !== "" ? { expiredAt: str(envelope.data.expired_at, "") } : {}) };
  }
  if (rawStatus === RACCOON_QR_STATUS.SUCCESS) {
    const accessToken = str(envelope.data.access_token, "");
    // A success without a token is "not done yet": an empty credential would
    // stall the flow, so it stays pending for the next poll.
    if (accessToken === "") return { status: RACCOON_QR_STATUS.PENDING };
    const refreshToken = str(envelope.data.refresh_token, "");
    const expMs = decodeRaccoonJwtExpMs(accessToken);
    return {
      status: RACCOON_QR_STATUS.SUCCESS,
      accessToken,
      refreshToken,
      ...(expMs !== undefined ? { expiresAtMs: expMs } : {}),
      // The account display name, extracted defensively (see
      // `extractRaccoonNickname`) — `""` when the payload carries none.
      nickname: extractRaccoonNickname(envelope.data, accessToken),
      // Field NAMES only (never values): the caller logs this once per login,
      // so an unprobed corner of the envelope becomes evidence on the next
      // real scan instead of a silent data breakpoint.
      dataFields: Object.keys(envelope.data).sort()
    };
  }
  return { status: RACCOON_QR_STATUS.PENDING };
}

/**
 * Rotate a credential pair through the refresh endpoint. The response carries
 * the NEW pair (the refresh token is single-use — the server rotates both), so
 * the caller must re-store what this returns; keeping the old refresh token is
 * what strands a desktop-file route in a 401 loop.
 * @param {object} credential - `{ refresh_token }`.
 * @param {typeof fetch} [fetcher] - injected fetch.
 * @returns {Promise<object>} `{ ok, accessToken, refreshToken, expiresAtMs?, code?, message? }`.
 */
export async function refreshRaccoonCredential(
  credential: any,
  fetcher?: typeof fetch
): Promise<{ ok: boolean; code?: RaccoonCodeValue; message?: string; accessToken?: string; refreshToken?: string; expiresAtMs?: number }> {
  const effective = fetcher ?? globalThis.fetch;
  const refreshToken = str(obj(credential).refresh_token, "");
  if (refreshToken === "") return { ok: false, code: RACCOON_CODE.NO_REFRESH_TOKEN, message: "the stored credential has no refresh token" };
  let envelope;
  try {
    const response = await effective(
      // Path verified 2026-10-01 with a LIVE credential: `/refresh_token`
      // answers a bare `404 page not found` (path absent), while `/refresh`
      // answers `400 params_invalid_error` with a deliberately bogus token —
      // the path exists and reaches the business layer. The `_token` suffix
      // this code used to append was the copy-over from the reference
      // plugin's constant set, and it made every refresh fail, so an expired
      // access token could only be recovered by re-scanning the QR code.
      `${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}/refresh`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken })
      }
    );
    envelope = parseRaccoonEnvelope(await response.json().catch(() => ({})), response.status);
  } catch (error) {
    return { ok: false, code: RACCOON_CODE.REFRESH_FAILED, message: errMsg(error) };
  }
  if (envelope.code !== 0 || envelope.data === null) {
    // A 401 is the gateway's dead-session signal whether or not the BODY
    // parsed: `RACCOON_DEAD_SESSION_CODES` names it as such, but that set was
    // only ever consulted against the JSON envelope — a plain-text (or
    // unparseable) 401 body reads as `code: -1`, which is NOT in the set,
    // and would be classified transient. The store's latch then keeps
    // knocking on a session only a fresh scan recovers, one guaranteed-401
    // per poll, indefinitely. So the HTTP status joins the dead decision,
    // not just the body.
    const dead = isDeadRaccoonEnvelope(envelope.code) || isDeadRaccoonEnvelope(envelope.status);
    return {
      ok: false,
      code: dead ? RACCOON_CODE.SESSION_DEAD : RACCOON_CODE.REFRESH_REJECTED,
      message: envelope.message || `refresh refused (code ${envelope.code})`
    };
  }
  const accessToken = str(envelope.data.access_token, "");
  if (accessToken === "") return { ok: false, code: RACCOON_CODE.REFRESH_REJECTED, message: "the refresh response carried no access token" };
  const refreshTokenOut = str(envelope.data.refresh_token, "");
  const expMs = decodeRaccoonJwtExpMs(accessToken);
  return { ok: true, accessToken, refreshToken: refreshTokenOut, ...(expMs !== undefined ? { expiresAtMs: expMs } : {}) };
}

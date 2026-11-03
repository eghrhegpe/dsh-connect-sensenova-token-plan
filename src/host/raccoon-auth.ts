/**
 * The Raccoon authentication operations: generate a scan code, poll its status,
 * and rotate a credential pair. The endpoints and the prose about the login
 * flow (mechanism reference, not ported) are the second upstream's core wire
 * knowledge.
 *
 * The login ORCHESTRATION (the timed walk, the store hand-off) lives elsewhere —
 * `raccoon-walk.ts` drives the cadence and `raccoon-store.ts` owns the
 * credential write-back; this module is the protocol half they call.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-auth
 */

import { randomBytes } from "node:crypto";
import { obj, str, verbatim, errMsg } from "./util.ts";
import {
  RACCOON_API_BASE,
  RACCOON_AUTH_PREFIX,
  RACCOON_IAM_AUTH_PREFIX,
  RACCOON_LOGIN_TIMEOUT_MS,
  RACCOON_QR_POLL_INTERVAL_MS
} from "./raccoon-consts.ts";
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
    const accessToken = verbatim(envelope.data.access_token, "");
    // A success without a token is "not done yet": an empty credential would
    // stall the flow, so it stays pending for the next poll.
    if (accessToken === "") return { status: RACCOON_QR_STATUS.PENDING };
    const refreshToken = verbatim(envelope.data.refresh_token, "");
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
 * A scan that has been issued and is ready to poll: the code to hand the
 * poller and the URL to put in the QR, and — for a server-issued scan — the
 * server's own deadline and cadence. The walk's DEFAULT (no `issueCode`
 * option) is the legacy local codegen, so a walk built without one keeps
 * working against a gateway that has moved on.
 */
export interface RaccoonIssuedScan {
  /** The code the poller polls. */
  code: string;
  /** The confirm-page URL the QR encodes. */
  url: string;
  /** The code came from the gateway's codegen: poll it with `pollIam`. */
  iam?: boolean;
  /** The server-stated expiry, as an absolute ms timestamp. */
  deadlineMs?: number;
  /** The server-stated poll cadence, in ms. */
  pollIntervalMs?: number;
  /** The confirm page answered 404: the walk ends as `unavailable`. */
  unavailable?: boolean;
}

/**
 * Server-issued QR codegen (2026-11: the gateway moved code issuance to
 * `POST /api/iam/v1/auth/mp/qrcode`). The response envelope is the string
 * `code: "OK"` half of the raccoon wire — the web-auth family's numeric
 * `code: 0` parser does not apply here. `data` carries the `qr-`-prefixed
 * `qrcode_code`, the confirm page's `scan_path`, and the server's own
 * `expires_in` / `poll_interval` seconds.
 * @param {typeof fetch} [fetcher] - injected fetch.
 * @returns {Promise<object|null>} the issued scan's wire facts, or `null` on
 *   any refusal, malformed envelope, or transport failure — the caller falls
 *   back to the legacy local codegen.
 */
export async function createRaccoonIamQr(fetcher?: typeof fetch): Promise<{
  code: string;
  scanPath: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
} | null> {
  const effective = fetcher ?? globalThis.fetch;
  let body: { code?: unknown; data?: unknown } | null;
  try {
    const response = await effective(`${RACCOON_API_BASE}${RACCOON_IAM_AUTH_PREFIX}/auth/mp/qrcode`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({})
    });
    body = (await response.json().catch(() => null)) as { code?: unknown; data?: unknown } | null;
  } catch {
    return null;
  }
  if (body === null || str(body.code, "") !== "OK") return null;
  const data = obj(body.data);
  if (data === null) return null;
  const code = str(data.qrcode_code, "");
  if (code === "") return null;
  const scanPath = str(data.scan_path, "") !== "" ? str(data.scan_path, "") : "/login/mp";
  const expiresIn = Number(data.expires_in);
  const pollInterval = Number(data.poll_interval);
  return {
    code,
    scanPath,
    // A missing cadence must not read as "never expires": fall back to the
    // walk's own wire facts (the 5-min deadline, the 2 s cadence).
    expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : RACCOON_LOGIN_TIMEOUT_MS / 1000,
    pollIntervalSeconds: Number.isFinite(pollInterval) && pollInterval > 0 ? pollInterval : RACCOON_QR_POLL_INTERVAL_MS / 1000
  };
}

/**
 * The confirm-page URL for a server-issued code: the server's own
 * `scan_path` (probed 2026-11: `/login/mp`) plus the query params the
 * site's own client sends — `code`, `appname`, and `source=platform`
 * (the legacy `raccoonQrLoginUrl` omits the last; a page that comes back
 * may key on it).
 */
export function raccoonIamQrUrl(code: string, scanPath: string): string {
  const path = scanPath.startsWith("/") ? scanPath : `/${scanPath}`;
  const params = new URLSearchParams({ code: str(code, ""), appname: "商汤小浣熊官网", source: "platform" });
  return `${RACCOON_API_BASE}${path}?${params.toString()}`;
}

/**
 * One poll of a SERVER-ISSUED scan. The endpoint is the site's own login
 * poll (`POST /api/iam/v1/auth/mp/qrcode/login`), whose envelope is the
 * string `code: "OK"` half, so the numeric parser does not apply.
 *
 * Every anomaly degrades to `pending`, exactly like the legacy poll: the
 * server's own expiry surfaces here as the AUTH_QRCODE error codes rather
 * than a status, and the walk's deadline — set from the same `expires_in`
 * at issue time — is what turns that into a `timeout`.
 *
 * The success payload observed in 2026-11 carries an `access_token` and NO
 * `refresh_token` (the official site's flow takes the access token only):
 * `refreshToken` is therefore stored as `""` and the credential is
 * access-only — the store already shapes that (a rotation-less credential
 * works until the access token expires, then the panel offers a re-scan;
 * `refreshRaccoonCredential`'s NO_REFRESH_TOKEN is not a dead-session
 * latch).
 * @param {string} code - the issued `qrcode_code` (a `qr-` server code or a
 *   legacy 32-hex one: the gateway's code spaces are shared, probed 2026-11).
 * @param {typeof fetch} [fetcher] - injected fetch.
 * @returns {Promise<object>} `{ status }` plus, on success, the token pair.
 */
export async function pollRaccoonIamQrLogin(code: string, fetcher?: typeof fetch): Promise<RaccoonQrPollResult> {
  const effective = fetcher ?? globalThis.fetch;
  let body: { code?: unknown; data?: unknown } | null;
  try {
    const response = await effective(`${RACCOON_API_BASE}${RACCOON_IAM_AUTH_PREFIX}/auth/mp/qrcode/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ qrcode_code: str(code, "") })
    });
    body = (await response.json().catch(() => null)) as { code?: unknown; data?: unknown } | null;
  } catch {
    return { status: RACCOON_QR_STATUS.PENDING };
  }
  const data = body === null ? null : obj(body.data);
  const rawStatus = data === null ? "" : str(data.status, "");
  if (rawStatus === RACCOON_QR_STATUS.CANCELED) return { status: RACCOON_QR_STATUS.CANCELED };
  if (rawStatus === RACCOON_QR_STATUS.SUCCESS) {
    // A success without a token is "not done yet": an empty credential would
    // stall the flow, so it stays pending for the next poll (the legacy
    // poll's same rule, restated for this envelope).
    const accessToken = data === null ? "" : verbatim(data.access_token, "");
    if (data === null || accessToken === "") return { status: RACCOON_QR_STATUS.PENDING };
    const refreshToken = verbatim(data.refresh_token, "");
    const expMs = decodeRaccoonJwtExpMs(accessToken);
    return {
      status: RACCOON_QR_STATUS.SUCCESS,
      accessToken,
      refreshToken,
      ...(expMs !== undefined ? { expiresAtMs: expMs } : {}),
      // The account display name, extracted defensively (see
      // `extractRaccoonNickname`) — the IAM flow's name claim rides the JWT
      // when the payload carries none.
      nickname: extractRaccoonNickname(data, accessToken),
      // Field NAMES only (never values): the caller logs this once per login,
      // so an unprobed corner of the new envelope becomes evidence on the
      // next real scan instead of a silent data breakpoint.
      dataFields: Object.keys(data).sort()
    };
  }
  // `logging` (the phone is mid-confirm), the AUTH_QRCODE error codes, and
  // every malformed corner: keep polling until the issue-time deadline.
  return { status: RACCOON_QR_STATUS.PENDING };
}

/**
 * Issue a scan: the server's codegen when the gateway answers it, else the
 * legacy local code (the confirm page stayed public: any self-made 32-hex
 * code enters `pending`, probed 2026-09), then ONE probe of the confirm
 * page itself: an HTTP 404 means the phone can never confirm, so the walk
 * must end NOW — waiting out its deadline would misread "the page is gone"
 * as "the QR expired" (issue #1). Any other probe outcome (a throw, a
 * non-404 status) does not block the walk: the polls remain the source of
 * truth.
 * @param {typeof fetch} [fetcher] - injected fetch.
 * @returns {Promise<object>} the issued scan, or the `unavailable` shape
 *   when the confirm page answered 404.
 */
export async function issueRaccoonScan(fetcher?: typeof fetch): Promise<RaccoonIssuedScan> {
  const effective = fetcher ?? globalThis.fetch;
  let code: string;
  let url: string;
  let deadlineMs: number | undefined;
  let pollIntervalMs: number | undefined;
  const created = await createRaccoonIamQr(effective);
  if (created !== null) {
    code = created.code;
    url = raccoonIamQrUrl(code, created.scanPath);
    deadlineMs = Date.now() + created.expiresInSeconds * 1000;
    // The site clamps its own cadence to [1 s, 60 s]; clamp the same way.
    pollIntervalMs = Math.min(60000, Math.max(1000, Math.round(created.pollIntervalSeconds * 1000)));
  } else {
    code = generateRaccoonQrCode();
    url = raccoonQrLoginUrl(code);
  }
  let probeStatus: number | null = null;
  try {
    const probe = await effective(url, { method: "GET", headers: { Accept: "text/html" } });
    probeStatus = probe.status;
  } catch {
    probeStatus = null;
  }
  if (probeStatus === 404) return { code: "", url: "", unavailable: true };
  if (created === null) return { code, url };
  // Spread the optional fields rather than assigning `undefined`: the
  // project compiles with `exactOptionalPropertyTypes`, where an explicit
  // undefined is not the same as an absent key.
  return {
    code,
    url,
    iam: true,
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {})
  };
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
  const refreshToken = verbatim(obj(credential).refresh_token, "");
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
  const accessToken = verbatim(envelope.data.access_token, "");
  if (accessToken === "") return { ok: false, code: RACCOON_CODE.REFRESH_REJECTED, message: "the refresh response carried no access token" };
  const refreshTokenOut = verbatim(envelope.data.refresh_token, "");
  const expMs = decodeRaccoonJwtExpMs(accessToken);
  return { ok: true, accessToken, refreshToken: refreshTokenOut, ...(expMs !== undefined ? { expiresAtMs: expMs } : {}) };
}

/**
 * The wire primitives every Raccoon call shares: the header set, the envelope
 * reader, and the two JWT-payload readers (expiry + display name).
 *
 * Split out of the former single `raccoon.ts` (2026-10-05). This is the layer
 * that knows the gateway's SHAPE; it makes no policy decision beyond "a
 * malformed answer reads as a refusal" and "a credential may arrive in either
 * of two document shapes". Every request-shaped module (auth, catalogue) sits
 * above it.
 *
 * The JWT readers live here rather than next to their callers because both the
 * auth walk (`pollRaccoonQrLogin`) and the store (`decodeRaccoonJwtExpMs` on
 * every read) need them, and they are pure functions over a token string.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-http
 */

import { obj, num, str } from "./util.ts";

/**
 * The one answer a single QR-poll can return (`pollRaccoonQrLogin`).
 *
 * `status` always present; the success branch adds the credential pair (and
 * the display name + probed field names, kept for the next scan's evidence).
 * Shared by `raccoon-walk.ts` (its `fetcher` returns this, not a `Response`)
 * so the walk module can be typed without a cast.
 */
export interface RaccoonQrPollResult {
  status: string;
  expiredAt?: string;
  nickname?: string;
  dataFields?: string[];
  expiresAtMs?: number;
  accessToken?: string;
  refreshToken?: string;
}

/**
 * Extract the account display name from a login payload. The fallback ladder
 * below was written when the success envelope had never been probed; a real
 * scan (2026-10-01, see docs/ROADMAP.md §6.1.2) settled it: the envelope's
 * `data` carries ONLY `access_token`/`refresh_token`/`status` — no user
 * object, no profile fields — so in practice the name always comes from the
 * JWT's `name` claim. The envelope ladder stays: it costs nothing and would
 * catch a gateway that starts shipping a user object.
 * @param {object} data - the success envelope's `data` object.
 * @param {string} [accessToken] - the JWT, whose payload may carry the name.
 * @returns {string} the nickname, or `""` when none is found.
 */
export function extractRaccoonNickname(data: any, accessToken = ""): string {
  const source = obj(data);
  const nested = obj(source.user ?? source.user_info ?? source.account);
  const candidates = [
    source.nickname, source.nick_name, source.display_name,
    nested.nickname, nested.nick_name, nested.name
  ];
  let nickname = "";
  for (const candidate of candidates) {
    const value = str(candidate, "");
    if (value !== "") { nickname = value; break; }
  }
  if (nickname !== "" || typeof accessToken !== "string" || accessToken === "") return nickname;
  // JWT fallback: the payload is read for ONE claim, never logged or stored
  // beyond the nickname the caller decides to keep.
  const parts = accessToken.split(".");
  if (parts.length < 2) return "";
  try {
    const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return "";
    for (const key of ["nickname", "nick_name", "display_name", "preferred_username", "name"]) {
      const value = str(claims[key], "");
      if (value !== "") return value;
    }
  } catch {
    return "";
  }
  return "";
}

/** Decode a JWT's `exp` claim to MILLISECONDS; `undefined` on any failure. */
export function decodeRaccoonJwtExpMs(token: string): number | undefined {
  if (typeof token !== "string" || token.length === 0) return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    const seconds = num(payload.exp);
    return typeof seconds === "number" ? seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The header set one Raccoon request carries.
 *
 * `X-Org-Code` is EMPTY for a personal account (the client always sends the
 * header, with an empty value for personal). The optional client-identity
 * headers let a Host pose as the desktop client's family; they are advisory —
 * the gateway does not gate on them.
 *
 * The credential arrives in EITHER shape: the raw document's snake_case
 * (`{ access_token, office_identity, device_id }` — the chat path's
 * per-request token view) or the store's parsed camelCase
 * (`{ accessToken, officeIdentity, deviceId }` — `parseRaccoonCredential`'s
 * output, what the panel routes hold). When both are present the raw
 * snake_case field wins. The dual read closes a real bug: a route once
 * passed the camelCase object and read `access_token` off it — an undefined
 * read that silently produced `Authorization: Bearer ` (empty) and a
 * gateway 401 the whole time, while the raw-doc path kept working.
 * @param {object} credential - `{ access_token|accessToken, office_identity|officeIdentity?, device_id|deviceId? }`.
 * @param {object} [options]
 * @param {string} [options.platform] - `X-Client-Platform` (e.g. `desktop-windows`).
 * @param {string} [options.version] - `X-Client-Version` (e.g. `v1.0.35`).
 * @returns {object} the header map.
 */
export function raccoonHeaders(credential: any, options: { platform?: string; version?: string } = {}) {
  const source = obj(credential);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${str(source.access_token ?? source.accessToken, "")}`,
    // Personal accounts send an empty org code; the header itself is always present.
    "X-Org-Code": str(source.office_identity ?? source.officeIdentity, ""),
    "X-Raccoon-Language": "zh"
  };
  if (typeof options.platform === "string" && options.platform !== "") headers["X-Client-Platform"] = options.platform;
  if (typeof options.version === "string" && options.version !== "") headers["X-Client-Version"] = options.version;
  const deviceId = source.device_id ?? source.deviceId;
  if (typeof deviceId === "string" && deviceId !== "") headers["X-Client-Device-ID"] = deviceId;
  return headers;
}

/**
 * Parse one gateway envelope. Success is `code === 0`; anything else is a
 * refusal whose `code`/`message` are surfaced (redacted at the call site when
 * a credential may be echoed back).
 *
 * `code` is read with a plain `Number` check, NOT the shared `num` helper:
 * `num` rejects `0` (it means "positive or fall back"), but `0` is exactly
 * this gateway's SUCCESS value — routing it through `num` would read every
 * successful envelope as a `-1` refusal.
 * @param {unknown} raw - the parsed JSON body.
 * @param {number} [status] - the HTTP status, for a machine-readable detail.
 * @returns {{code: number, message: string, data: object|null, status?: number}}
 */
export function parseRaccoonEnvelope(raw: unknown, status?: number): { code: number; message: string; data: Record<string, unknown> | null; status?: number } {
  const body = obj(raw);
  const parsedCode = Number(body.code);
  const code = Number.isFinite(parsedCode) ? parsedCode : -1;
  const message = str(body.message, "");
  const data = body.data === null || typeof body.data !== "object" || Array.isArray(body.data) ? null : obj(body.data);
  return { code, message, data, ...(typeof status === "number" ? { status } : {}) };
}

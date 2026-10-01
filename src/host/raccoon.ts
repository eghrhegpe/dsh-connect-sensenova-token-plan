/**
 * The Raccoon Work（商汤小浣熊）protocol layer — the pure, peer-free API half
 * of the second upstream provider (ROADMAP §6.1 "second upstream provider").
 *
 * Mechanism reference only (ROADMAP §6.1: "机制参考，不抄代码"): the endpoints,
 * the QR/SMS login walk, and the credit semantics were probed against the live
 * gateway and re-stated here, not ported. The desktop `~/.box-agent` token
 * route is REJECTED (§6.1.1: the refresh token is single-use; a 401 ×2 write-
 * back probe), so this half never touches a desktop credential file — login is
 * a self-built WeChat-QR walk whose tokens land in the DSH credentials service
 * (`raccoon-store.ts`), never in this plugin's directory, git, or logs.
 *
 * Wire facts this module encodes (all probed 2026-09 against the gateway):
 *   - envelope `{ code, message, details, data }`, success is `code === 0`;
 *   - the QR page is public: any self-made 32-hex code enters `pending` and is
 *     verified server-side, so the code is generated LOCALLY (`generateQrCode`);
 *   - the refresh token is SINGLE-USE: the server rotates BOTH tokens, so a
 *     refresh always re-stores the pair (the store owns that write-back);
 *   - `thinking` control is a PROVIDER-LEVEL dialect (`extra_body.thinking`,
 *     two states only); `reasoning_effort` is accepted by the schema but has
 *     no observable effect, so this module never emits it.
 *
 * Everything here takes an injected fetcher and pure data, so the offline
 * suites exercise it without a network; no Host peer is imported.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon
 */

import { randomBytes } from "node:crypto";
import { obj, num, str } from "./util.ts";

/** The gateway this provider talks to. */
export const RACCOON_API_BASE = "https://xiaohuanxiong.com";
/** Auth endpoints. */
export const RACCOON_AUTH_PREFIX = "/api/web/auth/v1";
/** Inference + model catalogue. */
export const RACCOON_LLM_PREFIX = "/api/web/llm/v2";
/** Credits (balance). */
export const RACCOON_POINTS_PREFIX = "/api/web/points/v1";
/** Desktop one-time login reward. */
export const RACCOON_DESKTOP_PREFIX = "/api/web/desktop/v1";

/** The OpenAI-compatible chat endpoint the adapter targets. */
export const RACCOON_CHAT_URL = `${RACCOON_API_BASE}${RACCOON_LLM_PREFIX}/chat/completions`;

/** The QR poll cadence: the gateway's own client polls every 2 s. */
export const RACCOON_QR_POLL_INTERVAL_MS = 2_000;
/** The QR login's overall deadline: a scan that takes longer is voided. */
export const RACCOON_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** The WeChat-QR login page the phone opens after a scan. */
export function raccoonQrLoginUrl(code) {
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
 * Extract the account display name from a login payload, defensively across
 * the field spellings a gateway plausibly uses. The success envelope was
 * never probed for a nickname (only `access_token`/`refresh_token` were
 * recorded), so the extraction tries the flat fields and a nested user
 * object, then falls back to JWT claims — and the caller logs the envelope's
 * FIELD NAMES (never values) so the next real scan settles the question with
 * evidence instead of another silent gap.
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
export function decodeRaccoonJwtExpMs(token) {
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
  const headers = {
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
export function parseRaccoonEnvelope(raw, status) {
  const body = obj(raw);
  const parsedCode = Number(body.code);
  const code = Number.isFinite(parsedCode) ? parsedCode : -1;
  const message = str(body.message, "");
  const data = body.data === null || typeof body.data !== "object" || Array.isArray(body.data) ? null : obj(body.data);
  return { code, message, data, ...(typeof status === "number" ? { status } : {}) };
}

/**
 * One poll of the QR login status. Any anomaly degrades to `pending`: the
 * caller polls on a 2 s cadence, and a transient network hiccup or an unknown
 * status must never read as `success` (an empty token would stall the flow)
 * or `canceled` (a live scan would be voided).
 * @param {string} code - the scan code being polled.
 * @param {typeof fetch} [fetcher] - injected fetch.
 * @returns {Promise<object>} `{ status }` plus, on success, the token pair.
 */
export async function pollRaccoonQrLogin(code: string, fetcher?: typeof fetch) {
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
): Promise<{ ok: boolean; code?: string; message?: string; accessToken?: string; refreshToken?: string; expiresAtMs?: number }> {
  const effective = fetcher ?? globalThis.fetch;
  const refreshToken = str(obj(credential).refresh_token, "");
  if (refreshToken === "") return { ok: false, code: "no_refresh_token", message: "the stored credential has no refresh token" };
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
    return { ok: false, code: "refresh_failed", message: error instanceof Error ? error.message : String(error) };
  }
  if (envelope.code !== 0 || envelope.data === null) {
    return { ok: false, code: envelope.code === 401 || envelope.code === 200003 ? "session_dead" : "refresh_rejected", message: envelope.message || `refresh refused (code ${envelope.code})` };
  }
  const accessToken = str(envelope.data.access_token, "");
  if (accessToken === "") return { ok: false, code: "refresh_rejected", message: "the refresh response carried no access token" };
  const refreshTokenOut = str(envelope.data.refresh_token, "");
  const expMs = decodeRaccoonJwtExpMs(accessToken);
  return { ok: true, accessToken, refreshToken: refreshTokenOut, ...(expMs !== undefined ? { expiresAtMs: expMs } : {}) };
}

/**
 * Fetch the live model catalogue, or `null` when it cannot be read OR when it
 * read fine but lists no visible model.
 *
 * The adapter falls back to a static roster in both cases, so a transient
 * catalogue outage degrades to the known-good models instead of breaking the
 * provider — the silent-fallback discipline of `console-client`. The two cases
 * are still distinguishable to the caller: `onFail` fires ONLY on a genuine
 * read failure (network / HTTP / envelope error), NOT on a successful read
 * that simply has no visible model — that split is what lets the panel say
 * "the gateway offered nothing" instead of "the gateway is down".
 * @param {object} credential - `{ access_token }`.
 * @param {typeof fetch} [fetcher] - injected fetch.
 * @param {(why: string) => void} [onFail] - fired on a genuine read failure.
 * @returns {Promise<object[]|null>} the normalized `[{id, name, multiplier, vision, contextWindow, maxOutputLength}]`, or `null`.
 */
export async function fetchRaccoonCatalog(credential: any, fetcher?: typeof fetch, onFail?: (why: string) => void) {
  const effective = fetcher ?? globalThis.fetch;
  try {
    const response = await effective(
      `${RACCOON_API_BASE}${RACCOON_LLM_PREFIX}/model_catalog`,
      { headers: raccoonHeaders(credential), signal: AbortSignal.timeout(30_000) }
    );
    if (!response.ok) {
      onFail?.(`HTTP ${response.status}`);
      return null;
    }
    const envelope = parseRaccoonEnvelope(await response.json().catch(() => ({})), response.status);
    if (envelope.code !== 0 || envelope.data === null) {
      onFail?.(`envelope code=${envelope.code} message=${envelope.message}`);
      return null;
    }
    const categories = Array.isArray(envelope.data.categories) ? envelope.data.categories : [];
    for (const category of categories) {
      if (obj(category).type !== "chat") continue;
      const models = Array.isArray(obj(category).models) ? obj(category).models : [];
      const seen = new Set();
      const out = [];
      for (const raw of models) {
        const model = obj(raw);
        if (model.visible === false) continue;
        const id = str(model.id, "");
        if (id === "" || seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          name: str(model.name, id),
          multiplier: typeof model.multiplier === "number" ? model.multiplier : undefined,
          vision: model.vision === true || (Array.isArray(model.input_modalities) ? model.input_modalities.includes("image") : false),
          contextWindow: num(model.context_window ?? model.context_length),
          maxOutputLength: num(model.max_output_tokens ?? model.max_output_length)
        });
      }
      if (out.length > 0) return out;
    }
    // A successful read that lists no visible model is NOT a failure — the
    // gateway deliberately hid its catalog; the panel must not read it as an
    // outage. Fall through to `null` without firing `onFail`.
    return null;
  } catch (why) {
    onFail?.(why instanceof Error ? `${why.name}: ${why.message}` : String(why));
    return null;
  }
}

/**
 * Read the account's credit balance. Read-only: the gateway has NO endpoint
 * for the daily 300-point grant (the server awards it automatically as
 * `daily_grant`), so the panel must not offer a check-in button.
 *
 * The read carries the gateway's own breakdown of that total (the live
 * envelope declares `available_points` beside `daily_points`,
 * `reward_points`, `monthly_points`, `topup_points`): a part is reported
 * only when the gateway declared it — a zero is a fact, so it is reported
 * too, and the panel decides what to show.
 * @param {object} credential - `{ access_token }` (or the parsed store shape).
 * @param {typeof fetch} [fetcher] - injected fetch.
 * @returns {Promise<object|null>} `{ total, daily?, reward?, monthly?, topup? }` or `null` when unreadable.
 */
export async function fetchRaccoonBalance(credential: any, fetcher?: typeof fetch, onFail?: (why: string) => void) {
  const effective = fetcher ?? globalThis.fetch;
  try {
    const response = await effective(
      `${RACCOON_API_BASE}${RACCOON_POINTS_PREFIX}/balance`,
      { headers: raccoonHeaders(credential), signal: AbortSignal.timeout(30_000) }
    );
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      // A 401 body distinguishes "the gateway never saw our Authorization"
      // (`authorization_empty_error`) from "it saw one and rejected it"
      // (`invalid_token` / a JWT reason). That split decides whether the fault
      // is in the transport (a header-stripping fetch) or the token itself.
      onFail?.(`HTTP ${response.status} ${bodyText.slice(0, 160)}`);
      return null;
    }
    const envelope = parseRaccoonEnvelope(await response.json().catch(() => ({})), response.status);
    if (envelope.code !== 0 || envelope.data === null) {
      onFail?.(`envelope code=${envelope.code} message=${envelope.message}`);
      return null;
    }
    const total = numOrNullSafe(envelope.data.available_points ?? envelope.data.balance ?? envelope.data.available ?? envelope.data.amount);
    const read = { total };
    const daily = numOrNullSafe(envelope.data.daily_points);
    const reward = numOrNullSafe(envelope.data.reward_points);
    const monthly = numOrNullSafe(envelope.data.monthly_points);
    const topup = numOrNullSafe(envelope.data.topup_points);
    if (daily !== null) read.daily = daily;
    if (reward !== null) read.reward = reward;
    if (monthly !== null) read.monthly = monthly;
    if (topup !== null) read.topup = topup;
    return read;
  } catch (why) {
    onFail?.(why instanceof Error ? `${why.name}: ${why.message}` : String(why));
    return null;
  }
}

/** Read a finite number (0 counts), else `null`. */
function numOrNullSafe(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * The static fallback roster: the six `visible: true` chat models the gateway
 * listed at probe time (2026-09). Used ONLY when `fetchRaccoonCatalog` comes
 * back empty, so the provider still offers models; a fresh catalogue always
 * wins over this table.
 */
export const RACCOON_FALLBACK_MODELS = Object.freeze([
  { id: "sn-sensenova-6-8-flash", name: "SenseNova 6.8 Flash", multiplier: 0, vision: true, contextWindow: 256_000, maxOutputLength: 63_999 },
  { id: "sn-sensenova-6-8-flash-lite", name: "SenseNova 6.8 Flash Lite", multiplier: 0, vision: true, contextWindow: 256_000, maxOutputLength: 63_999 },
  { id: "sn-glm-5-3", name: "GLM-5.3", multiplier: 0.75, vision: true, contextWindow: 1_000_000, maxOutputLength: 65_536 },
  { id: "sn-kimi-k3", name: "Kimi K3", multiplier: 1, vision: true, contextWindow: 1_000_000, maxOutputLength: 65_536 },
  { id: "sn-glm-5-3-flash", name: "GLM-5.3 Flash", multiplier: 0.2, vision: false, contextWindow: 1_000_000, maxOutputLength: 65_536 },
  { id: "sn-deepseek-v4-1-flash", name: "DeepSeek V4.1 Flash", multiplier: 0.25, vision: false, contextWindow: 1_000_000, maxOutputLength: 65_536 }
]);

/**
 * The two-state thinking control for this provider (a PROVIDER-level dialect,
 * model-independent — verified: every visible model accepts the same field).
 *
 * The ONLY wire channel that works is `extra_body.thinking = { type }`;
 * `reasoning_effort` is schema-accepted but has no observable effect, and a
 * top-level `thinking` is silently ignored by the gateway.
 * @param {string|undefined} effort - `undefined` = send nothing (server default
 *   = thinking on); `"off"` = disabled; anything else = enabled.
 * @returns {object|undefined} the `extra_body` value, or `undefined`.
 */
export function raccoonThinkingExtraBody(effort) {
  if (effort === undefined || effort.length === 0) return undefined;
  const type = effort === "off" ? "disabled" : "enabled";
  return { thinking: { type } };
}

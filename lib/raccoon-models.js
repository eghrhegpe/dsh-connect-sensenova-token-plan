import { E as num, F as str, I as verbatim, O as obj, T as errMsg } from "./llm-models.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

//#region src/host/raccoon-consts.ts
/**
* Raccoon gateway constants — the endpoint prefixes and the QR-login timings.
*
* These are the roots of the Raccoon dependency DAG: every other protocol
* module needs them, and nothing here depends on anything else in the Raccoon
* half.
*
* The stance-level knowledge — the wire facts, the "mechanism reference, not
* ported" position, the rejected desktop-token route — lives on
* {@link ./raccoon.ts}, the barrel every consumer imports. What stays here is
* knowledge that is *about the wire itself*.
*
* @module dsh-connect-sensenova-token-plan/raccoon-consts
*/
/** The gateway this provider talks to. */
const RACCOON_API_BASE = "https://xiaohuanxiong.com";
/** Auth endpoints. */
const RACCOON_AUTH_PREFIX = "/api/web/auth/v1";
/** Inference + model catalogue. */
const RACCOON_LLM_PREFIX = "/api/web/llm/v2";
/** Credits (balance). */
const RACCOON_POINTS_PREFIX = "/api/web/points/v1";
/**
* Server-side QR codegen + poll (2026-11-03 retest: the gateway moved code
* issuance to this prefix; the string-`OK` envelope half of the raccoon
* wire).
*/
const RACCOON_IAM_AUTH_PREFIX = "/api/iam/v1";
/** The QR poll cadence: the gateway's own client polls every 2 s. */
const RACCOON_QR_POLL_INTERVAL_MS = 2e3;
/** The QR login's overall deadline: a scan that takes longer is voided. */
const RACCOON_LOGIN_TIMEOUT_MS = 3e5;
/** The per-request deadline for a gateway read (catalogue / balance). */
const RACCOON_REQUEST_TIMEOUT_MS = 3e4;
/**
* The marker of the gateway's error-page shell (probed 2026-11-17: the
* `/login/mp` 404 is served as a full Next.js error page carrying
* `__next_error__` in its HTML). The issue-time probe reads it so a gateway
* that starts serving that page under a 200 does not read as "page alive" —
* a status-only check would miss the 200-shelled error page.
*/
const RACCOON_SCAN_PAGE_ERROR_MARKER = "__next_error__";

//#endregion
//#region src/host/raccoon-codes.ts
/**
* Why a Raccoon credential rotation failed — the second upstream's OWN
* taxonomy, plus the two predicates that read it.
*
* This module has no dependency on any other Raccoon module: it is a pure
* classification table, and keeping it that way is what lets a test pin the
* table and the mapping separately from the call sites that consult them.
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
const RACCOON_CODE = Object.freeze({
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
const RACCOON_DEAD_SESSION_CODES = Object.freeze(/* @__PURE__ */ new Set([401, 200003]));
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
function isDeadRaccoonSession(code) {
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
function isDeadRaccoonEnvelope(envelopeCode) {
	return typeof envelopeCode === "number" && RACCOON_DEAD_SESSION_CODES.has(envelopeCode);
}

//#endregion
//#region src/host/raccoon-http.ts
/**
* The wire primitives every Raccoon call shares: the header set, the envelope
* reader, and the two JWT-payload readers (expiry + display name).
*
* This is the layer that knows the gateway's SHAPE; it makes no policy
* decision beyond "a malformed answer reads as a refusal" and "a credential
* may arrive in either of two document shapes". Every request-shaped module
* (auth, catalogue) sits above it.
*
* The JWT readers live here rather than next to their callers because both the
* auth walk (`pollRaccoonQrLogin`) and the store (`decodeRaccoonJwtExpMs` on
* every read) need them, and they are pure functions over a token string.
*
* @module dsh-connect-sensenova-token-plan/raccoon-http
*/
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
function extractRaccoonNickname(data, accessToken = "") {
	const source = obj(data);
	const nested = obj(source.user ?? source.user_info ?? source.account);
	const candidates = [
		source.nickname,
		source.nick_name,
		source.display_name,
		nested.nickname,
		nested.nick_name,
		nested.name
	];
	let nickname = "";
	for (const candidate of candidates) {
		const value = str(candidate, "");
		if (value !== "") {
			nickname = value;
			break;
		}
	}
	if (nickname !== "" || typeof accessToken !== "string" || accessToken === "") return nickname;
	const parts = accessToken.split(".");
	if (parts.length < 2) return "";
	try {
		const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
		if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return "";
		for (const key of [
			"nickname",
			"nick_name",
			"display_name",
			"preferred_username",
			"name"
		]) {
			const value = str(claims[key], "");
			if (value !== "") return value;
		}
	} catch {
		return "";
	}
	return "";
}
/** Decode a JWT's `exp` claim to MILLISECONDS; `undefined` on any failure. */
function decodeRaccoonJwtExpMs(token) {
	if (typeof token !== "string" || token.length === 0) return void 0;
	const parts = token.split(".");
	if (parts.length < 2) return void 0;
	try {
		const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return void 0;
		const seconds = num(payload.exp);
		return typeof seconds === "number" ? seconds * 1e3 : void 0;
	} catch {
		return;
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
function raccoonHeaders(credential, options = {}) {
	const source = obj(credential);
	const headers = {
		Accept: "application/json",
		"Content-Type": "application/json",
		Authorization: `Bearer ${verbatim(source.access_token ?? source.accessToken, "")}`,
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
function parseRaccoonEnvelope(raw, status) {
	const body = obj(raw);
	const parsedCode = Number(body.code);
	return {
		code: Number.isFinite(parsedCode) ? parsedCode : -1,
		message: str(body.message, ""),
		data: body.data === null || typeof body.data !== "object" || Array.isArray(body.data) ? null : obj(body.data),
		...typeof status === "number" ? { status } : {}
	};
}

//#endregion
//#region src/host/raccoon-auth.ts
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
/** The WeChat-QR login page the phone opens after a scan. */
function raccoonQrLoginUrl(code) {
	const params = new URLSearchParams({
		code: str(code, ""),
		appname: "商汤小浣熊官网"
	});
	return `${RACCOON_API_BASE}/login/mp?${params.toString()}`;
}
/**
* One 32-hex scan code (16 random bytes), the exact shape the gateway's own
* client generates. Any self-made code is accepted and held `pending` until a
* phone confirms it, so generation is local and needs no server round-trip.
* @returns {string} the code.
*/
function generateRaccoonQrCode() {
	return randomBytes(16).toString("hex");
}
/** The QR poll's status values, exactly as the gateway spells them. */
const RACCOON_QR_STATUS = Object.freeze({
	PENDING: "pending",
	LOGGING: "logging",
	CANCELED: "canceled",
	SUCCESS: "success"
});
/**
* The SYNTHESIZED terminal: a dead ticket arrives as the gateway's error
* codes on the poll endpoint, not as a `status` value — `AUTH_QRCODE_INVALID`
* (HTTP 401, the code was never issued) and `AUTH_QRCODE_EXPIRED` (HTTP 410,
* the ticket's `expires_in` passed). Probed 2026-11-17: the gateway answers
* a well-formed-but-unknown uuidv7-shaped code with 410, so 410 also means
* "unknown ticket", not "known-and-expired" — either way the answer is
* the same: this ticket can never confirm. The walk reissues on this
* status. The gateway never spells `expired` as a raw status value (probed
* 2026-11: `pending`/`logging`/`canceled`/`success` only), so the string
* cannot collide with a server spelling.
*/
const RACCOON_QR_EXPIRED = "expired";
/** The gateway's string error codes naming a dead ticket (probed 2026-11-17). */
const RACCOON_IAM_QR_INVALID_CODE = "AUTH_QRCODE_INVALID";
const RACCOON_IAM_QR_EXPIRED_CODE = "AUTH_QRCODE_EXPIRED";
/**
* One poll of the QR login status. Any anomaly degrades to `pending`: the
* caller polls on a 2 s cadence, and a transient network hiccup or an unknown
* status must never read as `success` (an empty token would stall the flow)
* or `canceled` (a live scan would be voided).
* @param {string} code - the scan code being polled.
* @param {typeof fetch} [fetcher] - injected fetch.
* @returns {Promise<object>} `{ status }` plus, on success, the token pair.
*/
async function pollRaccoonQrLogin(code, fetcher) {
	const effective = fetcher ?? globalThis.fetch;
	let envelope;
	try {
		const response = await effective(`${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}/login_with_qrcode_code`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json"
			},
			body: JSON.stringify({ qrcode_code: str(code, "") })
		});
		envelope = parseRaccoonEnvelope(await response.json().catch(() => ({})), response.status);
	} catch {
		return { status: RACCOON_QR_STATUS.PENDING };
	}
	if (envelope.code !== 0 || envelope.data === null) return { status: RACCOON_QR_STATUS.PENDING };
	const rawStatus = str(envelope.data.status, "");
	if (rawStatus === RACCOON_QR_STATUS.CANCELED) return { status: RACCOON_QR_STATUS.CANCELED };
	if (rawStatus === RACCOON_QR_STATUS.LOGGING) return {
		status: RACCOON_QR_STATUS.LOGGING,
		...str(envelope.data.expired_at, "") !== "" ? { expiredAt: str(envelope.data.expired_at, "") } : {}
	};
	if (rawStatus === RACCOON_QR_STATUS.SUCCESS) {
		const accessToken = verbatim(envelope.data.access_token, "");
		if (accessToken === "") return { status: RACCOON_QR_STATUS.PENDING };
		const refreshToken = verbatim(envelope.data.refresh_token, "");
		const expMs = decodeRaccoonJwtExpMs(accessToken);
		return {
			status: RACCOON_QR_STATUS.SUCCESS,
			accessToken,
			refreshToken,
			...expMs !== void 0 ? { expiresAtMs: expMs } : {},
			nickname: extractRaccoonNickname(envelope.data, accessToken),
			dataFields: Object.keys(envelope.data).sort()
		};
	}
	return { status: RACCOON_QR_STATUS.PENDING };
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
async function createRaccoonIamQr(fetcher) {
	const effective = fetcher ?? globalThis.fetch;
	let body;
	try {
		body = await (await effective(`${RACCOON_API_BASE}${RACCOON_IAM_AUTH_PREFIX}/auth/mp/qrcode`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json"
			},
			body: JSON.stringify({})
		})).json().catch(() => null);
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
		expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : RACCOON_LOGIN_TIMEOUT_MS / 1e3,
		pollIntervalSeconds: Number.isFinite(pollInterval) && pollInterval > 0 ? pollInterval : RACCOON_QR_POLL_INTERVAL_MS / 1e3
	};
}
/**
* The confirm-page URL for a server-issued code: the server's own
* `scan_path` (probed 2026-11: `/login/mp`) plus the query params the
* site's own client sends — `code`, `appname`, and `source=platform`
* (the legacy `raccoonQrLoginUrl` omits the last; a page that comes back
* may key on it).
*/
function raccoonIamQrUrl(code, scanPath) {
	const path = scanPath.startsWith("/") ? scanPath : `/${scanPath}`;
	const params = new URLSearchParams({
		code: str(code, ""),
		appname: "商汤小浣熊官网",
		source: "platform"
	});
	return `${RACCOON_API_BASE}${path}?${params.toString()}`;
}
/**
* One poll of a SERVER-ISSUED scan. The endpoint is the site's own login
* poll (`POST /api/iam/v1/auth/mp/qrcode/login`), whose envelope is the
* string `code: "OK"` half, so the numeric parser does not apply.
*
* Every anomaly EXCEPT the ticket-death codes degrades to `pending`,
* exactly like the legacy poll. The server's own expiry surfaces as the
* AUTH_QRCODE error codes (401/410), which this poller reports as the
* SYNTHESIZED `RACCOON_QR_EXPIRED` status — the walk turns it into a
* reissue (a fresh ticket inside the overall login window) rather than
* letting the user wait out the dead ticket's deadline staring at a QR
* that can no longer confirm (2026-11-17 differential vs the reference
* implementation, which reissues on the same two codes).
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
async function pollRaccoonIamQrLogin(code, fetcher) {
	const effective = fetcher ?? globalThis.fetch;
	let body;
	let httpStatus = 0;
	try {
		const response = await effective(`${RACCOON_API_BASE}${RACCOON_IAM_AUTH_PREFIX}/auth/mp/qrcode/login`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json"
			},
			body: JSON.stringify({ qrcode_code: str(code, "") })
		});
		httpStatus = response.status;
		body = await response.json().catch(() => null);
	} catch {
		return { status: RACCOON_QR_STATUS.PENDING };
	}
	const data = body === null ? null : obj(body.data);
	const bodyCode = body === null ? "" : str(body.code, "");
	if (httpStatus === 401 || httpStatus === 410 || bodyCode === "AUTH_QRCODE_INVALID" || bodyCode === "AUTH_QRCODE_EXPIRED") return { status: RACCOON_QR_EXPIRED };
	const rawStatus = data === null ? "" : str(data.status, "");
	if (rawStatus === RACCOON_QR_STATUS.CANCELED) return { status: RACCOON_QR_STATUS.CANCELED };
	if (rawStatus === RACCOON_QR_STATUS.SUCCESS) {
		const accessToken = data === null ? "" : verbatim(data.access_token, "");
		if (data === null || accessToken === "") return { status: RACCOON_QR_STATUS.PENDING };
		const refreshToken = verbatim(data.refresh_token, "");
		const expMs = decodeRaccoonJwtExpMs(accessToken);
		return {
			status: RACCOON_QR_STATUS.SUCCESS,
			accessToken,
			refreshToken,
			...expMs !== void 0 ? { expiresAtMs: expMs } : {},
			nickname: extractRaccoonNickname(data, accessToken),
			dataFields: Object.keys(data).sort()
		};
	}
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
async function issueRaccoonScan(fetcher) {
	const effective = fetcher ?? globalThis.fetch;
	let code;
	let url;
	let deadlineMs;
	let pollIntervalMs;
	const created = await createRaccoonIamQr(effective);
	if (created !== null) {
		code = created.code;
		url = raccoonIamQrUrl(code, created.scanPath);
		deadlineMs = Date.now() + created.expiresInSeconds * 1e3;
		pollIntervalMs = Math.min(6e4, Math.max(1e3, Math.round(created.pollIntervalSeconds * 1e3)));
	} else {
		code = generateRaccoonQrCode();
		url = raccoonQrLoginUrl(code);
	}
	let probeStatus = null;
	let probeBody = "";
	try {
		const probe = await effective(url, {
			method: "GET",
			headers: { Accept: "text/html" }
		});
		probeStatus = probe.status;
		if (probeStatus < 400) probeBody = await probe.text().catch(() => "");
	} catch {
		probeStatus = null;
	}
	if (probeStatus === 404 || probeStatus !== null && probeBody.includes("__next_error__")) return {
		code: "",
		url: "",
		unavailable: true
	};
	if (created === null) return {
		code,
		url
	};
	return {
		code,
		url,
		iam: true,
		...deadlineMs !== void 0 ? { deadlineMs } : {},
		...pollIntervalMs !== void 0 ? { pollIntervalMs } : {}
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
async function refreshRaccoonCredential(credential, fetcher) {
	const effective = fetcher ?? globalThis.fetch;
	const refreshToken = verbatim(obj(credential).refresh_token, "");
	if (refreshToken === "") return {
		ok: false,
		code: RACCOON_CODE.NO_REFRESH_TOKEN,
		message: "the stored credential has no refresh token"
	};
	let envelope;
	try {
		const response = await effective(`${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}/refresh`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json"
			},
			body: JSON.stringify({ refresh_token: refreshToken })
		});
		envelope = parseRaccoonEnvelope(await response.json().catch(() => ({})), response.status);
	} catch (error) {
		return {
			ok: false,
			code: RACCOON_CODE.REFRESH_FAILED,
			message: errMsg(error)
		};
	}
	if (envelope.code !== 0 || envelope.data === null) return {
		ok: false,
		code: isDeadRaccoonEnvelope(envelope.code) || isDeadRaccoonEnvelope(envelope.status) ? RACCOON_CODE.SESSION_DEAD : RACCOON_CODE.REFRESH_REJECTED,
		message: envelope.message || `refresh refused (code ${envelope.code})`
	};
	const accessToken = verbatim(envelope.data.access_token, "");
	if (accessToken === "") return {
		ok: false,
		code: RACCOON_CODE.REFRESH_REJECTED,
		message: "the refresh response carried no access token"
	};
	const refreshTokenOut = verbatim(envelope.data.refresh_token, "");
	const expMs = decodeRaccoonJwtExpMs(accessToken);
	return {
		ok: true,
		accessToken,
		refreshToken: refreshTokenOut,
		...expMs !== void 0 ? { expiresAtMs: expMs } : {}
	};
}

//#endregion
//#region src/host/raccoon-authorize.ts
/**
* The Raccoon BROWSER-AUTHORIZE login — the official desktop client's own
* login chain, adopted by this plugin (ADR-020; evidence in
* `docs/evidence/2026-11-17-authorize-loopback/`).
*
* Why this module exists: the QR-SCAN chain is dead on the upstream side —
* the confirm page `/login/mp` has 404'd since 2026-11-04 (ROADMAP §6.1.10),
* and a QR that cannot be confirmed can never log anyone in. The official
* desktop client (build 2026-11-05, `resources/app.asar`) stopped using that
* chain and logs in through the WEB instead: the system browser opens
* `/authorize`, the user signs in ON THE PAGE (the page's own phone / WeChat
* QR — a DIFFERENT, live link than the dead `/login/mp` route), consents,
* and the issued one-time `authorization_code` is delivered back to the
* caller — either the registered `office-raccoon://` protocol (the official
* app only) or a LOOPBACK receiver on `127.0.0.1:<port>` (the Windows/Linux
* compatibility mode, which a third party may host itself). This module is
* the protocol half of that loopback mode: the receiver with the official
* receiver's security rules, the code exchange, and the URL builder the
* official page's own parser accepts.
*
* Mechanism reference, not port (ROADMAP §6.1): the wire facts were read out
* of the official client's login sources — the 2026-11-05 build's desktop-login,
* loopback-receiver, refresh-scheduler and iam-token helpers, the exact
* asar paths recorded in docs/evidence/2026-11-17-authorize-loopback/INDEX.md
* — and re-probed live 2026-11-17
* (`/authorize` 200 with loopback params rendered into its boot data; the
* exchange endpoint answering a bogus code with 400 `200035`; and the same
* evening a REAL consent delivered its code to a loopback receiver and
* exchanged — the `iss` the gateway signs is scheme-free, and it pairs the
* IAM token with a refresh token). The receiver's
* rules are the official receiver's RULES re-stated here — the loopback code
* is a one-shot credential, and an open receiver is a credential-exchange
* hole, so none of the seven checks is optional.
*
* The exchange lands the SAME credential the QR walk lands: the token pair
* goes to the DSH credentials service through `raccoon-store.ts` (red lines
* 1/2), never to this plugin's directory, git, or logs — and this module
* prints no credential value: its failure results carry a REASON WORD, not
* the body text.
*
* @module dsh-connect-sensenova-token-plan/raccoon-authorize
*/
/** The `/authorize` path the official client opens in the system browser. */
const RACCOON_AUTHORIZE_PATH = "/authorize";
/**
* The registered app the consent page shows (display name 「商汤小浣熊
* 客户端」). The value is the official client's own `DESKTOP_AUTH_PARAMS`
* literal (desktopLogin.js L12) — the one appname a live login was
* completed with (2026-11-17 evidence). The page's parser whitelists three
* appnames (办公小浣熊客户端 / 商汤小浣熊客户端 / Office Raccoon); all
* others still parse, but the consent copy then quotes the UNKNOWN string,
* so the proven one is the default.
*/
const RACCOON_AUTH_APPNAME = "办公小浣熊客户端";
/** The loopback receiver's callback path — fixed by the official page. */
const RACCOON_LOOPBACK_CALLBACK_PATH = "/auth/callback";
/**
* The gateway's envelope code for "this authorization code is unknown,
* expired, or already consumed" (probed 2026-11-17: a bogus code answers
* HTTP 400 with exactly this; the official client's constant
* `AUTHORIZATION_CODE_NOT_FOUND` is the same value). One re-start of the
* flow is the only recovery — retrying the same code changes nothing.
*/
const RACCOON_AUTHORIZATION_CODE_NOT_FOUND = 200035;
/**
* The receiver's default wait: the official loopback's own default
* (webLoginLoopback.js: `timeoutMs ?? 300000`). A browser sign-in that
* includes a fresh phone login comfortably fits five minutes.
*/
const RACCOON_AUTHORIZE_TIMEOUT_MS = 3e5;
/**
* The loopback redirect the official page's parser will accept, as a
* machine-checkable rule: `http://127.0.0.1:<port>/auth/callback` with a
* 4–5 digit port ≥ 1024 and ≤ 65535. Re-stated from the page chunk's `E()`
* (2026-11-17): a redirect the PAGE rejects would parse into a context and
* only fail at delivery, so the builder refuses it up front instead.
*/
const RACCOON_LOOPBACK_REDIRECT_RE = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/auth\/callback$/;
/**
* The `iss` an IAM token must carry. The official client computes it as
* `new URL(LOGIN_URL).host + "/iam"` — a bare HOST, no scheme — and the live
* exchange on 2026-11-17 confirms the gateway signs exactly that shape
* (`iss: "xiaohuanxiong.com/iam"`). The scheme-free form is load-bearing:
* `iss` is compared by equality, so a scheme-carrying expectation would
* reject every real token.
*/
const RACCOON_IAM_ISSUER = `${new URL(RACCOON_API_BASE).host}/iam`;
/**
* Protocol recognition for the gateway's IAM tokens, exactly the official
* client's rule (iamToken.js): the `iss` claim ends with `/iam`. No
* signature is checked here — the server owns validity; this only decides
* WHICH half of the success gate applies (the IAM half is gated on its own
* claims and never REQUIRES a refresh — though the live gateway pairs one;
* the legacy half must carry its refresh).
* @param {unknown} token - a candidate JWT.
* @returns {boolean}
*/
function isRaccoonIamToken(token) {
	if (typeof token !== "string" || token === "") return false;
	const parts = token.split(".");
	if (parts.length < 2) return false;
	try {
		const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
		return typeof payload?.iss === "string" && payload.iss.endsWith("/iam");
	} catch {
		return false;
	}
}
/**
* The official `iamTokenIsValid` re-stated: same issuer, a non-blank `sub`,
* a finite `exp` in the future — and no `Date` overflow (the official's last
* clause rejects an `exp` so large that `new Date(exp*1000)` is not a date).
* @param {string} token - the access token.
* @param {string} issuer - the expected `iss` (default {@link RACCOON_IAM_ISSUER}).
* @returns {boolean}
*/
function raccoonIamTokenIsValid(token, issuer = RACCOON_IAM_ISSUER) {
	if (typeof token !== "string" || token === "") return false;
	const parts = token.split(".");
	if (parts.length < 2) return false;
	try {
		const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
		return claims?.iss === issuer && typeof claims.sub === "string" && claims.sub.trim() !== "" && typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > Date.now() / 1e3 && !Number.isNaN((/* @__PURE__ */ new Date(claims.exp * 1e3)).getTime());
	} catch {
		return false;
	}
}
/**
* Build the `/authorize` URL one browser sign-in opens.
*
* Every constraint is the official page's own parser rule, checked up front:
* a URL the page would reject (and print 「授权链接无效」 over) must not be
* offered to the user — the failure then has a next step instead of a dead
* end. No value here is secret; the `state` is a public CSRF token the
* receiver will `timingSafeEqual` back.
* @param {object} options
* @param {number} options.port - the loopback port the receiver will listen on.
* @param {string} options.state - the 64-hex state the receiver will expect.
* @param {string} [options.appname] - the registered app to consent (default {@link RACCOON_AUTH_APPNAME}).
* @param {string} [options.base] - the gateway origin (default {@link RACCOON_API_BASE}).
* @returns {string} the full URL.
* @throws {Error} a named violation, so the route can answer `ok:false` with it.
*/
function buildRaccoonAuthorizeUrl({ port, state, appname = RACCOON_AUTH_APPNAME, base = RACCOON_API_BASE }) {
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("authorize: the loopback port must be an integer in 1024..65535");
	const redirect = `http://127.0.0.1:${port}${RACCOON_LOOPBACK_CALLBACK_PATH}`;
	if (!RACCOON_LOOPBACK_REDIRECT_RE.test(redirect)) throw new Error("authorize: the loopback redirect must be http://127.0.0.1:<4-5 digit port>/auth/callback");
	const expected = verbatim(state, "");
	if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("authorize: the state must be 64 lowercase hex characters");
	const app = verbatim(appname, "");
	if (app === "" || app.length > 100) throw new Error("authorize: the appname must be 1..100 characters");
	const origin = str(base, "https://xiaohuanxiong.com") !== "" ? str(base, "") : RACCOON_API_BASE;
	const url = new URL(origin);
	if (url.protocol !== "https:") throw new Error("authorize: the gateway origin must be https");
	url.pathname = RACCOON_AUTHORIZE_PATH;
	url.search = "";
	url.searchParams.set("login_source", "desktop");
	url.searchParams.set("appname", app);
	url.searchParams.set("desktop_callback", "loopback");
	url.searchParams.set("redirect", redirect);
	url.searchParams.set("state", expected);
	return url.toString();
}
/**
* Start the loopback receiver the /authorize page's callback lands on.
*
* The seven checks mirror the official receiver one for one — GET-only,
* host equal to our own authority, the loopback source address, an `Origin`
* that must equal the authorize origin when present, a `Sec-Fetch-Dest`
* that must equal `document` when present, the exact callback path with a
* query whose keys are a subset of `{code, state}` (each once), and a
* `state` that is 64 hex and `timingSafeEqual` to ours. One-shot: the first
* VALID callback wins, and once it is taken (or the receiver settles for
* any reason) the port answers 409 to everything — a second delivery of the
* same code must not re-exchange it. Rejections do NOT consume: a wrong
* `state` or an extra key leaves the receiver open so the page can be
* re-opened with a corrected URL — exactly the official's own behaviour.
*
* The factory is ASYNC because the port is only known after the OS
* assigns one (`port 0`): the caller awaits it before handing the URL to
* the browser, and by then the receiver is already listening — there is no
* window in which the page can redirect into a port that is not ours yet.
* A refused bind (a foreign process on a requested port) settles the result
* as `failed` rather than throwing: the caller is mid-request and needs an
* answer, and the failure it names is one the user can act on by re-clicking.
* @param {object} [options]
* @param {number} [options.port] - the port to listen on; `0` (default) lets
*   the OS pick, which also keeps two receivers from colliding.
* @param {string} [options.state] - a 64-hex state; generated when omitted.
* @param {number} [options.timeoutMs] - the wait window (default {@link RACCOON_AUTHORIZE_TIMEOUT_MS}).
* @param {string} [options.authorizationOrigin] - what a present `Origin`
*   header must equal (default the gateway origin).
* @param {string} [options.appname] - the consent app (default {@link RACCOON_AUTH_APPNAME}).
* @param {string} [options.base] - the gateway origin for the URL (default {@link RACCOON_API_BASE}).
* @returns {Promise<RaccoonAuthorizeReceiver>}
*/
async function startRaccoonAuthorizeReceiver(options = {}) {
	const state = options.state !== void 0 && options.state !== null ? verbatim(options.state, "") : randomBytes(32).toString("hex");
	if (!/^[a-f0-9]{64}$/.test(state)) throw new Error("authorize: the state must be 64 lowercase hex characters");
	const authorizationOrigin = str(options.authorizationOrigin, "") !== "" ? str(options.authorizationOrigin, "") : RACCOON_API_BASE;
	const timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : RACCOON_AUTHORIZE_TIMEOUT_MS;
	let settled = false;
	let consumed = false;
	let server = null;
	let timer = null;
	let settleFn = null;
	const finish = (value, hard = true) => {
		settleFn?.(value, hard);
	};
	const result = new Promise((resolve) => {
		settleFn = (value, hard = true) => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			if (server !== null) {
				if (hard) server.closeAllConnections?.();
				server.close();
			}
			resolve(value);
		};
	});
	const request = (req, res) => {
		const authority = `127.0.0.1:${portOf()}`;
		const answer = (status, body) => {
			res.writeHead(status, {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff"
			});
			res.end(body);
		};
		if (settled || consumed) {
			answer(409, "used");
			return;
		}
		let reason = "";
		let code = null;
		try {
			const raw = typeof req.url === "string" ? req.url : "/";
			if (req.method !== "GET") reason = "method";
			else if (req.headers.host !== authority) reason = "host";
			else if (req.socket.remoteAddress !== "127.0.0.1") reason = "source";
			else if (typeof req.headers.origin === "string" && req.headers.origin !== authorizationOrigin) reason = "origin";
			else if (typeof req.headers["sec-fetch-dest"] === "string" && req.headers["sec-fetch-dest"] !== "document") reason = "fetch-dest";
			else {
				const url = new URL(raw, `http://${authority}`);
				if (url.origin !== `http://${authority}` || url.pathname !== "/auth/callback" || url.hash !== "") reason = "path";
				else if ([...url.searchParams.keys()].some((key) => !(key === "code" || key === "state")) || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length !== 1) reason = "keys";
				else {
					const receivedState = url.searchParams.get("state") ?? "";
					const receivedCode = (url.searchParams.get("code") ?? "").trim();
					const stateOk = /^[a-f0-9]{64}$/.test(receivedState) && timingSafeEqual(Buffer.from(receivedState), Buffer.from(state));
					const codeOk = receivedCode !== "" && receivedCode.length <= 4096 && !/[\x00-\x1f\x7f]/.test(receivedCode);
					if (!stateOk) reason = "state";
					else if (!codeOk) reason = "code";
					else code = receivedCode;
				}
			}
		} catch {
			reason = "url";
		}
		if (code === null) {
			answer(400, `rejected: ${reason === "" ? "callback" : reason}`);
			return;
		}
		consumed = true;
		answer(200, "authorized");
		finish({
			ok: true,
			code
		}, false);
	};
	let assignedPort = 0;
	const portOf = () => assignedPort;
	timer = setTimeout(() => finish({
		ok: false,
		reason: "timeout"
	}), timeoutMs);
	timer.unref();
	server = createServer({ maxHeaderSize: 8192 }, request);
	server.on("error", () => finish({
		ok: false,
		reason: "failed"
	}));
	const requestedPort = typeof options.port === "number" && Number.isInteger(options.port) && options.port > 0 ? options.port : 0;
	if (requestedPort !== 0 && (requestedPort < 1024 || requestedPort > 65535)) throw new Error("authorize: the requested port must be 0 (random) or in 1024..65535");
	await new Promise((resolve, reject) => {
		const onError = (error) => {
			server?.removeListener("error", onError);
			reject(error);
		};
		server?.once("error", onError);
		server?.listen(requestedPort, "127.0.0.1", () => {
			server?.removeListener("error", onError);
			const address = server?.address() ?? null;
			if (address === null || typeof address === "string") {
				reject(/* @__PURE__ */ new Error("authorize: the loopback port did not bind"));
				return;
			}
			assignedPort = address.port;
			resolve();
		});
	}).catch(() => {});
	const portUsable = assignedPort >= 1024 && assignedPort <= 65535;
	if (!portUsable && assignedPort > 0) finish({
		ok: false,
		reason: "failed"
	});
	const redirect = `http://127.0.0.1:${assignedPort}${RACCOON_LOOPBACK_CALLBACK_PATH}`;
	const authorizeUrl = portUsable ? buildRaccoonAuthorizeUrl({
		port: assignedPort,
		state,
		appname: options.appname,
		base: options.base
	}) : "";
	return {
		state,
		port: assignedPort,
		redirect,
		authorizeUrl,
		result,
		cancel() {
			finish({
				ok: false,
				reason: "closed"
			});
		}
	};
}
/**
* Exchange a one-time authorization code for the token pair.
*
* The request is the official's own shape, byte for byte: `POST
* {authApi}/login_with_authorization_code` with a single `Content-Type`
* header and `{ authorization_code }` — the gateway's web-auth family, so
* the numeric `code === 0` envelope applies. The success gate is the
* official's too: an `access_token`, and EITHER a valid IAM token (no
* refresh expected) OR a refresh token (legacy pair). Anything short of the
* gate is a REFUSAL with a named reason, never a partial credential: saving
* a half-pair would be a credential that rotates into nothing.
* @param {string} code - the one-time authorization code (exchanged at most once; the gateway 400s a replay).
* @param {object} [options]
* @param {typeof fetch} [options.fetcher] - injected fetch (the suites stub it).
* @param {string} [options.authApiBase] - default `${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}`.
* @param {string} [options.iamIssuer] - the `iss` an IAM token must carry (default {@link RACCOON_IAM_ISSUER}).
* @returns {Promise<RaccoonAuthorizeExchange>}
*/
async function exchangeRaccoonAuthorizationCode(code, options = {}) {
	const token = verbatim(code, "");
	if (token === "") return {
		ok: false,
		reason: "invalid_response"
	};
	const authApiBase = str(options.authApiBase, "") !== "" ? str(options.authApiBase, "") : `${RACCOON_API_BASE}${RACCOON_AUTH_PREFIX}`;
	const iamIssuer = str(options.iamIssuer, "") !== "" ? str(options.iamIssuer, "") : RACCOON_IAM_ISSUER;
	const effective = options.fetcher ?? globalThis.fetch;
	let response;
	try {
		response = await effective(`${authApiBase}/login_with_authorization_code`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ authorization_code: token }),
			...options.fetcher === void 0 ? { signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS) } : {}
		});
	} catch {
		return {
			ok: false,
			reason: "network"
		};
	}
	const envelope = parseRaccoonEnvelope(await response.json().catch(() => ({})), response.status);
	if (response.status === 401) return {
		ok: false,
		reason: "session_dead"
	};
	if (envelope.code === 200035) return {
		ok: false,
		reason: "code_not_found"
	};
	if (!response.ok || envelope.code !== 0) return {
		ok: false,
		reason: "server_error"
	};
	const data = envelope.data ?? {};
	const accessToken = verbatim(data.access_token, "");
	if (accessToken === "") return {
		ok: false,
		reason: "invalid_response"
	};
	const iam = isRaccoonIamToken(accessToken);
	if (iam && !raccoonIamTokenIsValid(accessToken, iamIssuer)) return {
		ok: false,
		reason: "token_invalid"
	};
	const refreshToken = verbatim(data.refresh_token, "");
	if (!iam && refreshToken === "") return {
		ok: false,
		reason: "refresh_missing"
	};
	const out = {
		ok: true,
		accessToken,
		refreshToken,
		iam
	};
	const accessExp = decodeRaccoonJwtExpMs(accessToken);
	if (accessExp !== void 0) out.accessExpiresAtMs = accessExp;
	const refreshExp = refreshToken !== "" ? decodeRaccoonJwtExpMs(refreshToken) : void 0;
	if (refreshExp !== void 0) out.refreshExpiresAtMs = refreshExp;
	const officeIdentity = str(data.office_identity, "");
	if (officeIdentity !== "") out.officeIdentity = officeIdentity;
	const nickname = extractRaccoonNickname(data, accessToken);
	if (nickname !== "") out.nickname = nickname;
	return out;
}

//#endregion
//#region src/host/raccoon-catalog.ts
/**
* The Raccoon read operations: normalize a catalogue row, fetch the live
* catalogue, and read the credit balance.
*
* What binds these three together is not a call site but a decision they share:
* a gateway read that comes back unusable degrades to `null` (the caller falls
* back to the static roster / shows nothing) rather than throwing, and a
* *successful* read that simply lists nothing is NOT a failure — the `onFail`
* split is what lets the panel say "the gateway offered nothing" instead of
* "the gateway is down".
*
* @module dsh-connect-sensenova-token-plan/raccoon-catalog
*/
/**
* Raccoon models that ARE image-capable on the gateway even though the
* catalogue does not say so.
*
* The gateway's `tags` array is the current authority for vision ability, but
* it is not exhaustive: `sn-deepseek-v4-1-flash` carries no vision tag and yet
* answered a `chat/completions` request carrying an `image_url` part with
* HTTP 200 on 2026-10-04 (it described the picture correctly), and
* `sn-glm-5-3-flash` did the same on 2026-10-06 (it named all four stripes of
* the probe image). This set holds the models whose image support was PROBED
* rather than declared.
*
* Since 2026-10-22 an unprobed row defaults to image-capable, so membership is
* no longer what grants the flag — it is the provenance the panel prints
* (`visionSource: "measured"`): these rows were checked, the others are only
* assumed. The distinction still earns its keep, because a model that was
* probed and then started refusing images has to be moveable into the denylist
* without being confused with the rows nobody ever looked at.
*
* `sn-deepseek-v4-1-flash-1017` is the dated build the gateway lists BESIDE
* the untagged original (both rows are visible today; the 1017 row is the one
* on promotion). Its tags are the same vision-less set
* (`general` / `code` / `html` / `analysis` / `reasoning` / `auto`), and it
* named all four stripes on 2026-10-22 — a probe of its OWN, because the
* suffix is a build id: a future `-1103` (or a renamed sibling) is a different
* wire id and must be measured again rather than inferred from this entry. A
* name-prefix rule here would be exactly the "belief" this set exists to
* refuse.
* @type {ReadonlySet<string>}
*/
const RACCOON_VISION_WHITELIST = Object.freeze(/* @__PURE__ */ new Set([
	"sn-deepseek-v4-1-flash",
	"sn-deepseek-v4-1-flash-1017",
	"sn-glm-5-3-flash"
]));
/**
* Raccoon models the catalogue TAGS as image-capable that a probe found blind
* — the reason a tag is not a declaration of capability but a claim about it.
*
* The two directions cost differently: a missing flag hides a capability from
* the picker (silently — 2026-10-22: a newly added `-1017` build lost its image
* entry with no signal at all), while a WRONG flag sends the user's image to a
* model that cannot look at it and the model answers **HTTP 200** and then says
* it cannot see the picture, so no layer reports an error and the user reads it
* as their own mistake (2026-10-06 report: "glm-5.3 不能看图却显示可以看图").
*
* That second failure is why the flag still has a denylist even though the
* default is now "assume capable": the default makes the silent loss
* impossible, and this set is the only thing standing between a blind model
* and the user's image. Which is also why the panel labels an unprobed row as
* unverified instead of printing a plain "vision" chip.
*
* `sn-glm-5-3` is the measured case: its row carries `vision` among its tags,
* yet a `chat/completions` request with an `image_url` part answered
* 「无法查看图片（当前环境不支持图像识别）」in all three shapes tried — sync,
* image-part-first, and `stream: true`. The SAME payload was read correctly in
* the same run by `sn-glm-5-3-flash`, `sn-kimi-k3` and
* `sn-deepseek-v4-1-flash`, which is what rules out the payload as the cause.
*
* Membership is a MEASUREMENT with a date, not a verdict about the model: a
* denial is as load-bearing as an addition, so it needs a real probe too, and
* the day the gateway routes this id to a seeing backend the live harness
* (`test/live-raccoon.mjs`, L2e) turns red and the entry comes out.
* @type {ReadonlySet<string>}
*/
const RACCOON_VISION_DENYLIST = Object.freeze(/* @__PURE__ */ new Set(["sn-glm-5-3"]));
/**
* The vision verdict AND its provenance for a raw catalogue row.
*
* Precedence is measured first, then declared, then a permissive default:
*
* 1. the probe DENYLIST — a measured "cannot see" (the only rung that says no);
* 2. the probe WHITELIST — a measured "can see";
* 3. the row's own declaration — `tags` (`vision` / `image` /
*    `image-understanding`), then the legacy `vision` boolean and
*    `input_modalities`;
* 4. nothing at all — **assume capable** (`assumed`).
*
* Rung 4 used to be "assume blind", and that is the change of 2026-10-22: the
* gateway's tag set is not reliable in either direction (it misses real vision
* models and it tags a blind one), so an untagged row says nothing about the
* model. Assuming blind made every gateway addition fake a missing feature —
* the user sees no image entry and no reason why, and only a report fixes it.
* Assuming capable moves the cost to where the signal exists: if the model
* really cannot see, it says so in its reply (HTTP 200, model-level refusal),
* the user reads it as a capability gap rather than a broken plugin, and the
* row is moved into the denylist. Provenance is reported alongside so the
* panel can say "unverified" instead of asserting the capability.
*
* The declaration rung's own field order is measured too: the gateway's
* current `/api/web/llm/v2/model_catalog` carries NO `vision` boolean and NO
* `input_modalities` array at all — the ability lives in `tags` (the client
* normalises `image` / `image-understanding` into `vision` the same way, see
* the desktop App bundle). The legacy branches stay as a defensive ladder in
* case the catalogue drifts back to the older shape. `tags` is read
* case-sensitively — the gateway spells it lowercase, and a case-insensitive
* read would paper over a shape drift instead of flagging it.
* @param {object} model - a raw `categories[].models[]` entry.
* @returns {{vision: boolean, source: RaccoonVisionSource}} the verdict.
*/
function raccoonVisionVerdict(model) {
	const id = str(model.model_name, "") || str(model.id, "") || str(model.name, "");
	if (RACCOON_VISION_DENYLIST.has(id)) return {
		vision: false,
		source: "denied"
	};
	if (RACCOON_VISION_WHITELIST.has(id)) return {
		vision: true,
		source: "measured"
	};
	if ((Array.isArray(model.tags) ? model.tags : []).some((tag) => tag === "vision" || tag === "image" || tag === "image-understanding")) return {
		vision: true,
		source: "declared"
	};
	if (model.vision === true) return {
		vision: true,
		source: "declared"
	};
	if (Array.isArray(model.input_modalities) && model.input_modalities.includes("image")) return {
		vision: true,
		source: "declared"
	};
	return {
		vision: true,
		source: "assumed"
	};
}
/**
* The gateway's credit multiplier for one catalogue row, promotion-aware.
*
* The gateway ships BOTH a list price and an effective price, and the desktop
* client renders the two together (the effective price, with the list price
* struck through) rather than the list price alone — a `limited_free` model
* carries `billing_multiplier: 0.5` beside `billing_effective_multiplier: 0`,
* and quoting 0.5 to the user would misstate what a turn actually costs.
* Quoting 0 would misstate the other way once the promotion lapses, so the
* LIST price is carried alongside as `original` for the panel to show.
*
* The status set is the one the desktop client accepts (`normal` /
* `discount` / `limited_free`); anything else is treated as undeclared. The
* promotion fields are emitted ONLY for the two promotion states, so a
* `normal` row keeps the pre-existing row shape.
* @param {object} model - a raw `categories[].models[]` entry.
* @returns {{multiplier?: number, original?: number, status?: "discount"|"limited_free", note?: string}}
*/
function raccoonEffectiveMultiplier(model) {
	const base = typeof model.billing_multiplier === "number" ? model.billing_multiplier : typeof model.multiplier === "number" ? model.multiplier : void 0;
	const rawStatus = model.billing_status;
	const status = rawStatus === "discount" || rawStatus === "limited_free" ? rawStatus : void 0;
	const effective = typeof model.billing_effective_multiplier === "number" ? model.billing_effective_multiplier : void 0;
	const promoted = status !== void 0 && effective !== void 0;
	const note = typeof model.billing_status_note === "string" ? model.billing_status_note.trim() : "";
	return {
		multiplier: promoted ? effective : base,
		...promoted && base !== void 0 ? { original: base } : {},
		...promoted ? { status } : {},
		...promoted && note !== "" ? { note } : {}
	};
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
async function fetchRaccoonCatalog(credential, fetcher, onFail) {
	const effective = fetcher ?? globalThis.fetch;
	try {
		const response = await effective(`${RACCOON_API_BASE}${RACCOON_LLM_PREFIX}/model_catalog`, {
			headers: raccoonHeaders(credential),
			signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS)
		});
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
			const seen = /* @__PURE__ */ new Set();
			const out = [];
			for (const raw of models) {
				const model = obj(raw);
				if (model.visible === false) continue;
				const id = str(model.model_name, "") || str(model.id, "") || str(model.name, "");
				if (id === "" || seen.has(id)) continue;
				seen.add(id);
				const params = obj(model.params);
				const billing = raccoonEffectiveMultiplier(model);
				const verdict = raccoonVisionVerdict(model);
				out.push({
					id,
					name: str(model.name, id),
					multiplier: billing.multiplier,
					...billing.original !== void 0 ? { originalMultiplier: billing.original } : {},
					...billing.status !== void 0 ? { billingStatus: billing.status } : {},
					...billing.note !== void 0 ? { billingStatusNote: billing.note } : {},
					vision: verdict.vision,
					visionSource: verdict.source,
					contextWindow: num(params.context_window ?? model.context_window ?? model.context_length),
					maxOutputLength: num(params.max_tokens ?? params.max_output_tokens ?? model.max_output_tokens ?? model.max_output_length)
				});
			}
			if (out.length > 0) return out;
		}
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
async function fetchRaccoonBalance(credential, fetcher, onFail) {
	const effective = fetcher ?? globalThis.fetch;
	try {
		const response = await effective(`${RACCOON_API_BASE}${RACCOON_POINTS_PREFIX}/balance`, {
			headers: raccoonHeaders(credential),
			signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS)
		});
		if (!response.ok) {
			const bodyText = await response.text().catch(() => "");
			onFail?.(`HTTP ${response.status} ${bodyText.slice(0, 160)}`);
			return null;
		}
		const envelope = parseRaccoonEnvelope(await response.json().catch(() => ({})), response.status);
		if (envelope.code !== 0 || envelope.data === null) {
			onFail?.(`envelope code=${envelope.code} message=${envelope.message}`);
			return null;
		}
		const read = { total: numOrNullSafe(envelope.data.available_points ?? envelope.data.balance ?? envelope.data.available ?? envelope.data.amount) };
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

//#endregion
//#region src/host/raccoon-fallback.ts
/**
* The static fallback roster and the pinned-but-unwired thinking dialect.
*
* This is the leaf of the Raccoon dependency DAG: nothing here imports another
* Raccoon module, and nothing imports this except the three consumers that need
* a roster when the live read came back empty.
*
* @module dsh-connect-sensenova-token-plan/raccoon-fallback
*/
/**
* The static fallback roster: the six `visible: true` chat models the gateway
* listed at probe time (2026-09), with the per-model `context_window` /
* `max_output_length` the catalogue then carried. Used ONLY when
* `fetchRaccoonCatalog` comes back empty, so the provider still offers models;
* a fresh catalogue always wins over this table.
*
* These numbers are a CATALOG SNAPSHOT (the directory-authoritative values as
* they read at probe time), not guessed defaults — see ADR-004 / docs/
* SENSENOVA-API.md: the descriptor must declare directory values and fall back
* to undeclared (harness fills 32768) when the field is truly absent. They are
* only reached when the live catalogue is unreachable, which is exactly the
* scenario where a slightly stale but real window beats an invented one.
*
* The `vision` column is the ONE column that is not the snapshot's own: it
* carries the measured verdict (2026-10-06 probe, see
* `raccoon-catalog.ts`'s probe sets and docs/ADR.md ADR-009), because the
* catalogue's declaration was measured wrong in BOTH directions —
* `sn-glm-5-3` is tagged `vision` and cannot see, `sn-glm-5-3-flash` is
* untagged and can. These rows never pass through `raccoonRowVision`
* (they are already normalized), so the two bits below are kept honest by a
* consistency check in `test/raccoon.test.mjs` rather than by construction.
*/
const RACCOON_FALLBACK_MODELS = Object.freeze([
	{
		id: "sn-sensenova-6-8-flash",
		name: "SenseNova 6.8 Flash",
		multiplier: 0,
		vision: true,
		contextWindow: 256e3,
		maxOutputLength: 63999
	},
	{
		id: "sn-sensenova-6-8-flash-lite",
		name: "SenseNova 6.8 Flash Lite",
		multiplier: 0,
		vision: true,
		contextWindow: 256e3,
		maxOutputLength: 63999
	},
	{
		id: "sn-glm-5-3",
		name: "GLM-5.3",
		multiplier: .75,
		vision: false,
		contextWindow: 1e6,
		maxOutputLength: 65536
	},
	{
		id: "sn-kimi-k3",
		name: "Kimi K3",
		multiplier: 1,
		vision: true,
		contextWindow: 1e6,
		maxOutputLength: 65536
	},
	{
		id: "sn-glm-5-3-flash",
		name: "GLM-5.3 Flash",
		multiplier: .2,
		vision: true,
		contextWindow: 1e6,
		maxOutputLength: 65536
	},
	{
		id: "sn-deepseek-v4-1-flash",
		name: "DeepSeek V4.1 Flash",
		multiplier: .25,
		vision: true,
		contextWindow: 1e6,
		maxOutputLength: 65536
	}
]);

//#endregion
//#region src/host/raccoon-models.ts
/**
* Raccoon catalogue entry → pi-ai model descriptor mapping — the peer-free half
* of the second upstream provider.
*
* Mirrors `llm-models.ts`'s discipline: build plain objects only (no Host peer
* import) so the mapping decisions are testable on a clean checkout.
* `raccoon-llm-adapter.ts` is the peer-dependent half that hands these
* descriptors to `createProvider`.
*
* Two decisions carried here:
*   1. `reasoning: false` for now — the Raccoon gateway's ONLY effective
*      thinking channel is `extra_body.thinking` (a provider-level dialect),
*      which pi-ai's openai-completions does NOT emit. Offering a thinking
*      selector would 400 or be silently ignored, so the honest v1 shape is
*      "no toggle; the gateway defaults to thinking ON". This is a stated
*      limitation, not an oversight.
*   2. The Raccoon auth/identity headers ride in each descriptor's `headers`
*      map (pi-ai merges `model.headers` into the OpenAI client), because the
*      gateway reads `X-Org-Code` / `X-Raccoon-Language` per request.
*
* @module dsh-connect-sensenova-token-plan/raccoon-models
*/
/** The provider id this plugin registers under for Raccoon. */
const RACCOON_PROVIDER_ID = "sensenova-raccoon";
/** What the DSH model picker shows as the Raccoon provider's name. */
const RACCOON_DISPLAY_NAME = "SenseNova Raccoon";
/**
* The Raccoon LLM base URL the OpenAI-compatible chat endpoint addresses.
* `openAICompletionsApi` appends `chat/completions` to this.
*/
const RACCOON_BASE_URL = `${RACCOON_API_BASE}${RACCOON_LLM_PREFIX}`;
/** The zero-cost sentinel: per-token prices are unknowable (credit-gated). */
const NO_COST = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
});
/** The Raccoon auth/identity headers every request carries. */
function raccoonRequestHeaders(officeIdentity = "") {
	return {
		Accept: "application/json",
		"Content-Type": "application/json",
		"X-Org-Code": str(officeIdentity, ""),
		"X-Raccoon-Language": "zh"
	};
}
/**
* The Raccoon model rows the panel shows and the adapter offers.
*
* A live catalogue row always beats the static fallback roster: the caller
* passes the fetched catalogue, and only when it is `null`/empty does this
* fall back to `RACCOON_FALLBACK_MODELS`. The row keeps only what the picker
* and panel need (id, a display name, vision, window, multiplier) — the raw
* catalogue field the gateway adds later does not leak into the panel.
* @param {object[]|null} [catalog] - the `fetchRaccoonCatalog` result.
* @returns {object[]} the Raccoon model rows.
*/
function raccoonRoster(catalog) {
	const rows = Array.isArray(catalog) && catalog.length > 0 ? catalog : RACCOON_FALLBACK_MODELS;
	const out = [];
	for (const row of rows) {
		const source = row;
		const id = str(source.id, "");
		if (id === "") continue;
		out.push({
			id,
			name: str(source.name, id),
			vision: source.vision === true,
			multiplier: typeof source.multiplier === "number" ? source.multiplier : void 0,
			contextWindow: num(source.contextWindow),
			maxOutputLength: num(source.maxOutputLength)
		});
	}
	return out;
}
/**
* Apply the panel's pushed-model curation to a roster.
*
* `null` (the panel never saved a list) keeps the roster WHOLE — curation is
* opt-in, like the switch itself. A saved list filters by id; a list that
* names no current id publishes an empty offer (the picker showing zero
* Raccoon models IS the curation the panel asked for, not a fault).
* @param {object[]} [rows] - the `raccoonRoster` result.
* @param {string[]|null} [enabledIds] - the curated ids, or `null`.
* @returns {object[]} the filtered roster.
*/
function filterRaccoonRows(rows, enabledIds) {
	const list = Array.isArray(rows) ? rows : [];
	if (!Array.isArray(enabledIds)) return list;
	const wanted = new Set(enabledIds);
	return list.filter((row) => wanted.has(str(row?.id, "")));
}
/**
* Map one Raccoon row onto the pi-ai model descriptor the adapter offers.
* @param {object} row - a {@link raccoonRoster} row (must carry `id`).
* @param {object} [options] - `{ officeIdentity }` for the request headers.
* @returns {object} the pi-ai descriptor.
*/
function raccoonToDescriptor(row, options = {}) {
	const id = str(row?.id, "");
	if (id === "") throw new Error("raccoonToDescriptor: row has no id");
	const vision = row?.vision === true;
	const multiplier = typeof row?.multiplier === "number" ? row.multiplier : void 0;
	const name = str(row?.name, id);
	const displayName = multiplier === void 0 ? name : `${name} · x${multiplier.toFixed(2)}`;
	const contextWindow = num(row?.contextWindow);
	const maxOutputLength = num(row?.maxOutputLength);
	return {
		id,
		name: displayName,
		api: "openai-completions",
		provider: RACCOON_PROVIDER_ID,
		baseUrl: RACCOON_BASE_URL,
		input: vision ? ["text", "image"] : ["text"],
		reasoning: false,
		cost: { ...NO_COST },
		...contextWindow === void 0 ? {} : { contextWindow },
		...maxOutputLength === void 0 ? {} : { maxTokens: maxOutputLength },
		headers: raccoonRequestHeaders(options.officeIdentity),
		compat: {
			maxTokensField: "max_tokens",
			supportsDeveloperRole: false
		}
	};
}
/**
* Build the whole descriptor list for one Raccoon roster.
* @param {object[]} [roster] - the {@link raccoonRoster} result.
* @param {object} [options] - `{ officeIdentity }`.
* @returns {object[]} the pi-ai descriptors.
*/
function buildRaccoonDescriptors(roster, options = {}) {
	const list = Array.isArray(roster) ? roster : raccoonRoster(null);
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const row of list) {
		const id = str(row?.id, "");
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		out.push(raccoonToDescriptor(row, options));
	}
	return out;
}

//#endregion
export { RACCOON_LOGIN_TIMEOUT_MS as C, isDeadRaccoonSession as S, pollRaccoonQrLogin as _, raccoonRoster as a, decodeRaccoonJwtExpMs as b, fetchRaccoonCatalog as c, startRaccoonAuthorizeReceiver as d, RACCOON_QR_EXPIRED as f, pollRaccoonIamQrLogin as g, issueRaccoonScan as h, filterRaccoonRows as i, RACCOON_AUTHORIZE_TIMEOUT_MS as l, generateRaccoonQrCode as m, RACCOON_PROVIDER_ID as n, RACCOON_FALLBACK_MODELS as o, RACCOON_QR_STATUS as p, buildRaccoonDescriptors as r, fetchRaccoonBalance as s, RACCOON_DISPLAY_NAME as t, exchangeRaccoonAuthorizationCode as u, raccoonQrLoginUrl as v, RACCOON_QR_POLL_INTERVAL_MS as w, RACCOON_CODE as x, refreshRaccoonCredential as y };
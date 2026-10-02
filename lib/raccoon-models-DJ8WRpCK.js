import { f as obj, l as errMsg, u as num, v as str } from "./host-config-DAg51QS-.js";
import { randomBytes } from "node:crypto";

//#region src/host/raccoon.ts
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
/** The gateway this provider talks to. */
const RACCOON_API_BASE = "https://xiaohuanxiong.com";
/** Auth endpoints. */
const RACCOON_AUTH_PREFIX = "/api/web/auth/v1";
/** Inference + model catalogue. */
const RACCOON_LLM_PREFIX = "/api/web/llm/v2";
/** Credits (balance). */
const RACCOON_POINTS_PREFIX = "/api/web/points/v1";
/** The QR poll cadence: the gateway's own client polls every 2 s. */
const RACCOON_QR_POLL_INTERVAL_MS = 2e3;
/** The QR login's overall deadline: a scan that takes longer is voided. */
const RACCOON_LOGIN_TIMEOUT_MS = 3e5;
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
		Authorization: `Bearer ${str(source.access_token ?? source.accessToken, "")}`,
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
		const accessToken = str(envelope.data.access_token, "");
		if (accessToken === "") return { status: RACCOON_QR_STATUS.PENDING };
		const refreshToken = str(envelope.data.refresh_token, "");
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
	const refreshToken = str(obj(credential).refresh_token, "");
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
		code: isDeadRaccoonEnvelope(envelope.code) ? RACCOON_CODE.SESSION_DEAD : RACCOON_CODE.REFRESH_REJECTED,
		message: envelope.message || `refresh refused (code ${envelope.code})`
	};
	const accessToken = str(envelope.data.access_token, "");
	if (accessToken === "") return {
		ok: false,
		code: RACCOON_CODE.REFRESH_REJECTED,
		message: "the refresh response carried no access token"
	};
	const refreshTokenOut = str(envelope.data.refresh_token, "");
	const expMs = decodeRaccoonJwtExpMs(accessToken);
	return {
		ok: true,
		accessToken,
		refreshToken: refreshTokenOut,
		...expMs !== void 0 ? { expiresAtMs: expMs } : {}
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
			signal: AbortSignal.timeout(3e4)
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
				const id = str(model.id, "");
				if (id === "" || seen.has(id)) continue;
				seen.add(id);
				out.push({
					id,
					name: str(model.name, id),
					multiplier: typeof model.multiplier === "number" ? model.multiplier : void 0,
					vision: model.vision === true || (Array.isArray(model.input_modalities) ? model.input_modalities.includes("image") : false),
					contextWindow: num(model.context_window ?? model.context_length),
					maxOutputLength: num(model.max_output_tokens ?? model.max_output_length)
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
			signal: AbortSignal.timeout(3e4)
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
/**
* The static fallback roster: the six `visible: true` chat models the gateway
* listed at probe time (2026-09). Used ONLY when `fetchRaccoonCatalog` comes
* back empty, so the provider still offers models; a fresh catalogue always
* wins over this table.
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
		vision: true,
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
		vision: false,
		contextWindow: 1e6,
		maxOutputLength: 65536
	},
	{
		id: "sn-deepseek-v4-1-flash",
		name: "DeepSeek V4.1 Flash",
		multiplier: .25,
		vision: false,
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
	if (id === "") throw new Error("racconToDescriptor: row has no id");
	const vision = row?.vision === true;
	const multiplier = typeof row?.multiplier === "number" ? row.multiplier : void 0;
	const name = str(row?.name, id);
	return {
		id,
		name: multiplier === void 0 ? name : `${name} · x${multiplier.toFixed(2)}`,
		api: "openai-completions",
		provider: RACCOON_PROVIDER_ID,
		baseUrl: RACCOON_BASE_URL,
		input: vision ? ["text", "image"] : ["text"],
		reasoning: false,
		cost: { ...NO_COST },
		contextWindow: num(row?.contextWindow) ?? 256e3,
		maxTokens: num(row?.maxOutputLength) ?? 32e3,
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
export { raccoonQrLoginUrl as _, raccoonRoster as a, RACCOON_LOGIN_TIMEOUT_MS as c, decodeRaccoonJwtExpMs as d, fetchRaccoonBalance as f, pollRaccoonQrLogin as g, isDeadRaccoonSession as h, filterRaccoonRows as i, RACCOON_QR_POLL_INTERVAL_MS as l, generateRaccoonQrCode as m, RACCOON_PROVIDER_ID as n, RACCOON_CODE as o, fetchRaccoonCatalog as p, buildRaccoonDescriptors as r, RACCOON_FALLBACK_MODELS as s, RACCOON_DISPLAY_NAME as t, RACCOON_QR_STATUS as u, refreshRaccoonCredential as v };
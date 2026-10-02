import { _ as retryBounded, a as name, c as degrade, d as numOrNull, f as obj, g as redactSecrets, h as pluginError, i as isAdmitted, l as errMsg, m as pickDefined, n as hostName, o as resolveAuthOverrides, p as optional, r as inject, s as resolveSettings, t as CONFIG_DEFAULTS, u as num, v as str, y as verbatim } from "./host-config-DAg51QS-.js";
import { c as RACCOON_QR_POLL_INTERVAL_MS, d as fetchRaccoonBalance, f as fetchRaccoonCatalog, g as refreshRaccoonCredential, h as raccoonQrLoginUrl, i as filterRaccoonRows, l as RACCOON_QR_STATUS, m as pollRaccoonQrLogin, n as RACCOON_PROVIDER_ID, o as RACCOON_FALLBACK_MODELS, p as generateRaccoonQrCode, s as RACCOON_LOGIN_TIMEOUT_MS, t as RACCOON_DISPLAY_NAME, u as decodeRaccoonJwtExpMs } from "./raccoon-models-CUfY4D7j.js";
import { a as exhaustedModelIds, c as summarizeCatalog, d as identifyVisionModel, f as parsePools, l as isImageGenModel, n as LLM_DISPLAY_NAME, o as filterByEnabled, p as parseTrend, r as LLM_PROVIDER_ID, s as rosterWithAvailability, t as DEFAULT_REASONING_EFFORT, u as checkShape } from "./llm-models-caEWL5Ue.js";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promises } from "node:fs";

//#region src/host/codes.ts
/**
* One taxonomy for every failure this plugin reports.
*
* A code is declared ONCE here; every consumer reads THIS table rather than
* carrying its own copy:
*   - `sensenova-auth.ts` throws them — it folds the platform's own machine
*     reasons onto this table via {@link IAM_REASON_CODES}, declared here;
*   - `token-store.ts` decides which ones are credential-shaped (parked rather
*     than timed) by reading {@link CREDENTIAL_REFUSALS}, declared here;
*   - `snapshot-aggregate.ts` decides which ones mean "we never got a token"
*     by reading {@link isAuthFailure}, declared here.
* Adding a code means one new entry — credential-refusal and auth-failure are
* both decided in this one place, so a new platform reason can no longer be
* produced but not recognised (the three-list split used to do exactly that,
* reporting a locked account as a generic console failure).
*
* @module dsh-connect-sensenova-token-plan/codes
*/
/**
* Every failure code this plugin can produce or carry.
*
* The names are the wire values: they reach the panel in `body.code` and are
* what tests and the client branch on, so they are not free to rename.
*/
const CODE = Object.freeze({
	/**
	* A malformed endpoint override (a bad override URL, a missing JWKS key id,
	* a non-`Uint8Array` handed to `b64url`). Its wire value is `"config"`; the
	* snapshot route reports it to the panel as {@link CODE.CONFIG_ERROR}
	* (`"config_error"`) so the panel says "fix the row" rather than inviting a
	* sign-in. Never retried.
	*/
	CONFIG: "config",
	/** The password-sealing key set could not be read. */
	JWKS: "jwks",
	/** The OIDC walk ended without a challenge or a code. */
	LOGIN_FLOW: "login_flow",
	/** The submitted account is empty. The user has to fix it; waiting will not. */
	MISSING_CREDENTIALS: "missing_credentials",
	/** No account has ever been entered. Not a refusal: nothing was attempted. */
	NOT_CONFIGURED: "not_configured",
	/** The platform said the account or password is wrong. */
	LOGIN_REJECTED: "login_rejected",
	/** The platform locked the account. */
	ACCOUNT_LOCKED: "account_locked",
	/** The platform rate-limited the attempt. */
	RATE_LIMITED: "rate_limited",
	/** A captcha or an SMS step only a human can complete. */
	VERIFICATION_REQUIRED: "verification_required",
	/** The platform refused without naming a reason this table knows. */
	LOGIN_FAILED: "login_failed",
	/** The token endpoint would not exchange the code. */
	TOKEN_REJECTED: "token_rejected",
	/** The refresh token is dead: only a password login can recover. */
	REFRESH_REJECTED: "refresh_rejected",
	/** The refresh call failed for any other reason (network, 5xx). */
	REFRESH_FAILED: "refresh_failed",
	/** A stored grant carries no refresh token to renew with. */
	NO_REFRESH_TOKEN: "no_refresh_token",
	/** The console refused the token twice in a row (a renewal already failed). */
	JWT_EXPIRED: "jwt_expired",
	/** No token could be obtained: an auth-shaped failure folded into one code. */
	AUTH_ERROR: "auth_error",
	/** The console call itself failed (usually transient; the next poll clears it). */
	CONSOLE_ERROR: "console_error",
	/** The plugin row is misconfigured (the panel-facing spelling of {@link CODE.CONFIG}). */
	CONFIG_ERROR: "config_error"
});
/**
* What the platform's own machine reasons mean, keyed by their folded form.
*
* IAM answers with a `google.rpc.Status` envelope whose real cause sits in
* `details[].reason` (`invalidAccountOrPassword`, `accountLocked`,
* `tooManyAttempts`, …). Matching that code exactly — and treating the
* substring scan in `sensenova-auth.ts` as a fallback for a reason this table
* has not learned yet — is the difference between a reworded message and a
* silently reclassified lockout.
*
* Keys are lowercased with separators removed, because the platform writes
* camelCase while other responses spell the same reason snake_case.
*/
const IAM_REASON_CODES = Object.freeze({
	invalidaccountorpassword: CODE.LOGIN_REJECTED,
	incorrectusernameorpassword: CODE.LOGIN_REJECTED,
	wrongusernameorpassword: CODE.LOGIN_REJECTED,
	invalidcredentials: CODE.LOGIN_REJECTED,
	incorrectpassword: CODE.LOGIN_REJECTED,
	accountlocked: CODE.ACCOUNT_LOCKED,
	accountdisabled: CODE.ACCOUNT_LOCKED,
	userlocked: CODE.ACCOUNT_LOCKED,
	toomanyattempts: CODE.RATE_LIMITED,
	ratelimitexceeded: CODE.RATE_LIMITED,
	toomanyrequests: CODE.RATE_LIMITED,
	verificationrequired: CODE.VERIFICATION_REQUIRED,
	captcharequired: CODE.VERIFICATION_REQUIRED
});
/**
* Refusals that describe the CREDENTIAL rather than the moment.
*
* A wrong password does not become right by waiting, so a timer is the wrong
* instrument for it: the panel must keep asking for an account instead of
* quietly burning another attempt every minute. The platform's own
* verification prompts are the same shape — the user has to do something, so
* nothing is retried behind their back.
*
* `NOT_CONFIGURED` is deliberately not here. It is not a refusal at all: it
* means no account has ever been entered, so there was never an attempt to
* avoid repeating. Parking it would write a throttle record on every fresh
* install and then report `needsUserAction` to a user who has done nothing
* wrong yet.
* @type {ReadonlySet<string>}
*/
const CREDENTIAL_REFUSALS = Object.freeze(/* @__PURE__ */ new Set([CODE.LOGIN_REJECTED, CODE.VERIFICATION_REQUIRED]));
/**
* Every code that means "the plugin could not obtain a token".
*
* The panel says something different for these than for a console failure:
* one is fixed by signing in, the other usually clears on the next poll. This
* set is what keeps that distinction honest — every platform reason this table
* folds ({@link IAM_REASON_CODES}) and every parked refusal
* ({@link CREDENTIAL_REFUSALS}) MUST be in here, or one of them would be
* reported as `console_error` and the user would be told the wrong thing.
*
* {@link CODE.CONFIG} is deliberately absent. It is thrown from inside the auth
* walk, but it names a MISCONFIGURED row (an operator fix), not a failed token
* acquisition — so `failureCode` maps it to {@link CODE.CONFIG_ERROR} and the
* panel says "fix the row" instead of inviting a sign-in.
*
* {@link CODE.JWT_EXPIRED} is absent for a different and equally deliberate
* reason, and it is the one a future reader is most likely to "fix" by mistake:
* it means a token WAS obtained and the console then refused it (PITFALLS §4
* — 401 proves a token was rejected, not that none was ever issued), so it is
* not a failure to ACQUIRE one. `failureCode` passes it through verbatim,
* beside {@link CODE.NOT_CONFIGURED}, and the panel gives it its own wording.
* Folding it into the generic {@link CODE.AUTH_ERROR} would erase exactly the
* distinction that tells the user whether to wait for a silent renewal or to
* act. Do not add it here without moving that pass-through with it.
* @type {ReadonlySet<string>}
*/
const AUTH_FAILURE_CODES = Object.freeze(/* @__PURE__ */ new Set([
	CODE.JWKS,
	CODE.LOGIN_FLOW,
	CODE.MISSING_CREDENTIALS,
	CODE.NOT_CONFIGURED,
	CODE.LOGIN_REJECTED,
	CODE.ACCOUNT_LOCKED,
	CODE.RATE_LIMITED,
	CODE.VERIFICATION_REQUIRED,
	CODE.LOGIN_FAILED,
	CODE.TOKEN_REJECTED,
	CODE.REFRESH_REJECTED,
	CODE.REFRESH_FAILED,
	CODE.NO_REFRESH_TOKEN
]));
/**
* Whether this failure came from getting a token rather than from calling the
* console.
* @param {unknown} error - the caught error.
* @returns {boolean} true when the token could not be obtained.
*/
function isAuthFailure(error) {
	const code = error === null || typeof error !== "object" ? void 0 : error.code;
	return typeof code === "string" && AUTH_FAILURE_CODES.has(code);
}
/**
* Whether this refusal is fixed by the user acting rather than by waiting.
* @param {string} code - a {@link CODE} value.
* @returns {boolean} true when the refusal should be parked, not timed.
*/
function isCredentialRefusal(code) {
	return typeof code === "string" && CREDENTIAL_REFUSALS.has(code);
}
/**
* Failures that no sign-in can fix — the ones the panel must not answer with
* the account form.
*
*   `config_error` — a bad endpoint override; the operator must fix it.
*   `console_error` — the console did not answer; usually transient, and the
*                     text must say so instead of inviting a login.
*
* This is the declaration; `client.js` ships its own copy
* (`FORM_EXCLUDED_CODES`) because the browser bundle cannot import this
* module — and `test/panel.test.mjs` asserts the two sets are equal, so the
* copy cannot fall behind the declaration.
*/
const NO_LOGIN_CODES = Object.freeze(/* @__PURE__ */ new Set([CODE.CONFIG_ERROR, CODE.CONSOLE_ERROR]));

//#endregion
//#region src/host/sensenova-crypto.ts
/**
* dsh-connect-sensenova-token-plan — the cryptographic primitives the console login needs.
*
* Sealing the password into a JWE, deriving a PKCE pair, reading a JWT's own
* claims. All of it is pure in its inputs: where the login flow reads
* endpoints from configuration, this module is TOLD which endpoint and which
* key id to use. Nothing here reaches for a module-level setting — not even the
* JWKS cache, which each caller owns via {@link createJwksCache} (see below), so
* two callers with different configurations cannot disturb one another, and a
* test can exercise any of it without configuring the world first.
*
* @module dsh-connect-sensenova-token-plan/sensenova-crypto
*/
/**
* Base64url-encode bytes, unpadded, as JOSE requires.
*
* Only `Uint8Array` and `ArrayBuffer` are accepted; anything else is REJECTED
* with a `config` error. That guard exists because of a bug that cost a working
* login: `Buffer.from(new Uint32Array(8))` returns EIGHT bytes, not thirty-two.
* Node encodes a non-Uint8 TypedArray as if each ELEMENT were one byte,
* silently — no throw, no warning, just a quarter of the entropy expected. A
* PKCE verifier built that way came out 11 characters long, and the token
* endpoint's only complaint was an opaque `invalid_grant` carrying the hint
* "The PKCE code verifier must be at least 43 characters", with the real cause
* nowhere in it. Rather than compensate for Node's per-element encoding, this
* module refuses the shape outright so the mistake cannot reach the wire.
* @param {Uint8Array|ArrayBuffer} bytes - the bytes to encode.
* @returns {string} the unpadded base64url text.
*/
function b64url(bytes) {
	if (!(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) {
		const bad = bytes;
		throw pluginError(CODE.CONFIG, `b64url expects Uint8Array or ArrayBuffer, got ${bad?.constructor?.name ?? typeof bad}`);
	}
	return Buffer.from(bytes).toString("base64url");
}
/** Decode a base64url JWT segment into a UTF-8 string. */
function b64urlDecode(segment) {
	return Buffer.from(segment, "base64url").toString("utf8");
}
/**
* Read the console JWT's own claims without verifying its signature.
*
* Only used to learn `exp`, which the server is the authority for; the
* signature is never checked here because the panel is not the audience. A
* failure is not fatal — the caller falls back to letting the console decide.
* @param {string} token - a JWT.
* @returns {Record<string, unknown>} the payload, or `{}` when unreadable.
*/
function readJwtClaims(token) {
	const segments = str(token, "").split(".");
	if (segments.length < 2) return {};
	try {
		const parsed = JSON.parse(b64urlDecode(segments[1] ?? ""));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}
/**
* The access token's expiry as epoch milliseconds, or `null` when the token
* carries no readable `exp`.
* @param {string} token - a JWT.
* @returns {number|null}
*/
function readJwtExpiry(token) {
	const exp = readJwtClaims(token).exp;
	return typeof exp === "number" && Number.isFinite(exp) ? exp * 1e3 : null;
}
/** RFC 7636 bounds for a PKCE verifier, in characters. */
const PKCE_VERIFIER_MIN = 43;
const PKCE_VERIFIER_MAX = 128;
/** Random bytes for the verifier: 48 → ~64 base64url chars, mid-range not the 43 floor. */
const PKCE_VERIFIER_BYTES = 48;
/** AES-GCM IV length (RFC 7516 §5.1). */
const GCM_IV_BYTES = 12;
/** AES-GCM authentication tag length in bytes (128-bit, RFC 7516 §5.1). */
const GCM_TAG_BYTES = 16;
/**
* A PKCE verifier/challenge pair (S256).
*
* `subtle.digest` is asynchronous, so this is too; the challenge is the
* base64url of the digest's bytes, never the Promise itself.
*
* 48 random bytes encode to 64 characters — deliberately mid-range rather than
* at the 43-character floor. Sitting on the minimum means the next truncation
* bug (see {@link b64url}) produces a verifier that is *almost* valid and an
* error that names everything except the cause. The length is asserted here too,
* so a regression fails at the point that created it with a sentence a reader
* can act on, instead of at the token endpoint with an `invalid_grant`.
* @returns {Promise<{verifier: string, challenge: string}>}
*/
async function pkce() {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(PKCE_VERIFIER_BYTES)));
	if (verifier.length < PKCE_VERIFIER_MIN || verifier.length > PKCE_VERIFIER_MAX) throw pluginError(CODE.CONFIG, `PKCE verifier is ${verifier.length} characters, outside RFC 7636's ${PKCE_VERIFIER_MIN}-${PKCE_VERIFIER_MAX}`);
	return {
		verifier,
		challenge: b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
	};
}
/** How long a fetched JWKS is reused. The set rotates rarely, not per login. */
const JWKS_TTL_MS = 6e5;
/**
* A reusable key-set cache: the shape {@link sealPassword} expects in its
* `cache` option.
*
* This used to be one module-level `Map`. That contradicted this module's own
* promise — "nothing here reaches for a module-level setting" — and it leaked
* across callers exactly the way the throttle file does: two configurations
* shared one cached key set, so a test that wanted a clean cache had to reload
* the whole module (`import("...?shape=…")`) rather than just make a new cache.
* Handing each caller its own removes both problems at once: instances cannot
* disturb one another, and the isolation is a `createJwksCache()` call, not an
* import-cache hack. Keyed BY ENDPOINT inside, so one instance pointed at two
* mirrors still keeps their keys apart.
* @returns {Map<string, {keys: object[], at: number}>} an empty cache.
*/
function createJwksCache() {
	return /* @__PURE__ */ new Map();
}
/**
* Fetch a platform JWKS, honouring the caller-supplied short cache.
* @param {object} options - what to fetch and how.
* @param {string} options.jwksEndpoint - the JWKS document URL.
* @param {number} [options.timeoutMs] - request deadline.
* @param {() => number} [options.now] - clock source; injected by the tests.
* @param {Map<string, {keys: object[], at: number}>} options.cache - where to
*   keep the fetched set. Owned by the caller (see {@link createJwksCache}), so
*   no two instances share it unless they are handed the same map on purpose.
* @returns {Promise<object[]>} the key set.
*/
async function fetchJwks({ jwksEndpoint, timeoutMs = 15e3, now = Date.now, cache }) {
	const cached = cache.get(jwksEndpoint);
	if (cached !== void 0 && now() - cached.at < JWKS_TTL_MS) return cached.keys;
	const response = await fetch(jwksEndpoint, {
		redirect: "manual",
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!response.ok) throw pluginError(CODE.JWKS, `JWKS endpoint returned HTTP ${response.status}`);
	const body = obj(await response.json());
	const keys = Array.isArray(body.keys) ? body.keys : [];
	if (keys.length === 0) throw pluginError(CODE.JWKS, "JWKS endpoint returned no keys");
	cache.set(jwksEndpoint, {
		keys,
		at: now()
	});
	return keys;
}
/**
* Seal the password into a compact JWE the IAM endpoint accepts.
*
* The plaintext never leaves this function: it is sealed to the platform's
* RSA public key with RSA-OAEP, then the content is wrapped with A256GCM. The
* result is the 5-segment compact serialization.
*
* The two algorithm choices are dictated by the platform, not free parameters.
* The console seals with `alg: RSA-OAEP` — OAEP over SHA-1 — so the key is
* imported for SHA-1; `RSA-OAEP-256` here is rejected by IAM. The protected
* header is the AAD, and it enters the AAD as its base64url SEGMENT, not as
* the JSON text, per RFC 7516 §5.1 step 14.
* @param {string} password - the account password.
* @param {object} [options] - which key and where to find it; the runtime guards
*   below reject an absent endpoint / key id, so a missing option is a clear
*   CONFIG error rather than a silent fallback.
* @param {string} [options.jwksEndpoint] - the JWKS document URL.
* @param {string} [options.encKeyId] - the `kid` to seal to.
* @param {number} [options.timeoutMs] - request deadline.
* @param {Map<string, {keys: object[], at: number}>} [options.cache] - a
*   caller-owned key-set cache (see {@link createJwksCache}). Omitted, the seal
*   fetches fresh every call — correct but chatty; the login flow passes one so
*   repeated attempts reuse the set WITHOUT sharing it with another instance.
* @returns {Promise<string>} the compact JWE.
*/
async function sealPassword(password, options = {}) {
	const { jwksEndpoint, encKeyId, timeoutMs, cache = createJwksCache() } = options;
	if (str(jwksEndpoint, "") === "") throw pluginError(CODE.CONFIG, "no JWKS endpoint is configured");
	if (str(encKeyId, "") === "") throw pluginError(CODE.CONFIG, "no encryption key id is configured");
	const entry = (await fetchJwks({
		jwksEndpoint: str(jwksEndpoint, ""),
		...timeoutMs !== void 0 ? { timeoutMs } : {},
		cache
	})).find((key) => obj(key).kid === encKeyId);
	if (entry === void 0) throw pluginError(CODE.JWKS, `JWKS has no key ${encKeyId}`);
	const source = obj(entry);
	const modulus = str(source.n, "");
	const exponent = str(source.e, "");
	if (modulus === "" || exponent === "") throw pluginError(CODE.JWKS, "JWKS key is missing n/e");
	const key = await crypto.subtle.importKey("jwk", {
		kty: "RSA",
		n: modulus,
		e: exponent,
		alg: "RSA-OAEP",
		ext: true
	}, {
		name: "RSA-OAEP",
		hash: "SHA-1"
	}, false, ["encrypt"]);
	const contentKey = await crypto.subtle.generateKey({
		name: "AES-GCM",
		length: 256
	}, true, ["encrypt"]);
	const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", contentKey));
	const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
	const protectedHeader = b64url(new TextEncoder().encode(JSON.stringify({
		alg: "RSA-OAEP",
		enc: "A256GCM"
	})));
	const plaintext = new TextEncoder().encode(password);
	const sealedGcm = new Uint8Array(await crypto.subtle.encrypt({
		name: "AES-GCM",
		iv,
		additionalData: new TextEncoder().encode(protectedHeader),
		tagLength: 128
	}, contentKey, plaintext));
	const ciphertext = sealedGcm.subarray(0, sealedGcm.length - GCM_TAG_BYTES);
	const gcmTag = sealedGcm.subarray(sealedGcm.length - GCM_TAG_BYTES);
	return [
		protectedHeader,
		b64url(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, rawKey)),
		b64url(iv),
		b64url(ciphertext),
		b64url(gcmTag)
	].join(".");
}

//#endregion
//#region src/host/sensenova-auth.ts
/**
* SenseNova console authentication — OIDC authorization-code login and
* silent refresh.
*
* Reproduces the console's own browser login so the panel never asks you to
* paste a JWT by hand:
*
*   1. `GET /oauth2/auth` with PKCE → follow redirects to the Hydra login
*      challenge.
*   2. Encrypt the password into a compact JWE (RSA-OAEP + A256GCM) under the
*      platform JWKS key, and POST it to the IAM login endpoint together with
*      that challenge. The password is never in plaintext on the wire.
*   3. Follow the callback to the `authorization_code`.
*   4. Exchange code + verifier for an access token (the console JWT) AND a
*      refresh token.
*
* With a refresh token in hand the access token is renewable: `refresh()` is
* the whole point of this module, because the console JWT lives only 180
* minutes and re-pasting it used to be the panel's only recovery.
*
* Two behaviours are deliberate and match the platform, not the reference
* implementation this was ported from:
*
* - The authorization request MUST be started on the console origin
*   (`platform.sensenova.cn`). Hydra's CSRF cookie is bound to the entry
*   host, so starting on the identity provider's own host leaves the cookie
*   unreachable for the callback and the flow dies with "No CSRF value
*   available in the session cookie".
* - Nothing is written to disk here. The caller persists the grant through
*   `ctx.credentials`; this module only ever holds secrets in memory.
*
* @module dsh-connect-sensenova-token-plan/sensenova-auth
*/
/**
* The platform's public defaults — every value here is an override point, not a
* law of nature.
*
* These used to be frozen `const`s, which made pointing the panel at another
* console host (an enterprise mirror, a staging tenant) a code change plus a
* republish. {@link createAuth} lets the Host half pass them in from its own
* settings; the values below stay the defaults, so an unconfigured panel
* behaves exactly as it did before, and each instance keeps its own copy so two
* tenants never share one global.
*/
const AUTH_DEFAULTS = Object.freeze({
	consoleOrigin: "https://platform.sensenova.cn",
	iamOrigin: "https://iam.sensecoreapi.cn",
	tokenEndpoint: "https://signin.sensecore.cn/oauth2/token",
	jwksEndpoint: "https://signin.sensecore.cn/.well-known/jwks.json",
	clientId: "nova",
	scope: "openid offline offline_access",
	encKeyId: "public:hydra.openid.id-token",
	userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
	requestTimeoutMs: 2e4,
	maxHops: 6,
	/** Used only when the token endpoint omits `expires_in`; the console JWT lives 180 min. */
	assumedTokenLifetimeSeconds: 10800
});
/** Read a non-empty string, else `undefined`, so a bad override is skipped. */
function optionalStr(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/** Read a finite positive number, else `undefined`. */
function optionalNum(value) {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) && number > 0 ? number : void 0;
}
/** Whether a host is loopback — the only place plain http is tolerable. */
function isLoopback(hostname) {
	const host = String(hostname ?? "").replace(/^\[|\]$/g, "");
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
/**
* Reject an endpoint that is not an absolute https URL.
*
* https is mandatory for any non-loopback host: the token endpoint answers
* with the LIVE access/refresh pair in plaintext, so a typo'd `http://` for a
* real host quietly downgrades the session credentials to cleartext. The
* loopback exception keeps the e2e fake platform (http://127.0.0.1) reachable.
*/
function checkEndpoint(value, field) {
	let parsed;
	try {
		parsed = new URL(String(value));
	} catch {
		throw pluginError(CODE.CONFIG, `${field} is not an absolute URL: ${value}`);
	}
	if (parsed.protocol !== "https:") {
		if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) return String(value);
		throw pluginError(CODE.CONFIG, `${field} must be https (plain http is allowed only for loopback, e.g. the e2e fake platform), got ${parsed.protocol}//${parsed.host}`);
	}
	return String(value);
}
/**
* Resolve the platform endpoints and OAuth parameters into a frozen config.
*
* Unknown keys are ignored and malformed values throw rather than being
* trusted: these strings end up in the URLs that carry a sealed password, so a
* typo has to fail loudly instead of quietly aiming the login flow at another
* host. The result is frozen, so a caller that keeps it cannot mutate the
* instance's behaviour out from under it.
* @param {object} [overrides] - values to apply; absent keys keep their default.
* @returns {object} the effective configuration (frozen).
*/
function resolveAuthConfig(overrides = {}) {
	const source = obj(overrides);
	const pick = (key, fallback, isNumber) => {
		if (!Object.prototype.hasOwnProperty.call(source, key)) return fallback;
		const value = isNumber ? optionalNum(source[key]) : optionalStr(source[key]);
		return value === void 0 ? fallback : value;
	};
	const consoleOrigin = checkEndpoint(pick("consoleOrigin", AUTH_DEFAULTS.consoleOrigin, false), "consoleOrigin");
	return Object.freeze({
		consoleOrigin,
		iamOrigin: checkEndpoint(pick("iamOrigin", AUTH_DEFAULTS.iamOrigin, false), "iamOrigin"),
		authEndpoint: `${consoleOrigin}/oauth2/auth`,
		tokenEndpoint: checkEndpoint(pick("tokenEndpoint", AUTH_DEFAULTS.tokenEndpoint, false), "tokenEndpoint"),
		jwksEndpoint: checkEndpoint(pick("jwksEndpoint", AUTH_DEFAULTS.jwksEndpoint, false), "jwksEndpoint"),
		clientId: str(pick("clientId", AUTH_DEFAULTS.clientId, false), AUTH_DEFAULTS.clientId),
		scope: str(pick("scope", AUTH_DEFAULTS.scope, false), AUTH_DEFAULTS.scope),
		encKeyId: str(pick("encKeyId", AUTH_DEFAULTS.encKeyId, false), AUTH_DEFAULTS.encKeyId),
		userAgent: str(pick("userAgent", AUTH_DEFAULTS.userAgent, false), AUTH_DEFAULTS.userAgent),
		redirectUri: checkEndpoint(pick("redirectUri", consoleOrigin, false), "redirectUri"),
		requestTimeoutMs: num(pick("requestTimeoutMs", AUTH_DEFAULTS.requestTimeoutMs, true), AUTH_DEFAULTS.requestTimeoutMs),
		maxHops: num(pick("maxHops", AUTH_DEFAULTS.maxHops, true), AUTH_DEFAULTS.maxHops),
		assumedTokenLifetimeSeconds: num(pick("assumedTokenLifetimeSeconds", AUTH_DEFAULTS.assumedTokenLifetimeSeconds, true), AUTH_DEFAULTS.assumedTokenLifetimeSeconds),
		jwksCache: createJwksCache()
	});
}
/**
* Build a self-contained auth instance.
*
* Each instance owns its endpoints, OAuth parameters, timeouts and the JWKS
* cache key it seals under — there is no module-level mutable state to leak
* across tenants or tests. Construct one per Host (from `settings.auth`) or per
* test, and hand it to `createTokenStore`.
* @param {object} [overrides] - platform overrides; see {@link resolveAuthConfig}.
* @returns {{login: Function, refresh: Function, getConfig: Function}} the instance.
*/
function createAuth(overrides = {}) {
	const cfg = resolveAuthConfig(overrides);
	return {
		/** Log in with an account password; see {@link loginWith}. */
		login(credentials, options) {
			return loginWith(cfg, credentials, options);
		},
		/** Renew a refresh token; see {@link refreshWith}. */
		refresh(token, options) {
			return refreshWith(cfg, token, options);
		},
		/** The effective configuration, as a copy. */
		getConfig() {
			return { ...cfg };
		}
	};
}
/** Response-body keys whose value is a secret and must never be logged. */
const SECRET_BODY_KEYS = /* @__PURE__ */ new Set([
	"password",
	"access_token",
	"refresh_token",
	"id_token",
	"jwt",
	"authorization",
	"cookie",
	"set-cookie",
	"code_verifier"
]);
/** URL query parameters that carry a one-time secret. */
const SECRET_URL_PARAMS = /* @__PURE__ */ new Set([
	"code",
	"login_challenge",
	"code_challenge",
	"code_verifier",
	"access_token",
	"refresh_token",
	"session_state"
]);
/** Longest sanitized response snippet kept per hop. */
const TRACE_SNIPPET_MAX = 2e3;
/** Cap on total hops recorded, mirroring the redirect budget. */
const TRACE_MAX_HOPS = 12;
/**
* Strip every secret from a URL for the record: query parameters that carry
* one-time credentials have their VALUE replaced with `[REDACTED]` (the
* parameter name stays, so the record still shows which one the platform
* redirected with) — their presence is logged, their value is not.
* @param {string} url - any URL.
* @returns {string} the redacted URL, or the input when it does not parse.
*/
function sanitizeUrl(url) {
	const raw = str(url, "");
	if (raw === "") return "";
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		return raw.slice(0, 200);
	}
	for (const name of [...parsed.searchParams.keys()]) if (SECRET_URL_PARAMS.has(name.toLowerCase())) parsed.searchParams.set(name, "[REDACTED]");
	return parsed.href;
}
/**
* Reduce a response body to a log-safe snippet.
* @param {string} text - the raw body text (may be JSON, HTML, or nothing).
* @returns {string} a sanitized, length-capped snippet.
*/
function sanitizeBody(text) {
	const raw = str(text, "");
	if (raw === "") return "";
	let body = raw;
	try {
		const parsed = JSON.parse(raw);
		const scrub = (value) => {
			if (Array.isArray(value)) return value.map(scrub);
			if (value && typeof value === "object") {
				const out = {};
				for (const [key, item] of Object.entries(value)) out[key] = SECRET_BODY_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : scrub(item);
				return out;
			}
			if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return sanitizeUrl(value);
			return value;
		};
		body = JSON.stringify(scrub(parsed));
	} catch {
		body = raw.replace(/("password"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2").replace(new RegExp(`\\b(${[...SECRET_URL_PARAMS].join("|")})=([^&\\s"']+)`, "gi"), "$1=[REDACTED]");
	}
	return body.slice(0, TRACE_SNIPPET_MAX);
}
/**
* Create a fresh login trace for one sign-in attempt.
* @returns {{hops: object[], step(name, info): void, done(): object[]}}
*/
function createTrace() {
	const hops = [];
	return {
		hops,
		/** Record one hop; never throws — logging must not break the flow. */
		step(name, info = {}) {
			if (hops.length >= TRACE_MAX_HOPS) return;
			try {
				hops.push({
					step: name,
					at: (/* @__PURE__ */ new Date()).toISOString(),
					url: sanitizeUrl(info.url),
					status: typeof info.status === "number" ? info.status : null,
					location: info.location !== void 0 ? sanitizeUrl(info.location) : void 0,
					note: str(info.note, "") !== "" ? str(info.note, "") : void 0,
					body: info.body !== void 0 ? sanitizeBody(info.body) : void 0
				});
			} catch {}
		},
		done() {
			return hops;
		}
	};
}
/**
* How long the platform says to wait before trying again, in milliseconds.
*
* Two places carry it: a standard `Retry-After` header, and prose in the
* message ("try again after 8 minutes"). Honouring it is the difference
* between waiting out a lockout and extending one with every poll.
*
* The prose is matched in both languages the platform uses, because a window
* that goes unread becomes a refusal with no stated deadline — which falls
* back to a local backoff and so probes a lock that is still in force.
* @param {object} body - the parsed IAM response.
* @param {Response} response - the IAM response, for its headers.
* @returns {number|undefined} the wait, or `undefined` when none is stated.
*/
function retryWindowMs(body, response) {
	const header = Number(response?.headers?.get?.("retry-after"));
	if (Number.isFinite(header) && header > 0) return Math.ceil(header * 1e3);
	const text = `${str(obj(body).message, "")} ${rejectionDetail(body, response?.status ?? 0)}`;
	const match = /(\d+(?:\.\d+)?)\s*(second|sec|minute|min|hour|hr|秒|分钟|小时|时|分)/i.exec(text);
	if (match === null) return void 0;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return void 0;
	return amount * durationFactorMs(match[2] ?? "");
}
/**
* The length of one time unit, in either language.
*
* Minutes is the reading for a bare `分`, because a lockout measured in
* minutes is common and a coinage measured in minutes is not: reading it as
* seconds would under-wait and re-probe the lock.
* @param {string} unit - the matched unit.
* @returns {number} milliseconds.
*/
function durationFactorMs(unit) {
	if (/^h/i.test(unit) || unit.includes("小时") || unit === "时") return 36e5;
	if (/^m/i.test(unit) || unit.includes("分")) return 6e4;
	return 1e3;
}
/**
* One `fetch` with the console's headers and a deadline, returning the raw
* response so redirect handling stays with the caller.
* @param {string} url - absolute URL.
* @param {RequestInit & {timeoutMs?: number}} init - fetch options.
* @returns {Promise<Response>}
*/
async function httpGet(url, init = {}, cfg) {
	const { timeoutMs = cfg.requestTimeoutMs, ...rest } = init;
	return fetch(url, {
		...rest,
		redirect: "manual",
		headers: {
			"user-agent": cfg.userAgent,
			accept: "*/*",
			...obj(rest.headers)
		},
		signal: AbortSignal.timeout(timeoutMs)
	});
}
/**
* Dig a query parameter out of a URL, decoded.
*
* (The password-sealing JWE lives in `sensenova-crypto.ts` — `sealPassword` —
* with the PKCE and JWKS primitives this module no longer carries.)
* @param {string} url - any URL.
* @param {string} name - the parameter to read.
* @returns {string} the value, or `""` when absent.
*/
function paramOf(url, name) {
	try {
		return new URL(url).searchParams.get(name) ?? "";
	} catch {
		return "";
	}
}
/**
* Look for the next hop inside a 200 body.
*
* The console renders some transitions client-side, so a `Location` header is
* not always there. Scan for an absolute URL carrying the wanted parameter,
* then fall back to a meta refresh and the usual JS redirects.
* @param {string} body - the response text.
* @param {RegExp} wanted - matches the parameter that marks a hit.
* @returns {string} the next URL, or `""` when the body carries none.
*/
function nextFromBody(body, wanted) {
	const text = str(body, "");
	if (text === "") return "";
	for (const match of text.matchAll(/https?:\/\/[^"'\s<>]+[?&][^"'\s<>]*/g)) if (wanted.test(match[0])) return match[0];
	const meta = /<meta[^>]+http-equiv=["']refresh["'][^>]+url=["']([^"']+)/i.exec(text);
	if (meta !== null) return meta[1] ?? "";
	for (const pattern of [
		/window\.location\.replace\(["']([^"']+)["']/,
		/window\.location\.href\s*=\s*["']([^"']+)["']/,
		/location\.href\s*=\s*["']([^"']+)["']/,
		/window\.location\s*=\s*["']([^"']+)["']/
	]) {
		const found = pattern.exec(text);
		if (found !== null) return found[1] ?? "";
	}
	return "";
}
/**
* Walk a redirect chain by hand until `wanted` appears in a URL.
*
* `fetch` cannot follow this: the chain crosses hosts and the CSRF cookie
* must ride along, which needs one jar across the whole walk.
* @param {string} start - the first URL.
* @param {RegExp} wanted - what marks the destination.
* @param {Map<string, string>} jar - cookies collected along the way.
* @param {object} cfg - resolved auth config; `cfg.maxHops` is the hop budget.
* @param {{ step: (name: string, info?: object) => void }} [trace] - the trace
*   recorder; when present every hop is logged and the terminal body is scanned
*   for the next hop from the response text.
* @returns {Promise<string>} the matching URL, or `""` when the chain ends first.
*/
async function followUntil(start, wanted, jar, cfg, trace) {
	const budget = cfg.maxHops;
	let location = start;
	for (let hop = 0; hop < budget && location !== ""; hop += 1) {
		if (wanted.test(location)) return location;
		const response = await httpGet(location, { headers: { cookie: cookieHeader(jar) } }, cfg);
		collectCookies(response, jar);
		const next = str(response.headers.get("location"), "");
		if (trace !== void 0) {
			const bodyText = next !== "" ? "" : await response.text();
			trace.step(`redirect hop ${hop + 1}`, {
				url: location,
				status: response.status,
				location: next !== "" ? next : void 0,
				note: next !== "" ? "followed Location" : "no Location; scanned body for the next hop",
				body: bodyText
			});
			location = next !== "" ? next : nextFromBody(bodyText, wanted);
		} else location = next !== "" ? next : nextFromBody(await response.text(), wanted);
	}
	return wanted.test(location) ? location : "";
}
/** Render a cookie jar as a request `cookie` header. */
function cookieHeader(jar) {
	return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}
/** Absorb `set-cookie` headers into the jar, name/value only. */
function collectCookies(response, jar) {
	const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
	for (const line of raw) {
		const [pair = ""] = line.split(";");
		const index = pair.indexOf("=");
		if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
	}
}
/**
* Exchange a token-grant response for the fields the panel cares about.
* @param {Response|{status: number, jsonText: string}} response - the token
*   endpoint's response, or `{status, jsonText}` when the body was already
*   consumed for the trace and is handed over parsed-once.
* @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number, scope: string}>}
*/
async function readTokenResponse(response, cfg) {
	const status = typeof response.status === "number" ? response.status : 0;
	const body = obj(response.jsonText !== void 0 ? (() => {
		try {
			return JSON.parse(response.jsonText);
		} catch {
			return {};
		}
	})() : await response.json().catch(() => ({})));
	const accessToken = str(body.access_token, "");
	if (accessToken === "") {
		const detail = str(body.error_description, str(body.error, `HTTP ${status}`));
		throw pluginError(CODE.TOKEN_REJECTED, `token endpoint did not return an access token: ${detail}`);
	}
	return {
		accessToken,
		refreshToken: str(body.refresh_token, ""),
		expiresIn: Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : cfg.assumedTokenLifetimeSeconds,
		scope: str(body.scope, cfg.scope)
	};
}
/**
* Exchange a refresh token for a fresh access token.
*
* This is the call that removes the 3-hour manual re-login: the panel calls
* it on demand, and the rotated refresh token is returned so the caller can
* replace the stored one. Hydra rotates refresh tokens, so a caller that
* ignores the new one will find the old one dead on the next refresh.
* @param {string} refreshToken - the stored refresh token.
* @param {object} [options] - request options.
* @param {number} [options.timeoutMs] - deadline override.
* @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number, scope: string}>}
*/
async function refreshWith(cfg, refreshToken, options = {}) {
	const token = str(refreshToken, "");
	if (token === "") throw pluginError(CODE.NO_REFRESH_TOKEN, "no refresh token is stored");
	const response = await fetch(cfg.tokenEndpoint, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"user-agent": cfg.userAgent,
			accept: "application/json"
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: token,
			client_id: cfg.clientId,
			scope: cfg.scope
		}).toString(),
		signal: AbortSignal.timeout(options.timeoutMs ?? cfg.requestTimeoutMs)
	});
	if (!response.ok) {
		const body = obj(await response.json().catch(() => ({})));
		const dead = response.status === 400 && str(body.error, "") === "invalid_grant";
		const detail = str(body.error_description, str(body.error, `HTTP ${response.status}`));
		throw pluginError(dead ? CODE.REFRESH_REJECTED : CODE.REFRESH_FAILED, `refresh rejected (HTTP ${response.status}): ${detail}`);
	}
	return readTokenResponse(response, cfg);
}
/**
* The machine-readable reason IAM refused a login, when it sends one.
*
* IAM answers with a `google.rpc.Status`-shaped envelope whose top-level
* `message` is a generic status string ("InvalidArgument"), while the actual
* cause sits in `details[].reason` — `invalidAccountOrPassword`,
* `accountLocked`, `tooManyAttempts` and so on. Reading only the top level
* is what made every failure look like a wrong password, including rate
* limits and locked accounts.
* @param {object} body - the parsed IAM response.
* @returns {string} the reason, or `""` when the body carries none.
*/
function iamRejectionReason(body) {
	const details = obj(body).details;
	if (!Array.isArray(details)) return "";
	for (const entry of details) {
		const reason = str(obj(entry).reason, "");
		if (reason !== "") return reason;
	}
	return "";
}
/**
* The best human-readable explanation of a refused login.
*
* Prefers the specific localized message, then the machine reason, then the
* top-level message, so the user is told what the platform actually said
* rather than a guess the plugin made up.
* @param {object} body - the parsed IAM response.
* @param {number} status - the HTTP status.
* @returns {string}
*/
function rejectionDetail(body, status) {
	const source = obj(body);
	const details = Array.isArray(source.details) ? source.details : [];
	for (const entry of details) {
		const message = str(obj(entry).message, "");
		if (message !== "" && !/log_id|track_id/i.test(message)) return message;
	}
	const reason = iamRejectionReason(source);
	if (reason !== "") return reason;
	return str(source.message, str(source.error, `HTTP ${status}`));
}
/**
* Classify a refused login so the panel can say something specific.
*
* Order matters: an exact hit on the platform's machine reason wins, the
* substring scan only covers a code this table has not learned yet, and the
* generic code is the last resort — never a specific-looking guess.
*
* The table itself lives in `codes.ts` next to the taxonomy, so that a new
* platform reason is recognised in one place rather than three.
* @param {object} body - the parsed IAM response.
* @returns {string} a {@link CODE} value.
*/
function rejectionCode(body) {
	const reason = iamRejectionReason(body).toLowerCase().replace(/[\s_-]+/g, "");
	const exact = IAM_REASON_CODES[reason];
	if (exact !== void 0) return exact;
	if (reason.includes("accountorpassword") || reason.includes("credential")) return CODE.LOGIN_REJECTED;
	if (reason.includes("lock") || reason.includes("disable")) return CODE.ACCOUNT_LOCKED;
	if (reason.includes("attempt") || reason.includes("limit") || reason.includes("frequent")) return CODE.RATE_LIMITED;
	if (reason.includes("captcha") || reason.includes("verify")) return CODE.VERIFICATION_REQUIRED;
	return CODE.LOGIN_FAILED;
}
/**
* Log in with an account password and return a usable grant.
*
* @param {object} credentials - the account.
* @param {string} credentials.username - the console account.
* @param {string} credentials.password - its password.
* @param {object} [options] - request options.
* @param {number} [options.timeoutMs] - deadline override.
* @param {function(?object[], ?(Error & {code?: unknown})): void} [options.onTrace] - called with the
*   sanitized hop list when the attempt ENDS, success or failure; the second
*   argument is `null` on success and the thrown error otherwise. A success
*   throws nothing to carry a trace on, so this is the only way one is ever
*   recorded — and a success trace is the half that makes a failing one
*   readable, since "the browser works but this does not" is answered by
*   diffing the two.
* @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number, scope: string}>}
*   the access token (the console JWT), the refresh token when the platform
*   issued one, and the access token lifetime in seconds.
*/
async function loginWith(cfg, credentials, options = {}) {
	/** Run one attempt; every exit — success included — reports its trace. */
	const attempt = async () => {
		const trace = createTrace();
		try {
			const granted = await performLogin(credentials, options, trace, cfg);
			try {
				options.onTrace?.(trace.done(), null);
			} catch {}
			return granted;
		} catch (e) {
			const error = e;
			if (error?.trace === void 0) try {
				error.trace = trace.done();
			} catch {}
			try {
				options.onTrace?.(error.trace, error);
			} catch {}
			throw error;
		}
	};
	return attempt();
}
/**
* The login flow proper. Throws with `error.trace` attached on every exit;
* `login` wraps this so even out-of-band failures carry the trace.
*/
/**
* Step 1 — start the OIDC walk on the console origin and follow it to the
* Hydra `login_challenge`. Returns the challenge URL (or `""` when the walk
* ends without one). The CSRF cookie is bound to the entry host, so the walk
* MUST begin on `consoleOrigin` (see the module header for the failure mode
* when it does not).
* @param {object} cfg - resolved auth config.
* @param {Map<string,string>} jar - cookie jar, mutated with every `set-cookie`.
* @param {{ step: (name: string, info?: object) => void }} [trace]
* @param {string} challenge - the PKCE S256 challenge from step 0.
* @param {string} nonce - the state nonce issued for this flow.
* @returns {Promise<string>} the challenge URL, or `""`.
*/
async function obtainLoginChallenge(cfg, jar, trace, challenge, nonce) {
	const authUrl = new URL(cfg.authEndpoint);
	authUrl.search = new URLSearchParams({
		client_id: cfg.clientId,
		code_challenge: challenge,
		code_challenge_method: "S256",
		redirect_uri: cfg.redirectUri,
		response_type: "code",
		scope: cfg.scope,
		state: nonce
	}).toString();
	const first = await httpGet(authUrl.href, {}, cfg);
	collectCookies(first, jar);
	trace.step("authorize", {
		url: authUrl.href,
		status: first.status,
		location: first.headers.get("location"),
		note: "GET the authorization endpoint (starting on the console origin: the CSRF cookie is bound to this host)"
	});
	return followUntil(str(first.headers.get("location"), authUrl.href), /[?&]login_challenge=/, jar, cfg, trace);
}
/**
* Step 2 — seal the password (RSA-OAEP + A256GCM under the platform JWKS key)
* and POST it to IAM with the challenge. Returns the callback redirect URL, or
* throws a classified refusal carrying the platform's own retry window.
* @param {object} cfg - resolved auth config.
* @param {Map<string,string>} jar - cookie jar (carries the CSRF cookie).
* @param {{ step: (name: string, info?: object) => void }} [trace]
* @param {string} loginChallenge - the Hydra challenge from step 1.
* @param {string} secret - the verbatim password (never trimmed).
* @param {(code: string, message: string, extra?: object) => Error} fail - trace-tagged error factory.
* @param {number} [deadline] - request deadline override (ms).
* @returns {Promise<string>} the IAM callback redirect.
*/
async function postIamLogin(cfg, jar, trace, loginChallenge, user, secret, fail, deadline) {
	const encrypted = await sealPassword(secret, {
		jwksEndpoint: cfg.jwksEndpoint,
		encKeyId: cfg.encKeyId,
		cache: cfg.jwksCache
	});
	const iamUrl = `${cfg.iamOrigin}/iam/authn/v1/auth/nova/login`;
	const iamResponse = await fetch(iamUrl, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"user-agent": cfg.userAgent,
			accept: "application/json",
			origin: cfg.consoleOrigin,
			referer: `${cfg.consoleOrigin}/`,
			cookie: cookieHeader(jar)
		},
		body: JSON.stringify({
			username: user,
			password: encrypted,
			challenge: loginChallenge,
			is_encrypt: true
		}),
		signal: AbortSignal.timeout(deadline ?? cfg.requestTimeoutMs)
	});
	const iamText = await iamResponse.text();
	const iamBody = obj((() => {
		try {
			return JSON.parse(iamText);
		} catch {
			return {};
		}
	})());
	trace.step("iam-login", {
		url: iamUrl,
		status: iamResponse.status,
		note: str(iamBody.redirect, "") !== "" ? "IAM returned a callback redirect" : "IAM returned no redirect",
		body: iamText
	});
	const redirect = str(iamBody.redirect, "");
	if (!iamResponse.ok || redirect === "") {
		const code = rejectionCode(iamBody);
		const detail = rejectionDetail(iamBody, iamResponse.status);
		throw fail(code, `login failed: ${detail}`, {
			retryAfterMs: retryWindowMs(iamBody, iamResponse),
			detail
		});
	}
	return redirect;
}
/**
* Step 3 — walk the IAM callback to the authorization `code` and verify the
* round-tripped `state` nonce. Throws `LOGIN_FLOW` on a missing code or a
* state mismatch (the latter is the second half of the PKCE binding — a code
* from a flow this process did not start must not be exchanged).
* @param {object} cfg - resolved auth config.
* @param {Map<string,string>} jar - cookie jar.
* @param {{ step: (name: string, info?: object) => void }} [trace]
* @param {string} redirect - the IAM callback URL from step 2.
* @param {string} expectedState - the nonce issued in step 1.
* @param {(code: string, message: string, extra?: object) => Error} fail - trace-tagged error factory.
* @returns {Promise<string>} the authorization code.
*/
async function obtainAuthCode(cfg, jar, trace, redirect, expectedState, fail) {
	const codeUrl = await followUntil(redirect, /[?&]code=/, jar, cfg, trace);
	const code = paramOf(codeUrl, "code");
	if (code === "") {
		trace.step("callback", {
			url: redirect,
			note: "walk ended without an authorization code"
		});
		throw fail(CODE.LOGIN_FLOW, "could not obtain an authorization code from the callback");
	}
	const callbackState = paramOf(codeUrl, "state");
	if (callbackState !== expectedState) {
		trace.step("callback-state", {
			url: codeUrl,
			note: `state mismatch (expected ${expectedState.slice(0, 8)}…, got ${callbackState.slice(0, 8)}…)`
		});
		throw fail(CODE.LOGIN_FLOW, "callback state did not match the issued nonce");
	}
	return code;
}
/**
* Step 4 — trade code + verifier for the token pair. Throws `TOKEN_REJECTED`
* when the endpoint refuses, else returns the parsed grant.
* @param {object} cfg - resolved auth config.
* @param {{ step: (name: string, info?: object) => void }} [trace]
* @param {string} code - the authorization code from step 3.
* @param {string} verifier - the PKCE verifier matching step 1's challenge.
* @param {(code: string, message: string, extra?: object) => Error} fail - trace-tagged error factory.
* @param {number} [deadline] - request deadline override (ms).
* @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number, scope: string}>}
*/
async function exchangeCodeForToken(cfg, trace, code, verifier, fail, deadline) {
	const tokenResponse = await fetch(cfg.tokenEndpoint, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"user-agent": cfg.userAgent,
			accept: "application/json"
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: cfg.clientId,
			redirect_uri: cfg.redirectUri,
			scope: cfg.scope
		}).toString(),
		signal: AbortSignal.timeout(deadline ?? cfg.requestTimeoutMs)
	});
	const tokenText = await tokenResponse.text();
	trace.step("token-exchange", {
		url: cfg.tokenEndpoint,
		status: tokenResponse.status,
		note: tokenResponse.ok ? "token pair granted" : "token endpoint refused the exchange",
		body: tokenText
	});
	if (!tokenResponse.ok) {
		const body = obj((() => {
			try {
				return JSON.parse(tokenText);
			} catch {
				return {};
			}
		})());
		const detail = str(body.error_description, str(body.error, `HTTP ${tokenResponse.status}`));
		throw fail(CODE.TOKEN_REJECTED, `token exchange failed: ${detail}`);
	}
	return readTokenResponse({
		status: tokenResponse.status,
		jsonText: tokenText
	}, cfg);
}
/**
* The login flow proper. Throws with `error.trace` attached on every exit;
* `login` wraps this so even out-of-band failures carry the trace.
*/
async function performLogin({ username, password }, options, trace, cfg) {
	const deadline = options.timeoutMs ?? cfg.requestTimeoutMs;
	const user = str(username, "");
	const secret = verbatim(password, "");
	if (user === "" || secret.trim() === "") throw pluginError(CODE.MISSING_CREDENTIALS, "username and password are required");
	const fail = (code, message, extra = {}) => {
		const error = pluginError(code, message, extra);
		error.trace = trace.done();
		return error;
	};
	const jar = /* @__PURE__ */ new Map();
	const pkcePair = await pkce();
	const nonce = b64url(crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(16)));
	const loginChallenge = paramOf(await obtainLoginChallenge(cfg, jar, trace, pkcePair.challenge, nonce), "login_challenge");
	if (loginChallenge === "") {
		trace.step("challenge", { note: "walk ended without a login_challenge" });
		throw fail(CODE.LOGIN_FLOW, "could not obtain a login challenge from the authorization endpoint");
	}
	return exchangeCodeForToken(cfg, trace, await obtainAuthCode(cfg, jar, trace, await postIamLogin(cfg, jar, trace, loginChallenge, user, secret, fail, deadline), nonce, fail), pkcePair.verifier, fail, deadline);
}

//#endregion
//#region src/host/state-store.ts
/**
* 状态文件公共原语 —— 把四个 store（throttle / catalog / provider / draw）此前
* 各自手写的同一段"版本载荷 + temp 文件 + rename 原子 + 0600 + 损坏即忽略"
* 收敛到这里（docs/IMPROVEMENTS.md §4.1 第一步）。
*
* 第二步收敛的是**读缓存**：provider / draw 早有 1s TTL，而 catalog 完全没有
* （进程内永不失效）——同一个「两个进程共享一个 state 目录」的问题修了两个、
* 漏了第三个。现在统一走 {@link createStateReadCache}，一个 TTL 三个调用方。
*
* peer-free 与四个 store 同纪律：不 import 任何 Host peer，纯 `node:fs`，
* 离线可测（store.test.mjs 直接注入 dir 构造即可）。
*
* 行为约定（与四个 store 的历史实现逐一对齐）：
*   - 目录：`$DSH_HOME/state/<name>`——与 Host 自己的目录并列，而不是在
*     `logs/`（trace 轮转会按日志清扫，状态文件不能跟着被扫走）。
*   - 写：临时文件（0600，owner-only）→ `rename` 原子落位。**失败抛错**，
*     是否吞错是各 store 的语义（throttle/catalog 面对只读 Home 选择吞、
*     provider 面板开关交给调用方的错误路径），原语不做决定。
*   - 临时名：进程 + 时间戳 + 随机 UUID 后缀。固定临时名会让两个 Host 进程的
*     写落到同一路径、互相 `rename` 掉对方写了一半的文件；同一进程同一毫秒的
*     两次异步写也会撞名（`writeFile` 截断覆盖后一次 `rename` 静默丢写），
*     随机后缀让每个 temp 路径唯一，`rename` 原子性借此成立（见 `temporaryOf`）。
*     此前的写法曾只有进程 + 时间戳，同毫秒并发写会静默丢一条。
*   - 读：缺失、不可读、非 JSON 一律返回 `null`——"损坏即忽略"的方向。是否
*     缓存、缓存多久由 {@link createStateReadCache} 决定，不是每个 store 各自的
*     即兴实现。
*
* @module dsh-connect-sensenova-token-plan/state-store
*/
/**
* The DSH home: `$DSH_HOME` when the operator exported one, else `~/.dsh`.
* @returns {string} the home directory.
*/
function dshHome() {
	return str(process.env.DSH_HOME, join(homedir(), ".dsh"));
}
/**
* Where this plugin keeps state: `$DSH_HOME/state/<name>`.
* @param {string} name - the plugin's own state directory name
*   (`host-config.ts`'s `name`).
* @returns {string} the directory.
*/
function stateDir(name) {
	return join(dshHome(), "state", name);
}
/**
* 单个 profile 名的形态约束。它会直接成为磁盘路径的一段，所以这里按
* **外部输入**处理，而不是信任 Host 给的值。
*
* 规则与它的用途一一对应：
*   - 字符集限制（`[A-Za-z0-9._-]`）——排除路径分隔符与任何 traversal 形状；
*   - 不以点开头——顺带排掉 `.` 与 `..` 这两个唯一能让单段路径逃逸的名字；
*   - 长度上限——防超长目录名（Windows 路径上限、以及某些文件系统的 NAME_MAX）。
*
* 为什么不用白名单枚举已知 profile 名：集合是开放的（用户可以任意新建
* profile，本插件不该认识它们），白名单会把新 profile 错判成"拿不到名字"。
*/
const PROFILE_SEGMENT_MAX = 64;
const PROFILE_SEGMENT_RE = /^(?!\.)[A-Za-z0-9._-]+$/;
/**
* Is this string safe to use as ONE path segment?
* @param {unknown} value - candidate profile name.
* @returns {boolean} true when it survives {@link PROFILE_SEGMENT_RE}.
*/
function isProfileSegment(value) {
	if (typeof value !== "string") return false;
	const name = value.trim();
	if (name === "" || name.length > PROFILE_SEGMENT_MAX) return false;
	return PROFILE_SEGMENT_RE.test(name);
}
/**
* 当前这台 Host 跑在哪个 profile 下，取不到就返回 `null`。
*
* **怎么读它**：`ctx.get(name)` —— Cordis 自己的 "read a service without the
* inject requirement" 入口，未提供时安静返回 `undefined`。注意**别用属性访问**
* 去探：`ctx.profileContext` 会在服务缺失时**抛错**（`cannot get property
* "profileContext" without inject`，cordis `lib/index.js:676`）——这是本插件
* 实测踩到的，不是推测。`readOptionalService` 把两个入口都包了，属性访问只作为
* 测试桩的兜底留在最后。
*
* **为什么不用 `inject` 声明它**：`inject` 里的是**硬依赖**（`lib/index.js:688`
* 的报错文案就叫 "cannot get required service"），缺了 Cordis 根本不加载本插件。
* 而 `profileContext` 在官方 runtime 里是**可选**的（`@linxin666/
* dsh-client-ui-plugin-manager` 明确处理了"host 隐藏了它"的情形，
* `dsh-better-sidebar` 同理）。把它变成硬依赖，会让那些主机上整个插件消失
* （面板、额度、provider 全挂），代价远大于收益。
*
* **为什么不读 `DSH_PROFILE`**：在那个 runtime 里它是 OUTPUT 而非输入——由
* `runProfile()` 派生给子进程（`dsh-shell-env` 做的事），"no runtime module
* reads it to choose a profile"。手设或陈旧的值会把状态写进一个"这台 Host
* 根本不读"的 profile。
*
* 取到 = 调用方据此分段；取不到 = **退回当前的全局路径**，行为零漂移。
*
* @param {object} [ctx] - the Cordis context the Host handed `apply()`.
* @returns {string|null} the profile name, or `null` when unavailable/unsafe.
*/
function profileSegment(ctx) {
	if (ctx === null || typeof ctx !== "object") return null;
	const raw = readOptionalService(ctx, "profileContext");
	if (raw === null || typeof raw !== "object") return null;
	const name = raw.name;
	return isProfileSegment(name) ? String(name).trim() : null;
}
/**
* 读一个**可选**服务，三种入口依次尝试。
*
* 1. `ctx.get(name)` —— Cordis 的官方无 inject 读法（`ReflectService.get`），也是
*    `startSideEffects` 读可选 `settings` 服务用的同一入口。首选。
* 2. `ctx.reflect.get(name, false)` —— 底层等价物，宿主未把 mixin 挂出来时用。
* 3. `ctx[name]` 直接取属性 —— 手写测试桩的形状。**留在最后**：在真 Cordis 上
*    访问一个未声明且未提供的服务会抛（`... without inject`），必须包着 try。
*
* 三者都拿不到就是"这台 Host 没有这个服务"，调用方据此降级；这里永不抛错，
* 因为一个探测不到的可选服务不该让插件挂掉。
* @param {object} ctx - the Cordis context.
* @param {string} name - the service name.
* @returns {unknown} the service value, or `undefined`.
*/
function readOptionalService(ctx, name) {
	if (typeof ctx.get === "function") try {
		return ctx.get(name);
	} catch {}
	const reflect = ctx.reflect;
	if (reflect && typeof reflect.get === "function") try {
		return reflect.get(name, false);
	} catch {}
	try {
		return ctx[name];
	} catch {
		return;
	}
}
/**
* Per-profile state directory: `$DSH_HOME/state/<profile>/<name>`.
*
* Which states use this and which keep {@link stateDir} is a deliberate split,
* not an inconsistency — see PITFALLS §23. Briefly: the three switch-shaped
* states (catalog / provider / draw) answer "what does THIS profile want", so
* two profiles must not overwrite each other; the throttle answers "how long
* did the upstream tell US to wait" and the credentials grant answers "who are
* you", both of which are per-machine and are INTENDED to cross profiles.
*
* `profile` being `null` degrades to the shared directory, so every old host,
* every test and every in-process construction behaves exactly as before.
* @param {string} name - the plugin's own state directory name.
* @param {string|null} [profile] - the profile name; `null` means shared.
* @returns {string} the directory.
*/
function profileStateDir(name, profile) {
	return profile ? join(dshHome(), "state", profile, name) : stateDir(name);
}
/**
* Make the state directory exist (owner-only), created on demand.
*
* A read-only Home throws — callers wrap this in their own policy (the
* throttle/catalog writers swallow it, the provider switch does not).
* @param {string} dir - the state directory.
* @returns {Promise<void>}
*/
async function ensureStateDir(dir) {
	await mkdir(dir, {
		recursive: true,
		mode: 448
	});
}
/**
* A unique temporary path per write.
*
* Two Host processes can share one state directory, so a fixed temp name would
* let both writes land on the same path and each `rename` could move the
* other's half-written file. A process-plus-clock suffix keeps concurrent
* writers off each other; the RANDOM suffix then makes two writes from the
* SAME process inside one millisecond distinct too — clock+pid alone collides
* when two async state writes land in the same tick, and the second `writeFile`
* truncates the first's half-written temp before its `rename`, silently losing
* one write. The rename itself stays atomic per path.
* @param {string} dir - the state directory.
* @param {string} base - the final file name, e.g. `"throttle.json"`.
* @param {() => number} [now] - clock source; injected by the tests.
* @returns {string} `dir/<base>.<pid>.<now>.<uuid>.tmp`.
*/
function temporaryOf(dir, base, now = Date.now) {
	return join(dir, `${base}.${process.pid}.${now()}.${randomUUID()}.tmp`);
}
/**
* Write one state file atomically: a 0600 temporary file, then a rename.
*
* The payload string is written with a trailing newline, exactly as every
* store wrote before this module existed. Failures PROPAGATE — the callers
* decide whether a read-only Home breaks their flow.
* @param {string} file - the final file path.
* @param {string} payload - the serialized body (JSON text).
* @param {{temporary: string}} options - the temp path to write first.
* @returns {Promise<void>}
*/
async function writeStateFile(file, payload, { temporary }) {
	await writeFile(temporary, `${payload}\n`, {
		encoding: "utf8",
		mode: 384
	});
	await rename(temporary, file);
}
/**
* How long a parsed state file may be reused without going back to disk.
*
* Two Host processes share one state directory (see PITFALLS §22), so this is
* the upper bound on "how stale this process's view can be" — long enough to
* keep one poll self-consistent, short enough that a change made anywhere else
* is picked up on the next tick rather than after a restart.
*/
const STATE_READ_TTL_MS = 1e3;
/**
* 状态文件的短生命周期读缓存 —— 把 catalog / provider / draw 三个 store
* 各自手写的「近期读过就不再读盘」收敛到这里（§22：两个 Host 进程共享同一
* 个状态目录，缓存期就是「另一个进程的写入多久可见」的上界）。
*
* 为什么要有 TTL 而不是不缓存：每次轮询都重读一遍小 JSON 本身不贵，但快照
* 聚合在一次请求内会多次问同一个 store（目录条目、允许清单、开关），缓存让
* 一次请求内的答案自洽。为什么 TTL 必须短：超过了就是「另一个 profile 改了
* 允许清单，本机要重启才看得见」——这正是 catalog-store 早前的形态（无 TTL，
* 进程内永不失效），而现在三者共用一份 `ttlMs`。
*
* `null` 也是一个合法的缓存值（"文件不存在/损坏，读作无记录"），所以"从未
* 读过"用 `undefined` 表示，两者不可混。
*
* peer-free，与其余原语同纪律（不 import Host peer、离线可测）。时钟与 TTL
* 都可注入，便于测试把缓存推进过期。
*
* `inheritFrom` 是 §23 的一次性迁移缝：按 profile 分段后，本 profile 的新文件
* 一开始并不存在，而旧版把值放在**所有 profile 共享**的目录里。给了它以后，
* 读穿透发现自己的记录缺失时会去旧路径取一次、回填、再返回——**只尝试一次**
* （`adopted` 标志），所以它不会变成每个 TTL 周期都多读一个文件。
*
* 为什么让缓存原语承担这件事，而不是在外面先跑一遍迁移脚本：迁移就有了时序，
* 而"先迁移、再 seed"在 `apply()` 的同步构造里排不出确定顺序。挂在读穿透上
* 则天然正确——任何读到"空"的地方都会自动拿到旧值，且与并发进程无关（读到
* 同一份旧值、写同一份结果）。
*
* @template T
* @param {() => Promise<T|null>} readThrough - 真正的读盘 + 解析；返回 `null` 表示无可用记录。
* @param {object} [options]
* @param {number} [options.ttlMs] - 缓存有效期，默认 {@link STATE_READ_TTL_MS}。
* @param {() => number} [options.now] - 时钟源；测试注入。
* @param {{read: () => Promise<T|null>, write: (value: T) => Promise<void>}|null} [options.inheritFrom]
*   - 旧版共享布局（`read`）与把它回填到本 profile（`write`）；`null` = 不迁移。
* @returns {{read: () => Promise<T|null>, remember: (value: T|null) => void}}
*/
function createStateReadCache(readThrough, options = {}) {
	const { ttlMs = STATE_READ_TTL_MS, now = Date.now, inheritFrom = null } = options;
	let cached = void 0;
	let cachedAt = 0;
	/** Whether the one-shot legacy adoption has already been attempted. */
	let adopted = false;
	/**
	* 读穿透：自己的记录优先；缺失且还有旧布局可继承时，取一次旧值并回填。
	* @returns {Promise<T|null>}
	*/
	const load = async () => {
		const own = await readThrough();
		if (own !== null || inheritFrom === null || adopted) return own;
		adopted = true;
		const inherited = await inheritFrom.read();
		if (inherited === null) return null;
		try {
			await inheritFrom.write(inherited);
		} catch {}
		return inherited;
	};
	return {
		/**
		* 读值：TTL 内返回缓存，过期则穿透到 `load()`。
		* @returns {Promise<T|null>}
		*/
		async read() {
			if (cached !== void 0 && now() - cachedAt < ttlMs) return cached;
			cached = await load();
			cachedAt = now();
			return cached;
		},
		/**
		* 写路径用：把刚写入的值直接放进缓存，省掉下一次读盘，并保证自己的写入
		* 立刻对自己可见（不必等 TTL）。语义与 `read()` 一致，只是来源可信。
		* @param {T|null} value - 刚写入并解析后的值。
		* @returns {void}
		*/
		remember(value) {
			cached = value;
			cachedAt = now();
		}
	};
}
/**
* Read a state file as JSON, or `null` when it is absent, unreadable, or not
* JSON. Anything unrecognised reads as "nothing stored" — the safe direction
* for every consumer (one extra attempt / one re-fetch / the config default
* rules again), never a crash.
* @param {string} file - the file path.
* @returns {Promise<unknown>} the parsed value, or `null`.
*/
async function readStateJson(file) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

//#endregion
//#region src/host/throttle-store.ts
/**
* dsh-connect-sensenova-token-plan — where the sign-in throttle lives.
*
* It used to live in the credentials service, disguised as a `kind: "grant"`
* record carrying a marker field. That disguise was not a stylistic choice:
* the service admits exactly two record kinds, and an unknown one makes the
* whole credentials document unparseable — which takes the Host down, not
* just this panel. So a throttle could only ever be smuggled in as a grant,
* and a single mistyped payload was enough to break every credential on the
* machine.
*
* A throttle is not a credential. It is state: a deadline and a reason, plus
* a parked flag for refusals that have no deadline. It belongs in this
* plugin's own file, where a malformed value costs the plugin its throttle
* and nothing else.
*
* @module dsh-connect-sensenova-token-plan/throttle-store
*/
/** Shape version, bumped when the persisted form changes. */
const THROTTLE_VERSION$1 = 1;
/**
* Where the throttle lives: the SHARED directory, `$DSH_HOME/state/<plugin>`.
*
* Deliberately NOT per-profile, even though the catalog / provider / draw
* states are (PITFALLS §23). A throttle is not a per-profile preference, it is
* "how long the upstream told this machine to stop knocking" — if only the
* profile that got the 429 honoured it, the other profile's Host would resume
* hammering the same endpoint from the same machine during the very window the
* platform asked for. Splitting it would silently undo the whole point of the
* throttle, and the failure only surfaces under load. Do not "make it
* consistent" with the other three.
* @returns {string} the directory.
*/
function throttleDir() {
	return stateDir(name);
}
/**
* The throttle file this plugin wrote before its rename.
*
* Read for MIGRATION ONLY: a parked refusal — a wrong password the user has
* not yet corrected — must survive the rename, or the next Host start would
* retry that password automatically and walk into a lock. The old file is
* moved into place on first contact and never written again.
* @returns {string} the legacy file path.
*/
function legacyThrottleFile() {
	const home = str(process.env.DSH_HOME, join(homedir(), ".dsh"));
	return join(home, "state", "dsh-llm-rate-panel", "throttle.json");
}
/**
* Parse a persisted throttle, or `null` when it is absent, stale, or foreign.
*
* Anything unrecognised reads as "no throttle". That is the safe direction for
* a *time* window — the worst case is one extra attempt — and the reason the
* caller keeps parked refusals somewhere it can still see them.
* @param {unknown} raw - the parsed file contents.
* @param {() => number} now - clock source.
* @returns {{code: string, parked: boolean, until: number|null, attempt: number}|null}
*/
function parse$1(raw, now) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const body = raw;
	if (num(body.version, 0) !== THROTTLE_VERSION$1) return null;
	const code = str(body.code, "");
	if (code === "") return null;
	const attempt = Math.max(1, Math.floor(num(body.attempt, 1)));
	if (body.parked === true) return {
		code,
		parked: true,
		until: null,
		attempt
	};
	const until = num(body.until, NaN);
	if (!Number.isFinite(until) || until <= now()) return null;
	return {
		code,
		parked: false,
		until,
		attempt
	};
}
/**
* A throttle store backed by one file.
*
* Writes are atomic — a temporary file, then a rename — because two Host
* processes share this path: a half-written file read by the other process
* would read as "no throttle", which for a parked refusal means an automatic
* retry of a password the user has not changed.
* @param {object} [options] - wiring.
* @param {string} [options.dir] - directory; defaults to {@link throttleDir}.
* @param {() => number} [options.now] - clock source; injected by the tests.
* @returns {{read: Function, write: Function, clear: Function}} the store.
*/
function createFileThrottleStore({ dir = throttleDir(), now = Date.now } = {}) {
	const file = join(dir, "throttle.json");
	/**
	* Move a throttle written before the rename into the current location.
	*
	* Runs once: a state already at the new address wins over one at the old. The
	* old directory then holds nothing and is left to be swept with the Home.
	* @returns {Promise<void>} resolves once any legacy state is in place.
	*/
	let legacyAdopted = false;
	async function adoptLegacyFile() {
		if (legacyAdopted) return;
		legacyAdopted = true;
		try {
			await ensureStateDir(dir);
		} catch {}
		try {
			await readFile(file, "utf8");
		} catch {
			try {
				await rename(legacyThrottleFile(), file);
			} catch {}
		}
	}
	return {
		async read() {
			await adoptLegacyFile();
			return parse$1(await readStateJson(file), now);
		},
		async write(state) {
			await adoptLegacyFile();
			const temporary = temporaryOf(dir, "throttle.json");
			try {
				await ensureStateDir(dir);
				const body = JSON.stringify({
					version: THROTTLE_VERSION$1,
					code: state.code,
					parked: state.parked === true,
					until: state.parked === true ? null : state.until,
					attempt: state.attempt
				});
				await writeStateFile(file, body, { temporary });
			} catch {}
		},
		async clear() {
			try {
				await rm(file, { force: true });
			} catch {}
			try {
				await rm(legacyThrottleFile(), { force: true });
			} catch {}
		}
	};
}
/**
* A throttle store that forgets everything when the process ends.
*
* Used by the tests, and by a Host that can be given nothing writable. It is
* deliberately NOT the default: the throttle exists so that a second Host
* process does not walk into a lock the first is waiting out, which is a
* claim about other processes and cannot be kept in memory.
* @param {() => number} [now] - clock source.
* @returns {{read: Function, write: Function, clear: Function}} the store.
*/
function createMemoryThrottleStore(now = Date.now) {
	let held = null;
	return {
		async read() {
			return parse$1(held, now);
		},
		async write(state) {
			held = {
				version: THROTTLE_VERSION$1,
				...state
			};
		},
		async clear() {
			held = null;
		}
	};
}

//#endregion
//#region src/host/token-store/state.ts
/**
* The shared context a token store instance runs on — the seam the split
* around `token-store.ts` stands on.
*
* `token-store.ts` is one closure holding four intertwined blocks (grant,
* account, renewal, throttle) that share seven mutable variables. The split
* (docs/TOKEN-STORE-SPLIT.md) moves each block into its own module; what they
* all keep in common is exactly what this file owns:
*
*   - `wiring` — the read side: the credentials backend (real service or the
*     in-memory vault), the keys, the injected clock, env, auth, and the
*     throttle store. Built once per instance.
*   - `state` — the seven mutable fields, now named instead of closure-scoped:
*     `cached`, `rejected`, `inflight`, `lastError`, `throttle`,
*     `consecutiveRefusals`, `passwordSwept`. Each block writes only its own
*     fields (the ownership table lives in the split doc §1); every block may
*     read any field through `state.`.
*
* Step 1 of the split: `createStoreContext()` is the one new piece of code in
* this move. `token-store.ts`'s `createTokenStore` now builds this context and
* keeps its bodies verbatim against it, so the behavior baseline
* (`test/store-baseline.test.mjs`) and the 131 live checks stay green —
* no semantics moved, only the names did.
*
* @module dsh-connect-sensenova-token-plan/token-store/state
*/
/** Record address: this plugin's own namespace, so a stranger cannot collide. */
const RECORD_ID = "sensenova-console";
const THROTTLE_ID = "sensenova-console-throttle";
const DEFAULT_SKEW_MS = 12e4;
/**
* Build one store instance's wiring + state.
*
* The body of what `createTokenStore` used to do before its first `let`:
* resolve the throttle store, build the in-memory vault, the service
* resolver, the backend and the ephemeral check, and the key pair. The
* defaults and their comments move here unchanged; `token-store.ts` still
* documents the OPTIONS (they are the public face of the factory).
*
* @param {object} options - the same options object `createTokenStore` takes.
* @returns {{wiring: object, state: object}}
*/
function createStoreContext({ credentials, auth = createAuth(), env = process.env, skewMs = DEFAULT_SKEW_MS, throttleStore: injectedThrottleStore, now = Date.now, onTrace, credentialKey }) {
	const key = credentialKey(name, RECORD_ID);
	const THROTTLE_KEY = credentialKey(name, THROTTLE_ID);
	const throttleStore = injectedThrottleStore ?? createMemoryThrottleStore(now);
	/**
	* The in-memory fallback used while no credentials service is reachable. A
	* Host without the service still gets a working panel: the account and grant
	* live here, which is exactly as private as the real store and simply does
	* not outlive the process.
	*/
	const memory = {
		records: /* @__PURE__ */ new Map(),
		account: /* @__PURE__ */ new Map(),
		async readRecord(k) {
			return this.records.get(k);
		},
		async modifyRecord(k, mutate) {
			const next = await mutate(this.records.get(k));
			if (next === void 0) return this.records.get(k);
			this.records.set(k, next);
			return next;
		},
		async deleteRecord(k) {
			this.records.delete(k);
		},
		async resolve(ref) {
			const value = this.account.get(ref);
			return typeof value === "string" && value !== "" ? {
				value,
				source: "memory"
			} : void 0;
		},
		async set(ref, value) {
			this.account.set(ref, value);
		},
		async unset(ref) {
			this.account.delete(ref);
		}
	};
	/**
	* Resolve the credentials service on EVERY use, not once at mount: the
	* service may register after this plugin loads, and a flag frozen at mount
	* would then claim "no credentials service" forever while the store quietly
	* exists on disk. Accepts the service itself (tests) or a resolver function
	* (production, where the service is looked up per use) and normalises
	* anything absent to `null`.
	*/
	const resolveService = () => {
		return (typeof credentials === "function" ? credentials() : credentials) ?? null;
	};
	/** The live backend: the real service when attached, else the in-memory vault. */
	const backend = () => resolveService() ?? memory;
	/** True while nothing written through the store would survive a restart. */
	const ephemeral = () => resolveService() === null;
	return {
		wiring: {
			credentials,
			auth,
			env,
			skewMs,
			throttleStore,
			now,
			...onTrace !== void 0 ? { onTrace } : {},
			credentialKey,
			key,
			THROTTLE_KEY,
			backend,
			ephemeral
		},
		state: {
			/** In-memory token for this process; the record is the durable truth. */
			cached: null,
			/**
			* Tokens the console has already rejected.
			*
			* A 401 does not prove the token expired — it proves the console refused it —
			* so a rejected token must never be handed out again even while its `exp`
			* still looks valid. Without this the store would re-read the same record
			* and replay the token the console just refused.
			*/
			rejected: /* @__PURE__ */ new Set(),
			/** One in-flight acquisition, so N concurrent polls share one login. */
			inflight: null,
			/** Last failure, surfaced to the panel instead of a bare "not configured". */
			lastError: null,
			/**
			* A refusal that must not be repeated on a timer.
			*
			* The platform locks an account after a few bad attempts, so retrying a
			* failed sign-in automatically turns one mistake into a lockout. This records
			* why sign-in is pointless right now and until when.
			*
			* `until` is the absolute deadline when the platform names one ("try again
			* in 8 minutes"); otherwise a local backoff applies, doubling per attempt up
			* to a cap. `parked` marks a credential-shaped refusal, which has no
			* deadline at all: waiting cannot make a wrong password right.
			*/
			throttle: null,
			/**
			* How many refusals in a row this store has seen.
			*
			* Kept separately from `throttle` because the throttle record is deleted as
			* soon as its window closes, while this count must survive that deletion —
			* otherwise the doubling has nothing to double from and every wait restarts
			* at the shortest one.
			*/
			consecutiveRefusals: 0,
			/** True once a legacy stored password has been swept from the credentials service. */
			passwordSwept: false
		}
	};
}

//#endregion
//#region src/host/token-store/grant.ts
/**
* Block 1 of the token-store split: the GRANT read/write and freshness
* judgments. Owns the grant record's lifecycle — parse, adopt, persist,
* reap, fresh check.
*
* This module has no state of its own; it operates on the shared context
* (`wiring` + `state`) built by `state.ts`. The ownership table is in
* `docs/TOKEN-STORE-SPLIT.md` §1. Functions moved here are **verbatim** —
* the behavior baseline (`test/store-baseline.test.mjs`) and the 131 live
* checks stay green, so no semantics moved, only the file did.
*
* @module dsh-connect-sensenova-token-plan/token-store/grant
*/
/** Bumped if the stored payload shape ever changes incompatibly. */
const GRANT_VERSION = 1;
/**
* The stored grant, or `undefined` when nothing usable is stored.
*
* A payload that does not match the expected shape reads as absent rather
* than throwing: a hand-edited or downgraded record should degrade the panel
* into "not configured", not crash the route on every poll.
* @param {unknown} record - a credential record.
* @returns {{accessToken: string, refreshToken: string, expiresAt: number|null}|undefined}
*/
function parseGrant(record) {
	if (record === void 0 || record === null || obj(record).kind !== "grant") return void 0;
	const payload = obj(obj(record).payload);
	if (num(payload.version) !== GRANT_VERSION) return void 0;
	const accessToken = str(payload.accessToken, "");
	if (accessToken === "") return void 0;
	return {
		accessToken,
		refreshToken: str(payload.refreshToken, ""),
		expiresAt: numOrNull(payload.expiresAt) ?? readJwtExpiry(accessToken)
	};
}
/**
* Read the durable grant through the credentials service.
* @param {object} wiring - the store context wiring.
* @param {object} state - the store context state.
*/
async function readStored(wiring, state) {
	const { backend, key } = wiring;
	try {
		const current = parseGrant(await backend().readRecord(key));
		if (current !== void 0) return current;
		return await adoptLegacyGrant(wiring, state);
	} catch {
		return;
	}
}
/**
* Take over a grant a previous version saved under the old namespace.
*
* Runs once, when the record under the current name is absent. The legacy
* record is re-written at the current address and deleted, so the next read
* is a plain lookup; a grant that is still good must not be abandoned to the
* "please log in again" path just because this plugin was renamed.
* @returns {Promise<object|undefined>} the adopted grant, or undefined.
*/
async function adoptLegacyGrant(wiring, _state) {
	const { backend, key, credentialKey } = wiring;
	const LEGACY_SCOPE = "dsh-llm-rate-panel";
	const RECORD_ID = "sensenova-console";
	try {
		const legacyKey = credentialKey(LEGACY_SCOPE, RECORD_ID);
		const grant = parseGrant(await backend().readRecord(legacyKey));
		if (grant === void 0) return void 0;
		await backend().modifyRecord(key, () => Promise.resolve({
			kind: "grant",
			payload: {
				version: GRANT_VERSION,
				accessToken: grant.accessToken,
				refreshToken: grant.refreshToken,
				expiresAt: grant.expiresAt ?? null
			}
		}));
		await backend().deleteRecord(legacyKey).catch(() => {});
		return grant;
	} catch {
		return;
	}
}
/**
* Persist a token pair.
*
* Goes through `modifyRecord` so the read-decide-replace is exclusive: a
* refresh token is single-use, and two processes racing on it would
* otherwise invalidate each other's grant.
* @param {string} accessToken - the new console JWT.
* @param {string} refreshToken - the refresh token the platform just issued.
* @param {number} expiresIn - the access token lifetime in seconds.
* @param {string} [replacing] - the access token this write supersedes:
*   passed by every refresh, and by a password login that read an existing
*   grant. A record still holding exactly that token is the one we read, so
*   replacing it is right; a record holding anything else was rotated by
*   someone else in the meantime and is kept. Absent only for a first-ever
*   login that read no grant.
* @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
*   the grant now in effect — ours, or the newer one we deferred to.
*/
async function storeGrant(wiring, state, accessToken, refreshToken, expiresIn, replacing) {
	const { backend, key, now } = wiring;
	const issuedAt = now();
	const payload = {
		version: GRANT_VERSION,
		accessToken,
		refreshToken,
		expiresAt: issuedAt + num(expiresIn, 10800) * 1e3
	};
	try {
		const stored = parseGrant(await backend().modifyRecord(key, (current) => {
			const existing = parseGrant(current);
			if (replacing !== void 0) {
				if (existing !== void 0 && existing.accessToken !== replacing) return;
			} else if (existing !== void 0 && existing.expiresAt !== null && existing.expiresAt > issuedAt + 6e4) return;
			return Promise.resolve({
				kind: "grant",
				payload
			});
		})) ?? payload;
		state.cached = stored;
		return stored;
	} catch (error) {
		state.cached = {
			accessToken,
			refreshToken,
			expiresAt: payload.expiresAt
		};
		throw new Error(`could not persist the console token (${error instanceof Error ? error.message : String(error)}); it stays valid until dsh restarts`);
	}
}
/**
* Remove a grant that can no longer be of any use.
*
* A refresh token the platform has rejected (`refresh_rejected`) is dead for
* good, and when no account is stored to re-login with there is no path that
* ever revives it. Leaving it on disk did two things: it kept an ownerless
* token pair in the credentials file after "forget account", and it made
* every poll hit the dead refresh token before giving up. This reaps it.
* Best-effort: a read-only store keeps serving from memory until restart.
* @param {string} [accessToken] - the dead token, also dropped from the
*   in-memory cache and rejection set.
*/
async function purgeGrant(wiring, state, accessToken) {
	const { backend, key } = wiring;
	state.cached = null;
	if (accessToken !== void 0) state.rejected.delete(accessToken);
	await backend().deleteRecord(key).catch(() => {});
}
/**
* Whether a token is still good for at least `skewMs`.
* @param {object} wiring - the store context wiring.
* @param {object} state - the store context state.
* @param {object} token - a stored grant, or null/undefined.
* @param {number} [at] - the clock reference; defaults to `now()`.
* @returns {boolean}
*/
function isFresh(wiring, state, token, at) {
	const { now, skewMs } = wiring;
	if (at === void 0) at = now();
	if (token === void 0 || token === null) return false;
	if (state.rejected.has(token.accessToken)) return false;
	if (token.expiresAt === null) return true;
	return token.expiresAt - at > skewMs;
}

//#endregion
//#region src/host/token-store/throttle.ts
/**
* Block 4 of the token-store split: the sign-in refusal state machine.
* Owns the throttle's read/write/clear, the local backoff doubling, the legacy
* record adoption, and the refusal-shape error synthesis.
*
* No state of its own; operates on the shared context from `state.ts`.
* Functions moved here are **verbatim** — the behavior baseline
* (`test/store-baseline.test.mjs`) stays green, so no semantics moved, only
* the file did.
*
* The two backoff constants live here because they only ever appear in this
* block; they are still re-exported from `token-store.ts` (public surface
* unchanged).
*
* @module dsh-connect-sensenova-token-plan/token-store/throttle
*/
/**
* The first wait imposed on a refusal the platform gave no window for.
*
* Doubles from here; `MAX_LOGIN_BACKOFF_MS` caps it.
*/
const DEFAULT_LOGIN_BACKOFF_MS = 6e4;
/**
* Cap on a self-imposed wait.
*
* Applies ONLY to a wait this store invented. A window the platform stated
* itself ("try again in 2 hours") is never truncated by it: capping that is
* exactly what walks back into a lock that is still in force.
*/
const MAX_LOGIN_BACKOFF_MS = 18e5;
/**
* Where the throttle used to live, as a record in the credentials service.
*
* Read for MIGRATION ONLY; the marker identifies the old record.
*/
const THROTTLE_MARKER = "signin-throttle";
/** Store version, bumped when the throttle's persisted shape changes. */
const THROTTLE_VERSION = 1;
/**
* The refusal an in-force throttle stands for.
*
* Rethrows the platform's own failure while it is still the live one, so the
* message the user reads is the platform's words, not this store's. Once the
* wait has been served and re-reading finds a fresh refusal, that failure is
* gone — so the throttle's own description takes over.
*
* The classification code is preserved on the synthesized error, so the panel
* can still tell a wrong password from a lockout and say which it is.
* @param {{code: string, parked: boolean, until: number|null, attempt: number}} held
*   the throttle in force.
* @param {Error} [cause] - the original refusal, when it is still current.
* @returns {Error} the error to throw.
*/
function throttleError(held, cause) {
	if (cause !== void 0) return cause;
	const error = /* @__PURE__ */ new Error(held.parked ? "sign-in is not being retried automatically: the account needs to be entered again" : `sign-in is not being retried automatically: waiting out a ${held.code} refusal`);
	error.code = held.code;
	return error;
}
/**
* How long a refusal without a stated window should wait.
*
* Doubles per consecutive refusal so a persistently wrong password settles
* at the cap instead of producing a steady one-minute trickle of attempts
* for as long as the panel stays open.
* @param {number} attempt - how many self-imposed waits have been served.
* @returns {number} milliseconds to wait.
*/
function localBackoffMs(attempt) {
	const doubled = DEFAULT_LOGIN_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
	return Math.min(doubled, MAX_LOGIN_BACKOFF_MS);
}
/**
* Read the persisted throttle, or `null` when absent, stale, or unreadable.
*
* A parked refusal has no deadline, so it is keyed on its `parked` flag
* rather than on a time: reading it back must not depend on a field that is
* legitimately absent.
* @returns {Promise<{code: string, parked: boolean, until: number|null, attempt: number}|null>}
*/
async function readThrottle(wiring, state) {
	const { throttleStore } = wiring;
	const held = await throttleStore.read().catch(() => null);
	if (held !== null) return held;
	return adoptLegacyThrottle(wiring, state);
}
/**
* Take over a throttle a previous version parked in the credentials service.
*
* Only ever reads. It matters because a parked refusal has no deadline: lose
* it across a restart and the next poll retries a password the user has not
* changed, which is how one wrong password becomes a locked account. So the
* old record is adopted rather than dropped, then deleted so this runs once.
* Both the current address and the pre-rename one are consulted, so a parked
* state left under either name survives.
* @returns {Promise<object|null>} the adopted throttle, or null.
*/
async function adoptLegacyThrottle(wiring, _state) {
	const { backend, THROTTLE_KEY, credentialKey, throttleStore, now } = wiring;
	const candidates = [THROTTLE_KEY, credentialKey("dsh-llm-rate-panel", "sensenova-console-throttle")];
	for (const legacyKey of candidates) try {
		const record = obj(await backend().readRecord(legacyKey));
		if (record.kind !== "grant") continue;
		const payload = obj(record.payload);
		if (payload.marker !== "signin-throttle") continue;
		if (num(payload.version) !== THROTTLE_VERSION) continue;
		const code = str(payload.code, "");
		if (code === "") continue;
		const attempt = num(payload.attempt, 1);
		const until = numOrNull(payload.until);
		const adopted = payload.parked === true ? {
			code,
			parked: true,
			until: null,
			attempt
		} : {
			code,
			parked: false,
			until,
			attempt
		};
		if (adopted.parked !== true && (until === null || until <= now())) continue;
		await throttleStore.write(adopted).catch(() => {});
		await backend().deleteRecord(legacyKey).catch(() => {});
		return adopted;
	} catch {
		continue;
	}
	return null;
}
/**
* Remember a refusal so neither this process nor another one retries it.
*
* Persisted because a second Host process polling the same account would
* otherwise walk straight into a lock this one is politely waiting out.
* @param {object} error - the refusal thrown by `login`.
* @param {number} [previousAttempt] - the attempt count being superseded.
* @returns {Promise<{code: string, parked: boolean, until: number|null, attempt: number}>}
*   the throttle now in force.
*/
async function writeThrottle(wiring, state, error, previousAttempt) {
	const { throttleStore, now } = wiring;
	const code = str(obj(error).code, CODE.LOGIN_FAILED);
	const parked = isCredentialRefusal(code);
	const stated = numOrNull(obj(error).retryAfterMs);
	state.consecutiveRefusals = num(previousAttempt, state.consecutiveRefusals) + 1;
	const attempt = state.consecutiveRefusals;
	state.throttle = {
		code,
		parked,
		until: parked ? null : now() + (stated === null ? localBackoffMs(attempt) : Math.max(stated, 0)),
		attempt
	};
	await throttleStore.write(state.throttle).catch(() => {});
	return state.throttle;
}
/**
* Drop the throttle, so the next sign-in is allowed to try.
* @returns {Promise<void>}
*/
async function clearThrottle(wiring, state) {
	const { throttleStore, backend, THROTTLE_KEY, credentialKey } = wiring;
	const LEGACY_SCOPE = "dsh-llm-rate-panel";
	const THROTTLE_ID = "sensenova-console-throttle";
	state.throttle = null;
	await throttleStore.clear().catch(() => {});
	await Promise.all([backend().deleteRecord(THROTTLE_KEY).catch(() => {}), backend().deleteRecord(credentialKey(LEGACY_SCOPE, THROTTLE_ID)).catch(() => {})]);
}
/**
* How much longer a throttle is in force, or `null` when it is not.
*
* A parked refusal has no deadline and so no countdown.
* @param {{parked: boolean, until: number|null}|null} held - the throttle.
* @returns {number|null} milliseconds remaining.
*/
function inForceWaitMs(wiring, held) {
	const { now } = wiring;
	if (held === null || held.parked || held.until === null) return null;
	return Math.max(0, held.until - now());
}

//#endregion
//#region src/host/token-store/account.ts
/**
* Block 2 of the token-store split: the account lifecycle. Owns reading the
* username/account, logging in, saving and forgetting the account, and the
* one-time password sweep.
*
* No state of its own; operates on the shared context from `state.ts`.
* `loginFromAccount` needs two grant-block operations (read the stored grant,
* persist the new one); they are injected by the caller so this module never
* imports `grant.ts` (no circular dependency).
*
* Functions moved here are **verbatim** — the behavior baseline
* (`test/store-baseline.test.mjs`) stays green, so no semantics moved, only
* the file did.
*
* @module dsh-connect-sensenova-token-plan/token-store/account
*/
/**
* The reference form of a credential name.
*
* `@deepseek-ai/dsh-credentials` exports `credentialRef` for this, and the
* values below are already in the form it produces — a bare variable name.
* Spelled out here so the store's own test does not have to resolve a peer
* package to exercise anything; the service treats a string and its branded
* reference identically.
* @param {string} name - the variable name.
* @returns {string} the reference.
*/
const credentialRef$1 = (name) => name;
/** Where the account lives. The password is NEVER persisted. */
const USERNAME_REF = "SENSENOVA_USERNAME";
const PASSWORD_REF = "SENSENOVA_PASSWORD";
/**
* The account's identity: the stored username, with the environment as a
* fallback. Kept apart from the password because only the username is ever
* persisted — `state()` asks "is there an account to clear?" without
* requiring a password to be available.
* @returns {Promise<string>} the username, or `""` when none is known.
*/
async function readUsername(wiring, _state) {
	const { backend, env } = wiring;
	const fromStore = async (ref) => {
		const resolved = await backend().resolve(credentialRef$1(ref)).catch(() => void 0);
		return verbatim(resolved?.value, "");
	};
	return str(await fromStore("SENSENOVA_USERNAME"), "") || str(env["SENSENOVA_USERNAME"], "");
}
/**
* The account to log in with: a stored (or environment) username and an
* ENVIRONMENT password.
*
* The password is never persisted. `SENSENOVA_PASSWORD` in the environment
* is its only durable source, and that is an explicit opt-in: without an env
* password the panel simply asks again when the refresh token dies.
* @returns {Promise<{username: string, password: string, source: string}|undefined>}
*/
async function readAccount(wiring, state) {
	const { backend, env } = wiring;
	const username = await readUsername(wiring, state);
	if (!state.passwordSwept) {
		state.passwordSwept = true;
		await backend().unset(credentialRef$1(PASSWORD_REF)).catch(() => {});
	}
	const password = verbatim(env[PASSWORD_REF], "");
	if (username === "" || password.trim() === "") return void 0;
	return {
		username,
		password,
		source: "env"
	};
}
/**
* Log in with an account and return a self-renewing grant.
*
* The account is taken EXPLICITLY when the caller just typed it (the panel
* save path: the password lives in that call's closure and is never
* written anywhere), and read back from the environment otherwise (the
* auto-recovery path after a dead refresh token, opt-in via
* `SENSENOVA_PASSWORD`).
*
* The grant read BEFORE the sign-in is named as the one this login
* supersedes. It has to be read first: the token pair only arrives after the
* network walk, and naming nothing is what let a still-fresh grant from a
* DIFFERENT account silently survive a deliberate switch — the panel said
* "signed in" while keeping serving the previous account. Naming the read
* grant turns the write into the same compare-and-set a refresh uses: an
* intentional switch wins, a login racing another process's rotation defers.
* @param {{username: string, password: string}|undefined} explicit - an account
*   supplied by the caller (never persisted); positionally required, though
*   `undefined` is tolerated and falls back to `readAccount`.
* @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
*/
async function loginFromAccount(wiring, state, explicit, readStored, store) {
	const { auth, onTrace } = wiring;
	const account = explicit ?? await readAccount(wiring, state);
	if (account === void 0) throw pluginError(CODE.NOT_CONFIGURED, "no console account is configured");
	const previous = await readStored();
	const result = await auth.login({
		username: account.username,
		password: account.password
	}, { onTrace });
	return store(result.accessToken, result.refreshToken, result.expiresIn, previous?.accessToken);
}
/**
* Forget the stored account.
*
* The grant is left alone at first: the panel keeps working on the refresh
* token until that runs out, and only then asks for the account again. With
* no account left to recover a dead refresh token, `acquire` also reaps the
* expired grant then, so nothing ownerless is left behind.
* @returns {Promise<void>}
*/
async function forgetAccount(wiring, state) {
	const { backend } = wiring;
	await backend().unset(credentialRef$1(USERNAME_REF));
	await backend().unset(credentialRef$1(PASSWORD_REF));
	state.cached = null;
}

//#endregion
//#region src/host/token-store/renewal.ts
/**
* Block 3 of the token-store split: renewal through the stored refresh token.
*
* `renewWithRefresh` calls the grant block's `store` (compare-and-set write),
* so it receives `store` as an injected callback — keeping this module free of
* any `grant.ts` import (no circular dependency). The function body is
* **verbatim**; the behavior baseline stays green.
*
* @module dsh-connect-sensenova-token-plan/token-store/renewal
*/
/**
* Renew with the stored refresh token.
*
* Goes through the grant block's `store`, which names the superseded access
* token so a concurrent rotation is detected instead of silently overwritten.
* @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number|null}>}
*/
async function renewWithRefresh(wiring, _state, stored, store) {
	const { auth } = wiring;
	if (stored?.refreshToken === void 0 || stored.refreshToken === "") throw pluginError(CODE.NO_REFRESH_TOKEN, "stored grant has no refresh token");
	const result = await auth.refresh(stored.refreshToken);
	return store(result.accessToken, result.refreshToken, result.expiresIn, stored.accessToken);
}

//#endregion
//#region src/host/token-store/acquire.ts
/**
* The single seam where the four blocks meet: `acquire()`.
*
* Order of operations (frozen by the behavior baseline, must NOT change):
*   1. throttle gate — read the in-force refusal, fail fast if parked or in window
*   2. grant freshness — read stored (or cached), return if fresh
*   3. renewal — try the refresh token; on a rejected refresh, fork:
*      - account still stored → fall through to login
*      - no account → reap the dead grant and rethrow
*   4. login fallback — log in with the stored/env account; on a new refusal,
*      write the throttle (except `not_configured`, which records nothing)
*
* All block functions are injected by the caller so this module never imports
* them directly (no circular dependency). The body is **verbatim**; the
* behavior baseline stays green.
*
* @module dsh-connect-sensenova-token-plan/token-store/acquire
*/
/**
* Acquire a usable token, logging in or refreshing as needed.
*
* @param {object} wiring - the store context wiring.
* @param {object} state - the store context state.
* @param {object} blocks - the four block functions, injected by the caller.
* @returns {Promise<string>} the access token now in effect.
*/
async function acquire(wiring, state, blocks) {
	const { now } = wiring;
	const { readThrottle, clearThrottle, readStored, isFresh, renewWithRefresh, readAccount, loginFromAccount, writeThrottle, throttleError, purgeGrant } = blocks;
	const held = state.throttle ?? await readThrottle();
	state.throttle = held;
	if (held !== null && (held.parked || held.until !== null && held.until > now())) throw throttleError(held);
	if (held !== null) {
		state.consecutiveRefusals = held.attempt;
		await clearThrottle();
	}
	const stored = await readStored() ?? state.cached ?? void 0;
	if (stored !== null && stored !== void 0 && isFresh(stored)) {
		state.cached = stored;
		return stored.accessToken;
	}
	if (stored !== null && stored !== void 0 && stored.refreshToken !== "") try {
		return (await renewWithRefresh(stored)).accessToken;
	} catch (error) {
		if (obj(error).code !== CODE.REFRESH_REJECTED && obj(error).code !== CODE.NO_REFRESH_TOKEN) throw error;
		if (await readAccount() === void 0) {
			await purgeGrant(stored === null || stored === void 0 ? void 0 : stored.accessToken);
			throw error;
		}
	}
	try {
		const fresh = await loginFromAccount();
		state.consecutiveRefusals = 0;
		if (state.throttle !== null) await clearThrottle();
		return fresh.accessToken;
	} catch (error) {
		if (obj(error).code === CODE.NOT_CONFIGURED) throw error;
		const held = await writeThrottle(error, state.throttle?.attempt);
		throw held.parked ? error : throttleError(held, error);
	}
}

//#endregion
//#region src/host/token-store.ts
/**
* SenseNova console token store — the seam between the credentials service and
* the panel's console calls.
*
* The console JWT lives 180 minutes; this store keeps it renewed, so the
* panel never needs the pre-store ritual of copying a fresh token out of
* devtools into `$DSH_HOME/.env` and restarting.
*
* How it works:
*
* - The grant lives in `ctx.credentials` as a `grant` record, never on disk in
*   this plugin and never in the environment. Writing goes through
*   `modifyRecord`, the service's serialized read-modify-write path, so two
*   Host processes rotating the same refresh token cannot lose one another's
*   write.
* - `getToken()` returns a token that is valid for at least
*   `skewMs`, renewing through `refresh_token` when the stored one is close to
*   expiry. Hydra rotates refresh tokens, so every renewal also replaces the
*   stored refresh token.
* - `invalidate()` drops the in-memory token after a 401 so the next call
*   renews once rather than looping on a token the console already rejected.
*
* Sign-in is throttled, never retried on a poll timer. The platform locks an
* account after a few bad attempts, so an automatic retry turns one mistake
* into a lockout. Two kinds of refusal are treated differently:
*
* - A time-shaped one (locked, rate-limited, a platform fault) waits out a
*   backoff — the platform's own window when it states one, otherwise a local
*   one that doubles per attempt up to half an hour. The throttle is persisted,
*   so a second Host process does not keep knocking during the wait.
* - A credential-shaped one (wrong password, a captcha the user must clear) is
*   parked outright: waiting cannot fix it, so the panel asks for the account
*   again and only an explicit resubmit retries. This is what stops a panel
*   left open overnight from spending an attempt every minute on a password
*   nobody has corrected.
*
* Account login is a one-time bootstrap: put the account in the environment
* (`SENSENOVA_USERNAME` / `SENSENOVA_PASSWORD`) and the store logs in on the
* first use, then keeps itself alive from the refresh token alone. The
* password is never persisted by this module.
*
* Structure: this file is the FACADE — `createTokenStore` builds the shared
* context via `createStoreContext` (`./token-store/state.ts`) and delegates to
* the four extracted blocks (grant / account / renewal / throttle, in
* `./token-store/{grant,account,renewal,throttle}.ts`) plus the acquire seam
* (`./token-store/acquire.ts`). Public API and export surface are unchanged.
* The split doc is `docs/TOKEN-STORE-SPLIT.md`.
*
* @module dsh-connect-sensenova-token-plan/token-store
*/
/**
* The reference form of a credential name.
*
* `@deepseek-ai/dsh-credentials` exports `credentialRef` for this, and the
* values below are already in the form it produces — a bare variable name.
* Spelled out here so the store's own test does not have to resolve a peer
* package to exercise anything; the service treats a string and its branded
* reference identically, which check 14 pins down.
* @param {string} name - the variable name.
* @returns {string} the reference.
*/
const credentialRef = (name) => name;
/**
* Build the token store.
*
* @param {object} options - wiring.
* @param {object|null} options.credentials - the `ctx.credentials` service, or
*   `null` when the Host has none. A missing service must not disable the
*   panel: everything falls back to this process's memory, so the account form
*   still works and the token renews for as long as the Host lives. Only a
*   restart then asks again.
* @param {object} [options.auth] - a `createAuth()` instance; defaults to one
*   built on the platform defaults. The Host passes its configured instance so
*   the login flow and token refresh target the operator's endpoints, not the
*   shipped ones.
* @param {Function} options.credentialKey - the service's key factory, so the
*   branded key is built by the service that owns the type.
* @param {object} [options.env] - environment source (defaults to
*   `process.env`); injected by the tests.
* @param {number} [options.skewMs] - renew this long before expiry.
* @param {object} [options.throttleStore] - where sign-in refusals are
*   remembered; defaults to this plugin's own file, which is what lets one
*   Host process see a lock another is waiting out. Injected by the tests.
* @param {() => number} [options.now] - clock source; injected by the tests so
*   a backoff window can be crossed deliberately instead of by waiting.
* @param {function(?object[], ?(Error & {code?: unknown})): void} [options.onTrace] - called with
*   the sanitized hop list when a sign-in attempt ENDS, success or failure;
*   the second argument is `null` on success and the thrown error otherwise
*   (matching the contract `sensenova-auth.ts` uses).
* @returns the store: `getToken`, `invalidate`, `saveAccount`,
*   `forgetAccount`, and `state`.
*/
function createTokenStore(options) {
	const { wiring, state } = createStoreContext(options);
	const { env, backend, ephemeral } = wiring;
	const { rejected } = state;
	/** One-line delegations to the extracted blocks. */
	const readStored$1 = () => readStored(wiring, state);
	const store = (accessToken, refreshToken, expiresAt, replacing) => storeGrant(wiring, state, accessToken, refreshToken, expiresAt, replacing);
	const purgeGrant$1 = (accessToken) => purgeGrant(wiring, state, accessToken);
	const isFresh$1 = (token, at) => isFresh(wiring, state, token, at);
	const readThrottle$1 = () => readThrottle(wiring, state);
	const clearThrottle$1 = () => clearThrottle(wiring, state);
	const writeThrottle$1 = (error, previousAttempt) => writeThrottle(wiring, state, error, previousAttempt);
	const throttleError$1 = (held, cause) => throttleError(held, cause);
	const inForceWaitMs$1 = (held) => inForceWaitMs(wiring, held);
	const readUsername$1 = () => readUsername(wiring, state);
	const readAccount$1 = () => readAccount(wiring, state);
	const loginFromAccount$1 = (explicit) => loginFromAccount(wiring, state, explicit, readStored$1, store);
	const renewWithRefresh$1 = (stored) => renewWithRefresh(wiring, state, stored, store);
	const acquire$1 = () => acquire(wiring, state, {
		readThrottle: readThrottle$1,
		clearThrottle: clearThrottle$1,
		readStored: readStored$1,
		isFresh: isFresh$1,
		renewWithRefresh: renewWithRefresh$1,
		readAccount: readAccount$1,
		loginFromAccount: loginFromAccount$1,
		writeThrottle: writeThrottle$1,
		throttleError: throttleError$1,
		purgeGrant: purgeGrant$1
	});
	return {
		/**
		* A console access token that should not be rejected for expiry.
		* @returns {Promise<string>}
		*/
		async getToken() {
			if (isFresh$1(state.cached)) return state.cached.accessToken;
			state.inflight ??= acquire$1().then((token) => {
				state.lastError = null;
				return token;
			}).catch((error) => {
				state.lastError = error;
				throw error;
			}).finally(() => {
				state.inflight = null;
			});
			return state.inflight;
		},
		/**
		* Forget the token the console just rejected, so the next call renews
		* exactly once instead of replaying a token the server already refused.
		* @param {string} [token] - the token that was refused; defaults to the
		*   cached one.
		*/
		invalidate(token) {
			const refused = str(token, state.cached?.accessToken ?? "");
			if (refused !== "") {
				rejected.add(refused);
				while (rejected.size > 8) rejected.delete(rejected.values().next().value ?? "");
			}
			state.cached = null;
		},
		/**
		* Store a console account, then log in with it.
		*
		* This is what the panel's setup form calls. Only the USERNAME goes to
		* `ctx.credentials` (owner-only on disk, never in this plugin's own
		* files); the password stays in this call's closure and is gone when the
		* attempt ends. The resulting grant is what keeps the panel alive
		* afterwards, so a rejected password leaves nothing secret at rest.
		* @param {{username: string, password: string}} account - the credentials.
		* @returns {Promise<void>}
		*/
		async saveAccount(account) {
			const username = str(account?.username, "");
			const password = verbatim(account?.password, "");
			if (username === "" || password.trim() === "") throw pluginError(CODE.MISSING_CREDENTIALS, "a username and a password are both required");
			await backend().set(credentialRef(USERNAME_REF), username);
			state.cached = null;
			rejected.clear();
			await clearThrottle$1();
			try {
				await loginFromAccount$1({
					username,
					password
				});
				state.lastError = null;
			} catch (error) {
				if (obj(error).code !== CODE.NOT_CONFIGURED) await writeThrottle$1(error);
				throw error;
			}
		},
		/**
		* Forget the stored account.
		*
		* The grant is left alone at first: the panel keeps working on the refresh
		* token until that runs out, and only then asks for the account again. With
		* no account left to recover a dead refresh token, `acquire` also reaps the
		* expired grant then, so nothing ownerless is left behind.
		* @returns {Promise<void>}
		*/
		async forgetAccount() {
			const result = await forgetAccount(wiring, state);
			state.lastError = null;
			return result;
		},
		/**
		* A description of the store for the panel: whether a token is held, when
		* it expires, and the last failure. No secret is included.
		*/
		async state() {
			const stored = await readStored$1();
			const account = await readAccount$1();
			const username = await readUsername$1();
			const held = state.throttle ?? await readThrottle$1();
			return {
				configured: stored !== void 0 || account !== void 0,
				hasAccount: username !== "",
				autoRecoverArmed: str(env[PASSWORD_REF], "") !== "",
				hasRefreshToken: str(stored?.refreshToken, "") !== "",
				expiresAt: stored?.expiresAt ?? null,
				needsAccount: stored === void 0 && account === void 0,
				ephemeral: ephemeral(),
				retryAfterMs: inForceWaitMs$1(held),
				needsUserAction: held !== null && held.parked,
				error: state.lastError === null ? null : state.lastError instanceof Error ? state.lastError.message : String(state.lastError)
			};
		}
	};
}

//#endregion
//#region src/host/catalog-store.ts
/**
* The persisted model catalog — this plugin's OWN state file, never the Host's
* configuration.
*
* Why a file at all: the directly-registered LLM provider needs a model list
* before the first snapshot poll completes (and after a restart with no console
* login), so the last catalog the API key fetched is cached under
* `$DSH_HOME/state/<plugin>/catalog.json` (or `state/<profile>/<plugin>/` when
* the Host names one — see `profileStateDir`). It is deliberately NOT written into
* the settings row (`cordis.patch.yml`): a catalog is operational state, not an
* operator decision, and writing volatile arrays into the patch layer is the
* shape the WorkBuddy catalog drift warned about.
*
* Integrity follows `throttle-store.ts`: a versioned payload, a temp file plus
* an atomic rename (two Host processes can share the directory), owner-only
* modes, and "anything unrecognised reads as no catalog" — a corrupted or
* downgraded file costs one re-fetch, never a crash.
*
* @module dsh-connect-sensenova-token-plan/catalog-store
*/
/** Shape version, bumped when the persisted form changes incompatibly. */
const CATALOG_VERSION = 1;
/**
* Normalize a model-id allow-list.
*
* An EMPTY list means "no filter" (the WorkBuddy convention): a fresh install
* has curated nothing and must still be offered every model. Once non-empty it
* is an allow-list. Junk entries are dropped rather than stored.
* @param {unknown} raw - the persisted or posted list.
* @returns {string[]} unique string ids in first-seen order.
*/
function normalizeEnabledIds(raw) {
	if (!Array.isArray(raw)) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const item of raw) {
		const id = str(item, "");
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}
/**
* The directory this plugin's state lives in — per-profile when the Host names
* one, shared otherwise (PITFALLS §23).
* @param {string|null} [profile] - the profile name; `null` means shared.
* @returns {string} the directory.
*/
function catalogDir(profile) {
	return profileStateDir(name, profile);
}
/**
* Normalize a raw catalog into unique, whole entries.
*
* Mirrors `console-client.fetchModelCatalog`: keep every field the platform
* sent (vision identification reads `input_modalities`), normalize `id`, and
* drop entries without one. Duplicate ids keep the LAST occurrence — the
* freshest read wins — and stay in first-seen order.
* @param {unknown} raw - the raw `body.data` array or persisted entries.
* @returns {object[]} normalized entries.
*/
function normalizeEntries(raw) {
	if (!Array.isArray(raw)) return [];
	const byId = /* @__PURE__ */ new Map();
	for (const item of raw) {
		const source = obj(item);
		const id = str(source.id, "");
		if (id === "") continue;
		byId.set(id, {
			...source,
			id
		});
	}
	return [...byId.values()];
}
/**
* Parse a persisted catalog, or `null` when it is absent, unusable, or foreign.
*
* Only two things are refused here: a foreign shape (`version` mismatch) and a
* record that never carried a fetch time. There is deliberately NO staleness
* test — the catalog is cache-shaped, and "how old is too old" is the caller's
* call (the snapshot route refreshes it on its own cadence and replaces the
* file on write), so refusing a merely old catalog would only force a re-fetch
* that the next poll does anyway.
*
* The safe direction for a cache is "absent": the next snapshot re-fetches.
* @param {unknown} raw - the parsed file contents.
* @returns {{version: number, fetchedAt: number, entries: object[], enabledModelIds: string[]}|null}
*/
function parse(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const body = raw;
	if (num(body.version, 0) !== 1) return null;
	const fetchedAt = num(body.fetchedAt, 0);
	if (fetchedAt <= 0) return null;
	const entries = normalizeEntries(body.entries);
	const enabledModelIds = normalizeEnabledIds(body.enabledModelIds);
	return {
		version: 1,
		fetchedAt,
		entries,
		enabledModelIds
	};
}
/**
* The store contract both the file-backed and in-memory factories satisfy:
* one cached catalog of model entries plus a curated id allow-list.
* @typedef {object} CatalogStore
* @property {() => Promise<object[]>} list - stored entries, `[]` when none usable.
* @property {() => Promise<string[]>} listEnabledIds - allow-list; `[]` means "no filter".
* @property {(entries: object[], enabledModelIds?: string[]) => Promise<void>} replace - swap the catalog, preserving the allow-list unless given a new one.
* @property {(ids: string[]) => Promise<void>} setEnabledIds - swap ONLY the allow-list.
* @property {() => Promise<void>} clear - remove the stored catalog.
*/
/**
* A catalog store backed by one atomically-written file.
* @param {object} [options] - wiring.
* @param {string} [options.dir] - directory; overrides {@link options.profile}.
* @param {string|null} [options.profile] - the profile name, so two profiles
*   each get their own catalog instead of overwriting one shared allow-list;
*   defaults to `null` (the shared directory, i.e. today's behaviour).
* @param {() => number} [options.now] - clock source; injected by the tests.
* @param {number} [options.ttlMs] - how long a parsed record may be reused
*   before disk is consulted again; defaults to {@link STATE_READ_TTL_MS}.
* @returns {CatalogStore} the store.
*/
function createFileCatalogStore(options = {}) {
	const { dir, profile = null, now = Date.now, ttlMs = STATE_READ_TTL_MS } = options;
	const stateDir$4 = dir ?? catalogDir(profile);
	const file = join(stateDir$4, "catalog.json");
	/**
	* Last known record, mirrored from {@link cache} so the writers can reuse the
	* allow-list without a second read. `undefined` means "never synced from
	* disk", `null` means "synced, nothing usable stored".
	* @type {{version: number, fetchedAt: number, entries: object[], enabledModelIds: string[]}|null|undefined}
	*/
	let held;
	const legacyFile = dir === void 0 && profile ? join(stateDir(name), "catalog.json") : null;
	const cache = createStateReadCache(async () => parse(await readStateJson(file)), {
		ttlMs,
		now,
		inheritFrom: legacyFile === null ? null : {
			/** The pre-§23 record, if this machine ever wrote one. */
			read: async () => parse(await readStateJson(legacyFile)),
			/** Re-persist an inherited record under this profile's own directory. */
			write: async (record) => {
				held = record;
				await persist();
			}
		}
	});
	/** Sync `held` with disk (through the TTL cache) and return it. */
	const seen = async () => {
		held = await cache.read();
		return held;
	};
	/**
	* Persist the held record atomically; a write failure only loses the cache.
	*
	* The temp path is process-plus-clock unique (`state-store.ts`'s
	* `temporaryOf`), so two Host processes sharing this directory never write
	* the same temp name and `rename` each other's half-written file away.
	*/
	const persist = async () => {
		if (held === null) return;
		const temporary = temporaryOf(stateDir$4, "catalog.json", now);
		try {
			await ensureStateDir(stateDir$4);
			await writeStateFile(file, JSON.stringify(held), { temporary });
		} catch {
			await rm(temporary, { force: true }).catch(() => {});
		}
	};
	return {
		/**
		* The stored entries, or `[]` when nothing usable is stored.
		* @returns {Promise<object[]>}
		*/
		async list() {
			const record = await seen();
			return record === null ? [] : record.entries;
		},
		/**
		* The curated model-id allow-list; an EMPTY array means "no filter".
		* @returns {Promise<string[]>}
		*/
		async listEnabledIds() {
			const record = await seen();
			return record === null ? [] : record.enabledModelIds;
		},
		/**
		* Atomically replace the stored catalog.
		*
		* A read-only Home must not break the panel: the write failing only means
		* the catalog is re-fetched after the next restart, so the error is
		* swallowed after the in-memory copy is updated. The curated allow-list is
		* PRESERVED across a catalog refresh unless a new one is supplied.
		* @param {object[]} entries - the fresh catalog entries.
		* @param {string[]} [enabledModelIds] - an optional replacement allow-list.
		* @returns {Promise<void>}
		*/
		async replace(entries, enabledModelIds) {
			const current = await seen();
			const kept = current === null ? [] : current.enabledModelIds;
			held = {
				version: 1,
				fetchedAt: now(),
				entries: normalizeEntries(entries),
				enabledModelIds: enabledModelIds === void 0 ? kept : normalizeEnabledIds(enabledModelIds)
			};
			cache.remember(held);
			await persist();
		},
		/** Replace ONLY the curated allow-list, keeping the cached catalog. */
		async setEnabledIds(ids) {
			const current = await seen();
			const entries = current === null ? [] : current.entries;
			const fetchedAt = current === null ? now() : current.fetchedAt;
			held = {
				version: 1,
				fetchedAt,
				entries,
				enabledModelIds: normalizeEnabledIds(ids)
			};
			cache.remember(held);
			await persist();
		},
		/** Remove the stored catalog (used when the API key is forgotten). */
		async clear() {
			held = null;
			cache.remember(null);
			try {
				await rm(file, { force: true });
			} catch {}
		}
	};
}

//#endregion
//#region src/host/provider-store.ts
/**
* The provider-registration switch — this plugin's OWN state file, never the
* Host's configuration.
*
* Why a file at all: `registerProvider` in `cordis.patch.yml` is a DEPLOYMENT
* default the operator edits with a reload, but the panel needs a live switch
* that takes effect on the next request. The switch state therefore lives in
* `$DSH_HOME/state/<plugin>/provider.json`, exactly like the catalog
* (`catalog-store.ts`) and the throttle (`throttle-store.ts`): operational
* state, not an operator decision baked into the patch layer.
*
* Precedence at read time:
*
*   1. a value SAVED FROM THE PANEL (enabled: true|false) always wins;
*   2. no saved value (never touched, or the file was unreadable) falls back
*      to the patch's `registerProvider` — so an operator who enabled the
*      provider through configuration keeps it enabled across this change.
*
* Integrity follows `throttle-store.ts` / `catalog-store.ts`: a versioned
* payload, a temp file plus an atomic rename (two Host processes can share
* the directory), owner-only modes, and "anything unrecognised reads as not
* set" — a corrupted or downgraded file costs one re-toggle, never a crash.
*
* @module dsh-connect-sensenova-token-plan/provider-store
*/
/** Shape version, bumped when the persisted form changes incompatibly. */
const PROVIDER_VERSION = 1;
/**
* The directory this plugin's state lives in — per-profile when the Host names
* one, shared otherwise (PITFALLS §23). Unlike the THROTTLE, which is
* deliberately shared across profiles, this answers "does THIS profile want the
* provider registered" and must not be overwritten by the other profile's Host.
* @param {string|null} [profile] - the profile name; `null` means shared.
* @returns {string} the directory.
*/
function providerDir(profile) {
	return profileStateDir(name, profile);
}
/**
* Normalize an on/off switch: only booleans are real answers.
* @param {unknown} raw - the persisted or posted value.
* @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
*/
function normalizeEnabled(raw) {
	return typeof raw === "boolean" ? raw : null;
}
/**
* The file-backed provider switch.
* @param {object} [options]
* @param {string} [options.dir] - override the state directory (tests).
* @param {string|null} [options.profile] - the profile name; see {@link providerDir}.
* @param {number} [options.ttlMs] - how long a parsed switch may be reused
*   before disk is consulted again; defaults to {@link STATE_READ_TTL_MS}.
* @returns {object} the store.
*/
function createFileProviderStore(options = {}) {
	const { dir, profile = null, ttlMs = STATE_READ_TTL_MS } = options;
	const stateDir$3 = dir ?? providerDir(profile);
	const filePath = join(stateDir$3, "provider.json");
	/**
	* Write one payload atomically to this switch's own file.
	*
	* The single writer for all three callers (save / forget / the §23 legacy
	* adoption) — three copies of this is exactly the drift this module keeps
	* getting bitten by.
	* @param {object} body - the JSON body to persist.
	* @returns {Promise<void>}
	*/
	const writePayload = async (body) => {
		const temporary = temporaryOf(stateDir$3, "provider.json");
		await ensureStateDir(stateDir$3);
		await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary });
	};
	const legacyFile = dir === void 0 && profile ? join(stateDir(name), "provider.json") : null;
	const parseSwitch = (raw) => {
		const source = obj(raw);
		return source.version === 1 ? normalizeEnabled(source.enabled) : null;
	};
	const cache = createStateReadCache(async () => {
		return parseSwitch(await readStateJson(filePath));
	}, {
		ttlMs,
		inheritFrom: legacyFile === null ? null : {
			read: async () => parseSwitch(await readStateJson(legacyFile)),
			write: async (enabled) => {
				await writePayload({
					version: 1,
					enabled,
					updatedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
			}
		}
	});
	const read = () => cache.read();
	return {
		/**
		* The saved switch value.
		* @returns {Promise<boolean|null>} `null` = not set, fall back to config.
		*/
		async enabled() {
			return read();
		},
		/**
		* Whether the panel has ever saved a value here.
		* @returns {Promise<boolean>}
		*/
		async isSet() {
			return await read() !== null;
		},
		/**
		* Persist a switch value. The write is atomic (temp file + rename) so a
		* concurrent reader never sees a partial payload.
		* @param {boolean} value - the new switch state.
		* @returns {Promise<void>}
		*/
		async save(value) {
			const enabled = normalizeEnabled(value);
			if (enabled === null) throw new TypeError("provider switch expects a boolean");
			await writePayload({
				version: 1,
				enabled,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			cache.remember(enabled);
		},
		/**
		* Forget the panel-saved value: the config default rules again.
		* @returns {Promise<void>}
		*/
		async forget() {
			cache.remember(null);
			await writePayload({
				version: 1,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
		}
	};
}

//#endregion
//#region src/host/draw-store.ts
/**
* The draw-tool switch — this plugin's OWN state file, never the Host's
* configuration.
*
* Mirrors `provider-store.ts`: `drawEnabled` in `cordis.patch.yml` is a
* DEPLOYMENT default the operator edits with a reload, but the panel needs a
* live switch that takes effect on the next request. The switch state lives in
* `$DSH_HOME/state/<plugin>/draw.json` when no profile is named, and
* `$DSH_HOME/state/<profile>/<plugin>/draw.json` when the Host runs under one
* (`profileStateDir`) — exactly like the catalog; the throttle shares the same
* directory by design. Operational state, not an operator decision baked into
* the patch layer.
*
* Precedence at read time:
*
*   1. a value SAVED FROM THE PANEL (enabled: true|false) always wins;
*   2. no saved value (never touched, or the file was unreadable) falls back
*      to the patch's `drawEnabled` — so an operator who enabled drawing
*      through configuration keeps it enabled across this change.
*
* Integrity follows `provider-store.ts`: a versioned payload, a temp file plus
* an atomic rename, owner-only modes, and "anything unrecognised reads as not
* set" — a corrupted or downgraded file costs one re-toggle, never a crash.
*
* @module dsh-connect-sensenova-token-plan/draw-store
*/
/** Shape version, bumped when the persisted form changes incompatibly. */
const DRAW_STORE_VERSION = 1;
/**
* The directory this plugin's state lives in — per-profile when the Host names
* one, shared otherwise (PITFALLS §23). Same reasoning as the provider switch:
* "does THIS profile route images through SenseNova" is a per-profile opt-in.
* @param {string|null} [profile] - the profile name; `null` means shared.
* @returns {string} the directory.
*/
function drawStoreDir(profile) {
	return profileStateDir(name, profile);
}
/**
* Normalize an on/off switch: only booleans are real answers.
* @param {unknown} raw - the persisted or posted value.
* @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
*/
function normalizeDrawEnabled(raw) {
	return typeof raw === "boolean" ? raw : null;
}
/**
* Normalize a panel-saved draw-model preference: a non-empty string id, or
* `null` when nothing usable (absent / wrong type / blank).
* @param {unknown} raw - the persisted or posted value.
* @returns {string|null}
*/
function normalizeDrawModelId(raw) {
	return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}
/**
* The file-backed draw switch.
* @param {object} [options]
* @param {string} [options.dir] - override the state directory (tests).
* @param {string|null} [options.profile] - the profile name; see {@link drawStoreDir}.
* @param {number} [options.ttlMs] - how long a parsed switch may be reused
*   before disk is consulted again; defaults to {@link STATE_READ_TTL_MS}.
* @returns {object} the store.
*/
function createFileDrawStore(options = {}) {
	const { dir, profile = null, ttlMs = STATE_READ_TTL_MS } = options;
	const stateDir$2 = dir ?? drawStoreDir(profile);
	const filePath = join(stateDir$2, "draw.json");
	/**
	* Write one payload atomically to this switch's own file — the single writer
	* for save / forget / the §23 legacy adoption (see `provider-store.ts`).
	* @param {object} body - the JSON body to persist.
	* @returns {Promise<void>}
	*/
	const writePayload = async (body) => {
		const temporary = temporaryOf(stateDir$2, "draw.json");
		await ensureStateDir(stateDir$2);
		await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary });
	};
	const legacyFile = dir === void 0 && profile ? join(stateDir(name), "draw.json") : null;
	const parseSwitch = (raw) => {
		const source = obj(raw);
		if (source.version !== 1) return null;
		return {
			enabled: normalizeDrawEnabled(source.enabled),
			modelId: normalizeDrawModelId(source.drawModelId)
		};
	};
	const cache = createStateReadCache(async () => {
		return parseSwitch(await readStateJson(filePath));
	}, {
		ttlMs,
		inheritFrom: legacyFile === null ? null : {
			read: async () => parseSwitch(await readStateJson(legacyFile)),
			write: async (enabled) => {
				await writePayload({
					version: 1,
					enabled,
					updatedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
			}
		}
	});
	const read = () => cache.read();
	const saved = async () => await read() ?? {
		enabled: null,
		modelId: null
	};
	return {
		/**
		* The saved switch value.
		* @returns {Promise<boolean|null>} `null` = not set, fall back to config.
		*/
		async enabled() {
			return (await saved()).enabled;
		},
		/**
		* The saved draw-model preference.
		* @returns {Promise<string|null>} `null` = not set, fall back to config.
		*/
		async modelId() {
			return (await saved()).modelId;
		},
		/**
		* Whether the panel has ever saved a value here. A file that exists but
		* carries no answers (post-forget) still reads as "not set".
		* @returns {Promise<boolean>}
		*/
		async isSet() {
			const value = await read();
			return value !== null && (value.enabled !== null || value.modelId !== null);
		},
		/**
		* Persist a switch value. The write is atomic (temp file + rename) so a
		* concurrent reader never sees a partial payload.
		* @param {boolean} value - the new switch state.
		* @returns {Promise<void>}
		*/
		async save(value) {
			const enabled = normalizeDrawEnabled(value);
			if (enabled === null) throw new TypeError("draw switch expects a boolean");
			await writePayload({
				version: 1,
				enabled,
				drawModelId: (await saved()).modelId ?? void 0,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			cache.remember({
				enabled,
				modelId: (await saved()).modelId
			});
		},
		/**
		* Forget the panel-saved value: the config default rules again.
		* @returns {Promise<void>}
		*/
		async forget() {
			cache.remember({
				enabled: null,
				modelId: (await saved()).modelId
			});
			await writePayload({
				version: 1,
				drawModelId: (await saved()).modelId ?? void 0,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
		},
		/**
		* Persist a draw-model preference (the panel's picker). `null` clears it.
		* @param {string|null} value - the preferred catalog id, or null for auto.
		* @returns {Promise<void>}
		*/
		async saveModel(value) {
			const modelId = normalizeDrawModelId(value);
			if (modelId === null && value != null) throw new TypeError("draw model expects a non-empty string or null");
			const enabled = (await saved()).enabled;
			await writePayload({
				version: 1,
				...enabled !== null ? { enabled } : {},
				...modelId !== null ? { drawModelId: modelId } : {},
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			cache.remember({
				enabled,
				modelId
			});
		},
		/**
		* Forget the draw-model preference: the config default (usually auto) rules again.
		* @returns {Promise<void>}
		*/
		async forgetModel() {
			const enabled = (await saved()).enabled;
			cache.remember({
				enabled,
				modelId: null
			});
			await writePayload({
				version: 1,
				...enabled !== null ? { enabled } : {},
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
		}
	};
}

//#endregion
//#region src/host/api-key-store.ts
/**
* The SenseNova inference API key (`sk-…`) store — the credential behind the
* directly-registered LLM provider and the `/v1/models` catalog.
*
* It is the SAME reference-value mechanism the console account uses
* (`token-store.ts`): the key is not a new credentials record KIND (the
* service admits only `grant` / `api-key`, and a private kind makes the whole
* credentials document unparseable and takes the Host down). It is stored as a
* credential REFERENCE named `SENSENOVA_API_KEY` — owner-only in
* `~/.dsh/.credentials.yaml` — and the raw process environment stays honored
* as a fallback, so an existing `$DSH_HOME/.env` setup keeps working untouched.
*
* Precedence, per read: the credentials service (a value typed into the panel
* must win without a restart), then this process's memory (a Host with no
* credentials service), then the environment.
*
* @module dsh-connect-sensenova-token-plan/api-key-store
*/
/**
* The reference name the key is stored under.
*
* The hand-written `llm-pi-ai` provider resolves the same `apiKeyEnv` name, so
* a key this panel saves lights that provider too — one stored value, both
* routes.
*/
const API_KEY_REF = "SENSENOVA_API_KEY";
/**
* Build the API-key store.
* @param {object} [options] - wiring.
* @param {object|Function|null} [options.credentials] - the `ctx.credentials`
*   service, a resolver, or `null`. Resolved on EVERY use, like token-store:
*   the service may register after this plugin mounts.
* @param {object} [options.env] - environment source; defaults to `process.env`.
* @returns {{save: Function, forget: Function, resolve: Function, state: Function}}
*/
function createApiKeyStore({ credentials = null, env = process.env } = {}) {
	/** Fallback vault for a Host that has no credentials service. */
	const memory = /* @__PURE__ */ new Map();
	const resolveService = () => {
		return (typeof credentials === "function" ? credentials() : credentials) ?? null;
	};
	return {
		/**
		* Persist a typed-in key as the `SENSENOVA_API_KEY` reference.
		*
		* The value is stored verbatim (no trim): like the console password,
		* trimming an invisible character is a change the user cannot see. A
		* whitespace-only value is still "nothing entered".
		* @param {string} apiKey - the key.
		* @returns {Promise<void>}
		*/
		async save(apiKey) {
			const value = verbatim(apiKey, "");
			if (typeof value !== "string" || value.trim() === "") throw new Error("an API key is required");
			const service = resolveService();
			if (service !== null && typeof service.set === "function") {
				await service.set(API_KEY_REF, value);
				memory.set(API_KEY_REF, value);
			} else memory.set(API_KEY_REF, value);
		},
		/**
		* Forget the stored key. The environment fallback is NOT touched: clearing
		* a panel-saved reference must not delete an operator's `.env` setting.
		* Both the service reference and the in-memory copy are cleared, so a key
		* saved on a Host without the service disappears too.
		* @returns {Promise<void>}
		*/
		async forget() {
			memory.delete(API_KEY_REF);
			try {
				const service = resolveService();
				if (service !== null && typeof service.unset === "function") await service.unset(API_KEY_REF);
			} catch {}
		},
		/**
		* Resolve the live key and where it came from.
		* @returns {Promise<{value: string, source: ("credentials"|"memory"|"env"|null)}>}
		*/
		async resolve() {
			try {
				const service = resolveService();
				if (service !== null && typeof service.resolve === "function") {
					const resolved = await service.resolve(API_KEY_REF).catch(() => void 0);
					const value = verbatim(resolved?.value, "");
					if (typeof value === "string" && value.trim() !== "") return {
						value,
						source: "credentials"
					};
				}
			} catch {}
			const held = memory.get(API_KEY_REF);
			if (typeof held === "string" && held.trim() !== "") return {
				value: held,
				source: "memory"
			};
			const fromEnv = verbatim(env[API_KEY_REF], "");
			if (typeof fromEnv === "string" && fromEnv.trim() !== "") return {
				value: fromEnv,
				source: "env"
			};
			return {
				value: "",
				source: null
			};
		},
		/**
		* The secret-free description the routes and panel report.
		*
		* `ephemeral` mirrors token-store: true when this Host has no credentials
		* service, so a key the panel saved would not survive a restart. A key read
		* from the environment is still reported with its real source.
		* @returns {Promise<{hasApiKey: boolean, keySource: string|null, ephemeral: boolean}>}
		*/
		async state() {
			const { source } = await this.resolve();
			return {
				hasApiKey: source !== null,
				keySource: source,
				ephemeral: resolveService() === null
			};
		}
	};
}

//#endregion
//#region src/host/raccoon-store.ts
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
/** The reference name the credential pair is stored under. */
const RACCOON_CREDENTIAL_REF = "RACCOON_CREDENTIAL";
/**
* Parse the stored credential JSON; a malformed or absent value reads as no
* credential rather than an error — the safe direction (one re-login, never a
* crash).
* @param {unknown} value - the reference value.
* @returns {object|null} `{ accessToken, refreshToken, expiresAtMs, officeIdentity, nickname }` or `null`.
*/
function parseRaccoonCredential(value) {
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
	const expiresAtMs = decodeRaccoonJwtExpMs(accessToken) ?? (typeof source.expires_at_ms === "number" ? source.expires_at_ms : void 0);
	return {
		accessToken,
		refreshToken: refresh,
		...expiresAtMs !== void 0 ? { expiresAtMs } : {},
		officeIdentity: str(source.office_identity, ""),
		nickname: str(source.nickname, "")
	};
}
/**
* Serialize one credential for storage.
* @param {object} credential - `{ accessToken, refreshToken?, expiresAtMs?, officeIdentity?, nickname? }`.
* @returns {string} the JSON document.
*/
function serializeRaccoonCredential(credential) {
	const source = obj(credential);
	const out = {
		version: 1,
		access_token: str(source.accessToken, ""),
		refresh_token: str(source.refreshToken, ""),
		...typeof source.expiresAtMs === "number" ? { expires_at_ms: source.expiresAtMs } : {},
		...str(source.officeIdentity, "") !== "" ? { office_identity: source.officeIdentity } : {},
		...str(source.nickname, "") !== "" ? { nickname: source.nickname } : {}
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
function createRaccoonStore({ credentials = null, fetcher } = {}) {
	/** Fallback vault for a Host that has no credentials service. */
	const memory = /* @__PURE__ */ new Map();
	/** Single-flight: a refresh already in flight is shared, never raced. */
	let refreshInFlight = null;
	const resolveService = () => {
		return (typeof credentials === "function" ? credentials() : credentials) ?? null;
	};
	const storeNow = async (credential) => {
		const serialized = serializeRaccoonCredential(credential);
		const service = resolveService();
		if (service !== null && typeof service.set === "function") {
			await service.set(RACCOON_CREDENTIAL_REF, serialized);
			memory.set(RACCOON_CREDENTIAL_REF, serialized);
		} else memory.set(RACCOON_CREDENTIAL_REF, serialized);
	};
	return {
		/**
		* Persist a freshly-logged-in credential pair.
		* @param {object} credential - `{ accessToken, refreshToken?, ... }`.
		*/
		async save(credential) {
			if (str(credential?.accessToken, "") === "") throw new Error("a Raccoon access token is required");
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
				if (service !== null && typeof service.unset === "function") await service.unset(RACCOON_CREDENTIAL_REF);
			} catch {}
		},
		/**
		* Resolve the live credential and where it came from.
		* @returns {Promise<{credential: object|null, source: ("credentials"|"memory"|null)}>}
		*/
		async resolve() {
			try {
				const service = resolveService();
				if (service !== null && typeof service.resolve === "function") {
					const credential = parseRaccoonCredential((await service.resolve(RACCOON_CREDENTIAL_REF).catch(() => void 0))?.value);
					if (credential !== null) return {
						credential,
						source: "credentials"
					};
				}
			} catch {}
			const held = parseRaccoonCredential(memory.get(RACCOON_CREDENTIAL_REF));
			if (held !== null) return {
				credential: held,
				source: "memory"
			};
			return {
				credential: null,
				source: null
			};
		},
		/**
		* Whether the stored credential is within its expiry window.
		* @param {number} [leadMs] - renew this long before expiry; defaults to 5 min.
		*/
		async isExpired(leadMs = 3e5) {
			const { credential } = await this.resolve();
			if (credential === null) return true;
			if (credential.expiresAtMs === void 0) return false;
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
			if (refreshInFlight === null) refreshInFlight = (async () => {
				try {
					const { credential } = await this.resolve();
					if (credential === null) return {
						ok: false,
						code: "not_configured"
					};
					const rotated = await refreshRaccoonCredential({ refresh_token: credential.refreshToken }, fetcher);
					if (!rotated.ok) return rotated;
					await storeNow({
						accessToken: rotated.accessToken,
						refreshToken: rotated.refreshToken,
						...rotated.expiresAtMs !== void 0 ? { expiresAtMs: rotated.expiresAtMs } : {},
						officeIdentity: credential.officeIdentity,
						nickname: credential.nickname
					});
					return { ok: true };
				} finally {
					refreshInFlight = null;
				}
			})();
			return refreshInFlight;
		},
		/**
		* The secret-free description the routes and panel report.
		* @returns {Promise<{hasCredential: boolean, source: ("credentials"|"memory"|null), ephemeral: boolean, nickname: string, expiresAtMs: number|null, refreshExpiresAtMs?: number}>}
		*/
		async state() {
			const { credential, source } = await this.resolve();
			const refreshExpiresAtMs = credential?.refreshToken !== void 0 && credential.refreshToken !== "" ? decodeRaccoonJwtExpMs(credential.refreshToken) : void 0;
			return {
				hasCredential: credential !== null,
				source,
				ephemeral: resolveService() === null,
				nickname: credential?.nickname ?? "",
				expiresAtMs: credential?.expiresAtMs ?? null,
				...refreshExpiresAtMs !== void 0 ? { refreshExpiresAtMs } : {}
			};
		}
	};
}

//#endregion
//#region src/host/raccoon-switch-store.ts
/**
* The Raccoon provider-registration switch — this plugin's OWN state file,
* kept separate from the Token Plan `provider-store.ts` because the two
* providers are opt-in independently (ROADMAP §6.1 "second upstream provider").
*
* Same integrity discipline as `provider-store.ts`: a versioned payload, a
* temp file plus an atomic rename, owner-only modes, and "anything
* unrecognised reads as not set" (PITFALLS §23, per-profile segment).
*
* @module dsh-connect-sensenova-token-plan/raccoon-switch-store
*/
/** Shape version, bumped when the persisted form changes incompatibly. */
const RACCOON_SWITCH_VERSION = 1;
/**
* The directory this switch lives in — per-profile when the Host names one.
* @param {string|null} [profile] - the profile name; `null` means shared.
* @returns {string} the directory.
*/
function raccoonSwitchDir(profile) {
	return profileStateDir(name, profile);
}
/**
* Normalize an on/off switch: only booleans are real answers.
* @param {unknown} raw - the persisted or posted value.
* @returns {boolean|null} `true`/`false`, or `null` when nothing usable.
*/
function normalizeRaccoonEnabled(raw) {
	return typeof raw === "boolean" ? raw : null;
}
/**
* Normalize the pushed-model list: `null`/absent means "no curation — push
* the whole roster"; an array keeps only non-empty strings, deduped. Any
* other shape reads as "not set" (the same anything-unrecognised-is-null
* discipline as the switch itself).
* @param {unknown} raw - the persisted or posted value.
* @returns {string[]|null} the curated ids, or `null` when the roster pushes whole.
*/
function normalizeRaccoonIds(raw) {
	if (!Array.isArray(raw)) return null;
	const seen = /* @__PURE__ */ new Set();
	for (const entry of raw) if (typeof entry === "string" && entry !== "") seen.add(entry);
	return [...seen];
}
/**
* The file-backed Raccoon provider switch.
* @param {object} [options]
* @param {string} [options.dir] - override the state directory (tests).
* @param {string|null} [options.profile] - the profile name; see {@link raccoonSwitchDir}.
* @param {number} [options.ttlMs] - reuse window for a parsed value.
* @returns {object} the store.
*/
function createFileRaccoonStore(options = {}) {
	const { dir, profile = null, ttlMs = STATE_READ_TTL_MS } = options;
	const stateDir$1 = dir ?? raccoonSwitchDir(profile);
	const filePath = join(stateDir$1, "raccoon-provider.json");
	const writePayload = async (body) => {
		const temporary = temporaryOf(stateDir$1, "raccoon-provider.json");
		await ensureStateDir(stateDir$1);
		await writeStateFile(filePath, JSON.stringify(body, null, 2), { temporary });
	};
	const legacyFile = dir === void 0 && profile ? join(stateDir(name), "raccoon-provider.json") : null;
	const parseSwitch = (raw) => {
		const source = obj(raw);
		if (source.version !== 1) return null;
		return {
			enabled: normalizeRaccoonEnabled(source.enabled),
			enabledModelIds: normalizeRaccoonIds(source.enabledModelIds)
		};
	};
	const cache = createStateReadCache(async () => parseSwitch(await readStateJson(filePath)), {
		ttlMs,
		inheritFrom: legacyFile === null ? null : {
			read: async () => parseSwitch(await readStateJson(legacyFile)),
			write: async (value) => {
				await writePayload({
					version: 1,
					enabled: value.enabled,
					...value.enabledModelIds !== null ? { enabledModelIds: value.enabledModelIds } : {},
					updatedAt: (/* @__PURE__ */ new Date()).toISOString()
				});
			}
		}
	});
	const read = () => cache.read();
	return {
		/** The saved switch value. */
		async enabled() {
			return (await read())?.enabled ?? null;
		},
		/** The saved pushed-model list; `null` = the whole roster pushes. */
		async enabledIds() {
			return (await read())?.enabledModelIds ?? null;
		},
		/** Whether the panel has ever saved a value here. */
		async isSet() {
			return await read() !== null;
		},
		/** Persist a switch value (atomic), preserving the saved id list. */
		async save(value) {
			const enabled = normalizeRaccoonEnabled(value);
			if (enabled === null) throw new TypeError("the raccoon switch expects a boolean");
			const current = (await read())?.enabledModelIds ?? null;
			await writePayload({
				version: 1,
				enabled,
				...current !== null ? { enabledModelIds: current } : {},
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			cache.remember({
				enabled,
				enabledModelIds: current
			});
		},
		/** Persist the pushed-model list (atomic), preserving the saved switch. */
		async saveIds(value) {
			const ids = normalizeRaccoonIds(value);
			if (ids === null) throw new TypeError("the raccoon id list expects an array of strings");
			const enabled = (await read())?.enabled ?? null;
			await writePayload({
				version: 1,
				...enabled !== null ? { enabled } : {},
				enabledModelIds: ids,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			cache.remember({
				enabled,
				enabledModelIds: ids
			});
		},
		/** Forget the panel-saved value. */
		async forget() {
			cache.remember(null);
			await writePayload({
				version: 1,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
		}
	};
}

//#endregion
//#region src/host/publish-core.ts
/**
* The shared bones of a provider publisher — the parts that MUST NOT differ
* between upstreams, factored out so they cannot drift.
*
* Both publishers (`provider-publish.ts` for the Token Plan provider,
* `raccoon-publish.ts` for the Raccoon one) run the same control plane: a
* publish queue, a `disposed` gate, and a single-point pair registration that
* doubles as the rollback path. Those three are load-bearing and pinned by
* tests (PITFALLS §18 for the queue, §19 for the register shape) — and the
* rollback is the worst place to discover a divergence, because it only runs
* once something has already failed. When they were written twice, keeping
* them in sync relied on comments in one file pointing at the other; here
* there is one copy.
*
* What is deliberately NOT shared: the publish GATE and the state shape. The
* Token Plan side decides from "switch on?" plus a persisted catalog and an
* allow-list, and restores `entries`/`enabledIds`/quota ids on a rollback; the
* Raccoon side decides from "switch on?" plus "is there a credential?" and
* restores its roster. That difference is real domain difference, and folding
* it into one parameterized state machine would make a publish unreadable —
* every reader would have to read the configuration to know what one does.
*
* Peer-free: touches no runtime peer.
*
* @module dsh-connect-sensenova-token-plan/publish-core
*/
/** The event a successful (re)registration emits so readers refresh. */
const ADAPTERS_UPDATED_EVENT = "llm/adapters-updated";
/** The error a publisher reports when the Host exposes no `llm` service. */
const NO_LLM_SERVICE_ERROR = "the Host exposes no llm registration service";
/** The shape check message both publishers raise on a bad factory result. */
const BAD_FACTORY_SHAPE_ERROR = "the adapter factory did not return { adapter, providerIds }";
/**
* A publish queue: every publish runs after all the ones in flight.
*
* Concurrent publishes are not hypothetical — a mount seed can still be
* mid-flight when the first panel poll publishes the catalog it just fetched,
* and a switch flip or a logout can land on top of either. Two publishes
* interleaving means the SLOWER one wins: it releases the pair the faster one
* registered and then registers its own, so the Host serves a stale (possibly
* empty) set while the snapshot reports the fresh one (PITFALLS §18).
*
* The chain is the same shape `token-store.ts` uses for `getToken`: no lock
* object, and a rejected link never poisons the ones behind it.
* @returns {{
*   enqueue: (task: () => Promise<unknown>) => Promise<unknown>,
*   isDisposed: () => boolean,
*   dispose: () => void
* }}
*/
function createPublishQueue() {
	let publishChain = Promise.resolve();
	let disposed = false;
	return {
		/**
		* Queue `task` behind everything in flight and resolve with its result.
		* @param {() => Promise<unknown>} task - the publish to run, in turn.
		* @returns {Promise<unknown>} the task's own settled value.
		*/
		enqueue(task) {
			const queued = publishChain.then(task, task);
			publishChain = queued.then(() => void 0, () => void 0);
			return queued;
		},
		/**
		* Whether the publisher has been disposed. A publish that arrives after
		* dispose registers a provider into a Host that has already withdrawn the
		* plugin: no owner, no release, nothing on screen.
		* @returns {boolean}
		*/
		isDisposed: () => disposed,
		/** Mark the publisher disposed; every later publish becomes a no-op. */
		dispose() {
			disposed = true;
		}
	};
}
/**
* Build the releaser for one publisher's `state`.
*
* Releases are idempotent in the Host, and a release that throws must not
* abort the one behind it — during shutdown or a rollback the service may
* already be gone.
* @param {object} state - the publisher state holding the release functions.
* @returns {() => void} release, safe to call any number of times.
*/
function createPairReleaser(state) {
	return () => {
		const releaseFn = (fn) => {
			try {
				fn?.();
			} catch {}
		};
		releaseFn(state.releaseAdapter);
		releaseFn(state.releaseDirectory);
		state.releaseAdapter = null;
		state.releaseDirectory = null;
	};
}
/**
* Hand one built adapter to the `llm` service and record its release
* functions onto `target`.
*
* Defined ONCE because the publish path and the rollback path both register a
* pair, and two copies drift: a change to the directory row made in one place
* and not the other leaves the ROLLBACK registering a provider the publish
* path would never have built — and a rollback only runs once something has
* already gone wrong, which is the worst possible moment to find out
* (PITFALLS §19).
*
* The releases are written straight onto `target` rather than returned: if the
* directory call throws AFTER the adapter was registered, the adapter's
* release must still be reachable, or `release()` cannot undo it and the
* adapter outlives the plugin.
* @param {object} llm - the registration service.
* @param {{providerIds: string[], adapter: unknown}} built - what to register.
* @param {object} target - where the release functions are recorded.
* @param {object} identity - the provider's row on the models settings page.
* @param {string} identity.providerId
* @param {string} identity.displayName
* @returns {void}
*/
function registerProviderPair(llm, built, target, { providerId, displayName }) {
	target.releaseAdapter = llm.registerAdapter(built.providerIds, built.adapter);
	target.releaseDirectory = typeof llm.registerConfigurableProviders === "function" ? llm.registerConfigurableProviders([{
		provider: providerId,
		displayName,
		settingsNs: name,
		settingsPath: [],
		declared: false
	}]) : null;
}
/**
* Memoize the peer-dependent adapter factory for one publisher.
*
* The module is loaded once and the factory is read off it once, so a Host
* whose peers resolve slowly pays that cost one time, not per publish.
* @param {() => Promise<object>} loadModule - resolves the adapter module.
* @param {string} exportName - the factory export to read off the module.
* @returns {() => Promise<Function>} the memoized factory resolver.
*/
function createAdapterFactoryResolver(loadModule, exportName) {
	let adapterFactoryPromise;
	return async () => {
		if (adapterFactoryPromise === void 0) adapterFactoryPromise = Promise.resolve(loadModule()).then((mod) => mod?.[exportName]);
		return adapterFactoryPromise;
	};
}
/**
* Verify a built adapter is really one before it is registered Host-wide.
*
* An adapter is registered Host-wide, so a factory that returns anything else
* must fail here rather than publish a provider that cannot serve a request.
* @param {unknown} built - what the factory returned.
* @returns {boolean} whether it is `{ adapter, providerIds }`.
*/
function isBuiltAdapter(built) {
	return built !== null && typeof built === "object" && Array.isArray(built.providerIds) && built.adapter !== void 0;
}
/**
* Turn a build failure into a secret-free note plus a hint.
*
* A credential never reaches the panel or a log. The failure a reader cannot
* diagnose from the message alone: the llm peer packages ship INSIDE the Host,
* so a plugin directory the Host's node_modules cannot be reached from — a dev
* checkout symlinked into the profile, say — has no way to import them. Say
* so, with the remedy, because the panel can only report "provider absent".
* @param {unknown} error - the thrown value (may not be an Error at all).
* @returns {{note: string, hint: string, error: unknown}} the redacted message,
*   the optional remedy suffix, and the original value for re-raising.
*/
function describeBuildFailure(error) {
	const annotated = error;
	const why = errMsg(error);
	return {
		note: redactSecrets(why),
		hint: annotated?.code === "ERR_MODULE_NOT_FOUND" ? " — the llm peer packages ship with the Host; install this plugin where they resolve (or link them into its own node_modules)" : "",
		error
	};
}
/**
* Log one build failure the way both publishers log it.
* @param {object} [logger] - `ctx.logger`.
* @param {string} label - the upstream's name for the message ("SenseNova").
* @param {{note: string, hint: string}} described - from `describeBuildFailure`.
* @returns {void}
*/
function warnBuildFailure(logger, label, described) {
	logger?.warn?.(`${name}: cannot build the ${label} adapter: ${described.note}${described.hint}`);
}
/**
* Resolve the `llm` registration service, or bail out with the pair released.
*
* Both upstreams answer the same question the same way, and the answer is a
* fact about the Host — not about the provider — so it is one copy: a Host
* with no `llm` service gets no registration and a stated reason, never a
* half-built one.
* @param {object} job
* @param {object} job.state - the publisher state.
* @param {(service: string) => object|null} job.getLlm - the service resolver.
* @param {() => void} job.release - the publisher's releaser.
* @returns {object|null} the service, or null when it cannot register.
*/
function resolveRegistrationService({ state, getLlm, release }) {
	const llm = getLlm("llm");
	state.llmAvailable = llm !== null && typeof llm.registerAdapter === "function";
	if (!state.llmAvailable) {
		release();
		state.registered = false;
		state.error = NO_LLM_SERVICE_ERROR;
		return null;
	}
	return llm;
}
/**
* Take the registration down and record why it is gone.
*
* `state.built` is cleared along with it, and that matters: a stale `built`
* survives into the NEXT publish as its rollback target, so a later failed
* publish would re-register an adapter whose release has already been called.
* (The Raccoon publisher's "no credential" branch used to leave it standing.)
* @param {object} job
* @param {object} job.state - the publisher state.
* @param {() => void} job.release - the publisher's releaser.
* @param {string|null} [job.error] - why nothing is registered; null when the
*   absence is the wanted state (switch off).
* @returns {{ok: boolean, skipped: boolean}} the publish outcome.
*/
function unregister({ state, release, error = null }) {
	release();
	state.registered = false;
	state.built = null;
	state.error = error;
	return {
		ok: true,
		skipped: true
	};
}
/**
* Swap the registered pair: take down the old one, register the new one, and
* restore the OLD one if the new registration throws.
*
* This is the other half of PITFALLS §19, and the reason it is shared: the
* rollback is the path that only runs once something has already gone wrong.
* A registration that fails AFTER the old pair was released must put the
* previous one back, or a bad publish takes down models that were already
* serving. Written twice, the two copies drift; written once, a fix to the
* rollback reaches both upstreams.
*
* @param {object} job
* @param {object} job.llm - the registration service.
* @param {{providerIds: string[], adapter: unknown}} job.built - the new pair.
* @param {unknown} job.previousBuilt - the pair that was serving, or null.
* @param {object} job.state - the publisher state to record onto.
* @param {() => void} job.release - the publisher's releaser.
* @param {(llm: object, built: object, target: object) => void} job.registerPair -
*   the single-point registrar.
* @param {(event: string) => void | undefined} job.emit - the Host's raw
*   `ctx.emit`, if it has one. Optional so the absent case is handled once, in
*   {@link emitAdaptersUpdated}, rather than by every call site inventing a
*   no-op stand-in before it gets there.
* @param {() => void} [job.onRollback] - restore the domain snapshot fields
*   (`entries`/`enabledIds`, or the roster) to what is really serving.
* @returns {{ok: boolean, error?: unknown}} the publish outcome.
*/
function swapRegistration({ llm, built, previousBuilt, state, release, registerPair, emit, onRollback }) {
	release();
	try {
		registerPair(llm, built, state);
	} catch (error) {
		release();
		state.built = null;
		onRollback?.();
		state.error = redactSecrets(errMsg(error));
		if (previousBuilt !== null) try {
			registerPair(llm, previousBuilt, state);
			state.built = previousBuilt;
			state.registered = true;
		} catch {
			state.built = null;
			state.registered = false;
		}
		else state.registered = false;
		return {
			ok: false,
			error
		};
	}
	state.built = built;
	state.registered = true;
	state.error = null;
	emitAdaptersUpdated(emit);
	return { ok: true };
}
/**
* Emit the adapter-update event, tolerating a Host that has no `emit` and a
* Host whose `emit` refuses.
*
* This is the ONE place the emit path is defended, and it absorbs both halves
* of what used to be three layers. The assembly point (`index.ts`) used to wrap
* `ctx.emit` in its own `try { ctx.emit?.(event) } catch {}`, and each
* publisher then defaulted a missing `emit` to a no-op
* (`emit ?? (() => {})`) before handing it here — where a third `try/catch`
* waited. The middle layer could never do anything: the layer above it had
* already swallowed every throw, so the no-op fallback was unreachable except
* for a literal `undefined`, which the outer `?.` had already covered too.
*
* @param {((event: string) => void) | undefined} emit - the Host's raw
*   `ctx.emit`, or `undefined` on a Host that has none.
* @returns {void}
*/
function emitAdaptersUpdated(emit) {
	try {
		emit?.(ADAPTERS_UPDATED_EVENT);
	} catch {}
}

//#endregion
//#region src/host/raccoon-publish.ts
/**
* The Raccoon provider's PUBLISH STATE MACHINE — the peer-free control plane
* of the "second upstream provider" (ROADMAP §6.1).
*
* Deliberate BOUNDARY: this is a SECOND, independent publisher. It shares
* NONE of the Token Plan publisher's state (`provider-publish.ts`), so a flip
* of the Raccoon switch, a Raccoon login/logout, or a Raccoon catalogue drift
* can never register, release, or churn the Token Plan provider — the "MUST
* NOT touch Token Plan pool semantics" line of §6.1. It carries the same three
* load-bearing semantics, restated:
*   - the publish chain queues a publish behind every one in flight;
*   - the `disposed` gate stops a late publish registering into a withdrawn
*     Host;
*   - the single-point `registerPair` (factory-await + shape check, PITFALLS
*     §19) serves both the publish and the rollback path.
*
* The difference that shapes the publish: Raccoon has NO persisted catalog
* file and NO per-model quota exhaustion, so a publish is driven by exactly
* two facts — "is the switch on?" and "is there a credential?" — and its
* model set is the live (or fallback) roster. The offered-set signature is
* the roster ids, so a catalogue drift that changes ids triggers a rebuild.
*
* Peer-free: the adapter factory is injected (`loadAdapterModule`, defaulting
* to `import("./raccoon-llm-adapter.ts")`), so the offline suites substitute a
* fake factory without touching the Host's node_modules.
*
* @module dsh-connect-sensenova-token-plan/raccoon-publish
*/
/**
* The Raccoon provider publisher.
*
* @param {object} [deps]
* @param {() => Promise<boolean|null>} [deps.panelSwitch] - the panel-saved
*   value (`raccoon-switch-store.enabled()`); `null` when the state file is
*   untouched (in which case the provider stays off — opt-in default OFF).
* @param {() => Promise<string>} [deps.resolveToken] - resolves the live
*   Raccoon JWT per request (`raccoon-store` seam); empty when not logged in.
* @param {(service: string) => object|null} [deps.getLlm] - optional-service
*   resolver for the `llm` registration service.
* @param {() => Promise<{createRaccoonAdapter: Function}>} [deps.loadAdapterModule] -
*   the peer-dependent adapter factory module; defaults to the real
*   `raccoon-llm-adapter.ts`.
* @param {(event: string) => void} [deps.emit] - `ctx.emit` for the adapter
*   update event.
* @param {object} [deps.logger] - `ctx.logger` for the build-failure warning.
* @returns {{
*   state: object,
*   publish: (rows: object[], officeIdentity?: string) => Promise<object>,
*   release: () => void,
*   dispose: () => void,
*   isDisposed: () => boolean
* }}
*/
function createRaccoonPublisher(deps = {}) {
	const { panelSwitch, resolveToken, getLlm, loadAdapterModule, emit, logger } = deps;
	const effectivePanelSwitch = panelSwitch ?? (async () => null);
	const effectiveResolveToken = resolveToken ?? (async () => "");
	const effectiveLoadAdapterModule = loadAdapterModule ?? (() => import("./raccoon-llm-adapter-Be9DTZNM.js"));
	const effectiveGetLlm = getLlm ?? (() => null);
	const effectiveLogger = logger ?? { warn: () => {} };
	/** The live Raccoon registration state. */
	const state = {
		/** The roster the current registration was built from. */
		rows: [],
		/** A cheap signature of the offered roster (ids + vision bits). */
		signature: "",
		/** Whether an `llm` service answering `registerAdapter` is present. */
		llmAvailable: false,
		/** Whether the Raccoon provider pair is registered without error. */
		registered: false,
		/** The last registration error, surfaced secret-free in the snapshot. */
		error: null,
		releaseAdapter: null,
		releaseDirectory: null,
		/** The built adapter the active release functions belong to. */
		built: null
	};
	/**
	* The publish queue and the `disposed` gate — shared with the Token Plan
	* publisher (`publish-core.ts`), so the two cannot drift apart.
	*/
	const queue = createPublishQueue();
	/** Resolve the peer-dependent adapter factory once and memoize it. */
	const resolveAdapterFactory = createAdapterFactoryResolver(effectiveLoadAdapterModule, "createRaccoonAdapter");
	/** Release the registered pair. Releases are idempotent in the Host. */
	const release = createPairReleaser(state);
	/**
	* Hand one built adapter to the llm service and record its release
	* functions onto `target` — the shared single-point registrar (PITFALLS
	* §19), used by both the publish and the rollback path.
	*/
	const registerPair = (llm, built, target) => registerProviderPair(llm, built, target, {
		providerId: RACCOON_PROVIDER_ID,
		displayName: RACCOON_DISPLAY_NAME
	});
	/**
	* (Re)build and register the Raccoon provider for one roster snapshot.
	*
	* The publish decision is a three-way gate:
	*   - switch OFF            → release, no registration (opt-in default);
	*   - switch ON, no token   → release, `error: not_configured` (the panel's
	*                             "登录" affordance says so);
	*   - switch ON, token      → build + register the roster.
	* On a failed registration the PREVIOUS pair is restored.
	* @param {object[]} rows - the roster rows (`raccoonRoster`).
	* @param {string} [officeIdentity] - the credential's office identity.
	* @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
	*/
	const publishProviderOnce = async (rows, officeIdentity = "") => {
		if (queue.isDisposed()) return {
			ok: false,
			skipped: true
		};
		const previousBuilt = state.built;
		const previousRows = state.rows;
		state.rows = Array.isArray(rows) ? rows : [];
		state.signature = raccoonSignature(state.rows);
		if (!(await effectivePanelSwitch().catch(() => null) === true)) return unregister({
			state,
			release
		});
		const llm = resolveRegistrationService({
			state,
			getLlm: effectiveGetLlm,
			release
		});
		if (llm === null) return {
			ok: false,
			error: state.error
		};
		const token = await effectiveResolveToken().catch(() => "");
		if (token === null || token === "") return unregister({
			state,
			release,
			error: "not_configured"
		});
		let createRaccoonAdapter;
		let built;
		try {
			createRaccoonAdapter = await resolveAdapterFactory();
			if (createRaccoonAdapter === void 0) throw new Error(BAD_FACTORY_SHAPE_ERROR);
			built = await createRaccoonAdapter({
				rows: state.rows,
				officeIdentity,
				resolveToken: effectiveResolveToken,
				get: effectiveGetLlm
			});
			if (!isBuiltAdapter(built)) throw new Error(BAD_FACTORY_SHAPE_ERROR);
		} catch (e) {
			const described = describeBuildFailure(e);
			state.error = described.note;
			warnBuildFailure(effectiveLogger, "Raccoon", described);
			return {
				ok: false,
				error: described.error
			};
		}
		return swapRegistration({
			llm,
			built,
			previousBuilt,
			state,
			release,
			registerPair,
			emit,
			onRollback: () => {
				state.rows = previousRows;
			}
		});
	};
	/** Publish, queued behind every other in-flight publish. */
	const publish = (rows, officeIdentity) => queue.enqueue(() => publishProviderOnce(rows, officeIdentity ?? ""));
	/** Mark the publisher disposed: any later publish is a no-op. */
	const dispose = () => queue.dispose();
	return {
		state,
		publish,
		release,
		dispose,
		isDisposed: () => queue.isDisposed()
	};
}
/**
* A cheap signature of the Raccoon offered roster: the model ids, each tagged
* with the vision bit — an id whose modality flipped must rebuild even though
* the id list did not change.
* @param {object[]} rows - the `raccoonRoster` result.
* @returns {string}
*/
function raccoonSignature(rows) {
	return (Array.isArray(rows) ? rows : []).map((row) => `${str(row?.id, "")}:${row?.vision === true ? 1 : 0}`).join(",");
}

//#endregion
//#region src/host/switch-precedence.ts
/**
* The single adjudicator for "panel-saved value vs config default" across
* every opt-in switch.
*
* Historically the rule was hand-copied at three call sites (the provider
* route, the models route, the draw route) in two look-alike dialects:
*
*   - the boolean switch: `(panel ?? config) === true` plus
*     `panel === null ? "config" : "panel"`;
*   - the model preference: `panel ?? config` plus the same source probe.
*
* A fourth dialect existed where no config default exists at all (the Raccoon
* switch — a profile without a saved value falls to `off` with no fallback),
* which is exactly the shape this module does NOT serve: that one has no
* config default to adjudicate against, so it is the caller's plain read.
*
* This module is peer-free and deliberately tiny: the whole point is that a
* switch can never again invent its own precedence dialect, and the source
* label (`panel` / `config`) always rides with the answer so the panel can
* say which side is in charge. `test/switch-precedence.test.mjs` pins the
* dialect so a new caller copying the shape is the odd one out.
*
* @module dsh-connect-sensenova-token-plan/switch-precedence
*/
/**
* Resolve the effective boolean switch: a panel-saved value always wins,
* otherwise the config default rules.
* @param {boolean|null} panel - the panel-saved value (`null` = never saved).
* @param {boolean} config - the patch-declared default.
* @returns {boolean} the effective switch.
*/
function resolveSwitchEnabled(panel, config) {
	return (panel ?? config) === true;
}
/**
* Resolve the effective string preference (e.g. a draw-model id): a
* panel-saved value wins, otherwise the config default rules.
* @param {string|null} panel - the panel-saved value (`null` = never saved).
* @param {string|undefined} config - the patch-declared default.
* @returns {string|undefined} the effective preference.
*/
function resolveSwitchValue(panel, config) {
	return panel ?? config;
}
/**
* Where the effective value came from — the panel when it saved one, the
* config otherwise. Rides with every resolved answer so the panel can name
* the side in charge.
* @param {boolean|string|null} panel - the panel-saved value.
* @returns {"panel"|"config"}
*/
function switchSource(panel) {
	return panel === null ? "config" : "panel";
}

//#endregion
//#region src/host/provider-publish.ts
/**
* The directly-registered provider's PUBLISH STATE MACHINE — the peer-free
* control-plane half of step three ("one-stop service").
*
* Three load-bearing semantics, each pinned by a test that must keep running:
*   - the publish chain queues a publish behind every one in flight, so a slow
*     publish can never be overwritten by a fast one (PITFALLS §18);
*   - the `disposed` gate stops a publish arriving after dispose from
*     registering into a Host that has withdrawn the plugin;
*   - the single-point `registerPair` (with its factory-await + shape check,
*     PITFALLS §19) is used by both the publish and the rollback path.
*
* Peer-free: imports no runtime peer. The adapter factory is injected by the
* caller (`loadAdapterModule`, defaulting to `import("./llm-adapter.ts")`),
* so the offline suites can substitute a fake factory without touching the
* Host's node_modules.
*
* 跨切面行为指路：catalog 变化 / switch 翻转 / Key 清除 → 重注册 = `index.ts` seed poll + provider route handler + `publishProvider` 调用链。
* 看到"为什么 catalog 一小时缓存"的疑问，先读 `ARCHITECTURE.md` §5.2 的快照去抖与 `catalog-store.ts` 头注。
*
* @module dsh-connect-sensenova-token-plan/provider-publish
*/
/**
* The provider publisher.
*
* Holds the live registration state (`state`); the publish queue, the
* `disposed` gate and the single-point `registerPair` are the shared
* `publish-core.ts` bones. The caller drives `publish` from the mount seed, the
* catalog poll, the provider switch, the roster save and the api-key forget;
* it calls `dispose` from the `ctx.effect` teardown.
*
* The `getLlm` resolver is a FUNCTION, not a snapshot, because the `llm`
* service may register with the Host after this plugin mounts — the same
* resolver-not-snapshot pattern used for `credentials`.
*
* @param {object} [deps]
* @param {object} [deps.settings] - the resolved settings row (reads `registerProvider` and `apiBase` only).
* @param {() => Promise<boolean|null>} [deps.panelSwitch] - the panel-saved value
*   (`provider-store.enabled()`); null when the state file is untouched.
* @param {() => Promise<{createSensenovaAdapter: Function}>} [deps.loadAdapterModule] - the
*   peer-dependent adapter factory module; defaults to the real `llm-adapter.ts`.
* @param {(service: string) => object|null} [deps.getLlm] - optional-service
*   resolver for the `llm` registration service.
* @param {() => Promise<string>} [deps.resolveApiKey] - resolves the live `sk-`
*   key per request (the `api-key-store.ts` seam). The adapter factory reads
*   it, so it must be a real resolver, never a snapshot.
* @param {(event: string) => void} [deps.emit] - `ctx.emit` for the adapter
*   update event.
* @param {object} [deps.logger] - `ctx.logger` for the build-failure warning.
* @returns {{
*   state: {entries, enabledIds, unavailableIds, signature, quotaSignature,
*           llmAvailable, registered, error, built, releaseAdapter,
*           releaseDirectory},
*   publish: (entries: object[], enabledIds: string[],
*             unavailableModelIds?: string[]) => Promise<object>,
*   release: () => void,
*   dispose: () => void,
*   isDisposed: () => boolean
* }}
*/
function createProviderPublisher(deps = {}) {
	const { settings, panelSwitch, loadAdapterModule, getLlm, resolveApiKey, emit, logger } = deps;
	const effectiveSettings = settings ?? {};
	const effectivePanelSwitch = panelSwitch ?? (async () => null);
	const effectiveLoadAdapterModule = loadAdapterModule ?? (() => import("./llm-adapter-17gZQlIS.js"));
	const effectiveGetLlm = getLlm ?? (() => null);
	const effectiveResolveApiKey = resolveApiKey ?? (async () => "");
	const effectiveLogger = logger ?? { warn: () => {} };
	/**
	* The live registration state. A plain object the caller reads as `state`
	* (the snapshot's `llm` block pulls `registered` / `error` off it). The
	* release functions live here rather than being returned, because a
	* registration that throws AFTER the adapter was registered must still
	* be reachable, or the adapter outlives the plugin (see `registerPair`).
	*/
	const state = {
		/** The catalog entries the current registration was built from. */
		entries: [],
		/** The curated allow-list at registration time (empty = all models). */
		enabledIds: [],
		/** The last quota-exhausted model ids published to the picker. */
		unavailableIds: [],
		/** A cheap signature of the offered set (catalog ids + vision bits + allow-list). */
		signature: "",
		/** A cheap signature of the quota-exhausted set; flips when a pool crosses zero. */
		quotaSignature: "",
		/** Whether an `llm` service answering `registerAdapter` is present. */
		llmAvailable: false,
		/** Whether our provider pair is currently registered without error. */
		registered: false,
		/** The last registration error, surfaced secret-free in the snapshot. */
		error: null,
		releaseAdapter: null,
		releaseDirectory: null,
		/** The built adapter the active release functions belong to. */
		built: null
	};
	/**
	* The publish queue and the `disposed` gate — the first two of the three
	* load-bearing semantics. Both live in `publish-core.ts` now, so the
	* Raccoon publisher's copy cannot drift from this one.
	*/
	const queue = createPublishQueue();
	/** Resolve the peer-dependent adapter factory once and memoize it. */
	const resolveAdapterFactory = createAdapterFactoryResolver(effectiveLoadAdapterModule, "createSensenovaAdapter");
	/** Release the registered pair. Releases are idempotent in the Host. */
	const release = createPairReleaser(state);
	/**
	* Hand one built adapter to the llm service and record its release
	* functions onto `target`.
	*
	* The body is the shared `registerProviderPair` (PITFALLS §19) — one copy
	* for both publishers and both paths; this wrapper only supplies which
	* provider the row is for.
	* @param {object} llm - the registration service.
	* @param {{providerIds: string[], adapter: unknown}} built - what to register.
	* @param {object} target - where the release functions are recorded (`state`).
	* @returns {void}
	*/
	const registerPair = (llm, built, target) => registerProviderPair(llm, built, target, {
		providerId: LLM_PROVIDER_ID,
		displayName: LLM_DISPLAY_NAME
	});
	/**
	* (Re)build and register the provider for one catalog/allow-list snapshot.
	*
	* Rebuild-and-reregister rather than mutate: `PiAiAdapter` memoizes its
	* profiles snapshot internally, so only a fresh registration can change the
	* offered model list. On a failed registration the PREVIOUS pair is
	* restored, so a bad publish can never take down models that were already
	* serving.
	* @param {object[]} entries - the normalized catalog entries.
	* @param {string[]} enabledIds - the curated allow-list (empty = all).
	* @param {string[]} [unavailableModelIds] - quota-exhausted model ids to
	*   drop from the picker's offer.
	* @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
	*/
	const publishProviderOnce = async (entries, enabledIds, unavailableModelIds = []) => {
		if (queue.isDisposed()) return {
			ok: false,
			skipped: true
		};
		const previousBuilt = state.built;
		const previousEntries = state.entries;
		const previousEnabledIds = state.enabledIds;
		const previousUnavailable = state.unavailableIds;
		state.entries = Array.isArray(entries) ? entries : [];
		state.enabledIds = Array.isArray(enabledIds) ? enabledIds : [];
		state.unavailableIds = Array.isArray(unavailableModelIds) ? unavailableModelIds : [];
		const panelValue = await effectivePanelSwitch().catch(() => null);
		if (!resolveSwitchEnabled(panelValue, effectiveSettings.registerProvider)) return unregister({
			state,
			release
		});
		const llm = resolveRegistrationService({
			state,
			getLlm: effectiveGetLlm,
			release
		});
		if (llm === null) return {
			ok: false,
			error: state.error
		};
		let createSensenovaAdapter;
		let built;
		try {
			createSensenovaAdapter = await resolveAdapterFactory();
			if (createSensenovaAdapter === void 0) throw new Error(BAD_FACTORY_SHAPE_ERROR);
			built = await createSensenovaAdapter({
				entries: state.entries,
				enabledIds: state.enabledIds,
				baseUrl: effectiveSettings.apiBase,
				resolveApiKey: effectiveResolveApiKey,
				get: effectiveGetLlm,
				unavailableModelIds: state.unavailableIds
			});
			if (!isBuiltAdapter(built)) throw new Error(BAD_FACTORY_SHAPE_ERROR);
		} catch (e) {
			const described = describeBuildFailure(e);
			state.error = described.note;
			warnBuildFailure(effectiveLogger, "SenseNova", described);
			return {
				ok: false,
				error: described.error
			};
		}
		return swapRegistration({
			llm,
			built,
			previousBuilt,
			state,
			release,
			registerPair,
			emit,
			onRollback: () => {
				state.entries = previousEntries;
				state.enabledIds = previousEnabledIds;
				state.unavailableIds = previousUnavailable;
			}
		});
	};
	/**
	* Publish, queued behind every other publish in flight.
	*
	* The wrapper exists so no caller has to remember the queue: the mount seed,
	* a catalog poll, an api-key forget and a provider switch all reach the same
	* critical section, and any one of them racing another is the bug above.
	* @param {object[]} entries - the normalized catalog entries.
	* @param {string[]} enabledIds - the curated allow-list (empty = all).
	* @param {string[]} [unavailableModelIds] - quota-exhausted model ids.
	* @returns {Promise<{ok: boolean, skipped?: boolean, error?: unknown}>}
	*/
	const publish = (entries, enabledIds, unavailableModelIds = []) => queue.enqueue(() => publishProviderOnce(entries, enabledIds, unavailableModelIds));
	/**
	* Mark the publisher as disposed: any in-flight or later publish becomes a
	* no-op that cannot register into a withdrawn Host.
	*/
	const dispose = () => queue.dispose();
	return {
		state,
		publish,
		release,
		dispose,
		isDisposed: () => queue.isDisposed()
	};
}
/**
* Seed the registration from the persisted catalog so a restarted Host offers
* models before its first poll (and with no console login at all).
*
* Fire-and-forget: a state dir that cannot be read just waits for the poll.
* @param {Pick<ReturnType<typeof createProviderPublisher>, "state" | "publish">} publisher
*   — the only two members the seed touches. Typed off the REAL publisher
*   rather than a hand-written structural copy: that copy declared the third
*   `publish` parameter as `unknown`, which is WIDER than the `string[]` the
*   publisher actually accepts, so under `strictFunctionTypes` the genuine
*   publisher was not assignable to it. `lifecycle.ts` passing `wiring: any`
*   is the only reason this never surfaced — tightening that annotation
*   exposed it. The seed only ever passes a literal `[]` (below), so the
*   narrower type is a zero-runtime-change correction.
* @param {() => Promise<object[]>} listCatalog - read the persisted catalog entries.
* @param {() => Promise<string[]>} listEnabled - read the persisted allow-list.
* @param {(entries: object[], enabledIds: string[]) => string} signatureOf -
*   the cheap offered-set signature.
*/
function seedPublisherFromCatalog(publisher, listCatalog, listEnabled, signatureOf) {
	return (async () => {
		try {
			const [stored, storedEnabled] = await Promise.all([listCatalog(), listEnabled()]);
			publisher.state.signature = signatureOf(stored, storedEnabled);
			await publisher.publish(stored, storedEnabled, []);
		} catch {}
	})();
}
/**
* A cheap signature of the model set a provider registration would offer.
*
* It only has to answer "would rebuilding change anything?": the model ids in
* catalog order, each tagged with the SAME vision decision the descriptors
* use (an id whose modality flipped must rebuild even though the id list did
* not change), plus the curated allow-list. Anything else changing in a
* catalog entry does not affect the registered offer.
* @param {object[]} entries - the normalized catalog entries.
* @param {string[]} enabledIds - the allow-list (empty = all).
* @returns {string}
*/
function catalogSignature(entries, enabledIds) {
	return `${(Array.isArray(entries) ? entries : []).map((entry) => `${str(entry?.id, "")}:${identifyVisionModel(entry).vision === true ? 1 : 0}`).join(",")}|${(Array.isArray(enabledIds) ? enabledIds : []).join(",")}`;
}
/**
* Recompute the state's `signature` and `quotaSignature` from the offer the
* publisher just published. Call it after every direct `publishProvider` that
* bypasses the poll's change-detection in `snapshot-aggregate`: those two
* fields are the poll's "did the offer change?" signal, so they must track what
* was actually offered or the next poll needlessly churns (rebuilds) the
* registration. The formulas here are the SAME ones the poll uses, so the two
* can never drift apart. Only meaningful after a successful publish — on a
* failed one the caller's rollback already restored the previous fields.
* @param {{entries: object[], enabledIds: string[], unavailableIds: string[],
*          signature: string, quotaSignature: string}} state - `publisher.state`.
*/
function syncSignaturesAfterPublish(state) {
	const entries = Array.isArray(state.entries) ? state.entries : [];
	const enabledIds = Array.isArray(state.enabledIds) ? state.enabledIds : [];
	const unavailable = Array.isArray(state.unavailableIds) ? state.unavailableIds : [];
	state.signature = catalogSignature(entries, enabledIds);
	state.quotaSignature = [...unavailable].sort().join(",");
}

//#endregion
//#region src/host/coalesced-fetch.ts
/**
* One coalescing read-through cache: a TTL cache plus ONE in-flight promise
* per key.
*
* Two properties every caller needs, and that are easy to get wrong when each
* fetch re-implements them by hand (as `console-client.ts` once did twice):
*
*   1. **Single flight** — N concurrent readers of one key share ONE upstream
*      call. Without it, every open panel (or tab) polling at once issues its
*      own request, which is how a Host walks into the platform's own rate
*      limiter.
*   2. **Read-through TTL** — a fresh answer is served from memory; a stale one
*      is refetched.
*
* A REJECTED producer is shared but never cached: a failure is not an answer,
* and caching one would pin an error on the panel for a whole TTL after a
* single transient hiccup. Sharing the rejection is still correct — the callers
* asked for the same thing at the same time and get the same outcome.
*
* The maps are injectable so a caller can share one cache across modules (the
* console route's `cache`/`inflight` pair is created in `index.ts` and cleared
* wholesale when the account or key changes).
*
* @module dsh-connect-sensenova-token-plan/coalesced-fetch
*/
/**
* The longest TTL any caller may use; entries older than this are swept so the
* map cannot grow without bound when keys are per-credential and credentials
* rotate.
*/
const MAX_CACHE_AGE_MS = 36e5;
/**
* The generation state for one shared cache map.
*
* Keyed by the cache MAP rather than held per instance, and that is load
* bearing: a caller may construct a fresh `createCoalescedFetch` on every
* request while injecting one long-lived shared map (which is exactly what
* `console-client.ts` does, over the `cache`/`inflight` pair created in
* `index.ts`). Per-instance counters would reset to 0 on every call, so a
* `clear()` bump would be invisible to the very next read and a pre-clear
* flight's answer would be served to the account that just signed in.
* Hanging the counters off the map makes every instance over that map share
* one generation state, so the guard holds no matter how the caller builds it.
*/
const GENERATIONS = /* @__PURE__ */ new WeakMap();
/** The (created-on-demand) generation state belonging to one cache map. */
function generationsOf(cache) {
	let state = GENERATIONS.get(cache);
	if (state === void 0) {
		state = {
			global: 0,
			keys: /* @__PURE__ */ new Map()
		};
		GENERATIONS.set(cache, state);
	}
	return state;
}
/**
* Drop one key's cached answer, or the whole cache, bumping generations.
*
* Exported separately from the instance so a caller that only owns the raw
* maps — the account and api-key routes, which must invalidate the console
* cache the moment the credential changes — can invalidate WITHOUT having to
* construct an instance first. It shares `generationsOf`, so an instance's own
* `clear()` and this function are the same operation.
* @param {Map<string, unknown>} cache - the cache map to drop from.
* @param {Map<string, Promise<unknown>>} inflight - its in-flight companion.
* @param {string} [key] - the key to drop; omit to drop everything.
* @returns {void}
*/
function clearCoalescedFetch(cache, inflight, key) {
	const gens = generationsOf(cache);
	if (key === void 0) {
		gens.global += 1;
		cache.clear();
		inflight.clear();
		gens.keys.clear();
		return;
	}
	gens.keys.set(key, (gens.keys.get(key) ?? gens.global) + 1);
	cache.delete(key);
	inflight.delete(key);
}
/**
* A coalescing read-through cache.
* @param {object} [options]
* @param {Map<string, {body: unknown, at: number, gen: number}>} [options.cache] -
*   an existing cache map to share; a fresh one is created when omitted.
* @param {Map<string, Promise<unknown>>} [options.inflight] - an existing
*   in-flight map to share.
* @param {number} [options.maxAgeMs] - the sweep ceiling.
* @returns {{
*   read: (key: string, producer: () => Promise<unknown>, ttlMs: number) => Promise<unknown>,
*   clear: (key?: string) => void
* }}
*/
function createCoalescedFetch(options = {}) {
	const { cache = /* @__PURE__ */ new Map(), inflight = /* @__PURE__ */ new Map(), maxAgeMs = MAX_CACHE_AGE_MS } = options;
	const gens = generationsOf(cache);
	const genOf = (key) => gens.keys.get(key) ?? gens.global;
	/** Drop entries past the sweep ceiling; called after every write. */
	const sweep = () => {
		const nowMs = Date.now();
		for (const [key, entry] of cache) if (nowMs - entry.at > maxAgeMs) cache.delete(key);
	};
	/**
	* Read one key through the cache, coalescing concurrent misses.
	* @param {string} key - the cache key (a URL, or a key carrying a
	*   credential fingerprint — see the raccoon route).
	* @param {() => Promise<unknown>} producer - what to call on a miss.
	* @param {number} ttlMs - how long an answer stays fresh (`0` = never
	*   reuse; the single-flight sharing still applies).
	* @returns {Promise<unknown>} the value.
	*/
	const read = async (key, producer, ttlMs) => {
		const cached = cache.get(key);
		if (cached !== void 0 && cached.gen === genOf(key) && Date.now() - cached.at < ttlMs) return cached.body;
		const pending = inflight.get(key);
		if (pending !== void 0) return pending;
		const born = genOf(key);
		const flight = (async () => {
			const body = await producer();
			cache.set(key, {
				body,
				at: Date.now(),
				gen: born
			});
			sweep();
			return body;
		})().finally(() => {
			if (inflight.get(key) === flight) inflight.delete(key);
		});
		inflight.set(key, flight);
		return flight;
	};
	/**
	* Drop one key's cached answer, or the whole cache.
	*
	* The drop bumps the key's (or the global) generation AND evicts the
	* in-flight map entry, so the NEXT read cannot join a pre-clear flight nor be
	* served a pre-clear cache entry — the previous identity's answer is gone for
	* good even when its producer was still in flight when the change happened.
	* In-flight calls themselves are NOT cancelled: a reader that already took a
	* flight's promise still settles with what it asked for; only NEW reads miss.
	* @param {string} [key] - the key to drop; omit to drop everything.
	* @returns {void}
	*/
	const clear = (key) => clearCoalescedFetch(cache, inflight, key);
	return {
		read,
		clear
	};
}

//#endregion
//#region src/host/console-client.ts
/**
* The Host half's console and model-catalog fetches: caching plus single-flight.
*
* Both endpoints share one in-flight map per URL, so several open panels (or
* tabs) polling at once issue a single console request instead of N — which is
* also how the Host stays off the platform's own rate limiter. Cached responses
* age out on their own TTL, and a safety sweep drops anything older than the
* longest TTL so the map never grows without bound.
*
* The caching + coalescing is NOT implemented here: both functions drive the
* shared `coalesced-fetch.ts` primitive with the caller's maps, so this module
* owns the REQUEST shape only and the "one call per key" discipline has exactly
* one implementation to get right.
* @module dsh-connect-sensenova-token-plan/console-client
*/
/**
* One cached console response: the body plus the epoch millis it was fetched.
* @typedef {{body: unknown, at: number}} CacheEntry
*/
/**
* Fetch one console endpoint with a bearer token, caching the result.
*
* A 401/403 means the token the console saw is no longer good, so the store is
* invalidated and the call retried exactly once with a fresh token. Without
* the retry a token that expires mid-poll would leave the panel stuck on an
* error until the next manual re-login; with it, the panel heals itself.
*
* @param settings - resolved plugin settings.
* @param path - the console path, e.g. `/lite/console/v1/tokenplan/pool-usage`.
* @param params - optional query parameters.
* @param cacheMs - how long to keep the response.
* @param cache - the cache map to use.
* @param inflight - the in-flight map to share requests through.
* @param tokenStore - the credentials-backed token store.
* @returns {Promise<unknown>} the parsed console body.
*/
async function fetchConsole(settings, path, params, cacheMs, cache, inflight, tokenStore) {
	const query = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
	const url = `${settings.consoleBase}${path}${query}`;
	const coalesced = createCoalescedFetch({
		cache,
		inflight
	});
	const run = async () => {
		const send = async (token) => fetch(url, {
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/json"
			},
			signal: AbortSignal.timeout(settings.consoleTimeoutMs)
		});
		let token = await tokenStore.getToken();
		let response = await send(token);
		if (response.status === 401 || response.status === 403) {
			tokenStore.invalidate(token);
			token = await tokenStore.getToken();
			response = await send(token);
		}
		if (response.status === 401 || response.status === 403) {
			const error = /* @__PURE__ */ new Error(`console rejected the token (HTTP ${response.status})`);
			error.code = CODE.JWT_EXPIRED;
			throw error;
		}
		if (!response.ok) throw new Error(`console returned HTTP ${response.status}`);
		return await response.json();
	};
	return coalesced.read(url, run, cacheMs);
}
/**
* Fetch the API-key model catalog: the models this key can actually call.
*
* This is a free, read-only `GET /v1/models` — it spends no credits and
* consumes no inference quota. It is the same list the DSH Models page shows
* in "选择要添加的模型", and it is deliberately kept separate from the
* console's `pool-usage` `model_ids`, which is the PLAN's advertised
* coverage (it lists models this key has no permission for).
*
* @param settings - resolved plugin settings.
* @param cacheMs - how long to keep the response (long: the catalog is stable).
* @param cache - the cache map to use.
* @param inflight - the in-flight map to share requests through.
* @param apiKey - the SenseNova API key.
*/
async function fetchModelCatalog(settings, cacheMs, cache, inflight, apiKey) {
	const url = `${settings.apiBase}/models`;
	const coalesced = createCoalescedFetch({
		cache,
		inflight
	});
	const run = async () => {
		const response = await fetch(url, {
			headers: {
				authorization: `Bearer ${apiKey}`,
				accept: "application/json"
			},
			signal: AbortSignal.timeout(settings.consoleTimeoutMs)
		});
		if (!response.ok) throw new Error(`/v1/models returned HTTP ${response.status}`);
		const body = await response.json();
		return Array.isArray(body?.data) ? body.data.map((entry) => {
			const source = obj(entry);
			return {
				id: str(source.id, ""),
				...source
			};
		}).filter((entry) => entry.id !== "") : [];
	};
	return coalesced.read(url, run, cacheMs);
}

//#endregion
//#region src/host/draw.ts
/**
* The SenseNova image-generation module ("draw absorption", ARCHITECTURE §5.4
* route B) — the PEER-FREE half.
*
* Like `llm-models.ts` this module imports no runtime peer: it maps catalog
* entries, builds wire bodies and classifies failures as plain functions, so
* every decision here is testable on a clean checkout. The peer-dependent
* half lives in `index.ts`: the `@deepseek-ai/dsh-tools` import and the
* `ctx.tools` registration are loaded lazily and only when the `drawEnabled`
* opt-in is on — a Host without the tools service simply never sees the tool,
* exactly like the provider degrades without an `llm` service.
*
* Two design facts are load-bearing rather than cosmetic:
*
* 1. Model identification is STRUCTURED, not name-regex. `dsh-draw-router`
*    (the community reference this module absorbs, upstream/dsh-draw-router)
*    filters its probed model list through name patterns and thereby misses
*    `sensenova-u1.5-lite` outright (ARCHITECTURE §5.4); this module reads the
*    catalog's own `output_modalities` field instead — the same field
*    `isChatModel` already uses to keep image models OUT of the chat picker,
*    so the two lists can never disagree about what exists.
* 2. The key is resolved per call (`resolveApiKey`), never cached: rotating
*    the panel-saved `SENSENOVA_API_KEY` reference takes effect on the next
*    draw without re-registration, mirroring the LLM adapter.
*
* @module dsh-connect-sensenova-token-plan/draw
*/
/** The agent tool name. Scoped so it cannot collide with `dsh-draw-router`'s `draw_image`. */
const DRAW_TOOL_NAME = "sensenova_draw_image";
/** How long after a failed draw the next attempt is refused. Borrowed from dsh-draw-router (its probe cooldown). */
const DRAW_COOLDOWN_MS = 3e4;
/** Default deadline for one image request; image models are slow, chat deadlines do not apply. */
const DRAW_DEFAULT_TIMEOUT_MS = 12e4;
/** The platform's per-request image cap: its official docs pin `n` to 1 for both image models. */
const DRAW_MAX_IMAGES = 1;
/** The documented `output_format` choices for `images/generations` (png/jpg/jpeg/webp). */
const DRAW_OUTPUT_FORMATS = [
	"png",
	"jpg",
	"jpeg",
	"webp"
];
/** Normalize a caller-supplied `output_format` value to the documented set. */
function normalizeDrawOutputFormat(value) {
	const format = str(value, "").trim().toLowerCase();
	if (format === "") return "png";
	return DRAW_OUTPUT_FORMATS.includes(format) ? format : "png";
}
/** Normalize a caller-supplied `watermark` flag. Only documented boolean forms travel; everything else keeps the documented default `true`. */
function normalizeDrawWatermark(value) {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return true;
}
/**
* Build the `images/generations` endpoint from the OpenAI-compatible base.
*
* Mirrors `dsh-draw-router`'s `buildEndpoint` (upstream line 72-79) so every
* operator spelling of `apiBase` lands on the same URL:
* `…/v1` → `…/v1/images/generations`; an URL already ending in
* `/images/generations` passes through; a deeper `/v1/<something>` is rewound
* to `/v1`; anything else gets `/v1/images/generations` appended.
* @param {string} apiBase - the configured base (default `https://token.sensenova.cn/v1`).
* @returns {string} the full draw endpoint.
*/
function buildDrawEndpoint(apiBase) {
	const trimmed = str(apiBase, "").trim().replace(/\/+$/, "");
	if (trimmed === "") return "";
	if (/\/images\/generations$/.test(trimmed)) return trimmed;
	if (/\/v1$/.test(trimmed)) return `${trimmed}/images/generations`;
	if (/\/v1\//.test(trimmed)) return trimmed.replace(/\/v1\/.*$/, "/v1/images/generations");
	return `${trimmed}/v1/images/generations`;
}
/**
* The draw-capable model ids of one catalog, de-duplicated in first-seen order.
*
* Deduping keeps the LAST occurrence at its first-seen position, exactly like
* `rosterOf` / `buildDescriptors` / `catalog-store.normalizeEntries`, so the
* draw list and the chat roster can never disagree about which ids exist.
* @param {object[]} entries - the normalized catalog entries.
* @returns {string[]}
*/
function imageGenModelIds(entries) {
	const position = /* @__PURE__ */ new Map();
	const out = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!isImageGenModel(entry)) continue;
		const id = str(entry?.id, "");
		if (id === "") continue;
		if (position.has(id)) out[position.get(id)] = id;
		else {
			position.set(id, out.length);
			out.push(id);
		}
	}
	return out;
}
/**
* Choose the model one draw call addresses.
*
* Precedence: an explicitly requested id wins even when the catalog does not
* list it (a manual override, like `dsh-draw-router`; the platform answers
* the error itself if the id is wrong) — but an empty catalog with nothing
* requested yields `null`, and the caller turns that into the actionable
* "no draw models" error rather than sending a doomed request.
* @param {object[]} entries - the normalized catalog entries.
* @param {string} [requested] - the tool call's `model` parameter.
* @param {string} [preferred] - the configured default (`drawModelId`).
* @returns {string|null} the chosen id, or `null` when nothing can be picked.
*/
function pickDrawModel(entries, requested, preferred) {
	const want = str(requested, "").trim();
	if (want !== "") return want;
	const ids = imageGenModelIds(entries);
	if (ids.length === 0) return null;
	const config = str(preferred, "").trim();
	if (config !== "" && ids.includes(config)) return config;
	return ids[0] ?? null;
}
/**
* Build the `images/generations` request body.
*
* Only the fields the endpoint actually consumes travel: `n` is clamped to a
* sane range (a fraction floors, junk and out-of-range values fall back to 1)
* and `response_format` defaults to `url` — the panel/agent-facing shape that
* renders as a Markdown image without the client having to handle base64.
* `output_format` and `watermark` are always explicit (defaults `png` and
* `true`), because the official docs recommend pinning them to survive a
* future platform default change.
* @param {object} options - `{ model, prompt, n, size, responseFormat, outputFormat, watermark }`.
* @returns {object} the wire body.
*/
function buildDrawBody(options = {}) {
	const { model, prompt, n, size, responseFormat, outputFormat, watermark } = options;
	const count = Math.floor(num(n, 1));
	const body = {
		model: str(model, ""),
		prompt: str(prompt, ""),
		n: Number.isFinite(count) ? Math.min(1, Math.max(1, count)) : 1,
		response_format: str(responseFormat, "url") || "url",
		output_format: normalizeDrawOutputFormat(outputFormat),
		watermark: normalizeDrawWatermark(watermark)
	};
	const dims = str(size, "").trim();
	if (dims !== "") body.size = dims;
	return body;
}
/**
* Extract the first image out of an `images/generations` response.
* @param {object} data - the parsed response JSON.
* @returns {{url: string, b64Json: string, revisedPrompt: string}}
* @throws {Error} when the response carries no `data[0]` at all.
*/
function parseDrawResponse(data) {
	const item = data?.data?.[0];
	if (item === null || typeof item !== "object") throw new Error("draw: unexpected response, missing data[0]");
	const source = item;
	return {
		url: str(source.url, ""),
		b64Json: str(source.b64_json, ""),
		revisedPrompt: str(source.revised_prompt, "")
	};
}
/**
* Turn a failed HTTP answer into the message the agent (and the trace) reads.
*
* The split mirrors the 429 discipline already fixed for chat (ROADMAP §1-2):
* "insufficient/quota" in a 429 means the shared pool is drained — retrying
* the same request is waste — while any other 429 is a rate limit and a plain
* wait helps. Auth failures point at the panel's key area instead of at
* "the endpoint is broken".
* @param {number} status - the HTTP status code.
* @param {string} bodyText - the raw body (best effort, may be empty).
* @returns {string} the panel/agent-facing message.
*/
function describeDrawFailure(status, bodyText) {
	const text = redactSecrets(str(bodyText, "")).slice(0, 300);
	if (status === 401 || status === 403) return `draw failed: HTTP ${status} — the SENSENOVA_API_KEY is missing, invalid or not authorized for this model. Set it in the panel's 模型接入 area${text === "" ? "" : `; body: ${text}`}`;
	if (status === 429) {
		if (/insufficient|quota/i.test(text)) return `draw failed: HTTP 429 — 配额不足（共享池已耗尽或该出图模型不在套餐内），稍后或换模型再试; body: ${text}`;
		return `draw failed: HTTP 429 — 限频，请稍等重试; body: ${text}`;
	}
	if (status === 404) return `draw failed: HTTP 404 — 模型不存在或 endpoint 不对（检查 apiBase 与模型 id）${text === "" ? "" : `; body: ${text}`}`;
	return `draw failed: HTTP ${status}${text === "" ? "" : ` ${text}`}`;
}
/**
* Fire one draw request and parse the answer.
*
* The deadline aborts through an `AbortController` (the `AbortSignal.timeout`
* spelling would do, but the controller also cancels the in-flight body read
* and keeps the whole flow injectable for tests). A non-2xx answer never
* reaches JSON parsing: its classified message is thrown with the raw body
* attached, so the agent sees WHY, not just that it failed.
* @param {object} options - wiring.
* @param {Function} options.fetchImpl - the fetch to use (injected; the real
*   `globalThis.fetch` arrives from `index.ts`).
* @param {string} options.endpoint - the full `images/generations` URL.
* @param {string} options.apiKey - the resolved `sk-` key.
* @param {object} options.body - the wire body (`buildDrawBody`).
* @param {number} [options.timeoutMs] - the deadline.
* @returns {Promise<{url: string, b64Json: string, revisedPrompt: string, model: string}>}
*/
async function drawOnce({ fetchImpl, endpoint, apiKey, body, timeoutMs = DRAW_DEFAULT_TIMEOUT_MS }) {
	if (typeof fetchImpl !== "function") throw new Error("drawOnce: fetchImpl is required");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error(`draw timeout after ${timeoutMs}ms`)), Math.max(1e3, timeoutMs));
	try {
		const response = await fetchImpl(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify(body),
			signal: controller.signal
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(describeDrawFailure(response.status, text));
		}
		return {
			...parseDrawResponse(await response.json().catch(() => {
				throw new Error("draw: response is not valid JSON");
			})),
			model: str(body?.model, "")
		};
	} finally {
		clearTimeout(timer);
	}
}
/**
* The failed-draw cooldown gate.
*
* Borrowed from `dsh-draw-router` (its probe failure cooldown, upstream line
* 196): after one failed draw the next attempt is refused for a window, so a
* drained pool does not get hammered by an agent retrying in a loop. The
* clock is wall-time, so the gate reopens by itself when the window passes —
* deliberately NO success-side reset: a tripped gate blocks the execute entry
* itself, so a success can only ever happen on an open gate and a reset call
* there would be dead code.
* @param {number} [cooldownMs] - the window.
* @returns {{blocked: Function, trip: Function, remainingMs: Function}}
*/
function createDrawCooldown(cooldownMs = DRAW_COOLDOWN_MS) {
	let until = 0;
	return {
		blocked: (now = Date.now()) => now < until,
		trip: (now = Date.now()) => {
			until = now + cooldownMs;
		},
		remainingMs: (now = Date.now()) => Math.max(0, until - now)
	};
}
/**
* Build the agent tool object for `ctx.tools.register`.
*
* Pure wiring: the peer's `defineTool` factory arrives as a parameter (so this
* module stays importable without the peer), and every side effect the tool
* needs — key resolution, the live catalog, the fetch, disposal — is injected.
* `index.ts` calls this only when `drawEnabled` is on AND a tools service is
* present; every failure inside `execute` throws so the agent reads the
* reason, and the panel is never involved (no snapshot key, no route).
* @param {object} options - wiring.
* @param {Function} options.defineTool - the peer's tool factory.
* @param {Function} options.resolveApiKey - async `() => Promise<string>`, the
*   live `SENSENOVA_API_KEY` value (empty when unset).
* @param {Function} options.getEntries - `() => catalog entries` (sync or
*   async), read at call time so a catalog refresh is picked up without
*   re-registration. The caller (`index.ts`) hands the FULL persisted catalog,
*   not the picker's allow-list-filtered offer — the curation binds the picker,
*   never the agent's tools.
* @param {object} options.settings - `{ apiBase, drawModelId, drawTimeoutMs }`.
* @param {Function} options.fetchImpl - the fetch for `drawOnce`.
* @param {object} [options.cooldown] - a `createDrawCooldown()` gate.
* @param {Function} [options.isDisposed] - `() => boolean`, true after unmount.
* @returns {object} the tool definition for `ctx.tools.register`.
*/
function defineDrawTool({ defineTool, resolveApiKey, getEntries, settings, fetchImpl, cooldown = createDrawCooldown(), isDisposed = () => false }) {
	const timeoutMs = Math.max(5e3, Math.floor(num(settings?.drawTimeoutMs, DRAW_DEFAULT_TIMEOUT_MS)));
	return defineTool({
		name: DRAW_TOOL_NAME,
		description: "Generate an image with the SenseNova Token Plan key. Omit `model` to let the catalog's default image model be used; pass `model` only when you need a particular one — the available image model ids are reported in the result after the first successful call.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "Image generation prompt"
			},
			model: {
				type: "string",
				description: "SenseNova image model id; defaults to the first discovered one"
			},
			size: {
				type: "string",
				description: "Image size as WIDTHxHEIGHT, e.g. 1024x1024; platform range 512-4096 in multiples of 32, ratio up to 3:1; omit for auto"
			},
			n: {
				type: "number",
				description: "Number of images — the platform only supports 1; default 1"
			},
			outputFormat: {
				type: "string",
				description: "Image file format: png (default), jpg, jpeg, or webp"
			},
			watermark: {
				type: "boolean",
				description: "Add the SenseNova logo watermark. Defaults to true; false means no watermark"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					source: { type: "string" },
					model: { type: "string" },
					url: { type: "string" },
					prompt: { type: "string" },
					hint: { type: "string" }
				}
			},
			render: (_args, result) => [{
				type: "text",
				text: result?.hint || "图片已生成"
			}]
		},
		timeoutMs: timeoutMs + 1e4,
		async execute(params) {
			if (isDisposed()) throw new Error("sensenova draw tool is no longer mounted");
			const prompt = str(params?.prompt, "").trim();
			if (prompt === "") throw new Error("prompt is required");
			if (cooldown.blocked()) throw new Error(`draw cooldown: 上一次出图失败，${Math.ceil(cooldown.remainingMs() / 1e3)}s 后再试`);
			const apiKey = await resolveApiKey();
			if (typeof apiKey !== "string" || apiKey.trim() === "") throw new Error("SENSENOVA_API_KEY 未配置：在面板「模型接入」粘贴 sk- Key，或设置该环境变量");
			let picked;
			try {
				picked = await getEntries?.() ?? [];
			} catch {
				picked = [];
			}
			const entries = Array.isArray(picked) ? picked : [];
			const model = pickDrawModel(entries, str(params?.model, ""), settings?.drawModelId === void 0 ? void 0 : str(settings.drawModelId, ""));
			if (model === null) throw new Error("catalog 中没有出图模型（output_modalities 含 image 的条目为空）：确认 Key 已配置、面板已至少轮询一次，且套餐含出图模型");
			const body = buildDrawBody({
				model,
				prompt,
				...typeof params?.n === "number" ? { n: params.n } : {},
				size: str(params?.size, ""),
				outputFormat: str(params?.outputFormat, ""),
				...typeof params?.watermark === "boolean" ? { watermark: params.watermark } : {}
			});
			let result;
			try {
				result = await drawOnce({
					fetchImpl,
					endpoint: buildDrawEndpoint(str(settings?.apiBase, "")),
					apiKey,
					body,
					timeoutMs
				});
			} catch (error) {
				cooldown.trip();
				throw error;
			}
			const drawModelIds = imageGenModelIds(entries).join(", ");
			const available = drawModelIds !== "" ? `\n可用出图模型: ${drawModelIds}` : "";
			const hint = result.url !== "" ? `图片已生成!\n模型: ${result.model}\nURL: ${result.url}\n请直接输出 Markdown: ![图](${result.url})${available}` : `图片已生成!\n模型: ${result.model}\n(base64 图片数据，请以 data:image/png;base64,… 形式在对话中展示)${available}`;
			return {
				source: "sensenova",
				model: result.model,
				url: result.url,
				prompt,
				hint
			};
		}
	});
}

//#endregion
//#region src/host/draw-tool-state.ts
/**
* The draw tool's mount-time absence note, in memory only.
*
* `registerDrawTool` (lifecycle.ts) is the single place that decides whether
* the opt-in draw tool actually got registered. Three of its bail-outs are
* "the tool is absent" with the switch visibly on:
*
*   - the Host exposes no `tools` service (or its `register` is not a
*     function) — a NORMAL absence, nothing is broken, but the panel's copy
*     already has a line for it (`draw.noTools`) that was never wired to any
*     signal;
*   - the tools peer module failed to load — already logged via `degrade`;
*   - the registry refused the registration — already logged via `degrade`.
*
* Only the FIRST is a normal fact the panel should state (the other two are
* Host bugs, and their traces belong in the log, not the copy). This module
* holds exactly that one bit, read by the snapshot's draw block.
*
* In memory and NOT profile-scoped on purpose: it is a per-mount diagnostic,
* recomputed on every Host (re)mount by `registerDrawTool`, never persisted.
* Same in-memory discipline as `providerState.error`.
* @module dsh-connect-sensenova-token-plan/draw-tool-state
*/
let absent = false;
/** Clear the note — called at the top of every registration attempt. */
function resetDrawToolState() {
	absent = false;
}
/** Record that the draw switch is on but no tools service could be found. */
function markDrawToolAbsent() {
	absent = true;
}
/** The snapshot's draw block reads this once per poll. */
function drawToolAbsent() {
	return absent;
}

//#endregion
//#region src/host/snapshot-aggregate.ts
/**
* The snapshot route's DATA AGGREGATION — the peer-free pure half.
*
* Keeps the router to only the HTTP surface (route registration, the trust
* fence, body reading, the `writeJson` responses) while the polling-side
* decisions — fetching through the cache, parsing pools/trend/catalog,
* computing shape warnings, splitting a pool's coverage into callable vs
* locked models, marking quota-exhausted models, identifying vision models,
* building the `llm` status block — live here as one testable function.
*
* Pure by design: it takes the resolved `settings`, the shared `cache` /
* `inflight` maps, the `tokenStore`, the `apiKeyStore`, the `publisher`
* (from `provider-publish.ts`) and the `catalogStore`, and returns the exact
* snapshot body the route writes. No HTTP surface, no filesystem writes, no
* module-level state — so `test/routes.test.mjs` can pin every branch (the
* 14-key snapshot contract, the vision-vs-catalog distinction, the
* quota-flip re-registration) without mounting the full container.
*
* @module dsh-connect-sensenova-token-plan/snapshot-aggregate
*/
/**
* The operator's pseudo multiplier that names one model id, or undefined.
*
* Matching is a case-insensitive SUBSTRING of the model id, first configured
* key wins (insertion order — `resolveTrendMultipliers` preserves it). One
* matcher serves BOTH the trend rows and the panel roster, so a model's `×N`
* in the consumption chart and its `×N` badge in the model list are the same
* computed fact, never two copies that can drift.
*
* @param {unknown} modelId - a model id (trend row name or roster row id).
* @param {Record<string, number>} multipliers - the sanitized config map.
* @returns {number|undefined} the hit value, or undefined when nothing matched.
*/
function matchMultiplier(modelId, multipliers) {
	const id = String(modelId ?? "").toLowerCase();
	for (const [key, value] of Object.entries(multipliers || {})) if (id.includes(key.toLowerCase())) return value;
}
/**
* Attach the operator's pseudo multipliers to the parsed trend rows.
*
* A row without a match keeps no `multiplier` field — the panel shows no
* factor for it rather than guessing 1. The math lives here as one exported
* seam so the tests drive the exact function `buildSnapshotBody` calls, not a
* copy.
*
* @param {{models: Array<{model: string, credits: number, multiplier?: number}>}} trend
*   the `parseTrend` result; rows are replaced in place on the object.
* @param {Record<string, number>} multipliers - the sanitized config map.
* @returns {object} the same trend object with `multiplier` on matching rows.
*/
function applyTrendMultipliers(trend, multipliers) {
	trend.models = trend.models.map((row) => {
		const multiplier = matchMultiplier(row.model, multipliers);
		return multiplier === void 0 ? row : {
			...row,
			multiplier
		};
	});
	return trend;
}
/**
* Run one fetch, reporting its failure instead of throwing.
*
* The snapshot must NOT be all-or-nothing on the console: a signed-out or
* unreachable console still leaves the llm block and the model catalog —
* neither of which needs the console token — deliverable. The failed source
* is named in `quotaError`; the panel says why instead of showing nothing,
* and the API / Raccoon tabs stay fully usable without a console login.
* @param {() => Promise<unknown>} fn - the fetch.
* @returns {Promise<{value: unknown, error: unknown}>} `value` or `error`, never both.
*/
async function soft(fn) {
	try {
		return {
			value: await fn(),
			error: null
		};
	} catch (error) {
		return {
			value: null,
			error
		};
	}
}
/**
* Map a thrown console/auth error to the one code the panel branches on.
*
* A raw error message carries no intent, so the panel keys its guidance off
* this taxonomy instead: `not_configured` (the user can fix it) and
* `jwt_expired` (renewal already failed) pass through verbatim because the
* panel words them differently from every other case; a misconfigured row
* (`config`, thrown by the auth walk for a bad override or a missing key id)
* is reported as `config_error` so the panel says "fix the row" and never
* invites a sign-in; an auth-shaped failure becomes `auth_error`; anything
* else is a console failure, which usually self-heals on the next poll. The
* same mapping answers both the snapshot's in-body `quotaError` and the
* route's `ok:false` catch — one copy, one taxonomy.
* @param {unknown} error - the error a fetch or parse threw.
* @returns {string} the panel-facing code.
*/
function failureCode(error) {
	const code = error && typeof error === "object" ? error.code : void 0;
	if (code === CODE.CONFIG || code === CODE.CONFIG_ERROR) return CODE.CONFIG_ERROR;
	if (code === CODE.NOT_CONFIGURED || code === CODE.JWT_EXPIRED) return code;
	return isAuthFailure(error) ? CODE.AUTH_ERROR : CODE.CONSOLE_ERROR;
}
/**
* Fetch the three console sources in parallel and aggregate them into the
* snapshot body the route writes.
*
* The console sources are fetched through the shared `cache` + `inflight`
* maps (a single-flight per URL so concurrent polls share one call) and the
* `tokenStore` (so a 401 triggers one renewal before the call). The model
* catalog is optional: a missing API key degrades the model lists, not the
* quota — resolved per poll so a key that arrives after the plugin mounted
* still lights the lists on the next poll.
*
* @param {object} context
* @param {object} context.settings - the resolved settings row.
* @param {Map} context.cache - the console-response cache (shared across polls).
* @param {Map} context.inflight - the single-flight map (shared across polls).
* @param {object} context.tokenStore - the `createTokenStore` instance.
* @param {object} context.apiKeyStore - the `createApiKeyStore` instance.
* @param {object} context.publisher - the `createProviderPublisher` instance.
* @param {object} context.catalogStore - the `createFileCatalogStore` instance.
* @param {() => Promise<boolean|null>} context.panelSwitch - the panel-saved
*   provider switch (`provider-store.enabled()`); null when untouched.
* @param {() => Promise<boolean|null>} context.drawSwitch - the panel-saved
*   draw-tool switch (`draw-store.enabled()`), same shape and precedence.
* @returns {Promise<SnapshotData>} the snapshot body (`{ ok, now, ..., pools, trend, ... }`).
*/
async function buildSnapshotBody({ settings, cache, inflight, tokenStore, apiKeyStore, publisher, catalogStore, panelSwitch, drawSwitch, drawModelId }) {
	const providerState = publisher.state;
	const resolveApiKey = async () => (await apiKeyStore.resolve()).value;
	const now = Math.floor(Date.now() / 1e3);
	const bucketSeconds = settings.trendHours <= 72 ? 3600 : 86400;
	const endBucket = Math.floor(now / bucketSeconds) * bucketSeconds;
	const start = endBucket - settings.trendHours * 3600;
	const granularity = settings.trendHours <= 72 ? "TOKEN_PLAN_CREDIT_TREND_GRANULARITY_HOUR" : "TOKEN_PLAN_CREDIT_TREND_GRANULARITY_DAY";
	const [poolResult, trendResult, catalog] = await Promise.all([
		soft(() => fetchConsole(settings, "/lite/console/v1/tokenplan/pool-usage", void 0, settings.cacheSeconds * 1e3, cache, inflight, tokenStore)),
		soft(() => fetchConsole(settings, "/lite/console/v1/tokenplan/credit-usage-trend", {
			start_time: String(start),
			end_time: String(endBucket),
			granularity
		}, Math.max(settings.cacheSeconds, 300) * 1e3, cache, inflight, tokenStore)),
		(async () => {
			const apiKey = await resolveApiKey();
			return apiKey === "" ? null : fetchModelCatalog(settings, 36e5, cache, inflight, apiKey).catch(() => null);
		})()
	]);
	const pools = parsePools(poolResult.value);
	const trend = parseTrend(trendResult.value, settings.trendHours);
	applyTrendMultipliers(trend, settings.trendMultipliers);
	const consoleFailure = poolResult.error ?? trendResult.error ?? null;
	const quotaError = consoleFailure === null ? null : {
		code: failureCode(consoleFailure),
		message: errMsg(consoleFailure)
	};
	const shapeWarnings = [...poolResult.error === null ? checkShape(poolResult.value, "pool-usage").missing.map((key) => ({
		api: "pool-usage",
		missing: key
	})) : [], ...trendResult.error === null ? checkShape(trendResult.value, "credit-usage-trend").missing.map((key) => ({
		api: "credit-usage-trend",
		missing: key
	})) : []];
	const catalogIds = Array.isArray(catalog) ? catalog.map((entry) => str(entry?.id, "")) : [];
	if (Array.isArray(catalog)) {
		const available = new Set(catalogIds);
		pools.pools = pools.pools.map((pool) => {
			const callable = pool.modelIds.filter((model) => available.has(model));
			const locked = pool.modelIds.filter((model) => !available.has(model));
			return {
				...pool,
				callableModels: callable,
				lockedModels: locked
			};
		});
	} else pools.pools = pools.pools.map((pool) => ({
		...pool,
		callableModels: pool.modelIds,
		lockedModels: []
	}));
	const unavailableModelIds = exhaustedModelIds(pools);
	const visionModels = Array.isArray(catalog) ? catalog.map((entry) => identifyVisionModel(entry)).filter((entry) => entry.vision) : void 0;
	const keyState = await apiKeyStore.state().catch(() => ({
		hasApiKey: false,
		keySource: null,
		ephemeral: false
	}));
	const effectiveDrawModelId = await drawModelId?.().catch(() => null) ?? str(settings.drawModelId, "");
	const effectivePanelSwitch = await panelSwitch().catch(() => null);
	const effectiveDrawPanelSwitch = await drawSwitch?.().catch(() => null) ?? null;
	const enabledIds = await catalogStore.listEnabledIds().catch(() => providerState.enabledIds);
	let offered = providerState.entries;
	let catalogChanged = false;
	if (Array.isArray(catalog)) {
		if (catalogSignature(catalog, enabledIds) !== providerState.signature) {
			catalogChanged = true;
			await catalogStore.replace(catalog, enabledIds).catch(() => {});
			await publisher.publish(catalog, enabledIds, unavailableModelIds);
			syncSignaturesAfterPublish(providerState);
		}
		offered = catalog;
	}
	if ([...unavailableModelIds].sort().join(",") !== providerState.quotaSignature) {
		if (!catalogChanged) await publisher.publish(providerState.entries, providerState.enabledIds, unavailableModelIds);
		syncSignaturesAfterPublish(providerState);
	}
	const summary = summarizeCatalog(filterByEnabled(offered, enabledIds));
	const llmStatus = {
		...keyState,
		registerProvider: resolveSwitchEnabled(effectivePanelSwitch, settings.registerProvider),
		registerSource: switchSource(effectivePanelSwitch),
		llmAvailable: providerState.llmAvailable,
		providerRegistered: providerState.registered,
		providerId: LLM_PROVIDER_ID,
		modelCount: summary.modelCount,
		visionCount: summary.visionCount,
		thinkingDefault: DEFAULT_REASONING_EFFORT,
		models: rosterWithAvailability(offered, pools).map((row) => {
			const multiplier = matchMultiplier(row.id, settings.trendMultipliers);
			return multiplier === void 0 ? row : {
				...row,
				multiplier
			};
		}),
		enabledModelIds: enabledIds,
		quotaBlockedModelIds: unavailableModelIds,
		drawEnabled: resolveSwitchEnabled(effectiveDrawPanelSwitch, settings.drawEnabled),
		drawSource: switchSource(effectiveDrawPanelSwitch),
		...drawToolAbsent() ? { drawToolAbsent: true } : {},
		...Array.isArray(catalog) ? (() => {
			const candidates = imageGenModelIds(catalog);
			const drawModel = pickDrawModel(catalog, "", effectiveDrawModelId);
			return {
				...drawModel !== null ? { drawModel } : {},
				drawCandidateCount: candidates.length,
				drawCandidateIds: candidates,
				...effectiveDrawModelId !== "" ? { drawPreferredModel: effectiveDrawModelId } : {}
			};
		})() : {},
		...providerState.error !== null ? { providerError: providerState.error } : {}
	};
	return {
		ok: true,
		now: Date.now(),
		consoleBase: settings.consoleBase,
		cacheSeconds: settings.cacheSeconds,
		pollSeconds: settings.pollSeconds,
		auth: await tokenStore.state(),
		catalogAvailable: Array.isArray(catalog),
		catalogModels: catalogIds,
		...visionModels !== void 0 ? { visionModels } : {},
		uncountedModels: quotaError === null && Array.isArray(catalog) ? catalogIds.filter((model) => !pools.pools.some((pool) => pool.modelIds.includes(model))) : [],
		llm: llmStatus,
		pools,
		trend,
		quotaError,
		shapeWarnings
	};
}

//#endregion
//#region src/host/routes/http.ts
/**
* The HTTP primitives shared by every route of the family: the JSON shape,
* the bounded body reader, the standard refusals and the trust fence.
*
* Part of the routes split (see `../routes.ts` for the family map; the
* token-store playbook was followed: behaviour frozen first — the suites ran
* green against the `routes.ts` facade, unchanged, before and after the move).
* Handlers keep exactly the behaviour they had inline; only the shared
* wording and ceilings live here, so a route cannot drift its own 403 / 405.
*
* Nothing here imports a Host peer.
*
* @module dsh-connect-sensenova-token-plan/routes/http
*/
/** Family default response headers for a JSON route. */
const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"referrer-policy": "no-referrer"
};
/** Write one JSON response with the family headers. */
function writeJson(res, status, body, headers = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		...JSON_HEADERS,
		...headers
	});
	res.end(payload);
}
/** Ceiling on a submitted account, so a hostile page cannot stream a body. */
const MAX_ACCOUNT_BODY_BYTES = 4096;
/** Ceiling on a Raccoon action body: the login POST only needs the scan code. */
const MAX_RACCOON_BODY_BYTES = 2048;
/**
* Read a small JSON request body, refusing anything oversized.
*
* The account form is the only thing that posts here, so the ceiling is tiny
* and the reader is deliberately dull: no content-type negotiation, no
* streaming, just a bounded collect and a parse.
* @param request - the incoming HTTP request.
* @param limit - the byte ceiling.
* @returns {Promise<{ok: true, value: object} | {ok: false, error: string}>}
*/
async function readJsonBody(request, limit = MAX_ACCOUNT_BODY_BYTES) {
	const chunks = [];
	let received = 0;
	try {
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			received += buffer.byteLength;
			if (received > limit) return {
				ok: false,
				error: "request body is too large"
			};
			chunks.push(buffer);
		}
	} catch {
		return {
			ok: false,
			error: "could not read the request body"
		};
	}
	if (chunks.length === 0) return {
		ok: false,
		error: "a JSON body is required"
	};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {
			ok: false,
			error: "the body must be a JSON object"
		};
		return {
			ok: true,
			value: parsed
		};
	} catch {
		return {
			ok: false,
			error: "the body is not valid JSON"
		};
	}
}
/**
* Refuse a request the trust fence rejects, with the one body the panel reads.
*
* Every route opens with the identical line, so the wording and the 403 shape
* live in one place: a route that forgets the fence, or words it differently,
* is now the odd one out rather than a second truth.
* @param response - the outgoing HTTP response.
* @returns {void}
*/
function refuseOrigin(response) {
	writeJson(response, 403, {
		ok: false,
		error: "forbidden: origin mismatch"
	});
}
/**
* Refuse a disallowed method with the family's 405 shape. A method refusal is
* not a fresh answer, so it carries no `cache-control` (unlike a snapshot).
* @param response - the outgoing HTTP response.
* @returns {void}
*/
function refuseMethod(response) {
	writeJson(response, 405, {
		ok: false,
		error: "method not allowed"
	});
}
/**
* Read and validate a JSON body, or answer 400 and signal the caller to stop.
*
* Collapses the read-then-400 block every POST route repeats. Returns the
* `readJsonBody` result on success (callers keep reading `body.value`), or
* `null` after the 400 was written — a `null` is the caller's cue to return.
* @param request - the incoming HTTP request.
* @param response - the outgoing HTTP response (written on failure).
* @returns {Promise<object|null>} the read result, or null if a 400 was sent.
*/
async function readJsonBodyOr400(request, response, limit = MAX_ACCOUNT_BODY_BYTES) {
	const body = await readJsonBody(request, limit);
	if (!body.ok) {
		writeJson(response, 400, {
			ok: false,
			error: /** @type {{ok: false, error: string}} */ body.error
		}, { "cache-control": "no-store" });
		return null;
	}
	return body;
}
/**
* Wrap a route handler with the trust fence every route opens with.
*
* The seven handlers each repeated the identical `isAdmitted` block; this folds
* it into one seam so a forgotten fence is impossible and the 403 wording
* stays in {@link refuseOrigin}. A handler wrapped here must NOT repeat the
* fence — doing so is only a second, dead guard.
* @param handler - the route logic.
* @param allowedHosts - the settings' allowed-hosts list the fence checks against.
* @returns the fenced handler.
*/
function withOrigin(handler, allowedHosts) {
	return async (request, response) => {
		if (!isAdmitted(request, allowedHosts)) {
			refuseOrigin(response);
			return;
		}
		return handler(request, response);
	};
}
/**
* Whether a request opted into the Raccoon 401-triage diagnostics (`?debug=1`).
*
* A retired scaffold: the 401 root-cause fix (Bearer dual-shape + pre-read
* renewal gate + `/refresh`) has landed and no client renders the triage
* fields, so an ordinary poll must not carry them. A query flag keeps the
* capability without a config field (a patch change needs a restart) and
* without widening every response.
*
* Only `1` / `true` opt in: `?debug=0` must stay quiet, and a malformed URL is
* treated as "no".
* @param {object} request - the incoming HTTP request.
* @returns {boolean} whether the diagnostics were requested.
*/
function wantsDiagnostics(request) {
	const url = typeof request?.url === "string" ? request.url : "";
	if (url === "") return false;
	try {
		const flag = new URL(url, "http://localhost").searchParams.get("debug");
		return flag === "1" || flag === "true";
	} catch {
		return false;
	}
}

//#endregion
//#region src/host/routes/snapshot.ts
/**
* The snapshot route — the one read-only route the Client panel polls.
*
* Part of the routes split (see `../routes.ts` for the family map). The
* aggregation itself lives in `snapshot-aggregate.ts`; this module is the
* HTTP edge: the trust fence, the config-error short-circuit, the vision
* write-back, and the `ok:false` shape with its code taxonomy.
*
* @module dsh-connect-sensenova-token-plan/routes/snapshot
*/
/** The one read-only route the Client panel polls. */
const SNAPSHOT_PATH = `/api/${name}/snapshot`;
/**
* Register the snapshot route. Wiring subset: `settings`, `configError`,
* `cache`, `inflight`, `tokenStore`, `apiKeyStore`, `publisher`,
* `catalogStore`, `providerStore`, `drawStore`, `visionPublish`, `logger`.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {Pick<Wiring, "settings" | "configError" | "cache" | "inflight" | "tokenStore" | "apiKeyStore" | "publisher" | "catalogStore" | "providerStore" | "drawStore" | "visionPublish" | "logger">} wiring
*   - the subset this route reads, as assembled by `apply()` in `index.ts`.
*   Twelve of twenty-two — the widest surface in the family, and the reason
*   the declaration is worth having: `apiKeyStore` is read directly off the
*   bag rather than destructured, so it was invisible to a grep of the
*   destructuring line and the `Pick` now names it in the type instead.
* @returns {Function} the `off()` unregister callback.
*/
function registerSnapshotRoute(ctx, wiring) {
	const { settings, configError, cache, inflight, tokenStore, publisher, catalogStore, providerStore, drawStore, visionPublish, logger } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: SNAPSHOT_PATH,
		handler: withOrigin(async (request, response) => {
			if (request.method !== void 0 && request.method !== "GET" && request.method !== "HEAD") {
				refuseMethod(response);
				return;
			}
			if (configError !== null) {
				writeJson(response, 200, {
					ok: false,
					code: CODE.CONFIG_ERROR,
					error: configError,
					auth: await optional(tokenStore.state())
				}, { "cache-control": "no-store" });
				return;
			}
			try {
				const body = await buildSnapshotBody({
					settings,
					cache,
					inflight,
					tokenStore,
					apiKeyStore: wiring.apiKeyStore,
					publisher,
					catalogStore,
					panelSwitch: () => optional(providerStore.enabled()),
					drawSwitch: () => optional(drawStore ? drawStore.enabled() : null),
					drawModelId: () => optional(drawStore ? drawStore.modelId() : null)
				});
				if (body.visionModels !== void 0) visionPublish.current?.(body.visionModels, body.visionModels.map((entry) => entry.id)).catch((error) => logger?.warn?.(`${name}: vision model list write failed`, error));
				writeJson(response, 200, body, { "cache-control": "no-store" });
			} catch (error) {
				writeJson(response, 200, {
					ok: false,
					error: errMsg(error),
					code: failureCode(error),
					auth: await optional(tokenStore.state())
				}, { "cache-control": "no-store" });
			}
		}, settings.allowedHosts)
	});
}

//#endregion
//#region src/host/trace.ts
/**
* Login-trace persistence.
*
* Every sign-in attempt (success included) leaves one sanitized trace file in
* `$DSH_HOME/logs/`: a "browser works but the panel does not" report is only
* debuggable by diffing a working trace against a failing one. The sanitizing
* itself happens in `sensenova-auth.ts` — no password, token, cookie, or
* authorization code ever reaches this module — so the only concern here is
* I/O failures, which must never break the login response.
* @module dsh-connect-sensenova-token-plan/trace
*/
/**
* Where login traces are written. `$DSH_HOME/logs/` keeps them next to the
* other Host logs; `DSH_HOME` defaults to `~/.dsh`.
*/
function traceDir() {
	const home = str(process.env.DSH_HOME, join(homedir(), ".dsh"));
	return join(home, "logs");
}
/**
* Persist one login trace to disk, or fail silently.
*
* Written on EVERY attempt (success included): a "browser works but the panel
* does not" report is only debuggable by diffing a working trace against a
* failing one. The trace itself is already sanitized in sensenova-auth — no
* password, token, cookie, or authorization code ever reaches this file — so
* the only concerns here are I/O failures, which must never break the login
* response.
* @param {object[]|undefined} trace - the sanitized hop list from the auth module.
* @param {string} outcome - "ok" or the error code, for the filename.
* @returns {Promise<string|null>} the file path, or null when not written.
*/
async function writeLoginTrace(trace, outcome) {
	if (!Array.isArray(trace) || trace.length === 0) return null;
	try {
		const dir = traceDir();
		await promises.mkdir(dir, { recursive: true });
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		const file = join(dir, `sensenova-login-${stamp}-${str(outcome, "unknown").replace(/[^a-z_]/gi, "")}.json`);
		await promises.writeFile(file, `${JSON.stringify(trace, null, 2)}\n`, {
			encoding: "utf8",
			mode: 384
		});
		const files = (await promises.readdir(dir)).filter((name) => name.startsWith("sensenova-login-")).sort();
		for (const stale of files.slice(0, Math.max(0, files.length - 20))) await promises.rm(join(dir, stale), { force: true }).catch(() => {});
		return file;
	} catch {
		return null;
	}
}

//#endregion
//#region src/host/routes/account.ts
/**
* The account route — the panel configures itself without editing `.env`.
*
* Part of the routes split (see `../routes.ts` for the family map). Two GET
* answers (stored-state / forgot), one POST (sign in / forget): the form
* never learns the password, and a rejected sign-in reports the platform's
* own words plus the sanitized trace file.
*
* @module dsh-connect-sensenova-token-plan/routes/account
*/
/** The account route: the panel configures itself without editing `.env`. */
const ACCOUNT_PATH = `/api/${name}/account`;
/**
* Register the account route. Wiring subset: `settings`, `tokenStore`,
* `cache`, `inflight`.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {Pick<Wiring, "settings" | "tokenStore" | "cache" | "inflight">} wiring
*   - the subset this route reads, as assembled by `apply()` in `index.ts`.
* @returns {Function} the `off()` unregister callback.
*/
function registerAccountRoute(ctx, wiring) {
	const { settings, tokenStore, cache, inflight } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: ACCOUNT_PATH,
		handler: withOrigin(async (request, response) => {
			const method = request.method === void 0 ? "POST" : request.method;
			if (method === "GET") {
				writeJson(response, 200, {
					ok: true,
					...await tokenStore.state()
				}, { "cache-control": "no-store" });
				return;
			}
			if (method !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			if (body.value.forget === true) {
				try {
					await tokenStore.forgetAccount();
				} catch (error) {
					writeJson(response, 200, {
						...await optional(tokenStore.state()),
						ok: false,
						error: errMsg(error)
					}, { "cache-control": "no-store" });
					return;
				}
				clearCoalescedFetch(cache, inflight);
				writeJson(response, 200, {
					...await tokenStore.state(),
					ok: true
				}, { "cache-control": "no-store" });
				return;
			}
			try {
				await tokenStore.saveAccount({
					username: body.value.username,
					password: body.value.password
				});
			} catch (e) {
				const error = e;
				const traceFile = await writeLoginTrace(error?.trace, str(error?.code, CODE.AUTH_ERROR));
				writeJson(response, 200, {
					...await optional(tokenStore.state()),
					ok: false,
					code: str(error?.code, CODE.AUTH_ERROR),
					error: errMsg(error),
					...error?.detail === void 0 ? {} : { detail: String(error.detail) },
					...traceFile !== null ? { traceFile } : {},
					...typeof error?.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {}
				}, { "cache-control": "no-store" });
				return;
			}
			clearCoalescedFetch(cache, inflight);
			writeJson(response, 200, {
				...await tokenStore.state(),
				ok: true
			}, { "cache-control": "no-store" });
		}, settings.allowedHosts)
	});
}

//#endregion
//#region src/host/routes/api-key.ts
/**
* The inference API-key route (`sk-…`), step three of the one-stop plan.
*
* Part of the routes split (see `../routes.ts` for the family map). The
* secret-free state is all the form ever gets: present or not, and whether it
* came from the credentials service or the environment. Forget drops the
* panel-saved REFERENCE only and re-publishes the empty offer.
*
* @module dsh-connect-sensenova-token-plan/routes/api-key
*/
/** The inference API-key route (`sk-…`), step three of the one-stop plan. */
const API_KEY_PATH = `/api/${name}/api-key`;
/**
* Register the API-key route. Wiring subset: `settings`, `apiKeyStore`,
* `catalogStore`, `providerState`, `publishProvider`, `cache`, `inflight`,
* `logger`.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {Pick<Wiring, "settings" | "apiKeyStore" | "catalogStore" | "providerState" | "publishProvider" | "cache" | "inflight" | "logger">} wiring
*   - the subset this route reads, as assembled by `apply()` in `index.ts`.
* @returns {Function} the `off()` unregister callback.
*/
function registerApiKeyRoute(ctx, wiring) {
	const { settings, apiKeyStore, catalogStore, providerState, publishProvider, cache, inflight, logger } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: API_KEY_PATH,
		handler: withOrigin(async (request, response) => {
			const method = request.method === void 0 ? "GET" : request.method;
			const answer = async (extra = {}) => writeJson(response, 200, {
				ok: true,
				...await optional(apiKeyStore.state(), {
					hasApiKey: false,
					keySource: null,
					ephemeral: false
				}),
				...extra
			}, { "cache-control": "no-store" });
			if (method === "GET") {
				await answer();
				return;
			}
			if (method !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			if (body.value.forget === true) {
				try {
					await apiKeyStore.forget();
					await catalogStore.clear().catch((error) => logger?.warn?.(`${name}: catalog cache clear failed after api-key forget`, error));
					clearCoalescedFetch(cache, inflight);
					await publishProvider([], [], []);
					syncSignaturesAfterPublish(providerState);
					await answer();
				} catch (error) {
					await answer({
						ok: false,
						error: errMsg(error)
					});
				}
				return;
			}
			try {
				await apiKeyStore.save(body.value.apiKey);
			} catch (error) {
				await answer({
					ok: false,
					error: errMsg(error)
				});
				return;
			}
			clearCoalescedFetch(cache, inflight);
			await answer();
		}, settings.allowedHosts)
	});
}

//#endregion
//#region src/host/routes/provider.ts
/**
* The provider-registration switch route.
*
* Part of the routes split (see `../routes.ts` for the family map). GET
* answers the effective switch and where it came from; POST saves a strict
* boolean and publishes immediately with the CURRENT catalog (a failed
* publish rolls back inside `publishProvider`).
*
* @module dsh-connect-sensenova-token-plan/routes/provider
*/
/** The provider-registration switch route (docs/PROVIDER-HOT-RELOAD.md). */
const PROVIDER_PATH = `/api/${name}/provider`;
/**
* Register the provider route. Wiring subset: `settings`, `providerStore`,
* `providerState`, `publishProvider`.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {Pick<Wiring, "settings" | "providerStore" | "providerState" | "publishProvider">} wiring
*   - the subset this route reads, as assembled by `apply()` in `index.ts`.
* @returns {Function} the `off()` unregister callback.
*/
function registerProviderRoute(ctx, wiring) {
	const { settings, providerStore, providerState, publishProvider } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: PROVIDER_PATH,
		handler: withOrigin(async (request, response) => {
			const method = request.method === void 0 ? "GET" : request.method;
			const answer = async (extra = {}) => {
				const panelSwitch = await optional(providerStore.enabled());
				writeJson(response, 200, {
					ok: true,
					registerProvider: resolveSwitchEnabled(panelSwitch, settings.registerProvider),
					registerSource: switchSource(panelSwitch),
					providerRegistered: providerState.registered,
					...providerState.error !== null ? { providerError: providerState.error } : {},
					...extra
				}, { "cache-control": "no-store" });
			};
			if (method === "GET") {
				await answer();
				return;
			}
			if (method !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			if (typeof body.value.enabled !== "boolean") {
				writeJson(response, 400, {
					ok: false,
					error: "expected { enabled: boolean }"
				}, { "cache-control": "no-store" });
				return;
			}
			try {
				await providerStore.save(body.value.enabled);
				await publishProvider(providerState.entries, providerState.enabledIds, providerState.unavailableIds ?? []);
			} catch (error) {
				await answer({
					ok: false,
					error: errMsg(error)
				});
				return;
			}
			await answer();
		}, settings.allowedHosts)
	});
}

//#endregion
//#region src/host/routes/models.ts
/**
* The model-roster curation route.
*
* Part of the routes split (see `../routes.ts` for the family map). POST-only:
* an absent field is refused rather than read as "all models", the curated
* allow-list is capped, and a save re-publishes immediately with the CURRENT
* catalogue (a failed publish rolls back inside `publishProvider`).
*
* @module dsh-connect-sensenova-token-plan/routes/models
*/
/** The model-roster route (docs/API.md). */
const MODELS_PATH = `/api/${name}/models`;
/**
* Register the models route. Wiring subset: `settings`, `catalogStore`,
* `providerStore`, `providerState`, `publishProvider`.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {Pick<Wiring, "settings" | "catalogStore" | "providerStore" | "providerState" | "publishProvider">} wiring
*   - the subset this route reads, as assembled by `apply()` in `index.ts`.
* @returns {Function} the `off()` unregister callback.
*/
function registerModelsRoute(ctx, wiring) {
	const { settings, catalogStore, providerStore, providerState, publishProvider } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: MODELS_PATH,
		handler: withOrigin(async (request, response) => {
			if ((request.method === void 0 ? "POST" : request.method) !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			if (!Array.isArray(body.value.enabledModelIds)) {
				writeJson(response, 400, {
					ok: false,
					error: "expected { enabledModelIds: string[] }"
				}, { "cache-control": "no-store" });
				return;
			}
			const ids = normalizeEnabledIds(body.value.enabledModelIds);
			if (ids.length > 500) {
				writeJson(response, 400, {
					ok: false,
					error: `enabledModelIds is too long (max ${500})`
				}, { "cache-control": "no-store" });
				return;
			}
			const answer = async (extra = {}) => {
				writeJson(response, 200, {
					ok: true,
					enabledModelIds: await optional(catalogStore.listEnabledIds(), providerState.enabledIds),
					registerProvider: resolveSwitchEnabled(await optional(providerStore.enabled()), settings.registerProvider),
					providerRegistered: providerState.registered,
					...providerState.error !== null ? { providerError: providerState.error } : {},
					...extra
				}, { "cache-control": "no-store" });
			};
			try {
				await catalogStore.setEnabledIds(ids);
				await publishProvider(providerState.entries, ids, providerState.unavailableIds ?? []);
				syncSignaturesAfterPublish(providerState);
			} catch (error) {
				await answer({
					ok: false,
					error: errMsg(error)
				});
				return;
			}
			await answer();
		}, settings.allowedHosts)
	});
}

//#endregion
//#region src/host/routes/draw.ts
/**
* The draw-tool switch route.
*
* Part of the routes split (see `../routes.ts` for the family map). GET
* answers the effective switch and model preference with their sources; POST
* distinguishes three purposes by body — a saved boolean, a saved model
* preference (`null` = auto), or a forget. `forget` clears the SWITCH and
* deliberately keeps the model preference (`drawModelId: null` is the model's
* own reset), so the picker choice survives a switch being given back.
*
* @module dsh-connect-sensenova-token-plan/routes/draw
*/
/** The draw-tool switch route (docs/PROVIDER-HOT-RELOAD.md, same discipline). */
const DRAW_PATH = `/api/${name}/draw`;
/**
* Register the draw route. Wiring subset: `settings`, `drawStore`.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {Pick<Wiring, "settings" | "drawStore">} wiring - the subset this
*   route reads, as assembled by `apply()` in `index.ts`. Two of twenty-two:
*   the smallest dependency surface in the family, and now the compiler
*   enforces it.
* @returns {Function} the `off()` unregister callback.
*/
function registerDrawRoute(ctx, wiring) {
	const { settings, drawStore } = wiring;
	return ctx.webServer.register({
		kind: "exact",
		path: DRAW_PATH,
		handler: withOrigin(async (request, response) => {
			const method = request.method === void 0 ? "GET" : request.method;
			const answer = async (extra = {}) => {
				const panelDraw = await optional(drawStore ? drawStore.enabled() : null);
				const panelModel = await optional(drawStore ? drawStore.modelId() : null);
				const effectiveDraw = resolveSwitchEnabled(panelDraw, settings.drawEnabled);
				const effectiveModel = resolveSwitchValue(panelModel, settings.drawModelId);
				writeJson(response, 200, {
					ok: true,
					drawEnabled: effectiveDraw,
					drawSource: switchSource(panelDraw),
					drawModelId: effectiveModel,
					drawModelSource: switchSource(panelModel),
					...extra
				}, { "cache-control": "no-store" });
			};
			if (method === "GET") {
				await answer();
				return;
			}
			if (method !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response);
			if (body === null) return;
			if (body.value.forget === true) {
				if (!drawStore) {
					await answer({
						ok: false,
						error: "draw store is unavailable"
					});
					return;
				}
				try {
					await drawStore.forget();
				} catch (error) {
					await answer({
						ok: false,
						error: errMsg(error)
					});
					return;
				}
				await answer();
				return;
			}
			if (body.value.drawModelId !== void 0) {
				const raw = body.value.drawModelId;
				if (raw !== null && (typeof raw !== "string" || raw.trim() === "")) {
					writeJson(response, 400, {
						ok: false,
						error: "drawModelId expects a non-empty string or null"
					}, { "cache-control": "no-store" });
					return;
				}
				if (!drawStore) {
					await answer({
						ok: false,
						error: "draw store is unavailable"
					});
					return;
				}
				try {
					await drawStore.saveModel(raw);
				} catch (error) {
					await answer({
						ok: false,
						error: errMsg(error)
					});
					return;
				}
				await answer();
				return;
			}
			if (typeof body.value.enabled !== "boolean") {
				writeJson(response, 400, {
					ok: false,
					error: "expected { enabled: boolean }, { drawModelId }, or { forget: true }"
				}, { "cache-control": "no-store" });
				return;
			}
			if (!drawStore) {
				await answer({
					ok: false,
					error: "draw store is unavailable"
				});
				return;
			}
			try {
				await drawStore.save(body.value.enabled);
			} catch (error) {
				await answer({
					ok: false,
					error: errMsg(error)
				});
				return;
			}
			await answer();
		}, settings.allowedHosts)
	});
}

//#endregion
//#region src/host/raccoon-status.ts
/**
* The Raccoon tab's read model: one GET-shaped answer, assembled in one place.
*
* This used to be a 190-line closure inside the `/raccoon` HTTP handler, so it
* was reachable only by mounting the route and driving it with a stub gateway.
* Nothing in it is HTTP — it is a read model over two stores, one publisher and
* one cache — and burying it in a handler meant the eager-refresh gate, the
* cache keys, the `ModelsSource` tri-state and the `?debug=1` scaffold all
* stayed unpinned by any unit test. It lives here now, where
* `test/raccoon-status.test.mjs` drives it with fakes and no route at all.
*
* The ONE thing it does not own is the login walk's transient state — the
* pending scan, the in-flight gate, the settled outcome. That is route
* lifecycle (it drives a publisher and reads a catalogue), so the route hands
* it in through {@link RaccoonLoginView} rather than the module reaching for
* it. `test/raccoon.test.mjs` keeps covering that side.
*
* @module dsh-connect-sensenova-token-plan/raccoon-status
*/
/**
* How long one Raccoon balance read stays fresh.
*
* The tab polls every 60 s, and while a QR scan is waiting it polls every 2 s —
* without a cache that fast poll is 30 gateway calls a minute for a number that
* moves when the account spends. The window matches the slow cadence, so a
* scan's fast poll costs the same two calls a minute the idle tab does.
*/
const RACCOON_BALANCE_TTL_MS = 6e4;
/**
* How long one Raccoon catalogue read stays fresh (longer: the roster drifts
* when the gateway adds a model, not while a session is open).
*/
const RACCOON_CATALOG_TTL_MS = 3e5;
/**
* The proxy variables the diagnostics report — names only, and only when set.
*
* A hop between this Host and the gateway is the one thing a fresh-process
* probe cannot see, and it is the shape of "same file, probe 200, panel 401".
*/
const PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"http_proxy",
	"https_proxy",
	"ALL_PROXY",
	"NO_PROXY",
	"no_proxy"
];
/**
* A secret-free, stable identity for one access token, used as the cache key
* half so a rotated credential never reads the previous one's answer.
* @param {string} token - the access token (never stored, never logged).
* @returns {string} a 12-hex-character digest prefix.
*/
function tokenFingerprint(token) {
	return createHash("sha256").update(typeof token === "string" ? token : "", "utf8").digest("hex").slice(0, 12);
}
/**
* Mask a proxy URL's userinfo before it leaves the process.
*
* `hostProxyEnv` answers one question — "is there a hop between this Host and
* the gateway?" — and the hop is the host:port. The credentials are not part of
* that answer, yet a corporate proxy is routinely spelled
* `http://user:password@proxy:8080`, so reporting the value verbatim would put
* a live password into an HTTP response body. A diagnostic must never be worth
* more than the fact it carries.
*
* Both spellings are handled (with and without a scheme) and an unparseable
* value is masked textually rather than assumed clean; a value with no userinfo
* is returned untouched, so the hop still reads.
* @param {string} key - the environment variable's name.
* @param {string|undefined} value - its value.
* @returns {string} the `KEY=value` pair, with any userinfo replaced by `***`.
*/
function maskProxyUserinfo(key, value) {
	return `${key}=${str(value, "").replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)?[^/@]*@/i, "$1***@")}`;
}
/**
* Assemble the tab's read model.
*
* @param {RaccoonStatusDeps} deps - the stores, cache and login view.
* @param {boolean} [withDiagnostics] - opt into the `?debug=1` triage scaffold.
*   The POST branches re-report through this same function WITHOUT the flag,
*   so a mutation never answers with environment values.
* @returns {Promise<RaccoonState>} the secret-free state the tab renders.
*/
async function readRaccoonStatus(deps, withDiagnostics = false) {
	const { status: loginStatus, error: loginError } = deps.login.takeEvent();
	const store = deps.store ?? null;
	const switchStore = deps.switchStore ?? null;
	const read = deps.read;
	const switchState = await optional(switchStore ? switchStore.enabled() : null);
	const effectiveEnabled = switchState === true;
	let loggedIn = false;
	let nickname = "";
	let balance = null;
	let balanceBreakdown = null;
	let balanceDetail = null;
	let accessTokenPrefix = null;
	let credentialSource = null;
	let raccoonEnvShadow = null;
	let envCredentialFingerprint = null;
	let accessTokenFingerprint = null;
	let hostProxyEnv = null;
	let error = null;
	let expiresAtMs = null;
	let credentialExpired = false;
	let refreshExpiresAtMs = null;
	try {
		if (store !== null) {
			let state = await store.state().catch(() => null);
			loggedIn = state?.hasCredential === true;
			nickname = state?.nickname ?? "";
			credentialSource = state?.source ?? null;
			if (loggedIn) {
				if (await store.isExpired().catch(() => false)) {
					await store.refresh().catch(() => {});
					state = await store.state().catch(() => state);
					loggedIn = state?.hasCredential === true;
					nickname = state?.nickname ?? "";
					credentialSource = state?.source ?? null;
				}
				if (typeof state?.expiresAtMs === "number") {
					expiresAtMs = state.expiresAtMs;
					credentialExpired = Date.now() >= state.expiresAtMs;
				}
				if (typeof state?.refreshExpiresAtMs === "number") refreshExpiresAtMs = state.refreshExpiresAtMs;
				const { credential } = await store.resolve().catch(() => ({ credential: null }));
				if (credential?.accessToken) {
					if (withDiagnostics) {
						accessTokenPrefix = credential.accessToken.slice(0, 8);
						accessTokenFingerprint = tokenFingerprint(credential.accessToken);
					}
					const balanceRead = await read.read(`balance:${tokenFingerprint(credential.accessToken)}`, () => fetchRaccoonBalance(credential, void 0, (why) => {
						balanceDetail = why;
					}), RACCOON_BALANCE_TTL_MS).catch((why) => {
						balanceDetail = `call rejected: ${errMsg(why)}`;
						return null;
					});
					balance = balanceRead?.total ?? null;
					if (balanceRead !== null && balanceRead !== void 0) {
						const parts = {};
						if (balanceRead.daily !== void 0) parts.daily = balanceRead.daily;
						if (balanceRead.reward !== void 0) parts.reward = balanceRead.reward;
						if (balanceRead.monthly !== void 0) parts.monthly = balanceRead.monthly;
						if (balanceRead.topup !== void 0) parts.topup = balanceRead.topup;
						if (Object.keys(parts).length > 0) balanceBreakdown = parts;
					}
				}
			}
		}
	} catch (why) {
		error = redactSecrets(errMsg(why));
	}
	if (withDiagnostics) {
		raccoonEnvShadow = Object.hasOwn(process.env, "RACCOON_CREDENTIAL") && process.env.RACCOON_CREDENTIAL !== "";
		if (raccoonEnvShadow) envCredentialFingerprint = tokenFingerprint(process.env.RACCOON_CREDENTIAL ?? "");
		hostProxyEnv = PROXY_ENV_KEYS.filter((key) => process.env[key] !== void 0 && process.env[key] !== "").map((key) => maskProxyUserinfo(key, process.env[key]));
	}
	let models = null;
	let catalogReadFailed = false;
	try {
		if (store !== null) {
			const { credential } = await store.resolve().catch(() => ({ credential: null }));
			if (credential?.accessToken) models = await read.read(`catalog:${tokenFingerprint(credential.accessToken)}`, () => fetchRaccoonCatalog(credential, void 0, () => {
				catalogReadFailed = true;
			}), RACCOON_CATALOG_TTL_MS).catch(() => {
				catalogReadFailed = true;
				return null;
			});
		}
	} catch {
		models = null;
		catalogReadFailed = true;
	}
	const rosterLive = models !== null && Array.isArray(models) && models.length > 0;
	const roster = rosterLive ? models : RACCOON_FALLBACK_MODELS;
	const modelsSource = rosterLive ? "live" : catalogReadFailed ? "unreadable" : "empty";
	const publisherState = deps.publisher?.state ?? null;
	const savedIds = await optional(switchStore ? switchStore.enabledIds() : null);
	const scan = deps.login.liveScan();
	const diagnostics = withDiagnostics ? {
		...pickDefined({ accessTokenPrefix }),
		...pickDefined({ credentialSource }),
		raccoonEnvShadow: raccoonEnvShadow === true,
		...pickDefined({ envCredentialFingerprint }),
		...pickDefined({ accessTokenFingerprint }),
		hostProxyEnv
	} : {};
	return {
		ok: true,
		enabled: effectiveEnabled,
		switchSource: switchState === null ? "off" : "panel",
		pollSeconds: RACCOON_BALANCE_TTL_MS / 1e3,
		scanPollSeconds: RACCOON_QR_POLL_INTERVAL_MS / 1e3,
		loggedIn,
		nickname,
		credentialExpired,
		...pickDefined({ expiresAtMs }),
		...pickDefined({ refreshExpiresAtMs }),
		...pickDefined({
			scanUrl: scan?.url,
			scanCode: scan?.code
		}),
		...pickDefined({ loginStatus }),
		...loginError !== null && loginError !== "" ? { loginError } : {},
		balance,
		...pickDefined({ balanceBreakdown }),
		...pickDefined({ balanceDetail }),
		...diagnostics,
		models: roster,
		modelsSource,
		enabledModelIds: savedIds,
		providerRegistered: publisherState?.registered === true,
		...pickDefined({ providerError: publisherState?.error }),
		...pickDefined({ error })
	};
}

//#endregion
//#region src/host/raccoon-walk.ts
/**
* The Raccoon QR login walk — a single-responsibility module for the
* in-flight scan lifecycle.
*
* Why this lives outside `routes.ts`: the scan code must stay stable while a
* walk is waiting, otherwise two walks each own a different code and the GET
* can only ever report one — a scan that looks permanently stuck, with no
* error anywhere to explain it (PITFALLS §31, test T2). The walk also needs
* access to the cache (to clear it on login/logout) and to the publish layer
* (to register the provider on successful login), so burying it inside a
* route handler meant either leaking those seams through the handler or
* duplicating them.
*
* What this module owns (and nothing else):
*   - issuing a scan code
*   - polling the gateway until settle or timeout
*   - persisting the credential pair (delegates to callers)
*   - clearing the read cache on settle
*   - firing the logged-in side-effect hook (`onLoggedIn`) after the
*     credential landed
*   - emitting the settled outcome as an event
*
* Callers register the business-step callbacks (save, invalidate, onLoggedIn)
* ONCE at construction; the walk drives them at the right point of the
* lifecycle. `onLoggedIn` is where provider registration happens — the login
* branch used to fake it by assigning `invalidateCache` onto the returned
* object, a write nobody reads (the walk's own `invalidateCache` is the one
* captured at construction). The walk module holds only the transient screen —
* the scan code, the in-flight gate, the event that the GET returns.
*
* @module dsh-connect-sensenova-token-plan/raccoon-walk
*/
/** The terminal outcomes the tab reads. */
const LOGIN_STATUS = Object.freeze({
	scanning: "scanning",
	logged_in: "logged_in",
	timeout: "timeout",
	canceled: "canceled",
	failed: "failed"
});
/**
* Build the walk manager.
*
* @param options
* @param options.fetcher - the gateway fetcher (for tests to inject a fake).
* @param options.saveCredential - called with `{ accessToken, refreshToken, expiresAtMs?, nickname? }`; MUST persist to the credentials service. Errors become a `failed` event.
* @param options.invalidateCache - called on successful login to drop reads taken under the previous credential.
* @param options.onSettled - called once at the START of each scan cycle (after
*   the QR code is generated, before the poll loop begins), regardless of the
*   outcome. Kept for callers that want to reset per-scan UI state; the read
*   model's `login` view reads the walk's own state (`takeEvent` / `liveScan`),
*   not this hook, so the route registers it as a no-op.
* @param options.onLoggedIn - called AFTER the credential was persisted and the
*   read cache cleared, with the outcome already `logged_in`. The caller's
*   provider-registration side effect lives here. Its failures are swallowed:
*   the credential is already in place, so a publish miss is a degraded-but-
*   logged-in state, never a login failure.
* @returns {{ view: RaccoonWalkView, issueScan: () => Promise<void> }}
*/
function createRaccoonWalk(options) {
	let scan = null;
	/** `null` while idle; a promise while the walk runs. Cleared in finally. */
	let walk = null;
	let status = null;
	let error = null;
	const view = {
		isInFlight: () => walk !== null,
		liveScan: () => scan,
		takeEvent: () => {
			const took = {
				status,
				error
			};
			if (status !== null && status !== LOGIN_STATUS.scanning) {
				status = null;
				error = null;
			}
			return took;
		}
	};
	/**
	* Run one scan cycle. Errors from save or settle do NOT propagate — they
	* become a `failed` event so the tab can surface a reason.
	*/
	async function runScan() {
		const code = generateRaccoonQrCode();
		scan = {
			code,
			url: raccoonQrLoginUrl(code)
		};
		status = LOGIN_STATUS.scanning;
		error = null;
		options.onSettled();
		const deadline = Date.now() + RACCOON_LOGIN_TIMEOUT_MS;
		let canceled = false;
		let settled = null;
		try {
			try {
				while (Date.now() < deadline) {
					let poll;
					try {
						poll = await options.fetcher(code);
					} catch {
						poll = { status: RACCOON_QR_STATUS.PENDING };
					}
					if (poll.status === RACCOON_QR_STATUS.SUCCESS) {
						settled = poll;
						break;
					}
					if (poll.status === RACCOON_QR_STATUS.CANCELED) {
						canceled = true;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, RACCOON_QR_POLL_INTERVAL_MS));
				}
			} finally {}
			if (settled === null) {
				status = canceled ? LOGIN_STATUS.canceled : LOGIN_STATUS.timeout;
				return;
			}
			try {
				await options.saveCredential({
					accessToken: settled.accessToken,
					refreshToken: settled.refreshToken,
					...settled.expiresAtMs !== void 0 ? { expiresAtMs: settled.expiresAtMs } : {},
					...settled.nickname !== void 0 && settled.nickname !== "" ? { nickname: settled.nickname } : {}
				});
				options.invalidateCache();
				status = LOGIN_STATUS.logged_in;
				try {
					options.onLoggedIn?.();
				} catch {}
			} catch (saveError) {
				status = LOGIN_STATUS.failed;
				error = String(saveError instanceof Error ? saveError.message : saveError);
			}
		} finally {
			walk = null;
		}
	}
	async function issueScan() {
		walk = runScan().catch(() => {
			status = LOGIN_STATUS.failed;
			error = error ?? null;
		});
	}
	return {
		view,
		issueScan
	};
}

//#endregion
//#region src/host/routes/raccoon.ts
/**
* The Raccoon route (ROADMAP §6.1 "second upstream provider"): one GET
* reporting the secret-free state a tab renders, one POST carrying `{ action }`
* for the four panel actions. The QR login is a single server-side walk (no
* client long-poll); the credential never touches this plugin's directory,
* git, or logs — it goes straight to the DSH credentials service through
* `raccoonStore`.
*
* Part of the routes split (see `../routes.ts` for the family map). The walk
* lifecycle is owned by `raccoon-walk.ts`: one instance for the entire route,
* so a second click / tab mid-walk sees the SAME scan (concurrency gate via
* `view.isInFlight()`). The route only drives the side-effects and reads the
* transient state through `view`; one scan per process, cleared on settle, no
* handler-local state survives a re-mount.
*
* @module dsh-connect-sensenova-token-plan/routes/raccoon
*/
/** The Raccoon provider route (ROADMAP §6.1 "second upstream provider"). */
const RACCOON_PATH = `/api/${name}/raccoon`;
/**
* Register the Raccoon route. Wiring subset: `settings`, `raccoonStore`,
* `raccoonSwitch`, `raccoonPublisher`, `raccoonCache`.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {Pick<Wiring, "settings" | "raccoonStore" | "raccoonSwitch" | "raccoonPublisher" | "raccoonCache">} wiring
*   - the Raccoon half's subset, as assembled by `apply()` in `index.ts`. The
*   `Pick` is what makes "changing the Raccoon line must not affect the Token
*   Plan one" (ARCHITECTURE §5.5) a compile-time fact rather than a review
*   promise: this route physically cannot reach a Token Plan field.
* @returns {Function} the `off()` unregister callback.
*/
function registerRaccoonRoute(ctx, wiring) {
	const { settings, raccoonStore, raccoonSwitch, raccoonPublisher, raccoonCache } = wiring;
	const raccoonRead = raccoonCache ?? createCoalescedFetch();
	async function collectRaccoonRows(catalogToken) {
		let rows = RACCOON_FALLBACK_MODELS;
		let officeIdentity = "";
		try {
			const { credential } = await optional(raccoonStore ? raccoonStore.resolve() : null, { credential: null });
			if (catalogToken !== void 0 && catalogToken !== null && catalogToken !== "") {
				const live = await optional(raccoonRead.read(`catalog:${tokenFingerprint(str(catalogToken, ""))}`, () => fetchRaccoonCatalog({ access_token: catalogToken }), RACCOON_CATALOG_TTL_MS));
				if (live !== null && live.length > 0) rows = live;
			} else if (credential?.accessToken) {
				const live = await optional(raccoonRead.read(`catalog:${tokenFingerprint(credential.accessToken)}`, () => fetchRaccoonCatalog(credential), RACCOON_CATALOG_TTL_MS));
				if (live !== null && live.length > 0) rows = live;
				officeIdentity = credential.officeIdentity ?? "";
			}
		} catch {}
		const ids = await optional(raccoonSwitch ? raccoonSwitch.enabledIds() : null);
		return {
			rows: filterRaccoonRows(rows, ids),
			officeIdentity
		};
	}
	const raccoonWalkManager = createRaccoonWalk({
		fetcher: (code) => pollRaccoonQrLogin(code),
		saveCredential: (credential) => raccoonStore ? raccoonStore.save(credential) : Promise.reject(/* @__PURE__ */ new Error("no raccoon credential store")),
		invalidateCache: () => raccoonRead.clear(),
		onSettled: () => {},
		onLoggedIn: () => {
			if (raccoonPublisher === null || raccoonPublisher === void 0 || raccoonPublisher.isDisposed()) return;
			optional(raccoonSwitch?.enabled()).then((sw) => {
				if (sw === true) collectRaccoonRows(null).then(({ rows, officeIdentity }) => {
					raccoonPublisher.publish(rows, officeIdentity);
				}).catch(() => {});
			}).catch(() => {});
		}
	});
	const walkView = raccoonWalkManager.view;
	return ctx.webServer.register({
		kind: "exact",
		path: RACCOON_PATH,
		handler: withOrigin(async (request, response) => {
			const raccoonState = (withDiagnostics = false) => readRaccoonStatus({
				store: raccoonStore,
				switchStore: raccoonSwitch,
				publisher: raccoonPublisher,
				read: raccoonRead,
				login: walkView
			}, withDiagnostics);
			const method = request.method === void 0 ? "GET" : request.method;
			if (method === "GET") {
				writeJson(response, 200, await raccoonState(wantsDiagnostics(request)), { "cache-control": "no-store" });
				return;
			}
			if (method !== "POST") {
				refuseMethod(response);
				return;
			}
			const body = await readJsonBodyOr400(request, response, MAX_RACCOON_BODY_BYTES);
			if (body === null) return;
			const { action } = body.value;
			const answer = async (extra = {}) => {
				const state = await raccoonState();
				writeJson(response, 200, {
					...state,
					...extra
				}, { "cache-control": "no-store" });
			};
			if (action === "switch") {
				if (typeof body.value.enabled !== "boolean") {
					writeJson(response, 400, {
						ok: false,
						error: "expected { action: \"switch\", enabled: boolean }"
					}, { "cache-control": "no-store" });
					return;
				}
				if (raccoonSwitch === null || raccoonSwitch === void 0) {
					await answer({
						ok: false,
						error: "the raccoon switch is unavailable"
					});
					return;
				}
				try {
					await raccoonSwitch.save(body.value.enabled);
					if (raccoonPublisher !== null && raccoonPublisher !== void 0) {
						const { rows, officeIdentity } = await collectRaccoonRows(null);
						await raccoonPublisher.publish(rows, officeIdentity);
					}
				} catch (error) {
					await answer({
						ok: false,
						error: errMsg(error)
					});
					return;
				}
				await answer();
				return;
			}
			if (action === "models") {
				const ids = body.value.enabledModelIds;
				if (!Array.isArray(ids) || ids.some((entry) => typeof entry !== "string")) {
					writeJson(response, 400, {
						ok: false,
						error: "expected { action: \"models\", enabledModelIds: string[] }"
					}, { "cache-control": "no-store" });
					return;
				}
				if (ids.length > 500) {
					writeJson(response, 400, {
						ok: false,
						error: "too many model ids"
					}, { "cache-control": "no-store" });
					return;
				}
				if (raccoonSwitch === null || raccoonSwitch === void 0) {
					await answer({
						ok: false,
						error: "the raccoon switch is unavailable"
					});
					return;
				}
				try {
					await raccoonSwitch.saveIds(ids);
					if (raccoonPublisher !== null && raccoonPublisher !== void 0) {
						const { rows, officeIdentity } = await collectRaccoonRows(null);
						await raccoonPublisher.publish(rows, officeIdentity);
					}
				} catch (error) {
					await answer({
						ok: false,
						error: errMsg(error)
					});
					return;
				}
				await answer({
					ok: true,
					saved: true
				});
				return;
			}
			if (action === "login") {
				if (raccoonStore === null || raccoonStore === void 0) {
					await answer({
						ok: false,
						error: "the raccoon credential store is unavailable"
					});
					return;
				}
				if (walkView.isInFlight()) {
					const cur = walkView.liveScan();
					await answer({
						ok: true,
						status: LOGIN_STATUS.scanning,
						scanUrl: cur.url,
						scanCode: cur.code
					});
					return;
				}
				raccoonWalkManager.issueScan();
				const cur = walkView.liveScan();
				await answer({
					ok: true,
					status: LOGIN_STATUS.scanning,
					scanUrl: cur.url,
					scanCode: cur.code
				});
				return;
			}
			if (action === "logout") {
				if (raccoonStore === null || raccoonStore === void 0) {
					await answer({
						ok: false,
						error: "the raccoon credential store is unavailable"
					});
					return;
				}
				try {
					await raccoonStore.forget();
					raccoonRead.clear();
					if (raccoonPublisher !== null && raccoonPublisher !== void 0) await raccoonPublisher.publish(RACCOON_FALLBACK_MODELS, "");
				} catch (error) {
					await answer({
						ok: false,
						error: errMsg(error)
					});
					return;
				}
				await answer({
					ok: true,
					status: "logged_out"
				});
				return;
			}
			writeJson(response, 400, {
				ok: false,
				error: "expected { action: \"switch\"|\"models\"|\"login\"|\"logout\" }"
			}, { "cache-control": "no-store" });
		}, settings.allowedHosts)
	});
}

//#endregion
//#region src/host/routes.ts
/**
* The HTTP route handlers — the registry facade of the routes family.
*
* `apply()` (in `index.ts`) stays the single mount seam: it assembles a
* `wiring` object and hands it to {@link registerRoutes}; each route is its
* own module (one per resource) that closes over the wiring, so a route never
* imports a service directly. Nothing here imports a Host peer — the only
* lazy peer loads (the adapter / tools modules) live in `lifecycle.ts` and
* are injected from `apply` via `deps`.
*
* 2026-10 split (the token-store playbook: behaviour frozen first —
* `routes.test.mjs` + `wiring.test.mjs` ran green against THIS facade,
* unchanged, before and after the move). The family:
*
*   - `routes/http.ts`      — the shared primitives (writeJson, the bounded
*                             body reader, the fence/method refusals, the
*                             body ceilings);
*   - `routes/snapshot.ts`  — the polled read-only snapshot (and the
*                             failure-code taxonomy);
*   - `routes/account.ts`   — panel sign-in / forget, trace writes;
*   - `routes/api-key.ts`   — the `sk-` reference, forget-and-republish;
*   - `routes/provider.ts`  — the registration switch;
*   - `routes/models.ts`    — the curated allow-list;
*   - `routes/draw.ts`      — the draw-tool switch;
*   - `routes/raccoon.ts`   — the second-upstream provider (switch / models /
*                             login / logout).
*
* The registration ORDER is load-bearing: the returned `off()` callbacks run
* in this order on teardown. Public API and export surface are unchanged.
*
* @module dsh-connect-sensenova-token-plan/routes
*/
/**
* Register the six Token Plan routes plus the Raccoon route on the Host's web
* server. Each route is its own module; this assembler only decides what they
* may touch (the wiring) and hands back the unregister callbacks, in
* registration order — `teardown` runs them last.
* @param ctx - the host root context (only `ctx.webServer` is used here).
* @param {Wiring} wiring - assembled by `apply()` in `index.ts`.
* @returns {Array<() => void>} the seven `off()` unregister callbacks, in
*   registration order. Spelled out rather than `Function[]` so it matches
*   what `teardown` now accepts — and note that a JSDoc type is a COMMENT
*   here, not a type source, so `tsc` never checked this line either way.
*   The real guarantee for each route is its own `Pick<Wiring, …>` parameter.
*/
function registerRoutes(ctx, wiring) {
	return [
		registerSnapshotRoute(ctx, wiring),
		registerAccountRoute(ctx, wiring),
		registerApiKeyRoute(ctx, wiring),
		registerProviderRoute(ctx, wiring),
		registerModelsRoute(ctx, wiring),
		registerDrawRoute(ctx, wiring),
		registerRaccoonRoute(ctx, wiring)
	];
}

//#endregion
//#region src/host/lifecycle.ts
/**
* The plugin's side effects — the parts of mounting that are not route
* handlers.
*
* `apply()` is the single mount seam: it assembles the `wiring` object, calls
* {@link registerRoutes} (routes.ts), then {@link startSideEffects} for:
*
*   - the mount seed (`seedPublisherFromCatalog`): offer models before the
*     first poll, fire-and-forget;
*   - the draw tool registration (opt-in `drawEnabled`, doubly degraded);
*   - vision step two: the settings-row writer filled for the snapshot route.
*
* and {@link teardown} for the unmount order that PITFALLS §18 pins: dispose
* both publishers, release both pairs, then run the route `off` callbacks —
* the Raccoon publisher is disposed in the order it registered, so a late
* publish cannot register into a withdrawing Host. It must NOT be simplified.
*
* Peer-free discipline: no Host peer is imported here. The only lazy peer
* loads (the adapter / tools modules) are injected from `apply` via `deps`.
*
* @module dsh-connect-sensenova-token-plan/lifecycle
*/
/** How many times a mount-time optional-service read is retried. */
const SERVICE_RETRY_ATTEMPTS = 3;
/** Base backoff between service-read attempts (× attempt index). */
const SERVICE_RETRY_DELAY_MS = 300;
/**
* Read an optional Host service with a bounded retry.
*
* A service may register AFTER this plugin mounts — the note on vision step
* two below said so — and a mount-time read is the only window for a
* capability the Host cannot later remove: the tools registry has no
* unregister call, and the settings row is only written by a poll that finds
* `visionPublish.current` already filled. A one-shot read therefore misses a
* service that arrives a moment late for the WHOLE session, silently — the
* draw tool would be absent with the switch visibly on, the vision list never
* written, and no line on any panel naming the reason. The Raccoon publisher
* got the same bounded retry for its mount seed.
*
* This retries the READ ONLY. Whatever it returns is used exactly once by the
* caller: retrying a call that mutates (a tool registration) would register
* the same tool twice, and the tools registry cannot tell.
*
* The loop itself is the shared `retryBounded` (`util.ts`) — the same backoff
* shape the Raccoon mount seed uses; only the window length is set here.
* @template T - the shape of the service being waited for. The reader knows
*   what it wants (`{ register }` for tools, `{ update }` for settings); this
*   function only knows a name, so the shape is declared at the call site and
*   the `as T` below is the single place that claim is trusted. Defaulting to
*   `unknown` means a caller that forgets the parameter gets a type it cannot
*   accidentally dereference — which is the failure the old `Promise<any>`
*   invited on every one of its seven property reads.
* @param {object} ctx - the host root context.
* @param {string} service - the service name for `ctx.get`.
* @param {object} [options]
* @param {() => boolean} [options.isDisposed] - stop early when the plugin is
*   withdrawing; a late registration into a withdrawing Host is worse than
*   absence.
* @param {number} [options.attempts] - test seam for the attempt count.
* @param {number} [options.delayMs] - test seam for the backoff base.
* @returns {Promise<T|null>} the service, or `null` when it never appeared
*   inside the window.
*/
async function resolveServiceWithRetry(ctx, service, options = {}) {
	const { isDisposed = () => false, attempts = SERVICE_RETRY_ATTEMPTS, delayMs = SERVICE_RETRY_DELAY_MS } = options;
	let found = null;
	await retryBounded({
		attempts,
		delayMs,
		run: () => {
			if (isDisposed()) return true;
			try {
				const value = ctx.get?.(service) ?? ctx[service] ?? null;
				if (value !== null && value !== void 0) {
					found = value;
					return true;
				}
			} catch {}
			return false;
		}
	});
	return found;
}
/**
* Register the `sensenova_draw_image` agent tool (ARCHITECTURE.md §5.4,
* route B). Opt-in (`drawEnabled`, default off) and doubly degraded — a Host
* with no tools service never sees it, and a peer that fails to load leaves
* the panel and the provider untouched. Named as a separate export so a test
* can inject its own `ctx`/`wiring`; `startSideEffects` calls it when enabled.
* @param ctx - the host root context (reads `ctx.get("tools")` / `ctx.tools`).
* @param {DrawToolWiring} wiring - the seven fields read below.
* @param {object} side - test seams from `apply`'s `deps`.
* @param {Function} side.loadToolsModule - lazy `@deepseek-ai/dsh-tools` loader.
* @param {Function} side.drawFetch - draw request fetch (stubbed in tests).
* @returns {Promise<void>}
*/
async function registerDrawTool(ctx, wiring, side) {
	const { settings, configError, providerState, catalogStore, resolveApiKey, publisher, drawStore } = wiring;
	const { loadToolsModule, drawFetch } = side;
	resetDrawToolState();
	if (configError !== null) return;
	if (resolveSwitchEnabled(drawStore ? await drawStore.enabled().catch(() => null) : null, settings.drawEnabled) !== true) return;
	const panelModelId = drawStore ? await drawStore.modelId().catch(() => null) : null;
	const effectiveSettings = panelModelId !== null ? {
		...settings,
		drawModelId: panelModelId
	} : settings;
	const tools = await resolveServiceWithRetry(ctx, "tools", { isDisposed: () => publisher.isDisposed() });
	if (tools === null || typeof tools.register !== "function") {
		markDrawToolAbsent();
		return;
	}
	let defineTool;
	try {
		const mod = await Promise.resolve(loadToolsModule());
		defineTool = mod?.defineTool ?? mod?.default?.defineTool ?? null;
	} catch (error) {
		degrade("draw: tools peer module failed to load", error, wiring.logger, null);
		return;
	}
	if (typeof defineTool !== "function") return;
	try {
		tools.register(defineDrawTool({
			defineTool,
			resolveApiKey,
			getEntries: async () => {
				const live = Array.isArray(providerState.entries) && providerState.entries.length > 0 ? providerState.entries : await catalogStore.list().catch(() => []);
				return Array.isArray(live) ? live : [];
			},
			settings: effectiveSettings,
			fetchImpl: drawFetch,
			isDisposed: () => publisher.isDisposed()
		}));
	} catch (error) {
		degrade("draw: tools registry refused the registration", error, wiring.logger, null);
	}
}
/**
* The Raccoon mount seed (ROADMAP §6.1 second upstream) — the fire-and-forget
* boot of the Raccoon half, exported on its own so the
* orchestrator in `index.ts` stays a thin assembly: the seed is a side effect
* (it touches the credential store, the switch, the gateway, and the
* publisher), not part of "what a route may touch", so it belongs with the
* other mount side effects here.
*
* Fire-and-forget: the caller `void`s the returned promise. If the switch is
* already on and a credential was stored before this restart, this offers the
* Raccoon models before the first poll (and with no console login at all).
* The roster is rebuilt from the store, NOT from `raccoonPublisher.state.rows`
* — that field is in-memory only and empty on a fresh process, so gating on
* it meant a restarted Host never re-registered the provider (the panel said
* "logged in" and the tab listed models, but the picker saw none). With NO
* credential there is nothing to offer, so the publisher stays pristine and
* the tab keeps its "switch on — scan to log in" state.
* @param {object} wiring - the Raccoon half of the mount wiring.
* @param {object} wiring.raccoonStore - the Raccoon credential store.
* @param {object} wiring.raccoonSwitch - the Raccoon switch store.
* @param {object} wiring.raccoonPublisher - the Raccoon publisher.
* @returns {Promise<void>} the fire-and-forget seed.
*/
function seedRaccoonOnMount({ raccoonStore, raccoonSwitch, raccoonPublisher }) {
	const seedAttempts = 6;
	const seedDelayMs = 300;
	return (async () => {
		try {
			await retryBounded({
				attempts: seedAttempts,
				delayMs: seedDelayMs,
				run: async () => {
					if (raccoonPublisher.isDisposed()) return true;
					if (await raccoonSwitch.enabled().catch(() => null) !== true) return true;
					const { credential } = await raccoonStore.resolve().catch(() => ({ credential: null }));
					if (!credential?.accessToken) return false;
					if (await raccoonStore.isExpired().catch(() => false)) await raccoonStore.refresh().catch(() => {});
					const { credential: live } = await raccoonStore.resolve().catch(() => ({ credential: null }));
					let rows = [...RACCOON_FALLBACK_MODELS];
					if (live?.accessToken) {
						const catalog = await fetchRaccoonCatalog(live).catch(() => null);
						if (catalog !== null && catalog.length > 0) rows = catalog;
					}
					const curated = await raccoonSwitch.enabledIds().catch(() => null);
					await raccoonPublisher.publish(filterRaccoonRows(rows, curated), live?.officeIdentity ?? "").catch(() => {});
					if (raccoonPublisher.state.registered === true) return true;
					if (raccoonPublisher.isDisposed()) return true;
					return false;
				}
			});
		} catch {}
	})();
}
/**
* Run the mount-time side effects: the persisted-catalog seed, the draw tool
* (when opted in), and vision step two's settings-row writer.
* @param ctx - the host root context.
* @param {Wiring} wiring - assembled by `apply()`; the fields read here are
*   `settings` / `visionPublish` / `logger` plus the whole {@link DrawToolWiring}
*   it forwards to {@link registerDrawTool}. The per-field notes that used to
*   sit here are what the {@link Wiring} declaration now says instead.
* @param {object} side - test seams from `apply`'s `deps`
*   (`loadToolsModule`, `drawFetch`).
* @returns {void} — seed and draw are fire-and-forget.
*/
function startSideEffects(ctx, wiring, side) {
	const { publisher, catalogStore, settings, visionPublish } = wiring;
	seedPublisherFromCatalog(publisher, () => catalogStore.list(), () => catalogStore.listEnabledIds(), catalogSignature);
	registerDrawTool(ctx, wiring, side);
	(async () => {
		try {
			const settingsService = await resolveServiceWithRetry(ctx, "settings", { isDisposed: () => publisher.isDisposed() });
			if (settingsService === null || typeof settingsService.update !== "function") return;
			const descriptorOf = () => {
				try {
					const view = settingsService.describe?.({ redactSecrets: true });
					return (Array.isArray(view) ? view : view?.entries ?? []).find((candidate) => candidate?.ns === "dsh-connect-sensenova-token-plan") ?? null;
				} catch {
					return null;
				}
			};
			let publishing = false;
			let lastPublishedIds = settings.imageModelIds.slice();
			visionPublish.current = async (visionEntries, ids) => {
				if (settings.writeImageModelIds !== true) return;
				if (publishing) return;
				if (JSON.stringify(lastPublishedIds) === JSON.stringify(ids)) return;
				const descriptor = descriptorOf();
				if (descriptor === null) return;
				publishing = true;
				try {
					await settingsService.update(name, {
						imageModelIds: ids,
						visionModels: visionEntries
					}, descriptor.revision);
					lastPublishedIds = ids.slice();
				} catch (error) {
					wiring.logger?.warn?.(`${name}: vision publish refused: ${errMsg(error)}`);
				} finally {
					publishing = false;
				}
			};
		} catch {}
	})();
}
/**
* Unmount, in the order PITFALLS §18 pins:
*
*   1. `dispose` — a publish still in flight (the mount seed's, or a poll's)
*      must not register into a Host that is letting this plugin go;
*   2. `release` — stop offering the provider first, so a request cannot be
*      routed to an adapter whose Host services are already half gone;
*   3. the route `off()` callbacks, each guarded (the web server may already
*      be gone during shutdown).
*
* This order is a concurrency fix and must NOT be simplified.
* @param {Wiring} wiring - assembled by `apply()`; only the publisher pair
*   and the release are read, so the type says exactly three fields.
* @param {Array<() => void>} offs - the unregister callbacks from
*   {@link registerRoutes}. `Function[]` was the old spelling and it is
*   `any[]` in disguise — a `Function` may be called with any arguments and
*   return anything, so it pinned neither the shape nor the arity.
* @returns {void}
*/
function teardown(wiring, offs) {
	const { publisher, releaseProvider, raccoonPublisher } = wiring;
	publisher.dispose();
	raccoonPublisher?.dispose();
	raccoonPublisher?.release?.();
	releaseProvider();
	for (const off of offs) try {
		off();
	} catch {}
}

//#endregion
//#region src/host/index.ts
/**
* dsh-connect-sensenova-token-plan — Host half (thin router).
*
* Reads the SenseNova Token Plan quota through the platform's own console API
* (the same endpoints the web console calls) and serves the result to the
* Client panel over one read-only `/api` route.
*
* The heavy lifting lives in focused sibling modules so this file stays a
* readable orchestrator:
*
*   - `host-config.ts`    config contract + the `isAdmitted` trust fence
*   - `routes.ts`         the seven HTTP route handlers (peer-free, wiring-injected)
*                         — six Token Plan routes plus the Raccoon route
*   - `lifecycle.ts`      mount seed / draw tool / vision step two / teardown
*   - `console-client.ts` console/catalog fetch with cache + single-flight
*   - `parsers.ts`        response normalization + shape-drift detection
*   - `snapshot-aggregate.ts` the snapshot body's data aggregation
*   - `provider-publish.ts`  the provider registration state machine
*   - `state-store.ts`    atomic state-file primitives for the four stores
*   - `trace.ts`          login-trace persistence (already sanitized upstream)
*   - `util.ts`           the small `str`/`num`/`obj` readers
*
* This file keeps the Cordis entry (`name`/`inject`/`apply`), the wiring
* assembly, and the unmount effect — the parts that are about *this* plugin's
* surface rather than reusable logic.
*
* @module dsh-connect-sensenova-token-plan
*/
/**
* The record address format, matching `@deepseek-ai/dsh-credentials`.
*
* The service exports `credentialKey` for this, but a plugin that imports it
* statically cannot be exercised without that peer package present — which is
* what kept the test suite from running on a clean checkout. The Host's
* credentials service treats the plain `"scope/id"` string identically. Exported
* so `test/config.test.mjs` can pin its LITERAL shape on every machine (a clean
* checkout included), and `test/store.test.mjs` can assert it EQUALS the real
* peer function where that peer resolves — together they close the gap the old
* comment claimed was already closed but never actually tested.
* @param {string} scope - the plugin's namespace.
* @param {string} id - the record's name.
* @returns {string} the record key.
*/
const credentialKey = (scope, id) => `${scope}/${id}`;
/**
* Host body: assemble the wiring, register the seven routes (six Token Plan
* plus the Raccoon route), run the mount
* side effects, and hang the unmount effect. The route handlers live in
* `routes.ts`, the side effects in `lifecycle.ts` — this function only
* decides what they may touch.
* @param ctx - host root context.
* @param config - the row's raw patch config. There is no DSH Config schema, so
*   values arrive unvalidated; the endpoint overrides are checked where they
*   are consumed (`createAuth` throws on a malformed origin) and the failure
*   is surfaced through the snapshot instead of crashing the route.
* @param deps - test-only seams (the peer adapter / tools modules, a draw
*   fetch replacement). The real Loader passes nothing.
*/
function apply(ctx, config = {}, deps = {}) {
	const { settings, configError: rowError } = resolveSettings(config);
	let configError = rowError;
	let auth = null;
	if (configError === null) try {
		auth = createAuth(settings.auth);
	} catch (error) {
		configError = errMsg(error);
	}
	const apiKeyStore = createApiKeyStore({ credentials: () => ctx.get("credentials") ?? null });
	const resolveApiKey = async () => (await apiKeyStore.resolve()).value;
	/** @type {Map<string, import("./console-client.ts").CacheEntry>} */
	const cache = /* @__PURE__ */ new Map();
	/** One in-flight console fetch per URL, so concurrent polls share a call. */
	const inflight = /* @__PURE__ */ new Map();
	const profile = profileSegment(ctx);
	const catalogStore = createFileCatalogStore({ profile });
	const providerStore = createFileProviderStore({ profile });
	const drawStore = createFileDrawStore({ profile });
	/** Read an optional service without throwing on a Host that lacks it. */
	const getService = (service) => {
		try {
			return ctx.get?.(service) ?? null;
		} catch {
			return null;
		}
	};
	const raccoonCache = createCoalescedFetch();
	const loadAdapterModule = deps.loadAdapterModule ?? (() => import("./llm-adapter-17gZQlIS.js"));
	const publisher = createProviderPublisher({
		settings,
		panelSwitch: () => providerStore.enabled().catch(() => null),
		loadAdapterModule,
		getLlm: (service) => getService(service),
		resolveApiKey,
		emit: ctx.emit,
		logger: ctx.logger
	});
	const providerState = publisher.state;
	const publishProvider = (entries, enabledIds, unavailableModelIds = []) => publisher.publish(entries, enabledIds, unavailableModelIds);
	const releaseProvider = () => publisher.release();
	const raccoonStore = createRaccoonStore({ credentials: () => ctx.get("credentials") ?? null });
	const raccoonSwitch = createFileRaccoonStore({ profile });
	const raccoonPublisher = createRaccoonPublisher({
		panelSwitch: () => raccoonSwitch.enabled().catch(() => null),
		resolveToken: async () => {
			const { credential } = await raccoonStore.resolve();
			if (credential === null) return "";
			if (await raccoonStore.isExpired().catch(() => false)) await raccoonStore.refresh().catch(() => {});
			const { credential: live } = await raccoonStore.resolve();
			return live?.accessToken ?? "";
		},
		getLlm: (service) => getService(service),
		loadAdapterModule: deps.loadRaccoonAdapterModule ?? (() => import("./raccoon-llm-adapter-Be9DTZNM.js")),
		emit: ctx.emit,
		logger: ctx.logger
	});
	seedRaccoonOnMount({
		raccoonStore,
		raccoonSwitch,
		raccoonPublisher
	});
	const tokenStore = createTokenStore({
		auth: auth ?? createAuth(),
		credentials: () => ctx.get("credentials") ?? null,
		credentialKey,
		skewMs: settings.tokenSkewSeconds * 1e3,
		throttleStore: createFileThrottleStore(),
		onTrace: (hops, error) => {
			writeLoginTrace(hops, error === null ? "ok" : str(error?.code, CODE.AUTH_ERROR));
		}
	});
	const wiring = {
		settings,
		configError,
		cache,
		inflight,
		tokenStore,
		apiKeyStore,
		catalogStore,
		providerStore,
		drawStore,
		publisher,
		providerState,
		publishProvider,
		releaseProvider,
		resolveApiKey,
		visionPublish: { current: null },
		logger: ctx.logger,
		raccoonStore,
		raccoonSwitch,
		raccoonPublisher,
		raccoonCache
	};
	const offs = registerRoutes(ctx, wiring);
	startSideEffects(ctx, wiring, {
		loadToolsModule: deps.loadToolsModule ?? (() => import("@deepseek-ai/dsh-tools")),
		drawFetch: deps.drawFetch ?? ((url, options) => fetch(url, options))
	});
	ctx.effect(() => {
		return () => {
			teardown(wiring, offs);
		};
	}, `${name}: routes`);
}

//#endregion
export { CONFIG_DEFAULTS, apply, catalogSignature, credentialKey, hostName, inject, isAdmitted, name, resolveAuthOverrides, resolveSettings };
//#region src/host/util.ts
/**
* The error `pluginError` actually produces at runtime: an `Error` with a
* stable `code` the panel branches on, plus optional structured fields the
* panel and trace read. The fields are attached, not inherited, so this is a
* structural annotation, not a subclass.
* @typedef {Error & {
*   code: import("./codes.ts").CodeValue,
*   retryAfterMs?: number,
*   detail?: string,
*   trace?: object[]
* }} PluginError
*/
/** Read a finite positive number, else the fallback. */
function num(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
/** Read a non-empty string, else the fallback. */
function str(value, fallback) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}
/**
* The one-line error message every catch site used to hand-write: the
* Error's message when it is an Error, else its string form. Collapses
* the repeated `X instanceof Error ? X.message : String(X)` boilerplate.
* (The two Raccoon `onFail` sites that also quote `${why.name}` keep
* their own richer message and do NOT use this.)
* @param {unknown} value - a caught value.
* @returns {string}
*/
function errMsg(value) {
	return value instanceof Error ? value.message : String(value);
}
/**
* The one credential-word list, in the spelling the redaction rules and
* `test/credential-guard.test.mjs` both read.
*
* `access[_-]?token` covers `access_token`, `access-token` and — because these
* rules run case-insensitively — `accessToken`. `secret` and `client_secret`
* are listed separately: OAuth-shaped bodies spell them both ways.
*
* EXPORTED for the same reason the redaction rules need it, and not only for
* them: the credential fence in `test/credential-guard.test.mjs` derives its
* field-name vocabulary from this string, so a name added here also widens the
* fence that keeps that name out of `str()`. One list, two readers — a third
* hand-copied list is the way these drifted apart the first time.
*/
const SECRET_KEY = "password|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|code[_-]?verifier|token|secret";
/**
* Rules 5, 6 and 7 of `redactSecrets`, built from {@link SECRET_KEY} instead of
* repeating the alternation three times (which is exactly how rule 6 and rule 7
* came to be missing `secret`: three literals, three chances to forget one).
*/
const SECRET_JSON_PAIR = new RegExp(`(["']?(?:${SECRET_KEY})["']?\\s*:\\s*["'])[^"']+(?=["'])`, "gi");
const SECRET_KEY_VALUE = new RegExp(`\\b(${SECRET_KEY})\\s*=\\s*[^&;\\s"']+`, "gi");
const SECRET_UNQUOTED_PAIR = new RegExp(`\\b(${SECRET_KEY})(\\s*:\\s*)(?!null\\b|true\\b|false\\b|undefined\\b|-?\\d)([A-Za-z0-9._~+/=-]{4,})`, "gi");
/**
* Redact credential-shaped strings from any text that may reach a log, an
* error message, or a panel-facing response.
*
* AGENTS.md's red line: "凭据不入库" — a credential never reaches a log or a
* response. The login trace already sanitizes in `sensenova-auth.ts`; this is
* the counterpart for the LLM route, where an HTTP error object's `message`
* often embeds the request headers it was built from (axios/fetch errors do),
* and a SenseNova 4xx body may echo the `sk-` key back. Without this gate a
* registration failure would leak the key through `providerState.error` and
* `ctx.logger.warn`.
* @param {string} text - any string that might carry a credential.
* @returns {string} the text with credential patterns replaced by `[REDACTED]`.
*/
function redactSecrets(text) {
	return (typeof text === "string" ? text : "").replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]").replace(/(["']?[Aa]uthorization["']?\s*[:=]\s*["']?)(?!Bearer\s)[^"',;\s]+/g, "$1[REDACTED]").replace(/\b(Set-Cookie|Cookie)(\s*[:=]\s*)(["']?)[^"'\n]*\3/gi, "$1$2$3[REDACTED]$3").replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-[REDACTED]").replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[REDACTED]").replace(SECRET_JSON_PAIR, "$1[REDACTED]").replace(SECRET_KEY_VALUE, "$1=[REDACTED]").replace(SECRET_UNQUOTED_PAIR, "$1$2[REDACTED]");
}
/**
* Swallow a failure, but leave a trace.
*
* The opt-in modules degrade by design: a refused tool registration or a peer
* that fails to load must leave the panel and the quota read working, so these
* paths swallow. What they must NOT swallow is the reason — before this helper
* those catches were empty, so "面板照常用、模块缺席" produced exactly zero logs
* and a deployment that lost the draw tool had no line anywhere naming why.
*
* Logs at `warn`, deliberately NOT `debug`: a debug line is filtered on a
* default Host, so it would still be zero logs. `reason` is caller-supplied and
* static; the error message is redacted first (AGENTS.md red line 1 — a
* credential never enters a log).
*
* Returns `fallback`, so one call serves both shapes a silent catch appears
* in:
*   try { … } catch (e) { return degrade("draw: tools peer module failed to load", e, logger, null); }
*   … .catch((e) => degrade("draw: catalog list", e, logger, []))
* @param {string} reason - what degraded, module-prefixed ("draw: …").
* @param {unknown} error - the caught value; `null`/`undefined` (or empty)
*   means "no underlying error" and is omitted, so a refusal like ADR-006's
*   version guard does not log a misleading `: null`.
* @param {{ warn?: (message: string) => void } | undefined} logger - `ctx.logger`.
* @param {T} fallback - the value standing in for the absent result.
* @returns {T}
*/
function degrade(reason, error, logger, fallback) {
	const detail = error == null ? "" : redactSecrets(errMsg(error));
	logger?.warn?.(detail === "" ? `degraded: ${reason}` : `degraded: ${reason}: ${detail}`);
	return fallback;
}
/** Read a plain object, else `{}`. */
function obj(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
/**
* Wait for something that may arrive late, inside a bounded window.
*
* Mount-time reads run against a Host that is still assembling itself: the
* credentials, settings, tools and `llm` services may all register AFTER this
* plugin mounts, and a one-shot read that misses one leaves a capability
* absent for the whole session with no line anywhere naming the reason. This
* is the one loop both such callers use — `resolveServiceWithRetry`
* (retries a service READ, right below) and `seedRaccoonOnMount` in
* `lifecycle.ts` (retries a whole seed pass) — so the backoff shape cannot
* drift between them.
*
* The window LENGTH stays with the caller: those two need different budgets
* (a single service read settles in a few hundred ms; a seed that must wait
* for two services and then fetch a catalogue needs longer), and that is a
* design choice, not an accident.
* @param {object} job
* @param {number} job.attempts - how many attempts the window holds.
* @param {number} job.delayMs - backoff base; the wait before attempt N is
*   `delayMs * N` (linear, so a slow Host is not hammered).
* @param {(attempt: number) => boolean|Promise<boolean>} job.run - one
*   attempt; returns true to stop (succeeded, or gave up deliberately), false
*   to keep trying inside the window.
* @returns {Promise<boolean>} true when an attempt stopped the loop, false
*   when the window ran out.
*/
async function retryBounded({ attempts, delayMs, run }) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (await run(attempt)) return true;
		if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
	}
	return false;
}
/** How many times a mount-time optional-service read is retried. */
const SERVICE_RETRY_ATTEMPTS = 3;
/** Base backoff between service-read attempts (× attempt index). */
const SERVICE_RETRY_DELAY_MS = 300;
/**
* Read an optional Host service with a bounded retry.
*
* A service may register AFTER this plugin mounts — the vision step two note
* in `lifecycle.ts` said so — and a mount-time read is the only window for a
* capability the Host may never offer again: the settings row is only written
* by a poll that finds `visionPublish.current` already filled. A one-shot read
* therefore misses a service that arrives a moment late for the WHOLE session,
* silently — the draw tool would be absent with the switch visibly on, the
* vision list never written, and no line on any panel naming the reason. The
* Raccoon publisher got the same bounded retry for its mount seed.
*
* This retries the READ ONLY. Whatever it returns is used exactly once by the
* caller: retrying a call that mutates (a tool registration) would register
* the same tool twice, and the registry rejects a duplicate name.
*
* The loop is `retryBounded` directly above — the same backoff
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
* Read a string exactly as it was given, else the fallback.
*
* The companion to `str()` for secrets: a password is stored, read back and
* sent as typed, because trimming it is a change the user cannot see. A
* password of only whitespace is still "not filled in", which the caller
* judges with `.trim()`.
*/
function verbatim(value, fallback) {
	return typeof value === "string" ? value : fallback;
}
/** Read a finite number, else `null`. */
function numOrNull(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
/**
* Await an OPTIONAL store call, reading "there is no store" as "no answer".
*
* The shape this replaces looks defensive and is not:
* `(store ? store.enabled() : null).catch(() => null)` guards the CALL but
* applies `.catch` to the ternary's RESULT — and the absent branch yields a
* bare `null`, so the expression throws exactly on the branch the guard was
* written for. It stays invisible because the store is always wired in
* production, which is the one case where it works (PITFALLS §33).
*
* Use it as `await optional(store ? store.enabled() : null)`: the guard then
* sits on the value, where "not a promise" and "a rejected promise" both read
* as `null`.
* @param {T | Promise<T> | null | undefined} value - the call's result (usually a promise), or `null`.
* @param {F} fallback - what to read on absence or rejection; `null` by default,
*   so callers that only need "no answer" pass nothing.
* @returns the value, or `fallback` on absence or rejection.
*
* Generic over both the value and the fallback rather than annotated `unknown`
* (docs/IMPROVEMENTS.md §8): the caller's declared fallback is what makes the
* result usable at the call site — `optional(x, { credential: null })` must
* yield that object's shape, not `unknown`. The default-parameter form this
* replaces was typed FROM the `null` initializer under strictNullChecks, so
* every explicit fallback became an argument error.
*/
function optional(value, fallback = null) {
	return Promise.resolve(value).catch(() => fallback);
}
/**
* Omit the fields of `fields` that are `null` or `undefined`, keeping the
* rest as a fresh object. Collapses the `(x !== null ? { x } : {})` response
* builders: `...pickDefined({ x })` reads as omit-when-absent in one token.
* A guard that omits an empty string or requires a specific type is a
* DIFFERENT policy and keeps its own `typeof` / non-empty test — not this helper.
* @param {T} fields - the candidate field map.
* @returns a new object holding only the defined fields.
*/
function pickDefined(fields) {
	const out = {};
	for (const [key, value] of Object.entries(fields)) if (value !== null && value !== void 0) out[key] = value;
	return out;
}
/**
* An error carrying a stable code the panel can branch on.
*
* The single constructor for every failure this plugin produces. `extra`
* carries optional structured fields (retryAfterMs, detail) that the panel
* and the trace need; only defined extras are copied, so an absent field
* stays absent rather than reading as a zero.
*
* The runtime value is a plain `Error` with these fields attached; the
* {@link PluginError} type records that shape so a `catch (e)` downstream can
* read `e.code` as more than a hopeful guess.
* @param {import("./codes.ts").CodeValue} code - a {@link import("./codes.ts").CODE} wire value.
* @param {string} message - human-readable description.
* @param {{ retryAfterMs?: number, detail?: string }} [extra] - optional structured fields.
* @returns {PluginError}
*/
function pluginError(code, message, extra = {}) {
	const error = new Error(message);
	error.code = code;
	if (extra.retryAfterMs !== void 0) error.retryAfterMs = extra.retryAfterMs;
	if (extra.detail !== void 0) error.detail = extra.detail;
	return error;
}

//#endregion
//#region src/host/host-config.ts
/**
* The plugin's configuration contract and the Host trust fence.
*
* Everything the Host half reads from the row's patch config lives here, plus
* the `isAdmitted` check that keeps a foreign page from planting an account.
* `test/config.test.mjs` pins `CONFIG_DEFAULTS` and the resolvers against this
* file and `cordis.patch.yml`, so the code and the documented contract cannot
* silently drift.
* @module dsh-connect-sensenova-token-plan/host-config
*/
/**
* The one slug every addressable surface of this plugin derives from.
*
* Besides the name the Loader reports for the row, it is also the `/api` route
* prefix (`routes.ts`), the credential record's scope (`token-store.ts`) and the
* state directory (`throttle-store.ts`) — so a rename has to carry the user's
* stored grant and parked throttle with it, not just the text.
*
* The mirrors that cannot import this constant are pinned by
* `test/config.test.mjs`, so a rename on either side goes red instead of
* leaving the stored grant behind: §6 checks the literal `package.json#name`
* and the patch row's `id`/`name` pair against it, and §6b checks that every
* route literal in `src/client/const.ts` (the browser bundle cannot derive them)
* equals the `/api/${name}/…` this half builds in `routes.ts`.
*/
const name = "dsh-connect-sensenova-token-plan";
/** Cordis services this plugin needs; without `webServer` it stays inactive. */
const inject = ["webServer"];
/**
* The floor and the ceiling on one image request's deadline.
*
* A draw call is a SINGLE synchronous POST (src/host/draw.ts), so this
* deadline is the only guardrail between a stuck upstream and an agent turn
* that never returns. The floor keeps slow image models usable — they
* regularly take tens of seconds, and a chat-sized deadline would abort
* healthy requests. The ceiling keeps a mistyped row value (999999999) from
* parking a turn for months: 30 minutes is far above any sane image
* generation and far below "forever", and it is the same ceiling the sibling
* draw plugin uses.
*/
const DRAW_TIMEOUT_MIN_MS = 5e3;
const DRAW_TIMEOUT_MAX_MS = 18e5;
/**
* The plugin's configuration contract in one place.
*
* Every default the Host half reads lives here, so the code and the
* `cordis.patch.yml` that documents it cannot silently drift: `test/config.test.mjs`
* pins both against this object. The `auth` sub-object lists the operator-facing
* login-flow overrides (their patch.yml entries are commented by default, which is
* why they default to empty/zero and mean "use the platform default").
*
* ⚠️ That `auth` block is only the DEFAULTS SHAPE — do NOT copy it into
* `cordis.patch.yml` as a nested block. The patch row must spell these keys at
* the TOP LEVEL, and {@link resolveAuthOverrides} throws on a nested `auth`
* block: the loader accepts one, this resolver drops it, and the panel would
* keep talking to the real platform (redline 3).
*/
const CONFIG_DEFAULTS = Object.freeze({
	consoleBase: "https://platform.sensenova.cn",
	apiBase: "https://token.sensenova.cn/v1",
	trendHours: 24,
	/**
	* Pseudo multipliers for the trend table, keyed by a case-insensitive
	* SUBSTRING of a model id (first matching key wins, in insertion order).
	* The platform returns raw credits with no official per-model rate, so
	* these numbers are the operator's own comparison aid — the panel labels
	* them as custom/non-official and rows without a match stay unmultiplied.
	* Shipped defaults reflect the operator's rough current rates.
	*/
	trendMultipliers: {
		"glm-5.2": 10,
		"kimi-k3": 20,
		"sensenova": 1,
		"deepseek": 1
	},
	cacheSeconds: 60,
	pollSeconds: 30,
	consoleTimeoutMs: 15e3,
	tokenSkewSeconds: 120,
	auth: {
		iamBase: "",
		tokenEndpoint: "",
		jwksEndpoint: "",
		redirectUri: "",
		clientId: "",
		scope: "",
		encKeyId: "",
		maxHops: 0,
		loginTimeoutMs: 0,
		requestTimeoutMs: 0
	},
	/** Host names the Host answers as, by default. The operator's list is added. */
	admittedHosts: [
		"localhost",
		"127.0.0.1",
		"[::1]",
		"::1"
	],
	/**
	* Vision step two: whether the Host syncs the identified vision-capable
	* model ids into THIS row's own settings namespace (`imageModelIds`,
	* `visionModels`) on every catalog poll, for a later LLM connect plugin to
	* read. Off by default - the read-only info layer is the safe shape. The
	* writes go to this plugin's OWN settings row only, never another
	* provider's, so a miscalculated list cannot reach DSH's model routing.
	*/
	writeImageModelIds: false,
	/** The last published image-model id list (the reader's primary field). */
	imageModelIds: [],
	/** The last full vision identification (id + source marker per model). */
	visionModels: [],
	/**
	* Step three ("one-stop service"): register the LLM provider DIRECTLY.
	*
	* When true, the plugin calls `ctx.llm.registerAdapter` itself with an
	* OpenAI-compatible pi-ai adapter aimed at `apiBase`, the catalog poll feeds
	* its model list, vision models carry image input automatically, and the
	* panel-saved `SENSENOVA_API_KEY` reference authenticates requests. Off by
	* default for the same reason `writeImageModelIds` is: registering a model
	* source is a Host-wide change, not a read-only panel view, so it stays an
	* explicit opt-in and an operator with the hand-written `llm-pi-ai` row is
	* not suddenly offered two providers.
	*/
	registerProvider: false,
	/**
	* Per-model OUTPUT CEILING overrides, keyed by EXACT model id.
	*
	* The catalogue is FETCHED, not authored, and it can understate a model: the
	* module header of `llm-models.ts` probed `deepseek-v4-flash` accepting
	* 131072 while the catalogue states 65536. Without this field the only way to
	* disagree with the platform was to edit the stored catalogue — which the
	* next poll overwrites, so the correction silently reverts, and a ceiling
	* that reverts is worse than one that was never raised.
	*
	* Precedence: this map > the catalogue's `max_output_length` > undeclared
	* (the harness then applies `defaultMaxTokens ?? 32768`). Empty by default,
	* so the platform stays authoritative until the operator says otherwise.
	* Read by `llm-models.maxTokensFor`, which BOTH the descriptor build and the
	* panel roster call — the value sent and the value displayed are one order.
	* Scope: the DIRECTLY-REGISTERED provider (`registerProvider`) and the panel
	* roster that mirrors it. The Raccoon hosted route builds its descriptors in
	* `raccoon-models.ts` and is deliberately unaffected.
	*/
	maxTokensOverrides: {},
	/**
	* Draw absorption (ARCHITECTURE §5.4 route B): register the
	* `sensenova_draw_image` agent tool. When true AND the Host exposes a tools
	* service, image-generation requests go to `{apiBase}/images/generations`
	* with the panel-saved `SENSENOVA_API_KEY`, and the model list comes from
	* the catalog's own `output_modalities` (never a name regex). Off by
	* default like every execution module: a tool the agent can call is a
	* Host-wide change, and a Host without the tools service must simply never
	* see it rather than fail.
	*
	* 0.4.2: this value is now the DEPLOYMENT DEFAULT only. The panel's draw
	* tool switch (`POST /api/<name>/draw`, stored in `draw-store.ts`)
	* overrides it live with no restart. See `docs/PROVIDER-HOT-RELOAD.md` §7.
	*/
	drawEnabled: false,
	/** Preferred draw model id; empty means "first image-gen model of the catalog". */
	drawModelId: "",
	/** Deadline for one image request. Image models are slow; chat deadlines do not apply. Clamped into [DRAW_TIMEOUT_MIN_MS, DRAW_TIMEOUT_MAX_MS] by resolveDrawTimeoutMs. */
	drawTimeoutMs: 12e4,
	/** Opt-in: register the Raccoon hosted `web_search` provider in `ctx.web`. */
	webSearchEnabled: false,
	/**
	* Background freshness for the registered provider (2026-10 review #1b).
	* The panel polls only while it is open, but a registered provider is a
	* STANDING execution channel — its catalog/quota state used to decay until
	* somebody opened the panel. While the effective provider switch is ON, the
	* Host drives one aggregate refresh every N minutes (the same engine the
	* snapshot route calls, sharing its cache — a panel that polls in between
	* costs the platform nothing extra). `0` disables it; a panel-only Host
	* (switch off) never schedules the timer, keeping the opt-in shape.
	*/
	providerRefreshMinutes: 15
});
/**
* Sanitize the operator's pseudo-multiplier map: keep only string keys and
* finite positive numbers, preserving insertion order (matching is
* first-key-wins). A non-object or empty input falls back to the shipped
* defaults; the operator sets `{}` explicitly to disable all multipliers.
* Exported so `test/config.test.mjs` drives the same sanitizer the resolve
* path uses, instead of a copy that could drift.
* @param {unknown} raw - the raw `trendMultipliers` config value.
* @returns {Record<string, number>} the sanitized map.
*/
function resolveTrendMultipliers(raw) {
	const source = raw === void 0 || raw === null ? CONFIG_DEFAULTS.trendMultipliers : raw;
	if (source === null || typeof source !== "object" || Array.isArray(source)) return { ...CONFIG_DEFAULTS.trendMultipliers };
	const out = {};
	for (const [key, value] of Object.entries(source)) if (typeof key === "string" && key !== "" && typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
	return out;
}
/**
* Clamp a raw numeric setting to its effective integer.
*
* Every numeric field in {@link resolveSettings} follows the same shape: floor
* the raw value, clamp it at a lower bound, then (optionally) at an upper bound;
* a non-positive or non-finite raw falls back to `def` (because `num` only
* accepts a positive finite number). The sequence — `Math.min(max, Math.max(min,
* Math.floor(raw)))` with `max` defaulting to `Infinity` — is exactly what the
* inline `Math.max`/`Math.min` chains used to spell out one field at a time, so
* this is a MOVE of that pattern into one tested place, not a behaviour change.
* @param {unknown} raw - the raw value read from the row.
* @param {number} def - the fallback when `raw` is not a positive finite number.
* @param {number} min - the lower clamp (inclusive) applied after flooring.
* @param {number} [max] - the upper clamp (inclusive); omit for no upper bound.
* @returns {number} the clamped integer.
*/
function clampInt(raw, def, min, max = Infinity) {
	return Math.min(max, Math.max(min, Math.floor(num(raw, def))));
}
/**
* Resolve the draw deadline, with BOTH ends of the range enforced.
*
* One place owns the bounds so the config layer and the agent tool cannot
* drift: the Host settings read it through {@link clampInt}, and the tool
* re-clamps the value it is handed, because `defineDrawTool` takes a plain
* settings object (tests, future callers) rather than the resolved config —
* and the deadline is a REQUEST parameter, not a preference.
* @param {unknown} raw - the raw `drawTimeoutMs` value.
* @returns {number} the effective deadline in milliseconds, within
*   [DRAW_TIMEOUT_MIN_MS, DRAW_TIMEOUT_MAX_MS].
*/
function resolveDrawTimeoutMs(raw) {
	return clampInt(raw, CONFIG_DEFAULTS.drawTimeoutMs, DRAW_TIMEOUT_MIN_MS, DRAW_TIMEOUT_MAX_MS);
}
/**
* Resolve the background-refresher cadence, where ZERO IS A LOADED ANSWER.
*
* Every other numeric setting reads through `clampInt`, whose `num` treats a
* non-positive value as "unset" and falls back. Here `0` means "the refresher
* is disabled" — a deliberate operator decision — so an explicit finite number
* always travels (floored and clamped to [0, 1440]); only a non-number / NaN /
* ±Infinity falls back to the shipped default.
* @param {unknown} raw - the raw `providerRefreshMinutes` row value.
* @returns {number} the effective cadence in minutes (0 = off).
*/
function resolveProviderRefreshMinutes(raw) {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return CONFIG_DEFAULTS.providerRefreshMinutes;
	return Math.min(1440, Math.max(0, Math.floor(raw)));
}
/**
* Sanitize the operator's per-model output-ceiling map.
*
* Keys are EXACT model ids — deliberately NOT the case-insensitive SUBSTRING
* match {@link resolveTrendMultipliers} uses. A multiplier is a comparison aid,
* so a loose match is convenient; a ceiling is a REQUEST PARAMETER, so a loose
* match would silently retune models the operator never named (the key `flash`
* alone would land on five catalogue entries). Values must be positive
* INTEGERS: a fractional token count is a typo, and `0` is reserved for
* "undeclared" by `llm-models.maxTokensFor`, so it is not an expressible
* ceiling here.
*
* A malformed map falls back to the shipped default (`{}` — the catalogue is
* authoritative) instead of throwing: one bad row must not take the panel down,
* which is the same shape {@link resolveTrendMultipliers} uses.
* Exported so `test/config.test.mjs` drives the same sanitizer the resolve path
* uses, instead of a copy that could drift.
* @param {unknown} raw - the raw `maxTokensOverrides` config value.
* @returns {Record<string, number>} the sanitized map.
*/
function resolveMaxTokensOverrides(raw) {
	const source = raw === void 0 || raw === null ? CONFIG_DEFAULTS.maxTokensOverrides : raw;
	if (source === null || typeof source !== "object" || Array.isArray(source)) return { ...CONFIG_DEFAULTS.maxTokensOverrides };
	const out = {};
	for (const [key, value] of Object.entries(source)) if (typeof key === "string" && key !== "" && typeof value === "number" && Number.isInteger(value) && value > 0) out[key] = value;
	return out;
}
/**
* Resolve the row's raw patch config into effective settings.
*
* A malformed row must not throw out of here: `apply` runs at mount, and an
* exception would take the whole plugin down instead of leaving a panel that
* explains itself. So problems are returned as `configError` and surfaced
* through the snapshot route.
* @param {unknown} config - the row's raw patch config.
* @returns {{settings: ResolvedSettings, configError: string|null}}
*/
function resolveSettings(config) {
	const source = obj(config);
	const consoleBase = str(source.consoleBase, CONFIG_DEFAULTS.consoleBase).replace(/\/+$/, "");
	const apiBase = str(source.apiBase, CONFIG_DEFAULTS.apiBase).replace(/\/+$/, "");
	try {
		return {
			settings: {
				consoleBase,
				apiBase,
				trendHours: clampInt(source.trendHours, CONFIG_DEFAULTS.trendHours, 1, 168),
				trendMultipliers: resolveTrendMultipliers(source.trendMultipliers),
				cacheSeconds: clampInt(source.cacheSeconds, CONFIG_DEFAULTS.cacheSeconds, 5),
				pollSeconds: clampInt(source.pollSeconds, CONFIG_DEFAULTS.pollSeconds, 5),
				consoleTimeoutMs: clampInt(source.consoleTimeoutMs, CONFIG_DEFAULTS.consoleTimeoutMs, 1e3),
				allowedHosts: resolveAllowedHosts(source),
				tokenSkewSeconds: clampInt(source.tokenSkewSeconds, CONFIG_DEFAULTS.tokenSkewSeconds, 0),
				auth: resolveAuthOverrides(source, consoleBase),
				writeImageModelIds: source.writeImageModelIds === true,
				imageModelIds: Array.isArray(source.imageModelIds) ? source.imageModelIds.filter((id) => typeof id === "string") : CONFIG_DEFAULTS.imageModelIds,
				visionModels: Array.isArray(source.visionModels) ? source.visionModels.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : CONFIG_DEFAULTS.visionModels,
				registerProvider: source.registerProvider === true,
				maxTokensOverrides: resolveMaxTokensOverrides(source.maxTokensOverrides),
				drawEnabled: source.drawEnabled === true,
				drawModelId: str(source.drawModelId, ""),
				drawTimeoutMs: resolveDrawTimeoutMs(source.drawTimeoutMs),
				webSearchEnabled: source.webSearchEnabled === true,
				providerRefreshMinutes: resolveProviderRefreshMinutes(source.providerRefreshMinutes)
			},
			configError: null
		};
	} catch (error) {
		return {
			settings: {
				consoleBase,
				apiBase,
				trendHours: CONFIG_DEFAULTS.trendHours,
				trendMultipliers: CONFIG_DEFAULTS.trendMultipliers,
				cacheSeconds: CONFIG_DEFAULTS.cacheSeconds,
				pollSeconds: CONFIG_DEFAULTS.pollSeconds,
				consoleTimeoutMs: CONFIG_DEFAULTS.consoleTimeoutMs,
				allowedHosts: new Set(CONFIG_DEFAULTS.admittedHosts),
				tokenSkewSeconds: CONFIG_DEFAULTS.tokenSkewSeconds,
				auth: { consoleOrigin: consoleBase },
				writeImageModelIds: false,
				imageModelIds: CONFIG_DEFAULTS.imageModelIds,
				visionModels: CONFIG_DEFAULTS.visionModels,
				registerProvider: false,
				maxTokensOverrides: CONFIG_DEFAULTS.maxTokensOverrides,
				drawEnabled: false,
				drawModelId: "",
				drawTimeoutMs: CONFIG_DEFAULTS.drawTimeoutMs,
				webSearchEnabled: false,
				providerRefreshMinutes: CONFIG_DEFAULTS.providerRefreshMinutes
			},
			configError: errMsg(error)
		};
	}
}
/**
* Collect just the auth keys the operator actually set.
*
* The keys are read from the TOP LEVEL of the row. That is not obvious, and
* getting it wrong is not a harmless typo: a nested `auth:` block is accepted
* by the loader, silently dropped here, and the panel then runs on its shipped
* defaults — which point at the REAL platform. An end-to-end run meant to talk
* to a local stub then posts a real login attempt, which is exactly how this
* plugin locked an account once already. So a nested `auth` key is reported as
* a configuration error rather than ignored.
* @param {object} source - the row's raw patch config.
* @param {string} consoleBase - the resolved console origin.
* @returns {object} the override object for `createAuth`.
* @throws {Error} when the row looks like it nests overrides it does not read.
*/
function resolveAuthOverrides(source, consoleBase) {
	if (source.auth !== void 0 && source.auth !== null) {
		const keys = Object.keys(obj(source.auth));
		throw new Error(`auth overrides are top-level keys on this row, not a nested \`auth:\` block${keys.length === 0 ? "" : ` (found: ${keys.join(", ")})`}. Use \`iamBase\`, \`tokenEndpoint\`, \`jwksEndpoint\`, \`redirectUri\`, \`clientId\`, \`scope\` or \`encKeyId\` at the top level; a nested block is ignored and the panel would keep using the real platform.`);
	}
	const text = (key) => str(source[key], "");
	const overrides = { consoleOrigin: consoleBase };
	const set = (key, value, transform) => {
		if (value === "") return;
		overrides[key] = transform === void 0 ? value : transform(value);
	};
	set("iamOrigin", text("iamBase"), (value) => value.replace(/\/+$/, ""));
	set("tokenEndpoint", text("tokenEndpoint"));
	set("jwksEndpoint", text("jwksEndpoint"));
	set("redirectUri", text("redirectUri"));
	set("clientId", text("clientId"));
	set("scope", text("scope"));
	set("encKeyId", text("encKeyId"));
	const maxHops = Math.floor(num(source.maxHops, 0));
	if (maxHops > 0) overrides.maxHops = maxHops;
	const loginTimeoutMs = Math.floor(num(source.loginTimeoutMs, num(source.requestTimeoutMs, 0)));
	if (loginTimeoutMs > 0) overrides.requestTimeoutMs = loginTimeoutMs;
	return overrides;
}
/**
* Collect the host names this Host will answer as.
*
* The operator's list is ADDED to the defaults, never substituted: replacing
* them would let a typo lock the panel out of itself, and there is no console
* to fix it from.
* @param {object} source - the row's raw patch config.
* @returns {Set<string>} the admitted host names, lowercased.
*/
function resolveAllowedHosts(source) {
	const admitted = new Set(CONFIG_DEFAULTS.admittedHosts);
	const extra = Array.isArray(source.allowedHosts) ? source.allowedHosts : [];
	for (const entry of extra) {
		const name = str(entry, "").trim().toLowerCase();
		if (name !== "") admitted.add(name);
	}
	return admitted;
}
/**
* The host name a `Host` header names, without its port.
* @param {string} host - the raw header value.
* @returns {string} the name; bracketed for IPv6 literals.
*/
function hostName(host) {
	if (host.startsWith("[") && host.includes("]")) return host.slice(0, host.indexOf("]") + 1);
	const colons = host.split(":");
	if (colons.length > 2) {
		const penultimate = colons[colons.length - 2] ?? "";
		const last = colons[colons.length - 1] ?? "";
		if (/^\d+$/.test(penultimate) && /^\d+$/.test(last)) return host.slice(0, host.lastIndexOf(":"));
		return host;
	}
	return colons.length > 1 ? host.slice(0, host.lastIndexOf(":")) : host;
}
/**
* Trust fence for a route the browser can reach.
*
* Two different attacks have to be turned away here, and they need two
* different facts:
*
* 1. DNS rebinding. The attacker's page rebinds its own name to 127.0.0.1 and
*    POSTs an account. `Origin` and `Host` now AGREE on the attacker's name
*    while the request lands on the Host, so comparing them to each other
*    admits it. The `Host` header is the one thing a browser cannot forge, so
*    it is checked against a whitelist instead of against the `Origin`.
* 2. Cross-site forgery. A page on another origin asks the browser to post to
*    the loopback Host. Here the whitelist alone is worthless — the Host IS
*    legitimate — and the `Origin` is what gives it away.
*
* So: the `Host` must be one this Host answers as, AND any stated `Origin`
* must agree with it. A request that states no `Origin` is the ordinary
* same-origin GET and is admitted.
*
* The boundary this draws is the BROWSER, not the machine. A process running
* as the user sets `Host` and `Origin` to whatever it likes, and there is no
* CSRF token here to tell it apart from the panel — so anything that can open
* a socket to this port can also plant an account. That is the same trust the
* Host places in the user's own processes generally, but it is worth saying
* plainly: an `Origin` check reads like more protection than it is, and a
* reader who believes otherwise will build something on top of it. Closing
* that gap needs a token the Host serves in its own page and the POST carries
* back, not a header a client can choose.
* @param {{ headers?: { host?: unknown; origin?: unknown } }} request - the incoming HTTP request.
* @param {Set<string>} allowedHosts - the host names this Host answers as.
* @returns {boolean} whether the request may be served.
*/
function isAdmitted(request, allowedHosts) {
	const host = str(request.headers?.host, "").toLowerCase();
	if (host === "" || !allowedHosts.has(hostName(host))) return false;
	const origin = request.headers?.origin;
	if (typeof origin !== "string" || origin === "") return true;
	if (origin === "null") return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

//#endregion
//#region src/host/parsers.ts
/**
* Console response parsing and shape-drift detection.
*
* The parsers stay forgiving so a poll never throws because a field moved;
* that forgiveness is also how a platform-side rename becomes a serene "no
* data yet" screen, so `EXPECTED_SHAPES` + `checkShape` are what let the panel
* say "the upstream shape changed" instead of "you used nothing".
* @module dsh-connect-sensenova-token-plan/parsers
*/
/**
* The top-level keys each console contract is expected to carry.
*
* The parsers below stay forgiving so that a poll never throws because a field
* moved. That forgiveness is also how a platform-side rename becomes a serene
* "no data yet" screen, so this declaration is what lets the panel say
* "the upstream shape changed" instead of "you used nothing".
*/
const EXPECTED_SHAPES = Object.freeze({
	"pool-usage": ["plan", "pools"],
	"credit-usage-trend": ["series"]
});
/**
* The NESTED keys the panel actually draws numbers from.
*
* `EXPECTED_SHAPES` above only looks at the top level, which is not enough: a
* platform-side rename of `window_5h` leaves `plan` and `pools` perfectly
* present, so the drift detector said `ok` and the panel drew **0 / 0 / 0** —
* a serene empty quota where the module's whole purpose is to notice exactly
* this. The top-level keys are kept separate (rather than flattened in) so
* `EXPECTED_SHAPES` stays the documented top-level contract that callers and
* tests read.
*
* Path syntax: `.` descends into an object, `[]` iterates an array (every
* element must satisfy the rest of the path). A path is reported ONLY when its
* root is present — when `plan` itself is gone the top-level check already says
* so, and reporting `plan.id` too would blame the shape twice for one rename.
*/
const EXPECTED_NESTED = Object.freeze({
	"pool-usage": [
		"plan.id",
		"pools[].window_5h",
		"pools[].window_7d"
	],
	"credit-usage-trend": []
});
/**
* Collect the full paths under `body` that `path` requires and does not find.
* @param {unknown} body - the parsed console response.
* @param {string} path - one `EXPECTED_NESTED` entry.
* @returns {string[]} `[path]` when the requirement is unmet, else `[]`.
*/
function nestedMissing(body, path) {
	const segments = path.split(".");
	const walk = (node, index) => {
		if (index === segments.length) return [];
		const segment = segments[index] ?? "";
		const isList = segment.endsWith("[]");
		const key = isList ? segment.slice(0, -2) : segment;
		const value = obj(node)[key];
		if (value === void 0) return [path];
		if (isList) {
			if (!Array.isArray(value)) return [path];
			return value.some((element) => walk(element, index + 1).length > 0) ? [path] : [];
		}
		return walk(value, index + 1);
	};
	return walk(body, 0);
}
/** Parse one numeric field the console returns as a string. */
function credits(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}
/**
* Parse one epoch field the console returns as a decimal STRING
* (`reset_at`, `nearest_grant_expiry`): seconds since the epoch, or `null`
* when absent or not a usable number. A string here is the console's own
* shape — `Number` accepts it, and it keeps a second-precision integer.
*/
function epochSeconds(value) {
	if (value === void 0 || value === null || value === "" || value === "0") return null;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}
/**
* Report which expected keys a console payload is missing — top level AND the
* nested keys the panel draws from.
*
* A path whose ROOT is already reported as missing at the top level is not
* reported again: one rename must produce one warning, not three.
* @param {unknown} body - the parsed console response.
* @param {string} kind - a key of {@link EXPECTED_SHAPES}.
* @returns {{ok: boolean, missing: string[]}} the drift report.
*/
function checkShape(body, kind) {
	const expected = EXPECTED_SHAPES[kind] ?? [];
	const source = obj(body);
	const missing = expected.filter((key) => source[key] === void 0);
	for (const path of EXPECTED_NESTED[kind] ?? []) {
		const root = (path.split(".")[0] ?? "").replace("[]", "");
		if (root === "" || source[root] === void 0) continue;
		missing.push(...nestedMissing(body, path));
	}
	return {
		ok: missing.length === 0,
		missing
	};
}
/** Normalize the `pool-usage` response into the panel's pool rows. */
function parsePools(body) {
	const source = obj(body);
	const plan = obj(source.plan);
	const pools = Array.isArray(source.pools) ? source.pools : [];
	return {
		plan: {
			id: str(plan.id, ""),
			name: str(plan.name, ""),
			type: str(plan.type, "")
		},
		pools: pools.map((pool) => {
			const source = obj(pool);
			const window5 = obj(source.window_5h);
			const window7 = obj(source.window_7d);
			return {
				id: str(source.id, ""),
				name: str(source.name, ""),
				poolType: str(source.pool_type, "default"),
				modelIds: Array.isArray(source.model_ids) ? source.model_ids.filter((m) => typeof m === "string") : [],
				window5h: {
					limit: credits(window5.limit),
					used: credits(window5.used),
					remaining: credits(window5.remaining),
					resetAt: epochSeconds(window5.reset_at)
				},
				window7d: {
					limit: credits(window7.limit),
					used: credits(window7.used),
					remaining: credits(window7.remaining),
					resetAt: epochSeconds(window7.reset_at)
				},
				grantBalance: credits(source.grant_balance),
				nearestGrantExpiry: epochSeconds(source.nearest_grant_expiry),
				nearestGrantExpiringBalance: credits(source.nearest_grant_expiring_balance)
			};
		})
	};
}
/** Normalize the `credit-usage-trend` response into per-model credit rows. */
function parseTrend(body, trendHours) {
	const source = obj(body);
	const series = Array.isArray(source.series) ? source.series : [];
	const rows = [];
	for (const entry of series) {
		const source = obj(entry);
		const modelId = str(source.model_id, str(source.model_name, ""));
		if (modelId === "") continue;
		const points = Array.isArray(source.points) ? source.points : [];
		let total = 0;
		for (const point of points) total += credits(obj(point).credits);
		rows.push({
			model: modelId,
			credits: Math.round(total * 1e3) / 1e3
		});
	}
	rows.sort((a, b) => b.credits - a.credits);
	return {
		hours: trendHours,
		models: rows
	};
}
/**
* Whether one `GET /v1/models` entry can take image input, and WHY.
*
* This is the first step of the vision plan (ARCHITECTURE.md §5.1): the panel
* shows which of this key's callable models accept pictures, so the user
* knows which one to ask for image input.
*
* Two signals, in priority order:
*
* 1. STRUCTURED — the SenseNova catalog declares `input_modalities` (an
*   array, e.g. `["text","image"]`) on every entry. This is CONFIRMED the
*   platform ships it (2026-09 probe), so it is the authoritative answer:
*   a model is vision-capable iff `"image"` appears in its input
*   modalities. The name fallback below stops mattering on this platform.
*   `inputTypes` / `modality` / `capabilities` are kept as the fallback for
*   other providers that spell the same idea differently — no parser
*   change needed when they arrive.
* 2. NAME PATTERN — only when NO structured modality field is present at
*   all: naming conventions for the multimodal/vision families. Marked
*   `source: "name"` so the panel can say "inferred from the name" and
*   never pretend the platform declared it.
*
* @param {object} entry - one catalog entry (id + any extra fields).
* @returns {VisionModelData} the vision verdict (`source` says how it was decided).
*/
function identifyVisionModel(entry) {
	const source = obj(entry);
	const id = str(source.id, "");
	const modalities = modalitiesOf(source);
	if (modalities !== void 0) return {
		id,
		vision: modalities.some((modality) => /image/i.test(modality)),
		source: "field"
	};
	const byName = VISION_NAME_PATTERNS.some((pattern) => pattern.test(id));
	return {
		id,
		vision: byName,
		source: byName ? "name" : null
	};
}
/**
* Read the first modality-listing field off a catalog entry, or undefined.
* The SenseNova platform's confirmed field is `input_modalities` (array of
* strings, e.g. `["text","image"]`); the others are the spellings other
* providers are expected to use. Accepts string or array values so whatever
* the platform ships parses.
* @param {object} source - one catalog entry.
* @returns {string[]|undefined} the modality names, or undefined.
*/
function modalitiesOf(source) {
	for (const key of [
		"input_modalities",
		"inputTypes",
		"modality",
		"capabilities"
	]) {
		const value = source[key];
		if (Array.isArray(value)) return value.map((modality) => String(modality));
		if (typeof value === "string" && value !== "") return value.split(/[,|]/).map((modality) => modality.trim());
	}
}
/**
* Name patterns used ONLY when no structured modality field is present.
* `flash-lite` was the legacy guess from before the platform confirmed
* `input_modalities`; it is no longer a reliable signal (the name now maps
* to a model family whose actual modality mix the platform field decides),
* so it is dropped from the fallback set.
*/
const VISION_NAME_PATTERNS = Object.freeze([
	/-vl(-|\b)/i,
	/vision/i,
	/qwen.*vl/i,
	/glm-4v/i
]);

//#endregion
//#region src/host/modality.ts
/**
* The catalog modality judgment — the ONE place both model lists read from.
*
* Before this module existed, the two directions of "is this entry an image
* model" lived in two files with two shapes:
*
*   - `llm-models.ts` `isChatModel` (PERMISSIVE): a missing `output_modalities`
*     reads as chat, so a field the platform never sent does not vanish from
*     the picker;
*   - `draw.ts` `isImageGenModel` (STRICT): a missing `output_modalities` reads
*     as "not a draw model", so a wrong guess never sends the agent's request
*     to a model that cannot answer.
*
* They are complements, and a missing field makes them drift in OPPOSITE
* directions — the "two lists can never disagree" claim was maintained by
* convention (each side re-implemented the same field probe), not by
* construction. This module folds the probe into one function: both predicates
* read the same modality decision, so a contradiction between the chat roster
* and the draw list becomes impossible rather than merely undiscovered.
*
* For SenseNova the platform ALWAYS declares `output_modalities` on every
* catalog entry (verified 2026-09-29), so the name-segment fallback Agnes
* needs (its gateway declares no modality field at all) does not exist here;
* the strict/permissive split on a MISSING field is the only nuance, and it is
* preserved exactly as the two historical predicates behaved.
*
* @module dsh-connect-sensenova-token-plan/modality
*/
/**
* The image-modality decision of one catalog entry.
*
* The single probe both predicates read. Returns one of:
*
*   - `"declared-image"` — `output_modalities` is an array containing "image";
*   - `"declared-other"`  — the field is an array without "image";
*   - `"unknown"`         — the field is absent or not an array.
*
* A caller wanting the raw list can read `entry?.output_modalities` itself;
* this function is the judgment, not the data.
* @param {object} entry - one normalized catalog entry.
* @returns {"declared-image"|"declared-other"|"unknown"}
*/
function outputModalityOf(entry) {
	const out = entry?.output_modalities;
	if (!Array.isArray(out)) return "unknown";
	return out.includes("image") ? "declared-image" : "declared-other";
}
/**
* Whether a catalog entry can be addressed as a CHAT model on this provider's
* OpenAI-compatible endpoint.
*
* PERMISSIVE direction: a missing/unknown field reads as chat, so an entry
* the platform did not annotate does not vanish from the picker. Only an
* explicit image-GENERATION declaration keeps it out (such models answer 404
* on `/v1/chat/completions`, verified 2026-09-29).
* @param {object} entry - one normalized catalog entry.
* @returns {boolean} whether the entry is usable as a chat model.
*/
function isChatModel(entry) {
	return outputModalityOf(entry) !== "declared-image";
}
/**
* Whether one catalog entry is an image-GENERATION model.
*
* STRICT direction of the same judgment: only an EXPLICIT "image" declaration
* counts. A missing field means "unknown", and unknown must not be offered as
* a draw model — unlike the chat direction (permissive), a wrong draw guess
* sends the agent's request to a model that cannot answer.
* @param {object} entry - one normalized catalog entry.
* @returns {boolean}
*/
function isImageGenModel(entry) {
	return outputModalityOf(entry) === "declared-image";
}

//#endregion
//#region src/host/llm-models.ts
/**
* Catalog entry -> pi-ai model descriptor mapping — the pure half of the
* directly-registered SenseNova LLM provider ("one-stop service", step three).
*
* This module deliberately imports NO runtime peer (`@earendil-works/pi-ai`,
* `@deepseek-ai/dsh-llm-pi-ai`): it builds plain objects only, so the mapping
* decisions stay testable on a clean checkout. `llm-adapter.ts` is the
* peer-dependent half that hands these descriptors to `createProvider`.
*
* Three decisions carried here are load-bearing, not cosmetic:
*
* 1. `compat.supportsDeveloperRole: false`. pi-ai picks the system-prompt role
*    as `reasoning && supportsDeveloperRole ? "developer" : "system"`, and when
*    the flag is unset it AUTO-DETECTS, returning true for anything that does
*    not look like a known non-standard provider. SenseNova's direct endpoint
*    does not speak the developer role, so an unset flag makes every request
*    403 forever. Setting it false is the fix the qoder route proved necessary.
* 2. `maxTokens` declares the platform's OWN catalogue ceiling when the
*    catalogue states one. The harness fills an UNDECLARED maxTokens with
*    `defaultMaxTokens ?? 32768` (`dsh-llm-pi-ai` resolveRouteModels), so
*    "declaring nothing" does NOT mean "no ceiling" — it silently caps output
*    at 32768, HALF the ceiling flash-lite's catalogue states (65536; probed
*    2026-10-02: flash-lite accepts `max_tokens: 65536` and refuses 131072
*    with "MaxTokens invalid, should be in [1, 65536]", while v4-flash and
*    glm-5.2 accept 131072 — the ceiling is per-model). Declaring the
*    catalogue figure raises the cap to what the platform allows; a model
*    whose catalogue states no ceiling keeps the field UNDECLARED (the
*    harness 32768 fallback), never a guessed number. Only the field NAME
*    (`max_tokens`) is pinned unconditionally.
* 3. `reasoning: true` + a `thinkingLevelMap`. Every SenseNova chat model
*    advertises `supported_features: ["reasoning"]` and thinks by default
*    (verified 2026-09-29: default reasoning_effort high, thinking text
*    returned as `reasoning` on flash-lite and `reasoning_content` on
*    deepseek/glm/kimi — pi-ai reads both spellings). `reasoning: true` is
*    what makes DSH offer the 思考强度 selector and what makes pi-ai surface
*    the thinking. The map pins picker levels to platform-valid wire values:
*    `off: "none"` (the platform's off spelling — "off" itself 400s),
*    `minimal: null` (unverified on this gateway), and `max` only on glm-5.2
*    (probed 200; rejected 400 on flash-lite / deepseek-v4-flash).
*
* @module dsh-connect-sensenova-token-plan/llm-models
*/
/**
* The model ids whose EVERY quota pool is exhausted.
*
* The panel's `pool-usage` response groups models into pools, each with a
* 5h and a 7d window carrying `limit`/`remaining`. A pool is "exhausted" when
* its limit is known (> 0) and its remaining credit has hit zero in EITHER
* window — at that point a model funded by that pool AND NOTHING ELSE would
* answer a chat request with `429 quota_exceeded`, so the picker should not
* offer it (and the panel should show it greyed). A pool whose limit is
* 0/unknown is NOT counted as exhausted: `credits()` returns 0 for an absent
* limit, and we must not mark half the catalogue unavailable on a shape drift.
*
* Pool membership is NOT exclusive: the platform also lists a model in the
* general pool while it has its own dedicated pool, so one drained pool must
* not remove a model that another pool still funds. Blocking is therefore an
* ALL-POOLS judgement, not a union — a model leaves the picker only when no
* pool covering it is left with credit. (Live 2026-10-17: the general pool's
* 5h window hit 0 while the Flash-Lite dedicated pool still held 530k, and the
* old union rule emptied the ENTIRE picker offer, including that model.)
* @param {object} pools - the `parsePools` result (`{ pools: [...] }`).
* @returns {string[]} the blocked model ids, de-duplicated, in first-seen order.
*/
function exhaustedModelIds(pools) {
	const list = Array.isArray(pools?.pools) ? pools.pools : [];
	const coverage = /* @__PURE__ */ new Map();
	for (const pool of list) {
		const limit5 = num(pool?.window5h?.limit, 0);
		const rem5 = num(pool?.window5h?.remaining, 0);
		const limit7 = num(pool?.window7d?.limit, 0);
		const rem7 = num(pool?.window7d?.remaining, 0);
		const exhausted = limit5 > 0 && rem5 <= 0 || limit7 > 0 && rem7 <= 0;
		const ids = /* @__PURE__ */ new Set();
		for (const id of Array.isArray(pool?.modelIds) ? pool.modelIds : []) if (typeof id === "string" && id !== "") ids.add(id);
		for (const id of ids) {
			const row = coverage.get(id) ?? {
				pools: 0,
				exhausted: 0
			};
			row.pools += 1;
			if (exhausted) row.exhausted += 1;
			coverage.set(id, row);
		}
	}
	const out = [];
	for (const [id, row] of coverage) if (row.pools > 0 && row.exhausted === row.pools) out.push(id);
	return out;
}
/**
* Drained pools that declare no usable `model_ids`.
*
* This is the one state where the all-pools judgement has nothing to work
* with: the pool says "out of credit" but names no models, so `exhaustedModelIds`
* blocks nothing — and the panel's banner stays silent for the same reason. The
* drift is therefore invisible from BOTH ends, and a platform rename of
* `model_ids` would quietly disable quota protection altogether while every
* visible reading still looked right.
*
* A pure query rather than a log: the aggregator must reach the logger through
* a parameter (its purity is asserted by the suite), so the caller decides what
* to do with these labels. `exhaustedModelIds` deliberately treats the same
* shape as "covers nothing" — that behaviour is correct; only its SILENCE was
* the gap.
*
* @param {object} pools - the `parsePools` result (`{ pools: [...] }`).
* @returns {string[]} labels (id, else name, else `#index`) of such pools.
*/
function drainedPoolsWithoutModels(pools) {
	const list = Array.isArray(pools?.pools) ? pools.pools : [];
	const out = [];
	list.forEach((pool, index) => {
		const limit5 = num(pool?.window5h?.limit, 0);
		const rem5 = num(pool?.window5h?.remaining, 0);
		const limit7 = num(pool?.window7d?.limit, 0);
		const rem7 = num(pool?.window7d?.remaining, 0);
		if (!(limit5 > 0 && rem5 <= 0 || limit7 > 0 && rem7 <= 0)) return;
		if ((Array.isArray(pool?.modelIds) ? pool.modelIds : []).filter((id) => typeof id === "string" && id !== "").length > 0) return;
		const id = typeof pool?.id === "string" && pool.id !== "" ? pool.id : "";
		const name = typeof pool?.name === "string" && pool.name !== "" ? pool.name : "";
		out.push(id !== "" ? id : name !== "" ? name : `#${index}`);
	});
	return out;
}
/**
* The provider id this plugin registers under.
*
* It must NOT be the bare `"sensenova"`: a hand-written `llm-pi-ai` row using
* that id can already exist in an operator's profile (apiKeyEnv
* `SENSENOVA_API_KEY`, base `https://token.sensenova.cn/v1/`), and
* `registerAdapter` with a colliding id is refused as a duplicate. This own
* slug-shaped id cannot collide with that row or with another plugin.
*/
const LLM_PROVIDER_ID = "sensenova-token-plan";
/** What the DSH model picker shows as the provider's name. */
const LLM_DISPLAY_NAME = "SenseNova Token Plan";
/**
* The thinking effort the profile pins as DSH's "Default" on this provider.
*
* One constant for two claims: `llm-adapter.ts` pins it into the profile, and
* the snapshot echoes it to the panel roster, so the number the user reads is
* the number the adapter dispatches. Editing one without the other is now
* impossible by construction.
*/
const DEFAULT_REASONING_EFFORT = "high";
/**
* Per-token prices are unknowable for a quota plan; report zero everywhere.
*
* ⚠️ The zeros are a SENTINEL, not "free". SenseNova Token Plan is a credit
* pool billed by pool usage, so a per-token USD price simply does not exist on
* this route — but the model still burns credits. A panel row showing
* "$0.00" is describing "no per-token price known", never "this model costs
* nothing". Keep this comment next to the set so a future reader does not
* "fix" it to real prices or, worse, to `null` (which pi-ai may render as an
* unknown-cost row and break the picker's cost arithmetic).
*/
const NO_COST = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
});
/**
* Advertised context window when the catalog declares no usable one.
*
* pi-ai's options builder does arithmetic on `model.contextWindow`, so an
* undefined value behaves like zero rather than "unknown" and breaks max-token
* calculation; the qoder route therefore always supplies a positive number.
* 128k is the conservative SenseNova-family default; a catalog field that
* states a real window always wins.
*/
const FALLBACK_CONTEXT_WINDOW = 128e3;
/**
* Read a positive context window off the catalog entry's known spellings.
*
* `context_length` is the field the platform actually emits (verified against
* the live catalog, 2026-09); the other spellings are kept as fallbacks in
* case the platform ever reverts to a different name. SenseNova's `/v1/models`
* entries are kept whole by `console-client.ts`, so a field the platform adds
* later needs no parser change here — only its name has to be added to this
* list.
* @param {object} entry - one normalized catalog entry.
* @returns {number} the declared window, or the fallback.
*/
function contextWindowOf(entry) {
	for (const key of [
		"context_length",
		"context_window",
		"contextWindow",
		"max_context_tokens"
	]) {
		const value = Math.floor(num(entry?.[key], 0));
		if (value > 0) return value;
	}
	return FALLBACK_CONTEXT_WINDOW;
}
/**
* Read the platform's declared per-request output ceiling, 0 when unknown.
*
* The 0 return is an OUTCOME, not a blank: the descriptor then keeps
* `maxTokens` UNDECLARED and the harness's `defaultMaxTokens ?? 32768` applies
* — HALF of what flash-lite's catalogue states, so "declaring nothing" is not
* "no ceiling" (module header, decision 2). A non-zero return IS a request
* parameter: `toPiDescriptor` declares it as `maxTokens`, which is what raises
* the cap to what the platform allows.
*
* The same figure is the picker's display value (`rosterWithAvailability`
* carries it as `maxOutputLength` → `llm.metaOutput`), so the number the user
* reads is the number the request carries — one source, not two.
* Same spelling-first policy as {@link contextWindowOf}.
* @param {object} entry - one normalized catalog entry.
* @returns {number} the declared ceiling, or 0 when the entry states none.
*/
function maxOutputLengthOf(entry) {
	for (const key of [
		"max_output_length",
		"maxOutputLength",
		"max_output_tokens"
	]) {
		const value = Math.floor(num(entry?.[key], 0));
		if (value > 0) return value;
	}
	return 0;
}
/**
* The output ceiling a descriptor will ACTUALLY carry for one entry.
*
* Precedence, and this is the only place the order is stated:
* **operator override > the platform's catalogue figure > undeclared**.
* The override exists because the catalogue can UNDERSTATE a model: the module
* header's probe found `deepseek-v4-flash` accepting 131072 while the
* catalogue states 65536. The catalogue is FETCHED, not authored, so an
* operator needs a knob that survives the next refresh — and the refresh
* overwrites nothing else, which is why this is a separate map rather than a
* rewrite of the stored entries (`catalog-store.ts` keeps what the platform
* said; disagreeing with it is a setting, not a data edit).
*
* A 0 return still means UNDECLARED, so the harness's `defaultMaxTokens ??
* 32768` applies. An override deliberately cannot *lower* a catalogue figure
* into "no ceiling": the map only ever states a positive integer, and guessing
* a number where the platform stated none is what decision 2 forbids.
*
* The panel roster quotes THIS function, not {@link maxOutputLengthOf}, so the
* "最大输出" the user reads is the number the request carries. Two callers, one
* order — the alternative (roster quoting the catalogue while the descriptor
* quotes the override) is how the panel starts lying.
* @param {object} entry - one normalized catalog entry.
* @param {object} [overrides] - `{ "<model id>": <ceiling> }`; unsanitized input
*   is tolerated (each value is re-validated here) but `host-config.ts` already
*   sanitized it at the config seam.
* @returns {number} the effective ceiling, or 0 when nothing declares one.
*/
function maxTokensFor(entry, overrides) {
	const id = str(entry?.id, "");
	if (id !== "" && overrides !== null && overrides !== void 0 && typeof overrides === "object") {
		const raw = overrides[id];
		if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
	}
	return maxOutputLengthOf(entry);
}
/**
* The picker's 思考强度 levels, pinned to platform-valid wire spellings.
*
* DSH's picker offers levels from `getSupportedThinkingLevels(model)`
* (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`), and pi-ai's
* openai-completions dispatch sends `reasoning_effort = map[level] ?? level`.
* SenseNova's OpenAI-compat gateway accepts `none`/`low`/`medium`/`high` on
* every chat model, rejects `off` (the OpenAI spelling) and `minimal`, and
* rejects `max` everywhere except glm-5.2; `xhigh` is NOT universal — only
* deepseek-v4-flash took it in the probe (all probed 2026-09-29; the platform's
* own error lists `low, medium, high, xhigh, none`). So:
*
* - `off: "none"` — the picker's "关闭" must send `none`, not `off`;
* - `low`/`medium`/`xhigh` — per-model, gated on the PROBED_EFFORT table below.
*   The 2026-09-29 probe round exercised `none`/`high`/`max`/`xhigh` AND
*   `low`/`medium`; every `true` cell is a recorded 200, and a `false` cell
*   means either a 400 or an inconclusive 429 — the roster line must not quote
*   a level the platform may reject, and the live-contract replay
*   (`test/live-contract.mjs`) flips a cell once a 200 is recorded.
* - `max` — `"max"` on glm-5.2 only, `null` elsewhere.
*
* A value of `null` means "the picker must not offer this level"; a string is
* the wire spelling the level dispatches to.
* @param {object} entry - one normalized catalog entry.
* @returns {object} the thinkingLevelMap.
*/
/**
* Per-model 思考档位 probe table, mirrored from `test/baselines/sensenova-contract.json`
* §reasoningEffort (frozen 2026-09-29).
*
* Each cell is a boolean: `true` = a 200 was recorded for this model/level,
* `false` = closed. A cell left closed because the probe ran into a 429 rpm
* window (not a 400) is "not measured", which is NOT "unsupported" — the
* live-contract replay re-runs it; a model absent from the table keeps only
* `off`/`high` open, and a new model is added WITH its 200-probe evidence,
* never assumed.
*/
const PROBED_EFFORT = Object.freeze({
	"deepseek-v4-flash": {
		low: true,
		medium: true,
		high: true,
		xhigh: true,
		max: false
	},
	"glm-5.2": {
		low: true,
		medium: true,
		high: true,
		xhigh: false,
		max: true
	},
	"sensenova-6.8-flash-lite": {
		low: true,
		medium: true,
		high: true,
		xhigh: false,
		max: false
	},
	"deepseek-v4-pro": {
		low: false,
		medium: false,
		high: true,
		xhigh: false,
		max: false
	},
	"deepseek-flash": {
		low: false,
		medium: true,
		high: true,
		xhigh: false,
		max: false
	},
	"kimi-k3": {
		low: false,
		medium: true,
		high: true,
		xhigh: false,
		max: false
	}
});
function thinkingLevelMapFor(entry) {
	const id = str(entry?.id, "");
	const probed = PROBED_EFFORT[id];
	return {
		off: "none",
		minimal: null,
		low: probed?.low === true ? "low" : null,
		medium: probed?.medium === true ? "medium" : null,
		high: "high",
		xhigh: probed?.xhigh === true ? "xhigh" : null,
		max: probed?.max === true ? "max" : null
	};
}
/** pi-ai's escalation ladder (`EXTENDED_THINKING_LEVELS`). */
const THINKING_LADDER = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* The thinking levels DSH's selector will actually offer for one model.
*
* This mirrors pi-ai's `getSupportedThinkingLevels`
* against OUR map: walk the ladder, drop levels the map pins to `null`, and
* treat `xhigh`/`max` as opt-in (they must be present and non-null). DSH
* builds the model-settings effort list through exactly that function, so a
* roster row quoting this list cannot disagree with what the picker lets the
* user select — one contract, both ends. If pi-ai's rule ever changes, this
* filter changes with it (pinned by test/render + routes).
* @param {object} entry - one normalized catalog entry.
* @returns {string[]} level ids in escalation order, e.g. ["off","low",...].
*/
function supportedThinkingLevels(entry) {
	const map = thinkingLevelMapFor(entry);
	return THINKING_LADDER.filter((level) => {
		const mapped = map[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== void 0;
		return true;
	});
}
/**
* Map one catalog entry onto the pi-ai model descriptor the adapter offers.
*
* Vision is the SAME identification the snapshot publishes
* (`identifyVisionModel`: the platform's `input_modalities` first, the name
* fallback only when no structured field exists) — so the model picker cannot
* disagree with the panel's vision list about which models accept images.
* @param {object} entry - one normalized catalog entry (must carry `id`).
* @param {object} [options] - wiring.
* @param {string} [options.providerId] - the provider id the descriptor belongs to.
* @param {string} [options.baseUrl] - the OpenAI-compatible base URL.
* @returns {object} the pi-ai descriptor.
*/
function toPiDescriptor(entry, options = {}) {
	const { providerId = LLM_PROVIDER_ID, baseUrl } = options;
	const id = str(entry?.id, "");
	if (id === "") throw new Error("toPiDescriptor: catalog entry has no id");
	const vision = identifyVisionModel(entry).vision === true;
	const effectiveMaxTokens = maxTokensFor(entry, options.maxTokensOverrides);
	return {
		id,
		name: str(entry.name, id),
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: vision ? ["text", "image"] : ["text"],
		reasoning: true,
		thinkingLevelMap: thinkingLevelMapFor(entry),
		cost: { ...NO_COST },
		contextWindow: contextWindowOf(entry),
		...effectiveMaxTokens > 0 ? { maxTokens: effectiveMaxTokens } : {},
		compat: {
			maxTokensField: "max_tokens",
			supportsDeveloperRole: false
		}
	};
}
/**
* Narrow a catalog to the models the user enabled.
*
* An **empty list means "no filter"**: a fresh install has curated nothing and
* must still be offered every model (the WorkBuddy convention). Once non-empty
* the list is an allow-list; an id that names no current catalog entry is
* harmless — it simply matches nothing this catalog.
* @param {object[]} entries - the normalized catalog entries.
* @param {string[]} [enabledIds] - the allow-list; empty/absent disables it.
* @returns {object[]} the entries still offered, in catalog order.
*/
function filterByEnabled(entries, enabledIds) {
	const list = Array.isArray(enabledIds) ? enabledIds : [];
	if (list.length === 0) return Array.isArray(entries) ? entries : [];
	const allow = new Set(list);
	return (Array.isArray(entries) ? entries : []).filter((entry) => allow.has(str(entry?.id, "")));
}
/**
* Build the whole descriptor list for one catalog.
*
* Entries without an id are dropped (they could not be addressed on the wire)
* and duplicate ids keep the LAST occurrence, matching the catalog store's
* normalization so the adapter and the persisted catalog can never diverge.
* @param {object[]} entries - the normalized catalog entries.
* @param {object} options - `{ providerId, baseUrl, enabledIds, maxTokensOverrides }`.
* @returns {object[]} the pi-ai descriptors, in first-seen order.
*/
function buildDescriptors(entries, options = {}) {
	const { providerId = LLM_PROVIDER_ID, baseUrl, enabledIds = [], unavailableModelIds = [], maxTokensOverrides } = options;
	const blocked = new Set(Array.isArray(unavailableModelIds) ? unavailableModelIds : []);
	const filtered = filterByEnabled(entries, enabledIds).filter(isChatModel);
	const seen = /* @__PURE__ */ new Map();
	const out = [];
	for (const entry of Array.isArray(filtered) ? filtered : []) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const catalogEntry = entry;
		const id = str(catalogEntry.id, "");
		if (id === "") continue;
		if (blocked.has(id)) continue;
		if (!seen.has(id)) {
			seen.set(id, out.length);
			out.push(void 0);
		}
		out[seen.get(id)] = toPiDescriptor({
			...catalogEntry,
			id
		}, {
			providerId,
			...maxTokensOverrides !== void 0 ? { maxTokensOverrides } : {},
			...baseUrl !== void 0 ? { baseUrl } : {}
		});
	}
	return out;
}
/**
* The panel-facing roster with per-model quota availability.
*
* Like {@link rosterOf} it projects one row per chat-model id, but each row also
* carries whether the model's quota pool is currently exhausted — the
* "清单自带识别" the provider advertises to the panel. Unlike the PICKER
* (which drops exhausted models via `buildDescriptors` so no doomed request is
* dispatched), the panel keeps them in the list, greyed, so the user can see
* *why* a model is missing from the picker rather than wondering where it went.
* @param {object[]} entries - the normalized catalog entries.
* @param {object} pools - the `parsePools` result, or anything without a `pools`
*   array (in which case every row reads as available).
* @param {object} [maxTokensOverrides] - the SAME `{ "<model id>": ceiling }` map
*   a descriptor build gets. Positionally third and optional, so a caller written
*   before the field existed keeps compiling; omitting it makes every row quote
*   the catalogue figure, which is what a deployment with no overrides wants.
* @returns {{id: string, name: string, vision: boolean, available: boolean, quotaExhausted: boolean, contextWindow: number, maxOutputLength: number, thinkingLevels: string[]}[]}
*/
function rosterWithAvailability(entries, pools, maxTokensOverrides) {
	const blocked = new Set(exhaustedModelIds(pools));
	const position = /* @__PURE__ */ new Map();
	const out = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!isChatModel(entry)) continue;
		const id = str(entry?.id, "");
		if (id === "") continue;
		const row = {
			id,
			name: str(entry.name, id),
			vision: identifyVisionModel(entry).vision === true,
			available: !blocked.has(id),
			quotaExhausted: blocked.has(id),
			contextWindow: contextWindowOf(entry),
			maxOutputLength: maxTokensFor(entry, maxTokensOverrides),
			thinkingLevels: supportedThinkingLevels(entry)
		};
		if (position.has(id)) out[position.get(id)] = row;
		else {
			position.set(id, out.length);
			out.push(row);
		}
	}
	return out;
}
/**
* Counts the provider-registration status reports: how many models the catalog
* offered and how many of them accept image input, keyed by the same vision
* identification the descriptors use.
* @param {object[]} entries - the normalized catalog entries.
* @returns {{modelCount: number, visionCount: number, visionIds: string[]}}
*/
function summarizeCatalog(entries) {
	const list = (Array.isArray(entries) ? entries : []).filter(isChatModel);
	const visionIds = list.filter((entry) => str(entry?.id, "") !== "").map((entry) => identifyVisionModel(entry)).filter((entry) => entry.vision === true).map((entry) => entry.id);
	return {
		modelCount: list.filter((entry) => str(entry?.id, "") !== "").length,
		visionCount: visionIds.length,
		visionIds
	};
}
/**
* Enforces one upstream = one provider identity, before the descriptors reach
* the Host.
*
* DSH stamps `source.provider` on every assistant message from the ROUTE id it
* resolved, while `replayState.response.provider` is copied from the
* descriptor's own `provider` field. The Host's replay check compares the two
* and, on a mismatch, drops that assistant turn to a foreign message — pi-ai
* then replays every thinking block as plain text. A descriptor must therefore
* carry exactly the id the adapter registers under. Two upstreams sharing one
* identity constant break that check on whichever route is named differently,
* which is why the two routes here own separate ids (`LLM_PROVIDER_ID`,
* `RACCOON_PROVIDER_ID`) rather than one shared one.
*
* Throws instead of repairing: a mismatched descriptor means every replayed
* turn on that route is already degraded, so assembly time is the last cheap
* place to report it — once, instead of silently on each request.
* @param {object[]} models - the descriptors this upstream will publish.
* @param {string} providerId - the id this upstream registers under.
* @returns {object[]} the same descriptors, when the invariant holds.
*/
function assertProviderOwnership(models, providerId) {
	const owner = str(providerId, "");
	if (owner === "") throw new Error("assertProviderOwnership: providerId is required");
	const list = Array.isArray(models) ? models : [];
	for (const model of list) {
		const stamp = str(model?.provider, "");
		if (stamp !== owner) {
			const id = str(model?.id, "?");
			throw new Error(`assertProviderOwnership: descriptor "${id}" is stamped "${stamp}" but this upstream registers as "${owner}"`);
		}
	}
	return list;
}

//#endregion
export { pickDefined as A, resolveSettings as C, numOrNull as D, num as E, str as F, verbatim as I, redactSecrets as M, resolveServiceWithRetry as N, obj as O, retryBounded as P, resolveDrawTimeoutMs as S, errMsg as T, hostName as _, buildDescriptors as a, name as b, filterByEnabled as c, isImageGenModel as d, checkShape as f, CONFIG_DEFAULTS as g, parseTrend as h, assertProviderOwnership as i, pluginError as j, optional as k, rosterWithAvailability as l, parsePools as m, LLM_DISPLAY_NAME as n, drainedPoolsWithoutModels as o, identifyVisionModel as p, LLM_PROVIDER_ID as r, exhaustedModelIds as s, DEFAULT_REASONING_EFFORT as t, summarizeCatalog as u, inject as v, degrade as w, resolveAuthOverrides as x, isAdmitted as y };
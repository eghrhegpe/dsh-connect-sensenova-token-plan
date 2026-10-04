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
	return (typeof text === "string" ? text : "").replace(/(["']?[Aa]uthorization["']?\s*[:=]\s*["']?)(?!Bearer\s)[^"',;\s]+/g, "$1[REDACTED]").replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]").replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-[REDACTED]").replace(/(["']?(?:password|access_token|refresh_token|api[_-]?key|token)["']?\s*:\s*["'])[^"']+(?=["'])/gi, "$1[REDACTED]").replace(/\b(password|access_token|refresh_token|api[_-]?key|token)\s*=\s*[^&;\s]+/gi, "$1=[REDACTED]");
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
* is the one loop both such callers use — `resolveServiceWithRetry` in
* `lifecycle.ts` (retries a service READ) and the Raccoon mount seed in
* `index.ts` (retries a whole seed pass) — so the backoff shape cannot drift
* between them.
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
* @param value - the call's result (usually a promise), or `null`.
* @param fallback - what to read on absence or rejection; `null` by default,
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
* @param fields - the candidate field map.
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
	/** Deadline for one image request. Image models are slow; chat deadlines do not apply. */
	drawTimeoutMs: 12e4,
	/** Opt-in: register the Raccoon hosted `web_search` provider in `ctx.web`. */
	webSearchEnabled: false
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
* Resolve the row's raw patch config into effective settings.
*
* A malformed row must not throw out of here: `apply` runs at mount, and an
* exception would take the whole plugin down instead of leaving a panel that
* explains itself. So problems are returned as `configError` and surfaced
* through the snapshot route.
* @param config - the row's raw patch config.
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
				drawEnabled: source.drawEnabled === true,
				drawModelId: str(source.drawModelId, ""),
				drawTimeoutMs: clampInt(source.drawTimeoutMs, CONFIG_DEFAULTS.drawTimeoutMs, 5e3),
				webSearchEnabled: source.webSearchEnabled === true
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
				drawEnabled: false,
				drawModelId: "",
				drawTimeoutMs: CONFIG_DEFAULTS.drawTimeoutMs,
				webSearchEnabled: false
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
* @param request - the incoming HTTP request.
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
export { retryBounded as _, name as a, degrade as c, numOrNull as d, obj as f, redactSecrets as g, pluginError as h, isAdmitted as i, errMsg as l, pickDefined as m, hostName as n, resolveAuthOverrides as o, optional as p, inject as r, resolveSettings as s, CONFIG_DEFAULTS as t, num as u, str as v, verbatim as y };
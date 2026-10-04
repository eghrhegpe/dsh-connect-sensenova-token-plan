import { f as obj, u as num, v as str } from "./host-config-D8NSOU3A.js";

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
* The model ids whose quota pool is exhausted.
*
* The panel's `pool-usage` response groups models into pools, each with a
* 5h and a 7d window carrying `limit`/`remaining`. A pool is "exhausted" when
* its limit is known (> 0) and its remaining credit has hit zero in EITHER
* window — at that point every model it covers would answer a chat request
* with `429 quota_exceeded`, so the picker should not offer them (and the
* panel should show them greyed). A pool whose limit is 0/unknown is NOT
* counted as exhausted: `credits()` returns 0 for an absent limit, and we must
* not mark half the catalogue unavailable on a shape drift.
* @param {object} pools - the `parsePools` result (`{ pools: [...] }`).
* @returns {string[]} the exhausted model ids, de-duplicated, in first-seen order.
*/
function exhaustedModelIds(pools) {
	const list = Array.isArray(pools?.pools) ? pools.pools : [];
	const out = /* @__PURE__ */ new Set();
	for (const pool of list) {
		const limit5 = num(pool?.window5h?.limit, 0);
		const rem5 = num(pool?.window5h?.remaining, 0);
		const limit7 = num(pool?.window7d?.limit, 0);
		const rem7 = num(pool?.window7d?.remaining, 0);
		if (!(limit5 > 0 && rem5 <= 0 || limit7 > 0 && rem7 <= 0)) continue;
		for (const id of Array.isArray(pool?.modelIds) ? pool.modelIds : []) if (typeof id === "string" && id !== "") out.add(id);
	}
	return [...out];
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
* This is a DISPLAY fact only. The descriptors deliberately declare no
* `maxTokens` value (module header, decision 2), so this figure never becomes
* a request parameter — it says what the platform can emit at most, so the
* user learns why a long reply can still stop with `finish_reason: length`.
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
		...maxOutputLengthOf(entry) > 0 ? { maxTokens: maxOutputLengthOf(entry) } : {},
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
* @param {object} options - `{ providerId, baseUrl, enabledIds }`.
* @returns {object[]} the pi-ai descriptors, in first-seen order.
*/
function buildDescriptors(entries, options = {}) {
	const { providerId = LLM_PROVIDER_ID, baseUrl, enabledIds = [], unavailableModelIds = [] } = options;
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
* @returns {{id: string, name: string, vision: boolean, available: boolean, quotaExhausted: boolean, contextWindow: number, maxOutputLength: number, thinkingLevels: string[]}[]}
*/
function rosterWithAvailability(entries, pools) {
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
			maxOutputLength: maxOutputLengthOf(entry),
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

//#endregion
export { exhaustedModelIds as a, summarizeCatalog as c, identifyVisionModel as d, parsePools as f, buildDescriptors as i, isImageGenModel as l, LLM_DISPLAY_NAME as n, filterByEnabled as o, parseTrend as p, LLM_PROVIDER_ID as r, rosterWithAvailability as s, DEFAULT_REASONING_EFFORT as t, checkShape as u };
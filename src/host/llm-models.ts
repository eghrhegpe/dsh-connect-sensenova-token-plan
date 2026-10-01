/**
 * Catalog entry -> pi-ai model descriptor mapping — the pure half of the
 * directly-registered SenseNova LLM provider ("one-stop service", step three).
 *
 * This module deliberately imports NO runtime peer (`@earendil-works/pi-ai`,
 * `@deepseek-ai/dsh-llm-pi-ai`): it builds plain objects only, so the mapping
 * decisions are testable on a clean checkout the same way the qoder fork keeps
 * its own pi-ai model mapping peer-free. `llm-adapter.ts` is the peer-dependent half
 * that hands these descriptors to `createProvider`.
 *
 * Two decisions carried here are load-bearing rather than cosmetic:
 *
 * 1. `compat.supportsDeveloperRole: false`. pi-ai picks the system-prompt role
 *    as `reasoning && supportsDeveloperRole ? "developer" : "system"`, and when
 *    the flag is unset it AUTO-DETECTS, returning true for anything that does
 *    not look like a known non-standard provider. SenseNova's direct endpoint
 *    does not speak the developer role, so an unset flag makes every request
 *    403 forever. Setting it false is the fix the qoder route proved necessary.
 * 2. No `maxTokens` VALUE is declared. A declared value becomes the output
 *    ceiling and pi-ai sends it as `max_tokens`, truncating long replies with
 *    `finish: max-tokens`. Only the field NAME (`max_tokens`) is pinned.
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

import { str, num } from "./util.ts";
import { identifyVisionModel } from "./parsers.ts";
import type { AdapterConfig } from "./types.ts";

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
export function exhaustedModelIds(pools) {
  const list = Array.isArray(pools?.pools) ? pools.pools : [];
  const out = new Set();
  for (const pool of list) {
    const limit5 = num(pool?.window5h?.limit, 0);
    const rem5 = num(pool?.window5h?.remaining, 0);
    const limit7 = num(pool?.window7d?.limit, 0);
    const rem7 = num(pool?.window7d?.remaining, 0);
    const exhausted = (limit5 > 0 && rem5 <= 0) || (limit7 > 0 && rem7 <= 0);
    if (!exhausted) continue;
    for (const id of Array.isArray(pool?.modelIds) ? pool.modelIds : []) {
      if (typeof id === "string" && id !== "") out.add(id);
    }
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
export const LLM_PROVIDER_ID = "sensenova-token-plan";

/** What the DSH model picker shows as the provider's name. */
export const LLM_DISPLAY_NAME = "SenseNova Token Plan";

/**
 * The thinking effort the profile pins as DSH's "Default" on this provider.
 *
 * One constant for two claims: `llm-adapter.ts` pins it into the profile, and
 * the snapshot echoes it to the panel roster, so the number the user reads is
 * the number the adapter dispatches. Editing one without the other is now
 * impossible by construction.
 */
export const DEFAULT_REASONING_EFFORT = "high";

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
export const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Advertised context window when the catalog declares no usable one.
 *
 * pi-ai's options builder does arithmetic on `model.contextWindow`, so an
 * undefined value behaves like zero rather than "unknown" and breaks max-token
 * calculation; the qoder route therefore always supplies a positive number.
 * 128k is the conservative SenseNova-family default; a catalog field that
 * states a real window always wins.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

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
export function contextWindowOf(entry) {
  for (const key of ["context_length", "context_window", "contextWindow", "max_context_tokens"]) {
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
export function maxOutputLengthOf(entry) {
  for (const key of ["max_output_length", "maxOutputLength", "max_output_tokens"]) {
    const value = Math.floor(num(entry?.[key], 0));
    if (value > 0) return value;
  }
  return 0;
}

/**
 * Whether a catalog entry can be addressed as a CHAT model on this provider's
 * OpenAI-compatible endpoint.
 *
 * The catalog also lists image GENERATION models (`sensenova-u1-fast`,
 * `sensenova-u1.5-lite`): their `output_modalities` is `["image"]` and they
 * answer 404 "model is not found" on `/v1/chat/completions` (verified
 * 2026-09-29), so offering them as chat models only produces errors in DSH.
 * A missing/unknown `output_modalities` is treated as chat (permissive): the
 * field is new enough that an entry without it should not vanish from the
 * picker.
 * @param {object} entry - one normalized catalog entry.
 * @returns {boolean} whether the entry is usable as a chat model.
 */
export function isChatModel(entry) {
  const out = entry?.output_modalities;
  if (!Array.isArray(out)) return true;
  return !out.includes("image");
}

/**
 * The picker's 思考强度 levels, pinned to platform-valid wire spellings.
 *
 * DSH's picker offers levels from `getSupportedThinkingLevels(model)`
 * (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`), and pi-ai's
 * openai-completions dispatch sends `reasoning_effort = map[level] ?? level`.
 * SenseNova's OpenAI-compat gateway accepts `none`/`low`/`medium`/`high`/
 * `xhigh` on every chat model, rejects `off` (the OpenAI spelling) and
 * `minimal`, and rejects `max` everywhere except glm-5.2 (all probed
 * 2026-09-29; the platform's own error lists `low, medium, high, xhigh,
 * none`). So:
 *
 * - `off: "none"` — the picker's "关闭" must send `none`, not `off`;
 *   - `low`/`medium` — per-model, gated on the PROBED_EFFORT table. The
 *     2026-09-29 probe round exercised `none`/`high`/`max`/`xhigh` only;
 *     these two levels have not yet been probed, so they default closed
 *     (the roster line must not quote a level the platform may reject).
 *     The live-contract replay (`test/live-contract.mjs`) probes them and
 *     flips the table cells once a model's 200 is recorded.
 * - `max` — `"max"` on glm-5.2 only, `null` elsewhere.
 *
 * A value of `null` means "the picker must not offer this level"; a string is
 * the wire spelling the level dispatches to.
 * @param {object} entry - one normalized catalog entry.
 * @returns {object} the thinkingLevelMap.
 */
/**
 * Per-model 思考档位 probe table (frozen 2026-09-29, mirrored from
 * `test/baselines/sensenova-contract.json` §reasoningEffort).
 *
 * The baseline records which `reasoning_effort` values the platform
 * answered 200 for per model:
 *   - `high` — the platform default for every chat model;
 *   - `none` — 关思考, probed 200 on every model;
 *   - `xhigh` — ONLY probed 200 on deepseek-v4-flash;
 *   - `max`   — ONLY probed 200 on glm-5.2;
 *   - `low` / `medium` — 2026-09-30 live-contract replay probed 200 on
 *     sensenova-6.8-flash-lite / deepseek-v4-flash / glm-5.2 (both) and on
 *     deepseek-flash's `medium` (its `low` cell is still INDEFINITE — the
 *     probe hit a 429 rpm window, not a 400, so it is "not measured" not
 *     "unsupported"); deepseek-v4-pro's low/medium are also INDEFINITE for
 *     the same reason. INDEFINITE cells stay closed in this table until a
 *     clean re-run records a 200 (or a 400, which would close them
 *     permanently).
 *
 * The panel roster line must not quote a level the platform may 400 on,
 * so a model absent from this table gets `low`/`medium`/`xhigh`/`max` all
 * closed: only `off` (the `none` wire spelling) and `high` stay open —
 * the two values proven on every chat model by the same 2026-09-29 probe
 * round. A new model that turns out to accept an extra level is added
 * here WITH its probe evidence (see the baseline's `driftLog` discipline),
 * never assumed.
 */
const PROBED_EFFORT = Object.freeze({
  "deepseek-v4-flash": { low: true, medium: true, high: true, xhigh: true, max: false },
  "glm-5.2":           { low: true, medium: true, high: true, xhigh: false, max: true },
  "sensenova-6.8-flash-lite": { low: true, medium: true, high: true, xhigh: false, max: false },
  "deepseek-v4-pro":   { low: false, medium: false, high: true, xhigh: false, max: false },
  // deepseek-flash: medium probed 200; low is INDEFINITE (429, re-run
  // pending) so it stays closed — "not measured" is not "supported".
  "deepseek-flash":    { low: false, medium: true, high: true, xhigh: false, max: false },
  // kimi-k3: medium probed 200; low is INDEFINITE (429, re-run pending).
  "kimi-k3":           { low: false, medium: true, high: true, xhigh: false, max: false }
});

export function thinkingLevelMapFor(entry) {
  const id = str(entry?.id, "");
  const probed = PROBED_EFFORT[id];
  return {
    off: "none",
    minimal: null,
    // low/medium: per-model, gated on the probe table. A model NOT in the
    // table keeps the safe default (both closed) — the panel does not quote
    // a level the platform may reject, and the live-contract replay will
    // flip these cells once it probes them.
    low: probed?.low === true ? "low" : null,
    medium: probed?.medium === true ? "medium" : null,
    // high: the platform default on every chat model; always offered.
    high: "high",
    // Extended levels: only a 200 probe for THIS model opens the level.
    xhigh: probed?.xhigh === true ? "xhigh" : null,
    max: probed?.max === true ? "max" : null
  };
}

/** pi-ai's escalation ladder (`EXTENDED_THINKING_LEVELS`). */
const THINKING_LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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
export function supportedThinkingLevels(entry) {
  const map = thinkingLevelMapFor(entry);
  return THINKING_LADDER.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
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
export function toPiDescriptor(entry: any, options: AdapterConfig = {}) {
  const { providerId = LLM_PROVIDER_ID, baseUrl } = options;
  const id = str(entry?.id, "");
  if (id === "") throw new Error("toPiDescriptor: catalog entry has no id");
  const vision = identifyVisionModel(entry).vision === true;
  return {
    id,
    // Prefer the catalog's own display name; fall back to the id.
    name: str(entry.name, id),
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    // Vision is automatic: the catalog's modality field decides, the user does
    // not configure it per model.
    input: vision ? ["text", "image"] : ["text"],
    // Every SenseNova chat model thinks by default and advertises
    // `supported_features: ["reasoning"]`; see the module header (decision 3)
    // for why the flag is true and what the map pins.
    reasoning: true,
    thinkingLevelMap: thinkingLevelMapFor(entry),
    cost: { ...NO_COST },
    contextWindow: contextWindowOf(entry),
    // `supportsDeveloperRole: false` is load-bearing — see the module header.
    // There is deliberately no `maxTokens` VALUE here: declaring one truncates
    // replies; only the wire field name is pinned.
    compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false }
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
export function filterByEnabled(entries, enabledIds) {
  const list = Array.isArray(enabledIds) ? enabledIds : [];
  if (list.length === 0) return Array.isArray(entries) ? entries : [];
  const allow = new Set(list);
  return (Array.isArray(entries) ? entries : []).filter((entry) => allow.has(str(entry?.id, "")));
}

/**
 * The id that stands for "nothing is offered".
 *
 * An empty allow-list already means "no filter", so there has to be a second
 * spelling for "the filter matched nothing": a string that can never be a real
 * model id, kept as the list's only entry. `filterByEnabled` then filters by
 * an id that matches nothing, which is the offer the user asked for. A bare
 * `[]` cannot mean both "all models" and "no models" at once.
 *
 * The panel carries the SAME literal (`client.js` `HIDE_ALL_MODELS`) because
 * the browser bundle cannot import this module; `test/provider.test.mjs` pins
 * the two together so a rename on either side goes red.
 */
export const HIDE_ALL_MODELS = "__hide_all__";

/**
 * Whether one model id would be offered for a given allow-list.
 *
 * Mirrors {@link filterByEnabled}: an empty list offers everything, a
 * non-empty list is a strict allow-list, and the {@link HIDE_ALL_MODELS}
 * sentinel offers nothing.
 * @param {string[]|undefined} enabledIds - the allow-list; positionally required,
 *   though `undefined`/non-array is tolerated at runtime (treated as empty).
 * @param {string} id - the model id to ask about.
 * @returns {boolean}
 */
export function isModelEnabled(enabledIds, id) {
  const list = Array.isArray(enabledIds) ? enabledIds : [];
  if (list.length === 0) return true;
  return list.includes(str(id, ""));
}

/**
 * The panel-facing roster: one row per addressable catalog entry.
 *
 * Deliberately a projection, not the raw entries: the snapshot carries no
 * more than the picker needs (id, a display name, and the same vision
 * verdict the descriptors use), so a catalogue field the platform adds later
 * cannot leak into the panel for no reason.
 *
 * Deduping keeps the LAST occurrence at its first-seen position, exactly like
 * {@link buildDescriptors} and `catalog-store.normalizeEntries`: a fresher
 * read of the same id wins. If this diverged, the roster and the registered
 * offer would disagree about which models exist, and a ticked model could
 * become an unregistered one.
 * @param {object[]} entries - the normalized catalog entries.
 * @returns {{id: string, name: string, vision: boolean}[]}
 */
export function rosterOf(entries) {
  const position = new Map();
  const out: { id: string; name: string; vision: boolean }[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    // Image-generation models are not chat models and are not offered (see
    // `isChatModel`): the roster and the registered offer must agree about
    // which models exist, or a ticked model could become an unregistered one.
    if (!isChatModel(entry)) continue;
    const id = str(entry?.id, "");
    if (id === "") continue;
    const row = {
      id,
      name: str(entry?.name, id),
      vision: identifyVisionModel(entry).vision === true
    };
    if (position.has(id)) {
      out[position.get(id)] = row;
    } else {
      position.set(id, out.length);
      out.push(row);
    }
  }
  return out;
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
export function buildDescriptors(entries: any[], options: AdapterConfig = {}) {
  const { providerId = LLM_PROVIDER_ID, baseUrl, enabledIds = [], unavailableModelIds = [] } = options;
  // Image-generation models (`output_modalities: ["image"]`) cannot be
  // addressed as chat models and are excluded BEFORE the allow-list, so a
  // stale id in `enabledIds` matches nothing rather than resurrecting one.
  const blocked = new Set(Array.isArray(unavailableModelIds) ? unavailableModelIds : []);
  const filtered = filterByEnabled(entries, enabledIds).filter(isChatModel);
  const seen = new Map();
  // `undefined` slots exist briefly: a first sighting reserves the position
  // (push), the descriptor lands at that index below — the hole is always
  // filled before `out` is returned.
  const out: (object | undefined)[] = [];
  for (const entry of Array.isArray(filtered) ? filtered : []) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = str(entry.id, "");
    if (id === "") continue;
    // A model whose quota pool is exhausted would answer every request with
    // `429 quota_exceeded`, so the picker must not offer it — the panel (via
    // `rosterWithAvailability`) still shows it, greyed, with the reason. Skipping
    // here means a doomed request is never even dispatched.
    if (blocked.has(id)) continue;
    if (!seen.has(id)) {
      seen.set(id, out.length);
      out.push(undefined);
    }
    out[seen.get(id)] = toPiDescriptor({ ...entry, id }, { providerId, baseUrl });
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
export function rosterWithAvailability(entries, pools) {
  const blocked = new Set(exhaustedModelIds(pools));
  const position = new Map();
  const out: { id: string; name: string; vision: boolean; available: boolean; quotaExhausted: boolean; contextWindow: number; maxOutputLength: number; thinkingLevels: string[] }[] = [];
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
      // The window the descriptor itself will use: a declared `context_length`
      // when the catalog has one, else the same 128k fallback pi-ai gets —
      // so the badge never contradicts the effective behavior.
      contextWindow: contextWindowOf(entry),
      // The platform's declared output ceiling (0 = unknown). Widening the
      // projection here is deliberate: the raw entry stays Host-side, and the
      // panel quotes only these two parameter figures plus the vision verdict.
      maxOutputLength: maxOutputLengthOf(entry),
      // What the DSH selector will really offer this model (same rule pi-ai
      // applies to the registered descriptor) — the per-model fact worth
      // repeating on a row, unlike the provider-wide default, which the panel
      // states once in its header.
      thinkingLevels: supportedThinkingLevels(entry)
    };
    if (position.has(id)) {
      out[position.get(id)] = row;
    } else {
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
export function summarizeCatalog(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(isChatModel);
  const visionIds = list
    .filter((entry) => str(entry?.id, "") !== "")
    .map((entry) => identifyVisionModel(entry))
    .filter((entry) => entry.vision === true)
    .map((entry) => entry.id);
  return {
    modelCount: list.filter((entry) => str(entry?.id, "") !== "").length,
    visionCount: visionIds.length,
    visionIds
  };
}

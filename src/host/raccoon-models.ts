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

import { str, num } from "./util.ts";
import { RACCOON_LLM_PREFIX, RACCOON_API_BASE, RACCOON_FALLBACK_MODELS } from "./raccoon.ts";

/** The provider id this plugin registers under for Raccoon. */
export const RACCOON_PROVIDER_ID = "sensenova-raccoon";

/** What the DSH model picker shows as the Raccoon provider's name. */
export const RACCOON_DISPLAY_NAME = "SenseNova Raccoon";

/**
 * The Raccoon LLM base URL the OpenAI-compatible chat endpoint addresses.
 * `openAICompletionsApi` appends `chat/completions` to this.
 */
export const RACCOON_BASE_URL = `${RACCOON_API_BASE}${RACCOON_LLM_PREFIX}`;

/** The zero-cost sentinel: per-token prices are unknowable (credit-gated). */
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** The Raccoon auth/identity headers every request carries. */
export function raccoonRequestHeaders(officeIdentity = "") {
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
export function raccoonRoster(catalog) {
  const rows = Array.isArray(catalog) && catalog.length > 0 ? catalog : RACCOON_FALLBACK_MODELS;
  const out = [];
  for (const row of rows) {
    const id = str(row?.id, "");
    if (id === "") continue;
    out.push({
      id,
      name: str(row?.name, id),
      vision: row?.vision === true,
      multiplier: typeof row?.multiplier === "number" ? row.multiplier : undefined,
      contextWindow: num(row?.contextWindow),
      maxOutputLength: num(row?.maxOutputLength)
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
export function filterRaccoonRows(rows, enabledIds) {
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
export function raccoonToDescriptor(row: any, options: { officeIdentity?: string } = {}) {
  const id = str(row?.id, "");
  if (id === "") throw new Error("racconToDescriptor: row has no id");
  const vision = row?.vision === true;
  // The credit multiplier is billing metadata pi-ai has no channel for (the
  // descriptor's `cost` is per-token USD, which this credit-gated gateway
  // does not have), so it rides in the display name — the only surface the
  // model picker renders. The panel's roster shows the same figure, so the
  // two views cannot disagree.
  const multiplier = typeof row?.multiplier === "number" ? row.multiplier : undefined;
  const suffix = multiplier === undefined ? ""
    : multiplier === 0 ? "（free）"
    : multiplier === 1 ? ""
    : `（×${multiplier}）`;
  return {
    id,
    name: `${str(row?.name, id)}${suffix}`,
    api: "openai-completions",
    provider: RACCOON_PROVIDER_ID,
    baseUrl: RACCOON_BASE_URL,
    input: vision ? ["text", "image"] : ["text"],
    // See the module header: no thinking toggle in v1 (pi-ai cannot emit
    // `extra_body.thinking`); the gateway defaults to thinking ON.
    reasoning: false,
    cost: { ...NO_COST },
    // A positive window is required (pi-ai does arithmetic on it); the Raccoon
    // roster always declares one, but guard against a shape drift.
    contextWindow: num(row?.contextWindow) ?? 256_000,
    maxTokens: num(row?.maxOutputLength) ?? 32_000,
    headers: raccoonRequestHeaders(options.officeIdentity),
    // SenseNova-family: the OpenAI-compat gateway does not speak the
    // developer role, so pin it false (the same fix the qoder route proved).
    compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false }
  };
}

/**
 * Build the whole descriptor list for one Raccoon roster.
 * @param {object[]} [roster] - the {@link raccoonRoster} result.
 * @param {object} [options] - `{ officeIdentity }`.
 * @returns {object[]} the pi-ai descriptors.
 */
export function buildRaccoonDescriptors(roster: any, options: { officeIdentity?: string } = {}) {
  const list = Array.isArray(roster) ? roster : raccoonRoster(null);
  const out = [];
  const seen = new Set();
  for (const row of list) {
    const id = str(row?.id, "");
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(raccoonToDescriptor(row, options));
  }
  return out;
}

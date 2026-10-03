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
export function raccoonRoster(catalog: object[] | null | undefined): object[] {
  const rows = Array.isArray(catalog) && catalog.length > 0 ? catalog : RACCOON_FALLBACK_MODELS;
  const out: object[] = [];
  for (const row of rows) {
    const source = row as { id?: unknown; name?: unknown; vision?: unknown; multiplier?: unknown; contextWindow?: unknown; maxOutputLength?: unknown };
    const id = str(source.id, "");
    if (id === "") continue;
    out.push({
      id,
      name: str(source.name, id),
      vision: source.vision === true,
      multiplier: typeof source.multiplier === "number" ? source.multiplier : undefined,
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
export function filterRaccoonRows(rows: unknown, enabledIds: string[] | null | undefined): object[] {
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
  //
  // Spelled the way WorkBuddy's own selector is (`· x0.79`): the `·` + `x`
  // form is what users already see from the sibling plugin, so a second
  // convention (full-width parentheses, `（free）`) would read as noise. A
  // zero multiplier renders `· x0.00`, matching WorkBuddy's rendering of
  // free models; an absent multiplier keeps the bare name.
  const multiplier = typeof row?.multiplier === "number" ? row.multiplier : undefined;
  const name = str(row?.name, id);
  const displayName = multiplier === undefined ? name : `${name} · x${multiplier.toFixed(2)}`;
  // Read each window value ONCE. The ADR-004 fix spelled `num(row?.x)` in both
  // the condition and the value of the same spread — a doubled parse of the
  // same input, and an asymmetry a later edit could "fix" on one side only.
  // The local is the single source the spread keys off.
  const contextWindow = num(row?.contextWindow);
  const maxOutputLength = num(row?.maxOutputLength);
  return {
    id,
    name: displayName,
    api: "openai-completions",
    provider: RACCOON_PROVIDER_ID,
    baseUrl: RACCOON_BASE_URL,
    input: vision ? ["text", "image"] : ["text"],
    // See the module header: no thinking toggle in v1 (pi-ai cannot emit
    // `extra_body.thinking`); the gateway defaults to thinking ON.
    reasoning: false,
    cost: { ...NO_COST },
    // Declare the CATALOG authority value, never a guessed constant
    // (ADR-004 + docs/SENSENOVA-API.md: "declare the directory value when
    // present, fall back to UNDECLARED when absent so the harness fills its
    // own 32768 default" — the same policy the Token Plan side `llm-models.ts`
    // already follows). The Raccoon gateway returns `context_window` /
    // `max_output_tokens` per model (`fetchRaccoonCatalog`), so when those are
    // absent it is a SHAPE DRIFT, not a missing fact: we omit the field rather
    // than invent 256_000 / 32_000. A positive window really is required by
    // pi-ai's arithmetic, but the harness default is the correct floor — a
    // guessed hard number would just be wrong for whichever model lost its
    // field, and would contradict the directory-first rule.
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputLength === undefined ? {} : { maxTokens: maxOutputLength }),
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
  const out: object[] = [];
  const seen = new Set();
  for (const row of list) {
    const id = str(row?.id, "");
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(raccoonToDescriptor(row, options));
  }
  return out;
}

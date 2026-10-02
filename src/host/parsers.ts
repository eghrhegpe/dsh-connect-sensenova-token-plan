/**
 * Console response parsing and shape-drift detection.
 *
 * The parsers stay forgiving so a poll never throws because a field moved;
 * that forgiveness is also how a platform-side rename becomes a serene "no
 * data yet" screen, so `EXPECTED_SHAPES` + `checkShape` are what let the panel
 * say "the upstream shape changed" instead of "you used nothing".
 * @module dsh-connect-sensenova-token-plan/parsers
 */

import { str, obj } from "./util.ts";
import type { VisionModelData } from "../shared/wire.ts";

/**
 * The top-level keys each console contract is expected to carry.
 *
 * The parsers below stay forgiving so that a poll never throws because a field
 * moved. That forgiveness is also how a platform-side rename becomes a serene
 * "no data yet" screen, so this declaration is what lets the panel say
 * "the upstream shape changed" instead of "you used nothing".
 */
export const EXPECTED_SHAPES = Object.freeze({
  "pool-usage": ["plan", "pools"],
  "credit-usage-trend": ["series"]
});

/** Parse one numeric field the console returns as a string. */
export function credits(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parse one epoch field the console returns as a decimal STRING
 * (`reset_at`, `nearest_grant_expiry`): seconds since the epoch, or `null`
 * when absent or not a usable number. A string here is the console's own
 * shape — `Number` accepts it, and it keeps a second-precision integer.
 */
export function epochSeconds(value) {
  if (value === undefined || value === null || value === "" || value === "0") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/**
 * Report which expected top-level keys a console payload is missing.
 * @param {unknown} body - the parsed console response.
 * @param {string} kind - a key of {@link EXPECTED_SHAPES}.
 * @returns {{ok: boolean, missing: string[]}} the drift report.
 */
export function checkShape(body, kind) {
  const expected = EXPECTED_SHAPES[kind] ?? [];
  const source = obj(body);
  const missing = expected.filter((key) => source[key] === undefined);
  return { ok: missing.length === 0, missing };
}

/** Normalize the `pool-usage` response into the panel's pool rows. */
export function parsePools(body) {
  const plan = obj(body?.plan);
  const pools = Array.isArray(body?.pools) ? body.pools : [];
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
export function parseTrend(body, trendHours) {
  const series = Array.isArray(body?.series) ? body.series : [];
  const rows: { model: string; credits: number }[] = [];
  for (const entry of series) {
    const source = obj(entry);
    const modelId = str(source.model_id, str(source.model_name, ""));
    if (modelId === "") continue;
    const points = Array.isArray(source.points) ? source.points : [];
    let total = 0;
    for (const point of points) {
      total += credits(obj(point).credits);
    }
    rows.push({ model: modelId, credits: Math.round(total * 1000) / 1000 });
  }
  rows.sort((a, b) => b.credits - a.credits);
  return { hours: trendHours, models: rows };
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
export function identifyVisionModel(entry): VisionModelData {
  const source = obj(entry);
  const id = str(source.id, "");
  const modalities = modalitiesOf(source);
  if (modalities !== undefined) {
    return { id, vision: modalities.some((modality) => /image/i.test(modality)), source: "field" };
  }
  // Naming conventions only: multimodal/vision suffixes. Anything that
  // matches neither is reported as not-vision — the panel shows the list,
  // a human can correct. (On SenseNova the platform field above makes this
  // path unreachable; it exists so the plugin degrades sensibly on a
  // provider that exposes no modality metadata at all.)
  const byName = VISION_NAME_PATTERNS.some((pattern) => pattern.test(id));
  return { id, vision: byName, source: byName ? "name" : null };
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
  for (const key of ["input_modalities", "inputTypes", "modality", "capabilities"]) {
    const value = source[key];
    if (Array.isArray(value)) return value.map((modality) => String(modality));
    if (typeof value === "string" && value !== "") return value.split(/[,|]/).map((modality) => modality.trim());
  }
  return undefined;
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

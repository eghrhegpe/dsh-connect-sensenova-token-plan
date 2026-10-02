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
export const EXPECTED_NESTED = Object.freeze({
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
function nestedMissing(body: unknown, path: string): string[] {
  const segments = path.split(".");
  const walk = (node: unknown, index: number): string[] => {
    if (index === segments.length) return [];
    const segment = segments[index] ?? "";
    const isList = segment.endsWith("[]");
    const key = isList ? segment.slice(0, -2) : segment;
    const value = obj(node)[key];
    // Absent, or an array where an object was promised: the requirement fails.
    if (value === undefined) return [path];
    if (isList) {
      if (!Array.isArray(value)) return [path];
      // An empty list is legitimately "no rows yet", not drift.
      return value.some((element) => walk(element, index + 1).length > 0) ? [path] : [];
    }
    return walk(value, index + 1);
  };
  return walk(body, 0);
}

/** Parse one numeric field the console returns as a string. */
export function credits(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parse one epoch field the console returns as a decimal STRING
 * (`reset_at`, `nearest_grant_expiry`): seconds since the epoch, or `null`
 * when absent or not a usable number. A string here is the console's own
 * shape — `Number` accepts it, and it keeps a second-precision integer.
 */
export function epochSeconds(value: unknown): number | null {
  if (value === undefined || value === null || value === "" || value === "0") return null;
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
export function checkShape(body: unknown, kind: string): { ok: boolean; missing: string[] } {
  const expected = EXPECTED_SHAPES[kind as keyof typeof EXPECTED_SHAPES] ?? [];
  const source = obj(body);
  const missing = expected.filter((key) => source[key] === undefined);
  // Only descend where the top level held: a missing root is already reported.
  for (const path of EXPECTED_NESTED[kind as keyof typeof EXPECTED_NESTED] ?? []) {
    const root = (path.split(".")[0] ?? "").replace("[]", "");
    if (root === "" || source[root] === undefined) continue;
    missing.push(...nestedMissing(body, path));
  }
  return { ok: missing.length === 0, missing };
}

/** One normalized pool row (`parsePools` output). */
export interface PoolRow {
  id: string;
  name: string;
  poolType: string;
  modelIds: string[];
  window5h: { limit: number; used: number; remaining: number; resetAt: number | null };
  window7d: { limit: number; used: number; remaining: number; resetAt: number | null };
  grantBalance: number;
  nearestGrantExpiry: number | null;
  nearestGrantExpiringBalance: number;
}

/** The normalized `pool-usage` result. */
export interface PoolUsage {
  plan: { id: string; name: string; type: string };
  pools: PoolRow[];
}

/** Normalize the `pool-usage` response into the panel's pool rows. */
export function parsePools(body: unknown): PoolUsage {
  const source = obj(body);
  const plan = obj(source.plan);
  const pools = Array.isArray(source.pools) ? source.pools : [];
  return {
    plan: {
      id: str(plan.id, ""),
      name: str(plan.name, ""),
      type: str(plan.type, "")
    },
    pools: pools.map((pool: unknown) => {
      const source = obj(pool);
      const window5 = obj(source.window_5h);
      const window7 = obj(source.window_7d);
      return {
        id: str(source.id, ""),
        name: str(source.name, ""),
        poolType: str(source.pool_type, "default"),
        modelIds: Array.isArray(source.model_ids) ? source.model_ids.filter((m: unknown) => typeof m === "string") : [],
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
export function parseTrend(body: unknown, trendHours: number): { hours: number; models: { model: string; credits: number }[] } {
  const source = obj(body);
  const series = Array.isArray(source.series) ? source.series : [];
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
export function identifyVisionModel(entry: unknown): VisionModelData {
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
function modalitiesOf(source: Record<string, unknown>): string[] | undefined {
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

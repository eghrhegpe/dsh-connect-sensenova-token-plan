/**
 * Unit checks for the console parsers — the layer that turns a platform
 * response into the panel's rows, and the one PITFALLS §12 says must never read
 * a renamed field as "no usage".
 *
 * Until now `parsePools` / `parseTrend` / `checkShape` were only touched
 * indirectly: the route stubs served them a single happy-path body, so the drift
 * branch (the whole reason `EXPECTED_SHAPES` exists), the string-number coercion
 * (§11), and the trend SUM-vs-first semantics each had no direct assertion. A
 * regression in any of them stayed green as long as one well-shaped body still
 * parsed. This file exercises them directly, with no network at all — they are
 * pure functions over an object.
 */
import {
  credits,
  epochSeconds,
  checkShape,
  parsePools,
  parseTrend,
  identifyVisionModel,
  EXPECTED_SHAPES
} from "../src/host/parsers.ts";
// Imported here (not a new file) because the multiplier math sits on top of
// parseTrend's rows: same layer of the pipeline, same suite.
import { applyTrendMultipliers } from "../src/host/snapshot-aggregate.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail }); }
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) }); }

// --- 1. credits(): the console returns numbers AS STRINGS (§11) -----------
{
  check("a numeric string becomes a number", credits("60000") === 60000, String(credits("60000")));
  check("a real number passes through", credits(42.5) === 42.5);
  check("a decimal string keeps precision", credits("1234.56") === 1234.56, String(credits("1234.56")));
  // NaN is what a raw `Number(undefined)` produces; the parser must not leak it
  // onto the screen as "NaN".
  check("undefined reads as zero, not NaN", credits(undefined) === 0);
  check("null reads as zero", credits(null) === 0);
  check("an empty string reads as zero", credits("") === 0);
  check("a non-numeric string reads as zero", credits("abc") === 0);
  check("Infinity reads as zero (not finite)", credits(Infinity) === 0);
}

// --- 2. epochSeconds(): decimal-string epochs, and the 1970 trap ----------
// The console sends `reset_at` / `nearest_grant_expiry` as second-precision
// epoch STRINGS. Absent or unusable must be `null`, NOT 0 — reading "no expiry"
// as epoch 0 would render a reset date in 1970.
{
  check("a decimal-string epoch becomes a number", epochSeconds("1800000000") === 1800000000, String(epochSeconds("1800000000")));
  check("a real number epoch passes through", epochSeconds(1800000000) === 1800000000);
  check("fractional seconds are floored", epochSeconds("1800000000.9") === 1800000000, String(epochSeconds("1800000000.9")));
  check("undefined is null (absent)", epochSeconds(undefined) === null);
  check("null is null", epochSeconds(null) === null);
  check('empty string is null', epochSeconds("") === null);
  // The specific trap: the console's own sentinel for "never expires" is "0".
  check('"0" is null, not the year 1970', epochSeconds("0") === null, String(epochSeconds("0")));
  check("numeric 0 is null", epochSeconds(0) === null);
  check("a negative epoch is null", epochSeconds(-5) === null);
  check("a non-numeric string is null", epochSeconds("soon") === null);
}

// --- 3. checkShape(): the drift detector behind shapeWarnings -------------
// Forgiving parsers turn a platform rename into a serene empty screen; this is
// the one place that notices. Both directions matter: a missing key flags, a
// present key does not, and an unknown kind flags nothing (it has no contract).
{
  const poolKeys = EXPECTED_SHAPES["pool-usage"];
  check("pool-usage expects plan and pools",
    poolKeys.includes("plan") && poolKeys.includes("pools"), JSON.stringify(poolKeys));
  // A genuinely complete body: top-level keys AND the nested ones the panel
  // draws from. `{plan:{}, pools:[]}` used to stand in here, back when only the
  // top level was inspected — with the nested contract in place that body is a
  // drift (`plan.id` is gone), so the fixture had to become actually complete.
  const completePool = {
    plan: { id: "p1", name: "TokenPlan", type: "token_plan" },
    pools: [{ id: "pool-1", window_5h: { limit: "1" }, window_7d: { limit: "1" } }]
  };
  check("a complete pool body has no drift",
    checkShape(completePool, "pool-usage").ok === true,
    JSON.stringify(checkShape(completePool, "pool-usage")));
  const missingPools = checkShape({ plan: { id: "p1" } }, "pool-usage");
  check("a dropped `pools` key is reported", missingPools.ok === false && missingPools.missing.includes("pools"),
    JSON.stringify(missingPools));
  const renamedPlan = checkShape({ pools: [], planX: {} }, "pool-usage");
  check("a renamed `plan` is reported as missing", renamedPlan.missing.includes("plan"), JSON.stringify(renamedPlan));
  check("trend expects `series`", EXPECTED_SHAPES["credit-usage-trend"].includes("series"));
  check("a trend body without series drifts",
    checkShape({}, "credit-usage-trend").missing.includes("series"));
  // A null/array body must not throw — obj() folds it to {}.
  check("a null body reports every expected key missing",
    checkShape(null, "pool-usage").missing.length === poolKeys.length);
  check("an array body is not a plain object, so keys are missing",
    checkShape([], "pool-usage").ok === false);
  check("an unknown kind flags nothing", checkShape({}, "does-not-exist").ok === true);

  // --- 3b. the NESTED contract: a rename inside a pool row ----------------
  // The defect this closes: renaming `window_5h` left `plan` and `pools`
  // perfectly present, so the detector said ok and `parsePools` drew 0/0/0 —
  // a serene empty quota instead of "the upstream shape changed".
  const renamedWindow = {
    plan: { id: "p1" },
    pools: [{ id: "pool-1", window_5H: { limit: "1" }, window_7d: { limit: "1" } }]
  };
  const drift = checkShape(renamedWindow, "pool-usage");
  check("a renamed window_5h is reported as drift",
    drift.ok === false && drift.missing.includes("pools[].window_5h"), JSON.stringify(drift));
  // …and the parser really does draw zeros for that body, which is WHY the
  // detector has to catch it: the two halves are asserted against each other.
  const parsedRenamed = parsePools(renamedWindow);
  check("the renamed window really would have drawn 0/0/0",
    parsedRenamed.pools[0].window5h.used === 0 && parsedRenamed.pools[0].window5h.limit === 0,
    JSON.stringify(parsedRenamed.pools[0].window5h));
  const bothRenamed = checkShape({
    plan: { id: "p1" },
    pools: [{ id: "pool-1", window5: {}, window7: {} }]
  }, "pool-usage");
  check("both renamed windows are reported",
    bothRenamed.missing.includes("pools[].window_5h") && bothRenamed.missing.includes("pools[].window_7d"),
    JSON.stringify(bothRenamed));
  const noPlanId = checkShape({ plan: {}, pools: [] }, "pool-usage");
  check("a plan without its id is reported", noPlanId.missing.includes("plan.id"), JSON.stringify(noPlanId));
  // ONE rename must not be blamed twice: when the top-level root is gone the
  // nested path is not also reported.
  const rootGone = checkShape({ pools: [] }, "pool-usage");
  check("a missing `plan` root is reported once, not as plan.id too",
    rootGone.missing.includes("plan") && !rootGone.missing.includes("plan.id"), JSON.stringify(rootGone));
  // An empty pool list is "no rows yet", not drift.
  check("an empty pools array is not nested drift",
    checkShape({ plan: { id: "p1" }, pools: [] }, "pool-usage").ok === true);
  // A pool element that is not an object fails the path rather than throwing.
  check("a non-object pool element is reported, not thrown",
    checkShape({ plan: { id: "p1" }, pools: [null] }, "pool-usage").ok === false);
  check("trend carries no nested requirements yet",
    checkShape({ series: [{ model_id: "m" }] }, "credit-usage-trend").ok === true);
}

// --- 4. parsePools(): normalization of the whole pool row -----------------
{
  const body = {
    plan: { id: "p1", name: "TokenPlan", type: "token_plan" },
    pools: [{
      id: "pool-1", name: "通用池", pool_type: "dedicated", model_ids: ["A", 42, "B"],
      window_5h: { limit: "60000", used: "12345", remaining: "47655", reset_at: "1800000000" },
      window_7d: { limit: 600000, used: 12345, remaining: 587655, reset_at: "1800600000" },
      grant_balance: "500",
      nearest_grant_expiry: "1800900000",
      nearest_grant_expiring_balance: "120"
    }]
  };
  try {
    const out = parsePools(body);
    check("plan fields are carried", out.plan.id === "p1" && out.plan.name === "TokenPlan" && out.plan.type === "token_plan");
    check("one pool row", out.pools.length === 1);
    const pool = out.pools[0];
    check("pool identity + type", pool.id === "pool-1" && pool.name === "通用池" && pool.poolType === "dedicated");
    // model_ids filters to strings only: a stray number cannot reach the panel.
    check("non-string model ids are dropped", pool.modelIds.join(",") === "A,B", pool.modelIds.join(","));
    check("5h window coerces strings to numbers",
      pool.window5h.limit === 60000 && pool.window5h.used === 12345 && pool.window5h.remaining === 47655);
    check("5h reset_at becomes a number", pool.window5h.resetAt === 1800000000, String(pool.window5h.resetAt));
    check("7d window parses alongside", pool.window7d.limit === 600000 && pool.window7d.resetAt === 1800600000);
    check("grant balance is coerced", pool.grantBalance === 500, String(pool.grantBalance));
    check("expiry fields normalize",
      pool.nearestGrantExpiry === 1800900000 && pool.nearestGrantExpiringBalance === 120);
  } catch (error) {
    fail("parsePools normalizes a full row", error);
  }

  // Defaults on a sparse body: pool_type falls back to "default", absent windows
  // become zeros/null rather than throwing.
  try {
    const sparse = parsePools({ plan: {}, pools: [{ id: "x" }] });
    const p = sparse.pools[0];
    check("a missing pool_type defaults to 'default'", p.poolType === "default", p.poolType);
    check("absent model_ids is an empty list", Array.isArray(p.modelIds) && p.modelIds.length === 0);
    check("absent windows read as zero/none, not undefined",
      p.window5h.limit === 0 && p.window5h.resetAt === null && p.window7d.used === 0);
    check("absent grant reads as zero", p.grantBalance === 0);
  } catch (error) {
    fail("parsePools tolerates a sparse pool", error);
  }

  // Malformed top-level shapes must not throw — the poll must survive.
  try {
    check("a missing pools array yields no rows", parsePools({ plan: {} }).pools.length === 0);
    check("a null pools value yields no rows", parsePools({ plan: {}, pools: null }).pools.length === 0);
    check("a completely empty body still parses", parsePools({}).pools.length === 0 && parsePools({}).plan.id === "");
  } catch (error) {
    fail("parsePools survives malformed input", error);
  }
}

// --- 5. parseTrend(): the SUM over points, not the first point ------------
// AGENTS.md names this exact semantic: a test once expected the first point and
// was wrong. Pin the sum, the rounding, the fallback id, and the sort order.
{
  const body = {
    series: [
      { model_id: "Low", points: [{ credits: 1 }, { credits: 2 }] },
      { model_id: "High", points: [{ credits: 42.5 }, { credits: 51.25 }] },
      { model_name: "NameOnly", points: [{ credits: 5 }] },
      { model_id: "Empty", points: [] },
      { model_id: "", points: [{ credits: 9 }] },
      { points: [{ credits: 3 }] }
    ]
  };
  try {
    const out = parseTrend(body, 24);
    check("hours echoes the requested window", out.hours === 24);
    // "" and the entry with neither id nor name are skipped entirely.
    check("rows without any model id are dropped", out.models.length === 4, JSON.stringify(out.models.map((m) => m.model)));
    const byModel = new Map(out.models.map((row) => [row.model, row.credits]));
    check("the trend is a SUM over points (42.5+51.25)", byModel.get("High") === 93.75, String(byModel.get("High")));
    check("a two-point sum adds correctly", byModel.get("Low") === 3, String(byModel.get("Low")));
    check("model_name is the fallback id", byModel.has("NameOnly") === true);
    check("an empty points array sums to zero", byModel.get("Empty") === 0);
    // Rows come back sorted by consumption, descending.
    const creditsList = out.models.map((m) => m.credits);
    check("rows are sorted by credits descending",
      [...creditsList].sort((a, b) => b - a).join(",") === creditsList.join(","), creditsList.join(","));
  } catch (error) {
    fail("parseTrend sums points and orders rows", error);
  }

  // Rounding to three decimals: 12.3456 -> 12.346, and float noise is cleaned.
  try {
    const rounded = parseTrend({ series: [{ model_id: "R", points: [{ credits: 12.3456 }] }] }, 24);
    check("credits round to three decimals", rounded.models[0].credits === 12.346, String(rounded.models[0].credits));
    const noisy = parseTrend({ series: [{ model_id: "N", points: [{ credits: 0.1 }, { credits: 0.2 }] }] }, 24);
    check("float noise (0.1+0.2) rounds clean", noisy.models[0].credits === 0.3, String(noisy.models[0].credits));
  } catch (error) {
    fail("parseTrend rounds cleanly", error);
  }

  // Malformed: a missing/non-array series yields an empty list, not a throw.
  try {
    check("a missing series reads as no rows", parseTrend({}, 24).models.length === 0);
    check("a non-array series reads as no rows", parseTrend({ series: null }, 24).models.length === 0);
    check("a point without credits counts as zero",
      parseTrend({ series: [{ model_id: "Z", points: [{}, { credits: 4 }] }] }, 24).models[0].credits === 4);
  } catch (error) {
    fail("parseTrend survives malformed input", error);
  }
}

// --- 5b. applyTrendMultipliers(): the ×N labels the panel renders ----------
// The pseudo-multiplier matching runs Host-side on the parsed rows, so its
// semantics are part of the wire contract: substring match, case-insensitive,
// first configured key wins, and NO match means NO field (never a guessed 1).
{
  const row = (model) => ({ model, credits: 1 });
  try {
    const out = applyTrendMultipliers(
      { hours: 24, models: [row("GLM-5.2-Pro"), row("kimi-k3"), row("sensenova-6.8"), row("unmatched")] },
      { "glm-5.2": 10, "kimi-k3": 20, sensenova: 1, deepseek: 1 }
    );
    const byModel = new Map(out.models.map((r) => [r.model, r]));
    check("a substring match attaches the multiplier", byModel.get("GLM-5.2-Pro").multiplier === 10, JSON.stringify(byModel.get("GLM-5.2-Pro")));
    check("matching is case-insensitive", byModel.get("kimi-k3").multiplier === 20, String(byModel.get("kimi-k3").multiplier));
    check("a value of 1 still labels the row", byModel.get("sensenova-6.8").multiplier === 1, String(byModel.get("sensenova-6.8").multiplier));
    check("an unmatched row gets NO multiplier field (not 1)",
      !("multiplier" in byModel.get("unmatched")), JSON.stringify(byModel.get("unmatched")));
    check("credits stay verbatim under a multiplier", byModel.get("GLM-5.2-Pro").credits === 1, String(byModel.get("GLM-5.2-Pro").credits));
  } catch (error) {
    fail("applyTrendMultipliers matches rows", error);
  }

  // First-key-wins in insertion order: a model matching two keys takes the
  // one written first, not the "better" one.
  try {
    const out = applyTrendMultipliers({ models: [row("deepseek-sensenova")] }, { sensenova: 1, deepseek: 4 });
    check("first configured key wins on overlap", out.models[0].multiplier === 1, String(out.models[0].multiplier));
  } catch (error) {
    fail("applyTrendMultipliers first-key-wins", error);
  }

  // An empty/absent map (the operator set `{}`) leaves every row bare.
  try {
    const out = applyTrendMultipliers({ models: [row("glm-5.2")] }, {});
    check("an empty map disables all labels", !("multiplier" in out.models[0]), JSON.stringify(out.models[0]));
    const missing = applyTrendMultipliers({ models: [row("glm-5.2")] }, undefined);
    check("an absent map reads as disabled too", !("multiplier" in missing.models[0]), JSON.stringify(missing.models[0]));
  } catch (error) {
    fail("applyTrendMultipliers handles an empty map", error);
  }
}

// --- 6. identifyVisionModel(): which callable models take image input ------
// Step one of the vision plan (ARCHITECTURE.md §5.1). Two signals in priority
// order: a structured modality field wins (SenseNova confirms
// `input_modalities` on every catalog entry, 2026-09 probe); otherwise a name
// pattern, and the result is marked `source: "name"` so the panel can say
// "inferred".
{
  try {
    // Structured field: any of the accepted spellings wins over the name.
    const byField = identifyVisionModel({ id: "mystery", input_modalities: ["text", "image"] });
    check("a structured input_modalities field wins", byField.vision === true && byField.source === "field", JSON.stringify(byField));
    const byFieldOff = identifyVisionModel({ id: "mystery", input_modalities: ["text"] });
    check("a structured field saying text-only is not vision", byFieldOff.vision === false && byFieldOff.source === "field", JSON.stringify(byFieldOff));
    const stringList = identifyVisionModel({ id: "mystery", input_modalities: "text,image" });
    check("a comma-joined field value parses the same", stringList.vision === true && stringList.source === "field");
    const caps = identifyVisionModel({ id: "mystery", capabilities: "image,vision" });
    check("a `capabilities` field is also honored", caps.vision === true && caps.source === "field");
    // A text→image (image OUTPUT) model is not a vision model: only the input
    // side counts.
    const outOnly = identifyVisionModel({ id: "img-out", input_modalities: ["text"], output_modalities: ["image"] });
    check("image-only OUTPUT does not make a model vision", outOnly.vision === false && outOnly.source === "field", JSON.stringify(outOnly));

    // Name pattern, used only when no structured field is present at all.
    // (On SenseNova the platform field makes this path unreachable; it exists
    // so the plugin degrades sensibly on a provider with no modality metadata.)
    const nameHit = identifyVisionModel({ id: "qwen2.5-vl-72b" });
    check("a vision-sounding name matches the pattern", nameHit.vision === true && nameHit.source === "name", JSON.stringify(nameHit));
    const nameMiss = identifyVisionModel({ id: "deepseek-v4-flash" });
    check("a plain text model is not vision", nameMiss.vision === false && nameMiss.source === null, JSON.stringify(nameMiss));
    // The legacy `flash-lite` guess is intentionally NOT a pattern anymore:
    // the real catalog shows sensenova-6.8-flash-lite carries
    // input_modalities ["text","image"] (vision via the field) while
    // sensenova-u1.5-lite is ["text"]-in / ["image"]-out — the name alone
    // was never the reliable signal, so the field is what decides.
    const flashLiteNoField = identifyVisionModel({ id: "sensenova-6.8-flash-lite" });
    check("flash-lite without a field no longer matches by name", flashLiteNoField.vision === false && flashLiteNoField.source === null, JSON.stringify(flashLiteNoField));

    // A field beats a contradicting name: the platform's word wins.
    const conflict = identifyVisionModel({ id: "some-flash-lite", input_modalities: ["text"] });
    check("a text-only field overrides a vision-sounding name", conflict.vision === false && conflict.source === "field");

    // Malformed input must not throw — the catalog poll must survive.
    check("a bare id with no other fields reads as not-vision",
      identifyVisionModel({ id: "x" }).vision === false);
    check("an entry without an id still returns a row", identifyVisionModel({}).id === "");
  } catch (error) {
    fail("identifyVisionModel classifies catalog entries", error);
  }
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

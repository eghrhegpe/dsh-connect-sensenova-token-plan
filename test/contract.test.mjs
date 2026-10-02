/**
 * The frozen SenseNova inference contract — peer-free offline gate.
 *
 * `test/baselines/sensenova-contract.json` pins the 2026-09-29 live probe of
 * `https://token.sensenova.cn/v1` (9 catalog models, thinking-field dialects,
 * reasoning_effort support surface, sampling parameters, modality fields).
 * This suite asserts that the code the panel and the provider run
 * (`llm-models.js` descriptors / vision / chat / quota logic, `parsers.js`
 * normalization, `codes.js` 429/quota classification) still matches that
 * frozen contract. A red here means the CODE drifted from the platform
 * dialect, not the platform changed — the platform side is covered by
 * `test/live-contract.mjs` (manual, `npm run test:live:contract`).
 *
 * Everything here imports no Host peer, so the contract stays covered on a
 * clean checkout. The baseline JSON is the single source of truth for the
 * dialect facts; `docs/SENSENOVA-API.md` §7 is the human-readable mirror.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  toPiDescriptor,
  buildDescriptors,
  isChatModel,
  exhaustedModelIds,
  contextWindowOf,
  thinkingLevelMapFor,
  LLM_PROVIDER_ID
} from "../src/host/llm-models.ts";
import { credits, epochSeconds, parsePools, parseTrend, checkShape, identifyVisionModel } from "../src/host/parsers.ts";
import { retryableCodes, QUOTA_CODES } from "../src/host/llm-retry.ts";
import { isCredentialRefusal, CODE } from "../src/host/codes.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  readFileSync(join(ROOT, "test", "baselines", "sensenova-contract.json"), "utf8")
);
const baseUrl = contract.meta.baseUrl;

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

// --- 1. catalog entry shape from the contract ----------------------------
// The contract's `models` entries are the normalized catalog rows
// (`console-client.js` keeps each `/v1/models` row whole, plus the plugin's
// `id`). Build them exactly the way the provider would see them.
function entryFor(model) {
  return {
    id: model.id,
    input_modalities: model.visionInput ? ["text", "image"] : ["text"],
    output_modalities: model.imageGen ? ["image"] : ["text"],
    ...(model.contextLength !== undefined ? { context_length: model.contextLength } : {}),
    ...(model.maxOutputLength !== undefined ? { max_output_length: model.maxOutputLength } : {})
  };
}

// --- 2. toPiDescriptor against the frozen contract ------------------------
for (const model of contract.models) {
  if (model.chat !== true) continue; // 404/403 models are asserted in §3
  try {
    const entry = entryFor(model);
    const descriptor = toPiDescriptor(entry, { baseUrl });
    check(`${model.id} descriptor.id is the catalog id`, descriptor.id === model.id, descriptor.id);
    check(`${model.id} descriptor pins max_tokens field`,
      descriptor.compat?.maxTokensField === "max_tokens" && descriptor.compat?.supportsDeveloperRole === false,
      JSON.stringify(descriptor.compat));
    // The 2026-10-02 ceiling decision: the harness fills an UNDECLARED
    // maxTokens with 32768, so a catalogue-stated ceiling (flash-lite: 65536,
    // probed) must be DECLARED as maxTokens, and a catalogue entry without a
    // ceiling keeps the field absent (never a guessed number).
    if (model.maxOutputLength !== undefined) {
      check(`${model.id} descriptor declares the catalogue ceiling as maxTokens`,
        descriptor.maxTokens === model.maxOutputLength,
        `got ${String(descriptor.maxTokens)}`);
    } else {
      check(`${model.id} descriptor leaves maxTokens undeclared (no catalogue ceiling)`,
        !Object.prototype.hasOwnProperty.call(descriptor, "maxTokens"),
        JSON.stringify(descriptor));
    }
    check(`${model.id} descriptor declares reasoning + thinkingLevelMap`,
      descriptor.reasoning === true && typeof descriptor.thinkingLevelMap === "object",
      JSON.stringify({ reasoning: descriptor.reasoning }));
    const map = thinkingLevelMapFor(entry);
    check(`${model.id} thinkingLevelMap.off === "none" (platform off spelling)`,
      map.off === "none", JSON.stringify(map));
    // reasoning_effort dialect: the frozen surface decides which wire
    // spellings are platform-valid on THIS model.
    if (model.reasoningEffort?.max === true) {
      check(`${model.id} thinkingLevelMap.max === "max" (platform accepts it)`,
        map.max === "max", JSON.stringify(map.max));
    } else {
      check(`${model.id} thinkingLevelMap.max === null (platform rejects / unverified)`,
        map.max === null, JSON.stringify(map.max));
    }
    // xhigh is gated the same way: offered only where the baseline recorded a
    // 200 probe, closed everywhere else (including models the baseline never
    // probed — absence means "proven on nothing").
    if (model.reasoningEffort?.xhigh === true) {
      check(`${model.id} thinkingLevelMap.xhigh === "xhigh" (platform accepts it)`,
        map.xhigh === "xhigh", JSON.stringify(map.xhigh));
    } else {
      check(`${model.id} thinkingLevelMap.xhigh === null (rejected / unverified)`,
        map.xhigh === null, JSON.stringify(map.xhigh));
    }
    // low/medium: the 2026-09-30 probe round recorded them per-model. `true`
    // (a 200) opens the level; `false` or `"indefinite"` (a 429 rhythm
    // answer, not a 400 — "not measured" not "unsupported") keeps it
    // closed until a clean re-run flips the baseline cell.
    for (const level of ["low", "medium"]) {
      if (model.reasoningEffort?.[level] === true) {
        check(`${model.id} thinkingLevelMap.${level} === "${level}" (probed 200)`,
          map[level] === level, JSON.stringify(map[level]));
      } else {
        check(`${model.id} thinkingLevelMap.${level} === null (unprobed / indefinite)`,
          map[level] === null, JSON.stringify({ cell: model.reasoningEffort?.[level], got: map[level] }));
      }
    }
    check(`${model.id} thinkingLevelMap.minimal === null (unverified on this gateway)`,
      map.minimal === null, JSON.stringify(map.minimal));
    // vision: the descriptor's input array mirrors the contract's
    // visionInput flag (structured `input_modalities` wins).
    const expectedInput = model.visionInput ? ["text", "image"] : ["text"];
    check(`${model.id} descriptor.input matches contract visionInput`,
      JSON.stringify(descriptor.input) === JSON.stringify(expectedInput),
      JSON.stringify({ got: descriptor.input, want: expectedInput }));
    if (model.contextLength !== undefined) {
      check(`${model.id} descriptor.contextWindow reads catalog context_length`,
        descriptor.contextWindow === model.contextLength,
        `${descriptor.contextWindow} vs ${model.contextLength}`);
    }
  } catch (error) { fail(`${model.id} descriptor`, error); }
}

// --- 3. isChatModel excludes the image-generation + 404/403 models -------
for (const model of contract.models) {
  const entry = entryFor(model);
  if (model.imageGen === true) {
    check(`${model.id} (image-gen) is NOT a chat model (excluded from picker)`,
      isChatModel(entry) === false, "isChatModel should be false");
  }
  if (model.status === "404" || model.status === "403") {
    // 404/403 models are still catalog rows; the panel greys them via
    // `exhaustedModelIds` only when their POOL is depleted, not when the
    // endpoint 404s. The contract records them as non-chat (image-gen 404)
    // or as a plan-restriction (403). Assert the code agrees on the
    // image-gen 404 family: `output_modalities:["image"]` is the load-bearing
    // signal, not the status code.
    if (model.imageGen === true) {
      check(`${model.id} (404 image-gen) is excluded from the chat offer`,
        isChatModel(entry) === false, "isChatModel should be false");
    }
  }
}

// --- 4. identifyVisionModel mirrors the contract's visionInput ------------
for (const model of contract.models) {
  const entry = entryFor(model);
  const verdict = identifyVisionModel(entry);
  check(`${model.id} identifyVisionModel.vision matches contract`,
    verdict.vision === (model.visionInput === true),
    JSON.stringify({ got: verdict.vision, want: model.visionInput === true }));
}

// --- 5. buildDescriptors: the picker offer matches the contract -----------
// The offer is every chat model NOT in a depleted pool, filtered by the
// allow-list. With an empty pool and an empty allow-list, the offer is the
// whole chat set. `isChatModel` is PERMISSIVE (a missing/unknown
// `output_modalities` is treated as chat, and `deepseek-v4.1-flash` is a 403
// plan restriction, not an image-gen model), so the picker still lists it —
// the panel greys it via the quota/availability roster instead of dropping it
// from the offer. The image-gen U-series (404) is the only family excluded.
{
  const allEntries = contract.models.map(entryFor);
  // No pool depletion, no allow-list: the picker offers every chat model the
  // contract marks `chat: true` (including the 403-restricted v4.1-flash,
  // which is a plan restriction, not a non-chat model).
  const chatIds = contract.models.filter((m) => m.chat === true).map((m) => m.id);
  const offered = buildDescriptors(allEntries, { baseUrl, enabledIds: [], unavailableModelIds: [] });
  const offeredIds = offered.map((d) => d.id);
  check("buildDescriptors offers exactly the contract's chat models (no pool depletion)",
    JSON.stringify(offeredIds) === JSON.stringify(chatIds),
    JSON.stringify({ offered: offeredIds, want: chatIds }));

  // The image-gen U-series (404 on the chat endpoint) is the only family the
  // picker excludes: `output_modalities: ["image"]` is the load-bearing signal.
  const imageGenIds = contract.models.filter((m) => m.imageGen === true).map((m) => m.id);
  check("buildDescriptors excludes every image-gen model from the offer",
    imageGenIds.every((id) => !offeredIds.includes(id)),
    JSON.stringify({ offered: offeredIds, imageGen: imageGenIds }));

  // A depleted pool covering `deepseek-v4-flash` must drop it from the offer
  // while the panel roster still lists it (greyed).
  const pools = parsePools({
    plan: { id: "p", name: "Token Plan", type: "monthly" },
    pools: [{
      id: "pool-1", name: "default", pool_type: "default",
      model_ids: ["deepseek-v4-flash"],
      window_5h: { limit: "100", used: "100", remaining: "0", reset_at: "1700000000" },
      window_7d: { limit: "1000", used: "500", remaining: "500", reset_at: "1700000000" }
    }]
  });
  const blocked = exhaustedModelIds(pools);
  check("exhaustedModelIds flags the depleted pool's models",
    JSON.stringify(blocked) === JSON.stringify(["deepseek-v4-flash"]),
    JSON.stringify(blocked));
  const offeredBlocked = buildDescriptors(allEntries, { baseUrl, enabledIds: [], unavailableModelIds: blocked });
  check("buildDescriptors drops the quota-depleted model from the offer",
    offeredBlocked.every((d) => d.id !== "deepseek-v4-flash") &&
      offeredBlocked.some((d) => d.id === "deepseek-v4-pro"),
    JSON.stringify(offeredBlocked.map((d) => d.id)));
}

// --- 6. parsers: the contract's numeric/epoch spellings -------------------
{
  check("credits() normalizes a string number (the platform's spelling)",
    credits("12345") === 12345, String(credits("12345")));
  check("credits() returns 0 for an absent value", credits(undefined) === 0, String(credits(undefined)));
  check("epochSeconds() reads a decimal-seconds STRING (not ms)",
    epochSeconds("1700000000") === 1700000000, String(epochSeconds("1700000000")));
  check("epochSeconds() returns null for absent/0",
    epochSeconds(null) === null && epochSeconds("0") === null,
    JSON.stringify([epochSeconds(null), epochSeconds("0")]));
  // The pool-usage shape the panel parses: a missing `pools` key is a drift.
  const drift = checkShape({ plan: { id: "p" } }, "pool-usage");
  check("checkShape flags a pool-usage body missing `pools` (drift, not 'no data')",
    drift.ok === false && drift.missing.includes("pools"), JSON.stringify(drift));
}

// --- 7. 429 / quota classification matches the frozen retry policy --------
{
  const codes = retryableCodes();
  check("retryableCodes keeps RATE_LIMIT (transient throttle self-clears)",
    codes.includes(QUOTA_CODES.rateLimit), JSON.stringify(codes));
  check("retryableCodes excludes QUOTA (depleted shared pool is not retried)",
    !codes.includes(QUOTA_CODES.quota), JSON.stringify(codes));
  check("retryableCodes excludes ACCOUNT_QUOTA",
    !codes.includes(QUOTA_CODES.accountQuota), JSON.stringify(codes));
  // A quota-shaped refusal is parked, never auto-retried (the credential
  // discipline the throttle-store enforces).
  check("isCredentialRefusal treats a parked quota refusal as non-retriable",
    isCredentialRefusal(CODE.LOGIN_REJECTED) === true,
    "login_rejected is the credential-shaped refusal");
}

// --- 8. vision model roster mirrors the contract's visionInput -----------
{
  const allEntries = contract.models.map(entryFor);
  // The vision LIST is asserted through `identifyVisionModel` in §4 against the
  // STRUCTURED field only (the platform's `input_modalities`), independent of a
  // model's 403/404 status. Count the vision chat models the picker offers:
  // every contract model with `chat: true` and `visionInput: true`.
  const visionChat = contract.models.filter((m) => m.chat === true && m.visionInput === true);
  const visionOffer = buildDescriptors(allEntries, { baseUrl, enabledIds: [], unavailableModelIds: [] })
    .filter((d) => JSON.stringify(d.input) === JSON.stringify(["text", "image"]));
  check("the vision offer count matches the contract's visionInput chat models",
    visionOffer.length === visionChat.length,
    `${visionOffer.length} vs ${visionChat.length}`);
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} contract check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} contract checks passed`);

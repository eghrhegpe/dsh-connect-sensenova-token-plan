/**
 * Peer-free checks for the 429 self-healing work:
 *
 * - `llm-retry.js`: the quota-aware retry-policy config (which failure classes
 *   this shared-pool provider retries, and how gently).
 * - `llm-models.js`: `exhaustedModelIds` (pool -> blocked model set),
 *   `buildDescriptors` excluding blocked models, and `rosterWithAvailability`
 *   (the panel's self-identifying roster).
 *
 * Nothing here imports a Host peer, so the policy decisions stay covered on a
 * clean checkout. Where the peer is resolvable (a real Host runtime) an
 * optional block also pins the *resolved* policy, but its absence must not fail
 * the suite.
 */
import {
  buildRetryPolicyConfig,
  retryableCodes,
  QUOTA_CODES
} from "../src/host/llm-retry.ts";
import {
  exhaustedModelIds,
  buildDescriptors,
  rosterWithAvailability,
  supportedThinkingLevels
} from "../src/host/llm-models.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

const BASE_URL = "https://token.sensenova.cn/v1";

// --- 1. buildRetryPolicyConfig: shape + intent ----------------------------
{
  try {
    const cfg = buildRetryPolicyConfig();
    check("policy mode is 'normal'", cfg.mode === "normal", cfg.mode);
    check("maxRetries is a safe integer and rides out daytime rate-limiting (>=8)",
      Number.isSafeInteger(cfg.maxRetries) && cfg.maxRetries >= 8, String(cfg.maxRetries));

    const codes = cfg.retryableCodes;
    check("retryableCodes is a non-empty string array",
      Array.isArray(codes) && codes.length > 0 && codes.every((c) => typeof c === "string"));
    check("retryableCodes includes RATE_LIMIT (transient throttle is retried)",
      codes.includes(QUOTA_CODES.rateLimit));
    check("retryableCodes includes EMPTY_RESPONSE/SERVER/TIMEOUT/TRANSPORT",
      codes.includes(QUOTA_CODES.emptyResponse) &&
      codes.includes(QUOTA_CODES.server) &&
      codes.includes(QUOTA_CODES.timeout) &&
      codes.includes(QUOTA_CODES.transport));
    check("retryableCodes EXCLUDES QUOTA (depleted pool is not retried)",
      !codes.includes(QUOTA_CODES.quota), JSON.stringify(codes));
    check("retryableCodes EXCLUDES ACCOUNT_QUOTA",
      !codes.includes(QUOTA_CODES.accountQuota), JSON.stringify(codes));
    check("retryableCodes has no duplicates",
      new Set(codes).size === codes.length);

    const b = cfg.backoff;
    check("backoff.initialDelayMs is a positive finite number <= maxDelayMs",
      Number.isFinite(b.initialDelayMs) && b.initialDelayMs > 0 && b.initialDelayMs <= b.maxDelayMs,
      JSON.stringify(b));
    check("backoff.initialDelayMs is gentle on the shared pool (>=1000ms)",
      b.initialDelayMs >= 1000, String(b.initialDelayMs));
    check("backoff.maxDelayMs caps the worst-case wait (>=10000ms)",
      b.maxDelayMs >= 10_000, String(b.maxDelayMs));
    check("backoff.jitterRatio is within [0, 1]",
      b.jitterRatio >= 0 && b.jitterRatio <= 1, String(b.jitterRatio));
  } catch (error) {
    fail("buildRetryPolicyConfig", error);
  }
}

// --- 2. QUOTA_CODES spellings match the peer protocol ----------------------
{
  try {
    check("QUOTA_CODES.quota === 'QUOTA'", QUOTA_CODES.quota === "QUOTA");
    check("QUOTA_CODES.accountQuota === 'ACCOUNT_QUOTA'", QUOTA_CODES.accountQuota === "ACCOUNT_QUOTA");
    check("retryableCodes() returns the canonical set (no quota)",
      JSON.stringify(retryableCodes()) ===
      JSON.stringify([
        QUOTA_CODES.emptyResponse,
        QUOTA_CODES.rateLimit,
        QUOTA_CODES.server,
        QUOTA_CODES.timeout,
        QUOTA_CODES.transport
      ]));
  } catch (error) {
    fail("QUOTA_CODES spellings", error);
  }
}

// --- 3. exhaustedModelIds: pool -> blocked model set -----------------------
{
  try {
    const pools = {
      pools: [
        // Pool A: 5h window exhausted -> its models are blocked.
        {
          id: "a", modelIds: ["m1", "m2"],
          window5h: { limit: 100, remaining: 0, resetAt: 1 },
          window7d: { limit: 500, remaining: 400, resetAt: 2 }
        },
        // Pool B: limit unknown (0) with remaining 0 -> NOT exhausted (shape drift guard).
        {
          id: "b", modelIds: ["m3"],
          window5h: { limit: 0, remaining: 0, resetAt: null },
          window7d: { limit: 0, remaining: 0, resetAt: null }
        },
        // Pool C: still has credit -> NOT exhausted.
        {
          id: "c", modelIds: ["m4"],
          window5h: { limit: 50, remaining: 10, resetAt: 3 },
          window7d: { limit: 200, remaining: 100, resetAt: 4 }
        },
        // Pool D: 7d window exhausted (5h still has credit) -> blocked.
        {
          id: "d", modelIds: ["m5"],
          window5h: { limit: 50, remaining: 30, resetAt: 5 },
          window7d: { limit: 200, remaining: 0, resetAt: 6 }
        }
      ]
    };
    const blocked = exhaustedModelIds(pools);
    check("exhaustedModelIds catches both the 5h-exhausted and 7d-exhausted pools",
      JSON.stringify(blocked) === JSON.stringify(["m1", "m2", "m5"]), JSON.stringify(blocked));

    check("a pools object without a pools array yields nothing",
      exhaustedModelIds({}).length === 0);
    check("an undefined pools value yields nothing",
      exhaustedModelIds(undefined).length === 0);
    check("a pool missing both windows is not counted as exhausted",
      exhaustedModelIds({ pools: [{ id: "x", modelIds: ["m9"] }] }).length === 0);
  } catch (error) {
    fail("exhaustedModelIds", error);
  }
}

// --- 4. buildDescriptors excludes quota-exhausted models -------------------
{
  try {
    const entries = [
      { id: "m1" },
      { id: "m2" },
      { id: "m3" },
      { id: "gen", output_modalities: ["image"] }
    ];
    const all = buildDescriptors(entries, { baseUrl: BASE_URL }).map((d) => d.id);
    check("baseline buildDescriptors offers every chat model, skips image-generation",
      JSON.stringify(all) === JSON.stringify(["m1", "m2", "m3"]), JSON.stringify(all));

    const blocked = buildDescriptors(entries, { baseUrl: BASE_URL, unavailableModelIds: ["m2"] }).map((d) => d.id);
    check("buildDescriptors drops an unavailable model from the picker offer",
      JSON.stringify(blocked) === JSON.stringify(["m1", "m3"]), JSON.stringify(blocked));

    const allowBlocked = buildDescriptors(entries, {
      baseUrl: BASE_URL, enabledIds: ["m1", "m2"], unavailableModelIds: ["m2"]
    }).map((d) => d.id);
    check("unavailableModelIds composes with the enabledIds allow-list (m2 dropped even though allowed)",
      JSON.stringify(allowBlocked) === JSON.stringify(["m1"]), JSON.stringify(allowBlocked));

    const implicit = buildDescriptors(entries, { baseUrl: BASE_URL }).map((d) => d.id);
    check("omitting unavailableModelIds does not drop anything extra",
      JSON.stringify(implicit) === JSON.stringify(["m1", "m2", "m3"]));
  } catch (error) {
    fail("buildDescriptors exclusion", error);
  }
}

// --- 5. rosterWithAvailability: the panel's self-identifying roster -------
{
  try {
    const entries = [
      { id: "m1", max_output_length: 65536 },
      { id: "m2" },
      { id: "gen", output_modalities: ["image"] }
    ];
    // m1's pool still has credit; m2's pool has hit zero (5h window).
    const pools = {
      pools: [
        {
          id: "a", modelIds: ["m1"],
          window5h: { limit: 100, remaining: 40, resetAt: 1 },
          window7d: { limit: 500, remaining: 400, resetAt: 2 }
        },
        {
          id: "b", modelIds: ["m2"],
          window5h: { limit: 100, remaining: 0, resetAt: 3 },
          window7d: { limit: 500, remaining: 400, resetAt: 4 }
        }
      ]
    };
    const roster = rosterWithAvailability(entries, pools);
    const byId = Object.fromEntries(roster.map((r) => [r.id, r]));
    check("rosterWithAvailability drops image-generation models",
      !("gen" in byId) && roster.length === 2, JSON.stringify(roster.map((r) => r.id)));
    check("m1 is available (its pool still has credit)",
      byId.m1.available === true && byId.m1.quotaExhausted === false);
    check("m2 is marked quotaExhausted (its pool hit zero)",
      byId.m2.available === false && byId.m2.quotaExhausted === true);
    // The parameter figures the WorkBuddy-shape row quotes: the declared
    // ceiling rides verbatim, an entry without one carries 0 (UNKNOWN, never
    // a guess) so the panel draws no segment for it.
    check("the row projects the platform-declared output ceiling",
      byId.m1.maxOutputLength === 65536, String(byId.m1.maxOutputLength));
    check("an undeclared ceiling projects as 0, not a guessed number",
      byId.m2.maxOutputLength === 0, String(byId.m2.maxOutputLength));
    // The selectable ladder the row quotes must be EXACTLY what pi-ai's
    // getSupportedThinkingLevels computes over our map (null drops; xhigh/max
    // opt-in) — that function is the DSH selector's effort list source.
    check("the row projects the platform-proven thinking levels only",
      JSON.stringify(byId.m1.thinkingLevels) === JSON.stringify(["off", "high"]),
      JSON.stringify(byId.m1.thinkingLevels));
    // Extended levels are per-model and gated on the frozen probe table
    // (`PROBED_EFFORT` in llm-models.ts): `xhigh` only deepseek-v4-flash,
    // `max` only glm-5.2 — a model the platform never answered 200 for a level
    // does not get that level offered, even when its id is unknown. The
    // 2026-09-30 probe round also opened `low`/`medium` on the models it
    // answered 200 for (v4-flash / glm-5.2 / flash-lite / deepseek-flash /
    // kimi-k3 per model — see the baseline), so those rows now carry the
    // full proven ladder; an unknown id still gets only off/high.
    check("probed models carry their full proven ladder; unknown ids keep only off/high; minimal never offered",
      supportedThinkingLevels({ id: "glm-5.2" }).join(",") === "off,low,medium,high,max" &&
      supportedThinkingLevels({ id: "deepseek-v4-flash" }).join(",") === "off,low,medium,high,xhigh" &&
      supportedThinkingLevels({ id: "anything-else" }).join(",") === "off,high",
      [
        "glm-5.2=" + supportedThinkingLevels({ id: "glm-5.2" }).join(","),
        "v4-flash=" + supportedThinkingLevels({ id: "deepseek-v4-flash" }).join(","),
        "other=" + supportedThinkingLevels({ id: "anything-else" }).join(",")
      ].join(" | "));

    // No exhausted pools -> everything available.
    const clear = rosterWithAvailability(entries, { pools: [] });
    check("with no exhausted pools every row reads available",
      clear.every((r) => r.available === true && r.quotaExhausted === false));

    // A non-array / missing pools value must not throw and must read available.
    const safe = rosterWithAvailability(entries, {});
    check("a missing pools array yields available rows without throwing",
      safe.length === 2 && safe.every((r) => r.available === true));

    // Parity: the roster enumerates EVERY chat model (including quota-exhausted,
    // so the panel can show them greyed); the picker (buildDescriptors) offers
    // that same set MINUS the exhausted ids — the two must never disagree about
    // which models exist.
    const rosterIds = roster.map((r) => r.id);
    const built = buildDescriptors(entries, { baseUrl: BASE_URL, unavailableModelIds: ["m2"] }).map((d) => d.id);
    check("roster enumerates every chat model (incl. quota-exhausted)",
      JSON.stringify(rosterIds) === JSON.stringify(["m1", "m2"]), JSON.stringify(rosterIds));
    check("the picker offers roster minus the quota-exhausted ids",
      JSON.stringify(built) === JSON.stringify(rosterIds.filter((id) => !byId[id].quotaExhausted)),
      `${JSON.stringify(built)} vs ${JSON.stringify(rosterIds.filter((id) => !byId[id].quotaExhausted))}`);
  } catch (error) {
    fail("rosterWithAvailability", error);
  }
}

// --- 6. optional: the peer resolves the config the way we claim -----------
// Guarded: a clean checkout (no Host peer) must still pass; a real runtime
// additionally proves `resolveRetryPolicy` accepts our config and excludes
// the quota codes exactly as the snapshot-driven re-registration expects.
{
  try {
    const mod = await import("@deepseek-ai/dsh-llm").catch(() => null);
    if (mod && typeof mod.resolveRetryPolicy === "function") {
      const resolved = mod.resolveRetryPolicy(buildRetryPolicyConfig(), "retry.test");
      check("peer resolveRetryPolicy accepts our config", resolved != null && resolved.mode === "normal");
      check("peer-resolved retryableCodes excludes QUOTA",
        !resolved.retryableCodes.includes(QUOTA_CODES.quota), JSON.stringify(resolved.retryableCodes));
      check("peer-resolved retryableCodes includes RATE_LIMIT",
        resolved.retryableCodes.includes(QUOTA_CODES.rateLimit));
    } else {
      // Same semantics as peer-contract.test.mjs: a SKIP must not push a fake
      // pass into the totals — say it loudly and leave the check count honest.
      console.log("SKIP: peer @deepseek-ai/dsh-llm not resolvable here; the resolveRetryPolicy integration is covered by test/e2e.mjs");
    }
  } catch (error) {
    fail("peer resolveRetryPolicy integration", error);
  }
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

/**
 * The SenseNova inference contract against the LIVE platform — run
 * deliberately, never by default.
 *
 * Companion to `test/live-jwks.test.mjs` (same discipline: not part of
 * `npm test`, a default run must not reach a real service). This one replays
 * the frozen `test/baselines/sensenova-contract.json` against the platform's
 * `/v1/models` catalogue and a SMALL set of inference probes, so a platform
 * dialect drift (a renamed field, a flipped 400, a new modality spelling)
 * shows up as a red here FIRST, before it silently degrades the panel.
 *
 * A failure is INFORMATION, not a regression — the fix belongs in
 * `docs/SENSENOVA-API.md` §7 (the comment layer) plus a refresh of the
 * baseline JSON with the new platform response, never in `llm-models.js`
 * logic. See ROADMAP.md §2.3 (the "live failure is not a regression" rule).
 *
 *   npm run test:live:contract
 *
 * One catalogue request (the `/v1/models` poll) plus a SMALL set of inference
 * probes, kept deliberately small and rate-limit friendly: a 2s backoff
 * between probes keeps the run inside the platform's rpm/rps window. A
 * `429` is recorded as INDEFINITE (the platform rejects the request before
 * validating `reasoning_effort`, so it is a rhythm answer, not a level
 * verdict) and does NOT fail the run — re-run after the window clears.
 * Only a 4xx parameter refusal counts as a real "level unsupported" red.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  readFileSync(join(ROOT, "test", "baselines", "sensenova-contract.json"), "utf8")
);
const BASE_URL = contract.meta.baseUrl;

/** The live `sk-` key, read from the environment. `/v1/models` itself
 *  requires it (无鉴权实测 401，SENSENOVA-API.md §7.1), so without one the
 *  whole replay is meaningless — it SKIPs, loudly, and exits 0 the way
 *  `test/e2e-gate.mjs` does for a missing dsh CLI. A missing key is an
 *  environment fact, not a platform signal; conflating the two would train
 *  readers to ignore reds, which is the one thing a drift guard must never
 *  teach. */
const apiKey = process.env.SENSENOVA_API_KEY ?? "";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

if (apiKey === "") {
  console.log("SKIP test:live:contract — SENSENOVA_API_KEY is not set in this environment.");
  console.log("The platform's /v1/models answers 401 without a key, so nothing here");
  console.log("could distinguish 'the platform drifted' from 'we never asked'. Set the");
  console.log("key (or run on a Host whose credentials service holds it) and re-run.");
  process.exit(0);
}

// --- 1. the catalogue: every contract model still carries its frozen fields -
{
  let body;
  try {
    const response = await fetch(`${BASE_URL}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(30_000)
    });
    check("the /v1/models catalogue is reachable", response.ok, `HTTP ${response.status}`);
    body = await response.json().catch(() => null);
  } catch (error) {
    check("the /v1/models catalogue is reachable", false, String(error?.message ?? error));
  }
  if (body !== null) {
    const ids = new Set((Array.isArray(body.data) ? body.data : []).map((row) => row?.id));
    for (const model of contract.models) {
      check(`the catalogue still lists ${model.id}`, ids.has(model.id),
        `ids: ${[...ids].join(", ") || "none"}`);
      const row = (Array.isArray(body.data) ? body.data : []).find((r) => r?.id === model.id) ?? {};
      // The frozen modality fields in BOTH directions: a rename of
      // `input_modalities` / `output_modalities`, a model RE-CLAIMING image
      // input, or silently LOSING it, is a dialect drift, red here.
      if (model.visionInput === true) {
        check(`${model.id} input_modalities still declares image`,
          Array.isArray(row.input_modalities) && row.input_modalities.includes("image"),
          JSON.stringify(row.input_modalities));
      } else if (model.imageGen !== true && Array.isArray(body.data)) {
        check(`${model.id} input_modalities still declares NO image`,
          !(Array.isArray(row.input_modalities) && row.input_modalities.includes("image")),
          JSON.stringify(row.input_modalities));
      }
      if (model.imageGen === true) {
        check(`${model.id} output_modalities still declares image (excluded from chat)`,
          Array.isArray(row.output_modalities) && row.output_modalities.includes("image"),
          JSON.stringify(row.output_modalities));
      }
      if (model.contextLength !== undefined) {
        check(`${model.id} context_length still ${model.contextLength}`,
          row.context_length === model.contextLength,
          `got ${String(row.context_length)}`);
      }
    }
  }
}

// --- 2. inference probes: one `reasoning_effort` per untested model ------
// Each probe answers ONE question per call, and the answer is written back
// into the baseline by hand afterwards (the "live failure is not a
// regression, refresh the baseline" rule, ROADMAP §2.3):
//   - `reasoning_effort: "low"`   -> does the baseline's `low` cell flip?
//   - `reasoning_effort: "medium"`-> does the baseline's `medium` cell flip?
// The existing `none` probe (the "thinking object is even accepted"
// check) stays.
//
// Two rate-limit disciplines, both load-bearing against a shared pool:
//   1. A backoff BETWEEN probes: back-to-back requests across 7 models trip
//      the platform's rpm/rps windows and turn a parameter question into a
//      rhythm answer. 2s between probes keeps the run inside the window.
//   2. A 429 is NOT a "level unsupported" answer: the platform rejects the
//      request BEFORE it validates `reasoning_effort`, so a rate-limit
//      response proves nothing about the level. It is recorded as
//      INDEFINITE (evidence to re-run later, not a negative conclusion) and
//      excluded from the failure count — only a 4xx parameter refusal is a
//      real "the platform does not accept this level" signal.
// `probeOnce` / `sleep` / `fetchProbe` are function declarations below:
// they hoist to module top, so calling them from here is legal.
const PROBE_BACKOFF_MS = 2000;

for (const model of contract.models) {
  if (model.status !== "ok") continue; // 403/404 plans cannot be probed
  for (const level of ["low", "medium"]) {
    const { response, text, status } = await probeOnce(model.id, level);
    if (status === 429) {
      check(`${model.id} reasoning_effort:"${level}" probe INDEFINITE (rate-limited, not a level verdict)`,
        true, `HTTP 429 ${text.slice(0, 120)} — re-run after the window clears`);
    } else {
      check(`${model.id} reasoning_effort:"${level}" probe answered ${status}`,
        response.ok && status >= 200 && status < 300, `HTTP ${status} ${text.slice(0, 120)}`);
    }
    await sleep(PROBE_BACKOFF_MS);
  }
}

// --- 2b. the untested thinking-object families get their one `none` probe -
// Same discipline as §2 but keyed on `thinkingObject`, kept separate so a
// run where every level probe passes can still surface "this family has
// never had its thinking-object dialect checked".
for (const model of contract.models) {
  if (model.status !== "ok") continue; // 403/404 plans cannot be probed
  const probeNeeded = model.thinkingObject === "untested" || model.thinkingObject === "doc-claimed";
  if (!probeNeeded) continue;
  const { response, text, status } = await probeOnce(model.id, "none");
  if (status === 429) {
    check(`${model.id} reasoning_effort:"none" probe INDEFINITE (rate-limited)`,
      true, `HTTP 429 ${text.slice(0, 120)} — re-run after the window clears`);
  } else {
    check(`${model.id} reasoning_effort:"none" probe answered ${status}`,
      response.ok && status >= 200 && status < 300, `HTTP ${status} ${text.slice(0, 120)}`);
  }
  await sleep(PROBE_BACKOFF_MS);
}

// --- 2c. max_tokens ceiling probe: one declared ceiling per untested model --
// The harness (`dsh-llm-pi-ai` resolveRouteModels) fills an UNDECLARED
// maxTokens with `defaultMaxTokens ?? 32768` — i.e. our historical "declare
// no maxTokens" choice actually caps output at 32768, HALF the platform's
// declared catalogue ceiling (`max_output_length: 65536`). This probe pins
// what the platform itself accepts, so the descriptor can declare the real
// ceiling instead of letting the harness halve it. Same discipline as §2:
// a 429 is a rhythm answer (INDEFINITE, not a ceiling verdict), only a 4xx
// parameter refusal is a real "the platform caps lower" signal.
for (const model of contract.models) {
  if (model.status !== "ok") continue; // 403/404 plans cannot be probed
  const catalogueCeiling = model.maxOutputLength;
  for (const [label, maxTokens] of [
    ["at catalogue ceiling", catalogueCeiling ?? 65536],
    ["double the ceiling", (catalogueCeiling ?? 65536) * 2]
  ]) {
    const { response, text, status } = await probeOnceMaxTokens(model.id, maxTokens);
    if (status === 429) {
      check(`${model.id} max_tokens:${maxTokens} (${label}) probe INDEFINITE (rate-limited, not a ceiling verdict)`,
        true, `HTTP 429 ${text.slice(0, 120)} — re-run after the window clears`);
    } else if (status === 400) {
      check(`${model.id} max_tokens:${maxTokens} (${label}) refused by the platform`,
        true, `HTTP 400 ${text.slice(0, 120)} — the ceiling is lower than this`);
    } else {
      check(`${model.id} max_tokens:${maxTokens} (${label}) accepted`,
        response.ok && status >= 200 && status < 300, `HTTP ${status} ${text.slice(0, 120)}`);
    }
    await sleep(PROBE_BACKOFF_MS);
  }
}

/** One chat-completion probe, unwrapped into {response, text, status}. */
async function probeOnce(modelId, effort) {
  let response;
  try {
    response = await fetchProbe(modelId, effort);
  } catch (error) {
    // A transport failure is a "did not reach the platform" answer, not a
    // level verdict: record it, keep running, exit non-zero is not our job
    // here (the run summary reports the red row, a human re-runs).
    return {
      response: { ok: false, status: 0 },
      text: String(error?.message ?? error),
      status: 0
    };
  }
  const text = await response.text().catch(() => "");
  return { response, text, status: response.status };
}

/** Backoff between probes: keeps the run inside the platform's rpm/rps window.
 *  A function declaration (hoisted, no top-level `const` TDZ) because §2
 *  and §2b call it BEFORE the place it physically lives in this file. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One chat-completion probe; its result is evidence, not a code fix. */
async function fetchProbe(modelId, effort) {
  return fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "ping" }],
      reasoning_effort: effort,
      max_tokens: 8,
      stream: false
    }),
    signal: AbortSignal.timeout(60_000)
  });
}

/** One chat-completion probe with a declared max_tokens ceiling. */
async function fetchProbeMaxTokens(modelId, maxTokens) {
  return fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: "ping" }],
      reasoning_effort: "none",
      max_tokens: maxTokens,
      stream: false
    }),
    signal: AbortSignal.timeout(60_000)
  });
}

/** One max_tokens probe, unwrapped into {response, text, status}. */
async function probeOnceMaxTokens(modelId, maxTokens) {
  let response;
  try {
    response = await fetchProbeMaxTokens(modelId, maxTokens);
  } catch (error) {
    return {
      response: { ok: false, status: 0 },
      text: String(error?.message ?? error),
      status: 0
    };
  }
  const text = await response.text().catch(() => "");
  return { response, text, status: response.status };
}

console.log(JSON.stringify(results, null, 2));
// A 429 is a rhythm answer, not a platform verdict: the request is
// rejected BEFORE `reasoning_effort` is validated, so it proves nothing
// about the level. Indefinite probes are evidence to re-run later, not
// failures — only a 4xx parameter refusal counts against the run.
const failed = results.filter((r) => !r.pass && !r.name.includes("INDEFINITE"));
const indefinite = results.filter((r) => r.name.includes("INDEFINITE"));
if (failed.length > 0 || indefinite.length > 0) {
  if (indefinite.length > 0) {
    console.error(`\n${indefinite.length} probe(s) INDEFINITE (rate-limited, no verdict):`);
    for (const row of indefinite) console.error(`  - ${row.name}`);
    console.error("Re-run after the platform's rate window clears; a 429 is not a level verdict.");
  }
  if (failed.length > 0) {
    console.error(`\n${failed.length}/${results.length} live contract check(s) did not hold`);
    console.error("A live contract failure is usually a PLATFORM change, not a code bug: " +
      "refresh test/baselines/sensenova-contract.json and docs/SENSENOVA-API.md §7.");
  }
  process.exit(failed.length > 0 ? 1 : 0);
}
console.log(`\nall ${results.length} live contract checks passed`);

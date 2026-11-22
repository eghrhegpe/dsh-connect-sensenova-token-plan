/**
 * `RETIRED_MODEL_IDS` — the catalog source filter (0.10.1, GitHub PR #9):
 * models the platform retired but still lists in `/v1/models` are filtered at
 * the source (`fetchModelCatalog`), so they never reach the panel roster or
 * the published provider. Filtering only the cached catalog file would be
 * overwritten by the next live poll — the source filter covers both paths.
 *
 * The fake `fetch` pattern follows `auth.test.mjs` (save/restore
 * `globalThis.fetch` around each block).
 */
import { fetchModelCatalog, RETIRED_MODEL_IDS } from "../src/host/console-client.ts";
import { check, fail, finish } from "./harness.mjs";

const SETTINGS = { apiBase: "https://token.sensenova.cn/v1", consoleTimeoutMs: 5_000 };

function catalogResponse(ids) {
  return { ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id, object: "model" })) }) };
}

// --- 1. the filter surface --------------------------------------------------
check("RETIRED_MODEL_IDS is a frozen closed set holding the retired id",
  RETIRED_MODEL_IDS instanceof Set &&
    Object.isFrozen(RETIRED_MODEL_IDS) &&
    RETIRED_MODEL_IDS.has("sensenova-u1.5-lite"),
  JSON.stringify([...RETIRED_MODEL_IDS]));

// --- 2. live path: retired ids out, controls in ----------------------------
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    catalogResponse(["sensenova-6.8-flash-lite", "sensenova-u1.5-lite", "deepseek-v4-flash"]);
  try {
    const models = await fetchModelCatalog(SETTINGS, 60_000, new Map(), new Map(), "sk-test");
    check("the live catalog drops the retired id and keeps the control models, order intact",
      JSON.stringify(models.map((m) => m.id)) === JSON.stringify(["sensenova-6.8-flash-lite", "deepseek-v4-flash"]),
      JSON.stringify(models.map((m) => m.id)));
  } catch (error) {
    fail("live-path filter", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 3. a catalog of ONLY retired ids yields the empty list -----------------
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => catalogResponse(["sensenova-u1.5-lite", "sensenova-u1.5-lite"]);
  try {
    const models = await fetchModelCatalog(SETTINGS, 60_000, new Map(), new Map(), "sk-test");
    check("an all-retired catalog yields [] (not a phantom entry)",
      Array.isArray(models) && models.length === 0, JSON.stringify(models));
  } catch (error) {
    fail("all-retired catalog", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 4. the pre-existing empty-id filter still stands -----------------------
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    ({ ok: true, status: 200, json: async () => ({ data: [{ id: "" }, { id: "sensenova-6.8-flash-lite" }] }) });
  try {
    const models = await fetchModelCatalog(SETTINGS, 60_000, new Map(), new Map(), "sk-test");
    check("empty ids are still dropped alongside the retired filter",
      JSON.stringify(models.map((m) => m.id)) === JSON.stringify(["sensenova-6.8-flash-lite"]),
      JSON.stringify(models.map((m) => m.id)));
  } catch (error) {
    fail("empty-id filter", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 5. the cached path is filtered too (the cache stores the filtered list) 
{
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return catalogResponse(["sensenova-u1.5-lite", "glm-5.2"]); };
  try {
    const cache = new Map();
    const inflight = new Map();
    const first = await fetchModelCatalog(SETTINGS, 60_000, cache, inflight, "sk-test");
    const second = await fetchModelCatalog(SETTINGS, 60_000, cache, inflight, "sk-test");
    check("the second read comes from cache (no refetch) and stays filtered",
      calls === 1 &&
        JSON.stringify(first.map((m) => m.id)) === JSON.stringify(second.map((m) => m.id)) &&
        !second.some((m) => m.id === "sensenova-u1.5-lite"),
      JSON.stringify({ calls, second: second.map((m) => m.id) }));
  } catch (error) {
    fail("cached-path filter", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 6. the HTTP failure path is untouched by the filter -------------------
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    let threw = false;
    try {
      await fetchModelCatalog(SETTINGS, 60_000, new Map(), new Map(), "sk-test");
    } catch {
      threw = true;
    }
    check("an HTTP error still throws (the filter must not swallow the failure path)", threw);
  } catch (error) {
    fail("failure path", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

finish();

/**
 * Unit checks for the draw absorption module (`draw.js`) — PEER-FREE, like
 * provider.test.mjs:
 *
 * - endpoint building (every operator spelling of `apiBase` lands on the same
 *   `images/generations` URL);
 * - structured image-model identification (the field, NEVER a name regex —
 *   the dsh-draw-router lesson, ARCHITECTURE §5.4);
 * - model picking precedence, wire body clamps, response parsing;
 * - failure classification (the 429 quota-vs-rate split from ROADMAP §1);
 * - `drawOnce` against a fake fetch (success, classified failures, timeout);
 * - the failed-draw cooldown gate;
 * - `defineDrawTool` end-to-end with a passthrough `defineTool` and fake
 *   stores: hint shapes, degradation errors, cooldown wiring, per-call key
 *   resolution.
 *
 * Nothing here imports a Host peer or opens a socket.
 */
import { readFileSync } from "node:fs";
import { drawToolNote } from "../src/host/draw-tool-state.ts";
import {
  DRAW_TOOL_NAME,
  DRAW_COOLDOWN_MS,
  buildDrawEndpoint,
  isImageGenModel,
  imageGenModelIds,
  pickDrawModel,
  buildDrawBody,
  parseDrawResponse,
  describeDrawFailure,
  drawOnce,
  createDrawCooldown,
  defineDrawTool,
  DRAW_OUTPUT_FORMATS,
  normalizeDrawOutputFormat,
  normalizeDrawWatermark
} from "../src/host/draw.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}
async function rejects(fn) {
  try {
    await fn();
  } catch (error) {
    return String(error?.message ?? error);
  }
  return null;
}

// --- 1. buildDrawEndpoint: every apiBase spelling lands on the same URL ----
{
  check("v1 base appends the path",
    buildDrawEndpoint("https://token.sensenova.cn/v1") === "https://token.sensenova.cn/v1/images/generations",
    buildDrawEndpoint("https://token.sensenova.cn/v1"));
  check("trailing slashes are trimmed first",
    buildDrawEndpoint("https://token.sensenova.cn/v1///") === "https://token.sensenova.cn/v1/images/generations");
  check("an explicit endpoint passes through",
    buildDrawEndpoint("https://x.cn/v1/images/generations") === "https://x.cn/v1/images/generations");
  check("a deeper v1 path is rewound",
    buildDrawEndpoint("https://x.cn/v1/chat/completions") === "https://x.cn/v1/images/generations");
  check("a bare host gets the full v1 path",
    buildDrawEndpoint("https://x.cn") === "https://x.cn/v1/images/generations");
  check("empty base builds empty (caller decides)",
    buildDrawEndpoint("") === "" && buildDrawEndpoint(undefined) === "");
}

// --- 2. image-model identification is STRUCTURED, never a name guess -------
{
  const catalog = [
    { id: "sensenova-u1-fast", output_modalities: ["image"] },
    { id: "sensenova-6.8-flash-lite", input_modalities: ["text", "image"] },
    { id: "sensenova-u1.5-lite", output_modalities: ["text", "image"] },
    { id: "no-field-model" },
    { id: "" , output_modalities: ["image"] },
    { id: "sensenova-u1-fast", output_modalities: ["image", "text"] }
  ];
  check("output_modalities with image is a draw model",
    isImageGenModel(catalog[0]) === true);
  check("INPUT image (vision) is not a DRAW model",
    isImageGenModel(catalog[1]) === false);
  check("a missing field is NOT a draw model (strict direction)",
    isImageGenModel(catalog[3]) === false);
  const ids = imageGenModelIds(catalog);
  check("both u1 models are found — the regex route missed u1.5-lite",
    JSON.stringify(ids) === JSON.stringify(["sensenova-u1-fast", "sensenova-u1.5-lite"]),
    JSON.stringify(ids));
  check("duplicate ids keep first-seen position (last occurrence wins)",
    imageGenModelIds([{ id: "a", output_modalities: ["image"] }, { id: "b", output_modalities: ["image"] }, { id: "a", output_modalities: ["image"] }]).join(",") === "a,b");
  check("junk input yields an empty list",
    imageGenModelIds(null).length === 0 && imageGenModelIds("x").length === 0);
}

// --- 3. pickDrawModel precedence -------------------------------------------
{
  const entries = [
    { id: "sensenova-u1-fast", output_modalities: ["image"] },
    { id: "sensenova-u1.5-lite", output_modalities: ["image"] }
  ];
  check("an explicit request wins even off-catalog (manual override)",
    pickDrawModel(entries, "sensenova-u1.5-lite", "sensenova-u1-fast") === "sensenova-u1.5-lite");
  check("an off-catalog request still wins (platform answers the error)",
    pickDrawModel(entries, "custom-model", "") === "custom-model");
  check("the configured preferred model wins when listed",
    pickDrawModel(entries, "", "sensenova-u1.5-lite") === "sensenova-u1.5-lite");
  check("an unlisted preferred model falls back to the first",
    pickDrawModel(entries, "", "not-in-catalog") === "sensenova-u1-fast");
  check("no request and no preference picks the first",
    pickDrawModel(entries, "", "") === "sensenova-u1-fast");
  check("an empty catalog with nothing requested yields null (actionable error upstream)",
    pickDrawModel([], "", "") === null);
}

// --- 4. buildDrawBody clamps -------------------------------------------------
{
  const body = buildDrawBody({ model: "sensenova-u1-fast", prompt: "a cat" });
  check("defaults are n=1 and response_format=url",
    body.n === 1 && body.response_format === "url");
  check("documented output_format and watermark defaults travel",
    body.output_format === "png" && body.watermark === true);
  check("no size field travels when unset", !Object.prototype.hasOwnProperty.call(body, "size"));
  check("size travels when set",
    buildDrawBody({ model: "m", prompt: "p", size: "1024x1024" }).size === "1024x1024");
  check("n clamps to the platform's single-image cap (a hostile value must not burn the pool)",
    buildDrawBody({ model: "m", prompt: "p", n: 99 }).n === 1);
  check("n clamps low and floors fractions to the single-image cap",
    buildDrawBody({ model: "m", prompt: "p", n: 0 }).n === 1 &&
    buildDrawBody({ model: "m", prompt: "p", n: 2.9 }).n === 1);
  check("junk n falls back to 1", buildDrawBody({ model: "m", prompt: "p", n: "many" }).n === 1);
  check("a custom response_format travels",
    buildDrawBody({ model: "m", prompt: "p", responseFormat: "b64_json" }).response_format === "b64_json");
  check("documented output_format values travel through",
    buildDrawBody({ model: "m", prompt: "p", outputFormat: "webp" }).output_format === "webp" &&
    buildDrawBody({ model: "m", prompt: "p", outputFormat: "JPG" }).output_format === "jpg");
  check("junk output_format falls back to png",
    buildDrawBody({ model: "m", prompt: "p", outputFormat: "svg" }).output_format === "png" &&
    buildDrawBody({ model: "m", prompt: "p", outputFormat: 42 }).output_format === "png");
  check("watermark accepts documented boolean values and falls back to true",
    buildDrawBody({ model: "m", prompt: "p", watermark: false }).watermark === false &&
    buildDrawBody({ model: "m", prompt: "p", watermark: "false" }).watermark === false &&
    buildDrawBody({ model: "m", prompt: "p", watermark: "true" }).watermark === true &&
    buildDrawBody({ model: "m", prompt: "p", watermark: "no" }).watermark === true &&
    buildDrawBody({ model: "m", prompt: "p", watermark: 0 }).watermark === true);
  check("the documented output_format list matches the platform docs",
    JSON.stringify(DRAW_OUTPUT_FORMATS) === JSON.stringify(["png", "jpg", "jpeg", "webp"]));
  check("normalize helpers export the documented defaults",
    normalizeDrawOutputFormat("") === "png" &&
    normalizeDrawOutputFormat("WEBP") === "webp" &&
    normalizeDrawWatermark() === true &&
    normalizeDrawWatermark(false) === false);
}

// --- 5. parseDrawResponse ----------------------------------------------------
{
  const urlCase = parseDrawResponse({ data: [{ url: "https://img/x.png", revised_prompt: "better" }] });
  check("url is extracted", urlCase.url === "https://img/x.png" && urlCase.b64Json === "");
  check("revised_prompt is kept", urlCase.revisedPrompt === "better");
  const b64Case = parseDrawResponse({ data: [{ b64_json: "AAAA" }] });
  check("b64_json is extracted", b64Case.b64Json === "AAAA" && b64Case.url === "");
  check("a missing data[0] throws",
    (await rejects(() => parseDrawResponse({ data: [] }))) !== null &&
    (await rejects(() => parseDrawResponse(null))) !== null);
}

// --- 6. describeDrawFailure: the quota-vs-rate split -------------------------
{
  const q = describeDrawFailure(429, '{"code":"insufficient_quota"}');
  check("a quota 429 says so (do not retry blind)", /配额不足/.test(q), q);
  const r = describeDrawFailure(429, "rate limit exceeded");
  check("a rate-limit 429 says wait", /限频/.test(r), r);
  const a = describeDrawFailure(401, "");
  check("auth failures point at the key, not the endpoint", /SENSENOVA_API_KEY/.test(a), a);
  check("a 404 names the endpoint/model", /endpoint/.test(describeDrawFailure(404, "")));
  check("other statuses carry the raw body (truncated)",
    describeDrawFailure(500, "x".repeat(500)).length < 400);
}

// --- 7. drawOnce against a fake fetch ----------------------------------------
{
  const endpoint = "https://token.sensenova.cn/v1/images/generations";
  const okJson = { data: [{ url: "https://img/x.png" }] };
  let seen;
  const okFetch = async (url, options) => {
    seen = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => okJson
    };
  };
  try {
    const result = await drawOnce({
      fetchImpl: okFetch,
      endpoint,
      apiKey: "sk-test",
      body: buildDrawBody({ model: "sensenova-u1-fast", prompt: "a cat" })
    });
    check("success returns the parsed image + model",
      result.url === "https://img/x.png" && result.model === "sensenova-u1-fast");
    check("the endpoint and Bearer key hit the wire",
      seen.url === endpoint && seen.options.headers.Authorization === "Bearer sk-test");
    check("the body travels as JSON with the model",
      JSON.parse(seen.options.body).model === "sensenova-u1-fast");
  } catch (error) {
    fail("drawOnce success path", error);
  }
  {
    const message = await rejects(() => drawOnce({
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => '{"error":"insufficient_quota"}' }),
      endpoint, apiKey: "sk", body: { model: "m", prompt: "p" }
    }));
    check("a non-2xx answer is classified before parsing", /配额不足/.test(message ?? ""), message);
  }
  {
    const message = await rejects(() => drawOnce({
      fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }),
      endpoint, apiKey: "sk", body: { model: "m", prompt: "p" }
    }));
    check("a non-JSON 2xx answer throws a clear error", /not valid JSON/.test(message ?? ""), message);
  }
  {
    const message = await rejects(() => drawOnce({
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      endpoint, apiKey: "sk", body: { model: "m", prompt: "p" }
    }));
    check("a 2xx without data[0] throws", /missing data\[0\]/.test(message ?? ""), message);
  }
  {
    // The deadline aborts through the controller: a fetch honoring the signal
    // must see it, and drawOnce must reject instead of hanging.
    const abortAware = (url, options) => new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    const started = Date.now();
    const message = await rejects(() => drawOnce({
      fetchImpl: abortAware, endpoint, apiKey: "sk", body: { model: "m", prompt: "p" }, timeoutMs: 1000
    }));
    const elapsed = Date.now() - started;
    check("the deadline aborts a hanging fetch (~1s floor)", message !== null && elapsed < 5000, `${message} in ${elapsed}ms`);
  }
  check("a missing fetchImpl throws (wiring bug, not a network error)",
    (await rejects(() => drawOnce({ fetchImpl: undefined, endpoint, apiKey: "sk", body: {} }))) !== null);
}

// --- 8. the cooldown gate -----------------------------------------------------
{
  const gate = createDrawCooldown();
  let now = 1_000_000;
  check("fresh gate is open", gate.blocked(now) === false && gate.remainingMs(now) === 0);
  gate.trip(now);
  check("after a trip the gate is closed for the window",
    gate.blocked(now + 1) === true && gate.blocked(now + DRAW_COOLDOWN_MS) === false);
  check("remainingMs counts down to zero, never negative",
    gate.remainingMs(now + 1) > 0 && gate.remainingMs(now + DRAW_COOLDOWN_MS + 1) === 0);
}

// --- 9. defineDrawTool end-to-end with a passthrough factory ------------------
{
  const passthrough = (definition) => definition; // no peer: the plain object comes back
  const entries = [
    { id: "sensenova-u1-fast", output_modalities: ["image"] },
    { id: "sensenova-u1.5-lite", output_modalities: ["image"] }
  ];
  const settings = { apiBase: "https://token.sensenova.cn/v1", drawModelId: "", drawTimeoutMs: 5000 };
  const makeTool = (overrides = {}) => defineDrawTool({
    defineTool: passthrough,
    resolveApiKey: async () => "sk-live",
    getEntries: () => entries,
    settings,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ url: "https://img/ok.png" }] }) }),
    ...overrides
  });

  try {
    const tool = makeTool();
    check("the tool is scoped so it cannot collide with dsh-draw-router's draw_image",
      tool.name === "sensenova_draw_image" && DRAW_TOOL_NAME === "sensenova_draw_image");
    check("prompt is required",
      (await rejects(() => tool.execute({ prompt: "   " }))) !== null);
    const result = await tool.execute({ prompt: "a cat" });
    check("success renders the markdown-image hint",
      result.source === "sensenova" && result.url === "https://img/ok.png" &&
      /!\[图\]\(https:\/\/img\/ok\.png\)/.test(result.hint), result.hint);
    check("the default model is the first discovered",
      result.model === "sensenova-u1-fast");
    check("a manual model override travels",
      (await tool.execute({ prompt: "a cat", model: "sensenova-u1.5-lite" })).model === "sensenova-u1.5-lite");
  } catch (error) {
    fail("defineDrawTool success path", error);
  }
  {
    const message = await rejects(() => makeTool({ resolveApiKey: async () => "" }).execute({ prompt: "a cat" }));
    check("a missing key degrades with the actionable message", /SENSENOVA_API_KEY/.test(message ?? ""), message);
  }
  {
    const message = await rejects(() => makeTool({ getEntries: () => [] }).execute({ prompt: "a cat" }));
    check("an empty draw catalog degrades with the catalog hint", /没有出图模型/.test(message ?? ""), message);
  }
  {
    // Failure trips the cooldown: the immediate retry is refused with the
    // remaining window, and once the window passes (simulated by flipping the
    // controllable gate) the tool works again — a success can never reset a
    // tripped gate, because the gate blocks the execute entry itself.
    let tripped = false;
    let healthy = false;
    const gate = {
      blocked: () => tripped,
      trip: () => { tripped = true; },
      remainingMs: () => 30_000
    };
    const gateTool = defineDrawTool({
      defineTool: passthrough,
      resolveApiKey: async () => "sk-live",
      getEntries: () => entries,
      settings,
      fetchImpl: async () => healthy
        ? { ok: true, json: async () => ({ data: [{ url: "https://img/ok.png" }] }) }
        : { ok: false, status: 500, text: async () => "boom" },
      cooldown: gate
    });
    const first = await rejects(() => gateTool.execute({ prompt: "a cat" }));
    const second = await rejects(() => gateTool.execute({ prompt: "a cat" }));
    check("a failed draw throws the classified error", /HTTP 500/.test(first ?? ""), first);
    check("the next attempt is refused by the cooldown", /cooldown/.test(second ?? ""), second);
    healthy = true;
    tripped = false; // the 30s window passed
    const recovered = await gateTool.execute({ prompt: "a cat" });
    check("after the window the tool works again", recovered.url === "https://img/ok.png");
  }
  {
    const message = await rejects(() => makeTool({ getEntries: [] }).execute({ prompt: "a cat" }));
    check("a junk getEntries source degrades with the catalog hint", /没有出图模型/.test(message ?? ""), message);
  }
  {
    const liveCatalog = [
      { id: "sensenova-u1-fast", output_modalities: ["image"] },
      { id: "sensenova-u1.5-lite", output_modalities: ["image"] },
      { id: "sensenova-6.8", input_modalities: ["text"] }
    ];
    const tool = makeTool({ getEntries: async () => liveCatalog });
    const result = await tool.execute({ prompt: "a cat" });
    check("the tool exposes the documented extra fields",
      tool.parameters.outputFormat.type === "string" &&
      tool.parameters.watermark.type === "boolean" &&
      /png/.test(tool.parameters.outputFormat.description) &&
      /watermark/.test(tool.parameters.watermark.description));
    check("an async getEntries (the index.js shape) is awaited and used",
      result.model === "sensenova-u1-fast");
  }
  {
    const message = await rejects(() => makeTool({ isDisposed: () => true }).execute({ prompt: "a cat" }));
    check("a disposed plugin refuses draws", /no longer mounted/.test(message ?? ""), message);
  }
}

// --- N. the mount-time service seam: a service that registers late --------
// lifecycle.ts read two optional Host services exactly ONCE per mount, and
// neither capability can be re-established later: the tools registry has no
// unregister call, and the settings row is only written by a poll that finds
// `visionPublish.current` already filled. A service that arrives a moment
// after this plugin mounts was therefore missed for the whole session, with
// the draw switch visibly on and nothing on any panel naming the reason.
// The read retries; the registration must stay exactly once.
{
  const { resolveServiceWithRetry, registerDrawTool, startSideEffects } = await import(
    "../src/host/lifecycle.ts"
  );
  const { createEffectRegistry } = await import("../src/host/effects.ts");
  try {
    {
      let reads = 0;
      const service = { late: true };
      const ctx = { get: () => { reads += 1; return reads >= 2 ? service : undefined; } };
      const value = await resolveServiceWithRetry(ctx, "tools");
      check("a service that registers late is picked up inside the window",
        value === service, `reads=${reads}`);
      check("the retry stops as soon as the service appears", reads === 2, `reads=${reads}`);
    }
    {
      let reads = 0;
      const ctx = { get: () => { reads += 1; return undefined; } };
      const value = await resolveServiceWithRetry(ctx, "tools", { delayMs: 1 });
      check("a service that never appears reads as null after the window",
        value === null && reads === 3, `value=${value} reads=${reads}`);
    }
    {
      let reads = 0;
      const ctx = { get: () => { reads += 1; return undefined; } };
      const value = await resolveServiceWithRetry(ctx, "tools", { isDisposed: () => true });
      check("a withdrawing plugin stops reading immediately", value === null && reads === 0,
        `reads=${reads}`);
    }
    // registerDrawTool: the switch is on, the tools service only appears on
    // the second read. The tool must land exactly once — retrying the
    // registration would register a tool the registry cannot unregister twice.
    {
      let reads = 0;
      const registered = [];
      const ctx = {
        get: (service) => {
          if (service !== "tools") return undefined;
          reads += 1;
          return reads >= 2 ? { register: (tool) => { registered.push(tool); } } : undefined;
        }
      };
      const wiring = {
        settings: { drawEnabled: true, drawModelId: "" },
        configError: null,
        providerState: { entries: [{ id: "sensenova-u1-fast", output_modalities: ["image"] }] },
        catalogStore: { list: async () => [] },
        resolveApiKey: async () => "sk-live",
        publisher: { isDisposed: () => false },
        drawStore: { enabled: async () => null, modelId: async () => null }
      };
      const side = {
        loadToolsModule: async () => ({ defineTool: (tool) => ({ name: tool.name }) }),
        drawFetch: async () => ({})
      };
      await registerDrawTool(ctx, wiring, side);
      check("a late tools service still registers the draw tool",
        registered.length === 1 && typeof registered[0] === "object",
        `registered=${registered.length} reads=${reads}`);
      check("the draw tool is registered exactly once despite the retry",
        registered.length === 1 && reads === 2, `registered=${registered.length} reads=${reads}`);
      check("a successful registration does NOT mark the tool absent",
        drawToolNote() === null, `drawToolNote=${drawToolNote()}`);
    }
    // The one normal absence the panel states: the switch is on but the tools
    // service carries no `register` function, so the tool never registered.
    // `register: null` is returned on the FIRST read, so the retry loop stops
    // at once — this is the no-tools-service case, not the peer/registry one.
    {
      const ctx = { get: () => ({ register: null }) };
      const wiring = {
        settings: { drawEnabled: true, drawModelId: "" },
        configError: null,
        providerState: { entries: [] },
        catalogStore: { list: async () => [] },
        resolveApiKey: async () => "sk-live",
        publisher: { isDisposed: () => false },
        drawStore: { enabled: async () => null, modelId: async () => null }
      };
      const side = { loadToolsModule: async () => ({}), drawFetch: async () => ({}) };
      await registerDrawTool(ctx, wiring, side);
      check("no tools service names that reason for the panel copy",
        drawToolNote() === "no-tools-service", `drawToolNote=${drawToolNote()}`);
    }
    // The two Host-bug reasons: a peer that fails to load, and a registry that
    // refuses the registration. Both must name THEIR reason, so the panel tells
    // "Host can't run this peer" apart from "Host refused the tool" — and both
    // also log via `degrade` (marker checks below).
    {
      const wiring = {
        settings: { drawEnabled: true, drawModelId: "" },
        configError: null,
        providerState: { entries: [] },
        catalogStore: { list: async () => [] },
        resolveApiKey: async () => "sk-live",
        publisher: { isDisposed: () => false },
        drawStore: { enabled: async () => null, modelId: async () => null },
        logger: { warn: () => {} }
      };
      const side = { loadToolsModule: async () => { throw new Error("ERR_MODULE_NOT_FOUND boom"); }, drawFetch: async () => ({}) };
      await registerDrawTool({ get: () => ({ register: () => {} }) }, wiring, side);
      check("a peer that fails to load names that reason",
        drawToolNote() === "peer-load-failed", `drawToolNote=${drawToolNote()}`);

      const sideRefuse = { loadToolsModule: async () => ({ defineTool: () => ({ name: "x" }) }), drawFetch: async () => ({}) };
      const refusing = { register: () => { throw new Error("registry says no"); } };
      await registerDrawTool({ get: () => refusing }, wiring, sideRefuse);
      check("a registry that refuses names that reason",
        drawToolNote() === "registry-refused", `drawToolNote=${drawToolNote()}`);
    }
    // startSideEffects: vision step two's writer is only filled once the
    // settings service can actually be reached. A poll after the late fill
    // writes the row, and an unchanged list still writes nothing.
    {
      let reads = 0;
      const visionPublish = { current: null };
      const settingsService = {
        describe: () => [{ ns: "dsh-connect-sensenova-token-plan", revision: 7 }],
        updates: [],
        async update(ns, value, revision) {
          this.updates.push({ ns, value, revision });
        }
      };
      const ctx = {
        get: (service) => {
          if (service !== "settings") return undefined;
          reads += 1;
          return reads >= 2 ? settingsService : undefined;
        }
      };
      const wiring = {
        settings: { writeImageModelIds: true, imageModelIds: [] },
        visionPublish,
        // Required slot since 2026-10-05 (was `webSearchRestore?`):
        // startSideEffects reaches reconcileWebSearch, so a wiring that omits
        // it now throws instead of quietly reading "undefined = not armed".
        webSearchRestore: { current: null },
        publisher: {
          publish: async () => ({ ok: true }),
          dispose: () => {},
          isDisposed: () => false,
          state: {}
        },
        catalogStore: { list: async () => [], listEnabledIds: async () => [] },
        logger: { warn: () => {} }
      };
      startSideEffects(ctx, wiring, {
        loadToolsModule: async () => ({ defineTool: () => ({ name: "x" }) }),
        drawFetch: async () => ({})
      }, createEffectRegistry(wiring.logger));
      // The retry window is real time (300ms × attempt index).
      await new Promise((resolve) => setTimeout(resolve, 700));
      check("the vision writer is filled once the settings service appears",
        typeof visionPublish.current === "function" && reads === 2, `reads=${reads}`);
      await visionPublish.current([{ id: "vision-1" }], ["vision-1"]);
      check("a poll after the late service writes the settings row",
        settingsService.updates.length === 1
          && JSON.stringify(settingsService.updates[0].value.imageModelIds) === JSON.stringify(["vision-1"])
          && settingsService.updates[0].revision === 7,
        JSON.stringify(settingsService.updates));
      await visionPublish.current([{ id: "vision-1" }], ["vision-1"]);
      check("an unchanged vision list writes nothing on the next poll",
        settingsService.updates.length === 1, JSON.stringify(settingsService.updates));
    }
  } catch (error) {
    fail("the mount-time service seam", error);
  }
}

// --- 12. the two silent draw-path catches must keep calling `degrade` ----
// A regression here has no test that would catch it behaviourally: both paths
// end in "tool absent, panel fine", so the failure mode is absence, not a
// throw. Grep the source for the markers instead — a bare `catch {` on either
// path is a real bug this repo has already shipped once.
{
  const lifecycleSrc = readFileSync(new URL("../src/host/lifecycle.ts", import.meta.url), "utf8");
  check("draw peer-load failure is not silent (degrade marker present)",
    lifecycleSrc.includes('degrade("draw: tools peer module failed to load"'),
    "lifecycle.ts tools-peer load catch");
  check("draw registry refusal is not silent (degrade marker present)",
    lifecycleSrc.includes('degrade("draw: tools registry refused the registration"'),
    "lifecycle.ts registry-refusal catch");
  // The absence note must reach the snapshot BY INJECTION, not by a global
  // import: `buildSnapshotBody` is the pure aggregator and its only state
  // sources are parameters. The reason union widens freely — but only if
  // nobody sneaks the holder back in as an import.
  //
  // The two halves of the first assertion are deliberately NOT symmetric:
  // "no import of the holder" is the durable invariant, while the param is
  // asserted only as `drawToolNote?: () =>` (an optional CLOSURE, never a
  // plain value). Pinning the full return type here would churn on every
  // legitimate widening — this assertion already had to be hand-edited once
  // when the reason union was introduced, which is exactly the cost a marker
  // test should not impose.
  const aggregateSrc = readFileSync(new URL("../src/host/snapshot-aggregate.ts", import.meta.url), "utf8");
  const routeSrc = readFileSync(new URL("../src/host/routes/snapshot.ts", import.meta.url), "utf8");
  check("the aggregator reads the absence note via a param, never an import",
    !aggregateSrc.includes('from "./draw-tool-state.ts"')
      && aggregateSrc.includes("drawToolNote?: () =>"),
    "snapshot-aggregate.ts drawToolNote wiring");
  check("the snapshot route injects the absence reader",
    routeSrc.includes("drawToolNote: () => drawToolNote()"),
    "routes/snapshot.ts injection");
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

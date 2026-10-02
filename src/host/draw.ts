/**
 * The SenseNova image-generation module ("draw absorption", ARCHITECTURE §5.4
 * route B) — the PEER-FREE half.
 *
 * Like `llm-models.ts` this module imports no runtime peer: it maps catalog
 * entries, builds wire bodies and classifies failures as plain functions, so
 * every decision here is testable on a clean checkout. The peer-dependent
 * half lives in `index.ts`: the `@deepseek-ai/dsh-tools` import and the
 * `ctx.tools` registration are loaded lazily and only when the `drawEnabled`
 * opt-in is on — a Host without the tools service simply never sees the tool,
 * exactly like the provider degrades without an `llm` service.
 *
 * Two design facts are load-bearing rather than cosmetic:
 *
 * 1. Model identification is STRUCTURED, not name-regex. `dsh-draw-router`
 *    (the community reference this module absorbs, upstream/dsh-draw-router)
 *    filters its probed model list through name patterns and thereby misses
 *    `sensenova-u1.5-lite` outright (ARCHITECTURE §5.4); this module reads the
 *    catalog's own `output_modalities` field instead — the same field
 *    `isChatModel` already uses to keep image models OUT of the chat picker,
 *    so the two lists can never disagree about what exists.
 * 2. The key is resolved per call (`resolveApiKey`), never cached: rotating
 *    the panel-saved `SENSENOVA_API_KEY` reference takes effect on the next
 *    draw without re-registration, mirroring the LLM adapter.
 *
 * @module dsh-connect-sensenova-token-plan/draw
 */

import { str, num, redactSecrets } from "./util.ts";
import { isImageGenModel } from "./modality.ts";
import type { DrawRequest } from "./types.ts";

/** The agent tool name. Scoped so it cannot collide with `dsh-draw-router`'s `draw_image`. */
export const DRAW_TOOL_NAME = "sensenova_draw_image";

/** How long after a failed draw the next attempt is refused. Borrowed from dsh-draw-router (its probe cooldown). */
export const DRAW_COOLDOWN_MS = 30_000;

/** Default deadline for one image request; image models are slow, chat deadlines do not apply. */
export const DRAW_DEFAULT_TIMEOUT_MS = 120_000;

/** The platform's per-request image cap: its official docs pin `n` to 1 for both image models. */
export const DRAW_MAX_IMAGES = 1;

/** The documented `output_format` choices for `images/generations` (png/jpg/jpeg/webp). */
export const DRAW_OUTPUT_FORMATS = ["png", "jpg", "jpeg", "webp"];

/** Normalize a caller-supplied `output_format` value to the documented set. */
export function normalizeDrawOutputFormat(value) {
  const format = str(value, "").trim().toLowerCase();
  if (format === "") return "png";
  return DRAW_OUTPUT_FORMATS.includes(format) ? format : "png";
}

/** Normalize a caller-supplied `watermark` flag. Only documented boolean forms travel; everything else keeps the documented default `true`. */
export function normalizeDrawWatermark(value) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return true;
}

/**
 * Build the `images/generations` endpoint from the OpenAI-compatible base.
 *
 * Mirrors `dsh-draw-router`'s `buildEndpoint` (upstream line 72-79) so every
 * operator spelling of `apiBase` lands on the same URL:
 * `…/v1` → `…/v1/images/generations`; an URL already ending in
 * `/images/generations` passes through; a deeper `/v1/<something>` is rewound
 * to `/v1`; anything else gets `/v1/images/generations` appended.
 * @param {string} apiBase - the configured base (default `https://token.sensenova.cn/v1`).
 * @returns {string} the full draw endpoint.
 */
export function buildDrawEndpoint(apiBase) {
  const trimmed = str(apiBase, "").trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  if (/\/images\/generations$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/images/generations`;
  if (/\/v1\//.test(trimmed)) return trimmed.replace(/\/v1\/.*$/, "/v1/images/generations");
  return `${trimmed}/v1/images/generations`;
}

/**
 * Whether one catalog entry is an image-GENERATION model.
 *
 * The STRICT direction of the modality judgment: only a catalog entry that
 * EXPLICITLY declares `"image"` in `output_modalities` counts. A missing field
 * means "unknown", and unknown must not be offered as a draw model — unlike
 * the chat direction (permissive, so entries never vanish from the picker), a
 * wrong draw guess sends the agent's request to a model that cannot answer.
 * The judgment lives in {@link isImageGenModel} (`modality.ts`), the ONE place
 * both the draw list and the chat roster read from — they cannot disagree
 * about what exists.
 * @param {object} entry - one normalized catalog entry.
 * @returns {boolean}
 */
export { isImageGenModel };

/**
 * The draw-capable model ids of one catalog, de-duplicated in first-seen order.
 *
 * Deduping keeps the LAST occurrence at its first-seen position, exactly like
 * `rosterOf` / `buildDescriptors` / `catalog-store.normalizeEntries`, so the
 * draw list and the chat roster can never disagree about which ids exist.
 * @param {object[]} entries - the normalized catalog entries.
 * @returns {string[]}
 */
export function imageGenModelIds(entries) {
  const position = new Map();
  const out: string[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isImageGenModel(entry)) continue;
    const id = str(entry?.id, "");
    if (id === "") continue;
    if (position.has(id)) {
      out[position.get(id)] = id;
    } else {
      position.set(id, out.length);
      out.push(id);
    }
  }
  return out;
}

/**
 * Choose the model one draw call addresses.
 *
 * Precedence: an explicitly requested id wins even when the catalog does not
 * list it (a manual override, like `dsh-draw-router`; the platform answers
 * the error itself if the id is wrong) — but an empty catalog with nothing
 * requested yields `null`, and the caller turns that into the actionable
 * "no draw models" error rather than sending a doomed request.
 * @param {object[]} entries - the normalized catalog entries.
 * @param {string} [requested] - the tool call's `model` parameter.
 * @param {string} [preferred] - the configured default (`drawModelId`).
 * @returns {string|null} the chosen id, or `null` when nothing can be picked.
 */
export function pickDrawModel(entries, requested, preferred) {
  const want = str(requested, "").trim();
  if (want !== "") return want;
  const ids = imageGenModelIds(entries);
  if (ids.length === 0) return null;
  const config = str(preferred, "").trim();
  if (config !== "" && ids.includes(config)) return config;
  return ids[0];
}

/**
 * Build the `images/generations` request body.
 *
 * Only the fields the endpoint actually consumes travel: `n` is clamped to a
 * sane range (a fraction floors, junk and out-of-range values fall back to 1)
 * and `response_format` defaults to `url` — the panel/agent-facing shape that
 * renders as a Markdown image without the client having to handle base64.
 * `output_format` and `watermark` are always explicit (defaults `png` and
 * `true`), because the official docs recommend pinning them to survive a
 * future platform default change.
 * @param {object} options - `{ model, prompt, n, size, responseFormat, outputFormat, watermark }`.
 * @returns {object} the wire body.
 */
export function buildDrawBody(options: Partial<DrawRequest> = {}) {
  const { model, prompt, n, size, responseFormat, outputFormat, watermark } = options;
  const count = Math.floor(num(n, 1));
  const body: Record<string, unknown> = {
    model: str(model, ""),
    prompt: str(prompt, ""),
    n: Number.isFinite(count) ? Math.min(DRAW_MAX_IMAGES, Math.max(1, count)) : 1,
    response_format: str(responseFormat, "url") || "url",
    output_format: normalizeDrawOutputFormat(outputFormat),
    watermark: normalizeDrawWatermark(watermark)
  };
  const dims = str(size, "").trim();
  if (dims !== "") body.size = dims;
  return body;
}

/**
 * Extract the first image out of an `images/generations` response.
 * @param {object} data - the parsed response JSON.
 * @returns {{url: string, b64Json: string, revisedPrompt: string}}
 * @throws {Error} when the response carries no `data[0]` at all.
 */
export function parseDrawResponse(data) {
  const item = data?.data?.[0];
  if (item === null || typeof item !== "object") {
    throw new Error("draw: unexpected response, missing data[0]");
  }
  return {
    url: str(item.url, ""),
    b64Json: str(item.b64_json, ""),
    revisedPrompt: str(item.revised_prompt, "")
  };
}

/**
 * Turn a failed HTTP answer into the message the agent (and the trace) reads.
 *
 * The split mirrors the 429 discipline already fixed for chat (ROADMAP §1-2):
 * "insufficient/quota" in a 429 means the shared pool is drained — retrying
 * the same request is waste — while any other 429 is a rate limit and a plain
 * wait helps. Auth failures point at the panel's key area instead of at
 * "the endpoint is broken".
 * @param {number} status - the HTTP status code.
 * @param {string} bodyText - the raw body (best effort, may be empty).
 * @returns {string} the panel/agent-facing message.
 */
export function describeDrawFailure(status, bodyText) {
  // A 4xx body may echo the `sk-` key back (the failure `redactSecrets` in
  // util.ts exists for): the message reaches the agent tool result AND the
  // panel. Scrub BEFORE the slice so a credential cannot ride the tail.
  const text = redactSecrets(str(bodyText, "")).slice(0, 300);
  if (status === 401 || status === 403) {
    return `draw failed: HTTP ${status} — the SENSENOVA_API_KEY is missing, invalid or not authorized for this model. Set it in the panel's 模型接入 area${text === "" ? "" : `; body: ${text}`}`;
  }
  if (status === 429) {
    if (/insufficient|quota/i.test(text)) {
      return `draw failed: HTTP 429 — 配额不足（共享池已耗尽或该出图模型不在套餐内），稍后或换模型再试; body: ${text}`;
    }
    return `draw failed: HTTP 429 — 限频，请稍等重试; body: ${text}`;
  }
  if (status === 404) {
    return `draw failed: HTTP 404 — 模型不存在或 endpoint 不对（检查 apiBase 与模型 id）${text === "" ? "" : `; body: ${text}`}`;
  }
  return `draw failed: HTTP ${status}${text === "" ? "" : ` ${text}`}`;
}

/**
 * Fire one draw request and parse the answer.
 *
 * The deadline aborts through an `AbortController` (the `AbortSignal.timeout`
 * spelling would do, but the controller also cancels the in-flight body read
 * and keeps the whole flow injectable for tests). A non-2xx answer never
 * reaches JSON parsing: its classified message is thrown with the raw body
 * attached, so the agent sees WHY, not just that it failed.
 * @param {object} options - wiring.
 * @param {Function} options.fetchImpl - the fetch to use (injected; the real
 *   `globalThis.fetch` arrives from `index.ts`).
 * @param {string} options.endpoint - the full `images/generations` URL.
 * @param {string} options.apiKey - the resolved `sk-` key.
 * @param {object} options.body - the wire body (`buildDrawBody`).
 * @param {number} [options.timeoutMs] - the deadline.
 * @returns {Promise<{url: string, b64Json: string, revisedPrompt: string, model: string}>}
 */
export async function drawOnce({ fetchImpl, endpoint, apiKey, body, timeoutMs = DRAW_DEFAULT_TIMEOUT_MS }) {
  if (typeof fetchImpl !== "function") throw new Error("drawOnce: fetchImpl is required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`draw timeout after ${timeoutMs}ms`)), Math.max(1_000, timeoutMs));
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(describeDrawFailure(response.status, text));
    }
    const data = await response.json().catch(() => {
      throw new Error("draw: response is not valid JSON");
    });
    return { ...parseDrawResponse(data), model: str(body?.model, "") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The failed-draw cooldown gate.
 *
 * Borrowed from `dsh-draw-router` (its probe failure cooldown, upstream line
 * 196): after one failed draw the next attempt is refused for a window, so a
 * drained pool does not get hammered by an agent retrying in a loop. The
 * clock is wall-time, so the gate reopens by itself when the window passes —
 * deliberately NO success-side reset: a tripped gate blocks the execute entry
 * itself, so a success can only ever happen on an open gate and a reset call
 * there would be dead code.
 * @param {number} [cooldownMs] - the window.
 * @returns {{blocked: Function, trip: Function, remainingMs: Function}}
 */
export function createDrawCooldown(cooldownMs = DRAW_COOLDOWN_MS) {
  let until = 0;
  return {
    blocked: (now = Date.now()) => now < until,
    trip: (now = Date.now()) => { until = now + cooldownMs; },
    remainingMs: (now = Date.now()) => Math.max(0, until - now)
  };
}

/**
 * Build the agent tool object for `ctx.tools.register`.
 *
 * Pure wiring: the peer's `defineTool` factory arrives as a parameter (so this
 * module stays importable without the peer), and every side effect the tool
 * needs — key resolution, the live catalog, the fetch, disposal — is injected.
 * `index.ts` calls this only when `drawEnabled` is on AND a tools service is
 * present; every failure inside `execute` throws so the agent reads the
 * reason, and the panel is never involved (no snapshot key, no route).
 * @param {object} options - wiring.
 * @param {Function} options.defineTool - the peer's tool factory.
 * @param {Function} options.resolveApiKey - async `() => Promise<string>`, the
 *   live `SENSENOVA_API_KEY` value (empty when unset).
 * @param {Function} options.getEntries - `() => catalog entries` (sync or
 *   async), read at call time so a catalog refresh is picked up without
 *   re-registration. The caller (`index.ts`) hands the FULL persisted catalog,
 *   not the picker's allow-list-filtered offer — the curation binds the picker,
 *   never the agent's tools.
 * @param {object} options.settings - `{ apiBase, drawModelId, drawTimeoutMs }`.
 * @param {Function} options.fetchImpl - the fetch for `drawOnce`.
 * @param {object} [options.cooldown] - a `createDrawCooldown()` gate.
 * @param {Function} [options.isDisposed] - `() => boolean`, true after unmount.
 * @returns {object} the tool definition for `ctx.tools.register`.
 */
export function defineDrawTool({
  defineTool,
  resolveApiKey,
  getEntries,
  settings,
  fetchImpl,
  cooldown = createDrawCooldown(),
  isDisposed = () => false
}) {
  const timeoutMs = Math.max(5_000, Math.floor(num(settings?.drawTimeoutMs, DRAW_DEFAULT_TIMEOUT_MS)));
  return defineTool({
    name: DRAW_TOOL_NAME,
    description:
      "Generate an image with the SenseNova Token Plan key. " +
      "Omit `model` to let the catalog's default image model be used; pass `model` only when you need a particular one — " +
      "the available image model ids are reported in the result after the first successful call.",
    parameters: {
      prompt: { type: "string", required: true, description: "Image generation prompt" },
      model: { type: "string", description: "SenseNova image model id; defaults to the first discovered one" },
      size: { type: "string", description: "Image size as WIDTHxHEIGHT, e.g. 1024x1024; platform range 512-4096 in multiples of 32, ratio up to 3:1; omit for auto" },
      n: { type: "number", description: "Number of images — the platform only supports 1; default 1" },
      outputFormat: { type: "string", description: "Image file format: png (default), jpg, jpeg, or webp" },
      watermark: { type: "boolean", description: "Add the SenseNova logo watermark. Defaults to true; false means no watermark" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string" },
          model: { type: "string" },
          url: { type: "string" },
          prompt: { type: "string" },
          hint: { type: "string" }
        }
      },
      // Two parameters + array return: the shape dsh-draw-router had to fix
      // (its upstream "Bug 1+2") — keep both, the renderer is called with the
      // call args first and the result second.
      render: (_args, result) => [{ type: "text", text: result?.hint || "图片已生成" }]
    },
    timeoutMs: timeoutMs + 10_000,
    async execute(params) {
      if (isDisposed()) throw new Error("sensenova draw tool is no longer mounted");
      const prompt = str(params?.prompt, "").trim();
      if (prompt === "") throw new Error("prompt is required");
      if (cooldown.blocked()) {
        throw new Error(`draw cooldown: 上一次出图失败，${Math.ceil(cooldown.remainingMs() / 1000)}s 后再试`);
      }
      const apiKey = await resolveApiKey();
      if (typeof apiKey !== "string" || apiKey.trim() === "") {
        throw new Error("SENSENOVA_API_KEY 未配置：在面板「模型接入」粘贴 sk- Key，或设置该环境变量");
      }
      let picked;
      try {
        picked = (await getEntries?.()) ?? [];
      } catch {
        picked = [];
      }
      const entries = Array.isArray(picked) ? picked : [];
      const model = pickDrawModel(entries, params?.model, settings?.drawModelId);
      if (model === null) {
        throw new Error(
          "catalog 中没有出图模型（output_modalities 含 image 的条目为空）：确认 Key 已配置、面板已至少轮询一次，且套餐含出图模型"
        );
      }
      const body = buildDrawBody({ model, prompt, n: params?.n, size: params?.size, outputFormat: params?.outputFormat, watermark: params?.watermark });
      let result;
      try {
        result = await drawOnce({
          fetchImpl,
          endpoint: buildDrawEndpoint(settings?.apiBase),
          apiKey,
          body,
          timeoutMs
        });
      } catch (error) {
        cooldown.trip();
        throw error;
      }
      // The success hint reports the CURRENTLY available image models: the
      // tool description is static (the registry has no re-register), so this
      // is the one channel that carries the dynamic catalog to the model —
      // after the first successful call it can deliberately pick a specific
      // model instead of always taking the default.
      const drawModelIds = imageGenModelIds(entries).join(", ");
      const available = drawModelIds !== "" ? `\n可用出图模型: ${drawModelIds}` : "";
      const hint = result.url !== ""
        ? `图片已生成!\n模型: ${result.model}\nURL: ${result.url}\n请直接输出 Markdown: ![图](${result.url})${available}`
        : `图片已生成!\n模型: ${result.model}\n(base64 图片数据，请以 data:image/png;base64,… 形式在对话中展示)${available}`;
      return {
        source: "sensenova",
        model: result.model,
        url: result.url,
        prompt,
        hint
      };
    }
  });
}

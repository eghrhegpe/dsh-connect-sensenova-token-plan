/**
 * The SenseNova image-generation module ("draw absorption", ARCHITECTURE §5.4
 * route B) — the PEER-FREE half.
 *
 * Like `llm-models.ts` this module imports no runtime peer: it maps catalog
 * entries, builds wire bodies and classifies failures as plain functions, so
 * every decision here is testable on a clean checkout. The peer-dependent
 * half lives in `draw-mount.ts` (`registerDrawTool`, called by
 * `startSideEffects`):
 * the `@deepseek-ai/dsh-tools` import and the `ctx.tools` registration are
 * loaded lazily and only when the `drawEnabled` opt-in is on — `index.ts`
 * just injects the `loadToolsModule`/`drawFetch` seams. A Host without the
 * tools service simply never sees the tool, exactly like the provider
 * degrades without an `llm` service.
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
import { resolveDrawTimeoutMs } from "./host-config.ts";
import { isImageGenModel } from "./modality.ts";
import type { DrawRequest } from "./types.ts";

/** The agent tool name. Scoped so it cannot collide with `dsh-draw-router`'s `draw_image`. */
export const DRAW_TOOL_NAME = "sensenova_draw_image";

/** How long after a failed draw the next attempt is refused. Borrowed from dsh-draw-router (its probe cooldown). */
export const DRAW_COOLDOWN_MS = 30_000;

/**
 * Default deadline for one image request; image models are slow, chat
 * deadlines do not apply. 2026-11-05 probe: successful draws took 61-107s
 * and two paid draws died at the old 120s line — the deadline was cutting
 * requests the platform had already metered. 240s doubles the observed
 * worst case.
 */
export const DRAW_DEFAULT_TIMEOUT_MS = 240_000;

/** The platform's per-request image cap: its official docs pin `n` to 1 for both image models. */
export const DRAW_MAX_IMAGES = 1;

/** The documented `output_format` choices for `images/generations` (png/jpg/jpeg/webp). */
export const DRAW_OUTPUT_FORMATS = ["png", "jpg", "jpeg", "webp"];

/**
 * Merge the internal deadline controller with the caller's cancellation signal.
 *
 * `timeoutMs` on the tool declaration is an ASSERTION to the tools peer that
 * this body forwards `exec.signal` into a cooperative implementation — the
 * registry cannot hard-kill same-process code, so a body that ignores the
 * signal keeps a cancelled call burning its whole wall-clock budget (and the
 * credit pool behind it) after the agent has been told to stop.
 * `AbortSignal.any` carries the caller's abort reason verbatim into the fetch
 * rejection, which is what lets {@link isDrawCancellation} tell a cancellation
 * apart from a deadline. With no caller signal the internal controller stands
 * alone, so every test that invokes `execute(params)` with one argument keeps
 * its exact behaviour.
 * @param controller - the internal deadline controller.
 * @param signal - the caller's cancellation signal, when there is one.
 * @returns the signal to hand to fetch.
 */
export function mergedDrawSignal(controller: AbortController, signal?: AbortSignal): AbortSignal {
  if (signal === undefined || signal === null) return controller.signal;
  return AbortSignal.any([controller.signal, signal]);
}

/**
 * Whether a thrown value is a CALLER CANCELLATION rather than a deadline.
 *
 * The two must be treated apart: a deadline genuinely failed the attempt and
 * trips the cooldown, while a cancellation is the agent asking to stop —
 * punishing the next attempt for it would compound the interruption.
 * The check reads the error `name` because fetch rejects with the abort reason
 * verbatim: the peer's caller signal is a `DOMException` named `AbortError`,
 * while this module's own deadline aborts with a plain `Error` and never matches.
 * @param error - the thrown value.
 * @returns true when the caller cancelled the call.
 */
export function isDrawCancellation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/**
 * The six parameters the tool accepts. `execute` refuses anything outside
 * this list instead of dropping it: a silently ignored `quality` or
 * `seed` means the platform charged for an image the caller never asked
 * for — "did less and said nothing", the same crime as a clamped `n`.
 */
export const DRAW_PARAM_NAMES = ["prompt", "model", "size", "n", "outputFormat", "watermark"];

/** Normalize a caller-supplied `output_format` value to the documented set. */
export function normalizeDrawOutputFormat(value: unknown): string {
  const format = str(value, "").trim().toLowerCase();
  if (format === "") return "png";
  return DRAW_OUTPUT_FORMATS.includes(format) ? format : "png";
}

/** Normalize a caller-supplied `watermark` flag. Only documented boolean forms travel; everything else keeps the documented default `true`. */
export function normalizeDrawWatermark(value: unknown): boolean {
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
export function buildDrawEndpoint(apiBase: string): string {
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
export function imageGenModelIds(entries: unknown): string[] {
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
export function pickDrawModel(entries: unknown, requested?: string, preferred?: string): string | null {
  const want = str(requested, "").trim();
  if (want !== "") return want;
  const ids = imageGenModelIds(entries);
  if (ids.length === 0) return null;
  const config = str(preferred, "").trim();
  if (config !== "" && ids.includes(config)) return config;
  return ids[0] ?? null;
}

/**
 * Validate a `size` value against the endpoint's REAL grammar (2026-11-05
 * probe: the vendor docs advertise `2K`/`4K` constants, the endpoint
 * rejects them with HTTP 400 — only `auto` and bare WIDTHxHEIGHT pass).
 * Catching it here costs the caller a message instead of a burned request,
 * a tripped cooldown and a platform English JSON to parse.
 * @param {string} value - the trimmed size string ("" means "not supplied").
 * @returns {string} an actionable refusal, or "" when the value may travel.
 */
export function validateDrawSize(value: unknown): string {
  const size = str(value, "").trim().toLowerCase();
  if (size === "" || size === "auto") return "";
  const dims = /^(\d+)x(\d+)$/.exec(size);
  if (dims === null) {
    return `draw: size="${size}" is not accepted by this endpoint — use "auto" or WIDTHxHEIGHT (the "2K"/"4K" names in the vendor docs are rejected); e.g. 1024x1024, 2048x2048`;
  }
  const width = Number(dims[1]);
  const height = Number(dims[2]);
  const bad: string[] = [];
  if (width % 32 !== 0 || height % 32 !== 0) bad.push("both sides must be multiples of 32");
  if (width < 512 || width > 4096 || height < 512 || height > 4096) bad.push("both sides must be within 512-4096");
  const ratio = Math.max(width / height, height / width);
  if (ratio > 3) bad.push(`the long:short ratio must be at most 3:1 (got ${ratio.toFixed(2)}:1)`);
  if (bad.length !== 0) {
    return `draw: size="${size}" is invalid — ${bad.join("; ")} (the endpoint's own rule, checked before the request)`;
  }
  return "";
}

/**
 * Build the `images/generations` request body.
 *
 * Only the fields the endpoint actually consumes travel. `n` is NOT silently
 * shrunk: this platform draws one image per request (`DRAW_MAX_IMAGES`), so an
 * `n` above it is refused HERE rather than answered with fewer images than the
 * caller asked for — on an agent-facing tool surface, "did less and said
 * nothing" is indistinguishable from "the model was told one image". Junk /
 * non-positive values fall back to 1 (the documented default), matching
 * `outputFormat` and `watermark`, which keep their documented defaults for
 * the same reason. `response_format` defaults to `url` — the shape that
 * renders as a Markdown image without the client handling base64.
 * `output_format` and `watermark` are always explicit (defaults `png` and
 * `true`), because the official docs recommend pinning them to survive a
 * future platform default change.
 * @param {object} options - `{ model, prompt, n, size, responseFormat, outputFormat, watermark }`.
 * @returns {object} the wire body.
 * @throws {Error} when `n` is a finite number above {@link DRAW_MAX_IMAGES}.
 */
export function buildDrawBody(options: Partial<DrawRequest> = {}) {
  const { model, prompt, n, size, responseFormat, outputFormat, watermark } = options;
  const count = Math.floor(num(n, 1));
  if (Number.isFinite(count) && count > DRAW_MAX_IMAGES) {
    throw new Error(`draw: n=${count} is not supported — this platform generates ${DRAW_MAX_IMAGES} image per request; call the tool once per image`);
  }
  const body: Record<string, unknown> = {
    model: str(model, ""),
    prompt: str(prompt, ""),
    n: Number.isFinite(count) ? Math.max(1, count) : 1,
    response_format: str(responseFormat, "url") || "url",
    output_format: normalizeDrawOutputFormat(outputFormat),
    watermark: normalizeDrawWatermark(watermark)
  };
  const dims = str(size, "").trim();
  if (dims !== "") {
    const refusal = validateDrawSize(dims);
    if (refusal !== "") throw new Error(refusal);
    body.size = dims;
  }
  return body;
}
/** The platform-metred token counts of one image call (`usage` in the response). */
export type DrawUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  imagesCount: number;
};

/**
 * Extract the first image out of an `images/generations` response.
 * The `usage` block is the ONLY cost signal the platform gives back: it
 * meters an image call in tokens (`input_tokens` / `output_tokens` /
 * `total_tokens` / `images_count`) and publishes no price, so the counts are
 * carried through untouched and the credit deduction stays with the console's
 * own per-model trend.
 * @param {object} data - the parsed response JSON.
 * @returns {{url: string, b64Json: string, revisedPrompt: string, usage: DrawUsage}}
 * @throws {Error} when the response carries no `data[0]` at all.
 */
export function parseDrawResponse(data: unknown): { url: string; b64Json: string; revisedPrompt: string; usage: DrawUsage } {
  const item = (data as { data?: unknown[] | null } | null)?.data?.[0];
  if (item === null || typeof item !== "object") {
    throw new Error("draw: unexpected response, missing data[0]");
  }
  const source = item as { url?: unknown; b64_json?: unknown; revised_prompt?: unknown };
  return {
    url: str(source.url, ""),
    b64Json: str(source.b64_json, ""),
    revisedPrompt: str(source.revised_prompt, ""),
    usage: parseDrawUsage((data as { usage?: unknown } | null)?.usage)
  };
}

/**
 * Normalize the response `usage` block.
 *
 * Every field falls back to 0, so a response shape without `usage` (the
 * documented one does carry it) degrades to "nothing to report" instead of
 * failing a draw that already succeeded. Console-style numeric strings are
 * accepted alongside JSON numbers — the console API returns counts as strings
 * and the inference API returns them as numbers, and this reader must not
 * depend on which one answered.
 * @param {unknown} raw - the response's `usage` value.
 * @returns {DrawUsage} the four counts, 0 when absent.
 */
export function parseDrawUsage(raw: unknown): DrawUsage {
  const source = (raw !== null && typeof raw === "object" ? raw : {}) as {
    input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown; images_count?: unknown;
  };
  const read = (value: unknown): number => num(typeof value === "string" ? Number(value) : value, 0);
  const inputTokens = read(source.input_tokens);
  const outputTokens = read(source.output_tokens);
  const totalTokens = read(source.total_tokens) || inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    imagesCount: read(source.images_count)
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
export function describeDrawFailure(status: number, bodyText: string): string {
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
 * @param {AbortSignal} [options.signal] - the caller's cancellation signal
 *   (`exec.signal`), merged onto the deadline so a cancelled call stops here
 *   instead of burning its whole budget and the pool behind it.
 * @returns {Promise<{url: string, b64Json: string, revisedPrompt: string, model: string, usage: DrawUsage}>}
 */
export async function drawOnce({ fetchImpl, endpoint, apiKey, body, timeoutMs = DRAW_DEFAULT_TIMEOUT_MS, signal }: {
  fetchImpl: (url: string, options: object) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;
  endpoint: string;
  apiKey: string;
  body: Record<string, unknown>;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}): Promise<{ url: string; b64Json: string; revisedPrompt: string; model: string; usage: DrawUsage }> {
  if (typeof fetchImpl !== "function") throw new Error("drawOnce: fetchImpl is required");
  if (signal?.aborted === true) throw signal.reason ?? new Error("draw: cancelled");
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
      signal: mergedDrawSignal(controller, signal)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(describeDrawFailure(response.status, text)) as Error & { drawCooldown?: boolean };
      // 4xx (except 429) is a request-shape or config answer: the fix is in
      // the caller's hands, and a 30s gate only hides the lesson and burns
      // the turn waiting. 429/5xx come from the platform side — the gate
      // protects the pool there. A timeout carries no flag and keeps the
      // default (trip): the platform may have already metered that draw.
      error.drawCooldown = response.status === 429 || response.status >= 500;
      throw error;
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
 * `draw-mount.ts` (`registerDrawTool`) calls this only when `drawEnabled` is
 * on AND a tools service is present; every failure inside `execute` throws so
 * the agent reads the reason, and the panel is never involved (no snapshot
 * key, no route).
 * @param {object} options - wiring.
 * @param {Function} options.defineTool - the peer's tool factory.
 * @param {Function} options.resolveApiKey - async `() => Promise<string>`, the
 *   live `SENSENOVA_API_KEY` value (empty when unset).
 * @param {Function} options.getEntries - `() => catalog entries` (sync or
 *   async), read at call time so a catalog refresh is picked up without
 *   re-registration. The caller (`draw-mount.ts`) hands the FULL persisted catalog,
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
}: {
  defineTool: (definition: object) => unknown;
  resolveApiKey: () => Promise<string>;
  getEntries?: () => unknown | Promise<unknown>;
  settings?: { apiBase?: unknown; drawModelId?: unknown; drawTimeoutMs?: unknown };
  fetchImpl: (url: string, options: object) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;
  cooldown?: ReturnType<typeof createDrawCooldown>;
  isDisposed?: () => boolean;
}) {
  // The SAME resolver the config layer uses: the deadline is a request
  // parameter, so both ends of its range are enforced here too — this
  // function is callable with a raw settings object, not only with the
  // resolved config.
  const timeoutMs = resolveDrawTimeoutMs(settings?.drawTimeoutMs);
  return defineTool({
    name: DRAW_TOOL_NAME,
    // The tool body carries the parts a caller must know BEFORE calling and
    // cannot read off the parameters: what a call costs, what comes back, and
    // how the model choice works. The parameters keep only their own
    // per-value grammar — the two must not restate each other, and nothing
    // here may claim a price the platform does not publish.
    description:
      "Generate an image from a text prompt with the SenseNova Token Plan key.\n" +
      "\n" +
      "COST — every call spends real quota from the account's Token Plan credit pool; the platform publishes no per-image price and the response carries none, so the only cost reading is the token usage reported in `hint`. It renders exactly one image per request: `n` above 1 is refused before any request is sent (ask for several images with several calls), a rate-limited, server-failed or timed-out draw trips a 30s cooldown — do not retry in a loop; a rejected parameter does not, fix it and call again.\n" +
      "\n" +
      "RESULT — the hosted URL (valid about 24h: download or re-host it when the user needs it later), the model actually used, and a Markdown snippet ready to paste.\n" +
      "\n" +
      "MODEL — the catalog's image ids are reported in the result of the first successful call, because this description is fixed at registration and cannot follow a catalog refresh. Omit `model` for the plugin's default, or pass one of those ids when the choice matters.",
    parameters: {
      prompt: { type: "string", required: true, description: "Image generation prompt: what to draw, in what style, how it is composed" },
      model: { type: "string", description: "Optional image model id — one of the ids a successful call reports; omit to use the plugin's default" },
      size: { type: "string", description: "Optional `auto` or WIDTHxHEIGHT (e.g. 1024x1024): multiples of 32, 512-4096, aspect ratio at most 3:1; omit for the platform default. Anything else — including the `2K`/`4K` names the vendor docs list — is refused before the request is sent" },
      n: { type: "number", description: "Number of images: this platform draws one per request, so a value above 1 is refused instead of clamped" },
      outputFormat: { type: "string", description: "File format: png (default), jpg, jpeg, or webp" },
      watermark: { type: "boolean", description: "Add the SenseNova logo watermark (default true). `false` removes it — free during the beta, which the platform says will become a paid option" }
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
      render: (_args: unknown, result: { hint?: unknown } | null | undefined) => [{ type: "text", text: result?.hint || "图片已生成" }]
    },
    timeoutMs: timeoutMs + 10_000,
    async execute(
      params: { prompt?: unknown; model?: unknown; n?: unknown; size?: unknown; outputFormat?: unknown; watermark?: unknown } | undefined,
      // Optional: the peer always passes it, while the unit tests call
      // `execute(params)` with one argument. Declaring `timeoutMs` above
      // asserts this body forwards `exec.signal`, so the body reads it here.
      exec?: { signal?: AbortSignal }
    ) {
      if (isDisposed()) throw new Error("sensenova draw tool is no longer mounted");
      const signal = exec?.signal;
      if (signal?.aborted === true) throw signal.reason ?? new Error("draw: cancelled");
      const prompt = str(params?.prompt, "").trim();
      if (prompt === "") throw new Error("prompt is required");
      const unknown = Object.keys(params ?? {}).filter((key) => !DRAW_PARAM_NAMES.includes(key));
      if (unknown.length !== 0) {
        throw new Error(`draw: unknown parameter(s) ${unknown.join(", ")} — this tool sends only ${DRAW_PARAM_NAMES.join(", ")}; a field outside that list would be dropped while the draw still charges the pool, so the call is refused instead`);
      }
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
      const model = pickDrawModel(entries, str(params?.model, ""), settings?.drawModelId === undefined ? undefined : str(settings.drawModelId, ""));
      if (model === null) {
        throw new Error(
          "catalog 中没有出图模型（output_modalities 含 image 的条目为空）：确认 Key 已配置、面板已至少轮询一次，且套餐含出图模型"
        );
      }
      const body = buildDrawBody({
        model,
        prompt,
        ...(typeof params?.n === "number" ? { n: params.n } : {}),
        size: str(params?.size, ""),
        outputFormat: str(params?.outputFormat, ""),
        ...(typeof params?.watermark === "boolean" ? { watermark: params.watermark } : {})
      });
      let result;
      try {
        result = await drawOnce({
          fetchImpl,
          endpoint: buildDrawEndpoint(str(settings?.apiBase, "")),
          apiKey,
          body,
          timeoutMs,
          signal
        });
      } catch (error) {
        // A caller cancellation is not a failed attempt: the agent asked to
        // stop, and gating its next call for 30s would punish it for the
        // interruption. Everything else follows drawOnce's flag (429/5xx
        // trip, other 4xx do not); an error with no flag — timeout,
        // transport, bad JSON — keeps the safe default and trips.
        if (!isDrawCancellation(error) && (error as { drawCooldown?: boolean })?.drawCooldown !== false) {
          cooldown.trip();
        }
        throw error;
      }
      // The success hint reports the CURRENTLY available image models: the
      // tool DESCRIPTION is fixed at registration (a catalog refresh does not
      // re-register), so this is the channel that carries the dynamic catalog
      // to the model — after the first successful call it can deliberately
      // pick a specific model instead of always taking the default.
      const drawModelIds = imageGenModelIds(entries).join(", ");
      const available = drawModelIds !== "" ? `\n可用出图模型: ${drawModelIds}` : "";
      // The platform meters an image call in tokens and publishes no price (the
      // catalog's `pricing` is all "0"): `usage` is the only real cost figure
      // one call can report, so it travels with the hint instead of a number
      // this plugin would have to invent. Absent `usage` (all zeros) prints
      // nothing — a "0 tokens" line would read as a free draw.
      const metered = result.usage.totalTokens > 0
        ? `\n本次用量: 输入 ${result.usage.inputTokens} / 输出 ${result.usage.outputTokens} tokens（合计 ${result.usage.totalTokens}）`
        : "";
      const hint = result.url !== ""
        ? `图片已生成!\n模型: ${result.model}\nURL: ${result.url}\n请直接输出 Markdown: ![图](${result.url})${metered}${available}`
        : `图片已生成!\n模型: ${result.model}\n(base64 图片数据，请以 data:image/png;base64,… 形式在对话中展示)${metered}${available}`;
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

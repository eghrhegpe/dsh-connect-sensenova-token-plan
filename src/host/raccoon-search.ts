/**
 * The Raccoon hosted `web_search` MCP tool — the peer-free half of wiring the
 * `/api/web/mcp/web_search/v1/mcp` server into DSH (ROADMAP §6.1.7).
 *
 * TWO layers, split on purpose:
 *
 * 1. **Transport** — a real MCP-over-HTTP client (streamable transport). The
 *    gateway serves an MCP server whose only tool is `web_search` (probed
 *    2026-10-04: no-auth → structured 401, with the WeChat-QR credential →
 *    `initialize` 200 + `Mcp-Session-Id`, `tools/list` → one `web_search`, and
 *    an end-to-end `tools/call` returned real web results).
 * 2. **Mounting** — a `ctx.web` search PROVIDER, NOT a hand-registered agent
 *    tool. This follows the `dsh-commandcode-provider` precedent
 *    (`src/web-search.ts`): DSH ships its own `web_search` tool and a
 *    `WebSearchProvider` registry (`ctx.web` / `@deepseek-ai/dsh-web`), so a
 *    plugin registers a provider and lets DSH's model-facing tool call it. The
 *    earlier `tools.register` plan was the wrong mount — it would have created
 *    a second, parallel search tool and bypassed DSH's own selection/UI.
 *
 * The provider interfaces are STRUCTURAL here (declared locally, not imported):
 * this module stays peer-free so the offline suite exercises it with a fake
 * `ctx`, exactly like `draw.ts` — the Host peer is optional and may be missing.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-search
 */

import { str } from "./util.ts";

/** The hosted MCP search server. */
export const RACCOON_MCP_SEARCH_URL = "https://xiaohuanxiong.com/api/web/mcp/web_search/v1/mcp";
/** The MCP protocol version the gateway negotiated. */
export const RACCOON_MCP_PROTOCOL = "2024-11-05";
/** The single tool the server exposes. */
export const RACCOON_SEARCH_TOOL_NAME = "web_search";
/** The provider id registered in `ctx.web`. */
export const RACCOON_SEARCH_PROVIDER_ID = "raccoon";
/** Default result count. */
export const RACCOON_SEARCH_DEFAULT_COUNT = 5;
/** Cap the gateway states for `SearchType`. */
export const RACCOON_SEARCH_TYPES = Object.freeze(["web", "image"]);

/** The Accept header MCP streamable transport requires. */
const MCP_ACCEPT = "application/json, text/event-stream";

/** Structural view of `WebSearchSource` (`@deepseek-ai/dsh-web`). */
export interface RaccoonSearchSource {
  url: string;
  title?: string;
  snippet?: string;
}
/** Structural view of `WebSearchRequest`. */
export interface RaccoonSearchRequest {
  query: string;
  maxResults?: number;
}
/** Structural view of `WebSearchResult`. */
export interface RaccoonSearchResult {
  sources: RaccoonSearchSource[];
  truncated: boolean;
}
/** Structural view of `WebError` — code + message + optional cause. */
export class RaccoonSearchError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "RaccoonSearchError";
  }
}

/** A `WebSearchProvider` shape (structural). */
export interface RaccoonWebSearchProvider {
  readonly id: string;
  available(): boolean;
  search(request: RaccoonSearchRequest, signal?: AbortSignal): Promise<RaccoonSearchResult>;
}

/**
 * Pull the JSON payloads out of an MCP SSE body: the gateway answers
 * `event: message` lines followed by `data: {...}`. Anything else in the body
 * is ignored, so a keep-alive comment or an `event: ping` line cannot break the
 * parse.
 * @param {string} body - the raw response body.
 * @returns {object[]} the parsed `data:` JSON values.
 */
export function parseMcpSse(body: string): object[] {
  const out: object[] = [];
  for (const line of String(body).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "") continue;
    try {
      const value = JSON.parse(payload);
      if (value && typeof value === "object") out.push(value);
    } catch {
      // A malformed line is dropped, not fatal: one bad frame must not kill the
      // rest of the payload.
    }
  }
  return out;
}

/** Read the jsonrpc `result` / `error` off an MCP envelope. */
function mcpEnvelope(envelopes: object[]): { result?: any; error?: any } {
  const main = envelopes.find((entry) => {
    const e = entry as { method?: unknown };
    return e.method === undefined || e.method === null;
  });
  return (main ?? envelopes[0] ?? {}) as { result?: any; error?: any };
}

/**
 * The error payload off a failed request, however the body is framed. The
 * gateway answers SSE (a `data:` envelope) on protocol errors, but a proxy or a
 * gateway in front of it may return a plain JSON body or even HTML — read both.
 * @returns the jsonrpc `error` object, or `undefined` when the body says nothing.
 */
function extractError(raw: string, envelopes: object[]): { message?: unknown; code?: unknown } | undefined {
  const fromSse = mcpEnvelope(envelopes).error;
  if (fromSse && typeof fromSse === "object") return fromSse;
  const trimmed = String(raw).trim();
  if (trimmed === "") return undefined;
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const json = JSON.parse(trimmed);
    const error = json && typeof json === "object" ? (json as any).error : undefined;
    if (error && typeof error === "object") return error;
    // The Raccoon gateway's OWN error envelope: `{code, message, details}` sits
    // at the top level, not under a jsonrpc `error` key (probed 2026-10-04 — the
    // no-auth POST returns exactly this shape).
    const top = json && typeof json === "object" ? (json as any) : undefined;
    if (top && (typeof top.message === "string" || top.code !== undefined)) return top;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * One MCP-over-HTTP request. Returns `{ ok, status, sessionId?, envelopes?,
 * message? }` — the session id rides in the response header and is NOT part of
 * the body, which is why it is surfaced separately.
 * @param {object} options - request options.
 * @param {string} options.url - the MCP endpoint.
 * @param {string} options.token - the Raccoon Bearer credential.
 * @param {object} options.body - the jsonrpc body.
 * @param {string} [options.sessionId] - `Mcp-Session-Id` from `initialize`.
 * @param {number} [options.timeoutMs] - read timeout.
 * @param {typeof fetch} [options.fetchImpl] - injected fetch.
 */
export async function mcpPost(options: {
  url: string;
  token: string;
  body: object;
  sessionId?: string;
  timeoutMs?: number;
  fetchImpl?: (url: string, init: object) => Promise<any>;
}) {
  const { url, token, body, sessionId, timeoutMs = 60_000, fetchImpl } = options;
  const effective = fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
    Authorization: `Bearer ${token}`
  };
  if (sessionId !== undefined && sessionId !== "") headers["Mcp-Session-Id"] = sessionId;
  let response;
  try {
    response = await effective(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1_000, timeoutMs))
    });
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) };
  }
  const status = response?.status ?? 0;
  const sessionIdOut = response?.headers?.get?.("Mcp-Session-Id") ?? "";
  let raw = "";
  try {
    raw = await response.text();
  } catch (error) {
    return { ok: false, status, message: error instanceof Error ? error.message : String(error) };
  }
  const envelopes = parseMcpSse(raw);
  if (!response.ok) {
    const error = extractError(raw, envelopes);
    const envelopeCode = error?.code ?? (raw.match(/"code"\s*:\s*(\d+)/) ?? [])[1];
    const message = typeof error?.message === "string" && error.message !== ""
      ? error.message
      : envelopeCode !== undefined && envelopeCode !== ""
        ? `HTTP ${status} code=${envelopeCode}`
        : raw.trim().slice(0, 200) || `HTTP ${status}`;
    return { ok: false, status, sessionId: sessionIdOut, message };
  }
  return { ok: true, status, sessionId: sessionIdOut, envelopes };
}

/**
 * Run one `web_search` call over a fresh MCP session. A session is created and
 * consumed per call — simple and reliable, at the cost of a handshake per call
 * (the server times the session out on its own).
 * @param {object} options - options.
 * @param {string} options.token - the Raccoon credential.
 * @param {string} options.query - the search query (1~100 chars).
 * @param {number} [options.count] - result count.
 * @param {string} [options.searchType] - `web` | `image`.
 * @param {string} [options.timeRange] - optional time range.
 * @param {typeof fetch} [options.fetchImpl] - injected fetch.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @returns {Promise<{ok: boolean; results?: object[]; resultCount?: number; message?: string}>}
 */
export async function searchWebOnce(options: {
  token: string;
  query: string;
  count?: number;
  searchType?: string;
  timeRange?: string;
  fetchImpl?: (url: string, init: object) => Promise<any>;
  timeoutMs?: number;
}) {
  const { token, query, count, searchType, timeRange, fetchImpl, timeoutMs } = options;
  const url = RACCOON_MCP_SEARCH_URL;
  const common = { url, token, timeoutMs, fetchImpl };
  const init = await mcpPost({
    ...common,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: RACCOON_MCP_PROTOCOL,
        capabilities: {},
        clientInfo: { name: "dsh-raccoon-search", version: "1" }
      }
    }
  });
  if (!init.ok || init.sessionId === "") {
    return { ok: false, message: init.message ?? "MCP initialize failed" };
  }
  const sessionId = init.sessionId as string;
  await mcpPost({ ...common, sessionId, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  const args: Record<string, unknown> = { Query: query };
  if (typeof count === "number" && count > 0) args.Count = Math.floor(count);
  if (str(searchType, "") !== "") args.SearchType = searchType;
  if (str(timeRange, "") !== "") args.TimeRange = timeRange;
  const call = await mcpPost({
    ...common,
    sessionId,
    body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: RACCOON_SEARCH_TOOL_NAME, arguments: args } }
  });
  if (!call.ok) return { ok: false, message: call.message ?? "tools/call failed" };
  const { result, error } = mcpEnvelope(call.envelopes ?? []);
  if (error) return { ok: false, message: error?.message ?? String(error) };
  const text = Array.isArray(result?.content)
    ? result.content.find((part: any) => part?.type === "text")?.text
    : undefined;
  let parsed: any = {};
  if (typeof text === "string" && text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { Raw: text };
    }
  }
  const results = Array.isArray(parsed?.Result?.WebResults) ? parsed.Result.WebResults : [];
  const resultCount = typeof parsed?.Result?.ResultCount === "number" ? parsed.Result.ResultCount : results.length;
  return { ok: true, results, resultCount, raw: parsed };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new RaccoonSearchError("Raccoon web search aborted", "WEB_ABORTED", { cause: signal.reason });
}

/** Map one raw `WebResults` item to a source, dropping url-less rows. */
function toSource(item: any): RaccoonSearchSource | undefined {
  const url = str(item?.Url, "");
  if (url === "") return undefined;
  const title = str(item?.Title, "");
  const snippet = String(item?.Snippet ?? "").replace(/\s+/g, " ").trim();
  return {
    url,
    ...(title !== "" ? { title } : {}),
    ...(snippet !== "" ? { snippet } : {})
  };
}

/**
 * A `ctx.web` search provider backed by the Raccoon hosted MCP server.
 *
 * Selection between sibling search providers is the web seam's job (pin
 * `searchProvider: raccoon` if ambiguous), so this class only claims `id`; it
 * never touches the runtime's private selection field. `available()` is a cheap
 * local check — no network, exactly like the commandcode precedent.
 */
export class RaccoonSearchProvider implements RaccoonWebSearchProvider {
  readonly id = RACCOON_SEARCH_PROVIDER_ID;

  private readonly deps: { resolveToken: () => Promise<string>; fetchImpl?: (url: string, init: object) => Promise<any>; timeoutMs?: number };

  constructor(deps: { resolveToken: () => Promise<string>; fetchImpl?: (url: string, init: object) => Promise<any>; timeoutMs?: number }) {
    this.deps = deps;
  }

  available(): boolean {
    try {
      return URL.canParse(RACCOON_MCP_SEARCH_URL);
    } catch {
      return false;
    }
  }

  async search(request: RaccoonSearchRequest, signal?: AbortSignal): Promise<RaccoonSearchResult> {
    throwIfAborted(signal);
    const query = str(request?.query, "");
    if (query === "") {
      throw new RaccoonSearchError("Raccoon web search requires a non-empty query", "WEB_PROVIDER_ERROR");
    }
    const token = await this.deps.resolveToken();
    throwIfAborted(signal);
    if (token === "") {
      throw new RaccoonSearchError("Raccoon is not signed in — no credential to search with", "WEB_PROVIDER_ERROR");
    }
    const count = typeof request?.maxResults === "number" && request.maxResults > 0
      ? Math.max(1, Math.min(50, Math.floor(request.maxResults)))
      : RACCOON_SEARCH_DEFAULT_COUNT;
    let outcome;
    try {
      outcome = await searchWebOnce({
        token,
        query,
        count,
        fetchImpl: this.deps.fetchImpl,
        timeoutMs: this.deps.timeoutMs
      });
    } catch (error) {
      throwIfAborted(signal);
      throw new RaccoonSearchError(
        `Raccoon web search request failed: ${error instanceof Error ? error.message : String(error)}`,
        "WEB_PROVIDER_ERROR",
        { cause: error }
      );
    }
    throwIfAborted(signal);
    if (!outcome.ok) {
      throw new RaccoonSearchError(
        `Raccoon web search failed: ${outcome.message ?? "unknown error"}`,
        "WEB_PROVIDER_ERROR"
      );
    }
    const sources: RaccoonSearchSource[] = [];
    const seen = new Set<string>();
    for (const item of outcome.results ?? []) {
      const source = toSource(item);
      if (source === undefined || seen.has(source.url)) continue;
      seen.add(source.url);
      sources.push(source);
    }
    return { sources, truncated: false };
  }
}
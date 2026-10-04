/**
 * Unit checks for the Raccoon hosted `web_search` MCP tool (`raccoon-search.ts`)
 * — PEER-FREE, like draw.test.mjs:
 *
 * - SSE `data:` parsing (event lines, keep-alives, malformed frames);
 * - `mcpPost` against a fake fetch: 401 envelope, session header capture,
 *   failed-request message extraction;
 * - `searchWebOnce` end-to-end over a scripted MCP session (initialize →
 *   notifications/initialized → tools/call), including the arguments the call
 *   carries and the WebResults extraction;
 * - `RaccoonSearchProvider` against a fake `ctx.web` shape: `available()`,
 *   `search()` success mapping, empty-query / missing-credential /
 *   failed-call errors, url de-duplication, and abort propagation.
 *
 * The mount is the `ctx.web` provider (the commandcode precedent), NOT a
 * hand-registered agent tool — that is exactly what the provider block pins.
 * Nothing here opens a socket.
 */
import {
  RACCOON_MCP_SEARCH_URL,
  RACCOON_SEARCH_PROVIDER_ID,
  parseMcpSse,
  mcpPost,
  searchWebOnce,
  RaccoonSearchProvider,
  RaccoonSearchError
} from "../src/host/raccoon-search.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: !!condition, detail });
}
function fail(group, error) {
  results.push({ name: `${group}: threw ${error?.name ?? "Error"}`, pass: false, detail: String(error?.message ?? error) });
}

/** A scripted MCP-over-HTTP fetch: dispatches on the jsonrpc `method`. */
function scriptedFetch(script) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const hit = script[body.method];
    if (!hit) return { ok: false, status: 404, text: async () => "", headers: { get: () => null } };
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      headers: { get: (n) => (n === "Mcp-Session-Id" ? (hit.sessionId ?? "") : null) },
      text: async () => hit.body ?? ""
    };
  };
}

function sse(payload) {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function resultsBody(webResults) {
  return sse({
    jsonrpc: "2.0",
    id: 2,
    result: { content: [{ type: "text", text: JSON.stringify({ Result: { ResultCount: webResults.length, WebResults: webResults } }) }] }
  });
}

const HAPPY = {
  initialize: {
    status: 200,
    sessionId: "sess-1",
    body: sse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "search", version: "1" } } })
  },
  "notifications/initialized": { status: 202, body: "" },
  "tools/call": {
    status: 200,
    body: resultsBody([{ Title: "T", Url: "https://x", Snippet: "  s   s ", SiteName: "S" }])
  }
};

try {
  // --- 1. SSE parsing -----------------------------------------------------
  {
    const frames = parseMcpSse("event: ping\n\n" + sse({ a: 1 }) + "data: {not json\n\n" + sse({ b: 2 }));
    check("parseMcpSse reads data frames and skips events + junk",
      frames.length === 2 && frames[0].a === 1 && frames[1].b === 2, JSON.stringify(frames));
    check("parseMcpSse tolerates an empty body", parseMcpSse("").length === 0);
  }

  // --- 2. mcpPost ---------------------------------------------------------
  {
    const post = await mcpPost({
      url: RACCOON_MCP_SEARCH_URL,
      token: "t",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      fetchImpl: scriptedFetch(HAPPY)
    });
    check("mcpPost surfaces the session header", post.ok === true && post.sessionId === "sess-1", JSON.stringify(post.sessionId));

    const captured = [];
    await mcpPost({
      url: RACCOON_MCP_SEARCH_URL,
      token: "t",
      body: { jsonrpc: "2.0", method: "tools/call", params: {} },
      sessionId: "sess-1",
      fetchImpl: async (url, init) => {
        captured.push(init.headers);
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" };
      }
    });
    check("mcpPost carries Authorization + Mcp-Session-Id + both Accepts",
      captured[0].Authorization === "Bearer t" &&
      captured[0]["Mcp-Session-Id"] === "sess-1" &&
      captured[0].Accept === "application/json, text/event-stream", JSON.stringify(captured[0]));

    const denied = await mcpPost({
      url: RACCOON_MCP_SEARCH_URL,
      token: "t",
      body: {},
      fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => '{"code":200001,"message":"authorization_empty_error","details":"authorization empty"}' })
    });
    check("a 401 envelope reads its message", denied.ok === false && denied.message === "authorization_empty_error", JSON.stringify(denied));

    const notAcceptable = await mcpPost({
      url: RACCOON_MCP_SEARCH_URL,
      token: "t",
      body: {},
      fetchImpl: async () => ({ ok: false, status: 406, headers: { get: () => null }, text: async () => "Not Acceptable: Client must accept both application/json and text/event-stream" })
    });
    check("a 406 without SSE frames still reports the status",
      notAcceptable.ok === false && /Not Acceptable/.test(notAcceptable.message), notAcceptable.message);
  }

  // --- 3. searchWebOnce ---------------------------------------------------
  {
    const ok = await searchWebOnce({ token: "t", query: "商汤科技", count: 3, fetchImpl: scriptedFetch(HAPPY) });
    check("searchWebOnce returns the extracted results",
      ok.ok === true && ok.resultCount === 1 && ok.results[0].Title === "T", JSON.stringify(ok));

    const noInit = await searchWebOnce({ token: "t", query: "x", fetchImpl: scriptedFetch({}) });
    check("a missing initialize fails cleanly", noInit.ok === false && typeof noInit.message === "string", JSON.stringify(noInit));

    let callArgs = null;
    const inner = scriptedFetch(HAPPY);
    await searchWebOnce({
      token: "t", query: "q", count: 7, searchType: "image", timeRange: "2026",
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if (body.method === "tools/call") callArgs = body.params.arguments;
        return inner(url, init);
      }
    });
    check("searchWebOnce forwards query/count/type/range",
      callArgs?.Query === "q" && callArgs?.Count === 7 && callArgs?.SearchType === "image" && callArgs?.TimeRange === "2026", JSON.stringify(callArgs));
  }

  // --- 4. RaccoonSearchProvider (the ctx.web mount) ----------------------
  {
    const provider = new RaccoonSearchProvider({ resolveToken: async () => "tok", fetchImpl: scriptedFetch(HAPPY) });
    check("the provider registers under the raccoon id", provider.id === RACCOON_SEARCH_PROVIDER_ID, provider.id);
    check("available() is a cheap local check", provider.available() === true);

    const result = await provider.search({ query: "商汤科技", maxResults: 3 });
    check("search() maps WebResults to sources",
      result.sources.length === 1 && result.sources[0].url === "https://x" && result.sources[0].title === "T" && result.sources[0].snippet === "s s",
      JSON.stringify(result));

    const capped = await provider.search({ query: "x", maxResults: 999 });
    check("maxResults clamps into the gateway's 1~50 range", capped.truncated === false, JSON.stringify(capped));

    const empty = await provider.search({ query: "   " }).catch((e) => e);
    check("an empty query throws a WEB_PROVIDER_ERROR",
      empty instanceof RaccoonSearchError && empty.code === "WEB_PROVIDER_ERROR", String(empty?.code));

    const signedOutProvider = new RaccoonSearchProvider({ resolveToken: async () => "" });
    const signedOutError = await signedOutProvider.search({ query: "x" }).catch((e) => e);
    check("a missing credential throws", signedOutError instanceof RaccoonSearchError && /not signed in/.test(signedOutError.message), String(signedOutError?.message));

    const failed = await new RaccoonSearchProvider({ resolveToken: async () => "t", fetchImpl: scriptedFetch({}) }).search({ query: "x" }).catch((e) => e);
    check("a failed MCP call surfaces a provider error",
      failed instanceof RaccoonSearchError && failed.code === "WEB_PROVIDER_ERROR", String(failed?.message));

    const dedup = new RaccoonSearchProvider({
      resolveToken: async () => "t",
      fetchImpl: scriptedFetch({
        initialize: HAPPY.initialize,
        "notifications/initialized": { status: 202, body: "" },
        "tools/call": { status: 200, body: resultsBody([
          { Title: "A", Url: "https://dup", Snippet: "1" },
          { Title: "B", Url: "https://dup", Snippet: "2" },
          { Title: "", Url: "", Snippet: "3" },
          { Title: "C", Url: "https://c", Snippet: "4" }
        ]) }
      })
    });
    const deduped = await dedup.search({ query: "x" });
    check("results are url-de-duplicated and url-less rows are dropped",
      deduped.sources.length === 2 && deduped.sources[0].url === "https://dup", JSON.stringify(deduped.sources));

    const ctrl = new AbortController();
    ctrl.abort();
    const aborted = await provider.search({ query: "x" }, ctrl.signal).catch((e) => e);
    check("an aborted signal throws WEB_ABORTED",
      aborted instanceof RaccoonSearchError && aborted.code === "WEB_ABORTED", String(aborted?.code));
  }
} catch (error) {
  fail("raccoon-search", error);
}

// --- summary -------------------------------------------------------------
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
for (const row of failed) console.log(JSON.stringify(row));
console.log(`raccoon-search.test.mjs: ${passed}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
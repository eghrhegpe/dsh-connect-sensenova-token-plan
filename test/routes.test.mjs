/**
 * End-to-end checks of the Host routes, driving the real index.js.
 *
 * Two dimensions matter here and neither was covered before:
 *
 *   1. the token lifecycle against a fake console (401 → renew → retry), and
 *   2. the panel's own decision about whether to show the account form,
 *      replayed against the response the Host actually produces.
 *
 * The second is the regression guard for the reported bug: a Host whose
 * response carried no `auth` field left the panel with `auth === null`, and
 * the form was then unreachable.
 */
import { loadPeer, installNetworkGuard, isolateHostEnv, isolateStateDir } from "./peer-roots.mjs";
import { createFileThrottleStore } from "../src/host/throttle-store.ts";
import { RACCOON_CREDENTIAL_REF, serializeRaccoonCredential } from "../src/host/raccoon-store.ts";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();
/** The host's own SenseNova keys must not steer a check. See isolateHostEnv. */
const restoreHostEnv = isolateHostEnv();

const { credentialKey } = await loadPeer("dsh-credentials");
const { interpretSnapshot, decidePanelView } = await import("./panel-decision.js");

/** After the peers are found: the throttle is real state, kept off the real Home. */
const restoreStateDir = isolateStateDir();

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

const SNAPSHOT_PATH = "/api/dsh-connect-sensenova-token-plan/snapshot";
const ACCOUNT_PATH = "/api/dsh-connect-sensenova-token-plan/account";
const API_KEY_PATH = "/api/dsh-connect-sensenova-token-plan/api-key";
const PROVIDER_PATH = "/api/dsh-connect-sensenova-token-plan/provider";
const MODELS_PATH = "/api/dsh-connect-sensenova-token-plan/models";
const DRAW_PATH = "/api/dsh-connect-sensenova-token-plan/draw";
const RACCOON_PATH = "/api/dsh-connect-sensenova-token-plan/raccoon";
const RECORD_KEY = credentialKey("dsh-connect-sensenova-token-plan", "sensenova-console");

const POOL_BODY = {
  plan: { id: "p1", name: "TokenPlan", type: "token_plan" },
  pools: [{
    id: "pool-1", name: "通用池", pool_type: "default", model_ids: ["SenseNova-Lite"],
    window_5h: { limit: 60000, used: 12345, remaining: 47655, reset_at: "1800000000" },
    window_7d: { limit: 600000, used: 12345, remaining: 587655, reset_at: "1800600000" },
    grant_balance: 0
  }]
};
const TREND_BODY = { series: [{ model_id: "SenseNova-Lite", points: [{ credits: 12.5 }] }] };

function jwtExpiring(minutes) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + minutes * 60 })).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
}

const storedGrant = (accessToken, refreshToken, expiresIn) => ({
  kind: "grant",
  payload: { version: 1, accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 }
});

/** A fake credentials service covering both halves of the seam. */
function makeCredentials(initial, opts = {}) {
  const records = new Map();
  const refs = new Map(Object.entries(opts.refs ?? {}));
  if (initial) records.set(RECORD_KEY, initial);
  return {
    records, refs,
    async readRecord(k) { return records.get(k); },
    async modifyRecord(k, mutate) {
      const next = await mutate(records.get(k));
      if (next === undefined) return records.get(k);
      records.set(k, next);
      return next;
    },
    async deleteRecord(k) { records.delete(k); },
    async resolve(ref) {
      const v = refs.get(ref);
      return typeof v === "string" && v.length > 0 ? { value: v, source: "file" } : undefined;
    },
    async set(ref, value) { refs.set(ref, value); },
    async unset(ref) { refs.delete(ref); }
  };
}

function makeRequest(extra = {}) {
  return { method: "GET", headers: { host: "127.0.0.1:19387", ...extra } };
}

function makePost(body, extraHeaders = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    method: "POST",
    headers: { host: "127.0.0.1:19387", "content-type": "application/json", ...extraHeaders },
    async *[Symbol.asyncIterator]() { yield Buffer.from(text, "utf8"); }
  };
}

function makeResponse() {
  return {
    statusCode: null, headers: null, payload: null, writes: 0,
    // Counted because a real ServerResponse throws ERR_HTTP_HEADERS_SENT on a
    // second write, while this object would happily accept one: without the
    // count, a handler that answers twice passes here and breaks in the Host.
    writeHead(status, headers) { this.writes += 1; this.statusCode = status; this.headers = headers; },
    end(text) { this.payload = text === undefined ? null : JSON.parse(text); }
  };
}

/**
 * Mount the real routes; `credentials: null` models a Host without them.
 * @param {object|null} credentials - the fake credentials service.
 * @param {object} [config] - raw row config.
 * @param {object} [deps] - extra seam wiring:
 *   `llm` a fake llm service, `loadAdapterModule` the peer adapter seam.
 */
async function mount(credentials, config = {}, deps = {}) {
  const host = await import(`../src/host/index.ts?route=${Math.random()}`);
  const handlers = new Map();
  const services = { credentials, llm: deps.llm };
  host.apply({
    get: (s) => services[s],
    emit: deps.emit ?? (() => {}),
    effect: () => () => {},
    webServer: { register(spec) { handlers.set(spec.path, spec.handler); return () => {}; } }
  }, { consoleBase: "https://console.test", cacheSeconds: 5, ...config }, {
    loadAdapterModule: deps.loadAdapterModule
  });
  return async (path, request) => {
    const response = makeResponse();
    await handlers.get(path)(request, response);
    return response;
  };
}

/**
 * The panel's own decision, lifted out of client.js.
 *
 * This used to be a hand-written copy labelled "mirrored from PanelPage" — the
 * same drift `panel-decision.js` exists to abolish. A mirror that lives in the
 * route tests is worse than none: it asserts about a panel nobody ships.
 */
function panelDecision(body) {
  const read = interpretSnapshot(body);
  const decided = decidePanelView(read.data, read.error);
  return {
    data: read.data,
    failure: decided.failure,
    auth: decided.auth,
    needsSetup: decided.needsSetup,
    canManageAccount: decided.canManageAccount,
    renders: decided.render
  };
}

/** A console stub that can refuse the first token it is shown. */
function consoleStub({ rejectFirstToken = null } = {}) {
  const calls = [];
  const stub = async (url, init) => {
    const auth = init?.headers?.authorization ?? "";
    const target = String(url);
    calls.push({ target, auth });
    if (rejectFirstToken !== null && auth === `Bearer ${rejectFirstToken}`) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    if (target.includes("pool-usage")) {
      return new Response(JSON.stringify(POOL_BODY), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("credit-usage-trend")) {
      return new Response(JSON.stringify(TREND_BODY), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  stub.calls = calls;
  return stub;
}

/** A full login-flow stub. */
async function loginNetwork({ loginOk = true } = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true, ["encrypt", "decrypt"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const log = { logins: 0, tokens: 0 };
  let issuedState = "";
  const stub = async (url) => {
    const target = String(url);
    if (target.includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/oauth2/auth")) {
      issuedState = new URL(target).searchParams.get("state") ?? "";
      return new Response("", {
        status: 302,
        headers: {
          location: "https://platform.sensenova.cn/login?login_challenge=chal-123",
          "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
        }
      });
    }
    if (target.includes("iam.sensecoreapi.cn")) {
      log.logins += 1;
      return loginOk
        ? new Response(JSON.stringify({
            redirect: `https://platform.sensenova.cn/cb?code=the-code${issuedState !== "" ? `&state=${encodeURIComponent(issuedState)}` : ""}`
          }),
            { status: 200, headers: { "content-type": "application/json" } })
        // The real IAM envelope, not a guess: the cause lives in details[].
        : new Response(JSON.stringify({
            code: 3, message: "InvalidArgument",
            details: [
              { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "invalidAccountOrPassword", domain: "iam" },
              { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en", message: "invalid account or password" }
            ]
          }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (target.includes("oauth2/token")) {
      log.tokens += 1;
      return new Response(
        JSON.stringify({ access_token: jwtExpiring(180), refresh_token: `granted-${log.tokens}`, expires_in: 10800 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (target.includes("pool-usage")) {
      return new Response(JSON.stringify(POOL_BODY), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("credit-usage-trend")) {
      return new Response(JSON.stringify(TREND_BODY), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  stub.log = log;
  return stub;
}

async function withNetwork(stub, body) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// === A. a fresh stored token reaches the console and returns pools ========
{
  const token = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(token, "r1", 7200));
  const stub = consoleStub();
  await withNetwork(stub, async () => {
    const response = await (await mount(credentials))(SNAPSHOT_PATH, makeRequest());
    check("snapshot succeeds", response.payload.ok === true, JSON.stringify(response.payload).slice(0, 120));
    check("pool name is returned", response.payload?.pools?.pools?.[0]?.name === "通用池");
    check("5h window is parsed", response.payload?.pools?.pools?.[0]?.window5h?.used === 12345);
    check("7d reset_at string becomes a number",
      response.payload?.pools?.pools?.[0]?.window7d?.resetAt === 1800600000,
      String(response.payload?.pools?.pools?.[0]?.window7d?.resetAt));
    check("trend is parsed", response.payload?.trend?.models?.[0]?.credits === 12.5);
    check("console saw the stored token", stub.calls.every((c) => c.auth === `Bearer ${token}`));
    check("a working panel does not show the form",
      panelDecision(response.payload).renders === "pools");
  }).catch((error) => fail("A: fresh token", error));
}

// === A2. the trend cache actually hits across polls ====================
// The trend endpoint carries a 5-minute cache, but the request used to bake
// `now` (to the second) into `end_time`, so the URL differed on every poll and
// the cache never matched. Snapping `end_time` to the granularity boundary
// makes polls inside the same hour bucket share one URL and one cached body.
{
  const token = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(token, "r", 7200));
  const stub = consoleStub();
  await withNetwork(stub, async () => {
    const call = await mount(credentials, { cacheSeconds: 5 });
    const first = await call(SNAPSHOT_PATH, makeRequest());
    const second = await call(SNAPSHOT_PATH, makeRequest());
    const trendCalls = stub.calls.filter((c) => c.target.includes("credit-usage-trend"));
    check("both polls succeed", first.payload.ok === true && second.payload.ok === true,
      `${first.payload.ok}/${second.payload.ok}`);
    check("the trend response is served from cache on the second poll",
      trendCalls.length === 1, `trend console calls=${trendCalls.length}`);
    check("the second poll still carries trend data",
      second.payload?.trend?.models?.[0]?.credits === 12.5);
    // The property that makes the URL stable: end_time lands on the hour edge.
    const endParam = new URL(trendCalls[0].target).searchParams.get("end_time");
    check("the trend end_time is snapped to the hour boundary",
      Number(endParam) % 3600 === 0, `end_time=${endParam}`);
  }).catch((error) => fail("A2: trend cache hit", error));
}

// === A3. concurrent polls share one console call (single-flight) ========
// Many open panels or tabs poll at once. Without request coalescing, N panels
// would each hit the console — and the platform's own rate limiter, which this
// plugin goes to some length to avoid tripping. One in-flight fetch per URL
// means concurrent polls inside the same window collapse onto a single call.
{
  const token = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(token, "r", 7200));
  const stub = consoleStub();
  await withNetwork(stub, async () => {
    const call = await mount(credentials, { cacheSeconds: 5 });
    // Fire two snapshots at once so both enter fetchConsole before either
    // resolves and sets its cache.
    const [first, second] = await Promise.all([
      call(SNAPSHOT_PATH, makeRequest()),
      call(SNAPSHOT_PATH, makeRequest())
    ]);
    const poolCalls = stub.calls.filter((c) => c.target.includes("pool-usage"));
    const trendCalls = stub.calls.filter((c) => c.target.includes("credit-usage-trend"));
    check("both concurrent polls succeed",
      first.payload.ok === true && second.payload.ok === true,
      `${first.payload.ok}/${second.payload.ok}`);
    check("pool-usage was fetched once, not twice",
      poolCalls.length === 1, `pool calls=${poolCalls.length}`);
    check("credit-usage-trend was fetched once, not twice",
      trendCalls.length === 1, `trend calls=${trendCalls.length}`);
    check("both polls still carry trend data",
      first.payload?.trend?.models?.[0]?.credits === 12.5 &&
      second.payload?.trend?.models?.[0]?.credits === 12.5);
  }).catch((error) => fail("A3: single-flight", error));
}

// === B. a 401 triggers one renewal and a successful retry =================
{
  const dead = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(dead, "old-refresh", 7200));
  let refreshed = false;
  const stub = consoleStub({ rejectFirstToken: dead });
  await withNetwork(async (url, init) => {
    if (String(url).includes("oauth2/token")) {
      refreshed = true;
      return new Response(
        JSON.stringify({ access_token: jwtExpiring(180), refresh_token: "rotated", expires_in: 10800 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return stub(url, init);
  }, async () => {
    const response = await (await mount(credentials))(SNAPSHOT_PATH, makeRequest());
    check("401 is recovered", response.payload.ok === true, JSON.stringify(response.payload).slice(0, 160));
    check("a refresh happened", refreshed === true);
    check("the rotated refresh token is persisted",
      (await credentials.readRecord(RECORD_KEY))?.payload?.refreshToken === "rotated");
    // Two console endpoints; single-flight means only the initial attempts
    // carry the dead token, and only one renewal happens.
    check("only the initial attempt uses the dead token",
      stub.calls.filter((c) => c.auth === `Bearer ${dead}`).length === 2,
      `rejected=${stub.calls.filter((c) => c.auth === `Bearer ${dead}`).length}`);
  }).catch((error) => fail("B: 401 recovery", error));
}

// === C. a persistent rejection degrades the quota block ==================
// A console that keeps refusing the token no longer blanks the whole
// snapshot: the body answers `ok:true` with an in-body `quotaError`, so the
// API and Raccoon tabs (independent of the console) stay usable while the
// quota tab asks for a re-login.
{
  const dead = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(dead, "old", 7200));
  let refreshes = 0;
  await withNetwork(async (url) => {
    if (String(url).includes("oauth2/token")) {
      refreshes += 1;
      return new Response(
        JSON.stringify({ access_token: jwtExpiring(180), refresh_token: `r${refreshes}`, expires_in: 10800 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
  }, async () => {
    const response = await (await mount(credentials))(SNAPSHOT_PATH, makeRequest());
    check("a persistent rejection still answers", response.payload.ok === true,
      JSON.stringify(response.payload).slice(0, 160));
    check("the quota block names jwt_expired", response.payload.quotaError?.code === "jwt_expired",
      String(response.payload.quotaError?.code));
    check("the failure carries auth state", response.payload.auth !== undefined);
    check("the API tab block still arrives", response.payload.llm !== undefined);
    check("no refresh storm", refreshes <= 2, `refreshes=${refreshes}`);
  }).catch((error) => fail("C: persistent 401", error));
}

// === D. a cross-origin request is refused ================================
{
  const token = jwtExpiring(120);
  const credentials = makeCredentials(storedGrant(token, "r", 7200));
  const host = await import(`../src/host/index.ts?origin=${Math.random()}`);
  let handler = null;
  host.apply({
    get: (s) => (s === "credentials" ? credentials : undefined),
    effect: () => () => {},
    webServer: { register(spec) { handler = spec.handler; return () => {}; } }
  }, { consoleBase: "https://console.test" });
  const response = makeResponse();
  await handler(makeRequest({ origin: "https://evil.test" }), response);
  check("cross-origin is refused", response.statusCode === 403, String(response.statusCode));
}

// === D2. DNS rebinding: the two headers AGREE, and that is the trap ======
// The obvious fence compares `Origin` to `Host`. Under rebinding the attacker
// rebinds its own name to the loopback, so the browser sends the attacker's
// name for BOTH and the comparison waves the request through while it lands on
// the Host. Only refusing a Host this Host does not answer as turns it away —
// which matters here because the account route writes.
{
  const net = await loginNetwork();
  await withNetwork(net, async () => {
    const token = jwtExpiring(120);
    const credentials = makeCredentials(storedGrant(token, "r", 7200));
    const call = await mount(credentials);

    const rebound = await call(SNAPSHOT_PATH,
      makeRequest({ host: "attacker.test", origin: "https://attacker.test" }));
    check("a rebound host is refused even though Origin agrees with it",
      rebound.statusCode === 403, String(rebound.statusCode));

    // Brackets and ports are not part of the name, so a rebound Host cannot
    // smuggle itself in by spelling the loopback a different way.
    const bracketed = await call(SNAPSHOT_PATH,
      makeRequest({ host: "[::1]:19387", origin: "http://[::1]:19387" }));
    check("the loopback is still admitted when spelled with brackets and a port",
      bracketed.statusCode === 200, String(bracketed.statusCode));

    // The operator's list is added to the defaults, not substituted: naming a
    // LAN host must not lock the panel out of itself.
    const widened = await mount(credentials, { allowedHosts: ["panel.internal"] });
    const lan = await widened(SNAPSHOT_PATH,
      makeRequest({ host: "panel.internal", origin: "https://panel.internal" }));
    check("a host the operator added is admitted", lan.statusCode !== 403, String(lan.statusCode));
    const stillLoopback = await widened(SNAPSHOT_PATH, makeRequest());
    check("widening the list does not evict the loopback",
      stillLoopback.statusCode === 200, String(stillLoopback.statusCode));

    // Bare IPv6: the whitelist carries "::1" alongside "[::1]", and both
    // spellings must reach it. hostName() used to return "" for "::1" (the
    // first split segment of "::1"), which made the bare entry unreachable —
    // a host the operator named but no request could ever match.
    const bare = await call(SNAPSHOT_PATH, makeRequest({ host: "::1" }));
    check("a bare \"::1\" host is admitted", bare.statusCode === 200, String(bare.statusCode));
  }).catch((error) => fail("D2: DNS rebinding", error));
}

// === D3. the snapshot states its own rhythm =============================
// The panel used to poll every 30 s and quote "cached 60s" in its note, both
// written down in the browser bundle while the Host kept the real numbers. The
// Host now ships them and the panel follows, so changing either is one edit.
{
  const net = await loginNetwork();
  await withNetwork(net, async () => {
    const token = jwtExpiring(120);
    const call = await mount(makeCredentials(storedGrant(token, "r", 7200)));
    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    check("the snapshot states the cache age", snapshot.payload.cacheSeconds === 5,
      String(snapshot.payload.cacheSeconds));
    check("the snapshot states the poll cadence", snapshot.payload.pollSeconds === 30,
      String(snapshot.payload.pollSeconds));

    const retuned = await mount(makeCredentials(storedGrant(token, "r", 7200)),
      { cacheSeconds: 120, pollSeconds: 45 });
    const second = await retuned(SNAPSHOT_PATH, makeRequest());
    check("both follow the operator's values",
      second.payload.cacheSeconds === 120 && second.payload.pollSeconds === 45,
      `${second.payload.cacheSeconds}/${second.payload.pollSeconds}`);
  }).catch((error) => fail("D2: DNS rebinding", error));
}

// === E. a Host without the credentials service degrades, not dead-ends ===
// Before this fix the snapshot answered `auth_unavailable`, which the panel
// rendered as plain text with no way to sign in, and a response with no
// `auth` field at all left `auth === null` and so never reached the form.
// The signed-out host now answers `ok:true` with an in-body `quotaError`: the
// quota tab offers the sign-in form, while the API/Raccoon tabs stay usable.
{
  const net = await loginNetwork();
  await withNetwork(net, async () => {
    const call = await mount(null);
    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    check("a Host without credentials still answers", snapshot.statusCode === 200, String(snapshot.statusCode));
    check("it is not the auth_unavailable dead end", snapshot.payload.code !== "auth_unavailable",
      String(snapshot.payload.code));
    check("it still answers ok:true", snapshot.payload.ok === true,
      JSON.stringify(snapshot.payload ?? {}).slice(0, 140));
    check("the quota block names not_configured", snapshot.payload.quotaError?.code === "not_configured",
      String(snapshot.payload.quotaError?.code));
    check("the response carries auth state", snapshot.payload.auth !== undefined);
    check("it is marked ephemeral", snapshot.payload.auth?.ephemeral === true, JSON.stringify(snapshot.payload.auth));
    check("the API tab block still arrives (key/provider/draw are console-independent)",
      snapshot.payload.llm !== undefined);

    const decision = panelDecision(snapshot.payload);
    check("the quota tab offers the sign-in form", decision.canManageAccount === true && decision.renders === "pools",
      decision.renders);
    check("the panel is not asked for a full-screen setup", decision.needsSetup === false);

    // And the account route must accept a post, so the form can do its job.
    const posted = await call(ACCOUNT_PATH, makePost({ username: "u", password: "p" }));
    check("the account route accepts a post", posted.statusCode === 200, String(posted.statusCode));
    check("the post produced a grant", posted.payload.hasRefreshToken === true, JSON.stringify(posted.payload).slice(0, 160));

    // A restart-free second read now works off the in-memory grant.
    const second = await call(SNAPSHOT_PATH, makeRequest());
    check("the snapshot works right after signing in", second.payload.ok === true,
      JSON.stringify(second.payload).slice(0, 140));
  }).catch((error) => fail("E: a Host without credentials", error));
}

// === F. a response with no auth field still reaches the form =============
// The shape an older Host produced: `ok:false` and nothing else. The panel
// must not treat the missing field as "everything is fine".
{
  const decision = panelDecision({ ok: false, error: "no console account is configured", code: "not_configured" });
  check("a legacy payload without auth reaches the form", decision.renders === "AccountForm", decision.renders);
  check("the missing field reads as not needing setup", decision.needsSetup === true);
}

// === G. the account route, with a credentials service ====================
{
  const credentials = makeCredentials(null);
  const net = await loginNetwork();
  await withNetwork(net, async () => {
    const call = await mount(credentials);
    const before = await call(ACCOUNT_PATH, makeRequest());
    check("account GET succeeds", before.payload.ok === true);
    check("it reports no account", before.payload.hasAccount === false);
    check("it reports the panel needs setup", before.payload.needsAccount === true);
    check("it never returns a secret",
      !("password" in before.payload) && !("accessToken" in before.payload) && !("refreshToken" in before.payload));
    check("it is not ephemeral with the service", before.payload.ephemeral === false);

    const saved = await call(ACCOUNT_PATH, makePost({ username: "u@x", password: "p" }));
    check("a valid account is accepted", saved.payload.ok === true, JSON.stringify(saved.payload).slice(0, 160));
    check("the account is stored", saved.payload.hasAccount === true);
    check("a refresh token is held", saved.payload.hasRefreshToken === true);
    check("the panel no longer needs setup", saved.payload.needsAccount === false);
  }).catch((error) => fail("G: account route", error));
}

// === H. a rejected password is reported, not swallowed ===================
{
  const credentials = makeCredentials(null);
  const net = await loginNetwork({ loginOk: false });
  await withNetwork(net, async () => {
    const call = await mount(credentials);
    const response = await call(ACCOUNT_PATH, makePost({ username: "u", password: "wrong" }));
    check("a rejected password fails cleanly", response.payload.ok === false);
    check("the code is login_rejected", response.payload.code === "login_rejected", response.payload.code);
    // The reported reason must survive the state spread, or the panel can
    // never explain itself — and it must be the platform's own words.
    check("the reason reaches the user", /invalid account or password/i.test(response.payload.error),
      response.payload.error);
    check("the generic status string is not what the user is shown",
      !response.payload.error.includes("InvalidArgument"), response.payload.error);
    check("no grant is left behind", credentials.records.has(RECORD_KEY) === false);
  }).catch((error) => fail("H: rejected password", error));
}

// === I. body handling ====================================================
{
  const credentials = makeCredentials(null);
  const call = await mount(credentials);
  check("invalid JSON is a 400", (await call(ACCOUNT_PATH, makePost("{not json"))).statusCode === 400);
  check("a JSON array is a 400", (await call(ACCOUNT_PATH, makePost([1, 2, 3]))).statusCode === 400);
  check("an oversized body is a 400",
    (await call(ACCOUNT_PATH, makePost({ username: "u", password: "x".repeat(9000) }))).statusCode === 400);
  check("nothing was stored", credentials.refs.size === 0);

  const foreign = await call(ACCOUNT_PATH, makePost({ username: "attacker", password: "x" }, { origin: "https://evil.test" }));
  check("a cross-origin post is refused", foreign.statusCode === 403, String(foreign.statusCode));
  check("no account was written by the cross-origin post", credentials.refs.size === 0);
}

// === J. forget keeps the grant ==========================================
{
  const credentials = makeCredentials(storedGrant(jwtExpiring(120), "keep-me", 7200), {
    refs: { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "p" }
  });
  const call = await mount(credentials);
  const response = await call(ACCOUNT_PATH, makePost({ forget: true }));
  check("forget succeeds", response.payload.ok === true);
  check("the account is gone", response.payload.hasAccount === false);
  check("the grant survives", response.payload.hasRefreshToken === true);
  check("the panel is not asked for setup", response.payload.needsAccount === false);
}

// === L2. the snapshot's contract fields are present and correct ===========
// Four fields ride on every successful snapshot and the panel branches on each:
// `shapeWarnings` (PITFALLS §12 — a renamed console field must read as drift,
// not "no usage"), `catalogAvailable` / `uncountedModels` (the optional model
// catalog), and `traceFile` (the sanitized login trace a failed sign-in leaves
// behind). None had a direct assertion before, so a rename or a dropped field
// stayed invisible until it reached a user. This drives them through the real
// route with the network stubbed.
{
  // A drifted pool body: the parsers still return what they understood, but
  // `plan` and `pools` are gone from the top level.
  const DRIFT_POOL_BODY = { result: { data: [] }, series_x: [] };
  // A token unique to this block. index.js is a module singleton across mounts,
  // so `invalidate()` records refused tokens process-wide; reusing a JWT an
  // earlier section had its console reject would make getToken throw "not being
  // retried" here for a reason unrelated to the fields under test.
  const l2Token = jwtExpiring(120) + "-l2";
  // The throttle file is shared across mounts too (same isolated DSH_HOME), and
  // an earlier section parks a credential refusal that never expires on its own.
  // Clear it so these contract-field checks start from a clean slate rather than
  // inheriting another test's parked refusal.
  await createFileThrottleStore().clear();
  const driftStub = async (url) => {
    const target = String(url);
    if (target.includes("pool-usage")) {
      return new Response(JSON.stringify(DRIFT_POOL_BODY), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("credit-usage-trend")) {
      return new Response(JSON.stringify(TREND_BODY), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  await withNetwork(driftStub, async () => {
    const call = await mount(makeCredentials(storedGrant(l2Token, "r", 7200)));
    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    check("a drifted poll still succeeds", snapshot.payload.ok === true, JSON.stringify(snapshot.payload).slice(0, 120));
    check("shapeWarnings is an array", Array.isArray(snapshot.payload.shapeWarnings),
      JSON.stringify(snapshot.payload.shapeWarnings));
    const warnKeys = snapshot.payload.shapeWarnings.map((w) => `${w.api}:${w.missing}`).sort();
    check("the missing pool keys are reported as drift",
      warnKeys.includes("pool-usage:plan") && warnKeys.includes("pool-usage:pools"), JSON.stringify(warnKeys));
    check("a well-shaped trend adds no warning",
      !warnKeys.some((k) => k.startsWith("credit-usage-trend")), JSON.stringify(warnKeys));
    check("the panel surfaces the drift rather than reading empty",
      panelDecision(snapshot.payload).renders === "pools");
  }).catch((error) => fail("L2: shapeWarnings", error));

  // L2b. NESTED drift reaches the panel as a warning ----------------------
  // The top-level check alone missed the rename that matters most: `window_5h`
  // renamed inside a pool row leaves `plan`/`pools` present, so the panel drew
  // 0/0/0 with no warning at all. This drives the real route with such a body
  // and requires the drift to be reported by name.
  const DRIFT_NESTED_BODY = {
    plan: { id: "p1", name: "TokenPlan", type: "token_plan" },
    pools: [{
      id: "pool-1", name: "通用池", pool_type: "default",
      window_5H: { limit: "60000", used: "12345", remaining: "47655", reset_at: "1800000000" },
      window_7d: { limit: "600000", used: "12345", remaining: "587655", reset_at: "1800600000" }
    }]
  };
  const nestedStub = async (url) => {
    const target = String(url);
    if (target.includes("pool-usage")) {
      return new Response(JSON.stringify(DRIFT_NESTED_BODY), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("credit-usage-trend")) {
      return new Response(JSON.stringify(TREND_BODY), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  await withNetwork(nestedStub, async () => {
    const call = await mount(makeCredentials(storedGrant(l2Token, "r", 7200)));
    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    const warnKeys = snapshot.payload.shapeWarnings.map((w) => `${w.api}:${w.missing}`).sort();
    check("a renamed nested window is reported as drift",
      warnKeys.includes("pool-usage:pools[].window_5h"), JSON.stringify(warnKeys));
    check("the top-level keys are NOT blamed for a nested rename",
      !warnKeys.includes("pool-usage:plan") && !warnKeys.includes("pool-usage:pools"), JSON.stringify(warnKeys));
    // The user-visible consequence: without the warning this payload renders a
    // real pool row showing zero usage, which reads as "you used nothing".
    // `payload.pools` is the whole block (plan header + rows), not the array.
    const pool = snapshot.payload.pools.pools[0];
    check("the drifted pool really would render as zero usage",
      pool.window5h.used === 0 && pool.window5h.limit === 0, JSON.stringify(pool.window5h));
  }).catch((error) => fail("L2b: nested shapeWarnings", error));

  // The healthy path: no drift, and no API key means the catalog degrades to
  // `catalogAvailable:false` with an empty uncounted list (never undefined).
  await withNetwork(consoleStub(), async () => {
    const call = await mount(makeCredentials(storedGrant(l2Token, "r", 7200)));
    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    check("a clean poll reports no drift",
      Array.isArray(snapshot.payload.shapeWarnings) && snapshot.payload.shapeWarnings.length === 0,
      JSON.stringify(snapshot.payload.shapeWarnings));
    check("without an API key the catalog is unavailable", snapshot.payload.catalogAvailable === false,
      String(snapshot.payload.catalogAvailable));
    check("uncountedModels is an empty array when there is no catalog",
      Array.isArray(snapshot.payload.uncountedModels) && snapshot.payload.uncountedModels.length === 0,
      JSON.stringify(snapshot.payload.uncountedModels));
  }).catch((error) => fail("L2: clean + no-catalog", error));

  // traceFile: a rejected password must leave the caller a pointer to the
  // sanitized trace. DSH_HOME is already isolated by isolateStateDir(), so this
  // writes into a scratch dir, never the real Home.
  const rejectCredentials = makeCredentials(null);
  const rejectNet = await loginNetwork({ loginOk: false });
  await withNetwork(rejectNet, async () => {
    const call = await mount(rejectCredentials);
    const response = await call(ACCOUNT_PATH, makePost({ username: "u", password: "wrong" }));
    check("a rejected sign-in fails cleanly", response.payload.ok === false);
    check("the failure carries a traceFile pointer",
      typeof response.payload.traceFile === "string" && response.payload.traceFile.length > 0,
      String(response.payload.traceFile));
  }).catch((error) => fail("L2: traceFile", error));
}

// === K. one response per request ========================================
// Saving an account used to answer twice: the success `writeJson` sat inside
// the `try` with no `return`, so the flow fell through to a second one. A real
// ServerResponse throws ERR_HTTP_HEADERS_SENT on the second write — an
// unhandled rejection in the Host that the user never sees, because the first
// answer already reached the browser. These checks passed throughout, because
// the fake response accepted both writes.
{
  const credentials = makeCredentials(null);
  const net = await loginNetwork();
  await withNetwork(net, async () => {
    const call = await mount(credentials);
    const saved = await call(ACCOUNT_PATH, makePost({ username: "u@x", password: "p" }));
    check("saving an account succeeds", saved.payload.ok === true, JSON.stringify(saved.payload).slice(0, 120));
    check("a saved account answers exactly once", saved.writes === 1, `writes=${saved.writes}`);

    const forgotten = await call(ACCOUNT_PATH, makePost({ forget: true }));
    check("a forgotten account answers exactly once", forgotten.writes === 1, `writes=${forgotten.writes}`);

    const rejected = await call(ACCOUNT_PATH, makePost({ username: "u", password: "" }));
    check("an empty password answers exactly once", rejected.writes === 1, `writes=${rejected.writes}`);

    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    check("a snapshot answers exactly once", snapshot.writes === 1, `writes=${snapshot.writes}`);
  }).catch((error) => fail("K: one response per request", error));
}

// === M. vision step two: the settings-row publish does not leak into the
// poll or crash a Host without a settings service =========================
// `visionPublish.current` is wired from `ctx.get("settings")` in apply(). The
// fake ctx in this suite has no settings service, so the publish stays null
// and a poll with a catalog must still succeed — the write is an enhancement
// that degrades to "the info layer only", never a dependency of the response.
{
  const credentials = makeCredentials(storedGrant(jwtExpiring(120), "r", 7200));
  // Give the credentials service the API key ref so the catalog is computed.
  credentials.refs.set("SENSENOVA_API_KEY", "sk-test-key-for-routing-only");
  // Build on top of a real login stub so the token flow works; extend it
  // with the /v1/models answer.
  const net = await loginNetwork();
  const extendedStub = async (url, init) => {
    const target = String(url);
    if (target.includes("/v1/models") || target.includes("/models")) {
      return new Response(JSON.stringify({
        data: [
          { id: "sensenova-6.8-flash-lite", input_modalities: ["text", "image"] },
          { id: "sensenova-u1.5-lite", input_modalities: ["text"], output_modalities: ["image"] }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return net(url, init);
  };
  await withNetwork(extendedStub, async () => {
    const call = await mount(credentials, { writeImageModelIds: true });
    const snapshot = await call(SNAPSHOT_PATH, makeRequest());
    // The poll still answers even though no settings service is present.
    check("a poll with writeImageModelIds still succeeds", snapshot.statusCode === 200,
      String(snapshot.statusCode));
    check("the poll reports ok", snapshot.payload.ok === true,
      JSON.stringify(snapshot.payload).slice(0, 120));
    // The vision identification reached the snapshot as before.
    check("the snapshot still carries visionModels",
      Array.isArray(snapshot.payload.visionModels) &&
      snapshot.payload.visionModels.length === 1 &&
      snapshot.payload.visionModels[0].id === "sensenova-6.8-flash-lite",
      JSON.stringify(snapshot.payload.visionModels));
    // Step three status rides the same poll: the key ref is recognized, the
    // counts follow the catalog, and the opt-in defaults to off.
    const llm = snapshot.payload.llm;
    check("the snapshot carries the secret-free llm block",
      llm && llm.ok === undefined && typeof llm.hasApiKey === "boolean", JSON.stringify(llm));
    check("the llm block sees the credential reference",
      llm.hasApiKey === true && llm.keySource === "credentials", JSON.stringify(llm));
    check("the llm block counts models and vision models",
      llm.modelCount === 1 && llm.visionCount === 1, JSON.stringify(llm));
    // The image-output model (sensenova-u1.5-lite) is not a chat model and
    // must not appear in the picker roster (isChatModel, 2026-09-29).
    check("the roster excludes the image-output model",
      JSON.stringify(llm.models?.map((m) => m.id)) === JSON.stringify(["sensenova-6.8-flash-lite"]),
      JSON.stringify(llm.models));
    check("the provider stays unregistered with the switch off",
      llm.registerProvider === false && llm.providerRegistered === false, JSON.stringify(llm));
    // 0.4.2: the llm block now also carries the draw-tool switch's effective
    // value and source. Without a saved panel value they are the config
    // defaults.
    check("the llm block carries the draw switch state",
      llm.drawEnabled === false && llm.drawSource === "config",
      JSON.stringify({ drawEnabled: llm.drawEnabled, drawSource: llm.drawSource }));
    // 0.4.2+: the draw block is emitted whenever the catalog is present — an
    // AUTO pick (no configured drawModelId) still addresses the catalog's
    // first image model, so `drawModel` + the candidate set are deployment
    // facts, not operator preferences. Only `drawPreferredModel` is
    // preference-shaped and absent here.
    check("auto-pick still reports drawModel + candidates when the catalog exists",
      llm.drawModel === "sensenova-u1.5-lite" &&
      llm.drawCandidateCount === 1 &&
      JSON.stringify(llm.drawCandidateIds) === JSON.stringify(["sensenova-u1.5-lite"]),
      JSON.stringify({ drawModel: llm.drawModel, candidates: llm.drawCandidateIds }));
    check("auto-pick carries no operator preference",
      !("drawPreferredModel" in llm), JSON.stringify(llm.drawPreferredModel));
    check("the llm block never carries the key",
      !JSON.stringify(llm).includes("sk-test-key-for-routing-only"));
  }).catch((error) => fail("M: vision publish without settings service", error));
}

// === N. the inference API-key route: save / state / forget / fence =========
// The `sk-` key is a credential REFERENCE the catalog poll and the registered
// provider share. These checks pin the three sources (reference, memory, env),
// the no-echo contract, and the same-origin fence the account route has.
{
  // N1. a credentials-backed Host: reference save and forget.
  try {
    const credentials = makeCredentials(storedGrant(jwtExpiring(120), "r", 7200));
    const call = await mount(credentials);
    const initial = await call(API_KEY_PATH, makeRequest());
    check("N1 GET reports no key initially",
      initial.payload.ok === true && initial.payload.hasApiKey === false &&
      initial.payload.keySource === null && initial.payload.ephemeral === false,
      JSON.stringify(initial.payload));
    check("N1 the state never echoes a value field",
      !("value" in initial.payload) && !("apiKey" in initial.payload));

    const blank = await call(API_KEY_PATH, makePost({ apiKey: "   " }));
    check("N1 a whitespace key is refused", blank.payload.ok === false && typeof blank.payload.error === "string",
      JSON.stringify(blank.payload));

    const saved = await call(API_KEY_PATH, makePost({ apiKey: "sk-panel-saved" }));
    check("N1 save stores the shared reference",
      saved.payload.ok === true && saved.payload.hasApiKey === true &&
      saved.payload.keySource === "credentials" && credentials.refs.get("SENSENOVA_API_KEY") === "sk-panel-saved",
      JSON.stringify(saved.payload));
    check("N1 the save response carries no echo",
      !JSON.stringify(saved.payload).includes("sk-panel-saved"));

    // The catalog poll resolves the SAME reference (the two surfaces share one
    // stored value): the snapshot's secret-free state agrees.
    const net = await loginNetwork();
    await withNetwork(async (url, init) => {
      const target = String(url);
      if (target.includes("/v1/models") || target.includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "m1", input_modalities: ["text"] }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return net(url, init);
    }, async () => {
      const polled = await call(SNAPSHOT_PATH, makeRequest());
      check("N1 the snapshot sees the panel-saved key",
        polled.payload.ok === true && polled.payload.llm?.keySource === "credentials" &&
        polled.payload.catalogAvailable === true, JSON.stringify(polled.payload.llm));
    });

    const forgotten = await call(API_KEY_PATH, makePost({ forget: true }));
    check("N1 forget clears the reference",
      forgotten.payload.ok === true && forgotten.payload.hasApiKey === false &&
      !credentials.refs.has("SENSENOVA_API_KEY"), JSON.stringify(forgotten.payload));
  } catch (error) { fail("N1: credentials-backed API-key route", error); }

  // N2. a Host with no credentials service: memory + ephemeral.
  try {
    const call = await mount(null);
    const saved = await call(API_KEY_PATH, makePost({ apiKey: "sk-memory" }));
    check("N2 a keyless-service host keeps the key in memory and says so",
      saved.payload.ok === true && saved.payload.hasApiKey === true &&
      saved.payload.keySource === "memory" && saved.payload.ephemeral === true,
      JSON.stringify(saved.payload));
    const forgotten = await call(API_KEY_PATH, makePost({ forget: true }));
    check("N2 forget clears the in-memory key",
      forgotten.payload.ok === true && forgotten.payload.hasApiKey === false,
      JSON.stringify(forgotten.payload));
  } catch (error) { fail("N2: memory API-key route", error); }

  // N3. the environment fallback stays authoritative without a reference.
  {
    process.env.SENSENOVA_API_KEY = "sk-from-env";
    try {
      const credentials = makeCredentials(null);
      const call = await mount(credentials);
      const state = await call(API_KEY_PATH, makeRequest());
      check("N3 an env key is reported with its source",
        state.payload.hasApiKey === true && state.payload.keySource === "env",
        JSON.stringify(state.payload));
      await call(API_KEY_PATH, makePost({ forget: true }));
      const after = await call(API_KEY_PATH, makeRequest());
      check("N3 forget leaves the environment value standing",
        after.payload.hasApiKey === true && after.payload.keySource === "env",
        JSON.stringify(after.payload));
    } catch (error) {
      fail("N3: env fallback", error);
    } finally {
      delete process.env.SENSENOVA_API_KEY;
    }
  }

  // N4. the trust fence: a foreign page cannot plant or read the key.
  try {
    const call = await mount(makeCredentials(null));
    const foreign = await call(API_KEY_PATH, {
      method: "POST",
      headers: { host: "127.0.0.1:19387", origin: "https://evil.example", "content-type": "application/json" },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ apiKey: "sk-x" }), "utf8"); }
    });
    check("N4 a cross-origin API-key POST is refused", foreign.statusCode === 403,
      String(foreign.statusCode));
  } catch (error) { fail("N4: API-key trust fence", error); }
}

// === O. step three registration: the opt-in drives the llm service =========
// The peer-dependent adapter never loads in this suite: a fake factory is
// injected through apply's third argument, so what is asserted here is the
// WIRING — register/re-register with the catalog, the event, teardown on
// forget, and graceful absence of an llm service. The real peer assembly is
// covered by test/e2e.mjs.
{
  const makeFakeLlm = () => {
    const calls = { adapter: [], directory: [], releases: 0, events: [] };
    const llm = {
      calls,
      registerAdapter(ids, adapter) {
        calls.adapter.push({ ids, adapter });
        return () => { calls.releases += 1; };
      },
      registerConfigurableProviders(rows) {
        calls.directory.push(rows);
        return () => { calls.releases += 1; };
      }
    };
    return llm;
  };
  const makeFakeAdapterDeps = () => {
    const builds = [];
    return {
      builds,
      loadAdapterModule: async () => ({
        createSensenovaAdapter(options) {
          builds.push(options);
          return { providerIds: ["sensenova-token-plan"], adapter: { fake: true, builtFrom: options.entries.length } };
        }
      })
    };
  };

  // O1. enabled + llm service + a catalog poll: one registration for the set.
  try {
    const credentials = makeCredentials(storedGrant(jwtExpiring(120), "r", 7200));
    credentials.refs.set("SENSENOVA_API_KEY", "sk-routing");
    const llm = makeFakeLlm();
    const adapterDeps = makeFakeAdapterDeps();
    const events = [];
    const net = await loginNetwork();
    await withNetwork(async (url, init) => {
      const target = String(url);
      if (target.includes("/v1/models") || target.includes("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "SenseNova-Lite", input_modalities: ["text"] },
            { id: "SenseNova-Vision", input_modalities: ["text", "image"] }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return net(url, init);
    }, async () => {
      const call = await mount(credentials, { registerProvider: true }, {
        llm, ...adapterDeps, emit: (event) => events.push(event)
      });
      // Let the mount seed (reads the private catalog store) settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const snapshot = await call(SNAPSHOT_PATH, makeRequest());
      check("O1 the snapshot reports the provider registered",
        snapshot.payload.llm?.registerProvider === true &&
        snapshot.payload.llm?.llmAvailable === true &&
        snapshot.payload.llm?.providerRegistered === true, JSON.stringify(snapshot.payload.llm));
      check("O1 the adapter was registered under the own (non-colliding) id",
        llm.calls.adapter.length >= 1 &&
        JSON.stringify(llm.calls.adapter.at(-1).ids) === JSON.stringify(["sensenova-token-plan"]),
        JSON.stringify(llm.calls.adapter.map((c) => c.ids)));
      check("O1 the provider directory row was declared",
        llm.calls.directory.length >= 1 &&
        llm.calls.directory.at(-1)[0]?.provider === "sensenova-token-plan",
        JSON.stringify(llm.calls.directory));
      const lastBuild = adapterDeps.builds.at(-1);
      check("O1 the adapter was built from the two catalog models at apiBase",
        lastBuild.entries.length === 2 && lastBuild.baseUrl === "https://token.sensenova.cn/v1",
        JSON.stringify({ count: lastBuild.entries.length, baseUrl: lastBuild.baseUrl }));
      check("O1 the rebuild notified catalog readers",
        events.includes("llm/adapters-updated"), JSON.stringify(events));

      // A second identical poll must NOT rebuild: the signature gate.
      const again = await call(SNAPSHOT_PATH, makeRequest());
      const buildsAfterSecond = adapterDeps.builds.length;
      await call(SNAPSHOT_PATH, makeRequest());
      check("O1 an unchanged catalog does not rebuild the provider",
        adapterDeps.builds.length === buildsAfterSecond,
        `${buildsAfterSecond} -> ${adapterDeps.builds.length}`);
      check("O1 the repeated poll still reports registered", again.payload.llm?.providerRegistered === true);

      // Forgetting the key tears the offer down (empty model list).
      await call(API_KEY_PATH, makePost({ forget: true }));
      check("O1 forget republishes with an empty model set",
        adapterDeps.builds.at(-1).entries.length === 0,
        String(adapterDeps.builds.at(-1).entries.length));
      check("O1 the previous registration pair was released on republish",
        llm.calls.releases >= 2, String(llm.calls.releases));
    });
  } catch (error) { fail("O1: provider registration on catalog poll", error); }

  // O2. enabled on a Host WITHOUT an llm service degrades, never crashes.
  try {
    const credentials = makeCredentials(storedGrant(jwtExpiring(120), "r", 7200));
    credentials.refs.set("SENSENOVA_API_KEY", "sk-routing2");
    const adapterDeps = makeFakeAdapterDeps();
    const net = await loginNetwork();
    await withNetwork(async (url, init) => {
      const target = String(url);
      if (target.includes("/v1/models") || target.includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "m1" }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return net(url, init);
    }, async () => {
      const call = await mount(credentials, { registerProvider: true }, adapterDeps);
      const snapshot = await call(SNAPSHOT_PATH, makeRequest());
      check("O2 no llm service means registered=false but the poll survives",
        snapshot.payload.ok === true && snapshot.payload.llm?.registerProvider === true &&
        snapshot.payload.llm?.llmAvailable === false &&
        snapshot.payload.llm?.providerRegistered === false, JSON.stringify(snapshot.payload.llm));
      check("O2 the peer adapter is never built without an llm service",
        adapterDeps.builds.length === 0, String(adapterDeps.builds.length));
    });
  } catch (error) { fail("O2: registration without llm service", error); }
}

// === P. the provider switch route: the panel value beats the config default
// (docs/PROVIDER-HOT-RELOAD.md). The switch persists in the plugin state file
// and a POST republishes immediately — no llm service here, so publishing
// degrades to llmAvailable=false while the SAVED value still reports.
{
  try {
    const credentials = makeCredentials(null);
    const call = await mount(credentials);

    const initial = await call(PROVIDER_PATH, makeRequest());
    check("P1 GET reports the config default with source config",
      initial.payload.ok === true && initial.payload.registerProvider === false &&
      initial.payload.registerSource === "config", JSON.stringify(initial.payload));

    const bad = await call(PROVIDER_PATH, makePost({ enabled: "yes" }));
    check("P2 a non-boolean enabled is refused",
      bad.statusCode === 400 && bad.payload.ok === false, JSON.stringify(bad.payload));

    const on = await call(PROVIDER_PATH, makePost({ enabled: true }));
    check("P3 POST saves the panel value and reports it as source panel",
      on.payload.ok === true && on.payload.registerProvider === true &&
      on.payload.registerSource === "panel", JSON.stringify(on.payload));

    // A second mount (fresh plugin instance, same state file) must read the
    // persisted switch — the value outlives one Host process.
    const call2 = await mount(makeCredentials(null));
    const again = await call2(PROVIDER_PATH, makeRequest());
    check("P4 the panel value survives a remount",
      again.payload.registerProvider === true && again.payload.registerSource === "panel",
      JSON.stringify(again.payload));

    const off = await call2(PROVIDER_PATH, makePost({ enabled: false }));
    check("P5 switching off reports the off state with source panel",
      off.payload.ok === true && off.payload.registerProvider === false &&
      off.payload.registerSource === "panel", JSON.stringify(off.payload));

    // The GET after the flip is the same effective-value logic the snapshot's
    // `llm` block uses (this mount has no console account, so a snapshot here
    // would not carry an llm block at all — see group E).
    const offGet = await call2(PROVIDER_PATH, makeRequest());
    check("P6 GET after the flip reports the saved value",
      offGet.payload.registerProvider === false && offGet.payload.registerSource === "panel",
      JSON.stringify(offGet.payload));

    const other = await call2(PROVIDER_PATH, makePost({ forget: true }));
    check("P7 an unrelated body is refused",
      other.statusCode === 400 && other.payload.ok === false, JSON.stringify(other.payload));

    // P8 the ADR-006 support trap: if the state file holds a version this build
    // does not read, a POST must NOT answer ok:true with a silently-unchanged
    // switch — the panel has to be able to say "that did not land" instead of
    // leaving a toggle that appears to work.
    const pluginDir = join(process.env.DSH_HOME, "state", "dsh-connect-sensenova-token-plan");
    mkdirSync(pluginDir, { recursive: true });
    const providerFile = join(pluginDir, "provider.json");
    writeFileSync(providerFile, JSON.stringify({ version: 999, enabled: true, futureField: "x" }, null, 2), "utf8");
    const refusedPost = await call2(PROVIDER_PATH, makePost({ enabled: true }));
    const afterRefusal = JSON.parse(readFileSync(providerFile, "utf8"));
    check("P8 a foreign-version file makes POST answer ok:false with the reason",
      refusedPost.payload.ok === false && typeof refusedPost.payload.error === "string" &&
      refusedPost.payload.error.includes("refusing to overwrite provider.json"),
      JSON.stringify(refusedPost.payload));
    check("P8 the foreign file is left intact",
      afterRefusal.version === 999 && afterRefusal.futureField === "x", JSON.stringify(afterRefusal));
    // Restore a clean slate: the foreign file must not leak into the groups
    // after this one, whose own POSTs expect to write normally.
    rmSync(providerFile, { force: true });
  } catch (error) { fail("P: the provider switch route", error); }
}

// === Q. the model roster route: which of this key's models get offered =====
// The third way the picker writes: POST /models replaces the curated
// allow-list and republishes immediately. Three properties matter and none of
// them is covered by the other groups: the fence (a foreign page must not
// choose this Host's model list), the immediate publish (the offer must not
// wait for the next poll), and the signature handoff (the poll after a save
// must not churn the registration).
{
  const makeFakeLlm = () => {
    const calls = { adapter: [], directory: [], releases: 0, events: [] };
    return {
      calls,
      registerAdapter(ids, adapter) { calls.adapter.push({ ids, adapter }); return () => { calls.releases += 1; }; },
      registerConfigurableProviders(rows) { calls.directory.push(rows); return () => { calls.releases += 1; }; }
    };
  };
  const makeFakeAdapterDeps = () => {
    const builds = [];
    return {
      builds,
      loadAdapterModule: async () => ({
        createSensenovaAdapter(options) {
          builds.push(options);
          return { providerIds: ["sensenova-token-plan"], adapter: { fake: true } };
        }
      })
    };
  };

  // Q1. the fence and the method gate, before any body is trusted.
  try {
    const call = await mount(makeCredentials(null), { registerProvider: true });
    const foreign = await call(MODELS_PATH, makePost({ enabledModelIds: [] }, { origin: "https://evil.test" }));
    check("Q1 a cross-origin save is refused",
      foreign.statusCode === 403 && foreign.payload.ok === false, JSON.stringify(foreign.payload));
    const get = await call(MODELS_PATH, makeRequest());
    check("Q1 GET is not an allowed method here",
      get.statusCode === 405 && get.payload.ok === false, JSON.stringify(get.payload));
  } catch (error) { fail("Q1: the roster route fence", error); }

  // Q2-Q7. with a real session, a catalog, and an llm service.
  try {
    const credentials = makeCredentials(storedGrant(jwtExpiring(120), "r", 7200));
    credentials.refs.set("SENSENOVA_API_KEY", "sk-roster");
    const llm = makeFakeLlm();
    const adapterDeps = makeFakeAdapterDeps();
    const net = await loginNetwork();
    await withNetwork(async (url, init) => {
      const target = String(url);
      if (target.includes("/v1/models") || target.includes("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "SenseNova-Lite", input_modalities: ["text"] },
            { id: "SenseNova-Vision", input_modalities: ["text", "image"] },
            { id: "SenseNova-Pro", input_modalities: ["text"] }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return net(url, init);
    }, async () => {
      const call = await mount(credentials, { registerProvider: true }, {
        llm, ...adapterDeps, emit: () => {}
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The state file is shared across the whole suite, so the panel switch
      // may still be off from group P: turn it on the way a panel would.
      const enableSwitch = await call(PROVIDER_PATH, makePost({ enabled: true }));
      check("Q2 the panel switch can be turned on in the same session",
        enableSwitch.statusCode === 200 && enableSwitch.payload.ok === true &&
          enableSwitch.payload.registerProvider === true, JSON.stringify(enableSwitch.payload));

      // Q2. The picker's own read: the snapshot hands the roster to it.
      // Rows carry the per-model availability markers (ROADMAP §2.2): the
      // panel shows every chat model, greyed with the reason when its pool
      // is exhausted, so `available`/`quotaExhausted` travel even when true.
      // `contextWindow` rides too: the catalog stub declares no context
      // field, so every row carries `contextWindowOf`'s 128k fallback.
      // `maxOutputLength` is 0 (nothing declared); `multiplier: 1` rides
      // because the DEFAULT trendMultipliers match "sensenova" — the same
      // pseudo rate the trend rows would get, one matcher for both.
      // `thinkingLevels` is the proven-only set: these fake-catalog ids are
      // not in the probe table (PROBED_EFFORT), so no level beyond the
      // platform default rides — the roster quotes off/高 and nothing the
      // platform never answered 200 for on THIS id.
      const snapshot = await call(SNAPSHOT_PATH, makeRequest());
      check("Q2 the snapshot hands the picker the whole roster with a vision verdict",
        JSON.stringify(snapshot.payload.llm?.models) === JSON.stringify([
          { id: "SenseNova-Lite", name: "SenseNova-Lite", vision: false, available: true, quotaExhausted: false, contextWindow: 128000, maxOutputLength: 0, thinkingLevels: ["off", "high"], multiplier: 1 },
          { id: "SenseNova-Vision", name: "SenseNova-Vision", vision: true, available: true, quotaExhausted: false, contextWindow: 128000, maxOutputLength: 0, thinkingLevels: ["off", "high"], multiplier: 1 },
          { id: "SenseNova-Pro", name: "SenseNova-Pro", vision: false, available: true, quotaExhausted: false, contextWindow: 128000, maxOutputLength: 0, thinkingLevels: ["off", "high"], multiplier: 1 }
        ]), JSON.stringify(snapshot.payload.llm?.models));
      check("Q2 the snapshot quotes the profile's pinned thinking default",
        snapshot.payload.llm?.thinkingDefault === "high",
        String(snapshot.payload.llm?.thinkingDefault));
      check("Q2 an uncurated install reports an empty allow-list",
        JSON.stringify(snapshot.payload.llm?.enabledModelIds) === JSON.stringify([]),
        JSON.stringify(snapshot.payload.llm?.enabledModelIds));
      check("Q2 an empty allow-list still offers every model",
        snapshot.payload.llm?.modelCount === 3 && snapshot.payload.llm?.visionCount === 1,
        JSON.stringify({ m: snapshot.payload.llm?.modelCount, v: snapshot.payload.llm?.visionCount }));

      // Q3. Save a curation: it publishes immediately, with the new list.
      const buildCount = adapterDeps.builds.length;
      const save = await call(MODELS_PATH, makePost({ enabledModelIds: ["SenseNova-Vision"] }));
      check("Q3 a save reports the saved allow-list",
        save.statusCode === 200 && save.payload.ok === true &&
          JSON.stringify(save.payload.enabledModelIds) === JSON.stringify(["SenseNova-Vision"]),
        JSON.stringify(save.payload));
      check("Q3 the offer was republished on the request that carried the save",
        adapterDeps.builds.length === buildCount + 1 &&
          JSON.stringify(adapterDeps.builds.at(-1).enabledIds) === JSON.stringify(["SenseNova-Vision"]),
        JSON.stringify({ builds: adapterDeps.builds.length, ids: adapterDeps.builds.at(-1)?.enabledIds }));

      // Q4. The poll after the save sees the curation without a fresh catalog.
      const poll = await call(SNAPSHOT_PATH, makeRequest());
      check("Q4 the poll reports the curation",
        JSON.stringify(poll.payload.llm?.enabledModelIds) === JSON.stringify(["SenseNova-Vision"]),
        JSON.stringify(poll.payload.llm?.enabledModelIds));
      check("Q4 the offer is narrowed to the ticked model",
        poll.payload.llm?.modelCount === 1 && poll.payload.llm?.visionCount === 1,
        JSON.stringify({ m: poll.payload.llm?.modelCount, v: poll.payload.llm?.visionCount }));
      check("Q4 the poll still shows the WHOLE roster",
        JSON.stringify(poll.payload.llm?.models.map((model) => model.id)) ===
          JSON.stringify(["SenseNova-Lite", "SenseNova-Vision", "SenseNova-Pro"]),
        JSON.stringify(poll.payload.llm?.models));

      // Q5. The signature handoff: a poll that brings the same catalogue and
      // the same allow-list must not rebuild the provider.
      const settled = adapterDeps.builds.length;
      await call(SNAPSHOT_PATH, makeRequest());
      await call(SNAPSHOT_PATH, makeRequest());
      check("Q5 a save does not turn every later poll into a republish",
        adapterDeps.builds.length === settled,
        `${settled} -> ${adapterDeps.builds.length}`);

      // Q6. The sentinel: "temporarily push no models at all" must be
      // expressible, which an empty list cannot mean.
      const hide = await call(MODELS_PATH, makePost({ enabledModelIds: ["__hide_all__"] }));
      check("Q6 the hide-all sentinel is accepted and reported",
        hide.payload.ok === true && JSON.stringify(hide.payload.enabledModelIds) === JSON.stringify(["__hide_all__"]),
        JSON.stringify(hide.payload));
      check("Q6 the offer collapses to nothing",
        JSON.stringify(adapterDeps.builds.at(-1).enabledIds) === JSON.stringify(["__hide_all__"]),
        JSON.stringify(adapterDeps.builds.at(-1)?.enabledIds));
      const hidden = await call(SNAPSHOT_PATH, makeRequest());
      check("Q6 the snapshot counts zero registered models",
        hidden.payload.llm?.modelCount === 0 && hidden.payload.llm?.visionCount === 0,
        JSON.stringify({ m: hidden.payload.llm?.modelCount, v: hidden.payload.llm?.visionCount }));
      check("Q6 the roster itself is still complete",
        hidden.payload.llm?.models.length === 3, String(hidden.payload.llm?.models?.length));

      // Q7. Junk bodies are refused before anything is written.
      const missing = await call(MODELS_PATH, makePost({}));
      check("Q7 a missing field is refused, not read as 'all models'",
        missing.statusCode === 400 && missing.payload.ok === false, JSON.stringify(missing.payload));
      const wrong = await call(MODELS_PATH, makePost({ enabledModelIds: "SenseNova-Lite" }));
      check("Q7 a non-array field is refused",
        wrong.statusCode === 400 && wrong.payload.ok === false, JSON.stringify(wrong.payload));
      const junk = await call(MODELS_PATH, makePost({ enabledModelIds: "not json" }));
      check("Q7 an unreadable body is refused",
        junk.statusCode === 400 && junk.payload.ok === false, JSON.stringify(junk.payload));
      const tooLong = await call(MODELS_PATH,
        makePost({ enabledModelIds: Array.from({ length: 501 }, (_, index) => `m${index}`) }));
      check("Q7 an oversized allow-list is refused",
        tooLong.statusCode === 400 && JSON.stringify(tooLong.payload).includes("too long"),
        JSON.stringify(tooLong.payload));
      check("Q7 nothing was written by the refused bodies",
        JSON.stringify(adapterDeps.builds.at(-1).enabledIds) === JSON.stringify(["__hide_all__"]),
        JSON.stringify(adapterDeps.builds.at(-1)?.enabledIds));

      // Q8. Curation survives a remount (the same state file as the switch).
      const call2 = await mount(makeCredentials(storedGrant(jwtExpiring(120), "r", 7200)),
        { registerProvider: true }, { llm: makeFakeLlm(), ...makeFakeAdapterDeps(), emit: () => {} });
      const persisted = await call2(SNAPSHOT_PATH, makeRequest());
      check("Q8 the curation outlives one Host process",
        JSON.stringify(persisted.payload.llm?.enabledModelIds) === JSON.stringify(["__hide_all__"]),
        JSON.stringify(persisted.payload.llm?.enabledModelIds));

      // Q9. Forgetting the key also forgets the curation: a new key starts
      // uncurated, not under a filter the previous key's owner set.
      await call(MODELS_PATH, makePost({ enabledModelIds: ["SenseNova-Lite"] }));
      await call(API_KEY_PATH, makePost({ forget: true }));
      const after = await call(SNAPSHOT_PATH, makeRequest());
      check("Q9 forgetting the key clears the curation with it",
        JSON.stringify(after.payload.llm?.enabledModelIds) === JSON.stringify([]),
        JSON.stringify(after.payload.llm?.enabledModelIds));
    });
  } catch (error) { fail("Q: the model roster route", error); }
}

// === R. the draw switch route: the panel value beats the config default ====
// Same discipline as group P (the provider switch): a value saved from the
// panel lives in the plugin's own state file and wins over the patch's
// `drawEnabled`; a POST lands without a restart. The draw tool itself still
// needs the Host's tools service, but the SWITCH state is plain state — this
// group proves the round trip and the persistence across remounts.
{
  try {
    const credentials = makeCredentials(null);
    const call = await mount(credentials);

    const initial = await call(DRAW_PATH, makeRequest());
    check("R1 GET reports the config default with source config",
      initial.payload.ok === true && initial.payload.drawEnabled === false &&
        initial.payload.drawSource === "config", JSON.stringify(initial.payload));

    const bad = await call(DRAW_PATH, makePost({ enabled: "yes" }));
    check("R2 a non-boolean enabled is refused",
      bad.statusCode === 400 && bad.payload.ok === false, JSON.stringify(bad.payload));

    const on = await call(DRAW_PATH, makePost({ enabled: true }));
    check("R3 POST saves the panel value and reports it as source panel",
      on.payload.ok === true && on.payload.drawEnabled === true &&
        on.payload.drawSource === "panel", JSON.stringify(on.payload));

    // A second mount (fresh plugin instance, same state file) must read the
    // persisted switch — the value outlives one Host process.
    const call2 = await mount(credentials);
    const again = await call2(DRAW_PATH, makeRequest());
    check("R4 the panel value survives a remount",
      again.payload.drawEnabled === true && again.payload.drawSource === "panel",
      JSON.stringify(again.payload));

    const off = await call2(DRAW_PATH, makePost({ enabled: false }));
    check("R5 switching off reports the off state with source panel",
      off.payload.ok === true && off.payload.drawEnabled === false &&
        off.payload.drawSource === "panel", JSON.stringify(off.payload));

    // Forget the panel value so R6 can exercise the "untouched state file"
    // path: without this, R3's save would still be sitting in the shared
    // state file and R6 would read source "panel" instead of "config".
    const forget = await call2(DRAW_PATH, makePost({ forget: true }));
    check("R5b forgetting the panel value returns to the config default",
      forget.payload.ok === true && forget.payload.drawSource === "config",
      JSON.stringify(forget.payload));

    // A config-driven deployment keeps its operator decision when the panel
    // has never written a value: mount with `drawEnabled: true` in the patch
    // and GET the /draw route — source must say "config".
    const call3 = await mount(credentials, { drawEnabled: true });
    const configBacked = await call3(DRAW_PATH, makeRequest());
    check("R6 an untouched state file falls back to the config value",
      configBacked.payload.drawEnabled === true && configBacked.payload.drawSource === "config",
      JSON.stringify(configBacked.payload));
    // A panel-saved value still beats the config in the same room.
    const flipped = await call3(DRAW_PATH, makePost({ enabled: false }));
    check("R7 a panel save overrides the config default",
      flipped.payload.drawEnabled === false && flipped.payload.drawSource === "panel",
      JSON.stringify(flipped.payload));

    // The trust fence: a foreign page cannot flip the switch.
    const foreign = await call(DRAW_PATH, makePost({ enabled: true }, { origin: "https://evil.test" }));
    check("R8 a cross-origin draw POST is refused",
      foreign.statusCode === 403 && foreign.payload.ok === false, JSON.stringify(foreign.payload));
  } catch (error) { fail("R: the draw switch route", error); }
}

// === S. the /raccoon 401 diagnostics are opt-in (`?debug=1`) ==================
// The six diagnostic fields were the instrumentation for the Raccoon 401
// root-cause fix (Bearer dual-shape + the pre-read renewal gate + `/refresh`).
// The fix landed and the scaffold stayed, while nothing in the client ever read
// them — and one of them, `hostProxyEnv`, reports environment VALUES. This
// group pins the retirable shape: an ordinary poll must not carry them, an
// explicit `?debug=1` may, a POST's re-reported state must not, and a proxy
// URL's userinfo never leaves the process either way.
//
// This is also the FIRST route-level coverage the `/raccoon` handler has: the
// suite drove snapshot/account/api-key/provider/models/draw only, which is why
// the scaffold could sit on every response unnoticed.
{
  try {
    const DIAGNOSTIC_KEYS = [
      "accessTokenPrefix", "credentialSource", "raccoonEnvShadow",
      "envCredentialFingerprint", "accessTokenFingerprint", "hostProxyEnv"
    ];
    const carried = (payload) => DIAGNOSTIC_KEYS.filter((key) => Object.hasOwn(payload, key));
    const call = await mount(makeCredentials(null));

    const plain = await call(RACCOON_PATH, makeRequest());
    check("S1 an ordinary raccoon GET carries none of the diagnostics",
      plain.payload.ok === true && carried(plain.payload).length === 0,
      JSON.stringify(carried(plain.payload)));

    const debug = await call(RACCOON_PATH, { ...makeRequest(), url: `${RACCOON_PATH}?debug=1` });
    check("S2 `?debug=1` opts the triage scaffold back in",
      debug.payload.raccoonEnvShadow === false && Array.isArray(debug.payload.hostProxyEnv),
      JSON.stringify({ shadow: debug.payload.raccoonEnvShadow, proxy: debug.payload.hostProxyEnv }));

    // `?debug=0` (and any other spelling) must stay quiet: the flag is opt-in,
    // not a knob that is "on unless zero".
    const zero = await call(RACCOON_PATH, { ...makeRequest(), url: `${RACCOON_PATH}?debug=0` });
    check("S3 only `1`/`true` count as opt-in",
      carried(zero.payload).length === 0, JSON.stringify(carried(zero.payload)));

    // The whole reason the gate exists: these are environment values, and a
    // corporate proxy is routinely spelled `http://user:pass@proxy:8080`.
    const PROXY_KEY = "HTTP_PROXY";
    const before = process.env[PROXY_KEY];
    process.env[PROXY_KEY] = "http://alice:s3cr3t@proxy.test:8080";
    try {
      const withProxy = await call(RACCOON_PATH, { ...makeRequest(), url: `${RACCOON_PATH}?debug=1` });
      const line = (withProxy.payload.hostProxyEnv ?? []).find((entry) => entry.startsWith(`${PROXY_KEY}=`)) ?? "";
      check("S4 a proxy URL's userinfo never leaves the process",
        line.includes("proxy.test:8080") && !line.includes("s3cr3t") && !line.includes("alice"), line);
    } finally {
      if (before === undefined) delete process.env[PROXY_KEY];
      else process.env[PROXY_KEY] = before;
    }

    // A POST re-reports the same state through `answer()`; the scaffold must
    // not ride along on a mutation's answer.
    const posted = await call(RACCOON_PATH, makePost({ action: "models", enabledModelIds: [] }));
    check("S5 a POST's re-reported state carries none either",
      posted.payload.ok === true && carried(posted.payload).length === 0,
      JSON.stringify(carried(posted.payload)));
  } catch (error) { fail("S: the raccoon diagnostics gate", error); }
}

// === T. the QR login answers at once, and one gateway read serves many polls =
// The login walk used to BE the HTTP request: the POST blocked for up to five
// minutes while the client ran its own 150 × 2 s poll beside it, so one scan
// cost the gateway hundreds of reads for a balance that cannot move that fast.
// Now the POST answers the moment the scan is issued, the walk runs behind it,
// and the gateway reads are coalesced. This group pins all three halves — the
// one a user sees (a button that answers), the one that silently doubled
// (a second click issuing a second scan), and the one that was amplifying
// traffic by two orders of magnitude.
{
  /** A minimal `Response` face: the parsers read `.ok` / `.status` / `.json()`. */
  const jsonResponse = (body) => ({
    ok: true,
    status: 200,
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  });
  /** A JWT whose `exp` is `minutes` out, so the store never sees it lapsed. */
  const raccoonJwt = (minutes) =>
    `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + minutes * 60, name: "tester" })).toString("base64url")}.sig`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const TOKEN = raccoonJwt(60);
  let polls = 0;
  let balanceCalls = 0;
  let releaseFirstPoll = null;
  const guard = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.includes("login_with_qrcode_code")) {
      polls += 1;
      if (polls === 1) {
        // Hold the FIRST poll so the walk is provably in flight when the second
        // POST arrives — that suspended call is the concurrency gate's window.
        // It then answers SUCCESS, so the walk settles without sleeping through
        // its 2 s cadence (a leftover walk would keep the process alive).
        await new Promise((resolve) => { releaseFirstPoll = resolve; });
        return jsonResponse({ code: 0, data: { status: "success", access_token: TOKEN, refresh_token: "refresh-1" } });
      }
      return jsonResponse({ code: 0, data: { status: "pending" } });
    }
    if (url.includes("/points/v1/balance")) {
      balanceCalls += 1;
      return jsonResponse({ code: 0, data: { available_points: 300 } });
    }
    if (url.includes("/model_catalog")) {
      return jsonResponse({ code: 0, data: { categories: [{ type: "chat", models: [{ id: "sn-live", name: "Live", visible: true }] }] } });
    }
    if (url.includes("/refresh")) {
      return jsonResponse({ code: 0, data: { access_token: TOKEN, refresh_token: "refresh-2" } });
    }
    throw new Error(`unstubbed raccoon request: ${url}`);
  };

  try {
    const call = await mount(makeCredentials(null));

    // ── T1: the request is short again ──
    const started = Date.now();
    const first = await call(RACCOON_PATH, makePost({ action: "login" }));
    const elapsedMs = Date.now() - started;
    const code1 = first.payload?.scanCode ?? null;
    check("T1 the login POST answers when the scan is issued, not when it settles",
      first.payload?.ok === true && first.payload?.loginStatus === "scanning"
        && typeof code1 === "string" && code1 !== "" && elapsedMs < 1000,
      JSON.stringify({ ok: first.payload?.ok, status: first.payload?.loginStatus, elapsedMs }));

    // ── T2: one walk at a time ──
    // A second click (or a second tab) mid-walk must not issue a second scan:
    // the GET can only ever report one code, so the QR on screen would stop
    // matching the one being polled — a scan that looks stuck with no error.
    const second = await call(RACCOON_PATH, makePost({ action: "login" }));
    check("T2 a login while a walk is in flight re-issues the SAME scan",
      second.payload?.ok === true && second.payload?.scanCode === code1,
      JSON.stringify({ first: code1, second: second.payload?.scanCode }));

    // ── T3/T4: the outcome is an event, delivered once ──
    for (let i = 0; i < 20 && releaseFirstPoll === null; i += 1) await sleep(10);
    releaseFirstPoll?.();
    let settled = null;
    for (let i = 0; i < 40 && settled === null; i += 1) {
      const body = (await call(RACCOON_PATH, makeRequest())).payload;
      if (typeof body?.loginStatus === "string" && body.loginStatus !== "scanning") settled = body;
      else await sleep(25);
    }
    check("T3 the settled walk reports `logged_in` and the credential landed",
      settled !== null && settled.loginStatus === "logged_in" && settled.loggedIn === true,
      JSON.stringify(settled === null ? null : { status: settled.loginStatus, loggedIn: settled.loggedIn }));
    const after = (await call(RACCOON_PATH, makeRequest())).payload;
    check("T4 a terminal login outcome is delivered once, then cleared",
      Object.hasOwn(after, "loginStatus") === false, JSON.stringify(after.loginStatus ?? null));

    // ── T5: the fast poll no longer amplifies into gateway traffic ──
    // This is the whole point: during a scan the tab polls every 2 s, and each
    // of those used to cost a balance read AND a catalogue read.
    const before = balanceCalls;
    for (let i = 0; i < 5; i += 1) await call(RACCOON_PATH, makeRequest());
    const last = (await call(RACCOON_PATH, makeRequest())).payload;
    check("T5 five more polls inside the TTL cost no further balance read",
      balanceCalls - before === 0 && last?.balance === 300,
      JSON.stringify({ calls: balanceCalls - before, balance: last?.balance }));

    // ── T6: concurrent polls share one flight (a fresh cache, signed in) ──
    const signedIn = await mount(makeCredentials(null, {
      refs: {
        [RACCOON_CREDENTIAL_REF]: serializeRaccoonCredential({
          accessToken: TOKEN, refreshToken: "refresh-3", expiresAtMs: Date.now() + 3600_000
        })
      }
    }));
    const before2 = balanceCalls;
    const [left, right] = await Promise.all([
      signedIn(RACCOON_PATH, makeRequest()),
      signedIn(RACCOON_PATH, makeRequest())
    ]);
    check("T6 two concurrent polls share ONE balance read (single flight)",
      balanceCalls - before2 === 1 && left.payload?.balance === 300 && right.payload?.balance === 300,
      JSON.stringify({ calls: balanceCalls - before2, left: left.payload?.balance, right: right.payload?.balance }));
  } catch (error) { fail("T: the raccoon login walk and its read cache", error); } finally {
    globalThis.fetch = guard;
  }
}

// The Host routes are exercised against a stubbed console; nothing here may
// reach the real one. See the same guard in test/auth.test.mjs.
const unstubbed = releaseNetworkGuard();
restoreHostEnv();
check("no check escaped its stub to the network", unstubbed.length === 0, unstubbed.join(", "));

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

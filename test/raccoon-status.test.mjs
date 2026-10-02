/**
 * Unit checks for the Raccoon tab's READ MODEL (`raccoon-status.ts`).
 *
 * This is the layer that used to be a 190-line closure inside the `/raccoon`
 * HTTP handler, so the only thing pinning it was `test/routes.test.mjs` driving
 * the mounted route through a stub gateway. Everything that made the closure
 * hard to reach — the eager-refresh gate, the cache keys, the `ModelsSource`
 * tri-state, the `?debug=1` scaffold, the "read the terminal event BEFORE any
 * await" ordering the T3 fix depends on — becomes a direct, peer-free
 * assertion once the module takes its stores as arguments, which is the whole
 * point of the extraction.
 *
 * Peer-free like `raccoon.test.mjs`: no Host peer, no route, no network (the
 * one group that exercises the real coalescing cache serves its own fetch).
 */
import {
  readRaccoonStatus,
  tokenFingerprint,
  maskProxyUserinfo,
  RACCOON_BALANCE_TTL_MS,
  RACCOON_CATALOG_TTL_MS
} from "../src/host/raccoon-status.ts";
import { createCoalescedFetch, clearCoalescedFetch } from "../src/host/coalesced-fetch.ts";
import { optional } from "../src/host/util.ts";
import { RACCOON_API_BASE, RACCOON_POINTS_PREFIX, RACCOON_FALLBACK_MODELS, RACCOON_QR_POLL_INTERVAL_MS } from "../src/host/raccoon.ts";
import { installNetworkGuard } from "./peer-roots.mjs";
import { surface } from "./client-surface.js";
import { statedCadenceMs } from "../src/client/format.ts";
import { readFileSync } from "node:fs";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

// --- fixtures ---------------------------------------------------------------
// A realistic-length token: a real one is a long JWT, and the point of the
// prefix diagnostic is that 8 characters of it are useless on their own.
const TOKEN = `eyJhbGciOiJIUzI1NiJ9.${"x".repeat(240)}`;

const NOW = Date.now();

function fakeStore(overrides = {}) {
  const calls = { state: 0, isExpired: 0, refresh: 0, resolve: 0 };
  const base = {
    calls,
    async state() {
      calls.state += 1;
      return {
        hasCredential: true,
        nickname: "鲸鱼",
        source: "file",
        expiresAtMs: NOW + 3_600_000,
        refreshExpiresAtMs: NOW + 30 * 86_400_000
      };
    },
    async isExpired() {
      calls.isExpired += 1;
      return false;
    },
    async refresh() {
      calls.refresh += 1;
    },
    async resolve() {
      calls.resolve += 1;
      return { credential: { accessToken: TOKEN, officeIdentity: "office-1" } };
    }
  };
  return Object.assign(base, overrides);
}

function fakeSwitch({ enabled = true, ids = null } = {}) {
  return { enabled: async () => enabled, enabledIds: async () => ids };
}

/** A login view that hands back a fixed outcome and counts the hand-over. */
function fakeLogin({ status = null, error = null, scan = null } = {}) {
  const seen = { takeEvent: 0 };
  return {
    seen,
    view: {
      takeEvent: () => {
        seen.takeEvent += 1;
        return { status, error };
      },
      liveScan: () => scan
    }
  };
}

/**
 * A cache stub that records the (key, ttl) contract and answers from a table
 * keyed by the key's family (`balance` / `catalog`). A table entry that is a
 * function is called, so a rejection can be injected without a network.
 */
function stubRead(table = {}) {
  const calls = [];
  return {
    calls,
    async read(key, producer, ttlMs) {
      calls.push({ key, ttlMs });
      const hit = table[key.slice(0, key.indexOf(":"))];
      if (hit === undefined || hit === null) return null;
      return typeof hit === "function" ? hit() : hit;
    }
  };
}

function deps({ store = fakeStore(), login = fakeLogin(), read = stubRead(), publisher = null, switchStore = fakeSwitch() } = {}) {
  return { store, switchStore, publisher, read, login: login.view };
}

const BALANCE_HIT = { total: 1234, daily: 0, reward: 5, monthly: undefined, topup: undefined };
const CATALOG_HIT = [{ id: "sn-live-1", name: "Live One" }];

// === A. the two moved helpers ==============================================
try {
  const a = tokenFingerprint(TOKEN);
  const b = tokenFingerprint(TOKEN);
  const c = tokenFingerprint(`${TOKEN}y`);
  check("A1 the fingerprint is a stable 12-hex digest", a === b && /^[0-9a-f]{12}$/.test(a), a);
  check("A1 a different token gives a different fingerprint", a !== c, `${a} vs ${c}`);
  check("A1 the fingerprint carries no part of the token", !TOKEN.includes(a) && a !== TOKEN.slice(0, 12), a);
  check("A1 a non-string token still fingerprints (no throw)", /^[0-9a-f]{12}$/.test(tokenFingerprint(undefined)));

  check("A2 userinfo is masked and the hop still reads",
    maskProxyUserinfo("HTTPS_PROXY", "http://user:secret@proxy:8080") === "HTTPS_PROXY=http://***@proxy:8080",
    maskProxyUserinfo("HTTPS_PROXY", "http://user:secret@proxy:8080"));
  check("A2 a scheme-less userinfo is masked too",
    maskProxyUserinfo("HTTP_PROXY", "//user:secret@proxy:8080") === "HTTP_PROXY=//***@proxy:8080",
    maskProxyUserinfo("HTTP_PROXY", "//user:secret@proxy:8080"));
  check("A2 a value with no userinfo passes through untouched",
    maskProxyUserinfo("NO_PROXY", "localhost,127.0.0.1") === "NO_PROXY=localhost,127.0.0.1");
  check("A2 a path-borne `@` is not mistaken for userinfo",
    maskProxyUserinfo("NO_PROXY", "http://proxy:8080/a@b") === "NO_PROXY=http://proxy:8080/a@b");
  check("A2 an unparseable value is masked textually",
    maskProxyUserinfo("ALL_PROXY", "garbage@thing") === "ALL_PROXY=***@thing",
    maskProxyUserinfo("ALL_PROXY", "garbage@thing"));
} catch (error) {
  fail("A: the moved helpers", error);
}

// === A2. `optional`, the guard this extraction brought into the open =======
try {
  check("A2 an absent call (a bare null) reads as no answer, not a throw",
    (await optional(null)) === null);
  check("A2 a rejected call reads as no answer",
    (await optional(Promise.reject(new Error("peer gone")))) === null);
  check("A2 a fulfilled call passes its value through",
    (await optional(Promise.resolve(7))) === 7);
  check("A2 a non-promise value passes through too",
    (await optional("raw")) === "raw");
  check("A2 a rejected call yields the provided fallback, not null",
    (await optional(Promise.reject(new Error("x")), "fallback")) === "fallback");
  check("A2 a fulfilled call ignores the fallback",
    (await optional(Promise.resolve(7), -1)) === 7);
  // The exact shape it replaces: the guard must sit where the crash was.
  const absent = null;
  let threw = false;
  try {
    // eslint-disable-next-line no-unused-expressions
    (absent ? absent.enabled() : null).catch(() => null);
  } catch {
    threw = true;
  }
  check("A2 the old shape still throws on an absent store (which is why it went)",
    threw, "the anti-pattern was expected to throw here");
} catch (error) {
  fail("A2: optional", error);
}

// === B. the login event contract ===========================================
try {
  // B1 — the ordering the T3 bug fix depends on. The store read is what takes
  // time, so if the event were read after it a settled walk could publish a
  // terminal status beside a `loggedIn` that predates it.
  {
    const order = [];
    const store = fakeStore({
      async state() {
        order.push("store.state");
        return { hasCredential: true, nickname: "", source: "file" };
      }
    });
    const login = fakeLogin();
    const view = { takeEvent: () => { order.push("takeEvent"); return login.view.takeEvent(); }, liveScan: () => null };
    await readRaccoonStatus({ store, switchStore: null, publisher: null, read: stubRead(), login: view });
    check("B1 the event is taken BEFORE the first store read", order[0] === "takeEvent", order.join(" → "));
  }
  {
    const { view, seen } = fakeLogin({ status: "logged_in" });
    const answer = await readRaccoonStatus(deps({ login: { view } }));
    check("B2 a terminal outcome is reported in the answer", answer.loginStatus === "logged_in", JSON.stringify(answer.loginStatus));
    check("B2 the view is asked exactly once per read", seen.takeEvent === 1, String(seen.takeEvent));
  }
  {
    const answer = await readRaccoonStatus(deps({ login: fakeLogin({ status: "timeout", error: "scan expired" }) }));
    check("B2 a failed walk's reason rides along", answer.loginError === "scan expired", JSON.stringify(answer.loginError));
  }
  {
    // A `scanning` status is the live state of an in-flight walk, and the scan
    // it issued must ride with it or the tab has no QR to render.
    const scan = { code: "abc123", url: "https://example.invalid/qr/abc123" };
    const answer = await readRaccoonStatus(deps({ login: fakeLogin({ status: "scanning", scan }) }));
    check("B3 a pending scan is reported with its status",
      answer.loginStatus === "scanning" && answer.scanUrl === scan.url && answer.scanCode === scan.code,
      JSON.stringify({ s: answer.loginStatus, u: answer.scanUrl }));
  }
  {
    const answer = await readRaccoonStatus(deps({ login: fakeLogin({ status: "scanning" }) }));
    check("B4 no scan means no scan keys at all",
      !("scanUrl" in answer) && !("scanCode" in answer), Object.keys(answer).join(","));
  }
} catch (error) {
  fail("B: the login event contract", error);
}

// === B2. the tab's cadence is STATED, not guessed ==========================
// The client used to hold `RACCOON_POLL_MS = 60_000` / `RACCOON_SCAN_POLL_MS
// = 2_000` while this module held the same two numbers as cache windows
// (`RACCOON_BALANCE_TTL_MS`, and the route's `RACCOON_QR_POLL_INTERVAL_MS`).
// One knob, two homes, and nothing able to see them drift — the anti-
// redeclaration check in `raccoon.test.mjs` reads only `src/host/routes.ts`,
// so a client-side copy was outside its reach by construction. The route now
// states the cadence in its own answer, and these checks pin the statement to
// the numbers that actually govern the caching.
try {
  const answer = await readRaccoonStatus(deps({ read: stubRead({ balance: BALANCE_HIT, catalog: CATALOG_HIT }) }));
  check("B5 the answer states the tab's idle cadence in seconds",
    answer.pollSeconds === RACCOON_BALANCE_TTL_MS / 1000,
    `${answer.pollSeconds} vs TTL ${RACCOON_BALANCE_TTL_MS}`);
  check("B6 the answer states the scan cadence, equal to the route's own QR poll",
    answer.scanPollSeconds === RACCOON_QR_POLL_INTERVAL_MS / 1000,
    `${answer.scanPollSeconds} vs ${RACCOON_QR_POLL_INTERVAL_MS}`);
  check("B7 the stated cadence survives the client's converter unchanged",
    statedCadenceMs(answer.pollSeconds, 1) === RACCOON_BALANCE_TTL_MS
      && statedCadenceMs(answer.scanPollSeconds, 1) === RACCOON_QR_POLL_INTERVAL_MS,
    `${statedCadenceMs(answer.pollSeconds, 1)} / ${statedCadenceMs(answer.scanPollSeconds, 1)}`);
  // The old converter clamped to a 5 s floor, which silently rewrote the 2 s
  // scan cadence into 5 s — a client-side opinion overriding the number the
  // Host states (and the Host already clamps its own config at the source).
  // The check is explicit about the sub-floor value so the clamp cannot come
  // back unnoticed, and about a malformed one so the fallback still works.
  check("B7b a stated cadence below the old floor is passed through, not clamped",
    statedCadenceMs(2, 60_000) === 2_000 && statedCadenceMs(0.5, 7_000) === 1_000,
    `${statedCadenceMs(2, 60_000)} / ${statedCadenceMs(0.5, 7_000)}`);
  check("B7c a missing or malformed cadence falls back instead of inventing one",
    statedCadenceMs(undefined, 60_000) === 60_000 && statedCadenceMs(Number.NaN, 2_000) === 2_000
      && statedCadenceMs("30", 60_000) === 60_000 && statedCadenceMs(0, 60_000) === 60_000,
    `${statedCadenceMs(undefined, 60_000)} / ${statedCadenceMs(Number.NaN, 2_000)} / ${statedCadenceMs("30", 60_000)} / ${statedCadenceMs(0, 60_000)}`);
  // The two built-in fallbacks are what the first frame uses before any answer
  // has arrived, so they must equal the values the Host is expected to state —
  // otherwise the tab's opening seconds poll at a rate the Host never asked
  // for. Pinned to the shipped constants through the bundle's own surface.
  check("B8 the tab's pre-answer fallbacks match the Host's own windows",
    surface.helpers.RACCOON_POLL_MS === RACCOON_BALANCE_TTL_MS
      && surface.helpers.RACCOON_SCAN_POLL_MS === RACCOON_QR_POLL_INTERVAL_MS,
    `${surface.helpers.RACCOON_POLL_MS} / ${surface.helpers.RACCOON_SCAN_POLL_MS}`);
} catch (error) {
  fail("B2: the stated cadence", error);
}

// === C. the ?debug=1 scaffold ==============================================
const TRIAGE_KEYS = ["accessTokenPrefix", "credentialSource", "envCredentialFingerprint", "accessTokenFingerprint", "hostProxyEnv"];
try {
  {
    const answer = await readRaccoonStatus(deps({ read: stubRead({ balance: BALANCE_HIT, catalog: CATALOG_HIT }) }));
    check("C1 an ordinary read carries none of the triage keys",
      TRIAGE_KEYS.every((key) => !(key in answer)) && !("raccoonEnvShadow" in answer),
      Object.keys(answer).join(","));
  }
  {
    const answer = await readRaccoonStatus(deps({ read: stubRead({ balance: BALANCE_HIT, catalog: CATALOG_HIT }) }), true);
    check("C2 an opted-in read carries the scaffold",
      answer.credentialSource === "file" && typeof answer.raccoonEnvShadow === "boolean" && Array.isArray(answer.hostProxyEnv),
      JSON.stringify({ src: answer.credentialSource, shadow: answer.raccoonEnvShadow }));
    check("C2 the token prefix is a prefix, never the token",
      answer.accessTokenPrefix === TOKEN.slice(0, 8) && answer.accessTokenPrefix.length === 8,
      String(answer.accessTokenPrefix));
    check("C2 the token fingerprint is a 12-hex identifier",
      /^[0-9a-f]{12}$/.test(answer.accessTokenFingerprint), String(answer.accessTokenFingerprint));
    check("C2 no diagnostic leaks the access token",
      !JSON.stringify(answer).includes(TOKEN), "the token appeared in the answer");
  }
  {
    // A proxy password must never reach the response, and the shadowing
    // credential must be fingerprinted rather than quoted.
    const hadProxy = Object.hasOwn(process.env, "HTTPS_PROXY");
    const hadShadow = Object.hasOwn(process.env, "RACCOON_CREDENTIAL");
    const priorProxy = process.env.HTTPS_PROXY;
    const priorShadow = process.env.RACCOON_CREDENTIAL;
    process.env.HTTPS_PROXY = "http://user:sup3rsecret@proxy:8080";
    process.env.RACCOON_CREDENTIAL = "serialized-shadow-document";
    try {
      const answer = await readRaccoonStatus(deps(), true);
      const payload = JSON.stringify(answer);
      check("C4 a proxy password is masked on the way out",
        answer.hostProxyEnv.includes("HTTPS_PROXY=http://***@proxy:8080") && !payload.includes("sup3rsecret"),
        JSON.stringify(answer.hostProxyEnv));
      check("C4 a shadowing credential is reported as a fingerprint",
        answer.raccoonEnvShadow === true && /^[0-9a-f]{12}$/.test(answer.envCredentialFingerprint) && !payload.includes("serialized-shadow-document"),
        String(answer.envCredentialFingerprint));
    } finally {
      if (hadProxy) process.env.HTTPS_PROXY = priorProxy; else delete process.env.HTTPS_PROXY;
      if (hadShadow) process.env.RACCOON_CREDENTIAL = priorShadow; else delete process.env.RACCOON_CREDENTIAL;
    }
  }
} catch (error) {
  fail("C: the ?debug=1 scaffold", error);
}

// === D. balance ============================================================
try {
  {
    const answer = await readRaccoonStatus(deps({ read: stubRead({ balance: BALANCE_HIT }) }));
    check("D1 the total comes through", answer.balance === 1234, String(answer.balance));
    check("D1 only the parts the gateway declared are reported",
      answer.balanceBreakdown.daily === 0 && answer.balanceBreakdown.reward === 5
        && !("monthly" in answer.balanceBreakdown) && !("topup" in answer.balanceBreakdown),
      JSON.stringify(answer.balanceBreakdown));
  }
  {
    const read = stubRead({ balance: { total: 7 } });
    await readRaccoonStatus(deps({ read }));
    const call = read.calls.find((c) => c.key.startsWith("balance:"));
    check("D3 the balance read is keyed on the token fingerprint",
      call.key === `balance:${tokenFingerprint(TOKEN)}`, call.key);
    check("D3 the balance window matches the tab's slow cadence",
      call.ttlMs === RACCOON_BALANCE_TTL_MS && RACCOON_BALANCE_TTL_MS === 60_000, String(call.ttlMs));
  }
  {
    // A rejected read is not an empty balance: the panel must be able to tell
    // "the gateway said zero" from "we could not ask".
    const answer = await readRaccoonStatus(deps({ read: stubRead({ balance: () => Promise.reject(new Error("gateway unreachable")) }) }));
    check("D2 a rejected balance read leaves the number null and names the reason",
      answer.balance === null && typeof answer.balanceDetail === "string" && answer.balanceDetail.includes("gateway unreachable"),
      JSON.stringify({ b: answer.balance, d: answer.balanceDetail }));
  }
  {
    // The REAL coalescing cache against a stubbed gateway: one window, one call.
    const seen = [];
    const prior = globalThis.fetch;
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return { code: 0, message: "", data: { available_points: 42, reward_points: 2 } };
        },
        async text() { return ""; }
      };
    };
    try {
      const read = createCoalescedFetch();
      const wiring = { store: fakeStore(), switchStore: null, publisher: null, read, login: fakeLogin().view };
      const first = await readRaccoonStatus(wiring);
      const second = await readRaccoonStatus(wiring);
      const balanceCalls = seen.filter((url) => url.includes(`${RACCOON_POINTS_PREFIX}/balance`));
      check("D4 two reads inside the window cost ONE gateway balance call",
        balanceCalls.length === 1 && first.balance === 42 && second.balance === 42,
        `${balanceCalls.length} call(s) to ${RACCOON_API_BASE}${RACCOON_POINTS_PREFIX}/balance`);
    } finally {
      globalThis.fetch = prior;
    }
  }
  {
    // `onFail` from the protocol layer must reach the panel as a named reason,
    // not as an empty number.
    const prior = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401, async text() { return "invalid_token"; }, async json() { return {}; } });
    try {
      const answer = await readRaccoonStatus(deps({ read: createCoalescedFetch() }));
      check("D2 an HTTP refusal surfaces the gateway's own words",
        answer.balance === null && String(answer.balanceDetail).includes("401"),
        String(answer.balanceDetail));
    } finally {
      globalThis.fetch = prior;
    }
  }
} catch (error) {
  fail("D: balance", error);
}

// === E. the roster's three sources ========================================
try {
  {
    const answer = await readRaccoonStatus(deps({ read: stubRead({ catalog: CATALOG_HIT }) }));
    check("E1 a live catalogue is the roster, sourced `live`",
      answer.modelsSource === "live" && answer.models.length === 1 && answer.models[0].id === "sn-live-1",
      `${answer.modelsSource}/${answer.models.length}`);
  }
  {
    const answer = await readRaccoonStatus(deps({ read: stubRead({ catalog: null }) }));
    check("E2 no catalogue and no failure reads as `empty`",
      answer.modelsSource === "empty" && answer.models === RACCOON_FALLBACK_MODELS,
      answer.modelsSource);
  }
  {
    const answer = await readRaccoonStatus(deps({ read: stubRead({ catalog: () => Promise.reject(new Error("boom")) }) }));
    check("E3 an unreadable catalogue reads as `unreadable` and still offers the fallback",
      answer.modelsSource === "unreadable" && answer.models === RACCOON_FALLBACK_MODELS,
      answer.modelsSource);
  }
  {
    const read = stubRead({ catalog: CATALOG_HIT });
    await readRaccoonStatus(deps({ read }));
    const call = read.calls.find((c) => c.key.startsWith("catalog:"));
    check("E4 the catalogue read is keyed on the token fingerprint with the longer window",
      call.key === `catalog:${tokenFingerprint(TOKEN)}` && call.ttlMs === RACCOON_CATALOG_TTL_MS && RACCOON_CATALOG_TTL_MS === 300_000,
      `${call.key} @${call.ttlMs}`);
  }
  {
    const answer = await readRaccoonStatus(deps({ store: null, read: stubRead() }));
    check("E5 no store at all still answers with the fallback roster",
      answer.loggedIn === false && answer.models === RACCOON_FALLBACK_MODELS && answer.balance === null,
      JSON.stringify({ l: answer.loggedIn, s: answer.modelsSource }));
  }
} catch (error) {
  fail("E: the roster's three sources", error);
}

// === F. switch, publisher and the expiry facts =============================
try {
  {
    const answer = await readRaccoonStatus(deps({ switchStore: fakeSwitch({ enabled: false, ids: ["a", "b"] }) }));
    // `switchSource` names WHERE the value came from, not what it is: a
    // panel-saved `false` is still the panel's answer, not the default.
    check("F1 a switch that is off reports off, sourced from the panel",
      answer.enabled === false && answer.switchSource === "panel", answer.switchSource);
    check("F1 the saved curation is reported even while off", JSON.stringify(answer.enabledModelIds) === '["a","b"]', JSON.stringify(answer.enabledModelIds));
    check("F1 no publisher never reads as registered",
      answer.providerRegistered === false && !("providerError" in answer));
  }
  {
    const answer = await readRaccoonStatus(deps({ switchStore: null }));
    check("F1 an absent switch reads as off rather than throwing",
      answer.enabled === false && answer.switchSource === "off" && answer.enabledModelIds === null,
      JSON.stringify({ e: answer.enabled, ids: answer.enabledModelIds }));
  }
  {
    const answer = await readRaccoonStatus(deps({ publisher: { state: { registered: true, error: "peer missing" } } }));
    check("F2 a registered publisher with an error reports both",
      answer.providerRegistered === true && answer.providerError === "peer missing",
      JSON.stringify({ r: answer.providerRegistered, e: answer.providerError }));
  }
  {
    // The eager refresh: a lapsed access token with a live refresh token must
    // rotate in place BEFORE the reads, and the surfaced expiry facts must
    // describe the pair that will actually serve them.
    const store = fakeStore({
      async isExpired() { store.calls.isExpired += 1; return true; },
      async refresh() { store.calls.refresh += 1; },
      async state() {
        store.calls.state += 1;
        return {
          hasCredential: true,
          nickname: "鲸鱼",
          source: "file",
          expiresAtMs: store.calls.state === 1 ? NOW - 1000 : NOW + 3_600_000,
          refreshExpiresAtMs: NOW + 30 * 86_400_000
        };
      }
    });
    const answer = await readRaccoonStatus(deps({ store, read: stubRead({ balance: BALANCE_HIT, catalog: CATALOG_HIT }) }));
    check("F3 a lapsed token is refreshed in place exactly once", store.calls.refresh === 1, String(store.calls.refresh));
    check("F3 the state is re-read so the facts describe the live pair",
      store.calls.state >= 2 && answer.credentialExpired === false && answer.expiresAtMs > NOW,
      JSON.stringify({ n: store.calls.state, expired: answer.credentialExpired, at: answer.expiresAtMs }));
  }
  {
    const store = fakeStore();
    store.state = async () => ({ hasCredential: true, nickname: "", source: "file", expiresAtMs: NOW - 5000 });
    const answer = await readRaccoonStatus(deps({ store }));
    check("F4 a lapsed credential is flagged while it is still `loggedIn`",
      answer.loggedIn === true && answer.credentialExpired === true, JSON.stringify({ l: answer.loggedIn, e: answer.credentialExpired }));
  }
  {
    const store = fakeStore({
      async state() { return { hasCredential: false }; },
      async resolve() { return { credential: null }; }
    });
    const answer = await readRaccoonStatus(deps({ store, read: stubRead({ balance: BALANCE_HIT, catalog: CATALOG_HIT }) }));
    check("F5 no credential means no balance, no live roster and no nickname",
      answer.loggedIn === false && answer.balance === null && answer.modelsSource === "empty" && answer.nickname === "",
      JSON.stringify({ b: answer.balance, s: answer.modelsSource }));
  }
  {
    // A store whose read REJECTS is read as "no credential": the credential
    // service being unreachable must cost the tab its numbers, not the whole
    // answer. (`state()` carries its own `.catch(() => null)` for exactly
    // this — the route must never 500 because a peer went away.)
    const store = fakeStore({ async state() { throw new Error("credentials service said no"); } });
    const answer = await readRaccoonStatus(deps({ store }));
    check("F6 a rejecting store read degrades to `not logged in`, never a failed answer",
      answer.ok === true && answer.loggedIn === false && answer.balance === null,
      JSON.stringify({ ok: answer.ok, l: answer.loggedIn }));
  }
  {
    // The other shape: a store that is MALFORMED (a call that throws rather
    // than rejects) is a fact the panel should be told, not a crash. This is
    // what the outer `error` field is for.
    const store = { resolve: async () => ({ credential: null }) };
    const answer = await readRaccoonStatus(deps({ store }));
    check("F6 a malformed store is reported through `error` rather than thrown",
      answer.ok === true && typeof answer.error === "string" && answer.error.length > 0,
      String(answer.error));
  }
} catch (error) {
  fail("F: switch, publisher and the expiry facts", error);
}

// === G. the shared wire declaration is the ONE account of this answer ======
// `RaccoonState` used to live only in the client bundle — a hand-written mirror
// with no counterpart on this side, and (unlike the snapshot, which
// `docs.test.mjs` §5b pins) nothing compared its fields to the fields
// `readRaccoonStatus` actually produces. It now lives in `src/shared/wire.ts`
// (the one exception to the host source-graph closure, see `package.test.mjs`
// §2). These checks assert declaration and production are the SAME SET, so a
// field added to either side fails here instead of silently reaching only one.
//
// The one asymmetry is the `?debug=1` scaffold (`TRIAGE_KEYS`): those keys are
// emitted on the wire but deliberately NOT part of `RaccoonState` — they
// describe the environment, not the tab, and no client code reads any of them.
{
  const sharedSrc = readFileSync(new URL("../src/shared/wire.ts", import.meta.url), "utf8");
  const iface = sharedSrc.match(/interface RaccoonState \{([\s\S]*?)\n\}/);
  if (!iface) {
    check("G the shared RaccoonState declaration exists", false, "interface not found");
  } else {
    const hostSrc = readFileSync(new URL("../src/host/raccoon-status.ts", import.meta.url), "utf8");
    const okAt = hostSrc.indexOf("ok: true,");
    const retAt = hostSrc.lastIndexOf("return {", okAt);
    const endAt = hostSrc.indexOf("};", okAt);
    const block = okAt < 0 || retAt < 0 || endAt < 0 ? "" : hostSrc.slice(retAt, endAt);
    if (block.length === 0) {
      check("G the host return block is locatable", false, "slice failed");
    } else {
      const hostFields = new Set();
      // `key: value` lines (`ok: true`, `pollSeconds: …`).
      for (const m of block.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) hostFields.add(m[1]);
      // Bare shorthand lines (`loggedIn,`, `balance,`).
      for (const m of block.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*,?\s*$/gm)) hostFields.add(m[1]);
      // `pickDefined({ … })` — the first identifier of each comma-split segment
      // is the key, so `{ scanUrl: scan?.url }` yields `scanUrl`, not `url`.
      for (const m of block.matchAll(/pickDefined\(\{([\s\S]*?)\}\)/g)) {
        for (const segment of m[1].split(",")) {
          const id = segment.match(/[A-Za-z_$][\w$]*/);
          if (id) hostFields.add(id[0]);
        }
      }
      // A conditional object literal (`...(cond ? { loginError } : {})`).
      for (const m of block.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) hostFields.add(m[1]);

      const declaredFields = new Set();
      for (const m of iface[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\??\s*:/gm)) declaredFields.add(m[1]);

      const debugOnly = new Set(TRIAGE_KEYS);
      const hostOnly = [...hostFields].filter((f) => !declaredFields.has(f) && !debugOnly.has(f));
      const declaredOnly = [...declaredFields].filter((f) => !hostFields.has(f));

      check("G every field the route produces is declared in the shared wire contract",
        hostOnly.length === 0, hostOnly.join(", "));
      check("G every declared field is produced by the route (no phantom contract keys)",
        declaredOnly.length === 0, declaredOnly.join(", "));
      // The size agreement is over the ROUTE's own fields and the DECLARED set
      // only: the `?debug=1` scaffold lives in the `diagnostics` object above
      // the return block and is spread in by name, so its keys never appear in
      // `hostFields` — the two subset checks above already make room for them.
      check("G the declaration and the route agree in size",
        hostFields.size === declaredFields.size,
        `route ${hostFields.size} / declared ${declaredFields.size} (debug-only ${debugOnly.size} excluded by design)`);
    }
  }
}

// === H. the coalescing cache's clear() closes the pre-clear race ==========
// `clear()` is the seam that keeps one identity's cached answers from leaking
// into the next (account switch, forgotten key, fresh login). The race it must
// close: a producer that started BEFORE the clear and lands AFTER it must not
// write its answer where the next read can see it — and the next read must not
// join that stale flight either. Generation counters on the cache entries and
// an evicted in-flight map are what make the promise concurrent-safe.
try {
  {
    // H1: a pre-clear in-flight answer is unreachable after the clear.
    const coalesced = createCoalescedFetch();
    let releaseOld = null;
    let oldProducers = 0;
    let newProducers = 0;
    const oldFlight = coalesced.read("k", () => {
      oldProducers += 1;
      return new Promise((resolve) => { releaseOld = () => resolve("old-identity"); });
    }, 60_000);
    // The producer ran synchronously, so the flight exists; clear BEFORE it
    // settles, exactly the window the account route's cache.clear() can hit.
    await Promise.resolve();
    coalesced.clear("k");
    releaseOld();
    const oldValue = await oldFlight;
    // The next read must neither serve the old write nor join the old flight.
    const newValue = await coalesced.read("k", async () => {
      newProducers += 1;
      return "new-identity";
    }, 60_000);
    check("H1 clear makes a pre-clear in-flight answer unreachable",
      oldValue === "old-identity" && newValue === "new-identity"
        && oldProducers === 1 && newProducers === 1,
      `old=${oldValue} new=${newValue} producers=${oldProducers}/${newProducers}`);
  }
  {
    // H2: the no-key clear bumps the GLOBAL generation — every key refetches.
    const coalesced = createCoalescedFetch();
    let producers = 0;
    await coalesced.read("x", async () => { producers += 1; return "v1"; }, 60_000);
    coalesced.clear();
    const again = await coalesced.read("x", async () => { producers += 1; return "v2"; }, 60_000);
    check("H2 clear() (no key) invalidates every key",
      again === "v2" && producers === 2, `value=${again} producers=${producers}`);
  }
  {
    // H3: the TTL hit still works after a clear — the new generation's entry
    // is served within its window, so clearing is not a cache murder.
    const coalesced = createCoalescedFetch();
    let producers = 0;
    await coalesced.read("k", async () => { producers += 1; return "a"; }, 60_000);
    await coalesced.read("k", async () => { producers += 1; return "never"; }, 60_000);
    check("H3 a fresh entry after clear still hits within its TTL",
      producers === 1, `producers=${producers}`);
  }
  {
    // H4: THE PRODUCTION SHAPE. H1-H3 all drive ONE long-lived instance, which
    // is exactly why the guard could be green here while the shipped wiring
    // leaked: `console-client.ts` builds a FRESH instance per call over the
    // shared maps, and the account/api-key routes invalidate through the raw
    // map. With per-instance generation counters the bump was invisible to the
    // next read, so a pre-switch console flight was served to the account that
    // had just signed in. Pin the real shape: shared maps + fresh instance per
    // read + the routes' exported invalidation helper.
    const cache = new Map();
    const inflight = new Map();
    const readFresh = (key, body) => createCoalescedFetch({ cache, inflight })
      .read(key, async () => body, 60_000);

    let releaseOld = null;
    const oldFlight = createCoalescedFetch({ cache, inflight }).read("pool", () =>
      new Promise((resolve) => { releaseOld = () => resolve("ACCOUNT_A_DATA"); }), 60_000);
    await Promise.resolve();
    // What `routes/account.ts` does on an account switch.
    clearCoalescedFetch(cache, inflight);
    releaseOld();
    await oldFlight;
    const afterSwitch = await readFresh("pool", "ACCOUNT_B_DATA");
    check("H4 a fresh instance over shared maps sees the route's clear (no cross-account leak)",
      afterSwitch === "ACCOUNT_B_DATA",
      `post-switch read=${afterSwitch}`);
  }
} catch (error) {
  fail("H: coalesced clear race", error);
}

// The two groups that drive the REAL coalescing cache serve their own fetch;
// everything else answers from a stub cache. Nothing may reach the network.
const unstubbed = releaseNetworkGuard();
check("no check escaped its stub to the network", unstubbed.length === 0, unstubbed.join(", "));

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

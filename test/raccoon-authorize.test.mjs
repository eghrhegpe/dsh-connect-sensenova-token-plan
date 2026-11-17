/**
 * Unit checks for the Raccoon browser-authorize login (ADR-020) — the
 * PEER-FREE protocol layer in `src/host/raccoon-authorize.ts`:
 *
 * - `buildRaccoonAuthorizeUrl`: the official page's parser rules, enforced
 *   up front (port range, 64-hex state, the redirect shape, the appname bound);
 * - `startRaccoonAuthorizeReceiver`: the loopback receiver, exercised against
 *   a REAL 127.0.0.1 socket (the security rules are the point — a stubbed
 *   server would test our expectation of the rules, not the rules); every
 *   rejection is probed through a real HTTP request with the violating
 *   header, and the one-shot / 409 behaviour is pinned on the same socket;
 * - `exchangeRaccoonAuthorizationCode`: the gateway's exchange, driven by an
 *   INJECTED fetcher (no network) — the success gate (the IAM half and the
 *   legacy half) and every refusal reason;
 * - `isRaccoonIamToken` / `raccoonIamTokenIsValid`: the token-kind split the
 *   official `iamToken.js` encodes.
 *
 * Nothing here imports a Host peer (`node:http` and `node:crypto` are
 * built-ins, not peers), so the decisions stay covered on a clean checkout.
 */
import http from "node:http";
import {
  buildRaccoonAuthorizeUrl,
  startRaccoonAuthorizeReceiver,
  exchangeRaccoonAuthorizationCode,
  isRaccoonIamToken,
  raccoonIamTokenIsValid,
  RACCOON_API_BASE,
  RACCOON_AUTH_APPNAME,
  RACCOON_AUTHORIZE_PATH,
  RACCOON_LOOPBACK_CALLBACK_PATH,
  RACCOON_AUTHORIZATION_CODE_NOT_FOUND,
  RACCOON_AUTHORIZE_TIMEOUT_MS,
  RACCOON_IAM_ISSUER
} from "../src/host/raccoon.ts";
import { check, section, finish } from "./harness.mjs";

const STATE = "a".repeat(64);
const CODE = "auth-code-value-0123";

/** One base64url JWT with a fixed header/signature and the given payload. */
function fakeJwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.${b64({})}`;
}
const iamClaims = (expSeconds) => ({
  iss: RACCOON_IAM_ISSUER,
  sub: "acct-1",
  exp: expSeconds,
  name: "浣熊用户"
});
const nowSec = () => Math.floor(Date.now() / 1000);

// ── A: the URL builder is the page's parser, enforced up front ─────────────
section("A — buildRaccoonAuthorizeUrl: the page's rules, up front");
{
  const url = buildRaccoonAuthorizeUrl({ port: 4321, state: STATE });
  const parsed = new URL(url);
  check("A1 the URL is https on the gateway's /authorize", parsed.origin === RACCOON_API_BASE && parsed.pathname === RACCOON_AUTHORIZE_PATH, url);
  check("A2 the param set is the page's desktop+loopback shape",
    parsed.searchParams.get("login_source") === "desktop"
    && parsed.searchParams.get("desktop_callback") === "loopback"
    && parsed.searchParams.get("redirect") === `http://127.0.0.1:4321${RACCOON_LOOPBACK_CALLBACK_PATH}`
    && parsed.searchParams.get("state") === STATE,
    parsed.search);
  check("A3 the default appname is the proven one", parsed.searchParams.get("appname") === RACCOON_AUTH_APPNAME, parsed.searchParams.get("appname"));

  const refused = (port, state = STATE, appname = RACCOON_AUTH_APPNAME) => {
    let error = null;
    try { buildRaccoonAuthorizeUrl({ port, state, appname }); } catch (e) { error = e; }
    return error;
  };
  check("A4 a port below 1024 is refused up front", refused(999) !== null);
  check("A5 a non-integer port is refused", refused(4321.5) !== null);
  check("A6 a six-digit port is refused (the page's regex caps at 5)", refused(100000) !== null);
  check("A7 a port above 65535 is refused", refused(70000) !== null);
  check("A8 a 63-hex state is refused", refused(4321, "a".repeat(63)) !== null);
  check("A9 an UPPERCASE state is refused (the page's rule is [a-f0-9])", refused(4321, "A".repeat(64)) !== null);
  check("A10 a 101-char appname is refused", refused(4321, STATE, "x".repeat(101)) !== null);
  check("A11 the bounds are inclusive: 1024 and 65535 pass",
    refused(1024) === null && refused(65535) === null);
}

// ── B: the loopback receiver, on a real socket ─────────────────────────────
section("B — startRaccoonAuthorizeReceiver: the official's seven rules on a real socket");
async function probe(receiver, pathAndQuery, headers = {}, method = "GET") {
  return await new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port: receiver.port,
      path: pathAndQuery,
      method,
      headers
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", () => resolve({ status: null, body: "connection-closed" }));
    req.end();
  });
}
{
  const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, timeoutMs: 60_000 });
  check("B1 the receiver binds 127.0.0.1 and reports its port", receiver.port > 0 && receiver.redirect === `http://127.0.0.1:${receiver.port}${RACCOON_LOOPBACK_CALLBACK_PATH}`, String(receiver.port));
  const bUrl = new URL(receiver.authorizeUrl);
  check("B2 the authorizeUrl carries this receiver's port and state",
    bUrl.searchParams.get("redirect") === receiver.redirect && bUrl.searchParams.get("state") === receiver.state, receiver.authorizeUrl.slice(0, 120));
  check("B3 the state is 64 lowercase hex", /^[a-f0-9]{64}$/.test(receiver.state), receiver.state.slice(0, 8));

  const good = `/auth/callback?code=${encodeURIComponent(CODE)}&state=${STATE}`;
  const bad = (q) => `/auth/callback?${q}`;

  // The rejections first (the receiver stays open through every refusal).
  const cases = [
    ["B4 a POST is rejected (GET-only)", () => probe(receiver, good, {}, "POST"), "method"],
    ["B5 a foreign host header is rejected", () => probe(receiver, good, { Host: "example.com" }), "host"],
    ["B6 a foreign Origin is rejected", () => probe(receiver, good, { Origin: "https://evil.example" }), "origin"],
    ["B7 a non-document Sec-Fetch-Dest is rejected", () => probe(receiver, good, { "Sec-Fetch-Dest": "iframe" }), "fetch-dest"],
    ["B9 an extra query key is rejected", () => probe(receiver, bad(`code=${encodeURIComponent(CODE)}&state=${STATE}&foo=1`)), "keys"],
    ["B10 a duplicated state key is rejected", () => probe(receiver, bad(`code=${encodeURIComponent(CODE)}&state=${STATE}&state=${STATE}`)), "keys"],
    ["B11 a mismatched state is rejected", () => probe(receiver, bad(`code=${encodeURIComponent(CODE)}&state=${"b".repeat(64)}`)), "state"],
    ["B12 a 63-hex state is rejected", () => probe(receiver, bad(`code=${encodeURIComponent(CODE)}&state=${"a".repeat(63)}`)), "state"],
    ["B13 a control-char code is rejected", () => probe(receiver, bad(`code=${encodeURIComponent("a\u0001b")}&state=${STATE}`)), "code"],
    ["B14 an over-4096 code is rejected", () => probe(receiver, bad(`code=${encodeURIComponent("c".repeat(5000))}&state=${STATE}`)), "code"],
    ["B15 the wrong path is rejected", () => probe(receiver, `/auth/callback2?code=x&state=${STATE}`), "path"],
    ["B16 a fragment on the raw URL is rejected", () => probe(receiver, bad(`code=${encodeURIComponent(CODE)}&state=${STATE}`) + "#frag"), "path"]
  ];
  const bodies = [];
  for (const [name, run, expectation] of cases) {
    const res = await run();
    bodies.push(res.body);
    check(name, res.status === 400 && res.body.includes(expectation), res);
  }
  const b17res = await probe(receiver, good);
  check("B17 rejections never consume the receiver (a good callback still lands)",
    b17res.status === 200, b17res);

  const settled = await receiver.result;
  check("B18 the result settles with the callback's code, verbatim", settled.ok === true && settled.code === CODE, JSON.stringify(settled));
  const second = await probe(receiver, good).catch(() => null);
  check("B19 after the callback, the port is gone or 409 (one-shot)",
    second.status === null || second.status === 409, JSON.stringify(second));
  check("B20 no response body ever prints the code value",
    bodies.every((body) => !body.includes(CODE)), `${bodies.length} rejection bodies, none carry the code`);
  // The ACCEPTED case takes a fresh receiver: a valid callback is one-shot, so
  // running it against the first receiver would consume it and void B17–B19.
  const secondReceiver = await startRaccoonAuthorizeReceiver({ state: STATE, timeoutMs: 60_000 });
  const allowed = await probe(secondReceiver, bad(`code=${encodeURIComponent(CODE)}&state=${STATE}`), { Origin: RACCOON_API_BASE, "Sec-Fetch-Dest": "document" });
  check("B8 a matching Origin + document fetch-dest is accepted", allowed.status === 200, allowed);
  const s2 = await secondReceiver.result;
  check("B8b the accepting receiver settles with the code", s2.ok === true && s2.code === CODE, JSON.stringify(s2));
}
{
  // The timeout terminal: a receiver nobody calls back settles `timeout`.
  const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, timeoutMs: 150 });
  const settled = await receiver.result;
  check("B21 an unvisited receiver settles timeout", settled.ok === false && settled.reason === "timeout", JSON.stringify(settled));
  const after = await probe(receiver, `/auth/callback?code=${encodeURIComponent(CODE)}&state=${STATE}`).catch(() => null);
  check("B22 after the timeout the port is gone", after.status === null || after.status === 409 || after.status === 400, JSON.stringify(after));
}
{
  // The cancel terminal: `cancel()` reads as the user's own stop.
  const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, timeoutMs: 60_000 });
  receiver.cancel();
  const settled = await receiver.result;
  check("B23 cancel() settles closed", settled.ok === false && settled.reason === "closed", JSON.stringify(settled));
}
{
  // A refused bind settles `failed` instead of throwing out of the factory.
  // The refusal is made DETERMINISTIC: take a real port, then ask for it
  // again — EADDRINUSE is the one bind error every platform honours
  // (privilege-dependent ports like 80 are not a reliable fixture: on an
  // elevated Windows host 80 binds just fine).
  const blocker = http.createServer();
  await new Promise((res) => blocker.listen(0, "127.0.0.1", res));
  const takenPort = blocker.address().port;
  const receiver = await startRaccoonAuthorizeReceiver({ state: STATE, port: takenPort, timeoutMs: 60_000 });
  const settled = await receiver.result;
  check("B24 a bind refusal settles failed and yields an empty URL", settled.ok === false && settled.reason === "failed" && receiver.authorizeUrl === "", JSON.stringify({ settled, url: receiver.authorizeUrl }));
  check("B25 the state was still validated (64 hex) before the bind", /^[a-f0-9]{64}$/.test(receiver.state));
  blocker.closeAllConnections?.();
  blocker.close();
}
{
  let error = null;
  try { await startRaccoonAuthorizeReceiver({ state: STATE, port: 80, timeoutMs: 1000 }); } catch (e) { error = e; }
  check("B26 a requested port below the page's range is refused up front", error !== null && String(error.message).includes("1024"), String(error?.message));
}
{
  let error = null;
  try { await startRaccoonAuthorizeReceiver({ state: "z".repeat(64) }); } catch (e) { error = e; }
  check("B27 a malformed state is refused up front", error !== null && String(error.message).includes("state"), String(error?.message));
}

// ── C: the exchange, driven by an injected fetcher ─────────────────────────
section("C — exchangeRaccoonAuthorizationCode: the gate and every refusal");
function exchangeFetcher(body, status = 200, record = null) {
  return async (url, init) => {
    record?.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (typeof body === "function" ? body() : body)
    };
  };
}
{
  const ok = await exchangeRaccoonAuthorizationCode(CODE, {
    fetcher: exchangeFetcher({ code: 0, message: "ok", data: { access_token: fakeJwt(iamClaims(nowSec() + 3600)), office_identity: "id-1" } }),
  });
  check("C1 an IAM success passes the gate", ok.ok === true && ok.iam === true && ok.accessToken !== "" && ok.refreshToken === "", JSON.stringify(ok));
  check("C2 an IAM answer WITHOUT a refresh stores the empty pair (pass-through, never invented)", ok.refreshToken === "");
  check("C3 the access expiry is decoded for the store", typeof ok.accessExpiresAtMs === "number", String(ok.accessExpiresAtMs));
  check("C4 the office identity rides along", ok.officeIdentity === "id-1", String(ok.officeIdentity));
}
{
  // The LIVE 2026-11-17 loopback answer's shape: an IAM access token PAIRED
  // with a refresh_token (co-terminous, both exp = issue + 30 d) and NO
  // office identity. The gate accepts it — the IAM half never REQUIRES a
  // refresh, it PASSES THROUGH whatever the gateway pairs — and both
  // expiries decode. This is the exact answer a real user login produced.
  const pairExp = nowSec() + 30 * 86400;
  const ok = await exchangeRaccoonAuthorizationCode(CODE, {
    fetcher: exchangeFetcher({
      code: 0,
      message: "success",
      data: { access_token: fakeJwt(iamClaims(pairExp)), refresh_token: fakeJwt({ iss: RACCOON_IAM_ISSUER, sub: "acct-1", exp: pairExp }) }
    }),
  });
  check("C4b the live IAM+refresh pair is accepted and the refresh passes through",
    ok.ok === true && ok.iam === true && ok.refreshToken !== "", JSON.stringify({ ok: ok.ok, iam: ok.iam }));
  check("C4c a co-terminous pair decodes BOTH expiries (the store needs the refresh clock too)",
    typeof ok.accessExpiresAtMs === "number" && ok.accessExpiresAtMs === ok.refreshExpiresAtMs,
    String(ok.refreshExpiresAtMs));
}
{
  const ok = await exchangeRaccoonAuthorizationCode(CODE, {
    fetcher: exchangeFetcher({
      code: 0,
      data: {
        access_token: fakeJwt({ iss: RACCOON_API_BASE, sub: "x", exp: nowSec() + 3600 }),
        refresh_token: fakeJwt({ iss: RACCOON_API_BASE, exp: nowSec() + 86400 })
      }
    }),
  });
  check("C5 a legacy success passes with its refresh", ok.ok === true && ok.iam === false && ok.refreshToken !== "", JSON.stringify({ ok: ok.ok, iam: ok.iam, refresh: ok.refreshToken !== "" }));
  check("C6 the refresh expiry is decoded too", typeof ok.refreshExpiresAtMs === "number", String(ok.refreshExpiresAtMs));
}
{
  const res = await exchangeRaccoonAuthorizationCode(CODE, {
    fetcher: exchangeFetcher({ code: 0, data: { access_token: fakeJwt({ iss: RACCOON_API_BASE, sub: "x", exp: nowSec() + 3600 }) } }),
  });
  check("C7 a legacy answer without its refresh is refused, not stored", res.ok === false && res.reason === "refresh_missing", JSON.stringify(res));
}
{
  const res = await exchangeRaccoonAuthorizationCode(CODE, {
    fetcher: exchangeFetcher({ code: 0, data: { access_token: fakeJwt(iamClaims(nowSec() - 10)) } }),
  });
  check("C8 an EXPIRED IAM token is refused (the official's own validity gate)", res.ok === false && res.reason === "token_invalid", JSON.stringify(res));
}
{
  const res = await exchangeRaccoonAuthorizationCode(CODE, {
    fetcher: exchangeFetcher({ code: 0, data: { access_token: fakeJwt({ iss: "https://other.example/iam", sub: "x", exp: nowSec() + 3600 }) } }),
  });
  check("C9 an IAM token from the wrong issuer is refused", res.ok === false && res.reason === "token_invalid", JSON.stringify(res));
}
{
  const res = await exchangeRaccoonAuthorizationCode(CODE, {
    fetcher: exchangeFetcher({ code: RACCOON_AUTHORIZATION_CODE_NOT_FOUND, message: "authorization_code_not_found_error" }, 400),
  });
  check("C10 the 200035 refusal is named (a re-start is the only recovery)", res.ok === false && res.reason === "code_not_found", JSON.stringify(res));
}
{
  const res = await exchangeRaccoonAuthorizationCode(CODE, {
    fetcher: exchangeFetcher({ code: 40100, message: "unauthorized" }, 401),
  });
  check("C11 a 401 is the dead-session word", res.ok === false && res.reason === "session_dead", JSON.stringify(res));
}
{
  const res = await exchangeRaccoonAuthorizationCode(CODE, {
    fetcher: exchangeFetcher({ code: 50000, message: "boom" }, 500),
  });
  check("C12 a 5xx is a server refusal, not a credential verdict", res.ok === false && res.reason === "server_error", JSON.stringify(res));
}
{
  const res = await exchangeRaccoonAuthorizationCode(CODE, { fetcher: async () => { throw new Error("offline"); } });
  check("C13 a transport failure is the network word", res.ok === false && res.reason === "network", JSON.stringify(res));
}
{
  const res = await exchangeRaccoonAuthorizationCode(CODE, {
    fetcher: exchangeFetcher({ code: 0, data: {} }),
  });
  check("C14 a 200 with no token is an invalid answer, not a success", res.ok === false && res.reason === "invalid_response", JSON.stringify(res));
}
{
  const record = [];
  await exchangeRaccoonAuthorizationCode(CODE, {
    fetcher: exchangeFetcher({ code: 0, data: { access_token: fakeJwt(iamClaims(nowSec() + 60)) } }, 200, record),
  });
  const call = record[0];
  check("C15 the request is the official's shape: one Content-Type header, one body field",
    call.url === `${RACCOON_API_BASE}/api/web/auth/v1/login_with_authorization_code`
    && call.init.method === "POST"
    && JSON.stringify(Object.keys(call.init.headers)) === JSON.stringify(["Content-Type"])
    && Object.keys(JSON.parse(call.init.body)).length === 1,
    JSON.stringify(call?.init ?? null).slice(0, 200));
  check("C16 the code rides verbatim in the body", JSON.parse(call.init.body).authorization_code === CODE);
}

// ── D: the token-kind split ────────────────────────────────────────────────
section("D — isRaccoonIamToken / raccoonIamTokenIsValid");
{
  check("D1 an /iam issuer is recognized", isRaccoonIamToken(fakeJwt(iamClaims(nowSec() + 60))) === true);
  check("D2 a non-IAM issuer is not", isRaccoonIamToken(fakeJwt({ iss: RACCOON_API_BASE, sub: "x", exp: nowSec() + 60 })) === false);
  check("D3 a garbage token is not", isRaccoonIamToken("not-a-jwt") === false && isRaccoonIamToken("") === false && isRaccoonIamToken(null) === false);
  check("D4 the issuer match is exact", raccoonIamTokenIsValid(fakeJwt({ iss: `${RACCOON_IAM_ISSUER}/extra`, sub: "x", exp: nowSec() + 60 })) === false);
  check("D5 a blank sub fails the gate", raccoonIamTokenIsValid(fakeJwt({ iss: RACCOON_IAM_ISSUER, sub: "  ", exp: nowSec() + 60 })) === false);
  check("D6 a huge-but-finite exp that breaks Date is refused", raccoonIamTokenIsValid(fakeJwt({ iss: RACCOON_IAM_ISSUER, sub: "x", exp: 1e18 })) === false);
  check("D7 the default issuer is the gateway's /iam", raccoonIamTokenIsValid(fakeJwt(iamClaims(nowSec() + 60))) === true);
}

// ── E: the constants the suites single-source ──────────────────────────────
section("E — the wire constants");
{
  check("E1 the receiver's default window is the official's 300 s", RACCOON_AUTHORIZE_TIMEOUT_MS === 300_000, String(RACCOON_AUTHORIZE_TIMEOUT_MS));
  check("E2 the not-found code is the probed 200035", RACCOON_AUTHORIZATION_CODE_NOT_FOUND === 200035, String(RACCOON_AUTHORIZATION_CODE_NOT_FOUND));
  check("E3 the callback path is the page's fixed one", RACCOON_LOOPBACK_CALLBACK_PATH === "/auth/callback", RACCOON_LOOPBACK_CALLBACK_PATH);
  // The live 2026-11-17 loopback exchange signed `iss: "xiaohuanxiong.com/iam"` —
  // the HOST form the official fallback computes (`new URL(LOGIN_URL).host +
  // "/iam"`). The scheme is the trap this whole constant exists to dodge:
  // equality on `iss` means an `https://`-carrying expectation rejects every
  // real token, so the shape is pinned here, not just derived.
  check("E4 the IAM issuer is the scheme-free host form the gateway signs", RACCOON_IAM_ISSUER === "xiaohuanxiong.com/iam", RACCOON_IAM_ISSUER);
}

finish({ noun: "checks" });

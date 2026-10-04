/**
 * Checks for the token store: renewal, rejection memory, and the account —
 * with and without a credentials service.
 */
import { createTokenStore, MAX_LOGIN_BACKOFF_MS, DEFAULT_LOGIN_BACKOFF_MS, THROTTLE_ID } from "../src/host/token-store.ts";
import { purgeGrant } from "../src/host/token-store/grant.ts";
import { createFileThrottleStore, createMemoryThrottleStore } from "../src/host/throttle-store.ts";
import { loadPeer, installNetworkGuard, findPeerRoot, isolateStateDir } from "./peer-roots.mjs";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();

const { credentialKey, credentialRef } = await loadPeer("dsh-credentials");
const { parseCredentialsDocument } = await loadPeer("dsh-credentials-local");
// The YAML renderer is resolved from the credentials package itself, so it is
// the exact dependency it writes the file with — comparable byte for byte.
const yaml = await import(pathToFileURL(
  createRequire(join(findPeerRoot(), "@deepseek-ai", "dsh-credentials-local", "lib", "index.js"))
    .resolve("yaml")
).href);

/** After the peers are found: nothing else may touch the real Home. */
const restoreStateDir = isolateStateDir();

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

const KEY = credentialKey("dsh-connect-sensenova-token-plan", "sensenova-console");
/** The sign-in throttle lives beside the grant, in its own record. */
const THROTTLE_KEY = credentialKey("dsh-connect-sensenova-token-plan", THROTTLE_ID);
const credentialKeyFn = (scope, id) => credentialKey(scope, id);

function jwtExpiring(minutes) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + minutes * 60 })).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
}

const grant = (accessToken, refreshToken, expiresIn) => ({
  kind: "grant",
  payload: { version: 1, accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 }
});

/** A fake credentials service covering both halves of the seam. */
function fakeCredentials(initial, opts = {}) {
  const records = new Map();
  const refs = new Map(Object.entries(opts.refs ?? {}));
  if (initial) records.set(KEY, initial);
  const calls = { modify: 0, concurrentModify: 0, inModify: 0 };
  return {
    calls, records, refs,
    async readRecord(k) { return records.get(k); },
    async modifyRecord(k, mutate) {
      calls.modify += 1;
      calls.inModify += 1;
      if (calls.inModify > 1) calls.concurrentModify += 1;
      try {
        await new Promise((r) => setTimeout(r, 5));
        const next = await mutate(records.get(k));
        if (next === undefined) return records.get(k);
        records.set(k, next);
        return next;
      } finally {
        calls.inModify -= 1;
      }
    },
    async deleteRecord(k) { records.delete(k); },
    async resolve(ref) {
      const envValue = opts.env?.[ref];
      if (typeof envValue === "string" && envValue.length > 0) return { value: envValue, source: "env" };
      const value = refs.get(ref);
      return typeof value === "string" && value.length > 0 ? { value, source: "file" } : undefined;
    },
    async set(ref, value) {
      if (opts.readOnly?.includes(ref)) {
        throw new Error(`credentials-local: "${ref}" is supplied read-only by the launching environment, so set would be shadowed`);
      }
      refs.set(ref, value);
    },
    async unset(ref) { refs.delete(ref); }
  };
}

/** A token-endpoint stub issuing a distinct pair per exchange. */
/** The state the last authorization request issued, echoed into a success redirect. */
let issuedState = "";
async function makeTokenStub(onLogin) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true, ["encrypt", "decrypt"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const log = { logins: 0, tokens: 0 };
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
          location: "https://platform.sensenova.cn/login?login_challenge=chal",
          "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
        }
      });
    }
    if (target.includes("iam.sensecoreapi.cn")) {
      log.logins += 1;
      return onLogin();
    }
    if (target.includes("oauth2/token")) {
      log.tokens += 1;
      return new Response(
        JSON.stringify({
          access_token: `${jwtExpiring(180)}${`#${log.tokens}`}`,
          refresh_token: `rotated-${log.tokens}`,
          expires_in: 10800
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("{}", { status: 404 });
  };
  stub.log = log;
  return stub;
}

const accepted = () => new Response(JSON.stringify({
  redirect: `https://platform.sensenova.cn/cb?code=c${issuedState !== "" ? `&state=${encodeURIComponent(issuedState)}` : ""}`
}), {
  status: 200, headers: { "content-type": "application/json" }
});
// The real IAM refusal envelope: the cause is in details[].reason, not the
// generic top-level status string.
const refused = () => new Response(JSON.stringify({
  code: 3, message: "InvalidArgument",
  details: [
    { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "invalidAccountOrPassword", domain: "iam" },
    { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en", message: "invalid account or password" }
  ]
}), { status: 400, headers: { "content-type": "application/json" } });

/** Run `body` with a stubbed network, restoring the real fetch afterwards. */
async function withNetwork(stub, body) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 1. fresh stored token is used without any network call ---------------
{
  const credentials = fakeCredentials(grant(jwtExpiring(120), "r1", 7200));
  await withNetwork(async () => { throw new Error("must not call the network"); }, async () => {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {} });
    check("fresh stored token needs no refresh", (await store.getToken()).startsWith("eyJ"));
  }).catch((error) => fail("fresh stored token needs no refresh", error));
}

// --- 2. a token near expiry is renewed, and the rotation lands ------------
{
  const credentials = fakeCredentials(grant(jwtExpiring(1), "old-refresh", 60));
  const stub = await makeTokenStub(accepted);
  await withNetwork(stub, async () => {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {}, skewMs: 120_000 });
    const token = await store.getToken();
    check("near-expiry token is refreshed", stub.log.tokens === 1, `tokens=${stub.log.tokens}`);
    check("the rotation is persisted",
      (await credentials.readRecord(KEY)).payload.refreshToken === "rotated-1",
      (await credentials.readRecord(KEY)).payload.refreshToken);
    check("store returns the new access token", token.startsWith("eyJ"));
  }).catch((error) => fail("near-expiry token is refreshed", error));
}

// --- 3. concurrent polls share ONE acquisition ---------------------------
{
  const credentials = fakeCredentials(grant(jwtExpiring(1), "old-refresh", 60));
  const stub = await makeTokenStub(accepted);
  await withNetwork(stub, async () => {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {}, skewMs: 120_000 });
    const tokens = await Promise.all([store.getToken(), store.getToken(), store.getToken(), store.getToken()]);
    check("concurrent polls trigger one refresh", stub.log.tokens === 1, `tokens=${stub.log.tokens}`);
    check("all callers get the same token", new Set(tokens).size === 1);
    check("no overlapping modifyRecord", credentials.calls.concurrentModify === 0,
      `concurrent=${credentials.calls.concurrentModify}`);
  }).catch((error) => fail("concurrent polls share one acquisition", error));
}

// --- 4. a rejected refresh token surfaces clearly -------------------------
{
  const credentials = fakeCredentials(grant(jwtExpiring(1), "dead-refresh", 60));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: "invalid_grant", error_description: "refresh token is invalid, expired, revoked" }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
  try {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {}, skewMs: 120_000 });
    let caught = null;
    try { await store.getToken(); } catch (error) { caught = error; }
    check("a rejected refresh token throws", caught !== null);
    check("rejection carries refresh_rejected", caught?.code === "refresh_rejected", caught?.code);
    const state = await store.state();
    check("state records the failure", typeof state.error === "string" && state.error.length > 0, state.error);
    // No account is stored to recover this dead refresh with, so the grant is
    // reaped rather than left ownerless (see 8h for the "hit once, then ask"
    // guarantee); with an account present it would instead fall back to login.
    check("a rejected refresh with no account reaps the grant",
      state.configured === false && state.hasRefreshToken === false, JSON.stringify(state));
  } catch (error) {
    fail("rejected refresh token surfaces clearly", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 5. nothing stored and no account -> not_configured -------------------
{
  const credentials = fakeCredentials(null);
  const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {} });
  let caught = null;
  try { await store.getToken(); } catch (error) { caught = error; }
  check("no grant and no account throws", caught !== null);
  check("the code is not_configured", caught?.code === "not_configured", caught?.code);
  const state = await store.state();
  check("state says it needs the account", state.needsAccount === true);
  check("state has no refresh token", state.hasRefreshToken === false);
  // Having no account is not a REFUSAL: no request was made and nothing went
  // wrong. Recording it as one wrote a throttle record on every fresh install
  // and told a first-time user they had done something wrong.
  check("an unconfigured store demands no user action", state.needsUserAction === false,
    String(state.needsUserAction));
  check("an unconfigured store serves no wait", state.retryAfterMs === null, String(state.retryAfterMs));
  check("an unconfigured store writes no throttle",
    await credentials.readRecord(THROTTLE_KEY) === undefined,
    JSON.stringify(await credentials.readRecord(THROTTLE_KEY)));
}

// --- 6. a refused token is never served again ----------------------------
{
  const credentials = fakeCredentials(grant(jwtExpiring(120), "r1", 7200));
  const stub = await makeTokenStub(accepted);
  await withNetwork(stub, async () => {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {} });
    const stored = await credentials.readRecord(KEY);
    const first = await store.getToken();
    check("the stored token is served first", first === stored.payload.accessToken);
    store.invalidate(first);
    const second = await store.getToken();
    check("a refused token is never served again", second !== first);
    check("refusing it triggers a renewal", stub.log.tokens === 1, `tokens=${stub.log.tokens}`);
    store.invalidate(first);
    await store.getToken();
    check("re-refusing the old token does not storm", stub.log.tokens === 1, `tokens=${stub.log.tokens}`);
  }).catch((error) => fail("a refused token is never served again", error));
}

// --- 7. a malformed stored record degrades, never throws ------------------
{
  const credentials = fakeCredentials({ kind: "grant", payload: { version: 99, accessToken: "x" } });
  const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {} });
  let caught = null;
  try { await store.getToken(); } catch (error) { caught = error; }
  check("an unknown record version is ignored", caught?.code === "not_configured", caught?.code);
}

// --- 8. saveAccount stores the username only, then logs in --------------
{
  const credentials = fakeCredentials(null);
  const stub = await makeTokenStub(accepted);
  let loginBody = null;
  const wrapped = async (url, init) => {
    if (String(url).includes("iam.sensecoreapi.cn")) loginBody = JSON.parse(String(init?.body ?? "{}"));
    return stub(url, init);
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = wrapped;
  try {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {} });
    await store.saveAccount({ username: "  user@x  ", password: "  secret  " });
    check("the username is trimmed", credentials.refs.get("SENSENOVA_USERNAME") === "user@x",
      String(credentials.refs.get("SENSENOVA_USERNAME")));
    // The password is NEVER persisted: only the username (an identifier) goes
    // into the credentials service. The password itself must still reach IAM
    // exactly as typed — the panel's "show" lets a trailing space be checked
    // by eye, and trimming it behind the user's back would make that check a
    // lie — but it rides this call in memory and is gone when it ends.
    check("the password is NOT written to the credentials service",
      credentials.refs.get("SENSENOVA_PASSWORD") === undefined,
      JSON.stringify(credentials.refs.get("SENSENOVA_PASSWORD")));
    check("the username is the only ref stored",
      [...credentials.refs.keys()].join(",") === "SENSENOVA_USERNAME",
      [...credentials.refs.keys()].join(","));
    check("a login was attempted", stub.log.logins === 1, `logins=${stub.log.logins}`);
    // The password must reach IAM sealed, never in the clear. RFC 7516 §3:
    // the compact JWE is five segments (header.encryptedKey.iv.ciphertext.tag).
    check("the password is sent encrypted", typeof loginBody?.password === "string"
      && loginBody.password.split(".").length === 5 && !loginBody.password.includes("secret"),
      String(loginBody?.password).slice(0, 24));
    check("the IAM call is flagged as encrypted", loginBody?.is_encrypt === true);
    const state = await store.state();
    check("a refresh token is held after saving", state.hasRefreshToken === true);
  } catch (error) {
    fail("saveAccount stores and logs in", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 8b. a locked account must NOT be retried on a poll timer -----------
// The reported failure: repeated automatic attempts turned one bad password
// into an 8-minute lockout. The store must honour the platform's own window.
{
  // The account arrives through the ENVIRONMENT — the only durable password
  // source; the store never reads a password from the credentials refs.
  const accountEnv = { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "wrong" };
  const credentials = fakeCredentials(null);
  // IAM answers with the exact envelope the platform sends for a lock.
  const locked = () => new Response(JSON.stringify({
    code: 9, message: "The account has been locked, please try again after 8 minutes",
    details: [
      { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "accountLocked" },
      { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en",
        message: "The account has been locked, please try again after 8 minutes" }
    ]
  }), { status: 400, headers: { "content-type": "application/json" } });
  const stub = await makeTokenStub(locked);
  await withNetwork(stub, async () => {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: accountEnv });
    let first = null;
    try { await store.getToken(); } catch (error) { first = error; }
    check("a locked account is classified as such", first?.code === "account_locked", String(first?.code));
    check("the platform's wait is carried on the error",
      first?.retryAfterMs === 8 * 60_000, String(first?.retryAfterMs));

    const loginsAfterFirst = stub.log.logins;
    // This is the poll loop: without a backoff, every 30 s poll would try
    // again and hold the account locked.
    for (let i = 0; i < 5; i += 1) {
      try { await store.getToken(); } catch { /* expected */ }
    }
    check("repeated polls do NOT re-attempt the login", stub.log.logins === loginsAfterFirst,
      `logins went ${loginsAfterFirst} -> ${stub.log.logins}`);

    const state = await store.state();
    check("the state reports the remaining wait", typeof state.retryAfterMs === "number" && state.retryAfterMs > 0,
      String(state.retryAfterMs));
    // A window the platform stated is taken at its word. Capping it would put
    // the next probe inside a lock that is still in force, which is the very
    // thing the wait exists to prevent.
    check("a stated window is not truncated by the local cap",
      state.retryAfterMs <= 8 * 60_000 + 1_000, String(state.retryAfterMs));
    check("a lockout asks for the user, not a countdown",
      state.needsUserAction !== true, String(state.needsUserAction));

    // A deliberate resubmit is the user acting on the message, so it must be
    // allowed through rather than refused by this store's own timer.
    const corrected = () => new Response(JSON.stringify({
      redirect: `https://platform.sensenova.cn/cb?code=c${issuedState !== "" ? `&state=${encodeURIComponent(issuedState)}` : ""}`
    }), { status: 200, headers: { "content-type": "application/json" } });
    globalThis.fetch = await makeTokenStub(corrected);
    await store.saveAccount({ username: "u", password: "right-now" });
    check("a corrected resubmit is allowed inside the wait", (await store.state()).hasRefreshToken === true,
      JSON.stringify(await store.state()));
  }).catch((error) => fail("a locked account is not retried on a timer", error));
}

// --- 8c. a wrong password is PARKED, not retried on a timer --------------
// A bad password does not become right by waiting, so a countdown is the wrong
// instrument: the panel must go back to asking for the account. This is the
// case that used to produce a steady one-minute trickle of attempts for as
// long as the panel stayed open.
{
  const accountEnv = { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "wrong" };
  const credentials = fakeCredentials(null);
  const vague = () => new Response(JSON.stringify({
    code: 3, message: "InvalidArgument",
    details: [{ reason: "invalidAccountOrPassword" }]
  }), { status: 400, headers: { "content-type": "application/json" } });
  const stub = await makeTokenStub(vague);
  await withNetwork(stub, async () => {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: accountEnv });
    let first = null;
    try { await store.getToken(); } catch (error) { first = error; }
    check("a wrong password still reports itself", first?.code === "login_rejected", String(first?.code));

    const after = stub.log.logins;
    // Days, not minutes: a parked refusal must survive any amount of polling.
    for (let i = 0; i < 50; i += 1) {
      try { await store.getToken(); } catch { /* expected */ }
    }
    check("a wrong password is never retried automatically", stub.log.logins === after,
      `logins went ${after} -> ${stub.log.logins}`);

    const state = await store.state();
    check("a parked refusal has no countdown", state.retryAfterMs === null, String(state.retryAfterMs));
    check("a parked refusal asks the user instead", state.needsUserAction === true, String(state.needsUserAction));

    // The one path that may retry is the user submitting a corrected password.
    globalThis.fetch = await makeTokenStub(accepted);
    await store.saveAccount({ username: "u", password: "right-now" });
    const fixed = await store.state();
    check("a corrected password is accepted", fixed.hasRefreshToken === true, JSON.stringify(fixed));
    check("the parked flag is cleared once sign-in works", fixed.needsUserAction === false,
      String(fixed.needsUserAction));
  }).catch((error) => fail("a wrong password is parked, not retried", error));
}

// --- 8d. a time-shaped refusal is waited out, then probed exactly once ----
// The gap the old suite left: every earlier poll happened INSIDE the window, so
// nothing proved what happens after it expires. A backoff that re-probes on
// every poll after expiry is the same bug wearing a delay.
{
  const accountEnv = { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "wrong" };
  const credentials = fakeCredentials(null);
  // A lock with no stated window, so the local backoff governs.
  const vagueLock = () => new Response(JSON.stringify({
    code: 9, message: "TooManyRequests",
    details: [{ reason: "tooManyAttempts" }]
  }), { status: 400, headers: { "content-type": "application/json" } });
  const stub = await makeTokenStub(vagueLock);
  // Offset from the real clock, not a bare epoch: nothing here writes an
  // expiry, but a tiny fake epoch would make any JWT in play look unexpired.
  let clock = Date.now();
  await withNetwork(stub, async () => {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: accountEnv, now: () => clock });
    try { await store.getToken(); } catch { /* expected */ }
    const afterFirst = stub.log.logins;

    // Still inside the first backoff.
    clock += DEFAULT_LOGIN_BACKOFF_MS - 1;
    try { await store.getToken(); } catch { /* expected */ }
    check("a poll one second before expiry still does not try", stub.log.logins === afterFirst,
      `logins went ${afterFirst} -> ${stub.log.logins}`);

    // The window closes: exactly one probe, not one per poll.
    clock += 2;
    try { await store.getToken(); } catch { /* expected */ }
    check("the expired window triggers exactly one probe", stub.log.logins === afterFirst + 1,
      `logins went ${afterFirst} -> ${stub.log.logins}`);
    const afterProbe = stub.log.logins;
    for (let i = 0; i < 10; i += 1) {
      try { await store.getToken(); } catch { /* expected */ }
    }
    check("the new window stops the storm again", stub.log.logins === afterProbe,
      `logins went ${afterProbe} -> ${stub.log.logins}`);

    // The backoff doubles, so the second window is longer than the first.
    const second = await store.state();
    check("the wait after the second refusal is longer than the first",
      second.retryAfterMs >= DEFAULT_LOGIN_BACKOFF_MS * 2 - 1_000, String(second.retryAfterMs));
    clock += DEFAULT_LOGIN_BACKOFF_MS;
    try { await store.getToken(); } catch { /* expected */ }
    check("a doubled backoff is honoured too", stub.log.logins === afterProbe,
      `logins went ${afterProbe} -> ${stub.log.logins}`);
  }).catch((error) => fail("an expired window is probed exactly once", error));
}

// --- 8e. a long stated window is waited out in full ----------------------
// The other gap: the old cap truncated a platform-stated window, so a
// two-hour lock was re-probed after thirty minutes — while still locked.
{
  const accountEnv = { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "p" };
  const credentials = fakeCredentials(null);
  const twoHours = () => new Response(JSON.stringify({
    code: 9, message: "The account has been locked, please try again after 2 hours",
    details: [{ reason: "accountLocked" }]
  }), { status: 400, headers: { "content-type": "application/json" } });
  const stub = await makeTokenStub(twoHours);
  let clock = Date.now();
  await withNetwork(stub, async () => {
    const store = createTokenStore({
      credentials, credentialKey: credentialKeyFn, env: accountEnv,
      throttleStore: createMemoryThrottleStore(() => clock), now: () => clock
    });
    let first = null;
    try { await store.getToken(); } catch (error) { first = error; }
    check("a two-hour window is read whole", first?.retryAfterMs === 2 * 3_600_000, String(first?.retryAfterMs));
    const afterFirst = stub.log.logins;

    // Half an hour in — exactly where the old cap used to give up and re-probe.
    clock += MAX_LOGIN_BACKOFF_MS + 60_000;
    try { await store.getToken(); } catch { /* expected */ }
    check("the old half-hour cap no longer truncates a two-hour lock",
      stub.log.logins === afterFirst, `logins went ${afterFirst} -> ${stub.log.logins}`);

    clock += 2 * 3_600_000 - MAX_LOGIN_BACKOFF_MS;
    try { await store.getToken(); } catch { /* expected */ }
    check("the lock is probed again only after it has expired",
      stub.log.logins === afterFirst + 1, `logins went ${afterFirst} -> ${stub.log.logins}`);
  }).catch((error) => fail("a long stated window is waited out in full", error));
}

// --- 8f. the throttle outlives the process that set it -------------------
// Two Host processes share one account. A wait kept only in memory lets the
// second one knock straight through it — which is how a wait turns back into
// a lockout.
{
  const accountEnv = { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "p" };
  const credentials = fakeCredentials(null);
  const locked = () => new Response(JSON.stringify({
    code: 9, message: "The account has been locked, please try again after 8 minutes",
    details: [{ reason: "accountLocked" }]
  }), { status: 400, headers: { "content-type": "application/json" } });
  const stub = await makeTokenStub(locked);
  // A real file, in a scratch directory: "outlives the process" is a claim
  // about the disk, and an injected in-memory store would prove nothing.
  const dir = mkdtempSync(join(tmpdir(), "dsh-throttle-shared-"));
  const shared = createFileThrottleStore({ dir });
  await withNetwork(stub, async () => {
    // Process A takes the refusal.
    const first = createTokenStore({
      credentials, credentialKey: credentialKeyFn, env: accountEnv, throttleStore: shared
    });
    try { await first.getToken(); } catch { /* expected */ }
    const afterA = stub.log.logins;
    check("the first process made one attempt", afterA === 1, `logins=${afterA}`);

    // Process B starts fresh, as it would after a Host restart.
    const second = createTokenStore({
      credentials, credentialKey: credentialKeyFn, env: accountEnv, throttleStore: shared
    });
    for (let i = 0; i < 3; i += 1) {
      try { await second.getToken(); } catch { /* expected */ }
    }
    check("a second process does not retry the wait", stub.log.logins === afterA,
      `logins went ${afterA} -> ${stub.log.logins}`);
    check("the second process sees the same wait",
      (await second.state()).retryAfterMs > 0, String((await second.state()).retryAfterMs));

    // The throttle is its own record, so clearing it must not touch the grant.
    const globalThisFetch = globalThis.fetch;
    globalThis.fetch = await makeTokenStub(accepted);
    await second.saveAccount({ username: "u", password: "right" });
    const state = await second.state();
    check("a corrected password clears the shared throttle",
      state.hasRefreshToken === true && state.retryAfterMs === null, JSON.stringify(state));
    // The throttle no longer shares the document with the grant at all, so
    // this is now trivially true — and worth keeping, because the pair of
    // addresses is exactly where the old design put a poison risk.
    check("the grant record survived the throttle's removal",
      (await credentials.records.has(KEY)) === true,
      `grant=${await credentials.records.has(KEY)}`);
    check("the throttle never entered the credentials document",
      (await credentials.records.has(THROTTLE_KEY)) === false);
    globalThis.fetch = globalThisFetch;
  }).catch((error) => fail("the throttle outlives the process", error));
  rmSync(dir, { recursive: true, force: true });
}

// --- 8g. a dead refresh token falls back to login only on a schedule ------
// This is the route that actually starts spending password attempts: a grant
// whose refresh token expired sends `acquire` to the password path, from
// inside an ordinary poll.
{
  // The grant must already be stale, and stale in BOTH places `parseGrant`
  // looks: the stored `expiresAt` and the token's own `exp`. It prefers the
  // stored value, and a negative one reads as "expiry unknown" — which the
  // store deliberately treats as fresh. So: a JWT expired five minutes ago,
  // and a stored `expiresAt` that agrees.
  const expiredJwt = jwtExpiring(-5);
  const credentials = fakeCredentials({
    kind: "grant",
    payload: {
      version: 1,
      accessToken: expiredJwt,
      refreshToken: "dead-refresh",
      expiresAt: Date.now() - 1000
    }
  });
  // The account rides the ENVIRONMENT (the only durable password source):
  // without an env password a dead refresh would simply reap the grant.
  const accountEnv = { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "p" };
  const refused = () => new Response(JSON.stringify({ error: "invalid_grant" }),
    { status: 400, headers: { "content-type": "application/json" } });
  const stub = await makeTokenStub(refused);
  // The clock is offset from the real one rather than set to an epoch: the
  // grant's expiry was written with `Date.now()`, so a small fake epoch would
  // make a long-expired token look valid for centuries.
  const base = Date.now();
  let clock = base;
  await withNetwork(async (url) => {
    // The refresh token is dead; the password is refused as a lock.
    if (String(url).includes("oauth2/token")) return refused();
    return stub(url);
  }, async () => {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: accountEnv, skewMs: 120_000, now: () => clock });
    try { await store.getToken(); } catch { /* expected */ }
    const afterFirst = stub.log.logins;
    check("the fallback to the password path happened once", afterFirst === 1, `logins=${afterFirst}`);

    for (let i = 0; i < 8; i += 1) {
      try { await store.getToken(); } catch { /* expected */ }
    }
    check("polls do not re-spend password attempts after a fallback", stub.log.logins === afterFirst,
      `logins went ${afterFirst} -> ${stub.log.logins}`);

    // Once the wait is served, the fallback may probe — but only once.
    clock += DEFAULT_LOGIN_BACKOFF_MS + 1;
    try { await store.getToken(); } catch { /* expected */ }
    check("a served wait allows exactly one fallback probe", stub.log.logins === afterFirst + 1,
      `logins went ${afterFirst} -> ${stub.log.logins}`);
  }).catch((error) => fail("a dead refresh token falls back on a schedule", error));
}

// --- 8h. a dead refresh with NO account reaps the grant -------------------
// After "forget account" the grant is meant to keep working until its refresh
// token dies. Once it does, there is no password to recover with: the grant is
// dead for good. It must then be REMOVED — not left as an ownerless pair in the
// credentials file and not re-hit against the token endpoint on every poll.
{
  const expiredJwt = jwtExpiring(-5);
  const credentials = fakeCredentials({
    kind: "grant",
    payload: { version: 1, accessToken: expiredJwt, refreshToken: "dead-refresh", expiresAt: Date.now() - 1000 }
    // Deliberately NO refs: no account stored to re-login with.
  });
  const stub = await makeTokenStub(accepted);
  let tokenCalls = 0;
  await withNetwork(async (url) => {
    if (String(url).includes("oauth2/token")) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ error: "invalid_grant" }),
        { status: 400, headers: { "content-type": "application/json" } });
    }
    return stub(url);
  }, async () => {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {}, skewMs: 120_000 });

    let first = null;
    try { await store.getToken(); } catch (error) { first = error; }
    check("the dead refresh is reported", first?.code === "refresh_rejected", String(first?.code));
    check("the unrecoverable grant is removed from the credentials service",
      (await credentials.readRecord(KEY)) === undefined,
      JSON.stringify(await credentials.readRecord(KEY)));
    const state = await store.state();
    check("after the reap the panel is unconfigured again",
      state.configured === false && state.needsAccount === true && state.hasRefreshToken === false,
      JSON.stringify(state));

    // Further polls must not re-hit the dead token endpoint: the grant is gone,
    // so the store goes straight to "not configured" instead of refreshing.
    for (let i = 0; i < 3; i += 1) {
      let code = null;
      try { await store.getToken(); } catch (error) { code = error?.code; }
      check(`poll ${i + 1} after the reap asks for an account`, code === "not_configured", String(code));
    }
    check("the dead refresh is hit exactly once, not once per poll", tokenCalls === 1, `tokenCalls=${tokenCalls}`);
    check("no password login is attempted without an account", stub.log.logins === 0, `logins=${stub.log.logins}`);
  }).catch((error) => fail("a dead refresh with no account reaps the grant", error));
}

// --- 9. saveAccount refuses an empty account before any network ---------
{
  const credentials = fakeCredentials(null);
  await withNetwork(async () => { throw new Error("must not call the network"); }, async () => {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {} });
    let code = null;
    try { await store.saveAccount({ username: "u", password: "  " }); } catch (error) { code = error?.code; }
    check("an empty account is refused", code === "missing_credentials", String(code));
    check("nothing is stored", credentials.refs.size === 0);
  }).catch((error) => fail("empty account is refused", error));
}

// --- 10. a rejected password leaves no grant ----------------------------
{
  const credentials = fakeCredentials(null);
  const stub = await makeTokenStub(refused);
  await withNetwork(stub, async () => {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {} });
    let code = null;
    try { await store.saveAccount({ username: "u", password: "bad" }); } catch (error) { code = error?.code; }
    check("a rejected password surfaces", code === "login_rejected", String(code));
    check("no grant exists after a rejected login", (await store.state()).hasRefreshToken === false);
    // The remediation's sharpest claim: a rejected password must leave nothing
    // at rest — only the username (an identifier) was persisted.
    check("a rejected password leaves nothing secret at rest",
      credentials.refs.get("SENSENOVA_PASSWORD") === undefined,
      JSON.stringify(credentials.refs.get("SENSENOVA_PASSWORD")));
  }).catch((error) => fail("a rejected password leaves no grant", error));
}

// --- 10c. a password left by a previous version is swept, not kept --------
// The remediation: earlier builds stored SENSENOVA_PASSWORD in the credentials
// service, so a plaintext password sat at rest in `~/.dsh/.credentials.yaml`.
// On first contact the store removes a legacy value; the environment remains
// the only durable password source.
{
  const credentials = fakeCredentials(null, {
    refs: { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "legacy-secret" }
  });
  const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {} });
  const state = await store.state();
  check("a legacy stored password is swept on first contact",
    credentials.refs.get("SENSENOVA_PASSWORD") === undefined,
    JSON.stringify(credentials.refs.get("SENSENOVA_PASSWORD")));
  check("the username survives the sweep", credentials.refs.get("SENSENOVA_USERNAME") === "u");
  check("with no env password the store cannot auto-recover",
    state.configured === false && state.hasAccount === true && state.needsAccount === true,
    JSON.stringify(state));
}

// --- 10b. switching accounts replaces a STILL-FRESH grant ---------------
// The bug this guards against: `store()` deferred to any existing grant whose
// access token still had >60s left whenever the caller passed no `replacing`
// token — and only a password login calls it that way. So signing in as a
// different account while the previous one's grant was still healthy silently
// kept the OLD account: the new refresh token was dropped, the panel reported
// "signed in", and it kept showing the previous account's quota until that
// refresh token died. A fresh password login is an explicit decision to
// supersede whatever is stored, so it must win.
{
  const tokenA = jwtExpiring(120);
  const credentials = fakeCredentials(grant(tokenA, "refresh-A", 7200));
  const stub = await makeTokenStub(accepted);
  await withNetwork(stub, async () => {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {} });
    await store.saveAccount({ username: "account-b", password: "pass-b" });

    const record = await credentials.readRecord(KEY);
    check("switching accounts replaces the access token",
      record.payload.accessToken !== tokenA,
      `old=${String(tokenA).slice(0, 12)} new=${String(record.payload.accessToken).slice(0, 12)}`);
    check("the old account's refresh token is not retained",
      record.payload.refreshToken === "rotated-1",
      String(record.payload.refreshToken));
    check("the new username is the one stored",
      credentials.refs.get("SENSENOVA_USERNAME") === "account-b");

    // The served token must be the new account's, reached from the cache with
    // no second sign-in — the old grant must not linger in this process either.
    const served = await store.getToken();
    check("getToken serves the new account, not the old grant",
      served === record.payload.accessToken,
      `served=${String(served).slice(0, 12)}`);
    check("reading it back spends no extra login", stub.log.logins === 1,
      `logins=${stub.log.logins}`);
  }).catch((error) => fail("switching accounts replaces a fresh grant", error));
}

// --- 11. forgetAccount clears the refs but keeps the grant --------------
{
  const credentials = fakeCredentials(grant(jwtExpiring(120), "keep", 7200), {
    refs: { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "p" }
  });
  const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {} });
  await store.forgetAccount();
  check("the username ref is gone", credentials.refs.get("SENSENOVA_USERNAME") === undefined);
  const state = await store.state();
  check("the account is forgotten", state.hasAccount === false);
  check("the grant survives the forget", state.hasRefreshToken === true);
  check("the panel is not asked for setup", state.needsAccount === false);
}

// --- 12. the environment alone still configures the account -------------
{
  const env = { SENSENOVA_USERNAME: "env-user", SENSENOVA_PASSWORD: "env-pass" };
  const credentials = fakeCredentials(null, { env });
  const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env });
  const state = await store.state();
  check("an env account is recognised", state.hasAccount === true, JSON.stringify(state));
  check("an env account needs no setup", state.needsAccount === false);
}

// --- 13. NO credentials service: the panel still signs in ----------------
// A Host without the service must not lock the user out; the account lives in
// this process's memory, and the state says so.
{
  const stub = await makeTokenStub(accepted);
  await withNetwork(stub, async () => {
    const store = createTokenStore({ credentials: null, credentialKey: credentialKeyFn, env: {} });
    const before = await store.state();
    check("an in-memory store starts unconfigured", before.configured === false, JSON.stringify(before));
    check("it asks for the account", before.needsAccount === true);
    check("it is marked ephemeral", before.ephemeral === true, String(before.ephemeral));

    await store.saveAccount({ username: "u", password: "p" });
    const after = await store.state();
    check("the in-memory account is accepted", after.hasAccount === true, JSON.stringify(after));
    check("a token was obtained", after.configured === true);
    check("it stays marked ephemeral", after.ephemeral === true);

    const first = await store.getToken();
    store.invalidate(first);
    const second = await store.getToken();
    check("a refused in-memory token is replaced", second !== first);
    check("renewal used the refresh token, not a login", stub.log.tokens === 2 && stub.log.logins === 1,
      `tokens=${stub.log.tokens} logins=${stub.log.logins}`);

    await store.forgetAccount();
    check("forget works in memory", (await store.state()).hasAccount === false);
  }).catch((error) => fail("a Host without credentials can still sign in", error));
}

// --- 14. a store WITH the service is not ephemeral ----------------------
{
  const credentials = fakeCredentials(null);
  const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {} });
  const state = await store.state();
  check("a store with the service is not ephemeral", state.ephemeral === false, String(state.ephemeral));
  check("credentialRef yields the plain name", credentialRef("SENSENOVA_USERNAME") === "SENSENOVA_USERNAME");
  check("the record key is the namespaced pair", KEY === "dsh-connect-sensenova-token-plan/sensenova-console", KEY);
}

// --- 15. what this store writes must parse under the REAL credentials service
// A `kind: "throttle"` record poisoned C:\Users\...\.credentials.yaml for every
// plugin on the machine: the local provider throws while reading it, the
// required `credentials` service fails to activate, and the whole Host —
// desktop and web — refuses to start. So this does not test our own reading of
// the record; it feeds what we WRITE through parseCredentialsDocument, the very
// function that crashed.
// The throttle no longer goes anywhere near that document, so this keeps the
// two claims the move rests on: what we DO still write there parses, and what
// we stopped writing there would not have.
{
  // The account arrives through the ENVIRONMENT (the only durable password
  // source), so the refusal actually happens and lands in the throttle.
  const accountEnv = { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "wrong" };
  const credentials = fakeCredentials(null);
  const locked = () => new Response(JSON.stringify({
    code: 9, message: "The account has been locked, please try again after 8 minutes",
    details: [{ reason: "accountLocked" }]
  }), { status: 400, headers: { "content-type": "application/json" } });
  const stub = await makeTokenStub(locked);
  const own = createMemoryThrottleStore();
  await withNetwork(stub, async () => {
    const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: accountEnv, throttleStore: own });
    try { await store.getToken(); } catch { /* the expected refusal */ }

    // The point of the move: a refusal is this plugin's business, and nothing
    // about it can make another plugin's credentials file unreadable.
    check("a refusal no longer writes into the credentials service",
      (await credentials.readRecord(THROTTLE_KEY)) === undefined,
      JSON.stringify(await credentials.readRecord(THROTTLE_KEY)));
    check("it lands in the plugin's own store instead",
      (await own.read())?.code === "account_locked", JSON.stringify(await own.read()));

    // What IS still written there — the grant — has to survive the parser.
    const document = {
      version: 1,
      records: { [KEY]: grant(jwtExpiring(120), "keep-me", 7200) },
      refs: { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "wrong" }
    };
    let parsed = null;
    let error = null;
    try {
      parsed = parseCredentialsDocument(yaml.stringify(document), ".credentials.yaml");
    } catch (caught) {
      error = String(caught?.message ?? caught);
    }
    check("the real credentials parser accepts the grant we write", error === null, error);
    check("the grant survives the parse",
      parsed?.records.get(KEY)?.kind === "grant",
      error ?? JSON.stringify([...(parsed?.records?.keys() ?? [])]));

    // Still strict enough to have caught the original bug — without this the
    // checks above could pass for the wrong reason. It is also the record of
    // why `kind: "throttle"` was never an option.
    let poisonRejected = false;
    try {
      parseCredentialsDocument(yaml.stringify({
        version: 1,
        records: { [THROTTLE_KEY]: { kind: "throttle", payload: { version: 1 } } },
        refs: {}
      }), ".credentials.yaml");
    } catch {
      poisonRejected = true;
    }
    check("a private kind is still rejected by the parser (the original bug)",
      poisonRejected);

    const second = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: accountEnv, throttleStore: own });
    try { await second.getToken(); } catch { /* refused again, fast */ }
    check("a second store reads the persisted throttle instead of re-attempting",
      stub.log.logins === 1, `logins=${stub.log.logins}`);
    check("the persisted throttle still reports its wait",
      (await second.state()).retryAfterMs > 0, String((await second.state()).retryAfterMs));
  }).catch((error) => fail("the written records parse under the real service", error));
}

// --- 16. a throttle parked by the previous version is adopted, not lost ===
// A parked refusal has no deadline. Losing one across an upgrade means the next
// poll retries a password the user has not changed, which is how one wrong
// password becomes a locked account — the exact thing the throttle exists to
// prevent. So the old record is read once and taken over.
{
  const legacy = {
    kind: "grant",
    payload: {
      version: 1, marker: "signin-throttle", code: "login_rejected",
      parked: true, until: null, attempt: 1
    }
  };
  const credentials = fakeCredentials(null, {
    refs: { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "wrong" }
  });
  // Planted by hand: this is the shape the PREVIOUS version left on disk, and
  // no code path writes it any more.
  credentials.records.set(THROTTLE_KEY, legacy);
  const own = createMemoryThrottleStore();
  const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {}, throttleStore: own });
  const state = await store.state();
  check("a parked refusal from the previous version still holds",
    state.needsUserAction === true, JSON.stringify(state));
  check("it is adopted into the plugin's own store",
    (await own.read())?.parked === true, JSON.stringify(await own.read()));
  check("the old record is deleted, so this happens once",
    (await credentials.readRecord(THROTTLE_KEY)) === undefined);
}

// --- 16b. a grant saved under the pre-rename namespace is adopted ----------
// Renaming the plugin must not log the user out: a console grant (and its
// refresh token) saved under the old namespace is moved to the current one
// exactly once, and the old record deleted.
{
  const legacyKey = credentialKey("dsh-llm-rate-panel", "sensenova-console");
  const credentials = fakeCredentials(null);
  credentials.records.set(legacyKey, grant(jwtExpiring(120), "keep-me", 7200));
  const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {} });
  const state = await store.state();
  check("a grant from the pre-rename namespace still configures the panel",
    state.configured === true && state.hasRefreshToken === true, JSON.stringify(state));
  check("it was moved to the current namespace",
    (await credentials.readRecord(KEY))?.payload?.refreshToken === "keep-me",
    JSON.stringify(await credentials.readRecord(KEY)));
  check("the legacy record is deleted, so this runs once",
    (await credentials.readRecord(legacyKey)) === undefined);
  // The adopted grant is live, not just visible: a fresh grant is returned
  // without any network call, so this needs no stub.
  const token = await store.getToken();
  check("the adopted grant serves tokens",
    typeof token === "string" && token !== "", String(token).slice(0, 20));
}

// --- 16c. a parked refusal under the pre-rename namespace is adopted --------
// Same guarantee as 16, for a record a previous version left under the OLD
// namespace: the rename must not turn a parked wrong-password into a timer
// that retries it.
{
  const legacyKey = credentialKey("dsh-llm-rate-panel", THROTTLE_ID);
  const credentials = fakeCredentials(null, {
    refs: { SENSENOVA_USERNAME: "u", SENSENOVA_PASSWORD: "wrong" }
  });
  credentials.records.set(legacyKey, {
    kind: "grant",
    payload: {
      version: 1, marker: "signin-throttle", code: "login_rejected",
      parked: true, until: null, attempt: 1
    }
  });
  const own = createMemoryThrottleStore();
  const store = createTokenStore({ credentials, credentialKey: credentialKeyFn, env: {}, throttleStore: own });
  const state = await store.state();
  check("a parked refusal from the pre-rename namespace still holds",
    state.needsUserAction === true, JSON.stringify(state));
  check("it is adopted into the plugin's own store",
    (await own.read())?.parked === true, JSON.stringify(await own.read()));
  check("the legacy record is deleted, so this happens once",
    (await credentials.readRecord(legacyKey)) === undefined);
}

// --- 16d. a throttle file under the pre-rename state directory is adopted ---
// The file-backed store moved directories with the rename. A parked refusal in
// the OLD directory must be moved over on first contact — and a cleared
// throttle must stay cleared under both names.
{
  const home = mkdtempSync(join(tmpdir(), "dsh-rename-home-"));
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const legacyDir = join(home, "state", "dsh-llm-rate-panel");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "throttle.json"),
      JSON.stringify({ version: 1, code: "login_rejected", parked: true, until: null, attempt: 1 }) + "\n",
      { encoding: "utf8" });
    // Default dir resolves under the (temporarily re-pointed) Home.
    const store = createFileThrottleStore();
    check("a parked refusal from the pre-rename state dir still holds",
      (await store.read())?.parked === true, JSON.stringify(await store.read()));
    const newFile = join(home, "state", "dsh-connect-sensenova-token-plan", "throttle.json");
    check("it was moved to the current state dir", existsSync(newFile), newFile);
    check("the legacy file is gone", !existsSync(join(legacyDir, "throttle.json")));
    // clear() must also sweep a legacy file that was never adopted: a cleared
    // throttle under the new name must not resurrect under the old one.
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "throttle.json"),
      JSON.stringify({ version: 1, code: "account_locked", parked: false, until: 9_999_999_999, attempt: 1 }) + "\n",
      { encoding: "utf8" });
    const clearing = createFileThrottleStore();
    await clearing.clear();
    check("clear() sweeps an unadopted legacy file",
      !existsSync(join(legacyDir, "throttle.json")));
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
}

// --- 17. the file-backed store survives a second process -----------------
// The throttle exists so that another Host process sees a lock this one is
// waiting out, which an in-memory store cannot do. This is the whole reason it
// is on disk at all.
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-throttle-"));
  const first = createFileThrottleStore({ dir, now: () => 1_000 });
  await first.write({ code: "account_locked", parked: false, until: 2_000, attempt: 1 });
  const second = createFileThrottleStore({ dir, now: () => 1_500 });
  check("a second process reads the throttle the first wrote",
    (await second.read())?.code === "account_locked", JSON.stringify(await second.read()));
  const later = createFileThrottleStore({ dir, now: () => 2_500 });
  check("a window that has closed reads as no throttle", (await later.read()) === null,
    JSON.stringify(await later.read()));
  await second.clear();
  check("clearing it removes it for everyone", (await first.read()) === null);
  rmSync(dir, { recursive: true, force: true });
}

// --- 18. the plugin's credentialKey shim equals the real peer function ----
// `index.js` hand-rolls credentialKey so it runs without the peer package; this
// is the machine where that peer DOES resolve, so compare them directly. The
// literal shape is pinned on every machine by config.test.mjs; here the peer's
// own output is the reference. If the service ever changes its address format,
// this goes red instead of the panel quietly losing its stored grant.
{
  const { credentialKey: shim } = await import("../src/host/index.ts");
  for (const [scope, id] of [
    ["dsh-connect-sensenova-token-plan", "sensenova-console"],
    ["dsh-connect-sensenova-token-plan", THROTTLE_ID],
    ["dsh-llm-rate-panel", "sensenova-console"]
  ]) {
    check(`the shim matches the peer credentialKey for ${scope}/${id}`,
      shim(scope, id) === credentialKey(scope, id),
      `shim="${shim(scope, id)}" peer="${credentialKey(scope, id)}"`);
  }
}

// --- 19. autoRecoverArmed: 只报布尔，不回显值 -------------------------------
// `state()` 报告环境里有没有自动恢复密码（`SENSENOVA_PASSWORD`），供面板显示
// "refresh 失效后自动重登 / 需手动重登"。红线：值本身绝不能出 store——
// 断言序列化后的 state 不含密码文本，也没有 password/secret 键。
{
  const plainStore = createTokenStore({ credentials: fakeCredentials(null), credentialKey: credentialKeyFn, env: {} });
  const armedStore = createTokenStore({
    credentials: fakeCredentials(null),
    credentialKey: credentialKeyFn,
    env: { SENSENOVA_PASSWORD: "hunter2-秘密" }
  });
  const blankStore = createTokenStore({
    credentials: fakeCredentials(null),
    credentialKey: credentialKeyFn,
    env: { SENSENOVA_PASSWORD: "   " }
  });

  const plain = await plainStore.state();
  const armed = await armedStore.state();
  check("no env password -> auto-recover is not armed", plain.autoRecoverArmed === false, JSON.stringify(plain));
  check("env password present -> armed", armed.autoRecoverArmed === true);
  check("a blank env password is not armed", (await blankStore.state()).autoRecoverArmed === false);

  const serialized = JSON.stringify(armed);
  const keys = Object.keys(armed);
  check("the password value is never echoed (boolean only)",
    !serialized.includes("hunter2") && !serialized.includes("秘密") &&
      !serialized.includes("SENSENOVA_PASSWORD") && !keys.some((k) => /password|secret/i.test(k)),
    `${serialized.slice(0, 100)} keys=${keys.join(",")}`);
}

// --- purgeGrant: a read failure must not be read as "safe to delete" -------
// The compare-and-reap gate exists for ONE scenario: two Host processes sharing
// this credentials document (PITFALLS §22 — desktop runs an installed copy, web
// symlinks the source tree), where the other process has already rotated the
// refresh token and written a HEALTHY grant. Deleting unconditionally silently
// signed both out, so the gate reaps only if the record is still the dead token.
//
// Its old shape folded a read FAILURE into "record absent" via
// `.catch(() => undefined)`, and `undefined` is not `onDisk.accessToken !==
// accessToken`, so it fell through to `delete` — the gate opened precisely in
// the racing case it was built for, whenever the document could not be read at
// that instant (concurrent rewrite, EACCES, half-parsed YAML). A stale grant
// costs one failed request the caller is already handling; a deleted one costs
// the user a silent sign-out, so the conservative direction is to leave it.
{
  try {
    // The case under test: the document cannot be read right now.
    const unreadable = fakeCredentials(grant("AT-new", "RT-new", 60));
    unreadable.readRecord = async () => {
      throw new Error("EACCES: the credentials document is being rewritten");
    };
    const s1 = { cached: null, rejected: new Set() };
    await purgeGrant({ backend: () => unreadable, key: KEY }, s1, "AT-old");
    check("purgeGrant leaves the record alone when it cannot read it",
      unreadable.records.has(KEY),
      `records=${[...unreadable.records.keys()].join(",") || "(empty)"}`);

    // Control 1: readable and ROTATED by the other process — not deleted, adopted.
    const rotated = fakeCredentials(grant("AT-new", "RT-new", 60));
    const s2 = { cached: null, rejected: new Set() };
    await purgeGrant({ backend: () => rotated, key: KEY }, s2, "AT-old");
    check("purgeGrant keeps a grant another process has already rotated",
      rotated.records.has(KEY) && s2.cached?.accessToken === "AT-new",
      `has=${rotated.records.has(KEY)} cached=${s2.cached?.accessToken}`);

    // Control 2: readable and still the dead token — deleted, as intended.
    const dead = fakeCredentials(grant("AT-old", "RT-old", 60));
    const s3 = { cached: null, rejected: new Set() };
    await purgeGrant({ backend: () => dead, key: KEY }, s3, "AT-old");
    check("purgeGrant still reaps a grant that is the dead token",
      !dead.records.has(KEY), `records=${[...dead.records.keys()].join(",") || "(empty)"}`);
  } catch (error) {
    fail("purgeGrant does not reap what it cannot read", error);
  }
}

// The store is exercised against stubbed platform responses; nothing here may
// reach the real one. See the same guard in test/auth.test.mjs.
const unstubbed = releaseNetworkGuard();
check("no check escaped its stub to the network", unstubbed.length === 0, unstubbed.join(", "));

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

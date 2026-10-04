/**
 * Offline checks for sensenova-auth.js.
 *
 * Every request in this file is served by a stub, and every key is generated
 * here: no account credential is used, and nothing leaves the machine. The
 * platform's own JWKS is a separate, explicitly-invoked check — see
 * `test/live-jwks.test.mjs` and `npm run test:live` — so that "the suite is
 * offline" stays a property you can rely on rather than a claim.
 */
import { readJwtClaims, readJwtExpiry, createAuth } from "../src/host/sensenova-auth.ts";
import { createTrace } from "../src/host/auth-trace.ts";
import { sealPassword, createJwksCache } from "../src/host/sensenova-crypto.ts";
import { installNetworkGuard } from "./peer-roots.mjs";
import {
  AUTH_FAILURE_CODES, CODE, CREDENTIAL_REFUSALS,
  IAM_REASON_CODES, isAuthFailure, isCredentialRefusal
} from "../src/host/codes.ts";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();

// The crypto primitives moved to sensenova-crypto.js, so the seal checks pull
// them from there and hand in the endpoint/key the stub answers on.
const TEST_JWKS_ENDPOINT = "https://signin.sensecore.cn/.well-known/jwks.json";
const TEST_ENC_KEY_ID = "public:hydra.openid.id-token";
const sealOptions = { jwksEndpoint: TEST_JWKS_ENDPOINT, encKeyId: TEST_ENC_KEY_ID };

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

/** Decrypt a compact JWE, verifying the AAD binding, to prove well-formedness. */
async function decryptJwe(jwe, privateJwk) {
  // RFC 7516 §3: compact serialization is FIVE segments, the GCM tag detached.
  const segments = jwe.split(".");
  if (segments.length !== 5) throw new Error(`expected 5 compact segments, got ${segments.length}`);
  const [header, encryptedKey, iv, ciphertext, tag] = segments;
  const protectedJson = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  if (protectedJson.alg !== "RSA-OAEP" || protectedJson.enc !== "A256GCM") {
    throw new Error(`unexpected header: ${JSON.stringify(protectedJson)}`);
  }
  const key = await crypto.subtle.importKey(
    "jwk", privateJwk, { name: "RSA-OAEP", hash: "SHA-1" }, false, ["decrypt"]
  );
  const cek = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, Buffer.from(encryptedKey, "base64url"));
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(iv, "base64url"),
      additionalData: new TextEncoder().encode(header),
      tagLength: 128
    },
    await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]),
    // Rejoin ciphertext and the detached tag: WebCrypto decrypts both at once.
    Buffer.concat([Buffer.from(ciphertext, "base64url"), Buffer.from(tag, "base64url")])
  );
  return new TextDecoder().decode(plain);
}

/** A throwaway RSA public key for stubbed JWKS responses. */
async function stubKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true, ["encrypt", "decrypt"]
  );
  return {
    pair,
    jwk: await crypto.subtle.exportKey("jwk", pair.publicKey)
  };
}

// --- 1. compact JWE shape, against a locally generated key ----------------
// The structural claims (4 segments, the algorithm pair, a 12-byte IV, a
// 16-byte GCM tag, a modulus-width key wrap rather than a password-sized
// blob) hold for any conforming key, so they are asserted offline. The
// platform's actual key is checked separately by `npm run test:live`, which
// must never be part of a default run.
{
  const { jwk } = await stubKey();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    return realFetch(url, init);
  };
  try {
    // No module-reload hack: the JWKS cache is per-call now, so a fresh seal
    // needs no clean slate forced through `import("...?shape=…")`.
    const sealed = await sealPassword("structural-probe", sealOptions);
    const seg = sealed.split(".");
    // RFC 7516 §3: five segments — header.encryptedKey.iv.ciphertext.tag.
    check("seal has 5 compact segments", seg.length === 5, `got ${seg.length}`);
    check("seal header decodes", (() => {
      try {
        const h = JSON.parse(Buffer.from(seg[0], "base64url").toString("utf8"));
        return h.alg === "RSA-OAEP" && h.enc === "A256GCM";
      } catch {
        return false;
      }
    })(), seg[0]?.slice(0, 40) ?? "");
    // The stub key is 2048-bit, so the wrapped CEK is 256 bytes; the point is
    // that the segment carries a modulus-width wrap, not a password-sized blob.
    const ek = Buffer.from(seg[1], "base64url").length;
    check("encrypted key wraps the CEK at modulus width", ek === 256, String(ek));
    check("encrypted key is not the password", ek > "structural-probe".length);
    check("iv is 12 bytes", Buffer.from(seg[2], "base64url").length === 12);
    check("ciphertext is exactly the plaintext length",
      Buffer.from(seg[3], "base64url").length === "structural-probe".length);
    check("tag is detached and 16 bytes",
      Buffer.from(seg[4], "base64url").length === 16);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 2. round-trip with a known private key ------------------------------
{
  const { jwk, pair } = await stubKey();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    return realFetch(url, init);
  };
  try {
    const sealed = await sealPassword("correct horse battery staple", sealOptions);
    const plain = await decryptJwe(sealed, await crypto.subtle.exportKey("jwk", pair.privateKey));
    check("JWE round-trips to the original password", plain === "correct horse battery staple", plain.slice(0, 12));
    const again = await sealPassword("correct horse battery staple", sealOptions);
    check("each seal uses a fresh CEK/IV", sealed !== again);
  } catch (error) {
    fail("JWE round-trips to the original password", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 2b. the JWKS cache is per-instance, not module-level -----------------
// The seal used to read a single module-level `Map`, so two callers shared one
// cached key set — the same class of cross-caller leak the throttle file had,
// and it forced a test that wanted a clean cache to reload the whole module. Now
// each caller hands in its own cache (createAuth builds one into cfg). Assert the
// three properties that matter: reuse within one cache, isolation between two,
// and no fetch at all on a cold default.
{
  const { jwk } = await stubKey();
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("jwks.json")) {
      fetches += 1;
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: TEST_ENC_KEY_ID, use: "sig" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch in the cache check: ${url}`);
  };
  try {
    // Reuse: two seals through ONE cache hit the endpoint once.
    const shared = createJwksCache();
    await sealPassword("a", { ...sealOptions, cache: shared });
    await sealPassword("b", { ...sealOptions, cache: shared });
    check("one cache serves two seals with a single fetch", fetches === 1, `fetches=${fetches}`);

    // Isolation: a DIFFERENT cache does not see the first one's entry.
    fetches = 0;
    await sealPassword("c", { ...sealOptions, cache: createJwksCache() });
    check("a fresh cache refetches rather than reusing another instance's", fetches === 1, `fetches=${fetches}`);

    // Per-endpoint keying survives inside one cache: two mirrors, two fetches.
    fetches = 0;
    const multi = createJwksCache();
    await sealPassword("d", { jwksEndpoint: "https://mirror-a/.well-known/jwks.json", encKeyId: TEST_ENC_KEY_ID, cache: multi });
    await sealPassword("e", { jwksEndpoint: "https://mirror-b/.well-known/jwks.json", encKeyId: TEST_ENC_KEY_ID, cache: multi });
    check("one cache keyed by endpoint keeps two mirrors apart", fetches === 2, `fetches=${fetches}`);

    // createAuth gives each instance its own cache object.
    const authA = createAuth({ jwksEndpoint: TEST_JWKS_ENDPOINT });
    const authB = createAuth({ jwksEndpoint: TEST_JWKS_ENDPOINT });
    check("two auth instances own distinct JWKS caches",
      authA.getConfig().jwksCache !== authB.getConfig().jwksCache && authA.getConfig().jwksCache instanceof Map);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 3. JWT claim reading (pure) ------------------------------------------
const payload = Buffer.from(
  JSON.stringify({ exp: 1790518985, scp: "openid offline offline_access" })
).toString("base64url");
const token = `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
check("reads exp claim", readJwtClaims(token).exp === 1790518985);
check("reads scp claim", readJwtClaims(token).scp === "openid offline offline_access");
check("expiry converts to epoch millis", readJwtExpiry(token) === 1790518985 * 1000);
check("garbage token yields no claims", Object.keys(readJwtClaims("not-a-jwt")).length === 0);
check("empty token yields null expiry", readJwtExpiry("") === null);

// --- 4. PKCE regression: digest is async ---------------------------------
// `subtle.digest` returns a Promise. Encoding that Promise as if it were
// bytes throws ERR_INVALID_ARG_TYPE, and it only surfaces on the real login
// path — so assert both the correct value and the shape of the trap.
{
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  ).toString("base64url");
  // RFC 7636 appendix B test vector.
  check("S256 matches the RFC 7636 vector", expected === "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", expected);
  check("a digest Promise is not encodable as bytes", (() => {
    try {
      Buffer.from(crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      return false;
    } catch {
      return true;
    }
  })());
}

// --- 5. the login path runs end to end against a stubbed platform --------
// This is the regression guard for the Promise bug: login() must reach its
// first network call instead of throwing a TypeError.
{
  const { jwk } = await stubKey();
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    seen.push(target);
    if (target.includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    if (target.includes("/oauth2/auth")) {
      return new Response("", {
        status: 302,
        headers: {
          location: "https://platform.sensenova.cn/login?login_challenge=chal-123",
          "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
        }
      });
    }
    if (target.includes("iam.sensecoreapi.cn")) {
      // The real envelope: a generic top-level message with the actual cause
      // in details[].reason, exactly as IAM sends it.
      return new Response(JSON.stringify({
        code: 3, message: "InvalidArgument",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "invalidAccountOrPassword", domain: "iam" },
          { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en", message: "invalid account or password" },
          { "@type": "type.googleapis.com/sensetime.core.higgs.error_detail.v1.LogInfo", log_id: "01a0", track_id: "5f08", level: "UNSPECIFIED" }
        ]
      }), {
        status: 400, headers: { "content-type": "application/json" }
      });
    }
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  };
  try {
    const mod = await import(`../src/host/sensenova-auth.ts?login=${Date.now()}`);
    let code = null;
    let message = "";
    try {
      await mod.createAuth().login({ username: "u", password: "p" });
    } catch (error) {
      code = error?.code ?? error?.name ?? "unknown";
      message = String(error?.message ?? "");
    }
    check("login reaches the authorization endpoint", seen.some((u) => u.includes("/oauth2/auth")),
      seen.slice(0, 3).join(" | ").slice(0, 120));
    check("login does not fail on a type error", code !== "TypeError", String(code));
    // A wrong password must be distinguishable from every other refusal.
    check("a wrong password classifies as login_rejected", code === "login_rejected", String(code));
    check("the platform's specific message is used, not the generic status",
      message.includes("invalid account or password"), message);
    check("the generic status string is not what the user is shown",
      !message.includes("InvalidArgument"), message);
    check("log and track ids do not leak into the message",
      !message.includes("01a0") && !message.includes("5f08"), message);
  } catch (error) {
    fail("login reaches the authorization endpoint", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 5a. the generated PKCE verifier must actually be redeemable ---------
// A verifier that is too short is refused by the token endpoint with an
// `invalid_grant` whose hint names the length and nothing about the code that
// produced it — which is how an 11-character verifier shipped: every other
// test passed, and the only symptom was an opaque refusal on a login whose
// username and password were correct. Asserted at the point of creation,
// because that is the only place the cause is still legible.
{
  const { jwk } = await stubKey();
  const realFetch = globalThis.fetch;
  let authorizeUrl = "";
  let issuedState = "";
  let tokenBody = "";
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/oauth2/auth")) {
      authorizeUrl = target;
      issuedState = new URL(target).searchParams.get("state") ?? "";
      return new Response("", {
        status: 302,
        headers: { location: "https://platform.sensenova.cn/login?login_challenge=chal-1", "set-cookie": "a=b; Path=/" }
      });
    }
    if (target.includes("iam.sensecoreapi.cn")) {
      // Echo the state the authorization request issued — a real platform
      // round-trips it, and the flow now verifies the round-trip.
      const echo = issuedState !== "" ? `&state=${encodeURIComponent(issuedState)}` : "";
      return new Response(JSON.stringify({ redirect: `https://platform.sensenova.cn/?code=code-1${echo}` }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/oauth2/token")) {
      tokenBody = String(init.body ?? "");
      return new Response(JSON.stringify({ access_token: "a.b.c", refresh_token: "r", expires_in: 10800 }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  };
  try {
    const mod = await import(`../src/host/sensenova-auth.ts?pkce=${Date.now()}`);
    await mod.createAuth().login({ username: "u", password: "p" });
    const sent = new URLSearchParams(tokenBody);
    const verifier = sent.get("code_verifier") ?? "";
    check("a code_verifier is sent to the token endpoint", verifier !== "", `body=${tokenBody.slice(0, 160)}`);
    // RFC 7636 §4.1: 43 to 128 characters. This is the assertion the bug
    // missed — the old verifier was 11.
    check("the verifier is at least 43 characters", verifier.length >= 43, `length=${verifier.length}`);
    check("the verifier is at most 128 characters", verifier.length <= 128, `length=${verifier.length}`);
    check("the verifier uses only unreserved characters", /^[A-Za-z0-9\-._~]+$/.test(verifier), verifier);
    const challenge = new URL(authorizeUrl).searchParams.get("code_challenge") ?? "";
    const expected = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
      .toString("base64url");
    check("the verifier hashes to the challenge that was sent (S256)", challenge === expected,
      `challenge=${challenge} expected=${expected}`);
    check("the challenge method is S256",
      new URL(authorizeUrl).searchParams.get("code_challenge_method") === "S256");
  } catch (error) {
    fail("the generated PKCE verifier is redeemable", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 5b. other refusals are NOT reported as a wrong password -------------
// Every IAM failure used to collapse into one message, so a locked account or
// a rate limit told the user to retype a password that was fine.
{
  const { jwk } = await stubKey();
  const refusals = [
    ["a locked account", { reason: "accountLocked" }, "account_locked"],
    ["a rate limit", { reason: "tooManyAttempts" }, "rate_limited"],
    ["a required captcha", { reason: "captchaRequired" }, "verification_required"]
  ];  for (const [label, detail, expected] of refusals) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("jwks.json")) {
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/oauth2/auth")) {
        return new Response("", {
          status: 302,
          headers: {
            location: "https://platform.sensenova.cn/login?login_challenge=chal",
            "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
          }
        });
      }
      if (target.includes("iam.sensecoreapi.cn")) {
        return new Response(JSON.stringify({ code: 9, message: "FailedPrecondition", details: [detail] }), {
          status: 400, headers: { "content-type": "application/json" }
        });
      }
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    };
    try {
      const mod = await import(`../src/host/sensenova-auth.ts?refusal=${Date.now()}`);
      let code = null;
      try { await mod.createAuth().login({ username: "u", password: "p" }); } catch (error) { code = error?.code; }
      check(`${label} is not reported as a wrong password`, code === expected, String(code));
    } catch (error) {
      fail(`${label} is classified`, error);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

// --- 5c. the platform's wait is read in either language ------------------
// A window that goes unread is a refusal with no stated deadline, which falls
// back to a local backoff and so re-probes a lock that is still in force. The
// platform serves its message in the caller's language, so both must parse.
{
  const { jwk } = await stubKey();
  const windows = [
    ["8 minutes, English", "The account has been locked, please try again after 8 minutes", 8 * 60_000],
    ["2 hours, English", "The account has been locked, please try again after 2 hours", 2 * 3_600_000],
    ["45 seconds, English", "Too many attempts, please try again after 45 seconds", 45_000],
    ["8 分钟, Chinese", "账号已被锁定，请 8 分钟后重试", 8 * 60_000],
    ["2 小时, Chinese", "账号已被锁定，请 2 小时后重试", 2 * 3_600_000],
    ["30 秒, Chinese", "尝试过于频繁，请 30 秒后重试", 30_000],
    ["a bare 分 reads as minutes", "请 5 分后重试", 5 * 60_000]
  ];
  for (const [label, message, expected] of windows) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("jwks.json")) {
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/oauth2/auth")) {
        return new Response("", {
          status: 302,
          headers: {
            location: "https://platform.sensenova.cn/login?login_challenge=chal",
            "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
          }
        });
      }
      if (target.includes("iam.sensecoreapi.cn")) {
        return new Response(JSON.stringify({
          code: 9, message,
          details: [{ reason: "accountLocked" }]
        }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    };
    try {
      const mod = await import(`../src/host/sensenova-auth.ts?window=${Date.now()}-${Math.random()}`);
      let retryAfterMs;
      try { await mod.createAuth().login({ username: "u", password: "p" }); } catch (error) { retryAfterMs = error?.retryAfterMs; }
      check(`${label} yields its wait`, retryAfterMs === expected, String(retryAfterMs));
    } catch (error) {
      fail(`${label} yields its wait`, error);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // A Retry-After header is the authoritative form and needs no prose.
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("jwks.json")) {
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/oauth2/auth")) {
        return new Response("", {
          status: 302,
          headers: {
            location: "https://platform.sensenova.cn/login?login_challenge=chal",
            "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
          }
        });
      }
      if (target.includes("iam.sensecoreapi.cn")) {
        return new Response(JSON.stringify({ code: 9, message: "TooManyRequests", details: [{ reason: "tooManyAttempts" }] }), {
          status: 429, headers: { "content-type": "application/json", "retry-after": "600" }
        });
      }
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    };
    try {
      const mod = await import(`../src/host/sensenova-auth.ts?header=${Date.now()}-${Math.random()}`);
      let retryAfterMs;
      try { await mod.createAuth().login({ username: "u", password: "p" }); } catch (error) { retryAfterMs = error?.retryAfterMs; }
      check("a Retry-After header is read as seconds", retryAfterMs === 600_000, String(retryAfterMs));
    } catch (error) {
      fail("a Retry-After header is read as seconds", error);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // Retry-After may also be an HTTP-date (RFC 7231 §7.1.3), not just seconds.
  // A date-shaped header must be honoured as the wait until then, not dropped
  // (Number("Wed, ...") is NaN and would otherwise fall through to a guess).
  {
    const realFetch = globalThis.fetch;
    const future = new Date(Date.now() + 90_000).toUTCString();
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("jwks.json")) {
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/oauth2/auth")) {
        return new Response("", {
          status: 302,
          headers: {
            location: "https://platform.sensenova.cn/login?login_challenge=chal",
            "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
          }
        });
      }
      if (target.includes("iam.sensecoreapi.cn")) {
        return new Response(JSON.stringify({ code: 9, message: "TooManyRequests", details: [{ reason: "tooManyAttempts" }] }), {
          status: 429, headers: { "content-type": "application/json", "retry-after": future }
        });
      }
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    };
    try {
      const mod = await import(`../src/host/sensenova-auth.ts?httpdate=${Date.now()}-${Math.random()}`);
      let retryAfterMs;
      try { await mod.createAuth().login({ username: "u", password: "p" }); } catch (error) { retryAfterMs = error?.retryAfterMs; }
      check("a Retry-After HTTP-date is honoured as the wait until then",
        typeof retryAfterMs === "number" && retryAfterMs > 0 && retryAfterMs <= 90_000 + 5000, String(retryAfterMs));
    } catch (error) {
      fail("a Retry-After HTTP-date is honoured as the wait until then", error);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

// --- 6. login refuses empty credentials without any network --------------
{
  const realFetch = globalThis.fetch;
  let touched = 0;
  globalThis.fetch = async () => { touched += 1; return new Response("{}", { status: 500 }); };
  try {
    let code = null;
    try { await createAuth().login({ username: "", password: "p" }); } catch (error) { code = error?.code; }
    check("empty credentials are refused", code === "missing_credentials", String(code));
    // Emptiness is judged on the trimmed form, so a password that is nothing
    // but spaces was not filled in — yet a password that merely *has* a space
    // is a different password and must survive.
    let blank = null;
    try { await createAuth().login({ username: "u", password: "   " }); } catch (error) { blank = error?.code; }
    check("a whitespace-only password was not filled in", blank === "missing_credentials", String(blank));
    check("no request is made for empty credentials", touched === 0, `requests=${touched}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 7. refresh without a token refuses locally --------------------------
{
  const realFetch = globalThis.fetch;
  let touched = 0;
  globalThis.fetch = async () => { touched += 1; return new Response("{}", { status: 500 }); };
  try {
    let code = null;
    try { await createAuth().refresh(""); } catch (error) { code = error?.code; }
    check("an absent refresh token is refused", code === "no_refresh_token", String(code));
    check("no token request is made", touched === 0, `requests=${touched}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 7a. a refresh 400 is classified by the body's error, not the status ----
// The token endpoint's 400 means `invalid_grant` (the token is dead: only a
// password login recovers it) OR a request-shape problem (`invalid_client` /
// `invalid_scope` — the TOKEN is fine). Only the former is REFRESH_REJECTED:
// the caller's rejection path REAPS the stored grant, so a misclassified
// `invalid_client` would delete a perfectly healthy refresh token for good.
{
  const cases = [
    { label: "invalid_grant is a dead token", body: { error: "invalid_grant", error_description: "grant is stale" }, status: 400, expect: "refresh_rejected" },
    { label: "invalid_client is NOT a dead token", body: { error: "invalid_client", error_description: "unknown client" }, status: 400, expect: "refresh_failed" },
    { label: "invalid_scope is NOT a dead token", body: { error: "invalid_scope", error_description: "scope not allowed" }, status: 400, expect: "refresh_failed" },
    { label: "a non-JSON 400 body is NOT a dead token", body: "gateway refused", status: 400, expect: "refresh_failed" },
    { label: "a 500 is a transport failure, not a dead token", body: "boom", status: 500, expect: "refresh_failed" }
  ];
  for (const c of cases) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      typeof c.body === "string" ? c.body : JSON.stringify(c.body),
      { status: c.status, headers: { "content-type": "application/json" } });
    try {
      const mod = await import(`../src/host/sensenova-auth.ts?refresh400=${Date.now()}-${Math.random()}`);
      let code = null;
      try { await mod.createAuth().refresh("refresh-token"); } catch (error) { code = error?.code; }
      check(`refresh 400=${c.status} ${c.body.error ?? "(no error field)"} classifies as ${c.expect}`,
        code === c.expect, String(code));
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

// --- 7b. a SUCCESSFUL login also reports its trace ----------------------
// Only failures used to reach `onTrace`, so a working walk was never written
// down — and diffing a working attempt against a failing one is the entire
// reason the trace exists. A success throws nothing to carry it on.
{
  const { jwk } = await stubKey();
  for (const [label, ok] of [["a success", true], ["a failure", false]]) {
    const realFetch = globalThis.fetch;
    let issuedState = "";
    globalThis.fetch = async (url) => {
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
        const echo = issuedState !== "" ? `&state=${encodeURIComponent(issuedState)}` : "";
        return ok
          ? new Response(JSON.stringify({ redirect: `https://platform.sensenova.cn/cb?code=the-code${echo}` }),
            { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({
              code: 3, message: "InvalidArgument",
              details: [{ reason: "invalidAccountOrPassword" }]
            }), { status: 400, headers: { "content-type": "application/json" } });
      }
      if (target.includes("oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "granted-token", refresh_token: "granted-refresh", expires_in: 10800 }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    };
    try {
      const mod = await import(`../src/host/sensenova-auth.ts?trace-${label}=${Date.now()}-${Math.random()}`);
      const reported = [];
      let granted = null;
      let thrown = null;
      try {
        granted = await mod.createAuth().login({ username: "u", password: "p" },
          { onTrace: (hops, error) => reported.push({ hops, error }) });
      } catch (error) {
        thrown = error;
      }
      check(`${label} reports exactly one trace`, reported.length === 1, `traces=${reported.length}`);
      const first = reported[0] ?? {};
      check(`${label} reports the hops it walked`, Array.isArray(first.hops) && first.hops.length > 0,
        String(first.hops?.length));
      if (ok) {
        check("a success is reported with no error", first.error === null, String(first.error));
        check("a success still returns the grant", granted?.accessToken === "granted-token",
          String(granted?.accessToken));
        // IAM answers the form post with a `redirect` whose query carries the
        // authorization code. Scrubbing by KEY name misses it entirely, so this
        // is the assertion that fails if sanitizing ever goes back to names.
        const serialized = JSON.stringify(first.hops ?? []);
        check("a success trace does not carry the authorization code",
          !serialized.includes("the-code"), serialized.slice(0, 200));
      } else {
        check("a failure is reported with the error that was thrown", first.error === thrown);
        check("a failure still carries hops on the error",
          Array.isArray(thrown?.trace) && thrown.trace.length > 0, String(thrown?.trace?.length));
      }
    } catch (error) {
      fail(`${label} reports its trace`, error);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

// --- 7c. one taxonomy, three consumers ----------------------------------
// The auth half PRODUCES these codes, the store decides whether to park them,
// and the Host decides whether they are an auth failure. A code missing from
// the third list is reported to the user as a console failure — which is how
// a locked account came to be described as one.
{
  const declared = new Set(Object.values(CODE));
  const platformCodes = Object.values(IAM_REASON_CODES);
  check("every platform reason maps to a declared code",
    platformCodes.every((code) => declared.has(code)), platformCodes.join(", "));
  check("every platform reason counts as an auth failure",
    platformCodes.every((code) => AUTH_FAILURE_CODES.has(code)),
    platformCodes.filter((code) => !AUTH_FAILURE_CODES.has(code)).join(", "));
  check("a parked refusal is also an auth failure",
    [...CREDENTIAL_REFUSALS].every((code) => AUTH_FAILURE_CODES.has(code)));
  check("a lockout is an auth failure", isAuthFailure({ code: CODE.ACCOUNT_LOCKED }) === true);
  check("a rate limit is an auth failure", isAuthFailure({ code: CODE.RATE_LIMITED }) === true);
  check("a captcha is an auth failure", isAuthFailure({ code: CODE.VERIFICATION_REQUIRED }) === true);
  check("an unclassified refusal is an auth failure", isAuthFailure({ code: CODE.LOGIN_FAILED }) === true);
  check("a console failure is NOT an auth failure", isAuthFailure({ code: CODE.CONSOLE_ERROR }) === false);
  check("an error with no code is not an auth failure", isAuthFailure(new Error("boom")) === false);
  check("a wrong password is parked", isCredentialRefusal(CODE.LOGIN_REJECTED) === true);
  check("a lockout is waited out, not parked", isCredentialRefusal(CODE.ACCOUNT_LOCKED) === false);
  check("no account is never parked", isCredentialRefusal(CODE.NOT_CONFIGURED) === false);
}

// --- 7d. a body that is not JSON is scrubbed by VALUE too ----------------
// An HTML form or a bare redirect header puts `code=` and `login_challenge=`
// in plain text, where there is no key to match on at all.
{
  const { jwk } = await stubKey();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("jwks.json")) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.includes("/oauth2/auth")) {
      return new Response("", {
        status: 302,
        headers: {
          location: "https://platform.sensenova.cn/login?login_challenge=chal",
          "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
        }
      });
    }
    if (target.includes("iam.sensecoreapi.cn")) {
      // Deliberately not JSON: the branch that has to catch secrets by shape.
      return new Response("see https://platform.sensenova.cn/cb?code=the-code&login_challenge=chal",
        { status: 500, headers: { "content-type": "text/plain" } });
    }
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  };
  try {
    const mod = await import(`../src/host/sensenova-auth.ts?scrub=${Date.now()}-${Math.random()}`);
    const reported = [];
    try {
      await mod.createAuth().login({ username: "u", password: "p" },
        { onTrace: (hops, error) => reported.push({ hops, error }) });
    } catch {
      // The refusal is the point; what matters is what got written down.
    }
    const serialized = JSON.stringify(reported[0]?.hops ?? []);
    check("a plain-text body loses the authorization code",
      !serialized.includes("the-code"), serialized.slice(0, 240));
    check("a plain-text body loses the login challenge",
      !serialized.includes("=chal"), serialized.slice(0, 240));
  } catch (error) {
    fail("a plain-text body is scrubbed by value", error);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 7d. the callback's state must round-trip the issued nonce -----------
// PKCE binds the CODE to this process (the verifier); the state nonce is the
// second half: a callback carrying a state we did not issue is a code from a
// flow this process did not start — a replayed or injected redirect. Both
// directions matter: an echo is accepted, a foreign state is refused, and the
// refusal is a LOGIN_FLOW (the walk itself broke), not a credential refusal.
{
  const { jwk } = await stubKey();
  for (const [label, echoState] of [["a round-tripped state is accepted", "true"], ["a foreign state is refused", "false"]]) {
    const realFetch = globalThis.fetch;
    let issued = "";
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("jwks.json")) {
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/oauth2/auth")) {
        issued = new URL(target).searchParams.get("state") ?? "";
        return new Response("", {
          status: 302,
          headers: { location: "https://platform.sensenova.cn/login?login_challenge=chal", "set-cookie": "a=b; Path=/" }
        });
      }
      if (target.includes("iam.sensecoreapi.cn")) {
        const state = echoState === "true" ? issued : "injected-by-stranger";
        return new Response(JSON.stringify({
          redirect: `https://platform.sensenova.cn/cb?code=the-code&state=${encodeURIComponent(state)}`
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 10800 }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    };
    try {
      const mod = await import(`../src/host/sensenova-auth.ts?state-${echoState}=${Date.now()}-${Math.random()}`);
      let granted = null;
      let code = null;
      try {
        granted = await mod.createAuth().login({ username: "u", password: "p" });
      } catch (error) { code = error?.code; }
      check(label, echoState === "true" ? (granted !== null && code === null) : (granted === null && code === "login_flow"),
        `granted=${String(granted?.accessToken)} code=${String(code)}`);
    } catch (error) {
      fail(label, error);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

// --- 7c. endpoint overrides must be https except loopback ------------------
// The token endpoint answers in plaintext with the LIVE access/refresh pair,
// so a typo'd http:// must fail loudly for a real host — but the e2e fake
// platform runs on this machine's http://127.0.0.1, which is loopback and
// has no man-in-the-middle corridor. checkEndpoint enforces exactly that.
{
  const cases = [
    ["http://evil.example", "config", "a foreign http endpoint is refused"],
    ["http://127.0.0.1:8080", null, "a loopback http endpoint is allowed (e2e fake platform)"],
    ["http://localhost:8080", null, "a localhost http endpoint is allowed"],
    ["https://api.example", null, "a plain https endpoint is still allowed"]
  ];
  for (const [endpoint, expect, label] of cases) {
    let code = null;
    try { createAuth({ iamOrigin: endpoint }); } catch (error) { code = error?.code; }
    check(label, code === expect, `iamOrigin=${endpoint} code=${String(code)}`);
  }
}

// --- 7c. the login trace never records a credential ------------------------
// The trace file is what a user attaches to a bug report, so it is the highest
// -value leak in the plugin and the one place a red line is truly load-bearing.
// Two gates are pinned, because either alone fails open:
//   - the KEY names a secret field (matched separator-agnostically, so a
//     platform that spells `accessToken` instead of `access_token` is covered);
//   - the VALUE simply IS one (a JWT is self-describing, whatever key holds it).
// The second gate is what catches a credential under an INNOCENT key, and the
// URL shapes below are the ones the platform actually uses — a relative
// `Location` and a fragment are both outside `searchParams`.
{
  try {
    const trace = createTrace();
    trace.step("token", { body: JSON.stringify({ access_token: "AT.1", accessToken: "AT.2", refreshToken: "RT.2" }) });
    trace.step("nested", { body: JSON.stringify({ data: { token: "eyJhbGciOiJIUzI1NiJ9.abc.def" }, ok: true }) });
    trace.step("relative", { url: "/oauth2/callback?code=SECRETCODE&state=xyz" });
    trace.step("fragment", { url: "https://x/cb#access_token=SECRETAT" });
    const blob = JSON.stringify(trace.done());
    check("the trace redacts snake_case token keys",
      !blob.includes("AT.1") && !blob.includes("RT.2"), blob.slice(0, 220));
    check("the trace redacts camelCase token keys",
      !blob.includes("AT.2"), blob.slice(0, 220));
    check("the trace redacts a JWT nested under an ordinary key",
      !blob.includes("eyJhbGci"), blob.slice(0, 220));
    check("the trace redacts a secret in a RELATIVE redirect",
      !blob.includes("SECRETCODE"), blob.slice(0, 220));
    check("the trace redacts a secret in the URL fragment",
      !blob.includes("SECRETAT"), blob.slice(0, 220));
  } catch (error) {
    fail("the login trace never records a credential", error);
  }
}

// --- 8. the whole suite stayed offline -----------------------------------
// The point of the guard: a check that forgets its stub fails HERE, loudly,
// instead of reaching the platform and — for a login-shaped call — counting
// as a real attempt against someone's account.
const unstubbed = releaseNetworkGuard();
check("no check escaped its stub to the network", unstubbed.length === 0, unstubbed.join(", "));

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

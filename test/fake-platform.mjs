/**
 * A fake SenseNova platform for the end-to-end run.
 *
 * It answers everything the panel asks for — JWKS, the login flow, the token
 * endpoint, the console API — so the panel can reach a genuinely WORKING state
 * and the test can assert on real numbers coming out of a real Host. The
 * password it accepts is a fixed test string; it is not an account, and the
 * e2e run sets no real credentials at all.
 *
 * The real Host is booted against this on 127.0.0.1, so even a bug that tried
 * to sign in would land here rather than at the platform.
 */
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";

const PORT = Number(process.env.FAKE_PORT ?? 19399);
const PASSWORD = "e2e-test-password";

/**
 * A throwaway RSA key, generated per run: the JWE is decrypted to prove it.
 *
 * `generateKeyPairSync` already returns KeyObjects, so they are exported
 * directly — re-wrapping a public key with `createPublicKey` would throw.
 */
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const privateJwk = privateKey.export({ format: "jwk" });

/** Counters the test asserts on, so "did it log in?" is answerable. */
export const log = { jwks: 0, auth: 0, iam: 0, token: 0, poolUsage: 0, trend: 0, catalog: 0, badPassword: 0, throttled: 0 };

/** A JWT the panel will accept, expiring in an hour. */
function freshJwt() {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.e2e`;
}

const POOL_BODY = {
  plan: { id: "plan-e2e", name: "TokenPlan", type: "token_plan" },
  pools: [{
    id: "pool-e2e",
    name: "E2E 池",
    pool_type: "default",
    model_ids: ["SenseNova-Lite"],
    window_5h: { limit: 60000, used: 23456, remaining: 36544, reset_at: "1800000000" },
    window_7d: { limit: 600000, used: 23456, remaining: 576544, reset_at: "1800600000" },
    grant_balance: 0
  }]
};
const TREND_BODY = {
  series: [{ model_id: "SenseNova-Lite", points: [{ credits: 42.5 }, { credits: 51.25 }] }]
};

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
  });
}

/**
 * Decrypt a compact JWE with the fake's own key.
 *
 * Used only to PROVE the panel really sealed the submitted password rather
 * than sending it in the clear — the property the whole login path exists for.
 * @param {string} jwe - the compact serialization.
 * @returns {string|null} the plaintext, or `null` if it will not open.
 */
export async function openSealed(jwe) {
  try {
    // ALL FIVE segments. A compact JWE is header.encryptedKey.iv.ciphertext.tag,
    // and the tag is the detached final 128 bits (RFC 7516 §5.1). Reading only
    // the first four handed WebCrypto a ciphertext with no tag, which refuses
    // to decrypt — so `seen.password` was null on every run, the fake rejected
    // the login as a wrong password, and the flow never reached the token
    // endpoint. The end-to-end run therefore never exercised PKCE at all.
    const [header, wrapped, iv, ciphertext, tag] = String(jwe).split(".");
    if (wrapped === undefined || tag === undefined) return null;
    const key = await crypto.subtle.importKey(
      "jwk", privateJwk, { name: "RSA-OAEP", hash: "SHA-1" }, false, ["decrypt"]
    );
    const cek = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, Buffer.from(wrapped, "base64url"));
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Buffer.from(iv, "base64url"),
        additionalData: new TextEncoder().encode(header),
        tagLength: 128
      },
      await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]),
      // WebCrypto wants ciphertext||tag as one buffer; the JWE keeps them apart.
      Buffer.concat([Buffer.from(ciphertext, "base64url"), Buffer.from(tag, "base64url")])
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** The last sealed password the fake received, decrypted. */
export const seen = { password: null, username: null, codeChallenge: null, codeChallengeMethod: null, state: null };

/**
 * The PKCE floor from RFC 7636, enforced by every real OIDC server.
 *
 * The fake used to hand out a token without looking at `code_verifier` at all,
 * so a verifier that was too short — or absent — still produced a green
 * end-to-end run while the real platform refused the exchange. That is exactly
 * how an 11-character verifier reached a user's console.
 */
const PKCE_MIN_LENGTH = 43;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const body = req.method === "POST" ? await readBody(req) : "";
  // One line per request, so a test failure can be read straight off the log
  // instead of guessed at.
  process.stdout.write(`fake: ${req.method} ${path}\n`);

  if (path === "/.well-known/jwks.json") {
    log.jwks += 1;
    return json(res, 200, { keys: [{ ...jwk, kid: "public:hydra.openid.id-token", use: "sig" }] });
  }
  if (path === "/oauth2/auth") {
    // Hydra answers the authorization request with a redirect into the login
    // flow, carrying the CSRF cookie the callback needs. Returning a 200 here
    // is what made the panel report "could not obtain a login challenge".
    log.auth += 1;
    // Remember the challenge: the token endpoint has to redeem it, or the
    // fake is not checking PKCE and cannot catch a malformed verifier.
    seen.codeChallenge = url.searchParams.get("code_challenge");
    seen.codeChallengeMethod = url.searchParams.get("code_challenge_method");
    // Remember the state nonce: the callback must round-trip it, and the login
    // flow now verifies that round-trip.
    seen.state = url.searchParams.get("state");
    res.writeHead(302, {
      location: `http://127.0.0.1:${PORT}/login?login_challenge=chal-e2e`,
      "set-cookie": "oauth2_authentication_csrf=abc; Path=/"
    });
    return res.end();
  }
  if (path === "/login") {
    log.auth += 1;
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "oauth2_authentication_csrf=abc; Path=/" });
    return res.end("<html><body>login</body></html>");
  }
  if (path.includes("/iam/authn/") && path.includes("/login")) {
    log.iam += 1;
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* fall through to the refusal below */ }
    seen.username = typeof parsed.username === "string" ? parsed.username : null;
    seen.password = await openSealed(parsed.password);
    process.stdout.write(`fake: iam username=${seen.username} sealedPassword=${JSON.stringify(seen.password)}\n`);
    // A throttled account answers the platform's real rate-limit envelope: a
    // 429 whose reason scans to `RATE_LIMITED` and whose `Retry-After` header
    // states a window. A fake that only ever refuses a wrong password could
    // never exercise the wait honouring, so a run would pass while a real
    // lockout was still being extended with every poll.
    if (seen.username === "e2e-throttle") {
      log.throttled += 1;
      return json(res, 429, {
        code: 3,
        message: "TooManyAttempts",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "tooManyAttempts", domain: "iam" },
          { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en", message: "login attempts too frequent, try again after 2 minutes" }
        ]
      }, { "retry-after": "120" });
    }
    if (seen.password !== PASSWORD) {
      log.badPassword += 1;
      // The real envelope: a generic status up top, the cause in details[].
      return json(res, 400, {
        code: 3,
        message: "InvalidArgument",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "invalidAccountOrPassword", domain: "iam" },
          { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en", message: "invalid account or password" }
        ]
      });
    }
    const stateQuery = seen.state !== null ? `&state=${encodeURIComponent(seen.state)}` : "";
    return json(res, 200, { redirect: `http://127.0.0.1:${PORT}/cb?code=the-code${stateQuery}` });
  }
  if (path === "/cb") {
    const stateQuery = seen.state !== null ? `&state=${encodeURIComponent(seen.state)}` : "";
    res.writeHead(302, { location: `http://127.0.0.1:${PORT}/done?code=the-code${stateQuery}` });
    return res.end();
  }
  if (path === "/done") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<html><body>ok</body></html>");
  }
  if (path === "/oauth2/token") {
    log.token += 1;
    const params = new URLSearchParams(body);
    const grant = params.get("grant_type");
    if (grant === "authorization_code") {
      // Redeem PKCE the way Hydra does. The error payloads are the platform's
      // own words, so a failure looks like the failure a user would report.
      const verifier = params.get("code_verifier") ?? "";
      if (verifier.length < PKCE_MIN_LENGTH) {
        return json(res, 400, {
          error: "invalid_grant",
          error_description:
            "The provided authorization grant (e.g., authorization code, resource owner " +
            "credentials) or refresh token is invalid, expired, revoked, does not match the " +
            "redirection URI used in the authorization request, or was issued to another " +
            `client. The PKCE code verifier must be at least ${PKCE_MIN_LENGTH} characters.`
        });
      }
      const digest = Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
      ).toString("base64url");
      if (seen.codeChallenge !== null && digest !== seen.codeChallenge) {
        return json(res, 400, {
          error: "invalid_grant",
          error_description: "The PKCE code verifier did not match the code challenge."
        });
      }
    }
    if (grant === "authorization_code" || grant === "refresh_token") {
      return json(res, 200, {
        access_token: freshJwt(),
        refresh_token: `e2e-refresh-${log.token}`,
        expires_in: 10800,
        scope: "openid offline offline_access"
      });
    }
    return json(res, 400, { error: "unsupported_grant_type" });
  }
  if (path.includes("pool-usage")) {
    log.poolUsage += 1;
    return json(res, 200, POOL_BODY);
  }
  if (path.includes("credit-usage-trend")) {
    log.trend += 1;
    return json(res, 200, TREND_BODY);
  }
  if (path.includes("model")) {
    log.catalog += 1;
    // One text-only, one vision-capable, and one image-output-only model,
    // so the catalog exercise distinguishes input-modality from
    // output-modality (step-two publish must not treat an out model as a
    // vision model). The envelope is `{data:[…]}` — the OpenAI-compatible
    // shape `fetchModelCatalog` unwraps; a fake answering `{models:[…]}`
    // would hand the plugin an empty catalog and let a broken unwrap pass.
    return json(res, 200, {
      data: [
        { id: "SenseNova-Lite", name: "SenseNova-Lite", input_modalities: ["text"] },
        { id: "SenseNova-Vision", name: "SenseNova-Vision", input_modalities: ["text", "image"], output_modalities: ["text"] },
        { id: "SenseNova-Draw", name: "SenseNova-Draw", input_modalities: ["text"], output_modalities: ["image"] }
      ]
    });
  }
  return json(res, 404, { error: `no fake route for ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`fake-platform listening on http://127.0.0.1:${PORT}\n`);
});

/** Close cleanly so the test can finish. */
export function close() {
  return new Promise((resolve) => server.close(resolve));
}

export { PASSWORD, PORT };

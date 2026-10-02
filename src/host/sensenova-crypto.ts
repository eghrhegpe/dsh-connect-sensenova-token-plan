/**
 * dsh-connect-sensenova-token-plan — the cryptographic primitives the console login needs.
 *
 * Sealing the password into a JWE, deriving a PKCE pair, reading a JWT's own
 * claims. All of it is pure in its inputs: where the login flow reads
 * endpoints from configuration, this module is TOLD which endpoint and which
 * key id to use. Nothing here reaches for a module-level setting — not even the
 * JWKS cache, which each caller owns via {@link createJwksCache} (see below), so
 * two callers with different configurations cannot disturb one another, and a
 * test can exercise any of it without configuring the world first.
 *
 * @module dsh-connect-sensenova-token-plan/sensenova-crypto
 */
import { CODE } from "./codes.ts";
import { str, obj, pluginError } from "./util.ts";
import type { JwksOptions } from "./types.ts";

/**
 * Base64url-encode bytes, unpadded, as JOSE requires.
 *
 * Only `Uint8Array` and `ArrayBuffer` are accepted; anything else is REJECTED
 * with a `config` error. That guard exists because of a bug that cost a working
 * login: `Buffer.from(new Uint32Array(8))` returns EIGHT bytes, not thirty-two.
 * Node encodes a non-Uint8 TypedArray as if each ELEMENT were one byte,
 * silently — no throw, no warning, just a quarter of the entropy expected. A
 * PKCE verifier built that way came out 11 characters long, and the token
 * endpoint's only complaint was an opaque `invalid_grant` carrying the hint
 * "The PKCE code verifier must be at least 43 characters", with the real cause
 * nowhere in it. Rather than compensate for Node's per-element encoding, this
 * module refuses the shape outright so the mistake cannot reach the wire.
 * @param {Uint8Array|ArrayBuffer} bytes - the bytes to encode.
 * @returns {string} the unpadded base64url text.
 */
export function b64url(bytes) {
  // Accept Uint8Array and ArrayBuffer (what WebCrypto returns); reject other
  // TypedArrays whose element width would silently truncate the output.
  const isAcceptable = bytes instanceof Uint8Array || bytes instanceof ArrayBuffer;
  if (!isAcceptable) {
    // The guard above is the real protection (redline 4): only Uint8Array and
    // ArrayBuffer reach the encoder. Inside the reject branch the tightened
    // param type narrows `bytes` to `never`, so read the offending shape off a
    // loose view purely to describe it in the message.
    const bad = /** @type {*} */ (bytes);
    throw pluginError(CODE.CONFIG, `b64url expects Uint8Array or ArrayBuffer, got ${bad?.constructor?.name ?? typeof bad}`);
  }
  return Buffer.from(bytes as unknown as ArrayBuffer).toString("base64url");
}

/** Decode a base64url JWT segment into a UTF-8 string. */
export function b64urlDecode(segment) {
  return Buffer.from(segment, "base64url").toString("utf8");
}

/**
 * Read the console JWT's own claims without verifying its signature.
 *
 * Only used to learn `exp`, which the server is the authority for; the
 * signature is never checked here because the panel is not the audience. A
 * failure is not fatal — the caller falls back to letting the console decide.
 * @param {string} token - a JWT.
 * @returns {Record<string, unknown>} the payload, or `{}` when unreadable.
 */
export function readJwtClaims(token) {
  const segments = str(token, "").split(".");
  if (segments.length < 2) return {};
  try {
    const parsed = JSON.parse(b64urlDecode(segments[1]));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The access token's expiry as epoch milliseconds, or `null` when the token
 * carries no readable `exp`.
 * @param {string} token - a JWT.
 * @returns {number|null}
 */
export function readJwtExpiry(token) {
  const exp = readJwtClaims(token).exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

/** RFC 7636 bounds for a PKCE verifier, in characters. */
const PKCE_VERIFIER_MIN = 43;
const PKCE_VERIFIER_MAX = 128;

/**
 * A PKCE verifier/challenge pair (S256).
 *
 * `subtle.digest` is asynchronous, so this is too; the challenge is the
 * base64url of the digest's bytes, never the Promise itself.
 *
 * 48 random bytes encode to 64 characters — deliberately mid-range rather than
 * at the 43-character floor. Sitting on the minimum means the next truncation
 * bug (see {@link b64url}) produces a verifier that is *almost* valid and an
 * error that names everything except the cause. The length is asserted here too,
 * so a regression fails at the point that created it with a sentence a reader
 * can act on, instead of at the token endpoint with an `invalid_grant`.
 * @returns {Promise<{verifier: string, challenge: string}>}
 */
export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  if (verifier.length < PKCE_VERIFIER_MIN || verifier.length > PKCE_VERIFIER_MAX) {
    throw pluginError(
      CODE.CONFIG,
      `PKCE verifier is ${verifier.length} characters, outside RFC 7636's ${PKCE_VERIFIER_MIN}-${PKCE_VERIFIER_MAX}`
    );
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

/** How long a fetched JWKS is reused. The set rotates rarely, not per login. */
const JWKS_TTL_MS = 600_000;

/**
 * A reusable key-set cache: the shape {@link sealPassword} expects in its
 * `cache` option.
 *
 * This used to be one module-level `Map`. That contradicted this module's own
 * promise — "nothing here reaches for a module-level setting" — and it leaked
 * across callers exactly the way the throttle file does: two configurations
 * shared one cached key set, so a test that wanted a clean cache had to reload
 * the whole module (`import("...?shape=…")`) rather than just make a new cache.
 * Handing each caller its own removes both problems at once: instances cannot
 * disturb one another, and the isolation is a `createJwksCache()` call, not an
 * import-cache hack. Keyed BY ENDPOINT inside, so one instance pointed at two
 * mirrors still keeps their keys apart.
 * @returns {Map<string, {keys: object[], at: number}>} an empty cache.
 */
export function createJwksCache() {
  return new Map();
}

/**
 * Fetch a platform JWKS, honouring the caller-supplied short cache.
 * @param {object} options - what to fetch and how.
 * @param {string} options.jwksEndpoint - the JWKS document URL.
 * @param {number} [options.timeoutMs] - request deadline.
 * @param {() => number} [options.now] - clock source; injected by the tests.
 * @param {Map<string, {keys: object[], at: number}>} options.cache - where to
 *   keep the fetched set. Owned by the caller (see {@link createJwksCache}), so
 *   no two instances share it unless they are handed the same map on purpose.
 * @returns {Promise<object[]>} the key set.
 */
async function fetchJwks({ jwksEndpoint, timeoutMs = 15_000, now = Date.now, cache }) {
  const cached = cache.get(jwksEndpoint);
  if (cached !== undefined && now() - cached.at < JWKS_TTL_MS) return cached.keys;
  const response = await fetch(jwksEndpoint, {
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw pluginError(CODE.JWKS, `JWKS endpoint returned HTTP ${response.status}`);
  }
  // Read the body ONCE: a Response's body is a stream, and a second
  // `.json()` does not replay it — it throws.
  const body = obj(await response.json());
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (keys.length === 0) throw pluginError(CODE.JWKS, "JWKS endpoint returned no keys");
  cache.set(jwksEndpoint, { keys, at: now() });
  return keys;
}

/**
 * Seal the password into a compact JWE the IAM endpoint accepts.
 *
 * The plaintext never leaves this function: it is sealed to the platform's
 * RSA public key with RSA-OAEP, then the content is wrapped with A256GCM. The
 * result is the 5-segment compact serialization.
 *
 * The two algorithm choices are dictated by the platform, not free parameters.
 * The console seals with `alg: RSA-OAEP` — OAEP over SHA-1 — so the key is
 * imported for SHA-1; `RSA-OAEP-256` here is rejected by IAM. The protected
 * header is the AAD, and it enters the AAD as its base64url SEGMENT, not as
 * the JSON text, per RFC 7516 §5.1 step 14.
 * @param {string} password - the account password.
 * @param {object} [options] - which key and where to find it; the runtime guards
 *   below reject an absent endpoint / key id, so a missing option is a clear
 *   CONFIG error rather than a silent fallback.
 * @param {string} [options.jwksEndpoint] - the JWKS document URL.
 * @param {string} [options.encKeyId] - the `kid` to seal to.
 * @param {number} [options.timeoutMs] - request deadline.
 * @param {Map<string, {keys: object[], at: number}>} [options.cache] - a
 *   caller-owned key-set cache (see {@link createJwksCache}). Omitted, the seal
 *   fetches fresh every call — correct but chatty; the login flow passes one so
 *   repeated attempts reuse the set WITHOUT sharing it with another instance.
 * @returns {Promise<string>} the compact JWE.
 */
export async function sealPassword(password: string, options: JwksOptions = {}) {
  const { jwksEndpoint, encKeyId, timeoutMs, cache = createJwksCache() } = options;
  if (str(jwksEndpoint, "") === "") throw pluginError(CODE.CONFIG, "no JWKS endpoint is configured");
  if (str(encKeyId, "") === "") throw pluginError(CODE.CONFIG, "no encryption key id is configured");
  const keys = await fetchJwks({ jwksEndpoint, timeoutMs, cache });
  const entry = keys.find((key) => obj(key).kid === encKeyId);
  if (entry === undefined) throw pluginError(CODE.JWKS, `JWKS has no key ${encKeyId}`);
  const source = obj(entry);
  const modulus = str(source.n, "");
  const exponent = str(source.e, "");
  if (modulus === "" || exponent === "") throw pluginError(CODE.JWKS, "JWKS key is missing n/e");

  // Import the JWK by handing WebCrypto the public JWK itself, which also
  // proves the key is well-formed before any password is fed to it.
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: modulus, e: exponent, alg: "RSA-OAEP", ext: true },
    { name: "RSA-OAEP", hash: "SHA-1" },
    false,
    ["encrypt"]
  );

  // A256GCM content encryption: a fresh CEK and IV per login.
  const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", contentKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const protectedHeader = b64url(
    new TextEncoder().encode(JSON.stringify({ alg: "RSA-OAEP", enc: "A256GCM" }))
  );
  const plaintext = new TextEncoder().encode(password);
  // WebCrypto returns ciphertext||tag as one buffer; RFC 7516 §5.1/§5.2 wants
  // them SPLIT — the tag is the final detached 128 bits.
  const sealedGcm = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(protectedHeader), tagLength: 128 },
      contentKey,
      plaintext
    )
  );
  const ciphertext = sealedGcm.subarray(0, sealedGcm.length - 16);
  const gcmTag = sealedGcm.subarray(sealedGcm.length - 16);

  // The encrypted-key segment carries the CEK wrapped to the platform's public
  // key — not the password, which belongs in the ciphertext alone.
  const sealed = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, rawKey);

  // Compact serialization is FIVE segments: header.encryptedKey.iv.ciphertext.tag
  // (RFC 7516 §5.1 step 15). Four is not a valid JWE — the platform cannot even
  // parse it, and the decryption failure surfaces as "invalidAccountOrPassword",
  // which is why a correct password looked like a wrong one.
  return [protectedHeader, b64url(sealed), b64url(iv), b64url(ciphertext), b64url(gcmTag)].join(".");
}

/**
 * The one check that talks to the real platform — and it talks to nothing else.
 *
 * It fetches the public JWKS document and asks two questions that only the
 * live key set can answer: does the console still publish the kid the plugin
 * encrypts under, and is it still the RSA-4096 key the segment sizing assumes.
 * No credential is involved, no login is attempted, and nothing is POSTed.
 *
 * This is deliberately NOT part of `npm test`. A default run that reaches the
 * network is a default run that can fail for reasons that have nothing to do
 * with this plugin, and it blurs the line that matters: verification must not
 * default to sending requests at a real service. Run it deliberately:
 *
 *     npm run test:live
 *
 * A failure here is information, not a regression — a rotated key or a renamed
 * kid is a platform change, and the fix belongs in sensenova-crypto.js.
 */
import { sealPassword } from "../src/host/sensenova-crypto.ts";
import { results, check } from "./harness.mjs";

const JWKS_ENDPOINT = "https://signin.sensecore.cn/.well-known/jwks.json";
/** The kid the console seals the password under. */
const ENC_KEY_ID = "public:hydra.openid.id-token";


let jwks;
try {
  const response = await fetch(JWKS_ENDPOINT, { signal: AbortSignal.timeout(20_000) });
  check("the JWKS document is reachable", response.ok, `HTTP ${response.status}`);
  jwks = await response.json();
} catch (error) {
  // Offline or blocked is a legitimate outcome for an explicitly-invoked
  // network check; it is reported, not treated as a code defect.
  check("the JWKS document is reachable", false, String(error?.message ?? error));
}

if (jwks !== undefined) {
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const entry = keys.find((k) => k?.kid === ENC_KEY_ID);
  check(`the platform still publishes ${ENC_KEY_ID}`, entry !== undefined,
    `kids: ${keys.map((k) => k?.kid).filter(Boolean).join(", ") || "none"}`);

  if (entry !== undefined) {
    // The segment sizing in the offline checks assumes a 4096-bit modulus
    // (a 512-byte wrapped CEK). A downgrade would still work, but the shape
    // assertions would no longer describe reality. Decoded byte length gives
    // the modulus width directly; estimating it from the base64url character
    // count would need a per-character weight and would be wrong.
    const modulusBits = typeof entry.n === "string" ? Buffer.from(entry.n, "base64url").length * 8 : 0;
    check("the encryption key is still RSA-4096", modulusBits === 4096, `${modulusBits} bits`);
    check("the key declares an exponent", typeof entry.e === "string" && entry.e !== "", String(entry.e));
  }

  // A structural seal under the live key, still without sending anything:
  // this proves the real key can be imported with the algorithms IAM demands.
  try {
    const sealed = await sealPassword("structural-probe", { jwksEndpoint: JWKS_ENDPOINT, encKeyId: ENC_KEY_ID });
    const segments = sealed.split(".");
    check("the live key can seal a payload", segments.length === 5, `got ${segments.length}`);
    const wrapped = Buffer.from(segments[1], "base64url").length;
    check("the live key wraps the CEK at 4096-bit width", wrapped === 512, String(wrapped));
  } catch (error) {
    check("the live key can seal a payload", false, String(error?.message ?? error));
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} live check(s) did not hold`);
  console.error("A live check failing usually means the platform changed, not that the code is wrong.");
  process.exit(1);
}
console.log(`\nall ${results.length} live checks passed`);

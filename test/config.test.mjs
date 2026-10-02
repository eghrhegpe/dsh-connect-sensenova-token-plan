/**
 * Config single-source pin.
 *
 * `index.js` reads every default from one `CONFIG_DEFAULTS` object, and
 * `cordis.patch.yml` is the human-authored mirror of that contract. The two are
 * allowed to differ only where the patch comments a key out (its default meaning
 * "use the platform value"), but they must not drift silently: this file fails
 * the moment a default the code ships is not the one the patch documents, or a
 * key the code reads is missing from the patch entirely.
 *
 * This needs no peer package — it only imports `index.js` and reads the patch
 * file as text, so it runs on a clean checkout.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveSettings, CONFIG_DEFAULTS, resolveAuthOverrides, credentialKey, hostName, isAdmitted, name } from "../src/host/index.ts";
import { resolveTrendMultipliers } from "../src/host/host-config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const patch = readFileSync(join(here, "..", "cordis.patch.yml"), "utf8");

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

// --- 1. resolveSettings({}) returns the single-source defaults -----------
{
  const { settings, configError } = resolveSettings({});
  check("no config error on an empty config", configError === null, String(configError));
  check("consoleBase default", settings.consoleBase === CONFIG_DEFAULTS.consoleBase, settings.consoleBase);
  check("apiBase default", settings.apiBase === CONFIG_DEFAULTS.apiBase, settings.apiBase);
  check("trendHours default", settings.trendHours === CONFIG_DEFAULTS.trendHours, String(settings.trendHours));
  check("cacheSeconds default", settings.cacheSeconds === CONFIG_DEFAULTS.cacheSeconds, String(settings.cacheSeconds));
  check("pollSeconds default", settings.pollSeconds === CONFIG_DEFAULTS.pollSeconds, String(settings.pollSeconds));
  check("consoleTimeoutMs default", settings.consoleTimeoutMs === CONFIG_DEFAULTS.consoleTimeoutMs, String(settings.consoleTimeoutMs));
  check("tokenSkewSeconds default", settings.tokenSkewSeconds === CONFIG_DEFAULTS.tokenSkewSeconds, String(settings.tokenSkewSeconds));
  check("default allowedHosts match the schema",
    [...settings.allowedHosts].join(",") === CONFIG_DEFAULTS.admittedHosts.join(","),
    [...settings.allowedHosts].join(","));
  check("default auth only carries consoleOrigin",
    Object.keys(settings.auth).length === 1 && settings.auth.consoleOrigin === CONFIG_DEFAULTS.consoleBase,
    JSON.stringify(settings.auth));
}

// --- 2. the patch documents every user-facing key the code reads ----------
// The list is DERIVED from CONFIG_DEFAULTS, not hand-written. It used to be a
// literal array that quietly omitted half the keys (apiBase, pollSeconds,
// consoleTimeoutMs, allowedHosts, loginTimeoutMs), so "a code-side addition
// cannot go undocumented" was only true for whoever remembered to edit this
// file too. Now every top-level default and every auth override must appear in
// the patch — active or commented — or the check fails on its own.
const ACTIVE_KEYS = Object.keys(CONFIG_DEFAULTS).filter((key) => key !== "auth" && key !== "admittedHosts");
const AUTH_KEYS = Object.keys(CONFIG_DEFAULTS.auth);
for (const key of [...ACTIVE_KEYS, ...AUTH_KEYS]) {
  // Matches `key:` (active) or `# key:` / `#key:` (commented) — either way the
  // patch acknowledges the key, so a code-side addition cannot go undocumented.
  const mentioned = new RegExp(`(^|\\s)#?\\s*${key}\\s*:`, "m").test(patch);
  check(`cordis.patch.yml documents ${key}`, mentioned, mentioned ? "" : "key absent from patch");
}
// admittedHosts is spelled `allowedHosts` in the patch (the operator's name for
// it), so derive-and-check would miss it; assert that alias is documented too.
check("cordis.patch.yml documents allowedHosts", /(^|\s)#?\s*allowedHosts\s*:/m.test(patch), "alias absent from patch");

// The active keys must carry the SAME default the code ships, or the panel's
// "defaults" and the bundle's "defaults" disagree.
function activeValue(key) {
  const m = patch.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, "m"));
  return m ? m[1] : null;
}
check("patch consoleBase matches code default", activeValue("consoleBase") === CONFIG_DEFAULTS.consoleBase.replace(/\/+$/, ""), activeValue("consoleBase"));
check("patch trendHours matches code default", Number(activeValue("trendHours")) === CONFIG_DEFAULTS.trendHours, activeValue("trendHours"));
check("patch cacheSeconds matches code default", Number(activeValue("cacheSeconds")) === CONFIG_DEFAULTS.cacheSeconds, activeValue("cacheSeconds"));
check("patch tokenSkewSeconds matches code default", Number(activeValue("tokenSkewSeconds")) === CONFIG_DEFAULTS.tokenSkewSeconds, activeValue("tokenSkewSeconds"));

// --- 3. the credentialKey shim is pinned to its literal shape --------------
// `index.js` hand-rolls `credentialKey` so the plugin runs without the peer
// package, but that duplicate can drift from the real service silently: if the
// format ever changes (a different separator, escaping), the panel would write
// its grant to one address and read it from another — a lost account with every
// test still green. This pins the EXACT shape on any machine, clean checkout
// included; store.test.mjs adds the cross-check against the real peer function
// where that peer resolves. Together they replace the old comment's untested
// claim ("the store's checks pin the shape") with an assertion.
{
  check("credentialKey joins scope and id with a single slash",
    credentialKey("scope", "id") === "scope/id", credentialKey("scope", "id"));
  // The two addresses this plugin actually stores under — a rename of either the
  // scope or the id is a breaking change to stored grants, so the exact strings
  // are worth a line here even though they are assembled elsewhere.
  check("credentialKey builds the record address the plugin reads back",
    credentialKey("dsh-connect-sensenova-token-plan", "sensenova-console") ===
      "dsh-connect-sensenova-token-plan/sensenova-console");
  check("credentialKey does not trim or transform its parts",
    credentialKey("a b", "c/d") === "a b/c/d", credentialKey("a b", "c/d"));
}

// --- 4. the auth overrides resolve to the keys the code and patch share ---
{
  const auth = resolveAuthOverrides(
    { consoleBase: CONFIG_DEFAULTS.consoleBase, iamBase: "https://iam.example", tokenEndpoint: "https://tok.example" },
    CONFIG_DEFAULTS.consoleBase
  );
  check("resolveAuthOverrides forwards iamBase -> iamOrigin", auth.iamOrigin === "https://iam.example", auth.iamOrigin);
  check("resolveAuthOverrides forwards tokenEndpoint", auth.tokenEndpoint === "https://tok.example", auth.tokenEndpoint);
  check("resolveAuthOverrides keeps consoleOrigin", auth.consoleOrigin === CONFIG_DEFAULTS.consoleBase, auth.consoleOrigin);
}

// --- 5. hostName()/isAdmitted(): every Host-header spelling the fence must answer ---
// The old `split(":")[0]` turned "::1:19387" into "" (and even "::1" into ":"),
// so the default whitelist entries "::1" / "[::1]" were reachable only through
// the bracketed form — bare-IPv6 loopback clients were silently refused, a
// direction an operator has no console to fix from. Pin every form, including
// the public-IPv6 ones that must stay REFUSED.
{
  const cases = [
    // [spelling, expected name]
    ["::1", "::1"],
    ["::1:3080", "::1"],
    ["::1:80", "::1"],
    ["[::1]", "[::1]"],
    ["[::1]:19387", "[::1]"],
    ["fe80::1", "fe80::1"],
    ["fe80::1:3080", "fe80::1"],
    ["2001:db8::1", "2001:db8::1"],
    ["2001:db8::1:443", "2001:db8::1"],
    ["127.0.0.1", "127.0.0.1"],
    ["127.0.0.1:19387", "127.0.0.1"],
    ["localhost", "localhost"],
    ["localhost:3080", "localhost"],
    ["example.com", "example.com"]
  ];
  for (const [spelling, expected] of cases) {
    check(`hostName normalizes "${spelling}"`, hostName(spelling) === expected, hostName(spelling));
  }

  const { settings } = resolveSettings({});
  const admit = (host, origin = undefined) => {
    const headers = { host };
    if (origin !== undefined) headers.origin = origin;
    return isAdmitted({ headers }, settings.allowedHosts);
  };
  const admitCases = [
    // Loopback spellings: all four default whitelist entries must be reachable.
    ["::1", null, true, "bare ::1 with no port"],
    ["::1:3080", null, true, "bare ::1 with a port — the old dead entry"],
    ["[::1]", null, true, "bracketed ::1 without a port"],
    ["[::1]:19387", null, true, "bracketed ::1 with a port"],
    ["localhost:3080", null, true, "hostname with a port"],
    ["127.0.0.1:19387", null, true, "IPv4 with a port"],
    // Not loopback: the whitelist must keep refusing it.
    ["2001:db8::1", null, false, "a public IPv6 literal is refused"],
    ["2001:db8::1:443", null, false, "a public IPv6 literal with a port is refused"],
    ["example.com", null, false, "a foreign hostname is refused"],
    // The cross-site forgery layer still fires on top of the whitelist.
    ["localhost:3080", "http://evil.test", false, "a foreign Origin is refused even on a whitelisted host"]
  ];
  for (const [host, origin, expected, note] of admitCases) {
    check(`isAdmitted ${note}`, admit(host, origin) === expected, String(admit(host, origin)));
  }
}

// --- 6. the one slug every addressable surface derives from ----------------
// `name` is the route prefix, the credential scope, and the state directory.
// Two files cannot import it and repeat it literally — package.json#name and
// the patch row's id/name pair — so a rename used to be checked by hand in
// three places. The old comment admitted the test pinned CONFIG_DEFAULTS only.
// Pin all three here: a rename that touches the code but not either mirror
// (or vice versa) now goes red, because the stored grant's scope moves with it.
{
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  check("package.json name equals the host-config slug", pkg.name === name, `${pkg.name} !== ${name}`);
  // The row is `- insert:` → a list item whose own fields are `- id:` /
  // `name:`; accept an optional list dash and any indentation on either.
  const rowId = patch.match(/^\s*-?\s*id:\s*(\S+)\s*$/m)?.[1];
  check("cordis.patch.yml row id equals the slug", rowId === name, `${rowId} !== ${name}`);
  const rowName = patch.match(/^\s*-?\s*name:\s*(\S+)\s*$/m)?.[1];
  check("cordis.patch.yml row name equals the slug", rowName === name, `${rowName} !== ${name}`);
  // The scope the grant is actually stored under must be this same slug, so the
  // two checks above are really guarding the stored credential's address.
  check("the credential scope derives from the same slug",
    credentialKey(name, "sensenova-console") === `${name}/sensenova-console`);
}

// --- 6b. the client's route templates match the host's derived ones --------
// §6 pins the slug in package.json, the patch row and the credential scope.
// It does NOT reach the HTTP paths: `src/client/const.ts` spells seven
// `/api/${NS}/<resource>` TEMPLATES (the browser bundle cannot import the
// host, so it derives them from its own NS), while `src/host/routes.ts`
// derives the same seven as `/api/${name}/<resource>` from the registered
// name. Between the two, and the literals re-declared in
// `test/routes.test.mjs`, there was no pin — so a rename of the slug, or
// adding a route on one side only, read as green until the panel 404'd. All
// three spellings are scanned as text and expanded to their literal form, so
// the check proves the CLIENT side really is a template off NS, the HOST side
// really is derived, the two slugs agree, and the SUITE's own copies did not
// drift away from either.
{
  const clientSrc = readFileSync(join(here, "..", "src", "client", "const.ts"), "utf8");
  const hostSrc = readFileSync(join(here, "..", "src", "host", "routes.ts"), "utf8");
  const suiteSrc = readFileSync(join(here, "..", "test", "routes.test.mjs"), "utf8");

  // The client spells the whole path as a template off its own NS
  // (`\`/api/${NS}/snapshot\``); the host derives the same one off the
  // registered `name` (`\`/api/${name}/snapshot\``). Both are expanded to the
  // literal form before comparing, which is what makes a slug rename fail: the
  // NS literal must equal the host's name, or every expanded path differs. The
  // suite re-declares the same literals once, at its top (the request helpers
  // call them by name); those are scanned too, by the same rule as the
  // client's, so a third copy that fell behind turns this red rather than
  // silently testing a path the panel never uses.
  const clientNs = clientSrc.match(/export const NS = "([^"]+)"/)?.[1] ?? "";
  const clientPaths = [...clientSrc.matchAll(/\/api\/\$\{NS\}\/([^`"\s]+)/g)]
    .map((m) => `/api/${clientNs}/${m[1]}`)
    .sort();
  const hostPaths = [...hostSrc.matchAll(/\/api\/\$\{name\}\/([^`"\s]+)/g)]
    .map((m) => `/api/${name}/${m[1]}`)
    .sort();
  const suitePaths = [...suiteSrc.matchAll(/(?:const|,)\s*([A-Z_]+_PATH)\s*=\s*"(?:https?:)?\/api\/([^"\s]+)"/g)]
    .map((m) => `/api/${m[2]}`)
    .sort();

  check("client/const.ts NS literal equals the host slug",
    clientNs !== "" && clientNs === name, `client NS: ${clientNs} | host name: ${name}`);
  check("client/const.ts actually declares route templates", clientPaths.length >= 7, clientPaths.join(", "));
  check("host/routes.ts derives the same number of routes", hostPaths.length === clientPaths.length, hostPaths.join(", "));
  check("test/routes.test.mjs re-declares the same paths", suitePaths.length === clientPaths.length, suitePaths.join(", "));
  check("the client, the host and the suite agree path for path",
    JSON.stringify(clientPaths) === JSON.stringify(hostPaths) && JSON.stringify(hostPaths) === JSON.stringify(suitePaths),
    `client: ${clientPaths.join(", ")} | host: ${hostPaths.join(", ")} | suite: ${suitePaths.join(", ")}`);
}

// --- 7. trendMultipliers sanitization ----------------------------------
// The pseudo-multiplier map reaches the panel as ×N labels, so a malformed
// entry must be dropped (not thrown — one typo must not take the panel down)
// while insertion order survives, because matching is first-key-wins.
{
  // resolveSettings routes through the same sanitizer.
  const viaSettings = resolveSettings({ trendMultipliers: { "glm-5.2": 10, bad: 0 } }).settings.trendMultipliers;
  check("resolveSettings keeps only positive entries", JSON.stringify(viaSettings) === JSON.stringify({ "glm-5.2": 10 }), JSON.stringify(viaSettings));

  const dropped = resolveTrendMultipliers({ "": 5, zero: 0, negative: -2, nan: NaN, inf: Infinity, text: "10", "kimi-k3": 20 });
  check("invalid entries are silently dropped",
    JSON.stringify(dropped) === JSON.stringify({ "kimi-k3": 20 }), JSON.stringify(dropped));

  const order = resolveTrendMultipliers({ z: 1, a: 2 });
  check("insertion order survives (first match wins)", Object.keys(order).join(",") === "z,a", Object.keys(order).join(","));

  check("an explicit {} disables all multipliers",
    Object.keys(resolveTrendMultipliers({})).length === 0, JSON.stringify(resolveTrendMultipliers({})));

  check("undefined falls back to the shipped defaults",
    JSON.stringify(resolveTrendMultipliers(undefined)) === JSON.stringify(CONFIG_DEFAULTS.trendMultipliers), "");
  check("a non-object falls back to the shipped defaults",
    JSON.stringify(resolveTrendMultipliers("glm-5.2=10")) === JSON.stringify(CONFIG_DEFAULTS.trendMultipliers), "");
  check("an array falls back to the shipped defaults",
    JSON.stringify(resolveTrendMultipliers([10])) === JSON.stringify(CONFIG_DEFAULTS.trendMultipliers), "");
}

// --- 8. numeric field clamping boundaries ----------------------------
// Every numeric field flows through `clampInt(raw, def, min, max?)` in
// `resolveSettings`: floor, then clamp low, then clamp high; a non-positive or
// NaN `raw` falls back to `def`. Pin each bound so a future edit to the clamp
// cannot change the effective range the panel reports without going red.
// (Note: `num` rejects 0, so to exercise the *lower* clamp a small FRACTIONAL
// raw is used — an integer 0 would fall back to `def` instead.)
{
  const clamp = (cfg) => resolveSettings(cfg).settings;
  const tFloor = clamp({ trendHours: 12.9 }).trendHours;
  check("trendHours floors fractional input", tFloor === 12, String(tFloor));
  const tMax = clamp({ trendHours: 9999 }).trendHours;
  check("trendHours caps at 168", tMax === 168, String(tMax));
  const tLow = clamp({ trendHours: 0.5 }).trendHours;
  check("trendHours clamps to its 1 floor on a fractional raw", tLow === 1, String(tLow));
  const cLow = clamp({ cacheSeconds: 3 }).cacheSeconds;
  check("cacheSeconds clamps to its 5 floor", cLow === 5, String(cLow));
  const pLow = clamp({ pollSeconds: 3 }).pollSeconds;
  check("pollSeconds clamps to its 5 floor", pLow === 5, String(pLow));
  const ctLow = clamp({ consoleTimeoutMs: 500 }).consoleTimeoutMs;
  check("consoleTimeoutMs clamps to its 1000 floor", ctLow === 1000, String(ctLow));
  const skLow = clamp({ tokenSkewSeconds: 0.5 }).tokenSkewSeconds;
  check("tokenSkewSeconds clamps to its 0 floor on a fractional raw", skLow === 0, String(skLow));
  const dtLow = clamp({ drawTimeoutMs: 10 }).drawTimeoutMs;
  check("drawTimeoutMs clamps to its 5000 floor", dtLow === 5000, String(dtLow));
  const nanFall = clamp({ trendHours: "not a number" }).trendHours;
  check("a non-numeric trendHours falls back to default", nanFall === CONFIG_DEFAULTS.trendHours, String(nanFall));
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

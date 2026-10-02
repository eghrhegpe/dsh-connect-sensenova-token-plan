/**
 * The plugin's configuration contract and the Host trust fence.
 *
 * Everything the Host half reads from the row's patch config lives here, plus
 * the `isAdmitted` check that keeps a foreign page from planting an account.
 * `test/config.test.mjs` pins `CONFIG_DEFAULTS` and the resolvers against this
 * file and `cordis.patch.yml`, so the code and the documented contract cannot
 * silently drift.
 * @module dsh-connect-sensenova-token-plan/host-config
 */

import { str, obj, num, errMsg } from "./util.ts";

/**
 * The one slug every addressable surface of this plugin derives from.
 *
 * Besides the name the Loader reports for the row, it is also the `/api` route
 * prefix (`routes.ts`), the credential record's scope (`token-store.ts`) and the
 * state directory (`throttle-store.ts`) — so a rename has to carry the user's
 * stored grant and parked throttle with it, not just the text.
 *
 * The mirrors that cannot import this constant are pinned by
 * `test/config.test.mjs`, so a rename on either side goes red instead of
 * leaving the stored grant behind: §6 checks the literal `package.json#name`
 * and the patch row's `id`/`name` pair against it, and §6b checks that every
 * route literal in `src/client/const.ts` (the browser bundle cannot derive them)
 * equals the `/api/${name}/…` this half builds in `routes.ts`.
 */
export const name = "dsh-connect-sensenova-token-plan";
/** Cordis services this plugin needs; without `webServer` it stays inactive. */
export const inject = ["webServer"];

/**
 * The plugin's configuration contract in one place.
 *
 * Every default the Host half reads lives here, so the code and the
 * `cordis.patch.yml` that documents it cannot silently drift: `test/config.test.mjs`
 * pins both against this object. The `auth` sub-object lists the operator-facing
 * login-flow overrides (their patch.yml entries are commented by default, which is
 * why they default to empty/zero and mean "use the platform default").
 *
 * ⚠️ That `auth` block is only the DEFAULTS SHAPE — do NOT copy it into
 * `cordis.patch.yml` as a nested block. The patch row must spell these keys at
 * the TOP LEVEL, and {@link resolveAuthOverrides} throws on a nested `auth`
 * block: the loader accepts one, this resolver drops it, and the panel would
 * keep talking to the real platform (redline 3).
 */
export const CONFIG_DEFAULTS = Object.freeze({
  consoleBase: "https://platform.sensenova.cn",
  apiBase: "https://token.sensenova.cn/v1",
  trendHours: 24,
  /**
   * Pseudo multipliers for the trend table, keyed by a case-insensitive
   * SUBSTRING of a model id (first matching key wins, in insertion order).
   * The platform returns raw credits with no official per-model rate, so
   * these numbers are the operator's own comparison aid — the panel labels
   * them as custom/non-official and rows without a match stay unmultiplied.
   * Shipped defaults reflect the operator's rough current rates.
   */
  trendMultipliers: { "glm-5.2": 10, "kimi-k3": 20, "sensenova": 1, "deepseek": 1 },
  cacheSeconds: 60,
  pollSeconds: 30,
  consoleTimeoutMs: 15_000,
  tokenSkewSeconds: 120,
  auth: {
    iamBase: "",
    tokenEndpoint: "",
    jwksEndpoint: "",
    redirectUri: "",
    clientId: "",
    scope: "",
    encKeyId: "",
    maxHops: 0,
    loginTimeoutMs: 0,
    requestTimeoutMs: 0
  },
  /** Host names the Host answers as, by default. The operator's list is added. */
  admittedHosts: ["localhost", "127.0.0.1", "[::1]", "::1"],
  /**
   * Vision step two: whether the Host syncs the identified vision-capable
   * model ids into THIS row's own settings namespace (`imageModelIds`,
   * `visionModels`) on every catalog poll, for a later LLM connect plugin to
   * read. Off by default - the read-only info layer is the safe shape. The
   * writes go to this plugin's OWN settings row only, never another
   * provider's, so a miscalculated list cannot reach DSH's model routing.
   */
  writeImageModelIds: false,
  /** The last published image-model id list (the reader's primary field). */
  imageModelIds: [],
  /** The last full vision identification (id + source marker per model). */
  visionModels: [],
  /**
   * Step three ("one-stop service"): register the LLM provider DIRECTLY.
   *
   * When true, the plugin calls `ctx.llm.registerAdapter` itself with an
   * OpenAI-compatible pi-ai adapter aimed at `apiBase`, the catalog poll feeds
   * its model list, vision models carry image input automatically, and the
   * panel-saved `SENSENOVA_API_KEY` reference authenticates requests. Off by
   * default for the same reason `writeImageModelIds` is: registering a model
   * source is a Host-wide change, not a read-only panel view, so it stays an
   * explicit opt-in and an operator with the hand-written `llm-pi-ai` row is
   * not suddenly offered two providers.
   */
  registerProvider: false,
  /**
   * Draw absorption (ARCHITECTURE §5.4 route B): register the
   * `sensenova_draw_image` agent tool. When true AND the Host exposes a tools
   * service, image-generation requests go to `{apiBase}/images/generations`
   * with the panel-saved `SENSENOVA_API_KEY`, and the model list comes from
   * the catalog's own `output_modalities` (never a name regex). Off by
   * default like every execution module: a tool the agent can call is a
   * Host-wide change, and a Host without the tools service must simply never
   * see it rather than fail.
   *
   * 0.4.2: this value is now the DEPLOYMENT DEFAULT only. The panel's draw
   * tool switch (`POST /api/<name>/draw`, stored in `draw-store.ts`)
   * overrides it live with no restart. See `docs/PROVIDER-HOT-RELOAD.md` §7.
   */
  drawEnabled: false,
  /** Preferred draw model id; empty means "first image-gen model of the catalog". */
  drawModelId: "",
  /** Deadline for one image request. Image models are slow; chat deadlines do not apply. */
  drawTimeoutMs: 120_000
});

/**
 * Sanitize the operator's pseudo-multiplier map: keep only string keys and
 * finite positive numbers, preserving insertion order (matching is
 * first-key-wins). A non-object or empty input falls back to the shipped
 * defaults; the operator sets `{}` explicitly to disable all multipliers.
 * Exported so `test/config.test.mjs` drives the same sanitizer the resolve
 * path uses, instead of a copy that could drift.
 * @param {unknown} raw - the raw `trendMultipliers` config value.
 * @returns {Record<string, number>} the sanitized map.
 */
export function resolveTrendMultipliers(raw) {
  const source = raw === undefined || raw === null ? CONFIG_DEFAULTS.trendMultipliers : raw;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return { ...CONFIG_DEFAULTS.trendMultipliers };
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof key === "string" && key !== "" && typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Clamp a raw numeric setting to its effective integer.
 *
 * Every numeric field in {@link resolveSettings} follows the same shape: floor
 * the raw value, clamp it at a lower bound, then (optionally) at an upper bound;
 * a non-positive or non-finite raw falls back to `def` (because `num` only
 * accepts a positive finite number). The sequence — `Math.min(max, Math.max(min,
 * Math.floor(raw)))` with `max` defaulting to `Infinity` — is exactly what the
 * inline `Math.max`/`Math.min` chains used to spell out one field at a time, so
 * this is a MOVE of that pattern into one tested place, not a behaviour change.
 * @param {unknown} raw - the raw value read from the row.
 * @param {number} def - the fallback when `raw` is not a positive finite number.
 * @param {number} min - the lower clamp (inclusive) applied after flooring.
 * @param {number} [max] - the upper clamp (inclusive); omit for no upper bound.
 * @returns {number} the clamped integer.
 */
export function clampInt(raw, def, min, max = Infinity) {
  return Math.min(max, Math.max(min, Math.floor(num(raw, def))));
}

/**
 * Resolve the row's raw patch config into effective settings.
 *
 * A malformed row must not throw out of here: `apply` runs at mount, and an
 * exception would take the whole plugin down instead of leaving a panel that
 * explains itself. So problems are returned as `configError` and surfaced
 * through the snapshot route.
 * @param {object} config - the row's raw patch config.
 * @returns {{settings: object, configError: string|null}}
 */
export function resolveSettings(config) {
  const source = obj(config);
  const consoleBase = str(source.consoleBase, CONFIG_DEFAULTS.consoleBase).replace(/\/+$/, "");
  const apiBase = str(source.apiBase, CONFIG_DEFAULTS.apiBase).replace(/\/+$/, "");
  try {
    return {
      settings: {
        consoleBase,
        apiBase,
        trendHours: clampInt(source.trendHours, CONFIG_DEFAULTS.trendHours, 1, 168),
        // Pseudo trend multipliers: only well-formed entries travel (string
        // key, finite positive number); anything else is dropped rather than
        // throwing — a typo in one row must not take the panel down.
        trendMultipliers: resolveTrendMultipliers(source.trendMultipliers),
        cacheSeconds: clampInt(source.cacheSeconds, CONFIG_DEFAULTS.cacheSeconds, 5),
        // How often the panel asks again. The Host states it rather than the
        // panel assuming one, so the two cannot disagree about how fresh the
        // screen is.
        pollSeconds: clampInt(source.pollSeconds, CONFIG_DEFAULTS.pollSeconds, 5),
        // Deadline for one console call. The login flow has its own
        // (`loginTimeoutMs`, below): it walks several IAM hops, so the two
        // are not the same number and pretending otherwise is how a slow
        // login gets blamed on the console.
        consoleTimeoutMs: clampInt(source.consoleTimeoutMs, CONFIG_DEFAULTS.consoleTimeoutMs, 1_000),
        // Which host names this Host answers as. See `isAdmitted`: the panel
        // has a write route, so the loopback defaults can be widened but not
        // replaced.
        allowedHosts: resolveAllowedHosts(source),
        // Renew the console token this long before it actually expires, so a
        // panel poll never races the expiry boundary.
        tokenSkewSeconds: clampInt(source.tokenSkewSeconds, CONFIG_DEFAULTS.tokenSkewSeconds, 0),
        // Console login-flow overrides, handed to `createAuth` verbatim: it owns
        // the platform defaults, so only what the operator actually set travels.
        auth: resolveAuthOverrides(source, consoleBase),
        // Vision step two: the opt-in and the last published lists. The
        // lists are read back from the row so a restart does not lose the
        // answer the Host last computed (a reader that arrives before the
        // first catalog poll still sees the previous catalog's set).
        writeImageModelIds: source.writeImageModelIds === true,
        imageModelIds: Array.isArray(source.imageModelIds)
          ? source.imageModelIds.filter((id) => typeof id === "string")
          : CONFIG_DEFAULTS.imageModelIds,
        visionModels: Array.isArray(source.visionModels)
          ? source.visionModels.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
          : CONFIG_DEFAULTS.visionModels,
        // Step three opt-in: register the OpenAI-compatible LLM provider
        // directly (strict boolean, like writeImageModelIds).
        registerProvider: source.registerProvider === true,
        // Draw absorption opt-in (strict boolean, same reasoning as
        // registerProvider) plus its two knobs. The deadline has its own
        // floor: image models regularly take tens of seconds, and a chat-
        // sized deadline would abort healthy requests.
        drawEnabled: source.drawEnabled === true,
        drawModelId: str(source.drawModelId, ""),
        drawTimeoutMs: clampInt(source.drawTimeoutMs, CONFIG_DEFAULTS.drawTimeoutMs, 5_000)
      },
      configError: null
    };
  } catch (error) {
    // Fall back to the shipped defaults so the panel still mounts and can show
    // the reason, rather than vanishing.
    return {
      settings: {
        consoleBase,
        apiBase,
        trendHours: CONFIG_DEFAULTS.trendHours,
        trendMultipliers: CONFIG_DEFAULTS.trendMultipliers,
        cacheSeconds: CONFIG_DEFAULTS.cacheSeconds,
        pollSeconds: CONFIG_DEFAULTS.pollSeconds,
        consoleTimeoutMs: CONFIG_DEFAULTS.consoleTimeoutMs,
        allowedHosts: new Set(CONFIG_DEFAULTS.admittedHosts),
        tokenSkewSeconds: CONFIG_DEFAULTS.tokenSkewSeconds,
        auth: { consoleOrigin: consoleBase }
      },
      configError: errMsg(error)
    };
  }
}

/**
 * Collect just the auth keys the operator actually set.
 *
 * The keys are read from the TOP LEVEL of the row. That is not obvious, and
 * getting it wrong is not a harmless typo: a nested `auth:` block is accepted
 * by the loader, silently dropped here, and the panel then runs on its shipped
 * defaults — which point at the REAL platform. An end-to-end run meant to talk
 * to a local stub then posts a real login attempt, which is exactly how this
 * plugin locked an account once already. So a nested `auth` key is reported as
 * a configuration error rather than ignored.
 * @param {object} source - the row's raw patch config.
 * @param {string} consoleBase - the resolved console origin.
 * @returns {object} the override object for `createAuth`.
 * @throws {Error} when the row looks like it nests overrides it does not read.
 */
export function resolveAuthOverrides(source, consoleBase) {
  // ANY nested `auth` block is refused, not just the two names below: none of
  // its keys are read, so a block of any shape is silently ignored. Testing for
  // a fixed list would leave `auth: { iamBase: ... }` — the exact key an
  // operator reaches for — as the one case that still fails quietly.
  if (source.auth !== undefined && source.auth !== null) {
    const keys = Object.keys(obj(source.auth));
    throw new Error(
      "auth overrides are top-level keys on this row, not a nested `auth:` block" +
        `${keys.length === 0 ? "" : ` (found: ${keys.join(", ")})`}. ` +
        "Use `iamBase`, `tokenEndpoint`, `jwksEndpoint`, `redirectUri`, `clientId`, " +
        "`scope` or `encKeyId` at the top level; a nested block is ignored and the " +
        "panel would keep using the real platform."
    );
  }
  const text = (key) => str(source[key], "");
  const overrides: Record<string, unknown> = { consoleOrigin: consoleBase };
  const set = (key: string, value: any, transform?: (value: any) => any) => {
    if (value === "") return;
    overrides[key] = transform === undefined ? value : transform(value);
  };
  set("iamOrigin", text("iamBase"), (value) => value.replace(/\/+$/, ""));
  set("tokenEndpoint", text("tokenEndpoint"));
  set("jwksEndpoint", text("jwksEndpoint"));
  set("redirectUri", text("redirectUri"));
  set("clientId", text("clientId"));
  set("scope", text("scope"));
  set("encKeyId", text("encKeyId"));
  const maxHops = Math.floor(num(source.maxHops, 0));
  if (maxHops > 0) overrides.maxHops = maxHops;
  // `requestTimeoutMs` is what this option shipped as, but it only ever fed
  // the login flow — the console calls below had their own hardcoded deadline.
  // The old name still wins when only it is set, so a config written against
  // an earlier version keeps its deadline instead of silently reverting to
  // the default.
  const loginTimeoutMs = Math.floor(num(source.loginTimeoutMs, num(source.requestTimeoutMs, 0)));
  if (loginTimeoutMs > 0) overrides.requestTimeoutMs = loginTimeoutMs;
  return overrides;
}

/**
 * Collect the host names this Host will answer as.
 *
 * The operator's list is ADDED to the defaults, never substituted: replacing
 * them would let a typo lock the panel out of itself, and there is no console
 * to fix it from.
 * @param {object} source - the row's raw patch config.
 * @returns {Set<string>} the admitted host names, lowercased.
 */
export function resolveAllowedHosts(source) {
  const admitted = new Set(CONFIG_DEFAULTS.admittedHosts);
  const extra = Array.isArray(source.allowedHosts) ? source.allowedHosts : [];
  for (const entry of extra) {
    const name = str(entry, "").trim().toLowerCase();
    if (name !== "") admitted.add(name);
  }
  return admitted;
}

/**
 * The host name a `Host` header names, without its port.
 * @param {string} host - the raw header value.
 * @returns {string} the name; bracketed for IPv6 literals.
 */
export function hostName(host) {
  // "[::1]:8080" keeps its brackets; "localhost:8080" loses its port.
  if (host.startsWith("[") && host.includes("]")) {
    return host.slice(0, host.indexOf("]") + 1);
  }
  // A bare IPv6 literal carries more than one colon. A "name with an optional
  // port" is valid for such a value only when the ENTIRE part after the
  // SECOND-TO-LAST colon is a bare port:
  //   "::1:3080"   -> segments ["", "", "1", "3080"], after the 2nd-to-last
  //                    colon is "3080" (digits) -> name "::1"
  //   "::1"        -> segments ["", "", "1"], after the 2nd-to-last colon is
  //                    ":1" (colons are not digits) -> name "::1"
  //   "fe80::1"    -> segments ["fe80", "", "1"], after the 2nd-to-last
  //                    colon is ":1" -> name "fe80::1"
  // So the port, when present, is ALWAYS the last segment alone, and the
  // port-separator is the last colon only when the text after it is all
  // digits AND the text between that last colon and the one before it is
  // ALSO all digits ("1:3080" — the address's final group plus the port).
  // That distinguishes "::1" (":1" after the 2nd-to-last colon: has a colon,
  // not a port) from "::1:3080" ("3080" after the last colon: bare port).
  // A host the operator did not name is returned untouched: refused, which
  // is the safe direction.
  const colons = host.split(":");
  if (colons.length > 2) {
    // "address + port" = 2nd-to-last and last segments are BOTH digits.
    if (/^\d+$/.test(colons[colons.length - 2]) && /^\d+$/.test(colons[colons.length - 1])) {
      return host.slice(0, host.lastIndexOf(":"));
    }
    return host;
  }
  // 0 or 1 colons: a bare `:port` tail, or nothing at all.
  return colons.length > 1 ? host.slice(0, host.lastIndexOf(":")) : host;
}

/**
 * Trust fence for a route the browser can reach.
 *
 * Two different attacks have to be turned away here, and they need two
 * different facts:
 *
 * 1. DNS rebinding. The attacker's page rebinds its own name to 127.0.0.1 and
 *    POSTs an account. `Origin` and `Host` now AGREE on the attacker's name
 *    while the request lands on the Host, so comparing them to each other
 *    admits it. The `Host` header is the one thing a browser cannot forge, so
 *    it is checked against a whitelist instead of against the `Origin`.
 * 2. Cross-site forgery. A page on another origin asks the browser to post to
 *    the loopback Host. Here the whitelist alone is worthless — the Host IS
 *    legitimate — and the `Origin` is what gives it away.
 *
 * So: the `Host` must be one this Host answers as, AND any stated `Origin`
 * must agree with it. A request that states no `Origin` is the ordinary
 * same-origin GET and is admitted.
 *
 * The boundary this draws is the BROWSER, not the machine. A process running
 * as the user sets `Host` and `Origin` to whatever it likes, and there is no
 * CSRF token here to tell it apart from the panel — so anything that can open
 * a socket to this port can also plant an account. That is the same trust the
 * Host places in the user's own processes generally, but it is worth saying
 * plainly: an `Origin` check reads like more protection than it is, and a
 * reader who believes otherwise will build something on top of it. Closing
 * that gap needs a token the Host serves in its own page and the POST carries
 * back, not a header a client can choose.
 * @param request - the incoming HTTP request.
 * @param {Set<string>} allowedHosts - the host names this Host answers as.
 * @returns {boolean} whether the request may be served.
 */
export function isAdmitted(request, allowedHosts) {
  const host = str(request.headers?.host, "").toLowerCase();
  if (host === "" || !allowedHosts.has(hostName(host))) return false;
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin === "") return true;
  if (origin === "null") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

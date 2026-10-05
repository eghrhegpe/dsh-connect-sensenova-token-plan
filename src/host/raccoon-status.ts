/**
 * The Raccoon tab's read model: one GET-shaped answer, assembled in one place.
 *
 * This used to be a 190-line closure inside the `/raccoon` HTTP handler, so it
 * was reachable only by mounting the route and driving it with a stub gateway.
 * Nothing in it is HTTP — it is a read model over two stores, one publisher and
 * one cache — and burying it in a handler meant the eager-refresh gate, the
 * cache keys, the `ModelsSource` tri-state and the `?debug=1` scaffold all
 * stayed unpinned by any unit test. It lives here now, where
 * `test/raccoon-status.test.mjs` drives it with fakes and no route at all.
 *
 * The ONE thing it does not own is the login walk's transient state — the
 * pending scan, the in-flight gate, the settled outcome. That is route
 * lifecycle (it drives a publisher and reads a catalogue), so the route hands
 * it in through {@link RaccoonLoginView} rather than the module reaching for
 * it. `test/raccoon.test.mjs` keeps covering that side.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-status
 */
import { createHash } from "node:crypto";
import { fetchRaccoonBalance, fetchRaccoonCatalog, RACCOON_FALLBACK_MODELS, RACCOON_QR_POLL_INTERVAL_MS } from "./raccoon.ts";
import { str, redactSecrets, optional, errMsg, pickDefined } from "./util.ts";
import { resolveSwitchEnabled } from "./switch-precedence.ts";
import type { RaccoonState, RaccoonModel } from "../shared/wire.ts";

/**
 * How long one Raccoon balance read stays fresh.
 *
 * The tab polls every 60 s, and while a QR scan is waiting it polls every 2 s —
 * without a cache that fast poll is 30 gateway calls a minute for a number that
 * moves when the account spends. The window matches the slow cadence, so a
 * scan's fast poll costs the same two calls a minute the idle tab does.
 */
export const RACCOON_BALANCE_TTL_MS = 60_000;
/**
 * How long one Raccoon catalogue read stays fresh (longer: the roster drifts
 * when the gateway adds a model, not while a session is open).
 */
export const RACCOON_CATALOG_TTL_MS = 300_000;

/**
 * The proxy variables the diagnostics report — names only, and only when set.
 *
 * A hop between this Host and the gateway is the one thing a fresh-process
 * probe cannot see, and it is the shape of "same file, probe 200, panel 401".
 */
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "NO_PROXY",
  "no_proxy"
];

/**
 * A secret-free, stable identity for one access token, used as the cache key
 * half so a rotated credential never reads the previous one's answer.
 * @param {string} token - the access token (never stored, never logged).
 * @returns {string} a 12-hex-character digest prefix.
 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(typeof token === "string" ? token : "", "utf8").digest("hex").slice(0, 12);
}

/**
 * Mask a proxy URL's userinfo before it leaves the process.
 *
 * `hostProxyEnv` answers one question — "is there a hop between this Host and
 * the gateway?" — and the hop is the host:port. The credentials are not part of
 * that answer, yet a corporate proxy is routinely spelled
 * `http://user:password@proxy:8080`, so reporting the value verbatim would put
 * a live password into an HTTP response body. A diagnostic must never be worth
 * more than the fact it carries.
 *
 * Both spellings are handled (with and without a scheme) and an unparseable
 * value is masked textually rather than assumed clean; a value with no userinfo
 * is returned untouched, so the hop still reads.
 * @param {string} key - the environment variable's name.
 * @param {string|undefined} value - its value.
 * @returns {string} the `KEY=value` pair, with any userinfo replaced by `***`.
 */
export function maskProxyUserinfo(key: string, value: string | undefined): string {
  const text = str(value, "");
  // `[^/@]*@` cannot cross a `/`, so a path-borne `@` is never mistaken for
  // userinfo; the optional leading group covers `scheme://` and `//`.
  return `${key}=${text.replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)?[^/@]*@/i, "$1***@")}`;
}

/**
 * The login walk's transient state, as the read model needs to see it.
 *
 * Kept as an interface rather than a shared object so the route stays the sole
 * owner of the walk: the module can only ask, and cannot forget to clear.
 */
export interface RaccoonLoginView {
  /**
   * Take the walk's outcome ONCE.
   *
   * A terminal status (`logged_in` / `timeout` / `canceled` / `failed`) is an
   * EVENT, not a state: it is consumed here so a later poll cannot re-announce
   * a two-minute-old timeout. `"scanning"` is not consumed — it is the live
   * state of an in-flight walk.
   * @returns {{status: string|null, error: string|null}} the outcome, cleared.
   */
  takeEvent(): { status: string | null; error: string | null };
  /**
   * The scan a pending walk last issued, or `null` when none is waiting.
   * @returns {{code: string, url: string}|null} the scan.
   */
  liveScan(): { code: string; url: string } | null;
}

/**
 * What the read model reads through. Everything is injected so this module
 * imports no Host peer and can be driven with fakes.
 */
export interface RaccoonStatusDeps {
  /** The Raccoon credential store (`raccoon-store.ts`), or absent. */
  store?: any;
  /** The switch/curation store (`raccoon-switch-store.ts`), or absent. */
  switchStore?: any;
  /** The Raccoon provider publisher, or absent (its `state` is reported). */
  publisher?: any;
  /** The coalescing read-through cache (`coalesced-fetch.ts`). */
  read: { read: (key: string, producer: () => Promise<any>, ttlMs: number) => Promise<any> };
  /** The route-owned login walk's transient state. */
  login: RaccoonLoginView;
  /** The web_search opt-in store (`raccoon-web-store.ts`), or absent. */
  webSearchStore?: any;
  /** The config-level `webSearchEnabled` (host-config.ts), default off. */
  webSearchConfig?: boolean;
}

/**
 * Assemble the tab's read model.
 *
 * @param {RaccoonStatusDeps} deps - the stores, cache and login view.
 * @param {boolean} [withDiagnostics] - opt into the `?debug=1` triage scaffold.
 *   The POST branches re-report through this same function WITHOUT the flag,
 *   so a mutation never answers with environment values.
 * @returns {Promise<RaccoonState>} the secret-free state the tab renders.
 */
export async function readRaccoonStatus(deps: RaccoonStatusDeps, withDiagnostics = false): Promise<RaccoonState> {
  // ── The event read is FIRST, before any await in this function. ──
  //
  // Everything below costs at least one gateway read, which is time enough for
  // the login walk to finish its save. Reading the outcome last let one
  // response claim `loginStatus:"logged_in"` while the `loggedIn` computed at
  // the top still said the credential was absent — two facts from the same
  // answer, contradicting each other. Taken at the top, a terminal outcome
  // always postdates the state it names.
  const { status: loginStatus, error: loginError } = deps.login.takeEvent();
  const store = deps.store ?? null;
  const switchStore = deps.switchStore ?? null;
  const read = deps.read;
  const switchState = await optional(switchStore ? switchStore.enabled() : null);
  const effectiveEnabled = switchState === true;
  let loggedIn = false;
  let nickname = "";
  let balance = null;
  let balanceBreakdown: { daily?: number; reward?: number; monthly?: number; topup?: number } | null = null;
  let balanceDetail: string | null = null;
  let accessTokenPrefix: string | null = null;
  // Diagnostics (the 401 triage scaffold, `?debug=1` only — see below):
  // which layer the credential came from, whether the host's OWN process
  // environment carries a shadowing RACCOON_CREDENTIAL (the credentials
  // provider's inherited layer wins over the file), a secret-free
  // fingerprint of the exact access token the panel read, and the host
  // process's proxy env (a fresh-process probe has none — a difference
  // here would mean the same token reaches the gateway through a
  // different hop).
  let credentialSource: string | null = null;
  let raccoonEnvShadow: boolean | null = null;
  let envCredentialFingerprint: string | null = null;
  let accessTokenFingerprint: string | null = null;
  let hostProxyEnv: string[] | null = null;
  let error: string | null = null;
  // The credential's own expiry facts. `store.state()` already resolves them
  // (from the JWT `exp` claim); dropping them here is what made the tab say
  // "已登录" long after the access token died — the registration stayed up (the
  // publish gate only asks "is there a token?", not "is it live?"), so every
  // request failed with a 401 the panel could not name.
  let expiresAtMs: number | null = null;
  let credentialExpired = false;
  // The refresh token's window (≈30 days): how long the login survives
  // before a re-scan is the ONLY way back.
  let refreshExpiresAtMs: number | null = null;
  try {
    if (store !== null) {
      let state = await store.state().catch(() => null);
      loggedIn = state?.hasCredential === true;
      nickname = state?.nickname ?? "";
      credentialSource = state?.source ?? null;
      if (loggedIn) {
        // The same pre-request ritual the seed path calls — one call into the
        // store's `prepareForRequest`, never a second copy of it.
        // 3-hour access token with a live 30-day refresh must not 401 the
        // panel. Rotate in place (single-flight, whole-pair re-store, owned
        // by the store so no call site can drift), then re-read state so
        // the surfaced expiry facts describe the pair that
        // will actually serve the calls below.
        // Fast path: only re-read `state()` if the credential actually
        // lapsed — a live credential costs no extra round trip.
        if (await store.isExpired().catch(() => false)) {
          await store.prepareForRequest();
          state = await store.state().catch(() => state);
          loggedIn = state?.hasCredential === true;
          nickname = state?.nickname ?? "";
          credentialSource = state?.source ?? null;
        }
        if (typeof state?.expiresAtMs === "number") {
          expiresAtMs = state.expiresAtMs;
          credentialExpired = Date.now() >= state.expiresAtMs;
        }
        if (typeof state?.refreshExpiresAtMs === "number") {
          refreshExpiresAtMs = state.refreshExpiresAtMs;
        }
        const { credential } = await store.resolve().catch(() => ({ credential: null }));
        if (credential?.accessToken) {
          // The two token identifiers are computed ONLY for `?debug=1`: the
          // prefix and the SHA-256 fingerprint point at one exact credential,
          // and no client code reads either — so the ordinary poll neither
          // pays for the hash nor carries the identifier.
          if (withDiagnostics) {
            // Diagnostic: only the prefix, never the token, so a mismatch
            // against the stored credential is visible without leaking it.
            accessTokenPrefix = credential.accessToken.slice(0, 8);
            // SHA-256 prefix of the EXACT token the panel would send — a
            // stable, non-reversible identifier to diff against the file's
            // token (an `eyJhbGci` prefix is useless: every HS256 JWT starts
            // with it).
            accessTokenFingerprint = tokenFingerprint(credential.accessToken);
          }
          // `onFail` reports the concrete reason a read came back empty — a
          // broken request must not look like "the gateway has nothing to
          // say". Surfaced as `balanceDetail` for debugging.
          //
          // Cached + coalesced on the token's fingerprint: the tab polls
          // every 2 s while a scan is waiting, and a fresh number cannot
          // arrive faster than the account spends. Failures are shared,
          // never cached (see `coalesced-fetch.ts`).
          const balanceRead = await read
            .read(
              `balance:${tokenFingerprint(credential.accessToken)}`,
              () => fetchRaccoonBalance(credential, undefined, (why) => { balanceDetail = why; }),
              RACCOON_BALANCE_TTL_MS
            )
            .catch((why) => {
              balanceDetail = `call rejected: ${errMsg(why)}`;
              return null;
            });
          balance = balanceRead?.total ?? null;
          if (balanceRead !== null && balanceRead !== undefined) {
            // Declared, not inferred: each part is copied only when the
            // gateway declared it, so the target must accept optional numbers
            // (`{}` would reject every assignment).
            const parts: { daily?: number; reward?: number; monthly?: number; topup?: number } = {};
            if (balanceRead.daily !== undefined) parts.daily = balanceRead.daily;
            if (balanceRead.reward !== undefined) parts.reward = balanceRead.reward;
            if (balanceRead.monthly !== undefined) parts.monthly = balanceRead.monthly;
            if (balanceRead.topup !== undefined) parts.topup = balanceRead.topup;
            if (Object.keys(parts).length > 0) balanceBreakdown = parts;
          }
        }
      }
    }
  } catch (why) {
    error = redactSecrets(errMsg(why));
  }
  // The retirable scaffold below is computed only for `?debug=1` — the values
  // are the host process's own environment, and there is no reason for a poll
  // the panel makes every cycle to carry them.
  if (withDiagnostics) {
    // The host process's OWN launch environment (the credentials provider's
    // inherited layer, which beats the file): a RACCOON_CREDENTIAL set there
    // shadows the file credential for THIS host only — a fresh-process probe
    // never sees it. That is exactly the shape of "same file, probe 200, panel
    // 401". Presence + a fingerprint of the shadowing document, never the
    // value.
    raccoonEnvShadow = Object.hasOwn(process.env, "RACCOON_CREDENTIAL") && process.env.RACCOON_CREDENTIAL !== "";
    if (raccoonEnvShadow) {
      // Fingerprint of the SHADOWING document (the serialized reference value,
      // not a token): lets the panel side diff which copy this host actually
      // serves without printing either document.
      envCredentialFingerprint = tokenFingerprint(process.env.RACCOON_CREDENTIAL ?? "");
    }
    // Proxy env is the other per-process difference a fresh probe can't see:
    // a route through a corporate hop can drop or mangle the Authorization the
    // direct path carries. Names + the hop, with any userinfo masked: a proxy
    // URL may legitimately be `http://user:password@proxy:8080`, and that
    // password is not part of the fact this line carries.
    hostProxyEnv = PROXY_ENV_KEYS
      .filter((key) => process.env[key] !== undefined && process.env[key] !== "")
      .map((key) => maskProxyUserinfo(key, process.env[key]));
  }
  // The roster the adapter offers: the live catalogue when a credential exists
  // (the switch's own publish reads it too), else the static fallback so the
  // panel still shows the known models. `modelsSource` names which one the
  // panel is looking at — and WHY the fallback is in play, so the note does
  // not lie: a gateway that read fine but listed no visible model is "empty",
  // not "unreadable" (the two read as very different facts to the user).
  let models: RaccoonModel[] | null = null;
  let catalogReadFailed = false;
  try {
    if (store !== null) {
      const { credential } = await store.resolve().catch(() => ({ credential: null }));
      if (credential?.accessToken) {
        // Same treatment as the balance read: the catalogue is fetched once
        // per window per credential, and a scan's fast poll (or two open tabs)
        // share the one call that is already out.
        models = await read
          .read(
            `catalog:${tokenFingerprint(credential.accessToken)}`,
            () => fetchRaccoonCatalog(credential, undefined, () => { catalogReadFailed = true; }),
            RACCOON_CATALOG_TTL_MS
          )
          .catch(() => {
            catalogReadFailed = true;
            return null;
          });
      }
    }
  } catch {
    models = null;
    catalogReadFailed = true;
  }
  const rosterLive = models !== null && Array.isArray(models) && models.length > 0;
  const roster: readonly RaccoonModel[] = rosterLive ? models! : RACCOON_FALLBACK_MODELS;
  const modelsSource = rosterLive ? "live" : catalogReadFailed ? "unreadable" : "empty";
  const publisherState = deps.publisher?.state ?? null;
  // The pushed-model curation, so the tab's checkboxes render the saved list
  // (`null` = the panel never curated — the whole roster pushes).
  const savedIds = await optional(switchStore ? switchStore.enabledIds() : null);
  // The pending scan is read LAST, after the reads above, because it is the
  // one fact here that a settling walk can legitimately clear mid-request: a
  // walk that finished during those awaits has taken its scan away, and
  // reporting the stale URL beside a terminal `loginStatus` would put a QR on
  // screen for a login that is already over.
  const scan = deps.login.liveScan();
  // The 401-triage scaffold, assembled ONLY under `?debug=1`. It is dead
  // weight for the panel (no client code reads any of these keys) and one of
  // them reports environment values, so the ordinary poll must stay clean;
  // `hostProxyEnv` is masked even here. See ROADMAP §6.1.4.
  const diagnostics = withDiagnostics ? {
    ...pickDefined({ accessTokenPrefix }),
    ...pickDefined({ credentialSource }),
    raccoonEnvShadow: raccoonEnvShadow === true,
    ...pickDefined({ envCredentialFingerprint }),
    ...pickDefined({ accessTokenFingerprint }),
    hostProxyEnv
  } : {};
  const panelWebSearch = deps.webSearchStore ? await deps.webSearchStore.enabled().catch(() => null) : null;
  return {
    ok: true,
    enabled: effectiveEnabled,
    // The web_search opt-in, in the SAME precedence the mount-side registration
    // applies (`resolveSwitchEnabled`): the panel store beats the config, so a
    // switch flipped here and a `webSearchEnabled: true` in the plugin config
    // cannot disagree on the card. Absent either, the tool stays off.
    webSearchEnabled: resolveSwitchEnabled(panelWebSearch, deps.webSearchConfig === true),
    switchSource: switchState === null ? "off" : "panel",
    // The tab's own cadence, stated by the side that owns the cache windows —
    // the same discipline the quota snapshot follows with `pollSeconds`. The
    // client used to hard-code 60 s / 2 s while this module held the same two
    // numbers as TTLs, i.e. one knob with two homes and nothing able to see
    // them drift. Seconds, not milliseconds: this is a wire field, and the
    // snapshot's own spelling is seconds.
    pollSeconds: RACCOON_BALANCE_TTL_MS / 1000,
    scanPollSeconds: RACCOON_QR_POLL_INTERVAL_MS / 1000,
    loggedIn,
    nickname,
    // Whether the stored access token has lapsed. `loggedIn` alone says "a
    // credential exists"; this says whether it can still serve. The tab
    // renders a distinct re-login affordance on this flag.
    credentialExpired,
    ...pickDefined({ expiresAtMs }),
    ...pickDefined({ refreshExpiresAtMs }),
    // The in-flight scan (if a login walk is waiting): the tab re-renders its
    // QR from this on every poll, so a second tab / a refresh continues the
    // SAME scan instead of voiding it.
    ...pickDefined({ scanUrl: scan?.url, scanCode: scan?.code }),
    ...pickDefined({ loginStatus }),
    ...(loginError !== null && loginError !== "" ? { loginError } : {}),
    balance,
    ...pickDefined({ balanceBreakdown }),
    ...pickDefined({ balanceDetail }),
    ...diagnostics,
    models: roster,
    modelsSource,
    enabledModelIds: savedIds,
    providerRegistered: publisherState?.registered === true,
    ...pickDefined({ providerError: publisherState?.error }),
    ...pickDefined({ error })
  };
}

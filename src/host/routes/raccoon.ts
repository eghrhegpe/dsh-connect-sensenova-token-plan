/**
 * The Raccoon route (ROADMAP §6.1 "second upstream provider"): one GET
 * reporting the secret-free state a tab renders, one POST carrying `{ action }`
 * for the seven panel actions (provider switch, web search, the official-App
 * read-only source, pushed models, QR login, browser-authorize login, logout). The QR login is a single
 * server-side walk (no client long-poll); the credential never touches this plugin's directory,
 * git, or logs — it goes straight to the DSH credentials service through
 * `raccoonStore`.
 *
 * Part of the routes split (see `../routes.ts` for the family map). The walk
 * lifecycle is owned by `raccoon-walk.ts`: one instance for the entire route,
 * so a second click / tab mid-walk sees the SAME scan (concurrency gate via
 * `view.isInFlight()`). The route only drives the side-effects and reads the
 * transient state through `view`; one scan per process, cleared on settle, no
 * handler-local state survives a re-mount.
 *
 * @module dsh-connect-sensenova-token-plan/routes/raccoon
 */
import { name } from "../host-config.ts";
import { createCoalescedFetch } from "../coalesced-fetch.ts";
import { optional, verbatim } from "../util.ts";
import { writeJson, refuseMethod, readJsonBodyOr400, withOrigin, wantsDiagnostics, MAX_ENABLED_MODEL_IDS, MAX_RACCOON_BODY_BYTES, redactedError } from "./http.ts";
import type { Wiring } from "../types.ts";
import {
  pollRaccoonQrLogin,
  pollRaccoonIamQrLogin,
  issueRaccoonScan,
  fetchRaccoonCatalog,
  RACCOON_FALLBACK_MODELS,
  startRaccoonAuthorizeReceiver,
  exchangeRaccoonAuthorizationCode,
  RACCOON_AUTHORIZE_TIMEOUT_MS
} from "../raccoon.ts";
import type { RaccoonAuthorizeReceiver } from "../raccoon.ts";
// The tab's read model lives in its own peer-free module (it is not HTTP), so
// this handler owns only the walk and the four mutations. The catalogue cache
// window comes with it: `collectRaccoonRows` reads through the same cache.
import {
  readRaccoonStatus,
  tokenFingerprint,
  RACCOON_CATALOG_TTL_MS
} from "../raccoon-status.ts";
import { filterRaccoonRows } from "../raccoon-models.ts";
import { createRaccoonWalk, LOGIN_STATUS } from "../raccoon-walk.ts";
import { resolveSwitchOff } from "../switch-precedence.ts";

/** The Raccoon provider route (ROADMAP §6.1 "second upstream provider"). */
export const RACCOON_PATH = `/api/${name}/raccoon`;

// The QR walk's two timing constants (`RACCOON_LOGIN_TIMEOUT_MS`,
// `RACCOON_QR_POLL_INTERVAL_MS`) are gateway wire facts owned by
// `raccoon-consts.ts` (re-exported through the `raccoon.ts` barrel); their
// importers are `raccoon-walk.ts` and `raccoon-status.ts` (the scan cadence
// it reports), so they must never be re-declared HERE (ROADMAP §6.1.4;
// single-source check in `test/raccoon.test.mjs`).

/**
 * Register the Raccoon route. Wiring subset: `settings`, `raccoonStore`,
 * `raccoonSwitch`, `raccoonPublisher`, `raccoonCache`, `webSearchStore`,
 * `raccoonRosterSeen`, `reconcileWebSearch`, `raccoonDesktopSwitch`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {Pick<Wiring, "settings" | "raccoonStore" | "raccoonSwitch" | "raccoonPublisher" | "raccoonCache" | "webSearchStore" | "raccoonRosterSeen" | "reconcileWebSearch"
 *   | "raccoonDesktopSwitch">} wiring
 *   - the Raccoon half's subset, as assembled by `apply()` in `index.ts`. The
 *   `Pick` is what makes "changing the Raccoon line must not affect the Token
 *   Plan one" (ARCHITECTURE §5.5) a compile-time fact rather than a review
 *   promise: this route physically cannot reach a Token Plan field.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerRaccoonRoute(ctx: any, wiring: Pick<Wiring, "settings" | "raccoonStore" | "raccoonSwitch" | "raccoonPublisher" | "raccoonCache" | "webSearchStore" | "raccoonRosterSeen" | "reconcileWebSearch" | "raccoonDesktopSwitch">) {
  const { settings, raccoonStore, raccoonSwitch, raccoonPublisher, raccoonCache, webSearchStore, raccoonRosterSeen, reconcileWebSearch, raccoonDesktopSwitch } = wiring;

  // The Raccoon gateway reads (balance + catalogue) go through the SAME
  // coalescing cache primitive the console route uses, so a scan's fast poll
  // shares one call instead of issuing one per panel refresh. The instance is
  // the wiring's (created in `index.ts`) so a login/logout can clear it in one
  // place; a Host that wired none still gets a private one rather than a crash.
  const raccoonRead = raccoonCache ?? createCoalescedFetch();

  // The publish payload every registration-driving action shares: the live
  // catalogue when a credential exists, else the static fallback, MINUS the
  // panel's curated-away ids (filterRaccoonRows). `switch`, `models` and the
  // settled `login` walk (via `onLoggedIn` below, constructed before the
  // handler) all drive the same publisher with it, so it lives at the ROUTE
  // level — a function declaration so both the handler and the walk hook can
  // reference it regardless of definition order.
  async function collectRaccoonRows(catalogToken?: unknown) {
    let rows = RACCOON_FALLBACK_MODELS;
    let officeIdentity = "";
    try {
      const { credential } = await optional(raccoonStore ? raccoonStore.resolve() : null, { credential: null });
      if (catalogToken !== undefined && catalogToken !== null && catalogToken !== "") {
        // A freshly-scanned token: the read lands in the same cache under its
        // own fingerprint, so the first GET after login reuses it instead of
        // re-fetching what this very call just fetched.
        // Verbatim: the fingerprint must name the SAME value the request below
        // carries. A trimmed key would cache-miss its own fetch on every call —
        // and the token itself is a credential either way (util.ts `verbatim`).
        const live = await optional(raccoonRead.read(`catalog:${tokenFingerprint(verbatim(catalogToken, ""))}`, () => fetchRaccoonCatalog({ access_token: catalogToken }), RACCOON_CATALOG_TTL_MS));
        if (live !== null && live.length > 0) rows = live;
      } else if (credential?.accessToken) {
        const live = await optional(raccoonRead.read(`catalog:${tokenFingerprint(credential.accessToken)}`, () => fetchRaccoonCatalog(credential), RACCOON_CATALOG_TTL_MS));
        if (live !== null && live.length > 0) rows = live;
        officeIdentity = credential.officeIdentity ?? "";
      }
    } catch {
      // Fallback roster is already the safe default.
    }
    const ids = await optional(raccoonSwitch ? raccoonSwitch.enabledIds() : null);
    return { rows: filterRaccoonRows(rows, ids), officeIdentity };
  }

  const raccoonWalkManager = createRaccoonWalk({
    // Two pollers for two code families (2026-11: the gateway issues codes
    // from `/api/iam/v1`, whose envelope is the string-`code` half). The
    // walk picks by `issued.iam`; `issueCode` is what decides that.
    fetcher: (code: string) => pollRaccoonQrLogin(code),
    pollIam: (code: string) => pollRaccoonIamQrLogin(code),
    issueCode: () => issueRaccoonScan(),
    saveCredential: (credential) => (raccoonStore ? raccoonStore.save(credential) : Promise.reject(new Error("no raccoon credential store"))),
    invalidateCache: () => raccoonRead.clear(),
    // No `onSettled`: it exists for callers with per-scan UI state to reset,
    // and this route has none — the outcome flows through the view, which is
    // what the read model reads. Passing a no-op said the same thing with more
    // ceremony.
    // Login-settled side effect, shared by BOTH login channels: when the
    // switch is on, drive the publisher so the just-signed-in account's
    // catalogue reaches DSH's picker right away. Best-effort: a publish miss
    // must not flip the login outcome (the walk swallows the hook's
    // exceptions); the next switch toggle or the mount seed retries. The
    // shared helper is what keeps the walk's hook and the authorize settle
    // from re-deriving the same guard + publish chain — that re-derivation
    // is the same-file clone the duplication gate keeps out of this file.
    onLoggedIn: () => {
      publishForNewLogin();
    }
  });
  /** The shared post-login side effect (see the walk hook's comment). */
  const publishForNewLogin = () => {
    if (raccoonPublisher === null || raccoonPublisher === undefined || raccoonPublisher.isDisposed()) return;
    optional(raccoonSwitch?.enabled()).then((sw: boolean | null) => {
      if (resolveSwitchOff(sw)) {
        collectRaccoonRows(null).then(({ rows, officeIdentity }) => {
          void raccoonPublisher.publish(rows, officeIdentity);
        }).catch(() => {});
      }
    }).catch(() => {});
  };
  const walkView = raccoonWalkManager.view;

  // ── authorize: the browser-authorization loopback (ADR-020) ─────────────
  // The QR confirm page is dead upstream (404 since 11-04); this is the
  // official client's own login chain — the /authorize page in the system
  // browser, the callback on OUR loopback receiver, the code exchange. One
  // receiver per process (single-flight, the walk's idiom): a second
  // `start` re-ports the in-flight one instead of binding a second port.
  // The `authorization_code` rides ONLY here, from the receiver into the
  // exchange — never into a response body (the GET/POST `authorize` view
  // carries the public URL + a status word, nothing credential-shaped).
  let authorizeReceiver: RaccoonAuthorizeReceiver | null = null;
  let authorizeStatus: "idle" | "waiting" | "authorized" | "failed" | "timeout" | "canceled" = "idle";
  let authorizeError = "";
  const authorizeView = () => ({
    status: authorizeStatus,
    // The URL is only useful while waiting: once the receiver settles the
    // port is closed, and an old URL would 404 in the browser with no hint
    // of why — so it is exposed for exactly the `waiting` window.
    ...(authorizeStatus === "waiting" && authorizeReceiver !== null && authorizeReceiver.authorizeUrl !== "" ? { url: authorizeReceiver.authorizeUrl } : {}),
    ...(authorizeError !== "" ? { error: authorizeError } : {})
  });
  /** The fire-and-forget continuation: receive the code, exchange, save, publish. */
  const settleAuthorize = async (receiver: RaccoonAuthorizeReceiver, store: NonNullable<typeof raccoonStore>) => {
    const res = await receiver.result;
    if (authorizeReceiver !== receiver) return; // superseded — never
    authorizeReceiver = null;
    if (!res.ok || res.code === undefined) {
      authorizeStatus = res.reason === "closed" ? "canceled" : res.reason === "timeout" ? "timeout" : "failed";
      if (res.reason !== "closed" && res.reason !== "timeout") authorizeError = "bind";
      return;
    }
    const exchange = await exchangeRaccoonAuthorizationCode(res.code, {});
    if (!exchange.ok || exchange.accessToken === undefined) {
      authorizeStatus = "failed";
      authorizeError = exchange.reason ?? "unknown";
      return;
    }
    try {
      await store.save({
        accessToken: exchange.accessToken,
        refreshToken: exchange.refreshToken ?? "",
        ...(exchange.accessExpiresAtMs !== undefined ? { expiresAtMs: exchange.accessExpiresAtMs } : {}),
        ...(exchange.officeIdentity !== undefined ? { officeIdentity: exchange.officeIdentity } : {}),
        ...(exchange.nickname !== undefined ? { nickname: exchange.nickname } : {})
      });
      // Same reason as the walk's cache invalidation: the new account's
      // numbers must not be served from the previous one's cache window.
      raccoonRead.clear();
    } catch {
      authorizeStatus = "failed";
      authorizeError = "save_failed";
      return;
    }
    authorizeStatus = "authorized";
    authorizeError = "";
    // The SAME post-login side effect as the walk channel (the shared helper
    // keeps the two channels from re-deriving the guard + publish chain).
    publishForNewLogin();
  };

  const offRoute = ctx.webServer.register({
    kind: "exact",
    path: RACCOON_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      // The GET's secret-free state, reused by every POST branch so a mutation
      // always re-reports the same facts a GET would (the `scanUrl`/`code` it
      // carries are the scan the pending login walk last issued). The read model
      // itself is `raccoon-status.ts` — three stores and a cache, not HTTP —
      // which is also what makes it unit-testable without a route.
      //
      // `withDiagnostics` is the one thing a POST never gets: the 401-triage
      // fields ride only on an explicit `?debug=1` GET (see `wantsDiagnostics`),
      // so `answer()` below reports the same state minus the scaffold.
      const raccoonState = async (withDiagnostics = false) => {
        const state = await readRaccoonStatus(
          {
            store: raccoonStore,
            switchStore: raccoonSwitch,
            publisher: raccoonPublisher,
            read: raccoonRead,
            login: walkView,
            // The web_search opt-in is part of the read model, NOT a route
            // overlay: `readRaccoonStatus` owns `resolveSwitchEnabled` so the
            // field cannot drift between declaration and production.
            webSearchStore,
            webSearchConfig: settings.webSearchEnabled,
            // The first-sighting history the pill's "new model" marker reads.
            // Part of the read model, not a route overlay, so the seed / drop /
            // window rules live in ONE place (`raccoon-roster-seen-store.ts`).
            rosterSeenStore: raccoonRosterSeen
          },
          withDiagnostics
        );
        return state;
      };

      const method = request.method === undefined ? "GET" : request.method;
      if (method === "GET") {
        // Only a GET may opt into the triage scaffold (`?debug=1`); the POST
        // branches re-report through `answer()`, which passes no flag.
        writeJson(response, 200, { ...(await raccoonState(wantsDiagnostics(request))), authorize: authorizeView() }, { "cache-control": "no-store" });
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response, MAX_RACCOON_BODY_BYTES);
      if (body === null) return;
      const { action } = body.value;
      const answer = async (extra = {}) => {
        const state = await raccoonState();
        // Every mutation re-reports the authorize view with the state, so the
        // tab never has to distinguish "the GET I didn't make" from "the POST
        // that answered": one shape, one place it comes from.
        writeJson(response, 200, { ...state, authorize: authorizeView(), ...extra }, { "cache-control": "no-store" });
      };
      /**
       * The whole flow BOTH boolean switches share (`switch` and `desktop`):
       * validate the flag, guard an unwired store, save, drive the publisher with
       * the CURRENT roster, then answer with the fresh state — a 400 for a
       * non-boolean, `ok: false` in the body for the refusals the panel words, and
       * no `ok` override on success. It is a closure over `body`/`action`/`answer`
       * rather than two branch bodies that differ only by their store:
       * `duplication-gate.mjs` counts such a pair as one clone, and the reason it
       * is right is §343 — a fix that lands in one branch and not the other is
       * invisible to the reader of either. A missing token is NOT a refusal: it
       * degrades to a clean release inside the publisher (the `not_configured
       * reason`), so neither switch needs a login to exist.
       * @param {any} store - the switch store (`null`/`undefined` = unwired).
       * @param {string} unavailable - the wording when the store is unwired.
       * @returns {Promise<void>} the response is always written on this path.
       */
      const booleanSwitch = async (store: any, unavailable: string) => {
        if (typeof body.value.enabled !== "boolean") {
          writeJson(response, 400, { ok: false, error: `expected { action: "${action}", enabled: boolean }` }, { "cache-control": "no-store" });
          return;
        }
        if (store === null || store === undefined) {
          await answer({ ok: false, error: unavailable });
          return;
        }
        try {
          await store.save(body.value.enabled);
          // Drive the registration with the CURRENT roster: the switch decides
          // whether the models are offered at all.
          if (raccoonPublisher !== null && raccoonPublisher !== undefined) {
            const { rows, officeIdentity } = await collectRaccoonRows(null);
            await raccoonPublisher.publish(rows, officeIdentity);
          }
        } catch (error) {
          await answer({ ok: false, error: redactedError(error) });
          return;
        }
        await answer();
      };

      // The publish payload every registration-driving action shares lives at the
      // ROUTE level (`collectRaccoonRows` above): `switch`, `models` and the
      // settled `login` walk drive the same publisher with it. The walk's
      // `onLoggedIn` hook is registered once at construction, rendering the
      // old per-login-branch override dead.
      if (action === "switch") {
        await booleanSwitch(raccoonSwitch, "the raccoon switch is unavailable");
        return;
      }

      // ── webSearch: save the web-search opt-in and reconcile in-session ──
      // Unlike the provider `switch` above, the store alone is not the whole
      // write: the `ctx.web` registration is read-once at mount, so the save
      // must be followed by a reconcile (drop the taken-over selection, then
      // re-register against the new value). Best-effort on the reconcile — a
      // Host without a `web` service just leaves the switch saved for the next
      // boot, which is the same outcome a save without it would have had.
      if (action === "webSearch") {
        if (typeof body.value.enabled !== "boolean") {
          writeJson(response, 400, { ok: false, error: "expected { action: \"webSearch\", enabled: boolean }" }, { "cache-control": "no-store" });
          return;
        }
        if (webSearchStore === null || webSearchStore === undefined) {
          await answer({ ok: false, error: "the web-search switch is unavailable" });
          return;
        }
        try {
          await webSearchStore.save(body.value.enabled);
          await reconcileWebSearch?.().catch(() => {});
        } catch (error) {
          await answer({ ok: false, error: redactedError(error) });
          return;
        }
        await answer();
        return;
      }

      // ── desktop: the read-only official-App source switch (§6.1.11) ──
      // A flip changes WHICH login the store answers with, so the published
      // descriptors have to be rebuilt exactly as the provider `switch` above
      // rebuilds them: the per-request token follows the store on its own, but a
      // descriptor's headers are fixed at publish time — an `X-Org-Code` taken
      // from the QR credential must not ride on after the App's credential takes
      // over (that literal is a measured 400, §6.1.11). Nothing on this path can
      // log anyone out of anything: the store owns the scanned pair, the App owns
      // its file, and this branch writes neither.
      if (action === "desktop") {
        await booleanSwitch(raccoonDesktopSwitch, "the official-App source is unavailable");
        return;
      }

      // ── models: save the pushed-model curation and rebuild the offer ──
      if (action === "models") {
        const ids = body.value.enabledModelIds;
        if (!Array.isArray(ids) || ids.some((entry: any) => typeof entry !== "string")) {
          writeJson(response, 400, { ok: false, error: "expected { action: \"models\", enabledModelIds: string[] }" }, { "cache-control": "no-store" });
          return;
        }
        if (ids.length > MAX_ENABLED_MODEL_IDS) {
          writeJson(response, 400, { ok: false, error: "too many model ids" }, { "cache-control": "no-store" });
          return;
        }
        if (raccoonSwitch === null || raccoonSwitch === undefined) {
          await answer({ ok: false, error: "the raccoon switch is unavailable" });
          return;
        }
        try {
          await raccoonSwitch.saveIds(ids);
          if (raccoonPublisher !== null && raccoonPublisher !== undefined) {
            const { rows, officeIdentity } = await collectRaccoonRows(null);
            await raccoonPublisher.publish(rows, officeIdentity);
          }
        } catch (error) {
          await answer({ ok: false, error: redactedError(error) });
          return;
        }
        await answer({ ok: true, saved: true });
        return;
      }

      // ── login: delegate to the walk module, drive side-effects here ──
      //
      // `raccoon-walk.ts` owns the scan lifecycle: concurrency gate, gateway
      // polling, settle / timeout / cancel, credential save, cache invalidation,
      // and — through its `onLoggedIn` hook — the publish the route registers
      // once at construction (previously faked by assigning `invalidateCache`
      // onto the walk's returned object, a write nobody read).
      if (action === "login") {
        if (raccoonStore === null || raccoonStore === undefined) {
          await answer({ ok: false, error: "the raccoon credential store is unavailable" });
          return;
        }
        if (walkView.isInFlight()) {
          // A walk is already waiting: hand back ITS scan rather than issuing
          // a second one. Two walks would each own a different code while the
          // GET can only ever report one — a scan that looks permanently stuck.
          const cur = walkView.liveScan();
          if (cur === null) {
            // `isInFlight` is also true while a scan is being ISSUED (the
            // gate covers the network round-trip), and no code exists yet —
            // so a second click is told to wait rather than shown a QR
            // assembled from `null`.
            await answer({ ok: true, status: LOGIN_STATUS.scanning, code: "qr_issuing" });
            return;
          }
          await answer({ ok: true, status: LOGIN_STATUS.scanning, scanUrl: cur.url, scanCode: cur.code });
          return;
        }
        // AWAITED: issuing now costs a network round-trip (server codegen +
        // the confirm-page probe), so the scan exists when this resolves —
        // the old fire-and-forget read `liveScan()` a tick later and papered
        // over the gap with `cur!`. It also means `unavailable` (the
        // confirm page 404s) is reported as an outcome here instead of a
        // 5-minute wait that mislabels it as an expiry.
        await raccoonWalkManager.issueScan();
        // The scan is in flight: report it to the caller so the tab can
        // render the QR. The GET polls for the settled event via takeEvent().
        const cur = walkView.liveScan();
        if (cur === null) {
          // Only the `unavailable` outcome reaches here without a scan: there
          // is no QR to show, so say why instead of rendering an empty frame.
          await answer({ ok: true, status: LOGIN_STATUS.unavailable, code: "qr_unavailable" });
          return;
        }
        await answer({ ok: true, status: LOGIN_STATUS.scanning, scanUrl: cur.url, scanCode: cur.code });
        return;
      }

      // ── authorize: the browser-authorization loopback (ADR-020) ──
      // `step: "start"` binds (or re-ports) the one receiver and answers with
      // its public URL — the OPENING of the system browser is the CLIENT's
      // job (`window.open`), which keeps this route free of host privileges.
      // `step: "cancel"` closes the wait early. The terminal outcomes
      // (authorized / failed / timeout / canceled) surface through the GET's
      // `authorize` view on the tab's next poll; this response reports the
      // START outcome only.
      if (action === "authorize") {
        if (raccoonStore === null || raccoonStore === undefined) {
          await answer({ ok: false, error: "the raccoon credential store is unavailable" });
          return;
        }
        if (body.value.step === "cancel") {
          if (authorizeReceiver !== null) {
            authorizeReceiver.cancel();
            // The continuation settles the status to `canceled`; answer the
            // CURRENT view so the caller sees the in-flight wait it just cut.
            await answer({ ok: true, authorize: authorizeView() });
            return;
          }
          await answer({ ok: true, authorize: authorizeView() });
          return;
        }
        if (authorizeReceiver !== null) {
          // Single-flight: re-port the in-flight receiver (the walk's idiom —
          // a second click never binds a second port).
          await answer({ ok: true, authorize: authorizeView() });
          return;
        }
        let receiver: RaccoonAuthorizeReceiver;
        try {
          receiver = await startRaccoonAuthorizeReceiver({ port: 0, timeoutMs: RACCOON_AUTHORIZE_TIMEOUT_MS });
        } catch (error) {
          await answer({ ok: false, error: redactedError(error) });
          return;
        }
        authorizeReceiver = receiver;
        authorizeStatus = "waiting";
        authorizeError = "";
        // The receiver outlives this request, exactly as the walk does:
        // up to a five-minute wait, ending in a credential save. If the
        // bind itself refused, the result is already settled `failed` and
        // the continuation settles the view at once — report that instead
        // of a `waiting` the page would then open into a dead port.
        const settledAtOnce = receiver.authorizeUrl === "";
        void settleAuthorize(receiver, raccoonStore);
        await answer(settledAtOnce
          ? { ok: false, error: "the loopback receiver did not bind", authorize: authorizeView() }
          : { ok: true, authorize: authorizeView() });
        return;
      }

      // ── logout: forget the stored credential and release the provider ──
      if (action === "logout") {
        if (raccoonStore === null || raccoonStore === undefined) {
          await answer({ ok: false, error: "the raccoon credential store is unavailable" });
          return;
        }
        try {
          await raccoonStore.forget();
          // The credential is gone, so every cached balance/catalogue read
          // taken under it is now somebody else's number: a re-login must not
          // be served the previous account's balance for up to five minutes.
          raccoonRead.clear();
          if (raccoonPublisher !== null && raccoonPublisher !== undefined) {
            // Through the same curation filter as every other publish path
            // here. The credential is already gone, so the publisher lands on
            // its `not_configured` unregister branch — but publishing the raw
            // fallback roster made this the ONE offer that ignored the panel's
            // allow-list, which is a trap the moment logout ever means "keep
            // the credential, drop the provider" instead.
            const { rows, officeIdentity } = await collectRaccoonRows(null);
            await raccoonPublisher.publish(rows, officeIdentity);
          }
        } catch (error) {
          await answer({ ok: false, error: redactedError(error) });
          return;
        }
        await answer({ ok: true, status: "logged_out" });
        return;
      }

      writeJson(response, 400, { ok: false, error: "expected { action: \"switch\"|\"webSearch\"|\"desktop\"|\"models\"|\"login\"|\"authorize\"|\"logout\" }" }, { "cache-control": "no-store" });
    }, settings.allowedHosts)
  });

  // Unregistering the route ends the walk with it. The walk is the one side
  // effect here that outlives the request that started it: up to
  // `RACCOON_LOGIN_TIMEOUT_MS` of gateway polling, ending in a write to the
  // credentials service. Without this, unloading the plugin mid-scan left it
  // knocking on the gateway and could still persist a credential pair into a
  // service the plugin no longer owns. Idempotent, and a no-op when no scan is
  // running — which is every teardown but the one that races a live walk.
  return () => {
    raccoonWalkManager.stop();
    // The receiver is the second side effect that outlives its request: a
    // live loopback port on 127.0.0.1 that nobody is supposed to reach after
    // the plugin is gone. `cancel` settles the wait as `closed` and closes
    // the port; a no-op when nothing is in flight.
    authorizeReceiver?.cancel();
    offRoute();
  };
}

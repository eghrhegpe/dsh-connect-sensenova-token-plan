/**
 * The Raccoon route (ROADMAP §6.1 "second upstream provider"): one GET
 * reporting the secret-free state a tab renders, one POST carrying `{ action }`
 * for the four panel actions. The QR login is a single server-side walk (no
 * client long-poll); the credential never touches this plugin's directory,
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
import { optional, errMsg, str } from "../util.ts";
import { writeJson, refuseMethod, readJsonBodyOr400, withOrigin, wantsDiagnostics, MAX_ENABLED_MODEL_IDS, MAX_RACCOON_BODY_BYTES } from "./http.ts";
import type { Wiring } from "../types.ts";
import {
  pollRaccoonQrLogin,
  fetchRaccoonCatalog,
  RACCOON_FALLBACK_MODELS
} from "../raccoon.ts";
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

/** The Raccoon provider route (ROADMAP §6.1 "second upstream provider"). */
export const RACCOON_PATH = `/api/${name}/raccoon`;

// The QR walk's two timing constants (`RACCOON_LOGIN_TIMEOUT_MS`,
// `RACCOON_QR_POLL_INTERVAL_MS`) are gateway wire facts owned by `raccoon.ts`;
// `raccoon-walk.ts` is the only importer, so they must never be re-declared
// here (ROADMAP §6.1.4; single-source check in `test/raccoon.test.mjs`).

/**
 * Register the Raccoon route. Wiring subset: `settings`, `raccoonStore`,
 * `raccoonSwitch`, `raccoonPublisher`, `raccoonCache`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {Pick<Wiring, "settings" | "raccoonStore" | "raccoonSwitch" | "raccoonPublisher" | "raccoonCache">} wiring
 *   - the Raccoon half's subset, as assembled by `apply()` in `index.ts`. The
 *   `Pick` is what makes "changing the Raccoon line must not affect the Token
 *   Plan one" (ARCHITECTURE §5.5) a compile-time fact rather than a review
 *   promise: this route physically cannot reach a Token Plan field.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerRaccoonRoute(ctx: any, wiring: Pick<Wiring, "settings" | "raccoonStore" | "raccoonSwitch" | "raccoonPublisher" | "raccoonCache">) {
  const { settings, raccoonStore, raccoonSwitch, raccoonPublisher, raccoonCache } = wiring;

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
        const live = await optional(raccoonRead.read(`catalog:${tokenFingerprint(str(catalogToken, ""))}`, () => fetchRaccoonCatalog({ access_token: catalogToken }), RACCOON_CATALOG_TTL_MS));
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
    fetcher: (code: string) => pollRaccoonQrLogin(code),
    saveCredential: (credential) => (raccoonStore ? raccoonStore.save(credential) : Promise.reject(new Error("no raccoon credential store"))),
    invalidateCache: () => raccoonRead.clear(),
    // No `onSettled`: it exists for callers with per-scan UI state to reset,
    // and this route has none — the outcome flows through the view, which is
    // what the read model reads. Passing a no-op said the same thing with more
    // ceremony.
    // Login-settled side effect: when the switch is on, drive the publisher
    // so the just-signed-in account's catalogue reaches DSH's picker right
    // away. Best-effort: a publish miss must not flip the login outcome (the
    // walk swallows the hook's exceptions); the next switch toggle or the
    // mount seed retries.
    onLoggedIn: () => {
      if (raccoonPublisher === null || raccoonPublisher === undefined || raccoonPublisher.isDisposed()) return;
      optional(raccoonSwitch?.enabled()).then((sw: boolean | null) => {
        if (sw === true) {
          collectRaccoonRows(null).then(({ rows, officeIdentity }) => {
            void raccoonPublisher.publish(rows, officeIdentity);
          }).catch(() => {});
        }
      }).catch(() => {});
    }
  });
  const walkView = raccoonWalkManager.view;

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
      const raccoonState = (withDiagnostics = false) =>
        readRaccoonStatus(
          {
            store: raccoonStore,
            switchStore: raccoonSwitch,
            publisher: raccoonPublisher,
            read: raccoonRead,
            login: walkView
          },
          withDiagnostics
        );

      const method = request.method === undefined ? "GET" : request.method;
      if (method === "GET") {
        // Only a GET may opt into the triage scaffold (`?debug=1`); the POST
        // branches re-report through `answer()`, which passes no flag.
        writeJson(response, 200, await raccoonState(wantsDiagnostics(request)), { "cache-control": "no-store" });
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
        writeJson(response, 200, { ...state, ...extra }, { "cache-control": "no-store" });
      };
      // The publish payload every registration-driving action shares lives at the
      // ROUTE level (`collectRaccoonRows` above): `switch`, `models` and the
      // settled `login` walk drive the same publisher with it. The walk's
      // `onLoggedIn` hook is registered once at construction, rendering the
      // old per-login-branch override dead.
      if (action === "switch") {
        if (typeof body.value.enabled !== "boolean") {
          writeJson(response, 400, { ok: false, error: "expected { action: \"switch\", enabled: boolean }" }, { "cache-control": "no-store" });
          return;
        }
        if (raccoonSwitch === null || raccoonSwitch === undefined) {
          await answer({ ok: false, error: "the raccoon switch is unavailable" });
          return;
        }
        try {
          await raccoonSwitch.save(body.value.enabled);
          // Drive the registration with the CURRENT roster: the switch decides
          // whether the models are offered at all. A missing token degrades to
          // a clean release inside the publisher (the `not_configured` reason).
          if (raccoonPublisher !== null && raccoonPublisher !== undefined) {
            const { rows, officeIdentity } = await collectRaccoonRows(null);
            await raccoonPublisher.publish(rows, officeIdentity);
          }
        } catch (error) {
          await answer({ ok: false, error: errMsg(error) });
          return;
        }
        await answer();
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
          await answer({ ok: false, error: errMsg(error) });
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
          await answer({ ok: true, status: LOGIN_STATUS.scanning, scanUrl: cur!.url, scanCode: cur!.code });
          return;
        }
        void raccoonWalkManager.issueScan();
        // The scan is now in flight: report it to the caller so the tab can
        // render the QR. The GET will poll for the settled event via takeEvent().
        const cur = walkView.liveScan();
        await answer({ ok: true, status: LOGIN_STATUS.scanning, scanUrl: cur!.url, scanCode: cur!.code });
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
          await answer({ ok: false, error: errMsg(error) });
          return;
        }
        await answer({ ok: true, status: "logged_out" });
        return;
      }

      writeJson(response, 400, { ok: false, error: "expected { action: \"switch\"|\"models\"|\"login\"|\"logout\" }" }, { "cache-control": "no-store" });
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
    offRoute();
  };
}

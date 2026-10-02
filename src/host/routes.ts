/**
 * The HTTP route handlers.
 *
 * `apply()` (in `index.ts`) stays the single mount seam: it assembles a
 * `wiring` object and hands it to {@link registerRoutes}; each route is its
 * own named function (one per resource) that closes over the wiring, so a
 * route never imports a service directly. Nothing here imports a Host peer —
 * the only lazy peer loads (the adapter / tools modules) live in
 * `lifecycle.ts` and are injected from `apply` via `deps`.
 *
 * @module dsh-connect-sensenova-token-plan/routes
 */
import { isAdmitted, name } from "./host-config.ts";
import { createCoalescedFetch } from "./coalesced-fetch.ts";
import { buildSnapshotBody, failureCode } from "./snapshot-aggregate.ts";
import { CODE } from "./codes.ts";
import { writeLoginTrace } from "./trace.ts";
import { str, optional, errMsg } from "./util.ts";
import type { PluginError, Wiring } from "./types.ts";
import { normalizeEnabledIds } from "./catalog-store.ts";
import { syncSignaturesAfterPublish } from "./provider-publish.ts";
import {
  pollRaccoonQrLogin,
  fetchRaccoonCatalog,
  RACCOON_FALLBACK_MODELS
} from "./raccoon.ts";
// The tab's read model lives in its own peer-free module (it is not HTTP), so
// this handler owns only the walk and the four mutations. The catalogue cache
// window comes with it: `collectRaccoonRows` reads through the same cache.
import {
  readRaccoonStatus,
  tokenFingerprint,
  RACCOON_CATALOG_TTL_MS
} from "./raccoon-status.ts";
import { filterRaccoonRows } from "./raccoon-models.ts";
import { createRaccoonWalk, LOGIN_STATUS } from "./raccoon-walk.ts";

/** The one read-only route the Client panel polls. */
const SNAPSHOT_PATH = `/api/${name}/snapshot`;
/** The account route: the panel configures itself without editing `.env`. */
const ACCOUNT_PATH = `/api/${name}/account`;
/** The inference API-key route (`sk-…`), step three of the one-stop plan. */
const API_KEY_PATH = `/api/${name}/api-key`;
/** The provider-registration switch route (docs/PROVIDER-HOT-RELOAD.md). */
const PROVIDER_PATH = `/api/${name}/provider`;
/** The model-roster route (docs/API.md). */
const MODELS_PATH = `/api/${name}/models`;
/** The draw-tool switch route (docs/PROVIDER-HOT-RELOAD.md, same discipline). */
const DRAW_PATH = `/api/${name}/draw`;
/** The Raccoon provider route (ROADMAP §6.1 "second upstream provider"). */
const RACCOON_PATH = `/api/${name}/raccoon`;
/** Ceiling on a Raccoon action body: the login POST only needs the scan code. */
const MAX_RACCOON_BODY_BYTES = 2048;
// The QR walk's two timing constants (`RACCOON_LOGIN_TIMEOUT_MS`,
// `RACCOON_QR_POLL_INTERVAL_MS`) are gateway wire facts owned by `raccoon.ts`;
// `raccoon-walk.ts` is the only importer, so they must never be re-declared
// here (ROADMAP §6.1.4; single-source check in `test/raccoon.test.mjs`).
/** Ceiling on a submitted account, so a hostile page cannot stream a body. */
const MAX_ACCOUNT_BODY_BYTES = 4096;
/** Ceiling on the curated allow-list: a catalogue this large is a posting accident. */
const MAX_ENABLED_MODEL_IDS = 500;
/** Family default response headers for a JSON route. */
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer"
};

/** Write one JSON response with the family headers. */
function writeJson(res: any, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(payload);
}

/**
 * Read a small JSON request body, refusing anything oversized.
 *
 * The account form is the only thing that posts here, so the ceiling is tiny
 * and the reader is deliberately dull: no content-type negotiation, no
 * streaming, just a bounded collect and a parse.
 * @param request - the incoming HTTP request.
 * @param limit - the byte ceiling.
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: string}>}
 */
async function readJsonBody(request: any, limit = MAX_ACCOUNT_BODY_BYTES) {
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buffer.byteLength;
      if (received > limit) return { ok: false, error: "request body is too large" };
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, error: "could not read the request body" };
  }
  if (chunks.length === 0) return { ok: false, error: "a JSON body is required" };
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "the body must be a JSON object" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: "the body is not valid JSON" };
  }
}

/**
 * Refuse a request the trust fence rejects, with the one body the panel reads.
 *
 * Every route opens with the identical line, so the wording and the 403 shape
 * live in one place: a route that forgets the fence, or words it differently,
 * is now the odd one out rather than a second truth.
 * @param response - the outgoing HTTP response.
 * @returns {void}
 */
function refuseOrigin(response: any) {
  writeJson(response, 403, { ok: false, error: "forbidden: origin mismatch" });
}

/**
 * Refuse a disallowed method with the family's 405 shape. A method refusal is
 * not a fresh answer, so it carries no `cache-control` (unlike a snapshot).
 * @param response - the outgoing HTTP response.
 * @returns {void}
 */
function refuseMethod(response: any) {
  writeJson(response, 405, { ok: false, error: "method not allowed" });
}

/**
 * Whether a request opted into the Raccoon 401-triage diagnostics (`?debug=1`).
 *
 * A retired scaffold: the 401 root-cause fix (Bearer dual-shape + pre-read
 * renewal gate + `/refresh`) has landed and no client renders the triage
 * fields, so an ordinary poll must not carry them. A query flag keeps the
 * capability without a config field (a patch change needs a restart) and
 * without widening every response.
 *
 * Only `1` / `true` opt in: `?debug=0` must stay quiet, and a malformed URL is
 * treated as "no".
 * @param {object} request - the incoming HTTP request.
 * @returns {boolean} whether the diagnostics were requested.
 */
function wantsDiagnostics(request: any) {
  const url = str(request?.url, "");
  if (url === "") return false;
  try {
    const flag = new URL(url, "http://localhost").searchParams.get("debug");
    return flag === "1" || flag === "true";
  } catch {
    return false;
  }
}

/**
 * Read and validate a JSON body, or answer 400 and signal the caller to stop.
 *
 * Collapses the read-then-400 block every POST route repeats. Returns the
 * `readJsonBody` result on success (callers keep reading `body.value`), or
 * `null` after the 400 was written — a `null` is the caller's cue to return.
 * @param request - the incoming HTTP request.
 * @param response - the outgoing HTTP response (written on failure).
 * @returns {Promise<object|null>} the read result, or null if a 400 was sent.
 */
async function readJsonBodyOr400(request: any, response: any, limit = MAX_ACCOUNT_BODY_BYTES) {
  const body = await readJsonBody(request, limit);
  if (!body.ok) {
    writeJson(response, 400, { ok: false, error: /** @type {{ok: false, error: string}} */ (body).error }, { "cache-control": "no-store" });
    return null;
  }
  return body;
}

/**
 * Wrap a route handler with the trust fence every route opens with.
 *
 * The seven handlers each repeated the identical `isAdmitted` block; this folds
 * it into one seam so a forgotten fence is impossible and the 403 wording
 * stays in {@link refuseOrigin}. A handler wrapped here must NOT repeat the
 * fence — doing so is only a second, dead guard.
 * @param handler - the route logic.
 * @param allowedHosts - the settings' allowed-hosts list the fence checks against.
 * @returns the fenced handler.
 */
function withOrigin(handler: (request: any, response: any) => Promise<void>, allowedHosts: unknown) {
  return async (request: any, response: any) => {
    if (!isAdmitted(request, allowedHosts)) {
      refuseOrigin(response);
      return;
    }
    return handler(request, response);
  };
}

/**
 * Register the six Token Plan routes plus the Raccoon route on the Host's web
 * server. Each route is its own named function; this assembler only decides
 * what they may touch (the wiring) and hands back the unregister callbacks,
 * in registration order — `teardown` runs them last.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {Wiring} wiring - assembled by `apply()` in `index.ts`.
 * @returns {Function[]} the seven `off()` unregister callbacks, in registration order.
 */
export function registerRoutes(ctx: any, wiring: Wiring) {
  return [
    snapshotRoute(ctx, wiring),
    accountRoute(ctx, wiring),
    apiKeyRoute(ctx, wiring),
    providerRoute(ctx, wiring),
    modelsRoute(ctx, wiring),
    drawRoute(ctx, wiring),
    raccoonRoute(ctx, wiring)
  ];
}

/** The read-only snapshot route: the one the Client panel polls. */
function snapshotRoute(ctx: any, wiring: Wiring) {
  const { settings, configError, cache, inflight, tokenStore, publisher, catalogStore, providerStore, drawStore, visionPublish, logger } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: SNAPSHOT_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      if (request.method !== undefined && request.method !== "GET" && request.method !== "HEAD") {
        refuseMethod(response);
        return;
      }
      if (configError !== null) {
        // The panel maps this code to its own line, so the operator sees the
        // misconfiguration instead of a generic network failure.
        writeJson(response, 200, {
          ok: false,
          code: CODE.CONFIG_ERROR,
          error: configError,
          auth: await optional(tokenStore.state())
        }, { "cache-control": "no-store" });
        return;
      }
      try {
        // Step two (vision, ARCHITECTURE.md §5.1): publish the computed list to
        // this row's own settings namespace so a later LLM connect plugin can
        // read it. The aggregate needs to know the vision list before it builds
        // the body (it carries `visionModels`), so the caller computes it up
        // front and hands it in.
        const body = await buildSnapshotBody({
          settings,
          cache,
          inflight,
          tokenStore,
          apiKeyStore: wiring.apiKeyStore,
          publisher,
          catalogStore,
          panelSwitch: () => optional(providerStore.enabled()),
          drawSwitch: () => optional(drawStore ? drawStore.enabled() : null),
          drawModelId: () => optional(drawStore ? drawStore.modelId() : null)
        });
        if (body.visionModels !== undefined) {
          // A write failure here is silent otherwise: the vision list fails to
          // persist to this row's settings, so the later image-routing plugin
          // reads a stale or empty set with no trace to explain why. Log it; the
          // in-memory body the panel already got is unaffected.
          void visionPublish.current?.(body.visionModels, body.visionModels.map((entry: any) => entry.id))
            .catch((error) => logger?.warn?.(`${name}: vision model list write failed`, error));
        }
        writeJson(response, 200, body, { "cache-control": "no-store" });
      } catch (error) {
        // Distinguish "we cannot get a token" from "the console call failed":
        // the first is fixed by logging in, the second is usually transient.
        writeJson(response, 200, {
          ok: false,
          error: errMsg(error),
          code: failureCode(error),
          auth: await optional(tokenStore.state())
        }, { "cache-control": "no-store" });
      }
    }, settings.allowedHosts)
  });
}

/** The account route: sign in / forget, without editing `.env`. */
function accountRoute(ctx: any, wiring: Wiring) {
  const { settings, tokenStore, cache } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: ACCOUNT_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      // The same fence as the snapshot route: without it, any page the
      // browser visits could post an account into this panel.
      const method = request.method === undefined ? "POST" : request.method;
      if (method === "GET") {
        // The form needs to know whether an account is already stored, and
        // must never be told the password.
        writeJson(response, 200, { ok: true, ...(await tokenStore.state()) }, { "cache-control": "no-store" });
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // `forget: true` clears the account without logging in again; the grant
      // survives on its refresh token until it needs the password again.
      if (body.value.forget === true) {
        try {
          await tokenStore.forgetAccount();
        } catch (error) {
          // The state is spread FIRST: it carries its own `error` field, and
          // spreading it after this one would overwrite the real reason with
          // whatever the store last saw.
          writeJson(response, 200, {
            ...(await optional(tokenStore.state())),
            ok: false,
            error: errMsg(error)
          }, { "cache-control": "no-store" });
          return;
        }
        // The grant that just cleared answers the very next poll, so the cached
        // console responses from the previous account must not survive it.
        // (saveAccount does the same on its success path.)
        cache.clear();
        writeJson(response, 200, { ...(await tokenStore.state()), ok: true }, { "cache-control": "no-store" });
        return;
      }
      try {
        await tokenStore.saveAccount({ username: body.value.username, password: body.value.password });
        // The success trace is persisted through `onTrace`; no path is owed
        // to the panel for a sign-in that worked.
      } catch (e) {
        // A rejected password is the common case, and it is the user's to
        // correct: report the reason and leave the panel usable. The extra
        // fields are the shape `pluginError` attaches (types.PluginError) —
        // a non-pluginError throw simply has none of them, which every read
        // below already handles with its own fallback.
        const error = e as Partial<PluginError>;
        const traceFile = await writeLoginTrace(error?.trace, str(error?.code, CODE.AUTH_ERROR));
        writeJson(response, 200, {
          ...(await optional(tokenStore.state())),
          ok: false,
          code: str(error?.code, CODE.AUTH_ERROR),
          error: errMsg(error),
          // The platform's own words ride along so the panel can show them
          // beneath the classified line.
          ...(error?.detail === undefined ? {} : { detail: String(error.detail) }),
          // The sanitized hop-by-hop record of this attempt: the panel links
          // to it, and a support question becomes answerable.
          ...(traceFile !== null ? { traceFile } : {}),
          // When the platform names a wait, the panel greys the form out for
          // that long: retrying inside the window is what extends a lockout.
          ...(typeof error?.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {})
        }, { "cache-control": "no-store" });
        return;
      }
      // The grant that just landed answers the very next poll, so the cached
      // console responses from the previous account must not survive it.
      cache.clear();
      writeJson(response, 200, { ...(await tokenStore.state()), ok: true }, { "cache-control": "no-store" });
    }, settings.allowedHosts)
  });
}

/** The inference API-key route (`sk-…`), step three of the one-stop plan. */
function apiKeyRoute(ctx: any, wiring: Wiring) {
  const { settings, apiKeyStore, catalogStore, providerState, publishProvider, cache, logger } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: API_KEY_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      // Same trust fence as the other two routes: a foreign page must not be
      // able to plant or wipe an inference key.
      const method = request.method === undefined ? "GET" : request.method;
      // The secret-free state is all the form ever gets: present or not, and
      // whether it came from the credentials service or the environment.
      const answer = async (extra = {}) =>
        writeJson(
          response,
          200,
          { ok: true, ...(await optional(apiKeyStore.state(), { hasApiKey: false, keySource: null, ephemeral: false })), ...extra },
          { "cache-control": "no-store" }
        );
      if (method === "GET") {
        await answer();
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // Forget: drop the panel-saved REFERENCE only. An environment value is
      // deliberately left standing (forget cannot delete an operator's .env),
      // and the cached catalog answers the old key until the poll after.
      if (body.value.forget === true) {
        try {
          await apiKeyStore.forget();
          // The key itself is already gone; a leftover cached catalog would only
          // surface stale models on the next poll. If the clear fails we still
          // answer success, but record it — silently losing it would make a
          // "forgot the key but old models still offered" report undebuggable.
          await catalogStore.clear()
            .catch((error) => logger?.warn?.(`${name}: catalog cache clear failed after api-key forget`, error));
          cache.clear();
          await publishProvider([], [], []);
          // The signatures must not keep claiming a stale offer after the teardown:
          // re-sync them to what was just published, or the next poll re-publishes
          // (churns) an already-empty offer.
          syncSignaturesAfterPublish(providerState);
          await answer();
        } catch (error) {
          await answer({ ok: false, error: errMsg(error) });
        }
        return;
      }
      try {
        await apiKeyStore.save(body.value.apiKey);
      } catch (error) {
        await answer({ ok: false, error: errMsg(error) });
        return;
      }
      // The next poll fetches the catalog with the new key; a stale catalog
      // cached under a previous key must not survive it. The key itself is
      // resolved per REQUEST by the adapter, so no provider rebuild is needed.
      cache.clear();
      await answer();
    }, settings.allowedHosts)
  });
}

/** The provider-registration switch route. */
function providerRoute(ctx: any, wiring: Wiring) {
  const { settings, providerStore, providerState, publishProvider } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: PROVIDER_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      // Same trust fence as the other three routes: a foreign page must not be
      // able to flip model routing for the whole Host.
      const method = request.method === undefined ? "GET" : request.method;
      // Secret-free by construction: the effective switch, where it came from,
      // and whether a provider is registered right now.
      const answer = async (extra = {}) => {
        const panelSwitch = await optional(providerStore.enabled());
        writeJson(
          response,
          200,
          {
            ok: true,
            registerProvider: (panelSwitch ?? settings.registerProvider) === true,
            registerSource: panelSwitch === null ? "config" : "panel",
            providerRegistered: providerState.registered,
            ...(providerState.error !== null ? { providerError: providerState.error } : {}),
            ...extra
          },
          { "cache-control": "no-store" }
        );
      };
      if (method === "GET") {
        await answer();
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      if (typeof body.value.enabled !== "boolean") {
        writeJson(response, 400, { ok: false, error: "expected { enabled: boolean }" }, { "cache-control": "no-store" });
        return;
      }
      try {
        await providerStore.save(body.value.enabled);
        // Publish immediately with the CURRENT catalog: the switch decides
        // whether the models are offered at all, not what they are. A failed
        // publish rolls back to the previous pair inside publishProvider and
        // surfaces its reason in providerState.error.
        await publishProvider(providerState.entries, providerState.enabledIds, providerState.unavailableIds ?? []);
      } catch (error) {
        await answer({ ok: false, error: errMsg(error) });
        return;
      }
      await answer();
    }, settings.allowedHosts)
  });
}

/** The model-roster curation route. */
function modelsRoute(ctx: any, wiring: Wiring) {
  const { settings, catalogStore, providerStore, providerState, publishProvider } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: MODELS_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      // Same fence as the other routes: a foreign page must not be able to
      // decide which models this Host offers.
      const method = request.method === undefined ? "POST" : request.method;
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // An absent field is refused rather than read as "all models": writing
      // that would silently widen the offer to every model in the catalogue.
      if (!Array.isArray(body.value.enabledModelIds)) {
        writeJson(response, 400, { ok: false, error: "expected { enabledModelIds: string[] }" },
          { "cache-control": "no-store" });
        return;
      }
      const ids = normalizeEnabledIds(body.value.enabledModelIds);
      if (ids.length > MAX_ENABLED_MODEL_IDS) {
        writeJson(response, 400,
          { ok: false, error: `enabledModelIds is too long (max ${MAX_ENABLED_MODEL_IDS})` },
          { "cache-control": "no-store" });
        return;
      }
      const answer = async (extra = {}) => {
        writeJson(response, 200, {
          ok: true,
          enabledModelIds: await optional(catalogStore.listEnabledIds(), providerState.enabledIds),
          registerProvider:
            ((await optional(providerStore.enabled())) ?? settings.registerProvider) === true,
          providerRegistered: providerState.registered,
          ...(providerState.error !== null ? { providerError: providerState.error } : {}),
          ...extra
        }, { "cache-control": "no-store" });
      };
      try {
        await catalogStore.setEnabledIds(ids);
        // Publish immediately with the CURRENT catalogue: the offer must not
        // wait for the next poll. A failed publish rolls back to the previous
        // pair inside publishProvider and surfaces its reason.
        await publishProvider(providerState.entries, ids, providerState.unavailableIds ?? []);
        // Adopt the signature of what was just offered so the next poll does not
        // see a "change" and re-publish the same set.
        syncSignaturesAfterPublish(providerState);
      } catch (error) {
        await answer({ ok: false, error: errMsg(error) });
        return;
      }
      await answer();
    }, settings.allowedHosts)
  });
}

/** The draw-tool switch route. */
function drawRoute(ctx: any, wiring: Wiring) {
  const { settings, drawStore } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: DRAW_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      // Same trust fence as the other routes: a foreign page must not be able
      // to turn an agent image tool on or off.
      const method = request.method === undefined ? "GET" : request.method;
      const answer = async (extra = {}) => {
        const panelDraw = await optional(drawStore ? drawStore.enabled() : null);
        const panelModel = await optional(drawStore ? drawStore.modelId() : null);
        // The effective value: a saved panel value always wins, otherwise the
        // config default. The source tells the panel which side is in charge.
        const effectiveDraw = panelDraw ?? settings.drawEnabled;
        const effectiveModel = panelModel ?? settings.drawModelId;
        writeJson(
          response,
          200,
          {
            ok: true,
            drawEnabled: effectiveDraw === true,
            drawSource: panelDraw === null ? "config" : "panel",
            drawModelId: effectiveModel,
            drawModelSource: panelModel === null ? "config" : "panel",
            ...extra
          },
          { "cache-control": "no-store" }
        );
      };
      if (method === "GET") {
        await answer();
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // Three purposes, distinguished by the body — the same shape the
      // account and api-key routes use: a saved boolean, a saved model
      // preference (`null` = auto), or a forget that returns the saved
      // values to the config default.
      if (body.value.forget === true) {
        if (!drawStore) {
          await answer({ ok: false, error: "draw store is unavailable" });
          return;
        }
        try {
          await drawStore.forget();
        } catch (error) {
          await answer({ ok: false, error: errMsg(error) });
          return;
        }
        await answer();
        return;
      }
      if (body.value.drawModelId !== undefined) {
        const raw = body.value.drawModelId;
        if (raw !== null && (typeof raw !== "string" || raw.trim() === "")) {
          writeJson(response, 400, { ok: false, error: "drawModelId expects a non-empty string or null" }, { "cache-control": "no-store" });
          return;
        }
        if (!drawStore) {
          await answer({ ok: false, error: "draw store is unavailable" });
          return;
        }
        try {
          await drawStore.saveModel(raw);
        } catch (error) {
          await answer({ ok: false, error: errMsg(error) });
          return;
        }
        await answer();
        return;
      }
      if (typeof body.value.enabled !== "boolean") {
        writeJson(response, 400, { ok: false, error: "expected { enabled: boolean }, { drawModelId }, or { forget: true }" }, { "cache-control": "no-store" });
        return;
      }
      if (!drawStore) {
        await answer({ ok: false, error: "draw store is unavailable" });
        return;
      }
      try {
        await drawStore.save(body.value.enabled);
      } catch (error) {
        await answer({ ok: false, error: errMsg(error) });
        return;
      }
      await answer();
    }, settings.allowedHosts)
  });
}

// The Raccoon route (ROADMAP §6.1 "second upstream provider"): one GET
// reporting the secret-free state a tab renders, one POST carrying `{ action }`
// for the four panel actions. The QR login is a single server-side walk (no
// client long-poll); the credential never touches this plugin's directory,
// git, or logs — it goes straight to the DSH credentials service through
// `raccoonStore`.
//
// The walk lifecycle is owned by `raccoon-walk.ts`: one instance for the
// entire route, so a second click / tab mid-walk sees the SAME scan
// (concurrency gate via `view.isInFlight()`). The route only drives the
// side-effects and reads the transient state through `view`; one scan per
// process, cleared on settle, no handler-local state survives a re-mount.
function raccoonRoute(ctx: any, wiring: Wiring) {
  const { settings, raccoonStore, raccoonSwitch, raccoonPublisher, raccoonCache } = wiring;

  // The Raccoon gateway reads (balance + catalogue) go through the SAME
  // coalescing cache primitive the console route uses, so a scan's fast poll
  // shares one call instead of issuing one per panel refresh. The instance is
  // the wiring's (created in `index.ts`) so a login/logout can clear it in one
  // place; a Host that wired none still gets a private one rather than a crash.
  const raccoonRead = raccoonCache ?? createCoalescedFetch();

  const raccoonWalkManager = createRaccoonWalk({
    fetcher: (code: string) => pollRaccoonQrLogin(code),
    saveCredential: (credential) => raccoonStore.save(credential),
    invalidateCache: () => raccoonRead.clear(),
    onSettled: () => { /* no-op — status flows through the view */ }
  });
  const walkView = raccoonWalkManager.view;

  return ctx.webServer.register({
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
      // The publish payload every registration-driving action shares: the live
      // catalogue when a credential exists, else the static fallback, MINUS
      // the panel's curated-away ids (filterRaccoonRows). `switch`, `models`
      // and the settled `login` walk all drive the same publisher with it.
      const collectRaccoonRows = async (catalogToken?: unknown) => {
        let rows = RACCOON_FALLBACK_MODELS;
        let officeIdentity = "";
        try {
          const { credential } = await optional(raccoonStore ? raccoonStore.resolve() : null, { credential: null });
          if (catalogToken !== undefined && catalogToken !== null && catalogToken !== "") {
            // A freshly-scanned token: the read lands in the same cache under
            // its own fingerprint, so the first GET after login reuses it
            // instead of re-fetching what this very call just fetched.
            const live = await optional(raccoonRead.read(`catalog:${tokenFingerprint(catalogToken)}`, () => fetchRaccoonCatalog({ access_token: catalogToken }), RACCOON_CATALOG_TTL_MS));
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
      };

      // ── switch: register / deregister the Raccoon provider with DSH ──
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
      // polling, settle / timeout / cancel, credential save, cache invalidation.
      // This branch drives the publisher because provider registration touches
      // external state (the switch file + the DSH adapter registry).
      if (action === "login") {
        if (raccoonStore === null || raccoonStore === undefined) {
          await answer({ ok: false, error: "the raccoon credential store is unavailable" });
          return;
        }
        // Replace walk's default save/invalidate with one that also publishes
        // when the switch is on (so a logged-in user sees models immediately).
        (raccoonWalkManager as any).invalidateCache = () => {
          raccoonRead.clear();
          if (raccoonPublisher !== null && raccoonPublisher !== undefined && !raccoonPublisher.isDisposed()) {
            optional(raccoonSwitch?.enabled()).then((sw: boolean | null) => {
              if (sw === true) {
                collectRaccoonRows(null).then(({ rows, officeIdentity }) => {
                  void raccoonPublisher.publish(rows, officeIdentity);
                }).catch(() => {});
              }
            }).catch(() => {});
          }
        };
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
            await raccoonPublisher.publish(RACCOON_FALLBACK_MODELS, "");
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
}

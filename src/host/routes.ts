/**
 * The HTTP route handlers.
 *
 * `apply()` stays the single mount seam: it assembles a `wiring` object and
 * hands it to {@link registerRoutes}; the handlers keep exactly the behaviour
 * they had inline (the trust fence, the method allowances, the body ceilings,
 * the trace writes, the publish-after-save calls). Nothing here imports a Host
 * peer — the only lazy peer loads (the adapter / tools modules) live in
 * `lifecycle.ts` and are injected from `apply` via `deps`.
 *
 * @module dsh-connect-sensenova-token-plan/routes
 */
import { isAdmitted, name } from "./host-config.ts";
import { createCoalescedFetch } from "./coalesced-fetch.ts";
import { buildSnapshotBody, failureCode } from "./snapshot-aggregate.ts";
import { CODE } from "./codes.ts";
import { writeLoginTrace } from "./trace.ts";
import { str, redactSecrets, optional } from "./util.ts";
import type { PluginError } from "./types.ts";
import { normalizeEnabledIds } from "./catalog-store.ts";
import { catalogSignature } from "./provider-publish.ts";
import {
  generateRaccoonQrCode,
  raccoonQrLoginUrl,
  pollRaccoonQrLogin,
  fetchRaccoonCatalog,
  RACCOON_QR_STATUS,
  RACCOON_QR_POLL_INTERVAL_MS,
  RACCOON_LOGIN_TIMEOUT_MS,
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
// The QR walk's deadline and poll cadence are GATEWAY wire facts, so they live
// in the protocol layer (`raccoon.ts`) and are imported — never re-declared
// here. They used to be declared twice with identical values, which is the one
// shape that drifts in silence: two literals, no runtime assertion able to tell
// them apart (see ROADMAP §6.1.4 and `test/raccoon.test.mjs`'s single-source
// check).
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
function writeJson(res, status, body, headers = {}) {
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
async function readJsonBody(request, limit = MAX_ACCOUNT_BODY_BYTES) {
  const chunks = [];
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
function refuseOrigin(response) {
  writeJson(response, 403, { ok: false, error: "forbidden: origin mismatch" });
}

/**
 * Refuse a disallowed method with the family's 405 shape.
 *
 * The 405 carries no `cache-control`: unlike a snapshot, a method refusal is
 * not a fresh answer anyone would want to keep, so there is nothing to tell a
 * cache not to store.
 * @param response - the outgoing HTTP response.
 * @returns {void}
 */
function refuseMethod(response) {
  writeJson(response, 405, { ok: false, error: "method not allowed" });
}

/**
 * Whether a request opted into the Raccoon 401-triage diagnostics (`?debug=1`).
 *
 * Those diagnostics are a retirable scaffold: they were the instrumentation for
 * the 401 root-cause fix (`Bearer` dual-shape + the pre-read renewal gate +
 * `/refresh`), the fix landed, and nothing in the client has ever rendered
 * them — so an ordinary poll must not carry them, least of all `hostProxyEnv`,
 * which reports environment VALUES. A query flag keeps the triage capability
 * without a config field (a patch change needs a Host restart) and without
 * widening every response.
 *
 * Only `1` / `true` opt in: `?debug=0` must stay quiet, and a malformed URL is
 * treated as "no".
 * @param {object} request - the incoming HTTP request.
 * @returns {boolean} whether the diagnostics were requested.
 */
function wantsDiagnostics(request) {
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
 * Collapses the "read body -> not ok ? write 400 and return" block every POST
 * route repeats. Returns the `readJsonBody` result on success (so callers keep
 * reading the parsed object through `body.value`, exactly as before), or `null`
 * after it has already written the 400 — a `null` is the caller's cue to return.
 * @param request - the incoming HTTP request.
 * @param response - the outgoing HTTP response (written on failure).
 * @returns {Promise<object|null>} the read result, or null if a 400 was sent.
 */
async function readJsonBodyOr400(request, response) {
  const body = await readJsonBody(request);
  if (!body.ok) {
    writeJson(response, 400, { ok: false, error: /** @type {{ok: false, error: string}} */ (body).error }, { "cache-control": "no-store" });
    return null;
  }
  return body;
}

/**
 * Register the six routes on the Host's web server.
 *
 * The handlers close over `wiring` only — every service they touch is listed
 * there, so `apply()` is the single place that decides what a route can do.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {object} wiring - assembled by `apply()` in `index.ts`.
 * @param {object} wiring.settings - the resolved settings row.
 * @param {string|null} wiring.configError - a settings/auth misconfiguration
 *   surfaced through the snapshot instead of a mount crash.
 * @param {Map} wiring.cache - the console-response cache (shared across polls).
 * @param {Map} wiring.inflight - the single-flight map (shared across polls).
 * @param {object} wiring.tokenStore - the `createTokenStore` instance.
 * @param {object} wiring.apiKeyStore - the `createApiKeyStore` instance.
 * @param {object} wiring.catalogStore - the `createFileCatalogStore` instance.
 * @param {object} wiring.providerStore - the `createFileProviderStore` instance.
 * @param {object} wiring.publisher - the `createProviderPublisher` instance.
 * @param {object} wiring.providerState - `publisher.state` (shared reference).
 * @param {Function} wiring.publishProvider - (entries, enabledIds, unavailableIds) =>
 *   publisher.publish with rollback.
 * @param {{current: Function|null}} wiring.visionPublish - the settings-row
 *   writer filled by `startSideEffects` (no-op until then).
 * @param {object} wiring.drawStore - the `createFileDrawStore` instance; the
 *   draw switch route reads and writes it.
 * @param {object} [wiring.logger] - `ctx.logger` (Host logging), used by the
 *   trace-write handler; optional so tests may omit it.
 * @returns {Function[]} the six `off()` unregister callbacks, in registration
 *   order — `teardown` runs them last.
 */
export function registerRoutes(ctx, wiring) {
  const { settings, configError, cache, inflight, tokenStore, apiKeyStore, catalogStore, providerStore, drawStore, publisher, providerState, publishProvider, visionPublish, logger, raccoonStore, raccoonSwitch, raccoonPublisher, raccoonCache } = wiring;
  // The Raccoon gateway reads (balance + catalogue) go through the SAME
  // coalescing cache primitive the console route uses, so a scan's fast poll
  // shares one call instead of issuing one per panel refresh. The instance is
  // the wiring's (created in `index.ts`) so a login/logout can clear it in one
  // place; a Host that wired none still gets a private one rather than a crash.
  const raccoonRead = raccoonCache ?? createCoalescedFetch();

  const offRoute = ctx.webServer.register({
    kind: "exact",
    path: SNAPSHOT_PATH,
    handler: async (request, response) => {
      if (!isAdmitted(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
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
          auth: await tokenStore.state().catch(() => null)
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
          apiKeyStore,
          publisher,
          catalogStore,
          panelSwitch: () => providerStore.enabled().catch(() => null),
          drawSwitch: () => (drawStore ? drawStore.enabled().catch(() => null) : null),
          drawModelId: () => (drawStore ? drawStore.modelId().catch(() => null) : null)
        });
        if (body.visionModels !== undefined) {
          // A write failure here is silent otherwise: the vision list fails to
          // persist to this row's settings, so the later image-routing plugin
          // reads a stale or empty set with no trace to explain why. Log it; the
          // in-memory body the panel already got is unaffected.
          void visionPublish.current?.(body.visionModels, body.visionModels.map((entry) => entry.id))
            .catch((error) => logger?.warn?.(`${name}: vision model list write failed`, error));
        }
        writeJson(response, 200, body, { "cache-control": "no-store" });
      } catch (error) {
        // Distinguish "we cannot get a token" from "the console call failed":
        // the first is fixed by logging in, the second is usually transient.
        writeJson(response, 200, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: failureCode(error),
          auth: await tokenStore.state().catch(() => null)
        }, { "cache-control": "no-store" });
      }
    }
  });

  const offAccount = ctx.webServer.register({
    kind: "exact",
    path: ACCOUNT_PATH,
    handler: async (request, response) => {
      // The same fence as the snapshot route: without it, any page the
      // browser visits could post an account into this panel.
      if (!isAdmitted(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
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
            ...(await tokenStore.state().catch(() => null)),
            ok: false,
            error: error instanceof Error ? error.message : String(error)
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
          ...(await tokenStore.state().catch(() => null)),
          ok: false,
          code: str(error?.code, CODE.AUTH_ERROR),
          error: error instanceof Error ? error.message : String(error),
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
    }
  });

  const offApiKey = ctx.webServer.register({
    kind: "exact",
    path: API_KEY_PATH,
    handler: async (request, response) => {
      // Same trust fence as the other two routes: a foreign page must not be
      // able to plant or wipe an inference key.
      if (!isAdmitted(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
      const method = request.method === undefined ? "GET" : request.method;
      // The secret-free state is all the form ever gets: present or not, and
      // whether it came from the credentials service or the environment.
      const answer = async (extra = {}) =>
        writeJson(
          response,
          200,
          { ok: true, ...(await apiKeyStore.state().catch(() => ({
            hasApiKey: false,
            keySource: null,
            ephemeral: false
          }))), ...extra },
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
          providerState.signature = "";
          providerState.quotaSignature = "";
          await publishProvider([], [], []);
          await answer();
        } catch (error) {
          await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      try {
        await apiKeyStore.save(body.value.apiKey);
      } catch (error) {
        await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      // The next poll fetches the catalog with the new key; a stale catalog
      // cached under a previous key must not survive it. The key itself is
      // resolved per REQUEST by the adapter, so no provider rebuild is needed.
      cache.clear();
      await answer();
    }
  });

  const offProvider = ctx.webServer.register({
    kind: "exact",
    path: PROVIDER_PATH,
    handler: async (request, response) => {
      // Same trust fence as the other three routes: a foreign page must not be
      // able to flip model routing for the whole Host.
      if (!isAdmitted(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
      const method = request.method === undefined ? "GET" : request.method;
      // Secret-free by construction: the effective switch, where it came from,
      // and whether a provider is registered right now.
      const answer = async (extra = {}) => {
        const panelSwitch = await providerStore.enabled().catch(() => null);
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
        await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      await answer();
    }
  });

  const offModels = ctx.webServer.register({
    kind: "exact",
    path: MODELS_PATH,
    handler: async (request, response) => {
      // Same fence as the other routes: a foreign page must not be able to
      // decide which models this Host offers.
      if (!isAdmitted(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
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
          enabledModelIds: await catalogStore.listEnabledIds().catch(() => providerState.enabledIds),
          registerProvider:
            ((await providerStore.enabled().catch(() => null)) ?? settings.registerProvider) === true,
          providerRegistered: providerState.registered,
          ...(providerState.error !== null ? { providerError: providerState.error } : {}),
          ...extra
        }, { "cache-control": "no-store" });
      };
      try {
        await catalogStore.setEnabledIds(ids);
        // The next poll must not re-publish the same offer: adopt the signature
        // of what was just offered, or every poll would churn the registration.
        providerState.signature = catalogSignature(providerState.entries, ids);
        // Publish immediately with the CURRENT catalogue: the offer must not
        // wait for the next poll. A failed publish rolls back to the previous
        // pair inside publishProvider and surfaces its reason.
        await publishProvider(providerState.entries, ids, providerState.unavailableIds ?? []);
      } catch (error) {
        await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      await answer();
    }
  });

  const offDraw = ctx.webServer.register({
    kind: "exact",
    path: DRAW_PATH,
    handler: async (request, response) => {
      // Same trust fence as the other routes: a foreign page must not be able
      // to turn an agent image tool on or off.
      if (!isAdmitted(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
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
          await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
          await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
        await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      await answer();
    }
  });

  // The Raccoon route (ROADMAP §6.1 "second upstream provider"). One route,
  // one GET + one POST: the GET reports the secret-free state a tab renders
  // (switch value, login state, balance, offered roster, registration status);
  // the POST carries `{ action }` for the four panel actions. The QR login is
  // a single server-side walk (no client long-poll): the route generates the
  // scan code, blocks up to the login deadline polling the gateway every 2 s,
  // and answers with the scan URL to display the moment it is issued. The
  // credential never touches this plugin's directory, git, or logs — it goes
  // straight to the DSH credentials service through `raccoonStore`.
  // The in-flight QR login state lives OUTSIDE the handler: a handler-local
  // would be re-initialized to null on EVERY request (each call re-runs the
  // function body), so a GET arriving while the POST login walk is waiting
  // could never see the scan — the tab would poll forever with no QR to
  // render. One scan per process (the single long-poll owns it); cleared when
  // the walk settles.
  let raccoonScan: { code: string; url: string } | null = null;
  /**
   * The in-flight login walk, kept as the CONCURRENCY GATE.
   *
   * The walk is no longer the request (see the `login` branch): it runs in the
   * background and the POST answers the moment the scan code is issued. The
   * promise is held only so a second click (or a second tab) cannot start a
   * second walk — two walks would each hold a different code while the GET
   * could only ever report one, which is how a scan silently stops matching
   * the QR on screen.
   */
  let raccoonWalk: Promise<void> | null = null;
  /**
   * The settled outcome of the last login walk (`logged_in` / `timeout` /
   * `canceled` / `failed`), or `"scanning"` while one is in flight.
   *
   * A terminal status is delivered ONCE and then cleared: it is an event, not a
   * state, and leaving it standing would have the tab re-announce a two-minute
   * old timeout on every later poll. The panel's durable truth is `loggedIn`,
   * which the credential itself answers.
   */
  let raccoonLoginStatus: string | null = null;
  /** The reason behind a `failed` walk; cleared with the status. */
  let raccoonLoginError: string | null = null;
  /**
   * The login walk's transient state, as `raccoon-status.ts` reads it.
   *
   * Defined ONCE beside the bindings it closes over (not per request): the
   * module can only ask, so the clearing of a terminal event stays the route's
   * single decision, and the exact ordering the read model depends on (see the
   * two comments in `readRaccoonStatus`) is visible here rather than inferred.
   */
  const raccoonLoginView = {
    takeEvent: () => {
      const status = raccoonLoginStatus;
      const error = raccoonLoginError;
      // A terminal status is an EVENT, not a state: hand it over and clear it,
      // or every later poll re-announces a two-minute-old timeout. `scanning`
      // is the live state of an in-flight walk, so it stays.
      if (status !== null && status !== "scanning") {
        raccoonLoginStatus = null;
        raccoonLoginError = null;
      }
      return { status, error };
    },
    liveScan: () => raccoonScan
  };
  const offRaccoon = ctx.webServer.register({
    kind: "exact",
    path: RACCOON_PATH,
    handler: async (request, response) => {
      if (!isAdmitted(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
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
            login: raccoonLoginView
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
      const body = await readJsonBody(request, MAX_RACCOON_BODY_BYTES);
      if (!body.ok) {
        writeJson(response, 400, { ok: false, error: body.error }, { "cache-control": "no-store" });
        return;
      }
      const { action } = body.value;
      const answer = async (extra = {}) => {
        const state = await raccoonState();
        writeJson(response, 200, { ...state, ...extra }, { "cache-control": "no-store" });
      };
      // The publish payload every registration-driving action shares: the live
      // catalogue when a credential exists, else the static fallback, MINUS
      // the panel's curated-away ids (filterRaccoonRows). `switch`, `models`
      // and the settled `login` walk all drive the same publisher with it.
      const collectRaccoonRows = async (catalogToken) => {
        let rows = RACCOON_FALLBACK_MODELS;
        let officeIdentity = "";
        try {
          const { credential } = raccoonStore ? await raccoonStore.resolve().catch(() => ({ credential: null })) : { credential: null };
          if (catalogToken !== undefined && catalogToken !== null && catalogToken !== "") {
            // A freshly-scanned token: the read lands in the same cache under
            // its own fingerprint, so the first GET after login reuses it
            // instead of re-fetching what this very call just fetched.
            const live = await raccoonRead
              .read(`catalog:${tokenFingerprint(catalogToken)}`, () => fetchRaccoonCatalog({ access_token: catalogToken }), RACCOON_CATALOG_TTL_MS)
              .catch(() => null);
            if (live !== null && live.length > 0) rows = live;
          } else if (credential?.accessToken) {
            const live = await raccoonRead
              .read(`catalog:${tokenFingerprint(credential.accessToken)}`, () => fetchRaccoonCatalog(credential), RACCOON_CATALOG_TTL_MS)
              .catch(() => null);
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
          await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        await answer();
        return;
      }

      // ── models: save the pushed-model curation and rebuild the offer ──
      if (action === "models") {
        const ids = body.value.enabledModelIds;
        if (!Array.isArray(ids) || ids.some((entry) => typeof entry !== "string")) {
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
          await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        await answer({ ok: true, saved: true });
        return;
      }

      // ── login: issue a WeChat scan, then walk it in the BACKGROUND ──
      //
      // The walk used to BE the request: the POST blocked up to the 5-minute
      // deadline, polling the gateway every 2 s. That is an HTTP handler
      // holding a connection for five minutes — a tab reload, a proxy timeout
      // or a Host restart cuts it mid-walk, and the scan it issued stays pinned
      // on this route with nothing left to clear it. The client compensated by
      // running its own 150 × 2 s poll beside it, so one scan cost the gateway
      // hundreds of reads for a number that cannot change that fast.
      //
      // Now the POST answers the moment the scan is issued, the walk runs
      // behind it, and the tab learns the outcome from the GET it already
      // polls. One walk at a time (`raccoonWalk`).
      if (action === "login") {
        if (raccoonStore === null || raccoonStore === undefined) {
          await answer({ ok: false, error: "the raccoon credential store is unavailable" });
          return;
        }
        // A walk is already waiting: hand back ITS scan rather than issuing a
        // second one. Two walks would each own a different code while the GET
        // can only ever report one, so the QR on screen would stop matching the
        // code being polled — a scan that looks permanently stuck, with no
        // error anywhere to explain it.
        if (raccoonWalk !== null && raccoonScan !== null) {
          await answer({ ok: true, status: "scanning", scanUrl: raccoonScan.url, scanCode: raccoonScan.code });
          return;
        }
        const code = generateRaccoonQrCode();
        const scanUrl = raccoonQrLoginUrl(code);
        // The scan is in flight now: a GET the tab makes while this walk is
        // waiting reports the SAME code/URL (see `raccoonState`), so a refresh
        // or a second tab continues the scan instead of voiding it.
        raccoonScan = { code, url: scanUrl };
        raccoonLoginStatus = "scanning";
        raccoonLoginError = null;
        raccoonWalk = (async () => {
          const deadline = Date.now() + RACCOON_LOGIN_TIMEOUT_MS;
          let settled: any = null;
          let canceled = false;
          while (Date.now() < deadline) {
            const poll = await pollRaccoonQrLogin(code).catch(() => ({ status: RACCOON_QR_STATUS.PENDING }));
            if (poll.status === RACCOON_QR_STATUS.SUCCESS) {
              settled = poll;
              break;
            }
            if (poll.status === RACCOON_QR_STATUS.CANCELED) {
              canceled = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, RACCOON_QR_POLL_INTERVAL_MS));
          }
          if (settled === null) {
            // Timed out or the phone canceled: the panel says "try again".
            raccoonLoginStatus = canceled ? "canceled" : "timeout";
            return;
          }
          // Evidence, not guesswork: the success envelope was only ever probed
          // for the token pair, so log its FIELD NAMES (never values — no
          // secret can leak in a key list) once per login. A field the panel
          // later wants (a nickname the extractor missed, an org id) shows up
          // here on the first real scan instead of staying a silent gap.
          const dataFields = Array.isArray(settled.dataFields) ? settled.dataFields : [];
          logger?.info?.(`${name}: raccoon login envelope fields: ${dataFields.join(", ") || "(none)"}; nickname extracted: ${settled.nickname !== ""}`);
          // The scan worked: persist the pair to the credentials service (the
          // refresh token is single-use, so the store owns that write-back),
          // then drive the registration if the switch is on.
          try {
            await raccoonStore.save({
              accessToken: settled.accessToken,
              refreshToken: settled.refreshToken,
              ...(settled.expiresAtMs !== undefined ? { expiresAtMs: settled.expiresAtMs } : {}),
              // The QR success envelope carries the nickname — store it, or the
              // panel's "已登录：" line has nothing to show.
              ...(settled.nickname !== undefined && settled.nickname !== "" ? { nickname: settled.nickname } : {})
            });
          } catch (error) {
            // The scan worked and the credential did not land: the tab can only
            // hear about it through the same event channel, so the reason rides
            // there (sanitized — the store's message may quote the document).
            raccoonLoginStatus = "failed";
            raccoonLoginError = redactSecrets(error instanceof Error ? error.message : String(error));
            return;
          }
          // A new credential invalidates every read taken under the previous
          // one: the balance and the catalogue are per-account facts, and a
          // cached answer from the old session must not surface under the new
          // login. (This walk's own catalogue read is keyed on the NEW token, so
          // it is unaffected.)
          raccoonRead.clear();
          if (raccoonPublisher !== null && raccoonPublisher !== undefined && raccoonPublisher.isDisposed() === false) {
            const switchState = raccoonSwitch ? await raccoonSwitch.enabled().catch(() => null) : null;
            if (switchState === true) {
              const { rows, officeIdentity } = await collectRaccoonRows(settled.accessToken);
              await raccoonPublisher.publish(rows, officeIdentity);
            }
          }
          raccoonLoginStatus = "logged_in";
        })().finally(() => {
          // Both exits land here: the scan is over either way, and the gate
          // must reopen even when the walk threw — otherwise every later login
          // would be told "a walk is already waiting" forever.
          raccoonWalk = null;
          raccoonScan = null;
        });
        await answer({ ok: true, status: "scanning", scanUrl, scanCode: code });
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
          await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        await answer({ ok: true, status: "logged_out" });
        return;
      }

      writeJson(response, 400, { ok: false, error: "expected { action: \"switch\"|\"models\"|\"login\"|\"logout\" }" }, { "cache-control": "no-store" });
    }
  });

  return [offRoute, offAccount, offApiKey, offProvider, offModels, offDraw, offRaccoon];
}
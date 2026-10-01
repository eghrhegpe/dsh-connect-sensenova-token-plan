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
import { createHash } from "node:crypto";
import { isAdmitted, name } from "./host-config.ts";
import { buildSnapshotBody, failureCode } from "./snapshot-aggregate.ts";
import { CODE } from "./codes.ts";
import { writeLoginTrace } from "./trace.ts";
import { str, redactSecrets } from "./util.ts";
import { normalizeEnabledIds } from "./catalog-store.ts";
import { catalogSignature } from "./provider-publish.ts";
import {
  generateRaccoonQrCode,
  raccoonQrLoginUrl,
  pollRaccoonQrLogin,
  fetchRaccoonCatalog,
  fetchRaccoonBalance,
  RACCOON_QR_STATUS,
  RACCOON_FALLBACK_MODELS
} from "./raccoon.ts";

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
/** The QR login's overall deadline; a scan that takes longer is voided. */
const RACCOON_LOGIN_DEADLINE_MS = 5 * 60 * 1000;
/** One QR poll cadence, so a login wait loops at the gateway's own rate. */
const RACCOON_POLL_MS = 2_000;
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
  const { settings, configError, cache, inflight, tokenStore, apiKeyStore, catalogStore, providerStore, drawStore, publisher, providerState, publishProvider, visionPublish, logger, raccoonStore, raccoonSwitch, raccoonPublisher } = wiring;

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
      } catch (error) {
        // A rejected password is the common case, and it is the user's to
        // correct: report the reason and leave the panel usable.
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
        const panelDraw = await (drawStore ? drawStore.enabled() : null).catch(() => null);
        const panelModel = await (drawStore ? drawStore.modelId() : null).catch(() => null);
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
  const offRaccoon = ctx.webServer.register({
    kind: "exact",
    path: RACCOON_PATH,
    handler: async (request, response) => {
      if (!isAdmitted(request, settings.allowedHosts)) {
        refuseOrigin(response);
        return;
      }
      // The GET's secret-free state, reused by every POST branch so a mutation
      // always re-reports the same facts a GET would. The `scanUrl`/`code` it
      // carries are the scan the pending login walk last issued.
      const raccoonState = async () => {
        const switchState = await (raccoonSwitch ? raccoonSwitch.enabled() : null).catch(() => null);
        const effectiveEnabled = switchState === true;
        let loggedIn = false;
        let nickname = "";
        let balance = null;
        let balanceBreakdown: { daily?: number; reward?: number; monthly?: number; topup?: number } | null = null;
        let balanceDetail: string | null = null;
        let accessTokenPrefix: string | null = null;
        // Diagnostics (one-shot, to name the 401's owner): which layer the
        // credential came from, whether the host's OWN process environment
        // carries a shadowing RACCOON_CREDENTIAL (the credentials provider's
        // inherited layer wins over the file), a secret-free fingerprint of
        // the exact access token the panel read, and the host process's
        // proxy env (a fresh-process probe has none — a difference here would
        // mean the same token reaches the gateway through a different hop).
        let credentialSource: string | null = null;
        let raccoonEnvShadow: boolean | null = null;
        let envCredentialFingerprint: string | null = null;
        let accessTokenFingerprint: string | null = null;
        let hostProxyEnv: string[] | null = null;
        let error = null;
        // The credential's own expiry facts. `raccoonStore.state()` already
        // resolves them (from the JWT `exp` claim); dropping them here is what
        // made the tab say "已登录" long after the access token died — the
        // registration stayed up (the publish gate only asks "is there a
        // token?", not "is it live?"), so every request failed with a 401 the
        // panel could not name.
        let expiresAtMs: number | null = null;
        let credentialExpired = false;
        // The refresh token's window (≈30 days): how long the login survives
        // before a re-scan is the ONLY way back.
        let refreshExpiresAtMs: number | null = null;
        try {
          if (raccoonStore !== null && raccoonStore !== undefined) {
            let state = await raccoonStore.state().catch(() => null);
            loggedIn = state?.hasCredential === true;
            nickname = state?.nickname ?? "";
            credentialSource = state?.source ?? null;
            if (loggedIn) {
              // The same pre-request eager refresh the seed path uses: a
              // lapsed 3-hour access token with a live 30-day refresh must not
              // 401 the panel. Rotate in place (single-flight, whole-pair
              // re-store), then re-read state so the surfaced expiry facts
              // describe the pair that will actually serve the calls below.
              if (await raccoonStore.isExpired().catch(() => false)) {
                await raccoonStore.refresh().catch(() => {});
                state = await raccoonStore.state().catch(() => state);
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
              const { credential } = await raccoonStore.resolve().catch(() => ({ credential: null }));
              if (credential?.accessToken) {
                // Diagnostic: only the prefix, never the token, so a mismatch
                // against the stored credential is visible without leaking it.
                accessTokenPrefix = credential.accessToken.slice(0, 8);
                // SHA-256 prefix of the EXACT token the panel would send —
                // a stable, non-reversible identifier to diff against the
                // file's token (an `eyJhbGci` prefix is useless: every HS256
                // JWT starts with it).
                accessTokenFingerprint = createHash("sha256")
                  .update(credential.accessToken, "utf8")
                  .digest("hex")
                  .slice(0, 12);
                // `onFail` reports the concrete reason a read came back empty —
                // a broken request must not look like "the gateway has nothing
                // to say". Surfaced as `balanceDetail` for debugging.
                const balanceRead = await fetchRaccoonBalance(credential, undefined, (why) => { balanceDetail = why; }).catch((why) => {
                  balanceDetail = `call rejected: ${why instanceof Error ? why.message : String(why)}`;
                  return null;
                });
                balance = balanceRead?.total ?? null;
                if (balanceRead !== null && balanceRead !== undefined) {
                  const parts = {};
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
          error = redactSecrets(why instanceof Error ? why.message : String(why));
        }
        // The host process's OWN launch environment (the credentials
        // provider's inherited layer, which beats the file): a
        // RACCOON_CREDENTIAL set there shadows the file credential for THIS
        // host only — a fresh-process probe never sees it. That is exactly
        // the shape of "same file, probe 200, panel 401". Presence + a
        // fingerprint of the shadowing document, never the value.
        raccoonEnvShadow = Object.hasOwn(process.env, "RACCOON_CREDENTIAL") && process.env.RACCOON_CREDENTIAL !== "";
        if (raccoonEnvShadow) {
          // Fingerprint of the SHADOWING document (the serialized reference
          // value, not a token): lets the panel side diff which copy this
          // host actually serves without printing either document.
          envCredentialFingerprint = createHash("sha256")
            .update(process.env.RACCOON_CREDENTIAL, "utf8")
            .digest("hex")
            .slice(0, 12);
        }
        // Proxy env is the other per-process difference a fresh probe can't
        // see: a route through a corporate hop can drop or mangle the
        // Authorization the direct path carries. Names + values, all
        // non-secret.
        hostProxyEnv = [
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "http_proxy",
          "https_proxy",
          "ALL_PROXY",
          "NO_PROXY",
          "no_proxy"
        ].filter((key) => process.env[key] !== undefined && process.env[key] !== "")
          .map((key) => `${key}=${process.env[key]}`);
        // The roster the adapter offers: the live catalogue when a credential
        // exists (the switch's own publish reads it too), else the static
        // fallback so the panel still shows the known models. `modelsSource`
        // names which one the panel is looking at — and WHY the fallback is in
        // play, so the note does not lie: a gateway that read fine but listed
        // no visible model is "empty", not "unreadable" (the two read as very
        // different facts to the user).
        let models = null;
        let catalogReadFailed = false;
        try {
          if (raccoonStore !== null && raccoonStore !== undefined) {
            const { credential } = await raccoonStore.resolve().catch(() => ({ credential: null }));
            if (credential?.accessToken) {
              models = await fetchRaccoonCatalog(credential, undefined, () => { catalogReadFailed = true; }).catch(() => {
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
        const roster = rosterLive ? models : RACCOON_FALLBACK_MODELS;
        const modelsSource = rosterLive ? "live" : catalogReadFailed ? "unreadable" : "empty";
        const publisherState = raccoonPublisher?.state ?? null;
        return {
          ok: true,
          enabled: effectiveEnabled,
          switchSource: switchState === null ? "off" : "panel",
          loggedIn,
          nickname,
          // Whether the stored access token has lapsed. `loggedIn` alone says
          // "a credential exists"; this says whether it can still serve. The
          // tab renders a distinct re-login affordance on this flag.
          credentialExpired,
          ...(expiresAtMs !== null ? { expiresAtMs } : {}),
          ...(refreshExpiresAtMs !== null ? { refreshExpiresAtMs } : {}),
          // The in-flight scan (if a login walk is waiting): the tab re-renders
          // its QR from this on every poll, so a second tab / a refresh
          // continues the SAME scan instead of voiding it.
          ...(raccoonScan !== null ? { scanUrl: raccoonScan.url, scanCode: raccoonScan.code } : {}),
          balance,
          ...(balanceBreakdown !== null ? { balanceBreakdown } : {}),
          ...(balanceDetail !== null ? { balanceDetail } : {}),
          ...(accessTokenPrefix !== null ? { accessTokenPrefix } : {}),
          ...(credentialSource !== null ? { credentialSource } : {}),
          ...(raccoonEnvShadow !== null ? { raccoonEnvShadow } : {}),
          ...(envCredentialFingerprint !== null ? { envCredentialFingerprint } : {}),
          ...(accessTokenFingerprint !== null ? { accessTokenFingerprint } : {}),
          hostProxyEnv,
          models: roster,
          modelsSource,
          providerRegistered: publisherState?.registered === true,
          ...(publisherState?.error !== null && publisherState?.error !== undefined ? { providerError: publisherState.error } : {}),
          ...(error !== null ? { error } : {})
        };
      };

      const method = request.method === undefined ? "GET" : request.method;
      if (method === "GET") {
        writeJson(response, 200, await raccoonState(), { "cache-control": "no-store" });
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
            let rows = RACCOON_FALLBACK_MODELS;
            let officeIdentity = "";
            try {
              const { credential } = raccoonStore ? await raccoonStore.resolve().catch(() => ({ credential: null })) : { credential: null };
              if (credential?.accessToken) {
                const live = await fetchRaccoonCatalog(credential).catch(() => null);
                if (live !== null && live.length > 0) rows = live;
                officeIdentity = credential.officeIdentity ?? "";
              }
            } catch {
              // Fallback roster is already the safe default.
            }
            await raccoonPublisher.publish(rows, officeIdentity);
          }
        } catch (error) {
          await answer({ ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        await answer();
        return;
      }

      // ── login: start a WeChat-QR walk and block until it settles ──
      if (action === "login") {
        if (raccoonStore === null || raccoonStore === undefined) {
          await answer({ ok: false, error: "the raccoon credential store is unavailable" });
          return;
        }
        const code = generateRaccoonQrCode();
        const scanUrl = raccoonQrLoginUrl(code);
        // The scan is in flight now: a GET the tab makes while this walk is
        // waiting reports the SAME code/URL (see `raccoonState`), so a refresh
        // or a second tab continues the scan instead of voiding it.
        raccoonScan = { code, url: scanUrl };
        const deadline = Date.now() + RACCOON_LOGIN_DEADLINE_MS;
        let settled = null;
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
          await new Promise((resolve) => setTimeout(resolve, RACCOON_POLL_MS));
        }
        raccoonScan = null;
        if (settled === null) {
          // Timed out or the phone canceled: the panel says "try again".
          await answer({ ok: false, status: canceled ? "canceled" : "timeout" });
          return;
        }
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
          await answer({ ok: false, status: "logged_in", error: redactSecrets(error instanceof Error ? error.message : String(error)) });
          return;
        }
        if (raccoonPublisher !== null && raccoonPublisher !== undefined && raccoonPublisher.isDisposed() === false) {
          const switchState = raccoonSwitch ? await raccoonSwitch.enabled().catch(() => null) : null;
          if (switchState === true) {
            let rows = RACCOON_FALLBACK_MODELS;
            let officeIdentity = "";
            const live = settled.accessToken ? await fetchRaccoonCatalog({ access_token: settled.accessToken }).catch(() => null) : null;
            if (live !== null && live.length > 0) rows = live;
            const liveCredential = await raccoonStore.resolve().catch(() => ({ credential: null }));
            officeIdentity = liveCredential?.credential?.officeIdentity ?? officeIdentity;
            await raccoonPublisher.publish(rows, officeIdentity);
          }
        }
        await answer({ ok: true, status: "logged_in" });
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

      writeJson(response, 400, { ok: false, error: "expected { action: \"switch\"|\"login\"|\"logout\" }" }, { "cache-control": "no-store" });
    }
  });

  return [offRoute, offAccount, offApiKey, offProvider, offModels, offDraw, offRaccoon];
}
/**
 * The plugin's real wiring, driven by a real Cordis container.
 *
 * The route tests call `apply()` with a hand-rolled object that quacks like a
 * Host. That covers the handler bodies, and nothing else: not the plugin's
 * `inject` declaration, not service resolution, not the mount/unmount
 * lifecycle, not whether the routes are registered at all before something asks
 * for them. A plugin whose `inject` names a service the Host does not provide
 * would stay invisible in that suite and simply never appear in the UI.
 *
 * So this file boots an actual `@deepseek-ai/cordis` container, loads the
 * plugin the way the Loader does, and inspects what really got registered.
 * It stops short of a full `dsh web` process — no such CLI is installed here,
 * and the Electron runtime is not a server you can script — but it does cover
 * the seam that a fake context cannot.
 */
import { loadPeer, installNetworkGuard, isolateHostEnv, isolateStateDir } from "./peer-roots.mjs";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();
/** This machine's own SenseNova keys must not steer a check. */
const restoreHostEnv = isolateHostEnv();

const { Context } = await loadPeer("cordis");

// The Raccoon "second upstream provider" stores (ROADMAP §6.1): the switch's
// state file is shared with the plugin's own instance through `$DSH_HOME`
// (isolated below), and the credential is a credentials-service reference.
import { createFileRaccoonStore } from "../src/host/raccoon-switch-store.ts";
import { RACCOON_CREDENTIAL_REF, serializeRaccoonCredential } from "../src/host/raccoon-store.ts";
import { RACCOON_PROVIDER_ID } from "../src/host/raccoon-models.ts";

/** After the peers are found: mounting must not write into the real Home. */
const restoreStateDir = isolateStateDir();

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

/** A webServer service that records what a plugin registers with it. */
function makeWebServer() {
  const registered = new Map();
  return {
    registered,
    register(spec) {
      if (spec === null || typeof spec !== "object") throw new TypeError("register(spec) needs a spec");
      if (typeof spec.path !== "string") throw new TypeError("a route spec needs a path");
      if (typeof spec.handler !== "function") throw new TypeError("a route spec needs a handler");
      if (spec.kind !== undefined && spec.kind !== "exact") {
        throw new TypeError(`unexpected route kind: ${String(spec.kind)}`);
      }
      registered.set(spec.path, spec.handler);
      return () => { registered.delete(spec.path); };
    }
  };
}

/** A credentials service with the same surface the store uses. */
function makeCredentials() {
  const records = new Map();
  const refs = new Map();
  return {
    records,
    refs,
    async readRecord(k) { return records.get(k); },
    async modifyRecord(k, mutate) {
      const next = await mutate(records.get(k));
      if (next === undefined) return records.get(k);
      records.set(k, next);
      return next;
    },
    async deleteRecord(k) { records.delete(k); },
    async resolve(ref) {
      const v = refs.get(ref);
      return typeof v === "string" && v !== "" ? { value: v, source: "file" } : undefined;
    },
    async set(ref, value) { refs.set(ref, value); },
    async unset(ref) { refs.delete(ref); }
  };
}

/** A fake llm registration service recording the provider pair lifecycle. */
function makeLlm() {
  const calls = { adapter: 0, directory: 0, released: 0 };
  return {
    calls,
    registerAdapter(ids, adapter) {
      calls.adapter += 1;
      calls.lastIds = ids;
      calls.lastAdapter = adapter;
      return () => { calls.released += 1; };
    },
    registerConfigurableProviders(rows) {
      calls.directory += 1;
      calls.lastRows = rows;
      return () => { calls.released += 1; };
    }
  };
}

/** The peer adapter seam replacement: no Host peers are needed in wiring. */
function adapterDeps() {
  const builds = [];
  return {
    builds,
    loadAdapterModule: async () => ({
      createSensenovaAdapter(options) {
        builds.push(options);
        return { providerIds: ["sensenova-token-plan"], adapter: { fake: true } };
      }
    })
  };
}

/**
 * An adapter seam whose FIRST build parks until the test lets it go.
 *
 * The mount seed publishes fire-and-forget, so whether a second publish
 * overlaps it is otherwise a matter of timing — and a race that only fails
 * sometimes is a race that ships. Parking the first build makes the
 * interleaving deterministic: the second publish runs to completion while the
 * first is still inside the critical section, which is exactly the ordering
 * that used to let the stale catalog win.
 */
function gatedAdapterDeps() {
  const builds = [];
  let count = 0;
  let open = null;
  return {
    builds,
    /** Let the parked build continue. */
    release() { open?.(); },
    loadAdapterModule: async () => ({
      async createSensenovaAdapter(options) {
        const n = (count += 1);
        builds.push(options);
        // Only the FIRST build parks, so the second can finish ahead of it.
        if (n === 1) await new Promise((resolve) => { open = resolve; });
        return { providerIds: ["sensenova-token-plan"], adapter: { tag: n } };
      }
    })
  };
}

/** A minimal Host request, as Cordis would hand one to a handler. */
function request(extra = {}) {
  return { method: "GET", headers: { host: "127.0.0.1:19387", ...extra } };
}

/**
 * Let pending microtasks and I/O callbacks run to completion.
 *
 * The mount seed crosses several awaits before it publishes — two state-file
 * reads, the provider switch file, the adapter factory — so a single
 * `setTimeout(0)` is a coin toss that happens to land on a fast machine. A
 * fixed number of turns costs milliseconds and makes the wait the same
 * generous margin everywhere instead of a race that only fails under load.
 */
async function settle(turns = 10) {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A POST with a JSON body, as Cordis would hand one to a handler. */
function postRequest(body, extra = {}) {
  return {
    method: "POST",
    headers: { host: "127.0.0.1:19387", ...extra },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), "utf8"); }
  };
}

function response() {
  return {
    statusCode: null,
    headers: null,
    payload: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(text) { this.payload = text === undefined ? null : JSON.parse(text); }
  };
}

/** Boot a container with the given services and load the plugin into it. */
async function bootPlugin({ withCredentials = true, withLlm = false, config = {}, de } = {}) {
  const webServer = makeWebServer();
  const credentials = withCredentials ? makeCredentials() : undefined;
  const llm = withLlm ? makeLlm() : undefined;
  const ctx = new Context();
  // Services are published with `ctx.provide`, the way a Host publishes its
  // own. Assigning `ctx.webServer` from a plugin's apply would be too late:
  // `inject` is resolved BEFORE apply runs, so a plugin declaring
  // `inject: ["webServer"]` would never see it and would silently never
  // activate — exactly the wiring bug this file exists to catch.
  ctx.provide("webServer", webServer);
  if (credentials !== undefined) ctx.provide("credentials", credentials);
  // `llm` is consumed optionally through `ctx.get` (this plugin injects only
  // webServer), the same optional seam the settings/attachments services use.
  if (llm !== undefined) ctx.provide("llm", llm);
  const host = await import(`../src/host/index.ts?wiring=${Math.random()}`);
  // The Loader hands Cordis the plugin object; the module's named exports are
  // that object, so pass exactly them. `ctx.plugin` returns the fiber, and
  // disposing that fiber is how a plugin is stopped — the teardown path the
  // route's `ctx.effect` return value hangs off. The third apply argument is
  // test-only seam wiring (the peer adapter module); the real Loader passes
  // nothing there.
  const plugin = { name: host.name, inject: host.inject, apply: (fiberCtx, row) => host.apply(fiberCtx, row, de) };
  const fiber = await ctx.plugin(plugin, config);
  return { ctx, webServer, credentials, llm, host, plugin, fiber, stop: () => fiber?.dispose?.() };
}

// === A. a bad endpoint override is refused, not silently applied ========
// `apply` now builds a `createAuth(settings.auth)` instance of its own, so each
// boot gets a fresh config — there is no module-level state to inherit and no
// hidden-state trap. This case still confirms a malformed override is reported
// as a config error rather than silently aimed at the real platform.
{
  // `consoleBase` is the operator-facing key (see cordis.patch.yml); the
  // `auth.*` overrides are the lower-level ones `createAuth` also accepts.
  const { webServer, stop } = await bootPlugin({ config: { consoleBase: "not-a-url" } });
  const res = response();
  await webServer.registered.get("/api/dsh-connect-sensenova-token-plan/snapshot")(request(), res);
  // A malformed override must fail loudly: the alternative is a baffling
  // network error on every poll, with nothing saying why.
  check("a malformed endpoint is reported as a config error",
    res.payload?.ok === false && res.payload?.code === "config_error",
    JSON.stringify(res.payload ?? {}).slice(0, 120));
  check("the config error explains itself", typeof res.payload?.error === "string" && res.payload.error.length > 0,
    String(res.payload?.error));
  await stop();
}

// === A2. a NESTED auth block is refused, not silently ignored ===========
// Found by the end-to-end run, and the most dangerous shape this plugin has.
// The loader accepts `auth: { iamBase: ... }`; the plugin reads its overrides
// from the TOP level, so the block is dropped without a word — and the panel
// then runs on its shipped defaults, which point at the REAL platform. A test
// run meant for a local stub posted a real login attempt before this check
// existed. Silence here is what makes that possible, so it must be loud.
{
  const { webServer, stop } = await bootPlugin({
    config: { consoleBase: "http://127.0.0.1:19399", auth: { iamBase: "http://127.0.0.1:19399" } }
  });
  const res = response();
  await webServer.registered.get("/api/dsh-connect-sensenova-token-plan/snapshot")(request(), res);
  check("a nested auth block is reported as a config error",
    res.payload?.ok === false && res.payload?.code === "config_error",
    JSON.stringify(res.payload ?? {}).slice(0, 140));
  check("the message names the top-level keys to use",
    typeof res.payload?.error === "string" && res.payload.error.includes("iamBase"),
    String(res.payload?.error).slice(0, 160));
  // The panel must still mount and still answer: an operator who misconfigured
  // a key needs to be told, not left with a plugin that vanished.
  check("the plugin still mounts despite the bad row",
    webServer.registered.has("/api/dsh-connect-sensenova-token-plan/snapshot"));
  await stop();
}

// === B. the plugin activates and registers all three routes ===============
{
  const { webServer, host, stop } = await bootPlugin();
  check("the plugin declares the services it needs", Array.isArray(host.inject) && host.inject.includes("webServer"),
    JSON.stringify(host.inject));
  const routes = [
    "/api/dsh-connect-sensenova-token-plan/snapshot",
    "/api/dsh-connect-sensenova-token-plan/account",
    "/api/dsh-connect-sensenova-token-plan/api-key",
    "/api/dsh-connect-sensenova-token-plan/provider",
    "/api/dsh-connect-sensenova-token-plan/models",
    "/api/dsh-connect-sensenova-token-plan/draw",
    "/api/dsh-connect-sensenova-token-plan/raccoon"
  ];
  check("all seven routes are registered on mount",
    routes.every((path) => webServer.registered.has(path)),
    [...webServer.registered.keys()].join(", "));
  // The registered values must be callable handlers, not specs: the real
  // webServer invokes what it was given, and the panel depends on it.
  check("every route is a function",
    routes.every((path) => typeof webServer.registered.get(path) === "function"),
    routes.map((path) => typeof webServer.registered.get(path)).join(", "));
  await stop();
}

// === B. the routes answer through the container, not a stub ==============
{
  const { webServer, stop } = await bootPlugin();
  const handler = webServer.registered.get("/api/dsh-connect-sensenova-token-plan/snapshot");
  const res = response();
  // No account is configured, so this is the quota-unavailable path — the
  // body still answers `ok:true` with an in-body `quotaError` and carries the
  // `auth` block the panel needs to offer the sign-in form.
  await handler(request(), res);
  check("the snapshot route answers 200", res.statusCode === 200, String(res.statusCode));
  check("it reports a payload", res.payload !== null);
  check("an unconfigured Host is not an error state",
    res.payload?.ok === true && res.payload?.quotaError?.code === "not_configured",
    JSON.stringify(res.payload ?? {}).slice(0, 140));
  check("the answer carries the auth block the panel reads",
    res.payload?.auth !== undefined && res.payload?.auth?.needsAccount === true,
    JSON.stringify(res.payload?.auth));
  check("an unconfigured Host is not marked ephemeral",
    res.payload?.auth?.ephemeral === false, JSON.stringify(res.payload?.auth?.ephemeral));
  check("no wait is being served", res.payload?.auth?.retryAfterMs === null,
    String(res.payload?.auth?.retryAfterMs));
  check("no user action is demanded", res.payload?.auth?.needsUserAction === false,
    String(res.payload?.auth?.needsUserAction));
  check("the response is not cacheable", res.headers?.["cache-control"] === "no-store",
    JSON.stringify(res.headers));
  await stop();
}

// === C. a cross-origin request is refused at the real seam ===============
{
  const { webServer, stop } = await bootPlugin();
  const handler = webServer.registered.get("/api/dsh-connect-sensenova-token-plan/account");
  const res = response();
  await handler({ method: "POST", headers: { host: "127.0.0.1:19387", origin: "https://evil.test" } }, res);
  check("a cross-origin request is refused", res.statusCode === 403, String(res.statusCode));
  await stop();
}

// === D. unmounting withdraws the routes ==================================
// A plugin that leaks its routes keeps answering after it is disabled, which
// in the real Host means a stale panel still polling a route nobody owns.
{
  const { webServer, stop } = await bootPlugin();
  check("all seven routes are present while mounted", webServer.registered.size === 7,
    [...webServer.registered.keys()].join(", "));
  await stop();
  check("unmounting withdraws the routes", webServer.registered.size === 0,
    [...webServer.registered.keys()].join(", "));
}

// === E. a Host WITHOUT the credentials service still activates ===========
{
  const { webServer, stop } = await bootPlugin({ withCredentials: false });
  check("the plugin activates without the credentials service",
    webServer.registered.has("/api/dsh-connect-sensenova-token-plan/snapshot"));
  const res = response();
  await webServer.registered.get("/api/dsh-connect-sensenova-token-plan/snapshot")(request(), res);
  check("it reports the account as needed", res.payload?.auth?.needsAccount === true,
    JSON.stringify(res.payload?.auth));
  // With no service to hold it, the account would not survive a restart, and
  // the panel has to say so rather than imply the account is safe on disk.
  check("it admits the account is ephemeral", res.payload?.auth?.ephemeral === true,
    String(res.payload?.auth?.ephemeral));
  await stop();
}

// === F. the direct provider registers through the real llm service =======
// With `registerProvider: true` the mount seed registers the provider even
// before a console login or a first poll (its model list may start empty).
// The peer-dependent factory is injected via apply's third arg; what is
// asserted here is the Cordis-level wiring: optional `ctx.get("llm")`, the
// register pair, and its release on dispose.
{
  const de = adapterDeps();
  const { webServer, llm, stop } = await bootPlugin({
    withLlm: true,
    config: { registerProvider: true },
    de
  });
  // Let the mount seed's async publish settle.
  await settle();
  check("the adapter pair was registered with the llm service",
    llm.calls.adapter === 1 && llm.calls.directory === 1,
    JSON.stringify({ adapter: llm.calls.adapter, directory: llm.calls.directory }));
  check("the adapter is owned by the non-colliding provider id",
    Array.isArray(llm.calls.lastIds) && llm.calls.lastIds[0] === "sensenova-token-plan",
    JSON.stringify(llm.calls.lastIds));
  check("the directory row names this plugin's settings namespace",
    llm.calls.lastRows?.[0]?.settingsNs === "dsh-connect-sensenova-token-plan" &&
    llm.calls.lastRows[0]?.declared === false,
    JSON.stringify(llm.calls.lastRows));
  check("the adapter was built for apiBase with the key resolver seam",
    de.builds.length === 1 && typeof de.builds[0].resolveApiKey === "function" &&
    de.builds[0].baseUrl === "https://token.sensenova.cn/v1",
    JSON.stringify({ builds: de.builds.length, baseUrl: de.builds[0]?.baseUrl }));
  // The API-key route is served by the same container while registered.
  const keyRes = response();
  await webServer.registered.get("/api/dsh-connect-sensenova-token-plan/api-key")(request(), keyRes);
  check("the api-key route answers inside the container",
    keyRes.statusCode === 200 && keyRes.payload?.ok === true && keyRes.payload?.hasApiKey === false,
    JSON.stringify(keyRes.payload));

  const releasedBefore = llm.calls.released;
  await stop();
  check("disposing the fiber released the registered pair",
    llm.calls.released >= releasedBefore + 2, String(llm.calls.released));
  check("disposing withdrew the routes too", webServer.registered.size === 0,
    [...webServer.registered.keys()].join(", "));
}

// === F2. the opt-in off registers NOTHING, even with an llm service =======
{
  const de = adapterDeps();
  const { llm, stop } = await bootPlugin({ withLlm: true, config: {}, de });
  await settle();
  check("with registerProvider off no pair is registered",
    llm.calls.adapter === 0 && llm.calls.directory === 0 && de.builds.length === 0,
    JSON.stringify({ adapter: llm.calls.adapter, builds: de.builds.length }));
  await stop();
  check("off leaves nothing to release", llm.calls.released === 0, String(llm.calls.released));
}

// === F3. concurrent publishes queue instead of interleaving ==============
// A provider switch (or the first catalog poll) can publish while the mount
// seed's publish is still in flight. Unserialized, the SLOWER one wins: it
// releases the pair the faster one just registered and registers its own, so
// the Host serves one catalog while the snapshot reports another — the seed's
// empty list against a poll that just fetched models.
{
  const de = gatedAdapterDeps();
  const { webServer, llm, stop } = await bootPlugin({
    withLlm: true,
    config: { registerProvider: true },
    de
  });
  // Let the mount seed walk into its build and park there.
  await settle();
  check("the mount seed parked inside its first build", de.builds.length === 1,
    JSON.stringify({ builds: de.builds.length }));

  // A second publish on top of the parked one, not awaited yet: the provider
  // switch route re-publishes whatever the plugin is currently holding.
  const switching = webServer.registered.get("/api/dsh-connect-sensenova-token-plan/provider")(
    postRequest({ enabled: true }), response()
  );
  await settle();
  de.release();
  await switching;
  await settle();

  check("both publishes built an adapter", de.builds.length === 2,
    JSON.stringify({ builds: de.builds.length }));
  // The publish asked for LAST must be the one still registered. A seed that
  // merely resumed later must not overwrite the newer catalog with its own.
  check("the publish asked for last is the one registered",
    llm.calls.lastAdapter?.tag === 2,
    JSON.stringify({ tag: llm.calls.lastAdapter?.tag, ...llm.calls, builds: de.builds.length }));
  // Two registrations and one teardown between them: one pair left standing.
  check("exactly one pair is left registered",
    llm.calls.adapter === 2 && llm.calls.released === 2,
    JSON.stringify({ adapter: llm.calls.adapter, released: llm.calls.released }));

  const providerRes = response();
  await webServer.registered.get("/api/dsh-connect-sensenova-token-plan/provider")(request(), providerRes);
  check("the panel is told a provider is registered",
    providerRes.payload?.providerRegistered === true, JSON.stringify(providerRes.payload));

  await stop();
  check("disposing released the surviving pair",
    llm.calls.released === 4, JSON.stringify({ released: llm.calls.released }));
}

// === F4. the roster route answers through the real container seam =========
// Group B proves the route is REGISTERED and F3 proves publishing serialises;
// neither proves that the thing the panel reaches is the handler it expects.
// Drive one real request through the container's handler and check the effect
// reached the llm service.
{
  const de = adapterDeps();
  const { webServer, llm, stop } = await bootPlugin({
    withLlm: true,
    config: { registerProvider: true },
    de
  });
  await settle();
  // The switch lives in the shared state dir, so set it the way a panel would
  // rather than assuming the order of the other groups.
  const switchRes = response();
  await webServer.registered.get("/api/dsh-connect-sensenova-token-plan/provider")(
    postRequest({ enabled: true }), switchRes);
  check("the provider switch answers through the container",
    switchRes.statusCode === 200 && switchRes.payload?.ok === true,
    JSON.stringify(switchRes.payload));

  const res = response();
  await webServer.registered.get("/api/dsh-connect-sensenova-token-plan/models")(
    postRequest({ enabledModelIds: ["__hide_all__"] }), res);
  check("a roster save answers through the container",
    res.statusCode === 200 && res.payload?.ok === true &&
      JSON.stringify(res.payload?.enabledModelIds) === JSON.stringify(["__hide_all__"]),
    JSON.stringify(res.payload));
  const last = de.builds.at(-1);
  check("the roster save republished through the real llm service",
    last !== undefined
      && JSON.stringify(last.enabledIds) === JSON.stringify(["__hide_all__"])
      && llm.calls.adapter === de.builds.length,
    JSON.stringify({ builds: de.builds.length, last, calls: llm.calls }));

  await stop();
  check("disposing released every registration pair",
    llm.calls.released === llm.calls.adapter + llm.calls.directory, JSON.stringify(llm.calls));
}

// === F5. the Raccoon mount seed re-registers the provider on restart =====
// The Raccoon publisher's `state.rows` is in-memory only, so a fresh process
// starts with an EMPTY roster. The old seed gated on `state.rows.length > 0`
// and therefore never republished after a restart: the tab said "logged in"
// and listed models (its GET refetches the catalogue live), but the DSH
// model picker saw none. Pin the fixed behavior: a stored switch + a stored
// credential must register `sensenova-raccoon` again at mount, with no
// switch/login POST in between — the exact "restart" shape the user hit.
{
  // The switch file lives in the same `$DSH_HOME` the plugin reads
  // (`isolateStateDir` above points it at a scratch dir for this whole run).
  // profile is null in this container, so the shared dir is where the plugin
  // will look too.
  const raccoonSwitch = createFileRaccoonStore({});
  await raccoonSwitch.save(true);
  // A credential as the credentials service would hold it after a QR login.
  const credentials = makeCredentials();
  credentials.refs.set(RACCOON_CREDENTIAL_REF, serializeRaccoonCredential({
    accessToken: "seed-token",
    refreshToken: "seed-refresh",
    expiresAtMs: Date.now() + 3_600_000,
    nickname: "seed-nick"
  }));
  const webServer = makeWebServer();
  const llm = makeLlm();
  const ctx = new Context();
  ctx.provide("webServer", webServer);
  ctx.provide("credentials", credentials);
  ctx.provide("llm", llm);
  const host = await import(`../src/host/index.ts?wiring=${Math.random()}`);
  // The real raccoon adapter imports the llm peers; substitute a fake factory
  // like the other groups do for the Token Plan adapter, so the check stays
  // offline on a clean checkout.
  const raccoonDeps = {
    loadRaccoonAdapterModule: async () => ({
      createRaccoonAdapter: async (options) => ({
        adapter: { raccoonSeed: true },
        providerIds: [RACCOON_PROVIDER_ID]
      })
    })
  };
  // The mount seed (and the /raccoon GET) refetch the live catalogue and the
  // balance through `globalThis.fetch`. The network guard records-and-throws
  // rather than serving, so serve the two gateway routes here (the same fake
  // response shape the raccoon suite uses) and fall through to the guard for
  // anything else; restore the guard when the group is done.
  const guardFetch = globalThis.fetch;
  const fakeGatewayResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  });
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.includes("/api/web/llm/v2/model_catalog")) {
      return fakeGatewayResponse({ code: 0, data: { categories: [{ type: "chat", models: [{ id: "sn-live-1", name: "Live 1", visible: true }] }] } });
    }
    if (url.includes("/api/web/points/v1/balance")) {
      return fakeGatewayResponse({ code: 0, data: { balance: 300 } });
    }
    return guardFetch(input);
  };
  const plugin = { name: host.name, inject: host.inject, apply: (fiberCtx, row) => host.apply(fiberCtx, row, raccoonDeps) };
  const fiber = await ctx.plugin(plugin, {});
  // The mount seed crosses several awaits before it publishes; settle like F.
  await settle();
  check("the raccoon seed re-registers the provider at mount",
    llm.calls.adapter === 1 && llm.calls.lastIds?.[0] === RACCOON_PROVIDER_ID,
    JSON.stringify(llm.calls));
  // The panel route must agree: logged in, provider registered, models offered.
  const res = response();
  await webServer.registered.get("/api/dsh-connect-sensenova-token-plan/raccoon")(request(), res);
  check("the raccoon route confirms the provider is registered after restart",
    res.statusCode === 200 && res.payload?.ok === true && res.payload?.loggedIn === true
      && res.payload?.providerRegistered === true
      && Array.isArray(res.payload?.models) && res.payload.models.length > 0,
    JSON.stringify(res.payload).slice(0, 220));
  await fiber?.dispose?.();
  // Leave no switch behind for later groups (the file persists in the scratch
  // DSH_HOME; forgetting it makes the next boot read "not set" again).
  await raccoonSwitch.forget();
  globalThis.fetch = guardFetch;
}

// === F6. switch on + NO credential keeps the tab's "scan to log in" state =
// The seed publishes only when a credential survived the restart. Without one
// there is nothing to offer, so the publisher stays pristine — the tab keeps
// its designed "switch on — scan to log in" line instead of a raw
// `not_configured` error that the restart never earned.
{
  const raccoonSwitch = createFileRaccoonStore({});
  await raccoonSwitch.save(true);
  const webServer = makeWebServer();
  const llm = makeLlm();
  const ctx = new Context();
  ctx.provide("webServer", webServer);
  ctx.provide("credentials", makeCredentials()); // no RACCOON_CREDENTIAL ref
  ctx.provide("llm", llm);
  const host = await import(`../src/host/index.ts?wiring=${Math.random()}`);
  const raccoonDeps = {
    loadRaccoonAdapterModule: async () => ({
      createRaccoonAdapter: async () => ({ adapter: {}, providerIds: [RACCOON_PROVIDER_ID] })
    })
  };
  const plugin = { name: host.name, inject: host.inject, apply: (fiberCtx, row) => host.apply(fiberCtx, row, raccoonDeps) };
  const fiber = await ctx.plugin(plugin, {});
  await settle();
  check("no credential means no raccoon registration at mount",
    llm.calls.adapter === 0 && llm.calls.lastIds === undefined,
    JSON.stringify(llm.calls));
  await fiber?.dispose?.();
  await raccoonSwitch.forget();
}

// === F7. a transient seed failure retries instead of leaving the picker empty
// Raccoon has no poll to heal a missed registration (the Token Plan provider
// republishes on every catalogue poll). A transient failure at boot must
// therefore be retried: the fake adapter factory throws once, then succeeds,
// and the seed's bounded retry must still land the registration.
{
  const raccoonSwitch = createFileRaccoonStore({});
  await raccoonSwitch.save(true);
  const credentials = makeCredentials();
  credentials.refs.set(RACCOON_CREDENTIAL_REF, serializeRaccoonCredential({
    accessToken: "retry-token",
    refreshToken: "retry-refresh",
    expiresAtMs: Date.now() + 3_600_000,
    nickname: "retry-nick"
  }));
  const webServer = makeWebServer();
  const llm = makeLlm();
  const ctx = new Context();
  ctx.provide("webServer", webServer);
  ctx.provide("credentials", credentials);
  ctx.provide("llm", llm);
  const host = await import(`../src/host/index.ts?wiring=${Math.random()}`);
  // The seed refetches the catalogue through the guard; serve it like F5.
  const guardFetch = globalThis.fetch;
  const fakeGatewayResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  });
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (url.includes("/api/web/llm/v2/model_catalog")) {
      return fakeGatewayResponse({ code: 0, data: { categories: [{ type: "chat", models: [{ id: "sn-live-1", name: "Live 1", visible: true }] }] } });
    }
    return guardFetch(input);
  };
  let factoryCalls = 0;
  const raccoonDeps = {
    loadRaccoonAdapterModule: async () => ({
      createRaccoonAdapter: async () => {
        factoryCalls += 1;
        if (factoryCalls === 1) throw new Error("transient build failure");
        return { adapter: { retried: true }, providerIds: [RACCOON_PROVIDER_ID] };
      }
    })
  };
  const plugin = { name: host.name, inject: host.inject, apply: (fiberCtx, row) => host.apply(fiberCtx, row, raccoonDeps) };
  const fiber = await ctx.plugin(plugin, {});
  // The retry backoff is real time (300ms × attempt); wait it out.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await settle();
  check("a transient seed failure retries into a registration",
    factoryCalls === 2 && llm.calls.adapter === 1 && llm.calls.lastIds?.[0] === RACCOON_PROVIDER_ID,
    JSON.stringify({ factoryCalls, calls: llm.calls }));
  await fiber?.dispose?.();
  await raccoonSwitch.forget();
  globalThis.fetch = guardFetch;
}

// === F8. the mount-time effect registry (ADR-008) =======================
// Unmount is `drain(cap)` → `teardown`: a still-settling effect gets up to
// the cap to finish on its own; a straggler past the cap is named (the label
// in the warn is the guard's clue) and left to the disposed gates that
// already exist. The registry must also keep a REJECTING effect from
// becoming an unhandledRejection on the Host process.
{
  const { createEffectRegistry } = await import("../src/host/effects.ts");
  {
    const warns = [];
    const registry = createEffectRegistry({ warn: (message) => warns.push(message) });
    const pending = {};
    let released = false;
    pending.p = new Promise((resolve) => { released = resolve; });
    registry.add("fast", async () => "done");
    registry.add("hung", () => pending.p);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const stragglers = await registry.drain(500);
    check("a still-settling effect is reported by label when the cap hits",
      JSON.stringify(stragglers) === JSON.stringify(["hung"]), JSON.stringify(stragglers));
    check("a settled effect does not count as a straggler",
      JSON.stringify(registry.inFlight()) === JSON.stringify(["hung"]), JSON.stringify(registry.inFlight()));
    released("done");
    const after = await registry.drain(2000);
    check("after the straggler settles, a later drain finds nothing",
      after.length === 0 && JSON.stringify(registry.inFlight()) === "[]", JSON.stringify(after));
  }
  {
    const warns = [];
    const registry = createEffectRegistry({ warn: (message) => warns.push(message) });
    registry.add("rejecting", async () => { throw new Error("boom"); });
    registry.add("fast", async () => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    check("a rejecting effect is swallowed with a labeled warn, not an unhandledRejection",
      warns.length === 1 && warns[0].includes("rejecting") && warns[0].includes("boom"), JSON.stringify(warns));
    const stragglers = await registry.drain(500);
    check("a settled (rejected-or-resolved) effect is gone from the registry",
      stragglers.length === 0, JSON.stringify(stragglers));
  }
  {
    // The real Host context's `logger` may exist without a `warn` method:
    // the reject path must degrade to silence, and the effect must still be
    // swallowed and cleared (an unhandledRejection would kill this script).
    const registry = createEffectRegistry({});
    registry.add("silent-reject", async () => { throw new Error("x"); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stragglers = await registry.drain(200);
    check("a logger without `warn` degrades the reject path to silence, not a throw",
      stragglers.length === 0 && registry.inFlight().length === 0, JSON.stringify(stragglers));
  }
}

// === G. the wiring test itself stayed offline ===========================
const unstubbed = releaseNetworkGuard();
restoreHostEnv();
check("no check escaped its stub to the network", unstubbed.length === 0, unstubbed.join(", "));

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

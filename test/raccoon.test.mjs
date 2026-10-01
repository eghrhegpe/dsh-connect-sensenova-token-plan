/**
 * Unit checks for the Raccoon "second upstream provider" (ROADMAP §6.1) — the
 * PEER-FREE layers only:
 *
 * - `raccoon.ts`: the protocol half (QR-code generation, the QR login URL,
 *   the envelope parser, the JWT exp decode, the header map, the 6-model
 *   fallback roster, the two-state thinking mapping, and the refresh walk);
 * - `raccoon-store.ts`: the DSH-credentials reference store (save / forget /
 *   resolve / refresh write-back / the single-use refresh token is re-stored);
 * - `raccoon-models.ts`: roster → pi-ai descriptor mapping (vision bits, the
 *   headers, the `reasoning:false` decision, the context-window fallback);
 * - `raccoon-publish.ts`: the second, independent publisher (the switch-off /
 *   no-token / register path, the `disposed` gate, the rollback on failure);
 * - `raccoon-switch-store.ts`: the opt-in file-backed switch (atomic
 *   round-trip, version rejection, the legacy shared-dir inheritance);
 * - `qr.ts` (the client bundle's encoder): the v1–10/M capacity and the
 *   matrix's own invariants (finder squares, the dark module, the mask
 *   applied, the format bits), differential-tested against the upstream
 *   zero-dep reference as an ORACLE ONLY (it is never imported into the
 *   shipped code — `upstream/` stays outside the client graph).
 *
 * Nothing here imports a Host peer, so the decisions stay covered on a clean
 * checkout; the peer-dependent `raccoon-llm-adapter.ts` is exercised in
 * wiring/e2e instead.
 */
import {
  generateRaccoonQrCode,
  raccoonQrLoginUrl,
  parseRaccoonEnvelope,
  decodeRaccoonJwtExpMs,
  raccoonHeaders,
  RACCOON_FALLBACK_MODELS,
  raccoonThinkingExtraBody,
  refreshRaccoonCredential,
  pollRaccoonQrLogin,
  fetchRaccoonBalance,
  fetchRaccoonCatalog,
  RACCOON_QR_STATUS
} from "../src/host/raccoon.ts";
import {
  createRaccoonStore,
  parseRaccoonCredential,
  serializeRaccoonCredential,
  RACCOON_CREDENTIAL_REF
} from "../src/host/raccoon-store.ts";
import {
  RACCOON_PROVIDER_ID,
  RACCOON_DISPLAY_NAME,
  RACCOON_BASE_URL,
  raccoonRoster,
  raccoonToDescriptor,
  buildRaccoonDescriptors,
  raccoonRequestHeaders
} from "../src/host/raccoon-models.ts";
import { createRaccoonPublisher, raccoonSignature } from "../src/host/raccoon-publish.ts";
import { createFileRaccoonStore, normalizeRaccoonEnabled, RACCOON_SWITCH_VERSION } from "../src/host/raccoon-switch-store.ts";
import { installNetworkGuard } from "./peer-roots.mjs";
import { surface as clientSurface } from "./client-surface.js";

/** Installed before anything runs, so an unstubbed call cannot escape. */
const releaseNetworkGuard = installNetworkGuard();

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}
function section(title) {
  console.log(`\n— ${title}`);
}

// --- 1. protocol layer -------------------------------------------------------
{
  section("protocol layer (raccoon.ts)");
  try {
    // The scan code is a local 32-hex value: any self-made code the gateway
    // will hold `pending`, so generation must be random and well-formed.
    const code = generateRaccoonQrCode();
    check("the QR code is 32 lowercase hex characters", /^[0-9a-f]{32}$/.test(code), code);
    check("two generations differ (random, not a constant)",
      generateRaccoonQrCode() !== code);

    // The QR login URL is the gateway's public page, the code in it, the
    // Chinese app name percent-encoded (the scanner sees it, not raw CJK).
    const url = raccoonQrLoginUrl(code);
    check("the login URL carries the scan code", url.includes(`code=${code}`), url);
    check("the login URL names the app (encoded)", url.includes(encodeURIComponent("商汤小浣熊官网")), url);
    check("the login URL is on the gateway host", url.startsWith("https://xiaohuanxiong.com/login/mp?"));

    // The envelope: success is code===0 with the data object; a refusal keeps
    // the code/message so the panel can word it.
    const okEnvelope = parseRaccoonEnvelope({ code: 0, message: "ok", data: { access_token: "t" } }, 200);
    check("a zero envelope is success with data", okEnvelope.code === 0 && okEnvelope.data?.access_token === "t");
    const badEnvelope = parseRaccoonEnvelope({ code: 401, message: "authorization_verify_error", data: null }, 401);
    check("a non-zero envelope is a refusal (message + code kept)",
      badEnvelope.code === 401 && badEnvelope.message === "authorization_verify_error" && badEnvelope.data === null);
    check("an absent body degrades to a machine code -1",
      parseRaccoonEnvelope(null, 500).code === -1);

    // The JWT exp decode reads the payload without a signature check; a
    // malformed token reads as `undefined`, never an error.
    const expSeconds = Math.floor(Date.now() / 1000) + 3600;
    const b64url = (value) => Buffer.from(value).toString("base64url");
    const jwtPayload = b64url(JSON.stringify({ exp: expSeconds }));
    const jwt = `header.${jwtPayload}.sig`;
    check("the JWT exp is decoded to milliseconds",
      decodeRaccoonJwtExpMs(jwt) === expSeconds * 1000, String(decodeRaccoonJwtExpMs(jwt)));
    check("a non-JWT reads as undefined, not a throw",
      decodeRaccoonJwtExpMs("not a jwt") === undefined && decodeRaccoonJwtExpMs("") === undefined);

    // The header set: the Bearer token, an empty X-Org-Code for personal
    // accounts, the fixed language, and the optional client-identity headers.
    const headers = raccoonHeaders({ access_token: "tok", office_identity: "", device_id: "dev-1" }, { platform: "desktop-windows", version: "v1.0.35" });
    check("the auth header is a Bearer token", headers.Authorization === "Bearer tok");
    check("a personal account sends an empty X-Org-Code", headers["X-Org-Code"] === "");
    check("the language is pinned to zh", headers["X-Raccoon-Language"] === "zh");
    check("the optional client headers ride when given",
      headers["X-Client-Platform"] === "desktop-windows" && headers["X-Client-Version"] === "v1.0.35" && headers["X-Client-Device-ID"] === "dev-1");
    check("the content type is JSON", headers["Content-Type"] === "application/json");

    // Dual-shape regression: the panel routes hold the STORE's parsed
    // credential (camelCase, `parseRaccoonCredential`'s output) while the raw
    // document path stays snake_case. A camelCase object read through the
    // snake_case fields once produced `Authorization: Bearer ` (empty) and a
    // permanent gateway 401 — the token must reach the header from either
    // shape, with the raw field winning when both are present.
    const camelHeaders = raccoonHeaders({ accessToken: "tok-camel", officeIdentity: "" });
    check("a camelCase store credential reaches the Bearer header", camelHeaders.Authorization === "Bearer tok-camel");
    check("a camelCase office identity reaches X-Org-Code", camelHeaders["X-Org-Code"] === "");
    const bothShapes = raccoonHeaders({ access_token: "snake", accessToken: "camel", office_identity: "org-s", officeIdentity: "org-c" });
    check("when both shapes are present the raw snake_case field wins",
      bothShapes.Authorization === "Bearer snake" && bothShapes["X-Org-Code"] === "org-s");
    const camelDevice = raccoonHeaders({ accessToken: "t", deviceId: "dev-2" });
    check("a camelCase device id reaches the client header", camelDevice["X-Client-Device-ID"] === "dev-2");

    // The fallback roster: the six known models, in order, the two free ones
    // at multiplier 0, the rest priced.
    check("the fallback roster holds the six known models",
      RACCOON_FALLBACK_MODELS.length === 6, String(RACCOON_FALLBACK_MODELS.length));
    check("the two SenseNova flash models are free (multiplier 0)",
      RACCOON_FALLBACK_MODELS[0].multiplier === 0 && RACCOON_FALLBACK_MODELS[1].multiplier === 0);
    check("the roster is frozen (never mutated)", Object.isFrozen(RACCOON_FALLBACK_MODELS));

    // The two-state thinking mapping: off → disabled, anything else → enabled,
    // and `undefined` omits the field entirely (the server default = on).
    check("an absent thinking level sends no field", raccoonThinkingExtraBody(undefined) === undefined);
    check("'off' disables thinking", JSON.stringify(raccoonThinkingExtraBody("off")) === '{"thinking":{"type":"disabled"}}');
    check("anything else enables thinking", JSON.stringify(raccoonThinkingExtraBody("high")) === '{"thinking":{"type":"enabled"}}');
  } catch (error) {
    fail("protocol layer", error);
  }
}

// --- 2. the QR login walk (injected fetch) ----------------------------------
{
  section("QR login walk (pollRaccoonQrLogin / refresh)");
  // The protocol layer calls the injected fetch with (url, init) and reads
  // `response.status` / `response.ok` / `await response.json()` — the fake
  // must present that surface, not the bare `{ ok, status, json }` object.
  const fakeFetchResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  });
  const fakeFetcher = (body, status) => async () => fakeFetchResponse(body, status);
  try {
    // A success envelope: the token pair is returned, the exp decoded.
    const expSeconds = Math.floor(Date.now() / 1000) + 3600;
    const jwtPayload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
    const successBody = { code: 0, data: { status: "success", access_token: `header.${jwtPayload}.sig`, refresh_token: "rt-1", nickname: "nick" } };
    const success = await pollRaccoonQrLogin("code", fakeFetcher(successBody));
    check("a success poll returns the token pair", success.status === RACCOON_QR_STATUS.SUCCESS && success.accessToken.length > 0 && success.refreshToken === "rt-1");
    check("the success poll decodes the expiry", success.expiresAtMs === expSeconds * 1000);

    // A pending status: nothing yet.
    const pending = await pollRaccoonQrLogin("code", fakeFetcher({ code: 0, data: { status: "pending" } }));
    check("a pending poll stays pending", pending.status === RACCOON_QR_STATUS.PENDING && pending.accessToken === undefined);

    // A canceled scan: the flow stops.
    const canceled = await pollRaccoonQrLogin("code", fakeFetcher({ code: 0, data: { status: "canceled" } }));
    check("a canceled poll reports canceled", canceled.status === RACCOON_QR_STATUS.CANCELED);

    // A network anomaly degrades to pending (never to success/canceled): the
    // caller keeps polling at its own cadence.
    const erroring = await pollRaccoonQrLogin("code", async () => {
      throw new Error("the gateway did not answer");
    });
    check("an errored poll degrades to pending", erroring.status === RACCOON_QR_STATUS.PENDING);

    // A success without a token is "not done yet": it stays pending.
    const tokenless = await pollRaccoonQrLogin("code", fakeFetcher({ code: 0, data: { status: "success", access_token: "" } }));
    check("a tokenless success stays pending", tokenless.status === RACCOON_QR_STATUS.PENDING);

    // The refresh walk: the NEW pair comes back (the refresh token is
    // single-use, so the caller MUST re-store this — that write-back is the
    // store's job, pinned next). A dead refresh token is a refusal.
    const rotated = await refreshRaccoonCredential({ refresh_token: "rt-1" },
      fakeFetcher({ code: 0, data: { access_token: "new-access", refresh_token: "rt-2" } }));
    check("a refresh returns the rotated pair", rotated.ok === true && rotated.accessToken === "new-access" && rotated.refreshToken === "rt-2");
    check("a missing refresh token refuses without a network call",
      (await refreshRaccoonCredential({}, async () => {
        throw new Error("must not be called");
      })).ok === false);
    check("a dead refresh token (401) is a session_dead refusal",
      (await refreshRaccoonCredential({ refresh_token: "rt-1" },
        fakeFetcher({ code: 401, message: "authorization_verify_error", data: null }, 401))).ok === false);
  } catch (error) {
    fail("QR login walk", error);
  }
}

// --- 3. the balance / catalog reads ----------------------------------------
{
  section("balance + catalog reads");
  const fakeFetcher = (body, status = 200) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  });
  try {
    const read = await fetchRaccoonBalance({ access_token: "t" }, fakeFetcher({ code: 0, data: { balance: 300 } }));
    check("the balance total is the gateway figure", read !== null && read.total === 300, JSON.stringify(read));
    check("a zero balance is a valid figure, not null",
      ((await fetchRaccoonBalance({ access_token: "t" }, fakeFetcher({ code: 0, data: { balance: 0 } })))).total === 0);
    check("an unreadable balance is null, not a throw",
      (await fetchRaccoonBalance({ access_token: "t" }, async () => {
        throw new Error("network down");
      })) === null);
    // The gateway's own split of the total: a part is carried when declared
    // (even a zero — a fact), and the total still reads from the legacy
    // `available_points` alias chain.
    const split = await fetchRaccoonBalance({ access_token: "t" },
      fakeFetcher({ code: 0, data: { available_points: 10129, daily_points: 1129, reward_points: 9000, monthly_points: 0, topup_points: 0 } }));
    check("the balance split carries the declared parts",
      split.total === 10129 && split.daily === 1129 && split.reward === 9000 && split.monthly === 0 && split.topup === 0, JSON.stringify(split));
    const noSplit = await fetchRaccoonBalance({ access_token: "t" }, fakeFetcher({ code: 0, data: { balance: 300 } }));
    check("undeclared parts stay absent, not zero-filled",
      noSplit.total === 300 && noSplit.daily === undefined && noSplit.reward === undefined && noSplit.monthly === undefined && noSplit.topup === undefined, JSON.stringify(noSplit));

    // The catalog: the chat category's visible models, normalized to the row
    // shape the adapter consumes. A missing/failed read is null → fallback.
    const catalog = await fetchRaccoonCatalog({ access_token: "t" }, fakeFetcher({ code: 0, data: { categories: [{ type: "chat", models: [
      { id: "m1", name: "Model 1", multiplier: 0.5, vision: true, context_window: 200_000, max_output_tokens: 8_000 },
      { id: "m2", name: "Model 2", visible: false, input_modalities: ["image"] }
    ] }] } }));
    check("the catalog keeps only the visible chat models", catalog?.length === 1 && catalog?.[0]?.id === "m1", JSON.stringify(catalog));
    check("a catalog row carries its multiplier + vision + window",
      catalog?.[0]?.multiplier === 0.5 && catalog?.[0]?.vision === true && catalog?.[0]?.contextWindow === 200_000);
    check("a failed catalog read is null (the fallback roster takes over)",
      (await fetchRaccoonCatalog({ access_token: "t" }, async () => {
        throw new Error("down");
      })) === null);

    // The store-shape regression, pinned at the function level: the panel
    // routes resolve the credential through `raccoonStore` (camelCase) and
    // hand THAT object to these reads. The Authorization the gateway
    // receives must be the real Bearer token — not `Bearer ` (the empty read
    // that made the panel 401 while every fresh-process probe passed).
    const seen = [];
    const captureFetcher = async (url, init) => {
      seen.push({ url, headers: init?.headers ?? {} });
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { available_points: 1129, daily_points: 1129, categories: [] } }) };
    };
    const camelCred = { accessToken: "store-token", refreshToken: "rt", officeIdentity: "" };
    check("the balance read sends the Bearer token from a camelCase credential",
      ((await fetchRaccoonBalance(camelCred, captureFetcher))).total === 1129 &&
      seen[0]?.headers?.Authorization === "Bearer store-token");
    check("the catalog read sends the Bearer token from a camelCase credential",
      (await fetchRaccoonCatalog(camelCred, captureFetcher)) === null &&
      seen[1]?.url?.includes("/model_catalog") && seen[1]?.headers?.Authorization === "Bearer store-token");
    check("the org code rides from the camelCase office identity",
      seen[0]?.headers?.["X-Org-Code"] === "" &&
      (await (async () => {
        const seenOrg = [];
        await fetchRaccoonBalance({ accessToken: "t", officeIdentity: "org-7" }, async (url, init) => {
          seenOrg.push(init?.headers ?? {});
          return { ok: true, status: 200, json: async () => ({ code: 0, data: { balance: 1 } }) };
        });
        return seenOrg[0]?.["X-Org-Code"] === "org-7";
      })()));
  } catch (error) {
    fail("balance + catalog", error);
  }
}

// --- 4. the credential store ------------------------------------------------
{
  section("the DSH-credentials reference store");
  const fakeResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  try {
    // A fake credentials service: the shape the Host actually presents
    // (`resolve` / `set` / `unset`), recorded so the write-backs are checked.
    const records = new Map();
    const service = {
      async resolve(ref) {
        const value = records.get(ref);
        return typeof value === "string" ? { value, source: "credentials" } : undefined;
      },
      async set(ref, value) {
        records.set(ref, value);
      },
      async unset(ref) {
        records.delete(ref);
      }
    };

    // serialize/parse are inverses: a round-trip is a no-op, and the
    // refresh token + office identity + nickname ride along.
    const serialized = serializeRaccoonCredential({ accessToken: "a", refreshToken: "r", expiresAtMs: 1234, officeIdentity: "personal", nickname: "nick" });
    const parsed = parseRaccoonCredential(serialized);
    check("a serialized credential round-trips", parsed.accessToken === "a" && parsed.refreshToken === "r" && parsed.expiresAtMs === 1234 && parsed.officeIdentity === "personal" && parsed.nickname === "nick");
    check("a malformed value reads as no credential, not an error", parseRaccoonCredential("{ not json") === null && parseRaccoonCredential("") === null);

    // save → resolve: the pair lands under the named reference.
    const store = createRaccoonStore({ credentials: service, fetcher: async () => fakeResponse({ code: 0, data: { access_token: "a", refresh_token: "r" } }) });
    await store.save({ accessToken: "a", refreshToken: "r", officeIdentity: "personal", nickname: "nick" });
    check("a saved credential resolves with its source", (await store.resolve()).credential?.accessToken === "a" && (await store.resolve()).source === "credentials");
    check("the saved credential round-trips through the service", parseRaccoonCredential(records.get(RACCOON_CREDENTIAL_REF))?.accessToken === "a");

    // save without a token refuses (the panel would be signing in with an
    // empty credential).
    let refused = false;
    try {
      await store.save({ accessToken: "" });
    } catch {
      refused = true;
    }
    check("an empty access token refuses to save", refused === true);

    // The refresh write-back: the SINGLE-USE refresh token is rotated, so the
    // new pair is RE-STORED under the same reference. This is the load-bearing
    // difference from the desktop-file route (which kept the old refresh token
    // and 401-looped).
    const refreshService = new Map(records);
    const refreshStore = createRaccoonStore({
      credentials: {
        async resolve(ref) {
          const value = refreshService.get(ref);
          return typeof value === "string" ? { value, source: "credentials" } : undefined;
        },
        async set(ref, value) {
          refreshService.set(ref, value);
        },
        async unset(ref) {
          refreshService.delete(ref);
        }
      },
      fetcher: async () => fakeResponse({ code: 0, data: { access_token: "new-a", refresh_token: "new-r" } })
    });
    await refreshStore.save({ accessToken: "a", refreshToken: "r" });
    const refreshed = await refreshStore.refresh();
    check("a refresh re-stores the ROTATED pair", refreshed.ok === true && parseRaccoonCredential(refreshService.get(RACCOON_CREDENTIAL_REF))?.accessToken === "new-a" && parseRaccoonCredential(refreshService.get(RACCOON_CREDENTIAL_REF))?.refreshToken === "new-r");

    // A dead refresh token: the refusal propagates, the OLD pair is kept (the
    // credential is still usable until it expires), and the state still reads
    // "configured".
    const deadStore = createRaccoonStore({
      credentials: service,
      fetcher: async () => fakeResponse({ code: 401, message: "dead", data: null }, 401)
    });
    await deadStore.save({ accessToken: "a", refreshToken: "r" });
    const deadResult = await deadStore.refresh();
    check("a dead refresh token refuses without clobbering the stored pair",
      deadResult.ok === false && parseRaccoonCredential(records.get(RACCOON_CREDENTIAL_REF))?.refreshToken === "r");

    // forget clears both the durable reference and the memory copy.
    await store.forget();
    check("a forget clears the durable reference", records.get(RACCOON_CREDENTIAL_REF) === undefined && (await store.resolve()).credential === null);

    // The ephemeral shape: no credentials service → memory only, and
    // `ephemeral` is the panel's "re-login after a restart" warning.
    const ephemeral = createRaccoonStore({ credentials: null });
    await ephemeral.save({ accessToken: "mem" });
    check("a Host without a credentials service is ephemeral", (await ephemeral.state()).ephemeral === true && (await ephemeral.state()).hasCredential === true);

    // state() names the refresh window too: the panel's "how long until I
    // must re-scan" fact. A real JWT `exp` is decoded; an absent refresh
    // token leaves the field out, never null-fills it.
    const jwtExp = Math.floor(Date.now() / 1000) + 86_400 * 30;
    const jwtRefresh = `h.${Buffer.from(JSON.stringify({ exp: jwtExp })).toString("base64url")}.s`;
    const refreshWindow = createRaccoonStore({ credentials: null });
    await refreshWindow.save({ accessToken: "mem-a", refreshToken: jwtRefresh });
    check("state() reports the refresh token's window",
      (await refreshWindow.state()).refreshExpiresAtMs === jwtExp * 1000);
    const noRefresh = createRaccoonStore({ credentials: null });
    await noRefresh.save({ accessToken: "mem-only" });
    check("state() omits refreshExpiresAtMs when no refresh token is stored",
      (await noRefresh.state()).refreshExpiresAtMs === undefined);
  } catch (error) {
    fail("credential store", error);
  }
}

// --- 5. the descriptor mapping (raccoon-models.ts) --------------------------
{
  section("the roster → pi-ai descriptor mapping");
  try {
    check("the provider id is the own collision-free slug", RACCOON_PROVIDER_ID === "sensenova-raccoon");
    check("the display name is set", RACCOON_DISPLAY_NAME === "SenseNova Raccoon");
    check("the base URL points at the Raccoon LLM prefix", RACCOON_BASE_URL === "https://xiaohuanxiong.com/api/web/llm/v2");

    // The roster: a live catalogue beats the fallback; an absent one falls
    // back. The rows keep only the fields the picker and panel need.
    const live = raccoonRoster([{ id: "x", name: "X", vision: true, multiplier: 0.3 }]);
    check("a live catalogue row wins over the fallback", live.length === 1 && live[0].id === "x" && live[0].vision === true && live[0].multiplier === 0.3);
    check("an absent catalogue falls back to the six known models",
      raccoonRoster(null).length === 6 && raccoonRoster([]).length === 6);

    // The descriptor: vision → ["text","image"]; the headers ride; the
    // context window has a positive fallback; reasoning is pinned false (the
    // v1 limitation, stated in the module header).
    const descriptor = raccoonToDescriptor({ id: "m1", name: "M1", vision: true, contextWindow: 100_000, maxOutputLength: 8_000 }, { officeIdentity: "personal" });
    check("a vision model offers text + image input", JSON.stringify(descriptor.input) === JSON.stringify(["text", "image"]));
    check("a text model offers text only", JSON.stringify(raccoonToDescriptor({ id: "m2", vision: false }).input) === JSON.stringify(["text"]));
    check("the descriptor carries the Raccoon request headers",
      descriptor.headers["X-Org-Code"] === "personal" && descriptor.headers["X-Raccoon-Language"] === "zh" && descriptor.headers["Content-Type"] === "application/json");
    check("the declared context window is honored", descriptor.contextWindow === 100_000);
    check("a missing window falls back to a positive default", raccoonToDescriptor({ id: "m3" }).contextWindow > 0);
    check("the declared output ceiling is honored as maxTokens", descriptor.maxTokens === 8_000);
    check("v1 pins reasoning:false (no thinking toggle)", descriptor.reasoning === false);
    check("the OpenAI-compat field is pinned to max_tokens", descriptor.compat?.maxTokensField === "max_tokens");
    check("the descriptor is tagged with the Raccoon provider", descriptor.provider === RACCOON_PROVIDER_ID && descriptor.api === "openai-completions");

    // The credit multiplier rides in the DISPLAY NAME: pi-ai has no channel
    // for billing metadata (its `cost` is per-token USD), and the model
    // picker renders only the name — so a priced model shows "（×0.75）",
    // a free one "（free）", and multiplier 1 stays bare.
    check("a priced model's name carries its multiplier suffix",
      raccoonToDescriptor({ id: "p1", name: "P1", multiplier: 0.75 }).name === "P1（×0.75）");
    check("a free model's name says free",
      raccoonToDescriptor({ id: "p2", name: "P2", multiplier: 0 }).name === "P2（free）");
    check("multiplier 1 adds no suffix", raccoonToDescriptor({ id: "p3", name: "P3", multiplier: 1 }).name === "P3");
    check("a missing multiplier adds no suffix", raccoonToDescriptor({ id: "p4", name: "P4" }).name === "P4");

    // buildRaccoonDescriptors dedupes by id (first occurrence wins): a live
    // catalogue that ever lists the same model twice must not register the
    // adapter with two rows under one id.
    const list = buildRaccoonDescriptors([{ id: "a", name: "A1" }, { id: "a", name: "A2" }, { id: "b" }], {});
    check("duplicate ids keep the FIRST occurrence",
      list.length === 2 && list[0].id === "a" && list[0].name === "A1" && list[1].id === "b");

    // The request-header helper, in isolation.
    const headers = raccoonRequestHeaders("org-1");
    check("the request headers carry the org code + language", headers["X-Org-Code"] === "org-1" && headers["X-Raccoon-Language"] === "zh");
  } catch (error) {
    fail("descriptor mapping", error);
  }
}

// --- 6. the second, independent publisher (raccoon-publish.ts) --------------
{
  section("the Raccoon publisher (a second, independent registration)");
  try {
    // A fake llm service that records every registerAdapter/release call.
    const makeLlm = () => {
      const calls = { register: [], release: [], releaseFn: null };
      return {
        calls,
        registerAdapter(ids, adapter) {
          calls.register.push({ ids, adapter });
          calls.releaseFn = () => {
            calls.release.push(ids);
          };
          return calls.releaseFn;
        },
        registerConfigurableProviders() {
          return () => {};
        }
      };
    };

    // The switch OFF (the opt-in default) releases everything: no provider is
    // registered, no error, `skipped` true.
    {
      const llm = makeLlm();
      const publisher = createRaccoonPublisher({
        panelSwitch: async () => false,
        resolveToken: async () => "a-token",
        getLlm: () => llm,
        loadAdapterModule: async () => ({
          createRaccoonAdapter: async () => ({ adapter: {}, providerIds: [RACCOON_PROVIDER_ID] })
        })
      });
      const result = await publisher.publish([{ id: "a" }], "");
      check("the switch OFF releases with no registration", result.ok === true && result.skipped === true && publisher.state.registered === false && llm.calls.register.length === 0);
    }

    // The switch ON but NO token: the offer must not exist, and the reason is
    // the clean `not_configured` (the panel's "log in first" affordance).
    {
      const llm = makeLlm();
      const publisher = createRaccoonPublisher({
        panelSwitch: async () => true,
        resolveToken: async () => "",
        getLlm: () => llm,
        loadAdapterModule: async () => ({
          createRaccoonAdapter: async () => {
            throw new Error("must not build without a token");
          }
        })
      });
      const result = await publisher.publish([{ id: "a" }], "");
      check("switch ON + no token releases with not_configured", result.ok === true && result.skipped === true && publisher.state.registered === false && publisher.state.error === "not_configured");
    }

    // The switch ON + a token: the roster is built and registered; the
    // officeIdentity rides to the factory.
    {
      const llm = makeLlm();
      let factorySaw;
      const publisher = createRaccoonPublisher({
        panelSwitch: async () => true,
        resolveToken: async () => "a-token",
        getLlm: () => llm,
        loadAdapterModule: async () => ({
          createRaccoonAdapter: async (options) => {
            factorySaw = options;
            return { adapter: { marker: true }, providerIds: [RACCOON_PROVIDER_ID] };
          }
        })
      });
      const result = await publisher.publish([{ id: "a", vision: true }, { id: "b" }], "org-9");
      check("switch ON + a token registers the roster", result.ok === true && publisher.state.registered === true && llm.calls.register.length === 1 && llm.calls.register[0].ids[0] === RACCOON_PROVIDER_ID);
      check("the factory saw the roster + office identity", factorySaw.rows.length === 2 && factorySaw.officeIdentity === "org-9" && typeof factorySaw.resolveToken === "function");
    }

    // The `disposed` gate: a publish after dispose is a no-op that registers
    // nothing.
    {
      const llm = makeLlm();
      const publisher = createRaccoonPublisher({
        panelSwitch: async () => true,
        resolveToken: async () => "a-token",
        getLlm: () => llm,
        loadAdapterModule: async () => ({
          createRaccoonAdapter: async () => ({ adapter: {}, providerIds: [RACCOON_PROVIDER_ID] })
        })
      });
      publisher.dispose();
      const result = await publisher.publish([{ id: "a" }], "");
      check("a publish after dispose registers nothing", result.ok === false && result.skipped === true && llm.calls.register.length === 0);
    }

    // The offered-set signature: the ids + vision bits, so a modality flip
    // triggers a rebuild even when the id list did not change.
    check("the signature tags each id with its vision bit",
      raccoonSignature([{ id: "a", vision: true }, { id: "b", vision: false }]) === "a:1,b:0");
    check("an empty roster has an empty signature", raccoonSignature([]) === "" && raccoonSignature(null) === "");
  } catch (error) {
    fail("raccoon publisher", error);
  }
}

// --- 7. the QR encoder (client bundle, decoder-verified) --------------------
{
  section("the in-panel QR encoder (client-side)");
  try {
    const { buildQrMatrix, qrDataUrl } = clientSurface.qr;
    check("the client surface exposes the QR encoder", typeof buildQrMatrix === "function" && typeof qrDataUrl === "function");

    // The login URL is ~144 bytes: it must fit a v1–10/M matrix and render a
    // valid-looking square with the finder squares dark.
    const payload = raccoonQrLoginUrl(generateRaccoonQrCode());
    const matrix = buildQrMatrix(payload);
    check("the login URL encodes to a square matrix", matrix.size === matrix.modules.length && matrix.size % 4 === 1, `size ${matrix.size}`);
    check("a ~144-byte payload lands in the v1–10 range", matrix.size >= 21 && matrix.size <= 57, String(matrix.size));
    // The three finder squares' top-left cells are dark (a square's outer
    // ring is always dark at its corner).
    check("the top-left finder's corner is dark", matrix.modules[0]?.[0] === true);
    check("the top-right finder's corner is dark", matrix.modules[0]?.[matrix.size - 1] === true);
    check("the bottom-left finder's corner is dark", matrix.modules[matrix.size - 1]?.[0] === true);

    // A payload beyond the v1–10/M capacity must THROW, not emit a
    // unscannable code.
    let threw = false;
    try {
      buildQrMatrix("x".repeat(400));
    } catch {
      threw = true;
    }
    check("an over-capacity payload throws (no unscannable code)", threw === true);

    // Ground truth: structural assertions cannot tell a scannable code from
    // an ISO-shaped one — the first draft of this encoder passed all of the
    // checks above while producing matrices NO decoder could read (timing
    // drawn over finders, mask 5 collapsed onto 6, transposed format strips,
    // data placed over the format/version reservations). The real contract is
    // "a decoder reads it back", so decode every version through jsQR, a
    // pure-JS decoder the tab's users effectively run in reverse. It is a
    // devDependency-free dynamic import: the check skips with a note when the
    // package is absent (an air-gapped checkout still runs the rest).
    let jsQR = null;
    try {
      ({ default: jsQR } = await import("jsqr"));
    } catch {
      console.log("  note: jsqr is not installed; the decode-verification checks are skipped");
    }
    if (jsQR !== null) {
      // Render the matrix to a raw RGBA raster (dark modules black on white,
      // 10× scale, a 4-module quiet zone — what a camera would see).
      const renderRgba = (m, scale = 10, quiet = 4) => {
        const dim = (m.size + quiet * 2) * scale;
        const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
        for (let r = 0; r < m.size; r++) {
          for (let c = 0; c < m.size; c++) {
            if (!m.modules[r][c]) continue;
            for (let dy = 0; dy < scale; dy++) {
              for (let dx = 0; dx < scale; dx++) {
                const i = (((r + quiet) * scale + dy) * dim + (c + quiet) * scale + dx) * 4;
                data[i] = data[i + 1] = data[i + 2] = 0;
              }
            }
          }
        }
        return { dim, data };
      };
      const decodesTo = (text) => {
        const { dim, data } = renderRgba(buildQrMatrix(text));
        const result = jsQR(data, dim, dim, { inversionAttempts: "dontInvert" });
        return result !== null && result.data === text;
      };
      // One probe per version (byte lengths that pin v1–v10 in both encoders
      // and the reference capacity table), plus the real login URL — the
      // payload this encoder exists for, which lands in v8 where the first
      // draft's alignment-collapse bug lived.
      const probes = [["v1", 12], ["v2", 22], ["v3", 36], ["v4", 54], ["v5", 72], ["v6", 90], ["v7", 108], ["v8", 130], ["v9", 158], ["v10", 190]];
      for (const [label, len] of probes) {
        const text = "a".repeat(len);
        check(`jsQR decodes a ${label} matrix back to its payload`, decodesTo(text));
      }
      check("jsQR decodes a REAL login URL back to itself", decodesTo(payload));
    }

    // The SVG data-URL: the tab drops it straight into an <img>. It carries
    // the white background and the dark-module path. The URL is percent-encoded,
    // so the size attribute appears as `width%3D%22208%22`, not `width="208"`.
    const url = qrDataUrl(payload, { size: 208 });
    check("the data-URL is an SVG image", url.startsWith("data:image/svg+xml"));
    check("the SVG declares its rendered size", url.includes("width%3D%22208%22") && url.includes("height%3D%22208%22"));
  } catch (error) {
    fail("QR encoder", error);
  }
}

// --- 8. the opt-in file-backed switch (raccoon-switch-store.ts) -------------
{
  section("the Raccoon provider switch store");
  try {
    // normalizeRaccoonEnabled: only booleans are real answers, anything else
    // (including `null`/`"true"`/a versioned payload) reads as "not set".
    check("a boolean normalizes to itself", normalizeRaccoonEnabled(true) === true && normalizeRaccoonEnabled(false) === false);
    check("a non-boolean reads as not set", normalizeRaccoonEnabled(null) === null && normalizeRaccoonEnabled("true") === null && normalizeRaccoonEnabled({ enabled: true }) === null);

    // The file-backed store: an atomic save/forget round-trip, the version
    // mismatch reads as "not set" (a downgraded or corrupt file can never
    // silently flip the switch), and a profile-scoped dir is respected.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "raccoon-switch-"));
    const store = createFileRaccoonStore({ dir });
    check("an untouched store reads as not set (the config default rules)", (await store.enabled()) === null && (await store.isSet()) === false);
    await store.save(true);
    check("a saved value round-trips through the file", (await store.enabled()) === true && (await store.isSet()) === true);
    await store.save(false);
    check("a flipped value overwrites the file", (await store.enabled()) === false);
    await store.forget();
    check("a forget returns to not set", (await store.enabled()) === null);
    // A non-boolean save refuses (the route only ever posts a boolean; a
    // hand-crafted write must not silently plant a value).
    let refused = false;
    try {
      await store.save("yes");
    } catch {
      refused = true;
    }
    check("a non-boolean save refuses", refused === true);
    // A version-mismatched payload reads as not set (a downgraded file must
    // not flip the switch), and a well-formed versioned payload reads its
    // value. These are ON-DISK parse checks; the store above already proved
    // the save/forget/round-trip half.
    const { writeFileSync } = await import("node:fs");
    const file = join(dir, "raccoon-provider.json");
    writeFileSync(file, JSON.stringify({ version: 999, enabled: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const mismatchedStore = createFileRaccoonStore({ dir, ttlMs: 20 });
    const mismatchedRead = await mismatchedStore.enabled();
    check("a mismatched version reads as not set", mismatchedRead === null, String(mismatchedRead));
    writeFileSync(file, JSON.stringify({ version: RACCOON_SWITCH_VERSION, enabled: true, updatedAt: new Date().toISOString() }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const wellFormedStore = createFileRaccoonStore({ dir, ttlMs: 20 });
    const wellFormedRead = await wellFormedStore.enabled();
    check("a well-formed versioned payload reads its value", wellFormedRead === true, String(wellFormedRead));
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    fail("switch store", error);
  }
}

// --- report ------------------------------------------------------------------
releaseNetworkGuard();
const passed = results.filter((result) => result.pass).length;
const failed = results.filter((result) => !result.pass);
for (const result of failed) {
  console.error(`  FAIL  ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
}
console.log(`\nraccoon.test.mjs: ${passed}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;

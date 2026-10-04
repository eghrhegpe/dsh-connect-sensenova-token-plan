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
  extractRaccoonNickname,
  raccoonHeaders,
  RACCOON_FALLBACK_MODELS,
  raccoonThinkingExtraBody,
  refreshRaccoonCredential,
  pollRaccoonQrLogin,
  fetchRaccoonBalance,
  fetchRaccoonCatalog,
  RACCOON_QR_STATUS,
  RACCOON_CODE,
  isDeadRaccoonSession,
  isDeadRaccoonEnvelope
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
import { createRaccoonWalk, LOGIN_STATUS } from "../src/host/raccoon-walk.ts";
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
    // The nickname extraction: flat field, nested object, JWT claim, then "".
    // The success envelope was never probed for the nickname (the token pair
    // was the only recorded read), so the extractor is defensive across the
    // plausible spellings and the caller logs the envelope's field names —
    // the next real scan settles which shape the gateway actually speaks.
    check("the success poll extracts a flat nickname", success.nickname === "nick", String(success.nickname));
    check("the success poll reports the envelope field names (names only)",
      Array.isArray(success.dataFields) && success.dataFields.includes("access_token") && success.dataFields.includes("nickname")
        && success.dataFields.every((field) => typeof field === "string"),
      JSON.stringify(success.dataFields));
    const namelessJwt = Buffer.from(JSON.stringify({ exp: expSeconds, preferred_username: "130****1100" })).toString("base64url");
    check("the nickname falls back to a JWT claim",
      extractRaccoonNickname({ status: "success" }, `header.${namelessJwt}.sig`) === "130****1100");
    check("a nested user object carries the nickname too",
      extractRaccoonNickname({ user: { nickname: "小浣熊" } }, "") === "小浣熊");
    check("a payload with no name reads as an empty nickname, not an error",
      extractRaccoonNickname({ status: "success" }, `header.${jwtPayload}.sig`) === ""
        && extractRaccoonNickname(null, "not a jwt") === "");

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
      })).code === RACCOON_CODE.NO_REFRESH_TOKEN);
    // The check below used to assert only `.ok === false` while its NAME claimed
    // `session_dead` — so the classification could have been deleted outright and
    // the suite stayed green. Asserting the code is what makes the name true.
    check("a dead refresh token (401) is a session_dead refusal",
      (await refreshRaccoonCredential({ refresh_token: "rt-1" },
        fakeFetcher({ code: 401, message: "authorization_verify_error", data: null }, 401))).code === RACCOON_CODE.SESSION_DEAD);
    // The gateway also says "dead" with an envelope code under an HTTP 200, so
    // both numbers must map to the same classification — the ternary this
    // replaced had them as two bare literals.
    check("an envelope 200003 under HTTP 200 is the same dead-session refusal",
      (await refreshRaccoonCredential({ refresh_token: "rt-1" },
        fakeFetcher({ code: 200003, message: "token invalid", data: null }, 200))).code === RACCOON_CODE.SESSION_DEAD);
    // ...and a refusal that is NOT one of those two must stay retryable, or the
    // plugin would write off a login that a later attempt could still recover.
    check("an unrecognized refusal stays retryable rather than dead",
      (await refreshRaccoonCredential({ refresh_token: "rt-1" },
        fakeFetcher({ code: 500, message: "server busy", data: null }, 500))).code === RACCOON_CODE.REFRESH_REJECTED);
    // The two halves of the classification, pinned so they cannot drift:
    // the gateway numbering (wire fact) and our label (panel fact).
    check("isDeadRaccoonEnvelope reads the gateway numbering",
      isDeadRaccoonEnvelope(401) === true && isDeadRaccoonEnvelope(200003) === true
      && isDeadRaccoonEnvelope(500) === false && isDeadRaccoonEnvelope("401") === false);
    check("isDeadRaccoonSession reads our label, and only that one",
      isDeadRaccoonSession(RACCOON_CODE.SESSION_DEAD) === true
      && isDeadRaccoonSession(RACCOON_CODE.REFRESH_REJECTED) === false
      && isDeadRaccoonSession(RACCOON_CODE.REFRESH_FAILED) === false
      && isDeadRaccoonSession(undefined) === false);
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
    // The catalogue row shape the gateway sends TODAY (v2): the id is
    // `model_name`, the ability lives in `tags`, the windows live in `params`,
    // and the multiplier is `billing_multiplier`. The older shape (`id` /
    // `vision` / `input_modalities` / `context_window` / `max_output_tokens`)
    // is kept as a defensive ladder and pinned by the legacy block below.
    const catalog = await fetchRaccoonCatalog({ access_token: "t" }, fakeFetcher({ code: 0, data: { categories: [{ type: "chat", models: [
      { model_name: "sn-model-1", name: "sn-model-1", visible: true, billing_multiplier: 0.5, tags: ["general", "vision"], params: { context_window: 200_000, max_tokens: 8_000 } },
      { model_name: "sn-deepseek-v4-1-flash", name: "sn-deepseek-v4-1-flash", visible: true, billing_multiplier: 0.25, tags: ["general", "code"], params: { context_window: 1_000_000, max_tokens: 100_000 } },
      { model_name: "sn-promo-free", name: "sn-promo-free", visible: true, billing_multiplier: 0.5, billing_effective_multiplier: 0, billing_status: "limited_free", billing_status_note: "免费至10月31日", tags: ["vision"], params: { context_window: 256_000, max_tokens: 63_999 } },
      { model_name: "sn-promo-disc", name: "sn-promo-disc", visible: true, billing_multiplier: 1, billing_effective_multiplier: 0.75, billing_status: "discount", billing_status_note: "会员日", tags: ["general"] },
      { model_name: "sn-plain", name: "sn-plain", visible: true, billing_multiplier: 0.3, billing_status: "normal" },
      { model_name: "sn-noeff", name: "sn-noeff", visible: true, billing_multiplier: 0.4, billing_status: "limited_free" },
      { model_name: "m2", name: "Model 2", visible: false, input_modalities: ["image"] }
    ] }] } }));
    check("the catalog keeps only the visible chat models",
      catalog?.length === 6 && catalog?.[0]?.id === "sn-model-1" && catalog?.[1]?.id === "sn-deepseek-v4-1-flash", JSON.stringify(catalog));
    check("a catalog row carries its multiplier + vision + window (v2 fields)",
      catalog?.[0]?.multiplier === 0.5 && catalog?.[0]?.vision === true && catalog?.[0]?.contextWindow === 200_000 && catalog?.[0]?.maxOutputLength === 8_000);
    check("the probed vision whitelist beats a missing tag",
      catalog?.[1]?.vision === true && catalog?.[1]?.multiplier === 0.25);
    check("a limited_free row quotes the effective price with the list price beside it",
      catalog?.[2]?.multiplier === 0 && catalog?.[2]?.originalMultiplier === 0.5 && catalog?.[2]?.billingStatus === "limited_free" && catalog?.[2]?.billingStatusNote === "免费至10月31日", JSON.stringify(catalog?.[2]));
    check("a discount row quotes the effective price, not the list",
      catalog?.[3]?.multiplier === 0.75 && catalog?.[3]?.originalMultiplier === 1 && catalog?.[3]?.billingStatus === "discount" && catalog?.[3]?.billingStatusNote === "会员日", JSON.stringify(catalog?.[3]));
    check("a normal row keeps the pre-existing row shape (no promotion fields)",
      catalog?.[4]?.multiplier === 0.3 && catalog?.[4]?.billingStatus === undefined && catalog?.[4]?.originalMultiplier === undefined, JSON.stringify(catalog?.[4]));
    check("a promotion without an effective price degrades to the list price",
      catalog?.[5]?.multiplier === 0.4 && catalog?.[5]?.billingStatus === undefined, JSON.stringify(catalog?.[5]));
    // The legacy shape must still read: `id` as the id, top-level windows.
    const legacy = await fetchRaccoonCatalog({ access_token: "t" }, fakeFetcher({ code: 0, data: { categories: [{ type: "chat", models: [
      { id: "legacy-1", name: "Legacy", visible: true, multiplier: 1, vision: true, context_window: 1000, max_output_tokens: 500 }
    ] }] } }));
    check("the legacy catalogue shape still normalizes",
      legacy?.[0]?.id === "legacy-1" && legacy?.[0]?.multiplier === 1 && legacy?.[0]?.vision === true && legacy?.[0]?.contextWindow === 1000 && legacy?.[0]?.maxOutputLength === 500);
    check("a failed catalog read is null (the fallback roster takes over)",
      (await fetchRaccoonCatalog({ access_token: "t" }, async () => {
        throw new Error("down");
      })) === null);
    // "empty" vs "unreadable": a read that SUCCEEDED but listed no visible
    // model must NOT fire onFail (the gateway hid its catalog — not an
    // outage), while a thrown read MUST. This is the split the panel's
    // "the gateway offers no visible models" note depends on.
    const onFailCalls = [];
    check("a successful-but-empty catalog read does not fire onFail",
      (await fetchRaccoonCatalog({ access_token: "t" },
        fakeFetcher({ code: 0, data: { categories: [{ type: "chat", models: [{ id: "h", name: "Hidden", visible: false }] }] } }),
        () => { onFailCalls.push("empty"); })) === null && onFailCalls.length === 0);
    onFailCalls.length = 0;
    check("a thrown catalog read fires onFail",
      (await fetchRaccoonCatalog({ access_token: "t" }, async () => { throw new Error("down"); },
        () => { onFailCalls.push("failed"); })) === null && onFailCalls.length === 1 && onFailCalls[0] === "failed");

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

    // --- the dead-session latch -------------------------------------------
    // The refusal above is a VERDICT, and every eager-refresh call site is
    // shaped `if (isExpired()) refresh()`. So without a latch the plugin asks
    // the gateway once per poll cycle, forever, for an answer that cannot
    // change — the second upstream's answer to a refusal Token Plan answers
    // with throttle-store.ts. These four checks are that latch's whole
    // existence: count the calls, not just the return values.
    let deadCalls = 0;
    const latchedStore = createRaccoonStore({
      credentials: service,
      fetcher: async () => {
        deadCalls += 1;
        return fakeResponse({ code: 401, message: "dead", data: null }, 401);
      }
    });
    // A LAPSED access token, and it has to be a real JWT: `parseRaccoonCredential`
    // derives `expiresAtMs` from the token's `exp`, so a bare string like "a"
    // leaves it undefined and `isExpired()` answers false forever — the poll
    // loop below would then never call `refresh()`, and a "asked once" check
    // would pass for the wrong reason. That is a green test that proves nothing.
    const lapsedJwt = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 })).toString("base64url")}.sig`;
    await latchedStore.save({ accessToken: lapsedJwt, refreshToken: "r" });
    check("the lapsed token really does read as expired (the loop below is live)",
      (await latchedStore.isExpired()) === true);
    await latchedStore.refresh();
    const afterFirst = deadCalls;
    // The poll loop: three more rounds of "is it expired? then renew".
    for (let round = 0; round < 3; round += 1) {
      if (await latchedStore.isExpired()) await latchedStore.refresh();
    }
    check("a dead session is asked ONCE, not once per poll",
      afterFirst === 1 && deadCalls === 1, `calls=${deadCalls}`);
    check("the latch reports the gateway's own verdict, not a synthetic skip",
      (await latchedStore.refresh()).code === RACCOON_CODE.SESSION_DEAD);
    check("a dead session still reads as expired so the panel keeps the re-login affordance",
      (await latchedStore.isExpired()) === true);
    // The escape hatch, and the reason the latch is in-process only: a re-scan
    // stores a NEW pair and must re-open the door. If `save` forgot to clear it,
    // the user would finish a successful QR login and still be refused.
    deadCalls = 0;
    await latchedStore.save({ accessToken: "fresh", refreshToken: "fresh-r" });
    check("a fresh scan re-opens the door after a dead session",
      deadCalls === 0 && (await latchedStore.isExpired()) === false);

    // The counterpart: a refusal that is NOT a dead-session verdict must stay
    // retryable, or one network blip would cost the user a working login.
    let flakyCalls = 0;
    const flakyStore = createRaccoonStore({
      credentials: service,
      fetcher: async () => {
        flakyCalls += 1;
        return fakeResponse({ code: 500, message: "busy", data: null }, 500);
      }
    });
    await flakyStore.save({ accessToken: lapsedJwt, refreshToken: "r" });
    await flakyStore.refresh();
    await flakyStore.refresh();
    check("a transient refusal keeps being retried (no latch)",
      flakyCalls === 2, `calls=${flakyCalls}`);

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
    check("a missing window is OMITTED (harness fills its 32768 default), not guessed",
      !("contextWindow" in raccoonToDescriptor({ id: "m3" })));
    check("a missing output ceiling is OMITTED, not guessed",
      !("maxTokens" in raccoonToDescriptor({ id: "m3" })));
    check("the declared output ceiling is honored as maxTokens", descriptor.maxTokens === 8_000);
    check("v1 pins reasoning:false (no thinking toggle)", descriptor.reasoning === false);
    check("the OpenAI-compat field is pinned to max_tokens", descriptor.compat?.maxTokensField === "max_tokens");
    check("the descriptor is tagged with the Raccoon provider", descriptor.provider === RACCOON_PROVIDER_ID && descriptor.api === "openai-completions");

    // The credit multiplier rides in the DISPLAY NAME: pi-ai has no channel
    // for billing metadata (its `cost` is per-token USD), and the model
    // picker renders only the name — so a priced model shows "· x0.75", and
    // a free one "· x0.00" (the `· x` form matches WorkBuddy's selector).
    check("a priced model's name carries its multiplier suffix",
      raccoonToDescriptor({ id: "p1", name: "P1", multiplier: 0.75 }).name === "P1 · x0.75");
    check("a free model's name says x0.00",
      raccoonToDescriptor({ id: "p2", name: "P2", multiplier: 0 }).name === "P2 · x0.00");
    check("multiplier 1 renders its own factor", raccoonToDescriptor({ id: "p3", name: "P3", multiplier: 1 }).name === "P3 · x1.00");
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

    // A publish that takes the registration down must FORGET the pair, not
    // just release it: a stale `built` survives into the next publish as its
    // rollback target, so a later failed publish would re-register an adapter
    // whose release has already been called. (The "no token" branch used to
    // leave it standing; `unregister` in publish-core.ts now clears it.)
    {
      const llm = makeLlm();
      let token = "a-token";
      const publisher = createRaccoonPublisher({
        panelSwitch: async () => true,
        resolveToken: async () => token,
        getLlm: () => llm,
        loadAdapterModule: async () => ({
          createRaccoonAdapter: async () => ({ adapter: { marker: true }, providerIds: [RACCOON_PROVIDER_ID] })
        })
      });
      await publisher.publish([{ id: "a" }], "");
      const builtWhileServing = publisher.state.built;
      token = "";
      const result = await publisher.publish([{ id: "a" }], "");
      check("a publish that goes down forgets the pair it released", builtWhileServing !== null && result.skipped === true && publisher.state.built === null);
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

// --- ADR-006 (raccoon-switch): all three writers refuse a foreign version ----
// raccoon-provider.json has THREE writers (save / saveIds / forget) instead of
// the provider switch's two, so the guard has to sit in the single writePayload
// and every writer must respect its refusal — otherwise saveIds is the side door
// that still stomps a newer build's file.
{
  const { writeFileSync, readFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "raccoon-switch-guard-"));
  try {
    const file = join(dir, "raccoon-provider.json");
    const foreignPayload = { version: 999, enabled: true, futureField: "x" };
    const seedForeign = () => writeFileSync(file, JSON.stringify(foreignPayload, null, 2), "utf8");
    const intact = () => {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      return raw.version === 999 && raw.futureField === "x";
    };

    const refusalOf = async (fn) => {
      try { await fn(); return null; } catch (error) { return String(error?.message ?? error); }
    };
    const surfaced = (raw) => raw !== null && /refusing to overwrite raccoon-provider\.json/.test(raw);

    seedForeign();
    const warnings = [];
    const a = createFileRaccoonStore({ dir, logger: { warn: (m) => warnings.push(m) } });
    check("raccoon save() refuses out loud, not silently", surfaced(await refusalOf(() => a.save(true))));
    check("raccoon save() does not overwrite a foreign version", intact(), readFileSync(file, "utf8"));
    check("the raccoon refusal is logged, not silent",
      warnings.some((w) => w.includes("refusing to overwrite raccoon-provider.json") && w.includes("version 999")),
      warnings.join(" | "));

    seedForeign();
    check("raccoon saveIds() surfaces the refusal too", surfaced(await refusalOf(() => createFileRaccoonStore({ dir }).saveIds(["sn-raccoon-1"]))));
    check("raccoon saveIds() does not overwrite a foreign version", intact());

    seedForeign();
    check("raccoon forget() surfaces the refusal too", surfaced(await refusalOf(() => createFileRaccoonStore({ dir }).forget())));
    check("raccoon forget() does not overwrite a foreign version", intact());

    // The guard must not trip on the file's own version.
    writeFileSync(file, JSON.stringify({ version: RACCOON_SWITCH_VERSION, enabled: false }), "utf8");
    await createFileRaccoonStore({ dir }).save(true);
    const afterNormal = JSON.parse(readFileSync(file, "utf8"));
    check("a known raccoon version still writes normally",
      afterNormal.version === RACCOON_SWITCH_VERSION && afterNormal.enabled === true, JSON.stringify(afterNormal));

    // The reason string is load-bearing, same as the other guards.
    const source = readFileSync(new URL("../src/host/raccoon-switch-store.ts", import.meta.url), "utf8");
    check("the raccoon refusal marker stays in the source",
      source.includes("raccoon-switch: refusing to overwrite raccoon-provider.json holding version"), "");
  } catch (error) {
    fail("ADR-006 raccoon-switch write-side version guard", error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the wire constants have exactly one home --------------------------------
// ROADMAP §6.1.4: the route side used to re-declare the QR walk's deadline and
// poll cadence, so the same number lived in two files and NOTHING could see
// them drift — no runtime assertion can, because both copies were simply read.
// These two checks pin the invariants that a behavioural test cannot reach:
// the single source, and the deliberate NON-wiring of the desktop reward
// endpoint (the one probe that would claim the user's reward for good).
{
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join, basename } = await import("node:path");
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  // The route side of the protocol constants lives in `routes/raccoon.ts`
  // since the 2026-10 routes split (the facade registers, the family owns the
  // paths); the single-source check scans that module, not the facade.
  const routesSrc = readFileSync(join(srcRoot, "host", "routes", "raccoon.ts"), "utf8");
  // The declaration is what must be gone; a comment may still name them.
  const redeclared = ["RACCOON_LOGIN_DEADLINE_MS", "RACCOON_POLL_MS"]
    .filter((name) => new RegExp(`(?:const|let|var)\\s+${name}\\b`).test(routesSrc));
  check("the QR walk's deadline/cadence are imported, not re-declared",
    redeclared.length === 0 &&
      /RACCOON_LOGIN_TIMEOUT_MS/.test(routesSrc) && /RACCOON_QR_POLL_INTERVAL_MS/.test(routesSrc),
    redeclared.join(", ") || "routes/raccoon.ts does not import the protocol constants");

  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
  const wired = walk(srcRoot)
    .filter((file) => file.endsWith(".ts") && basename(file) !== "raccoon.ts")
    .filter((file) => readFileSync(file, "utf8").includes("RACCOON_DESKTOP_PREFIX"));
  check("the desktop one-time reward endpoint stays unwired",
    wired.length === 0, wired.map((file) => file.replace(srcRoot, "src")).join(", "));
}

// --- W. the QR walk's onLoggedIn hook and the save-window gate ----------
// A1: a successful login must drive the caller's logged-in side effect
// (provider publish) — and only AFTER the credential landed. A failed save
// must not fire it, and a throwing hook must not flip the outcome.
// A2: the concurrency gate must stay closed THROUGH the save window — a
// second login clicked while the credential is being written must not issue
// a second scan — and reopen only once save settled.
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const success = () => ({ status: RACCOON_QR_STATUS.SUCCESS, accessToken: "at", refreshToken: "rt" });
  const drain = async (walk) => {
    for (let i = 0; i < 40 && walk.view.isInFlight(); i += 1) await sleep(10);
  };

  // W1: happy path — save → invalidate → onLoggedIn, exactly in that order.
  {
    const order = [];
    const walk = createRaccoonWalk({
      fetcher: async () => success(),
      saveCredential: async () => { order.push("save"); },
      invalidateCache: () => { order.push("invalidate"); },
      onSettled: () => {},
      onLoggedIn: () => { order.push("onLoggedIn"); }
    });
    await walk.issueScan();
    await drain(walk);
    const event = walk.view.takeEvent();
    check("W1 a successful scan drives save, then invalidate, then onLoggedIn",
      event.status === LOGIN_STATUS.logged_in && order.join(",") === "save,invalidate,onLoggedIn",
      `${event.status} / ${order.join(",")}`);
  }

  // W2: a failed save fires NO onLoggedIn and reports failed.
  {
    let logins = 0;
    const walk = createRaccoonWalk({
      fetcher: async () => success(),
      saveCredential: async () => { throw new Error("the credentials service refused"); },
      invalidateCache: () => {},
      onSettled: () => {},
      onLoggedIn: () => { logins += 1; }
    });
    await walk.issueScan();
    await drain(walk);
    const event = walk.view.takeEvent();
    check("W2 a failed save reports failed and never fires onLoggedIn",
      event.status === LOGIN_STATUS.failed && logins === 0 && event.error !== null,
      `${event.status} / logins=${logins}`);
  }

  // W3: a throwing onLoggedIn must NOT flip the outcome — the credential is
  // already persisted, so a publish miss is a degraded-but-logged-in state.
  {
    const walk = createRaccoonWalk({
      fetcher: async () => success(),
      saveCredential: async () => {},
      invalidateCache: () => {},
      onSettled: () => {},
      onLoggedIn: () => { throw new Error("publish boom"); }
    });
    await walk.issueScan();
    await drain(walk);
    const event = walk.view.takeEvent();
    check("W3 a throwing onLoggedIn leaves the login logged_in",
      event.status === LOGIN_STATUS.logged_in && event.error === null,
      `${event.status} / error=${event.error}`);
  }

  // W4: the gate stays closed THROUGH the held save (A2) and reopens after.
  {
    let releaseSave = null;
    const walk = createRaccoonWalk({
      fetcher: async () => success(),
      saveCredential: () => new Promise((resolve) => { releaseSave = () => resolve(); }),
      invalidateCache: () => {},
      onSettled: () => {},
      onLoggedIn: () => {}
    });
    void walk.issueScan();
    // Wait until the walk has reached the (held) save — the exact window the
    // old gate reopened in, letting a second login race the credential write.
    for (let i = 0; i < 100 && releaseSave === null; i += 1) await sleep(5);
    check("W4 the walk is still in flight DURING the held save",
      walk.view.isInFlight() === true && releaseSave !== null, `inFlight=${walk.view.isInFlight()}`);
    releaseSave?.();
    await drain(walk);
    check("W4 the gate reopens only once save settled",
      walk.view.isInFlight() === false, `inFlight=${walk.view.isInFlight()}`);
  }

  // W5: `stop()` ends a PENDING walk without waiting out the poll interval,
  // and without ever calling the credentials service. The walk is the one side
  // effect that outlives the request that started it, so route teardown has to
  // be able to cut it — a 2s sleep per unmount is survivable, five minutes of
  // gateway polling is not.
  {
    let saves = 0;
    let polls = 0;
    const walk = createRaccoonWalk({
      fetcher: async () => { polls += 1; return { status: RACCOON_QR_STATUS.PENDING }; },
      saveCredential: async () => { saves += 1; },
      invalidateCache: () => {}
    });
    void walk.issueScan();
    // Let the first poll land so the walk is parked in the inter-poll sleep —
    // the state `stop()` has to cut short.
    for (let i = 0; i < 100 && polls === 0; i += 1) await sleep(5);
    const before = polls;
    walk.stop();
    await drain(walk);
    const event = walk.view.takeEvent();
    check("W5 a stopped pending walk reports canceled, not timeout",
      event.status === LOGIN_STATUS.canceled, `${event.status}`);
    check("W5 a stopped walk writes no credential",
      saves === 0, `saves=${saves}`);
    check("W5 stop() cuts the poll loop instead of draining the interval",
      polls - before <= 1, `polled ${polls - before} more time(s) after stop`);
  }

  // W6: a poll already IN FLIGHT when `stop()` lands still resolves — and its
  // `success` must be discarded, not written. This is the window that made the
  // walk dangerous: the gateway call and the teardown are in the same tick, so
  // a walk that was settling as the Host began unloading would persist a
  // credential pair into a service the plugin no longer owns.
  {
    let releasePoll = null;
    let saves = 0;
    const walk = createRaccoonWalk({
      fetcher: () => new Promise((resolve) => { releasePoll = () => resolve(success()); }),
      saveCredential: async () => { saves += 1; },
      invalidateCache: () => {}
    });
    void walk.issueScan();
    for (let i = 0; i < 100 && releasePoll === null; i += 1) await sleep(5);
    walk.stop();
    releasePoll?.();
    await drain(walk);
    const event = walk.view.takeEvent();
    check("W6 a success arriving after stop() is discarded, not persisted",
      saves === 0 && event.status === LOGIN_STATUS.canceled,
      `saves=${saves} / ${event.status}`);
  }

  // W7: a scan issued after `stop()` never starts — the route that would serve
  // it is being unregistered, so there is no tab on the other end.
  {
    let polls = 0;
    const walk = createRaccoonWalk({
      fetcher: async () => { polls += 1; return success(); },
      saveCredential: async () => {},
      invalidateCache: () => {}
    });
    walk.stop();
    await walk.issueScan();
    await drain(walk);
    check("W7 a scan issued after stop() is refused outright",
      polls === 0 && walk.view.takeEvent().status === LOGIN_STATUS.canceled,
      `polls=${polls}`);
  }

  // W9: a `saveCredential` failure rides the EVENT channel to the browser —
  // `takeEvent()` → `raccoon-status.ts`'s `loginError` → the panel — and the
  // record it was handed IS the credential pair. The code claimed "sanitized"
  // above a bare `String(message)`, so a store/credentials-provider error that
  // quoted its input would have printed the tokens into the response. Asserted
  // here at the boundary (rather than on `redactSecrets` alone) because that
  // boundary is the thing that was open.
  {
    const walk = createRaccoonWalk({
      fetcher: async () => success(),
      saveCredential: async () => {
        throw new Error('refused pair { accessToken: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig, refreshToken: rt-abcdef123456 }');
      },
      invalidateCache: () => {}
    });
    void walk.issueScan();
    await drain(walk);
    const event = walk.view.takeEvent();
    check("W9 a save failure still reports `failed`",
      event.status === LOGIN_STATUS.failed, `${event.status}`);
    check("W9 the reason is present (a silent failure would be the other bug)",
      typeof event.error === "string" && event.error.includes("refused pair"), `${event.error}`);
    check("W9 the tokens in that reason are redacted before it reaches the panel",
      typeof event.error === "string"
        && !event.error.includes("eyJhbGciOi")
        && !event.error.includes("rt-abcdef123456"),
      `${event.error}`);
  }

  // W10: the REDACTION must not swallow the diagnosis. A store that refuses an
  // EMPTY token says so with a plain message; if `redactSecrets` were
  // over-eager (whole-string blanking, or a catch-all) the panel would show
  // "unknown" and the user would lose the only actionable fact.
  {
    const walk = createRaccoonWalk({
      fetcher: async () => success(),
      saveCredential: async () => { throw new Error("a Raccoon access token is required"); },
      invalidateCache: () => {}
    });
    void walk.issueScan();
    await drain(walk);
    const event = walk.view.takeEvent();
    check("W10 a reason with no secret in it survives verbatim",
      event.error === "a Raccoon access token is required", `${event.error}`);
  }

  // W8: `stop()` is idempotent and safe with no walk running — every teardown
  // but the one that races a live scan calls it that way.
  {
    const walk = createRaccoonWalk({
      fetcher: async () => success(),
      saveCredential: async () => {},
      invalidateCache: () => {}
    });
    walk.stop();
    walk.stop();
    check("W8 stop() is idempotent and safe on an idle walk",
      walk.view.isInFlight() === false, `inFlight=${walk.view.isInFlight()}`);
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

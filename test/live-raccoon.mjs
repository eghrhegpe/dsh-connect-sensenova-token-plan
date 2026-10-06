/**
 * The raccoon gateway contract against the LIVE service — run deliberately,
 * never by default.
 *
 * Companion to `test/live-contract.mjs` (same discipline: not part of `npm
 * test`, a default run must not reach a real service), but aimed at the
 * SECOND upstream (`xiaohuanxiong.com`, provider `sensenova-raccoon`) whose
 * access and refresh lifecycle is entirely separate from Token Plan. See
 * ROADMAP.md §7 P2.
 *
 * Two tiers, and the split is a safety property, not ergonomics:
 *
 *   L1 (default, no credentials) — route EXISTENCE only. Every probe is
 *      unauthenticated, so the run consumes nothing and can be re-run freely
 *      by anyone, including CI-adjacent machines with no token at hand. This
 *      is the tier that would have caught the `_token` path typo before it
 *      shipped (ROADMAP §6.1.3).
 *   L2 (`RACCOON_ACCESS_TOKEN` set) — the real read contract: the catalogue
 *      shape and, above all, `available_points` still being the balance
 *      field. That field name is the exact bug 0.4.6 fixed (everything else
 *      read as `null`, panel showed a fake zero).
 *
 *   npm run test:live:raccoon
 *   RACCOON_ACCESS_TOKEN=... npm run test:live:raccoon
 *
 * A failure here is INFORMATION, not a regression — same rule as
 * ROADMAP §2.3: the fix belongs in this baseline JSON plus docs, never in
 * `src/host/raccoon.ts` logic read backwards from a platform answer.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  readFileSync(join(ROOT, "test", "baselines", "raccoon-contract.json"), "utf8")
);
const BASE_URL = contract.meta.baseUrl;

// L2 gate. The token arrives ONLY from the environment: it is never read from
// the Host's credentials service, never written anywhere, never echoed. See
// red line #1 in AGENTS.md — a probe script is exactly the kind of place a
// credential leaks from, because its whole job is printing what came back.
const accessToken = process.env.RACCOON_ACCESS_TOKEN ?? "";
const orgCode = process.env.RACCOON_ORG_CODE ?? "";
const refreshToken = process.env.RACCOON_REFRESH_TOKEN ?? "";
const allowRefresh = process.env.RACCOON_LIVE_ALLOW_REFRESH === "1";

/** Every emitted credential reference goes through here: a stable,
 *  non-reversible identifier. The same 12-hex discipline `src/host/routes.ts`
 *  uses for `accessTokenFingerprint` — an `eyJhbGci` prefix would be useless
 *  since every JWT starts with it. */
function fingerprint(value) {
  if (value === "") return "(none)";
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

const PROBE_BACKOFF_MS = 500;
const TIMEOUT_MS = 30_000;
/** The image probe's own deadline: a chat completion is not a metadata read.
 *  Measured 2026-10-06, the same three models answered in 3.5–9 s, but one run
 *  of `sn-glm-5-3-flash` went past the 30 s read timeout — and a timeout is
 *  reported as a red here on purpose: a model the picker offers images to but
 *  that cannot answer inside 90 s is broken from the user's seat. */
const VISION_TIMEOUT_MS = 90_000;

/** Header pair for the given tier. Mirrors `raccoonHeaders()` in
 *  src/host/raccoon.ts — duplicated on purpose so this script stays
 *  peer-free and build-artifact-free (it must run on a clean checkout that
 *  never ran `npm run build`). If that function ever grows a new
 *  authentication-relevant header, this probe silently stops representing the
 *  real client, so the commented shape below is the thing to re-read. */
function headers(withAuth) {
  if (!withAuth) return { Accept: "application/json" };
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "X-Org-Code": orgCode,
    "X-Raccoon-Language": "zh"
  };
}

/** One request, unwrapped into {status, body, text, transportError}. */
async function probe(method, path, { auth = false, body = null, timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: headers(auth),
      ...(body !== null ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text().catch(() => "");
    return { status: response.status, body: tryJson(text), text, transportError: null };
  } catch (error) {
    return { status: 0, body: null, text: "", transportError: error instanceof Error ? error.message : String(error) };
  }
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Split an SSE body into its JSON `data:` envelopes, skipping keep-alive
 *  lines and blank rows — the same tolerance `parseMcpSse` in
 *  src/host/raccoon-search.ts has to carry, because the gateway interleaves
 *  comments and heartbeats with the messages. */
function parseSseEnvelopes(text) {
  const envelopes = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "") continue;
    const parsed = tryJson(payload);
    if (parsed !== null) envelopes.push(parsed);
  }
  return envelopes;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** The answer text of one `chat/completions` reply, in either dialect: a JSON
 *  body (`choices[0].message.content`) or an SSE stream (the concatenated
 *  `choices[].delta.content`). The gateway answers both depending on the
 *  `stream` flag it was asked for, and a probe that reads only one dialect
 *  would report a seeing model as blind. */
function chatAnswer(text, body) {
  const fromJson = body?.choices?.[0]?.message?.content;
  if (typeof fromJson === "string" && fromJson !== "") return fromJson;
  if (typeof body?.data?.choices?.[0]?.message?.content === "string") return body.data.choices[0].message.content;
  return parseSseEnvelopes(text)
    .map((envelope) => envelope?.choices?.[0]?.delta?.content ?? envelope?.data?.choices?.[0]?.delta?.content ?? "")
    .join("");
}

/**
 * A PNG of `width`×`height` made of equal vertical stripes — built here rather
 * than pasted as a base64 blob so the image the probe sends is readable in the
 * source that sends it. `stripes` are `[r, g, b]`, left to right.
 * @param {number[][]} stripes
 * @param {number} [width]
 * @param {number} [height]
 * @returns {Buffer} the PNG bytes.
 */
function stripePng(stripes, width = 240, height = 120) {
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const rowBytes = width * 3 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const stripe = stripes[Math.min(stripes.length - 1, Math.floor((x / width) * stripes.length))];
      raw.writeUIntBE((stripe[0] << 16) | (stripe[1] << 8) | stripe[2], y * rowBytes + 1 + x * 3, 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// The route-existence dialect this gateway speaks: a path that EXISTS but is
// not authorized answers a STRUCTURED envelope (JSON with `code`), while a
// path that does not exist at all answers a bare `404 page not found` in plain
// text. That asymmetry is the whole probe instrument, and it is why every
// assertion below is paired with a control.
const isStructured = (res) => res.body !== null && typeof res.body.code !== "undefined";
const isTextNotFound = (res) => res.status === 404 && res.body === null;

console.log(`live raccoon probe — ${BASE_URL}`);
console.log(`tier: ${accessToken === "" ? "L1 (no credentials, route existence only)" : `L2 (bearer ${fingerprint(accessToken)})`}`);

// --- L1. route existence: every contract route must still be THERE -------
for (const route of contract.routes) {
  const body = route.probeWithoutAuth === "structured-400"
    // The bogus-token probe is the only way to touch refresh safely: a REAL
    // refresh token is single-use rotation, so spending one here would leave
    // the user unable to renew until they re-scan. A deliberately malformed
    // token separates "400 = the path exists and reached business logic" from
    // "404 = no such path" at zero cost (ROADMAP §6.1.3).
    ? { refresh_token: "bogus-token-for-route-existence-probe" }
    : null;
  const res = await probe(route.method, route.path, { auth: false, body });

  if (res.transportError !== null) {
    check(`${route.id} (${route.path}) reachable`, false, `transport: ${res.transportError}`);
    await sleep(PROBE_BACKOFF_MS);
    continue;
  }

  if (route.probeWithoutAuth === "structured-401") {
    // Structured rejection, not a missing path: the route is mounted and the
    // gateway is telling us to authenticate.
    check(`${route.id} (${route.path}) exists and demands credentials`,
      res.status === 401 && isStructured(res),
      `HTTP ${res.status} body=${JSON.stringify(res.body ?? res.text.slice(0, 120))}`);
  } else {
    check(`${route.id} (${route.path}) exists (bogus token rejected by business layer)`,
      res.status === 400 && isStructured(res),
      `HTTP ${res.status} code=${String(res.body?.code)}`);
    if (res.body?.code !== undefined) {
      check(`${route.id} still answers ${String(route.expectedCode)} ${route.expectedMessage}`,
        res.body.code === route.expectedCode,
        `got code=${String(res.body.code)} message=${String(res.body.message)}`);
    }
  }
  await sleep(PROBE_BACKOFF_MS);
}

// --- L1b. controls: prove the 401-vs-404 instrument still discriminates ---
// Without this group every "structured 401" above is a belief, not a
// measurement: if the gateway started answering structured 404s too, L1 would
// pass while telling us nothing. These two must stay absent.
for (const control of contract.absentRouteControls) {
  const body = control.method === "POST" ? { refresh_token: "bogus-token-for-route-existence-probe" } : null;
  const res = await probe(control.method, control.path, { auth: false, body });
  if (res.transportError !== null) {
    check(`control ${control.id} still absent (probe unreachable)`, false, `transport: ${res.transportError}`);
    await sleep(PROBE_BACKOFF_MS);
    continue;
  }
  check(`control ${control.id} still absent (plain-text 404, not a structured envelope)`,
    isTextNotFound(res),
    `HTTP ${res.status} body=${JSON.stringify(res.body ?? res.text.slice(0, 120))}`);
  await sleep(PROBE_BACKOFF_MS);
}

// --- L1c. the forbidden route is never touched WITH credentials ----------
// `/api/web/desktop/v1/login/points/grant` is a one-per-account desktop login
// reward: requesting it with a real credential SPENDS it, irreversibly
// (ROADMAP §6.1.4, PITFALLS §28). It is listed in the baseline under
// `forbidden` and this loop asserts the script's own discipline: even with a
// token in hand we must not authenticate toward it. Existence is all we prove.
for (const forbidden of contract.forbidden) {
  const res = await probe(forbidden.method, forbidden.path, { auth: false });
  check(`forbidden ${forbidden.path} probed WITHOUT credentials`,
    true,
    res.transportError !== null
      ? `transport: ${res.transportError}`
      : `HTTP ${res.status} — existence only, never authenticated`);

  // A `check(..., true)` above records the intent but cannot prove it, so this
  // is the part that actually bites: read OUR OWN SOURCE and assert the path
  // never appears on a line that also authenticates. Someone hand-editing this
  // loop to `{ auth: true }` to "see what happens" is the realistic failure
  // mode, and it is exactly the one that spends a user's one-time reward.
  const own = readFileSync(fileURLToPath(import.meta.url), "utf8").split(/\r?\n/);
  const offending = own
    .map((line, index) => ({ line: line.trim(), no: index + 1 }))
    .filter((row) => row.line.includes(forbidden.path) && /auth:\s*true/.test(row.line));
  check(`source guard: ${forbidden.path} never appears with auth:true in this script`,
    offending.length === 0,
    offending.length === 0 ? "no authenticated call site" : `line(s) ${offending.map((o) => o.no).join(", ")}`);
}

if (accessToken === "") {
  console.log("\nSKIP L2 — RACCOON_ACCESS_TOKEN is not set.");
  console.log("L2 is the tier that guards `available_points` (the 0.4.6 balance bug) and the");
  console.log("visible-model roster. Export a token and re-run to exercise it. A missing");
  console.log("token is an environment fact, not a platform signal, so this exits 0 the");
  console.log("way `test/e2e-gate.mjs` does for a missing dsh CLI.");
  report();
}

// --- L2a. catalogue shape -------------------------------------------------
{
  const res = await probe("GET", contract.routes.find((r) => r.id === "catalog").path, { auth: true });
  if (res.transportError !== null) {
    check("catalogue read reachable with credentials", false, `transport: ${res.transportError}`);
  } else {
    check("catalogue read succeeds (envelope code 0)", res.body?.code === 0,
      `HTTP ${res.status} code=${String(res.body?.code)} message=${String(res.body?.message)}`);
    const categories = Array.isArray(res.body?.data?.categories) ? res.body.data.categories : [];
    const chat = categories.find((c) => c?.type === contract.catalog.categoryType);
    check(`catalogue still declares a "${contract.catalog.categoryType}" category`,
      chat !== undefined,
      `types: ${categories.map((c) => String(c?.type)).join(", ") || "none"}`);
    const models = Array.isArray(chat?.models) ? chat.models : [];
    // The v2 catalogue's id field is `model_name` (ROADMAP §6.1.6: `id` is gone,
    // and every row still carries an empty `id` key). Reading `id` alone here
    // made this line report the whole roster as vanished — a red that means
    // nothing, which is the failure mode this file's header warns about.
    const rowId = (m) => String(m?.model_name ?? m?.id ?? "");
    const visibleIds = new Set(models.filter((m) => m?.visible !== false && rowId(m) !== "").map(rowId));
    const survivors = contract.catalog.visibleIds.filter((id) => visibleIds.has(id));
    // `list-not-subset`: new models are not drift, MASS DISAPPEARANCE is. A
    // strict equality here would make every gateway catalogue expansion a red,
    // and a red that means nothing teaches people to ignore reds.
    check(`catalogue still lists ≥${survivors.length >= 4 ? 4 : survivors.length} of the frozen visible ids (${survivors.length}/${contract.catalog.visibleIds.length})`,
      survivors.length >= 4,
      `visible on gateway: ${[...visibleIds].join(", ") || "none"}`);
    // Invisible entries: the rows the gateway hides from the picker. The v2
    // catalogue marks them with `visible: false` (that is what
    // `fetchRaccoonCatalog` filters on) — reading "empty id" here counted ALL
    // nine rows as invisible, because v2 dropped `id` entirely and every row
    // now has an empty one. Same pre-v2 leftover as the id read above.
    const invisible = models.filter((m) => m?.visible === false);
    check("catalogue invisible entries are still the known count",
      invisible.length === contract.catalog.invisibleCount,
      `found ${invisible.length}, frozen ${contract.catalog.invisibleCount}`);
  }
  await sleep(PROBE_BACKOFF_MS);
}

// --- L2b. balance fields — the field that broke 0.4.6 ---------------------
{
  const route = contract.routes.find((r) => r.id === "balance");
  const res = await probe("GET", route.path, { auth: true });
  if (res.transportError !== null) {
    check("balance read reachable with credentials", false, `transport: ${res.transportError}`);
  } else {
    check("balance read succeeds (envelope code 0)", res.body?.code === 0,
      `HTTP ${res.status} code=${String(res.body?.code)} message=${String(res.body?.message)}`);
    const data = res.body?.data ?? null;
    if (data === null) {
      check("balance envelope carries a data object", false, String(res.text.slice(0, 160)));
    } else {
      // THE regression nail. The gateway's total arrives as `available_points`;
      // when this field disappears the HOST silently falls back to
      // balance/available/amount, finds nothing, and renders a fake zero —
      // which is precisely the 0.4.6 failure, invisible until someone compared
      // against the real console. This assertion exists so the next rename
      // shows up here instead of in a user's balance display.
      check(`balance still reports "${contract.balance.totalField}" (the 0.4.6 field)`,
        typeof data[contract.balance.totalField] !== "undefined",
        `data keys: ${Object.keys(data).join(", ")}`);
      const total = Number(data[contract.balance.totalField]);
      check("balance total still parses as a finite number", Number.isFinite(total),
        `got ${String(data[contract.balance.totalField])}`);
      for (const part of contract.balance.partFields) {
        if (typeof data[part] === "undefined") continue; // declared-only合约
        check(`declared balance part "${part}" is still finite`,
          Number.isFinite(Number(data[part])),
          `got ${String(data[part])}`);
      }
    }
  }
  await sleep(PROBE_BACKOFF_MS);
}

// --- L2d. the hosted web_search MCP, end to end (ROADMAP §6.1.7) ----------
// This is not route existence — it is the contract src/host/raccoon-search.ts
// depends on. MCP over HTTP streamable answers 406 unless BOTH content types
// are accepted and hands back a per-session `Mcp-Session-Id`, so the generic
// probe() (plain `Accept`) cannot speak it; a raw fetch is the instrument here.
{
  const mcpRoute = contract.routes.find((r) => r.id === "mcp-web-search");
  const mcpUrl = `${BASE_URL}${mcpRoute.path}`;
  const mcpHeaders = () => ({
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`
  });
  const mcp = contract.mcpWebSearch ?? { toolName: "web_search", probeQuery: "商汤科技", protocolVersion: "2024-11-05" };

  let init = null;
  let initError = "";
  try {
    init = await fetch(mcpUrl, {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: mcp.protocolVersion, capabilities: {}, clientInfo: { name: "live-raccoon-probe", version: "1.0" } }
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    initError = error instanceof Error ? error.message : String(error);
  }
  check("mcp initialize is reachable with credentials", init !== null, initError);

  if (init !== null) {
    check("mcp initialize answers 200", init.status === 200, `HTTP ${init.status}`);
    const sessionId = init.headers.get("mcp-session-id") ?? "";
    check("mcp initialize returns a Mcp-Session-Id", sessionId.length > 0,
      sessionId.length === 0 ? "header missing" : `id=${fingerprint(sessionId)}`);
    const initText = await init.text().catch(() => "");
    const initEnvelopes = parseSseEnvelopes(initText);
    check("mcp initialize announces a server (serverInfo or error-free envelope)",
      initEnvelopes.length > 0, `envelopes=${initEnvelopes.length}`);

    let call = null;
    let callError = "";
    try {
      call = await fetch(mcpUrl, {
        method: "POST",
        headers: { ...mcpHeaders(), ...(sessionId !== "" ? { "Mcp-Session-Id": sessionId } : {}) },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: mcp.toolName, arguments: { Query: mcp.probeQuery, Count: 1, SearchType: "web" } }
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (error) {
      callError = error instanceof Error ? error.message : String(error);
    }
    check("mcp tools/call is reachable", call !== null, callError);
    if (call !== null) {
      check("mcp tools/call answers 200", call.status === 200, `HTTP ${call.status}`);
      const callText = await call.text().catch(() => "");
      const envelopes = parseSseEnvelopes(callText);
      const textPiece = envelopes
        .flatMap((e) => Array.isArray(e?.result?.content) ? e.result.content : [])
        .find((c) => typeof c?.text === "string")?.text ?? "";
      const parsed = tryJson(textPiece);
      const webResults = Array.isArray(parsed?.Result?.WebResults) ? parsed.Result.WebResults : [];
      check(`mcp web_search returns a WebResults array (Count=1)`,
        webResults.length >= 1,
        `results=${webResults.length} resultCount=${String(parsed?.Result?.ResultCount)}`);
      const first = webResults[0];
      if (first) {
        check("mcp web_search result rows carry Url/Title/Snippet",
          typeof first.Url === "string" && typeof first.Title === "string" && typeof first.Snippet === "string",
          first.Url ? `url=${first.Url}` : "missing Url");
      }
    }
  }

  // `images/gen` is deliberately NOT generated here: each POST spends points
  // and blocks synchronously past 600 s, and its response shape is still
  // unconfirmed. Route existence is already covered in L1; the field contract
  // is frozen in `contract.imageGen` until someone runs one by hand.
  check("images/gen real generation is not auto-probed (spends points, response format unconfirmed)",
    true, "route existence in L1; see contract.imageGen.note");
}

// --- L2e. the vision probe sets, RE-PROBED (ADR-009) ----------------------
// `RACCOON_VISION_WHITELIST` / `RACCOON_VISION_DENYLIST` are measurements, and
// a measurement with no re-probe rots into a belief. Every member of either set
// gets one real image question here — that is the whole point of this tier. If
// the gateway re-routes `sn-glm-5-3` to a seeing backend, this section goes red
// and says the denylist entry can come out.
//
// Cost discipline (same as L2d): ONE request per member, no retry, no loop.
// This is the only part of L2 that spends inference credits — three short chat
// turns today, against the alternative of users sending pictures to a model
// that answers HTTP 200 and then says it cannot see them.
{
  const vision = contract.visionProbe ?? null;
  if (vision === null) {
    console.log("\nSKIP vision re-probe — test/baselines/raccoon-contract.json has no visionProbe block.");
  } else {
    const png = stripePng([[0x2e, 0x8b, 0x57], [0xff, 0x00, 0xff], [0xff, 0xa5, 0x00], [0x1e, 0x3a, 0x8a]]);
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const members = Object.keys(vision.expected ?? {});
    check("the vision probe names at least one model", members.length >= 1, `members=${members.join(",")}`);
    for (const id of members) {
      const res = await probe("POST", "/api/web/llm/v2/chat/completions", {
        auth: true,
        timeoutMs: VISION_TIMEOUT_MS,
        body: {
          model: id,
          stream: false,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: vision.question },
              { type: "image_url", image_url: { url: dataUrl } }
            ]
          }]
        }
      });
      if (res.transportError !== null) {
        check(`${id}: vision probe reachable`, false, `transport: ${res.transportError}`);
      } else {
        const answer = chatAnswer(res.text, res.body);
        const denies = /无法(看到|查看|识别)|看不到|不能(看到|查看|识别)|不支持(图片|图像)|未(能)?收到(图片|图像)/.test(answer);
        // A seeing model names the stripes; a blind one either denies outright or
        // (worse) guesses. Guessing is why the verdict is "denies → blind" AND
        // "names ≥3 colours → sees", with the middle read as blind.
        const colours = ["绿", "品红", "洋红", "橙", "深蓝"].filter((c) => answer.includes(c)).length;
        const sees = denies ? false : colours >= 3;
        const want = vision.expected[id] === true;
        check(`${id}: live vision verdict still matches the recorded probe (${want ? "sees" : "blind"})`,
          sees === want,
          `HTTP ${res.status} sees=${sees} denies=${denies} colours=${colours} answer="${answer.replace(/\s+/g, " ").slice(0, 120)}"`);
      }
      await sleep(PROBE_BACKOFF_MS);
    }
    if (members.length > 0) {
      console.log(`\nL2e spent ${members.length} billed chat request(s) — one per probe-set member.`);
    }
  }
}

// --- L2c. refresh: opt-in only, because it BURNS the token ----------------
// A real raccoon refresh is single-use rotation. Running it casually
// invalidates the very pair the user is relying on and forces a re-scan, so
// this tier is behind a second explicit gate even though L2 already has a
// token. The console tells you what it did and what it cost.
if (refreshToken !== "" && allowRefresh) {
  console.log(`\n!!! refresh probe armed — this SPENDS refresh token ${fingerprint(refreshToken)}`);
  console.log("!!! The gateway rotates it: after this request that pair is dead and the panel");
  console.log("!!! will need a QR re-scan. Do not arm this on a credential you still need.");
  const res = await probe("POST", contract.routes.find((r) => r.id === "refresh").path, {
    auth: false,
    body: { refresh_token: refreshToken }
  });
  check("refresh accepted a real token (envelope code 0)", res.body?.code === 0,
    `HTTP ${res.status} code=${String(res.body?.code)} message=${String(res.body?.message)}`);
  const rotated = String(res.body?.data?.refresh_token ?? "");
  check("refresh rotated the pair (a fresh refresh_token came back)", rotated !== "" && rotated !== refreshToken,
    `new token fingerprint ${fingerprint(rotated)}`);
} else if (refreshToken !== "" && !allowRefresh) {
  console.log("\nSKIP refresh probe — RACCOON_REFRESH_TOKEN is set but RACCOON_LIVE_ALLOW_REFRESH!=1.");
  console.log("A real refresh SPENDS the token (single-use rotation), so it needs its own opt-in.");
  console.log("Set RACCOON_LIVE_ALLOW_REFRESH=1 only on a pair you are willing to lose.");
}

report();

/** Summarize and exit. Negative asserts failed; positive asserts are the gates. */
function report() {
  const failed = results.filter((r) => !r.pass);
  console.log(JSON.stringify(results, null, 2));
  if (failed.length > 0) {
    console.error(`\n${failed.length}/${results.length} live raccoon check(s) did not hold`);
    console.error("A live failure is usually a GATEWAY change, not a code bug: refresh");
    console.error("test/baselines/raccoon-contract.json and ROADMAP.md §6.1.2/§6.1.3 first,");
    console.error("then decide whether src/host/raccoon.ts must follow.");
    process.exit(1);
  }
  console.log(`\nall ${results.length} live raccoon checks passed`);
  process.exit(0);
}

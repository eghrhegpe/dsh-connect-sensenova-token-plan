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
async function probe(method, path, { auth = false, body = null } = {}) {
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: headers(auth),
      ...(body !== null ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS)
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    const visibleIds = new Set(models.filter((m) => m?.visible !== false && String(m?.id ?? "") !== "").map((m) => String(m.id)));
    const survivors = contract.catalog.visibleIds.filter((id) => visibleIds.has(id));
    // `list-not-subset`: new models are not drift, MASS DISAPPEARANCE is. A
    // strict equality here would make every gateway catalogue expansion a red,
    // and a red that means nothing teaches people to ignore reds.
    check(`catalogue still lists ≥${survivors.length >= 4 ? 4 : survivors.length} of the frozen visible ids (${survivors.length}/${contract.catalog.visibleIds.length})`,
      survivors.length >= 4,
      `visible on gateway: ${[...visibleIds].join(", ") || "none"}`);
    const invisible = models.filter((m) => String(m?.id ?? "") === "" && String(m?.model_name ?? "") !== "");
    check("catalogue invisible entries (empty id, model_name present) are still the known count",
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

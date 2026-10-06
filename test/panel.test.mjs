/**
 * The panel's own decisions, run against the code the browser actually loads.
 *
 * There is no mirror here AND no source-scraping: `panel-decision.js` loads
 * the client SOURCE (`src/client/index.ts`, via `client-surface.js`) as a module
 * and calls the functions the browser calls, so these checks fail when the
 * PANEL's behaviour changes —
 * not when a hand-written copy changes, and not when the client's formatting
 * changes. The cases that matter most are the throttle fields, which the old
 * mirror did not model at all: the greying-out added to stop a bad password
 * becoming a lockout was, as a consequence, entirely uncovered.
 */
import { readFile, readdir } from "node:fs/promises";
import { decidePanelView, dictionaries, interpretSnapshot, tables, RENDER } from "./panel-decision.js";
import { AUTH_FAILURE_CODES, CODE, CREDENTIAL_REFUSALS, NO_LOGIN_CODES } from "../src/host/codes.ts";
import { CONFIG_DEFAULTS } from "../src/host/host-config.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

/**
 * Drive a raw Host response through the panel's own pipeline.
 *
 * This is the point of the module: the bytes below are what the Host actually
 * sends, and they go through the panel's REAL reading and REAL decision.
 * @param {unknown} body - the parsed snapshot response.
 * @returns {object} the view model.
 */
function view(body) {
  const read = interpretSnapshot(body);
  return decidePanelView(read.data, read.error);
}

const healthy = {
  ok: true,
  pools: { pools: [{ id: "pool-1", name: "通用池" }] },
  trend: { models: [] },
  auth: { configured: true, hasAccount: true, hasRefreshToken: true, needsAccount: false, ephemeral: false, retryAfterMs: null }
};

// === A. a working panel renders the pools ================================
{
  const result = view(healthy);
  check("a working panel renders the pools", result.render === RENDER.PANELS, result.render);
  check("a working panel is not asked for setup", result.needsSetup === false);
  check("the account editor is offered", result.canManageAccount === true);
  check("a healthy panel is not waiting", result.coolingMs === null, String(result.coolingMs));
  check("a healthy panel asks for nothing", result.needsUserAction === false);
}

// === B. THE REPORTED BUG: a Host response with no `auth` field ===========
// A Host whose response carried no `auth` left the panel with `auth === null`,
// and the form was then unreachable. This is the legacy shape: `ok:false` and
// nothing else. The missing field must not read as "everything is fine".
{
  const result = view({ ok: false, error: "no console account is configured", code: "not_configured" });
  check("a legacy payload without auth reaches the form", result.render === RENDER.FORM, result.render);
  check("the missing field reads as not needing setup", result.needsSetup === true);
  check("the reason still names the missing account", result.guidanceKey === "panel.jwtMissing",
    String(result.guidanceKey));

  // The COMMON shape is NOT the legacy one above: the Host answers `ok:true`
  // for "not signed in yet" and puts the state in `quotaError.code`
  // (e2e asserts this at test/e2e.mjs — "an unconfigured panel reports the quota
  // unavailable, not an error"). That distinction is load-bearing for polling:
  // `useSnapshotPolling` backs off to a minute whenever `interpretSnapshot`
  // yields an error, so if `not_configured` ever started reading as a FAILURE,
  // a perfectly normal fresh install would poll once a minute instead of every
  // 30 s. Pinned here so a change to `interpretSnapshot` cannot make the
  // ordinary unconfigured state look like a broken one.
  const fresh = view({
    ok: true,
    pools: { pools: [] },
    trend: { models: [] },
    quotaError: { code: "not_configured", message: "no console account is configured" },
    auth: { configured: false, hasAccount: false, hasRefreshToken: false, needsAccount: true, ephemeral: false, retryAfterMs: null }
  });
  check("an unconfigured panel is ok:true, so the snapshot reader sees NO error",
    interpretSnapshot({
      ok: true,
      auth: { configured: false },
      quotaError: { code: "not_configured" }
    }).error === null,
    JSON.stringify(interpretSnapshot({
      ok: true, auth: { configured: false }, quotaError: { code: "not_configured" }
    })));
  check("…and the ordinary unconfigured state is not an error view either",
    fresh.render === RENDER.PANELS, fresh.render);
}

// === B2. THE CLEARED-ACCOUNT DEAD END: `ok:true` after forget ============
// "Forget the saved account" keeps the refresh grant breathing, so the next
// poll still answers `ok:true` with empty pools. `data` is non-null, so the
// `!data` setup form never mounts; if the account section card were gated on
// `hasAccount` alone (false right after a forget), the user was locked out
// of their own account — no re-entry path. The card is therefore shown
// UNCONDITIONALLY whenever the snapshot carries the Host's auth block:
// the MIDDLE state (grant still alive: `hasAccount` false, `needsAccount`
// false, `configured` true) and the dead-grant state both keep the editor
// on screen, so a cleared account always has a re-entry path.
{
  const midState = {
    ok: true,
    pools: { pools: [] },
    trend: { models: [] },
    auth: { configured: true, hasAccount: false, hasRefreshToken: true, needsAccount: false, retryAfterMs: null }
  };
  const dead = {
    ok: true,
    pools: { pools: [] },
    trend: { models: [] },
    auth: { configured: false, hasAccount: false, hasRefreshToken: false, needsAccount: true, retryAfterMs: null }
  };
  const mid = view(midState);
  check("grant still alive: the account editor stays on screen", mid.canManageAccount === true,
    JSON.stringify(mid.auth));
  check("grant still alive: the panel still reads quota", mid.render === RENDER.PANELS, mid.render);
  const deadResult = view(dead);
  check("grant dead: the account editor stays on screen", deadResult.canManageAccount === true,
    JSON.stringify(deadResult.auth));
  check("grant dead: the panel still answers (empty), no setup form",
    deadResult.render === RENDER.PANELS, deadResult.render);
}

// === B3. a console-less snapshot degrades, not dead-ends ==================
// The Host answers `ok:true` with an in-body `quotaError` when the console is
// unreachable (no account, a rejected token, the console down): the panel
// must keep rendering the tabs (the API and Raccoon tabs are independent of
// the console) and keep the account editor reachable on the quota tab —
// never a full-screen dead end.
{
  const signedOut = {
    ok: true,
    pools: { pools: [] },
    trend: { models: [] },
    quotaError: { code: "not_configured", message: "no console account is configured" },
    llm: { hasApiKey: false, keySource: null, ephemeral: false, registerProvider: false },
    auth: { configured: false, hasAccount: false, hasRefreshToken: false, needsAccount: true, ephemeral: false, retryAfterMs: null }
  };
  const result = view(signedOut);
  check("a console-less snapshot still renders the panel", result.render === RENDER.PANELS, result.render);
  check("a console-less snapshot is not a full-screen setup", result.needsSetup === false);
  check("the account editor stays reachable on the quota tab", result.canManageAccount === true);

  const consoleDown = view({ ...signedOut, quotaError: { code: "console_error", message: "console down" } });
  check("a transient console outage also keeps the panel",
    consoleDown.render === RENDER.PANELS && consoleDown.canManageAccount === true, consoleDown.render);
  check("a transient console outage is not a sign-in ask", consoleDown.needsSetup === false);
}

// === C. a config error must NOT hide behind the form ====================
{
  const result = view({ ok: false, error: "bad endpoint override", code: "config_error" });
  check("a config error shows text, not the form", result.render === RENDER.TEXT, result.render);
  check("a config error still explains itself", result.guidanceKey === "panel.configError",
    String(result.guidanceKey));
}

// === D. a transport error and a malformed body are not success ===========
{
  const transport = decidePanelView(null, "network down");
  check("a transport error reaches the form", transport.render === RENDER.FORM, transport.render);
  check("a transport error carries no auth", transport.auth === null);
  // `ok` missing entirely: the Host never sends this, and it must not read as
  // a working panel.
  const malformed = view({ pools: {} });
  check("a body with no `ok` is not a working panel", malformed.render !== RENDER.PANELS, malformed.render);
  check("a body with no `ok` reaches the form", malformed.render === RENDER.FORM, malformed.render);
}

// === E. THE THROTTLE: a lockout greys the form, with the platform's number =
{
  const locked = {
    ok: false,
    error: "login failed: The account has been locked",
    code: "account_locked",
    auth: { configured: false, hasAccount: true, retryAfterMs: 8 * 60_000, needsUserAction: false }
  };
  const result = view(locked);
  check("a served wait reaches the panel", result.coolingMs === 8 * 60_000, String(result.coolingMs));
  check("a lockout does not ask for a corrected password", result.needsUserAction === false);
  check("a locked account reaches the form", result.render === RENDER.FORM, result.render);
  // The button is greyed while cooling, and the message states the platform's
  // own number so the reason it is disabled is never a mystery.
  const minutes = Math.max(1, Math.ceil(result.coolingMs / 60_000));
  check("a cooling panel shows the platform's own minutes", minutes === 8, String(minutes));
}

// === F. THE THROTTLE: a wrong password is parked, not counted down =======
// A countdown here would be a lie: when it reached zero no retry would happen,
// because waiting cannot make a wrong password right. The button must stay
// usable, because retyping IS the fix.
{
  const parked = {
    ok: false,
    error: "login failed: invalid account or password",
    code: "login_rejected",
    auth: { configured: false, hasAccount: true, retryAfterMs: null, needsUserAction: true }
  };
  const result = view(parked);
  check("a parked refusal shows no countdown", result.coolingMs === null, String(result.coolingMs));
  check("a parked refusal asks the user to act", result.needsUserAction === true);
  check("a parked refusal leaves the submit button usable", result.coolingMs === null);
  check("a wrong password still reaches the form", result.render === RENDER.FORM, result.render);
}

// === F2. a console failure must NOT hide behind the login form ===========
// The old test read "any failure without data reaches the form", which made
// an unreachable console look like a sign-in problem: the user was asked for a
// password for an outage, and the reason was never on screen.
{
  const down = {
    ok: false,
    error: "console returned HTTP 502",
    code: "console_error",
    auth: { configured: true, hasAccount: true, hasRefreshToken: true, needsAccount: false, retryAfterMs: null }
  };
  const result = view(down);
  check("a console failure shows text, not the form", result.render === RENDER.TEXT, result.render);
  check("a console failure is not asked for setup", result.needsSetup === false);
  check("a console failure still says what happened",
    result.failure?.message === "console returned HTTP 502", String(result.failure?.message));
  // A locked account is the opposite case: the account IS the thing to fix.
  const locked = view({
    ok: false, error: "login failed: locked", code: "account_locked",
    auth: { configured: false, hasAccount: true, needsAccount: false, retryAfterMs: 8 * 60_000 }
  });
  check("a lockout still reaches the form", locked.render === RENDER.FORM, locked.render);
}

// === F2b. the panel only branches on codes the plugin declares ===========
// client.js is a browser bundle and cannot import codes.js, so it ships its
// own tables — GUIDANCE_BY_CODE, REFUSAL_TEXT, FORM_EXCLUDED_CODES. It cannot
// share the taxonomy, but it must not contradict one: these are semantic
// assertions on the REAL tables the browser uses (the old version regexed the
// source text for literals, which could only ever see spellings, never
// meaning).
{
  const declared = new Set(Object.values(CODE));
  const guided = Object.keys(tables.GUIDANCE_BY_CODE);
  const refusals = Object.keys(tables.REFUSAL_TEXT);
  const excluded = [...tables.FORM_EXCLUDED_CODES];
  const handled = [...new Set([...guided, ...refusals, ...excluded])];
  const unknown = handled.filter((code) => !declared.has(code));
  check("the panel's tables were read from the shipped client", handled.length >= 6,
    handled.join(", "));
  check("every code the panel branches on is declared in codes.js", unknown.length === 0, unknown.join(", "));
  check("the panel can tell a console failure from an auth failure",
    handled.includes(CODE.CONSOLE_ERROR) && handled.includes(CODE.AUTH_ERROR),
    handled.join(", "));
  // The declaration lives in codes.js; the client copy is pinned to it, so a
  // code added to either side only fails here instead of quietly changing
  // what the form does.
  check("the form-excluded set equals codes.js NO_LOGIN_CODES",
    excluded.length === NO_LOGIN_CODES.size && excluded.every((code) => NO_LOGIN_CODES.has(code)),
    excluded.join(", "));
  // Every credential refusal is the user's to correct, so the form must have
  // a line of text for it — this is the check that would have caught the
  // historical bug where account_locked was produced but never recognised.
  const untexted = [...CREDENTIAL_REFUSALS].filter((code) => !(code in tables.REFUSAL_TEXT));
  check("every credential refusal has a form line", untexted.length === 0, untexted.join(", "));
  // No auth failure may be hidden behind the "no login can fix this" wall:
  // each of them is answered by signing in, which is what the form offers.
  const hidden = [...AUTH_FAILURE_CODES].filter((code) => tables.FORM_EXCLUDED_CODES.has(code));
  check("no auth-failure code is hidden from the form", hidden.length === 0, hidden.join(", "));

  // A code compared INLINE in a component is a third place a wire code can live:
  // outside all three tables, and therefore outside every check above.
  // `login_failed` was exactly that — a rename in codes.ts would have turned the
  // branch into dead code and shown the platform's raw error instead of the
  // form's own line, with nothing red. It has since moved into `REFUSAL_TEXT`
  // (an interpolated value), so this check flipped from "find and pin the
  // offender" to "a new offender is a failure": the taxonomy now lives only in
  // the tables, and any inline comparison that reappears goes red on its own.
  // Only the code-shaped literals are collected (dotted strings are dictionary
  // keys, whose existence F6 already covers).
  const components = (await readdir(new URL("../src/client/", import.meta.url)))
    .filter((name) => name.endsWith(".ts") && name !== "i18n.ts");
  const inline = new Set();
  // `typeof code === "string"` is a type guard, not a wire code, so the
  // primitives are excluded — the point is to find comparisons against the
  // taxonomy, and a type test is not one.
  const PRIMITIVES = new Set(["string", "number", "boolean", "object", "undefined", "function", "symbol", "bigint"]);
  for (const name of components) {
    const source = await readFile(new URL(`../src/client/${name}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/(?:code|error\?\.code)\s*===\s*"([^".]+)"/g)) {
      if (!PRIMITIVES.has(match[1])) inline.add(match[1]);
    }
  }
  check("no wire code is compared inline in a component",
    inline.size === 0,
    inline.size > 0 ? `inline: ${[...inline].sort().join(", ")}` : "checked: none");
}

// === F3. the two dictionaries carry the same keys ========================
// A key added to one language only is invisible in one and renders as a raw
// key in the other — which is how `panel.shapeDrift` shipped with a Chinese
// dictionary that could not display it.
{
  const zhKeys = Object.keys(dictionaries.zh).sort();
  const enKeys = Object.keys(dictionaries.en).sort();
  check("the dictionaries were read from the shipped client", zhKeys.length > 20 && enKeys.length > 20,
    `zh=${zhKeys.length} en=${enKeys.length}`);
  const onlyZh = zhKeys.filter((key) => !enKeys.includes(key));
  const onlyEn = enKeys.filter((key) => !zhKeys.includes(key));
  check("no key exists only in Chinese", onlyZh.length === 0, onlyZh.join(", "));
  check("no key exists only in English", onlyEn.length === 0, onlyEn.join(", "));

  // …and every key is actually READ somewhere. A key no component asks for is
  // maintained in two languages forever and shown to nobody: `entry.label` was
  // exactly that (the Plugins page names the card from `package.json` +
  // `locale/`, and the in-card heading reads `panel.title`), so it sat in both
  // dictionaries with zero call sites and green tests. Same failure shape as
  // PITFALLS §29 — scaffolding with no consumer and no watcher.
  //
  // Only keys a text scan can judge are in scope. Two families are exempt and
  // the exemption is written out rather than hidden behind a pattern:
  //   - `llm.level.*` / `llm.src.*` are built at runtime by `dictKey()` from
  //     Host-enumerated values, so no literal exists to find;
  //   - keys reached through a VARIABLE (`tt(key)`, `tt(absentKey)` in
  //     `provider-controls.ts`) cannot be resolved statically. Listing them here
  //     is the honest statement that this check covers the literal-key surface
  //     only — the alternative (pretending to resolve them) would be a check
  //     that can be wrong, which is worse than one with a written boundary.
  const DYNAMIC = new Set([
    // Keys reached through a VARIABLE: `tt(absentKey)` in `provider-controls.ts`
    // over the `drawAbsentKey` table — the only literals the scans cannot
    // resolve. This set used to shelter ten more keys behind the "dynamic"
    // label that no component ever read; those are gone with their dictionary
    // rows, and the check below re-proves the remaining three are the
    // genuinely unreachable ones.
    "draw.noTools", "draw.noToolsPeer", "draw.noToolsRefused"
  ]);
  const clientFiles = (await readdir(new URL("../src/client", import.meta.url), { recursive: true }))
    .filter((name) => name.endsWith(".ts") && !name.endsWith("i18n.ts"));
  const usedKeys = new Set();
  for (const name of clientFiles) {
    const text = await readFile(new URL(`../src/client/${name}`, import.meta.url), "utf8");
    for (const m of text.matchAll(/\btt\(\s*"([^"]+)"/g)) usedKeys.add(m[1]);
    // A key reached through an EXPRESSION rather than a literal right after the
    // paren: `tt(a ? "auth.portalHint" : "auth.registerHint")`,
    // `tt(\`section.${open ? "collapse" : "expand"}\`)`. Both spellings are
    // ordinary call sites a human reads, so scanning for the `namespace.key`
    // shape anywhere in a client module covers them without pretending to parse
    // the expression.
    for (const m of text.matchAll(/["'`]([a-z][\w]*(?:\.[\w-]+)+)["'`]/g)) usedKeys.add(m[1]);
    // Tables whose VALUES are dictionary keys: `GUIDANCE_BY_CODE` /
    // `REFUSAL_TEXT` in `snapshot.ts` map a wire code or a tab id to a key
    // (typed `Record<string, DictionaryKey>`), and `raccoon-tab`/`panel-page`
    // map tab ids the same way. Those literals are consumed at runtime through
    // the table, so the scans above cannot see them.
    for (const m of text.matchAll(/:\s*"([a-z][\w]*(?:\.[\w-]+)+)"/g)) usedKeys.add(m[1]);
  }
  const unused = zhKeys.filter((key) => !usedKeys.has(key) && !DYNAMIC.has(key) && !key.startsWith("llm.level.") && !key.startsWith("llm.src."));
  check("every statically-visible dictionary key is read by something", unused.length === 0,
    unused.join(", "));

  // The plugin's NAME is stated in three places, and two of them sit on the
  // same screen: the Plugins-page card title comes from `locale/<lang>.json`'s
  // `meta.title` (the shell's own lookup, PITFALLS §27), while the heading
  // inside the opened card comes from the panel dictionary's `panel.title`.
  // Nothing joined them, so the card could read 「商汤 Token Plan 接入全家桶」
  // on one surface and 「商汤接入」 on the other with every test green — two
  // names for one plugin, differing by a whole tab's worth of description. The
  // pair is pinned here so the two surfaces cannot drift apart silently.
  //
  // `package.json`'s `displayName` is deliberately NOT part of this: that one
  // names the package in npm/marketplace listings (English by convention) and
  // is not shown on either card surface.
  const localeZh = JSON.parse(await readFile(new URL("../locale/zh.json", import.meta.url), "utf8"));
  const localeEn = JSON.parse(await readFile(new URL("../locale/en.json", import.meta.url), "utf8"));
  check("the zh card name and the in-card title agree",
    localeZh?.meta?.title === dictionaries.zh["panel.title"],
    `locale=${localeZh?.meta?.title} panel=${dictionaries.zh["panel.title"]}`);
  check("the en card name and the in-card title agree",
    localeEn?.meta?.title === dictionaries.en["panel.title"],
    `locale=${localeEn?.meta?.title} panel=${dictionaries.en["panel.title"]}`);
}

// === F4. the panel's rhythm comes from the Host, not from a literal ======
// The bundle used to hold "poll every 30 s" and "cached 60s" as numbers while
// the Host held the real ones. Those are the kind of pair that drifts the first
// time either side is tuned, so the bundle is checked for literals rather than
// for behaviour it cannot exercise here.
//
// The check targets the POLL timer specifically: `setInterval(run, cadenceMs)`
// in `PanelPage`, whose cadence the Host states in every snapshot. The form's
// 1-second countdown timer is unrelated to polling and may stay a literal.
{
  // The cadence machinery now lives in the extracted `useSnapshotPolling` hook
  // (panel-page.ts owns only JSX + the non-polling state), and since the
  // visibility/back-off loop was hoisted into the shared
  // `use-polling-interval.ts` (the Raccoon tab drives the same loop), the
  // literal-free cadence assertion follows it there. Same rule, new home: the
  // check is about "the timer takes a STATED cadence", wherever that timer is
  // written — and it must stay a single occurrence, because two would mean two
  // loops that could drift apart again.
  const hookSource = await readFile(new URL("../src/client/use-snapshot-polling.ts", import.meta.url), "utf8");
  const pageSource = await readFile(new URL("../src/client/panel-page.ts", import.meta.url), "utf8");
  const loopSource = await readFile(new URL("../src/client/use-polling-interval.ts", import.meta.url), "utf8");
  const pollTimers = loopSource.match(/setInterval\(\w+,\s*[^)]*\)/g) ?? [];
  check("the poll timer takes a stated cadence, not a literal",
    pollTimers.length === 1 && /\d/.test(pollTimers[0]) === false,
    pollTimers.join(" | "));
  // The loop the quota hook shares with the Raccoon tab: the two tabs must not
  // grow separate intervals again (the visibility pause and the back-off are
  // exactly what drifted), so both are pinned to the one hook.
  const raccoonSource = await readFile(new URL("../src/client/raccoon-tab.ts", import.meta.url), "utf8");
  check("both tabs drive the one shared polling loop",
    /usePollingInterval\(/.test(hookSource) && /usePollingInterval\(/.test(raccoonSource)
      && !/setInterval\(/.test(hookSource) && !/setInterval\(/.test(raccoonSource),
    "a tab grew its own setInterval");
  // The back-off is a real number, so pin it: a "60_000" that silently becomes
  // 6 s would be faster than the cadence it is backing off from.
  const backoff = loopSource.match(/ERROR_BACKOFF_MS\s*=\s*(\d+_\d+|\d+)/) ?? [];
  check("the failure back-off is at least a minute",
    Number(String(backoff[1] ?? "0").replace(/_/g, "")) >= 60_000,
    `${backoff[1] ?? "not found"}`);
  check("the cache note quotes the snapshot's own number",
    /cache:\s*data\?\.cacheSeconds/.test(pageSource),
    (pageSource.match(/cache:[^,}]*cacheSeconds[^)]*\)/g) ?? []).join(" | "));

  // The INITIAL cadence — what the first frame polls at, before any snapshot
  // has stated one — is the other literal the Host owns too:
  // `CONFIG_DEFAULTS.pollSeconds` is the number every snapshot states. The
  // raccoon tab's fallback is pinned to the route's constant by
  // `raccoon-status.test.mjs` B8; this one was left unpinned, so retuning the
  // Host default left the quota tab polling at the old rate with nothing red.
  // The literal carries an underscore (`30_000`), the repo's own convention
  // for thousands in a number literal, which also anchors this to the cadence
  // state and nothing else in this file. It is now the hook's default
  // parameter (`useSnapshotPolling(defaultCadenceMs = 30_000)`), so the regex
  // matches the `= 30_000` default rather than an inline `useState(30_000)`.
  const initialCadence = hookSource.match(/defaultCadenceMs\s*=\s*(\d+_\d+)/) ?? [];
  check("the initial cadence equals the Host's own default",
    Number(initialCadence[1]?.replace(/_/g, "")) === CONFIG_DEFAULTS.pollSeconds * 1000,
    `${initialCadence[1] ?? "not found"} vs ${CONFIG_DEFAULTS.pollSeconds}s`);
}

// === F5. the API tab's card order and its open-by-default set ==============
// The three cards answer "what did the reader come here for", not "what
// depends on what": 语言模型 and 出图工具 lead and open, the API key editor
// trails because it is the PREREQUISITE they point back at. Both halves have
// drifted before — the cards were reordered once while a hint inside one of
// them still said 「在上方保存 API Key」, pointing at a card that had moved
// below it. So: pin the order, pin the defaults, and pin the hint to a CARD
// NAME rather than a direction (a name survives a reorder, "上方" does not).
{
  const source = await readFile(new URL("../src/client/panel-page.ts", import.meta.url), "utf8");
  const order = [...source.matchAll(/title:\s*tt\("([^"]+)"\)/g)].map((m) => m[1]);
  const at = (key) => order.indexOf(key);
  check("the API tab's three cards are all rendered as sections",
    at("llm.providerTitle") >= 0 && at("draw.title") >= 0 && at("llm.title") >= 0,
    order.join(" | "));
  check("语言模型 leads, 出图工具 follows, API Key trails last",
    at("llm.providerTitle") < at("draw.title") && at("draw.title") < at("llm.title"),
    `providerTitle@${at("llm.providerTitle")} draw@${at("draw.title")} llm@${at("llm.title")}`);

  // `openSections` is the FIRST half of a destructured pair, so the `=` sits
  // after `setOpenSections]` — anchoring on `openSections\s*=useState` matches
  // nothing and silently degrades to "no defaults found" (which reads as a
  // pass if the empty object is not itself checked).
  const defaults = Object.fromEntries(
    [...(source.match(/\[openSections,[^\n]*useState\(\{([^}]*)\}\)/)?.[1] ?? "")
      .matchAll(/(\w+):\s*(true|false)/g)].map((m) => [m[1], m[2] === "true"])
  );
  check("the panel's open-by-default map was actually read (not silently empty)",
    Object.keys(defaults).length >= 6, JSON.stringify(defaults));
  check("语言模型 and 出图工具 start expanded, the key editor starts collapsed",
    defaults.provider === true && defaults.draw === true && defaults.llm === false,
    JSON.stringify(defaults));

  // A cross-card hint must name the card, never point up or down: the two
  // cards it connects have already swapped places once.
  const dict = dictionaries.zh;
  check("the cross-card hint names the API Key card instead of a direction",
    /API Key/.test(dict["llm.rosterEmpty"] ?? "") && !/上方|下方/.test(dict["llm.rosterEmpty"] ?? ""),
    dict["llm.rosterEmpty"]);
  check("the English hint matches the Chinese one on this point",
    !/\babove\b|\bbelow\b/.test(dictionaries.en["llm.rosterEmpty"] ?? ""),
    dictionaries.en["llm.rosterEmpty"]);
}

// === F6. every key the panel ASKS for exists, in both languages ============
// F3 above proves the two dictionaries agree with each other. It cannot see
// the other half of the pair: a key that is in neither dictionary — or is
// spelled differently in the component than in the dictionary — renders as
// the RAW KEY on screen. That is invisible to the render suite by design: it
// drives the components with an identity `tt` and therefore asserts the key
// NAMES a frame asks for, which is exactly the thing that is wrong. `tt` also
// falls back to the key rather than throwing, so nothing else catches it
// either. So the bundle's own source is scanned for the keys it asks for.
//
// The scanner is structural, not "every quoted string": an argument may be a
// ternary whose CONDITION compares against a wire code (`code ===
// "account_locked" ? "auth.locked" : …`), and those codes are not dictionary
// keys. Only key POSITIONS are collected — a whole argument, or a branch of a
// ternary in argument position — and a template argument is recorded as a
// dynamic FAMILY (`llm.level.…`) that must be covered by an enum from the
// Host, since the client cannot enumerate the values the Host sends.
{
  const DIRECTORY = new URL("../src/client/", import.meta.url);
  const files = (await readdir(DIRECTORY)).filter((name) => name.endsWith(".ts") && name !== "i18n.ts");
  check("the bundle's sources were actually found (not silently none)", files.length >= 10, files.join(", "));

  // Split a `tt(...)` argument on its TOP-LEVEL `?`/`:` — skipping `?.`, `??`,
  // string and template literals, and anything inside brackets — so the
  // branches of a ternary come out as separate expressions while an optional
  // chain in the condition does not split the argument in two.
  const branchesOf = (argument) => {
    const parts = [];
    let depth = 0;
    let start = 0;
    let quote = null;
    for (let index = 0; index < argument.length; index += 1) {
      const char = argument[index];
      if (quote !== null) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") depth -= 1;
      else if (depth === 0 && (char === "?" || char === ":")) {
        // `?.` is a chain, `??` is a nullish default; neither is a ternary.
        if (argument[index + 1] === "." || char === "?" && argument[index + 1] === "?") continue;
        parts.push(argument.slice(start, index));
        start = index + 1;
      }
    }
    parts.push(argument.slice(start));
    return parts.map((part) => part.trim());
  };

  // The `tt(` call sites, with the balanced argument text that follows each.
  const callsOf = (source) => {
    const out = [];
    const opener = /(?<![\w.$])tt\(/g;
    for (let match = opener.exec(source); match !== null; match = opener.exec(source)) {
      let depth = 1;
      let index = match.index + match[0].length;
      const from = index;
      let quote = null;
      for (; index < source.length && depth > 0; index += 1) {
        const char = source[index];
        if (quote !== null) {
          if (char === "\\") index += 1;
          else if (char === quote) quote = null;
          continue;
        }
        if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
        if (char === "(") depth += 1;
        else if (char === ")") depth -= 1;
      }
      out.push(source.slice(from, index - 1));
    }
    return out;
  };

  const asked = new Set();
  const families = new Set();
  const deferred = new Set();
  const conditions = new Set();
  let sites = 0;
  for (const name of files) {
    const source = await readFile(new URL(name, DIRECTORY), "utf8");
    for (const argument of callsOf(source)) {
      sites += 1;
      for (const branch of branchesOf(argument)) {
        const literal = /^"([^"]*)"$/.exec(branch);
        if (literal !== null) {
          if (literal[1].includes(".")) asked.add(literal[1]);
          continue;
        }
        const template = /^`([^`$]*)\$\{/.exec(branch);
        if (template !== null && template[1].includes(".")) { families.add(template[1]); continue; }
        // A `dictKey("<family>", value)` call is the same family spelled through
        // the helper instead of a template literal: the family cannot be listed
        // in the dictionary either way, so it has to be pinned the same way.
        // The cast lives in `runtime.ts` `dictKey` (the ONE escape from the
        // `DictionaryKey` type), and the family name is its first argument.
        const dictKey = /^dictKey\("([^"]+)",\s*/.exec(branch);
        if (dictKey !== null && dictKey[1].includes(".")) { families.add(`${dictKey[1]}.`); continue; }
        // An identifier or table lookup in key position: the KEYS come from a
        // table the render suite already checks VALUE BY VALUE, so record the
        // site and let F6b below pin those tables into the dictionaries.
        // A ternary's CONDITION also lands here (`code === "account_locked"`)
        // and is not a key source, so the two are kept apart: bare identifiers
        // and `TABLE[...]` are key sources, everything else is a condition.
        if (/^[A-Za-z_$][\w$]*$/.test(branch) || /^[A-Za-z_$][\w$]*\[[^\]]*\]$/.test(branch)) deferred.add(branch);
        else if (branch !== "") conditions.add(branch);
      }
    }
  }
  check("the scan reached the whole bundle (tt call sites, not zero)", sites >= 100, `${sites} sites in ${files.length} files`);
  check("key-shaped literals were collected (an empty set passes vacuously)",
    asked.size >= 80, `${asked.size} distinct keys`);

  const zh = dictionaries.zh;
  const en = dictionaries.en;
  const missing = [...asked].filter((key) => !(key in zh) || !(key in en));
  check("every key the bundle asks for exists in both languages",
    missing.length === 0,
    missing.map((key) => `${key} (${key in zh ? "zh" : "∅"}/${key in en ? "en" : "∅"})`).join(", "));

  // The dynamic families the client cannot enumerate: their VALUES come from
  // the Host, so the Host's own lists are what they are checked against —
  // textually, because neither list is reachable without importing the Host
  // module (the ladder is module-private, the key sources are a JSDoc union).
  // A level the Host adds therefore turns this red until it has a name.
  check("the dynamic key families were found", families.size >= 2, [...families].join(", "));
  const llmSource = await readFile(new URL("../src/host/llm-models.ts", import.meta.url), "utf8");
  const keyStoreSource = await readFile(new URL("../src/host/api-key-store.ts", import.meta.url), "utf8");
  const ladder = (llmSource.match(/THINKING_LADDER\s*=\s*\[([^\]]*)\]/)?.[1] ?? "")
    .match(/"([^"]+)"/g)?.map((quoted) => quoted.slice(1, -1)) ?? [];
  const sources = [...new Set((keyStoreSource.match(/source:\s*"([^"]+)"/g) ?? [])
    .map((entry) => /"([^"]+)"/.exec(entry)[1]))];
  check("the Host's thinking ladder was actually read", ladder.length >= 5, ladder.join(", "));
  check("the Host's key sources were actually read", sources.length >= 2, sources.join(", "));
  const familyKeys = [...ladder.map((level) => `llm.level.${level}`), ...sources.map((source) => `llm.src.${source}`)];
  const familyMissing = familyKeys.filter((key) => !(key in zh) || !(key in en));
  check("every thinking level and key source the Host can send has a name",
    familyMissing.length === 0,
    familyMissing.length > 0 ? familyMissing.join(", ") : `${familyKeys.length} keys checked`);

  // The detail a hit on this closed list must say HOW to fix it, not just that
  // it broke. A new table-driven `tt` identifier is a legitimate change; the
  // right action is to register it here (plus the i18n keys), not to weaken the
  // check. Without this line the first hit reads as "some suite went red" and
  // costs a round trip to interpret — which is exactly what happened when
  // `DrawSwitch` introduced `tt(absentKey)`.
  const tableDrivenDetail = (found) => {
    const expected = "absentKey,guidanceKey,open,quotaGuidanceKey,refusalKey".split(",");
    const foundIds = [...found].sort().join(",");
    if (foundIds === expected.join(",")) {
      return `identifiers: ${foundIds} | conditions: ${[...conditions].sort().join(", ")}`;
    }
    const added = [...found].filter((id) => !expected.includes(id)).join(", ");
    const missing = expected.filter((id) => !found.has(id)).join(", ");
    return `新增 table-driven tt 标识符: ${added || "无"}; 缺失: ${missing || "无"} —— 把新标识符补进本检查的期望清单（并确保 i18n 中英都有对应键），别放宽或删除本检查`;
  };

  // F6b: the table-driven arguments. `GUIDANCE_BY_CODE` values and
  // `REFUSAL_TEXT` values are the keys those sites pass to `tt`, and they are
  // only as good as the dictionary behind them. `refusalKey` is the account
  // form's local for a `REFUSAL_TEXT[code]` lookup (it reads the key into a
  // name so it can tell an interpolated value from a plain one), so it carries
  // the same dictionary obligation — a table value is only checked when it is
  // handed to `tt` directly, which is what this list records. `absentKey` is
  // `DrawSwitch`'s local for a `drawToolNote` → i18n-key lookup; adding a
  // reason to the host's `DrawToolAbsentReason` union must therefore land here
  // AND in `DRAW_ABSENT_KEY`, which `Record<...>` already forces at compile
  // time.
  check("the table-driven tt sites are the ones expected",
    [...deferred].sort().join(",") === "absentKey,guidanceKey,open,quotaGuidanceKey,refusalKey",
    tableDrivenDetail(deferred));
  const tableKeys = [...Object.values(tables.GUIDANCE_BY_CODE ?? {}), ...Object.values(tables.REFUSAL_TEXT ?? {})];
  const tableMissing = [...new Set(tableKeys)].filter((key) => !(key in zh) || !(key in en));
  check("every table value the panel can hand to tt is a real key in both languages",
    tableMissing.length === 0,
    tableMissing.length > 0 ? tableMissing.join(", ") : `${new Set(tableKeys).size} keys checked`);
}

// === G. the checks are running the shipped module, not a stale copy ======
// Reaching here at all means client.js loaded and materialized its factory.
{
  const result = view(healthy);
  check("the decision was read from the shipped client", typeof result === "object" && result !== null);
  check("the reader was read from the shipped client", typeof interpretSnapshot === "function");
  check("a successful body is read as data", interpretSnapshot(healthy).data === healthy);
  check("a failed body is read as an error", interpretSnapshot({ ok: false, code: "x" }).data === null);
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);



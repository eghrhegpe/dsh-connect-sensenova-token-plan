/**
 * The SHIPPED client.js, evaluated in a jsdom window and rendered by REAL React.
 *
 * `render.test.mjs` answers the same question ("what reaches the screen")
 * through `client-surface.js`: the client SOURCE loaded into Node, a recording
 * `h` instead of React, hooks stubbed to their initial value. That stand-in is
 * deliberate — and it has two documented edges, both recorded in
 * `docs/TESTING.md` and `docs/QODER-GAP.md` §4/§6.2:
 *
 *   1. it runs the source, not the bundle — the artifact was never proven to
 *      load, register, or render;
 *   2. it cannot mount hook components — faking the hook contract would test
 *      the fake, so `AccountForm` stayed "a documented gap rather than a
 *      pretended one".
 *
 * This suite closes both. It reads the root `client.js` artifact,
 * evals it inside a jsdom realm with a `window.__ModuleLoader__` installed —
 * exactly the seam the browser Host uses — materializes the factory with the
 * REAL react from devDependencies, and mounts it with `react-dom/client` into
 * a real document. From there it checks what only a real renderer can show:
 * DOM attribute/style mapping of the quota card's arithmetic, the `useState`
 * round-trips of the account form (controlled inputs, the show-password flip,
 * the empty-field refusal, and — a red-line-1 assertion — the password
 * leaving component state the moment the sign-in lands), the ModelPicker's
 * draft/save state machine (the "saved" claim only lands when a poll echoes
 * the write; a refusal keeps the edits visible), and the PanelPage's polling
 * lifecycle on jsdom's REAL timers (the loading frame, the Host-stated
 * cadence, the unmount teardown).
 *
 * Deliberately NOT adopted from the qoder shape this mirrors: the
 * bundle-text scraping. The artifact already exposes the same `panel` test
 * surface the source does, so there is nothing to scrape; freshness of the
 * artifact stays `build-gate`'s job (this suite loads whatever `client.js` is
 * on disk, exactly as the browser would).
 *
 * Heavy devDeps (jsdom/react/react-dom) gate this suite: they are installed
 * in CI's offline job (`npm install --legacy-peer-deps`), so a SKIP here is an
 * environment fact, not a pass — and a red here in CI is a regression
 * (PITFALS §30's green-possibility rule, applied honestly).
 *
 * Fake credentials only; the stubbed fetch never leaves the jsdom realm and
 * no check detail may carry the password sentinel.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { envSkip } from "./env-skip.mjs";
import { results, check, finish } from "./harness.mjs";


// React's missing-`key` warning, collected for the WHOLE run.
//
// It cannot be collected around a single mount: React warns once per component
// NAME and then stays quiet (`ownerHasKeyUseWarning`), so a per-mount spy passes
// vacuously on an already-warned component — observed here as an empty list while
// stderr carried four warnings. The spy is installed for the run and forwards to
// the real console, so nothing is hidden; the assertion at the end of §H reads
// the run's own count. The DOM never carries a key, so the console is the only
// observable a missing one has.
const reactKeyWarnings = [];
const realConsoleError = console.error;
console.error = (...args) => {
  const line = args.map((arg) => String(arg)).join(" ");
  if (line.includes('unique "key"')) reactKeyWarnings.push(line);
  realConsoleError.call(console, ...args);
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromHere = createRequire(import.meta.url);

// --- probe the heavy tier: loud SKIP when the devDeps are absent ----------
const HEAVY = ["jsdom", "react", "react-dom/client"];
const missing = HEAVY.filter((specifier) => {
  try {
    requireFromHere.resolve(specifier);
    return false;
  } catch {
    return true;
  }
});
if (missing.length > 0) {
  envSkip("render-dom", `${missing.join(", ")} not installed in this project's node_modules.`,
    [
      "the SHIPPED client.js was NOT evaluated against REAL React",
      "(CI's offline job installs them, so CI always runs this suite for real)",
      "a GLOBAL react is deliberately not a fallback — the verdict must match the version pinned in devDependencies",
      "Bootstrap dev deps with: npm install --legacy-peer-deps",
    ]);
}

const { JSDOM } = await import("jsdom");

// --- the artifact, evaluated in a real window -----------------------------
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "http://127.0.0.1/"
});
const win = dom.window;

// react-dom executes in the NODE realm and probes the global `window` at
// import time and on every update (`window.event` in resolveUpdatePriority).
// Mirror the jsdom window into this realm BEFORE importing react-dom — the
// same step a vitest/jest "environment: jsdom" setup performs implicitly.
globalThis.window = win;
globalThis.document = win.document;

const reactModule = await import("react");
/** The CJS surface of react — exactly what a browser module table's `require("react")` hands over. */
const React = reactModule.default ?? reactModule;
const { createRoot } = await import("react-dom/client");
if (typeof React.act !== "function") {
  // The suite's own contract, checked rather than assumed: React >= 19 ships
  // `act` on the package itself. A pinned devDep drift lands here, loudly.
  console.error("FAIL render-dom — the resolved react has no `act` export (needs react >= 19)");
  process.exit(1);
}
const act = React.act;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The registration id the client bundle declares (mirrors `client-surface.js`). */
const CLIENT_ID = "dsh-connect-sensenova-token-plan";
const ACCOUNT_PATH = `/api/${CLIENT_ID}/account`;
const MODELS_PATH = `/api/${CLIENT_ID}/models`;
const SNAPSHOT_PATH = `/api/${CLIENT_ID}/snapshot`;
const RACCOON_PATH = `/api/${CLIENT_ID}/raccoon`;

const registrations = [];
win.__ModuleLoader__ = { load: (registration) => registrations.push(registration) };
win.eval(readFileSync(join(root, "client.js"), "utf8"));

const registration = registrations.find((entry) => entry.id === CLIENT_ID);
check("the shipped bundle registers with the loader seam a browser uses",
  registration !== undefined,
  `captured ${JSON.stringify(registrations.map((r) => r.id))}`);
if (registration === undefined) {
  console.log(JSON.stringify(results, null, 2));
  console.error(`\n1/1 check(s) FAILED — client.js changed its registration shape`);
  process.exit(1);
}

// The same one-package rule `client-surface.js` enforces: anything the client
// starts importing must fail HERE first, against the real artifact this time.
const materialized = registration.factory((specifier) => {
  if (specifier === "react") return React;
  throw new Error(
    `render-dom: the shipped bundle required "${specifier}", which this loader does not provide. ` +
    "The shipped bundle must stay dependency-free apart from react."
  );
});
check("the materialized artifact carries the Host half (inject/apply)",
  Array.isArray(materialized.inject) && typeof materialized.apply === "function",
  JSON.stringify({ inject: materialized.inject, apply: typeof materialized.apply }));
const panel = materialized.panel;
check("the materialized artifact exposes the same panel test surface",
  typeof panel?.components?.QuotaCard === "function" && typeof panel.components.AccountForm === "function",
  Object.keys(panel?.components ?? {}).join(","));

const tt = (key) => key;

/** One inline style property as react-dom actually wrote it ("" when absent). */
const css = (el, prop) => (el?.style?.[prop] ?? "");
// Epoch SECONDS, `hours` from now — the unit `parsers.ts`' `epochSeconds()`
// delivers `reset_at` in and the unit every client formatter (`when`,
// `clockLong`, the `Date` constructor) takes. Fixtures that hand a window a
// millisecond `resetAt` read as "already reset" and silently drop the clock, so
// the unit is built here rather than written inline at each call site.
const inHours = (hours) => Math.floor(Date.now() / 1000) + hours * 3600;

/** Mount `element` into a fresh jsdom container under a real react-dom root. */
function mount(element) {
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const r = createRoot(host);
  act(() => r.render(element));
  return {
    host,
    rerender(element) { act(() => r.render(element)); },
    unmount() {
      act(() => r.unmount());
      host.remove();
    }
  };
}

/** Drive a controlled input the way a real browser does: native setter + input event. */
function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

// === A. the quota card's numbers survive REAL React's DOM mapping ==========
// render.test.mjs sees the stand-in's element tree; this sees what a browser
// would actually paint: text nodes, the `aria-valuenow` ATTRIBUTE react-dom
// sets, and the inline `width` STYLE it applies.
{
  const same = { label: "pool.window5h", window: { limit: 60000, used: 12345, remaining: 47655, resetAt: 1800000000 }, tt };
  const card = mount(React.createElement(panel.components.QuotaCard, same));
  const text = card.host.textContent;
  check("the used figure renders against the limit in the real DOM",
    text.includes("12,345 / 60,000"), text);
  check("the headline is the bare used percentage",
    text.includes("20.6%") && !text.includes("79.4%"), text);
  check("the raw remaining count is not on screen", !text.includes("47,655"), text);
  check("the reset time renders", text.includes("pool.reset"), text);

  const bar = card.host.querySelector("[aria-valuenow]");
  check("assistive tech reads the same percentage through a real attribute",
    bar?.getAttribute("aria-valuenow") === "20.6", String(bar?.getAttribute("aria-valuenow")));
  const fills = [...card.host.querySelectorAll("*")].filter((el) => el.style.width === "20.575%");
  check("the bar's fill width reaches the DOM as the same fraction",
    fills.length === 1, `matched ${fills.length} element(s) with style.width 20.575%`);

  card.unmount();
  check("unmounting the quota card empties the container", card.host.childNodes.length === 0);
}

// === A2. an unknown-limit window must NOT render "0 / 0" =================
// The headline and bar already guard `limit > 0` (rendering "—" / empty);
// the used/limit caption sat one line below them behind no such guard, so a
// pool the platform declined to cap was shown as "已用 0 / 0". Regression
// surface for the cards.ts:101 fix.
{
  const unknown = { label: "pool.window5h", window: { used: 0, limit: 0, remaining: undefined }, tt };
  const card = mount(React.createElement(panel.components.QuotaCard, unknown));
  const text = card.host.textContent;
  check("an unknown-limit window's caption reads \"—\", not \"0 / 0\"",
    !text.includes("0 / 0") && text.includes("—"), text);
  const bareUnknown = { label: "pool.window5h", window: { used: undefined, limit: undefined }, tt };
  const card2 = mount(React.createElement(panel.components.QuotaCard, bareUnknown));
  check("a completely absent window still shows no fake ratio",
    !card2.host.textContent.includes("/"), card2.host.textContent);
  card.unmount();
  card2.unmount();
}

// === B. AccountForm: the hook contract, REAL for the first time ============
// Every check in this block runs `useState` against react-dom's dispatcher —
// the gap `docs/TESTING.md` kept open on purpose ("faking the hook contract
// would test the fake").
{
  let doneCalls = 0;
  const form = mount(React.createElement(panel.components.AccountForm, { tt, onDone: () => { doneCalls++; } }));
  const host = form.host;
  const text = () => host.textContent;

  const user = host.querySelector('input[autocomplete="username"]');
  const password = host.querySelector('input[autocomplete="current-password"]');
  const formEl = host.querySelector("form");
  const submitBtn = host.querySelector('button[type="submit"]');
  check("the form mounts and both fields reach the screen",
    user !== null && password !== null && text().includes("auth.username") && text().includes("auth.password"),
    text().slice(0, 160));
  check("the password starts behind the dots", password.type === "password", password.type);
  check("the register hint shows when no account exists", text().includes("auth.registerHint"), text().slice(0, 200));

  // useState round-trip through React's controlled-input contract.
  typeInto(user, "  demo-user  ");
  check("typing round-trips through useState into the controlled value",
    user.value === "  demo-user  ", JSON.stringify(user.value));

  // The show/hide toggle: one state flips two attributes/text the DOM shows.
  const toggle = [...host.querySelectorAll('button[type="button"]')].at(-1);
  act(() => toggle.click());
  check("the show-password toggle flips the real input type",
    password.type === "text", password.type);
  check("the toggle's own label follows the state", text().includes("auth.hide"), text().slice(0, 240));

  // Empty password → the pure-state refusal branch. No fetch may fire.
  const fetchCalls = [];
  win.fetch = (path, init) => {
    fetchCalls.push({ path, init });
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
  };
  act(() => formEl.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })));
  check("submitting an empty password refuses in-component and never reaches the Host",
    host.querySelector('p[role="alert"]')?.textContent === "auth.empty" && fetchCalls.length === 0,
    `alert=${host.querySelector('p[role="alert"]')?.textContent} fetches=${fetchCalls.length}`);

  // Success path (fake credentials, stubbed realm-local fetch).
  const PASSWORD_SENTINEL = "sentinel-not-a-real-secret";
  typeInto(password, PASSWORD_SENTINEL);
  await act(async () => {
    formEl.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  });
  const sent = fetchCalls.length === 1 ? JSON.parse(fetchCalls[0].init.body) : null;
  check("the sign-in POSTs once to the account route with the trimmed username",
    fetchCalls.length === 1 && fetchCalls[0].path === ACCOUNT_PATH && sent?.username === "demo-user",
    fetchCalls.map((c) => c.path).join(","));
  // Red line 1, asserted against the SHIPPED bundle: the password bytes must
  // leave component state the moment the Host confirms. (The sentinel itself
  // is never written into any detail string.)
  check("the password reaches the Host and is cleared from component state on success",
    sent?.password === PASSWORD_SENTINEL && password.value === "",
    `cleared=${password.value === ""}`);
  check("the saved outcome note and the parent callback land",
    host.querySelector('p[role="status"]')?.textContent === "auth.working" && doneCalls === 1,
    `status=${host.querySelector('p[role="status"]')?.textContent} onDone=${doneCalls}`);
  check("busy releases back to the submit label",
    submitBtn.textContent === "auth.submit", submitBtn.textContent);

  form.unmount();
  check("unmounting the form empties the container", host.childNodes.length === 0);
}

// === C. ModelPicker: the draft/save state machine, REAL for the first time ==
// This block renders with the REAL en dictionary, not the identity `tt`: the
// draft's verdict is a FIGURE ("2 ticked / 3 total") that the client's own
// `format` interpolates, and only the shipped template carries the slots.
// The Host's value never moves under the component — the test rerenders to
// simulate the poll that echoes a write. Three rosters make the middle case
// reachable at all: `allowListFor` spells "all ticked" as the EMPTY list and
// "nothing" as the hide-all sentinel, so a two-model roster would collapse
// every single click into an extreme. The extremes get their own round trip.
{
  const en = panel.dictionaries.en;
  const ttEn = (key) => (typeof en[key] === "string" ? en[key] : key);
  const models = [
    { id: "m-a", name: "Alpha", multiplier: 1 },
    { id: "m-b", name: "Beta", multiplier: 2 },
    { id: "m-c", name: "Gamma", multiplier: 1 }
  ];
  const posts = [];
  win.fetch = (path, init) => {
    posts.push({ path, body: JSON.parse(init.body) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  };
  let pickerDone = 0;
  const pickerProps = (hostIds) => ({
    llm: { models, enabledModelIds: hostIds },
    tt: ttEn,
    onDone: () => { pickerDone++; }
  });
  const picker = mount(React.createElement(panel.components.ModelPicker, pickerProps(["m-a"])));
  const box = (name) => [...picker.host.querySelectorAll('input[type="checkbox"]')]
    .find((el) => el.getAttribute("aria-label") === name);
  const button = (label) => [...picker.host.querySelectorAll("button")]
    .find((el) => el.textContent === label);

  check("the picker starts at the Host's allow-list",
    picker.host.textContent.includes("1 ticked / 3 total")
      && box("Beta")?.checked === false && box("Gamma")?.checked === false,
    picker.host.textContent.slice(0, 160));

  act(() => box("Beta").click());
  check("ticking a row edits the DRAFT: the box moves while the Host prop never did",
    box("Beta")?.checked === true
      && picker.host.textContent.includes("2 ticked / 3 total")
      && picker.host.textContent.includes("Unsaved changes"),
    picker.host.textContent.slice(0, 200));

  await act(async () => { button("Save").click(); });
  check("save POSTs the draft allow-list to the models route once",
    posts.length === 1 && posts[0].path === MODELS_PATH
      && [...posts[0].body.enabledModelIds].sort().join(",") === "m-a,m-b",
    JSON.stringify(posts));
  check("an unechoed save keeps showing the edits — the 'saved' claim waits for the Host",
    picker.host.textContent.includes("Unsaved changes") && !picker.host.textContent.includes("Saved —"),
    picker.host.textContent.slice(-160));

  // The poll echoes the write: the Host value now equals the saved draft.
  picker.rerender(React.createElement(panel.components.ModelPicker,
    pickerProps([...posts[0].body.enabledModelIds])));
  check("the Host echo turns the draft into 'saved' and retires the footer",
    picker.host.querySelector('p[role="status"]')?.textContent === "Saved — the model list has been updated."
      && !picker.host.textContent.includes("Unsaved changes") && pickerDone === 1,
    `${picker.host.querySelector('p[role="status"]')?.textContent} onDone=${pickerDone}`);

  // The all-on extreme: the panel's own canonical spelling of "every model
  // offered" is the EMPTY list (models.ts: `length===0 ? true : includes`).
  // DOM round trip: tick the last box, save posts [], the echoed [] keeps all
  // three boxes ticked — the panel and the Host read the same wire the same way.
  act(() => box("Gamma").click());
  check("ticking up to all reads '3 ticked / 3 total' and re-dirties the draft",
    box("Gamma")?.checked === true
      && picker.host.textContent.includes("3 ticked / 3 total")
      && picker.host.textContent.includes("Unsaved changes")
      && !picker.host.textContent.includes("Saved —"),
    picker.host.textContent.slice(-200));
  await act(async () => { button("Save").click(); });
  check("the all-on draft saves to the empty-list extreme",
    posts.length === 2 && Array.isArray(posts[1].body.enabledModelIds)
      && posts[1].body.enabledModelIds.length === 0,
    JSON.stringify(posts[1]?.body));
  picker.rerender(React.createElement(panel.components.ModelPicker,
    pickerProps(posts[1].body.enabledModelIds)));
  check("the echoed [] keeps every box ticked — the extreme round-trips through the Host",
    box("Alpha")?.checked === true && box("Beta")?.checked === true && box("Gamma")?.checked === true
      && picker.host.querySelector('p[role="status"]')?.textContent === "Saved — the model list has been updated."
      && pickerDone === 2,
    `${box("Alpha")?.checked}/${box("Beta")?.checked}/${box("Gamma")?.checked} onDone=${pickerDone}`);

  act(() => box("Alpha").click());
  check("unticking one row lands back on an explicit subset draft",
    box("Alpha")?.checked === false
      && picker.host.textContent.includes("2 ticked / 3 total")
      && picker.host.textContent.includes("Unsaved changes")
      && !picker.host.textContent.includes("Saved —"),
    picker.host.textContent.slice(-160));

  win.fetch = (path) => {
    posts.push({ path, body: "refused" });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, error: "boom" }) });
  };
  await act(async () => { button("Save").click(); });
  check("a Host refusal lands as an alert, draft intact",
    picker.host.querySelector('p[role="alert"]')?.textContent === "Save failed: boom"
      && picker.host.textContent.includes("Unsaved changes") && box("Alpha")?.checked === false,
    String(picker.host.querySelector('p[role="alert"]')?.textContent));

  act(() => button("Discard").click());
  check("discard drops the draft back to the Host value (the [] extreme) and clears the alert",
    box("Alpha")?.checked === true
      && picker.host.querySelector('p[role="alert"]') === null
      && !picker.host.textContent.includes("Unsaved changes"),
    picker.host.textContent.slice(-160));

  picker.unmount();
  check("unmounting the picker empties the container", picker.host.childNodes.length === 0);
}

// === D. PanelPage: the polling lifecycle on jsdom's REAL timers ============
// render.test.mjs drives the shared loop through a controllable fake
// document/timer world (its H group); this mounts the REAL page and lets
// jsdom's own setInterval run. The claims are lifecycle facts only, timed
// with tolerance: the loading frame exists for exactly the unconcluded first
// attempt, a Host-stated 1 s cadence repeats FASTER than the 30 s default
// could, and unmounting leaves no poll alive behind it.
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let snapshotFetches = 0;
  const healthy = {
    ok: true,
    pools: {
      pools: [{
        id: "p1",
        name: "Plan A",
        poolType: "default",
        window5h: { limit: 60000, used: 12345, remaining: 47655, resetAt: 1800000000 },
        window7d: { limit: 600000, used: 1000, remaining: 599000 }
      }]
    },
    trend: { hours: 24, models: [{ model: "m-a", credits: 900 }, { model: "m-b", credits: 100 }] },
    pollSeconds: 1
  };
  win.fetch = () => {
    snapshotFetches += 1;
    return Promise.resolve({ ok: true, status: 200, json: async () => healthy });
  };
  const page = mount(React.createElement(panel.components.PanelPage, { tt }));
  check("the first frame is the loading line, not the setup form — the loadedOnce gate paints",
    page.host.textContent.includes("panel.loading")
      && !page.host.textContent.includes("auth.username")
      && snapshotFetches === 1,
    `fetches=${snapshotFetches} text=${page.host.textContent.slice(0, 120)}`);

  await act(async () => { await sleep(30); });
  const painted = page.host.textContent;
  check("a landed snapshot paints the pools with their arithmetic",
    painted.includes("Plan A") && painted.includes("12,345 / 60,000")
      && page.host.querySelector("[aria-valuenow]") !== null,
    painted.slice(0, 200));
  check("the trend section draws the declared rows",
    painted.includes("trend.model") && painted.includes("m-a") && painted.includes("900"),
    painted.slice(0, 240));
  check("the tab bar is unconditional: all three tabs reach the screen",
    painted.includes("tab.quota") && painted.includes("tab.api") && painted.includes("tab.raccoon"),
    painted.slice(0, 120));

  const beforeCadence = snapshotFetches;
  await act(async () => { await sleep(2300); });
  check("the Host-stated 1 s cadence drives a real interval",
    snapshotFetches - beforeCadence >= 2,
    `grew by ${snapshotFetches - beforeCadence} in ~2.3 s — the 30 s default could not do that`);

  const atUnmount = snapshotFetches;
  page.unmount();
  await sleep(1300);
  check("unmounting tears the loop down: no poll outlives the panel",
    snapshotFetches === atUnmount,
    `${snapshotFetches - atUnmount} fetch(es) after unmount`);
}

// === E. The composer pill survives a model switch (2026-10-15 regression) ===
// The reported bug: the pill painted only on first load, then vanished after
// the user switched models — forever. The old single-component gate called
// `useSnapshotPolling()` (real hooks) AFTER an ownership early-return, so a
// switch that left the gate rendered fewer hooks than the previous pass and
// React tore the component out of the tree ("Rendered fewer hooks than
// expected"); switching back could never re-add hooks, so the pill stayed
// gone until a page reload. The fix moves the gate to a component boundary
// (outer decides whether the inner pill mounts; all poller hooks live in the
// inner one — opencode-go's `UsagePill`/`ActiveUsage` shape), so every render
// of the outer calls a constant hook count and mount/unmount stays a legal
// React operation. This section drives that switch-out/switch-back on REAL
// react-dom: the old shape fails here at the first rerender, the new shape
// rounds the pill back. A second reported facet is pinned too: an empty
// transient `next` (the picker's in-flight switch frame) must not shadow a
// usable `lastUsed`, or owned models read "no provider" and the pill hides
// even though the selection still belongs to this plugin.
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pillSnapshot = {
    ok: true,
    pools: {
      pools: [{
        id: "p1",
        name: "通用池",
        poolType: "default",
        window5h: { limit: 1000, used: 200, remaining: 800, resetAt: inHours(2) },
        window7d: { limit: 10000, used: 100, remaining: 9900 }
      }]
    },
    trend: { hours: 24, models: [] }
  };
  let pillFetches = 0;
  // The keyed hook the slot system materializes in the real host. The fake must
  // register a REAL hook (useState) in the component's hook list, the way the
  // host's materialized one does: only then does a conditional early-return that
  // skips the poller's hooks actually violate the Rules of Hooks. A plain
  // function would let the old shape limp through this section.
  const selection = { next: { provider: "sensenova-token-plan", model: "deepseek-v4-flash" } };
  const useProjection = () => {
    React.useState(selection);
    return selection;
  };
  // Every request is attributed to its route: the two providers' readings come
  // from two different endpoints, and "which one did the pill actually ask" is
  // the whole isolation claim — a bar count alone would pass a pill that read
  // the snapshot AND the balance.
  const routes = [];
  // Swappable so the Raccoon frames below can change the gateway's answer.
  // 42 150 and not 4 215: `count()` only reaches for a thousands separator at
  // or above 10 000, and a balance figure is exactly where that rule must
  // hold — a comma-less five-digit balance is the reading we would ship wrong.
  let raccoonState = { ok: true, loggedIn: true, balance: 42150 };
  win.fetch = (path) => {
    pillFetches += 1;
    routes.push(path);
    const body = path === RACCOON_PATH ? raccoonState : pillSnapshot;
    // The stall stands in for a real `reset()`: the gateway's answer is served
    // immediately instead of after the hook's own network latency.
    return new Promise((resolve) => setTimeout(
      () => resolve({ ok: true, status: 200, json: async () => body }), 0));
  };
  // `let`: the Raccoon frames below remount the pill through the unmount →
  // mount path a real provider switch takes.
  let pill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  const button = () => pill.host.querySelector("button.dsh-sensenova-composer-pill");
  const text = () => pill.host.textContent;

  await act(async () => { await sleep(0); });
  check("an owned Token Plan model mounts the pill with its two-window reading",
    button() !== null && text().includes("composer.pool5h 20%") && text().includes("composer.pool7d 1%"),
    `fetches=${pillFetches} text=${text().slice(0, 120)}`);
  check("the reset instant rides in the title, not the pill body",
    button()?.getAttribute("title")?.includes("composer.resetAt") === true
      && !text().includes("composer.resetAt"),
    `title=${button()?.getAttribute("title")}`);

  // The switch that used to kill the pill: a model from a foreign provider.
  selection.next = { provider: "openai", model: "gpt-x" };
  let foreignSwitchError = null;
  try {
    pill.rerender(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  } catch (error) {
    foreignSwitchError = error;
  }
  const fetchesWhileForeign = pillFetches;
  check("a foreign-provider model unmounts the pill instead of crashing it",
    foreignSwitchError === null && button() === null && pillFetches === fetchesWhileForeign,
    `error=${foreignSwitchError?.message ?? "none"} button=${button() !== null} fetches=${pillFetches} (stable while foreign: ${pillFetches === fetchesWhileForeign})`);

  // Switching BACK — the exact step the old hook mismatch made unrecoverable.
  selection.next = { provider: "sensenova-token-plan", model: "deepseek-v4-flash" };
  let switchBackError = null;
  try {
    pill.rerender(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  } catch (error) {
    switchBackError = error;
  }
  await act(async () => { await sleep(0); });
  check("switching back to an owned model brings the pill back (the reported 'gone forever')",
    switchBackError === null && button() !== null && text().includes("composer.pool5h 20%") && pillFetches === fetchesWhileForeign + 1,
    `error=${switchBackError?.message ?? "none"} fetches=${pillFetches} text=${text().slice(0, 120)}`);

  // The transient state right after a picker switch: `next` arrives as an
  // empty object before it carries the new selection. An empty `next` must
  // not shadow a still-usable `lastUsed` — the old `next ?? lastUsed` read
  // a provider off `{}` and hid the pill for OWNED models on exactly these
  // frames (the reported switch: the selected model was still a Token Plan
  // one when the pill vanished).
  selection.next = {};
  selection.lastUsed = { provider: "sensenova-token-plan", model: "sensenova-6.8-flash-lite" };
  pill.rerender(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  check("an empty transient `next` does not shadow a usable `lastUsed`",
    button() !== null && text().includes("composer.pool5h 20%"),
    `button=${button() !== null} text=${text().slice(0, 120)}`);

  // A Raccoon model is a DIFFERENT quota universe, so it must read its own
  // gateway's balance — never a Token Plan pool, and never a percentage: the
  // gateway declares no daily/monthly cap, so any share drawn here would be
  // invented. The request log is what proves the isolation; the reading itself
  // proves it stopped borrowing.
  routes.length = 0;
  selection.next = { provider: "sensenova-raccoon", model: "sn-sensenova-6-8-flash" };
  pill.rerender(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  check("a Raccoon model reads the Raccoon route and never the Token Plan snapshot",
    routes.length > 0 && routes.every((path) => path === RACCOON_PATH),
    `routes=${JSON.stringify(routes)}`);
  check("a Raccoon model paints its own credit balance, not Token Plan percentages",
    button() !== null && text().includes("composer.raccoonPrefix · 42,150 composer.balanceUnit")
      && !text().includes("composer.pool5h") && !text().includes("composer.pool7d"),
    `text=${text().slice(0, 160)} title=${button()?.getAttribute("title")}`);

  // `0` is a reading, not a gap: a drained balance must not wear the grey "—"
  // that means "we could not find out" — it is the alarm.
  raccoonState = { ok: true, loggedIn: true, balance: 0 };
  routes.length = 0;
  selection.next = { provider: "sensenova-token-plan", model: "deepseek-v4-flash" };
  pill.rerender(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  routes.length = 0;
  selection.next = { provider: "sensenova-raccoon", model: "sn-sensenova-6-8-flash" };
  pill.rerender(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  const drainedDot = pill.host.querySelector(".dsh-sensenova-composer-pill-dot");
  check("a drained Raccoon balance reads 0 and takes the error tier, never a grey dash",
    text().includes("0 composer.balanceUnit") && !text().includes("—")
      && css(drainedDot, "background").startsWith("var(--dsw-alias-state-error-primary"),
    `text=${text().slice(0, 160)} dot=${css(drainedDot, "background")}`);

  // Signed out is a DIFFERENT fact from unreadable, and the pill has to say
  // which one it is — a grey dash beside a pool percentage was the old answer,
  // and it left the reader guessing. Reaching the new answer takes a REMOUNT:
  // polling reloads on a cadence, not on every render, so a same-branch rerender
  // legitimately keeps the previous reading. Driving it through the unmount →
  // mount path (what a real provider switch does) also checks that nothing
  // caches the old session's balance across the switch.
  raccoonState = { ok: true, loggedIn: false };
  pill.unmount();
  routes.length = 0;
  pill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  check("a signed-out Raccoon session says so in the tooltip instead of guessing",
    routes.length > 0 && routes.every((path) => path === RACCOON_PATH)
      && button()?.getAttribute("title")?.includes("composer.raccoonSignedOut") === true
      && text().includes("—"),
    `routes=${JSON.stringify(routes)} title=${button()?.getAttribute("title")} text=${text().slice(0, 120)}`);

  // Back to Token Plan: the snapshot branch takes over and stops asking the
  // Raccoon route — the reverse of the isolation above.
  raccoonState = { ok: true, loggedIn: true, balance: 42150 };
  routes.length = 0;
  selection.next = { provider: "sensenova-token-plan", model: "deepseek-v4-flash" };
  pill.rerender(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  check("switching back to Token Plan reads only the snapshot again",
    routes.length > 0 && routes.every((path) => path === SNAPSHOT_PATH)
      && text().includes("composer.planPrefix") && text().includes("composer.pool5h 20%"),
    `routes=${JSON.stringify(routes)} text=${text().slice(0, 160)}`);

  pill.unmount();
  check("unmounting the pill leaves no poller alive", pill.host.childNodes.length === 0);
}

// === F. the pill wears the TOOLBAR's skin, not a default button (2026-10-16) ===
// The reported defect: the pill rendered correctly but "样式确实不太不一样" —
// because it had NOTHING but a `className`, and this plugin injects no
// stylesheet, so a browser painted its UA button box (grey fill, black border,
// system font) inside the host's ghost toolbar. A `className` that no
// stylesheet can match is invisible to the user and permanent to the author.
//
// These checks read the REAL inline style react-dom writes, so they fail for
// exactly the defect a screenshot would show: a dropped property, a re-spelled
// literal, or a revert to the unstyled shape. They assert the SHAPE (a property
// is present and carries the host's scale), never the rendered colour — jsdom
// resolves no `var()`, and hard-coding a colour is how a tone swap slips past
// (the same ruling as `render.test.mjs` §C).
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const okSnapshot = {
    ok: true,
    pools: {
      pools: [{
        id: "p1", name: "通用池", poolType: "default",
        window5h: { limit: 1000, used: 200, remaining: 800, resetAt: inHours(1) },
        window7d: { limit: 10000, used: 100, remaining: 9900 }
      }]
    },
    trend: { hours: 24, models: [] }
  };
  win.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => okSnapshot });
  const selection = { next: { provider: "sensenova-token-plan", model: "deepseek-v4-flash" } };
  const useProjection = () => { React.useState(selection); return selection; };
  const pill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });

  const button = pill.host.querySelector("button.dsh-sensenova-composer-pill");
  check("the pill reaches the DOM as a styled element, not a bare className",
    button !== null && typeof button.getAttribute("style") === "string"
      && button.getAttribute("style").length > 0,
    `style=${button?.getAttribute("style") ?? "(absent)"}`);

  // The UA button box has to be gone in BOTH of its spellings: `background`
  // (the fill) and `border-style` (the frame). `border: 0` was tried first and
  // jsdom parses it as `medium`, which would have left the frame standing.
  check("the browser's default button chrome is removed (fill and frame)",
    css(button, "background") === "none" && css(button, "borderStyle") === "none",
    `background=${css(button, "background")} border-style=${css(button, "borderStyle")}`);

  // The host's toolbar neighbours are 28px tall 12px ghost controls; a pill
  // drawn at the plugin card's 13px/30px scale reads as a foreign widget.
  check("the pill is the host's 28px / 12px toolbar scale, not the card's",
    css(button, "height") === "28px" && css(button, "fontSize") === "12px",
    `height=${css(button, "height")} font-size=${css(button, "fontSize")}`);

  // `color: inherit` (not a literal ink) is what lets the shell's theme own the
  // reading, and `fontFamily: inherit` stops a plugin default from changing the
  // digits' width under a CJK-capable host font.
  check("the reading inherits the shell's ink and font rather than hard-coding them",
    css(button, "color") === "inherit" && css(button, "fontFamily") === "inherit",
    `color=${css(button, "color")} font-family=${css(button, "fontFamily")}`);

  // The tier colour must be a HOST TOKEN. `#22c55e` in the source looked fine
  // on this machine's light theme and wrong on every other one — a retheme
  // recolours the window and leaves the pill behind.
  const dot = pill.host.querySelector(".dsh-sensenova-composer-pill-dot");
  const dotBackground = css(dot, "background");
  check("a healthy tier's dot wears the shell's state token, not a plugin hex",
    dotBackground.startsWith("var(--dsw-alias-state-success-primary"),
    `dot background=${dotBackground}`);

  // The reading stays in the host's label ink while things are fine — a tier
  // colour on the text would make a routine 1% as loud as the model picker.
  const reading = pill.host.querySelector(".dsh-sensenova-composer-pill-text");
  check("a healthy reading keeps the host's label ink (only the dot carries the tier)",
    reading !== null && reading.getAttribute("style") === null,
    `text style=${reading?.getAttribute("style") ?? "(absent)"}`);

  // Polling makes the percentages change in place; proportional digits would
  // twitch the whole toolbar every cadence.
  check("the percentages use tabular figures so polling does not reflow the row",
    [...pill.host.querySelectorAll("span")].filter((el) => css(el, "fontVariantNumeric") === "tabular-nums").length === 2,
    `tabular spans=${[...pill.host.querySelectorAll("span")].filter((el) => css(el, "fontVariantNumeric") === "tabular-nums").length}`);

  // An EXHAUSTED window is the one tier that tints the READING as well as the
  // dot. Same ruling as `statError`: a spent quota must not read as a calm
  // 100%. The healthy frame above is the control — identical shape, no ink on
  // the text — so this cannot pass by the reading simply always wearing colour.
  win.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      pools: {
        pools: [{
          id: "p1", name: "通用池", poolType: "default",
          window5h: { limit: 1000, used: 1000, remaining: 0, resetAt: inHours(1) },
          window7d: { limit: 10000, used: 100, remaining: 9900 }
        }]
      },
      trend: { hours: 24, models: [] }
    })
  });
  const spentPill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  const spentDot = spentPill.host.querySelector(".dsh-sensenova-composer-pill-dot");
  const spentReading = spentPill.host.querySelector(".dsh-sensenova-composer-pill-text");
  check("an exhausted window moves BOTH the dot and the reading to the error token",
    css(spentDot, "background").startsWith("var(--dsw-alias-state-error-primary")
      && css(spentReading, "color").startsWith("var(--dsw-alias-state-error-primary"),
    `dot=${css(spentDot, "background")} reading=${css(spentReading, "color")}`);
  spentPill.unmount();

  // The stale frame: the reading failed, so the numbers on screen are old. The
  // mark is a footnote in tertiary ink — if it wore tier colour it would read
  // as a fifth quota window instead of a caveat about the two beside it.
  win.fetch = () => Promise.reject(new Error("snapshot unreachable"));
  const stalePill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  // The stale mark's own leaf span, not the reading wrapper that also contains
  // the word (textContent matches ancestors too).
  const staleMark = [...stalePill.host.querySelectorAll("span")]
    .find((el) => el.children.length === 0 && el.textContent?.includes("composer.stale"));
  check("the stale mark is a tertiary footnote, not a fifth reading",
    staleMark !== undefined && css(staleMark, "color").startsWith("var(--dsw-alias-label-tertiary"),
    `stale span style=${staleMark?.getAttribute("style") ?? "(absent)"} text=${stalePill.host.textContent.slice(0, 120)}`);
  stalePill.unmount();

  pill.unmount();
}

// === G. the reading says WHICH plan it is (2026-10-16) ========================
// The reported gap: "plan、raccoon 前缀" — with both providers on offer in one
// workspace, 「5 小时 1% · 本周 2%」 does not say whose quota is draining. The
// reference plugin answers it with `Go · ` (its plan name) before the figures,
// and that prefix is the reason its pill is readable at a glance. Here the plan
// name comes from the SELECTED PROVIDER, because that is what decides where the
// numbers came from — the prefix is the data decision, not a label.
//
// These read the real inline style react-dom writes, same discipline as §F: the
// prefix's own class is asserted, and its ink is a HOST TOKEN, so a retheme or
// a swapped literal fails here rather than in a screenshot.
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const okSnapshot = {
    ok: true,
    pools: {
      pools: [{
        id: "p1", name: "通用池", poolType: "default",
        window5h: { limit: 1000, used: 200, remaining: 800, resetAt: inHours(1) },
        window7d: { limit: 10000, used: 100, remaining: 9900 }
      }]
    },
    trend: { hours: 24, models: [] }
  };
  let raccoonState = { ok: true, loggedIn: true, balance: 42150 };
  win.fetch = (path) => {
    const body = path === RACCOON_PATH ? raccoonState : okSnapshot;
    return new Promise((resolve) => setTimeout(
      () => resolve({ ok: true, status: 200, json: async () => body }), 0));
  };
  const selection = { next: { provider: "sensenova-token-plan", model: "deepseek-v4-flash" } };
  const useProjection = () => { React.useState(selection); return selection; };
  let pill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });

  // These look the node up per call on purpose: the Raccoon frames below remount
  // through the unmount → mount path, and `mount` appends a FRESH container —
  // a captured `host` would still point at the detached one and every later
  // assertion would silently read a dead tree.
  const plan = () => pill.host.querySelector(".dsh-sensenova-composer-pill-plan");
  const trigger = () => pill.host.querySelector("button.dsh-sensenova-composer-pill");
  const body = () => pill.host.textContent;
  check("the Token Plan reading leads with its plan name",
    plan()?.textContent === "composer.planPrefix · ",
    `plan span=${JSON.stringify(plan()?.textContent)} text=${body().slice(0, 120)}`);
  // The prefix is a label, so it takes the shell's SECONDARY ink while the
  // figures keep the primary — the eye should land on the number, then read
  // whose plan it is. A primary-ink prefix would compete with the reading.
  check("the plan name is a label: secondary ink, never a tier colour",
    css(plan(), "color").startsWith("var(--dsw-alias-label-secondary")
      && !css(plan(), "color").includes("state-"),
    `plan color=${css(plan(), "color")}`);
  // The prefix must not shrink away when the row gets narrow: it is the pill's
  // shortest fragment and the one that survives every truncation.
  check("the plan name does not collapse when the toolbar narrows",
    css(plan(), "flexShrink") === "0",
    `flex-shrink=${css(plan(), "flexShrink")}`);
  // Position, not just presence: the plan name has to come BEFORE the figures,
  // which is the whole point of the reference's `Go · `. Both are looked up
  // among the trigger's OWN spans: the pill is now wrapped in an anchor element
  // (§H), so a host-wide search would match that wrapper first and report every
  // descendant as being "after" it.
  const triggerSpans = [...trigger().querySelectorAll("span")];
  const order = triggerSpans.findIndex((el) => el === plan());
  const readingAt = triggerSpans.findIndex((el) => el.textContent?.includes("composer.pool5h"));
  check("the plan name precedes the figures, not trails them",
    order !== -1 && readingAt !== -1 && order < readingAt,
    `plan at ${order}, reading at ${readingAt}`);

  // Switching provider swaps the prefix with it — the reading and the plan name
  // are one fact, not a label someone forgot to update.
  selection.next = { provider: "sensenova-raccoon", model: "sn-sensenova-6-8-flash" };
  pill.rerender(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  check("switching provider swaps the plan name with the reading",
    plan()?.textContent === "composer.raccoonPrefix · "
      && body().includes("42,150 composer.balanceUnit"),
    `plan=${JSON.stringify(plan()?.textContent)} text=${body().slice(0, 120)}`);
  // The dot on a live balance is the success token, the same reading as a
  // healthy window — "there is credit left" is a state, not a percentage.
  const raccoonDot = pill.host.querySelector(".dsh-sensenova-composer-pill-dot");
  check("a funded Raccoon balance wears the host's success token",
    css(raccoonDot, "background").startsWith("var(--dsw-alias-state-success-primary"),
    `dot=${css(raccoonDot, "background")}`);

  // Signed out is its own reading: absence of a balance, stated as such, in the
  // unknown ink — never a fabricated number. It takes the unmount → mount path
  // for the same reason as §E: polling reloads on a cadence, not per render.
  raccoonState = { ok: true, loggedIn: false };
  pill.unmount();
  pill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  const signedOutDot = pill.host.querySelector(".dsh-sensenova-composer-pill-dot");
  check("a signed-out Raccoon session shows a dash in the unknown ink, not a figure",
    body().includes("composer.raccoonPrefix · —") && !/\d/.test(body())
      && css(signedOutDot, "background").startsWith("var(--dsw-alias-label-tertiary"),
    `text=${body().slice(0, 120)} dot=${css(signedOutDot, "background")}`);

  pill.unmount();
}

// === H. the pill EXPANDS into the figures it cannot fit (2026-10-16) ========
// The reported gap: 「没有点击弹窗，显示准确的额度卡」 — the pill reads a rounded
// percentage, and "1%" cannot answer the question that makes a user open
// anything: can I still afford a long-context request before this window rolls?
// So the panel spends its width on the RAW figures (used/limit), the exact reset
// clock, and the pool attribution — and deliberately does NOT repeat the pill's
// rounded percentage, which would be the same number twice.
//
// Three structural claims are pinned here, each of which could silently rot:
//   1. the trigger is a real toggle (aria-expanded + aria-controls + a second
//      click closes) — a panel with no way back is a trap;
//   2. the panel is the pill's SIBLING inside an anchor, not its child: a
//      `<div role="dialog">` inside a `<button>` is invalid nesting, and the
//      absolute positioning needs a containing block that is not the button's
//      own padding box;
//   3. a provider switch UNMOUNTS the panel with the inner pill, so a panel can
//      never outlive the model whose quota it was quoting.
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const okSnapshot = {
    ok: true,
    pools: {
      pools: [{
        id: "p1", name: "通用池", poolType: "default",
        // `used`/`limit` chosen so `count()` shows the separator rule on BOTH
        // sides of the ratio — the panel is where raw figures live, so this is
        // exactly where a comma-less 1.25M would ship wrong.
        window5h: { limit: 1_250_000, used: 12_500, remaining: 1_237_500, resetAt: inHours(2) },
        window7d: { limit: 60_000_000, used: 1_200_000, remaining: 58_800_000 }
      }]
    },
    trend: { hours: 24, models: [] }
  };
  let raccoonState = { ok: true, loggedIn: true, balance: 42150 };
  const routes = [];
  win.fetch = (path) => {
    routes.push(path);
    const body = path === RACCOON_PATH ? raccoonState : okSnapshot;
    return new Promise((resolve) => setTimeout(
      () => resolve({ ok: true, status: 200, json: async () => body }), 0));
  };
  const selection = { next: { provider: "sensenova-token-plan", model: "deepseek-v4-flash" } };
  const useProjection = () => { React.useState(selection); return selection; };
  let pill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });

  const button = () => pill.host.querySelector("button.dsh-sensenova-composer-pill");
  const panelNode = () => pill.host.querySelector(".dsh-sensenova-composer-pill-popover");
  const click = async (el) => {
    await act(async () => { el.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });
    await act(async () => { await sleep(0); });
  };

  // Closed to begin with, and the trigger does not name a panel that is absent.
  check("the panel starts closed and the trigger claims no panel id yet",
    panelNode() === null && button()?.getAttribute("aria-expanded") === "false"
      && button()?.getAttribute("aria-controls") === null,
    `panel=${panelNode() !== null} expanded=${button()?.getAttribute("aria-expanded")} controls=${button()?.getAttribute("aria-controls")}`);

  await click(button());
  const openPanel = panelNode();
  const openText = pill.host.textContent;
  check("one click opens the quota panel",
    openPanel !== null && button()?.getAttribute("aria-expanded") === "true",
    `panel=${openPanel !== null} expanded=${button()?.getAttribute("aria-expanded")} text=${openText.slice(0, 200)}`);
  check("the trigger names the panel it controls, and that id resolves to the node",
    button()?.getAttribute("aria-controls") === openPanel?.id && typeof openPanel?.id === "string" && openPanel.id !== "",
    `aria-controls=${button()?.getAttribute("aria-controls")} panel id=${JSON.stringify(openPanel?.id)}`);
  check("the panel announces itself as a dialog owned by the trigger",
    openPanel?.getAttribute("role") === "dialog"
      && button()?.getAttribute("aria-haspopup") === "dialog"
      && openPanel?.getAttribute("aria-label")?.includes("composer.pillTitle") === true,
    `role=${openPanel?.getAttribute("role")} haspopup=${button()?.getAttribute("aria-haspopup")} label=${openPanel?.getAttribute("aria-label")}`);

  // The panel is the pill's SIBLING inside the anchor — never inside the button.
  // Invalid nesting is one thing; the containing block matters more: an
  // absolutely-positioned child of the button would be positioned against the
  // button's own padding box and its 320px width would blow the toolbar open.
  check("the panel is a sibling of the trigger, not a child of the button",
    openPanel !== null && button()?.contains(openPanel) === false
      && openPanel?.parentElement === button()?.parentElement
      && css(openPanel?.parentElement, "position") === "relative",
    `inside button=${button()?.contains(openPanel)} same parent=${openPanel?.parentElement === button()?.parentElement} anchor position=${css(openPanel?.parentElement, "position")}`);

  // The panel's OWN text, not the host's: the trigger's rounded percentages sit
  // in the same container, so asserting against `host.textContent` would fail on
  // the pill's own reading rather than on anything the panel drew.
  const panelText = () => openPanel?.textContent ?? "";
  check("the panel shows each window's raw used/limit, not the rounded percent again",
    panelText().includes("12,500 / 1,250,000") && panelText().includes("1,200,000 / 60,000,000"),
    `panel text=${panelText().slice(0, 320)}`);
  check("the panel does not repeat the pill's rounded percentage",
    !panelText().includes("composer.pool5h") && !panelText().includes("composer.pool7d"),
    `panel text=${panelText().slice(0, 320)}`);
  // The 5h window carries a reset instant; the 7d one does not in this fixture,
  // so exactly ONE reset line may appear — a second one would mean a clock is
  // being drawn where the platform declared none.
  check("the exact reset clock is drawn only where the platform declared one",
    (panelText().match(/pool\.reset/g) ?? []).length === 1,
    `reset lines=${(panelText().match(/pool\.reset/g) ?? []).length} text=${panelText().slice(0, 320)}`);

  // Pool attribution: this model names no pool, so the panel must SAY it was
  // attributed to a pool it does not own — the name rides beside that fact, not
  // instead of it. The pool's TYPE is asserted from the wire rather than assumed:
  // the fallback lands on `pools[0]`, which the console does not promise is the
  // general pool, so a panel that hard-wrote 「通用池」 would state a fact this
  // client cannot support.
  //
  // The sentence itself promises nothing about the pool's KIND — it reports the
  // SELECTION (the model listed nowhere, the platform's order consulted), because
  // the kind is `pools[0]`'s own `pool_type`, drawn beside the name from the wire.
  // The old wording ("按通用池计") asserted a general pool and so contradicted
  // itself the moment the fallback landed on a dedicated one; the `dedicated`
  // fixture at the end of this section is that case, taken rather than assumed.
  check("the panel names the pool, its declared type, and how the model reached it",
    panelText().includes("通用池 · pool.default · composer.poolFallback") && !panelText().includes("composer.poolHit"),
    `panel text=${panelText().slice(0, 200)}`);

  // The bar carries the SAME tier ink the pill's dot does — one threshold for
  // one plugin (80% warn), NOT `cards.ts`'s 70/90: two tiers disagreeing inside
  // one screenshot is worse than either number. This fixture sits at 1% and 2%,
  // so it is the OK-token control; the pair that actually straddles the line is
  // asserted at the end of this section, because the prefix this check pins
  // (`var(--dsw-alias-state-`) is satisfied by ANY tier. Measured: with only
  // this assertion, `share >= 0.8` → `0.7` left every suite green.
  const fills = [...(openPanel?.querySelectorAll("div") ?? [])].filter((el) => el.style.width !== "");
  check("each window's bar is filled with the shared tier ink, not a plugin hex",
    fills.length === 2 && fills.every((el) => css(el, "background").startsWith("var(--dsw-alias-state-")),
    `fills=${fills.map((el) => `${el.style.width}/${css(el, "background")}`).join(" ")}`);
  const bars = [...(openPanel?.querySelectorAll("[role='progressbar']") ?? [])];
  check("the bars are reachable by assistive tech, sized to the value they draw",
    bars.length === 2 && bars.every((bar) => bar.getAttribute("aria-valuemax") === "100"
      && Number(bar.getAttribute("aria-valuenow")) >= 0 && bar.querySelector("div") !== null),
    `bars=${bars.map((bar) => `${bar.getAttribute("aria-valuenow")}/${bar.querySelector("div") === null ? "no fill" : "fill"}`).join(",")}`);

  // The host chrome, at the host's scale: the popover floats ABOVE the composer
  // (the row sits at the input's bottom, so a downward panel would cover the
  // draft), it is opaque (it floats over the input's own surface), and it uses
  // the shell's tokens so a retheme reaches it.
  check("the panel floats above the composer row instead of covering the draft",
    css(openPanel, "position") === "absolute" && css(openPanel, "bottom") === "100%"
      && Number.parseInt(css(openPanel, "zIndex"), 10) >= 100,
    `position=${css(openPanel, "position")} bottom=${css(openPanel, "bottom")} z-index=${css(openPanel, "zIndex")}`);
  check("the panel is opaque and wears the shell's own border and surface tokens",
    css(openPanel, "background").startsWith("var(--dsw-alias-bg-layer-1")
      && css(openPanel, "border").includes("var(--dsw-alias-border-l1"),
    `background=${css(openPanel, "background")} border=${css(openPanel, "border")}`);
  check("the panel fits a narrow viewport instead of running off the left edge",
    /100vw/.test(css(openPanel, "width")) && css(openPanel, "width").startsWith("min("),
    `width=${css(openPanel, "width")}`);
  // A trigger that promises no pointer reads as broken the moment it acts.
  check("the trigger offers a pointer now that it acts",
    css(button(), "cursor") === "pointer",
    `cursor=${css(button(), "cursor")}`);

  // The three dismissals, in the order a user reaches them. The first is the
  // re-click (the MVP's only path); the other two are document listeners this
  // plugin already owns one of (visibilitychange), so "we cannot express
  // outside-click" was never true — what matters is that both listeners exist
  // only while the panel is open.
  await click(button());
  check("re-clicking closes the panel and leaves no node behind",
    panelNode() === null && button()?.getAttribute("aria-expanded") === "false"
      && button()?.getAttribute("aria-controls") === null,
    `panel=${panelNode() !== null} expanded=${button()?.getAttribute("aria-expanded")} controls=${button()?.getAttribute("aria-controls")}`);

  // `pointerdown` on a node outside the anchor. `document.body` is never inside
  // the pill's own anchor, so it stands in for the chat surface a user actually
  // clicks away to.
  await click(button());
  await act(async () => {
    win.document.body.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
  });
  check("a pointerdown outside the pill closes the panel",
    panelNode() === null && button()?.getAttribute("aria-expanded") === "false",
    `panel=${panelNode() !== null} expanded=${button()?.getAttribute("aria-expanded")}`);

  // A press INSIDE the anchor must NOT close it. This is the case that decides
  // the event type: `pointerdown` is what keeps the trigger's own toggle from
  // racing the dismissal — a `click` listener would already have seen the
  // button's toggle by the time it ran, so "click away" and "click the pill to
  // close" would fight over one click.
  await click(button());
  const innerPress = openPanel.querySelector(".dsh-sensenova-composer-pill-popover-head") ?? button();
  await act(async () => {
    innerPress.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
  });
  check("a press inside the panel leaves it open (the trigger's toggle cannot race the dismissal)",
    panelNode() !== null && button()?.getAttribute("aria-expanded") === "true",
    `panel=${panelNode() !== null} expanded=${button()?.getAttribute("aria-expanded")}`);

  await act(async () => {
    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  check("Escape closes the panel without touching the trigger",
    panelNode() === null && button()?.getAttribute("aria-expanded") === "false",
    `panel=${panelNode() !== null} expanded=${button()?.getAttribute("aria-expanded")}`);

  // Any OTHER key must leave it alone — an unconditional keydown close would
  // make typing in the composer shut the panel.
  await click(button());
  await act(async () => {
    win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "a", bubbles: true }));
  });
  check("an unrelated keystroke leaves the panel open (typing in the composer must not close it)",
    panelNode() !== null && button()?.getAttribute("aria-expanded") === "true",
    `panel=${panelNode() !== null} expanded=${button()?.getAttribute("aria-expanded")}`);

  // A closed panel must leave no listener behind: a live click-away whose
  // subject is already unmounted is a handler on the document that outlived the
  // thing it existed to close. Nothing here can reopen the panel, which IS the
  // proof the listener is gone — a stray press on the body changes nothing.
  await click(button());
  await act(async () => {
    win.document.body.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
  });
  check("a closed panel owns no listener: a stray press outside changes nothing",
    panelNode() === null && button()?.getAttribute("aria-expanded") === "false",
    `panel=${panelNode() !== null} expanded=${button()?.getAttribute("aria-expanded")}`);

  // Toggling is pure UI state: opening must not fetch. The request log is the
  // proof, because "no extra fetch" is otherwise invisible — the panel reads the
  // numbers already on screen.
  const fetchesBeforeToggles = routes.length;
  await click(button());
  await click(button());
  check("opening the panel costs no request (it reads what the pill already polled)",
    routes.length === fetchesBeforeToggles,
    `${routes.length - fetchesBeforeToggles} new request(s)`);

  // A provider switch unmounts the inner pill, so the panel goes with it. The
  // panel quotes ONE model's quota; left mounted it would keep showing figures
  // for a model the session no longer points at — the exact confusion the panel
  // exists to prevent.
  selection.next = { provider: "sensenova-raccoon", model: "sn-sensenova-6-8-flash" };
  pill.rerender(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  check("switching provider takes the Token Plan panel down with the pill",
    panelNode() === null && button()?.getAttribute("aria-expanded") === "false",
    `panel=${panelNode() !== null} expanded=${button()?.getAttribute("aria-expanded")} text=${pill.host.textContent.slice(0, 160)}`);

  // The Raccoon panel is a STOCK, not a window: one figure, no bar, no borrowed
  // pool. It reuses the same frame so the two branches read as one widget.
  await click(button());
  const raccoonPanel = panelNode();
  const raccoonText = pill.host.textContent;
  check("the Raccoon panel shows the balance and invents no window for it",
    raccoonPanel !== null && raccoonText.includes("42,150 composer.balanceUnit")
      && !raccoonText.includes("pool.window5h") && !raccoonText.includes("pool.window7d")
      && raccoonPanel?.querySelectorAll("[role='progressbar']").length === 0,
    `panel=${raccoonPanel !== null} text=${raccoonText.slice(0, 240)}`);
  check("the Raccoon panel borrows no Token Plan pool line",
    !raccoonText.includes("通用池") && raccoonText.includes("composer.raccoonTitle"),
    `text=${raccoonText.slice(0, 240)}`);

  // The gateway's OWN split of the total. A single total answers "how much";
  // the split answers "how much of it expires tonight", which is what decides
  // whether to spend now — so the parts belong in the panel even though the pill
  // (one figure wide) keeps the total alone. No bar: no limit was published to
  // scale one against.
  raccoonState = { ok: true, loggedIn: true, balance: 42150, balanceBreakdown: { daily: 600, reward: 8344, monthly: 30000, topup: 3206 } };
  pill.unmount();
  pill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  await click(button());
  const breakdownText = panelNode()?.textContent ?? "";
  check("the Raccoon panel breaks the balance into the parts the gateway declared",
    panelNode() !== null
      && breakdownText.includes("composer.balanceParts")
      // `count()` only groups at and above 10000, so 8344 and 3206 stay bare —
      // the assertion spells out the formatter's own rule rather than a
      // house style it does not have.
      && breakdownText.includes("raccoon.partNameDaily600 composer.balanceUnit")
      && breakdownText.includes("raccoon.partNameReward8344 composer.balanceUnit")
      && breakdownText.includes("raccoon.partNameMonthly30,000 composer.balanceUnit")
      && breakdownText.includes("raccoon.partNameTopup3206 composer.balanceUnit")
      && panelNode()?.querySelectorAll("[role='progressbar']").length === 0,
    `panel text=${breakdownText.slice(0, 320)}`);
  await click(button());
  check("the Raccoon panel closes on a second click too",
    panelNode() === null && button()?.getAttribute("aria-expanded") === "false",
    `panel=${panelNode() !== null} expanded=${button()?.getAttribute("aria-expanded")}`);

  // Signed out: the panel must state the FACT (and where to fix it) rather than
  // show a dash with nothing behind it. Reached by remount, as in §E/§G:
  // polling reloads on a cadence, not per render.
  raccoonState = { ok: true, loggedIn: false };
  pill.unmount();
  pill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  await click(button());
  const signedOutPanelText = panelNode()?.textContent ?? "";
  check("a signed-out Raccoon session's panel says so instead of showing a dash",
    panelNode() !== null && signedOutPanelText.includes("composer.raccoonSignedOut")
      && !/\d/.test(signedOutPanelText),
    `panel text=${signedOutPanelText.slice(0, 200)}`);
  pill.unmount();

  // A Token Plan answer with NO pool must not render borrowed rows: the panel
  // says the model is outside the pools, and draws no window for a pool that
  // does not exist.
  selection.next = { provider: "sensenova-token-plan", model: "sn-unknown-model" };
  win.fetch = (path) => Promise.resolve({
    ok: true,
    status: 200,
    json: async () => path === RACCOON_PATH ? raccoonState : { ok: true, pools: { pools: [] }, trend: { hours: 24, models: [] } }
  });
  pill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  await click(button());
  const emptyPanelText = panelNode()?.textContent ?? "";
  check("a Token Plan model with no pool in the answer gets no invented quota rows",
    panelNode() !== null && panelNode()?.querySelector("[role='progressbar']") === null
      && emptyPanelText.includes("composer.noPool"),
    `panel text=${emptyPanelText.slice(0, 200)}`);
  pill.unmount();

  // The grant footnote. `grantBalance` is a SEPARATE quota universe — 30 days,
  // it does not consume the rolling windows — so it can only ever be a footnote
  // here: never a percentage, never a window row. Three cases, and the third is
  // the one that matters: a zero grant is normalized by `credits()` whether the
  // platform declared one or not, so drawing 「返赠余额 0」 would claim the grant
  // was spent instead of saying there is none.
  selection.next = { provider: "sensenova-token-plan", model: "deepseek-v4-flash" };
  const grantedSnapshot = (grant) => ({
    ok: true,
    pools: {
      pools: [{
        id: "p1", name: "通用池", poolType: "default",
        window5h: { limit: 1000, used: 200, remaining: 800, resetAt: inHours(1) },
        window7d: { limit: 10000, used: 100, remaining: 9900, resetAt: inHours(48) },
        grantBalance: grant,
        nearestGrantExpiry: grant > 0 ? inHours(24 * 12) : null,
        nearestGrantExpiringBalance: grant > 0 ? 120 : 0
      }]
    },
    trend: { hours: 24, models: [] }
  });
  const grantTextFor = async (grant) => {
    win.fetch = (path) => Promise.resolve({
      ok: true, status: 200,
      json: async () => path === RACCOON_PATH ? raccoonState : grantedSnapshot(grant)
    });
    pill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
    await act(async () => { await sleep(0); });
    await click(button());
    return panelNode()?.textContent ?? "";
  };
  const grantText = await grantTextFor(500);
  // The KEYS, not the substituted words: `tt` here echoes the key, and a key has
  // no `{balance}` in it, so `format` has nothing to fill. What matters is that
  // both fragments are drawn, and that the grant cost no third window bar.
  check("a live grant appears as a footnote with its expiry, not as a third window",
    grantText.includes("pool.grant") && grantText.includes("pool.grantExpiry")
      && panelNode()?.querySelectorAll("[role='progressbar']").length === 2,
    `panel text=${grantText.slice(0, 320)}`);
  pill.unmount();
  const noGrantText = await grantTextFor(0);
  check("a zero grant draws no footnote at all (an absent grant is not a spent one)",
    !noGrantText.includes("pool.grant") && !noGrantText.includes("pool.grantExpiry"),
    `panel text=${noGrantText.slice(0, 320)}`);
  pill.unmount();

  // The reset clock is stated in the unit the wire carries. `epochSeconds()`
  // hands `reset_at` over in SECONDS, and the first version of `resetFor`
  // compared that against `Date.now()`'s milliseconds — so every real reading
  // looked already-reset and the clock silently vanished. The fixtures above are
  // in seconds, so this assertion is the one that would catch a regression back
  // to milliseconds: the 48h clock is on ANOTHER DAY, and a bare `HH:MM` would
  // read as later today.
  // Two clocks, not one: the 5h window resets today and the weekly one lands
  // another day out. Under the millisecond bug `resetFor` dropped BOTH, so the
  // count is the assertion that catches it — a unit regression here shows up as
  // zero reset lines rather than as a mis-formatted clock.
  const twoClockText = await grantTextFor(0);
  check("both declared resets are worded, in the unit the wire sends them (seconds)",
    (twoClockText.match(/pool\.reset/g) ?? []).length === 2,
    `reset lines=${(twoClockText.match(/pool\.reset/g) ?? []).length} panel text=${twoClockText.slice(0, 320)}`);
  pill.unmount();
  // And with a REAL translator the 48-hour clock must carry its date, not read as
  // a time later today — the bug `when()` was written for, now pinned through the
  // shipped dictionary rather than through a key-echoing `tt`.
  // The same-day side must NOT be pinned with `inHours(1)`: after 23:00 local
  // that crosses midnight, `when()` correctly switches to `MM-DD HH:mm`, and the
  // bare `HH:mm` expectation went red for the last hour of every day (caught
  // 2026-10-16 23:39 with `1h=10-17 00:39`, green again at 00:07 — a wall-clock
  // flake of the same family as the seconds/ms bug above, this time in the
  // fixture). Today's local NOON is the same calendar day at any run time —
  // `when()` reads the day, not the future — so the exact reading "12:00" is
  // assertable, which pins the branch harder than the shape-only regex did.
  const noonToday = Math.floor(new Date().setHours(12, 0, 0, 0) / 1000);
  check("the date-aware clock formats a cross-day reset as MM-DD HH:mm",
    /^\d{2}-\d{2} \d{2}:\d{2}$/.test(panel.helpers.when(inHours(48)))
      && panel.helpers.when(noonToday) === "12:00",
    `48h=${panel.helpers.when(inHours(48))} noon=${panel.helpers.when(noonToday)}`);
  pill.unmount();

  // One word for one window: the pill said 「本周」 while its own panel said
  // 「每周」 about the same rolling 7-day window. Read off the SHIPPED dictionary,
  // because `tt` here echoes the key and cannot see the words at all. Compared
  // case-insensitively and with the space stripped: the pill carries its word
  // inside a sentence and the panel as a row heading, so capitalization is a
  // deliberate difference at each surface — but the WORD may not be.
  const weeklyWord = (dict, key) => dict[key].toLowerCase().replace(/\s+/g, "");
  check("the pill and its panel name the weekly window with the same word",
    weeklyWord(panel.dictionaries.zh, "composer.pool7d") === weeklyWord(panel.dictionaries.zh, "pool.window7d")
      && weeklyWord(panel.dictionaries.en, "composer.pool7d") === weeklyWord(panel.dictionaries.en, "pool.window7d"),
    `zh pill=${panel.dictionaries.zh["composer.pool7d"]} panel=${panel.dictionaries.zh["pool.window7d"]} / en pill=${panel.dictionaries.en["composer.pool7d"]} panel=${panel.dictionaries.en["pool.window7d"]}`);

  pill.unmount();
  check("unmounting the pill with its panel open leaves nothing behind", pill.host.childNodes.length === 0);

  // ---- 判定级断言：阈值、分支、以及新增的状态 -------------------------------
  // Every ink check above asserts a PREFIX, and a prefix is satisfied by any
  // tier: `share >= 0.8` could become `0.7` and all suites stayed green (measured
  // against the build, not suspected). A threshold is pinned only by two readings
  // that straddle it; a branch only by a fixture that takes it. So: the 79%/85%
  // pair names the exact token on each side of the line, the `dedicated` pool
  // takes the branch that asserts its type off the wire, and each state the panel
  // can now be in gets the reading that fails when its discriminator is removed.
  const poolSnapshot = (pool) => ({ ok: true, pools: { pools: [pool] }, trend: { hours: 24, models: [] } });
  const windowOf = (used, limit, resetAt) => (resetAt === undefined
    ? { limit, used, remaining: limit - used }
    : { limit, used, remaining: limit - used, resetAt });
  /** A pool that LISTS the selected model, so `matched` is decided by the fixture. */
  const planPool = (window5h, window7d, overrides = {}) => ({
    id: "p1", name: "通用池", poolType: "default", modelIds: ["deepseek-v4-flash"],
    window5h, window7d, grantBalance: 0, nearestGrantExpiry: null, nearestGrantExpiringBalance: 0,
    ...overrides
  });
  /** Mount a Token Plan pill over `snapshot`, open its panel, hand back what it drew. */
  const openPanelFor = async (snapshot) => {
    win.fetch = (path) => Promise.resolve({
      ok: true, status: 200,
      json: async () => path === RACCOON_PATH ? raccoonState : snapshot
    });
    pill.unmount();
    pill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
    await act(async () => { await sleep(0); });
    await click(button());
    const node = panelNode();
    return { text: node?.textContent ?? "", title: button()?.getAttribute("title") ?? "", node };
  };
  const fillsOf = (node) => [...(node?.querySelectorAll("div") ?? [])].filter((el) => el.style.width !== "");

  // 85% — above the line, and it must be the WARN token and nothing else.
  const warnRead = await openPanelFor(poolSnapshot(planPool(windowOf(850, 1000, inHours(1)), windowOf(10, 1000))));
  const warnFills = fillsOf(warnRead.node);
  check("a window at 85% wears the warn token — the 80% line asserted AT the line",
    warnFills.length === 2
      && css(warnFills[0], "background").startsWith("var(--dsw-alias-state-warn-primary")
      && css(warnFills[1], "background").startsWith("var(--dsw-alias-state-success-primary"),
    `fills=${warnFills.map((el) => `${el.style.width}/${css(el, "background")}`).join(" ")}`);

  // 79% — the OTHER side of the same line, and the reading that kills a moved
  // threshold: should 0.8 ever become 0.7, this window turns warn and fails.
  const underRead = await openPanelFor(poolSnapshot(planPool(windowOf(790, 1000, inHours(1)), windowOf(10, 1000))));
  const underFills = fillsOf(underRead.node);
  check("a window just under the line (79%) is still ok — the threshold's other side",
    underFills.length === 2
      && css(underFills[0], "background").startsWith("var(--dsw-alias-state-success-primary"),
    `fills=${underFills.map((el) => `${el.style.width}/${css(el, "background")}`).join(" ")}`);

  // The pool branch whose type the fallback cannot assume. `poolType` is READ off
  // the wire, so a dedicated pool must be worded dedicated — and a mutant that
  // hard-writes "default" is invisible until a fixture declares otherwise, which
  // is exactly why the surviving mutant survived.
  const dedicatedRead = await openPanelFor(poolSnapshot(planPool(
    windowOf(500, 1000, inHours(1)), windowOf(10, 1000), { name: "Flash-Lite 专属池", poolType: "dedicated" }
  )));
  check("a pool that LISTS the model says so, and its declared type comes off the wire",
    dedicatedRead.text.includes("Flash-Lite 专属池 · pool.dedicated · composer.poolHit")
      && !dedicatedRead.text.includes("composer.poolFallback"),
    `panel text=${dedicatedRead.text.slice(0, 240)}`);

  // The overlap case the console actually serves: `sensenova-6.8-flash-lite` is
  // named by the 通用池 AND by its own Flash-Lite pool. First-hit attribution
  // picked the 通用池 and showed ITS 5h meter (here 500/1000 = 50%) for a model
  // whose spend never touches that window — live check 2026-10-18 00:00 saw the
  // dedicated 5h at 3,129 consumed with the general 5h still at 0. Both pools
  // list the model here, so only the dedicated-preference discriminates: the
  // numbers asserted (7/1000) exist in the dedicated pool alone and 500/1000 in
  // the general one alone.
  const sharedRead = await openPanelFor({
    ok: true,
    pools: {
      pools: [
        planPool(windowOf(500, 1000, inHours(1)), windowOf(10, 1000)),
        planPool(windowOf(7, 1000, inHours(1)), windowOf(9, 1000), { id: "p2", name: "Flash-Lite 专属池", poolType: "dedicated" })
      ]
    },
    trend: { hours: 24, models: [] }
  });
  check("a model named by BOTH pools is billed to its dedicated pool, not the first hit",
    sharedRead.text.includes("Flash-Lite 专属池 · pool.dedicated · composer.poolHit")
      && sharedRead.text.includes("7 / 1000") && !sharedRead.text.includes("500 / 1000"),
    `panel text=${sharedRead.text.slice(0, 240)}`);

  // ...and when the dedicated pool is SPENT while the general one still has
  // credit, the pill follows the pool that actually keeps the model selectable.
  // The Host keeps the model in the picker while ANY covering pool has credit;
  // pointing the pill at the spent one would draw a full meter for a model the
  // picker still offers — two panels disagreeing about one fact. Same fixture as
  // above with the two windows swapped, so only the spent/live discrimination
  // can produce the expected reading.
  const spillRead = await openPanelFor({
    ok: true,
    pools: {
      pools: [
        planPool(windowOf(500, 1000, inHours(1)), windowOf(10, 1000)),
        planPool(windowOf(1000, 1000, inHours(1)), windowOf(9, 1000, inHours(1)), { id: "p2", name: "Flash-Lite 专属池", poolType: "dedicated" })
      ]
    },
    trend: { hours: 24, models: [] }
  });
  check("a spent dedicated pool hands the pill back to the pool that still covers the model",
    spillRead.text.includes("通用池 · pool.default · composer.poolHit")
      && spillRead.text.includes("500 / 1000") && !spillRead.text.includes("1000 / 1000"),
    `panel text=${spillRead.text.slice(0, 240)}`);

  // A spent deadline must not shadow a live one. `w5?.resetAt ?? w7?.resetAt` took
  // the first NON-NULL, so with the 5h reset already past (mid-reset, or a
  // snapshot that lagged) the tooltip worded NO reset at all while the weekly one
  // was still two days out. The 48h clock is also on another day, so the day form
  // is what a `when()`-formatted instant produces — and a revert to a raw
  // `toLocaleString()` fails the same pattern.
  const liveRead = await openPanelFor(poolSnapshot(planPool(windowOf(500, 1000, inHours(-1)), windowOf(10, 1000, inHours(48)))));
  check("a spent 5h deadline does not shadow the weekly one still ahead (the tooltip words the live reset)",
    /composer\.resetAt \d{2}-\d{2} \d{2}:\d{2}/.test(liveRead.title),
    `title=${liveRead.title}`);
  check("and the panel words the same one live reset, for the same reason",
    (liveRead.text.match(/pool\.reset/g) ?? []).length === 1,
    `reset lines=${(liveRead.text.match(/pool\.reset/g) ?? []).length} text=${liveRead.text.slice(0, 240)}`);

  // A limit the platform never declared. `credits()` normalizes an absent limit to
  // 0, so the row used to publish "0 / 0" — two numbers nobody sent, for a ratio
  // nobody can compute — while the pill beside it read 「每周 —」 for the same
  // window. One token, and the same rule `percentOf` uses to decide the pill's.
  const noLimitRead = await openPanelFor(poolSnapshot(planPool(windowOf(500, 1000, inHours(1)), windowOf(0, 0))));
  // `count()` groups only at 10000 and above, so the declared side reads
  // 「500 / 1000」 — the formatter's own rule, spelled out rather than a house
  // style it does not have.
  check("an undeclared limit draws no ratio at all, instead of a fabricated 0 / 0",
    noLimitRead.text.includes("500 / 1000") && noLimitRead.text.includes("—")
      && !noLimitRead.text.includes("0 / 0"),
    `panel text=${noLimitRead.text.slice(0, 240)}`);

  // The OTHER way a model can own no pool, and the one a 401 used to be reported
  // as. `loadedOnce` cannot carry this branch — `use-remote-read.ts` sets it in a
  // `finally`, so a failed attempt counts as "loaded" — and this fixture is the
  // only one in the suite whose read never once succeeds.
  win.fetch = () => Promise.reject(new Error("snapshot unreachable"));
  pill.unmount();
  pill = mount(React.createElement(panel.components.ComposerUsagePill, { tt, useProjection }));
  await act(async () => { await sleep(0); });
  await click(button());
  const unreadText = panelNode()?.textContent ?? "";
  check("a read that never once succeeded says the quota is UNKNOWN, not that the model is outside the pools",
    unreadText.includes("composer.quotaUnknown") && !unreadText.includes("composer.noPool"),
    `panel text=${unreadText.slice(0, 240)}`);

  // React's own dev-mode contract, read from the only place it is visible. This
  // component builds four `children` arrays by hand — the two window rows, the two
  // readings, the Raccoon parts deck and its two-entry frame — and React warns on
  // EVERY render for a member with no `key`. The collector spans the whole run
  // (see the top of this file for why a per-mount spy cannot work), so this is
  // the run's own count: every mount above, both pills included, has rendered
  // these arrays at least once by now.
  check("no render in this run logs React's missing-key warning",
    reactKeyWarnings.length === 0,
    `${reactKeyWarnings.length} warning(s), first: ${(reactKeyWarnings[0] ?? "").slice(0, 200)}`);
  pill.unmount();
}

finish();

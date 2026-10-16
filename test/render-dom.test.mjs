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

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

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
  process.stderr.write(
    `\n[render-dom] SKIPPED — ${missing.join(", ")} not installed in this project's node_modules.\n` +
    `[render-dom]   Bootstrap dev deps with: npm install --legacy-peer-deps\n` +
    `[render-dom]   (CI's offline job installs them, so CI always runs this suite for real;\n` +
    `[render-dom]    a GLOBAL react is deliberately not a fallback — the verdict must match\n` +
    `[render-dom]    the version pinned in devDependencies.)\n\n`
  );
  process.exit(0);
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
        window5h: { limit: 1000, used: 200, remaining: 800, resetAt: Date.now() + 2 * 3_600_000 },
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
        window5h: { limit: 1000, used: 200, remaining: 800, resetAt: Date.now() + 3_600_000 },
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
          window5h: { limit: 1000, used: 1000, remaining: 0, resetAt: Date.now() + 3_600_000 },
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
        window5h: { limit: 1000, used: 200, remaining: 800, resetAt: Date.now() + 3_600_000 },
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
  // which is the whole point of the reference's `Go · `.
  const order = [...pill.host.querySelectorAll("span")].findIndex((el) => el === plan());
  const readingAt = [...pill.host.querySelectorAll("span")].findIndex((el) => el.textContent?.includes("composer.pool5h"));
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

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

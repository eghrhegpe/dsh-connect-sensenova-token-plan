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
 * This suite closes both, minimally. It reads the root `client.js` artifact,
 * evals it inside a jsdom realm with a `window.__ModuleLoader__` installed —
 * exactly the seam the browser Host uses — materializes the factory with the
 * REAL react from devDependencies, and mounts it with `react-dom/client` into
 * a real document. From there it checks what only a real renderer can show:
 * DOM attribute/style mapping of the quota card's arithmetic, and the
 * `useState` round-trips of the account form (controlled inputs, the
 * show-password flip, the empty-field refusal, and — a red-line-1 assertion —
 * the password leaving component state the moment the sign-in lands).
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

/** Mount `element` into a fresh jsdom container under a real react-dom root. */
function mount(element) {
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const r = createRoot(host);
  act(() => r.render(element));
  return {
    host,
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

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

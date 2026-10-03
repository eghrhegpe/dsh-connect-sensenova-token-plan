// @ts-check
/**
 * The shipped client bundle, loaded as a module instead of scraped as text.
 *
 * `client.js` is a browser artifact: it registers a lazy factory through
 * `window.__ModuleLoader__.load({ id, factory })` and touches nothing else at
 * module scope. That is exactly enough to run it in Node: this module installs
 * a capturing `__ModuleLoader__`, imports the real `client.js`, materializes
 * its factory with a minimal React stand-in, and exports what comes back.
 *
 * This replaces the previous approach — cutting functions out of the source
 * with balanced-brace walks and evaluating the snippets with `new Function`.
 * That worked, but its anchors were the client's *formatting*: renaming a
 * variable or moving a brace broke the tests for reasons that had nothing to
 * do with behaviour. Loading the real module has no anchors at all. If the
 * client's structure changes, these checks keep testing whatever the panel
 * actually runs.
 *
 * The React stand-in is deliberately minimal: `createElement` records a plain
 * object tree (what `texts`/`findElement` walk), and the hooks are no-op
 * shims. Only hook-free code is exercised through this surface today; a hook
 * component would need a real renderer, which is why `AccountForm` stays a
 * documented gap rather than a pretended one.
 *
 * Test-only: never imported by the plugin's own entry graph, so it is absent
 * from `package.json#files` on purpose (pinned by `test/package.test.mjs`).
 * @module dsh-connect-sensenova-token-plan/client-surface
 */

/** The registration id the client bundle declares. */
const CLIENT_ID = "dsh-connect-sensenova-token-plan";

/**
 * A recording stand-in for the client's `h`: plain objects instead of React
 * elements, function components left UNCALLED (exactly how React receives
 * them), so a check can expand the tree itself and see the real structure.
 * @type {(...args: unknown[]) => object}
 */
export const h = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.length === 1 && Array.isArray(children[0]) ? children[0] : children
});

/** Registrations captured from `client.js`'s single `window` call. */
const registrations = [];

// The client's only module-scope side effect. Installed before the dynamic
// import below, which is why the import is awaited at the top level.
const win = /** @type {Window & typeof globalThis & { __ModuleLoader__?: { load: (r: object) => void } }} */ (globalThis.window ?? {});
globalThis.window = win;
win.__ModuleLoader__ = {
  load: (registration) => registrations.push(registration)
};

/**
 * What the factory's `require` may hand out.
 *
 * The shipped bundle requires exactly one package (`react`); anything else
 * throws loudly, so a future import added to the client fails here first —
 * a browser module table would resolve it, this one will not say yes by
 * accident.
 */
const React = Object.freeze({
  createElement: h,
  Fragment: Symbol("Fragment"),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => undefined,
  useCallback: (callback) => callback,
  // `useMemo` returns the computed value (a fresh one per call, as a real
  // renderer would on its first pass); `useRef` hands back a stable mutable
  // box. Hook components are not mounted through this surface today, but
  // these keep the stand-in honest for anything that calls them.
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial })
});

// Exported so a suite that must drive REAL effects (see the polling-loop group
// in `render.test.mjs`) can install its own recording React through
// `runtime.ts` and then restore this one — the seam is a plain assignment, so
// handing it back is the whole contract.
export const reactStandin = React;

await import("../src/client/index.ts");

const registration = registrations.find((entry) => entry.id === CLIENT_ID);
if (registration === undefined) {
  throw new Error(
    `client-surface: client.js did not register "${CLIENT_ID}"; ` +
      "the bundle's entry structure changed, update this loader to match."
  );
}

/**
 * The materialized `panel` test surface of the shipped client module.
 *
 * The factory returns `{ inject, apply, panel }`: the first two are what the
 * Host reads, and `panel` is the module's own test surface (dictionaries, the
 * decision function, tables, style tokens, components) — all definitions the
 * browser runs, exposed rather than copied.
 * @type {{inject: Function, apply: Function, panel: object}}
 */
const materialized = registration.factory((specifier) => {
  if (specifier === "react") return React;
  throw new Error(
    `client-surface: the client bundle required "${specifier}", which this loader does not provide. ` +
      "The shipped bundle must stay dependency-free apart from react."
  );
});
export const surface = Object.freeze(/** @type {object} */ (materialized.panel ?? materialized));

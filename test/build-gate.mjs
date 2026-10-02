// @ts-check
/**
 * Gate for the build (docs/ARCHITECTURE.md / ROADMAP §6.2).
 *
 * `src/` holds ALL sources (host + client); `lib/` and the root `client.js`
 * are GENERATED artifacts, now VERSIONED (committed alongside src/ — see
 * .gitignore and the dsh-connect-qoder sibling's docs/issues/19: the DSH
 * marketplace `github:` install source is a pnpm git-dep that won't run
 * prepack/prepare, so an un-versioned lib/ makes a GitHub-direct install ship
 * without its host entry). They remain fully rebuildable from `src/`. This gate
 * owns the properties the offline suites (which import the SOURCES directly)
 * cannot see:
 *
 * 1. BUILD — `npm run build` (host bundle + client artifact) must succeed.
 * 2. FRESHNESS — the committed-into-the-working-tree `client.js` must match a
 *    rebuild of the current `src/client/`. A stale artifact silently ships
 *    yesterday's client; the suite that fails here tells you to rebuild (the
 *    fresh artifact is already in the working tree). When no artifact exists
 *    yet (clean checkout, never built), a fresh build trivially satisfies it.
 * 3. SHAPE — the artifact carries no top-level `import`/`export` statement
 *    (legal in all three module worlds), registers exactly one bundle under
 *    the plugin id when imported as ESM, materializes with a react-only
 *    stand-in require, and still exposes the panel test surface.
 *
 * Same rule as test/e2e-gate.mjs: if tsdown is not installed, print a loud
 * SKIP and exit 0 — a machine without dev deps is not a regression. (CI's
 * offline job installs nothing, so it always SKIPs here; wiring the build into
 * CI is a listed follow-up in ROADMAP §6.2.)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT = join(root, "client.js");
const HOST_BUNDLE = join(root, "lib", "index.js");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  if (!pass) console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
};

if (!existsSync(join(root, "node_modules", "tsdown", "package.json"))) {
  process.stderr.write(
    `\n[build-gate] SKIPPED — tsdown is not installed.\n` +
    `[build-gate]   Bootstrap dev deps with: npm i -D tsdown --legacy-peer-deps\n` +
    `[build-gate]   (the repo's peerDependencies are Host-runtime packages and do not\n` +
    `[build-gate]   resolve from a registry, so a plain npm install cannot run here).\n\n`
  );
  process.exit(0);
}

const normalized = (path) => existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
const before = normalized(ARTIFACT);

// 1. the full build (host bundle + client artifact) must succeed
const build = spawnSync("npm", ["run", "build"], {
  cwd: root,
  shell: true,
  encoding: "utf8",
  timeout: 180_000,
});
check("npm run build exits 0", !build.error && build.status === 0,
  String(build.stderr ?? build.error ?? "").slice(-2000));

if (build.error || build.status !== 0) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
}

// 2. the host bundle was produced (single lib/index.js entry point)
check("host bundle lib/index.js is produced", existsSync(HOST_BUNDLE),
  existsSync(HOST_BUNDLE) ? "" : "the host build did not emit lib/index.js");
check("host bundle is non-empty", existsSync(HOST_BUNDLE) && readFileSync(HOST_BUNDLE, "utf8").trim().length > 0,
  "");

// 3. freshness: the working-tree artifact must equal a rebuild of the sources.
//    `before` is null on a clean checkout (no artifact yet) — a fresh build is
//    then trivially fresh.
const after = normalized(ARTIFACT);
check("client.js is fresh (rebuild reproduces it byte-for-byte)", before === null || before === after,
  before === null ? "" : "the artifact drifted from src/client/ — the fresh build is now in the working tree; review and commit it");

// 4. shape: no top-level import/export statement — the file is evaluated by
//    the browser module table AND imported as legal ESM in Node (the tail in
//    src/client/index.ts pins all three worlds). This pins a property of the
//    GENERATED output, not of the sources, so it is a contract check, not a
//    text anchor.
const artifactText = after ?? "";
check("artifact has no top-level import/export statement",
  !/^\s*import\s*[{*"'\w]/m.test(artifactText) && !/^\s*export\s*[{*\w]/m.test(artifactText));

// 5. behavioral surface: imported as ESM with a capturing
//    `window.__ModuleLoader__` (the client-surface pattern), the artifact
//    must register exactly one bundle under the plugin id, materialize with
//    a react-only stand-in require, and expose the panel surface keys.
const reactStandin = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol("Fragment"),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => undefined,
  useCallback: (callback) => callback,
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial })
};

const win = /** @type {any} */ (globalThis.window ?? {});
globalThis.window = win;
const captured = [];
win.__ModuleLoader__ = { load: (registration) => captured.push(registration) };

await import(pathToFileURL(ARTIFACT).href);

check("artifact registers exactly one bundle", captured.length === 1, `got ${captured.length}`);
if (captured.length === 1) {
  const registration = captured[0];
  check("registration carries the plugin id", registration.id === "dsh-connect-sensenova-token-plan",
    String(registration.id));
  let surface = null;
  try {
    const instance = registration.factory((specifier) => {
      if (specifier === "react") return reactStandin;
      throw new Error(`unexpected require of "${specifier}"`);
    });
    surface = instance.panel;
    check("factory returns an apply function", typeof instance.apply === "function",
      String(typeof instance.apply));
    check("factory returns the inject list", Array.isArray(instance.inject) && instance.inject.join(",") === "slots,locale",
      JSON.stringify(instance.inject));
  } catch (error) {
    check("factory materializes with a react-only require", false, String(error));
  }
  const surfaceKeys = ["interpretSnapshot", "viewOf", "errorOfStatus", "dictionaries", "tables", "styles", "helpers", "components"];
  check("panel surface exposes every documented key", surface !== null && surfaceKeys.every((key) => key in surface),
    surface === null ? "panel missing" : surfaceKeys.filter((key) => !(key in surface)).join(","));
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

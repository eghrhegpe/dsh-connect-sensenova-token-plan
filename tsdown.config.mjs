// @ts-check
/**
 * Build configuration. `src/` holds ALL sources (host + client); `lib/` and the
 * root `client.js` are build artifacts that are **versioned on purpose** — the
 * DSH marketplace installs from `github:`, and that install path does not run
 * `prepack`, so an untracked `lib/` ships a package whose `main` does not
 * exist. Rationale and the freshness gate that protects it: `test/build-gate.mjs`
 * and `.gitignore`'s own comment; decided in ADR-005.
 *
 * Two entries:
 *
 * 1. HOST — `src/host/index.ts` bundled to a single `lib/index.js`. A single
 *    bundle (not preserve-modules) is deliberate: the published surface is one
 *    entry point (`package.json#main` + `exports["."]`), and the offline suites
 *    import the SOURCES directly (`../src/host/*.ts`, Node strips types
 *    natively on 22.19+/24), so no per-module `lib/` output is needed for
 *    either the runtime or the tests. Every peer package stays external.
 *
 * 2. CLIENT — `src/client/index.ts` bundled to the root `client.js` artifact
 *    (IIFE, see below). Its path/filename/loader-ABI are contracts:
 *    `package.json#exports`, the browser loader, and `client-surface.js` all
 *    consume the same file. It is GENERATED and `test/build-gate.mjs` fails the
 *    suite when it goes stale.
 *
 * `format: "iife"` (client) is load-bearing, not a style choice: rolldown's
 * syntax detector keys on the tail's `module.exports` branch and an esm build
 * would wrap the bundle in a `__commonJS` shim plus a top-level `export
 * default`, rewriting the loader ABI. An IIFE keeps every statement inside one
 * function scope — the top level is a single expression with no import/export,
 * legal whether the loader evaluates the text as a script or as a module, and
 * the tail's three-world registration branches still run inside it.
 */
import { defineConfig } from "tsdown";

/** Peer packages that must resolve from the Host runtime, never be bundled. */
const NEVER_BUNDLE = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-llm-pi-ai",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-host-webserver",
  "@deepseek-ai/schemastery",
  "@earendil-works/pi-ai",
];

export default defineConfig([
  {
    name: "host",
    entry: ["src/host/index.ts"],
    outDir: "lib",
    format: "esm",
    platform: "node",
    target: "es2023",
    // One entry file, but NOT one output file. `splitting: false` governs
    // STATIC splitting only; the two adapter modules are reached through a
    // literal `import()` at the call site (`deps.loadAdapterModule ?? (() =>
    // import("./llm-adapter.ts"))`), and a dynamic import forces a split chunk
    // no matter what `splitting` says. That is load-bearing LAZINESS, not an
    // accident: the adapters are only needed once a provider is actually
    // published, so a Host running the panel alone never parses them.
    //
    // The consequence to keep in mind when editing: `lib/` is a CHUNK GRAPH
    // whose chunk names carry a content hash, so `lib/index.js` is only valid
    // alongside the exact chunks it names. A partial `git add lib/` (committing
    // the entry but not a renamed chunk) ships a package that throws
    // ERR_MODULE_NOT_FOUND at plugin load. `test/build-gate.mjs` walks the graph
    // from this entry and fails on a dangling or orphaned chunk, with no
    // toolchain needed.
    splitting: false,
    clean: true,
    minify: false,
    sourcemap: false,
    dts: false,
    outExtensions: () => ({ js: ".js" }),
    deps: { neverBundle: [...NEVER_BUNDLE] },
  },
  {
    name: "client",
    entry: ["src/client/index.ts"],
    outDir: ".",
    format: "iife",
    platform: "browser",
    target: "es2020",
    // react must keep resolving through the loader's module table, never be
    // bundled: the browser world materializes `clientFactory` with its own
    // `require`, and the Node suites hand the factory a stand-in. In the
    // sources the call is `loaderRequire("react")` — a plain parameter call,
    // invisible to the bundler — so this pin is belt and braces.
    deps: { neverBundle: ["react"] },
    outputOptions: {
      entryFileNames: "client.js",
      name: "dsh_connect_sensenova_token_plan_client",
    },
    // outDir is the repo root (the artifact lives at the package root by
    // contract), so tsdown's clean must never run here.
    clean: false,
    minify: false,
    sourcemap: false,
    dts: false,
  },
]);

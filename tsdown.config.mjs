// @ts-check
/**
 * Build configuration. `src/` holds ALL sources (host + client); `lib/` and the
 * root `client.js` are build artifacts that are **versioned on purpose** — the
 * DSH marketplace installs plugins with pnpm, and pnpm refuses to run build
 * scripts for git deps outright (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`; the fix
 * is an `allowBuilds` allowlist entry, which a plugin installer does not have).
 * So "swap `prepack` for `prepare` and let the install build itself" is a DEAD
 * END: npm does run `prepare` on a git install (verified 2026-10-05), pnpm does
 * not. Without a committed `lib/`, the GitHub-direct install ships a package
 * whose `main` does not exist. The npm registry channel is unaffected (`prepack`
 * builds the tarball), but it cannot rescue the GitHub channel. Rationale and the
 * freshness gate that protects it: `test/build-gate.mjs` and `.gitignore`'s own
 * comment; decided in ADR-005.
 *
 * Chunk names carry NO content hash (`chunkFileNames: "[name].js"`, host entry
 * below): a rebuild then edits the same filenames in place, so `git status` shows
 * one `M` per changed chunk instead of a `D` + untracked-new pair, and a
 * path-limited commit stops silently dropping a freshly-named chunk (AGENTS.md).
 * The gate reads no hardcoded name list — it walks the emitted graph — so this
 * config change does not move its baseline.
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
    // The consequence to keep in mind when editing: `lib/` is a CHUNK GRAPH, so
    // `lib/index.js` is only valid alongside the exact chunks it names. A partial
    // `git add lib/` (committing the entry but not a chunk that is not yet
    // tracked) ships a package that throws ERR_MODULE_NOT_FOUND at plugin load.
    // Chunk names carry NO content hash, so a chunk becomes untracked only the
    // FIRST time a split module is introduced — never on a plain edit.
    // `test/build-gate.mjs` walks the graph from this entry and fails on a
    // dangling or orphaned chunk, with no toolchain needed.
    splitting: false,
    clean: true,
    minify: false,
    sourcemap: false,
    dts: false,
    outExtensions: () => ({ js: ".js" }),
    outputOptions: {
      // Both pinned WITHOUT a content hash. The entry pin is belt and braces (the
      // default already yields `index.js` for `src/host/index.ts`); the chunk pin
      // is the whole point — a stable name makes a rebuild rewrite the same file
      // in place instead of emitting a differently-named twin next to a dead one.
      entryFileNames: "index.js",
      chunkFileNames: "[name].js"
    },
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

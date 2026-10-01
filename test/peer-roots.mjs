/**
 * Resolve this plugin's peer dependencies to the Host that ships them.
 *
 * `@deepseek-ai/dsh-credentials` is a PEER dependency: it is not installed into
 * this plugin, because it lives inside the DSH runtime. A bare
 * `import ... from "@deepseek-ai/dsh-credentials"` therefore fails with
 * ERR_MODULE_NOT_FOUND on a clean checkout — which is how this suite came to
 * read as unrunnable, when in fact it only ever passed in a session that had a
 * `node_modules` symlink in place.
 *
 * Tests import their peer through here instead, so `npm test` works on a fresh
 * clone with no manual setup. Nothing is installed and nothing is downloaded:
 * the copy inside the Host is used, which is the same one that will run the
 * plugin.
 *
 * The Host copy is not always there. On a CI runner the ONLY candidate is the
 * repo's own `node_modules`, which `npm install --legacy-peer-deps` leaves
 * without an `@deepseek-ai` scope at all — the root manifest declares those
 * packages as PEER dependencies, and that flag means npm skips them rather than
 * fetching them. The gate then died at its second suite (`store.test.mjs`) and
 * the remaining seventeen never ran, on every push, silently. So the
 * npm-installed CLI's own tree is a candidate as well: it is the one complete,
 * version-consistent set (its siblings resolve each other through peers too —
 * `dsh-credentials-local` imports `@deepseek-ai/dsh-atomic-write`, so a
 * two-or-three-package install from the registry leaves dangling imports), and
 * it is listed LAST so a developer machine keeps preferring the runtime it
 * actually runs.
 *
 * Usage: `const { credentialKey } = await loadPeer("dsh-credentials");`
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The plugin root — the tests import `../index.js` from it. */
const ROOT = join(HERE, "..");

/** What a root must carry to be the Host runtime rather than a look-alike. */
const PEER_MARKER = join("@deepseek-ai", "dsh-credentials-local");

/**
 * Where the Host keeps its unpacked runtime, most specific first.
 *
 * `$DSH_HOME` wins so a dev checkout can point elsewhere; the rest cover a
 * normal install and a checkout with an extracted asar.
 * @returns {string[]} existing candidate `node_modules` roots.
 */
function candidateRoots() {
  const home = process.env.DSH_HOME;
  const localAppData = process.env.LOCALAPPDATA ?? "";
  return [
    ...(home === undefined || home === "" ? [] : [join(home, "dsh-asar-unpacked", "dsh", "node_modules")]),
    // A dev checkout may have linked its peers in already; that wins.
    join(ROOT, "node_modules"),
    // The default install layout: the Host unpacks its runtime under ~/.dsh.
    // Without this a machine that simply never sets DSH_HOME — the common
    // case, and the one this file's header promises to handle — had no
    // usable candidate, because the packaged app's node_modules carries no
    // @deepseek-ai scope.
    join(homedir(), ".dsh", "dsh-asar-unpacked", "dsh", "node_modules"),
    ...(localAppData === "" ? [] : [join(localAppData, "Programs", "DeepSeek Harness", "resources", "app.asar.unpacked", "dsh", "node_modules")]),
    // Last two, and deliberately so: a developer machine must keep resolving
    // against the runtime it actually runs. These are for the machine that has
    // no Host install at all — CI, first and foremost: the meta package in the
    // workspace, then the CLI's own tree (the one an `npm install -g` creates).
    join(ROOT, "node_modules", "@deepseek-ai", "dsh", "node_modules"),
    cliRuntimeModules()
  ].filter((candidate) => typeof candidate === "string" && candidate !== "" && existsSync(candidate));
}

/**
 * The `node_modules` tree of the npm-installed DSH CLI, when there is one.
 *
 * This is the source `test/e2e.mjs` has always used, for a reason worth
 * restating: it is the package set the CLI was built against, it is complete,
 * and it carries no user plugins. The unpacked desktop runtime under `~/.dsh`
 * looks like a candidate and is NOT one for booting a whole Host (a different
 * version, which shows up as a third of its entries failing to activate) — but
 * it is perfectly good for the offline suites' narrower needs, which is why it
 * keeps its earlier place in `candidateRoots`.
 *
 * Memoized: computing it spawns `npm root -g`, and `loadPeer` is called more
 * than once per suite. A machine where the spawn fails (a packaged desktop app
 * has no global tree; a confined sandbox may refuse a piped child) simply gets
 * one fewer candidate instead of an exception.
 * @returns {string|undefined} a `node_modules` directory, or undefined.
 */
let cliRuntimeCache = null;
export function cliRuntimeModules() {
  if (cliRuntimeCache !== null) return cliRuntimeCache === false ? undefined : cliRuntimeCache;
  // One command string, not argv + `shell: true`: the argv form is deprecated
  // precisely because it concatenates unescaped arguments (DEP0190), and this
  // runs in every suite that falls back here.
  const root = spawnSync("npm root -g", { shell: true, encoding: "utf8", timeout: 30_000 });
  if (root.error !== undefined || root.status !== 0) {
    cliRuntimeCache = false;
    return undefined;
  }
  const prefix = root.stdout.trim();
  const anchor = prefix === "" ? "" : join(prefix, "@deepseek-ai", "dsh", "node_modules");
  // The marker is a package the Host itself needs; without it the directory is
  // not the runtime, and using it would only trade one ERR_MODULE_NOT_FOUND for
  // another.
  cliRuntimeCache = anchor !== "" && existsSync(join(anchor, "@deepseek-ai", "dsh-base")) ? anchor : false;
  return cliRuntimeCache === false ? undefined : cliRuntimeCache;
}

/**
 * The first candidate root that actually ships the Host's DSH packages.
 *
 * The marker is the package the callers resolve BY PATH (`store.test.mjs`
 * builds `<root>/@deepseek-ai/dsh-credentials-local/lib/index.js` from it), not
 * merely the presence of an `@deepseek-ai` folder: a dev checkout that linked
 * in a couple of the LLM peers gets an `@deepseek-ai` scope of its own, and
 * that near-miss root would win the search while pointing at packages it does
 * not have.
 * @returns {string|undefined} a `node_modules` root, or `undefined`.
 */
export function findPeerRoot() {
  return candidateRoots().find((root) => existsSync(join(root, PEER_MARKER))) ?? undefined;
}

/**
 * Import one of the Host's DSH packages.
 *
 * Resolution is done with a `require` rooted at the runtime, because only
 * `require` can be pointed at an arbitrary `node_modules`; the entry it finds
 * is then imported as an ES module, which is what the package is.
 * @param {string} name - the package name, e.g. `dsh-credentials`.
 * @returns {Promise<object>} the package's exports.
 * @throws {Error} when no candidate root carries the package, naming every
 *   place that was looked in — a silent fallback would just move the failure.
 */
export async function loadPeer(name) {
  const specifier = name.startsWith("@") ? name : `@deepseek-ai/${name}`;
  const roots = candidateRoots();
  // One line per candidate, saying what actually happened there. The previous
  // silent `catch` reported "Looked in: <root>" for roots that WERE examined
  // and failed for an unstated reason, which sent the reader hunting in the
  // wrong direction — the failure's cause is the diagnosis, not the search
  // path.
  const attempts = [];
  for (const root of roots) {
    if (!existsSync(join(root, "@deepseek-ai"))) {
      attempts.push(`${root}: no @deepseek-ai scope`);
      continue;
    }
    try {
      const entry = createRequire(join(root, "package.json")).resolve(specifier);
      return await import(pathToFileURL(entry).href);
    } catch (error) {
      attempts.push(`${root}: ${String(error?.message ?? error).split("\n")[0]}`);
    }
  }
  throw new Error(
    `cannot resolve the peer dependency ${specifier}.\n` +
      `Looked in:\n${attempts.map((a) => `  - ${a}`).join("\n")}\n` +
      "It ships inside the DSH runtime rather than in this plugin. Set $DSH_HOME, " +
      "or symlink a node_modules into the plugin folder."
  );
}

export { ROOT };

/**
 * Hide this machine's SenseNova environment from the checks.
 *
 * `index.js` reads `SENSENOVA_API_KEY` out of `process.env` when it mounts. A
 * developer machine that has one set therefore takes a path the suite never
 * stubbed: the model catalog is fetched for real, which trips the network
 * guard, and the request it makes carries a Bearer token that is not the
 * console token — so "the console saw the stored token" fails for a reason
 * that has nothing to do with the code under test.
 *
 * A suite that is green on a clean machine and red on its author's is not
 * offline; it is only usually offline. These keys are removed for the whole
 * run and restored afterwards.
 * @param {string[]} [keys] - the variables to hide.
 * @returns {() => void} restore.
 */
export function isolateHostEnv(keys = ["SENSENOVA_API_KEY", "SENSENOVA_USERNAME", "SENSENOVA_PASSWORD"]) {
  const saved = keys.map((key) => [key, process.env[key]]);
  for (const key of keys) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Point `$DSH_HOME` at a scratch directory for the rest of the run.
 *
 * The plugin keeps durable state there — login traces under `logs/`, the
 * sign-in throttle under `state/` — and a suite that writes either into the
 * developer's real Home is not offline, it is destructive: a throttle left
 * behind by one run refuses every later login, including the Host's own.
 *
 * Call this AFTER {@link loadPeer}, which is the one thing that needs the real
 * Home: it is where the peer packages are found.
 * @returns {() => void} restore.
 */
export function isolateStateDir() {
  const saved = process.env.DSH_HOME;
  const dir = mkdtempSync(join(tmpdir(), "dsh-connect-sensenova-token-plan-state-"));
  process.env.DSH_HOME = dir;
  return () => {
    if (saved === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  };
}

/**
 * Record every request that is not answered by a stub.
 *
 * "The suite never touches the real platform" is the property that keeps a
 * test run from becoming a source of login attempts — the exact failure this
 * plugin had to be fixed for. Asserting it is better than claiming it: a
 * stray unstubbed `fetch` shows up here instead of quietly reaching IAM.
 *
 * Installed by importing this module, so no test file can forget it. A stub
 * installed with `withNetwork` replaces `globalThis.fetch` and is therefore
 * never seen here — only calls that escape every stub are recorded.
 * @returns {() => string[]} a function yielding the unstubbed URLs seen.
 */
export function installNetworkGuard() {
  const real = globalThis.fetch;
  const escaped = new Set();
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    escaped.add(url);
    throw new Error(
      `the offline suite made an unstubbed request to ${url}. ` +
        "Every check must serve its own network; see test/live-jwks.test.mjs for the one " +
        "check that is allowed to reach the platform, and run it with `npm run test:live`."
    );
  };
  return () => {
    globalThis.fetch = real;
    return [...escaped];
  };
}

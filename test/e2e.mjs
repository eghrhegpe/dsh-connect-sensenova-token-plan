/**
 * End-to-end: a REAL `dsh web` process, the real plugin, real HTTP.
 *
 * Everything below the Host is a stub — a fake SenseNova platform on
 * 127.0.0.1 — but nothing below the plugin is faked: the bundle is loaded by
 * the Loader, the routes are registered with the real webserver, the browser
 * trust fence and auth cookie are the Host's own, and the panel renders from
 * the response a real HTTP client received.
 *
 * The isolation is deliberate and total:
 *
 *   - A SEPARATE `$DSH_HOME`, so the run cannot see the real credentials, the
 *     real plugin registry, or the real profiles.
 *   - NO account credentials anywhere. The panel boots into `not_configured`.
 *   - Every endpoint redirected to 127.0.0.1, so even a bug that tried to sign
 *     in would reach the fake.
 *
 * That last pair is not ceremony. An earlier attempt at this harness used a
 * nested `auth:` block, which the loader accepts and the plugin ignores — so
 * the panel used its shipped defaults and POSTED A REAL LOGIN ATTEMPT to
 * iam.sensecoreapi.cn during a test run. The plugin now rejects that shape
 * outright (see resolveAuthOverrides), and this harness asserts the redirect
 * actually took effect before it lets a sign-in happen.
 *
 * Run it directly with `npm run test:e2e`, or through `npm test`: the default
 * gate ends in `test/e2e-gate.mjs`, which runs this file when the dsh CLI is on
 * PATH and prints a loud SKIP (exit 0) when it is not. It boots a server, so it
 * is slower than the offline suites and needs the CLI present to actually run.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliRuntimeModules } from "./peer-roots.mjs";

/**
 * Where this plugin lives, derived from the running file — never hard-coded.
 *
 * The default used to be one machine's absolute path, which made the run
 * silently point at the wrong directory on every other checkout (and fail in CI
 * for a reason that looked like a plugin bug). Forward slashes are normalised
 * because the path is embedded into a profile `package.json` as a `link:`
 * dependency value, where backslash-escapes do not survive JSON. `PANEL_DIR`
 * still overrides, for an out-of-tree checkout.
 */
const PLUGIN_DIR = (process.env.PANEL_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".."))
  .replace(/\\/g, "/");
/** `dsh` from the npm global bin; the shim on PATH is preferred when present. */
const DSH = process.env.DSH_CLI ?? "dsh";

/**
 * Ask the OS for a free port.
 *
 * Hard-coded ports collide with a previous run that has not finished releasing
 * its socket, and the symptom is a bare "fetch failed" with nothing pointing at
 * the real cause.
 * @returns {Promise<number>} a port nothing is listening on.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}
function note(text) {
  process.stdout.write(`  ${text}\n`);
}

/**
 * Deadline for ONE request to the Host.
 *
 * Only the Host's boot had a timeout, so a check whose `fetch` never settled
 * hung the run forever — no failure, no output, just a process that never
 * returns. Every call to the Host now carries its own deadline, and a refusal
 * to answer becomes a failed check naming the request that did not answer.
 */
const CALL_TIMEOUT_MS = 15_000;

/**
 * Deadline for the whole run.
 *
 * The backstop behind the per-call deadlines: nothing in a test runner should
 * be able to hang indefinitely, least of all one that spawns a real Host
 * process. Exceeding it fails the run loudly instead of waiting forever.
 */
const RUN_TIMEOUT_MS = 240_000;

/** Reject when `promise` has not settled in `ms`. */
function withDeadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms}ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

/**
 * The runtime packages a profile resolves, taken from the CLI's own install.
 *
 * The Loader resolves every bundle — `@deepseek-ai/dsh-base` included, and the
 * Host's own internals with it — relative to `<DSH_HOME>/profiles`, NOT relative
 * to wherever the CLI was installed. A hand-built temp home therefore has no
 * packages to find, and the boot dies with 154 × `Cannot find package
 * '<runtime dep>'`: a failure that reads exactly like a plugin regression and is
 * nothing but a missing shared directory. (It is not even about this plugin —
 * an isolated profile with no plugin at all fails the same way, and so does one
 * built from a commit predating the change under test.)
 *
 * The CLI's install tree is the right source, and the only one that is both
 * complete and isolated: it is exactly the package set this CLI version was
 * built against, and it carries no user plugins (`dsh-connect-*` count: zero),
 * so sharing it cannot pull the developer's real profile in. The unpacked
 * desktop runtime under `~/.dsh` looks like a candidate and is not one: it is a
 * different version, which shows up as a third of its entries failing to
 * activate.
 *
 * The lookup itself now lives in `peer-roots.mjs` (`cliRuntimeModules`), the one
 * place that answers "where is the Host runtime?" for every suite. The offline
 * suites need it for their PEER packages (which is the same question), and they
 * need it for the same reason: a machine with no desktop install — CI — has no
 * other complete source.
 *
 * `undefined` means the CLI is not an npm install (a packaged desktop app has no
 * global tree); the home is then left as it was, and the boot failure says what
 * it could not find.
 */

/** The isolated home: a profile whose only plugin is ours, aimed at the fake. */
function buildHome(fakePort) {
  const home = mkdtempSync(join(tmpdir(), "dsh-panel-e2e-"));
  const profile = join(home, "profiles", "web");
  mkdirSync(join(profile, "node_modules"), { recursive: true });
  symlinkSync(PLUGIN_DIR, join(profile, "node_modules", "dsh-connect-sensenova-token-plan"), "junction");
  writeFileSync(join(profile, "package.json"), JSON.stringify({
    name: "dsh-profile-web-e2e",
    private: true,
    dependencies: { "dsh-connect-sensenova-token-plan": `link:${PLUGIN_DIR}` },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-connect-sensenova-token-plan"] } }
  }, null, 2));

  // The row id is the one the plugin's own patch declares, and the login-flow
  // overrides are TOP-LEVEL keys. A nested `auth:` block is accepted here and
  // ignored by the plugin, which is how the run once reached the real IAM.
  writeFileSync(join(profile, "cordis.patch.yml"), [
    "- id: dsh-connect-sensenova-token-plan",
    "  name: dsh-connect-sensenova-token-plan",
    "  config:",
    `    consoleBase: http://127.0.0.1:${fakePort}`,
    `    apiBase: http://127.0.0.1:${fakePort}/v1`,
    `    iamBase: http://127.0.0.1:${fakePort}`,
    `    tokenEndpoint: http://127.0.0.1:${fakePort}/oauth2/token`,
    `    jwksEndpoint: http://127.0.0.1:${fakePort}/.well-known/jwks.json`,
    `    redirectUri: http://127.0.0.1:${fakePort}`,
    // Step three is opt-in, so the run has to opt in: with this on, the Host
    // tries to register the SenseNova provider for real, and the peer
    // packages (`@earendil-works/pi-ai`, `@deepseek-ai/dsh-llm*`) must resolve
    // out of the Host's own runtime — a clean checkout has none. Leaving it
    // off would test the degradation path and silently skip the feature.
    "    registerProvider: true",
    ""
  ].join("\n"));

  // Sibling of the profile, not inside it: this is the shared tree every
  // profile on a real machine resolves through, and the CLI looks for it there.
  const shared = cliRuntimeModules();
  if (shared === undefined) {
    note("no CLI install tree to share — the boot will fail to resolve its runtime packages");
  } else {
    symlinkSync(shared, join(home, "profiles", "node_modules"), "junction");
    note(`shared runtime packages: ${shared}`);
  }
  return home;
}

/** Start the fake platform in this process and wait for it to listen. */
async function startFake(port) {
  process.env.FAKE_PORT = String(port);
  // Loaded from THIS file's directory, not from PLUGIN_DIR: even when
  // PANEL_DIR points the Host at an out-of-tree checkout, the fake the run
  // talks to stays the sibling of the runner that drives it.
  return import(`${new URL("./fake-platform.mjs", import.meta.url).href}?${Date.now()}`);
}

/** Boot the Host and resolve with its launch token once it prints one. */
/**
 * Kill the Host AND everything it spawned.
 *
 * `spawn(..., { shell: true })` runs the CLI through a shell wrapper, so the
 * handle we hold is the WRAPPER, not the Host. `child.kill()` therefore reaps
 * the wrapper and leaves the real `node .../dsh/lib/bin.js` running — observed
 * on this machine as a 342 MB orphan still holding its port minutes after a
 * green run, which is exactly the "next run fails for an unrelated reason"
 * failure the watchdog comment warns about.
 *
 * So kill the whole tree: `taskkill /T` on Windows (the wrapper is cmd.exe,
 * whose child is the real Host), the process group elsewhere. The POSIX branch
 * needs the spawn to be `detached` — that makes the child a group leader so
 * `-pid` addresses the group.
 * @param {import("node:child_process").ChildProcess} child
 */
function killHostTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // No group (spawn was not detached, or the group is already gone): fall
    // back to the direct kill we used to rely on.
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

function startHost(home, port) {
  return new Promise((resolve, reject) => {
    // The developer's own SenseNova environment is STRIPPED from the child.
    // `SENSENOVA_API_KEY` in the launching shell reaches the Host as an
    // environment credential, which the credentials service then treats as
    // read-only ("supplied read-only by the launching environment") — so the
    // run fetched the catalog before any key was entered, and the panel's own
    // save was refused. Both are failures of the harness, not of the plugin,
    // and both are invisible on a machine that happens to have no key set.
    // Same three names the offline suites hide (see peer-roots.mjs).
    const env = { ...process.env, DSH_HOME: home };
    for (const key of ["SENSENOVA_API_KEY", "SENSENOVA_USERNAME", "SENSENOVA_PASSWORD"]) delete env[key];
    const child = spawn(DSH, ["--profile", "web", "--no-open", "--port", String(port)], {
      env,
      shell: true,
      // POSIX only: make the child a group leader so the teardown can signal the
      // whole tree with `-pid`. On Windows the group kill goes through
      // `taskkill /T` instead (see killHostTree).
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`the Host did not report a URL:\n${out}`)), 180_000);
    const onData = (chunk) => {
      out += String(chunk);
      const match = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9._~-]+)/);
      if (match !== null) {
        clearTimeout(timer);
        resolve({ child, url: `http://127.0.0.1:${port}/?token=${match[1]}`, output: () => out });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      // Recorded rather than thrown: an exit AFTER the URL was printed is a
      // different (and much more interesting) failure than one before, and it
      // arrives while requests are in flight.
      child.exited = { code, signal };
      reject(new Error(`the Host exited (${String(code)}/${String(signal)}) before serving:\n${out}`));
    });
  });
}

/** A session carrying the Host's own browser-trust cookie. */
async function openSession(url, port) {
  const first = await fetch(url);
  const cookie = (first.headers.getSetCookie?.() ?? []).map((line) => line.split(";")[0]).join("; ");
  return {
    cookie,
    /** A call that presents the cookie and a matching origin. */
    async call(path, init = {}) {
      const label = `${init.method ?? "GET"} ${path}`;
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        // Each request gets a deadline. Without one, a Host that accepts the
        // connection and never answers hangs the entire run with no output.
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        // No connection reuse. The Host closes sockets after a response, and
        // undici will happily hand a closed one back from its pool — which
        // surfaces as `UND_ERR_SOCKET` on a request the server never received.
        // Each call is one short-lived connection, which is exactly what a test
        // wants and costs nothing at this rate.
        headers: { cookie, origin: `http://127.0.0.1:${port}`, connection: "close", ...init.headers }
      }).catch((error) => {
        // Name the request, and say whether the Host is still alive: a bare
        // "fetch failed" from a ten-call run says nothing about which call died
        // or whether the process went with it.
        const exited = host?.child?.exited;
        throw new Error(
          `${label} failed: ${error?.cause?.code ?? error?.message ?? error}` +
          `${exited === undefined ? "" : ` (the Host exited: ${String(exited.code)}/${String(exited.signal)})`}`
        );
      });
      // The body gets a deadline too: a response that opens and then stalls
      // would otherwise hang here, past the point the request deadline covers.
      return readJson(response, label);
    }
  };
}

/**
 * Read a response as JSON when it is JSON, and as text when it is not.
 * @param {Response} response - the response to read.
 * @returns {Promise<{status: number, body: object|null, text: string}>}
 */
async function readJson(response, label = "the response") {
  const text = await withDeadline(response.text(), CALL_TIMEOUT_MS, `reading the body of ${label}`);
  try { return { status: response.status, body: JSON.parse(text), text }; } catch { return { status: response.status, body: null, text }; }
}

let host = null;
let fake = null;
let home = null;
const PORT = await freePort();
const FAKE_PORT = await freePort();
home = buildHome(FAKE_PORT);

/**
 * The run-wide backstop: past this the run is a failure, not a slow test.
 *
 * It reports which check it died on rather than just dying, because "the e2e
 * hung" is unactionable and "it hung on the token exchange" is not. The Host
 * is killed on the way out — an orphaned Host holding its port is what makes
 * the NEXT run fail for an unrelated reason.
 */
const watchdog = setTimeout(() => {
  const last = results.at(-1)?.name ?? "(none)";
  check("the e2e run finished inside its budget", false,
    `exceeded ${RUN_TIMEOUT_MS}ms; the last check reached was: ${last}`);
  host?.child && killHostTree(host.child);
  console.log(JSON.stringify(results, null, 2));
  console.error(
    `\nthe e2e run exceeded ${RUN_TIMEOUT_MS}ms — failing rather than hanging forever.` +
    `\nlast check reached: ${last}`
  );
  process.exit(1);
}, RUN_TIMEOUT_MS);

try {
  note(`isolated home: ${home}`);
  fake = await startFake(FAKE_PORT);
  note(`fake platform on 127.0.0.1:${FAKE_PORT}`);

  host = await startHost(home, PORT);
  note(`dsh web on 127.0.0.1:${PORT}`);

  const warnings = host.output();
  check("the plugin activated without a loader warning",
    !warnings.includes("did not activate"), warnings.split("\n").filter((l) => l.includes("activate")).join(" | "));
  check("the routes were not rejected as duplicates",
    !warnings.includes("duplicate exact route"));
  // A peer-range mismatch makes the loader SKIP the whole bundle, and the run
  // would then die on the first call to an API route that was never registered:
  // a bare 401 from the Host's default handler, every subsequent check "401 /
  // undefined / {}", and a failure mode that looks like a plugin bug but is
  // really a packaging one. Catch the skip where its evidence exists — in the
  // boot log — and name the remedy in the first check that would otherwise die.
  const skippedLines = warnings.split("\n").filter((l) => l.includes("skipping profile bundle"));
  check("the plugin bundle was not skipped by the loader",
    skippedLines.length === 0, skippedLines.join(" | ").slice(0, 400));

  const session = await openSession(host.url, PORT);
  const call = session.call;
  /**
   * A JSON POST through the same session (origin + trust cookie) as `call`.
   *
   * The wire shape is the bare object: `readJsonBody` wraps it into
   * `{ok, value}` internally, so the panel sends `{"enabled":false}`, not
   * `{"value":{"enabled":false}}`. A wrong wrap here reads as a refused
   * mutation rather than as a test bug, which is how the first pass of this
   * block lost ten checks.
   */
  const post = (path, value) => call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  });

  // === the panel is reachable and honest about having no account ==========
  {
    const res = await call("/api/dsh-connect-sensenova-token-plan/snapshot");
    check("the snapshot route answers through the real webserver", res.status === 200, String(res.status));
    check("an unconfigured panel reports the quota unavailable, not an error",
      res.body?.ok === true && res.body?.quotaError?.code === "not_configured", JSON.stringify(res.body ?? {}).slice(0, 120));
    check("it demands no user action on a fresh install",
      res.body?.auth?.needsUserAction === false, String(res.body?.auth?.needsUserAction));
  }

  // === the Host's own browser-trust fence ===============================
  // A request with a foreign Origin is refused by the Host before the plugin
  // is reached. (A bare local request with no Origin IS admitted — the Host
  // treats it as same-origin — so the fence is about the Origin header.)
  {
    const res = await readJson(await fetch(`http://127.0.0.1:${PORT}/api/dsh-connect-sensenova-token-plan/snapshot`, {
      headers: { origin: "https://evil.test" }
    }));
    check("a foreign origin is refused by the Host", res.status === 401 || res.status === 403, String(res.status));
  }

  // === the cross-origin fence is the plugin's own ========================
  {
    const res = await readJson(await fetch(`http://127.0.0.1:${PORT}/api/dsh-connect-sensenova-token-plan/account`, {
      method: "POST",
      headers: { cookie: session.cookie, origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ username: "attacker", password: "x" })
    }));
    check("a cross-origin account post is refused", res.status === 403, String(res.status));
  }

  // === a real sign-in, against the fake ==================================
  {
    // The full login takes several round trips inside ONE request. The Host's
    // read timeout may be shorter than the fake's whole flow, in which case the
    // server answers and then drops the socket. Give the exchange room.
    const before = fake.log.iam;
    const res = await call("/api/dsh-connect-sensenova-token-plan/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "e2e-user", password: "e2e-test-password" })
    }).catch((error) => {
      // One retry: a socket the Host closed between the server finishing and
      // the client reading is a transport hiccup, not a verdict. The fake's
      // own counter decides whether the attempt actually happened.
      note(`sign-in transport hiccup (${error.message}); retrying once`);
      return call("/api/dsh-connect-sensenova-token-plan/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "e2e-user", password: "e2e-test-password" })
      });
    });
    check("the sign-in succeeded", res.body?.ok === true, JSON.stringify(res.body ?? {}).slice(0, 200));
    // The state nonce the authorization request issued must have round-tripped
    // through the callback — the fake now echoes it back and the flow verifies
    // the round-trip, so a broken echo fails the sign-in itself.
    check("the callback round-tripped the state nonce",
      typeof fake.seen.state === "string" && fake.seen.state.length > 0, String(fake.seen.state));
    // Where the request actually went. The fake's own counter is the evidence,
    // and it is what an earlier version of this harness failed to check: a
    // nested `auth:` block was accepted by the loader, ignored by the plugin,
    // and the run POSTED A REAL LOGIN ATTEMPT to iam.sensecoreapi.cn. The
    // plugin now rejects that shape outright; this asserts the redirect holds.
    check("the request reached the fake, not the platform", fake.log.iam > before,
      `iam calls ${before} -> ${fake.log.iam}`);
    check("the password arrived sealed and opened to the submitted value",
      fake.seen.password === "e2e-test-password", String(fake.seen.password));
    check("no bad-password refusal was produced", fake.log.badPassword === 0, String(fake.log.badPassword));
    check("a refresh token was obtained", res.body?.hasRefreshToken === true,
      JSON.stringify(res.body?.hasRefreshToken));
  }

  // === the panel reads real numbers out of a real response ===============
  {
    const res = await call("/api/dsh-connect-sensenova-token-plan/snapshot");
    check("the snapshot succeeds after signing in", res.body?.ok === true,
      JSON.stringify(res.body ?? {}).slice(0, 160));
    check("the pool came back with its name", res.body?.pools?.pools?.[0]?.name === "E2E 池",
      JSON.stringify(res.body?.pools?.pools?.[0]?.name));
    check("the 5h window is parsed", res.body?.pools?.pools?.[0]?.window5h?.used === 23456,
      String(res.body?.pools?.pools?.[0]?.window5h?.used));
    check("the 7d reset_at became a number", res.body?.pools?.pools?.[0]?.window7d?.resetAt === 1800600000,
      String(res.body?.pools?.pools?.[0]?.window7d?.resetAt));
    // The trend is a SUM over the series' points (42.5 + 51.25), not the first
    // point — asserting 42.5 here only ever passed because the run used to fail
    // before reaching this check and `undefined !== 42.5` was one of many
    // failures nobody read individually.
    check("the trend came back", res.body?.trend?.models?.[0]?.credits === 93.75,
      JSON.stringify(res.body?.trend?.models?.[0]?.credits));
    check("the token is reported as self-renewing", res.body?.auth?.configured === true);
    check("no wait is being served", res.body?.auth?.retryAfterMs === null, String(res.body?.auth?.retryAfterMs));
    // The console origin proves the whole run stayed on the stub.
    check("the panel is talking to the fake, not the platform",
      res.body?.consoleBase === `http://127.0.0.1:${FAKE_PORT}`, String(res.body?.consoleBase));
  }

  // === the vision step-two read side: catalog + visionModels in the
  // snapshot ==============================================================
  // The fake catalog carries one text-only, one vision-capable
  // (input_modalities ["text","image"]) and one image-output-only
  // (input ["text"], output ["image"]) model. The snapshot must list only
  // the vision-capable one — an output-only model is NOT a vision model, and
  // that distinction is what step two publishes to the settings row.
  // The e2e home has no SENSENOVA_API_KEY, so the catalog is unavailable
  // here (the model list degrades rather than fabricating): assert that
  // degraded shape holds AND that visionModels stays ABSENT (not an empty
  // list) when the key is missing — the panel must not claim "no vision
  // models" when it never asked the platform.
  {
    const res = await call("/api/dsh-connect-sensenova-token-plan/snapshot");
    check("without an API key the catalog is unavailable",
      res.body?.catalogAvailable === false, String(res.body?.catalogAvailable));
    check("no catalog means visionModels is absent, not an empty claim",
      res.body?.visionModels === undefined,
      JSON.stringify(res.body?.visionModels ?? null));
    check("a degraded catalog still reports no uncounted models",
      Array.isArray(res.body?.uncountedModels) && res.body?.uncountedModels.length === 0,
      JSON.stringify(res.body?.uncountedModels));
  }

  // === step three: a pasted key lights the catalog AND the provider =======
  // Everything above ran with no key, which is the degradation path. Now the
  // panel saves one through its own route, and the very next poll must fetch
  // the catalog with it, persist it, and register the provider — no restart,
  // no hand-written `llm-pi-ai` row.
  {
    const KEY = "sk-e2e-not-a-real-key";
    const before = fake.log.catalog;
    const saved = await call("/api/dsh-connect-sensenova-token-plan/api-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: KEY })
    });
    check("the key is accepted and reported as present",
      saved.body?.ok === true && saved.body?.hasApiKey === true,
      JSON.stringify(saved.body ?? {}).slice(0, 160));
    // The credentials service is what makes the key survive a restart; a run
    // that quietly fell back to process memory would pass `hasApiKey` and lose
    // the key on the next boot.
    check("the key landed in the credentials service, not process memory",
      saved.body?.keySource === "credentials", String(saved.body?.keySource));
    // The route answers with state, so the assertion is about the whole body:
    // a key echoed anywhere in a response is the failure this guards.
    check("no route echoes the key back", !saved.text.includes("sk-e2e"),
      saved.text.slice(0, 160));

    const res = await call("/api/dsh-connect-sensenova-token-plan/snapshot");
    check("the key reached the fake's model endpoint", fake.log.catalog > before,
      `catalog calls ${before} -> ${fake.log.catalog}`);
    check("the catalog is available once a key is saved",
      res.body?.catalogAvailable === true, String(res.body?.catalogAvailable));
    check("the catalog lists every model the key can call",
      JSON.stringify(res.body?.catalogModels) === JSON.stringify(["SenseNova-Lite", "SenseNova-Vision", "SenseNova-Draw"]),
      JSON.stringify(res.body?.catalogModels));
    // Only the input-modality model counts: the image-OUTPUT model must not
    // be published as one that can take a picture.
    check("the vision list is exactly the input-modality model",
      JSON.stringify((res.body?.visionModels ?? []).map((entry) => entry.id)) === JSON.stringify(["SenseNova-Vision"]),
      JSON.stringify(res.body?.visionModels));
    check("no key is echoed in the snapshot either", !res.text.includes("sk-e2e"));

    const llm = res.body?.llm ?? {};
    check("the panel reports the opt-in switch as on", llm.registerProvider === true, String(llm.registerProvider));
    check("the Host exposes an llm registration service", llm.llmAvailable === true,
      JSON.stringify(llm).slice(0, 200));
    check("the SenseNova provider is registered with the Host", llm.providerRegistered === true,
      JSON.stringify(llm).slice(0, 300));
    check("it registers under its own provider id", llm.providerId === "sensenova-token-plan", String(llm.providerId));
    check("the offered models come from the catalog, image-output excluded",
      llm.modelCount === 2 && llm.visionCount === 1 &&
        JSON.stringify(llm.models?.map((m) => m.id)) === JSON.stringify(["SenseNova-Lite", "SenseNova-Vision"]),
      `modelCount=${String(llm.modelCount)} visionCount=${String(llm.visionCount)} models=${JSON.stringify(llm.models)}`);

    // PITFALLS §23, end-to-end. This Host was launched with `--profile web`
    // (see startHost), so a real `profileContext` names it — and the states
    // that belong to a profile must land UNDER that name. No unit stub can
    // settle this: only a real Host says whether the optional service is truly
    // visible to a plugin that does NOT inject it.
    const perProfile = join(home, "state", "web", "dsh-connect-sensenova-token-plan");
    check("the catalog landed under this profile's directory",
      existsSync(join(perProfile, "catalog.json")), join(perProfile, "catalog.json"));
    check("nothing was written to the pre-§23 shared state directory",
      !existsSync(join(home, "state", "dsh-connect-sensenova-token-plan", "catalog.json")),
      join(home, "state", "dsh-connect-sensenova-token-plan", "catalog.json"));
  }

  // === the switch and curation routes, against the REAL llm service ========
  // Every route below is pure local — it reads and writes plugin state, it
  // never touches the network — so the fake platform needed no new endpoint for
  // them. They were the five of seven routes this suite never called: the
  // snapshot/account/api-key trio was all the run touched, and the switch
  // routes only ever ran against a hand-built fake llm in routes.test.mjs.
  // That leaves two properties only a real Host can settle, so they are the
  // point of this block:
  //   - the flip works through the REAL registration service (not an injected
  //     fake adapter): POSTing the switch off must actually withdraw the
  //     provider from the Host, and the curation must narrow the OFFER the
  //     Host really serves, read back out of a real HTTP response.
  //   - the trust fence is uniform. The routes' own comments promise that a
  //     foreign page cannot flip model routing Host-wide, but the fence had
  //     only been probed on snapshot and account. A valid session cookie plus
  //     a foreign Origin is the stronger form: the cookie alone must not be
  //     enough to get in.
  // State is restored as it goes, so the later checks still see a configured,
  // registered panel.
  {
    const NS = "/api/dsh-connect-sensenova-token-plan";

    // -- /provider: the switch is config-backed until the panel saves one --
    const prov = await call(`${NS}/provider`);
    check("the /provider route reports the config default with its source",
      prov.status === 200 && prov.body?.registerProvider === true && prov.body?.registerSource === "config",
      JSON.stringify(prov.body ?? {}).slice(0, 220));
    check("the provider is registered at that point", prov.body?.providerRegistered === true,
      String(prov.body?.providerRegistered));

    const junkProv = await post(`${NS}/provider`, { enabled: "yes" });
    check("a non-boolean switch is refused before anything is written",
      junkProv.status === 400 && junkProv.body?.ok === false,
      `${junkProv.status} ${JSON.stringify(junkProv.body ?? {}).slice(0, 120)}`);

    const off = await post(`${NS}/provider`, { enabled: false });
    check("flipping the switch off WITHDRAWS the provider from the real Host",
      off.status === 200 && off.body?.ok === true && off.body?.registerProvider === false &&
        off.body?.registerSource === "panel" && off.body?.providerRegistered === false,
      JSON.stringify(off.body ?? {}).slice(0, 260));
    check("a withdrawn provider is not reported as an error",
      off.body?.providerError === undefined, String(off.body?.providerError ?? null));

    const offGet = await call(`${NS}/provider`);
    check("the saved switch survives into the next request as the effective value",
      offGet.body?.registerProvider === false && offGet.body?.registerSource === "panel" &&
        offGet.body?.providerRegistered === false,
      JSON.stringify(offGet.body ?? {}).slice(0, 200));

    const backOn = await post(`${NS}/provider`, { enabled: true });
    check("the provider comes back on the request that carries the flip",
      backOn.body?.ok === true && backOn.body?.registerProvider === true && backOn.body?.providerRegistered === true,
      JSON.stringify(backOn.body ?? {}).slice(0, 260));

    // -- /models: the curation narrows what the Host really offers ---------
    const junkModels = await post(`${NS}/models`, { enabledModelIds: "SenseNova-Lite" });
    check("a non-array allow-list is refused rather than read as all models",
      junkModels.status === 400 && junkModels.body?.ok === false,
      `${junkModels.status} ${JSON.stringify(junkModels.body ?? {}).slice(0, 140)}`);

    const getModels = await call(`${NS}/models`, { method: "GET" });
    check("the curation route refuses a GET", getModels.status === 405, String(getModels.status));

    const narrowed = await post(`${NS}/models`, { enabledModelIds: ["SenseNova-Vision"] });
    check("the curation is saved and reported",
      narrowed.status === 200 && narrowed.body?.ok === true &&
        JSON.stringify(narrowed.body?.enabledModelIds) === JSON.stringify(["SenseNova-Vision"]) &&
        narrowed.body?.providerRegistered === true,
      JSON.stringify(narrowed.body ?? {}).slice(0, 260));

    const narrowedSnap = await call(`${NS}/snapshot`);
    check("the offer the Host serves is narrowed to the ticked model",
      narrowedSnap.body?.llm?.modelCount === 1 && narrowedSnap.body?.llm?.visionCount === 1,
      JSON.stringify({ m: narrowedSnap.body?.llm?.modelCount, v: narrowedSnap.body?.llm?.visionCount }));
    check("the roster itself is still complete while the offer is narrowed",
      narrowedSnap.body?.llm?.models?.length === 2, String(narrowedSnap.body?.llm?.models?.length));
    check("the snapshot reports the curation",
      JSON.stringify(narrowedSnap.body?.llm?.enabledModelIds) === JSON.stringify(["SenseNova-Vision"]),
      JSON.stringify(narrowedSnap.body?.llm?.enabledModelIds));

    const restored = await post(`${NS}/models`, { enabledModelIds: [] });
    const restoredSnap = await call(`${NS}/snapshot`);
    check("an empty allow-list restores the whole offer",
      restored.body?.ok === true &&
        restoredSnap.body?.llm?.modelCount === 2 && restoredSnap.body?.llm?.visionCount === 1,
      JSON.stringify({ saved: restored.body?.ok, m: restoredSnap.body?.llm?.modelCount, v: restoredSnap.body?.llm?.visionCount }));

    // -- /draw: the draw-tool switch, the third pure-local writer ----------
    const drawGet = await call(`${NS}/draw`);
    check("the /draw route reports the config default",
      drawGet.status === 200 && drawGet.body?.drawEnabled === false && drawGet.body?.drawSource === "config",
      JSON.stringify(drawGet.body ?? {}).slice(0, 200));

    const badModel = await post(`${NS}/draw`, { drawModelId: "   " });
    check("a blank draw model preference is refused",
      badModel.status === 400 && badModel.body?.ok === false, `${badModel.status}`);

    const withModel = await post(`${NS}/draw`, { drawModelId: "SenseNova-Draw" });
    check("a saved model preference wins over the config default",
      withModel.body?.ok === true && withModel.body?.drawModelId === "SenseNova-Draw" &&
        withModel.body?.drawModelSource === "panel",
      JSON.stringify(withModel.body ?? {}).slice(0, 220));

    const drawOn = await post(`${NS}/draw`, { enabled: true });
    check("the draw switch is saved as a panel value",
      drawOn.body?.ok === true && drawOn.body?.drawEnabled === true && drawOn.body?.drawSource === "panel",
      JSON.stringify(drawOn.body ?? {}).slice(0, 220));

    const forget = await post(`${NS}/draw`, { forget: true });
    check("a forget returns the SWITCH to the config default",
      forget.body?.ok === true && forget.body?.drawEnabled === false && forget.body?.drawSource === "config",
      JSON.stringify(forget.body ?? {}).slice(0, 260));
    check("a forget preserves the model preference (saveModel null is the reset)",
      forget.body?.drawModelId === "SenseNova-Draw" && forget.body?.drawModelSource === "panel",
      JSON.stringify({ m: forget.body?.drawModelId, s: forget.body?.drawModelSource }));

    // -- the fence, on the mutation paths ----------------------------------
    const evilProvider = await readJson(await fetch(`http://127.0.0.1:${PORT}${NS}/provider`, {
      method: "POST",
      headers: { cookie: session.cookie, origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    }));
    check("a foreign origin cannot flip the provider switch", evilProvider.status === 403, String(evilProvider.status));
    const stillOn = await call(`${NS}/provider`);
    check("the refused flip left the switch where the panel left it",
      stillOn.body?.registerProvider === true && stillOn.body?.providerRegistered === true,
      JSON.stringify(stillOn.body ?? {}).slice(0, 200));
    const evilModels = await readJson(await fetch(`http://127.0.0.1:${PORT}${NS}/models`, {
      method: "POST",
      headers: { cookie: session.cookie, origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ enabledModelIds: ["SenseNova-Lite"] })
    }));
    check("a foreign origin cannot choose the model offer", evilModels.status === 403, String(evilModels.status));
  }

  // === the second upstream: /raccoon answers through the real Host ========
  // The raccoon route is the one route this suite never called. With no
  // credential and the switch at its opt-in default OFF, `readRaccoonStatus`
  // takes none of the gateway reads (raccoon-status.ts: `loggedIn` false skips
  // the balance and catalogue fetches), so this GET is pure local state and
  // needs no fake gateway. What it still proves, and nothing else does:
  //   - the route is really registered with the Host (a wrong path or a
  //     duplicate would 404/401 here instead of answering);
  //   - the isolation invariant (AGENTS.md fact 3): reading the second
  //     upstream leaves the Token Plan registration exactly as it was;
  //   - the `?debug=1` scaffold rides only on the explicit opt-in.
  {
    const NS = "/api/dsh-connect-sensenova-token-plan";
    const before = await call(`${NS}/provider`);

    const raccoon = await call(`${NS}/raccoon`);
    check("the /raccoon route answers through the real webserver",
      raccoon.status === 200 && raccoon.body?.ok === true,
      `${raccoon.status} ${JSON.stringify(raccoon.body ?? {}).slice(0, 140)}`);
    check("the opt-in default is reported as off",
      raccoon.body?.enabled === false && raccoon.body?.switchSource === "off",
      JSON.stringify({ enabled: raccoon.body?.enabled, source: raccoon.body?.switchSource }));
    check("no credential is claimed",
      raccoon.body?.loggedIn === false && raccoon.body?.nickname === "",
      JSON.stringify({ loggedIn: raccoon.body?.loggedIn, nickname: raccoon.body?.nickname }));
    check("the second provider is not registered", raccoon.body?.providerRegistered === false,
      String(raccoon.body?.providerRegistered));
    check("the roster falls back without ever reading the gateway",
      raccoon.body?.modelsSource === "empty" && Array.isArray(raccoon.body?.models) &&
        raccoon.body.models.length > 0,
      JSON.stringify({ source: raccoon.body?.modelsSource, count: raccoon.body?.models?.length }));

    // The scaffold carries environment-derived values, so the ordinary poll
    // must not — only an explicit `?debug=1` may.
    const plain = JSON.stringify(raccoon.body ?? {});
    check("an ordinary poll carries no diagnostics scaffold",
      !plain.includes("hostProxyEnv") && !plain.includes("raccoonEnvShadow"), plain.slice(0, 140));
    const debug = await call(`${NS}/raccoon?debug=1`);
    check("an explicit ?debug=1 does carry the scaffold",
      Object.hasOwn(debug.body ?? {}, "hostProxyEnv") && typeof debug.body?.raccoonEnvShadow === "boolean",
      JSON.stringify({ hostProxyEnv: debug.body?.hostProxyEnv, shadow: debug.body?.raccoonEnvShadow }).slice(0, 140));

    const after = await call(`${NS}/provider`);
    check("reading the raccoon line left the SenseNova provider registered",
      before.body?.providerRegistered === true && after.body?.providerRegistered === true &&
        after.body?.registerProvider === true,
      JSON.stringify({ before: before.body?.providerRegistered, after: after.body?.providerRegistered }));

    const evil = await readJson(await fetch(`http://127.0.0.1:${PORT}${NS}/raccoon`, {
      headers: { cookie: session.cookie, origin: "https://evil.test" }
    }));
    check("a foreign origin is refused on the raccoon route", evil.status === 403, String(evil.status));
  }

  // === the throttle: a platform-stated window is honoured, then local =====
  // Every earlier sign-in succeeded, so no throttle is in force: this is the
  // run's first refusal and it must reach IAM. The fake answers the account
  // `e2e-throttle` with a real 429 envelope carrying `Retry-After: 120`.
  //
  // Two properties only a real Host settles, and both are the reason the
  // throttle exists (token-store/throttle.ts):
  //   - the platform's own window rides out as `retryAfterMs`, so the panel
  //     waits out a lockout instead of re-attempting into it;
  //   - a SECOND attempt inside that window is served by the LOCAL gate and
  //     never reaches the platform — the fake's IAM counter is the evidence,
  //     not the plugin's word. Re-probing is what turns a lockout permanent.
  //
  // The deliberate resubmit that closes the block is the ONE path that clears
  // a throttle, so the wrong-password block below starts clean again.
  {
    const NS = "/api/dsh-connect-sensenova-token-plan";
    const attempt = (body) => call(`${NS}/account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    const iamBefore = fake.log.iam;
    const first = await attempt({ username: "e2e-throttle", password: "x" });
    check("a rate-limited sign-in is classified as rate_limited",
      first.body?.code === "rate_limited", String(first.body?.code));
    check("the platform's own wait rides out as a countdown",
      first.body?.retryAfterMs === 120000,
      JSON.stringify({ retryAfterMs: first.body?.retryAfterMs }));
    check("the platform's own words reach the panel",
      typeof first.body?.detail === "string" && first.body.detail.includes("try again after 2 minutes"),
      String(first.body?.detail));
    check("the refusal reached the fake's IAM", fake.log.iam === iamBefore + 1,
      `iam calls ${iamBefore} -> ${fake.log.iam}`);

    // The console answers from the earlier successful polls are still inside
    // their 60s cache, and a cache hit never calls `getToken` — so the gate
    // under test would not fire at all. `forget: true` is the one path that
    // clears the console cache WITHOUT clearing the throttle: a deliberate
    // resubmit clears both, which would erase the very state being probed.
    const cleared = await attempt({ forget: true });
    check("forgetting the account clears the console cache, not the throttle",
      cleared.body?.ok === true, JSON.stringify(cleared.body ?? {}).slice(0, 140));

    // A cache miss now has to obtain a token, and the local gate refuses it
    // inside the window. The fake's IAM counter is the evidence that no
    // re-probe happened — the gate is what a poll loop hits, and re-probing
    // is what turns a transient lockout permanent.
    const polled = await call(`${NS}/snapshot`);
    check("the poll is refused by the LOCAL gate while the wait is in force",
      polled.body?.quotaError?.code === "auth_error", String(polled.body?.quotaError?.code));
    check("the poll reports the wait rather than a clean error",
      typeof polled.body?.auth?.retryAfterMs === "number" && polled.body.auth.retryAfterMs > 0,
      JSON.stringify({ retryAfterMs: polled.body?.auth?.retryAfterMs }));
    check("the poll never re-probed the platform", fake.log.iam === iamBefore + 1,
      `iam calls ${iamBefore + 1} -> ${fake.log.iam}`);

    const resubmit = await attempt({ username: "e2e-user", password: "e2e-test-password" });
    check("a deliberate resubmit clears the throttle and signs back in",
      resubmit.body?.ok === true, JSON.stringify(resubmit.body ?? {}).slice(0, 200));
    check("the resubmit reached IAM, so the throttle really was cleared",
      fake.log.iam > iamBefore + 1, `iam calls ${iamBefore + 1} -> ${fake.log.iam}`);
  }

  // === a wrong password is classified, and the panel explains itself =====
  {
    const res = await call("/api/dsh-connect-sensenova-token-plan/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "e2e-user", password: "wrong-one" })
    });
    check("a wrong password is reported as such", res.body?.code === "login_rejected", String(res.body?.code));
    check("the platform's own words reach the user",
      typeof res.body?.detail === "string" && res.body.detail.includes("invalid account or password"),
      String(res.body?.detail));
    check("a wrong password demands user action, not a countdown",
      res.body?.needsUserAction === true, String(res.body?.needsUserAction));
    check("a wrong password serves no wait", res.body?.retryAfterMs === null, String(res.body?.retryAfterMs));
  }
} catch (error) {
  check("the e2e run completed", false, String(error?.message ?? error));
  // The Host's own output is the only place a boot-time or request-time failure
  // shows up; without it a "fetch failed" says nothing about why.
  if (host !== null) {
    const tail = host.output().split("\n").slice(-12).join("\n");
    if (tail.trim() !== "") note(`dsh output:\n${tail}`);
  }
} finally {
  clearTimeout(watchdog);
  // Kill the Host tree AND close its pipes. `shell: true` spawns a shell
  // wrapper, so the handle we hold is the wrapper: `kill()` alone reaped only
  // that and left the real Host alive (a 342 MB orphan still holding its port
  // after a green run). killHostTree takes down the whole tree; destroying the
  // pipes is still needed because an open pipe on a child keeps this event loop
  // up, which is how a run printed all its results and then sat there for
  // minutes looking busy.
  if (host?.child !== undefined) {
    killHostTree(host.child);
    for (const stream of [host.child.stdout, host.child.stderr]) {
      try { stream?.destroy(); } catch { /* already gone */ }
    }
  }
  // Teardown gets a deadline too: a fake that will not close would otherwise
  // hang the run after every check had already passed.
  if (fake?.close !== undefined) {
    await withDeadline(Promise.resolve(fake.close()), 10_000, "closing the fake platform")
      .catch(() => { /* best effort: the results are already in hand */ });
  }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
else console.log(`\nall ${results.length} e2e checks passed`);

// Leave explicitly. The failure path used to `process.exit(1)` while the
// success path relied on the event loop draining — and it never did, because a
// spawned Host's pipes keep a handle open. A run that prints "all 24 checks
// passed" and then hangs reads exactly like a run that is still working, which
// is how six minutes disappeared. One turn for stdout to drain, then exit.
const exitCode = failed.length > 0 ? 1 : 0;
process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 100).unref();

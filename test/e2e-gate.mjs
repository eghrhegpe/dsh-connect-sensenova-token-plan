/**
 * Gate for the end-to-end run inside `npm test`.
 *
 * The e2e suite boots a REAL `dsh web` process, so it is slower than the offline
 * suites and needs the dsh CLI on PATH (or `DSH_CLI` pointing at it). That makes
 * it the one check that cannot be assumed to run everywhere — a clean CI box has
 * no dsh installed. But "sometimes can't run" must not mean "never runs": this
 * plugin's most dangerous historical bug (a nested `auth:` block silently
 * ignored, so the panel POSTED A REAL LOGIN to the platform) was caught ONLY by
 * e2e, and keeping e2e out of the default gate left that whole class unguarded
 * between manual runs.
 *
 * So the rule is: if the CLI AND a complete runtime tree are present, RUN the
 * e2e and propagate its exit code — a genuine failure fails the build. If
 * either is missing, print a loud SKIP and exit 0, because refusing to install
 * dsh is not a regression. The skip is surfaced through `env-skip.mjs`, which
 * also writes the `[skip]` line on stdout so `run-all.mjs` can list what this
 * run did NOT cover — a green summary that silently swallowed the boot would
 * be the exact §30 failure this runner exists to remove.
 *
 * TWO preconditions, and the second is the one worth arguing for. `cliPresent()`
 * alone used to be enough, until a machine showed up where the CLI was on PATH
 * but its install tree carried no `@deepseek-ai/dsh-base`: the gate then booted
 * the Host, watched 154 of its own plugins fail to import, and reported a
 * FAILED run whose cause had nothing to do with this plugin. `test/e2e.mjs`
 * already knows that shape (it prints "no CLI install tree to share" and boots
 * anyway), so this gate asks the SAME question with the SAME function rather
 * than inventing a second guess about what "complete" means — a divergent
 * criterion is how a pre-check starts disagreeing with the thing it guards.
 */
import { spawnSync } from "node:child_process";
import { cliRuntimeModules } from "./peer-roots.mjs";
import { envSkip } from "./env-skip.mjs";

const DSH = process.env.DSH_CLI ?? "dsh";
const NAME = "e2e-gate.mjs";

/** What the run loses when this gate does not complete. See env-skip.mjs. */
const COVERAGE = [
  "NOT verified in this run: the real Host boot — plugin loader, route",
  "registration, the same-origin trust fence, and the cordis.patch.yml hand-off.",
  "This is the ONLY check that sees them: every offline suite stubs the network,",
  "so the class of bug caught by e2e (a nested `auth:` block posting a REAL",
  "login to the platform) is unguarded until this suite runs.",
];

function cliPresent() {
  // Ask the CLI itself rather than trusting PATH bookkeeping; `--version` is the
  // cheapest thing that proves the shim resolves AND runs. shell:true mirrors how
  // e2e.mjs spawns it, so a Windows .cmd shim behaves the same here as there.
  const probe = spawnSync(DSH, ["--version"], { shell: true, encoding: "utf8", timeout: 30_000 });
  return !probe.error && probe.status === 0;
}

if (!cliPresent()) {
  envSkip(
    NAME,
    `the "${DSH}" CLI is not available on this machine`,
    [
      ...COVERAGE,
      "Install DSH or set DSH_CLI to exercise it (npm run test:e2e).",
    ]
  );
}

if (cliRuntimeModules() === undefined) {
  envSkip(
    NAME,
    `the "${DSH}" CLI is on PATH but its install tree has no complete @deepseek-ai runtime`,
    [
      ...COVERAGE,
      `Install the runtime the CLI boots from: npm install -g @deepseek-ai/dsh`,
      `(a CLI alone can start the Host but cannot resolve its own packages — see`,
      `cliRuntimeModules() in peer-roots.mjs, the same test e2e.mjs applies).`,
    ]
  );
}

const run = spawnSync(process.execPath, ["test/e2e.mjs"], { stdio: "inherit" });
process.exit(run.status === null ? 1 : run.status);

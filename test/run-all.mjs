/**
 * The gate runner — run the whole roster, then REPORT every verdict.
 *
 * ## Why this exists
 *
 * PITFALLS §30, root cause 2, verbatim:
 *
 *   > `set -e` + 19 个套件写在同一个 step：第 2 个套件一抛错，后面 17 个
 *   > （含 `build-gate`）一次都没跑过。于是「门禁红」看起来像某个用例失败，
 *   > 实际是门禁根本没在验证。
 *
 * Both entry points (`npm test` and the CI offline job) had that shape. The
 * postmortem's own closing rule applies:
 *
 *   > 门禁的依赖获取方式也是门禁的一部分 … 判据不是「CI 红没红」，而是
 *   > 「这个门禁在目标环境上有没有可能变绿」。
 *
 * A chain cannot answer that question: it stops at the first red, so the run
 * never learns whether the other 28 were green. On a machine without the Host
 * peer packages that is the DEFAULT experience — `store.test.mjs` is second in
 * the roster and peer-dependent, so `npm test` locally has always been a
 * one-suite verdict wearing a 29-suite costume.
 *
 * So: run everything, keep going, then summarise. The exit code is still
 * non-zero if anything failed — this changes what the gate REPORTS, not what
 * it GATES.
 *
 * ## Why it is also the per-domain escape hatch
 *
 * AGENTS.md tells contributors to verify per domain and never to run the full
 * `vitest`-style sweep twice in a row. That rule exists to protect the
 * machine, and it was written against a runner that had no addressing at all.
 * `--only` / `--skip` give the rule a first-class form:
 *
 *   node test/run-all.mjs --only=parsers     # one domain
 *   node test/run-all.mjs --only=raccoon    # everything with a prefix
 *   node test/run-all.mjs --skip=gate       # drop the slow build-shaped gates
 *   node test/run-all.mjs --list            # the roster, no execution
 *
 * ## What it does NOT do
 *
 * It does not soften a failure. A suite that fails here fails exactly as it
 * did in the chain, with the same exit code and the same output; the only
 * difference is that the other 28 also get to report. Suites that SKIP
 * themselves (missing typescript, missing tsdown, missing dsh CLI) still exit
 * 0 and still say so — this runner never converts a SKIP into a pass it
 * invented.
 *
 * @module test/run-all
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SUITES } from "./suites.mjs";
import { ARTIFACT_CONSUMERS, staleArtifactReason } from "./artifact-freshness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** Parse `--only=` / `--skip=` / `--list` out of argv. */
const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return null;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
};
const listOnly = argv.includes("--list");
const only = flag("only");
const skip = flag("skip");

/**
 * Select the roster for this run.
 *
 * `only` and `skip` are SUBSTRING matches, not globs or regexes: a contributor
 * typing `--only=raccoon` should get the four raccoon suites without knowing
 * whether one of them is spelled `raccoon-web`. An empty `--only=` or
 * `--skip=` is treated as "no filter" rather than "match nothing", so a stray
 * env expansion cannot silently produce an empty green run — that is precisely
 * the failure mode of the chain it replaces (a gate that verifies nothing
 * looks identical to a gate that passed).
 * @returns {typeof SUITES} the suites to run, in roster order.
 */
const selected = SUITES.filter((suite) => {
  if (only !== null && only !== "" && !suite.name.includes(only)) return false;
  if (skip !== null && skip !== "" && suite.name.includes(skip)) return false;
  return true;
});

if (listOnly) {
  for (const suite of selected) process.stdout.write(`${suite.name}\t${suite.note}\n`);
  process.exit(0);
}

if (selected.length === 0) {
  // Never exit 0 on an empty selection: "nothing ran" must not read as
  // "everything passed" (PITFALLS §30's own standard, applied to the runner
  // that exists to fix it).
  console.error(`no suite matched (only=${JSON.stringify(only)} skip=${JSON.stringify(skip)})`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The on-disk-artifact gate.
//
// Two suites here judge BUILT bytes rather than sources: `render-dom.test.mjs`
// `eval`s the root `client.js`, and `e2e-gate.mjs` boots a Host against a
// profile that links this package, so it exercises `lib/index.js`. Both are
// valuable precisely because they read the shipped bytes — but a selection that
// includes either and NOT `build-gate.mjs` can come back green about code that
// is no longer in the tree (PITFALLS §41: ten source mutations survived).
//
// `build-gate.mjs` is the authority on freshness — it rebuilds in place and
// compares byte-for-byte — so any selection containing it is already covered
// and this gate stays out of the way. Full `npm test` and CI never see it fire,
// which is what keeps a fresh checkout from skipping coverage it should run.
//
// When `build-gate` is absent this SKIPS rather than fails: "you did not
// rebuild" is a missing input, not a broken assertion. A selection that skips
// entirely still exits 1 through the all-skipped guard below, so a lone
// `--only=render-dom` on an unbuilt tree cannot read as a pass.
//
// The verdict itself lives in ./artifact-freshness.mjs — a judgement that only
// ever runs inside a spawn is a judgement nobody tests — so this file merely
// gathers the facts it decides on.
// ---------------------------------------------------------------------------
const buildGateSelected = selected.some((suite) => suite.name === "build-gate.mjs");

/** The newest mtime (ms) of any file under `dir`, recursively (0 if empty). */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(child));
    else if (entry.isFile()) newest = Math.max(newest, statSync(child).mtimeMs);
  }
  return newest;
}

/** Gather the ambient facts {@link staleArtifactReason} decides on. */
function probeArtifact(relPath) {
  const artifact = join(root, relPath);
  const exists = existsSync(artifact);
  const status = spawnSync("git", ["status", "--porcelain", "--", "src"], { cwd: root, encoding: "utf8" });
  // No usable git (a source tarball, a stripped PATH) is passed through as
  // `null` — "cannot tell" — rather than as a clean tree.
  const dirty = status.error || status.status !== 0 ? null : String(status.stdout ?? "").trim() !== "";
  return {
    name: relPath,
    exists,
    dirty,
    srcMtime: exists ? newestMtime(join(root, "src")) : 0,
    artifactMtime: exists ? statSync(artifact).mtimeMs : 0,
  };
}

const failures = [];
const skips = [];
let totalMs = 0;

console.log(`running ${selected.length} suite${selected.length === 1 ? "" : "s"} from test/suites.mjs`);
console.log(`(every suite reports; the exit code is the AND of all verdicts — PITFALLS §30 root cause 2)\n`);

for (const [index, suite] of selected.entries()) {
  const label = `${String(index + 1).padStart(2, " ")}/${selected.length} ${suite.name}`;
  process.stdout.write(`── ${label}\n`);

  // Refuse to grade a built artifact against sources it predates — see the
  // artifact gate above. Checked before the spawn so nothing runs at all.
  const artifactName = ARTIFACT_CONSUMERS.get(suite.name);
  if (artifactName !== undefined && !buildGateSelected) {
    const artifactReason = staleArtifactReason(probeArtifact(artifactName));
    if (artifactReason !== "") {
      skips.push({ suite: suite.name, reason: artifactReason });
      console.log(`   ⊘ ${suite.name} SKIPPED — ${artifactReason}\n`);
      continue;
    }
  }

  const startedAt = Date.now();
  // stdout is piped (not inherited) for exactly one reason: a suite that skips
  // itself announces `[skip] <name> — <reason>` there, and the summary below
  // has to be able to list what was NOT verified. `maxBuffer` is generous
  // because e2e can legitimately dump a whole Host's activation log.
  //
  // stderr stays inherited, so both skip explanations and per-check output keep
  // streaming in the interleaved order they were written.
  const result = spawnSync(process.execPath, [join(here, suite.name)], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - startedAt;
  totalMs += ms;
  const stdoutResult = typeof result.stdout === "string" ? result.stdout : "";
  if (stdoutResult !== "") process.stdout.write(stdoutResult);
  const skipLine = stdoutResult.split("\n").find((line) => line.startsWith("[skip] "));
  // The sentinel already carries the suite name (`[skip] store.test.mjs — …`);
  // repeating it in the summary would read as two different suites.
  const skipReason =
    skipLine === undefined
      ? ""
      : skipLine.slice("[skip] ".length).replace(new RegExp(`^${suite.name.replaceAll(".", "\\.")} — `), "");

  if (result.error) {
    // A spawn failure (ENOENT on node, a bad shebang) is a gate verdict, not
    // a crash of the runner: record it and keep going.
    failures.push({ suite: suite.name, code: `spawn error: ${result.error.message}` });
    console.log(`   ✗ ${suite.name} could not start (${result.error.message})\n`);
    continue;
  }
  const code = result.status;
  if (code === 0) {
    if (skipLine !== undefined) {
      skips.push({ suite: suite.name, reason: skipReason });
      console.log(`   ⊘ ${suite.name} SKIPPED — ${skipReason}\n`);
    } else {
      console.log(`   ✓ ${suite.name} (${(ms / 1000).toFixed(1)}s)\n`);
    }
    continue;
  }
  // A suite that self-declares a SKIP (missing typescript / tsdown / dsh CLI)
  // exits 0 and says so in its own output. This runner passes those through
  // untouched — it does NOT try to detect them: with `stdio: "inherit"` the
  // verdict is not in this process's hands, and guessing would recreate the
  // sin §30 describes (a run that LOOKS green because the runner, not the
  // suite, decided what counted).
  failures.push({ suite: suite.name, code });
  console.log(`   ✗ ${suite.name} exited ${code} (${(ms / 1000).toFixed(1)}s)\n`);
}

console.log("─".repeat(60));

// A run where EVERYTHING skipped must not read as green. Same rule as the empty
// selection check above, applied one layer later: "nothing ran" is only
// acceptable when it says so loudly, and never as a summary line nobody reads.
// In practice this fires on a checkout where no dependency is installed at all,
// which looks like success only if you believe the exit code instead of the list.
if (skips.length === selected.length) {
  console.error(
    `every selected suite SKIPPED (${skips.length}/${selected.length}) — this run verified nothing.\n` +
      `That is a broken environment, not a passing gate (PITFALLS §30: judge by whether\n` +
      `the gate CAN go green on its target environment, not by whether it is red).`
  );
  for (const skip of skips) console.error(`  ${skip.suite} — ${skip.reason}`);
  process.exit(1);
}

if (failures.length === 0) {
  console.log(`all ${selected.length} suite${selected.length === 1 ? "" : "s"} passed in ${(totalMs / 1000).toFixed(1)}s`);
  if (skips.length > 0) {
    // Skips are reported even on a green run, because otherwise "all passed"
    // would overstate what was verified — the failure mode this runner was
    // built to end was precisely a summary that lied about its own coverage.
    console.error(`\n${skips.length}/${selected.length} suite(s) SKIPPED for environment — NOT verified this run:`);
    for (const skip of skips) console.error(`  ${skip.suite} — ${skip.reason}`);
    console.error(`\n(local only: in CI these dependencies are installed by the job, so they do not\nskip — see test/env-skip.mjs. Reproduce that verdict: DSH_TEST_STRICT_SKIP=1 npm test)`);
  }
  process.exit(0);
}

console.error(`${failures.length}/${selected.length} suite(s) FAILED (${(totalMs / 1000).toFixed(1)}s total):`);
for (const failure of failures) console.error(`  ${failure.suite} — ${failure.code}`);
// The point of the exercise: the suites that DID run are named, so a red here
// reports what was verified instead of stopping at the first red.
console.error(
  `\n(${selected.length - failures.length - skips.length} suite(s) did run and passed` +
    (skips.length > 0 ? `, ${skips.length} skipped for environment` : "") +
    `)`
);
for (const skip of skips) console.error(`  ⊘ ${skip.suite} — ${skip.reason}`);
process.exit(1);

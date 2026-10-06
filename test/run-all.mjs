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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SUITES } from "./suites.mjs";

const here = dirname(fileURLToPath(import.meta.url));

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

const failures = [];
let totalMs = 0;

console.log(`running ${selected.length} suite${selected.length === 1 ? "" : "s"} from test/suites.mjs`);
console.log(`(every suite reports; the exit code is the AND of all verdicts — PITFALLS §30 root cause 2)\n`);

for (const [index, suite] of selected.entries()) {
  const label = `${String(index + 1).padStart(2, " ")}/${selected.length} ${suite.name}`;
  process.stdout.write(`── ${label}\n`);
  const startedAt = Date.now();
  // stdio: inherit — the suites print their own per-check output, and a
  // captured buffer would hide which of 29 suites said what until the end.
  const result = spawnSync(process.execPath, [join(here, suite.name)], { stdio: "inherit" });
  const ms = Date.now() - startedAt;
  totalMs += ms;

  if (result.error) {
    // A spawn failure (ENOENT on node, a bad shebang) is a gate verdict, not
    // a crash of the runner: record it and keep going.
    failures.push({ suite: suite.name, code: `spawn error: ${result.error.message}` });
    console.log(`   ✗ ${suite.name} could not start (${result.error.message})\n`);
    continue;
  }
  const code = result.status;
  if (code === 0) {
    console.log(`   ✓ ${suite.name} (${(ms / 1000).toFixed(1)}s)\n`);
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
if (failures.length === 0) {
  console.log(`all ${selected.length} suite${selected.length === 1 ? "" : "s"} passed in ${(totalMs / 1000).toFixed(1)}s`);
  process.exit(0);
}

console.error(`${failures.length}/${selected.length} suite(s) FAILED (${(totalMs / 1000).toFixed(1)}s total):`);
for (const failure of failures) console.error(`  ${failure.suite} — ${failure.code}`);
// The point of the exercise: the suites that DID run are named, so a red here
// reports what was verified instead of stopping at the first red.
console.error(`\n(${selected.length - failures.length} suite(s) did run and passed)`);
process.exit(1);

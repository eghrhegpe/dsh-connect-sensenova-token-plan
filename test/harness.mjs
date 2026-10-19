/**
 * The ceremony every offline suite used to copy verbatim.
 *
 * `results` + `check` + `fail` + the JSON/tail/exit block were byte-level
 * copies across the suites — the same lines, in some cases with the local
 * variable renamed — which made a change to the tail convention a many-file
 * edit and hid the fact that the copies carried no per-suite behaviour at all.
 *
 * Module-level state is safe here BECAUSE the runner spawns one process per
 * suite (`test/run-all.mjs`): no two suites ever share this module instance,
 * so there is no cross-suite ledger to collide with. Suites that are also
 * `import`ed by another process (none today) would have to use a factory.
 *
 * A suite whose tail is genuinely its own — a custom noun, a JSON summary
 * object, an exit that propagates a child's status — keeps formatting it
 * itself. `check`/`fail`/`results` still come from here, and {@link finish} is
 * opt-in, so migrating is never all-or-nothing.
 */

/**
 * The assertion ledger, in declaration order. The runner reads the suite's
 * EXIT CODE, not this array; it exists so a failure names itself and so the
 * full ledger can be dumped as JSON.
 * @type {Array<{name: string, pass: boolean, detail: unknown}>}
 */
export const results = [];

/**
 * Record one assertion.
 *
 * `name` is a contract, not a label: it is what a red run prints, what a
 * reviewer greps for, and — per docs/TESTING.md — what the suite promises.
 * Keep it descriptive enough to diagnose without reading the body.
 * @param {string} name - what was asserted.
 * @param {unknown} condition - truthy = pass.
 * @param {unknown} [detail] - evidence shown when the check is inspected.
 */
export function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

/**
 * Record a thrown error as a failed assertion, so a suite that throws inside a
 * block reports WHICH block threw instead of dying silently.
 * @param {string} name - the assertion group that threw.
 * @param {unknown} error - the caught value.
 */
export function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

/**
 * {@link fail}'s sibling for suites that fold the error's class into the name
 * (`"<group>: threw TypeError"`). Kept separate rather than folded into `fail`
 * with a flag: the recorded NAME differs, and a name is a contract — a silent
 * change from `"x: threw TypeError"` to `"x"` would alter what the ledger says
 * while the suite stayed green.
 * @param {string} group - the assertion group that threw.
 * @param {unknown} error - the caught value.
 */
export function failGroup(group, error) {
  results.push({
    name: `${group}: threw ${error?.name ?? "Error"}`,
    pass: false,
    detail: String(error?.message ?? error)
  });
}

/**
 * Print a section heading. Pure readability: the runner ignores stdout beyond
 * the skip sentinel, so this is free to be prose.
 * @param {string} title - the section name.
 */
export function section(title) {
  console.log(`\n— ${title}`);
}

/**
 * The second tail convention: name every failure on stderr, then print the
 * suite's own pass ratio, then fail SOFT (`exitCode`, so any already-scheduled
 * cleanup still runs).
 *
 * Kept as its own function rather than a flag on {@link finish} because the two
 * differ in three independent ways at once — the failure detail is printed per
 * row, the pass line names the suite instead of counting categories, and the
 * exit is soft — and a single function with three switches would be harder to
 * read than the two call sites it replaces.
 * @param {{suite: string}} options - `suite` is the file name printed in the
 *   pass line, so the output still says who is reporting.
 */
export function finishVerbose({ suite }) {
  const passed = results.filter((r) => r.pass).length;
  const bad = failed();
  for (const row of bad) {
    console.error(`  FAIL  ${row.name}${row.detail ? ` — ${row.detail}` : ""}`);
  }
  console.log(`\n${suite}: ${passed}/${results.length} passed`);
  if (bad.length > 0) process.exitCode = 1;
}

/** The failed subset of {@link results}. */
export function failed() {
  return results.filter((r) => !r.pass);
}

/**
 * The canonical suite tail: the whole ledger as JSON, then either the failure
 * count on stderr plus `exit(1)`, or the pass line.
 *
 * Byte-identical to the copies it replaces, deliberately: nothing parses a
 * suite's stdout today (the runner uses the exit code), but "nothing parses
 * it" is a fact that can change without this file noticing, and a tail that
 * quietly reformatted would be a silent contract change.
 *
 * `process.exit(1)` rather than `process.exitCode = 1` — the hard exit is what
 * the copies used, and it keeps a suite from hanging on a stray open handle
 * after it has already decided it failed.
 * @param {{noun?: string}} [options] - `noun` replaces "checks" in the pass
 *   line for suites whose ledger is a different category (`contract checks`,
 *   `live checks`).
 */
export function finish({ noun = "checks" } = {}) {
  console.log(JSON.stringify(results, null, 2));
  const bad = failed();
  if (bad.length > 0) {
    console.error(`\n${bad.length}/${results.length} check(s) FAILED`);
    process.exit(1);
  }
  console.log(`\nall ${results.length} ${noun} passed`);
}

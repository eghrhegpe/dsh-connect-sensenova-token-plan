/**
 * The loud-skip protocol for suites whose dependencies are NOT in this repo.
 *
 * ## Why this file exists
 *
 * Half the roster depends on things npm cannot install here: `@deepseek-ai/*`
 * peers ship inside the DSH Host runtime, and `dsh` itself is a CLI that may
 * not be on PATH. Those suites used to `throw` when their dependency was
 * missing, which means they FAILED. On a developer machine that verdict is a
 * lie — the code is fine, the machine is not — but the failure is indistinguishable
 * from a regression, so `npm test` locally settled into a permanent 4/32 red
 * that AGENTS.md told its readers to subtract by hand.
 *
 * A permanent red is not a stricter gate, it is a noisier one: once four reds
 * are normal, the fifth has to be argued for. That is PITFALLS §30's shape
 * again — the postmortem was written about a chain that hid results, and this
 * is the mirror image, a run whose top line is unreadable without a manual
 * correction. So missing-environment becomes a SKIP, and the summary says so.
 *
 * ## The non-negotiable half: CI never skips
 *
 * The whole reason skipping is safe is §30's closing rule:
 *
 *   > 判据不是「CI 红没红」，而是「这个门禁在目标环境上有没有可能变绿」。
 *
 * On a CI runner the peers ARE obtainable (the offline job installs the CLI to
 * supply the runtime), so a missing peer there is the real thing — AGENTS.md
 * already says so: "CI 不适用这条 … 那里报同一句 = 真回归". A skip that also
 * fires in CI would convert §30's hard-won regression signal back into a green
 * nobody reads. So: `CI` (or `DSH_TEST_STRICT_SKIP=1`) makes every
 * would-be skip a FAILURE with the same message. Set the latter to reproduce
 * CI's judgement locally.
 *
 * ## The contract
 *
 *   - stdout gets exactly one `[skip] <name> — <reason>` line: machine-readable,
 *     so `test/run-all.mjs` can list what was NOT verified instead of counting
 *     it as a pass.
 *   - stderr gets the human explanation, including what the run therefore did
 *     not cover — a skip that hides its own coverage hole is the sin this file
 *     exists to remove.
 *   - exit 0 when skipping, exit 1 in strict mode. Nothing else.
 *
 * @module test/env-skip
 */

import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when a missing dependency must be reported as a FAILURE, not a skip.
 *
 * `CI` is set by every major runner (GitHub Actions sets it to `"true"`).
 * `DSH_TEST_STRICT_SKIP` exists so the strict verdict can be reproduced on a
 * laptop: `DSH_TEST_STRICT_SKIP=1 npm test` is the local answer to
 * "would this have been red on CI?", which is the question a contributor is
 * actually asking when they see four skips.
 */
export const STRICT =
  (process.env.CI !== undefined && process.env.CI !== "" && process.env.CI !== "0") ||
  process.env.DSH_TEST_STRICT_SKIP === "1";

/**
 * The roster-facing name of the calling suite, derived rather than retyped.
 *
 * A suite that hand-writes `"store.test.mjs"` in its skip message drifts the
 * day it is renamed, and the drift lands in exactly the line a reader uses to
 * work out which suite did not run.
 *
 * @param {string} url `import.meta.url` of the suite.
 * @returns {string} its file name.
 */
export const suiteName = (url) => basename(fileURLToPath(url));

/**
 * Exit 0 with a loud explanation, or fail, depending on {@link STRICT}.
 *
 * @param {string} name suite/gate name, as the roster spells it.
 * @param {string} missing one line naming what is unavailable.
 * @param {string[]} coverage what this run therefore did NOT verify.
 * @returns {never} never returns; always exits the process.
 */
export function envSkip(name, missing, coverage = []) {
  const headline = `[skip] ${name} — ${missing}`;
  if (STRICT) {
    process.stderr.write(
      `\n${headline.replace("[skip]", "[skip refused]")}\n` +
        `[skip refused]   STRICT mode (${
          process.env.DSH_TEST_STRICT_SKIP === "1" ? "DSH_TEST_STRICT_SKIP=1" : "CI"
        }): on CI these dependencies are installed by the job, so a miss here is\n` +
        `[skip refused]   a REGRESSION, not an environment gap (AGENTS.md: "那里报同一句 = 真回归").\n` +
        (coverage.length > 0 ? coverage.map((line) => `[skip refused]   ${line}`).join("\n") + "\n" : "") +
        `\n`
    );
    process.exit(1);
  }

  process.stdout.write(`${headline}\n`);
  process.stderr.write(
    `\n${headline}\n` +
      coverage.map((line) => `[skip]   ${line}`).join("\n") +
      (coverage.length > 0 ? "\n" : "") +
      `[skip]   This is an environment gap, NOT a regression. Reproduce CI's stricter\n` +
      `[skip]   verdict with: DSH_TEST_STRICT_SKIP=1 npm test\n\n`
  );
  process.exit(0);
}

/**
 * Turn a failed peer resolution into a skip, leaving every other error fatal.
 *
 * Only {@link isPeerMissing} errors are absorbed: swallowing a genuine throw
 * from inside the peer module would turn a real breakage into a silence, which
 * is exactly the class of bug §30 is about.
 *
 * @param {string} name suite name for the message.
 * @param {string[]} coverage what this run therefore did NOT verify.
 * @returns {(error: unknown) => never}
 */
export function skipOnMissingPeer(name, coverage = []) {
  return (error) => {
    if (!isPeerMissing(error)) throw error;
    envSkip(name, String(error?.message ?? error).split("\n")[0], coverage);
  };
}

/**
 * True when {@link module:test/peer-roots.loadPeer} failed to find a peer.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isPeerMissing(error) {
  return Boolean(error) && (/** @type {{peerMissing?: boolean}} */ (error).peerMissing === true);
}

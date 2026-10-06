/**
 * Commit message floor (zero dependencies, git only).
 *
 * The repo's CONTRIBUTING.md §1 asks for a Chinese `type:` prefix and a body
 * that explains the *why*. This is the bottom line: it only enforces what a
 * machine can, and it is deliberately narrow so it never becomes the thing a
 * contributor argues with:
 *
 *   1. a conventional `type:` (or `type(scope):`) prefix from a fixed set;
 *   2. the subject is not a bare filename / path (the `test\raccoon.test.mjs`
 *      accident);
 *   3. no backslash in the message (Windows path separators creep in here);
 *   4. a subject length with at least a few real characters.
 *
 * Git-generated subjects (`Merge …`, `Revert …`) are exempt — they are not
 * authored by humans and would only add noise.
 *
 * Defaults to checking the working tree's HEAD; pass `--range SPEC` (e.g.
 * `origin/main..HEAD`) to check a span. If the range cannot be resolved, the
 * script falls back to HEAD and notes it, so a CI call like
 *   node test/commit-lint.mjs --range origin/main..HEAD
 * never hard-fails on a ref the runner could not fetch.
 *
 * Exit codes: 0 clean, 1 violation. An unresolvable range is NOT a distinct
 * exit code — it falls back to HEAD (noted on stdout) and the exit code
 * reflects the HEAD lint result, by design: a fetch quirk must never mask a
 * real violation, nor fake a clean one.
 */
import { spawnSync } from "node:child_process";

const TYPES = new Set([
  "feat", "fix", "docs", "test", "chore", "style", "refactor", "perf", "build", "ci",
]);
const PREFIX_RE = /^(feat|fix|docs|test|chore|style|refactor|perf|build|ci)(\([a-z0-9][a-z0-9._-]*\))?:\s+\S/;
const BARE_PATH_RE = /^[A-Za-z0-9_@./\\-]+\.(mjs|cjs|js|ts|tsx|jsx|json|yml|yaml|md|toml|png|svg|lock)$/i;
const MIN_SUBJECT = 4; // characters after the prefix

const args = process.argv.slice(2);
let range = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--range") range = args[++i];
  else if (args[i]?.startsWith("--range=")) range = args[i].slice("--range=".length);
}

function git(args) {
  return spawnSync("git", args, { encoding: "utf8", timeout: 30_000 });
}

function listCommits(spec) {
  // spec === null → just HEAD; otherwise `git rev-list <spec>`.
  const argv = spec === null ? ["rev-list", "-1", "HEAD"] : ["rev-list", spec];
  const res = git(argv);
  if (res.status !== 0) return { shas: null, error: res.stderr.trim() || res.stdout.trim() };
  const shas = res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  return { shas, error: null };
}

function subjectOf(sha) {
  const res = git(["log", "-1", "--format=%s", sha]);
  return res.status === 0 ? res.stdout.trim() : "";
}

function lintSubject(subject) {
  if (/^(Merge|Revert)\b/.test(subject)) return null; // git-generated
  if (subject.length === 0) return "empty subject";
  if (subject.includes("\\")) return "subject contains a backslash (Windows path?)";
  if (BARE_PATH_RE.test(subject)) return "subject is a bare filename — say what changed and why";
  if (!PREFIX_RE.test(subject)) {
    return "subject needs a `type:` prefix (feat/fix/docs/test/chore/style/refactor/perf/build/ci), optional `type(scope):`)";
  }
  const after = subject.replace(/^(feat|fix|docs|test|chore|style|refactor|perf|build|ci)(\([a-z0-9][a-z0-9._-]*\))?:/, "").trim();
  if (after.length < MIN_SUBJECT) return `subject too thin after the prefix (>= ${MIN_SUBJECT} chars)`;
  return null;
}

function run(shas, fallbackNote) {
  let violations = 0;
  for (const sha of shas) {
    const subject = subjectOf(sha);
    const reason = lintSubject(subject);
    if (reason) {
      violations += 1;
      console.log(`[commit-lint] ${sha.slice(0, 7)} ${reason}: ${subject}`);
    }
  }
  const note = fallbackNote ? ` (${fallbackNote})` : "";
  console.log(`[commit-lint] ${shas.length} commit(s) checked${note}, ${violations} violation(s)`);
  if (violations > 0) {
    console.log(JSON.stringify({ name: "commit-lint", pass: false, violations }));
    process.exit(1);
  }
  console.log(JSON.stringify({ name: "commit-lint", pass: true, checked: shas.length }));
}

if (range === null) {
  const { shas } = listCommits(null);
  run(shas ?? []);
} else {
  const { shas, error } = listCommits(range);
  if (shas === null) {
    // Range unresolvable (e.g. base ref not on the runner) — fall back to HEAD
    // rather than hard-failing CI on a ref-fetch problem.
    console.log(`[commit-lint] range "${range}" not resolvable: ${error}`);
    const { shas: head } = listCommits(null);
    run(head ?? [], `range ${range} unresolvable; linted HEAD`);
  } else if (shas.length === 0) {
    // Push to main / no new commits in the span — nothing to lint.
    console.log(`[commit-lint] 0 commits in range ${range} — nothing to lint`);
    console.log(JSON.stringify({ name: "commit-lint", pass: true, checked: 0 }));
  } else {
    run(shas);
  }
}

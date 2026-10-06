#!/usr/bin/env node
/**
 * Duplication gate — the mechanical half of the "two upstreams stay isolated"
 * invariant (docs/ARCHITECTURE.md §5.5).
 *
 * PITFALLS.md §343 recorded the failure mode this gate prevents: raccoon's
 * publish/adapter were once verbatim copies of the Token Plan side (47%/63%
 * duplication), and the only thing holding the copies apart afterwards was two
 * comments pointing at each other saying "keep in sync". Comments do not fail
 * CI; this does.
 *
 * How it works: jscpd (a devDependency, same detector `npm run duplicate-check`
 * uses interactively) scans `src/` at the 70-token threshold, and every clone
 * found must match a `WHITELIST` entry — an explicit, line-capped admission.
 *
 * The rules, in the spirit of the repo's closed-set gates:
 *
 *   1. Any clone NOT in the whitelist fails. The fix is to either remove the
 *      duplication or, when it is genuinely irreducible glue, register it here
 *      with a comment saying why — a new entry is a decision, not an accident.
 *   2. A whitelisted pair that grows past its line cap fails. Clones tend to
 *      accrete; the cap forces the accretion to show up as a red gate instead
 *      of silently re-creating the pre-§343 state.
 *   3. Raccoon-vs-Token-Plan cross-boundary clones are called out in the
 *      failure message even when whitelisted, so the reviewer sees the
 *      invariant that is being spent.
 *
 * Not a `*.test.mjs`: like typecheck-gate/build-gate/e2e-gate it is a gate
 * script in `test/suites.mjs`'s roster, so `npm test` (the run-all runner)
 * and ci.yml's offline job (which installs devDependencies, so jscpd is
 * present there) run it; without jscpd it SKIPs loudly like its siblings.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Same skip-rule as typecheck-gate/build-gate/e2e-gate: jscpd is a devDependency,
// so a machine without dev deps SKIPs loudly instead of crashing on the
// readFileSync below (an uncaught ENOENT is a red gate that says nothing about
// the code — the §30 failure shape). CI installs dev deps, so it still runs.
if (!existsSync(join(root, "node_modules", "jscpd", "package.json"))) {
  process.stderr.write(
    `\n[duplication-gate] SKIPPED — jscpd is not installed in this project's node_modules.\n` +
    `[duplication-gate]   Bootstrap dev deps with: npm install --legacy-peer-deps\n\n`
  );
  process.exit(0);
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail: detail || "" });
  if (!pass) console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// The admitted clones. Lines are the larger of the two halves' extents; they
// will drift a little with edits — the cap is a ceiling with headroom, not a
// byte-freeze. Registering a NEW entry requires a reason in the comment.
const WHITELIST = [
  {
    // The thin post-core-extraction shells: publish-core.ts took the shared
    // body, these ~19 lines are the per-upstream glue around it (see
    // PITFALLS.md §343). Cross-boundary (Token Plan ↔ raccoon) — capped.
    files: ["provider-publish.ts", "raccoon-publish.ts"],
    maxLines: 24
  },
  {
    // Inside routes/raccoon.ts itself: the two raccoon credential sources
    // (store grant vs env) share a response-shaping tail. Same-file clone,
    // outside the isolation boundary.
    files: ["routes/raccoon.ts", "routes/raccoon.ts"],
    maxLines: 20
  },
  {
    // token-store.ts's legacy facade vs token-store/state.ts — the facade
    // re-exports the split module's context builder; scheduled to shrink as
    // the TOKEN-STORE-SPLIT migration completes.
    files: ["token-store.ts", "token-store/state.ts"],
    maxLines: 14
  }
];

const MIN_TOKENS = 70; // keep in lockstep with the `duplicate-check` npm script

const require = createRequire(import.meta.url);
const jscpdPkg = JSON.parse(readFileSync(join(root, "node_modules", "jscpd", "package.json"), "utf8"));
const jscpdBin = join(root, "node_modules", "jscpd", jscpdPkg.bin.jscpd.replace(/^\.\//, ""));

const outDir = mkdtempSync(join(tmpdir(), "jscpd-gate-"));
try {
  execFileSync(process.execPath, [jscpdBin, "src", "--min-tokens", String(MIN_TOKENS), "--reporters", "json", "--output", outDir, "--silent"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"]
  });
  const report = JSON.parse(readFileSync(join(outDir, "jscpd-report.json"), "utf8"));
  const clones = (report.duplicates ?? []).map((clone) => {
    // Count the larger half's span: the clone's real size in source lines.
    const first = clone.firstFile.end - clone.firstFile.start + 1;
    const second = clone.secondFile.end - clone.secondFile.start + 1;
    const rel = (name) => name.split(/[\\/]src[\\/]/).pop().replace(/\\/g, "/").replace(/^host\//, "");
    return {
      a: rel(clone.firstFile.name),
      b: rel(clone.secondFile.name),
      lines: Math.max(first, second)
    };
  });

  check(`jscpd scanned the tree (report format intact)`, Array.isArray(report.duplicates), "jscpd-report.json missing or malformed");

  const remaining = [...clones];
  for (const entry of WHITELIST) {
    const pairKey = (clone) => {
      const pair = [clone.a, clone.b].sort().join(" <-> ");
      return pair === [...entry.files].sort().join(" <-> ");
    };
    const matched = remaining.filter(pairKey);
    for (const clone of matched) remaining.splice(remaining.indexOf(clone), 1);
    const worst = matched.reduce((max, clone) => Math.max(max, clone.lines), 0);
    const crossBoundary = entry.files.some((f) => f.startsWith("raccoon")) && entry.files.some((f) => !f.startsWith("raccoon"));
    check(
      `whitelisted clone ${entry.files.join(" <-> ")} stays under its ${entry.maxLines}-line cap`,
      matched.length === 0 || worst <= entry.maxLines,
      crossBoundary
        ? `now ${worst} lines (cap ${entry.maxLines}) — the Token Plan ↔ raccoon isolation is being re-spent; extract instead of copying`
        : `now ${worst} lines (cap ${entry.maxLines})`
    );
  }

  for (const clone of remaining) {
    const crossBoundary = (clone.a.startsWith("raccoon") || clone.b.startsWith("raccoon")) && clone.a.split("/")[0] !== clone.b.split("/")[0];
    check(
      `unregistered clone ${clone.a} <-> ${clone.b} (${clone.lines} lines) is removed or whitelisted`,
      false,
      crossBoundary
        ? "crosses the Token Plan ↔ raccoon boundary — this is exactly the §343 regression; extract shared code or register an explicit cap in WHITELIST"
        : "add to WHITELIST with a reason comment, or extract the shared code"
    );
  }
  // And the aggregate must not silently grow within whitelisted pairs either.
  check(`total clone count stays within the whitelist (${WHITELIST.length})`, clones.length <= WHITELIST.length, `found ${clones.length}`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify(results, null, 2));
if (failed.length > 0) {
  console.error(`\nduplication gate: ${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`\nduplication gate: all ${results.length} checks passed`);

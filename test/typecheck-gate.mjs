// @ts-check
/**
 * Gate for the TypeScript checker (the tsconfig's 8 strict flags are only
 * worth having while something RUNS them on every push).
 *
 * Same skip-rule as build-gate/e2e-gate: if `typescript` is not installed in
 * THIS project's node_modules, print a loud SKIP and exit 0 — a machine
 * without dev deps is not a regression. The local pin is what makes the gate
 * real: before typescript entered devDependencies, `npm run typecheck` here
 * resolved a GLOBAL tsc (an uncontrolled version), and CI — which installs
 * nothing beyond devDeps — had no tsc to find at all. A gate that always
 * skips is a gate that tests nothing (the §30 lesson, ci.yml header).
 *
 * Invoked as `node <path>/bin/tsc` (not the .cmd shim, not npx, not PATH):
 * the exact local compiler runs on every platform with no global leakage.
 *
 * Not a *.test.mjs, so it lives OUTSIDE test/package.test.mjs's three-way
 * roster pin — it is listed explicitly in package.json's `test` chain and in
 * ci.yml's offline job, exactly like build-gate.mjs.
 *
 * TWO configs run: tsconfig.json (everything, strict flags at project level)
 * and tsconfig.strict-null.json (the per-file strictNullChecks allowlist from
 * docs/IMPROVEMENTS.md §8 — a file graduates by moving from the main config's
 * exclude to an include line here). A green gate means BOTH are clean.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TS_PKG = join(root, "node_modules", "typescript", "package.json");

if (!existsSync(TS_PKG)) {
  process.stderr.write(
    `\n[typecheck-gate] SKIPPED — typescript is not installed in this project's node_modules.\n` +
    `[typecheck-gate]   Bootstrap dev deps with: npm install --legacy-peer-deps\n` +
    `[typecheck-gate]   (a GLOBAL tsc is deliberately NOT a fallback: the gate must run the\n` +
    `[typecheck-gate]    version pinned in devDependencies, or its verdict is not reproducible).\n\n`
  );
  process.exit(0);
}

const pinned = JSON.parse(readFileSync(TS_PKG, "utf8")).version;
const TSC = join(root, "node_modules", "typescript", "bin", "tsc");

// Two configs: the project-wide check, then the per-file strictNullChecks
// allowlist. Both must be clean for the gate to pass. A missing allowlist
// config is a hard failure — the gate would otherwise green-light a silent
// removal of the §8 graduation track.
const CONFIGS = ["tsconfig.json", "tsconfig.strict-null.json"];

let failed = false;
for (const config of CONFIGS) {
  if (!existsSync(join(root, config))) {
    console.error(`FAIL typecheck — ${config} is listed by the gate but absent on disk`);
    failed = true;
    continue;
  }
  process.stdout.write(`[typecheck-gate] typescript ${pinned} (local) — tsc -p ${config}\n`);
  const tsc = spawnSync(process.execPath, [TSC, "-p", config], {
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
  });
  const out = `${tsc.stdout ?? ""}${tsc.stderr ?? ""}`;
  if (out.trim() !== "") process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  if (tsc.error) {
    console.error(`FAIL typecheck (${config}) could not run — ${String(tsc.error)}`);
    failed = true;
  } else if (tsc.status !== 0) {
    console.error(`FAIL typecheck (${config}) — tsc exited ${tsc.status} (see the errors above)`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`\nall typecheck checks passed (typescript ${pinned}, ${CONFIGS.length} config(s), 0 errors)`);

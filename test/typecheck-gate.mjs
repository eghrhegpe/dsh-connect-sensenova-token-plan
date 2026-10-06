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
 * Not a `*.test.mjs` — so the disk-vs-roster half of test/package.test.mjs's
 * pin exempts it by name — but it IS a roster member: since the runner
 * replaced the `npm test` chain (2026-10-05) it sits in `test/suites.mjs`,
 * runs in `npm test` / CI offline, and package.test checks it EXISTS per the
 * roster (the roster⊆disk direction, which first saw the gate files in 2026).
 * The pre-runner world it was written for — "explicitly listed in package.json's
 * `test` chain and ci.yml" — is gone: both entry points now invoke the runner.
 *
 * TWO configs run: tsconfig.json (everything, strict flags at project level)
 * and tsconfig.strict-null.json (the per-file strictNullChecks allowlist from
 * docs/IMPROVEMENTS.md §8 — a file graduates by moving from the main config's
 * exclude to an include line here). A green gate means BOTH are clean.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL: the taxonomy's headline promise is that a MISSPELLED code
// is a compile error, not a silent string. `CodeValue` used to be redeclared as
// `string` in types.ts and `pluginError` took `string`, so the union existed
// but nothing consumed it and `pluginError("not_a_code", …)` compiled clean —
// the exact silent failure `codes.ts` says it exists to prevent. A green tsc
// over src/ cannot prove a NEGATIVE, so prove it here: compile a scratch file
// that misspells a code and require tsc to REJECT it. If someone loosens the
// type back to `string`, this goes red.
//
// Deliberately runs even when a config above already failed: it reports its own
// verdict independently, so one run tells you whether the type AND the gate are
// both still doing their jobs.
{
  const probe = join(root, "src", "host", "__codevalue-negative-control.ts");
  const probeSource =
    `import { pluginError } from "./util.ts";\n` +
    `// The typo MUST be rejected; see the negative control in test/typecheck-gate.mjs.\n` +
    `export const typo = pluginError("not_a_real_code_typo", "must not compile");\n`;
  try {
    writeFileSync(probe, probeSource, "utf8");
    const tsc = spawnSync(process.execPath, [TSC, "--noEmit", "--strictNullChecks", "--module", "nodenext",
      "--moduleResolution", "nodenext", "--allowImportingTsExtensions", "--target", "es2023", probe], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    });
    const out = `${tsc.stdout ?? ""}${tsc.stderr ?? ""}`;
    // Expect a REJECTION that names the PROBE FILE. Matching the typo string or
    // "CodeValue" alone is not enough: an unrelated error elsewhere (say,
    // `error.code = code` rejecting a loosened parameter) would satisfy that
    // while the probe itself compiled clean — passing for the wrong reason.
    const probeName = "__codevalue-negative-control.ts";
    const rejected = tsc.status !== 0 && out.includes(probeName) && /not_a_real_code_typo|CodeValue/.test(out);
    if (rejected) {
      process.stdout.write(`[typecheck-gate] negative control ok — a misspelled code is rejected (${out.trim().split("\n")[0]})\n`);
    } else {
      console.error(
        `[typecheck-gate] FAIL negative control — a misspelled code compiled CLEAN.\n` +
        `[typecheck-gate]   \`pluginError\` no longer takes CodeValue (the CODE union), so the\n` +
        `[typecheck-gate]   taxonomy's compile-time guarantee is gone. tsc said: ${out.trim() || "(nothing)"}\n`
      );
      failed = true;
    }
  } finally {
    rmSync(probe, { force: true });
  }
}

if (failed) process.exit(1);
console.log(`\nall typecheck checks passed (typescript ${pinned}, ${CONFIGS.length} config(s), 0 errors)`);

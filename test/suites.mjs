/**
 * The gate roster — ONE list, in the order it must run.
 *
 * ## Why this file exists
 *
 * The list used to live twice, as text:
 *
 *   - `package.json`'s `scripts.test`, and
 *   - the "Run the offline suites" step in `.github/workflows/ci.yml`,
 *
 * both written as `node test/X.mjs && node test/Y.mjs && …` in a single
 * `set -e` shell. That shape is PITFALLS §30's root cause 2, quoted from the
 * repository's own postmortem:
 *
 *   > `set -e` + 19 个套件写在同一个 step：第 2 个套件一抛错，后面 17 个
 *   > （含 `build-gate`）一次都没跑过。于是「门禁红」看起来像某个用例失败，
 *   > 实际是门禁根本没在验证。
 *
 * §30 fixed that postmortem's root causes 1 (peer sourcing) and 3 (a comment
 * that lied), and listed three fixes — none of which was "stop chaining". So
 * the sentence stayed in the lesson and the shape stayed in both entry points.
 * §30's closing rule is the one that applies here:
 *
 *   > 门禁的依赖获取方式也是门禁的一部分 … 判据不是「CI 红没红」，而是
 *   > 「这个门禁在目标环境上有没有可能变绿」。
 *
 * A chain cannot report "green" honestly: a red early suite hides every later
 * suite's verdict, so the run's own output understates what was verified. On
 * this machine that is not hypothetical — `store.test.mjs` (2nd) depends on
 * Host peer packages, and a machine without them turns the whole tail into
 * silence. That is also why the repo's own guidance is "verify per domain, and
 * let the pre-push hook run the full set" (AGENTS.md): with a chain, there was
 * no way to ask for a full local run and get a truthful answer.
 *
 * ## What this file is NOT
 *
 * It is not a second source of truth — it is THE one. `test/run-all.mjs`
 * executes it, and `test/package.test.mjs`'s roster pin reads it (it used to
 * regex-scrape two text mirrors and compare them; scraping one array is
 * strictly stronger, and it let the CI pin become "CI invokes this same
 * runner" instead of "CI's hand-copied list matches package.json's").
 *
 * The CI offline job runs the same runner with `--skip=e2e-gate`, because the
 * end-to-end tier is a separate job there (it needs a Host runtime and a build
 * of the shipped artifacts). `e2e-gate` still runs in the LOCAL default gate,
 * and SKIPs loudly where the `dsh` CLI is absent.
 *
 * @module test/suites
 */

/**
 * The default gate, in run order.
 *
 * Order is not arbitrary: the cheap pure-logic suites come first so a broken
 * import fails in under a second, the peer-dependent ones sit in the middle
 * where §30's failure used to hide everything after them, and the three
 * build-shaped gates (duplication → typecheck → build) stay last because they
 * are the slowest and the most likely to be SKIPped by a missing devDependency.
 *
 * `e2e-gate` is last on purpose: it boots a real Host process, so it must not
 * hold up the 29 cheap verdicts that precede it.
 *
 * @type {ReadonlyArray<{name: string, kind: "suite"|"gate", note: string}>}
 */
export const SUITES = Object.freeze([
  // ── the 26 *.test.mjs suites (this exact set is what package.test.mjs pins
  //    against disk; the four gate files below are exempt there, as e2e-gate
  //    has been since it stopped being a *.test.mjs) ───────────────────────
  { name: "auth.test.mjs", kind: "suite", note: "login / PKCE / JWE / throttle classification" },
  { name: "store.test.mjs", kind: "suite", note: "token store behaviour (peer-dependent)" },
  { name: "store-baseline.test.mjs", kind: "suite", note: "frozen behaviour frames — zero drift allowed" },
  { name: "routes.test.mjs", kind: "suite", note: "the HTTP route family" },
  { name: "panel.test.mjs", kind: "suite", note: "panel decisions + zh/en dictionary parity" },
  { name: "render.test.mjs", kind: "suite", note: "the client render surface" },
  { name: "parsers.test.mjs", kind: "suite", note: "response parsing + shape-drift detection" },
  { name: "snapshot-aggregate.test.mjs", kind: "suite", note: "snapshot body aggregation" },
  { name: "provider.test.mjs", kind: "suite", note: "provider registration state machine" },
  { name: "provider-rollback-guard.test.mjs", kind: "suite", note: "rollback path (only runs when things broke)" },
  { name: "switch-precedence.test.mjs", kind: "suite", note: "panel value vs config default" },
  { name: "config.test.mjs", kind: "suite", note: "settings resolution + auth overrides" },
  { name: "package.test.mjs", kind: "suite", note: "npm manifest + the gate roster pin" },
  { name: "docs.test.mjs", kind: "suite", note: "documentation consistency" },
  { name: "wiring.test.mjs", kind: "suite", note: "host wiring + publish serialisation" },
  { name: "contract.test.mjs", kind: "suite", note: "the outbound inference contract" },
  { name: "retry.test.mjs", kind: "suite", note: "429 backoff / triage" },
  { name: "error-fix.test.mjs", kind: "suite", note: "LLM error repair" },
  { name: "peer-contract.test.mjs", kind: "suite", note: "what this plugin asks of its peers" },
  { name: "draw.test.mjs", kind: "suite", note: "draw absorption + degrade markers" },
  { name: "doctor.test.mjs", kind: "suite", note: "doctor symptom codes" },
  { name: "raccoon.test.mjs", kind: "suite", note: "second upstream: QR encoder, walk, catalogue" },
  { name: "raccoon-status.test.mjs", kind: "suite", note: "raccoon state assembly (optional deps)" },
  { name: "raccoon-search.test.mjs", kind: "suite", note: "hosted web_search provider" },
  { name: "raccoon-web.test.mjs", kind: "suite", note: "search selection takeover/restore" },
  { name: "state-segmentation.test.mjs", kind: "suite", note: "per-profile state directories" },

  // ── the four gate files. Not *.test.mjs, so the three-way roster pin
  //    exempts them (same exemption e2e-gate has always had) — but they are
  //    still part of the default gate and still have to EXIST, which
  //    package.test.mjs now checks against this list. ───────────────────────
  { name: "duplication-gate.mjs", kind: "gate", note: "jscpd over src/ against a line-capped whitelist" },
  { name: "typecheck-gate.mjs", kind: "gate", note: "local tsc under tsconfig.json's strict flags" },
  { name: "build-gate.mjs", kind: "gate", note: "real tsdown build of lib/ + client.js" },
  { name: "e2e-gate.mjs", kind: "gate", note: "boots a real Host; SKIPs without the dsh CLI" }
]);

/**
 * Suites that must never join the default gate.
 *
 * The network tier is the reason: a green offline run must not reach the
 * platform. `live-jwks.test.mjs` runs only via `npm run test:live`, and
 * package.test.mjs pins its EXCLUSION — so wiring it in fails the gate rather
 * than quietly making every local run billable.
 * @type {ReadonlySet<string>}
 */
export const EXEMPT = new Set(["live-jwks.test.mjs"]);

/**
 * The CI offline job's shape of the gate: everything except the end-to-end
 * tier, which is its own job (it needs a Host runtime and a build of the
 * shipped artifacts). Expressed as a flag string rather than a second list, so
 * CI cannot drift out of sync by editing a copy.
 * @type {string}
 */
export const CI_FLAGS = "--skip=e2e-gate";

/**
 * The one answer to "may this suite trust the artifact on disk?".
 *
 * Two suites in this roster judge BUILT bytes rather than sources:
 *
 *   - `render-dom.test.mjs` `eval`s the root `client.js` in jsdom. That is the
 *     point of it — it is the only suite that proves the SHIPPED client bytes
 *     render — but it also means its verdict is about whatever bundle happens
 *     to be on disk.
 *   - `e2e-gate.mjs` spawns `e2e.mjs`, which writes a profile that links this
 *     package; the Host resolves it through `package.json` → `main` →
 *     `lib/index.js`. So it exercises the BUILT host bundle.
 *
 * Either one, run on a tree whose `src/` has moved past the last build, reports
 * on code that is no longer there. That is PITFALLS §41, where ten source
 * mutations survived a green run.
 *
 * The verdict lives here, apart from `run-all.mjs`, for the same reason
 * `peer-roots.mjs` lives apart from `e2e.mjs`: it is a judgement, not I/O, and
 * a judgement that only ever runs inside a spawn is a judgement nobody tests.
 * The caller does the probing (stat, git) and this module decides.
 *
 * `build-gate.mjs` remains the AUTHORITY on freshness — it rebuilds in place
 * and compares byte-for-byte — so the runner only consults this when the gate
 * is not part of the selection. The roster deliberately puts `build-gate`
 * (index 108) immediately before `e2e-gate` (109), so the full run rebuilds
 * before either consumer reads the disk.
 *
 * @module test/artifact-freshness
 */

/**
 * The suites whose verdict is about a BUILT artifact, mapped to the artifact
 * they consume (relative to the repo root).
 *
 * A map rather than a set because the two consumers need different files, and
 * "which file does this suite actually read" is the whole question.
 * @type {Map<string, string>}
 */
export const ARTIFACT_CONSUMERS = new Map([
  ["render-dom.test.mjs", "client.js"],
  ["e2e-gate.mjs", "lib/index.js"]
]);

/**
 * Why an artifact-consuming suite must not run against this working tree, or
 * `""` when the artifact may be trusted.
 *
 * Both conditions are required, and each earns its place. Uncommitted `src/`
 * says the tree moved past the last commit; the mtime comparison is what keeps
 * the ordinary "edit, `npm run build`, run the suite" workflow working, since a
 * rebuild rewrites the artifact after the sources it read. A clean tree is left
 * to `build-gate`, which judges it better than a timestamp can.
 *
 * @param {object} probe - the ambient facts, gathered by the caller.
 * @param {string} probe.name - the artifact's path, for the message.
 * @param {boolean} probe.exists - whether the artifact is on disk.
 * @param {boolean|null} probe.dirty - uncommitted `src/` changes; `null` when
 *   git is unusable (a source tarball, a stripped PATH), which decides nothing.
 * @param {number} probe.srcMtime - newest mtime (ms) anywhere under `src/`.
 * @param {number} probe.artifactMtime - mtime (ms) of the artifact itself.
 * @returns {string} the reason to print on the skip line, or "" to run normally.
 */
export function staleArtifactReason({ name, exists, dirty, srcMtime, artifactMtime }) {
  if (!exists) return `the built artifact ${name} is absent — run: npm run build`;
  // `null` is "cannot tell" and `false` is "committed tree": both hand the
  // question to build-gate rather than inventing a verdict here.
  if (dirty !== true) return "";
  if (srcMtime <= artifactMtime) return "";
  return `src/ has uncommitted changes newer than ${name} — this suite runs the BUILT artifact, ` +
    "so it would exercise the previous build. Run: npm run build";
}

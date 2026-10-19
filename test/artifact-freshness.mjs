/**
 * The one answer to "may this suite trust the bundle on disk?".
 *
 * `render-dom.test.mjs` EVALUATES the root `client.js` rather than importing
 * `src/`: that is the point of it — it is the only suite that proves the
 * SHIPPED bytes render — but it also means a run containing it can come back
 * green about code that is no longer in the tree. That is PITFALLS §41, where
 * ten source mutations survived a green run.
 *
 * The verdict lives here, apart from `run-all.mjs`, for the same reason
 * `peer-roots.mjs` lives apart from `e2e.mjs`: it is a judgement, not I/O, and
 * a judgement that only ever runs inside a spawn is a judgement nobody tests.
 * The caller does the probing (stat, git) and this module decides.
 *
 * `build-gate.mjs` remains the AUTHORITY on freshness — it rebuilds in place
 * and compares byte-for-byte — so the runner only consults this when the gate
 * is not part of the selection.
 *
 * @module test/artifact-freshness
 */

/** The suites whose verdict is about the root `client.js` bundle, not `src/`. */
export const ARTIFACT_CONSUMERS = new Set(["render-dom.test.mjs"]);

/**
 * Why an artifact-consuming suite must not run against this working tree, or
 * `""` when the bundle may be trusted.
 *
 * Both conditions are required, and each earns its place. Uncommitted `src/`
 * says the tree moved past the last commit; the mtime comparison is what keeps
 * the ordinary "edit, `npm run build`, run the suite" workflow working, since a
 * rebuild rewrites `client.js` after the sources it read. A clean tree is left
 * to `build-gate`, which judges it better than a timestamp can.
 *
 * @param {object} probe - the ambient facts, gathered by the caller.
 * @param {boolean} probe.exists - whether the root `client.js` is on disk.
 * @param {boolean|null} probe.dirty - uncommitted `src/` changes; `null` when
 *   git is unusable (a source tarball, a stripped PATH), which decides nothing.
 * @param {number} probe.srcMtime - newest mtime (ms) anywhere under `src/`.
 * @param {number} probe.artifactMtime - mtime (ms) of the root `client.js`.
 * @returns {string} the reason to print on the skip line, or "" to run normally.
 */
export function staleArtifactReason({ exists, dirty, srcMtime, artifactMtime }) {
  if (!exists) return "the root client.js artifact is absent — run: npm run build";
  // `null` is "cannot tell" and `false` is "committed tree": both hand the
  // question to build-gate rather than inventing a verdict here.
  if (dirty !== true) return "";
  if (srcMtime <= artifactMtime) return "";
  return "src/ has uncommitted changes newer than the root client.js — this suite evaluates the BUNDLE, " +
    "so it would verify the previous build. Run: npm run build";
}

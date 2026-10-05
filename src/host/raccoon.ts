/**
 * The Raccoon Work（商汤小浣熊）protocol layer — the pure, peer-free half of the
 * second upstream provider (ROADMAP §6.1 "second upstream provider").
 *
 * **This file is a barrel** (2026-10-05). It was one 683-line module; it is now
 * six modules split along the dependency DAG its own segments formed, and this
 * re-exports all of them so every consumer's import line is unchanged. Nothing
 * is defined here.
 *
 * | module | carries | depends on |
 * |---|---|---|
 * | {@link ./raccoon-consts} | endpoint prefixes, QR timings | — |
 * | {@link ./raccoon-codes} | the rotation-failure taxonomy | — |
 * | {@link ./raccoon-http} | headers, envelope, JWT readers | — |
 * | {@link ./raccoon-auth} | QR generate/poll, refresh | consts, codes, http |
 * | {@link ./raccoon-catalog} | row transforms, catalogue, balance | consts, http |
 * | {@link ./raccoon-fallback} | static roster, pinned thinking dialect | — |
 *
 * The split is a pure move: no logic changed, no cycle exists (the graph above
 * is acyclic), and the segment boundaries were chosen from the measured
 * cross-segment reference edges rather than by taste. Consumers may import from
 * the leaf modules directly when that is more honest (the suites do), or from
 * here when they genuinely use several segments.
 *
 * Mechanism reference only (ROADMAP §6.1: "机制参考，不抄代码"): the endpoints,
 * the QR/SMS login walk, and the credit semantics were probed against the live
 * gateway and re-stated here, not ported. The desktop `~/.box-agent` token
 * route is REJECTED (§6.1.1: the refresh token is single-use; a 401 ×2 write-
 * back probe), so this half never touches a desktop credential file — login is
 * a self-built WeChat-QR walk whose tokens land in the DSH credentials service
 * (`raccoon-store.ts`), never in this plugin's directory, git, or logs.
 *
 * Wire facts this layer encodes (all probed 2026-09 against the gateway):
 *   - envelope `{ code, message, details, data }`, success is `code === 0`;
 *   - the QR page is public: any self-made 32-hex code enters `pending` and is
 *     verified server-side, so the code is generated LOCALLY (`generateQrCode`);
 *   - the refresh token is SINGLE-USE: the server rotates BOTH tokens, so a
 *     refresh always re-stores the pair (the store owns that write-back);
 *   - `thinking` control is a PROVIDER-LEVEL dialect (`extra_body.thinking`,
 *     two states only); `reasoning_effort` is accepted by the schema but has
 *     no observable effect, so this module never emits it.
 *
 * Every module here takes an injected fetcher and pure data, so the offline
 * suites exercise them without a network; no Host peer is imported.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon
 */

export * from "./raccoon-consts.ts";
export * from "./raccoon-codes.ts";
export * from "./raccoon-http.ts";
export * from "./raccoon-auth.ts";
export * from "./raccoon-catalog.ts";
// NOT `export *`: `raccoonThinkingExtraBody` is deliberately unexported from
// the leaf — it has no production caller, and the suite reaches it by named
// import from `raccoon-fallback.ts` directly. Re-exporting it here would put it
// back on the public face this split removed it from.
export { RACCOON_FALLBACK_MODELS } from "./raccoon-fallback.ts";

/**
 * The static fallback roster and the pinned-but-unwired thinking dialect.
 *
 * Split out of the former single `raccoon.ts` (2026-10-05). This is the leaf of
 * the Raccoon dependency DAG: nothing here imports another Raccoon module, and
 * nothing imports this except the three consumers that need a roster when the
 * live read came back empty.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-fallback
 */

/**
 * The static fallback roster: the six `visible: true` chat models the gateway
 * listed at probe time (2026-09), with the per-model `context_window` /
 * `max_output_length` the catalogue then carried. Used ONLY when
 * `fetchRaccoonCatalog` comes back empty, so the provider still offers models;
 * a fresh catalogue always wins over this table.
 *
 * These numbers are a CATALOG SNAPSHOT (the directory-authoritative values as
 * they read at probe time), not guessed defaults — see ADR-004 / docs/
 * SENSENOVA-API.md: the descriptor must declare directory values and fall back
 * to undeclared (harness fills 32768) when the field is truly absent. They are
 * only reached when the live catalogue is unreachable, which is exactly the
 * scenario where a slightly stale but real window beats an invented one.
 *
 * The `vision` column is the ONE column that is not the snapshot's own: it
 * carries the measured verdict (2026-10-06 probe, see
 * `raccoon-catalog.ts`'s probe sets and docs/ADR.md ADR-009), because the
 * catalogue's declaration was measured wrong in BOTH directions —
 * `sn-glm-5-3` is tagged `vision` and cannot see, `sn-glm-5-3-flash` is
 * untagged and can. These rows never pass through `raccoonRowVision`
 * (they are already normalized), so the two bits below are kept honest by a
 * consistency check in `test/raccoon.test.mjs` rather than by construction.
 */
export const RACCOON_FALLBACK_MODELS = Object.freeze([
  { id: "sn-sensenova-6-8-flash", name: "SenseNova 6.8 Flash", multiplier: 0, vision: true, contextWindow: 256_000, maxOutputLength: 63_999 },
  { id: "sn-sensenova-6-8-flash-lite", name: "SenseNova 6.8 Flash Lite", multiplier: 0, vision: true, contextWindow: 256_000, maxOutputLength: 63_999 },
  { id: "sn-glm-5-3", name: "GLM-5.3", multiplier: 0.75, vision: false, contextWindow: 1_000_000, maxOutputLength: 65_536 },
  { id: "sn-kimi-k3", name: "Kimi K3", multiplier: 1, vision: true, contextWindow: 1_000_000, maxOutputLength: 65_536 },
  { id: "sn-glm-5-3-flash", name: "GLM-5.3 Flash", multiplier: 0.2, vision: true, contextWindow: 1_000_000, maxOutputLength: 65_536 },
  { id: "sn-deepseek-v4-1-flash", name: "DeepSeek V4.1 Flash", multiplier: 0.25, vision: true, contextWindow: 1_000_000, maxOutputLength: 65_536 }
]);

/**
 * The two-state thinking control for this provider (a PROVIDER-level dialect,
 * model-independent — verified: every visible model accepts the same field).
 *
 * The ONLY wire channel that works is `extra_body.thinking = { type }`;
 * `reasoning_effort` is schema-accepted but has no observable effect, and a
 * top-level `thinking` is silently ignored by the gateway.
 *
 * v1 does not wire this into the adapter: it registers `reasoning: false`
 * (see `raccoon-models.ts`), so the encoder has no production caller and is
 * exercised by the test suite only. It stays as a pinned wire fact so the
 * day the adapter learns to carry `extra_body`, the spelling does not have to
 * be re-probed.
 *
 * **Not exported** (2026-10-05): an exported symbol with no production caller
 * is debt on the module's public face — it invites a call site that the
 * provider cannot honour (`reasoning: false` means the adapter drops the
 * field). The test suite reaches it by named import from THIS module, which
 * is what keeps it honest: the day the adapter learns to carry `extra_body`,
 * the right move is to export it deliberately from `raccoon-models.ts`, not
 * to widen this leaf's surface by accident.
 * @param {string|undefined} effort - `undefined` = send nothing (server default
 *   = thinking on); `"off"` = disabled; anything else = enabled.
 * @returns {object|undefined} the `extra_body` value, or `undefined`.
 */
export function raccoonThinkingExtraBody(effort: string | undefined): object | undefined {
  if (effort === undefined || effort.length === 0) return undefined;
  const type = effort === "off" ? "disabled" : "enabled";
  return { thinking: { type } };
}

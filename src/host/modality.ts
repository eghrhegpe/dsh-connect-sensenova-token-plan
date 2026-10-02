/**
 * The catalog modality judgment — the ONE place both model lists read from.
 *
 * Before this module existed, the two directions of "is this entry an image
 * model" lived in two files with two shapes:
 *
 *   - `llm-models.ts` `isChatModel` (PERMISSIVE): a missing `output_modalities`
 *     reads as chat, so a field the platform never sent does not vanish from
 *     the picker;
 *   - `draw.ts` `isImageGenModel` (STRICT): a missing `output_modalities` reads
 *     as "not a draw model", so a wrong guess never sends the agent's request
 *     to a model that cannot answer.
 *
 * They are complements, and a missing field makes them drift in OPPOSITE
 * directions — the "two lists can never disagree" claim was maintained by
 * convention (each side re-implemented the same field probe), not by
 * construction. This module folds the probe into one function: both predicates
 * read the same modality decision, so a contradiction between the chat roster
 * and the draw list becomes impossible rather than merely undiscovered.
 *
 * For SenseNova the platform ALWAYS declares `output_modalities` on every
 * catalog entry (verified 2026-09-29), so the name-segment fallback Agnes
 * needs (its gateway declares no modality field at all) does not exist here;
 * the strict/permissive split on a MISSING field is the only nuance, and it is
 * preserved exactly as the two historical predicates behaved.
 *
 * @module dsh-connect-sensenova-token-plan/modality
 */

/**
 * The image-modality decision of one catalog entry.
 *
 * The single probe both predicates read. Returns one of:
 *
 *   - `"declared-image"` — `output_modalities` is an array containing "image";
 *   - `"declared-other"`  — the field is an array without "image";
 *   - `"unknown"`         — the field is absent or not an array.
 *
 * A caller wanting the raw list can read `entry?.output_modalities` itself;
 * this function is the judgment, not the data.
 * @param {object} entry - one normalized catalog entry.
 * @returns {"declared-image"|"declared-other"|"unknown"}
 */
export function outputModalityOf(entry) {
  const out = entry?.output_modalities;
  if (!Array.isArray(out)) return "unknown";
  return out.includes("image") ? "declared-image" : "declared-other";
}

/**
 * Whether a catalog entry can be addressed as a CHAT model on this provider's
 * OpenAI-compatible endpoint.
 *
 * PERMISSIVE direction: a missing/unknown field reads as chat, so an entry
 * the platform did not annotate does not vanish from the picker. Only an
 * explicit image-GENERATION declaration keeps it out (such models answer 404
 * on `/v1/chat/completions`, verified 2026-09-29).
 * @param {object} entry - one normalized catalog entry.
 * @returns {boolean} whether the entry is usable as a chat model.
 */
export function isChatModel(entry) {
  return outputModalityOf(entry) !== "declared-image";
}

/**
 * Whether one catalog entry is an image-GENERATION model.
 *
 * STRICT direction of the same judgment: only an EXPLICIT "image" declaration
 * counts. A missing field means "unknown", and unknown must not be offered as
 * a draw model — unlike the chat direction (permissive), a wrong draw guess
 * sends the agent's request to a model that cannot answer.
 * @param {object} entry - one normalized catalog entry.
 * @returns {boolean}
 */
export function isImageGenModel(entry) {
  return outputModalityOf(entry) === "declared-image";
}

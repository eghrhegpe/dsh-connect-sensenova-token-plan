/**
 * One roster row, drawn once for every model list that has one.
 *
 * `ModelRoster` (the Token Plan catalogue) and `RaccoonRoster` (the second
 * upstream's gateway catalogue) draw the SAME row: a two-line block whose head
 * line is a checkbox, the model id, an optional `×N` rate chip, and badges for
 * notable states, over an indented parameter line that quotes only the figures
 * the upstream actually declared.
 *
 * `test/render.test.mjs` pins that shape for BOTH components in one loop, with
 * a comment saying the next change must not "migrate one and forget the rest" —
 * which is precisely the case for one definition instead of two. The drift had
 * already happened, in three places nobody noticed: the Token Plan label ran a
 * 10px gap and the Raccoon one 8px; the rate chip sat INSIDE the label on one
 * side and beside it on the other; and one row pushed its badge right with
 * `flex: "1 1 auto"` on the label while the other hard-coded a spacer. Each is
 * invisible in isolation and permanent once both copies are edited separately.
 *
 * What stays with the CALLER is every domain fact, because that is where the
 * two catalogues genuinely differ: what counts as "on" (`ModelRoster` reads an
 * allow-list; `RaccoonRoster` reads `null` as "the whole roster pushes"), what
 * a zero rate means (`×0` is the operator's own pseudo figure, while the
 * Raccoon gateway's 0 really means free), which tooltip labels that figure,
 * which badges are notable, and which parameter segments exist at all — the
 * thinking ladder is deliberately absent for the Raccoon provider. This
 * component therefore takes rendered CONTENT, never a mode flag: a boolean
 * `raccoon` prop would put the two catalogues' wording back in one file, which
 * is the thing being separated.
 * @module dsh-connect-sensenova-token-plan/model-row
 */

import { h } from "./runtime.ts";
import { S } from "./styles.ts";

/**
 * One row of a model roster.
 * @param {object} props - the row's content, already decided by the caller.
 * @param {string} props.id - the model id; also the name's hover title.
 * @param {string} props.label - the name on screen (falls back to the id).
 * @param {boolean} props.on - whether the model is pushed; off dims the row.
 * @param {boolean} [props.busy] - disables the checkbox while a save or the
 *   login walk is in flight, and drops the pointer cursor to match.
 * @param {string|null} [props.rateText] - the rate chip's text (`×0.75`, or a
 *   provider-specific "free"); `null`/absent draws no chip.
 * @param {string} [props.rateTitle] - the chip's tooltip. It is the caller's
 *   because the two rates are NOT the same fact (see the module note).
 * @param {unknown[]} [props.badges] - badge nodes for the head line's right
 *   edge; the caller decides which states are worth quoting.
 * @param {string|null} [props.meta] - the parameter line's text; empty/absent
 *   draws no line rather than an empty one.
 * @param {(id: string) => void} [props.onToggle] - absent (render suite), the
 *   checkbox is display-only.
 * @returns {unknown} the `<li>` for this row.
 */
export function ModelRow({ id, label, on, busy, rateText, rateTitle, badges, meta, onToggle }: {
  id: string;
  label: string;
  on: boolean;
  busy?: boolean;
  rateText?: string | null;
  rateTitle?: string;
  badges?: unknown[];
  meta?: string | null;
  onToggle?: (id: string) => void;
}): unknown {
  const badgeList = Array.isArray(badges) ? badges.filter((badge) => badge !== null && badge !== undefined) : [];
  // No explicit spacer before the badges: `modelRowHead` is a flex row and the
  // label below grows (`1 1 auto`), so it absorbs the slack and the badges land
  // on the right edge anyway. A spacer AND a growing label would split the free
  // space between them and push the rate chip away from the name it belongs to.
  return h(
    "li",
    { style: { ...S.modelRow, ...(on ? {} : S.modelRowOff) } },
    h(
      "div",
      { style: S.modelRowHead },
      // `modelRow` is a COLUMN (a head line over an optional parameter line),
      // so the checkbox, the name and its badge must sit inside one
      // `modelRowHead` row — as bare siblings they stack, the badge drops to
      // its own line, and the whole row reads as a broken two-column attempt.
      h(
        "label",
        {
          style: busy ? { ...S.modelRowLabel, cursor: "default" } : { ...S.modelRowLabel, cursor: "pointer" }
        },
        h("input", {
          type: "checkbox",
          checked: on,
          disabled: busy === true,
          style: S.modelCheck,
          "aria-label": label,
          // Hook-free: the handler is handed in. Without it this box is
          // display-only and the list cannot be edited by a single row.
          onChange: onToggle ? () => onToggle(id) : undefined
        }),
        h("span", { style: S.modelName, title: id }, label),
        // The rate rides directly after the name (WorkBuddy's `(0.29x)` shape):
        // it qualifies THAT model, so it must not float to the far edge.
        rateText === null || rateText === undefined
          ? null
          : h("span", { style: S.modelRate, title: rateTitle }, rateText)
      ),
      // A badge marks a NOTABLE state only. Its `key` is the caller's index
      // position, so the list stays stable if one upstream gains a badge and
      // the other does not.
      ...badgeList
    ),
    // The parameter line carries only what was declared: a figure the upstream
    // never sent draws no segment, and a line with nothing to say vanishes —
    // an empty line reads as "there is nothing to know", which is different
    // from "we do not know".
    meta === null || meta === undefined || meta === ""
      ? null
      : h("div", { style: S.modelMeta }, meta)
  );
}

/**
 * The Raccoon roster: the models the second upstream's adapter offers.
 *
 * Split out of `raccoon-tab.ts` for the reason its rows are split out of every
 * other list: the tab's data is internal `useState`, so the render suite can
 * only ever reach its logged-out frame — a roster inlined in a hook component
 * is unassertable, and the row-shape regression that once broke the draw card
 * would sail through again. Hook-free here, so the suite mounts the very rows
 * the browser draws.
 *
 * The row SKELETON comes from {@link ModelRow}, shared with the Token Plan
 * roster. What this module decides is what the gateway's catalogue makes
 * DIFFERENT:
 * - a `null` curation means "the whole roster pushes", not "nothing does" —
 *   the opposite default from the Token Plan allow-list;
 * - a declared multiplier of 0 reads as 免费, because this figure is the
 *   gateway's own price rather than the operator's pseudo rate, and `×0` would
 *   quote a real zero as a rate;
 * - the rate tooltip is `raccoon.rateTitle`, never the Token Plan's
 *   `llm.rosterRateTitle` — the latter calls the figure a pseudo, operator-side
 *   number, which would libel data that came straight off the wire;
 * - there is NO thinking ladder. This provider registers `reasoning: false`
 *   (pi-ai cannot emit `extra_body.thinking`, the gateway's only working
 *   channel), so quoting levels would promise a selector the DSH picker will
 *   never offer. An unsupported fact is left out, never guessed at.
 * @module dsh-connect-sensenova-token-plan/raccoon-roster
 */

import { count, format, tokenSize } from "./format.ts";
import { raccoonModelIsOn } from "./models.ts";
import { ModelRow } from "./model-row.ts";
import { h } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { S } from "./styles.ts";
import type { RaccoonModel } from "../shared/wire.ts";

/**
 * One model row as the /raccoon route reports it.
 *
 * The row shape now lives in `src/shared/wire.ts` (one declaration for both
 * halves). Re-exported here so the row type stays reachable at this path; the
 * component imports the same type for its own props.
 */
export type { RaccoonModel };

/**
 * The model roster the Raccoon adapter offers.
 * @param {object} props
 * @param {RaccoonModel[]} props.models - the rows the route reported.
 * @param {Tt} props.tt - the dictionary.
 * @param {("live"|"empty"|"unreadable")?} [props.source] - which table these
 *   rows came from; a silent fallback is named so the panel cannot read the
 *   built-in table as the gateway's catalogue.
 * @param {string[]?} [props.enabledIds] - the saved pushed-model curation;
 *   `null`/absent reads as "the whole roster pushes".
 * @param {boolean} [props.busy] - disables the checkboxes while a save or the
 *   login walk is in flight.
 * @param {boolean} [props.registered] - whether the provider pair is
 *   currently registered; the header chip says so.
 * @param {(id: string) => void} [props.onToggle] - the per-row toggle; absent
 *   (render suite), the checkboxes are display-only.
 * @returns {unknown} the roster list element.
 */
export function RaccoonRoster({ models, tt, source, enabledIds, busy, registered, onToggle }: {
  models: readonly RaccoonModel[];
  tt: Tt;
  source?: "live" | "empty" | "unreadable";
  enabledIds?: string[] | null;
  busy?: boolean;
  registered?: boolean;
  onToggle?: (id: string) => void;
}): unknown {
  const rows = Array.isArray(models) ? models : [];
  const fallbackNote = source === "empty" ? tt("raccoon.modelsEmpty") : source === "unreadable" ? tt("raccoon.modelsFallback") : null;
  // `null` (the panel never curated) is "every model pushes", not "none does".
  // The predicate is the SHARED one (`models.ts`): the rule this line applies
  // is the same rule the toggle implements, so a row can no longer disagree
  // with the list that ticking it would post.
  return h(
    "div",
    { style: { ...S.modelPanel, marginTop: 10 } },
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 } },
      h("span", { style: { ...S.muted, fontSize: 12, fontWeight: 600 } }, format(tt("raccoon.models"), { count: count(rows.length) })),
      fallbackNote !== null
        ? h("span", { style: { ...S.muted, fontSize: 11 } }, fallbackNote)
        : null,
      h("span", { style: S.spacer }),
      // The registration chip: the switch says "wants", this says "is", in the
      // spot the eye scans for state — the header's right edge.
      h("span", {
        style: {
          ...S.modelBadge,
          ...(registered === true ? { color: "var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))" } : {})
        }
      }, registered === true ? tt("raccoon.registeredChip") : tt("raccoon.unregisteredChip"))
    ),
    h("div", { style: { ...S.muted, fontSize: 11, marginBottom: 6 } }, tt("raccoon.pushHint")),
    h(
      "ul",
      { style: S.modelList, role: "list" },
      rows.map((row) => {
        const id = String(row?.id ?? "");
        const label = String(row?.name ?? id);
        const on = raccoonModelIsOn(enabledIds, id);
        // The credit rate reads as its own chip, drawn exactly like the Token
        // Plan roster's `×N` (0 is "free", not "×0" — see the module note).
        const rate = typeof row?.multiplier === "number" ? row.multiplier : null;
        // Only figures the platform actually declares draw a segment, and the
        // thinking ladder is deliberately absent (see the module note).
        const ctx = typeof row?.contextWindow === "number" && row.contextWindow > 0
          ? format(tt("llm.contextBadge"), { ctx: tokenSize(row.contextWindow) })
          : null;
        const out = typeof row?.maxOutputLength === "number" && row.maxOutputLength > 0
          ? format(tt("llm.metaOutput"), { out: tokenSize(row.maxOutputLength) })
          : null;
        const meta = [ctx, out].filter(Boolean).join(" · ");
        return h(ModelRow, {
          key: id,
          id,
          label,
          on,
          busy,
          rateText: rate === null ? null : rate === 0 ? tt("raccoon.free") : `×${rate}`,
          rateTitle: tt("raccoon.rateTitle"),
          badges: [
            row?.vision === true ? h("span", { key: "vision", style: S.modelBadge }, tt("llm.rosterVision")) : null
          ],
          meta,
          onToggle
        });
      })
    )
  );
}

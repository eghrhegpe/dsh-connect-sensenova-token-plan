/**
 * One horizontal progress bar, drawn the same way everywhere it appears: the
 * quota card, the composer popover's per-window row, and the per-model trend
 * rows all paint a track with an optional fill and report the same number to
 * assistive tech.
 *
 * Extracted 2026-10-19 (P1 review). The three call sites had drifted on the one
 * thing they must not: `aria-valuenow` was a STRING in the quota card
 * (`pct.toFixed(1)`) and a NUMBER in the other two. An ARIA value is a number —
 * the string form was a latent type error that only the DOM's own attribute
 * coercion hid, and it would have kept hiding. The primitive takes a number and
 * hands the DOM a number, so the three bars cannot disagree again.
 *
 * The THRESHOLDS stay at the call sites on purpose: the card grades 70 warn /
 * 90 danger and the pill grades 80 / 100 (`tierOf`), and both file headers
 * explain why they must not be unified (two threshold tables on one screen is
 * worse than either one). This module owns the SHAPE of the bar, not what colour
 * it happens to be.
 */
import { h } from "./runtime.ts";

/**
 * A progress bar: a track, an optional fill, and the ARIA triple.
 *
 * @param props.track - the track style (the full-width background).
 * @param props.fill - the fill style, or `null` to draw NO fill child at all.
 *   A caller with an unknown share passes `null` rather than a 0-width child,
 *   which a stray `min-width` in some engine could paint as a nub (the pill's
 *   comment owns that reasoning; the card passes a style and keeps its shape).
 * @param props.widthPct - the fill width percentage; ignored when `fill` is null.
 * @param props.valueNow - the value assistive tech reads: ALWAYS a number.
 * @param props.label - the accessible label.
 */
export function QuotaBar(props: {
  track: Record<string, unknown>;
  fill: Record<string, unknown> | null;
  widthPct: number;
  valueNow: number;
  label: string;
}): unknown {
  return h(
    "div",
    {
      style: props.track,
      role: "progressbar",
      "aria-label": props.label,
      "aria-valuenow": props.valueNow,
      "aria-valuemin": 0,
      "aria-valuemax": 100
    },
    props.fill === null ? null : h("div", { style: { ...props.fill, width: `${props.widthPct}%` } })
  );
}

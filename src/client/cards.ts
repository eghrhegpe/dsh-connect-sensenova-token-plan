/**
 * Hook-free presentational components: the panel icon, the quota pool cards,
 * the exhaustion notice, the trend chart, and the collapsible section card.
 * The render suite drives every one of these in Node, so behavior may not
 * drift by a hair.
 */
import { PANEL_ID } from "./const.ts";
import { clockLong, count, format, when } from "./format.ts";
import { h } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import { S } from "./styles.ts";
import type { PoolData, PoolsData, QuotaWindowData, TrendData } from "./wire.ts";

/**
 * A quota window as the wire carries it; fields are defensive on purpose.
 *
 * The alias exists because `QuotaCard` deliberately accepts `unknown`: a
 * window that is not an object at all (a shape-drifted row, an absent field)
 * must render nothing instead of throwing. `wire.ts` already describes the
 * well-formed case, so this narrows the same shape instead of redeclaring it.
 */
type QuotaWindow = QuotaWindowData;

/**
 * The "积分币" coin glyph the plugin card's `icon.svg` derives from, drawn here
 * so the shape lives in one place. The card itself is rendered by the Plugins
 * page (`plugins.bundle.config` slot); there is no sidebar row this could be a
 * glyph for.
 */
export function PanelIcon({ size }: { size?: number }): unknown {
  return h(
    "svg",
    {
      "data-dsh-panel-entry": PANEL_ID,
      viewBox: "0 0 16 16",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.3",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true"
    },
    h("circle", { cx: 8, cy: 8, r: 6 }),
    h("path", { d: "M8 5.2v5.6M6.2 6.6h3.6M6.2 9.4h3.6" })
  );
}

/** The bar fill and figure tone for a usage percentage: 70 warn / 90 danger. */
export function usageTone(pct: number): { fill: Record<string, unknown>; color: string } {
  if (pct >= 90) return { fill: S.barFillError, color: "var(--dsw-alias-state-error-primary)" };
  if (pct >= 70) return { fill: S.barFillWarn, color: "var(--dsw-alias-state-warn-primary)" };
  return { fill: S.barFill, color: "var(--dsw-alias-label-secondary)" };
}

/**
 * One quota window as a compact sub-card. The REMAINING PERCENTAGE is the
 * headline figure — raw credit counts in the tens of thousands are hard to
 * judge, while "79.4%" answers "还剩多少" at a glance (the shell's own
 * quota cards lead with a percentage for the same reason). The only raw
 * figures left are the used/limit caption under the bar: the percentage
 * already implies the balance, so a third number would be noise. The
 * headline carries the usage tone (70 warn / 90 error) because a tiny
 * remaining percentage is the alarm.
 *
 * A window that is not an object at all (a pool row the Host flagged as
 * shape-drifted, or a window field simply absent) renders NOTHING instead
 * of throwing: one malformed pool must not blank the whole panel — the
 * shape warning above already says what is wrong.
 */
export function QuotaCard({ label, window, tt }: { label: string; window: QuotaWindow | null | unknown; tt: Tt }): unknown {
  if (window === null || typeof window !== "object") return null;
  // Optional on the wire (parsePools normalizes, but the client keeps reading
  // defensively). `limit`/`used` default to 0: absent figures fail the `> 0`
  // guard exactly as the old `undefined > 0 === false` did — "unknown", not
  // a fake percentage. `remaining` stays undefined on purpose: ANY numeric
  // default would light one of the two comparisons (0 <= 0 shows the
  // exhaustion chip, a positive number shows a reset line), while the old
  // undefined made both read false — "say nothing when nothing is known".
  const { limit = 0, used = 0, remaining, resetAt } = window as QuotaWindow;
  // A missing/zero limit is UNKNOWN, not "0.0% remaining" — claiming the
  // window is drained when the platform simply said nothing is a lie, so
  // the headline reads "—" and the bar stays empty.
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : null;
  const tone = usageTone(pct ?? 0);
  const pctColor = tone.color;
  const headline = pct === null ? "—" : `${(100 - pct).toFixed(1)}%`;
  return h(
    "div",
    { style: S.quota },
    h(
      "div",
      { style: S.quotaTop },
      h("span", { style: S.quotaLabel }, label),
      // An absent `remaining` renders NEITHER chip (see the destructure
      // comment): the guard is the old `undefined <= 0 === false` made
      // explicit for the type checker.
      typeof remaining === "number" && remaining <= 0
        ? h("span", { style: { ...S.chip, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)" } }, tt("pool.exhausted"))
        : null
    ),
    h("div", { style: { ...S.quotaRemaining, color: pctColor } }, headline),
    // The bar tracks USAGE (it fills as the window drains), so its width
    // and its assistive value both carry the used percentage, while the
    // headline above carries the remaining one: two views of one number.
    h(
      "div",
      { style: S.bar, role: "progressbar", "aria-label": `${label} ${tt("pool.used")} ${pct === null ? "—" : `${pct.toFixed(1)}%`}`, "aria-valuenow": pct === null ? 0 : pct.toFixed(1), "aria-valuemin": 0, "aria-valuemax": 100 },
      h("div", { style: { ...tone.fill, width: `${pct ?? 0}%` } })
    ),
    // One quiet footer row: the only raw figures (used/limit) on the left,
    // the reset clock on the right. Both are supporting detail; keeping
    // them off the top row leaves the window label alone up there.
    h(
      "div",
      { style: S.quotaTop },
      h("span", { style: S.quotaUsed }, `${tt("pool.used")} ${count(used)} / ${count(limit)}`),
      // `when` not `clock`: the weekly reset can land on another day, and
      // a bare HH:MM reads as "later today" — wrong and alarming.
      typeof remaining === "number" && remaining > 0 && resetAt ? h("span", { style: S.quotaReset }, format(tt("pool.reset"), { time: when(resetAt) })) : null
    )
  );
}

/**
 * One pool card. The open state is intentionally tiny: name, type chip,
 * spendable grant balance, and the twin quota sub-cards. Everything
 * explanatory (grant expiry, the model coverage lists) folds into one
 * `<details>` row so the deck stays scannable on wide screens.
 */
export function PoolCard({ pool, tt }: { pool: PoolData; tt: Tt }): unknown {
  const callable = pool.callableModels || pool.modelIds || [];
  const locked = pool.lockedModels || [];
  const hasDetails = pool.nearestGrantExpiry || callable.length > 0 || locked.length > 0;
  return h(
    "div",
    { style: S.card },
    h(
      "div",
      { style: S.cardHead },
      h("span", { style: S.poolName }, pool.name),
      h("span", { style: S.chip }, pool.poolType === "dedicated" ? tt("pool.dedicated") : tt("pool.default")),
      h("span", { style: S.spacer }),
      // Spendable grant money belongs up with the headline, not buried.
      // `grantBalance` is optional on the wire; `?? 0` keeps the `> 0` guard
      // reading exactly as the old implicit `undefined > 0 === false` did.
      (pool.grantBalance ?? 0) > 0
        ? h("span", { style: S.grantChip, title: format(tt("pool.grant"), { balance: count(pool.grantBalance) }) }, format(tt("pool.grant"), { balance: count(pool.grantBalance) }))
        : null
    ),
    h(
      "div",
      { style: S.quotas },
      h(QuotaCard, { label: tt("pool.window5h"), window: pool.window5h, tt }),
      h(QuotaCard, { label: tt("pool.window7d"), window: pool.window7d, tt })
    ),
    hasDetails
      ? h(
          "details",
          { style: S.details },
          h("summary", { style: S.detailsSummary }, tt("pool.details")),
          h(
            "div",
            { style: S.detailsBody },
            pool.nearestGrantExpiry
              ? h("div", { style: S.grant }, format(tt("pool.grantExpiry"), { time: clockLong(pool.nearestGrantExpiry), balance: count(pool.nearestGrantExpiringBalance) }))
              : null,
            callable.length > 0
              ? h(
                  "div",
                  { style: S.models },
                  h("span", { style: { ...S.muted, fontSize: 12, marginRight: 2 } }, `${tt("pool.callable")}:`),
                  callable.map((model) => h("span", { key: model, style: S.modelTag }, model))
                )
              : null,
            locked.length > 0
              ? h(
                  "div",
                  { style: { ...S.models, ...S.muted }, title: locked.join(", ") },
                  h("span", { style: { fontSize: 12, marginRight: 2 } }, format(tt("pool.locked"), { count: locked.length }))
                )
              : null
          )
        )
      : null
  );
}

/**
 * A top-of-section notice for the "transient exhaustion" case: when one or
 * more credit pools have hit zero, the picker (host side) drops those pools'
 * models, so the reader sees models vanish with no explanation. This line
 * says WHY they vanished and WHEN they are expected back — the earliest
 * `resetAt` among the exhausted windows — so a zeroed pool reads as
 * "recovers at HH:MM", never as a mystery.
 *
 * Hook-free: it only reads the snapshot's `pools` array, so the render suite
 * drives the exact component the browser draws. Returns null when nothing is
 * exhausted (the common case stays silent). It does not guess whether a zero
 * came from a true quota drain or a rate-limit blip — the panel never sees
 * the 429 class — it only reports the pool's own reset clock, which is the
 * one honest recovery signal available here.
 */
export function PoolExhaustionNotice({ pools, tt }: { pools?: PoolsData | null; tt: Tt }): unknown {
  const list = Array.isArray(pools?.pools) ? pools.pools : [];
  let earliest = 0;
  let anyExhausted = false;
  for (const pool of list) {
    for (const key of ["window5h", "window7d"] as const) {
      const win = pool?.[key] as QuotaWindow | undefined;
      if (win && Number(win.remaining) <= 0) {
        anyExhausted = true;
        const reset = Number(win.resetAt) || 0;
        if (reset > 0 && (earliest === 0 || reset < earliest)) earliest = reset;
      }
    }
  }
  if (!anyExhausted) return null;
  // `when`, not `clock`: the earliest reset may belong to the weekly window
  // and sit days out, and a bare HH:MM would promise recovery in hours.
  const time = earliest > 0 ? when(earliest) : "—";
  return h(
    "div",
    {
      style: { ...S.formNote, color: "var(--dsw-alias-state-error-primary)", marginTop: 4, marginBottom: 10 },
      role: "status"
    },
    format(tt("pool.exhaustedNotice"), { time })
  );
}

/**
 * Per-model credit consumption, drawn as a mini bar chart so the eye
 * lands on WHICH model is burning credits: each row carries a bar
 * relative to the largest consumer (the top model fills the track), with
 * the absolute number right-aligned beside the model name. The whole
 * block sits in a card like the quota cards instead of floating as a
 * bare table.
 */
export function TrendTable({ trend, tt }: { trend?: TrendData | null; tt: Tt }): unknown {
  // `models` missing entirely (a drifted payload the Host still passed as
  // data) is the empty case, not a crash: the empty note is honest.
  if (!trend || !Array.isArray(trend.models) || trend.models.length === 0) return h("div", { style: S.card }, h("div", { style: S.empty }, tt("trend.none")));
  const max = Math.max(0, ...trend.models.map((row) => Math.max(0, Number(row.credits) || 0)));
  const anyMultiplier = trend.models.some((row) => typeof row.multiplier === "number");
  return h(
    "div",
    { style: S.card },
    h(
      "div",
      { style: S.trendHead },
      h("span", { style: S.trendHeadLabel }, tt("trend.model")),
      h("span", { style: { ...S.trendHeadLabel, textAlign: "right" } }, tt("trend.credits"))
    ),
    trend.models.map((row) => {
      const credits = Math.max(0, Number(row.credits) || 0);
      const pct = max > 0 ? (credits / max) * 100 : 0;
      return h(
        "div",
        { key: row.model, style: S.trendRow },
        h(
          "div",
          { style: S.trendRowHead },
          // Long model ids truncate; the full name is one hover away. A
          // configured pseudo multiplier (×N) rides beside the name: the
          // raw credits stay verbatim, the factor is a comparison aid only.
          h("span", { style: S.trendModel, title: row.model }, row.model, typeof row.multiplier === "number" && row.multiplier !== 1 ? h("span", { style: S.chip, title: tt("trend.multiplierLegend") }, `×${row.multiplier}`) : null),
          h("span", { style: S.trendCredits }, count(credits))
        ),
        h(
          "div",
          { style: S.trendBar, role: "progressbar", "aria-label": `${row.model} ${Math.round(pct)}%`, "aria-valuenow": Math.round(pct), "aria-valuemin": 0, "aria-valuemax": 100 },
          h("div", { style: { ...S.barFill, width: `${pct}%` } })
        )
      );
    }),
    // The bars above are scaled to the LARGEST consumer, so the top model
    // always fills the track — that answers "who is burning credits", but
    // the eye misreads a full track as "this model is at its limit". The
    // legend names the convention so the chart never lies by omission.
    h("div", { style: S.trendLegend }, tt("trend.legend")),
    // The honesty line: the ×N factors are the operator's own config, not
    // platform pricing — only shown when at least one row carries one.
    anyMultiplier ? h("div", { style: S.trendLegend }, tt("trend.multiplierLegend")) : null
  );
}

/**
 * One content section as a workbuddy-style collapsible card: a full-width
 * header button (title + rotating chevron) over a bordered card body.
 * Auto-expanded by default in `PanelPage`; the reader can tuck a section
 * away to focus on the other. Hook-free on purpose — `open` and `onToggle`
 * arrive as props, so the render tests exercise the toggle without faking
 * React state (children travel as a regular `children` prop, as in React).
 */
export function SectionCard({ title, open, onToggle, children, tt }: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children?: unknown;
  tt: Tt;
}): unknown {
  return h(
    "div",
    { style: S.sectionCard },
    h(
      "button",
      {
        type: "button",
        style: S.sectionHead,
        "aria-expanded": open,
        "aria-label": `${tt(open ? "section.collapse" : "section.expand")}: ${title}`,
        onClick: onToggle
      },
      h("span", { style: S.sectionHeadTitle }, title),
      h(
        "svg",
        { viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", style: open ? { ...S.chevron, ...S.chevronOpen } : S.chevron },
        h("path", { d: "M3 6l5 5 5-5" })
      )
    ),
    h("div", { style: S.sectionBody, hidden: !open }, open ? children : null)
  );
}

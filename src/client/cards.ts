/**
 * Hook-free presentational components: the quota pool cards, the exhaustion
 * notice, the trend chart, and the collapsible section card. The render suite
 * drives every one of these in Node, so behavior may not drift by a hair.
 *
 * `PanelIcon` used to live here: an inline "积分币" glyph for a plugin card the
 * Plugins page draws from `icon.svg`. It had no call site — the card renders
 * through the `plugins.bundle.config` slot, and there is no sidebar row to put a
 * glyph in — so the bundler dropped it from `client.js` entirely while its
 * source, its bilingual comments and its `PANEL_ID` import stayed behind and
 * were carried review after review. Deleted rather than kept "just in case":
 * the icon a user actually sees is `icon.svg` at the repo root.
 */
import { clockLong, count, format, when } from "./format.ts";
import { QuotaBar } from "./quota-bar.ts";
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

/** The bar fill and figure tone for a usage percentage: 70 warn / 90 danger. */
function usageTone(pct: number): { fill: Record<string, unknown>; color: string } {
  if (pct >= 90) return { fill: S.barFillError, color: "var(--dsw-alias-state-error-primary)" };
  if (pct >= 70) return { fill: S.barFillWarn, color: "var(--dsw-alias-state-warn-primary)" };
  return { fill: S.barFill, color: "var(--dsw-alias-label-secondary)" };
}

/**
 * One quota window as a compact sub-card. The headline and the bar point the
 * SAME way — both read "已用", from 0 to 100 — so a filled bar and a big
 * percentage can never contradict each other the way the old "remaining %"
 * headline over a usage bar did (100.0% remaining next to a full-looking bar
 * read as "drained"). The product semantics: a free-tier quota FILLS as you
 * spend (encouragement), and the warn/error tones ride that same usage
 * percentage (70 warn / 90 error). The only absolute figures left are the
 * used/limit caption under the bar.
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
  // The bare used percentage — no "已用" prefix. The prefix earned its keep
  // only while the headline could point the opposite way from the bar; now
  // headline and bar are the same number, and four sibling cards repeating
  // the same two characters is noise the reader pays on every glance.
  const headline = pct === null ? "—" : `${pct.toFixed(1)}%`;
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
    // The bar and the headline both carry the used percentage: one number,
    // one shape, no room for the two to disagree. `valueNow` is a NUMBER
    // (`Number(pct.toFixed(1))`), not the old `pct.toFixed(1)` string: an ARIA
    // value is a number, and the DOM's own coercion was hiding the type error.
    QuotaBar({
      track: S.bar,
      fill: tone.fill,
      widthPct: pct ?? 0,
      valueNow: pct === null ? 0 : Number(pct.toFixed(1)),
      label: `${label} ${tt("pool.used")} ${pct === null ? "—" : `${pct.toFixed(1)}%`}`
    }),
    // One quiet footer row: the only raw figures (used/limit) on the left,
    // the reset clock on the right. Both are supporting detail; keeping
    // them off the top row leaves the window label alone up there.
    h(
      "div",
      { style: S.quotaTop },
      // Same guard as the headline/bar above: an absent or zero `limit` is
      // UNKNOWN, not "0 / 0". Printing two numbers the platform never sent
      // (here, a fake used/limit ratio) contradicts the "—" headline and
      // the empty bar sitting directly above this row.
      h("span", { style: S.quotaUsed },
        limit > 0 ? `${tt("pool.used")} ${count(used)} / ${count(limit)}` : `—`),
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
 *
 * `catalogAvailable` (the snapshot's own flag) says whether the Host actually
 * reached `GET /v1/models` this poll. Without a catalog the split cannot be
 * made: `callableModels` IS the plan's claim list and `lockedModels` is empty
 * by construction — so the fold must label the list as UNVERIFIED coverage,
 * not claim every model is callable. `undefined` (an old caller that never
 * passes the prop) keeps the verified wording, matching the Host that always
 * states the flag.
 */
export function PoolCard({ pool, tt, catalogAvailable }: { pool: PoolData; tt: Tt; catalogAvailable?: boolean }): unknown {
  const callable = pool.callableModels || pool.modelIds || [];
  const locked = pool.lockedModels || [];
  const unverified = catalogAvailable === false;
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
                  h("span", { style: { ...S.muted, fontSize: 12, marginRight: 2 } }, `${unverified ? tt("pool.coverageUnverified") : tt("pool.callable")}:`),
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
 * more credit pools have hit zero AND some model has no other pool left to
 * draw on, the picker (host side) drops that model, so the reader sees it
 * vanish with no explanation. This line says WHY it vanished and WHEN it is
 * expected back — the earliest `resetAt` among the pools that actually block
 * something — so a zeroed pool reads as "recovers at HH:MM", never as a
 * mystery.
 *
 * Hook-free: it reads two plain snapshot fields — the `pools` array and, when
 * the Host publishes it, `llm.quotaBlockedModelIds` — so the render suite drives
 * the exact component the browser draws. Returns null when nothing is
 * exhausted (the common case stays silent), and also when the Host says the
 * drained pools block no model. It does not guess whether a zero came from a
 * true quota drain or a rate-limit blip — the panel never sees the 429 class —
 * it only reports the pool's own reset clock, which is the one honest recovery
 * signal available here.
 */
export function PoolExhaustionNotice({ pools, tt, blockedModelIds }: { pools?: PoolsData | null; tt: Tt; blockedModelIds?: string[] }): unknown {
  const list = Array.isArray(pools?.pools) ? pools.pools : [];
  // The banner is about MODELS, not meters. Under the all-pools rule a drained
  // pool can sit beside a live one that still covers every model it names — then
  // nothing is unselectable and a red banner would be a false alarm. The Host
  // already publishes the authoritative blocked set (`llm.quotaBlockedModelIds`);
  // when the snapshot carries it, it decides, and a drained pool that blocks
  // nothing neither raises the banner nor contributes its reset clock.
  //
  // `undefined` (an old Host, or a snapshot without the llm block) keeps the
  // pool-level reading — the only signal available — rather than silently
  // dropping the notice.
  const blocked = Array.isArray(blockedModelIds) ? new Set(blockedModelIds.map(String)) : null;
  let earliest = 0;
  let anyBlocked = false;
  for (const pool of list) {
    let drained = false;
    let poolEarliest = 0;
    for (const key of ["window5h", "window7d"] as const) {
      const win = pool?.[key] as QuotaWindow | undefined;
      // A missing/zero limit is UNKNOWN, not drained — the same rule the host
      // applies in `exhaustedModelIds`. Reporting exhaustion from a shape
      // drift would put a red banner over a pool the platform never quantified.
      if (win && Number(win.limit) > 0 && Number(win.remaining) <= 0) {
        drained = true;
        const reset = Number(win.resetAt) || 0;
        if (reset > 0 && (poolEarliest === 0 || reset < poolEarliest)) poolEarliest = reset;
      }
    }
    if (!drained) continue;
    if (blocked !== null) {
      const ids = Array.isArray(pool?.modelIds) ? pool.modelIds : [];
      if (!ids.some((id) => blocked.has(String(id)))) continue;
    }
    anyBlocked = true;
    if (poolEarliest > 0 && (earliest === 0 || poolEarliest < earliest)) earliest = poolEarliest;
  }
  if (!anyBlocked) return null;
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
      // A row below 1% of the top consumer draws NO bar: on a linear scale
      // relative to the top figure its bar is a 1px sliver — a shape that
      // occupies a row while carrying no readable information. The name and
      // the absolute number stay; the legend says small rows draw no bar.
      const drawsBar = pct >= 1;
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
        drawsBar
          ? QuotaBar({
              track: S.trendBar,
              fill: S.barFill,
              widthPct: pct,
              valueNow: Math.round(pct),
              label: `${row.model} ${Math.round(pct)}%`
            })
          : null
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

/**
 * Theme-token-only styles; a renamed token degrades looks, never rendering.
 */

/**
 * The plugin's brand color, spelled once. The shell may expose
 * `--sensenova-brand` (tabs under a branded theme); the hex fallback keeps the
 * accent identical in shells that do not. One literal, three consumers —
 * previously the fallback was re-spelled at each use, so a rebrand left a
 * third of the accent behind.
 */
const BRAND = "var(--sensenova-brand, #6C5CE7)";

/** The shared button skin; `rosterBulk` reuses it one step taller so the bulk
 *  buttons sit level with the 32px roster search box. */
const BUTTON = { height: 30, padding: "0 12px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", fontSize: 13, cursor: "pointer" };
export const S = {
  // The config card is embedded inside the Plugins page
  // (`plugins.bundle.config` slot). The host page provides outer margins,
  // so this root only needs flex layout and overflow clipping: the pinned
  // header stays flex-none and `scroll` (flex:1, min-height:0) takes the
  // overflow. Without this chain the card grows past its container and
  // the host silently truncates everything below the fold.
  page: { flex: "1 1 auto", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", color: "var(--dsw-alias-label-primary)", fontSize: 14, lineHeight: "22px" },
  headerBar: { flex: "none", background: "var(--dsw-alias-bg-base)", position: "relative", zIndex: 1 },
  header: { display: "flex", alignItems: "center", gap: 12, padding: "16px 0 12px" },
  scroll: { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" },
  content: { padding: "6px 0 56px" },
  // Two fixed perspectives — daily quota reading vs. one-off API wiring —
  // so the setup cards stop crowding the numbers the panel exists for.
  tabBar: { display: "flex", gap: 4, borderBottom: "1px solid var(--dsw-alias-border-l1)", marginBottom: 4 },
  // `outline: none` because the shell stamps its own white focus ring on
  // every clicked button — a second "active" language that fought this one:
  // the raccoon tab showed a clean underline while the two other tabs wore
  // a white box. The underline + weight below IS the active state, visible
  // without a ring; keyboard users keep the aria-selected semantics.
  tab: { appearance: "none", background: "none", border: "none", borderBottom: "2px solid transparent", padding: "8px 12px", fontSize: 13, color: "var(--dsw-alias-label-secondary)", cursor: "pointer", outline: "none" },
  tabActive: { color: "var(--dsw-alias-label-primary)", fontWeight: 600, borderBottom: `2px solid ${BRAND}` },
  title: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: "28px" },
  updated: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 },
  spacer: { flex: 1 },
  // The active tab's status cluster on the right of the pinned header: a
  // compact row (更新于 + chip + banner + 刷新) that stays put while the body
  // scrolls. `inline-flex` lets it shrink instead of pushing the title off.
  cluster: { display: "inline-flex", alignItems: "center", gap: 12, flexWrap: "wrap", justifyContent: "flex-end" },
  button: BUTTON,
  sectionTitle: { margin: "22px 0 10px", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-secondary)" },
  // Content sections are workbuddy-style collapsible cards: a bordered
  // card whose header is a full-width button (title + rotating chevron).
  // `PanelPage` starts both sections expanded; the reader can tuck one
  // away to focus on the other.
  sectionCard: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden", marginTop: 22 },
  sectionHead: { display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 16px", background: "none", border: "none", cursor: "pointer", textAlign: "left" },
  sectionHeadTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
  chevron: { display: "inline-flex", flex: "none", transition: "transform 0.15s ease", color: "var(--dsw-alias-label-secondary)" },
  chevronOpen: { transform: "rotate(180deg)" },
  sectionBody: { borderTop: "1px solid var(--dsw-alias-border-l1)", margin: "0 16px", padding: "12px 0 16px" },
  // Pool cards live in the responsive `poolsGrid` (gap owns the spacing),
  // so the card itself carries no bottom margin.
  card: { background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, padding: 16 },
  // Responsive deck of pool cards: each column is at least 320px and the
  // row reflows on narrow panels instead of overflowing.
  poolsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 12, alignItems: "start" },
  cardHead: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  poolName: { fontSize: 15, fontWeight: 600 },
  chip: { display: "inline-flex", alignItems: "center", height: 22, padding: "0 8px", borderRadius: 999, fontSize: 12, border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)" },
  // The grant balance is money the user can still spend, so it reads as a
  // metric, not a decoration: right-aligned tabular figures on the card's
  // own line, no chip frame. A pill here gave a headline number the same
  // weight as the static type label beside it.
  grantChip: { display: "inline-flex", alignItems: "center", fontSize: 13, color: "var(--dsw-alias-label-primary)", fontVariantNumeric: "tabular-nums" },
  // The two quota windows sit side by side as twin sub-cards, stacking
  // when the card gets narrower than ~2*170px (170 leaves room for the
  // longest "used x / limit" caption beside the headline figures).
  quotas: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))", gap: 10, marginTop: 14 },
  // The twin quota windows float on a darker surface (layer-2) rather than
  // a third nested border: the section card owns the outer frame and the
  // pool card owns the inner one, so the sub-window reads by background
  // step alone. A border here made three equal-weight rectangles inside
  // each other and flattened the hierarchy it was meant to express.
  quota: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0, padding: "12px 14px", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)" },
  // `flexWrap` because the reset stamp can grow to `MM-DD HH:mm`: in a narrow
  // twin column the label and the date no longer share a row, and the date is
  // the one part of the line that must never be clipped.
  quotaTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  quotaLabel: { fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-secondary)" },
  // The second upstream's balance is the same KIND of fact a quota headline is
  // — the number the user came to read — so it borrows the quota headline's
  // weight (18 / 650 / tabular) rather than the run-on meta line it used to
  // ride in. The Raccoon tab is a SEPARATE credential and data source, so it
  // owns its own card; that independence was never a licence to skip the type
  // scale, and a headline spelled in 12px secondary text is how a tab reads as
  // unfinished next to its siblings.
  statHeadline: { fontSize: 18, lineHeight: "22px", fontWeight: 650, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" },
  // A quiet secondary label for a headline's own caption line (the declared
  // split, the credential clocks). It is the same stop `quotaLabel` uses, so a
  // number and its caption read as one unit across both upstreams.
  statCaption: { fontSize: 11, lineHeight: "15px", color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
  // A headline figure that IS the alarm, not decoration: a balance at zero
  // must say so at the same weight the bar's error tone does. There is no warn
  // band here on purpose — the quota headline has one because a PERCENTAGE has
  // honest thresholds, while an absolute credit figure's normal magnitude is
  // not something this client is told, so any "low" cut would be a number
  // invented below the wire.
  statError: { color: "var(--dsw-alias-state-error-primary)" },
  // The gateway's split of the raccoon balance, as a deck of min-width cards:
  // the same responsive rule `poolsGrid` and `quotas` own (auto-fit, each
  // column at least N px, row reflows instead of overflowing). 110px is the
  // floor that fits the longest label ("奖励") beside its figure without
  // dropping it to a second line, and it stacks to 2×2 or a single column on a
  // narrow panel. One run-on `每日 600 · 奖励 8344 · 月度 0 · 充值 0` line read as
  // a comma list of four different facts with no place to separate them.
  statGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 110px), 1fr))", gap: 10, marginTop: 12 },
  // A grid card rides on the card's own step — the raccoon balance card gives
  // the deck the same layer-2 the quota twin gets, so a part reads by
  // background alone rather than as a fourth nested border.
  statCard: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0, padding: "10px 12px", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)" },
  // The part's figure is the point of the card; the name under it is the label,
  // so the big number leads and the label never competes with it.
  statValue: { fontSize: 16, fontWeight: 600, lineHeight: "20px", fontVariantNumeric: "tabular-nums" },
  quotaReset: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" },
  // The usage PERCENTAGE is the headline — the same number the bar below
  // draws, so the pair can never point in opposite directions. Tabular
  // figures keep it still while polling.
  quotaRemaining: { fontSize: 18, lineHeight: "22px", fontWeight: 650, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" },
  // used/limit is a single quiet caption under the bar (its own full row,
  // so the figures row never wraps on a narrow twin card).
  quotaUsed: { fontSize: 11, lineHeight: "15px", color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
  bar: { height: 6, borderRadius: 3, background: "var(--dsw-alias-bg-layer-1)", overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 3, background: BRAND },
  barFillWarn: { background: "var(--dsw-alias-state-warn-primary)" },
  barFillError: { background: "var(--dsw-alias-state-error-primary)" },
  // Secondary bookkeeping (grant expiry, model coverage) folds away so a
  // card's open state is just its name, the twin quotas, and nothing else.
  details: { marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--dsw-alias-border-l1)" },
  detailsSummary: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", cursor: "pointer", userSelect: "none" },
  detailsBody: { display: "flex", flexDirection: "column", gap: 10, marginTop: 10 },
  grant: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
  models: { display: "flex", flexWrap: "wrap", gap: 6 },
  modelTag: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 11, padding: "2px 6px", borderRadius: 6, background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l1)" },
  // The per-model consumption card: a label row over one horizontal-bar
  // row per model. The bar is relative to the LARGEST consumer — the
  // chart answers "which model is burning credits" — so the top model
  // fills the track and the rest shrink proportionally; the absolute
  // number stays right-aligned beside the model name.
  trendHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, paddingBottom: 6, borderBottom: "1px solid var(--dsw-alias-border-l1)" },
  trendHeadLabel: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", fontWeight: 500 },
  trendRow: { display: "flex", flexDirection: "column", gap: 8, padding: "10px 0", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
  trendRowHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, minWidth: 0 },
  trendModel: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  trendCredits: { fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  // The trend card sits on layer-1 like the pool cards, so its bar track
  // must be layer-2 (the quota bars invert this: layer-1 inside layer-2).
  trendBar: { height: 6, borderRadius: 3, background: "var(--dsw-alias-bg-layer-2)", overflow: "hidden" },
  // The legend under the bars: quiet secondary text, lifted a little off
  // the last row's divider so it reads as a caption, not another data row.
  trendLegend: { marginTop: 10, fontSize: 11, lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
  muted: { color: "var(--dsw-alias-label-secondary)" },
  error: { color: "var(--dsw-alias-state-error-primary)" },
  empty: { color: "var(--dsw-alias-label-secondary)", padding: "18px 0" },
  field: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 },
  fieldLabel: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
  input: {
    height: 32, padding: "0 10px", borderRadius: 8, fontSize: 13,
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-bg-layer-1)",
    color: "var(--dsw-alias-label-primary)"
  },
  /** Real shell tokens — replaces the color-mix hack that faked "on-primary". */
  primary: {
    height: 32, padding: "0 16px", borderRadius: 8, fontSize: 13, fontWeight: 500,
    border: "1px solid var(--dsw-alias-border-l2)",
    background: "var(--dsw-alias-button-primary-fill)",
    color: "var(--dsw-alias-label-primary-foreground)", cursor: "pointer"
  },
  primaryBusy: { opacity: 0.6, cursor: "default" },
  formError: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, margin: "10px 0 0" },
  formNote: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, margin: "10px 0 0" },
  // The model picker: a search box, then one flat row per model. The section
  // card owns the ONLY frame — a border per row was a card inside a card and
  // flattened the hierarchy (WorkBuddy lesson: inner elements never re-draw
  // the outer box). Badges read by background step alone, and a badge marks a
  // NOTABLE state only: "text only" is the default and earns nothing.
  rosterTools: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 },
  rosterCount: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums", marginLeft: "auto" },
  rosterBulk: { ...BUTTON, height: 32 },
  modelList: { display: "flex", flexDirection: "column", margin: 0, padding: 0, listStyle: "none" },
  // Head line over the parameter line: the divider separates rows without a
  // box, the padding keeps the whole row as the visual unit.
  modelRow: { display: "flex", flexDirection: "column", gap: 2, padding: "8px 4px", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
  modelRowHead: { display: "flex", alignItems: "center", gap: 8 },
  // The clickable label wrapping a row's checkbox/radio + name. It has to be
  // the FLEXIBLE child (`flex: 1 1 auto`) while the row itself is the column,
  // and it has to shrink (`minWidth: 0`) or the name's ellipsis never engages.
  // Three rows draw this (the Token Plan roster, the draw switch's auto row
  // and its per-model rows) and all three were repeating it inline verbatim;
  // `busy` only ever decides whether the pointer still promises a click.
  modelRowLabel: { display: "flex", alignItems: "center", gap: 10, flex: "1 1 auto", minWidth: 0 },
  modelRowOff: { opacity: 0.55 },
  // The "register an account / open the site" link each card ends with. All
  // three cards drew it inline, identically; a change to the underline or the
  // offset had to be made three times and two of them were always forgotten.
  externalLink: { color: "var(--dsw-alias-label-primary)", fontSize: 12, marginTop: 10, display: "inline-block", textDecoration: "underline", cursor: "pointer" },
  modelCheck: { flex: "none", width: 15, height: 15, cursor: "pointer", accentColor: BRAND, margin: 0 },
  // `0 1 auto` (not `1 1 auto`): the name hugs the rate chip instead of
  // stretching to the right edge; the label shrinks, so ellipsis still works.
  modelName: { flex: "0 1 auto", minWidth: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  modelRate: { flex: "none", fontSize: 11, color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums" },
  modelBadge: { flex: "none", fontSize: 11, padding: "1px 7px", borderRadius: 999, background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-secondary)" },
  // The WorkBuddy-style parameter line: only per-model facts — the figures the
  // platform declares (window, output ceiling) and the levels the selector
  // offers. Provider-wide constants live in the header once, never here.
  // Indented under the model name (15px checkbox + 10px gap = 25).
  modelMeta: { paddingLeft: 25, fontSize: 11, lineHeight: "15px", color: "var(--dsw-alias-label-secondary)" },
  rosterFoot: { display: "flex", gap: 8, alignItems: "center", marginTop: 10 },
  // A roster's own frame — one step INSIDE the section card. The rule above
  // still holds (rows draw no box of their own; the divider separates them),
  // but "one frame per level" is about not repeating the SAME frame, not about
  // leaving a whole list adrift: the Raccoon tab pairs its roster with a login
  // block that already wears a card, and an unframed list beside a framed one
  // read as an unfinished half rather than as a deliberate hierarchy.
  modelPanel: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 12, background: "var(--dsw-alias-bg-layer-1)", padding: "12px 14px" },
  // === the composer pill: a different surface, borrowed metrics ============
  // Every token above draws INSIDE this plugin's own card — 13px type, framed
  // buttons, 8–12px radii, brand ink. The pill (ROADMAP §6.3) is a guest in
  // the HOST's composer toolbar, where its neighbours are the model picker and
  // the attach/mode ghost controls: 28px tall, unframed, 12px, transparent.
  // It therefore borrows the TOOLBAR's scale, not the card's — a card-sized pill
  // in that row reads as a foreign widget at a glance, which is exactly what
  // the 2026-10-15 report was. This plugin injects no stylesheet (see
  // `toggle-switch.ts`), so these are inline styles by the only route available.
  //
  // `background: "none"` + `borderStyle: "none"` rather than `border: 0`: the
  // UA button frame is a real border on some engines and a `border-image` on
  // others, and the longhand removes it in all of them (jsdom also mis-parses
  // the `border` shorthand). `appearance: "none"` drops the rest of the UA
  // skin so the shell's own focus treatment is what shows.
  pillTrigger: {
    appearance: "none", display: "inline-flex", alignItems: "center", gap: 5,
    height: 28, padding: "0 6px", flexShrink: 0,
    // UA chrome has to be taken off explicitly: this element is a `<button>`
    // for its tooltip and accessible name, and a browser paints that as a
    // filled, bordered, rounded box. `background: "none"` + `borderStyle:
    // "none"` (not `border: 0`, which jsdom mis-parses and some engines treat
    // as a border-image) leaves nothing behind.
    background: "none", borderStyle: "none",
    color: "inherit", fontFamily: "inherit", fontSize: 12, lineHeight: "20px",
    whiteSpace: "nowrap", userSelect: "none",
    // `cursor: "pointer"` because the pill now ACTS: it toggles its quota panel.
    // The focus ring is deliberately NOT suppressed — `outline` is left alone
    // above, so the UA's own ring shows when a keyboard user tabs onto the
    // trigger, and with no stylesheet there is no other way to give it one.
    cursor: "pointer"
  },
  // The tier's whole job is the 7px dot (opencode-go's shape too): the reading
  // keeps the host's label ink so a routine 1% never shouts. `flexShrink: 0`
  // because the trigger's `overflow: hidden` would otherwise flatten it into
  // an ellipse the moment the row gets narrow.
  pillDot: { width: 7, height: 7, borderRadius: 999, flexShrink: 0 },
  // Tabular figures: the snapshot polls on a cadence, and proportional digits
  // make the whole toolbar twitch every few seconds as `9%` becomes `10%`.
  pillReading: { fontVariantNumeric: "tabular-nums" },
  // The plan name — 「商汤 · 」/「浣熊 · 」— is a LABEL, so it takes the host's
  // secondary ink while the reading keeps the primary: the row reads
  // "which plan, at what cost", and the eye should land on the number first.
  // opencode-go tints its `Go · ` the same way, and its `.brand` is the first
  // thing its narrow-row tier drops — this one has no container query to do
  // that, so the prefix stays at every width (it is the pill's shortest and
  // most load-bearing fragment).
  pillPlan: { color: "var(--dsw-alias-label-secondary)", flexShrink: 0 },
  // The stale mark is a footnote, not a reading — the dot and the numbers
  // already say the data is old; this only says WHY the numbers may lag.
  pillStale: { color: "var(--dsw-alias-label-tertiary)" },
  // Tier ink from the shell's own state tokens (`--dsw-alias-state-*`), not
  // plugin hexes: a retheme or a light/dark switch recolours the pill with the
  // rest of the window. The hexes are fallbacks for a shell that defines
  // neither, and deliberately sit beside the upstream opencode-go picks.
  pillTierOk: "var(--dsw-alias-state-success-primary, #22c55e)",
  pillTierWarn: "var(--dsw-alias-state-warn-primary, #eab308)",
  pillTierExhausted: "var(--dsw-alias-state-error-primary, #ef4444)",
  // "Unknown" is not a state — it is the ABSENCE of a reading, so it borrows
  // the tertiary label ink rather than inventing a fourth state colour.
  pillTierUnknown: "var(--dsw-alias-label-tertiary, #9ca3af)",
  // A window that is actually spent is an alarm, not a meter, so it is the one
  // tier that tints the reading as well as the dot — same ruling as
  // `statError` above: an exhausted quota must not read as a calm 100%.
  pillTierExhaustedText: { color: "var(--dsw-alias-state-error-primary)" },
  // === the pill's expand panel: the SAME guest, one size up ================
  // The 28px pill can carry a reading but not the figures behind it, so the
  // details live in a popover over the composer. It stays a guest of the HOST's
  // chrome rather than an import of this plugin's card: host tokens, host radii
  // (8–10px, not the card's 12), and a 12px type scale that matches the pill's
  // own rather than the card's 13. What it borrows from `cards.ts` is only the
  // IDEA of a window row (label + bar + used/limit + reset); it deliberately
  // does NOT borrow that card's 70/90 thresholds — two tiers disagreeing in one
  // screenshot is worse than either.
  //
  // `bottom: "100%"` rather than `top: "100%"`: the composer row sits at the
  // BOTTOM of the input box, so an upward popover never covers the draft the
  // user is typing (and cannot be clipped by the input's own scroll). The host's
  // `.uV2eYG_row` sets no `overflow`, so the absolutely-positioned child escapes
  // it — verified against the shipped host CSS, which is why this needs no
  // portal and no z-index fight with the input.
  pillPopover: {
    position: "absolute", bottom: "100%", right: 0, zIndex: 100,
    // A hairline border and an opaque layer: the popover floats OVER the
    // composer's own surface, so it cannot be translucent.
    border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 10,
    background: "var(--dsw-alias-bg-layer-1)",
    boxShadow: "0 6px 24px rgba(0, 0, 0, 0.18)",
    // `min(320px, …)` because the popover is right-anchored in the composer and
    // a narrow window would otherwise push it off-screen on the left; the
    // `calc` leaves a 16px gutter against the viewport edge.
    width: "min(320px, calc(100vw - 32px))",
    padding: "10px 12px", marginBottom: 8,
    textAlign: "left", color: "var(--dsw-alias-label-primary)",
    fontSize: 12, lineHeight: "18px", fontFamily: "inherit",
    boxSizing: "border-box"
  },
  // The trigger becomes the popover's anchor, so it is the one element in the
  // toolbar that establishes a containing block. Without it the panel would be
  // positioned against the whole composer row and pinned to ITS right edge.
  pillPopoverAnchor: { position: "relative", display: "inline-flex" },
  pillPopoverHead: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 },
  pillPopoverTitle: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
  pillPopoverPool: { color: "var(--dsw-alias-label-secondary)" },
  pillPopoverStale: { color: "var(--dsw-alias-label-tertiary)" },
  // One window per row: label + bar on the first line, the raw figures and the
  // reset clock on the second. The figures are the reason the panel exists — the
  // pill's percentages are rounded, and "1%" cannot answer "can I still run a
  // long context request", which is the question that opens this panel.
  pillPopoverRow: { padding: "6px 0" },
  pillPopoverRowLine: { display: "flex", alignItems: "baseline", gap: 8 },
  pillPopoverLabel: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
  pillPopoverFigure: { marginLeft: "auto", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary)" },
  pillPopoverBar: { height: 4, borderRadius: 2, margin: "2px 0 4px", overflow: "hidden", background: "var(--dsw-alias-bg-layer-2)" },
  pillPopoverFill: { height: "100%", borderRadius: 2 },
  pillPopoverFoot: { display: "flex", alignItems: "baseline", gap: 8, color: "var(--dsw-alias-label-tertiary)" },
  pillPopoverReset: { marginLeft: "auto", fontVariantNumeric: "tabular-nums" },
  // The Raccoon branch's single "window" is a stock, not a window: one figure,
  // no bar, and the signed-in/signed-out fact beside it. Drawn as a row anyway
  // so the two branches share one panel frame and one set of metrics.
  pillPopoverNote: { marginTop: 8, color: "var(--dsw-alias-label-tertiary)" }
};
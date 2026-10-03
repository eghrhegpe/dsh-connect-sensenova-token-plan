/**
 * The `plugins.bundle.config` card: polling, the decision gate, and the whole
 * panel layout — rendered inside the Plugins page, always expanded (there is
 * no sidebar entry and no standalone `main` page).
 */
import {
  AccountForm
} from "./account-form.ts";
import { ApiKeyForm, ProviderForm } from "./api-key-form.ts";
import { PANEL_ID } from "./const.ts";
import { clock, format } from "./format.ts";
import { FORM_EXCLUDED_CODES, GUIDANCE_BY_CODE, viewOf } from "./snapshot.ts";
import { useSnapshotPolling } from "./use-snapshot-polling.ts";
import { h, useCallback, useEffect, useState } from "./runtime.ts";
import type { Tt } from "./runtime.ts";
import type { PoolData, VisionModelData } from "./wire.ts";
import { S } from "./styles.ts";
import { PoolCard, PoolExhaustionNotice, SectionCard, TrendTable } from "./cards.ts";
import { DrawSwitch } from "./provider-controls.ts";
import { RaccoonTab } from "./raccoon-tab.ts";

/**
 * Quota-unavailable codes the user fixes by signing in.
 *
 * The Host answers `ok:true` with an in-body `quotaError` when the console is
 * unreachable; for these codes the quota tab leads with the account form
 * instead of empty sections. The set is DERIVED — every wire code the panel
 * has a guidance line for, minus the ones no login can fix
 * (`FORM_EXCLUDED_CODES`: `config_error` stays a notice, never a form).
 *
 * Derived rather than listed because the hand-written version WAS "the
 * complement of FORM_EXCLUDED_CODES" in a comment only: a code the Host adds
 * later would have kept its guidance line yet silently landed in the
 * "empty sections, no form" branch — the one outcome a reader cannot act on.
 */
const LOGIN_BLOCKED_QUOTA_CODES: ReadonlySet<string> = new Set(
  Object.keys(GUIDANCE_BY_CODE).filter((code) => !FORM_EXCLUDED_CODES.has(code))
);

/**
 * The three panel perspectives, as ONE fact.
 *
 * `PanelPage`'s own state, the `HeaderStatus` props type and its JSDoc
 * `@param` each used to spell the union out by hand, so adding a fourth tab
 * meant three edits — and the JSDoc one would not fail the build if missed.
 * The tab bar and the header both branch on this id, so it is the one id
 * worth naming. The three tabs stay fixed: quota (the Token Plan console),
 * api (key + provider + draw wiring) and raccoon (the SECOND upstream).
 */
export type TabId = "quota" | "api" | "raccoon";

export function PanelPage({ onClose, tt, localeSubscribe }: {
  onClose?: () => void;
  tt: Tt;
  localeSubscribe?: unknown;
}): unknown {
  // Polling state lives in the hook: `data`/`error`/`loadedOnce`/`updatedAt`/
  // `cadenceMs`/`load` are returned there (see ./use-snapshot-polling.ts).
  const { data, error, loadedOnce, updatedAt, load } = useSnapshotPolling();
  const [, setLocaleRevision] = useState(0);
  // The content sections start expanded — the panel opens showing
  // everything — while the account editor starts collapsed: it is a
  // maintenance action, one click away. Remounting on a page switch
  // restores these defaults.
  //
  // The API tab's two feature cards (provider / draw) start OPEN too: they
  // are the reason someone visits that tab, and a collapsed card hiding its
  // own switch reads as "this does nothing". Only the API key editor stays
  // closed — it holds a secret field, and it is a prerequisite the two
  // cards above point at rather than the thing being configured.
  const [openSections, setOpenSections] = useState({ pools: true, trend: true, account: false, provider: true, draw: true, llm: false, raccoon: true });
  // Three fixed perspectives: "quota" is the daily reading (pools, trend,
  // account), "api" is the Token Plan wiring (key, provider push, draw), and
  // "raccoon" is the SECOND upstream provider (ROADMAP §6.1) — an independent
  // credential + switch that shares no pool semantics with the first two. The
  // tab bar renders on every frame — loading, error and setup states live
  // INSIDE the quota tab, so the api and raccoon tabs (both independent of
  // the Token Plan console) stay reachable before a snapshot lands.
  const [activeTab, setActiveTab] = useState<TabId>("quota");
  // The pinned header is a SHELL: it shows the plugin identity (the card hosts
  // three tabs, so it is never a quota-only label) and, on its right, the
  // status cluster of the ACTIVE tab. The quota and api tabs read the Token
  // Plan snapshot, so they share `updatedAt` + `load`; the raccoon tab is a
  // SECOND upstream with its own poll, and reports its own freshness here
  // (it writes `updatedAt`/`error`/`onRefresh` on mount and on every
  // successful GET). A state, not a ref, so the header re-renders live when
  // the raccoon tab refreshes. When the tab is not mounted the value is null
  // and the header shows nothing raccoon-specific — the chip below is
  // quota-only and must never bleed into the api/raccoon rows (pinned by
  // render.test.mjs group H2's reverse-pin).
  const [raccoonStatus, setRaccoonStatus] = useState<{ updatedAt: number; error: string | null; onRefresh: () => void } | null>(null);

  // The Host half registers the dictionaries, but a runtime language switch
  // only reaches this page through the locale face's subscribe: without it a
  // mounted panel keeps whatever strings it happened to render first.
  useEffect(() => {
    if (typeof localeSubscribe !== "function") return undefined;
    return (localeSubscribe as (fn: () => void) => () => void)(() => setLocaleRevision((revision) => revision + 1));
  }, [localeSubscribe]);

  const toggleSection = useCallback((key: string) => {
    setOpenSections((current) => ({ ...current, [key]: !current[key as keyof typeof current] }));
  }, []);

  const pools = data?.pools;
  const trend = data?.trend;
  // The decision is `viewOf`'s (module scope): the Node-side tests invoke
  // this exact function, so there is no second copy that could drift.
  const { failure, auth, needsSetup, guidance, shapeWarnings } = viewOf(data, error, tt);
  // The one gate that turns `panel.loading` from dead code into the real
  // first frame: until an attempt has concluded, nothing may claim the
  // user needs setup.
  const showSetupForm = needsSetup && loadedOnce;
  const authChip = auth === null
    ? null
    : auth.error || !auth.configured
      // A "needs login" chip with a blank tooltip is a dead end: the reader
      // sees "something is wrong" but cannot say what. When the Host gives no
      // reason (a fresh install, nothing configured yet), the tooltip is the
      // guidance line — the same one the setup form would show — so the chip
      // and the form never disagree about why.
      ? h("span", { style: S.chip, title: auth.error || guidance || "" }, tt("auth.needsLogin"))
      : h("span", { style: S.chip }, tt("auth.selfRenew"));
  // The right-hand cluster of the pinned header, owned by the ACTIVE tab.
  // Extracted into a hook-free {@link HeaderStatus} so the render suite can
  // mount it directly and pin that quota-only copy (the renewal chip, the
  // stale-data banner) never reaches the api/raccoon tabs.
  const headerStatus = h(HeaderStatus, {
    activeTab,
    hasData: data !== null,
    updatedAt,
    failure,
    authChip,
    raccoonStatus,
    tt,
    onRefreshQuota: () => void load()
  });
  const authManage = auth !== null;
  // The quota block can be empty with the console unreachable (no account, a
  // rejected token, the console down): the Host answers `ok:true` with an
  // in-body `quotaError`, keyed by the same taxonomy the failure path uses.
  // The quota tab says why and offers the fix; the api and raccoon tabs are
  // INDEPENDENT of the console and stay fully usable.
  const quotaError = data?.quotaError ?? null;
  const quotaGuidanceKey = quotaError?.code ? (GUIDANCE_BY_CODE[String(quotaError.code)] ?? null) : null;
  const quotaNotice = quotaError === null
    ? null
    : quotaGuidanceKey !== null
      ? h("div", { style: S.formNote, role: "status" }, tt(quotaGuidanceKey))
      : typeof quotaError.message === "string" && quotaError.message !== ""
        ? h("div", { style: S.formNote, role: "status" }, quotaError.message)
        : null;
  // A quota gap a sign-in fixes leads with the account form, not with empty
  // quota sections.
  const quotaLoginBlocked = quotaError !== null && LOGIN_BLOCKED_QUOTA_CODES.has(String(quotaError.code ?? ""));
  // The tab bar is UNCONDITIONAL. It used to render only after a snapshot
  // landed — the loading, error and setup views were full-screen and hid the
  // tabs, which locked out every user who wanted the API or Raccoon tab (both
  // independent of the Token Plan console) before connecting the console.
  // Each tab now owns its own empty state instead.
  // Each tab renders from its own plain function (not a nested-ternary tree)
  // so a change to one tab never forces the reader to expand all three at
  // once. All three close over the locals computed above; none holds state.

  // The quota tab owns the loading / error / setup states (no snapshot yet)
  // and, once a snapshot lands, the pools + trend sections. The shape-drift
  // banner stays in the tab bar's sibling below, not here.
  const quotaBody = () => {
    if (data === null) {
      return showSetupForm
        ? h(AccountForm, { auth, onDone: () => void load(), tt, snapshotAt: updatedAt })
        : h(
            "div",
            { style: S.empty },
            failure === null
              ? tt("panel.loading")
              : h(
                  "div",
                  null,
                  h("div", { role: "alert" }, guidance ?? format(tt("panel.error"), { error: failure.message }))
                )
          );
    }
    return h(
      "div",
      null,
      quotaNotice,
      quotaLoginBlocked
        ? h(AccountForm, { auth: data?.auth ?? null, onDone: () => void load(), tt, snapshotAt: updatedAt })
        : h(
            "div",
            null,
            // Both content sections are collapsible card headers, auto-expanded
            // by default: the panel opens showing everything, and the reader
            // can tuck the chart or the pools away to focus on the other.
            h(
              SectionCard,
              { title: tt("section.pools"), open: openSections.pools, onToggle: () => toggleSection("pools"), tt },
              pools?.plan?.name
                ? h("div", { style: { ...S.muted, fontSize: 12, marginBottom: 10 } }, pools.plan.name)
                : null,
              h(PoolExhaustionNotice, { pools, tt }),
              h(
                "div",
                { style: S.poolsGrid },
                (pools?.pools || []).map((pool: PoolData) => h(PoolCard, { key: pool.id, pool, tt }))
              ),
              Array.isArray(data.uncountedModels) && data.uncountedModels.length > 0
                ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: -4, marginBottom: 4 } },
                    format(tt("pool.uncounted"), { models: data.uncountedModels.join(" · ") }))
                : null,
              // Step one of the vision plan: which of THIS key's models take
              // image input. Only shown when the Host actually had a catalog to
              // ask (no API key → the field is absent → no claim either way).
              Array.isArray(data.visionModels) && data.visionModels.length > 0
                ? h("div", { style: { ...S.muted, fontSize: 12, marginTop: -4, marginBottom: 4 } },
                    format(tt("pool.vision"), {
                      models: data.visionModels.map((entry: VisionModelData) => entry.id).join(" · ") + (data.visionModels.every((entry: VisionModelData) => entry.source === "name") ? tt("pool.visionInferred") : "")
                    }))
                : null
            ),
            h(
              SectionCard,
              { title: format(tt("section.trend"), { hours: trend?.hours ?? 24 }), open: openSections.trend, onToggle: () => toggleSection("trend"), tt },
              h(TrendTable, { trend, tt })
            ),
            // The cache age is quoted from the snapshot, not written down here:
            // a note that says 60 while the Host caches for 300 is a lie the
            // reader has no way to catch.
            h("div", { style: S.note }, format(tt("note"), { cache: data?.cacheSeconds ?? 60 })),
            // The login state stays visible while everything works — and
            // while nothing does: a collapsed section (unlike the content
            // sections) keeps the editor one click away without cluttering
            // the quota view, but the header itself is always on screen.
            // Suppressed when the quota gap is login-fixable: the form at
            // the top of the tab already carries the editor.
            authManage
              ? h(
                  SectionCard,
                  { title: tt("auth.title"), open: openSections.account, onToggle: () => toggleSection("account"), tt },
                  h(AccountForm, { auth, onDone: () => void load(), tt, bare: true, snapshotAt: updatedAt })
                )
              : null
          )
    );
  };

  // The API tab: one SectionCard per concern, ordered by what the reader came
  // for, not dependency order. The two feature cards lead (and open); the key
  // editor trails as the prerequisite they point back at.
  const apiBody = () =>
    h(
      "div",
      null,
      h(
        SectionCard,
        { title: tt("llm.providerTitle"), open: openSections.provider, onToggle: () => toggleSection("provider"), tt },
        h(ProviderForm, { llm: data?.llm ?? null, onDone: () => void load(), tt })
      ),
      h(
        SectionCard,
        { title: tt("draw.title"), open: openSections.draw, onToggle: () => toggleSection("draw"), tt },
        h(DrawSwitch, { llm: data?.llm ?? null, onDone: () => void load(), tt })
      ),
      h(
        SectionCard,
        { title: tt("llm.title"), open: openSections.llm, onToggle: () => toggleSection("llm"), tt },
        h(ApiKeyForm, { llm: data?.llm ?? null, onDone: () => void load(), tt, bare: true })
      )
    );

  // The Raccoon tab (ROADMAP §6.1) is a SECOND upstream with its own
  // credential and data source (the /raccoon route this tab polls) — it never
  // touches the Token Plan snapshot, so it renders from its own card. The
  // header's chevron folds it like every other section: it used to be wired to
  // a no-op, so the one control that promised to collapse this tab did nothing
  // when clicked — a fake affordance, which reads as "broken", not "expanded".
  const raccoonBody = () =>
    h(
      "div",
      { style: { marginTop: 22 } },
      h(
        SectionCard,
        { title: tt("raccoon.title"), open: openSections.raccoon, onToggle: () => toggleSection("raccoon"), tt },
        h(RaccoonTab, { tt, onReportStatus: setRaccoonStatus })
      )
    );

  const body = h(
    "div",
    null,
    h(
      "div",
      { style: S.tabBar, role: "tablist" },
      h("button", { type: "button", role: "tab", "aria-selected": activeTab === "quota", style: { ...S.tab, ...(activeTab === "quota" ? S.tabActive : {}) }, onClick: () => setActiveTab("quota") }, tt("tab.quota")),
      h("button", { type: "button", role: "tab", "aria-selected": activeTab === "api", style: { ...S.tab, ...(activeTab === "api" ? S.tabActive : {}) }, onClick: () => setActiveTab("api") }, tt("tab.api")),
      h("button", { type: "button", role: "tab", "aria-selected": activeTab === "raccoon", style: { ...S.tab, ...(activeTab === "raccoon" ? S.tabActive : {}) }, onClick: () => setActiveTab("raccoon") }, tt("tab.raccoon"))
    ),
    // The shape-drift banner belongs with the daily reading: it warns
    // about the numbers themselves, not about the wiring below.
    activeTab === "quota" && data && shapeWarnings.length > 0
      ? h("div", { style: S.formError, role: "status" },
          format(tt("panel.shapeDrift"), {
            detail: shapeWarnings.map((entry) => `${tt("shape.api")} ${entry.api} ${tt("shape.missing")} ${entry.missing}`).join("; ")
          }))
      : null,
    activeTab === "quota" ? quotaBody() : activeTab === "raccoon" ? raccoonBody() : apiBody()
  );


  return h(
    "div",
    { style: S.page, "data-dsh-plugin": PANEL_ID },
    // The bar is pinned (flex:none); everything below scrolls inside
    // `S.scroll` instead of being clipped by the shell's center column. The
    // bar is a SHELL: a plugin-identity title on the left, and the ACTIVE
    // tab's own status cluster on the right — never a quota-only label that
    // pretends to be the global title.
    h(
      "div",
      { style: S.headerBar },
      h(
        "div",
        { style: S.header },
        h("h1", { style: S.title }, tt("panel.title")),
        h("span", { style: S.spacer }),
        // The right side is the active tab's cluster (更新于 / chip / banner /
        // 刷新), built above so each tab owns only its own facts.
        headerStatus,
        onClose ? h("button", { type: "button", style: S.button, onClick: () => onClose() }, tt("panel.back")) : null
      )
    ),
    h(
      "div",
      { style: S.scroll },
      h("div", { style: S.content }, body)
    )
  );
}

/**
 * The right-hand cluster of the pinned header.
 *
 * The header is a SHELL: a plugin-identity title on the left, and this — the
 * ACTIVE tab's own status — on the right. Quota and api read the same Token
 * Plan snapshot, so both show its `updatedAt` and share the quota refresher;
 * only quota carries the renewal chip and the stale-data banner, because those
 * describe the console login token that the api (API key) and raccoon (a
 * separate gateway credential) tabs have nothing to say about. The raccoon tab
 * reports its OWN freshness + refresher through `raccoonStatus`, so the header
 * "刷新" finally refreshes it too (before, `load()` only re-fetched the quota
 * snapshot and the raccoon poll was separate — the button silently skipped the
 * third tab). Until the raccoon tab mounts, `raccoonStatus` is null and
 * nothing raccoon-specific renders.
 *
 * Hook-free on purpose: the render suite mounts it directly to pin the
 * invariant that quota-only copy (renewal chip, stale-data banner) never
 * appears for the api/raccoon tabs.
 *
 * Prop types are declared once, by the TypeScript annotation on the function
 * — an earlier `@param {TabId} props.activeTab` style JSDoc spelled the same
 * types a second time, where a change to one side could not fail the build.
 */
export function HeaderStatus({
  activeTab,
  hasData,
  updatedAt,
  failure,
  authChip,
  raccoonStatus,
  tt,
  onRefreshQuota
}: {
  activeTab: TabId;
  hasData: boolean;
  updatedAt: number;
  failure: { message: string } | null;
  authChip: unknown;
  raccoonStatus: { updatedAt: number; error: string | null; onRefresh: () => void } | null;
  tt: Tt;
  onRefreshQuota: () => void;
}): unknown {
  // The raccoon tab owns a separate upstream; its cluster is whatever the tab
  // last reported (its own updatedAt + its own refresh). Nothing quota-specific
  // may appear here.
  if (activeTab === "raccoon") {
    const status = raccoonStatus;
    if (status === null) return null;
    return h(
      "span",
      { style: S.cluster },
      status.updatedAt > 0
        ? h("span", { style: S.updated }, format(tt("panel.updated"), { time: clock(status.updatedAt / 1000) }))
        : null,
      // The raccoon upstream's own failure. It used to be reported by the tab
      // and rendered by NOBODY, so an unreachable Host left the last timestamp
      // and the last roster on screen with no hint that the read had failed.
      // `updatedAt` deliberately keeps its last good value above, so the pair
      // reads as "stale, and here is why" rather than as fresh data.
      status.error !== null
        ? h("span", { style: S.error, role: "status", title: status.error }, format(tt("panel.error"), { error: status.error }))
        : null,
      h("button", { type: "button", style: S.button, onClick: () => status.onRefresh() }, tt("panel.refresh"))
    );
  }
  // Quota and api share the Token Plan snapshot's `updatedAt` and refresher.
  return h(
    "span",
    { style: S.cluster },
    hasData ? h("span", { style: S.updated }, format(tt("panel.updated"), { time: clock(updatedAt / 1000) })) : null,
    // The renewal chip is quota-ONLY: gated on `activeTab === "quota"`, never on
    // `hasData` alone, so the api tab (an API key, not a console grant) and the
    // raccoon tab (a separate credential) never show "令牌自动续期中".
    activeTab === "quota" ? authChip : null,
    // The stale-data banner is quota-specific too: the console outage that
    // produces it is unrelated to the api/raccoon tabs.
    activeTab === "quota" && failure !== null && hasData
      ? h("span", { style: S.error, role: "status", title: failure.message }, format(tt("panel.error"), { error: failure.message }))
      : null,
    h("button", { type: "button", style: S.button, onClick: () => onRefreshQuota() }, tt("panel.refresh"))
  );
}
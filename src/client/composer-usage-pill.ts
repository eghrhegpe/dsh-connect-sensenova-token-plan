/**
 * 对话框用量胶囊（ROADMAP §6.3）—— 输入框工具栏 `conversation.input.right` 座席。
 *
 * 形态跟随 opencode-go 的「用量胶囊」，不跟随 workbuddy 的「纯文本余额读数」：
 * 商汤 Token Plan 是 5h / 周 滚动额度池，**没有**单一余额可显示，所以胶囊画的是
 * 「已用百分比」+ 颜色分级（绿 <80% / 黄 ≥80% / 红 耗尽 / 灰 未知）；重置时间放
 * tooltip，不进胶囊正文——正文密度与 opencode-go 对齐（它也是只在展开面板里给
 * 重置时间，pill 本体只有两档百分比 + 标记）。
 *
 * **套餐名前缀**：正文第一段是**当前 provider 的套餐名**
 * （`商汤 · ` / `浣熊 · `，英文 UI 走 `SenseNova · ` / `Raccoon · `），照
 * opencode-go 的 `Go · `。这不是装饰：会话里可以同时有 Token Plan 与小浣熊的模型，
 * 胶囊不写明是哪套额度，光看「5 小时 1%」读者无法判断在烧谁的配额。前缀跟着
 * **数据源**走而不是跟着某段文字走——它就是「下面这些数字属于哪套额度」的答案。
 *
 * **两条数据源，互不污染**（同一裁定，写在这里免得下一个人把它并回去）：
 *   - Token Plan 档读 `/snapshot` 的 pools（5h / 周 百分比）；
 *   - 小浣熊档读 `/raccoon` 的 `balance`（积分余额）。
 * 两者的额度宇宙不同（小浣熊网关不声明日/月上限），所以**小浣熊不借 Token Plan
 * 的池**（早前的回落逻辑会把它错画成 Token Plan 的窗口），反过来 Token Plan 档
 * 也不在没有池时拿余额顶替。哪一档挂载由 provider 在组件边界决定，见下。
 *
 * **样式**：本组件不注入样式表（见 `toggle-switch.ts` 的同名裁定），所以胶囊的
 * 全部外观是 inline style，取自 `styles.ts` 的 `S.pill*` 一族——那一族按**宿主
 * 工具栏**的尺度定（28px 高 / 12px 字 / 无框 / 透明底），不按本插件卡片自己的
 * 13px 框按钮尺度。2026-10-15 用户报「样式确实不太一样」，根因是当时只有
 * `className`（无样式表 ⇒ 无效）+ 四个写死 hex，于是渲染成浏览器默认按钮；
 * 现在分级色走宿主 token（`--dsw-alias-state-*`），换肤 / 明暗随之走。
 * `className` 保留为测试选择器（`render-dom.test.mjs` 查询它）。
 *
 * **三层结构**（本组件不「切模型即消失」的关键）：归属/档位门控发生在**组件边界**
 * —— 外层 `ComposerUsagePill` 只决定内层 `TokenPlanPill` / `RaccoonPill` 谁的挂/摘，
 * 轮询 hook 全在内层调用，hook 顺序恒定。若在同一组件里先调 hook 再按门控早退
 * （`return null`），切模型会踩 Rules of Hooks 的红线（「Rendered fewer hooks
 * than expected」）：组件被 React 甩出树，切回归属模型也起不来。opencode-go 的
 * `UsagePill` / `ActiveUsage` 就是这个形状（它的 `UsagePill` 也是先选 provider
 * 再挑内层组件）。
 *
 * 归属门控走 `useProjection("modelSelection")`（`next` 优先于 `lastUsed`），与
 * workbuddy 的 gate 逐字一致。该 prop 是 session 作用域槽位**严格必需**的物化
 * prop（见 `test/composer-slot-gate.mjs` 断言 D：session 作用域 `optional=false`，
 * 缺源抛 `SlotAssemblyError`），这里的 noop 兜底只是让 Node 侧单测能脱离 Host 注入。
 *
 * 两条复用现有轮询，不新开接口：`/snapshot` 走 `useSnapshotPolling`，`/raccoon` 走
 * 本文件的 `useRaccoonBalance`（Host 侧 5 分钟缓存，`RACCOON_BALANCE_TTL_MS`）。
 * 两者共用同一个轮询内核 `use-remote-read.ts`——一代守卫 / 取消 / 失败退避 /
 * 卸载拆除只有一份实现；这里原本的手抄副本被 `duplication-gate.mjs` 拒绝（而且
 * 抄出来就已经漂了：401 只回裸状态码，没有 `errorOfStatus` 的措辞）。
 * 失败降级：保留上次数值、超过一个 cadence 即标「上次数据」，不抛异常（照 §5
 * 不变量 2 的纪律：面板照常用、该模块缺席）。非归属 provider 的会话内层根本不
 * 挂载 —— 不跑任何 fetch 循环。
 *
 * 池归组：额度是**池级**的（通用池 / Flash-Lite 专属池，每个 pool 带 `modelIds`），
 * 按当前模型 id 匹配所属池；Token Plan 模型匹配不到就回落到第一个池，不发明
 * 「余额」。回落池**不保证**是通用池——控制台把通用池与专属池作兄弟返回、顺序由
 * 平台定，所以面板写池的类型（`poolType`）而不写死「通用池」。
 *
 * 返赠余额（`grantBalance`）不进**胶囊**：它是独立口径（30 天有效、不占滚动窗口），
 * 塞进百分比会混淆「窗口消耗」与「可用余额」。但面板有地方放，而读者在面板里正
 * 问「这 5 小时用完了我还能不能跑」，返赠余额就是那个答案，所以它作为**面板脚注**
 * 出现（≥1 分才画；0 分画出来只是噪声）。早前把它完全排除的裁定，是在没有面板、
 * 没有地方陈述这个事实时做的。
 *
 * **秒，不是毫秒**：`window_5h.reset_at` 经 `epochSeconds()` 落在
 * **秒**上，而旧 `resetFor()` 拿它跟 `Date.now()`（毫秒）比——任何真实读数都判定为
 * 「已过期」，于是面板的重置时刻与 tooltip 的「重置于」在真机上从未出现过（§H 的
 * fixture 喂的是毫秒，正好把这个洞盖住）。现在比较时换算、返回值仍是秒，
 * `when()` / `new Date(x * 1000)` 都吃秒，调用点不必记住单位。
 *
 * **展开面板**：胶囊点一下展开额度卡，画的是胶囊**装不下**的
 * 东西——每个窗口的原始 used/limit、精确重置时刻（`when`，跨日带日期）、以及
 * 「本模型计入哪个池 / 因无专属池按通用池计」。不放百分比：胶囊已经有四舍五入后的
 * 百分比，再来一个是同一个数字说两遍；开面板要回答的是「1% 还够不够跑一次长上下文」，
 * 那个问题只有原始数字答得了。分级阈值与胶囊同一个 `tierOf`（80 黄 / 100 红），
 * **不**抄 `cards.ts` 的 70/90——同一屏里两套阈值互相打脸比任何一套都糟。
 *
 * 关闭方式：再点一次胶囊、点面板外部、按 Esc。三者共用**内层**组件里的一对
 * document 监听（`pointerdown` + `keydown`，只在 open 时挂，卸载/收起即摘），
 * 守卫与 cleanup 照抄 `use-polling-interval.ts` 的 visibilitychange 那一套
 * （`typeof document !== "undefined" && "addEventListener" in document`）——本
 * 插件本来就持有 document 级监听（那个 visibilitychange），所以这不是新开的
 * 口子，是把已经有的那一个用在第二个地方。
 *
 * 监听器挂在**内层**组件：外层 `ComposerUsagePill` 仍只决定挂哪个内层，三层结构
 * （见上）不破；而切模型会卸载内层，连监听器与面板一起消失——面板永远不可能显示
 * 上一个模型的额度，监听器也不会跨模型留下。
 *
 * 点外部用 `pointerdown` 而不是 `click`：触发器自己的 `click` 会在同一轮事件里
 * 冒泡到 document，若用 `click` 关闭，「点胶囊关闭」会先关掉面板再被触发器的
 * toggle 重新打开（净效果 = 关不掉）。`pointerdown` 在 click 之前落下，且不冒泡
 * 到触发的按钮，顺序上就没有这个反转。代价是「在别处按下鼠标、拖回胶囊再松手」
 * 会关掉面板——这是所有 pointerdown 关闭方案的通病，付得起。
 */
import { h, useCallback, useEffect, useRef, useState } from "./runtime.ts";
import { S } from "./styles.ts";
import { count, format, when } from "./format.ts";
import { RACCOON_PATH } from "./const.ts";
import { useRemoteRead, type RemoteRead, type RemoteRoute } from "./use-remote-read.ts";
import { useSnapshotPolling } from "./use-snapshot-polling.ts";
import { QuotaBar } from "./quota-bar.ts";
import type { Tt } from "./runtime.ts";
import type { PoolData, QuotaWindowData } from "./wire.ts";
import type { RaccoonState } from "../shared/wire.ts";

/**
 * The two providers this pill claims (ROADMAP §6.3), and which of them each
 * reading belongs to. They are named separately because the branch between
 * them IS the pill's data decision: each provider's numbers come from its own
 * route, and neither borrows the other's. The Raccoon *web-search* provider is
 * not among them — it carries no quota at all.
 */
const TOKEN_PLAN = "sensenova-token-plan";
const RACCOON = "sensenova-raccoon";

/**
 * The idle cadence for the Raccoon read, before the route states its own.
 *
 * The route states `pollSeconds` in every answer (pinned to
 * `RACCOON_BALANCE_TTL_MS` by `test/raccoon-status.test.mjs` B8); this is the
 * same fallback the Raccoon tab keeps (`RACCOON_POLL_MS`) because it is the
 * number the Host's cache window is built around. A balance is a stock, not a
 * fast meter — this reader only exists so the pill stops showing a grey "—"
 * where a real figure is one poll away.
 */
const RACCOON_POLL_MS = 60_000;

/**
 * The popover's DOM id, so the trigger's `aria-controls` can name it.
 *
 * A constant, not a generated one: only ONE pill is mounted at a time (the
 * outer gate picks exactly one inner pill), so a fixed id is unique by
 * construction, and a fixed string is something a test can assert. A generated
 * id would need a `useId` call in the inner component — harmless, but it buys
 * uniqueness this component does not need and costs a hook it does not use.
 */
const POPOVER_ID = "dsh-sensenova-composer-pill-popover";

/** The slice of the `modelSelection` projection this decision needs. */
export interface ModelSelectionLike {
  next?: { provider?: string; model?: string } | null;
  lastUsed?: { provider?: string; model?: string } | null;
}

/** The props the slot hands the component (plus the renderer-injected `useProjection`). */
export interface ComposerPillProps {
  tt: Tt;
  useProjection?: (key: "modelSelection") => ModelSelectionLike | undefined;
}

/**
 * The candidate selection: `next` wins over `lastUsed` — BUT an empty `next`
 * object (the transient state right after a picker switch, before it carries
 * the new selection) must not shadow a still-usable `lastUsed`. The old
 * `next ?? lastUsed` read a provider off `{}` and returned `undefined`,
 * hiding the pill for OWNED models on exactly the frames a switch produces.
 */
function candidateOf(projection: ModelSelectionLike | undefined) {
  const p = projection ?? {};
  const usable = (c: { provider?: string; model?: string } | null | undefined) =>
    c !== null && c !== undefined
    && (typeof c.provider === "string" || typeof c.model === "string");
  if (usable(p.next)) return p.next;
  if (usable(p.lastUsed)) return p.lastUsed;
  return undefined;
}

/**
 * The provider the session is currently pointed at.
 *
 * `next` wins over `lastUsed`: a switch that has landed but not yet been sent is
 * still the selection the composer displays — the same precedence the shell uses.
 */
export function selectedProviderOf(projection: ModelSelectionLike | undefined): string | undefined {
  const candidate = candidateOf(projection);
  const provider = candidate?.provider;
  return typeof provider === "string" && provider !== "" ? provider : undefined;
}

/** The selected model id, `next` winning as above. */
export function selectedModelOf(projection: ModelSelectionLike | undefined): string | undefined {
  const candidate = candidateOf(projection);
  const model = candidate?.model;
  return typeof model === "string" && model !== "" ? model : undefined;
}

/**
 * Which pool's windows this model draws from.
 *
 * A pool is model-scoped when it declares `modelIds`. When SEVERAL pools name
 * the same model, the dedicated pool wins over the general one: the console
 * lists `sensenova-6.8-flash-lite` in both, yet its spend lands in the
 * Flash-Lite pool only (live check 2026-10-18 00:00: the dedicated 5h window
 * had 3,129 credits consumed while the general 5h window stayed at 0, both
 * sharing one `resetAt`). Taking the first hit would attribute the model — and
 * its exhaustion — to the general pool, i.e. show a full meter for a model that
 * still has an untouched quota behind it.
 *
 * That observation does not prove the platform charges the dedicated pool
 * FIRST: a "general pool until it runs dry, then the dedicated one" rule would
 * have produced the same numbers. The pill can therefore read healthy while a
 * request still comes back 429. That is the same bet the Host's all-pools rule
 * makes (`exhaustedModelIds`), so the pill and the picker never disagree — only
 * the inference about the console's billing order stays unverified.
 *
 * A Token Plan model that names no pool falls back to the first pool — never to
 * an invented aggregate. The fallback is Token Plan only: a Raccoon model
 * belongs to the Raccoon gateway's own credit universe, so it never borrows a
 * Token Plan pool — it renders through {@link RaccoonPill}, which reads that
 * gateway's balance.
 *
 * A covering pool that is ALREADY DRAINED loses to a covering pool that still
 * has credit: the Host keeps the model selectable while ANY covering pool has
 * credit (the all-pools rule), so pointing the pill at the spent one would show
 * a full meter for a model the picker still offers — a disagreement between two
 * panels about one fact. Dedicated-first decides only among pools that can still
 * serve, and still decides by itself when every covering pool is spent (then the
 * earliest reset clock is what the reader needs).
 */
export function poolFor(
  pools: PoolData[] | undefined,
  modelId: string | undefined,
  provider?: string
): PoolData | undefined {
  const covering =
    modelId !== undefined
      ? (pools ?? []).filter((p) => Array.isArray(p.modelIds) && p.modelIds.includes(modelId))
      : [];
  const live = covering.filter((pool) => !poolSpent(pool));
  const preferred = live.find((p) => p.poolType === "dedicated") ?? live[0];
  if (preferred !== undefined) return preferred;
  const dedicated = covering.find((p) => p.poolType === "dedicated");
  if (dedicated !== undefined) return dedicated;
  if (covering.length > 0) return covering[0];
  return provider === TOKEN_PLAN ? pools?.[0] : undefined;
}

/**
 * Whether either window of a pool reads as fully spent.
 *
 * Deliberately `tierOf` (the pill's one colour rule) rather than a second
 * `remaining <= 0` comparison: `limit` unknown must stay "unknown", never
 * "spent", and the pill already owns exactly one implementation of that.
 */
function poolSpent(pool: PoolData): boolean {
  return tierOf(pool.window5h) === "exhausted" || tierOf(pool.window7d) === "exhausted";
}

/** The four colour tiers, worst-first for comparison. */
export type Tier = "ok" | "warn" | "exhausted" | "unknown";

/** The colour for a window, by share of its limit already spent. */
export function tierOf(window: QuotaWindowData | null | undefined): Tier {
  const limit = typeof window?.limit === "number" ? window.limit : NaN;
  const used = typeof window?.used === "number" ? window.used : NaN;
  if (!Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0) return "unknown";
  const share = used / limit;
  if (share >= 1) return "exhausted";
  if (share >= 0.8) return "warn";
  return "ok";
}

/** The worse of two tiers, for the pill's single colour. */
export function worseTier(a: Tier, b: Tier): Tier {
  const rank: Record<Tier, number> = { exhausted: 4, warn: 3, ok: 2, unknown: 1 };
  return rank[a] >= rank[b] ? a : b;
}

/** The used share of a window as a rounded percent, or `null` when unknowable. */
export function percentOf(window: QuotaWindowData | null | undefined): number | null {
  const limit = typeof window?.limit === "number" ? window.limit : NaN;
  const used = typeof window?.used === "number" ? window.used : NaN;
  if (!Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0) return null;
  return Math.round((used / limit) * 100);
}

/**
 * A balance as the pill's number, or `null` when the gateway declared none.
 *
 * `0` is a reading, not a gap: an exhausted balance must read `0 分` in the
 * alarm tier, never the grey "—" that means "we could not find out". Only
 * `null` / `undefined` / a non-finite value is absence.
 */
export function balanceOf(state: RaccoonState | null | undefined): number | null {
  const balance = state?.balance;
  return typeof balance === "number" && Number.isFinite(balance) ? balance : null;
}

const TIER_INK: Record<Tier, string> = {
  ok: S.pillTierOk,
  warn: S.pillTierWarn,
  exhausted: S.pillTierExhausted,
  unknown: S.pillTierUnknown
};

/**
 * The reset instant to WORD, in the same epoch SECONDS the wire uses — or `null`
 * when none should be worded.
 *
 * The units are the whole point of this helper. `window_5h.reset_at` arrives as
 * decimal epoch seconds (`epochSeconds()` in `parsers.ts`), so a seconds value
 * compared against `Date.now()`'s milliseconds is ALWAYS in the past — which
 * silently deleted the reset clock from the panel and the tooltip for every real
 * reading, while `cards.ts` (which skips this helper and formats straight)
 * kept showing it. So the comparison converts, and the return value stays in
 * SECONDS: both `when()` and `new Date(x * 1000)` take seconds, so no caller has
 * to remember which unit a "resetAt" is in.
 *
 * A reset that has already passed (the window is mid-reset, or the snapshot
 * lagged it) is dropped rather than worded "重置中" — the stale mark, when
 * present, carries that reading instead.
 * @param resetAtSeconds - epoch seconds, exactly as the wire carries it.
 * @param nowMs - epoch ms (injectable for tests).
 */
export function resetFor(resetAtSeconds: number | null | undefined, nowMs: number): number | null {
  if (typeof resetAtSeconds !== "number" || !Number.isFinite(resetAtSeconds)) return null;
  return resetAtSeconds * 1000 > nowMs ? resetAtSeconds : null;
}

/**
 * The SOONEST reset still ahead among several windows' — or `null` if none is.
 *
 * `window_5h.resetAt ?? window_7d.resetAt` picks the first non-null, not the
 * first LIVE one, and the two are not the same window: the 5h deadline elapses
 * four times a day (so it is mid-reset or lagged by the snapshot's own cadence),
 * while the weekly one is still ahead — and the tooltip, having taken the dead
 * 5h value, then worded no deadline at all. That deleted the reset clock exactly
 * when the reader had the most reason to look at it. Choosing the soonest future
 * instant makes each window contribute what it knows and a spent deadline
 * contribute nothing, instead of shadowing the other window.
 *
 * Ties and equal values are harmless: the first minimum wins, and both callers
 * only ever word the one instant.
 * @param resets - every window's `resetAt`, epoch seconds, in any order.
 * @param nowMs - epoch ms (injectable for tests).
 */
export function nextResetOf(
  resets: readonly (number | null | undefined)[],
  nowMs: number
): number | null {
  let soonest: number | null = null;
  for (const at of resets) {
    const live = resetFor(at, nowMs);
    if (live === null) continue;
    if (soonest === null || live < soonest) soonest = live;
  }
  return soonest;
}

/** How long a read may age before the pill calls it "上次数据" (90 s, a bit past the stated cadence). */
export const STALE_AFTER_MS = 90_000;

/** The inner pills' props — handed down as plain values, so they call no projection hook. */
interface ActivePillProps {
  tt: Tt;
  model: string | undefined;
}

/**
 * One window as a panel row: the label, a bar that carries the same share the
 * pill's percentage rounds, the RAW figures, and the reset clock.
 *
 * Why the bar and the raw figures but no percentage: the pill already shows the
 * rounded percentage, and a second rounded percentage beside it would be the
 * same number twice. What the pill cannot show is the question that opens this
 * panel — "1%" cannot say whether a long-context request still fits — so the
 * row spends its width on used/limit instead.
 *
 * `aria` mirrors `cards.ts`'s progressbar: same role, same value triple, so a
 * screen reader is told the same thing by both surfaces.
 */
function QuotaRow({ label, window, tt }: { label: string; window: QuotaWindowData | null; tt: Tt }) {
  const limit = typeof window?.limit === "number" ? window.limit : 0;
  const used = typeof window?.used === "number" ? window.used : 0;
  // Unknown is a zero-width bar, never a full one: a limit the platform did not
  // declare must not read as "spent".
  const share = limit > 0 ? Math.min(100, (used / limit) * 100) : null;
  const tier = tierOf(window);
  const resetAt = resetFor(window?.resetAt ?? null, Date.now());
  return h(
    "div",
    { style: S.pillPopoverRow },
    h(
      "div",
      { style: S.pillPopoverRowLine },
      h("span", { style: S.pillPopoverLabel }, label),
      // The figure is ONE token when the limit is undeclared, not `0 / 0`: a
      // limit of zero is the console declining to publish a cap, and printing
      // both sides of a ratio nobody can compute publishes two numbers the
      // platform never sent. The predicate is the one `percentOf` and `tierOf`
      // already apply to this very field (finite and positive), so the row and
      // the pill's colour cannot disagree about whether a share is knowable —
      // §34's "one contract drawn twice" settled at the source.
      h(
        "span",
        { style: S.pillPopoverFigure },
        Number.isFinite(limit) && limit > 0 ? `${count(used)} / ${count(limit)}` : "—"
      )
    ),
    QuotaBar({
      track: S.pillPopoverBar,
      // A bar with no known share draws no fill at all, rather than a 0-width
      // child that a stray `min-width` in some engine would paint as a nub.
      fill: share === null ? null : { ...S.pillPopoverFill, background: TIER_INK[tier] },
      widthPct: share ?? 0,
      valueNow: share === null ? 0 : Math.round(share),
      label: `${label} ${tt("pool.used")}`
    }),
    // `when`, not a bare clock: the weekly reset can land on another day, and
    // "重置 08:00" reads as later today — wrong, and alarming next to a 1% pill.
    resetAt === null
      ? null
      : h(
          "div",
          { style: S.pillPopoverFoot },
          h("span", { style: S.pillPopoverReset }, format(tt("pool.reset"), { time: when(resetAt) }))
        )
  );
}

/**
 * How one `/raccoon` answer becomes a reading.
 *
 * The route answers `ok:false` for every EXPECTED failure (signed out, gateway
 * down, token lapsed), so the failure wording is the route's, not ours: only it
 * knows which of its failures a user can act on. A balance of `0` is a VALUE,
 * not a failure, so it travels back as a value and {@link balanceOf} decides
 * what the pill words. Module-scoped because the polling core closes over this
 * route — a fresh literal per render would rebuild the loop on every render.
 */
const RACCOON_ROUTE: RemoteRoute<RaccoonState> = {
  path: RACCOON_PATH,
  parse: (body, status): RemoteRead<RaccoonState> => {
    if (status < 200 || status >= 300) return { value: null, failure: `HTTP ${status}` };
    const envelope = body as RaccoonState | null;
    if (envelope === null || typeof envelope !== "object" || envelope.ok === false) {
      const detail = envelope && typeof envelope.error === "string" ? envelope.error : "";
      return { value: null, failure: detail !== "" ? detail : "read failed" };
    }
    return { value: envelope, failure: null, cadenceSeconds: envelope.pollSeconds };
  }
};

/**
 * The Raccoon gateway's balance reader: the same polling core the panel's
 * snapshot reader uses, pointed at the plugin's OWN `/raccoon` route — which the
 * Host already answers from a 5-minute cache, so a composer pill adds no gateway
 * traffic. It reads the whole `RaccoonState` rather than a balance field, so
 * `loggedIn` and the failure wording come from the same answer instead of a
 * second request.
 *
 * Why the pill cannot simply borrow the Raccoon tab's reader: the tab is a
 * plugin-card surface that mounts on demand and may never be opened in a given
 * session; the pill is in the composer of every conversation whose model is a
 * Raccoon one. A shared hook would mean either the pill polls for tabs nobody
 * opened, or the tab reads a balance the pill already paid for. What they DO
 * share is the lifecycle — which is why this is a route over `useRemoteRead`
 * rather than a hand-kept copy of the snapshot reader's body.
 */
function useRaccoonBalance(defaultCadenceMs = RACCOON_POLL_MS) {
  const { data, error, loadedOnce, updatedAt } =
    useRemoteRead<RaccoonState>(RACCOON_ROUTE, defaultCadenceMs);
  return { state: data, error, loadedOnce, updatedAt };
}

/**
 * The dismissal listeners for an open panel: click-away and Escape.
 *
 * Both are ordinary document listeners guarded the way `use-polling-interval.ts`
 * guards its `visibilitychange` one, and both are torn down the moment the panel
 * closes — a closed panel must not keep the document on a listener that exists
 * only to close it.
 *
 * The containment test reads the anchor's DOM node rather than the panel's: a
 * click on the trigger itself is a TOGGLE (the button's own `click` handler), so
 * treating it as "inside" is what keeps the outside-click path from racing it.
 * `anchorRef` is a ref, not state, so attaching it costs no render and no hook
 * order risk.
 *
 * `pointerdown` and not `click`: by `click` time the trigger's own handler has
 * already run, so a `click` listener that treated the trigger as "inside" would
 * close and the toggle would immediately reopen — a panel that cannot be closed
 * by clicking away. See the module doc for the drag-back caveat.
 */
function useDismissOn(open: boolean, close: () => void, anchorRef: { current: unknown }) {
  useEffect(() => {
    if (!open) return;
    // A host that gives the client no `document` (a bare Node mount) simply has
    // no dismissal beyond the trigger's own toggle, which is the fallback the
    // MVP shipped with — the panel must not throw here.
    if (typeof document === "undefined" || !("addEventListener" in document)) return;
    // Duck-typed rather than `target instanceof Node`: `Node` is a browser
    // global, and this module is also mounted under jsdom in the render suite,
    // where only `document` is mirrored into the Node realm — naming the
    // constructor would ReferenceError there. `nodeType` is the same test
    // without the global.
    const nodeLike = (value: unknown): value is { nodeType: number } =>
      typeof value === "object" && value !== null && typeof (value as { nodeType?: unknown }).nodeType === "number";
    const anchorLike = anchorRef.current as { contains?: (node: unknown) => boolean } | null;
    const insideAnchor = (target: unknown) =>
      nodeLike(target) && typeof anchorLike?.contains === "function" && anchorLike.contains(target);
    const onPointerDown = (event: Event) => {
      if (insideAnchor((event.target as EventTarget | null))) return;
      close();
    };
    const onKeyDown = (event: Event) => {
      if ((event as KeyboardEvent).key !== "Escape") return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close, anchorRef]);
}

/**
 * The popover itself: a `<div role="dialog">` sibling of the trigger rather than
 * its child: a dialog inside a `<button>` is invalid nesting (a button's content
 * model is phrasing content, and interactive content inside it is worse), and the
 * panel has its own rows. The anchor wrapper is a plain `<span>` for the same
 * reason.
 *
 * The `id` lives HERE rather than on an extra wrapper: `aria-controls` has to
 * resolve to the node that actually carries the panel, and one wrapper between
 * the id and the panel would make the reference point at a bare wrapper.
 */
function QuotaPopover(props: { tt: Tt; title: string; stale: boolean; poolLine: string | null; note: string | null; footnote?: string | null; children?: unknown }) {
  const { tt, title, stale, poolLine, note, footnote = null, children } = props;
  return h(
    "div",
    {
      className: "dsh-sensenova-composer-pill-popover",
      id: POPOVER_ID,
      role: "dialog",
      "aria-label": title,
      style: S.pillPopover
    },
    h(
      "div",
      { style: S.pillPopoverHead },
      h("span", { style: S.pillPopoverTitle }, title),
      poolLine === null ? null : h("span", { style: S.pillPopoverPool }, poolLine),
      stale ? h("span", { style: S.pillPopoverStale }, tt("composer.stale")) : null
    ),
    children,
    note === null ? null : h("div", { style: S.pillPopoverNote }, note),
    // The footnote is a SECOND quiet line, kept separate from `note`: `note`
    // speaks for a state the reader must act on (signed out, outside the pools),
    // while the footnote carries a figure that is merely worth knowing. Merging
    // them would make a grant balance read as a warning.
    footnote === null ? null : h("div", { style: S.pillPopoverNote }, footnote)
  );
}

/**
 * One declared part of the Raccoon balance: a label and its figure, no bar.
 *
 * A bar needs a limit to be a share of, and the gateway publishes none here —
 * so a bar would be a fraction of an invented denominator. The figure is drawn
 * in the panel's own `count` unit so it adds up in the reader's head against
 * the total above it.
 */
function RaccoonPartRow({ label, value, tt }: { label: string; value: number; tt: Tt }) {
  return h(
    "div",
    { style: S.pillPopoverRowLine },
    h("span", { style: S.pillPopoverLabel }, label),
    h("span", { style: S.pillPopoverFigure }, `${count(value)} ${tt("composer.balanceUnit")}`)
  );
}

/** The shared shell: the tier dot, the reading, the plan prefix, the panel anchor. */
function PillBody(props: {
  tt: Tt;
  planLabel: string;
  tier: Tier;
  children?: unknown;
  stale?: boolean;
  title: string;
  open?: boolean;
  onToggle: () => void;
  onClose: () => void;
  panel?: unknown;
}) {
  const { tt, planLabel, tier, children, stale = false, title, open = false, onToggle, onClose, panel = null } = props;
  // The anchor node, for the dismissal listeners' containment test. `useRef`
  // rather than state: it is read inside a listener and must not re-render the
  // pill when it is attached.
  const anchorRef = useRef<unknown>(null);
  useDismissOn(open, onClose, anchorRef);
  return h(
    "span",
    {
      className: "dsh-sensenova-composer-pill-anchor",
      style: S.pillPopoverAnchor,
      ref: anchorRef
    },
    h(
      "button",
      {
        type: "button",
        // The class survives as the test selector (`render-dom.test.mjs` queries
        // it) — and as nothing else: this plugin injects no stylesheet, so a
        // className is a hook for tests and an eyesore for the author. Everything
        // the pill LOOKS like is the inline style below.
        className: "dsh-sensenova-composer-pill",
        title,
        "aria-label": title,
        "aria-expanded": open,
        // `aria-haspopup: "dialog"` says the trigger OWNS a panel (not a menu, so
        // arrow-key navigation is not promised), and `aria-controls` points at
        // the panel's id only when it is mounted — pointing at a missing node is
        // a broken reference, so the attribute is conditional.
        "aria-haspopup": "dialog",
        "aria-controls": open ? POPOVER_ID : undefined,
        onClick: onToggle,
        style: S.pillTrigger
      },
      h("span", {
        className: "dsh-sensenova-composer-pill-dot",
        "aria-hidden": "true",
        style: { ...S.pillDot, background: TIER_INK[tier] }
      }),
      // The plan name: which quota the numbers below belong to. Rendered as its
      // own span so it can be tinted/weighted on its own later without touching
      // the reading (opencode-go wraps its `Go · ` in `css.brand` for the same
      // reason).
      h(
        "span",
        { className: "dsh-sensenova-composer-pill-plan", style: S.pillPlan },
        `${planLabel} · `
      ),
      h(
        "span",
        {
          className: "dsh-sensenova-composer-pill-text",
          // Only an EXHAUSTED window tints the text. Everything else stays in
          // the host's label ink, which is what makes a 1% pill quiet: if the
          // percentages wore tier colour, a healthy reading would be as loud as
          // the model picker's own chrome.
          style: tier === "exhausted" ? S.pillTierExhaustedText : undefined
        },
        children,
        stale ? h("span", { style: S.pillStale }, ` · ${tt("composer.stale")}`) : null
      )
    ),
    open && panel !== null ? panel : null
  );
}

/**
 * The composer pill. Renders nothing unless the session's model belongs to this
 * plugin — so no other provider's conversations carry a foreign credit readout,
 * and no fetch loop runs while it is absent (the inner poller is not mounted).
 * Which inner pill mounts is the same decision as whether one does: Token Plan
 * reads the snapshot, Raccoon reads its own balance, and neither is mounted for
 * the other's provider.
 */
export function ComposerUsagePill(props: ComposerPillProps) {
  const { tt, useProjection } = props;
  // The keyed hook call stays at one fixed site every render: the host's
  // materialized hook, or the noop when a Node test injects no projection.
  // The gate below only decides whether an INNER component mounts — a legal
  // hook boundary — never how many hooks this component called.
  const projection = (useProjection ?? (() => undefined))("modelSelection");
  const provider = selectedProviderOf(projection);
  const model = selectedModelOf(projection);
  if (provider === TOKEN_PLAN) return h(TokenPlanPill, { tt, model });
  if (provider === RACCOON) return h(RaccoonPill, { tt });
  return null;
}

/**
 * The Token Plan reading: the snapshot poller (unconditionally, first hook) and
 * the two-window percentage pair. Unmounted wholesale when the session leaves
 * the Token Plan provider, which is also what stops its fetch loop.
 */
function TokenPlanPill({ tt, model }: ActivePillProps) {
  const { data, error, loadedOnce, updatedAt } = useSnapshotPolling();
  // The panel's open state lives HERE, in the inner component, not in the outer
  // gate: an outer `open` flag would make `ComposerUsagePill` return one of
  // three shapes and could reintroduce the hook-count drift §6.3 ruled out. A
  // switch to a Raccoon model unmounts this whole component, so the panel
  // cannot outlive the model whose quota it was quoting — which is the correct
  // default and needs no listener to enforce it.
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((wasOpen) => !wasOpen), []);
  // An idempotent close for the dismissal path: a toggle there would be undone by
  // the second arrival (a click-away that toggles, then the anchor's own handler
  // toggles back = a panel that cannot be dismissed).
  const close = useCallback(() => setOpen(false), []);
  const pools = data?.pools?.pools ?? [];
  const pool = poolFor(pools, model, TOKEN_PLAN);
  const w5 = pool?.window5h ?? null;
  const w7 = pool?.window7d ?? null;
  const tier = worseTier(tierOf(w5), tierOf(w7));
  const p5 = percentOf(w5);
  const p7 = percentOf(w7);
  const now = Date.now();
  const stale = error !== null || (updatedAt > 0 && now - updatedAt > STALE_AFTER_MS);
  // The SOONEST live deadline of the two windows, never the first non-null: the
  // 5h deadline elapses four times a day, so `w5?.resetAt ?? w7?.resetAt` handed
  // the tooltip a spent instant and worded no deadline at all while the weekly
  // one was still ahead.
  const resetTime = nextResetOf([w5?.resetAt, w7?.resetAt], now);
  const label = (prefix: string, pct: number | null) =>
    `${prefix} ${pct === null ? "—" : `${pct}%`}`;
  // Two ways a model can own no pool, and `loadedOnce` cannot tell them apart:
  // `use-remote-read.ts` sets it in a `finally`, so an attempt that FAILED counts
  // as "loaded". The discriminator is `data` — the poller keeps the last good
  // reading across a failure, so a non-null `data` means an answer did arrive at
  // some point and the model really is in no pool, while a null `data` means we
  // never found out. Wording the first on the second's evidence is how a 401
  // became a claim about the billing model.
  const everRead = data !== null;
  const noPoolReason = everRead ? tt("composer.noPool") : tt("composer.quotaUnknown");
  const poolTitle = pool !== undefined
    ? pool.name ? String(pool.name) : null
    : loadedOnce ? noPoolReason : null;
  const title = [
    tt("composer.pillTitle"),
    poolTitle,
    // `when()`, not `toLocaleString()`: every other reset in this panel is worded
    // through `when`, and the tooltip's raw locale string was a second dialect for
    // the same field — with no day when the reset crossed midnight.
    resetTime !== null ? `${tt("composer.resetAt")} ${when(resetTime)}` : null,
    stale ? tt("composer.stale") : null
  ]
    .filter(Boolean)
    .join(" · ");

  // Which pool's windows the model draws from, and HOW it got there — a model
  // that names its pool and one that falls back to another pool are billing
  // differently even when the numbers match, and the panel is where that
  // distinction has room to be said out loud.
  //
  // The fallback wording names the pool's OWN type rather than asserting
  // "general": `poolFor` falls back to `pools[0]`, and the console returns
  // sibling pools (the 通用池 next to a Flash-Lite 专属池) in the platform's own
  // order. So the pool a fallback landed on can be a dedicated pool, and calling
  // it 通用池 would be a fact this client cannot support. Same branch `cards.ts`
  // takes on `poolType` — `dedicated` says so, anything else says default, which
  // is also what `parsers.ts` normalizes an absent `pool_type` to.
  const matched =
    model !== undefined && pool !== undefined
      ? Array.isArray(pool.modelIds) && pool.modelIds.includes(model)
      : false;
  const poolKind = pool !== undefined && pool.poolType === "dedicated"
    ? tt("pool.dedicated")
    : tt("pool.default");
  const poolLine = pool === undefined
    ? null
    : `${String(pool.name ?? "")} · ${poolKind} · ${matched ? tt("composer.poolHit") : tt("composer.poolFallback")}`;
  // The pool-less case still gets the FRAME, not a bare note: a panel that
  // changes shape when the model has no pool teaches the reader two layouts, and
  // `role="dialog"` / `aria-controls` must describe the same node in both.
  // The grant footnote: a separate quota universe (30 days, it does not consume
  // the rolling windows), so it can only ever be a footnote here — never a
  // percentage, never a window row. Drawn only when the platform declared money
  // to draw: `credits()` normalizes an absent `grant_balance` to `0`, and a
  // "返赠余额 0" line would read as a claim that the grant was spent rather than
  // that there is none.
  const grant = pool === undefined ? 0 : pool.grantBalance ?? 0;
  const grantExpiry = pool?.nearestGrantExpiry ?? null;
  const footnote = grant > 0
    ? [
      format(tt("pool.grant"), { balance: count(grant) }),
      // `when`, and only while the expiry is still ahead: an elapsed deadline is
      // `resetFor`'s case, and a stale date beside a live balance reads as a
      // warning the platform never raised.
      grantExpiry !== null && resetFor(grantExpiry, now) !== null
        ? format(tt("pool.grantExpiry"), { time: when(grantExpiry), balance: count(pool?.nearestGrantExpiringBalance ?? 0) })
        : null
    ].filter((part) => part !== null).join(" · ")
    : null;

  const panel =
    pool === undefined
      ? h(QuotaPopover, {
          tt,
          title: tt("composer.pillTitle"),
          stale,
          poolLine: null,
          note: loadedOnce ? noPoolReason : "…",
          children: null
        })
      : h(QuotaPopover, {
          tt,
          title: tt("composer.pillTitle"),
          stale,
          poolLine,
          note: null,
          footnote,
          children: [
            h(QuotaRow, { key: "w5", label: tt("pool.window5h"), window: w5, tt }),
            h(QuotaRow, { key: "w7", label: tt("pool.window7d"), window: w7, tt })
          ]
        });

  return h(PillBody, {
    tt,
    planLabel: tt("composer.planPrefix"),
    tier,
    stale,
    title,
    open,
    onToggle: toggle,
    onClose: close,
    panel,
    children: [
      h("span", { key: "r5", style: S.pillReading }, label(tt("composer.pool5h"), p5)),
      " · ",
      h("span", { key: "r7", style: S.pillReading }, label(tt("composer.pool7d"), p7))
    ]
  });
}

/**
 * The Raccoon reading: the gateway's own credit balance, in its own unit.
 *
 * It is a STOCK, not a meter — the Raccoon gateway declares no daily or monthly
 * cap, so there is no honest percentage to draw here. Turning a balance into a
 * percentage would require inventing the limit it is a share of, and the pill
 * would then show a number nobody published. So: the balance, the plan prefix,
 * and a tier that follows the FACT rather than a threshold — drained reads
 * exhausted, a positive balance reads ok, an unreadable one reads unknown.
 */
function RaccoonPill({ tt }: { tt: Tt }) {
  const { state, error, loadedOnce, updatedAt } = useRaccoonBalance();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((wasOpen) => !wasOpen), []);
  const close = useCallback(() => setOpen(false), []);
  const balance = balanceOf(state);
  const now = Date.now();
  const stale = error !== null || (updatedAt > 0 && now - updatedAt > STALE_AFTER_MS);
  const signedOut = state !== null && state.loggedIn !== true;
  const tier: Tier = balance === null ? "unknown" : balance <= 0 ? "exhausted" : "ok";
  const reading = balance === null
    ? "—"
    : `${count(balance)} ${tt("composer.balanceUnit")}`;
  // The models the gateway added since this plugin first wrote them down.
  //
  // This is the pill's ONLY non-quota fact, and it earns the space: the
  // balance answers "can I afford it", while "a new model exists" is the one
  // thing a user cannot infer from any number here. The 1017 build sat in the
  // gateway unseen for weeks precisely because the only surface that knew was
  // a tab nobody had opened that day.
  //
  // Names, not ids: `state.models` is the same roster the tab renders, so the
  // display name the user will see in the picker is a lookup, not a second
  // source. Capped at three — past that the marker is about a BULK change and
  // the count is the useful part, the list belongs in the popover.
  const newIds = state?.newModelIds ?? [];
  const newNames = newIds.map((id) => {
    const row = state?.models?.find((model) => model.id === id);
    return row?.name ?? row?.id ?? id;
  });
  const shownNames = newNames.slice(0, 3);
  const newModelTitle = newIds.length === 0
    ? null
    : `${tt("composer.raccoonNewModelsTitle")}${shownNames.join(tt("composer.raccoonNewModelsSep"))}${newIds.length > shownNames.length ? "…" : ""}`;

  const title = [
    tt("composer.raccoonTitle"),
    signedOut ? tt("composer.raccoonSignedOut") : balance === null ? tt("composer.raccoonUnknown") : null,
    newModelTitle,
    stale ? tt("composer.stale") : null
  ]
    .filter(Boolean)
    .join(" · ");
  // The grey "—" is honest before the first answer arrives but says nothing
  // after one has: past the first read, the wording has to say WHICH fact is
  // missing (signed out vs unreadable), or the reader is back to guessing.
  const pending = !loadedOnce && balance === null;

  // The gateway's own split of the total, when it declares one. A single total
  // answers "how much"; the split answers "how much of it expires tonight",
  // which is the question that decides whether to spend now — so the parts are
  // the reason the panel is worth opening, while the pill keeps the total alone
  // (a toolbar has room for one number, not five).
  //
  // Only the parts the gateway DECLARED: an absent part is not a zero, and
  // drawing a zero for it would publish a figure nobody sent. Four literal
  // `tt()` calls, not a table lookup, because the keys are fixed — the same
  // reasoning `raccoon-card.ts` records.
  const breakdown = state?.balanceBreakdown;
  // `key` on each: these four go into ONE array that is then handed as a single
  // `children` value, so React sees a nested list and asks every member for a
  // stable identity. Without one it reuses this row's fibre for the next part
  // when the gateway stops declaring one — and warns on every render besides.
  const partRows = [
    breakdown?.daily === undefined ? null : h(RaccoonPartRow, { key: "daily", label: tt("raccoon.partNameDaily"), value: breakdown.daily, tt }),
    breakdown?.reward === undefined ? null : h(RaccoonPartRow, { key: "reward", label: tt("raccoon.partNameReward"), value: breakdown.reward, tt }),
    breakdown?.monthly === undefined ? null : h(RaccoonPartRow, { key: "monthly", label: tt("raccoon.partNameMonthly"), value: breakdown.monthly, tt }),
    breakdown?.topup === undefined ? null : h(RaccoonPartRow, { key: "topup", label: tt("raccoon.partNameTopup"), value: breakdown.topup, tt })
  ].filter((row) => row !== null);

  const panel = h(QuotaPopover, {
    tt,
    title: tt("composer.raccoonTitle"),
    stale: stale && loadedOnce,
    // The Raccoon gateway declares no pool and no window: there is nothing to
    // attribute the stock to, so the pool line stays absent rather than being
    // filled with a borrowed Token Plan pool.
    poolLine: null,
    note: signedOut ? tt("composer.raccoonSignedOut") : balance === null ? tt("composer.raccoonUnknown") : null,
    children: [
      h(
        "div",
        { key: "balance", style: S.pillPopoverRow },
        h(
          "div",
          { style: S.pillPopoverRowLine },
          h("span", { style: S.pillPopoverLabel }, tt("composer.balanceLabel")),
          h("span", { style: S.pillPopoverFigure }, balance === null ? "—" : `${count(balance)} ${tt("composer.balanceUnit")}`)
        )
      ),
      // Declared parts ride as a compact deck under the total, each on its own
      // line — no bar, because no limit was published to scale one against.
      partRows.length === 0
        ? null
        : h(
            "div",
            { key: "parts", style: S.pillPopoverParts },
            h("div", { style: S.pillPopoverPartsLabel }, tt("composer.balanceParts")),
            partRows
          ),
      // The roster's news, as a row of the same popover the balance lives in:
      // the pill says "1 新模型", this says WHICH. It reuses the SAME capped
      // list (shownNames) the tooltip renders — one fact, one wording across
      // both surfaces (ADR-017), and no risk of the popover turning into a
      // two-hundred-row wall when the gateway bulk-adds or the store misbehaves.
      newIds.length === 0
        ? null
        : h(
            "div",
            { key: "newModels", style: S.pillPopoverParts },
            h("div", { style: S.pillPopoverPartsLabel }, tt("composer.raccoonNewModelsRow")),
            h("div", { style: S.pillPopoverRowLine }, h("span", { style: S.pillPopoverFigure }, `${shownNames.join(tt("composer.raccoonNewModelsSep"))}${newIds.length > shownNames.length ? "…" : ""}`))
          )
    ]
  });

  return h(PillBody, {
    tt,
    planLabel: tt("composer.raccoonPrefix"),
    tier,
    stale: stale && loadedOnce,
    title,
    open,
    onToggle: toggle,
    onClose: close,
    panel,
    children: h(
      "span",
      { style: S.pillReading },
      pending ? "…" : reading,
      // A third segment rather than a chip or a dot: the pill already uses its
      // dot for the tier, and a second coloured mark would read as a second
      // quota state. Muted label ink (S.pillNewTag) keeps it subordinate to
      // the number it sits beside.
      newIds.length === 0
        ? null
        : h("span", { style: S.pillNewTag }, ` · ${newIds.length} ${tt("composer.raccoonNewModels")}`)
    )
  });
}

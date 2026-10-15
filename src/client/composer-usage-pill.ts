/**
 * 对话框用量胶囊（ROADMAP §6.3）—— 输入框工具栏 `conversation.input.right` 座席。
 *
 * 形态跟随 opencode-go 的「用量胶囊」，不跟随 workbuddy 的「纯文本余额读数」：
 * 商汤 Token Plan 是 5h / 周 滚动额度池，**没有**单一余额可显示，所以胶囊画的是
 * 「已用百分比」+ 颜色分级（绿 <80% / 黄 ≥80% / 红 耗尽 / 灰 未知）；重置时间放
 * tooltip，不进胶囊正文——正文密度与 opencode-go 对齐（它也是只在展开面板里给
 * 重置时间，pill 本体只有两档百分比 + 标记）。
 *
 * **两层结构**（本组件不「切模型即消失」的关键）：归属门控发生在**组件边界**——
 * 外层 `ComposerUsagePill` 只决定内层 `ActiveComposerPill` 的挂/摘，轮询 hook
 * `useSnapshotPolling` 全在内层调用，hook 顺序恒定。若在同一组件里先调 hook 再
 * 按门控早退（`return null`），切模型会踩 Rules of Hooks 的红线（「Rendered
 * fewer hooks than expected」）：组件被 React 甩出树，切回归属模型也起不来。
 * opencode-go 的 `UsagePill` / `ActiveUsage` 就是这个形状。
 *
 * 归属门控走 `useProjection("modelSelection")`（`next` 优先于 `lastUsed`），与
 * workbuddy 的 gate 逐字一致。该 prop 是 session 作用域槽位**严格必需**的物化
 * prop（见 `test/composer-slot-gate.mjs` 断言 D：session 作用域 `optional=false`，
 * 缺源抛 `SlotAssemblyError`），这里的 noop 兜底只是让 Node 侧单测能脱离 Host 注入。
 *
 * 快照复用 `useSnapshotPolling` —— 同一个 `/snapshot` 端点（Host 侧有
 * `cacheSeconds`），不另开一条轮询打控制台接口。失败降级：保留上次数值、超过
 * 一个 cadence 即标「上次数据」，不抛异常（照 §5 不变量 2 的纪律：面板照常用、
 * 该模块缺席）。非归属 provider 的会话内层根本不挂载 —— 不跑任何 fetch 循环。
 *
 * 池归组：额度是**池级**的（通用池 / Flash-Lite 专属池，每个 pool 带 `modelIds`），
 * 按当前模型 id 匹配所属池；Token Plan 模型匹配不到就回落到第一个池（通用池），
 * 不发明「余额」。小浣熊（`sensenova-raccoon`）模型属于小浣熊网关的积分宇宙，
 * 回落会把 Token Plan 的窗口错画成它的额度——所以它**不**回落：灰「—」+
 * tooltip 说明该模型不在 Token Plan 池内（其余额在小浣熊 tab 读）。
 *
 * 返赠余额（`grantBalance`）不进胶囊：它是独立口径（30 天有效、不占滚动窗口），
 * 塞进百分比会混淆「窗口消耗」与「可用余额」——它属于插件卡「积分额度」tab。
 */
import { h } from "./runtime.ts";
import { useSnapshotPolling } from "./use-snapshot-polling.ts";
import type { Tt } from "./runtime.ts";
import type { PoolData, QuotaWindowData } from "./wire.ts";

/**
 * The provider ids this pill claims (ROADMAP §6.3): the Token Plan LLM
 * provider and the Raccoon second upstream. The Raccoon *web-search*
 * provider is not in the set — it carries no quota.
 */
const PROVIDER_IDS = new Set(["sensenova-token-plan", "sensenova-raccoon"]);

/** The provider whose models may fall back to the general pool (see {@link poolFor}). */
const TOKEN_PLAN = "sensenova-token-plan";

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
 * A pool is model-scoped when it declares `modelIds`; a Token Plan model that
 * names no pool falls back to the first (general) pool — never to an invented
 * aggregate. The fallback is Token Plan only: a Raccoon model belongs to the
 * Raccoon gateway's own credit universe (its balance is read in the Raccoon
 * tab), so it never borrows a Token Plan pool — it yields `undefined` and the
 * pill shows grey "—" instead of a foreign number.
 */
export function poolFor(
  pools: PoolData[] | undefined,
  modelId: string | undefined,
  provider?: string
): PoolData | undefined {
  const hit =
    modelId !== undefined
      ? pools?.find((p) => Array.isArray(p.modelIds) && p.modelIds.includes(modelId))
      : undefined;
  if (hit !== undefined) return hit;
  return provider === TOKEN_PLAN ? pools?.[0] : undefined;
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

const TIER_COLOR: Record<Tier, string> = {
  ok: "#22c55e",
  warn: "#eab308",
  exhausted: "#ef4444",
  unknown: "#9ca3af",
};

/**
 * The reset instant for the tooltip, or `null` when none should be worded:
 * a reset that has already passed (the window is mid-reset or the snapshot
 * lagged it) is dropped rather than worded "重置中" — the stale mark, when
 * present, carries that reading instead.
 * @param resetAt - epoch ms.
 * @param now - epoch ms (injectable for tests).
 */
export function resetFor(resetAt: number | null | undefined, now: number): number | null {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return null;
  return resetAt > now ? resetAt : null;
}

/** How long a read may age before the pill calls it "上次数据" (90 s, a bit past the stated cadence). */
export const STALE_AFTER_MS = 90_000;

/** The inner pill's props — handed down as plain values, so it calls no projection hook. */
interface ActivePillProps {
  tt: Tt;
  provider: string;
  model: string | undefined;
}

/**
 * The composer pill. Renders nothing unless the session's model belongs to this
 * plugin — so no other provider's conversations carry a foreign credit readout,
 * and no fetch loop runs while it is absent (the inner poller is not mounted).
 */
export function ComposerUsagePill(props: ComposerPillProps) {
  const { tt, useProjection } = props;
  // The keyed hook call stays at one fixed site every render: the host's
  // materialized hook, or the noop when a Node test injects no projection.
  // The gate below only decides whether the INNER component mounts — a legal
  // hook boundary — never how many hooks this component called.
  const projection = (useProjection ?? (() => undefined))("modelSelection");
  const provider = selectedProviderOf(projection);
  const owned = provider !== undefined && PROVIDER_IDS.has(provider);
  return owned ? h(ActiveComposerPill, { tt, provider, model: selectedModelOf(projection) }) : null;
}

/**
 * The mounted pill: owns the snapshot poller (unconditionally, first hook) and
 * draws the reading. Unmounted wholesale when the session leaves an owned
 * provider, which is also what stops its fetch loop.
 */
function ActiveComposerPill({ tt, provider, model }: ActivePillProps) {
  const { data, error, loadedOnce, updatedAt } = useSnapshotPolling();
  const pools = data?.pools?.pools ?? [];
  const pool = poolFor(pools, model, provider);
  const w5 = pool?.window5h ?? null;
  const w7 = pool?.window7d ?? null;
  const tier = worseTier(tierOf(w5), tierOf(w7));
  const p5 = percentOf(w5);
  const p7 = percentOf(w7);
  const now = Date.now();
  const stale = error !== null || (updatedAt > 0 && now - updatedAt > STALE_AFTER_MS);
  // The "no pool" note is worded for the Raccoon case only (its balance lives
  // in the Raccoon tab). A Token Plan model that matched no pool is either a
  // still-unconfigured account or an empty read — the grey "—" plus the panel
  // tab carries that; the pill does not guess.
  const noPool = loadedOnce && pool === undefined && provider !== TOKEN_PLAN;
  const resetTime = resetFor(w5?.resetAt ?? w7?.resetAt ?? null, now);
  const label = (prefix: string, pct: number | null) =>
    `${prefix} ${pct === null ? "—" : `${pct}%`}`;
  const title = [
    tt("composer.pillTitle"),
    pool?.name ? String(pool.name) : noPool ? tt("composer.noPool") : null,
    resetTime ? `${tt("composer.resetAt")} ${new Date(resetTime).toLocaleString()}` : null,
    stale ? tt("composer.stale") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return h(
    "button",
    {
      type: "button",
      className: "dsh-sensenova-composer-pill",
      title,
      "aria-label": title,
      style: { color: TIER_COLOR[tier] }
    },
    h("span", { className: "dsh-sensenova-composer-pill-dot", "aria-hidden": "true", style: { background: TIER_COLOR[tier] } }),
    " ",
    h("span", { className: "dsh-sensenova-composer-pill-text" },
      label(tt("composer.pool5h"), p5),
      " · ",
      label(tt("composer.pool7d"), p7),
      stale ? ` · ${tt("composer.stale")}` : ""
    )
  );
}

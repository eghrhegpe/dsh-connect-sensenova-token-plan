# 决策账本（ADR）

**为什么有这个文件**：本插件的定位与关键决策改过好几次。此前每次改动都在正文上盖一块「修订（日期）」内联补丁——ARCHITECTURE §5 曾因此叠出多层沉积，新读者把历史读成现行规则，文档被迫按「考古地层」维护。2026-10 起改为：**现行文档只写现状；裁定沿革一律入本账本**。账本条目登记裁定的事实、理由与取代关系，现行正文（ARCHITECTURE.md 等）只引用账本、不内联修订。

## 使用规则

- 一条裁定一个条目：`## ADR-NNN 标题`，块内必有**日期**与**状态**（现行 / 已被 ADR-NNN 取代 / 存档）。
- 改裁定 = 新增条目（标 `取代：ADR-xxx`）+ 把现行文档改写为现状表述；**不在现行正文留内联补丁**。
- 被取代裁定的原文若需要完整保留，进归档文件（本插件目前无此先例；需要时参照姊妹插件 `dsh-connect-agnes-token-plan` 的 `docs/ARCHIVE-BOUNDARY-DECISIONS.md` 形态新建）。
- 门禁：`docs.test.mjs` 检查 `ARCHAEOLOGY` 扫全部非账本文档，命中「日期修订」「修订（二）」「本节裁定已失效」样式的内联考古层即红。

---

## ADR-001 定位从「额度信息面板」转向「大统一」

- **日期**：2026-09-29
- **状态**：现行（不变量正文见 [ARCHITECTURE.md](./ARCHITECTURE.md) §5）
- **裁定**：放弃「只做额度信息、n 个插件分散行动」，转向商汤全过程集成的单点入口——额度 + provider + 出图路由对接 + 429 自愈，逐块 opt-in 吸收；不做多 Key 池（同账号共享额度池，轮换无效）。
- **理由**：同类插件生态（ARCHITECTURE §5.3 核实）已把「其中几块能力做成单包」变成现实；本插件是唯一既知道本 Key 实际能调哪些模型、又常驻 DSH 的组件。此前「商汤全家桶不成立」的判断废止，但爆炸半径教训（PITFALLS §6）收敛为 §5 的三条不变量继续生效。

## ADR-002 边界划线从「Key/认证域」放宽为「厂商归属」

- **日期**：2026-10-01
- **状态**：现行（正文见 ARCHITECTURE §5 不变量 3 与 §5.5 裁定）
- **裁定**：不变量 3 的划线依据，从「只吸收与商汤 **Key/账号线**强相关的能力」（按 Key 域名 / 认证域划线）改为「**只吸收与商汤（SenseTime）产品线强相关的能力**」。该划法会把同一厂商的姐妹产品线误划到界外——Token Plan 控制台与小浣熊（`xiaohuanxiong.com`）同属商汤旗下产品，却走互不相通的两个认证域（实测见 ROADMAP §6.1.1 的两次复测）。界定依据改为**厂商归属**而非域名或认证域，第二上游因此属**界内**。另外两条不变量（opt-in 默认关、凭据红线）不受影响。
- **理由（三条独立举证）**：中证网 2026-07-19（U1 Pro 能力在商汤旗下小浣熊与 Seko 深度验证）、商汤官方稿件 2026-09-21（小浣熊由商汤打造）、本仓库 ROADMAP §6.1 既有措辞。
- **配套收敛（2026-10-02）**：「隔离」指状态与凭据、不指复制代码——两个 publisher 各自 state/开关/凭据引用互不相干，但发布状态机与 adapter 装配共用 `publish-core.ts` / `llm-adapter-core.ts`（见 ARCHITECTURE §5.5 与 PITFALLS §32）。

## ADR-003 路由按资源拆分，先冻结行为再搬家

- **日期**：2026-10-02
- **状态**：现行（结构正文见 ARCHITECTURE §2 routes 家族与 IMPROVEMENTS §9.4）
- **裁定**：`src/host/routes.ts`（875 行单文件）按 token-store 术式拆为 `routes/` 8 模块 + 88 行 facade：`http.ts` 装共享原语（writeJson / 有界 body 读取 / 同源闸 / 方法拒答 / body 上限），snapshot / account / api-key / provider / models / draw / raccoon 各一模块并各自声明路径常量；facade 只留装配与注册顺序。**先冻结行为再搬家**：`routes.test.mjs` + `wiring.test.mjs` + `config.test.mjs` §6b + `raccoon.test.mjs` 单源检查在拆分前后全绿零漂移。
- **理由**：875 行单文件是全仓最大 Host 文件，七个 handler 挤在同一函数作用域；拆出后每个路由可独立阅读/测试，路径常量随资源走（config.test §6b 的 host 侧扫描同步改为扫 `routes/` 目录）。

## ADR-004 maxTokens 从「不声明」改为「声明目录权威值」

- **日期**：2026-10-02
- **状态**：现行（descriptor 决策正文见 `llm-models.ts` 头注决策 2 与 ARCHITECTURE §5.2）
- **裁定**：废除「不声明 maxTokens」旧决策。`dsh-llm-pi-ai`（peer）对未声明的 maxTokens 强制填 `defaultMaxTokens ?? 32768`（resolveRouteModels）——「不声明」的实际效果是输出被截在 32768，比平台声明的上限少一半。descriptor 改为：目录 `max_output_length` 有值则声明为该值、缺值则回落不声明（harness 32768 兜底）；只钉字段名 `max_tokens` 不变。
- **理由（真机探针 2026-10-02）**：flash-lite `max_tokens:131072` → 400「field MaxTokens invalid, should be in [1, 65536]」（目录 65536 是硬上限）；v4-flash / glm-5.2 `max_tokens:131072` → 200（接受翻倍，上限更高）——上限**因模型而异**，故按目录逐模型声明，而非像 Agnes 那样全局钉 65536。探针已进 `test/live-contract.mjs` §2c，证据入基线 `driftLog`。

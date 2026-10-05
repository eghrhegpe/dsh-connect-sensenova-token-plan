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

## ADR-005 构建产物 lib/ 从「gitignore 不入库」改为「版本化入库」

- **日期**：2026-10-03
- **状态**：现行（现行表述见 [ARCHITECTURE.md](./ARCHITECTURE.md) 语言表、`docs/SETUP.md` §2、`docs/DSH-PLUGIN.md` §构建化、`.gitignore` 注释；门禁见 `ci.yml` 的 `build-freshness` job）
- **裁定**：`lib/`（Host ESM bundle + 切分 chunk）与根 `client.js`（Client IIFE）**不再 gitignore，随 `src/` 一起提交**；CI 新增 `build-freshness` 硬门禁——`npm run build` 后 `git diff --exit-code -- lib client.js` 必须为空，并双跑构建比对字节稳定，防止「源码动了却没重生成产物」。发布到 npm registry 的那一份仍由 `prepack` 现场重建，不受影响。
- **理由**：DSH 市场的 `github:` 安装源是 **pnpm git-dep**，pnpm 11 在没有 allowBuilds 批准时**不会**替仓库跑 `prepack`/`prepare`——此前 `lib/` 被 gitignore，用户打 GitHub 仓库地址装出来的插件缺宿主入口 `lib/index.js`，卡片静默失效。兄弟插件 `dsh-connect-qoder`（其 `.gitignore` 的 docs/issues/19）已踩过同一坑并采用同款版本化方案。另：构建产物经实测**字节可复现**（双跑 `diff` 为空），门禁可信。
- **取代**：2026-09-30 的「`lib/` 与 `client.js` 一并 gitignore、产物彻底不入库」方案（原载 [ROADMAP.md](./ROADMAP.md) §6.2，已在该处标注被本 ADR 推翻）。该方案当时依赖「删 lib 可重建」即可，未考虑 github: 安装源不跑 prepack 的现实，故作废。
- **新约定（团队纪律）**：此后改 `src/` 后，除 `npm run build` 重建，必须把 `lib/`、`client.js` 与源码一并提交，否则 `build-freshness` 门禁红。

## ADR-006 状态文件写侧加版本护栏：拒绝覆盖本构建读不懂的记录

- **日期**：2026-10-03
- **状态**：现行（实现见 `src/host/state-store.ts` 的 `readStateVersion` / `isKnownStateVersion` 原语与各 store 的 `writePayload`；降级信号经 `degrade()`，见 [PITFALLS.md](./PITFALLS.md) §37）
- **裁定**：每个带 `version` 的状态文件（catalog / provider / draw / raccoon-switch / throttle）在**写之前**必须先读出磁盘上的 `version`，且当该版本是本构建**不认识**的数字版本时**拒绝写入**——不是覆盖、不是静默跳过，而是 `degrade` 记下原因并把拒绝理由回传给调用方，由调用方决定是否对用户可见。「磁盘上没有 version」与「没有文件」同义（nothing to protect，放行）；只有**本构建读不懂的数字版本**才意味着「这是更新版构建写的」，覆盖它等于销毁自己都看不见的数据。
- **理由**：这些状态文件是**运营态**而非用户配置，跨版本升级/回滚时新旧构建会在同一路径上交替写。「先写后读」的老实做法在回滚场景里会把新版本写的清单或开关静默降级成旧版本认识的形态，用户看不出任何异常——而这类损坏不可逆（文件里没有备份）。护栏本身由 `state-store.ts` 的两个纯函数承载，五个 store 复用同一份白名单原语，不各自实现（IMPROVEMENTS §4.1「用 Host 原语统一」的第一层已在此落地）。
- **取代/边界**：与 §23（[PITFALLS.md](./PITFALLS.md)）的**按 profile 分段**是正交的两件事——分段决定「写到哪个目录」，本护栏决定「能不能写」。二者都只保护写侧，读侧一律「不认识就当没有」（宁可多问一次平台，也不因读不懂而崩）。
- **配套门禁**：ADR 编号被代码引用时必须在账本存在，由 `test/docs.test.mjs` 核对（此前该编号被 `src/` 与 `test/` 引用 27 处却不在账本，正是因为旧门禁只校验条目**形状**、从不校验**存在性**）。

## ADR-007 定位膨胀补上「停止吸收」判据：共享凭据则合并，否则分裂

- **日期**：2026-10-05
- **状态**：现行（正文见 [ARCHITECTURE.md](./ARCHITECTURE.md) §5.6）
- **裁定**：§5 的大统一路线**继续有效**——本插件仍是商汤全过程的单点入口，不推翻、不回退到分层分散行动。但补一条**停止条件**：新关注面按五条顺序问，命中即停——① 共享同一套登录态/凭据→ 留在本插件；② 共享同一额度池 → 留在本插件；③ 能被一条 opt-in 开关关掉且关掉后面板照常→ 才可能吸收；④ 失败会炸到别的关注面 → 不吸收；⑤ 前两条都答不上（既不共享凭据也不共享池）→ **分裂成第二个插件**。第⑤ 条是本次新增的要点：ADR-002 把划线依据从「认证域」放宽为「厂商归属」，解决了姐妹产品被误划界外，但**放宽后的口径若只用来往里吸，就会吸出一个什么都装的插件**。厂商归属是必要条件而非充分条件。
- **理由**：§5 写透了「怎么安全吸收」（三条不变量 + 双重降级 + opt-in），却没写「何时该停」。缺判据的代价不是抽象风险——本插件一度同时是①额度面板 ②LLM provider ③出图工具 ④`ctx.web` search provider ⑤第二上游独立登录五个关注面，每加一个都要新写一遍降级、开关与状态分段。判据方向是**「共享凭据 → 合并」而非「关注面多 → 拆分」**：细化会让每个插件各自重实现降级与状态分段，而 §37 的观测纪律（只给 2 处关键空 catch 加声音）只有在模块同处一个进程时才成立。
- **配套澄清（本轮核实）**：「多插件并行」本身**不是**风险来源——DSH 插件总线按 id 注册，provider 名/ 面板卡 slot / 凭据 owner 各自独立命名，多插件同 Host 进程并存且互不覆盖。本机核实（2026-10-05）：`profiles/web` 同时装载 3 个 token-plan 插件（sensenova / agnes / modelscope），`profiles/desktop` 装 2 个。因此 §5.3 那句「本机这批插件一个都没安装…本机事实上已经只跑本插件」已随本条更新为按profile 分列的实况。真正要防的是**同一件事做两遍**，不是插件数量。
- **与既有裁定的关系**：ADR-001（大统一）与 ADR-002（厂商归属）均不取代；本条为其补「出口」。ADR-005/006 那种「加护栏」的思路同源——判据的价值在于把「该停」变成可回答的问题，而不是靠人的克制。
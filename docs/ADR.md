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
- **裁定**：`src/host/routes.ts`（875 行单文件）按 token-store 术式拆为 `routes/` 8 模块 + 65 行 facade：`http.ts` 装共享原语（writeJson / 有界 body 读取 / 同源闸 / 方法拒答 / body 上限），snapshot / account / api-key / provider / models / draw / raccoon 各一模块并各自声明路径常量；facade 只留装配与注册顺序。**先冻结行为再搬家**：`routes.test.mjs` + `wiring.test.mjs` + `config.test.mjs` §6b + `raccoon.test.mjs` 单源检查在拆分前后全绿零漂移。
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

## ADR-008 挂载期 effect 注册表：unmount 先 drain 后 teardown

- **日期**：2026-10-05
- **状态**：现行（实现见 `src/host/effects.ts`（`createEffectRegistry` / `MOUNT_EFFECT_DRAIN_TIMEOUT_MS`）、`lifecycle.ts` 的 `startSideEffects` 第四参（四个 effect 全部 `effects.add` 注册，vision 段提名为 `publishVisionStepTwo`）、`index.ts` 的 `effects.add("raccoon-seed", …)` 与 unmount cleanup（`await effects.drain(5000)` 后 `teardown`）；门禁见 `test/wiring.test.mjs` 的 unmount-drain 段）
- **裁定**：全部 5 个挂载期 effect（catalog-seed / raccoon-seed / draw-tool / web-search / vision）经 `EffectRegistry` 的 `add(label, run)` 注册——**立即启动**（并发语义与旧 IIFE 完全一致，不阻塞 mount）但按短 label 追踪在途 promise；unmount 时在 `teardown` **之前**执行一次 `drain(5000ms)`：等到仍 settling 的 effect 全部落定或封顶；超限 straggler 带 label 出 warn 并交回既有 disposed 守卫（PITFALLS §18 / §31、P0-1 `65ab2dc` 的 `isDisposed` 检查）。注册表是**记账**而非新安全机制：不新增任何竞态防线，5s 上限保证挂死的 effect 不可能拖死 unmount。
- **理由**：每个被吸收模块自带一个匿名 `void (async () => { … })()` IIFE，竞态面随模块数**组合式增长**——unmount 时 N 个 effect 可能仍在 settling，而没有任何东西观察「哪几个还活着」。现有各守卫（publish 队列的 `disposed` 闩、重试循环里的 `isDisposed` 检查、web-search mount 的 hand-back）在**各自模块内**正确，但共同依赖「dispose 恰好跑赢」。drain 把常态从「dispose 然后祈祷守卫成立」变成「先让它跑完再 dispose」，最坏情况（straggler）行为与今日逐字等价（守卫兜底 + 多一行带 label 的 warn）；顺带补上 `void reconcileWebSearch(…)` 的无 rejection 处理器洞——registry 的 `add` 吞 rejection 并 warn，真因仍落在发生处的日志里。
- **边界**：unmount cleanup 的返回体由同步 `() => void` 改为 `async () => Promise<void>`——Cordis fiber 对 thenable 的 disposer 结果完整 await（cordis 源 `fiber.ts` 的 `runDisposable` 语义，本机 unpack 版已核），故 `wiring.test` 的 `await stop()` 后断言 teardown 已执行的用例不受影响。drain 上限 5000ms 取自 raccoon-seed 的 `retryBounded` 最坏节奏（6×300ms 线性退避 ≈1.8s + 一次目录 fetch）再加裕量；门控 timer **不** `unref`（首轮实现曾 unref，实测在事件循环空载时 5s 上限永不触发、drain 的 TLA 永不安定——Node host 关闭时序下 unmount 会挂死，比测试进程多活 5 秒严重得多），代价仅是「unmount 发生在进程退出前」时多一个至多 5s 的 ref timer。

## ADR-009 vision 判定采用「双向实测覆盖」：目录 tags 是声明，可能两个方向都错

- **日期**：2026-10-06
- **状态**：现行（实现见 `src/host/raccoon-catalog.ts` 的 `RACCOON_VISION_WHITELIST` / `RACCOON_VISION_DENYLIST` 与 `raccoonRowVision` 的三级优先级；离线门禁见 `test/raccoon.test.mjs` 的双向覆盖 / 集合互斥 / fallback 表一致 / 基线对齐四组断言；实测复核见 `test/live-raccoon.mjs` 的 L2e 段与基线 `test/baselines/raccoon-contract.json` 的 `visionProbe` 块）
- **裁定**：小浣熊网关目录 `tags` 里的 `vision` 声明**既会漏报也会错报**，故 vision 判定链固定为三级：**实测否决集 → 实测白名单 → 行内声明**。两个集合的成员资格都是**带日期的实测结论**（加入要真探针，移除同样要真探针），并由 live 层每次复探——测量没有复探路径就会退化成信念。声明那一级继续保留为兜底梯子（`tags` → 旧 `vision` 布尔 → 旧 `input_modalities`）。
- **理由**：2026-10-06 的一条用户直觉报告（「glm-5.3 不能看图却显示可以看图，glm-5.3-flash 可以看图却显示不能看图」）实测成立，而且是**方向相反的两条同时出现**。同一轮、同一份请求体（标准 OpenAI `image_url` + data URL、240×120 四条竖条）：`sn-glm-5-3-flash` / `sn-kimi-k3` / `sn-deepseek-v4-1-flash` 全部读对，`sn-glm-5-3` 在 sync、图片在前、`stream:true` 三种形态下一律回「无法查看图片（当前环境不支持图像识别）」。载荷形状因此被排除，问题在网关给该 id 挂的后端。修前的机制只有单向白名单（只能把**漏报**纠正成「可看图」），**错报没有任何表达位**——而错报的代价与漏报不对称：漏报只是能力被选择器藏起来，错报是**把用户的图片发给看不见它的模型**，网关对这种情况回 **HTTP 200** 再由模型自述看不见，上游没有哪一层报错。
- **边界**：本条只管小浣熊这一条标签通道。Token Plan 侧（`identifyVisionModel` 按 `/v1/models` 的 `input_modalities` 判定）是另一个上游、另一套声明字段，不受影响；两侧判定函数依旧不合并。`RACCOON_FALLBACK_MODELS` 快照表里的 vision 列**不是**目录快照的一部分，而是随本条一起改为实测值（那 6 行是已归一化的行，不经过判定函数），由离线一致性断言看住。
- **复核条件**：`sn-glm-5-3` 是被**路由**到看不见的后端（同 payload 其余模型读得出，故非载荷问题），所以网关哪天改路由，L2e 会红——那时删掉否决集条目、同步基线 `visionProbe.expected` 与 fallback 表即可，不必重写判定链。
- **取代**：[ROADMAP.md](./ROADMAP.md) §6.1.6 末句「`sn-glm-5-3-flash` 仍 `vision:false`（tags 无 vision、未实测，不猜）」由本条取代。那句当时是正确姿势（不猜），今天补上了实测；ROADMAP 已是冻结档案，照冻结纪律不回头改它，结论落在这里。

## ADR-010 token-store 注释只砍「搬家叙述」，不砍不变式与教训

- **日期**：2026-10-19
- **状态**：现行（实现见 `src/host/token-store/` 七个文件；行为零变化，守它的仍是 `test/store-baseline.test.mjs` 的 17 场景 / 48 帧冻结基线 + 全量 34 套件）
- **裁定**：`src/host/token-store/` 的注释占比实测 **54.7%**（1136 行里 621 行注释，`docs/issues/P1-STRUCTURAL-BACKLOG.md` 原记 48%）。瘦身只动一类：**搬家叙述**（「Block N of the split」「Functions moved here are verbatim」「this used to read …」「what `createTokenStore` used to do」）。不变式、红线理由、迁移键语义（`THROTTLE_MARKER` / 旧记录的「read for MIGRATION ONLY」）一律不动。
- **理由**：台账把这一点描述为「48% 占比里大量『当初为什么没这么写』是 git/ADR 的活」，逐块读下来该判断**只对了一半**：绝大多数注释是**防回归理由**——fail-open 的清除闸为什么必须区分「读失败」与「记录不存在」、`rejected` 集合为什么存在、throttle 的写失败为什么故意落到内存、凭据服务为什么每次使用都重新 resolve。删掉这些等于把「改回去会怎样」从代码点挪进一份没人会翻的 log，是净损失。真正只描述「文件怎么搬过来」的段落实测 **31 行**（1136→1105 总行、621→590 注释行，占比 54.7%→53.4%），删掉零知识损失。
- **边界**：本轮不动其他已收编文件的注释（`state-store.ts`、`web-search.ts`），也不把行数当 KPI——瘦身后 `token-store/` 仍以注释为主，那是这类凭据状态机的合理形态。
- **复核条件**：后续若有人以「注释太长」为由继续删，先问被删段落是否回答了「改回去会怎样」。回答了就不能删，只能压缩措辞。

## ADR-011 不为行数拆分 `wire.ts` / `qr.ts`

- **日期**：2026-10-19
- **状态**：现行（`src/host/wire.ts` 104 行、`src/host/qr.ts` 509 行，均保持单文件；守它们的是 `test/docs.test.mjs` 检查 8 的 `SnapshotData` ↔ Host 构造块双向一致、`test/raccoon.test.mjs` §7 与 `test/typecheck-gate.mjs`）
- **裁定**：两者都**不拆**。`wire.ts` 里 raccoon 专属的那一段不是「分叉」，是组装点：它是共享层与 Host 的契约面，拆开只会把一份契约切成两个必须同步的文件。`qr.ts` 已经切到「每一段只被下一段调用一次」的粒度，再切只会切出一次性辅助函数。
- **理由**：拆分的收益是「文件短了」，代价是「多一个 import 边界 + 一个需要文档与门禁追踪的新文件」。本仓库更划算的方向已被证明是**收敛重复的读侧/写侧脚手架**（`switch-store.ts`、`state-store.createVersionedJsonWriter`），而不是按行数切分。
- **边界**：本条只管「以行数为由的拆分」。若 `qr.ts` 需要支持第二种码制、或 `wire.ts` 需要承载第三类上游，重组属于另一条裁定。
- **复核条件**：`qr.ts` 超过 800 行，或 `wire.ts` 出现两个互不相关的契约段（不再只是「主注册 + 一个上游」）时重开。

## ADR-012 `web.searchProviderId` 的根因交由上游，本地只留 Option B

- **日期**：2026-10-19
- **状态**：现行（防御性补丁实现见 `src/host/web-search.ts` 的 `applyWebSearchSelection`；门禁见 `test/raccoon-web.test.mjs` 的「外来 provider 占用 → 拒绝接管、模块缺席」用例）
- **裁定**：本插件**不再**尝试自己解决「凭什么由我改全局搜索选择」这个问题。已落地的 Option B 只是防御姿态：只在槽位为空（`undefined`）或本插件已持有时接管；外来 provider 占用则拒绝、整个模块缺席。真解法必须由宿主提供 **plugin-owned 的选择面**（或让插件注册为候选、由用户显式选择），那部分超出本仓库的边界。
- **理由**：全局 `searchProviderId` 是宿主的一份单值状态，插件单方面写入必然是零和——写进去那一刻就替用户做了选择，而 teardown 的归还逻辑只能表达「我顶掉了谁」，无法表达「我们俩都该在」。Option B 把风险收敛到「不抢别人的」，但没有消除域归属问题本身。
- **边界**：本条不否决宿主未来给出的选择面；届时把 `applyWebSearchSelection` 换成注册式调用即可，不需要重写 provider 发布链。
- **复核条件**：宿主 API 出现插件级选择面（或 `searchProviderId` 改为可多值）时重开。在那之前，任何「再包一层 try/catch」的补丁都属于重复解决同一个问题。

## ADR-013 lifecycle 的搬家裁定：按邻聚拆，门面不动 import 面

- **日期**：2026-10-21
- **状态**：现行（实现见 `src/host/lifecycle.ts` 门面块与 `src/host/draw-mount.ts`；门禁见 `test/draw.test.mjs` 的 degrade-marker 栅栏——两处 catch 的锚点已随住址改指 `draw-mount.ts`，检查名不变）
- **裁定**：`registerDrawTool` 本体（含 `DrawToolWiring` / `DrawFetchResponse`）搬出 `lifecycle.ts` → `draw-mount.ts`；`resolveServiceWithRetry` 的有界重试搬去 `util.ts`，坐在 `retryBounded` 旁边。`lifecycle.ts` 保留门面：全部外名照常从这里 re-export，import 面零改动。`web-search.ts` 此前对 `lifecycle.ts` 的那条刻意 import 环，随助手迁 `util.ts` 而消失。
- **理由**：拆的依据是**内聚，不是行数**——ADR-011 拒绝过「为行数拆」，这次同样不是行数：是第二个上游与出图工具先后住进来之后，lifecycle 成了「谁都得往里塞一块」的杂物间。先例两条：ADR-003 的路由拆分（先冻结行为再搬），以及 `web-search.ts` 早先同型的门面拆分——本条把那个模式收编命名。degrade-marker 测试栅栏与代码同批改指新住址，保证搬家始终有闸盯着「静默失败纪律没被搬丢」。
- **边界**：`startSideEffects` 仍收完整 `Wiring` 包（effect 装配者：把各 handler 的 Pick 并起来≈全集，收窄只是数字游戏）；teardown 顺序（PITFALLS §18）一字未动。
- **复核条件**：门面哪天出现「转发别名」（re-export 时改名）时收掉门面，让调用方直连真住址——门面存在的唯一意义是 import 面不变，名字都要转发的门面只剩指路成本。

## ADR-014 考古纪律扩展到 src/ 注释：红的是搬家叙述，不是日期

- **日期**：2026-10-21
- **状态**：现行（门禁见 `test/docs.test.mjs` 检查 12 的 src/ 扫描）
- **裁定**：ADR-010 的「现行正文禁内联修订补丁」不只管 docs：**src/ 代码注释里「某日从前一个文件拆出／搬到此址」式搬家叙述为红**。模块头部写当下的职责与邻接关系，「何时拆的、为什么那天拆」进本账本。实测/probe/验证/复核日期**不在打击面**——那些是证据不是考古，删掉反而毁掉承重信息（`llm-models.ts` 的 probe 日期、`raccoon-catalog.ts` 的验证日期都属此类）。
- **理由**：docs 早有 ARCHAEOLOGY 闸，src 却一直没人管：本轮改造清点了 9 个文件共 12 行「带日期的搬家叙述」（`raccoon-auth/catalog/codes/consts/http.ts` 五块协议模块头、`raccoon.ts` 桶头与 `raccoon-fallback.ts` 两处、`composer-usage-pill.ts` 三处日期补丁、`quota-bar.ts` 的 Extracted 句），全部改写为现在时。它的病和 docs 那份同构：把来历当现行信息，下一次再拆之后句子就烂成真不了伪的坏坐标——新读者会按注释去已搬空的旧住址找东西。门禁只列这 12 行真实出现过的四个形态（`Split out of the former` / `Extracted 20xx` / `（YYYY-MM-DD 落地|修）` / 标题后 `(YYYY-MM-DD)`），不搞「凡带日期皆红」——判据收窄到能被现有注释逐个对照验证，误伤面为零，将来要扩也要有实例才动。
- **边界**：只扫 `src/**/*.ts`；docs/ 各表的沿革注记（如 `ARCHITECTURE.md` 拆分行的日期、`PROVIDER-HOT-RELOAD.md` 变更表）是台账性质，保留；测试套件里引用搬家史的注释与检查名不受检。写新拆分时正确落点是加 ADR 条目，不是在头部留日期。
- **复核条件**：哪天出现第五种搬家叙述形态、或有人真需要按日期考古，按实例扩清单，不预先放宽任何一条。

## ADR-015 多上游的身份边界：一条路由一个 provider id，章不得共用

- **日期**：2026-10-21
- **状态**：现行（实现见 `src/host/llm-models.ts` 的 `assertProviderOwnership`、`src/host/llm-adapter-core.ts` 的 `assemblePiAiAdapter` 首行调用；门禁见 `test/provider.test.mjs` 第 15 段 5 条）
- **裁定**：本插件两条上游路由继续各持一个 provider id（`sensenova-token-plan`、`sensenova-raccoon`），且每个 descriptor 的 `provider` 必须等于它所属路由注册的那个 id。**禁止**引入跨上游共享的 identity 常量。该不变式在装配期由 `assertProviderOwnership` 强制：不符即抛错——拒绝分支，不是补偿分支；不 warn、不自动改写。
- **理由**：DSH 里「身份」有两个来源。assistant 消息的 `source.provider` 来自解析到的**路由 id**；`replayState.response.provider` 抄自 descriptor 的 `provider` 字段。宿主重放校验比对二者，不等即把该条 assistant 消息降级为外来消息（`api` 变 `dsh-foreign`），pi-ai 随之把其中的 thinking 块当正文重放。所以「多条路由共用一章」的代价不是某次请求报错，而是那条路由的**每一轮历史都静默降级**，日志里没有任何 error。本机对同类插件的一份扫描（179 会话 / 13,951 条 model 消息 / 11 个 provider）给出了量级：共用 identity 的那条 global 路由 1,332 条消息**全部**分叉（章 `workbuddy` ≠ 路由 `workbuddy-global`），而同机其余 10 个 provider 全部同名通过。该扫描只作判据证据，不在本插件的改动范围。ADR-007 的「共享凭据则合并，否则分裂」管的是插件级归属；本条是它的 provider 级同源推论：**同一插件内不共享凭据的两条上游，也不共享身份**。
- **边界**：`toPiDescriptor` / `buildDescriptors` 的 `providerId` 默认值（`LLM_PROVIDER_ID`）**保留**。约十五处离线测试在验过滤、去重、视觉识别等与身份无关的行为，强制传参只会给它们添噪音，且默认值本身不会把错误章发到 Host——真正注册的 descriptor 必经 `assemblePiAiAdapter`，两个上游共用这一个入口。守卫因此落在装配期而非构造期：构造期的默认值是测试便利，装配期才是上线路径。
- **复核条件**：若 DSH 改为按 descriptor 的 `provider` 统一记 `source.provider`（两侧同源、不再比对），本条可撤销。在此之前，新增上游一律先申请新 id 再走同一个装配函数。

## ADR-016 小浣熊识图改为「默认放行 + 实测否决」：把未实测从静默变成可见

- **日期**：2026-10-22
- **状态**：现行（实现见 `src/host/raccoon-catalog.ts` 的 `raccoonVisionVerdict`——返回 `{ vision, source }`，`RaccoonVisionSource = "measured" | "declared" | "assumed" | "denied"`；`fetchRaccoonCatalog` 的行带 `visionSource`；`src/shared/wire.ts` 的 `RaccoonModel.visionSource`；面板鉴别见 `src/client/raccoon-roster.ts` 的 chip 与 `src/client/i18n.ts` 的 `llm.rosterVisionAssumed` / `llm.rosterVisionAssumedTitle`。门禁：`test/raccoon.test.mjs` 的 provenance 断言、`test/render.test.mjs` 的三条 chip 断言）
- **裁定**：判定链四级，且**末级是「放行」**：`实测否决集 → 实测白名单 → 行内声明 → 默认假定可看图（assumed）`。否决集是唯一说「不」的一级；白名单不再是开关，而是 **provenance**（`measured`）。面板只说它知道的事：`measured` / `declared` 打「可看图」，`assumed` 打「可看图·未实测」并带解释性 tooltip，`denied` 不打 chip。
- **理由**：2026-10-22 实测，网关目录把 `sn-deepseek-v4-1-flash-1017`（`description: DeepSeek-V4.1-Flash-1017`、限免至 10-31、`effective_multiplier` 0）与旧 `sn-deepseek-v4-1-flash` **并列**挂出，新行的 `tags` 与旧版同为一组无 vision 的标签；用户贴图时图片入口整条消失、面板不报任何错（默认拒绝的失效形态：能力缺失是静默的，只有当人主动报告才被发现）。同一张四条竖条图同一条问题，该 id 读对 4/4。同一天的 7 个可见 chat 模型里，能看图的**要么有标签、要么已实测**（`sn-glm-5-3` 仍是唯一实测瞎子，留在否决集），也就是说「默认拒绝」在今天的目录上没保护任何东西，却会在网关每次加新模型时制造一次静默缺失。
- **代价与护栏**：默认放行把失效方向翻到「错报」——但本网关的错报是**可观测**的：HTTP 200 + 模型自述看不见（2026-10-06 已实证，ADR-009），且面板已把那行标成「未实测」，用户不会把插件行为误读成模型能力。否决集因此成为唯一维护面：模型自述看不见，就把 id 带日期实测后加进去；`test/live-raccoon.mjs` 的 L2e 继续对两集合成员复探。
- **边界**：只动小浣熊判定。Token Plan 侧 `identifyVisionModel`（按 `/v1/models` 的 `input_modalities`）不动，两侧判定函数依旧不合并；`RACCOON_FALLBACK_MODELS` 的 vision 列仍是手写实测值、不经判定函数；`visionSource` 只供面板显示，`raccoonToDescriptor` 的 `input` 数组仍只由 `vision` 布尔决定。
- **取代**：ADR-009 的「三级判定链」中第三级之后的**隐式 default-deny** 由本条翻转；ADR-009 其余部分（双向实测、否决集的存在、L2e 复探、两集合互斥、fallback 表一致性）继续现行。
- **复核条件**：若网关出现「拒绝图片会**报错**而不是让模型自述」的形态（HTTP 4xx/5xx），默认放行的代价就换成整轮失败，届时要把默认翻回拒绝，并在面板显式给出「未实测」入口，而不是继续静默放行。

## ADR-017 网关新增模型走胶囊的「· N 新模型」，不弹窗、不留确认态

- **日期**：2026-10-22
- **状态**：现行（实现见 `src/host/raccoon-roster-seen-store.ts` 的首次见到历史、`src/host/raccoon-status.ts` 在 live 目录上做 diff 后回 `newModelIds`、`src/shared/wire.ts` 的 `RaccoonState.newModelIds`、`src/client/composer-usage-pill.ts` 的 `RaccoonPill` 第三段与 tooltip。门禁：`test/raccoon.test.mjs` 的「8b. the first-sighting history」、`test/raccoon-status.test.mjs` 的「E2. the roster's first sighting」、`test/render-dom.test.mjs` 胶囊段的三帧）
- **裁定**：三处一起钉死。**承载面**是输入框右侧额度胶囊读数字的第三段（`· N 新模型`）+ tooltip 与 popover 行都只列**前三个**名字（余下用省略号，两处同一截断口径），不弹窗、不新增 chip。**新鲜度**只由持久化的「首次见到时间」决定（`raccoon-roster-seen.json`，7 天窗口），没有「已读/确认」手势。**措辞**说「本机首次见到的模型」而非「网关新增模型」——网关没有「上架时间」字段，插件知道的只是本机第一次见到该 id 的时刻，标成「网关新增」是替插件陈述一个它无从得知的网关事实（与 ADR-016 反的是同一种过度声明）。**首次写入（SEED）**按「已过期」戳记录全量名单，announce 零条。**名单上限不是队列而是形状漂移闸**：roster 大于上限时**不写、不报**（详见下），而非「保留最新 N 条」。
- **理由**：DSH 的 Host Service 目录里没有 notification/toast 服务（2026-10-22 对全量 Service 清单查过，无命中），插件能碰到的可见面只有插件卡面板与输入框胶囊，弹窗要么自建要么没有——自建一套通知的成本远大于它唤起的注意力。更关键的是这次事故（ADR-016）的教训不是「没提醒」，而是「无 vision 标签的行被静默判成纯文本，图片入口整条消失」；默认放行之后图片入口本来就存在，新增模型的信息价值从「救错误」降级成「发现新品」。发现新品应当**可忽略**：常驻在胶囊上，扫一眼就有，不打断手头的事。7 天窗口取自「网关 refresh 周期未知 + 一周内总会开一次面板」的保守覆盖；不做确认态是因为它要再存一份用户手势状态，却只影响一句话是否继续显示——用时间窗替代手势，状态机少一半。**上限用「漂移即不报」而非「裁掉最旧 N」**：裁掉一个仍在名单里的 id，会让它下一轮查不到旧戳、盖上新鲜 `now`、重新报新——而每轮被裁的集合轮换，「新」计数会震荡甚至增长（实测 250 名单对 200 上限，逐轮 50→100）。一个会凭空造出新模型的账本比没有账本更糟。
- **代价与护栏**：网关短暂回退名单会让看过的模型重新报新；标记不改变任何请求行为，7 天后自愈，所以代价可接受。真正要防的是**升级时的整张名单谎报**，护栏就是 SEED 的过期戳（按 `now` 记会让全名单在 7 天内都显示为新增）。**SEED 的诚实性以「首个 live 读代表完整目录」为前提，而这一条没有任何检查**：若升级后首次 live 读恰赶上网关返回子集，缺席的 id 拿不到过期戳，目录补全时它们会拿到真实 `now` 戳、被误报为新。这是一个**会自愈的窄窗口**（7 天 + 仅首读截断时触发 + 只影响一处低价值提示），用一个「seed 前目录条数下限」的启发式去堵反而可能让正常的小目录永不 seed——代价不划算，故显式认领而非设闸。若历史文件不可读（损坏、外来版本），标记缺席而面板照常——与 `raccoon-provider.json` 同一条 ADR-006 纪律：读容忍、写拒绝，绝不覆盖别的版本；`raccoon-status.ts` 吞掉写失败退化为「无标记」，绝不退化为「错标记」。
- **理由**：DSH 的 Host Service 目录里没有 notification/toast 服务（2026-10-22 对全量 Service 清单查过，无命中），插件能碰到的可见面只有插件卡面板与输入框胶囊，弹窗要么自建要么没有——自建一套通知的成本远大于它唤起的注意力。更关键的是这次事故（ADR-016）的教训不是「没提醒」，而是「无 vision 标签的行被静默判成纯文本，图片入口整条消失」；默认放行之后图片入口本来就存在，新增模型的信息价值从「救错误」降级成「发现新品」。发现新品应当**可忽略**：常驻在胶囊上，扫一眼就有，不打断手头的事。7 天窗口取自「网关 refresh 周期未知 + 一周内总会开一次面板」的保守覆盖；不做确认态是因为它要再存一份用户手势状态，却只影响一句话是否继续显示——用时间窗替代手势，状态机少一半。
- **代价与护栏**：网关短暂回退名单会让看过的模型重新报新；标记不改变任何请求行为，7 天后自愈，所以代价可接受。真正要防的是**升级时的整张名单谎报**，护栏就是 SEED 的过期戳（按 `now` 记会让全名单在 7 天内都显示为新增）。若历史文件不可读（损坏、外来版本），标记缺席而面板照常——与 `raccoon-provider.json` 同一条 ADR-006 纪律：读容忍、写拒绝，绝不覆盖别的版本。
- **边界**：只在小浣熊 provider 被选中时出现（Token Plan 名册没有该字段，也不做跨上游的「新品」概念）；diff 只对 `modelsSource === "live"` 的目录做——fallback 六行是本插件自己的文本，拿它当基准等于把自家行报成网关新闻；`newModelIds` 缺失（旧生产者、离线）时面板不画任何东西；胶囊之外不通知（面板不重复，避免同一事实两处口径）。
- **复核条件**：若网关给出模型上下架的时间戳或公告字段，用网关事实替换本地首次见到时间（本地钟不可信、跨设备不一致，那正是本条最大的近似）；若 DSH 上线通知服务，可把同一事实接过去，胶囊仍保留为常驻面。撤销本条不动其余裁定。

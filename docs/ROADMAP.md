# 路线图（Roadmap）

> 本文承接 [ARCHITECTURE.md](./ARCHITECTURE.md) §5「大统一」定位变更，是**执行层面的时间序列与优先级**，不是重复定位。§5 负责「我们是谁、边界在哪」，本文负责「下一步做什么、按什么顺序、侵入性如何、门禁怎么过」。
> 依据：[AGENTS.md](../AGENTS.md)（验证裁剪、红线）、[TESTING.md](./TESTING.md)（docs.test.mjs 防孤儿文件 / 防跨文件重复表）、[PITFALLS.md](./PITFALLS.md)。
> 研究档案：[IMPROVEMENTS.md](./IMPROVEMENTS.md) 是设计问题的**研究上游**（诊断 + 证据 + 投入/风险比）；本文只记**执行状态**——标 ✅ 章节的实施进展以本文为准，研究文件里残留的「已落地」注记只是写下当时的历史时间点，不随实现继续更新。

## 0. 已锁死的前提（来自 §5，这里不复制其表）

- **三条不变量**：每个新模块 opt-in 默认关；凭据红线不动；只吸与商汤 Key / 账号线强相关的能力。
- **能力事实**：本插件**可**向 DSH 注册推理 provider（`sensenova-token-plan`）。它是否成为某台机器的默认推理通道，由该机的 profile 与用户模型选择决定，**不随插件注册自动成立**（`agent-default-model` 是宿主的选择记录服务，见 [IMPROVEMENTS.md](./IMPROVEMENTS.md) §1.2 的撤销注记）；一旦某 profile 真的把它选作默认模型，故障域就从「Plugins 页里的只读面板」升级为「推理可用性」，这是**条件性**的爆炸半径，不是既成事实。
- **角色**：从「只下发信息」升级为「信息 + 执行」，但每块执行都挂在三条不变量下。

## 1. 对 §5 的一处纠偏：429 不做多 Key 池

§5 原写「429 自愈 + 多 Key 池进插件」。经查证需要修正：

- **事实**：SenseNova Token Plan 是**同一账号共享额度池**，换 Key 不换池 → 多 Key 轮换对该路线是**伪解**（这也是 §5 早已写「不碰 `st-rotator` 多 Key」的同源理由）。
- **决策**：吸收 `st-rotator` 的两条纪律——① 先分诊「限频（可退避）vs 配额不足（别空转）」；② 降速退避而非继续冲——但**不吸收多 Key 池化**。
- §5 的「拟吸收」行已据本文件改为「429 自愈（退避 + 分诊），不做多 Key 池」。

## 2. P0：`index.js` 控制面解耦 + 商汤契约自动化回归 ✅ 已实现（2026-09）

> 来源：2026-09 锐评结论，研究论证见 [IMPROVEMENTS.md](./IMPROVEMENTS.md) §2（接线复杂度诊断的完整证据链）。两个 P0 先于任何「继续吸收」——§0 已承认本插件
> 可注册推理 provider（是否默认通道由 profile 决定），`index.js` 1187 行里同时挂着
> 5 条路由 + `providerState` 状态机 + `publishChain` 串行化 + 两个 fire-and-forget IIFE
> （catalog seed、draw 注册），复杂度已溢出：注释越解释越拆不动。再谈下一块吸收之前，
> 先把「控制面」和「契约护栏」立住，否则吸收越快、爆炸半径越大。
>
> **落地状态（本节完成时）**：§2.1 抽 `provider-publish.js` + `snapshot-aggregate.js`，
> `index.js` 从 1187 行瘦到 778 行（wiring F3 经新模块注入仍全绿）；§2.2 落
> `test/contract.test.mjs`（77 项，进 `npm test`）+ `test/baselines/sensenova-contract.json`
> （冻结 2026-09-29 实测）+ `test/live-contract.mjs`（`npm run test:live:contract`，手动档）。
> 离线全量 12 套件 + e2e-gate 全绿。

### 2.1 拆 `index.js`：控制面状态机独立成模块

**现状**（`index.js`，2026-09 实测）：`providerState` 8 字段 + `publishProvider` /
`publishProviderOnce` / `registerPair` / `releaseProvider` / `catalogSignature` 全内联在
`apply()` 闭包里；路由 handler 直接读写 `providerState`。`test/wiring.test.mjs` 的
F3（并发 publish「最后发起者最终注册」门控）依赖对 `index.js` 内部状态的注入，
所以拆之前必须先给状态机一个可注入的边界。

**做法**（peer-free，离线可测，与 `llm-retry.js` 同纪律）：

| 步骤 | 内容 | 门禁 |
|---|---|---|
| ① 抽模块 | 新建 `provider-publish.js`：`createProviderPublisher({ settings, panelSwitch, loadAdapterModule, getLlm, onEvent, logger })` 返回 `{ publish, release, dispose, state }`；内部持有 `publishChain` / `disposed` / `registerPair` 单点定义（PITFALLS §18/§19 语义原样迁移） | `test/wiring.test.mjs` F3 改为对新模块注入（gate 语义不变），原 F3 红→绿即完成 |
| ② 瘦 router | `index.js` 只留路由 handler + 快照组装 + 各 store 接线；`providerState` 改为 `publisher.state` 只读引用；目标 `index.js` < 700 行 | `test/routes.test.mjs` + `test/provider.test.mjs` 全绿；快照 14 键契约零改动（`docs.test.mjs` §5 门禁） |
| ③ 第二个 IIFE 收编 | draw 注册（`index.js:558-597` 的 `void (async () => {...})()`）改走 publisher 的 `onEvent` 钩子或独立 `draw-register.js`，与 ① 同批评审 | `test/draw.test.mjs` 全绿；快照契约仍零改动（工具缺席时 14 键不变） |

**不变量**：① 并发语义（`publishChain` 串行、`disposed` 闸、慢者赢修复）与 ② 回滚语义
（`registerPair` 单点、factory 结果 await + 形状校验）必须**原样**迁过去，不是重写；
`test/wiring.test.mjs` F3 是钉死并发语义的最后一道测试，拆完它必须仍红能抓同样的竞态。
**完成判据**：`index.js` 无 `providerState` 字段声明、`index.js` 行数 < 700、
wiring/routes/provider/draw 四套件全绿、e2e-gate 通过。

### 2.2 商汤契约自动化回归（把 §20/§21 的实测从一次性变可复跑）

**现状**：ROADMAP §0 引用的「40+ 实测请求」与 `PITFALLS.md` §20/§21 的方言表
（thinking 形态、`reasoning_effort` 取值、采样规则、404/403 模型清单）全靠 2026-09-29
一次性手工实测维持，`docs/SENSENOVA-API.md` §7 是注释层，**没有自动化护栏**——
商汤下次改一个 400 语义就又是一轮 40 请求。`test/live-jwks.test.mjs` 已证明
「live 档不进 `npm test`、手动 `npm run test:live`」这套纪律在本仓库可复用。

**做法**（与 `live-jwks` 同型：离线骨架进门禁，live 重放手动跑）：

| 档 | 文件 | 内容 | 门禁 |
|---|---|---|---|
| 离线 | `test/contract.test.mjs`（进 `npm test`）+ `test/baselines/sensenova-contract.json`（冻结 2026-09-29 实测：9 模型的 thinking 形态 / reasoning_effort 支持面 / 采样参数 / `context_length` / 模态 / 404-403 标记） | 断言 `llm-models.js` 的 `toPiDescriptor` / `identifyVisionModel` / `isChatModel` / `exhaustedModelIds` 对契约表的输出与冻结值一致；`parsers.js` 对契约表的解析结果；`codes.js` 的 reason 折叠对 429/quota 文案的分类。契约表改动必须附「平台响应原文」证据（提交约定） | `npm test` 全绿 |
| live | `test/live-contract.mjs`（不进 `npm test`，`npm run test:live:contract`） | 对 `token.sensenova.cn/v1/models` 发 1 请求核对 9 模型目录仍含冻结字段（模态 / context_length / max_output_length / supported_sampling_parameters）；推理端点按契约表**每格 1 请求、限流友好**（每格失败记漂移不重试），红 = 平台方言漂移，修法走 `SENSENOVA-API.md` §7 注释层，不静默改代码 | 手动 / CI best-effort（同 `live-jwks`） |
| 探针纪律（2026-09-30 扩） | 推理探针扩到 `reasoning_effort: low/medium`（每模型 2 请求、2s 退避）；**429 是节奏答案不是参数判读**——探针记 INDEFINITE、不计入失败、退出码 0，只有 4xx 参数拒绝才算「平台不支持」的负证据；探针结果**人工**写回冻结契约（`driftLog` 留平台响应原文），不自动改 `llm-models.ts` | 同上；首跑（2026-09-30 22:11）实锤 9 格 200，4 格 INDEFINITE 待重跑 |
**完成判据**：`test/contract.test.mjs` 进 `package.json` 的 `test` 脚本链；
`test/baselines/sensenova-contract.json` 字段与 `SENSENOVA-API.md` §7.5 逐模型表一一对应；
live 档在 `package.json` 加 `test:live:contract` 脚本（与 `test:live` 并列）。

### 2.3 顺序约束（防漂移）

- §2.1 与 §2.2 **互不依赖，可并行**（不同文件域：§2.1 碰 `index.js`/`wiring`，
  §2.2 碰 `test/`+`package.json` 脚本）；但**都先于**任何「继续吸收」
  （§6.1 raccoon 机制点、§5 doctor、§6 明确不做清单之外的新模块）。
- §2.1 完成前，**冻结「大统一」下一块吸收**——`index.js` 还挂着 5 路由 + 2 个
  IIFE 时再加模块，会重演 PITFALLS §18「慢者赢」的并发陷阱面。
- §2.2 的 live 档失败**不是回归**（同 `live-jwks` 纪律）：平台改字段时它红，
  修法是更新 `test/baselines/sensenova-contract.json` + `SENSENOVA-API.md` §7 注释，
  不是改 `llm-models.ts` 逻辑去迁就平台。
- §2.2 冻结的事实是**套餐层级相关**的（PITFALLS §20 自认部分模型 403 未实测、
  `reasoning_effort:"max"` 仅 glm 实测通过）：契约基线保的是「本机这把 Key 的世界
  没漂移」，不是「所有套餐都对」。分发到其它套餐的用户首遇方言差异时，修法走
  `SENSENOVA-API.md` §7 注释层 + 基线增行，不静默改 `llm-models.ts`——live 档
  只在作者机器有护栏，这一层保护随大统一分发而变薄，吸收新模块前先记住这一点。

## 3. 旗舰刀口：429 自愈（全局级，低侵入）✅ 已实现

> 研究论证：[IMPROVEMENTS.md](./IMPROVEMENTS.md) §3（peer 语义耦合的诊断与契约护栏选项）。

### 3.1 配置粒度结论（已查证代码）

| 检查点 | 结论 |
|---|---|
| `retryPolicy` 落点 | `llm-adapter.js:127` 唯一 `profiles` 条目（`LLM_PROVIDER_ID`），**provider 全局级**，非 model 级 |
| descriptor 是否带 per-model retry | `llm-models.ts` `toPiDescriptor` 无 retry/quota 字段，全局策略即全 model 一刀切 |
| quota 数据源粒度 | `parsers.ts` `parsePools` 每个 pool 带 `modelIds`，额度是 **pool 级归组**，model 级差异化无数据支撑 |
| 推论 | 保持**全局** retry 策略（最低侵入）+ **per-model 可用性标记**（descriptor 重建时按 pool 耗尽打标） |

per-model 可用性标记即用户要的「清单自带识别」——但它是 **availability 信号**，不是 retry 配置，不碰 peer 钩子，随 `publishProvider` 重建即生效。

### 3.2 落地分层（peer-free 与 peer 依赖分离）

> spike 已查实：429 的「配额超限 vs 限频」**分类已由 peer 完成**，不需要我们重写。
> `dsh-llm-pi-ai/lib/index.js:1376` 的 `classifyPiAiError` 把 429 消息分成
> `QUOTA_EXCEEDED_CODE`（`isQuotaExceededError`）与 `RATE_LIMIT`（正则 `\b429\b|rate.?limit`）。
> 因此我们的工作只剩两件：**(a) 决定这两类错误的重试策略**；**(b) 把 pool 状态转成模型可用性**。

> ⚠️ **纠偏（2026-09-30 实测）**：上述 spike 假设"peer 分类正确"，但实际 `isQuotaExceededError`
> （`dsh-llm/lib/index.js:181`）命中面过宽——含 `out of ... budget`、`balance/credits exhausted`、
> `usage limit (exceeded|exhausted|reached)` 等。商汤限频 429 体常带 `rate limit budget` /
> `out of rate budget` 这类字眼，于是被**抢判为 `QUOTA`**（而纯 `RATE_LIMIT` 正则因排在 `isQuotaExceededError`
> 之后成了死代码）。后果：本应退避重试的限频被按"配额耗尽"快速失败、且模型被面板静默下线呈现"额度已用尽"。
> → 新增 `llm-error-fix.ts` 在 host 侧 Proxy 包裹 `PiAiAdapter` 流出口，把"误判的限频 QUOTA"纠正回
> `RATE_LIMIT`（保留 message）；真配额耗尽与已限频原样放行。即：peer 分类**仍用作主路径**，但我们加了一层
> 保守的"宁重勿杀"纠正，不重写、不依赖 peer 解析（peer-free 可测）。

- **重试策略（全局，1 行 peer 改动）— 已实现**：`llm-retry.ts` 导出 peer-free 的
  `buildRetryPolicyConfig()`（显式 `mode:"normal"`、`retryableCodes` 排除 `QUOTA`/`ACCOUNT_QUOTA`、保留
  `RATE_LIMIT` 并略调 backoff 对共享池更温和），`llm-adapter.ts:127` 改为
  `resolveRetryPolicy(buildRetryPolicyConfig(), ...)`。peer 已默认对 `RATE_LIMIT` 退避、对 `QUOTA` 快速失败，本改动是把意图固定下来并防未来 peer 默认漂移。
- **quota→provider 桥 — 已实现**：快照处理器用 `exhaustedModelIds(pools)`（`llm-models.ts`）算出借尽池覆盖的模型集，经 `publishProvider(entries, enabledIds, unavailableModelIds)` 透传给 `createSensenovaAdapter`，由 `buildDescriptors` 在 picker 侧排除（避免发出必 429 的请求）；另以 `quotaSignature`（`index.ts`）去抖，仅在额度跨越零点时触发一次重注册（memoize 约束下唯一生效路径）。
- **per-model 可用性（「清单自带识别」）— 已实现**：`buildDescriptors`（`llm-models.ts`）按 `pool.remaining<=0` 在 picker 侧排除借尽模型；面板则通过 `rosterWithAvailability(entries, pools)` 列出全部 chat 模型并附 `available`/`quotaExhausted` 标记（始终可见、灰色显示原因）。不依赖 peer 钩子，随 `publishProvider` 重建即生效。

### 3.3 spike 结论（已查证）：memoize → 走 re-registration

`PiAiAdapter.current()`（`dsh-llm-pi-ai/lib/index.js:1759`）用
`if (this.snapshot?.profiles === profiles) return this.snapshot;` 做记忆化，**key 是
profiles Map 的引用身份，不是内容**。本插件的 `profiles: () => profiles` 每次返回同一引用，
所以 retryPolicy 在首次构建后被冻结——**运行时改 Map 内的字段不会被拾取**，必须让 Map 引用变化。

因此「池耗尽即降级」走 **B 路（spike 前已预判的真实分支）**：在 quota 状态变化时触发一次
`publishProvider`，复用现有 catalog 签名去抖思路、加 `quota-signature` 即可整体重建 adapter、
重算 `resolveRetryPolicy`。这同时驱动 §3.2 的 per-model 可用性标记（本就走 `publishProvider`），
**两个能力共用一个重注册信号，全局、低侵入**。

**已排除的 C 路（精确窗口退避）**：peer 的 `dsh-llm-retry` 在 `failure.providerRetryAfterMs`
存在时会用它做精确退避（`dsh-llm-retry/lib/index.js:171`），且 `LlmFailure` 支持该字段。但 grep
`dsh-llm-pi-ai` 未发现它在 SenseNova 429 路径上提取 HTTP `Retry-After` 并附到 `LlmError`——
即默认 `RATE_LIMIT` 走的是通用指数退避，而非按平台窗口。要把「按 `resetAt` 精确退避」做出来，需要
推理侧响应钩子把 `Retry-After` 转成 `providerRetryAfterMs`，而该钩子面本次未在 peer 中查证到公开
入口。**C 路非必需**（默认已对 `RATE_LIMIT` 退避），列为 deferred，不阻塞主线。

### 3.4 测试（按域裁剪，禁全量）

- `test/retry.test.mjs` 已落地（peer-free）：断言 `buildRetryPolicyConfig` 形状（排除 QUOTA/ACCOUNT_QUOTA、保留 RATE_LIMIT）、`exhaustedModelIds`、`buildDescriptors` 排除借尽模型、`rosterWithAvailability` 标记；peer 可达时额外断言 `resolveRetryPolicy` 解析结果。
- 验证只跑 `parsers` / `provider` / `auth` 相关 + 新增 `retry`；**不跑全量**（`AGENTS.md` 并行纪律：禁连跑全量 vitest 卡死用户机）。

## 4. 官方文档保真：不提炼、不 git rm、保留逐字原文

`docs/sensenova-api-reference/*.md`（12 个，商汤**官方一手信源**，已由 `.txt` 改名 `.md`）的处理原则已据评审纠偏——**原「提炼回 SENSENOVA-API.md 后 git rm」方案作废**，理由：

- **权威性问题**：这些是逐字引用才有意义的一手信源（错误码 `429 quota_exceeded_error`、参数名 `reasoning_effort`/`supported_features`、模型实测能力表）。转述会漂，且 `codes.js`/`parsePools` 的判据靠 grep 原文兜底，丢原文即丢依据。
- **git rm 前提错误**：`upstream/SenseNova AI API does/` 与 `docs/sensenova-api-reference/` 那份**逐字节相同，但 upstream 那份 0 文件进 git**（是参考应用 checkout，不在本插件版本控制）。`docs/sensenova-api-reference/` 那份是**唯一受版本控制的官方副本**——`git rm` 不是去重，是删除唯一受控信源。
- **无实际问题需解**：这 12 个 txt **不在 `package.json` 的 `files`** → 不进发布包；位于 `docs/` 子目录 → 不触发 `docs.test.mjs` 孤儿文件规则；`SENSENOVA-API.md` 本就是独立的「实测注释层」（开篇即声明「官方文档多处不符，以实测为准」），揉进原文反而搅乱它已维护的「官方 vs 实测」边界。

**正确做法（天花板 = 改名，不越界）**：

- **保留官方原文逐字**，作为只读一手信源。
- **最多改名**：`.txt` → `.md`（纯内容保留、零权威损失，仅换扩展名让查看器渲染更好）；顺手把误译残留目录名 `SenseNova AI API does` 改为 `sensenova-api-reference`。
- **[SENSENOVA-API.md](./SENSENOVA-API.md) 保持「实测注释层」身份**，改为**链接**到官方原文（如「官方模型列表见 `sensenova-api-reference/11、模型列表.md`」），而非抄录——形成「官方一手信源（逐字，只读）+ 插件实测注释（我们维护）」两层互不污染。
- **不做**：提炼/转述、把官方原文合并进 SENSENOVA-API.md、`git rm` 官方副本。
- **不做**「把 `upstream/` 拉进库」的反向操作（`upstream/` 仍 gitignored、独立历史）。

## 5. P1 ✅：CLI `doctor --json`

- **已落地**（2026-10-01）：`src/host/doctor.ts`（peer-free，只读状态文件、不碰凭据，Host 没起也能跑）+ `tools/doctor.mjs` CLI（`npm run doctor` 人读 / `npm run doctor:json` 机器读）+ `test/doctor.test.mjs`（离线进 `npm test` 链）。README 已对外文档化。

## 6. 明确不做（边界，写死防止漂移）

- **多 Key 池化**：同池无效，已纠偏（§1）。
- **签到 / 每日领取**：先证商汤有端点，否则不吸。
- **不再往 `upstream/` 拉新项目**，除非同时定义「提炼出口」（吸知识不吸代码）。
- **跨 provider 通用聚合**：不吸收 `dsh-provider-quota` / `dsh-musage` 的泛化定位（见 §5.3）。
- **client.js 文件级分解（2026-09-29 定界不拆；2026-09-30 tripwire 触发、决策重开并执行完毕——client 半边 TS 化 + 按功能拆文件一步到位，见 §6.2）**。
  该边界条目的「不拆」部分就此退役；Host 半边免构建 + checkJs 的现状不变。

## 6.2 构建链与 Client 拆分（2026-09-30：先干跑验证，当日决策重开并执行完毕）

原计划「拆分先行、.ts 化稳定后再说」被合并为一步（touch 每个文件一遍而非两遍），
用户拍板采纳；本节是既成事实的执行记录。

**已落地：**

- **源码布局**：`src/client/*.ts` 十五个文件，按功能拆——`index.ts`（factory +
  三世界尾巴）、`runtime.ts`（React 缝隙：factory 入口 `provideClientReact`，其余
  模块经转发的 `h`/hooks 取用，调用点与拆分前的闭包形式逐字一致）、`const.ts`
  （路由常量）、`i18n.ts`（zh/en 双语字典，`en: typeof zh` 编译期钉键集齐平）、
  `styles.ts`、`format.ts`、`models.ts`（allow-list 代数）、`snapshot.ts`（决策层
  + 三张码表）、`cards.ts`、`account-form.ts`、`provider-controls.ts`、
  `model-picker.ts`、`api-key-form.ts`、`panel-page.ts`、`apply.ts`。行为逐字转录，
  17 个离线套件 + e2e 全绿背书。
- **构建**：`tsdown.config.mjs` → 根 `client.js` 产物，`npm run build:client`。三个
  关键取值：`format: "iife"`（顶层零 import/export，三世界尾巴活在函数作用域里；
  esm 构建会被 rolldown 的 CJS 语法探测包壳改写 ABI）；`outputOptions.entryFileNames:
  "client.js"`（产物路径/文件名不变，`package.json#exports` 与 `files` 不动）；
  `clean: false`（outDir 是仓库根）。factory 参数命名 `loaderRequire` 而非
  `require`——避免裸 `require` 被打包器当模块系统语法改写；react 仍由 loader 注入
  （`deps.neverBundle` 钉住）。三世界尾巴保留在源码里，CJS require 世界照旧声明。
- **门禁**：`test/build-gate.mjs`（npm test 链尾、e2e-gate 之前；文件名不含
  `.test.`，不入 `package.test.mjs` 三方名册，同 e2e-gate 范式）——**freshness**
  （重建与提交产物做换行归一化的逐字节比对，过期即红并提示提交新产物）+ **形状**
  （无顶层 import/export、ESM 导入恰好注册一份、react-only 替身可物化、panel 测试面
  键齐全）。tsdown 缺席则醒目 SKIP 退出 0。
- **新纪律**：改 `src/client/*.ts` 后必须 `npm run build:client`，并把根 `client.js`
  与源码放进**同一个 commit**；只提交源码不提交产物 = build-gate 红。devDeps 安装需
  `--legacy-peer-deps`（peer 是 Host 运行时包，registry 上只发预发布版且整套互相以 peer 咬合；本仓刻意无 lockfile。**2026-10-01 补正**：见 [PITFALLS.md](./PITFALLS.md) §30——正因如此，CI 的 peer 来源必须是整棵 CLI 运行时树）。
- **【当晚已被取代】「Host 半边不动」**：随后按 workbuddy 规范完成全仓归一——Host 源码迁
  `src/host/*.ts`（27 个模块），tsdown 多入口构建 `lib/`（ESM bundle + 切分 chunk）；`lib/` 与根
  `client.js` 一并 `.gitignore`，**产物彻底不入库**（上文「产物与源码同 commit」纪律随之作废），
  测试面与门禁已适配；17 套件 + build-gate + e2e + tsc 全绿，「删 lib 可重建」验收通过。
  checkJs 的 JSDoc 投入随 .ts 化自然并入类型标注。

**遗留项已闭合（2026-09-30）**：CI 离线 job 现已安装 devDeps（`npm install
--legacy-peer-deps`；setup-node 以 `package.json` 为 key 做 npm 缓存——本仓刻意无
lockfile）并实跑 `test/build-gate.mjs`，构建失败与产物缺失在 CI 即红，不再恒 SKIP。
「无构建」表述已全库同步（`DSH-PLUGIN.md` §7、`ARCHITECTURE.md` 半边表、
`TESTING.md` 链条枚举、`AGENTS.md` 验证段、`PITFALLS.md` §22）。

## 6.1 竞品参照：raccoon 的机制点（可选模式范本）

> 仅作**机制参考，不抄代码**。参照对象：`liudapeng0311/dsh-raccoon-work`（DSH 小浣熊 Connect，接入商汤小浣熊桌面 App 模型）。
> 关键事实：它接的是**小浣熊桌面 App 登录态网关**（`xiaohuanxiong.com/api/web/llm/v2` + box-agent 登录态文件），**不是** Token Plan 配额池——限流宇宙与我们不同，故「它不限速」是源差异、非技术碾压。

可借鉴的机制点（纯架构，不移植实现）：

- **零配置复用桌面 App 登录态（接入模式范本）**：读 App 自维护的登录态文件，不另起 OAuth 流，账号切换自动跟随。若未来做「App 登录态直连」可选 provider 模式，这是骨架——但属合规/授权分叉，需先定方向（见 §6 边界，不默认吸收）。
- **刷新令牌单用回写（必要纪律）**：上游刷新是单用语义，会服务端轮换 refresh token，必须把轮换后的对回写 App 登录态文件，否则 App 下次撞 `refresh_conflict` 被登出；冲突时先重读 App 文件拿有效令牌再继续。任何「回读桌面凭证」模式都必须照搬，否则会卡住用户登录面（同源于 AGENTS.md 并行纪律）。
- **信封→HTTP 状态翻译（shim 范本）**：网关用 `{code, message, data}` 信封 + 业务码（积分不足 `200402`/`200429`、限频短语「频繁 / rate limit」）表达语义，插件翻译成 HTTP 状态（401/402/429）交给 pi-ai 默认重试。我们 `codes.js` 的 `RATE_LIMITED` 分诊哲学可参考其写法。
- **探测结果缓存（避免重复花费）**：推理档位需实测（网关只部分校验）、实测花积分，故按「账号 + 目录行指纹」缓存结论（有效期 14 天），上游改行即作废重测。若我们未来做推理档位实测（目前靠官方目录声明），可借鉴指纹缓存。
- **429 处理（反例，确认取舍）**：其 `retryPolicy` 传 `undefined` 用默认，所有 429 当 `soft_rate` 甩给 pi-ai 默认重试，**不做配额耗尽 vs 限频分诊**。这恰是我们 `llm-retry.js` 已做得更细之处，且印证「Token Plan 硬配额池需精细治理」是 raccoon 触及不到的维度——不要回退。

### 6.1.1 桌面端登录态作为「第二条登录路径」：已实测否决，实施延后

> **状态（2026-09-30 第二次复测：仍判死）**：**不做**，但**保留原理与复测判据**。方向上是「最终仍想融」，
> 因此这里只钉结论与前置门禁——**实施统一推迟到本体稳定之后**，本块不阻塞任何主线。

**结论**：小浣熊桌面端的登录态**不能**作为本插件 OIDC 之外的第二条登录路径。
原因不是权限没开，而是**两个独立认证域**。

**实测证据（2026-09-29，只读探针，token 只在内存中过一遍 `Authorization` 头，
未落盘、未进日志）**：

| 观测 | 结果 |
|---|---|
| 桌面 `~/.box-agent/config/auth.json` 的 JWT claims | `iss` 为**数字型 App 级标识**（本例 `721217`），**无 `aud`、无 `scope`** |
| `GET platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage`（带该 token） | `401` `auth_token_invalid` / `Invalid access token` |
| `GET token.sensenova.cn/v1/models`（同上） | `401`，`{"code":16,"message":"Forbidden"}` |

**第二次只读复测（2026-09-30，判据 §6.1.1 原文 1 次只读请求）**：桌面 `access_token`
（claims 指纹与 09-29 相同）打 `GET platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage`
仍回 `401 auth_token_invalid / "Unauthenticated"`——**判死结论未变**，认证域未合并。
附带对照：`xiaohuanxiong.com/api/web/llm/v2/models` 回 `404 page not found`（网关路由或鉴权入口与 09-29 记录有漂移，
融第二上游前需重新核实该端点契约，不能照抄 raccoon 的 URL 清单）。

对照本插件自己的令牌：Hydra 签发、`client_id=nova`、`scope=openid offline offline_access`
（见 [SENSENOVA-API.md](./SENSENOVA-API.md) §1）。**令牌这一层就不通用**——
换登录方式（扫码 / 短信 / 深链回调）也绕不过去。

**同期核实的上游事实**（来自 `upstream/deepseek-harness-codearts-master`，即
`dsh-codearts-auth`）：

- 小浣熊桌面官方授权链路 `office-raccoon://auth/callback` 在网页里**写死**，
  宿主侧 Node 进程收不到回调；第三方插件只能自建登录流（微信扫码 / 短信验证码）。
  故「读桌面 `auth.json`」是**捷径而非唯一路径**。
- `desktop/v1/login/points/grant` 是小浣熊「桌面端登录奖励（每号一次）」端点，
  但其积分属于**小浣熊域（`xiaohuanxiong.com`）**，不是 Token Plan 积分池——
  对 §6「签到 / 每日领取」边界仍不适用。

**三条凭据路线（原理；未来真要融时先回到这张表对形态）**：

| 路线 | 做法 | 代表 | 风险面 |
|---|---|---|---|
| 只读桌面登录态 | 读 App 凭据文件、绝不写回，刷新结果写插件自有副本 | workbuddy 类 | 低：不可能弄坏 App 的登录 |
| 回写桌面登录态 | 上游 refresh 是单次使用语义，必须把轮换后的令牌写回 App 文件 | 小浣熊桌面 | 高：写坏即把用户登出 App |
| 自有登录 + 凭据服务 | 自己走 OAuth / 扫码，凭据只进 DSH 凭据服务 | **本插件**、codearts | 低，但每个产品要各写一套 |

**若未来要融，正确形态是「第二上游 provider」而不是「第二登录路径」**：把
`xiaohuanxiong.com/api/web/llm/v2` 注册为独立 provider（opt-in、默认关、
独立凭据生命周期、不碰 Token Plan 池语义）。

> **方向已定（2026-10-01）：纳入。** 此前这里写「它撞 §5 不变量 3（按 Key/账号线划线），
> 属合规 / 授权分叉，须先定方向——**不默认吸收**」。当时搁置的原因是**边界划法**而不是
> 不认同这件事本身：按认证域划线会把同一厂商的姐妹产品线一并判成界外。
> [ARCHITECTURE.md](./ARCHITECTURE.md) §5 不变量 3 的划线依据已改为「厂商归属」，裁定
> **界内**，举证与边界详述见该文 §5.5。
> 本节的两次复测结论**不变**——它判死的是第二**登录路径**（桌面 App 登录态复用），
> 与第二上游是不是界内是两件事，别混为一谈。

**复测判据（本体稳定后、开工前先跑，1 次只读请求）**：拿桌面 `access_token` 打
`GET platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage`；
`200` = 认证域已合并（本结论被推翻，可继续）；`401 auth_token_invalid` = 仍然判死。

**前置门禁**：本插件本体稳定——§2.1 / §2.2 两个 P0 已落地且无挂起中的吸收项。

### 6.1.2 第二上游形态：2026-10-01 网关契约复测（落地后补齐）

> **背景纠偏**：raccoon 第二上游（面板第三个 tab、`sensenova-raccoon` provider）已于
> 2026-09-30 21:31（commit `5d789b6`）落地并随 **0.4.3** 发布，但本文件当时**没有同步**——
> §6.1.1 的结论与 §7 的 P2 行都还停在「观望」。§6.1.1 判死的是**第二登录路径**（复用桌面
> App 登录态打 Token Plan），该结论不变；本节补的是**第二上游形态**（独立 provider 打
> `xiaohuanxiong.com` 网关）在落地之后的首次补齐复测。

**复测对象**：`https://xiaohuanxiong.com` 网关，全部请求**不带任何凭据**（无本地 token 参与、
无计费可能、只读语义），目的只是区分「路由不存在」与「路由存在但需鉴权」。

| 端点 | 方法 | 响应 | 判读 |
|---|---|---|---|
| `/api/web/llm/v2/model_catalog` | GET | `401` `{"code":200001,"message":"authorization_empty_error"}` | 路由存在，抵达鉴权层 |
| `/api/web/llm/v2/chat/completions` | GET | `404` 纯文本 `404 page not found` | **仅 GET 未注册，不足以判死**（见下） |
| `/api/web/llm/v2/chat/completions` | POST | `401` `{"code":200001,"message":"authorization_empty_error"}` | 路由存在，抵达鉴权层 |
| `/api/web/llm/v2/models` | GET | `404` 纯文本 `404 page not found` | 复现 §6.1.1 的 09-30 记录；**本插件不使用此端点** |

**结论**：本插件实际依赖的两个网关路由（`model_catalog` 拉目录、`chat/completions` 走推理）
**契约成立**——两者都返回结构化信封而非纯文本 404，说明请求已抵达鉴权中间件。09-30 那次
「404」记录的是参考件 `dsh-raccoon-work` 的 `models` 端点，**不是本插件用的端点**；此前按
前缀相同就判「实现的常量就是被标注 404 的那份清单」是**误判**，已更正。

**附带的真教训**：用 GET 给 REST 端点探活有歧义。Go/Gin 一类框架对「路径存在但方法未注册」
默认回纯文本 `404 page not found`，与「路径不存在」无法区分——只看 GET 的 404 会把一个健康
端点误判成已漂移。判据必须是「同一路径 + 正确方法」，且要看**响应体形态**（结构化信封 vs
纯文本），不止看状态码。已收进 [PITFALLS.md](./PITFALLS.md) §24。

**仍然成立的两件事**：① 桌面 App 登录态打 Token Plan 仍然判死（§6.1.1 未变，两个认证域不通
用）；② 复测只能证明**路由还在**，不能替代带凭据的端到端验证——真凭据下的信封形态、
`refresh` 单用轮换、倍率字段都以 `test/raccoon.test.mjs` 的离线 fixture 为契约，需**（定期人工复核）**。

### 6.1.3 真凭据复测：2026-10-01（首次带凭据做端到端）

§6.1.2 那次复测**不带任何凭据**，只能证明「路由还在」。本节是**首次**用面板扫码得到的有效凭据逐个实测（每个请求均带 `Authorization` 与 `X-Org-Code`），把「路由存在但需鉴权」与「路径真的不存在」分开判。

| 端点 | 带有效凭据实测 | 判读 |
|---|---|---|
| `GET /api/web/llm/v2/model_catalog` | `200 {"code":0,...}`，`categories[].models[]` 6 个 `sn-*` 可见模型 | 通；前 3 个 `raccoon-*` 隐形模型 `id` 字段为空、`model_name` 有值 |
| `GET /api/web/points/v1/balance` | `200 {"code":0,"data":{"available_points":10129,...}}` | 通，但**字段名是 `available_points`**，旧解析只认 `balance/available/amount` → 读成 `null` |
| `POST /api/web/auth/v1/refresh`（**假 token**） | `400 {"code":100002,"message":"params_invalid_error","details":"param token invalid format invalid"}` | 路径**存在**，抵达业务层 |
| `POST /api/web/auth/v1/refresh_token`（**假 token**） | `404 page not found`（纯文本） | 路径**不存在** |

**结论：参考件（`dsh-raccoon-work`）的路径没错，是本插件抄录时走了样，两处已随 0.4.6 修正**：

- refresh 端点把 `/refresh` 抄成了 `/refresh_token`（多了 `_token`），于是**每次续期都 404**——access token 过期后只能重新扫码，这正是 0.4.6「凭据过期」一节的深层成因；
- balance 解析字段漏了 `available_points`，拿真实余额读成 `null`、面板显示假 0。

**探活纪律（沿用 §6.1.2 的判据）**：刷新/续期端点用**假的 `refresh_token`** 探活——真 token 是单用的，烧掉会让用户下次无法续期；假 token 同样能区分「400 = 路径在」与「404 = 路径不在」，零代价。

**扫码登录信封实测（2026-10-01，真扫码）**：`login_with_qrcode_code` 成功信封的 `data` **只含 `access_token`、`refresh_token`、`status` 三个字段**——没有用户对象、没有头像/手机号/用户 ID。面板展示的昵称**确定来自 access token JWT 的 `name` claim**（`extractRaccoonNickname` 的 JWT 兜底分支命中；claims 全集为 `exp/iss/jti/name/nation_code/nbf/owner_type/sid`）。这销案了「信封从未被探测、昵称来源未证实」的悬案：网关能给的全部账号信息就是这一条昵称，面板无需也无从展示更多；`raccoon.ts` 里信封字段的防御梯子保留（代价为零，防网关将来加字段）。

### 6.1.4 接入面盘点：未接的数据、死负载与「自动」的边界（2026-10-01：报告 → 当天处置）

> 起因：0.4.6 收尾时把「Host 已经拿到、插件却没用」的数据逐条过了一遍。三条发现当天**按下表处置落地**
> （先只报告、再拍板动手是刻意的两拍：处置顺序由「有没有真实下行风险」决定，不由「代码脏不脏」决定）；
> 本节同时把「自动续期 / 自动登录 / 签到」三件常被混成一件的事按事实拆开。

| 未接入项 | 现状（证据） | 处置 |
|---|---|---|
| `RACCOON_DESKTOP_PREFIX`（`/api/web/desktop/v1`） | **定义了但零引用**：唯一出处在 `src/host/raccoon.ts` 的常量区，全仓无调用点；构建产物 `lib/` 里连字符串都被 tree-shake 掉。**同类死常量还有两个**：`RACCOON_QR_POLL_INTERVAL_MS` / `RACCOON_LOGIN_TIMEOUT_MS`——`src/host/routes.ts` 把同样的值**又本地定义了一遍**（`RACCOON_LOGIN_DEADLINE_MS` / `RACCOON_POLL_MS`），实际逻辑走本地那对 | ✅ 分两种处置：`routes.ts` 的两个副本**删掉、改从 `raccoon.ts` 导入**（两个真源是唯一会静默漂移的形态）；桌面前缀**保留但写明「故意不接线」**（它是端点级唯一代码路标，删了会把「探针即领取」的知识挤回文档） |
| 401 诊断六字段 | Host **一直在发**：`accessTokenPrefix` / `credentialSource` / `raccoonEnvShadow` / `envCredentialFingerprint` / `accessTokenFingerprint` / `hostProxyEnv`（`src/host/routes.ts` 的 `raccoonState()`）。客户端**一个都没读**（`client.js` 里只有 `balanceDetail` / `modelsSource`）。是排查 401 时的脚手架，线上无害但属死负载——其中 `hostProxyEnv` 还是**无条件**上报（非 `null` 省略） | ✅ 全部收进 **`?debug=1`** 显式开关（GET 才认；免配置字段、免重启，POST 的回报一律干净），且 `hostProxyEnv` 的**代理 userinfo 一律遮蔽**后才出门 |
| 目录字段 `model_name` | **从未被读**。目录归一化只认 `id` / `name` / `multiplier` / `vision` / `context_window` / `max_output_*`；`id` 为空的行**显式跳过**（实测前 3 个 `raccoon-*` 隐形模型正是 `id` 空、`model_name` 有值——那是有意过滤，不是静默丢弃）。风险只在：若哪天可见模型的显示名改走 `model_name`，会静默退化成用 `id` 当名字（不炸、但难看） | ➖ 不动（`id === ""` 的跳过是设计），仅登记为「字段已观测、未消费」 |

余额侧**无静默丢弃**：总量抽 `available_points`（`balance` / `available` / `amount` 兜底），拆分 `daily` / `reward` / `monthly` / `topup_points` 四条零也照报；读失败必报原因（`balanceDetail`），目录侧「读失败」与「读成功但无可见模型」分开报（`modelsSource` 的 `unreadable` vs `empty`）。

**优先级判据（为什么是这个顺序）**：六字段里只有 `hostProxyEnv` 有**真实下行风险**——它回吐的是环境变量的**值**，而企业代理常写成 `http://user:pass@proxy:8080`，userinfo 就是凭据（本机 7 个代理变量全未设置，属**潜在**而非活跃；但代码路径对所有用户通用，且该路由的信任边界是浏览器、不是机器，本地任意进程都能读）。其余五字段（8 字符前缀、来源字符串、布尔、两个 12-hex 指纹）无秘密、无消费者，是纯死负载。**常量单真源**略高于纯卫生：两份字面量一旦漂移，没有任何运行期断言看得见。故顺序为「诊断字段（含遮蔽）→ 常量单真源 → 其余」。

**验证方式（无门禁可依赖，所以用反证）**：这六字段与那两个副本常量在 `test/` 里**零覆盖**——删掉它们不会有任何测试变红，安全性只能靠「grep 证明无消费者」这一条人工证据。因此在补齐守门断言之外，做了两个**故意破坏**的反证：把开关写死成常开 → 负向断言点名泄漏的键；摘掉遮蔽 → 断言原样吐出 `alice:s3cr3t`。两条都实测红过再还原（同 [PITFALLS.md](./PITFALLS.md) §25 的验收纪律）。为什么脚手架能长期无人发现，已收进 [PITFALLS.md](./PITFALLS.md) §29。

#### 「自动」的边界：自动的是续期，不是登录，更不是签到

- **自动续期**（Token Plan / 小浣熊都有）：Token Plan 走 `acquire()`（节流闸 → 新鲜度 → refresh → 登录兜底）；小浣熊的 refresh 是**单用轮换**、整对回写，并在每次请求前 eager refresh。触发是**惰性**的——Host 半边零 `setInterval`，靠面板轮询打路由时按需触发。
- **密码自动重登**（仅 Token Plan）：**opt-in**，必须 `SENSENOVA_PASSWORD` 在 Host 进程环境里且账号已存；没有它，refresh 一死就回面板要手动登录。平台要短信/图形验证码时自动化注定失败（面板文案 `auth.verification`）。
- **登录本身**永远需要用户在场一次：Token Plan 是浏览器 OIDC+PKCE，小浣熊是微信扫码（阻塞最多 5 分钟等扫）。
- **签到 / 每日领取：没有做，也没有可调的端点**。Token Plan 侧从未证实存在这样的端点（§6「先证商汤有端点，否则不吸」与 §7「明确不做」仍然有效）；小浣熊侧日发积分是**服务端自动发的 `daily_grant`**（网关没给这个发放的端点），面板只读余额、把日发那部分当 breakdown 展示。所以**不存在「靠自动登录刷签到」这回事**——本插件从未发出任何签到/领取请求。

#### 探针提醒：`desktop/v1/login/points/grant` 不能拿真凭据试

该端点是「桌面端登录奖励（**每号一次**）」且属**小浣熊域**（不是 Token Plan 积分池），对 §6 的签到边界不适用。更要紧的是它的属性：**有副作用且不可逆**——带真凭据请求即把一次性奖励真实领走。所以「先人工探针确认契约」只能做**无凭据的路由存在性探测**（判据沿用 §6.1.2：结构化信封 `401` vs 纯文本 `404`）；带凭据的契约验证必须等真决定接入时再做，并明确接受当次奖励被领走。已收进 [PITFALLS.md](./PITFALLS.md) §28。

## 7. 优先级与时间盒

| 优先级 | 项 | 侵入性 | 门禁 |
|---|---|---|---|
| **P0 ✅** | `index.js` 控制面解耦（§2.1：`provider-publish.js` + `snapshot-aggregate.js` 抽状态机与聚合、`index.js` 1187→778 行、5 路由 + 2 IIFE 收编） | 中（纯重构，快照契约零改动） | `test/wiring.test.mjs` F3 经新模块注入仍全绿 + `routes`/`provider`/`draw` 四套件全绿 + `e2e-gate` |
| **P0 ✅** | 商汤契约自动化回归（§2.2：`test/contract.test.mjs` 77 项进 `npm test` + `test/live-contract.mjs` live 手动档 + `test/baselines/sensenova-contract.json` 冻结 2026-09-29 实测） | 低（纯测试基建，不碰运行时） | `npm test` 全绿；`package.json` 加 `test:live:contract` 脚本 |
| **P0 ✅** | 429 spike + 配额联动（全局策略 `llm-retry.ts` + per-model 可用性 `llm-models.ts` + `index.ts` quota 重注册） | 低（1 行 peer + peer-free 分类器 + 状态文件桥） | `e2e-gate`（dsh CLI 在则实跑）；`test/retry.test.mjs` 已落地 |
| **P0 文档** | §5 纠偏 + 本文入库 | 无（仅 doc） | `docs.test.mjs` |
| **P1 ✅** | 出图吸收（§5.4 接法 B）：`draw.ts`（peer-free：结构化识别 / 端点拼接 / 429 分诊 / 失败冷却）+ `index.ts` opt-in 接线（`drawEnabled` 默认关，无 tools 服务即缺席）；快照契约零改动 | 低 | `test/draw.test.mjs`（56 项）已落地；离线 12 套件全绿 |
| **P1 ✅** | `doctor --json`（`src/host/doctor.ts` + `tools/doctor.mjs`，已落地 2026-10-01） | 低 | `test/doctor.test.mjs` 进 `npm test` 链 |
| P1（可选） | §4 官方文档保真（改名/链接，不提炼不 `git rm`） | 低（仅重命名 + 链接） | `docs.test.mjs` |
| **P2 ✅ 部分落地** | 第二上游 provider：已随 0.4.3 落地（三个 tab 之一 + `sensenova-raccoon`），2026-10-01 补做网关契约复测，**契约成立**（§6.1.2）；剩余未做的是 desktop 融合路径（第二**登录路径**，见 §6.1.1）——它已实测判死，维持观望。接入面盘点与死负载处置见 §6.1.4（2026-10-01：诊断收进 `?debug=1` + 常量单真源） | 高（新上游 + 新凭据生命周期） | 已落地部分：`test/raccoon.test.mjs` 离线 101 项 + `docs.test.mjs` 检查 9；**仍缺**：带凭据的 live 端到端探针（比照 §2.2 给商汤做的 `live-contract`） |
| 明确不做 | 多 Key / 签到 / 跨 provider 聚合 | — | — |
| 明确不做 | 伪倍率折进注册模型名（qoder ② 法：把倍率嵌进 DSH 原生选择器的模型名里，绕「选择器无旁路字段」限制）。2026-09-30 决议 | 低 | 现状即决议：`×N` 只作**面板侧标记**（模型花名册行尾 + 趋势图，同一匹配器、同一数值，均标「非官方」）。理由：① 倍率是操作者手填的对比数据、非平台计费事实，折进 DSH 全局模型名会把个人配置泄漏给所有会话；② qoder 嵌名是「DSH 无字段携带平台真实倍率」的 workaround，本插件的倍率本就没有平台出处，面板就是它唯一合理的位置；③ 模型名是 DSH 配置 / 选择器的稳定标识（id 匹配），加 `×N` 会破坏 id 语义 |

> **顺序约束**：两个 P0（§2.1 / §2.2）已落地（2026-09），是后续任何「继续吸收」的前置门禁。

## 8. 关联文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) §5 — 定位与边界（本文承接，不复制其表）
- [AGENTS.md](../AGENTS.md) — 验证裁剪、红线
- [TESTING.md](./TESTING.md) — `docs.test.mjs` 孤儿文件 / 跨文件重复表规则
- [SENSENOVA-API.md](./SENSENOVA-API.md) — 商汤接口全集（§4 保真：链接官方原文，不提炼）
- [PITFALLS.md](./PITFALLS.md) — 改代码前避坑（§16 peer 解析、§6 凭据事故）

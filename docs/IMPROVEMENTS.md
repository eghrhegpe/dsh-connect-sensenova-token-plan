# 改进研究（Improvements）

对 `dsh-connect-sensenova-token-plan` 当前设计的一次**深化改进研究**：针对已识别的
四个结构性问题（定位描述与注册能力脱节、`index.js` 接线复杂度、peer 语义耦合、
状态/契约/UX/client 四块维护债），给出**有实证支撑**的改进方向与分步落地建议。
本文是**研究结论**，不是待执行清单——每条建议都附证据（文件路径 + 行号），并标注
投入/风险/门禁。

> **修订记录**：2026-09-29 复核后修正三处原稿硬伤——① §1.2 的"默认推理通道"论断
> 撤销（`agent-default-model` 是运行时可变的选择记录，原引用内容已不可复现）；
> ② peer 版本注记由 `0.2.0-rc.1` 纠正为实测的 `0.1.7-rc.2`；③ §3.1③ 的"正则命中
> 类型名"机制**实测不成立**（`\b` 不穿透 `_`——`_` 是 word 字符，`quota_exceeded_error`
> 类型名不触发误判；真正触发 `isQuotaExceededError` 的是 message 文本里的额度措辞）。
> 另修正 §1.1 行数口径与 §4.1 的 catalog-store 并发细节。P0 的 §3.3① 契约护栏测试
> （`test/peer-contract.test.mjs`，含机制钉）随本次复核落地。

> 定位：承接 [ARCHITECTURE.md](./ARCHITECTURE.md) §5（大统一）与 [ROADMAP.md](./ROADMAP.md)
> §0–§6（路线图），但聚焦"怎么改得更好"，不重复定位。
> 与 ROADMAP 的分工：本文是**研究档案**——诊断、证据、投入/风险比，结论随时间沉淀，
> 不再追实现进度；文中「已落地 / ✅」注记只在写下当时成立，**当前执行状态一律以
> [ROADMAP.md](./ROADMAP.md) 为准**。
> 实证来源：本机 DSH 运行时（`~/.dsh/dsh-asar-unpacked/dsh/node_modules`，即
> `test/peer-roots.mjs` 解析到的 peer 根）的 peer 源码、兄弟插件
> （`~/.dsh/profiles/{web,desktop}` 安装树与 `~/.dsh/fork`）与本插件源码。
> 版本注记（2026-09-29 核验修订）：所有 peer 行号引用基于本机运行时实测版本
> `@deepseek-ai/*` `0.1.7-rc.2`、`@earendil-works/pi-ai` `0.85.1`，并已在该版本上
> 逐行复核一致（原稿误标 `0.2.0-rc.1`，本机无此版本号来源）；平台改行为时以实测为准。

---

## 1. 大统一定位：矛盾不在"合"，在"没对齐"

### 1.1 实证：单包 connect 是生态惯例，不是越界

兄弟插件（本机 `~/.dsh/profiles` 实测）全部是**单包 connect**：面板 + provider +
工具一体，无一拆分：

| 插件 | 单包形态 | 是否注册 provider | peer 面（含 dsh-llm / pi-ai / host-webserver 等） | 代码量（JS，本机实测） |
|---|---|---|---|---|
| `dsh-connect-trae` | 面板+双供应商 provider+签到一体 | 是（`dsh-llm-pi-ai`） | 是 | ≈5.9k 行（2 文件，几乎全在 `lib/index.js`） |
| `dsh-connect-workbuddy` | 面板+provider+模型管理一体 | 是 | 是 | ≈5.9k 行（4 文件） |
| `@eghrhegpe/dsh-connect-qoder` | provider 为主（接本机登录态） | 是 | 是 | ≈21.8k 行（fork 副本 76 文件；web 安装树为其硬链接） |
| `@mars-sea/dsh-commandcode-provider` | 目录+多账号轮换+用量面板 | 是 | 是 | ≈15.5k 行（desktop 副本 2 文件） |

> 行数为 2026-09-29 复核快照（cmd 递归枚举 `*.js`，不含嵌套 `node_modules`；
> pnpm 硬链接安装树在 node/pwsh 枚举器下计数不稳定，故用 cmd 口径）。web/desktop/
> fork 副本与统计口径不同会显著改变数值——原稿的 8119/7566/9642/18006 与复核值有
> 出入，不作追溯。**只取"同量级单包"的定性结论，数字不作门禁。**

本插件（≈1.7 万行 JS：根 25 文件 ≈8.6k + test 21 文件 ≈8.1k，不含 docs/upstream）
与同族（5.9k–21.8k 行）同量级。**"把面板做大了"不是缺陷，是这类 connect 插件的
常态**。锐评里"积分面板被过度设计 3 倍"的潜台词——"应该更小"——在 DSH 生态里
不成立：生态的同类**全部**是全家桶单包。

### 1.2 原"默认推理通道"论断：核验后撤销（2026-09-29）

原稿把 `profiles/web/cordis.patch.yml:93-98` 的 `agent-default-model` 行读成
"本插件当前就是这台机器的默认推理通道"。复核后**撤销该论断**，两处硬伤：

1. **引用与现行文件不符**：该文件 93-98 行现状是 `- id: agent-default-model` →
   `provider: agnestokenplan` / `model: agnes-3.0-flash`（`baseURL:
   https://api.agnes-ai.cn/v1`，独立于本插件）；全文件 grep 不到
   `sensenova-token-plan`。desktop profile 的同行是 `provider: qoder-cn /
   model: Qwen3.8-Flash`。原稿引用的 `provider: sensenova-token-plan` /
   `model: sensenova-6.8-flash-lite / reasoningEffort: high` 在任何现行文件
   （含 `cordis.patch.yml.bak-plugin-manager` 备份）里都不可复现。
2. **机制读错**：`agent-default-model` 是 `@deepseek-ai/dsh-agent-default-model`
   的**"默认模型选择"读写服务**——`lib/index.js:14` 自述 *"Owns the default
   model **selection**"*，`saveSelection()`（`:53-66`）经 `configEditor.edit()`
   把用户上次选中的模型**回写**进 profile patch。它是**运行时可变的选择记录**
   （config schema 里 `provider/model` 均 `.volatile()`），不是静态的"默认通道"
   架构声明。两个 profile 指向不同供应商、mtime（2026-09-29 12:54 / 15:46）
   随模型切换被改写，正是这一语义的佐证。

仍成立的事实：本插件确实注册 provider（`llm-models.js:79` `LLM_PROVIDER_ID =
"sensenova-token-plan"`）——"**有能力**充当推理通道"为真；"**当前**就是这台
机器的默认推理通道"**无证据**。真正的定位张力弱化为：README/包名/`displayName`
只写"积分面板 / Token Plan"，没有覆盖已注册的 provider 能力与 429 自愈（§3）
——这是**文档对齐**问题，不是"该不该做大"的问题（见下节）。

### 1.3 结论与建议

- **保留单包**（生态惯例，拆包反而违背上表核实到的同类形态）。
- **对齐定位**：把"商汤 connect 全家桶（面板 + 可选 provider 注册 + 429 自愈）"
  写进 README 与包描述——明确**注册了 provider、能承担推理通道**的能力与对应责任
  （provider 行的健康、面板只读、429 分诊）。**不写**"默认推理通道"——那由
  profile 与用户的模型选择决定（见 §1.2），不是插件自身的属性。不靠改名，靠
  **文档与故障半径对齐**。
- **不改架构，做"注册 provider 的可靠性工程"**：
  1. provider 注册（推理线）与 console 登录（面板线）**本就是两条独立路径**
     （`resolveApiKey` 现取，catalog 独立于 console 凭据）。保持并**固化**这个
     解耦：console 凭据事故不应波及 provider 已注册的服务中的模型。
  2. 面板快照 `llm` 块（`providerState.error` / `registered`）已能表达"推理线
     是否健康"，把它在面板里**显式呈现**（一行"模型接入：已注册 N 模型 / 异常
     原因"），让注册 provider 的故障对用户可见、可处置。
- 迁移成本：**零代码**，纯文档 + 面板一行字。风险：低。门禁：`docs.test.mjs`
  （README 行数上限）、`panel.test.mjs`（字典一致性）。
- **落地状态（2026-09-29）**：文档侧已完成——README 定位句与 `package.json`
  `description` 改为"connect 全家桶（面板 + provider 注册 + 429 自愈）"，并说明
  429 误判纠正（见 §3）；**不写**"默认推理通道"。面板侧"推理线健康"行**本已具备**
  （`ProviderStatus` 渲染 `llm.registered` / `llm.noService` / `llm.error` /
  `llm.off`，即"已注册 N 模型 / 异常原因"），无需新增。§1.3 完成，零剩余项。

---

## 2. `index.js` 接线层：5 路由 + 2 IIFE 的收编

### 2.1 现状责任清单（`index.js` 778 行实测）

| 段落（行号） | 责任 | 类型 |
|---|---|---|
| `apply()` 头部 `#L195-L236` | 解析 settings、建 auth/apiKeyStore/catalogStore/providerStore | 编排 |
| `#L263-L293` | 建 `publisher`（provider-publish）+ fire-and-forget `seedPublisherFromCatalog` IIFE① | 副作用 IIFE |
| `#L305-L344` | draw 工具注册 IIFE②（`void (async () => {...})()`） | 副作用 IIFE |
| `#L351-L374` | 建 `tokenStore`（带 `onTrace` 钩子） | 编排 |
| `#L381-L435` | 注册 `SNAPSHOT` 路由（薄，委托 `buildSnapshotBody`） | HTTP 面 |
| `#L437-L516` | 注册 `ACCOUNT` 路由（最厚：GET/POST/forget、cache 清、trace 落盘） | HTTP 面 |
| `#L518-L584` | 注册 `API_KEY` 路由（GET/POST/forget、清 catalog/缓存/签名） | HTTP 面 |
| `#L586-L645` | 注册 `PROVIDER` 路由（开关 + 立即 publish） | HTTP 面 |
| `#L647-L707` | 注册 `MODELS` 路由（allow-list + 立即 publish） | HTTP 面 |
| `#L709-L723` | `ctx.effect` teardown：dispose→release→off×5 | 副作用 |
| `#L741-L775` | vision step two（settings-row writer） | 编排 |

**结论**：`index.js` 现在是"挂载编排器 + 5 个路由 handler + 2 个 IIFE + teardown"。
`buildSnapshotBody` 已把最重的聚合抽走；剩下的是**路由骨架**与**接线胶水**。

### 2.2 剩余"接线味"的风险分级

- **真风险（保留即可）**：`teardown` 的 `dispose→release→off` 顺序（`#L709`）
  是 PITFALLS §18 并发修复的一部分，**不能简化**。
- **审美/可维护性（可动）**：5 个路由 handler 内联在 `apply` 里，使 `index.js`
  始终是"最大的一个文件"。`ACCOUNT` 路由最厚（含 `forget`、trace 落盘、`cache.clear`
  副作用），是最值得抽走的。
- **2 个 IIFE**：`seedPublisherFromCatalog`（IIFE①）与 draw 注册（IIFE②）都
  fire-and-forget，且 IIFE② 内部还要判断 `tools` 服务、懒 import peer。这是
  "接线"与"副作用"的混杂点。

### 2.3 目标结构（推荐方案：抽 `routes.js` + `lifecycle.js`）

**方案 A（推荐）**：
1. 新增 `routes.js`（peer-free）：导出 `registerRoutes(ctx, wiring)`，`wiring` 由
   `index.js` 组装（含 `settings/auth/tokenStore/apiKeyStore/publisher/catalogStore/
   providerStore/cache/inflight`）。`SNAPSHOT/ACCOUNT/API_KEY/PROVIDER/MODELS`
   五个 handler 原样迁入，`writeJson`/`readJsonBody`/`failureCode` 随之迁走。
2. 新增 `lifecycle.js`（peer-free）：导出 `startSideEffects(ctx, wiring)`（收敛
   IIFE① seed + IIFE② draw 注册 + vision step two）与 `teardown(ctx, wiring)`
   （dispose→release→off×5）。IIFE② 内的 `tools` 服务判断保留，但抽成具名函数
   `registerDrawTool(ctx, wiring)`，`test/draw.test.mjs` 可直接注入。
3. `index.js` 退化为"组装 wiring + 调 `registerRoutes` + 调 `startSideEffects`/
   `teardown` + `ctx.effect` 挂 teardown"，目标 **< 300 行**。

**wiring F3 注入点**：`test/wiring.test.mjs` 当前直接 import `index.js` 的
`apply` 并注入 deps。迁到 `routes.js`/`lifecycle.js` 后，`apply` 仍保持为"唯一
的挂载缝"，把 deps 透传给新模块——**F3 语义不变**（它测的是 publisher 的并发
publish，不测路由骨架）。

**peer-free**：`routes.js`/`lifecycle.js` 不 import 任何 peer，纯函数 + 注入，
与 `snapshot-aggregate.js` 同纪律，离线可测。

**影响**：`test/routes.test.mjs`（路由契约 14 键）改为对 `routes.js` 的 `wiring`
注入；`test/draw.test.mjs` 改为对 `lifecycle.registerDrawTool` 注入；`index.js`
的 `apply` 保留给 `e2e`（真 Host 挂载）。门禁：`routes` + `draw` + `wiring` +
`e2e-gate` 四套全绿。

**投入**：中（纯移动，~300 行进两个新模块 + `index.js` 瘦身 + 改 2 套测试的
注入缝）。**风险**：低（语义原样迁，无并发逻辑重写）。**回滚**：按 `git` 回退
单提交即可。

**落地状态（2026-09-29）**：已完成——新增 `routes.js`（`registerRoutes(ctx, wiring)`，
五个 handler 与 `writeJson`/`readJsonBody`/`failureCode` 原样迁入）与
`lifecycle.js`（`startSideEffects` = mount seed + `registerDrawTool` + vision
step two；`teardown` = dispose→release→off×5）。`index.js` 从 778 行瘦到
**251 行**（组装 wiring + 两处调用 + `ctx.effect` 挂 teardown），全部导出不变。
实际收敛比原方案更好：**三套测试零改动**——`routes`/`wiring` 经 `apply` 黑盒、
`draw` 只测 `draw.js` 纯逻辑，无需改注入缝。16 套件全绿。搬运中踩过一个真坑：
`ctx.effect` 的 cleanup 语义（注册时**返回**的函数在卸载时才执行；误写成注册时
直接执行会让 teardown 立即清光全部路由，wiring 首轮红即此，已修并加注释）。

> **现状更新（2026-10-03）——本节以上行数已全部作废，勿据此估工作量**：该轮拆分
> 之后又走了 [ADR.md](./ADR.md) ADR-003（路由按资源拆成 `routes/` 家族，每资源一模块）
> 与全仓 `.js`→`.ts` 归一。`index.ts` 现为 **339 行**，其中大部分是带 `WHY` 的装配注释；
> 路由门面 `routes.ts` 仅 65 行（只做「决定各 route 能碰 wiring 的哪部分」），七个
> handler 在 `routes/*.ts`（门面顶部注释列出家族地图）。下文 §2.3 的目标结构与 §5 的
> 「瘦到 251 行」均已达成且被超越，剩余项只有接线味的残余，不是行数问题。

---

## 3. peer 语义耦合：`llm-error-fix.js` 是"补丁"，可升级为"契约护栏"

### 3.1 实证核验：误判机制已逐层坐实（本机 peer 源码）

商汤限频 429 被误判为 `QUOTA` 的**完整链条**（全部已在本机 peer 坐实）：

1. **pi-ai 把 JSON body 拼进 message**（`@earendil-works/pi-ai/dist/api/
   openai-completions.js:518` → `dist/utils/error-body.js:111-118`，核验修订：
   原稿漏写 `utils/` 路径段）：非 2xx 时 `errorMessage = "<status>: <body>"`，
   body 是整段 JSON（含 `"type":"quota_exceeded_error"`）。
2. **`classifyPiAiError` 先 quota 后 rate**（`dsh-llm-pi-ai/lib/index.js:1376-1379`）：
   `isQuotaExceededError(message)` 在前，`/\b429\b|rate.?limit/` 在后——限频正则
   是**死分支**（任何体先被 quota 正则吃下）。
3. **`isQuotaExceededError` 命中面过宽**（`dsh-llm/lib/types/error.js:76-82`）：
   `/\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i`
   命中 **message 文本里的硬额度措辞**（`quota exceeded` 空格分隔、`out of
   credits/budget`、`balance exhausted` 等）。

   ⚠️ **核验修订（2026-09-29 实测）**：原稿"正则命中 `quota_exceeded_error`
   类型名（`quota` + `_exceeded`）"**不成立**——正则末尾 `\b` 词边界不会穿透
   `_`（`_` 属于 `\w`，`exceeded_error` 中 `exceeded` 之后**没有**词边界），实测
   `isQuotaExceededError('"type":"quota_exceeded_error"') === false`、
   `isQuotaExceededError('quota_exceeded_error') === false`。真正触发误判的是
   **429 体 message 文本里的额度措辞**：配合第 2 步 quota 先于 rate 的顺序，
   任何带额度措辞的限频 429 都会被判 `QUOTA`。

**验证结论**：商汤限频 429 的 body 常带额度措辞（如 `quota exceeded`、`out of rate
budget` 等），`isQuotaExceededError` 命中该措辞 → `classifyPiAiError` 判 `QUOTA`
（**类型名 `quota_exceeded_error` 本身不触发**，见第 3 条核验修订）；而
`DEFAULT_RETRYABLE_CODES`（`dsh-llm/lib/types/retry-policy.js:16-22`）不含
`QUOTA`/`ACCOUNT_QUOTA`——限频**不重试**，且面板把模型按 `exhaustedModelIds`
静默下线。这就是 `llm-error-fix.js` 存在的实证依据，**不是假设**。

### 3.2 现状评估：`llm-error-fix.js` 设计其实合理，但缺"护栏"

- **合理**：保守（只在 `code===QUOTA` 且有限频信号时纠正）、peer-free、幂等
  （已是 `RATE_LIMIT`/非 QUOTA 原样放行）、有结构化 type 兜底（`extractStructuredType`）。
- **缺护栏**：它**依赖 peer 的 message 拼接格式**（整段 JSON 进 `errorMessage`）。
  一旦 peer 改 `error-body.js`（不再嵌 body，或换 type 字段名），
  `extractStructuredType` 抓不到 → 退回纯文本启发 → **静默漏纠**，且
  `test/error-fix.test.mjs` 用固定字符串测，**察觉不到 peer 行为漂移**。
  这才是"在 peer bug 上盖房子"的真实风险面：不是"peer 修好就死"，而是
  "peer 改拼接格式就静默漏"。

  > 核验修订（2026-09-29）：漏纠的**精确触发面**是"message 文本含额度措辞 **和**
  > 速率信号"的临界体（如 `{"message":"rpm quota exhausted,...","type":
  > "quota_exceeded_error"}`）：结构化 type 分支（rateCapWords 命中 rpm/rate/too
  > many/限流等）能纠正；一旦 peer 不嵌 body 退回文本启发，`hardQuota` 会命中
  > 额度措辞 → 判定"真耗尽" → **漏纠**。`error-fix.test.mjs` 的固定字符串覆盖不
  > 到"文本启发与结构化分支分歧"的临界体——这正是契约护栏（§3.3①）要钉的点，
  > 已由 `test/peer-contract.test.mjs` 的 B 段钉死。

### 3.3 解耦选项（按推荐序）

| 选项 | 做法 | 风险 | 工作量 | 可行性 |
|---|---|---|---|---|
| **① 契约护栏（已落地，2026-09-29）** | `test/peer-contract.test.mjs`：**当真实 peer 可达时**（`peer-roots.mjs` 本地解析），钉死"peer 判 QUOTA + 含限频信号 → 本插件 `reclassifyFinish` 纠正回 RATE_LIMIT"这一**端到端行为契约**，并另设两道漂移护栏——`extractStructuredType` 必须仍能从 peer 拼好的 message 回捞结构化 type（peer 改拼接格式即红）、peer 根因未修（`isQuotaExceededError` 仍命中类型名）有显式现状钉；peer 缺席（没装 Host 的机器）则 SKIP；**CI 已由 workflow 供应运行时，故那边不再缺席**（见 [PITFALLS.md](./PITFALLS.md) §30）。 | 低（纯测试，不碰运行时） | 已完成 | 已进 `npm test` 链 + CI offline job（三方名册钉子，见 §7 门禁） |
| ② 上游修 peer（长期） | 向 `deepseek-harness`（peer 在 `packages/llm/llm`）提 PR：`isQuotaExceededError` 排除 `quota_exceeded_error` 类型名误匹配（要求 `quota` 与 `exceeded` 间非 `_` 连接，或命中时再查限频信号）。 | 高（依赖上游版本节奏，插件不可控） | 中 | 中（上游是公共仓 `github.com/deepseek-ai/deepseek-harness`，可提；但 peer 范围 `>=0.1.5 <0.3` 意味着旧 Host 仍可能跑 bug 版） |
| ③ 收紧 peer 版本（护栏） | `package.json` peer 范围 `dsh-llm/dsh-llm-pi-ai` 现为 `>=0.1.5 <0.3`。若上游修了，可收紧到 `>=0.2.x`（修后版本）并在 README 注明"需 Host ≥0.2.x 才吃满 429 修复"。 | 中（老 Host 不升级则 429 修复不可用） | 小 | 中（需上游先出修版） |

**推荐组合**：① 已落地（`test/peer-contract.test.mjs`，把"静默漏纠"变"可见红"）；
上游修复落地后叠 ③（把 peer 范围收紧到修后版本，`llm-error-fix.js` 自然退化为
no-op 兼容层，**不删**——老 peer 仍需要它）。**不删补丁**是刻意的：它是
"老 Host + bug 版 peer"的兜底，删了反而破坏向后兼容。

**投入**：① 已完成（一个新测试文件 + 进 `npm test` 链 + CI offline job；peer 不可达
时 SKIP，无需在 CI 另加 best-effort 档——它就是离线门禁的一部分）。**门禁**：离线
`npm test` 全绿（peer 不可达时 SKIP）。

---

## 4. 状态 / 契约 / UX / client：四块维护债，按"收益/风险比"排

### 4.1 状态文件重复 → 用 Host 的 `dsh-atomic-write` 统一（实证：兄弟插件已用）

- **实证**：`dsh-connect-trae` 的 `package.json` peerDependencies 已含
  `@deepseek-ai/dsh-atomic-write`（line 79，实测 `>=0.1.7-rc.1 <0.2.0-0`），且它
  用它写 catalog 状态（`lib/index.js:9,1319-1320` 实为
  `withFileLock(ownPath, () => writeFileAtomic(...))`）。而本插件在
  `throttle-store.js` / `catalog-store.js` / `provider-store.js` 三处**手写**
  同一段"temp 文件 + `rename` 原子 + 0600 + `$DSH_HOME/state/<plugin>`"。

  > 核验修订（2026-09-29）：三处手写逐行坐实（`throttle-store.js:93,144-145`、
  > `catalog-store.js:120,129-130`、`provider-store.js:107,117-118,131-132`）。
  > 但"弱隔离"的程度**因 store 而异**：`catalog-store` 已在 `:112-118` 用
  > `pid+时间戳` 唯一临时名显式处理"两个 Host 进程共享目录"（注释明说，原稿
  > 对其"裸奔"的表述过重），只剩读改写无锁；**固定 tmp 名、真有两进程互踩风险
  > 的是 `provider-store`**。`dsh-atomic-write` 的 `withFileLock` 收益仍成立，
  > 但对 catalog 是"锦上添花"、对 provider-store 才是"补洞"。
- **`dsh-atomic-write` 的语义**（`README`）：`writeFileAtomic(text, {mode:0o600})`
  （随机后缀 sibling + `rename`，拒绝跟随 symlink）+ `withFileLock`（跨进程写锁，
  解决本插件"两个 Host 进程同时写同一状态文件"的多进程问题——这正是
  `catalog-store` / `provider-store` 的潜在竞态面）。
- **收益**：删掉 ~3 份手写原子写 + 权限逻辑，收敛成一个 peer 原语；**额外**拿到
  跨进程写锁（`withFileLock`）——按上述核验修订，对 `provider-store` 是补洞
  （固定 tmp 名的并发互踩）、对 `catalog-store` 是加固（已有 pid+时间戳唯一
  临时名，剩读改写无锁），对 `throttle-store` 是统一原语。
- **代价**：新增 1 个 peer 依赖（`@deepseek-ai/dsh-atomic-write`，零运行时
  依赖的纯文件系统原语，peer 缺席时降级回手写路径或"状态缺席"，与 provider
  缺席同形）。**离线可测**：注入 `writeFileAtomic`/`withFileLock` 替身。
- **推荐**：做。分两步——先抽 `state-store.js` 统一"版本载荷 + 原子写 + 0600 +
  损坏即忽略"，`throttle/catalog/provider` 三 store 改为对它的薄封装；再接
  `dsh-atomic-write`（可选开关，peer 缺席走手写）。投入中、风险低、门禁
  `store.test.mjs` + 新增 `state-store` 注入。
- **落地状态（2026-09-29）**：第一步已完成——新增 `state-store.js`（peer-free，
  导出 `stateDir/ensureStateDir/temporaryOf/writeStateFile/readStateJson`），
  三个 store 的目录解析与原子读写全部改走原语（`throttleDir/catalogDir/
  providerDir` 委托 `stateDir`）。`catalog`/`provider` 原有 pid+时间戳唯一临时名
  策略并入原语，`throttle` 的固定 tmp 名一并消除（顺带收敛它的双进程互踩面）；
  provider 目录权限收紧到 0o700、写失败抛错语义保留。`store.test.mjs` 全部
  黑盒断言无行为变化（131 checks 全绿）。第二步（`dsh-atomic-write` peer 接入，
  拿 `withFileLock` 跨进程写锁）未做，待 peer 依赖评估。

### 4.2 契约基线 → 加 CI live-contract job（best-effort，同 e2e 纪律）

- **现状**：`test/live-contract.mjs`（手动 `npm run test:live:contract`）+
  `test/live-jwks.test.mjs`（手动 `npm run test:live`）都**不进** `npm test`，
  也没进 `CI`。`.github/workflows/ci.yml` 只有 `offline`（硬门禁）+ `e2e`
  （best-effort）两档。→ **平台方言漂移只能靠人工手动跑才看得见**（ROADMAP
  §2.2 自己也写了"修法走注释层，不静默改代码"，但没有自动触发点）。
- **改进**：在 `ci.yml` 加第三档 `live-contract`（best-effort，`continue-on-error:
  true`，同 e2e），跑 `node test/live-contract.mjs`。需要一个平台凭据（API key）
  来源：CI secret `SENSENOVA_API_KEY`（owner 注入，不进代码）。无凭据时 job
  SKIP（与 e2e "没有 dsh CLI 就 SKIP" 同形）。
- **收益**：平台改 `reasoning_effort` 取值 / 400 语义 / 目录字段时，**漂移当天
  红**（best-effort 不挡离线门禁，但 CI 日志会标红），不再等下一轮 40 请求。
- **代价**：一个 CI secret（owner 维护）+ 一行 workflow。风险极低。
- **推荐**：做。投入极小，把 §20/§21 实测从"一次性手工"变"可自动探"。
- **落地状态（2026-09-29）**：已在 `ci.yml` 加第三档 `live-contract`（best-effort、
  `continue-on-error: true`），跑 `node test/live-contract.mjs`，凭据走 repo secret
  `SENSENOVA_API_KEY`（owner 注入，不进代码）。`live-contract.mjs` 非 `*.test.mjs`
  （其头部明示"无 key → loud SKIP + exit 0"，与 e2e 缺 CLI 同形），因此**不进三方
  名册比对**，offline 硬门禁与 `npm test` 链不受影响。剩余动作只剩 owner 在 CI
  仓库配置 `SENSENOVA_API_KEY` secret。

### 4.3 UX 代价量化 → 最小实现：面板显示 auto-recover armed 状态

- **现状**：`SENSENOVA_PASSWORD` 环境变量是密码唯一持久来源（AGENTS.md 红线，
  不可动），但**用户从未被告知"我有没有设它、设了没有"**。refresh 被吊销 +
  无 env 密码 → 面板重新显示表单，用户此刻才第一次知道要重登（`AUTH.md` §7）。
- **红线内可做的最小改进**：`tokenStore.state()` 增加一个**非秘密**字段
  `autoRecoverArmed`（是否检测到 env 里有 `SENSENOVA_PASSWORD`，**只报布尔，
  不回显值**），面板在账号区显一行"自动恢复：已开启/未开启"。用户看到"未开启"
  才知道"refresh 一死就得手动重登"，可以主动去设 env。
- **量化**：这个布尔本身就是"重登风险"的可见指标——`false` 时，下次 refresh
  失败必然触发重登表单。无需埋点，一个布尔 + 一行字。
- **投入**：极小（`state()` 加一字段 + 面板一行 + 字典 + 测试断言布尔不回显值）。
  **门禁**：`store.test.mjs` + `panel.test.mjs`（字典一致性 + 不回显红线）。
- **落地状态（2026-09-29）**：Host 侧已完成——`token-store.js` `state()` 新增
  `autoRecoverArmed` 布尔（只查 env 密码存在性，值不出 store），`store.test.mjs`
  新增 4 条断言（无密码/有密码/空密码 + 序列化不含秘密值的红线）；client 侧中英
  字典（`auth.autoRecoverOn/Off`）与账号区渲染行已在 `client.js` 就位——该文件正
  含并行未提交改动，client 行随其一并合入提交（未单独带出，见 AGENTS.md 并行纪律）。
  门禁 `store` + `panel` 已绿。

### 4.4 `client.js` 单体 ≈1.9k 行 → 纯逻辑抽 peer-free 兄弟模块

> 核验修订（2026-09-29）：标题原写 1848 行；复核时点为 1875 行（且工作树有对
> `client.js` 的未提交改动，数字随改动浮动），取"≈1.9k 行"量级，不影响下述结论。
>
> **状态（2026-09-30）**：本条路线已被 ROADMAP §6.2 的正式拆分取代——纯逻辑与组件已按
> 功能拆入 `src/client/*.ts`（TypeScript），经 tsdown 构建回根 `client.js` 产物；本节保留
> 为当时的约束分析。

- **约束**：`client.js` 刻意**不 import** 任何 DSH Client 包（浏览器 module
  table 只解析包名，无构建步骤，`package.json dsh.client` 只声明 `inject`）。
  所以**不能**把逻辑拆成"多个 client entry"——client 是单 entry（`./client`）。
- **可做的拆分**：把 `client.js` 里**纯逻辑**（`interpretSnapshot`、决策、格式化、
  i18n 字典）抽进 `client-surface.js` / `panel-decision.js` / `panel-render.js`
  这几个**已存在**的测试 seam（`test/client-surface.js` 等）。现状它们是"把
  `client.js` 作为模块加载后**物化** `panel` 测试面"——即测试侧反向抽。
  **反过来**：把纯逻辑**前置**抽成 `client-logic.js`（peer-free、纯函数），
  `client.js`（浏览器 entry）与测试 seam **都** import 它——单一事实源，Node
  侧直接测 `client-logic.js`（不加载 React），浏览器侧 `client.js` 仍不 import
  任何包（只 `require("react")` + `client-logic.js` 的纯导出）。
- **前提核验（2026-09-29 实测 Loader）**：**不可行，§4.4 判停**。
  `@deepseek-ai/dsh-client-modules/lib/client.js:698-705` —— 插件 bundle 的同步
  `require(spec)` 只认 `this.seed`（平台静态 seed 包名），相对路径直接抛
  "missed the module table"；`require.async` 只接受 build-time 命名的
  `CLIENT_CHUNK`（`:707-716`）。**client.js 无法相对 import 任何本地模块或
  JSON**（`package.test.mjs` §5 的"无相对路径 + 只 require react"正是这条纪律的
  钉子）。因此 4.4a（外置 `panel-strings.json`）与 4.4b（抽 `client-logic.js`）
  **都走不通**——除非 Loader 未来支持相对 client 模块（等上游/平台，归入 §3.3②
  同类的"等上游"档）。`client.js` 保持单 entry 内联是当前架构的硬约束，不是可
  优化项。
- **推荐**：先做 4.4a（字典/决策数据外置成 JSON，零 Loader 风险，立刻把
  `client.js` 减 ~400 行）；4.4b（纯逻辑抽 `client-logic.js`）作为可选项，
  待验证 Loader 相对 import 能力。

---

## 5. 落地顺序（按 收益/风险 排，非依赖序）

| 序 | 项 | 侵入性 | 收益 | 风险 | 门禁 |
|---|---|---|---|---|---|
| **P0** | §3.3 ① peer 契约护栏测试（`test/peer-contract.test.mjs`，**已落地**） | 极低（纯测试） | 高（把静默漏纠变可见红） | 极低 | `npm test`（peer 不可达 SKIP，已进三方名册） |
| **P0** | §4.3 `autoRecoverArmed` 布尔 + 面板一行（**Host 侧已落地**；client 渲染行随 `client.js` 并行改动合入） | 低 | 中（量化 UX 代价） | 极低 | `store` + `panel`（已绿） |
| **P1** | §4.2 CI live-contract job（best-effort + secret） | 极低 | 高（漂移当天可见） | 极低 | CI 新增档 |
| **P1** | §4.1 状态文件统一（`state-store.js` + 可选 `dsh-atomic-write`） | 中 | 中（删 3 份重复 + 跨进程锁） | 中（新 peer 依赖） | `store` + 新增注入 |
| **P1** | §4.4a 字典/决策外置成 JSON（`client.js` 瘦 ~400 行） | — | — | — | **判停**：Loader 不支持 client 相对 import（`require` 只认 seed，见 §4.4 前提核验） |
| **P2** | §2.3 抽 `routes.js` + `lifecycle.js`（`index.js` 瘦到 251 行，**已落地**） | 中 | 中（接线味收编） | 中（effect cleanup 坑已修） | `routes` + `draw` + `wiring` + `e2e`（16 套件已绿） |
| **P2** | §1.3 定位对齐（README/文档 + 面板显示推理线健康，**已落地**） | 极低 | 中（消自我矛盾） | 极低 | `docs` + `panel`（已绿） |
| **P3** | §3.3 ② 上游修 peer + ③ 收紧 peer 范围（生态配合） | — | 高（根除 429 误判） | 中（依赖上游） | 等上游 |
| **P3** | §4.4b 纯逻辑抽 `client-logic.js` | — | — | — | **判停**（同 §4.4a：Loader 硬约束） |

> **不做**（与 §5.3 / ROADMAP §6 边界一致）：跨 provider 通用聚合、多 Key 池、
> 签到/每日领取（先证商汤有端点）。

---

## 6. 总判断

- **最大的设计张力（核验修订）**：原稿的"名字叫面板、事实是默认推理通道"不成立——
  `agent-default-model` 是 `dsh-agent-default-model` 回写的"上次选择"记录
  （§1.2：web=agnestokenplan、desktop=qoder-cn），且原引用内容已不可复现。真正的
  张力是**文档没覆盖已注册的 provider 能力**（README/`displayName` 只写"积分
  面板"）——这是"对齐"而非"重构"的问题：改文档 + 面板一行字，不是改架构。
- **已落地的第一优先项**是 §3.3 ① 的 peer 契约护栏（2026-09-29）：它把
  `llm-error-fix.js` 从"静态测试测不到 peer 漂移"的隐患，变成"漂移当天红"的可见
  护栏，且**零运行时风险**（纯测试，peer 不可达 SKIP）。与既有的 `peer-roots.mjs`
  / `live-jwks` 纪律同形。**下一步最该做**的是同为 P0 的 §4.3 `autoRecoverArmed`
  布尔（`store`+`panel` 两套门禁，改动面小）。
- **最有杠杆的维护债**仍是 §4.1 状态文件统一：一份重复实现抽掉三份，还顺带
  补上 `dsh-atomic-write` 的跨进程写锁（对 `provider-store` 补洞、对
  `catalog-store` 加固），是"少写代码 + 更安全"的双赢。
- **`index.js` 重构（§2.3）排 P2 不 P0**：它有价值（收编接线味）但改 2 套测试
  注入缝，风险高于纯测试项；且 `buildSnapshotBody` 抽走聚合后，`index.js`
  已不是"不可读"，是"仍最大"——收益递减。等 §4.1/§4.4a 先清完维护债再做，
  避免一次改动碰太多面。

> 本文只给方向与门禁；除 P0 的 §3.3① 契约护栏测试（`test/peer-contract.test.mjs`）
> 已随本次复核落地外，其余各项落地前先读 [PITFALLS.md](./PITFALLS.md)
> 对应条目（§18 并发 / §16 peer 解析 / §6 凭据事故）与 [AGENTS.md](../AGENTS.md)
> 红线（凭据不入库 / 只 `grant` 一种 kind / `auth` 顶层键 / PKCE `Uint8Array` /
> trace 落盘 / 密码 JWE），以及 [CONTRIBUTING.md](./CONTRIBUTING.md) 的提交纪律
> （路径限定提交、`git status --short` 复核）。

---

## 7. 模型花名册重排：向 WorkBuddy 形状学习（2026-09-30 已落地）

对面板「推送到 DSH 的模型」一次锐评的落地记录。三个病灶、三个取舍：

- **卡内再画卡**：原每行 `border + bg-layer-2` 小胶囊，把区块卡（`sectionCard`
  已有唯一边框）切成栅栏。**取舍**：行改为扁平行 + `borderBottom` 分隔线
  （面板内 `trendRow` 已有此先例，不是新发明）；徽章去掉描边只留底色阶，
  且**默认态不发徽章**——「纯文本」是缺省，给缺省发徽章等于给什么都没发
  （`llm.rosterText` 键随之一删，双语同步）。
- **参数不可见**：用户看不到 LLM 参数与预设上下文。**取舍**：每行加缩进参数行
  （上下文 + `llm.metaOutput` + `llm.metaLevels` 可选档位列表），数字只报**平台声明**的
  `max_output_length`（`maxOutputLengthOf`，0 = 未声明就不画该段，绝不猜）；
  档位列表与思考默认值分家——**行内只放会变的**（`supportedThinkingLevels`，按 pi-ai
  `getSupportedThinkingLevels` 同一规则对本方 map 过滤，即 DSH 选择器实际给出的集合，
  glm-5.2 独享「最高」档），**不放的**是 provider 级常数：默认档 `DEFAULT_REASONING_EFFORT`
  单一常量（`llm-adapter` 派发它、快照播报它，展示与行为构造上不可漂移）只在花名册
  头部说**一次**（`llm.rosterThinkingDefault`）。首版曾把「默认思考强度 high」逐行打印，
  当日即被指出：七行同样的字是噪音不是信息——**逐行重复恒定量**这个反模式记在此处。
   修订（2026-09-30 两连）：①扩展档 xhigh 原对**所有**模型开放、max 只 glm-5.2 特判，改为逐模型门控（当时叫 EXTENDED_THINKING，数据抄自冻结契约 test/baselines/sensenova-contract.json）：xhigh 只对 deepseek-v4-flash 开（唯一实测 200 者）、max 只对 glm-5.2 开，未实测模型两档都关；②同日再收紧一档——low/medium 原对全家族无条件开放（依据只是平台 400 报错文案里出现过这两个词，而 SENSENOVA-API.md §7.6 明说那串列表是**并集**、各模型支持面不同），并入同一张门控表（改名 PROBED_EFFORT，覆盖 low/medium/high/xhigh/max 五格）：high（平台默认，全家族实测过）保持开，low/medium 尚无逐模型探针（test/live-contract.mjs 已扩探针段，跑完按 200/400 结果翻表），两格先关——面板未实测不画。
   收官（同日 22:11 探针首跑）：PROBED_EFFORT 已按实锤 200 翻表——sensenova-6.8-flash-lite / deepseek-v4-flash / glm-5.2 三家 low+medium 全开，deepseek-flash / kimi-k3 各开 medium；deepseek-v4-pro 两格与另两家 low 格仍 INDEFINITE（429 是限流节奏答案、非 400 参数拒——重跑翻表，不造假证），契约表 driftLog 留了证据原文。
- **倍率与格式**：`trendMultipliers` 一直存在但只在趋势表露面。**取舍**：抽
  `matchMultiplier` 单一匹配器，趋势行与花名册行共用——同一模型的 `×N` 两处
  是同一计算事实；未命中无字段（不猜 1）。上下文格式修 `1049k` 占位符感 bug
  （`Math.round(1048576/1000)`）：新增 `tokenSize`，千整走十进制（128000→128K）、
  二进制才走 1024（262144→256K、65536→64K）、≥1M 走 M（1048576→1M）。
  顺带补上 `quotaExhausted` 徽章（CHANGELOG 曾承诺"灰色显示原因"而 client 从未实现）。
- **明确未做（P2，待目录签名联动）**：每模型上下文预算单选与卡内图片开关——
  覆盖值不进 `catalogSignature`（`id:vision` 位串），改了不会触发重注册，
  先动签名再动 UI。

验证钉：`render` G4（1M/×N/额度耗尽/档位列表本地化/默认值不逐行重复 + `tokenSize` 直测）、
`routes` Q2（行含 `maxOutputLength`/`multiplier`/`thinkingLevels` 与 `llm.thinkingDefault`）、
`retry` §5（投影层 0=未声明 + 档位过滤与 pi-ai 规则一致）。

---

## 8. `strictNullChecks`：为什么它是"另一档"，不是"再开一个开关"（2026-10-01 评估）

tsconfig 严格开关分档推进的收尾评估。前四档（零成本 8 项 → 挂门禁 → `useUnknownInCatchVariables`）
都是**运行期行为不变的纯类型操作**：要么实测 0 错直接开，要么 cast/改名即可，`store-baseline`
零漂移 + 全量 e2e 绿就是全部证明。`strictNullChecks` 破了这个模式，故**判为独立 backlog、不在本轮开**。

**实测（2026-10-01，叠加在已开的 10 个严格开关之上）**：`tsc --strictNullChecks` 报 **142** 处
（早先单测基线 93；差额是 `noUncheckedIndexedAccess` 与本开关的叠加——下标访问同时满足"可能 undefined"
两个条件后成倍暴露）。分布高度不均：

| 集中度 | 文件 | 处数 | 性质 |
|---|---|---|---|
| 一个文件占 1/3 | `src/client/qr.ts` | 48 | 纯渲染数学（QR 点阵生成），peer-free、自成一体 |
| **登录红线路径** | `routes.ts`(18) + `token-store.ts`(5) + `sensenova-auth.ts`(1) + 两个 publish(各5) + `raccoon.ts`(1) | **~40** | null 语义要人判：该 `??` 还是加守卫还是确认可信 |
| 其余 | 18 个文件散布 | ~54 | 状态存储、解析、面板渲染 |

**为什么不能像前几档一样硬开**：

1. **无 per-file 粒度**——`strictNullChecks` 是全有或全无，一旦进 tsconfig 就得 142 处全修。
2. **每处都是运行期决策，不是类型层**：`error?.code` 那种 cast 能机械做（§useUnknownInCatchVariables），
   但 `obj[key]` 变 `T | undefined` 后，"这里到底会不会 undefined、该给什么默认"必须人判——**猜错就是 bug**，
   而这些点 40 处落在 AGENTS.md 红线 1/5 的登录路径（错密码锁号、trace 必须落盘）。红线区的 null 决策
   不能用"全量 e2e 绿"背书——e2e 走的是 happy path + 固定假平台，覆盖不到所有 undefined 分支。
3. **收益递减**：前四档已把"零风险"的红利吃完；SNC 是"高判断成本换高表达力"，与"按域裁剪、禁止无脑全量"
   的验证纪律相悖。

**裁定（2026-10-01 更新，非红线子集已按 allowlist 逐档毕业）**：整体硬开判为"下一档独立大 PR"，不动；
但本档描述的**最低风险路径已全部走通**——**整个 client 半区 + host 非红线的
数据/解析/开关/诊断/出图层**经 `tsconfig.strict-null.json`
（per-file strictNullChecks allowlist，主配置排除这些文件）纳入 SNC + `noUncheckedIndexedAccess`
强制，由 `test/typecheck-gate.mjs` 跑两份 config 守门。毕业一个文件=移进本 include +
加进主配置 exclude（同一 commit，否则同一文件被两套规则跑两遍）。

已毕业（SNC + `noUncheckedIndexedAccess` 全绿，按风险递增序，均纯类型层零运行改动）：

**client 半区（计数 0）**：
- **`src/client/qr.ts`（48 处）**：零 import、peer-free、纯点阵数学；`!` 断言（越界由
  size×size 循环构造排除）+ 两张 ISO 常量表补类型。正确性由 raccoon.test 的 **jsQR 解码回
  原 payload**（v1–v10 探针 + 真登录 URL）背书——该文件注释自陈的 ground-truth。
- **`cards.ts` / `account-form.ts` / `panel-page.ts`（9 处）**：渲染/表单层，失败模式是
  "面板画错"非"锁号"。手法是把旧隐式语义显式化：`remaining` 加 `typeof === "number"` 守卫
  （旧 `undefined <= 0 === false` 的"不知道就不画"一字不差）；`REFUSAL_TEXT[code]` 先判 string；
  `limit/used` 默认 0；`panel-page` 把恒真的 `if (document.addEventListener)` 改
  `"addEventListener" in document`（TS2774：函数引用恒真，本意是探测存在性——唯一一处真修正）。

**host 数据/解析层（批次A）**：`state-store` / `catalog-store` / `parsers` / `llm-models` /
`raccoon-models` 毕业。根因全是指针化钉死类型（`const x=[]`→`never[]`、`let x=null`→`null`、
默认参数 `param=null`→类型锁 null——tsconfig `$comment` 警告的形状，`noImplicitAny:false` 下仍
对带初值绑定生效），修法纯类型层：`createStateReadCache` 补 `<T>` + options 参数类型 +
`cached: T|null|undefined`（undefined=没读过 / null=读过无记录，语义不可混）——一处修全仓四
store 的 `inheritFrom` never 下游投影；裸数组补元素类型；memory store 的 `let held` 补 record 联合。
闭包叶子 `raccoon.ts`（被图内 import 拖入、本身未毕业）顺手修 1 处 never[]。

**host 开关/诊断存储 + 出图工具（批次B）**：`provider-store` / `draw-store` /
`raccoon-switch-store` / `doctor` / `draw` 毕业。三个开关 store 本身零修复（其错误本就是
state-store 原语的下游投影，批次A已解）；`doctor` 的 `scope` 字面量按 `DoctorScope` 接口标注 +
`profiles: string[]`；`draw` 的 `out: string[]`。闭包核查：五文件传递 import 全落在已毕业/干净叶子。
`snapshot-aggregate` 自身 SNC 干净但闭包拖进 provider-publish（红线），**未毕业**。

**发现（批次A 标注的涟漪，归终审议题）**：给 `raccoonRoster` 补 `object[]` 后，全项目 SNC 探针
里 `routes`(20) / `index`(3)——其中 routes:942/945、index:283 是**消费方形状之争**（消费侧把
roster 声明成 `multiplier: number` 的 never-undefined 行，roster 却可推 undefined；`any[]` 时代静默
放行）。两份门禁 config 均为 0，不影响运行——它正印证"红线消费方需逐帧评审"，故留独立大 PR。

**剩余（真·backlog，全项目探针 43 处，全在登录/装配路径）**：routes 20 / token-store 5 /
provider-publish 5 / raccoon-publish 5 / index 3 / sensenova-auth 1 / api-key-store 1 /
raccoon-store 1 / llm-error-fix 1 / raccoon-llm-adapter 1。每处需人判 null 语义 + 消费形状契约，
按 `store-baseline` 那样的"逐帧评审 + 显式重生成"规格做，独立大 PR。

---

**批次C（2026-10-02）——登录/装配路径毕业，allowlist 收束为全局翻转**。

上面"真·backlog"里的 43 处，实际探针（`strictNullChecks` + `noUncheckedIndexedAccess` 全项目，
含 client + shared + host）为 **34 处**、跨 14 文件（43 是早前快照，部分已被批次A/B 顺手吸收）。
本节按"修根因不逐点打补丁"的次序清到 0，全部纯类型层、`store-baseline` 零漂移（见下）：

| 根因 | 手法 | 命中文件 |
|---|---|---|
| `let x = null` / `x: null` 字面量把类型锁成 `null` | 声明处给可赋值类型（`string \| null`、`T \| null`） | token-store、provider-publish、raccoon-publish、raccoon-status、raccoon-store、index |
| `const a = []` 推断 `never[]` | 补元素类型（`Buffer[]`、`any[]`、`string[]`） | routes、sensenova-auth、llm-models |
| **带默认初值的参数**由初值定型（`fallback = null`、`error = null`、`credentials = null`、`= []`） | 显式注解参数类型（`.ts` 里 JSDoc 不产类型） | util、publish-core、api-key-store、provider-publish、index |
| 捕获组 `match[1]` 在 `noUncheckedIndexedAccess` 下为 `string\|undefined` | 归一到已声明契约（`?? null`）；该正则组 1 匹配时必有值 | llm-error-fix（真缺陷：`!== null` 守卫漏 `undefined`） |
| 共享原语下游投影不匹配 | 一处修全：`optional<T,F>` 泛型化；`pickDefined` 返回值类型 `Exclude<null\|undefined>`（旧类型把 `{error}` 撑成 `string\|null`，RaccoonState.error 只收 `string`） | util |
| **消费方形状之争**（§8 末尾"留独立大 PR"那条） | 逐帧裁定：`RaccoonState.models` 改 `readonly RaccoonModel[]`（全仓只读，无一处 push；测试用引用相等钉住 frozen fallback，`RaccoonModel[]` 是被违背的契约）+ client `RaccoonRoster` prop 同步；`roster` 显式 `readonly`；`settled` 收窄为带 `accessToken: string` 的交集类型（`raccoon-walk` 保存凭据处原为 `string\|undefined` → 真缺陷）；`publishProvider` 参数 `string[]` 注解（原 `never[]`）；`resolveToken` 改必填（对齐姊妹 `createSensenovaAdapter.resolveApiKey`，去掉 `= {}` 默认） | wire、raccoon-roster、raccoon-status、raccoon-walk、raccoon-llm-adapter、types、index、provider-publish |
| 装配对象与 `Wiring` 声明不符 | 根因是 `publishProvider` 的 `never[]`，非 `Wiring` 本身 | index |

`token-store` 整条链路（含 5 个 block）通过把隐式字面量升成显式接口 `TokenStoreState`
/ `StoreContextWiring` / `StoredGrant` / `HeldThrottle` / `AuthLike` / `CredentialBackend`
/ `ThrottleStore` 清零，`isFresh` 补 `token is StoredGrant` 类型谓词（其运行时契约本就
"非 null 才算 fresh"，谓词不新增检查）。两个 publisher 的共享注册态收进
`publish-core.PublisherStateBase`，领域差异（catalog 行 vs roster 行）留在各自的
`ProviderPublisherState` / `RaccoonPublisherState`——正是 publish-core 头注的共享/差异纪律。

**allowlist 收束**：34 处清零后，allowlist 覆盖已达 src 100%，per-file 分档机制的历史使命
完成——**`tsconfig.json` 直接开 `strictNullChecks: true`**（§8 的"整体硬开"判为独立大 PR，
如今以"逐档毕业到 100% 再翻转"的次序落地，而不是一次性 142 处硬开）。
`tsconfig.strict-null.json` 保留（`typecheck-gate` 硬性要求存在），但已退化为与主配置
等价的双重确认。验证：`npm test` 全绿（含 `typecheck-gate` 两份 config、`store-baseline`
零漂移、`build-gate`、`e2e-gate`）。

---


**批次D（2026-10-03）——noImplicitAny 八域迁移 + strict 全局翻转**。

批次C 翻 strictNullChecks 后，剩余最大的类型洞是 `noImplicitAny: false`：
全项目探针 **449 处**隐式 any（TS7006 参数 389 + TS7031 解构 36 + TS7053 索引 12 +
TS7005/7034/7023/7024 杂类 12），跨 43 文件，host 侧 446 / client 3。按"从叶子往根、
每域一个测试过的 commit"分八域清到 0，再翻 flag（与 SNC 同一 graduation-track 纪律）：

| 域 | 文件 | 消数 | 备注 |
|---|---|---|---|
| 叶子域 | util/codes/trace/modality/coalesced-fetch | 16 | 全库地基；`redactSecrets` 等防御性函数标 `unknown`（诚实签名） |
| token-store 域 | token-store 全家 + throttle/api-key-store + index 一行 | ~83 | 接线 state.ts 已声明未接线的 `StoreContextWiring`/`TokenStoreState` 等接口 |
| state-store 域 | 5 个状态文件 store | 47 | 提取 `CatalogRecord`；同构开关 store 三件套 |
| LLM/console 域 | host-config/console-client/llm-models/llm-adapter(-core)/llm-error-fix | 64 | 提取 `ResolvedSettings`（下游首个受益者）；`CatalogEntry` 接口 |
| 解析/聚合域 | parsers/snapshot-aggregate/draw/switch-precedence | 71 | `PoolRow`/`PoolUsage`；nestedMissing 递归补返回注解（消 TS7023） |
| 发布链域 | publish-core/provider-publish/lifecycle/index/raccoon-publish | 54 | `PublisherStateBase` 复用；`DrawFetchResponse` 具名（消嵌套泛型语法冲突） |
| raccoon 家族 + client | raccoon 全家 + 3 个 client 文件 + 2 个 routes | 23 | raccoonHeaders 改 `Record<string,string>`（消 3×TS7053） |
| 凭据红线域 | sensenova-auth/sensenova-crypto | 82 | `AuthConfig`/`AuthTrace` 接口；IAM_REASON_CODES 索引收窄 |

**接线过程揭穿的潜伏问题**（不开 noImplicitAny 永远看不到）：`isFresh` type predicate
误用（stale grant 也是 StoredGrant，false 分支窄化成 never——改显式 null 检查）；
`AuthLike.expiresIn` 被 `[key: string]: unknown` 索引签名吞成 unknown；`writeLoginTrace`
的 JSDoc 说 `object[]` 而 types.ts 真类型是 `unknown[]`（JSDoc 撒谎按真类型标）；
`resolveSettings` catch 降级分支缺 8 字段与 happy path 形状不一致。

**翻转**：449→0 后开 `noImplicitAny: true`；随即干查 `strict: true` 仅剩 1 条
（`Set.next().value` 在 noUncheckedIndexedAccess 下 `string|undefined`，`?? ""` 守卫），
**同日再翻 `strict: true`**——8 个 strict 子旗标至此全开，`tsconfig.json` 的
`strict`/`noImplicitAny` 均 true。`tsconfig.strict-null.json` 保留作冗余双查
（其 include 含 doctor.ts，翻转后暴露 7 条隐式 any，已同 commit 标净）。
验证：`npm test` 全链绿（typecheck-gate 两配置 strict 下 0 错、store-baseline
零漂移、e2e 91）。



**批次E（2026-10-03）——exactOptionalPropertyTypes 翻转（strict 家族收官）**。

strict 翻转后最后一个可议强旗标。干查 9 条错误，全仓**同一根因**：给可选属性
显式赋 `undefined`（`{ opt: v ?? undefined }` 或对象字面量直接展开可能为
undefined 的值）——exactOptionalPropertyTypes 要求可选属性**缺席**而非
`undefined`。修法统一为**条件展开**（`...(v !== undefined ? { v } : {})`），
零行为变更，命中 9 文件：draw（buildDrawBody 的 n/watermark）、llm-models
（toPiDescriptor 的 baseUrl）、llm-adapter/raccoon-llm-adapter（get）、
token-store/state（wiring 的 onTrace）、snapshot-aggregate（drawModel）、
sensenova-crypto（fetchJwks 的 timeoutMs）、use-snapshot-polling（signal）、
raccoon-tab（providerError）。翻转后 `npm test` 全链绿（typecheck-gate 两
配置 0 错、e2e 91、build-gate client.js 重建字节一致）。

**至此类型工程终态**：`strict: true`（8 子旗标）+ `noUncheckedIndexedAccess`
+ `exactOptionalPropertyTypes` + `noUnusedLocals/Parameters` +
`erasableSyntaxOnly`——全仓最高严格度下 0 错误，四轮强化（SNC →
noImplicitAny 449→0 → strict → exactOptionalPropertyTypes）均走
"干查爆炸半径 → 清 → 翻转 → 全量门禁裁决"同一纪律。


## 9. 姊妹插件对照：`dsh-connect-agnes-token-plan` 的设计差异与借鉴清单（2026-10-02 快照）

> **档案性质**：本文是**研究档案**（同 §1–§8 定位），不是待执行清单。对照对象是
> 兄弟插件 `~/.dsh/plugins/dsh-connect-agnes-token-plan`（**v0.8.0**，本插件 **v0.4.7**，
> 同一作者 eghrhegpe，同一「大统一」架构家族）。快照日期 2026-10-02；文中 Agnes 侧的行号/
> 版本/模块清单以该日期的本机源码为准，平台改行为时以实测为准。
> **一句话结论**：差异不是"两套设计"，而是"同一蓝图、Agnes 多走了 2~3 个版本的重构步"——
> 路由拆分、开关统一、决策账本、maxTokens 实测钉值四件事 Agnes 已完成，本插件恰好停在
> 各自"改造前"；反过来，线契约单一声明、全仓 strictNullChecks 翻转、jscpd/commit-lint
> 三道护栏是本插件领先 Agnes 的。

### 9.1 共同底座（别误读成两套设计）

两者机制几乎逐字同构：Host/Client 两半 TS、Plugins 页三 tab 卡片、`大统一`定位
（两侧同为 2026-09-29 改）、三条不变量（opt-in 默认关 / 凭据红线 / 厂商边界）、
`token-store/` 六块拆分 + `store-baseline` 冻结、`publish-core`/`provider-publish`
发布状态机、`llm-error-fix` 429 分诊、`state-store` profile 分段、e2e 假平台、
doctor CLI、PITFALLS 文档文化。可比的是各自演进到哪一步，不是机制本身。

### 9.2 核心差异对照

| 维度 | 本插件（SenseNova） | Agnes 插件（v0.8.0） | 谁更成熟 |
|---|---|---|---|
| 登录 | OIDC+PKCE+JWE（密码 RSA-OAEP+A256GCM 封包）+ **refresh_token 静默续期**，密码可删（`../src/host/sensenova-auth.ts` / `sensenova-crypto.ts`） | 一跳 `POST /api/user/login`，**无 OIDC/无 refresh**，过期用存密码重登；fallback 7 天防误杀 | 平台决定：SenseNova 有刷新流所以本插件更省心；Agnes 是平台不给 refresh 的被迫形态 |
| 第二上游 | 小浣熊：面板内**微信扫码登录**（`../src/client/qr.ts` + `../src/host/raccoon-walk.ts`） | AgnesCode：**读本机桌面 App 会话文件**（os_crypt+DPAPI），JWT≈28 天、**无自动续期**须手动重采 | 小浣熊交互自洽；AgnesCode 零配置但每 28 天手动一次（其文档自标"已知限制"） |
| 路由组织 | `routes.ts` 门面 + `routes/` 8 模块（**2026-10-02 拆分已落地**，§9.4 P0；先冻结 `routes`/`wiring` 再搬，零漂移） | `routes.ts` 88 行 facade + `src/host/routes/` 8 模块（2026-10 按 token-store 术式先冻结测试再搬） | 已对齐 Agnes 术式 |
| 开关商店 | `provider-store` / `draw-store` / `raccoon-switch-store` 共享 `state-store` 原语 + **`switch-precedence.ts` 单一裁决处**（2026-10-02 落地：resolveSwitchEnabled/Source 统一三处手抄方言，`switch-precedence.test.mjs` 钉红） | `switch-store.ts`（四开关共用一层）+ `switch-precedence.ts`（"面板值 vs 配置默认"唯一裁决处，带来源标签） | **已对齐核心**：底层原语共享 + 唯一裁决处；store 文件级行为层暂不强制合并（差异属真实领域形状） |
| maxTokens | **声明目录权威值**（2026-10-02 落地：真机探针钉住 harness 对未声明值强制填 32768；目录 `max_output_length` 有则声明、缺则回落不声明；实测上限因模型而异——flash-lite 硬上限 65536、v4-flash/glm-5.2 接受 131072） | 真机探针推翻旧决策：**钉 65536**（harness 对未声明值强制填 32768=减半，见其 AGNES-API.md §7.3） | **已对齐并细化**：Agnes 全局钉 65536，本插件按目录逐模型声明（更准） |
| 模态判定 | `modality.ts` **单一裁决**（2026-10-02 落地：`outputModalityOf` 一份判断，`isChatModel` 宽松方向与 `isImageGenModel` 严格方向从它派生，缺字段不再让两方向反向失手；llm-models/draw 各自 re-export 保持导出面） | `modality.ts` **单一函数三级判定**（声明字段→名称段→默认），矛盾由构造消除 | **已对齐**（SenseNova 平台恒有模态字段，无需名称段兜底） |
| 出图/视频 | 只有 `sensenova_draw_image`（视频线**判停**：2026-10-02 探测平台无视频模型/端点，前提不成立） | draw + **`agnes_video_generate`**（异步任务、V2.0/2.5 双参数族互斥分派） | 功能面 Agnes 更宽，但 SenseNova 平台无视频能力，不构成对标缺口 |
| 线契约 | `../src/shared/wire.ts` **单一声明**，client 侧只是再导出面，`tsc` 是第一守门员 | 契约仍留 client 侧镜像，靠 `contract.test.mjs` §10 解析对账 | **本插件领先**（Agnes 尚未收敛） |
| 类型门禁 | 2026-10-02 **全仓 strictNullChecks 全局翻转**（§8 分批毕业，`../test/typecheck-gate.mjs` 把关） | `noUncheckedIndexedAccess`+`exactOptionalPropertyTypes` 全局开，`tsc-gate.mjs` 保证 `npm test` 真跑 tsc | 两者殊途同归；本插件翻转更彻底 |
| 文档治理 | `./ARCHITECTURE.md` §5 用**内联「修订（日期）」补丁**记录沿革 | **`docs/ADR.md` 决策账本** + `ARCHAEOLOGY` 机械检查**禁内联修订补丁**；另有 `REFERENCES.md` 登记 `upstream/` 容器 | **Agnes 领先**：裁定沿革外置账本，正文只写现状 |
| 测试编排 | package.json 用 `&&` 链 25 个套件 + jscpd + commit-lint | `test/run.mjs` 聚合器（`--only` 过滤）+ tsc-gate | 各有取舍；本插件多了 jscpd 与 commit-lint 两道护栏 |
| 上游容器 | `upstream/` 12 个对照仓库，但**无清单登记** | `upstream/` 20+ 件 + `REFERENCES.md` + `SOURCES.md` 登记来源/版本/承重 | **Agnes 领先** |

### 9.3 优缺点归纳

**Agnes 设计优点（本插件应借鉴）**：
1. **`routes/` 拆分 + 冻结先行**：875 行单文件 → 8 个资源路由，facade 只留注册顺序；
   做法是"先让测试在 facade 上全绿再搬家"，零漂移。本仓 `.agnes` 可读性评审的 P0 建议与它完全同向。
2. **`switch-store` + `switch-precedence`**：四开关共用行为层 + 唯一裁决处，"值来自哪
   （panel/config/off）"随答案一起返回——本插件三份 store 还欠的工程收敛。
3. **maxTokens 钉实测值**：用真机探针推翻"不声明"旧决策。**已落地（2026-10-02）**——
   harness 兜底坐实（`dsh-llm-pi-ai` resolveRouteModels 对未声明强制 32768），真机探针
   钉住 SenseNova 上限因模型而异（flash-lite 硬上限 65536、v4-flash/glm-5.2 接受 131072），
   descriptor 改为声明目录权威值（有则声明、缺则回落）。
4. **`ADR.md` 账本 + 禁内联修订补丁**：决策沿革不进正文，docs.test 机械把关——本插件
   §5.5 的内联修订恰恰是它明令禁止的形态。
5. **`modality.ts` 单点判定**：模态判定一个函数服务两方向，避免"缺字段时严格/宽松朝相反
   方向失手"这类矛盾。
6. **视频工具**：异步任务状态机 + 双参数族互斥分派，是出图之外的完整第二工具线。

**本插件设计优点（Agnes 反而欠着）**：
1. **`../src/shared/wire.ts` 单一契约声明**：Agnes 还在 client 镜像 + 正则对账；我们已由
   `tsc` 直接守门（含嵌套结构，Agnes 的解析只比顶层字段）。
2. **全仓 strictNullChecks 全局翻转**：分批毕业、`tsconfig.strict-null.json` 留作冗余双查，
   登录/装配路径已清零——Agnes 只做到"tsc 真跑"层级。
3. **jscpd 重复代码检查 + commit-lint**：Agnes 的 scripts 里没有这两道。
4. **refresh_token 自动续期**：登录一次后密码可删；Agnes 每到期一次就要依赖存密码重登。
5. **小浣熊面板内扫码登录**：交互闭环在面板内；AgnesCode 的 28 天手动重采是它自认的
   "已知限制"。

**各自短板**：本插件——开关优先级三处手抄、无 ADR 账本（内联修订
在沉积）、无 maxTokens 钉值、注释密度过高（`.agnes` 评审已量化：18 个文件注释占比 >48%，
最高 77%）。Agnes——密码明文过 TLS（平台无 JWE 端点）、无 refresh 导致"令牌疑似死"时会真花
一次登录尝试（靠 7 天 fallback 补偿）、AgnesCode 无自动续期、client 契约镜像未收敛、无全局
strictNullChecks 翻转。

### 9.4 可落地借鉴清单（按优先级，门禁对齐 §5 风格）

| 优先级 | 借鉴项 | 对应现状 | 门禁 |
|---|---|---|---|
| **P0** | 拆 `../src/host/routes.ts` 为 8 个资源路由 + facade（先冻结 `routes.test.mjs` 再搬） | **✅ 已落地（2026-10-02）**——`routes/` 8 模块 + facade，`routes`/`wiring`/`config`/`raccoon` 拆分前后零漂移 | `routes` + `wiring` + `e2e-gate` |
| **P0** | 真机探针钉 SenseNova 的 `max_tokens` 平台上限（验证是否也吃 32768 兜底） | **✅ 已落地（2026-10-02）**——live-contract 新增 §2c 探针；harness 兜底坐实（未声明强制 32768），flash-lite 硬上限 65536 / v4-flash、glm-5.2 接受 131072；descriptor 改声明目录权威值 | `live-contract`（best-effort）+ `contract` + `provider` + `typecheck` |
| **P1** | 建 `docs/ADR.md` 账本 + docs.test 的 `ARCHAEOLOGY` 检查，把 §5 内联修订迁出正文 | **✅ 已落地（2026-10-02）**——ADR-001~004 入账本，§5 内联修订迁为现状表述，`docs.test` 新增考古纪律检查 | `docs` |
| **P1** | 三份开关 store 收敛为共享 `switch-store` + `switch-precedence` | **✅ 已落地（2026-10-02）**——`switch-precedence.ts` 单一裁决处（resolveSwitchEnabled/Value/Source）替换 provider/models/draw 三处手抄方言；store 底层原语本就共享 `state-store`；`switch-precedence.test.mjs` 进 `npm test` + CI | `store` + `routes` + `switch-precedence` + `package` |
| **P1** | `modality.ts` 单函数统一两个判定方向 | **✅ 已落地（2026-10-02）**——`outputModalityOf` 单一裁决 + `isChatModel`/`isImageGenModel` 派生；矛盾由构造消除（provider.test 补互补断言） | `provider` + `draw` + `contract` + `typecheck` |
| **P2** | `docs/REFERENCES.md` 登记 `upstream/` 容器清单 | **✅ 已落地（2026-10-02）**——商汤线 + 生态核实线 12 件登记来源/版本/承重，容器纪律与维护入档 | `docs` |
| **P2** | 视频工具线（若 SenseNova 平台有视频模型） | **判停（2026-10-02 探测）**——平台文档、冻结契约与真机目录（live-contract 拉取，9 模型全为对话/图像生成）均无视频模型/视频端点；对标前提不成立，待平台出视频能力再议 | — |

> 执行纪律：落地任何一项前先读 [AGENTS.md](../AGENTS.md) 红线与对应 [PITFALLS.md](./PITFALLS.md)
> 条目；Agnes 侧的完整决策沿革与裁定账本见其 `docs/ADR.md` / `docs/ARCHITECTURE.md` §5
> （本机路径 `~/.dsh/plugins/dsh-connect-agnes-token-plan/`，非本仓库文件，不经 docs.test 校验）。


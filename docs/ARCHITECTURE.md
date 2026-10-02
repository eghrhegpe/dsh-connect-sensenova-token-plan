# 架构（Architecture）

本仓库 `dsh-connect-sensenova-token-plan` 是 DeepSeek Harness 的一个**插件**，在 Harness Web UI 的 **Plugins 页**以插件卡提供商汤（SenseNova）控制台 Token Plan 的实时积分用量面板。它还**不是**一个独立可运行程序，而是挂在 Host（桌面版 / `dsh web`）里的一截逻辑。

本文讲清三件事：插件与 `upstream/` 的关系、插件内部的 Host/Client 分流、以及数据如何流动。

---

## 1. 双仓库关系：`dsh-connect-sensenova-token-plan` 与 `upstream/`

本仓库根目录下有一个 **被 `.gitignore` 忽略的 `upstream/`** 目录，它是从 `~/.dsh/fork/sensenova-usage-dashboard` 移入的**上游仓库**（独立 git 仓库，线上：[shaobingtongzhi/sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard)；本地副本当前不带 `.git`，恢复方式见下方引用块）。

| 维度 | `dsh-connect-sensenova-token-plan`（本仓库） | `upstream/`（被忽略，独立仓库） |
|---|---|---|
| 形态 | DSH 插件（Host 半边 + Client 半边） | 独立 Python 桌面应用（pywebview 原生窗口） |
| 语言 | Host 半边与 Client 半边均为 **TypeScript 源码**（`src/host/*.ts` + `src/client/*.ts`），经 `npm run build`（tsdown）构建为 `lib/`（Host 单条 ESM bundle + 动态切分 chunk）与根 `client.js`（Client IIFE 产物）；`lib/` 与 `client.js` 均为 `.gitignore` 忽略的纯构建产物，删后可从 `src/` 重建 | Python（`dashboard.py` + `auth_login.py`） |
| 账号凭据 | 走 **DSH 凭据服务**（`~/.dsh/.credentials.yaml`），无明文文件 | 明文存 `accounts.json`（为支持自动重登） |
| 令牌续期 | **`refresh_token` 静默续期**，面板过期无需重启 | JWT 过期后用明文账号密码**重登** |
| 登录节流 | 区分时间型 / 凭据型拒绝，防锁号 | 仅基础重试 |
| 与控制台交互 | `pool-usage` / `credit-usage-trend` / `GET /v1/models` | 同样的 `pool-usage` 等接口 |
| 是否进本仓库历史 | 是（本仓库主开发目标） | **否**（gitignored，保持独立 git 历史与 remote） |

**为什么要这样放：** 上游 Python 工具是这套商汤控制台集成的「原始实现 / 参考源」，里面沉淀了接口字段、打包（`build_mac.sh` / PyInstaller `.spec`）、登录封包等可复用知识。把它以**被忽略的 `upstream/`** 形式容纳进本仓库，既能随时对照、复用其接口与打包经验，又不会污染本插件仓库的提交历史，也不会把明文凭据文件（`accounts.json`）带进版本库。插件在**构建期与运行期都不依赖 `upstream/`**——两者只是概念上的上下游，没有代码耦合。

> 若需向上游提交改动，进入 `upstream/` 目录本身就是一个完整 git 仓库，直接 `git` 操作即可，与外层仓库互不影响。**注意：本地副本当前实测不带 `.git`**——若要在其中独立 `git` 操作，先恢复为独立仓库：
> `git clone https://github.com/shaobingtongzhi/sensenova-usage-dashboard upstream/sensenova-usage-dashboard`

---

## 2. 插件内部结构：Host 半边 vs Client 半边

插件分两半，加载时机与改动代价完全不同：

| 半边 | 文件 | 加载时机 | 改动后如何生效 |
|---|---|---|---|
| **Host（服务端）** | `src/host/*.ts`（清单以该目录为准，经 `npm run build` 构建为 `lib/`） | 启动时加载一次 | **重新构建 + 完全退出 DSH（含托盘）再启动**，`dsh web` 不会热重载 |
| **Client（前端）** | `src/client/*.ts`（构建为根 `client.js`） | 浏览器侧，随页面加载 | `npm run build:client` 重建后浏览器刷新即可 |

- `index.ts`：Host 入口——注册只读路由 `/api/dsh-connect-sensenova-token-plan/snapshot`（聚合控制台数据，401 自动续期重试一次）+ 账号配置路由 + 各 store 接线与 side-effect 编排。
- `routes.ts`：**路由主模块**（990 行，本仓库最大的 Host 文件）——snapshot / account / api-key / provider / models / draw / raccoon 七条路由的 handler、同源闸、body 上限、`writeJson` 全部在此；`index.ts` 只保留 HTTP 面与装配。小浣熊的**读模型**已抽出为 `raccoon-status.ts`（原先它是 handler 内一个 190 行闭包），这里只剩扫码 walk 与四个 mutation。
- `lifecycle.ts`：Host 生命周期——`registerRoutes` / `startSideEffects`（draw 工具注册、catalog seed）/ `teardown`（dispose + release + off×5）。
- `host-config.ts`：配置契约——`CONFIG_DEFAULTS`、`resolveSettings` / `resolveAuthOverrides`（含嵌套 `auth:` 块拒绝）、`isAdmitted` 同源闸、`hostName` 解析。
- `codes.ts`：全部错误码与 IAM 平台原因码的唯一声明处。`sensenova-auth.ts` 产出、`token-store.ts` 判定是否 parked、`index.ts` 判定是否属于「拿不到令牌」，三处都从这里取。
- `token-store.ts`：凭据服务里的令牌与账号存取、按期续期、401 拒绝记忆。已按 §TOKEN-STORE-SPLIT.md 拆为薄 facade + 六块子模块（`token-store/{state,grant,throttle,account,renewal,acquire}.ts`）。
- `throttle-store.ts`：登录节流状态，写在插件自己的状态文件（`$DSH_HOME/state/<plugin>/throttle.json`，原子写、0600），跨进程跨重启生效。
- `sensenova-auth.ts`：OIDC 授权码流登录 + `refresh_token` 静默续期。
- `sensenova-crypto.ts`：密码 JWE 封包（RSA-OAEP(SHA-1) + A256GCM）、PKCE 派生、JWT 解析、JWKS 缓存（由调用方持有、非模块级单例）。
- `console-client.ts`：控制台与模型目录的网络请求，带短生命周期缓存与 single-flight。
- `parsers.ts`：响应解析层——字符串数值 / epoch 归一、`checkShape` 漂移检测、`parseTrend` 对 points 求和、`identifyVisionModel` 视觉模型识别。
- `trace.ts`：登录 trace 落盘（成功/失败，值级脱敏，仅留最近 20 个，权限 0600）。
- `util.ts`：共享工具函数（`str` / `num` / `obj` 等类型安全读取器）+ 两个共享原语：`retryBounded`（有界重试窗口，PITFALLS §31 的重试收敛）与 `optional`（可选 store 调用的守卫，PITFALLS §33）。
- `types.ts`：Host 侧共享类型定义。
- `state-store.ts`：状态文件公共原语——版本载荷 + 原子写 + 0600 + `createStateReadCache`（TTL 读缓存）+ `profileSegment` / `profileStateDir`（profile 分段，见 PITFALLS §23）。
- `catalog-store.ts`：模型目录缓存（version 载荷、allow-list）；`provider-store.ts`：provider 开关（面板值 > 配置默认值）；`draw-store.ts`：出图开关与模型偏好；`api-key-store.ts`：推理 Key 存取（credentials → memory → env 优先级）。四个 store 同纪律：版本化、temp + rename 原子写、0600、损坏即忽略、按 profile 分段。
- `provider-publish.ts`：直接注册的 provider 的发布状态机（peer-free）——`publishChain` 串行化、`disposed` 闸、单点 `registerPair` 与回滚路径（PITFALLS §18/§19）。
- `snapshot-aggregate.ts`：快照路由的数据聚合（peer-free）——并行取数 / 解析 / 形状漂移 / 可调用-vs-锁定拆分 / 配额耗尽标记 / vision 识别 / `llm` 状态块组装。
- `llm-models.ts`：目录条目 → pi-ai descriptor 映射（vision 自动识别、`supportsDeveloperRole:false`、不声明 maxTokens 值、`isChatModel` 排除出图模型、`buildDescriptors` / `rosterWithAvailability` / `exhaustedModelIds`）。
- `llm-adapter.ts`：LLM provider adapter 装配（动态 import peer、`resolveApiKey` 每次请求现取、429 分诊委托 `llm-error-fix.ts`）。
- `llm-retry.ts`：peer-free 的 429 重试策略配置（`buildRetryPolicyConfig`，排除 QUOTA/ACCOUNT_QUOTA、保留 RATE_LIMIT）。
- `llm-error-fix.ts`：host 侧 Proxy 包裹 `PiAiAdapter` 流出口，把误判的限频 QUOTA 纠正回 RATE_LIMIT（PITFALLS §20/§21 的 429 分诊）。
- `draw.ts`：出图模块（peer-free）——结构化识别 image-output 模型、端点拼接、wire body 钳制、响应解析、失败分诊（429 配额 vs 限频）、失败冷却。
- `doctor.ts`：只读状态文件诊断（peer-free，`npm run doctor` / `doctor:json`）——回答「这台机器上 provider 到底是开是关」（PITFALLS §22）。
- `raccoon.ts`：第二上游协议层——微信扫码登录走查、信封解析、refresh 轮换、余额与目录读取。
- `raccoon-status.ts`：小浣熊面板的**读模型**（peer-free）——把 switch / 凭据 / 余额 / roster / 注册态 / `?debug=1` 脚手架组装成一次 GET 的答案。余额 60 s、目录 300 s，按**凭据指纹**走 `coalesced-fetch`；终态登录事件在**首个 await 之前**读取（PITFALLS §31 的 T3 修复）。答案里一并**播报 tab 的两档轮询节奏**（`pollSeconds` / `scanPollSeconds`，取自本模块的窗口常量与路由的 QR 间隔）——与 snapshot 用 `pollSeconds` 播报节奏同一纪律：节奏归拥有缓存与网关预算的一侧定义，客户端只负责照用（内置常量降级为「首帧兜底」，并与这里的值钉死）。吃 `store` / `switchStore` / `publisher` / `read` / `login` 五个注入项，因此可脱开路由单测（`test/raccoon-status.test.mjs`）；walk 本身仍归 `routes.ts`。
- `raccoon-store.ts`：小浣熊凭据（DSH 凭据服务引用）；`raccoon-switch-store.ts`：小浣熊开关（按 profile 分段）；`raccoon-models.ts`：小浣熊模型目录归一化与描述符映射；`raccoon-publish.ts` + `raccoon-llm-adapter.ts`：小浣熊独立 provider 注册与 adapter（与 Token Plan 注册完全隔离——**隔离的是状态与凭据，不是代码**：两个 publisher 实例的 `state`、开关、凭据引用互不相干，而两者的发布状态机与 adapter 装配共用 `publish-core.ts` / `llm-adapter-core.ts`，理由见 §5.5）。
- `client.js`：Plugins 页内的配置卡与三个 tab（积分额度 / 接入 API / 小浣熊）+ 账号表单（React，纯主题令牌样式）。内部 `interpretSnapshot` 把 Host 的响应读成 `(data, error)` 对，再交给决策块。客户端也按「能否脱离 hook 被挂载」分层：`cards.ts` / `provider-controls.ts`（状态行）/ `model-picker.ts` / `model-row.ts` / `raccoon-roster.ts` / `raccoon-card.ts` 全部是**无 hook 组件**，因此渲染套件挂的就是浏览器画的同一棵树；`panel-page.ts` / `raccoon-tab.ts` / 各表单持有 hook，是各 tab 的**生命周期**层（轮询、cadence、四个 mutation、向 header 上报新鲜度），渲染委托给上面那层。
- `model-row.ts`：两个模型列表共用的**行骨架**（`li` + `modelRowHead` + label/checkbox/name/rate + badges + 参数行）。领域事实留在调用方——`on` 怎么判（Token Plan 读 allow-list、小浣熊把 `null` 读成"整份 roster"）、费率为 0 怎么措辞（`×0` 是运营侧伪系数、小浣熊的 0 真是免费）、tooltip 用哪个键、哪些 badge 值得报、参数行有没有思考阶梯——所以它吃的是**渲染好的内容**，不是模式开关（理由见 PITFALLS §34）。
- `raccoon-card.ts`：小浣熊 tab 的**帧**，无 hook，`state` 走 props。这一层存在的唯一理由是**可断言性**：`RaccoonTab` 的数据是内部 `useState`，无论怎么挂载都只渲染登出帧，于是余额行/拆解/两个凭据时钟/过期告警/两种未注册措辞在抽出前没有任何断言（理由见 PITFALLS §35）。
- 测试基建：`client-surface.js` / `panel-decision.js` / `panel-render.js` —— 把 `client.js` 作为模块加载后物化 `panel` 测试面。不进运行时、不进 `files` 打包清单。

---

## 3. 数据流（轮询 → 快照 → 渲染）

```
[面板打开]
   │  每 30s（仅挂载时轮询，关闭即停）
   ▼
GET /api/dsh-connect-sensenova-token-plan/snapshot   ← Host 半边
   │  1) 检查令牌，临近过期或 401 时用 refresh_token 续期
   │  2) 调用控制台 pool-usage / credit-usage-trend / GET /v1/models
   │  3) 按 consoleBase 等配置聚合，Host 缓存 cacheSeconds 秒
   ▼
{snapshot}  ──HTTP 200，body 内 ok:true/false 区分成败──►
   │
   ▼
client.js: interpretSnapshot(body) → {data, error}
   │  error 携带 auth 块（含 needsAccount / retryAfterMs / needsUserAction）
   ▼
决策块（panel-decision.js 从同一模块取的 viewOf）决定渲染：
   - 有数据 → 积分池 / 每模型消耗
   - 需配置账号 → AccountForm（用户自己填一次）
   - config_error / console_error → 纯文本提示（登录解不了的问题：
     前者是配置写错，后者是控制台没应答，下一轮通常自愈）
```

关键点：**HTTP 永远 200**，成败靠 body 里的 `ok` 与 `code` 区分；`auth` 块会随失败一起下发，所以连不上控制台时面板也能说出「令牌是否能自愈」。

---

## 4. 登录与令牌生命周期

详见 [AUTH.md](./AUTH.md)。一句话版：

1. 用户首次在面板填一次账号密码，密码用平台 JWKS 公钥封成 JWE（RSA-OAEP + A256GCM），明文不上网。
2. 账号与 access/refresh token 存入 DSH 凭据服务（**密码不落盘**，仅登录瞬间内存使用；`SENSENOVA_PASSWORD` 环境变量是唯一持久来源）；之后**只靠 `refresh_token` 静默续期**，不再需要密码。
3. 令牌约 180 分钟有效，提前 `tokenSkewSeconds`（默认 120s）触发续期；控制台返回 401 时也会换新并重试一次。

---

## 5. 生态定位：大统一——商汤全过程集成的单点入口（2026-09-29 定位变更）

**决议（2026-09-29）**：插件定位从「只做信息、不做执行、n 个插件分层分散行动」
改为**大统一**：额度/登录/模型清单（现状）+ 视觉信息下发（§5.1）+ LLM provider
注册（§5.2）+ 出图路由对接 + 429 自愈（退避/分诊），逐块吸收进本插件，
不再依赖多个插件各自为战。可行性依据是 §5.3 的生态核实：同类插件已把
其中几块能力做成了单包现实。

此前「商汤全家桶不成立」的判断就此废止，但爆炸半径教训**仍然有效**
（本插件曾是桌面端必需启动项，一次凭据事故炸过整机，见
[PITFALLS.md](./PITFALLS.md) §6 与 [SETUP.md](./SETUP.md) §2 注记），
收敛为大统一的三条不变量：

- **每个新模块 opt-in、默认关**，任何失败降级为「面板照常用、该模块缺席」
  （§5.2 的降级模式是范本）——不许再造「桌面端必需启动项」。
- **凭据红线不动**（[AGENTS.md](../AGENTS.md) 红线 1/2）：新增凭据一律只进
  DSH 凭据服务（含未来若引入多 Key 池），永不入库、永不进日志。
- **只吸收与商汤（SenseTime）产品线强相关的能力**，不做跨 provider 通用聚合——
  §5.3 里 `dsh-provider-quota` / `dsh-musage` 的定位边界就是本插件的边界。
  > **2026-10-01 修订（边界放宽）**：原表述是「只吸收与商汤 **Key/账号线**强相关的能力」，
  > 按 Key 域名 / 认证域划线。该划法会把同一厂商的姐妹产品线误划到界外——Token Plan
  > 控制台与小浣熊（`xiaohuanxiong.com`）同属商汤旗下产品，却走互不相通的两个认证域
  >（实测见 [ROADMAP.md](./ROADMAP.md) §6.1.1 的两次复测）。
  > 界定依据改为**厂商归属**而非域名或认证域，第二上游因此属**界内**，裁定详情见 §5.5。
  > 另外两条不变量（opt-in 默认关、凭据红线）不受本次修订影响。

变更前的三层分工，改作吸收路线图：

| 层 | 变更前谁干 | 大统一后的去向 |
|---|---|---|
| 额度 / 登录 / 模型清单 | **本插件** | 维持现状，继续是地基 |
| 「哪些模型能看图」的识别与信息下发 | **本插件（见 §5.1）** | 维持现状（两步走已落地） |
| 真把图喂给模型（视觉/绘图路由） | `dsh-media-skills` / `dsh-draw-router`（社区） | **拟吸收**：出图路由对接，参考 §5.3 `dsh-draw-router`，对接点源码对照见 §5.4 |
| 429 自愈（退避+分诊） | `st-rotator`（独立 Python 进程） | **拟吸收**：吸收其两条纪律（先分诊「限频 vs 配额」、降速退避），**不做多 Key 池**（同账号共享额度池，轮换无效）；路线图见 [ROADMAP.md](./ROADMAP.md) |

本插件仍是机器里**唯一既知道本 Key 实际能调哪些模型、又常驻 DSH 里**的组件——
大统一之后它从「只下发信息」升级为「信息 + 执行」，但每一块执行都挂在上面的
三条不变量之下。

### 5.1 视觉能力：两步走（2026-09 决议）

痛点：用户在 DSH 设置里填入 `SENSENOVA_API_KEY` 后，模型卡片的「输入类型」
不会自动标记「图片」，Agent 不知道 `sensenova-6.8-flash-lite` 可当 vision
模型，填 key 不会自动打开看图。DSH 的 LLM 链路本身原生认图片输入
（deepseek provider 有 `maxImagesPerRequest`、图片 offload 一整套参数），
缺的只是「商汤这套餐里哪把模型能看图」这条结构化信息。

**第一步（本期，已完成）**：插件从 `GET /v1/models` 的 `catalogModels` 算出
`visionModels`（可看图模型清单），发进 `/snapshot`，面板加一行展示。
识别依据：**已确认（2026-09 拉真实响应）**——商汤 `/v1/models` 在**每个**模型
条目上都带结构化字段 `input_modalities`（字符串数组，如
`["text","image"]`）与 `output_modalities`，所以按字段判定：`"image"` 出现在
`input_modalities` 里即可看图；名字规律（`vl` / `vision`）仅作为「平台若某
天不返回模态字段」的兜底，并标 `source: "name"` 注明是按名字推断。实测：
`deepseek-v4-flash`、`glm-5.2`、`kimi-k3` 等 8 个模型 input 仅 `["text"]`；
`sensenova-6.8-flash-lite` input 为 `["text","image"]`（即可看图模型）；
`sensenova-u1-fast`、`sensenova-u1.5-lite` input 仅 `["text"]` 但 output 为
`["image"]`（出图模型，不是看图模型——只看 `input_modalities` 的判定天然
把它们排除，名字规律若只看 `-lite` 会误判，所以名字兜底里已删掉 `flash-lite`）。

另外，API key 的读取路径按 DSH 官方 provider 惯例改为**先经 credentials 服务
的参考层**（`ctx.get("credentials")?.resolve("SENSENOVA_API_KEY")`，对应
`~/.dsh/.credentials.yaml` 里用户级的 env 变量值），最后才回退 `process.env`。
旧代码只读 `process.env`，而很多机器（含本机）的 key 只存在 credentials 服务
里、`process.env` 里根本没有这条——所以旧版「读不到 key」并不等于「没有
key」，是读错了层。

**第二步（本期已实现，opt-in）**：把第一步算出的可看图模型清单写进
**本插件自己那一行 DSH settings**（`imageModelIds` / `visionModels`
两个字段，走 DSH 官方写路径
`settings.update(rowId, patch, revision)`），供后续
`dsh-provider-sensenova` 之类的 LLM connect 插件读取，从而让 DSH 的图片
offload 链路知道这把 Key 里哪些模型可以接图。

设计守口（对应 §5 大统一的不变量：opt-in 默认关、失败降级不拖垮宿主）：
- **只写本插件自己的 row**，绝不碰其它 provider（trae / workbuddy 等）
  的 `imageModelIds` 格子——算错一份模型清单，最坏影响的是面板自己的
  一行字，不会波及 DSH 的模型路由。
- **默认关闭**（`writeImageModelIds: false`）。不显式打开时，这个插件
  仍然只是信息层；打开后，Host 在每次 catalog poll 算出 `visionModels`
  后会幂等地写回本 row（清单没变就不写，不刷 revision 计数）。
- 写入是**旁路增强**：被拒/无 settings 服务时只打日志，poll 照常应答，
  面板照常显示——写不写成功不影响读的那一半。

宿主机器 `~/.dsh/profiles/*/cordis.patch.yml` 里已有 `imageModelIds`
与 `imageOverrides` 实例（该路径在宿主 profile 目录，不在本仓库），
trae 源码注释「Provider API 不暴露模态元数据，image 输入靠显式
`imageModelIds` 声明」对商汤**不成立**：商汤已经暴露
`input_modalities`（见上），第二步只是把这份现成信息按 DSH 的
settings 写路径交出去，不做识别逻辑。

### 5.2 第三步：本插件直接注册 LLM provider（2026-09，opt-in）

第二步把信息「写给别的 connect 插件读」；第三步更进一步——开关
`registerProvider: true` 后，**本插件自己**调用 `ctx.llm.registerAdapter`
注册一个直连 `apiBase`（默认 `https://token.sensenova.cn/v1`）的
OpenAI 兼容 provider，用户不再需要手写 `llm-pi-ai` patch 行。

关键事实与守口：

- **provider id 用 `sensenova-token-plan`，不能用裸 `sensenova`**：宿主
  desktop profile 里可能已存在手写 `llm-pi-ai` 的 `sensenova` 行，重名
  注册会被 `registerAdapter` 以 DUPLICATE_ADAPTER 拒绝。同时注册
  `registerConfigurableProviders`（`settingsNs` 为本插件自己的 row，
  `declared:false`），让模型设置页出现该 provider 的配置入口。
- **Key 仍是同一个引用**：面板「模型接入」区把 `sk-` Key 以
  `SENSENOVA_API_KEY` 引用存进 DSH 凭据服务（`api-key-store.ts`），
  `process.env` 兜底；与手写行读取的引用名相同，一份值两边都亮。
  Key 在适配器里是**每次请求现取**（`resolveApiKey`），轮换 Key 无需
  重新注册；任何快照/路由响应只回布尔状态与来源标签，永不回显明文。
- **模型清单来自 catalog，vision 自动识别**：`/v1/models` 的完整 entry
  经 `llm-models.ts`（**无 peer 依赖**，离线可测）映射成 pi-ai descriptor：
  vision 判定复用 §5.1 同一份 `identifyVisionModel`，vision 模型自动带
  `input:["text","image"]`。两个承重字段：`compat.supportsDeveloperRole:
  false`（不设会自动探测成 true，商汤端点持续 403）；**不声明 maxTokens
  值**（声明了会变成输出上限、截断长回复，只钉字段名 `max_tokens`）。
- **catalog/勾选清单是插件私有状态，不进 dsh 配置**：
  `catalog-store.ts` 写 `$DSH_HOME/state/<profile>/<name>/catalog.json`（按 profile 分段，见 [PITFALLS.md](./PITFALLS.md) §23）
  （version 载荷、temp+rename 原子写、0600/0700、损坏即忽略），
  存 catalog entries 与 `enabledModelIds` 允许清单（**空数组=不过滤**，
  全新安装默认提供全部模型）。重启后、首次轮询前就靠这份缓存先注册。
- **刷新=重建+重注册+广播**：`PiAiAdapter` 内部按 profiles 快照记忆化，
  所以 catalog/允许清单变化时整体重建 adapter、替换注册并
  `ctx.emit("llm/adapters-updated")`；注册失败回滚旧 pair，不拖垮正在
  服务的模型。快照用「id+vision 位+允许清单」签名去抖，catalog 一小时
  缓存、面板 30 秒轮询也不会反复重注册。
- **peer 依赖懒加载**：`llm-adapter.ts` import Host 发行的
  `@earendil-works/pi-ai` / `@deepseek-ai/dsh-llm-pi-ai` /
  `@deepseek-ai/dsh-llm`，干净检出解析不到，所以 index.js 只在开关开启
  且 `ctx.get("llm")` 存在时动态 `import("./llm-adapter.js")`；无 llm
  服务、peer 加载失败都降级为「面板照常用、provider 缺席」，并把
  去密错误带进快照 `llm.providerError`。图片两 hook
  （`resolveAttachments` / `resolveImageAccess`）必须接，否则图片消息
  直接 UNSUPPORTED_CONTENT。

### 5.3 同类插件生态事实（本机核实，2026-09-29）

大统一的可行性依据：DSH 生态里已有同类插件把其中几块能力做成了单包现实。
本表是 2026-09-29 核实到的快照，后续吸收哪块能力，先回到这里对形态。

| 插件 | 核实到的形态 | 对本项目的意义 |
|---|---|---|
| `@alaxrpg/dsh-sensenova-provider`（desktop） | **直接竞品**：同样走商汤 OIDC+PKCE、注册 LLM provider，带多 Key 轮换与 vision | 证明「额度 + provider 合一」在 DSH 生态成立；其多 Key 轮换是本插件没有的能力，但 Token Plan 同账号共享额度池、换 Key 不换池，**不吸收**（见 [ROADMAP.md](./ROADMAP.md) §1） |
| `dsh-retry-boost` | 429 自愈网关：多 Key 池化、AIMD 限速；专门处理 SenseNova 把「配额不足」（insufficient_quota）混进 429 被误判重试的问题 | 429 自愈模块的同类先例；吸收时必须区分「限频（可退避重试）」与「配额不足（换 Key / 停）」 |
| `dsh-draw-router` | 绘图路由，含 `sensenova-u1-fast` 出图 | 出图路由的对接参考（`sensenova-u1-fast` 即 catalog 里 output 为 `["image"]` 的出图模型，§5.1 已识别）；参考件放 `upstream/dsh-draw-router/` 作对照 |
| `mmx-quota-tool` | 聚合面板基准：实时积分面板、跨 provider 汇总、用量告警 | 面板 UX 基准（实时性、告警形态）向它对齐；跨 provider 聚合本身**不**吸收 |
| `dsh-provider-quota` / `dsh-musage` | 品类对照：泛化的「provider 额度面板」 | 定位边界样本：本插件不泛化成通用额度面板，只深耕商汤 |
| `dsh-codearts-auth`（`upstream/deepseek-harness-codearts-master`） | **多 provider 聚合登录插件**：codearts / buddy / workbuddy / lobsterai / qoder / loomy / raccoon / trae 各写一套自有登录流（IAM OAuth、扫码轮询、短信），凭据一律进 DSH 凭据服务；其中小浣熊走微信扫码——因官方深链回调 `office-raccoon://auth/callback` 写死、宿主 Node 收不到 | 「自有登录 + 凭据服务」形态的完整先例（与本插件同机制）；其跨 provider 泛化正是 §5 不变量 3 划出的边界，**不吸收**。小浣熊部分的事实见 [ROADMAP.md](./ROADMAP.md) §6.1.1 |

**代价核实（同日二次核实，2026-09-29）**：上表核实的是「形态存在」，这里补「维护代价」的实测快照。GitHub 查询：`alaxrpg/dsh-sensenova-provider` 最后推送 2026-09-26、0 star、2 个开放 issue（活跃）；`hhb1028/dsh-retry-boost` 最后推送 2026-09-03（4 star）；`Thedeergod666/dsh-musage` 2026-08-31（6 star）；`mtty-ai/mmx-quota-tool` 2026-08-16（2 star）。由此钉住两件事：其一，这批存在性证明全部是**个人维护、个位数采用**的插件，没有一个经受过规模检验——§5 决议的真实依据强度是「单包可行」，不是「已被验证的成熟路线」；其二，本机这批插件一个都没安装（仅 `upstream/` 参考件），本机事实上已经只跑本插件。这把执行纪律（每块吸收都挂快照契约 + e2e 门禁，[ROADMAP.md](./ROADMAP.md) §2.3 顺序约束）从谨慎升级为必需。

### 5.4 出图对接点：dsh-draw-router 源码级对照（2026-09-29）

对象：`upstream/dsh-draw-router/repo/lib/index.js`（495 行，v0.1.1）。
结论先行：**判定我们已有且更准、出图执行只有约 80 行、中间不存在需要
谈判的协议**——大统一走吸收（下述接法 B），接法 A 仅在想保留
draw-router 的多源能力时才有意义。

| 维度 | dsh-draw-router（现状） | 本插件（现状） |
|---|---|---|
| 出图模型识别 | 名字正则 `DRAW_MODEL_PATTERNS`（line 25-34：`/image/i`、`/u1-fast/i`、`/wan/i`、`/flux/i`…命中才认），探测自己另调一次 `GET /v1/models` | `output_modalities` 含 `"image"` 的结构化判定（`llm-models.js` line 101-114，2026-09 已核真实响应），catalog 每小时已有 |
| 识别质量 | 实锤会漏：商汤两把出图模型 `u1-fast` / `u1.5-lite`（§5.1）里，`u1-fast` 命中 `/u1-fast/i`，**`u1.5-lite` 一条正则都不命中**——装它配商汤源，`draw_image` 默认永远挑不到 u1.5-lite | 两把都识别 |
| 出图执行 | `buildEndpoint` 拼 `{base}/v1/images/generations`（line 72-79）→ `POST {model, prompt, n, response_format}` → 取 `data[0].url / b64_json`（line 209-261），约 80 行 | 无（待吸收的全部增量） |
| 凭据 | 明文写进插件目录 `draw-config.json`（line 140-151） | DSH 凭据服务，不落盘 |

对接的两种接法：

- **接法 A（喂信息，零改对方）**：快照/设置行加一份 `imageGenModels`
  （与 `visionModels` 同姿势，同一份 catalog 换个判定方向），预填
  draw-router 的 `manualModels`——它每个 source 本来就支持 `addModel`
  （line 470-477），`drawModels()` 会合并 `detected + manual`
  （line 180-186），我们的清单进去后正则漏识别的问题直接消失。
- **接法 B（吸收，大统一路线，推荐）**：Key（凭据服务 `SENSENOVA_API_KEY`）、
  apiBase、catalog、轮询基建本插件全有，吸收的增量只是上面那 80 行执行 +
  用自己的结构化判定替掉正则。它 495 行里其余约 400 行（多源管理、
  DashScope 异步任务、Agnes/StepFun 特判）按 §5 不变量 3
  **不吸收**——那是「跨 provider 通用绘图」的边界外。

顺手可借的小件：probe 失败 30 秒 cooldown（line 196）；
lifetime `AbortController` + `AbortSignal.any` 超时合并模式（line 103-115）。

**接法 B 已落地（2026-09-29，`draw.ts` + `index.ts` 接线）**：

- 工具名 `sensenova_draw_image`（带前缀，避免与 dsh-draw-router 的
  `draw_image` 撞名），配置开关 `drawEnabled`（默认关）+ `drawModelId` +
  `drawTimeoutMs`；只有 `drawEnabled === true` 且 Host 有 tools 服务时才
  动态 `import("@deepseek-ai/dsh-tools")` 注册——无 tools 服务、peer 加载
  失败、注册被拒都降级为「工具缺席、面板照常」，与 §5.2 的降级同型。
- 识别走 `isImageGenModel`（`output_modalities` 严格方向：缺字段不算，
  与 `isChatModel` 的宽松方向互补，两份清单不可能互相矛盾）；
  Key 每次调用现取（`resolveApiKey`，轮换即生效）；失败分诊沿用 429 纪律
  （`insufficient/quota` → 配额问题，别重试；其余 429 → 限频，等再试）；
  失败后 30s 冷却（借自上游 line 196）。
- 快照契约**零改动**（14 键不动，`API.md` 不变）：工具要么在要么不在，
  agent 直接可见；面板不新增展示。

### 5.5 边界裁定：第二上游（小浣熊）属于界内（2026-10-01）

**裁决**：小浣熊（`xiaohuanxiong.com` 网关，`sensenova-raccoon` provider）**属于**
§5 不变量 3 界内的能力，不是破例，也不是例外许可。随本次裁定，不变量 3 的划线依据
从「Key/账号线（认证域）」改为「**厂商归属**」。

**为什么原来的划法会判错**：不变量 3 原写「只吸收与商汤 **Key/账号线**强相关的能力」。
如果「账号线」指的是同一个认证域，那么小浣熊天然被排除——两者的令牌确实不通用：
拿小浣熊桌面 App 的 `access_token` 打 `platform.sensenova.cn` 的 Token Plan 端点回
`401 auth_token_invalid`（见 [ROADMAP.md](./ROADMAP.md) §6.1.1 的两次复测）。
**但认证域不通 ≠ 产品线无关**——把一个自家厂商的姐妹产品判成界外，是拿实现细节当边界。

**同一厂商的举证**（三条独立信源，不是推测）：

| 信源 | 原文要点 |
|---|---|
| 中证网 2026-07-19（商汤 U1 Pro 发布） | U1 Pro 的能力「在**商汤旗下的**产业级 AI『小浣熊』及视频创作工具 Seko 中已得到深度验证」 |
| 商汤官方稿件 2026-09-21 | 「**商汤小浣熊 Raccoon Work**」由商汤科技打造，支持移动端 / 桌面端 / 私有化部署 |
| 本仓库既有措辞 | [ROADMAP §6.1](./ROADMAP.md) 早已写「接入**商汤小浣熊**桌面 App 模型」——边界这次才承认，事实一直在那儿 |

**它与 Token Plan 的关系**（写清才能让后来人判断能不能再放宽）：同一厂商、**不同产品线**、
**互不相通的认证域**、**互不算的积分口径**（那边独立余额，这边 5h/周额度池）。所以它在实现上
必须做到的正是现在这套：**独立凭据生命周期、独立 publisher、独立 provider id**——共享任何
一样都会把两条产品线焊死在一起。它撞的不是「是不是商汤的」这条线，而是「要不要把一个新
产品的凭据塞进旧产品的池子里」这条线。

**「隔离」指的是状态与凭据，不是复制代码**（2026-10-02 收敛，见 PITFALLS §32）：两个 publisher
各自的 `state`、开关与凭据引用互不相干，这是本裁定要求的；但两者的**发布状态机**（发布队列 /
`disposed` 闸 / 单点注册与失败回滚 / 构建失败诊断）与 **adapter 装配**（inert 认证面、profile
行、429 误判纠正层）应当**共用一份**（`publish-core.ts` / `llm-adapter-core.ts`），各自持一个
实例即可。原先为「隔离」而复制文件，复制的恰好是最脆的回滚路径——改一处漏一处只在出事时
才暴露。**隔离由实例边界保证，不由代码副本保证**；共享机制不违反本条，共享状态才违反。

**本次裁定不改变的边界**（防止一句话把口子开成无限大）：

- **仍然不做跨厂商聚合**——codearts 那类「一套形态融 N 个不同厂商」的做法依旧在界外，
  这是 §5.3 里 `dsh-provider-quota` / `dsh-musage` 的泛化定位，与本插件的深耕路线相反。
- **本次放宽只覆盖「同一厂商下的产品线」**，不覆盖「同一厂商做的一切」——举个例子，
  商汤方舟的视觉 API、Seko 视频创作即便确认同厂商，也仍需各自走 §5 的裁定流程。
- **每纳入一条新产品线，必须同时落三条**：① 厂商归属的外部举证（可核的信源，不是印象）；
  ② 它与 Token Plan 的具体关系（尤其积分与认证域是否通用）；③ 三者齐全才允许默认关
  opt-in 地进入树干——缺任何一条都回到 §5.2 的 publisher 隔离形态自行维护。

---

## 6. 与上游 Python 工具的差异（给移植 / 对照用）

- **凭据安全**：上游明文 `accounts.json`；本插件零明文、零调试日志，仅经 DSH 凭据服务。
- **续期策略**：上游过期即重登（依赖明文密码）；本插件 `refresh_token` 续期，密码可从环境变量删除。
- **节流**：本插件显式区分「时间型拒绝（锁号/限频）照单全收平台声明窗口」与「凭据型拒绝（错密码）绝不自动重试」，专门防锁号；上游无此分层。
- **接口知识可复用**：两方调用的 `pool-usage`、`credit-usage-trend`、JWT 解析逻辑一致，`upstream/` 的 `auth_login.py` 可作为登录封包与字段语义的对照参考。

---

## 7. 相关文档

- [SETUP.md](./SETUP.md) — 安装、配置、重启注意事项
- [AUTH.md](./AUTH.md) — 认证、续期、节流设计
- [API.md](./API.md) — 路由与控制台端点、配置字段
- [TESTING.md](./TESTING.md) — 测试体系与已知缺口
- [CONTRIBUTING.md](./CONTRIBUTING.md) — 提交约定与红线

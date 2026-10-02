# 测试体系（Testing）

本插件以**离线单元测试**为主：网络层全部打桩，密码用临时生成的密钥加密，绝不发往商汤。目标是守住三条关键路径——登录/续期、令牌存储、路由与面板决策。

---

## 1. 运行

```powershell
npm test       # 依次跑 auth / store / store-baseline / routes / panel / render / parsers / provider / config / package / docs / wiring / contract / retry / error-fix / peer-contract / draw / doctor / raccoon / state-segmentation，末尾 typecheck-gate（用 devDeps 钉住的本地 tsc 跑 tsconfig.json 的严格开关；无 typescript 则 SKIP）+ build-gate（重建 src/ 全部源码并验证 lib/ 与 client.js 产物；无 tsdown 则 SKIP，见 ROADMAP §6.2）+ e2e-gate（无 dsh CLI 则 SKIP）
npm run commit:lint  # 提交信息底线（零依赖）：检查 HEAD 一条提交；CI 检查 origin/main..HEAD 内的新提交（见下方 commit 红线）
npm run test:e2e    # 只跑端到端：真 Host + 假平台，需 dsh CLI 在 PATH
npm run test:live   # 仅 live-jwks.test.mjs，需联网，验证 JWKS 文档可达
npm run test:live:contract # 仅 live-contract.mjs，需联网 + SENSENOVA_API_KEY，重放商汤推理契约
npm run test:live:raccoon # 仅 live-raccoon.mjs，需联网，第二上游（小浣熊）网关契约；无凭据跑 L1 路由存在性，带 RACCOON_ACCESS_TOKEN 跑 L2 读取契约
```

测试**无需 `npm install`**：`@deepseek-ai/dsh-credentials` 等是 Host 里的 peer 依赖，由 `test/peer-roots.mjs` 就地解析（`$DSH_HOME` → 插件 `node_modules` → 默认安装位置 `~/.dsh/dsh-asar-unpacked` → 打包安装目录 → 工作区内的 `@deepseek-ai/dsh` 元包 → **npm 全局 CLI 的运行时树**，最后两项是为「没装 Host 的机器」准备的，CI 正属此类）。找不到时会列出每个候选根**各自失败的原因**，而不是静默跳过或只报搜索路径。`config.test.mjs` 不依赖任何 peer，干净检出即可跑。

> **CI 侧的前车之鉴（2026-10-01，见 [AGENTS.md](../AGENTS.md)「验证」段）**：`npm install --legacy-peer-deps` 会**跳过** peer，所以干净 runner 上这些套件既没有 peer 也没有运行时——硬门禁一度**连续一整天每次都红在第二个套件**（`store.test.mjs`），`set -e` 又把后面 17 个套件一起吞掉。现在 `ci.yml` 的 offline job 会先装 CLI、`peer-roots.mjs` 据此解析。因此：**CI 里这类报错是回归，不是环境问题**；而「干净检出上跑不了」只对本机成立。

---

## 2. 各测试文件职责

| 文件 | 守什么 |
|---|---|
| `test/auth.test.mjs` | JWE 封包（RSA-OAEP + A256GCM）round-trip、PKCE（S256 向量）、登录分类（错密码 / 锁号 / 限频 / 验证码）、拒绝消息取平台原话、**登录 trace 成功与失败都要上报**、**错误码 taxonomy 一致性** |
| `test/store.test.mjs` | 令牌存储与续期、并发轮询只触发一次刷新、401 拒绝记忆、节流状态跨进程、env 账号识别、内存态 ephemeral、**真实凭据服务解析器校验写入记录**（非 `grant` kind 即红） |
| `test/store-baseline.test.mjs` | **token-store 全行为冻结基线**：17 个场景、48 帧，把凭据服务调用序列（read/modify/delete/resolve/set/unset）、节流存储读写、grant/ref 落盘、错误码与完整 `state()` 逐帧冻结在 `test/baselines/token-store-behavior.json`；拆分/改动 token-store 前后必须零漂移（见 §5） |
| `test/routes.test.mjs` | 把面板的判断逻辑**原样跑在真实接口响应上**，专门守住「无凭据服务时表单仍可达」这条路径；同源校验、body 上限、跨域拒绝、**一个请求只答一次**；第三步的 api-key 路由（credentials/memory/env 三来源、不回显、forget 不动环境变量）、快照 `llm` 块与 provider 注册/签名去抖/无 llm 降级（假 adapter 工厂经 apply 第三参注入，不碰真 peer） |
| `test/panel.test.mjs` | 面板「显示什么」的决策，**直接从 `client.js` 抠出决策块求值**（见 `panel-decision.js`），而不是手写副本——逻辑一变测试自动跟；**中英文字典键集一致**；控制台故障不伪装成登录表单 |
| `test/render.test.mjs` | 面板「数字怎么上屏」的渲染，`panel-render.js` 从 `client-surface.js` 物化出的真实 `panel` 测试面取组件、以记录型 `h` 在 Node 求值：`used/limit` 写反、剩余量丢失、进度条色阶错档、除零 NaN 都会红；同一个循环驱动 `ModelRoster` 与 `RaccoonRoster`（行骨架共用 `model-row.ts`，见 PITFALLS §34）；小浣熊 tab 的**各个帧**由无 hook 的 `RaccoonCard` 挂载后逐帧钉住——余额折行、网关拆解、两个凭据时钟、过期告警、两种未注册措辞（PITFALLS §35） |
| `test/parsers.test.mjs` | **控制台响应解析层**（纯函数、无网络）：字符串数值与 epoch 归一（§11）、`reset_at="0"` 不得读成 1970、`checkShape` 双向漂移检测（§12 `shapeWarnings` 的来源）、trend 对 points **求和**而非取首个 |
| `test/provider.test.mjs` | **第三步纯逻辑层（无 peer、干净检出可跑）**：`llm-models` descriptor 映射（vision 自动识别、`supportsDeveloperRole:false`、不声明 maxTokens 值、contextWindow fallback、去重、允许清单空=不过滤）、`catalog-store`（版本号拒绝、损坏即忽略、原子往返、只读目录降级内存）、`provider-store`（开关归一、面板值持久与重挂载读取、版本号拒绝、非布尔即未设置、forget 回退配置默认）、`api-key-store`（credentials→memory→env 优先级、save/forget、forget 不动环境变量、凭据服务故障穿透） |
| `test/config.test.mjs` | **配置单一事实源钉子**：`CONFIG_DEFAULTS` 与 `cordis.patch.yml` 不得静默漂移；不依赖 peer，干净检出即可跑 |
| `test/package.test.mjs` | **打包清单 + 门禁名册双钉子**：从 `main`/`exports` 走静态 import 闭包，可达模块必须在 `files` 里（曾漏 5 个 → tarball 加载即崩）；反向钉住"`files` 里却无人引用"的死重；**钉住「磁盘上的 `*.test.mjs` ↔ `npm test` 链 ↔ CI 离线 job」三处一致**（retry/draw 曾各自绿着躺在磁盘上、两个门禁都不跑它们，就是这个钉子要防的漂移）；`live-jwks.test.mjs` 是唯一显式豁免（联网档，默认不得进链）；不依赖 peer，干净检出即可跑 |
| `test/docs.test.mjs` | **文档一致性钉子**：内部链接全部可解析、同一张表格不出现在 ≥2 个文件（防多源事实）、根 `README.md` 行数上限、`DSH-PLUGIN.md` 教学快照与 `package.json` 同步、**`API.md` 快照示例与契约键集一致**；不依赖 peer，干净检出即可跑 |
| `test/contract.test.mjs` | **商汤推理契约回归（离线档）**：`test/baselines/sensenova-contract.json`（冻结 2026-09-29 实测：9 目录模型的 thinking 形态 / reasoning_effort 支持面 / 采样参数 / context_length / 模态 / 404-403 标记）驱动 `llm-models.js` 的 `toPiDescriptor` / `isChatModel` / `buildDescriptors` / `exhaustedModelIds` / `thinkingLevelMapFor` 与 `parsers.js` 的归一、`llm-retry.js` 的 429/quota 分类；红 = 代码偏离冻结契约，修法走 `SENSENOVA-API.md` §7 + 基线刷新 |
| `test/retry.test.mjs` | **429 自愈逻辑层（peer-free）**：`buildRetryPolicyConfig` 形状（排除 QUOTA/ACCOUNT_QUOTA、保留 RATE_LIMIT）、`exhaustedModelIds`、`buildDescriptors` 排除借尽模型、`rosterWithAvailability` 标记；peer 可达时追加断言 `resolveRetryPolicy` 的解析结果；不依赖 peer 的部分干净检出可跑 |
| `test/draw.test.mjs` | **出图模块（peer-free，如 `provider.test.mjs`）**：端点拼接（`apiBase` 各种写法归一）、结构化识别 image-output 模型（看字段、绝不用名字正则）、挑选优先级、wire body 钳制、响应解析、失败分诊（429 配额 vs 限频）、`drawOnce` 对假 fetch（成功/分类失败/超时）、失败冷却门、`defineDrawTool` 用直通 `defineTool` + 假 store 端到端 |
| `test/error-fix.test.mjs` | **429 分诊纠正（peer-free）**：`llm-error-fix.ts` 的 `reclassifyFinish` 把误判的 QUOTA 纠正回 RATE_LIMIT；真配额耗尽与已限频原样放行；`isQuotaExceededError` 命中面验证 |
| `test/peer-contract.test.mjs` | **peer 契约护栏（peer 可达时）**：钉死「peer 判 QUOTA + 含限频信号 → 本插件 `reclassifyFinish` 纠正回 RATE_LIMIT」的端到端行为契约；`extractStructuredType` 必须仍能从 peer 拼好的 message 回捞结构化 type；peer 缺席则 SKIP |
| `test/doctor.test.mjs` | **CLI 诊断（peer-free）**：`doctor.ts` 对状态文件只读扫描——provider / draw / catalog 开关与生效值、profile 分段目录、零凭据读取 |
| `test/raccoon.test.mjs` | **第二上游（peer-free）**：小浣熊协议层（扫码信封解析、refresh 轮换、余额/目录读取）、两个 store、描述符映射、publisher 状态机、QR 编码器、开关 store |
| `test/raccoon-status.test.mjs` | **小浣熊面板读模型（peer-free）**：`raccoon-status.ts` 的 `readRaccoonStatus` 直接以假 store/假缓存驱动——终态事件在**首个 await 之前**读取（T3 修复的排序）、`?debug=1` 脚手架只在显式 opt-in 时出现且代理密码/遮蔽凭据只以指纹出网、缓存键按**凭据指纹**且余额 60 s/目录 300 s（真 `coalesced-fetch` 对桩 fetch 验一次窗口一次调用）、roster 的 live/empty/unreadable 三态、过期凭据的原地续期与过期事实、可选 switch/store 缺席时降级不崩 |
| `test/state-segmentation.test.mjs` | **PITFALLS §23 分段形状门禁（peer-free，只读源码）**：catalog / provider / draw / raccoon-switch 四个开关态必须走 `profileStateDir(name, profile)`、`profileStateDir(name, null)` 必须回退共享目录、throttle 与凭据 store（api-key / raccoon）**故意不分段**；`index.ts` 把 `profile` 只传给那四个、`createFileThrottleStore()` 不得带 profile；别名「统一它们」即红 |
| `test/wiring.test.mjs` | **真实 Cordis 容器**里的装配：`inject` 解析、服务注册、路由挂载与卸载、配置错误；第三步的可选 `ctx.get("llm")` 注册对（`registerAdapter` + `registerConfigurableProviders`，id `sensenova-token-plan`）、opt-in 关闭不注册、fiber dispose 释放注册对与三条路由 |
| `test/live-jwks.test.mjs` | （仅 `test:live`）真实拉取 JWKS 文档，确认封包公钥可达 |
| `test/live-contract.mjs` | （仅 `test:live:contract`）重放 `test/baselines/sensenova-contract.json` 对商汤推理端点：`/v1/models` 目录核对 + 少量 `reasoning_effort:"none"` 探针（限流友好，每格 1 请求不重试）；红 = 平台方言漂移，**不是回归**，修法走 `SENSENOVA-API.md` §7 注释层 |
| `test/live-raccoon.mjs` | （仅 `test:live:raccoon`）重放 `test/baselines/raccoon-contract.json` 对第二上游网关（`xiaohuanxiong.com`）。**两档**：L1 无需凭据，只探路由存在性（存在的路径答结构化 `401`/`400` 信封，不存在的答纯文本 `404 page not found`），并跑两条**对照组**证明该判据仍成立；L2 需 `RACCOON_ACCESS_TOKEN`，守两条真用过的事实——目录里 6 个可见 `sn-*` 未整体消失、余额主字段仍是 `available_points`（这是 0.4.6「余额读成假 0」的回归钉子）。**红线**：`desktop/v1/login/points/grant` 永不带凭据（一次性登录奖励，请求即领走不可逆，ROADMAP §6.1.4 / PITFALLS §28），脚本对自己的源码做静态自证；真实 refresh 需二级 opt-in（`RACCOON_LIVE_ALLOW_REFRESH=1`），因为它轮换时会烧掉这对 token |

不碰真实账号的保证：网络层打桩，密码用临时密钥加密，不发往商汤；`routes.test.mjs` 用真实响应形状但全 stub。

---

## 3. `panel-decision.js` / `client-surface.js` 为何特殊

面板的渲染决策与渲染组件**不是手写副本、也不再是从源码抠字符串**：`client-surface.js` 把 `client.js` **作为模块加载**（装一个捕获型 `window.__ModuleLoader__`，给工厂喂一个记录型 React 替身），拿到工厂物化出的 `panel` 测试面（`interpretSnapshot` / `viewOf` / 字典 / 错误码表 / 样式令牌 / 组件），`panel-decision.js` 与 `panel-render.js` 再从这个真实对象上取用。若 `client.js` 的结构变了，检查跟着变——测的始终是浏览器真正跑的那段代码。

> 机制有两代：早期一版是手写 `panelDecision` 副本（会漂移，且漏了节流字段）；再一版是从 `client.js` 源码用平衡括号抠函数体、`new Function` 求值（锚点绑死源码排版）。现版把 `client.js` 物化成模块后两者都取代了。

---

## 4. 已知缺口

> 本文曾记载「`wiring.test.mjs` 缺失、`panel.test.mjs` 有失败用例」。两条都已不成立：`wiring.test.mjs` 现在 24 项全过，`panel.test.mjs` 41 项全过。后来记载的「同源校验挡不住 DNS rebinding」「密码会被静默 trim」也已收口：前者由 `isAdmitted` 的 Host 白名单（`index.ts`，`routes.test.mjs` D2 守住「Origin 与 Host 一致的陷阱」），后者由 `token-store.ts` 的 `verbatim()`（密码按原样进 JWE，store.test.mjs 断言「密文不含明文、且密码不写入凭据服务」）。「渲染层没有被测到」同样不再成立：`test/render.test.mjs` 通过 `panel-render.js` 检查上屏数字，`used/limit` 写反的演练实测 5 项变红。文档比代码先过期也是一类缺陷，所以这里只保留仍然真实的缺口：

- **`AccountForm` 的渲染没有被测到。** 它建立在 `useState`/`useEffect` 之上，React 替身只会无脑返回初值——测的会是那个假件。宁可留着缺口也不假装覆盖；表单的行为部分由 `store`/`routes` 套件在 Host 侧守住。`ModelPicker` 同属这类 hook 组件，草稿/保存态也未被渲染层覆盖；它的**可测部分**已被拆出来守住：勾选行的 `ModelRoster`（不依赖 hook）由 `test/render.test.mjs` G4 组覆盖，而「勾选 → 允许清单」的推导（含空清单折叠与 `__hide_all__` 哨兵）由 `test/provider.test.mjs` 5.6c 组以面板与 Host 两侧逐值相等钉死。
- **小浣熊 tab 的帧已不再属于这个缺口。** 它原先与 `AccountForm` 同类：渲染树由内部 `useState` 决定，替身只返回初值，套件永远只看得到登出帧。抽 `RaccoonCard`（`state` 走 props）之后，余额折行、网关拆解、两个凭据时钟、过期凭据的 alert、两种未注册措辞、注册失败在开关关闭时仍可见，全部由 `test/render.test.mjs` 直接挂载断言（见 PITFALLS §35）。真正还留着的缺口只有 `AccountForm` 的表单态、`ModelPicker` 的草稿/保存态，以及 `RaccoonTab` 自身的轮询生命周期——最后这条由 `test/raccoon.test.mjs`（Host 侧路由）与 e2e 覆盖。
- **联网档（`test:live` / `test:live:contract` / `test:live:raccoon`）默认一律不跑。** `test:live` 只拉公开 JWKS、不带凭据、不发登录请求；另两个分别对真实商汤推理端点与真实小浣熊网关发请求（后者在无凭据时只做路由存在性探测，不携带任何凭据、无副作用）。默认不打它们，一是避免「测试会因与插件无关的外部原因失败」，二是守住那条界线：验证不该默认等于对真实服务发请求。
- **本机的 `SENSENOVA_*` 环境变量被测试隔离。** `index.ts` 在挂载时从 `process.env` 读 API key，一台真配了它的机器会走进套件从未打桩的分支（真去拉模型目录，并把一个非控制台 token 混进断言）。只在一台干净机器上绿、在作者机器上红的套件不叫离线，叫「通常离线」——`test/peer-roots.mjs` 的 `isolateHostEnv()` 负责这件事。
- **`credentialKey` 形状有双保险。** 它是 `index.ts` 一处照抄 `@deepseek-ai/dsh-credentials` 格式（`"scope/id"`）的 shim，为让测试不解析 peer 就能跑。`config.test.mjs` 在**任何机器**（含干净检出）钉死其字面形状，`store.test.mjs` 在 peer 可解析的机器上再断言与真实实现**逐值相等**——格式一变，无论是插件这侧手抖还是 peer 包升级改了分隔符，都会红，而不是等到运行时面板读不到自己的 grant。
- **`isAdmitted` 的 IPv6 裸写形态（已修，钉在 `test/config.test.mjs`）。** 旧 `hostName()` 对裸 `::1:19387` 走 `split(":")[0]` 得空串，白名单里的 `::1` 永远命中不了——裸 IPv6 客户端被误拒。修法：`hostName` 按「最后一对冒号后若全为数字且倒数第二段也为数字（裸 IPv6 末组 + 端口）」剥端口；`::1`、`2001:db8::1` 等无端口字面量原样保留。`config.test.mjs` 有 14 条 `hostName` 用例 + 8 条 `isAdmitted` 白名单用例钉住全部形态。
- **视觉模型识别的信源字段已确认（2026-09 拉真实响应）。** 商汤 `GET /v1/models` 在**每个**条目上都带 `input_modalities`（字符串数组，如 `["text","image"]`）与 `output_modalities`。`identifyVisionModel` 已按字段判定（`"image"` ∈ `input_modalities`），名字规律（`vl`/`vision`）仅作平台某天不下发模态字段时的兜底，且已删掉 `flash-lite`（实测 `sensenova-6.8-flash-lite` 靠字段判为可看图、而 `sensenova-u1.5-lite` 是出图不是看图，纯名字会误判）。`test/parsers.test.mjs` 第 6 组钉住：字段优先、text-only 不算、出图不算（只看 input）、字段压过相悖的名字、无字段时按名字、无 id 仍出行。
- **视觉第二步（opt-in 写入本插件 settings row）钉在 `test/routes.test.mjs` M 组。** `writeImageModelIds: true` 且无 settings 服务的 Host 上，poll 照常成功、`visionModels` 照常进 snapshot（写入是旁路，失败不拖垮应答）；`ctx.get("settings")` 缺席时 `visionPublish.current` 保持 null，poll 不炸。写入本身的正确性（写了真的落进 row、revision 计数）依赖 settings 服务在运行——由 DSH 侧的 `settings.update` 契约保证，本套件不重复验。
- **路由测试用的是假 `response`，不是真实的 `http.ServerResponse`。** 它会计数写入次数（这是抓住「保存账号答了两次」的原因），但不会复现真实对象的 `ERR_HTTP_HEADERS_SENT`、`setHeader` 顺序与流语义。
- **端到端已进 `npm test` 门禁，但依赖 dsh CLI。** `test/e2e.mjs` 拉起**真 Host 进程**（`dsh web`）+ 一个 127.0.0.1 上的**假商汤平台**（`test/fake-platform.mjs`，自带独立 `$DSH_HOME`、零真实凭据、全部端点重定向到本机），断言登录/池用量/节流分类等端到端行为，并校验假平台真的收到了流量。它曾长期被排除在默认跑之外——而「嵌套 `auth:` 块打到真平台锁号」这类最危险的 bug 只有它能抓。现在 `npm test` 末尾接 `test/e2e-gate.mjs`：探到 dsh CLI 就实跑（失败即红），探不到就打醒目 SKIP 并退出 0。缺 CLI 不是回归，但一次绿跑若跳过了端到端，装配路径就没被真正验过——`.github/workflows/ci.yml` 从 **2026-10-02** 起把它列为独立**硬门禁**（e2e job 与本地一样跑 `e2e-gate.mjs`，去掉了 `continue-on-error`），不再被离线绿灯掩盖。**它自己也开着 `registerProvider: true` 并断言 provider 真的注册上了**（含目录/vision/去密状态），所以第三步那套 Host 侧装配不会被「离线全绿」掩盖；同时它把 `SENSENOVA_API_KEY`/`SENSENOVA_USERNAME`/`SENSENOVA_PASSWORD` 从子进程环境里删掉——否则开发机的 Key 会被凭据服务当成只读环境值传进 Host，目录不再降级、面板保存被拒，测试只在作者机器上红（PITFALLS §17）。

- **本机 2026-09-29 已知环境故障（非插件缺陷，勿当回归）**：隔离 Home 启动真 Host 时全部 154 个 `@deepseek-ai/*` 宿主插件 `failed to import`（required 插件 `webserver` 缺席 → 面板插件等不到 `webServer` 服务 → `dsh web` 启动失败）。根因在 **Host 运行时的宿主插件包解析链**（`C:\Users\Zhujieling11\AppData\Roaming\npm\dsh.ps1` 对应的 dsh 运行时与其 `dsh-asar-unpacked` 运行态），不在本插件代码——`DSH_HOME` 指向真实 `~/.dsh` 时 `dsh web` 正常启动（127.0.0.1:3080），且 17 个离线套件全绿。此故障下 `test/e2e-gate.mjs` 会在 `npm test` 里红；修复 DSH 运行时后自然恢复，离线门禁已独立守住全部行为语义。**（2026-09-30 状态：已恢复，本机 e2e 门禁全绿。）**

---

## 5. 行为冻结基线（`store-baseline.test.mjs`）

`token-store.ts` 计划拆成登录 / 续期 / 节流 / 迁移四块（锐评 #5：944 行单体），但四块共享闭包状态、迁移挂在读路径上，纯搬文件极易静默改掉细语义。`store.test.mjs` 的手写 check 只断言「作者想到的语义」；`store-baseline.test.mjs` 把 store 的**完整可观察面**冻结在 `test/baselines/token-store-behavior.json`：17 个场景、48 帧，每帧记录凭据服务调用序列（read/modify/delete/resolve/set/unset）、节流存储读视图、grant/ref 落盘内容、抛出的 `{code,message}` 与完整 `state()` 对象。

- **驱动方式**：只走公开 API（`getToken`/`invalidate`/`saveAccount`/`forgetAccount`/`state`），注入脚本化 `auth`、内存凭据服务、共享内存节流存储（第二个 store 实例模拟「重启」）、虚拟时钟；无网络、无 peer、无墙钟，干净检出可跑。
- **已钉死的阴沟语义**：`not_configured` 绝不写节流；parked 跨重启零新登录；本地退避 60s→120s 翻倍且关窗后 attempt 保留；平台声明的 2h 窗口不被 30 分钟本地帽截断；并发轮询单飞（恰好一次 refresh）；compare-and-set 慢者赢（并发旋转的 grant 不被覆盖）；`refresh_rejected` 无账号回收 vs 有账号重登的岔路；被拒令牌不复播；旧命名空间 grant/节流一次性收养（节流只收养第一条、第二条等 `clearThrottle` 扫）；密码不落盘（`autoRecoverArmed` 只报布尔）；无凭据服务降级并标记 `ephemeral`。
- **门禁纪律**：拆分后该套件必须零漂移。有意改动 store 行为时，先逐帧评审、再显式重生成，并在提交信息写明原因：

  ```powershell
  $env:UPDATE_BASELINE='1'; node test/store-baseline.test.mjs; Remove-Item Env:UPDATE_BASELINE
  ```

  重生成不是「让测试变绿」的手段。套件与基线同进 `npm test` 链与 CI 离线 job（三方名册由 `package.test.mjs` 钉住）。

# 更新日志（Changelog）

本文件只记**公开行为变化**（新增能力、破坏性改动、重要修复）。实现细节、重构与测试加固请直接看 `git log`。

## [Unreleased] — 2026-10-04

两条小浣熊网关契约的实测修正，都由桌面客户端行为反推后真凭据验证。

- **目录字段漂移修复**（`src/host/raccoon.ts`）：网关 `/model_catalog` 已切换为只发 `model_name` / `tags` / `params` / `billing_multiplier`，旧字段（`id` / `vision` / `input_modalities` / `context_window` / `max_output_*` / `multiplier`）全部消失，目录读取因此恒为空（不报错），面板与模型注册**恒走内置快照表**。实测 `sn-deepseek-v4-1-flash` 支持读图（`chat/completions` 带 `image_url` 回 HTTP 200），快照却标 `vision:false`。现按 v2 字段归一化、`tags` 判定 vision，并新增实测白名单 `RACCOON_VISION_WHITELIST`（实测优先于声明）。
- **限时免费 / 折扣如实展示**（`raccoon.ts` + `raccoon-roster.ts` + `wire.ts` + `i18n.ts`）：目录行的 `multiplier` 改读**生效倍率**（限免时为 0），并保留 `originalMultiplier` / `billingStatus` / `billingStatusNote`；面板模型清单对促销模型加「限时免费 / 限时折扣」徽章，倍率 tooltip 同时给出当前价与原价。此前只读原价，`sn-sensenova-6-8-flash` 面板显示 ×0.50，实际限免 0 倍（客户端把限免折扣当永久免费读）。

## [0.4.9] — 2026-10-03

两条主线：**「小浣熊」tab 的面板按自家设计系统重做**（三个注册开关换成真开关、余额从一行散文改成卡片组、模型清单表头不再替整段说明当标题），以及**限频与并发两处真实缺口**（Retry-After 的 HTTP-date 形式读不到、跨进程写入缺版本护栏）。

- **小浣熊面板重做**（`src/client/raccoon-card.ts`、`raccoon-roster.ts`、`toggle-switch.ts`、`styles.ts`）：
  - 三处注册开关（通用提供方、出图工具、小浣熊提供方）换成共享的滑动开关。原来是一个裸 checkbox 加一句脚注长的标签（`启用小浣熊提供方（向 DSH 注册模型）`），读起来像一行散文前面挂了个方框；现在是短标签 + `title` tooltip 承担说明，开关本体承担「这是个开关」的意思；
  - 余额从「余额 + 每日 600 · 奖励 8344 · 月度 0 · 充值 0 · 凭据有效至… · 续期至…」的一行散文，改成与通用积分池同款的卡片组——每个分项独立成卡、最小宽度自动换行，窄面板换列而不是溢出；
  - 两个凭据时钟（凭据有效至 / 续期至）与提供方开关移入账号卡：它们讲的是「这次登录」，不是额度数字；余额卡只留用户第一眼要读的东西；
  - 模型清单表头去掉机制说明（「勾选决定哪些模型推送进 DSH…」「以下为内置备用模型」），降到列表底部做脚注，与走势图图例同一层级——读者先看到计数与状态徽标，读完列表再读到原理。
- **Retry-After 支持 RFC 7231 的 HTTP-date 形式**（`src/host/sensenova-auth.ts`）：此前只认秒数，网关返回 `Sat, 03 Oct 2026 12:00:00 GMT` 这类绝对时间时退避预算读不到，429 会立刻重试。
- **错误响应统一走 `redactedError`**（`src/host/routes/http.ts` 及其余八个路由文件）：收口错误消息里回流凭据明文的缺口。
- **跨进程并发协议补齐两处缺口**（`src/host/throttle-store.ts`、`src/host/token-store/grant.ts`）：节流状态写入加版本护栏，读到异版的旧值不再覆盖新值；凭据 grant 改为条件回收，读到别的进程已续期的新 grant 时不再回收。
- **小浣熊模型描述符不再猜 `contextWindow` / `maxTokens`**（`src/host/raccoon-models.ts`）：改为「目录声明为准，缺则交给 harness 决定」。此前硬钉的猜数会让模型声明比网关实际支持的更大，请求落到 400。
- **小浣熊面板轮询收敛**（`src/client/raccoon-tab.ts`）：删掉为追扫码状态而写的补偿轮询，改由服务端状态驱动的双档轮询，客户端不再持有比 walk 活得更久的定时器。
- **文档新增按症状可查的排查入口**（`docs/TROUBLESHOOTING.md`，+147 行）：按现象组织、每条带稳定症状码；`npm run doctor --json` 取 `symptoms` 后跳条目。README 同步加上这个入口。


### 构建产物 lib/ 改为版本化入库（与 dsh-connect-qoder 同款决策）

DSH 市场的 `github:` 安装源是 pnpm git-dep，pnpm 11 在没有 allowBuilds 批准时**不会**替仓库跑 `prepack`/`prepare`——此前 `lib/` 与 `client.js` 被 gitignore，用户打 GitHub 仓库地址装出来的插件缺宿主入口（`lib/index.js`），卡片静默失效。现改为：

- **`lib/` 与根 `client.js` 不再忽略、随源码一起提交**（`.gitignore` 删除对应两行，并写明理由）；
- **CI 新增 `build-freshness` 硬门禁**：`npm run build` 后 `git diff --exit-code -- lib client.js` 必须为空，双跑构建比对字节稳定，防止「源码动了却没重生成产物」；
- 安装文档（`docs/SETUP.md`）更正「git 地址直接装」的描述：现因为产物已入库，GitHub 直装开箱即用、无需构建授权；
- `AGENTS.md` / `ARCHITECTURE.md` / `docs/DSH-PLUGIN.md` / `test/build-gate.mjs` 同步澄清产物已版本化。

影响：改 `src/` 后除重建外，**必须把 `lib/`、`client.js` 与源码一并提交**，否则该门禁红。发到 npm registry 的那一份仍由 `prepack` 现场重建，不受影响。

## [0.4.7] — 2026-10-02

扫码登录不再把面板与网关绑在一起：此前一次扫码能让一个 HTTP 请求阻塞最长 5 分钟，客户端再用 150 次补偿轮询去够那个迟迟不返回的状态，而第二上游的每次读都实打实打网关——等待的是人，不是连接。本版把等待挪出请求路径，并给第二上游的读接上缓存与单飞。

- **扫码登录改为「发码即回、walk 转后台」**（`src/host/routes.ts`、`src/host/raccoon-walk.ts`）：POST 立刻返回二维码；超时 / 取消 / 凭据保存失败三种终态作为**一次性事件**由 GET 的 `loginStatus` 下发，读到即清——「已登录」仍由凭据回答，事件不承担状态。客户端删掉补偿轮询死循环，改由服务端状态驱动的双档轮询，不再持有比 walk 活得更久的定时器。
- **三种失败终态有了名字**（`src/client/i18n.ts`）：`raccoon.loginTimeout` / `raccoon.loginCanceled` / `raccoon.loginFailed`，中英成对。此前它们只表现为「面板没反应」。
- **第二上游读接入缓存与单飞**（`src/host/coalesced-fetch.ts`）：前台读与后台轮询合并，一次扫码打网关的读次数从几百次降到合并后的少数几次；Token Plan 侧 `console-client` 里两份手写的 cache/inflight 一并换成同一个原语。
- **门禁补强**（发布质量，用户不可见）：名册新增 4 个套件（provider 回滚护栏、小浣熊状态读、state 分段形状）并把 `typecheck-gate` 接进链（`tsc` 缺席则 SKIP）；新增 `commit:lint` 与 jscpd 重复代码**报告档**（`npm run duplicate-check`，不挡发布）；新增 `npm run test:live:raccoon`（小浣熊 live 契约探针 + 基线，L1 档无需凭据）。
- **CI 的两处静默红修掉**：offline 硬门禁在干净 runner 上拿不到 peer 依赖，连续一整天红在第二个套件（`set -e` 让后面 17 个套件从未跑过）；e2e job 少了构建步骤，一直在拿 gitignored 的缺席产物做端到端。两项修完 CI 在 `main` 上转绿。
- **内部重构**（行为由冻结基线与套件背书）：`routes.ts` 拆成 7 条命名路由并给 `Wiring` 上类型；两个上游的发布状态机与 adapter 装配各收敛为一份（`publish-core.ts` / `llm-adapter-core.ts`）；小浣熊的状态读与 walk 各自成模块。`peerDependencies` 补齐原先漏声明的 5 个 Host 包。

### 修复：小浣熊的模型勾选是单向门（2026-10-02）

用户可见的 bug，不是重构：**取消勾选过的模型再也勾不回来**。小浣熊 roster 的每次点击都发出「原清单里去掉这个 id」，加方向从来没实现——把整列点空后该 provider 就永久推不出模型，只能手改状态文件。复选框渲染自状态、写出去的清单没有回显，所以界面上完全看不出异常。

- **勾选代数收进一个家**（`src/client/models.ts`、`raccoon-card.ts`、`raccoon-roster.ts`）：Token Plan 与网关的 `enabledModelIds` 是**两种方言**（`[]` = 不过滤 vs `null` = 整份推送），组件因此就地手搓了半个代数。新增 `raccoonModelIsOn` / `toggleRaccoonModelIn`，行态与切换后的清单读同一个谓词；全开时不塌回 `null`（`null` 只保留「从未策展」），因此网关日后新增的模型默认不勾。
- **轮询节奏改由 Host 播报**（`src/host/raccoon-status.ts`、`src/client/raccoon-tab.ts`）：`/raccoon` 的 GET 新增 `pollSeconds` / `scanPollSeconds`，客户端照用；两个客户端常量降级为「首帧兜底」并与 Host 的窗口值钉死。顺带去掉了客户端重复的 5 s 下限 / 3600 s 上限——Host 已在配置源头 clamp，客户端那道是第二个意见（且会把 2 s 的扫码档悄悄改成 5 s）。
- **小浣熊轮询补上竞态防护**（`src/client/raccoon-tab.ts`）：档位切换会重建循环并立刻取数，慢的那次可能后落地、把余额/roster/登录态整体倒退。加入与额度 tab 同款的 generation 守卫。
- **文案不再复述 Host 的数字**（`src/client/i18n.ts`）：`note` 的「约 3 小时」与 `raccoon.loginTimeout` 的「5 分钟」都是 Host 常量的手抄件（改一处即撒谎），改为只讲事实、不带数字。

## [0.4.6] — 2026-10-01

小浣熊面板把「凭据已过期」当成了「已登录」：access token 早已失效时，登录卡仍显示「已登录：退出登录」，注册也照样成立，于是模型能选、请求却一个个 401——用户只能靠猜。

- **过期状态暴露到面板**（`src/host/routes.ts`）：`/raccoon` 的 GET 状态新增 `credentialExpired` 与 `expiresAtMs`。此前 `raccoonStore.state()` 已经解析出 JWT `exp`，但 `raccoonState()` 只取了 `hasCredential`，把过期信息整个丢掉——这是「已登录」与「能请求」混为一谈的根源。
- **客户端区分两种登录态**（`src/client/raccoon-tab.ts`）：`credentialExpired === true` 时登录卡改渲染红色警示「登录已过期」，按钮换成「重新登录」（触发扫码 walk），不再走「退出登录」；未过期走原样。
- **双语文案**（`src/client/i18n.ts`）：新增 `raccoon.expired` / `raccoon.reLogin`，中英文成对。
- 凭据本身仍留在 DSH 凭据服务（`RACCOON_CREDENTIAL`），过期后靠面板提示重新扫码续期，而不是让用户误以为模型坏了。

### 真凭据复测暴露的两处抄录偏差（2026-10-01 首测）

带有效凭据逐个实测网关端点，发现参考件路径没变、是本插件抄录时走了样：

- **refresh 端点路径修正**（`src/host/raccoon.ts`）：`/api/web/auth/v1/refresh_token` → `/api/web/auth/v1/refresh`。前者用无效 token 实测得纯文本 `404 page not found`（路径不存在）；后者得 `400 {"code":100002,"message":"params_invalid_error"}`（路径存在、已抵达业务层）。此前多抄的 `_token` 后缀让**每次续期都失败**——access token 过期后只能重新扫码登录。
- **balance 字段名补齐 `available_points`**（`src/host/raccoon.ts`）：实测响应为 `{"available_points":10129,...}`，旧解析只认 `balance / available / amount`，读不到即返回 `null`，于是面板把拿不到当「积分余额 0」显示。

### 两处面板常驻入口（随本版一并到达用户）

登录态修好只解决了「能不能用」，用户还常缺两个「去哪儿办」的入口——API Key 表单的官网链接此前仅在未配置 key 时闪现，配置完就消失，而配额管理恰恰是配置完之后更需要的事；小浣熊 tab 则完全没有指向官网的路。

- **API Key 表单的官网链接改为常驻**（`src/client/api-key-form.ts`）：去掉 `hasApiKey !== true` 的条件渲染，改为按状态切文案——未配置走原「还没有 API Key？前往官网免费获取 →」，已配置走新增的「前往官网管理额度 →」。链接始终在场，指向同一处 `SENSENOVA_SIGNUP_URL`。
- **小浣熊 tab 底部补官网入口**（`src/client/raccoon-tab.ts`、`src/client/const.ts`）：新增 `RACCOON_SITE_URL`（`https://xiaohuanxiong.com/`）与 `raccoon.clientLink`「下载商汤小浣熊客户端，领取限时积分 →」。沿用 `SENSENOVA_SIGNUP_URL` 的同一套纪律：纯公开 URL、只在新 tab 打开、从不用于带凭据的请求。
- 新增两处 i18n 键（`llm.keyManageHint` / `raccoon.clientLink`），中英文成对。

## [0.4.5] — 2026-10-01

出图请求体对齐官方文档：`sensenova_draw_image` 现在会显式携带 `output_format` 与 `watermark`，并在 agent 工具参数面暴露对应入口。

- **出图请求体补齐文档字段**（`src/host/draw.ts`、`src/host/types.ts`）：`buildDrawBody()` 现默认发送 `output_format: "png"` 与 `watermark: true`，不再只发 `{model, prompt, n, size, response_format}`。这是按官方 `images/generations` 文档做的显式化——官方说明建议调用时显式传入 `watermark`，避免后续默认值变更影响线上行为。
- **出图参数归一化收敛**：`outputFormat` 只接受文档允许值（`png` / `jpg` / `jpeg` / `webp`），非法值回落 `png`；`watermark` 仅接受文档声明的布尔形态（`true/false` 或字符串 `"true"/"false"`），其余回落默认 `true`。
- **agent 工具新增两个可选参数**（`sensenova_draw_image`）：`outputFormat`、`watermark`，调用侧可按需控制出图格式与水印，缺省保持官方默认。
- **测试补齐**（`test/draw.test.mjs`）：锁住默认请求体字段、归一化行为与工具 schema 暴露；`node test/draw.test.mjs` 74/74 全绿。

## [0.4.4] — 2026-10-01

插件卡的自述面补正：中文界面下卡片的标题与简介不再显示英文，并补上卡片图标。

- **卡片标题与简介本地化**（`locale/en.json` + `locale/zh.json`）：Plugins 页卡片的这两行文案**不由插件渲染**，而是 DSH 读包元数据——`package.json.description`（只认字符串）作英文兜底，`locale/*.json` 的 `meta.title` / `meta.description` 按当前语言的兜底链覆盖（`en` → `["en"]`，`zh` → `["zh","en"]`）。此前只提供了英文那一半，于是「点进去每个 tab 都是中文、卡片却是英文」，标题还落回裸包名 `dsh-connect-sensenova-token-plan`（`displayName` 这条链路根本不读）。现在中文界面显示「商汤 Token Plan 接入全家桶」+ 中文简介；英文界面文案不变——`locale/en.json` **只写标题**，英文简介继续由 `package.json` 单一真源提供，同一段英文不会两处漂移。
- **卡片图标**（`icon.svg`）：沿用面板 `PanelIcon` 的「积分币」母题（青绿渐变圆盘 + 白色记数笔画）。读取端对图标是硬校验——相对路径、SVG/PNG/JPEG/WebP、必须落在清单目录内、≤256 KiB，任一不满足会让整条元数据报错而不是降级。
- **两处打包遗漏都是静默失效**：`exports` 缺 `"./locale/*.json"` 通配时，解析 `pkg/locale/zh.json` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，而读取端把这一类错误当「没有本地化元数据」**直接吞掉**——不报错、不告警、只显示英文；`files` 漏 `locale` 则本机（符号链接）生效、用户装上仍是英文。已连同 `icon.svg` 一起进白名单，经验写回 `docs/PITFALLS.md` §27。

## [0.4.3] — 2026-10-01

第二个上游（小浣熊）、面板从侧边栏归位到 Plugins 页、模型花名册重排，外加一批「状态翻成某个值后操作入口跟着消失」的可见性修复。

> **版本号说明**：0.4.1 与 0.4.2 都**未发布到 npm**（registry 上仍是 0.4.0）。本版把自 0.4.1 以来的全部改动一次收敛为 0.4.3，0.4.2 不再单独发布。

### 第二个上游：小浣熊 tab（微信扫码登录 + 独立 provider）

`ROADMAP §6.1` 的「第二上游」落地：接入 `xiaohuanxiong.com` 网关，与 Token Plan 积分池**相互独立**，全程 opt-in。

- **面板第三个 tab「小浣熊」**（`src/client/raccoon-tab.ts`）：开关、微信扫码登录、积分余额、模型花名册四块。文案中英双语（`raccoon.*` 17 键）。
- **Host 半边 peer-free 协议层**（`src/host/raccoon.ts`）：扫码登录走查、信封解析（成功判据是 `code === 0`，用普通 `Number` 比较——共享的 `num` 助手会把 `0` 当假值拒掉）、一次性 refresh-token 轮换、余额与目录读取、两态思考档位映射。
- **凭据走 DSH 凭据服务**（`src/host/raccoon-store.ts`）：存的是凭据服务引用而非明文；轮换后的新 pair 在续期时**回写**——这正是与「读桌面端文件」路线相比唯一能站住的地方。
- **开关按 profile 分段**（`src/host/raccoon-switch-store.ts`）：与 provider/draw 同一套文件-backed 纪律。
- **第二个独立 publisher**（`src/host/raccoon-publish.ts` + `raccoon-llm-adapter.ts`）：与 Token Plan 的注册完全隔离，小浣熊侧怎么折腾都churn 不到主注册。
- **自包含 QR 编码器**（`src/client/qr.ts`，455 行，零外部依赖）：byte mode、纠错等级 M、v1–10，登录 URL 直接在面板内编码成图。
- **测试**：`test/raccoon.test.mjs`（离线，覆盖协议、两个 store、描述符映射、publisher 状态机、QR 编码器、开关 store），已进 `npm test` 与 CI offline 档。

**小浣熊上线后连修四轮**（每条都是「面板看起来正常、实际不可用」）：

- **QR 编码器产出的矩阵没有任何解码器读得出来**：用 jsQR（`qrcode-decoder` 同款纯 JS 引擎）做解码验证时发现，首版从 v1 到 v10 全部解码失败——尽管套件里每一条结构断言都是绿的。五个缺陷全是绘制顺序或码表错误，最典型的是**定位图形（timing）画在三个 finder 之后**，把 finder 内部的第 6 行/列擦成黑白条纹；timing 必须先画，finder 后画才能覆盖。
- **扫码确认时「正在等待」不可见**：进行中的那次扫码对 tab 不可见。
- **QR 要等下一轮 60s 轮询才出现**：登录入口像没反应。
- **`fontSize` / `marginTop` 泄漏成 DOM 属性而非样式**：样式静默失效。
- **扫码登录拿到的昵称没存**：面板无法称呼用户，补存后正常问候。
- **小浣熊的积分倍率没进模型选择器**：面板花名册显示的 ×0.75 / free / ×0.2，在选择器里看不到（pi-ai 没有计费元数据通道，选择器只渲染名字）。倍率改挂进显示名——`GLM-5.3（×0.75）`、`SenseNova 6.8 Flash（free）`，倍率 1 保持裸名。两处同源，不会打架。

### 面板从侧边栏归位到 Plugins 页

- **去掉 `sidebar.panellist` 与 `main` 槽位注册**，只留 `plugins.bundle.config`：面板改为 Plugins 页内的**内联卡片**，不再占侧边栏一行（`src/client/panel-page.ts`、`src/client/index.ts`）。同时摘掉 layout 服务依赖与 onClose 按钮（Plugins 页自己管导航），`PanelPage` 的 `onClose` 改为按传入与否决定渲染。
- 这解决了「装了 5 个 connect 插件 = 侧边栏 5 行噪音」的问题，与 workbuddy 的形态对齐。

### 小浣熊模型列表：行形态与 Token Plan 花名册对齐

原来每个模型只有「名字 + 一个 English 徽章」，参数行整块缺席，读起来像个半成品。数据其实**早就在手上**——网关的目录行带 `context_window` / `max_output_tokens`，`fetchRaccoonCatalog` 自首个版本就归一化了这两个字段，`raccoonRoster` 也一路保留着，只有这个渲染组件把它们丢了：

- **补上参数行**：「256K 上下文 · 最大输出 64K」，复用 Token Plan 花名册的 `S.modelMeta` 与同两条文案模板（`llm.contextBadge` / `llm.metaOutput`）。目录没声明该字段时**不画这一段**（`num()` 对缺失值返回 `undefined`，不兜底编数）——面板只引述平台真给的东西。
- **倍率改为独立 chip**（`S.modelRate`，与 Token Plan 同款），`0` 显示 `free` 而不是 `×0`（零倍率是对模型的事实陈述，不是一个为零的费率）；新增 `raccoon.free` 键补齐 i18n。
- **倍率 tooltip 不复用 `llm.rosterRateTitle`**：那句话写的是「积分消耗**伪**倍率（自定义对比用，**非官方**）」，因为 Token Plan 的倍率确实是操作者在插件里配的；而小浣熊的倍率是**网关目录直接声明的字段**，借那句 tooltip 等于给真数据贴上"编的"标签。新增 `raccoon.rateTitle`「网关目录声明的积分倍率（0 为免费）」，并加断言钉住别再用错。
- **`· vision` 硬编码英文改为 `llm.rosterVision`「可看图」徽章**，靠右对齐——原先那个 `" · vision"` 是拼在倍率徽章里的中文字典里的英文裸串，既没走 i18n 也没走统一徽章样式。
- **给列表一个框**（新增 `S.modelPanel`）：与同 tab 里「已登录」块（`S.card`）同级的容器。行的分隔线样式**不变**——仓库既有原则是「section card 持有唯一的框、行不重画框」，缺的是列表这一层的容器，不是给每行描边。

`test/render.test.mjs` 补 5 条断言（150 → 155）：参数行在有字段时出现、在没字段时不出现为空行、费率 chip 渲染、free 不带 `×0`，以及**思考档位必须缺席**——该 provider 注册的是 `reasoning: false`（pi-ai 发不出网关唯一有效的 `extra_body.thinking`），照抄 Token Plan 那行「思考 关闭/低/中/高」等于承诺一个 DSH 选择器永远不会给的档位。均做过「删参数行 / 填入思考档位 → 红 → 还原 → 绿」验证。

### 「接入 API」tab：卡片改名、重排、默认展开

按「你为什么来这」而不是按依赖排序，三张卡全部改名 / 换位置（`src/client/panel-page.ts`、`src/client/i18n.ts`）：

- **「提供方注册与模型推送」改名「语言模型」**（`llm.providerTitle`，en: `Language models`），并移到**第一位**、默认展开。
- **「出图工具」第二位**，默认展开。两张功能卡都是用户进这个 tab 的理由；收起的卡把自己的开关藏起来，读起来像「这个功能没反应」。
- **「API Key」移到最后**并保持默认收起——它是前两张卡的**前置条件**，由它们指回来，而不是被配置的对象；卡内是密钥输入框，也不该是默认铺开的那一屏。

同时修掉一处被这次重排坑到的文案漂移：`llm.rosterEmpty` 原写「在**上方**保存一次 API Key」，而它所指引的 API Key 卡已经换到**下方**——方向词在换序后必然指错，改为直接点名「API Key」卡片（中英两侧同步；`draw.off`、`llm.noKey` 那两处「上方」指的是**同卡片内**的开关与输入框，不跨卡，保持不变）。

`test/panel.test.mjs` 补三条断言把这次的决定钉住：三张卡的渲染顺序、默认展开集合、跨卡指引必须点卡片名而非方向词（均做过「故意改回旧序 / 改回 false → 红 → 还原 → 绿」验证）。

### 截图与市场清单对齐（`docs` 门禁新增检查 11）

重截截图时文件名从 `panel-credit-pools.png` / `panel-provider-setup.png` 换了新名，磁盘与 git 都已同步，**唯独 `screenshots.json` 仍指着两个已删掉的旧文件**——工作树干净、构建通过、其余检查全绿，**没有任何东西在报错**，而它是市场页取图的唯一依据，推上去就是图裂。

- **清单对齐当前两张**：`assets/panel-credit.png`（「积分额度」tab）、`assets/panel-API-provider.png`（「接入 API」tab）；「小浣熊」那张待补。
- **`docs.test.mjs` 新增检查 11**：清单声明的每条路径必须**真实存在于磁盘**、是图片扩展名、条目数 1–8、且为仓库根相对路径。三种破坏实测红过再还原复验绿（换回旧名 / `..` 逃逸 / 拿 `README.md` 当条目）。
- **`PITFALLS` 新增 §26**（条目数 25 → 26，三处引用由门禁当场抓出并同步）：**清单类文件（`.json` / `.yml` / `.toml`）不是文档，但同样是契约**——改资产名前先问「还有谁按名字引用它」；本仓库按名字引用 `assets/` 的机器消费方只有 `screenshots.json` 一处，正是「只有一处 + 又不叫 `.md`」让它成了盲区。
- **`CONTRIBUTING` §8** 那句「重截并推送后截图自动生效（**文件名不变**）」已修正：它藏了个未言明的前提——**改名就必须同步清单**，而这次恰恰是换了名。

### 模型花名册重排（WorkBuddy 形态）

- **行去卡内框、改用分隔线**：`modelRow` 由横向 flex 行改为纵向列（头行 + 缩进的参数行），新增 `modelRowHead` 包裹头行；徽章只标 notable 态（删「纯文本」徽章、补「额度耗尽」徽章）。工具行计数成组右置，批量按钮 32px 与搜索框等高。
- **每行只留会变的 per-model 事实**：参数段从「上下文 · 最大输出 · 默认思考强度」改为**本模型实际可选档位**——「思考 关闭/低/中/高/极高[/最高]」，由 Host 新导出的 `supportedThinkingLevels` 按 pi-ai `getSupportedThinkingLevels` 同一规则过滤（与 DSH 选择器同源），glm-5.2 独显「最高」。provider 级常数（默认思考强度）收进花名册头部只说一次（`llm.rosterThinkingDefault`），**删掉逐行重复的恒定默认档**——用户锐评「恒定默认档逐行重复=噪音」，该反模式已记入 `docs/IMPROVEMENTS.md` §7。
- **`tokenSize` 修正 1049k → 1M**：千整走十进制、纯二进制走 1024、≥1M 归 M。Host 侧新增 `maxOutputLength` 投影（`0` = 未声明则整段不画，绝不猜）。
- **`matchMultiplier` 单一匹配器**：趋势行 ×N 与花名册 ×N 同源同值，两处显示不可能不一致。

### 出图行的渲染回归修复

- **出图行把名字与徽章摞成了竖排**：`modelRow` 在花名册重排时改为纵向列并新增 `modelRowHead`，但当时只迁移了 `model-picker.ts`；`provider-controls.ts` 的 `DrawSwitch` 与 `raccoon-tab.ts` 仍是旧标记——`label` 与徽章成了纵向列的直接子元素，于是堆叠，且 `modelName` 的 `flex: 0 1 auto` 被压到近乎零宽。现两处都补上 `modelRowHead` 包裹（与 `ModelRoster` 同一契约）。
- **回归守卫**：`test/render.test.mjs` G6 组改为真正挂载 `DrawSwitch` 并断言行是列形态、没有任何一行把名字/徽章留在 `modelRowHead` 之外、每行恰好 3 个头行；`ModelRoster` 与 `RaccoonRoster` 共用同一组断言并带**非空性检查**（此前「0 行也算通过」的真空通过正是这次回归溜走的原因）。为让渲染套件能挂载，`raccoon-tab.ts` 把内联花名册抽成无 hook 的导出组件 `RaccoonRoster`。
- **出图选择器的两处显示修复**：勾选态不再叠在开关上；目录为空时说明原因（而不是留白）；自动选择且未钉模型时徽章点名实际生效的模型；出图块在自动选择时也下发（此前只在钉死模型时下发）。

### 面板注册引导双向化

- 账号表单标题下与 API Key 表单底部的官网链接**两种状态都显示**：无账号时「前往官网注册」，已有账号时「前往官网管理额度 / 获取 API Key」（新键 `auth.portalHint`，中英双语；URL 入 `const.ts`）。

### 思考档位收敛到「实测过 200 才画」（面板不再过度承诺 low/medium/xhigh）

面板花名册每行原来把 `low/medium/xhigh` 对**所有**商汤模型都画出来，但冻结契约表
`test/baselines/sensenova-contract.json` 里 `xhigh` 只实测过 deepseek-v4-flash（200）、
`max` 只实测过 glm-5.2（200），`low`/`medium` 对任何模型都**从未实测**（代码依据只是
平台 400 报错文案里出现过这两个词，而 [SENSENOVA-API.md §7.6](docs/SENSENOVA-API.md)
明说那串列表是**并集**、各模型支持面不同）——用户点了某家不支持的档就可能 400。
现把 `thinkingLevelMapFor` 改为**逐模型门控**（新常量 `PROBED_EFFORT`，数据抄自同一张
冻结契约，覆盖 low/medium/high/xhigh/max 五格）：`high`（平台默认，全家族实测过）保持
开，`xhigh` 只对 deepseek-v4-flash 开，`max` 只对 glm-5.2 开；未收录模型默认全关。

**2026-09-30 探针补测后**：`test/live-contract.mjs` 扩了 `reasoning_effort:low/medium`
探针（2s 退避；429 记 INDEFINITE 不当判读——限流是节奏问题不是参数拒绝，只有 4xx 才
算"不支持"的负证据）。首跑实锤 200 的格子：sensenova-6.8-flash-lite（low+medium）、
**deepseek-v4-flash（low+medium，你原问的那行——低中档平台真支持）**、glm-5.2（low+medium）、
deepseek-flash（medium）、kimi-k3（medium）→ 这些格已翻 `true`，对应面板行放出低/中档。
仍 INDEFINITE 的（429 rpm 窗口，非 400，保持关、重跑再翻）：deepseek-v4-pro 的 low+medium、
deepseek-flash 的 low、kimi-k3 的 low。

测试同步：`contract` §2 加逐模型 low/medium 断言（读契约表，`true`→开、`indefinite`/`false`→关）、
`provider` §1（v4-flash/glm-5.2/flash-lite 的 low+medium 开、INDEFINITE 格关）、`retry` §5、
`routes` Q2、`render` G4（v4-flash 那行 = 关闭/低/中/高/极高）。文档同步：`API.md` 样例
行与字段注记、`IMPROVEMENTS.md` §7 修订、本条。

### 可见性修复三连：登录态常显 + provider 注册 pending 态 + 小浣熊错误不再被开关藏起

同族问题——「状态翻成某个值后，操作入口/错误行跟着消失，用户拿不到重入路」：

- **登录态与账号编辑器无条件可见**（中间态不再是死路）：此前「连接商汤控制台」区卡只在 `hasAccount || needsAccount` 时出现——中间态（已点过「清除账号」、grant 仍在静默续期）下整卡消失，要等 refresh_token 彻底失效才重新拿到重输入口。现改为**只要快照携带 auth 块就常显**，积分额度页底部永远有该卡（默认折叠、一键展开）：随时可核对登录态、重输账号改指仍有效的 grant、或再清一次账号。头部「需要重新登录」chip 的 tooltip 在 Host 没给 reason 时回落 guidance 文案，不再留空白。
- **provider 注册 pending 态**：开关已开、服务在、无 error，但注册没落地时，原文案谎报「未注册——勾选上方开关」（指向已勾选的开关）；新增 `llm.registeredPending` 直说 pending。同时修分支序：具体失败（providerError）优先于能力缺失（noService），两者同时成立时不再吞错误。
- **小浣熊 tab 注册状态行不再被开关门控**：providerError 原来只在 `enabled === true` 时渲染，开关一关报错就消失；现 `state !== null` 即渲染，失败行与开关解耦。
- **构建修复**：`qr.ts` 内 8 处 `x?.y = v`（可选链左值赋值）是解析错误，tsdown 直接挂掉——改为先索引后赋值。
- **测试**：`test/panel.test.mjs` B2 组翻转（中间态/死 grant 态都钉 `canManageAccount === true`）；`panel-decision.js` 镜像同步去门控；`render.test.mjs` 新增 pending 态与 error 优先序 2 项 pin。

### 运维诊断 doctor（PITFALLS §22 的欠账）

回答「这台机器的 provider / 出图开关到底开没开」——此前唯一答案在一个 JSON 状态文件里，不在任何配置文件、任何路由、任何 CLI。

- **新增 `src/host/doctor.ts`（peer-free 纯读层）+ `tools/doctor.mjs` CLI**：读 `$DSH_HOME/state/<name>/` 与每个 `<profile>/<name>/` 下的 `provider.json` / `draw.json` / `catalog.json`，报「面板保存值 > 部署默认值」的生效开关、模型允许清单、以及「文件存在但读不成」时**点名**是哪个文件（损坏/外来版本不会静默变空）。`npm run doctor`（人读）/ `npm run doctor:json`（机器读）。
- 与「大统一」定位对齐：单点入口必须可查，doctor 是第一条查询通道；它不写任何文件、不碰凭据，只在磁盘上读，Host 没起也能跑。
- **测试**：`test/doctor.test.mjs`（23 项，离线门禁）——三套 payload 解析器的「损坏/外来版本读作未设」方向、profile 分段与 shared 布局互不误认、干净机器/损坏文件的人读文案；进 `npm test` 与 CI offline 档。

### 边界裁定：第二上游正式纳入界内（不变量 3 修订）

Token Plan 与小浣熊同为商汤旗下产品线，`sensenova` 这个名头名副其实，第二上游不再是「待定方向的破例」。

- **`ARCHITECTURE.md` §5 不变量 3 修订**：划线依据从「只吸收与商汤 **Key/账号线**强相关的能力」改为「只吸收与**商汤（SenseTime）产品线**强相关的能力」。原划法按 Key 域名 / 认证域划线，会把同一厂商的姐妹产品线误判到界外——第二上游由此从「撞边界、须先定方向」变为**界内**。另两条不变量（opt-in 默认关、凭据红线）不变。
- **新增 §5.5** 记录裁定本身，**三条独立举证**而非印象：中证网 2026-07-19（U1 Pro 能力「在**商汤旗下的**产业级 AI『小浣熊』及 Seko 中已得到深度验证」）、商汤官方稿件 2026-09-21（「**商汤小浣熊 Raccoon Work**」由商汤科技打造）、以及本仓库既有措辞（ROADMAP §6.1 早写着「接入**商汤小浣熊**桌面 App 模型」——边界这次才承认，事实一直在那儿）。
- **它与 Token Plan 的确切关系**（后来人据此判断还能不能再放宽）：**同一厂商、不同产品线、认证域互不相通、积分口径互不算**。所以实现上必须继续是独立凭据 / 独立 publisher / 独立 provider id——共享任何一样都等于把两条产品线焊死。它是**第二上游**，与 §6.1.1 判死的**第二登录路径**不是同一件事。
- **防止口子被开成无限大**：本次放宽只覆盖「同一厂商下的产品线」，**跨厂商聚合**（codearts 那类一套形态融 N 家）依旧在界外。以后每纳入一条新产品线必须同时落三条——① 外部可核的厂商举证；② 与 Token Plan 的具体关系，尤其是积分与认证域是否通用；③ 齐全后才允许以 opt-in 默认关的形态进入树干。缺一条就退回 publisher 隔离那条路。
- **同步**：`ROADMAP.md` §6.1.1 的「须先定方向——不默认吸收」改为**方向已定**；`AGENTS.md` 第三条事实改为「同属商汤旗下，但认证域不相通」。§6.1.1 判死第二**登录路径**的两次复测结论**不变**——它与「第二上游属不属界内」不是同一件事，别混为一谈。

### 第二上游补复测 + 文档追平（一次自审掀开的三处「文档与代码分头走路」）

- **README 不再说谎**（它进 npm 的 `files` 白名单，是用户装完后读到的唯一说明书）：此前 ① **零处**提到当期头条特性——第三个 tab「小浣熊」；② 三处仍写「侧边栏」，而代码早已迁到 Plugins 页，第 31 行「打开侧边栏「积分面板」」会让人**找不到入口**（操作级失效，不是文字洁癖）；③ 仍挂着「面板**只读**」的承诺，而它已经能注册推理通道、挂出图工具、写 DSH settings。三处全部改正，并补齐「出图工具」与「第二个上游：小浣熊」两个真正的能力小节（含 provider id `sensenova-raccoon`、工具挂载需重启的事实）。
- **`cordis.patch.yml` 头注释的同类漂移**：第 3 行同款地写着 "sidebar panel"，同样进 npm 包，一并改掉。
- **第二上游的网关契约补复测**（新增 `docs/ROADMAP.md` §6.1.2）：2026-10-01 的四次无凭据只读请求——本插件实际依赖的 `/model_catalog` 与 `/chat/completions` 均回 `401 authorization_empty_error`（已抵鉴权层，路由健在）；09-30 记录里那个 404 的是参考件 `dsh-raccoon-work` 的 `/models`，**本插件不使用**。此前据前缀相同就判「实现的常量正是被标注 404 的那份清单」属**误判，已更正**。附带教训收进 PITFALLS §24。
- **护栏：`docs.test.mjs` 新增两条语义检查**——原有的全是形式校验（链接 / 表格去重 / 行数上限），对面「文档断言的事是否与代码一致」毫无感知：
  - **检查 9**：README 必须覆盖面板的每一个 tab。tab 名单从 `panel-page.ts` 的 `activeTab` 联合类型派生、文案从 `i18n.ts` 的 `tab.<id>` 派生，**不写死任何名字**，于是「加 tab 忘了告诉用户」和「改 tab 名不跟」都必然红。
  - **检查 10**：README 与 `cordis.patch.yml` 声称的 UI 位置必须与 `src/client/*.ts` 实际注册的槽位一致。
  - 两条都做过「故意破坏 → 必须红 → 还原 → 复绿」的双向验证（删光「小浣熊」精确报出 `raccoon（面板文案「小浣熊」）`；改回事故原文报「声称面板在侧边栏但没有 sidebar 槽位注册」）。
- **PITFALLS 新增 §24（GET 探活会误判）与 §25（形式门禁全绿 ≠ 文档说实话）**，总数 23 → 25；三处散落的过期引用（`README.md` / `AGENTS.md` / `docs/README.md`）同步——这批数字正是由新门禁当场揪出来的。

### 文档修正：撤销 ROADMAP §0 被证伪的前提

- [ROADMAP.md](docs/ROADMAP.md) §0 与 §2 引言原写「本插件已是双 profile 的 `agent-default-model`——即这台机器的**默认推理通道**，故障域已升级为推理可用性」。该论断 2026-09-29 已被 [IMPROVEMENTS.md](docs/IMPROVEMENTS.md) §1.2 撤销（`agent-default-model` 是宿主的选择记录服务，原引用不可复现），但 ROADMAP 未同步。现改为「**能力事实**：可注册 provider `sensenova-token-plan`；是否默认通道由 profile 与用户模型选择决定；一旦某 profile 选它作默认，故障域才从面板升级为推理可用性（条件性爆炸半径）」。两份文档不再正面矛盾。

### 文档与仓库纪律

- **消灭「离线 N 套件」数字漂移源**：文档不再背书套件数量与枚举（`AGENTS.md` 曾写十七套件、`DSH-PLUGIN.md` 曾列 17 项清单，raccoon/doctor 套件加入后双双过期）——套件清单与链的唯一事实源收敛到 `package.json scripts.test`（已有 `package.test.mjs` 钉磁盘 ↔ 链 ↔ CI 一致性），文档只指事实源不复制数字。
- **现状模块引用 `.js` → `.ts` 全量对齐**（64 处 / 9 文件）：只改「现状引用」，保留「历史动作 / 研究档案 / 产物 / 外部」四类原文。

### 仓库结构规范化：src/ 全源码，lib/ 纯产物

- 全部源码收敛到 `src/`（`src/host/*.ts` 27 个 Host 模块 + `src/client/*.ts` Client 半边）；`lib/` 与根 `client.js` 降为纯构建产物并加入 `.gitignore`——删掉后 `npm run build` 一条命令从源码完整重建。
- 对外行为无变化：`main`/`exports` 指向不变（`./lib/index.js`、`./client: ./client.js`），`files` 白名单同步，`npm publish` 经 `prepack` 自动构建；`exports` 收敛为 `.` 与 `./client` 两个子路径。

### 出图工具面板开关（drawEnabled）

与 provider 开关同机制的「面板开关 + 立即生效」，出图吸收（§5.4 接法 B）不再需要改配置重启：

- **面板新增「出图工具」卡片**（`client.js` 的 `DrawSwitch` 控件）：勾选保存后写入插件私有状态文件 `$DSH_HOME/state/<plugin>/draw.json`，与 `provider-store.js` 走完全相同的完整性纪律。优先级：面板保存值 > `cordis.patch.yml` 的 `drawEnabled`；从未动过面板的部署，行为与 `false` 一致。
- **新增 `POST /api/<name>/draw` 路由**（`routes.js`）：与 `/provider` 同一信任形状（同源围栏 + 4 KB body 上限），`{ enabled: true|false }` 或 `{ forget: true }`。
- **快照 `llm.drawEnabled` / `llm.drawSource`**：`snapshot-aggregate.js` 在 llm 块里回显出图开关的生效值与来源，面板无需单独调 `/draw` 就能读到当前状态。
- **`lifecycle.js` 的 `registerDrawTool` 改读生效值**：不再直接读 `settings.drawEnabled`，而是「面板保存值 ?? 配置默认值」。工具的实际挂载/缺席发生在**下一个 Host 启动**时（agent tools 没有 unregister 语义），开关值本身是立即生效的。
- **测试**：`test/provider.test.mjs` 新增 draw-store 纯逻辑组（归一、读写、版本拒绝、损坏忽略、forget）；`test/routes.test.mjs` 新增 R 组（8 项，覆盖 GET/POST/forget/跨域围栏/跨 remount 持久化/配置回退）；`test/wiring.test.mjs` 路由计数从 5 更新为 6。

### 面板视觉打磨

几处「不报错、但会误导或压平层级」的显示。

- **每模型消耗柱状图补图例**：柱子按「最高消耗者」归一化，top 模型永远填满轨道——它回答的是「谁在烧积分」，但满格会被误读成「这个模型快触顶」。卡片底部补一行说明「柱长按最高消耗相对显示，非占总额度比例」，图表不再靠省略说谎。
- **返赠余额从药丸改为指标数字**：`返赠余额 327,904` 此前裹在与「通用池/专属池」同款的圆角药丸里，一个大数字被压成和静态类型标签同等权重的装饰。改为卡头右侧的 tabular 数字，读作可花余额指标。
- **注册成功不再常驻绿色**：「已向 DSH 注册提供方…」是静止常态，长期亮 `state-success-primary` 会让人误以为刚发生了好事。收敛为中性次要文字，绿色只留给「已保存」这类瞬时反馈。
- **去掉最内层子卡的冗余边框**：section 卡→池卡→双子窗三层等宽 `border-l1` 互相抵消、压平层级。最内层子窗改为纯靠更深的背景面（layer-2）浮起，边框只留两层。
- **API Key 字段标题去重**：「模型接入（API Key）」区块头与卡内输入框标签原本同名重复，标签改为「API Key」。
- **品牌色锚定商汤紫**：去掉 shell 跟随层，3 个品牌强调点直接锚定 SenseNova 紫；活动 tab 与非活动 tab 使用同一套基础样式。

## [0.4.1] — 2026-09-29

面板前端修复：几处「看起来对、实际错」的显示，加两处让操作直接失效的 bug。

- **每周额度重置时间误显示为当天**：5 小时与每周两个窗口共用同一个时间格式化器，而它只吐 `HH:MM`——每周窗口的 `reset_at` 是几天后的绝对时刻，日期被吞掉，读作「重置 18:10」，像是当天 18 点发生。新增 `when()`：今天保持紧凑 `HH:MM`，跨天带 `MM-DD`。返赠到期一直用的是 `clockLong`（带日期），只有重置时间漏了。
- **模型选择器「全选」会清空已选模型**：`ModelPicker.bulk` 把 `{id, name, vision}` 行数组传给只接受字符串的 `allowListFor`，`rosterIds` 过滤后恒为空 → 无论点「全选」还是「全不选」都返回 `[HIDE_ALL_MODELS]`，保存即清空模型列表。逻辑提成纯函数 `bulkModelsIn`，调用点显式转 id。
- **选择器单个模型无法勾选**：`ModelRoster` 的 checkbox 只有 `checked` 没有 `onChange`，实际只读——配合上一条，整块选择器不可用。
- **轮询竞态**：前一轮请求未返回时定时器又触发一轮，慢的那次会后发先至、覆盖新数据，用量条肉眼可见地往回跳。每次 `load` 递增 generation，过期响应直接丢弃，并用 `AbortController` 取消被取代的请求（不只是忽略结果）。后台标签停掉轮询，切回时立即刷新一次。
- **控制台不可读时给出可行动的文案**：`console_error` 一直被挡在登录表单之外（`FORM_EXCLUDED_CODES`），但 `GUIDANCE_BY_CODE` 没有这个键，用户只看到裸错误串、暗示永久故障——现在提示「通常下一次自动刷新即可恢复」。HTTP 401/403 不再只显 `读取失败：HTTP 401`，改为按令牌失效处理并保持登录表单可达。
- **暗色主题状态色静默失效**：三处主题变量前缀写成 `--dsh-alias-*`（不存在的变量名），「已耗尽」红标与「已保存」绿字失效；官方 UI 一律 `--dsw-alias-*`。
- **可访问性**：错误类 7 处 `role="alert"`、状态类 5 处 `role="status"`（此前屏幕阅读器听不到任何失败原因）；QuotaCard 的 `aria-valuenow` 与可见百分比统一为一位小数；模型搜索框补 `aria-label`；两处 tooltip 不再裸露 `{balance}` / `{selected}` 占位符。

## [0.4.0] — 2026-09-29

出图吸收（大统一 §5.4 接法 B）：本插件可以给 agent 提供商汤出图能力了。

- **新增 agent 工具 `sensenova_draw_image`**（opt-in，配置 `drawEnabled: false` 默认关）：POST `{apiBase}/images/generations`，鉴权用面板「模型接入」保存的 `SENSENOVA_API_KEY` 引用（每次调用现取，轮换 Key 无需重启）。
- **出图模型识别用结构化字段，不用名字正则**：从 catalog 的 `output_modalities` 判定（与 chat 清单的排除逻辑互为反向，两份清单不可能矛盾）。社区同类 `dsh-draw-router` 的名字正则会漏掉 `sensenova-u1.5-lite`，本实现不会（对照见 `docs/ARCHITECTURE.md` §5.4）。
- **429 分诊与失败冷却**：出图失败时区分「配额不足（别盲重试）」与「限频（等再试）」；失败后 30s 冷却，防止 agent 在耗尽的共享池上打转。
- **修复 429 误判纠正（chat 路径）**：peer 的 `classifyPiAiError` 先跑 `isQuotaExceededError`，命中面过宽——商汤限频 429 体里带 `rate budget` / `credits` 字眼时会被抢判成 `QUOTA`，导致本应退避重试的限频被按"配额耗尽"快速失败、且模型被面板静默下线（呈现"额度已用尽"）。新增 `llm-error-fix.js`：在 `llm-adapter.js` 用 Proxy 包裹 `PiAiAdapter` 的流出口，把这类"误判的限频 QUOTA"在出流前纠正回 `RATE_LIMIT`（保留原 message），真配额耗尽与已限频原样放行。`test/error-fix.test.mjs`（24 项，peer-free）覆盖。详见 ROADMAP §3 的纠偏注记。
- **降级同型**：无 tools 服务的 Host、peer 加载失败、注册被拒——工具静默缺席，面板与 provider 不受影响；快照契约零改动（14 键不变）。
- 配套：`drawModelId`（首选模型）与 `drawTimeoutMs`（默认 120s）两个配置；`test/draw.test.mjs`（56 项，peer-free）。

## [0.3.4] — 2026-09-29

429 自愈与「清单自带识别」：Token Plan 池额度耗尽时，模型不再发出必失败的请求。

- **provider 级重试策略**（`llm-retry.js` → `resolveRetryPolicy` 显式配置）：配额耗尽（`QUOTA`/`ACCOUNT_QUOTA`）**不重试、快速失败**；限频（`RATE_LIMIT`）按退避重试。候选路由在共享额度池上空转只会延长冷却窗口，故刻意不对配额做重试（对应上文「不做多 Key 池」）。
- **清单自带识别**：某模型所属额度池耗尽（`remaining <= 0`）时，该模型从 DSH 模型选择器移除（不再发出必 429 的请求）；面板花名册则**保留**该模型并以 `available:false` / `quotaExhausted:true` 标记、灰色显示原因，用户可知「为什么这个模型不见了」。
- **额度跨越零点自动重注册**：快照用 `quotaSignature` 去抖，仅在额度状态变化时才触发一次 `publishProvider` 重建（受 `PiAiAdapter` 对 profiles Map 引用记忆化约束，这是唯一生效路径），无需重启 Host。
- **快照 `llm` 块新增** `quotaBlockedModelIds`；`models` 每行新增 `available` / `quotaExhausted` 字段，供面板渲染。

## [0.3.3] — 2026-09-29

**安全姿态收紧：控制台密码不再落盘**（破坏性改动——老用户升级后需重新登录一次的情况见下）。

- **密码默认不写入任何文件**：此前 `saveAccount` 会把面板输入的密码原样存进 DSH 凭据服务（`~/.dsh/.credentials.yaml`，owner-only 的明文 YAML）。本版改为只保存**账号 + access/refresh token**；密码仅在登录瞬间于内存中使用，用完即弃。
- **`SENSENOVA_PASSWORD` 环境变量是密码唯一的持久来源**（显式 opt-in）：放在环境里，refresh_token 失效后可自动重登，与旧行为一致；不放，则 refresh 失效时面板要求重新输入一次（README「登录失败怎么办」早已承诺此路径）。
- **旧版残留自动清除**：凭据服务里已存的 `SENSENOVA_PASSWORD` 引用在首次接触时被移除（一次性清扫），明文密码不会继续留在磁盘上。
- 行为影响：**升级后若当前 refresh_token 仍有效，完全无感**（续期照常）；仅在 refresh_token 已失效、且依赖"密码存在凭据服务里自动重登"的场景下，会多一次手动输入。
- `state().hasAccount` 语义微调：现在按"已保存的账号名"判定（不再要求密码可用），面板的「清除账号」入口在密码缺失时仍然可用。

## [0.3.2] — 2026-09-29

面板新增「模型允许清单」：可以**勾选具体哪些模型推送进 DSH 的模型列表**，不再只能全推或全不推。

- **面板新增模型选择器**（「模型接入（API Key）」区）：列出本 Key 目录下每个模型（带名称与可看图标记），逐条勾选；支持搜索过滤、可见项全选/全取消、实时计数，编辑先落草稿，点保存才写入。
- **新增路由** `POST /api/<name>/models`（同源围栏 + body 上限 + 500 项上限，与账号/api-key/provider 路由同一信任形状）：`POST { enabledModelIds: string[] }` 替换允许清单，**同一请求内**重新发布 provider，面板不用等下一次轮询。设计理由见 [docs/PROVIDER-HOT-RELOAD.md](docs/PROVIDER-HOT-RELOAD.md) §6。
- **清单语义**：`[]` = 不过滤，全部推送；非空 = 严格允许清单，只推列出的模型；`["__hide_all__"]` = 一个都不推送（表达「临时全部收起」，空数组已表示「未筛选」，需要独立写法）。
- **快照 `llm` 块新增两个字段**：`models`（整份可选目录：`id` / `name` / `vision`，**不受**过滤影响，面板据此画可勾选项）、`enabledModelIds`（当前生效的允许清单）。
- **`modelCount` / `visionCount` 改为按清单过滤后计数**——它们描述的是「实际注册了多少」，而不是目录有多大。0.3.1 及以前清单恒为空，数值不变。
- 清单存在与 catalog 同一份私有状态文件 `state/<name>/catalog.json` 的 `enabledModelIds` 字段（版本与原子写纪律不变），重启即恢复。
- `POST /api/<name>/api-key` 的 `forget` 语义不变，但它会连带清掉勾选记录：换一个 Key 就是一份新的、未勾选的目录。
- 补记：`package.json` 的 `version` 在 0.3.1 时漏改（一直是 0.3.0），本次一并补齐到 0.3.2。

## [0.3.1] — 2026-09-28

提供方注册开关热生效（[docs/PROVIDER-HOT-RELOAD.md](docs/PROVIDER-HOT-RELOAD.md)）：

- **面板新增真开关**：「模型接入（API Key）」区可直接勾选「向 DSH 注册 SenseNova 提供方」，保存到插件私有状态文件并在**同一请求内**重新发布 provider——立即生效，无需改配置、无需重启 Host。
- **新增路由** `GET/POST /api/<name>/provider`（同源围栏 + body 上限，与账号/api-key 路由同一信任形状）：`POST { enabled: boolean }` 切换开关，GET 回显生效值、来源与注册状态。
- **优先级**：面板保存过的值 > `cordis.patch.yml` 的 `registerProvider`（后者降级为部署默认）。未触碰面板的部署行为与 0.3.0 完全一致。
- **快照 `llm` 块新增 `registerSource`**（`"panel"` / `"config"`）；`registerProvider` 改为回显生效值。
- 开关状态存 `state/<name>/provider.json`（新模块 `provider-store.js`，版本化 + 原子写 + 损坏即读作未设置，与 `catalog-store`/`throttle-store` 同一完整性纪律）。

## [0.3.0] — 2026-09-28

第三步「一条龙」：本插件可**直接注册 SenseNova LLM provider**，不再需要手写 `llm-pi-ai` patch 行（opt-in，默认关闭）。

- **面板新增「模型接入（API Key）」区**：粘贴 `sk-` Key 即保存为 DSH 凭据服务引用 `SENSENOVA_API_KEY`（与手写 provider 读取同一引用名），支持显示/隐藏、保存、清除；环境变量 `SENSENOVA_API_KEY` 仍作兜底，清除面板引用不会动环境变量；任何接口响应只回「有无/来源」去密状态，不回显 Key。
- **新增配置 `registerProvider`（默认 `false`）**：开启后 Host 以 provider id `sensenova-token-plan` 直连 `apiBase`（默认 `https://token.sensenova.cn/v1`）注册 OpenAI 兼容适配器（`ctx.llm.registerAdapter` + `registerConfigurableProviders`），模型列表由 `/v1/models` catalog 自动构建并广播刷新；vision 模型自动带图片输入，无需手填 `imageModelIds`。
- **catalog 与模型勾选清单存插件私有状态文件** `$DSH_HOME/state/<name>/catalog.json`（原子写、损坏即忽略），不写 dsh 配置；重启后、首次轮询前即凭缓存完成注册。
- **快照新增 `llm` 块**：`hasApiKey` / `keySource` / `ephemeral` / `registerProvider` / `llmAvailable` / `providerRegistered` / `providerId` / `modelCount` / `visionCount`（成功响应顶层键 13 → 14）。
- **新增路由** `GET/POST /api/<name>/api-key`（同源围栏 + 4 KB body 上限，与账号路由一致）。
- 无 `llm` 服务或 peer 加载失败时面板与额度轮询照常工作，provider 静默缺席并在快照里带进去密错误原因。
- **peer 解析**：`@earendil-works/pi-ai` / `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-llm-pi-ai` 进 `peerDependencies`。它们由 Host 发行，npm 装进 profile 的插件能顺着 `profiles/node_modules` 解析到；**开发期 symlink/junction 进 profile 的检出解析不到**（Node 会把链接解成 realpath），表现为面板一直说「provider 缺席」而离线套件全绿——修法与现象见 PITFALLS §16。
- e2e 现在会真开 `registerProvider` 并断言注册成功（含目录 / vision / 去密状态），并像离线套件一样从子进程环境里剥掉 `SENSENOVA_*`（PITFALLS §17）。
- Host 侧改动需**完全退出 DSH（含托盘）后重启**生效。

## [0.2.0] — 2026-09-28

文档与合规加固（无对外行为变化，纯质量与一致性工作）：

- **文档职责归位**：根 `README.md` 从 ~243 行瘦身到 ~128 行，只留索引与快速上手；重复的「认证」章节、配置/节流/测试表格、文件表已删除或下沉。
  - `docs/SETUP.md`：新增「环境隔离（web 优先，桌面端后置）」说明与「常见信号与处置」表。
  - `docs/TESTING.md`：吸收原 README 独占的开发轶事（test:live 边界、读写隔离、凭据双钉、store 守卫），并补 `docs.test.mjs` 一行职责；测试套件说明由「九套件」更正为「十套件」。
  - `docs/DSH-PLUGIN.md`：移除写死的测试计数，教学快照 caveat 与 `files` 数组同步到真实 `package.json`。
  - `docs/ARCHITECTURE.md` / `docs/CONTRIBUTING.md`：把 host 外路径（`~/.dsh/profiles/desktop/cordis.patch.yml`）标注为「仓库外」，示例提交信息改为中文。
- **文档一致性门禁**（新增 `test/docs.test.mjs`，已纳入 `npm test` 十套件与 CI）：内部链接可解析、同一张表格不跨文件重复、根 README 行数上限、DSH-PLUGIN 教学快照与 `package.json` 同步、`API.md` 快照示例与声明契约键集一致。
- **许可证与第三方合规**：新增 `LICENSE`（MIT，Copyright (c) 2026 eghrhegpe）与 `THIRD_PARTY_NOTICES.md`（致谢 dsh-connect-qoder 文档范式、connect 家族设计对齐、上游接口参考实现）；二者进入 `files` 打包清单。
- **上游关系澄清**：各文档补 `shaobingtongzhi/sensenova-usage-dashboard` GitHub 参考链接；如实记录本地 `upstream/` 副本当前不含 `.git`（设计态为独立仓库，恢复命令见 `docs/ARCHITECTURE.md` §1）。
- **首次发布 npm**：`dsh-connect-sensenova-token-plan@0.2.0`（无 scope、公开）；`package.json` 移除 `private: true` 并补 `repository` 字段指回 GitHub 仓，市场列表可自动关联下载量。

## [0.1.x] 及之前 — 未发布

早期提交（最新见 `git log`，本机无 git tag）：实现 OIDC+PKCE 登录、密码 JWE 封包、`refresh_token` 静默续期、登录节流分类、双窗口（5h/7d）用量面板、趋势与返赠明细、视觉第二步 opt-in 写入本插件 settings。具体条目以提交历史为准，本文件不再补列。

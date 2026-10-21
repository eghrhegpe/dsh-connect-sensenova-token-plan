# AGENTS.md — AI 会话纪律

给 AI 协作会话的第一站。**纪律文件不是教程**：不重复 `docs/` 的内容，只钉死：**按哪条路走、怎么验证、什么红线、去哪查**。
每次会话先读本文件；第一屏的「探索顺序」按任务分派，别从「进入代码库的读取顺序」一路读到底——那是读代码的路，不是做任何事的路。

> 通用纪律底座（并行会话纪律 / 评审纪律 / 验证约定）与兄弟插件共用，见 `AGENTS.common.md`（改了要回灌其余四仓同名文件）。

## 探索顺序（按任务挑一条路，别从头读到尾）

本文件是**纪律文件不是教程**：它钉死红线、验证、导航，不教一步步做。按你当下的任务照下面一条路走；
每行给「先读 → 再读 → 动手前确认」三段式。

**开头这条比表里任何一行都值钱**：如果这次要回答的只是一个**判定存在性的问题**——「这张截图有没有人链接」
「这个字段到底生效没」「某文件在不在盘上」——那答案是**一条 `ls` / `grep`**，不是「读实现 + 跑全量」。
2026-10 的实录：查「新截图有没有被引用」花了约 5 万 tokens（读完全套实现、跑 34 套件 + e2e），
而当时唯一需要的是 `grep -rn sensenova-usage-capsule .` 一条命令。**先问「哪条命令能回答它」，
答得出来就先跑那条命令，跑完就回答。**

| 你的任务 | 第一站（先读） | 第二站（再读） | 动手前确认 |
|---|---|---|---|
| **判定存在性 / 归属**（有没有人引用、某配置生效没、文件在不在） | 无 | 无 | 一条 `grep`/`ls` 回答；**不要**升级成读实现或 `npm test` |
| **改文档 / README / `cordis.patch.yml` 文案 / 加截图资产** | 无（看任务本身） | `test/docs.test.mjs` 检查 9–11（tab 全覆盖 + 槽位一致 + `screenshots.json` 图与孤儿资产） | `grep -rn "<文件名>"` 拿到引用者 → 再 `node test/docs.test.mjs`。**不进 `src/`、不 build、不跑全量** |
| **它坏了 / 用户报了个现象** | 下方「去哪查」第 1 行（`docs/TROUBLESHOOTING.md`，按症状码） | `docs/PITFALLS.md` 对应条目 | 先跑 `npm run doctor --json` 取 `symptoms`，按现象定位，别按模块名猜 |
| 改 host 逻辑 / 加路由 / 改配置字段 | 本文件「三条事实」「红线」→ `docs/API.md`、`docs/SETUP.md` | `src/host/index.ts`（`apply` 是唯一装配点）→ `src/host/routes.ts`（路由门面） | `npm run build` + 该域测试；**碰契约文件（`src/shared/*`、`client.js`、`lib/index.js`）走全量** |
| **动凭据 / 登录 / 续期 / 节流 / 加解密** | 本文件红线 1/2/4/6 → `docs/AUTH.md` | `sensenova-auth.ts`、`token-store/*`、`throttle-store.ts`、`sensenova-crypto.ts` 照单全读（不按行数挑） | `node test/auth.test.mjs` + `node test/store-baseline.test.mjs` + `node test/credential-guard.test.mjs`（判据：凭据只走 `verbatim()`，`str()` 读一次就红）；要 `UPDATE_BASELINE=1` 就是更大的事，**先停下来说** |
| 动第二个上游（小浣熊 / `sensenova-raccoon`） | 下方「去哪查」对应行（`docs/ROADMAP.md` §6.1.2 / §6.1.4） | `src/host/raccoon*.ts` | `node test/raccoon.test.mjs`（peer-free，clean checkout 可跑）；两边凭据/store/publisher 影响须恒为零 |
| 改面板 UI / client | 本文件「三条事实」第 2 条 → `docs/PITFALLS.md` §41 | `src/client/cards.ts`、`src/client/panel-page.ts` | **改 `src/` 必先 `npm run build`**，否则 render 套件 eval 的是旧 `client.js`（绿了也是假的） |
| 拍 / 改裁定，回溯边界与定位沿革 | 下方「去哪查」对应行（`docs/ADR.md` 账本 + `docs/ARCHITECTURE.md` §5 正文） | — | 现行正文**禁内联「修订（日期）」补丁**，`test/docs.test.mjs` 的 `ARCHAEOLOGY` 把关 |
| 通览事故史 / 接手维护 | `docs/PITFALLS.md`（现象→根因→修法，条数见文件头，别写死） | `docs/ARCHITECTURE.md` §5 | 崩溃系（§30 / §38 / §42 这类）已写明病历与处方，别重演 |

下面「去哪查」是**第二层字典**——路走了一半、要定位某个具体文件或细节时才去翻，不必一开始通读。

## 项目一句话

DSH 插件：参考上游应用 `upstream/sensenova-usage-dashboard`，从商汤 SenseNova 控制台 API 读 Token Plan 额度，渲染到 Harness **Plugins 页的插件卡**（三个 tab：积分额度 / 接入 API / 小浣熊）。
Host（Node/cordis）走完整 OIDC+PKCE 登录并自续期；Client（React bundle）轮询本地路由。

**三条事实**（写代码前先认清你在动哪一条）：

1. 「积分额度」tab 是地基，走 Host 登录 + 自动续期，只读 OpenStack 控制台。
2. 「接入 API」tab 与出图工具会把本插件**升级为推理通道**——注册 provider `sensenova-token-plan`、给 agent 挂 `sensenova_draw_image`。它们都是 **opt-in 默认关**，任何失败必须降级为「面板照常用、该模块缺席」。
3. **「小浣熊」tab 是第二个上游**：接的是 `xiaohuanxiong.com` 网关的**独立 provider** `sensenova-raccoon`。它与 Token Plan **同属商汤旗下**，但**认证域互不相通**（桌面 App 登录态打不通 Token Plan，实测见 `docs/ROADMAP.md` §6.1.1）——所以它在 §5 不变量 3 的**界内**（裁定见 `docs/ARCHITECTURE.md` §5.5），而凭据仍必须各走一套。改这条线时它对主注册的影响应恒为零：两边 publisher、store、凭据引用全部隔离。

**定位变更（2026-09-29）**：从「只做额度信息、n 个插件分散行动」转向**大统一——商汤全过程集成的单点入口**（额度 + provider + 出图路由对接 + 429 自愈（退避/分诊，不做多 Key 池），逐块 opt-in 吸收）。边界与三条不变量见 `docs/ARCHITECTURE.md` §5，同类插件核实事实见 §5.3；吸收路线图见 docs/ROADMAP.md，设计决策研究档案见 docs/IMPROVEMENTS.md。

在 web 端、desktop 搜索同类插件：见 `~/.dsh/profiles`（同类插件清单随生态变化，不在此硬编码；当前含 commandcode / qoder / trae / workbuddy 等）。

## 验证（按域裁剪，禁止无脑全量）

```bash
node test/auth.test.mjs     # 登录/PKCE/JWE/节流分类
node test/store-baseline.test.mjs # token-store 全行为冻结基线：拆分/改动续期·节流·迁移前后必须零漂移
node test/panel.test.mjs    # 面板决策、中英字典一致性
node test/parsers.test.mjs  # 响应解析层：字符串数值/epoch、shape 漂移、trend 求和
node test/docs.test.mjs  # 文档一致性：内部链接、跨文件表格去重、README 行数上限、教学快照、API 契约
node test/e2e.mjs           # 端到端单独跑：拉起真 Host + 假平台，约 10 秒（需 dsh CLI）
npm test                    # 全量离线测试门禁 = node test/run-all.mjs（套件名册单一声源 test/suites.mjs；各门禁探到 typescript / tsdown / jscpd / dsh CLI 才实跑，否则 SKIP）
npm run test:list           # 只列名册不执行
node test/run-all.mjs --only=<子串>   # 按域裁剪的正式形态（--skip=<子串> 反向；空选择直接红，绝不假装通过）
npm run build               # 改 src/（host 或 client）后必跑：重建 lib/ 与根 client.js；两者已**版本化入库**（不再 gitignore，理由见 .gitignore 注释 + 兄弟插件 dsh-connect-qoder 的 docs/issues/19：github: 安装源不跑 prepack，lib 不入库则 GitHub 直装坏）；提交源码时务必把产物一并提交，否则 CI 的 build-freshness 门禁会红
```

- **e2e 已在 `npm test` 门禁里**（经 `test/e2e-gate.mjs`），但只在这台机器装了 dsh CLI 时才真跑；
  CI 里它是独立硬门禁（2026-10-02 起：`ci.yml` 的 e2e job 也跑 `e2e-gate.mjs` 并去掉了
  `continue-on-error`——缺 dsh CLI 时它 SKIP 退出 0，有则真跑且红即拦）。手工排查用 `node test/e2e.mjs` 单跑即可。
- **e2e 只跑一次**。它要启动真实 Host 进程；需要看两段输出就跑一次落盘再读文件，
  不要把同一条命令串两遍。
- **peer 套件缺依赖是 SKIP，不是红——但只在本地**。`store.test.mjs`
  （`@deepseek-ai/dsh-credentials` + `dsh-credentials-local`）、`routes.test.mjs`
  （`dsh-credentials`）、`wiring.test.mjs`（`@deepseek-ai/cordis`）依赖随 DSH runtime
  发行的 peer，不在插件目录；`e2e-gate.mjs` 还要一棵能被 Host 真正引导的 runtime 树
  （判据与 `test/e2e.mjs` 同源，都是 `cliRuntimeModules()`，见 `test/peer-roots.mjs`——
  刻意不去发明第二个"什么算完整"的答案）。本机缺这些时它们经 `test/env-skip.mjs`
  **loud skip**：stdout 一行 `[skip] <套件> — <原因>`（`run-all.mjs` 据此把它们单列进
  汇总，不算作通过）+ stderr 写明这轮**没验证什么**。`cannot resolve the peer dependency`
  因此不再出现在本地汇总里；要看那个红：`DSH_TEST_STRICT_SKIP=1 npm test`。
  小浣熊域不在此列：`raccoon.test.mjs` 自证 peer-free（头注写明，决策面在 clean
  checkout 可跑）；`peer-contract` / `retry` 是半依赖形态——peer 可达时追加真跑、缺席时自
  SKIP，红才算回归。
  **CI 恒为严格模式**：offline job 已装 CLI 供应运行时（`.github/workflows/ci.yml`），
  那里同一缺口 = 真回归——`env-skip` 在 `CI` 下把每个 skip 升回失败（2026-10-01 的 §30
  事故是「红了一整天没人管」，它的镜像同样致命：四个被文档豁免的常驻红，会让第五个
  红失去说服力）。
- 测试数会随并行会话变化，只看自己域的增减。**套件项数不在这里写死**——它是每次改测试就腐
  的即时值，真源是 `test/suites.mjs`，用 `npm run test:list` 自证（该命令只列不跑）。单套件
  计数看 `test/<域>.test.mjs` 结尾的 passed/total 行。
- **动了契约/接缝文件，跑全量，别按域裁剪**。`src/shared/*`、`client.js`、`lib/index.js`
  以及被多个模块消费的文件，消费者不可枚举——按域裁剪会漏掉跨域契约（实测：只给面板加一个
  渲染分支，draw/render/typecheck 全绿，全量才在 `panel.test.mjs` 的 table-driven tt 白名单上红）。
  判断标准：这个文件的消费者我数得清吗？数不清就全量。
- **全量现在是安全的，且能给出完整信号**（2026-10-05 起）。此前 `npm test` 是一条 `&&` 链：
  第二个套件（peer 依赖的 `store.test.mjs`）一红，后面 26 项**一次都没跑过**，而输出看起来
  只是一次普通的用例失败——这正是 PITFALLS §30 根因 2，那条 lesson 写了一年没修。现已换成
  `test/run-all.mjs`：跑完名册里的每一项再汇总，失败项逐个点名，并附「N 项跑过并通过」。
  **所以「跑全量」不再是件有代价的事**（本机 peer 可解析时约一分多钟），别再因为怕卡机器
  而只跑自己那一个域——那正是让 §30 那次事故藏了一整天的姿势。
- **撞了封闭集合检查，别绕过，按它的修法补进去**。仓库的高 ROI 门禁多是闭合清单
  （panel 的 tt 白名单、PITFALLS 条目数、degrade marker grep、聚合器纯度断言）。被它拦住
  = 你动了未登记成员，正确动作是把新成员补进清单（连代码带测试），不是放宽或删掉这条检查。

## 红线（违反任一都会炸到用户机器）

1. **凭据不入库**：账号与 access/refresh token 只进 DSH 凭据服务（`~/.dsh/.credentials.yaml`，owner-only），
   永不写入插件目录、永不进 git、永不进日志；**密码不落盘**——仅登录瞬间内存使用，`SENSENOVA_PASSWORD`
   环境变量是它唯一的持久来源（显式 opt-in，勿把密码写回凭据服务）。登录 trace 已在 `sensenova-auth.ts`
   内做值级脱敏（`code`/`code_verifier`/token/cookie），新增输出点必须过同一套
   `sanitize*`。
2. **credentials 记录只能是 `kind: "grant"`**。发明私有 kind 会让凭据文件对
   整个 Host 不可解析，而该服务是 required —— **Host 直接起不来**。私有状态
   **不进凭据服务**（节流等已迁到插件状态文件 `throttle-store.ts`）；历史上寄
   存在凭据记录里的节流仅按 marker（`THROTTLE_MARKER`）做一次性迁移读取，别把
   它变回常驻地址。
3. **auth overrides 是 patch 行的顶层键**（`iamBase`、`tokenEndpoint`…），
   不是嵌套 `auth:` 块。嵌套会被静默忽略，面板拿着出厂默认值打到**真平台**——
   这条已经锁过一次号。`resolveAuthOverrides` 对嵌套块直接抛错，别放宽它。
4. **PKCE verifier 用 `Uint8Array` + 长度自检（43–128）**。`Buffer.from(Uint32Array)`
   按"每元素一字节"编码、静默截断——曾产出 11 字符 verifier，token 端点只回
   `invalid_grant`，hint 是唯一线索。`b64url` 只放行
   `Uint8Array`/`ArrayBuffer`，对其余 TypedArray 直接抛 `CODE.CONFIG`（拒绝分支，
   不是补偿分支）——别改回补偿。
5. **登录路径的每次尝试（成功也算）必须经 `onTrace` 落盘**。没有成功 trace，
   "浏览器能登、面板不能"就无法对照排查。
6. **密码必须走 JWE 封包**（平台 JWKS 公钥 RSA-OAEP + A256GCM），明文不上网；
   算法组合是平台钉死的，不是自由参数。
7. **一个上游 = 一个 provider id，descriptor 的 `provider` 只能等于本路由注册的 id**。
   DSH 在每条 assistant 消息上记 `source.provider`（解析到的**路由 id**），而
   `replayState.response.provider` 抄自 descriptor 的 `provider` 字段；宿主重放校验
   比对这两个值，不等即判为外来消息，pi-ai 把整段思考块重放成正文。所以**禁止**引入
   跨上游共享的 identity 常量：名字与章不同的那条路由会每轮静默降级。装配期的
   `assertProviderOwnership`（`llm-models.ts`，由 `assemblePiAiAdapter` 首行调用）对它
   直接抛错，**别放宽成 warn 或自动改写**。新增上游先给它新 id，再走同一个装配函数。

## 并行会话纪律

通用核心条款（不碰 `git stash`/`push`/`pop`、路径限定提交、`git status --short` 复核、targeted 复跑定性）见 `AGENTS.common.md` §并行会话纪律；下面是本仓补充与事故实录。

- **同一个文件被两个会话改着**（2026-10-02 撞过一次：另一会话在做 `.js`→`.ts` 文档清扫，
  9 个文档同时处于「他改一半 + 我改一半」）：这时整文件 `git add` **一定会捎带对方的改动**。
  两条路，选一条：
  1. **等对方先提交**，再动那个文件（最省事，优先）；
  2. **只提交自己的 hunk**：`git diff -U3 -- <文件> > tmp/mixed.patch`，只保留自己的 hunk
     （留一个只在你这侧出现的标记行做筛子），`git apply --cached --check` 过了再 `git apply --cached`，
     最后 **不带路径** `git commit`。
- ⚠️ 上面第 2 条的坑：**`git commit -- <路径>` 提交的是工作树版本，不是索引**——带路径写会把
  对方那半一起写进提交，hunk 级暂存就白做了。要么 `git add <文件>` + `git commit`（提交索引），
  要么 `git commit -- <文件>`（提交整个工作树版本）。提交前用 `git diff --cached --stat` 核对，
  提交后用 `git status --short` 确认留下的只剩对方的改动。
- ⚠️ **路径限定提交只带得上「已跟踪」的文件，新建的一概漏掉**（2026-10-05 撞过）：
  `git commit -- <路径>` 不含 `--include`/`-a`，**untracked 的新文件不会被纳入**。
  那次事故的直接原因是 chunk 文件名带内容 hash：改 `src/` 一 build 就变成「旧 chunk
  被删、新 chunk 是 untracked」，`-- src lib` 只带上了已跟踪的 `lib/index.js`，结果它
  引用磁盘上不存在的分块，而**GitHub 直装源不跑 prepack，装到就坏**。
  **该失效面已在 2026-10-06 收窄**（`tsdown.config.mjs` 的 `chunkFileNames: "[name].js"`，
  不带 hash）：产物名稳定，改 `src/` 一 build 是**原地修改**（git 显示 `M`），不再产生
  「删旧 + 新增 untracked」这一对。剩下的唯一触发条件是**新增一个切分模块**（新的
  `import()` 目标）——那一次的新 chunk 仍是 untracked。所以纪律不变：改 `src/` 的提交里，
  产物目录要先 `git add <产物目录>` 再 `git commit`（不带路径），
  或分两次提交（第二次专门补产物，提交信息写明是补漏）。
  复核姿势：`git status --short` 应为空；再 `git ls-files <产物目录>` 数一遍文件数，
  对得上构建输出才对。
- ⚠️ **构建产物是整包的：`npm run build` 会把工作树里所有 `src/` 改动编进 `client.js` / `lib/`**，
  包括别人还没提交的那半（2026-10-19 撞过：另一会话正在改 `src/client/cards.ts`，我 build 一次，
  产物里就多出了对方的逻辑）。所以产物不属于任何单个会话，**路径限定提交隔离不了它**：
  带上 `client.js` = 替对方提交了他的实现；不带 = 产物与源码不一致，build-freshness 门禁红。
  处置顺序：build 前先看 `git status --short` 里有没有别人的 `src/` 改动 → **有就等对方提交再 build**
  （这次就是这么解开的：对方先落了 `2783d55`，我再 build，产物才只含已提交的源码）；
  实在等不了，build 后核对 `git diff -- client.js`，并在提交信息里写明产物含对方哪一处改动。

## 去哪查（docs/ 地图）

| 何时 | 查 |
|---|---|
| **排查问题（手里是症状，不是主题）** | `docs/TROUBLESHOOTING.md`——按现象组织，每条带稳定症状码；先 `npm run doctor --json` 取 `symptoms` 再跳条目。症状码真源是 `src/host/codes.ts` 的 `SYMPTOM`，与该页由 `test/doctor.test.mjs` 双向钉住 |
| 排查登录失败 / 改 PKCE、JWE、续期、节流 | `docs/AUTH.md` → `docs/SENSENOVA-API.md` |
| 动第二个上游（小浣熊 / `sensenova-raccoon`） | `docs/ROADMAP.md` §6.1.2（网关契约复测表）/ §6.1.4（接入面盘点：死常量、死负载、签到边界）→ `src/host/raccoon*.ts` |
| 给用户看的文案（README / `cordis.patch.yml`）改了 | `test/docs.test.mjs` 检查 9–11（tab 全覆盖 + 槽位一致 + `screenshots.json` 图真实在盘），两者都进 npm 包 |
| 理解 Host/Client 分流、双仓库关系 | `docs/ARCHITECTURE.md` |
| 拍/改裁定、回溯边界与定位沿革（现行表述 vs 历史依据） | `docs/ADR.md`（决策账本；取代关系与举证链在此，现行规则见 `docs/ARCHITECTURE.md` §5）；**现行正文禁内联「修订（日期）」补丁**，`docs.test.mjs` 检查 `ARCHAEOLOGY` 把关 |
| 查某条事实「当初从哪来」 / 要落盘新参照件 | `docs/REFERENCES.md`（`upstream/` 容器清单：来源 / 版本 / 许可 / 承重在哪） |
| 加配置字段 / 改路由 | `docs/API.md`、`docs/SETUP.md`；提供方开关见 `docs/PROVIDER-HOT-RELOAD.md` |
| 改测试前 | `docs/TESTING.md` |
| 改任何代码前扫一眼 | `docs/PITFALLS.md`（现象→根因→修法，条数见文件头，别写死） |
| **测试全绿或变异全被杀死，但其实没测到你改的那行** | `docs/PITFALLS.md` §41（`render-dom.test.mjs` 等套件 eval 的是产物根 `client.js`，改 `src/` 后必须先 `npm run build`） |
| **测试只在深夜红、白天自己绿**（红与运行时刻有关）| `docs/PITFALLS.md` §42（期望值挂 `Date.now()`+相对偏移、形状取决于日历日归属的断言必在 23:00–24:00 窗内翻车；改用运行时刻不变的日历锚或冻时钟） |
| **改文件时工具「什么都没做」**（`replace` 不匹配、`Edit` 反复失败、多半是行尾）| `docs/PITFALLS.md` §38（工作树 CRLF/LF 分布用 `git ls-files --eol` 自明，**别写死数字**——`i/lf` 与 `w/crlf` 各计一遍再下锚点；`replace` 后必须断言变化） |
| 排查「这条配置到底生效没」 / 改了源码却没变 | `docs/PITFALLS.md` §22（bundles 装载 → patch overlay → `$DSH_HOME/state/<profile>/<name>/` 三层，desktop 是安装副本、web 是 symlink） |
| 加/改 **state 文件**、读 `profileContext`、判断某状态该不该按 profile 分段 | `docs/PITFALLS.md` §23（catalog/provider/draw 分段；throttle 与凭据 grant **故意共享**，别统一） |
| 提交约定、`upstream/` 红线 | `docs/CONTRIBUTING.md` |
| 发版 / 补发（tag・`main`・npm・Release 四条独立通道） | `RELEASING.md`（状态表 S0–S4 **含 S2′ 顺序颠倒**、§4.5 推荐顺序、§5.5 发布内容一致性核验） |

## 进入代码库的读取顺序（AI 会话）

约 2 万行 src + 约 1.8 万行测试（`test/**/*.mjs`；含测试支撑文件约 2.2 万行），乱序读会把时间花在「重新验证文档已写明的事实」上。
这条顺序是 2026-10-02 全库审查后的复盘：先建坐标系，再读代码。

> ⚠️ **这 8 步是「读代码」的路，不是「做任何事」的路。**开读前先过一个闸：
> **这次改动会不会改变运行时行为？**
> - **不会**（文档、README、`cordis.patch.yml` 文案、`assets/` 截图、注释、`screenshots.json`）
>   → **直接从第 8 步的轻档验证起步**（`grep -rn <文件名>` 找引用者 → `node test/docs.test.mjs`），
>   第 1–7 步全部跳过。2026-10 的实录：查「新截图有没有人引用」把 8 步走满，约 5 万 tokens，
>   而当时唯一需要的是 `grep -rn sensenova-usage-capsule .` 一条命令。
> - **会**（`src/**`、`client.js`、`lib/**`）→ 走完整顺序；碰契约文件再加跑全量。
>
> 判定标准只有一条：**能变成「哪条命令能回答它」的问题，就别升级成「读实现 + 跑全量」**。

1. **先文档，后代码**：本文件 → `docs/README.md` 索引 → `docs/ARCHITECTURE.md` §5
   （三条不变量 + §5.5 双上游裁定）→ `docs/PITFALLS.md` 现象→根因→修法（条数见文件头）扫一遍。这些是判断
   「代码对不对」的坐标系；跳过它们 = 把 `index.ts` 里已写清的接线重新验证一遍。
2. **git 先行**：`git log --oneline -15` + `git status --short`。并行会话常驻，
   「刚提交的文件」（尤其 `client/` 与 `sensenova-auth.ts`）最可能有新鲜改动或未
   提交半成品，优先读，并先确认 HEAD 再下结论（本次审查就撞上 `useSnapshotPolling`
   在审查中途被另一会话提交）。
3. **装配点优先**：先读 `src/host/index.ts`（apply 是唯一装配点，建立依赖图），
   再读 `src/host/routes.ts`（路由门面：返回 7 个 `off()` 回执——6 条 Token Plan 路由
   + 1 条 raccoon 路由；`routes/http.ts` 是共享原语，不是资源）拿路由家族图；
   顺着依赖走，别按文件名猜。
4. **错误语义先行**：先读 `src/host/codes.ts`（单一 taxonomy + 派生集合）。全仓
   错误分类以它为真源，「按状态码分类 vs 按 body 字段分类」这类不一致只有对照它
   才显形——2026-10 的 refresh 400 误删凭据就是对照登录路径的 `rejectionCode`
   才看出来的。
5. **凭据域必读，不按行数挑**：`sensenova-crypto.ts`、`token-store/*`、
   `throttle-store.ts`、`sensenova-auth.ts` 是红线 1/2/4/6 的落点，无论大小照单
   全读；行数排序只用来排其余代码的优先级。
6. **两条上游分开读**：Token Plan（index → token-store → sensenova-auth →
   routes/*）与小浣熊（raccoon-walk/publish/status/llm-adapter）凭据、store、
   publisher 全隔离，混读会把「哪条线属于谁」搞混（ARCHITECTURE §5.5）。
7. **改行为前先读测试与基线**：`docs/TESTING.md` 说明每个套件测什么；动
   token-store 前先判断行为冻结面（`store-baseline`）要不要 `UPDATE_BASELINE=1`
   ——要的话是更大的事，先停下来说。测试里 `check(name, condition, detail)` 的
   `name` 本身就是契约，1.8 万行测试是规格，不是附件。
8. **验证闭环**：改完跑对应域单测（`node test/<域>.test.mjs`）→ 全量 `npm test`
   （= `node test/run-all.mjs`：跑完名册全部项（套件 + 门禁，见 `test/suites.mjs`）再汇总，失败项逐个点名；
   「末尾绿」「按链序定位」都是旧 `&&` 链的读法，别再用）。

## 会话纪律：边界先于取证（AI 自己会翻的车）

上面「已知的真实坑」是**产品**的坑，这里是**会话**的坑——它们不会被任何门禁拦住，只会烧掉上下文和用户的耐心。评审阶段的通用四条（量化可复现 / 先读裁定再读代码 / 无罪搜索 / 结论四级）见 `AGENTS.common.md` §评审纪律；本仓会话专属的坑如下：

- **判定边界先于取证**：回答「有没有」「在不在」「生效没」这类问题，先跑那条能回答它的命令，
  再决定要不要往下查。**「我要验证它没问题」不是许可**——先问「哪个门禁会因为什么变红」，
  答不出来就说明这次验证没有靶子，跑全量只是买安慰。
- **门禁全绿 ≠ 没事**：本仓有两类缺陷跑测试永远挖不到——① 语法合法、类型也对，只是**排版/折行
  被挤坏**（`tsc` 与全部套件都抓不到，2026-10 实测：39/39 全绿而 `provider-reconcile.ts` 与
  `runtime.ts:21` 的接口声明被挤成一行）；② **门禁本身在核错对象**（判据绿着，因为它检查的是
  另一个文件）。两类都只能靠读代码 + **变异实证**抓：故意把文件写错 → 跑一次门禁 → 看它到底
  点不点得中 → 按原字节还原（**不要用 `git checkout` 还原**，会带走并行会话的未提交改动）。
- **排版损伤靠机械扫描兜底**：全仓扫 `;\s{3,}\S` / `\}\s{3,}\S` / `\{\s{3,}\S`（排除 `//` 行尾
  注释），命中即人工看一眼。肉眼扫不出折行损伤，这条是唯一可靠的兜底。
- **改含中文的文本先用 `repr` 核对磁盘原文**：`read` 的输出带行号前缀，全角标点（——、、
  「」、节线 U+2500）在眼里极易看串。`python -c "print(repr(open('f',encoding='utf-8').read()))"`
  打出真身再抄；**`replace` 之后必须断言变化**（不匹配时工具可能什么都不做）。
- **别按文件名猜装配**：`apply()` 里没有的符号，就别在 `index.ts` 里找——它可能在
  `runtime.ts`/`routes/*` 里。猜错一次就要多读三个文件来纠正。

## 已知的真实坑（改前先看这里有没有）

- **e2e 曾跑完不退出**：成功路径没 `process.exit`，Host 子进程 stdio 管道吊住
  事件循环——所有 check 通过后仍挂几分钟，看起来像在干活。现已有显式退出 +
  看门狗（240s）+ 每请求 15s 超时，别拆。
- **假平台必须真校验**：`fake-platform.mjs` 的 token 端点要校验 PKCE（长度 +
  S256 匹配），`openSealed` 要读全 5 段 JWE。假平台不校验的每一环，
  都是 bug 直达用户的通道。
- **测试期望要对齐实现语义**：`parseTrend` 是对 points 求和，不是取首个。

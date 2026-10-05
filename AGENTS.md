# AGENTS.md — AI 会话纪律

给 AI 协作会话的第一站。不重复 `docs/` 的内容，只钉死：**怎么验证、什么红线、去哪查**。
每次会话先读本文件；细节按下面的文档地图跳。

## 项目一句话

DSH 插件：参考上游应用 `upstream/sensenova-usage-dashboard`，从商汤 SenseNova 控制台 API 读 Token Plan 额度，渲染到 Harness **Plugins 页的插件卡**（三个 tab：积分额度 / 接入 API / 小浣熊）。
Host（Node/cordis）走完整 OIDC+PKCE 登录并自续期；Client（React bundle）轮询本地路由。

**三条事实**（写代码前先认清你在动哪一条）：

1. 「积分额度」tab 是地基，走 Host 登录 + 自动续期，只读 OpenStack 控制台。
2. 「接入 API」tab 与出图工具会把本插件**升级为推理通道**——注册 provider `sensenova-token-plan`、给 agent 挂 `sensenova_draw_image`。它们都是 **opt-in 默认关**，任何失败必须降级为「面板照常用、该模块缺席」。
3. **「小浣熊」tab 是第二个上游**：接的是 `xiaohuanxiong.com` 网关的**独立 provider** `sensenova-raccoon`。它与 Token Plan **同属商汤旗下**，但**认证域互不相通**（桌面 App 登录态打不通 Token Plan，实测见 `docs/ROADMAP.md` §6.1.1）——所以它在 §5 不变量 3 的**界内**（裁定见 `docs/ARCHITECTURE.md` §5.5），而凭据仍必须各走一套。改这条线时它对主注册的影响应恒为零：两边 publisher、store、凭据引用全部隔离。

**定位变更（2026-09-29）**：从「只做额度信息、n 个插件分散行动」转向**大统一——商汤全过程集成的单点入口**（额度 + provider + 出图路由对接 + 429 自愈（退避/分诊，不做多 Key 池），逐块 opt-in 吸收）。边界与三条不变量见 `docs/ARCHITECTURE.md` §5，同类插件核实事实见 §5.3；吸收路线图见 docs/ROADMAP.md，设计决策研究档案见 docs/IMPROVEMENTS.md。

在web端、desktop搜索同类插件：`~/.dsh/profiles`

```
@mars-sea/dsh-commandcode-provider
非官方 Command Code 提供方：实时模型目录、多账号轮换、用量面板与套餐配额面板。

@eghrhegpe/dsh-connect-qoder
将本机已登录的 Qoder（国内版 Qoder CN / 国际版 Qoder）模型接入 DeepSeek Harness —— bring locally signed-in Qoder models into DeepSeek Harness with zero configuration.


dsh-connect-trae
把本机登录的 Trae 模型接入 DeepSeek Harness：国内版与国际版双供应商并行，提供用量/积分概览与每日签到领取。


dsh-connect-workbuddy
把本机登录的 WorkBuddy 模型接入 DeepSeek Harness，并提供只读的积分概览与模型管理。
```

## 验证（按域裁剪，禁止无脑全量）

```bash
node test/auth.test.mjs     # 登录/PKCE/JWE/节流分类
node test/store-baseline.test.mjs # token-store 全行为冻结基线：拆分/改动续期·节流·迁移前后必须零漂移
node test/panel.test.mjs    # 面板决策、中英字典一致性
node test/parsers.test.mjs  # 响应解析层：字符串数值/epoch、shape 漂移、trend 求和
node test/docs.test.mjs  # 文档一致性：内部链接、跨文件表格去重、README 行数上限、教学快照、API 契约
node test/e2e.mjs           # 端到端单独跑：拉起真 Host + 假平台，约 10 秒（需 dsh CLI）
npm test                    # 全量离线测试门禁 = node test/run-all.mjs（套件名册单一声源 test/suites.mjs；各自探到 typescript / tsdown / dsh CLI 才实跑，否则 SKIP）
npm run test:list           # 只列名册不执行
node test/run-all.mjs --only=<子串>   # 按域裁剪的正式形态（--skip=<子串> 反向；空选择直接红，绝不假装通过）
npm run build               # 改 src/（host 或 client）后必跑：重建 lib/ 与根 client.js；两者已**版本化入库**（不再 gitignore，理由见 .gitignore 注释 + 兄弟插件 dsh-connect-qoder 的 docs/issues/19：github: 安装源不跑 prepack，lib 不入库则 GitHub 直装坏）；提交源码时务必把产物一并提交，否则 CI 的 build-freshness 门禁会红
```

- **e2e 已在 `npm test` 门禁里**（经 `test/e2e-gate.mjs`），但只在这台机器装了 dsh CLI 时才真跑；
  CI 里它是独立硬门禁（2026-10-02 起：`ci.yml` 的 e2e job 也跑 `e2e-gate.mjs` 并去掉了
  `continue-on-error`——缺 dsh CLI 时它 SKIP 退出 0，有则真跑且红即拦）。手工排查用 `node test/e2e.mjs` 单跑即可。
- **e2e 只跑一次**。它要启动真实 Host 进程；需要看两段输出就跑一次落盘再读文件，
  不要把同一条命令串两遍。
- **peer 套件红 ≠ 回归（只对本机成立）**。`store/routes/wiring.test.mjs` 依赖
  `@deepseek-ai/dsh-credentials`（随 DSH runtime 发行，不在插件目录）。
  本机报 `cannot resolve the peer dependency` 是环境问题：查 `test/peer-roots.mjs`
  候选根（`$DSH_HOME` → 插件 `node_modules` → 桌面运行时 → npm 全局 CLI 运行时树）。
  **CI 不适用这条**：offline job 已装 CLI 供应运行时（`.github/workflows/ci.yml`），
  那里报同一句 = 真回归（2026-10-01 的 §30 事故：硬门禁红了一整天没人管）。
- 测试数会随并行会话变化（68/38 是某一时点快照），只看自己域的增减。
- **动了契约/接缝文件，跑全量，别按域裁剪**。`src/shared/*`、`client.js`、`lib/index.js`
  以及被多个模块消费的文件，消费者不可枚举——按域裁剪会漏掉跨域契约（实测：只给面板加一个
  渲染分支，draw/render/typecheck 全绿，全量才在 `panel.test.mjs` 的 table-driven tt 白名单上红）。
  判断标准：这个文件的消费者我数得清吗？数不清就全量。
- **全量现在是安全的，且能给出完整信号**（2026-10-05 起）。此前 `npm test` 是一条 `&&` 链：
  第二个套件（peer 依赖的 `store.test.mjs`）一红，后面 26 项**一次都没跑过**，而输出看起来
  只是一次普通的用例失败——这正是 PITFALLS §30 根因 2，那条 lesson 写了一年没修。现已换成
  `test/run-all.mjs`：跑完 30 项再汇总，失败项逐个点名，并附「N 项跑过并通过」。
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
   `invalid_grant`，hint 是唯一线索。`b64url` 对非 Uint8 视图已有补偿分支，别删。
5. **登录路径的每次尝试（成功也算）必须经 `onTrace` 落盘**。没有成功 trace，
   "浏览器能登、面板不能"就无法对照排查。
6. **密码必须走 JWE 封包**（平台 JWKS 公钥 RSA-OAEP + A256GCM），明文不上网；
   算法组合是平台钉死的，不是自由参数。

## 并行会话纪律

工作树常同时有**他人未提交改动**（多会话并行开发是常态）：

- **不碰 `git stash / push / pop`**（`list`/`show` 只读可用）。
- 路径限定提交，比如：`git commit -m "<说明>" -- <自己的文件…>`，
  禁 `git add -u` / `git add -A` 全量卷入。
- 提交后 `git status --short` 复核：没带走别人的东西。
- 看到非自己改动的文件处于 modified，**不要**替它做对照实验（stash 出基线），
  用 targeted 复跑（改前后各跑一次同一小组文件）定性。
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
  改过 `src/` 后 `npm run build` 的产物正好踩这条——tsdown 生成的 chunk 文件名带内容
  hash，于是「旧 chunk 被删、新 chunk 是 untracked」：`-- src lib` 只带上了已跟踪的
  `lib/index.js`，结果它引用磁盘上不存在的分块，而**GitHub 直装源不跑 prepack，装到就坏**。
  改 `src/` 的提交里，产物目录要先 `git add <产物目录>` 再 `git commit`（不带路径），
  或分两次提交（第二次专门补产物，提交信息写明是补漏）。
  复核姿势：`git status --short` 应为空；再 `git ls-files <产物目录>` 数一遍文件数，
  对得上构建输出才对。

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
| 改任何代码前扫一眼 | `docs/PITFALLS.md`（38 条现象→根因→修法） |
| **改文件时工具「什么都没做」**（`replace` 不匹配、`Edit` 反复失败、多半是行尾）| `docs/PITFALLS.md` §38（40 CRLF / 86 LF / 1 混合；**先量行尾再写锚点**，`replace` 后必须断言变化） |
| 排查「这条配置到底生效没」 / 改了源码却没变 | `docs/PITFALLS.md` §22（bundles 装载 → patch overlay → `$DSH_HOME/state/<profile>/<name>/` 三层，desktop 是安装副本、web 是 symlink） |
| 加/改 **state 文件**、读 `profileContext`、判断某状态该不该按 profile 分段 | `docs/PITFALLS.md` §23（catalog/provider/draw 分段；throttle 与凭据 grant **故意共享**，别统一） |
| 提交约定、`upstream/` 红线 | `docs/CONTRIBUTING.md` |
| 发版 / 补发（tag・`main`・npm・Release 四条独立通道） | `RELEASING.md`（状态表 S0–S4 **含 S2′ 顺序颠倒**、§4.5 推荐顺序、§5.5 发布内容一致性核验） |

## 进入代码库的读取顺序（AI 会话）

约 2 万行 src + 1.7 万行测试，乱序读会把时间花在「重新验证文档已写明的事实」上。
这条顺序是 2026-10-02 全库审查后的复盘：先建坐标系，再读代码。

1. **先文档，后代码**：本文件 → `docs/README.md` 索引 → `docs/ARCHITECTURE.md` §5
   （三条不变量 + §5.5 双上游裁定）→ `docs/PITFALLS.md` 38 条扫一遍。这些是判断
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
   `name` 本身就是契约，1.7 万行测试是规格，不是附件。
8. **验证闭环**：改完跑对应域单测（`node test/<域>.test.mjs`）→ 全量 `npm test`
   （= `node test/run-all.mjs`：跑完 26 套件 + 4 门禁共 30 项再汇总，失败项逐个点名；
   「末尾绿」「按链序定位」都是旧 `&&` 链的读法，别再用）。

## 已知的真实坑（改前先看这里有没有）

- **e2e 曾跑完不退出**：成功路径没 `process.exit`，Host 子进程 stdio 管道吊住
  事件循环——所有 check 通过后仍挂几分钟，看起来像在干活。现已有显式退出 +
  看门狗（240s）+ 每请求 15s 超时，别拆。
- **假平台必须真校验**：`fake-platform.mjs` 的 token 端点要校验 PKCE（长度 +
  S256 匹配），`openSealed` 要读全 5 段 JWE。假平台不校验的每一环，
  都是 bug 直达用户的通道。
- **测试期望要对齐实现语义**：`parseTrend` 是对 points 求和，不是取首个。

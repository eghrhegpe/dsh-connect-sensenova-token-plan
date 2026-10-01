# 贡献约定（Contributing）

面向在本仓库提交改动的人。原则：Host 半边改动代价高、登录失败会锁号、凭据绝不能进版本库。

---

## 1. 提交信息风格

沿用现有历史的中文 `type:` 前缀：

- `feat:` 新能力
- `fix:` 修复
- 正文用中文说明「为什么」，而非「改了什么」（diff 自明）。

例：`fix: 被拒的登录不再自动重试，避免错密码把账号锁死`

---

## 2. 改动 Host 半边必须重启

Host 半边源码位于 `src/host/`（**清单以该目录为准**，不在本文件逐一枚举——本仓已有「套件数/模块清单只指事实源、不复制数字」的纪律，见 [CHANGELOG](../CHANGELOG.md) 0.4.3「文档与仓库纪律」），经 `npm run build` 构建为 `lib/index.js` 后在 Host 启动时加载一次，**改完须完全退出 DSH（含托盘）再启动**（重新构建产物）。只改 `src/client/*.ts` 时跑 `npm run build:client` 重建根 `client.js`、浏览器刷新即可。提交前用 [SETUP.md](./SETUP.md) §4 的自查确认跑的是新代码。

---

## 3. 测试先行

- 改动登录 / 续期 / 节流 / 路由 / 面板决策后，跑 `npm test`。
- 新增登录分支（新的拒绝类型、新的窗口读取）必须补 `auth.test.mjs` 或 `store.test.mjs`。
- 面板渲染决策改动后，`panel.test.mjs` 应同步（它通过 `client-surface.js` 把 `client.js` 作为模块加载、直接调用工厂物化出的 `panel` 测试面，不需手写副本，也没有字符串锚点）。若 `client.js` 的工厂不再导出 `panel` 测试面或改动了结构，`client-surface.js` 会**直接抛错**——更新它，别退回抠源码。
- 网络层一律打桩，密码用临时密钥，**绝不发往商汤**，也不依赖真实账号。

---

## 4. 红线：什么绝不进版本库

- **凭据**：`.env`、`.env.*`、`*.env` 已被忽略；账号密码、access/refresh token 只经 DSH 凭据服务，不写文件、不写日志。
- **`upstream/`**：已被 `.gitignore` 忽略。它是独立 git 仓库（[shaobingtongzhi/sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard)；本地副本按独立 `.git` 容纳，丢失时用 `git clone` 该地址恢复，见 [ARCHITECTURE.md](./ARCHITECTURE.md) §1），容纳进本仓库只为本地对照，**不要 `git add upstream/`**，也不要把它的 `accounts.json` 等带进来。
- **运行时产物**：`*.log`、`logs/`、`tmp/`、`node_modules/`、`dist/`、`build/` 已忽略。
- **DSH 内部抽取物**：本仓库曾误把 `_asar_extract/`（Host 打包产物）提交进历史，应将其从跟踪中移除（见下方 §6），且不再 add。

---

## 5. 文档同步

逻辑改动若影响以下内容，同步更新 `docs/`：

- 路由 / 配置字段变化 → `API.md` / `SETUP.md`
- 登录 / 续期 / 节流变化 → `AUTH.md` / `SENSENOVA-API.md`
- 结构或双仓库关系变化 → `ARCHITECTURE.md` / `DSH-PLUGIN.md`
- 测试套件或流程变化 → `TESTING.md`
- 新踩坑或修法 → `PITFALLS.md`

根 `README.md` 保持为索引与快速上手，细节下沉到 `docs/`。

---

## 6. 仓库整洁（历史遗留清理）

本仓库曾把 DSH 的 `_asar_extract/`（asar 解包出的 Host 内部文件）误纳入 git 跟踪。这些不是本插件源码，且随版本变化会制造巨大 diff。建议将其从索引中移除（保留工作区文件、不再跟踪）：

```powershell
git rm -r --cached _asar_extract
# 然后确认 .gitignore 已忽略（或在 .gitignore 追加 _asar_extract/）
git commit -m "chore: stop tracking DSH internal _asar_extract dump"
```

> 此项属仓库整理，按需进行；与本插件功能无关。

---

## 7. 已知取舍

- **API key 的持久化与跨进程**
  `index.ts` 的 `resolveApiKey()` 已优先走 `ctx.credentials.resolve("SENSENOVA_API_KEY")`、回退 `process.env`，
  与账号/密码腿（走 `ctx.credentials.modifyRecord`、kind=grant、跨重启、跨进程）的不对称已收口——
  凭据服务里的 key 与 env 里的 key 都能被读到。仍不对称的部分：API key 无写路径（不通过本插件修改），
  所以不给 `token-store.ts` 加 `modifyRecord`；`fetchModelCatalog` 只接字符串参数，不关心供方是谁。
  读 key 必须每次轮询时调用（凭据服务可能晚于插件挂载注册），不能在 `apply` 开头缓存。

---

## 8. 投稿 awesome-dsh-plugin 列表（插件市场收录）

投稿指南（唯一权威，改规则以它为准）：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>

**不要看错仓库**：投稿是向 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR，加且仅加一个文件
`data/plugins/eghrhegpe__dsh-connect-sensenova-token-plan.yml`；不要手工编辑对方仓库生成出来的
README，也不要把条目文件建在本仓库。一个 PR 最多 3 条。

本插件的拟稿（描述只能陈述功能、不带营销词，每句都会被对照代码核对）：

```yaml
url: https://github.com/eghrhegpe/dsh-connect-sensenova-token-plan
name: eghrhegpe/dsh-connect-sensenova-token-plan
category: usage
description:
  en: 'SenseNova Token Plan credit panel rendered as a config card on the Harness Plugins page: per-pool quota windows (5h and weekly), grant balance and per-model consumption from the SenseNova console API, with in-panel login and automatic token renewal. Three opt-in switches, off by default, register SenseNova models and the Xiaohuanxiong upstream as LLM providers and expose an image-generation tool to the agent.'
  zh: '在 Harness 的 Plugins 页以插件卡显示商汤 SenseNova 控制台的 Token Plan 积分用量：各积分池额度窗口（5 小时与每周）、返赠余额与每模型消耗，支持面板内登录与令牌自动续期。另有三个默认关闭的可选开关，用于把商汤模型与小浣熊上游注册为 DSH 提供方，并向 agent 暴露出图工具。'
```

含 `: ` 的描述必须加引号，否则 YAML 解析失败；`en` 必填且以句号结尾，`zh` 可选。

**截图（`screenshots.json`）必须与当前 UI 一致**——它是市场页的第一屏，比描述更先被看到，却也是最容易在 UI 迁移后烂掉的东西：

- **当前 2 张已重截**（2026-10-01，0.4.3 面板归位之后）：`assets/panel-credit.png`（「积分额度」tab：池卡 + 每模型消耗）、`assets/panel-API-provider.png`（「接入 API」tab：语言模型开关 + 花名册勾选）。旧两张 `panel-credit-pools.png` / `panel-provider-setup.png` 拍于归位之前（标题还是「积分面板」、右上角挂着已摘掉的「返回会话」按钮、无 tab bar、模型行带已删的「纯文本」徽章），已删除。
- 重截条目与 tab 覆盖同理，**每张必须对应一个真实 tab**；仍缺第 ③ 张「小浣熊」= 扫码登录 / 余额 / 花名册。
- **清单与资产必须同一次提交**（2026-10-01 实测事故）：重截换名那次 `assets/` 与 git 都已换成新名，唯独 `screenshots.json` 还指着两个已不存在的文件——工作树干净、构建通过、其余十条检查全绿，**没有任何东西在报错**，而市场按这份清单取图，推上去就是图裂。现由 `docs.test.mjs` 检查 11 兜住：每条路径必须真实存在、是图片扩展名、1–8 张、且为仓库根相对路径。
- **不要凭想象补图**——画一个不存在的界面比没有图更坏，本插件的市场描述是「每句都会被对照代码核对」。

投稿前的硬门槛（CI 自动检查 + 维护者人工读码）：

- `package.json` 已声明 `dsh.bundle` 且根目录有 `cordis.patch.yml`——已满足（只声明 `dsh.client` 会被拒）；
- 官方 `@deepseek-ai/*` 包走 `peerDependencies`——已满足；
- GitHub 仓库需打 `dsh-plugin` topic——已满足（2026-09-28 补上）；
- 仓库创建满 24 小时（CI 按 GitHub `created_at` 自动卡）；本仓 2026-09-28T05:03:11Z 建仓；
- 真实可用代码、非占位——已满足；仓库需公开且处于活跃维护。

已发布 npm 包 `dsh-connect-sensenova-token-plan`（**0.4.5 于 2026-10-01 发布**；2026-09-28 首发 0.2.0；
0.4.1 与 0.4.2 打了 git tag 但**未发布到 npm**，其内容随 **0.4.3** 一并发布。`repository` 指回本仓，列表会
自动按下载量关联，yml 里无需任何 npm 字段）。注意本机默认 registry 是 npmmirror 镜像，登录与发布都
必须显式带 `--registry=https://registry.npmjs.org`；发新版前先在 package.json 升版本号（已发布版本
不可覆盖）。**完整发布清单见根目录 [RELEASING.md](../RELEASING.md)**——尤其第 6 步 GitHub Release
没有任何自动化，漏掉时不会有任何东西报错。

> **已发布 ⇒ tag 不可移**（2026-10-01 实测，别踩）：`v0.4.3` 已同时存在于 npm 与 GitHub Release，
> 因此**不能**按 RELEASING §4 的告警去「删除并强制移动 tag」来补齐后来的提交——那会让 npm 上的
> 0.4.3 与 tag 内容不符。`v0.4.3` 之后落地的改动（e2e 进程树修复、`.gitignore`、
> 以及自述面文档追平）**只能随下一个版本（0.4.4）到达用户**——该版本已于 2026-10-01 发布，上述改动随即到达用户。
>
> **实测证据（同一条命令、发版前后两个读数）**：
> `npm view dsh-connect-sensenova-token-plan readme --registry=https://registry.npmjs.org`
> 在 **0.4.4 发布前**抓下来，旧版（0.4.3）README 含 3 处「侧边栏」、0 处「小浣熊」——那正是用户当时读到的内容；
> **发布后**再抓为 1 处、4 处，且与仓库 `README.md` **逐字相同**。剩下的那 1 处是刻意写的否定句
> （「面板是页内的内联卡片，**不在侧边栏**」），不是残留。**修好的 README 在发新版前对用户不存在**；
> 这条命令是唯一能证实「用户此刻读到的到底是哪一版」的手段。

**市场收录状态（2026-10-01 实测）**：投稿 PR 已提且**仍处于 open、未合并**——
[awesome-dsh-plugin#6139](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6139)
（2026-09-29 提交，`merged_at: null`，0 评论）；`data/plugins/` 目录下尚无
`eghrhegpe__dsh-connect-sensenova-token-plan.yml`，与实际一致。**该 PR 的正文与条目文件已于 2026-10-01 更新**（原先两处都停在旧形态）：原文写的是 "for the Harness Web sidebar"，原文引用 yml 里的 "sidebar panel" 与「侧边栏面板」；两处现都改为 Plugins 页的配置卡，并补上三个默认关闭的可选开关（provider 注册 / 出图工具 / 第二上游）。**原文其实提过 provider 注册**——但只提了它一个，且未提第二上游（此前本节误写为「未提 provider 注册」，2026-10-01 读到 PR 原文后更正）。**yml 才是市场条目的实际描述**：只改正文不改 yml，是另一种「分头走路」。收录后市场按 `screenshots.json` 取图，动图只需更新清单与资产（**改名就必须同步清单**，见检查 11 与 PITFALLS §26）。

**更新一个已投稿的条目**（2026-10-01 实操，两处都要改）：条目文件在 **PR 的 head fork** 上（`eghrhegpe/awesome-dsh-plugin`，分支 `add-sensenova-token-plan`），既不在本仓、也不在 base 仓。

```bash
# 1) 条目文件本身——市场条目的实际描述由它决定
SHA=$(gh api "repos/eghrhegpe/awesome-dsh-plugin/contents/data/plugins/eghrhegpe__dsh-connect-sensenova-token-plan.yml?ref=add-sensenova-token-plan" --jq .sha)
#    请求体 {message, content: <新内容的 base64>, sha: $SHA, branch: "add-sensenova-token-plan"}
gh api repos/eghrhegpe/awesome-dsh-plugin/contents/data/plugins/eghrhegpe__dsh-connect-sensenova-token-plan.yml \
  --method PUT --input <body.json>
# 2) PR 正文——人读的说明，用 --body-file 避免 shell 转义踩坑
gh pr edit 6139 -R awesome-dsh-plugin/awesome-dsh-plugin --body-file <body.md>
```

两个坑：① 访问该 PR **必须带 `-R awesome-dsh-plugin/awesome-dsh-plugin`**，否则 `gh pr view 6139` 会按本仓的 PR 号去解析，直接报 `Could not resolve to a PullRequest`；② `gh pr edit` 会改 PR 的更新时间（在按更新时间排序的队列里位置会变），但不会引入 review，属可接受代价。

其余可选增强：根目录放 `screenshots.json` 声明 1–8 张截图；或在 GitHub Release 挂版本无关文件名的
`.tgz`（yml 的 `tarball:` 字段）。本仓可从源码安装，tarball 不需要。

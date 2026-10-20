# 贡献约定（Contributing）

面向在本仓库提交改动的人。原则：Host 半边改动代价高、登录失败会锁号、凭据绝不能进版本库。

---

## 1. 提交信息风格

沿用现有历史的中文 `type:` 前缀：

- `feat:` 新能力
- `fix:` 修复
- 正文用中文说明「为什么」，而非「改了什么」（diff 自明）。

例：`fix: 被拒的登录不再自动重试，避免错密码把账号锁死`

> **提交信息底线（零依赖门禁）**：`npm run commit:lint` 检查最近一条提交，CI 检查 `origin/main..HEAD` 内的新提交。硬性要求：必须有 `type:` 前缀（`feat`/`fix`/`docs`/`test`/`chore`/`style`/`refactor`/`perf`/`build`/`ci`，可选 `type(scope):`）；主题不能是裸文件名；不得含反斜杠（Windows 路径串入）；前缀后至少几个实义字。正文「为什么」靠自觉，机器不查。`test\raccoon.test.mjs`、`小浣熊样式美化` 这类就是被这条挡下的典型。

---

## 2. 改动 Host 半边必须重启

Host 半边源码位于 `src/host/`（**清单以该目录为准**，不在本文件逐一枚举——本仓已有「套件数/模块清单只指事实源、不复制数字」的纪律，见 [CHANGELOG](../CHANGELOG.md) 0.4.3「文档与仓库纪律」），经 `npm run build` 构建为 `lib/index.js` 后在 Host 启动时加载一次，**改完须完全退出 DSH（含托盘）再启动**（重新构建产物）。只改 `src/client/*.ts` 时跑 `npm run build:client`（与 `build` 同一命令串：tsdown 一次全建 host + client，产物原地重写）重建根 `client.js`、浏览器刷新即可。提交前用 [SETUP.md](./SETUP.md) §4 的自查确认跑的是新代码。

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

规则只认上游原文，本仓副本在 `awesome-dsh-plugin-submission/contributing.md`——**别在这里转述规则**，转述就会漂移（本节此前那一大段门槛清单、引号规则、截图要求都是这么烂掉的）。

本仓只有三件事实：

- 条目文件：`awesome-dsh-plugin-submission/eghrhegpe__dsh-connect-sensenova-token-plan.yml`，提 PR 时原样复制到对方仓库的 `data/plugins/` 下。**不要在这里再维护第二份 yaml**，两处一定会漂移。
- `category: usage`。
- 已收录：PR [#6139](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6139)，2026-10-12 合并。之后代码继续演进，条目文案是否同步是人的判断，不写进文档当现状——要看当前状态就用 `gh` 查，别读文档。

## 9. 编辑器约定（.editorconfig）

仓库根有 `.editorconfig`，它的判据是**零字节改动**：只写与磁盘现状一致的键。因此它不会替你
把 CRLF 转成 LF、不会删行尾空白、也不会补末尾换行——markdown 的行尾双空格是硬换行，补末尾
换行会给一批文件制造纯格式 diff。缩进按本仓风格取 2 空格；`lib/**`、根 `client.js`、
`assets/**`、`upstream/**` 是产物与参照件，排除在缩进约定外。

行尾归一化由 `.gitattributes`（`* text=auto eol=lf`）负责，不在 editorconfig 的职责内。
改完文件别顺手「格式化全仓」：那是噪声 diff，还可能把并行会话里别人的改动一起卷进来。

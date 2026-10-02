# 发布流程（Release Flow）

> 本文档是 `dsh-connect-sensenova-token-plan` 的**唯一权威发布流程**。发布前请通读一遍。
>
> **先讲清两个常见误解——它们都属于「以为会自动完成」**：
>
> **① 本仓库没有 release 自动化**。`.github/workflows/` 里只有 `ci.yml`（跑测试）；
> 你在 GitHub Releases 页面看到的「更新日记框」是**手动** `gh release create` 出来的，CI 不会、npm 成功也不会自动建。
> 这正是历史上最容易漏的一步：它对 CI / 测试 / 安装**都没有任何影响**，漏掉时没有任何东西报错，只能靠「发布清单里写着」来保证。
>
> **② 「npm 发出去就算发完了」也不成立**。npm 只是四条通道里的一条——**tag、`main`、npm、GitHub Release 是四个独立事实**，任一先发生都不会带上其余三个。`v0.4.7` 就出现过「`npm view` 已经能查到新版本，而 tag、`main` 上的版本提交、Release 全都不存在」的顺序颠倒。它能被安全收口，只因为在补 tag 之前先做了**内容一致性核验**（§5.5）——顺序颠倒本身不会报错，只能靠状态表认出来。

## 0. 先给 AI / 操作者一个清晰目的

这份文档的目标不是“把六步一字不差念一遍”，而是让操作者在**任意时刻**都能回答三个问题：

1. **我现在卡在发版链的哪一环？**
2. **还缺哪些环节才算完整发布？**
3. **哪些动作可以补，哪些动作不可逆？**

所以使用方式是：

- **新发版**：按第 1 → 6 步做。
- **断点续发**：先跳到「发版状态判定表」，确认当前状态，再只补缺的那几步。
- **已发生 tag / npm / Release 任一动作**：先看「不可逆点」，再决定能不能修、如何修。

## 1. 发版状态判定表（先判断，再动手）

先把下面这几组命令跑一遍，把当前状态定位到某一个格子。定位错了，后面的顺序会全错。**顺序颠倒不是假设**：`v0.4.7` 就是「npm 已发、tag/main/Release 全缺」，它不在旧的 S0–S4 里，所以下表补了 **S2′**。

```bash
# A. 仓库侧：tag 是否存在、指向哪里
git tag -l vX.Y.Z
git rev-list -n1 vX.Y.Z          # tag 指向的 commit

# B. 仓库侧：main 是否已推、有没有没推的发布提交
git status -sb                    # 看 `ahead N`：版本提交是否还躺在本地
git log --oneline -5
git log --oneline @{u}..HEAD      # 有输出 = 那些就是没推的提交（v0.4.7 卡在这）

# C. 版本侧：package.json / CHANGELOG 是否已落到目标版本
grep '"version"' package.json
head -n 40 CHANGELOG.md

# D. npm 侧：latest 是不是目标版本
npm view dsh-connect-sensenova-token-plan version --registry=https://registry.npmjs.org

# D2. npm 侧：目标版本是否已被占用（不可逆点第 1 条的判据）
npm view dsh-connect-sensenova-token-plan@X.Y.Z version --registry=https://registry.npmjs.org

# E. GitHub 侧：是否已建 Release
gh release view vX.Y.Z --json name,tagName,isDraft,isPrerelease,assets
```

按下表判断：

| 状态 | 特征 | 还缺什么 | 下一步 |
|---|---|---|---|
| S0 未开始 | 无 tag、npm 还是旧版、无 Release | 全流程 | 从第 1 步走完整链路 |
| S1 代码已进 main | 修复已提交、已 push；`package.json` 尚未升版 | 版本文件、tag、npm、Release | 先补齐 2/3/4，再走 5/6 |
| S2 已 tag | 有 tag、main 已推；npm 未发 | npm、Release | 走 5、6 |
| **S2′ 顺序颠倒：已 npm、未 tag** | `npm view <包>@X.Y.Z` 能查到；`git tag -l vX.Y.Z` 为空（`main` 上的版本提交也可能还没推） | tag、main、Release | **先做 §5.5 内容核验**，再把 tag 指到「被核验过的那个提交」（不是当时的 `HEAD`），然后走 4 的推送与 6；**不要重新 publish** |
| S3 已 npm | 有 tag、npm 已发；无 Release | Release | 只走 6 |
| S4 完整 | tag、main、npm、Release 都有 | 无 | 做最终核对即可 |

**本仓库典型真实状态**（都是实际发生过的）：

- **S1**：出图修复先进库，`package.json` / `CHANGELOG` 后才追平（0.4.5）
- **S3**：npm 已发到 0.4.5，但 GitHub Release 还没建
- **S2′**：npm 先发了 0.4.7，tag / `main` 上的版本提交 / Release 三者全缺——顺序颠倒不会自己报错，只能靠这张表认出来

这说明：**“tag 已推”或“npm 已发”都不等于发版完成**，必须按 S0–S4（含 S2′）判状态，而不是凭感觉。

## 2. 不可逆点（先记住这四条）

在动手前，先把这四条钉死，避免走到一半才发现只能发新版本：

1. **npm 已发布 ⇒ 该版本号不可覆盖**
   - 目标版本若已在 npm 列表里，不能把 tag 移回去假装“补上一版”。
   - 正确动作是开下一个 `X.Y.(Z+1)`。
2. **GitHub Release 已建 ⇒ tag 基本钉死**
   - 尤其当该 Release 与 npm 版本已同时存在时，移动 tag 会让“用户装到的内容”与“Release 指向的内容”分叉。
3. **`--verify-tag` 漏掉 ⇒ 可能悄悄新建 tag**
   - 若 tag 不存在，`gh release create` 会把 tag 指向当前 HEAD。
   - 所以补 Release 时务必先确认 tag 已存在，再建。
4. **先 publish、后打 tag ⇒ 「tag 该指哪个提交」从显然变成需要取证**
   - 发布动作先发生、`git tag` 还没建，于是当时的 `HEAD` 未必就是被 publish 的那份内容（本地可能有未推的提交、或事后又落了别的提交）。
   - 这不是灾难，但**取证责任转移到了你身上**：补 tag 前必须按 §5.5 证明「npm 上那一版 == 某个提交的构建产物」，再把 tag 指向那个提交、并同步推 `main`。
   - 正序（4 → 5 → 6）时这件事是免费的：tag 在 publish 之前就定好了，谁也不用事后推断。

判断某个 tag 是否还能动，用下面两条：

```bash
npm view dsh-connect-sensenova-token-plan versions --registry=https://registry.npmjs.org
gh release view vX.Y.Z --json tagName
```

只要任一已发生（版本在列 / Release 已存在），**不要移 tag，只发下一版**。

## 前置条件

- `gh` 已登录且带 `repo` 权限：`gh auth status` 应显示 `Logged in to github.com account eghrhegpe`、scope 含 `repo`。
- npm 已登录，且**必须显式指向 npmjs**：本机默认 registry 是 npmmirror 镜像，登录与发布都要带 `--registry=https://registry.npmjs.org`（见 `docs/CONTRIBUTING.md` §8）。
  - **这条要当 preflight 查，而不是当背景知识**：`npm whoami --registry=https://registry.npmjs.org` 返回 `E401 Unauthorized` 就是没登录。此时 `npm publish` 会**先跑完 `prepack` 构建再失败**——白等一轮，且失败信息看起来像构建问题。补救只有一条命令：`npm login --registry=https://registry.npmjs.org`（交互式、需要凭据，AI 不要代做）。
  - **不带 `--registry` 的 `npm whoami` 会骗人**：它可能显示「已登录」，但那是镜像账号，与能否 publish 无关。判断发布能力一律带 `--registry`。
- 仓库：`https://github.com/eghrhegpe/dsh-connect-sensenova-token-plan`（默认分支 `main`）。
- 本地 `main` 与远端同步，且**工作树处于干净、可发布状态**（见下方「并行会话纪律」）。

## 每次发布的完整步骤

### 1. 确认测试与代码

```bash
npm test        # 全量离线门禁 + 末尾 build-gate + e2e-gate（套件清单与链以 package.json scripts.test 为准，不在本文件背书数字；探到 dsh CLI 才实跑 e2e）
```

> 并行开发是常态：改哪个域就先跑哪个域（如 `node test/panel.test.mjs`），全量留给 pre-push。
> 不要为了「确认」连续跑全量 `npm test`——会把本机卡死。

### 1.5 并行会话纪律（发布前必看）

工作树常同时有**他人未提交改动**。发布提交只收**自己本轮**的文件，**禁止 `git add -A` / `git add -u`**：

```bash
git add package.json CHANGELOG.md        # 只收版本号 + 更新日志
git commit -m "chore: 版本升级至 X.Y.Z"
```

- 不要 `git stash / push / pop` 去腾「干净基线」——会把别人的未提交改动一并卷走。
- 提交后 `git status --short` 复核：没带走别人的东西。
- **发布必须从「完全提交」的状态切出版本**。若工作树里还躺着属于本版的改动（如 `client.js`、文档），先让它们各自落地，再走下面的流程——否则 tag 指向的提交里会缺这些文件。
- **现实变体：修复已先入库，版本文件要随后追平**：如果功能 / 修复代码已经随并行会话提交到 `main`，而 `package.json` / `CHANGELOG.md` 还没跟上，**不要试图把 tag 指回某个旧提交**。正确做法是开下一个版本（`X.Y.(Z+1)`），先把版本与日志补齐，再打 tag；这样「用户装到的内容」与「GitHub tag 指向的内容」才是同一份。`v0.4.5` 的出图请求体对齐修复就是这条路径的实例。

### 2. 更新版本号

手动改 `package.json` 的 `version` 字段（语义化版本 `X.Y.Z`）。

> 后续步骤以目标版本号 `X.Y.Z` 指代。

### 3. 更新 CHANGELOG.md

把顶部 `## [Unreleased]` 下的条目搬进新的一节，按本仓库既有格式：

```markdown
## [X.Y.Z] — YYYY-MM-DD

<本版主线，一到两段；有两条主线就点名。>

- **<主题>**：<具体改动与用户可感知的影响>。
```

- **不要改 changelog 的写法风格**——本项目用 `## [X.Y.Z] — 日期` + 主题化要点，与 workbuddy 的 `Features/Fixes/Docs` 分组不同，二者都合法，沿用本项目即可。
- `CHANGELOG.md` 记**逐条变更**；GitHub Release 正文（第 6 步）是**可独立阅读的发布公告**，两者不是同一份文本（见下）。

### 4. 提交并打 git tag

```bash
git add package.json CHANGELOG.md
git commit -m "chore: 版本升级至 X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z: <一句话说明>"
git push origin main
git push origin vX.Y.Z
```

> ⚠️ **tag 必须指向包含本次代码的提交**。若目标 tag 已存在且指向旧提交，修正后用 `git rev-list -n1 vX.Y.Z` 确认指向当前 HEAD。
>
> **但「删除并强制移动 tag」只在两个前提下合法**：① 该版本**尚未** `npm publish`；② 尚未创建 GitHub Release。
> 只要二者之一已经发生（例如 `v0.4.3` 于 2026-09-30 同时上了 npm 与 Release），tag 就**钉死**了——
> 移动它会让 npm 上那一版的内容与 tag 所指不符，而 npm 又不可覆盖。此时**唯一正解是发新版本**，
> 让后来的提交随 `X.Y.(Z+1)` 到达用户。判断方法：
>
> ```bash
> npm view <pkg> versions --registry=https://registry.npmjs.org   # 目标版本已在列？→ 不可移
> gh release view vX.Y.Z --json tagName                           # 已存在？→ 不可移
> ```
>
> 这里的 `-m` 用**冒号**（`vX.Y.Z: <一句话>`），第 6 步 Release 的 `--title` 用**破折号**（`vX.Y.Z — <一句话>`）——两者措辞可以不同，但都必须是同一件事的一句话说明。**打完 tag 别忘了第 6 步。**

### 4.5 推荐顺序：先推 main、等 CI 绿、再 tag + publish

正序是「提交 → tag → 推 main → 推 tag → publish → Release」。把它挪成下面这样，多花约 50 秒，换来两件事：**tag 不会指向一个 CI 红的提交**，且发布内容与 `main` 天然对齐。

```bash
git push origin main
gh run watch "$(gh run list --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
git tag -a vX.Y.Z -m "vX.Y.Z: <一句话说明>"
git push origin vX.Y.Z
npm publish --registry=https://registry.npmjs.org
```

- **为什么要等**：CI 在**发布提交**上绿，才算「发出去的这一版被真验过」。本仓库刚经历过门禁连续一整天恒红（`docs/PITFALLS.md` §30）——恒红的门禁与没有门禁等价，绿的那一次才有信息量。
- `gh run watch --exit-status` 失败时返回非零，可以直接当门禁用；跑完再 tag，就不存在「tag 指向 CI 红的提交」。
- **CI 红了怎么办**：该版本**尚未 publish** 时移动 tag 合法（第 2 节的前提）——修完再 tag；**已经 publish** 就只补 tag/Release（S3 / S2′），把红当成下一版的输入，不要试图覆盖已发版本。
- 不想等也可以：正序（4 → 5 → 6）本身就是合法路径，只是少一道确认。

### 5. 发布到 npm

> 本插件经 npm 分发（DSH 插件页从 npm 拉取 `dsh-connect-sensenova-token-plan`），**npm 发布是发版的必走步骤**，不是可选项。GitHub Release（第 6 步）与 npm 包是两条独立通道，任一成功都不会自动触发另一条。

```bash
# 本机默认 registry 是 npmmirror 镜像，发布必须显式指向 npmjs，否则发到镜像或读缓存旧版
npm publish --registry=https://registry.npmjs.org

# 验证（必须带同样的 --registry，否则读到的是镜像缓存的旧版）
npm view dsh-connect-sensenova-token-plan version --registry=https://registry.npmjs.org
# 应显示 X.Y.Z，且与第 2 步 package.json 升的版本一致
```

- **已发布版本不可覆盖**：发新版前必须在第 2 步先升 `package.json` 的 `version`，再 `npm publish`；直接对已有版本号发布会报错。
- `package.json` 的 `files` 字段已限定发布内容，测试与 `node_modules/` 不会进包。
- 发布前可用 `npm pack --dry-run` 预览 tarball 内容。
- **（可选，与发版解耦）收录到插件市场**：向 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR 增加 `data/plugins/eghrhegpe__dsh-connect-sensenova-token-plan.yml`（描述只能陈述功能、不带营销词），详情见 `docs/CONTRIBUTING.md` §8。列表会按下载量自动关联本仓库，yml 里无需任何 npm 字段。
- **断点续发：npm 已成功但会话中断 / 忘了下一步**
  - 先回读第 1 节判定表，确认当前是 **S3**（有 tag、npm 已发、无 Release）。
  - 此时不要再重跑 `npm publish`；唯一缺口是第 6 步。
  - 先 `gh release view vX.Y.Z --json tagName` 确认“没建过”，再补建。
  - 这样能把“以为发完了”的错觉，收敛成一条明确的状态判断。

### 5.5 发布内容一致性核验（正序 / 补发都要做）

目的只有一个：**证明「用户装到的内容」与「tag 指向的提交」是同一份东西**。发布顺序一旦颠倒（S2′），这一步是补 tag 的**前置条件**；正序时它是收尾证据——两者都别省。

```bash
# 1) 把已发布的那一版拉下来。包名带 @版本，才会从 registry 取；不带版本会打包本地目录！
npm pack dsh-connect-sensenova-token-plan@X.Y.Z --registry=https://registry.npmjs.org --pack-destination tmp
tar -xzf tmp/dsh-connect-sensenova-token-plan-X.Y.Z.tgz -C tmp

# 2) 与本机（= 候选 tag 提交的构建产物）逐文件比 SHA256
```

判据与 `v0.4.7` 的实测记录：

| 检查 | 为什么是这条 | 0.4.7 结果 |
|---|---|---|
| 全部文件 SHA256 一致 | 「同一份内容」的唯一硬证据；文件数相同只是必要条件 | 18/18 一致 |
| `client.js` 与 `lib/index.js` 单独比 | 这两份才是真正跑起来的代码（Client bundle / Host bundle） | 均相同 |
| 包内含本版**新增的用户可见字符串** | 证明构建来自本版源码，而不是缓存或旧产物 | `client.js` 含 `raccoon.loginTimeout` |
| 包内 `CHANGELOG.md` 含本版节 | 证明版本文件同步进了包 | 含 `## [0.4.7]` |
| 包内 `package.json.version` == 目标版本 | 最低限度 | `0.4.7` |

- Windows/PowerShell 下比对前把路径分隔符统一（`lib\` 与 `lib/` 会让「文件清单不一致」这种假差异冒出来）。
- **解包到 `tmp/` 是安全的**：它是 gitignored 的 scratch 目录，`test/docs.test.mjs` 的文档扫描已显式跳过它（否则包内 README 那些相对 `docs/*.md` 的链接会在这里变成假红——这条踩过，见该文件 `collectMd` 的注释）。
- 只想查一条最便宜的：确认包里有**本版新加的那句用户可见文案**——它能同时证伪「构建用了旧产物」和「发的是上一版」。

> **不做这一步会怎样**：不会有任何东西报错。用户装到的是一份、GitHub 上 tag 指的是另一份，两者在下次有人对比之前一直「看起来都对」——与 `docs/PITFALLS.md` §25「形式门禁全绿，不代表文档说了实话」是同一类失效。

### 6. 创建 GitHub Release（**最容易漏，务必做**）

**tag 推送成功 ≠ 发布完成。** 自某个版本起，每个版本都应在 GitHub 上有一份 Release——它是用户从 GitHub 进入时的第一屏，也是 tag 对外的说明。

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z — <一句话说明>" \
  --notes-file /tmp/release-X.Y.Z.md \
  --verify-tag
```

- **`--verify-tag`（务必带上）**：tag 必须已存在（第 4 步推过）。漏了它，命令会在 tag 不存在时**悄悄新建一个指向当前 HEAD 的 tag**——那可能不是你发布的那次提交。
- **`--title` 形态是 `vX.Y.Z — <一句话>`**（破折号 `—`）。
- **`--notes-file` 指向临时文件**。不要用 `--notes-from-tag`（tag message 只有一行，正文会空得离谱），也不要用 `--generate-notes`（那是自动 commit 列表，与历史形态不符）。
- 不加 `--draft`、不加 `--prerelease`：均为正式发布。
- **不附任何构建产物**：本插件经 DSH 注册表 / npm 分发，不通过 Release 发二进制。不要在这一步突然塞 `.tgz`。
- **断点续发：npm 已发、只缺 Release 时**
  - 这就是第 1 节判定表里的 **S3**。
  - 此时目标非常单一：只补 Release，不再碰 tag、不再重发 npm。
  - 先确认 tag 指向的 commit 就是本次要发的内容，再建 Release。
  - 建完后用同一节清单核对，避免“发了一半却不知道哪边缺”。

**正文形态**（注意：它与 `CHANGELOG.md` 那一节**不是同一份文本**）：

```markdown
# <一个主题 emoji> vX.Y.Z — <比 --title 再完整一档的一句>

<本版主线，一到两段；有两条主线就点名。>

---

## 一、<主题>
## 二、<主题>
```

- H1 带一个主题 emoji（如 🐋），副标题比 `--title` 更长一档。
- 正文按 **`## 一、` `## 二、` 主题**分节，而不是照抄 CHANGELOG 的逐条列表：CHANGELOG 是变更记录，Release 是**可独立阅读的发布公告**，可以更展开（贴取证、对照表、失败判据、修法）。
- 允许表格、引用块、行内代码、`---` 分隔线。

核对清单（**做完逐条勾掉**）：

- [ ] `gh release list` 里能看到本次版本，标题以 `vX.Y.Z — ` 开头（破折号）
- [ ] Release 指向的 tag 与第 4 步推的是同一个：`gh release view vX.Y.Z --json tagName`
- [ ] 不是 draft、不是 prerelease
- [ ] `assets` 为空（与分发方式一致）
- [ ] 正文不是 CHANGELOG 的复制粘贴，单独读也讲得通

```bash
# 一次确认以上五点
gh release view vX.Y.Z --json name,tagName,isDraft,isPrerelease,assets
```

> **为什么这一步必须写进文件**：它对 CI、对 npm、对测试**都没有任何影响**，所以漏掉时不会有任何东西报错——这正是它容易被漏掉的原因。它只能靠「发布清单里写着」来保证。

## 最终闭环清单（完成判定，不再凭感觉）

发版是否完成，只看下面 5 个事实是否全部成立：

- [ ] **仓库可查**：`vX.Y.Z` tag 存在，且 `git rev-list -n1 vX.Y.Z` 指向本次要发布的 commit。
- [ ] **main 可查**：该 commit 已在 `origin/main`，`git log --oneline -5` 能追到版本提交。
- [ ] **版本文件可查**：`package.json` 的 `version` 与目标版本一致；`CHANGELOG.md` 顶部已有该版本节。
- [ ] **npm 可查**：`npm view dsh-connect-sensenova-token-plan version --registry=https://registry.npmjs.org` 返回目标版本。
- [ ] **GitHub Release 可查**：`gh release view vX.Y.Z --json tagName` 能查到，且 `isDraft=false`、`isPrerelease=false`、`assets=[]`。
- [ ] （推荐，不参与「完整」判定）**发布提交上 CI 绿**：`gh run list` 里该 commit 的 run 结论是 `success`。它是质量事实而非完整性事实——但正因为本仓库出现过「门禁恒红一整天、发版照发」（`docs/PITFALLS.md` §30），这条才值得单列。

只要有一个缺，就是“未完整发布”。  
**AI 的执行目的**应当始终是：

> 先判状态（S0–S4，含 S2′），再补缺口，最后用这 5 条收口；任何一步都不得假设“前面那一步已经做完了”。

## 常见问题

- **GitHub 上没有本次 Release / `gh release list` 看不到新版本**：第 6 步漏了。`gh release create` 与 tag 推送是两条独立通道，**tag 推送成功不会自动创建 Release**。补做即可：版本、tag、正文都还在仓库里，事后补建与当时创建完全等效，只是 GitHub 上的时间戳会晚。
- **`gh release create` 报 `tag not found`**：tag 还没推。先完成第 4 步的 `git push origin vX.Y.Z`。**不要**为了让它通过就去掉 `--verify-tag`——那会让 gh 新建一个指向当前 HEAD 的 tag，可能偏离你实际发布的提交。
- **`gh` 报 `HTTP 403` / `Resource not accessible`**：token 缺 `repo` scope。`gh auth status` 确认 scopes；需要时 `gh auth refresh -s repo`。
- **发布后才发现 tag 落后于 HEAD**（`git log --oneline vX.Y.Z..HEAD` 有输出）：**不要**动 tag。既然该版本已在 npm / Release 上，正确动作是**开下一个版本**（升 `package.json` → 新 CHANGELOG 节 → 提交 → 打新 tag → publish → 建 Release），让漏掉的提交随新版到达用户。已发布版本的内容是既成事实，改 tag 只会制造「tag 说什么 ≠ npm 装到什么」的错位。
- **修好的文档用户看不到**：README / `cordis.patch.yml` 都在 `files` 白名单里，随包发布。改完仓库里的 README **不代表**用户读到的是新版——验证方式：
  `npm view dsh-connect-sensenova-token-plan readme --registry=https://registry.npmjs.org | grep -c '<你刚加的关键词>'`
  返回 0 就说明还停在上一版，需要发新版才会生效。
- **发布提交不小心卷走了别人的改动**：回退用 `git reset --soft HEAD~1`（仅撤提交保留文件改动），重新按「1.5 并行会话纪律」只 `git add` 自己的文件再提交；已 push 的先用 `git push --force-with-lease` 谨慎修正（仅限自己未与他人共享的分支/tag）。
- **npm 包 / `dsh plugin add` 还没刷到新版本**：确认第 5 步 `npm publish --registry=https://registry.npmjs.org` 已成功，且 `npm view dsh-connect-sensenova-token-plan version --registry=https://registry.npmjs.org` 已显示 X.Y.Z（带同样的 `--registry`，否则读到镜像缓存旧版）。GitHub Release 与 npm 包是两条独立通道，建了 Release 不等于发了包。
- **npm 已经发出去，但 tag / main / Release 还没做**（第 1 节的 **S2′**）：按下面顺序补，**不要重新 publish**（该版本号已不可覆盖）。
  1. **先核验**（§5.5）：把已发布 tarball 拉下来，与本机候选提交的产物逐文件比 SHA256——确认 npm 上那一版就是它。
  2. 推 `main`（把版本提交送上去），再把 tag 指向**被核验过的那个提交**：`git tag -a vX.Y.Z -m "…"` 后核对 `git rev-list -n1 vX.Y.Z` 与 `git rev-parse HEAD` 是否一致（不一致就说明 tag 打错了位置）。
  3. 补 Release（第 6 步，带 `--verify-tag`）。
  - **为什么会走到这一步**：publish 与 tag 是两件独立的事，顺序颠倒不会报错——只能靠状态表与核验认出来。
- **`npm publish` 报 `E401 Unauthorized`**：没登录（或登录的是镜像账号）。确认与补救：
  `npm whoami --registry=https://registry.npmjs.org` → `npm login --registry=https://registry.npmjs.org`。
  注意 publish 会**先跑 `prepack` 构建再失败**，所以别把它当「一按就知道」的检查——发布前先跑 whoami。
- **`gh ... -q` 在 PowerShell 里报 `failed to parse jq expression`**：是引号被 PowerShell 吃了（`\"` 会原样传进 jq）。用单引号包住表达式（`-q '.[0].databaseId'`），或干脆用 `--json <字段>` 后自己看。

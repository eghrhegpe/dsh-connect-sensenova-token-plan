# 发布流程（Release Flow）

> 本文档是 `dsh-connect-sensenova-token-plan` 的**唯一权威发布流程**。发布前请通读一遍。
>
> **先讲清一个常见误解**：本仓库**没有 release 自动化**——`.github/workflows/` 里只有 `ci.yml`（跑测试）。
> 你在 GitHub Releases 页面看到的「更新日记框」是**手动** `gh release create` 出来的，CI 不会、npm 成功也不会自动建。
> 这正是历史上最容易漏的一步：它对 CI / 测试 / 安装**都没有任何影响**，漏掉时没有任何东西报错，只能靠「发布清单里写着」来保证。

## 前置条件

- `gh` 已登录且带 `repo` 权限：`gh auth status` 应显示 `Logged in to github.com account eghrhegpe`、scope 含 `repo`。
- npm 已登录：**本机默认 registry 是 npmmirror 镜像**，发布与登录都必须显式带 `--registry=https://registry.npmjs.org`（见 `docs/CONTRIBUTING.md` §8）。先 `npm whoami --registry=https://registry.npmjs.org` 确认账号已登录。
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

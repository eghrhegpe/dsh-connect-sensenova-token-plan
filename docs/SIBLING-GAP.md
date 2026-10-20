# 兄弟插件差集核对（2026-10-20）

> 📦 **冻结档案（2026-10-20）**：本文是**一次性差集核对**的记录——当时核了什么、抄了什么、
> 明确不抄什么、还剩什么没核。它已退出持续维护面：文中提到的兄弟仓提交号、文件位置与实测
> 现状都会过时，用时回各仓自证。**现行规则**看 [ADR.md](./ADR.md)（裁定）、
> [ARCHITECTURE.md](./ARCHITECTURE.md)（结构）、[PITFALLS.md](./PITFALLS.md)（坑）、
> [TESTING.md](./TESTING.md)（测试）；本文与它们冲突时**以现行文件为准**。

## 1. 方法：只做差集，不通读历史

本仓与兄弟插件（`dsh-connect-qoder` / `dsh-connect-atomcode` / `dsh-connect-agnes-token-plan` /
`dsh-connect-modelscope-token-plan`）共享同一套 DSH 插件骨架：bundle 结构、patch 装配、
peer 语义、门禁名册、构建产物入库纪律——这些**本仓早已同步到位**。再读一遍它们的提交史，
等于把已知事实重验一遍，收益低而上下文贵。

值得读的只有**各家本族特有**的落地改动：它们回答的是「同类问题别人踩过哪些坑、怎么修的」。
于是方法固定为三步：先列差集候选 → 在本仓核**有没有这个问题** → 只抄**问题确实存在**且
**修法能对上本仓结构**的那部分。核完不成立的也要留痕（「核过但本仓不成立」），否则下一轮
会重新怀疑同一件事。

兄弟仓位置（本机路径，非本仓库文件，不经 docs 门禁校验）：
`~/.dsh/plugins/dsh-connect-{qoder,atomcode,agnes-token-plan,modelscope-token-plan}`；
已发布的安装件在 `~/.dsh/profiles/desktop/node_modules/` 下对应目录。

## 2. 已落地（三项，均为「零行为变化」）

### 2.1 三个零成本 tsc 开关

- **兄弟侧**：agnes 仓提交 `6453b87` 给 `tsconfig.json` 加了 `noImplicitReturns`、
  `verbatimModuleSyntax`、`noUncheckedSideEffectImports`——都是「写对也过、写错立刻红」的
  开关，不引入任何运行时代价。
- **本仓现状（核对时）**：三个全缺。
- **实测**：三个开关在本仓两个 config（`tsconfig.json` / `tsconfig.strict-null.json`）上都是
  **0 诊断**——存量代码本来就满足，只是没有门禁守着。
- **落地**：`tsconfig.json` 加三键，理由写进 `$comment`；`test/typecheck-gate.mjs` 照旧跑两个
  config（该门禁不钉具体键，加开关不改变它的行为）。

### 2.2 `.editorconfig`：只写与磁盘现状一致的键

- **判据**：这份文件一旦承诺了「现状不符」的键，编辑器就会开始批量改写仓库——那是噪声 diff，
  还会把并行会话里别人的改动一起卷进来。所以先量现状再写键，目标是**零字节改动**。
- **实测基线（2026-10-20）**：全仓无 BOM；工作区里有一批文件是 CRLF，而索引统一 LF
  （`.gitattributes` 的 `* text=auto eol=lf` 负责归一化，editorconfig 不越权）；行尾空白只剩
  零星几处；有一批文件没有末尾换行；源码与文档里**没有 tab**（只有生成物 `client.js` /
  `lib/*.js` 与二进制误报）；代码文件没有以 4 空格为主体的（2 空格是本仓风格）。
- **落地**：根 `.editorconfig` 只给与现状一致的键——`charset=utf-8` / `end_of_line=lf` /
  `indent_style=space` / 缩进 2 空格；`trim_trailing_whitespace` 与 `insert_final_newline`
  显式关掉（markdown 的行尾双空格是硬换行；补末尾换行会让一批文件产生纯格式 diff）；
  `lib/**`、根 `client.js`、`assets/**`、`upstream/**` 排除在缩进约定外。
- **代价**：零——全仓没有任何门禁消费 editorconfig，它是纯编辑器提示。

### 2.3 429 重分类的「判据理由」

- **兄弟侧**：modelscope 仓把「要不要把 QUOTA 纠正成 RATE_LIMIT」从一个裸布尔改成
  **先返回稳定短串（判据路径）、布尔由它派生**。
- **本仓现状（核对时）**：`src/host/llm-error-fix.ts` 的 `shouldReclassifyQuotaToRate` 只吐
  布尔——判定分支写在实现里，既不可 grep，也没法单独钉测。
- **落地**：新增 `REASON`（稳定短串集合）与 `reclassifyReason(failure)`，布尔改为「路径串是否
  落在应纠正集合」的投影；8 条分支与旧实现逐条等价，判定结果不变。

## 3. 明确不抄（连同理由）

- **agnes 的 scan-to-login device flow**：本仓登录是浏览器 OIDC + PKCE（AGENTS.md 红线 4/6），
  没有设备码可扫。
- **agnes 的 DPAPI Windows 门禁**：本仓密码封包走平台 JWKS 的 JWE（RSA-OAEP + A256GCM），
  不经 Windows 凭据库，那道门禁防不到本仓的威胁面。
- **agnes 的 any 预算门禁**：本仓 `noImplicitAny` 已开，缺的不是这一条。
- **qoder 的 credentialKind 三档**：依赖它自己的 provider 形态，本仓是另一套。

## 4. 核过但本仓不成立

- **静默失败门禁**（qoder issue 16）：本仓已有 `test/silent-catch.test.mjs`，同一缺陷类已被
  覆盖——省下一份白工。

## 5. 还没核的三项（留给下一轮差集，本轮未动）

1. **出图链的四处语义缺陷**（modelscope 侧 `222c72c`）：本仓 `src/host/draw.ts` 结构不同，
   得先在本仓取证再逐条比对——「非 2xx 的轮询会不会把上一轮读数当成终态」「abort 会不会被当
   抖动吞掉」「waitMs 的余量」「作业表的 dispose 有没有调用方」。**不可直搬**。
2. **覆盖率分母**（qoder issue 11）：本仓目前**没有覆盖率工具**（`package.json` 里没有
   coverage / c8 / nyc），先要决定「要不要引入」，再谈分母怎么算。
3. **激活路径的裸 node 覆盖**（qoder 侧）：本仓 `test/wiring.test.mjs` 依赖 peer
   `@deepseek-ai/cordis`，本机是 loud SKIP、CI 才真跑——要不要补一份不依赖 peer 的裸 node
   激活档，是下一个候选。

## 6. 复查方式

本轮结论都能当场重跑：`node test/error-fix.test.mjs` 看 2.3 的路径钉，
`tsc -p tsconfig.json --noEmit` 看 2.1 的诊断数，`.editorconfig` 的键与
`git ls-files --eol` 的现状对读即 2.2 的基线，兄弟侧则回
`~/.dsh/plugins/dsh-connect-{agnes-token-plan,modelscope-token-plan}` 查对应提交。

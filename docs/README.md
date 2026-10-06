# 文档体系（docs/）

本目录是 `dsh-connect-sensenova-token-plan` 插件的详细文档，与根 `README.md`（快速上手与索引）互补、不重复。所有文档为中文。

AI 协作会话从根目录 [AGENTS.md](../AGENTS.md) 进入：验证怎么跑、红线、文档地图都在那里，本目录提供细节。

阅读顺序建议：先 [ARCHITECTURE.md](./ARCHITECTURE.md) 建立整体认知，再按需查 [SETUP.md](./SETUP.md) / [AUTH.md](./AUTH.md) / [API.md](./API.md)；改动代码前读 [TESTING.md](./TESTING.md) 与 [CONTRIBUTING.md](./CONTRIBUTING.md)。

> **手里有症状，先看 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)**（按现象组织，不是按主题）。
> 「额度那栏一直是空的」「登录后又掉线」「改了代码没生效」这类问题从那里进，每条给稳定症状码；
> `npm run doctor --json` 的 `symptoms` 字段直接给症状码，人和 agent 用同一条路进文档。症状码真源是
> `src/host/codes.ts` 的 `SYMPTOM`，与该页由 `test/doctor.test.mjs` 双向钉住。

| 文档 | 内容 | 何时查 |
|---|---|---|
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | **按症状排查**：额度栏空 / 反复要求登录 / 模型或工具不出现 / 改了代码没生效 / 状态文件对不上 / 配置报错——每条给「先看哪 → 怎么办 → 根因在哪篇」，带稳定症状码供 doctor 与 agent 引用 | **排查问题的第一站**（先有症状、后有主题） |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 双仓库关系（`dsh-connect-sensenova-token-plan` 与 `upstream/`）、Host/Client 分流、数据流、生态定位与大统一路线（§5，同类插件核实见 §5.3、出图对接点源码对照见 §5.4）、与上游 Python 工具差异 | 理解结构、接手、做架构决策、定吸收边界 |
| [ROADMAP.md](./ROADMAP.md) 📦 | 战略执行路线图（2026-09-29 起）：P0 解耦与契约回归、429 全局自愈、§5「多 Key 池」纠偏、小浣熊网关契约复测与接入面盘点，明确不做的边界 | 📦 **历史**：当初按什么顺序做、为什么这么定（冻结，不持续维护） |
| [DSH-PLUGIN.md](./DSH-PLUGIN.md) | DSH 插件机制总览（bundle 结构、Loader 条目、cordis.patch.yml、安装重启、peer 依赖、与兄弟插件关系） | 理解「这是一个 DSH 插件」、对照 dsh-connect-qoder 范本 |
| [QODER-GAP.md](./QODER-GAP.md) 📦 | 与 `dsh-connect-qoder` 的 client 侧差距对照（可测边界 / 分层线 / JSX / 测试基建），事实带行号 | 📦 **历史**：一次性的两插件差距核对（冻结，不持续维护；qoder 改版后整体失真） |
| [SETUP.md](./SETUP.md) | 安装、配置字段表、改动后必须重启 Host、首次使用、常见信号处置、报错去哪儿看（Host 日志 vs 浏览器控制台） | 装环境、改配置、排「跑的是旧代码」、查面板报错信号、找不到报错该看哪个进程 |
| [AUTH.md](./AUTH.md) | OIDC+PKCE、密码 JWE 加密、凭据存储、静默续期、防锁号节流 | 改登录/续期、排查登录失败 |
| [API.md](./API.md) | 本地路由（`snapshot`/`account`）、控制台端点、配置端点清单 | 对接路由、看返回结构、调端点 |
| [PROVIDER-HOT-RELOAD.md](./PROVIDER-HOT-RELOAD.md) | 提供方注册开关：从「配置字段 + 重启」到「面板开关 + 立即生效」的设计决策与同类插件调研 | 改 provider 注册、理解开关语义 |
| [TESTING.md](./TESTING.md) | 离线测试体系、`panel-decision.js` 机制、已知缺口 | 跑测试、理解测试为什么这样写 |
| [SENSENOVA-API.md](./SENSENOVA-API.md) | 商汤接口全集（认证/OIDC、密码 JWE、用量接口、错误码、推理接口、上游简介） | 改登录/用量/推理适配、对照 upstream、排接口字段 |
| [PITFALLS.md](./PITFALLS.md) | 39 条真实踩坑（现象→根因→修法） | 改代码前避坑、理解防御性代码的来由 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 提交约定、红线（凭据/`upstream/` 不进库）、仓库整洁 | 准备提交、清理历史误跟踪 |
| [CHANGELOG.md](../CHANGELOG.md) | 公开行为变化的版本记录（非 git log 替代） | 看「这个版本改了什么」 |
| [IMPROVEMENTS.md](./IMPROVEMENTS.md) 📦 | 深化改进研究（定位对齐 / `index.js` 收编 / peer 契约护栏 / 四块债），附分步落地顺序与门禁 | 📦 **历史**：当初的诊断与投入风险比（冻结，不持续维护） |
| [TOKEN-STORE-SPLIT.md](./TOKEN-STORE-SPLIT.md) 📦 | `token-store.ts` 拆分**落地记录**（四块 + 显式 state 容器）：状态归属表、7 步落地门禁、红线核对表 | 📦 **历史**：token-store 怎么拆的、当时还欠什么（冻结，不持续维护） |
| [ADR.md](./ADR.md) | 决策账本（大统一定位 / 边界放宽 / 路由拆分 / maxTokens 决策）：裁定事实、理由与取代关系；现行文档只写现状，沿革一律在此 | 查「当初为什么这么定」、改裁定（新增条目而非内联修订） |
| [REFERENCES.md](./REFERENCES.md) | 参照件索引：`upstream/` 容器（商汤 Token Plan 历史上游 + 生态核实样本）的来源、版本、许可与「承重在哪」；容器纪律与维护 | 查「某条事实当初从哪来」、落盘新参照件、核对参照版本 |

## 文档边界（不在此目录写的内容）

- **代码与测试**：源码改动、补 `wiring.test.mjs`、修 `panel.test.mjs` 失败用例 —— 属实现工作，由对应会话处理。
- **上游 Python 工具细节**：`upstream/` 的构建/打包/多账号逻辑以它自己的 `README.md` 为准；本目录只在架构层面对照，不重复其细节（其接口与封包对照见 [SENSENOVA-API.md](./SENSENOVA-API.md) §6）。

## 同步约定

逻辑改动若影响路由/配置、登录/续期/节流、或双仓库关系，须同步更新对应文档；根 `README.md` 始终只做索引与快速上手，细节下沉到本目录。

### 不写时点计数

行数、文件数、用例项数、CRLF/LF 计数这类**随一次改动就旧**的值，**不要在正文写死**。它们唯一的用途是当置信度信号（"文档是量过的"），但作为被维护的事实来养，成本恒高、收益为零。改用自证：

- 文件行数 → `(Get-Content src/host/token-store.ts).Count`
- 目录文件数 → `git ls-files "src/client/*.ts" | Measure-Object`
- 套件名册与项数 → `node test/run-all.mjs --list` + `test/suites.mjs`
- 行尾分布 → 临时 pwsh 统计，用完即弃

**允许写死**的只有两类：**历史/对比**（"拆分前 944 行单体 → 拆分后薄 facade"，承载"改了多少"这个决定依据）与**契约真源**（门禁钉的值：PITFALLS 条数、API 快照键数、baseline 场景/帧数）。写历史数字要注明时点；写契约数字要标注它由门禁钉住、改动要连门禁一起改。判断标准：这个数字**读者用得上吗**？用不上就换命令或删。

### 冻结档案（📦）

**研究档案、一次性核对、已落地的设计蓝图**这类文件，价值在「当初怎么想的」，不在「现在长什么样」——继续维护它们只会持续产出会腐的描述。这些文件**冻结**：正文顶部带 📦 头注、本索引标 📦、「何时查」写成历史参考。规则：

- **冻结 = 退出持续维护面**：不再随代码改动更新，也不再要求"文档与代码一致"。描述失真是**预期内的**，头注已声明以 `src/` / `test/` / `ADR.md` 为准。
- **现行表述永远在别处**：现行规则看 `docs/ADR.md`（裁定）+ `docs/ARCHITECTURE.md`（结构）+ `docs/PITFALLS.md`（坑）+ `docs/TESTING.md`（测试）。冻结文件里若与它们冲突，**以现行文件为准**。
- **解除冻结才改**：若某文件的结论又要重新生效（如重做某块设计），先删头注、把结论迁进 `ADR.md` / `ARCHITECTURE.md`，再按现行文档维护——**不要**在冻结文件上打内联修订补丁。
- 冻结清单（2026-10-05）：`ROADMAP.md`、`IMPROVEMENTS.md`、`QODER-GAP.md`、`TOKEN-STORE-SPLIT.md`。`test/docs.test.mjs` 的考古扫描把它们与账本同等豁免。

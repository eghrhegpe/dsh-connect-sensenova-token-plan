# 文档体系（docs/）

本目录是 `dsh-connect-sensenova-token-plan` 插件的详细文档，与根 `README.md`（快速上手与索引）互补、不重复。所有文档为中文。

AI 协作会话从根目录 [AGENTS.md](../AGENTS.md) 进入：验证怎么跑、红线、文档地图都在那里，本目录提供细节。

阅读顺序建议：先 [ARCHITECTURE.md](./ARCHITECTURE.md) 建立整体认知，再按需查 [SETUP.md](./SETUP.md) / [AUTH.md](./AUTH.md) / [API.md](./API.md)；改动代码前读 [TESTING.md](./TESTING.md) 与 [CONTRIBUTING.md](./CONTRIBUTING.md)。

| 文档 | 内容 | 何时查 |
|---|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 双仓库关系（`dsh-connect-sensenova-token-plan` 与 `upstream/`）、Host/Client 分流、数据流、生态定位与大统一路线（§5，同类插件核实见 §5.3、出图对接点源码对照见 §5.4）、与上游 Python 工具差异 | 理解结构、接手、做架构决策、定吸收边界 |
| [ROADMAP.md](./ROADMAP.md) | 战略执行路线图（2026-09-29 起）：P0 解耦与契约回归（§2，`index.js` 控制面拆模块 + 商汤契约自动化回归）、429 全局自愈、§5「多 Key 池」纠偏、文档精炼、小浣熊网关契约复测与接入面盘点（§6.1），明确不做的边界 | 定吸收顺序 / 优先级、拍板侵入性、防范围漂移 |
| [DSH-PLUGIN.md](./DSH-PLUGIN.md) | DSH 插件机制总览（bundle 结构、Loader 条目、cordis.patch.yml、安装重启、peer 依赖、与兄弟插件关系） | 理解「这是一个 DSH 插件」、对照 dsh-connect-qoder 范本 |
| [SETUP.md](./SETUP.md) | 安装、配置字段表、改动后必须重启 Host、首次使用、常见信号处置 | 装环境、改配置、排「跑的是旧代码」、查面板报错信号 |
| [AUTH.md](./AUTH.md) | OIDC+PKCE、密码 JWE 加密、凭据存储、静默续期、防锁号节流 | 改登录/续期、排查登录失败 |
| [API.md](./API.md) | 本地路由（`snapshot`/`account`）、控制台端点、配置端点清单 | 对接路由、看返回结构、调端点 |
| [PROVIDER-HOT-RELOAD.md](./PROVIDER-HOT-RELOAD.md) | 提供方注册开关：从「配置字段 + 重启」到「面板开关 + 立即生效」的设计决策与同类插件调研 | 改 provider 注册、理解开关语义 |
| [TESTING.md](./TESTING.md) | 离线测试体系、`panel-decision.js` 机制、已知缺口 | 跑测试、理解测试为什么这样写 |
| [SENSENOVA-API.md](./SENSENOVA-API.md) | 商汤接口全集（认证/OIDC、密码 JWE、用量接口、错误码、推理接口、上游简介） | 改登录/用量/推理适配、对照 upstream、排接口字段 |
| [PITFALLS.md](./PITFALLS.md) | 31 条真实踩坑（现象→根因→修法） | 改代码前避坑、理解防御性代码的来由 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 提交约定、红线（凭据/`upstream/` 不进库）、仓库整洁 | 准备提交、清理历史误跟踪 |
| [CHANGELOG.md](../CHANGELOG.md) | 公开行为变化的版本记录（非 git log 替代） | 看「这个版本改了什么」 |
| [IMPROVEMENTS.md](./IMPROVEMENTS.md) | 深化改进研究（定位对齐 / `index.js` 收编 / peer 契约护栏 / 状态·契约·UX·client 四块债），实证引用兄弟插件与本机 peer 源码，附分步落地顺序与门禁 | 定改进优先级、排重构顺序、查每项的投入风险比 |
| [TOKEN-STORE-SPLIT.md](./TOKEN-STORE-SPLIT.md) | `token-store.js` 拆分蓝图（登录/续期/节流/迁移四块 + 显式 state 容器）：状态归属表、迁移块退役条件、7 步落地计划（每步门禁=行为基线零漂移）、红线核对表 | 动刀 token-store 之前先读这份 |

## 文档边界（不在此目录写的内容）

- **代码与测试**：源码改动、补 `wiring.test.mjs`、修 `panel.test.mjs` 失败用例 —— 属实现工作，由对应会话处理。
- **上游 Python 工具细节**：`upstream/` 的构建/打包/多账号逻辑以它自己的 `README.md` 为准；本目录只在架构层面对照，不重复其细节（其接口与封包对照见 [SENSENOVA-API.md](./SENSENOVA-API.md) §6）。

## 同步约定

逻辑改动若影响路由/配置、登录/续期/节流、或双仓库关系，须同步更新对应文档；根 `README.md` 始终只做索引与快速上手，细节下沉到本目录。

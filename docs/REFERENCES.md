# 参照件索引（References）

本文件是仓库根 `upstream/` **容器**的唯一权威索引与纪律。`upstream/` 整个目录被 `.gitignore` 的 `/upstream/` 忽略：**永不进本仓库历史、不进 npm 包**，绝不 `git add upstream/`。

它容纳的不是「一个上游应用」，而是两类东西：**独立 git 仓库**（各占一个用仓库原名命名的子目录，浅克隆、自带 `.git` 与 remote，可各自 `git pull`）与**本机快照 / 解包**（非 git）。要查某个子目录的来源，优先看它自己的 `README`；本文件只登记**承重件**——即那些一旦丢失、会让某条实现线「凭记忆猜事实」的参照。

> **2026-10-02 建档说明**：本插件的历史上游是商汤时代 Python 桌面工具 [shaobingtongzhi/sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard)，曾以 `upstream/sensenova-usage-dashboard` 移入；其后为「大统一」吸收而拉入的同类插件参照件（§5.3 生态核实的五个形态样本）也一并落在此容器。本文件按「承重在哪」分线登记；与主线关系弱的历史对照件只列来源，不展开承重。

---

## 1. 商汤 Token Plan 线（承重）

| 参照件（`upstream/` 下） | 形态 | 来源 | 版本 / HEAD | 许可 | 承重在哪 |
|---|---|---|---|---|---|
| `sensenova-usage-dashboard/` | 本机快照（非 git，原独立仓库） | [shaobingtongzhi/sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard) | 本地当前不带 `.git`，恢复用 `git clone` | 未标注 | **登录/用量逻辑的原始参考实现**：`dashboard.py` + `auth_login.py`；`auth_login.py` 的 JWE 封包与字段语义是 [SENSENOVA-API.md](./SENSENOVA-API.md) §6 / §7 的对照（本插件零明文、refresh 续期、节流分层均为相对它的差异点，见 ARCHITECTURE §6） |
| `SenseNova AI API does/` | 本机快照（官方文档副本） | 商汤官方 API 文档（与 `docs/sensenova-api-reference/` 逐字节相同） | — | 官方文档 | **注意**：本文件 0 文件进 git（参考应用 checkout）；`docs/sensenova-api-reference/` 是唯一受版本控制的官方副本（ROADMAP §6.1 裁定） |
| `st_rotator_client/` | 本机快照（独立 Python 进程） | 社区 st-rotator（商汤 429 轮换客户端） | — | 未标注 | 429 自愈先例：先分诊「限频 vs 配额」、降速退避两条纪律，被 `llm-error-fix.ts` / `llm-retry.ts` 吸收（**不做多 Key 池**，见 ARCHITECTURE §5 吸收路线图） |

## 2. 生态核实线（同类插件形态样本，ARCHITECTURE §5.3 快照）

| 参照件（`upstream/` 下） | 形态 | 来源 | 版本 / HEAD | 许可 | 承重在哪 |
|---|---|---|---|---|---|
| `alaxrpg-dsh-sensenova-provider/` | git 仓库 | [alaxrpg/dsh-sensenova-provider](https://github.com/alaxrpg/dsh-sensenova-provider.git) | `0.1.0-alpha.8` | 未标注 | **直接竞品形态证明**：商汤 OIDC+PKCE + provider 注册 + 多 Key 轮换 + vision 单包；证明「额度 + provider 合一」成立（多 Key 轮换不吸收，Token Plan 同账号共享额度池） |
| `dsh-retry-boost/` | git 仓库 | [hhb1028/dsh-retry-boost](https://github.com/hhb1028/dsh-retry-boost.git) | `1.2.0` | 未标注 | 429 自愈网关同类先例：多 Key 池化 + AIMD 限速；「限频可退避 vs 配额不足换 Key/停」的区分纪律出处 |
| `dsh-draw-router/` | 本机快照（非 git，zip 解包） | 社区 draw-router（源码见 `repo/lib/index.js`） | `0.1.1` | 未标注 | **出图吸收的对接参考**（ARCHITECTURE §5.4 源码级对照）：`repo/lib/index.js` 495 行；其「名字正则漏识别 u1.5-lite」正是本插件改结构化判定的实证；30s 冷却与超时合并模式已借入 `draw.ts` |
| `mmx-quota-tool/` | git 仓库 | [mtty-ai/mmx-quota-tool](https://github.com/mtty-ai/mmx-quota-tool.git) | `0.1.0` | 未标注 | 面板 UX 基准（实时性、告警形态）——跨 provider 聚合本身不吸收 |
| `dsh-provider-quota/` | git 仓库 | [lizhouai/dsh-provider-quota](https://github.com/lizhouai/dsh-provider-quota.git) | `0.3.15` | 未标注 | 品类对照：泛化「provider 额度面板」= 本插件**不**吸收的边界样本 |
| `dsh-musage/` | git 仓库 | [Thedeergod666/dsh-musage](https://github.com/Thedeergod666/dsh-musage.git) | `0.1.1` | 未标注 | 同上：跨 provider 通用聚合边界 |
| `deepseek-harness-codearts-master/` | 本机快照（非 git，zip 解包） | `dsh-codearts-auth`（codearts / buddy / workbuddy / lobsterai / qoder / loomy / raccoon / trae 多 provider 聚合登录插件） | — | 未标注 | 「自有登录 + 凭据服务」形态完整先例；小浣熊微信扫码的事实源（ROADMAP §6.1.1）；其跨 provider 泛化是边界样本 |
| `dsh-connect-workbuddy-main/` | 本机快照（非 git，zip 解包） | `dsh-connect-workbuddy` | `2.3.1` | 未标注 | 面板 + provider + 模型管理单包形态对照（IMPROVEMENTS §1.1 生态惯例表） |
| `dsh-raccoon-work-old0.16/` | 本机快照（非 git） | 商汤小浣熊 Raccoon Work 旧版（0.16） | `0.1.2` | 未标注 | 第二上游（小浣熊）的历史形态对照；ROADMAP §6.1 的接入面盘点参考 |

## 3. 纪律

- **只吸收事实，不复制代码。** 对这些参照件的用法一律是「读出协议事实 → 用自有的 Node/TypeScript 实现重写」。参考件多为「个人学习与技术研究」定位；本插件不 vendor 任何源码，不把参照件的实现逻辑抄进 `src/`。
- **绝不 `git add upstream/`**，也不把参照件里的明文凭据文件（如 `accounts.json`）带进版本库。
- **凭据的边界不变**：参照件只提供「凭据存在哪、怎么解」的事实；解出的 token / 密码永不落盘、不进日志，见 [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [PITFALLS.md](./PITFALLS.md)。
- **版本漂移优先于文档结论。** 任何参照件的事实都带「它当时看的是哪个版本」（§5.3 的维护代价快照 2026-09-29：这批生态插件全部个人维护、个位数采用）；引用其结论前先回本表核版本。

## 4. 维护

```bash
cd upstream/<子目录> && git pull      # git 仓库：浅克隆（--depth 1），要历史先 git fetch --unshallow
```

新增参照件时：在 `upstream/` 下并排加**同名目录**（`/upstream/` 规则已覆盖，无需改 `.gitignore`），并在本文件登记来源、版本与「承重在哪」；只做本机对照、与主线无关的，登记到机械清单即可（见根目录 [AGENTS.md](../AGENTS.md) 与 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)）。**不再往 `upstream/` 拉新项目，除非同时定义「提炼出口」**（ROADMAP §6.1 纪律：吸知识不吸代码）。

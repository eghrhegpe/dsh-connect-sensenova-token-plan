# dsh-connect-sensenova-token-plan

商汤接入的 DSH **Plugins 页**插件卡**全家桶**（三个 tab）：① **积分额度** tab——登录一次，实时查看积分余额、额度窗口与每模型消耗，令牌自动续期，之后无需再管；② **接入 API** tab——把商汤模型注册为 DSH provider，参与对话与出图；③ **小浣熊** tab（可选、默认关）——微信扫码接入第二个上游 `xiaohuanxiong.com`，与主额度池相互独立。此外 429 自愈在后台生效：限频被误判为"额度耗尽"时在 Host 侧纠正回退避重试，模型不会无端消失。

## 功能

商汤 Token Plan 按**积分池**计费——每个池有 5 小时滚动窗口 + 每周额度，用超了只能等窗口重置。这个面板把数字搬进 DSH 的 Plugins 页，写代码时不用切网页就能盯住：

- **积分池**：额度窗口（已用 / 剩余 / 百分比 / 重置时间）、返赠余额与到期时间
- **模型清单**：套餐覆盖 vs 当前 Key 实际能调，一眼看出哪些模型需要开通
- **每模型消耗**：近 N 小时各模型积分排名，"烧分大户"一目了然
- **可选接入**：把商汤模型（`sensenova-6.8-flash-lite`、`deepseek-v4-flash` 等）接进 DSH 对话，视觉模型自动识别、思考强度可选
- **第二个上游（默认关）**：面板「小浣熊」tab 微信扫码接入 `xiaohuanxiong.com`，独立凭据、独立 provider，与 Token Plan 额度池互不干涉

面板**不代你操作账务**：不改套餐、不代扣积分、不碰 Key 明文；数据来自商汤控制台自己的 API，与网页控制台口径一致。真正会「动」的三部分——注册 provider、挂出图工具、接第二个上游——全部 opt-in 且**默认关闭**，不打开时插件退化为纯信息展示。

**注册 provider 时**（面板开关打开），插件把商汤模型接进 DSH 的对话模型选择器，并在 Host 侧纠正 peer 对限频 429 的误判（商汤把速率上限错命名为 `quota_exceeded_error`，会被判成额度耗尽而不重试）——限频真正退避重试，模型不再无端 "消失"。

## 安装

1. 在 DSH「插件」页搜索 `dsh-connect-sensenova-token-plan` 点击安装，或运行：

   ```powershell
   dsh plugin --profile web add dsh-connect-sensenova-token-plan       # Web 端
   dsh plugin --profile desktop add dsh-connect-sensenova-token-plan  # 桌面端
   ```

2. **完全退出 DSH（含托盘）再启动**。

## 快速开始

1. 打开 DSH 的 **Plugins 页**，找到 `dsh-connect-sensenova-token-plan` 的插件卡（面板是页内的内联卡片，**不在侧边栏**）。
2. 在「积分额度」tab 点「连接商汤控制台」，填一次账号和密码，点登录。
3. 之后令牌自动续期，无需再操作。

登录失败时表单会直接显示商汤返回的原因（含「3 次错误锁 15 分钟」这类平台硬规则）；想清除账号，用面板底部的按钮。

## 它是怎么工作的

登录原理一句话：Host 在后台用商汤标准登录拿令牌并**自动续期**（refresh_token 到期前自动换新，所以不用你再输密码）；面板打开时才轮询一个只读本地路由，关掉即停。协议细节（OIDC/PKCE、密码 JWE 封包、防锁号节流）见 [docs/AUTH.md](docs/AUTH.md)，接口契约见 [docs/SENSENOVA-API.md](docs/SENSENOVA-API.md)。

## 把商汤模型接进 DSH（可选）

「接入 API」tab 的三张卡按"你为什么来这"排序，而不是按依赖排序：**语言模型**（注册 provider + 勾选推送哪些模型）、**出图工具**——两张都在最前且默认展开；**API Key** 收在最后（默认收起），它是前两张卡的前置条件，由它们指回来。

在「API Key」卡里粘贴 `sk-` Key 保存：Host 即以 `sensenova-token-plan` 之名注册 OpenAI 兼容 provider，模型列表随 `/v1/models` 自动刷新、可看图模型自动带图片输入，还能在「语言模型」卡勾选具体要推送哪些模型。Key 只进 DSH 凭据、面板永不回显。开关与勾选都在面板热生效，无需重启。细节见 [docs/SETUP.md](docs/SETUP.md) §3 与 [docs/PROVIDER-HOT-RELOAD.md](docs/PROVIDER-HOT-RELOAD.md)。

## 出图工具（可选，默认关）

面板「出图工具」卡（在「语言模型」下方，默认展开）打开开关后，Host 给 agent 注册工具 `sensenova_draw_image`（首选模型由 `drawModelId` 指定），鉴权走同一把 `SENSENOVA_API_KEY`。出图模型由 catalog 的 `output_modalities` 结构化判定，不靠名字正则。注意：工具的实际挂载 / 缺席发生在**下一次 Host 启动**（agent tools 没有 unregister 语义），开关值本身立即生效。

## 第二个上游：小浣熊（可选，默认关）

面板「小浣熊」tab 用微信扫码登录 `xiaohuanxiong.com`，并以 provider id `sensenova-raccoon`（显示名 SenseNova Raccoon）注册**独立** provider。登录后显示积分余额与模型清单，每个模型带**上下文窗口 / 最大输出**与积分倍率（`free` / `×0.75` 这类，由网关目录声明；目录没给就不显示，不猜）。它与 Token Plan 同属**商汤（SenseTime）旗下**的两条产品线，所以放在同一个 `sensenova` 插件里顺理成章；但两者的**认证域与积分口径互不相通**（那边是独立余额，这边是 5 小时 / 每周额度池），凭据也各走一套——它不是 Token Plan 的第二条登录路径，实测依据见 [docs/ROADMAP.md](docs/ROADMAP.md) §6.1.1。

## 运维诊断：这台机器现在挂没挂 provider？

provider / 出图开关的生效值存在插件私有状态文件里（`$DSH_HOME/state/<name>/`），不在任何配置或路由上——查"到底开没开"用 doctor，它只读状态文件、不碰凭据，Host 没起也能跑：

```powershell
npm run doctor          # 人读：每个 profile 的 provider / draw 开关与模型清单
npm run doctor:json     # 机器读：JSON（可进你的巡检 / 工单脚本）
```

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构与数据流
- [docs/SETUP.md](docs/SETUP.md) — 配置字段、改动后重启、常见信号
- [docs/AUTH.md](docs/AUTH.md) — 登录 / 续期 / 节流设计
- [docs/API.md](docs/API.md) — 路由与控制台端点
- [docs/TESTING.md](docs/TESTING.md) — 测试体系
- [docs/SENSENOVA-API.md](docs/SENSENOVA-API.md) — 商汤接口全集（实测）
- [docs/PITFALLS.md](docs/PITFALLS.md) — 真实踩坑（33 条）
- [CHANGELOG.md](CHANGELOG.md) — 版本变化

AI 协作会话请先读 [AGENTS.md](AGENTS.md)。

## 诚实声明

- 面板显示的是**控制台自己的口径**，与网页控制台一致；`GET /v1/models` 只区分权限，不计费也不占推理额度；
- 续期在令牌过期前触发；若 refresh_token 被吊销且环境里已无密码，面板会明确提示重新登录，而不是静默显示旧数据；
- 凭据（账号、access/refresh token）只经 DSH 凭据服务保存，**密码不落盘**；本插件不写任何明文凭据文件或调试日志。

## 许可证

MIT License（Copyright (c) 2026 eghrhegpe），全文见 [LICENSE](LICENSE)；第三方依赖与合规说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

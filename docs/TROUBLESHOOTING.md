# 按症状排查（Troubleshooting）

本文件是**按你看到的现象**组织的入口，不是按主题。其他文档回答"这个功能怎么设计的"，
这里回答"我看到 X，该怎么办"。

**为什么要有这个文件**（PITFALLS §25「形式门禁全绿，不代表文档说了实话」的另一半）：本仓库的
40 条坑每条都写了**现象**，文档索引却只按**主题**组织（"何时查 ROADMAP"）。于是把症状变成主题
需要有人**已经知道答案**——而那正是最不需要看文档的人。一句"额度那栏一直是空的"在按主题的
索引里无处落脚，只能靠全文搜索碰运气。所以症状在这里有一等公民的地位：有稳定症状码、能被
doctor 报出来、能双向钉住。

> **给 agent**：每条症状都有一个稳定的症状码（`quota-empty`、`needs-login`…），也出现在
> `npm run doctor --json` 的 `symptoms` 字段里。先跑 doctor 拿到症状码，再用下表跳到对应条目。
> 症状码的真源是 `src/host/codes.ts` 的 `SYMPTOM`，本文件的条目与之由
> `test/doctor.test.mjs` 双向钉住——**症状码出现在这里却没进 `SYMPTOM`（或反之），门禁即红**。

**先分清是哪一半的问题**（决定去哪找日志）：本插件是 Host 半边 + 浏览器半边，登录/节流/注册
失败在 Host（看 `dsh web` 终端 stdout 或 `$DSH_HOME/logs/sensenova-login-*.json`），面板渲染
问题在浏览器 bundle（多数被当数据渲染成面板文本，不进 F12）。详见 [SETUP.md](./SETUP.md) §7。

---

## A. 额度 / 积分栏

### A1. 额度栏是空的或显示"不可用" {#a1-额度栏是空的或显示不可用}

`quota-empty`

按这个顺序查（快照接口 `GET /api/<plugin>/snapshot` 一次就能看到前两层）：

1. **账号登录了吗** —— 面板「积分额度」tab 顶部。若显示登录表单，先填一次账号密码。
   快照里 `auth.configured` 为 `false` 即未登录。
2. **快照有没有报错** —— `auth.error` / `quotaError.code`：
   - `not_configured` → 从没登录过，回到第 1 步；
   - `refresh_rejected` / `jwt_expired` → 令牌死了，见 [B1](#b1-面板反复要求重新登录)；
   - `config_error` → 配置问题，见 [C3](#c3-面板顶部报配置错误)；
   - `console_error` → 商汤控制台没应答，通常下一轮轮询自愈；持续出现查网络。
3. **结构漂移了吗** —— 快照带 `shapeWarnings` 说明控制台返回的字段变了（如改名）。对照
   [SENSENOVA-API.md](./SENSENOVA-API.md) 核对字段——这是"接口变更"的第一信号，不是"暂无数据"。
   根因与判别见 [PITFALLS.md](./PITFALLS.md) §12（shape 漂移检测）。

### A2. 「可看图」一行缺失 / 清单为空 {#a2-可看图一行缺失}

- **缺整行** → 没有 API key，模型目录没拉（`catalogAvailable: false`）。在面板「接入 API → API Key」
  粘贴 `sk-` Key 保存，或在用户级 env 配 `SENSENOVA_API_KEY`。下一轮 poll 自动亮起，无需重启。
- **行在但清单空** → 商汤当前确实没有模型声明 `input_modalities` 含 `image`（2026-09 起每个模型条目都带
  该字段）。对照 catalog 里各模型的 `input_modalities` 实际值。

## B. 登录 / 模型接入 / 出图

### B1. 面板反复要求重新登录 {#b1-面板反复要求重新登录}

`needs-login` · `login-refused`

refresh_token 被吊销（或已过期）且环境里已无密码可自动续期。面板**不会**静默显示旧数据，会明确
要求重登。处置：在面板表单填一次账号密码。设计见 [AUTH.md](./AUTH.md)；refresh token 每次刷新
都会被轮换、只存 access token 的后果见 [PITFALLS.md](./PITFALLS.md) §5。

被拒分三类，别一概重试（重试只会把错密码撞成锁号——[PITFALLS.md](./PITFALLS.md) §6）：

| 面板说的 | 含义 | 怎么做 |
|---|---|---|
| 账号锁定 / 限频（带倒计时） | **时间型** | 等平台窗口；插件已按平台声明的窗口计时，**别手动重试** |
| 账号或密码不正确 / 需验证码 | **凭据型** | 插件**完全不自动重试**，重填正确账号密码 |
| `invalid_grant` 之类 | refresh 已死 | 重填一次（回到本节开头） |

### B2. 模型列表里没有商汤模型 {#b2-模型列表里没有商汤模型}

`provider-missing`

1. 面板「接入 API」里的 **provider 开关**打开了吗（默认关）？
2. Host 有 `llm` 服务吗？快照 `llm.providerRegistered` 为 `false` 而开关为 `true` 时，看 Host
   日志里 peer 加载失败——按本插件的降级纪律，**该模块缺席、面板照常用**，不是整个面板失效
   （[ARCHITECTURE.md](./ARCHITECTURE.md) §5.2）。
3. **用 doctor 确认磁盘上的生效值**（开关存在状态文件，不在任何配置或路由上）：
   ```powershell
   npm run doctor          # 每个 profile 的 provider / draw 生效值
   npm run doctor:json     # 机器读，含 symptoms 症状码
   ```
   出现 `state-unreadable` 症状码 → 见 [C2](#c2-状态文件读不出来或开关对不上)。

provider 注册与撤回的热生效设计见 [PROVIDER-HOT-RELOAD.md](./PROVIDER-HOT-RELOAD.md)。

### B3. 某个模型没出现 / 出图工具没挂上 {#b3-某个模型没出现或出图工具没挂上}

`tool-or-model-missing`

- **出图工具**：开关生效 ≠ 工具已挂载。agent tools 没有 unregister 语义，**工具的实际挂载/缺席
  发生在下一次 Host 启动**——改了开关要完全重启 DSH 才见效（[README](../README.md)「出图工具」节）。
  无 tools 服务或 peer 加载失败时工具**静默缺席**（面板会给出对应一行说明，不是 bug）。
- **单个模型没出现**：在「语言模型」卡的勾选清单里被取消推送了。清单是**允许清单**，空=不过滤；
  想"一个都不推"要用哨兵值，语义见 [PROVIDER-HOT-RELOAD.md](./PROVIDER-HOT-RELOAD.md) §6。

## C. 装了改了却不生效 / 状态对不上

### C1. 改了代码但面板没变 {#c1-改了代码但面板没变}

`stale-code`

**Host 半边（`index.ts` / `sensenova-auth.ts` / `token-store.ts` 等）只在 DSH 启动时加载一次。**
改完必须**完全退出 DSH（含托盘）再启动**；只改浏览器半边（`src/client/`）刷新页面即可。

自查在跑的是不是新代码——看快照有没有 `auth` 字段：

```powershell
(Invoke-RestMethod http://127.0.0.1:19387/api/dsh-connect-sensenova-token-plan/snapshot).auth
```

没有 `auth`（而是 `totals`/`recent` 之类）→ **跑的还是旧代码**，重启。完整说明见
[SETUP.md](./SETUP.md) §4；这条坑的两个 profile 变体见 [PITFALLS.md](./PITFALLS.md) §8 与 §22
（本机可能同时有桌面版与 `dsh web` 在跑，用的不是同一份代码、也不是同一个 profile）。

> 源码改了但产物没重建也会这样：改 `src/` 后要 `npm run build` 并把 `lib/`、`client.js` 与源码
> **一并提交**（ADR-005；CI 的 `build-freshness` 门禁就是钉这一条）。

### C2. 状态文件读不出来或开关对不上 {#c2-状态文件读不出来或开关对不上}

`state-unreadable`

`doctor` 报 `unreadable state: xxx.json`，或"面板明明开了、doctor 却说不通"：

- **写侧版本护栏**：状态文件带 `version`，本构建只认自己那几个版本；磁盘上是**更新的版本**时
  **拒绝覆盖**（裁定见 [ADR.md](./ADR.md) ADR-006）。这是保护不是故障——通常是升级中途。
- **别手改这些 JSON**：用面板开关改（它走原子写 + 版本校验）。
- **profile 分段**：状态在 `$DSH_HOME/state/<profile>/<name>/`，取不到 profile 名时才退回
  `$DSH_HOME/state/<name>/`。doctor 会把两者都列出来；同一台机器跑着两个 profile 时，别看错那一份
  （[PITFALLS.md](./PITFALLS.md) §23）。

### C3. 面板顶部报配置错误 {#c3-面板顶部报配置错误}

`config-error`

配置面（`cordis.patch.yml`）里的端点类字段不是合法 http(s) 绝对地址时，插件在**挂载时**就报
`config_error`（而不是第一次轮询才变成莫名的网络错误）。对照 [SETUP.md](./SETUP.md) §3 的字段表，
改后重装/重载 Host。另一个坑：嵌套的 `auth:` 块会被**静默忽略**，端点字段必须是 patch 行的
**顶层键**（[AGENTS.md](../AGENTS.md) 红线 3 曾因此打到真平台）。

---

## 还有别的问题？

- 想知道**为什么**会有某个设计（不只是怎么办）：[PITFALLS.md](./PITFALLS.md)（40 条
  现象→根因→修法）、[ARCHITECTURE.md](./ARCHITECTURE.md)（结构与数据流）。
- 想改配置字段：[SETUP.md](./SETUP.md) §3；想对接协议：[AUTH.md](./AUTH.md)、
  [API.md](./API.md)。
- 找不到对应症状？本文件由症状码（`src/host/codes.ts` 的 `SYMPTOM`）钉住，新增/改名时两处一起改，
  门禁会拦下只改一处的情况。
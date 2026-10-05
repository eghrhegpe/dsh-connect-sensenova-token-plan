# 接口与端点（API）

分两层：本插件向 Harness Web UI 暴露的**本地路由**，以及它反向调用**商汤控制台**的接口。

---

## 1. 本插件路由（Host 半边注册）

七条路由都经过**同源校验**：带 `Origin` 的请求必须与 Host 同源，因此只有本机 DSH 自己提供的页面能写入账号或 Key。请求体上限 **4 KB**。

### `GET /api/dsh-connect-sensenova-token-plan/snapshot`
面板轮询的聚合结果。返回体（HTTP 恒为 200，成败靠 body 区分）：

```jsonc
{
  "ok": true,
  "now": 1790529234603,
  "consoleBase": "https://platform.sensenova.cn",
  "cacheSeconds": 60,
  "pollSeconds": 30,
  "auth": {
    "configured": true, "hasAccount": true, "hasRefreshToken": true,
    "needsAccount": false, "ephemeral": false,
    "retryAfterMs": null, "needsUserAction": false,
    "expiresAt": 1790529234603, "error": null
  },
  "catalogAvailable": true,
  "catalogModels": ["sensenova-6.8-flash-lite", "..."],
  "visionModels": [/* 可看图模型（仅 catalogAvailable 时返回，否则省略） */],
  "pools": { "plan": {...}, "pools": [/* 每池 5h/7d 窗口、返赠、callableModels / lockedModels */] },
  "trend": { "hours": 24, "models": [/* 每模型消耗；命中 trendMultipliers 配置的行附 multiplier: number（伪倍率，非官方） */] },
  "uncountedModels": [/* 在模型目录但不在任何池中的模型 */],
  // 控制台不可达（未登录 / 令牌被拒 / 控制台故障）时非空：额度区显示原因并给出
  // 修复入口，API 与 Raccoon tab 不受影响；正常时为 null
  "quotaError": null,
  "llm": {
    // 推理 Key 状态（永远不回显 Key 本身）
    "hasApiKey": true, "keySource": "credentials", "ephemeral": false,
    // 直接注册开关 / Host llm 服务 / 当前是否已注册
    "registerProvider": false, "llmAvailable": false,
    "providerRegistered": false, "providerId": "sensenova-token-plan",
    // 实际注册了多少个（已按下面的允许清单过滤），以及其中多少个可看图；
    // thinkingDefault 是本提供方 profile 钉死的思考强度默认值（与 llm-adapter 同一
    // 常量）——provider 级常数，面板只在花名册头部说一次，不逐行重复
    "modelCount": 2, "visionCount": 1,
    "thinkingDefault": "high",
    // 模型选择器数据：整份可选目录（不受过滤影响）与当前生效的允许清单。
    // 空清单 = 不过滤 = 全部推送；["__hide_all__"] = 一个都不推送。
    // 每行附目录声明的 contextWindow / maxOutputLength（0 = 平台未声明）、
    // thinkingLevels（DSH 选择器实际可选档位，与 pi-ai getSupportedThinkingLevels
    // 同一规则算出；扩展档 xhigh/max 只对冻结契约表里实测过 200 的模型开放，
    // low/medium 按 2026-09-30 live-contract 探针的逐模型实锤结果开放：
    // flash-lite / v4-flash / glm-5.2 全开，deepseek-flash / kimi-k3 只开
    // medium，v4-pro 两格未定（429 限流未测成，重跑后翻表））；命中
    // trendMultipliers 的行再附 multiplier: number（伪倍率，非官方，与
    // trend 同一匹配器）。
    "models": [{ "id": "sensenova-6.8-flash-lite", "name": "sensenova-6.8-flash-lite", "vision": false, "contextWindow": 262144, "maxOutputLength": 65536, "multiplier": 1, "thinkingLevels": ["off", "low", "medium", "high"] }],
    "enabledModelIds": [],
    // 出图工具开关生效值与来源（0.4.2）；工具实际挂载在下一个 Host 启动时发生
    "drawEnabled": false, "drawSource": "config",
    // 一次出图调用实际会寻址的模型 id：用与工具本身相同的 pickDrawModel
    // 优先级（调用参数 > 配置的 drawModelId > 目录首个出图模型）从同一份
    // 目录算出，面板展示与工具行为不会分叉。目录缺席（无 Key）时整个字段缺席
    "drawModel": "sensenova-u1-fast",
    // 目录里 output_modalities 含 image 的条目：自动选择藏掉同侪时，候选让它可见
    "drawCandidateCount": 2,
    "drawCandidateIds": ["sensenova-u1-fast", "sensenova-u1.5-lite"]
  },
  "shapeWarnings": [/* 控制台返回结构与预期不符时非空 */]
}
```

- 控制台不可达（未登录 / 令牌被拒 / 控制台故障）时快照**仍为 `ok:true`**：额度数据为空并携带 `quotaError: {code, message}`（`not_configured` / `jwt_expired` / `auth_error` / `console_error`）。额度区据此提示原因并给出登录入口；**接入 API 与 Raccoon tab 不依赖控制台登录**，照常可用。
- `ok:false` 仅剩配置错误（`config_error`）与意外抛错，body 带 `code` 与 `auth` 块。
- Host 内部：临近过期或收到 401 时自动用 `refresh_token` 续期并重试一次。
- `shapeWarnings` 非空说明控制台字段可能改名，面板会明说而非永远「暂无数据」。

### `GET /api/dsh-connect-sensenova-token-plan/account`
返回账号状态（**不含密码**）：`configured` / `hasAccount` / `hasRefreshToken` / `ephemeral` 等。

### `POST /api/dsh-connect-sensenova-token-plan/account`
两种用途，靠 body 区分：

- 保存账号：`{ "username": "...", "password": "..." }` —— 触发 OIDC 登录并落库。
- 清除账号：`{ "forget": true }` —— 仅删账号引用，保留仍有效的令牌。

非法 body（非对象、JSON 数组、超 4 KB）返回 400；跨域 POST 返回 403 且不写入任何账号。

### `GET /api/dsh-connect-sensenova-token-plan/api-key`
返回推理 Key 的**去密状态**（无 Key 值本身）：`hasApiKey` / `keySource`（`credentials` 凭据服务引用、`env` 环境变量、`memory` 无凭据服务时的进程内存、或 `null`）/ `ephemeral`。

### `POST /api/dsh-connect-sensenova-token-plan/api-key`
两种用途，靠 body 区分：

- 保存 Key：`{ "apiKey": "sk-..." }` —— 以 `SENSENOVA_API_KEY` 引用写入 DSH 凭据服务（与手写 `llm-pi-ai` 行读取的是同一个引用名）；进程环境变量仍是兜底来源。下次轮询用新 Key 拉取模型目录并（开关开启时）重建已注册的 provider。
- 清除 Key：`{ "forget": true }` —— 仅删面板保存的引用并清空私有 catalog 缓存；环境变量 `SENSENOVA_API_KEY` **不**受影响，已注册 provider 的模型列表被清空。

响应同样只含去密状态；非法 body 返回 400，跨域 POST 返回 403。任何响应都不会回显 Key 明文。

### `GET /api/dsh-connect-sensenova-token-plan/provider`
提供方注册开关的去密状态：`registerProvider`（**生效值**）、`registerSource`（`panel` 面板保存过 / `config` 沿用配置默认）、`providerRegistered`（当前是否真的注册着），注册失败时附 `providerError`。设计见 [PROVIDER-HOT-RELOAD.md](./PROVIDER-HOT-RELOAD.md)。

### `POST /api/dsh-connect-sensenova-token-plan/provider`
`{ "enabled": true|false }` —— 把开关写入插件私有状态文件并在**同一请求内**重新发布 provider（立即生效，无需重启）。优先级：面板保存的值 > `cordis.patch.yml` 的 `registerProvider`。非布尔 `enabled` 返回 400；跨域返回 403。

### `POST /api/dsh-connect-sensenova-token-plan/models`
`{ "enabledModelIds": ["model-a", ...] }` —— 替换本 Key 的**模型允许清单**：勾选后保存到私有 catalog 状态文件，并在**同一请求内**重新发布 provider（面板不需要等下一次轮询）。

清单语义与 `filterByEnabled` 一致：

- **空数组 `[]`** = 不过滤，目录里的模型全部推送；
- **非空数组** = 严格允许清单，只推送列出的模型；
- **`["__hide_all__"]`** = 一个都不推送（临时全部收起用的哨兵；空数组已表示「未筛选」，需要一个不同的写法表达「筛选后一个都不剩」）。

返回 `{ ok, enabledModelIds, registerProvider, providerRegistered, providerError? }`，不含模型明文号与 Key。缺字段 / 非数组 / 超过 500 项返回 400 且不写入任何值；跨域返回 403。清单只影响**推送给 DSH 的选择器**，`snapshot` 里的 `catalogModels` / `llm.models` 仍是整份目录，面板据此展示可勾选项。

### `GET /api/dsh-connect-sensenova-token-plan/draw`
出图工具开关的去密状态：`drawEnabled`（**生效值**）、`drawSource`（`panel` 面板保存过 / `config` 沿用配置默认）。设计见 [PROVIDER-HOT-RELOAD.md](./PROVIDER-HOT-RELOAD.md) §7。

### `POST /api/dsh-connect-sensenova-token-plan/draw`
`{ "enabled": true|false }` —— 把出图开关写入插件私有状态文件（`$DSH_HOME/state/<profile>/<plugin>/draw.json`，按 profile 分段、见 [PITFALLS.md](./PITFALLS.md) §23），与 `/provider` 走的是同一套「存私有状态」机制，但**不触发任何即时发布**——agent 工具的实际注册/缺席发生在下一个 Host 启动（或重新安装）时，由 `lifecycle.ts` 的 `startSideEffects` 重读生效值。优先级：面板保存的值 > `cordis.patch.yml` 的 `drawEnabled`。非布尔 `enabled` 返回 400；跨域返回 403。

`{ "drawModelId": "sensenova-u1.5-lite" }`（或 `null` = 自动选择）—— 把出图模型偏好写入同一个 `draw.json`。生效时机与开关相同：`startSideEffects` 在下一次挂载时用它覆盖 `cordis.patch.yml` 的 `drawModelId`（优先级：面板 > 配置；面板清除后回落配置，配置也为空则自动取目录第一个出图模型）。非空字符串之外的非 null 值返回 400；跨域返回 403。`{ "forget": true }` **仅清除出图开关**的面板保存值，并**刻意保留**模型偏好——`src/host/draw-store.ts` 的 `forget()` 用现有 `modelId` 重写该行，重置模型偏好的入口是显式传 `drawModelId`（`src/host/routes/draw.ts` 未暴露 `forgetModel`）；别把 `forget` 读成「重置全部」。

---

## 2. 商汤控制台接口（插件反向调用）

| 接口 | 方法 | 用途 | 认证 |
|---|---|---|---|
| `https://platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage` | GET | 各积分池 5h / 7d 窗口、返赠余额与到期 | `Bearer <JWT>` |
| `credit-usage-trend`（同前缀） | GET | 近 N 小时每模型积分消耗 | `Bearer <JWT>` |
| `GET https://token.sensenova.cn/v1/models` | GET | 套餐覆盖模型里本 Key 真正能调哪些（只读、不计费、不占推理额度） | `Bearer <SENSENOVA_API_KEY>` |

池返回结构含 `name`、`model_ids`、`window_5h` / `window_7d`（各带 `limit` / `used` / `remaining` / `reset_at`）、`grant_balance`、`nearest_grant_expiry`、`pool_type`（default / dedicated）。额度数值完全来自控制台 API，插件不做任何推算。

登录相关端点见 [AUTH.md](./AUTH.md)：授权端点（`consoleBase` + `/oauth2/auth`）、令牌端点（`tokenEndpoint`）、JWKS（`jwksEndpoint`）、IAM（`iamBase`）。

---

## 3. 配置端点清单（cordis.patch.yml）

完整字段与默认值见 [SETUP.md](./SETUP.md) §3。端点类字段（`consoleBase` / `apiBase` / `iamBase` / `tokenEndpoint` / `jwksEndpoint` / `redirectUri`）仅在企业镜像或预发环境指向别的主机时才需改动；任意非法 http(s) 绝对地址会在挂载时报 `config_error`。

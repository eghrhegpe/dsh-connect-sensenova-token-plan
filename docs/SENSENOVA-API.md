# 商汤 SenseNova 接口文档（SenseNova API）

本插件与上游 Python 工具（`upstream/`，见 §6）都围绕同一套商汤控制台接口。本文把它们集中记下，避免散落在代码注释里。

> 一切以商汤平台实际返回为准；下文字段名来自本插件 `parsers.ts` 的真实解析逻辑（`parsePools` / `parseTrend`）与 `sensenova-auth.ts` 的登录流。**接口如有改名，本插件通过 `shapeWarnings` 提示，而非静默显示「暂无数据」——所以改接口第一信号是面板顶部冒出「接口缺字段」提示，不是空白。**

---

## 0. 官方参考原文（一手信源，逐字）

> 以下为商汤官方接口文档的**逐字原文**，按原文件名归档于 `sensenova-api-reference/` 目录。本插件**不转述、不删改**这些文件——它们是 `codes.ts` / `parsePools` 判据的对照依据。下文各节的「以实测为准」结论是我们的注释层，若与官方原文冲突，以本插件实测为准（详见 [PITFALLS.md](./PITFALLS.md) §20、§21），请勿用原文覆盖实测注释。

| 文件 | 内容 |
|---|---|
| [1、快速开始.md](./sensenova-api-reference/1、快速开始.md) | 快速开始 |
| [2、SenseNova 6.8 Flash Lite.md](./sensenova-api-reference/2、SenseNova 6.8 Flash Lite.md) | SenseNova 6.8 Flash Lite |
| [3、SenseNova U1.5 Lite.md](./sensenova-api-reference/3、SenseNova U1.5 Lite.md) | SenseNova U1.5 Lite |
| [4、SenseNova U1.5 Fast.md](./sensenova-api-reference/4、SenseNova U1.5 Fast.md) | SenseNova U1.5 Fast |
| [5、DeepSeek V4 Flash.md](./sensenova-api-reference/5、DeepSeek V4 Flash.md) | DeepSeek V4 Flash |
| [6、DeepSeek V4.1 Flash.md](./sensenova-api-reference/6、DeepSeek V4.1 Flash.md) | DeepSeek V4.1 Flash |
| [7、GLM-5.2.md](./sensenova-api-reference/7、GLM-5.2.md) | GLM-5.2 |
| [11、模型列表.md](./sensenova-api-reference/11、模型列表.md) | 模型列表 |
| [12、基础对话与流式输出.md](./sensenova-api-reference/12、基础对话与流式输出.md) | 基础对话与流式输出 |
| [13、思考模式与可用参数.md](./sensenova-api-reference/13、思考模式与可用参数.md) | 思考模式与可用参数 |
| [14、错误码.md](./sensenova-api-reference/14、错误码.md) | 错误码 |
| [15、接入方式.md](./sensenova-api-reference/15、接入方式.md) | 接入方式 |

## 1. 认证接口（拿到控制台 JWT）

控制台 JWT 约 **180 分钟**（`10800` 秒）有效。登录是标准 **OIDC 授权码流 + PKCE(S256)**，完整链路在 `sensenova-auth.ts`：

| 步骤 | 端点 | 方法 | 关键参数 |
|---|---|---|---|
| 1. 发起授权 | `https://platform.sensenova.cn/oauth2/auth` | GET | `client_id=nova`、`code_challenge`、`code_challenge_method=S256`、`redirect_uri`、`response_type=code`、`scope=openid offline offline_access`、`state` |
| 2. 取 login_challenge | 跟随最多 `maxHops`(默认 6) 跳 3xx 重定向 | GET | 从 URL 里抠 `login_challenge` |
| 3. IAM 登录 | `https://iam.sensecoreapi.cn/iam/authn/v1/auth/nova/login` | POST | `username`、`password`(见 §2 加密)、`challenge`、`is_encrypt:true`；带 `origin`/`referer` 为 console 源站、`cookie` 为第 1 步的 CSRF cookie |
| 4. 拿授权码 | 跟随回调重定向 | GET | 从 URL 抠 `code` |
| 5. 换令牌 | `https://signin.sensecore.cn/oauth2/token` | POST | `grant_type=authorization_code`、`code`、`code_verifier`、`client_id`、`redirect_uri`、`scope` |

- **刷新令牌**（插件核心，免去 3 小时手动换）：对 token 端点 `grant_type=refresh_token`、`refresh_token`、`client_id`、`scope`。Hydra **会轮换 refresh_token**——忽略返回的新 refresh_token 会导致下次刷新失败，所以本插件每次都落库新值。
- `scope` 必须含 `offline offline_access`，否则拿不到 refresh_token。
- JWKS（密码封包公钥）：`https://signin.sensecore.cn/.well-known/jwks.json`，key id `public:hydra.openid.id-token`。JWKS 的获取与缓存已迁到 `sensenova-crypto.js`：缓存**由调用方持有**（`createAuth` 每实例一份 `cfg.jwksCache`），内部再按 `jwksEndpoint` URL 分键——两个实例即便同 endpoint 也不共享；TTL 由 `JWKS_TTL_MS=600_000`（10 分钟）控制。

---

## 2. 密码加密（JWE）

账号密码绝不明文上网。封包方式固定为 **`alg: RSA-OAEP`（OAEP over SHA-1，不是 RSA-OAEP-256）+ `enc: A256GCM`**：

1. 从 JWKS 取公钥（`kid=public:hydra.openid.id-token`），`importKey` 时 `hash: "SHA-1"`；用 SHA-256/512 的变体 IAM 会拒。
2. 生成一次性 CEK(AES-GCM 256) + 12 字节 IV。
3. 用 CEK 以 A256GCM 加密密码（AAD = protected header 的 base64url 段，按 RFC 7516 §5.1 来，不是整段 JSON 文本）。
4. 用平台公钥以 RSA-OAEP 包 CEK。
5. compact 序列化：`header.encryptedKey.iv.ciphertext`（128-bit GCM tag 附在 ciphertext 后）。

`upstream/auth_login.py` 用 `jwcrypto` 做同样的事，可作对照实现。

---

## 3. 用量接口（面板数据源）

### 3.1 积分池 `GET /lite/console/v1/tokenplan/pool-usage`

需 `Authorization: Bearer <JWT>`。返回（本插件解析的关键字段）：

| 字段 | 说明 |
|---|---|
| `plan.id` / `plan.name` / `plan.type` | 套餐信息 |
| `pools[].name` / `pools[].id` / `pools[].pool_type` | 池名 / 池类型（`default` 通用池 / `dedicated` 专属池） |
| `pools[].model_ids` | 套餐覆盖的模型 id 列表 |
| `pools[].window_5h` / `window_7d` | 各含 `limit` / `used` / `remaining` / `reset_at`（epoch 秒字符串） |
| `pools[].grant_balance` | 返赠余额 |
| `pools[].nearest_grant_expiry` / `nearest_grant_expiring_balance` | 最近返赠到期时间 / 对应余额 |

- 数值字段控制台**用字符串返回**（如 `"12345"`），解析时按数字读；`reset_at` 等是 **decimal 字符串秒**，要 `epochSeconds()` 转整数秒。
- 只校验顶层 key（`plan`、`pools`），其余缺失字段宽容处理——这是 ``shapeWarnings`` 的来源。

### 3.2 消耗趋势 `GET /lite/console/v1/tokenplan/credit-usage-trend`

需 Bearer。查询参数：

| 参数 | 说明 |
|---|---|
| `start_time` / `end_time` | epoch 秒；本插件算为 `now - trendHours*3600` 到 `now` |
| `granularity` | `trendHours<=72` → `TOKEN_PLAN_CREDIT_TREND_GRANULARITY_HOUR`；否则 `..._DAY` |

返回 `series[]`，每项：

- `model_id`（缺时回落 `model_name`）作为模型标识；
- `points[]`，每点 `credits`（字符串）累加为该模型区间总消耗；
- 结果按消耗降序。

### 3.3 模型目录 `GET https://token.sensenova.cn/v1/models`

需 `Authorization: Bearer <API Key>`（**不是控制台 JWT**，是本机推理 API key）。**免费、只读、不计费、不占推理额度**。返回 `data[].id` 列表——用来区分「套餐覆盖的 `model_ids`」与「当前 Key 真能调的模型」：差集即「需开通」的模型（`pool.lockedModels`）。API key 缺失时本插件只降级模型清单，不影响额度展示。

---

## 4. 错误码与登录拒绝分类

IAM 拒绝登录时返回 `google.rpc.Status` 信封：顶层 `message` 是泛化的（如 `InvalidArgument`），**真正原因在 `details[].reason`**（`invalidAccountOrPassword` / `accountLocked` / `tooManyAttempts` / `verificationRequired` …）。只读取顶层 message 会把锁号、限频全误判成「密码错」。

本插件 `rejectionCode()` 映射（小写字面匹配，忽略分隔符大小写）：

| 平台 reason（折叠后） | 插件 code | 面板行为 |
|---|---|---|
| `invalidAccountOrPassword` / `invalidCredentials` / `incorrectPassword` | `login_rejected` | 凭据型：绝不自动重试，请用户重填 |
| `accountLocked` / `accountDisabled` / `userLocked` | `account_locked` | 时间型：等平台声明窗口（照单全收） |
| `tooManyAttempts` / `rateLimitExceeded` / `tooManyRequests` | `rate_limited` | 时间型：退避等待 |
| `verificationRequired` / `captchaRequired` | `verification_required` | 凭据型：需人工验证，停车等待用户 |

- 等待窗口来源优先级：`Retry-After` 头（秒）→ 消息正文（中英文都匹配，如 `try again after 8 minutes` / `请 8 分钟后重试`）；`分` 读作分钟（不是秒）。
- **平台声明的窗口永不截断**（哪怕 2 小时）；只有本插件自己发明的退避才受 `MAX_LOGIN_BACKOFF_MS`(默认 30 分钟) 上限。

---

## 5. 令牌生命周期相关错误

| 场景 | code | 处理 |
|---|---|---|
| 无账号 | `not_configured` | 快照额度区提示配置（不阻塞 API / Raccoon tab）；**不计入节流**（不是拒绝） |
| 缺 username/password | `missing_credentials` | 拒绝，不重试 |
| refresh_token 被吊销/失效（token 端点 400） | `refresh_rejected` | 回落密码登录；若无密码则报错 |
| refresh 其它失败 | `refresh_failed` | 抛出 |
| 控制台 401/403 后用新 token 仍拒 | `JWT_EXPIRED` | 面板提示需重登 |
| 取令牌阶段失败 | `jwt`/`login_flow`/`jwks` 等 | 见 AUTH.md |

---

## 6. 上游 Python 工具（`upstream/`）简介

`upstream/` 是从 `~/.dsh/fork/sensenova-usage-dashboard` 移入、被 `.gitignore` 忽略的**独立 git 仓库**（线上：[shaobingtongzhi/sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard)；独立于本仓库历史）。它是本插件登录/用量逻辑的**原始参考实现**，专注桌面端：

- `dashboard.py`：pywebview 原生窗口 + 内置 HTTP 服务，每 5 分钟刷新，窗口内可配账号。
- `auth_login.py`：OAuth2 授权码 + PKCE + 密码 JWE 加密；JWT 过期后**用明文账号密码重登**。
- 凭据存 `accounts.json`（**明文用户名密码**，为支持自动重登——不要提交）。
- 构建：`build_mac.sh`（macOS `.app`）、`SenseNova用量查询.spec`（PyInstaller 单文件 exe）。

**与本插件差异（移植/对照用）：** 上游明文存密码、过期即重登、无节流分层；本插件零明文、refresh_token 静默续期、显式区分时间型/凭据型拒绝防锁号。接口字段与主流程两方一致，故 `upstream/` 可作为封包与字段语义的对照，但**不是本插件的依赖**，改动请在其独立仓库内进行（详见 [ARCHITECTURE.md](./ARCHITECTURE.md)）。

---

## 7. 推理接口（OpenAI 兼容 `chat/completions`）

本插件第三步以 provider `sensenova-token-plan` 直连 `https://token.sensenova.cn/v1` 注册 OpenAI 兼容适配器（见 [ARCHITECTURE.md](./ARCHITECTURE.md) §5.2 与 [SETUP.md](./SETUP.md) §3 的 `registerProvider`）。本节记录 **2026-09-29 对该端点的实测契约**（key 取凭据服务 `SENSENOVA_API_KEY`，共 24 个真实请求）。

> ⚠️ 官方「SenseNova 6.8 Flash Lite」页的 OpenAI 段与平台实际行为**多处不符，且各家模型文档互相矛盾**（GLM 页明说 `thinking.type:disabled` 会失败、实测可用；DeepSeek 页与 flash-lite 页都列 `reasoning_effort:"max"`、实测 flash-lite / v4-flash 都 400）。**一律以本节实测为准**，详见 [PITFALLS.md](./PITFALLS.md) §20 与 §21。

### 7.1 模型目录 `GET /v1/models`

需 `Bearer <API Key>`，无鉴权实测返回 **401**。返回 `data[]`，`console-client.ts` 把每条**整条原样保留**（`{ id, ...source }`），本插件已知字段：

| 字段 | 实测示例（sensenova-6.8-flash-lite） | 插件用处 |
|---|---|---|
| `id` | `sensenova-6.8-flash-lite` | 模型 id |
| `name` | 同 id | 展示名兜底 |
| `input_modalities` | `["text","image"]` | 看图判定（`identifyVisionModel` 只看 input） |
| `output_modalities` | `["text"]` | 出图模型（`sensenova-u1-fast`/`u1.5-lite`）是 `["image"]`，不算看图 |
| `context_length` | `262144` | **上下文窗口——`contextWindowOf` 的命名字段** |
| `max_output_length` | `65536` | 单次响应上限 |
| `supported_features` | `["tools","json_mode","reasoning"]` | 全部模型都有此三特性 |
| `supported_sampling_parameters` | `["temperature","stop"]` | 只有这两项 |
| `pricing` | 全 `"0"` | 与插件 `NO_COST` 零值哨兵一致（额度池计费，无单 token 价） |
| `quantization` | `"fp8"` | — |

实测目录共 9 个模型：`deepseek-v4-flash`、`glm-5.2`、`sensenova-u1-fast`、`sensenova-6.8-flash-lite`、`sensenova-u1.5-lite`、`deepseek-v4-pro`、`kimi-k3`、`deepseek-flash`、`deepseek-v4.1-flash`。

### 7.2 请求参数（实测）

| 参数 | 实测 | 备注 |
|---|---|---|
| `model` | ✅ | 固定用目录 id |
| `messages[].role` | ✅ `system`/`user`/`assistant`/`tool` | **没有 `developer`**——`role:"developer"` 实测 400，即 `supportsDeveloperRole:false` 的依据 |
| `max_tokens` | ✅ | 上限即目录 `max_output_length` |
| `stream` | ✅ | SSE；`delta` 含 `content`/`reasoning`/`role` |
| `stream_options.include_usage` | ✅ | 流末块带完整 `usage` |
| `reasoning_effort` | ✅ `low/medium/high/xhigh/none` | 平台报错列表是**并集**，各模型支持面不同，见 §7.5/§7.6；默认 high（思考开）；`none` 关思考（无思考字段、`reasoning_tokens=0`） |
| `response_format:{"type":"json_object"}` | ✅ | 官方提示：与思考模式不建议同开 |
| `tools` + `tool_choice:"auto"` | ✅ | `finish_reason:"tool_calls"`，`message.tool_calls` 正常返回；DeepSeek 系带 tools 须回传历史 `reasoning_content`（§7.6） |
| `temperature` / `stop` | ✅ | 目录声明仅此两项 |
| `thinking`（object 形态） | ✅ deepseek-v4-flash / glm-5.2 | `{"type":"enabled"/"disabled"}` 实测有效（disabled → `reasoning_tokens=0`）；v4.1-flash 文档自述支持；flash-lite 当天模型抖动未测成 |
| `thinking`（字符串形态） | ❌ **全线 400** | `"enabled"`/`"disabled"`/`true`/`false` 在 flash-lite / deepseek-v4-flash / glm-5.2 上全部 400——官方文档当字符串写是错的 |
| `reasoning_effort:"max"` | ⚠️ 看模型 | glm-5.2 实测 **200**；flash-lite / deepseek-v4-flash 实测 **400**；v4.1-flash 文档自述原生支持（该 Key 套餐 403 未测） |

### 7.3 响应结构（实测）

- 顶层：`id`、`created`、`model`、`object:"chat.completion"`、`request_id`。
- `choices[0].finish_reason` ∈ `stop` / `length`（达 max_tokens 或上下文上限）/ `tool_calls` / `content_filter`。
- `choices[0].message`：`role`、`content`；思考开时**字段按模型家族分家**——flash-lite 吐 `reasoning`，deepseek/glm/kimi 家族吐 `reasoning_content`（官方 DeepSeek/GLM 文档确认，实测键集一致，见 §7.5）；调工具时有 `tool_calls[]`（`id`/`type`/`function{name,arguments}`）。
- `usage`：`prompt_tokens`/`completion_tokens`/`total_tokens`，`completion_tokens_details.reasoning_tokens`、`prompt_tokens_details.cached_tokens`。

**思考模式的真实代价**（2026-09-29 实测，同一极小 prompt）：默认（high）1044ms / prompt 88 tokens、`reasoning` 78 字、`reasoning_tokens` 43；`none` 361ms / prompt 62 tokens——默认思考每请求**多烧约 26 个 prompt token、慢约 2.9 倍**。本插件 descriptor 已设 `reasoning:true` + `thinkingLevelMap`（profile 默认 `high`），DSH 思考强度选择器照常工作：思考透出由 pi-ai 读 `reasoning`/`reasoning_content` 两种拼写完成（见 [PITFALLS.md](./PITFALLS.md) §21），不再有"思考被吞"问题。

### 7.4 图像输入（实测）

`content` 为内容块数组时支持 `image_url`：公网 URL 与 `data:image/*;base64,...` 均可，实测都能正确识别（gstatic 风景图答出「蓝色湖泊+山脉+小岛」、1×1 base64 图答「纯蓝色图片」）。

**注意**：官方示例图 `https://www.sensenova.cn/marketing-home/showcase-hero.png` 实测直接请求 **400「inference request is invalid」且耗时约 91 秒**——该 URL 本机 HEAD 是 200 `image/png`，但体积 **4.28 MB**，是图太大、不是 URL 不可达。插件 `llm-adapter.js` 的 `requestImageMaxBytes: 1_048_576`（1 MB，dsh-llm 默认）比平台容忍度紧，超限图由插件本地处理，属正常保护。

### 7.5 逐模型实测（2026-09-29 初测，9 个目录模型；2026-09-30 目录漂移复核）

> **2026-09-30 目录漂移**（`live-contract` 首次实跑逮住，证据见基线 `driftLog`）：
> 平台把 `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-flash` / `glm-5.2` /
> `kimi-k3` / `deepseek-v4.1-flash` 六家的 `input_modalities` 由 `["text","image"]`
> **退回** `["text"]`；`sensenova-6.8-flash-lite` 仍为 `["text","image"]`。
> **推理响应方言不变**——glm-5.2 实测仍吐 `reasoning_content`（2026-09-30 复核），
> flash-lite 仍吐 `reasoning`。即：本表「思考字段」列与 `reasoning_effort` 支持面
> **不受此次目录改动影响**；受影响的是插件 vision 识别（`identifyVisionModel` 按
> `input_modalities` 判定，方向是宽松的「字段说有才算」，回退 `["text"]` 即六家
> 不再出现在 vision 清单——`test/contract.test.mjs` 已按刷新后的基线全绿）。
> 目录 `input_modalities` 是平台**声明**能力，不是实测结论；实测能力以本节「思考字段」
> 列与推理端点响应为准。

| 模型 | 对话可用 | 思考字段 | 实测备注 |
|---|---|---|---|
| `sensenova-6.8-flash-lite` | ✅ 200 | `reasoning` | 唯一吐 `reasoning` 的；当天曾整体 404「model is not found」（抖动，见 §7.6）；**2026-09-30 目录仍声明 `input_modalities:["text","image"]`** |
| `deepseek-v4-flash` | ✅ 200 | `reasoning_content` | 思考 ~20–32 rTok；`max` 400、`xhigh` 200；**2026-09-30 目录 `input_modalities` 回退 `["text"]`** |
| `deepseek-v4-pro` | ✅ 200 | `reasoning_content` | 思考 ~123 rTok（128 配额几乎全烧）；**2026-09-30 目录 `input_modalities` 回退 `["text"]`** |
| `deepseek-flash` | ✅ 200 | `reasoning_content` | **2026-09-30 目录 `input_modalities` 回退 `["text"]`** |
| `glm-5.2` | ✅ 200 | `reasoning_content` | `max` **200 有效**；思考极烧 token（一句话 126 rTok）；`thinking` object `disabled` 有效（官方文档说会失败，实测可用）；**2026-09-30 目录 `input_modalities` 回退 `["text"]`，推理仍吐 `reasoning_content`（复核 200）** |
| `kimi-k3` | ✅ 200 | `reasoning_content` | **超慢**：关思考 8s、开思考 14s（1 词回复）；**2026-09-30 目录 `input_modalities` 回退 `["text"]`** |
| `sensenova-u1-fast` | ❌ **404** | — | 图像生成模型，非对话（`output_modalities:["image"]`）→ 插件选择器已排除（`isChatModel`） |
| `sensenova-u1.5-lite` | ❌ **404** | — | 同上 |
| `deepseek-v4.1-flash` | ❌ **403** | — | 目录有、当前 Key 套餐未开通（面板「需开通」）；文档自述 `thinking` object 形态 + 原生 `max`（该 Key 403 未实测）；**2026-09-30 目录 `input_modalities` 回退 `["text"]`** |

### 7.6 家族差异与插件取舍

- **思考字段分家**：flash-lite → `message.reasoning`；deepseek-v4-flash/v4-pro/deepseek-flash/glm-5.2/kimi-k3 → `message.reasoning_content`。DeepSeek 系文档：**带 `tools` 时须回传所有历史 `reasoning_content`**（否则工具调用链路不完整）；不带 tools 时回传了也会被忽略。
- **`thinking` 参数**：字符串形态全线 400；object 形态 `{"type":"enabled"/"disabled"}` 在 deepseek-v4-flash / glm-5.2 实测有效（disabled → `reasoning_tokens=0`）；v4.1-flash 文档自述支持；GLM 官方文档称 disabled 会失败——实测可用（文档错）。
- **`reasoning_effort`**：平台报错列表 `low/medium/high/xhigh/none` 是**并集**，各模型支持面不同：`max` 仅 glm（实测 200）与 v4.1-flash（文档原生）支持，flash-lite / v4-flash 400；`xhigh` v4-flash 实测 200（文档称映射到 high）。
- **思考模式采样规则**（DeepSeek v4/v4.1 文档）：temperature / presence_penalty / frequency_penalty **不生效**（传入不报错）；top_p 思考模式最小 0.95、非思考固定 1.0。GLM top_p 默认 0.95。
- **`max_tokens` 默认（文档）**：flash-lite 65535；v4-flash 非思考 8K / 思考 64K（`max` 档 128K）；v4.1-flash 131072（范围 [1,393216]）；glm 64K（[1,128K]）。目录 `max_output_length` 是权威值（v4.1-flash 目录为 65536，与文档默认 131072 不符——以目录为准）。
- **U 系列不是对话模型**：`sensenova-u1-fast`/`u1.5-lite` 是图像生成（`output_modalities:["image"]`，独立 images 数组 API），对话端点 404。`llm-models.js` 的 `isChatModel` 按 `output_modalities` 把它们从**选择器 roster、descriptor 列表、注册计数**三处一致排除，杜绝「选了就 404」。
- **可用性抖动**：flash-lite 当天出现整体 404「model is not found」（连 `reasoning_effort:"high"` 对照都 404）。按错误码文档（§14）404 = 模型下线或不存在，遇到先查平台状态，不是参数语义。
- **目录声明 ≠ 实测能力（2026-09-30 复核）**：`input_modalities` 是平台的**声明字段**，插件 vision 识别（`identifyVisionModel`）按它判定（`"image"` ∈ `input_modalities` 才算看图，方向宽松——缺字段不算）。2026-09-29 初测时 6 家 DeepSeek/GLM/Kimi 系声明 `["text","image"]`，2026-09-30 平台把其中 5 家（`deepseek-v4-flash`/`v4-pro`/`deepseek-flash`/`glm-5.2`/`kimi-k3`，外加 403 的 `deepseek-v4.1-flash`）退回 `["text"]`，`sensenova-6.8-flash-lite` 仍声明 `["text","image"]`。**推理响应方言不受此次目录改动影响**：glm-5.2 复核仍 200 且吐 `reasoning_content`，flash-lite 仍吐 `reasoning`。即：目录回退只影响插件 vision 清单（5 家从「可看图」掉出），不影响思考透出。`test/contract.test.mjs` 按刷新后的基线（`visionInput:false`）全绿；`live-contract` 是抓这类目录漂移的护栏，红了先查基线 `driftLog`，再决定是否随平台刷新。

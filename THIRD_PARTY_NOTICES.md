# 第三方致谢与合规（Third-Party Notices）

本插件是**参考实现驱动的移植**，不是从零摸索。本文把参考对象点名到文件和组件级别，方便审查与合规核对。

## 1. 主参考实现：`upstream/sensenova-usage-dashboard`

线上：<https://github.com/shaobingtongzhi/sensenova-usage-dashboard>（Python 桌面工具，独立仓库）。本地副本在 `.gitignore` 忽略的 `upstream/sensenova-usage-dashboard/`，不随本仓库提交、不进包。插件构建期与运行期均不依赖它。

`src/host/sensenova-auth.ts` 模块头部原文：*"reference implementation this was ported from"*——登录流是该 Python 工具的 **TypeScript 重实现**，不是从零设计。

### 1.1 `upstream/sensenova-usage-dashboard/auth_login.py`（本插件 `sensenova-auth.ts` + `sensenova-crypto.ts` 的原型）

| 参考项 | 上游位置 | 插件对应 |
|---|---|---|
| IAM / 控制台 / Token / JWKS 四个 origin | `IAM_BASE` / `OIDC_AUTH` / `OIDC_TOKEN` / `JWKS_URL` | `AUTH_DEFAULTS.iamOrigin` / `consoleOrigin` / `tokenEndpoint` / `jwksEndpoint` |
| OAuth 参数 `client_id=nova`、`scope=openid offline offline_access`、`redirect_uri=console origin` | 同文件 | `AUTH_DEFAULTS.clientId` / `scope` / `redirectUri` |
| 密码封包算法 `RSA-OAEP(SHA-1) + A256GCM`、JWKS key id `public:hydra.openid.id-token` | `encrypt_password()` / `get_enc_pubkey()` | `sensenova-crypto.ts` 的 `sealPassword` + `AUTH_DEFAULTS.encKeyId` |
| PKCE S256 派生（`secrets.token_bytes(32)` → base64url → 43–128 字符） | `_pkce()` | `sensenova-crypto.ts` 的 `pkce` |
| User-Agent 字符串（Chrome 152 伪装串） | `_USER_AGENT` | `AUTH_DEFAULTS.userAgent` |
| 授权请求必须从 `platform.sensenova.cn` 发起（CSRF cookie 域绑定） | 顶部注释第 35–39 行 | `sensenova-auth.ts` 模块注释第 21–28 行（同一发现，同一定论） |
| 最多 6 跳重定向跟随、从 Location / meta refresh / JS 跳转里解析 code | `_follow_until()` | `sensenova-auth.ts` 的 redirect walk |
| `nova/login` 响应体读取 `redirect` 字段 | `login()` 第 234 行 | 同插件流程 |
| JWT `exp` 直接解码 payload 判断过期 | `dashboard.py` 的 `_jwt_exp()` | `sensenova-crypto.ts` 的 `readJwtExpiry` |
| `expires_in` 默认 10800 秒（180 分钟） | `login()` 第 280 行 | `AUTH_DEFAULTS.assumedTokenLifetimeSeconds` |

**差异（本插件做的增量，不属于参考范围）：**
- 上游明文存 `accounts.json`；本插件走 DSH 凭据服务，密码不落盘。
- 上游 JWT 过期后**用明文密码重登**；本插件用 `refresh_token` 静默续期（`refresh()` 是本插件核心）。
- 上游只写一份诊断日志；本插件有节流分层（时间型 vs 凭据型拒绝，防锁号）、trace 值级脱敏、`sanitize*` 一族。
- 上游没有 refresh_token 轮换处理；本插件每次落库新 refresh_token（Hydra 会轮换，忽略会挂）。

### 1.2 `upstream/sensenova-usage-dashboard/dashboard.py`（本插件用量层与快照的原型）

| 参考项 | 上游位置 | 插件对应 |
|---|---|---|
| 用量端点 `/lite/console/v1/tokenplan/pool-usage` | `POOL_USAGE_ENDPOINT` 常量 | `console-client.ts` 的同名路径 |
| 请求头 `Authorization: Bearer <JWT>`、`Referer: {API_BASE}/console` | `query_pool_usage()` | 同插件 `console-client.ts` |
| 积分池字段语义（`name` / `model_ids` / `window_5h` / `window_7d` 含 `limit`/`used`/`remaining`/`reset_at`、`grant_balance`、`nearest_grant_expiry`、`pool_type`） | README 的 API 节 + `dashboard.py` 的解析逻辑 | `parsers.ts` 的 `parsePools` 与 `docs/SENSENOVA-API.md` §3.1 |
| epoch 秒字符串 → 本地时间 | `ts_to_str()` / `ts_to_date()` | `parsers.ts` 的 `epochSeconds()` |

**差异：** 上游不做字符串→数值归一（直接 `f"{n:,}"` 格式化），本插件 `parsePools` 先 `Number()` 归一再格式化；上游不做形状漂移检测，本插件有 `checkShape` + `shapeWarnings`。

### 1.3 打包与工具脚本（未移植）

上游的 `build_mac.sh`、`SenseNova用量查询.spec`、`启动.bat` / `启动.sh` 等打包脚本本插件**未吸收**——Python 打包（PyInstaller / pywebview）与 Node 打包（tsdown / ESM bundle）机制完全不同，无迁移价值。README 提到的 `build_mac.sh` / PyInstaller `.spec` 经验仅作设计对照，见 `docs/ARCHITECTURE.md` §1 的对比表。

---

## 2. DSH 插件范式参考

本插件与 DSH connect 家族共用同一套加载协议、bundle 结构、peer 依赖、`cordis.patch.yml` 槽位。

- **README 范式**：`~/.dsh/fork/dsh-connect-qoder` 的 README——「这是一个 DSH 插件、如何被加载、bundle 结构、测试门禁」的完整写法（见 `docs/DSH-PLUGIN.md`）。
- **架构对齐**：provider settings 设计对齐 `dsh-connect-trae` / `dsh-connect-workbuddy` / `llm-qoder`，`imageModelIds` 等字段见 `docs/ARCHITECTURE.md` §5.1。
- **本地对照件**：`upstream/dsh-connect-workbuddy-main` 是同类插件 checkout，仅供结构对照，不进包、不 import。

均属于**设计 / 文档 / 接口层面的参照**，未复制代码。

---

## 3. 其它上游参考件（`upstream/` 内，均为 gitignored、不进包）

这些是「形态存在性证明」或对接点源码对照，本插件**未**从其代码复制，仅在设计决策中引用其事实：

| 目录 | 来源 | 用途 |
|---|---|---|
| `alaxrpg-dsh-sensenova-provider` | 社区插件（直接竞品：同样走商汤 OIDC+PKCE 注册 LLM provider） | §5.3 生态核实：证明「额度 + provider 合一」在 DSH 生态成立。其多 Key 轮换**不吸收**（Token Plan 同账号共享池、换 Key 不换池） |
| `dsh-draw-router` | 社区绘图路由插件 | 出图路由（§5.4 接法 B）对接点的源码对照：`buildEndpoint` 拼 `{base}/v1/images/generations`、`POST {model, prompt, n, response_format}`、`data[0].url / b64_json` 解析 |
| `deepseek-harness-codearts-master` | 多 provider 聚合登录插件 | 「自有登录 + 凭据服务」形态的完整先例；其小浣熊部分（微信扫码登录）事实见 `docs/ROADMAP.md` §6.1.1。跨 provider 泛化属 §5 不变量 3 界外，**不吸收** |
| `dsh-raccoon-work-old0.16` | 商汤小浣熊 Connect 旧版 | 小浣熊网关机制参考（信封→HTTP 状态翻译、桌面 App 登录态读取），仅机制参考，见 `docs/ROADMAP.md` §6.1 |
| `dsh-retry-boost` | 社区 429 自愈网关 | 429 自愈模块的同类先例：吸收其两条纪律（先分诊限频 vs 配额、降速退避），**不做多 Key 池化** |
| `st_rotator_client` | 独立 Python 进程版 429 轮换 | 同上，与 `dsh-retry-boost` 同源纪律 |
| `dsh-provider-quota` / `dsh-musage` | 聚合用量面板基准 | 面板 UX 基准（实时性、告警形态）；跨 provider 聚合属界外 |
| `mmx-quota-tool` | 实时积分面板 | 同上，作为面板形态对照 |
| `SenseNova AI API does` | 商汤官方接口文档副本 | **非受控副本**（`docs/sensenova-api-reference/` 是版本控制内的唯一副本，见 `docs/ROADMAP.md` §159） |

---

## 4. 随包第三方依赖

`package.json` 的 `files` 打包清单（由 `test/package.test.mjs` 的 import 闭包检查钉住）**不包含任何第三方代码**：

- `peerDependencies`（`react`、`@deepseek-ai/dsh`、`@deepseek-ai/dsh-credentials`）由 DSH Host 运行时在运行期提供，不随本插件安装或打包（见 `docs/DSH-PLUGIN.md` §2）；测试基建 `test/peer-roots.mjs` 就地解析它们，不引入新依赖；
- `react` 为 MIT 许可；`@deepseek-ai/*` 属 DSH 运行时发行物，其许可证以 DSH 官方发行版为准；
- `LICENSE` 与本文随包携带，但均为本项目自身文档。

引入新的第三方外部依赖或复用其他项目代码时，请同步更新本文件并遵守对应许可证要求。

---

## 5. 许可证

本项目采用 MIT 许可证，版权归属：Copyright (c) 2026 eghrhegpe。全文见 [LICENSE](./LICENSE)。

上述所有参考对象均为**独立仓库**，其许可证以其自身 `LICENSE` 为准；本插件未复制其代码（Python→TypeScript 的重实现除外，见 §1），不构成许可证约束下的再分发。

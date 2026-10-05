# 安装与配置（Setup）

本插件随 Host（桌面版或 `dsh web`）运行，没有独立启动入口。

---

## 1. 前置条件

- **Node.js ≥ 22**：仅用于跑测试（`npm test`），运行时由 Host 提供运行时，无需本机装 Node 来跑插件本身。
- **DSH 运行时**：插件装在某个 DSH profile 下，由 Host 在启动时加载 `index.ts` 等 Host 半边文件。
- **凭据服务**：Host 需具备 `@deepseek-ai/dsh-credentials` 能力，账号密码与令牌才能落库。没有它时面板仍可打开，但账号只存内存（重启需重登，见 [AUTH.md](./AUTH.md)）。

---

## 2. 安装

**Web 与桌面端通用**。由带 `plugin_manager` 的会话（Creator 模式）执行，或在 **Web 的「插件」页**粘贴同一 target；较新版本 CLI 为 `dsh plugin --profile <profile> add <target>`（`web` / `desktop` 皆可）。target 三种形态：

| target 形态 | 值 | 适用场景 |
|---|---|---|
| npm 包名（推荐） | `dsh-connect-sensenova-token-plan`（可钉版本，如 `dsh-connect-sensenova-token-plan@0.2.0`） | 普通用户，无需 clone |
| git 地址 | `https://github.com/eghrhegpe/dsh-connect-sensenova-token-plan` | 不经 registry 直接装（DSH 市场走 pnpm git-dep；`lib/` 与 `client.js` 已随仓库提交，装出来即带宿主入口，无需构建授权） |
| 本地路径 | 本检出目录的绝对路径（如 `~\.dsh\plugins\dsh-connect-sensenova-token-plan`） | 开发调试 |

```powershell
plugin_manager { action: "install_bundle", target: "dsh-connect-sensenova-token-plan" }
```

- npm 形态装的是预构建 tarball：本包无安装脚本、无打包依赖（DSH 运行时走 peer，由 Host 提供），不需要 `allowBuilds` 构建授权；
- 安装器依次询问 profile 配置的 registry 与备用源（默认含 `registry.npmmirror.com`）；刚发布的新版本在镜像源同步可能有几分钟延迟，官方源 `registry.npmjs.org` 立即可用；
- 安装后，Harness **Plugins 页**出现本插件的配置卡（页内内联，不是侧边栏入口）；首次打开会提示连接商汤控制台；
- **装完必须完全退出 DSH（含托盘）再启动**——Host 半边只在启动时加载一次；只改 `client.js` 时浏览器刷新即可。

### 环境隔离（历史注记）

2026-09-27 本插件曾作为**桌面端必需启动项**（`dsh.profile.bundles`），因往共享凭据库写入宿主不认识的 `kind: throttle` 记录，把桌面端直接炸到 startup failed（爆炸半径是整机插件全卡死）。该问题已修复——节流迁到插件自己的状态文件 `throttle-store.ts`（原子写、0600），凭据服务只认 `grant`/`api-key` 两种 kind（见 [PITFALLS.md](./PITFALLS.md) §6）。**2026-09-29 双端实测：web 与桌面端均可正常挂载运行，不再有任何 profile 限制。**

---

## 3. 配置

配置面就是本目录的 **`cordis.patch.yml`**，改完重新安装 / 重载生效；也可在 profile 的 `cordis.patch.yml` 里用 `- id: dsh-connect-sensenova-token-plan` 覆盖同名字段。

| 字段 | 默认 | 说明 |
|---|---|---|
| `consoleBase` | `https://platform.sensenova.cn` | 控制台源站（OAuth 授权起点 / 默认回调） |
| `trendHours` | `24` | 消耗趋势回看小时数（最大 168） |
| `trendMultipliers` | `{"glm-5.2":10,"kimi-k3":20,"sensenova":1,"deepseek":1}` | 消耗趋势的**伪倍率**（自定义对比用，非官方数据）：键为模型 id 的大小写不敏感子串（按书写顺序首个命中生效），值为正数。面板以 `×N` 角标显示并附「非官方」说明，消耗趋势与「模型接入」花名册用**同一匹配器、同一取值**；显式设 `{}` 可全部关闭。非法条目（键空 / 值 ≤0 或非数字）被静默丢弃 |
| `cacheSeconds` | `60` | Host 侧缓存秒数；面板脚注直接引用此值 |
| `pollSeconds` | `30` | 面板轮询间隔，由 Host 下发、面板跟随（不再硬编码 30s） |
| `allowedHosts` | — | 追加可信 `Host` 名（默认 `localhost` / `127.0.0.1` / `[::1]` / `::1`，只增不替；`[::1]` 是浏览器 IPv6 `Host` 头的常见形态，`hostName()` 专门保留括号） |
| `tokenSkewSeconds` | `120` | 提前多久续期，避免撞过期边界 |
| `apiBase` | `https://token.sensenova.cn/v1` | 推理 API 源站（模型目录） |
| `iamBase` | `https://iam.sensecoreapi.cn` | 接受加密密码的 IAM 源站 |
| `tokenEndpoint` | `https://signin.sensecore.cn/oauth2/token` | Hydra 令牌端点 |
| `jwksEndpoint` | `https://signin.sensecore.cn/.well-known/jwks.json` | JWKS 文档（密码封包公钥） |
| `redirectUri` | 同 `consoleBase` | OAuth 注册回调；Hydra 精确匹配 |
| `clientId` | `nova` | 控制台公开 client id |
| `scope` | `openid offline offline_access` | `offline_access` 是拿到 refresh_token 的前提 |
| `encKeyId` | `public:hydra.openid.id-token` | 密码封包用的 JWKS key id |
| `maxHops` | `6` | 登录重定向链最大跳数 |
| `loginTimeoutMs` | `20000` | 登录流程单次请求超时；`requestTimeoutMs` 是它的旧名，仍然认 |
| `consoleTimeoutMs` | `15000` | 单次控制台请求超时（`pool-usage` / `models`） |
| `writeImageModelIds` | `false` | 视觉第二步（§5.1）：**opt-in**，是否把识别出的可看图模型清单写进本插件自己的 DSH settings row（`imageModelIds` / `visionModels` 两个字段），供后续 LLM connect 插件读取。默认关，纯读信息层 |
| `registerProvider` | `false` | 第三步（§5.2）：**opt-in**，是否由本插件直接向 DSH 注册 OpenAI 兼容 LLM provider（id `sensenova-token-plan`，直连 `apiBase`）。开启后在面板「模型接入」保存 `sk-` Key 即可，catalog 轮询自动建/刷新模型列表，vision 模型自动带图片输入；catalog 与允许清单只存插件私有状态文件。默认关——注册模型源是 Host 级变更 |
| `drawEnabled` | `false` | 出图吸收（§5.4 接法 B）：**opt-in**，是否给 agent 注册 `sensenova_draw_image` 工具（POST `{apiBase}/images/generations`，用面板保存的 `SENSENOVA_API_KEY`）。出图模型由 catalog 的 `output_modalities` 结构化识别（不用名字正则），Key 每次调用现取；失败后 30s 冷却。默认关——agent 工具是 Host 级变更；无 tools 服务的 Host 上该工具静默缺席。0.4.2 起面板「模型接入」区有真开关（`POST /api/<name>/draw`），勾选保存后在插件私有状态文件里记录，立即生效、无需重启 Host；未动过面板开关的部署，行为与 `false` 一致 |
| `drawModelId` | `""` | 首选出图模型 id；留空 = catalog 里第一把出图模型（如 `sensenova-u1-fast`）。工具调用显式传 `model` 时以调用为准 |
| `drawTimeoutMs` | `120000` | 单次出图请求超时（出图模型很慢，别用对话级超时）；下限 5000 |
| `webSearchEnabled` | `false` | 小浣熊内置联网搜索（见 [ROADMAP.md](./ROADMAP.md) §6.1.7）：**opt-in**，向 `ctx.web` 注册 Raccoon 托管的 `web_search` provider，复用 Raccoon 凭据链，并按 commandcode 方式**接管** `searchProviderId`（防 `WEB_PROVIDER_AMBIGUOUS`），保存后即时生效、teardown 恢复被顶掉的后端。需 Host 暴露 `ctx.web` 服务，无则静默缺席 |

端点类字段仅在企业镜像 / 预发环境指向别的主机时才需要动；全部不配即等于平台默认值。任意端点覆盖若不是合法的 http(s) 绝对地址，插件在**挂载时**就报 `config_error`（面板顶部显示），而不是等到第一次轮询才变成莫名其妙的网络错误。

> 上表主机层字段的默认值（含 `allowedHosts` 的 `localhost`/`127.0.0.1`/`[::1]`/`::1`）统一定义在 `src/host/host-config.ts` 的 `CONFIG_DEFAULTS`（`src/host/index.ts` 仅 import 并在末尾再 export，非定义处），并由 `test/config.test.mjs` 与 `cordis.patch.yml` 双向钉住；auth 类字段留空即表示"使用平台默认"，其生效值定义在 `src/host/auth-config.ts` 的 `AUTH_DEFAULTS`（2026-10 从 `sensenova-auth.ts` 拆出，见该文件头注释），不在此重复。

---

## 4. 改动后必须重启 Host

**Host 半边（`index.ts` / `token-store.ts` / `sensenova-auth.ts`）在启动时加载一次。** 改完这些文件，运行中的 `dsh web` 不会自动重载，必须完全退出 DSH 再启动（**托盘也要退**）。只改 `client.js` 时，浏览器刷新页面即可。

自查是否跑的是新代码——看快照接口的返回：

```powershell
(Invoke-RestMethod http://127.0.0.1:19387/api/dsh-connect-sensenova-token-plan/snapshot).auth
```

- 有 `auth` 字段 → 新代码在跑；
- 没有 `auth`、而是 `totals` / `recent` 之类 → **跑的还是旧代码**，需要重启。

> 注意本机可能同时存在多个 dsh 进程：桌面版（默认 19387）与 `dsh web`（常见 3080）用的是**不同的 profile**。确认你打开的 GUI 连的是哪一个。

---

## 5. 首次使用

1. 打开 Plugins 页的插件卡，切到「积分额度」tab。
2. 点「连接商汤控制台」，填一次账号与密码，点登录。
3. 之后令牌自动续期，无需再操作。面板底部可清除已保存账号。

登录失败的排查见 [AUTH.md](./AUTH.md)。

---

## 6. 常见信号与处置

| 面板 / 接口信号 | 含义 | 怎么做 |
|---|---|---|
| 面板顶部 `config_error` | 配置面有非法端点地址等挂载期错误 | 检查 `cordis.patch.yml` 的端点类字段（§3），改后重装 / 重载 Host |
| 快照带 `shapeWarnings` | 控制台返回结构与预期不符（如字段改名） | 对照 [SENSENOVA-API.md](./SENSENOVA-API.md) 核对接口字段——这是接口变更的第一信号，不是「暂无数据」 |
| 面板 `console_error` | 控制台没应答 | 通常是下一轮轮询自愈；持续出现再查网络与控制台状态 |
| 快照接口没有 `auth` 字段 | 跑的还是旧代码 | 完全退出 DSH（含托盘）再启动（见 §4） |
| 面板提示需要重新登录 | refresh_token 被吊销且环境已无密码 | 面板表单填一次账号密码即可 |
| 面板「可看图」一行缺失，但 `/v1/models` 有模型 | 没有 API key，模型目录没拉（`catalogAvailable: false`），视觉清单随之不显示 | 在面板「模型接入（API Key）」区粘贴 `sk-` Key 保存（写入 DSH 凭据服务引用），或在用户级 env 变量层配 `SENSENOVA_API_KEY`；下一轮 poll 自动亮起来，无需重启 |
| 「可看图」清单为空但 catalog 有模型 | 平台当前没有一个模型声明 `input_modalities` 含 `image`（或平台该字段缺失） | 对照 `catalogModels` 里各模型的 `input_modalities` 实际值；商汤 2026-09 起每个条目都带此字段，空清单应是真的没有可看图模型 |

---

## 7. 报错去哪儿看：Host 侧日志 vs 浏览器控制台

排查报错的第一步不是按 F12，而是确认**报错在哪个进程**。本插件是两半（见 [ARCHITECTURE.md](./ARCHITECTURE.md)），两半的日志去向不同：

| 要查什么 | 跑在哪 | 日志去哪 |
|---|---|---|
| 登录 / 重登 / 令牌续期 / 节流 / provider 注册 / 出图工具注册失败 | Host（Node 进程，即启动 `dsh web` 的那个终端 / 桌面版主进程） | **服务器 stdout/stderr**，永远不进浏览器控制台；登录链路另见下方落盘 trace |
| 面板渲染决策（哪个区显示什么、降级文案） | 浏览器里的 React bundle | 理论上进 F12，但多数错误被当**数据**下发渲染进面板文本区（见下），不在控制台 |

### Host 侧：翻落盘 trace，别在 F12 里找

DSH 与插件都**没有内存环形日志（ring buffer）**；插件用**落盘 trace** 顶这个位——每一次登录尝试（**成功也算**，AGENTS.md 红线 5）都写一个文件：

- 位置与命名：`$DSH_HOME/logs/sensenova-login-<ISO时间戳>-<结果>.json`（`DSH_HOME` 默认 `~/.dsh`；`<结果>` 为 `ok` 或错误码）。
- 保留策略：同目录只留**最近 20 个**（有界轮转，等价一个磁盘环形日志）；权限 `0600`。
- 内容：只记脱敏形状，密码 / token / cookie / 授权码一律 `[REDACTED]`（脱敏在 `sensenova-auth.ts` 内做，见 [PITFALLS.md](./PITFALLS.md) §15）——凭据永不进 trace。

想实时看：tail 这个目录里最新的文件，或把启动 `dsh web` 的 stdout 重定向到文件再 `tail -f`。

> ⚠️ **文件名前缀是 `sensenova-login-`，不是 `agnes-login-`**（那是姊妹插件 `dsh-connect-agnes-token-plan` 的前缀）。按错前缀去 `tail` 会一条都找不到。

### 为什么面板报错只在文本框、不进浏览器控制台

不是 bug，是设计：快照路由 **HTTP 永远 200**，成败靠 body 里的 `ok` 与 `code` 区分（见 [ARCHITECTURE.md](./ARCHITECTURE.md) §3、[API.md](./API.md)）。错误被当**数据**（`quotaError.code`、`shapeWarnings`）下发、渲染成面板一行中性文案，而**不抛异常**——一旦抛出，一次读取失败会顺着 React 渲染树炸穿，把一个模块的缺席放大成整页失效。所以「控制台安静」是这套降级策略的表象，不是错误丢了。

因此：

- 排 **Host 侧**（登录 / 节流 / 注册）→ 看 `dsh web` 终端 stdout 或 `logs/sensenova-login-*.json`。
- 排 **面板渲染决策** → 对照 `decidePanelView` / `test/panel.test.mjs` 那套决策函数，比翻控制台快。

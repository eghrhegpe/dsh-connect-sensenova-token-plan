# 踩坑经历（Pitfalls）

把对接商汤控制台过程中真实踩过的坑记下来，按「现象 → 根因 → 修法」写。多数已写进代码，这里是为了**下次改的时候别再踩一遍**，也方便接手的人理解代码里那些「看起来多此一举」的防御。

---

## 1. 登录流必须从 console 源站发起，否则 CSRF cookie 取不到

- **现象**：授权码流走到回调时直接 `No CSRF value available in the session cookie`，流程死。
- **根因**：Hydra 的 CSRF cookie 绑定在**入口 host** 上。如果在 IAM 自己的源站（`iam.sensecoreapi.cn`）发起授权，回调时 cookie 不可达。
- **修法**：`AUTH_ENDPOINT` 强制为 `consoleOrigin + /oauth2/auth`（`https://platform.sensenova.cn/oauth2/auth`），IAM 登录请求才带 `origin`/`referer` 为 console 源站、并复用第 1 步收集到的 CSRF cookie。

---

## 2. 密码封包必须是 RSA-OAEP(SHA-1) + A256GCM

- **现象**：IAM 拒绝封包，登录失败。
- **根因**：平台用 `alg: RSA-OAEP`（即 OAEP over **SHA-1**）。用更「现代」的 `RSA-OAEP-256` IAM 直接拒。
- **修法**：`importKey` 时 `hash: "SHA-1"`；AAD 用 protected header 的 **base64url 段**（不是整段 JSON 文本），严格按 RFC 7516 §5.1 step 14。每次封包换新 CEK/IV。

---

## 3. 登录失败只读顶层 message，把锁号当密码错

- **现象**：账号被锁、被限频，面板却统一报「账号或密码不正确」，用户反复重试 → 锁死更严重。
- **根因**：IAM 返回 `google.rpc.Status` 信封，真正原因在 `details[].reason`，顶层 `message` 只是泛化的 `InvalidArgument`。
- **修法**：`rejectionCode()` 优先取 `details[].reason` 精确匹配（`invalidAccountOrPassword`/`accountLocked`/`tooManyAttempts`/`verificationRequired`…）， substring 扫描只作兜底，绝不伪造具体原因。

---

## 4. 401 不证明 token 过期，只是「被拒」

- **现象**：一次 401 后若直接甩掉 token 重登，会陷入刷新风暴或频繁登录。
- **根因**：401 可能来自并发 poll 各自持不同 token、或 refresh 还没轮换完。
- **修法**：401/403 时 `tokenStore.invalidate(token)` 标记该 token 被拒（有界集合，最多记最近 8 个），然后**只换新 token 重试一次**；重试仍拒才抛 `JWT_EXPIRED`。被拒 token 绝不再下发，避免 replay。

---

## 5. refresh_token 会被轮换，忽略新值下次就死

- **现象**：连续刷新后某次突然 `refresh_rejected`。
- **根因**：Hydra 每次刷新都发**新 refresh_token**，旧的直接失效。只拿 access_token 不存 refresh_token = 自毁。
- **修法**：每次 `refresh()` 都把返回的新 `refresh_token` 一并落库（`store(..., replacing)` 用 `modifyRecord` 串行化，避免多进程互踢）。

---

## 6. 自动重试把一次错密码变成锁号

- **现象**：面板开着过夜，错密码被每分钟重试，账号被锁。
- **根因**：平台几次失败就锁号；轮询里重发密码等于主动撞锁。
- **修法**：两类拒绝区别对待——
  - **时间型**（锁定/限频/故障）：等窗口；**平台声明窗口照单全收、绝不截断**（哪怕 2 小时），无窗口才本地指数退避 60s→2m→4m… 上限 30 分钟；窗口一到恰好探测一次。
  - **凭据型**（错密码/验证码）：**完全不自动重试**，面板请用户重填，只有用户主动提交才试。
  - 节流曾写进凭据服务（伪装成 `grant` 记录 + marker 字段），但凭据服务只认两种 kind，私有状态寄存在那里一条 typo 就会炸掉整台机器——现已迁到插件自己的状态文件（`throttle-store.ts`，原子写），**跨进程跨重启**生效：另一个 Host 进程不会在等待期继续敲门。旧凭据记录地址仅作一次性迁移读取。

---

## 7. 把 `not_configured` 当拒绝，导致新装就「需用户操作」

- **现象**：全新安装、从未填过账号，面板却如临大敌地要用户「处理」。
- **根因**：`not_configured` 根本不是拒绝——是「还没配过」，从没发过请求，谈不上「避免重复」。
- **修法**：`CREDENTIAL_REFUSALS` 集合**不含** `not_configured`，也不写 throttle 记录；只有真正发过请求被拒才记录节流。

---

## 8. 改 Host 半边不重启，跑的一直是旧代码

- **现象**：改了 `src/host/*.ts` 但没重新构建（或构建了没重启），刷新面板没变化。
- **根因**：Host 半边只在启动时加载一次，`dsh web` 不热重载。
- **修法**：**完全退出 DSH（含托盘）再启动**。自查：`(Invoke-RestMethod .../snapshot).auth` 有 `auth` 字段 = 新代码；没有 = 旧代码。注意桌面版(19387)与 `dsh web`(常 3080) 是不同 profile。
- 只改 `src/client/*.ts` 则 `npm run build:client` 重建 `client.js` 后浏览器刷新即可。

---

## 9. `_asar_extract/` 误入仓库污染提交

- **现象**：`git status` 一长串 `lib/main.js`、`renderer/*`、`welcome/*` 等 DSH 桌面应用内部文件。
- **根因**：有人把 `app.asar` 解包到插件目录并 `git add`，把 Harness 自身源码当插件代码提交了。
- **修法**：`git rm -r --cached _asar_extract` 停止跟踪（已做）。它不是本插件代码，且每次版本升级会产生几十万行 diff。

---

## 10. upstream 不该进本仓库历史 / 明文凭据

- **现象**：上游 Python 工具含 `accounts.json`（明文账号密码）和 `.workbuddy/`。
- **根因**：直接塞进插件仓库会污染历史、泄露凭据。
- **修法**：上游以**被忽略的 `upstream/`** 形式容纳（[shaobingtongzhi/sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard)，保留其独立 `.git` 与 remote——本地副本若丢 `.git`，`git clone` 该地址恢复），`.gitignore` 加 `/upstream/`，绝不 `git add upstream/`，也不碰它的 `accounts.json`。

---

## 11. 控制台数值字段是字符串，时间字段是 decimal 秒字符串

- **现象**：`limit`/`used` 直接当数字用得到 NaN；`reset_at` 显示成奇怪的大数。
- **根因**：控制台把数字**当字符串**返回，时间是 **epoch 秒的字符串**（不是毫秒）。
- **修法**：`credits()` 用 `Number()` 归一；`epochSeconds()` 转 `Number` 再 `Math.floor`，空/`0`/非法返回 `null`（避免把「无到期」误判成 1970 年）。

---

## 12. 形状漂移被读成「暂无数据」

- **现象**：平台改了返回字段，面板永远显示空。
- **根因**：解析器对缺失字段宽容，若顶层 key（`plan`/`pools`/`series`）改名，解析仍返回「能看懂的」，缺失部分静默消失。
- **修法**：`EXPECTED_SHAPES` 校验顶层 key，缺哪个就在快照里挂 `shapeWarnings`，面板顶部明示「接口缺字段 {api} {missing}」，而不是永远「暂无数据」。

---

## 13. 同源校验少一行，任意网页能往面板塞账号

- **现象**：潜在——任意站点可 POST 账号进用户面板。
- **根因**：snapshot/account 路由若不做 origin 校验，跨站请求可写账号。
- **修法**：`isAdmitted()`——带 `Origin` 的请求必须与 Host 同 host；`origin === "null"` 一律拒；无 `Origin` 的同源 GET 放行。account POST 还要校验 body ≤ 4KB、必须是对象（非数组/非 null）。

---

## 14. JWKS 缓存跨 tenant 复用会封错包

- **现象**：切到企业镜像/预发后密码封包用错公钥。
- **根因**：JWKS 缓存了上一个租户的密钥，新平台却用不同 key。
- **修法**：JWKS 缓存已从 `sensenova-auth.ts` 迁到 `sensenova-crypto.ts`，且**由调用方持有、非模块级单例**。`createAuth(overrides)` 每次在自带配置里挂一份独立缓存（`cfg.jwksCache = createJwksCache()`），`sealPassword(..., { cache })` 用它——所以两个实例即便指向**同一个** endpoint 也不共享密钥项；缓存内部再按 `jwksEndpoint` URL 分键，一个实例配多镜像也各归各。这一层之前只做了一半：auth 侧已 per-instance，crypto 侧仍是模块级 `Map`，跨实例照样串味，测试只能靠 `import("...?shape=…")` 重载整个模块来强制干净缓存。补全后该 hack 退休，`test/auth.test.mjs` §2b 直接钉住"复用/隔离/分键/两实例各自持有"四条语义。`forgetJwks()` 随模块级缓存一并删除（此前全仓零调用）。

---

## 15. 登录 trace 漏了脱敏 = 泄露密码/token

- **现象**：潜在——诊断文件里出现明文密码或 token。
- **根因**：每次登录都写 trace 便于「浏览器能用、面板不能」的对照排查，但若不过滤就泄密。
- **修法**：`sanitizeUrl`/`sanitizeBody` 把 `password`/`access_token`/`refresh_token`/`code`/`code_verifier`/`cookie` 等一律 `[REDACTED]`，trace 才落盘；文件权限 `0o600`，仅留最近 20 个。

---

## 16. 插件目录解析不到 Host 的 peer 依赖，provider 静默缺席

- **现象**：`registerProvider: true` 之后面板一直显示 provider 未注册，快照 `llm.providerError` 里是
  `Cannot find package '@earendil-works/pi-ai' imported from …/plugins/dsh-connect-sensenova-token-plan/llm-adapter.js`；
  而离线套件（连 `npm test` 全量）**全绿**，因为离线套件通过 `peer-roots.mjs` 从 Host 运行时就地解析 peer，
  走的不是插件自己的解析链。
- **根因**：三个 peer（`@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`）由 `llm-adapter-core.ts` 导入（2026-10-02 §32 的「adapter 装配共用」收敛后落在那里，并声明在 `peerDependencies`），而 Node 的裸模块解析是从**该文件所在目录**逐级向上找
  `node_modules`。npm 装进 profile 的插件（`profiles/web/node_modules/<name>` 是**真实目录**）会向上走到
  `profiles/node_modules`，那里有 Host 的 peer；开发期的 `~/.dsh/plugins/<name>` 是**真实目录**，profile 侧的 `node_modules/<name>` 才是指向它的**符号链接/junction**（web 侧）或**安装副本**（desktop 侧，见 §22），Node 默认把链接解成 realpath，于是解析链从插件目录向上只剩 `~/.dsh/plugins`、`~/.dsh`、`~`，
  一路都没有这些包。
- **修法**：三个 peer 进 `peerDependencies`（npm 安装时由 profile 侧提供）；开发检出要么用 plugin manager
  以真实目录安装，要么把这三个包链接进插件自己的 `node_modules`（与 `dsh-connect-qoder` 的开发检出做法一致，
  `test/peer-roots.mjs` 头部也记了这条 workaround）。失败时 Host 日志会同时打出 `ERR_MODULE_NOT_FOUND` 与这句
  提示——面板只报「provider 缺席」，日志才说得清是哪一层没解析到。e2e 现在开着 `registerProvider` 真跑一遍注册，
  这条漏洞不会再以「离线全绿」的形式溜过去。

---

## 17. e2e 继承了开发机的 `SENSENOVA_API_KEY`，测的不是干净安装

- **现象**：本机（shell 里设了 `SENSENOVA_API_KEY`）跑 e2e，「没有 Key 时目录不可用」这类断言失败；
  面板保存 Key 的请求返回 `ok:false`，错误是
  `credentials-local: "SENSENOVA_API_KEY" is supplied read-only by the launching environment`。
- **根因**：e2e 用 `{...process.env}` 拉起 Host，开发机环境里的 Key 就成了子进程的环境凭据；凭据服务把
  「来自启动环境」的值视为**只读**，于是插件既提前拿到了 Key（目录不再降级），又写不进新值。
  干净机器上这两条路径都看不见——测试因此只在作者机器上红，属于典型的「只是通常离线」。
- **修法**：`startHost()` 在 spawn 前删掉 `SENSENOVA_API_KEY`/`SENSENOVA_USERNAME`/`SENSENOVA_PASSWORD`
  （与离线套件的 `isolateHostEnv` 同一组名字），隔离从「另一个 `$DSH_HOME`」补齐到「另一份环境」。
  注意这也是**真实产品行为**的体现：用户的 Key 若来自启动环境，面板保存会被凭据服务拒绝，面板会照实显示该原因，
  此时清掉环境变量或改用它处提供的值即可——插件不会偷偷绕过只读引用。
---

## 18. 两次 publish 并发，慢的那一次赢

- **现象**：面板显示 N 个模型、provider 已注册，但模型路由里真正可用的是另一份——常是重启后 state 缓存里那份空/旧列表。日志无异常，重试也自愈不了（要等下一次 catalog 变化）。
- **根因**：挂载时从 `catalog.json` 播种的那次发布是 fire-and-forget，可能还在飞；此时首次轮询、开关切换或 Key 清除又各发布一次。每次发布都是「先 `releaseProvider()` 再 `registerAdapter()`」，两次交错时**先发起、后完成**的那次会摘掉对方刚注册的 pair，再把自己那份旧 catalog 注册上去。更糟的是插件已经 dispose 之后，播种那次仍会完成注册——留下一个没人拥有、没人能摘掉的 provider。
- **修法**：`publishProvider` 走 promise 链串行（`publishChain`，与 `token-store.ts` 的 `getToken` 同一手法），seed / 轮询 / 开关 / Key 清除四个入口都进同一临界区；`disposed` 标志在 dispose 时置位，之后的发布直接跳过。注册那一对调用抽成 `registerPair()` 只定义一次——发布路径与回滚路径共用，否则两份迟早漂移（回滚只在已经出错时才跑，是最坏的发现时机）。钉住它的是 `test/wiring.test.mjs` F3：用可控 gate 让第一次 build 停住，断言「最后发起的那次是最终注册的」。
- **注意**：`index.ts` 里 signature 去抖是同步块（赋值与比较之间没有 await），单线程下它自己不会漏；漏的是 `publishProvider` 内部的 await。别以为有 signature 就够了。

---

## 19. adapter 工厂一旦返回 Promise，就会注册一个 undefined adapter

- **现象**：潜在——面板说 provider 已注册，快照 `llm.providerError` 为空，但真正调模型时报完全不像原因的路由错误。
- **根因**：`createSensenovaAdapter()` 现在是同步函数，`index.ts` 把它的返回值直接交给 `registerAdapter`。哪天它内部改成动态 import peer 而变成 async，`built` 就是 Promise，`built.adapter` / `built.providerIds` 全为 `undefined`——而 Host 照单注册。故障出现在模型路由，离原因很远。
- **修法**：`await` 工厂的返回值（对同步函数零副作用），并校验形状必须是 `{ adapter, providerIds }`；不符就在发布前抛错，进快照的 `llm.providerError`，而不是注册一个空壳。

---

## 20. 官方接口文档与平台行为不一致，照抄必 400

- **现象**：把商汤官方「SenseNova 6.8 Flash Lite」接口文档里的参数照进代码：`thinking:"disabled"` 想关思考，结果每请求 400；`reasoning_effort:"max"` 想要最强推理，也 400。
- **根因**：官方文档多处与平台实际不符（2026-09-29 对 `token.sensenova.cn/v1` 实测 40+ 个请求）：
  `thinking` **字符串形态**（`"enabled"`/`"disabled"`/`true`/`false`）全线 400——文档当字符串写是错的（object 形态 `{"type":...}` 才有效，见第 21 条）；
  `reasoning_effort:"max"` 在 flash-lite / deepseek-v4-flash 上实测 400（glm-5.2 上有效）——平台报错原文 `field ReasoningEffort invalid, should be one of: low, medium, high, xhigh, none`；
  目录 `supported_sampling_parameters` 只声明 `["temperature","stop"]`，文档表格里列的 `top_p`/`frequency_penalty`/`presence_penalty`/`seed`/`n` 一个都不在声明里（思考模式下 temperature 等本就不生效，送不送得动未验证，别假设支持）。
  另外文档写 `max_tokens` 默认 65535，目录实际 `max_output_length` 是 65536；窗口字段是 `context_length` 不是 `context_window`（曾让 `contextWindowOf` 拿不到真实窗口、全体回退 128k，见 `llm-models.ts` 与 `test/provider.test.mjs`）。
- **修法**：与平台行为有关的契约一律以**实测**为准（见 [SENSENOVA-API.md](./SENSENOVA-API.md) §7），官方文档只当线索、不当依据——且各模型页面互相矛盾（GLM 页说 `thinking.type:disabled` 会失败、实测可用；DeepSeek 页与 flash-lite 页都列 `max`、实测两处 400）。实测要点：默认即思考开（flash-lite `message.reasoning`、deepseek/glm/kimi 是 `reasoning_content`，每请求多约 26 个 prompt token、慢约 2.9 倍）；`reasoning_effort:"none"` 关思考（思考字段消失、`reasoning_tokens=0`）；`role:"developer"` 是 400（`supportsDeveloperRole:false` 的依据）；流式 `delta` 含 `content`/`reasoning`/`role`。

---

## 21. 同一平台两套思考语义，按模型家族分家

- **现象**：在 flash-lite 上验证过的思考参数搬到 deepseek/glm/kimi 上行为不同：flash-lite 的 `thinking` 字符串 400，deepseek-v4-flash 的 `thinking:{"type":"disabled"}` 却有效；`reasoning_effort:"max"` flash-lite 400、glm-5.2 却 200；返回的思考字段 flash-lite 是 `reasoning`、deepseek/glm/kimi 是 `reasoning_content`。
- **根因**：商汤在 OpenAI 兼容网关背后给不同模型家族做了各自的参数/字段方言（2026-09-29 逐模型实测）：
  思考字段：flash-lite → `message.reasoning`；deepseek-v4-flash/v4-pro/deepseek-flash/glm-5.2/kimi-k3 → `message.reasoning_content`（DeepSeek/GLM 官方文档确认）；
  `thinking` 参数：字符串形态全线 400；object 形态 `{"type":"enabled"/"disabled"}` 在 deepseek-v4-flash / glm-5.2 实测有效（disabled → `reasoning_tokens=0`）；v4.1-flash 文档自述支持（该 Key 套餐 403 未实测）；
  `reasoning_effort`：平台报错列表 `low/medium/high/xhigh/none` 是**并集**；`max` 只有 glm（实测 200）与 v4.1-flash（文档原生）支持，flash-lite / v4-flash 400；`xhigh` 在 v4-flash 实测 200（官方文档称映射到 high）；
  工具链路：DeepSeek 系文档要求带 `tools` 时回传所有历史 `reasoning_content`，否则工具调用链路不完整（不带 tools 时回传也会被忽略）——DSH/pi-ai 若丢弃该字段，deepseek 系多轮工具调用可能断链；
  思考模式采样：DeepSeek 系 temperature / presence_penalty / frequency_penalty 不生效（传入不报错），top_p 思考模式最小 0.95、非思考固定 1.0；GLM top_p 默认 0.95。
- **修法**：按**模型家族**而不是按「平台」记契约（逐模型表见 [SENSENOVA-API.md](./SENSENOVA-API.md) §7.5）。思考透出不再悬而未决：pi-ai 的 openai-completions 读取 `reasoning_content`/`reasoning`/`reasoning_text` 三种拼写（2026-09 查源码确认），本插件 descriptor 已翻为 `reasoning:true` + `thinkingLevelMap`（`off:"none"` 是平台关思考的拼写，`minimal:null` 不提供，`max` 仅 glm-5.2），profile 默认 `high` 保持平台默认思考开。`isChatModel` 按 `output_modalities` 排除图像生成模型（U 系列对话端点 404），避免把不可聊的模型挂进选择器。

---

## 22. 两个 profile 跑的不是同一份代码，却共用同一份状态文件

- **现象**：web profile 的面板改了配置或模型允许清单，desktop profile 的表现跟着变（或干脆不变）；desktop 侧的行为与源码对不上，像是跑着旧版本。问「这台机器上商汤 provider 到底是开是关」，翻遍 `cordis.patch.yml` 找不到答案。
- **根因**（2026-09-30 本机实测，三处超出直觉的事实）：
  - **装载面不是 patch，是 bundle**：插件在 profile 的 `package.json#dsh.profile.bundles` 里注册，`cordis.patch.yml` 只是 overlay，**缺省合法**（`cordis.yml` 头注即写明：不要编辑该文件，树由 bundles → patch → overlays 合成）。所以「patch 里没有本插件的行」什么都不证明。
  - **两个 profile 装的不是同一份**：本机 `profiles/web/node_modules/<name>` 是 `symlink → ~/.dsh/plugins/<name>`（跑源码 HEAD），而 `profiles/desktop/node_modules/<name>` 是**真目录**（安装副本，pin 在依赖里声明的版本号）。改了源头，web 立即生效，desktop 停在旧版本。
  - **状态面却是全局的**：`state-store.ts` 的 `$DSH_HOME/state/<name>/`（`catalog.json` / `provider.json` / `throttle.json`）与凭据服务里的同一条 grant 都不按 profile 分段，被两个 Host 进程共写，且载荷除各自的 `version` 外**没有跨版本协商**。
  - 叠加 `provider-publish.ts` 的 `panelValue ?? patch`：没有 patch 行时 `registerProvider` 取默认 `false`，而面板保存的值写在 state 文件里并**压过**默认值——于是「是否注册 provider」在这台机器上唯一的开关，是一个不在 git、不在 patch、CLI 也查不到的 JSON。
- **已做**（2026-09-30）：四个 store 的读缓存统一到 `state-store.ts` 的 `createStateReadCache` —— provider / draw 早有 1s TTL，**catalog 完全没有**（进程内永不失效），同一个共享目录问题修了两个、漏了第三个。现在一个 TTL 三个调用方，只允许在一处调整。钉住这条的是：`test/provider.test.mjs` §8b 用两个共享同一个 dir 的 store 实例模拟两个进程，断言「第二个进程的写入/开关，这边不必重启就看得见」，顺带钉住 `replace` 必须保住磁盘上真实的 allow-list（旧实现里惰性 `held` 会在没读过盘时把别人存好的清单重置成 `[]`）。
- **按期查**（三层按序，别只翻 patch）：**bundles（装载）→ patch overlay（配置）→ `$DSH_HOME/state/<name>/`（运行时热开关）**。改完源头，desktop 一侧需要重装该 bundle 才会跟上（web 的 symlink 自动跟上）。
- **已落地**（2026-10-01，P0）：`doctor --json`（`src/host/doctor.ts` + `tools/doctor.mjs`，`npm run doctor` / `doctor:json`），让「这台机器上 provider 到底是开是关」有处可问——它只读插件自己的状态文件、不碰凭据，Host 没起也能跑。状态目录的分段**已在第 23 条做掉**。

---

## 23. profile 状态：哪些该分、哪些该共享，以及读 `profileContext` 的两个坑

- **现象**：web 面板改了模型允许清单或 provider 开关，desktop 侧跟着变（或干脆不变）；两个 Host 进程（web = 源码 symlink，desktop = 安装副本，见第 22 条）共写同一份 `catalog.json` / `provider.json` / `draw.json`。更糟的是**版本方向**：老进程读不懂新格式时不会报错——每个 store 的 `parse` 对「版本不认识」一律读作「无记录」，于是它重拉一次、再把**旧格式写回去**，覆盖掉新进程刚写的。
- **根因**：这三份是**配置决策**（「这个 profile 允许哪些模型 / 要不要挂 provider / 要不要出图」），本就该 per-profile；而旧版统一放在 `$DSH_HOME/state/<name>/`，那是按「只做额度面板」的年代设计的。
- **修法**（2026-09-30 已做）：`state-store.ts` 新增 `profileSegment(ctx)` 与 `profileStateDir(name, profile)`；catalog / provider / draw 三个 store 接受 `profile`，目录变成 `$DSH_HOME/state/<profile>/<name>/`。**取不到 profile 名时退回原共享目录**，所以老主机、测试与进程内构造的行为零漂移。
- **取 profile 名的三个坑**（2026-09-30 运行时实证，非推测）：
  1. **只能用 `ctx.get("profileContext")`，不能用属性访问。** Cordis 的 Context 是 Proxy：读一个**没在 `inject` 里声明、Host 也没 provide** 的服务，`ctx.get` 安静返回 `undefined`，而 `ctx.profileContext` **抛错** `cannot get property "profileContext" without inject`（`@deepseek-ai/cordis` `lib/index.js:676`）。本插件首次改动就把这个错炸在 `wiring.test.mjs` 上，堆栈指向的正是属性访问那一行。官方两派用法也印证了这条边界：`dsh-app-boot` / `dsh-shell-env` 用 `ctx.get`，`dsh-settings` 则先 `static inject = ["configEditor","profileContext"]` 才敢用属性。
  2. **不能把 `profileContext` 写进 `inject`。** `inject` 里的是**硬依赖**（缺了插件根本不加载，报错文案就叫 "cannot get required service"），而这个服务是**可选**的——`dshmarket` 的注释直言有 host 会隐藏它，`dsh-better-sidebar` 也为缺席写了分支。写进 `inject`，那些主机上本插件会整个消失（面板、额度、provider 全挂）。
  3. **不要读 `DSH_PROFILE`。** 它在这个 runtime 里是 **OUTPUT 而非输入**：由 `runProfile()` 经 `dsh-shell-env` 派生给子进程，「no runtime module reads it to choose a profile」。手设或陈旧的值会把状态写进一个这台 Host 根本不读的目录。
  - 另外，`profileContext.name` 会变成**路径的一段**，所以按外部输入校验（`isProfileSegment`）：字符集 `[A-Za-z0-9._-]`、不以 `.` 开头（顺带排掉 `.` 与 `..`）、长度 ≤ 64。拒绝的代价只是退回共享目录，所以规则宁严勿宽。
- **故意不分段的两个**（别顺手「统一」掉）：
  - **`throttle.json`**：它答的是「上游要**这台机器**等多久」。若只有吃到 429 的那个 profile 遵守，另一个 profile 会在同一窗口里继续敲门——**静默废掉节流的意义**，而且只在被限流时才看得见。代码里已写明这条意图（`throttle-store.ts` 的目录函数）。
  - **凭据 grant**：它答的是「你是谁」，与 profile 无关；且按红线 1，token 只进凭据服务。
- **迁移**：新目录一开始是空的。读穿透发现「自己的文件不存在」时，从旧共享路径**复制**一次旧值并回填（`createStateReadCache` 的 `inheritFrom`），**只尝试一次**，所以不会变成每个 TTL 周期多读一个文件。用**复制而非移动**，与 `store.test.mjs` §16d 的改名迁移（移动、删旧文件）**故意不同**：老版本进程仍在读旧路径，把文件拿走等于把它的开关静默重置。
- **验证**（三层，缺一层都可能在验证空气）：
  - `test/provider.test.mjs` §8c：名字的接受/拒绝表（含 `..`、`a/b`、`a\b`、超长、非字符串），以及三种 ctx 形状——没有该服务、`get()` **抛错**、普通对象桩——都不得把错误抛穿。
  - 同文件 §8d：分段目录、一次性继承（含「旧文件仍在」这条与 §16d 相反的断言）、**两个 profile 互不干扰**、显式 `dir` 不继承。
  - **`test/e2e.mjs`**：真 Host 用 `--profile web` 启动，断言 catalog 落在 `state/web/<name>/` 且共享目录**没有**新文件。只有真 Host 能回答「这个可选服务对不 inject 它的插件是否真的可见」——单测桩回答不了，而服务不可见时功能会**静默失效**、测试却全绿。
- **未做**：文件级**版本协商**——分段只隔离了「哪个 profile 的配置」，没有解决「哪个版本的格式」。老进程仍可能把新格式覆盖回旧格式（每个 store 的 `parse` 对认不出的版本一律读作「无记录」，随后写回自己那一版）。

---

## 24. 用 GET 给 REST 端点探活会误判：404 ≠ 端点没了

- **现象**：要给一条推理路由做健康检查，写了 `fetch(url, {method:"GET"})`，拿到 `404 page not found`，于是判定「上游端点已漂移、这个功能死了」。事实上那条路由**活得好好的**。
- **根因**：Go/Gin 一类框架对「路径存在但**方法**未注册」的默认响应就是普普通通的 **404**（纯文本 `404 page not found`），与「路径根本不存在」**逐字节相同**。只有用了正确的方法（这里是 POST），请求才会穿过路由层抵达鉴权中间件，拿到业务信封。
- **实证（2026-10-01，见 `ROADMAP.md` §6.1.2）**：同一台网关同一条路径，两种判读天差地别——

  | 端点 | 方法 | 响应 | 判读 |
  |---|---|---|---|
  | `/api/web/llm/v2/chat/completions` | GET | `404` 纯文本 `404 page not found` | 不足以判死 |
  | `/api/web/llm/v2/chat/completions` | POST | `401` `{"code":200001,"message":"authorization_empty_error"}` | 路由存在，已抵鉴权层 |

- **修法**（探活纪律，按顺序）：① 用**这条端点真实的业务方法**探（推理就该 POST，别偷懒用 GET）；② 看**响应体形态**而不只看状态码——结构化信封（`{"code":…}`）意味着请求已进应用层，纯文本 `404 page not found` 才是没到；③ 探活请求**不带任何凭据**：既无计费可能，又刚好用 `401 authorization_empty` 证明「路由在，只是我没钥匙」。
- **教训的代价**：这条误判曾直接导出一个错误结论——「本插件第二上游用的正是被自家文档标注 404 的那份 URL 清单」。前缀确实相同，但**端点不同**：`/models` 真 404（那是参考件 `dsh-raccoon-work` 的路径），本插件用的 `/model_catalog` 与 `/chat/completions` 都活着。**看个前缀就下结论，和看个状态码就下结论是同一种粗心**——下判断前先回到 [ROADMAP.md](./ROADMAP.md) §6.1.2 那张表核对具体端点。
- **伴随坑（Windows Git Bash）**：脚本里把 `/api/...` 这样的路径字符串当命令行参数传，会被 MSYS 路径转换吃掉——`/api/web/llm/v2` 变成 `C:/.../PortableGit/.../api/web/llm/v2`，`fetch` 直接 `invalid url`，看起来像网络问题。用 `-e` 内联或先 `export MSYS_NO_PATHCONV=1`。

---

## 25. 形式门禁全绿，不代表文档说了实话

- **现象**：`docs.test.mjs` 十条检查全绿——127 条内部链接可解析、37 张表无跨文件重复、README 远低于 140 行上限、API 快照 15 键契约一致。同一时刻的 README：① **零处**提到当期头条特性（第三个 tab「小浣熊」）；② 三处仍写「侧边栏」，而代码早已迁到 Plugins 页，第 31 行「打开侧边栏「积分面板」」让用户**找不到入口**；③ 仍挂着「面板**只读**」的承诺，而它已经会注册推理通道、挂出图工具、写 DSH settings。
- **根因**：那套门禁验的全是**形式**——对一个题材「文档断言的事是否与代码一致」毫无感知。而 README 进了 npm 的 `files` 白名单，是用户安装完成后读到的**唯一**说明书；`cordis.patch.yml` 同样在包里，也藏着过期的「sidebar panel」注释。
- **修法**（2026-10-01 已做，两道新检查进 `docs.test.mjs`）：
  - **检查 9：README 必须覆盖面板的每一个 tab。** 文案不写死，从两个真源派生——`panel-page.ts` 里 `activeTab` 的联合类型给出 tab id 集合，`i18n.ts` 的 `tab.<id>` 给出中文文案；README 少了任何一个就红。于是「加一个 tab 忘了告诉用户」和「改了 tab 名而不跟」都必然红。
  - **检查 10：自述面声明的 UI 位置必须与 client 实际注册的槽位一致。** 受检「自述面」= `README.md` + `cordis.patch.yml`；槽位证据从 `src/client/*.ts` 的**非注释行**里找（只剥整行注释，不动行内 `//`，否则 URL 里的 `https://` 会被削掉半条路由）。声称了代码里没有的槽位 = 红。
  - **两处易漏的细节**：检查 10 要跳过否定句——「面板**不在**侧边栏」是在帮用户纠偏，不是位置声明；当初事故那句「打开侧边栏」不含否定词，照样红。检查 9 的正则必须钉住 `activeTab`，泛配 `useState<` 会先抓到同文件里的 `useState<SnapshotData | null>`，反而漏掉真目标。
- **验证**（缺这步等于自洽练手）：故意破坏后必须红——① 删光 README 里的「小浣熊」→ 精确报 `raccoon（面板文案「小浣熊」）`；② 把第 32 行改回事故原文「打开侧边栏「积分面板」」→ 报「声称面板在侧边栏，但 `src/client/*.ts` 里没有 sidebar 槽位注册」。两条都实测红过，再还原复验绿。
- **教训**：形式门禁越完善，越容易吸走「语义对不对」的注意力——绿得越好，越让人懒得读文档本身。**任何纯形式检查对语义漂移一律无效**，除非它的期望值是从代码派生出来的（像检查 9/10 那样：tab 名单来自 `panel-page.ts`、槽位证据来自 `apply.ts`）。

## 26. 重命名资产时只改了一半：清单指空，而所有检查都是绿的

- **现象**：重截截图时文件名从 `panel-credit-pools.png` / `panel-provider-setup.png` 换成 `panel-credit.png` / `panel-API-provider.png`。磁盘上是新文件、git 里也是新文件（`git status` 干净），**唯独 `screenshots.json` 还指着两个已删掉的旧名**。此刻工作树干净、构建通过、`docs.test.mjs` 十条检查全绿——**没有任何东西在报错**。而这份清单是市场页取图的唯一依据，推上去就是两张图全裂。
- **根因**：**「文档」这个词会让人只想到 `.md`**。`screenshots.json` 是数据文件、在 `package.json` 的 `files` 白名单里、被市场直接消费，但它在检查网里完全不存在——没人把它当「自述面」。重命名的人（人或并行会话里的 AI）改了两处该改的（磁盘、git），漏掉那个不显眼的清单。
- **修法**（检查 11，进 `docs.test.mjs`）：`screenshots.json` 声明的**每一条路径必须真实存在于磁盘**、是图片扩展名（`png/jpg/jpeg/webp/gif`）、条目数在 1–8 之间、且为仓库根相对路径（绝对路径与 `..` 逃逸在别人机器上必裂）。
- **验证**：三种破坏都实测红过再还原复验绿——① 换回两个旧文件名 → 精确报两条「清单指空，市场按它取图必然裂」；② `../outside.png` + 空条目 → 报「不是仓库根相对路径」与「含空条目」；③ 拿 `README.md` 当条目 → 报「不是图片扩展名」。
- **教训**：**「清单类文件」不是文档，但同样是契约**——`.json` / `.yml` / `.toml` 里写着别人的路径，改资产时最容易只改一半。本仓库按文件名引用 `assets/` 的机器消费方只有 `screenshots.json` **一处**；正是「只有一处 + 又不叫 `.md`」，让它成了盲区。**给资产改名之前先问：还有谁按名字引用它？** 答案里除了仓库内的文件，还包含仓库外的人工引用（如市场投稿 PR 正文会点名截图）。

## 27. 插件卡的标题与简介有第二套真源：`package.json` + `locale/`，而缺 exports 通配是静默失败

- **现象**：中文界面下 Plugins 页的插件卡显示裸包名 `dsh-connect-sensenova-token-plan` 作标题 + 一段英文简介，而点进去**面板每一个 tab 都是中文**。同机兄弟插件 `dsh-connect-agnes` 却显示中文——差别只是对方的 `description` 恰好写的就是中文。
- **根因**：卡片文案**不是插件自己渲染的**（`plugins.bundle.config` 槽位只插面板本体），而是 DSH 插件管理器读的**包元数据**：`readPluginMeta()`（`@deepseek-ai/dsh-app-boot`）先取 `package.json` 的 `description`（**只认字符串**，`stringField` 非字符串即丢）当英文兜底，再叠 `locale/*.json` 里的 `meta.title` / `meta.description`；客户端 `resolveText()` 按当前语言的兜底链取词（`en` 链 = `["en"]`，`zh` 链 = `["zh","en"]`）。本仓库只提供了前一半，于是中文界面照旧显示英文。三个连带事实：① `displayName` 这条链路**根本不读**，所以标题落回 `manifest.name`——那个裸包名；② **`locale/en.json` 是锚点**：读取端遍历的是「英文资源所在目录」，没有它 `zh.json` **永远不会被读**；③ 缺 `"./locale/*.json"` 这条 exports 通配时，解析抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，而读取端把这一类错误（含 `ENOENT` / `ERR_MODULE_NOT_FOUND`）当「没有本地化元数据」**直接吞掉**——不报错、不告警、只安静显示英文。
- **修法**（2026-10-01 已做）：新增 `locale/en.json`（**只写 `meta.title`**，英文简介继续由 `package.json` 提供单一真源，避免同一段英文两处漂移）+ `locale/zh.json`（标题 + 简介）；`exports` 补 `"./locale/*.json": "./locale/*.json"`；`files` 补**裸目录名** `locale`——**不要写 `locale/*.json`**：`test/package.test.mjs` 第 3 项对含 `.` 的 `files` 条目会把它当字面路径去磁盘上找，必红。教科书范例是内置包 `@deepseek-ai/dsh-experimental-auto-review/locale/{en,zh}.json`。改了这两个文件要同步 `docs/DSH-PLUGIN.md` 的 `jsonc` 教学快照（`files` 由 `test/docs.test.mjs` 钉死，漏了就红）。
- **验证**：不必起 DSH —— 在 `tmp/`（git-ignored）里照抄 `readPluginMeta` + `resolveText` 的链路跑一遍，断言 `en` 链拿到 `package.json` 那句原文、`zh` 链拿到中文标题与简介；再故意摘掉 exports 通配复跑，必须看到 `ERR_PACKAGE_PATH_NOT_EXPORTED`（即静默回落英文），加回来才通。**用一条会红的反证，换掉「看起来生效了」的错觉。**
- **教训**：**「插件自己渲染的界面」与「DSH 渲染的插件元数据」是两套真源**。前者走 `ctx.locale` 注册的字典（本仓库早已中英双语，`test/panel.test.mjs` 还钉住键集一致），后者走 `package.json` + `locale/`：只改一套，就会出现「面板全中文、卡片全英文」这种自相矛盾的自述面。凡是**框架替我读**的文件，先找到读它的代码，再问一句「它读不到时会说什么」——本条里的三个坑（锚点缺失、exports 通配、`files` 写法）**没有一个会报错，只会安静地不生效**，正是本仓库反复踩的那一类（§25 形式全绿而语义已漂、§26 清单指空而检查全绿）。

---

## 28. 有副作用的一次性端点不能拿真凭据探活：探针即领取

- **现象**：要给一条「奖励领取」类端点确认契约（路径、参数形态、响应信封），第一反应是照 §24 的纪律**带上有效凭据**发一次请求——毕竟 §24 证明了「带凭据才能区分路由不在与鉴权拒绝」。可这类端点**不是只读的**：调用成功就会**真实发放奖励**，而我们盯上的那条恰是「每号一次」的登录奖励。一次探针 = 把用户那份奖励领掉，且**没有回滚**。
- **根因**：§24 的探活纪律是为**只读端点**写的（`model_catalog` / `balance` / `chat/completions` 的鉴权层），它的隐含前提是「这个请求不改变服务端状态」。奖励 / 领取 / 签到 / 兑换码一类端点天然违反这个前提，而它们偏偏最需要「路径到底存不存在」这个判据。**判据本身没错，错在把它套到有副作用的端点上。**
- **修法**（两层，代价从低到高，先做第一层）：
  1. **无凭据探存在性**（代价为零，永远先做）：**不带** `Authorization` 请求同一路径。判读沿用 §24——结构化信封 `{"code":…,"message":"authorization_empty_error"}` = 路由存在、已抵鉴权层；纯文本 `404 page not found` = 路径不在。这一步**不会触发发放**：请求在鉴权层就被拒了。
  2. **带凭据验契约**（只在真决定接入时做，且**明确接受副作用**）：先用**假凭据**（形状合法、值无效）探参数校验分支——能拿到 `400 params_invalid_error` 这类「已抵达业务层」的响应，就说明路径与参数形态都对，而**奖励一分未发**（与 §6.1.3 探 refresh 端点同一手法）。只有假凭据推不动、必须看真实成功信封时，才用真凭据，并在动手前把「这一次调用就是领取」写进报告。
- **实证关联**：本仓库的具体候选是 `desktop/v1/login/points/grant`（小浣熊「桌面端登录奖励，每号一次」）。盘点它时已写明：只做第 1 层探针，第 2 层等真拍板接入——见 [ROADMAP.md](./ROADMAP.md) §6.1.4。
- **教训**：**动手探活之前先问一句「这个请求会不会改变服务端状态」**。只读端点可以用真凭据换真实证据；有副作用的端点，真凭据本身就是代价——探针按下的那一刻，问题已经不成立了（没有「可回滚的领取」）。判据可以复用，**前提不能照搬**。

---

## 29. 排障脚手架留在线上：没有任何测试看管它，而它会带上环境的值

- **现象**：修完一个 401 悬案（`e039174`：`Bearer` 双形状 + 读前续期门 + `/refresh` 路径），当时为「给 401 找出主人」加的 6 个诊断字段**留在每一条响应里**：`accessTokenPrefix` / `credentialSource` / `raccoonEnvShadow` / `envCredentialFingerprint` / `accessTokenFingerprint` / `hostProxyEnv`。客户端**一个都没渲染**，测试**一个都没断言**，于是它既没有消费者、也没有看守者，静悄悄地成了常驻负载。
- **根因**：三层叠加，缺一层都不会出这个形态。① **脚手架的寿命没人定义**——加它的时候问题是活的，修完之后没人负责收；② **零测试覆盖**——不是「测试没抓到」，而是「此处根本没有测试」：`/raccoon` 路由此前**没有任何路由级用例**（`routes.test.mjs` 只驱动 snapshot/account/api-key/provider/models/draw 六条），所以没有任何一条会红；③ **字段名看着就无害**——`hostProxyEnv` 的注释自己写着「all non-secret」，而它回吐的是环境变量的**值**，企业代理常写成 `http://user:pass@proxy:8080`，userinfo 就是凭据。
- **修法**（2026-10-01 已做）：整块收进显式 `?debug=1`（免配置字段、免重启；POST 的回报一律干净，因为 `answer()` 不带这个 flag），`hostProxyEnv` 的 userinfo 出门前一律遮蔽，并给 `/raccoon` 补上**第一条路由级覆盖**——正向断言「`?debug=1` 能拿回来」+ 负向断言「平时一个都不许出现」。
- **验证**（无门禁可依赖，所以靠反证）：两个**故意破坏**都必须红——① 把开关写死成常开 → 负向断言点名 `["raccoonEnvShadow","hostProxyEnv"]`；② 摘掉 userinfo 遮蔽 → 断言原样吐出 `HTTP_PROXY=http://alice:s3cr3t@proxy.test:8080`。两条实测红过再还原，之后 167 项路由用例全绿。
- **教训**：**排障脚手架要按「临时物」对待，而不是按「代码」对待**。给它一个到期条件（修完即收进 debug 开关或删除），给它至少一条断言——**负向断言最便宜**（「这些键平时不许出现」几乎零成本，却是唯一能防它悄悄长回来的东西）。更要紧的是：**「诊断字段」不是天然安全的**——字段名与注释里的「non-secret」是作者当时的判断，不是事实；凡是要把环境、URL、文件路径一类的原样值写进响应的，先问「这个值里可能裹着什么」（同 §28：探针的代价是奖励，诊断的代价可能是凭据）。

---

## 30. 硬门禁的依赖来源假设了「开发机的形状」，于是它红了一整天而没人知道

- **现象**：CI 每一次 push 都红，回溯至少一整天（`0.4.3` / `0.4.4` / `0.4.5` 三个 release 全在红着的门禁下发出）。日志永远是同一句，出现在 offline job（唯一的硬门禁）的**第二个**套件：`Error: cannot resolve the peer dependency @deepseek-ai/dsh-credentials. Looked in: <repo>/node_modules: no @deepseek-ai scope`。而本机 `npm test` 全绿。
- **根因**（三层，缺一层都不至于此）：
  1. **依赖来源与 runner 不匹配**：`test/peer-roots.mjs` 的候选根全是「装了 DSH 的机器」形状（`$DSH_HOME` → 插件 `node_modules` → `~/.dsh/dsh-asar-unpacked` → 打包安装目录）。干净 runner 上只剩 `<repo>/node_modules`，而 `npm install --legacy-peer-deps` 对它**跳过 peer**——`--force` 也不行，实测 `dsh-credentials` / `cordis` 都没落地，只有未被声明为 peer 的 `dsh-credentials-local` 进去了。**门禁在这台机器上永远不可能绿。**
  2. **`set -e` + 19 个套件写在同一个 step**（2026-10-01 时点名册共 19 项，现已扩到 30 项）：第 2 个套件一抛错，后面 17 个（含 `build-gate`）**一次都没跑过**。于是「门禁红」看起来像某个用例失败，实际是**门禁根本没在验证**。
     **已修（2026-10-05）**——本条曾长期是「写进 lesson 却没修」的活例子：§30 的验收只处理了根因 1 与 3，而根因 2 恰恰是唯一一条**当时就在文档里写着、却没人动**的。修法见下方新增的第 4 条。
  3. **注释替这堆问题背了书**：workflow 写着这些套件「resolve peers from stubs」——`peer-roots.mjs` 里**没有任何 stub**，只有真实运行时查找；又写 peer「cannot resolve from any registry」——包其实都在 registry 上，只是**只发预发布版**，而声明范围 `>=0.1.5 <0.3` 在 npm 默认 semver 规则下**不匹配预发布**（`npm view '@deepseek-ai/dsh-credentials@>=0.1.5 <0.3'` 直接 E404）。两条加起来，读注释的人会得出「CI 本来就这样」——**这正是它红了一整天没人管的原因**。
- **修法**（2026-10-01 已做）：offline job 增加 `npm install -g @deepseek-ai/dsh`（**全局**装：不读本仓 manifest，npm 才会去拉运行时自己的 peer 闭包），`test/peer-roots.mjs` 新增 `cliRuntimeModules()`（从 `test/e2e.mjs` 抽出并共享；`npm root -g` → `<prefix>/@deepseek-ai/dsh/node_modules`，marker `dsh-base`，每进程 memo 一次）作为**最后**一个候选根。本地优先级不变，开发机仍优先跑它真正运行的那份运行时。
- **验证**（不 push 也能验，且必须这么做）：把开发机的运行时候选**全部屏蔽**——`USERPROFILE` / `LOCALAPPDATA` / `DSH_HOME` 指向空目录（`APPDATA` 不能动：Windows 上 npm 的全局前缀取自它）——此时 `findPeerRoot()` 必须落到 CLI 运行时树，然后跑**完整 19 套件 + build-gate**（2026-10-01 时点名册），全绿才算修好（本机实测：屏蔽后 19 套件 + build-gate 全绿，`e2e` 44/44）。反证也做过：该条件下只装 2–3 个 registry 包，`store.test.mjs` 会以 `Cannot find package '@deepseek-ai/dsh-atomic-write'` 崩——**DSH 整套包互相以 peerDependencies 咬合，装子集必留悬空 import**，这就是「必须整棵运行时」的判据。
- **教训**：**门禁的依赖获取方式也是门禁的一部分**。判据不是「CI 红没红」，而是「**这个门禁在目标环境上有没有可能变绿**」——恒红的门禁与没有门禁等价，甚至更糟：它把真回归淹进噪音，还让 release 照发。三条纪律：① **clean runner 上必须能绿**；做不到就把来源写进 workflow，**不要**在测试里加 SKIP（把 peer 依赖 SKIP 掉 = 绿着什么都没测）；② **别把 N 个套件塞进一个 `set -e` step**，一次失败会吞掉其余套件的全部信号；③ **注释里的「为什么这样做」必须与实现同步**——本次三条根因里最难发现的恰恰是那条说谎的注释，它让每个人都以为这是已知且可接受的红色。
- **修法 4（2026-10-05 补做，唯一一条当时没动的根因）**：把「跑完所有再汇总」做成 **runner**，而不是把套件摊平成更多 step。套件名册收进单一声源 `test/suites.mjs`（30 项，每项带 `kind` 与 `note`），`npm test` 与 `ci.yml` 的 offline job 调**同一个** `node test/run-all.mjs`（CI 传 `--skip=e2e-gate`，因为端到端在那边是独立 job）。退出码仍是「全部的与」，所以门禁该拦还是拦——变的只是它**报告**什么：以前「红」可能意味着后面 26 项根本没跑，现在每项都有 verdict，且汇总会点名「N 项跑过并通过」。
  - **为什么是 runner 而不是多 step**：step 只让 GitHub UI 逐项显示，仍要人翻日志找「哪些没跑」；runner 能自己汇总、能在本机用（`--only=` / `--skip=` 把 AGENTS.md 那条「按域裁剪」从口头约定变成一等公民），还让「**空选择必须红**」成为可能——一条没跑的门禁和一个通过的门禁长得一模一样。
  - **顺手修掉两处同源漂移**：`package.test.mjs` 的名册钉子原用正则刮 `scripts.test` 与 `ci.yml` **两份手抄文本**再比较（重复本身就是被维护的东西，「三方一致」于是变成第四处要记的地方）；现在读 `suites.mjs` 这一份数据，并新增一条钉子：**`ci.yml` 里不许再出现手抄的 `node test/x.test.mjs`**——有人把清单粘回 workflow 就红。
  - **验证（反证实测做过三条）**：① 在 `ci.yml` 里塞回一行 `node test/auth.test.mjs` → 精确报红「ci.yml has no hand-copied suite chain left」；② 从名册删掉 `state-segmentation.test.mjs` → 报「exists on disk but no gate runs it」；③ 把 `doctor.test.mjs` 改成 `doctorX` → 报「roster names a file that is not in test/」（旧 `*.test.mjs` 正则根本看不见 gate 文件那一向）。runner 自身：把一个必败探针插到名册第 3 位 → 第 4、5 项照常跑完并报绿，汇总写「1/5 FAILED（4 项跑过并通过）」，退出码 1。

---

## 31. 把「等用户」实现成「等 HTTP」：一次扫码打了网关几百次读

- **现象**：小浣熊微信扫码登录的 `POST /raccoon {action:"login"}` **阻塞最长 5 分钟**（`RACCOON_LOGIN_TIMEOUT_MS`，每 2 s 轮询网关一次），期间该 HTTP 请求一直挂着；客户端为了能在这段时间里拿到二维码和最终结果，又在旁边跑了一个自己写的 **150 × 2 s** 补偿轮询。两次轮询叠起来，一次扫码要打网关 **几百次** `balance` + `model_catalog` 读——为一个「用户扫没扫码」的事实，和为一个根本不可能每秒变化的余额数字。附带三处隐性故障：① tab 刷新 / 代理超时 / Host 重启会切掉这个 POST，而 `raccoonScan` 只在正常 settle 时被清，于是变成**没人能清的幽灵扫码**；② 两个 tab（或双击）各起一次登录，后发的 code 覆盖前一个，而 GET 只能回报一个——屏上的二维码与正在轮询的码从此不匹配，**表现为「扫了没反应」且没有任何报错**；③ 被切断的 walk 不 reopen 闸门，此后的登录请求可能被永久挡在门外。
- **根因**（三层，缺一层都只是「有点浪费」而不是「两个数量级」）：
  1. **等待对象错了**：要等的是**人**（手机扫码），实现却让**连接**去等。HTTP handler 持有连接 5 分钟，把「用户动作」的时延直接变成「服务端资源」的占用，并且把生命周期交给了最不可靠的一方（浏览器 / 代理）。
  2. **客户端用「更密地轮询」补偿「服务端不回答」**：补偿是**乘数不是加法**——服务端没有可读的状态，客户端就只能加密度；密度上去了，服务端的每请求成本又被乘了一遍。
  3. **第二上游没接缓存与单飞**：Token Plan 侧早有 `cache` / `inflight`（`console-client.ts`），小浣熊这条线写的时候没有接，于是每次 GET 都实打实打两次网关读。**「复用面板的轮询基建」不等于「共享它省下的那份请求」。**
- **修法**（2026-10-02 已做，四处一并落地）：
  1. **发码即回**：POST 只负责生成并下发扫码（`scanUrl` / `scanCode` / `loginStatus:"scanning"`，约 100 ms），扫码 walk 转后台（`raccoonWalk`）；结果作为**事件**经 GET 的 `loginStatus` 下发一次（`logged_in` / `timeout` / `canceled` / `failed`），**读后即清**——它是事件不是状态，否则两分钟前的超时会被每次轮询反复播报。
  2. **并发闸 + finally 清理**：`raccoonWalk !== null` 时第二次 login 返回**同一个**扫码而不是新发一个；walk 无论成败都在 `finally` 里清掉 `raccoonWalk` 与 `raccoonScan`，切断 / 抛错都 reopen 闸门。
  3. **读侧接缓存与单飞**：新增 `src/host/coalesced-fetch.ts`（TTL 读穿 + 每 key 单飞，失败共享但不缓存），**`console-client.ts` 里两份手写的 cache/inflight 逻辑一并换成它**（顺手消掉重复），小浣熊的 `balance`(60 s) / `catalog`(300 s) 按**凭据指纹**做 key，logout / 登录成功时 `clear()`——换账号不能读到上一个人的余额。
  4. **客户端删掉死循环**：删掉 150 × 2 s 的 `quick()`（它在扫码 10 秒成功后仍会跑满 5 分钟），改为由服务端 `loginStatus` 驱动的**双档 cadence**（扫描中 2 s，其余 60 s），闸门也在服务端——客户端不再持有任何可能活过 walk 的定时器。
- **验证**：`test/routes.test.mjs` 新增 T 段 6 条（173 项全绿）：T1 断言 POST 在 1 s 内返回 `scanning`；T2 断言 walk 在飞时第二次 login 复用同一 `scanCode`；T3 断言 settle 后 `loginStatus === "logged_in"` 与 `loggedIn === true` **同时成立**；T4 断言终态只投递一次；T5 断言 TTL 内再轮询 5 次**零新增**网关读；T6 断言两个并发 GET 共享一次读（单飞）。**T3 当场抓到一个真 bug**：`loginStatus` 原先在响应组装的**末尾**读取，而 `loggedIn` 在**开头**读取，中间那次 `await`（读 balance）足够让 walk 落地凭据——于是同一个响应能一边说 `logged_in` 一边说没登录；修法是把事件读取挪到 `raccoonState()` 的最开头，使终态永远晚于它所描述的 state。
- **教训**：**等待人 ≠ 等待连接**——凡是「等用户做某个动作」的流程，请求必须立刻返回，状态必须可被轮询，且**截止期限归服务端所有**（客户端持有一个比 walk 活得久的定时器，就是下一个幽灵轮询）。更要紧的是那条乘法：**客户端的轮询密度 × 服务端的每请求成本 = 真实流量**，只优化一头等于没优化；所以每接入一个新上游，缓存与单飞要和路由**一起**接上，别等流量账算出来才补。

---

## 32. 用「复制一份」实现隔离：复制的恰好是最脆的回滚路径

- **现象**：为接入第二上游（小浣熊），`raccoon-publish.ts` 与 `raccoon-llm-adapter.ts` 是按 `provider-publish.ts` / `llm-adapter.ts` **复制出来**的。逐字比对（去注释去空行）：publisher 一对有 **101 行逐字相同**（占并集 47%），adapter 一对 **73 行**（63%）。被复制进去的包括 PITFALLS §18/§19 钉死的三条承重语义（`publishChain` 串行、`disposed` 闸、单点 `registerPair` + 回滚），以及那段注释自己都写着 "provider-agnostic" 的 429 误判纠正 Proxy。表面症状不是报错，是**纪律分裂**：两边注释互相指着对方说"保持同步"，而没有任何测试或机制在强制这件事。
- **根因**（三层）：
  1. **把「隔离」理解成了「不共享代码」**。要隔离的是*状态与凭据*（两个 publisher 各持实例、各读各的 store 即可达成），却用*复制文件*去实现——复制带来的是两份会漂移的副本，不是更强的隔离。
  2. **复制的对象选错了：挑中了最脆的那部分**。回滚路径（注册失败 → 恢复旧 pair）**只在出事时才跑**，是全线最难被日常测试碰到、也最致命的一段；把它复制成两份，等于把唯一不能漂移的代码漂移了。§19 那条注释本身就是为这个场景写的。
  3. **没有度量"什么是重复"**。凭感觉"这两个文件不一样"（provider 有 quota/allow-list、raccoon 有 token gate），于是整文件复制；但真正该问的是——**这些行能不能被同一个测试同时钉住**？能，就不该有第二份；不能（领域差异），才允许分开。
- **修法**（2026-10-02 已做，收敛而非新增重复）：
  1. 新建 `src/host/publish-core.ts`：`createPublishQueue`（队列 + disposed 闸）、`createPairReleaser`、`registerProviderPair`（单点注册）、`swapRegistration`（注册交换 + 失败回滚旧 pair）、`resolveRegistrationService`（llm 服务检查）、`unregister`（注销并记录原因）、`createAdapterFactoryResolver`、`isBuiltAdapter` / `describeBuildFailure` / `warnBuildFailure` / `emitAdaptersUpdated`。**两个 publisher 各持一个实例**，各传自己的 provider 身份与 `onRollback`。
  2. 新建 `src/host/llm-adapter-core.ts`：`assemblePiAiAdapter`（provider + profile + `PiAiAdapter` + 429 纠正 Proxy）+ `imageBudgets`（像素预算可覆写——小浣熊网关 10 MB 限制，用更小的预算）。两个 adapter 只剩"自己的描述符构建 + 自己的凭据解析"。
  3. **保留领域差异，不做参数化状态机**：gate 语义（provider 看 catalog + allow-list；raccoon 看 token）与 state 形状（`entries`/`enabledIds`/quota vs `rows`）留在各自文件里——那是真差异，参数化只会让每个读者都要读配置才能理解一次 publish。
  4. **顺手抓到并修掉一个真 bug**：raccoon 的 "no token / `not_configured`" 分支只 `release()` 却**不清 `state.built`**（Token Plan 侧的 switch-off 分支清了）。残留的 `built` 会成为**下一次** publish 的回滚目标——一次失败发布会把一个 release 已被调用的 adapter 重新注册回 Host。统一走 `unregister` 后消失。
- **验证**：收敛后全域复跑零漂移——provider 201、raccoon **122**（+1 为新增的 stale-`built` 断言）、wiring 46、routes 173、contract 98、store-baseline 48 帧、typecheck 2 配置 0 错、e2e 44/44。adapter 一对的逐字相同行 **73 → 7**（Jaccard 0.63 → 0.23），publisher 一对 **101 → 81**，且剩下的 81 行绝大多数是 state 字段声明与 import 行（数据，不是逻辑）。
- **教训**：**隔离由实例边界保证，不由代码副本保证**。判断"该不该有第二份"的问法不是"两个文件像不像"，而是"这些行能不能被一个测试同时钉住"——能就抽，不能才留。尤其：**需要复制的代码，优先检查它是不是回滚 / 降级 / 清理路径**；这类代码一年跑不了几次，却决定了出事时是"退回去"还是"烂在那里"。

---

## 33. 「看起来有防护」的表达式：`(x ? x.y() : null).catch(...)`

- **现象**：把 `/raccoon` handler 里那个 190 行的 `raccoonState` 闭包抽成 `raccoon-status.ts` 时，`switchStore` 从「wire 里必然非空的实例」变成了**显式可选的注入项**。抽出后跑新写的单测，`switchStore: null` 直接抛 `TypeError: Cannot read properties of null (reading 'catch')`——而这一行原本长这样：`const switchState = await (switchStore ? switchStore.enabled() : null).catch(() => null);`。它在生产里活了很久，因为生产里 `raccoonSwitch` 永远是个对象：这条分支**从来没被走到过**。
- **根因**：三元只保护了**调用**，`.catch` 却挂在三元**结果**上——缺席分支给的是 `null` 而不是 promise。于是这个"防御性"表达式只在**不需要防御的那一支**上是安全的，真正需要它的那一支直接崩。更麻烦的是它**读起来是有防护的**（明明有个 `?` 和一个 `.catch`），review 的眼球滑过去不留痕；这也解释了为什么它没在写的时候被发现。
- **修法**（2026-10-02 已做）：`optional(value)` 进 `util.ts` —— `Promise.resolve(value).catch(() => null)`，把「不是 promise」和「rejected promise」统一读成"没有答案"，守卫就落在**调用点**而不是调用结果上。全仓**四处**一并换掉：新模块的 `raccoonSwitch.enabled()` / `enabledIds()`，以及 `routes.ts` 里同形状的 `drawStore.enabled()` / `drawStore.modelId()`（画图路由的 `answer()`，每请求都跑）——抽公共原语而不是只修自己这一处，理由与 PITFALLS §32 同：**同类 bug 会漂移，收在一处才不再有第二份可漂移的副本**。
- **验证**：`test/raccoon-status.test.mjs` F 组用 `switchStore: null` 直接驱动，断言是「off + 降级」而不是抛错；修前同一输入会把**整组**检查一起带走（异常逃出组内 try，后续断言全部不执行）。新套件 46 项，`package.test.mjs` 的三方名册钉子（磁盘 ↔ `npm test` ↔ CI）同时钉住它的注册。
- **教训**：**判断一个表达式是否真有防护，要看哪一条分支会走到那层防护，再用一个真的走那条分支的测试证明它**。`a ? a.b() : null` 这类形状正是"看起来有防护"的重灾区。顺带一个正面收获：把闭包抽成注入式模块的额外收益，不是行数变少，而是**缺席变成了可表达、可达的状态**——在路由里它被 wire 保证为非空，这个 bug 本可以永久潜伏。抽模块（`routes.ts` 收为 65 行门面、路由体在 `routes/<resource>.ts`，读模型 387 行独立在 `raccoon-status.ts`、可脱开路由单测）真正的价值在此。

---

## 34. 同一份 UI 契约画两遍：测试把它们钉在一起，代码却留了两份

- **现象**：`ModelRoster`（`model-picker.ts`，Token Plan 目录）与 `RaccoonRoster`（第二上游网关目录）各画一遍同一套行骨架——`li` + `modelRowHead` + `label`（checkbox / 名称 / `×N`）/ badges / 参数行。`test/render.test.mjs` 里甚至已经有一个循环**同时**驱动两者、断言同一份契约，注释白纸黑字写着「下一个改行形状的人不能改一个忘另一个」——那是对「这两份必须逐字一致」的书面承认，却只用测试兜着。而漂移已经发生，三处，没人发现：head 内 label 的间距一边 10px 一边 8px；rate chip 一边在 label **内**、一边在 label **外**；一处靠 label 的 `flex: "1 1 auto"` 把 badge 顶到右边缘，另一处硬塞了一个 `spacer`。
- **根因**：判定「该不该有第二份」时看的是**「两个组件像不像」**。它们确实不像——一个绑定 allow-list + 思考阶梯 + 配额耗尽 badge，另一个绑定网关费率 + `null` 读成全员 + 无阶梯。于是各写一遍。该问的是另一个问题：**这些行能不能被同一个测试同时钉住？**能，而且当时就已经那么钉了。**能同时钉住的东西，就是同一份规格；规格只有一份，实现就不该有两份。**
- **修法**（2026-10-02 已做）：新建 `src/client/model-row.ts`，两个 roster 共用。关键是**只收骨架，不收领域**：primitive 吃**渲染好的内容**（`rateText` / `rateTitle` / `badges` / `meta`），不吃模式开关——一个 `raccoon: true` 的布尔会把两份措辞重新塞回同一个文件，那正是要分开的东西。三处漂移随之收敛（统一 10px、rate chip 进 label、去掉 `spacer` 靠 label 撑开）。
- **验证**：`test/render.test.mjs` 165 项在抽取前后逐项零漂移（那条同时驱动两者的循环就是验收器）；行原语自身的契约另由该循环钉住。
- **教训**：**一条测试同时驱动两个组件时，它同时是两个组件的规格。** 反过来也成立且更有用：如果两个组件只能用两套输入分别钉，那才是真差异，才允许分开。这是 PITFALLS §32（复制最脆的回滚路径）的同一条道理换了层皮——那里是「隔离靠实例不靠副本」，这里是「规格靠测试不靠自觉」。

---

## 35. 把「随状态变化的帧」关进 hook 组件，等于把帧从测试面上锁掉

- **现象**：`raccoon-tab.ts` 的整棵渲染树由内部 `useState` 决定。而 `test/client-surface.js` 的 React 替身里，`useState` 只返回初值、`useEffect` 是空操作——所以**挂载 tab 永远只看到登出帧**（旧文件头自己承认了这点，并把 `RaccoonRoster` 拆出去当作补救）。于是这些一条断言都没有：余额 + 网关拆解 + **两个**凭据时钟并进同一行的折叠、过期凭据渲染成 `alert` 而非状态行、nickname 为空时不留悬空冒号、`已启用未登录` 与 `未注册` 两种措辞的分野、注册失败在开关**关闭**时仍可见。这些不是边角——过期告警和那两种措辞，恰恰是用户在出故障时唯一能读到的东西。
- **根因**：把「数据从哪来」和「画成什么样」绑进了同一个函数。hook 是取数与生命周期的工具，不是渲染的必需品；state 一旦关进 hook 的闭包，测试要够到那些帧就只能自己重实现一遍 hook 契约——**那是在测假货**（`client-surface.js` 的注释把这条线划得很清楚：宁可留一个写明了的缺口，也不假装）。
- **修法**（2026-10-02 已做）：新建 `src/client/raccoon-card.ts`，**无 hook**，`state` 走 props；`RaccoonState` 接口、`qrImageOf`、以及「对整份 roster 取反」的 id 推导一并迁入。`raccoon-tab.ts` 只留生命周期：轮询与两档 cadence、四个 mutation、unmount 清理、向 header 上报新鲜度（616 → 235 行；此后又随 tab 增改回长到约 442 行——行数是时点快照，别当契约）。`tt` 在套件里是 identity，所以断言钉的是**哪个键渲染出来了**，不是译文。
- **验证**：`test/render.test.mjs` 新增 21 条（165 → 186）。其中 8 条第一版是红的，根因是我自己写错了：`lineHas` 去读 `props.children`，而测试替身的 `h` 把 `children` 挂在**元素**上而不是 `props` 上——改用现成的 `texts()` 做**精确节点比对**（顺带避开 `raccoon.unregistered` 是 `raccoon.unregisteredChip` 前缀这个子串陷阱，`includes` 会在错误的帧上报"有"）。
- **教训**：**「这个组件的状态测不到」通常不是测试能力不够，是组件把状态私有了。** 判据很直接：把 state 提成 props 会让组件变差吗？不会——那它本来就不该私有。同一条规则在本仓库已经落地三次：host 侧 `raccoon-status.ts`、`snapshot-aggregate.ts`，client 侧 `RaccoonRoster`；这次只是把同一件事做完。附带一个可复用的判据：**只要某段逻辑是 `state` + `tt` 的纯函数，它就没有理由待在 hook 里。**

---

## 36. 重复一份「规则」而不重复一份「数据」，等于只实现了半个开关

- **现象**：小浣熊 tab 里，模型可以被取消勾选，**但再也勾不回来**。凡是被关掉的模型，此后每次点击都发出**原封不动**的清单；把整份 roster 全部点掉后，那个 provider 就永久推不出任何模型，用户唯一的出路是去手改状态文件。界面上一切正常——复选框渲染自 `state`，而它要发的那份清单没有任何地方显示。
- **根因**：`models.ts` 早已拥有「勾选代数」（`toggleModelIn` / `allowListFor` / 哨兵 `HIDE_ALL_MODELS`），但它是 **Token Plan 方言**（`[]` = 不过滤）。网关那边的 `enabledModelIds` 语义相反：`null` = 整份 roster 推送，`[]` = 一个都不推。于是组件作者判定「不能复用」，就地手搓了 `current.filter((entry) => entry !== id)` ——**只写了减方向**，加方向连同「`null` 要按 roster 物化」这条规则一起丢了。复制过去的不是数据（那会立刻不一致），而是**规则的一半**，而半个规则在界面上与完整规则长得一模一样。
- **修法**（2026-10-02 已做）：两种方言都收进 `models.ts` 一个家——新增 `raccoonModelIsOn`（谓词）与 `toggleRaccoonModelIn`（代数），组件只调用、不再推导；roster 的行态与切换后的清单从此读**同一个谓词**，二者不可能再互相矛盾。结果保持「完整且按 roster 排序」，且**全开时不塌回 `null`**（`null` 只保留「从未策展」这一个含义），因此网关日后新增的模型默认不勾——与 Token Plan 侧 `allowListFor` 同一条政策。
- **验证**：`test/render.test.mjs` 新增 4 条，直接驱动真组件的复选框 `onChange` 并读**它 POST 了什么**（而不是读渲染）。先拿旧实现跑过一遍确认会红：`curated=["a"]` 时点 B 发出 `["a"]`（什么都没变）、`curated=[]` 时发出 `[]`（永远出不去）；修后分别得到 `["a","b"]` 与 `["b"]`。
- **教训**：**「两份不同方言的同名字段」是复制代数最常见的借口，而它恰恰是最不该就地手搓的地方。** 方言差异应该被**参数化**（收进一个模块，让两个调用点各自选方言），而不是被**下放**到调用点去各自理解。附带一条诊断口径：**读渲染的测试证明不了写路径**——复选框勾选状态来自 `state`，写出去的清单没有回显，所以这个 bug 对「渲染断言」完全隐形；要钉住它，必须让点击真的发生、并断言它发出去的载荷。

---

## 37. 空 `catch` 吞掉了功能，也吞掉了原因：面板照常用、模块缺席、零日志

- **现象**：出图工具（opt-in，默认关）注册失败——bundled tools peer 模块加载失败，或 `ctx.tools.register` 拒绝注册——面板一切正常，出图工具缺席，**日志零行**。`lifecycle.ts` 里那个 peer 加载的空 catch 注释甚至白纸黑字写着「nothing logs」。用户看到的只有「开关开了但没工具」，没有任何一行能指向原因。
- **根因**：这些路径**按设计**吞错——opt-in 模块降级必须让面板和额度读取照常工作，所以异常被吞是对的。错在**连「原因」也一起吞了**。全仓 34 处空 catch 里，真正「关键路径 + 真失败 + 零日志」的其实只有 **2 处**，全在 `lifecycle.ts` 的 draw 注册路径（peer 加载、注册被拒）。其余绝大多数是**正常缺席**（Host 没有那个服务，不该刷日志），或**本就已会告警**（vision 写入拒绝、llm peer 加载失败都已有 `logger.warn`）。
- **修法**（2026-10-03 已做）：新增 `util.degrade(reason, error, logger, fallback)`——对外照样吞，对内留痕。
  1. **`warn` 级别，不用 `debug`**：debug 行在默认 Host 上被过滤，改成 debug 等于还是零日志，目的没达成。
  2. **返回 `fallback`**：一个调用同时承接 `try { … } catch (e) { return degrade(…) }` 与 `.catch((e) => degrade(…))` 两种形态——34 处空 catch 里两种形状混杂，只写一种就得另一半先包一层 try/catch，机械活翻倍。
  3. **error 消息先过 `redactSecrets`** 再落日志（AGENTS.md 红线 1：凭据永不进日志）。
  4. `test/draw.test.mjs` 加两条 **marker grep**，锁住这两处不得退回空 catch。为什么用 grep 而不是行为测试：这两条路径的失败模式是**缺席而非抛错**，行为断言抓不到，只能锁源码标记。
- **验证**：draw 套件 76 项、typecheck 两套 0 错、`npm test` 全绿（含 e2e 91 项）。
- **教训**：**空 `catch` 不是「已经处理了」，是「把原因也处理掉了」。** 但**别批量把 34 处都改成 warn**——多数空 catch 对应的是「Host 没有某服务」的正常缺席，给它们加 warn 会把真故障淹在噪音里。判断一处空 catch 该不该有声，问两句：**它是真失败吗**（不是正常缺席）？**它另有告警路径吗**（vision 写入、peer 构建失败都已 warn）？两者都否，才值得 `degrade`。观测成本要落在真故障上，不落在所有降级上。

## 38. 同一个仓库有两种行尾：按行尾猜锚点的脚本会「静默什么都没做」

- **现象**（2026-10-05 实测，做`webSearchRestore` 槽重构时连踩两次）：改`src/host/lifecycle.ts` 时，锚点字符串按 LF 写、文件是 CRLF，于是 `String.replace` 与 `Edit` **全部静默失败**。第一次以为是工具的 bug，改用 `node -e` 脚本重试；脚本里 `s.replace(old, next)` 同样不匹配，但**没有断言**，于是脚本照常退出 0，反证测试报「29/29仍绿」——我差点把「破坏没生效」当成「新断言不够狠」。
- **根因**：`src/`+`test/` 的 CRLF/LF 分布是**混合的**（2026-10-05 复测为 41 个纯 CRLF / 97 个纯 LF / 0 混合，具体数随新增文件变，用临时 pwsh 统计即可、别写死；此前记录的「1 个混合 + `state-store.ts` 一行孤立 LF `}`」已随该文件重写消失）。两边都不算错（Windows 上的默认产物 vs. 工具写出的新文件），但**没有任何机制声明哪个是规范**，于是每个按字节匹配锚点的人都要重查一遍。而更坏的失效模式不是「报错」，是**「不报错地什么都没发生」**：`replace` 没匹配 → 文件没变 → 反证跑出绿 → 你把假绿当成真绿。这与 §30 根因 3（说谎的注释）是同一个家族：**信号缺失被读成信号正常**。
- **修法**（2026-10-05 已做）：
  1. **行尾必须先查，再写锚点**。改文件前 `node -e "const s=require('fs').readFileSync(p,'utf8');console.log((s.match(/\r\n/g)||[]).length,(s.match(/(?<!\r)\n/g)||[]).length)"`——两个数哪个是 0 决定了锚点用什么。**别猜，量。**
  2. **脚本里`replace` 之后必须断言结果变了**。`if (out === s) throw new Error('replace was a no-op')` 一行，能把「静默失败」变成「响亮失败」。同理 `findIndex` 返回 `-1` 时 `splice(-1,1)` 会删掉数组最后一行（本次真发生过：把一个文件的收尾 `}` 删掉，套件报`ERR_INVALID_TYPESCRIPT_SYNTAX`，看起来像语法错误，根因是锚点没找到）。
  3. **反证的有效性自带校验**：破坏前先打印 `replace 生效: true/false`，为 false 就不要看测试结果——测的是没改过的文件，绿得毫无意义。
- **为什么现在不统一行尾**：41:97 的分裂是历史产物，机械归一化会撞出半个仓库的diff，淹没真正要review 的那几行；且本仓不做跨平台 checkout（Windows 开发、CI 跑同一份），**没有实际故障在等它修**。所以记录判据而不动手：**等它真的咬人时（出现第二种「静默无操作」的失效，或需要在 LF/CRLF 间做字节级断言）再归一**。§33 同一原则——先看它是否已产生真实故障。
- **教训**：**当一个工具「什么都没做」而你不知道时，你会把假绿当真绿。** 修法不是更小心地写锚点，是**让无操作变成响亮的**：`replace` 后断言变化、`findIndex` 校验 `-1`、破坏前确认生效。**这与 §30 根因 3 是同一条纪律的两面**——那条讲「注释里的说谎让人以为红色已知」，这条讲「静默的无操作让人以为绿色已验证」。

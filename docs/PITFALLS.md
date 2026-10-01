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
- **根因**：`llm-adapter.ts` 要 import Host 发行的三个 peer（`@earendil-works/pi-ai`、
  `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`），而 Node 的裸模块解析是从**该文件所在目录**逐级向上找
  `node_modules`。npm 装进 profile 的插件（`profiles/web/node_modules/<name>` 是**真实目录**）会向上走到
  `profiles/node_modules`，那里有 Host 的 peer；开发期的 `~/.dsh/plugins/<name>` 是**符号链接/junction** 进
  profile 的，Node 默认把链接解成 realpath，于是解析链从插件目录向上只剩 `~/.dsh/plugins`、`~/.dsh`、`~`，
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
  另外文档写 `max_tokens` 默认 65535，目录实际 `max_output_length` 是 65536；窗口字段是 `context_length` 不是 `context_window`（曾让 `contextWindowOf` 拿不到真实窗口、全体回退 128k，见 `llm-models.js` 与 `test/provider.test.mjs`）。
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

- **现象**：`docs.test.mjs` 十条检查全绿——127 条内部链接可解析、37 张表无跨文件重复、README 76 行远低于 140 上限、API 快照 14 键契约一致。同一时刻的 README：① **零处**提到当期头条特性（第三个 tab「小浣熊」）；② 三处仍写「侧边栏」，而代码早已迁到 Plugins 页，第 31 行「打开侧边栏「积分面板」」让用户**找不到入口**；③ 仍挂着「面板**只读**」的承诺，而它已经会注册推理通道、挂出图工具、写 DSH settings。
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
  2. **`set -e` + 19 个套件写在同一个 step**：第 2 个套件一抛错，后面 17 个（含 `build-gate`）**一次都没跑过**。于是「门禁红」看起来像某个用例失败，实际是**门禁根本没在验证**。
  3. **注释替这堆问题背了书**：workflow 写着这些套件「resolve peers from stubs」——`peer-roots.mjs` 里**没有任何 stub**，只有真实运行时查找；又写 peer「cannot resolve from any registry」——包其实都在 registry 上，只是**只发预发布版**，而声明范围 `>=0.1.5 <0.3` 在 npm 默认 semver 规则下**不匹配预发布**（`npm view '@deepseek-ai/dsh-credentials@>=0.1.5 <0.3'` 直接 E404）。两条加起来，读注释的人会得出「CI 本来就这样」——**这正是它红了一整天没人管的原因**。
- **修法**（2026-10-01 已做）：offline job 增加 `npm install -g @deepseek-ai/dsh`（**全局**装：不读本仓 manifest，npm 才会去拉运行时自己的 peer 闭包），`test/peer-roots.mjs` 新增 `cliRuntimeModules()`（从 `test/e2e.mjs` 抽出并共享；`npm root -g` → `<prefix>/@deepseek-ai/dsh/node_modules`，marker `dsh-base`，每进程 memo 一次）作为**最后**一个候选根。本地优先级不变，开发机仍优先跑它真正运行的那份运行时。
- **验证**（不 push 也能验，且必须这么做）：把开发机的运行时候选**全部屏蔽**——`USERPROFILE` / `LOCALAPPDATA` / `DSH_HOME` 指向空目录（`APPDATA` 不能动：Windows 上 npm 的全局前缀取自它）——此时 `findPeerRoot()` 必须落到 CLI 运行时树，然后跑**完整 19 套件 + build-gate**，全绿才算修好（本机实测：屏蔽后 19 套件 + build-gate 全绿，`e2e` 44/44）。反证也做过：该条件下只装 2–3 个 registry 包，`store.test.mjs` 会以 `Cannot find package '@deepseek-ai/dsh-atomic-write'` 崩——**DSH 整套包互相以 peerDependencies 咬合，装子集必留悬空 import**，这就是「必须整棵运行时」的判据。
- **教训**：**门禁的依赖获取方式也是门禁的一部分**。判据不是「CI 红没红」，而是「**这个门禁在目标环境上有没有可能变绿**」——恒红的门禁与没有门禁等价，甚至更糟：它把真回归淹进噪音，还让 release 照发。三条纪律：① **clean runner 上必须能绿**；做不到就把来源写进 workflow，**不要**在测试里加 SKIP（把 peer 依赖 SKIP 掉 = 绿着什么都没测）；② **别把 N 个套件塞进一个 `set -e` step**，一次失败会吞掉其余套件的全部信号；③ **注释里的「为什么这样做」必须与实现同步**——本次三条根因里最难发现的恰恰是那条说谎的注释，它让每个人都以为这是已知且可接受的红色。

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

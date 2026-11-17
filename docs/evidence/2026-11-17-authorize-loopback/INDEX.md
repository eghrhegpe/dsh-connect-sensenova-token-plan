# 证据：官方浏览器授权链（/authorize → /login → 授权码）2026-11-17 可用性判定

2026-11-17 12:46–12:47（Asia/Shanghai），浏览器截图（用户操作，地址栏可见 URL；图中不含 `code=` 值，无凭据泄漏）。
背景：小浣熊 QR 扫码确认页 `/login/mp` 自 11-04 起 404（本仓 ROADMAP §6.1.10），两家插件的
QR 扫码链路同死。官方桌面客户端（11-05 构建，`C:\Program Files\raccoon-ai`）的登录主链已换成
**浏览器授权 + 回调**（asar 内 `build/electron/main/account/desktopLogin.js` /
`client/account/webLogin(.Loopback).js`），本目录记录该链的线上可用性判定。

## 图录

| 文件 | 页面 / URL（地址栏） | 证明 |
|---|---|---|
| [01-authorize-url-a-not-signed-in.png](./01-authorize-url-a-not-signed-in.png) | `GET /authorize?login_source=desktop&appname=办公小浣熊客户端` | 未登录态下 `/authorize` 渲染 200，提示「请先登录，再确认是否授权此应用」+「登录并继续」入口——**授权页本身活着**（与 404 的 `/login/mp` 是两条不同链路） |
| [02-login-page-phone-tab.png](./02-login-page-phone-tab.png) | `GET /login?lang=zh&redirect_url=%2Fauthorize%3F…` | 登录页手机号 Tab 正常（+86 手机 + 验证码 +「发送验证码」+「切换为密码登录」） |
| [03-login-page-wechat-scan-tab.png](./03-login-page-wechat-scan-tab.png) | 同 `/login`，切「微信扫码」Tab | **登录页内的微信扫码 QR 正常渲染**（先勾选条款再同意）——网页扫码登录活着；死的只是 `/login/mp` 那个 QR 确认路由 |
| [04-authorize-success.png](./04-authorize-success.png) | `GET /authorize?lang=zh&login_source=desktop&ap…` | 「✓ 授权成功 / 请返回客户端继续使用」——**授权码已签发**，经深链 `office-raccoon://auth/callback` 投递（该 code 已被消费，图中无值） |

## 判定（2026-11-17）

1. **整条浏览器授权链活着**：`/authorize`（200）→ 未登录时 `/login`（手机号 / 微信扫码均可）→ 授权同意 →
   `POST /api/web/auth/v1/authorization_code` 签发一次性 code → 深链 / loopback 投递。QR 确认页 404
   **不影响**这条链。
2. loopback 变体（`&desktop_callback=loopback&redirect=http://127.0.0.1:<port>/auth/callback&state=<64hex>`）：
   - 页面侧上下文解析（客户端 bundle 内 `R()` 函数，已原样离线复跑）：合法，context 含 `desktopCallback:"loopback"`；
   - 服务端 SSR flight 数据同样接受该参数组；
   - **未端到端验证的一跳**：签发后服务端是否真按 `redirect` 跳回 loopback（本次实测走的是深链成功屏，
     图 4）。插件实现落地时用 4321 端口探针一次性点穿即可定案（探针脚本见会话记录，规则照官方
     `webLoginLoopback.js`：GET / host / origin / sec-fetch-dest / path / query 键白名单 / state 64hex
     timingSafeEqual / 一次性）。
3. 兑换端点 `POST /api/web/auth/v1/login_with_authorization_code` 活着（同日 bogus code 探针：
   `400 code 200035 authorization_code_not_found_error`）。
4. 配套事实（官方 11-05 客户端源码）：IAM token（`iss` 以 `/iam` 结尾）不存 refresh、续期提前窗为 0；
   非 IAM 才有 300s 提前窗（`scheduleAuth.js` L76）——与参考插件整段抄 300s 的差异项。

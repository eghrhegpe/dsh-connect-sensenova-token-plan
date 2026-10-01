# 认证设计（Auth）

面板显示的数据来自商汤控制台自己的 API；要调这些接口，必须持有控制台 JWT。JWT 只有约 **180 分钟**有效，本插件的设计目标是：**登录一次，之后全自动，且绝不让错密码把账号锁死。**

---

## 1. 认证模型概览

```
用户填账号密码 ──► Host 走 OIDC 授权码流（PKCE）
                         │
                         ├─ 密码用平台 JWKS 公钥封成 JWE（RSA-OAEP + A256GCM），明文不上网
                         ├─ 密码只在登录瞬间于内存中使用，用完即弃，不落盘
                         │
                         ▼
                   DSH 凭据服务（~/.dsh/.credentials.yaml，仅本账户可读）
                         存：账号 + access_token + refresh_token
                         │
                         ▼
              此后只靠 refresh_token 静默续期；
              想自动重登（refresh 失效时），把密码放进环境变量 SENSENOVA_PASSWORD
```

- **密码不落盘**：`SENSENOVA_PASSWORD` 环境变量是它唯一的持久来源（显式 opt-in——放在环境里，refresh_token 失效后可自动重登，无需再输一次）。账号名以面板保存的为准，环境变量兜底。
- 密码只发往本机 Host，再由它加密送往商汤；它不写入任何文件。没有 `.env`、没有重启、没有明文凭据文件。

---

## 2. OIDC 授权码流 + PKCE

`GET /api/.../account`（POST 账号）触发完整授权码流：

1. 生成 PKCE `code_verifier` / `code_challenge`（S256）。
2. 跳转授权端点（`consoleBase` + `/oauth2/auth`，`client_id=nova`），同时携带一个随机 `state` nonce。
3. 跟随最多 `maxHops` 跳的重定向链；回调 URL 里的 `state` 必须**原样带回**第 2 步发出的 nonce，否则按 `login_flow` 拒绝（防外部注入的重放回调）。PKCE 把 code 绑定到本进程（verifier），state 是这半个绑定的另一半。
4. 令牌端点用 `scope=openid offline offline_access` 换取 `access_token` + `refresh_token`（`offline_access` 是拿到 refresh_token 的前提）。

---

## 3. 密码 JWE 加密

账号密码不能明文发往 IAM。登录时用平台 JWKS 公钥（`jwksEndpoint`，key id = `encKeyId` 默认 `public:hydra.openid.id-token`）对密码做：

- **RSA-OAEP**（密钥封装，把一次性 CEK 包起来）
- **A256GCM**（内容加密，带 16 字节 GCM tag）

即标准的 `RSA-OAEP + A256GCM` JWE，与网页端一致；每次封包用全新 CEK / IV。明文密码不出现在请求里（封包后的密文出现在 IAM 调用上，并被标记为 `encrypted`）。

---

## 4. 凭据存储

账号、access/refresh token 只经 **DSH 凭据服务**写入 `~/.dsh/.credentials.yaml`，权限限制为仅本账户可读。**密码不写入任何文件**：登录时经内存使用，用完即弃；`SENSENOVA_PASSWORD` 环境变量是它唯一的持久来源（显式 opt-in）。旧版本曾把密码存进凭据服务，本版在首次接触时自动清除该残留值。本插件**不写任何明文凭据文件、也不写调试日志**。

没有凭据服务时（如某些 `dsh web` profile、或测试环境）：面板仍可打开，但账号只存**内存**（标记 `ephemeral`），重启后需重登——此时面板会明确提示，而不是假装已保存。

---

## 5. 静默续期

- 令牌在过期前 `tokenSkewSeconds`（默认 120s）触发续期。
- 控制台返回 **401** 时，也会用 `refresh_token` 换新并重试一次。
- 续期失败（refresh_token 被吊销）且环境已无密码时，面板明确提示需要重新登录，而不是静默显示旧数据。
- 续期状态写入凭据记录 `dsh-connect-sensenova-token-plan/sensenova-console`（含 `hasRefreshToken` / `expiresAt`）。

**「自动」到哪一步为止**（三个常被混成一件事的边界）：本节说的自动，指的是**令牌续期**——它不需要用户在场。**登录本身永远需要用户在场一次**（浏览器 OIDC 授权码 + PKCE），此后才谈得上静默续期；「密码自动重登」是**显式 opt-in**：只有 `SENSENOVA_PASSWORD` 在 Host 进程环境里、且账号已存，refresh_token 被吊销时才会用密码重登（面板文案 `auth.autoRecoverOn`），没有它则明确要求重新登录；平台要短信/图形验证码时自动化注定完不成（`auth.verification`，见 §7）。另外，**本插件不含任何签到 / 每日领取调用**——自动续期不产生积分副作用，别把它读成「在后台刷签到」（第二上游的日发积分由服务端自动发放，见 [ROADMAP.md](./ROADMAP.md) §6.1.4）。

---

## 6. 登录节流（防锁号的核心）

平台在几次失败尝试后会**锁号**，所以插件**绝不在定时轮询里重发密码**。两类拒绝区别对待：

| 拒绝类型 | 平台返回 | 行为 |
|---|---|---|
| **时间型**（锁定、频率限制、平台故障） | 带等待窗口，或无窗口 | 等待窗口结束前直接失败，不发请求。平台声明的窗口**照单全收，绝不截短**（声明 2 小时就等满 2 小时）；无窗口时本地指数退避 60s → 2m → 4m … 上限 30 分钟。窗口一到恰好探测一次。 |
| **凭据型**（密码错误、需验证码） | `invalidAccountOrPassword` 等 | **完全不自动重试**——等待改变不了一个错密码。面板重新提示输入账号，只有用户主动提交才再试。 |

节流状态写在**插件自己的状态文件**（`$DSH_HOME/state/<plugin>/throttle.json`，原子写、0600），因此**跨进程、跨重启**都生效：另一个 Host 进程（桌面版 / `dsh web` 用不同 profile，但可能共用同一 Home）不会在等待期内继续敲门。放在插件自己的文件里而不是凭据服务，是因为节流不是凭据，而凭据服务只认两种记录 kind——发明第三种会让整份凭据文件对 Host 不可解析（见 PITFALLS §6 与 `throttle-store.js` 头注）。旧版曾把节流伪装成 `grant` 记录（marker 字段 `THROTTLE_MARKER`）寄存在凭据服务里，该地址仅作**一次性迁移读取**，之后不再写入。窗口读取同时支持中英文（「try again after 8 minutes」与「请 8 分钟后重试」）以及 `Retry-After` 头。

注意**跨 profile 共享这条只对节流成立**：`catalog` / `provider` / `draw` 三份状态是 **per-profile** 的（`$DSH_HOME/state/<profile>/<name>/`，见 [PITFALLS.md](./PITFALLS.md) §23），与节流**故意相反**——它们答的是「这个 profile 要什么」，而节流答的是「上游要这台机器等多久」。别把两者"统一"成同一种粒度。

---

## 7. 登录失败怎么办

- 表单下方显示商汤返回的原因（通常是「账号或密码不正确」）。
- 时间型拒绝：按钮变灰并展示平台声明的等待分钟数，等待期不自动重试。
- 凭据型拒绝：清空重填，只有你主动点「登录」才会再发一次——绝不让错密码被轮询反复发送导致锁号。
- 若 `refresh_token` 被吊销且密码已不在环境中，面板重新显示表单，此时填一次即可。

---

## 8. 清除账号

面板底部「连接商汤控制台」区卡里可清除已保存账号；当前令牌仍会继续用 `refresh_token` 续期，直到确实需要密码为止。清除只删账号引用，不删仍有效的令牌记录。

清除后到 grant 失效的这段**中间态**里，面板照常读额度，同时「连接商汤控制台」区卡**保持常显**（无条件可见，不限登录态）——随时可重输账号把仍在有效的 grant 改指到新账号，无需等 refresh_token 失效才拿到重输入口。

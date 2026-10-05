# token-store.ts 拆分方案（登录 / 续期 / 节流 / 迁移）

> 锐评 #5：944 行 `token-store.js` 单体（现 TS 化，见下文状态）。本文是拆分的设计蓝图。
> 前置护栏：`test/store-baseline.test.mjs`（17 场景 48 帧全行为冻结基线，
> 见 [TESTING.md §5](./TESTING.md)）。拆分的门禁 = 基线零漂移 + `store.test.mjs` 全绿。
>
> **状态（2026-09-29）：6 步全部落地，token-store 从 944 行单体收口为薄 facade（`token-store.ts` + `token-store/` 七块子模块；行数是时点值，别当契约，`(Get-Content src/host/token-store.ts).Count` 自证）。**
> 各块已抽至 `token-store/{state,grant,throttle,account,renewal,acquire,constants}.ts`（源码已 TS 化，构建产物仍为 .js；`constants.ts` 集中收拢记录地址常量），
> 全量离线套件 + 基线 48 帧零漂移全绿。剩余：§7 迁移块退役（下次大版本）。

---

## 0. 为什么要按「块」拆，而不是按「类」拆

现状的 944 行不是 4 个独立类，而是 **1 个闭包 + 4 块逻辑**：所有函数共享
`cached` / `rejected` / `inflight` / `lastError` / `throttle` / `consecutiveRefusals` /
`passwordSwept` 七个闭包变量（拆分后又加了 `saveInflight`——facade 里 `saveAccount`
的单一进行中登录，见 §1 表，故实际八变量），`acquire()` 是四块在运行时交手的唯一缝。直接「按类」
拆（每个函数各建文件、互相回调）会把隐式共享变成 4×4 的交叉引用；按「块」拆
（每块一个模块 + **一个显式 state 对象**）才能保留「谁在什么时候写哪个变量」的可读性。

拆完后的目标形状：

```
token-store.js        薄 facade：createTokenStore(options) 组装 wiring + state，
                      委托各块，导出原公共 API（getToken/invalidate/saveAccount/
                      forgetAccount/state）与全部常量 re-export。index.js 的
                      import 一行不动。
token-store/state.js  StoreState（七变量的显式容器）+ Wiring（backend/memory
                      vault/keys/now/skewMs/env/refs），工厂 createStoreContext()
token-store/grant.js  parseGrant / readStored / adoptLegacyGrant / store(CAS) /
                      purgeGrant / isFresh            （块 1：grant 的读写与判定）
token-store/account.js readUsername / readAccount(+密码清扫) / loginFromAccount /
                      saveAccount / forgetAccount     （块 2：账号生命周期）
token-store/renewal.js renewWithRefresh + refresh_rejected 岔路（回收 vs 重登）
                                        （块 3：续期）
token-store/throttle.js localBackoffMs / readThrottle / adoptLegacyThrottle /
                      writeThrottle / clearThrottle / inForceWaitMs / throttleError
                                        （块 4：节流状态机 + 旧记录收养）
token-store/acquire.js acquire()：节流闸门 → grant 新鲜判定 → 续期 → 登录兜底
                      （四块交手的唯一缝，留在独立模块，不塞进任何一块）
```

现状：`token-store.js` 已 TS 化为**完整的薄 facade**
`src/host/token-store.ts`——`createTokenStore` 组装 context + 委托六块（行数用 `(Get-Content src/host/token-store.ts).Count` 自证，本文不写死），
`src/host/index.ts` 直接 `import { createTokenStore } from "./token-store.ts"`，而
`package.json` **没有** `./token-store` 导出。早期规划中的「再导出 shim」没有落地；
e2e / wiring 套件的注入面由 facade 的**公开选项名与常量 re-export 面保持不变**（§5）保证。

---

## 1. 状态归属表（七个闭包变量 → 新 owner）

| 变量 | 语义 | 新 owner | 读写方 |
|---|---|---|---|
| `cached` | 本进程内存 grant 镜像 | `state.grant`（grant.js 写，renewal.js 写） | getToken 短路读 |
| `rejected` | 被控制台 401 过的 token 集（≤8） | `state.grant.rejected`（grant.js `markRejected`） | `isFresh` 读；`invalidate` 写 |
| `inflight` | 单一进行中的 acquire | `state.acquire`（facade 的 `getToken` 管） | 并发短路 |
| `lastError` | 最近一次失败，供 `state()` 报 | `state.ui`（facade 写，`state()` 读） | state().error |
| `throttle` | 本进程节流镜像（与持久存储同形） | `state.throttle`（throttle.js 唯一写方） | acquire 闸门读 |
| `consecutiveRefusals` | 跨关窗保留的连续拒绝计数 | `state.throttle.attempt` 同源（与 `throttle` 合并进一个 `throttle.js` 拥有的 `held` 结构，关窗不清零） | writeThrottle 读前值 |
| `passwordSwept` | 旧版密码 ref 一次性清扫标志 | `state.account`（account.js） | readAccount |

**纪律**：每个块只写自己 owner 的字段，读任何字段必须显式经 `state.` 前缀。
基线冻结的凭据服务调用序列对「读的顺序」敏感（S1/S4 帧可证），所以
`acquire.js` 里的调用次序 = 基线次序，搬代码时**不许顺手改调用顺序**。

---

## 2. 四块内容清单（从现文件行号 → 新模块）

| 新模块 | 迁自 `token-store.js` | 备注 |
|---|---|---|
| `state.js` | 构造器头（wiring 解析、memory vault、`resolveService`/`backend`/`ephemeral`）+ 七个 let 变量 | memory vault 留 wiring 层，不进块 |
| `grant.js` | `parseGrant`（模块级）/ `readStored` / `adoptLegacyGrant` / `store` / `purgeGrant` / `isFresh` | `parseGrant` 用 `readJwtExpiry`（sensenova-auth 再导出），注入即可 |
| `account.js` | `readUsername` / `readAccount` / `loginFromAccount` / `saveAccount` / `forgetAccount` / 常量 `USERNAME_REF`/`PASSWORD_REF` 的使用 | 密码永不入 refs——`saveAccount` 的注释原样搬 |
| `renewal.js` | `renewWithRefresh` + `acquire` 内 refresh 失败岔路（`refresh_rejected`/`no_refresh_token` → 有账号重登 / 无账号 `purgeGrant` 回收） | 岔路逻辑**留在 acquire.js 调用 renewal.js 的出口钩子**，renewal.js 本身只做「refresh → store(CAS) 命名 superseded」 |
| `throttle.js` | `localBackoffMs` / `readThrottle` / `adoptLegacyThrottle` / `writeThrottle` / `clearThrottle` / `inForceWaitMs` / `throttleError`（模块级） | `THROTTLE_MARKER` 常量随迁 |
| `acquire.js` | `acquire`（729 行起 ~80 行）+ `getToken` 壳（inflight/lastError） | 唯一的交互缝，保持最小 |
| `index.js`（facade） | `createTokenStore` 组装、`invalidate`、`state()` 的读侧拼装 | `state()` 调用各块的 read 视图，拼装顺序 = 基线顺序 |

---

## 3. 迁移（migration）块的处置

`adoptLegacyGrant` / `adoptLegacyThrottle` / 密码 ref 清扫是三处**一次性迁移**，
挂在读路径上（读 grant 时收养旧命名 grant；读节流时收养旧命名/寄居记录；
首次 readAccount 清扫旧密码 ref）。

- **拆分时**：作为 `grant.js` / `throttle.js` / `account.js` 各自的尾部私有函数
  原样保留（语义与注释一字不动），它们不是独立「迁移块」——强行抽出第五个
  模块只会多一个只被调用一次的 import。
- **退役条件**（写进各函数头注释，别忘删）：`LEGACY_SCOPE` 命名空间在目标
  用户群全部升级过一个完整发布周期后，三处收养与清扫可整段删除，`state.js`
  的 wiring 随之少两个 legacy key。删除时基线对应帧（S9a/S9b/S9c）要**同时**
  重生成——那是唯一的「有意漂移」窗口，提交信息写明退役原因。

---

## 4. 分步落地（每步独立提交、独立可回滚）

| 步 | 内容 | 门禁 | 提交 | 状态 |
|---|---|---|---|---|
| 1 | 新增 `token-store/state.js`：`createStoreContext(options)` 产出 `{ wiring, state }`；`createTokenStore` 改为「组 context → 委托」，函数体不动 | 基线零漂移 + store 131 | `57cdc7e`+`ffca7af` | ✅ |
| 2 | 抽 `token-store/grant.js`（`parseGrant` 模块级 + 五个闭包函数 `(wiring,state)` 参数化） | 同上 | `fabe450`+`d57207d` | ✅ |
| 3 | 抽 `token-store/throttle.js`（七函数 + `DEFAULT_LOGIN_BACKOFF_MS`/`MAX_LOGIN_BACKOFF_MS`/`THROTTLE_MARKER` 常量随迁） | 同上，S3/S4/S5/S11 帧重点核对 | `6c9ec96`+`00eeaef` | ✅ |
| 4 | 抽 `token-store/account.js`（`readUsername`/`readAccount`/`loginFromAccount`/`forgetAccount` + `passwordSwept` 语义 + `USERNAME_REF`/`PASSWORD_REF` 随迁） | 同上，S9c/S10 帧重点核对 | `b44a5f8`+`fd854fa` | ✅ |
| 5 | 抽 `token-store/renewal.js` + `token-store/acquire.js`（`renewWithRefresh` 经 `store` 回调注入；`acquire` 经 `blocks` 参数注入四块函数，调用次序 = 基线次序） | 同上，S6a/b/c、S7a/b、S8 帧重点核对 | `623b673`+`a0ee546` | ✅ |
| 6 | `token-store.js` 收口为薄 facade（944 行 → 351 行）：删除全部死委托壳，`createTokenStore` 内 14 行 const 一行委托 + 公开 API 编排；公开导出面不变 | 全量 17 离线套件全绿 | `47c0bdf` | ✅ |
| 7（下个大版本） | 退役三处 legacy 迁移（§3 条件满足时），`UPDATE_BASELINE=1` 重生成并在提交信息写明 | 基线（新版）零漂移 | — | ⏳ |

每步**只搬不写**：函数体、注释、调用次序原样移动；唯一允许的新代码是
`state.js` 的 context 工厂与 facade 委托。某一步基线红了，就是该步动了语义——
先修回原文形状再谈下一步，禁止「顺手优化」。

---

## 5. 红线核对表（拆分前后逐条过）

- [x] `get` 到的 token 的**来源次序**不变：节流闸门 → 内存缓存 → 持久 grant（含旧命名收养）→ refresh（含 CAS）→ 登录兜底。基线 S1–S8 帧钉死。
- [x] 凭据服务**调用序列**不变（基线逐帧 `calls` 数组即序列快照）；尤其
      `saveAccount` 的「先 set ref、清节流、再 login」与 `state()` 的六步读序。
- [x] 错误对象：`throttleError(held, cause)` 的 cause 语义（窗口期内报平台原话、
      过窗后报本模块话术）原样保留；`state().error` 仍取 `lastError.message`。
- [x] `state()` 九键 + `autoRecoverArmed` 布尔，键集与取值规则不变（S 帧 result 逐值）。
- [x] 密码不落盘：`saveAccount` 只 `set` username ref；`readAccount` 的密码来源只有
      env 与显式入参。`store.test.mjs` 8/10 组独立守住，基线 S10/S11 帧同。
- [x] 节流寄居记录的 marker/version 校验不变（`THROTTLE_MARKER` + `THROTTLE_VERSION`），
      非法记录读作 absent（S9b 帧）。
- [x] `createTokenStore` 的**公开选项名**不变（index.js 与 e2e 的注入面）。
- [x] `token-store.js` 的 re-export 面不变：`createTokenStore` + `RECORD_SCOPE` /
      `LEGACY_SCOPE` / `RECORD_ID` / `USERNAME_REF` / `PASSWORD_REF` / `THROTTLE_ID` /
      `DEFAULT_LOGIN_BACKOFF_MS` / `MAX_LOGIN_BACKOFF_MS`（`store.test.mjs` 与
      `peer-contract` 依赖这些名）。

---

## 6. 判停条件（任一出现就停，回滚到上一步）

1. 某步基线出现**非本步引入**的漂移（说明并行会话也在动 token-store.js——
   等它收口，见 AGENTS.md 并行纪律）。
2. 拆完六步后 `npm test` 全量出现**新**失败（非基线）——语义有遗漏，停。
3. `acquire.js` 超过 ~120 行还装不下交互缝——说明块的边界划错了，
   回来重划（候选：把「refresh 失败岔路」整段归给 renewal.js，acquire 只留调用）。

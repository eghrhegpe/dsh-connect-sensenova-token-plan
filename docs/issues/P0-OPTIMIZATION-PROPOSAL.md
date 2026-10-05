# 优化方案：P0 两条待拍板

审查发现的最高优先级两条，都不是热路径小项，按项目纪律先出方案等拍板。
已在同一轮直接修掉的：客户端样式收编 + memo 依赖（811716a）、token-store
那个从不分叉的三元（639df2b）。

---

## P0-1 第二上游能顶掉别的插件的搜索 provider

**现状**（`src/host/lifecycle.ts:555-573`）

```ts
web.searchProviderId = RACCOON_SEARCH_PROVIDER_ID;
```

`ctx.web` 是**DSH 全局单例**，不是本插件的 provider 命名空间。小浣熊开关一
开，就直接改写宿主进程的全局搜索路由。

**为什么这是 P0**：`ARCHITECTURE.md` §5 的不变量要求「改raccoon 这条线对主
注册的影响恒为零」。导入级隔离我已核实为零越界，但这处写的是宿主单例——**它
是唯一一处真正的破口**，也是 AGENTS.md 点名的"唯一缺口"。

**已有的缓解**（做对了一半）：记 `state.displaced` + `preexisting`，`teardown`
在 `:655` 还原。缺口在恢复时机：

```ts
// index.ts:331
webSearchRestore: { current: null },
```

`registerWebSearchProvider` 在 mount 时填槽；若 seed 早于装配完成，
`teardown` 里 `current?.()` 静默不执行，**抢占不归还**。

### 三个选项

| 选项 | 做法 | 代价 | 风险 |
|---|---|---|---|
| **A. 补齐归还（推荐）** | 槽位初值改为「无条件还原」的函数而非 `null`：seed 早到也记下 preexisting，等接管发生再记账 | 改`lifecycle.ts` + `index.ts` 两处 | 低。不变量本来就要求归还，这只是补齐它 |
| **B. 加断言** | 抢占前检查 `web.searchProviderId` 是否已被别的插件占用，冲突则拒绝接管并降级（沿用既有degrade 姿势） | 只改 `lifecycle.ts` | 中。需要定「拒绝时面板说什么」 |
| **C. 不动** | 现状+ 注释说明这是有意的 | 0 | 高。这条不变量现在写在架构文档里，实现不满足 |

**我倾向 A**：`ARCHITECTURE.md` 既然写了「恒为零」，实现就得兑现。B 是防御性
的补丁，治标不治本——问题不是「会不会冲突」，是「凭什么由我改全局」。

---

## P0-2 `saveAccount` 绕过 inflight 锁，并发登录打向平台

**现状**（`src/host/token-store.ts`）

```ts
:172   state.inflight ??= ...        // 只护 getToken
:241   saveAccount() → loginFromAccount()   // 直调，无互斥
:236   clearThrottle()               // 且先把闸门抹掉
```

**为什么这是 P0**：POST /account 与面板轮询重叠时，**两次登录同时打向商汤**。
红线5 明写「登录路径每次尝试必须经 onTrace 落盘」，理由是「平台锁定账户是真实
风险」——同一个闸门正在被绕过。这是锁号路径。

跨进程更弱：`throttle.ts:168` 的 write 是**事后记录**，两个进程在同一窗口内
各自读不到节流→ 各花一次尝试。`token-store.ts:29` 宣称的「第二进程不再敲
门」只在**首次拒绝之后**成立。

### 三个选项

| 选项 | 做法 | 代价 | 风险 |
|---|---|---|---|
| **A. inflight 覆盖 saveAccount（推荐）** | 让 `saveAccount` 走同一把锁；锁被占时等它释放而不是再打一次 | 改 `token-store.ts` 约 15 行 | 中。store-baseline 是行为冻结面，**可能要 UPDATE_BASELINE=1**——按AGENTS.md 这是更大的事，需你点头 |
| **B. 只在写路径加闸** | `clearThrottle` 之前先确认没有 in-flight | 局部，但治不了根 | 中。「没有 in-flight」本身就是要修的竞态 |
| **C. 只在文档记下** | 承认单进程假定 | 0 | 高。这正是 store-baseline 存在的意义 |

**我倾向 A**，但有个前置条件要先查清：`saveAccount` 等锁期间的**用户可见行
为**（面板该显示什么？）没有定义。这不是实现细节，是产品决定——所以我不擅自
定。

---

## 建议顺序

1. 先拍 P0-1 的选项（A/B/C）
2. P0-2 我需要你回答一个问题再动手：**并发登录被合并时，面板显示什么？**
   - 「登录中…」直到另一路完成（推荐，用户看不出并发）
   - 直接复用另一路的结果
   - 报「已有登录在进行」

## 我**没有**动的东西，及原因

| 项| 为什么没动 |
|---|---|
| `web.searchProviderId` 全局写入本身 | 架构级，按纪律等你拍板 |
| `grant.ts:127` 的 `10800` 硬编码 | **审查结论有误，我已推翻**：那不是「忽略配置项」。`sensenova-auth.ts:104-107` 已把 `assumedTokenLifetimeSeconds` 用在 `expires_in` 缺失的兜底上，`grant.ts` 的 `num(expiresIn, 10800)` 是第二道兜底，只在`expiresIn` 本身非有限数时才轮到 |
| `throttleError` 的合成路径 | **审查结论有误，我已推翻**：不是死代码。`acquire.ts:62` 的闸门 `throw throttleError(held)` 不传cause，走的正是合成分支。真实问题只是 `:122` 那个三元不区分——已在 639df2b 修掉 |
| 六份手抄的 `writePayload` | 抽 `createVersionedJsonStore` 是 6 文件重构，且撞 store-baseline。建议独立一轮，不混进P0 |
| `qr.ts` 509 行 | 依赖问题（它换一张 `<img>`，且抛错可降级），不是紧急 |
| `shared/wire.ts` 的 104 行raccoon 专属 | 搬文件收益低、风险中等，留到重构轮 |
| `token-store` 十三包装 / 假依赖注入 | 拆分本身边界是干净的，收益被注释放大。**砍注释比拆文件划算得多** |

---

## 附：这轮实际改了什么

**811716a** — 客户端样式收编

- `model-picker.ts`：`llm` 为 null 时 `:114` 的 `[]` 字面量每次渲染都是新对象，
  `useMemo`/`useCallback` 每次失效（注释却声称引用恒等）。提`NO_MODELS`/
  `NO_IDS` 模块级 frozen 常量，注释这才成立。
- `styles.ts` 新增 `modelRowLabel`：同一套 label 样式在 `model-row.ts:84` 与
  `provider-controls.ts:230/257`被逐字内联三遍——`ModelRow` 抽了等于没抽。
- `styles.ts` 新增 `externalLink`：外链样式逐字复制三份（account-form /
  api-key-form / raccoon-card），而 styles 里原本没有对应 token。

**639df2b** — token-store 表达性清理

- `acquire.ts:122` 的 `held.parked ? error : throttleError(held, error)` 是
  一个「从不分叉的三元」：`throttleError` 拿到 cause 就原样返回，两臂交回同一
  对象。改为单次抛出 + 不接返回值。
- store-baseline 17 场景 48帧零漂移，证实是纯表达性清理，未触发 UPDATE_BASELINE。

验证：typecheck-gate（含负控制）+ panel 75 checks + **全量 30 套件** + 91 e2e 全绿。

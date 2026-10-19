# 结构债台账（P1，2026-10-05 建）

承接 [P0-OPTIMIZATION-PROPOSAL.md](./P0-OPTIMIZATION-PROPOSAL.md) 的结构债清单。
P0 两条已修 + P1 writePayload 收编后的**剩余结构性欠账**，逐项给现状 / 为什么没动 / 出手条件。

---

## 本轮（提交 1109889）已完成

| 项 | 落点 | 说明 |
|---|---|---|
| eager-refresh 仪式收编 | `raccoon-store.ts` `prepareForRequest()`；三调用点（index / seed / raccoon-status）改走它 | 此前 `if (isExpired()) refresh()` 手抄三处，漂移无门禁 |
| 挂载 effect 注册表 | `effects.ts` + `lifecycle.ts` `startSideEffects` 第 4 参 + `index.ts` unmount cleanup | ADR-008：unmount 先 drain(5s) 再 teardown，straggler 按 label 告警；吞 rejection 补上 `void reconcileWebSearch` 的无 handler 洞 |
| web-search 段拆分 | `web-search.ts`（7 导出）+ lifecycle 门面再导出 | 门面零改动先例（同 raccoon 拆分）；孤儿 JSDoc 转 banner、teardown JSDoc 归位 |
| teardown `?.release?.()` 降噪 | `lifecycle.ts` | release 在该 publisher 必填，`?.()` 多余 |
| jsQR 注释修正 | `raccoon.test.mjs` §7 | jsQR 已是 devDependency，注释不再声称 devDependency-free |

## 遗留（未动，含原因）

| 项 | 现状 | 为什么没动 / 出手条件 |
|---|---|---|
| ~~`web.searchProviderId` 全局写本身~~ **P0-1** | P0-1 只补了「归还路径」（dispose 竞态不再永久顶掉别的插件），但「由本插件改写 DSH 全局搜索路由」这一架构事实仍在 | ✅ 已处理（Option B，2026-10-19）：`applyWebSearchSelection` 只在**空槽或自持**时接管；**外来 provider 占用时拒绝**（模块缺席，不顶替兄弟）。`web-search.ts` JSDoc + `raccoon-web.test.mjs` 全部 happy-path 用例从 foreign prior 改到 empty prior + 新增 refuse-case 断言。根子「凭什么由我改全局」仍开放 —— 真正解法是宿主提供 plugin-owned 选择面 |
| ~~`types.ts` `HostDeps` 袋装两拨人~~ **已收窄** | 20 字段袋（台账原记 18）实际消费面极窄：`apply`(index.ts) 只读 4、`createProviderPublisher`(provider-publish.ts) 解构 7，其余是历史残留 | ✅ 已处理：拆成 `HostDeps`(4，apply 的 lazy-load 缝) + `ProviderPublisherDeps`(7，publisher 的 settings/llm/emit 袋)，删 10 个无消费者死字段（credential/onTrace/timeoutMs/headers/jwksEndpoint/encKeyId/baseUrl/cache/maxHops/requestTimeoutMs）；纯类型面、运行时零变化（字段本就全 optional、各有默认回落），typecheck-gate 双 config 0 错 |
| `shared/wire.ts` 104 行 raccoon 专属 state 声明 | 搬去 `raccoon-status.ts` 或在 shared 内分组 | 纯搬文件收益低、风险中等，留到重构轮 |
| token-store 十三包装 / 假依赖注入 | 拆分边界干净，收益被注释放大 | 同 P0 提案：**砍注释（48% 占比里大量「当初为什么没这么写」是 git/ADR 的活）比拆文件划算得多** |
| ~~catalog/throttle 半同构 writePayload~~ | 台账原记「`createVersionedJsonWriter` 只收了 4 份逐行同构；这两份半同构（返回 void / throttle 沉默不 degrade），强行纳入要改返回语义」 | ✅ 已处理（2026-10-19 核实）：`onRefuse` 做成**可选**钩子之后两份都已纳入——`catalog-store.ts:181` 传 `onRefuse`（拒绝要 degrade 出声），`throttle-store.ts:129` 不传（throttle 沉默是有意的）。台账这一条**在写下时就已经过期**：它描述的「返回语义冲突」正是 `onRefuse` 解掉的那一个 |
| `api-key-store.ts` 引用 `state-store` 原语 0 次 | 事实成立，但**不是欠账**：它存的不是插件状态文件，是 DSH 凭据服务里的一条 credential REFERENCE（`SENSENOVA_API_KEY`）——改走 state-store 反而会踩红线 1/2（私有 kind / 状态外溢） | ✅ 已收窄（2026-10-19）：真正的重复是**「凭据服务」解析那 4 行**（service-or-resolver + 缺省归一 `null` + `ephemeral` 判据），原本在 `token-store/state.ts:229`、`api-key-store.ts:44`、`raccoon-store.ts:121` 各抄一份，已收进 `src/host/credentials-service.ts`（`resolveCredentialsService` / `isEphemeral`），10 个调用点改走它。`state-store` 那条不是欠账，保留现状 |
| `qr.ts` 509 行手写 QR 编码器 | 清洁室实现，jsQR decoder 逐版本验证已进 devDependency | 换库会引入面板 bundle 的第三方依赖线；抛错可降级，非紧急 |

## 下一步建议

1. ~~拍板 `web.searchProviderId` 全局写（P0-1 的 B 选项或有意识接受）~~ ✅ 已按 B 选项落地（见上）。剩下的根子「凭什么由我改全局」不是本插件内能解的：需要宿主提供 plugin-owned 的选择面，留待上游
2. 若做注释瘦身：**只砍「考古叙述」**（git/ADR 已覆盖的部分），保留行为与红线注释
3. ~~`HostDeps` 收窄前先跑 `typecheck-gate` + 全量（types.ts 是合同面）~~ ✅ 已收窄（见上「已收窄」行）
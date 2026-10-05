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
| `web.searchProviderId` 全局写本身 | P0-1 只补了「归还路径」（dispose 竞态不再永久顶掉别的插件），但「由本插件改写 DSH 全局搜索路由」这一架构事实仍在 | 架构级，等拍板（P0 提案里已列）。选项 B（接管前检查占用、冲突则拒绝）只是防御性补丁；根子是「凭什么由我改全局」 |
| `types.ts` `HostDeps` 18 字段 any 袋 | 实际消费面极窄（index 只读 4 个、provider-publish 读 7 个），其余是历史残留 | 收窄是纯类型面改动、风险中，收益被 `any` 兼容面稀释；P0 提案对 token-store 的判断「砍注释比拆文件划算」同源 |
| `shared/wire.ts` 104 行 raccoon 专属 state 声明 | 搬去 `raccoon-status.ts` 或在 shared 内分组 | 纯搬文件收益低、风险中等，留到重构轮 |
| token-store 十三包装 / 假依赖注入 | 拆分边界干净，收益被注释放大 | 同 P0 提案：**砍注释（48% 占比里大量「当初为什么没这么写」是 git/ADR 的活）比拆文件划算得多** |
| catalog/throttle 半同构 writePayload | `createVersionedJsonWriter` 只收了 4 份逐行同构；这两份半同构（返回 void / throttle 沉默不 degrade） | 强行纳入要改返回语义，单独评估 |
| `api-key-store.ts` 绕过 state-store 原语（引用数=0） | 独立重构风险更高 | 单独评估 |
| `qr.ts` 509 行手写 QR 编码器 | 清洁室实现，jsQR decoder 逐版本验证已进 devDependency | 换库会引入面板 bundle 的第三方依赖线；抛错可降级，非紧急 |

## 下一步建议

1. 拍板 `web.searchProviderId` 全局写（P0-1 的 B 选项或有意识接受）
2. 若做注释瘦身：**只砍「考古叙述」**（git/ADR 已覆盖的部分），保留行为与红线注释
3. `HostDeps` 收窄前先跑 `typecheck-gate` + 全量（types.ts 是合同面）
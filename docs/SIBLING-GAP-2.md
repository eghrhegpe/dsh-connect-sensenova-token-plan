# 兄弟插件差集核对 · 第二轮（2026-10-20）

> 📦 **冻结档案（2026-10-20）**：本文是**第二轮差集核对**的记录——第一轮
> [SIBLING-GAP.md](./SIBLING-GAP.md) 留下三项没核，本轮逐条核完：哪几条在本仓不成立、
> 哪一条真缺、缺的那条落了什么、哪些明确不抄。它已退出持续维护面：文中提到的兄弟仓提交号
> 与实测现状都会过时，用时回各仓自证。**现行规则**看 [ADR.md](./ADR.md)（裁定）、
> [ARCHITECTURE.md](./ARCHITECTURE.md)（结构）、[PITFALLS.md](./PITFALLS.md)（坑）、
> [TESTING.md](./TESTING.md)（测试）；本文与它们冲突时**以现行文件为准**。

## 1. 起点与方法

第一轮的结论是「只做差集，不通读历史」：本仓与兄弟插件共享同一套 DSH 插件骨架（bundle 结构、
patch 装配、peer 语义、门禁名册、产物入库纪律），这些本仓早已同步到位；值得读的只有**各家
本族特有**的落地改动。第一轮留下三项没核：

- ④ 出图链的四处语义缺陷（兄弟 `dsh-connect-modelscope-token-plan` 提交 `222c72c`）；
- ⑤ 覆盖率分母（兄弟 `dsh-connect-qoder` 的 issue 11 / 提交 `0a560fc`）；
- ⑥ 激活路径的裸 node 覆盖（同上）。

本轮沿用同一方法：**先列差集候选 → 在本仓核有没有这个问题 → 只抄问题确实存在、且修法能对上
本仓结构的那部分**；核过但不成立的也留痕，否则下一轮会重新怀疑同一件事。

## 2. ④ 出图链：四条缺陷三条不成立，缺的是「超时上限」

兄弟 `222c72c` 的四条（modelscope 仓）：

1. `describeDrawFailure` 在 401/403 时不再替上游编造账号态（按 body 匹配账号态措辞，body 真
   写了才说「账号未完成邮箱验证/实名」，否则给中性枚举）；
2. 非 2xx 的轮询不再拿上一轮读数当终态证据；
3. 轮询请求带 `signal`，abort 不再被当抖动吞掉；
4. `waitMs` 让出 margin，硬护栏不越过 `DRAW_TIMEOUT_MAX_MS`。

**本仓逐条**：

- 第 1 条**不成立**：本仓出图的认证面就是面板保存的 `SENSENOVA_API_KEY`，`src/host/draw.ts`
  的 401/403 文案只说「Key 缺失、无效或无权访问该模型」，没有替上游断言账号态。
- 第 2、3、4 条**不适用**：本仓出图是**单次同步 POST**（`drawOnce`），没有轮询、没有作业表、
  没有重试/抖动层——这三条缺陷的前提在本仓不存在。
- 附带的「作业表在装配点创建与销毁」**不成立**：本仓没有作业表。

**但同一处有一个真缺口**：`drawTimeoutMs` **只有下限没有上限**。本仓出图是单次同步请求，这个
期限是 agent turn 唯一的护栏；配成 `999999999` 就能把一个 turn 挂住数月。兄弟仓有硬上限
`DRAW_TIMEOUT_MAX_MS`（30 分钟），本仓没有。

**落地**：

- `src/host/host-config.ts` 新增 `DRAW_TIMEOUT_MIN_MS` / `DRAW_TIMEOUT_MAX_MS` 与纯函数
  `resolveDrawTimeoutMs(raw)`——**一段区间由一个函数拥有**，配置层与工具层都走它，两侧不可能漂。
- `src/host/draw.ts` 的工具超时改为调同一个 resolver：工具拿到的是**原始 settings 对象**而不是
  解析后的配置，所以它必须自己再夹一次——期限是请求参数，不是偏好。
- 门禁：`test/config.test.mjs` 钉下限、上限，以及「工具读的是同一个 resolver」（用源码钉住，
  因为工具内部的有效期限从外部观测不到）；`test/docs.test.mjs` 检查 17 钉 `docs/SETUP.md`
  说明格里的两个边界与源码常量一致。
- 文档：`docs/SETUP.md` 的 `drawTimeoutMs` 行、`cordis.patch.yml` 的注释。

**核过但不成立（同族项）**：兄弟在卸载时清进程内状态（`resetDrawToolNote()` +
`drawJobs.dispose()`）。本仓 `src/host/draw-tool-state.ts` 的缺席 note 只在
`src/host/lifecycle.ts` 的 `registerDrawTool` 开头重置，卸载不重置——但装配路径上 `effects.add`
是**同步**调用，reset 在挂载后同步发生，窗口是微秒级，不构成泄漏。不改。

## 3. ⑤ 覆盖率分母：不抄

兄弟用 **Node 内置**的 `node --test --experimental-test-coverage`，并在 CI 强制覆盖率**地板**
（行/分支/函数各有阈值），前提是他们用 `node --test` 内置 runner。

本仓的 runner 是自写的 `test/run-all.mjs`（名册真源 `test/suites.mjs`）：内置覆盖率只认
`--test`，本仓套件文件也不是 node:test 文件。要么迁 runner（成本远大于收益），要么自己写
V8 覆盖率合并器、或引入 c8。**结论：不引入覆盖率工具。**

只抄它背后那条纪律：**最该测、却进不了分母的东西要显式登记**——本仓的对应物是门禁名册
`test/suites.mjs`（套件清单唯一真源）与 `test/env-skip.mjs` 的 loud skip 语义（缺 peer 的套件
单独列出、不算通过）。

## 4. ⑥ 激活路径裸 node 覆盖：不成立，本仓已有更强等价物

兄弟的阻塞是：`index.ts` 顶层 import 四个 `@deepseek-ai/*` peer，裸 node 直接 import 就死
`ERR_MODULE_NOT_FOUND`。他们的解法是新增 `test/activation.test.js`：用假 Cordis 上下文跑
`apply()`，断言路由全挂、无重复路径、dispose 全释放、零区域不上线、`GET /account` 与
`/status` 真应答，并把 `$DSH_HOME` / HOME 指向一次性沙箱（三源凭据皆空 ⇒ 不绑端口、不发上游
请求）。

**本仓不成立**：`src/host/index.ts` 顶层**零 peer import**；peer 只在
`src/host/llm-adapter-core.ts` 静态 import，而它只被两个 adapter 模块引用，那两个模块又只被
**动态** `import()` 加载 → 裸 node 可 import 本仓的 index.ts。且本仓已有更强的等价物：
`test/wiring.test.mjs`（真 cordis 容器）、`test/e2e.mjs`（真 Host）、`test/routes.test.mjs`
（假 ctx 跑 handler）。

**顺带纠正第一轮的一处错误记载**：第一轮写「`test/wiring.test.mjs` 本机 SKIP、CI 才真跑」——
**错的**。`test/peer-roots.mjs` 的 `loadPeer` 会从**全局 DSH runtime 树**解析 peer，本机真跑
通过。判断 peer 可用性要用 `loadPeer`，**不能用裸 `import('@deepseek-ai/…')` 去试**——插件目录
里没有这些包是正常的。

## 5. 本轮明确不抄

- **覆盖率工具链**（见 §3）：与本仓的自写 runner 形态不兼容，收益不抵成本。
- **兄弟的 `test/activation.test.js` 形态**（见 §4）：本仓顶层零 peer import，且已有真容器与
  真 Host 两层覆盖。
- **兄弟出图链的轮询/作业表/抖动层改造**（见 §2）：本仓出图是单次同步 POST，这些结构不存在。

## 6. 剩余

本轮核完第一轮留下的全部未核项，没有新增待办。兄弟仓后续若再出本族特有改动，按第一轮的方法
另立一次核对记录——**不要往本文追加新章**（本文已冻结）。

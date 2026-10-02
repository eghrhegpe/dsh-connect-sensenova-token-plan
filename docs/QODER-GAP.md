# QODER-GAP：本插件与 `dsh-connect-qoder` 的 client 侧差距对照

**用途**：把本插件（`dsh-connect-sensenova-token-plan`）与相邻插件
`dsh-connect-qoder` 在 client 侧的**准确差距**钉成一份可复核的档案。
两个方向都有借鉴价值：qoder 抄本插件的分层，本插件抄 qoder 的 JSX + 产物测试基建。
本文只写**现状**（谁在哪、可测性如何），不写"谁该改"的裁定；裁定见
[ADR.md](./ADR.md)。

**数据来源**：2026-10-03 逐文件、逐函数核实。qoder 在
`~/.dsh/plugins/dsh-connect-qoder`（本机 web 是 symlink，desktop 是安装副本，
见 [PITFALLS.md](./PITFALLS.md) §22 的三层装载）。qoder 是独立仓库、
**不在本仓库内**，故本文不链它的路径，只引用事实与行号。

---

## 1. 一句话差距

**两边都有分层、都有纯函数、都有 hook 容器——真正的差别是"可测边界画在哪儿"：**
本插件的分层线画在"能算的 vs 画出树"，把**卡片展示规则**留在 Node 可 import 的
纯模块里；qoder 的分层线画在"领域状态 vs UI"，把**卡片展示规则**漏在了 JSX 文件里，
于是 Node 测试碰不到，只能用「抓 bundle 文本 + 测试里抄镜像」两种蹩脚方式兜住。

---

## 2. 分维度对照（已核实）

| 维度 | 本插件（sensenova） | qoder |
|---|---|---|
| client 源码格式 | 全 `.ts`、**零 JSX**，React 元素用 `h()`（`src/client/runtime.ts`） | `.tsx` + **真 JSX**（`src/client/card.tsx`，`return (` 多处） |
| client 产物位置 | 根 `client.js`（IIFE） | `lib/client.js`（`exports["./client"]` 指向它） |
| client 构建 | tsdown 一条命令出 host + client | tsdown **只出 host**；client 由 `scripts/build-client.mjs` 单独出（含 `window.__ModuleLoader__.load` shell + REQUIRED-string 门禁 + 与已发布字节逐位比对） |
| **纯规则 Node 可 import** | 是（多个纯 `.ts` 模块，见 §4） | 部分（`controller.ts` 可；**卡片规则不可**，见 §3） |
| client 测试加载什么 | `test/client-surface.js:78` **直接 `import("../src/client/index.ts")`**，Node 原生剥类型 | **打产物，绝不 import 源码**：`test/helpers/render-card.js`（明写 "deliberately not an import of `src/client/card.tsx`"）用 jsdom + 真 react 渲染 `lib/client.js`；其余测试 `readFileSync('../lib/client.js')` 从产物文本抽函数 |
| JSX 能否自由使用 | 不能（Node 直载源码不转 JSX） | 能（Node 从不加载 client 源码） |
| 卡片规则兜底手段 | 不需要——规则可直接 import 断言 | `card-host-parity.test.js:47` 抓 bundle 文本 + `:50` 在测试里再抄一遍（"transcribed from `src/client/card.tsx` AFTER the fix"） |
| 测试重依赖 | 无 DOM 重依赖，极简 React stand-in | `jsdom` / `react` / `react-dom` 进 devDeps，真 DOM 渲染 |

---

## 3. qoder 侧事实（已核实）

**已有分层，且分界线画在"领域状态 vs UI"：**

- `controller.ts`（365 行）是**纯领域状态机**：只 `import` `settings-write.ts`，
  无 `react` / `fetch` / `document` / `window`，Node 可直接 import——这层**与
  本插件的 `snapshot.ts` 同级**，qoder 已经有了。
- `card.tsx`（1816 行）里已有 3 个 **hook-free 纯展示件**：
  `QuotaBlock` @402、`CheckinCard` @475、`RegionUsage` @522——和本插件的
  `cards.ts` 同类。
- fetch 已通过注入的 `PersistField`（`controller.ts:104`）+ `settings-write.ts`
  收口。

**但卡片专属的展示规则全写在 `card.tsx` 里，Node 碰不到：**

| 规则函数 | 位置 | 可测性 |
|---|---|---|
| `offPeakState` | `card.tsx:264` | Node 抓不到 |
| `windowLabelOf` | `card.tsx:318` | Node 抓不到 |
| `rateAt` | `card.tsx:338` | Node 抓不到 |
| `refreshNoticeKey` | `card.tsx:380` | Node 抓不到 |

这一类恰恰是**最容易被 UI 改动波及**的规则（促销、折扣、窗口标签），因此最需要
防漂移。qoder 只能靠 `card-host-parity.test.js:47`（抓 bundle 文本）与 `:50`
（在测试里再抄一份）兜住——**镜像注定漂移**（qoder 自己的
`test/client-bundle.test.js` 头注也承认这一点）。

**真正带 hooks / fetch 的只有 3 个容器**（这是"单文件重"的实质）：

| 组件 | 起始行 | hooks | fetch |
|---|---|---|---|
| `QoderUsagePanel` | 603 | 12 | 2 |
| `QoderAccountPanel` | 778 | 17 | 3 |
| `QoderPluginCard` | 1220 | 31 | 1 |

---

## 4. 本插件侧事实（已核实）

**分层线画在"能算的 vs 画出树"，展示规则全部在纯 `.ts` 模块里，Node 直测：**

| 纯模块（Node 可 import） | 承载的规则 | 谁来测 |
|---|---|---|
| `src/client/snapshot.ts` | `interpretSnapshot` / `viewOf` / `decidePanelView` / `errorOfStatus` / 表 `GUIDANCE_BY_CODE` 等——**面板"显示什么"的决策** | `panel.test.mjs`（经 `panel-decision.js` → `client-surface.js`） |
| `src/client/models.ts` | `modelIsOn` / `allowListFor` / `toggleModelIn` / `setAllModelsIn` / `bulkModelsIn` / `raccoonModelIsOn` / `toggleRaccoonModelIn`——**模型是否启用、允许清单** | 同一 `panel` 测试面 |
| `src/client/format.ts` | `clock` / `clockLong` / `when` / `count` / `format` / `tokenSize` / `statedCadenceMs`——**时间与数字呈现** | 同一 `panel` 测试面 |
| `src/client/cards.ts` | `PoolCard` / `PoolExhaustionNotice` / `QuotaCard` / `TrendTable` / `SectionCard`——**hook-free 展示件**（与 qoder 的 `QuotaBlock` 同类） | `render.test.mjs`（经 `panel-render.js` 遍历 `h()` 树） |

**唯一带 hooks 的是生命周期层**：`panel-page.ts` / `raccoon-tab.ts` /
`account-form.ts` / `api-key-form.ts` / `model-picker.ts` /
`provider-controls.ts` / `use-snapshot-polling.ts`——与 qoder 那 3 个容器同类。

**本插件没有的**：JSX（用 `h()` 换取 Node 直载源码的可测性，理由见 §2 与
`src/client/runtime.ts` 头注）、jsdom 真渲染断言。

---

## 5. 差距的本质：一条分界线

| | 本插件（sensenova） | qoder |
|---|---|---|
| 分层线位置 | "能算的" vs "画出树" | "领域状态" vs "UI（含规则）" |
| 领域/数据规则（Node 直测） | `snapshot.ts` | `controller.ts` ✅ 同级 |
| **卡片展示规则**（最易漂移） | **也在纯层**（`models.ts` / `format.ts`） | **漏在 `card.tsx`**（`offPeakState` 等 4 个） |
| 兜底手段 | 不需要 | 抓 bundle 文本 + 测试里抄镜像 |

**结论**：这不是"qoder 没分层"的问题——它分层了，只是把**最容易漂移的展示规则**
留在了 Node 抓不到的地方；本插件的分层恰好把同一类规则全部暴露给 Node。

---

## 6. 双向可借鉴

### 6.1 qoder ← 本插件：抽出 `card-model.ts`，删掉镜像抄写

真正该抄的**不是**把 1816 行拆成 6 个文件（那是形式对齐，churn 大、风险中等），
而是把 `offPeakState` / `rateAt` / `windowLabelOf` / `refreshNoticeKey` 抽成一个
**Node 可 import 的纯 `.ts` 模块**（如 `card-model.ts`），让测试从"抓文本 +
抄镜像"变成"引真模块"。**同时必须删除 `card-host-parity.test.js:50` 那份镜像抄写**
——否则只是把双重真源换个地方放着，照样漂。

### 6.2 本插件 ← qoder：JSX + 产物测试（前提是解耦）

本插件要上 JSX，前提是把 `test/client-surface.js` 那条"整棵组件树和规则一起
直载"的耦合拆开：

- **纯规则继续直 import 源码 `.ts`**（保留现有可测性优势，不进 JSX）；
- **组件层走产物 + jsdom**（照 `test/helpers/render-card.js` 平移），只覆盖渲染；
- 这样 JSX 组件留在 `.tsx`，Node 从不加载它，**JSX 可自由使用**。

**代价提醒**：走通 jsdom 路线，就得一并接受它的短板——从 bundle 文本按花括号
抽函数的脆断言（qoder 自己的 `client-bundle.test.js` 承认 "indentation is not
stable across a rebuild"）与产物 freshness 门禁。本插件的 `client-surface.js`
恰恰是为淘汰这套才存在的（见其头注）。所以这不是"白捡 JSX"，是拿测试轻量换
格式可读性。

---

## 7. 相关文档

- [ARCHITECTURE.md](./ARCHITECTURE.md) §2 — 本插件 Host/Client 分流与分层
- [ARCHITECTURE.md](./ARCHITECTURE.md) §5.3 — 同类插件生态事实（对照形态的参考）
- [IMPROVEMENTS.md](./IMPROVEMENTS.md) §4 — 状态/契约/UX/client 四块维护债
- [DSH-PLUGIN.md](./DSH-PLUGIN.md) — DSH 插件机制总览
- [ADR.md](./ADR.md) — 决策账本（裁定沿革在此登记）
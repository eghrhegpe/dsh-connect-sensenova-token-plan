# 入口迁移方案（P2，待拍板）：面板从 Plugins 页卡迁到设置页 + 侧栏

> **状态：待拍板，未实现。** 本文档只做方案、座席判据与注册骨架，**不动 `src/`**。
> 依据：issue #3 / #8 连续报「找不到入口」；B 批兄弟插件（qoder / trae / workbuddy）已把
> 入口从 Plugins 页卡迁到「设置页 + 侧栏」形态，本文档对齐该形态。

---

## 1. 现状（与 `src/` 实际注册一致）

| 面 | 座席 | 落点 |
|---|---|---|
| 面板（三 tab：积分额度 / 接入 API / 小浣熊） | `plugins.bundle.config` | `src/client/apply.ts` 注入，Plugins 页插件卡内 |
| 用量胶囊 | `conversation.input.right` | 输入框右侧 |
| 小浣熊登录 / 直连 | 小浣熊 tab | 插件卡内 |

## 2. 问题：为什么 Plugins 页卡「找不到」

Plugins 页卡是**市场详情页**（`plugins.bundle.config` 槽），它的本职是「介绍 + 安装」；
把整套配置也放进去，用户要滚过营销文案才摸到 checkbox。trae 迁走时写的原话：

> It used to register into the Plugins page's `plugins.bundle.config` /
> `plugins.row.config` slots, which put the whole configuration inside the
> plugin's market detail page, below its README. That page's job is to describe
> and install a package; a page that both advertises and configures makes the
> user scroll past marketing to reach a checkbox.

这就是 #3 / #8 同一句话「找不到入口」的根源。

## 3. 座席判据：侧栏「更多」菜单**不是**合适座席

用户提过的 `sidebar.panellist.actions`（侧栏「更多」菜单）**不放**，理由三条：

1. 里面现有的两条是 **DSH 级市场动作**（浏览更多插件 / 创建你的插件）——把「某个 provider
   的账户/池界面」塞进同一组，语义错位。
2. 可发现性并不更好：它藏在「更多」展开里，比 Plugins 页卡还深一层，只是把「找不到」从
   一处分诊到另一处。
3. 它是**菜单**不是**面板宿主**：往里加一条 `menuitem` 点开一个面板，绕一圈还是回到
   「侧栏面板」模式——那不如直接坐侧栏面板的座席。

**侧栏界面的正确座席是 sidebar panel**（见 §4.2），不是这个菜单。

## 4. 方案（三档，可增量落地）

### 4.1 主入口：`settings.section` 一页（默认可见）

- id = 本插件包名 `dsh-connect-sensenova-token-plan`，`order: 30`（排在官方段 account -10 /
  general 0 / models 10 / plugins 15 / agent-presets 20 之后，与其他第三方页并列，不撞内建）。
- 导航字形用 `settings.section.icon`，`renderSlot('settings.section.icon', …, { only: id })`——
  id 不一致的图标永远不出现、壳静默回退默认字形，故必须与页 id 同一串。
- **注册即探针**：`ctx.slots.inject('settings.section', cb)` 本身就是探针——宿主声明了就跑、
  没声明就无操作（**不抛错、不排队**）。**不要**在外面包 `typeof` 探针：那会把「宿主不支持」
  变成「永不注册、静默」，是兄弟插件栽过两次的失败模式。让宿主回答。

\`\`\`ts
ctx.slots.inject('settings.section' as never, () => {
  const disposers: Array<() => void> = [];
  disposers.push((ctx.slots as unknown as { register(o: { name: string; id: string; order?: number }): () => void })
    .register({ name: 'settings.section', id: 'dsh-connect-sensenova-token-plan', order: 30 }));
  disposers.push((ctx.slots as unknown as { register(o: { name: string; id: string }): () => void })
    .register({ name: 'settings.section.icon', id: 'dsh-connect-sensenova-token-plan' }));
  return () => disposers.forEach((d) => d());
});
\`\`\`

（骨架照 trae `registerSettingsPage` / workbuddy `registerSettingsSection` 的成文实现，非新发明。）

### 4.2 侧栏面板：`setSidebarPanelWanted`（opt-in，默认关）

常驻用量胶囊/账号速览走 **sidebar panel**（`ui-sidebar` 的 `SidebarRoot` `usePanels(...)`
面板列表行），不是 `sidebar.panellist.actions` 菜单项。默认关（`Config.sidebarPanel`），
与 qoder/trae/workbuddy 一致——侧栏行是用户自己开的，不是默认就占一行。

### 4.3 兼容兜底：`plugins.bundle.config` 卡瘦身成「打开设置页」跳转行

保留但不承载整版配置：一行「打开设置页 →」跳 `settings.section`。向后兼容旧 Host
（没有 `settings.section` 时卡兜底），也符合 B 批「卡让位给设置页」的做法。

## 5. 一致性与降级（实现时必须守的）

- **自述面与实际对齐**：`docs.test.mjs` 检查 10 钉「声明的 UI 位置 = `src/client/*.ts` 实际
  注册的槽位」。**实现时**同步改 README / SETUP / TROUBLESHOOTING 的「面板位置」描述；
  本文档在 `docs/issues/` 下不受检查 10 扫描（受检面 = ROOT 顶层 + docs/ 顶层 .md），但仍
  按「当前位置 = `plugins.bundle.config`」写，不把建议当现状。
- **旧 Host 优雅降级**：`settings.section` 未声明 → 无操作、卡兜底，不抛错。
- **改 `src/` 必先 `npm run build`**（render 套件 eval 的是产物根 `client.js`，绿了也可能是
  假的，见 PITFALLS §41）；改契约/自述面跑全量 `npm test`，不按域裁剪。

## 6. 验收（实现时）

- `npm run build` + 全量 `npm test`（含 `docs.test.mjs` 检查 10）。
- 真机双态：旧 Host 仍出插件卡（跳转行）；新 Host 出设置页 + 可选侧栏行。
- `node test/raccoon.test.mjs`（peer-free，小浣熊域不动，回归为零）。

## 7. 参考实现（兄弟插件，只读证据，不是本仓代码）

| 插件 | 文件 | 形态 |
|---|---|---|
| trae | `src/client/index.tsx`（`registerSettingsPage`） | `settings.section` 页 + id/order 30 + 注册即探针 |
| workbuddy | `src/client/index.tsx`（`registerSettingsSection`） | `settings.section` 页 + `surface: 'settings'` |
| qoder | `src/client/index.tsx` | 保留 `plugins.bundle.config` + `QODER_SIDEBAR_PANEL_ID` 侧栏（opt-in） |
| workbuddy | `src/client/panel-switch.ts` | 侧栏面板座席 = `ui-sidebar` `usePanels(...)` |

---

*落位：`docs/issues/`（与 P0-OPTIMIZATION-PROPOSAL / P1-STRUCTURAL-BACKLOG 同目录，都是
「方案/台账」不是现状声明）。改行为前先看 `docs/ARCHITECTURE.md` §5（三条不变量 + §5.5 双上游
裁定）：本方案只动**面板入口的座席**，不碰 provider 装配、凭据、store 与双上游边界。*
/**
 * composer 用量胶囊的 peer 契约门禁（ROADMAP §6.3「落地前确认②」）。
 *
 * ## 断什么
 *
 * §6.3 已裁定对话框用量显示走 opencode-go 形态：在 `conversation.input.right`
 * 座席注册用量胶囊，用 `useProjection("modelSelection")` 判当前会话所选模型的
 * provider 归属。字节级验证只证明了本机一个 DSH 版本（0.2.0-rc.1），而本插件的
 * peer 范围是 `>=0.1.5 <0.3`——上游某版本一旦移除该槽位、或把 projection 改成
 * 非严格注入，胶囊就静默落不了地。本节钉的就是这条契约在本机**可解析的每个
 * DSH client 副本**上都不漂移。
 *
 * 四项断言（锚函数名与结构，不碰行号——行号随 runtime 重生成漂）：
 *
 *   A. 槽位声明：`dsh-client-ui-conversation` 的 `slots.d.ts` 仍把
 *      `'conversation.input.right'` 声明为 `kind: 'list'` + `scope: 'session'`。
 *      scope 不是 session 就不是 per-session 归属，`useProjection` 不再严格必需。
 *   B. 槽位仍渲染：`client.js` 仍调用 `renderSlot("conversation.input.right", …)`。
 *      声明了但不渲染 = 座席是死的。
 *   C. projection 源族：`dsh-client-ui-session` 的 session scope adapter 仍在
 *      `keyedHooks` 里声明 `projection`——它是 `useProjection` 唯一来源。
 *   D. `useProjection` 强制物化：`dsh-client-ui-renderer` 的
 *      `materializeStandardBinding` 仍把 keyedHooks 经 `standardHookPropName(name)`
 *      转成 `use<Name>` prop，且 session（非 `session-maybe`）作用域 `optional=false`
 *      （缺源抛 `SlotAssemblyError`）——不存在「可能没注入」的形态。
 *   E. 渲染器仍接入：`dsh-client-ui-conversation` 的 `client.js` 仍
 *      `require("@deepseek-ai/dsh-client-ui-slots")`（且不自己定义 `renderSlot`）。
 *      这条**不**断言该包装在 `node_modules` 里：0.2.1-rc.2 起没有任何包声明依赖
 *      它，shell 的模块注册表供给它，所以它不在安装树里是正常形态。按包存在性
 *      断言（旧版的做法）只会把上游的打包方式当成契约，见 PITFALLS §58。
 *
 * ## 怎么跑
 *
 * 纯静态读文件，不装 peer、不拉 Host、不碰网络。候选 scope 根按「本机 DSH 副本」
 * 枚举：profile 的 node_modules、`dsh-asar-unpacked` / `app.asar.unpacked` 的运行时树
 * （即 peer-roots.mjs 的候选根）、`$DSH_HOME` 指向的 checkout、`~/dsh-plugins`
 * 下兄弟插件的 node_modules，以及**全局 CLI 树**（`cliRuntimeModules()`）——最后
 * 一项是 CI runner 上唯一存在的那个，漏掉它等于让这条门禁在 CI 上只剩 SKIP。
 * 每个 scope 是一个**版本样本**，全部要过 A–E。
 *
 * 找不到任何副本 = 醒目 SKIP 退出 0（与 `store.test.mjs` / `peer-contract.test.mjs`
 * 的 peer 缺席范式一致）：一台没装 Host 的机器上属正常。有副本却装不齐（缺
 * session / renderer / conversation 任一）按失败处理，不是 SKIP——那是环境不完整，
 * 同 peer-roots 的处理。
 *
 * @module test/composer-slot-gate
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envSkip } from "./env-skip.mjs";
import { cliRuntimeModules } from "./peer-roots.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? "";
const DSH_HOME = process.env.DSH_HOME;

/**
 * The three packages whose BYTES this gate reads. All three must be present.
 *
 * `dsh-client-ui-slots` is deliberately NOT here. It was the fourth, as an
 * EXISTENCE assertion — but nothing in A–D ever read its bytes, so it was an
 * install-shape proxy, and it went stale when upstream 0.2.1-rc.2 shrank
 * `dsh-experimental-client-ui-agent-team`'s `peerDependencies` to `cordis`
 * alone: npm had been auto-installing slots as a peer, and no package declares
 * it anymore. The package still PUBLISHES (0.2.1-rc.2 is on npm, not
 * deprecated) and the conversation bundle still `require`s it; the shell's
 * module registry supplies it, so it needs to be in no `node_modules` at all.
 * See {@link SLOT_RUNTIME_PKG} and the plugin's PITFALLS §58.
 */
const CONTRACT_PKGS = [
  "dsh-client-ui-conversation",
  "dsh-client-ui-session",
  "dsh-client-ui-renderer",
];

/** The slot runtime the conversation bundle pulls from the shell's registry. */
const SLOT_RUNTIME_PKG = "dsh-client-ui-slots";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail ?? "") });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

/**
 * Candidate `node_modules` roots for a DSH client copy, most specific first.
 *
 * Same shapes as `test/peer-roots.mjs`'s `candidateRoots` (a dev checkout's own
 * `node_modules`, the unpacked desktop runtime, the CLI tree), plus the two
 * places a copy actually shows up on a machine that runs plugins: the profile's
 * `node_modules` and a sibling plugin's. Every path is `existsSync`-checked, so a
 * machine that simply never had one yields `[]` and the gate SKIPs honestly.
 * @returns {string[]} existing `node_modules` roots.
 */
function candidateRoots() {
  // `cliRuntimeModules()` is what makes this gate run on a CI runner at all:
  // those machines have the dsh CLI (`npm install -g @deepseek-ai/dsh`) and
  // nothing else, so every path enumerated literally below is absent. Without
  // it the roster read a zero-scope SKIP, and `envSkip` promotes that to a
  // FAILURE under CI (`CI=true` ⇒ STRICT) — the suite went red for having
  // nothing to read, which is the opposite of its intent.
  const cliRuntime = cliRuntimeModules();
  const roots = [
    ...(DSH_HOME === undefined || DSH_HOME === "" ? [] : [join(DSH_HOME, "dsh-asar-unpacked", "dsh", "node_modules")]),
    join(HERE, "..", "node_modules"),
    join(HOME, ".dsh", "dsh-asar-unpacked", "dsh", "node_modules"),
    join(HOME, ".dsh", "profiles", "node_modules"),
    join(HOME, "dsh-plugins"),
    ...(LOCAL_APP_DATA === "" ? [] : [join(LOCAL_APP_DATA, "Programs", "DeepSeek Harness", "resources", "app.asar.unpacked", "dsh", "node_modules")]),
    ...(cliRuntime === undefined ? [] : [cliRuntime]),
  ];
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    if (typeof root !== "string" || root === "" || seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out.filter((root) => existsSync(root));
}

/**
 * Every DSH client scope on this machine, as `{ root, version }`.
 *
 * A scope is a `<root>/@deepseek-ai` directory that ships `dsh-client-ui-conversation`.
 * `root` is that scope directory, so all four contract packages resolve under it
 * with a consistent version. Sibling plugins' `node_modules` are searched one level
 * deep so each sibling plugin under `~/dsh-plugins` shows up too.
 * @returns {Array<{scope: string, version: string}>} distinct scopes.
 */
function collectScopes() {
  const scopes = [];
  const seen = new Set();
  const push = (scopeDir) => {
    if (seen.has(scopeDir)) return;
    const pkg = join(scopeDir, "dsh-client-ui-conversation", "package.json");
    if (!existsSync(pkg)) return;
    let version = "?";
    try {
      version = JSON.parse(readFileSync(pkg, "utf8")).version ?? "?";
    } catch {
      version = "?";
    }
    seen.add(scopeDir);
    scopes.push({ scope: scopeDir, version });
  };
  for (const root of candidateRoots()) {
    push(join(root, "@deepseek-ai"));
    // A sibling plugin's root has the scope one level deeper.
    if (existsSync(join(root, "node_modules"))) {
      for (const name of readdir(join(root, "node_modules"))) {
        push(join(root, "node_modules", name, "node_modules", "@deepseek-ai"));
      }
    }
  }
  return scopes;
}

function readdir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Assert the contract items for one DSH client scope.
 * @param {string} scope - the `<root>/@deepseek-ai` directory.
 * @param {string} label - a label for the failure messages.
 */
function assertScope(scope, label) {
  const present = new Set(
    CONTRACT_PKGS.filter((name) => existsSync(join(scope, name, "package.json"))),
  );
  for (const name of CONTRACT_PKGS) {
    check(
      `${label}: ${name} 包存在（三个读到字节的包缺一即环境不完整）`,
      present.has(name),
      present.has(name) ? `${join(scope, name)} 在位` : `缺失 ${join(scope, name)}`
    );
  }
  // Short-circuiting here is safe precisely because the three above are the
  // packages A–D READ: a missing one makes every later check throw, not pass.
  if (present.size !== CONTRACT_PKGS.length) return;

  // E. 槽位渲染器仍由 shell 递进来。
  // 单独立一条而不是并进前面三个：slots 不在安装树里是 0.2.1 起的正常形态，
  // 唯一能证明「渲染器仍可达」的字节是那处模块说明符。旧版这里按包存在性断言，
  // 正是把「上游的打包方式」当成了「我们的契约」。
  try {
    const convTxt = readFileSync(join(scope, "dsh-client-ui-conversation", "lib", "client.js"), "utf8");
    const specifier = `"@deepseek-ai/${SLOT_RUNTIME_PKG}"`;
    const requires = convTxt.includes(`require(${specifier})`);
    const definesOwn = /\bfunction\s+renderSlot\b|\brenderSlot\s*=/.test(convTxt);
    check(
      `${label}: conversation bundle 仍 require(${specifier})`,
      requires && !definesOwn,
      requires
        ? (definesOwn
          ? "既 require 又自造 renderSlot——打包方式又变了，重读这条门禁"
          : "渲染器仍经 shell 模块注册表递进 bundle")
        : `找不到 require(${specifier})：槽位渲染器不再接入，胶囊会静默消失`
    );
  } catch (error) {
    fail(`${label}: 读取 conversation client.js（slots 说明符）`, error);
  }

  // A. 槽位声明
  const slotsDts = join(scope, "dsh-client-ui-conversation", "lib", "types", "client", "contract", "slots.d.ts");
  try {
    const txt = readFileSync(slotsDts, "utf8");
    const idx = txt.indexOf("'conversation.input.right': {");
    const slice = idx === -1 ? "" : txt.slice(idx, idx + 200);
    check(
      `${label}: slots.d.ts 声明 conversation.input.right`,
      idx !== -1 && /kind:\s*'list'\s*;/.test(slice) && /scope:\s*'session'\s*;/.test(slice),
      `idx=${idx}；需 kind:'list' + scope:'session'（scope 不是 session 则 useProjection 不再严格必需）`
    );
  } catch (error) {
    fail(`${label}: 读取 slots.d.ts`, error);
  }

  // B. 槽位仍渲染
  const convJs = join(scope, "dsh-client-ui-conversation", "lib", "client.js");
  try {
    const txt = readFileSync(convJs, "utf8");
    check(
      `${label}: client.js 仍 renderSlot conversation.input.right`,
      txt.includes('renderSlot("conversation.input.right"'),
      "声明了但不渲染 = 座席是死的"
    );
  } catch (error) {
    fail(`${label}: 读取 conversation client.js`, error);
  }

  // C. projection 源族
  const sessJs = join(scope, "dsh-client-ui-session", "lib", "client.js");
  try {
    const txt = readFileSync(sessJs, "utf8");
    check(
      `${label}: session adapter 声明 keyedHooks projection`,
      txt.includes('keyedHooks: ["projection"]') &&
        txt.includes("binding.session.projections.faceOf(key)"),
      "useProjection 的唯一来源是 session scope adapter 的 projection 源族"
    );
  } catch (error) {
    fail(`${label}: 读取 session client.js`, error);
  }

  // D. useProjection 强制物化
  const rendJs = join(scope, "dsh-client-ui-renderer", "lib", "client.js");
  try {
    const txt = readFileSync(rendJs, "utf8");
    const fnIdx = txt.indexOf("function materializeStandardBinding");
    const body = fnIdx === -1 ? "" : txt.slice(fnIdx, fnIdx + 4000);
    check(
      `${label}: materializeStandardBinding 仍可定位`,
      fnIdx !== -1,
      "找不到该函数 = renderer 改名/移除"
    );
    check(
      `${label}: keyedHooks 经 standardHookPropName 物化为 use<Name> prop`,
      body.includes("standardHookPropName") && body.includes("keyedObservableHook(source, defaultKey)"),
      "projection → useProjection 的物化路径（打包产物里是 (0, mod.standardHookPropName)(name) 形式）"
    );
    check(
      `${label}: session（非 session-maybe）作用域 optional=false（严格必需）`,
      txt.includes("strict keyed standard hook") && txt.includes('scope === "session-maybe"'),
      "缺源会抛 SlotAssemblyError，不存在「可能没注入」的形态"
    );
  } catch (error) {
    fail(`${label}: 读取 renderer client.js`, error);
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
const scopes = collectScopes();
if (scopes.length === 0) {
  envSkip("composer-slot-gate", "本机没有可解析的 DSH client 副本（dsh-client-ui-conversation 未安装）。",
    [
      "composer 用量胶囊的 peer 契约无法验证（同 store.test.mjs 的 peer 缺席范式）",
      "CI 需装好运行时才会真跑——那里出现则说明 workflow 的运行时安装步骤没生效",
    ]);
}

for (const { scope, version } of scopes) {
  assertScope(scope, `DSH client v${version}`);
}

console.log(JSON.stringify({ copies: scopes.map((s) => `${s.version} @ ${s.scope}`) }, null, 2));
console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  console.error("composer 用量胶囊的 peer 契约已漂移：按 ROADMAP §6.3 换座席或放弃该功能。");
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed (${scopes.length} DSH client copy/copies)`);
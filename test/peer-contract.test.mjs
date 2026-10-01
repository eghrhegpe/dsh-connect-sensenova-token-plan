/**
 * Peer 契约护栏 —— 把 "peer 改拼接格式就静默漏纠" 变成可见红（docs/IMPROVEMENTS.md §3.3①）。
 *
 * `llm-error-fix.js` 依赖 peer 的 message 拼接格式：非 2xx 时 pi-ai 把整段 JSON body
 * 拼进 `errorMessage`（`<status>: <body>`，见 `@earendil-works/pi-ai/dist/utils/
 * error-body.js:15-30,63-76,111-118`：OpenAI SDK 的 `error.error`（parsed JSON 对象）
 * 经 `safeJsonStringify` 转回 JSON 字符串作 body）。本套件在**真实 peer 可达时**
 * （`findPeerRoot()` 本地解析，见 test/peer-roots.mjs 头注）钉死这条端到端行为契约；
 * peer 缺席则 SKIP——与 `npm test` 离线门禁兼容（一台没装 Host 的机器上属正常；CI 由
 * workflow 装好运行时，故那边出现 SKIP 本身就是信号）。有真实 Host 的机器（本机）会真跑。
 *
 * 误判机制（2026-09-29 实测修正原稿 §3.1③）：
 *   - peer 的 `isQuotaExceededError`（`@deepseek-ai/dsh-llm/lib/types/error.js:76-82`）
 *     命中**message 文本里的硬额度措辞**（`quota exceeded` 空格分隔、`out of
 *     credits/budget` 等）；
 *   - **类型名 `quota_exceeded_error` 本身不触发**——末尾 `\b` 词边界不穿透 `_`
 *     （`_` 是 word 字符）：实测 `isQuotaExceededError('quota_exceeded_error') === false`。
 *
 * 三段断言（失败信息都指向下一步该做什么）：
 *   A. 端到端纠正（应恒真）：对 peer 拼好的 message（**额度措辞 + 速率信号** + quota
 *      类型名，即 peer 会误判 QUOTA 的体），`shouldReclassifyQuotaToRate` 为 true、
 *      `reclassifyFinish` 把 QUOTA 纠正回 RATE_LIMIT 且保留原 message；真配额耗尽与
 *      peer 已判 RATE_LIMIT 的体原样放行（引用相等）。
 *   B. 拼接格式漂移护栏：`extractStructuredType(peerMessage)` 必须仍能从 peer 拼好的
 *      message 里回捞 `quota_exceeded_error`。peer 改 error-body.js（不再嵌 body、换
 *      type 字段名、换前缀）时这里红——届时临界体（额度措辞 + 速率信号）回退纯文本
 *      启发会被 `hardQuota` 卡住而静默漏纠（§3.2 场景），需同步更新 `llm-error-fix.js`
 *      的抓取/回退。
 *   C. peer 行为钉：① misjudged 体仍被判 QUOTA（`isQuotaExceededError` true，即
 *      "quota 先于 rate"的死分支前提仍在；上游修正则/调序后这里红 → 按 §3.3②/③ 收紧
 *      peer 范围、llm-error-fix 退化为 no-op 兼容层并更新本契约）；② 类型名本身
 *      **不**误命中（钉住正确机制，防未来正则改动把 `_` 也当边界而误伤）；③ rate 类型
 *      名不误命中。
 *
 * peer 引用按其实际导出选取：`@deepseek-ai/dsh-llm/lib/types/error.js` 导出
 * `isQuotaExceededError` 与 `QUOTA_EXCEEDED_CODE`（= 'QUOTA'）；组合消息优先用 pi-ai
 * 的 `formatProviderError`（存在时），缺 pi-ai 则按文档格式字面拼 `"<status>: <body>"`。
 * 全部按路径 import（绕过 exports 映射），裸 specifier 由 peer 文件自身位置解析到
 * runtime 根。
 */
import { findPeerRoot, installNetworkGuard } from "./peer-roots.mjs";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractStructuredType,
  shouldReclassifyQuotaToRate,
  reclassifyFinish,
  CODE
} from "../src/host/llm-error-fix.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail ?? "") });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

// 任何逃过 stub 的网络请求立即红：本套件必须是纯离线的。
installNetworkGuard();

const root = findPeerRoot();
if (root === undefined) {
  console.log("SKIP: 未找到 Host peer 根——契约无法验证，跳过且不红（本地干净检出属正常；CI 里出现则说明 workflow 的运行时安装步骤没生效，见 .github/workflows/ci.yml）。");
  console.log("SKIP: 需 $DSH_HOME / 已解包的桌面运行时 / npm 全局 CLI 的运行时树才会真跑（见 test/peer-roots.mjs 的候选根）。");
  process.exit(0);
}

// --- 装载真实 peer（root 在却装不上 = 环境不完整，按失败处理，不是 SKIP）-----------
let dshLlm;
try {
  dshLlm = await import(pathToFileURL(join(root, "@deepseek-ai", "dsh-llm", "lib", "types", "error.js")).href);
} catch (error) {
  fail("load @deepseek-ai/dsh-llm/lib/types/error.js from peer root", error);
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
}

// pi-ai 的 formatProviderError：真实组合消息（peer 缺席时退化为字面拼）。
let compose = (status, body) => `${status}: ${body}`;
const piErrorBody = join(root, "@earendil-works", "pi-ai", "dist", "utils", "error-body.js");
if (existsSync(piErrorBody)) {
  try {
    const { formatProviderError } = await import(pathToFileURL(piErrorBody).href);
    compose = (status, body) =>
      formatProviderError({ status, body, message: "", messageCarriesBody: false });
  } catch {
    // 保持字面拼：格式按 error-body.js 文档注释（`"<status>: <body>"`）一致。
  }
}

const { isQuotaExceededError, QUOTA_EXCEEDED_CODE } = dshLlm;

// --- 代表性商汤 429 体 -------------------------------------------------------
// 误判体：message 文本含硬额度措辞（触发 isQuotaExceededError → peer 判 QUOTA）+
// 同时含速率信号（结构化 type 分支的 rateCapWords 可判为限频）→ 插件应纠正 RATE_LIMIT。
const MISJUDGED_BODIES = [
  JSON.stringify({ message: "quota exceeded, too many requests per minute, retry later", type: "quota_exceeded_error", code: "8" }),
  // rpm quota exhausted：文本启发会被 hardQuota（"quota exhausted"）卡住，只有结构化
  // type 分支（rateCapWords 命中 "rpm"）能纠正——B 段护栏的精确触发面。
  JSON.stringify({ message: "rpm quota exhausted, retry after 1s", type: "quota_exceeded_error", code: "8" })
];
// 真配额耗尽：额度措辞 + 无任何速率信号 → 必须保留 QUOTA（peer 不重试是对的）。
const HARD_BODY = JSON.stringify({ message: "monthly quota exceeded, no credits left", type: "quota_exceeded_error", code: "8" });
// peer 已正确判限频的体（类型即 rate_limit）：插件只防御、不纠正。
const RATE_TYPE_BODY = JSON.stringify({ message: "slow down", type: "rate_limit_error" });
// 类型名不误命中（机制钉）与无额度措辞的限频体（peer 会正确判 RATE_LIMIT）：
const TYPE_NAME_ONLY = '"type":"quota_exceeded_error"';
const NO_QUOTA_WORDING_BODY = JSON.stringify({ message: "rpm exhausted", type: "quota_exceeded_error", code: "8" });

const misjudgedMessages = MISJUDGED_BODIES.map((body) => compose(429, body));
const hardMessage = compose(429, HARD_BODY);
const rateTypeMessage = compose(429, RATE_TYPE_BODY);
const noQuotaWordingMessage = compose(429, NO_QUOTA_WORDING_BODY);

// --- C. peer 行为钉 ----------------------------------------------------------
check(
  "peer 仍把『额度措辞 + 429』误判为 QUOTA（死分支前提仍在）",
  MISJUDGED_BODIES.every((body) => isQuotaExceededError(body)),
  "上游若修了 dsh-llm（正则收紧或 429 短路率优先），这里红：按 §3.3②/③ 收紧 peer 范围、llm-error-fix 退化为 no-op 兼容层并更新本契约"
);
check(
  "机制钉：quota_exceeded_error 类型名本身不误命中（\\b 不穿透 _）",
  !isQuotaExceededError(TYPE_NAME_ONLY) && !isQuotaExceededError('quota_exceeded_error'),
  "若上游正则改动（把 _ 当边界）后这里红：类型名开始误伤，需复审 llm-error-fix 与 §3.1③ 的表述"
);
check(
  "peer 正控制：rate_limit_error 类型名不误命中 isQuotaExceededError",
  !isQuotaExceededError(RATE_TYPE_BODY),
  "该类型名不应触发配额正则"
);
check(
  "peer 正控制：无额度措辞的限频体（rpm exhausted）不误判 QUOTA",
  !isQuotaExceededError(NO_QUOTA_WORDING_BODY),
  "该体 peer 正确走到 RATE_LIMIT 分支"
);

// --- B. 拼接格式漂移护栏 ------------------------------------------------------
// peer 若不再把 body 拼进 message（换字段、换前缀、不嵌 JSON），这里红；届时临界体
// （额度措辞 + 速率信号）回退纯文本启发会被 hardQuota 卡住 → 静默漏纠（§3.2 场景）。
check(
  "extractStructuredType 仍能从 peer 拼好的 message 回捞 quota_exceeded_error",
  misjudgedMessages.every((m) => extractStructuredType(m) === "quota_exceeded_error") &&
    extractStructuredType(hardMessage) === "quota_exceeded_error",
  JSON.stringify(misjudgedMessages.map((m) => extractStructuredType(m)))
);
check(
  "extractStructuredType 区分 rate_limit_error 型体",
  extractStructuredType(rateTypeMessage) === "rate_limit_error",
  String(extractStructuredType(rateTypeMessage))
);

// --- A. 端到端纠正 -----------------------------------------------------------
for (const message of misjudgedMessages) {
  const failure = { code: QUOTA_EXCEEDED_CODE, message };
  check(
    `shouldReclassifyQuotaToRate true（额度措辞 + 速率信号 + quota 类型名）: ${message.slice(0, 60)}`,
    shouldReclassifyQuotaToRate(failure) === true
  );
  const out = reclassifyFinish({
    type: "finish",
    reason: { kind: "error", failure }
  });
  check(
    "reclassifyFinish 把 peer 误判的 QUOTA 纠正回 RATE_LIMIT",
    out !== null && out.reason?.failure?.code === CODE.RATE_LIMIT,
    JSON.stringify(out?.reason?.failure)
  );
  check(
    "纠正时保留原始 message（供排查）",
    out?.reason?.failure?.message === message
  );
}

// 真配额耗尽：不纠正（保留 QUOTA，peer 不重试、面板按 exhaustedModelIds 下线是对的）。
{
  const hard = { type: "finish", reason: { kind: "error", failure: { code: QUOTA_EXCEEDED_CODE, message: hardMessage } } };
  check("真配额耗尽原样放行（引用相等，QUOTA 不重试）", reclassifyFinish(hard) === hard);
  check("真配额耗尽不应被判为可纠正限频", shouldReclassifyQuotaToRate(hard.reason.failure) === false);
}
// peer 已判 RATE_LIMIT：幂等放行（无额度措辞的限频体与 rate 类型体）。
{
  const rate = { type: "finish", reason: { kind: "error", failure: { code: CODE.RATE_LIMIT, message: rateTypeMessage } } };
  check("peer 已判 RATE_LIMIT 的体幂等放行", reclassifyFinish(rate) === rate);
  const rate2 = { type: "finish", reason: { kind: "error", failure: { code: CODE.RATE_LIMIT, message: noQuotaWordingMessage } } };
  check("无额度措辞的限频体幂等放行", reclassifyFinish(rate2) === rate2);
}

// --- D. peer 分类结构漂移护栏（整层前提的「源」）--------------------------------
// 本纠正层存在的唯一理由：peer `classifyPiAiError` 里 `isQuotaExceededError`
// 排在 `rate.?limit` 分支**之前**（额度措辞抢判 QUOTA，限频够不到）。C 段用
// 「额度+速率」组合 message 间接钉了这个顺序的**效果**；这里再从 peer 源码
// **文本**直接钉**结构**——锚函数名 + 判定的相对顺序，不碰行号（行号会随
// runtime 重生成漂）。上游一旦调序或收紧 `isQuotaExceededError`，QUOTA 抢判
// 消失、llm-error-fix 退化为 no-op：这里先于线上红。
{
  const piSrcPath = join(root, "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js");
  if (existsSync(piSrcPath)) {
    let piSrc = "";
    try {
      piSrc = readFileSync(piSrcPath, "utf8");
    } catch (error) {
      fail("读取 peer classifyPiAiError 源码", error);
    }
    const fnStart = piSrc.indexOf("function classifyPiAiError");
    const fnEnd = fnStart === -1 ? -1 : piSrc.indexOf("PI_AI_ERROR", fnStart); // 兜底分支是函数最后一行
    const body = fnEnd === -1 ? "" : piSrc.slice(fnStart, fnEnd);
    check(
      "peer classifyPiAiError 仍可定位（函数名未改名/移除）",
      fnStart !== -1 && fnEnd !== -1,
      fnStart === -1 ? "找不到 `function classifyPiAiError`" : "找不到 `PI_AI_ERROR` 兜底分支"
    );
    const iQuota = body.indexOf("isQuotaExceededError(");
    const iRate = body.indexOf("rate.?limit");
    check(
      "peer 结构：isQuotaExceededError 调用先于 rate.?limit 分支（QUOTA 抢判前提仍在）",
      iQuota !== -1 && iRate !== -1 && iQuota < iRate,
      `isQuotaExceededError@${iQuota}, rate.?limit@${iRate}` +
        "（若 -1 或顺序翻转：QUOTA 不再抢判 429，llm-error-fix 退化为 no-op 兼容层，" +
        "按 §3.3②/③ 收紧 peer 范围并更新本契约与本层注释）"
    );
  } else {
    console.log("SKIP: 未找到 peer `dsh-llm-pi-ai/lib/index.js`——结构护栏跳过（不红）。");
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
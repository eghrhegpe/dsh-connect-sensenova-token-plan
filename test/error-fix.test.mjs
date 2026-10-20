/**
 * 429 误判纠正层（llm-error-fix.js）的离线检查。
 *
 * 不 import 任何 Host peer，纯函数 + 稳定协议字符串即可覆盖：
 *   - `looksLikeRateLimit`：哪些 429 体被认作限频、哪些硬额度被放行；
 *   - `reclassifyFinish`：把误判 QUOTA 的 finish 改回 RATE_LIMIT、且幂等；
 *   - `reclassifyStream`：对整条流逐 chunk 纠正，非 finish / 真 QUOTA 原样过；
 *   - `reclassifyReason`：429 重分类的判据路径（8 条稳定短串），布尔只是它的投影。
 *
 * 这些与 peer 缺席与否无关——干净 checkout 也能跑（符合 npm test 离线门禁）。
 */
import { looksLikeRateLimit, extractStructuredType, shouldReclassifyQuotaToRate, reclassifyFinish, reclassifyStream, reclassifyReason, REASON, CODE } from "../src/host/llm-error-fix.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail ?? "") });
}
function fail(name, error) {
  results.push({ name, pass: false, detail: String(error?.message ?? error) });
}

// --- 1. looksLikeRateLimit: 误判核心用例 ----------------------------------
{
  // 商汤限频体，带的 "rate limit budget" 措辞不应被 isQuotaExceededError 吃下。
  const rateCases = [
    "HTTP 429: requests rate limit exceeded, please retry after 1s",
    "429 Too Many Requests — out of rate budget, retry later",
    "请求过于频繁，请稍后再试 (429)",
    "rate.limit: request frequency limited, throttle",
    "Error 429: too many requests per minute"
  ];
  for (const msg of rateCases) {
    check(`looksLikeRateLimit true: ${msg.slice(0, 40)}`, looksLikeRateLimit(msg) === true);
  }
}
{
  // 真配额耗尽：必须判定为 false（不纠正，保留 QUOTA 不重试的保守行为）。
  const quotaCases = [
    "quota exceeded: your monthly credits are exhausted",
    "insufficient balance: out of credits",
    "额度已用尽，请升级套餐",
    "balance depleted — no remaining quota",
    "QUOTA: usage limit reached for this billing period"
  ];
  for (const msg of quotaCases) {
    check(`looksLikeRateLimit false (hard quota): ${msg.slice(0, 40)}`, looksLikeRateLimit(msg) === false);
  }
}
{
  // 非 429、无限频信号：不纠正。
  check("looksLikeRateLimit false on 5xx", looksLikeRateLimit("HTTP 500 internal error") === false);
  check("looksLikeRateLimit false on empty", looksLikeRateLimit("") === false);
  check("looksLikeRateLimit false on non-string", looksLikeRateLimit(undefined) === false);
}

// --- 2. reclassifyFinish: 只动误判 QUOTA，幂等于其它 -----------------------
{
  // 误判 QUOTA 的限频体 -> RATE_LIMIT，且 message 保留。
  const chunk = {
    type: "finish",
    reason: { kind: "error", failure: { code: CODE.QUOTA, message: "429 out of rate budget" } }
  };
  const out = reclassifyFinish(chunk);
  check("reclassifyFinish flips misjudged QUOTA -> RATE_LIMIT",
    out !== chunk && out.reason.failure.code === CODE.RATE_LIMIT, JSON.stringify(out?.reason?.failure));
  check("reclassifyFinish keeps original message",
    out.reason.failure.message === "429 out of rate budget");
  check("reclassifyFinish returns a NEW object (no mutation)",
    out !== chunk && chunk.reason.failure.code === CODE.QUOTA);

  // 真 QUOTA（硬额度措辞）原样放行。
  const hard = {
    type: "finish",
    reason: { kind: "error", failure: { code: CODE.QUOTA, message: "额度已用尽" } }
  };
  check("reclassifyFinish leaves hard-quota QUOTA alone",
    reclassifyFinish(hard) === hard);

  // 已是 RATE_LIMIT 原样放行。
  const rate = {
    type: "finish",
    reason: { kind: "error", failure: { code: CODE.RATE_LIMIT, message: "429" } }
  };
  check("reclassifyFinish idempotent on RATE_LIMIT", reclassifyFinish(rate) === rate);

  // 非 finish chunk 原样放行。
  const text = { type: "text-delta", text: "hi" };
  check("reclassifyFinish passes through non-finish chunks", reclassifyFinish(text) === text);

  // aborted / non-error finish 原样放行。
  const aborted = { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED" } } };
  check("reclassifyFinish leaves aborted finish alone", reclassifyFinish(aborted) === aborted);

  // 非对象 / null 安全。
  check("reclassifyFinish safe on null", reclassifyFinish(null) === null);
}

// --- 3. reclassifyStream: 整条流逐 chunk 纠正 ------------------------------
{
  async function run() {
    async function* source() {
      yield { type: "text-delta", text: "a" };
      yield { type: "finish", reason: { kind: "error", failure: { code: CODE.QUOTA, message: "429 rate limit" } } };
      yield { type: "finish", reason: { kind: "error", failure: { code: CODE.QUOTA, message: "额度已用尽" } } };
    }
    const seen = [];
    for await (const c of reclassifyStream(source())) seen.push(c);
    return seen;
  }
  try {
    const seen = await run();
    check("reclassifyStream keeps non-finish chunk", seen[0] && seen[0].type === "text-delta");
    check("reclassifyStream corrects the rate-limit QUOTA",
      seen[1].reason.failure.code === CODE.RATE_LIMIT, JSON.stringify(seen[1]?.reason?.failure));
    check("reclassifyStream preserves the hard-quota QUOTA",
      seen[2].reason.failure.code === CODE.QUOTA, JSON.stringify(seen[2]?.reason?.failure));
  } catch (error) {
    fail("reclassifyStream", error);
  }
}

// --- 4. 真实商汤线格式：quota_exceeded_error 误命名速率上限 -----------------
// 线上实际打出的两条体（见会话日志）：code:8 是"rpm exhausted"——请求速率上限，
// 却被商汤复用 quota_exceeded_error 这个名字；code:429003 是 rate_limit_error，
// peer 已判 RATE_LIMIT。v1 纯文本启发漏判了 code:8，本层靠结构化 type 纠正。
{
  const bodies = [
    // 请求速率上限，错命名为 quota_exceeded_error：必须纠正为 RATE_LIMIT。
    { code: CODE.QUOTA, message: '429: {"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}' },
    // 仅内层 message 带 rpm（无完整 JSON）：纯文本启发也要接住。
    { code: CODE.QUOTA, message: "rpm exhausted" },
    // tpm/rpm 速率上限的另一种措辞。
    { code: CODE.QUOTA, message: '{"message":"inference exceeds tpm/rpm limit","type":"quota_exceeded_error","code":"8"}' }
  ];
  for (const failure of bodies) {
    check(`shouldReclassifyQuotaToRate true for ${failure.message.slice(0, 46)}`,
      shouldReclassifyQuotaToRate(failure) === true);
  }

  // 已是 rate_limit_error 类型（peer 多数已判 RATE_LIMIT，这里防御性确认）。
  const alreadyRate = { code: CODE.QUOTA, message: '429: {"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error","code":"429003"}' };
  check("extractStructuredType pulls rate_limit_error", extractStructuredType(alreadyRate.message) === "rate_limit_error");
  check("shouldReclassifyQuotaToRate true for rate_limit_error type", shouldReclassifyQuotaToRate(alreadyRate) === true);

  // 真配额耗尽（token/credit/balance），即使 type 是 quota_exceeded_error 也保留 QUOTA。
  const realQuota = [
    { code: CODE.QUOTA, message: '{"message":"token quota exceeded","type":"quota_exceeded_error","code":"8"}' },
    { code: CODE.QUOTA, message: '{"message":"月额度已用尽","type":"quota_exceeded_error","code":"8"}' }
  ];
  for (const failure of realQuota) {
    check(`shouldReclassifyQuotaToRate false (true quota): ${failure.message.slice(0, 40)}`,
      shouldReclassifyQuotaToRate(failure) === false);
  }

  // 端到端：整条流里 code:8/rpm 的 finish 被纠正为 RATE_LIMIT。
  async function* src() {
    yield { type: "finish", reason: { kind: "error", failure: { code: CODE.QUOTA, message: '429: {"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}' } } };
  }
  const seen = [];
  for await (const c of reclassifyStream(src())) seen.push(c);
  check("stream corrects code:8 rpm-exhausted to RATE_LIMIT",
    seen[0]?.reason?.failure?.code === CODE.RATE_LIMIT, JSON.stringify(seen[0]?.reason?.failure));
}

// --- 5. reclassifyReason: 429 重分类的可观测理由 ----------------------------
// 把 shouldReclassifyQuotaToRate 的判定路径翻译成稳定短串。钉死三件事：
//   ① 8 条路径各自对应哪类报文（一条路径塌成另一条，判定逻辑就退化成了旧版）；
//   ② 布尔是路径的投影（两条路径不得各判各的——改前它们确实是两处独立判断）；
//   ③ 路径串是稳定契约（改名等于改日志里的 grep 键，要改就一起改文档与测试）。
{
  const q = (message) => ({ code: CODE.QUOTA, message });
  const cases = [
    // [failure, 期望 reason, 期望 shouldReclassifyQuotaToRate]
    [null, REASON.NOT_QUOTA_CODE, false],
    [{ code: CODE.RATE_LIMIT, message: "throttled" }, REASON.NOT_QUOTA_CODE, false],
    [q('{"type":"rate_limit_exceeded"}'), REASON.STRUCTURED_RATE_LIMIT_TYPE, true],
    [q('{"type":"quota_exceeded_error","detail":"tpm cap"}'), REASON.STRUCTURED_QUOTA_RATE_CAP, true],
    [q('{"type":"quota_exceeded_error","detail":"all used up"}'), REASON.STRUCTURED_QUOTA_NO_CAP, false],
    [q('{"type":"server_overloaded"}'), REASON.STRUCTURED_OTHER_TYPE, false],
    [q("HTTP 429 too many requests"), REASON.TEXT_RATE_SIGNAL, true],
    [q("requests per minute exceeded, quota exceeded"), REASON.TEXT_HARD_QUOTA, false],
    [q("service temporarily unavailable"), REASON.TEXT_NO_RATE_SIGNAL, false]
  ];
  const seenPaths = new Set();
  for (const [failure, wantReason, wantBool] of cases) {
    const got = reclassifyReason(failure);
    seenPaths.add(got);
    check(`reclassifyReason = ${wantReason}`, got === wantReason, `got=${got}`);
    check(`shouldReclassifyQuotaToRate = ${wantBool} (${wantReason})`,
      shouldReclassifyQuotaToRate(failure) === wantBool);
  }

  // 闭合集合：8 条路径一条不多、一条不少。多一条 = 有分支没被钉住；少一条 =
  // 两条分支共用一个串，路径信息已经丢了。
  check("reclassifyReason 路径集合恰好 8 条", seenPaths.size === 8, `seen=${seenPaths.size}`);
  check("REASON 导出恰好 8 个路径串", Object.keys(REASON).length === 8, `n=${Object.keys(REASON).length}`);

  // 路径串是稳定契约：字面量被改名等于改了日志里的 grep 键。
  const expectedLiterals = [
    "not_quota_code",
    "structured:rate_limit_type",
    "structured:quota_rate_cap",
    "structured:quota_no_cap",
    "structured:other_type",
    "text:rate_signal",
    "text:hard_quota",
    "text:no_rate_signal"
  ];
  const literals = Object.values(REASON);
  check("REASON 的 8 个字面量与本文档一致",
    expectedLiterals.every((lit) => literals.includes(lit)) &&
      literals.every((value) => expectedLiterals.includes(value)),
    JSON.stringify(literals));

  // 8 条路径里恰好 3 条落到「应纠正」：改前这条分割是散在两个函数里的，
  // 现在布尔完全由路径集合派生，比例也被钉住了。
  const truePaths = new Set(
    cases.filter(([failure]) => shouldReclassifyQuotaToRate(failure)).map(([, reason]) => reason)
  );
  check("应纠正路径恰好 3 条（其余 5 条保留 QUOTA）", truePaths.size === 3, `true=${[...truePaths].join(",")}`);
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);

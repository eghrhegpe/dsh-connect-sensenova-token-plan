/**
 * 429 误判纠正层 —— host 侧对 peer 分类器的安全覆盖。
 *
 * 根因（对照 peer 源码 `@deepseek-ai/dsh-llm-pi-ai` 的 `classifyPiAiError`
 * 与 `@deepseek-ai/dsh-llm` 的 `isQuotaExceededError`，二者均为**非行号锚**
 * 的稳定符号；其判定顺序与措辞命中面由 `test/peer-contract.test.mjs` 在
 * 真 peer 可达时钉死）：
 *   `classifyPiAiError` **先**跑 `isQuotaExceededError`（命中面极宽：`out of
 *   ... budget`、`balance/credits exhausted` 等），**后**才跑纯限频分支
 *   （`\b429\b|rate.?limit`）。凡是商汤 429 体里带上一两个 “budget/credits/
 *   limit” 字眼，就被前一行抢判成 `QUOTA`；于是 `llm-retry.ts` 的
 *   `retryableCodes()`（刻意排除 QUOTA）对这类 429 不重试，面板又把模型按
 *   `exhaustedModelIds` 静默下线，对用户呈现“额度耗尽”。
 *
 * 本模块在 host 侧把“看似限频却被误判为 QUOTA 的 429”纠正回 `RATE_LIMIT`，
 * 让退避重试真正生效；真配额耗尽（明确余额/积分耗尽的硬额度措辞）保留
 * `QUOTA`（那是共享 Token Plan 池的硬耗尽，重试只会延长冷却窗口，见
 * ROADMAP §1 纪律）。
 *
 * 设计约束（对应 AGENTS.md 红线与并行纪律）：
 *   - 不动 vendor peer：peer 不在此插件 git 内，也不可被改。
 *   - 零 peer 依赖：纯函数 + 稳定协议字符串；peer 缺席（干净 checkout）时
 *     模块仍加载、测试仍跑，不破坏 `npm test` 离线门禁。
 *   - 只重写 `finish` chunk 的 `failure.code`，保留原始 `message` 以便排查，
 *     不触碰任何正常数据流，幂等（已是 RATE_LIMIT / 非 QUOTA 原样放行）。
 *
 * 阅读顺序：本文件自上而下是「判据词表 → 纯判据 → 判据路径 → 布尔派生 →
 * 流出口改写」。对外契约在底部（`reclassifyStream` / `reclassifyFinish`），想找它
 * 依赖了哪些判据，就从底部逆着依赖链往上读；想知道「为什么这么判」，看
 * `reclassifyReason` 返回的路径串（{@link REASON}）——布尔只是它的投影。
 *
 * @module dsh-connect-sensenova-token-plan/llm-error-fix
 */

/**
 * 与 peer 协议对齐的失败类（稳定字符串，不 import peer 也成立）。
 * `QUOTA` 来自 `@deepseek-ai/dsh-llm` 的 `QUOTA_EXCEEDED_CODE`，`RATE_LIMIT`
 * 来自 peer `classifyPiAiError` 的返回字面量。
 */
export const CODE = Object.freeze({
  /** 共享 Token Plan 池耗尽（peer 不重试，本层默认也不纠正）。 */
  QUOTA: "QUOTA",
  /**
   * 账户级配额耗尽。peer 的 `classifyPiAiError` 目前不产生此类（它只返回
   * `QUOTA_EXCEEDED_CODE`），列在此处纯为协议对齐与防御；本层不纠正它。
   */
  ACCOUNT_QUOTA: "ACCOUNT_QUOTA",
  /** 瞬时限频（peer retryPolicy 默认重试，本层把误判体拉回这里）。 */
  RATE_LIMIT: "RATE_LIMIT"
});

// ─────────────────────────────────────────────────────────────────────────
// 判据词表（集中在此，两个纯判据共用；改动前先看它被谁引用）
//
// 注意：下面「限频信号」有两套，且**故意不同**——不要合并：
//   · RATE_SIGNAL   用于纯文本启发（无结构化 type 时的兜底），措辞面更宽，
//                   含 “request frequency” 这类散文式描述。
//   · RATE_CAP_WORD 用于结构化 type 分支（type 是 quota 但怀疑被错命名），
//                   只认 rpm/tpm/per-minute 这类「速率上限」硬信号。
// 合并会让其一的钉测漂移（见 test/error-fix.test.mjs 逐条用例）。
// ─────────────────────────────────────────────────────────────────────────

/** 纯文本层面的限频信号（v1 启发用）。 */
const RATE_SIGNAL = [
  /\b429\b/,
  /rate[_\s-]?limit/i,
  /too many requests?/i,
  /requests?\s+(?:per|rate|freq)/i,
  /\b(?:rpm|tpm)\b/,
  /throttl/i,
  /请求过于频繁|限流|频率/
];

/** 硬额度措辞：命中即相信是配额耗尽，不纠正（避免把真耗尽也拉去重试）。 */
const HARD_QUOTA_WORDING = [
  /\b(?:balance|credits?)\s+(?:exhausted|depleted)\b/i,
  /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i,
  /额度\s*(?:已)?\s*(?:用尽|耗尽|不足)/,
  /quota\s*(?:exceeded|exhausted|reached)/i
];

/** 结构化 type 分支认的「速率上限」信号：rpm/tpm/每分钟/限流/频率。 */
const RATE_CAP_WORDING =
  /\brpm\b|\btpm\b|rate[_\s-]?limit|per[\s_-]?(?:min|minute|sec|second)|too many|限流|频率|请求过于频繁/i;

/** 从错误文本里回捞商汤结构化 `type` 字段（如 `"type":"quota_exceeded_error"`）。 */
const STRUCTURED_TYPE = /"type"\s*:\s*"([^"]+)"/i;

/**
 * 一个 429 体是否“更可能是限频而非真配额耗尽”——纯文本启发（v1）。
 *
 * 判据：消息里出现显式限频信号（{@link RATE_SIGNAL} 任一），且**没有**命中
 * 硬额度措辞（{@link HARD_QUOTA_WORDING}）。
 *
 * 关键区分：“out of **rate** budget” / “rate limit budget” 是限频体，不在硬
 * 额度措辞里，所以仍判为限频——这正是误判的核心。
 * @param {string} message - 平台错误文本（可能含状态码与 JSON）。
 * @returns {boolean} true 表示应纠正为 RATE_LIMIT。
 */
export function looksLikeRateLimit(message: string): boolean {
  if (typeof message !== "string" || message.length === 0) return false;
  if (!hasRateSignal(message)) return false;
  return !hasHardQuotaWording(message);
}

/**
 * 文本里是否出现限频信号（{@link RATE_SIGNAL} 任一）。
 *
 * 与 {@link hasHardQuotaWording} 一起构成「限频 vs 真耗尽」这一对判据的共同
 * 底座：布尔判据（{@link looksLikeRateLimit}）与路径判据（{@link
 * reclassifyReason}）读的是同一份词表、同一次小写化，**不可能各判各的**。
 * @param {string} message - 平台错误文本。
 * @returns {boolean} true 表示命中限频信号。
 */
function hasRateSignal(message: string): boolean {
  return RATE_SIGNAL.some((re) => re.test(message.toLowerCase()));
}

/**
 * 文本里是否命中硬额度措辞（{@link HARD_QUOTA_WORDING} 任一）——真耗尽信号。
 * @param {string} message - 平台错误文本。
 * @returns {boolean} true 表示命中硬额度措辞。
 */
function hasHardQuotaWording(message: string): boolean {
  return HARD_QUOTA_WORDING.some((re) => re.test(message.toLowerCase()));
}

/**
 * 从错误文本里抽出商汤结构化 `type` 字段。
 *
 * peer 把整条错误 JSON 拼进 `failure.message`，所以这里能从文本回捞结构信
 * 号，而不依赖 peer 是否单独透传了 `type`。抓不到返回 null。
 * @param {string} message
 * @returns {string|null}
 */
export function extractStructuredType(message: string): string | null {
  if (typeof message !== "string" || message.length === 0) return null;
  const match = STRUCTURED_TYPE.exec(message);
  // `match[1]` reads as `string | undefined` under `noUncheckedIndexedAccess`,
  // but group 1 always participates in this pattern, so it is never absent when
  // the regex matched. The `?? null` states that against the declared return
  // type rather than widening it (docs/IMPROVEMENTS.md §8).
  return match ? (match[1] ?? null) : null;
}

/**
 * 429 重分类的判据路径——{@link reclassifyReason} 返回的稳定短串（非自由文本）。
 *
 * 为什么要它：改之前 {@link shouldReclassifyQuotaToRate} 只吐一个布尔，于是
 * 「这条 429 为什么判成限频 / 为什么没判」在日志与现场都查不到——同一份 peer
 * 报文换个措辞就换个结论，而排查的人只能看到结果。改成「先给路径、再由路径
 * 派生布尔」之后，判定路径可 grep、可钉测，且布尔与路径**不可能分叉**：布尔
 * 只由 {@link RECLASSIFY_TRUE_REASONS} 这一个集合派生。
 */
export const REASON = Object.freeze({
  /** 失败为空或 code≠QUOTA，纠正层不适用。 */
  NOT_QUOTA_CODE: "not_quota_code",
  /** 结构化 type 含 rate_limit：本就是限频（防御性纠正）。 */
  STRUCTURED_RATE_LIMIT_TYPE: "structured:rate_limit_type",
  /** 结构化 type 含 quota 且命中速率上限字样：被错命名的速率上限，纠正。 */
  STRUCTURED_QUOTA_RATE_CAP: "structured:quota_rate_cap",
  /** 结构化 type 含 quota 但无任何速率信号：真耗尽，保留 QUOTA。 */
  STRUCTURED_QUOTA_NO_CAP: "structured:quota_no_cap",
  /** 结构化 type 是其它非 quota 值：保守不纠正。 */
  STRUCTURED_OTHER_TYPE: "structured:other_type",
  /** 无结构化 type，纯文本命中限频信号且无硬额度字样：纠正。 */
  TEXT_RATE_SIGNAL: "text:rate_signal",
  /** 无结构化 type，命中硬额度字样：保留 QUOTA。 */
  TEXT_HARD_QUOTA: "text:hard_quota",
  /** 无结构化 type，也无限频信号：保留 QUOTA。 */
  TEXT_NO_RATE_SIGNAL: "text:no_rate_signal"
});

/**
 * 一个被 peer 判为 QUOTA 的失败，按哪条判据路径处理——429 重分类的**可观测
 * 理由**。
 *
 * 纯函数，复用同一批词表（模块私有的 {@link RATE_SIGNAL} / {@link
 * RATE_CAP_WORDING}、{@link HARD_QUOTA_WORDING}、结构化 type），不引入第二份
 * 词表；返回 {@link REASON} 里的稳定短串，供日志/面板/测试引用「为什么这么
 * 判」。
 *
 * 这是修正 v1（纯文本启发）漏判的核心：`{"message":"rpm exhausted",
 * "type":"quota_exceeded_error","code":"8"}` 这种体——商汤把**请求速率上限**
 * 复用 `quota_exceeded_error` 这个名字，纯文本里没有 “rate limit” 字样，v1 的
 * `looksLikeRateLimit` 既没命中限频信号也没命中硬额度，于是留在 QUOTA、不重试、
 * 直接失败。本函数改读结构化 `type`，逐层收窄，每条返回串对应一条路径：
 *
 *   1. {@link REASON.NOT_QUOTA_CODE}             失败为空或 code≠QUOTA，不适用。
 *   2. {@link REASON.STRUCTURED_RATE_LIMIT_TYPE} type 含 rate_limit，本就是限频（防御）。
 *   3. {@link REASON.STRUCTURED_QUOTA_RATE_CAP}  type 含 quota 但带 {@link RATE_CAP_WORDING}
 *      （rpm/tpm/每分钟/限流…）→ 是“被错命名为 quota 的速率上限”，纠正为 RATE_LIMIT。
 *   4. {@link REASON.STRUCTURED_QUOTA_NO_CAP}    type 含 quota 且无任何速率信号
 *      （token/credit/balance 真耗尽）→ 保留 QUOTA。
 *   5. {@link REASON.STRUCTURED_OTHER_TYPE}      type 是其它非 quota 值 → 保守不纠正。
 *   6. {@link REASON.TEXT_RATE_SIGNAL}           无结构化 type，纯文本命中限频信号
 *      且无硬额度字样 → 纠正。
 *   7. {@link REASON.TEXT_HARD_QUOTA}            无结构化 type，命中硬额度字样 → 保留 QUOTA。
 *   8. {@link REASON.TEXT_NO_RATE_SIGNAL}        无结构化 type，也无限频信号 → 保留 QUOTA。
 *
 * 不纠正真配额耗尽：那是共享 Token Plan 池的硬耗尽，重试只会延长冷却窗口
 * （ROADMAP §1 纪律），所以宁可快失败。
 * @param {{code?: string, message?: string}} failure
 * @returns {string} 标记处理路径的稳定短串。
 */
export function reclassifyReason(failure: { code?: unknown; message?: unknown }): string {
  if (!failure || failure.code !== CODE.QUOTA) return REASON.NOT_QUOTA_CODE;
  const message = typeof failure.message === "string" ? failure.message : "";
  const type = extractStructuredType(message);

  if (type !== null) {
    const t = type.toLowerCase();
    if (/rate[_\s-]?limit/.test(t)) return REASON.STRUCTURED_RATE_LIMIT_TYPE; // 分支 1（防御）
    if (/quota/.test(t)) {
      // 分支 2 vs 3：quota_exceeded_error 但带速率上限字样 → 错命名。
      return RATE_CAP_WORDING.test(message)
        ? REASON.STRUCTURED_QUOTA_RATE_CAP
        : REASON.STRUCTURED_QUOTA_NO_CAP;
    }
    return REASON.STRUCTURED_OTHER_TYPE; // 分支 4
  }

  // 分支 5：无结构化 type，退回纯文本启发——但**理由仍然可见**。
  if (!hasRateSignal(message)) return REASON.TEXT_NO_RATE_SIGNAL;
  return hasHardQuotaWording(message) ? REASON.TEXT_HARD_QUOTA : REASON.TEXT_RATE_SIGNAL;
}

/** 判为「应纠正为 RATE_LIMIT」的路径集合——布尔判定的唯一真源。 */
const RECLASSIFY_TRUE_REASONS: ReadonlySet<string> = new Set([
  REASON.STRUCTURED_RATE_LIMIT_TYPE,
  REASON.STRUCTURED_QUOTA_RATE_CAP,
  REASON.TEXT_RATE_SIGNAL
]);

/**
 * 一个被 peer 判为 QUOTA 的失败，是否其实是限频、应纠正为 RATE_LIMIT。
 *
 * 布尔判定单一真源：读 {@link reclassifyReason} 的路径串是否落在「应纠正」集合
 * 里，分支逻辑不再写第二遍（改前两处各判一遍，是漂移的温床）；「为什么这么
 * 判」见 {@link reclassifyReason} 的返回串。
 * @param {{code?: string, message?: string}} failure
 * @returns {boolean} true 表示应纠正为 RATE_LIMIT。
 */
export function shouldReclassifyQuotaToRate(failure: { code?: unknown; message?: unknown }): boolean {
  return RECLASSIFY_TRUE_REASONS.has(reclassifyReason(failure));
}

/** The stream chunk shape the reclassification layer reads off a finish. */
interface ErrorFinishChunk {
  type?: unknown;
  reason?: {
    kind?: unknown;
    failure?: { code?: unknown; message?: unknown };
  };
}

/**
 * 把单个流 chunk 里的失败码在误判时纠正。
 *
 * 非 finish、非 error 终止、非 QUOTA，或已判为限频的，一律原样返回（新对象
 * 仅在确有纠正时创建，保持调用方对引用相等的预期）。
 * @param {object} chunk - harness 流协议 chunk。
 * @returns {object} 原 chunk 或 code 被纠正后的新 chunk。
 */
export function reclassifyFinish(chunk: unknown): unknown {
  if (!isErrorFinish(chunk)) return chunk;
  const errorChunk = chunk as ErrorFinishChunk;
  const reason = errorChunk.reason;
  const failure = reason?.failure;
  if (failure === undefined || !shouldReclassifyQuotaToRate(failure)) return chunk;
  // 纠正为 RATE_LIMIT：保留 message，仅改 code 以驱动 peer 的退避重试。
  return {
    ...errorChunk,
    reason: { ...reason, failure: { ...failure, code: CODE.RATE_LIMIT } }
  };
}

/** 是否为「带 failure 的 error 型 finish chunk」——纠正层唯一关心的形状。 */
function isErrorFinish(chunk: unknown): boolean {
  if (chunk === null || typeof chunk !== "object") return false;
  const candidate = chunk as ErrorFinishChunk;
  return (
    candidate.type === "finish" &&
    candidate.reason !== null && typeof candidate.reason === "object" &&
    candidate.reason.kind === "error" && candidate.reason.failure != null
  );
}

/**
 * 包裹一个 adapter 的 async iterator 流：对每个 finish chunk 做重判。
 * @param {AsyncIterableIterator<object>} source - 内层 adapter 的流。
 * @returns {AsyncGenerator<object>} 纠正后的流。
 */
export async function* reclassifyStream(source: AsyncIterableIterator<unknown>): AsyncGenerator<unknown> {
  for await (const chunk of source) {
    yield reclassifyFinish(chunk);
  }
}

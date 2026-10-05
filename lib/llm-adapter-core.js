import { a as name } from "./host-config.js";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";

//#region src/host/llm-retry.ts
/**
* The directly-registered SenseNova provider's 429 retry policy — the peer-FREE
* half of the 429 self-healing work.
*
* The *decision* (which failure classes this shared-pool provider retries, and
* how gently) is pure, so it lives here — importable on a clean checkout where
* the `@deepseek-ai/dsh-llm` peer is not resolvable — and is handed to the peer's
* `resolveRetryPolicy` from `llm-adapter.ts`. `test/retry.test.mjs` pins its
* shape without importing that peer.
*
* The peer classifies a SenseNova 429 into two codes (`isQuotaExceededError` →
* `rate.?limit` inside `classifyPiAiError`, pinned against the real source by
* `test/peer-contract.test.mjs`):
*
*   - `QUOTA` / `ACCOUNT_QUOTA` — the Token Plan pool is depleted. Retrying
*     cannot refill it, and the pool is SHARED across every model on this key,
*     so hammering it only extends the cool-down (the same lesson `st-rotator`
*     bakes into its AIMD limiter). Deliberately NOT retried: fast-fail and let
*     the panel say why.
*   - `RATE_LIMIT` — a transient throttle that self-clears. Retried, with a
*     backoff biased longer than the peer default so one shared pool is not
*     re-hit immediately: SenseNova's daytime rpm/tpm ceiling is aggressive
*     (`llm-error-fix.ts`: its `quota_exceeded_error` code 8 is really a
*     per-minute rate cap), so we ride it out with more attempts and a gentler
*     first step.
*
* @module dsh-connect-sensenova-token-plan/llm-retry
*/
/**
* The failure-class codes this provider reasons about, in peer-canonical
* spelling.
*
* The strings mirror the `@deepseek-ai/dsh-llm` peer's error-code constants
* (`QUOTA_EXCEEDED_CODE = "QUOTA"`, `ACCOUNT_QUOTA_EXCEEDED_CODE =
* "ACCOUNT_QUOTA"`, `EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE"`). They are stable
* protocol codes, not implementation details, so pinning them here is what the
* qoder route does too; `llm-adapter.ts` still imports the live constants from
* the peer and passes them through `resolveRetryPolicy`, so a peer rename would
* surface at the adapter, not silently drift here.
*/
const QUOTA_CODES = Object.freeze({
	/** Depleted Token Plan pool (per-pool quota). Not retried. */
	quota: "QUOTA",
	/** Depleted account-level quota. Not retried. */
	accountQuota: "ACCOUNT_QUOTA",
	/** Empty/truncated response. Retried. */
	emptyResponse: "EMPTY_RESPONSE",
	/** Transient throttle (429 rate). Retried with backoff. */
	rateLimit: "RATE_LIMIT",
	/** Upstream 5xx. Retried. */
	server: "SERVER",
	/** Request deadline exceeded. Retried. */
	timeout: "TIMEOUT",
	/** Connection-level failure. Retried. */
	transport: "TRANSPORT"
});
/**
* The failure classes this provider retries, in peer-canonical order.
*
* Excludes both quota codes on purpose: a depleted pool cannot be retried into
* health, and retrying it against a shared credit pool only prolongs the
* cool-down. `RATE_LIMIT` stays — transient throttles self-clear.
* @returns {string[]} the retryable code list (no duplicates, non-empty).
*/
function retryableCodes() {
	return [
		QUOTA_CODES.emptyResponse,
		QUOTA_CODES.rateLimit,
		QUOTA_CODES.server,
		QUOTA_CODES.timeout,
		QUOTA_CODES.transport
	];
}
/**
* Build the provider's retry-policy config.
*
* The shape is exactly what `@deepseek-ai/dsh-llm`'s `resolveRetryPolicy`
* accepts (`mode: "normal"` → `{ mode, maxRetries, retryableCodes, backoff }`).
* We pin it explicitly rather than passing `undefined` so a future change to
* the peer's default policy cannot silently alter this provider's behaviour.
*
* Tuned for SenseNova's daytime rate ceiling (rpm/tpm), which the peer mislabels
* as `QUOTA` — `llm-error-fix.ts` pulls those back to `RATE_LIMIT` so they
* reach this policy. The numbers: more attempts (8) and a gentler, longer
* backoff than the peer default (initial 1.5s → cap 20s, jitter 0.25) so a
* single shared credit pool is not stampeded while the rate window refills.
* Still bounded: a genuine outage fails after ~90s of backed-off retries rather
* than spinning forever. QUOTA stays excluded (a depleted pool cannot be retried
* into health; retrying it only prolongs the cool-down — ROADMAP §1).
* @returns {{mode: "normal", maxRetries: number, retryableCodes: string[], backoff: {initialDelayMs: number, maxDelayMs: number, jitterRatio: number}}}
*/
function buildRetryPolicyConfig() {
	return {
		mode: "normal",
		maxRetries: 8,
		retryableCodes: retryableCodes(),
		backoff: {
			initialDelayMs: 1500,
			maxDelayMs: 2e4,
			jitterRatio: .25
		}
	};
}

//#endregion
//#region src/host/llm-error-fix.ts
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
* 阅读顺序：本文件自上而下是「判据词表 → 两个纯判据 → 决策组合 → 流出口
* 改写」。对外契约在底部（`reclassifyStream` / `reclassifyFinish`），想找它
* 依赖了哪些判据，就从底部逆着依赖链往上读。
*
* @module dsh-connect-sensenova-token-plan/llm-error-fix
*/
/**
* 与 peer 协议对齐的失败类（稳定字符串，不 import peer 也成立）。
* `QUOTA` 来自 `@deepseek-ai/dsh-llm` 的 `QUOTA_EXCEEDED_CODE`，`RATE_LIMIT`
* 来自 peer `classifyPiAiError` 的返回字面量。
*/
const CODE = Object.freeze({
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
const RATE_CAP_WORDING = /\brpm\b|\btpm\b|rate[_\s-]?limit|per[\s_-]?(?:min|minute|sec|second)|too many|限流|频率|请求过于频繁/i;
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
function looksLikeRateLimit(message) {
	if (typeof message !== "string" || message.length === 0) return false;
	const m = message.toLowerCase();
	if (!RATE_SIGNAL.some((re) => re.test(m))) return false;
	return !HARD_QUOTA_WORDING.some((re) => re.test(m));
}
/**
* 从错误文本里抽出商汤结构化 `type` 字段。
*
* peer 把整条错误 JSON 拼进 `failure.message`，所以这里能从文本回捞结构信
* 号，而不依赖 peer 是否单独透传了 `type`。抓不到返回 null。
* @param {string} message
* @returns {string|null}
*/
function extractStructuredType(message) {
	if (typeof message !== "string" || message.length === 0) return null;
	const match = STRUCTURED_TYPE.exec(message);
	return match ? match[1] ?? null : null;
}
/**
* 一个被 peer 判为 QUOTA 的失败，是否其实是限频、应纠正为 RATE_LIMIT。
*
* 这是修正 v1（纯文本启发）漏判的核心：`{"message":"rpm exhausted",
* "type":"quota_exceeded_error","code":"8"}` 这种体——商汤把**请求速率上限**
* 复用 `quota_exceeded_error` 这个名字，纯文本里没有 “rate limit” 字样，v1 的
* `looksLikeRateLimit` 既没命中限频信号也没命中硬额度，于是留在 QUOTA、不重试、
* 直接失败。本函数改读结构化 `type`，逐层收窄：
*
*   1. `type` 含 `rate_limit` → 本就是限频（peer 多数已判 RATE_LIMIT，这里是防御）。
*   2. `type` 含 `quota` 但仍带 {@link RATE_CAP_WORDING}（rpm/tpm/每分钟/限流…）
*      → 是“被错命名为 quota 的速率上限”，纠正为 RATE_LIMIT。
*   3. `type` 含 `quota` 且无任何速率信号（token/credit/balance 真耗尽）→ 保留 QUOTA。
*   4. `type` 是其它非 quota 值 → 保守不纠正。
*   5. 无结构化 `type` → 退回 v1 的 {@link looksLikeRateLimit}。
*
* 不纠正真配额耗尽：那是共享 Token Plan 池的硬耗尽，重试只会延长冷却窗口
* （ROADMAP §1 纪律），所以宁可快失败。
* @param {{code?: string, message?: string}} failure
* @returns {boolean} true 表示应纠正为 RATE_LIMIT。
*/
function shouldReclassifyQuotaToRate(failure) {
	if (!failure || failure.code !== CODE.QUOTA) return false;
	const message = typeof failure.message === "string" ? failure.message : "";
	const type = extractStructuredType(message);
	if (type !== null) {
		const t = type.toLowerCase();
		if (/rate[_\s-]?limit/.test(t)) return true;
		if (/quota/.test(t)) return RATE_CAP_WORDING.test(message);
		return false;
	}
	return looksLikeRateLimit(message);
}
/**
* 把单个流 chunk 里的失败码在误判时纠正。
*
* 非 finish、非 error 终止、非 QUOTA，或已判为限频的，一律原样返回（新对象
* 仅在确有纠正时创建，保持调用方对引用相等的预期）。
* @param {object} chunk - harness 流协议 chunk。
* @returns {object} 原 chunk 或 code 被纠正后的新 chunk。
*/
function reclassifyFinish(chunk) {
	if (!isErrorFinish(chunk)) return chunk;
	const errorChunk = chunk;
	const reason = errorChunk.reason;
	const failure = reason?.failure;
	if (failure === void 0 || !shouldReclassifyQuotaToRate(failure)) return chunk;
	return {
		...errorChunk,
		reason: {
			...reason,
			failure: {
				...failure,
				code: CODE.RATE_LIMIT
			}
		}
	};
}
/** 是否为「带 failure 的 error 型 finish chunk」——纠正层唯一关心的形状。 */
function isErrorFinish(chunk) {
	if (chunk === null || typeof chunk !== "object") return false;
	const candidate = chunk;
	return candidate.type === "finish" && candidate.reason !== null && typeof candidate.reason === "object" && candidate.reason.kind === "error" && candidate.reason.failure != null;
}
/**
* 包裹一个 adapter 的 async iterator 流：对每个 finish chunk 做重判。
* @param {AsyncIterableIterator<object>} source - 内层 adapter 的流。
* @returns {AsyncGenerator<object>} 纠正后的流。
*/
async function* reclassifyStream(source) {
	for await (const chunk of source) yield reclassifyFinish(chunk);
}

//#endregion
//#region src/host/llm-adapter-core.ts
/**
* The shared `PiAiAdapter` assembly both upstreams use.
*
* The two adapters (`llm-adapter.ts` for the Token Plan provider,
* `raccoon-llm-adapter.ts` for the Raccoon one) were written as copies: same
* inert pi-ai auth plane, same profile row, same `PiAiAdapter` wiring, same
* stream-reclassification Proxy. That is assembly against the runtime peers,
* not domain logic — a difference between the two copies buys nothing and
* costs a fix twice (the 429 misclassification layer is a correction, and
* every correction must reach both routes or one of them silently stops
* retrying).
*
* What stays in each adapter: the descriptor build (each upstream maps its
* own roster/catalog) and the credential resolver each route reads.
*
* Peer-dependent: imports `pi-ai` / `dsh-llm` / `dsh-llm-pi-ai`, which ship
* inside the Host. Like the adapters themselves, it cannot be imported by the
* offline unit suite and is exercised by the wiring/e2e checks.
*
* @module dsh-connect-sensenova-token-plan/llm-adapter-core
*/
/** Idle ceiling while one stream read is outstanding (dsh-llm-pi-ai default). */
const STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Pixel budget at the `dsh-llm-pi-ai` default (the Token Plan provider). */
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4194304;
/**
* Image budgets at the `dsh-llm-pi-ai` defaults, with the pixel budget
* overridable: the Raccoon gateway caps a request body near 10 MB, so there
* the per-image byte ceiling binds instead and the pixel budget is lowered to
* keep an image inside it.
* @param {number} [requestImagePixelBudget] - override for the pixel budget.
* @returns {{maxRequestImageBytes: number, requestImagePixelBudget: number,
*   requestImageMaxBytes: number}} the profile's image budget row.
*/
function imageBudgets(requestImagePixelBudget = DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET) {
	return {
		maxRequestImageBytes: 20971520,
		requestImagePixelBudget,
		requestImageMaxBytes: 1048576
	};
}
/**
* Inert pi-ai auth plane.
*
* Authentication goes through the credential resolver each route supplies
* (the stored `SENSENOVA_API_KEY` reference, or the stored Raccoon JWT), read
* per request. pi-ai's own credential lifecycle must never manufacture a
* credential for these routes, so every ambient question answers "nothing
* stored, nothing set".
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/**
* Wrap an adapter so both stream exits reclassify a misjudged 429.
*
* The peer's `classifyPiAiError` can read a "budget/credits" worded 429 as
* QUOTA (which is not retried); this layer corrects such a body back to
* RATE_LIMIT before the stream leaves, so the backoff in `llm-retry.ts`
* actually fires. Only the stream exits are intercepted — no peer internals
* are touched and no ordinary data chunk is altered. See `llm-error-fix.ts`.
* @param {object} inner - the `PiAiAdapter` to wrap.
* @returns {object} the wrapped adapter.
*/
function withReclassifiedStream(inner) {
	return new Proxy(inner, { get(target, prop, receiver) {
		const value = Reflect.get(target, prop, receiver);
		if (prop === "stream") {
			const stream = target.stream;
			return (options) => reclassifyStream(stream(options));
		}
		if (typeof value === "function" && prop === "prepareCall") {
			const prepare = target.prepareCall;
			return (...args) => {
				const prepared = prepare.apply(target, args);
				const handle = prepared;
				if (handle !== null && typeof handle.then === "function") return handle.then((p) => {
					const inner = p;
					return inner !== null && typeof inner.stream === "function" ? {
						...inner,
						stream: (o) => reclassifyStream(inner.stream(o))
					} : p;
				});
				return handle !== null && typeof handle.stream === "function" ? {
					...handle,
					stream: (o) => reclassifyStream(handle.stream(o))
				} : prepared;
			};
		}
		return value;
	} });
}
/**
* Assemble one provider's adapter: the pi-ai provider, its single profile
* row, and the `PiAiAdapter` carrying them.
*
* A fresh instance per rebuild is deliberate: `PiAiAdapter` memoizes the
* profiles snapshot internally, so the caller REPLACES the registered adapter
* when the catalog or credential changes and emits `llm/adapters-updated`.
* @param {PiAiAdapterParts} options - the per-upstream facts.
* @returns {{adapter: object, providerIds: string[]}} the adapter and the ids
*   it owns.
*/
function assemblePiAiAdapter({ providerId, displayName, apiKeyName, models, resolveCredential, get, reasoning, requestImagePixelBudget }) {
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: apiKeyName,
				/**
				* pi-ai hands the credential it resolved; these routes store none,
				* so the parameter is typed only to name what is read off it.
				* @param {{credential?: {key?: string}}} [options]
				*/
				async resolve({ credential } = {}) {
					const key = credential?.key;
					return key === void 0 || key.length === 0 ? void 0 : {
						auth: { apiKey: key },
						source: displayName
					};
				}
			} },
			models,
			api: openAICompletionsApi()
		}),
		getModels: () => models
	};
	const profiles = /* @__PURE__ */ new Map([[providerId, {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(buildRetryPolicyConfig(), `${name}.${providerId}.retryPolicy`),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...reasoning !== void 0 ? { reasoning } : {},
		...imageBudgets(requestImagePixelBudget),
		piProvider: provider
	}]]);
	return {
		adapter: withReclassifiedStream(new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => resolveCredential(),
			resolveAttachments: () => get?.("attachments"),
			resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => (get?.("fs"))?.processPathFromHostPath?.(hostPath), ref)
		})),
		providerIds: [providerId]
	};
}

//#endregion
export { assemblePiAiAdapter as t };
/**
 * IAM rejection reading — turn the platform's refusal into a wait window, a
 * human detail, and a machine-readable code.
 *
 * Split out of `sensenova-auth.ts`: these functions answer "what did the
 * platform say when it said no", a concern that is independent of how the
 * login flow walks its redirects.
 *
 * @module dsh-connect-sensenova-token-plan/auth-iam
 */

import { CODE, IAM_REASON_CODES } from "./codes.ts";
import { str, obj } from "./util.ts";

/**
 * How long the platform says to wait before trying again, in milliseconds.
 *
 * Two places carry it: a standard `Retry-After` header, and prose in the
 * message ("try again after 8 minutes"). Honouring it is the difference
 * between waiting out a lockout and extending one with every poll.
 *
 * RFC 7231 §7.1.3 lets `Retry-After` be either a delta-seconds integer OR an
 * HTTP-date. The platform docs only mention the seconds form, but a future
 * date must still be honoured: `Number("Wed, 21 Oct 2026 ...")` is `NaN`, and
 * letting that fall through to a guess would re-probe a lock the platform has
 * told us to back off until — so a date-shaped header is parsed and returned
 * as the wait until then.
 *
 * The prose is matched in both languages the platform uses, because a window
 * that goes unread becomes a refusal with no stated deadline — which falls
 * back to a local backoff and so probes a lock that is still in force.
 * @param {object} body - the parsed IAM response.
 * @param {Response} response - the IAM response, for its headers.
 * @returns {number|undefined} the wait, or `undefined` when none is stated.
 */
export function retryWindowMs(body: unknown, response: { status?: number; headers?: { get?: (name: string) => string | null } }): number | undefined {
  // A Retry-After in seconds is the authoritative form when present.
  const header = response?.headers?.get?.("retry-after");
  const headerSeconds = Number(header);
  if (typeof header === "string" && Number.isFinite(headerSeconds) && headerSeconds > 0) {
    return Math.ceil(headerSeconds * 1000);
  }
  // An HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT") is the other RFC 7231 form.
  // A past or unparseable date yields no wait; a future one does.
  if (typeof header === "string") {
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) {
      const delta = dateMs - Date.now();
      if (delta > 0) return delta;
    }
  }

  // Otherwise read the duration out of the human message.
  const text = `${str(obj(body).message, "")} ${rejectionDetail(body, response?.status ?? 0)}`;
  const match = /(\d+(?:\.\d+)?)\s*(second|sec|minute|min|hour|hr|秒|分钟|小时|时|分)/i.exec(text);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return amount * durationFactorMs(match[2] ?? "");
}

/**
 * The length of one time unit, in either language.
 *
 * Minutes is the reading for a bare `分`, because a lockout measured in
 * minutes is common and a coinage measured in minutes is not: reading it as
 * seconds would under-wait and re-probe the lock.
 * @param {string} unit - the matched unit.
 * @returns {number} milliseconds.
 */
function durationFactorMs(unit: string): number {
  if (/^h/i.test(unit) || unit.includes("小时") || unit === "时") return 3_600_000;
  if (/^m/i.test(unit) || unit.includes("分")) return 60_000;
  return 1000;
}

/**
 * The machine-readable reason IAM refused a login, when it sends one.
 *
 * IAM answers with a `google.rpc.Status`-shaped envelope whose top-level
 * `message` is a generic status string ("InvalidArgument"), while the actual
 * cause sits in `details[].reason` — `invalidAccountOrPassword`,
 * `accountLocked`, `tooManyAttempts` and so on. Reading only the top level
 * is what made every failure look like a wrong password, including rate
 * limits and locked accounts.
 * @param {object} body - the parsed IAM response.
 * @returns {string} the reason, or `""` when the body carries none.
 */
function iamRejectionReason(body: unknown): string {
  const details = obj(body).details;
  if (!Array.isArray(details)) return "";
  for (const entry of details) {
    const reason = str(obj(entry).reason, "");
    if (reason !== "") return reason;
  }
  return "";
}

/**
 * The best human-readable explanation of a refused login.
 *
 * Prefers the specific localized message, then the machine reason, then the
 * top-level message, so the user is told what the platform actually said
 * rather than a guess the plugin made up.
 * @param {object} body - the parsed IAM response.
 * @param {number} status - the HTTP status.
 * @returns {string}
 */
export function rejectionDetail(body: unknown, status: number): string {
  const source = obj(body);
  const details = Array.isArray(source.details) ? source.details : [];
  for (const entry of details) {
    const message = str(obj(entry).message, "");
    // The LogInfo entries carry ids, not explanations; a message naming a
    // log or track id would be noise to the reader.
    if (message !== "" && !/log_id|track_id/i.test(message)) return message;
  }
  const reason = iamRejectionReason(source);
  if (reason !== "") return reason;
  return str(source.message, str(source.error, `HTTP ${status}`));
}

/**
 * Classify a refused login so the panel can say something specific.
 *
 * Order matters: an exact hit on the platform's machine reason wins, the
 * substring scan only covers a code this table has not learned yet, and the
 * generic code is the last resort — never a specific-looking guess.
 *
 * The table itself lives in `codes.ts` next to the taxonomy, so that a new
 * platform reason is recognised in one place rather than three.
 * @param {object} body - the parsed IAM response.
 * @returns {string} a {@link CODE} value.
 */
export function rejectionCode(body: unknown): import("./codes.ts").CodeValue {
  // The platform writes the reason camelCase (`invalidAccountOrPassword`);
  // other responses spell it snake_case or SCREAMING_CASE. Folding separators
  // away lets one table serve every casing.
  const reason = iamRejectionReason(body).toLowerCase().replace(/[\s_-]+/g, "");
  const exact = IAM_REASON_CODES[reason as keyof typeof IAM_REASON_CODES];
  if (exact !== undefined) return exact;
  if (reason.includes("accountorpassword") || reason.includes("credential")) return CODE.LOGIN_REJECTED;
  if (reason.includes("lock") || reason.includes("disable")) return CODE.ACCOUNT_LOCKED;
  if (reason.includes("attempt") || reason.includes("limit") || reason.includes("frequent")) return CODE.RATE_LIMITED;
  if (reason.includes("captcha") || reason.includes("verify")) return CODE.VERIFICATION_REQUIRED;
  return CODE.LOGIN_FAILED;
}

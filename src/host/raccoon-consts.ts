/**
 * Raccoon gateway constants — the endpoint prefixes and the QR-login timings.
 *
 * Split out of the former single `raccoon.ts` (2026-10-05) along the dependency
 * DAG its own segments formed: every other protocol module needs these, so they
 * are the roots. Nothing here depends on anything else in the Raccoon half.
 *
 * The header comment that used to sit on the old monolith — the wire facts, the
 * "mechanism reference, not ported" stance, the rejected desktop-token route —
 * moved to {@link ./raccoon.ts}, which is now the barrel every consumer imports.
 * What stays here is the knowledge that is *about the wire itself*.
 *
 * @module dsh-connect-sensenova-token-plan/raccoon-consts
 */

/** The gateway this provider talks to. */
export const RACCOON_API_BASE = "https://xiaohuanxiong.com";
/** Auth endpoints. */
export const RACCOON_AUTH_PREFIX = "/api/web/auth/v1";
/** Inference + model catalogue. */
export const RACCOON_LLM_PREFIX = "/api/web/llm/v2";
/** Credits (balance). */
export const RACCOON_POINTS_PREFIX = "/api/web/points/v1";
/**
 * Desktop one-time login reward (`/api/web/desktop/v1`) — INTENTIONALLY UNWIRED.
 *
 * Kept as wire knowledge, never as a call site: **nothing in this plugin may
 * call it.** Two reasons, both measured rather than assumed. ① It is a
 * MUTATION — a probe sent with a real credential claims the user's one-time
 * reward for good (PITFALLS §28). ② It belongs to the Raccoon credit pool
 * (`xiaohuanxiong.com`), not the Token Plan pool, so it cannot serve the
 * daily-reward boundary either (ROADMAP §6.1.1). The daily grant needs no
 * endpoint at all: the server awards `daily_grant` on its own, which is why
 * `fetchRaccoonBalance` (`./raccoon-catalog.ts`) is read-only.
 *
 * If a future audit flags this as dead code: read ROADMAP §6.1.4 before
 * deleting it (the endpoint string is the only code-level breadcrumb) and
 * before wiring it up (the probe price is the reward itself).
 */
export const RACCOON_DESKTOP_PREFIX = "/api/web/desktop/v1";

/** The QR poll cadence: the gateway's own client polls every 2 s. */
export const RACCOON_QR_POLL_INTERVAL_MS = 2_000;
/** The QR login's overall deadline: a scan that takes longer is voided. */
export const RACCOON_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

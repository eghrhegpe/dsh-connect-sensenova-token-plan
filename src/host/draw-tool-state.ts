/**
 * The draw tool's mount-time absence note, in memory only.
 *
 * `registerDrawTool` (draw-mount.ts) is the single place that decides whether
 * the opt-in draw tool actually got registered. Four of its outcomes are
 * worth stating on the panel, and each has its own line:
 *
 *   - the Host exposes no `tools` service (or its `register` is not a
 *     function) — a NORMAL absence, nothing is broken, but the panel should
 *     say so rather than read "on — model list" as "drawing works";
 *   - the tools peer module failed to load or shipped no `defineTool` — a
 *     Host bug, logged via `degrade` AND stated on the panel;
 *   - the registry refused the registration — a Host bug, logged via
 *     `degrade` AND stated on the panel;
 *   - the registry accepted it but returned no disposer — an OLDER peer's
 *     capability boundary, not a bug: the tool works and cannot be withdrawn.
 *     Stated on the panel and logged, because "the switch is off and the tool
 *     still answers" is otherwise unexplainable from the UI.
 *
 * This module holds exactly one of those reasons (or none), plus one more bit:
 * whether the tool is in the registry RIGHT NOW (`drawToolMounted()`). The two
 * are complementary and neither implies the other — a reason explains why a
 * registration attempt failed (or succeeded but cannot be undone), while
 * `mounted` is the present-tense reading. `note === null && mounted === false`
 * with the switch on is the one state neither can describe alone: the pass has
 * not settled yet (boot, or a flip whose queued pass is still running).
 *
 * It is the WRITER's home: `registerDrawTool` sets both, and the snapshot route
 * (`routes/snapshot.ts`) injects `() => drawToolNote()` /
 * `() => drawToolMounted()` into `buildSnapshotBody`, so the aggregator itself
 * never imports this module and stays pure — the same closure-injection pattern
 * as `drawSwitch`.
 *
 * In memory and NOT profile-scoped on purpose: they are per-registration
 * diagnostics, recomputed by `registerDrawTool` on every mount AND on every
 * in-session switch flip (`reconcileDrawTool`), never persisted. Same
 * in-memory discipline as `providerState.error`.
 * @module dsh-connect-sensenova-token-plan/draw-tool-state
 */

import type { DrawToolAbsentReason } from "../shared/wire.ts";

let note: DrawToolAbsentReason | null = null;

/**
 * Whether the tool is in the registry right now.
 *
 * Distinct from `note`, and the difference is the whole point: `note` answers
 * "why did this attempt not take", this answers "is it there as of this
 * instant". A pass that has not run yet leaves both at their cleared values,
 * which is what makes "switch on, no reason, not mounted" readable as
 * "still settling" rather than as a silent absence.
 */
let mounted = false;

/**
 * Clear both bits — called at the top of every registration attempt, so a
 * later success cannot leave a stale reason or a stale "mounted" behind.
 */
export function resetDrawToolNote(): void {
  note = null;
  mounted = false;
}

/** Record why the draw tool did not register, with the switch on. */
export function setDrawToolNote(reason: DrawToolAbsentReason): void {
  note = reason;
}

/** The snapshot route reads this once per poll and injects it downstream. */
export function drawToolNote(): DrawToolAbsentReason | null {
  return note;
}

/** Record that the registration landed (or that it is gone). */
export function setDrawToolMounted(value: boolean): void {
  mounted = value === true;
}

/** Whether the tool is in the registry right now. */
export function drawToolMounted(): boolean {
  return mounted;
}
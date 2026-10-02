/**
 * The draw tool's mount-time absence note, in memory only.
 *
 * `registerDrawTool` (lifecycle.ts) is the single place that decides whether
 * the opt-in draw tool actually got registered. Three of its bail-outs are
 * "the tool is absent" with the switch visibly on:
 *
 *   - the Host exposes no `tools` service (or its `register` is not a
 *     function) — a NORMAL absence, nothing is broken, but the panel should
 *     say so rather than read "on — model list" as "drawing works";
 *   - the tools peer module failed to load or shipped no `defineTool` — a
 *     Host bug, logged via `degrade` AND stated on the panel;
 *   - the registry refused the registration — a Host bug, logged via
 *     `degrade` AND stated on the panel.
 *
 * This module holds exactly one of those reasons (or none). It is the
 * WRITER's home: `registerDrawTool` sets it, and the snapshot route
 * (`routes/snapshot.ts`) injects `() => drawToolNote()` into
 * `buildSnapshotBody`, so the aggregator itself never imports this module and
 * stays pure — the same closure-injection pattern as `drawSwitch`.
 *
 * In memory and NOT profile-scoped on purpose: it is a per-mount diagnostic,
 * recomputed on every Host (re)mount by `registerDrawTool`, never persisted.
 * Same in-memory discipline as `providerState.error`.
 * @module dsh-connect-sensenova-token-plan/draw-tool-state
 */

import type { DrawToolAbsentReason } from "../shared/wire.ts";

let note: DrawToolAbsentReason | null = null;

/** Clear the note — called at the top of every registration attempt. */
export function resetDrawToolNote(): void {
  note = null;
}

/** Record why the draw tool did not register, with the switch on. */
export function setDrawToolNote(reason: DrawToolAbsentReason): void {
  note = reason;
}

/** The snapshot route reads this once per poll and injects it downstream. */
export function drawToolNote(): DrawToolAbsentReason | null {
  return note;
}